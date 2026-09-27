/**
 * The review page for public outlines (see outlines.html and
 * worker/src/outlines.js). Everything goes in with textContent and DOM
 * nodes; the shapes are drawn as SVG over the stored photograph, projected
 * with the same frame arithmetic the training pipeline uses.
 */
import { lngLatToFramePx } from './lib/mercator.js';

const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';

export const CLASS_COLOURS = {
  building: '#4285f4', water: '#00bcd4', pool: '#18ffff', road: '#ff5252',
  driveway: '#ff9800', parking: '#ffeb3b', sidewalk: '#e040fb', rail: '#795548',
};

const view = { maps: [], at: 0, doc: null, dropped: new Set(), frame: null, w: 0, h: 0, lawnOn: true };

/** Polygons of any geometry, as lists of rings. Overlapping parts stay separate. */
export function polygonsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function pathFor(rings) {
  return rings.map((ring) => ring.map((ll, i) => {
    const [x, y] = lngLatToFramePx(view.frame, ll, view.w, view.h);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('') + 'Z').join('');
}

function draw(candidate) {
  const svg = $('#overlay');
  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
  if (view.lawnOn) {
    for (const f of candidate.shapes || []) {
      for (const rings of polygonsOf(f.geometry || f)) {
        const p = document.createElementNS(SVG, 'path');
        p.setAttribute('class', 'lawn');
        p.setAttribute('d', pathFor(rings));
        svg.append(p);
      }
    }
  }
  const features = view.doc.features || [];
  features.forEach((f, i) => {
    const colour = CLASS_COLOURS[f.properties?.class] || '#ffffff';
    const g = document.createElementNS(SVG, 'g');
    for (const rings of polygonsOf(f.geometry)) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('class', `shape${view.dropped.has(i) ? ' dropped' : ''}`);
      p.setAttribute('d', pathFor(rings));
      p.setAttribute('fill', colour);
      p.setAttribute('stroke', colour);
      p.setAttribute('fill-rule', 'nonzero');
      const t = document.createElementNS(SVG, 'title');
      t.textContent = `${f.properties?.class} (${f.properties?.source})`;
      p.append(t);
      g.append(p);
    }
    g.addEventListener('click', () => {
      if (view.dropped.has(i)) view.dropped.delete(i); else view.dropped.add(i);
      draw(candidate);
      legend();
    });
    svg.append(g);
  });
  if (candidate.parcel?.geometry) {
    for (const rings of polygonsOf(candidate.parcel.geometry)) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('class', 'parcel');
      p.setAttribute('d', pathFor(rings));
      svg.append(p);
    }
  }
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
  if (!Object.keys(counts).length) el.textContent = 'No public outlines fall in this frame.';
}

async function open(i) {
  view.at = (i + view.maps.length) % view.maps.length;
  const m = view.maps[view.at];
  $('#pick').value = m.id;
  $('#said').textContent = '';
  const [doc, cand] = await Promise.all([
    fetch(`/api/admin/outline?id=${encodeURIComponent(m.id)}`).then((r) => r.json()),
    fetch(`/api/admin/candidate?id=${encodeURIComponent(m.id)}`).then((r) => r.json()),
  ]);
  view.doc = doc;
  view.dropped = new Set((doc.features || []).map((f, k) => (f.properties?.dropped ? k : -1)).filter((k) => k >= 0));
  view.frame = cand.imageFrame || cand.frame;
  $('#sub').textContent = `${m.county || 'Traced by hand'}${m.squareFeet ? `, ${m.squareFeet.toLocaleString()} sq ft of lawn` : ''}`
    + ` — ${doc.status === 'approved' ? 'APPROVED' : 'draft'}${doc.fetchedAt ? `, fetched ${doc.fetchedAt.slice(0, 10)}` : ''}`;
  const errs = doc.errors ? Object.entries(doc.errors).map(([k, v]) => `${k}: ${String(v).split('\n')[0]}`) : [];
  $('#errors').hidden = !errs.length;
  $('#errors').textContent = errs.length ? `Some sources did not answer — ${errs.join('; ')}` : '';
  $('#attribution').textContent = doc.attribution || '';
  const img = $('#photo');
  img.onload = () => {
    view.w = img.naturalWidth; view.h = img.naturalHeight;
    draw(cand); legend();
  };
  img.src = `/api/admin/candidate-image?id=${encodeURIComponent(m.id)}`;
  view.candidate = cand;
}

async function save(status) {
  const m = view.maps[view.at];
  $('#said').textContent = 'Saving…';
  const res = await fetch('/api/admin/outline', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: m.id, status, dropped: [...view.dropped] }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { $('#said').textContent = `Not saved (${out.error || res.status}).`; return; }
  m.status = out.status;
  $('#said').textContent = out.status === 'approved'
    ? `Approved — ${out.kept} shapes will be shown to the detector as "not lawn".`
    : `Saved as a draft (${out.kept} kept).`;
  labelOptions();
}

function labelOptions() {
  const pick = $('#pick');
  pick.textContent = '';
  view.maps.forEach((m) => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${m.status === 'approved' ? '✓ ' : ''}${m.county || 'Traced by hand'} — ${m.id.slice(0, 22)}`;
    pick.append(o);
  });
  pick.value = view.maps[view.at]?.id || '';
}

async function start() {
  let data;
  try {
    const res = await fetch('/api/admin/outlines');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#locked').hidden = false;
    return;
  }
  view.maps = (data.maps || []).sort((a, b) => (a.status === 'approved') - (b.status === 'approved'));
  if (!view.maps.length) { $('#none').hidden = false; return; }
  $('#page').hidden = false;
  labelOptions();
  $('#pick').addEventListener('change', (e) => open(view.maps.findIndex((m) => m.id === e.target.value)));
  $('#prev').addEventListener('click', () => open(view.at - 1));
  $('#next').addEventListener('click', () => open(view.at + 1));
  $('#save').addEventListener('click', () => save('draft'));
  $('#approve').addEventListener('click', () => save('approved'));
  $('#lawn-toggle').addEventListener('click', () => {
    view.lawnOn = !view.lawnOn;
    $('#lawn-toggle').textContent = view.lawnOn ? 'Hide the traced lawn' : 'Show the traced lawn';
    draw(view.candidate);
  });
  open(0);
}

if (typeof document !== 'undefined' && document.getElementById('overlay')) start();
