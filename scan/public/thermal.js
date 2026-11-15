/**
 * DEV ONLY -- THE USB THERMAL CAMERA ON A WALK (core session, 2026-11-15; android/app/src/dev/README.md).
 *
 * The owner: "thermal will not be packaged in the public release app that we eventually release some day. So keep the
 * code neatly marked so that it's not accidentally copied over to the production version." This file is the whole of
 * the thermal camera on the page. app.js loads it only when the app offers window.LawnARThermal (the dev build of
 * the Android app; the store build has no such thing), and tells it of a walk's start and end with a "yard-walk"
 * event; nothing else in the page knows of it.
 *
 * What it does: a small box in the AR view with one short line saying what to do now. The sky scan (10 s: the phone
 * up at the sky, turned slowly once around; the thermal runner maps the sky's dome from it, for the cloud cover)
 * starts by itself when the phone is pointed at the sky. Two optional checks sit under "More". The frames are kept and sent by the app itself
 * (ThermalCamera.kt); nothing is turned into a temperature on the phone.
 */
const T = window.LawnARThermal;
const read = () => { try { return JSON.parse(T.status()); } catch { return null; } };
const mb = (b) => (b / 1e6).toFixed(b < 1e7 ? 1 : 0);

const css = document.createElement('style');
css.textContent = `
  #thermal { position: absolute; left: 8px; top: max(18vh, calc(110px + env(safe-area-inset-top))); max-width: 50vw; z-index: 4;
    background: rgba(0,0,0,.6); border: 1px solid rgba(255,170,80,.7); border-radius: 8px; padding: 6px 8px; font-size: 13px; line-height: 1.3; }
  #thermal b { color: #ffb066; }
  #thermal .bad { color: #ff8a80; }
  #thermal .go { color: #6fe39a; }
  #thermal div.btns { display: flex; gap: 6px; margin-top: 6px; }
  #thermal button { flex: 1; padding: 8px 6px; font-size: 13px; background: rgba(0,0,0,.6); border: 1px solid rgba(255,255,255,.4); color: #fff; border-radius: 6px; }
  #thermal button[disabled] { opacity: .45; }
  #thermal .big { font-size: 17px; font-weight: 600; }
  #thermal .dim { color: #cfd8d3; }
  #thermal #thermal-go { display: block; width: 100%; margin-top: 6px; padding: 10px; font-size: 15px; }
  #thermal #thermal-go[hidden], #thermal #thermal-more[hidden], #thermal a[hidden] { display: none; }
  #thermal a { display: inline-block; margin-top: 4px; color: #ffb066; text-decoration: underline; }
  #thermal #thermal-more button { display: block; width: 100%; margin-top: 8px; }
  #thermal #thermal-more small { display: block; color: #cfd8d3; }
  #thermal-send { position: fixed; left: 8px; bottom: calc(8px + env(safe-area-inset-bottom)); z-index: 6; background: rgba(0,0,0,.75); color: #ffb066;
    border-radius: 8px; padding: 6px 10px; font-size: 13px; }
`;
document.head.append(css);

/* GUIDED, NOT A ROW OF BUTTONS (the owner, 2026-11-15, after the first thermal walk: "the sky sweep instructions were
   incredibly unclear, too wordy... the thermal buttons didn't make sense and have unclear purposes. Make it more
   guided and automatic"). One short line saying what to do now, at most one button, and the sky scan starts by
   itself when the phone is pointed at the sky. The two optional checks sit under "More", each with its purpose. */
const box = document.createElement('div');
box.id = 'thermal';
box.innerHTML = `<div id="thermal-say"></div><button type="button" id="thermal-go" hidden></button>
  <a id="thermal-more-link" hidden>More</a>
  <div id="thermal-more" hidden>
    <button type="button" id="thermal-sky2">Sky scan again</button><small>At the end of the walk: shows if the clouds changed.</small>
    <button type="button" id="thermal-sweep">Timing check</button><small>5 s: wave the phone past something hot (a mug). Once is enough, ever.</small>
    <button type="button" id="thermal-angle">Angle check</button><small>Keep one sunny patch in view and walk up to it from 25 ft.</small>
  </div>`;
document.querySelector('#overlay')?.append(box);
const send = document.createElement('div');
send.id = 'thermal-send'; send.hidden = true;
document.body.append(send);
const $ = (q) => box.querySelector(q);

const walk = { id: null, on: false, sky: [], sweeps: 0, angle: false, angles: 0, note: '', noteUntil: 0, upFor: 0, doneAt: 0, more: false };
const say = (text, ms = 5000) => { walk.note = text; walk.noteUntil = Date.now() + ms; render(); };
const SKY_AUTO_DEG = 30;   // the sky scan starts by itself with the phone this near straight up (a roof corner is aimed at lower)

function startSky() {
  const label = walk.sky.length ? 'end' : 'start';
  if (!T.skyShot(label)) return false;
  walk.sky.push(label); walk.upFor = 0;
  return true;
}

function render() {
  const s = read();
  if (!s) return;
  const inWalk = !document.querySelector('#overlay')?.hidden;
  if (inWalk) {
    let text = '', go = null;
    const rec = s.state === 'ready' && !!s.walk;
    if (s.state === 'none') text = s.present ? 'Tap to connect the camera' : 'No camera plugged in';
    else if (s.state === 'asking') text = 'Allow the USB camera';
    else if (s.state === 'setup' || s.state === 'settling') text = `Warming up${s.state === 'settling' ? `: ${s.secs} s` : '…'}`;
    else if (s.state === 'failed' || s.state === 'unplugged') text = `<span class="bad">${s.state === 'unplugged' ? 'Camera unplugged: plug it back in' : 'Camera setup failed: unplug it and plug it back in'}</span>`;
    else if (s.busy === 'sky') text = s.skyLeftS > 0 ? `<span class="go big">Turn around slowly · ${s.skyLeftS}</span>` : '<span class="go big">Keep pointing at the sky…</span>';
    else if (s.busy === 'sweep') text = '<span class="go big">Wave it past the hot thing · 5 s</span>';
    else if (walk.angle) { text = '<span class="go">Angle check: keep the patch in view, walk up to it</span>'; go = 'Done'; }
    else if (!rec) text = walk.on ? '<span class="bad">Not recording this walk</span>' : 'Ready';
    else if (!walk.sky.length) {
      // the first thing on a thermal walk: the sky scan, started by pointing the phone at the sky
      text = s.busy === 'reference' ? 'One moment…' : '<span class="go big">Point the phone at the sky</span><br><span class="dim">Open sky, away from trees and the roof. It starts by itself.</span>';
      if (!s.busy && s.upDeg != null && s.upDeg <= SKY_AUTO_DEG) { if (++walk.upFor >= 2) startSky(); } else walk.upFor = 0;
    } else if (Date.now() - walk.doneAt < 4000) text = '<span class="go big">Sky scan done ✓</span>';
    else text = `Recording ✓ <span class="dim">${s.kept} frames</span><br><span class="dim">Aim at the grass ahead, sweep side to side.</span>`;
    if (walk.note && Date.now() < walk.noteUntil) text += `<br>${walk.note}`;
    // the moment a sky scan ends
    if (walk.wasSky && s.busy !== 'sky') walk.doneAt = Date.now();
    walk.wasSky = s.busy === 'sky';
    $('#thermal-say').innerHTML = `<b>Thermal</b> ${text}`;
    const g = $('#thermal-go'); g.hidden = !go; if (go) g.textContent = go;
    const canMore = rec && walk.sky.length > 0 && !s.busy && !walk.angle;
    $('#thermal-more-link').hidden = !canMore;
    $('#thermal-more-link').textContent = walk.more ? 'Less' : 'More';
    $('#thermal-more').hidden = !(canMore && walk.more);
    $('#thermal-angle').disabled = typeof T.mark !== 'function';
    // a walk that began before the camera was ready: its file starts as soon as there is a camera
    if (walk.on && !s.walk && s.state !== 'none' && s.state !== 'asking') { try { T.startWalk(walk.id); } catch { /* next time */ } }
  }
  const u = s.upload || {};
  const left = u.waiting || 0;
  send.hidden = true;   // the page's one upload box (app.js renderUploads) says it now
  void left;
}

$('#thermal-say').addEventListener('click', () => { const s = read(); if (s && (s.state === 'none' || s.state === 'failed')) { try { T.connect(); } catch { /* gone */ } render(); } });
$('#thermal-more-link').addEventListener('click', () => { walk.more = !walk.more; render(); });
$('#thermal-sky2').addEventListener('click', () => {
  const s = read();
  walk.more = false;
  if (!s || s.upDeg == null || s.upDeg > 65) { say('Point the phone at the sky first, then tap again.'); return; }
  if (!startSky()) say('One moment, then try again.');
  render();
});
$('#thermal-sweep').addEventListener('click', () => {
  walk.more = false;
  if (T.sweep()) walk.sweeps++; else say('One moment, then try again.');
  render();
});
$('#thermal-go').addEventListener('click', () => {
  if (walk.angle) { try { T.mark('angle-end'); } catch { /* gone */ } walk.angle = false; say('Angle check kept ✓'); }
});

/* WHERE THE WALK SITS ON THE MAP, for the thermal session's runner (its answer of 2026-11-15: "the per-second table
   is what I want"): once a second, the page's level fit in effect and the ground's height, by ARCore's own frame
   time; at the walk's end, with the lidar's ground grid and the lawn's outline in the same metres, as the twin part
   thermal-placement.json (private bucket). The shape is in android/app/src/dev/README.md. */
const place = { ask: null, send: null, samples: [], timer: null };
const r4 = (v) => (Number.isFinite(v) ? +v.toFixed(4) : null);
function samplePlace() {
  const p = place.ask?.();
  if (!p || !Number.isFinite(p.t)) return;
  place.samples.push({ ar_ns: Math.round(p.t * 1e6), theta: +p.theta.toFixed(6), tx: r4(p.tx), ty: r4(p.ty), s: +p.s.toFixed(6), groundY: r4(p.groundY), dy: r4(p.dy), dyFrom: p.dyFrom, by: p.by, odo: r4(p.odo), tracking: !!p.tracking });
}
function sendPlace(d) {
  if (!place.send || !place.samples.length) return 0;
  const g = d.ground;
  place.send('thermal-placement.json', JSON.stringify({
    format: 1, walk: String(d.walk), map: d.map,
    // only for the weather: rounded to a tenth of a degree
    coarse: d.origin ? { lng: +d.origin[0].toFixed(1), lat: +d.origin[1].toFixed(1) } : null,
    // the map's own point, what east and north are measured from: for the site to hand the water map the walk's
    // frame (private bucket only; the thermal runner does not use it)
    origin: d.origin || null,
    samples: place.samples,
    ground: g ? { e0: r4(g.box[0]), n1: r4(g.box[3]), cell: g.cell, W: g.W, H: g.H, h: Array.from(g.data, (v) => (Number.isFinite(v) ? +v.toFixed(2) : null)) } : null,
    outline: { rings: (d.lawn || []).map((ring) => ring.map(([e, n]) => [r4(e), r4(n)])) },
  }));
  return place.samples.length;
}

/* THE ANGLE CHECK the water session asked for (2026-11-15; optional, one minute, best on an afternoon walk): on open,
   sunny lawn, keep the camera on one patch while walking toward it from about 25 ft until standing over it. */
$('#thermal-angle').addEventListener('click', () => {
  walk.more = false;
  if (!T.mark('angle-start')) { say('Not recording.'); return; }
  walk.angle = true; walk.angles++;
  render();
});

document.addEventListener('yard-walk', (e) => {
  const d = e.detail || {};
  if (d.phase === 'start' && !d.replay) {
    place.ask = d.placement || null; place.send = d.send || null; place.samples = [];
    clearInterval(place.timer); place.timer = setInterval(samplePlace, 1000);
    walk.id = String(d.walk); walk.on = true; walk.sky = []; walk.sweeps = 0; walk.angle = false; walk.angles = 0; walk.note = ''; walk.upFor = 0; walk.doneAt = 0; walk.more = false; walk.wasSky = false;
    try { T.connect(); T.startWalk(walk.id); } catch { /* no camera: the walk goes on without it */ }
  } else if (d.phase === 'end' && walk.on) {
    const s = read();
    if (walk.angle) { try { T.mark('angle-end'); } catch { /* gone */ } walk.angle = false; }
    walk.on = false;
    try { T.endWalk(); } catch { /* gone */ }
    // counts only, for the walk's summary
    clearInterval(place.timer); samplePlace();
    const placed = s?.walk ? sendPlace(d) : 0;
    if (s?.walk && d.add) d.add.thermal = { placed, frames: s.kept, poses: s.poses, dropped: s.dropped, mb: +mb(s.bytes), references: s.refs, setup: s.setup, sky: walk.sky, sweeps: walk.sweeps, angleChecks: walk.angles };
  }
  render();
});

/* THE WALKER'S OWN NOTES, asked for by the water session (2026-11-15) for each thermal walk: the air temperature
   from a thermometer in the shade at chest height at the start and the end (not the phone's own sensor, which runs
   hot), whether the grass was wet, whether sprinklers ran in the last 3 days, and the cloud. Asked when the walk
   ends; kept on this phone until the site has them, as the walk's twin part thermal-notes.json. */
const NOTES = 'yard-ar-thermal-notes';
const waitingNotes = () => { try { return JSON.parse(localStorage.getItem(NOTES) || '[]'); } catch { return []; } };
const keepNotes = (list) => { try { localStorage.setItem(NOTES, JSON.stringify(list.slice(-8))); } catch { /* this phone only */ } };
async function sendNotes() {
  for (const n of waitingNotes()) {
    try {
      const res = await fetch(`/api/scan/twin?walk=${encodeURIComponent(n.walk)}&part=thermal-notes.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n), credentials: 'same-origin' });
      if (res.ok || (res.status >= 400 && res.status < 500 && ![401, 403, 404, 408, 429].includes(res.status))) keepNotes(waitingNotes().filter((x) => x.walk !== n.walk));
    } catch { /* no signal: next time */ }
  }
}
function askNotes(id, started) {
  document.querySelector('#thermal-notes')?.remove();
  const f = document.createElement('form');
  f.id = 'thermal-notes';
  f.style.cssText = 'position:fixed;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:7;background:#1c2420;border:1px solid rgba(255,170,80,.7);border-radius:10px;padding:12px;font-size:15px;line-height:1.5;color:#fff';
  f.innerHTML = `<strong style="color:#ffb066">Thermal walk: a few notes</strong><br>
    <span style="font-size:13px;color:#cfd8d3">Air temperature from a thermometer in the shade at chest height (not the phone).</span><br>
    <label>At the start <input name="a0" inputmode="decimal" size="5"></label> <label>at the end <input name="a1" inputmode="decimal" size="5"></label>
    <select name="unit"><option value="F">°F</option><option value="C">°C</option></select><br>
    <label><input type="checkbox" name="wet"> The grass was wet (dew, rain, sprinklers)</label><br>
    <label><input type="checkbox" name="spr"> Sprinklers ran in the last 3 days</label><br>
    <label>Sky (optional: the sky sweep measures it) <select name="cloud"><option value="">?</option><option>clear</option><option>broken</option><option>overcast</option></select></label><br>
    <button type="submit" style="margin-top:8px;padding:10px 16px">Save</button> <button type="button" name="skip" style="margin-top:8px;padding:10px 16px">Skip</button>`;
  document.body.append(f);
  const toC = (v, unit) => { const x = parseFloat(v); return Number.isFinite(x) ? +(unit === 'F' ? (x - 32) / 1.8 : x).toFixed(1) : null; };
  f.elements.skip.addEventListener('click', () => f.remove());
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const unit = f.elements.unit.value, now = Date.now();
    const air = [[f.elements.a0.value, started], [f.elements.a1.value, now]].map(([v, at]) => ({ T: toC(v, unit), at })).filter((x) => x.T != null);
    keepNotes([...waitingNotes().filter((x) => x.walk !== id), { walk: id, air, entered: { a0: f.elements.a0.value, a1: f.elements.a1.value, unit }, wet: f.elements.wet.checked, sprinklers: f.elements.spr.checked, cloud: f.elements.cloud.value || null, savedAt: now }]);
    f.remove();
    sendNotes();
  });
}
document.addEventListener('yard-walk', (e) => {
  const d = e.detail || {};
  if (d.phase === 'end' && d.add?.thermal) askNotes(String(d.walk), Number(d.walk) || Date.now());
});
sendNotes();

setInterval(render, 500);
render();
