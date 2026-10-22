/**
 * The route planner's page (route session, 2026-10-22).
 *
 *   1. read the screenshot here, in the browser (Tesseract), into stops
 *   2. let the stops be checked and fixed
 *   3. find each on the map, ask the Worker how long every drive between
 *      them takes, pick the fastest order (lib/solve.js), draw it
 *
 * The shop's address is never in the code: it is typed once (or arrives in
 * the link as #end=...) and kept in this browser and in the page's address,
 * so a bookmark or home-screen icon carries it.
 */

import { addressVariants, formatMinutes, mergeStops, parseWords, sameStreet, slices } from './lib/parse.js';
import { pathCost, solvePath } from './lib/solve.js';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ------------------------------------------------------------ storage */
const store = {
  get(k, d) {
    try { const v = localStorage.getItem(`route.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(`route.${k}`, JSON.stringify(v)); } catch { /* private window: fine */ }
  },
};

let stops = store.get('stops', []);
let startMode = store.get('startMode', 'end');
let result = store.get('result', null);
const geoCache = store.get('geo', {});

/* ------------------------------------------------------------ status */
function say(text, bad = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}
function sayPlan(text, bad = false) {
  say(text, bad);
  $('#plan').textContent = text && !bad ? text : 'Plan fastest route';
}

/* ------------------------------------------------------------ where */
const endInput = $('#end');
function setEnd(v, fromHash = false) {
  endInput.value = v;
  store.set('end', v);
  const url = new URL(location.href);
  url.hash = v ? `end=${encodeURIComponent(v)}` : '';
  if (!fromHash || location.hash !== url.hash) history.replaceState(null, '', url);
}
{
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('end');
  setEnd(fromHash || store.get('end', ''), Boolean(fromHash));
}
endInput.addEventListener('change', () => setEnd(endInput.value.trim()));

function showStartMode() {
  for (const b of document.querySelectorAll('[data-start]')) b.setAttribute('aria-pressed', String(b.dataset.start === startMode));
}
for (const b of document.querySelectorAll('[data-start]')) {
  b.addEventListener('click', () => { startMode = b.dataset.start; store.set('startMode', startMode); showStartMode(); });
}
showStartMode();

/* ------------------------------------------------------------ reading the screenshot */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the text reader. Check the connection and try again.'));
    document.head.append(s);
  });
}

async function readScreenshots(files) {
  const bar = $('#progress');
  bar.hidden = false;
  bar.value = 0;
  say('Loading the text reader…');
  if (!window.Tesseract) await loadScript(TESSERACT);
  let done = 0;
  let total = 1;
  let part = 0;
  const worker = await window.Tesseract.createWorker('eng', 1, {
    logger: (m) => { if (m.status === 'recognizing text') { part = m.progress; bar.value = (done + part) / total; } },
  });
  const lists = [];
  try {
    const images = [];
    for (const f of files) {
      const bmp = await createImageBitmap(f);
      const scale = Math.min(4, Math.max(0.5, 1080 / bmp.width));
      const W = Math.round(bmp.width * scale);
      const H = Math.round(bmp.height * scale);
      images.push({ bmp, scale, W, parts: slices(H) });
    }
    total = images.reduce((a, i) => a + i.parts.length, 0);
    for (const [n, img] of images.entries()) {
      const words = [];
      for (const s of img.parts) {
        say(`Reading screenshot${images.length > 1 ? ` ${n + 1} of ${images.length}` : ''}…`);
        const c = document.createElement('canvas');
        c.width = img.W;
        c.height = s.height;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img.bmp, 0, s.top / img.scale, img.bmp.width, s.height / img.scale, 0, 0, img.W, s.height);
        const { data } = await worker.recognize(c);
        for (const w of data.words || []) {
          const b = { x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0 + s.top, y1: w.bbox.y1 + s.top };
          const cy = (b.y0 + b.y1) / 2;
          if (cy >= s.ownTop && cy < s.ownBottom) words.push({ text: w.text, bbox: b });
        }
        done += 1;
        bar.value = done / total;
      }
      img.bmp.close?.();
      lists.push(parseWords(words, img.W));
    }
  } finally {
    await worker.terminate();
    bar.hidden = true;
  }
  return mergeStops(lists);
}

let nextId = Math.max(0, ...stops.map((s) => s.id || 0)) + 1;
async function pick(files, append) {
  if (!files.length) return;
  try {
    const found = await readScreenshots([...files]);
    const fresh = found.map((s) => ({ id: nextId++, ...s }));
    stops = append ? mergeStops([stops, fresh]) : fresh;
    store.set('stops', stops);
    if (!append) { result = null; store.set('result', null); $('#result').hidden = true; }
    renderStops();
    $('#stopsBox').open = true;
    const timed = fresh.filter((s) => s.minutes != null).length;
    say(found.length
      ? `Found ${found.length} stop${found.length === 1 ? '' : 's'}${timed < found.length ? ` (${found.length - timed} without a time)` : ''}. Check them below.`
      : 'No addresses found in that picture. Is it the job list?', !found.length);
    if (found.length) $('#stopsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    say(e.message || String(e), true);
  }
}
$('#pick').addEventListener('change', (e) => { pick(e.target.files, false); e.target.value = ''; });
$('#pickMore').addEventListener('change', (e) => { pick(e.target.files, true); e.target.value = ''; });

/* ------------------------------------------------------------ the stops, editable */
function jobMinutes(list) {
  return list.reduce((a, s) => a + (Number(s.minutes) || 0), 0);
}

function renderStops() {
  $('#stopsCard').hidden = !stops.length;
  $('#stopCount').textContent = stops.length ? `${stops.length}` : '';
  $('#stops').innerHTML = stops.map((s, i) => `
    <li data-id="${s.id}">
      <span class="n">${i + 1}</span>
      <div class="addr-fields">
        <input type="text" data-k="address" value="${esc(s.address)}" aria-label="Stop ${i + 1} address" placeholder="Street address">
        <input type="text" data-k="city" value="${esc(s.city)}" aria-label="Stop ${i + 1} city" placeholder="City">
        ${s.name ? `<span class="who">${esc(s.name)}${s.service ? ` · ${esc(s.service)}` : ''}</span>` : ''}
      </div>
      <input type="number" inputmode="numeric" min="0" max="999" data-k="minutes" value="${s.minutes ?? ''}" aria-label="Stop ${i + 1} job minutes" placeholder="min">
      <button type="button" class="x" data-remove aria-label="Remove stop ${i + 1}">×</button>
      ${s.error ? `<span class="err">${esc(s.error)}</span>` : ''}
    </li>`).join('');
  $('#jobTotal').textContent = formatMinutes(jobMinutes(stops));
}

$('#stops').addEventListener('input', (e) => {
  const li = e.target.closest('li');
  const s = stops.find((x) => String(x.id) === li?.dataset.id);
  if (!s || !e.target.dataset.k) return;
  const k = e.target.dataset.k;
  s[k] = k === 'minutes' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value;
  delete s.error;
  store.set('stops', stops);
  $('#jobTotal').textContent = formatMinutes(jobMinutes(stops));
});
$('#stops').addEventListener('click', (e) => {
  if (!e.target.closest('[data-remove]')) return;
  const id = e.target.closest('li').dataset.id;
  stops = stops.filter((s) => String(s.id) !== id);
  store.set('stops', stops);
  renderStops();
});
$('#addStop').addEventListener('click', () => {
  stops.push({ id: nextId++, address: '', city: stops.at(-1)?.city || '', name: '', minutes: null, service: '' });
  store.set('stops', stops);
  renderStops();
  const inputs = document.querySelectorAll('#stops input[data-k="address"]');
  inputs[inputs.length - 1]?.focus();
});
$('#clear').addEventListener('click', () => {
  if (!confirm('Clear all stops and the route?')) return;
  stops = [];
  result = null;
  store.set('stops', stops);
  store.set('result', null);
  renderStops();
  $('#result').hidden = true;
  say('');
});

/* ------------------------------------------------------------ planning */
async function call(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `The server said ${res.status}`), { status: res.status });
  return data;
}

async function geocode(q, near) {
  const key = q.toLowerCase().replace(/\s+/g, ' ').trim();
  if (geoCache[key]) return geoCache[key];
  const params = new URLSearchParams({ q });
  if (near) params.set('near', `${near.lng},${near.lat}`);
  try {
    const hit = await call(`/api/geocode?${params}`);
    geoCache[key] = hit;
    const keys = Object.keys(geoCache);
    for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete geoCache[k];
    store.set('geo', geoCache);
    return hit;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** The stop on the map: as read, then with a street type added, until the answer names its street near the shop. */
async function findStop(s, end) {
  let fallback = null;
  for (const a of addressVariants(s.address)) {
    const hit = await geocode([a, s.city].filter(Boolean).join(', '), end);
    if (!hit || km(hit, end) > 80) continue;
    if (sameStreet(hit.label, s.address)) return hit;
    fallback ||= { ...hit, shaky: true };
  }
  return fallback;
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('This browser cannot share its location.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lng: p.coords.longitude, lat: p.coords.latitude, label: 'Your location' }),
      () => reject(new Error('Could not get your location. Allow it, or start at the shop.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

const km = (a, b) => {
  const r = Math.PI / 180;
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * 6371;
};

async function plan() {
  const endQ = endInput.value.trim();
  setEnd(endQ);
  if (!endQ) { say('Type where the day ends first (the shop).', true); endInput.focus(); return; }
  const list = stops.filter((s) => s.address.trim());
  if (!list.length) { say('No stops to route yet.', true); return; }
  const btn = $('#plan');
  btn.disabled = true;
  try {
    sayPlan('Finding the shop…');
    const end = await geocode(endQ, null);
    if (!end) throw new Error(`Could not find "${endQ}" on the map. Add the city and state.`);
    let start = { ...end, label: 'The shop' };
    if (startMode === 'here') {
      sayPlan('Getting your location…');
      start = await locate();
    }
    sayPlan('Finding the stops…');
    const found = [];
    const queue = [...list];
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (queue.length) {
        const s = queue.shift();
        const hit = await findStop(s, end);
        if (!hit) s.error = 'Not found on the map near the shop. Check the spelling, or add Dr / St.';
        else { delete s.error; found.push({ stop: s, hit }); }
      }
    }));
    store.set('stops', stops);
    renderStops();
    found.sort((a, b) => list.indexOf(a.stop) - list.indexOf(b.stop));
    if (!found.length) throw new Error('None of the stops could be found on the map.');
    if (found.length > 60) throw new Error('At most 60 stops at a time.');

    sayPlan('Timing every drive…');
    const points = [start, ...found.map((f) => f.hit), end];
    const ll = (p) => [p.lng, p.lat];
    const { durations, distances } = await call('/api/matrix', { points: points.map(ll) });

    sayPlan('Choosing the order…');
    await new Promise((r) => setTimeout(r, 30));
    const order = solvePath(durations);
    const listed = pathCost(durations, points.map((_, i) => i));
    const best = pathCost(durations, order);

    sayPlan('Drawing the roads…');
    let legs;
    let geometry = null;
    try {
      ({ legs, geometry } = await call('/api/route', { points: order.map((i) => ll(points[i])) }));
    } catch {
      legs = order.slice(1).map((j, k) => ({ duration: durations[order[k]][j], distance: distances[order[k]][j] }));
    }

    result = {
      at: Date.now(),
      startMode,
      start,
      end,
      stops: order.slice(1, -1).map((i) => {
        const { stop, hit } = found[i - 1];
        return { id: stop.id, address: stop.address, city: stop.city, name: stop.name, minutes: stop.minutes, hit };
      }),
      missing: list.filter((s) => s.error).map((s) => ({ address: s.address, minutes: s.minutes })),
      legs,
      geometry,
      saved: Math.max(0, listed - best),
      done: [],
    };
    store.set('result', result);
    sayPlan('');
    renderResult(true);
  } catch (e) {
    sayPlan('');
    say(e.message || String(e), true);
  } finally {
    btn.disabled = false;
    $('#plan').textContent = 'Plan fastest route';
  }
}
$('#plan').addEventListener('click', plan);

/* ------------------------------------------------------------ the answer */
const miles = (m) => `${(m / 1609.344).toFixed(m < 16093 ? 1 : 0)} mi`;
const mins = (s) => `${Math.max(1, Math.round(s / 60))} min`;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function googleLinks(r) {
  // up to 9 waypoints between an origin and a destination, consecutive trips sharing a stop
  const seq = [r.startMode === 'here' ? null : r.end.label, ...r.stops.map((s) => s.hit.label), r.end.label];
  const out = [];
  for (let a = 0; a < seq.length - 1; a += 10) {
    const b = Math.min(seq.length - 1, a + 10);
    const p = new URLSearchParams({ api: '1', destination: seq[b], travelmode: 'driving' });
    if (seq[a]) p.set('origin', seq[a]);
    const way = seq.slice(a + 1, b);
    if (way.length) p.set('waypoints', way.join('|'));
    const from = a === 0 ? 'Start' : `Stop ${a}`;
    const to = b === seq.length - 1 ? 'the shop' : `stop ${b}`;
    out.push(`<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?${p}">${from} → ${to}</a>`);
  }
  return out.join('');
}

let map = null;
function drawMap(r) {
  if (!window.L) { $('#map').closest('.card').hidden = true; return; }
  if (!map) {
    map = window.L.map('map', { zoomControl: true, attributionControl: true });
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  } else {
    map.eachLayer((l) => { if (!(l instanceof window.L.TileLayer)) map.removeLayer(l); });
  }
  const pin = (p, text, home) => window.L.marker([p.lat, p.lng], {
    icon: window.L.divIcon({ className: `pin${home ? ' home' : ''}`, html: text, iconSize: [26, 26], iconAnchor: [13, 13] }),
  }).addTo(map);
  const line = r.geometry
    ? r.geometry.map(([lng, lat]) => [lat, lng])
    : [r.start, ...r.stops.map((s) => s.hit), r.end].map((p) => [p.lat, p.lng]);
  window.L.polyline(line, { color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1f7a4d', weight: 5, opacity: 0.85 }).addTo(map);
  if (km(r.start, r.end) > 0.05) pin(r.start, 'S', true);
  pin(r.end, '⌂', true);
  r.stops.forEach((s, i) => pin(s.hit, String(i + 1)));
  map.fitBounds(window.L.latLngBounds(line), { padding: [20, 20] });
}

function renderResult(scroll = false) {
  const r = result;
  $('#result').hidden = !r;
  if (!r) return;
  const allStops = [...r.stops, ...r.missing];
  const jobs = jobMinutes(allStops);
  const driveS = r.legs.reduce((a, l) => a + (l.duration || 0), 0);
  const driveM = Math.round(driveS / 60);
  const dist = r.legs.reduce((a, l) => a + (l.distance || 0), 0);
  $('#planned').textContent = `planned ${clock(r.at)}`;
  $('#tJobs').textContent = formatMinutes(jobs);
  $('#tDrive').textContent = formatMinutes(driveM);
  $('#tAll').textContent = formatMinutes(jobs + driveM);

  const notes = [`${r.stops.length} stop${r.stops.length === 1 ? '' : 's'}, ${miles(dist)} of driving.`];
  notes.push(`Starting now, back at the shop about ${clock(Date.now() + (jobs + driveM) * 60000)}.`);
  if (r.saved >= 60) notes.push(`${mins(r.saved)} less driving than the order in the screenshot.`);
  const untimed = allStops.filter((s) => s.minutes == null).length;
  const warn = [];
  if (untimed) warn.push(`${untimed} stop${untimed === 1 ? ' has' : 's have'} no job time, so the job total is short.`);
  if (r.missing.length) warn.push(`Not routed (not found on the map near the shop): ${r.missing.map((s) => s.address).join('; ')}. Their job time is counted.`);
  $('#notes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('') + warn.map((n) => `<li class="warn">${esc(n)}</li>`).join('');

  const done = new Set(r.done || []);
  const nav = (label) => `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', destination: label, travelmode: 'driving' })}`;
  const items = r.stops.map((s, i) => {
    const leg = r.legs[i] || {};
    const shaky = s.hit.shaky;
    return `<li class="${done.has(s.id) ? 'done' : ''}" data-id="${s.id}">
      <span class="num">${i + 1}</span>
      <div class="body">
        <div class="addr">${esc(s.address)}</div>
        <div class="meta">${esc([s.name, s.city].filter(Boolean).join(' · '))}</div>
        <div class="chips"><span>🚗 ${mins(leg.duration || 0)} · ${miles(leg.distance || 0)}</span>${s.minutes != null ? `<span>⏱ ${s.minutes}m job</span>` : ''}</div>
        ${shaky ? `<div class="found">Map's best guess: ${esc(s.hit.label)}</div>` : ''}
      </div>
      <a class="go" target="_blank" rel="noopener" href="${esc(nav(s.hit.label))}" aria-label="Directions to stop ${i + 1}">Go</a>
    </li>`;
  });
  const back = r.legs[r.stops.length] || {};
  items.push(`<li class="home"><span class="num">⌂</span><div class="body"><div class="addr">Back to the shop</div>
    <div class="chips"><span>🚗 ${mins(back.duration || 0)} · ${miles(back.distance || 0)}</span></div></div>
    <a class="go" target="_blank" rel="noopener" href="${esc(nav(r.end.label))}" aria-label="Directions to the shop">Go</a></li>`);
  $('#legs').innerHTML = items.join('');
  $('#gmaps').innerHTML = googleLinks(r);
  drawMap(r);
  if (scroll) $('#stopsBox').open = false;
  if (scroll) $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#legs').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li || !e.target.closest('.body') || !result) return;
  const id = Number(li.dataset.id);
  const done = new Set(result.done || []);
  if (done.has(id)) done.delete(id); else done.add(id);
  result.done = [...done];
  store.set('result', result);
  li.classList.toggle('done', done.has(id));
});

renderStops();
renderResult();
if (result) $('#stopsBox').open = false;
