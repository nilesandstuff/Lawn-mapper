/**
 * PLACING HEADS IN AR: THE ADMIN TEST PAGE (owner, 2026-10-31: "make an AR tool that you walk the lawn with and point a
 * cursor at the head, tap place, and it puts a pin there... initially test it on a seperate admin only page to be sure
 * it's actually usable before shipping it"; FINDINGS H64).
 *
 * WebXR's immersive-ar session (Chrome on Android, ARCore) with hit-test: the crosshair's ray meets the ground the phone
 * has found, to a few centimetres. References marked both on the saved map's photo and in AR line the two up
 * (lib/ar-align.js: a turn and a shift, least squares); then each Place head is a pin on the map. Check points, marked
 * on both but left out of the fit, say how far off a placed head lands. Nothing here writes to the map: the points and
 * pins are kept on this phone (per map) and the results copied by hand.
 */
import { toLocal, fromLocal, arLevel, fitRigid, apply, headingOf, baseline } from '/lib/ar-align.js';
import { tracedOn, lineUpAt } from '/lib/shade/traced.js';
import { openable } from '/lib/maps.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FT = 3.28084;
const ftIn = (m) => { const inch = Math.round(m * FT * 12); return inch < 12 ? `${inch} in` : `${Math.floor(inch / 12)} ft ${inch % 12} in`; };

/* ---------------------------------------------------------------- the map */

const R = 6378137;
const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];
const fromMerc = ([x, y]) => [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
const worldSize = (zoom) => 512 * 2 ** zoom;
const mercToWorld = ([x, y], zoom) => [((x + Math.PI * R) / (2 * Math.PI * R)) * worldSize(zoom), ((Math.PI * R - y) / (2 * Math.PI * R)) * worldSize(zoom)];
const worldToMerc = ([wx, wy], zoom) => [(wx / worldSize(zoom)) * 2 * Math.PI * R - Math.PI * R, Math.PI * R - (wy / worldSize(zoom)) * 2 * Math.PI * R];

const st = { site: null, origin: null, frame: null, photo: null, shift: [0, 0], heads: [], lawn: [], points: [], pins: [], adding: 'ref', key: null, T: null, session: 0 };

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
// map metres (east, north of the map's point) <-> pixels on the photo canvas
function toPx([e, n]) {
  const f = st.frame, w = st.photo ? st.photo.width : 1280, h = st.photo ? st.photo.height : 1280;
  const c = mercToWorld(toMerc([f.lng, f.lat]), f.zoom), p = mercToWorld(toMerc(fromLocal(st.origin, [e, n])), f.zoom), s = w / f.size;
  return [(p[0] - c[0]) * s + w / 2 + st.shift[0], (p[1] - c[1]) * s + h / 2 + st.shift[1]];
}
function fromPx([x, y]) {
  const f = st.frame, w = st.photo ? st.photo.width : 1280, h = st.photo ? st.photo.height : 1280, s = w / f.size;
  const c = mercToWorld(toMerc([f.lng, f.lat]), f.zoom);
  const wx = (x - w / 2 - st.shift[0]) / s + c[0], wy = (y - h / 2 - st.shift[1]) / s + c[1];
  return toLocal(st.origin, fromMerc(worldToMerc([wx, wy], f.zoom)));
}

function drawMarks(ctx, P, r) {
  // the lawn's outline
  ctx.lineWidth = Math.max(1.5, r / 3); ctx.strokeStyle = 'rgba(255,255,255,.85)';
  for (const ring of st.lawn) { ctx.beginPath(); ring.forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke(); }
  // the heads already on the map
  for (const h of st.heads) { const [x, y] = P(h.map); ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill(); ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke(); }
  // references and check points: filled once marked in AR; a check's AR landing joined to it
  st.points.forEach((pt) => {
    const [x, y] = P(pt.map), col = pt.kind === 'ref' ? cssVar('--ref') : cssVar('--check');
    if (pt.kind === 'check' && pt.ar && st.T) { const [ax, ay] = P(apply(st.T, arLevel(pt.ar))); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ax, ay); ctx.stroke(); ctx.beginPath(); ctx.arc(ax, ay, r * 0.5, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill(); }
    ctx.beginPath(); ctx.rect(x - r, y - r, 2 * r, 2 * r); ctx.lineWidth = 2.5; ctx.strokeStyle = col; ctx.stroke();
    if (pt.ar) { ctx.fillStyle = col; ctx.fill(); }
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 1.6)}px system-ui`; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(pt.name, x + r * 1.3, y - r * 0.6); ctx.fillText(pt.name, x + r * 1.3, y - r * 0.6);
  });
  // the heads placed in AR
  for (const pin of st.pins) { const m = pinMap(pin); if (!m) continue; const [x, y] = P(m); ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, 2 * Math.PI); ctx.fillStyle = cssVar('--pin'); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#f00';

function drawMap() {
  const cv = $('#map'), w = st.photo ? st.photo.width : 1280, h = st.photo ? st.photo.height : 1280;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#2a332f'; ctx.fillRect(0, 0, w, h);
  if (st.photo) ctx.drawImage(st.photo, st.shift[0], st.shift[1]);
  drawMarks(ctx, toPx, Math.max(6, w / 120));
}

/* ------------------------------------------------------- points and pins */

const save = () => { try { localStorage.setItem(st.key, JSON.stringify({ points: st.points.map(({ ar, ...p }) => p), pins: st.pins.map((p) => ({ map: pinMap(p), at: p.at })) })); } catch { /* this phone only */ } };
const load = () => { try { const j = JSON.parse(localStorage.getItem(st.key) || 'null'); if (j) { st.points = (j.points || []).map((p) => ({ ...p, ar: null })); st.pins = (j.pins || []).filter((p) => p.map).map((p) => ({ map: p.map, at: p.at })); } } catch { /* fresh */ } };
const nextName = (kind) => { const pre = kind === 'ref' ? 'R' : 'C'; let k = 1; while (st.points.some((p) => p.name === `${pre}${k}`)) k++; return `${pre}${k}`; };
// a pin placed in this AR session moves with every better fit; one from an earlier session keeps where it was put
const pinMap = (p) => (p.ar && p.session === st.session && st.T ? apply(st.T, arLevel(p.ar)) : p.map || null);

function refit() {
  const pairs = st.points.filter((p) => p.kind === 'ref' && p.ar).map((p) => ({ ar: arLevel(p.ar), map: p.map, p }));
  st.T = fitRigid(pairs);
  if (st.T) pairs.forEach((q, i) => { q.p.residual = st.T.residuals[i]; });
  st.baseline = baseline(pairs);
}

function listPoints() {
  $('#points').innerHTML = st.points.map((p) => `<li><span class="${p.kind}">${esc(p.name)}</span> ${p.kind === 'ref' ? 'reference' : 'check point'}${p.head ? ` (mapped head ${esc(p.head)})` : ''}${p.ar ? ' — marked in AR' : ''}</li>`).join('');
  const refs = st.points.filter((p) => p.kind === 'ref').length;
  $('#start').disabled = !st.xr || refs < 2;
  $('#xr-why').textContent = !st.xr ? st.xrWhy || '' : refs < 2 ? 'Add at least two references first.' : '';
}

function results() {
  const refs = st.points.filter((p) => p.kind === 'ref' && p.ar), checks = st.points.filter((p) => p.kind === 'check' && p.ar && st.T);
  const errs = checks.map((p) => { const [e, n] = apply(st.T, arLevel(p.ar)); return Math.hypot(e - p.map[0], n - p.map[1]); });
  checks.forEach((p, i) => { p.error = errs[i]; });
  const pinsNow = st.pins.filter((p) => pinMap(p)).length;
  const rows = [
    ...refs.map((p) => `<tr><td class="ref">${esc(p.name)}</td><td>reference</td><td>${st.T ? `fits to ${ftIn(p.residual || 0)}` : '—'}</td></tr>`),
    ...checks.map((p) => `<tr><td class="check">${esc(p.name)}</td><td>check point</td><td><strong>${ftIn(p.error)} off</strong></td></tr>`),
  ];
  const sorted = [...errs].sort((a, b) => a - b);
  $('#results').innerHTML = refs.length || pinsNow ? `<div class="card"><strong>Results</strong>
    ${st.T ? `<p>Lined up on ${refs.length} references ${ftIn(st.baseline || 0)} apart at the widest: ${refs.length > 2 ? `they fit to ${ftIn(st.T.rms)} on average` : 'two always fit each other, so only a third reference or a check point says how close it is'}; AR's distances against the map's: ${(st.T.scale * 100).toFixed(1)}%.</p>` : '<p>Not lined up yet: mark two references in AR.</p>'}
    ${checks.length ? `<p><strong>Check points: ${ftIn(sorted[sorted.length >> 1])} off at the middle, ${ftIn(sorted[sorted.length - 1])} at the worst</strong> (${checks.length}).</p>` : ''}
    ${rows.length ? `<table><tr><th></th><th></th><th></th></tr>${rows.join('')}</table>` : ''}
    <p>${pinsNow} head${pinsNow === 1 ? '' : 's'} placed (red on the map).</p>
    <div class="tools"><button type="button" id="copy">Copy results</button></div></div>` : '';
  $('#copy')?.addEventListener('click', async () => {
    const out = {
      page: 'water AR test', when: new Date().toISOString(), device: navigator.userAgent,
      fit: st.T ? { references: refs.length, baselineM: +(st.baseline || 0).toFixed(2), rmsM: +st.T.rms.toFixed(3), scale: +st.T.scale.toFixed(4) } : null,
      references: refs.map((p) => ({ name: p.name, residualM: +(p.residual || 0).toFixed(3) })),
      checks: checks.map((p) => ({ name: p.name, errorM: +p.error.toFixed(3), head: !!p.head })),
      headsPlaced: pinsNow, events: st.events.slice(-40),
    };
    try { await navigator.clipboard.writeText(JSON.stringify(out, null, 1)); $('#copy').textContent = 'Copied'; } catch { $('#copy').textContent = 'Could not copy'; }
  });
}

/* ------------------------------------------------- tapping and dragging */

function canvasXY(ev) {
  const cv = $('#map'), r = cv.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * cv.width, ((ev.clientY - r.top) / r.height) * cv.height];
}
function wireMap() {
  const cv = $('#map');
  let drag = null, downAt = null;
  cv.addEventListener('pointerdown', (ev) => {
    const xy = canvasXY(ev), near = (m) => { const [x, y] = toPx(m); return Math.hypot(x - xy[0], y - xy[1]); };
    const r = Math.max(14, cv.width / 50);
    const hit = st.points.find((p) => near(p.map) < r * 1.4);
    downAt = xy;
    if (hit) { drag = hit; cv.setPointerCapture(ev.pointerId); }
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    drag.map = fromPx(canvasXY(ev)); drag.head = null; drag.ar = null; drawMap();
  });
  cv.addEventListener('pointercancel', () => { if (drag) { drag = null; save(); listPoints(); drawMap(); } downAt = null; });
  cv.addEventListener('pointerup', (ev) => {
    const xy = canvasXY(ev);
    if (drag) { drag = null; save(); listPoints(); drawMap(); return; }
    if (!downAt || Math.hypot(xy[0] - downAt[0], xy[1] - downAt[1]) > 12) return;
    // a tap: snap to a mapped head within reach, else where it fell
    const r = Math.max(14, cv.width / 50);
    let map = fromPx(xy), head = null;
    const near = st.heads.map((h) => ({ h, d: Math.hypot(toPx(h.map)[0] - xy[0], toPx(h.map)[1] - xy[1]) })).sort((a, b) => a.d - b.d)[0];
    if (near && near.d < r * 1.5) { map = [...near.h.map]; head = near.h.label; }
    st.points.push({ id: `${Date.now()}`, kind: st.adding, name: nextName(st.adding), map, head, ar: null });
    save(); listPoints(); drawMap();
  });
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    st.adding = b.dataset.add;
    document.querySelectorAll('[data-add]').forEach((x) => { x.classList.toggle('on', x === b); x.classList.toggle('plain', x !== b); });
  }));
  $('#undo-point').addEventListener('click', () => { st.points.pop(); save(); listPoints(); drawMap(); });
  $('#clear-pins').addEventListener('click', () => { st.pins = []; save(); drawMap(); results(); });
}

/* -------------------------------------------------------------- the AR */

st.events = [];
const log = (what) => { st.events.push({ t: Math.round(performance.now()), what }); };

async function checkXR() {
  st.xr = false;
  if (!window.isSecureContext) { st.xrWhy = 'AR needs the secure (https) page.'; return; }
  if (!navigator.xr) { st.xrWhy = "This browser has no AR (WebXR). Open this page in Chrome on Android, on a phone that has Google Play Services for AR."; return; }
  try { st.xr = await navigator.xr.isSessionSupported('immersive-ar'); } catch { st.xr = false; }
  if (!st.xr) st.xrWhy = "This phone's browser says it cannot run AR. In Chrome on Android, install or update Google Play Services for AR.";
}

let xr = null; // { session, gl, ref, viewer, hits, cur, pose, target }
function nextTarget() {
  const want = st.points.filter((p) => !p.ar);
  return want.find((p) => p.kind === 'ref') || want[0] || null;
}
function flash(text) { const f = $('#flash'); f.textContent = text; f.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => f.classList.remove('show'), 1600); }

async function startAR() {
  const overlay = $('#overlay');
  overlay.hidden = false; document.body.classList.add('in-ar');
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'local-floor'], domOverlay: { root: overlay } });
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
  for (const p of st.points) { p.ar = null; p.residual = null; }
  st.T = null;
  const cv = document.createElement('canvas');
  const gl = cv.getContext('webgl', { xrCompatible: true, alpha: true });
  await gl.makeXRCompatible?.();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  const ref = await session.requestReferenceSpace('local');
  const viewer = await session.requestReferenceSpace('viewer');
  let hits;
  try { hits = await session.requestHitTestSource({ space: viewer, entityTypes: ['plane', 'point'] }); } catch { hits = await session.requestHitTestSource({ space: viewer }); }
  xr = { session, gl, ref, viewer, hits, cur: null, pose: null, target: nextTarget(), lastHud: 0, stack: [] };
  log(`AR started; dom overlay ${session.domOverlayState?.type || 'none'}`);
  session.addEventListener('end', () => { log('AR ended'); xr = null; overlay.hidden = true; document.body.classList.remove('in-ar'); save(); listPoints(); drawMap(); results(); });
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
  const tracking = pose && !pose.emulatedPosition;
  const res = tracking ? frame.getHitTestResults(xr.hits) : [];
  const hp = res.length ? res[0].getPose(xr.ref) : null;
  xr.cur = hp ? { x: hp.transform.position.x, y: hp.transform.position.y, z: hp.transform.position.z } : null;
  $('#cross').classList.toggle('hit', !!xr.cur);
  if (t - xr.lastHud > 120) { xr.lastHud = t; hud(tracking); }
}

function hud(tracking) {
  const p = xr.pose?.transform.position;
  const dist = xr.cur && p ? Math.hypot(xr.cur.x - p.x, xr.cur.z - p.z) : null;
  const refs = st.points.filter((q) => q.kind === 'ref' && q.ar).length;
  const lines = [];
  lines.push(!xr.pose ? 'Starting the camera…' : !tracking ? '<strong>Lost its place</strong>: hold still, aim at textured ground' : xr.cur ? `Ground ${ftIn(dist)} ahead` : 'Looking for the ground: sweep the phone slowly over it');
  if (st.T) lines.push(`Lined up on ${refs} references${refs > 2 ? ` (fit ${ftIn(st.T.rms)})` : ''}${st.baseline < 5 ? ' — <strong>references too close together</strong>' : ''}`);
  else lines.push(`Mark ${2 - refs} more reference${2 - refs === 1 ? '' : 's'} to line up`);
  const t = xr.target;
  if (t) lines.push(`Next: <strong>${esc(t.name)}</strong> (${t.kind === 'ref' ? 'reference' : 'check point'}${t.head ? `, head ${esc(t.head)}` : ''}) — tap another on the small map to choose it`);
  $('#hud').innerHTML = lines.join('<br>');
  drawMini();
}

function drawMini() {
  const cv = $('#mini'), ctx = cv.getContext('2d'), W = cv.width;
  ctx.clearRect(0, 0, W, W);
  // centred on the phone once lined up, else on the points; about 30 m across
  let c = st.points.length ? [st.points.reduce((a, p) => a + p.map[0], 0) / st.points.length, st.points.reduce((a, p) => a + p.map[1], 0) / st.points.length] : [0, 0];
  const me = st.T && xr?.pose ? apply(st.T, arLevel(xr.pose.transform.position)) : null;
  if (me) c = me;
  const span = 30, k = W / span;
  const P = ([e, n]) => [W / 2 + (e - c[0]) * k, W / 2 - (n - c[1]) * k];
  st.miniP = P; st.miniC = c; st.miniK = k;
  drawMarks(ctx, P, 9);
  if (me) {
    const h = (headingOf(st.T, xr.pose.transform.orientation) * Math.PI) / 180;
    const [x, y] = P(me);
    ctx.fillStyle = '#4cff9a'; ctx.beginPath(); ctx.moveTo(x + 16 * Math.sin(h), y - 16 * Math.cos(h)); ctx.lineTo(x + 8 * Math.sin(h + 2.4), y - 8 * Math.cos(h + 2.4)); ctx.lineTo(x + 8 * Math.sin(h - 2.4), y - 8 * Math.cos(h - 2.4)); ctx.closePath(); ctx.fill();
    if (xr.cur) { const [ax, ay] = P(apply(st.T, arLevel(xr.cur))); ctx.strokeStyle = '#4cff9a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ax, ay, 7, 0, 2 * Math.PI); ctx.stroke(); }
  }
}

function updateBar() {
  const t = xr?.target;
  $('#mark').textContent = t ? `Mark ${t.name}` : 'All marked';
  $('#mark').disabled = !t;
  $('#place').disabled = !st.T;
}

function wireAR() {
  $('#start').addEventListener('click', startAR);
  $('#exit').addEventListener('click', () => xr?.session.end());
  $('#mark').addEventListener('click', () => {
    if (!xr?.target) return;
    if (!xr.cur) { flash('No ground under the crosshair'); return; }
    const t = xr.target;
    xr.stack.push({ type: 'mark', p: t, prev: t.ar });
    t.ar = { ...xr.cur };
    log(`marked ${t.name}`);
    refit();
    navigator.vibrate?.(30);
    if (t.kind === 'check' && st.T) { const [e, n] = apply(st.T, arLevel(t.ar)); flash(`${t.name}: ${ftIn(Math.hypot(e - t.map[0], n - t.map[1]))} off`); } else flash(`${t.name} marked`);
    xr.target = nextTarget();
    updateBar(); results();
  });
  $('#place').addEventListener('click', () => {
    if (!st.T) return;
    if (!xr.cur) { flash('No ground under the crosshair'); return; }
    const pin = { ar: { ...xr.cur }, session: st.session, at: Date.now() };
    pin.map = apply(st.T, arLevel(pin.ar));
    st.pins.push(pin);
    xr.stack.push({ type: 'pin', pin });
    log('placed a head');
    navigator.vibrate?.(30);
    flash(`Head ${st.pins.length} placed`);
    save(); results();
  });
  $('#undo').addEventListener('click', () => {
    const a = xr?.stack.pop();
    if (!a) return;
    if (a.type === 'mark') { a.p.ar = a.prev; refit(); xr.target = a.p; } else st.pins = st.pins.filter((p) => p !== a.pin);
    log('undo');
    updateBar(); save(); results();
  });
  // choose the next point to mark by tapping it on the small map
  $('#mini').addEventListener('click', (ev) => {
    if (!xr || !st.miniP) return;
    const cv = $('#mini'), r = cv.getBoundingClientRect();
    const xy = [((ev.clientX - r.left) / r.width) * cv.width, ((ev.clientY - r.top) / r.height) * cv.height];
    const near = st.points.map((p) => ({ p, d: Math.hypot(st.miniP(p.map)[0] - xy[0], st.miniP(p.map)[1] - xy[1]) })).sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 40) { xr.target = near.p; updateBar(); hud(true); }
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
  $('#status').textContent = `${esc(m.address || 'Your map')}: ${st.heads.length} mapped head${st.heads.length === 1 ? '' : 's'}${st.photo ? '' : ' (the photo would not load: the lawn outline only)'}.`;
  load();
  $('#setup').hidden = false;
  await checkXR();
  wireMap(); wireAR(); listPoints(); drawMap(); results();
}

open().catch((e) => { $('#status').textContent = `Something went wrong: ${e.message}`; });
