/**
 * THE YARD AR TEST PAGE (core session, docs/SCAN-PLAN.md phases 1 and 2).
 *
 * One page, two engines (scan/lib/track.js): Chrome's WebXR on Android, the 8th Wall engine on iPhone. Phase 1: a
 * crosshair, a dot where it meets the ground, pins to drop and check after a walk, a two-tap measure. Phase 2: where
 * the phone is ON THE MAP -- two references marked on the photo and aimed at in AR (scan/lib/align.js), and the lidar
 * match from the depth picture (scan/lib/locate.js, scan/lib/lidar.js in /lidar-worker.js); check points say how far
 * off the map position is. The walk's bookkeeping is scan/lib/walk.js; what is kept on the site is distances and
 * counts only. Pins' map positions stay on this phone until phase 3 writes them to the map record.
 */
import { detect, start, engineChoice, load8thWall } from '/lib/track.js';
import { newWalk, step, dropPin, checkPin, measure, tapeFor, undo, far, summary, pinNow } from '/lib/walk.js';
import { makeDrawer, lidarMeshes } from '/lib/draw.js';
import { levelDist, toLocal } from '/lib/frames.js';
import { frameFor, bboxOf, toPx, fromPx, ringsOf } from '/lib/photo.js';
import { newLocate, mark, noteGround, addDepth, nextAsk, answer, fitFor, mapOf, sessionOf, checkError, nearestNamed, agreement, status as fixStatus, summaryOf } from '/lib/locate.js';
import { leftOut, mapToSession } from '/lib/align.js';
import { newTwin, addPoints, addPose, wantKey, addKey, flush, flushDue, liveOf } from '/lib/twin.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FT = 3.28084;
const ftIn = (m) => { const inch = Math.round(m * FT * 12); return inch < 12 ? `${inch} in` : `${Math.floor(inch / 12)} ft ${inch % 12} in`; };
const ENGINE_URL = '/vendor/xr/xr.js';
const NAME = { webxr: "Chrome's AR (WebXR)", '8thwall': '8th Wall' };
const COLOR = { dot: [0.3, 1, 0.6, 0.9], dotPlane: [1, 0.8, 0.2, 0.9], pin: [0.9, 0.22, 0.2, 0.95], placed: [0.9, 0.22, 0.2, 0.45], mark: [0.35, 0.6, 1, 0.95], ref: [0.25, 0.5, 1, 0.9], check: [0.75, 0.3, 0.9, 0.9] };
const CSS = { ref: '#2f7cf6', check: '#a54bd8', pin: '#e53935', lawn: '#4cc38a' };
const FAR_AGAIN = 3000;
const DEPTH_EVERY = 250;

const st = {
  caps: null, has8w: false, map: new URLSearchParams(location.search).get('map'), site: null, origin: null, lawn: [], parcel: [], frame: null, photo: null,
  points: [], adding: 'ref', view: { s: 1, ox: 0, oy: 0 }, pins: [],
  walk: null, L: null, tracker: null, drawer: null, frame: null, hudAt: 0, farAt: 0, depthAt: 0, errors: [], lid: { worker: null, ready: null, error: null, progress: '', overlay: null, meshes: null }, gpsWatch: null,
  lidarOn: true, agree: null,
};
// the photo frame and the AR frame are both "frame": keep the AR one apart
st.ar = null;

/* ------------------------------------------------------------- the page */

async function main() {
  if (st.map) $('#back').href = `${$('#back').getAttribute('href')}?map=${encodeURIComponent(st.map)}`;
  try { st.has8w = (await fetch('/vendor/xr/VERSION', { method: 'HEAD', cache: 'no-store' })).ok; } catch { st.has8w = false; }
  st.caps = await detect({ eightWallUrl: st.has8w ? ENGINE_URL : null });
  const pick = engineChoice({ hasXR: st.caps.webxr, has8w: st.has8w, ios: st.caps.ios });
  const bits = [];
  bits.push(st.caps.ios ? 'An iPhone or iPad.' : 'Not an iPhone.');
  bits.push(st.caps.webxr ? "Chrome's AR is here." : 'No WebXR in this browser (none on iPhone; on Android, Chrome with Google Play Services for AR has it).');
  bits.push(st.has8w ? 'The 8th Wall engine is on this site.' : 'The 8th Wall engine is not on this site (the deploy did not install it).');
  $('#status').textContent = bits.join(' ');
  const box = $('#start');
  box.innerHTML = '';
  for (const e of pick.offered) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = `Start AR (${NAME[e]})`; b.className = e === pick.start ? '' : 'plain';
    b.addEventListener('click', () => startAR(e));
    box.append(b);
  }
  if (!pick.offered.length) {
    $('#why').innerHTML = st.caps.why ? esc(st.caps.why) : st.caps.ios
      ? 'Nothing on this phone can track yet. The fallback to try once: install <a href="https://apps.apple.com/app/id1295998056">Mozilla WebXR Viewer</a> (old, unsupported) and open this page in it.'
      : 'Nothing on this phone can track. On Android, open this page in Chrome with Google Play Services for AR installed.';
  } else if (!st.caps.webxr && st.has8w) {
    $('#why').textContent = 'Safari will ask for the camera and the motion sensors; both are needed. The engine downloads about 7 MB the first time.';
  }
  renderResults();
  if (st.map) await loadMap(st.map).catch((e) => { $('#mapnote').textContent = `The map could not be opened (${e.message}): tracking only, no references or lidar.`; });
  else $('#mapnote').textContent = 'No map: open this page from the dashboard to use references and the lidar. Tracking still works.';
}

/* --------------------------------------------------------------- the map */

async function loadMap(id) {
  const res = await fetch(`/api/maps/one?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `${res.status}`);
  const m = j?.map || j; // docs/MAPS.md: the answer is { map }
  if (!m || !Number.isFinite(m.lng) || !Number.isFinite(m.lat)) throw new Error('no point');
  st.site = m; st.origin = [m.lng, m.lat];
  st.lawn = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(st.origin, p)));
  st.parcel = ringsOf(m.parcel ? [m.parcel] : []).map((r) => r.map((p) => toLocal(st.origin, p)));
  const pts = [...st.lawn.flat(), ...st.parcel.flat()];
  st.frame = frameFor(bboxOf(st.origin, pts, 12), m.lat);
  loadPoints(); loadPins(); listPoints();
  $('#setup').hidden = false;
  $('#mapnote').textContent = `Map opened${m.squareFeet ? ` (${Math.round(m.squareFeet).toLocaleString()} sq ft of lawn)` : ''}.`;
  drawMap();
  startLidar(m);
  try {
    const q = new URLSearchParams({ lng: st.frame.lng, lat: st.frame.lat, zoom: st.frame.zoom, size: st.frame.size, height: st.frame.height, provider: 'mapbox' });
    const r = await fetch(`/api/imagery?${q}`);
    if (r.ok) st.photo = await createImageBitmap(await r.blob());
  } catch { /* the outline alone */ }
  drawMap();
}

const photoW = () => (st.photo ? st.photo.width : 1280), photoH = () => (st.photo ? st.photo.height : 1280);
const px = (map) => toPx(st.frame, st.origin, map, photoW(), photoH());
const unpx = (p) => fromPx(st.frame, st.origin, p, photoW(), photoH());
const KEYP = () => `scan-points:${st.map}`, KEYPIN = () => `scan-pins:${st.map}`;
const loadPoints = () => { try { st.points = JSON.parse(localStorage.getItem(KEYP()) || '[]'); } catch { st.points = []; } };
const savePoints = () => { try { localStorage.setItem(KEYP(), JSON.stringify(st.points)); } catch { /* this phone only */ } };
const loadPins = () => { try { st.pins = JSON.parse(localStorage.getItem(KEYPIN()) || '[]'); } catch { st.pins = []; } };
const savePins = () => { try { localStorage.setItem(KEYPIN(), JSON.stringify(st.pins.slice(-200))); } catch { /* this phone only */ } };
const nextName = (kind) => { const pre = kind === 'ref' ? 'R' : 'C'; let k = 1; while (st.points.some((p) => p.name === `${pre}${k}`)) k++; return `${pre}${k}`; };

function drawMap() {
  const cv = $('#map'); if (!cv || !st.frame) return;
  const w = photoW(), h = photoH();
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#2a332f'; g.fillRect(0, 0, w, h);
  g.setTransform(st.view.s, 0, 0, st.view.s, st.view.ox, st.view.oy);
  if (st.photo) g.drawImage(st.photo, 0, 0);
  const lw = 2 / st.view.s;
  const ring = (r, color, dash) => { if (r.length < 2) return; g.beginPath(); r.forEach((p, i) => { const [x, y] = px(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath(); g.setLineDash(dash || []); g.strokeStyle = color; g.lineWidth = lw; g.stroke(); g.setLineDash([]); };
  for (const r of st.parcel) ring(r, 'rgba(255,255,255,.8)', [6 / st.view.s, 4 / st.view.s]);
  for (const r of st.lawn) ring(r, CSS.lawn);
  const dot = (map, color, label, r = 9) => { const [x, y] = px(map); g.beginPath(); g.arc(x, y, r / st.view.s, 0, Math.PI * 2); g.fillStyle = color; g.fill(); g.lineWidth = lw; g.strokeStyle = '#fff'; g.stroke(); if (label) { g.font = `bold ${13 / st.view.s}px system-ui, sans-serif`; g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 3 / st.view.s; g.strokeText(label, x + 11 / st.view.s, y + 5 / st.view.s); g.fillText(label, x + 11 / st.view.s, y + 5 / st.view.s); } };
  for (const p of st.pins) if (p.map) dot(p.map, CSS.pin, p.name, 7);
  for (const p of st.points) dot(p.map, p.kind === 'ref' ? CSS.ref : CSS.check, p.name);
  if (st.L && st.ar?.pose && st.walk) { const me = mapOf(st.L, st.ar.pose.position, st.walk.odo); if (me) dot(me, '#ffeb3b', 'you', 7); }
}
function clampView() {
  const cv = $('#map'), w = cv.width, h = cv.height, s = st.view.s;
  st.view.ox = Math.min(0, Math.max(w - w * s, st.view.ox)); st.view.oy = Math.min(0, Math.max(h - h * s, st.view.oy));
}
function zoomAt(f, [x, y]) {
  const s0 = st.view.s, s1 = Math.max(1, Math.min(8, s0 * f));
  st.view.ox = x - ((x - st.view.ox) * s1) / s0; st.view.oy = y - ((y - st.view.oy) * s1) / s0; st.view.s = s1;
  clampView(); drawMap();
}
function listPoints() {
  const el = $('#points');
  el.innerHTML = st.points.map((p) => `<li><span style="color:${p.kind === 'ref' ? CSS.ref : CSS.check};font-weight:600">${esc(p.name)}</span> ${p.kind === 'ref' ? 'reference' : 'check point'}</li>`).join('') || '<li class="dim">None yet. Tap the photo.</li>';
}
function wireMap() {
  const cv = $('#map'), ptrs = new Map();
  let drag = null, downAt = null, pan = null, pinch = null, moved = false;
  const canvasXY = (ev) => { const r = cv.getBoundingClientRect(); return [((ev.clientX - r.left) / r.width) * cv.width, ((ev.clientY - r.top) / r.height) * cv.height]; };
  const toBase = ([x, y]) => [(x - st.view.ox) / st.view.s, (y - st.view.oy) / st.view.s];
  const hitR = () => Math.max(14, cv.width / 50) / st.view.s;
  const hitAt = (b) => st.points.find((p) => { const [x, y] = px(p.map); return Math.hypot(x - b[0], y - b[1]) < hitR() * 1.4; }) || null;
  cv.addEventListener('pointerdown', (ev) => {
    cv.setPointerCapture(ev.pointerId); ptrs.set(ev.pointerId, canvasXY(ev));
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s0: st.view.s, base: toBase([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) }; drag = null; pan = null; downAt = null; return; }
    if (ptrs.size > 2) return;
    const xy = canvasXY(ev), b = toBase(xy);
    downAt = xy; moved = false;
    const hit = hitAt(b);
    if (hit) drag = hit; else pan = { x: xy[0], y: xy[1], ox: st.view.ox, oy: st.view.oy };
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!ptrs.has(ev.pointerId)) return;
    ptrs.set(ev.pointerId, canvasXY(ev));
    if (pinch && ptrs.size >= 2) { const [a, b] = [...ptrs.values()], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; st.view.s = Math.max(1, Math.min(8, pinch.s0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d0)); st.view.ox = mid[0] - pinch.base[0] * st.view.s; st.view.oy = mid[1] - pinch.base[1] * st.view.s; clampView(); drawMap(); return; }
    const xy = canvasXY(ev);
    if (downAt && Math.hypot(xy[0] - downAt[0], xy[1] - downAt[1]) > 12) moved = true;
    if (drag && moved) { drag.map = unpx(toBase(xy)); drawMap(); } else if (pan && moved) { st.view.ox = pan.ox + xy[0] - pan.x; st.view.oy = pan.oy + xy[1] - pan.y; clampView(); drawMap(); }
  });
  const up = (ev, cancelled) => {
    ptrs.delete(ev.pointerId);
    if (pinch) { if (ptrs.size < 2) pinch = null; downAt = null; drag = null; pan = null; return; }
    const xy = canvasXY(ev);
    if (drag && moved) { drag = null; savePoints(); listPoints(); drawMap(); return; }
    const tap = !cancelled && downAt && !moved;
    drag = null; pan = null; downAt = null;
    if (!tap) return;
    const b = toBase(xy);
    if (hitAt(b)) return;
    st.points.push({ id: `${Date.now()}`, kind: st.adding, name: nextName(st.adding), map: unpx(b) });
    savePoints(); listPoints(); drawMap();
  };
  cv.addEventListener('pointerup', (ev) => up(ev, false));
  cv.addEventListener('pointercancel', (ev) => up(ev, true));
  cv.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomAt(ev.deltaY < 0 ? 1.25 : 0.8, canvasXY(ev)); }, { passive: false });
  const mid = () => [cv.width / 2, cv.height / 2];
  $('#zin').addEventListener('click', () => zoomAt(1.6, mid()));
  $('#zout').addEventListener('click', () => zoomAt(1 / 1.6, mid()));
  $('#zfit').addEventListener('click', () => { st.view = { s: 1, ox: 0, oy: 0 }; drawMap(); });
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    st.adding = b.dataset.add;
    document.querySelectorAll('[data-add]').forEach((x) => { x.classList.toggle('plain', x !== b); });
  }));
  $('#undo-point').addEventListener('click', () => { st.points.pop(); savePoints(); listPoints(); drawMap(); });
  $('#clear-pins').addEventListener('click', () => { st.pins = []; savePins(); drawMap(); });
}

/* ------------------------------------------------------ the lot's lidar */

function startLidar(m) {
  try {
    const w = new Worker('/lidar-worker.js', { type: 'module' });
    st.lid.worker = w;
    const pts = [...st.lawn.flat(), ...st.parcel.flat()], es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
    const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
    w.onmessage = ({ data }) => {
      if (data.progress) { st.lid.progress = data.progress; showLidar(); }
      if (data.ready) { st.lid.ready = data.ready; log(`lidar read: ${data.ready.points} points, ${data.ready.solid} solid cells, shift ${data.ready.shift}`); showLidar(); }
      if (data.overlay) { st.lid.overlay = data.overlay; st.lid.meshes = null; log(`lidar overlay: ${data.overlay.solids.length / 4} solid cells, ${data.overlay.tall.length / 5} tall cells`); }
      if (data.error) { st.lid.error = data.error; log(`lidar: ${data.error}`); showLidar(); }
      if (data.fix && st.L) { const f = answer(st.L, data.fix, data.id); if (f && st.L.fixes.length === 1) flash('You are here: the lidar found you'); }
    };
    w.onerror = (e) => { st.lid.error = e.message || 'the lidar reader failed'; showLidar(); };
    w.postMessage({ load: { origin: st.origin, box, lidar: m.tools?.shade?.data?.lidar || null } });
  } catch (e) { st.lid.error = e.message; showLidar(); }
}
function showLidar() {
  const el = $('#lidar'); if (!el) return;
  el.textContent = st.lid.error ? `The lidar could not be read (${st.lid.error}): references only.`
    : st.lid.ready ? `Lidar ready: ${st.lid.ready.points.toLocaleString()} points, ${st.lid.ready.solid.toLocaleString()} solid cells (walls, fences, trunks), lined up by ${st.lid.ready.shift}; buildings by ${st.lid.ready.rule || 'the AR copy'}${st.lid.ready.structures ? ` (${st.lid.ready.structures.building.toLocaleString()} m² of building)` : ''}.`
      : st.lid.progress || 'Reading the lidar…';
}

/* --------------------------------------------------------------- the AR */

function flash(text) { const f = $('#flash'); f.textContent = text; f.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => f.classList.remove('show'), 2400); }
const log = (what) => { st.errors.push({ t: Date.now(), what }); if (st.errors.length > 80) st.errors.shift(); };

async function startAR(engine) {
  const overlay = $('#overlay');
  st.walk = newWalk({ engine, phone: navigator.userAgent });
  st.walk.checks = [];
  st.L = newLocate();
  // the walk's twin (scan/lib/twin.js): its points, track and pictures go up to the site as it goes (src/twin.js)
  st.twin = newTwin({ walk: `${st.walk.startedAt}`, map: st.map || null, engine, started: st.walk.startedAt });
  st.twinUp = { queue: [], busy: false, off: null, sent: 0, failed: 0 };
  st.errors = []; st.ar = null; st.drawer = null;
  overlay.hidden = false; document.body.classList.add('in-ar');
  $('#hud').textContent = engine === '8thwall' ? 'Loading the engine… then the phone asks for the camera and the motion sensors.' : 'Starting…';
  const canvas = $('#cam');
  try {
    st.tracker = await start({ engine, overlay, canvas, eightWallUrl: ENGINE_URL, onFrame, onEvent });
    st.walk.features = st.tracker.features;
    // GPS, only as a place to start the lidar search from; kept in memory, never in the copy
    if (st.origin && navigator.geolocation) {
      try { st.gpsWatch = navigator.geolocation.watchPosition((pos) => { if (!st.ar?.pose || !st.L) return; const p = st.ar.pose.position; st.L.gps = { at: toLocal(st.origin, [pos.coords.longitude, pos.coords.latitude]), acc: pos.coords.accuracy, phone: [p.x, -p.z], t: Date.now() }; }, () => {}, { enableHighAccuracy: true, maximumAge: 2000 }); } catch { /* no GPS */ }
    }
  } catch (e) {
    log(`start failed: ${e.message}`);
    st.walk.endedAt = Date.now(); st.walk.failed = String(e.message || e);
    finish();
    $('#why').textContent = `AR would not start: ${e.message}`;
  }
}

function onEvent(ev) {
  if (!st.walk) return;
  if (ev.type === 'error') { log(`engine: ${ev.message}`); flash(`Engine: ${ev.message}`.slice(0, 80)); }
  if (ev.type === 'camera') log(`camera ${ev.status}`);
  if (ev.type === 'motion') log(`motion sensors ${ev.status}`);
  if (ev.type === 'tracking') log(`tracking ${ev.status} ${ev.reason || ''}`.trim());
  if (ev.type === 'end') finish();
}

/** What to mark next: an unmarked reference, then an unmarked check point, then the reference nearest the phone. */
function nextTarget() {
  const markedIds = new Set(st.L.marks.map((m) => m.id));
  const want = st.points.filter((p) => !markedIds.has(p.id));
  const first = want.find((p) => p.kind === 'ref') || want[0];
  if (first) return first;
  const me = st.ar?.pose ? mapOf(st.L, st.ar.pose.position, st.walk.odo) : null;
  const refs = st.points.filter((p) => p.kind === 'ref');
  return me ? refs.slice().sort((a, b) => Math.hypot(a.map[0] - me[0], a.map[1] - me[1]) - Math.hypot(b.map[0] - me[0], b.map[1] - me[1]))[0] || null : refs[0] || null;
}

function onFrame(f) {
  if (!st.walk) return;
  st.ar = f;
  const w = st.walk, L = st.L, odo = w.odo;
  const warnings = step(w, { t: f.t, pos: f.pose?.position, quat: f.pose?.quaternion, tracking: f.tracking, reset: f.reset, points: f.points });
  for (const x of warnings) {
    if (x === 'lost') flash('Lost its place: look around slowly');
    if (x === 'reset') flash('The tracking jumped: mark a reference again');
    if (x === 'fast') flash('Turn slower');
  }
  // the ground near the phone: the crosshair's depth when it is on the ground (0.8-2.5 m below the camera)
  if (f.hit?.type === 'DEPTH' && f.pose) { const drop = f.pose.position.y - f.hit.position.y; if (drop > 0.8 && drop < 2.5) noteGround(L, f.hit.position.y); }
  // the depth picture as points round the phone, four times a second; then, when it is time, a match
  if (f.depth && f.pose && f.tracking === 'normal' && f.t - st.depthAt > DEPTH_EVERY) {
    st.depthAt = f.t;
    const pts = [];
    for (let i = 0; i < 16; i++) for (let j = 0; j < 28; j++) { const p = f.depth.at((i + 0.5) / 16, (j + 0.5) / 28); if (p) pts.push(p); }
    addDepth(L, pts, odo, f.pose.position.y);
    if (st.twin) addPoints(st.twin, Date.now(), odo, pts, L.groundY);
  }
  // the twin: the camera's track, a picture now and then, and what has piled up sent every 15 s
  if (st.twin && f.pose) {
    const now = Date.now();
    addPose(st.twin, now, odo, f.pose.position, f.pose.quaternion, f.tracking);
    if (f.grab && f.tracking === 'normal' && !st.twinUp.off && wantKey(st.twin, now, f.pose.position, f.pose.quaternion)) {
      const g = f.grab();
      if (g) { const name = addKey(st.twin, now, odo, f.pose.position, f.pose.quaternion, g); g.blob.then((b) => b && sendTwin([{ name, type: 'image/jpeg', body: b }]), () => {}); }
    }
    if (flushDue(st.twin, now)) sendTwin(flush(st.twin, now, liveOf(L, w)));
  }
  if (st.lid.ready && st.lid.worker && f.tracking === 'normal') {
    const ask = nextAsk(L, odo, Date.now(), f.pose?.position || null);
    if (ask.id) st.lid.worker.postMessage({ register: { id: ask.id, stand: ask.stand, ground: ask.ground, high: ask.high, prior: ask.prior, s: ask.s } });
    else if (ask.why && !/too soon|running/.test(ask.why)) L.why = ask.why;
  }
  // draw
  if (f.gl && f.view && f.proj) {
    try {
      if (!st.drawer || st.drawer.gl !== f.gl) st.drawer = { gl: f.gl, d: makeDrawer(f.gl) };
      const items = [];
      for (const p of w.pins) {
        if (p.anchor) { const a = st.tracker?.anchorAt(p.anchor); if (a) p.anchorAt = a; }
        const now = pinNow(p);
        items.push({ kind: 'pin', at: now, color: COLOR.pin });
        if (now !== p.at) items.push({ kind: 'mark', at: p.at, color: COLOR.placed });
      }
      // the references and check points where the fit puts them: on the real corner when the fix is right
      const T = fitFor(L, odo);
      if (T) for (const p of st.points) { const s = sessionOf(L, p.map, odo, L.groundY ?? (f.pose ? f.pose.position.y - 1.4 : 0)); if (s && f.pose && levelDist(s, f.pose.position) < 30) items.push({ kind: 'mark', at: s, color: p.kind === 'ref' ? COLOR.ref : COLOR.check }); }
      if (w.pendingMeasure) items.push({ kind: 'mark', at: w.pendingMeasure.a, color: COLOR.mark });
      if (f.hit) items.push({ kind: 'dot', at: f.hit.position, color: f.hit.type === 'DEPTH' ? COLOR.dot : COLOR.dotPlane });
      // THE LIDAR IN THE CAMERA (owner, 2026-11-03: "so that I can see how it's lining up... mostly transparent, but
      // still visible... then add a black dot on them if the AR agrees with them"): the solid cells the match matches
      // against (blue), the canopy (green) and the roofs (orange), through the fit for this moment; black dots where
      // the phone's standing points land on a solid cell, red where they land on nothing
      const statics = [], dots = [];
      if (st.lidarOn && T && st.lid.overlay && f.pose) {
        if (!st.lid.meshes || st.lid.meshes.gl !== f.gl) {
          const m = lidarMeshes(st.lid.overlay);
          st.lid.meshes = { gl: f.gl, solids: st.drawer.d.makeMesh(m.solids), canopy: st.drawer.d.makeMesh(m.canopy), roofs: st.drawer.d.makeMesh(m.roofs) };
        }
        const me = mapOf(L, f.pose.position, odo);
        const groundHere = L.groundY ?? f.pose.position.y - 1.4;
        const dy = me ? groundHere - demAt(st.lid.overlay.dem1, me[0], me[1], groundHere) : 0;
        const model = mapToSession(T, dy);
        statics.push({ mesh: st.lid.meshes.solids, model, color: [0.35, 0.7, 1, 0.26], through: true });
        statics.push({ mesh: st.lid.meshes.canopy, model, color: [0.3, 0.9, 0.4, 0.12], through: true });
        statics.push({ mesh: st.lid.meshes.roofs, model, color: [1, 0.6, 0.3, 0.14], through: true });
        if (f.t - (st.agreeAt || 0) > 300) { st.agreeAt = f.t; st.agree = agreement(L, odo, st.lid.overlay.dist); }
        if (st.agree) { dots.push({ points: st.agree.on, color: [0, 0, 0, 0.95], r: 0.045 }); dots.push({ points: st.agree.off, color: [1, 0.25, 0.2, 0.7], r: 0.03 }); }
      } else st.agree = null;
      st.drawer.d.draw({ view: f.view, proj: f.proj, viewport: f.viewport, framebuffer: f.framebuffer, items, dots, statics });
    } catch (e) { if (!st.drawErr) { st.drawErr = true; log(`draw: ${e.message}`); } }
  }
  $('#cross').classList.toggle('hit', !!f.hit);
  if (f.t - st.hudAt > 200) { st.hudAt = f.t; hud(f); }
}

function hud(f) {
  const w = st.walk, L = st.L;
  const tr = f.tracking === 'normal' ? '<span class="ok">tracking</span>' : f.tracking === 'limited' ? '<span class="warn">tracking limited</span>' : '<span class="bad">no tracking yet: move the phone slowly over the ground</span>';
  const aim = f.hit ? `aim ${ftIn(f.hit.distance)} <span class="dim">(${f.hit.type === 'DEPTH' ? 'depth' : 'plane'})</span>${far(f.hit) ? ' <span class="warn">(far)</span>' : ''}` : 'no ground under the crosshair';
  const pts = f.points ? ` · ${f.points} pts` : '';
  const target = st.points.length ? nextTarget() : null;
  const ag = st.agree ? ` · lidar dots: <strong>${st.agree.on.length}</strong> on, ${st.agree.off.length} off` : '';
  const fixLine = st.origin ? `<br>${esc(st.lid.ready ? fixStatus(L, w.odo) : st.lid.error ? `No lidar (${st.lid.error}); references only: ${fixStatus(L, w.odo)}` : `Lidar: ${st.lid.progress || 'reading…'}`)}${ag}${target ? `<br>Next to mark: <strong style="color:${target.kind === 'ref' ? '#8ab4ff' : '#d9a6ff'}">${esc(target.name)}</strong> (aim where it meets the ground, within 10 ft, tap Mark)` : ''}` : '';
  const last = st.errors.length && Date.now() - st.errors[st.errors.length - 1].t < 6000 && /engine|start/.test(st.errors[st.errors.length - 1].what) ? `<br><span class="bad">${esc(st.errors[st.errors.length - 1].what)}</span>` : '';
  $('#hud').innerHTML = `${NAME[w.engine]} · ${tr} · walked ${Math.round(w.stats.walked * FT)} ft${pts} · ${aim} · ${w.pins.length} pin${w.pins.length === 1 ? '' : 's'}${w.pendingMeasure ? ' · <span class="warn">now aim at the second mark</span>' : ''}${fixLine}${last}`;
  const can = !!f.hit && f.tracking !== 'lost';
  $('#pin').disabled = !can; $('#measure').disabled = !can; $('#check').disabled = !can || !w.pins.length; $('#mark').disabled = !can || !target;
  if (f.t - (st.mapAt || 0) > 1000 && fitFor(L, w.odo)) { st.mapAt = f.t; drawMap(); }
}

/** The lidar ground at a map point from the 1 m grid the worker sent; `fallback` off the grid. */
function demAt(g, e, n, fallback) {
  if (!g) return fallback;
  const c = Math.floor((e - g.box[0]) / g.cell), r = Math.floor((g.box[3] - n) / g.cell);
  if (c < 0 || r < 0 || c >= g.W || r >= g.H) return fallback;
  const v = g.data[r * g.W + c];
  return Number.isFinite(v) ? v : fallback;
}

const nearestPin = (hit) => { let best = null, bd = 6; for (const p of st.walk.pins) { const d = levelDist(pinNow(p), hit.position); if (d < bd) { bd = d; best = p; } } return best; };

function wire() {
  $('#pin').addEventListener('click', () => {
    const f = st.ar; if (!f?.hit) return;
    if (far(f.hit) && Date.now() - st.farAt > FAR_AGAIN) { st.farAt = Date.now(); flash(`Aiming from ${ftIn(f.hit.distance)}: step closer, or tap again to drop it anyway`); return; }
    const p = dropPin(st.walk, f.hit);
    flash(`Pin ${p.name} dropped (${ftIn(p.aim || 0)}, by ${p.type === 'DEPTH' ? 'depth' : 'plane'})`);
    if (st.tracker?.anchor) st.tracker.anchor(p.at).then((a) => { if (a && st.walk && st.walk.pins.includes(p)) { p.anchor = a; p.anchorAt = st.tracker?.anchorAt(a) || { ...p.at }; } });
  });
  $('#check').addEventListener('click', () => {
    const f = st.ar; if (!f?.hit || !st.walk.pins.length) return;
    const p = nearestPin(f.hit);
    if (!p) { flash('No pin within 20 ft of the crosshair'); return; }
    const c = checkPin(st.walk, p, f.hit);
    flash(`Pin ${p.name}: ${ftIn(c.offLevelM)} off as placed${c.offAnchorLevelM != null ? `, ${ftIn(c.offAnchorLevelM)} as anchored` : ''} (${ftIn(c.walkedSinceM)} walked since)`);
  });
  $('#mark').addEventListener('click', () => {
    const f = st.ar; if (!f?.hit) return;
    const target = nextTarget(); if (!target) return;
    if (far(f.hit) && Date.now() - st.farAt > FAR_AGAIN) { st.farAt = Date.now(); flash(`Aiming from ${ftIn(f.hit.distance)}: step closer, or tap again to mark anyway`); return; }
    const odo = st.walk.odo;
    if (target.kind === 'check') {
      const c = checkError(st.L, target, f.hit, odo);
      mark(st.L, target, f.hit, odo);
      if (c) { st.walk.checks.push({ name: target.name, errorM: c.errorM, by: c.by, errorFixM: c.errorFixM, errorRefsM: c.errorRefsM, walkedSinceFixM: c.walkedSinceFixM, aimM: c.aim, walkedM: odo, marksBefore: st.L.marks.length - 1, fixesBefore: st.L.fixes.length }); flash(`${target.name}: ${ftIn(c.errorM)} off (${c.by === 'fix' ? 'lidar fix' : 'references'}${c.errorRefsM != null && c.by === 'fix' ? `; ${ftIn(c.errorRefsM)} by the references alone` : ''})`); } else flash(`${target.name} marked; not placed yet, so no error to give`);
    } else {
      mark(st.L, target, f.hit, odo);
      const n = new Set(st.L.marks.filter((m) => m.kind === 'ref').map((m) => m.id)).size;
      flash(n >= 2 ? `${target.name} marked: lined up by ${n} references` : `${target.name} marked: one more reference lines the map up`);
    }
    log(`marked ${target.name} (${target.kind}) from ${f.hit.distance?.toFixed(2)} m`);
  });
  $('#measure').addEventListener('click', () => {
    const f = st.ar; if (!f?.hit) return;
    const m = measure(st.walk, f.hit);
    flash(m ? `Measured ${ftIn(m.m)} (${m.m.toFixed(2)} m)` : 'First mark set: aim at the second and tap Measure');
  });
  $('#undo').addEventListener('click', () => { const u = undo(st.walk); flash(u === 'pin' ? 'Pin removed' : u === 'measure' ? 'First mark cleared' : 'Nothing to undo'); });
  $('#exit').addEventListener('click', () => { if (st.tracker) st.tracker.stop(); else finish(); });
  $('#move').addEventListener('click', () => $('#overlay').classList.toggle('bar-low'));
  $('#lidar-toggle').addEventListener('click', () => { st.lidarOn = !st.lidarOn; $('#lidar-toggle').classList.toggle('off', !st.lidarOn); flash(st.lidarOn ? 'Lidar shown' : 'Lidar hidden'); });
}

/* ------------------------------------------------------------ results */

const KEY = 'scan-walks';
const kept = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const keep = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-12))); } catch { /* this phone only */ } };

function finish() {
  if (!st.walk) return;
  const w = st.walk, L = st.L;
  w.endedAt = w.endedAt || Date.now();
  try { if (st.gpsWatch != null) navigator.geolocation.clearWatch(st.gpsWatch); } catch { /* none */ }
  st.gpsWatch = null;
  // the pins' map positions, by the fit at the moment each was dropped: kept on this phone, drawn on the photo (phase 3 writes them to the map)
  if (L && st.origin) {
    for (const p of w.pins) {
      const m = mapOf(L, pinNow(p), p.odo);
      if (m) st.pins.push({ name: `${p.name}`, map: m, at: w.startedAt });
      // how far the pin is from the nearest reference or check point (the owner says which it was dropped on): distances only
      p.nearest = nearestNamed(L, pinNow(p), p.odo, st.points);
    }
    savePins();
  }
  const refs = st.points.filter((p) => p.kind === 'ref').map((p) => ({ name: p.name, marks: L ? L.marks.filter((m) => m.id === p.id).length : 0, leftOutM: L ? r3(leftOut(L.marks.filter((m) => m.kind === 'ref'), p.id)) : null }));
  const s = summary(w, {
    page: 'yard AR test v2', features: w.features || null, failed: w.failed || null, errors: st.errors.map((e) => e.what).slice(-30),
    references: refs, checks: (w.checks || []).map((c) => ({ ...c, errorM: r3(c.errorM), errorFixM: r3(c.errorFixM), errorRefsM: r3(c.errorRefsM), walkedSinceFixM: r2(c.walkedSinceFixM), aimM: r2(c.aimM), walkedM: r2(c.walkedM) })),
    pinsNear: w.pins.map((p) => ({ name: p.name, nearest: p.nearest ? { name: p.nearest.name, m: r2(p.nearest.m), byRefsM: r2(p.nearest.byRefsM) } : null })),
    fix: L ? summaryOf(L) : null, lidar: st.lid.ready ? { points: st.lid.ready.points, solid: st.lid.ready.solid, shift: st.lid.ready.shift, rule: st.lid.ready.rule || null, structures: st.lid.ready.structures || null, tallCells: st.lid.overlay ? st.lid.overlay.tall.length / 5 : null } : st.lid.error ? { error: st.lid.error } : null,
  });
  s.id = `${w.startedAt}`; s.saved = null;
  if (st.twin) {
    sendTwin(flush(st.twin, Date.now(), liveOf(L, w, { ended: true, summary: s.id })));
    s.twin = { ...st.twin.counts, camera: st.twin.camera, off: st.twinUp.off };
  }
  st.twin = null;
  st.tracker = null; st.walk = null; st.L = null; st.ar = null; st.drawer = null;
  $('#overlay').hidden = true; document.body.classList.remove('in-ar');
  const list = kept(); list.push(s); keep(list);
  renderResults(s.id); drawMap();
  post(s);
}
const r2 = (v) => (v == null ? null : +Number(v).toFixed(2)), r3 = (v) => (v == null ? null : +Number(v).toFixed(3));

/** The twin's parts up to the site (src/twin.js), one at a time, each tried twice; a missing bucket stops it. */
function sendTwin(parts) {
  const up = st.twinUp, walk = st.twin?.walk || up.walk;
  if (!up || up.off || !parts?.length) return;
  up.walk = walk;
  for (const p of parts) up.queue.push(p);
  if (up.busy) return;
  up.busy = true;
  (async () => {
    while (up.queue.length && !up.off) {
      const p = up.queue.shift();
      let ok = false;
      for (let tries = 0; tries < 2 && !ok; tries++) {
        try {
          const res = await fetch(`/api/scan/twin?walk=${encodeURIComponent(up.walk)}&part=${encodeURIComponent(p.name)}`, { method: 'PUT', headers: { 'Content-Type': p.type }, body: p.body });
          ok = res.ok;
          if (res.status === 503) { up.off = 'the site has no twin bucket yet'; break; }
          if (!ok && res.status < 500) break;
        } catch { /* tried again */ }
        if (!ok && tries === 0) await new Promise((r) => setTimeout(r, 3000));
      }
      if (ok) up.sent++; else { up.failed++; if (st.twin) st.twin.counts.failed++; }
    }
    up.busy = false;
  })();
}

/** A walk to the site's own database (scan/src/walks.js); failing that it stays on this phone. */
async function post(s) {
  let saved = false, why = '';
  try {
    const res = await fetch('/api/scan/walks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    saved = res.ok;
    if (!res.ok) why = (await res.json().catch(() => ({})))?.error || `${res.status}`;
  } catch (e) { why = e.message; }
  const all = kept(), mine = all.find((x) => x.id === s.id);
  if (mine) { mine.saved = saved; mine.savedWhy = saved ? null : why; keep(all); }
  renderResults(s.id);
}

function renderResults(focus = null) {
  const list = kept().slice().reverse();
  const box = $('#results');
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h2>Walks on this phone</h2>${list.map((s, i) => walkCard(s, i === 0 || s.id === focus)).join('')}`;
  box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const s = kept().find((x) => x.id === b.dataset.copy);
    try { await navigator.clipboard.writeText(JSON.stringify(s, null, 1)); b.textContent = 'Copied'; } catch { b.textContent = 'Could not copy'; }
  }));
  box.querySelectorAll('[data-forget]').forEach((b) => b.addEventListener('click', () => { keep(kept().filter((x) => x.id !== b.dataset.forget)); renderResults(); }));
  box.querySelectorAll('input[data-tape]').forEach((inp) => inp.addEventListener('change', () => {
    const [id, i] = inp.dataset.tape.split(':');
    const all = kept(), s = all.find((x) => x.id === id), m = s?.measures[+i];
    if (!m) return;
    const metres = Number(inp.value) / FT;
    const r = tapeFor({ m: m.metres }, metres);
    m.tapedM = metres > 0 ? +metres.toFixed(3) : null; m.shortBy = r ? +r.shortBy.toFixed(4) : null;
    keep(all); renderResults(id); post(s);
  }));
}

function walkCard(s, open) {
  const pc = (v) => `${(Math.abs(v) * 100).toFixed(1)}% ${v > 0 ? 'short' : 'long'}`;
  const pins = s.pins.map((p) => `<tr><td>${esc(p.name)}${p.anchored ? '*' : ''}<br><span class="dim">${p.type === 'DEPTH' ? 'depth' : 'plane'}${p.planeOffYM != null ? `; plane ${ftIn(Math.abs(p.planeOffYM))} ${p.planeOffYM > 0 ? 'above' : 'below'}` : ''}</span></td><td>${p.aimM != null ? ftIn(p.aimM) : '?'}</td><td>${p.checks.length ? p.checks.map((c) => `<strong>${ftIn(c.offLevelM)}</strong>${c.offAnchorLevelM != null ? ` / <strong>${ftIn(c.offAnchorLevelM)}</strong>*` : ''} after ${ftIn(c.walkedSinceM)}`).join('<br>') : '<span class="dim">not checked</span>'}</td></tr>`).join('');
  const measures = s.measures.map((m, i) => `<tr><td>${ftIn(m.metres)} <span class="dim">(${m.metres} m)</span></td><td>tape <input type="number" step="0.1" min="0" inputmode="decimal" data-tape="${esc(s.id)}:${i}" value="${m.tapedM ? (m.tapedM * FT).toFixed(1) : ''}" aria-label="What the tape said, feet"> ft</td><td>${m.shortBy != null ? `<strong>${pc(m.shortBy)}</strong>` : ''}</td></tr>`).join('');
  const checks = (s.checks || []).map((c) => `<tr><td>${esc(c.name)}</td><td><strong>${ftIn(c.errorM)}</strong> off</td><td class="dim">${c.by === 'fix' ? `lidar fix, ${ftIn(c.walkedSinceFixM || 0)} of walk before` : 'references'}${c.errorRefsM != null && c.by === 'fix' ? `; by the references alone ${ftIn(c.errorRefsM)}` : ''}; aimed from ${c.aimM != null ? ftIn(c.aimM) : '?'}</td></tr>`).join('');
  const near = (s.pinsNear || []).filter((p) => p.nearest).map((p) => `${esc(p.name)} is ${ftIn(p.nearest.m)} from ${esc(p.nearest.name)}${p.nearest.byRefsM != null ? ` (${ftIn(p.nearest.byRefsM)} by the references alone)` : ''}`).join('; ');
  const refs = (s.references || []).filter((r) => r.marks).map((r) => `${esc(r.name)} marked ${r.marks === 1 ? 'once' : `${r.marks} times`}${r.leftOutM != null ? ` (<strong>${ftIn(r.leftOutM)}</strong> off when the others line it up)` : ''}`).join('; ');
  const fx = s.fix;
  const x = s.stats;
  return `<details class="card"${open ? ' open' : ''}><summary><strong>${esc(NAME[s.engine] || s.engine)}</strong> · ${new Date(s.when).toLocaleString()} · ${Math.round(s.seconds / 60)} min${s.failed ? ' · <span class="warn">did not start</span>' : ''}</summary>
    ${s.failed ? `<p class="warn">${esc(s.failed)}</p>` : ''}
    <p class="dim">${s.saved === true ? 'Saved to the site.' : s.saved === false ? `On this phone only (not saved: ${esc(s.savedWhy || '?')}).` : 'Saving…'}</p>
    <p>Walked ${Math.round(x.walkedM * FT)} ft; lost its place ${x.losses} time${x.losses === 1 ? '' : 's'}; ${x.resets} jump${x.resets === 1 ? '' : 's'}; ${x.fastTurns} fast turn${x.fastTurns === 1 ? '' : 's'}; tracked ${x.trackedShare != null ? Math.round(x.trackedShare * 100) : '?'}% of frames${s.points?.maxAtOnce ? `; up to ${s.points.maxAtOnce} points seen at once` : ''}.</p>
    ${fx ? `<p><strong>Where you were:</strong> ${fx.fixes} lidar fix${fx.fixes === 1 ? '' : 'es'} from ${fx.asks} tries${fx.fixes ? ` (${Math.round(100 * fx.fixHits.reduce((a, b) => a + b, 0) / fx.fixHits.length)}% of points landed on average)` : ''}; ${fx.references} reference${fx.references === 1 ? '' : 's'}, ${fx.marks} marks. ${Object.keys(fx.refused || {}).length ? `Refused: ${esc(Object.entries(fx.refused).map(([k, v]) => `${k} (${v})`).join('; '))}.` : ''}${s.lidar?.error ? ` <span class="warn">Lidar: ${esc(s.lidar.error)}</span>` : s.lidar ? ` Lidar: ${s.lidar.points.toLocaleString()} points, ${s.lidar.solid.toLocaleString()} solid cells.` : ''}</p>` : ''}
    ${s.twin ? `<p>Twin: ${s.twin.points.toLocaleString()} points, ${s.twin.keys} picture${s.twin.keys === 1 ? '' : 's'}${s.twin.off ? ` <span class="warn">not kept: ${esc(s.twin.off)}</span>` : s.twin.failed ? ` <span class="warn">(${s.twin.failed} part${s.twin.failed === 1 ? '' : 's'} did not upload)</span>` : ''}. <a href="/twin.html?walk=${encodeURIComponent(s.id)}">See how it lines up</a></p>` : ''}
    ${refs ? `<p class="dim">References: ${refs}.</p>` : ''}
    ${near ? `<p class="dim">Pins on the map: ${near}.</p>` : ''}
    ${checks ? `<table><tr><th>Check point</th><th>On the map</th><th>By</th></tr>${checks}</table>` : ''}
    ${pins ? `<table style="margin-top:8px"><tr><th>Pin</th><th>Aimed from</th><th>Off its spot when checked (as placed / *anchored)</th></tr>${pins}</table>` : '<p class="dim">No pins.</p>'}
    ${measures ? `<table style="margin-top:8px"><tr><th>Measured</th><th>Tape</th><th>Error</th></tr>${measures}</table>` : ''}
    ${s.errors?.length ? `<details><summary class="dim">Messages (${s.errors.length})</summary><pre>${esc(s.errors.join('\n'))}</pre></details>` : ''}
    <div class="tools"><button type="button" data-copy="${esc(s.id)}">Copy results</button><button type="button" class="plain" data-forget="${esc(s.id)}">Forget this walk</button></div>
  </details>`;
}

wire(); wireMap();
main().catch((e) => { $('#status').textContent = `This page could not start: ${e.message}`; });
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) setTimeout(() => { if (st.has8w) load8thWall(ENGINE_URL).catch(() => {}); }, 1500);
