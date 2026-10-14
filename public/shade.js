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
 */

import { pointsIn, toMerc, fromMerc, mercScale } from './shade/ept.js';
import { lazDecoder, browserFactory } from './shade/laz.js';
import { nad83Correction } from './shade/datum.js';
import { alignToPhoto } from './shade/align.js';
import { gridOver, gridForFrame, gridBox, rasterise, fillGaps, greyPicture, blurNaN, resample, cellOf, quantile } from './shade/grid.js';
import { pointLayer } from './shade/view3d.js';
import { frameCorners } from './lib/mercator.js';
import { movedCorners } from './lib/align.js';
import { tracedOn, lineUpAt } from './shade/traced.js';
import { startSun } from './shade/sun-ui.js';
import { track, reportError, watchErrors, setPlace } from './shade/usage.js';
import { traceLot, lotFeature, lotParam, parseLot } from './shade/trace.js';

const $ = (s) => document.querySelector(s);
const SAVES_KEY = 'lawnmapper.saves.v1'; // the editor's own local store (app.js), read only
const MARGIN_M = 50;
const ALIGN_M = 140; // the photo frame the match runs on, at least this wide

const view = { map: null, site: null, built: null };

function status(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${cls}`;
  /* Every message shown as a failure is one a visitor saw (shade/usage.js). */
  if (cls === 'bad' && !/^No public lidar/.test(text)) reportError('status', text); // no lidar is an answer, counted as usage
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
    tracedOn: tracedOn(s),
  };
}

/**
 * A typed address, as the editor finds one (owner, 2026-10-12): the
 * geocoder's pick, the county's property line for it, and the county photo
 * when the Worker has one sharp enough here (its list comes best first, as
 * the editor takes it), shown where the county put it -- the lidar is then
 * lined up on that photo's ground.
 */
async function siteFromAddress(r) {
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

async function getBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.arrayBuffer();
}

const io = { getJson, getBytes, decompress: lazDecoder(() => browserFactory()) };

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
  view.sun = null;
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
  if (!clouds.length) {
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
  const t = site.tracedOn || { provider: 'mapbox' };
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
  const onMapbox = await match('mapbox');
  let onCounty = t.provider === 'county' ? await match('county', t.svc) : null;
  /* A typed address: a county photo with gaps over this frame gives way to
     the next on the Worker's list, then to Mapbox (the editor's rule), and
     each one passed over is logged for the core's county-photo report. */
  if (t.list) {
    let i = 0;
    while (onCounty && (onCounty.error || missingShare(onCounty.photo) > 0.02)) {
      reportCountyFailure(site, frame, t.list[i], onCounty.error ? 'refused' : 'gaps', onCounty.error || `${Math.round(100 * missingShare(onCounty.photo))}% of the frame missing`, t.list.map((x) => x.id));
      i++;
      if (i >= t.list.length) { onCounty = null; t.provider = 'mapbox'; break; }
      t.svc = t.list[i].id; t.title = t.list[i].title || null;
      onCounty = await match('county', t.svc);
    }
  }
  const move = t.provider === 'county' ? lineUpAt(t, [frame.lng, frame.lat]) : { east: 0, north: 0 };
  let used, usedName;
  if (onCounty && !onCounty.error) {
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
  if (onMapbox.error) report.push(`<p class="warn">${esc(onMapbox.error)}</p>`);
  const residual = fit?.confident ? [fit.east / k, fit.north / k] : [0, 0];
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
  map.easeTo({ pitch: 55, bearing: -20, duration: 800 });

  /* The report. */
  const u = cloud.unit;
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '?');
  report.unshift(`
    <h2>The lidar</h2>
    <table>
      <tr><td>Cloud</td><td>${esc(cloud.name)}${cloud.confirmed ? '' : ' <span class="warn">(box match only: USGS did not confirm it flew this point)</span>'}</td></tr>
      ${u ? `<tr><td>Flown</td><td>${day(u.start)} to ${day(u.end)}, ${esc(u.ql || '?')}, ${u.season === 'off' ? '<span class="warn">leaf-off</span>' : u.season === 'on' ? 'leaf-on' : u.season === 'mixed' ? '<span class="warn">part leaf-off</span>' : 'season unknown'}</td></tr>` : ''}
      <tr><td>Points</td><td>${cols.n.toLocaleString()} within ${MARGIN_M} m of the lot; ${(inLot / lotM2).toFixed(1)} a square meter over the lot</td></tr>
      ${notOnAws.length ? `<tr><td>Also flown</td><td class="warn">${notOnAws.map((x) => `${esc(x.workunit)} (${day(x.end)}, ${esc(x.ql || '?')})`).join('; ')} — not in the public cloud store, so not read</td></tr>` : ''}
    </table>
    <h2>Lining it up</h2>
    <table>
      <tr><td>Datum (NAD83 → map)</td><td>${fmtMove(datum.east, datum.north)} <span class="dim">computed, epoch ${cloud.epoch.toFixed(1)}</span></td></tr>
      <tr><td>Matched against</td><td>${esc(usedName)}</td></tr>
      ${t.provider === 'county' && t.align ? `<tr><td>Editor's line-up</td><td class="dim">${fmtMove(move.east, move.north)} at this frame's center (saved ${t.align.east.toFixed(2)} E, ${t.align.north.toFixed(2)} N, scale ${t.align.scale})</td></tr>` : ''}
      <tr><td>Left over, measured</td><td>${fit ? `${fmtMove(fit.east, fit.north)} <span class="${fit.confident ? 'ok' : 'warn'}">${esc(fit.why)}</span>` : '<span class="bad">not measured</span>'}</td></tr>
      ${fit ? `<tr><td>Quarters alone</td><td class="dim">${fit.quarters.map((q) => (q ? fmtMove(q.east, q.north) : '—')).join(' · ')}</td></tr>` : ''}
      ${fit ? `<tr><td>Open ground that voted</td><td class="dim">${Math.round(fit.openShare * 100)}% of a ${Math.round(gridForFrame(frame, 1, 1).cell * k)} m frame; match ${fit.score?.toFixed(2)} against ${fit.second?.toFixed(2)} for the best rival</td></tr>` : ''}
      ${onCounty && !onCounty.error && onMapbox.fit ? `<tr><td>Cross-check: Mapbox</td><td class="dim">${fmtMove(onMapbox.fit.east, onMapbox.fit.north)} (${esc(onMapbox.fit.why)})${onMapbox.fit.confident && fit.confident ? `; ${Math.hypot(onMapbox.fit.east - fit.east, onMapbox.fit.north - fit.north).toFixed(2)} m from the answer above` : ''}</td></tr>` : ''}
      <tr><td><b>Applied</b></td><td><b>${fmtMove(datum.east + (fit?.confident ? fit.east : 0), datum.north + (fit?.confident ? fit.north : 0))}</b> ${fit?.confident ? '<span class="ok">datum + measured</span>' : '<span class="warn">datum only</span>'}</td></tr>
    </table>
    <p class="dim">Roofs and crowns will NOT sit exactly on the photo's: the photo was taken at an angle, so tall
    things lean in it by up to a meter or two, and the laser measures them where they stand.
    The ground is what has to agree. "Lined up" off shows the cloud where the file puts it. "Lidar ground picture" lays the laser's view of the ground over the photo to compare by eye: roads, drives and paths should sit exactly on the photo's.</p>`);
  $('#report').innerHTML = report.join('');
  status(fit?.confident ? 'Built and lined up.' : 'Built. The photo check was not tight enough to apply; the datum correction is applied.', fit?.confident ? 'ok' : 'warn');
  track('built', `${Math.round((Date.now() - started) / 1000)} s, ${fit?.confident ? 'lined up' : 'not lined up'}`);

  /* Step 2: the sun over this model, in a worker (shade/sun-ui.js). */
  view.sun = startSun({
    map, site, cols, box, shift, heightM: baseZ, season: cloud.unit?.season,
    beforeLayer: () => (map.getLayer('parcel') ? 'parcel' : undefined),
  });
  /* A visit's field readings, when the readings page sent us here (admin). */
  const truth = new URLSearchParams(location.search).get('truth');
  if (truth) import('./shade/truth-ui.js').then((m) => m.startTruth({ map, sun: view.sun, spec: truth, bounds: siteBounds(site) })).catch((e) => status(e.message, 'bad'));
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
  const go = async () => {
    if ($('#go').disabled) return; // one at a time: Enter while tracing or building waits
    $('#go').disabled = true;
    try {
      const id = $('#saved').value;
      if (id) await savesReady;
      const at = $('#at').value.trim();
      let site = null;
      setPlace(id ? { place: `saved map ${id}` } : at ? { place: at } : null);
      if (id) { site = siteFromSave(saves.find((s) => s.id === id)); track('search', 'saved map'); }
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
      if (!id && !site.parcel && !site.area) {
        lot = (params.get('at') === at && parseLot(params.get('lot'))) || null;
        if (!lot) {
          view.sun?.stop(); view.sun = null;
          const map = await ensureMap();
          removeBuilt(map);
          for (const g of ['parcel', 'lawn']) map.getSource(g)?.setData({ type: 'FeatureCollection', features: [] });
          $('#toggles').hidden = true;
          track('trace', 'asked');
          lot = await traceLot(map, { lng: site.lng, lat: site.lat, box: $('#trace'), status });
          track('trace', lot ? 'done' : 'cancelled');
          if (!lot) { status('Trace the property, then it can be built. Press Build to start again.'); return; }
        }
        site.parcel = lotFeature(lot);
      }
      const keep = params.get('truth') ? `&truth=${encodeURIComponent(params.get('truth'))}${site.area ? `&area=${params.get('area')}` : ''}` : '';
      history.replaceState(null, '', (id ? `?map=${encodeURIComponent(id)}` : `?at=${encodeURIComponent(at)}${lot ? `&lot=${lotParam(lot)}` : ''}`) + keep);
      await build(site);
    } catch (e) {
      status(e.message || String(e), 'bad');
    } finally {
      $('#go').disabled = false;
    }
  };
  $('#go').addEventListener('click', go);
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
  if (params.get('map')) { await savesReady; $('#saved').value = params.get('map'); if ($('#saved').value) go(); }
  else if (params.get('at')) { $('#at').value = params.get('at'); go(); }
  ensureMap().catch((e) => status(`The map would not load: ${e.message}`, 'bad'));
}

main();
