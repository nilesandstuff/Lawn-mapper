/**
 * PLACING HEADS IN AR: THE ADMIN TEST PAGE (owner, 2026-10-31: "make an AR tool that you walk the lawn with and point a
 * cursor at the head, tap place, and it puts a pin there... initially test it on a seperate admin only page to be sure
 * it's actually usable before shipping it"; FINDINGS H64, H65).
 *
 * WebXR's immersive-ar session (Chrome on Android, ARCore) with hit-test: the crosshair's ray meets the ground the phone
 * has found. References marked both on the saved map's photo and in AR line the two up (lib/ar-align.js: a turn and a
 * shift, least squares); then each Place head is a pin on the map. Check points, marked on both but left out of the
 * fit, say how far off a placed head lands.
 *
 * The phone's frame drifts as it walks and turns (the owner's first walk: reasonable in the front, 20 ft off in the
 * back, worse again on coming back). So references can be marked again and again as they are passed; every mark keeps
 * how far the phone had walked when it was made, and each moment is lined up by the marks the shortest walk away
 * (fitMixedAt). Edges (a driveway's or sidewalk's edge drawn on the photo) can be marked at any spot along them; AR's
 * scale is measured between references marked one after the other and held in the fit (this phone's AR measured
 * 3.6-4.4% short, H66; fitting it freely soaked up drift). Each mark is
 * also an ARCore anchor where the phone supports them, so ARCore's own corrections move it.
 *
 * Nothing here writes to the map: the points and pins are kept on this phone (per map) and the results copied by hand.
 */
import { toLocal, fromLocal, arLevel, fitDrift, apply, headingOf, baseline, edgeOff, pairScale } from '/lib/ar-align.js';
import { tracedOn, lineUpAt } from '/lib/shade/traced.js';
import { unproject } from '/lib/ar-lidar.js';
import { openable } from '/lib/maps.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FT = 3.28084;
const ftIn = (m) => { const inch = Math.round(m * FT * 12); return inch < 12 ? `${inch} in` : `${Math.floor(inch / 12)} ft ${inch % 12} in`; };
const ft = (m) => `${Math.round(m * FT)} ft`;

const AIM_FAR = 3.5;      // m: aiming farther than this, the ground's height error grows into the reading (H65)
const WALK_REMARK = 20;   // m walked since the last reference mark: ask for one
const LOSS_WALK = 10;     // m added to the walk when tracking is lost: what came before counts for less
const RESET_WALK = 1000;  // m added when ARCore says its frame jumped: what came before counts for nothing
const FAST_TURN = 90;     // degrees a second
const STEP = 0.5;         // m: the walk counts moves this long, so the hand's sway is not walking (H66: 508 m counted)
const EDGE_W = 0.5;       // an edge mark counts half a point: the photo's edge is less sharp than a corner
const SCALE_OK = [0.9, 1.1];
const ANCHOR_MAX = 1.5;   // m: an anchor moved farther than this jumped (H67: one moved a head 21 m); its first reading is kept
const FAR_AGAIN = 3000;   // ms: placing from farther than AIM_FAR takes a second tap within this

/* ---------------------------------------------------------------- the map */

const R = 6378137;
const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];
const fromMerc = ([x, y]) => [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
const worldSize = (zoom) => 512 * 2 ** zoom;
const mercToWorld = ([x, y], zoom) => [((x + Math.PI * R) / (2 * Math.PI * R)) * worldSize(zoom), ((Math.PI * R - y) / (2 * Math.PI * R)) * worldSize(zoom)];
const worldToMerc = ([wx, wy], zoom) => [(wx / worldSize(zoom)) * 2 * Math.PI * R - Math.PI * R, Math.PI * R - (wy / worldSize(zoom)) * 2 * Math.PI * R];

const st = { site: null, origin: null, frame: null, photo: null, shift: [0, 0], heads: [], lawn: [], points: [], pins: [], adding: 'ref', key: null, T: null, session: 0, view: { s: 1, ox: 0, oy: 0 }, events: [] };

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
  if (!res.ok) throw new Error(`${res.status}`);
  return createImageBitmap(await res.blob());
}
/** The photo the lawn was traced on, as the water map shows it (public/app.js savedPhoto). */
async function savedPhoto(frame, traced) {
  const t = traced || { provider: 'mapbox' };
  if (t.provider === 'county') {
    try {
      const photo = await photoOf(frame, 'county', t.svc);
      const move = lineUpAt(t, [frame.lng, frame.lat]);
      const k = Math.cos((frame.lat * Math.PI) / 180), s = (worldSize(frame.zoom) / (2 * Math.PI * R)) * (photo.width / frame.size);
      return { photo, shift: [(move.east / k) * s, -(move.north / k) * s] };
    } catch { /* Mapbox's instead */ }
  }
  return { photo: await photoOf(frame).catch(() => null), shift: [0, 0] };
}
const photoW = () => (st.photo ? st.photo.width : 1280), photoH = () => (st.photo ? st.photo.height : 1280);
// map metres (east, north of the map's point) <-> pixels on the photo
function toPx([e, n]) {
  const f = st.frame, w = photoW(), h = photoH();
  const c = mercToWorld(toMerc([f.lng, f.lat]), f.zoom), p = mercToWorld(toMerc(fromLocal(st.origin, [e, n])), f.zoom), s = w / f.size;
  return [(p[0] - c[0]) * s + w / 2 + st.shift[0], (p[1] - c[1]) * s + h / 2 + st.shift[1]];
}
function fromPx([x, y]) {
  const f = st.frame, w = photoW(), h = photoH(), s = w / f.size;
  const c = mercToWorld(toMerc([f.lng, f.lat]), f.zoom);
  const wx = (x - w / 2 - st.shift[0]) / s + c[0], wy = (y - h / 2 - st.shift[1]) / s + c[1];
  return toLocal(st.origin, fromMerc(worldToMerc([wx, wy], f.zoom)));
}

/* --------------------------------------------- marks, the walk and the fit */

const marked = (p) => p.marks?.length > 0;
const lastMark = (p) => (marked(p) ? p.marks[p.marks.length - 1] : null);
/** Every reference and edge mark this session, as fitMixedAt wants them. */
const cons = () => st.points.filter((p) => p.kind === 'ref' || p.kind === 'edge').flatMap((p) => (p.marks || []).map((m) => (p.kind === 'edge'
  ? { kind: 'edge', id: p.id, ar: arLevel(m.ar), a: p.a, b: p.b, odo: m.odo, w: EDGE_W, p, m }
  : { kind: 'pt', id: p.id, ar: arLevel(m.ar), map: p.map, odo: m.odo, p, m })));
const refMarks = () => cons().filter((c) => c.kind === 'pt');
/** This phone's AR scales from earlier walks (photo distance / AR distance), latest last. */
function learnedScales() {
  try { return JSON.parse(localStorage.getItem('ar-scales') || '[]').filter(Number.isFinite); } catch { return []; }
}
/** This walk's scale: between references marked one after the other (lib/ar-align.js pairScale). */
const sessionScale = () => pairScale(refMarks().map((r) => ({ ar: r.ar, map: r.map, odo: r.odo, id: r.p.id })));
const median = (v) => { const w = [...v].sort((a, b) => a - b); return w.length % 2 ? w[w.length >> 1] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2; };
/** The scale the fit holds: this walk's pairs (up to three votes) with the earlier walks', or 1 with none; 0.9-1.1 only. */
function learnedScale() {
  const sc = sessionScale(), votes = [...learnedScales(), ...(sc ? Array(Math.min(sc.n, 3)).fill(sc.k) : [])];
  const k = votes.length ? median(votes) : 1;
  return k >= SCALE_OK[0] && k <= SCALE_OK[1] ? k : 1;
}
const distinctRefs = (list) => new Set(list.filter((c) => c.kind === 'pt').map((c) => c.p)).size;
/** The fit for a moment of the walk: the turn from pairs, the shift from what is near, the phone's scale held (fitDrift). */
const fitWith = (list, odo) => fitDrift(list, odo, { scale: learnedScale() });
const refFit = (odo) => fitWith(cons(), odo);
/** The fit for a moment: the lidar's fix nearest it in the walk, within FIX_REACH; else the references' (H68). */
const fitFor = (odo) => { const f = nearestFix(odo); return f && Math.abs(f.odo - odo) <= FIX_REACH ? f.T : refFit(odo); };

/* ----------------------------------------------- "you are here" from the lidar (H68) */

const FIX_REACH = 20;  // m of walk a lidar fix stands for
const VOX = 0.2;       // m: the phone's depth points kept one to a cell this size
const LID = { worker: null, ready: null, error: null, progress: '', fixes: [], pending: false, last: null, asks: 0, id: 0, gps: null, why: null };
const nearestFix = (odo) => LID.fixes.reduce((b, f) => (!b || Math.abs(f.odo - odo) < Math.abs(b.odo - odo) ? f : b), null);
const thinTo = (a, m) => (a.length <= m ? a : a.filter((_, i) => i % Math.ceil(a.length / m) === 0));

/** Read the lot's lidar in the worker (public/ar-lidar-worker.js): the lawn and 20 m round it. */
function startLidar(m) {
  try {
    const w = new Worker('/ar-lidar-worker.js', { type: 'module' });
    LID.worker = w;
    const pts = st.lawn.flat(), es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
    const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
    w.onmessage = ({ data }) => {
      if (data.progress) { LID.progress = data.progress; showLidar(); }
      if (data.ready) { LID.ready = data.ready; log(`lidar read: ${data.ready.points} points`); showLidar(); listPoints(); }
      if (data.error) { LID.error = data.error; log(`lidar: ${data.error}`); showLidar(); listPoints(); }
      if (data.fix) onFix(data.fix, data.id);
    };
    w.onerror = (e) => { LID.error = e.message || 'the lidar reader failed'; showLidar(); listPoints(); };
    w.postMessage({ load: { origin: st.origin, box, lidar: m.tools?.shade?.data?.lidar || null } });
  } catch (e) { LID.error = e.message; showLidar(); }
}
function showLidar() {
  const el = $('#lidar'); if (!el) return;
  el.textContent = LID.error ? `The lidar could not be read (${LID.error}): references only.`
    : LID.ready ? `Lidar ready (${LID.ready.points.toLocaleString()} points). In AR the page works out where you are from what the camera sees: look round at the house, fences, bushes and trees as you walk. References are optional; check points still measure how close it is.`
      : LID.progress || 'Reading the lidar…';
}

/** Four times a second: the depth picture as points round the phone (to 8 m, ARCore's reach), on the ground or standing (0.4-2.4 m up). */
function collectDepth(frame, pose) {
  if (!xr.sense?.granted?.includes('depth-sensing')) return;
  const view = pose.views?.[0]; if (!view || typeof frame.getDepthInformation !== 'function') return;
  let d = null; try { d = frame.getDepthInformation(view); } catch { d = null; }
  if (!d) return;
  const P = view.projectionMatrix, M = view.transform.matrix;
  const gy = xr.groundY ?? pose.transform.position.y - 1.35;
  for (let i = 0; i < 16; i++) for (let j = 0; j < 28; j++) {
    const x = (i + 0.5) / 16, y = (j + 0.5) / 28, z = d.getDepthInMeters(x, y);
    if (!(z > 0.4 && z < 8)) continue;
    const [X, Y, Z] = unproject(x, y, z, P, M);
    const h = Y - gy, cls = Math.abs(h) < 0.2 ? 'g' : h > 0.4 && h < 2.4 ? 's' : null;
    if (!cls) continue;
    xr.cloud.set(`${Math.floor(X / VOX)},${Math.floor(Z / VOX)},${cls}`, { u: X, v: -Z, y: Y, odo: xr.odo, cls });
  }
  if (xr.cloud.size > 8000) for (const [k, p] of xr.cloud) if (p.odo < xr.odo - 40) xr.cloud.delete(k);
}

/** Every 1.5 s: the last 25 m of the walk's points to the worker, from the last fix, the references, or GPS. */
function maybeRegister() {
  if (!LID.ready || LID.pending || !xr?.tracking || Date.now() - (LID.lastAsk || 0) < 1500) return;
  const recent = [...xr.cloud.values()].filter((p) => p.odo > xr.odo - 25);
  const stand = recent.filter((p) => p.cls === 's').map((p) => [p.u, p.v]), ground = recent.filter((p) => p.cls === 'g').map((p) => [p.u, p.v, p.y]);
  if (stand.length < 30) { LID.why = `the camera has ${stand.length} points on walls, fences, bushes or trunks within 25 ft (30 wanted): look round at them`; return; }
  const last = nearestFix(xr.odo);
  let prior = null;
  if (last && Math.abs(last.odo - xr.odo) < FIX_REACH) prior = { T: last.T, searchM: 1.5, searchDeg: 6 };
  else {
    const ref = refFit(xr.odo);
    if (ref) prior = { T: ref, searchM: 4, searchDeg: 15 };
    else if (LID.gps && Date.now() - LID.gps.t < 30000) prior = { at: LID.gps.at, phone: LID.gps.phone, radiusM: Math.max(6, Math.min(20, LID.gps.acc * 1.5)) };
  }
  if (!prior) { LID.why = 'waiting for GPS (or two references) to start from'; return; }
  LID.pending = true; LID.lastAsk = Date.now(); LID.asks++;
  const id = ++LID.id; LID.asked = { id, odo: xr.odo, from: prior.T ? (last && prior.T === last.T ? 'the last fix' : 'the references') : 'GPS' };
  LID.worker.postMessage({ register: { id, stand: thinTo(stand, 600), ground: thinTo(ground, 300), prior, s: learnedScale() } });
}
function onFix(fix, id) {
  LID.pending = false;
  if (!LID.asked || LID.asked.id !== id) return;
  LID.last = { ok: fix.ok, why: fix.why || null, hits: fix.hits ?? null, runnerUp: fix.runnerUp || null, from: LID.asked.from };
  if (fix.ok) {
    const first = !LID.fixes.length;
    LID.fixes.push({ T: fix.T, odo: LID.asked.odo, hits: fix.hits, at: Date.now() });
    if (LID.fixes.length > 300) LID.fixes.shift();
    LID.why = null;
    if (first) { log(`first lidar fix from ${LID.asked.from}: ${Math.round(fix.hits * 100)}% on the lidar`); navigator.vibrate?.([30, 60, 30]); flash('Found where you are'); }
    refit();
  } else LID.why = fix.why;
}
// a pin placed in this AR session is lined up by the marks the shortest walk from it (made before or after); one from
// an earlier session keeps where it was put
function pinMap(p) {
  if (p.ar && p.session === st.session) { const T = fitFor(p.odo); if (T) return apply(T, arLevel(p.ar)); }
  return p.map || null;
}
/** A check point's latest mark: where it landed and how far off. */
function checkLanding(p) {
  const m = lastMark(p); if (!m) return null;
  const T = fitFor(m.odo); if (!T) return null;
  const at = apply(T, arLevel(m.ar));
  const nearest = Math.min(...cons().map((r) => Math.abs(r.odo - m.odo)));
  return { at, error: Math.hypot(at[0] - p.map[0], at[1] - p.map[1]), walked: nearest, dist: m.dist };
}
/**
 * Each reference tested against the others (owner's first walk: two references 31 m apart that AR measured 4% short,
 * so each was 0.65 m from fitting and nothing said which was wrong). Its latest mark, lined up by every other
 * reference's marks: how far from its place on the photo it lands. With three or more, the odd one out shows.
 */
function leftOut(p) {
  const m = lastMark(p); if (!m) return null;
  const others = cons().filter((r) => r.p !== p);
  if (distinctRefs(others) < 2) return null;
  const T = fitWith(others, m.odo); if (!T) return null;
  const at = apply(T, arLevel(m.ar));
  return Math.hypot(at[0] - p.map[0], at[1] - p.map[1]);
}
/** AR's distances against the photo's, between the references: 1 if they agree. */
/** AR's distances against the photo's: { k held (photo / AR), walk: this walk's pairs or null, earlier: walks kept }. */
const scaleNow = () => ({ k: learnedScale(), walk: sessionScale(), earlier: learnedScales().length });
/** How far an edge's latest mark lands from its line, metres. */
function edgeLanding(p) {
  const m = lastMark(p); if (!m) return null;
  const T = fitFor(m.odo); if (!T) return null;
  return edgeOff(p, apply(T, arLevel(m.ar)));
}
const walkedSinceRef = () => { const r = cons(); return r.length && xr ? Math.min(...r.map((q) => xr.odo - q.odo)) : null; };

/* ---------------------------------------------------------------- drawing */

function drawMarks(ctx, P, r) {
  ctx.lineWidth = Math.max(1.5, r / 3); ctx.strokeStyle = 'rgba(255,255,255,.85)';
  for (const ring of st.lawn) { ctx.beginPath(); ring.forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke(); }
  for (const h of st.heads) { const [x, y] = P(h.map); ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill(); ctx.strokeStyle = '#333'; ctx.lineWidth = r / 8; ctx.stroke(); }
  st.points.filter((pt) => pt.kind === 'edge').forEach((pt) => {
    const [ax, ay] = P(pt.a), [bx, by] = P(pt.b), col = cssVar('--edge');
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = r * 0.9; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = marked(pt) ? r * 0.6 : r * 0.35; ctx.setLineDash(marked(pt) ? [] : [r, r * 0.6]); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    for (const [x, y] of [[ax, ay], [bx, by]]) { ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill(); }
    const [mx, my] = P(pt.map);
    ctx.fillStyle = '#fff'; ctx.font = `bold ${r * 1.6}px system-ui`; ctx.strokeStyle = '#000'; ctx.lineWidth = r / 3; ctx.strokeText(pt.name, mx + r, my - r); ctx.fillText(pt.name, mx + r, my - r);
  });
  if (st.pendingEdge) { const [x, y] = P(st.pendingEdge); ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, 2 * Math.PI); ctx.fillStyle = cssVar('--edge'); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = r / 4; ctx.stroke(); }
  st.points.filter((pt) => pt.kind !== 'edge').forEach((pt) => {
    const [x, y] = P(pt.map), col = pt.kind === 'ref' ? cssVar('--ref') : cssVar('--check');
    if (pt.kind === 'check') { const l = checkLanding(pt); if (l) { const [ax, ay] = P(l.at); ctx.strokeStyle = col; ctx.lineWidth = r / 4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ax, ay); ctx.stroke(); ctx.beginPath(); ctx.arc(ax, ay, r * 0.5, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill(); } }
    ctx.beginPath(); ctx.rect(x - r, y - r, 2 * r, 2 * r); ctx.lineWidth = r / 3.5; ctx.strokeStyle = col; ctx.stroke();
    if (marked(pt)) { ctx.fillStyle = col; ctx.fill(); }
    ctx.fillStyle = '#fff'; ctx.font = `bold ${r * 1.6}px system-ui`; ctx.strokeStyle = '#000'; ctx.lineWidth = r / 3; ctx.strokeText(pt.name, x + r * 1.3, y - r * 0.6); ctx.fillText(pt.name, x + r * 1.3, y - r * 0.6);
  });
  for (const pin of st.pins) { const m = pinMap(pin); if (!m) continue; const [x, y] = P(m); ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, 2 * Math.PI); ctx.fillStyle = cssVar('--pin'); ctx.fill(); ctx.lineWidth = r / 4; ctx.strokeStyle = '#fff'; ctx.stroke(); }
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#f00';

/* The setup map, zoomable (owner, 2026-10-31: "placing the reference points and check points was difficult on such a
   small map that couldn't be zoomed in any further"). view: canvas px = photo px * s + (ox, oy). */
const BASE_R = () => Math.max(6, photoW() / 120);
function drawMap() {
  const cv = $('#map'), w = photoW(), h = photoH(), v = st.view;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#2a332f'; ctx.fillRect(0, 0, w, h);
  ctx.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);
  if (st.photo) ctx.drawImage(st.photo, st.shift[0], st.shift[1]);
  // marks keep their size on the screen as it zooms, up to a point
  drawMarks(ctx, toPx, BASE_R() / Math.sqrt(v.s));
}
function clampView() {
  const v = st.view, w = photoW(), h = photoH();
  v.s = Math.max(1, Math.min(8, v.s));
  v.ox = Math.min(0, Math.max(w - w * v.s, v.ox)); v.oy = Math.min(0, Math.max(h - h * v.s, v.oy));
}
function zoomAt(k, [cx, cy]) {
  const v = st.view, bx = (cx - v.ox) / v.s, by = (cy - v.oy) / v.s;
  v.s *= k; v.s = Math.max(1, Math.min(8, v.s));
  v.ox = cx - bx * v.s; v.oy = cy - by * v.s;
  clampView(); drawMap();
}

/* ------------------------------------------------------- points and pins */

const save = () => { try { localStorage.setItem(st.key, JSON.stringify({ points: st.points.map(({ marks, residual, ...p }) => p), pins: st.pins.map((p) => ({ map: pinMap(p), at: p.at, aim: p.aim ?? p.dist ?? null, walked: p.walked ?? p.odo ?? null, fromRef: p.fromRef ?? null, anchorShift: anchorShift(p), anchorJumped: p.anchorJumped ?? null })) })); } catch { /* this phone only */ } };
const load = () => { try { const j = JSON.parse(localStorage.getItem(st.key) || 'null'); if (j) { st.points = (j.points || []).map((p) => ({ ...p, ar: undefined, marks: [] })); st.pins = (j.pins || []).filter((p) => p.map).map((p) => ({ map: p.map, at: p.at, aim: p.aim, walked: p.walked, fromRef: p.fromRef, savedShift: p.anchorShift, anchorJumped: p.anchorJumped })); } } catch { /* fresh */ } };
/** How far a head's anchor has carried it on the map from where it was placed, m (this walk's heads; else as saved). */
function anchorShift(p) {
  if (!(p.ar && p.raw && p.session === st.session)) return p.savedShift ?? null;
  const T = fitFor(p.odo); if (!T) return null;
  const a = apply(T, arLevel(p.ar)), b = apply(T, arLevel(p.raw));
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
const nextName = (kind) => { const pre = kind === 'ref' ? 'R' : kind === 'edge' ? 'E' : 'C'; let k = 1; while (st.points.some((p) => p.name === `${pre}${k}`)) k++; return `${pre}${k}`; };

function refit() {
  st.T = xr ? fitFor(xr.odo) : null;
  st.baseline = baseline(st.points.filter((p) => p.kind === 'ref' && marked(p)).map((p) => ({ map: p.map })));
}

function listPoints() {
  $('#points').innerHTML = st.points.map((p) => `<li><span class="${p.kind === 'edge' ? 'edgec' : p.kind}">${esc(p.name)}</span> ${p.kind === 'ref' ? 'reference' : p.kind === 'edge' ? `edge, ${ft(Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]))} long` : 'check point'}${marked(p) ? ` — marked in AR${p.marks.length > 1 ? ` ${p.marks.length} times` : ''}` : ''}</li>`).join('');
  if (st.pendingEdge) $('#points').innerHTML += '<li class="dim">Tap the other end of the edge.</li>';
  const refs = st.points.filter((p) => p.kind === 'ref').length;
  $('#start').disabled = !st.xr || (refs < 2 && !LID.ready);
  $('#xr-why').textContent = !st.xr ? st.xrWhy || '' : refs < 2 && !LID.ready ? (LID.error ? 'Add at least two references first (the lidar could not be read).' : 'Reading the lidar (or add two references)…') : '';
}

/**
 * The placed heads, each as metres east and north of the middle of the latest walk's heads (no coordinates): the owner
 * placed one head again and again on the second walk, so their spread is how repeatable a placing is.
 */
function headsRelative() {
  const all = st.pins.map((p) => ({ p, m: pinMap(p) })).filter((x) => x.m);
  if (!all.length) return null;
  const latest = Math.max(...all.map((x) => x.p.at || 0));
  const walk = all.filter((x) => (x.p.at || 0) >= latest - 45 * 60 * 1000);
  const c = [walk.reduce((a, x) => a + x.m[0], 0) / walk.length, walk.reduce((a, x) => a + x.m[1], 0) / walk.length];
  const d = walk.map((x) => Math.hypot(x.m[0] - c[0], x.m[1] - c[1]));
  return {
    latestWalk: { n: walk.length, rmsFromMiddleM: +Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length).toFixed(3), farthestM: +Math.max(...d).toFixed(3) },
    each: all.map((x) => ({ when: x.p.at ? new Date(x.p.at).toISOString().slice(11, 19) : null, eM: +(x.m[0] - c[0]).toFixed(2), nM: +(x.m[1] - c[1]).toFixed(2), aimM: x.p.aim != null ? +x.p.aim.toFixed(2) : null, walkedM: x.p.walked != null ? +x.p.walked.toFixed(1) : null, fromRefMarkM: x.p.fromRef != null ? +x.p.fromRef.toFixed(1) : null, anchorShiftM: anchorShift(x.p) != null ? +anchorShift(x.p).toFixed(2) : null, anchorJumpedM: x.p.anchorJumped ?? null })),
  };
}

function results() {
  const refs = st.points.filter((p) => p.kind === 'ref' && marked(p));
  const checks = st.points.filter((p) => p.kind === 'check').map((p) => ({ p, l: checkLanding(p) })).filter((c) => c.l);
  const errs = checks.map((c) => c.l.error).sort((a, b) => a - b);
  const pinsNow = st.pins.filter((p) => pinMap(p)).length;
  const nMarks = refMarks().length;
  const edges = st.points.filter((p) => p.kind === 'edge' && marked(p));
  const rows = [
    ...refs.map((p) => { const lo = leftOut(p); return `<tr><td class="ref">${esc(p.name)}</td><td>reference</td><td>marked ${p.marks.length === 1 ? 'once' : `${p.marks.length} times`}${lo != null ? `; <strong>${ftIn(lo)}</strong> from its place when the others line it up` : ''}</td></tr>`; }),
    ...edges.map((p) => { const off = edgeLanding(p); return `<tr><td class="edgec">${esc(p.name)}</td><td>edge</td><td>marked ${p.marks.length === 1 ? 'once' : `${p.marks.length} times`}${off != null ? `; the latest ${ftIn(off)} from its line` : ''}</td></tr>`; }),
    ...checks.map(({ p, l }) => `<tr><td class="check">${esc(p.name)}</td><td>check point</td><td><strong>${ftIn(l.error)} off</strong> <span class="dim">(${ft(l.walked)} walked from a reference mark; aimed from ${ft(l.dist)})</span></td></tr>`),
  ];
  const x = xr?.stats || st.lastStats;
  $('#results').innerHTML = refs.length || pinsNow ? `<div class="card"><strong>Results</strong>
    <p>${refs.length >= 2 ? `${refs.length} references, ${nMarks} marks, ${ftIn(st.baseline || 0)} apart at the widest. ${(() => { const sc = scaleNow(), pc = (k) => `${(Math.abs(1 - 1 / k) * 100).toFixed(1)}% ${k > 1 ? 'shorter' : 'longer'}`; if (!sc.walk && !sc.earlier) return 'AR\'s scale is not measured yet: mark two references 25 ft or more apart one after the other.'; return `AR measures distances ${pc(sc.k)} than the photo (${sc.walk ? `${sc.walk.n} pair${sc.walk.n === 1 ? '' : 's'} of references marked one after the other this walk: ${pc(sc.walk.k)}` : 'none this walk'}${sc.earlier ? `; ${sc.earlier} earlier walk${sc.earlier === 1 ? '' : 's'}` : ''}); the fit corrects for it.`; })()}${refs.length === 2 ? ' With two references nothing says which one is off; a third does.' : ' The reference that lands farthest from its place is most likely the one placed or aimed wrong (check where it is on the photo); with only three, one bad reference makes the others look off too, so four or more show it plainly.'}` : 'Not lined up yet: mark two references in AR.'}${x ? ` Walked ${ft(x.walked)}; lost its place ${x.losses} time${x.losses === 1 ? '' : 's'}${x.resets ? `; its frame jumped ${x.resets} time${x.resets === 1 ? '' : 's'}` : ''}; ${x.fastTurns} fast turn${x.fastTurns === 1 ? '' : 's'}.` : ''}</p>
    ${checks.length ? `<p><strong>Check points: ${ftIn(errs[errs.length >> 1])} off at the middle, ${ftIn(errs[errs.length - 1])} at the worst</strong> (${checks.length}).</p>` : ''}
    ${rows.length ? `<table>${rows.join('')}</table>` : ''}
    ${(() => { const z = xr ? senseSummary(xr.sense) : st.lastSense; if (!z) return ''; const yes = (v) => (v && v !== 'not given' ? 'yes' : 'no'); return `<p class="dim">This phone's sensors: depth ${yes(z.depth)}, camera picture ${yes(z.camera)}, surfaces ${yes(z.surfacesFound)}; the crosshair on walls ${z.crosshairOn.wall} times${z.groundHeights ? `; the ground's height varied ${ft(z.groundHeights.spanM)} over ${ft(z.groundHeights.overWalkM)} walked` : ''}.</p>`; })()}
    <p>${pinsNow} head${pinsNow === 1 ? '' : 's'} placed (red on the map).</p>
    <div class="tools"><button type="button" id="copy">Copy results</button></div></div>` : '';
  $('#copy')?.addEventListener('click', async () => {
    const out = {
      page: 'water AR test v4', lidar: { read: LID.ready ? { points: LID.ready.points, solidCells: LID.ready.solid, cloud: LID.ready.cloud, shift: LID.ready.shift } : LID.error || null, asks: LID.asks, fixes: LID.fixes.length, last: LID.last, depthPointsKept: xr?.cloud?.size ?? null }, when: new Date().toISOString(), device: navigator.userAgent, sensors: xr ? senseSummary(xr.sense) : st.lastSense || null, stats: x ? { walkedM: +x.walked.toFixed(1), losses: x.losses, resets: x.resets, fastTurns: x.fastTurns } : null,
      scale: { heldPhotoOverAR: +scaleNow().k.toFixed(4), thisWalk: scaleNow().walk ? { k: +scaleNow().walk.k.toFixed(4), pairs: scaleNow().walk.n } : null, earlierWalks: learnedScales() },
      edges: edges.map((p) => ({ name: p.name, lengthM: +Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]).toFixed(1), marks: p.marks.length, latestOffM: edgeLanding(p) != null ? +edgeLanding(p).toFixed(3) : null })),
      references: refs.map((p) => ({ name: p.name, leftOutM: leftOut(p) != null ? +leftOut(p).toFixed(3) : null, marks: p.marks.map((m) => ({ walkedM: +m.odo.toFixed(1), aimM: +m.dist.toFixed(2), anchorMovedM: m.anchorMoved != null ? +m.anchorMoved.toFixed(3) : null, anchorJumpedM: m.anchorJumped ?? null })) })),
      checks: checks.map(({ p, l }) => ({ name: p.name, errorM: +l.error.toFixed(3), fromRefMarkM: +l.walked.toFixed(1), aimM: +l.dist.toFixed(2) })),
      headsPlaced: pinsNow, heads: headsRelative(), events: st.events.slice(-60),
    };
    try { await navigator.clipboard.writeText(JSON.stringify(out, null, 1)); $('#copy').textContent = 'Copied'; } catch { $('#copy').textContent = 'Could not copy'; }
  });
}

/* ------------------------------------------- tapping, dragging, zooming */

function canvasXY(ev) {
  const cv = $('#map'), r = cv.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * cv.width, ((ev.clientY - r.top) / r.height) * cv.height];
}
const toBase = ([x, y]) => [(x - st.view.ox) / st.view.s, (y - st.view.oy) / st.view.s];
function wireMap() {
  const cv = $('#map'), ptrs = new Map();
  let drag = null, downAt = null, pan = null, pinch = null, moved = false;
  const hitR = () => Math.max(14, cv.width / 50) / st.view.s; // in photo px
  // what a press lands on: a point, or one end of an edge
  const hitAt = (b) => {
    const near = (m) => { const [x, y] = toPx(m); return Math.hypot(x - b[0], y - b[1]) < hitR() * 1.4; };
    for (const p of st.points) {
      if (p.kind === 'edge') { if (near(p.a)) return { p, end: 'a' }; if (near(p.b)) return { p, end: 'b' }; } else if (near(p.map)) return { p };
    }
    return null;
  };
  cv.addEventListener('pointerdown', (ev) => {
    cv.setPointerCapture(ev.pointerId);
    ptrs.set(ev.pointerId, canvasXY(ev));
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s0: st.view.s, base: toBase([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) };
      if (drag) { drag = null; save(); listPoints(); }
      pan = null; downAt = null; return;
    }
    if (ptrs.size > 2) return;
    const xy = canvasXY(ev), b = toBase(xy);
    const hit = hitAt(b);
    downAt = xy; moved = false;
    if (hit) drag = hit; else pan = { x: xy[0], y: xy[1], ox: st.view.ox, oy: st.view.oy };
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!ptrs.has(ev.pointerId)) return;
    ptrs.set(ev.pointerId, canvasXY(ev));
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      st.view.s = Math.max(1, Math.min(8, pinch.s0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d0));
      st.view.ox = mid[0] - pinch.base[0] * st.view.s; st.view.oy = mid[1] - pinch.base[1] * st.view.s;
      clampView(); drawMap(); return;
    }
    const xy = canvasXY(ev);
    if (downAt && Math.hypot(xy[0] - downAt[0], xy[1] - downAt[1]) > 12) moved = true;
    if (drag && moved) {
      const at = fromPx(toBase(xy)), p = drag.p;
      if (drag.end) { p[drag.end] = at; p.map = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2]; } else p.map = at;
      p.marks = []; drawMap();
    }
    else if (pan && moved) { st.view.ox = pan.ox + xy[0] - pan.x; st.view.oy = pan.oy + xy[1] - pan.y; clampView(); drawMap(); }
  });
  const up = (ev, cancelled) => {
    ptrs.delete(ev.pointerId);
    if (pinch) { if (ptrs.size < 2) pinch = null; downAt = null; drag = null; pan = null; return; }
    const xy = canvasXY(ev);
    if (drag && moved) { drag = null; save(); listPoints(); drawMap(); return; }
    const tap = !cancelled && downAt && !moved;
    drag = null; pan = null; downAt = null;
    if (!tap) return;
    // a tap: a point where it fell (the mapped heads are not snapped to: they can be off -- owner, 2026-10-31)
    const b = toBase(xy), map = fromPx(b);
    if (hitAt(b)) return; // a press on an existing point or edge end was to drag it
    if (st.adding === 'edge') {
      // an edge: two taps along a straight edge on the ground (a driveway's, a sidewalk's, a patio's)
      if (!st.pendingEdge) { st.pendingEdge = map; drawMap(); listPoints(); return; }
      const a = st.pendingEdge; st.pendingEdge = null;
      if (Math.hypot(map[0] - a[0], map[1] - a[1]) < 1) { drawMap(); listPoints(); return; }
      st.points.push({ id: `${Date.now()}`, kind: 'edge', name: nextName('edge'), a, b: map, map: [(a[0] + map[0]) / 2, (a[1] + map[1]) / 2], marks: [] });
    } else st.points.push({ id: `${Date.now()}`, kind: st.adding, name: nextName(st.adding), map, marks: [] });
    save(); listPoints(); drawMap();
  };
  cv.addEventListener('pointerup', (ev) => up(ev, false));
  cv.addEventListener('pointercancel', (ev) => up(ev, true));
  cv.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomAt(ev.deltaY < 0 ? 1.25 : 0.8, canvasXY(ev)); }, { passive: false });
  const mid = () => [cv.width / 2, cv.height / 2];
  $('#zin').addEventListener('click', () => zoomAt(1.6, mid()));
  $('#zout').addEventListener('click', () => zoomAt(1 / 1.6, mid()));
  $('#zfit').addEventListener('click', () => { st.view = { s: 1, ox: 0, oy: 0 }; drawMap(); });
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    st.adding = b.dataset.add; st.pendingEdge = null; drawMap();
    document.querySelectorAll('[data-add]').forEach((x) => { x.classList.toggle('on', x === b); x.classList.toggle('plain', x !== b); });
  }));
  $('#undo-point').addEventListener('click', () => { if (st.pendingEdge) st.pendingEdge = null; else st.points.pop(); save(); listPoints(); drawMap(); });
  $('#clear-pins').addEventListener('click', () => { st.pins = []; save(); drawMap(); results(); });
}

/* -------------------------------------------------------------- the AR */

const log = (what) => { st.events.push({ t: Math.round(performance.now()), walkedM: xr ? +xr.odo.toFixed(1) : null, what }); };

async function checkXR() {
  st.xr = false;
  if (!window.isSecureContext) { st.xrWhy = 'AR needs the secure (https) page.'; return; }
  if (!navigator.xr) { st.xrWhy = "This browser has no AR (WebXR). Open this page in Chrome on Android, on a phone that has Google Play Services for AR."; return; }
  try { st.xr = await navigator.xr.isSessionSupported('immersive-ar'); } catch { st.xr = false; }
  if (!st.xr) st.xrWhy = "This phone's browser says it cannot run AR. In Chrome on Android, install or update Google Play Services for AR.";
}

let xr = null;
/** What to mark next: an unmarked reference, then an unmarked check point or edge, then the reference or edge nearest the phone. */
function nextTarget() {
  const want = st.points.filter((p) => !marked(p));
  const first = want.find((p) => p.kind === 'ref') || want[0];
  if (first) return first;
  const me = myMap();
  const refs = st.points.filter((p) => p.kind === 'ref' || p.kind === 'edge');
  const away = (p) => (p.kind === 'edge' ? segDist(p, me) : Math.hypot(p.map[0] - me[0], p.map[1] - me[1]));
  return me ? refs.sort((a, b) => away(a) - away(b))[0] : refs[0] || null;
}
const segDist = (e, q) => { const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], t = Math.max(0, Math.min(1, ((q[0] - e.a[0]) * dx + (q[1] - e.a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(e.a[0] + dx * t - q[0], e.a[1] + dy * t - q[1]); };
const myMap = () => (st.T && xr?.pose ? apply(st.T, arLevel(xr.pose.transform.position)) : null);
function flash(text) { const f = $('#flash'); f.textContent = text; f.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => f.classList.remove('show'), 1800); }

/** After a walk, keep its scale for this phone (the last six walks), when references were marked one after the other. */
function learnScale() {
  const sc = sessionScale();
  if (!sc || sc.k < SCALE_OK[0] || sc.k > SCALE_OK[1]) return;
  try { const v = learnedScales(); v.push(+sc.k.toFixed(4)); localStorage.setItem('ar-scales', JSON.stringify(v.slice(-6))); log(`kept this phone's scale ${sc.k.toFixed(4)}`); } catch { /* not kept */ }
}

async function startAR() {
  const overlay = $('#overlay');
  overlay.hidden = false; document.body.classList.add('in-ar');
  let session;
  try {
    // THE SENSOR CHECK (owner, 2026-10-31: "compare the visual results of the lidar with the camera input to provide an
    // accurate 'you are here'"): ask for the phone's depth, its camera picture and the surfaces it finds, as well, to
    // learn which of them Chrome gives this phone. Refused, the session starts as before.
    try {
      session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'anchors', 'depth-sensing', 'camera-access', 'plane-detection'], domOverlay: { root: overlay },
        depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] } });
    } catch (e) {
      log(`the extra sensors were refused: ${e.message}`);
      session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'anchors'], domOverlay: { root: overlay } });
    }
  } catch (e) {
    overlay.hidden = true; document.body.classList.remove('in-ar'); $('#xr-why').textContent = `AR would not start: ${e.message}`; log(`start failed: ${e.message}`); return;
  }
  try {
    await setUp(session, overlay);
  } catch (e) {
    log(`setup failed: ${e.message}`);
    xr = null; overlay.hidden = true; document.body.classList.remove('in-ar');
    try { await session.end(); } catch { /* already ended */ }
    $('#xr-why').textContent = `AR started but could not set up: ${e.message}`;
  }
}

async function setUp(session, overlay) {
  st.session = Date.now();
  // a new session has a new frame of its own: marks from an earlier one no longer line up
  for (const p of st.points) p.marks = [];
  st.T = null;
  const cv = document.createElement('canvas');
  const gl = cv.getContext('webgl', { xrCompatible: true, alpha: true });
  await gl.makeXRCompatible?.();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  const ref = await session.requestReferenceSpace('local');
  const viewer = await session.requestReferenceSpace('viewer');
  let hits;
  try { hits = await session.requestHitTestSource({ space: viewer, entityTypes: ['plane', 'point'] }); } catch { hits = await session.requestHitTestSource({ space: viewer }); }
  xr = { session, gl, ref, viewer, hits, cur: null, hit: null, pose: null, lastHud: 0, stack: [], odo: 0, lastPos: null, tracking: true, yaw: null, yawT: 0, turn: 0, fast: false,
    anchors: typeof XRHitTestResult !== 'undefined' && 'createAnchor' in XRHitTestResult.prototype && (!session.enabledFeatures || session.enabledFeatures.includes('anchors')),
    stats: { walked: 0, losses: 0, resets: 0, fastTurns: 0 } };
  xr.target = nextTarget();
  xr.sense = senseStart(session, gl);
  xr.cloud = new Map(); xr.groundY = null;
  LID.fixes = []; LID.last = null; LID.why = null; LID.pending = false; LID.gps = null;
  // GPS only to start the search from (metres off is fine); kept in memory, never copied
  try { LID.watch = navigator.geolocation?.watchPosition((pos) => { if (!xr?.pose) return; const p = xr.pose.transform.position; LID.gps = { at: toLocal(st.origin, [pos.coords.longitude, pos.coords.latitude]), acc: pos.coords.accuracy, phone: [p.x, -p.z], t: Date.now() }; }, () => {}, { enableHighAccuracy: true, maximumAge: 2000 }); } catch { /* no GPS */ }
  log(`AR started; dom overlay ${session.domOverlayState?.type || 'none'}; anchors ${xr.anchors ? 'yes' : 'no'}`);
  // ARCore's frame jumped (it relocalised): marks before the jump no longer line up with anything after it
  ref.addEventListener?.('reset', () => { if (!xr) return; xr.odo += RESET_WALK; xr.stats.resets++; xr.lastPos = null; log('frame reset'); flash('The AR jumped: mark a reference again'); refit(); });
  session.addEventListener('end', () => { try { if (LID.watch != null) navigator.geolocation.clearWatch(LID.watch); } catch { /* none */ } log('AR ended'); st.lastStats = xr?.stats; st.lastSense = senseSummary(xr?.sense); learnScale(); xr = null; overlay.hidden = true; document.body.classList.remove('in-ar'); save(); listPoints(); drawMap(); results(); });
  // taps on the overlay's buttons are not AR "select"s
  overlay.addEventListener('beforexrselect', (ev) => ev.preventDefault());
  session.requestAnimationFrame(onFrame);
  updateBar();
}

function onFrame(t, frame) {
  if (!xr) return;
  xr.session.requestAnimationFrame(onFrame);
  const layer = xr.session.renderState.baseLayer;
  xr.gl.bindFramebuffer(xr.gl.FRAMEBUFFER, layer.framebuffer);
  xr.gl.clearColor(0, 0, 0, 0); xr.gl.clear(xr.gl.COLOR_BUFFER_BIT | xr.gl.DEPTH_BUFFER_BIT);
  const pose = frame.getViewerPose(xr.ref);
  xr.pose = pose || null;
  if (pose && t - (xr.sense.last || 0) > 500) { xr.sense.last = t; try { senseFrame(frame, pose); } catch (e) { xr.sense.err = e.message; } }
  if (pose && !pose.emulatedPosition && t - (xr.cloudT || 0) > 250) { xr.cloudT = t; try { collectDepth(frame, pose); } catch (e) { xr.cloudErr = e.message; } }
  xr.gl.bindFramebuffer(xr.gl.FRAMEBUFFER, layer.framebuffer);
  const tracking = !!pose && !pose.emulatedPosition;
  if (xr.tracking && !tracking && pose) { xr.stats.losses++; xr.odo += LOSS_WALK; log('lost its place'); }
  if (!xr.tracking && tracking) { xr.lastPos = null; log('found its place'); }
  xr.tracking = tracking;
  if (tracking) {
    // the walk: the phone's movement on the level, in steps of half a metre or more (the hand's sway is not walking)
    const p = pose.transform.position;
    if (!xr.lastPos) xr.lastPos = { x: p.x, z: p.z };
    const d = Math.hypot(p.x - xr.lastPos.x, p.z - xr.lastPos.z);
    if (d > STEP) { xr.odo += d; xr.stats.walked += d; xr.lastPos = { x: p.x, z: p.z }; }
    // how fast it is turning, smoothed
    const yaw = yawOf(pose.transform.orientation);
    if (xr.yaw != null && t > xr.yawT) {
      let dy = Math.abs(yaw - xr.yaw); if (dy > 180) dy = 360 - dy;
      xr.turn = 0.8 * xr.turn + 0.2 * (dy / ((t - xr.yawT) / 1000));
      const fast = xr.turn > FAST_TURN;
      if (fast && !xr.fast) { xr.stats.fastTurns++; log('fast turn'); }
      xr.fast = fast;
    }
    xr.yaw = yaw; xr.yawT = t;
  }
  const res = tracking ? frame.getHitTestResults(xr.hits) : [];
  xr.hit = res[0] || null;
  const hp = xr.hit ? xr.hit.getPose(xr.ref) : null;
  xr.cur = hp ? { x: hp.transform.position.x, y: hp.transform.position.y, z: hp.transform.position.z } : null;
  $('#cross').classList.toggle('hit', !!xr.cur);
  if (t - xr.lastHud > 150) {
    xr.lastHud = t;
    followAnchors(frame);
    refit();
    maybeRegister();
    hud(tracking);
  }
}

/* ------------------------------------------------- what the phone can sense */

/** Which sensors Chrome granted, and counters for what each gives (the copy's "sensors"). */
function senseStart(session, gl) {
  const granted = session.enabledFeatures ? [...session.enabledFeatures] : null;
  const has = (f) => (granted ? granted.includes(f) : false);
  let binding = null, fb = null;
  if (has('camera-access') && typeof XRWebGLBinding !== 'undefined') { try { binding = new XRWebGLBinding(session, gl); fb = gl.createFramebuffer(); } catch { /* no picture */ } }
  return { granted, binding, fb, depth: { tries: 0, got: 0, centre: [], far: 0, near: Infinity }, camera: { tries: 0, got: 0, size: null, colours: [] },
    planes: { horizontal: 0, vertical: 0, most: 0 }, hits: { ground: 0, wall: 0, other: 0 }, ground: [], err: null, last: 0 };
}

/** Twice a second: the depth at the middle of the picture, the picture's colour there, the surfaces found, what the
 * crosshair is on (ground or wall, from the hit's surface direction), and the ground's height every metre walked. */
function senseFrame(frame, pose) {
  const S = xr.sense, view = pose.views?.[0];
  if (view && typeof frame.getDepthInformation === 'function' && S.granted?.includes('depth-sensing')) {
    S.depth.tries++;
    let d = null; try { d = frame.getDepthInformation(view); } catch { d = null; }
    if (d) {
      S.depth.got++;
      const c = d.getDepthInMeters(0.5, 0.5); if (c > 0) S.depth.centre.push(+c.toFixed(2));
      for (let i = 1; i < 6; i++) for (let j = 1; j < 6; j++) { const z = d.getDepthInMeters(i / 6, j / 6); if (z > 0) { S.depth.far = Math.max(S.depth.far, z); S.depth.near = Math.min(S.depth.near, z); } }
      if (S.depth.centre.length > 40) S.depth.centre.shift();
    }
  }
  if (view?.camera && S.binding) {
    S.camera.tries++;
    const gl = xr.gl, tex = S.binding.getCameraImage(view.camera);
    if (tex) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        const w = view.camera.width, h = view.camera.height, px = new Uint8Array(16 * 16 * 4);
        gl.readPixels((w >> 1) - 8, (h >> 1) - 8, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let r = 0, g = 0, b = 0; for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
        S.camera.got++; S.camera.size = [w, h];
        S.camera.colours.push([Math.round(r / 256), Math.round(g / 256), Math.round(b / 256)]);
        if (S.camera.colours.length > 20) S.camera.colours.shift();
      }
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    }
  }
  if (frame.detectedPlanes) {
    let hz = 0, vt = 0; frame.detectedPlanes.forEach((p) => { if (p.orientation === 'vertical') vt++; else hz++; });
    S.planes.horizontal = Math.max(S.planes.horizontal, hz); S.planes.vertical = Math.max(S.planes.vertical, vt); S.planes.most = Math.max(S.planes.most, hz + vt);
  }
  if (xr.hit) {
    const q = xr.hit.getPose(xr.ref)?.transform.orientation;
    if (q) {
      const ny = 1 - 2 * (q.x * q.x + q.z * q.z); // the surface's normal (the hit's y axis), its upward part
      if (ny > 0.8) { S.hits.ground++; if (xr.cur) xr.groundY = xr.groundY == null ? xr.cur.y : 0.8 * xr.groundY + 0.2 * xr.cur.y; } else if (ny < 0.35) S.hits.wall++; else S.hits.other++;
      // the ground's height every metre walked, in AR's own level frame (no place on Earth): does AR see the slope?
      if (ny > 0.8 && xr.cur && (!S.ground.length || xr.odo - S.ground[S.ground.length - 1].odo >= 1)) S.ground.push({ odo: xr.odo, y: xr.cur.y });
    }
  }
}

function senseSummary(S) {
  if (!S) return null;
  const med = (v) => (v.length ? [...v].sort((a, b) => a - b)[v.length >> 1] : null);
  const ys = S.ground.map((g) => g.y);
  return {
    granted: S.granted,
    depth: S.depth.tries ? { framesWithDepth: `${S.depth.got}/${S.depth.tries}`, middleM: med(S.depth.centre), nearestM: Number.isFinite(S.depth.near) ? +S.depth.near.toFixed(2) : null, farthestM: +S.depth.far.toFixed(2) } : 'not given',
    camera: S.camera.tries ? { framesRead: `${S.camera.got}/${S.camera.tries}`, size: S.camera.size, recentMiddleColours: S.camera.colours.slice(-8) } : 'not given',
    surfacesFound: S.planes.most ? S.planes : 'not given',
    crosshairOn: S.hits,
    groundHeights: ys.length > 1 ? { samples: ys.length, spanM: +(Math.max(...ys) - Math.min(...ys)).toFixed(2), overWalkM: +(S.ground[S.ground.length - 1].odo - S.ground[0].odo).toFixed(1) } : null,
    error: S.err,
  };
}

/** The phone's turn on the level, degrees, from where the camera looks plus where the phone's top edge points: aimed
 * straight down, the camera's own heading is noise, but the top edge then points the way the phone faces. */
function yawOf(q) {
  const rot = ([vx, vy, vz]) => { // v + 2w(q x v) + 2 q x (q x v)
    const cx = q.y * vz - q.z * vy, cy = q.z * vx - q.x * vz, cz = q.x * vy - q.y * vx;
    return [vx + 2 * (q.w * cx + q.y * cz - q.z * cy), vy + 2 * (q.w * cy + q.z * cx - q.x * cz), vz + 2 * (q.w * cz + q.x * cy - q.y * cx)];
  };
  const f = rot([0, 0, -1]), u = rot([0, 1, 0]);
  return (Math.atan2(f[0] + u[0], -(f[2] + u[2])) * 180) / Math.PI;
}

/** ARCore moves an anchor as it corrects its map: the mark moves with it. */
function followAnchors(frame) {
  if (!xr.anchors || !frame.trackedAnchors) return;
  const all = [...st.points.flatMap((p) => p.marks || []), ...st.pins.filter((p) => p.session === st.session)];
  for (const m of all) {
    if (!m.anchor || !frame.trackedAnchors.has(m.anchor)) continue;
    const ap = frame.getPose(m.anchor.anchorSpace, xr.ref);
    if (!ap) continue;
    const q = ap.transform.position, moved = Math.hypot(q.x - m.raw.x, q.z - m.raw.z);
    if (moved > ANCHOR_MAX) {
      // ARCore's corrections are tenths of a metre (H66); metres is an anchor carried off (a plane merged or
      // re-found elsewhere): keep the reading as it was made
      if (!m.anchorJumped) { m.anchorJumped = +moved.toFixed(1); log(`an anchor jumped ${moved.toFixed(1)} m: ignored`); }
      m.ar = { ...m.raw };
      continue;
    }
    m.ar = { x: q.x, y: q.y, z: q.z };
    m.anchorMoved = moved;
  }
}
async function anchorFor(m) {
  if (!xr?.anchors || !xr.hit) return;
  try { m.anchor = await xr.hit.createAnchor(); } catch { /* the mark keeps its first reading */ }
}

function hud(tracking) {
  const p = xr.pose?.transform.position;
  const dist = xr.cur && p ? Math.hypot(xr.cur.x - p.x, xr.cur.z - p.z) : null;
  const nRefs = st.points.filter((q) => q.kind === 'ref' && marked(q)).length;
  const lines = [];
  if (!xr.pose) lines.push('Starting the camera…');
  else if (!tracking) lines.push('<strong class="warn">Lost its place</strong>: hold still, aim at the ground nearby');
  else if (!xr.cur) lines.push('Looking for the ground: sweep the phone slowly over it');
  else lines.push(dist > AIM_FAR ? `<span class="warn">Ground ${ft(dist)} ahead: come within 10 ft</span>` : `Ground ${ft(dist)} ahead`);
  if (xr.fast) lines.push('<strong class="warn">Turning fast: slow down</strong>');
  if (LID.ready) {
    const f = xr ? nearestFix(xr.odo) : null, on = f && Math.abs(f.odo - xr.odo) <= FIX_REACH;
    lines.push(on ? `<strong>You are here</strong> (lidar: ${Math.round(f.hits * 100)}% of what the camera sees lines up${LID.why ? '; holding the last fix' : ''})` : `<span class="warn">Finding where you are</span>: ${esc(LID.why || 'looking…')}`);
  }
  if (LID.ready && !nRefs) { /* references optional */ } else if (nRefs >= 2 && st.T) {
    const w = walkedSinceRef();
    lines.push(w > WALK_REMARK ? `<strong class="warn">Mark a reference or edge</strong> (${ft(w)} walked since the last mark; two one after the other, or an edge twice a few steps apart, also set the turn)` : `Lined up (${cons().length} marks; ${ft(w || 0)} since the last)${st.baseline < 5 ? ' — <strong class="warn">references too close together</strong>' : ''}`);
  } else lines.push(`Mark ${2 - nRefs} more reference${2 - nRefs === 1 ? '' : 's'} to line up`);
  const tg = xr.target;
  if (tg) lines.push(`Next: <strong>${esc(tg.name)}</strong> (${tg.kind === 'ref' ? 'reference' : tg.kind === 'edge' ? 'edge: aim at any spot along it' : 'check point'}${marked(tg) ? ', again' : ''}) — tap another on the small map`);
  $('#hud').innerHTML = lines.join('<br>');
  updateBar();
  drawMini();
}

function drawMini() {
  const cv = $('#mini'), ctx = cv.getContext('2d'), W = cv.width;
  ctx.clearRect(0, 0, W, W);
  let c = st.points.length ? [st.points.reduce((a, p) => a + p.map[0], 0) / st.points.length, st.points.reduce((a, p) => a + p.map[1], 0) / st.points.length] : [0, 0];
  const me = myMap();
  if (me) c = me;
  const span = 30, k = W / span;
  const P = ([e, n]) => [W / 2 + (e - c[0]) * k, W / 2 - (n - c[1]) * k];
  st.miniP = P;
  drawMarks(ctx, P, 9);
  if (xr?.target) { const [x, y] = P(xr.target.map); ctx.strokeStyle = '#4cff9a'; ctx.lineWidth = 3; ctx.strokeRect(x - 15, y - 15, 30, 30); }
  if (me) {
    const h = (headingOf(st.T, xr.pose.transform.orientation) * Math.PI) / 180;
    const [x, y] = P(me);
    ctx.fillStyle = '#4cff9a'; ctx.beginPath(); ctx.moveTo(x + 16 * Math.sin(h), y - 16 * Math.cos(h)); ctx.lineTo(x + 8 * Math.sin(h + 2.4), y - 8 * Math.cos(h + 2.4)); ctx.lineTo(x + 8 * Math.sin(h - 2.4), y - 8 * Math.cos(h - 2.4)); ctx.closePath(); ctx.fill();
    if (xr.cur) { const [ax, ay] = P(apply(st.T, arLevel(xr.cur))); ctx.strokeStyle = '#4cff9a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ax, ay, 7, 0, 2 * Math.PI); ctx.stroke(); }
  }
}

function updateBar() {
  const t = xr?.target;
  $('#mark').textContent = t ? `Mark ${t.name}${marked(t) ? ' again' : ''}` : 'Mark';
  $('#mark').disabled = !t;
  $('#place').disabled = !st.T;
}

function wireAR() {
  $('#start').addEventListener('click', startAR);
  $('#exit').addEventListener('click', () => xr?.session.end());
  const low = () => { try { return localStorage.getItem('ar-bar') === 'low'; } catch { return false; } };
  $('#overlay').classList.toggle('bar-low', low());
  $('#move').addEventListener('click', () => { const o = $('#overlay'); o.classList.toggle('bar-low'); try { localStorage.setItem('ar-bar', o.classList.contains('bar-low') ? 'low' : 'high'); } catch { /* this time only */ } });
  $('#mark').addEventListener('click', () => {
    if (!xr?.target) return;
    if (!xr.cur) { flash('No ground under the crosshair'); return; }
    const t = xr.target, p = xr.pose.transform.position;
    const m = { ar: { ...xr.cur }, raw: { ...xr.cur }, odo: xr.odo, dist: Math.hypot(xr.cur.x - p.x, xr.cur.z - p.z), at: Date.now() };
    if (t.kind === 'check') t.marks = [m]; else t.marks.push(m);
    anchorFor(m);
    xr.stack.push({ type: 'mark', p: t, m });
    log(`marked ${t.name} from ${m.dist.toFixed(1)} m`);
    refit();
    navigator.vibrate?.(30);
    const far = m.dist > AIM_FAR ? ` (from ${ft(m.dist)}: closer is better)` : '';
    if (t.kind === 'check') { const l = checkLanding(t); flash(l ? `${t.name}: ${ftIn(l.error)} off${far}` : `${t.name} marked${far}`); } else if (t.kind === 'edge') { const off = edgeLanding(t); flash(`${t.name} marked${off != null ? `, ${ftIn(off)} from its line` : ''}${far}`); } else flash(`${t.name} marked${far}`);
    xr.target = nextTarget();
    updateBar(); results(); listPoints();
  });
  let farAt = 0;
  $('#place').addEventListener('click', () => {
    if (!st.T) return;
    if (!xr.cur) { flash('No ground under the crosshair'); return; }
    const p = xr.pose.transform.position;
    // from far off a head lands feet away (H67: 7 ft from 14 ft away): ask once more
    const far = Math.hypot(xr.cur.x - p.x, xr.cur.z - p.z);
    if (far > AIM_FAR && Date.now() - farAt > FAR_AGAIN) { farAt = Date.now(); flash(`${ft(far)} away: come closer, or tap again to place it anyway`); return; }
    farAt = 0;
    const pin = { ar: { ...xr.cur }, raw: { ...xr.cur }, odo: xr.odo, dist: Math.hypot(xr.cur.x - p.x, xr.cur.z - p.z), session: st.session, at: Date.now() };
    pin.aim = pin.dist; pin.walked = pin.odo; pin.fromRef = walkedSinceRef();
    pin.map = apply(st.T, arLevel(pin.ar));
    anchorFor(pin);
    st.pins.push(pin);
    xr.stack.push({ type: 'pin', pin });
    log(`placed a head from ${pin.dist.toFixed(1)} m`);
    navigator.vibrate?.(30);
    flash(`Head ${st.pins.length} placed${pin.dist > AIM_FAR ? ` (from ${ft(pin.dist)}: closer is better)` : ''}`);
    save(); results();
  });
  $('#undo').addEventListener('click', () => {
    const a = xr?.stack.pop();
    if (!a) return;
    if (a.type === 'mark') { a.p.marks = a.p.marks.filter((m) => m !== a.m); a.m.anchor?.delete?.(); xr.target = a.p; } else { st.pins = st.pins.filter((p) => p !== a.pin); a.pin.anchor?.delete?.(); }
    refit();
    log('undo');
    updateBar(); save(); results(); listPoints();
  });
  // choose what to mark next (or mark again) by tapping it on the small map
  $('#mini').addEventListener('click', (ev) => {
    if (!xr || !st.miniP) return;
    const cv = $('#mini'), r = cv.getBoundingClientRect();
    const xy = [((ev.clientX - r.left) / r.width) * cv.width, ((ev.clientY - r.top) / r.height) * cv.height];
    const near = st.points.map((p) => ({ p, d: Math.hypot(st.miniP(p.map)[0] - xy[0], st.miniP(p.map)[1] - xy[1]) })).sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 60) { xr.target = near.p; updateBar(); hud(xr.tracking); }
  });
}

/* ------------------------------------------------------------ opening */

async function open() {
  const id = new URLSearchParams(location.search).get('map');
  if (!id) {
    const res = await fetch('/api/maps', { credentials: 'same-origin' });
    const j = await res.json().catch(() => null);
    const maps = res.ok && j?.maps ? openable(j.maps) : [];
    $('#status').textContent = maps.length ? 'Choose a map:' : 'No saved maps with a traced lawn and shade map here. Sign in, or open a map from your dashboard first.';
    $('#maps').innerHTML = maps.map((m) => `<p><a href="?map=${encodeURIComponent(m.id)}">${esc(m.address || 'a map')}</a></p>`).join('');
    return;
  }
  const res = await fetch(`/api/maps/one?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.map) { $('#status').textContent = j?.error || `The map would not open (${res.status}).`; return; }
  const m = j.map;
  st.site = m; st.origin = [m.lng, m.lat]; st.key = `ar-test:${id}`;
  const asPoly = (s) => { const g = s?.geometry || s; return g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : []; };
  st.lawn = (m.shapes || []).flatMap(asPoly).map((poly) => poly[0].map((p) => toLocal(st.origin, p)));
  const irr = m.tools?.water?.data?.irrigation;
  st.heads = (irr?.heads || []).filter((h) => Array.isArray(h.at)).map((h, k) => ({ map: toLocal(st.origin, h.at), label: String(k + 1) }));
  // the photo: the lawn and its mapped heads, 15 m round
  const pts = [...st.lawn.flat(), ...st.heads.map((h) => h.map)];
  const ll = (pts.length ? pts : [[0, 0]]).map((p) => toMerc(fromLocal(st.origin, p)));
  const pad = 15 / Math.cos((m.lat * Math.PI) / 180);
  const bbox = [Math.min(...ll.map((p) => p[0])) - pad, Math.min(...ll.map((p) => p[1])) - pad, Math.max(...ll.map((p) => p[0])) + pad, Math.max(...ll.map((p) => p[1])) + pad];
  st.frame = frameFor(bbox, m.lat);
  $('#status').textContent = 'Fetching the photo…';
  const ph = await savedPhoto(st.frame, tracedOn(m));
  st.photo = ph.photo; st.shift = ph.shift;
  $('#status').textContent = `${m.address || 'Your map'}: ${st.heads.length} mapped head${st.heads.length === 1 ? '' : 's'}${st.photo ? '' : ' (the photo would not load: the lawn outline only)'}.`;
  load();
  $('#setup').hidden = false;
  startLidar(m);
  await checkXR();
  wireMap(); wireAR(); listPoints(); drawMap(); results();
}

open().catch((e) => { $('#status').textContent = `Something went wrong: ${e.message}`; });
