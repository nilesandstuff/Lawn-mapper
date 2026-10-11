/**
 * /shade.html: THE PROPERTY IN 3D, FROM LIDAR, LINED UP (shade map, step 1).
 *
 * For one property -- a saved map, or a point -- this:
 *   1. finds the newest public point cloud flown over it (/api/shade/lidar,
 *      worker/src/shade.js);
 *   2. reads every point within 50 m of the property line, because a tree on
 *      the neighbour's lot shades this one: a 20 m tree at 42 deg N throws a
 *      45 m shadow at winter noon (shade/ept.js, shade/laz.js);
 *   3. moves it from NAD83 to the web map's datum by the published
 *      transformation (shade/datum.js), then MEASURES what is left against
 *      the Mapbox photo the lawn was traced on (shade/align.js), and applies
 *      that too only when the measurement is tight enough to trust;
 *   4. draws it in 3D on that same map with the property line and the lawn,
 *      so any misfit is in plain sight (shade/view3d.js).
 *
 * Nothing is saved and nothing costs money. Everything it found is printed
 * under the map, including what it could not measure.
 */

import { pointsIn, toMerc, fromMerc, mercScale } from './shade/ept.js';
import { lazDecoder, browserFactory } from './shade/laz.js';
import { nad83Correction } from './shade/datum.js';
import { alignToPhoto } from './shade/align.js';
import { gridOver, gridForFrame, gridBox, rasterise, fillGaps, greyPicture, blurNaN, resample, cellOf, quantile } from './shade/grid.js';
import { pointLayer } from './shade/view3d.js';
import { frameCorners } from './lib/mercator.js';

const $ = (s) => document.querySelector(s);
const SAVES_KEY = 'lawnmapper.saves.v1'; // the editor's own local store (app.js), read only
const MARGIN_M = 50;
const ALIGN_M = 140; // the photo frame the match runs on, at least this wide

const view = { map: null, site: null, built: null };

function status(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

/* ------------------------------------------------------------ the sites */

function localSaves() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVES_KEY) || 'null');
    return Array.isArray(raw?.saves) ? raw.saves : [];
  } catch { return []; }
}

async function accountSaves() {
  try {
    const res = await fetch('/api/maps', { credentials: 'same-origin' });
    if (!res.ok) return [];
    return (await res.json()).maps || [];
  } catch { return []; }
}

async function listSaves() {
  const seen = new Set();
  const all = [...localSaves(), ...(await accountSaves())].filter((s) => {
    if (!s || !Number.isFinite(s.lng) || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  const sel = $('#saved');
  for (const s of all) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.address || `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`}${s.squareFeet ? ` — ${Math.round(s.squareFeet).toLocaleString()} sq ft` : ''}`;
    sel.append(o);
  }
  return all;
}

const asFeature = (p) => (p?.type === 'Feature' ? p : p?.type ? { type: 'Feature', properties: {}, geometry: p } : null);

function siteFromSave(s) {
  return {
    label: s.address || 'Saved map', lng: s.lng, lat: s.lat,
    parcel: asFeature(s.parcel),
    lawn: (s.shapes || []).map(asFeature).filter(Boolean),
  };
}

async function siteFromPoint(lat, lng) {
  let parcel = null;
  try {
    const res = await fetch(`/api/parcel?lng=${lng}&lat=${lat}`);
    if (res.ok) parcel = (await res.json()).parcel || null;
  } catch { /* no parcel: a box round the point will do */ }
  return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lng, lat, parcel, lawn: [] };
}

/** [w, s, e, n] in degrees of everything we know about the site. */
function siteBounds(site) {
  const pts = [];
  const add = (g) => {
    if (!g) return;
    const walk = (c) => (typeof c[0] === 'number' ? pts.push(c) : c.forEach(walk));
    walk(g.coordinates);
  };
  add(site.parcel?.geometry);
  site.lawn.forEach((f) => add(f.geometry));
  if (!pts.length) {
    const d = 15 / 111320;
    return [site.lng - d / Math.cos(site.lat * Math.PI / 180), site.lat - d, site.lng + d / Math.cos(site.lat * Math.PI / 180), site.lat + d];
  }
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

/* ------------------------------------------------------------- the map */

let mapPromise = null;
function ensureMap() {
  if (!mapPromise) mapPromise = makeMap().catch((e) => { mapPromise = null; throw e; });
  return mapPromise;
}

async function makeMap() {
  const cfg = await (await fetch('/api/config')).json();
  mapboxgl.accessToken = cfg.mapboxToken;
  const map = new mapboxgl.Map({
    container: 'map', style: 'mapbox://styles/mapbox/satellite-v9', projection: 'mercator',
    center: [-95, 39], zoom: 3, antialias: true, maxPitch: 75,
  });
  /* A refused token or a dead style must say so, not leave Build waiting. */
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the map did not load in 30 s')), 30000);
    map.once('load', () => { clearTimeout(timer); resolve(); });
    map.once('error', (e) => { if (!map.loaded()) { clearTimeout(timer); reject(new Error(e?.error?.message || 'the map would not load')); } });
  });
  view.map = map;
  return map;
}

function setGeo(map, id, features, paint) {
  const data = { type: 'FeatureCollection', features };
  if (map.getSource(id)) map.getSource(id).setData(data);
  else {
    map.addSource(id, { type: 'geojson', data });
    map.addLayer({ id, type: 'line', source: id, paint });
  }
}

/* -------------------------------------------------------------- loading */

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function getBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.arrayBuffer();
}

const io = { getJson, getBytes, decompress: lazDecoder(() => browserFactory()) };

/** The Mapbox photo of a frame, as RGBA pixels. Same origin, so readable. */
async function photoOf(frame) {
  const q = new URLSearchParams({ lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, height: frame.height, provider: 'mapbox' });
  const res = await fetch(`/api/imagery?${q}`);
  if (!res.ok) throw new Error(`the photo would not load (${res.status})`);
  const bmp = await createImageBitmap(await res.blob());
  const c = document.createElement('canvas'); // not OffscreenCanvas: older iPhones lack it
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  return { data: d.data, width: d.width, height: d.height };
}

/** A square frame centred on the site, at least ALIGN_M and the lot wide, at a whole-ish zoom. */
function alignFrame(site, bounds) {
  const k = mercScale(site.lat);
  const [x0, y0] = toMerc([bounds[0], bounds[1]]), [x1, y1] = toMerc([bounds[2], bounds[3]]);
  const spanM = Math.max(ALIGN_M, (Math.max(x1 - x0, y1 - y0) * k) + 20);
  const mPerPxZ0 = (2 * Math.PI * 6378137 * k) / 512;
  const zoom = Math.max(15, Math.min(19, Math.floor(Math.log2((1280 * mPerPxZ0) / spanM) * 100) / 100));
  const [lng, lat] = fromMerc([(x0 + x1) / 2, (y0 + y1) / 2]);
  return { lng, lat, zoom, size: 1280, height: 1280 };
}

/* ---------------------------------------------------------------- build */

async function build(site) {
  const map = await ensureMap();
  view.site = site;
  removeBuilt(map);
  const bounds = siteBounds(site);
  setGeo(map, 'parcel', site.parcel ? [site.parcel] : [], { 'line-color': '#ffeb3b', 'line-width': 2.5 });
  setGeo(map, 'lawn', site.lawn, { 'line-color': '#69f0ae', 'line-width': 2.5 });
  map.fitBounds(bounds, { padding: 40, duration: 0 });

  const k = mercScale(site.lat);
  const report = [];

  status('Asking USGS which lidar was flown here…');
  const found = await getJson(`${location.origin}/api/shade/lidar?lng=${site.lng}&lat=${site.lat}`);
  if (!found || found.error) throw new Error(found?.error || 'the lidar index did not answer');
  const { clouds, notOnAws } = found;
  if (!found.wesm) report.push('<p class="warn">USGS\'s 3DEP index did not answer, so no cloud could be confirmed by name and flight dates are unknown.</p>');
  if (!clouds.length) {
    status('No public lidar over this point that this page can read.', 'bad');
    $('#report').innerHTML = notOnAws.length
      ? `<p>USGS lists ${notOnAws.length} collection(s) here that are not in the public cloud store: ${notOnAws.map((u) => esc(u.workunit)).join(', ')}.</p>` : '';
    return;
  }

  /* The box: the lot plus the margin, and at least the photo frame. */
  const frame = alignFrame(site, bounds);
  const fBox = gridBox(gridForFrame(frame, 1, 1));
  const [lx0, ly0] = toMerc([bounds[0], bounds[1]]), [lx1, ly1] = toMerc([bounds[2], bounds[3]]);
  const m = MARGIN_M / k;
  const box = [Math.min(lx0 - m, fBox[0]), Math.min(ly0 - m, fBox[1]), Math.max(lx1 + m, fBox[2]), Math.max(ly1 + m, fBox[3])];

  let cloud = null, cols = null;
  for (const c of clouds.slice(0, 3)) {
    status(`Reading ${c.name}…`);
    try {
      const got = await pointsIn(c.url, box, io, { progress: (d, t) => status(`Reading ${c.name}: ${d} of ${t} pieces…`) });
      if (got.cols.n > 500) { cloud = c; cols = got.cols; break; }
      report.push(`<p class="warn">${esc(c.name)} has no points here; tried the next.</p>`);
    } catch (e) {
      report.push(`<p class="warn">${esc(c.name)} could not be read (${esc(e.message)}); tried the next.</p>`);
    }
  }
  if (!cols) { status('None of the clouds over this point had points here.', 'bad'); $('#report').innerHTML = report.join(''); return; }

  /* Density over the lot itself. */
  let inLot = 0;
  for (let i = 0; i < cols.n; i++) if (cols.x[i] >= lx0 && cols.x[i] <= lx1 && cols.y[i] >= ly0 && cols.y[i] <= ly1) inLot++;
  const lotM2 = Math.max(1, (lx1 - lx0) * (ly1 - ly0) * k * k);

  status('Moving it onto the map\'s datum, then checking against the photo…');
  const datum = nad83Correction(site.lat, site.lng, cloud.epoch);
  const pre = [datum.east / k, datum.north / k];
  let fit = null;
  try {
    const photo = await photoOf(frame);
    await new Promise((r) => setTimeout(r, 0));
    fit = alignToPhoto(cols, frame, photo, { pre });
  } catch (e) {
    report.push(`<p class="bad">The photo check could not run: ${esc(e.message)}</p>`);
  }
  const residual = fit?.confident ? fit.shift : [0, 0];
  const shift = [pre[0] + residual[0], pre[1] + residual[1]];

  /* Ground under every point, for heights, on a 1 m grid. */
  const g = gridOver(box, 1, site.lat);
  const r = rasterise(cols, g, { shift });
  const ground = fillGaps(r.zGround, g.w, g.h, 30);
  const heightOver = (i) => {
    const c = cellOf(g, cols.x[i], cols.y[i], shift);
    const z0 = c < 0 ? NaN : ground[c];
    return Number.isFinite(z0) ? cols.z[i] - z0 : 0;
  };
  const baseZ = quantile(ground, 0.5);

  view.built = { cols, shift, pre, heightOver, baseZ, frame, fit };
  drawBuilt(map, true);
  $('#toggles').hidden = false;
  map.easeTo({ pitch: 55, bearing: -20, duration: 800 });

  /* The report. */
  const u = cloud.unit;
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '?');
  report.unshift(`
    <h2>The lidar</h2>
    <table>
      <tr><td>Cloud</td><td>${esc(cloud.name)}${cloud.confirmed ? '' : ' <span class="warn">(box match only: USGS did not confirm it flew this point)</span>'}</td></tr>
      ${u ? `<tr><td>Flown</td><td>${day(u.start)} to ${day(u.end)}, ${esc(u.ql || '?')}, ${u.season === 'off' ? '<span class="warn">leaf-off</span>' : u.season === 'on' ? 'leaf-on' : u.season === 'mixed' ? '<span class="warn">part leaf-off</span>' : 'season unknown'}</td></tr>` : ''}
      <tr><td>Points</td><td>${cols.n.toLocaleString()} within ${MARGIN_M} m of the lot; ${(inLot / lotM2).toFixed(1)} a square metre over the lot</td></tr>
      ${notOnAws.length ? `<tr><td>Also flown</td><td class="warn">${notOnAws.map((x) => `${esc(x.workunit)} (${day(x.end)}, ${esc(x.ql || '?')})`).join('; ')} — not in the public cloud store, so not read</td></tr>` : ''}
    </table>
    <h2>Lining it up</h2>
    <table>
      <tr><td>Datum (NAD83 → map)</td><td>${fmtMove(datum.east, datum.north)} <span class="dim">computed, epoch ${cloud.epoch.toFixed(1)}</span></td></tr>
      <tr><td>Left over, measured</td><td>${fit ? `${fmtMove(fit.east, fit.north)} <span class="${fit.confident ? 'ok' : 'warn'}">${esc(fit.why)}</span>` : '<span class="bad">not measured</span>'}</td></tr>
      ${fit ? `<tr><td>Quarters alone</td><td class="dim">${fit.quarters.map((q) => (q ? fmtMove(q.east, q.north) : '—')).join(' · ')}</td></tr>` : ''}
      ${fit ? `<tr><td>Open ground that voted</td><td class="dim">${Math.round(fit.openShare * 100)}% of a ${Math.round(gridForFrame(frame, 1, 1).cell * k)} m frame; match ${fit.score?.toFixed(2)} against ${fit.second?.toFixed(2)} for the best rival</td></tr>` : ''}
      <tr><td><b>Applied</b></td><td><b>${fmtMove(datum.east + (fit?.confident ? fit.east : 0), datum.north + (fit?.confident ? fit.north : 0))}</b> ${fit?.confident ? '<span class="ok">datum + measured</span>' : '<span class="warn">datum only</span>'}</td></tr>
    </table>
    <p class="dim">Roofs and crowns will NOT sit exactly on the photo's: the photo was taken at an angle, so tall
    things lean in it by up to a metre or two (DETECTOR-FINDINGS H63), and the laser measures them where they stand.
    The ground is what has to agree. "Lined up" off shows the cloud where the file puts it. "Lidar ground picture" lays the laser's view of the ground over the photo to compare by eye: roads, drives and paths should sit exactly on the photo's.</p>`);
  $('#report').innerHTML = report.join('');
  status(fit?.confident ? 'Built and lined up.' : 'Built. The photo check was not tight enough to apply; the datum correction is applied.', fit?.confident ? 'ok' : 'warn');
}

const fmtMove = (e, n) => (e === null || n === null ? '—'
  : `${Math.abs(e).toFixed(2)} m ${e >= 0 ? 'E' : 'W'}, ${Math.abs(n).toFixed(2)} m ${n >= 0 ? 'N' : 'S'}`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function removeBuilt(map) {
  for (const id of ['points', 'picture']) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
}

/** (Re)draw the points and the ground picture, lined up or as filed. */
function drawBuilt(map, fixed) {
  const b = view.built;
  if (!b) return;
  removeBuilt(map);
  const shift = fixed ? b.shift : [0, 0];
  if ($('#t-picture').getAttribute('aria-pressed') === 'true') {
    /* The laser's own picture of the ground, at 0.3 m, where it now sits. */
    const fr = b.frame, k = mercScale(fr.lat);
    const wM = gridForFrame(fr, 1, 1).cell * k;
    const gw = Math.round(wM / 0.5), g = gridForFrame(fr, gw, gw);
    const r = rasterise(b.cols, g, { shift });
    const W = Math.round(wM / 0.3);
    const pic = greyPicture(resample(blurNaN(fillGaps(r.iLow, gw, gw, 2), gw, gw, 0.7), gw, gw, W, W), W, W);
    const c = document.createElement('canvas');
    c.width = W; c.height = W;
    c.getContext('2d').putImageData(new ImageData(pic.data, W, W), 0, 0);
    map.addSource('picture', { type: 'image', url: c.toDataURL(), coordinates: frameCorners(fr) });
    map.addLayer({ id: 'picture', type: 'raster', source: 'picture', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, 'parcel');
  }
  if ($('#t-points').getAttribute('aria-pressed') === 'true') {
    map.addLayer(pointLayer('points', b.cols, { heightOver: b.heightOver, shift, baseZ: b.baseZ, lat: view.site.lat, size: 3 }));
  }
}

function toggle(id, on) {
  const el = $(id);
  const next = on ?? el.getAttribute('aria-pressed') !== 'true';
  el.setAttribute('aria-pressed', String(next));
  return next;
}

/* --------------------------------------------------------------- wiring */

async function main() {
  const saves = await listSaves();
  const params = new URLSearchParams(location.search);
  const go = async () => {
    $('#go').disabled = true;
    try {
      const id = $('#saved').value;
      const at = $('#at').value.trim();
      let site = null;
      if (id) site = siteFromSave(saves.find((s) => s.id === id));
      else if (at) {
        const [lat, lng] = at.split(/[ ,]+/).map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Type a point as "lat, lng".');
        site = await siteFromPoint(lat, lng);
      } else throw new Error('Pick a saved map or type a point first.');
      history.replaceState(null, '', id ? `?map=${encodeURIComponent(id)}` : `?at=${encodeURIComponent(at)}`);
      await build(site);
    } catch (e) {
      status(e.message || String(e), 'bad');
    } finally {
      $('#go').disabled = false;
    }
  };
  $('#go').addEventListener('click', go);
  $('#t-points').addEventListener('click', () => { toggle('#t-points'); drawBuilt(view.map, $('#t-fix').getAttribute('aria-pressed') === 'true'); });
  $('#t-fix').addEventListener('click', () => drawBuilt(view.map, toggle('#t-fix')));
  $('#t-picture').addEventListener('click', () => { toggle('#t-picture'); drawBuilt(view.map, $('#t-fix').getAttribute('aria-pressed') === 'true'); });
  $('#t-tilt').addEventListener('click', () => {
    const on = toggle('#t-tilt');
    view.map?.easeTo(on ? { pitch: 55, bearing: -20 } : { pitch: 0, bearing: 0 });
  });
  if (params.get('map')) { $('#saved').value = params.get('map'); if ($('#saved').value) go(); }
  else if (params.get('at')) { $('#at').value = params.get('at'); go(); }
  ensureMap().catch((e) => status(`The map would not load: ${e.message}`, 'bad'));
}

main();
