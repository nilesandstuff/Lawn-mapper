/**
 * Does the banked county photo line up with the banked Mapbox photo and its
 * outlines? (owner, 2026-10-01; see county.html.)
 *
 * Built like outlines.js, which is the viewer that lined up: both pictures are
 * the banked files at their own pixel size over one frame -- the map's
 * image_frame -- and the outlines are projected with lngLatToFramePx against
 * that same frame and those same pixels, which is how training rasterises
 * them (tools/train-detector.js maskOf). Everything goes in with textContent
 * and DOM nodes.
 */
import { lngLatToFramePx, metresPerPixel } from './lib/mercator.js';

const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
const NUDGE_M = 0.1;

const view = {
  list: [], at: 0, filter: 'todo', doc: null, w: 0, h: 0,
  nudge: { east: 0, north: 0 }, flipped: false,
};

/* ------------------------------------------------------------ pure parts */

/** Doubtful: the automatic fit was weak, ran to the edge of its search, or did not settle. */
export const doubtful = (m) => (Number(m.fit) < 0.3)
  || (Number(m.residual_m) > 0.3) || Math.hypot(Number(m.east) || 0, Number(m.north) || 0) > 9;

export const FILTERS = {
  todo: (m) => !m.review,
  doubtful: (m) => !m.review && doubtful(m),
  ok: (m) => m.review === 'ok',
  off: (m) => m.review === 'off',
  all: () => true,
};

/** Indices shown under a filter, in list order. */
export const shown = (list, filter) => list.map((m, i) => [m, i])
  .filter(([m]) => (FILTERS[filter] || FILTERS.all)(m)).map(([, i]) => i);

/** The next shown index after `at` in direction dir, wrapping; -1 when none. */
export function stepIn(list, filter, at, dir) {
  const idx = shown(list, filter);
  if (!idx.length) return -1;
  const pos = idx.indexOf(at);
  if (pos < 0) return idx[dir > 0 ? 0 : idx.length - 1];
  return idx[(pos + dir + idx.length) % idx.length];
}

/** Polygons of any geometry, as lists of rings. */
export function polygonsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/** An SVG path for rings, in the photo's own pixels. */
export function pathFor(rings, frame, w, h) {
  return rings.map((ring) => ring.map((ll, i) => {
    const [x, y] = lngLatToFramePx(frame, ll, w, h);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('') + 'Z').join('');
}

/* ------------------------------------------------------------- drawing */

function draw() {
  const svg = $('#overlay');
  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
  if (!$('#show-lines').checked || !view.doc) return;
  const frame = view.doc.frame;
  const add = (cls, rings) => {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('class', cls);
    p.setAttribute('d', pathFor(rings, frame, view.w, view.h));
    svg.append(p);
  };
  const parcel = view.doc.parcel?.geometry || view.doc.parcel;
  for (const rings of polygonsOf(parcel)) add('parcel', rings);
  for (const f of view.doc.shapes || []) {
    const g = f.geometry || f;
    for (const rings of polygonsOf(g)) add(f.properties?.inferred ? 'inferred' : 'lawn', rings);
  }
}

/* The county photo, moved by the person's nudge (metres -> photo pixels). */
function placeCounty() {
  if (!view.doc) return;
  const mpp = metresPerPixel(view.doc.frame, view.w);
  const x = (view.nudge.east / mpp / view.w) * 100;
  const y = (-view.nudge.north / mpp / view.h) * 100;
  $('#county').style.transform = `translate(${x.toFixed(3)}%, ${y.toFixed(3)}%)`;
  const n = view.nudge;
  $('#nudgesaid').textContent = n.east || n.north
    ? `County photo nudged ${Math.abs(n.east).toFixed(2)} m ${n.east >= 0 ? 'east' : 'west'}, `
      + `${Math.abs(n.north).toFixed(2)} m ${n.north >= 0 ? 'north' : 'south'} (not saved until a verdict)`
    : '';
}

function applyOpacity() {
  const mb = Number($('#op-mapbox').value) / 100;
  const ct = Number($('#op-county').value) / 100;
  $('#mapbox').style.opacity = String(view.flipped ? 0 : mb);
  $('#county').style.opacity = String(view.flipped ? 1 : ct);
  $('#flip').textContent = view.flipped ? 'Flip back' : 'Flip';
}

/* --------------------------------------------- the viewer: fit, zoom, pan */
/* As outlines.js: the photo fitted whole, then zoomed about a point. */
const cam = { fit: 1, zoom: 1, x: 0, y: 0, pointers: new Map(), pinch: null, pan: null };
const ZOOMS = [1, 2, 4];

function layout() {
  if (!view.w) return;
  const vp = $('#viewport').getBoundingClientRect();
  cam.fit = Math.min(vp.width / view.w, vp.height / view.h);
  const st = $('#stage');
  st.style.width = `${view.w * cam.fit}px`;
  st.style.height = `${view.h * cam.fit}px`;
  clampPan();
  st.style.left = '0px';
  st.style.top = '0px';
  st.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
}

function clampPan() {
  const vp = $('#viewport').getBoundingClientRect();
  const w = view.w * cam.fit * cam.zoom;
  const h = view.h * cam.fit * cam.zoom;
  cam.x = w <= vp.width ? (vp.width - w) / 2 : Math.min(0, Math.max(vp.width - w, cam.x));
  cam.y = h <= vp.height ? (vp.height - h) / 2 : Math.min(0, Math.max(vp.height - h, cam.y));
}

function zoomAt(z, px, py) {
  const z0 = cam.zoom;
  cam.zoom = Math.max(1, Math.min(8, z));
  cam.x = px - (px - cam.x) * (cam.zoom / z0);
  cam.y = py - (py - cam.y) * (cam.zoom / z0);
  layout();
}

function wireCamera() {
  const vp = $('#viewport');
  const local = (e) => { const r = vp.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  vp.addEventListener('pointerdown', (e) => {
    cam.pointers.set(e.pointerId, local(e));
    vp.setPointerCapture(e.pointerId);
    if (cam.pointers.size === 2) {
      const [a, b] = [...cam.pointers.values()];
      cam.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: cam.zoom };
      cam.pan = null;
    } else {
      cam.pan = { at: local(e), x: cam.x, y: cam.y };
    }
  });
  vp.addEventListener('pointermove', (e) => {
    if (!cam.pointers.has(e.pointerId)) return;
    cam.pointers.set(e.pointerId, local(e));
    if (cam.pinch && cam.pointers.size === 2) {
      const [a, b] = [...cam.pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(cam.pinch.z * (d / cam.pinch.d), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    } else if (cam.pan) {
      const [x, y] = local(e);
      cam.x = cam.pan.x + (x - cam.pan.at[0]);
      cam.y = cam.pan.y + (y - cam.pan.at[1]);
      layout();
    }
  });
  const end = (e) => {
    cam.pointers.delete(e.pointerId);
    if (cam.pointers.size < 2) cam.pinch = null;
    if (!cam.pointers.size) cam.pan = null;
  };
  vp.addEventListener('pointerup', end);
  vp.addEventListener('pointercancel', end);
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(cam.zoom * (e.deltaY < 0 ? 1.25 : 0.8), x, y);
  }, { passive: false });
  window.addEventListener('resize', layout);
  $('#zoom').addEventListener('click', () => {
    const next = ZOOMS.find((z) => z > cam.zoom + 0.01) || 1;
    const r = vp.getBoundingClientRect();
    zoomAt(next, r.width / 2, r.height / 2);
  });
}

/* ---------------------------------------------------------- one map */

function error(text) {
  const el = $('#errors');
  el.hidden = !text;
  el.textContent = text || '';
}

function describe(d) {
  const sub = $('#sub');
  sub.textContent = '';
  const pill = (text, cls = '') => { const s = document.createElement('span'); s.className = `pill ${cls}`; s.textContent = text; sub.append(s, ' '); };
  pill(d.county || 'no county');
  pill(`${d.title || 'county photo'}${d.year ? ` ${d.year}` : ''}`);
  if (d.native_cm) pill(`${Math.round(d.native_cm)} cm native`);
  pill(`auto-aligned ${Number(d.east).toFixed(2)} m E, ${Number(d.north).toFixed(2)} m N`
    + `${Number(d.scale) !== 1 ? `, x${d.scale}` : ''}`);
  pill(`fit ${Number(d.fit).toFixed(2)} (was ${Number(d.fit0).toFixed(2)})`, doubtful(d) ? 'warn' : '');
  if (d.residual_m !== null && d.residual_m !== undefined) pill(`residual ${Number(d.residual_m).toFixed(2)} m`, Number(d.residual_m) > 0.3 ? 'warn' : '');
  if (d.review) pill(d.review === 'ok' ? 'lines up' : "don't use", d.review);
  if (d.status) pill(`map ${d.status}`);
}

async function open(i) {
  if (i < 0) { labelOptions(); return; }
  view.at = i;
  const m = view.list[i];
  labelOptions();
  $('#said').textContent = '';
  error('');
  let d;
  try {
    const res = await fetch(`/api/admin/county?id=${encodeURIComponent(m.id)}`);
    if (!res.ok) throw new Error(`could not load (${res.status})`);
    d = await res.json();
  } catch (e) { error(String(e.message || e)); return; }
  if (view.list[view.at]?.id !== m.id) return; // moved on meanwhile
  view.doc = d;
  view.nudge = { east: Number(d.review_east) || 0, north: Number(d.review_north) || 0 };
  view.flipped = false;
  describe(d);

  const mb = $('#mapbox');
  const ct = $('#county');
  const loaded = (img) => new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error(`${img.alt} did not load`)); });
  const both = Promise.all([loaded(mb), loaded(ct)]);
  mb.src = `/api/admin/candidate-image?id=${encodeURIComponent(m.id)}`;
  ct.src = `/api/admin/county-image?id=${encodeURIComponent(m.id)}&v=${encodeURIComponent(d.banked_at || '')}`;
  try { await both; } catch (e) { error(String(e.message || e)); }
  view.w = mb.naturalWidth || ct.naturalWidth;
  view.h = mb.naturalHeight || ct.naturalHeight;
  if (ct.naturalWidth && (ct.naturalWidth !== view.w || ct.naturalHeight !== view.h)) {
    error(`The two photos are different sizes (${view.w}x${view.h} and ${ct.naturalWidth}x${ct.naturalHeight}): `
      + 'the county one was not banked over this frame. Do not use it.');
  }
  cam.zoom = 1;
  layout();
  draw();
  placeCounty();
  applyOpacity();
}

async function verdict(review) {
  const m = view.list[view.at];
  if (!m) return;
  $('#said').textContent = 'Saving…';
  try {
    const res = await fetch('/api/admin/county-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: m.id, review, east: view.nudge.east, north: view.nudge.north }),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || String(res.status));
    m.review = out.review;
    m.review_east = out.east;
    m.review_north = out.north;
    $('#said').textContent = review === 'ok'
      ? (out.east || out.north ? 'Saved: lines up with the nudge; it is re-cut on the next re-bank pass.' : 'Saved: lines up.')
      : "Saved: this map stays on Mapbox.";
    const next = stepIn(view.list, view.filter, view.at, 1);
    if (next >= 0 && next !== view.at) setTimeout(() => open(next), 350);
    else labelOptions();
  } catch (e) {
    $('#said').textContent = '';
    error(`Not saved: ${e.message || e}`);
  }
}

function nudge(e, n) {
  view.nudge = {
    east: Math.round((view.nudge.east + e) * 100) / 100,
    north: Math.round((view.nudge.north + n) * 100) / 100,
  };
  placeCounty();
}

function labelOptions() {
  const pick = $('#pick');
  pick.textContent = '';
  const idx = shown(view.list, view.filter);
  for (const i of idx) {
    const m = view.list[i];
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${m.review === 'ok' ? '✓ ' : m.review === 'off' ? '✗ ' : doubtful(m) ? '? ' : ''}${m.county || m.id.slice(0, 24)}`;
    pick.append(o);
  }
  if (!idx.includes(view.at) && view.list[view.at]) {
    const o = document.createElement('option');
    o.value = String(view.at);
    o.textContent = `(${view.list[view.at].county || 'this map'})`;
    pick.prepend(o);
  }
  pick.value = String(view.at);
  const pos = idx.indexOf(view.at);
  const ok = view.list.filter((m) => m.review === 'ok').length;
  const off = view.list.filter((m) => m.review === 'off').length;
  $('#count').textContent = `${idx.length ? `${pos >= 0 ? pos + 1 : '–'} of ${idx.length}` : 'none'}`
    + ` · ${ok} lines up, ${off} don't use, ${view.list.length - ok - off} to check`;
}

async function start() {
  let data;
  try {
    const res = await fetch('/api/admin/county-list');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#locked').hidden = false;
    return;
  }
  view.list = data.maps || [];
  if (!view.list.length) {
    if (data.looked) $('#nonewhy').textContent = `${data.looked} maps looked at so far; none had usable county imagery yet.`;
    $('#none').hidden = false;
    return;
  }
  document.documentElement.classList.add('viewer');
  $('#gate').hidden = true;
  $('#page').hidden = false;
  view.filter = shown(view.list, 'doubtful').length ? 'doubtful' : shown(view.list, 'todo').length ? 'todo' : 'all';
  $('#filter').value = view.filter;
  wireCamera();
  $('#filter').addEventListener('change', (ev) => {
    view.filter = ev.target.value;
    const idx = shown(view.list, view.filter);
    if (idx.length && !idx.includes(view.at)) open(idx[0]); else labelOptions();
  });
  $('#pick').addEventListener('change', (ev) => open(Number(ev.target.value)));
  $('#prev').addEventListener('click', () => open(stepIn(view.list, view.filter, view.at, -1)));
  $('#next').addEventListener('click', () => open(stepIn(view.list, view.filter, view.at, 1)));
  $('#op-mapbox').addEventListener('input', () => { view.flipped = false; applyOpacity(); });
  $('#op-county').addEventListener('input', () => { view.flipped = false; applyOpacity(); });
  $('#flip').addEventListener('click', () => { view.flipped = !view.flipped; applyOpacity(); });
  $('#show-lines').addEventListener('change', draw);
  $('#n-left').addEventListener('click', () => nudge(-NUDGE_M, 0));
  $('#n-right').addEventListener('click', () => nudge(NUDGE_M, 0));
  $('#n-up').addEventListener('click', () => nudge(0, NUDGE_M));
  $('#n-down').addEventListener('click', () => nudge(0, -NUDGE_M));
  $('#n-reset').addEventListener('click', () => { view.nudge = { east: 0, north: 0 }; placeCounty(); });
  $('#ok').addEventListener('click', () => verdict('ok'));
  $('#off').addEventListener('click', () => verdict('off'));
  $('#helpbtn').addEventListener('click', () => { $('#help').hidden = !$('#help').hidden; });
  $('#helpclose').addEventListener('click', () => { $('#help').hidden = true; });
  $('#help').addEventListener('pointerdown', (e) => e.stopPropagation());
  const first = shown(view.list, view.filter)[0];
  open(first ?? 0);
}

if (typeof document !== 'undefined' && document.getElementById('overlay')) start();
