/**
 * Label the trees (trees.html; owner, 2026-10-04). The tree model's canopy
 * over each lawn, made by workflow 28, is labelled per pixel: evergreen, in
 * leaf, bare or not a tree. A brush paints only inside the canopy, Fill
 * paints a whole patch with one tap, and Points moves an outline's corners.
 * Everything is in the photo's own pixels; nothing is projected.
 */
import { rasterizePolygon } from './lib/mask.js';

const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';

/* Code 0 is unlabelled; the codes are what the saved PNG's red channel holds. */
export const CLASSES = [
  { code: 1, id: 'evergreen', label: 'Evergreen', colour: [0, 150, 136] },
  { code: 2, id: 'leaf', label: 'In leaf', colour: [124, 179, 66] },
  { code: 3, id: 'bare', label: 'Bare', colour: [161, 136, 127] },
  { code: 4, id: 'nottree', label: 'Not a tree', colour: [229, 57, 53] },
  { code: 0, id: 'erase', label: 'Erase', colour: [200, 200, 200] },
];
const LABEL_ALPHA = 150;
const WASH = [255, 255, 255, 70]; // unlabelled canopy

const closed = (ring) => (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
  ? [...ring, ring[0]] : ring);
const identity = (p) => p;

/** Which patch each pixel is in (k + 1), 0 for none, from the patches' outlines and holes. */
export function patchIds(clumps, w, h) {
  const ids = new Int32Array(w * h);
  clumps.forEach((c, k) => {
    const m = rasterizePolygon([closed(c.polygon), ...(c.holes || []).map(closed)], w, h, identity);
    for (let i = 0; i < m.length; i++) if (m[i] && !ids[i]) ids[i] = k + 1;
  });
  return ids;
}

/**
 * A round dab of `code` at (x, y), radius r, only on canopy (ids > 0).
 * Returns the box it touched, [x0, y0, x1, y1], or null.
 */
export function dab(labels, ids, w, h, x, y, r, code) {
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(w - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(h - 1, Math.ceil(y + r));
  if (x0 > x1 || y0 > y1) return null;
  const r2 = r * r;
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const i = yy * w + xx;
      if (ids[i] && (xx - x) ** 2 + (yy - y) ** 2 <= r2) labels[i] = code;
    }
  }
  return [x0, y0, x1, y1];
}

/** Every pixel of the patch under (x, y) set to `code`; the patch's number, or 0 if none. */
export function fillAt(labels, ids, w, x, y, code) {
  const k = ids[Math.round(y) * w + Math.round(x)];
  if (!k) return 0;
  for (let i = 0; i < ids.length; i++) if (ids[i] === k) labels[i] = code;
  return k;
}

/** Square metres of each class on the canopy, and unlabelled. */
export function counts(labels, ids, m2PerPx) {
  const n = { unlabelled: 0 };
  for (const c of CLASSES) if (c.code) n[c.id] = 0;
  for (let i = 0; i < labels.length; i++) {
    if (!ids[i]) continue;
    const c = CLASSES.find((k) => k.code === labels[i] && k.code);
    if (c) n[c.id]++; else n.unlabelled++;
  }
  for (const k of Object.keys(n)) n[k] = Math.round(n[k] * m2PerPx * 10) / 10;
  return n;
}

/* ------------------------------------------------------------- the page */

const view = {
  list: [], at: -1, filter: 'todo', model: null, w: 0, h: 0, mpp: 0.1,
  clumps: [], ids: null, labels: null, img: null, ctx: null,
  tool: 'brush', code: 1, sizeM: 1, undo: [], dirty: false, sel: null,
};

const shownIdx = () => view.list.map((m, i) => [m, i]).filter(([m]) => (view.filter === 'all' ? true
  : view.filter === 'nottree' ? m.notTreeM2 > 0
  : view.filter === 'done' ? m.status === 'done' && !m.stale : m.status !== 'done' || m.stale)).map(([, i]) => i);

function pickOptions() {
  const sel = $('#pick');
  sel.textContent = '';
  for (const i of shownIdx()) {
    const m = view.list[i];
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${m.name} · ${m.county || 'traced by hand'} · ${m.clumps} patch${m.clumps === 1 ? '' : 'es'}${m.stale ? ' · outlines remade, look again' : m.status === 'done' ? ' · done' : m.status === 'draft' ? ' · draft' : ''}${m.notTreeM2 > 0 ? ` · not a tree ${Math.round(m.notTreeM2)} m²` : ''}`;
    if (i === view.at) o.selected = true;
    sel.append(o);
  }
}

/* Repaint the label layer within a box (or all of it). */
function paint(box = null) {
  const { w, h, labels, ids, img } = view;
  const [x0, y0, x1, y1] = box || [0, 0, w - 1, h - 1];
  const d = img.data;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x, p = i * 4;
      if (!ids[i]) { d[p + 3] = 0; continue; }
      const c = labels[i] ? CLASSES.find((k) => k.code === labels[i]) : null;
      const col = c ? [...c.colour, LABEL_ALPHA] : WASH;
      d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; d[p + 3] = col[3];
    }
  }
  view.ctx.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

function ringPath(ring) {
  return ring.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('') + 'Z';
}

function drawOutlines() {
  const svg = $('#overlay');
  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
  for (const rings of view.model.lawn || []) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('class', 'lawn');
    p.setAttribute('d', rings.map(ringPath).join(''));
    svg.append(p);
  }
  view.clumps.forEach((c, k) => {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('class', 'clump');
    p.setAttribute('d', [c.polygon, ...(c.holes || [])].map(ringPath).join(''));
    svg.append(p);
    if (view.tool !== 'points') return;
    const r = Math.max(2, 5 / (cam.fit * cam.zoom));
    const ring = c.polygon;
    const last = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.length - 1 : ring.length;
    for (let v = 0; v < last; v++) {
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('class', `vx${view.sel && view.sel[0] === k && view.sel[1] === v ? ' on' : ''}`);
      dot.setAttribute('cx', ring[v][0]); dot.setAttribute('cy', ring[v][1]); dot.setAttribute('r', r);
      dot.dataset.k = String(k); dot.dataset.v = String(v);
      svg.append(dot);
    }
  });
}

function rebuildCanopy() {
  view.ids = patchIds(view.clumps, view.w, view.h);
  paint();
  drawOutlines();
  status();
}

function status() {
  const n = counts(view.labels, view.ids, view.mpp * view.mpp);
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  $('#left').textContent = total
    ? `canopy on the lawn ${Math.round(total)} m² · unlabelled ${Math.round((n.unlabelled / total) * 100)}%`
      + CLASSES.filter((c) => c.code && n[c.id]).map((c) => ` · ${c.label.toLowerCase()} ${Math.round(n[c.id])} m²`).join('')
    : 'no canopy on this lawn';
  $('#undo').disabled = !view.undo.length;
}

function snapshot() {
  view.undo.push({ labels: view.labels.slice(), clumps: JSON.stringify(view.clumps) });
  if (view.undo.length > 40) view.undo.shift();
  view.dirty = true;
  $('#undo').disabled = false;
}

function undo() {
  const s = view.undo.pop();
  if (!s) return;
  view.labels = s.labels;
  const before = JSON.stringify(view.clumps);
  view.clumps = JSON.parse(s.clumps);
  if (before !== s.clumps) rebuildCanopy(); else { paint(); status(); }
  view.dirty = true;
}

/* The labels as a PNG, class codes in the red channel, nothing off the canopy. */
function encodeLabels() {
  const c = document.createElement('canvas');
  c.width = view.w; c.height = view.h;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(view.w, view.h);
  for (let i = 0; i < view.labels.length; i++) {
    out.data[i * 4] = view.ids[i] ? view.labels[i] : 0;
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}

async function decodeLabels(dataUrl, w, h) {
  const im = new Image();
  im.src = dataUrl;
  await im.decode();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(im, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
}

async function save(status, { advance = false } = {}) {
  if (!view.model) return true;
  $('#said').textContent = 'Saving…';
  const body = {
    name: view.model.name, status, clumps: view.clumps, labels: encodeLabels(),
    classes: Object.fromEntries(CLASSES.filter((c) => c.code).map((c) => [c.code, c.id])),
    counts: counts(view.labels, view.ids, view.mpp * view.mpp),
  };
  try {
    const res = await fetch('/api/admin/tree', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
  } catch (e) {
    $('#said').textContent = `Not saved: ${e.message}`;
    return false;
  }
  view.dirty = false;
  view.list[view.at].status = status;
  view.list[view.at].stale = false;
  view.list[view.at].notTreeM2 = counts(view.labels, view.ids, view.mpp * view.mpp).nottree;
  $('#said').textContent = status === 'done' ? 'Saved as done.' : 'Saved.';
  pickOptions();
  if (advance) {
    const idx = shownIdx();
    const next = idx.find((i) => i > view.at) ?? idx[0];
    if (next !== undefined && next !== view.at) open(next);
  }
  return true;
}

async function open(i) {
  if (i === undefined || i < 0) return;
  if (view.dirty && !(await save(view.list[view.at]?.status === 'done' ? 'done' : 'draft'))) return;
  view.at = i;
  const m = view.list[i];
  $('#said').textContent = 'Loading…';
  let got;
  try {
    const res = await fetch(`/api/admin/tree?name=${encodeURIComponent(m.name)}`);
    if (!res.ok) throw new Error(String(res.status));
    got = await res.json();
  } catch (e) {
    $('#said').textContent = `Could not open ${m.name} (${e.message}).`;
    return;
  }
  const model = got.model;
  view.model = model;
  view.w = model.w; view.h = model.h; view.mpp = model.mpp || 0.1;
  /* The outlines saved with the labels, unless workflow 28 has made the map
     again since (B09's canopy came out inverted and was remade, 2026-10-04):
     then the fresh outlines. The painted labels are per pixel and stay. */
  const savedFirst = got.saved?.clumps && (!model.at || !got.saved.at || got.saved.at >= model.at);
  view.clumps = (savedFirst ? got.saved.clumps : model.clumps) || [];
  view.undo = []; view.sel = null; view.dirty = false;
  const canvas = $('#paint');
  canvas.width = view.w; canvas.height = view.h;
  view.ctx = canvas.getContext('2d');
  view.img = view.ctx.createImageData(view.w, view.h);
  view.labels = got.saved?.labels ? await decodeLabels(got.saved.labels, view.w, view.h) : new Uint8Array(view.w * view.h);
  $('#photo').src = `/api/admin/tree-photo?name=${encodeURIComponent(m.name)}`;
  $('#sub').textContent = `${m.name} · ${model.county || 'traced by hand'} · ${view.clumps.length} canopy patch${view.clumps.length === 1 ? '' : 'es'} on the lawn`;
  cam.zoom = 1; cam.x = 0; cam.y = 0;
  layout();
  rebuildCanopy();
  pickOptions();
  $('#said').textContent = got.saved ? `Opened your ${got.saved.status} labels.` : '';
}

/* ------------------------------------------- camera: fit, pinch, two-finger pan */

const cam = { fit: 1, zoom: 1, x: 0, y: 0 };

function layout() {
  if (!view.w) return;
  const vp = $('#viewport').getBoundingClientRect();
  cam.fit = Math.min(vp.width / view.w, vp.height / view.h);
  const st = $('#stage');
  st.style.width = `${view.w * cam.fit}px`;
  st.style.height = `${view.h * cam.fit}px`;
  const w = view.w * cam.fit * cam.zoom, h = view.h * cam.fit * cam.zoom;
  cam.x = w <= vp.width ? (vp.width - w) / 2 : Math.min(0, Math.max(vp.width - w, cam.x));
  cam.y = h <= vp.height ? (vp.height - h) / 2 : Math.min(0, Math.max(vp.height - h, cam.y));
  st.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
}

function zoomAt(z, px, py) {
  const z0 = cam.zoom;
  cam.zoom = Math.max(1, Math.min(10, z));
  cam.x = px - (px - cam.x) * (cam.zoom / z0);
  cam.y = py - (py - cam.y) * (cam.zoom / z0);
  layout();
  if (view.tool === 'points') drawOutlines();
}

function wire() {
  const vp = $('#viewport');
  const pointers = new Map();
  let pinch = null, pan = null, stroke = null, drag = null, tap = null;
  const local = (e) => { const r = vp.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  /* A viewport point in the photo's pixels. */
  const toImg = ([x, y]) => [(x - cam.x) / (cam.fit * cam.zoom), (y - cam.y) / (cam.fit * cam.zoom)];
  const rPx = () => Math.max(1, view.sizeM / view.mpp);

  const strokeTo = (pt) => {
    const [x, y] = toImg(pt);
    const [px, py] = stroke.last;
    const step = Math.max(1, rPx() / 3);
    const n = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / step));
    let box = null;
    for (let s = 1; s <= n; s++) {
      const b = dab(view.labels, view.ids, view.w, view.h, px + ((x - px) * s) / n, py + ((y - py) * s) / n, rPx(), view.code);
      if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
    }
    stroke.last = [x, y];
    if (box) paint(box);
  };

  vp.addEventListener('pointerdown', (e) => {
    if (!view.model) return;
    pointers.set(e.pointerId, local(e));
    vp.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      /* A second finger: whatever the first began is a pinch after all. */
      if (stroke) { undo(); stroke = null; }
      drag = null; tap = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: cam.zoom, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], x: cam.x, y: cam.y };
      return;
    }
    const pt = local(e);
    const vx = e.target?.classList?.contains('vx') ? e.target : null;
    if (view.tool === 'points' && vx) {
      snapshot();
      view.sel = [Number(vx.dataset.k), Number(vx.dataset.v)];
      $('#delpoint').disabled = false;
      drag = { k: view.sel[0], v: view.sel[1] };
      drawOutlines();
    } else if (view.tool === 'brush') {
      snapshot();
      const [x, y] = toImg(pt);
      stroke = { last: [x, y] };
      const b = dab(view.labels, view.ids, view.w, view.h, x, y, rPx(), view.code);
      if (b) paint(b);
    } else if (view.tool === 'fill') {
      tap = { at: pt };
    } else {
      pan = { at: pt, x: cam.x, y: cam.y };
    }
  });

  vp.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      /* From where the pinch began each time, so moves never compound. */
      cam.zoom = pinch.z;
      cam.x = pinch.x + (mid[0] - pinch.mid[0]);
      cam.y = pinch.y + (mid[1] - pinch.mid[1]);
      zoomAt(pinch.z * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d), mid[0], mid[1]);
      return;
    }
    const pt = local(e);
    if (stroke) strokeTo(pt);
    else if (drag) {
      const [x, y] = toImg(pt);
      const ring = view.clumps[drag.k].polygon;
      const p = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
      ring[drag.v] = p;
      if (drag.v === 0 && ring.length > 1) ring[ring.length - 1] = p;
      drawOutlines();
    } else if (pan) {
      cam.x = pan.x + (pt[0] - pan.at[0]);
      cam.y = pan.y + (pt[1] - pan.at[1]);
      layout();
    } else if (tap && Math.hypot(pt[0] - tap.at[0], pt[1] - tap.at[1]) > 8) {
      tap = null; // a drag with Fill is a look around, not a fill
      pan = { at: pt, x: cam.x, y: cam.y };
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size) return;
    if (drag) { drag = null; rebuildCanopy(); }
    if (tap) {
      const [x, y] = toImg(tap.at);
      const before = view.labels.slice();
      const k = fillAt(view.labels, view.ids, view.w, x, y, view.code);
      if (k) {
        view.undo.push({ labels: before, clumps: JSON.stringify(view.clumps) });
        view.dirty = true;
        paint();
        $('#said').textContent = `Patch filled: ${CLASSES.find((c) => c.code === view.code).label.toLowerCase()}.`;
      } else {
        $('#said').textContent = 'Tap inside a yellow outline to fill it.';
      }
      tap = null;
    }
    if (stroke) stroke = null;
    pan = null;
    status();
  };
  vp.addEventListener('pointerup', end);
  vp.addEventListener('pointercancel', end);
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(cam.zoom * (e.deltaY < 0 ? 1.25 : 0.8), x, y);
  }, { passive: false });
  window.addEventListener('resize', layout);
}

function setTool(t) {
  view.tool = t;
  for (const id of ['brush', 'fill', 'points', 'move']) $(`#t-${id}`).setAttribute('aria-pressed', String(id === t));
  $('#delpoint').hidden = t !== 'points';
  $('#delpoint').disabled = !view.sel;
  drawOutlines();
}

function deletePoint() {
  if (!view.sel) return;
  const [k, v] = view.sel;
  const ring = view.clumps[k]?.polygon;
  const isClosed = ring && ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
  const corners = ring ? ring.length - (isClosed ? 1 : 0) : 0;
  if (corners <= 3) { $('#said').textContent = 'An outline needs at least three points.'; return; }
  snapshot();
  ring.splice(v, 1);
  if (v === 0 && isClosed) ring[ring.length - 1] = ring[0];
  view.sel = null;
  rebuildCanopy();
}

async function start() {
  let data;
  try {
    const res = await fetch('/api/admin/trees');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#locked').hidden = false;
    return;
  }
  view.list = (data.maps || []).filter((m) => m.clumps > 0);
  if (!view.list.length) { $('#none').hidden = false; return; }
  document.documentElement.classList.add('viewer');
  $('#gate').hidden = true;
  $('#page').hidden = false;

  const bar = $('#classes');
  for (const c of CLASSES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cls';
    b.textContent = c.label;
    b.style.setProperty('--c', `rgb(${c.colour.join(',')})`);
    b.setAttribute('aria-pressed', String(c.code === view.code));
    b.addEventListener('click', () => {
      view.code = c.code;
      for (const o of bar.children) o.setAttribute('aria-pressed', String(o === b));
      if (view.tool === 'points' || view.tool === 'move') setTool('brush');
    });
    bar.append(b);
  }
  for (const t of ['brush', 'fill', 'points', 'move']) $(`#t-${t}`).addEventListener('click', () => setTool(t));
  const size = $('#size');
  const sizeSaid = () => { view.sizeM = Number(size.value); $('#sizesaid').textContent = `${view.sizeM} m`; };
  size.addEventListener('input', sizeSaid);
  sizeSaid();
  $('#delpoint').addEventListener('click', deletePoint);
  $('#undo').addEventListener('click', () => { undo(); status(); });
  $('#save').addEventListener('click', () => save(view.list[view.at]?.status === 'done' ? 'done' : 'draft'));
  $('#done').addEventListener('click', () => save('done', { advance: true }));
  $('#filter').addEventListener('change', (ev) => {
    view.filter = ev.target.value;
    const idx = shownIdx();
    if (idx.length && !idx.includes(view.at)) open(idx[0]); else pickOptions();
  });
  $('#pick').addEventListener('change', (ev) => open(Number(ev.target.value)));
  $('#prev').addEventListener('click', () => { const idx = shownIdx(); open([...idx].reverse().find((i) => i < view.at) ?? idx.at(-1)); });
  $('#next').addEventListener('click', () => { const idx = shownIdx(); open(idx.find((i) => i > view.at) ?? idx[0]); });
  $('#helpbtn').addEventListener('click', () => { $('#help').hidden = !$('#help').hidden; });
  $('#helpclose').addEventListener('click', () => { $('#help').hidden = true; });
  $('#help').addEventListener('pointerdown', (e) => e.stopPropagation());
  window.addEventListener('beforeunload', (ev) => { if (view.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
  wire();
  view.filter = shownIdx().length ? 'todo' : 'all';
  $('#filter').value = view.filter;
  open(shownIdx()[0] ?? 0);
}

if (typeof document !== 'undefined' && document.getElementById('paint')) start();
