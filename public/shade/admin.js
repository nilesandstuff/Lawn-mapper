/**
 * The shade map's admin page (owner, 2026-10-14): links to its pages, and
 * who used it and what went wrong, from /api/shade/admin/usage (worker/src/
 * shade-usage.js). Admin only: the figures route answers anyone else 404.
 */

import { isOwnDevice, setOwnDevice } from './usage.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const n = (v) => Number(v || 0).toLocaleString('en-US');
const short = (id) => (id ? id.slice(0, 6) : '-');

/** The last 30 days as bars, oldest left, from rows { day, [field] }. */
export function bars(rows, field, cls = '', now = Date.now()) {
  const by = new Map(rows.map((r) => [r.day, Number(r[field] || 0)]));
  const days = [...Array(30)].map((_, i) => new Date(now - (29 - i) * 86400000).toISOString().slice(0, 10));
  const top = Math.max(1, ...days.map((d) => by.get(d) || 0));
  return `<div class="bars">${days.map((d) => `<i class="${cls}" title="${d}: ${by.get(d) || 0}" style="height:${Math.round((100 * (by.get(d) || 0)) / top)}%"></i>`).join('')}</div>
    <div class="axis"><span>${days[0].slice(5)}</span><span>30 days, most ${top}</span><span>${days[29].slice(5)}</span></div>`;
}

export function usageHtml(u) {
  const t = u.totals;
  const tile = (label, v) => `<div class="tile"><b>${n(v)}</b><span>${label}</span></div>`;
  const kinds = u.byKind.length
    ? `<table><tr><th>What, last 30 days</th><th class="n">times</th><th class="n">visitors</th></tr>${u.byKind.map((k) => `<tr><td>${esc(k.kind)}</td><td class="n">${n(k.n)}</td><td class="n">${n(k.visitors)}</td></tr>`).join('')}</table>`
    : '<p class="dim">Nothing recorded yet.</p>';
  const rows = u.events.length
    ? `<div class="scroll"><table><tr><th>When</th><th>What</th><th>Detail</th><th>Visitor</th></tr>${u.events.map((e) => `<tr><td>${when(e.at)}</td><td>${esc(e.kind)}</td><td>${esc(e.detail || '')}</td><td>${short(e.client)}${e.signedIn ? ' (signed in)' : ''}</td></tr>`).join('')}</table></div>`
    : '';
  return `<div class="tiles">
      ${tile('visitors today', t.day.visitors)}${tile('visitors, 7 days', t.week.visitors)}${tile('visitors, 30 days', t.month.visitors)}
      ${tile('page opens, 30 days', t.month.opens)}${tile('3D builds, 30 days', t.month.builds)}${tile('errors, 7 days', t.week.errors)}
    </div>
    <p class="dim">Visitors a day</p>${bars(u.byDay, 'visitors')}
    ${kinds}
    <p class="dim">Latest ${u.events.length} events</p>${rows}`;
}

export function errorsHtml(u) {
  if (!u.errors.length) return '<p class="ok">No errors recorded.</p>';
  const top = u.topErrors.length
    ? `<table><tr><th>Most often, last 30 days</th><th class="n">times</th><th>last</th></tr>${u.topErrors.map((e) => `<tr><td><span class="dim">${esc(e.source)}</span> ${esc(e.message)}</td><td class="n">${n(e.n)}</td><td>${when(e.last)}</td></tr>`).join('')}</table>`
    : '';
  return `<p class="dim">Errors a day</p>${bars(u.byDayErrors, 'errors', 'err')}${top}
    <p class="dim">Latest ${u.errors.length}</p>
    <div class="scroll"><table><tr><th>When</th><th>Where</th><th>Message</th><th>Place</th><th>Visitor</th></tr>${u.errors.map((e) => `<tr><td>${when(e.at)}</td><td>${esc(e.source)}${e.page ? ` / ${esc(e.page)}` : ''}${e.detail ? `<br><span class="dim">${esc(e.detail)}</span>` : ''}</td><td>${esc(e.message)}</td><td>${placeHtml(e)}</td><td>${short(e.client)}</td></tr>`).join('')}</table></div>
    <p class="dim">Places are kept 90 days, then blanked; the errors stay.</p>`;
}

/** An error's place: what was searched, and its point as a link that opens the shade map there. */
export function placeHtml(e) {
  const pt = Number.isFinite(e.lat) && Number.isFinite(e.lng);
  if (!e.place && !pt) return '<span class="dim">—</span>';
  const at = pt ? `${Number(e.lat).toFixed(5)}, ${Number(e.lng).toFixed(5)}` : '';
  return `${e.place ? esc(e.place) : ''}${pt ? `${e.place ? '<br>' : ''}<a href="/shade?at=${encodeURIComponent(at)}">${esc(at)}</a>` : ''}`;
}

async function main() {
  let me = null;
  try { me = (await (await fetch('/api/auth/me', { credentials: 'same-origin' })).json()).user; } catch { /* signed out */ }
  if (!me?.admin) { $('#who').innerHTML = '<span class="bad">This page is for admins; sign in as one.</span>'; return; }
  $('#who').textContent = `Signed in as ${me.email}.`;
  $('#admin').hidden = false;
  $('#mine').checked = isOwnDevice();
  $('#mine').addEventListener('change', () => setOwnDevice($('#mine').checked));
  try {
    const r = await fetch('/api/shade/admin/usage', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${r.status}`);
    const u = await r.json();
    $('#usage').classList.remove('dim'); $('#usage').innerHTML = usageHtml(u);
    $('#errors').classList.remove('dim'); $('#errors').innerHTML = errorsHtml(u);
  } catch (e) {
    $('#usage').innerHTML = `<span class="bad">The figures would not load (${esc(e.message)}).</span>`;
    $('#errors').textContent = '';
  }
}

if (typeof document !== 'undefined') main();
