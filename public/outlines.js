/**
 * The review page for not-lawn examples (see outlines.html and
 * worker/src/outlines.js). Everything goes in with textContent and DOM
 * nodes; the outlines are drawn as SVG over the example's photograph,
 * projected with the same frame arithmetic the training pipeline uses.
 */
import { lngLatToFramePx, metresPerPixel } from './lib/mercator.js';
import { alignImages, luminance } from './lib/align.js';

const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';

export const CLASS_COLOURS = {
  building: '#4285f4', water: '#00bcd4', pool: '#18ffff', road: '#ff5252',
  driveway: '#ff9800', parking: '#ffeb3b', sidewalk: '#e040fb', rail: '#795548',
};

const view = {
  list: [], at: 0, filter: 'draft', doc: null, dropped: new Set(), w: 0, h: 0,
  /* Metres (east, north): all outlines together, and one outline dragged on its own. */
  shift: { east: 0, north: 0, source: null }, shifts: new Map(),
  /* Outlines listed for this frame with no part inside the photograph. */
  outside: new Set(),
};
const NUDGE_M = 0.25;
const DRAG_SLOP_PX = 5;

/** Shift in metres from alignImages' answer on a grid of cellM metres a cell. */
export function shiftFromFit(fit, cellM) {
  return { east: fit.dx * cellM, north: -fit.dy * cellM };
}

/** Polygons of any geometry, as lists of rings. Overlapping parts stay separate. */
export function polygonsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/**
 * Whether any part of a polygon (rings in photo pixels) lies inside the
 * w x h photograph. A public outline is picked up when its BOX touches the
 * frame, so a winding stream or an L-shaped pond can be listed while none of
 * it is in the picture (owner, 2026-09-28: "the key says water, but I'm not
 * seeing anything labelled water").
 */
export function touchesPhoto(rings, w, h) {
  const outer = rings[0] || [];
  if (outer.some(([x, y]) => x >= 0 && x <= w && y >= 0 && y <= h)) return true;
  const inRing = (px, py, ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  if ([[0, 0], [w, 0], [w, h], [0, h]].some(([x, y]) => inRing(x, y, outer))) return true;
  const cross = (a, b, c, d) => {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  };
  const box = [[0, 0], [w, 0], [w, h], [0, h]];
  for (let i = 1; i < outer.length; i++) {
    for (let k = 0; k < 4; k++) if (cross(outer[i - 1], outer[i], box[k], box[(k + 1) % 4])) return true;
  }
  return false;
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

const pxRings = (rings) => rings.map((ring) => ring.map((ll) => lngLatToFramePx(view.doc.frame, ll, view.w, view.h)));

function findOutside() {
  view.outside = new Set();
  (view.doc.features || []).forEach((f, i) => {
    if (!polygonsOf(f.geometry).some((rings) => touchesPhoto(pxRings(rings), view.w, view.h))) view.outside.add(i);
  });
}

function pathFor(rings) {
  return rings.map((ring) => ring.map((ll, i) => {
    const [x, y] = lngLatToFramePx(view.doc.frame, ll, view.w, view.h);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('') + 'Z').join('');
}

const mpp = () => metresPerPixel(view.doc.frame, view.w);
const offsetOf = (i) => {
  const one = view.shifts.get(i) || { east: 0, north: 0 };
  return { east: view.shift.east + one.east, north: view.shift.north + one.north };
};

function draw() {
  const svg = $('#overlay');
  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
  const m = mpp();
  (view.doc.features || []).forEach((f, i) => {
    if (view.outside.has(i)) return;
    const colour = CLASS_COLOURS[f.properties?.class] || '#ffffff';
    const g = document.createElementNS(SVG, 'g');
    const o = offsetOf(i);
    g.setAttribute('transform', `translate(${(o.east / m).toFixed(2)} ${(-o.north / m).toFixed(2)})`);
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
    grab(g, i);
    svg.append(g);
  });
  shiftLine();
}

/*
 * TAP TO DROP, DRAG TO MOVE (owner, 2026-09-28). A press that stays within a
 * few pixels is a tap and drops or keeps the outline, as before; one that
 * moves drags that outline alone.
 */
function grab(g, i) {
  g.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();   /* the outline's, not a pan of the photo */
    if (cam.pointers.size) return;   /* a second finger joins a pinch, not a drag */
    const svg = $('#overlay');
    const perPx = view.w / svg.getBoundingClientRect().width;
    const start = { x: ev.clientX, y: ev.clientY, was: { ...(view.shifts.get(i) || { east: 0, north: 0 }) } };
    let dragging = false;
    g.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
      dragging = true;
      const m = mpp();
      view.shifts.set(i, { east: start.was.east + dx * perPx * m, north: start.was.north - dy * perPx * m });
      const o = offsetOf(i);
      g.setAttribute('transform', `translate(${(o.east / m).toFixed(2)} ${(-o.north / m).toFixed(2)})`);
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      if (!dragging) {
        if (view.dropped.has(i)) view.dropped.delete(i); else view.dropped.add(i);
      }
      draw();
      legend();
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });
}

function shiftLine() {
  const s = view.shift;
  const moved = [...view.shifts.values()].filter((v) => v.east || v.north).length;
  const dir = (v, pos, neg) => `${Math.abs(v).toFixed(2)} m ${v >= 0 ? pos : neg}`;
  $('#shiftsaid').textContent = (s.east || s.north
    ? `All outlines moved ${dir(s.east, 'east', 'west')}, ${dir(s.north, 'north', 'south')}`
      + (s.source === 'auto' ? ' (lined up with the photo automatically)' : '')
    : 'Outlines where the public map puts them')
    + (moved ? `; ${moved} dragged on ${moved === 1 ? 'its' : 'their'} own.` : '.');
}

function nudge(east, north) {
  view.shift = { east: view.shift.east + east, north: view.shift.north + north, source: 'person' };
  draw();
}

/*
 * LINE THE OUTLINES UP WITH THE PHOTOGRAPH, as NAIP is lined up in the editor
 * (public/lib/align.js): the kept outlines are painted as a mask on a small
 * grid, and the shift that best lays the mask's edges on the photo's edges is
 * taken if it is clearly better than none. Up to 5 m; whole outlines only.
 */
async function autoAlign() {
  const img = $('#photo');
  const gw = 192;
  const gh = Math.max(8, Math.round(gw * view.h / view.w));
  const cellM = mpp() * view.w / gw;
  const photo = document.createElement('canvas');
  photo.width = gw; photo.height = gh;
  const pc = photo.getContext('2d', { willReadFrequently: true });
  pc.drawImage(img, 0, 0, gw, gh);
  const ref = luminance(pc.getImageData(0, 0, gw, gh).data, gw, gh);
  const mask = document.createElement('canvas');
  mask.width = gw; mask.height = gh;
  const mc = mask.getContext('2d', { willReadFrequently: true });
  mc.fillStyle = '#000'; mc.fillRect(0, 0, gw, gh);
  mc.fillStyle = '#fff';
  mc.scale(gw / view.w, gh / view.h);
  (view.doc.features || []).forEach((f, i) => {
    if (view.dropped.has(i) || view.outside.has(i)) return;
    for (const rings of polygonsOf(f.geometry)) mc.fill(new Path2D(pathFor(rings)), 'evenodd');
  });
  const mov = luminance(mc.getImageData(0, 0, gw, gh).data, gw, gh);
  const fit = alignImages(ref, mov, gw, gh, { maxShift: Math.max(2, Math.round(5 / cellM)), scales: [1] });
  const sh = fit.moved ? shiftFromFit(fit, cellM) : { east: 0, north: 0 };
  view.shift = { ...sh, source: fit.moved ? 'auto' : null };
  draw();
}

function legend() {
  const counts = {};
  (view.doc.features || []).forEach((f, i) => {
    if (view.outside.has(i)) return;
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
  if (view.outside.size) {
    const s = document.createElement('span');
    s.className = 'outside';
    s.textContent = `${view.outside.size} listed outline${view.outside.size === 1 ? ' lies' : 's lie'} wholly outside the photo: not shown, not taught`;
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

/* ----------------------------------------------- the viewer: fit, zoom, pan */

/* The photo fitted whole into the viewport, then zoomed about a point. */
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

/* Centred when it fits; never panned so far that photo leaves a gap it need not. */
function clampPan() {
  const vp = $('#viewport').getBoundingClientRect();
  const w = view.w * cam.fit * cam.zoom;
  const h = view.h * cam.fit * cam.zoom;
  cam.x = w <= vp.width ? (vp.width - w) / 2 : Math.min(0, Math.max(vp.width - w, cam.x));
  cam.y = h <= vp.height ? (vp.height - h) / 2 : Math.min(0, Math.max(vp.height - h, cam.y));
}

/* Zoom to z keeping the viewport point (px, py) where it is. */
function zoomAt(z, px, py) {
  const z0 = cam.zoom;
  cam.zoom = Math.max(1, Math.min(6, z));
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

/* ------------------------------------------------ which examples, in order */

export const FILTERS = {
  draft: (e) => e.status !== 'approved' && e.status !== 'rejected',
  approved: (e) => e.status === 'approved',
  rejected: (e) => e.status === 'rejected',
  all: () => true,
};

/** Positions in `list` that pass the filter, in order. */
export function shown(list, filter) {
  const keep = FILTERS[filter] || FILTERS.all;
  return list.map((e, i) => (keep(e) ? i : -1)).filter((i) => i >= 0);
}

/** The next position after `at` (or before, dir -1) that passes, wrapping; -1 if none. */
export function stepIn(list, filter, at, dir = 1) {
  const idx = shown(list, filter);
  if (!idx.length) return -1;
  if (dir > 0) return idx.find((i) => i > at) ?? idx[0];
  return [...idx].reverse().find((i) => i < at) ?? idx[idx.length - 1];
}

async function open(i) {
  if (i < 0) { labelOptions(); return; }
  view.at = i;
  const e = view.list[view.at];
  labelOptions();
  $('#said').textContent = '';
  $('#help').hidden = true;
  const doc = await fetch(`/api/admin/example?id=${encodeURIComponent(e.id)}`).then((r) => r.json());
  if (doc.error || !doc.frame) {
    view.doc = { features: [], frame: null };
    $('#errors').hidden = false;
    $('#errors').textContent = `Could not load this example: ${doc.error || 'no frame'}.`;
    return;
  }
  view.doc = doc;
  view.dropped = new Set((doc.features || []).map((f, k) => (f.properties?.dropped ? k : -1)).filter((k) => k >= 0));
  view.shift = doc.shift ? { east: doc.shift.east, north: doc.shift.north, source: doc.shift.source } : { east: 0, north: 0, source: null };
  view.shifts = new Map((doc.features || []).map((f, k) => [k, f.properties?.shift]).filter(([, v]) => v));
  const t = doc.target || {};
  const sub = `${e.id}: a ${t.class || '?'} (${t.source || '?'}), `
    + `${doc.status === 'approved' ? 'APPROVED' : doc.status === 'rejected' ? 'REJECTED' : 'draft'}`;
  $('#sub').textContent = sub;
  const errs = doc.errors ? Object.entries(doc.errors).map(([k, v]) => `${k}: ${String(v).split('\n')[0]}`) : [];
  $('#errors').hidden = !errs.length;
  $('#errors').textContent = errs.length
    ? `Some outlines may be missing here (a public map did not answer when this was fetched): ${errs.join('; ')}` : '';
  $('#attribution').textContent = doc.attribution || '';
  const img = $('#photo');
  img.onload = async () => {
    view.w = img.naturalWidth; view.h = img.naturalHeight;
    cam.zoom = 1;
    layout();
    findOutside();
    draw(); legend();
    const m = mpp();
    $('#sub').textContent = `${sub} · ${Math.round(view.w * m)} × ${Math.round(view.h * m)} m`;
    /* Never saved before: line the outlines up now; what was saved stands. */
    if (!doc.shift && !doc.reviewedAt) {
      try { await autoAlign(); } catch { /* shown as delivered */ }
    }
  };
  img.src = `/api/admin/example-image?id=${encodeURIComponent(e.id)}`;
}

async function save(status) {
  const e = view.list[view.at];
  $('#said').textContent = 'Saving…';
  const res = await fetch('/api/admin/example', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: e.id, status, dropped: [...new Set([...view.dropped, ...view.outside])],
      shift: view.shift.east || view.shift.north ? view.shift : null,
      shifts: Object.fromEntries([...view.shifts.entries()].filter(([, v]) => v && (v.east || v.north))),
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { $('#said').textContent = `Not saved (${out.error || res.status}).`; return; }
  e.status = out.status;
  e.kept = out.kept || {};
  $('#said').textContent = out.status === 'approved' ? 'Approved.' : out.status === 'rejected' ? 'Rejected.' : 'Saved as a draft.';
  totals();
  /* On to the next one in this list: reviewing is a queue, and so is going back over. */
  if (out.status !== 'draft') {
    const next = stepIn(view.list, view.filter, view.at, 1);
    if (next >= 0 && next !== view.at) open(next); else labelOptions();
  } else labelOptions();
}

function labelOptions() {
  const pick = $('#pick');
  pick.textContent = '';
  const idx = shown(view.list, view.filter);
  for (const i of idx) {
    const e = view.list[i];
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${e.status === 'approved' ? '✓ ' : e.status === 'rejected' ? '✗ ' : ''}${e.id}`;
    pick.append(o);
  }
  if (!idx.includes(view.at)) {
    const o = document.createElement('option');
    o.value = String(view.at);
    o.textContent = `${view.list[view.at]?.id || ''} (not in this list)`;
    pick.prepend(o);
  }
  pick.value = String(view.at);
  const pos = idx.indexOf(view.at);
  $('#count').textContent = idx.length ? `${pos >= 0 ? pos + 1 : '–'} of ${idx.length}` : 'none';
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
  document.documentElement.classList.add('viewer');
  $('#gate').hidden = true;
  $('#page').hidden = false;
  view.filter = shown(view.list, 'draft').length ? 'draft' : 'all';
  $('#filter').value = view.filter;
  totals();
  wireCamera();
  $('#filter').addEventListener('change', (ev) => {
    view.filter = ev.target.value;
    const idx = shown(view.list, view.filter);
    if (idx.length && !idx.includes(view.at)) open(idx[0]); else labelOptions();
  });
  $('#pick').addEventListener('change', (ev) => open(Number(ev.target.value)));
  $('#prev').addEventListener('click', () => open(stepIn(view.list, view.filter, view.at, -1)));
  $('#next').addEventListener('click', () => open(stepIn(view.list, view.filter, view.at, 1)));
  $('#save').addEventListener('click', () => save('draft'));
  $('#approve').addEventListener('click', () => save('approved'));
  $('#reject').addEventListener('click', () => save('rejected'));
  $('#n-left').addEventListener('click', () => nudge(-NUDGE_M, 0));
  $('#n-right').addEventListener('click', () => nudge(NUDGE_M, 0));
  $('#n-up').addEventListener('click', () => nudge(0, NUDGE_M));
  $('#n-down').addEventListener('click', () => nudge(0, -NUDGE_M));
  $('#n-auto').addEventListener('click', () => { view.shifts = new Map(); autoAlign().catch(() => {}); });
  $('#n-reset').addEventListener('click', () => { view.shift = { east: 0, north: 0, source: null }; view.shifts = new Map(); draw(); });
  $('#helpbtn').addEventListener('click', () => { $('#help').hidden = !$('#help').hidden; });
  $('#helpclose').addEventListener('click', () => { $('#help').hidden = true; });
  $('#help').addEventListener('pointerdown', (e) => e.stopPropagation());
  const first = shown(view.list, view.filter)[0];
  open(first ?? 0);
}

if (typeof document !== 'undefined' && document.getElementById('overlay')) start();
