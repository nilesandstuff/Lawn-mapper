/**
 * The page a shared link opens (route session, 2026-11-06): /s/<id>, or
 * /s/<id>?p=2 for the second person. A LIVE day (lib/live.js, src/share.js):
 *
 *   - ticks are shared: anyone's tick shows on every phone (checked every
 *     25 seconds while the page is open, and whenever it comes back to it)
 *   - "Help with this route": a helper -- who need have nothing else loaded --
 *     gives a name, Now or the time they'll be free, and where from; every
 *     stop not yet done is shared out again (split.js rebalance) so everyone
 *     gets back at about the same time; the stop someone is on stays theirs
 *   - "I'm free to help now" for someone already on the day who has finished,
 *     or a helper who said a time and is here early or late
 *   - "Your list changed" when a re-split moved your stops
 *   - optional, while the page is open: near a stop for a while and then
 *     leaving it, "Done at ...?" -- a question, never a tick by itself
 *
 * A re-split is worked out on the phone that asks for it, from drive times
 * kept on the phone (lib/cache.js) or fetched through the Worker, and saved
 * only over the version it read: if anything changed meanwhile, it starts
 * again from the new one.
 */

import { COLORS, drawLive, liveCard, liveTotals, thin } from './people.js';
import { applySplit, describe, problem, problemPoints, standing } from './lib/live.js';
import { rebalance } from './lib/split.js';
import { elementsOf, fill, fromCache, MAX_PAIRS, prune, remember, toFetch } from './lib/cache.js';
import { RIDE_DEFAULTS, rideAdjust } from './lib/ride.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const id = location.pathname.match(/^\/s\/([A-Za-z0-9]{8,20})/)?.[1];
const store = {
  get(k, d, scope = `share.${id}.`) { try { const v = localStorage.getItem(`route.${scope}${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v, scope = `share.${id}.`) { try { localStorage.setItem(`route.${scope}${k}`, JSON.stringify(v)); } catch { /* fine */ } },
};

let doc = null;
let map = null;
let only = null;
let me = store.get('me', null);
let busy = false;

function say(text, bad = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  if (text) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function call(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `The server said ${res.status}`), { status: res.status, body });
  return body;
}

/* ------------------------------------------------------------ showing it */
const meIndex = () => (doc ? doc.people.findIndex((p) => p.id === me) : -1);

function render() {
  const n = doc.people.length;
  const now = Date.now();
  const working = doc.people.map((_, k) => liveTotals(doc, k, now)).filter((t) => t.back);
  const latest = working.length ? Math.max(...working.map((t) => t.back)) : null;
  const left = Object.values(doc.stops).filter((s) => !s.done).length;
  $('#title').textContent = n > 1 ? `Route shared by ${n}` : `${doc.people[0].name}'s route`;
  document.title = $('#title').textContent;
  $('#sub').textContent = left
    ? `${left} stop${left === 1 ? '' : 's'} to go${latest ? `, everyone back about ${clock(latest)}` : ''}. Ends at the shop.`
    : 'Every stop is done.';

  // who am I, and what can I do
  const mi = meIndex();
  const mine = mi >= 0 ? liveTotals(doc, mi, now) : null;
  $('#helpCard').hidden = mi >= 0;
  $('#meCard').hidden = mi < 0;
  if (mi >= 0) {
    const p = doc.people[mi];
    $('#freeNow').textContent = p.readyAt && p.readyAt > now ? "I'm here now: share out the stops" : mine.todo.length ? 'Share out the stops again' : "I'm free to help now";
  }
  $('#nameRow').hidden = false;

  // whose route to show
  $('#whoCard').hidden = n < 2 && mi >= 0;
  $('#who').innerHTML = `<button type="button" data-k="all">Everyone</button>${doc.people.map((p, k) => `<button type="button" data-k="${k}">${esc(p.name)}${p.id === me ? ' (you)' : ''}</button>`).join('')}`;
  for (const b of document.querySelectorAll('#who button')) b.setAttribute('aria-pressed', String(only == null ? b.dataset.k === 'all' : String(only) === b.dataset.k));
  $('#whoHint').textContent = mi < 0 ? 'Which one is you? Open your own route and tap "This is me", or help with the form above.' : '';

  // what happened
  const ev = (doc.events || []).slice(-6).reverse();
  $('#eventsCard').hidden = !ev.length && n < 2;
  $('#events').innerHTML = ev.map((e) => `<li><b>${clock(e.at)}</b> ${esc(e.text)}</li>`).join('') || '<li>Nothing yet: ticks and helpers show here.</li>';
  $('#updated').textContent = `checked ${clock(now)}`;

  // the people: me first
  const order = doc.people.map((_, k) => k).filter((k) => only == null || k === only);
  if (mi >= 0 && only == null) order.sort((a, b) => (a === mi ? -1 : b === mi ? 1 : 0));
  $('#people').innerHTML = order.map((k) => liveCard(doc, k, { me, open: only != null || k === mi || n <= 2, now })
    .replace('</summary>', `</summary>${mi < 0 && only === k ? `<div class="row-btns"><button type="button" class="btn small" data-me="${esc(doc.people[k].id)}">This is me</button></div>` : ''}`)).join('');
  if (window.L) { $('#mapCard').hidden = false; map = drawLive(window.L, 'map', doc, only, map); }
  noticeChanges();
}

/** "Your list changed" when someone else's re-split moved my stops. */
function noticeChanges() {
  const mi = meIndex();
  if (mi < 0) return;
  const todo = standing(doc)[mi].todo;
  const seen = store.get('seenTodo', null);
  store.set('seenTodo', todo);
  if (!seen) return;
  const gained = todo.filter((s) => !seen.includes(s) && !doc.stops[s].done);
  const lost = seen.filter((s) => !todo.includes(s) && !doc.stops[s]?.done);
  if (!gained.length && !lost.length) return;
  const b = $('#changed');
  b.hidden = false;
  b.innerHTML = `<b>Your list changed at ${clock(Date.now())}.</b> ${gained.length ? `${gained.length} stop${gained.length === 1 ? '' : 's'} added` : ''}${gained.length && lost.length ? ', ' : ''}${lost.length ? `${lost.length} taken by someone else` : ''}. Your next stop: ${todo[0] ? esc(doc.stops[todo[0]].address) : 'back to the shop'}.<br><button type="button" class="btn small" id="changedOk">OK</button>`;
  $('#changedOk').onclick = () => { b.hidden = true; };
  if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
}

/* ------------------------------------------------------------ keeping up */
async function refresh() {
  if (!id || busy) return;
  try {
    const next = await call(`/api/share/${id}`);
    if (!doc || next.version !== doc.version) { doc = next; render(); } else $('#updated').textContent = `checked ${clock(Date.now())}`;
  } catch (e) {
    if (!doc) $('#sub').textContent = e.message;
  }
}
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 25000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

/* ------------------------------------------------------------ ticks */
$('#people').addEventListener('click', async (e) => {
  const meBtn = e.target.closest('[data-me]');
  if (meBtn) { me = meBtn.dataset.me; store.set('me', me); store.set('seenTodo', null); render(); pushFollowMe(); return; }
  const li = e.target.closest('li[data-stop]');
  if (!li || !e.target.closest('.body')) return;
  const sid = li.dataset.stop;
  const done = !doc.stops[sid].done;
  li.classList.toggle('done', done);
  try {
    doc = await call(`/api/share/${id}/tick`, { method: 'POST', body: JSON.stringify({ stop: sid, done, by: myName() }) });
    render();
  } catch (err) {
    li.classList.toggle('done', !done);
    say(`Could not save that tick: ${err.message}`, true);
  }
});

$('#who').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  only = b.dataset.k === 'all' ? null : Number(b.dataset.k);
  const p = new URLSearchParams(location.search);
  if (only == null) p.delete('p'); else p.set('p', String(only + 1));
  history.replaceState(null, '', `${location.pathname}${p.toString() ? `?${p}` : ''}`);
  render();
});

/* ------------------------------------------------------------ helping: the re-split */
const myName = () => store.get('name', '', 'share.') || (meIndex() >= 0 ? doc.people[meIndex()].name : '');

let when = 'now';
let from = 'here';
for (const b of document.querySelectorAll('[data-when]')) b.addEventListener('click', () => { when = b.dataset.when; seg('[data-when]', when, 'when'); $('#helpTime').hidden = when !== 'later'; });
for (const b of document.querySelectorAll('[data-from]')) b.addEventListener('click', () => { from = b.dataset.from; seg('[data-from]', from, 'from'); $('#helpAddress').hidden = from !== 'address'; });
function seg(sel, v, key) { for (const b of document.querySelectorAll(sel)) b.setAttribute('aria-pressed', String(b.dataset[key] === v)); }

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('This phone cannot share its location here. Use an address.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lng: p.coords.longitude, lat: p.coords.latitude, label: 'Where I was' }),
      () => reject(new Error('Could not get your location. Allow it, or use an address.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

/** "14:30" today (or tomorrow, if that has passed by more than an hour) as a time. */
function timeToday(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  return t.getTime();
}

const drives = store.get('drives', {}, '');
function saveDrives() {
  let max = MAX_PAIRS;
  for (let k = 0; k < 5; k += 1) {
    prune(drives, { max });
    try { localStorage.setItem('route.drives', JSON.stringify(drives)); return; } catch { /* full */ }
    max = Math.floor(Object.keys(drives).length / 2);
  }
}

/** Every drive between the points: this phone's cache, the rest from Mapbox through the Worker. */
async function driveTables(points) {
  const keep = points.map((p) => !String(p.key).startsWith('at:'));
  const t = fromCache(drives, points, { keep });
  const asks = toFetch(t.durations);
  for (const q of asks) fill(t, await call('/api/matrix', { method: 'POST', body: JSON.stringify({ points: points.map((p) => [p.lng, p.lat]), ...q }) }));
  remember(drives, points, t.durations, t.distances, { keep });
  saveDrives();
  return { ...t, fetched: elementsOf(asks) };
}

/**
 * Change me (or add me), then share every stop not done yet out again and
 * save it over the version read. change(doc) edits the doc in place and
 * returns event lines.
 */
async function resplit(change) {
  busy = true;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      say('Getting the latest…');
      const fresh = await call(`/api/share/${id}`);
      const lines = change(fresh) || [];
      say('Timing the drives…');
      const { points, index } = problemPoints(fresh);
      const t = await driveTables(points);
      say('Sharing out the stops…');
      await new Promise((r) => setTimeout(r, 30));
      const now = Date.now();
      // close stops ridden between, not driven: steps between them cost less (lib/ride.js)
      const R = rideAdjust(t.durations, t.distances, points, (i) => Boolean(fresh.stops[points[i].key]), fresh.ride || RIDE_DEFAULTS);
      const pr = problem(fresh, R.D, index, now);
      if (pr.who.length < 2) {
        lines.push('Nobody else is working to share with yet');
      }
      const res = pr.who.length ? rebalance(R.D, { persons: pr.persons, current: pr.current, shop: pr.shop, service: pr.service, timeMs: 2000 }) : { routes: [] };
      const { doc: next, changes } = pr.who.length ? applySplit(fresh, pr, res.routes, t.durations, t.distances, points, now) : { doc: fresh, changes: [] };
      lines.push(...describe(fresh, changes));
      // the roads, for whoever's list changed
      say('Drawing the roads…');
      const st = standing(next);
      for (const [k, p] of next.people.entries()) {
        if (p.geometry || !st[k].todo.length) continue;
        const pos = st[k].done.length ? next.stops[st[k].done.at(-1)] : p.start;
        const seq = [...(pos ? [pos] : []), ...st[k].todo.map((s) => next.stops[s]), next.shop];
        if (seq.length < 2) continue;
        try { p.geometry = thin((await call('/api/route', { method: 'POST', body: JSON.stringify({ points: seq.map((x) => [x.lng, x.lat]) }) })).geometry); } catch { /* straight lines */ }
      }
      try {
        doc = await call(`/api/share/${id}`, { method: 'PUT', body: JSON.stringify({ version: fresh.version, people: next.people, events: lines, by: me }) });
        store.set('seenTodo', meIndex() >= 0 ? standing(doc)[meIndex()].todo : null);
        say(lines.length ? lines.join('. ') : 'Shared out: no change was worth making.');
        render();
        return;
      } catch (e) {
        if (e.status !== 409) throw e;
        // someone ticked or re-split meanwhile: again, from theirs
      }
    }
    throw new Error('The day kept changing while sharing it out. Try again.');
  } catch (e) {
    say(e.message || String(e), true);
  } finally {
    busy = false;
  }
}

/** Where I'll start from and when, from the form. */
async function whereWhen() {
  let start = null;
  if (from === 'address') {
    const q = $('#helpAddress').value.trim();
    if (!q) throw new Error('Type the address you will start from.');
    const near = doc.shop;
    const hit = await call(`/api/geocode?q=${encodeURIComponent(q)}&near=${near.lng},${near.lat}`).catch(() => null);
    if (!hit) throw new Error(`Could not find "${q}" on the map.`);
    start = { lng: hit.lng, lat: hit.lat, label: hit.label };
  } else start = await locate();
  let readyAt = Date.now();
  if (when === 'later') {
    const v = $('#helpTime').value;
    if (!v) throw new Error('Pick the time you will be free.');
    readyAt = timeToday(v);
  }
  return { start, readyAt };
}

$('#helpGo').addEventListener('click', async () => {
  const name = $('#helpName').value.trim();
  if (!name) { say('Your name first, so the others know who took what.', true); $('#helpName').focus(); return; }
  let ww;
  try { ww = await whereWhen(); } catch (e) { say(e.message, true); return; }
  store.set('name', name, 'share.');
  const newId = `h${Date.now().toString(36)}`;
  me = newId;
  store.set('me', me);
  store.set('seenTodo', null);
  await resplit((d) => {
    d.people.push({ id: newId, name, stops: [], into: {}, back: null, geometry: null, readyAt: ww.readyAt, start: ww.start, free: true, helper: true });
    return [`${name} is helping${ww.readyAt > Date.now() + 60000 ? ` from ${clock(ww.readyAt)}` : ' now'}`];
  });
  if (meIndex() >= 0) pushFollowMe();
});

/** Me, already on the day: free now (here), or at a time I give. */
async function meFree(later) {
  const mi = meIndex();
  if (mi < 0) return;
  let readyAt = Date.now();
  if (later) {
    const v = prompt('What time will you be free? (like 2:30 PM)');
    if (!v) return;
    const m = v.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) { say('Could not read that time. Try like 2:30 PM.', true); return; }
    let h = Number(m[1]) % 12;
    if ((m[3] || '').toLowerCase() === 'pm' || (!m[3] && h < 7)) h += 12;
    readyAt = timeToday(`${h}:${m[2] || '00'}`);
  }
  let start = null;
  const st = standing(doc)[mi];
  if (!st.todo.length || doc.people[mi].readyAt > Date.now()) {
    try { start = await locate(); } catch (e) { if (!st.done.length) { say(e.message, true); return; } }
  }
  await resplit((d) => {
    const p = d.people.find((x) => x.id === me);
    p.free = true;
    p.readyAt = readyAt;
    if (start) p.start = start;
    return [`${p.name} is free to help${readyAt > Date.now() + 60000 ? ` from ${clock(readyAt)}` : ' now'}`];
  });
}
$('#freeNow').addEventListener('click', () => meFree(false));
$('#freeLater').addEventListener('click', () => meFree(true));

/* ------------------------------------------------------------ notifications (src/push.js, sw.js) */
const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
let registration = null;

function pushHint(text) { const h = $('#pushHint'); h.hidden = !text; h.textContent = text || ''; }

/** Whether this phone can be told, and whether it is set to be. */
async function pushReady() {
  const box = $('#pushToggle');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    box.disabled = true;
    pushHint(/iPhone|iPad/.test(navigator.userAgent)
      ? 'On iPhone: tap Share, then "Add to Home Screen", open your route from that icon, and turn this on there.'
      : 'This browser cannot show notifications.');
    return;
  }
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
    const sub = await registration.pushManager.getSubscription();
    box.checked = Boolean(sub) && store.get('push', false) && Notification.permission === 'granted';
  } catch { box.disabled = true; pushHint('Notifications could not start here.'); }
}

/** This phone told about my list (me), or no longer. */
async function setPush(on) {
  const box = $('#pushToggle');
  try {
    if (!registration) registration = await navigator.serviceWorker.register('/sw.js');
    let sub = await registration.pushManager.getSubscription();
    if (!on) {
      if (sub) await call(`/api/share/${id}/subscribe`, { method: 'DELETE', body: JSON.stringify({ subscription: sub.toJSON() }) });
      store.set('push', false);
      pushHint('');
      return;
    }
    if (meIndex() < 0) throw new Error('Pick which route is yours first.');
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site: allow them in the browser settings.');
    if (!sub) {
      const { publicKey } = await call('/api/push/key');
      sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(publicKey) });
    }
    await call(`/api/share/${id}/subscribe`, { method: 'POST', body: JSON.stringify({ person: me, subscription: sub.toJSON() }) });
    store.set('push', true);
    pushHint("You'll be told when your list changes, even with this page shut.");
  } catch (e) {
    box.checked = false;
    store.set('push', false);
    pushHint(e.message || String(e));
  }
}
$('#pushToggle').addEventListener('change', (e) => setPush(e.target.checked));
/** After I join or say who I am: if this phone is set to be told, about me now. */
const pushFollowMe = () => { if (store.get('push', false)) setPush(true); };

/* ------------------------------------------------------------ "Done at ...?" from location, page open */
let watch = null;
let at = null; // { sid, since }
const metres = (a, b) => Math.hypot((a.lng - b.lng) * 81000, (a.lat - b.lat) * 111000);
function geoSuggest(on) {
  store.set('geo', on);
  if (watch != null) { navigator.geolocation.clearWatch(watch); watch = null; }
  if (!on || !navigator.geolocation) return;
  watch = navigator.geolocation.watchPosition((pos) => {
    const mi = meIndex();
    if (mi < 0 || !doc) return;
    const next = standing(doc)[mi].todo[0];
    if (!next) return;
    const here = { lng: pos.coords.longitude, lat: pos.coords.latitude };
    const dist = metres(here, doc.stops[next]);
    if (dist < 80) { if (!at || at.sid !== next) at = { sid: next, since: Date.now() }; return; }
    if (at && at.sid === next && dist > 200 && Date.now() - at.since > 2 * 60000) {
      const s = doc.stops[next];
      const b = $('#suggest');
      b.hidden = false;
      b.innerHTML = `Done at <b>${esc(s.address)}</b>?<br><button type="button" class="btn small" id="sugYes">Yes, done</button> <button type="button" class="btn small" id="sugNo">Not yet</button>`;
      const sid = next;
      $('#sugYes').onclick = async () => { b.hidden = true; doc = await call(`/api/share/${id}/tick`, { method: 'POST', body: JSON.stringify({ stop: sid, done: true, by: myName() }) }); render(); };
      $('#sugNo').onclick = () => { b.hidden = true; };
      if (navigator.vibrate) navigator.vibrate(150);
      at = null;
    }
  }, () => { /* no location: just no suggestions */ }, { enableHighAccuracy: true, maximumAge: 15000 });
}
$('#geoToggle').checked = Boolean(store.get('geo', false));
$('#geoToggle').addEventListener('change', (e) => geoSuggest(e.target.checked));

/* ------------------------------------------------------------ start */
async function main() {
  if (!id) { $('#sub').textContent = 'This link is missing its route.'; return; }
  $('#helpName').value = store.get('name', '', 'share.');
  try {
    doc = await call(`/api/share/${id}`);
  } catch (e) { $('#sub').textContent = e.message; return; }
  const asked = Number(new URLSearchParams(location.search).get('p'));
  if (asked >= 1 && asked <= doc.people.length) {
    only = asked - 1;
    // a person's own link: that is them, unless this phone already said otherwise
    if (!me) { me = doc.people[asked - 1].id; store.set('me', me); }
  }
  if (me && meIndex() < 0) { me = null; store.set('me', null); }
  render();
  if (store.get('geo', false)) geoSuggest(true);
  pushReady();
}
main();
