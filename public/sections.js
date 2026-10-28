/**
 * The lawn sections tool's page (sections.html). The cuts themselves are
 * lib/sections.js; this file is the map, the fingers and the saving.
 *
 * Opened from the dashboard on one saved map (?map=<id>). It reads the lawn
 * from the map's record, never changes it, and keeps its sections as its own
 * part (POST /api/maps/tool?tool=sections, docs/MAPS.md).
 */

import {
  startSections, sliceSections, cutOutShape, joinSections, fitToLawn,
  sectionSqFt, totalSqFt, sectionsPart, sectionsFromPart,
} from './lib/sections.js';
import { sizeLabel, labelSpot } from './lib/size-label.js';
import { autoYards } from './lib/yards.js';
import { themeIn } from './lib/overture.js';

const $ = (s) => document.querySelector(s);
const clip = window.polygonClipping;
const HOME = (() => { const h = location.hostname; return /workers\.dev$|localhost|^[\d.]+$|^$/.test(h) ? null : h.split('.').slice(-2).join('.'); })();
const COLORS = ['#ffb300', '#29b6f6', '#ec407a', '#9ccc65', '#ab47bc', '#ff7043', '#26a69a', '#d4e157', '#5c6bc0', '#8d6e63'];
const colorOf = (s) => COLORS[(s.id - 1) % COLORS.length];

const view = { map: null, record: null, sections: [], undo: [], tool: 'move', selected: null, joinFirst: null, shapePts: [], stroke: null, admin: false, lot: null, auto: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function hint(text, warn = false) { const h = $('#hint'); h.textContent = text || ''; h.classList.toggle('warn', !!warn); }
function stop(html) { const m = $('#msg'); m.innerHTML = html; m.hidden = false; $('#tools').hidden = true; $('#panel').hidden = true; }

/* ------------------------------------------------------------- loading */

async function openMap(id) {
  const res = await fetch(`/api/maps/one?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The map could not be read (${res.status}).`);
  return (await res.json()).map || null;
}

/** Signed in as an admin? The auto-front prototype and the corpus check show only then. */
async function isAdmin() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    return res.ok && Boolean((await res.json())?.user?.admin);
  } catch { return false; }
}

/**
 * A CORPUS LOT FOR THE AUTO-FRONT CHECK (admin; owner, 2026-10-28). Opened
 * with ?lot=<id>: its lawn and its county parcel, whose record carries the
 * street address the rule reads. Nothing is saved for it; the verdict goes
 * to /api/admin/yard-marks.
 */
async function openLot(id) {
  if (id === 'next') {
    // The one-tap way in: the newest lot nobody has marked yet.
    const list = await fetch('/api/admin/yard-lots', { credentials: 'same-origin' });
    if (!list.ok) return null;
    const next = ((await list.json()).lots || []).find((l) => !l.mark);
    if (!next) return null;
    location.replace(`/sections?lot=${encodeURIComponent(next.id)}`);
    return new Promise(() => {}); // the page is leaving
  }
  const res = await fetch(`/api/admin/yard-lot?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  if (!res.ok) return null;
  const { lot, mark } = await res.json();
  if (!lot) return null;
  view.lot = { id: lot.id, mark };
  // The corpus keeps no address (deliberately); the street comes from a lookup of the lot's point, and is never kept.
  return { id: null, address: `Corpus lot${lot.county ? `, ${lot.county}` : ''}`, street: lot.street || null, lng: lot.lng, lat: lot.lat, parcel: lot.parcel, shapes: lot.shapes || [], tools: {} };
}

async function start() {
  const params = new URLSearchParams(location.search);
  const id = params.get('map');
  const lotId = params.get('lot');
  const dash = HOME ? `https://${HOME}/dashboard` : '/';
  $('#back').href = id && HOME ? `${dash}?map=${encodeURIComponent(id)}` : dash;
  if (!clip) { stop('<p>The page did not load fully. Reload it.</p>'); return; }
  if (!id && !lotId) { stop(`<p>Open a map from <a href="${dash}">your maps</a> to split its lawn into sections.</p>`); return; }
  view.admin = await isAdmin();
  let record;
  if (lotId) {
    if (!view.admin) { stop(`<p>That is not one of your maps. <a href="${dash}">Your maps</a></p>`); return; }
    try { record = await openLot(lotId); } catch (e) { stop(`<p>${esc(e.message)}</p>`); return; }
    if (!record) { stop('<p>No such lot in the corpus.</p>'); return; }
  } else {
    try { record = await openMap(id); } catch (e) { stop(`<p>${esc(e.message)}</p>`); return; }
    if (!record) { stop(`<p>That map is not one of yours. <a href="${dash}">Your maps</a></p>`); return; }
  }
  const shapes = (record.shapes || []).filter((f) => f?.geometry);
  if (!shapes.length) {
    stop(`<p>This map has no lawn yet. Measure it in the <a href="/?map=${encodeURIComponent(id)}">Lawn Mapper</a> first, then come back.</p>`);
    return;
  }
  view.record = record;
  view.shapes = shapes;
  $('#title').textContent = record.address || 'Lawn sections';
  document.title = `${record.address ? `${record.address} - ` : ''}Lawn sections`;

  const kept = sectionsFromPart(record.tools?.sections?.data);
  try {
    view.sections = kept ? fitToLawn(clip, kept, shapes) : startSections(clip, shapes);
  } catch {
    view.sections = startSections(clip, shapes);
  }
  // The lawn redrawn since the sections were kept: fitted now, so save the fit.
  const stale = kept && record.tools.sections.basedOn && record.at && record.tools.sections.basedOn !== record.at;

  // The tools and the list first, so the map is made at its final size and
  // the lawn is framed in the part of the screen that shows it.
  $('#tools').hidden = false;
  $('#panel').hidden = false;
  renderList();
  await makeMap();
  view.map.resize();
  render();
  fitView();
  $('#auto').hidden = !view.admin;
  $('#auto-sides-label').hidden = !view.admin;
  if (view.lot) {
    $('#review').hidden = false;
    reviewBar();
    await autoFront();
    return;
  }
  if (stale) { save(); hint('The lawn was changed since these sections were made. They have been fitted to it: check them.'); }
  else if (!kept) hint('Pick a tool below to cut the lawn into sections. They always add up to the whole lawn.');
}

/* ------------------------------------------------------------- auto front */

const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * 6378137, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * 6378137];

/** Overture's roads (with their names) and building outlines over the lot, read once. */
async function streetsAndBuildings() {
  if (view.auto) return view.auto;
  const pts = [];
  const ring = view.record.parcel?.geometry?.coordinates?.[0] || view.record.parcel?.coordinates?.[0] || [];
  for (const p of ring) pts.push(toMerc(p));
  for (const s of view.sections) for (const poly of s.poly) for (const p of poly[0]) pts.push(toMerc(p));
  if (!pts.length) throw new Error('Nothing to look around.');
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const pad = 120; // far enough to catch the street on every side, and the corner
  const bbox = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  const [tr, bl] = await Promise.all([themeIn('transportation', bbox), themeIn('buildings', bbox)]);
  const roads = tr.filter((f) => f.type === 2 && (f.props.subtype === 'road' || !f.props.subtype)).map((f) => {
    let name = f.props['@name'] || null;
    if (!name && f.props.names) { try { name = JSON.parse(f.props.names)?.primary || null; } catch { name = null; } }
    return { name, cls: f.props.class || 'unknown', sub: f.props.subclass || null, lines: f.parts };
  });
  const buildings = bl.filter((f) => f.type === 3 && f.layer === 'building').map((f) => f.parts);
  view.auto = { roads, buildings };
  return view.auto;
}

/**
 * FRONT, BACK AND SIDES FROM THE ADDRESS (owner, 2026-10-28; lib/yards.js).
 * Replaces the sections with the rule's proposal, as one Undo. The house
 * outline it read is drawn, so a wrong answer can be seen for what it is.
 */
async function autoFront() {
  const btn = $('#auto');
  btn.disabled = true;
  hint('Reading the streets and the building outline...');
  let data;
  try { data = await streetsAndBuildings(); } catch (e) { hint(`The streets could not be read: ${e.message}`, true); btn.disabled = false; return; }
  const lawn = view.shapes;
  const sides = $('#auto-sides').checked;
  const r = autoYards(clip, {
    parcel: view.record.parcel, buildings: data.buildings, roads: data.roads, lawn, sides,
    address: view.record.address, street: view.record.street || null,
    point: Number.isFinite(view.record.lng) && Number.isFinite(view.record.lat) ? [view.record.lng, view.record.lat] : null,
  });
  btn.disabled = false;
  if (r.error) { view.lastAuto = { ...(r.info || {}), error: r.error, unclear: Boolean(r.unclear) }; if (data.buildings.length) drawBuildings(data.buildings); hint(r.error, true); return; }
  // Only the house it chose is drawn: the one with the most of itself on the lot.
  drawBuildings(data.buildings);
  view.lastAuto = r.info;
  let id = 1;
  const sections = r.sections.map((s) => ({ id: id++, name: s.name, poly: s.poly }));
  const i = r.info;
  const where = `${i.matched ? 'faces' : 'nearest street,'} ${i.street}, ${i.facing}`;
  const extra = (i.facesCorner ? ', set to the corner' : i.cornerStrip ? `, corner lot with ${i.sideStreet}` : i.sideStreet ? `, ${i.sideStreet} near` : '') + (i.pinched ? `, ${i.pinched} pinch${i.pinched > 1 ? 'es' : ''}` : '') + (i.otherBuilding ? ', another building on the lot' : '');
  apply({ sections }, `Auto front: ${where}${extra}. Check it, then fix anything by hand.`);
}

function drawBuildings(buildings) {
  const map = view.map;
  const data = { type: 'FeatureCollection', features: buildings.map((rings) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } })) };
  if (map.getSource('buildings')) map.getSource('buildings').setData(data);
  else {
    map.addSource('buildings', { type: 'geojson', data });
    map.addLayer({ id: 'buildings', type: 'line', source: 'buildings', paint: { 'line-color': '#fff', 'line-width': 1.5, 'line-opacity': 0.8 } }, 'draft-fill');
  }
}

$('#auto').addEventListener('click', () => { if (view.map) autoFront(); });
$('#auto-sides').addEventListener('change', () => { if (view.map && view.lastAuto) autoFront(); });

/* ------------------------------------------------------------- the check */

function reviewBar() {
  const m = view.lot?.mark;
  $('#tally').textContent = m ? `Marked ${m.verdict}` : '';
  fetch('/api/admin/yard-marks', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d) return;
    const t = d.tally;
    $('#tally').textContent = `${t.right} right, ${t.wrong} wrong${t.skip ? `, ${t.skip} skipped` : ''}${t.pctRight !== null ? ` (${t.pctRight}% right)` : ''}${m ? ` · this one: ${m.verdict}` : ''}`;
  }).catch(() => {});
}

async function mark(verdict) {
  if (!view.lot) return;
  let note = '';
  if (verdict === 'wrong') note = window.prompt('What went wrong? (optional)', '') || '';
  const res = await fetch('/api/admin/yard-marks', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: view.lot.id, verdict, note, info: view.lastAuto || null }),
  });
  if (!res.ok) { hint(`The mark was not kept (${res.status}).`, true); return; }
  view.lot.mark = { verdict };
  reviewBar();
  await nextLot();
}

/** The newest corpus lot not yet marked, after this one. */
async function nextLot() {
  const res = await fetch('/api/admin/yard-lots', { credentials: 'same-origin' });
  if (!res.ok) return;
  const { lots } = await res.json();
  const at = lots.findIndex((l) => l.id === view.lot.id);
  const after = [...lots.slice(at + 1), ...lots.slice(0, Math.max(0, at))];
  const next = after.find((l) => !l.mark);
  if (!next) { hint('Every lot with a county parcel has been marked.'); return; }
  location.href = `/sections?lot=${encodeURIComponent(next.id)}`;
}

$('#mark-right').addEventListener('click', () => mark('right'));
$('#mark-wrong').addEventListener('click', () => mark('wrong'));
$('#mark-skip').addEventListener('click', () => mark('skip'));
$('#next-lot').addEventListener('click', () => nextLot());

/* ------------------------------------------------------------- the map */

async function makeMap() {
  const cfg = await (await fetch('/api/config')).json();
  mapboxgl.accessToken = cfg.mapboxToken;
  const map = new mapboxgl.Map({
    container: 'map', style: 'mapbox://styles/mapbox/satellite-v9', projection: 'mercator',
    center: [view.record.lng || -85.6, view.record.lat || 42.9], zoom: 18, maxZoom: 22, pitchWithRotate: false, dragRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the map did not load')), 30000);
    map.once('load', () => { clearTimeout(t); resolve(); });
  });
  map.addSource('sections', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'sections-fill', type: 'fill', source: 'sections', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'on'], 0.6, 0.38] } });
  map.addLayer({ id: 'sections-line', type: 'line', source: 'sections', paint: { 'line-color': '#fff', 'line-width': ['case', ['get', 'on'], 3, 1.5] } });
  if (view.record.parcel?.geometry) {
    map.addSource('parcel', { type: 'geojson', data: view.record.parcel });
    map.addLayer({ id: 'parcel', type: 'line', source: 'parcel', paint: { 'line-color': '#ffeb3b', 'line-width': 1.5, 'line-dasharray': [2, 2] } }, 'sections-fill');
  }
  map.addSource('draft', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#fff', 'fill-opacity': 0.2 } });
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#fff', 'line-width': 2.5, 'line-dasharray': [1.5, 1] } });
  map.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#2e7d32', 'circle-stroke-width': 2 } });
  map.on('move', queueLabels);
  map.on('resize', queueLabels);
  view.map = map;
  window.__sectionsMap = map; // for tests: they draw through the map's own projection
  wireFingers(map);
}

const empty = () => ({ type: 'FeatureCollection', features: [] });

function fitView() {
  const b = new mapboxgl.LngLatBounds();
  for (const s of view.sections) for (const p of s.poly) for (const pt of p[0]) b.extend(pt);
  if (!b.isEmpty()) view.map.fitBounds(b, { padding: { top: 76, bottom: 24, left: 24, right: 24 }, duration: 0, maxZoom: 21 }); // the hint sits along the top
}

/* ------------------------------------------------------------- drawing */

function render() {
  const map = view.map;
  if (!map) return;
  map.getSource('sections').setData(sectionFeatures());
  const total = totalSqFt(view.sections);
  $('#total').textContent = sizeLabel(total);
  renderList();
  queueLabels();
  $('#undo').disabled = !view.undo.length;
}

function renderList() {
  const list = $('#list');
  const rows = [...view.sections].sort((a, b) => sectionSqFt(b) - sectionSqFt(a));
  list.innerHTML = rows.map((s) => `
    <div class="row${s.id === view.selected ? ' on' : ''}" data-id="${s.id}">
      <span class="sw" style="background:${colorOf(s)}"></span>
      <input value="${esc(s.name)}" placeholder="Name it (front, back, side)" maxlength="40" aria-label="Section name">
      <span class="size">${Math.round(sectionSqFt(s)).toLocaleString()} sqft</span>
    </div>`).join('');
  for (const row of list.querySelectorAll('.row')) {
    const id = Number(row.dataset.id);
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      const s = view.sections.find((x) => x.id === id);
      if (s) { s.name = input.value.slice(0, 40); queueLabels(); save(); }
    });
    input.addEventListener('focus', () => { view.selected = id; highlight(); });
  }
}

function sectionFeatures() {
  return {
    type: 'FeatureCollection',
    features: view.sections.map((s) => ({
      type: 'Feature', id: s.id,
      properties: { id: s.id, color: colorOf(s), on: s.id === view.selected || s.id === view.joinFirst },
      geometry: { type: 'MultiPolygon', coordinates: s.poly },
    })),
  };
}

/** The picked section lit on the map and in the list. */
function highlight() {
  for (const row of document.querySelectorAll('#list .row')) row.classList.toggle('on', Number(row.dataset.id) === view.selected);
  view.map?.getSource('sections')?.setData(sectionFeatures());
}

/* Labels: the section's name and size, inside its biggest piece. */
let labelFrame = 0;
function queueLabels() { if (!labelFrame) labelFrame = requestAnimationFrame(() => { labelFrame = 0; drawLabels(); }); }
function drawLabels() {
  const box = $('#labels');
  const map = view.map;
  if (!map) return;
  const placed = [];
  const html = [];
  for (const s of view.sections) {
    const big = s.poly.reduce((a, b) => (ringSpan(b[0]) > ringSpan(a[0]) ? b : a));
    const rings = big.map((r) => r.map((pt) => { const p = map.project(pt); return [p.x, p.y]; }));
    const text = sizeLabel(sectionSqFt(s));
    const name = s.name ? `<b>${esc(s.name)}</b>` : '';
    const w = Math.max(text.length * 7, s.name ? Math.min(40, s.name.length) * 7.5 : 0) + 6;
    const h = s.name ? 30 : 16;
    const at = labelSpot(rings, w, h, { avoid: placed });
    if (!at) continue;
    placed.push([at[0] - w / 2, at[1] - h / 2, at[0] + w / 2, at[1] + h / 2]);
    html.push(`<div class="lab" style="left:${at[0]}px;top:${at[1]}px">${name}${text}</div>`);
  }
  box.innerHTML = html.join('');
}
function ringSpan(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a);
}

function draft(features) { view.map.getSource('draft').setData({ type: 'FeatureCollection', features }); }

/* ------------------------------------------------------------- tools */

const HINTS = {
  move: 'Move the map, or tap a section to pick it.',
  slice: 'Drag a straight line across the lawn to cut it in two.',
  draw: 'Draw a line with your finger across the lawn to cut along it.',
  square: 'Drag a box. The lawn inside it becomes a new section.',
  shape: 'Tap to place points around an area, then press Cut shape.',
  join: 'Tap two sections to make them one.',
};

function setTool(tool) {
  view.tool = tool;
  view.shapePts = [];
  view.joinFirst = null;
  view.stroke = null;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  const drawing = tool === 'slice' || tool === 'draw' || tool === 'square';
  const map = view.map;
  if (drawing) { map.dragPan.disable(); map.touchZoomRotate.disable(); map.doubleClickZoom.disable(); }
  else { map.dragPan.enable(); map.touchZoomRotate.enable(); map.touchZoomRotate.disableRotation(); }
  if (tool === 'shape') map.doubleClickZoom.disable(); else if (!drawing) map.doubleClickZoom.enable();
  $('#map').classList.toggle('drawing', drawing);
  $('#shape-done').hidden = tool !== 'shape';
  $('#shape-done').disabled = true;
  draft([]);
  highlight();
  hint(HINTS[tool]);
}

/** A change: kept for Undo, drawn and saved. */
function apply(result, done) {
  if (result.error) { hint(result.error, true); return false; }
  view.undo.push(view.sections);
  if (view.undo.length > 30) view.undo.shift();
  view.sections = result.sections;
  render();
  save();
  hint(done);
  return true;
}

const ll = (p) => { const x = view.map.unproject(p); return [x.lng, x.lat]; };
const pointOf = (e) => { const r = $('#map').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

function wireFingers(map) {
  const el = map.getCanvasContainer();
  el.addEventListener('pointerdown', (e) => {
    if (!['slice', 'draw', 'square'].includes(view.tool) || !e.isPrimary) return;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    view.stroke = [pointOf(e)];
  });
  el.addEventListener('pointermove', (e) => {
    if (!view.stroke || !e.isPrimary) return;
    const p = pointOf(e);
    if (view.tool === 'draw') view.stroke.push(p);
    else view.stroke[1] = p;
    drawStroke();
  });
  const finish = (e) => {
    if (!view.stroke || !e.isPrimary) return;
    const s = view.stroke;
    view.stroke = null;
    draft([]);
    if (s.length < 2) return;
    if (view.tool === 'square') {
      const [[x0, y0], [x1, y1]] = s;
      if (Math.abs(x1 - x0) < 6 || Math.abs(y1 - y0) < 6) { hint('Drag a bigger box.', true); return; }
      apply(cutOutShape(clip, view.sections, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(ll)), 'Cut out. Name it in the list below.');
    } else {
      const len = s.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - s[i - 1][0], p[1] - s[i - 1][1]) : 0), 0);
      if (len < 12) { hint('Draw a longer line across the lawn.', true); return; }
      apply(sliceSections(clip, view.sections, s.map(ll)), 'Cut in two. Name the pieces in the list below.');
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', () => { view.stroke = null; draft([]); });

  map.on('click', (e) => {
    const p = [e.point.x, e.point.y];
    if (view.tool === 'shape') {
      view.shapePts.push(ll(p));
      $('#shape-done').disabled = view.shapePts.length < 3;
      drawShape();
      return;
    }
    const hit = map.queryRenderedFeatures(e.point, { layers: ['sections-fill'] })[0];
    const id = hit ? Number(hit.properties.id) : null;
    if (view.tool === 'join') {
      if (!id) return;
      if (!view.joinFirst) { view.joinFirst = id; highlight(); hint('Now tap the section to join it to.'); return; }
      if (id === view.joinFirst) { view.joinFirst = null; highlight(); hint(HINTS.join); return; }
      const first = view.joinFirst;
      view.joinFirst = null;
      if (apply(joinSections(clip, view.sections, first, id), 'Joined.')) view.selected = first;
      highlight();
      return;
    }
    if (view.tool === 'move') {
      view.selected = id;
      highlight();
      if (id) document.querySelector(`#list .row[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  });
}

function drawStroke() {
  const s = view.stroke;
  if (!s || s.length < 2) return;
  if (view.tool === 'square') {
    const [[x0, y0], [x1, y1]] = s;
    const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(ll);
    draft([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }]);
  } else {
    draft([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: s.map(ll) } }]);
  }
}

function drawShape() {
  const pts = view.shapePts;
  const f = pts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
  if (pts.length >= 3) f.unshift({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
  else if (pts.length === 2) f.unshift({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
  draft(f);
}

for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => view.map && setTool(b.dataset.tool));
$('#shape-done').addEventListener('click', () => {
  if (view.shapePts.length < 3) return;
  if (apply(cutOutShape(clip, view.sections, view.shapePts), 'Cut out. Name it in the list below.')) {
    view.shapePts = [];
    $('#shape-done').disabled = true;
    draft([]);
  }
});
$('#undo').addEventListener('click', () => {
  if (!view.undo.length) return;
  view.sections = view.undo.pop();
  view.selected = null;
  render();
  save();
  hint('Undone.');
});

/* ------------------------------------------------------------- saving */

let saveTimer = null;
function save() {
  const id = view.record?.id;
  if (!id) return;
  $('#saved').textContent = 'Saving...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const data = sectionsPart(view.sections);
    if (JSON.stringify(data).length > 63000) { $('#saved').textContent = 'Too many cuts to save. Undo a few or join some sections.'; return; }
    try {
      const res = await fetch(`/api/maps/tool?id=${encodeURIComponent(id)}&tool=sections`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, basedOn: view.record.at || null }),
      });
      $('#saved').textContent = res.ok ? 'Saved to this map.' : `Not saved (${res.status}). Your next change tries again.`;
    } catch {
      $('#saved').textContent = 'Not saved: no connection. Your next change tries again.';
    }
  }, 800);
}

start().catch((e) => stop(`<p>${esc(e?.message || 'Something went wrong.')}</p>`));
