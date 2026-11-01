/**
 * THE YARD AR TEST PAGE (core session, docs/SCAN-PLAN.md phase 1).
 *
 * Does the phone's tracking hold on a lawn? One page, two engines
 * (scan/lib/track.js): Chrome's WebXR on Android, the 8th Wall engine on
 * iPhone (and on Android for comparison). A crosshair, a dot where it meets
 * the ground, a pin you can drop and check again after a walk, and a
 * two-tap measure to hold against a tape. The walk's bookkeeping is
 * scan/lib/walk.js; what the owner copies out is distances and counts only.
 *
 * No map is read or written yet: phase 2 lines the session up with the lidar.
 */
import { detect, start, engineChoice, load8thWall } from '/lib/track.js';
import { newWalk, step, dropPin, checkPin, measure, tapeFor, undo, far, summary, AIM_FAR } from '/lib/walk.js';
import { makeDrawer } from '/lib/draw.js';
import { levelDist } from '/lib/frames.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FT = 3.28084;
const ftIn = (m) => { const inch = Math.round(m * FT * 12); return inch < 12 ? `${inch} in` : `${Math.floor(inch / 12)} ft ${inch % 12} in`; };
const ENGINE_URL = '/vendor/xr/xr.js';
const NAME = { webxr: "Chrome's AR (WebXR)", '8thwall': '8th Wall' };
const COLOR = { dot: [0.3, 1, 0.6, 0.9], pin: [0.9, 0.22, 0.2, 0.95], mark: [0.35, 0.6, 1, 0.95] };
const FAR_AGAIN = 3000; // ms: a drop from farther than AIM_FAR takes a second tap within this

const st = { caps: null, has8w: false, walk: null, tracker: null, drawer: null, frame: null, hudAt: 0, farAt: 0, errors: [], map: new URLSearchParams(location.search).get('map') };

/* ------------------------------------------------------------- the page */

async function main() {
  if (st.map) $('#back').href = `${$('#back').getAttribute('href')}?map=${encodeURIComponent(st.map)}`;
  try { st.has8w = (await fetch('/vendor/xr/VERSION', { method: 'HEAD', cache: 'no-store' })).ok; } catch { st.has8w = false; }
  st.caps = await detect({ eightWallUrl: st.has8w ? ENGINE_URL : null });
  const pick = engineChoice({ hasXR: st.caps.webxr, has8w: st.has8w, ios: st.caps.ios });
  const bits = [];
  bits.push(st.caps.ios ? 'An iPhone or iPad.' : 'Not an iPhone.');
  bits.push(st.caps.webxr ? "Chrome's AR is here." : "No WebXR in this browser (none on iPhone; on Android, Chrome with Google Play Services for AR has it).");
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
}

/* --------------------------------------------------------------- the AR */

function flash(text) { const f = $('#flash'); f.textContent = text; f.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => f.classList.remove('show'), 2200); }
const log = (what) => { st.errors.push({ t: Date.now(), what }); if (st.errors.length > 50) st.errors.shift(); };

async function startAR(engine) {
  const overlay = $('#overlay');
  st.walk = newWalk({ engine, phone: navigator.userAgent });
  st.errors = []; st.frame = null; st.drawer = null;
  overlay.hidden = false; document.body.classList.add('in-ar');
  $('#hud').textContent = engine === '8thwall' ? 'Loading the engine… then Safari asks for the camera and the motion sensors.' : 'Starting…';
  const canvas = $('#cam');
  try {
    st.tracker = await start({ engine, overlay, canvas, eightWallUrl: ENGINE_URL, onFrame, onEvent });
    st.walk.features = st.tracker.features;
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
  if (ev.type === 'tracking') log(`tracking ${ev.status} ${ev.reason || ''}`.trim());
  if (ev.type === 'end') finish();
}

function onFrame(f) {
  if (!st.walk) return;
  st.frame = f;
  const warnings = step(st.walk, { t: f.t, pos: f.pose?.position, quat: f.pose?.quaternion, tracking: f.tracking, reset: f.reset, points: f.points });
  for (const w of warnings) {
    if (w === 'lost') flash('Lost its place: look around slowly');
    if (w === 'reset') flash('The tracking jumped');
    if (w === 'fast') flash('Turn slower');
  }
  // draw
  if (f.gl && f.view && f.proj) {
    try {
      if (!st.drawer || st.drawer.gl !== f.gl) st.drawer = { gl: f.gl, d: makeDrawer(f.gl) };
      const items = st.walk.pins.map((p) => ({ kind: 'pin', at: p.at, color: COLOR.pin }));
      if (st.walk.pendingMeasure) items.push({ kind: 'mark', at: st.walk.pendingMeasure.a, color: COLOR.mark });
      if (f.hit) items.push({ kind: 'dot', at: f.hit.position, color: COLOR.dot });
      st.drawer.d.draw({ view: f.view, proj: f.proj, viewport: f.viewport, framebuffer: f.framebuffer, items });
    } catch (e) { if (!st.drawErr) { st.drawErr = true; log(`draw: ${e.message}`); } }
  }
  $('#cross').classList.toggle('hit', !!f.hit);
  if (f.t - st.hudAt > 200) { st.hudAt = f.t; hud(f); }
}

function hud(f) {
  const w = st.walk;
  const tr = f.tracking === 'normal' ? '<span class="ok">tracking</span>' : f.tracking === 'limited' ? '<span class="warn">tracking limited</span>' : '<span class="bad">no tracking yet: move the phone slowly over the ground</span>';
  const aim = f.hit ? `aim ${ftIn(f.hit.distance)}${far(f.hit) ? ' <span class="warn">(far: step closer)</span>' : ''}` : 'no ground under the crosshair';
  const pts = f.points ? ` · ${f.points} pts` : '';
  const last = st.errors.length && Date.now() - st.errors[st.errors.length - 1].t < 6000 && /engine|start/.test(st.errors[st.errors.length - 1].what) ? `<br><span class="bad">${esc(st.errors[st.errors.length - 1].what)}</span>` : '';
  $('#hud').innerHTML = `${NAME[w.engine]} · ${tr} · walked ${Math.round(w.stats.walked * FT)} ft${pts}<br>${aim} · ${w.pins.length} pin${w.pins.length === 1 ? '' : 's'}${w.pendingMeasure ? ' · <span class="warn">now aim at the second mark</span>' : ''}${last}`;
  const can = !!f.hit && f.tracking !== 'lost';
  $('#pin').disabled = !can; $('#measure').disabled = !can; $('#check').disabled = !can || !w.pins.length;
}

const nearestPin = (hit) => {
  let best = null, bd = 6;
  for (const p of st.walk.pins) { const d = levelDist(p.at, hit.position); if (d < bd) { bd = d; best = p; } }
  return best;
};

function wire() {
  $('#pin').addEventListener('click', () => {
    const f = st.frame; if (!f?.hit) return;
    if (far(f.hit) && Date.now() - st.farAt > FAR_AGAIN) { st.farAt = Date.now(); flash(`Aiming from ${ftIn(f.hit.distance)}: step closer, or tap again to drop it anyway`); return; }
    const p = dropPin(st.walk, f.hit);
    flash(`Pin ${p.name} dropped (aimed from ${ftIn(p.aim || 0)})`);
  });
  $('#check').addEventListener('click', () => {
    const f = st.frame; if (!f?.hit || !st.walk.pins.length) return;
    const p = nearestPin(f.hit);
    if (!p) { flash('No pin within 20 ft of the crosshair'); return; }
    const c = checkPin(st.walk, p, f.hit);
    flash(`Pin ${p.name} is ${ftIn(c.offLevelM)} from the spot (${ftIn(c.walkedSinceM)} walked since)`);
  });
  $('#measure').addEventListener('click', () => {
    const f = st.frame; if (!f?.hit) return;
    const m = measure(st.walk, f.hit);
    flash(m ? `Measured ${ftIn(m.m)} (${m.m.toFixed(2)} m)` : 'First mark set: aim at the second and tap Measure');
  });
  $('#undo').addEventListener('click', () => { const u = undo(st.walk); flash(u === 'pin' ? 'Pin removed' : u === 'measure' ? 'First mark cleared' : 'Nothing to undo'); });
  $('#exit').addEventListener('click', () => { if (st.tracker) st.tracker.stop(); else finish(); });
  $('#move').addEventListener('click', () => $('#overlay').classList.toggle('bar-low'));
}

/* ------------------------------------------------------------ results */

const KEY = 'scan-walks';
const kept = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const keep = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-12))); } catch { /* this phone only */ } };

function finish() {
  if (!st.walk) return;
  const w = st.walk;
  w.endedAt = w.endedAt || Date.now();
  st.tracker = null; st.walk = null; st.frame = null; st.drawer = null;
  $('#overlay').hidden = true; document.body.classList.remove('in-ar');
  const s = summary(w, { features: w.features || null, failed: w.failed || null, errors: st.errors.map((e) => e.what).slice(-20) });
  s.id = `${w.startedAt}`;
  // the measures keep their walk-side records so a taped distance typed later can be scored
  const list = kept(); list.push(s); keep(list);
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
    keep(all); renderResults(id);
  }));
}

function walkCard(s, open) {
  const pc = (v) => `${(Math.abs(v) * 100).toFixed(1)}% ${v > 0 ? 'short' : 'long'}`;
  const pins = s.pins.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.aimM != null ? ftIn(p.aimM) : '?'}</td><td>${p.checks.length ? p.checks.map((c) => `<strong>${ftIn(c.offLevelM)}</strong> after ${ftIn(c.walkedSinceM)}`).join('<br>') : '<span class="dim">not checked</span>'}</td></tr>`).join('');
  const measures = s.measures.map((m, i) => `<tr><td>${ftIn(m.metres)} <span class="dim">(${m.metres} m)</span></td><td>tape <input type="number" step="0.1" min="0" inputmode="decimal" data-tape="${esc(s.id)}:${i}" value="${m.tapedM ? (m.tapedM * FT).toFixed(1) : ''}" aria-label="What the tape said, feet"> ft</td><td>${m.shortBy != null ? `<strong>${pc(m.shortBy)}</strong>` : ''}</td></tr>`).join('');
  const x = s.stats;
  return `<details class="card"${open ? ' open' : ''}><summary><strong>${esc(NAME[s.engine] || s.engine)}</strong> · ${new Date(s.when).toLocaleString()} · ${Math.round(s.seconds / 60)} min${s.failed ? ' · <span class="warn">did not start</span>' : ''}</summary>
    ${s.failed ? `<p class="warn">${esc(s.failed)}</p>` : ''}
    <p>Walked ${Math.round(x.walkedM * FT)} ft; lost its place ${x.losses} time${x.losses === 1 ? '' : 's'}; ${x.resets} jump${x.resets === 1 ? '' : 's'}; ${x.fastTurns} fast turn${x.fastTurns === 1 ? '' : 's'}; tracked ${x.trackedShare != null ? Math.round(x.trackedShare * 100) : '?'}% of frames${s.points?.maxAtOnce ? `; up to ${s.points.maxAtOnce} points seen at once` : ''}.</p>
    ${pins ? `<table><tr><th>Pin</th><th>Aimed from</th><th>Off its spot when checked</th></tr>${pins}</table>` : '<p class="dim">No pins.</p>'}
    ${measures ? `<table style="margin-top:8px"><tr><th>Measured</th><th>Tape</th><th>Error</th></tr>${measures}</table>` : ''}
    ${s.errors?.length ? `<details><summary class="dim">Engine messages (${s.errors.length})</summary><pre>${esc(s.errors.join('\n'))}</pre></details>` : ''}
    <div class="tools"><button type="button" data-copy="${esc(s.id)}">Copy results</button><button type="button" class="plain" data-forget="${esc(s.id)}">Forget this walk</button></div>
  </details>`;
}

wire();
main().catch((e) => { $('#status').textContent = `This page could not start: ${e.message}`; });
// warm the engine's download on iPhone so the first Start is quicker (no camera, no sensors until the tap)
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) setTimeout(() => { if (st.has8w) load8thWall(ENGINE_URL).catch(() => {}); }, 1500);
