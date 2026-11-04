/**
 * SOIL MOISTURE READINGS IN THE FIELD (water session; owner, 2026-11-02): "I tap a location button, it pulls my gps
 * to see which property I'm at (and I can move the pin if needed), all that's loaded is the aerial imagery. I can
 * zoom/pan and then tap a dot, then it prompts me for the reading, and I move on to the next one. Then I save it."
 *
 * The property: the phone's position, then the county property line there (Lawn Mapper's /api/parcel), then a
 * saved map on it if there is one (/api/maps). The photo: THE ONE THE LAWN WAS TRACED ON when a saved map is here
 * (the county photo, lined up as the editor left it, with the traced lawn drawn over it; owner, 2026-11-04: dots
 * put on Mapbox's photo sat half a meter off the trace), else one Mapbox frame round the property line.
 * The readings: a draft on this phone until saved (so a dead spot in the signal loses nothing), then the water
 * Worker's database (src/moisture.js), the visit saved again whole each time. Earlier visits' spots are drawn as grey
 * rings: a reading taken on one keeps that spot's id, so the same spot can be followed from visit to visit.
 */

import { tracedOn, lineUpAt } from '/lib/shade/traced.js';

const $ = (s) => document.querySelector(s);
const R = 6378137;
const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];
const fromMerc = ([x, y]) => [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
const worldSize = (zoom) => 512 * 2 ** zoom;
const mercToWorld = ([x, y], zoom) => [((x + Math.PI * R) / (2 * Math.PI * R)) * worldSize(zoom), ((Math.PI * R - y) / (2 * Math.PI * R)) * worldSize(zoom)];
const worldToMerc = ([wx, wy], zoom) => [(wx / worldSize(zoom)) * 2 * Math.PI * R - Math.PI * R, Math.PI * R - (wy / worldSize(zoom)) * 2 * Math.PI * R];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const DRAFT = 'moisture-draft-v1', SETUP = 'moisture-setup-v1';
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } } };

const st = {
  property: null,   // { lng, lat, pin, county, label, ring: [[lng, lat]...] | null, mapId, lawn: [rings] | null, tracedOn }
  frame: null, photo: null, photoShift: [0, 0], placedOn: 'mapbox',
  view: { s: 1, ox: 0, oy: 0 },
  visit: null,      // { id, at, dots: [{ n, spot, lng, lat, value, note, at }], savedAt, savedCount }
  old: [],          // earlier spots here: { spot, lng, lat, value, at }
  me: null,         // { lng, lat, acc }
  movingPin: false,
};

/* ---------------------------------------------------------------- the meter's setup, kept on the phone */
const setup = { meter: '', unit: 'scale', depth: '', ...(store.get(SETUP) || {}) }; // most hand meters under $200 read a relative %, not true water content
$('#meter').value = setup.meter; $('#unit').value = setup.unit; $('#depth').value = setup.depth;
for (const id of ['meter', 'unit', 'depth']) $(`#${id}`).addEventListener('change', () => { setup[id] = $(`#${id}`).value; store.set(SETUP, setup); });
if (!setup.meter) $('#setup').open = true;
const unitWord = () => (setup.unit === 'vwc' ? '%' : '');

/* ---------------------------------------------------------------- status */
function say(text, bad = false) { const el = $('#status'); el.textContent = text; el.classList.toggle('bad', bad); }
function hint(text) { $('#hint').textContent = text || ''; }

/* ---------------------------------------------------------------- where am I */
function position() {
  return new Promise((ok, no) => {
    if (!navigator.geolocation) return no(new Error('this browser gives no location'));
    navigator.geolocation.getCurrentPosition((p) => ok({ lng: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy }),
      (e) => no(new Error(e.code === 1 ? 'location is blocked for this site: allow it in the browser\'s settings' : 'no location fix yet: try again in the open')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
  });
}
let watching = null;
function watchMe() {
  if (watching !== null || !navigator.geolocation) return;
  watching = navigator.geolocation.watchPosition((p) => { st.me = { lng: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy }; draw(); }, () => {}, { enableHighAccuracy: true, maximumAge: 3000 });
}

/* ---------------------------------------------------------------- the property */
const inRing = (pt, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
const outerRing = (g) => (g?.type === 'Polygon' ? g.coordinates[0] : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]).sort((a, b) => b.length - a.length)[0] : null);
const metres = (a, b) => { const k = Math.cos((a[1] * Math.PI) / 180); return Math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 111320); };

async function propertyAt(lng, lat) {
  const out = { lng, lat, pin: null, county: null, label: null, ring: null, mapId: null, lawn: null, tracedOn: null };
  try {
    const r = await fetch(`/api/parcel?lng=${lng}&lat=${lat}`);
    const j = r.ok ? await r.json() : null;
    const f = j?.parcel;
    if (f?.geometry) {
      out.ring = outerRing(f.geometry);
      out.pin = f.properties?.pin || null; out.county = f.properties?.countyKey || f.properties?.county || null;
      // the address is shown on this screen only, to confirm the place; it is never sent or kept
      out.label = [f.properties?.address, f.properties?.county].filter(Boolean).join(', ') || null;
    }
  } catch { /* no property line: the point alone */ }
  try {
    const r = await fetch('/api/maps');
    const maps = r.ok ? (await r.json())?.maps || [] : [];
    const near = maps.filter((m) => Number.isFinite(m.lng) && Number.isFinite(m.lat))
      .map((m) => ({ m, d: metres([lng, lat], [m.lng, m.lat]), inside: out.ring ? inRing([m.lng, m.lat], out.ring) : false }))
      .filter((x) => x.inside || x.d < 40).sort((a, b) => b.inside - a.inside || a.d - b.d)[0];
    if (near) out.mapId = near.m.id;
    if (out.mapId) {
      // the saved map itself: the traced lawn, and the photo it was traced on
      const one = await fetch(`/api/maps/one?id=${encodeURIComponent(out.mapId)}`);
      const m = one.ok ? (await one.json())?.map : null;
      if (m) {
        out.tracedOn = tracedOn(m);
        out.lawn = (m.shapes || []).map((f) => f?.geometry || f).flatMap((g) => (g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [])).flat();
      }
    }
  } catch { /* signed out, or no maps */ }
  return out;
}

async function earlierAt(pin) {
  if (!pin) return [];
  try {
    const r = await fetch(`/api/water/moisture?pin=${encodeURIComponent(pin)}`);
    return r.ok ? (await r.json()).visits || [] : [];
  } catch { return []; }
}

function frameFor(p) {
  const pts = p.ring || [[p.lng, p.lat]];
  const xs = pts.map((q) => toMerc(q)[0]), ys = pts.map((q) => toMerc(q)[1]);
  const k = Math.cos((p.lat * Math.PI) / 180), pad = (p.ring ? 20 : 40) / k;
  const box = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  const spanM = Math.max(box[2] - box[0], box[3] - box[1]) * k, mPerPxZ0 = (2 * Math.PI * R * k) / 512;
  const zoom = Math.max(15, Math.min(20, Math.floor(Math.log2((1280 * mPerPxZ0) / spanM) * 100) / 100));
  const [lng, lat] = fromMerc([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
  return { lng, lat, zoom, size: 1280, height: 1280 };
}
async function photoOf(f, provider = 'mapbox', svc = null) {
  const q = new URLSearchParams({ lng: f.lng, lat: f.lat, zoom: f.zoom, size: f.size, height: f.height, provider });
  if (svc != null) q.set('svc', svc);
  const r = await fetch(`/api/imagery?${q}`);
  if (!r.ok) throw new Error(`the ${provider === 'county' ? 'county' : 'Mapbox'} photo would not load (${r.status})`);
  return createImageBitmap(await r.blob());
}

/** The photo the lawn was traced on, as the water map shows it (app.js savedPhoto): the county photo moved by the
 *  editor's line-up, else Mapbox's. -> { photo, shift: [px, py], placedOn, name } */
async function savedPhoto(f, t) {
  if (t?.provider === 'county') {
    try {
      const photo = await photoOf(f, 'county', t.svc);
      const move = lineUpAt(t, [f.lng, f.lat]);
      const k = Math.cos((f.lat * Math.PI) / 180), s = (worldSize(f.zoom) / (2 * Math.PI * R)) * (photo.width / f.size);
      return { photo, shift: [(move.east / k) * s, -(move.north / k) * s], placedOn: `county:${t.svc}`, name: 'the county photo the lawn was traced on' };
    } catch (e) { hint(e.message); }
  }
  return { photo: await photoOf(f), shift: [0, 0], placedOn: 'mapbox', name: t?.provider === 'county' ? "Mapbox's photo (the county photo would not load)" : "Mapbox's photo" };
}

async function load(lng, lat, { keepVisit = false } = {}) {
  hint(''); say('Finding the property line…');
  const p = await propertyAt(lng, lat);
  st.property = p;
  say(p.ring ? `${p.label || 'Property found'}${p.pin ? ` (parcel ${p.pin})` : ''}${p.mapId ? ' · a saved map is on it' : ''}` : 'No county property line here: readings keep their place on the photo alone.');
  st.frame = frameFor(p);
  hint('Loading the photo…');
  try { const sp = await savedPhoto(st.frame, p.tracedOn); st.photo = sp.photo; st.photoShift = sp.shift; st.placedOn = sp.placedOn; hint(''); if (p.lawn?.length) say(`${$('#status').textContent} · ${sp.name}, the traced lawn in green`); } catch (e) { st.photo = null; hint(e.message); }
  if (!keepVisit || !st.visit) newVisit();
  else saveDraft();
  const visits = await earlierAt(p.pin);
  st.old = oldSpots(visits.filter((v) => v.id !== st.visit.id));
  earlierCard(visits.filter((v) => v.id !== st.visit.id));
  $('#movepin').disabled = false; $('#newvisit').disabled = false; $('#marktrunk').disabled = false;
  fit(); refresh();
  if (!$('#hint').textContent) hint('Tap the lawn where you took a reading.');
}

function oldSpots(visits) {
  const by = new Map();
  for (const v of visits) for (const r of v.readings || []) {
    const key = r.spot || r.id, prev = by.get(key);
    if (!prev || r.at > prev.at) by.set(key, { spot: r.spot || r.id, lng: r.lng, lat: r.lat, value: r.value, at: r.at, unit: v.unit });
  }
  return [...by.values()];
}
function earlierCard(visits) {
  const el = $('#earlier');
  if (!visits.length) { el.hidden = true; return; }
  el.hidden = false;
  const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  el.innerHTML = `<strong>Earlier visits here</strong><ul class="small" style="margin:4px 0;padding-left:20px">${visits.slice(-8).reverse().map((v) => `<li>${day(v.at)}: ${v.readings.length} reading${v.readings.length === 1 ? '' : 's'}${v.unit === 'vwc' ? ` (${Math.min(...v.readings.map((r) => r.value))}–${Math.max(...v.readings.map((r) => r.value))}%)` : ''}</li>`).join('')}</ul>`;
}

/* ---------------------------------------------------------------- the visit and its draft */
function newVisit() {
  st.visit = { id: uid(), at: Date.now(), dots: [], marks: [], savedAt: null, savedCount: 0 };
  $('#weather').value = ''; $('#vnote').value = '';
  saveDraft(); refresh();
}
function saveDraft() {
  if (!st.visit || !st.property) return;
  store.set(DRAFT, { property: st.property, visit: st.visit, weather: $('#weather').value, note: $('#vnote').value });
}
$('#weather').addEventListener('change', () => { if (st.visit) st.visit.dirty = true; saveDraft(); refresh(); });
$('#vnote').addEventListener('change', () => { if (st.visit) st.visit.dirty = true; saveDraft(); refresh(); });
const unsaved = () => !!st.visit && (st.visit.dots.length > 0 || (st.visit.marks || []).length > 0) && (st.visit.dirty || st.visit.savedCount !== st.visit.dots.length);

function refresh() {
  const v = st.visit, n = v ? v.dots.length : 0;
  const nm = (v?.marks || []).length;
  $('#count').textContent = [n ? `${n} reading${n === 1 ? '' : 's'}` : '', nm ? `${nm} trunk${nm === 1 ? '' : 's'} marked` : ''].filter(Boolean).join(', ');
  $('#list').innerHTML = v ? v.dots.map((d, k) => `<li>${d.value}${unitWord()}${d.again ? ' <span class="dim small">(same spot as before)</span>' : ''}${d.note ? ` <span class="dim small">${esc(d.note)}</span>` : ''}<button class="plain" data-k="${k}">edit</button></li>`).join('') : '';
  $('#save').disabled = !unsaved();
  $('#save').textContent = !n && !nm ? 'Save readings' : unsaved() ? `Save ${n ? `${n} reading${n === 1 ? '' : 's'}` : ''}${n && nm ? ' and ' : ''}${nm ? `${nm} trunk${nm === 1 ? '' : 's'}` : ''}` : 'Saved';
  $('#saved').textContent = v?.savedAt ? `Saved at ${new Date(v.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${unsaved() ? ': newer readings are on this phone only until you save again.' : '.'}` : n ? 'On this phone only until saved.' : '';
  draw();
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
$('#list').addEventListener('click', (e) => { const k = e.target?.dataset?.k; if (k !== undefined) ask({ edit: Number(k) }); });

/* ---------------------------------------------------------------- the reading dialog */
let asking = null;
function ask(what) {
  asking = what;
  const v = st.visit, d = what.edit !== undefined ? v.dots[what.edit] : null;
  $('#asktitle').textContent = d ? `Reading ${d.n}` : `Reading ${v.dots.length + 1}`;
  $('#askwhere').textContent = what.old ? `The spot read on ${new Date(what.old.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} (${what.old.value}${what.old.unit === 'vwc' ? '%' : ''} then)` : setup.unit === 'vwc' ? '% water by volume' : setup.unit === 'scale' ? "the meter's own % or scale" : '';
  $('#val').value = d ? d.value : ''; $('#rnote').value = d?.note || '';
  $('#askdel').hidden = !d;
  $('#ask').showModal();
  setTimeout(() => $('#val').focus(), 50);
}
$('#ask').addEventListener('close', () => {
  const how = $('#ask').returnValue, w = asking; asking = null;
  if (!w || how === 'cancel') return;
  const v = st.visit;
  if (how === 'delete' && w.edit !== undefined) { v.dots.splice(w.edit, 1); v.dots.forEach((d, k) => { d.n = k + 1; }); v.dirty = true; }
  else if (how === 'ok') {
    const value = Number($('#val').value);
    if (!Number.isFinite(value) || $('#val').value === '') return;
    if (setup.unit === 'vwc' && (value < 0 || value > 100)) { say(`${value}% is not a soil moisture: not kept.`, true); return; }
    const note = $('#rnote').value.trim() || null;
    if (w.edit !== undefined) Object.assign(v.dots[w.edit], { value, note });
    else v.dots.push({ n: v.dots.length + 1, spot: w.old ? w.old.spot : uid(), again: !!w.old, lng: w.lng, lat: w.lat, value, note, at: Date.now() });
    v.dirty = true;
  }
  saveDraft(); refresh();
});

/* ---------------------------------------------------------------- saving */
$('#save').addEventListener('click', async () => {
  const v = st.visit, p = st.property;
  if (!v || !p || (!v.dots.length && !(v.marks || []).length)) return;
  $('#save').disabled = true; $('#save').textContent = 'Saving…';
  const weather = $('#weather').value ? { lastTwoDays: $('#weather').value } : null;
  const body = { id: v.id, at: v.at, lng: p.lng, lat: p.lat, parcel_pin: p.pin, county: p.county, map_id: p.mapId, placed_on: st.placedOn, meter: setup.meter || null, unit: setup.unit, depth_in: setup.depth === '' ? null : Number(setup.depth), note: $('#vnote').value.trim() || null, weather, readings: v.dots.map(({ n, spot, lng, lat, value, note, at }) => ({ n, spot, lng, lat, value, note, at })), marks: (v.marks || []).map(({ kind, lng, lat, note }) => ({ kind, lng, lat, note })) };
  try {
    const r = await fetch('/api/water/moisture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `the server said ${r.status}`);
    v.savedAt = Date.now(); v.savedCount = v.dots.length; v.dirty = false;
    saveDraft(); say(`Saved ${j.readings} reading${j.readings === 1 ? '' : 's'}${j.marks ? ` and ${j.marks} trunk${j.marks === 1 ? '' : 's'}` : ''}.`);
  } catch (e) {
    say(`Not saved (${e.message}). The readings are kept on this phone: try again when there is signal.`, true);
  }
  refresh();
});
$('#newvisit').addEventListener('click', () => {
  if (unsaved() && !confirm('This visit has readings that are not saved. Start a new one anyway?')) return;
  newVisit(); say('A new visit: tap the lawn where you take each reading.');
});
window.addEventListener('beforeunload', (e) => { if (unsaved()) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------------------------------------------------------- finding the property */
$('#locate').addEventListener('click', async () => {
  if (unsaved() && !confirm('This visit has readings that are not saved. Find the property again anyway? (They stay on this phone.)')) return;
  $('#locate').disabled = true;
  say('Asking the phone where it is…');
  try {
    const p = await position();
    st.me = p; watchMe();
    say(`Found you (to about ${Math.round(p.acc * 3.28084)} ft).`);
    await load(p.lng, p.lat);
  } catch (e) { say(e.message, true); }
  $('#locate').disabled = false;
});
$('#marktrunk').addEventListener('click', () => {
  st.marking = !st.marking; st.movingPin = false; $('#movepin').classList.remove('on');
  $('#marktrunk').classList.toggle('on', st.marking);
  hint(st.marking ? 'Tap where each tree trunk stands (tap a brown dot again to remove it). Tap the button again when done.' : '');
});
$('#movepin').addEventListener('click', () => {
  st.movingPin = !st.movingPin;
  $('#movepin').classList.toggle('on', st.movingPin);
  hint(st.movingPin ? 'Tap where the property is.' : '');
});

/* ---------------------------------------------------------------- the map: photo pixels <-> places */
const cv = $('#map'), ctx = cv.getContext('2d');
function pxOf([lng, lat]) {
  const f = st.frame, w = st.photo?.width || f.size, s = w / f.size;
  const c = mercToWorld(toMerc([f.lng, f.lat]), f.zoom), p = mercToWorld(toMerc([lng, lat]), f.zoom);
  return [(p[0] - c[0]) * s + w / 2, (p[1] - c[1]) * s + (st.photo?.height || f.height) / 2];
}
function placeOf([x, y]) {
  const f = st.frame, w = st.photo?.width || f.size, s = w / f.size;
  const c = mercToWorld(toMerc([f.lng, f.lat]), f.zoom);
  return fromMerc(worldToMerc([c[0] + (x - w / 2) / s, c[1] + (y - (st.photo?.height || f.height) / 2) / s], f.zoom));
}
const screenOf = ([x, y]) => [st.view.ox + x * st.view.s, st.view.oy + y * st.view.s];
const photoAt = ([sx, sy]) => [(sx - st.view.ox) / st.view.s, (sy - st.view.oy) / st.view.s];

function size() {
  const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  ctx.setTransform(d, 0, 0, d, 0, 0);
  return r;
}
function fit() {
  const r = size();
  if (!st.frame) return;
  const pts = (st.property?.ring || [[st.property.lng, st.property.lat]]).map(pxOf);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const bw = Math.max(80, Math.max(...xs) - Math.min(...xs)), bh = Math.max(80, Math.max(...ys) - Math.min(...ys));
  const s = Math.min(r.width / bw, r.height / bh) * 0.85;
  st.view.s = s; st.view.ox = r.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * s; st.view.oy = r.height / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * s;
  draw();
}
function zoomAt(k, sx, sy) {
  const s = Math.max(0.05, Math.min(12, st.view.s * k)); k = s / st.view.s;
  st.view.ox = sx - (sx - st.view.ox) * k; st.view.oy = sy - (sy - st.view.oy) * k; st.view.s = s; draw();
}

function draw() {
  const r = cv.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (!st.frame) { ctx.fillStyle = '#cfd8d3'; ctx.font = '15px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Tap “Find this property” to start', r.width / 2, r.height / 2); return; }
  const { s, ox, oy } = st.view;
  if (st.photo) ctx.drawImage(st.photo, ox + st.photoShift[0] * s, oy + st.photoShift[1] * s, st.photo.width * s, st.photo.height * s);
  // the traced lawn, when a saved map is here: the line the readings are judged against
  for (const ring of st.property?.lawn || []) {
    ctx.beginPath(); ring.forEach((q, k) => { const [x, y] = screenOf(pxOf(q)); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(105,240,174,.95)'; ctx.stroke();
  }
  // the property line
  if (st.property?.ring) {
    ctx.beginPath(); st.property.ring.forEach((q, k) => { const [x, y] = screenOf(pxOf(q)); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,214,0,.95)'; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
  }
  // the pin
  { const [x, y] = screenOf(pxOf([st.property.lng, st.property.lat])); ctx.fillStyle = '#e53935'; ctx.beginPath(); ctx.arc(x, y - 14, 7, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(x - 5, y - 10); ctx.lineTo(x, y); ctx.lineTo(x + 5, y - 10); ctx.fill(); }
  // trunks marked on this visit: brown dots
  for (const m of st.visit?.marks || []) {
    const [x, y] = screenOf(pxOf([m.lng, m.lat]));
    ctx.fillStyle = '#6d4c41'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // earlier spots: grey rings with their last value
  const taken = new Set((st.visit?.dots || []).map((d) => d.spot));
  ctx.font = '600 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const o of st.old) {
    if (taken.has(o.spot)) continue;
    const [x, y] = screenOf(pxOf([o.lng, o.lat]));
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = '#e0e0e0'; ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x - 15, y + 13, 30, 14); ctx.fillStyle = '#fff'; ctx.fillText(String(o.value), x, y + 20);
  }
  // this visit's readings
  for (const d of st.visit?.dots || []) {
    const [x, y] = screenOf(pxOf([d.lng, d.lat]));
    ctx.fillStyle = '#ff9800'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.font = '700 12px system-ui'; ctx.fillText(String(d.n), x, y + 0.5);
    ctx.font = '600 11px system-ui'; ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(x - 17, y + 14, 34, 14); ctx.fillStyle = '#fff'; ctx.fillText(`${d.value}${unitWord()}`, x, y + 21);
  }
  // where the phone is
  if (st.me) {
    const [x, y] = screenOf(pxOf([st.me.lng, st.me.lat]));
    const accPx = (st.me.acc / (156543.03 * Math.cos((st.frame.lat * Math.PI) / 180) / 2 ** st.frame.zoom)) * ((st.photo?.width || st.frame.size) / st.frame.size) * s;
    if (accPx > 8) { ctx.fillStyle = 'rgba(33,150,243,.15)'; ctx.beginPath(); ctx.arc(x, y, accPx, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#2196f3'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

/* ---------------------------------------------------------------- touch: drag to pan, pinch to zoom, tap to read */
const ptrs = new Map();
let gesture = null;
const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, local(e));
  if (ptrs.size === 1) gesture = { kind: 'pan', start: local(e), ox: st.view.ox, oy: st.view.oy, moved: false, t: Date.now() };
  else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    gesture = { kind: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: st.view.s, ox: st.view.ox, oy: st.view.oy, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], moved: true };
  }
});
cv.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId) || !gesture) return;
  ptrs.set(e.pointerId, local(e));
  if (gesture.kind === 'pan' && ptrs.size === 1) {
    const [x, y] = local(e), dx = x - gesture.start[0], dy = y - gesture.start[1];
    if (Math.hypot(dx, dy) > 8) gesture.moved = true;
    if (gesture.moved) { st.view.ox = gesture.ox + dx; st.view.oy = gesture.oy + dy; draw(); }
  } else if (gesture.kind === 'pinch' && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = Math.max(0.05, Math.min(12, gesture.s * (d / Math.max(1, gesture.d)))), k = s / gesture.s;
    st.view.s = s; st.view.ox = mid[0] - (gesture.mid[0] - gesture.ox) * k; st.view.oy = mid[1] - (gesture.mid[1] - gesture.oy) * k; draw();
  }
});
const end = (e) => {
  if (!ptrs.has(e.pointerId)) return;
  const at = local(e);
  ptrs.delete(e.pointerId);
  if (gesture?.kind === 'pan' && !gesture.moved && ptrs.size === 0 && Date.now() - gesture.t < 700) tap(at);
  if (ptrs.size === 0) gesture = null;
  else if (ptrs.size === 1) { const [p] = [...ptrs.values()]; gesture = { kind: 'pan', start: p, ox: st.view.ox, oy: st.view.oy, moved: true, t: 0 }; }
};
cv.addEventListener('pointerup', end);
cv.addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) gesture = null; });
cv.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = local(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, x, y); }, { passive: false });
$('#zin').addEventListener('click', () => { const r = cv.getBoundingClientRect(); zoomAt(1.5, r.width / 2, r.height / 2); });
$('#zout').addEventListener('click', () => { const r = cv.getBoundingClientRect(); zoomAt(1 / 1.5, r.width / 2, r.height / 2); });
$('#me').addEventListener('click', () => {
  if (!st.me || !st.frame) { say('No location yet: tap "Find this property".'); return; }
  const r = cv.getBoundingClientRect(), [x, y] = pxOf([st.me.lng, st.me.lat]);
  st.view.ox = r.width / 2 - x * st.view.s; st.view.oy = r.height / 2 - y * st.view.s; draw();
});

async function tap(at) {
  if (!st.frame) return;
  const place = placeOf(photoAt(at));
  if (st.movingPin) {
    st.movingPin = false; $('#movepin').classList.remove('on'); hint('');
    // readings already taken stay with this visit (the pin is usually moved off a neighbour's lot at the start)
    await load(place[0], place[1], { keepVisit: !!st.visit?.dots.length });
    return;
  }
  const near = (q, px) => { const [x, y] = screenOf(pxOf(q)); return Math.hypot(x - at[0], y - at[1]) <= px; };
  if (st.marking) {
    const v = st.visit; v.marks = v.marks || [];
    const hit = v.marks.findIndex((m) => near([m.lng, m.lat], 18));
    if (hit >= 0) v.marks.splice(hit, 1); else v.marks.push({ kind: 'trunk', lng: place[0], lat: place[1], note: null, at: Date.now() });
    v.dirty = true; saveDraft(); refresh();
    return;
  }
  const mine = (st.visit?.dots || []).findIndex((d) => near([d.lng, d.lat], 20));
  if (mine >= 0) return ask({ edit: mine });
  const taken = new Set((st.visit?.dots || []).map((d) => d.spot));
  const old = st.old.find((o) => !taken.has(o.spot) && near([o.lng, o.lat], 20));
  if (old) return ask({ old, lng: old.lng, lat: old.lat });
  ask({ lng: place[0], lat: place[1] });
}

/* ---------------------------------------------------------------- start: an unsaved draft comes back */
window.addEventListener('resize', () => { if (st.frame) { const r0 = { ...st.view }; size(); st.view = r0; draw(); } else { size(); draw(); } });
size(); draw();
const draft = store.get(DRAFT);
if ((draft?.visit?.dots?.length || draft?.visit?.marks?.length) && draft.property && (draft.visit.dirty || draft.visit.savedCount !== draft.visit.dots.length)) {
  st.visit = draft.visit;
  $('#weather').value = draft.weather || ''; $('#vnote').value = draft.note || '';
  say('Bringing back the readings not yet saved…');
  load(draft.property.lng, draft.property.lat, { keepVisit: true }).then(() => say(`${st.visit.dots.length === 1 ? 'An unsaved reading from earlier is back: save it' : `${st.visit.dots.length} unsaved readings from earlier are back: save them`}, or start a new visit.`));
}
