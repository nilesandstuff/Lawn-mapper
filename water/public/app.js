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
 * lawn outlines. Nothing is written yet: the water part of a map will hold
 * what a person enters (a soak test, gauge totals, zones), and none of that
 * exists yet. Nothing is kept in the browser.
 */

const $ = (s) => document.querySelector(s);
const R = 6378137;
const view = { photo: null, data: null, frame: null, site: null };
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
    mapId: id,
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

async function photoOf(frame) {
  const q = new URLSearchParams({ lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, height: frame.height, provider: 'mapbox' });
  const res = await fetch(`/api/imagery?${q}`);
  if (!res.ok) throw new Error(`the photo would not load (${res.status})`);
  return createImageBitmap(await res.blob());
}

/** EPSG:3857 -> pixel on the photo. */
function toPx(frame, img, xy) {
  const c = mercToWorld(toMerc([frame.lng, frame.lat]), frame.zoom);
  const w = mercToWorld(xy, frame.zoom);
  const s = img.width / frame.size;
  return [(w[0] - c[0]) * s + img.width / 2, (w[1] - c[1]) * s + img.height / 2];
}

/* -------------------------------------------------------------- drawing */

function overlay(d, { flow = true, grade = true } = {}) {
  const { W, H } = d.grid;
  const img = new ImageData(W, H);
  const px = img.data;
  for (let i = 0; i < W * H; i++) {
    let rgba = null;
    if (d.reported[i] === 2) {
      const t = Math.min(1, d.depth[i] / 0.10);
      rgba = [30, 107, 255, Math.round(110 + 130 * t)];
    } else if (d.reported[i] === 1) rgba = [190, 200, 215, 110]; // not a lawn hollow: pavement, trees, a ditch...
    if (flow && !d.wall[i] && d.flow[i] >= 250) rgba = [34, 211, 238, 220];
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
  if (!d || !photo) return;
  const cv = $('#view');
  cv.width = photo.width; cv.height = photo.height;
  const g = cv.getContext('2d');
  g.fillStyle = '#222'; g.fillRect(0, 0, cv.width, cv.height);
  if ($('#show-photo').checked) g.drawImage(photo, 0, 0);
  else { g.fillStyle = '#3a4440'; g.fillRect(0, 0, cv.width, cv.height); }

  const o = overlay(d, { flow: $('#show-flow').checked, grade: $('#show-grade').checked });
  const tmp = document.createElement('canvas');
  tmp.width = d.grid.W; tmp.height = d.grid.H;
  tmp.getContext('2d').putImageData(o, 0, 0);
  // the grid's corners, moved by the datum correction (real meters -> web-mercator meters)
  const dx = d.shift.east / d.grid.k, dy = d.shift.north / d.grid.k;
  const [x0, y0] = toPx(frame, photo, [d.grid.bbox[0] + dx, d.grid.bbox[3] + dy]);
  const [x1, y1] = toPx(frame, photo, [d.grid.bbox[2] + dx, d.grid.bbox[1] + dy]);
  g.imageSmoothingEnabled = false;
  g.drawImage(tmp, x0, y0, x1 - x0, y1 - y0);

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
}

/* ------------------------------------------------------------- the words */

const inches = (cm) => (cm / 2.54).toFixed(1);
const sqft = (m2) => Math.round(m2 * 10.764).toLocaleString();
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
  const b = s.besideHouse;
  if (b.outlineCells) {
    const verdict = b.towardShare >= 0.25 ? 'A good part of the ground beside the house falls <strong>toward</strong> it.'
      : b.meetsCodeShare >= 0.5 ? `The ground falls away from the house well along most of it${b.towardShare > 0.05 ? ', with a few stretches falling toward it' : ''}.`
        : `The ground beside the house is mostly flatter than the building code asks (a 5% fall away)${b.towardShare > 0.05 ? ', and falls toward it in places' : ''}.`;
    parts.push(`<div class="card"><h2>Beside the house</h2><p>${verdict}</p>
      <p class="dim">Falls toward the house along ${pct(b.towardShare)} of the walls; away by the building code's 5% (6 in over the first 10 ft) along ${pct(b.meetsCodeShare)}. Measured 1.5–10 ft out, on the ground around each point, so a planting bed against the wall is not what is judged.</p></div>`);
  }
  parts.push(`<p class="dim">Survey: ${esc(d.cloud.name.replace(/^USGS_LPC_/, '').replace(/_/g, ' '))}, flown ${flown}${d.cloud.ql ? `, ${esc(d.cloud.ql)}` : ''}. ${s.groundPointsPerM2.toFixed(1)} ground points per square meter; scatter ${inches(s.scatter * 100)} in. Worked out in ${s.seconds.toFixed(0)} s.</p>`);
  if (d.cloud.notOnAws?.length) parts.push('<p class="dim">USGS lists a newer survey here that is not yet readable by this page.</p>');
  $('#report').innerHTML = parts.join('');
}

/* ----------------------------------------------------------------- flow */

let running = null;

async function run(site) {
  running?.terminate();
  view.site = site; view.data = null;
  $('#result').hidden = true;
  status(`Reading the survey for ${site.label}…`);
  const bboxPromise = new Promise((resolve, reject) => {
    const w = new Worker('/analyse.js', { type: 'module' });
    running = w;
    w.onmessage = ({ data }) => {
      if (data.progress) status(`Reading the survey… ${data.progress.done} of ${data.progress.total} pieces`);
      else if (data.error) { w.terminate(); reject(new Error(data.error)); }
      else if (data.done) { w.terminate(); resolve(data.done); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'the analysis stopped')); };
    w.postMessage({ site });
  });
  const d = await bboxPromise;
  status('Fetching the photo…');
  view.frame = frameFor(d.grid.bbox, d.grid.lat);
  view.photo = await photoOf(view.frame).catch(() => null);
  if (!view.photo) { $('#show-photo').checked = false; view.photo = { width: 1280, height: 1280 }; }
  view.data = d;
  $('#result').hidden = false;
  draw();
  report(d, site);
  status('');
  const back = $('#back');
  if (back && site.mapId) back.href = `${HOME}/dashboard?map=${encodeURIComponent(site.mapId)}`;
}

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

for (const id of ['#show-flow', '#show-grade', '#show-photo']) $(id).addEventListener('change', draw);

if (mapId) guarded(async () => { status('Opening your map…'); await run(await siteFromMap(mapId)); });
