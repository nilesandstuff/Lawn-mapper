/**
 * water.<home domain>: THE LOW-SPOT MAP FOR ONE PROPERTY (water session).
 *
 * Finding the property is the shade map's way (public/shade.js
 * siteFromAddress / siteFromPoint, features session), through this site's
 * Worker: the address search, the pick when there are several, the county's
 * property line, a photo of the frame. The lidar is read and the map worked
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

const $ = (s) => document.querySelector(s);
const R = 6378137;
const view = { photo: null, data: null, frame: null, site: null, plan: null };
const inputs = { downspouts: [], gutters: [], areas: [], topsoil: false, grass: 'cool', texture: '' };
let mode = null, pending = null; // 'from' | 'to' (a downspout) | 'gutter' | 'area'
const added = []; // what was entered, in order, for Undo: 'spout' | 'gutter' | 'area'
const AREA_COLOR = { deck: '#a1887f', pavers: '#bf360c', solid: '#212121', roof: '#fafafa', lawn: '#69f0ae', bed: '#6d4c41' };
const ZONE_RGB = [[46, 134, 222], [230, 126, 34], [142, 68, 173], [22, 160, 133]];
const HOME = document.documentElement.dataset.home || '';
const mapId = new URLSearchParams(location.search).get('map');

function status(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

/* ------------------------------------------------- finding the property */

async function pickAddress(q) {
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
  const j = res.ok ? await res.json() : null;
  if (!res.ok) throw new Error(j?.error || `The address lookup failed (${res.status}).`);
  const results = j?.results || [];
  if (!results.length) throw new Error("That address wasn't found. Try adding the city and state.");
  if (results.length === 1) return results[0];
  const box = $('#candidates');
  box.replaceChildren();
  status('Which one?');
  return new Promise((resolve) => {
    for (const r of results) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.label;
      b.onclick = () => { box.hidden = true; resolve(r); };
      box.append(b);
    }
    box.hidden = false;
  });
}

const asFeature = (p) => (p?.type === 'Feature' ? p : p?.type ? { type: 'Feature', properties: {}, geometry: p } : null);

async function parcelAt(where) {
  try {
    const res = await fetch(`/api/parcel?${new URLSearchParams(where)}`);
    return res.ok ? asFeature((await res.json()).parcel) : null;
  } catch { return null; }
}

async function siteFromAddress(r) {
  const where = { lng: r.lng, lat: r.lat };
  if (r.county) where.county = r.county;
  if (r.state) where.state = r.state;
  if (r.parcelPin) where.pin = r.parcelPin;
  if (r.parcelSqFt) where.sqft = r.parcelSqFt;
  return { label: r.label, lng: r.lng, lat: r.lat, parcel: await parcelAt(where), lawn: [] };
}

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
    mapId: id, at: s.at || null,
    // the photo the lawn was traced on (owner 2026-10-19: a county photo if one was saved, Mapbox if Mapbox)
    tracedOn: tracedOn(s),
    water: s.tools?.water?.data || null,
  };
}

async function siteFromPoint(lat, lng) {
  return { label: 'Where you are', lng, lat, parcel: await parcelAt({ lng, lat }), lawn: [] };
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

function overlay(d, { flow = true, grade = true, hard = true, zones = true } = {}) {
  const { W, H } = d.grid;
  const img = new ImageData(W, H);
  const px = img.data;
  const p = view.plan;
  for (let i = 0; i < W * H; i++) {
    let rgba = null;
    // roofs white, paving black (owner 2026-10-19); the plan's own reading once it is in, the person's marks included
    const kind = p?.kinds ? p.kinds[i] : d.wall[i] ? 2 : hard && d.paved && Number.isFinite(d.paved[i]) && d.paved[i] >= 0.5 ? 3 : 0;
    if (kind === 2) rgba = [250, 250, 250, 170];
    if (hard && kind === 3) rgba = [12, 12, 12, 190];
    if (hard && kind === 4) rgba = [150, 60, 30, 170]; // a brick or paver patio
    if (p && view.need && Number.isFinite(p.needMm[i])) {
      // each square metre's own need in the thirstiest month, light (little) to dark (much)
      const t = Math.max(0, Math.min(1, (p.needMm[i] - view.need.lo) / Math.max(1, view.need.hi - view.need.lo)));
      rgba = [Math.round(227 - 214 * t), Math.round(242 - 171 * t), Math.round(253 - 92 * t), 200];
    } else if (zones && p && p.zoneOf[i] >= 0) {
      rgba = [...ZONE_RGB[p.zoneOf[i] % ZONE_RGB.length], 105];
      if (p.wetAnyway[i] >= 0.1) rgba = [13, 71, 161, 200];
      else if (p.wetFromWatering[i] >= 0.05) rgba = [255, 23, 68, 200];
      else if (p.dryShare[i] > 0.1) rgba = [255, 214, 0, 190];
    }
    if (d.reported[i] === 2) {
      const t = Math.min(1, d.depth[i] / 0.10);
      rgba = [30, 107, 255, Math.round(110 + 130 * t)];
    } else if (d.reported[i] === 1) rgba = [190, 200, 215, 110]; // not a lawn hollow: pavement, trees, a ditch...
    // runoff lines: weighted by what each surface sheds when the lawn is traced (m^2 of runoff-producing surface), plain area otherwise
    if (flow && !d.wall[i] && d.flow[i] >= (d.weighted ? 60 : 250)) rgba = [34, 211, 238, 220];
    if (grade && Number.isFinite(d.grade[i])) {
      const g = d.grade[i];
      rgba = g < -0.01 ? [229, 57, 53, 255] : g < 0.05 ? [255, 179, 0, 255] : [67, 160, 71, 255];
    }
    if (rgba) px.set(rgba, i * 4);
  }
  return img;
}

function draw() {
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
    const o = overlay(d, { flow: $('#show-flow').checked, grade: $('#show-grade').checked, hard: $('#show-hard').checked, zones: $('#show-zones').checked });
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
  const spouts = [...inputs.downspouts, ...(mode === 'to' && pending ? [{ from: pending, to: null }] : [])];
  for (const sp of spouts) {
    const [x0, y0] = at(sp.from);
    g.fillStyle = '#ff9100'; g.beginPath(); g.arc(x0, y0, lw * 1.6, 0, 7); g.fill();
    if (!sp.to) continue;
    const [x1, y1] = at(sp.to);
    g.strokeStyle = '#ff9100'; g.lineWidth = lw; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.strokeStyle = '#000'; g.lineWidth = lw * 0.6; g.fillStyle = '#00e5ff'; g.beginPath(); g.arc(x1, y1, lw * 2, 0, 7); g.fill(); g.stroke();
  }
  if ($('#show-heads')?.checked) heads.drawOn(g, lw);
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
  // building 50 (never: owner, 2026-10-21), under a tree 6 (roots: kept out), under paving 2 (a sleeve; they
  // go round when they can) -- the analysis's roofs, canopy and paving, sampled every half metre
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
      if (d.canopy && d.canopy[i]) worst = Math.max(worst, 6);
      else if (d.paved && d.paved[i] >= 0.5) worst = Math.max(worst, 2);
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
      return { building: !!d.wall[i], canopy: !!d.canopy?.[i], paved: !!(d.paved && d.paved[i] >= 0.5), lawn: d.lawnMask ? !!d.lawnMask[i] : true };
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
  showCoverage: () => !!$('#show-coverage')?.checked,
  // the traced lawn's outlines, as rings of [lng, lat] (the placing grid lines up with its longest edge)
  lawnRings: () => (view.site?.lawn || []).flatMap((f) => (f.geometry?.type === 'Polygon' ? f.geometry.coordinates : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.flat() : [])),
  // the traced lawn's corners, [[west, south], [east, north]]
  lawnBox: () => {
    const pts = (view.site?.lawn || []).flatMap((f) => (f.geometry?.type === 'Polygon' ? f.geometry.coordinates.flat() : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.flat(2) : []));
    if (!pts.length) return null;
    return [[Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))], [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]];
  },
  // what is on the ground at a point, for the arcs (lib/arcs.js): the traced lawn, a building or paving, other
  get groundAt() {
    const d = view.data;
    if (!d?.wall) return null;
    return (at) => {
      const g = d.grid, dx = d.shift.east / g.k, dy = d.shift.north / g.k, [x, y] = toMerc(at);
      const c = Math.floor(((x - (g.bbox[0] + dx)) * g.k) / g.cell), r = Math.floor(((g.bbox[3] + dy - y) * g.k) / g.cell);
      if (c < 0 || r < 0 || c >= g.W || r >= g.H) return null;
      const i = r * g.W + c;
      if (d.wall[i] || (d.paved && d.paved[i] >= 0.5)) return 'hard';
      if (d.lawnMask) return d.lawnMask[i] ? 'lawn' : 'other';
      return 'lawn';
    };
  },
  lawnMiddle: () => {
    const pts = (view.site?.lawn || []).flatMap((f) => (f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.flatMap((p) => p[0]) : []));
    if (!pts.length) return view.site ? [view.site.lng, view.site.lat] : null;
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  },
  changed: () => keep(),
  finish: () => { $('#result').classList.remove('heads-on'); draw(); headsCard(); if (view.data) report(view.data, view.site); if (view.plan) planReport(view.plan); },
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
    const items = hollows.slice(0, 8).map((p) => `<li>Likely holds water: at least ${inches(p.depthCm)} in deep, about ${sqft(lawnKnown ? p.onLawnM2 : p.areaM2)} sq ft${lawnKnown ? ' of lawn' : ''}, roughly ${gallons(p.volumeL)} gallons when full${p.againstBuilding ? ' — <strong>against a building</strong>' : ''}.</li>`);
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
  const legend = $('#zone-legend');
  legend.innerHTML = p.zones.map((z) => `${chip(z.zone)}zone ${z.zone + 1}`).join(' &nbsp; ');
  if (!p.zones.length) { $('#plan').innerHTML = '<div class="card"><h2>No lawn to plan for</h2><p class="dim">Trace the lawn in Lawn Mapper and open the map from your dashboard.</p></div>'; return; }
  const peak = (z) => z.months.reduce((a, b) => ((b.mmMonth || 0) > (a.mmMonth || 0) ? b : a), z.months[0]);
  if (p.trouble?.length) parts.push(`<div class="card" style="border-color:var(--warn)"><h2>Not everything answered this time</h2><ul>${p.trouble.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><p class="dim">Reload the page to try again; the plan below is worked out without it.</p></div>`);
  parts.push(`<div class="card"><h2>Your watering plan: ${p.zones.length} zone${p.zones.length > 1 ? 's' : ''}</h2>
    <p>Each zone below needs a different amount, or a different rhythm, to stay between too wet and too dry. Water a zone when it says, by about the depth it says; more is wasted below the roots, less leaves it short.</p>
    <p class="dim">Worked out day by day over ten years of this place's weather: rain and runoff in, the grass's use out, the soil's root zone in between. ${p.shaded ? ` Shade from trees and buildings is counted (the shade map's own light model; the lawn's middle gets about ${Math.round(p.sunShare * 100)}% of open-sky sunlight in summer).` : ' The lawn is taken as in full sun until the shade is worked out.'}${p.seasonDays ? ` The watering season is the shade map's growing season here for ${p.grass === 'warm' ? 'warm' : 'cool'}-season grass, about ${p.seasonDays} days.` : ''} Grass beside paving and sunny walls is counted as using a little more (up to 8% at the edge, an estimate from published measurements).${p.grass === 'warm' ? ' Warm-season grass is let dry a little further between waterings than cool-season.' : ''} These are likely amounts, until a soak test on your lawn confirms them. Depths are what to put down: about a quarter more than the grass uses, since sprinklers water unevenly and the driest spots must get enough (a typical home system, until your heads are mapped). Roots are taken to reach ${Math.round(p.rootIn || 8)} in, and a day's watering is at most two runs with a soak between, so on slow ground it comes more often, a little at a time.${p.standIn ? ' <strong>No lawn was traced, so this plans for all the open ground</strong>: open this from a Lawn Mapper map for your lawn alone.' : ''}</p></div>`);
  const week = p.thisWeek;
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
    if (z.tooWet > 0) problems.push(`About <strong>${sqft(z.tooWet)} sq ft</strong> gets too wet when the zone is watered as a whole: it also takes water from uphill, a roof or paving. Watering it less, or moving a downspout, would likely help.`);
    if (z.tooDry > 0) problems.push(`About <strong>${sqft(z.tooDry)} sq ft</strong> still dries out between waterings: it holds less, or loses more, than the rest.`);
    parts.push(`<div class="card"><h2>${chip(z.zone)}Zone ${z.zone + 1} · ${sqft(z.m2)} sq ft</h2>
      <p class="big">${pk.waterings ? `About ${inch(pk.mmEach)} in each time; in ${MONTH[pk.month]}, ${howOften(pk).replace(/ \(.*$/, '')}.` : 'Rain likely covers it in a typical year.'}</p>
      ${z.dryWeek ? `<p>In a ${MONTH[z.dryWeek.month]} week with no rain: about <strong>${inch(z.dryWeek.mm)} in</strong>, over ${z.dryWeek.waterings} watering${z.dryWeek.waterings > 1 ? 's' : ''}. Skip one for each ${inch(z.dryWeek.each)} in or so of rain.</p>` : ''}
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

/* ----------------------------------------------------------------- flow */

let running = null;

async function run(site) {
  running?.terminate();
  view.site = site; view.data = null; view.plan = null;
  zoom.s = 1; zoom.tx = 0; zoom.ty = 0; $('#view').style.transform = '';
  $('#result').hidden = true; $('#plan').innerHTML = ''; $('#hill').innerHTML = '';
  const kept = site.water || {};
  inputs.downspouts = Array.isArray(kept.downspouts) ? kept.downspouts : [];
  inputs.gutters = Array.isArray(kept.gutters) ? kept.gutters : [];
  inputs.areas = Array.isArray(kept.areas) ? kept.areas : [];
  added.length = 0;
  inputs.topsoil = !!kept.topsoil;
  inputs.grass = kept.grass === 'warm' ? 'warm' : 'cool';
  inputs.texture = ''; // the soil is the survey's (owner 2026-10-19: no override)
  $('#topsoil').checked = inputs.topsoil;
  $('#grass').value = inputs.grass;
  setMode(null);
  status(`Reading the survey for ${site.label}…`);
  const w = new Worker('/analyse.js', { type: 'module' });
  running = w;
  const first = new Promise((resolve, reject) => {
    w.onmessage = ({ data }) => {
      if (data.progress) status(`Reading the survey… ${data.progress.done} of ${data.progress.total} pieces`);
      else if (data.error) { w.terminate(); reject(new Error(data.error)); }
      else if (data.done) resolve(data.done);
      else if (data.planProgress) $('#saved').textContent = data.planProgress;
      else if (data.plan) { view.plan = data.plan; $('#saved').textContent = savedNote; if (!heads.active) planReport(data.plan); needScale(); draw(); }
      else if (data.planError) $('#saved').textContent = `The watering plan could not be worked out: ${data.planError}`;
      else if (data.hill) hillReport(data.hill);
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'the analysis stopped')); };
  });
  w.postMessage({ site, inputs: { ...inputs } });
  // the photo first, over the analysis box (lib/site.js boxFor; the shade map's own box when it has one),
  // so the sprinklers can be placed while the survey is read
  status('Fetching the photo…');
  const box = site.lidar?.box?.length === 4 ? site.lidar.box : boxFor(site);
  view.frame = frameFor(box, site.lat);
  const saved = await savedPhoto(view.frame, site);
  view.photo = saved.photo; view.photoShift = saved.shift; view.photoName = saved.name;
  if (!view.photo) { $('#show-photo').checked = false; view.photo = { width: 1280, height: 1280 }; view.photoName = 'no photo (it would not load)'; }
  $('#result').hidden = false;
  const asking = await heads.open(kept.irrigation);
  $('#result').classList.toggle('heads-on', asking);
  headsCard();
  draw();
  status(asking ? 'Reading the survey while you do this…' : `Reading the survey for ${site.label}…`);
  const d = await first;
  view.data = d;
  heads.refresh(); // the ground's heights and the buildings: the pressure model solves again with them
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
  return JSON.stringify({ data: { v: 1, downspouts: inputs.downspouts, gutters: inputs.gutters, areas: inputs.areas, topsoil: inputs.topsoil, grass: inputs.grass, irrigation: heads.data }, basedOn: view.site.at });
}
const saveUrl = () => `/api/maps/tool?id=${encodeURIComponent(view.site.mapId)}&tool=water`;

async function save() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dirty || !view.site?.mapId) return;
  if (saving) { await saving; return save(); } // one at a time: a change made meanwhile goes in the next
  dirty = false;
  const body = saveBody();
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
  if (!dirty || !view.site?.mapId) return;
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
$('#grass').addEventListener('change', () => { inputs.grass = $('#grass').value === 'warm' ? 'warm' : 'cool'; changed(); });

async function guarded(fn) {
  $('#go').disabled = true; $('#here').disabled = true;
  try { await fn(); } catch (e) { status(e.message || String(e), 'bad'); } finally { $('#go').disabled = false; $('#here').disabled = false; }
}

$('#find').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#address').value.trim();
  if (!q) return;
  guarded(async () => { status('Looking up the address…'); const r = await pickAddress(q); status('Finding the property line…'); await run(await siteFromAddress(r)); });
});

$('#here').addEventListener('click', () => guarded(async () => {
  status('Finding where you are…');
  const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, () => reject(new Error('Location was not shared.')), { enableHighAccuracy: true, timeout: 20000 }));
  await run(await siteFromPoint(pos.coords.latitude, pos.coords.longitude));
}));

for (const id of ['#show-flow', '#show-grade', '#show-photo', '#show-hard', '#show-zones', '#show-heads', '#show-coverage']) $(id).addEventListener('change', draw);
$('#edit-heads').addEventListener('click', async () => { setMode(null); if (await heads.open(heads.data, { force: true })) { $('#result').classList.add('heads-on'); draw(); $('#stage').scrollIntoView({ behavior: 'smooth' }); } });
/* The water-need layer (owner 2026-10-19: knock-on effects of every input, as on a real lawn): each square
   metre's own watering in the lawn's thirstiest month, scaled from the lawn's 5th to 95th percentile. */
function needScale() {
  const p = view.plan;
  if (!p || !$('#show-need').checked) { view.need = null; $('#need-legend').hidden = true; return; }
  const v = Array.from(p.needMm).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) { view.need = null; return; }
  view.need = { lo: v[Math.floor(v.length * 0.05)], hi: v[Math.floor(v.length * 0.95)] };
  $('#need-text').textContent = `${inch(view.need.lo)} to ${inch(view.need.hi)} in of watering in a typical ${MONTH[p.needMonth ?? 6]}, square by square`;
  $('#need-legend').hidden = false;
}
$('#show-need').addEventListener('change', () => { needScale(); draw(); });

if (mapId) guarded(async () => { status('Opening your map…'); await run(await siteFromMap(mapId)); });
