/**
 * The light-readings admin page (/shade-log.html): the address Sensor Logger
 * posts to, uploading an export by hand, and the recordings split into
 * visits, each opened on the shade map to compare (shade/truth-ui.js).
 * Admin only: the routes refuse everybody else with a 404.
 */

import { unzipText, fromExport, posePerSecond, joinTrack, splitVisits, usable, sunOrShade, compassOffset } from './truth.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

async function getJson(url, init) {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function showKey(rotate = false) {
  const k = await getJson('/api/shade/readings/key', rotate ? { method: 'POST' } : undefined);
  $('#push-url').textContent = k.url;
  $('#key-note').textContent = rotate ? 'New address made; the old one no longer works.' : '';
}

/* ------------------------------------------------------------- upload */

async function upload(files) {
  const say = (t, cls = 'dim') => { $('#upload-status').textContent = t; $('#upload-status').className = cls; };
  try {
    const texts = {};
    let name = '';
    for (const f of files) {
      name = name || f.name.replace(/\.(zip|csv)$/i, '');
      if (/\.zip$/i.test(f.name)) Object.assign(texts, await unzipText(await f.arrayBuffer()));
      else texts[f.name] = await f.text();
    }
    const got = fromExport(texts);
    got.orient = posePerSecond(got.orient); // up to 100 a second in the file
    if (!got.fix.length || !got.lux.length) {
      say(`That file has ${got.fix.length} location and ${got.lux.length} light readings; both are needed. Files seen: ${Object.keys(texts).join(', ') || 'none'}.`, 'bad');
      return;
    }
    const session = `upload ${name}`;
    const CHUNK = 2000;
    const total = Math.max(got.fix.length, got.lux.length, got.orient.length);
    for (let i = 0; i < total; i += CHUNK) {
      say(`Uploading… ${Math.min(100, Math.round((100 * i) / total))}%`);
      await getJson('/api/shade/readings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, fix: got.fix.slice(i, i + CHUNK), lux: got.lux.slice(i, i + CHUNK), orient: got.orient.slice(i, i + CHUNK) }),
      });
    }
    say(`Uploaded ${got.fix.length.toLocaleString()} locations, ${got.lux.length.toLocaleString()} light readings and ${got.orient.length ? `${got.orient.length.toLocaleString()} seconds of orientation` : 'no orientation'} as "${session}".`, 'ok');
    loadSessions();
  } catch (e) {
    say(`The upload failed: ${e.message}`, 'bad');
  }
}

/* --------------------------------------------------------- recordings */

async function loadSessions() {
  const box = $('#sessions');
  try {
    const { sessions } = await getJson('/api/shade/readings/sessions');
    if (!sessions.length) { box.innerHTML = '<p class="dim">Nothing recorded yet.</p>'; return; }
    box.replaceChildren(...sessions.map((s) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="top"><b>${esc(day(s.first))}</b><span class="dim">${esc(clock(s.first))} – ${esc(clock(s.last))} · ${s.fixes.toLocaleString()} fixes · ${s.lux.toLocaleString()} s of light</span></div>
        <div class="row"><button type="button">Show visits</button><span class="dim small">${esc(s.session)}</span></div><div class="visits"></div>`;
      card.querySelector('button').onclick = () => showVisits(s.session, card.querySelector('.visits'));
      return card;
    }));
  } catch (e) {
    box.innerHTML = `<p class="bad">The recordings could not be read (${esc(e.message)}).</p>`;
  }
}

async function showVisits(session, box) {
  box.innerHTML = '<p class="dim">Splitting into visits…</p>';
  const d = await getJson(`/api/shade/readings/data?session=${encodeURIComponent(session)}`);
  const track = joinTrack(d.fix, d.lux, { cuts: d.cuts.map(([a, b]) => [a, b]), orient: d.orient || [] });
  const luxSeconds = new Set(d.lux.map(([t]) => Math.floor(t / 1000)));
  /* GPS runs on when the phone puts the light sensor to sleep, so the
     fixes, not the joined track, say how long the visit really was. */
  const fixAt = d.fix.map((f) => f[0]);
  const visits = splitVisits(track).map((v) => ({ v, u: usable(v) })).filter(({ u }) => u.length >= 20);
  if (!visits.length) { box.innerHTML = '<p class="dim">No visit with enough usable readings (moving, under sprayer speed, a good fix, the phone flat).</p>'; return; }
  /* How the phone sits on the hopper, from the whole day's straight runs:
     it stays taped all day, so one fit serves every visit. */
  const mount = compassOffset(visits.flatMap(({ u }) => u));
  box.replaceChildren(...visits.map(({ v, u }, i) => {
    const so = sunOrShade(u.map((s) => s.lux));
    const lat = u.reduce((a, s) => a + s.lat, 0) / u.length, lng = u.reduce((a, s) => a + s.lng, 0) / u.length;
    const t0 = v[0].t, t1 = v[v.length - 1].t;
    const secs = new Set(fixAt.filter((t) => t >= t0 && t <= t1).map((t) => Math.floor(t / 1000)));
    let lit = 0;
    for (const s of secs) if (luxSeconds.has(s) || luxSeconds.has(s - 1) || luxSeconds.has(s + 1)) lit++;
    const cover = secs.size ? lit / secs.size : 1;
    const row = document.createElement('div');
    row.className = 'visit';
    const sky = so.clear ? `<span class="ok">sun and shade ${Math.round(so.contrast)}× apart</span>` : '<span class="warn">no clear sun (cloudy?)</span>';
    const gap = cover < 0.8 ? `<br><span class="warn">The light sensor slept through ${Math.round(100 * (1 - cover))}% of this visit (see step 1, the battery settings).</span>` : '';
    const spec = [session, t0, t1, ...(mount ? [Math.round(mount.offset), mount.n, Math.round(mount.spread)] : [])].join('|');
    /* The whole track's box, so the shade page models every lot it crossed
       (neighbors treated as one, a street of stops), not only the one at
       its middle. */
    const lats = u.map((x) => x.lat), lngs = u.map((x) => x.lng);
    const area = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)].map((v) => v.toFixed(5)).join(',');
    const href = `/shade.html?at=${lat.toFixed(6)},${lng.toFixed(6)}&truth=${encodeURIComponent(spec)}&area=${area}`;
    row.innerHTML = `<div><b>Visit ${i + 1}</b> <span class="dim">${esc(clock(t0))}–${esc(clock(t1))}, ${u.length} usable readings</span><br>${sky}${gap}</div>
      <a class="button" href="${href}">Check on the shade map</a>`;
    return row;
  }));
}

/* --------------------------------------------------------------- main */

async function main() {
  let me = null;
  try { me = (await getJson('/api/auth/me')).user; } catch { /* signed out */ }
  if (!me?.admin) {
    $('#who').innerHTML = 'This page is for the site\'s admins. <a href="/">Sign in</a> as one and come back.';
    return;
  }
  $('#who').textContent = `Signed in as ${me.email || me.name || 'admin'}.`;
  $('#admin').hidden = false;
  showKey().catch((e) => { $('#push-url').textContent = `Could not get the address (${e.message}).`; });
  $('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#push-url').textContent); $('#key-note').textContent = 'Copied.'; } catch { $('#key-note').textContent = 'Copy it by hand: press and hold the address.'; }
  };
  $('#rotate').onclick = () => { if (confirm('Make a new address? The phone will need the new one; the old one stops working.')) showKey(true); };
  $('#file').onchange = () => { if ($('#file').files.length) upload([...$('#file').files]); };
  loadSessions();
}

main();
