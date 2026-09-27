/**
 * The review page for not-lawn examples (see outlines.html and
 * worker/src/outlines.js). Everything goes in with textContent and DOM
 * nodes; the outlines are drawn as SVG over the example's photograph,
 * projected with the same frame arithmetic the training pipeline uses.
 */
import { lngLatToFramePx } from './lib/mercator.js';

const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';

export const CLASS_COLOURS = {
  building: '#4285f4', water: '#00bcd4', pool: '#18ffff', road: '#ff5252',
  driveway: '#ff9800', parking: '#ffeb3b', sidewalk: '#e040fb', rail: '#795548',
};

const view = { list: [], at: 0, doc: null, dropped: new Set(), w: 0, h: 0 };

/** Polygons of any geometry, as lists of rings. Overlapping parts stay separate. */
export function polygonsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/** What is approved so far, by kind: outlines kept across approved examples. */
export function approvedTotals(list) {
  const kept = {};
  let examples = 0;
  for (const e of list) {
    if (e.status !== 'approved') continue;
    examples++;
    for (const [c, n] of Object.entries(e.kept || {})) kept[c] = (kept[c] || 0) + n;
  }
  return { examples, kept };
}

function pathFor(rings) {
  return rings.map((ring) => ring.map((ll, i) => {
    const [x, y] = lngLatToFramePx(view.doc.frame, ll, view.w, view.h);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('') + 'Z').join('');
}

function draw() {
  const svg = $('#overlay');
  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
  (view.doc.features || []).forEach((f, i) => {
    const colour = CLASS_COLOURS[f.properties?.class] || '#ffffff';
    const g = document.createElementNS(SVG, 'g');
    for (const rings of polygonsOf(f.geometry)) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('class', `shape${f.properties?.target ? ' target' : ''}${view.dropped.has(i) ? ' dropped' : ''}`);
      p.setAttribute('d', pathFor(rings));
      p.setAttribute('fill', colour);
      p.setAttribute('stroke', colour);
      const t = document.createElementNS(SVG, 'title');
      t.textContent = `${f.properties?.class} (${f.properties?.source})`;
      p.append(t);
      g.append(p);
    }
    g.addEventListener('click', () => {
      if (view.dropped.has(i)) view.dropped.delete(i); else view.dropped.add(i);
      draw();
      legend();
    });
    svg.append(g);
  });
}

function legend() {
  const counts = {};
  (view.doc.features || []).forEach((f, i) => {
    const c = f.properties?.class || 'other';
    counts[c] = counts[c] || { kept: 0, dropped: 0 };
    counts[c][view.dropped.has(i) ? 'dropped' : 'kept']++;
  });
  const el = $('#legend');
  el.textContent = '';
  for (const [c, n] of Object.entries(counts)) {
    const s = document.createElement('span');
    s.style.setProperty('--c', CLASS_COLOURS[c] || '#fff');
    s.textContent = `${c} ${n.kept}${n.dropped ? ` (+${n.dropped} dropped)` : ''}`;
    el.append(s);
  }
}

function totals() {
  const t = approvedTotals(view.list);
  const parts = Object.entries(t.kept).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`);
  const drafts = view.list.filter((e) => e.status === 'draft').length;
  $('#totals').textContent = `Approved: ${t.examples} of ${view.list.length} examples`
    + (parts.length ? ` — outlines kept: ${parts.join(', ')}` : '')
    + ` · ${drafts} still to review`;
}

async function open(i) {
  view.at = (i + view.list.length) % view.list.length;
  const e = view.list[view.at];
  $('#pick').value = e.id;
  $('#said').textContent = '';
  const doc = await fetch(`/api/admin/example?id=${encodeURIComponent(e.id)}`).then((r) => r.json());
  if (doc.error || !doc.frame) {
    view.doc = { features: [], frame: null };
    $('#errors').hidden = false;
    $('#errors').textContent = `Could not load this example: ${doc.error || 'no frame'}.`;
    return;
  }
  view.doc = doc;
  view.dropped = new Set((doc.features || []).map((f, k) => (f.properties?.dropped ? k : -1)).filter((k) => k >= 0));
  const t = doc.target || {};
  $('#sub').textContent = `${e.id}: chosen for a ${t.class || '?'} (${t.source || '?'}) — `
    + `${doc.status === 'approved' ? 'APPROVED' : doc.status === 'rejected' ? 'REJECTED' : 'draft'}`;
  const errs = doc.errors ? Object.entries(doc.errors).map(([k, v]) => `${k}: ${String(v).split('\n')[0]}`) : [];
  $('#errors').hidden = !errs.length;
  $('#errors').textContent = errs.length ? `Some sources did not answer — ${errs.join('; ')}` : '';
  $('#attribution').textContent = doc.attribution || '';
  const img = $('#photo');
  img.onload = () => { view.w = img.naturalWidth; view.h = img.naturalHeight; draw(); legend(); };
  img.src = `/api/admin/example-image?id=${encodeURIComponent(e.id)}`;
}

async function save(status) {
  const e = view.list[view.at];
  $('#said').textContent = 'Saving…';
  const res = await fetch('/api/admin/example', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: e.id, status, dropped: [...view.dropped] }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { $('#said').textContent = `Not saved (${out.error || res.status}).`; return; }
  e.status = out.status;
  e.kept = out.kept || {};
  $('#said').textContent = out.status === 'approved' ? 'Approved.' : out.status === 'rejected' ? 'Rejected.' : 'Saved as a draft.';
  labelOptions();
  totals();
  /* On to the next one still to review: this page is a queue. */
  if (out.status !== 'draft') {
    const next = view.list.findIndex((x, k) => k > view.at && x.status === 'draft');
    if (next >= 0) open(next);
  }
}

function labelOptions() {
  const pick = $('#pick');
  pick.textContent = '';
  view.list.forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = `${e.status === 'approved' ? '✓ ' : e.status === 'rejected' ? '✗ ' : ''}${e.id}`;
    pick.append(o);
  });
  pick.value = view.list[view.at]?.id || '';
}

async function start() {
  let data;
  try {
    const res = await fetch('/api/admin/examples');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#locked').hidden = false;
    return;
  }
  view.list = data.examples || [];
  if (!view.list.length) { $('#none').hidden = false; return; }
  $('#page').hidden = false;
  labelOptions();
  totals();
  $('#pick').addEventListener('change', (ev) => open(view.list.findIndex((x) => x.id === ev.target.value)));
  $('#prev').addEventListener('click', () => open(view.at - 1));
  $('#next').addEventListener('click', () => open(view.at + 1));
  $('#save').addEventListener('click', () => save('draft'));
  $('#approve').addEventListener('click', () => save('approved'));
  $('#reject').addEventListener('click', () => save('rejected'));
  const first = view.list.findIndex((x) => x.status === 'draft');
  open(first >= 0 ? first : 0);
}

if (typeof document !== 'undefined' && document.getElementById('overlay')) start();
