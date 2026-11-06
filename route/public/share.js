/**
 * The page a shared link opens: /s/<id>, or /s/<id>?p=2 for one person's
 * route (route session, 2026-11-06). Read-only: the stops in order, Go
 * buttons, Google Maps trips, the map; ticks are kept on this phone.
 */

import { drawPlan, personCard, totals } from './people.js';
import { formatMinutes } from './lib/parse.js';

const $ = (s) => document.querySelector(s);
const id = location.pathname.match(/^\/s\/([A-Za-z0-9]{8,20})/)?.[1];
const store = {
  get(k, d) { try { const v = localStorage.getItem(`route.share.${id}.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`route.share.${id}.${k}`, JSON.stringify(v)); } catch { /* fine */ } },
};

let plan = null;
let map = null;
let only = null;

function render() {
  const done = new Set(store.get('done', []));
  const people = only == null ? plan.people.map((_, k) => k) : [only];
  $('#people').innerHTML = people.map((k) => personCard(plan, k, { done, open: true })).join('');
  for (const b of document.querySelectorAll('#who button')) b.setAttribute('aria-pressed', String(String(only) === b.dataset.k || (only == null && b.dataset.k === 'all')));
  if (window.L) { $('#mapCard').hidden = false; map = drawPlan(window.L, 'map', plan, only, map); }
  const p = new URLSearchParams(location.search);
  if (only == null) p.delete('p'); else p.set('p', String(only + 1));
  history.replaceState(null, '', `${location.pathname}${p.toString() ? `?${p}` : ''}`);
}

$('#people').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-tick]');
  if (!li || !e.target.closest('.body')) return;
  const done = new Set(store.get('done', []));
  const k = li.dataset.tick;
  if (done.has(k)) done.delete(k); else done.add(k);
  store.set('done', [...done]);
  li.classList.toggle('done', done.has(k));
});
$('#who').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  only = b.dataset.k === 'all' ? null : Number(b.dataset.k);
  render();
});

async function main() {
  if (!id) { $('#sub').textContent = 'This link is missing its route.'; return; }
  const res = await fetch(`/api/share/${id}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { $('#sub').textContent = body.error || 'This route could not be loaded.'; return; }
  plan = body.plan;
  const n = plan.people.length;
  const asked = Number(new URLSearchParams(location.search).get('p'));
  only = asked >= 1 && asked <= n ? asked - 1 : null;
  const day = new Date(plan.at || body.at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const days = plan.people.filter((p) => p.stops.length).map((p) => totals(p).total);
  const longest = Math.max(...days);
  const shortest = Math.min(...days);
  $('#title').textContent = n > 1 ? `Route split ${n} ways` : 'Shared route';
  document.title = n > 1 ? `Route split ${n} ways` : 'Shared route';
  $('#sub').textContent = `Planned ${day}. ${n > 1 ? `${shortest === longest ? formatMinutes(longest) : `${formatMinutes(shortest)} to ${formatMinutes(longest)}`} each, driving plus jobs, ` : ''}ending at the shop.`;
  if (n > 1) {
    $('#whoCard').hidden = false;
    $('#who').innerHTML = `<button type="button" data-k="all">Everyone</button>${plan.people.map((p, k) => `<button type="button" data-k="${k}">${p.name || `Person ${k + 1}`}</button>`).join('')}`;
  }
  render();
}
main();
