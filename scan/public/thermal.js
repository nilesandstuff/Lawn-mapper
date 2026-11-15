/**
 * DEV ONLY -- THE USB THERMAL CAMERA ON A WALK (core session, 2026-11-15; android/app/src/dev/README.md).
 *
 * The owner: "thermal will not be packaged in the public release app that we eventually release some day. So keep the
 * code neatly marked so that it's not accidentally copied over to the production version." This file is the whole of
 * the thermal camera on the page. app.js loads it only when the app offers window.LawnARThermal (the dev build of
 * the Android app; the store build has no such thing), and tells it of a walk's start and end with a "yard-walk"
 * event; nothing else in the page knows of it.
 *
 * What it does: a small box in the AR view saying what the camera is doing (setting up, settling, ready, taking its
 * shutter reference), a Sky shot button (the phone straight up at open sky for 2 s, at the walk's start and end) and
 * a Sweep button (5 s past something hot, for the timing). The frames are kept and sent by the app itself
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
  #thermal-send { position: fixed; left: 8px; bottom: calc(8px + env(safe-area-inset-bottom)); z-index: 6; background: rgba(0,0,0,.75); color: #ffb066;
    border-radius: 8px; padding: 6px 10px; font-size: 13px; }
`;
document.head.append(css);

const box = document.createElement('div');
box.id = 'thermal';
box.innerHTML = '<span id="thermal-say"></span><div class="btns"><button type="button" id="thermal-sky">Sky shot</button><button type="button" id="thermal-sweep">Sweep</button></div>';
document.querySelector('#overlay')?.append(box);
const send = document.createElement('div');
send.id = 'thermal-send'; send.hidden = true;
document.body.append(send);
const $ = (q) => box.querySelector(q);

const walk = { id: null, on: false, sky: [], sweeps: 0, note: '', noteUntil: 0 };
const say = (text, ms = 6000) => { walk.note = text; walk.noteUntil = Date.now() + ms; render(); };

function render() {
  const s = read();
  if (!s) return;
  const inWalk = !document.querySelector('#overlay')?.hidden;
  if (inWalk) {
    let text;
    if (s.state === 'none') text = s.present ? 'camera found: tap to connect' : 'no camera plugged in';
    else if (s.state === 'asking') text = s.detail;
    else if (s.state === 'setup') text = `setting up: ${s.detail}…`;
    else if (s.state === 'settling') text = `settling, ${s.secs} s`;
    else if (s.state === 'failed' || s.state === 'unplugged') text = `<span class="bad">${s.detail}</span>`;
    else if (s.busy === 'sky') text = '<span class="go">SKY SHOT: hold it pointing straight up</span>';
    else if (s.busy === 'sweep') text = '<span class="go">SWEEP: 5 s, left and right past the hot thing</span>';
    else if (s.busy === 'reference') text = 'shutter reference…';
    else text = `ready${s.walk ? ` · ${s.kept} frames${s.dropped ? ` (${s.dropped} lost)` : ''} · ${mb(s.bytes)} MB` : ''}${s.refAgoS != null ? ` · reference ${s.refAgoS} s ago` : ''}`;
    if (s.state === 'ready' && walk.on && !s.walk) text += ' <span class="bad">· NOT recording this walk</span>';
    if (s.state === 'ready' && s.walk && !walk.sky.length && !s.busy) text += '<br><span class="go">Take the sky shot first.</span>';
    if (walk.note && Date.now() < walk.noteUntil) text += `<br>${walk.note}`;
    $('#thermal-say').innerHTML = `<b>Thermal</b> ${text}`;
    const can = s.state === 'ready' && !s.busy && !!s.walk;
    $('#thermal-sky').disabled = !can; $('#thermal-sweep').disabled = !can;
    $('#thermal-sky').textContent = walk.sky.length ? 'Sky shot (end)' : 'Sky shot';
    // a walk that began before the camera was ready: its file starts as soon as there is a camera
    if (walk.on && !s.walk && s.state !== 'none' && s.state !== 'asking') { try { T.startWalk(walk.id); } catch { /* next time */ } }
  }
  const u = s.upload || {};
  const left = u.waiting || 0;
  send.hidden = !left && !u.error;
  if (!send.hidden) send.textContent = u.sending ? `Thermal file: ${mb(u.sending.sent)} of ${mb(u.sending.total)} MB sent` : u.error ? `Thermal file not sent yet (${String(u.error).slice(0, 60)}); tap to try again` : `Thermal file waiting (${mb(u.bytes || 0)} MB)`;
}

$('#thermal-say').addEventListener('click', () => { const s = read(); if (s && (s.state === 'none' || s.state === 'failed')) { try { T.connect(); } catch { /* gone */ } render(); } });
send.addEventListener('click', () => { try { T.sendWaiting(); } catch { /* gone */ } });
$('#thermal-sky').addEventListener('click', () => {
  const s = read();
  if (!s) return;
  if (s.upDeg == null) { say('The sky shot needs the AR running, to know which way is up.'); return; }
  if (s.upDeg > 20) { say(`Point the phone's camera straight up (now ${s.upDeg}° off), at open sky: no trees, roof edge or your own head in view. Then tap again and hold still.`, 9000); return; }
  const label = walk.sky.length ? 'end' : 'start';
  if (T.skyShot(label)) { walk.sky.push(label); say('Hold it there: a shutter reference, then 2 s of sky.', 8000); } else say('Not now: the camera is busy. Try again in a moment.');
});
$('#thermal-sweep').addEventListener('click', () => {
  if (T.sweep()) { walk.sweeps++; say('Sweep the view left and right across something hot (a mug about 3 ft away), 3 or 4 times.', 6000); } else say('Not now: the camera is busy.');
});

document.addEventListener('yard-walk', (e) => {
  const d = e.detail || {};
  if (d.phase === 'start' && !d.replay) {
    walk.id = String(d.walk); walk.on = true; walk.sky = []; walk.sweeps = 0; walk.note = '';
    try { T.connect(); T.startWalk(walk.id); } catch { /* no camera: the walk goes on without it */ }
  } else if (d.phase === 'end' && walk.on) {
    const s = read();
    walk.on = false;
    try { T.endWalk(); } catch { /* gone */ }
    // counts only, for the walk's summary
    if (s?.walk && d.add) d.add.thermal = { frames: s.kept, poses: s.poses, dropped: s.dropped, mb: +mb(s.bytes), references: s.refs, setup: s.setup, sky: walk.sky, sweeps: walk.sweeps };
  }
  render();
});

setInterval(render, 1000);
render();
