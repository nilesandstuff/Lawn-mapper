/**
 * THE ADMIN SAVES PAGE (owner, 2026-11-11; worker/src/admin-saves.js): "just a list of the admin saves and links to
 * open each in the various tools". While a trace is still working the list asks again every few seconds, and each
 * ask also lets the server finish a trace that is ready (the one-minute timer does the same with the page closed).
 */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const get = async (path, init) => { const r = await fetch(path, { credentials: 'same-origin', ...init }); if (!r.ok) throw Object.assign(new Error(`${r.status}`), { status: r.status }); return r.json(); };

const traceLine = (m) => {
  const t = m.trace;
  if (!t) return '<span class="dim">no trace</span>';
  if (t.status === 'done') return `<span class="ok">Traced</span>: ${Number(m.squareFeet || 0).toLocaleString()} sq ft in ${t.pieces ?? m.shapes} piece${(t.pieces ?? m.shapes) === 1 ? '' : 's'}`;
  if (t.status === 'pending' || t.status === 'starting') return `<span class="warn">Turf Trace is working…</span> ${m.working ? `${esc(m.working)}. ` : ''}It finishes by itself, page open or not`;
  if (t.status === 'kept') return '<span class="ok">Edited by hand</span>: the trace was not laid over it';
  return `<span class="bad">Trace failed</span>${t.detail ? `: ${esc(t.detail)}` : ''}. Open it in the Lawn Mapper to trace it there.`;
};
const lidarLine = (m) => {
  const l = m.lidar;
  if (!l) return '<span class="dim">Lidar: built after the trace</span>';
  if (l.status === 'done') return `<span class="ok">Lidar ready</span>${l.detail ? `: ${esc(l.detail)}` : ''}. The AR and the shade map can open it.`;
  if (l.status === 'waiting' || l.status === 'building') return '<span class="warn">Lidar is being built on the server…</span> about a minute, page open or not';
  return `<span class="bad">Lidar not built</span>${l.detail ? `: ${esc(l.detail)}` : ''}. Open it in the shade map to build it there.`;
};
const toolLine = (m, tools) => {
  const has = Object.keys(m.tools || {});
  return tools.map((t) => `<a href="${esc(t.url.replace('{id}', encodeURIComponent(m.id)))}">${esc(t.name)}${has.includes(t.id) ? ' &#10003;' : ''}</a>`).join('');
};

let timer = null;
async function load({ check = false } = {}) {
  clearTimeout(timer);
  const note = $('#note'), list = $('#list');
  try {
    if (check) await get('/api/admin/admin-saves/check', { method: 'POST' }).catch(() => null);
    const [{ maps }, { tools }] = await Promise.all([get('/api/admin/admin-saves'), get('/api/tools')]);
    const shown = tools.filter((t) => ['lawn', 'shade', 'water', 'scan'].includes(t.id));
    list.innerHTML = maps.length ? maps.map((m) => `<div class="save">
        <h2>${esc(m.address || m.id)}</h2>
        <p>${traceLine(m)}</p>
        <p>${lidarLine(m)}</p>
        <p class="dim">Saved ${m.at ? esc(new Date(m.at).toLocaleString()) : ''}${m.county ? ` · ${esc(m.county)}` : ''}</p>
        <div class="links">${toolLine(m, shown)}</div>
      </div>`).join('') : '<p>No admin saves yet. On the Lawn Mapper\'s AI tab, set up an address and press "Save as admin and auto trace".</p>';
    const waiting = maps.some((m) => (m.trace && (m.trace.status === 'pending' || m.trace.status === 'starting')) || (m.lidar && (m.lidar.status === 'waiting' || m.lidar.status === 'building')));
    note.textContent = waiting ? 'Checking again in a few seconds…' : `${maps.length} map${maps.length === 1 ? '' : 's'}`;
    if (waiting) timer = setTimeout(() => load({ check: true }), 8000);
  } catch (e) {
    list.innerHTML = '';
    note.textContent = e.status === 404 ? 'Not found: this page is for the administrator, signed in.' : `Could not load (${e.message}).`;
  }
}
$('#refresh').addEventListener('click', () => load({ check: true }));
load({ check: true });
