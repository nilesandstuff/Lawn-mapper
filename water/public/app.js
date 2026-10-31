/**
 * water.<home domain>: THE LOW-SPOT MAP FOR ONE PROPERTY (water session).
 *
 * The property is one of the person's saved maps, chosen from a menu of
 * those whose lawn and shade map are done (lib/maps.js; owner, 2026-10-23:
 * no address search). The lidar is read and the map worked
 * out in a Web Worker (analyse.js -> lib/site.js); then drawn here over the
 * photo, moved by the datum correction the analysis used (lib/datum.js).
 *
 * A SAVED MAP (docs/MAPS.md): opened from the dashboard as ?map=<id>, read
 * with GET /api/maps/one through this site's Worker (same-origin; the
 * sign-in or guest cookie travels), the way the shade page opens a save
 * (public/shade.js siteFromSave): its address, point, property line and
 * lawn outlines. The water part of the map (POST /api/maps/tool, tool
 * "water") keeps what the person enters: downspouts (the roof-edge spot each
 * empties from and the ground it empties to), gutter runs, and whether the
 * lawn has 4 in of loamy topsoil. Nothing is kept in the browser.
 *
 * THE WATERING PLAN (owner, 2026-10-18, water/VISION.md): after the low-spot
 * map the worker reads the soil survey and ten years of weather and runs the
 * daily water balance (lib/plan.js): zones, how much and how often each needs
 * watering month by month, this week's next watering, and the ground a zone's
 * watering leaves too wet or still dry.
 */

import { tracedOn, lineUpAt } from '/lib/shade/traced.js';
import { boxFor } from '/lib/site.js';
import { sprinklers } from '/heads.js';
import { viewer3d, groundMesh } from '/view3d.js';
import { openable } from '/lib/maps.js';
import { KINDS as LAYER_KINDS, FIELD_WORDS, typeWords, hasCounty, askBox, compact, freshEnough, summary as layerSummary, pick as layerPick, intakesNear } from '/lib/layers.js';
import { sectorName } from '/lib/wind.js';
import { SPECIES, groupOf } from '/lib/roots.js';

const $ = (s) => document.querySelector(s);
const R = 6378137;
const view = { photo: null, data: null, frame: null, site: null, plan: null };
const inputs = { downspouts: [], gutters: [], areas: [], topsoil: false, grass: 'cool', species: [], mode: 'normal', texture: '' };
let mode = null, pending = null; // 'from' | 'to' (a downspout) | 'gutter' | 'area'
const added = []; // what was entered, in order, for Undo: 'spout' | 'gutter' | 'area'
const AREA_COLOR = { deck: '#a1887f', pavers: '#bf360c', solid: '#212121', roof: '#fafafa', lawn: '#69f0ae', bed: '#6d4c41' };
const ZONE_RGB = [[46, 134, 222], [230, 126, 34], [142, 68, 173], [22, 160, 133]];
const HOME = document.documentElement.dataset.home || '';
const mapId = new URLSearchParams(location.search).get('map');

/* WHAT IS LOADING, IN SIGHT (owner, 2026-10-24: "give a more obvious indication that something is loading, don't
   lock the UI, but display something that says what's loading in an obvious spot"): every piece of work the page
   is waiting on, named, in a panel fixed at the bottom of the screen with a spinner; taps go through it. */
const busyJobs = new Map();
function busy(key, text) {
  if (text) busyJobs.set(key, text); else busyJobs.delete(key);
  const el = $('#busy');
  if (!el) return;
  el.hidden = !busyJobs.size;
  el.innerHTML = busyJobs.size ? `<span class="spin" aria-hidden="true"></span><span>${[...busyJobs.values()].map((t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))).join('<br>')}</span>` : '';
}
const idle = (key) => busy(key, null);
const clearBusy = () => { busyJobs.clear(); busy('', null); };

function status(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

/* ------------------------------------------------- finding the property */

const asFeature = (p) => (p?.type === 'Feature' ? p : p?.type ? { type: 'Feature', properties: {}, geometry: p } : null);

/** A saved map, as the shade page reads one (public/shade.js siteFromSave). */
async function siteFromMap(id) {
  const res = await fetch(`/api/maps/one?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  const j = await res.json().catch(() => null);
  if (res.status === 404) throw new Error("That map isn't in your maps on this device. Open it from your dashboard, or sign in.");
  if (!res.ok || !j?.map) throw new Error(j?.error || `The map would not open (${res.status}).`);
  const s = j.map;
  if (!Number.isFinite(s.lng) || !Number.isFinite(s.lat)) throw new Error('That map has no location yet. Finish it in Lawn Mapper first.');
  return {
    label: s.address || 'your map', lng: s.lng, lat: s.lat,
    parcel: asFeature(s.parcel),
    lawn: (s.shapes || []).map(asFeature).filter(Boolean),
    // the shade map's cloud, box and shift, when it has worked on this map: the same cells as its part
    lidar: s.tools?.shade?.data?.lidar || null,
    // the trees and branches erased on the shade map: gone from the water map's shade too
    shadeEdits: s.tools?.shade?.data?.grid ? { grid: s.tools.shade.data.grid, erased: s.tools.shade.data.erased || [], cubes: s.tools.shade.data.cubes || [], fences: Array.isArray(s.tools.shade.data.fences) ? s.tools.shade.data.fences : null } : null,
    mapId: id, at: s.at || null,
    // the photo the lawn was traced on (owner 2026-10-19: a county photo if one was saved, Mapbox if Mapbox)
    tracedOn: tracedOn(s),
    water: s.tools?.water?.data || null,
  };
}

/* ------------------------------------------------------------- the photo */

const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];
const fromMerc = ([x, y]) => [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
const worldSize = (zoom) => 512 * 2 ** zoom;
const mercToWorld = ([x, y], zoom) => [((x + Math.PI * R) / (2 * Math.PI * R)) * worldSize(zoom), ((Math.PI * R - y) / (2 * Math.PI * R)) * worldSize(zoom)];

/** One Mapbox frame (Lawn Mapper's /api/imagery) covering the analysis box. */
function frameFor(bbox, lat) {
  const k = Math.cos(lat * Math.PI / 180);
  const spanM = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * k;
  const mPerPxZ0 = (2 * Math.PI * R * k) / 512;
  const zoom = Math.max(15, Math.min(20, Math.floor(Math.log2((1280 * mPerPxZ0) / spanM) * 100) / 100));
  const [lng, clat] = fromMerc([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
  return { lng, lat: clat, zoom, size: 1280, height: 1280 };
}

async function photoOf(frame, provider = 'mapbox', svc = null) {
  const q = new URLSearchParams({ lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, height: frame.height, provider });
  if (svc != null) q.set('svc', svc);
  const res = await fetch(`/api/imagery?${q}`);
  if (!res.ok) throw new Error(`the ${provider === 'county' ? 'county' : 'Mapbox'} photo would not load (${res.status})`);
  return createImageBitmap(await res.blob());
}

/**
 * The photo the map was saved on (lib/shade/traced.js, the shade map's own reading of a save): a county
 * photo moved by the editor's line-up onto the web map's ground, where the lawn was traced over it; Mapbox
 * otherwise, or when the county's will not load. -> { photo, shift: [px, py] to draw it at, name }
 */
async function savedPhoto(frame, site) {
  const t = site.tracedOn || { provider: 'mapbox' };
  if (t.provider === 'county') {
    try {
      const photo = await photoOf(frame, 'county', t.svc);
      const move = lineUpAt(t, [frame.lng, frame.lat]);
      const k = Math.cos((frame.lat * Math.PI) / 180), s = (worldSize(frame.zoom) / (2 * Math.PI * R)) * (photo.width / frame.size);
      return { photo, shift: [(move.east / k) * s, -(move.north / k) * s], name: `the county photo the map was saved on${t.align ? ', where the editor lined it up' : ''}` };
    } catch (e) {
      const photo = await photoOf(frame).catch(() => null);
      return { photo, shift: [0, 0], name: `Mapbox's photo (the county photo the map was saved on would not load: ${e.message})` };
    }
  }
  return { photo: await photoOf(frame).catch(() => null), shift: [0, 0], name: "Mapbox's photo" };
}

/** EPSG:3857 -> pixel on the photo. */
function toPx(frame, img, xy) {
  const c = mercToWorld(toMerc([frame.lng, frame.lat]), frame.zoom);
  const w = mercToWorld(xy, frame.zoom);
  const s = img.width / frame.size;
  return [(w[0] - c[0]) * s + img.width / 2, (w[1] - c[1]) * s + img.height / 2];
}

/* -------------------------------------------------------------- drawing */

/* ONE VIEW AT A TIME (owner, 2026-10-23: "Break up the different views into their respective categories, so
   that it's not just a sea of overlapping and hard to separate colors. Add soil view"). Roofs (white) and paving
   (black) under every view, when wanted; each view's own colours on top, and nothing of the others'. */
const VIEWS = ['zones', 'need', 'soil', 'water', 'drains', 'slope', 'wind', 'sprinklers'];
/** The wind view's steps: each spot's July wind as a share of the open wind, calm (deep teal) to windy (pale). */
const WIND_STEPS = [[0.25, [0, 77, 64, 200]], [0.35, [0, 121, 107, 180]], [0.45, [38, 166, 154, 160]], [0.55, [128, 203, 196, 150]], [Infinity, [224, 242, 241, 150]]];
const WIND_WORDS = ['under a quarter of the open wind', 'a quarter to a third', 'a third to under half', 'about half', 'over half'];
let mapView = 'zones';
/** Soil units' colours: earthy, told apart (the soil view). */
const SOIL_RGB = [[161, 136, 127], [255, 183, 77], [77, 182, 172], [149, 117, 205], [229, 115, 115], [174, 213, 129], [100, 181, 246], [240, 98, 146]];
/** Slope classes for the slope view: light to deep purple (kept apart from the house strip's red, amber, green). */
const SLOPE_STEPS = [[0.02, [237, 231, 246, 0]], [0.05, [209, 196, 233, 150]], [0.1, [149, 117, 205, 170]], [0.2, [94, 53, 177, 190]], [Infinity, [49, 27, 146, 210]]];
const SLOPE_WORDS = ['under 2% (flat)', '2–5%', '5–10%', '10–20%', 'over 20%'];

/** The ground's slope, cell by cell, from the survey's surface (rise over run, central differences). */
function slopeOf(d) {
  if (d.slope) return d.slope;
  const { W, H, cell } = d.grid, z = d.z, out = new Float32Array(W * H).fill(NaN);
  if (!z) return out;
  // over two cells each way (about 4 m): the ground's lie, not the survey's scatter
  const k = 2;
  for (let r = k; r < H - k; r++) for (let c = k; c < W - k; c++) {
    const i = r * W + c, gx = (z[i + k] - z[i - k]) / (2 * k * cell), gy = (z[i + k * W] - z[i - k * W]) / (2 * k * cell);
    if (Number.isFinite(gx) && Number.isFinite(gy)) out[i] = Math.hypot(gx, gy);
  }
  d.slope = out;
  return out;
}

function overlay(d, v, { hard = true } = {}) {
  const { W, H } = d.grid;
  const img = new ImageData(W, H);
  const px = img.data;
  const p = view.plan;
  const slope = v === 'slope' ? slopeOf(d) : null;
  // the soil and the slope on the property only (the lawn when there is no property line): the survey's soil
  // patch and the woods beyond it say nothing about this lawn
  const mine = d.parcelMask || d.lawnMask || null;
  for (let i = 0; i < W * H; i++) {
    let rgba = null;
    // roofs white, paving black (owner 2026-10-19); the plan's own reading once it is in, the person's marks included
    const kind = p?.kinds ? p.kinds[i] : d.wall[i] ? 2 : d.paved && Number.isFinite(d.paved[i]) && d.paved[i] >= 0.5 ? 3 : 0;
    if (hard && kind === 2) rgba = [250, 250, 250, 170];
    if (hard && kind === 3) rgba = [12, 12, 12, 190];
    if (hard && kind === 4) rgba = [150, 60, 30, 170]; // a brick or paver patio
    const ground = kind !== 2 && kind !== 3 && kind !== 4;
    if (v === 'zones' && p && p.zoneOf[i] >= 0 && kind === 1) {
      rgba = [...ZONE_RGB[p.zoneOf[i] % ZONE_RGB.length], 105];
      if (p.wetAnyway[i] >= 0.1) rgba = [13, 71, 161, 200];
      else if (p.wetFromWatering[i] >= 0.05) rgba = [255, 23, 68, 200];
      else if (p.dryShare[i] > (p.mode !== 'normal' && p.stress ? p.stress.planned : 0) + 0.1) rgba = [255, 214, 0, 190]; // at a lower level: drier than the rest of the lawn, not merely short as planned
    } else if (v === 'need' && p && view.need && Number.isFinite(p.needMm[i])) {
      // each square metre's own need in the thirstiest month, light (little) to dark (much)
      const t = Math.max(0, Math.min(1, (p.needMm[i] - view.need.lo) / Math.max(1, view.need.hi - view.need.lo)));
      rgba = [Math.round(227 - 214 * t), Math.round(242 - 171 * t), Math.round(253 - 92 * t), 200];
    } else if (v === 'soil' && p?.soilAt && ground && (!mine || mine[i])) {
      rgba = [...SOIL_RGB[p.soilAt[i] % SOIL_RGB.length], kind === 1 ? 200 : 120];
    } else if (v === 'water') {
      if (d.reported[i] === 2) rgba = [30, 107, 255, Math.round(110 + 130 * Math.min(1, d.depth[i] / 0.10))];
      else if (d.reported[i] === 1) rgba = [190, 200, 215, 110]; // not a lawn hollow: pavement, trees, a ditch...
      // runoff lines: weighted by what each surface sheds when the lawn is traced (m^2 of runoff-producing surface), plain area otherwise
      if (!d.wall[i] && d.flow[i] >= (d.weighted ? 60 : 250)) rgba = [34, 211, 238, 220];
    } else if (v === 'wind' && p?.windJuly && kind === 1 && d.lawnMask?.[i]) {
      const w = p.windJuly[i];
      if (Number.isFinite(w)) rgba = WIND_STEPS.find(([lim]) => w < lim)[1];
    } else if (v === 'slope' && ground && (!mine || mine[i])) {
      const sl = slope[i];
      if (Number.isFinite(sl)) { const step = SLOPE_STEPS.find(([lim]) => sl < lim); if (step[1][3]) rgba = step[1]; }
      if (Number.isFinite(d.grade[i])) { const gr = d.grade[i]; rgba = gr < -0.01 ? [229, 57, 53, 255] : gr < 0.05 ? [255, 179, 0, 255] : [67, 160, 71, 255]; }
    }
    if (rgba) px.set(rgba, i * 4);
  }
  return img;
}

/* TOP DOWN OR 3D (public/view3d.js): the 3D view drapes the 2D map, as it is drawn, over the lidar ground, so
   every view and every step shows in both; it is for looking (taps and drags edit in the top-down view) */
const three = { on: false, v: null, meshFor: null, tex: 0, exag: 3 };
function draw() {
  draw2d();
  if (three.on) texSoon();
}
function texSoon() {
  if (three.tex) return;
  three.tex = requestAnimationFrame(() => {
    three.tex = 0;
    if (!three.on || !three.v) return;
    ensureGround();
    // the map's canvas, at most 2048 px a side (a phone's texture limit is often 4096; memory is the rest)
    const cv = $('#view'), s = Math.min(1, 2048 / Math.max(cv.width, cv.height));
    const c2 = document.createElement('canvas'); c2.width = Math.round(cv.width * s); c2.height = Math.round(cv.height * s);
    c2.getContext('2d').drawImage(cv, 0, 0, c2.width, c2.height);
    three.v.setTexture(c2);
  });
}
/** The ground's mesh, made once per survey, each cell's middle placed on the 2D map's canvas. */
function ensureGround() {
  const d = view.data;
  if (!d?.z || three.meshFor === d) return;
  const g = d.grid, dx = d.shift.east / g.k, dy = d.shift.north / g.k, cv = $('#view');
  const mesh = groundMesh({ W: g.W, H: g.H, cell: g.cell, z: d.z, uv: (c, r) => { const [x, y] = toPx(view.frame, view.photo, [g.bbox[0] + dx + ((c + 0.5) * g.cell) / g.k, g.bbox[3] + dy - ((r + 0.5) * g.cell) / g.k]); return [x / cv.width, y / cv.height]; } });
  three.v.setGround(mesh); three.v.setExaggeration(three.exag);
  three.meshFor = d;
  three.relief = mesh.zRange;
  $('#stage-hint').textContent = `Drag to turn it, pinch to zoom and move; heights stretched ${three.exag}x (the ground here rises about ${(mesh.zRange * 3.281).toFixed(0)} ft across the map). Taps edit in the top-down view.`;
}
function setDim(dim) {
  const want = dim === '3d';
  if (want && !view.data?.z) { $('#stage-hint').textContent = 'The 3D view follows the lidar survey: it is still being read.'; return; }
  three.on = want;
  document.querySelectorAll('[data-dim]').forEach((b) => b.classList.toggle('on', b.dataset.dim === (want ? '3d' : '2d')));
  $('#stage').classList.toggle('three', want); $('#view3d').hidden = !want; $('#dim3d').hidden = !want;
  if (want) {
    if (!three.v) {
      try { three.v = viewer3d($('#view3d')); } catch (e) { three.v = { ok: false, err: e.message }; }
      if (!three.v.ok) { three.on = false; $('#stage').classList.remove('three'); $('#view3d').hidden = true; $('#dim3d').hidden = true; document.querySelectorAll('[data-dim]').forEach((b) => b.classList.toggle('on', b.dataset.dim === '2d')); $('#stage-hint').textContent = `This browser cannot draw in 3D${three.v.err ? ` (${three.v.err})` : ''}.`; three.v = null; return; }
    }
    draw();
    if (three.meshFor) $('#stage-hint').textContent = `Drag to turn it, pinch to zoom and move; heights stretched ${three.exag}x (the ground here rises about ${(three.relief * 3.281).toFixed(0)} ft across the map). Taps edit in the top-down view.`;
  } else $('#stage-hint').textContent = 'Pinch or use + and \u2212 to zoom; drag to move around.';
}
document.querySelectorAll('[data-dim]').forEach((b) => b.addEventListener('click', () => setDim(b.dataset.dim)));
$('#exag').addEventListener('input', (e) => { three.exag = Number(e.target.value) || 1; $('#exag-v').textContent = String(three.exag); three.v?.setExaggeration(three.exag); if (three.meshFor) $('#stage-hint').textContent = `Drag to turn it, pinch to zoom and move; heights stretched ${three.exag}x (the ground here rises about ${(three.relief * 3.281).toFixed(0)} ft across the map). Taps edit in the top-down view.`; });
$('#view3d-reset').addEventListener('click', () => three.v?.reset());

function draw2d() {
  const { photo, data: d, frame, site } = view;
  if (!photo || !frame) return;
  const cv = $('#view');
  cv.width = photo.width; cv.height = photo.height;
  const g = cv.getContext('2d');
  g.fillStyle = '#222'; g.fillRect(0, 0, cv.width, cv.height);
  if ($('#show-photo').checked && photo.close) g.drawImage(photo, view.photoShift[0], view.photoShift[1]);
  else { g.fillStyle = '#3a4440'; g.fillRect(0, 0, cv.width, cv.height); }

  // the analysis over the photo, once it is in, and not while the sprinklers are being placed
  if (d && !heads.active) {
    const o = overlay(d, mapView, { hard: $('#show-hard').checked });
    const tmp = document.createElement('canvas');
    tmp.width = d.grid.W; tmp.height = d.grid.H;
    tmp.getContext('2d').putImageData(o, 0, 0);
    // the grid's corners, moved by the datum correction (real meters -> web-mercator meters)
    const dx = d.shift.east / d.grid.k, dy = d.shift.north / d.grid.k;
    const [x0, y0] = toPx(frame, photo, [d.grid.bbox[0] + dx, d.grid.bbox[3] + dy]);
    const [x1, y1] = toPx(frame, photo, [d.grid.bbox[2] + dx, d.grid.bbox[1] + dy]);
    g.imageSmoothingEnabled = false;
    g.drawImage(tmp, x0, y0, x1 - x0, y1 - y0);
  }

  if (mapView === 'drains' && view.layers && !heads.active) drawLayers(g);

  if (site.parcel) {
    g.strokeStyle = '#ffeb3b'; g.lineWidth = Math.max(3, photo.width / 250); g.setLineDash([g.lineWidth * 3, g.lineWidth * 2]);
    const polys = site.parcel.geometry.type === 'Polygon' ? [site.parcel.geometry.coordinates] : site.parcel.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) {
      g.beginPath();
      ring.forEach((p, i) => { const [x, y] = toPx(frame, photo, toMerc(p)); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.closePath(); g.stroke();
    }
  }
  g.setLineDash([]);
  g.strokeStyle = '#69f0ae'; g.lineWidth = Math.max(2, photo.width / 400);
  for (const f of site.lawn || []) {
    const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    for (const poly of polys) for (const ring of poly) {
      g.beginPath();
      ring.forEach((p, i) => { const [x, y] = toPx(frame, photo, toMerc(p)); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.closePath(); g.stroke();
    }
  }
  // gutters (white runs along the eaves) and downspouts (from the roof edge to where each empties)
  const lw = Math.max(3, photo.width / 300), at = (p) => toPx(frame, photo, toMerc(p));
  g.lineCap = 'round'; g.lineJoin = 'round';
  const gutters = [...inputs.gutters, ...(mode === 'gutter' && pending?.length ? [pending] : [])];
  for (const line of gutters) {
    g.strokeStyle = '#ffffff'; g.lineWidth = lw * 1.4;
    g.beginPath(); line.forEach((p, k) => { const [x, y] = at(p); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
    for (const p of line) { const [x, y] = at(p); g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, lw, 0, 7); g.fill(); }
  }
  // the person's marked areas, outlined in their kind's colour
  const areas = [...inputs.areas, ...(mode === 'area' && pending?.length ? [{ kind: $('#area-kind').value, ring: pending }] : [])];
  for (const a of areas) {
    g.strokeStyle = AREA_COLOR[a.kind] || '#fff'; g.lineWidth = lw; g.setLineDash([lw * 2, lw]);
    g.beginPath(); a.ring.forEach((p, k) => { const [x, y] = at(p); if (k) g.lineTo(x, y); else g.moveTo(x, y); });
    if (a.ring.length > 2) g.closePath();
    g.stroke(); g.setLineDash([]);
    for (const p of a.ring) { const [x, y] = at(p); g.fillStyle = AREA_COLOR[a.kind] || '#fff'; g.beginPath(); g.arc(x, y, lw, 0, 7); g.fill(); }
  }
  if (heads.active) { heads.drawOn(g, lw); return; }
  // the downspouts belong to the water the lot sheds: the zones, the need and the standing water
  const spouts = [...inputs.downspouts, ...(mode === 'to' && pending ? [{ from: pending, to: null }] : [])];
  for (const sp of ['zones', 'need', 'water'].includes(mapView) || mode ? spouts : []) {
    const [x0, y0] = at(sp.from);
    g.fillStyle = '#ff9100'; g.beginPath(); g.arc(x0, y0, lw * 1.6, 0, 7); g.fill();
    if (!sp.to) continue;
    const [x1, y1] = at(sp.to);
    g.strokeStyle = '#ff9100'; g.lineWidth = lw; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.strokeStyle = '#000'; g.lineWidth = lw * 0.6; g.fillStyle = '#00e5ff'; g.beginPath(); g.arc(x1, y1, lw * 2, 0, 7); g.fill(); g.stroke();
  }
  if (mapView === 'sprinklers') heads.drawOn(g, lw);
}

/* DRAINS AND WATER (lib/layers.js): areas, then lines, then points, each kind its own look; drawn as the service
   serves them, on the photo's ground like the traced lawn (FINDINGS H37: no datum move) */
function drawLayers(g) {
  const { photo, frame } = view, at = (p) => toPx(frame, photo, toMerc(p));
  const cv = $('#view'), css = cv.width / Math.max(1, cv.getBoundingClientRect().width);
  const order = { area: 0, line: 1, point: 2 };
  const layers = view.layers.layers.slice().sort((a, b) => order[LAYER_KINDS[a.kind].draw] - order[LAYER_KINDS[b.kind].draw] || LAYER_KINDS[a.kind].rank - LAYER_KINDS[b.kind].rank);
  g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
  for (const l of layers) {
    const k = LAYER_KINDS[l.kind];
    g.setLineDash((k.dash || []).map((v) => v * css));
    for (const f of l.features) {
      const geo = f.g;
      if (k.draw === 'area') {
        const polys = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : [];
        for (const poly of polys) {
          g.beginPath();
          for (const ring of poly) ring.forEach((p, i) => { const [x, y] = at(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
          if (k.fill) { g.fillStyle = k.fill; g.fill('evenodd'); }
          g.strokeStyle = k.stroke; g.lineWidth = 1.6 * css; g.stroke();
        }
      } else if (k.draw === 'line') {
        const lines = geo.type === 'LineString' ? [geo.coordinates] : geo.type === 'MultiLineString' ? geo.coordinates : [];
        const dia = Number(f.p.DIAMETER || f.p.LATERAL_SIZE);
        for (const line of lines) {
          g.beginPath(); line.forEach((p, i) => { const [x, y] = at(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
          g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = (k.width + 2) * css; g.stroke();
          g.strokeStyle = k.stroke; g.lineWidth = (k.width + (Number.isFinite(dia) && dia > 0 ? Math.min(3, dia / 12) : 0)) * css; g.stroke();
        }
      } else {
        g.setLineDash([]);
        const pts = geo.type === 'Point' ? [geo.coordinates] : geo.type === 'MultiPoint' ? geo.coordinates : [];
        for (const p of pts) {
          const [x, y] = at(p), r = 5 * css;
          g.fillStyle = k.fill; g.strokeStyle = k.stroke; g.lineWidth = 1.8 * css;
          g.beginPath();
          if (k.shape === 'square') g.rect(x - r, y - r, 2 * r, 2 * r);
          else if (k.shape === 'triangle') { g.moveTo(x, y - r * 1.2); g.lineTo(x + r * 1.1, y + r * 0.8); g.lineTo(x - r * 1.1, y + r * 0.8); g.closePath(); }
          else g.arc(x, y, r, 0, 7);
          g.fill(); g.stroke();
        }
      }
    }
  }
  if (view.layerPicked?.at) {
    const [x, y] = at(view.layerPicked.at), r = 9 * css;
    g.setLineDash([]); g.strokeStyle = '#ff1744'; g.lineWidth = 2.5 * css; g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke();
  }
  g.restore();
}

/** Photo pixels per ground metre at the frame's middle. */
const pxPerM = () => (worldSize(view.frame.zoom) / (2 * Math.PI * R * Math.cos((view.frame.lat * Math.PI) / 180))) * (view.photo.width / view.frame.size);
/** The traced lawn's middle, or the map's point. */
function lawnMid() {
  const pts = (view.site?.lawn || []).flatMap((f) => (f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.flatMap((p) => p[0]) : []));
  if (!pts.length) return view.site ? [view.site.lng, view.site.lat] : null;
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}
const lawnRingsOf = () => (view.site?.lawn || []).flatMap((f) => (f.geometry?.type === 'Polygon' ? f.geometry.coordinates : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.flat() : []));

/* THE LAYERS, KEPT WITH THE MAP (owner, 2026-10-24: "you'll be attaching them to the unified saves"): a copy a
   month old or less, with every source answered, is used as it is; otherwise asked for again (GET
   /api/water/layers through this site's Worker), kept, and saved with the map. A source still working is asked
   again a minute later, twice at most. */
let layersAsk = 0;
/** The most the layers may take of the water part's 64 KB, after everything else in it. */
function layerBudget() {
  const rest = JSON.stringify({ data: { v: 1, downspouts: inputs.downspouts, gutters: inputs.gutters, areas: inputs.areas, topsoil: inputs.topsoil, grass: inputs.grass, species: inputs.species, mode: inputs.mode, irrigation: heads.data, wind: inputs.wind || null }, basedOn: view.site?.at }).length;
  return Math.max(4000, Math.min(30000, MAX_TOOL_BYTES - rest - 3000));
}
async function loadLayers(boxDeg, kept) {
  const ask = ++layersAsk;
  try { await askLayers(ask, boxDeg, kept); } finally { if (ask === layersAsk) idle('layers'); }
}
async function askLayers(ask, boxDeg, kept) {
  view.layersError = '';
  if (kept?.layers) { view.layers = kept; inputs.layers = kept; layersIn(); }
  if (freshEnough(kept)) return;
  busy('layers', "Asking the county's and the national maps for drains and water…");
  const q = askBox(boxDeg).join(',');
  for (let k = 0; k < 3; k++) {
    try {
      const res = await fetch(`/api/water/layers?box=${q}`);
      if (ask !== layersAsk) return;
      if (res.ok) {
        const j = await res.json();
        if (ask !== layersAsk) return;
        view.layersRaw = j; view.layersError = '';
        const saved = compact(j, { centre: lawnMid(), budget: layerBudget() });
        view.layers = saved; inputs.layers = saved; layersIn(); keep();
        // whole, with the county's own: done. With none, the service may still be searching this place: soon again
        if (!j.pending?.length && (hasCounty(saved) || k > 0)) return;
        if (!j.pending?.length) { busy('layers', "Looking for this county's drain maps (a first look here takes a few seconds)…"); await new Promise((r) => setTimeout(r, 20000)); if (ask !== layersAsk) return; continue; }
        busy('layers', `Still waiting on ${j.pending.map((x) => x.title).join(', ')} (asking again in a minute)…`);
      } else if (!view.layers) { view.layersError = `the drains and water layers did not answer (${res.status})`; layersIn(); }
    } catch (e) { if (!view.layers) { view.layersError = `the drains and water layers could not be reached (${e.message})`; layersIn(); } }
    await new Promise((r) => setTimeout(r, 60000));
    if (ask !== layersAsk) return;
  }
}
function layersIn() {
  if (mapView === 'drains') { legend(); draw(); }
  if (view.data && !heads.active) report(view.data, view.site);
}

/** A tap on the photo -> [lng, lat]. */
function tapPx(ev) {
  const cv = $('#view'), rect = cv.getBoundingClientRect();
  return [((ev.clientX - rect.left) / rect.width) * cv.width, ((ev.clientY - rect.top) / rect.height) * cv.height];
}
/** A pixel on the photo -> [lng, lat]. */
function pxToLngLat([px, py]) {
  const { photo, frame } = view;
  const c = mercToWorld(toMerc([frame.lng, frame.lat]), frame.zoom), s = photo.width / frame.size;
  const wx = (px - photo.width / 2) / s + c[0], wy = (py - photo.height / 2) / s + c[1];
  const size = worldSize(frame.zoom);
  const x = (wx / size) * 2 * Math.PI * R - Math.PI * R, y = Math.PI * R - (wy / size) * 2 * Math.PI * R;
  return fromMerc([x, y]).map((v) => +v.toFixed(7));
}
function tapAt(ev) { return pxToLngLat(tapPx(ev)); }

/* YOUR SPRINKLERS FIRST (owner, 2026-10-20: "a step that happens before doing anything else within the
   water map"): public/heads.js runs the steps; the page lends it the photo and the save. */
const heads = sprinklers({
  panel: $('#heads-panel'), title: $('#heads-title'),
  draw: () => draw(),
  tapPx, toLngLat: pxToLngLat,
  toPx: (p) => toPx(view.frame, view.photo, toMerc(p)),
  // photo pixels per ground metre at the frame's middle
  pxPerM: () => (worldSize(view.frame.zoom) / (2 * Math.PI * R * Math.cos((view.frame.lat * Math.PI) / 180))) * (view.photo.width / view.frame.size),
  cssScale: () => { const cv = $('#view'); return cv.width / cv.getBoundingClientRect().width; },
  // the ground's height (USGS lidar, metres) at a point, once the survey is read
  elevReady: () => !!view.data?.z,
  elev: (at) => {
    const d = view.data;
    if (!d?.z) return null;
    const [x, y] = toMerc(at), g = d.grid, dx = d.shift.east / g.k, dy = d.shift.north / g.k;
    const c = ((x - (g.bbox[0] + dx)) * g.k) / g.cell - 0.5, r = ((g.bbox[3] + dy - y) * g.k) / g.cell - 0.5;
    const c0 = Math.max(0, Math.min(g.W - 2, Math.floor(c))), r0 = Math.max(0, Math.min(g.H - 2, Math.floor(r)));
    const fx = Math.max(0, Math.min(1, c - c0)), fy = Math.max(0, Math.min(1, r - r0)), Z = (rr, cc) => d.z[rr * g.W + cc];
    const v = (1 - fy) * ((1 - fx) * Z(r0, c0) + fx * Z(r0, c0 + 1)) + fy * ((1 - fx) * Z(r0 + 1, c0) + fx * Z(r0 + 1, c0 + 1));
    return Number.isFinite(v) ? v : null;
  },
  // what a run of pipe costs per foot, as a multiple of open ground (lib/hydraulics.js route): through a
  // building 50 (never: owner, 2026-10-21), under paving 2 (a sleeve; they go round when they can) -- the
  // analysis's roofs and paving, sampled every half metre (trees are not counted: owner, 2026-10-22)
  routeCost: (a, b) => {
    const d = view.data;
    if (!d?.wall) return 1;
    const g = d.grid, dx = d.shift.east / g.k, dy = d.shift.north / g.k;
    const [ax, ay] = toMerc(a), [bx, by] = toMerc(b), L = Math.hypot(bx - ax, by - ay) * g.k, n = Math.max(2, Math.ceil(L / 0.5));
    let worst = 1;
    for (let k = 1; k < n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
      const c = Math.floor(((x - (g.bbox[0] + dx)) * g.k) / g.cell), r = Math.floor(((g.bbox[3] + dy - y) * g.k) / g.cell);
      if (c < 0 || r < 0 || c >= g.W || r >= g.H) continue;
      const i = r * g.W + c;
      if (d.wall[i]) return 50;
      if (d.paved && d.paved[i] >= 0.5) worst = Math.max(worst, 2);
    }
    return worst;
  },
  // the ground for laying pipe (lib/layout.js): a building, under a tree, paving, the traced lawn; null until the
  // lawn map is in, or off it
  layoutGround: () => {
    const d = view.data;
    if (!d?.wall) return null;
    return (at) => {
      const g = d.grid, dx = d.shift.east / g.k, dy = d.shift.north / g.k, [x, y] = toMerc(at);
      const c = Math.floor(((x - (g.bbox[0] + dx)) * g.k) / g.cell), r = Math.floor(((g.bbox[3] + dy - y) * g.k) / g.cell);
      if (c < 0 || r < 0 || c >= g.W || r >= g.H) return null;
      const i = r * g.W + c;
      return { building: !!d.wall[i], paved: !!(d.paved && d.paved[i] >= 0.5), lawn: d.lawnMask ? !!d.lawnMask[i] : true };
    };
  },
  // a building or paving within `m` metres of a point (a head's throw reaching it)
  hardNear: (at, m) => {
    const d = view.data;
    if (!d?.wall || !(m > 0)) return false;
    const g = d.grid, dx = d.shift.east / g.k, dy = d.shift.north / g.k, [x, y] = toMerc(at);
    const c0 = ((x - (g.bbox[0] + dx)) * g.k) / g.cell, r0 = ((g.bbox[3] + dy - y) * g.k) / g.cell, R = m / g.cell;
    for (let r = Math.floor(r0 - R); r <= Math.ceil(r0 + R); r++) for (let c = Math.floor(c0 - R); c <= Math.ceil(c0 + R); c++) {
      if (r < 0 || c < 0 || r >= g.H || c >= g.W || Math.hypot(r + 0.5 - r0, c + 0.5 - c0) > R) continue;
      const i = r * g.W + c;
      if (d.wall[i] || (d.paved && d.paved[i] >= 0.5)) return true;
    }
    return false;
  },
  mapId: () => view.site?.mapId || null,
  /* THE ANALYSIS GRID (the watering plan's cells), for each valve's lawn: its size, each cell's middle as
     [lng, lat] (moved by the datum correction, as drawn), and whether it is lawn. null until the survey is in. */
  analysisGrid: () => {
    const d = view.data;
    if (!d?.grid) return null;
    const g = d.grid, dx = d.shift.east / g.k, dy = d.shift.north / g.k;
    const lawn = d.lawnMask || view.plan?.kinds;
    return {
      W: g.W, H: g.H, cellM: g.cell,
      at: (c, r) => fromMerc([g.bbox[0] + dx + ((c + 0.5) * g.cell) / g.k, g.bbox[3] + dy - ((r + 0.5) * g.cell) / g.k]),
      lawn: (i) => (d.lawnMask ? !!d.lawnMask[i] : lawn ? lawn[i] === 1 : false),
    };
  },
  /** The plan is in (the soil and the weather read). */
  planReady: () => !!view.plan,
  // the sprinkler zones' schedule came in outside its step: the report leads with it
  scheduleIn: () => { if (view.plan && !heads.active) planReport(view.plan); },
  /** The watering plan run on the valves' own lawn (zoneOf: zone - 1 per cell, -1 none) -> Promise of it. */
  valvePlan: (zoneOf) => new Promise((resolve, reject) => {
    if (!running || !view.plan) { reject(new Error('the watering plan is not in yet')); return; }
    const id = ++valveAsk.n;
    valveAsk.waiting.set(id, { resolve, reject });
    running.postMessage({ valvePlan: { inputs: { ...inputs }, zoneOf, id } });
  }),
  showCoverage: () => !!$('#show-coverage')?.checked,
  // the traced lawn's outlines, as rings of [lng, lat] (the placing grid lines up with its longest edge)
  lawnRings: () => (view.site?.lawn || []).flatMap((f) => (f.geometry?.type === 'Polygon' ? f.geometry.coordinates : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.flat() : [])),
  // the traced lawn's corners, [[west, south], [east, north]]
  lawnBox: () => {
    const pts = (view.site?.lawn || []).flatMap((f) => (f.geometry?.type === 'Polygon' ? f.geometry.coordinates.flat() : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.flat(2) : []));
    if (!pts.length) return null;
    return [[Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))], [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]];
  },
  /* what is on the ground at a point, for the arcs (lib/arcs.js), on the core session's advice (2026-10-21):
     'wall' a building (the lidar's footprint), 'paved' paving on the lot, 'road' paving outside the property
     line; the traced lawn 'lawn', or 'lawn-nearwall' / 'lawn-nearpaved' within a metre of either (the edges
     are good to about half a metre, so the band costs a little rather than flipping the score); else 'other' */
  get groundAt() {
    const d = view.data;
    if (!d?.wall) return null;
    const g = d.grid, N = g.W * g.H;
    const hardAt = (i) => (d.wall[i] ? 2 : d.paved && d.paved[i] >= 0.5 ? 1 : 0);
    if (!d.nearHard) {
      // within one cell (a metre) of a building (2) or paving (1)
      d.nearHard = new Uint8Array(N);
      for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
        let m = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < g.H && cc < g.W) m = Math.max(m, hardAt(rr * g.W + cc)); }
        d.nearHard[r * g.W + c] = m;
      }
    }
    return (at) => {
      const dx = d.shift.east / g.k, dy = d.shift.north / g.k, [x, y] = toMerc(at);
      const c = Math.floor(((x - (g.bbox[0] + dx)) * g.k) / g.cell), r = Math.floor(((g.bbox[3] + dy - y) * g.k) / g.cell);
      if (c < 0 || r < 0 || c >= g.W || r >= g.H) return null;
      const i = r * g.W + c, h = hardAt(i);
      if (h === 2) return 'wall';
      if (h === 1) return d.parcelMask && !d.parcelMask[i] ? 'road' : 'paved';
      const lawn = d.lawnMask ? d.lawnMask[i] : 1;
      if (!lawn) return 'other';
      return d.nearHard[i] === 2 ? 'lawn-nearwall' : d.nearHard[i] === 1 ? 'lawn-nearpaved' : 'lawn';
    };
  },
  lawnMiddle: () => {
    const pts = (view.site?.lawn || []).flatMap((f) => (f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.flatMap((p) => p[0]) : []));
    if (!pts.length) return view.site ? [view.site.lng, view.site.lat] : null;
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  },
  changed: () => keep(),
  get mode() { return inputs.mode; }, setMode: (m) => setWateringMode(m),
  planKey: () => JSON.stringify([inputs.mode, inputs.species, inputs.grass, inputs.topsoil, inputs.areas, inputs.downspouts, inputs.gutters]),
  busy: (key, text) => busy(key, text),
  finish: () => { $('#result').classList.remove('heads-on'); legend(); draw(); headsCard(); if (view.data) report(view.data, view.site); if (view.plan) planReport(view.plan); },
});

/** The sprinkler system, zone by zone, under the map once its steps are done. */
function headsCard() {
  const z = heads.summary(), irr = heads.data;
  if (irr.none) { $('#heads-summary').innerHTML = '<p class="dim">No in-ground sprinklers on this map. <em>Your sprinklers</em> adds them.</p>'; return; }
  if (!z) { $('#heads-summary').innerHTML = ''; return; }
  $('#heads-summary').innerHTML = `<div class="card"><h2>Your sprinkler system: ${irr.heads.length} heads on ${z.length} valve${z.length === 1 ? '' : 's'}</h2>
    <table class="months"><tr><th>Valve</th><th>Heads</th><th>Flow</th><th>Puts down</th><th>At the heads</th></tr>
    ${z.map((v) => `<tr><td><span class="chip" style="background:${v.color}"></span>Zone ${v.n}</td><td>${v.heads}</td><td>${v.gpm.toFixed(1)} gpm</td><td>${v.precipInH ? `${v.precipInH.toFixed(2)} in/h` : '?'}${v.mixed ? ' (sprays and rotors mixed)' : ''}</td><td>${Number.isFinite(v.psiLo) ? `${Math.round(v.psiLo)}–${Math.round(v.psiHi)} psi` : '?'}</td></tr>`).join('')}</table>
    <p class="dim">From the makers' performance charts, at the pressure each head gets: worked out from your pressure through the meter, the backflow preventer, the supply line, the valve, each run of pipe and fitting as an installer most likely laid it, and each swing joint, with the ground's rise and fall. "Puts down" is at head-to-head spacing; a catch-cup test on the lawn would measure the real rate.</p></div>`;
}

/* ------------------------------------------------------------- the words */

const inches = (cm) => (cm / 2.54).toFixed(1);
const sqft = (m2) => Math.round(m2 * 10.764).toLocaleString();

/** What drains onto the lawn, from the lot and from beyond its line (lib/impervious.js runOnSources). */
function runOnCard(cv) {
  const o = cv.runOn;
  if (!o) return '';
  const sum = (x) => x.roof + x.paved + x.ground;
  const lot = sum(o.lot), beyond = sum(o.beyond);
  if (!lot && !beyond) return '<p>No roof, paving or other ground drains onto the lawn: only the rain that falls on it.</p>';
  const parts = (x) => [[x.roof, 'roof'], [x.paved, 'paving'], [x.ground, 'beds, bare ground and ground under trees']].filter(([v]) => v >= 1).map(([v, w]) => `${sqft(v)} sq ft of ${w}`);
  const list = [];
  if (lot) list.push(`<li>From your own lot: ${parts(o.lot).join(', ')}.</li>`);
  if (beyond) list.push(`<li>From beyond your lot line (neighbours' yards, roofs and driveways, and the street, within about 100 ft of it): ${parts(o.beyond).join(', ')}.</li>`);
  const hard = o.weightedM2 > 0.5 * cv.lawnM2;
  return `<p>Rain that lands on this ground runs onto the lawn:</p><ul>${list.join('')}</ul>
      <p class="dim">Each patch is counted once, where its water first reaches the lawn. Roofs and paving shed almost all their rain; beds, yards and ground under trees shed some, mostly in heavy rain. Altogether it sends the lawn about as much water as the rain falling on ${sqft(o.weightedM2)} sq ft${hard ? ' — a lot for the lawn to take in a storm' : ''}.</p>`;
}
const gallons = (l) => Math.round(l / 3.785).toLocaleString();
const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function report(d, site) {
  const s = d.summary, parts = [];
  const flown = d.cloud.flown ? new Date(`${d.cloud.flown}T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'an unknown date';
  const where = site.parcel ? 'on this property' : 'near this point (no county property line was found)';
  const lawnKnown = d.hasLawn;
  const isLawnHollow = (p) => p.kind === 'hollow' && (!lawnKnown || p.onLawnM2 > 0);
  const hollows = d.spots.filter(isLawnHollow);
  const others = d.spots.filter((p) => !isLawnHollow(p));
  const KIND = { trees: 'under trees', paved: 'pavement, a car or hidden ground', water: 'open water or a pool', ditch: 'a ditch or swale', built: 'a stairwell or window well', deep: 'too deep for a lawn hollow (a pond or basin)', hollow: 'off the lawn' };
  if (hollows.length) {
    // a storm inlet, manhole or basin mapped in it (lib/layers.js): built to collect water, not a fault in the lawn
    const drainIn = (p) => (view.layers && p.lngLat ? intakesNear(view.layers, p.lngLat, Math.max(3, Math.sqrt(p.areaM2 / Math.PI) + 1.5))[0] : null);
    const items = hollows.slice(0, 8).map((p) => { const dr = drainIn(p); return `<li>${dr ? `<strong>A ${esc(LAYER_KINDS[dr.kind].label)} is mapped here</strong> (${esc(dr.source)}): this low ground is likely built to collect water, not a hollow in the lawn. ` : 'Likely holds water: '}at least ${inches(p.depthCm)} in deep, about ${sqft(lawnKnown ? p.onLawnM2 : p.areaM2)} sq ft${lawnKnown ? ' of lawn' : ''}, roughly ${gallons(p.volumeL)} gallons when full${p.againstBuilding ? ' — <strong>against a building</strong>' : ''}.</li>`; });
    parts.push(`<div class="card"><h2>${hollows.length} low spot${hollows.length > 1 ? 's' : ''} ${lawnKnown ? 'in your lawn' : where}</h2><ul>${items.join('')}</ul>
      <p class="dim">Depths run shallow: smoothing out the survey's scatter takes some off, so read them as "at least".${lawnKnown ? '' : ' Without your lawn traced, some of these may be on pavement or a roof: open this from a Lawn Mapper map for a surer answer.'}</p></div>`);
  } else {
    parts.push(`<div class="card"><h2>No low spot ${lawnKnown ? 'in your lawn' : where} big enough to be sure of</h2>
      <p class="dim">On this survey a hollow has to be deeper than ${inches(s.noiseFloor * 100)} in to stand out from the laser's scatter. Smaller ones can still hold water; this can't see them.</p></div>`);
  }
  if (others.length) {
    const counts = {};
    for (const p of others) counts[p.kind] = (counts[p.kind] || 0) + 1;
    parts.push(`<div class="card"><h2>Also low, but not a lawn problem</h2><ul class="dim">${Object.entries(counts).map(([k, n]) => `<li>${n} ${KIND[k] || k}</li>`).join('')}</ul>
      <p class="dim">Shown faint on the map. Under trees the laser sees little of the ground, so those are the least certain.</p></div>`);
  }
  const cv = s.cover;
  if (cv) {
    const total = cv.lawnM2 + cv.roofM2 + cv.pavedM2 + cv.otherM2 + cv.unjudgedM2;
    const p = (m) => `${Math.round((100 * m) / Math.max(1, total))}%`;
    parts.push(`<div class="card"><h2>What covers the lot</h2><ul>
      <li>Lawn: ${sqft(cv.lawnM2)} sq ft (${p(cv.lawnM2)})</li>
      <li>Roofs: ${sqft(cv.roofM2)} sq ft (${p(cv.roofM2)})</li>
      <li>Paving, likely: ${sqft(cv.pavedM2)} sq ft (${p(cv.pavedM2)})</li>
      <li>Other ground (beds, bare soil, gravel): ${sqft(cv.otherM2)} sq ft (${p(cv.otherM2)})${cv.unjudgedM2 ? `; under trees, not judged: ${sqft(cv.unjudgedM2)} sq ft` : ''}</li></ul>
      ${runOnCard(cv)}
      <p class="dim">${s.pavingFromPhoto ? "Paving is judged from how brightly the laser came back and from the USDA's aerial photo, whose infrared band shows living grass, both measured against your own lawn: in a test against a published 1 m land-use map it was right on about 85 cells in 100 and found 82% of the paving." : 'Paving is judged from how brightly the laser came back, measured against your own lawn: in a test against a published 1 m land-use map it was right on about 85 cells in 100 and found three quarters of the paving.'} Add your downspouts so the roofs' water lands where it really does.</p></div>`);
  }
  const b = s.besideHouse;
  if (b.outlineCells) {
    const verdict = b.towardShare >= 0.25 ? 'A good part of the ground beside the house falls <strong>toward</strong> it.'
      : b.meetsCodeShare >= 0.5 ? `The ground falls away from the house well along most of it${b.towardShare > 0.05 ? ', with a few stretches falling toward it' : ''}.`
        : `The ground beside the house is mostly flatter than the building code asks (a 5% fall away)${b.towardShare > 0.05 ? ', and falls toward it in places' : ''}.`;
    parts.push(`<div class="card"><h2>Beside the house</h2><p>${verdict}</p>
      <p class="dim">Falls toward the house along ${pct(b.towardShare)} of the walls; away by the building code's 5% (6 in over the first 10 ft) along ${pct(b.meetsCodeShare)}. Measured 1.5–10 ft out, on the ground around each point, so a planting bed against the wall is not what is judged.</p></div>`);
  }
  parts.push(`<p class="dim">Survey: ${esc(d.cloud.name.replace(/^USGS_LPC_/, '').replace(/_/g, ' '))}, flown ${flown}${d.cloud.ql ? `, ${esc(d.cloud.ql)}` : ''}. ${s.groundPointsPerM2.toFixed(1)} ground points per square meter; scatter ${inches(s.scatter * 100)} in. Worked out in ${s.seconds.toFixed(0)} s. Photo: ${esc(view.photoName || "Mapbox's photo")}.${s.overture ? ' Building outlines, roads and sidewalks: Overture Maps (OpenStreetMap, Microsoft and others), on top of what the laser and the photo show.' : ''}</p>`);
  if (d.cloud.notOnAws?.length) parts.push('<p class="dim">USGS lists a newer survey here that is not yet readable by this page.</p>');
  $('#report').innerHTML = parts.join('');
}

/* ------------------------------------------------------ the watering plan */

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const inch = (mm) => { const v = Math.round((mm / 25.4) * 20) / 20; return v < 0.05 ? 'under 0.05' : v.toFixed(2); };
const dayName = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const chip = (z) => `<span class="chip" style="background:rgb(${ZONE_RGB[z % ZONE_RGB.length].join(',')})"></span>`;

function howOften(m) {
  if (!m.waterings) return m.high ? `rarely (up to ${m.high} times in a dry year)` : 'rain covers it';
  const every = DAYS_IN[m.month] / m.waterings;
  return `about every ${every < 1.5 ? 'day' : `${Math.round(every)} days`} (${m.waterings} time${m.waterings > 1 ? 's' : ''}; ${m.low}–${m.high} across ten years)`;
}

/**
 * How to put a watering down without it running off: the ground takes `takes` in an hour, so a watering of
 * `mm` goes down in runs of at most an hour's worth, an hour apart -- each run as many minutes as the
 * sprinklers need to put that much down (spray heads about 1.5 in/h, rotors about 0.5 in/h, until the
 * heads are mapped).
 */
function soakAdvice(takes, mm) {
  // at most two runs a day (owner, 2026-10-20); the plan keeps a watering within that
  const depth = mm / 25.4, runs = Math.min(2, Math.max(1, Math.ceil(depth / takes - 0.05)));
  const minutes = (rate) => Math.max(1, Math.round((depth / runs / rate) * 60));
  const head = (rate, name) => (rate <= takes ? `${name} can put it down in one go` : `${name}: ${runs} run${runs > 1 ? 's' : ''} of about ${minutes(rate)} minutes`);
  return `This ground takes about ${takes.toFixed(2)} in of water an hour before it runs off. To put down ${inch(mm)} in${runs > 1 ? `, water in two short runs an hour apart` : ''} -- ${head(1.5, 'spray heads (about 1.5 in an hour)')}; ${head(0.5, 'rotors (about 0.5 in an hour)')}.`;
}

function planReport(p) {
  const parts = [];
  legend();
  if (!p.zones.length) { $('#plan').innerHTML = '<div class="card"><h2>No lawn to plan for</h2><p class="dim">Trace the lawn in Lawn Mapper and open the map from your dashboard.</p></div>'; return; }
  const peak = (z) => z.months.reduce((a, b) => ((b.mmMonth || 0) > (a.mmMonth || 0) ? b : a), z.months[0]);
  if (p.trouble?.length) parts.push(`<div class="card" style="border-color:var(--warn)"><h2>Not everything answered this time</h2><ul>${p.trouble.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><p class="dim">Reload the page to try again; the plan below is worked out without it.</p></div>`);
  /* ONE KIND OF ZONE (owner, 2026-10-27: "seperate the terminology for the watering zones and sprinkler zones... Recommendations
     should be based on sprinkler zones"): a zone is a sprinkler valve's; the plan's own parts of the lawn are "watering
     areas". With the sprinklers mapped, the report leads with each sprinkler zone's run times; the areas follow, as what
     each part of the lawn needs. */
  parts.push('<div class="tools no-print" style="margin:0 0 8px"><button type="button" id="save-pdf">Save as PDF</button></div>');
  const sprinklerCard = heads.scheduleCard?.();
  if (sprinklerCard) parts.push(sprinklerCard);
  /* HOW MUCH TO WATER (owner, 2026-10-28): the level's crop coefficient from the owner's table by species, the
     middle of each range averaged over the grasses checked; the report says which figure the plan used. */
  const kcWords = (() => {
    const k = p.kc; if (!k) return '';
    const f = (v) => v.toFixed(2), rng = ([lo, hi]) => (lo === hi ? f(lo) : `${f(lo)}-${f(hi)}`);
    const parts = k.parts.map((q) => (q.general ? `${q.name.toLowerCase().replace(/^a /, '')}: the table does not name it, so its ${SPECIES[q.id]?.group === 'warm' ? 'warm' : 'cool'}-season grasses averaged, ${rng(q.range)} across them` : `${q.name} ${rng(q.range)}`)).join('; ');
    const st = p.stress, days = (sh) => Math.round(sh * (st?.seasonDays || 0));
    const short = st && p.mode !== 'normal' ? ` The grass still draws at its own ${f(k.grass)}, so it goes short of water, by design: through a typical season it gets about <strong>${Math.round(st.useShare * 100)}%</strong> of the water it would use, past its readily available water on about ${days(st.planned)} days and badly short (more than halfway to wilting) on about <strong>${days(st.severe)}</strong>; with rain alone, ${Math.round(st.rainAloneUseShare * 100)}% and ${days(st.rainAloneSevere)} badly short days${p.mode === 'dormancy' ? '. It browns and goes dormant in the dry spells and greens up again after rain.' : '. It slows, dulls and shows footprints in the dry spells, without going dormant.'}` : '';
    const level = p.mode === 'deficit' ? `<strong>Deficit watering:</strong> water just enough to avoid serious stress, at moderate maintenance. Each watering replaces <strong>${f(k.used)}</strong> times reference ET instead of normal's ${f(k.normalKc)}.${short}`
      : p.mode === 'dormancy' ? `<strong>Dormancy watering:</strong> water just enough to keep the grass alive, not green, at low maintenance. Each watering replaces <strong>${f(k.used)}</strong> times reference ET instead of normal's ${f(k.normalKc)}.${short}`
      : `<strong>Normal watering:</strong> replace all the water the grass uses, taken at <strong>${f(k.used)}</strong> times reference ET.`;
    return `<p>${level} (The coefficients: ${parts}; the middle of each range${k.parts.length > 1 ? ', averaged' : ''}.) ${p.mode === 'normal' ? 'Deficit or dormancy above waters less.' : 'Normal above waters the full amount.'}</p>`;
  })();
  parts.push(`<div class="card"><h2>${sprinklerCard ? 'What each part of the lawn needs' : 'Your watering plan'}: ${p.zones.length} watering area${p.zones.length > 1 ? 's' : ''}</h2>${kcWords}
    <p>${sprinklerCard ? 'The parts of the lawn below differ in what they need: their soil, slope, sun and the water that runs onto them. The sprinkler zones&rsquo; run times above are worked out from them.' : 'Each watering area below needs a different amount, or a different rhythm, to stay between too wet and too dry. Water an area when it says, by about the depth it says; more is wasted below the roots, less leaves it short. Map your sprinklers (<em>Your sprinklers</em>) for run times by sprinkler zone.'}</p>
    <p class="dim">Worked out day by day over ten years of this place's weather: rain and runoff in, the grass's use out, the soil's root zone in between.${p.rainShaped ? ` Its ${p.rainShaped} rainy days each fall hour by hour as the rain fell at ${esc(p.rainStation?.name || 'the nearest')} airport that day, so a cloudburst faster than the lawn takes water runs off.` : ''} ${p.shaded ? ` Shade from trees and buildings is counted (the shade map's own light model${p.lightByMonth ? ', month by month: the leaves as they stand and the sun where it is each month' : ''}${p.ownRadiation ? '; and each spot\'s own warmth from it: the near-infrared that leaves let through, the skylight in a building\'s shade, and the night sky each spot loses its heat to' : ''}${p.fences?.fences ? `; the ${p.fences.fences} fence${p.fences.fences === 1 ? '' : 's'} drawn on the shade map, in the shade, as sky the grass beside ${p.fences.fences === 1 ? 'it' : 'them'} cannot lose its heat to, and warm in the sun` : ''}; the lawn's middle gets about ${Math.round(p.sunShare * 100)}% of open-sky sunlight in summer${p.lightInfo?.passes?.season === 'mixed' ? `, part of this lot flown with the leaves off and part in leaf (${p.lightInfo.passes.off.toLocaleString()} and ${p.lightInfo.passes.on.toLocaleString()} points), each square metre judged by its own returns` : p.lightInfo?.passes?.season === 'on' ? `, the lidar flown in leaf, so the crowns stand as the laser saw them${p.lightInfo.passes.dropped ? ` (a leaf-off pass's ${p.lightInfo.passes.dropped.toLocaleString()} points left out)` : ''}` : p.lightInfo?.canopy === 'seasonal' ? `, the trees in summer leaf: the lidar was flown with the leaves off${p.lightInfo.passes?.dropped ? ` (an in-leaf pass's ${p.lightInfo.passes.dropped.toLocaleString()} points left out)` : ''}` : ''}${p.lightInfo?.erased || p.lightInfo?.blocks ? `, with the edits made on the shade map: ${[p.lightInfo.erased ? `${p.lightInfo.erased} square metres of trees taken out` : '', p.lightInfo.blocks ? `${p.lightInfo.blocks} blocks of branches trimmed` : ''].filter(Boolean).join(' and ')}` : ''}${p.lightInfo?.blocksLost ? `; <strong>the ${p.lightInfo.blocksLost} blocks of branches trimmed on the shade map could not be carried over</strong> (it was saved on another grid: open the shade map and save it again)` : ''}). Shade takes away the sun's share of the grass's use, not the share the air itself dries out, which each day's weather sets (about a quarter, on a summer day here)${p.treeCool ? '; near trees the air is cooler on sunny summer days, and dries it less' : ''}.${p.windInfo ? ` Houses, trees${p.windInfo.fences ? ', fences' : ''} and hedges shelter each spot by what stands upwind of it, from the directions the local wind blows (the Wind view): in July from ${Math.round(p.windInfo.July.calmest * 100)}% of the open wind in the calmest tenth of the lawn to ${Math.round(p.windInfo.July.median * 100)}% in the middle, the lawn as a whole held to what was measured in yards like it.` : p.yardWind ? ` Houses and trees shelter the lawn from the wind: about ${Math.round(p.yardWind * 100)}% of the open wind the weather gives, from the cover round it (measured in yards like it), less again where the trees are thick.` : ''}` : ' The lawn is taken as in full sun until the shade is worked out.'}${p.seasonDays ? ` The watering season is the shade map's growing season here for ${p.grass === 'warm' ? 'warm' : 'cool'}-season grass, about ${p.seasonDays} days.` : ''} Grass beside paving and sunny walls is counted as using a little more (up to 8% at the edge, an estimate from published measurements).${p.grass === 'warm' ? ' Warm-season grass is let dry a little further between waterings than cool-season.' : ''} These are likely amounts, until a soak test on your lawn confirms them. Depths are what to put down: about a quarter more than the grass uses, since sprinklers water unevenly and the driest spots must get enough (a typical home system, until your heads are mapped). ${rootWords(p)} A day's watering is at most two runs with a soak between, so on slow ground it comes more often, a little at a time.${p.standIn ? ' <strong>No lawn was traced, so this plans for all the open ground</strong>: open this from a Lawn Mapper map for your lawn alone.' : ''}</p></div>`);
  const week = p.thisWeek;
  /* HOW FAST THE RECENT RAINS FELL (lib/weather.js addRainHours): the radar's hours, scaled to the day's total. A
     rain faster than the lawn takes water in partly ran off, so it did less than its inches suggest. */
  const rains = (week?.rains || []).slice(-6).reverse();
  if (rains.length) {
    const f = week.lawnIntakeMmH;
    const in2 = (mm) => (mm / 25.4).toFixed(2);
    const rows = rains.map((r) => `<tr><td>${dayName(r.date)}</td><td>${in2(r.mm)} in</td><td>${in2(r.peakMmH)} in${Number.isFinite(f) && r.peakMmH > f ? ' <strong>(faster than the lawn takes it: some ran off)</strong>' : ''}</td></tr>`).join('');
    parts.push(`<div class="card"><h2>The recent rains, and how fast they fell</h2>
      <table class="months"><tr><th>Day</th><th>Rain</th><th>Most in one hour</th></tr>${rows}</table>
      <p class="dim">${Number.isFinite(f) ? `Your lawn's soil takes in about ${in2(f)} in an hour on its typical ground. ` : ''}Rain faster than that runs off before it soaks in, so a cloudburst waters the lawn less than its total says; this week's plan counts it hour by hour. The hours are the National Weather Service's radar rain (Stage IV, gauge-corrected), from the Iowa Environmental Mesonet, scaled to the day's gauge-based total (PRISM).</p></div>`);
  }
  /* THE WIND HERE (owner, 2026-10-27: "find local weather data to see how windy the area is and what the trends
     are"): the nearest airport station's ten years (lib/wind.js), at 2 m over open grass. */
  const lw = p.localWind;
  if (lw?.stats?.byMonth) {
    const mph = (ms) => (Number.isFinite(ms) ? Math.round(ms * 2.237 * 10) / 10 : '–');
    const from = (b) => b.rose.map((v, k) => [v, k]).sort((a, c) => c[0] - a[0]).slice(0, 2).filter(([v]) => v > 0).map(([v, k]) => `${sectorName(k)} ${Math.round(v * 100)}%`).join(', ');
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const rows = lw.stats.byMonth.map((b, m) => `<tr><td>${MON[m]}</td><td>${mph(b.dayMs)}</td><td>${Math.round((b.calm || 0) * 100)}%</td><td>${mph(b.gustP90)}</td><td>${from(b)}</td></tr>`).join('');
    const tr = lw.stats.trendPerDecade;
    parts.push(`<div class="card"><h2>The wind here</h2>
      <p>From ${esc(lw.stats.prevailing !== null ? sectorName(lw.stats.prevailing) : 'no one direction')} most of all in summer; ${mph(lw.stats.all.dayMs)} mph in the daytime on average, calm ${Math.round(lw.stats.all.calm * 100)}% of the hours${Number.isFinite(tr) ? `; over these ${lw.stats.byYear.length} years ${Math.abs(tr) < 0.05 ? 'no change to speak of' : `${tr > 0 ? 'stronger' : 'lighter'} by about ${mph(Math.abs(tr))} mph a decade`}` : ''}.</p>
      <table class="months"><tr><th>Month</th><th>Daytime mph</th><th>Calm</th><th>Gusts, mph*</th><th>Daytime wind from</th></tr>${rows}</table>
      <p class="dim">${esc(lw.station.name)} airport, ${lw.station.km} km away, ${lw.stats.years.join('-')}: its hourly reports (the Iowa Environmental Mesonet's archive), at 2 m over open grass. *Gusts as the airport's 10 m mast reports them, in the hours it gusted: nine in ten below this. Your lawn's own wind is less: houses, trees and fences round it shelter it, each spot by what stands upwind of it.</p></div>`);
  }
  for (const z of p.zones) {
    const pk = peak(z), w = week?.zones.find((x) => x.zone === z.zone);
    const season = z.months.filter((m) => m.waterings || m.high);
    const why = [];
    why.push(`its soil holds about ${inch(z.tawMm)} in where the roots are (${z.soils.map(esc).join('; ')}; ${z.drainage.map((d) => esc(String(d).toLowerCase())).join(', ')})`);
    if (z.slope >= 0.04) why.push(`it slopes about ${Math.round(z.slope * 100)}%, so heavy rain runs off`);
    if (z.runOnShare >= 0.05) why.push(`${Math.round(z.runOnShare * 100)}% of it gets at least a quarter more water than its own rain, running off roofs, paving or ground uphill`);
    if (z.heatShare >= 0.2) why.push(`${Math.round(z.heatShare * 100)}% of it lies beside paving or a sunny wall, which warms it`);
    if (z.sun !== null && z.sun !== undefined) why.push(z.sun >= 0.85 ? 'it is in nearly full sun' : `it gets about ${Math.round(z.sun * 100)}% of full sun in summer, so it uses less`);
    const problems = [];
    if (z.wetAnyway > 0) problems.push(`About <strong>${sqft(z.wetAnyway)} sq ft</strong> stays wet even with no watering at all: likely a drainage matter, not a watering one.`);
    if (z.tooWet > 0) problems.push(`About <strong>${sqft(z.tooWet)} sq ft</strong> gets too wet when the area is watered as a whole: it also takes water from uphill, a roof or paving. Watering it less, or moving a downspout, would likely help.`);
    if (p.mode !== 'normal' && p.stress && z.dryShare > p.stress.planned + 0.1) problems.push(`This area goes short of water more than the rest of the lawn: on about <strong>${Math.round(z.dryShare * p.stress.seasonDays)} days</strong> of a typical season.`);
    if (z.tooDry > 0 && p.mode === 'normal') problems.push(`About <strong>${sqft(z.tooDry)} sq ft</strong> still dries out between waterings: it holds less, or loses more, than the rest.`);
    parts.push(`<div class="card"><h2>${chip(z.zone)}Area ${z.zone + 1} · ${sqft(z.m2)} sq ft</h2>
      <p class="big">${pk.waterings ? `About ${inch(pk.mmEach)} in each time; in ${MONTH[pk.month]}, ${howOften(pk).replace(/ \(.*$/, '')}.` : 'Rain likely covers it in a typical year.'}</p>
      ${z.dryWeek ? `<p>In a ${MONTH[z.dryWeek.month]} week with no rain: about <strong>${inch(z.dryWeek.mm)} in</strong>${p.mode !== 'normal' ? ` (at the ${p.mode} coefficient)` : ''}, over ${z.dryWeek.waterings} watering${z.dryWeek.waterings > 1 ? 's' : ''}. Skip one for each ${inch(z.dryWeek.each)} in or so of rain.</p>` : ''}
      ${w ? `<p>${w.next ? `Next watering: likely <strong>${dayName(w.next.date)}</strong>, about ${inch(w.next.mm)} in.` : `No watering needed through ${dayName(week.through)}, from the last weeks' weather and the forecast.`}</p>` : ''}
      <table class="months"><tr><th>Month</th><th>How often</th><th>Each time</th></tr>
      ${season.map((m) => `<tr><td>${MONTH[m.month]}</td><td>${howOften(m)}</td><td>${m.mmEach ? `${inch(m.mmEach)} in` : '–'}</td></tr>`).join('')}</table>
      ${z.takesInPerH ? `<p class="dim">${soakAdvice(z.takesInPerH, pk.mmEach || z.depthMm)}</p>` : ''}
      <p class="dim">Why: ${why.join('; ')}.</p>
      ${problems.length ? `<ul>${problems.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}</div>`);
  }
  const soilList = p.texture ? [{ ...p.soil[0], name: p.soil.map((u) => u.name).filter(Boolean).join('; '), share: null }] : p.soil;
  const soilRows = soilList.map((u) => {
    const wet = u.wetByMonth.map((v, m) => (v !== null && v !== undefined ? [m, v] : null)).filter(Boolean);
    const table = wet.length ? ` The water table comes within about ${Math.round(Math.min(...wet.map((x) => x[1])) / 2.54)} in of the surface in ${wet.map((x) => MONTH[x[0]].slice(0, 3)).join(', ')}.` : '';
    const what = u.chosen ? `<strong>${esc(u.chosen)}</strong>, as you chose (the survey says ${esc(u.name || 'unnamed')})` : `<strong>${esc(u.name || 'unnamed')}</strong>`;
    const layers = u.layers?.length ? ` Layers: ${u.layers.map((l) => `${l.topIn}–${l.bottomIn} in ${esc(l.texture)}`).join('; ')}.` : '';
    const intake = u.intakeInH ? ` Water soaks into the top layer at about ${u.intakeInH < 0.1 ? u.intakeInH.toFixed(2) : u.intakeInH.toFixed(1)} in an hour, as the survey measured it${u.intakeInH < 0.3 ? ': slowly' : ''}.` : '';
    return `<li>${what}${u.share !== null && !u.chosen ? ` (${Math.round(u.share * 100)}% of the area)` : ''}: ${esc(String(u.drainage || 'drainage not given').toLowerCase())}, hydrologic group ${esc(u.hydgrp || '?')}.${layers} The top ${Math.round(p.rootIn || 8)} in, where the roots are, hold about ${inch((p.topsoil ? u.tawTopsoilMm : u.tawMm) ?? 0)} in of water the grass can use${p.topsoil ? ', with your 4 in of loamy topsoil on top' : ''}.${intake}${table}</li>`;
  });
  parts.push(`<div class="card"><h2>The soil${p.topsoil ? ' (with 4 in of loamy topsoil on the lawn)' : ''}</h2><ul>${soilRows.join('')}</ul>
    <p class="dim">From the USDA soil survey (NRCS). A soak test (coming) will check it on your lawn.</p></div>`);
  const wm = p.weather.filter((m) => m.grassUseMm > 10);
  parts.push(`<div class="card"><h2>The weather it is planned on</h2>
    <table class="months"><tr><th>Month</th><th>Rain</th><th>Reference ET</th><th>Your grass uses</th></tr>${wm.map((m) => `<tr><td>${MONTH[m.month]}</td><td>${inch(m.rainMm)} in</td><td>${inch(m.referenceMm)} in</td><td>${inch(m.grassUseMm)} in</td></tr>`).join('')}</table>
    <p class="dim">Typical months: the middle of the last ${p.years} years. Rain: ${esc(p.rainFrom || 'NASA POWER')}. Reference ET is what well-watered, clipped grass would use (FAO-56 Penman-Monteith from NASA POWER's weather; Enviroweather and most weather networks call it potential ET); your grass's use is that times 0.8, before shade and paving change it square by square. Not all rain soaks in: on a slope or in a downpour some runs off, which the plan counts.</p></div>`);
  if (p.roofs.guessed) parts.push(`<p class="hint">${p.roofs.guessed} roof${p.roofs.guessed > 1 ? 's' : ''} on your property ${p.roofs.guessed > 1 ? 'have' : 'has'} no downspouts entered, so ${p.roofs.guessed > 1 ? 'their' : 'its'} water is assumed to come off at the low corner. Add the downspouts for a truer plan: tap <em>Add a downspout</em>, then the roof edge it comes from, then where it empties.</p>`);
  if (p.roofs.unusedDownspouts.length) parts.push(`<p class="hint">${p.roofs.unusedDownspouts.length} downspout${p.roofs.unusedDownspouts.length > 1 ? 's are' : ' is'} not on a roof: tap closer to the roof's edge.</p>`);
  $('#plan').innerHTML = parts.join('');
  $('#save-pdf')?.addEventListener('click', savePdf);
}
/** The roots, in the plan's words: the species checked, their working depth, and the season's rise and fall. */
function rootWords(p) {
  const r = p.roots;
  if (!r) return `Roots are taken to reach ${Math.round(p.rootIn || 8)} in.`;
  const names = r.species.map((sp) => sp.name.replace(/ \(.*\)$/, '').toLowerCase());
  const what = r.species.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const depth = r.species.length > 1 ? `the average of their working depths, ${r.workingIn} in` : `a working depth of ${r.workingIn} in`;
  const t = r.typical;
  const season = t && t.peakIn - t.lowIn >= 0.3 ? ` From the soil's temperature through the year the roots stand deepest in ${MONTH[t.peakMonth]} (about ${t.peakIn} in) and shallowest in ${MONTH[t.lowMonth]} (about ${t.lowIn} in)${r.ownDays ? `, each of the ${p.years} years by its own soil temperature` : ''}: shallow roots mean smaller, more frequent waterings then.` : t ? ` The soil's temperature through the year moves them little here (${t.lowIn}-${t.peakIn} in).` : '';
  return `Watering is planned to wet the roots of ${what}: ${depth}${r.species.some((sp) => sp.general) ? ' (the general figure where a grass has no measured depth of its own)' : ''}.${season}`;
}
/** The report as a PDF: the map as it is drawn now, above the report, through the browser's print ("Save as PDF"). */
function savePdf() {
  try { const img = $('#print-map'), cv = $('#view'); if (img && cv) img.src = cv.toDataURL('image/jpeg', 0.85); } catch { /* a tainted canvas: the report alone */ }
  setTimeout(() => window.print(), 50);
}

/** The ground water the land round the lawn may send it (lib/upslope.js): a first cut, worded "likely". */
function hillReport(h) {
  if (h.error) { $('#hill').innerHTML = `<p class="dim">The land round the lawn could not be read (${esc(h.error)}).</p>`; return; }
  const acres = (ha) => (ha * 2.471).toFixed(ha * 2.471 < 10 ? 1 : 0);
  const head = h.level === 'likely' ? 'Water from below: likely in wet seasons' : h.level === 'possible' ? 'Water from below: possible in wet seasons' : 'Water from below: unlikely';
  const why = [];
  if (h.belowHill) why.push(`about ${acres(h.upslopeHa)} acres of slope (${Math.round(h.upslopeSlope * 100)}% on average) drain toward the lawn`);
  else if (h.upslopeHa >= 0.1) why.push(`about ${acres(h.upslopeHa)} acres drain toward the lawn, most of it gentle (${Math.round(h.upslopeSlope * 100)}%)`);
  else why.push('little land drains toward the lawn');
  why.push(`the lawn sits wetter than ${Math.round(h.twiPercentile * 100)}% of the land within about a third of a mile, by its shape`);
  if (h.handM !== null) why.push(`its middle is about ${Math.round(h.handM * 3.28)} ft above the nearest natural drainage line${h.channelM !== null ? `, ${Math.round(h.channelM * 3.28).toLocaleString()} ft away` : ''}`);
  $('#hill').innerHTML = `<div class="card"><h2>${head}</h2>
    <p>${why.join('; ').replace(/^./, (c) => c.toUpperCase())}.</p>
    <p>${h.level === 'likely' ? 'Ground water from the land above can keep the soil under this lawn wetter than rain alone would, most in spring. Water less than the plan says until a soak test or a soil probe shows the ground drying, and watch for spots that stay soft.' : h.level === 'possible' ? 'Some ground water from the land above may reach the lawn in a wet spring. The plan does not count it yet.' : 'The plan needs no allowance for it.'}</p>
    <p class="dim">From the USGS 10 m ground model round the lawn. A first reading, not yet checked against real lawns; the soil survey's own water table, where it has one, is in the soil card above.</p></div>`;
}

/* STREAMS AND THE FLOOD PLAIN (owner, 2026-10-31; FINDINGS H63): the nearest streams and their water's height, and
   FEMA's flood zones and 1% flood water against the lawn's own lidar ground. */
function streamsReport(r) {
  if (r.error) { $('#streams').innerHTML = `<p class="dim">The streams and the flood map could not be read (${esc(r.error)}).</p>`; return; }
  const ft = (m) => Math.round(m * 3.28084), dist = (m) => (m < 400 ? `${Math.round(m * 3.28084 / 10) * 10} ft` : `${(m / 1609.34).toFixed(m < 1609 ? 2 : 1)} mi`);
  const named = (s) => (s.name ? s.name : s.kind === 'perennial' ? 'a stream that flows all year' : `an unnamed ${s.kind}`);
  const lines = [];
  const p = r.perennial, n = r.nearest;
  if (p) {
    lines.push(`<p><strong>The nearest stream that flows all year</strong>: ${esc(named(p))}, ${dist(p.distM)} away${p.km2 ? `, draining ${p.km2 < 10 ? p.km2.toFixed(1) : Math.round(p.km2)} km\u00b2` : ''}.${Number.isFinite(p.aboveM) ? ` The middle of the lawn stands about <strong>${ft(p.aboveM)} ft above its water</strong>. A stream that flows all year runs at the water table, so the water table under the lawn is no deeper than that, and usually shallower under rising ground.${p.aboveM < 1.5 && p.distM < 150 ? ' That close and that low, it is likely within reach of the roots in spring.' : ''}` : ''}</p>`);
  } else if (r.streamsOk) lines.push('<p>No stream that flows all year within about two thirds of a mile.</p>');
  if (n && (!p || n.distM < p.distM - 20)) lines.push(`<p>Nearer: ${esc(named(n))}${n.kind !== 'perennial' && n.name ? ` (${n.kind})` : ''}, ${dist(n.distM)} away${Number.isFinite(n.aboveM) ? `, about ${ft(Math.abs(n.aboveM))} ft ${n.aboveM >= 0 ? 'below' : 'above'} the lawn` : ''}. ${/intermittent/.test(n.kind) ? 'It runs in wet seasons only.' : /ditch/.test(n.kind) ? 'A dug channel: it carries water away and can lower the water table near it.' : ''}</p>`);
  if (r.floodOk) {
    const zoneWords = (z) => (!z.zone ? 'outside every mapped flood zone' : /^A/.test(z.zone) ? `in the 1%-chance (100-year) flood plain (zone ${z.zone})` : z.zone === 'X' && /0\.2/.test(z.subtype || '') ? 'in the 0.2%-chance (500-year) flood plain' : z.zone === 'X' ? 'in an area of minimal flood hazard (zone X)' : z.zone === 'D' ? `in an area whose flood hazard is not determined${z.subtype ? ` (${esc(z.subtype.toLowerCase())})` : ''}` : `in zone ${esc(z.zone)}`);
    const zs = r.zones.filter((z) => z.share >= 0.01);
    lines.push(`<p><strong>FEMA's flood map</strong>: ${zs.length ? zs.map((z) => `${zs.length > 1 ? `${Math.round(z.share * 100)}% of the lawn ` : 'the lawn is '}${zoneWords(z)}`).join('; ') : 'no flood map here'}.${r.flood ? (r.flood.depthShare > 0 ? ` The 1% flood's water here stands about ${ft(r.flood.m)} ft above sea level (from FEMA's ${esc(r.flood.from)}${Number.isFinite(r.flood.nearM) && r.flood.nearM > 0 ? `, ${dist(r.flood.nearM)} away` : ''}): <strong>${Math.round(r.flood.depthShare * 100)}% of the lawn lies under it</strong>, up to about ${ft(r.flood.maxDepthM)} ft deep.` : ` The 1% flood's water here stands about ${ft(r.flood.m)} ft above sea level (from FEMA's ${esc(r.flood.from)}${Number.isFinite(r.flood.nearM) && r.flood.nearM > 0 ? `, ${dist(r.flood.nearM)} away` : ''}); the lawn's lowest point is about ${ft(r.flood.lowestAboveM)} ft above it.`) : ''}</p>`);
  }
  $('#streams').innerHTML = lines.length ? `<div class="card"><h2>Streams and the flood plain</h2>${lines.join('')}
    <p class="dim">The streams from the USGS national stream map (NHDPlus HR), their water's height from the USGS 10 m ground; the flood zones and the 1% flood's water from FEMA's National Flood Hazard Layer; the lawn's height from its own lidar. On this page only: not used in the watering plan.</p></div>` : '';
}

/* ----------------------------------------------------------------- flow */

let running = null;
const valveAsk = { n: 0, waiting: new Map() };

async function run(site) {
  running?.terminate();
  view.site = site; view.data = null; view.plan = null;
  zoom.s = 1; zoom.tx = 0; zoom.ty = 0; $('#view').style.transform = '';
  $('#result').hidden = true; $('#plan').innerHTML = ''; $('#hill').innerHTML = ''; $('#streams').innerHTML = '';
  const kept = site.water || {};
  inputs.downspouts = Array.isArray(kept.downspouts) ? kept.downspouts : [];
  inputs.gutters = Array.isArray(kept.gutters) ? kept.gutters : [];
  inputs.areas = Array.isArray(kept.areas) ? kept.areas : [];
  added.length = 0;
  inputs.topsoil = !!kept.topsoil;
  inputs.species = Array.isArray(kept.species) ? kept.species.filter((id) => SPECIES[id]) : [];
  inputs.grass = inputs.species.length ? groupOf(inputs.species) : kept.grass === 'warm' ? 'warm' : 'cool';
  inputs.texture = ''; // the soil is the survey's (owner 2026-10-19: no override)
  inputs.layers = kept.layers && typeof kept.layers === 'object' ? kept.layers : null;
  inputs.wind = kept.wind && typeof kept.wind === 'object' ? kept.wind : null;
  view.layers = null; view.layersRaw = null; view.layerPicked = null; view.layersError = '';
  $('#topsoil').checked = inputs.topsoil;
  restored = false;
  inputs.mode = ['normal', 'deficit', 'dormancy'].includes(kept.mode) ? kept.mode : 'normal';
  modeBoxes();
  speciesBoxes();
  setMode(null);
  status(`Reading the survey for ${site.label}…`);
  busyJobs.clear(); busy('survey', 'Reading the lidar survey of the ground…');
  view.hillIn = false;
  const w = new Worker('/analyse.js', { type: 'module' });
  running = w;
  const first = new Promise((resolve, reject) => {
    w.onmessage = ({ data }) => {
      if (data.progress) { status(`Reading the survey… ${data.progress.done} of ${data.progress.total} pieces`); busy('survey', `Reading the lidar survey of the ground: ${data.progress.done} of ${data.progress.total} pieces`); }
      else if (data.error) { w.terminate(); clearBusy(); reject(new Error(data.error)); }
      else if (data.done) resolve(data.done);
      else if (data.planProgress) { $('#saved').textContent = data.planProgress; busy('plan', data.planProgress); }
      else if (data.valvePlan) { const w = valveAsk.waiting.get(data.valvePlan.id); valveAsk.waiting.delete(data.valvePlan.id); if (w) { if (data.valvePlan.error) w.reject(new Error(data.valvePlan.error)); else w.resolve(data.valvePlan); } }
      else if (data.plan) { idle('plan'); if (!view.hillIn) busy('hill', 'Reading the land round the lawn (water from uphill)…'); view.plan = data.plan; needScale(); heads.planIn?.(); $('#saved').textContent = savedNote; if (!heads.active) planReport(data.plan); legend(); draw(); }
      else if (data.planError) { idle('plan'); idle('hill'); $('#saved').textContent = `The watering plan could not be worked out: ${data.planError}`; }
      else if (data.hill) { view.hillIn = true; idle('hill'); hillReport(data.hill); }
      else if (data.streams) { streamsReport(data.streams); }
      else if (data.wind) { inputs.wind = data.wind; keep(); }
    };
    w.onerror = (e) => { w.terminate(); clearBusy(); reject(new Error(e.message || 'the analysis stopped')); };
  });
  w.postMessage({ site, inputs: { ...inputs } });
  // the photo first, over the analysis box (lib/site.js boxFor; the shade map's own box when it has one),
  // so the sprinklers can be placed while the survey is read
  status('Fetching the photo…');
  const box = site.lidar?.box?.length === 4 ? site.lidar.box : boxFor(site);
  view.frame = frameFor(box, site.lat);
  // the drains and water on the same box, in degrees (lib/layers.js), kept with the map
  { const [w, s0] = fromMerc([box[0], box[1]]), [e, n] = fromMerc([box[2], box[3]]); loadLayers([w, s0, e, n], inputs.layers); }
  busy('photo', 'Fetching the photo…');
  const saved = await savedPhoto(view.frame, site).finally(() => idle('photo'));
  view.photo = saved.photo; view.photoShift = saved.shift; view.photoName = saved.name;
  if (!view.photo) { $('#show-photo').checked = false; view.photo = { width: 1280, height: 1280 }; view.photoName = 'no photo (it would not load)'; }
  $('#result').hidden = false;
  const asking = await heads.open(kept.irrigation);
  restoredNow();
  $('#result').classList.toggle('heads-on', asking);
  headsCard();
  draw();
  status(asking ? 'Reading the survey while you do this…' : `Reading the survey for ${site.label}…`);
  const d = await first;
  idle('survey');
  view.data = d; three.meshFor = null;
  heads.refresh(); // the ground's heights and the buildings: the pressure model solves again with them
  legend();
  draw();
  if (!heads.active) report(d, site);
  status('');
  const back = $('#back');
  if (back && site.mapId) back.href = `${HOME}/dashboard?map=${encodeURIComponent(site.mapId)}`;
}

/* ------------------------------------------- what the person enters, kept */

let savedNote = '', saveTimer = null;

function replan() {
  if (!running || !view.data) return;
  $('#saved').textContent = 'Working out the watering plan…';
  busy('plan', 'Working out the watering plan again…');
  running.postMessage({ replan: { ...inputs } });
}

function changed() {
  draw();
  replan();
  keep();
}

/* EVERY CHANGE IS KEPT WITH THE MAP (owner, 2026-10-20: "make sure that every step in the sprinkler placement
   saves progress to the unified save file"): the water part of the map (POST /api/maps/tool, docs/MAPS.md)
   is written a moment after the last change; a save that fails is tried again until it lands; one that is
   still waiting when the page is closed or put away is sent with keepalive, so it outlives the page. */
let dirty = false, saving = null, retryTimer = null;
/* NOT BEFORE THE MAP'S OWN PART IS BACK (found 2026-10-28): the drains and water (loadLayers) can land, and ask
   to be kept, before the sprinklers have been restored from the map (heads.open, after the photo); a save then
   would carry an empty sprinkler map over the real one. A change asked for before that waits for it. */
let restored = false;
function restoredNow() { restored = true; if (dirty) save(); }
const MAX_TOOL_BYTES = 64 * 1024; // the unified save's limit for one tool's part

function showSaved(note) {
  savedNote = note;
  if (!/Working/.test($('#saved').textContent)) $('#saved').textContent = note;
  const hs = $('#heads-saved');
  if (hs) hs.textContent = note;
}

/** Save what was entered, a moment after the last change. */
function keep() {
  if (!view.site?.mapId) { showSaved('Open this from your dashboard to keep your sprinklers, downspouts and gutters with the map.'); return; }
  dirty = true;
  showSaved('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
}

function saveBody() {
  return JSON.stringify({ data: { v: 1, downspouts: inputs.downspouts, gutters: inputs.gutters, areas: inputs.areas, topsoil: inputs.topsoil, grass: inputs.grass, species: inputs.species, mode: inputs.mode, irrigation: heads.data, layers: inputs.layers || null, wind: inputs.wind || null }, basedOn: view.site.at });
}
const saveUrl = () => `/api/maps/tool?id=${encodeURIComponent(view.site.mapId)}&tool=water`;

async function save() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dirty || !view.site?.mapId || !restored) return;
  if (saving) { await saving; return save(); } // one at a time: a change made meanwhile goes in the next
  dirty = false;
  let body = saveBody();
  // the drains and water give way first: trimmed to what is left after the person's own entries
  if (body.length > MAX_TOOL_BYTES && inputs.layers && view.layersRaw) { inputs.layers = view.layers = compact(view.layersRaw, { centre: lawnMid(), budget: layerBudget() }); body = saveBody(); }
  if (body.length > MAX_TOOL_BYTES && inputs.layers) { inputs.layers = null; body = saveBody(); }
  if (body.length > MAX_TOOL_BYTES) { dirty = true; showSaved(`Not saved: this map's water part is ${Math.round(body.length / 1024)} KB, over the ${MAX_TOOL_BYTES / 1024} KB a tool may keep.`); return; }
  saving = (async () => {
    try {
      const res = await fetch(saveUrl(), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body });
      if (res.ok) { showSaved('Saved with your map.'); return; }
      dirty = true;
      showSaved(res.status === 401 || res.status === 403 ? `Not saved: sign in again to keep it (${res.status}).` : `Not saved yet (${res.status}); trying again.`);
    } catch (e) {
      dirty = true;
      showSaved(`Not saved yet (${e.message || 'no connection'}); trying again.`);
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(save, 5000);
  })();
  await saving;
  saving = null;
}

// closing the page, or a phone putting it away, with a change not yet sent: send it now, outliving the page
function flush() {
  if (!dirty || !view.site?.mapId || !restored) return;
  const body = saveBody();
  if (body.length > MAX_TOOL_BYTES) return;
  try { fetch(saveUrl(), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }); dirty = false; } catch { /* the next visit's save will try */ }
}
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

function setMode(m) {
  mode = m; pending = m === 'gutter' || m === 'area' ? [] : null;
  $('#add-area').classList.toggle('on', m === 'area');
  $('#add-area').textContent = m === 'area' ? 'Done with this area' : 'Mark an area';
  $('#area-kind').hidden = m !== 'area';
  $('#add-spout').classList.toggle('on', m === 'from' || m === 'to');
  $('#add-gutter').classList.toggle('on', m === 'gutter');
  $('#add-gutter').textContent = m === 'gutter' ? 'Done with this gutter' : 'Draw a gutter';
  $('#view').classList.toggle('picking', !!m);
  $('#hint').textContent = m === 'from' ? 'Tap the spot on the roof edge where the downspout comes down.'
    : m === 'to' ? 'Now tap where it empties onto the ground (the end of its extension, or the drain it goes into).'
      : m === 'gutter' ? 'Tap along the eave, corner to corner, then "Done with this gutter".'
        : m === 'area' ? 'Choose what it is, then tap its corners all the way round, then "Done with this area". It overrides what the map found there.' : '';
}

/* ZOOM AND PAN (owner 2026-10-19: "the image is static and can't be zoomed in, that makes it difficult
   ... to place the gutters accurately"). The canvas is scaled and moved inside the stage with a CSS
   transform; a tap is mapped through it (tapAt reads the transformed box), and a drag or a pinch never
   counts as a tap. */
const zoom = { s: 1, tx: 0, ty: 0, pts: new Map(), moved: false, start: null };
function applyZoom() {
  const cv = $('#view');
  const w = cv.offsetWidth, h = cv.offsetHeight; // the canvas's laid-out size, before the transform
  zoom.s = Math.max(1, Math.min(8, zoom.s));
  zoom.tx = Math.min(0, Math.max(w - w * zoom.s, zoom.tx));
  zoom.ty = Math.min(0, Math.max(h - h * zoom.s, zoom.ty));
  cv.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.s})`;
  // the sprinklers' dots and labels keep their size on the screen: drawn again once the zoom settles
  clearTimeout(zoom.redraw); zoom.redraw = setTimeout(draw, 150);
}
function zoomAt(factor, cx, cy) {
  const st = $('#stage').getBoundingClientRect();
  const x = cx - st.left, y = cy - st.top;
  const s1 = Math.max(1, Math.min(8, zoom.s * factor)), k = s1 / zoom.s;
  zoom.tx = x - (x - zoom.tx) * k; zoom.ty = y - (y - zoom.ty) * k; zoom.s = s1;
  applyZoom();
}
const stageEl = $('#stage');
stageEl.addEventListener('pointerdown', (ev) => {
  if (ev.target.closest('.zoom')) return;
  if (view.photo && heads.grab(ev)) { stageEl.setPointerCapture?.(ev.pointerId); return; } // dragging a sprinkler head
  zoom.pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
  if (zoom.pts.size === 1) { zoom.moved = false; zoom.start = [ev.clientX, ev.clientY]; }
  stageEl.setPointerCapture?.(ev.pointerId);
});
stageEl.addEventListener('pointermove', (ev) => {
  if (heads.move(ev)) return;
  if (!zoom.pts.has(ev.pointerId)) return;
  const prev = zoom.pts.get(ev.pointerId);
  if (zoom.pts.size === 1) {
    if (Math.hypot(ev.clientX - zoom.start[0], ev.clientY - zoom.start[1]) > 6) zoom.moved = true;
    if (zoom.moved) { zoom.tx += ev.clientX - prev[0]; zoom.ty += ev.clientY - prev[1]; applyZoom(); }
  } else if (zoom.pts.size === 2) {
    const [a, b] = [...zoom.pts.values()];
    const other = a === prev ? b : a;
    const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]), d1 = Math.hypot(ev.clientX - other[0], ev.clientY - other[1]);
    if (d0 > 0) zoomAt(d1 / d0, (ev.clientX + other[0]) / 2, (ev.clientY + other[1]) / 2);
    zoom.moved = true;
  }
  zoom.pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
});
const lift = (ev) => { if (heads.drop(ev)) return; zoom.pts.delete(ev.pointerId); };
stageEl.addEventListener('pointerup', lift);
stageEl.addEventListener('pointercancel', lift);
stageEl.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomAt(ev.deltaY < 0 ? 1.25 : 0.8, ev.clientX, ev.clientY); }, { passive: false });
$('#zoom-in').addEventListener('click', () => { const r = stageEl.getBoundingClientRect(); zoomAt(1.6, r.left + r.width / 2, r.top + r.height / 2); });
$('#zoom-out').addEventListener('click', () => { const r = stageEl.getBoundingClientRect(); zoomAt(1 / 1.6, r.left + r.width / 2, r.top + r.height / 2); });
$('#zoom-reset').addEventListener('click', () => { zoom.s = 1; zoom.tx = 0; zoom.ty = 0; applyZoom(); });

stageEl.addEventListener('click', (ev) => { // on the stage: it holds the pointer while a finger is down
  if (ev.target.closest('.zoom')) return;
  if (zoom.moved) { zoom.moved = false; return; } // the end of a drag or a pinch, not a tap
  if (view.photo && heads.tap(ev)) return;
  // the drains and water: a tap shows the nearest one's details (about 14 screen px round the finger)
  if (!mode && mapView === 'drains' && view.layers) {
    const at = tapAt(ev), cv = $('#view'), css = cv.width / cv.getBoundingClientRect().width;
    const got = layerPick(view.layers, at, (14 * css) / pxPerM());
    view.layerPicked = got ? { ...got, at } : null;
    legend(); draw();
    return;
  }
  if (!mode || !view.data) return;
  const p = tapAt(ev);
  if (mode === 'from') { setMode('to'); pending = p; draw(); return; }
  if (mode === 'to') { inputs.downspouts.push({ from: pending, to: p }); added.push('spout'); setMode(null); changed(); return; }
  if (mode === 'gutter' || mode === 'area') { pending.push(p); draw(); }
});
$('#add-spout').addEventListener('click', () => setMode(mode === 'from' || mode === 'to' ? null : 'from'));
$('#add-area').addEventListener('click', () => {
  if (mode === 'area') {
    const ring = pending, kind = $('#area-kind').value;
    setMode(null);
    if (ring.length >= 3) { inputs.areas.push({ kind, ring }); added.push('area'); changed(); } else draw();
    return;
  }
  setMode('area');
});
$('#area-kind').addEventListener('change', draw);
$('#add-gutter').addEventListener('click', () => {
  if (mode === 'gutter') { const line = pending; setMode(null); if (line.length >= 2) { inputs.gutters.push(line); added.push('gutter'); changed(); } else draw(); return; }
  setMode('gutter');
});
$('#undo').addEventListener('click', () => {
  if (mode) { setMode(null); draw(); return; }
  // the last thing entered this visit; after a reload, the last area, then gutter, then downspout
  const last = added.pop() || (inputs.areas.length ? 'area' : inputs.gutters.length ? 'gutter' : 'spout');
  if (last === 'area') inputs.areas.pop(); else if (last === 'gutter') inputs.gutters.pop(); else inputs.downspouts.pop();
  changed();
});
$('#clear').addEventListener('click', () => {
  if (!inputs.downspouts.length && !inputs.gutters.length && !inputs.areas.length) return;
  if (!confirm('Remove every downspout, gutter and marked area on this map?')) return;
  inputs.downspouts = []; inputs.gutters = []; inputs.areas = []; added.length = 0; setMode(null); changed();
});
$('#topsoil').addEventListener('change', () => { inputs.topsoil = $('#topsoil').checked; changed(); });
/* HOW MUCH TO WATER (owner, 2026-10-28: normal, deficit or dormancy, "just before asking if the user has irrigation"):
   the same choice sits on the page and on the sprinklers' first step; it is kept with the map and re-plans. */
function modeBoxes() {
  document.querySelectorAll('#mode input[name=mode]').forEach((el) => { el.checked = el.value === inputs.mode; });
}
function setWateringMode(m) {
  if (!['normal', 'deficit', 'dormancy'].includes(m) || m === inputs.mode) return;
  inputs.mode = m; modeBoxes(); changed();
}
document.querySelectorAll('#mode input[name=mode]').forEach((el) => el.addEventListener('change', () => setWateringMode(el.value)));
/* THE GRASSES (owner, 2026-10-28: "users will need to check boxes to indicate their planted species"): the species
   checked set the roots' working depth and their season's rise and fall (lib/roots.js); the group (cool- or
   warm-season) follows the species, the one with more of them. */
function speciesBoxes() {
  const box = $('#species');
  if (!box) return;
  const groups = [['cool', 'Cool-season'], ['warm', 'Warm-season']];
  box.innerHTML = groups.map(([g, label]) => `<div class="species-group"><strong>${label}</strong>${Object.entries(SPECIES).filter(([, sp]) => sp.group === g).map(([id, sp]) => `<label class="toggle"><input type="checkbox" data-species="${id}" ${inputs.species.includes(id) ? 'checked' : ''}> ${sp.name}</label>`).join('')}</div>`).join('');
  if (!inputs.species.length) { const gen = inputs.grass === 'warm' ? 'warmMix' : 'coolMix'; box.querySelector(`[data-species=${gen}]`).checked = true; }
  box.querySelectorAll('[data-species]').forEach((el) => el.addEventListener('change', () => {
    inputs.species = [...box.querySelectorAll('[data-species]:checked')].map((x) => x.dataset.species);
    inputs.grass = groupOf(inputs.species, inputs.grass);
    changed();
  }));
}

async function guarded(fn) {
  try { await fn(); } catch (e) { clearBusy(); status(e.message || String(e), 'bad'); }
}

/* THE MAP TO OPEN (owner, 2026-10-23): a menu of the person's saved maps whose lawn and shade map are done (lib/
   maps.js), in place of an address search. Choosing one reopens the page on it; a change not yet saved on this map
   is sent first (flush), so it lands on this map, not the next. */
async function fillMapMenu() {
  const sel = $('#map-pick'), none = $('#map-none');
  let maps = [];
  try {
    const res = await fetch('/api/maps', { credentials: 'same-origin' });
    maps = res.ok ? openable((await res.json())?.maps) : [];
  } catch { maps = []; }
  const dash = `${HOME}/dashboard`;
  if (!maps.length) {
    sel.hidden = true; none.hidden = false;
    none.innerHTML = `No saved map has its lawn and its shade map done yet. Finish both from <a href="${dash}">your dashboard</a>, then open the water map from there or here.`;
    return;
  }
  sel.innerHTML = `${mapId ? '' : '<option value="">Choose a map…</option>'}${maps.map((m) => `<option value="${esc(m.id)}" ${m.id === mapId ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}`;
  if (mapId && !maps.some((m) => m.id === mapId)) sel.insertAdjacentHTML('afterbegin', '<option value="" selected>This map (its lawn or shade map is not finished)</option>');
  sel.onchange = () => {
    if (!sel.value || sel.value === mapId) return;
    flush();
    location.href = `${location.pathname}?map=${encodeURIComponent(sel.value)}`;
  };
}
fillMapMenu();

for (const id of ['#show-photo', '#show-hard']) $(id).addEventListener('change', () => { legend(); draw(); });
$('#edit-heads').addEventListener('click', async () => { setMode(null); if (await heads.open(heads.data, { force: true })) { $('#result').classList.add('heads-on'); draw(); $('#stage').scrollIntoView({ behavior: 'smooth' }); } });
/* The water-need layer (owner 2026-10-19: knock-on effects of every input, as on a real lawn): each square
   metre's own watering in the lawn's thirstiest month, scaled from the lawn's 5th to 95th percentile. */
function needScale() {
  const p = view.plan;
  if (!p) { view.need = null; return; }
  const v = Array.from(p.needMm).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) { view.need = null; return; }
  view.need = { lo: v[Math.floor(v.length * 0.05)], hi: v[Math.floor(v.length * 0.95)] };
}

/* THE KEY AND A FEW WORDS FOR THE VIEW SHOWN: only its own colours (the property line and the lawn's outline
   are on every view) */
const key = (bg, text, border = false) => `<span><i style="background:${bg}${border ? ';border:1px solid #888' : ''}"></i>${text}</span>`;
function legend() {
  const p = view.plan, d = view.data, items = [], info = [];
  const base = [key('#ffeb3b', 'property line'), key('#69f0ae', 'your lawn')];
  if ($('#show-hard').checked) base.push(key('#111', 'paving', true), key('#fff', 'roof', true));
  if (mapView === 'zones') {
    if (p?.zones?.length) items.push(...p.zones.map((z) => `<span>${chip(z.zone)}area ${z.zone + 1}</span>`));
    items.push(key('#ff1744', 'too wet if watered with its area'), key('#0d47a1', 'wet even without watering'), key('#ffd600', view.plan?.mode && view.plan.mode !== 'normal' ? 'short of water more than the rest' : 'still dries out'));
    info.push('Watering areas: parts of the lawn that need the same watering, from the plan below: their soil, slope, sun and the water that runs onto them. They are not your sprinkler zones (your valves), which are under <em>Sprinklers</em>.');
  } else if (mapView === 'need') {
    if (view.need) items.push(`<span><i style="background:linear-gradient(90deg,#e3f2fd,#0d47a1);width:48px"></i>${inch(view.need.lo)} to ${inch(view.need.hi)} in of watering in a typical ${MONTH[p.needMonth ?? 6]}, square by square</span>`);
    info.push('Each square metre\'s own watering in the lawn\'s thirstiest month: darker needs more. Every input shows here, whether or not it moves the line between two areas.');
  } else if (mapView === 'soil') {
    info.push(soilInfo(p));
  } else if (mapView === 'water') {
    items.push(key('#1e6bff', 'a hollow in the lawn that holds water'), key('#bec8d7', 'low ground off the lawn (paving, under trees, a ditch)'), key('#22d3ee', 'where runoff runs together'), key('#ff9100', 'downspout, from the roof edge to where it empties'));
    info.push('Where rain collects and where it runs, from the USGS lidar survey of the ground. The cards below list each hollow.');
  } else if (mapView === 'drains') {
    const L = view.layers;
    if (L?.layers?.length) for (const kind of Object.keys(LAYER_KINDS)) {
      if (!L.layers.some((l) => l.kind === kind)) continue;
      const k = LAYER_KINDS[kind];
      items.push(`<span><i style="background:${k.draw === 'area' ? k.fill || 'transparent' : k.draw === 'line' ? k.stroke : k.fill};border:${k.draw === 'line' ? 0 : `2px ${k.dash ? 'dashed' : 'solid'} ${k.stroke}`}${k.shape === 'circle' ? ';border-radius:50%' : ''}${k.draw === 'line' ? ';height:4px;vertical-align:3px' : ''}"></i>${k.label}</span>`);
    }
    if (view.layerPicked) {
      const pk = view.layerPicked, k = LAYER_KINDS[pk.kind];
      const rows = Object.entries(pk.p || {}).map(([f, v]) => `<li>${esc(FIELD_WORDS[f] || f.toLowerCase().replace(/_/g, ' '))}: ${esc(f === 'SUBTYPE' ? typeWords(v) : v)}</li>`).join('');
      info.push(`<div class="card" style="margin-top:6px"><strong>${esc(k.label.replace(/^./, (c) => c.toUpperCase()))}</strong> <span class="dim">(${esc(pk.title)}, ${esc(pk.source)})</span>${rows ? `<ul>${rows}</ul><span class="dim">As the source records it; elevations and sizes are in its own units (Kent County's are feet and inches).</span>` : ''}</div>`);
    }
    if (L) {
      const lines = layerSummary(L, { lawn: lawnRingsOf(), mid: lawnMid() });
      info.push(`<ul>${lines.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`);
      info.push(`Tap a drain, a pipe or an area for its details. From ${L.sources.length ? esc(L.sources.join(', ')) : 'the national maps'}: the county's own storm sewer where it publishes one, and USGS water, the national wetlands inventory and FEMA flood zones everywhere; drawn as the sources place them.${L.failed?.length ? ` Not answering this time: ${esc(L.failed.join(', '))}.` : ''}${L.trimmed ? ' The farthest of the less useful pieces were left out to keep the map small.' : ''}`);
    } else info.push(view.layersError ? `Not here: ${esc(view.layersError)}.` : 'Asking the county and the national maps for drains and water here…');
  } else if (mapView === 'slope') {
    SLOPE_STEPS.forEach(([, c], k) => { if (c[3]) items.push(key(`rgb(${c[0]},${c[1]},${c[2]})`, SLOPE_WORDS[k])); });
    items.push(key('#e53935', 'beside the house: falls toward it'), key('#ffb300', 'falls away, but under 6 in over 10 ft'), key('#43a047', 'falls away 6 in or more over 10 ft (the building code)'));
    info.push(`How steep the ground is, from the lidar (ground flatter than 2% is left clear). On a slope water runs off before it soaks in: the plan waters it in shorter runs. The strip along the house is its fall over the first few feet.`);
  } else if (mapView === 'wind') {
    const wi = view.plan?.windInfo;
    if (view.plan?.windJuly) {
      WIND_STEPS.forEach(([, c], k) => items.push(key(`rgb(${c[0]},${c[1]},${c[2]})`, WIND_WORDS[k])));
      info.push(`The wind at each spot of the lawn in July, as a share of the open wind at the airport: from the houses, trees${wi?.fences ? ', fences' : ''} and hedges upwind of it, out to 150 m, each direction as often as the month's daytime wind blows from it${wi?.rose ? '' : ' (no station answered: every direction alike)'}, the trees in leaf. A calm spot dries more slowly, so it is planned to use less water. The lawn as a whole is held to what was measured in yards like it (${Math.round((wi?.yard || 0) * 100)}% of the open wind, with ${Math.round((wi?.cover || 0) * 100)}% of the ground within 90 m under roofs and trees).`);
    } else info.push('The wind at each spot is worked out once the shade is in (it needs the trees and roofs round the lawn).');
  } else if (mapView === 'sprinklers') {
    const z = heads.summary();
    if (z) items.push(...z.map((v) => `<span><i style="background:${v.color}"></i>zone ${v.n}</span>`));
    if ($('#show-coverage').checked) items.push(key('#d32f2f', 'no water'), key('#f57c00', 'under 60% of the average (dry)'), key('#1565c0', 'over 150%'));
    info.push(heads.data?.done && !heads.data?.none ? ($('#show-coverage').checked ? 'Each zone run long enough to put down its average depth, all the zones together.' : 'Where each head throws. <em>Your sprinklers</em> changes them.') : 'No sprinklers mapped yet: <em>Your sprinklers</em> adds them.');
  }
  $('#legend').innerHTML = [...items, ...base].join('');
  $('#view-info').innerHTML = info.join('');
  $('#sprinkler-sub').hidden = mapView !== 'sprinklers';
}

/* THE SOIL, IN A FEW WORDS (owner, 2026-10-23: "give a brief description of the soil characteristics in the info
   panel"): for each of the survey's soils on the map, its colour, its texture, how much water it holds where the
   roots are, how fast water soaks in, its drainage and its runoff group, and what that means for watering. */
const HYD = { A: 'sheds little rain (sandy, water soaks in fast)', B: 'sheds some rain in a storm', C: 'sheds a fair share of a storm (water soaks in slowly)', D: 'sheds most of a storm (clay, or a high water table)' };
function soilInfo(p) {
  if (!p?.soil?.length) return 'The soil survey is still being read.';
  const counts = new Map();
  if (p.soilAt) for (let i = 0; i < p.soilAt.length; i++) if (p.kinds[i] === 1) counts.set(p.soilAt[i], (counts.get(p.soilAt[i]) || 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const rows = p.soil.map((u, k) => {
    const share = counts.get(k) || 0;
    if (p.soil.length > 1 && !share) return null;
    const top = u.layers?.[0], texture = top ? String(top.texture).toLowerCase() : null;
    const taw = (p.topsoil ? u.tawTopsoilMm : u.tawMm) ?? null, holds = taw !== null ? taw / 25.4 : null;
    const holdWord = holds === null ? '' : holds < 0.8 ? 'holds little water' : holds < 1.4 ? 'holds an average amount of water' : 'holds a lot of water';
    const intake = u.intakeInH, inWord = !Number.isFinite(intake) ? '' : intake < 0.2 ? `takes water in slowly (about ${intake.toFixed(2)} in an hour)` : intake < 1 ? `takes water in at a moderate pace (about ${intake.toFixed(1)} in an hour)` : `takes water in fast (about ${intake.toFixed(1)} in an hour)`;
    const wet = (u.wetByMonth || []).map((v, m) => (v !== null && v !== undefined ? [m, v] : null)).filter(Boolean);
    const table = wet.length ? ` Its water table comes within about ${Math.round(Math.min(...wet.map((x) => x[1])) / 2.54)} in of the surface in ${wet.map((x) => MONTH[x[0]].slice(0, 3)).join(', ')}.` : '';
    const means = [];
    if (holds !== null && holds < 0.8) means.push('water it more often, a little at a time');
    else if (holds !== null && holds >= 1.4) means.push('it can go longer between waterings');
    if (Number.isFinite(intake) && intake < 0.3) means.push('water in short runs with a soak between, or it runs off');
    const pctLawn = p.soil.length > 1 ? ` (${Math.round((share / total) * 100)}% of the lawn)` : '';
    return `<li><span class="chip" style="background:rgb(${SOIL_RGB[k % SOIL_RGB.length].join(',')})"></span><strong>${esc(u.name || 'unnamed')}</strong>${pctLawn}: ${[texture ? `${texture} on top` : null, holdWord ? `${holdWord} in the top ${Math.round(p.rootIn || 8)} in (about ${holds.toFixed(1)} in)` : null, inWord || null, u.drainage ? String(u.drainage).toLowerCase() : null, u.hydgrp ? HYD[String(u.hydgrp)[0]] || null : null].filter(Boolean).join('; ')}.${table}${means.length ? ` For watering: ${means.join(', and ')}.` : ''}</li>`;
  }).filter(Boolean);
  return `<ul>${rows.join('')}</ul><span>From the USDA soil survey (NRCS): the soil is mapped in patches tens of yards across, so a line between two soils is approximate.${p.topsoil ? ' With your 4 in of loamy topsoil on the lawn.' : ''}</span>`;
}

document.querySelectorAll('.views [data-view]').forEach((b) => b.addEventListener('click', () => {
  mapView = b.dataset.view;
  document.querySelectorAll('.views [data-view]').forEach((x) => x.classList.toggle('on', x === b));
  legend(); draw();
}));
document.querySelectorAll('[name=sprview]').forEach((r) => r.addEventListener('change', () => { legend(); draw(); }));

if (mapId) guarded(async () => { status('Opening your map…'); await run(await siteFromMap(mapId)); });
