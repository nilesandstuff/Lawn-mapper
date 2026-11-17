/**
 * THE MODEL EXPLORER (owner, 2026-11-17: "a way for me personally to look at the readings, the specific factors/values
 * contributing to the models predictions, and what the model ultimately predicts the reading should be... Each map
 * would have different views by the type of measurement... thermal surface, soil temp, wind, and moisture. If
 * measurements don't exist for all of the different views, still show the predictions side.")
 *
 * The administrator's for now (src/index.js), opened from the measurements page; TODO 30 opens the same page to
 * everyone, where the readings simply are not there (their routes answer the administrator only) and the model side
 * stands alone. So nothing here assumes readings: each view is the model's own layer, with the readings drawn over it
 * when there are any.
 *
 * It opens the map exactly as the water map does (lib/siteof.js, the page's own analysis worker, public/analyse.js)
 * and asks that worker:
 *   walkCheck   a thermal walk's predictions at every record, under the walker's own air and sky (as it is scored)
 *   moment      every lawn spot at one time: grass surface, soil at 2 and 4 in, wind (Open-Meteo's archived hours)
 *   moistureAt  every lawn spot's root-zone water on a date, rain alone (the readings' check)
 *   explain     one spot's factors (lib/explain.js: the words and numbers; this page only lays them out)
 * The photo is drawn by public/frame.js, shared with the water map. Nothing is saved from here.
 */
import { siteOf, inputsOf } from '/lib/siteof.js';
import { walkRecords } from '/lib/walkrecords.js';
import { boxFor } from '/lib/site.js';
import { fmt } from '/lib/explain.js';
import { openMeteoUrls, parseOpenMeteo } from '/lib/momentweather.js';
import { spearman } from '/lib/rank.js';
import { frameFor, savedPhoto, toPx, toMerc, pxToLngLat } from '/frame.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const getJson = async (u, ms = 15000) => { try { const r = await fetch(u, { credentials: 'same-origin', signal: AbortSignal.timeout(ms) }); return r.ok ? r.json() : null; } catch { return null; } };
const localDate = (ms) => new Date(ms).toLocaleDateString('en-CA');
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const busy = (s) => { $('#busy').textContent = s || ''; };

/* COLOURS (the dataviz method): one hue light to dark for a magnitude, two hues through grey for measured minus
   modelled. Orange for temperatures, blue for water, teal for wind. */
const RAMPS = {
  temp: ['#fde4d3', '#f9b98f', '#f08a52', '#d95926', '#a8401a', '#6e2a10'],
  water: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#0d366b'],
  wind: ['#d2f1e6', '#9fe0c8', '#5fc9a6', '#1baf7a', '#127f59', '#0a4f38'],
  diff: ['#256abf', '#86b6ef', '#f0efec', '#f19a7c', '#d03b3b'],
};
const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
function colourAt(ramp, x) {
  const s = RAMPS[ramp], t = Math.max(0, Math.min(1, x)) * (s.length - 1), k = Math.min(s.length - 2, Math.floor(t)), a = hex(s[k]), b = hex(s[k + 1]), f = t - k;
  return a.map((v, j) => Math.round(v + (b[j] - v) * f));
}
const gradient = (ramp) => `linear-gradient(90deg, ${RAMPS[ramp].join(', ')})`;

const VIEWS = {
  surface: { label: 'Thermal surface', kind: 'temp', ramp: 'temp', measured: true },
  soil: { label: 'Soil temperature', kind: 'temp', ramp: 'temp', measured: false },
  wind: { label: 'Wind', kind: 'speed', ramp: 'wind', measured: false },
  moisture: { label: 'Moisture', kind: 'share', ramp: 'water', measured: true },
};

const S = {
  id: new URLSearchParams(location.search).get('map'), site: null, worker: null, d: null, plan: null, photo: null, frame: null, shift: [0, 0],
  view: 'surface', layer: 'measured', depth: 10, events: { surface: [], moisture: [] }, when: null,
  walks: new Map(), moments: new Map(), moist: new Map(), visits: [], items: [], field: null, check: null, selected: null, ready: false,
};

/* ---------------------------------------------------------------- the worker */
let seq = 0;
const waiting = new Map();
function ask(key, body) {
  return new Promise((resolve) => { const id = `x${++seq}`; waiting.set(id, resolve); S.worker.postMessage({ [key]: { id, ...body } }); });
}
function openWorker() {
  return new Promise((resolve, reject) => {
    const w = new Worker('/analyse.js', { type: 'module' });
    S.worker = w;
    w.onmessage = ({ data }) => {
      for (const key of ['walkCheck', 'moment', 'explain', 'moistureAt']) if (data[key]) { const k = waiting.get(data[key].id); waiting.delete(data[key].id); if (k) k(data[key]); return; }
      if (data.progress) busy(`Reading the lidar survey: ${data.progress.done} of ${data.progress.total} pieces…`);
      else if (data.planProgress) busy(data.planProgress);
      else if (data.done) { S.d = data.done; draw(); }
      else if (data.plan) { S.plan = data.plan; resolve(); }
      else if (data.error) reject(new Error(data.error));
      else if (data.planError) reject(new Error(`the plan: ${data.planError}`));
    };
    w.onerror = (e) => reject(new Error(e.message || 'the analysis stopped'));
    w.postMessage({ site: S.site, inputs: inputsOf(S.site.water) });
  });
}

/* ------------------------------------------------------------ the grid, the photo */
function cellAt([lng, lat]) {
  const d = S.d; if (!d?.grid) return -1;
  const { W, H, bbox } = d.grid, dx = d.shift.east / d.grid.k, dy = d.shift.north / d.grid.k;
  const [x, y] = toMerc([lng, lat]);
  const c = Math.floor(((x - dx - bbox[0]) / (bbox[2] - bbox[0])) * W), r = Math.floor(((bbox[3] - (y - dy)) / (bbox[3] - bbox[1])) * H);
  return c >= 0 && c < W && r >= 0 && r < H ? r * W + c : -1;
}
/** The nearest lawn cell to a point within 2 m (a reading taken on the lawn's edge), or -1. */
function lawnCellNear(p, field = null) {
  const i0 = cellAt(p), d = S.d, kinds = S.plan?.kinds;
  if (i0 < 0 || !kinds) return -1;
  const ok = (i) => kinds[i] === 1 && (!field || Number.isFinite(field[i]));
  if (ok(i0)) return i0;
  const W = d.grid.W, H = d.grid.H, r0 = Math.floor(i0 / W), c0 = i0 % W;
  let best = -1, bd = Infinity;
  for (let r = r0 - 2; r <= r0 + 2; r++) for (let c = c0 - 2; c <= c0 + 2; c++) {
    if (r < 0 || c < 0 || r >= H || c >= W) continue;
    const i = r * W + c, dd = (r - r0) ** 2 + (c - c0) ** 2;
    if (ok(i) && dd < bd) { bd = dd; best = i; }
  }
  return best;
}

/* ------------------------------------------------------------ the readings */
async function loadReadings() {
  const [mo, th] = await Promise.all([getJson(`/api/water/moisture?map=${encodeURIComponent(S.id)}`), getJson(`/api/maps/thermal?id=${encodeURIComponent(S.id)}`)]);
  S.visits = (mo?.visits || []).filter((v) => v.readings?.length);
  const walks = (th?.walks || []).filter((w) => w.ok === true && w.walk);
  S.events.surface = [
    ...walks.map((w) => ({ key: `walk:${w.walk}`, kind: 'walk', walk: w.walk, t: w.started ?? null, label: `Thermal walk${Number.isFinite(w.started) ? `, ${when(w.started)}` : ''}${Number.isFinite(w.records) ? ` (${w.records} records)` : ''}` })),
    ...S.visits.filter((v) => v.unit === 'surface_f').map((v) => ({ key: `visit:${v.id}`, kind: 'visit', visit: v, t: v.at, label: `Surface readings, ${when(v.at)} (${v.readings.length})` })),
  ].sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  S.events.moisture = S.visits.filter((v) => v.unit !== 'surface_f').map((v) => ({ key: `visit:${v.id}`, kind: 'visit', visit: v, t: v.at, date: localDate(v.at), label: `Moisture readings, ${day(v.at)} (${v.readings.length})` })).sort((a, b) => b.t - a.t);
}

/** A walk's records, its weather (frozen with it when it was scored; else Open-Meteo's, fetched here) and the model's
 *  prediction at each record (the worker's walkCheck: exactly as the walk is scored). */
async function loadWalk(ev) {
  if (S.walks.has(ev.walk)) return S.walks.get(ev.walk);
  busy('Reading the walk…');
  const walk = await getJson(`/api/maps/thermal?id=${encodeURIComponent(S.id)}&walk=${encodeURIComponent(ev.walk)}`, 30000);
  if (!walk) throw new Error('the walk did not answer');
  const { records, notes, started, ended } = walkRecords(walk, S.site, { lawnAt: (p) => S.plan?.kinds?.[cellAt(p)] === 1 });
  let weather = await getJson(`/api/water/truth/weather?walk=${encodeURIComponent(ev.walk)}`);
  if (!weather) {
    const rows = [];
    for (const [src, u] of Object.entries(openMeteoUrls(S.site.lat, S.site.lng, started, ended ?? started + 9e5))) {
      try { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); if (r.ok) rows.push(...parseOpenMeteo(await r.json(), src, started - 36e5, (ended ?? started) + 36e5)); } catch { /* the rest */ }
    }
    weather = { series: rows, sources: [] };
  }
  busy('The model at every record of the walk (its soil spun up over the weeks before)…');
  const res = await ask('walkCheck', { records, series: weather.series || [], notes });
  if (res.error) throw new Error(res.error);
  S.walkKey = ev.walk; // the worker keeps the last walk it checked: a record's factors come from it
  const out = { key: ev.walk, series: weather.series || [], records, res, notes, mid: records.length ? records[Math.floor(records.length / 2)].tm : started };
  S.walks.set(ev.walk, out);
  return out;
}

/* ------------------------------------------------------------ the model's layers */
async function momentAt(t) {
  const key = Math.round(t / 6e4);
  if (S.moments.has(key)) return S.moments.get(key);
  busy('The model over the whole lawn at that minute (each spot\'s soil spun up over the 45 days before)…');
  const m = await ask('moment', { t });
  if (m.error) throw new Error(m.error);
  S.moments.set(key, m);
  S.momentKey = key;
  return m;
}
async function moistureOn(date) {
  if (S.moist.has(date)) return S.moist.get(date);
  busy('The root zone\'s water on that day, rain alone…');
  const m = await ask('moistureAt', { date });
  if (m.error) throw new Error(m.error);
  S.moist.set(date, m);
  return m;
}

/* ------------------------------------------------------------ choosing what to show */
function whenOptions() {
  const v = S.view, sel = $('#when');
  let evs = v === 'surface' ? S.events.surface : v === 'moisture' ? S.events.moisture : [];
  // soil and wind: the readings' moments as ready-made times
  if (v === 'soil' || v === 'wind') evs = S.events.surface.filter((e) => Number.isFinite(e.t)).map((e) => ({ ...e, key: `time:${e.t}`, kind: 'time', label: `At the ${e.kind === 'walk' ? 'walk' : 'readings'} of ${when(e.t)}` }));
  sel.innerHTML = [...evs.map((e) => `<option value="${esc(e.key)}">${esc(e.label)}</option>`), `<option value="pick">${v === 'moisture' ? 'Pick a day…' : 'Pick a time…'}</option>`].join('');
  S.whenList = evs;
  sel.value = evs.length ? evs[0].key : 'pick';
  const yest = new Date(Date.now() - 864e5); yest.setHours(15, 0, 0, 0);
  if (!$('#pick').value) $('#pick').value = new Date(yest.getTime() - yest.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  if (!$('#pick-day').value) $('#pick-day').value = localDate(yest.getTime());
}
function currentWhen() {
  const k = $('#when').value;
  if (k !== 'pick') return S.whenList.find((e) => e.key === k) || null;
  if (S.view === 'moisture') return { kind: 'day', date: $('#pick-day').value };
  const t = new Date($('#pick').value).getTime();
  return Number.isFinite(t) ? { kind: 'time', t } : null;
}

async function show() {
  if (!S.ready) return;
  const v = S.view, ev = currentWhen();
  $('#pick').hidden = !($('#when').value === 'pick' && v !== 'moisture');
  $('#pick-day').hidden = !($('#when').value === 'pick' && v === 'moisture');
  $('#depth-box').hidden = v !== 'soil';
  S.items = []; S.field = null; S.check = null; S.selected = null; S.ctx = null;
  $('#spot').innerHTML = '<p class="dim">Tap a spot on the map to see its reading, the model\'s prediction and what goes into it.</p>';
  const hasReadings = VIEWS[v].measured && ev && ev.kind !== 'time' && ev.kind !== 'day';
  if (!hasReadings && S.layer !== 'model') S.layer = 'model';
  if (hasReadings && S.layerFor !== v) { S.layer = 'measured'; }
  S.layerFor = v;
  $('#whole').hidden = true;
  try {
    if (!ev) { busy('Pick a time.'); draw(); return; }
    if (v === 'surface' && ev.kind === 'walk') {
      const w = await loadWalk(ev);
      S.ctx = { type: 'walk', walk: w, t: w.mid };
      S.items = w.records.map((r, k) => ({ lng: r.lng, lat: r.lat, m: r.T, p: w.res.pred[k], k, band: r.band || '0-60' })).filter((x) => x.band === '0-60');
      S.check = { n: w.res.n, bias: w.res.bias, rmse: w.res.rmse, rho: w.res.rho, used: w.res.used, v1: w.res.v1 };
      const mk = Math.round(w.mid / 6e4);
      if (S.moments.has(mk)) S.field = S.moments.get(mk).surface; else $('#whole').hidden = false;
    } else if (v === 'surface' && ev.kind === 'visit') {
      const m = await momentAt(ev.t);
      S.ctx = { type: 'moment', t: ev.t };
      S.field = m.surface;
      S.items = ev.visit.readings.filter((r) => Number.isFinite(r.lng) && Number.isFinite(r.value)).map((r) => { const i = lawnCellNear([r.lng, r.lat], m.surface); return { lng: r.lng, lat: r.lat, m: (r.value - 32) / 1.8, p: i >= 0 ? m.surface[i] : NaN, i, n: r.n, note: r.note }; });
      S.check = statsOf(S.items);
      S.check.used = { soil: m.used, air: 'Open-Meteo\'s archived hour (the air you read is not used here)' };
    } else if (v === 'moisture') {
      const date = ev.date;
      const m = await moistureOn(date);
      S.ctx = { type: 'moisture', date };
      S.field = m.wet;
      if (ev.kind === 'visit') {
        S.items = ev.visit.readings.filter((r) => Number.isFinite(r.lng) && Number.isFinite(r.value)).map((r) => { const i = lawnCellNear([r.lng, r.lat], m.wet); return { lng: r.lng, lat: r.lat, m: r.value, p: i >= 0 ? m.wet[i] : NaN, i, n: r.n, note: r.note, unit: ev.visit.unit }; });
        const ok = S.items.filter((x) => Number.isFinite(x.p));
        S.check = { n: ok.length, rho: spearman(ok.map((x) => x.m), ok.map((x) => x.p)), unit: ev.visit.unit };
      }
    } else {
      const m = await momentAt(ev.t);
      S.ctx = { type: 'moment', t: ev.t };
      S.field = v === 'wind' ? m.wind : S.depth === 5 ? m.soil5 : m.soil10;
      S.check = { used: { soil: m.used }, w: m.w };
    }
    busy('');
  } catch (e) { busy(`Not worked out: ${e.message || e}`); }
  layerButtons(hasReadings);
  summary();
  draw();
}

function statsOf(items) {
  const ok = items.filter((x) => Number.isFinite(x.m) && Number.isFinite(x.p));
  if (!ok.length) return { n: 0 };
  const d = ok.map((x) => x.m - x.p), bias = d.reduce((a, b) => a + b, 0) / d.length;
  return { n: ok.length, bias, rmse: Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length), rho: spearman(ok.map((x) => x.m), ok.map((x) => x.p)) };
}

function layerButtons(hasReadings) {
  const v = S.view;
  document.querySelectorAll('#layers [data-layer]').forEach((b) => {
    const l = b.dataset.layer;
    b.disabled = l !== 'model' && (!hasReadings || (l === 'diff' && v === 'moisture'));
    b.title = b.disabled ? (VIEWS[v].measured ? (l === 'diff' ? 'The meter reads its own scale, not the model\'s share' : 'No readings at this time') : `No ${VIEWS[v].label.toLowerCase()} readings yet`) : '';
    b.setAttribute('aria-pressed', String(S.layer === l));
  });
}

function summary() {
  const c = S.check, v = S.view, el = $('#summary');
  if (!c) { el.innerHTML = ''; return; }
  const tiles = [];
  if (Number.isFinite(c.n) && c.n) tiles.push(['Spots compared', String(c.n)]);
  if (Number.isFinite(c.bias)) tiles.push(['Measured − model, average', fmt(c.bias, 'dtemp')]);
  if (Number.isFinite(c.rmse)) tiles.push(['Typical miss (RMS)', fmt(c.rmse, 'dtemp').replace('+', '')]);
  if (c.rho !== undefined) tiles.push(['Same order? (rank, 1 = yes)', Number.isFinite(c.rho) ? c.rho.toFixed(2) : '-']);
  if (c.w) tiles.push(['Air', fmt(c.w.ta, 'temp')], ['Open wind', fmt(c.w.wind, 'speed')], ['Sunshine', fmt(c.w.ghi, 'flux')]);
  const notes = [];
  if (c.used?.soil) notes.push(`Soil: ${c.used.soil}.`);
  if (c.used?.air) notes.push(`Air: ${c.used.air}.`);
  if (c.used?.cloud) notes.push(`Cloud: ${c.used.cloud}.`);
  if (c.v1 && Number.isFinite(c.v1.bias)) notes.push(`Without the soil columns (version 1): off by ${fmt(c.v1.bias, 'dtemp')} on average, rank ${Number.isFinite(c.v1.rho) ? c.v1.rho.toFixed(2) : '-'}.`);
  if (v === 'surface' && S.ctx?.type === 'walk') notes.push('Squares viewed 0–60° from straight down. Each is set against the model at its own minute.');
  if (v === 'moisture' && c.unit) notes.push(`Readings in ${c.unit === 'vwc' ? '% water' : 'the meter\'s own scale'}; the model gives the share of the root zone\'s usable water, so only their order is compared.`);
  el.innerHTML = `<div class="big">${tiles.map(([k, val]) => `<div><span class="dim">${esc(k)}</span><b>${esc(val)}</b></div>`).join('')}</div>${notes.length ? `<p class="dim">${esc(notes.join(' '))}</p>` : ''}`;
}

/* ------------------------------------------------------------ drawing */
function scaleOf() {
  const v = S.view, L = S.layer;
  const vals = [];
  if (L === 'diff') for (const x of S.items) { if (Number.isFinite(x.m) && Number.isFinite(x.p)) vals.push(x.m - x.p); }
  else {
    if (S.field && !(L === 'measured' && v === 'moisture')) for (let i = 0; i < S.field.length; i++) if (Number.isFinite(S.field[i])) vals.push(S.field[i]);
    for (const x of S.items) { const val = L === 'measured' ? x.m : x.p; if (Number.isFinite(val) && !(v === 'moisture' && L === 'model')) vals.push(val); }
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  let lo = vals[Math.floor(vals.length * 0.02)], hi = vals[Math.ceil(vals.length * 0.98) - 1];
  if (L === 'diff') { const m = Math.max(Math.abs(lo), Math.abs(hi), 0.5); lo = -m; hi = m; }
  if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
  const kind = L === 'diff' ? 'dtemp' : L === 'measured' && v === 'moisture' ? 'num' : VIEWS[v].kind;
  return { lo, hi, ramp: L === 'diff' ? 'diff' : VIEWS[v].ramp, kind };
}

function draw() {
  const { photo, frame, d } = S;
  if (!photo || !frame) return;
  const cv = $('#view'), C = cropOf();
  cv.width = C.w; cv.height = C.h;
  const g = cv.getContext('2d');
  g.translate(-C.x, -C.y); // the photo's pixels, cut to the lawn and round it
  g.fillStyle = '#3a4440'; g.fillRect(C.x, C.y, C.w, C.h);
  if (photo.close) g.drawImage(photo, S.shift[0], S.shift[1]);
  const sc = scaleOf();
  const norm = (x) => (sc ? (x - sc.lo) / (sc.hi - sc.lo) : 0);
  // the model's own layer over the lawn (under the readings)
  const showField = S.field && d?.grid && (S.layer === 'model' || (S.layer === 'measured' && S.view !== 'moisture' && !S.items.length));
  if (showField && sc) {
    const { W, H } = d.grid, img = new ImageData(W, H);
    for (let i = 0; i < W * H; i++) { const x = S.field[i]; if (!Number.isFinite(x)) continue; img.data.set([...colourAt(sc.ramp, norm(x)), 200], i * 4); }
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; tmp.getContext('2d').putImageData(img, 0, 0);
    const dx = d.shift.east / d.grid.k, dy = d.shift.north / d.grid.k;
    const [x0, y0] = toPx(frame, photo, [d.grid.bbox[0] + dx, d.grid.bbox[3] + dy]), [x1, y1] = toPx(frame, photo, [d.grid.bbox[2] + dx, d.grid.bbox[1] + dy]);
    g.imageSmoothingEnabled = false; g.drawImage(tmp, x0, y0, x1 - x0, y1 - y0);
  }
  // the lawn's outline
  g.strokeStyle = '#69f0ae'; g.lineWidth = Math.max(2, C.w / 300);
  for (const f of S.site.lawn || []) {
    const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    for (const poly of polys) for (const ring of poly) { g.beginPath(); ring.forEach((p, k) => { const [x, y] = toPx(frame, photo, toMerc(p)); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath(); g.stroke(); }
  }
  // the readings: half-metre squares (a walk) or dots (a visit), coloured by the layer
  const pxPerM = (() => { const k = Math.cos((S.site.lat * Math.PI) / 180), a = toPx(frame, photo, toMerc([S.site.lng, S.site.lat])), b = toPx(frame, photo, toMerc([S.site.lng + 1 / (111320 * k), S.site.lat])); return Math.abs(b[0] - a[0]); })();
  const valOf = (x) => (S.layer === 'measured' ? x.m : S.layer === 'model' ? x.p : x.m - x.p);
  if (sc && S.items.length && !(S.layer === 'model' && S.view === 'moisture')) {
    const walk = S.ctx?.type === 'walk', size = walk ? Math.max(2, 0.5 * pxPerM) : Math.max(1.2 * pxPerM, C.w / 40);
    for (const x of S.items) {
      const val = valOf(x); if (!Number.isFinite(val)) continue;
      const [px, py] = toPx(frame, photo, toMerc([x.lng, x.lat]));
      g.fillStyle = `rgb(${colourAt(sc.ramp, norm(val)).join(',')})`;
      if (walk) g.fillRect(px - size / 2, py - size / 2, size, size);
      else { g.beginPath(); g.arc(px, py, size / 2, 0, 2 * Math.PI); g.fill(); g.lineWidth = 2; g.strokeStyle = '#fcfcfb'; g.stroke(); }
    }
  }
  if (S.selected?.at) {
    const [px, py] = toPx(frame, photo, toMerc(S.selected.at));
    g.lineWidth = Math.max(3, C.w / 150); g.strokeStyle = '#fcfcfb'; g.beginPath(); g.arc(px, py, Math.max(C.w / 45, 1.5 * pxPerM), 0, 2 * Math.PI); g.stroke();
    g.lineWidth = Math.max(1.5, C.w / 300); g.strokeStyle = '#0b0b0b'; g.stroke();
  }
  legend(sc);
}

/** The part of the photo drawn: the lawn (or the analysis box with no lawn) and a third again round it, square-ish. */
function cropOf() {
  if (S.crop) return S.crop;
  const { photo, frame } = S;
  const pts = [];
  for (const f of S.site.lawn || []) { const gm = f.geometry || f; const polys = gm.type === 'Polygon' ? [gm.coordinates] : gm.type === 'MultiPolygon' ? gm.coordinates : []; for (const poly of polys) for (const p of poly[0] || []) pts.push(toPx(frame, photo, toMerc(p))); }
  if (!pts.length) return { x: 0, y: 0, w: photo.width, h: photo.height };
  let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  const side = Math.max(x1 - x0, y1 - y0, 160) * 1.35, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const w = Math.min(photo.width, side), h = Math.min(photo.height, side);
  const x = Math.max(0, Math.min(photo.width - w, cx - w / 2)), y = Math.max(0, Math.min(photo.height - h, cy - h / 2));
  if (photo.close) S.crop = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }; // fixed once the real photo is in
  return S.crop || { x, y, w, h };
}

function legend(sc) {
  const el = $('#legend');
  if (!sc) { el.innerHTML = ''; return; }
  const what = S.layer === 'diff' ? 'Measured − model (blue: the model warmer; red: the model cooler)' : S.layer === 'measured' ? (S.view === 'moisture' ? 'Reading (the meter\'s scale)' : 'Measured') : `Model: ${S.view === 'moisture' ? 'root zone water, share of full' : S.view === 'soil' ? `soil at ${S.depth === 5 ? 2 : 4} in` : S.view === 'wind' ? 'wind at 2 m' : 'grass surface'}`;
  const f = (x) => (sc.kind === 'num' ? String(Math.round(x)) : fmt(x, sc.kind));
  el.innerHTML = `<span>${esc(what)}</span><span>${esc(f(sc.lo))}</span><span class="bar" style="background:${gradient(sc.ramp)}"></span><span>${esc(f(sc.hi))}</span>${S.layer === 'model' && S.items.length && S.ctx?.type === 'walk' ? '<span class="dim">Squares the walk covered: under the walker\'s air and sky. Elsewhere: Open-Meteo\'s archived hour.</span>' : ''}`;
}

/* ------------------------------------------------------------ a tapped spot */
async function tap(ev) {
  if (!S.ready || !S.photo) return;
  const cv = $('#view'), rect = cv.getBoundingClientRect();
  const C = cropOf(), px = [C.x + ((ev.clientX - rect.left) / rect.width) * cv.width, C.y + ((ev.clientY - rect.top) / rect.height) * cv.height];
  const at = pxToLngLat(S.frame, S.photo, px);
  const k = Math.cos((at[1] * Math.PI) / 180), dist = (x) => Math.hypot((x.lng - at[0]) * 111320 * k, (x.lat - at[1]) * 111320);
  let item = null;
  if (S.items.length) { let bd = 1.2; for (const x of S.items) { const dd = dist(x); if (dd < bd) { bd = dd; item = x; } } }
  const v = S.view;
  let res;
  $('#spot').innerHTML = '<p class="dim">Working it out…</p>';
  if (v === 'moisture') {
    const i = item ? item.i : lawnCellNear(at, S.field);
    if (i < 0) { $('#spot').innerHTML = '<p class="dim">Not on the lawn the model works out.</p>'; return; }
    res = await ask('moistureAt', { date: S.ctx.date, i, reading: item ? item.m : null, unit: item?.unit || null });
    res = res.error ? res : { ...res.explain, t: null };
  } else if (item && S.ctx?.type === 'walk') {
    const w = S.ctx.walk;
    if (S.walkKey !== w.key) { await ask('walkCheck', { records: w.records, series: w.series, notes: w.notes }); S.walkKey = w.key; }
    res = await ask('explain', { view: 'surface', k: item.k, reading: item.m });
  }
  else {
    // a moment's spot: make sure the worker's moment is this one (the walk's whole-lawn layer, or this time)
    const t = S.ctx?.type === 'walk' ? S.ctx.walk.mid : S.ctx?.t;
    if (!Number.isFinite(t)) { $('#spot').innerHTML = '<p class="dim">Nothing worked out at this spot yet. For a walk, tap a square it covered, or model the whole lawn.</p>'; return; }
    const key = Math.round(t / 6e4);
    if (!S.moments.has(key)) { $('#spot').innerHTML = '<p class="dim">Tap a square the walk covered, or model the whole lawn at this minute first.</p>'; return; }
    if (S.momentKey !== key) { await ask('moment', { t }); S.momentKey = key; }
    const i = item ? item.i : lawnCellNear(at, S.moments.get(key).surface);
    if (i < 0) { $('#spot').innerHTML = '<p class="dim">Not on the lawn the model works out.</p>'; return; }
    res = await ask('explain', { view: v === 'surface' ? 'surface' : v, i, depthCm: S.depth, reading: item ? item.m : null });
  }
  S.selected = { at: item ? [item.lng, item.lat] : at };
  draw();
  spotCard(res, item);
}

function spotCard(r, item) {
  const el = $('#spot');
  if (!r || r.error) { el.innerHTML = `<p class="dim">${esc(r?.error || 'Nothing came back for that spot.')}</p>`; return; }
  const moist = r.view === 'moisture';
  const reading = item ? (moist ? `${item.m}${item.unit === 'vwc' ? '% water' : ' on the meter'}` : fmt(item.m, 'temp')) : null;
  const tiles = [];
  if (reading !== null) tiles.push(['Reading', reading]);
  tiles.push([`Model: ${r.label.toLowerCase()}`, fmt(r.value, r.kind)]);
  if (reading !== null && !moist && Number.isFinite(item.m) && Number.isFinite(r.value)) tiles.push(['Measured − model', fmt(item.m - r.value, 'dtemp')]);
  for (const o of r.others || []) tiles.push([o.label, fmt(o.v, o.kind)]);
  const groups = (r.groups || []).map((gr, n) => `<details${n < 3 ? ' open' : ''}><summary>${esc(gr.title)}</summary>${gr.note ? `<p class="dim">${esc(gr.note)}</p>` : ''}<table>${gr.rows.map((x) => `<tr><td>${esc(x.label)}${x.note ? `<span class="dim">${esc(x.note)}</span>` : ''}</td><td class="v">${esc(fmt(x.v, x.kind))}</td></tr>`).join('')}</table></details>`).join('');
  el.innerHTML = `<h2>${item?.n ? `Spot ${esc(item.n)}` : 'This spot'}${Number.isFinite(r.t) ? `, ${esc(when(r.t))}` : S.ctx?.date ? `, ${esc(day(Date.parse(`${S.ctx.date}T12:00:00`)))}` : ''}</h2>
    <div class="big">${tiles.map(([k, val]) => `<div><span class="dim">${esc(k)}</span><b>${esc(val)}</b></div>`).join('')}</div>${item?.note ? `<p class="dim">Note: ${esc(item.note)}</p>` : ''}${groups}`;
}

/* ------------------------------------------------------------ start */
document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => {
  S.view = b.dataset.view;
  document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  whenOptions(); show();
}; });
document.querySelectorAll('#layers [data-layer]').forEach((b) => { b.onclick = () => { if (b.disabled) return; S.layer = b.dataset.layer; layerButtons(!b.disabled && S.items.length > 0); draw(); }; });
$('#when').onchange = () => show();
$('#pick').onchange = () => show();
$('#pick-day').onchange = () => show();
$('#depth').onchange = () => { S.depth = Number($('#depth').value); show(); };
$('#whole').onclick = async () => {
  const w = S.ctx?.walk; if (!w) return;
  $('#whole').disabled = true;
  try { const m = await momentAt(w.mid); S.field = m.surface; busy(''); $('#whole').hidden = true; } catch (e) { busy(`Not worked out: ${e.message || e}`); }
  $('#whole').disabled = false;
  draw();
};
$('#view').addEventListener('click', tap);

(async () => {
  if (!S.id) { busy('No map given. Open this from the measurements page.'); return; }
  $('#open-map').href = `/?map=${encodeURIComponent(S.id)}`;
  try {
    const j = await getJson(`/api/maps/one?id=${encodeURIComponent(S.id)}`);
    if (!j?.map) throw new Error('that map would not open (sign in as the administrator)');
    S.site = siteOf(j.map, S.id);
    $('#title').textContent = `Model explorer: ${S.site.label || 'a map'}`;
    const box = S.site.lidar?.box?.length === 4 ? S.site.lidar.box : boxFor(S.site);
    S.frame = frameFor(box, S.site.lat);
    const photoP = savedPhoto(S.frame, S.site).then((p) => { S.photo = p.photo || { width: 1280, height: 1280 }; S.shift = p.shift; draw(); });
    const readP = loadReadings();
    busy('Working out the map (the survey, the soil, the shade, the weather): a minute or two…');
    await Promise.all([openWorker(), photoP, readP]);
    S.ready = true;
    whenOptions();
    await show();
  } catch (e) { busy(`The map could not be worked out: ${e.message || e}`); }
})();
