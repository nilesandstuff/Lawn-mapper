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
 * (fitAt). Each mark is also an ARCore anchor where the phone supports them, so ARCore's own corrections move it.
 *
 * Nothing here writes to the map: the points and pins are kept on this phone (per map) and the results copied by hand.
 */
import { toLocal, fromLocal, arLevel, fitAt, apply, headingOf, baseline } from '/lib/ar-align.js';
import { tracedOn, lineUpAt } from '/lib/shade/traced.js';
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
/** Every reference mark this session, as fitAt wants them. */
const refMarks = () => st.points.filter((p) => p.kind === 'ref').flatMap((p) => (p.marks || []).map((m) => ({ ar: arLevel(m.ar), map: p.map, odo: m.odo, p, m })));
const fitFor = (odo) => fitAt(refMarks(), odo);
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
  const nearest = Math.min(...refMarks().map((r) => Math.abs(r.odo - m.odo)));
  return { at, error: Math.hypot(at[0] - p.map[0], at[1] - p.map[1]), walked: nearest, dist: m.dist };
}
const walkedSinceRef = () => { const r = refMarks(); return r.length && xr ? Math.min(...r.map((q) => xr.odo - q.odo)) : null; };

/* ---------------------------------------------------------------- drawing */

function drawMarks(ctx, P, r) {
  ctx.lineWidth = Math.max(1.5, r / 3); ctx.strokeStyle = 'rgba(255,255,255,.85)';
  for (const ring of st.lawn) { ctx.beginPath(); ring.forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke(); }
  for (const h of st.heads) { const [x, y] = P(h.map); ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill(); ctx.strokeStyle = '#333'; ctx.lineWidth = r / 8; ctx.stroke(); }
  st.points.forEach((pt) => {
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

const save = () => { try { localStorage.setItem(st.key, JSON.stringify({ points: st.points.map(({ marks, residual, ...p }) => p), pins: st.pins.map((p) => ({ map: pinMap(p), at: p.at })) })); } catch { /* this phone only */ } };
const load = () => { try { const j = JSON.parse(localStorage.getItem(st.key) || 'null'); if (j) { st.points = (j.points || []).map((p) => ({ ...p, ar: undefined, marks: [] })); st.pins = (j.pins || []).filter((p) => p.map).map((p) => ({ map: p.map, at: p.at })); } } catch { /* fresh */ } };
const nextName = (kind) => { const pre = kind === 'ref' ? 'R' : 'C'; let k = 1; while (st.points.some((p) => p.name === `${pre}${k}`)) k++; return `${pre}${k}`; };

function refit() {
  st.T = xr ? fitFor(xr.odo) : null;
  st.baseline = baseline(st.points.filter((p) => p.kind === 'ref' && marked(p)).map((p) => ({ map: p.map })));
}

function listPoints() {
  $('#points').innerHTML = st.points.map((p) => `<li><span class="${p.kind}">${esc(p.name)}</span> ${p.kind === 'ref' ? 'reference' : 'check point'}${p.head ? ` (mapped head ${esc(p.head)})` : ''}${marked(p) ? ` — marked in AR${p.marks.length > 1 ? ` ${p.marks.length} times` : ''}` : ''}</li>`).join('');
  const refs = st.points.filter((p) => p.kind === 'ref').length;
  $('#start').disabled = !st.xr || refs < 2;
  $('#xr-why').textContent = !st.xr ? st.xrWhy || '' : refs < 2 ? 'Add at least two references first.' : '';
}

function results() {
  const refs = st.points.filter((p) => p.kind === 'ref' && marked(p));
  const checks = st.points.filter((p) => p.kind === 'check').map((p) => ({ p, l: checkLanding(p) })).filter((c) => c.l);
  const errs = checks.map((c) => c.l.error).sort((a, b) => a - b);
  const pinsNow = st.pins.filter((p) => pinMap(p)).length;
  const nMarks = refMarks().length;
  const rows = [
    ...refs.map((p) => `<tr><td class="ref">${esc(p.name)}</td><td>reference</td><td>marked ${p.marks.length === 1 ? 'once' : `${p.marks.length} times`}</td></tr>`),
    ...checks.map(({ p, l }) => `<tr><td class="check">${esc(p.name)}</td><td>check point</td><td><strong>${ftIn(l.error)} off</strong> <span class="dim">(${ft(l.walked)} walked from a reference mark; aimed from ${ft(l.dist)})</span></td></tr>`),
  ];
  const x = xr?.stats || st.lastStats;
  $('#results').innerHTML = refs.length || pinsNow ? `<div class="card"><strong>Results</strong>
    <p>${refs.length >= 2 ? `${refs.length} references, ${nMarks} marks, ${ftIn(st.baseline || 0)} apart at the widest.` : 'Not lined up yet: mark two references in AR.'}${x ? ` Walked ${ft(x.walked)}; lost its place ${x.losses} time${x.losses === 1 ? '' : 's'}${x.resets ? `; its frame jumped ${x.resets} time${x.resets === 1 ? '' : 's'}` : ''}; ${x.fastTurns} fast turn${x.fastTurns === 1 ? '' : 's'}.` : ''}</p>
    ${checks.length ? `<p><strong>Check points: ${ftIn(errs[errs.length >> 1])} off at the middle, ${ftIn(errs[errs.length - 1])} at the worst</strong> (${checks.length}).</p>` : ''}
    ${rows.length ? `<table>${rows.join('')}</table>` : ''}
    <p>${pinsNow} head${pinsNow === 1 ? '' : 's'} placed (red on the map).</p>
    <div class="tools"><button type="button" id="copy">Copy results</button></div></div>` : '';
  $('#copy')?.addEventListener('click', async () => {
    const out = {
      page: 'water AR test v2', when: new Date().toISOString(), device: navigator.userAgent, stats: x ? { walkedM: +x.walked.toFixed(1), losses: x.losses, resets: x.resets, fastTurns: x.fastTurns } : null,
      references: refs.map((p) => ({ name: p.name, marks: p.marks.map((m) => ({ walkedM: +m.odo.toFixed(1), aimM: +m.dist.toFixed(2), anchorMovedM: m.anchorMoved != null ? +m.anchorMoved.toFixed(3) : null })) })),
      checks: checks.map(({ p, l }) => ({ name: p.name, errorM: +l.error.toFixed(3), fromRefMarkM: +l.walked.toFixed(1), aimM: +l.dist.toFixed(2), head: !!p.head })),
      headsPlaced: pinsNow, events: st.events.slice(-60),
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
    const hit = st.points.find((p) => { const [x, y] = toPx(p.map); return Math.hypot(x - b[0], y - b[1]) < hitR() * 1.4; });
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
    if (drag && moved) { drag.map = fromPx(toBase(xy)); drag.head = null; drag.marks = []; drawMap(); }
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
    // a tap: snap to a mapped head within reach, else where it fell
    const b = toBase(xy);
    let map = fromPx(b), head = null;
    const near = st.heads.map((h) => ({ h, d: Math.hypot(toPx(h.map)[0] - b[0], toPx(h.map)[1] - b[1]) })).sort((p, q) => p.d - q.d)[0];
    if (near && near.d < hitR() * 1.5) { map = [...near.h.map]; head = near.h.label; }
    // a tap on an existing point does nothing (it was a press to drag it)
    if (st.points.some((p) => { const [x, y] = toPx(p.map); return Math.hypot(x - b[0], y - b[1]) < hitR() * 1.4; })) return;
    st.points.push({ id: `${Date.now()}`, kind: st.adding, name: nextName(st.adding), map, head, marks: [] });
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
    st.adding = b.dataset.add;
    document.querySelectorAll('[data-add]').forEach((x) => { x.classList.toggle('on', x === b); x.classList.toggle('plain', x !== b); });
  }));
  $('#undo-point').addEventListener('click', () => { st.points.pop(); save(); listPoints(); drawMap(); });
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
/** What to mark next: an unmarked reference, then an unmarked check point, then the reference nearest the phone again. */
function nextTarget() {
  const want = st.points.filter((p) => !marked(p));
  const first = want.find((p) => p.kind === 'ref') || want[0];
  if (first) return first;
  const me = myMap();
  const refs = st.points.filter((p) => p.kind === 'ref');
  return me ? refs.sort((a, b) => Math.hypot(a.map[0] - me[0], a.map[1] - me[1]) - Math.hypot(b.map[0] - me[0], b.map[1] - me[1]))[0] : refs[0] || null;
}
const myMap = () => (st.T && xr?.pose ? apply(st.T, arLevel(xr.pose.transform.position)) : null);
function flash(text) { const f = $('#flash'); f.textContent = text; f.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => f.classList.remove('show'), 1800); }

async function startAR() {
  const overlay = $('#overlay');
  overlay.hidden = false; document.body.classList.add('in-ar');
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'anchors'], domOverlay: { root: overlay } });
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
  log(`AR started; dom overlay ${session.domOverlayState?.type || 'none'}; anchors ${xr.anchors ? 'yes' : 'no'}`);
  // ARCore's frame jumped (it relocalised): marks before the jump no longer line up with anything after it
  ref.addEventListener?.('reset', () => { if (!xr) return; xr.odo += RESET_WALK; xr.stats.resets++; xr.lastPos = null; log('frame reset'); flash('The AR jumped: mark a reference again'); refit(); });
  session.addEventListener('end', () => { log('AR ended'); st.lastStats = xr?.stats; xr = null; overlay.hidden = true; document.body.classList.remove('in-ar'); save(); listPoints(); drawMap(); results(); });
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
  const tracking = !!pose && !pose.emulatedPosition;
  if (xr.tracking && !tracking && pose) { xr.stats.losses++; xr.odo += LOSS_WALK; log('lost its place'); }
  if (!xr.tracking && tracking) { xr.lastPos = null; log('found its place'); }
  xr.tracking = tracking;
  if (tracking) {
    // the walk: the phone's movement on the level, ignoring jitter under 5 cm
    const p = pose.transform.position;
    if (!xr.lastPos) xr.lastPos = { x: p.x, z: p.z };
    const d = Math.hypot(p.x - xr.lastPos.x, p.z - xr.lastPos.z);
    if (d > 0.05) { xr.odo += d; xr.stats.walked += d; xr.lastPos = { x: p.x, z: p.z }; }
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
    hud(tracking);
  }
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
    const q = ap.transform.position;
    m.ar = { x: q.x, y: q.y, z: q.z };
    m.anchorMoved = Math.hypot(q.x - m.raw.x, q.z - m.raw.z);
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
  if (nRefs >= 2 && st.T) {
    const w = walkedSinceRef();
    lines.push(w > WALK_REMARK ? `<strong class="warn">Mark a reference again</strong> (${ft(w)} walked since the last mark)` : `Lined up (${refMarks().length} marks; ${ft(w || 0)} since the last)${st.baseline < 5 ? ' — <strong class="warn">references too close together</strong>' : ''}`);
  } else lines.push(`Mark ${2 - nRefs} more reference${2 - nRefs === 1 ? '' : 's'} to line up`);
  const tg = xr.target;
  if (tg) lines.push(`Next: <strong>${esc(tg.name)}</strong> (${tg.kind === 'ref' ? 'reference' : 'check point'}${tg.head ? `, head ${esc(tg.head)}` : ''}${marked(tg) ? ', again' : ''}) — tap another on the small map`);
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
    if (t.kind === 'check') { const l = checkLanding(t); flash(l ? `${t.name}: ${ftIn(l.error)} off${far}` : `${t.name} marked${far}`); } else flash(`${t.name} marked${far}`);
    xr.target = nextTarget();
    updateBar(); results(); listPoints();
  });
  $('#place').addEventListener('click', () => {
    if (!st.T) return;
    if (!xr.cur) { flash('No ground under the crosshair'); return; }
    const p = xr.pose.transform.position;
    const pin = { ar: { ...xr.cur }, raw: { ...xr.cur }, odo: xr.odo, dist: Math.hypot(xr.cur.x - p.x, xr.cur.z - p.z), session: st.session, at: Date.now() };
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
  await checkXR();
  wireMap(); wireAR(); listPoints(); drawMap(); results();
}

open().catch((e) => { $('#status').textContent = `Something went wrong: ${e.message}`; });
