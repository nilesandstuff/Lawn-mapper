/**
 * THE WALK INSPECTOR (core session, 2026-11-08; the owner: "I'd like to get eyes on some of this myself. Like a
 * visualization of the depth readings, the semantic labels, the mesh, the things that match vs. don't (and this new
 * point system), and just whatever else is going on. Kind of in the same spirit as the /predictions page").
 *
 * Reads what task `place` wrote beside the walk's twin (scan/tools/inspect_build.py): inspect.json and
 * inspect-points.bin, plus the twin's own pictures (keys-*.json, key-*.jpg) and mesh.bin. Admin only, like the site.
 */
import { unpackModel } from '/lib/lidar-model.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FT = 3.28084;
const walkId = new URLSearchParams(location.search).get('walk');
const part = (name) => fetch(`/api/scan/twin?walk=${encodeURIComponent(walkId)}&part=${encodeURIComponent(name)}`, { credentials: 'same-origin' });
const getJSON = async (u) => { const r = await fetch(u, { credentials: 'same-origin' }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.error || `${r.status}`); return j; };
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const st = { J: null, F: null, U: null, n: 0, keys: [], pic: -1, img: null, view: { s: 1, ox: 0, oy: 0 }, T: null, scoredT: null, box: null, base: {} };

/* ------------------------------------------------------------- colours */
const VERDICT = ['#94a3b8', '#f97316', '#22c55e', '#a855f7', '#14b8a6', '#ef4444', '#475569'];
const LABEL = { unlabeled: '#9ca3af', sky: '#7dd3fc', building: '#3b82f6', tree: '#16a34a', road: '#57534e', sidewalk: '#a8a29e', terrain: '#a3e635', structure: '#f59e0b', object: '#e879f9', vehicle: '#f43f5e', person: '#fb7185', water: '#0ea5e9' };
const ramp = (x) => { x = Math.max(0, Math.min(1, x)); const r = Math.round(255 * Math.min(1, 2 * x)), g = Math.round(255 * Math.min(1, 2 * (1 - x))); return `rgb(${r},${g},60)`; };
const rampBlue = (x) => { x = Math.max(0, Math.min(1, x)); return `hsl(${Math.round(260 - 220 * x)},80%,55%)`; };

function colourOf(i, mode) {
  const F = st.F, U = st.U, f = i * 8;
  if (mode === 'verdict') return VERDICT[U[f + 5]] || '#999';
  if (mode === 'label') return LABEL[st.J.labels[U[f + 1] - 1]] || '#6b7280';
  if (mode === 'conf') return U[f + 2] ? ramp(1 - U[f + 2] / 255) : '#6b7280';
  if (mode === 'class') return U[f] ? '#94a3b8' : '#ef4444';
  if (mode === 'height') return F[f + 6] < -50 ? '#6b7280' : rampBlue(F[f + 6] / 6);
  if (mode === 'flags') return U[f + 3] ? '#facc15' : U[f + 4] ? '#ef4444' : 'rgba(148,163,184,.35)';
  if (mode === 'time') return rampBlue(F[f + 3] / Math.max(1, st.tMax));
  return '#999';
}
function legend(mode) {
  const sw = (c, t) => `<span><span class="key" style="background:${c}"></span>${esc(t)}</span>`;
  if (mode === 'verdict') return st.J.verdicts.map((t, i) => sw(VERDICT[i], t)).join('');
  if (mode === 'label') return Object.entries(LABEL).map(([k, c]) => sw(c, k)).join('') + sw('#6b7280', 'no label kept (older walks)');
  if (mode === 'conf') return sw(ramp(0), 'ARCore sure') + sw(ramp(0.5), 'middling') + sw(ramp(1), 'weak') + sw('#6b7280', 'not kept');
  if (mode === 'class') return sw('#94a3b8', 'ground') + sw('#ef4444', 'standing');
  if (mode === 'height') return sw(rampBlue(0), 'on the ground') + sw(rampBlue(0.5), '3 m up') + sw(rampBlue(1), '6 m+');
  if (mode === 'flags') return sw('#ef4444', 'phantom: the walk\'s other sight lines pass through it') + sw('#facc15', 'spike: one spot read near on a far surface (the page\'s own check)') + sw('rgba(148,163,184,.6)', 'neither');
  if (mode === 'time') return sw(rampBlue(0), 'start') + sw(rampBlue(1), 'end');
  return '';
}

/* ---------------------------------------------------------------- start */
async function main() {
  if (!walkId) return listWalks();
  $('#twin-link').href = `/twin.html?walk=${encodeURIComponent(walkId)}`;
  const { parts } = await getJSON(`/api/scan/twin?walk=${encodeURIComponent(walkId)}`);
  const names = new Set(parts.map((p) => p.name));
  if (!names.has('inspect.json')) { $('#status').innerHTML = 'This walk has not been through the inspector yet: run workflow "S. Yard AR tool" with task <code>place</code> and this walk.'; return; }
  $('#status').textContent = 'Reading…';
  st.J = await (await part('inspect.json')).json();
  const buf = await (await part('inspect-points.bin')).arrayBuffer();
  st.n = st.J.points.n;
  st.F = new Float32Array(buf, 0, st.n * 8);
  st.U = new Uint8Array(buf, st.n * 32, st.n * 8);
  st.tMax = 0; for (let i = 0; i < st.n; i++) st.tMax = Math.max(st.tMax, st.F[i * 8 + 3]);
  for (const nm of [...names].filter((x) => /^keys-\d+\.json$/.test(x)).sort()) st.keys.push(...(await (await part(nm)).json()));
  st.keys = st.keys.filter((k) => names.has(k.name)).sort((a, b) => a.t - b.t);
  st.hasMesh = names.has('mesh.bin');
  const pl = st.J.placements;
  st.scoredT = pl[0].T; st.T = pl[0].T;
  $('#scored').textContent = st.J.scored;
  $('#place').innerHTML = pl.map((p, i) => `<option value="${i}">${esc(p.name)}${p.med != null ? ` (${p.med.toFixed(1)} ft off)` : ''}</option>`).join('');
  summary();
  grid();
  wire();
  $('#view').hidden = false;
  $('#status').textContent = `${st.n.toLocaleString()} of the walk's ${st.J.points.of.toLocaleString()} depth points; built ${new Date(st.J.at).toLocaleString()}.`;
  $('#time').max = String(Math.ceil(st.tMax));
  fit(); draw();
  if (st.keys.length) { $('#pics').hidden = false; $('#pic-at').max = String(st.keys.length - 1); showPic(0); }
}

async function listWalks() {
  const [{ twins }, walks] = await Promise.all([getJSON('/api/scan/twins'), getJSON('/api/scan/walks').catch(() => ({ walks: [] }))]);
  const when = new Map((walks.walks || []).map((w) => [w.id, w]));
  $('#status').textContent = twins.length ? 'Pick a walk (newest first). A walk shows here once task place has run on it.' : 'No walks with a twin yet.';
  $('#list').innerHTML = twins.length ? `<ul>${twins.map((t) => { const w = when.get(t.walk); return `<li><a href="?walk=${encodeURIComponent(t.walk)}">${w ? new Date(w.at).toLocaleString() : esc(t.walk)}</a> <span class="dim">${w?.summary?.stats ? `${Math.round(w.summary.stats.walkedM * FT)} ft walked` : ''}</span></li>`; }).join('')}</ul>` : '';
}

function summary() {
  const J = st.J;
  $('#placements').innerHTML = `<table><tr><th>Placed by</th><th>Off</th><th>Margin</th></tr>${J.placements.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.med != null ? `${p.med.toFixed(1)} ft` : '<span class="dim">no check points</span>'}</td><td>${p.margin != null ? `${(p.margin * 100).toFixed(1)}%` : ''}</td></tr>`).join('')}</table>`;
  const c = J.counts, tot = st.n || 1, pc = (k) => `${c[k].toLocaleString()} <span class="dim">(${Math.round((c[k] / tot) * 100)}%)</span>`;
  $('#counts').innerHTML = `<table>${J.verdicts.map((t, i) => `<tr><td><span class="key" style="background:${VERDICT[i]}"></span>${esc(t)}</td><td>${pc(['groundOn', 'groundOff', 'wall', 'wallHidden', 'thing', 'nothing', 'off'][i])}</td></tr>`).join('')}
    <tr><td>phantoms (the walk's other sight lines pass through them)</td><td>${pc('phantoms')}</td></tr><tr><td>spikes (the page's own check; walks from the evening of 2026-11-08)</td><td>${pc('spikes')}</td></tr></table>`;
  const W = J.consensus?.weights || {};
  const row = (nm, w) => `<tr><td>${esc(nm)}</td><td>${w.med != null ? `${w.med.toFixed(1)} ft` : ''}</td><td>${w.margin != null ? `${(w.margin * 100).toFixed(1)}%` : ''}</td><td>${w.credits ? ['G', 'B', 'O', 'P', 'X'].map((k) => (w.credits[k] ?? 0).toFixed(1)).join(' / ') : ''}</td></tr>`;
  const tr = J.consensus?.truth;
  $('#credits').innerHTML = Object.keys(W).length ? `<table><tr><th>Weighting</th><th>Off</th><th>Margin</th><th>Ground / buildings / things / pavement / through a house</th></tr>${tr ? row('the truth itself', { med: tr.med, credits: tr.credits }) : ''}${Object.entries(W).map(([k, w]) => row(k, w)).join('')}</table>` : '<p class="dim">No best-fit-overall run for this walk.</p>';
}

/* ------------------------------------------------------------ the grid */
function grid() {
  const g = st.J.grid;
  st.base.kind = b64(g.kind); st.base.height = b64(g.height); st.base.bright = g.bright ? b64(g.bright) : null;
  if (!st.base.bright) $('#base').querySelector('option[value=bright]').disabled = true;
  st.box = [g.x0, g.y1 - g.h * g.cellY, g.x0 + g.w * g.cell, g.y1];
  for (const k of ['kind', 'height', 'bright']) {
    const a = st.base[k]; if (!a) continue;
    const cv = document.createElement('canvas'); cv.width = g.w; cv.height = g.h;
    const ctx = cv.getContext('2d'), im = ctx.createImageData(g.w, g.h);
    for (let i = 0; i < g.w * g.h; i++) {
      let c = [0, 0, 0, 0]; const v = a[i];
      if (k === 'kind') c = v === 1 ? [59, 130, 246, 200] : v === 2 || v === 3 ? [22, 163, 74, 120] : v === 4 ? [245, 158, 11, 170] : v === 5 ? [148, 163, 184, 90] : [0, 0, 0, 0];
      else if (k === 'height') { const x = Math.min(1, v / 120); c = v ? [40 + 200 * x, 60 + 120 * (1 - x), 220 - 160 * x, 210] : [0, 0, 0, 0]; }
      else c = v ? [v, v, v, 230] : [0, 0, 0, 0];
      im.data.set(c, i * 4);
    }
    ctx.putImageData(im, 0, 0); st.base[`${k}Img`] = cv;
  }
}

/* ------------------------------------------------------------- drawing */
const CW = 1200;
const s0 = () => CW / Math.max(st.box[2] - st.box[0], st.box[3] - st.box[1]);
const toPx = (e, n) => [(e - st.box[0]) * s0(), (st.box[3] - n) * s0()];
function fit() {
  // fit the walk's points, not the whole lidar grid
  let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (let i = 0; i < st.n; i += 7) { const [e, n] = placed(i); if (!Number.isFinite(e)) continue; e0 = Math.min(e0, e); e1 = Math.max(e1, e); n0 = Math.min(n0, n); n1 = Math.max(n1, n); }
  if (!Number.isFinite(e0)) { st.view = { s: 1, ox: 0, oy: 0 }; return; }
  const [x0, y0] = toPx(e0 - 6, n1 + 6), [x1, y1] = toPx(e1 + 6, n0 - 6);
  const s = Math.min(16, Math.max(1, CW / Math.max(x1 - x0, y1 - y0)));
  st.view = { s, ox: -x0 * s + (CW - (x1 - x0) * s) / 2, oy: -y0 * s + (CW - (y1 - y0) * s) / 2 };
}
/** a point's map place under the chosen placement (the scored one is stored; others from the session point) */
function placed(i) {
  const f = i * 8, F = st.F;
  if (st.T === st.scoredT) return [F[f + 4], F[f + 5]];
  const [th, tx, ty] = st.T, c = Math.cos(th), s = Math.sin(th), u = F[f], v = -F[f + 2];
  return [c * u - s * v + tx, s * u + c * v + ty];
}
function inWindow(t) {
  const w = +$('#window').value; if (!w) return true;
  return Math.abs(t - +$('#time').value) <= w;
}
function draw() {
  const cv = $('#map'), g = cv.getContext('2d'), v = st.view, s = s0();
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#1d2421'; g.fillRect(0, 0, CW, CW);
  g.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);
  const base = $('#base').value, img = st.base[`${base}Img`];
  if (img) { g.imageSmoothingEnabled = false; const [x0, y0] = toPx(st.box[0], st.box[3]); g.drawImage(img, x0, y0, (st.box[2] - st.box[0]) * s, (st.box[3] - st.box[1]) * s); }
  const J = st.J, scoredView = st.T === st.scoredT;
  if ($('#show-credits').checked && scoredView) {
    for (const [e, n, q] of J.groundCells) { const [x, y] = toPx(e - 1, n + 1); g.fillStyle = `rgba(148,163,184,${0.08 + 0.3 * q})`; g.fillRect(x, y, 2 * s, 2 * s); }
    for (const [e, n, q] of J.edges) { const [x, y] = toPx(e, n); g.fillStyle = ramp(1 - q); g.beginPath(); g.arc(x, y, 0.45 * s, 0, 7); g.fill(); }
    for (const [e, n, q] of J.thingsHit) { const [x, y] = toPx(e, n); g.strokeStyle = '#14b8a6'; g.lineWidth = 3 / v.s; g.beginPath(); g.arc(x, y, (0.6 + q) * s, 0, 7); g.stroke(); }
  }
  if ($('#show-things').checked) for (const [e, n, area, top] of J.things) { const [x, y] = toPx(e, n); g.strokeStyle = 'rgba(245,158,11,.9)'; g.lineWidth = 1.5 / v.s; g.beginPath(); g.arc(x, y, Math.max(0.5, Math.sqrt(area / Math.PI)) * s, 0, 7); g.stroke(); }
  const mode = $('#colour').value, size = Math.max(1.2 / v.s, 0.12 * s), sg = $('#show-ground').checked, ss = $('#show-stand').checked;
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < st.n; i++) {
    const f = i * 8, ground = st.U[f] === 1;
    if (ground !== (pass === 0)) continue;   // ground first, standing on top
    if (ground ? !sg : !ss) continue;
    if (!inWindow(st.F[f + 3])) continue;
    const [e, n] = placed(i), [x, y] = toPx(e, n);
    g.fillStyle = colourOf(i, mode); g.fillRect(x - size / 2, y - size / 2, size, size);
  }
  if ($('#show-through').checked && scoredView) { g.strokeStyle = 'rgba(239,68,68,.8)'; g.lineWidth = 1.5 / v.s; for (const [a, b, c, d] of J.through) { const [x0, y0] = toPx(a, b), [x1, y1] = toPx(c, d); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); } }
  if ($('#show-track').checked && scoredView) {
    g.strokeStyle = '#22d3ee'; g.lineWidth = 2 / v.s; g.beginPath();
    J.track.forEach(([t, e, n], k) => { const [x, y] = toPx(e, n); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
    if (+$('#window').value) { const t = +$('#time').value, p = J.track.reduce((b, r) => (!b || Math.abs(r[0] - t) < Math.abs(b[0] - t) ? r : b), null); if (p) dot(g, p[1], p[2], '#facc15', v.s); }
  }
  if ($('#show-checks').checked) {
    const [th, tx, ty] = st.T, c = Math.cos(th), sn = Math.sin(th);
    for (const ch of J.checks) {
      const at = [c * ch.ar[0] - sn * ch.ar[1] + tx, sn * ch.ar[0] + c * ch.ar[1] + ty];
      const [x0, y0] = toPx(...ch.map), [x1, y1] = toPx(...at);
      g.strokeStyle = '#fff'; g.lineWidth = 2 / v.s; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      dot(g, ch.map[0], ch.map[1], '#a54bd8', v.s); dot(g, at[0], at[1], '#fff', v.s, 4);
    }
  }
  const k = st.keys[st.pic];
  if (k && scoredView) {
    const vw = k.view, [th, tx, ty] = st.T, c = Math.cos(th), sn = Math.sin(th);
    const m = (u, w) => [c * u - sn * w + tx, sn * u + c * w + ty];
    const a = m(vw[12], -vw[14]), b = m(vw[12] - vw[8] * 4, -(vw[14] - vw[10] * 4));
    const [x0, y0] = toPx(...a), [x1, y1] = toPx(...b);
    g.strokeStyle = '#facc15'; g.lineWidth = 3 / v.s; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  }
  $('#legend').innerHTML = legend(mode) + ($('#show-credits').checked ? `<br><span class="dim">credits: grey squares the ground (darker earns more), dots each metre of building edge (green full, red little), teal rings the lidar things that earned</span>` : '') + ($('#show-checks').checked ? '<br><span class="dim">check points: purple where they are on the map, white where this placement puts the mark</span>' : '') + (!scoredView ? '<br><span class="warn">Credits, track and verdicts are scored under the first placement; only the points move.</span>' : '');
  $('#time-at').textContent = +$('#window').value ? `${fmtT(+$('#time').value)} into the walk` : '';
}
function dot(g, e, n, color, vs, r = 6) { const [x, y] = toPx(e, n); g.beginPath(); g.arc(x, y, r / vs, 0, 7); g.fillStyle = color; g.fill(); g.lineWidth = 1.5 / vs; g.strokeStyle = '#000'; g.stroke(); }
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function pick(cx, cy) {
  const v = st.view, mx = (cx - v.ox) / v.s, my = (cy - v.oy) / v.s, s = s0();
  const e = mx / s + st.box[0], n = st.box[3] - my / s;
  let best = -1, bd = (8 / v.s / s) ** 2;
  for (let i = 0; i < st.n; i++) {
    const f = i * 8; if (!inWindow(st.F[f + 3])) continue;
    if (st.U[f] === 1 ? !$('#show-ground').checked : !$('#show-stand').checked) continue;
    const [pe, pn] = placed(i), d = (pe - e) ** 2 + (pn - n) ** 2; if (d < bd) { bd = d; best = i; }
  }
  if (best < 0) { $('#pick').textContent = ''; return; }
  const f = best * 8, F = st.F, U = st.U, lab = st.J.labels[U[f + 1] - 1];
  $('#pick').innerHTML = `<strong>${esc(st.J.verdicts[U[f + 5]])}</strong>${U[f + 5] === 2 || U[f] ? ` (grade ${F[f + 7].toFixed(2)})` : ''}. ${U[f] ? 'Ground point' : 'Standing point'}, ${F[f + 6] > -50 ? `${(F[f + 6] * FT).toFixed(1)} ft over the lidar's ground` : 'off the lidar'}; ARCore: ${lab ? esc(lab) : 'no label kept'}${U[f + 2] ? `, depth confidence ${(U[f + 2] / 255).toFixed(2)}` : ''}${U[f + 4] ? '; <span class="warn">a phantom</span>' : ''}${U[f + 3] ? '; <span class="warn">a spike</span>' : ''}. Seen ${fmtT(F[f + 3])} into the walk.`;
}

/* ------------------------------------------------------------ pictures */
async function showPic(i) {
  st.pic = i; const k = st.keys[i]; if (!k) return;
  $('#pic-when').textContent = `${i + 1} of ${st.keys.length}, ${fmtT(k.t)} in, ${Math.round(k.odo * FT)} ft walked`;
  try { const r = await part(k.name); if (r.ok) st.img = await createImageBitmap(await r.blob()); } catch { st.img = null; }
  drawPic(); draw();
}
function drawPic() {
  const k = st.keys[st.pic], cv = $('#pic'); if (!k) return;
  const W = st.img ? st.img.width : k.w || 640, H = st.img ? st.img.height : k.h || 480;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  if (st.img) g.drawImage(st.img, 0, 0);
  if (!$('#pic-dots').checked) return;
  const V = k.view, P = k.proj, mode = $('#colour').value, r = Math.max(2, W / 220);
  for (let i = 0; i < st.n; i++) {
    const f = i * 8; if (Math.abs(st.F[f + 3] - k.t) > 0.5) continue;
    const dx = st.F[f] - V[12], dy = st.F[f + 1] - V[13], dz = st.F[f + 2] - V[14];
    // the camera's frame: V's columns are its axes in the session
    const cx = V[0] * dx + V[1] * dy + V[2] * dz, cy = V[4] * dx + V[5] * dy + V[6] * dz, cz = V[8] * dx + V[9] * dy + V[10] * dz;
    const X = P[0] * cx + P[4] * cy + P[8] * cz + P[12], Y = P[1] * cx + P[5] * cy + P[9] * cz + P[13], Wc = P[3] * cx + P[7] * cy + P[11] * cz + P[15];
    if (Wc <= 0) continue;
    const x = ((X / Wc + 1) / 2) * W, y = ((1 - Y / Wc) / 2) * H;
    if (x < 0 || y < 0 || x > W || y > H) continue;
    g.fillStyle = colourOf(i, mode); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
}

/* ------------------------------------------------------------------ 3D */
async function open3d() {
  const el = $('#three'), btn = $('#open-3d'); el.hidden = false; btn.disabled = true; btn.textContent = 'Loading…';
  const THREE = await import('three'); const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
  const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(el.clientWidth, el.clientHeight); el.innerHTML = ''; el.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b0f0d);
  const cam = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 2000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.8)); const sun = new THREE.DirectionalLight(0xffffff, 0.8); sun.position.set(30, 60, 20); scene.add(sun);
  const g = st.J.grid, z0 = g.groundZ;
  // lidar columns (three: x east, y up, z south)
  const cols = []; for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) { const i = r * g.w + c, kd = st.base.kind[i], hh = st.base.height[i] / 10; if (kd && hh > 0.4) cols.push([c, r, kd, hh]); }
  const geo = new THREE.BoxGeometry(g.cell, 1, g.cellY), mat = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.45 });
  const inst = new THREE.InstancedMesh(geo, mat, cols.length), mtx = new THREE.Matrix4(), col = new THREE.Color();
  cols.forEach(([c, r, kd, hh], j) => { const e = g.x0 + (c + 0.5) * g.cell, n = g.y1 - (r + 0.5) * g.cellY; mtx.makeScale(1, hh, 1); mtx.setPosition(e, hh / 2, -n); inst.setMatrixAt(j, mtx); inst.setColorAt(j, col.set(kd === 1 ? 0x3b82f6 : kd === 2 || kd === 3 ? 0x16a34a : 0xf59e0b)); });
  scene.add(inst);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(g.w * g.cell, g.h * g.cellY), new THREE.MeshBasicMaterial({ color: 0x1f2a24 })); ground.rotation.x = -Math.PI / 2; ground.position.set(g.x0 + (g.w * g.cell) / 2, -0.02, -(g.y1 - (g.h * g.cellY) / 2)); scene.add(ground);
  let cloud = null;
  const build = async () => {
    if (cloud) { scene.remove(cloud); cloud.geometry.dispose(); }
    const pos = [], cl = [], mode = $('#colour').value, c3 = new THREE.Color();
    if ($('#mesh').checked && st.hasMesh) {
      const { arrays: A } = await unpackModel(await (await part('mesh.bin')).arrayBuffer());
      const C = [0x94a3b8, 0xef4444, 0xfacc15, 0x64748b];
      for (let i = 0; i < A.e.length; i++) { pos.push(A.e[i], A.z[i] - z0, -A.n[i]); c3.set(C[A.cls[i]] ?? 0x999999); cl.push(c3.r, c3.g, c3.b); }
    } else for (let i = 0; i < st.n; i++) {
      const f = i * 8; if (!inWindow(st.F[f + 3])) continue;
      const [e, n] = placed(i), hh = st.F[f + 6] > -50 ? st.F[f + 6] : 0;
      pos.push(e, hh, -n); c3.setStyle(colourOf(i, mode)); cl.push(c3.r, c3.g, c3.b);
    }
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bg.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
    cloud = new THREE.Points(bg, new THREE.PointsMaterial({ size: 0.12, vertexColors: true })); scene.add(cloud);
    return bg;
  };
  const bg = await build(); bg.computeBoundingSphere();
  const ctr = bg.boundingSphere ? bg.boundingSphere.center : new THREE.Vector3();
  cam.position.set(ctr.x + 25, 30, ctr.z + 25); const controls = new OrbitControls(cam, renderer.domElement); controls.target.copy(ctr); controls.update();
  st.rebuild3d = build;
  const loop = () => { renderer.render(scene, cam); requestAnimationFrame(loop); }; loop();
  addEventListener('resize', () => { renderer.setSize(el.clientWidth, el.clientHeight); cam.aspect = el.clientWidth / el.clientHeight; cam.updateProjectionMatrix(); });
  btn.textContent = 'Opened';
}

/* ------------------------------------------------------------ controls */
function wire() {
  const redraw = () => { draw(); drawPic(); st.rebuild3d?.(); };
  for (const id of ['colour', 'base', 'show-ground', 'show-stand', 'show-credits', 'show-things', 'show-track', 'show-checks', 'show-through', 'window', 'pic-dots']) $(`#${id}`).addEventListener('change', redraw);
  $('#mesh').addEventListener('change', () => st.rebuild3d?.());
  $('#place').addEventListener('change', (e) => { st.T = st.J.placements[+e.target.value].T; draw(); st.rebuild3d?.(); });
  $('#time').addEventListener('input', () => { if (!+$('#window').value) $('#window').value = '10'; draw(); });
  $('#pic-at').addEventListener('input', (e) => showPic(+e.target.value));
  $('#pic-sync').addEventListener('click', () => { const k = st.keys[st.pic]; if (!k) return; $('#time').value = String(Math.round(k.t)); if (!+$('#window').value) $('#window').value = '2'; draw(); $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('#open-3d').addEventListener('click', () => open3d().catch((e) => { $('#open-3d').textContent = `Could not open it (${e.message})`; }));
  const zoom = (f, at = [CW / 2, CW / 2]) => { const v = st.view, s1 = Math.max(0.5, Math.min(40, v.s * f)); v.ox = at[0] - ((at[0] - v.ox) * s1) / v.s; v.oy = at[1] - ((at[1] - v.oy) * s1) / v.s; v.s = s1; draw(); };
  $('#zoom-in').addEventListener('click', () => zoom(1.6)); $('#zoom-out').addEventListener('click', () => zoom(1 / 1.6)); $('#zoom-fit').addEventListener('click', () => { fit(); draw(); });
  const cv = $('#map'), touches = new Map(); let pinch = null, moved = 0;
  const toC = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * CW, ((e.clientY - r.top) / r.height) * CW]; };
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); touches.set(e.pointerId, toC(e)); moved = 0; if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
  cv.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    const p = touches.get(e.pointerId), q = toC(e); touches.set(e.pointerId, q); moved += Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (touches.size === 1) { st.view.ox += q[0] - p[0]; st.view.oy += q[1] - p[1]; draw(); }
    else if (touches.size === 2 && pinch) { const [a, b] = [...touches.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (d > 0) { zoom(d / pinch, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); pinch = d; } }
  });
  const up = (e) => { if (touches.size === 1 && moved < 8) pick(...toC(e)); touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', (e) => { touches.delete(e.pointerId); pinch = null; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8, toC(e)); }, { passive: false });
}

main().catch((e) => { $('#status').textContent = `The inspector could not open this walk: ${e.message}`; });
