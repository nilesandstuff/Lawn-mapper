/**
 * /shade.html: THE PROPERTY IN 3D, FROM LIDAR, LINED UP (shade map, step 1).
 *
 * For one property -- a saved map, or a point -- this:
 *   1. finds the newest public point cloud flown over it (/api/shade/lidar,
 *      worker/src/shade.js);
 *   2. reads every point within 50 m of the property line, because a tree on
 *      the neighbor's lot shades this one: a 20 m tree at 42 deg N throws a
 *      45 m shadow at winter noon (shade/ept.js, shade/laz.js);
 *   3. moves it from NAD83 to the web map's datum by the published
 *      transformation (shade/datum.js), then MEASURES what is left against
 *      THE PHOTO THE LAWN WAS TRACED ON, as the editor showed it: the Mapbox
 *      photo, or the county photo the map was saved on, moved by the
 *      line-up it was saved with (owner, 2026-10-11: maps are saved on
 *      county photos too). Applied only when the measurement is tight
 *      enough to trust; the other photo is matched as a cross-check;
 *   4. draws it in 3D on that same map with the property line and the lawn,
 *      so any misfit is in plain sight (shade/view3d.js).
 *
 * Nothing is saved and nothing costs money. Everything it found is printed
 * under the map, including what it could not measure.
 *
 * IN STEPS (owner, 2026-10-15; shade/steps.js): 1 the property and its
 * line, 2 the trees as the model sees them (shade/trees-ui.js, with the
 * eraser), 3 the shade map (shade/sun-ui.js), 4 which grass
 * (shade/grass-ui.js). The lidar is read when step 2 opens; the light is
 * worked out when step 3 opens, without the columns erased in step 2. The
 * camera stays on a leash to the property (shade/leash.js).
 */

import { pointsIn, toMerc, fromMerc, mercScale } from './shade/ept.js';
import { flightOf } from './shade/find.js';
import { onePass } from './shade/passes.js';
import { lazDecoder, browserFactory } from './shade/laz.js';
import { nad83Correction } from './shade/datum.js';
import { alignToPhoto } from './shade/align.js';
import { gridOver, gridForFrame, gridBox, rasterise, fillGaps, greyPicture, blurNaN, resample, cellOf, quantile } from './shade/grid.js';
import { groundOf } from './shade/ground.js';
import { pointLayer, groundLayer } from './shade/view3d.js';
import { frameCorners } from './lib/mercator.js';
import { movedCorners } from './lib/align.js';
import { tracedOn, lineUpAt } from './shade/traced.js';
import { startSun } from './shade/sun-ui.js';
import { track, reportError, watchErrors, setPlace } from './shade/usage.js';
import { traceLot, lotFeature, lotParam, parseLot, lotProblem } from './shade/trace.js';
import { startSteps } from './shade/steps.js';
import { leash } from './shade/leash.js';
import { startTrees } from './shade/trees-ui.js';
import { cleanFences, fenceRecord } from './shade/fences.js';
import { drawFenceLine, askFence, showFences, fenceWords } from './shade/fence-ui.js';
import { renderGrass } from './shade/grass-ui.js';
import { ringAreaSqM, SQM_PER_SQFT } from './lib/area.js';

const $ = (s) => document.querySelector(s);
const MARGIN_M = 50;
/** /shade-trees: the same page, drawing the trees instead of the light. */
const TREES = typeof document !== 'undefined' && document.body?.dataset.mode === 'trees';
/** /shade in steps (shade/steps.js): property, trees, shade, grass. The trees page has no steps. */
const STEPPED = typeof document !== 'undefined' && !!document.querySelector('#steps');
const ALIGN_M = 140; // the photo frame the match runs on, at least this wide
/* The camera's leash (shade/leash.js): over the ground no further than this from the line, no higher than this. */
const LEASH_M = 500, LEASH_ALT_M = 2000;
/** The home domain the dashboard lives on (lawnmap.X -> X); none on workers.dev or a local host. */
const HOME = (() => { const h = typeof location !== 'undefined' ? location.hostname : ''; return /workers\.dev$|localhost|^[\d.]+$|^$/.test(h) ? null : h.split('.').slice(-2).join('.'); })();

const view = { map: null, site: null, built: null, steps: null, trees: null, model: null, builtFor: null, sun: null, sunFor: null, eraseVersion: 0, sunVersion: 0, unleash: null };

function status(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${cls}`;
  /* Every message shown as a failure is one a visitor saw (shade/usage.js). */
  if (cls === 'bad' && !/^No public lidar/.test(text)) reportError('status', text); // no lidar is an answer, counted as usage
}

/* ------------------------------------------------------------ the sites */

/*
 * ONE MAP, EVERY TOOL (docs/MAPS.md, 2026-10-16): every map lives on the
 * server, a guest's one included, and the shade map keeps ITS OWN PART of
 * it -- the traced property line when the county had none, the erased tree
 * cells, and the settings -- under tools.shade. Nothing is read from the
 * browser's old local store any more.
 */
async function listSaves() {
  let all = [];
  try {
    const res = await fetch('/api/maps', { credentials: 'same-origin' });
    if (res.ok) all = ((await res.json()).maps || []).filter((s) => s && Number.isFinite(s.lng));
  } catch { all = []; }
  const sel = $('#saved');
  for (const s of all) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.address || `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`}${s.squareFeet ? ` — ${Math.round(s.squareFeet).toLocaleString()} sq ft` : ''}`;
    sel.append(o);
  }
  return all;
}

/** One map with every tool's part, or null when it is not this visitor's. */
async function openMap(id) {
  const res = await fetch(`/api/maps/one?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The map could not be read (${res.status}).`);
  return (await res.json()).map || null;
}

/**
 * A map started here, from the address typed: the server answers its id,
 * or 409 for a guest's second map (the message says to sign in; the map
 * they have is kept). Returns { id, at } or null.
 */
async function newMap(site, label) {
  const body = { address: label, lng: site.lng, lat: site.lat, source: 'shade', county: site.county || null, parcel: site.parcel && !site.parcel.properties?.traced ? site.parcel : null };
  let res, out = {};
  try {
    res = await fetch('/api/maps/new', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    out = await res.json().catch(() => ({}));
  } catch { track('map', 'new failed: offline'); return null; }
  if (res.status === 409 && out.error === 'guest-limit') {
    const link = HOME ? ` <a href="https://${HOME}/dashboard">Your maps</a>` : '';
    site.limitNote = `<p class="warn">${esc(out.message || 'Sign in to keep more than one map.')}${link}</p>`; // shown under the property line (offerLot writes that note first)
    track('map', 'guest limit');
    return null;
  }
  if (!res.ok || !out.id) { track('map', `new failed ${res.status}`); return null; }
  track('map', 'started here');
  return { id: out.id, at: out.at || null };
}

/** The shade map's part of a map, as kept on the server (at most 64 KB). */
function shadePart() {
  const site = view.site;
  if (!site) return null;
  const traced = site.parcel?.properties?.traced ? site.parcel.geometry.coordinates[0].slice(0, -1) : null;
  const grid = view.model ? gridOver(view.model.box, 1, site.lat) : null;
  const shown = view.sun?.view?.() || {};
  const data = {
    v: 3,
    lot: traced,
    /* The fences drawn in step 1 (fences.js records: line, heightM, style,
       material, color, and their light, wind and surface numbers, which the
       water map reads for its wind and heat). */
    fences: view.fences || [],
    erased: view.trees?.erasedCells() || [],
    cubes: view.trees?.erasedCubes() || [],
    grid: grid ? { w: grid.w, h: grid.h, x0: Math.round(grid.x0 * 100) / 100, y1: Math.round(grid.y1 * 100) / 100, nz: view.trees?.nz || null } : null,
    /* The cloud read and its line-up, so the next visit reads the same one and skips the photo match. */
    lidar: view.model?.lidar || null,
    settings: { grass: $('#grass')?.value || null, what: shown.what || null, when: shown.when || null, date: $('#sun-date')?.value || null, step: view.steps?.current || 1 },
    at: new Date().toISOString(),
  };
  if (JSON.stringify(data).length > 60000) { data.cubes = []; data.cubesDropped = true; }
  if (JSON.stringify(data).length > 60000) { data.erased = []; data.erasedDropped = true; }
  return data;
}

/** Keep the part, settled for a second like a save; dropped quietly on failure (a convenience, not the measurement). Writing it is what marks the shade map done on the dashboard. */
let partTimer = null;
function saveShadePart({ now = false } = {}) {
  const site = view.site;
  if (!site?.map?.id) return;
  clearTimeout(partTimer);
  partTimer = setTimeout(async () => {
    const data = shadePart();
    if (!data) return;
    try {
      const res = await fetch(`/api/maps/tool?id=${encodeURIComponent(site.map.id)}&tool=shade`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, basedOn: site.map.at || null }) });
      if (res.ok) { site.map.shade = data; backLink(); } else track('map', `part refused ${res.status}`);
    } catch { /* offline: the next change tries again */ }
  }, now ? 0 : 1000);
}

/** Do the erased cells kept on the server belong to this model's grid (the lot and the lidar unchanged)? */
function partFitsGrid(part) {
  if (!part?.grid || !view.model) return false;
  const g = gridOver(view.model.box, 1, view.site.lat);
  const nzOk = !part.grid.nz || !view.trees?.nz || part.grid.nz === view.trees.nz;
  return nzOk && g.w === part.grid.w && g.h === part.grid.h && Math.abs(g.x0 - part.grid.x0) < 0.5 && Math.abs(g.y1 - part.grid.y1) < 0.5;
}

/** The link back to the dashboard, once the map has an id (none on workers.dev or a local host). */
function backLink() {
  const a = $('#back-dash');
  if (!a) return;
  const id = view.site?.map?.id;
  a.hidden = !(HOME && id);
  if (HOME && id) a.href = `https://${HOME}/dashboard?map=${encodeURIComponent(id)}`;
}

const asFeature = (p) => (p?.type === 'Feature' ? p : p?.type ? { type: 'Feature', properties: {}, geometry: p } : null);

function siteFromSave(s) {
  const part = s.tools?.shade?.data || null;
  const site = {
    label: s.address || 'Saved map', lng: s.lng, lat: s.lat,
    parcel: asFeature(s.parcel),
    lawn: (s.shapes || []).map(asFeature).filter(Boolean),
    tracedOn: tracedOn(s),
    county: s.county || null,
    map: { id: s.id, at: s.at || null, shade: part },
  };
  /* The line traced here last time, when the county had none. */
  if (!site.parcel && part?.lot && !lotProblem(part.lot)) site.parcel = lotFeature(part.lot);
  return site;
}

/**
 * A typed address, as the editor finds one (owner, 2026-10-12): the
 * geocoder's pick, the county's property line for it, and the county photo
 * when the Worker has one sharp enough here (its list comes best first, as
 * the editor takes it), shown where the county put it -- the lidar is then
 * lined up on that photo's ground.
 */
async function siteFromAddress(r) {
  /* Start the lidar's download now (core session, 2026-10-29: /api/lidar/warm):
     a survey published only as USGS tiles takes minutes to fetch the first
     time, and the person spends them checking the property line. Not waited on. */
  fetch(`/api/lidar/warm?lng=${r.lng}&lat=${r.lat}`).catch(() => {});
  const where = new URLSearchParams({ lng: r.lng, lat: r.lat });
  if (r.county) where.set('county', r.county);
  if (r.state) where.set('state', r.state);
  if (r.parcelPin) where.set('pin', r.parcelPin);
  if (r.parcelSqFt) where.set('sqft', r.parcelSqFt);
  const [parcel, list] = await Promise.all([
    fetch(`/api/parcel?${where}`).then((x) => (x.ok ? x.json() : null)).then((j) => j?.parcel || null).catch(() => null),
    fetch(`/api/county-imagery?lng=${r.lng}&lat=${r.lat}`).then((x) => (x.ok ? x.json() : null))
      .then((j) => {
        const ss = Array.isArray(j?.services) ? j.services : j?.service ? [j.service] : [];
        if (j?.recent && !ss.some((x) => Number(x.id) === Number(j.recent.id))) ss.push(j.recent);
        return ss;
      }).catch(() => []),
  ]);
  const svc = list[0];
  return {
    label: r.label, lng: r.lng, lat: r.lat, parcel: asFeature(parcel), lawn: [], county: r.county || null,
    /* The Worker's order (core, 2026-10-12): best first, then the newer flight;
       build() passes over any with gaps here, as the editor does. */
    tracedOn: svc ? { provider: 'county', svc: svc.id, align: null, about: [r.lng, r.lat], title: svc.title || null, list } : { provider: 'mapbox' },
  };
}

/** The geocoder's answers for a typed address; one chosen by tapping when there are several. */
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

async function siteFromPoint(lat, lng) {
  let parcel = null;
  try {
    const res = await fetch(`/api/parcel?lng=${lng}&lat=${lat}`);
    if (res.ok) parcel = (await res.json()).parcel || null;
  } catch { /* no parcel: a box round the point will do */ }
  return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lng, lat, parcel, lawn: [], tracedOn: { provider: 'mapbox' } };
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
  /* A field-readings check covers the whole track (shade/log.js: area). */
  if (site.area) { pts.push([site.area[0], site.area[1]], [site.area[2], site.area[3]]); }
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

/*
 * THE LIDAR CACHED (owner, 2026-10-17: "caching the lidar load"): the
 * cloud's node files never change once published, so each one read is kept
 * in the browser's cache store and a map opened again reads them from
 * there, not from USGS's bucket. The hierarchy and the metadata are small
 * and read fresh. Kept to a few hundred files; the oldest go first.
 */
const LIDAR_CACHE = 'shade-lidar-v1', LIDAR_CACHE_MAX = 600;
async function lidarCache() {
  try { return typeof caches !== 'undefined' ? await caches.open(LIDAR_CACHE) : null; } catch { return null; }
}
async function getBytes(url) {
  const cacheable = /\/ept-data\/[^?]+\.laz$/.test(url);
  const cache = cacheable ? await lidarCache() : null;
  if (cache) {
    try { const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); } catch { /* read it */ }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  if (cache) {
    try {
      await cache.put(url, res.clone());
      const keys = await cache.keys();
      if (keys.length > LIDAR_CACHE_MAX) for (const k of keys.slice(0, keys.length - LIDAR_CACHE_MAX)) await cache.delete(k);
    } catch { /* the store is full or closed: read it next time */ }
  }
  return res.arrayBuffer();
}

const io = { getJson, getBytes, decompress: lazDecoder(() => browserFactory()) };
/* A flight USGS has published only as LAZ tiles (public/lib/lidar-tiles.js): the server is fetching them, a minute or two the first time. */
const fetchingWords = (name, mb) => `Fetching ${name} onto the server (USGS's newest survey here, not yet in the public cloud store${mb ? `, ${mb} MB` : ''}): a minute or two the first time…`;

/** A photo of a frame (Mapbox, or a county service by id), as RGBA pixels. Same origin, so readable. */
async function photoOf(frame, provider = 'mapbox', svc = null) {
  const q = new URLSearchParams({ lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, height: frame.height, provider });
  if (svc != null) q.set('svc', svc);
  const res = await fetch(`/api/imagery?${q}`);
  if (!res.ok) throw new Error(`the ${provider === 'county' ? 'county' : 'Mapbox'} photo would not load (${res.status})`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); // not OffscreenCanvas: older iPhones lack it
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  return { data: d.data, width: d.width, height: d.height, url: URL.createObjectURL(blob) };
}

/**
 * How much of a photo is missing: transparent pixels always, flat pure
 * white or black only past 4% (a bright roof saturates too) -- the
 * editor's rule (app.js, tools/county-imagery.js coverage()).
 */
export function missingShare(photo) {
  if (!photo?.data) return 0;
  const d = photo.data, n = d.length / 4;
  let clear = 0, flat = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) clear++;
    else if ((d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) || (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0)) flat++;
  }
  return (clear + (flat / n > 0.04 ? flat : 0)) / n;
}

/** Log a county photo passed over, for the core's county-photo report (fire and forget). */
function reportCountyFailure(site, frame, svc, kind, reason, services) {
  try {
    const p = site.parcel?.properties || {};
    fetch('/api/county-failure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({
        stage: 'shade', kind, reason, lng: frame.lng, lat: frame.lat, zoom: frame.zoom,
        frame: { lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, height: frame.height },
        county: p.county || site.county || null, parcelPin: p.pin ?? null, address: p.address || site.label || null,
        svc: svc ? { id: svc.id, url: svc.url, title: svc.title, year: svc.year, flown: svc.flown } : null,
        services,
      }),
    }).catch(() => {});
  } catch { /* bookkeeping only */ }
}

/** A square frame centered on the site, at least ALIGN_M and the lot wide, at a whole-ish zoom. */
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
  view.sun?.stop();
  view.sun = null; view.sunFor = null;
  view.trees?.stop();
  view.trees = null;
  view.model = null; view.builtFor = null;
  removePhotoDrape(map);
  if (STEPPED) { view.steps.setNext(2, false); view.steps.setNext(3, false); $('#grass-out').innerHTML = '<p class="dim">Waiting for the shade map…</p>'; }
  reLeash(site.parcel || { type: 'Feature', geometry: { type: 'Point', coordinates: [site.lng, site.lat] } });
  removeBuilt(map);
  const bounds = siteBounds(site);
  setGeo(map, 'parcel', site.parcel ? [site.parcel] : [], { 'line-color': '#ffeb3b', 'line-width': 2.5 });
  setGeo(map, 'lawn', site.lawn, { 'line-color': '#69f0ae', 'line-width': 2.5 });
  map.fitBounds(bounds, { padding: 40, duration: 0 });

  const k = mercScale(site.lat);
  const report = [];

  const started = Date.now();
  track('build', site.area ? 'field check' : site.parcel ? 'with a property line' : 'no property line');
  status('Asking USGS which lidar was flown here…');
  const found = await getJson(`${location.origin}/api/shade/lidar?lng=${site.lng}&lat=${site.lat}`);
  if (!found || found.error) throw new Error(found?.error || 'the lidar index did not answer');
  const { clouds, notOnAws } = found;
  if (!found.wesm) report.push('<p class="warn">USGS\'s 3DEP index did not answer, so no cloud could be confirmed by name and flight dates are unknown.</p>');
  /* THE LIDAR KEPT WITH THE MAP (owner, 2026-10-17: "save those edits to a
     map, so that means caching the lidar load and its alignment"): the same
     cloud, box and line-up as last time, so the trees stand where they
     stood, the erased blocks fit, and the photo match is skipped. */
  const kept = site.map?.shade?.lidar;
  let cloud = null, cols = null, flown = null, box = null, keptUsed = false;
  if (kept?.url && Array.isArray(kept.box) && kept.box.length === 4 && Array.isArray(kept.shift) && kept.shift.length === 2 && !site.area) {
    status(`Reading ${kept.name || 'the lidar kept with this map'}…`);
    try {
      const got = await pointsIn(kept.url, kept.box, io, { progress: (d, tot, more) => status(more?.fetching ? fetchingWords(kept.name || 'the kept lidar', kept.mb) : `Reading ${kept.name || 'the kept lidar'}: ${d} of ${tot} pieces…`) });
      if (got.cols.n > 500) {
        cloud = clouds.find((c) => c.url === kept.url) || { url: kept.url, name: kept.name || 'the cloud kept with this map', epoch: kept.epoch || 2018, unit: null, confirmed: false };
        cols = got.cols; flown = got.flown; box = kept.box; keptUsed = true;
      }
    } catch (e) { report.push(`<p class="warn">The lidar kept with this map could not be read (${esc(e.message)}); read afresh.</p>`); }
  }
  if (!clouds.length && !keptUsed) {
    track('no-lidar', notOnAws.length ? `${notOnAws.length} collection(s) not in the public store` : 'none');
    status('No public lidar over this point that this page can read.', 'bad');
    $('#report').innerHTML = notOnAws.length
      ? `<p>USGS lists ${notOnAws.length} collection(s) here that are not in the public cloud store: ${notOnAws.map((u) => esc(u.workunit)).join(', ')}.</p>` : '';
    return;
  }

  /* The box: the lot plus the margin, and at least the photo frame. */
  const frame = alignFrame(site, bounds);
  const fBox = gridBox(gridForFrame(frame, 1, 1));
  const [lx0, ly0] = toMerc([bounds[0], bounds[1]]), [lx1, ly1] = toMerc([bounds[2], bounds[3]]);
  /* Points a square meter over the lot itself. A HOLE IN THE SURVEY (a user's
     report, 2026-10-29: "unable to identify any trees" in Ketchum, Idaho):
     USGS's index matches a survey by its box, and a survey can have a hole
     where it was never flown -- there, Southern Idaho 2018 had about 0.05 a
     square meter over the lot and 20 a block away. Under USGS's lowest grade
     (QL3, 0.5 a square meter) the survey is taken as not covering the lot:
     the next one is tried, and with none the page says so instead of
     building an empty model. */
  const lotM2 = Math.max(1, (lx1 - lx0) * (ly1 - ly0) * k * k);
  const lotDensity = (c) => { let n = 0; for (let i = 0; i < c.n; i++) if (c.x[i] >= lx0 && c.x[i] <= lx1 && c.y[i] >= ly0 && c.y[i] <= ly1) n++; return n / lotM2; };
  const MIN_DENSITY = 0.5;
  if (keptUsed && lotDensity(cols) < MIN_DENSITY) { keptUsed = false; cols = null; cloud = null; flown = null; box = null; }
  const holes = [], failed = [];
  const m = MARGIN_M / k;
  if (!keptUsed) box = [Math.min(lx0 - m, fBox[0]), Math.min(ly0 - m, fBox[1]), Math.max(lx1 + m, fBox[2]), Math.max(ly1 + m, fBox[3])];

  for (const c of keptUsed ? [] : clouds.slice(0, 3)) {
    status(`Reading ${c.name}…`);
    try {
      const got = await pointsIn(c.url, box, io, { progress: (d, t, more) => status(more?.fetching ? fetchingWords(c.name, c.mb) : `Reading ${c.name}: ${d} of ${t} pieces…`) });
      const dens = got.cols.n ? lotDensity(got.cols) : 0;
      if (got.cols.n > 500 && dens >= MIN_DENSITY) { cloud = c; cols = got.cols; flown = got.flown; break; }
      holes.push({ name: c.name, dens });
      report.push(`<p class="warn">${esc(c.name)} has ${dens < 0.05 ? 'almost no' : `only ${dens.toFixed(2)} a square meter of`} points over this lot (a hole in the survey); tried the next.</p>`);
    } catch (e) {
      failed.push({ name: c.name, why: e.message });
      report.push(`<p class="warn">${esc(c.name)} could not be read (${esc(e.message)}); tried the next.</p>`);
    }
  }
  if (!cols) {
    const hole = holes.length ? `The lidar USGS publishes here has a hole over this property: ${holes.map((h) => `${esc(h.name)} has ${h.dens < 0.05 ? 'almost no points' : `${h.dens.toFixed(2)} points a square meter`}`).join('; ')} over the lot, where a survey has 2 to 20 or more. Without them the trees and buildings cannot be seen, so the shade cannot be worked out.` : 'None of the lidar over this point had points here, so the trees and buildings cannot be seen.';
    /* A survey that could not be read (most often the newer one still being fetched onto the server the first time). */
    const unread = failed.length ? ` ${failed.map((f) => `${esc(f.name)} could not be read: ${esc(f.why)}.`).join(' ')}` : '';
    const later = unread + (notOnAws.length ? ` USGS has flown it again (${notOnAws.map((u) => `${esc(u.workunit)}, ${esc(u.ql || '?')}, flown to ${u.end ? new Date(u.end).toISOString().slice(0, 7) : '?'}`).join('; ')}), but that survey is not yet in the public cloud store this map reads; once it is, the trees will show here.` : '');
    track('no-lidar', holes.length ? `hole in ${holes.map((h) => h.name).join(', ')}${notOnAws.length ? '; newer not in the store' : ''}` : 'no points');
    status(hole + later, 'bad');
    $('#report').innerHTML = report.join('') + `<p class="warn">${hole}${later}</p>`;
    return;
  }

  /* One leaf state over the lot where the lidar allows it (passes.js): a
     survey's passes can be months apart, one in leaf and one not. */
  const passes = onePass(cols, [lx0, ly0, lx1, ly1], k);
  cols = passes.cols;

  /* Density over the lot itself. */
  const inLot = Math.round(lotDensity(cols) * lotM2);

  status(keptUsed ? 'Lining it up as kept with this map…' : 'Moving it onto the map\'s datum, then checking against the photo…');
  const datum = nad83Correction(site.lat, site.lng, cloud.epoch);
  const pre = [datum.east / k, datum.north / k];
  const t = site.tracedOn || { provider: 'mapbox' };
  let onMapbox = null, onCounty = null, move = { east: 0, north: 0 }, used = null, usedName = '';
  const match = async (provider, svc) => {
    try {
      const photo = await photoOf(frame, provider, svc);
      await new Promise((r) => setTimeout(r, 0));
      return { photo, fit: alignToPhoto(cols, frame, photo, { pre }) };
    } catch (e) {
      return { error: e.message };
    }
  };
  /* The photo the outline was traced on decides; the other is a cross-check. */
  if (!keptUsed) onMapbox = await match('mapbox');
  if (!keptUsed) onCounty = t.provider === 'county' ? await match('county', t.svc) : null;
  /* A typed address: a county photo with gaps over this frame gives way to
     the next on the Worker's list, then to Mapbox (the editor's rule), and
     each one passed over is logged for the core's county-photo report. */
  if (!keptUsed && t.list) {
    let i = 0;
    while (onCounty && (onCounty.error || missingShare(onCounty.photo) > 0.02)) {
      reportCountyFailure(site, frame, t.list[i], onCounty.error ? 'refused' : 'gaps', onCounty.error || `${Math.round(100 * missingShare(onCounty.photo))}% of the frame missing`, t.list.map((x) => x.id));
      i++;
      if (i >= t.list.length) { onCounty = null; t.provider = 'mapbox'; break; }
      t.svc = t.list[i].id; t.title = t.list[i].title || null;
      onCounty = await match('county', t.svc);
    }
  }
  if (!keptUsed) move = t.provider === 'county' ? lineUpAt(t, [frame.lng, frame.lat]) : { east: 0, north: 0 };
  if (keptUsed) {
    used = kept.fit ? { east: kept.fit.east ?? null, north: kept.fit.north ?? null, confident: !!kept.fit.confident, why: kept.fit.why || 'as kept with the map' } : null;
    usedName = `the line-up kept with this map${kept.at ? ` on ${String(kept.at).slice(0, 10)}` : ''}`;
  } else if (onCounty && !onCounty.error) {
    /* Matched to the county photo where the county put it; the outline was
       drawn on it after the editor's line-up moved it, so add that move. */
    const f = onCounty.fit;
    used = { ...f, east: f.east === null ? null : f.east + move.east, north: f.north === null ? null : f.north + move.north };
    usedName = t.title !== undefined
      ? `the county photo${t.title ? ` (${t.title})` : ''}, the clearest for this address, where the county put it`
      : `the county photo the map was traced on${t.align ? ', as the editor lined it up' : ' (saved without a line-up, so where the county put it)'}`;
  } else {
    used = onMapbox.fit || null;
    usedName = t.provider === 'county'
      ? `the Mapbox photo, because the county photo could not be read (${onCounty?.error || '?'})${t.align ? '' : '; the map was saved without a line-up, so its outline may sit up to about half a meter off this'}`
      : site.lawn.length ? 'the Mapbox photo the map was traced on' : 'the Mapbox photo';
  }
  const fit = used;
  if (onMapbox?.error) report.push(`<p class="warn">${esc(onMapbox.error)}</p>`);
  const residual = fit?.confident ? [fit.east / k, fit.north / k] : [0, 0];
  const shift = keptUsed ? kept.shift : [pre[0] + residual[0], pre[1] + residual[1]];

  /* Ground under every point, for heights and the drapes, on the 1 m grid:
     the same smooth surface the model stands on (ground.js), so the photo,
     the light and the blocks share one ground. */
  const g = gridOver(box, 1, site.lat);
  const ground = groundOf(cols, g, { shift }).z;
  const heightOver = (i) => {
    const c = cellOf(g, cols.x[i], cols.y[i], shift);
    const z0 = c < 0 ? NaN : ground[c];
    return Number.isFinite(z0) ? cols.z[i] - z0 : 0;
  };
  const baseZ = quantile(ground, 0.5);
  /* The fences stand on this ground when the map is tilted. */
  view.groundFor = { grid: g, z: ground, baseZ };
  fenceList();

  view.built = {
    cols, shift, pre, heightOver, baseZ, frame, fit,
    traced: onCounty && !onCounty.error
      ? { url: onCounty.photo.url, corners: t.align
        ? movedCorners(frameCorners(frame), t.align.east, t.align.north, t.align.scale, t.about) : frameCorners(frame) }
      : null,
  };
  $('#t-traced').hidden = !view.built.traced;
  drawBuilt(map, true);
  $('#toggles').hidden = false;
  drapePhoto(map, site, g, ground, baseZ); // the photo onto the lidar's ground, in the background
  map.easeTo({ pitch: 55, bearing: -20, duration: 800 });

  /* The report. The flight's dates and season from the points' own clock
     (find.js flightOf), the catalogue's when the files keep no time. */
  const u0 = flightOf(cloud.unit, flown);
  /* The points' own days over the lot decide the season (passes.js). */
  const u = u0 && passes.season ? { ...u0, season: passes.season, source: 'laser', agree: u0.catalogue ? u0.catalogue.season === passes.season : u0.agree } : u0;
  const passWords = !passes.season || (!passes.dropped && passes.season !== 'mixed') ? ''
    : passes.season === 'mixed'
      ? `<tr><td>Leaves</td><td class="warn">Part of this lot was flown with the leaves off (${passes.off.toLocaleString()} points) and part in leaf (${passes.on.toLocaleString()}), and neither pass covers it alone. Each square meter is judged by its own returns: leaves are added only where the laser saw bare branches, never on top of a canopy it saw in leaf.</td></tr>`
      : `<tr><td>Leaves</td><td>Two passes over this lot, ${passes.off.toLocaleString()} points with the leaves off and ${passes.on.toLocaleString()} in leaf. The ${passes.season === 'on' ? 'in-leaf' : 'leaf-off'} pass covers the lot alone, so the other's ${passes.dropped.toLocaleString()} points are left out: no canopy here is part summer leaves and part bare branches.</td></tr>`;
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '?');
  const seasonWord = (s) => (s === 'off' ? '<span class="warn">leaf-off</span>' : s === 'on' ? 'leaf-on' : s === 'mixed' ? '<span class="warn">part leaf-off</span>' : 'season unknown');
  report.unshift(`
    <h2>The lidar</h2>
    <table>
      <tr><td>Cloud</td><td>${esc(cloud.name)}${cloud.confirmed ? '' : ' <span class="warn">(box match only: USGS did not confirm it flew this point)</span>'}</td></tr>
      ${u ? `<tr><td>Flown</td><td>${day(u.start)}${day(u.end) !== day(u.start) ? ` to ${day(u.end)}` : ''}, ${esc(u.ql || '?')}, ${seasonWord(u.season)} <span class="dim">${u.source === 'laser' ? 'by the laser\'s own clock' : 'by the USGS catalogue'}${u.catalogue && !u.agree ? `; the catalogue says ${day(u.catalogue.start)} to ${day(u.catalogue.end)}, ${u.catalogue.season || '?'} — the clock wins` : ''}</span></td></tr>` : '<tr><td>Flown</td><td class="warn">unknown: the files keep no time and the USGS catalogue did not answer; the trees are drawn as the laser saw them</td></tr>'}
      ${passWords}
      <tr><td>Points</td><td>${cols.n.toLocaleString()} within ${MARGIN_M} m of the lot; ${(inLot / lotM2).toFixed(1)} a square meter over the lot</td></tr>
      ${notOnAws.length ? `<tr><td>Also flown</td><td class="warn">${notOnAws.map((x) => `${esc(x.workunit)} (${day(x.end)}, ${esc(x.ql || '?')})`).join('; ')} — not in the public cloud store, so not read</td></tr>` : ''}
    </table>
    <h2>Lining it up</h2>
    <table>
      <tr><td>Datum (NAD83 → map)</td><td>${fmtMove(datum.east, datum.north)} <span class="dim">computed, epoch ${cloud.epoch.toFixed(1)}</span></td></tr>
      <tr><td>Matched against</td><td>${esc(usedName)}</td></tr>
      ${t.provider === 'county' && t.align ? `<tr><td>Editor's line-up</td><td class="dim">${fmtMove(move.east, move.north)} at this frame's center (saved ${t.align.east.toFixed(2)} E, ${t.align.north.toFixed(2)} N, scale ${t.align.scale})</td></tr>` : ''}
      <tr><td>Left over, measured</td><td>${fit ? `${fmtMove(fit.east, fit.north)} <span class="${fit.confident ? 'ok' : 'warn'}">${esc(fit.why)}</span>` : '<span class="bad">not measured</span>'}</td></tr>
      ${fit?.quarters?.length ? `<tr><td>Quarters alone</td><td class="dim">${fit.quarters.map((q) => (q ? fmtMove(q.east, q.north) : '—')).join(' · ')}</td></tr>` : ''}
      ${fit?.score != null ? `<tr><td>Open ground that voted</td><td class="dim">${Math.round(fit.openShare * 100)}% of a ${Math.round(gridForFrame(frame, 1, 1).cell * k)} m frame; match ${fit.score?.toFixed(2)} against ${fit.second?.toFixed(2)} for the best rival</td></tr>` : ''}
      ${onCounty && !onCounty.error && onMapbox?.fit ? `<tr><td>Cross-check: Mapbox</td><td class="dim">${fmtMove(onMapbox.fit.east, onMapbox.fit.north)} (${esc(onMapbox.fit.why)})${onMapbox.fit.confident && fit.confident ? `; ${Math.hypot(onMapbox.fit.east - fit.east, onMapbox.fit.north - fit.north).toFixed(2)} m from the answer above` : ''}</td></tr>` : ''}
      <tr><td><b>Applied</b></td><td><b>${fmtMove(datum.east + (fit?.confident ? fit.east : 0), datum.north + (fit?.confident ? fit.north : 0))}</b> ${fit?.confident ? '<span class="ok">datum + measured</span>' : '<span class="warn">datum only</span>'}</td></tr>
    </table>
    <p class="dim">Roofs and crowns will NOT sit exactly on the photo's: the photo was taken at an angle, so tall
    things lean in it by up to a meter or two, and the laser measures them where they stand.
    The ground is what has to agree. "Lined up" off shows the cloud where the file puts it. "Lidar ground picture" lays the laser's view of the ground over the photo to compare by eye: roads, drives and paths should sit exactly on the photo's.</p>`);
  $('#report').innerHTML = report.join('');
  status(keptUsed ? 'Built and lined up as kept with this map.' : fit?.confident ? 'Built and lined up.' : 'Built. The photo check was not tight enough to apply; the datum correction is applied.', keptUsed || fit?.confident ? 'ok' : 'warn');
  track('built', `${Math.round((Date.now() - started) / 1000)} s, ${fit?.confident ? 'lined up' : 'not lined up'}`);

  view.builtFor = site;
  view.model = {
    cols, box, shift, baseZ, ground, fit, season: u?.season ?? null, flownTo: u?.end ? day(u.end) : null,
    lidar: keptUsed ? kept : { url: cloud.url, name: cloud.name, epoch: cloud.epoch, box, shift, fit: fit ? { east: fit.east, north: fit.north, confident: !!fit.confident, why: fit.why } : null, at: new Date().toISOString() },
  };

  /* The trees page (/shade-trees): the same model drawn instead of lit (shade/trees-ui.js). */
  if (TREES) {
    view.sun = await startTrees({ map, site, cols, box, shift, season: view.model.season, flownTo: view.model.flownTo, baseZ });
    return;
  }

  if (STEPPED) {
    /* Step 2: the trees, with the eraser; the shade waits for step 3. */
    view.trees = await startTrees({ map, site, cols, box, shift, season: view.model.season, flownTo: view.model.flownTo, erase: true, baseZ, onErase: () => { view.eraseVersion++; saveShadePart(); } });
    view.trees.setActive(view.steps.current === 2);
    view.steps.unlock(3);
    view.steps.setNext(2, true);
    /* The cloud and its line-up go onto the map now, so the next visit reads the same. */
    if (!keptUsed) saveShadePart();
    /* The part kept last time: the erased cells back in, if the grid is the same; the step they left. */
    const part = site.map?.shade;
    if ((part?.erased?.length || part?.cubes?.length) && partFitsGrid(part)) { view.trees.restore({ cells: part.erased || [], cubes: part.cubes || [] }); view.eraseVersion++; }
    if (part && (part.settings?.step || 0) >= 3 && view.steps.current === 2) { view.steps.unlock(3); view.steps.go(3); }
    status(keptUsed ? 'The trees are built and lined up as kept with this map. Erase any that should not count, then go on to the shade map.'
      : fit?.confident ? 'The trees are built and lined up with the photo. Erase any that should not count, then go on to the shade map.'
        : 'The trees are built. The photo check was not tight enough to apply; the datum correction alone is applied.', keptUsed || fit?.confident ? 'ok' : 'warn');
    /* A field-readings check goes straight to the shade map (admin). */
    if (new URLSearchParams(location.search).get('truth')) view.steps.go(3);
    return;
  }

  startShade();
}

/** Step 3: the sun over the model, in a worker (shade/sun-ui.js), without the columns erased in step 2. */
function startShade() {
  const { map, site, model: m } = view;
  if (!m || !map) return;
  const mask = view.trees?.erased() || null, cubes = view.trees?.erasedCubes() || null;
  if (view.sun && view.sunFor === m) {
    if (view.sunVersion !== view.eraseVersion) { view.sun.setErased(mask, cubes); view.sunVersion = view.eraseVersion; }
    view.sun.setVisible(true);
    return;
  }
  view.sun?.stop();
  view.sun = startSun({
    map, site, cols: m.cols, box: m.box, shift: m.shift, heightM: m.baseZ, season: m.season, ground: m.ground, erased: mask, erasedCubes: cubes, fences: view.fences || [],
    beforeLayer: () => (map.getLayer('parcel') ? 'parcel' : undefined),
    onSeason: (se, climate) => {
      if (!STEPPED) return;
      view.steps.unlock(4);
      view.steps.setNext(3, true);
      renderGrass($('#grass-out'), { season: se, climate, hasLawn: site.lawn.length > 0, grassKind: $('#grass')?.value || null });
      saveShadePart();
    },
    onChange: () => { if (STEPPED) saveShadePart(); },
  });
  view.sunFor = m;
  view.sunVersion = view.eraseVersion;
  /* The settings they chose last time (grass, how the season is counted, the day). */
  const st = site.map?.shade?.settings;
  if (st && STEPPED) {
    if (st.grass && $('#grass') && [...$('#grass').options].some((o) => o.value === st.grass)) { $('#grass').value = st.grass; $('#grass').onchange?.(); }
    if (st.date && /^\d{4}-\d{2}-\d{2}$/.test(st.date)) view.sun.showDay(Date.parse(`${st.date}T12:00:00`));
    if (st.what || st.when) view.sun.setView({ what: st.what, when: st.when });
  }
  /* A visit's field readings, when the readings page sent us here (admin). */
  const truth = new URLSearchParams(location.search).get('truth');
  if (truth) import('./shade/truth-ui.js').then((t) => t.startTruth({ map, sun: view.sun, spec: truth, bounds: siteBounds(site), moveM: m.fit?.confident ? [m.fit.east, m.fit.north] : null })).catch((e) => status(e.message, 'bad'));
}

/** Square feet inside a property line. */
function lotSqFt(parcel) {
  const g = parcel?.geometry;
  const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.reduce((a, p) => a + Math.abs(ringAreaSqM(p[0])), 0) / SQM_PER_SQFT;
}

/**
 * Step 1's end: the property line on the photo, to check before the trees
 * are built. Steps 2-4 close again until the trees are built for this site.
 */
async function offerLot(site, { traced = false } = {}) {
  const map = await ensureMap();
  view.site = site;
  view.steps.lockFrom(2);
  view.trees?.setActive(false);
  view.sun?.setVisible(false);
  setGeo(map, 'parcel', site.parcel ? [site.parcel] : [], { 'line-color': '#ffeb3b', 'line-width': 2.5 });
  setGeo(map, 'lawn', site.lawn, { 'line-color': '#69f0ae', 'line-width': 2.5 });
  map.fitBounds(siteBounds(site), { padding: 40, duration: 0, pitch: 0, bearing: 0 });
  reLeash(site.parcel || { type: 'Feature', geometry: { type: 'Point', coordinates: [site.lng, site.lat] } });
  const sqft = site.parcel ? Math.round(lotSqFt(site.parcel)) : 0;
  $('#lot-note').innerHTML = site.parcel
    ? `<p class="ok">Property line ${traced || site.parcel.properties?.traced ? 'as you traced it' : 'from the county\'s records'}: about ${sqft.toLocaleString()} sq ft${site.lawn.length ? `, with the lawn you mapped (${site.lawn.length} shape${site.lawn.length === 1 ? '' : 's'})` : ''}. Check it against the photo${traced ? '' : '; if it is off, trace it yourself'}.</p>`
    : '<p class="warn">No property line yet.</p>';
  $('#lot-trace').hidden = !site.parcel;
  $('#lot-trace').textContent = traced || site.parcel?.properties?.traced ? 'Trace it again' : 'Trace the line myself';
  view.steps.setNext(1, !!site.parcel);
  backLink();
  /* The fences kept with this map, and the tools to add more. */
  if (view.fencesFor !== site) { view.fences = cleanFences(site.map?.shade?.fences); view.fencesFor = site; }
  $('#fences').hidden = !site.parcel;
  fenceList();
  status(site.parcel ? `Check the property line${view.fences.length ? '' : ', mark any solid or board fences'}, then go on to the trees.` : 'Trace the property line.');
}

/* ---------------------------------------------------------------- fences */

/** The fences on the map and in step 1's list, with Edit and Remove. */
function fenceList() {
  const map = view.map;
  if (!map) return;
  showFences(map, view.fences || [], { ground: view.groundFor || null });
  const list = $('#fence-list');
  if (!list) return;
  list.innerHTML = (view.fences || []).map((f, i) => `<div class="fence"><i style="background:${{ solid: '#ff8a65', spaced: '#ffd54f', shadowbox: '#ce93d8' }[f.style]}"></i><span>${esc(fenceWords(f))}</span>
    <button type="button" data-fence-edit="${i}">Change</button><button type="button" data-fence-line="${i}">Redraw</button><button type="button" data-fence-del="${i}">Remove</button></div>`).join('')
    || '<p class="dim">No fences marked.</p>';
  list.querySelectorAll('[data-fence-edit]').forEach((b) => { b.onclick = () => editFence(Number(b.dataset.fenceEdit), { line: false }); });
  list.querySelectorAll('[data-fence-line]').forEach((b) => { b.onclick = () => editFence(Number(b.dataset.fenceLine), { line: true }); });
  list.querySelectorAll('[data-fence-del]').forEach((b) => { b.onclick = () => { view.fences.splice(Number(b.dataset.fenceDel), 1); fencesChanged(); }; });
  $('#fence-add').disabled = (view.fences || []).length >= 40;
}
/** Kept with the map, and the light worked out again with them. */
function fencesChanged() {
  fenceList();
  saveShadePart();
  view.sun?.setFences?.(view.fences);
  track('fence', `${view.fences.length} fences`);
}
let fenceBusy = false;
/** Add a fence (i null) or change one: draw its line (new, or asked), then the questions. */
async function editFence(i = null, { line = true } = {}) {
  if (fenceBusy || !view.map) return;
  fenceBusy = true;
  $('#fence-add').disabled = true;
  try {
    const was = i === null ? null : view.fences[i];
    const pts = line ? await drawFenceLine(view.map, { box: $('#fence-draw'), status, line: was?.line || null }) : was.line;
    if (!pts) return;
    const answers = await askFence($('#fence-draw'), was);
    if (!answers) return;
    const rec = fenceRecord({ id: was?.id || null, line: pts, ...answers });
    if (!rec) { status('That fence could not be kept: its line is too short or its height out of range.', 'warn'); return; }
    if (i === null) view.fences.push(rec); else view.fences[i] = rec;
    fencesChanged();
    status(`Fence kept: ${fenceWords(rec)}.`, 'ok');
  } finally {
    fenceBusy = false;
    fenceList();
  }
}

/** The camera's leash to the lot (or the address, while the line is traced). */
function reLeash(feature) {
  view.unleash?.();
  view.unleash = view.map && feature ? leash(view.map, feature, { maxM: LEASH_M, maxAltM: LEASH_ALT_M }) : null;
}

/** Trace the line on the map (step 1), replacing the one on file. */
async function traceNow(site) {
  const map = await ensureMap();
  view.steps.lockFrom(2);
  view.trees?.setActive(false);
  view.sun?.setVisible(false);
  removeBuilt(map);
  for (const g of ['parcel', 'lawn']) map.getSource(g)?.setData({ type: 'FeatureCollection', features: [] });
  $('#toggles').hidden = true;
  $('#lot-note').innerHTML = '';
  $('#lot-trace').hidden = true;
  $('#fences').hidden = true;
  view.steps.setNext(1, false);
  reLeash({ type: 'Feature', geometry: { type: 'Point', coordinates: [site.lng, site.lat] } });
  track('trace', 'asked');
  const lot = await traceLot(map, { lng: site.lng, lat: site.lat, box: $('#trace'), status });
  track('trace', lot ? 'done' : 'cancelled');
  return lot;
}

/** Steps 1-4 opening (shade/steps.js): each shows its own tools and its own picture on the map. */
function onStep(n) {
  view.trees?.setActive(n === 2);
  if (n === 3 && view.trees) view.trees.setVisible($('#t-trees').getAttribute('aria-pressed') === 'true');
  $('#t-trees').hidden = n !== 3 || !view.trees;
  $('#t-lawn').hidden = n !== 3 || $('#t-lawn').dataset.has !== '1';
  $('#toggles').hidden = n === 1;
  view.sun?.setVisible(n === 3 || n === 4);
  if (n === 2 && view.site && view.builtFor !== view.site) build(view.site).catch((e) => status(e.message || String(e), 'bad'));
  if (n === 3) { startShade(); status(view.model ? 'The shade map: choose what to show and over which days; the caption says what is on the map. Tap the lawn to read it.' : ''); }
  if (n === 4) {
    status('Which grass will grow here, from the climate and the season\'s light.');
    const s = view.sun?.season();
    renderGrass($('#grass-out'), { season: s?.season || null, climate: s?.climate || view.sun?.climate() || null, hasLawn: (view.site?.lawn.length || 0) > 0, grassKind: $('#grass')?.value || null });
  }
}

const fmtMove = (e, n) => (e === null || n === null ? '—'
  : `${Math.abs(e).toFixed(2)} m ${e >= 0 ? 'E' : 'W'}, ${Math.abs(n).toFixed(2)} m ${n >= 0 ? 'N' : 'S'}`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function removeBuilt(map) {
  for (const id of ['points', 'picture', 'traced']) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
}

/*
 * THE PHOTO ON THE LIDAR'S GROUND (owner, 2026-10-17: "warp the imagery to
 * fit that 3d ground so that it's not just a 3d lidar map sitting above a
 * 2d image"). The satellite photo of the modelled box is fetched once more
 * at the finest zoom that fits it in one Mapbox frame, cut to the box, and
 * laid on the same ground mesh the light is draped on (view3d.js
 * groundLayer), shown when the map is tilted. The trees stand on that
 * ground too (trees-ui.js, baseZ), so the whole scene is one surface.
 */
const PHOTO_3D = 'photo-3d', LINES_3D = 'lines-3d';
function removePhotoDrape(map) {
  for (const id of [PHOTO_3D, LINES_3D]) if (map.getLayer(id)) map.removeLayer(id);
  if (view.photoPitch) { map.off('pitchend', view.photoPitch); view.photoPitch = null; }
  for (const id of ['parcel', 'lawn']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
  view.photoDrape = null;
}

/**
 * THE PROPERTY LINE AND THE LAWN OUTLINES ON THE SAME GROUND (owner,
 * 2026-10-17): drawn into a transparent picture of the box at 0.2 m a
 * pixel and draped a little above the light; the flat line layers are
 * hidden while the map is tilted so nothing sits under the ground.
 */
function linesDrape(map, site, grid, ground, baseZ) {
  const rings = [];
  const walk = (g, color) => { if (!g) return; const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; for (const p of polys) for (const r of p) rings.push({ r, color }); };
  walk(site.parcel?.geometry, '#ffeb3b');
  for (const f of site.lawn) walk(f.geometry, '#69f0ae');
  if (!rings.length) return null;
  const [bx0, by0, bx1, by1] = gridBox(grid);
  const k = mercScale(site.lat);
  const scale = Math.min(1, 2048 / Math.max((bx1 - bx0) * k / 0.2, (by1 - by0) * k / 0.2));
  const W = Math.max(1, Math.round((bx1 - bx0) * k / 0.2 * scale)), H = Math.max(1, Math.round((by1 - by0) * k / 0.2 * scale));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g2 = c.getContext('2d');
  g2.lineWidth = 3; g2.lineJoin = 'round';
  for (const { r, color } of rings) {
    g2.strokeStyle = color;
    g2.beginPath();
    r.forEach((p, i) => { const [x, y] = toMerc(p); const px = ((x - bx0) / (bx1 - bx0)) * W, py = ((by1 - y) / (by1 - by0)) * H; if (i) g2.lineTo(px, py); else g2.moveTo(px, py); });
    g2.stroke();
  }
  const layer = groundLayer(LINES_3D, { grid, ground, baseZ, lat: site.lat, liftM: 0.15, smooth: true, taperCells: 12 });
  map.addLayer(layer);
  layer.setImage(c);
  return layer;
}
async function drapePhoto(map, site, grid, ground, baseZ) {
  removePhotoDrape(map);
  const layer = groundLayer(PHOTO_3D, { grid, ground, baseZ, lat: site.lat, liftM: 0.02, smooth: true, taperCells: 12 });
  map.addLayer(layer, below(map, ['light-3d', 'light', 'parcel']));
  view.photoDrape = layer;
  const lines = linesDrape(map, site, grid, ground, baseZ);
  const show = () => {
    const tilted = map.getPitch() > 5;
    if (map.getLayer(PHOTO_3D)) map.setLayoutProperty(PHOTO_3D, 'visibility', tilted ? 'visible' : 'none');
    if (lines && map.getLayer(LINES_3D)) map.setLayoutProperty(LINES_3D, 'visibility', tilted ? 'visible' : 'none');
    for (const id of ['parcel', 'lawn']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', tilted && lines ? 'none' : 'visible');
  };
  view.photoPitch = show;
  map.on('pitchend', show);
  show();
  /* The frame: the box's center, the finest zoom that keeps its longer side
     within 1280 logical pixels (the Worker asks Mapbox at 2x). */
  const [bx0, by0, bx1, by1] = gridBox(grid);
  const WORLD = 2 * Math.PI * 6378137;
  const zoom = Math.max(14, Math.min(19, Math.floor(Math.log2((1280 * WORLD) / (512 * Math.max(bx1 - bx0, by1 - by0))) * 100) / 100));
  const perPx = WORLD / (512 * 2 ** zoom); // 3857 m per logical px
  const [lng, lat] = fromMerc([(bx0 + bx1) / 2, (by0 + by1) / 2]);
  const frame = { lng, lat, zoom, size: Math.min(1280, Math.ceil((bx1 - bx0) / perPx) + 2), height: Math.min(1280, Math.ceil((by1 - by0) / perPx) + 2) };
  try {
    const q = new URLSearchParams({ lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, height: frame.height, provider: 'mapbox' });
    const res = await fetch(`/api/imagery?${q}`);
    if (!res.ok) throw new Error(`photo ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    if (view.photoDrape !== layer) return; // rebuilt meanwhile
    /* Cut the box out of the frame: both are axis-aligned in mercator. */
    const g = gridForFrame(frame, bmp.width, bmp.height); // the frame's own pixel grid, in 3857
    const sx = (bx0 - g.x0) / g.cell, sy = (g.y1 - by1) / g.cellY, sw = (bx1 - bx0) / g.cell, sh = (by1 - by0) / g.cellY;
    const scale = Math.min(1, 2048 / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
    c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    layer.setImage(c);
  } catch (e) { track('photo-3d', `not draped: ${e.message}`); }
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
    map.addLayer({ id: 'picture', type: 'raster', source: 'picture', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, below(map, ['light', 'parcel']));
  }
  if (b.traced && $('#t-traced').getAttribute('aria-pressed') === 'true') {
    map.addSource('traced', { type: 'image', url: b.traced.url, coordinates: b.traced.corners });
    map.addLayer({ id: 'traced', type: 'raster', source: 'traced', paint: { 'raster-fade-duration': 0 } }, below(map, ['picture', 'light', 'parcel']));
  }
  if ($('#t-points').getAttribute('aria-pressed') === 'true') {
    map.addLayer(pointLayer('points', b.cols, { heightOver: b.heightOver, shift, baseZ: b.baseZ, lat: view.site.lat, size: 3 }));
  }
}

/** The first of these layers that exists, to draw beneath it: photos under the light colors, under the outlines. */
const below = (map, ids) => ids.find((id) => map.getLayer(id));

function toggle(id, on) {
  const el = $(id);
  const next = on ?? el.getAttribute('aria-pressed') !== 'true';
  el.setAttribute('aria-pressed', String(next));
  return next;
}

/* --------------------------------------------------------------- wiring */

async function main() {
  watchErrors();
  track('open', new URLSearchParams(location.search).get('truth') ? 'field check' : location.search ? 'with a place' : 'blank');
  /* The buttons work at once; the saved maps arrive when they arrive. */
  let saves = [];
  const savesReady = listSaves().then((s) => { saves = s; });
  const params = new URLSearchParams(location.search);
  const go = async (startup = false) => {
    if ($('#go').disabled) return; // one at a time: Enter while tracing or building waits
    $('#go').disabled = true;
    try {
      const id = $('#saved').value;
      if (id) await savesReady;
      const at = $('#at').value.trim();
      let site = null;
      setPlace(id ? { place: `saved map ${id}` } : at ? { place: at } : null);
      if (id) {
        const m = await openMap(id).catch(() => null);
        const listed = saves.find((s) => s.id === id);
        if (!m && !listed) throw new Error('That map is not among yours. Open it from your dashboard, or type the address.');
        site = siteFromSave(m || listed);
        track('search', 'saved map');
      }
      else if (at) {
        const nums = at.split(/[ ,]+/).filter(Boolean).map(Number);
        if (nums.length === 2 && nums.every(Number.isFinite) && Math.abs(nums[0]) <= 90) site = await siteFromPoint(nums[0], nums[1]);
        else {
          status('Looking up that address…');
          track('search', 'address');
          const r = await pickAddress(at);
          status('Finding the property line and the clearest photo…');
          site = await siteFromAddress(r);
        }
      } else throw new Error('Pick a saved map, or type an address or a point, first.');
      /* Errors from here on carry the place, for the admin page only (shade/usage.js). */
      setPlace({ place: id ? `saved map ${id}: ${site.label}` : site.label === at ? at : `${at} (${site.label})`, lng: site.lng, lat: site.lat });
      const area = (params.get('area') || '').split(',').map(Number);
      if (params.get('truth') && area.length === 4 && area.every(Number.isFinite) && area[2] > area[0] && area[3] > area[1]
        && area[2] - area[0] < 0.02 && area[3] - area[1] < 0.02) site.area = area; // at most ~1.5 km across
      /* NO PROPERTY LINE: the visitor traces it (shade/trace.js), or it came in the link. */
      let lot = null;
      const fromLink = params.get('at') === at && !!parseLot(params.get('lot'));
      if (!id && !site.parcel && !site.area) {
        lot = (fromLink && parseLot(params.get('lot'))) || null;
        if (!lot) {
          if (STEPPED) { view.site = site; lot = await traceNow(site); } else {
            view.sun?.stop(); view.sun = null;
            const map = await ensureMap();
            removeBuilt(map);
            for (const g of ['parcel', 'lawn']) map.getSource(g)?.setData({ type: 'FeatureCollection', features: [] });
            $('#toggles').hidden = true;
            track('trace', 'asked');
            lot = await traceLot(map, { lng: site.lng, lat: site.lat, box: $('#trace'), status });
            track('trace', lot ? 'done' : 'cancelled');
          }
          if (!lot) { status(STEPPED ? 'Trace the property line, then the trees can be built. Press Find to start again.' : 'Trace the property, then it can be built. Press Build to start again.'); return; }
        }
        site.parcel = lotFeature(lot);
      }
      /* A map of its own for an address typed here (docs/MAPS.md): kept on
         the server with the shade map's part, so the dashboard lists it and
         the lawn mapper can open it. A guest at their one map gets the
         message and goes on without saving. */
      if (!id && !site.area && !TREES) {
        const made = await newMap(site, at);
        if (made) site.map = { id: made.id, at: made.at, shade: null };
      }
      const keep = params.get('truth') ? `&truth=${encodeURIComponent(params.get('truth'))}${site.area ? `&area=${params.get('area')}` : ''}` : '';
      const mapId = id || site.map?.id || null;
      history.replaceState(null, '', (mapId ? `?map=${encodeURIComponent(mapId)}` : `?at=${encodeURIComponent(at)}${lot ? `&lot=${lotParam(lot)}` : ''}`) + keep);
      if (STEPPED) {
        view.builtFor = null;
        await offerLot(site, { traced: !!lot && !fromLink });
        if (site.limitNote && $('#lot-note')) $('#lot-note').insertAdjacentHTML('beforeend', site.limitNote);
        if (lot && !fromLink) saveShadePart({ now: true });
        /* A link with the lot in it, a saved map, or a field check: straight on to the trees. */
        if (params.get('truth') || (startup && (id || fromLink || site.parcel))) { view.steps.unlock(2); view.steps.go(2); }
        return;
      }
      await build(site);
    } catch (e) {
      status(e.message || String(e), 'bad');
    } finally {
      $('#go').disabled = false;
    }
  };
  view.steps = startSteps({ onEnter: onStep });
  $('#go').addEventListener('click', () => go());
  $('#at').addEventListener('keydown', (e) => { if (e.key === 'Enter') { $('#saved').value = ''; go(); } });
  $('#at').addEventListener('input', () => { if ($('#at').value.trim()) $('#saved').value = ''; });
  $('#t-points').addEventListener('click', () => { toggle('#t-points'); drawBuilt(view.map, $('#t-fix').getAttribute('aria-pressed') === 'true'); });
  $('#t-fix').addEventListener('click', () => drawBuilt(view.map, toggle('#t-fix')));
  $('#t-picture').addEventListener('click', () => { toggle('#t-picture'); drawBuilt(view.map, $('#t-fix').getAttribute('aria-pressed') === 'true'); });
  $('#t-traced').addEventListener('click', () => { toggle('#t-traced'); drawBuilt(view.map, $('#t-fix').getAttribute('aria-pressed') === 'true'); });
  $('#t-tilt').addEventListener('click', () => {
    const on = toggle('#t-tilt');
    view.map?.easeTo(on ? { pitch: 55, bearing: -20 } : { pitch: 0, bearing: 0 });
  });
  $('#t-trees')?.addEventListener('click', () => { view.trees?.setVisible(toggle('#t-trees')); });
  /* Step 1: trace the line over the county's (or again). */
  $('#fence-add')?.addEventListener('click', () => editFence(null));
  $('#lot-trace')?.addEventListener('click', async () => {
    const site = view.site;
    if (!site || $('#go').disabled) return;
    $('#go').disabled = true;
    try {
      const lot = await traceNow(site);
      if (lot) {
        site.parcel = lotFeature(lot);
        site.lawn = [];
        if (!site.map?.id) history.replaceState(null, '', `?at=${encodeURIComponent($('#at').value.trim() || site.label)}&lot=${lotParam(lot)}`);
        await offerLot(site, { traced: true });
        saveShadePart({ now: true });
      } else await offerLot(site);
    } catch (e) { status(e.message || String(e), 'bad'); } finally { $('#go').disabled = false; }
  });
  if (params.get('map')) {
    /* A map from the dashboard: in the list when it is this visitor's; otherwise go() says so. */
    await savesReady;
    $('#saved').value = params.get('map');
    if (!$('#saved').value) { const o = document.createElement('option'); o.value = params.get('map'); o.textContent = 'This map'; $('#saved').append(o); $('#saved').value = o.value; }
    go(true);
  }
  else if (params.get('at')) { $('#at').value = params.get('at'); go(true); }
  ensureMap().catch((e) => status(`The map would not load: ${e.message}`, 'bad'));
}

main();
globalThis.__shade = view; // for the headless smoke tests only
