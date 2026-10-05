/**
 * /lidar-trees.html: the lidar's trees beside the tree model's, for looking
 * at (owner, 2026-10-05). Nothing here is saved; workflow 30 writes the maps.
 */
const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';

export const LAYERS = [
  { id: 'inferred', label: 'Inferred', colour: '#ab47bc' },
  { id: 'model', label: 'Tree model', colour: '#ffeb3b' },
  { id: 'lidar', label: 'Lidar trees', colour: '#00e5ff' },
  { id: 'dense', label: 'Dense', colour: '#ff4081' },
  { id: 'lawn', label: 'Lawn', colour: '#69f0ae' },
  { id: 'offlawn', label: 'Off the lawn too', colour: '#00e5ff' },
];

const view = { list: [], at: -1, doc: null, show: { inferred: true, model: true, lidar: true, dense: true, lawn: true, offlawn: false } };
const cam = { fit: 1, zoom: 1, x: 0, y: 0 };

/** An SVG path for a list of rings ([x, y] each). */
export function ringsPath(rings) {
  return rings.filter((r) => r && r.length > 2)
    .map((r) => r.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('') + 'Z').join('');
}

function add(svg, cls, rings) {
  const d = ringsPath(rings);
  if (!d) return;
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('class', cls);
  p.setAttribute('d', d);
  svg.append(p);
}

function draw() {
  const d = view.doc;
  const svg = $('#overlay');
  svg.textContent = '';
  if (!d) return;
  svg.setAttribute('viewBox', `0 0 ${d.w} ${d.h}`);
  const s = view.show;
  if (s.inferred) for (const r of d.inferred || []) add(svg, 'inferred', r);
  if (s.lidar) {
    for (const c of d.lidarClumps || []) {
      if (!c.onLawn && !s.offlawn) continue;
      add(svg, c.onLawn ? 'lidar' : 'lidar off', [c.polygon, ...(c.holes || [])]);
    }
  }
  if (s.dense) for (const c of d.dense || []) add(svg, 'dense', [c.polygon, ...(c.holes || [])]);
  if (s.model) for (const c of d.modelClumps || []) add(svg, 'model', [c.polygon, ...(c.holes || [])]);
  if (s.lawn) for (const r of d.lawn || []) add(svg, 'lawn', r);
}

function layout() {
  const d = view.doc;
  if (!d) return;
  const vp = $('#viewport').getBoundingClientRect();
  cam.fit = Math.min(vp.width / d.w, vp.height / d.h);
  const st = $('#stage');
  st.style.width = `${d.w * cam.fit}px`;
  st.style.height = `${d.h * cam.fit}px`;
  const w = d.w * cam.fit * cam.zoom, h = d.h * cam.fit * cam.zoom;
  cam.x = w <= vp.width ? (vp.width - w) / 2 : Math.min(0, Math.max(vp.width - w, cam.x));
  cam.y = h <= vp.height ? (vp.height - h) / 2 : Math.min(0, Math.max(vp.height - h, cam.y));
  st.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
}

function zoomAt(z, px, py) {
  const z0 = cam.zoom;
  cam.zoom = Math.max(1, Math.min(12, z));
  cam.x = px - (px - cam.x) * (cam.zoom / z0);
  cam.y = py - (py - cam.y) * (cam.zoom / z0);
  layout();
}

function pickOptions() {
  const sel = $('#pick');
  sel.textContent = '';
  view.list.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${m.name} · ${m.county || 'traced by hand'} · lidar ${m.lidarOnLawnSqM} m²`
      + `${m.modelOnLawnSqM === null ? '' : ` · model ${m.modelOnLawnSqM} m²`}`;
    if (i === view.at) o.selected = true;
    sel.append(o);
  });
}

async function open(i) {
  if (i === undefined || i < 0 || i >= view.list.length) return;
  view.at = i;
  const m = view.list[i];
  $('#sub').textContent = `Loading ${m.name}…`;
  try {
    const res = await fetch(`/api/admin/lidar-tree?name=${encodeURIComponent(m.name)}`);
    if (!res.ok) throw new Error(String(res.status));
    view.doc = await res.json();
  } catch (e) {
    $('#sub').textContent = `Could not open ${m.name} (${e.message}).`;
    return;
  }
  const d = view.doc;
  $('#photo').src = `/api/admin/lidar-tree-photo?name=${encodeURIComponent(m.name)}`;
  const cov = m.inferredCovered;
  $('#sub').textContent = `${m.name} · lidar ${d.lidar?.project || '?'}${d.lidar?.year ? ` (${d.lidar.year})` : ''}`
    + ` · on the lawn: lidar ${m.lidarOnLawn} patch${m.lidarOnLawn === 1 ? '' : 'es'}, ${m.lidarOnLawnSqM} m²`
    + `${m.modelOnLawnSqM === null ? ' · no tree-model map' : `; model ${m.modelOnLawn}, ${m.modelOnLawnSqM} m²`}`
    + `${cov ? ` · inferred lawn under tree: lidar ${cov.lidar}%${cov.model === null ? '' : `, model ${cov.model}%`}` : ''}`;
  cam.zoom = 1; cam.x = 0; cam.y = 0;
  layout();
  draw();
  pickOptions();
}

function wire() {
  const vp = $('#viewport');
  const pointers = new Map();
  let pinch = null, pan = null;
  const local = (e) => { const r = vp.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  vp.addEventListener('pointerdown', (e) => {
    if (!view.doc) return;
    pointers.set(e.pointerId, local(e));
    vp.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: cam.zoom, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], x: cam.x, y: cam.y };
      pan = null;
      return;
    }
    const pt = local(e);
    pan = { at: pt, x: cam.x, y: cam.y };
  });
  vp.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      cam.zoom = pinch.z;
      cam.x = pinch.x + (mid[0] - pinch.mid[0]);
      cam.y = pinch.y + (mid[1] - pinch.mid[1]);
      zoomAt(pinch.z * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d), mid[0], mid[1]);
    } else if (pan) {
      const pt = local(e);
      cam.x = pan.x + (pt[0] - pan.at[0]);
      cam.y = pan.y + (pt[1] - pan.at[1]);
      layout();
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) pan = null;
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

async function start() {
  let data;
  try {
    const res = await fetch('/api/admin/lidar-trees');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#locked').hidden = false;
    return;
  }
  view.list = data.maps || [];
  if (!view.list.length) { $('#none').hidden = false; return; }
  document.documentElement.classList.add('viewer');
  $('#gate').hidden = true;
  $('#page').hidden = false;
  const bar = $('#layers');
  for (const l of LAYERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'layer';
    b.textContent = l.label;
    b.style.setProperty('--c', l.colour);
    b.setAttribute('aria-pressed', String(view.show[l.id]));
    b.addEventListener('click', () => {
      view.show[l.id] = !view.show[l.id];
      b.setAttribute('aria-pressed', String(view.show[l.id]));
      draw();
    });
    bar.append(b);
  }
  $('#pick').addEventListener('change', (ev) => open(Number(ev.target.value)));
  $('#prev').addEventListener('click', () => open((view.at - 1 + view.list.length) % view.list.length));
  $('#next').addEventListener('click', () => open((view.at + 1) % view.list.length));
  $('#helpbtn').addEventListener('click', () => { $('#help').hidden = !$('#help').hidden; });
  $('#helpclose').addEventListener('click', () => { $('#help').hidden = true; });
  $('#help').addEventListener('pointerdown', (e) => e.stopPropagation());
  wire();
  open(0);
}

if (typeof document !== 'undefined' && document.getElementById('overlay')) start();
