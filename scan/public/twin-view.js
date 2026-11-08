/**
 * THE WALK TWIN VIEWER (core session, 2026-11-03; owner: "I want to see how it lines up with reality"). A walk's
 * twin (scan/lib/twin.js, kept by src/twin.js) laid over the map's photo and the lidar the AR match used:
 * the phone's depth points placed by the walk's own fixes (or the references alone, or the fixes alone, to compare),
 * its track, and the camera pictures along it. Admin only, like everything on this site.
 */
import { toLocal } from '/lib/frames.js';
import { frameFor, bboxOf, toPx, ringsOf } from '/lib/photo.js';
import { readCloud, readTrack, placer, placeCloud, lineUp } from '/lib/twin.js';
import { apply } from '/lib/align.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FT = 3.28084;
const ftIn = (m) => { const inch = Math.round(m * FT * 12); return inch < 12 ? `${inch} in` : `${Math.floor(inch / 12)} ft ${inch % 12} in`; };
const walkId = new URLSearchParams(location.search).get('walk');
const st = { meta: null, live: null, cloud: [], track: [], keys: [], map: null, origin: null, frame: null, photo: null, lawn: [], parcel: [], overlay: null, lidarWhy: '', placed: null, view: { s: 1, ox: 0, oy: 0 }, pic: -1 };

const getJSON = async (u) => { const r = await fetch(u, { credentials: 'same-origin' }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.error || `${r.status}`); return j; };
const part = (name) => fetch(`/api/scan/twin?walk=${encodeURIComponent(walkId)}&part=${encodeURIComponent(name)}`, { credentials: 'same-origin' });

async function main() {
  if (!walkId) return listTwins();
  $('#inspect-link').href = `/inspect.html?walk=${encodeURIComponent(walkId)}`;
  const { parts } = await getJSON(`/api/scan/twin?walk=${encodeURIComponent(walkId)}`);
  if (!parts.length) { $('#status').textContent = 'No twin was kept for this walk.'; return; }
  const names = parts.map((p) => p.name).sort();
  const bytes = parts.reduce((a, p) => a + p.bytes, 0);
  $('#status').textContent = `Reading the twin (${(bytes / 1e6).toFixed(1)} MB in ${parts.length} parts)…`;
  st.meta = names.includes('meta.json') ? await (await part('meta.json')).json() : {};
  st.live = names.includes('live.json') ? await (await part('live.json')).json() : { fixes: [], marks: [] };
  for (const n of names.filter((x) => x.startsWith('cloud-'))) st.cloud.push(...readCloud(await (await part(n)).arrayBuffer()));
  for (const n of names.filter((x) => x.startsWith('track-'))) st.track.push(...readTrack(await (await part(n)).arrayBuffer()));
  for (const n of names.filter((x) => x.startsWith('keys-'))) st.keys.push(...(await (await part(n)).json()));
  st.keys = st.keys.filter((k) => names.includes(k.name));
  if (st.meta.map) await loadMap(st.meta.map).catch((e) => { st.mapWhy = e.message; });
  $('#view').hidden = false;
  $('#status').textContent = `Walk of ${st.meta.started ? new Date(st.meta.started).toLocaleString() : '?'}${st.live.ended ? '' : ' (cut short: what was sent before it stopped)'}. ${st.cloud.length.toLocaleString()} points, ${st.track.length.toLocaleString()} poses, ${st.keys.length} pictures, ${st.live.fixes.length} lidar fixes, ${st.live.marks.filter((m) => m.kind === 'ref').length} reference marks.${st.mapWhy ? ` The map could not be opened (${st.mapWhy}).` : ''}`;
  wire();
  place();
  if (st.keys.length) { $('#pics').hidden = false; $('#pic-at').max = String(st.keys.length - 1); showPic(0); }
  if (names.includes('splat.splat')) showSplat(parts);
}

/** The splat made from this walk by workflow S2 (scan/tools/splat_modal.py), when there is one. */
async function showSplat(parts) {
  $('#splat').hidden = false;
  const size = parts.find((p) => p.name === 'splat.splat')?.bytes || 0;
  $('#splat-size').textContent = `${(size / 1e6).toFixed(1)} MB`;
  try {
    const n = await (await part('splat.json')).json();
    $('#splat-numbers').textContent = n.error ? n.error : `${n.gaussians.toLocaleString()} splats from ${n.pictures} pictures; matches them to ${n.psnr} dB (PSNR: 20 is rough, 25 good, 30 very good).`;
  } catch { /* the numbers are optional */ }
  try { const r = await part('splat-compare.jpg'); if (r.ok) $('#splat-compare').src = URL.createObjectURL(await r.blob()); } catch { /* none */ }
  $('#splat-open').addEventListener('click', async () => {
    const el = $('#splat-3d'), b = $('#splat-open');
    b.disabled = true; b.textContent = 'Loading…'; el.hidden = false;
    try {
      const GS = await import('https://cdn.jsdelivr.net/npm/@mkkellogg/gaussian-splats-3d@0.4.7/build/gaussian-splats-3d.module.js');
      // start where the first picture was taken, looking the way it looked
      const v = st.keys[0]?.view, at = v ? [v[12], v[13], v[14]] : [0, 1.5, 0], look = v ? [v[12] - v[8], v[13] - v[9], v[14] - v[10]] : [0, 1.5, -1];
      const viewer = new GS.Viewer({ rootElement: el, cameraUp: [0, 1, 0], initialCameraPosition: at, initialCameraLookAt: look, sharedMemoryForWorkers: false, gpuAcceleratedSort: false });
      await viewer.addSplatScene(`/api/scan/twin?walk=${encodeURIComponent(walkId)}&part=splat.splat`, { format: GS.SceneFormat.Splat, showLoadingUI: true, progressiveLoad: false });
      viewer.start();
      b.textContent = 'Opened';
    } catch (e) { b.textContent = `Could not open it (${e.message})`; }
  });
}

async function listTwins() {
  const [{ twins }, walks] = await Promise.all([getJSON('/api/scan/twins'), getJSON('/api/scan/walks').catch(() => ({ walks: [] }))]);
  const when = new Map((walks.walks || []).map((w) => [w.id, w]));
  $('#status').textContent = twins.length ? 'The walks with a twin, newest first.' : 'No twins yet: the next walk keeps one.';
  $('#list').innerHTML = twins.length ? `<ul>${twins.map((t) => { const w = when.get(t.walk); return `<li><a href="?walk=${encodeURIComponent(t.walk)}">${w ? new Date(w.at).toLocaleString() : esc(t.walk)}</a> <span class="dim">${(t.bytes / 1e6).toFixed(1)} MB, ${t.keys} pictures${w?.summary?.stats ? `, ${Math.round(w.summary.stats.walkedM * FT)} ft walked` : ''}</span></li>`; }).join('')}</ul>` : '';
}

async function loadMap(id) {
  const j = await getJSON(`/api/maps/one?id=${encodeURIComponent(id)}`);
  const m = j?.map || j;
  if (!m || !Number.isFinite(m.lng) || !Number.isFinite(m.lat)) throw new Error('no point');
  st.map = m; st.origin = [m.lng, m.lat];
  st.lawn = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(st.origin, p)));
  st.parcel = ringsOf(m.parcel ? [m.parcel] : []).map((r) => r.map((p) => toLocal(st.origin, p)));
  const pts = [...st.lawn.flat(), ...st.parcel.flat()];
  st.frame = frameFor(bboxOf(st.origin, pts, 12), m.lat);
  try {
    const q = new URLSearchParams({ lng: st.frame.lng, lat: st.frame.lat, zoom: st.frame.zoom, size: st.frame.size, height: st.frame.height, provider: 'mapbox' });
    const r = await fetch(`/api/imagery?${q}`);
    if (r.ok) st.photo = await createImageBitmap(await r.blob());
  } catch { /* the outline alone */ }
  // the same lidar, read the same way, as the AR page's match used
  const es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
  const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
  const w = new Worker('/lidar-worker.js', { type: 'module' });
  st.lidarWhy = 'reading the lidar…';
  w.onmessage = ({ data }) => {
    if (data.progress) { st.lidarWhy = data.progress; numbers(); }
    if (data.error) { st.lidarWhy = `the lidar could not be read: ${data.error}`; numbers(); }
    if (data.ready) st.lidarRule = data.ready.rule;
    if (data.overlay) { st.overlay = data.overlay; st.lidarWhy = ''; w.terminate(); place(); }
  };
  w.postMessage({ load: { origin: st.origin, box, lidar: m.tools?.shade?.data?.lidar || null } });
}

function place() {
  const mode = $('#fit').value;
  const pl = placer(st.live, mode);
  st.placed = placeCloud(st.cloud, pl);
  st.trackPlaced = st.track.map((p) => { const T = pl(p.odo); return T ? apply(T, [p.pos.x, -p.pos.z]) : null; });
  st.place = pl;
  numbers(); draw();
}

function numbers() {
  const el = $('#numbers'); if (!el || !st.placed) return;
  const lu = st.overlay ? lineUp(st.placed.pts, st.overlay.dist) : null;
  const fx = st.live.fixes;
  el.innerHTML = `<p><strong>${st.placed.placed.toLocaleString()}</strong> points placed, ${st.placed.unplaced.toLocaleString()} not (no fix or references for that part of the walk).</p>
    ${lu && lu.n ? `<p>The phone's walls, fences and trunks against the lidar's: <strong>${Math.round(lu.within30cm * 100)}%</strong> within a foot; half within <strong>${ftIn(lu.medianM)}</strong> (${lu.n.toLocaleString()} points).</p>` : st.overlay ? '<p class="dim">No standing points placed over the lidar.</p>' : `<p class="dim">${esc(st.lidarWhy || 'No lidar for this map.')}</p>`}
    <p class="dim">${fx.length} lidar fix${fx.length === 1 ? '' : 'es'}${fx.length ? ` at ${fx.map((f) => `${Math.round(f.odo * FT)} ft`).slice(0, 12).join(', ')}${fx.length > 12 ? '…' : ''} of the walk` : ''}.${st.lidarRule ? ` Buildings by ${esc(st.lidarRule)}.` : ''}</p>`;
}

/* --------------------------------------------------------------- drawing */

const W = () => (st.photo ? st.photo.width : 1280), H = () => (st.photo ? st.photo.height : 1280);
const px = (m) => (st.frame ? toPx(st.frame, st.origin, m, W(), H()) : [W() / 2 + m[0] * 8, H() / 2 - m[1] * 8]);

function draw() {
  const cv = $('#map'); if (!cv) return;
  if (cv.width !== W() || cv.height !== H()) { cv.width = W(); cv.height = H(); }
  const g = cv.getContext('2d'), s = st.view.s;
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#2a332f'; g.fillRect(0, 0, cv.width, cv.height);
  g.setTransform(s, 0, 0, s, st.view.ox, st.view.oy);
  if (st.photo && $('#show-photo').checked) g.drawImage(st.photo, 0, 0);
  const p0 = px([0, 0]), p1 = px([1, 0]), ppm = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 8;
  const sq = (m, size, color) => { const [x, y] = px(m); g.fillStyle = color; g.fillRect(x - size / 2, y - size / 2, size, size); };
  if (st.overlay && $('#show-lidar').checked) {
    const t = st.overlay.tall;
    for (let i = 0; i < t.length; i += 5) if (t[i + 4]) sq([t[i] + 0.5, t[i + 1] + 0.5], ppm, 'rgba(249,115,22,.28)');
    const so = st.overlay.solids, c = st.overlay.cell * ppm;
    for (let i = 0; i < so.length; i += 4) sq([so[i] + st.overlay.cell / 2, so[i + 1] + st.overlay.cell / 2], c, 'rgba(59,130,246,.75)');
  }
  for (const r of st.parcel) ring(g, r, 'rgba(255,255,255,.7)', s);
  if (st.placed) {
    const P = st.placed.pts, want = [$('#show-ground').checked, $('#show-stand').checked, $('#show-high').checked];
    const col = ['rgba(203,213,225,.5)', 'rgba(239,68,68,.85)', 'rgba(250,204,21,.85)'], size = Math.max(1.5, 0.08 * ppm);
    for (let k = 0; k < 3; k++) {
      if (!want[k]) continue;
      g.fillStyle = col[k];
      for (let i = 0; i < P.length; i += 4) if (P[i + 3] === k) { const [x, y] = px([P[i], P[i + 1]]); g.fillRect(x - size / 2, y - size / 2, size, size); }
    }
  }
  if (st.trackPlaced && $('#show-track').checked) {
    g.strokeStyle = '#22d3ee'; g.lineWidth = 2 / s; g.beginPath();
    let on = false;
    for (const m of st.trackPlaced) { if (!m) { on = false; continue; } const [x, y] = px(m); if (on) g.lineTo(x, y); else g.moveTo(x, y); on = true; }
    g.stroke();
  }
  // references where they are on the map, and the pins where the walk put them
  for (const m of st.live.marks || []) if (m.kind === 'ref') dot(g, m.map, '#2f7cf6', s);
  for (const p of st.live.pins || []) { const T = p.at && st.place ? st.place(p.odo) : null; if (T) dot(g, apply(T, [(p.anchorAt || p.at).x, -(p.anchorAt || p.at).z]), '#e53935', s, p.name); }
  // the picture being looked at: where the phone stood and which way it faced
  const k = st.keys[st.pic];
  if (k && st.place) {
    const T = st.place(k.odo);
    if (T) {
      const v = k.view, at = apply(T, [v[12], -v[14]]), ahead = apply(T, [v[12] - v[8] * 4, -(v[14] - v[10] * 4)]);
      const [x0, y0] = px(at), [x1, y1] = px(ahead);
      g.strokeStyle = '#fff'; g.lineWidth = 3 / s; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      dot(g, at, '#facc15', s);
    }
  }
}
function ring(g, r, color, s) { if (r.length < 2) return; g.beginPath(); r.forEach((p, i) => { const [x, y] = px(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath(); g.setLineDash([6 / s, 4 / s]); g.strokeStyle = color; g.lineWidth = 1.5 / s; g.stroke(); g.setLineDash([]); }
function dot(g, m, color, s, label) {
  const [x, y] = px(m); g.beginPath(); g.arc(x, y, 7 / s, 0, Math.PI * 2); g.fillStyle = color; g.fill(); g.lineWidth = 2 / s; g.strokeStyle = '#fff'; g.stroke();
  if (label) { g.font = `bold ${13 / s}px system-ui, sans-serif`; g.fillStyle = '#fff'; g.fillText(label, x + 9 / s, y + 4 / s); }
}

async function showPic(i) {
  st.pic = i; const k = st.keys[i]; if (!k) return;
  $('#pic-when').textContent = `${i + 1} of ${st.keys.length}, ${Math.round(k.t)} s in, ${Math.round(k.odo * FT)} ft walked`;
  try { const r = await part(k.name); if (r.ok) { const u = URL.createObjectURL(await r.blob()); const img = $('#pic'); if (img.dataset.u) URL.revokeObjectURL(img.dataset.u); img.src = u; img.dataset.u = u; } } catch { /* none */ }
  draw();
}

/* -------------------------------------------------------------- controls */

function wire() {
  for (const id of ['show-photo', 'show-lidar', 'show-ground', 'show-stand', 'show-high', 'show-track']) $(`#${id}`).addEventListener('change', draw);
  $('#fit').addEventListener('change', place);
  $('#pic-at').addEventListener('input', (e) => showPic(+e.target.value));
  const zoom = (f, at = [W() / 2, H() / 2]) => { const s0 = st.view.s, s1 = Math.max(1, Math.min(16, s0 * f)); st.view.ox = at[0] - ((at[0] - st.view.ox) * s1) / s0; st.view.oy = at[1] - ((at[1] - st.view.oy) * s1) / s0; st.view.s = s1; clamp(); draw(); };
  const clamp = () => { const w = W(), h = H(), s = st.view.s; st.view.ox = Math.min(0, Math.max(w - w * s, st.view.ox)); st.view.oy = Math.min(0, Math.max(h - h * s, st.view.oy)); };
  $('#zoom-in').addEventListener('click', () => zoom(1.6));
  $('#zoom-out').addEventListener('click', () => zoom(1 / 1.6));
  $('#zoom-fit').addEventListener('click', () => { st.view = { s: 1, ox: 0, oy: 0 }; draw(); });
  // drag to pan, two fingers to zoom
  const cv = $('#map'), touches = new Map();
  const toCanvas = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * cv.width, ((e.clientY - r.top) / r.height) * cv.height]; };
  let pinch = null;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); touches.set(e.pointerId, toCanvas(e)); if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; } });
  cv.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    const prev = touches.get(e.pointerId), now = toCanvas(e); touches.set(e.pointerId, now);
    if (touches.size === 1) { st.view.ox += now[0] - prev[0]; st.view.oy += now[1] - prev[1]; clamp(); draw(); }
    else if (touches.size === 2 && pinch) { const [a, b] = [...touches.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (d > 0) { zoom(d / pinch.d, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); pinch.d = d; } }
  });
  const up = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8, toCanvas(e)); }, { passive: false });
  $('#delete').addEventListener('click', async () => {
    if (!confirm('Delete this walk\'s twin (its points, track and pictures)? The walk\'s results stay.')) return;
    const r = await fetch(`/api/scan/twin?walk=${encodeURIComponent(walkId)}`, { method: 'DELETE', credentials: 'same-origin' });
    $('#status').textContent = r.ok ? 'Deleted.' : `Not deleted (${r.status}).`;
    if (r.ok) $('#view').hidden = true;
  });
}

main().catch((e) => { $('#status').textContent = `The twin could not be read: ${e.message}`; });
