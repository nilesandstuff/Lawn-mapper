/**
 * THE YARD AR TEST PAGE (core session, docs/SCAN-PLAN.md phases 1 and 2).
 *
 * One page, two engines (scan/lib/track.js): Chrome's WebXR on Android, the 8th Wall engine on iPhone. Phase 1: a
 * crosshair, a dot where it meets the ground, pins to drop and check after a walk, a two-tap measure. Phase 2: where
 * the phone is ON THE MAP -- two references marked on the photo and aimed at in AR (scan/lib/align.js), and the lidar
 * match from the depth picture (scan/lib/locate.js, scan/lib/lidar.js in /lidar-worker.js); check points say how far
 * off the map position is. The walk's bookkeeping is scan/lib/walk.js; what is kept on the site is distances and
 * counts only. Pins' map positions stay on this phone until phase 3 writes them to the map record.
 */
import { detect, start, engineChoice, load8thWall, SEM_LABELS } from '/lib/track.js';
import { newWalk, step, dropPin, checkPin, measure, tapeFor, undo, far, summary, pinNow } from '/lib/walk.js';
import { makeDrawer, lidarMeshes, OCC_RANGE, OCC_RANGE_FULL } from '/lib/draw.js';
import { lookMeshes } from '/lib/look.js';
import { snapTo } from '/lib/lidar-marks.js';
import { levelDist, toLocal, fromLocal } from '/lib/frames.js';
import { frameFor, bboxOf, toPx, fromPx, ringsOf, toMerc } from '/lib/photo.js';
import { newLocate, mark, noteGround, addDepth, nextAsk, answer, fitFor, fitSource, leftOutOf, mapOf, sessionOf, checkError, nearestNamed, agreement, groundOffset, groundUnder, status as fixStatus, summaryOf } from '/lib/locate.js';
import { STAND as REF_STAND, MIN_STAND as REF_MIN_STAND, VOX as REF_VOX, referenceFit, buildRef, encodeRef, decodeRef, sameFix } from '/lib/walkref.js';
import { keepPlan, placeWalk, matchUsable, updateRef, cornersShort, AS_IS as REF_AS_IS , closingOf, CLOSE_M } from '/lib/refkeep.js';
import { leftOut, mapToSession } from '/lib/align.js';
import { newTwin, addPoints, addPose, wantKey, addKey, flush, flushDue, liveOf } from '/lib/twin.js';
import { newAnchors, viewOf, noteView, nudge, pitchOf, anchorsKept, SHOW_S } from '/lib/anchors.js';
import { surfaceOf } from '/lib/surface.js';
import { geoReading } from '/lib/geo.js';
import { spikesIn } from '/lib/spikes.js';
import { walkPrior } from '/lib/walkfix.js';
import { KINDS, kindOf, addSightings, standing, decodeThings, encodeThings, pairGutters, forRecord, takeAway, putBack } from '/lib/things.js';
import { keepPoint, viewFromSem, newSemCount, noteSem, semSummary, newCrumbs, crumbDue, addCrumb, crumbMoves } from '/lib/semantics.js';
import { newOutbox, idbStore, memoryStore, statusText } from '/lib/outbox.js';
import { newPerf, resources as perfResources, perfLines } from '/lib/perf.js';
import { byDistance, nearestMap, mapLabel } from '/lib/maps-pick.js';
import { enhance } from '/lib/enhance.js';
import { newSight, sight, lookOf, LOW_EAVE_M } from '/lib/roof-corner.js';
import { whereIs, resnap, NEAR_SIGHT_M } from '/lib/guide.js';
import { viewToFit, followView, toScreen, zoomAt as miniZoom, pan as miniPan, edgeArrow } from '/lib/minimap.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FT = 3.28084;
const ftIn = (m) => { const inch = Math.round(m * FT * 12); return inch < 12 ? `${inch} in` : `${Math.floor(inch / 12)} ft ${inch % 12} in`; };
const ENGINE_URL = '/vendor/xr/xr.js';
const NAME = { webxr: "Chrome's AR (WebXR)", '8thwall': '8th Wall', native: 'the Yard AR app (ARCore)' };
/* THE ANDROID APP (android/, 2026-11-07): the bridge version this page needs (Bridge.kt; build.gradle.kts BRIDGE). A
   page needing more than the installed app has says so and offers the update; otherwise the app needs nothing new. */
const BRIDGE_NEEDED = 1;
const COLOR = { dot: [0.3, 1, 0.6, 0.9], dotPlane: [1, 0.8, 0.2, 0.9], pin: [0.9, 0.22, 0.2, 0.95], placed: [0.9, 0.22, 0.2, 0.45], mark: [0.35, 0.6, 1, 0.95], ref: [0.25, 0.5, 1, 0.9], check: [0.75, 0.3, 0.9, 0.9], where: [1, 1, 1, 0.95] };
const THING_COL = { sprinkler: [0.1, 0.85, 0.95, 0.95], 'gutter-top': [1, 0.75, 0.1, 0.95], 'gutter-out': [1, 0.45, 0.1, 0.95], other: [0.85, 0.85, 0.85, 0.95] };
const CSS = { ref: '#2f7cf6', check: '#a54bd8', pin: '#e53935', lawn: '#4cc38a' };
const THING_CSS = { sprinkler: '#1ad9f2', 'gutter-top': '#ffbf1a', 'gutter-out': '#ff731a', other: '#d9d9d9' };
/* THE LIVE LIDAR FIX IS SET ASIDE (the owner, 2026-11-09: "let's go back to just placing references manually and set
   aside everything about getting a live fix from lidar and finding the best fit after a walk... it looks like automatic
   lidar alignment is just too difficult to make work"; SCAN-H28-H31). The walk is placed by its reference marks; the
   lidar is still read and drawn. ?lidarfix=1 turns the old live fix back on, for a test. */
const LIDAR_LIVE = (() => { try { return new URLSearchParams(location.search).get('lidarfix') === '1'; } catch { return false; } })();
const FAR_AGAIN = 3000;
const DEPTH_EVERY = 250;
const TWIN_WIDE_MIN = 0.05;   // the least depth confidence the twin's wider look keeps (the per-photo .rdepth keeps every cell)
const TWIN_WIDE_EVERY = 1000; // ms between the twin's wider looks (every cell of the app's depth grid, weak ones flagged)
const LIVE_RANGE = 30; // m: the live match and the walk's ground take depth this near, as far as the twin keeps it (track.js; 8 until 2026-11-08)
const WALK_EVERY = 10000; // ms between placements of the whole walk (walkfix.js)
const PREV_MIN_M = 60;      // m walked before the first match against the earlier walk is asked for
const PREV_EVERY = 15000; // ms between matches against the map's earlier walk (walkref.js, SCAN-H32)
const PREV_MAX = 40000;   // standing (and ground) points kept for that match
/* A DEPTH GRID WITH EACH PICTURE (the owner, 2026-11-09, step 2 after SCAN-H32: the pictures matched between walks
   but the twin's thinned points gave few of them a depth): key-NNNN.depth beside key-NNNN.jpg, u16 [nx, ny] then the
   distance from the camera of each cell's surface in mm (0 none), rows from the top. ~18 KB a picture. */
const KEY_DEPTH = { nx: 72, ny: 128 };
const COLOUR_EVERY = 900; // ms between reads of the ground's colour

const st = {
  caps: null, has8w: false, map: new URLSearchParams(location.search).get('map'), site: null, origin: null, lawn: [], parcel: [], frame: null, photo: null,
  points: [], adding: 'ref', view: { s: 1, ox: 0, oy: 0 }, pins: [],
  walk: null, L: null, tracker: null, drawer: null, frame: null, hudAt: 0, farAt: 0, depthAt: 0, errors: [], lid: { worker: null, ready: null, error: null, progress: '', overlay: null, meshes: null }, gpsWatch: null,
  /* THE LIDAR IS NOT DRAWN IN THE CAMERA UNLESS ASKED (the owner, 2026-11-21: "the number 1 most important thing is
     that a walk is consistent with itself. Live fixes really don't matter at all in the first walk... Showing the
     marked corners rather than the lidar"). The Lidar button, or ?lidar=1, shows it as before. */
  lidarOn: (() => { try { return new URLSearchParams(location.search).get('lidar') === '1'; } catch { return false; } })(), agree: null,
};
/* THE STOPWATCH (lib/perf.js; owner, 2026-11-12: "build it but I want you to be able to read the data"): the page's
   own (how long opening took), and one a walk (frames, jitter, waits, its upload). Their numbers go in the walk's
   summary, which the site keeps and task `walks` prints. */
const pagePerf = newPerf();
try { st.tapMode = localStorage.getItem('yard-ar-tap-mode') === '1'; } catch { st.tapMode = false; }
st.wperf = null;
/** The walk's numbers with the page's opening and what was downloaded. Times, sizes and counts only. */
function perfOf(wp) {
  let res = {};
  try { res = perfResources(performance.getEntriesByType('resource')); } catch { /* none */ }
  const c = navigator.connection || {};
  const device = { cores: navigator.hardwareConcurrency ?? null, memoryGb: navigator.deviceMemory ?? null, net: c.effectiveType ?? null, downMbps: c.downlink ?? null,
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null };
  return { ...(wp || pagePerf).summary({ device, resources: res, uploadsHeld: !!st.holdLast, uploadsByApp: !!nativeParts() }), stagesS: pagePerf.summary().stagesS };
}
// the photo frame and the AR frame are both "frame": keep the AR one apart
st.ar = null;

/* ------------------------------------------------------------- the page */

async function main() {
  startOutbox().catch(() => {});
  if (st.map) $('#back').href = `${$('#back').getAttribute('href')}?map=${encodeURIComponent(st.map)}`;
  try { st.has8w = (await fetch('/vendor/xr/VERSION', { method: 'HEAD', cache: 'no-store' })).ok; } catch { st.has8w = false; }
  st.caps = await detect({ eightWallUrl: st.has8w ? ENGINE_URL : null });
  const pick = engineChoice({ hasXR: st.caps.webxr, has8w: st.has8w, ios: st.caps.ios, hasNative: !!st.caps.native });
  const bits = [];
  if (st.caps.native) {
    // inside the app: its own ARCore, so the browser's engines are beside the point
    bits.push(`Inside the Yard AR app (version ${st.caps.native.app}, ${st.caps.native.device}); it uses ARCore directly.`);
  } else {
    bits.push(st.caps.ios ? 'An iPhone or iPad.' : 'Not an iPhone.');
    bits.push(st.caps.webxr ? "Chrome's AR is here." : 'No WebXR in this browser (none on iPhone; on Android, Chrome with Google Play Services for AR has it).');
    bits.push(st.has8w ? 'The 8th Wall engine is on this site.' : 'The 8th Wall engine is not on this site (the deploy did not install it).');
  }
  $('#status').textContent = bits.join(' ');
  appBox().catch(() => {});
  const box = $('#start');
  box.innerHTML = '';
  for (const e of pick.offered) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = `Start AR (${NAME[e]})`; b.className = e === pick.start ? '' : 'plain';
    b.addEventListener('click', () => startAR(e));
    box.append(b);
  }
  /* THE READINGS PAGE, IN THE APP (bridge 7; the owner, 2026-11-17: "display the readings page on a separate page/tab
     in the app so I don't need to flip back and forth between the browser and the app"): the water site's field
     readings open over this page; Back, or the bar at its top, comes back here. */
  if ((st.caps.native?.bridge ?? 0) >= 7 && typeof window.LawnARNative?.readings === 'function') {
    const r = document.createElement('button');
    r.type = 'button'; r.className = 'plain'; r.textContent = 'Readings (soil, temperature, wind)';
    r.addEventListener('click', () => { try { window.LawnARNative.readings(); } catch { flash('This app cannot open the readings page: update it'); } });
    box.append(r);
  }
  /* RECORD FIRST, FIX AFTERWARDS (owner, 2026-11-05): no live lidar fix on this walk; it is recorded (points, track,
     pictures, marks, pins) and placed afterwards on a GitHub runner (workflow "S. Yard AR tool", task fix). The
     references still line the camera view up meanwhile. */
  if (pick.offered.length) {
    const lab = document.createElement('label'); lab.className = 'dim'; lab.style.display = 'block'; lab.style.margin = '8px 0';
    lab.innerHTML = '<input type="checkbox" id="record-only"> Testing only: skip the live lidar fix (the walk is placed afterwards on the server, and is NOT kept as the map\'s reference). Leave this off for a normal walk';
    box.append(lab);
    $('#record-only').addEventListener('change', (e) => { st.recordOnly = e.target.checked; });
    /* THE OLD WAY, KEPT AS A BACKUP MODE (the owner, 2026-11-12: "remove the mark button entirely and replace with a
       small red button that says start over" -- "Save the old configuration though, as a backup mode. We might need to
       add back future support for ground references"). Off: roof corners only, each marks itself, no Mark button. On:
       everything as it was -- the Mark button, ground references, check points, the long top box. */
    const tap = document.createElement('label'); tap.className = 'dim'; tap.style.display = 'block'; tap.style.margin = '8px 0';
    tap.innerHTML = `<input type="checkbox" id="tap-mode"${st.tapMode ? ' checked' : ''}> Backup mode: mark by tapping (ground references and check points, the Mark button)`;
    box.append(tap);
    $('#tap-mode').addEventListener('change', (e) => { st.tapMode = e.target.checked; try { localStorage.setItem('yard-ar-tap-mode', st.tapMode ? '1' : '0'); } catch { /* this visit only */ } });
    /* RECORDING AND REPLAY (the app's bridge 3; the owner, 2026-11-08: "so I don't have to keep doing the same walks
       over and over"): ARCore records the walk's camera and motion; it goes to the site after the walk, and any
       recorded walk can be run again through ARCore and this page from the couch. */
    if ((st.caps.native?.bridge ?? 0) >= 3) {
      const rec = document.createElement('label'); rec.className = 'dim'; rec.style.display = 'block'; rec.style.margin = '8px 0';
      rec.innerHTML = '<input type="checkbox" id="record-arcore"> Record this walk for replay (a video of the whole walk with its motion: it can be over 100 MB a MINUTE (135 MB for a 1 minute walk, 2026-11-15), sent after the walk; untick it to send only the walk\'s points and pictures, a few MB)';
      box.append(rec);
      // off unless ticked (the owner, 2026-11-15: "Make the replay recording off by default"; 135 MB for a minute)
      st.recordOff = true;
      $('#record-arcore').addEventListener('change', (e) => { st.recordOff = !e.target.checked; });
      const fr = document.createElement('label'); fr.className = 'dim'; fr.style.display = 'block'; fr.style.margin = '8px 0';
      fr.innerHTML = '<input type="checkbox" id="full-res"> Full-resolution camera (1920x1080, pictures kept 1080 wide; the recording is about 2 GB for 8 minutes)';
      box.append(fr);
      $('#full-res').addEventListener('change', (e) => { st.fullRes = e.target.checked; });
      if (typeof window.LawnARNative.localRecordings === 'function') phoneRecordings(box);
      const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'plain'; rb.textContent = 'Replay a recorded walk';
      rb.addEventListener('click', () => pickReplay().catch((e) => flash(`Recordings could not be listed: ${e.message}`)));
      box.append(rb);
      const pend = (() => { try { return JSON.parse(window.LawnARNative.pendingRecordings()); } catch { return []; } })();
      /* The app's events before any walk has started (the owner, 2026-11-08: the send "only updates when I close the
         app and re open"): track.js sets this hook only when a walk starts, so a send begun as the app opened told
         nobody. A walk's own hook replaces this one. */
      if (!window.LawnARNative_onEvent) window.LawnARNative_onEvent = (e) => onEvent({ ...e, type: 'native', what: e.type });
      if (pend.length) { const n = document.createElement('p'); n.className = 'dim'; n.id = 'rec-pending'; n.textContent = `${pend.length} recording${pend.length === 1 ? '' : 's'} still on the phone, being sent (${Math.round(pend.reduce((a, x) => a + (x.sent || 0), 0) / 1e6)} of ${Math.round(pend.reduce((a, x) => a + x.bytes, 0) / 1e6)} MB so far; keep the app open on wifi).`; box.append(n); try { window.LawnARNative.sendRecordings(); } catch { /* none */ } }
    } else if (st.caps.native) {
      const n = document.createElement('p'); n.className = 'dim'; n.textContent = 'Recording walks for replay needs the app\'s next version: update it from the link above.'; box.append(n);
    }
    if (st.caps.native && (st.caps.native.bridge ?? 0) < 5) {
      const n = document.createElement('p'); n.className = 'dim'; n.textContent = 'Real things hiding the lidar cleanly (the phone\'s full depth picture, every frame) needs the app\'s next version: update it from the link above.'; box.append(n);
    }
    /* RAW DEPTH ONLY, a test (2026-11-06): asked for raw first, the S21's Chrome gave smooth. Asked for raw alone,
       it either gives raw or no depth at all; the walk's log says which ("depth raw" or "depth -"). */
    if (pick.offered.includes('webxr')) {
      const raw = document.createElement('label'); raw.className = 'dim'; raw.style.display = 'block'; raw.style.margin = '8px 0';
      raw.innerHTML = '<input type="checkbox" id="raw-depth"> Raw depth only (a test: the walk may get no depth at all)';
      box.append(raw);
      $('#raw-depth').addEventListener('change', (e) => { st.rawDepth = e.target.checked; });
    }
  }
  if (!pick.offered.length) {
    $('#why').innerHTML = st.caps.why ? esc(st.caps.why) : st.caps.ios
      ? 'Nothing on this phone can track yet. The fallback to try once: install <a href="https://apps.apple.com/app/id1295998056">Mozilla WebXR Viewer</a> (old, unsupported) and open this page in it.'
      : 'Nothing on this phone can track. On Android, open this page in Chrome with Google Play Services for AR installed.';
  } else if (!st.caps.webxr && st.has8w) {
    $('#why').textContent = 'Safari will ask for the camera and the motion sensors; both are needed. The engine downloads about 7 MB the first time.';
  }
  renderResults();
  st.mapBusy = true;   // startAR waits for this: a walk begun while the map is still opening belongs to no map
  if (st.map) { await loadMap(st.map).then(() => pagePerf.stage('map opened')).catch((e) => { $('#mapnote').textContent = `The map could not be opened (${e.message}): tracking only, no references or lidar.`; }); changeButton(); }
  else await pickMap().catch(() => { $('#mapnote').textContent = 'No map: open this page from the dashboard to use references and the lidar. Tracking still works.'; });
  st.mapBusy = false;
}

/* WHICH MAP (scan/lib/maps-pick.js; owner, 2026-11-07): the app cannot be handed a map by the dashboard (that opens
   in the browser), so the page picks one itself: the nearest saved map within reach of the phone's place opens by
   itself, otherwise a list, nearest first; Change map lists them again. */
async function pickMap({ auto = true, own = false } = {}) {
  const note = $('#mapnote');
  note.textContent = 'Finding your maps…';
  /* THE ADMIN SAVES FIRST (the owner, 2026-11-11: "The picker on the AR page will default to maps in the admin save
     folder. And there will be an on page drop-down that allows me to pick from any of the admin saves"): the test
     maps made from the Lawn Mapper's AI tab (worker/src/admin-saves.js), listed by /api/maps?admin=1. With none,
     the account's own maps as before; "Your own maps" in the drop-down shows those instead. */
  let maps = [], admin = [];
  const ask = async (q) => { try { return (await (await fetch(`/api/maps${q}`, { credentials: 'same-origin' })).json())?.maps || []; } catch { return []; } };
  if (!own) admin = (await ask('?admin=1')).filter((m) => m.adminSave === true);
  st.adminMaps = admin;
  maps = admin.length ? admin : await ask('');
  drawAdminPick();
  if (!maps.length) { note.textContent = 'No saved maps for this account: tracking still works without one.'; return; }
  const here = await new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition((p) => resolve({ at: [p.coords.longitude, p.coords.latitude], acc: p.coords.accuracy }), () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
  const near = auto ? nearestMap(maps, here?.at, here?.acc ?? 0) : null;
  if (near) { await openMap(near.map.id, `the nearest saved map (${Math.round(near.m * FT)} ft from here)`); return; }
  const list = byDistance(maps, here?.at);
  const far = (m) => (m == null ? '' : ` · ${m < 1609 ? `${Math.round(m * FT)} ft` : `${(m / 1609).toFixed(1)} mi`}`);
  note.innerHTML = `<strong>Pick a map</strong>${here ? ' (nearest first)' : ' (the phone did not give its place)'}:
    <div class="tools" style="margin-top:6px">${list.slice(0, 15).map(({ map, m }) => `<button type="button" class="plain" data-map="${esc(map.id)}">${esc(mapLabel(map))}${far(m)}</button>`).join(' ')}</div>`;
  note.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => openMap(b.dataset.map, 'as picked')));
}

/** The drop-down of admin saves (and a way back to the account's own maps), above the map note. */
function drawAdminPick() {
  const box = $('#admin-pick'); if (!box) return;
  const A = st.adminMaps || [];
  box.hidden = !A.length;
  if (!A.length) return;
  box.innerHTML = `<label>Admin saves: <select id="admin-map"><option value="">Pick one…</option>${A.map((m) => `<option value="${esc(m.id)}"${m.id === st.map ? ' selected' : ''}>${esc(mapLabel(m))}${m.trace?.status === 'done' ? '' : m.trace?.status ? ` (trace ${esc(m.trace.status)})` : ''}</option>`).join('')}<option value="__own">Your own maps…</option></select></label>`;
  $('#admin-map').addEventListener('change', (e) => { const v = e.target.value; if (v === '__own') pickMap({ auto: false, own: true }); else if (v) openMap(v, 'picked from the admin saves'); });
}

async function openMap(id, how) {
  st.map = id;
  /* A WALK ALREADY UNDER WAY WITH NO MAP TAKES THIS ONE (2026-11-25: the owner's second walk of 2026-11-24 was begun
     seconds before the page had found its map; its record named no map, so the earlier walk never placed it and no
     tool could tell where it belonged, though its corners were marked on this map's roofs). */
  if (st.twin && !st.twin.map) { st.twin.map = id; st.twin.metaCamera = false; st.lateMap = true; log('the walk under way had no map: it is now this map\'s'); }
  try { const u = new URL(location.href); u.searchParams.set('map', id); history.replaceState(null, '', u); } catch { /* the address bar can wait */ }
  const back = $('#back');
  if (back) back.href = `${(back.getAttribute('href') || '').split('?')[0]}?map=${encodeURIComponent(id)}`;
  try { await loadMap(id); $('#mapnote').textContent += ` Opened ${how}.`; } catch (e) { $('#mapnote').textContent = `The map could not be opened (${e.message}).`; }
  changeButton();
  // the drop-down of admin saves, also when the map came by its link (the admin saves page) and nothing was picked
  if (!st.adminMaps) { try { st.adminMaps = ((await (await fetch('/api/maps?admin=1', { credentials: 'same-origin' })).json())?.maps || []).filter((m) => m.adminSave === true); } catch { st.adminMaps = []; } }
  drawAdminPick();
}

function changeButton() {
  const note = $('#mapnote');
  if (!note || note.querySelector('#change-map')) return;
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'change-map'; b.className = 'plain'; b.style.marginLeft = '8px'; b.textContent = 'Change map';
  b.addEventListener('click', () => pickMap({ auto: false }));
  note.append(' ', b);
}

/* --------------------------------------------------------------- the map */

async function loadMap(id) {
  const res = await fetch(`/api/maps/one?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `${res.status}`);
  const m = j?.map || j; // docs/MAPS.md: the answer is { map }
  if (!m || !Number.isFinite(m.lng) || !Number.isFinite(m.lat)) throw new Error('no point');
  st.site = m; st.origin = [m.lng, m.lat];
  st.lawn = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(st.origin, p)));
  st.parcel = ringsOf(m.parcel ? [m.parcel] : []).map((r) => r.map((p) => toLocal(st.origin, p)));
  const pts = [...st.lawn.flat(), ...st.parcel.flat()];
  st.frame = frameFor(bboxOf(st.origin, pts, 12), m.lat);
  loadPoints(); loadPins(); listPoints();
  askMarks(id);
  layerControls(); eraserControls(); askErased(id);
  $('#setup').hidden = false;
  // which map: the owner has more than one of the same house (2026-11-09), so its date and size say which
  const saved = m.at ? new Date(m.at) : null;
  $('#mapnote').textContent = `Map opened (${[saved && !Number.isNaN(+saved) ? `saved ${saved.toLocaleDateString()}` : '', m.squareFeet ? `${Math.round(m.squareFeet).toLocaleString()} sq ft of lawn` : ''].filter(Boolean).join(', ') || 'no lawn traced yet'}).`;
  drawMap();
  startLidar(m);
  askReference();
  askThings();
  st.photo = null; st.photos = { kept: null, stretched: null }; st.shown = {};
  const got = await keptPhoto(id);
  if (got.photo) { st.photos.kept = got.photo; st.photoSrc = got.src; st.frame = got.frame; }
  $('#mapnote').textContent += ` Photo: ${got.note}.`;
  if (got.photo) st.photos.stretched = await stretchedPhoto(id, got.src, got.photo);
  await showPhoto();
  lidarPhoto().catch((e) => log(`lidar picture: ${e.message}`)); // if the lidar was read before the photo came
  groundPhoto().catch((e) => log(`lidar ground picture: ${e.message}`));
  naipPhoto().catch((e) => log(`NAIP: ${e.message}`));
}

/**
 * THE PHOTO STRETCHED ONTO THE LIDAR, AND CRISPER (the owner, 2026-11-09: aerial photos are locally skewed at the
 * ground and only the lidar is true to it; "run the photos through the same enhancement that the lawnmapper uses to
 * make things crisper and easier to see"). docs/SCAN-PLAN.md section 17. The study (scan/tools/warp_study.py) keeps
 * the map's own photo resampled so each pixel sits where the lidar put that spot, on the same frame and size, under
 * refs/warp/<map>/. Laid where the page draws the lidar (the model's one shift onto the photo included), so a point
 * placed on it is placed on the lidar's ground. Each point keeps which photo it was placed on (`on`).
 */
async function stretchedPhoto(id, src, kept) {
  try {
    const r = await fetch(`/api/scan/warp?map=${encodeURIComponent(id)}&file=warped-${src}.png`, { credentials: 'same-origin' });
    if (!r.ok) return null;
    const b = await createImageBitmap(await r.blob());
    return b.width === kept.width && b.height === kept.height ? b : null; // another frame: not this photo's stretch
  } catch { return null; }
}

/**
 * THE LIDAR AS A THIRD PICTURE TO PLACE POINTS ON (the owner, 2026-11-10: "we can try placing points to lidar. Make
 * the change non-destructively so we can switch back"): lib/look.js lidarPicture, laid on the photo's own frame and
 * size, so the point placer, the zoom and every point's place on the map are the same whichever picture is shown.
 * One more choice beside the photo; nothing about the photo is changed, and each point keeps which it was placed on.
 */
async function lidarPhoto() {
  const pic = st.lid.overlay?.picture, kept = st.photos?.kept;
  if (!pic || !kept || !st.frame) return;
  const small = document.createElement('canvas'); small.width = pic.W; small.height = pic.H;
  small.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pic.rgba), pic.W, pic.H), 0, 0);
  const c = document.createElement('canvas'); c.width = kept.width; c.height = kept.height;
  const g = c.getContext('2d'); g.fillStyle = '#2a332f'; g.fillRect(0, 0, c.width, c.height);
  const a = toPx(st.frame, st.origin, [pic.e0, pic.n1], c.width, c.height), b = toPx(st.frame, st.origin, [pic.e0 + pic.W * pic.cell, pic.n1 - pic.H * pic.cell], c.width, c.height);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(small, a[0], a[1], b[0] - a[0], b[1] - a[1]);
  st.photos.lidar = await createImageBitmap(c);
  await showPhoto();
}

/**
 * THE GROUND ALONE, HARD-EDGED (lib/ground-picture.js; the owner, 2026-11-11: "improve the viewability of the lidar...
 * ground level... hide anything above... preserve the hard edges"): the worker's picture drawn in the photo's frame,
 * unsmoothed so its edges stay where they are.
 */
async function groundPhoto() {
  const pic = st.lid.ground, kept = st.photos?.kept;
  if (!pic || !kept || !st.frame) return;
  const small = document.createElement('canvas'); small.width = pic.W; small.height = pic.H;
  small.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pic.rgba), pic.W, pic.H), 0, 0);
  const c = document.createElement('canvas'); c.width = kept.width; c.height = kept.height;
  const g = c.getContext('2d'); g.fillStyle = '#2a332f'; g.fillRect(0, 0, c.width, c.height);
  const a = toPx(st.frame, st.origin, [pic.e0, pic.n1], c.width, c.height), b = toPx(st.frame, st.origin, [pic.e0 + pic.W * pic.cell, pic.n1 - pic.H * pic.cell], c.width, c.height);
  g.imageSmoothingEnabled = false;
  g.drawImage(small, a[0], a[1], b[0] - a[0], b[1] - a[1]);
  st.photos.ground = await createImageBitmap(c);
  await showPhoto();
}

/**
 * NAIP AS A BACKGROUND OF ITS OWN (the owner, 2026-11-11: "make the naip layer selectable as the background in the
 * point placement. I don't want to combine naip with 3dep, seperate views"): the USDA's aerial photo as it is
 * delivered, not slid onto the lidar (SCAN-PLAN section 22 measured it 0.8 m off the lidar at the owner's home and
 * 3 m at work). The newest frame Microsoft's Planetary Computer holds that covers the whole photo frame; failing
 * that, the USGS National Map's mosaic. Both free, no key, open to browsers (public/shade/naip.js reads them so).
 */
const NAIP_STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search', NAIP_CROP = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox';
const NAIP_MOSAIC = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
async function naipPhoto() {
  const kept = st.photos?.kept; if (!kept || !st.frame || st.photos.naip) return;
  const W = kept.width, H = kept.height, frame = st.frame, photos = st.photos;
  // the photo frame's corners in web mercator (the frame is a mercator square)
  const ll = [[0, 0], [W, 0], [W, H], [0, H]].map((p) => fromLocal(st.origin, fromPx(frame, st.origin, p, W, H)));
  const mc = ll.map(toMerc), bbox = [Math.min(...mc.map((p) => p[0])), Math.min(...mc.map((p) => p[1])), Math.max(...mc.map((p) => p[0])), Math.max(...mc.map((p) => p[1]))];
  const inside = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
  let bmp = null, note = '';
  try {
    const res = await fetch(NAIP_STAC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collections: ['naip'], intersects: { type: 'Polygon', coordinates: [[...ll, ll[0]]] }, limit: 100 }) });
    const items = res.ok ? ((await res.json())?.features || []) : [];
    const f = items.filter((x) => ll.every((pt) => (x.geometry?.coordinates || []).some((poly) => inside(pt, poly)))).sort((a, b) => String(b.properties?.datetime).localeCompare(String(a.properties?.datetime)))[0];
    if (f) {
      const img = await fetch(`${NAIP_CROP}/${bbox.map((v) => v.toFixed(2)).join(',')}/${W}x${H}.png?collection=naip&item=${encodeURIComponent(f.id)}&assets=image&asset_bidx=image%7C1,2,3&coord_crs=EPSG:3857&dst_crs=EPSG:3857&resampling=bilinear`);
      if (img.ok) { bmp = await createImageBitmap(await img.blob()); note = `flown ${String(f.properties?.datetime).slice(0, 10)}, ${f.properties?.gsd || '?'} m a pixel`; }
    }
  } catch (e) { log(`NAIP (frames): ${e.message}`); }
  if (!bmp) {
    try {
      const img = await fetch(`${NAIP_MOSAIC}?bbox=${bbox.map((v) => v.toFixed(2)).join(',')}&bboxSR=3857&imageSR=3857&size=${W},${H}&format=png&bandIds=0,1,2&interpolation=RSP_BilinearInterpolation&f=image`);
      if (img.ok) { bmp = await createImageBitmap(await img.blob()); note = 'the USGS mosaic, its newest'; }
    } catch (e) { log(`NAIP (mosaic): ${e.message}`); }
  }
  if (!bmp || photos !== st.photos) return;
  st.photos.naip = bmp; st.naipNote = note;
  log(`NAIP: ${note}`);
  await showPhoto();
}

const pref = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this phone only */ } };

/** The photo the placement map shows: as kept or stretched, crisper or not (lib/enhance.js, for the eye only). */
async function showPhoto() {
  const want = pref('scan-photo', 'stretched');
  const which = (want === 'lidar' || want === 'ground' || want === 'naip') && st.photos?.[want] ? want : st.photos?.stretched && want === 'stretched' ? 'stretched' : 'kept';
  const crisp = which !== 'lidar' && which !== 'ground' && pref('scan-crisp', '1') !== '0';   // the enhancement is for photos
  const base = st.photos?.[which] || null;
  st.photoChoice = base ? which : null;
  const key = `${which}:${crisp ? 1 : 0}`;
  if (base && crisp && !st.shown[key]) {
    try {
      const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(base, 0, 0);
      const im = g.getImageData(0, 0, c.width, c.height);
      enhance(im.data, c.width, c.height);
      g.putImageData(im, 0, 0);
      st.shown[key] = await createImageBitmap(c);
    } catch (e) { log(`crisper photo: ${e.message}`); }
  }
  st.photo = (crisp && st.shown[key]) || base;
  photoTools();
  drawMap();
}

function photoTools() {
  const box = $('#photo-tools'); if (!box) return;
  box.hidden = !st.photos?.kept;
  const s = $('#photo-stretched'), k = $('#photo-kept'), c = $('#photo-crisp');
  s.hidden = !st.photos?.stretched || !!st.againMode; k.hidden = !!st.againMode;
  const li = $('#photo-lidar'); if (li) { li.hidden = !st.photos?.lidar || !!st.againMode; li.classList.toggle('plain', st.photoChoice !== 'lidar'); }
  c.hidden = st.photoChoice === 'lidar' || st.photoChoice === 'ground';
  for (const w of ['ground', 'naip']) { const b = $(`#photo-${w}`); if (b) { b.hidden = !st.photos?.[w] || !!st.againMode; b.classList.toggle('plain', st.photoChoice !== w); } }
  againTools();
  k.classList.toggle('plain', st.photoChoice !== 'kept');
  s.classList.toggle('plain', st.photoChoice !== 'stretched');
  const crisp = pref('scan-crisp', '1') !== '0';
  c.classList.toggle('plain', !crisp); c.setAttribute('aria-pressed', String(crisp));
  if (st.photoChoice === 'lidar') { const M = st.lid.overlay?.picture?.marks; $('#photo-why').textContent = `The lidar itself. Raised things (roofs, decks, walls, sheds, hot tubs) have straight edges fitted to the laser's hits; paving the laser tells apart by brightness (darker than the grass) is dashed blue: its corners always less sure, and a curved drive or a road only traced, with no corners. A point snaps to a corner: a white dot is pinned to about a foot, a yellow ring is less sure (the laser's last hit may stop short), a white cross is a small thing's middle. In the walk, aim at that corner itself, at any height. The ground shows by brightness; trees are green outlines.${M ? ` ${M.corners.filter((c) => c.sure && onPhoto(c.at)).length} sure corners here.` : ''}`; return; }
  if (st.photoChoice === 'ground') { const L = st.lid.ground; $('#photo-why').textContent = `The lidar's ground alone, everything above it hidden (grey: no ground seen, under a roof or a thick crown). Hard-edged on purpose: light is grass, dark is paving (blacktop darker than concrete), each edge put halfway between the laser's light and dark hits. One hit every ${L ? (L.spacing * 3.281).toFixed(1) : '?'} ft, drawn on ${L ? (L.cell * 39.37).toFixed(0) : '?'} in cells.`; return; }
  if (st.photoChoice === 'naip') { $('#photo-why').textContent = `NAIP, the USDA's aerial photo (${st.naipNote || ''}), as delivered: not moved onto the lidar.`; return; }
  $('#photo-why').textContent = st.photos?.stretched
    ? (st.photoChoice === 'stretched' ? 'Stretched onto the lidar: each spot moved to where the lidar measured it, so a corner on the ground is where it is on the ground.' : 'The photo as the map was traced on it. Aerial photos lean and stretch a little at the ground; "Stretched onto the lidar" corrects that.')
    : 'No stretched photo for this map yet.';
}

/** Place the set again on the other photo: switch photos, hide the first placements. */
async function againStart() {
  if (!st.points.length || !st.photos?.stretched) return;
  st.againFrom = st.photoChoice;
  setPref('scan-photo', st.photoChoice === 'stretched' ? 'kept' : 'stretched');
  // a fresh round: earlier second placements on this other photo are cleared, so none is reused unseen
  for (const p of st.points) delete p.again;
  st.againMode = true; st.againShown = null; st.view = { s: 1, ox: 0, oy: 0 };
  savePoints(); await showPhoto(); listPoints();
  flash(`Now on the ${st.photoChoice === 'stretched' ? 'stretched' : 'traced'} photo: tap each point's spot again`);
}
async function againStop() {
  st.againMode = false; st.againShown = null;
  if (st.againFrom) setPref('scan-photo', st.againFrom);
  await showPhoto(); listPoints();
}
function againTools() {
  const a = $('#again'), d = $('#again-done'); if (!a || !d) return;
  a.hidden = st.againMode || !st.points.length || !st.photos?.stretched;
  d.hidden = !st.againMode;
  const add = document.querySelectorAll('[data-add]'); add.forEach((b) => { b.hidden = !!st.againMode; });
  const n = $('#new-set'); if (n) n.hidden = !!st.againMode;
}

function wirePhotoTools() {
  $('#photo-kept')?.addEventListener('click', () => { setPref('scan-photo', 'kept'); showPhoto(); });
  $('#photo-lidar')?.addEventListener('click', () => { setPref('scan-photo', 'lidar'); showPhoto(); });
  $('#photo-ground')?.addEventListener('click', () => { setPref('scan-photo', 'ground'); showPhoto(); });
  $('#photo-naip')?.addEventListener('click', () => { setPref('scan-photo', 'naip'); showPhoto(); });
  $('#photo-stretched')?.addEventListener('click', () => { setPref('scan-photo', 'stretched'); showPhoto(); });
  $('#photo-crisp')?.addEventListener('click', () => { setPref('scan-crisp', pref('scan-crisp', '1') !== '0' ? '0' : '1'); showPhoto(); });
}

/**
 * THE PHOTO THE MAP WAS TRACED ON, KEPT WITH THE MAP (the owner, 2026-11-09: "let's make sure the AR point placement
 * map gets the same imagery that the map was initially saved on"; and, of a fallback to Mapbox when a county photo
 * could not be had, "that's a bug that needs addressing. The photo a map is traced on should be accessible
 * indefinitely"). Lawn Mapper keeps it beside the map when the map is saved (worker/src/map-photo.js): the county
 * photo as the editor showed it (its line-up applied), or Mapbox, with its frame. The page lays it down on that frame,
 * so a point on it is a point on the photo the outline was drawn on. No stand-in: a photo that cannot be had is said.
 */
async function keptPhoto(id) {
  try {
    const r = await fetch(`/api/maps/photo?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!r.ok) { const j = await r.json().catch(() => null); throw new Error(j?.error || `${r.status}`); }
    const frame = JSON.parse(r.headers.get('X-Photo-Frame') || 'null');
    if (!frame || ![frame.lng, frame.lat, frame.zoom, frame.size].every(Number.isFinite)) throw new Error('no frame with the photo');
    frame.height = Number.isFinite(frame.height) ? frame.height : frame.size;
    const src = r.headers.get('X-Photo-Source');
    const photo = await createImageBitmap(await r.blob());
    return { photo, frame, src: src === 'county' ? 'county' : 'mapbox', note: `${src === 'county' ? 'the county photo' : 'the Mapbox photo'} the map was traced on, kept with the map` };
  } catch (e) {
    return { photo: null, frame: null, note: `the map's own photo could not be loaded (${e.message}); reload to try again` };
  }
}

/* The placement map: its drawing, zoom, points and touch (restored 2026-11-09: commit 280e271 had deleted this block
   with the old photo fetch, and the page stopped at its start screen). */
const photoW = () => (st.photo ? st.photo.width : 1280), photoH = () => (st.photo ? st.photo.height : 1280);
/* A TALLER WINDOW (the owner, 2026-11-10: "make the map view larger, it's a pretty small window"): the canvas was the
   photo's own shape, and a wide photo on a phone was a strip 160 px high. The canvas is now at least 1.25 times as
   tall as it is wide, the photo in its middle (padY above it), so zoomed in there is a tall window to work in. */
const MAP_TALL = 1.25;
const mapH = () => Math.max(photoH(), Math.round(photoW() * MAP_TALL));
const padY = () => (mapH() - photoH()) / 2;
const px = (map) => { const q = toPx(st.frame, st.origin, map, photoW(), photoH()); return [q[0], q[1] + padY()]; };
const unpx = (p) => fromPx(st.frame, st.origin, [p[0], p[1] - padY()], photoW(), photoH());
const KEYP = () => `scan-points:${st.map}`, KEYPIN = () => `scan-pins:${st.map}`;
const loadPoints = () => { try { st.points = JSON.parse(localStorage.getItem(KEYP()) || '[]'); } catch { st.points = []; } };
/* THE MARKS ARE KEPT WITH THE MAP (core session, 2026-11-24; src/twin.js marks): the owner opened their home map and
   the marks were gone, because they lived only in this phone's storage. Now the phone's copy is the quick one and
   the server's the kept one: written a moment after each change, read when a map opens (askMarks), the newer of the
   two winning by its time. */
const KEYPAT = () => `scan-points-at:${st.map}`;
let marksTimer = null;
const savePoints = () => {
  const at = new Date().toISOString();
  try { localStorage.setItem(KEYP(), JSON.stringify(st.points)); localStorage.setItem(KEYPAT(), at); } catch { /* the server's copy below */ }
  const map = st.map, points = pointsKept();
  clearTimeout(marksTimer);
  if (map) marksTimer = setTimeout(() => putMarks(map, points, at), 1500);
};
async function putMarks(map, points, at) {
  try {
    const r = await fetch(`/api/scan/marks?map=${encodeURIComponent(map)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, at, points }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    if (!r.ok) log(`the marks were NOT kept with the map (the site answered ${r.status}); they are on this phone`);
  } catch { /* no signal: the next change, or the next opening, sends them */ }
}
async function askMarks(map) {
  let j = null;
  try { const r = await fetch(`/api/scan/marks?map=${encodeURIComponent(map)}`, { credentials: 'same-origin' }); j = r.ok ? await r.json() : null; } catch { j = null; }
  if (st.map !== map || !j) return;
  let localAt = '';
  try { localAt = localStorage.getItem(KEYPAT()) || ''; } catch { localAt = ''; }
  const server = !j.none && Array.isArray(j.points) ? j.points : null;
  if (server && server.length && (!st.points.length || String(j.at || '') > localAt)) {
    st.points = server;
    try { localStorage.setItem(KEYP(), JSON.stringify(st.points)); localStorage.setItem(KEYPAT(), String(j.at || '')); } catch { /* shown all the same */ }
    listPoints(); drawMap();
    log(`the marks kept with this map (${server.length}) are shown`);
  } else if (st.points.length && (!server || localAt > String(j.at || ''))) putMarks(map, pointsKept(), localAt || new Date().toISOString());
}
const loadPins = () => { try { st.pins = JSON.parse(localStorage.getItem(KEYPIN()) || '[]'); } catch { st.pins = []; } };
const savePins = () => { try { localStorage.setItem(KEYPIN(), JSON.stringify(st.pins.slice(-200))); } catch { /* this phone only */ } };
/* PLACED AGAIN ON THE OTHER PHOTO (the owner, 2026-11-10): the same set of points placed a second time on the other
   photo (as traced / stretched onto the lidar), without seeing the first placements, so the two can be compared
   spot for spot. Each point keeps it as `again: { on, map }`. While placing again, the map shows only the second
   placements; a tap places the next point still to do. */
const againTodo = () => (st.points || []).find((p) => !p.again);
function shownPoints() {
  if (!st.againMode) return st.points;
  if (!st.againShown) st.againShown = st.points.filter((p) => p.again).map((p) => ({ id: p.id, name: p.name, kind: p.kind, map: p.again.map, of: p }));
  return st.againShown;
}
const nextName = (kind) => { const pre = kind === 'ref' ? 'R' : 'C'; let k = 1; while (st.points.some((p) => p.name === `${pre}${k}`)) k++; return `${pre}${k}`; };

function drawMap() {
  const cv = $('#map'); if (!cv || !st.frame) return;
  const w = photoW(), h = mapH(), y0 = padY();
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#2a332f'; g.fillRect(0, 0, w, h);
  g.setTransform(st.view.s, 0, 0, st.view.s, st.view.ox, st.view.oy);
  g.imageSmoothingEnabled = st.view.s < 6; // past the photo's own pixels, show them as they are
  if (st.photo) g.drawImage(st.photo, 0, y0);
  /* SIZES IN SCREEN PIXELS (the owner, 2026-11-09: "the points aren't labeled, and they're really hard to drag
     around because they're so small"): the canvas is the photo's 2560 pixels shown about 400 wide, so a size in
     canvas pixels came out a sixth as big. u = canvas pixels per screen pixel at this zoom. */
  const u = cssK() / st.view.s;
  const ring = (r, color, dash, lw) => { if (r.length < 2) return; g.beginPath(); r.forEach((p, i) => { const [x, y] = px(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath(); g.setLineDash(dash || []); g.strokeStyle = color; g.lineWidth = lw; g.stroke(); g.setLineDash([]); };
  // the property line (dashed white) and the traced lawn, at a width of v canvas pixels a screen pixel
  const traces = (v) => { for (const r of st.parcel) ring(r, 'rgba(255,255,255,.8)', [6 * v, 4 * v], 2 * v); for (const r of st.lawn) ring(r, CSS.lawn, null, 2 * v); };
  /* A WALK'S GROUND (askSurfaces; scan/tools/surfaces.py, 2026-11-24, the owner: "Lawn shape refinement and driveway
     marking?"): each square foot the walk's ground points called paving (grey) or grass (pale green), by the phone's
     own labels, or bare ground in a patch of 4 sq ft or more (brown; the owner: bare areas "larger than like 4 sqft"
     are not grass), UNDER the traced lawn's line, so where the two disagree shows. */
  if (st.surfaces?.kinds && st.frame && st.origin) {
    const S = st.surfaces, c = S.cellM || 0.3048, [oe, on] = Array.isArray(S.origin) ? toLocal(st.origin, S.origin) : [0, 0];
    // turf in light blue-green (the owner, 2026-11-24: the faint green was too near the trees' dark green), each kind
    // switched on and off by its box under the map, all of them as strong as the slider says
    const A = layerAlpha(), fill = { 1: `rgba(79, 224, 210, ${A})`, 2: `rgba(184, 184, 204, ${A})`, 3: `rgba(192, 132, 74, ${A})` };
    const on_ = { 1: layerOn('turf'), 2: layerOn('paved'), 3: layerOn('bare') };
    const er = st.erased, showEr = layerOn('erased') && layers().erased === true;
    for (let r = 0; r < S.h; r++) for (let q = 0; q < S.w; q++) {
      const k = S.kinds[r * S.w + q];
      if (!k) continue;
      const gone = er && er.has(`g:${S.i0 + q},${S.j0 + r}`);
      if (gone ? !showEr : !on_[k]) continue;
      const e0 = oe + (S.i0 + q) * c, n0 = on + (S.j0 + r) * c, a = px([e0, n0 + c]), b = px([e0 + c, n0]);
      g.fillStyle = gone ? `rgba(230, 60, 60, ${A})` : fill[k];
      g.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(1, Math.abs(b[0] - a[0])), Math.max(1, Math.abs(b[1] - a[1])));
    }
  }
  traces(u);
  if (st.photoChoice === 'lidar') lidarLines(g, u);
  // a point: a ring with a fine cross at its exact spot (the photo shows through), and its name beside it
  const dot = (map, color, label, r = 9, chosen = false) => {
    const [x, y] = px(map), R = r * u;
    g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.lineWidth = (chosen ? 4 : 3) * u; g.strokeStyle = color; g.stroke();
    g.beginPath(); g.arc(x, y, R + 1.5 * u, 0, Math.PI * 2); g.lineWidth = 1 * u; g.strokeStyle = '#fff'; g.stroke();
    g.beginPath(); g.moveTo(x - R * 0.6, y); g.lineTo(x + R * 0.6, y); g.moveTo(x, y - R * 0.6); g.lineTo(x, y + R * 0.6); g.lineWidth = 1.2 * u; g.strokeStyle = '#fff'; g.stroke();
    if (label) { g.font = `bold ${15 * u}px system-ui, sans-serif`; g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.85)'; g.lineWidth = 4 * u; g.strokeText(label, x + R + 4 * u, y - R * 0.4); g.fillText(label, x + R + 4 * u, y - R * 0.4); }
  };
  for (const p of st.pins) if (p.map) dot(p.map, CSS.pin, p.name, 7);
  // a walk's plants (askPlants): each square foot where plant was seen 3 ft up or more, darker the higher it reached
  if (st.plants?.boxes?.length && st.frame && st.origin && layerOn('plants')) {
    const c = st.plants.cellM || 0.3048, top = new Map();
    // a walk made on another map of this lot (plants.origin, the main site's plantsOfPlace) is measured from that map's point
    const [oe, on] = Array.isArray(st.plants.origin) ? toLocal(st.origin, st.plants.origin) : [0, 0];
    for (const [i, j, , hi] of st.plants.boxes) { const k = `${i},${j}`; if (!(top.get(k) >= hi)) top.set(k, hi); }
    for (const [k, hi] of top) {
      if (st.erased?.has(`p:${k}`) && !(layers().erased === true)) continue;
      const [i, j] = k.split(',').map(Number), a = px([oe + i * c, on + (j + 1) * c]), b = px([oe + (i + 1) * c, on + j * c]);
      g.fillStyle = st.erased?.has(`p:${k}`) ? `rgba(230, 60, 60, ${layerAlpha()})` : `rgba(30, ${hi >= 24 ? 110 : 170}, 60, ${Math.min(1, layerAlpha() * (hi >= 24 ? 1.1 : 0.8))})`;
      g.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(1, Math.abs(b[0] - a[0])), Math.max(1, Math.abs(b[1] - a[1])));
    }
  }
  // the things placed on earlier walks (things.js), by their ids, so the list under the map says which is which
  if (layerOn('things')) for (const t of st.placed || []) if (!t.gone && t.at) dot(t.at, THING_CSS[t.kind] || '#ddd', t.id, 7);
  roofMarks(g, u);
  for (const p of shownPoints()) dot(p.map, p.kind === 'ref' ? CSS.ref : CSS.check, p.name, 14, p === st.dragging);
  // WHILE DRAGGING, A MAGNIFIER: the photo round the point four times closer, in the top corner away from the finger
  if (st.dragging) {
    const [x, y] = px(st.dragging.map), k = cssK(), R = 70 * k, Z = 4;
    const cx = st.dragLoupeLeft ? R + 10 * k : cv.width - R - 10 * k, cy = R + 10 * k;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#2a332f'; g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    const zs = st.view.s * Z;
    g.imageSmoothingEnabled = zs < 6;
    g.setTransform(zs, 0, 0, zs, cx - x * zs, cy - y * zs);
    if (st.photo) g.drawImage(st.photo, 0, y0);
    traces(k / zs); // the lawn's and the lot's lines in the magnifier too (the owner, 2026-11-10)
    if (st.photoChoice === 'lidar') lidarLines(g, k / zs);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.lineWidth = 1.5 * k; g.strokeStyle = st.dragging.kind === 'ref' ? CSS.ref : CSS.check; g.stroke();
    g.restore();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.lineWidth = 3 * k; g.strokeStyle = '#fff'; g.stroke();
    g.font = `bold ${14 * k}px system-ui, sans-serif`; g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.85)'; g.lineWidth = 4 * k;
    g.strokeText(st.dragging.name, cx - R + 8 * k, cy + R - 10 * k); g.fillText(st.dragging.name, cx - R + 8 * k, cy + R - 10 * k);
    g.setTransform(st.view.s, 0, 0, st.view.s, st.view.ox, st.view.oy);
  }
  if (st.L && st.ar?.pose && st.walk) { const me = mapOf(st.L, st.ar.pose.position, st.walk.odo); if (me) dot(me, '#ffeb3b', 'you', 7); }
}
/**
 * THE LIDAR'S RAISED THINGS AS STRAIGHT LINES, AND THEIR CORNERS (lib/lidar-marks.js; the owner, 2026-11-10: "The
 * blurry edge is just too imprecise for human eyes to decide where the edge is"). A roof dark, a deck, wall, shed or hot
 * tub orange (an upper level deeper), each edge a crisp line; a corner a white dot when the laser pins it to about a
 * foot, a hollow yellow ring when it does not (a wall's end the laser's last hit may stop short of); a small round
 * thing's middle a white cross. u: canvas pixels a screen pixel.
 */
/* Only what lies on the photo (the owner, 2026-11-10: "2 are off the lidar image so I can't tell what they are"): the
   corners are found over the lot and 20 m round it, the picture is drawn in the photo's frame. */
const onPhoto = (at) => { if (!at || !st.frame) return true; const q = toPx(st.frame, st.origin, at, photoW(), photoH()); return q[0] >= 0 && q[1] >= 0 && q[0] <= photoW() && q[1] <= photoH(); };
// a thing's middle (2026-11-10: the worker did not send it, onPhoto threw, and nothing was drawn): its ring's otherwise
const middleOf = (o) => o.middle || (o.ring?.length ? [o.ring.reduce((t, p) => t + p[0], 0) / o.ring.length, o.ring.reduce((t, p) => t + p[1], 0) / o.ring.length] : null);
function lidarLines(g, u) {
  const M = st.lid.overlay?.picture?.marks; if (!M) return;
  for (const o of M.objects) {
    if (!o.ring || o.ring.length < 3 || !onPhoto(middleOf(o))) continue;
    g.beginPath(); o.ring.forEach((p, i) => { const [x, y] = px(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath();
    if (o.kind === 'paving') { g.fillStyle = 'rgba(120,170,255,.22)'; g.fill(); g.setLineDash([5 * u, 3 * u]); g.lineWidth = 2 * u; g.strokeStyle = '#9cc4ff'; g.stroke(); g.setLineDash([]); continue; }
    g.fillStyle = o.kind === 'building' ? 'rgba(18,18,22,.85)' : o.top > 2.5 ? 'rgba(210,95,0,.7)' : 'rgba(255,150,40,.6)';
    g.fill(); g.lineWidth = 2 * u; g.strokeStyle = '#fff'; g.stroke();
  }
  for (const c of M.corners) {
    if (!onPhoto(c.at)) continue;
    const [x, y] = px(c.at), r = 5 * u;
    if (c.kind === 'middle') { g.beginPath(); g.moveTo(x - r, y); g.lineTo(x + r, y); g.moveTo(x, y - r); g.lineTo(x, y + r); g.lineWidth = 2.5 * u; g.strokeStyle = '#fff'; g.stroke(); continue; }
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    if (c.sure) { g.fillStyle = '#fff'; g.fill(); g.lineWidth = 1.5 * u; g.strokeStyle = '#000'; g.stroke(); }
    else { g.lineWidth = 2 * u; g.strokeStyle = '#ffd400'; g.stroke(); }
  }
}

/**
 * THE ROOF CORNERS A WALK MAY TAKE AS REFERENCES (lib/roof-corner.js; the owner, 2026-11-11: "the user should either be
 * able to pick the corners, or have them shown to them on the map that their lawn was traced on"): each offered
 * corner as a white diamond, on whichever picture is showing, where the LIDAR has it (a photo's roof leans, so a
 * diamond may sit a few feet off the roof's corner in the photo: it says which corner, not where the photo has it).
 * A tap on one makes it a reference.
 */
const roofFree = () => (st.againMode ? [] : (st.lid.roofs || []).filter((c) => onPhoto(c.at) && !(st.points || []).some((p) => p.roof && Math.hypot(p.map[0] - c.at[0], p.map[1] - c.at[1]) < 0.3)));
function roofMarks(g, u) {
  for (const c of roofFree()) {
    const [x, y] = px(c.at), r = 9 * u;
    g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
    g.fillStyle = 'rgba(255,255,255,.25)'; g.fill(); g.lineWidth = 2.5 * u; g.strokeStyle = '#000'; g.stroke(); g.lineWidth = 1.5 * u; g.strokeStyle = '#fff'; g.stroke();
  }
}
function roofAt(b) {
  const reach = 28 * cssK() / (st.view?.s || 1); let best = null, bd = reach;
  for (const c of roofFree()) { const [x, y] = px(c.at), d = Math.hypot(x - b[0], y - b[1]); if (d < bd) { bd = d; best = c; } }
  return best;
}

/** Points that were put on a corner follow it when the corners are found again (lib/guide.js resnap): the map's lot or
    lawn changed, so the box the corners are found over did, and a corner can come out a foot or two away. */
function backOnCorners() {
  if (st.walk || !st.points.length) return;
  const r = resnap(st.points, st.lid.overlay?.picture?.marks?.corners || [], st.lid.roofsAny?.length ? st.lid.roofsAny : st.lid.roofs || []);
  if (!r.moved.length) return;
  savePoints(); listPoints(); drawMap();
  log(`points put back on their corners: ${r.moved.map((m) => `${m.name} ${m.m} m`).join(', ')}`);
  flash(`${r.moved.map((m) => m.name).join(', ')} moved back onto ${r.moved.length === 1 ? 'its corner' : 'their corners'} (the map's shapes changed)`);
}

/* A POINT ON A ROOF CORNER IS A ROOF CORNER, DIAMOND OR NOT (the owner, 2026-11-15: "They're all roof corners but
   they're not diamonds... There shouldn't [be] ground points, we never talked about that"). The diamonds are only
   the corners the tiers offer; a reference put on any other building corner was kept as a ground point, which the
   walk never asks for, so R1 was marked and then nothing. Any building corner whose eave the lidar can tell
   (roof-corner.js roofCornersAny) makes the point a roof corner: when it is placed, and for the points already on
   the map when the lidar is read. */
const roofNear = (at, reach = 0.6) => { let best = null, bd = reach; for (const c of st.lid.roofsAny || []) { const d = Math.hypot(c.at[0] - at[0], c.at[1] - at[1]); if (d <= bd) { bd = d; best = c; } } return best; };
const roofOf = (rc) => ({ eaveM: rc.eaveM, label: rc.label, sure: rc.sure, within: rc.within, offLot: !!rc.offLot, picked: !!rc.picked });
function roofsFromPoints() {
  if (st.walk) return;
  const made = [];
  for (const p of st.points || []) {
    if (p.roof || p.kind !== 'ref' || !p.map) continue;
    const rc = roofNear(p.map);
    if (rc) { p.roof = roofOf(rc); p.map = rc.at.slice(); made.push(p.name); }
  }
  if (!made.length) return;
  savePoints();
  log(`points on roof corners made roof corners: ${made.join(', ')}`);
  flash(`${made.join(', ')}: on a roof corner, so ${made.length === 1 ? 'it is' : 'they are'} sighted like R1`);
}

/** A point placed on the lidar view goes to the corner within a fingertip, when there is one. */
function snapped(at) {
  if (st.photoChoice !== 'lidar') return { at, snap: null };
  const reach = (28 * cssK()) / st.view.s * (photoW() ? Math.abs(unpx([1, 0])[0] - unpx([0, 0])[0]) : 0);
  const M = st.lid.overlay?.picture?.marks;
  const c = snapTo(M && { corners: M.corners.filter((k) => onPhoto(k.at)) }, at, reach);
  return c ? { at: c.at.slice(), snap: { kind: c.kind, of: c.of, sure: !!c.sure, within: c.within ?? null } } : { at, snap: null };
}
const snapWord = (sn) => (!sn ? 'not on a corner' : sn.kind === 'middle' ? 'on a small thing\'s middle' : sn.sure ? 'on a corner the laser pins (about a foot)' : `on a corner the laser does not pin${sn.within ? ` (within ${Math.round(sn.within * 3.281 * 10) / 10} ft)` : ''}`);

/** Canvas pixels per screen pixel: the map canvas is the photo's own size, shown at the page's width. */
function cssK() { const cv = $('#map'), r = cv?.getBoundingClientRect(); return r && r.width ? cv.width / r.width : 1; }
const MAX_ZOOM = 40;
function clampView() {
  const cv = $('#map'), w = cv.width, h = cv.height, s = st.view.s;
  st.view.ox = Math.min(0, Math.max(w - w * s, st.view.ox)); st.view.oy = Math.min(0, Math.max(h - h * s, st.view.oy));
}
function zoomAt(f, [x, y]) {
  const s0 = st.view.s, s1 = Math.max(1, Math.min(MAX_ZOOM, s0 * f));
  st.view.ox = x - ((x - st.view.ox) * s1) / s0; st.view.oy = y - ((y - st.view.oy) * s1) / s0; st.view.s = s1;
  clampView(); drawMap();
}
function listPoints() {
  const el = $('#points');
  const rn = $('#roof-note');
  if (rn) { const R = st.lid?.roofs; rn.hidden = !R; if (R) rn.textContent = R.length ? `Roof corners: ${R.filter((c) => !c.offLot).length} sure (white diamonds) on your lot${R.some((c) => c.offLot) ? `, and ${R.filter((c) => c.offLot).length} on a neighbour's building (usable if you can stand where you see them; not counted as yours)` : ''}. The circles are the less sure corners: they can be chosen too, and two of them do for one diamond. Tap one to make it a reference; in the walk you aim up at it from two places and it marks itself.${R.some((c) => c.tier === 2) ? ` Fewer than three met the first rule (15 ft up, 15 ft from the lawn), so ${R.filter((c) => c.tier === 2).length} more are offered up to 18 ft up and 30 ft from the lawn.` : ''}` : 'No roof corner is offered on this map: none has two long straight roof edges, under 18 ft up and within 30 ft of the lawn.'; }
  againTools();
  if (st.againMode) {
    const t = againTodo();
    el.innerHTML = st.points.map((p) => `<li><span style="color:${p.kind === 'ref' ? CSS.ref : CSS.check};font-weight:600">${esc(p.name)}</span> ${p.again ? 'placed again' : p === t ? '<strong>tap its spot now</strong>' : 'to do'}</li>`).join('');
    return;
  }
  el.innerHTML = st.points.map((p) => `<li><span style="color:${p.kind === 'ref' ? CSS.ref : CSS.check};font-weight:600">${esc(p.name)}</span> ${p.roof ? `reference · the roof's ${esc(p.roof.label)}, ${Math.round(p.roof.eaveM * 3.281)} ft up (in the walk: aim up at it from two places; it marks itself)` : p.kind === 'ref' ? 'reference' : 'check point'}${p.on === 'lidar' ? (p.snap ? (p.snap.kind === 'middle' ? ' · on a small thing\'s middle' : p.snap.sure ? ' · on a sure corner' : ' · on a less sure corner') : ' · on the lidar, not on a corner') : ''}</li>`).join('') || '<li class="dim">None yet. Tap the photo.</li>';
}
function wireMap() {
  const cv = $('#map'), ptrs = new Map();
  let drag = null, downAt = null, pan = null, pinch = null, moved = false, downT = 0, dragFrom = null;
  /* A POINT MOVES ONLY WHEN MEANT TO (the owner, 2026-11-10: a check point had "moved from where I placed it, by a
     great distance... It could've been an accidental touch", another by 2-3 ft). Two faults: a finger that came down
     near a point and slid moved the point where it meant to move the map, and "slid" was 12 CANVAS pixels, three
     screen pixels on a phone, so a plain touch on a point nudged it by feet. Now a finger must rest on the point for
     HOLD_MS before it picks it up (a slide before that moves the map), a slide is SLIDE screen pixels, and every move
     is said, with how far. A mouse picks a point up at once. */
  const HOLD_MS = 280, SLIDE = 10;
  const canvasXY = (ev) => { const r = cv.getBoundingClientRect(); return [((ev.clientX - r.left) / r.width) * cv.width, ((ev.clientY - r.top) / r.height) * cv.height]; };
  const toBase = ([x, y]) => [(x - st.view.ox) / st.view.s, (y - st.view.oy) / st.view.s];
  const hitR = () => (24 * cssK()) / st.view.s; // about a fingertip, at any zoom
  // the nearest point within reach (two close together: the one under the finger)
  const hitAt = (b) => { let best = null, bd = hitR(); for (const p of shownPoints()) { const [x, y] = px(p.map), d = Math.hypot(x - b[0], y - b[1]); if (d < bd) { bd = d; best = p; } } return best; };
  cv.addEventListener('pointerdown', (ev) => {
    cv.setPointerCapture(ev.pointerId); ptrs.set(ev.pointerId, canvasXY(ev));
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s0: st.view.s, base: toBase([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) }; if (drag) delete drag.grab; drag = null; st.dragging = null; pan = null; downAt = null; return; }
    if (ptrs.size > 2) return;
    const xy = canvasXY(ev), b = toBase(xy);
    // THE ERASER (2026-11-24): one finger erases, two still move and zoom the map
    if (st.eraser && ptrs.size === 1) { st.eraseStroke = []; eraseAt(unpx(b)); downAt = null; pan = null; drag = null; drawMap(); return; }
    if (st.eraser && st.eraseStroke) { undoStroke(st.eraseStroke); st.eraseStroke = null; }
    downAt = xy; moved = false; downT = ev.pointerType === 'mouse' ? -Infinity : performance.now();
    const hit = hitAt(b);
    // a point keeps where the finger took hold of it, so it moves beside the finger, not under it
    pan = { x: xy[0], y: xy[1], ox: st.view.ox, oy: st.view.oy };
    if (hit) { const [hx, hy] = px(hit.map); drag = hit; drag.grab = [hx - b[0], hy - b[1]]; dragFrom = hit.map.slice(); }
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!ptrs.has(ev.pointerId)) return;
    ptrs.set(ev.pointerId, canvasXY(ev));
    if (pinch && ptrs.size >= 2) { const [a, b] = [...ptrs.values()], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; st.view.s = Math.max(1, Math.min(MAX_ZOOM, pinch.s0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d0)); st.view.ox = mid[0] - pinch.base[0] * st.view.s; st.view.oy = mid[1] - pinch.base[1] * st.view.s; clampView(); drawMap(); return; }
    const xy = canvasXY(ev);
    if (st.eraser && st.eraseStroke && ptrs.size === 1) { eraseAt(unpx(toBase(xy))); drawMap(); return; }
    if (downAt && !moved && Math.hypot(xy[0] - downAt[0], xy[1] - downAt[1]) > SLIDE * cssK()) {
      moved = true;
      // slid before the hold was up: the finger meant the map, not the point
      if (drag && performance.now() - downT < HOLD_MS) { delete drag.grab; drag = null; }
    }
    if (drag && moved) { const b = toBase(xy), gr = drag.grab || [0, 0]; drag.map = unpx([b[0] + gr[0], b[1] + gr[1]]); st.dragging = drag; st.dragLoupeLeft = xy[0] > cv.width / 2; drawMap(); } else if (pan && moved) { st.view.ox = pan.ox + xy[0] - pan.x; st.view.oy = pan.oy + xy[1] - pan.y; clampView(); drawMap(); }
  });
  const up = (ev, cancelled) => {
    ptrs.delete(ev.pointerId);
    if (st.eraser && st.eraseStroke) { if (st.eraseStroke.length) { st.eraseUndo.push(st.eraseStroke); saveErased(); } st.eraseStroke = null; downAt = null; pan = null; drag = null; drawMap(); return; }
    if (pinch) { if (ptrs.size < 2) pinch = null; downAt = null; drag = null; pan = null; return; }
    const xy = canvasXY(ev);
    if (drag && moved && drag.roof && dragFrom) { drag.map = dragFrom.slice(); delete drag.grab; drag = null; st.dragging = null; flash('A roof corner stays where the lidar has it. Delete it to choose another.'); drawMap(); return; }
    if (drag && moved && !drag.of && st.photoChoice === 'lidar') { const sp = snapped(drag.map); drag.map = sp.at; drag.snap = sp.snap || undefined; }
    if (drag && moved) {
      const far = dragFrom ? Math.hypot(drag.map[0] - dragFrom[0], drag.map[1] - dragFrom[1]) * 3.281 : 0;
      flash(`${drag.name} moved ${far < 10 ? far.toFixed(1) : Math.round(far)} ft`); log(`point ${drag.name} moved ${far.toFixed(1)} ft on the map`);
    }
    if (drag && moved) { delete drag.grab; if (drag.of) drag.of.again = { on: st.photoChoice || null, map: drag.map }; else drag.on = st.photoChoice || undefined; drag = null; st.dragging = null; savePoints(); listPoints(); drawMap(); return; }
    const tap = !cancelled && downAt && !moved;
    if (drag) delete drag.grab;
    drag = null; pan = null; downAt = null; st.dragging = null;
    if (!tap) { drawMap(); return; }
    const b = toBase(xy);
    if (hitAt(b)) return;
    if (st.againMode) {
      const t = againTodo(); if (!t) return;
      t.again = { on: st.photoChoice || null, map: unpx(b) }; st.againShown = null;
      savePoints(); listPoints(); drawMap();
      if (!againTodo()) flash('Every point placed again. Tap "Done" to go back.');
      return;
    }
    const rc = roofAt(b);
    if (rc) {
      st.points.push({ id: `${Date.now()}`, kind: 'ref', name: nextName('ref'), map: rc.at.slice(), roof: { eaveM: rc.eaveM, label: rc.label, sure: rc.sure, within: rc.within, offLot: !!rc.offLot } });
      flash(`${st.points[st.points.length - 1].name}: ${rc.offLot ? "a neighbour's roof, its" : "the roof's"} ${rc.label}, ${Math.round(rc.eaveM * 3.281)} ft up`);
      savePoints(); listPoints(); drawMap(); return;
    }
    const sp = snapped(unpx(b));
    // a reference put on a building corner that has an eave is a roof corner, offered as a diamond or not
    const anyRoof = st.adding === 'ref' ? roofNear(sp.at) : null;
    st.points.push({ id: `${Date.now()}`, kind: st.adding, name: nextName(st.adding), map: anyRoof ? anyRoof.at.slice() : sp.at, on: st.photoChoice || undefined, snap: sp.snap || undefined, roof: anyRoof ? roofOf(anyRoof) : undefined });
    if (anyRoof) flash(`${st.points[st.points.length - 1].name}: a roof corner (${anyRoof.label}, ${Math.round(anyRoof.eaveM * 3.281)} ft up)`);
    else if (st.adding === 'ref' && !st.tapMode) flash(`${st.points[st.points.length - 1].name} is NOT on a roof corner the lidar knows: the walk will not ask for it. Put it on a building's corner.`);
    else if (st.photoChoice === 'lidar') flash(`${st.points[st.points.length - 1].name} ${snapWord(sp.snap)}`);
    savePoints(); listPoints(); drawMap();
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
    document.querySelectorAll('[data-add]').forEach((x) => { x.classList.toggle('plain', x !== b); });
  }));
  $('#undo-point').addEventListener('click', () => {
    if (st.againMode) { const done = st.points.filter((p) => p.again); if (done.length) delete done[done.length - 1].again; st.againShown = null; }
    else st.points.pop();
    savePoints(); listPoints(); drawMap();
  });
  /* A NEW SET (the owner, 2026-11-10: new check points placed where they can be found again exactly) */
  $('#new-set')?.addEventListener('click', () => {
    if (st.points.length && !confirm(`Remove all ${st.points.length} points and start a new set?`)) return;
    st.points = []; st.againMode = false; st.againShown = null; savePoints(); listPoints(); drawMap();
  });
  $('#again')?.addEventListener('click', () => againStart());
  $('#again-done')?.addEventListener('click', () => againStop());
  $('#clear-pins').addEventListener('click', () => { st.pins = []; savePins(); drawMap(); });
}

/* ------------------------------------------------------ the lot's lidar */

function startLidar(m) {
  try {
    const w = new Worker('/lidar-worker.js', { type: 'module' });
    st.lid.worker = w; st.lid.noReturns = false;
    const pts = [...st.lawn.flat(), ...st.parcel.flat()], es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
    const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
    w.onmessage = ({ data }) => {
      if (data.progress) { st.lid.progress = data.progress; showLidar(); }
      if (data.noReturns) { st.lid.noReturns = true; showLidar(); }
      if (data.ready) { pagePerf.stage('lidar read'); st.lid.ready = data.ready; log(`lidar model read: ${data.ready.points} columns, ${data.ready.solid} solid cells, shift ${data.ready.shift}`); showLidar(); keepShadeFresh(m, data.ready); }
      if (data.roofs) { st.lid.roofs = data.roofs; st.lid.roofsAny = data.roofsAny || []; log(`roof corners offered: ${data.roofs.length} (of ${st.lid.roofsAny.length} building corners with an eave)`); backOnCorners(); roofsFromPoints(); drawMap(); listPoints(); }
      if (data.ground) { st.lid.ground = data.ground; groundPhoto().catch((e) => log(`lidar ground picture: ${e.message}`)); }
      if (data.marks && st.L) st.L.spacing = data.marks.spacing ?? st.L.spacing;   // each mark's own allowance (locate.js mark)
      if (data.marks && st.lid.overlay?.picture) { st.lid.overlay.picture.marks = data.marks; backOnCorners(); if (st.photoChoice === 'lidar') { photoTools(); drawMap(); } }
      if (data.overlay) { st.lid.overlay = data.overlay; st.lid.meshes = null; lidarPhoto().catch((e) => log(`lidar picture: ${e.message}`)); log(`lidar overlay: ${data.overlay.solids.length / 4} solid cells, ${data.overlay.tall.length / 5} tall cells`); }
      if (data.error) { st.lid.error = data.error; log(`lidar: ${data.error}`); showLidar(); if (/no lidar model yet/.test(data.error)) keepShadeFresh(m, null); }
      if (data.walk && st.L && st.walkAsk && data.id === st.walkAsk.id) {
        const a = st.walkAsk; st.walkAsk = null;
        if (data.walk.ok) {
          const first = !st.L.walk?.ok;
          st.L.walk = { ...data.walk, walkedM: a.odo, from: a.from.replace(/ \(.*$/, ''), at: Date.now() };
          st.walkStats.ok++; if (st.walkStats.firstOkM == null) st.walkStats.firstOkM = Math.round(a.odo);
          if (first) flash('Placed by the whole walk so far');
        } else st.walkStats.lastWhy = data.walk.why;
      }
      if (data.fix && st.L) { const f = answer(st.L, data.fix, data.id); if (f && st.L.log.at(-1)?.held === 'first') flash('You are here: the lidar found you'); }
    };
    w.onerror = (e) => { st.lid.error = e.message || 'the lidar reader failed'; showLidar(); };
    w.postMessage({ load: { origin: st.origin, box, map: st.map, lawn: st.lawn, parcel: st.parcel } });
  } catch (e) { st.lid.error = e.message; showLidar(); }
}
/**
 * THE SHADE MODEL KEPT UP TO DATE (the owner, 2026-11-09: "when a user visits the AR tool, it checks to see if the
 * most recent version of the shade map has been loaded and saved for that map. If the most recent version hasn't been
 * loaded, it calls the shade maps tools and updates it. It needs to retain any edits that have been to the shade map,
 * including fences and erased branches/trees"). Out of date: no model, a model with no build stamp or an older one
 * than the shade map's own (public/shade/build.js SHADE_BUILD), or built from an older save of the map than this one.
 * Then the shade map's own rebuild (public/shade/rebuild.js, the features session's: the lidar kept with the map, the
 * same steps as the shade page, the person's erasures and fences applied) builds and saves it, and the page reads it
 * again. Once per visit; a map never opened in the shade map is sent there.
 */
async function keepShadeFresh(m, ready) {
  if (st.lid.rebuilt || st.lid.rebuilding || !st.map) return;
  let build = null;
  try { ({ SHADE_BUILD: build } = await import('/lib/shade/build.js')); } catch { return; } // a scan site before the stamp
  const when = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };
  const why = !ready ? 'there is none yet'
    : !Number.isFinite(ready.modelBuild) || ready.modelBuild < build ? 'the shade map has changed since it was built'
      : when(ready.modelBasedOn) != null && when(m.at) != null && when(ready.modelBasedOn) < when(m.at) ? 'the map was saved again since'
        : null;
  if (!why) return;
  st.lid.rebuilding = true;
  log(`shade model out of date (${why}): rebuilding`);
  const say = (w) => { st.lid.progress = `Updating the lidar from the shade map (${why}): ${w}`; if (!st.lid.ready) showLidar(); else { const el = $('#lidar'); if (el) el.textContent = st.lid.progress; } };
  say('starting…');
  let r;
  try {
    const { rebuildModel } = await import('/lib/shade/rebuild.js');
    r = await rebuildModel(st.map, { onProgress: say, lazSrc: '/lib/vendor/laz-perf.js' });
  } catch (e) { r = { ok: false, why: e.message || String(e) }; }
  st.lid.rebuilding = false; st.lid.rebuilt = true;
  if (r?.ok) {
    log(`shade model rebuilt (build ${r.build}, ${r.fences ?? 0} fences, ${r.erased ?? 0} erasures kept)`);
    try { st.lid.worker?.terminate(); } catch { /* gone */ }
    st.lid = { ...st.lid, worker: null, ready: null, error: null, progress: 'Reading the updated lidar…', noReturns: false, overlay: null, meshes: null, ground: null, roofs: null };
    showLidar();
    startLidar(m);
    return;
  }
  const words = r?.words || (r?.why === 'not-in-shade-map' ? 'Open this map in the shade map once, so its lidar is chosen and lined up; then come back.' : `The lidar could not be updated (${r?.why || 'no answer'}).`);
  log(`shade model not rebuilt: ${r?.why}`);
  if (st.lid.ready) { const el = $('#lidar'); if (el) el.textContent = `${words} The saved lidar is used meanwhile.`; } else { st.lid.error = words; showLidar(); }
}
function showLidar() {
  const el = $('#lidar'); if (!el) return;
  el.textContent = st.lid.error ? `The lidar could not be read (${st.lid.error}): references only.`
    : st.lid.ready ? `Lidar ready: the shade map's model, ${st.lid.ready.points.toLocaleString()} columns, ${st.lid.ready.solid.toLocaleString()} solid cells (walls, fences, trunks), lined up by ${st.lid.ready.shift}; buildings by ${st.lid.ready.rule || 'the AR copy'}${st.lid.ready.lawnEdge ? '; the lawn\'s edges matched too' : ''}${st.lid.ready.structures ? ` (${st.lid.ready.structures.building.toLocaleString()} m² of building)` : ''}.`
      : st.lid.progress || 'Reading the lidar…';
  // a lot so big that the shade map's file kept no lidar returns: nothing to outline or take corners from
  if (st.lid.noReturns && !st.lid.error) el.textContent += ' The lidar model kept no returns for this lot (it is too big to keep them all), so no outlines or roof corners are offered: put the references on the photo instead.';
}

/* --------------------------------------------------------------- the AR */

function flash(text) { const f = $('#flash'); f.textContent = text; f.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => f.classList.remove('show'), 2400); }
const log = (what) => { st.errors.push({ t: Date.now(), what }); if (st.errors.length > 80) st.errors.shift(); };

async function startAR(engine, { anyway = false } = {}) {
  // the map first (see openMap): at most 12 s, then the walk starts as it used to
  if (st.mapBusy && !st.map) { flash('Finding your map first…'); for (let i = 0; i < 48 && st.mapBusy && !st.map; i++) await new Promise((r) => setTimeout(r, 250)); if (st.map) for (let i = 0; i < 20 && st.mapBusy; i++) await new Promise((r) => setTimeout(r, 250)); }
  /* NO WALK THAT CANNOT BE KEPT (refkeep.js cornersShort; the owner, 2026-11-16): two roof corners, well apart, are
     checked here, before the walk, not found missing after it. A replay, a testing-only walk and the backup mode are
     not held up; "Start anyway" starts it knowing it will not be kept. */
  // the roof corners are known once the lidar is read (a point becomes a roof corner on it): until then, say so
  const short = !anyway && st.map && !st.replayOf && !st.recordOnly && !st.tapMode
    ? (st.lid?.error ? `This map has no lidar (${st.lid.error}), so it has no roof corners to line a walk up by.` : st.lid?.noReturns ? 'The lidar model kept no returns for this lot, so it offers no roof corners to line a walk up by.' : !st.lid?.ready || !st.lid.roofs ? 'The lidar is still being read: the roof corners are checked once it is. Try again in a moment.' : cornersShort(st.points))
    : null;
  if (short) {
    const box = $('#start'), old = box.querySelector('.corners-short'); if (old) old.remove();
    const card = document.createElement('div'); card.className = 'card corners-short';
    card.innerHTML = `<strong>Choose the roof corners first</strong><p>${esc(short)}</p>`;
    const go = document.createElement('button'); go.type = 'button'; go.className = 'plain'; go.textContent = 'Start anyway (this walk will not be kept as the reference)';
    go.addEventListener('click', () => { card.remove(); startAR(engine, { anyway: true }); });
    card.append(go); box.prepend(card); card.scrollIntoView?.({ block: 'center' });
    flash('Choose two roof corners first');
    return;
  }
  const overlay = $('#overlay');
  pagePerf.stage('AR asked'); st.wperf = newPerf(); st.wperfAsked = performance.now(); st.wperfShapes = false;
  st.walk = newWalk({ engine, phone: navigator.userAgent });
  /* SENT AFTER THE WALK, NOT DURING IT, when asked (2026-11-24; the owner: "I'm wonder if the continuous upload during
     the walks is part of the problem with stuttering and jumps"): parts are still kept on the phone as they come, and
     go when the walk ends. The walk's summary says which way it was made and how its frames went while parts were
     being sent and while none were (lib/perf.js), so two walks answer the question. */
  st.holdUploads = st.holdLast = !!$('#hold-uploads')?.checked;
  if (st.holdUploads) st.outbox?.hold?.(true);
  tellApp(st.upStatus || { pending: 0 });   // the keep-running service starts now, while the app is in front
  st.dy = null; st.dyFrom = null; st.gpsTrail = []; st.anchors = newAnchors(); st.nudge = null; st.depthFill = null; st.geoTrail = []; st.geoSeen = null; st.sem = newSemCount(); st.lastSem = null; st.semDims = null; st.occ = null; st.occFull = 0; st.occAt = 0; st.walkGround = new Map(); st.spikes = { pictures: 0, cells: 0, flagged: 0 }; st.walkAsk = null; st.walkAt = 0; st.walkStats = { asks: 0, ok: 0, lastWhy: null, firstOkM: null }; st.crumbs = newCrumbs();
  st.walk.checks = [];
  st.L = newLocate(); st.L.spacing = st.lid.overlay?.picture?.marks?.spacing ?? null; st.sight = null; st.sightPaused = false; st.sightEndedAt = 0; st.roofsDone = null; st.resighted = new Set(); st.resightOf = null; st.rescan = null;
  st.prevStand = new Map(); st.prevGround = new Map(); st.prevAsk = null; st.prevCand = null; st.prevAt = 0; st.prevStats = { asks: 0, ok: 0, lastWhy: null, firstOkM: null, lastMs: null };
  // the owner's choice at the start (2026-11-11): the saved walk places this one, or this one is a fresh reference
  st.refUse = st.refMeta && refChoice() === 'saved';
  loadThings();
  if (st.refUse) loadReference(); else { st.ref?.worker?.terminate?.(); st.ref = st.map ? { map: st.map, worker: null, ready: null, none: true, error: null, fresh: !!st.refMeta } : null; log(st.refMeta ? 'earlier walk: not used (fresh chosen); this walk is kept as the new one' : 'earlier walk: none kept for this map; this walk is kept as it'); }
  mini.view = null; mini.mode = 'fit'; mini.locked = false; $('#arrows').innerHTML = '';
  st.surfCount = { grass: 0, pave: 0 };
  st.chosen = null; st.undoMarks = [];
  // the walk's twin (scan/lib/twin.js): its points, track and pictures go up to the site as it goes (src/twin.js)
  st.twin = newTwin({ walk: `${st.walk.startedAt}`, map: st.map || null, engine, started: st.walk.startedAt });
  st.twinUp = { queue: [], busy: false, off: null, sent: 0, failed: 0 };
  // for what only a dev build adds (the thermal camera, public/thermal.js): a walk began
  document.dispatchEvent(new CustomEvent('yard-walk', { detail: { phase: 'start', walk: `${st.walk.startedAt}`, replay: !!st.replayOf, placement: placementNow, send: (name, body) => sendTwin([{ name, type: 'application/json', body }]) } }));
  st.errors = []; st.ar = null; st.drawer = null;
  overlay.hidden = false; document.body.classList.add('in-ar');
  $('#hud').textContent = engine === '8thwall' ? 'Loading the engine… then the phone asks for the camera and the motion sensors.' : 'Starting…';
  const canvas = $('#cam');
  try {
    // bridge 3: this walk recorded by ARCore for replay (on unless turned off), or an earlier walk replayed
    st.recUp = null; st.started = null; st.geoDepthN = 0;
    st.tracker = await start({ engine, overlay, canvas, eightWallUrl: ENGINE_URL, onFrame, onEvent, rawDepth: !!st.rawDepth, record: st.replayOf || st.recordOff ? null : st.walk.startedAt, playback: st.replayOf || null,
      // the camera's picture: full resolution (1920x1080, pictures kept 1080 wide) when asked, or for the replay of a
      // walk recorded that way; else the smallest mode (640x480, pictures 480 wide; 1.10). Tracking, depth and labels
      // come from ARCore at their own sizes whichever is chosen.
      // A replay of a full-resolution walk may be asked to keep its pictures 480 wide, so one walk compares the two
      // (the owner, 2026-11-08: "Do we know that 480 is actually good enough?"); ARCore still plays the 1920x1080 mode.
      nativeOptions: { ...((st.replayOf ? st.replayImage === '1920x1080' : st.fullRes) ? { cameraImage: 'largest', grabW: st.replayOf && st.replaySmall ? 480 : 1080 } : {}),
        ...(new URLSearchParams(location.search).get('street') === '1' ? { streetscape: true } : {}) } });
    st.grabW = (st.replayOf ? st.replayImage === '1920x1080' : st.fullRes) && !(st.replayOf && st.replaySmall) ? 1080 : 480;
    st.walk.features = st.tracker.features;
    // GPS, only as a place to start the lidar search from; kept in memory, never in the copy
    if (st.origin && navigator.geolocation && !st.replayOf) { // a replay's place is the recording's, not the phone's now
      try { st.gpsWatch = navigator.geolocation.watchPosition((pos) => { if (!st.ar?.pose || !st.L) return; const p = st.ar.pose.position; st.L.gps = { at: toLocal(st.origin, [pos.coords.longitude, pos.coords.latitude]), acc: pos.coords.accuracy, phone: [p.x, -p.z], t: Date.now() };
            /* THE GPS TRAIL (2026-11-05: a walk without references has GPS's place but no heading; the trail of GPS
               readings against the session's own track gives both, over a long walk): one reading per 2 m walked */
            const tr = (st.gpsTrail = st.gpsTrail || []), g = st.L.gps, last = tr[tr.length - 1];
            if (!last || Math.hypot(g.phone[0] - last.phone[0], g.phone[1] - last.phone[1]) >= 2) { tr.push({ at: g.at, phone: g.phone, acc: g.acc, odo: st.walk?.odo ?? 0 }); if (tr.length > 3000) tr.shift(); } }, () => {}, { enableHighAccuracy: true, maximumAge: 2000 }); } catch { /* no GPS */ }
    }
  } catch (e) {
    log(`start failed: ${e.message}`);
    st.walk.endedAt = Date.now(); st.walk.failed = String(e.message || e);
    finish();
    $('#why').textContent = `AR would not start: ${e.message}`;
  }
}

/* RECORDINGS ON THE PHONE (the app's bridge 4; the owner: "make it so I can choose whether to remove a recording from
   my phone or not? I don't want to have to download every time to replay it"): keep them once sent (the default) or
   not, and remove any by hand; a replay uses the phone's copy when there is one. */
const phoneList = () => { try { return JSON.parse(window.LawnARNative.localRecordings()); } catch { return []; } };
function phoneRecordings(box) {
  const N = window.LawnARNative, wrap = document.createElement('div');
  wrap.style.margin = '8px 0';
  const keep = document.createElement('label'); keep.className = 'dim'; keep.style.display = 'block';
  keep.innerHTML = '<input type="checkbox" id="keep-rec"> Keep recordings on this phone once they are on the site (replays then use the phone\'s copy instead of fetching it)';
  wrap.append(keep);
  const list = document.createElement('div'); wrap.append(list);
  box.append(wrap);
  $('#keep-rec').checked = (() => { try { return N.keepRecordings(); } catch { return true; } })();
  $('#keep-rec').addEventListener('change', (e) => { try { N.setKeepRecordings(e.target.checked); } catch { /* old app */ } });
  const draw = () => {
    const recs = phoneList();
    list.innerHTML = recs.length ? `<p class="dim" style="margin:6px 0">On this phone (${Math.round(recs.reduce((a, r) => a + r.bytes, 0) / 1e6)} MB):</p>` : '';
    for (const r of recs) {
      const row = document.createElement('div'); row.className = 'dim'; row.style.margin = '4px 0';
      row.textContent = `${new Date(+r.walk).toLocaleString()}, ${Math.round(r.bytes / 1e6)} MB, ${r.sent ? 'on the site too' : 'not on the site yet'} `;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'plain'; b.textContent = 'Remove from phone';
      b.addEventListener('click', () => {
        if (!r.sent && !confirm('This recording is not on the site yet: removing it loses it. Remove anyway?')) return;
        try { N.removeRecording(r.walk); } catch { /* old app */ }
        draw();
      });
      row.append(b); list.append(row);
    }
  };
  draw();
}

/** The recorded walks, newest first; picking one opens its map and runs it through ARCore again (bridge 3). */
async function pickReplay() {
  const [{ recordings }, w] = await Promise.all([fetch('/api/scan/recordings', { credentials: 'same-origin' }).then((r) => r.json()), fetch('/api/scan/walks', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({ walks: [] }))]);
  const when = new Map((w.walks || []).map((x) => [x.id, x]));
  // with the recordings kept on the phone (bridge 4), those too, and marked: a replay of one fetches nothing
  const onPhone = new Set(typeof window.LawnARNative?.localRecordings === 'function' ? phoneList().map((r) => r.walk) : []);
  for (const wk of onPhone) if (!recordings.some((r) => r.walk === wk)) recordings.push({ walk: wk, bytes: phoneList().find((r) => r.walk === wk)?.bytes || 0, phoneOnly: true });
  const list = document.createElement('div'); list.className = 'card';
  list.innerHTML = recordings.length ? '<strong>Replay a walk</strong><p class="dim">ARCore runs on the walk\'s recording as if walking it again, in real time; the page does again what was done then (marks, pins, checks). The replay is kept as a walk of its own.</p>' : '<p class="dim">No recorded walks yet: the next walk in the app records itself.</p>';
  if (recordings.length) {
    const sm = document.createElement('label'); sm.className = 'dim'; sm.style.display = 'block'; sm.style.margin = '6px 0';
    sm.innerHTML = '<input type="checkbox" id="replay-small"> Replay a full-resolution walk with its pictures 480 wide (to compare with the same walk at 1080)';
    list.append(sm);
    sm.querySelector('input').addEventListener('change', (e) => { st.replaySmall = e.target.checked; });
    st.replaySmall = false;
  }
  for (const r of recordings) {
    const x = when.get(r.walk), b = document.createElement('button'); b.type = 'button'; b.className = 'plain'; b.style.display = 'block'; b.style.margin = '6px 0';
    b.textContent = `${x ? new Date(x.at).toLocaleString() : new Date(+r.walk).toLocaleString()}: ${x?.summary?.stats ? `${Math.round(x.summary.stats.walkedM * 3.281)} ft, ` : ''}${Math.round(r.bytes / 1e6)} MB${onPhone.has(r.walk) ? ' (on this phone)' : ''}`;
    b.addEventListener('click', async () => {
      st.replayOf = r.walk;
      st.replayImage = x?.summary?.app?.image || (x?.summary?.app?.app && /^1\.9$/.test(x.summary.app.app) ? '1920x1080' : null); // replayed in the mode it was recorded in
      try { const meta = await (await fetch(`/api/scan/twin?walk=${encodeURIComponent(r.walk)}&part=meta.json`, { credentials: 'same-origin' })).json(); if (meta?.map && meta.map !== st.map) await openMap(meta.map, 'from the recorded walk'); } catch { /* the map open now, if any */ }
      flash(onPhone.has(r.walk) ? 'Replaying it from the phone' : 'Fetching the recording, then replaying it');
      startAR('native');
    });
    list.append(b);
  }
  $('#start').append(list);
}

const recUpText = () => { const u = st.recUp; if (!u) return ''; return u.done ? 'Recording: on the site, ready to replay.' : u.error ? `Recording: not sent yet (${u.error}); tried again when the app next opens.` : `Recording: sending, ${Math.round((u.sent || 0) / 1e6)} of ${Math.round((u.total || 0) / 1e6)} MB.`; };

function onEvent(ev) {
  // the recording's upload carries on after the walk ends: its progress goes on the results
  if (!st.walk) { if (ev.type === 'native' && ev.what === 'upload') { st.recUp = ev; for (const id of ['#rec-up', '#rec-pending']) { const el = $(id); if (el) el.textContent = recUpText(); } } return; }
  if (ev.type === 'error') { log(`engine: ${ev.message}`); flash(`Engine: ${ev.message}`.slice(0, 80)); }
  if (ev.type === 'camera') log(`camera ${ev.status}`);
  if (ev.type === 'motion') log(`motion sensors ${ev.status}`);
  if (ev.type === 'tracking') log(`tracking ${ev.status} ${ev.reason || ''}`.trim());
  if (ev.type === 'native') {
    log(`app: ${ev.message || [ev.depth != null ? `depth ${ev.depth}` : '', ev.geospatial != null ? `geospatial ${ev.geospatial}` : '', ev.geoError ? `geospatial failed: ${ev.geoError}` : '', ev.image ? `camera ${ev.image}` : ''].filter(Boolean).join(', ')}`);
    if (ev.message) flash(ev.message.slice(0, 80));
    else if (ev.geoError) flash(`Street View positioning is off this walk (${ev.geoError})`.slice(0, 80));
    if (ev.modes) { st.started = { camera: ev.camera, image: ev.image, modes: ev.modes, streetscape: !!ev.streetscape, streetError: ev.streetError || null, recording: !!ev.recording, recordError: ev.recordError || null, replay: ev.replay || null }; log(`app: camera ${ev.camera} of ${ev.modes.length} modes; streetscape ${ev.streetscape}; recording ${ev.recording}${ev.recordError ? ` (${ev.recordError})` : ''}`); }
    if (ev.recordError) flash(`This walk is not being recorded (${ev.recordError})`.slice(0, 80));
    if (ev.what === 'fetching') flash('Fetching the recorded walk');
    if (ev.what === 'download' && !ev.done && ev.total) flash(`Fetching the recording: ${Math.round((ev.got / ev.total) * 100)}%`);
    if (ev.what === 'upload') { st.recUp = ev; if (ev.done) flash('The recording is on the site'); else if (ev.error) flash(`The recording is not sent yet (${ev.error}); it will be tried again`.slice(0, 80)); }
    if (ev.what === 'playbackEnd') { flash('The recording has ended'); log(`replay ended: ${ev.status}`); st.tracker?.stop(); }
    if (ev.what === 'recorded') log(`recording finished: ${Math.round(ev.bytes / 1e6)} MB, being sent`);
  }
  if (ev.type === 'end') finish();
}

/** What to mark next: an unmarked reference, then an unmarked check point, then the reference nearest the phone. */
/* the references and check points with their map places, kept in the walk's private twin (live.json), so the walk
   can be scored afterwards against them even when none was marked: a pin dropped on a check point counts */
const trailKept = () => (st.gpsTrail || []).map((g) => ({ at: g.at.map((v) => +v.toFixed(2)), phone: g.phone.map((v) => +v.toFixed(2)), acc: +(+g.acc).toFixed(1), odo: +(+g.odo).toFixed(1) }));
/* ARCORE'S GEOSPATIAL POSE (the app, when built with a key): Street View's place and heading for the phone, with its
   accuracies, beside the session's own place then; one a second at most. Kept in the walk's private twin only. */
const geoKept = () => (st.geoTrail || []).map((g) => ({ ...g }));
/** For the walk's summary: how many readings, ARCore's median accuracies, how long Earth waited; no places. */
function geoSummary() {
  const tr = st.geoTrail || [], seen = st.geoSeen;
  if (!tr.length && !seen) return null;
  const med = (k) => { const a = tr.map((g) => g[k]).filter(Number.isFinite).sort((x, y) => x - y); return a.length ? +a[a.length >> 1].toFixed(1) : null; };
  const best = (k) => { const a = tr.map((g) => g[k]).filter(Number.isFinite); return a.length ? +Math.min(...a).toFixed(1) : null; };
  return { n: tr.length, hacc: med('hacc'), yawAcc: med('yawAcc'), bestHacc: best('hacc'), bestYawAcc: best('yawAcc'), firstS: seen?.firstS ?? null, waiting: seen?.waiting ?? 0, states: seen?.states || {}, used: st.L ? (st.L.log || []).filter((e) => /Street View/.test(e.from || '')).length : null };
}
function noteGeo(f, odo) {
  const g = f.geo;
  if (!g || !f.pose) return;
  // (2026-11-07) Earth can be ENABLED and still not tracking (no Street View yet, or none here): the app then sends the
  // state alone. Counted, so the walk says how long Street View took or that it never came
  const seen = (st.geoSeen ||= { tracking: 0, waiting: 0, states: {} });
  if (g.state !== 'ENABLED' || ![g.lat, g.lng, g.hacc].every(Number.isFinite)) {
    const k = g.state === 'ENABLED' ? 'on, not yet tracking' : g.state || '?'; // the app (bridge 1) sends Earth's state alone then
    seen.waiting++; seen.states[k] = (seen.states[k] || 0) + 1; return;
  }
  seen.tracking++;
  if (seen.firstS == null && st.walk) seen.firstS = Math.round((Date.now() - st.walk.startedAt) / 1000);
  // live: the latest reading on the map, for the lidar search's start and, when ARCore is sure, the placement (geo.js)
  const r = st.origin ? geoReading(g, f.pose, st.origin) : null;
  if (r && st.L) { r.t = Date.now(); st.L.geo = r; }
  const tr = (st.geoTrail ||= []), last = tr[tr.length - 1];
  if (last && f.t - last.tms < 1000) return;
  const p = f.pose.position;
  /* Kept in degrees, as ARCore gives them (absolute: they mean the same with any map or none; the private bucket only,
     the owner, 2026-11-07), with the East-Up-South turn, and beside them the map's metres and turn when a map is open */
  tr.push({ tms: f.t, lat: g.lat, lng: g.lng, alt: g.alt, hacc: g.hacc, vacc: g.vacc, yawAcc: g.yawAcc, eus: g.eus, at: r ? r.at.map((v) => +v.toFixed(2)) : null, theta: r ? +r.theta.toFixed(5) : null, phone: [+p.x.toFixed(3), +(-p.z).toFixed(3)], y: +p.y.toFixed(3), odo: +odo.toFixed(1) });
  if (tr.length > 5000) tr.shift();
}

/** The Android app's box: in Chrome on Android, get it or open it; inside it, an update when one is ready. */
async function appBox() {
  const box = $('#appbox');
  if (!box) return;
  const v = await (await fetch('/api/app/version', { cache: 'no-store' })).json();
  const inApp = st.caps.native;
  if (inApp) {
    const old = (inApp.bridge ?? 0) < BRIDGE_NEEDED, newer = v.code > (inApp.code || 0);
    if (!old && !newer) return;
    box.hidden = false;
    box.innerHTML = `<strong>${old ? 'This page needs a newer app.' : `A newer app is ready (version ${esc(v.name || v.code)}).`}</strong> <button type="button" id="app-update">Update</button> <span class="dim">Chrome downloads it; tap the download to install over this one.</span>`;
    $('#app-update').addEventListener('click', () => window.LawnARNative.openExternal(`${location.origin}/api/app/apk`));
    return;
  }
  if (!/Android/i.test(navigator.userAgent) || !v.code) return;
  box.hidden = false;
  box.innerHTML = `<strong>The Android app</strong> (version ${esc(v.name || v.code)}): ARCore itself, with what Chrome holds back (raw depth, Street View's place).
    <div class="tools" style="margin-top:6px"><a href="/api/app/apk"><button type="button">Get the app</button></a> <a href="/api/app/pair"><button type="button" class="plain">Open in the app</button></a></div>
    <p class="dim" style="margin:6px 0 0">First time: Get the app, open the download and allow installing from Chrome. Then Open in the app signs it in (once).</p>`;
}
const pointsKept = () => (st.points || []).map((p) => ({ id: p.id, name: p.name, kind: p.kind, map: p.map, on: p.on || null, again: p.again || null, snap: p.snap || null, roof: p.roof || null }));

function nextTarget() {
  // the point the owner picked on the mini map, until it is marked (2026-11-03: Mark "was demanding R2, which I had
  // just marked" when C1 was wanted)
  if (st.chosen) { const c = st.points.find((p) => p.id === st.chosen); if (c && (st.tapMode || c.roof)) return c; st.chosen = null; }
  const markedIds = new Set(st.L.marks.map((m) => m.id));
  // roof corners only, each marking itself (the default since 2026-11-12; the backup mode is everything below)
  if (!st.tapMode) return st.points.find((p) => p.roof && !markedIds.has(p.id)) || null;
  const want = st.points.filter((p) => !markedIds.has(p.id));
  /* references first, so the map lines up early; but a record-only walk is lined up afterwards, and its references are
     optional (the owner, 2026-11-05: on a walk without references "it didn't let me actually mark the checkpoints") */
  const first = (st.recordOnly ? want.find((p) => p.kind === 'check') : want.find((p) => p.kind === 'ref')) || want[0];
  if (first) return first;
  const me = st.ar?.pose ? mapOf(st.L, st.ar.pose.position, st.walk.odo) : null;
  const crumbs = st.crumbs?.list.length && st.tracker?.anchorAt ? crumbMoves(st.crumbs, (h) => st.tracker.anchorAt(h)) : null;
  const refs = st.points.filter((p) => p.kind === 'ref');
  return me ? refs.slice().sort((a, b) => Math.hypot(a.map[0] - me[0], a.map[1] - me[1]) - Math.hypot(b.map[0] - me[0], b.map[1] - me[1]))[0] || null : refs[0] || null;
}

function onFrame(f) {
  const t0 = performance.now();
  if (st.wperf && st.wperfAsked != null) { st.wperf.time('AR asked to first frame', t0 - st.wperfAsked); st.wperfAsked = null; pagePerf.stage('first frame'); }
  try { frameWork(f); } finally {
    if (st.wperf && st.walk) { st.wperf.frame(t0, performance.now(), !!(st.upStatus?.sending && !st.holdUploads)); if (f.pose?.position && f.tracking !== false) st.wperf.pose(f.pose.position, t0 / 1000); }
  }
}
function frameWork(f) {
  /* WHERE A FRAME'S TIME GOES (2026-11-12: the first timed walk put the page's own work at half the walk's time,
     15 ms a frame and over 100 ms one frame in twenty). Each part of the frame's work is timed under its name. */
  let lapAt = performance.now();
  const lap = (name) => { const n = performance.now(); st.wperf?.time(`frame: ${name}`, n - lapAt); lapAt = n; };
  st.lap = lap;
  try { autoSight(f); showNext(); } catch (e) { log(`roof sighting: ${e.message}`); }
  if (st.sight) { try { stepSight(f); } catch (e) { log(`roof sighting: ${e.message}`); st.sight = null; } }
  lap('roof sighting');
  if (!st.walk) return;
  st.ar = f;
  if (f.events) replayActs(f); // a replay: what was done at this frame of the recorded walk
  const w = st.walk, L = st.L, odo = w.odo;
  /* THE PHONE'S OWN TRACKING JUMPED (the owner's walk at home, 2026-11-15: three corners marked, the map lined up
     well, and "maybe 50 feet later it got some sort of new fix that completely ruined the fix". The log has no new
     fix at all: no lidar fix, no earlier walk, no whole-walk placement. It has ARCore losing its place twice, a
     7.6 s stall, and its position moving 2.6 m between two frames). When ARCore moves the phone more than a metre in
     one frame, everything marked before sits in a frame that has shifted, and no fit of those marks is right any
     more. So: say so, ask for a roof corner again, and once two are sighted afresh let the old marks go. */
  if (L && f.pose?.position && f.tracking === 'normal') {
    const p = f.pose.position, q = st.lastTracked;
    // more than a metre between two frames, and faster than anyone walks (6 m a second): a jump, not a stride after a stall
    const moved = q ? Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) : 0, dt = q ? Math.max(1, f.t - q.t) : 0;
    if (q && dt < 1500 && moved > 1 && moved / (dt / 1000) > 6 && L.marks.some((m) => m.by === 'ROOF')) {
      /* A STEP IS NOTED, AND NOTHING IS ASKED (2026-11-22; docs/SCAN-PLAN.md 48). On the big walk of 2026-11-21 the
         places seen before and after eight such steps lay 6-20 in apart as walked, and 149-162 in with the steps
         taken back: the steps were the phone putting itself right. So the walk is no longer cut there, the corners
         are not asked for again, and the earlier marks are kept. The step is logged and counted (L.steps). */
      const m = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      (L.steps ||= []).push({ odo, m });
      log(`the phone's tracking stepped ${m.toFixed(1)} m in one frame at ${Math.round(odo * FT)} ft walked (noted; nothing asked)`);
    }
    st.lastTracked = { x: p.x, y: p.y, z: p.z, t: f.t };
  }
  const warnings = step(w, { t: f.t, pos: f.pose?.position, quat: f.pose?.quaternion, tracking: f.tracking, reset: f.reset, points: f.points });
  for (const x of warnings) {
    if (x === 'lost') flash('Lost its place: look around slowly');
    if (x === 'reset') flash('The tracking jumped: mark a reference again');
    if (x === 'fast') flash('Turn slower');
  }
  // the ground near the phone: the crosshair's depth when it is on the ground (0.8-2.5 m below the camera)
  if ((f.hit?.type === 'DEPTH' || /SURFACE$/.test(f.hit?.type || '')) && f.pose) { const drop = f.pose.position.y - f.hit.position.y; if (drop > 0.8 && drop < 2.5) noteGround(L, f.hit.position.y); }
  lap('walk step');
  // the depth picture as points round the phone, four times a second; then, when it is time, a match
  if (f.geo) noteGeo(f, odo);
  if (f.sem) st.lastSem = { t: f.t, sem: f.sem };
  // THE DRIFT LOG (bridge 2, semantics.js): an ARCore anchor every 10 m at the camera; how far ARCore has moved each
  // by the walk's end is the drift it corrected
  if (st.tracker?.anchors && st.tracker.engine === 'native' && st.crumbs && f.pose && f.tracking === 'normal' && crumbDue(st.crumbs, odo)) {
    const at = { ...f.pose.position }, c = st.crumbs;
    c.lastOdo = odo; // no second ask while this one is answered
    st.tracker.anchor(at).then((h) => addCrumb(c, h, at, odo), () => addCrumb(c, null, at, odo));
  }
  if (f.depthType && !w.depthType) { w.depthType = f.depthType; log(`depth: ${f.depthType}`); if (st.twin) st.twin.depthType = f.depthType; }
  // (2026-11-07) the app keeps its last depth picture until a new one is taken; read twice, its points would count as
  // seen twice (the standing rule) when they were seen once: a picture already used is skipped
  const depthDue = f.depth && f.pose && f.tracking === 'normal' && f.t - st.depthAt > DEPTH_EVERY;
  const shot = depthDue && f.depth.shot ? f.depth.shot() : null; // read only when due: each read is a bridge call
  if (depthDue && (shot == null || shot !== st.depthShot)) {
    st.depthAt = f.t; st.depthShot = shot;
    const pts = [];
    // bridge 2: ARCore's label at each cell; people and cars dropped (semantics.js), the labels counted
    // labels by position only from an app that says how it read them (1.8 on): 1.7's sat wrong on the depth
    const dims = f.depth.semDims ? f.depth.semDims() : null;
    if (!st.semDims && dims) st.semDims = dims;
    const lab = dims ? f.depth.label : null, labC = f.depth.labelConf;
    /* (2026-11-08) one spot read near on a wall the rest of the picture reads far (spikes.js): judged on the whole
       picture, RECORDED ONLY for now (kept with the point in the twin, counted in the summary), nothing dropped */
    const cam = f.pose.position, rr = new Float32Array(16 * 28), cellP = new Array(16 * 28);
    for (let j = 0; j < 28; j++) for (let i = 0; i < 16; i++) {
      const p = f.depth.at((i + 0.5) / 16, (j + 0.5) / 28);
      cellP[j * 16 + i] = p;
      rr[j * 16 + i] = p ? Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z) : 0;
    }
    const spk = spikesIn(rr, 16, 28);
    if (st.spikes) { st.spikes.pictures++; st.spikes.cells += rr.reduce((a, v) => a + (v > 0 ? 1 : 0), 0); st.spikes.flagged += spk.reduce((a, v) => a + v, 0); }
    for (let i = 0; i < 16; i++) for (let j = 0; j < 28; j++) {
      const x = (i + 0.5) / 16, y = (j + 0.5) / 28, p = cellP[j * 16 + i];
      const l = lab ? lab(x, y) : null, lc = l ? labC(x, y) : null;
      if (l && st.sem) noteSem(st.sem, l, lc, f.depth.m(x, y), p && L.groundY != null ? p.y - L.groundY : null);
      if (!p) continue;
      if (!keepPoint(l, lc)) { if (st.sem) st.sem.dropped++; continue; }
      if (l) { p.label = l; p.lconf = lc; }
      if (f.depth.conf) p.dconf = f.depth.conf(x, y); // kept with the point (twin labels part): are phantoms the weak ones?
      if (spk[j * 16 + i]) p.spike = true;
      pts.push(p);
    }
    /* HOLES IN THE DEPTH (2026-11-07): Chrome no longer names the depth type when asked for raw alone, so the walk
       measures it. Raw depth is 0 where the runtime is not confident; smooth fills every pixel. Indoors nearly all of
       a smooth picture is within range, so a high share of holes says raw. */
    // what the phone sees, as a small picture of distances, so a real wall or trunk hides the lidar behind it (draw.js)
    if (f.depth.m && !f.depth.occ) {
      const OW = 24, OH = 42, od = new Uint8Array(OW * OH);
      for (let j = 0; j < OH; j++) for (let i = 0; i < OW; i++) {
        const d = f.depth.m((i + 0.5) / OW, (j + 0.5) / OH);
        od[j * OW + i] = d > 0 ? Math.max(1, Math.min(255, Math.round((d / OCC_RANGE) * 255))) : 0;
      }
      st.occ = { w: OW, h: OH, data: od, t: f.t };
    }
    if (f.depth.m) {
      const df = (st.depthFill ||= { frames: 0, cells: 0, zero: 0, far: 0, weak: 0, minConf: f.depth.minConf ?? null });
      df.frames++;
      for (let i = 0; i < 8; i++) for (let j = 0; j < 14; j++) {
        const x = (i + 0.5) / 8, y = (j + 0.5) / 14, d = f.depth.m(x, y); df.cells++;
        if (d === 0) df.zero++; else if (d > 8) df.far++;
        // depth given but under the app's confidence cut (the app's grids only): dropped
        if (d > 0 && f.depth.conf && f.depth.minConf != null) { const c = f.depth.conf(x, y); if (c != null && c < f.depth.minConf) df.weak++; }
      }
    }
    const near = pts.filter((p) => Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z) <= LIVE_RANGE);
    // THE WHOLE WALK'S GROUND (walkfix.js): one ARCore ground point per half metre of the walk, for its placement
    if (L.groundY != null && st.walkGround && st.walkGround.size < 8000) for (const p of near) {
      if (Math.abs(p.y - L.groundY) >= 0.15) continue;
      const k = `${Math.floor(p.x / 0.5)},${Math.floor(p.z / 0.5)}`;
      if (!st.walkGround.has(k)) st.walkGround.set(k, [+p.x.toFixed(3), +(-p.z).toFixed(3), +p.y.toFixed(3)]);
    }
    addDepth(L, near, odo, f.pose.position, { standing: false }); // standing points come from the colour pass below
    if (st.twin) addPoints(st.twin, Date.now(), odo, pts, L.groundY, cam);
    /* THE TWIN'S OWN, WIDER LOOK (2026-11-19; docs/SCAN-PLAN.md 31; the owner: "We should keep more points"). The
       points above are 16 x 28 rays of the picture at the live confidence cut. Once every TWIN_WIDE_EVERY the twin
       also takes every cell of the app's own grid, the weak ones too (flagged: they count only when seen again from
       another place), with Google's label on each. Recorded only: nothing live reads them. */
    if (st.twin && f.depth.all && Date.now() - (st.twinWideAt || 0) >= TWIN_WIDE_EVERY) {
      st.twinWideAt = Date.now();
      try {
        const A = f.depth.all(), wide = [];
        // every other cell each way, the other ones next time: a quarter of the grid a look, so the phone's memory
        // and the upload grow by about what the live points already cost, not by nine times
        const o = (st.twinWideN = (st.twinWideN || 0) + 1) & 3, oi = o & 1, oj = o >> 1;
        if (A) for (let j = oj; j < A.ny; j += 2) for (let i = oi; i < A.nx; i += 2) {
          const x = (i + 0.5) / A.nx, y = (j + 0.5) / A.ny, p = A.at(x, y);
          if (!p) continue;
          const l = lab && A.label ? A.label(x, y) : null, lc = l && A.labelConf ? A.labelConf(x, y) : null;
          if (!keepPoint(l, lc)) continue;
          if (l) { p.label = l; p.lconf = lc; }
          const c = A.conf ? A.conf(x, y) : null;
          // a cell the phone gave next to no confidence is not a measurement: on the first walk that kept them
          // (2026-11-20) they were half the walk's records, reaching 60 ft from the camera and 53 ft over it
          if (c != null && c < TWIN_WIDE_MIN) continue;
          if (c != null) { p.dconf = c; if (f.depth.minConf != null && c < f.depth.minConf) p.weak = true; }
          wide.push(p);
        }
        if (wide.length) addPoints(st.twin, Date.now(), odo, wide, L.groundY, cam);
      } catch { /* the wider look is extra: a walk never stops for it */ }
    }
    /* GEOSPATIAL DEPTH (bridge 3, where Google has VPS): ARCore's smoothed depth carried to 65 m by Streetscape
       Geometry, kept in the twin past where the camera's own depth reaches (25 m), flagged, and not matched live:
       it is Google's buildings and terrain placed by the Geospatial pose, not something the camera measured */
    if (st.twin && f.depth.geoDepth && st.started?.streetscape) {
      const gd = f.depth.geoDepth(), far = [];
      if (gd) for (let j = 0; j < 28; j++) for (let i = 0; i < 16; i++) {
        const p = gd.at((i + 0.5) / 16, (j + 0.5) / 28);
        if (p && Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z) > 25) { p.geoDepth = true; far.push(p); }
      }
      if (far.length) { st.geoDepthN = (st.geoDepthN || 0) + far.length; addPoints(st.twin, Date.now(), odo, far, L.groundY, cam); }
    }
  }
  lap('depth picture to points');
  // 8th Wall: no depth map, but its world points, at the same pace (scan/lib/track.js worldPointsOf); no camera
  // picture to colour them, so they go in as standing candidates too, each still needing two sightings
  if (!f.depth && f.world && f.pose && f.t - st.depthAt > DEPTH_EVERY) {
    st.depthAt = f.t;
    addDepth(L, f.world, odo, f.pose.position);
    if (st.twin) addPoints(st.twin, Date.now(), odo, f.world, L.groundY, f.pose.position);
  }
  lap('world points');
  // THE GROUND'S COLOUR (scan/lib/surface.js): about once a second, the camera's picture read back, and the depth
  // under a grid of it labelled grass or paving, for the lawn-edge term of the match. The same read serves the twin.
  let grabbed = null;
  /* ONE READ OF THE CAMERA'S PICTURE SERVES BOTH (2026-11-22, the walk in the rain: 12 frames a second, the picture
     read and the twin 62% of the page's own work). The colour was read every 0.9 s and a picture for the twin taken
     every 1 s or more, each with its own read, so the two fell out of step and the camera's picture was read about
     twice a second. A picture wanted for the twin now brings the colour's read with it. */
  const keyNow = !!(st.twin && f.pose && f.grab && f.tracking === 'normal' && !st.twinUp?.off && wantKey(st.twin, Date.now(), f.pose.position, f.pose.quaternion));
  if (f.grab && f.pose && f.tracking === 'normal' && (keyNow || f.t - (st.colourAt || 0) > COLOUR_EVERY)) {
    st.colourAt = f.t;
    grabbed = f.grab();
    /* ANCHOR NUDGES (scan/lib/anchors.js): does this picture show a roofline against the sky, or pavement? After
       30 m without one, a hint to look at it; the after-the-walk placement lives on both (SCAN-H19) */
    if (grabbed?.pixels && st.anchors) {
      // bridge 2: ARCore's own labels when the app sends them (semantics.js), else the page's colour test
      const pitch = pitchOf(f.pose.quaternion);
      const fresh = st.lastSem && f.t - st.lastSem.t < 1500;
      const view = (fresh && viewFromSem(st.lastSem.sem, pitch)) || viewOf(grabbed.pixels, grabbed.w, grabbed.h, pitch);
      noteView(st.anchors, odo, view);
      const now = performance.now() / 1000;
      if (st.nudge && (view[st.nudge.kind] || now > st.nudge.until)) st.nudge = null;
      const n = nudge(st.anchors, odo, now);
      /* NOT SAID ANY MORE (the owner, 2026-11-22: "should we get rid of the prompt that periodically says to look at
         a roof or driveway edge?"). The nudges fed an after-the-walk placement by skyline and pavement that no longer
         places walks (the corners do), and a walk's first job is to agree with itself. The views are still counted
         in the summary; nudge() is still called so the counts of what WOULD have been asked are kept. */
      void n;
    }
    if (grabbed?.pixels && f.depth) {
      const pts = [], { w: gw, h: gh, pixels } = grabbed;
      for (let i = 0; i < 24; i++) for (let j = 0; j < 40; j++) {
        const x = (i + 0.5) / 24, y = (j + 0.5) / 40, p = f.depth.at(x, y);
        if (!p || Math.hypot(p.x - f.pose.position.x, p.y - f.pose.position.y, p.z - f.pose.position.z) > LIVE_RANGE) continue;
        const l = f.depth.label && st.semDims ? f.depth.label(x, y) : null;
        if (l && !keepPoint(l, f.depth.labelConf(x, y))) continue;
        if (l) p.label = l;
        const k = (Math.min(gh - 1, Math.floor(y * gh)) * gw + Math.min(gw - 1, Math.floor(x * gw))) * 4;
        const surf = surfaceOf(pixels[k], pixels[k + 1], pixels[k + 2]);
        p.surf = surf || 'other'; pts.push(p); if (surf) st.surfCount[surf]++;
      }
      if (pts.length) addDepth(L, pts, odo, f.pose.position);
      if (pts.length && st.map) keepForPrev(L, pts); // every walk: it may place the next one (keepReference), or be placed by the last
    }
  }
  lap('camera picture read, ground colour');
  // the twin: the camera's track, a picture now and then, and what has piled up sent every 15 s
  if (st.twin && f.pose) {
    const now = Date.now();
    addPose(st.twin, now, odo, f.pose.position, f.pose.quaternion, f.tracking);
    if (keyNow) {
      const g = grabbed || f.grab();
      if (g) {
        const name = addKey(st.twin, now, odo, f.pose.position, f.pose.quaternion, g);
        g.blob.then((b) => b && sendTwin([{ name, type: 'image/jpeg', body: b }]), () => {});
        lap('twin: track, a picture');
        const dep = keyDepth(f, name);
        if (dep) sendTwin([dep]);
        const rdep = keyRaw(f, name);
        if (rdep) sendTwin(rdep.sem ? [rdep, rdep.sem] : [rdep]);
        const sdep = keySmooth(f, name);
        if (sdep) sendTwin([sdep]);
        lap('twin: a picture\'s three depth grids');
      }
    }
    if (flushDue(st.twin, now)) sendTwin(flush(st.twin, now, liveOf(L, w, { recordOnly: !!st.recordOnly, points: pointsKept(), gpsTrail: trailKept(), geoTrail: geoKept(), anchors: st.anchors ? anchorsKept(st.anchors) : null, prev: prevKept() })));
  }
  lap('twin: track, and every 15 s what piled up made ready to send');
  // PLACED BY THE MAP'S EARLIER WALK (walkref.js, SCAN-H32): every PREV_EVERY, this walk's points so far against it
  /* NOT IN THE WALK'S FIRST 200 ft (2026-11-22, runs 490-491: matched on its first 100 ft a walk was placed 50-95 ft
     wrong every time, and called good; from 200 ft, stretched to the map's metres, 3-40 in). */
  /* ...UNLESS A ROOF CORNER HAS BEEN MARKED (the owner, 2026-11-22: "That's actually a bit of a problem. Would 1 corner
     reference fix that?"): the latest marked corner bounds the match to placements that put it where the map has it
     (walkref.js prior.pin), so the match may be asked as soon as there are points enough. */
  const cornerMark = (() => { for (let i = L.marks.length - 1; i >= 0; i--) { const m = L.marks[i]; if (m.kind === 'ref' && m.ar && m.map) return m; } return null; })();
  if (st.ref?.ready && !st.ref.stale && !st.prevAsk && (odo >= PREV_MIN_M || cornerMark) && f.tracking === 'normal' && Date.now() - st.prevAt > PREV_EVERY && st.prevStand.size >= REF_MIN_STAND) {
    const id = `p${Date.now()}`;
    st.prevAt = Date.now(); st.prevAsk = { id, odo }; st.prevStats.asks++;
    // where GPS or Street View has the walk, as a LOOSE bound (at least 15 m and 25 degrees): tight, it shut the
    // right answer out (run 491); loose, it only forbids the far side of the yard
    const pr = walkPrior(st.gpsTrail, st.geoTrail);
    // (the phone's own heading was tried with the corner, run 503: no fix came earlier for it, so it is not used)
    /* ONCE A FIX HAS BEEN USED, THE WALK IS NOT TURNED ANOTHER WAY (2026-11-25, run 593 and the one after): with a corner
       as the pin every turn was searched, and from 440 ft on some other turn landed within 10 points of the right
       one, so every later match was refused and the page drew by the fit of 459 ft for the walk's last 800 ft.
       Bounded to 15 degrees of the last used fit, the far turns are not candidates. */
    const turn = L.prev?.ok && Number.isFinite(L.prev.T?.theta) ? { theta: L.prev.T.theta, searchDeg: 15 } : null;
    const prior = cornerMark ? { pin: { ar: cornerMark.ar, map: cornerMark.map }, searchM: 1.5, ...(turn || {}) }
      : pr ? { T: { theta: pr.T.theta, tx: pr.T.tx, ty: pr.T.ty }, searchM: Math.max(15, 2 * pr.searchM), searchDeg: Math.max(25, 2 * pr.searchDeg) } : null;
    st.ref.worker.postMessage({ fix: { id, stand: [...st.prevStand.values()], ground: [...st.prevGround.values()], prior } });
  }
  if (LIDAR_LIVE && !st.recordOnly && st.lid.ready && st.lid.worker && f.tracking === 'normal') {
    const ask = nextAsk(L, odo, Date.now(), f.pose?.position || null);
    if (ask.id) st.lid.worker.postMessage({ register: { id: ask.id, stand: ask.stand, ground: ask.ground, high: ask.high, surface: ask.surface, prior: ask.prior, s: ask.s, refs: ask.refs } });
    else if (ask.why && !/too soon|running/.test(ask.why)) L.why = ask.why;
    // THE WHOLE WALK AT ONCE (walkfix.js, SCAN-H25): every WALK_EVERY, the trail's placement refined by all the ground
    // seen so far, in the worker
    const nowMs = Date.now();
    if (!st.walkAsk && nowMs - st.walkAt > WALK_EVERY && st.walkGround?.size >= 300) {
      const prior = walkPrior(st.gpsTrail, st.geoTrail);
      if (prior) {
        const all = [...st.walkGround.values()], step = Math.max(1, Math.ceil(all.length / 1500));
        const id = `w${nowMs}`;
        st.walkAt = nowMs; st.walkAsk = { id, odo, from: prior.from }; st.walkStats.asks++;
        st.lid.worker.postMessage({ walk: { id, ground: all.filter((_, i) => i % step === 0), prior: { T: prior.T } } });
      }
    }
  }
  lap('asks to the match workers');
  // draw
  if (f.gl && f.view && f.proj) {
    try {
      if (!st.drawer || st.drawer.gl !== f.gl) st.drawer = { gl: f.gl, d: makeDrawer(f.gl) };
      const items = [];
      for (const p of w.pins) {
        if (p.anchor) { const a = st.tracker?.anchorAt(p.anchor); if (a) p.anchorAt = a; }
        const now = pinNow(p);
        items.push({ kind: 'pin', at: now, color: p.kind ? THING_COL[p.kind] || COLOR.pin : COLOR.pin });
        if (now !== p.at) items.push({ kind: 'mark', at: p.at, color: COLOR.placed });
      }
      // the references and check points where the fit puts them: on the real corner when the fix is right
      const T = fitFor(L, odo);
      if (T) for (const p of st.points) { const s = sessionOf(L, p.map, odo, L.groundY ?? (f.pose ? f.pose.position.y - 1.4 : 0)); if (s && f.pose && levelDist(s, f.pose.position) < 30) items.push({ kind: 'mark', at: s, color: p.kind === 'ref' ? COLOR.ref : COLOR.check }); }
      /* EACH CORNER WHERE IT WAS MARKED (white; 2026-11-22): the phone's own place for it at that moment, moved by no
         fit and no map. Coming back to a corner, a white post off the real corner is the walk's own drift, seen. */
      if (f.pose) for (const m of L.marks) { if (!m.ar) continue; const at = { x: m.ar[0], y: m.y ?? 0, z: -m.ar[1] }; if (levelDist(at, f.pose.position) < 30) items.push({ kind: 'mark', at, color: COLOR.where }); }
      /* THE THINGS PLACED ON EARLIER WALKS (lib/things.js), where the fit puts them now: a sprinkler head, a gutter's
         top or outlet, each at its own height over the ground. Only once the walk has a place on the map. */
      if (T && st.things?.length && f.pose) {
        const gy = L.groundY ?? f.pose.position.y - 1.4;
        for (const t of st.things) { const s = sessionOf(L, t.at, odo, gy + (t.h || 0)); if (s && levelDist(s, f.pose.position) < 30) items.push({ kind: 'pin', at: s, color: THING_COL[t.kind] || COLOR.pin }); }
      }
      if (w.pendingMeasure) items.push({ kind: 'mark', at: w.pendingMeasure.a, color: COLOR.mark });
      if (f.hit) items.push({ kind: 'dot', at: f.hit.position, color: f.hit.type === 'DEPTH' ? COLOR.dot : COLOR.dotPlane });
      // THE LIDAR IN THE CAMERA (owner, 2026-11-03: "so that I can see how it's lining up... mostly transparent, but
      // still visible... then add a black dot on them if the AR agrees with them"): the solid cells the match matches
      // against (blue), the canopy (green) and the roofs (orange), through the fit for this moment; black dots where
      // the phone's standing points land on a solid cell, red where they land on nothing
      const statics = [], dots = [];
      if (st.lidarOn && T && st.lid.overlay && f.pose) {
        if (!st.lid.meshes || st.lid.meshes.gl !== f.gl) {
          const tMesh = performance.now(); // the wait the eye sees as "shapes take a while to render"
          /* THE LOOK (lib/look.js; the owner, 2026-11-10): black roofs, white walls, green trees, orange for other
             objects, smooth surfaces on 0.5 m, drawn solidly. The old blue/green/orange boxes only if a worker from
             before the look answered. */
          if (st.lid.overlay.show) st.lid.meshes = { gl: f.gl, look: lookMeshes(st.lid.overlay.show).map((m) => ({ mesh: st.drawer.d.makeMesh(m.verts), color: m.color })) };
          else {
            const m = lidarMeshes(st.lid.overlay);
            st.lid.meshes = { gl: f.gl, solids: st.drawer.d.makeMesh(m.solids), canopy: st.drawer.d.makeMesh(m.canopy), roofs: st.drawer.d.makeMesh(m.roofs) };
          }
          st.wperf?.time('lidar shapes built', performance.now() - tMesh);
          if (st.wperf && !st.wperfShapes) { st.wperfShapes = true; pagePerf.stage('lidar shapes drawn'); }
        }
        /* the height: the phone's own ground points against the lidar's ground at their own places (locate.js
           groundOffset), worked out twice a second and moved only when it changes by more than 10 cm, so a glance
           does not lift the drawing; the crosshair's ground only until there are ground points enough */
        if (f.t - (st.dyAt || 0) > 500) {
          st.dyAt = f.t;
          const g = groundOffset(L, odo, T, (e, n) => demAt(st.lid.overlay.dem1, e, n, NaN));
          if (g != null && (st.dy == null || st.dyFrom !== 'ground' || Math.abs(g - st.dy) > 0.1)) { st.dy = g; st.dyFrom = 'ground'; }
          else if (g == null && st.dyFrom !== 'ground') {
            const me = mapOf(L, f.pose.position, odo), groundHere = L.groundY ?? f.pose.position.y - 1.4;
            st.dy = me ? groundHere - demAt(st.lid.overlay.dem1, me[0], me[1], groundHere) : 0; st.dyFrom = 'crosshair';
          }
        }
        const dy = st.dy ?? 0;
        const model = mapToSession(T, dy);
        if (st.lid.meshes.look) for (const m of st.lid.meshes.look) statics.push({ mesh: m.mesh, model, color: m.color, through: true });
        else {
          statics.push({ mesh: st.lid.meshes.solids, model, color: [0.35, 0.7, 1, 0.26], through: true });
          statics.push({ mesh: st.lid.meshes.canopy, model, color: [0.3, 0.9, 0.4, 0.12], through: true });
          statics.push({ mesh: st.lid.meshes.roofs, model, color: [1, 0.6, 0.3, 0.14], through: true });
        }
        if (f.t - (st.agreeAt || 0) > 300) { st.agreeAt = f.t; st.agree = agreement(L, odo, st.lid.overlay.dist); }
        if (st.agree) { dots.push({ points: st.agree.on, color: [0, 0, 0, 0.95], r: 0.045 }); dots.push({ points: st.agree.off, color: [1, 0.25, 0.2, 0.7], r: 0.03 }); }
      } else st.agree = null;
      /* WHAT HIDES THE LIDAR (bridge 5, 2026-11-10): ARCore's smoothed depth picture at its own size, about fifteen
         times a second, straight to the shader (draw.js); the 24 x 42 samples above only with an older app */
      if (f.depth?.occ && f.t - (st.occAt || 0) > 60) {
        st.occAt = f.t;
        const o = f.depth.occ(OCC_RANGE_FULL);
        if (o) { if (!st.occFull) log(`occlusion: the app's smoothed depth, ${o.w}x${o.h}`); st.occFull = (st.occFull || 0) + 1; st.occ = { w: o.w, h: o.h, data: o.data, range: o.range, t: f.t }; }
      }
      const occlusion = st.occ && f.t - st.occ.t < 1000 ? st.occ : null;
      st.drawer.d.draw({ view: f.view, proj: f.proj, viewport: f.viewport, framebuffer: f.framebuffer, items, dots, statics, occlusion });
    } catch (e) { if (!st.drawErr) { st.drawErr = true; log(`draw: ${e.message}`); } }
  }
  $('#cross').classList.toggle('hit', !!f.hit);
  lap('drawing the AR shapes');
  if (f.t - st.hudAt > 200) { st.hudAt = f.t; hud(f); lap('top box'); }
  if (f.t - (st.miniAt || 0) > 120) { st.miniAt = f.t; try { drawMini(f); arrows(f); } catch (e) { log(`mini map: ${e.message}`); } }
  lap('mini map and arrows');
}

function hud(f) {
  const w = st.walk, L = st.L;
  const tr = f.tracking === 'normal' ? '<span class="ok">tracking</span>' : f.tracking === 'limited' ? '<span class="warn">tracking limited</span>' : '<span class="bad">no tracking yet: move the phone slowly over the ground</span>';
  const aim = f.hit ? `aim ${ftIn(f.hit.distance)} <span class="dim">(${f.hit.type === 'DEPTH' ? 'depth' : 'plane'})</span>${far(f.hit) ? ' <span class="warn">(far)</span>' : ''}` : 'no ground under the crosshair';
  const pts = f.points ? ` · ${f.points} pts` : '';
  const target = st.points.length ? nextTarget() : null;
  const ag = st.agree ? ` · lidar dots: <strong>${st.agree.on.length}</strong> on, ${st.agree.off.length} off` : '';
  // the map's earlier walk (walkref.js): what its match is waiting for, until it places the walk
  const prevLine = st.ref?.ready && !st.ref.stale && !L.prev?.ok ? `<br><span class="dim">Earlier walk: ${esc(st.prevStats?.lastWhy || (st.prevStand?.size < REF_MIN_STAND ? `gathering points (${st.prevStand.size} of ${REF_MIN_STAND} on walls, fences and shrubs)` : 'matching…'))}</span>`
    : st.ref?.error ? `<br><span class="dim">Earlier walk: ${esc(st.ref.error)}</span>` : '';
  const fixLine = st.origin ? `<br>${st.recordOnly ? '<strong>Recording only</strong>: no live lidar fix; the walk is placed afterwards (workflow S, task fix). ' : ''}${esc(st.lid.ready ? fixStatus(L, w.odo) : st.lid.error ? `No lidar (${st.lid.error}); references only: ${fixStatus(L, w.odo)}` : `Lidar: ${st.lid.progress || 'reading…'}`)}${ag}${target ? `<br>Next to mark: <strong style="color:${target.kind === 'ref' ? '#8ab4ff' : '#d9a6ff'}">${esc(target.name)}</strong> ${target.roof ? '(a roof corner: aim the circle up at it and hold still; it marks itself, no tap. Tap another point on the mini map to do that one instead)' : '(aim where it meets the ground, within 10 ft, tap Mark; tap another point on the mini map to mark that one instead)'}` : ''}` : '';
  const last = st.errors.length && Date.now() - st.errors[st.errors.length - 1].t < 6000 && /engine|start/.test(st.errors[st.errors.length - 1].what) ? `<br><span class="bad">${esc(st.errors[st.errors.length - 1].what)}</span>` : '';
/* THE TOP BOX, SHORT (the owner, 2026-11-12: the mini map covered it; "shorten the dialog box by trimming wordiness
     and info that isn't doing much"): tracking, how far walked, how the map is lined up, and trouble when there is
     any. The backup mode keeps the long one. */
  const roofsAll = st.points.filter((p) => p.roof), roofsDone = roofsAll.filter((p) => L.marks.some((m) => m.id === p.id)).length;
  if (!st.tapMode) $('#hud').innerHTML = `${tr} · walked ${Math.round(w.stats.walked * FT)} ft${roofsAll.length ? ` · roof corners ${roofsDone} of ${roofsAll.length}` : st.points.length ? ' · <span class="warn">no roof corners chosen (pick diamonds on the lidar view, or use the backup mode)</span>' : ''}${st.origin && (st.lid.error || !st.lid.ready) ? `<br><span class="dim">${esc(st.lid.error ? `No lidar (${st.lid.error})` : `Lidar: ${st.lid.progress || 'reading…'}`)}</span>` : ''}${st.nudge ? `<br><span class="warn">${esc(st.nudge.text)}</span>` : ''}${st.upStatus && (st.upStatus.off || (st.upStatus.pending && !st.upStatus.sending)) ? `<br><span class="dim">${esc(statusText(st.upStatus))}</span>` : ''}${last}`;
  else $('#hud').innerHTML = `${NAME[w.engine]} · ${tr} · walked ${Math.round(w.stats.walked * FT)} ft${pts} · ${aim} · ${w.pins.length} pin${w.pins.length === 1 ? '' : 's'}${w.pendingMeasure ? ' · <span class="warn">now aim at the second mark</span>' : ''}${fixLine}${prevLine}${st.nudge ? `<br><span class="warn">${esc(st.nudge.text)}</span>` : ''}${st.upStatus && (st.upStatus.pending > 3 || st.upStatus.off || (st.upStatus.pending && !st.upStatus.sending)) ? `<br><span class="dim">${esc(statusText(st.upStatus))}</span>` : ''}${last}`;
  const can = !!f.hit && f.tracking !== 'lost';
  $('#pin').disabled = !can; $('#measure').disabled = !can; $('#check').disabled = !can || !w.pins.length; $('#mark').disabled = !target || (target.roof ? f.tracking === 'lost' : !can);
  const again = target && L.marks.some((m) => m.id === target.id);
  $('#mark').hidden = !st.tapMode; $('#startover').hidden = !!st.tapMode;
  $('#mark').textContent = target ? (target.roof && !again ? (st.sightPaused ? `Go on with ${target.name}` : `Pause ${target.name} (roof)`) : `Mark ${target.name}${again ? ' again' : ''}`) : 'Mark';
  /* (2026-11-24: 33-44 ms a time, 5-6% of a walk's frame time, once the walk's ground and plants were drawn on it; it is
     not on screen during a walk) redrawn only when it can be seen */
  if (f.t - (st.mapAt || 0) > 1000 && fitFor(L, w.odo) && $('#map')?.offsetParent) { st.mapAt = f.t; const tm = performance.now(); drawMap(); st.wperf?.time('frame: placement map redrawn (hidden page)', performance.now() - tm); }
}

/** The lidar ground at a map point from the 1 m grid the worker sent; `fallback` off the grid. */
/** Where the walk sits on the map at this moment, for a dev-only extra that asks (public/thermal.js): the latest
    frame's time, the level fit in effect (align.js apply: session (x, -z) -> map east, north), what it came from, the
    session's height of the ground under the phone, and dy (session y = the lidar ground's height + dy). */
function placementNow() {
  const w = st.walk, L = st.L, f = st.ar;
  if (!w || !L || !f) return null;
  const T = fitFor(L, w.odo);
  if (!T) return null;
  return { t: f.t, theta: T.theta, tx: T.tx, ty: T.ty, s: T.s ?? 1, by: fitSource(L, w.odo), groundY: L.groundY ?? null, dy: st.dyFrom ? st.dy : null, dyFrom: st.dyFrom || null, odo: w.odo, tracking: f.tracking !== false && f.tracking !== 'lost' };
}

function demAt(g, e, n, fallback) {
  if (!g) return fallback;
  const c = Math.floor((e - g.box[0]) / g.cell), r = Math.floor((g.box[3] - n) / g.cell);
  if (c < 0 || r < 0 || c >= g.W || r >= g.H) return fallback;
  const v = g.data[r * g.W + c];
  return Number.isFinite(v) ? v : fallback;
}

const nearestPin = (hit) => { let best = null, bd = 6; for (const p of st.walk.pins) { const d = levelDist(pinNow(p), hit.position); if (d < bd) { bd = d; best = p; } } return best; };

/* ------------------------------------------------------------ the mini map */

// mode: 'fit' (every reference and check point), 'follow' (the phone, once there is a lock), 'manual' (moved by hand)
const mini = { view: null, mode: 'fit', locked: false, w: 0, h: 0 };
function miniSize() {
  const cv = $('#mini'), r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  mini.w = w; mini.h = h; mini.dpr = dpr;
  return cv;
}
function drawMini(f) {
  const cv = miniSize(), g = cv.getContext('2d'), { w, h, dpr } = mini;
  const L = st.L, odo = st.walk?.odo ?? 0;
  const me = L && f?.pose ? mapOf(L, f.pose.position, odo) : null;
  if (me && !mini.locked) { mini.locked = true; if (mini.mode !== 'manual') mini.mode = 'follow'; }
  if (!me) mini.locked = false;
  const fit = viewToFit(st.points.map((p) => p.map), w, h, 18 * dpr);
  if (mini.mode === 'follow' && me) mini.view = followView(me, w, h, fit);
  else if (mini.mode !== 'manual' || !mini.view) mini.view = fit;
  const v = mini.view, S = (m) => toScreen(v, m, w, h);
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
  // the photo, put down by where three of its pixels fall
  if (st.photo && st.frame) {
    const a = S(unpx([0, 0])), b = S(unpx([1, 0])), c = S(unpx([0, 1]));
    g.save(); g.globalAlpha = 0.9; g.setTransform(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1], a[0], a[1]); g.drawImage(st.photo, 0, 0); g.restore();
  }
  g.lineWidth = 1.5 * dpr;
  for (const r of st.lawn) { if (r.length < 2) continue; g.beginPath(); r.forEach((p, i) => { const [x, y] = S(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath(); g.strokeStyle = CSS.lawn; g.stroke(); }
  const marked = new Set((L?.marks || []).map((m) => m.id));
  g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
  for (const p of st.points) {
    const [x, y] = S(p.map);
    g.beginPath(); g.arc(x, y, 5 * dpr, 0, Math.PI * 2); g.fillStyle = p.kind === 'ref' ? CSS.ref : CSS.check; g.fill();
    g.lineWidth = (marked.has(p.id) ? 2.5 : 1.5) * dpr; g.strokeStyle = marked.has(p.id) ? '#4cff9a' : '#fff'; g.stroke();
    if (st.chosen === p.id) { g.beginPath(); g.arc(x, y, 10 * dpr, 0, Math.PI * 2); g.strokeStyle = '#ffeb3b'; g.lineWidth = 2 * dpr; g.stroke(); }
    g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineWidth = 3 * dpr; g.strokeText(p.name, x + 7 * dpr, y + 4 * dpr); g.fillText(p.name, x + 7 * dpr, y + 4 * dpr);
  }
  if (me) {
    // where the phone faces: its look direction on the level, turned onto the map by the fit
    const q = f.pose.quaternion, fx = -(2 * (q.x * q.z + q.w * q.y)), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const ahead = mapOf(L, { x: f.pose.position.x + fx * 4, y: f.pose.position.y, z: f.pose.position.z + fz * 4 }, odo);
    const [x, y] = S(me);
    if (ahead) { const [ax, ay] = S(ahead), d = Math.hypot(ax - x, ay - y) || 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + ((ax - x) / d) * 16 * dpr, y + ((ay - y) / d) * 16 * dpr); g.strokeStyle = '#ffeb3b'; g.lineWidth = 3 * dpr; g.stroke(); }
    g.beginPath(); g.arc(x, y, 6 * dpr, 0, Math.PI * 2); g.fillStyle = '#ffeb3b'; g.fill(); g.lineWidth = 2 * dpr; g.strokeStyle = '#000'; g.stroke();
  } else {
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, h - 18 * dpr, w, 18 * dpr); g.fillStyle = '#fff'; g.fillText('No lock yet: aim at a reference', 6 * dpr, h - 5 * dpr);
  }
  if (mini.mode === 'manual') { g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(w - 64 * dpr, 0, 64 * dpr, 16 * dpr); g.fillStyle = '#fff'; g.fillText('2 taps: back', w - 60 * dpr, 12 * dpr); }
}
/** Arrows at the screen's edge to the references and check points out of the picture, once there is a lock. */
function arrows(f) {
  const box = $('#arrows'), L = st.L;
  const on = L && f?.view && f?.proj && st.walk && fitFor(L, st.walk.odo);
  const seen = new Set();
  if (on) {
    const vw = window.innerWidth, vh = window.innerHeight, odo = st.walk.odo;
    for (const p of st.points) {
      const s = sessionOf(L, p.map, odo, L.groundY);
      const a = s ? edgeArrow(s, f.view, f.proj, vw, vh, 30) : null;
      if (!a) continue;
      seen.add(p.id);
      let el = box.querySelector(`[data-id="${CSS_ESC(p.id)}"]`);
      if (!el) { el = document.createElement('div'); el.className = 'arrow'; el.dataset.id = p.id; el.innerHTML = '<i></i><span></span>'; box.append(el); }
      el.style.left = `${a.x}px`; el.style.top = `${a.y}px`; el.style.color = p.kind === 'ref' ? '#6ea8ff' : '#d58cff';
      el.querySelector('i').style.transform = `rotate(${a.angle}rad)`;
      el.querySelector('span').textContent = p.name;
    }
  }
  for (const el of [...box.children]) if (!seen.has(el.dataset.id)) el.remove();
}
const CSS_ESC = (s) => String(s).replace(/["\\]/g, '\\$&');
function wireMini() {
  const cv = $('#mini'), touches = new Map();
  let pinch = null, lastTap = 0;
  const at = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (mini.dpr || 1), (e.clientY - r.top) * (mini.dpr || 1)]; };
  cv.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); cv.setPointerCapture(e.pointerId); touches.set(e.pointerId, at(e));
    const now = Date.now();
    if (touches.size === 1 && now - lastTap < 320) { mini.mode = mini.locked ? 'follow' : 'fit'; mini.view = null; lastTap = 0; return; }
    lastTap = now;
    if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId) || !mini.view) return;
    const prev = touches.get(e.pointerId), now = at(e); touches.set(e.pointerId, now);
    if (touches.size === 1) { if (Math.hypot(now[0] - prev[0], now[1] - prev[1]) < 1) return; mini.mode = 'manual'; mini.view = miniPan(mini.view, now[0] - prev[0], now[1] - prev[1]); }
    else if (touches.size === 2 && pinch) { const [a, b] = [...touches.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (d > 0) { mini.mode = 'manual'; mini.view = miniZoom(mini.view, d / pinch, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], mini.w, mini.h); pinch = d; } }
    if (st.ar) drawMini(st.ar);
  });
  let downAt = null;
  cv.addEventListener('pointerdown', (e) => { downAt = { p: at(e), t: Date.now() }; });
  const up = (e) => {
    touches.delete(e.pointerId); if (touches.size < 2) pinch = null;
    // a short tap that did not move: pick the nearest reference or check point to mark next
    if (e.type === 'pointerup' && downAt && Date.now() - downAt.t < 300 && mini.view && st.L) {
      const p = at(e);
      if (Math.hypot(p[0] - downAt.p[0], p[1] - downAt.p[1]) < 8 * (mini.dpr || 1)) {
        let best = null;
        for (const q of st.points) { const s = toScreen(mini.view, q.map, mini.w, mini.h), d = Math.hypot(s[0] - p[0], s[1] - p[1]); if (d < 28 * (mini.dpr || 1) && (!best || d < best.d)) best = { q, d }; }
        if (best) {
          /* A TAP ON A ROOF CORNER STARTS ITS SCAN, MARKED OR NOT (the owner, 2026-11-23: "make it so that tapping a
             reference point in the mini map allows that roof corner to go through the normal corner scan, it's
             difficult to tap the phone when pointing it up"; and 2026-11-22: "there actually wasn't a way to mark a
             roof corner a 2nd time"). The tap is made with the phone held low; then aim up, and the corner marks
             itself as the first time. A corner scanned again keeps its first mark (locate.js), and the two together
             say how far the walk has slid (refkeep.js closingOf). A second tap on the same corner calls it off. */
          const q = best.q;
          if (q.roof && !st.tapMode) {
            if (st.rescan === q.id && Date.now() - (st.rescanAt || 0) < 700) { /* the second tap of a double tap: not a calling off */ }
            else if (st.rescan === q.id) { st.rescan = null; st.chosen = null; st.sight = null; $('#guide').hidden = true; flash(`${q.name}: scan called off`); }
            else {
              const was = st.L.marks.some((m) => m.id === q.id);
              st.chosen = q.id; st.rescan = q.id; st.rescanAt = Date.now(); st.sight = null; st.sightPaused = false; st.sightEndedAt = 0; st.sightNow = true;
              flash(was ? `${q.name}: scanning it again. Aim up at the roof corner.` : `${q.name} is next. Aim up at the roof corner.`);
              log(`roof corner ${q.name} picked on the mini map${was ? ' to be scanned again' : ''}`);
            }
          } else { st.chosen = q.id; flash(`Next to mark: ${q.name}`); }
          if (st.ar) drawMini(st.ar);
        }
      }
    }
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); if (!mini.view) return; mini.mode = 'manual'; mini.view = miniZoom(mini.view, e.deltaY < 0 ? 1.25 : 0.8, at(e), mini.w, mini.h); if (st.ar) drawMini(st.ar); }, { passive: false });
}

function wire() {
  wireMini();
  $('#pin').addEventListener('click', () => doPin(st.ar));
  $('#check').addEventListener('click', () => doCheck(st.ar));
  $('#mark').addEventListener('click', () => doMark(st.ar));
  $('#startover').addEventListener('click', startOver);
  // the hint between corners, tapped: start the next corner here and now, wherever the map thinks it is
  $('#guide').addEventListener('click', () => { if (st.guideNext && !st.sight) { st.sightNow = true; st.sightEndedAt = 0; log('next corner started by a tap on the hint'); } });
  $('#undo').addEventListener('click', () => doUndo());
  $('#measure').addEventListener('click', () => {
    const f = st.ar; if (!f?.hit) return;
    const m = measure(st.walk, f.hit);
    flash(m ? `Measured ${ftIn(m.m)} (${m.m.toFixed(2)} m)` : 'First mark set: aim at the second and tap Measure');
  });
  wireRest();
}

/* THE WALK'S ACTIONS, kept in its ARCore recording (bridge 3) with the frame they happened on, and done again by a
   replay when that frame comes round (replay: true skips the "step closer" check: it was answered the first time). */
const recordAct = (a) => { if (!st.replayOf) st.tracker?.recordAction?.(a); };
function replayActs(f) {
  for (const a of f.events || []) {
    if (a.a === 'pin') doPin(f, { replay: true });
    else if (a.a === 'check') doCheck(f, { replay: true });
    else if (a.a === 'mark') doMark(f, { replay: true, target: a.target });
    else if (a.a === 'undo') doUndo({ replay: true });
  }
}
function doPin(f, { replay = false } = {}) {
    if (!f?.hit) return;
    if (!replay && far(f.hit) && Date.now() - st.farAt > FAR_AGAIN) { st.farAt = Date.now(); flash(`Aiming from ${ftIn(f.hit.distance)}: step closer, or tap again to drop it anyway`); return; }
    recordAct({ a: 'pin' });
    const p = dropPin(st.walk, f.hit);
    if (!replay) askKind(p);
    flash(`Pin ${p.name} dropped (${ftIn(p.aim || 0)}, by ${p.type === 'DEPTH' ? 'depth' : 'plane'})`);
    if (st.tracker?.anchor) st.tracker.anchor(p.at).then((a) => { if (a && st.walk && st.walk.pins.includes(p)) { p.anchor = a; p.anchorAt = st.tracker?.anchorAt(a) || { ...p.at }; } });
}
/* WHAT IS IT? (lib/things.js; the goal, 2026-11-22: a walk "can place sprinkler heads, gutters (where they connect to
   the roof and where they let out)"). After a pin is dropped a row asks; a tap gives the pin its kind, and at the
   walk's end the pins with a kind are kept with the map. No tap: it stays a plain pin, as before. */
function askKind(p) {
  const el = $('#kinds'); if (!el) return;
  clearTimeout(st.kindsTimer);
  el.innerHTML = KINDS.map((k) => `<button type="button" data-kind="${k.id}">${esc(k.name)}</button>`).join('') + '<button type="button" data-kind="">Just a pin</button>';
  el.hidden = false;
  el.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const k = kindOf(b.dataset.kind);
    if (k && st.walk?.pins.includes(p)) { p.kind = k.id; flash(`${k.name}: kept with the map when the walk ends`); log(`pin ${p.name} is a ${k.short}`); }
    el.hidden = true; clearTimeout(st.kindsTimer);
  };
  st.kindsTimer = setTimeout(() => { el.hidden = true; }, 12000);
}
function doCheck(f, { replay = false } = {}) {
    if (!f?.hit || !st.walk.pins.length) return;
    const p = nearestPin(f.hit);
    if (!p) { flash('No pin within 20 ft of the crosshair'); return; }
    if (!replay) recordAct({ a: 'check' });
    const c = checkPin(st.walk, p, f.hit);
    flash(`Pin ${p.name}: ${ftIn(c.offLevelM)} off as placed${c.offAnchorLevelM != null ? `, ${ftIn(c.offAnchorLevelM)} as anchored` : ''} (${ftIn(c.walkedSinceM)} walked since)`);
}
/**
 * A ROOF CORNER MARKED BY TWO AIMS (lib/roof-corner.js; the owner, 2026-11-11: a prescribed, checked procedure, the mark
 * made automatically). Mark starts it; each frame goes to the sighting, whose words show in the middle of the view;
 * when two sight lines cross at the eave it is marked with no tap. Mark again cancels.
 */
function startSight(f, target) {
  const groundY = st.L.groundY ?? (f.pose ? f.pose.position.y - 1.4 : 0);
  /* THE EAVE'S HEIGHT FROM A CORNER ALREADY MARKED (2026-11-12: R2 refused 3.9 ft low on the owner's walk; the ground
     under the phone had read 0.3 m different from one corner to the next, and a lot slopes): a marked roof corner's
     crossing is that eave's height in the session, and the lidar knows how much higher or lower this eave is (each
     one's ground + its height over it). The ground under the phone is only used for the first corner. */
  const dem = st.lid.overlay?.dem1, abs = (p) => { const g = dem ? demAt(dem, p.map[0], p.map[1], NaN) : NaN; return Number.isFinite(g) ? g + p.roof.eaveM : NaN; };
  const ys = [];
  for (const m of st.L.marks) { if (m.by !== 'ROOF') continue; const p = st.points.find((q) => q.id === m.id); if (p?.roof && Number.isFinite(abs(p)) && Number.isFinite(abs(target))) ys.push(m.y + abs(target) - abs(p)); }
  /* BUT NOT FOR A LOW CORNER (the owner, 2026-11-16, R3 on a 6 ft stone wall: "the scanning only worked when i pointed
     the cursor 2 feet down the wall from the actual top"; the estimate from the marked roofs was 0.77 m under the
     ground's): a wall's top is near the ground the phone stands on, which the phone reads well there, while the lidar's
     coarse ground beside a wall (one side higher than the other, often) is the rough part of that estimate */
  const low = target.roof.eaveM < LOW_EAVE_M;
  const eaveY = ys.length && !low ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  const at = fitFor(st.L, st.walk.odo) ? sessionOf(st.L, target.map, st.walk.odo, 0) : null;
  st.sight = { S: newSight({ eaveM: target.roof.eaveM, groundY, eaveY, expect: at ? { x: at.x, z: at.z } : null, loose: !!target.roof.picked || target.roof.sure === false }), target, rays: 0 };
  log(`roof corner ${target.name} (${target.roof.label}, eave ${target.roof.eaveM} m): sighting started, ground y ${groundY.toFixed(2)}${eaveY != null ? `, eave y ${eaveY.toFixed(2)} from ${ys.length} marked (by the ground it would be ${(groundY + target.roof.eaveM).toFixed(2)})` : low && ys.length ? `, a low corner: eave y ${(groundY + target.roof.eaveM).toFixed(2)} by the ground (the marked ones would say ${(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(2)})` : ''}${at ? ', the map places it' : ''}`);
}
/** The next unmarked roof corner's sighting, started by itself once the walk is tracking. */
function autoSight(f) {
  if (st.sight || st.sightPaused || !st.walk || !st.L || !f.pose || f.tracking !== 'normal') return;
  if (Date.now() - (st.sightEndedAt || 0) < 2500) return; // a breath between corners, and after a refusal
  // after the phone's tracking jumped (L.stale), only the corners sighted since count as marked: the nearest is asked first
  const stale = st.L.stale;
  const marked = new Set(st.L.marks.filter((m) => !stale || m.odo > stale.odo).map((m) => m.id));
  const chosen = st.chosen ? st.points.find((p) => p.id === st.chosen) : null;
  // the corner tapped on the mini map goes first, and is scanned even when it is already marked (st.rescan)
  let target = chosen?.roof && (!marked.has(chosen.id) || st.rescan === chosen.id) ? chosen : st.points.find((p) => p.roof && !marked.has(p.id));
  /* A CORNER THAT DISAGREES WITH THE OTHERS IS ASKED FOR AGAIN, ONCE (locate.js leftOutOf; the owner's R1 at home sat
     9 ft from where R2 and R3 put it): when every corner is marked and one was left out of the fit, it is the next
     target, so the walk ends with all of them agreeing instead of carrying a wrong one. */
  if (!target && !stale) {
    const again = leftOutOf(st.L).find((id) => !(st.resighted ||= new Set()).has(id));
    const p = again != null ? st.points.find((q) => q.id === again && q.roof) : null;
    if (p) { target = p; st.resightOf = p.id; }
  }
  if (stale && target && !chosen && f.pose) {
    let bd = Infinity;
    for (const p of st.points) {
      if (!p.roof || marked.has(p.id)) continue;
      const q = fitFor(st.L, st.walk.odo) ? sessionOf(st.L, p.map, st.walk.odo, 0) : null;
      const d = q ? Math.hypot(q.x - f.pose.position.x, q.z - f.pose.position.z) : Infinity;
      if (d < bd) { bd = d; target = p; }
    }
  }
  st.nextHint = null;
  /* NO ROOF CORNER LEFT TO ASK FOR (the owner at home, 2026-11-15: R1 marked, then nothing, four walks running; the
     map's other points, R2 and R3, were most likely ground points put there before the roof corners existed, which
     this mode never asks for because they need a tap). Say so, instead of going quiet: what is done, and what the
     other points need. */
  if (!target && !leftOutOf(st.L).some((id) => !(st.resighted ||= new Set()).has(id))) {
    const roofs = st.points.filter((p) => p.roof), others = st.points.filter((p) => !p.roof && p.kind === 'ref' && !marked.has(p.id));
    st.roofsDone = marked.size && roofs.length ? { n: roofs.length, others: others.map((p) => p.name) } : null;
    return;
  }
  st.roofsDone = null;
  /* NOT FROM ACROSS THE YARD (the owner, 2026-11-12: looking at a corner already done "goes through the prompts for
     rescanning... It should say 'move on to next prompt X feet to the Y direction'"): once the map is lined up, the
     next corner's sighting waits until the phone is within reach of it and facing it; until then the middle of the
     view says how far and which way. Before the map is lined up there is nothing to steer by, so it starts as it did. */
  /* ...BUT ONLY WHEN THE MAP IS LINED UP BY THE CORNERS THEMSELVES (the owner, 2026-11-15, at home: "The roof
     scanning wont move on to the 2nd roof corner"). With one corner marked the walk is placed by something rougher
     (Street View's position, an earlier walk), which can put the next corner yards from where it is; waiting to be
     "within reach and facing it" by that placement can then wait for ever. So the waiting begins with two corners
     marked; before that the next corner starts at once, as it did. And the wait can always be skipped: a tap on the
     hint in the middle of the view starts the corner where the phone is (st.sightNow). */
  const lined = !stale && marked.size >= 2 && fitSource(st.L, st.walk.odo) !== 'geo';
  const s = lined && !st.sightNow && fitFor(st.L, st.walk.odo) ? sessionOf(st.L, target.map, st.walk.odo, st.L.groundY ?? f.pose.position.y - 1.4) : null;
  st.sightNow = false;
  if (s && f.pose.quaternion) {
    const c = f.pose.position, w = whereIs([c.x, c.y, c.z], lookOf(f.pose.quaternion), [s.x, s.y, s.z]);
    if (w.m > NEAR_SIGHT_M || !w.facing) { st.nextHint = { target, w, done: marked.size }; return; }
  } else if (marked.size) flash(`Next: ${target.name}, the roof's ${target.roof.label}. Walk to it, then aim up at it.`);
  if (st.resightOf === target.id) { (st.resighted ||= new Set()).add(target.id); st.resightOf = null; const two = new Set(st.L.marks.filter((m) => m.kind === 'ref').map((m) => m.id)).size === 2;
    flash(two ? `${target.name} and the next corner are not the distance apart the map has them (the phone may have drifted between them): aim at ${target.name} once more.` : `${target.name} does not agree with the other corners: aim at it once more.`); log(`roof corner ${target.name} left out of the fit (it disagrees with the others): asked for again`); }
  startSight(f, target);
}
/** The middle of the view between corners: where the next one is, or that they are all done. */
function showNext() {
  const el = $('#guide'), h = st.nextHint;
  if (st.sight || st.tapMode) return;
  const d = st.roofsDone;
  if (!h && d && (d.n < 2 || d.others.length)) {
    // every roof corner is marked, but the map is not lined up by them (one corner), or other points wait unasked
    st.guideNext = false; el.hidden = false;
    $('#guide-say').textContent = d.n < 2 ? 'Only 1 roof corner on this map: it needs 2' : `All ${d.n} roof corners marked`;
    $('#guide-detail').textContent = `${d.others.length ? `${d.others.join(', ')} on your map ${d.others.length === 1 ? 'is' : 'are'} not on a building corner the lidar can tell the roof's height at, so ${d.others.length === 1 ? 'it cannot' : 'they cannot'} be sighted. ` : ''}Exit, and on the map's lidar view put ${d.n < 2 ? 'a second point' : 'the points'} on a building's corner (it says "a roof corner" when it takes).`;
    $('#guide-bar').style.width = '100%';
    return;
  }
  if (!h) { if (st.guideNext) { el.hidden = true; st.guideNext = false; } return; }
  st.guideNext = true; el.hidden = false;
  $('#guide-say').textContent = `Next: ${h.target.name}, ${h.w.ft} ft ${h.w.word}`;
  $('#guide-detail').textContent = `The roof's ${h.target.roof.label}. It starts by itself when you face it from within ${Math.round(NEAR_SIGHT_M * FT)} ft. Already there? Tap here to start it now.`;
  $('#guide-bar').style.width = '0%';
}
/** Start over (the red button): this walk's marks and fixes gone, the first corner asked for again. Two taps. */
function startOver() {
  if (!st.walk || !st.L) return;
  if (Date.now() - (st.startOverAt || 0) > 3500) { st.startOverAt = Date.now(); flash('Tap Start over again to clear this walk\'s marks'); return; }
  st.startOverAt = 0;
  const n = st.L.marks.length;
  st.L.marks.length = 0; st.L.holds = []; st.L.fixes = []; st.L.streak = [];
  st.undoMarks = []; st.sight = null; st.sightPaused = false; st.sightEndedAt = 0; st.chosen = null; st.nextHint = null; st.roofsDone = null; st.rescan = null;
  $('#guide').hidden = true;
  log(`start over: ${n} marks cleared`); flash('Started over: aim up at the first roof corner');
}
function stepSight(f) {
  const s = st.sight; if (!s) return;
  // the camera's depth at the crosshair and just round it (range in metres, null where it reads nothing), for the
  // sighting's check against where the corner should be
  let depths = null;
  if (f.depth?.at && f.pose) {
    const c = f.pose.position;
    depths = [[0.5, 0.5], [0.46, 0.5], [0.54, 0.5], [0.5, 0.47], [0.5, 0.53]].map(([x, y]) => { try { const p = f.depth.at(x, y); return p ? Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) : null; } catch { return null; } });
  }
  sight(s.S, { t: f.t, pos: f.pose?.position, quat: f.pose?.quaternion, tracking: f.tracking, depths });
  const S = s.S, el = $('#guide');
  if (S.rays.length !== s.rays) { s.rays = S.rays.length; try { navigator.vibrate?.(60); } catch { /* no buzz */ } }
  st.guideNext = false; el.hidden = false; $('#guide-say').textContent = `${s.target.name}, the roof's ${s.target.roof.label}: ${S.say}`; $('#guide-detail').textContent = S.detail || ''; $('#guide-bar').style.width = `${Math.round((S.progress || 0) * 100)}%`;
  if (!S.done) return;
  // a refusal stays up long enough to read, with its reason (the owner, 2026-11-12: "I thought I did, then it asked again")
  st.sight = null; st.sightEndedAt = Date.now(); if (!S.done.ok) { st.sightEndedAt += 6000; $('#guide-say').textContent = `${s.target.name} was NOT marked`; $('#guide-detail').textContent = `${S.done.why}. It will ask again in a few seconds.`; }
  setTimeout(() => { if (!st.sight && !st.guideNext) el.hidden = true; }, S.done.ok ? 1800 : 8000);
  (st.walk.roofSights ||= []).push({ name: s.target.name, ok: S.done.ok, why: S.done.why || null, sights: S.done.sights ?? S.rays.length, missM: S.done.missM != null ? +S.done.missM.toFixed(3) : null, turnDeg: S.done.turnDeg != null ? Math.round(S.done.turnDeg) : null, eaveOffM: S.done.eaveOffM != null ? +S.done.eaveOffM.toFixed(2) : null, steps: S.log });
  if (!S.done.ok) {
    flash(`${s.target.name} not marked: ${S.done.why}`); log(`roof corner ${s.target.name} not marked: ${S.done.why}`);
    // a corner being scanned AGAIN is not asked for over and over: it is marked already; another tap on the mini map tries again
    if (st.rescan === s.target.id && st.L.marks.some((m) => m.id === s.target.id)) { st.rescan = null; st.chosen = null; $('#guide-detail').textContent = `${S.done.why}. It keeps its first mark; tap it on the mini map to try again.`; }
    return;
  }
  try { navigator.vibrate?.([60, 60, 120]); } catch { /* no buzz */ }
  // scanned before on this walk: how far the phone now has the corner from where it had it then (the walk's own slide)
  const before = [...st.L.marks].reverse().find((m) => m.id === s.target.id && m.kind === 'ref');
  mark(st.L, s.target, { position: S.done.position, distance: S.done.distance, type: 'ROOF' }, st.walk.odo);
  const slid = before ? { m: Math.hypot(S.done.position.x - before.ar[0], -S.done.position.z - before.ar[1]), walkedM: st.walk.odo - before.odo } : null;
  st.rescan = null;
  // after a tracking jump: two corners sighted afresh, and the marks from before it are let go
  if (st.L.stale) {
    const since = new Set(st.L.marks.filter((m) => m.odo > st.L.stale.odo).map((m) => m.id));
    if (since.size >= 2) { const n0 = st.L.marks.length; st.L.marks = st.L.marks.filter((m) => m.odo > st.L.stale.odo); log(`lined up afresh after the jump: ${n0 - st.L.marks.length} earlier marks let go`); st.L.stale = null; }
  }
  const n = new Set(st.L.marks.filter((m) => m.kind === 'ref').map((m) => m.id)).size;
  flash(slid ? `${s.target.name} marked again: the phone has it ${ftIn(slid.m)} from where it had it ${Math.round(slid.walkedM * FT)} ft of walking ago` : n >= 2 ? `${s.target.name} marked: lined up by ${n} references` : `${s.target.name} marked: one more reference lines the map up`);
  if (slid) log(`roof corner ${s.target.name} scanned again after ${Math.round(slid.walkedM * FT)} ft: ${ftIn(slid.m)} from its first place in the walk's own frame`);
  log(`roof corner ${s.target.name} marked: ${S.done.sights} aims ${Math.round(S.done.turnDeg)} degrees apart, lines ${(S.done.missM * 100).toFixed(0)} cm apart, ${S.done.eaveOffM.toFixed(2)} m off the lidar's eave`);
  st.undoMarks.push({ id: s.target.id, name: s.target.name, check: false, at: Date.now() });
  st.chosen = null;
}
function doMark(f, { replay = false, target: tid = null } = {}) {
    const target = tid != null ? st.points.find((q) => q.id === tid) : nextTarget(); if (!target) return;
    /* A ROOF CORNER MARKS ITSELF (the owner, 2026-11-11: "I was hoping we could do it automatically so nothing has to
       be pressed (tapping adds a brief shake, and the user may be holding the phone awkwardly)"): autoSight starts the
       sighting; this button only pauses it and lets it go on. */
    if (target.roof) {
      st.sightPaused = !st.sightPaused;
      if (st.sightPaused) { st.sight = null; $('#guide').hidden = true; flash(`${target.name}: paused. Tap again to go on.`); } else flash(`${target.name}: aim up at the roof corner`);
      return;
    }
    if (!f?.hit) return;
    if (!replay && far(f.hit) && Date.now() - st.farAt > FAR_AGAIN) { st.farAt = Date.now(); flash(`Aiming from ${ftIn(f.hit.distance)}: step closer, or tap again to mark anyway`); return; }
    recordAct({ a: 'mark', target: target.id });
    const odo = st.walk.odo;
    if (target.kind === 'check') {
      const c = checkError(st.L, target, f.hit, odo);
      mark(st.L, target, f.hit, odo);
      if (c) { st.walk.checks.push({ name: target.name, errorM: c.errorM, by: c.by, errorFixM: c.errorFixM, errorRefsM: c.errorRefsM, walkedSinceFixM: c.walkedSinceFixM, aimM: c.aim, walkedM: odo, marksBefore: st.L.marks.length - 1, fixesBefore: st.L.fixes.length }); flash(`${target.name}: ${ftIn(c.errorM)} off (${c.by === 'fix' ? 'lidar fix' : 'references'}${c.errorRefsM != null && c.by === 'fix' ? `; ${ftIn(c.errorRefsM)} by the references alone` : ''})`); } else flash(`${target.name} marked; not placed yet, so no error to give`);
    } else {
      mark(st.L, target, f.hit, odo);
      const n = new Set(st.L.marks.filter((m) => m.kind === 'ref').map((m) => m.id)).size;
      flash(n >= 2 ? `${target.name} marked: lined up by ${n} references` : `${target.name} marked: one more reference lines the map up`);
    }
    log(`marked ${target.name} (${target.kind}) from ${f.hit.distance?.toFixed(2)} m`);
    st.undoMarks.push({ id: target.id, name: target.name, check: target.kind === 'check' && st.walk.checks.length && st.walk.checks[st.walk.checks.length - 1].name === target.name, at: Date.now() });
    st.chosen = null;
}
function doUndo() {
    recordAct({ a: 'undo' });
    // the newest of: a reference or check mark (kept here), a pin or a half-done measure (walk.js)
    const m = st.undoMarks[st.undoMarks.length - 1], lastPin = st.walk.pins[st.walk.pins.length - 1];
    const pinAt = lastPin ? st.walk.startedAt + (lastPin.t || 0) : 0;
    if (m && m.at >= pinAt && !st.walk.pendingMeasure) {
      st.undoMarks.pop();
      const i = st.L.marks.map((x) => x.id).lastIndexOf(m.id);
      if (i >= 0) st.L.marks.splice(i, 1);
      if (m.check) st.walk.checks.pop();
      log(`unmarked ${m.name}`); flash(`${m.name}: last mark removed`);
      return;
    }
    const u = undo(st.walk); flash(u === 'pin' ? 'Pin removed' : u === 'measure' ? 'First mark cleared' : 'Nothing to undo');
}

function wireRest() {
  $('#exit').addEventListener('click', () => { if (st.tracker) st.tracker.stop(); else finish(); });
  $('#move').addEventListener('click', () => $('#overlay').classList.toggle('bar-low'));
  $('#lidar-toggle').classList.toggle('off', !st.lidarOn);
  $('#lidar-toggle').addEventListener('click', () => { st.lidarOn = !st.lidarOn; $('#lidar-toggle').classList.toggle('off', !st.lidarOn); flash(st.lidarOn ? 'Lidar shown' : 'Lidar hidden'); });
}

/* ------------------------------------------------------------ results */

const KEY = 'scan-walks';
const kept = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const keep = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-12))); } catch { /* this phone only */ } };

function finish() {
  // inside the Android app: make sure ARCore is stopped and the page is opaque again, however the walk ended (an exit
  // tapped while the app was still starting left the camera running under the summary: owner, 2026-11-07)
  if (window.LawnARNative) { try { window.LawnARNative.stop(); } catch { /* gone */ } document.documentElement.classList.remove('native-ar'); }
  if (!st.walk) return;
  const w = st.walk, L = st.L;
  w.endedAt = w.endedAt || Date.now();
  try { if (st.gpsWatch != null) navigator.geolocation.clearWatch(st.gpsWatch); } catch { /* none */ }
  st.gpsWatch = null;
  // the pins' map positions, by the fit at the moment each was dropped: kept on this phone, drawn on the photo (phase 3 writes them to the map)
  if (L && st.origin) {
    for (const p of w.pins) {
      const m = mapOf(L, pinNow(p), p.odo);
      if (m) st.pins.push({ name: `${p.name}`, map: m, at: w.startedAt });
      // how far the pin is from the nearest reference or check point (the owner says which it was dropped on): distances only
      p.nearest = nearestNamed(L, pinNow(p), p.odo, st.points);
    }
    savePins();
  }
  const crumbs = st.crumbs?.list.length && st.tracker?.anchorAt ? crumbMoves(st.crumbs, (h) => st.tracker.anchorAt(h)) : null;
  const refs = st.points.filter((p) => p.kind === 'ref').map((p) => ({ name: p.name, marks: L ? L.marks.filter((m) => m.id === p.id).length : 0, leftOutM: L ? r3(leftOut(L.marks.filter((m) => m.kind === 'ref'), p.id)) : null }));
  const s = summary(w, {
    page: 'yard AR test v2', pointKinds: st.points.map((p) => `${p.name}:${p.roof ? 'roof' : p.kind}`).join(' '), roofSights: w.roofSights || null, recordOnly: !!st.recordOnly, features: w.features || null, depthType: w.depthType || null, anchors: st.anchors ? anchorsKept(st.anchors) : null, depthFill: st.depthFill ? { frames: st.depthFill.frames, holes: +(st.depthFill.zero / Math.max(1, st.depthFill.cells)).toFixed(3), past8m: +(st.depthFill.far / Math.max(1, st.depthFill.cells)).toFixed(3), weak: +(st.depthFill.weak / Math.max(1, st.depthFill.cells)).toFixed(3), minConf: st.depthFill.minConf } : null, rawAsked: !!st.rawDepth, geo: geoSummary(), depthSpikes: st.spikes ? { ...st.spikes, share: +(st.spikes.flagged / Math.max(1, st.spikes.cells)).toFixed(4), recordOnly: true } : null, walkFix: st.walkStats ? { ...st.walkStats, share: L?.walk?.ok ? +L.walk.share.toFixed(3) : null, margin: L?.walk?.ok ? +L.walk.margin.toFixed(3) : null, walkedM: L?.walk?.ok ? Math.round(L.walk.walkedM) : null } : null, semantics: st.caps?.native ? { on: !!st.tracker?.semantics, dims: st.semDims || null, ...(semSummary(st.sem) || {}) } : null, crumbs: crumbs ? { n: crumbs.n, held: crumbs.held, lost: crumbs.lost, refused: crumbs.refused, medianM: crumbs.medianM, maxM: crumbs.maxM, maxLevelM: crumbs.maxLevelM, worstOdo: crumbs.worstOdo } : null, app: st.caps?.native ? { app: st.caps.native.app, bridge: st.caps.native.bridge, device: st.caps.native.device, camera: st.started?.camera ?? null, image: st.started?.image ?? null, modes: st.started?.modes ?? null, streetscape: st.started?.streetscape ?? null, streetError: st.started?.streetError ?? null, recording: st.started?.recording ?? null, recordError: st.started?.recordError ?? null, geoDepthPoints: st.geoDepthN || 0, grabW: st.grabW || null } : null, replayOf: st.replayOf || null, failed: w.failed || null, errors: st.errors.map((e) => e.what).slice(-30),
    references: refs, checks: (w.checks || []).map((c) => ({ ...c, errorM: r3(c.errorM), errorFixM: r3(c.errorFixM), errorRefsM: r3(c.errorRefsM), walkedSinceFixM: r2(c.walkedSinceFixM), aimM: r2(c.aimM), walkedM: r2(c.walkedM) })),
    pinsNear: w.pins.map((p) => ({ name: p.name, nearest: p.nearest ? { name: p.nearest.name, m: r2(p.nearest.m), byRefsM: r2(p.nearest.byRefsM) } : null })),
    fix: L ? summaryOf(L) : null, surfaceSeen: st.surfCount || null, lidar: st.lid.ready ? { points: st.lid.ready.points, solid: st.lid.ready.solid, shift: st.lid.ready.shift, rule: st.lid.ready.rule || null, structures: st.lid.ready.structures || null, tallCells: st.lid.overlay ? st.lid.overlay.tall.length / 5 : null } : st.lid.error ? { error: st.lid.error } : null,
  });
  s.id = `${w.startedAt}`; s.saved = null;
  // ...and ended: what a dev-only extra says of the walk (counts) is kept in its summary
  { const add = {}; document.dispatchEvent(new CustomEvent('yard-walk', { detail: { phase: 'end', walk: s.id, add, map: st.map || null, origin: st.origin || null, lawn: st.lawn || [], ground: st.lid?.overlay?.dem1 || null } })); if (Object.keys(add).length) s.extras = add; }
  try { s.perf = perfOf(st.wperf); st.upPerf = { perf: st.wperf, id: s.id }; } catch (e) { log(`speed numbers: ${e.message}`); }
  if (st.twin) {
    sendTwin(flush(st.twin, Date.now(), liveOf(L, w, { ended: true, summary: s.id, crumbs: crumbs ? crumbs.list : null, walk: L?.walk?.ok ? { T: L.walk.T, share: L.walk.share, margin: L.walk.margin, walkedM: L.walk.walkedM, from: L.walk.from } : null, recordOnly: !!st.recordOnly, points: pointsKept(), gpsTrail: trailKept(), geoTrail: geoKept(), anchors: st.anchors ? anchorsKept(st.anchors) : null, prev: prevKept() })));
    s.twin = { ...st.twin.counts, camera: st.twin.camera, off: st.twinUp.off };
  }
  st.twin = null;
  st.tracker = null; st.walk = null; st.L = null; st.ar = null; st.drawer = null;
  if (st.holdUploads) { st.holdUploads = false; st.outbox?.hold?.(false); }
  setTimeout(() => tellApp(st.outbox?.status?.() || st.upStatus || { pending: 0 }), 0);   // the walk over: the service runs until the outbox is empty
  st.replayOf = null; st.replayImage = null; st.replaySmall = false; // a replay is one walk; the next starts from the camera again
  $('#overlay').hidden = true; document.body.classList.remove('in-ar');
  const list = kept(); list.push(s); keep(list);
  renderResults(s.id); drawMap();
  post(s);
  // kept as its map's reference, by itself (keepReference): said on the walk's card when it is known
  if (L && !s.failed) {
    const say = (text) => { const all = kept(), mine = all.find((x) => x.id === s.id); if (mine) { mine.reference = text; keep(all); renderResults(s.id); if (text && !/^Saving/.test(text)) post(mine); } };   // posted again with the verdict, so the walks log says why (the owner, 2026-11-15)
    say('Saving this walk as the map\'s reference…');
    keepReference(L, String(w.startedAt)).then(async (text0) => { const placed = await keepThings(L, w).catch((e) => `The things placed were NOT kept: ${e.message}.`); const text = [text0, placed].filter(Boolean).join(' '); say(text || ''); if (text) { log(text); flash(/^Saved/.test(text) ? 'Saved as this map\'s reference' : /^Kept on the phone/.test(text) ? 'Kept as this map\'s reference: it goes up when there is signal' : /^The reference already/.test(text) ? 'The reference already had all of this walk' : 'Not saved as the reference: see the walk\'s card'); } askReference(); })
      .catch((e) => say(`NOT saved as the reference: ${e.message}`));
  }
}
const r2 = (v) => (v == null ? null : +Number(v).toFixed(2)), r3 = (v) => (v == null ? null : +Number(v).toFixed(3));

/** The twin's parts up to the site (src/twin.js), one at a time, each tried twice; a missing bucket stops it. */
/* THE OUTBOX (scan/lib/outbox.js, 2026-11-07): every part of a walk is kept on the phone first and leaves only when
   the site has it; a failed part waits and goes again, and parts left by a walk closed early go up the next time the
   page opens. Walk summaries the site did not take are posted again then too. */
/* THE APP SENDS (bridge 8, android Parts.kt; the owner, 2026-11-25: after a walk, with the app left, the notification
   showed "but the numbers don't move. The full recordings have historically sent fine in the background, so yea it
   sounds like doing the walk upload data the same way would be good. Build it."). In an app that can, each part is
   handed to the app as soon as it is made (its route on this site, its type, its bytes) and the app keeps and sends
   it, in the background too; the outbox here is then only the few parts not yet handed over. In a browser, or an
   older app, the page sends as before. */
const nativeParts = () => { const N = window.LawnARNative; return N && typeof N.keepPart === 'function' && typeof N.partsStatus === 'function' ? N : null; };
const partUrl = (p) => { const ref = /^ref:/.test(p.name) ? p.name.slice(4) : null; return ref != null ? `/api/scan/reference?map=${encodeURIComponent(ref)}&walk=${encodeURIComponent(p.walk)}` : `/api/scan/twin?walk=${encodeURIComponent(p.walk)}&part=${encodeURIComponent(p.name)}`; };
async function handPart(p) {
  const N = nativeParts(); if (!N) return sendPart(p);
  const u8 = new Uint8Array(await new Response(p.body).arrayBuffer());
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return N.keepPart(partUrl(p), p.type || 'application/octet-stream', btoa(bin)) ? 'ok' : 'retry';
}
/** The upload's state for the page: the outbox's own, with what the app holds added when the app sends. */
function uploadsNow() {
  const u = st.upStatus, N = nativeParts();
  if (!N) return u;
  let n = null;
  try { n = JSON.parse(N.partsStatus()); } catch { n = null; }
  if (!n) return u;
  const a = u || { pending: 0, bytes: 0 };
  return { ...a, pending: (a.pending || 0) + n.pending, bytes: (a.bytes || 0) + n.bytes, sending: !!(a.sending || n.sending), sent: n.sent, sentBytes: n.sentBytes, dropped: (a.dropped || 0) + n.dropped, lastError: n.lastError || a.lastError || null, off: a.off || n.off || null, byApp: true };
}
async function startOutbox() {
  const store = (await idbStore().catch(() => null)) || memoryStore();
  st.outbox = newOutbox({ store, send: handPart, onChange: (u) => { st.upStatus = u; tellApp(u); uploadSettled(u); if (st.twinUp) { st.twinUp.off = u.off; st.twinUp.sent = u.sent; st.twinUp.failed = u.dropped; } renderUploads(); } });
  await st.outbox.refresh();
  st.outbox.kick();
  for (const w of kept().filter((x) => x.saved === false)) post(w);
  window.addEventListener('online', () => { st.outbox?.kick(); for (const w of kept().filter((x) => x.saved === false)) post(w); });
}

/** The app (bridge 6) is told how many parts wait, so it keeps this page running with the screen off while any do:
    at once when they begin or end, every few seconds between. */
function tellApp(u) {
  const N = window.LawnARNative;
  if (!N || typeof N.partsPending !== 'function' || nativeParts()) return;   // an app that sends for itself needs no telling
  /* KEPT ON FROM THE WALK'S START TO THE LAST PART GONE (2026-11-24; the owner: "The background upload doesn't appear
     to be working"; two walks that evening stopped sending part way, one with 247 of its 491 pictures up). The page
     said "none left" whenever it caught up during a walk, and the app stopped its keep-running service; asked to start
     it again with the app already in the background (the owner gone to another app, or the screen off), Android
     refuses a new service of that kind, the page is paused and the parts wait. Now, while a walk is on, at least one
     part is said to wait, so the service started in the foreground stays started until the walk ends and the outbox
     is empty. */
  const n = u.off ? 0 : Math.max(u.pending || 0, st.walk ? 1 : 0), now = Date.now(), was = st.toldApp || { n: 0, at: 0 };
  if ((n > 0) === (was.n > 0) && now - was.at < 4000) return;
  st.toldApp = { n, at: now };
  try { N.partsPending(n, u.bytes || 0); } catch { /* an older app */ }
}

/** Everything gone: the finished walk's summary is posted again with its upload's numbers (it was posted at the walk's
    end, before most parts had left). Once a walk. */
function uploadSettled(u) {
  const up = st.upPerf;
  if (!up || up.told || u.pending || u.sending || st.walk) return;
  up.perf.uploadDone(); up.told = true;
  const all = kept(), mine = all.find((x) => x.id === up.id);
  if (!mine) return;
  try { mine.perf = { ...mine.perf, upload: up.perf.summary().upload }; keep(all); post(mine); } catch { /* the numbers can be lost; the walk cannot */ }
}

/** One part to the site: 'ok', 'retry' (no answer, 5xx, 408, 429), 'drop' (refused) or 'off' (no bucket). */
async function sendPart(p) {
  const t0 = performance.now(), wp = st.upPerf?.perf || st.wperf || pagePerf;
  let out = 'retry';
  try { out = await sendPartNow(p); return out; } finally { wp.part(performance.now() - t0, p.body?.size ?? p.body?.byteLength ?? p.body?.length ?? 0, out); }
}
const SEND_TIMEOUT_MS = 60000;
async function sendPartNow(p) {
  // a map's reference that could not leave at the walk's end (keepReference) goes to its own route
  const ref = /^ref:/.test(p.name) ? p.name.slice(4) : null;
  const url = ref != null ? `/api/scan/reference?map=${encodeURIComponent(ref)}&walk=${encodeURIComponent(p.walk)}` : `/api/scan/twin?walk=${encodeURIComponent(p.walk)}&part=${encodeURIComponent(p.name)}`;
  const res = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': p.type }, body: p.body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }); // a send that hangs (one took 12 minutes) is let go and tried again
  if (res.ok) return 'ok';
  if (res.status === 503) { p.offWhy = 'the site has no twin bucket yet'; return 'off'; }
  if (res.status === 408 || res.status === 429 || res.status >= 500) return 'retry';
  if (res.status === 401 || res.status === 403 || res.status === 404) return 'retry'; // signed out for now: keep it for later
  p.dropWhy = ((await res.json().catch(() => ({})))?.error || `${res.status}`).slice(0, 80);
  return 'drop';
}

/* ------------------------------------------------ the things placed on the map (lib/things.js) */
/** The map's things, read once at a walk's start; none, or no signal, is no things. */
async function loadThings() {
  st.things = [];
  const map = st.map; if (!map) return;
  try {
    const r = await fetch(`/api/scan/things?map=${encodeURIComponent(map)}`, { credentials: 'same-origin' });
    if (r.ok && st.map === map) { st.things = standing(decodeThings(await r.text())); if (st.things.length) log(`things placed on earlier walks: ${st.things.length}`); }
  } catch { /* no signal: none shown */ }
}
/* What vouched for the walk's place on the map (things.js GRADES): three roof corners that all agree, the earlier
   walk's shape, two corners; anything else is unsure. Read at the walk's END, when the fit is the walk's last word. */
function gradeOfFix(L, odo) {
  const src = fitSource(L, odo);
  const corners = new Set((L.marks || []).filter((m) => m.kind === 'ref').map((m) => m.id)).size, left = leftOutOf(L).length;
  if (src === 'refs' || corners >= 2) { if (corners - left >= 3 && !left) return 'corners3'; if (src === 'earlier') return 'earlier'; if (corners - left >= 2) return 'corners2'; }
  return src === 'earlier' ? 'earlier' : 'unsure';
}
/* SHARED WITH THE MAP'S RECORD (docs/MAPS.md, the scan tool's part; the owner, 2026-11-22: "Yes. Ask the water map
   how it wants that", and the water session's answer): each thing's present place, for the water map to OFFER. The
   scan tool's part is read first so nothing else in it is lost. A failure here loses nothing: the things are kept
   on the scan site and go into the record at the next walk's end. -> what happened, in words. */
async function shareThings(things) {
  const map = st.map;
  try {
    const had = st.site?.tools?.scan?.data && typeof st.site.tools.scan.data === 'object' ? st.site.tools.scan.data : {};
    const data = { ...had, things: forRecord(things, (at) => fromLocal(st.origin, at)), thingsAt: new Date().toISOString() };
    const rr = await fetch(`/api/maps/tool?id=${encodeURIComponent(map)}&tool=scan`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, basedOn: st.site?.at || null }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    if (rr.ok && st.site) st.site.tools = { ...(st.site.tools || {}), scan: { ...(st.site.tools?.scan || {}), data } };
    return rr.ok ? '; shared with the map for the water map' : `; NOT yet shared with the map's record (the site answered ${rr.status})`;
  } catch { return '; NOT yet shared with the map\'s record (no signal)'; }
}

/* THE THINGS PLACED ON THIS MAP, LISTED UNDER THE START BUTTONS (2026-11-22; the walk in the rain left the same gutter
   pinned twice 6-7 ft apart and the page had no way to take one away). Each by its id (the same id is on the map
   above), what it is, what vouched for its place and how many times it was sighted; "Take away" marks it gone (kept,
   not deleted: "Put back" undoes it), and the list is kept and shared with the map's record again. */
const GRADE_WORDS = { corners3: 'three roof corners agreed', earlier: 'placed by the earlier walk', corners2: 'two roof corners', unsure: 'the walk\'s place was unsure' };
async function askThings() {
  const box = $('#things-list'); if (!box) return;
  st.placed = []; box.hidden = true;
  const map = st.map; if (!map) return;
  try {
    const r = await fetch(`/api/scan/things?map=${encodeURIComponent(map)}`, { credentials: 'same-origin' });
    if (r.ok && st.map === map) st.placed = decodeThings(await r.text());
  } catch { /* no signal: none listed */ }
  drawThings(); drawMap();
  /* THE MAP'S RECORD CAUGHT UP (2026-11-23): the list can change off the page (a walk found bad afterwards has its
     doubled things taken away by the workflow, scan/tools/things-fix.mjs). When what the record holds is not what
     the list says (which are there, which are gone), it is shared again, quietly. */
  try {
    const sig = (a) => JSON.stringify((a || []).map((t) => [t.id, t.kind, !!t.gone, t.e, t.n]).sort());
    const rec = st.site?.tools?.scan?.data?.things;
    if (st.map === map && st.placed.length && st.origin && sig(rec) !== sig(forRecord(st.placed, (at) => fromLocal(st.origin, at)))) { const said = await shareThings(st.placed); log(`placed things: the map's record brought up to date${said}`); }
  } catch { /* the next walk's end shares them */ }
  askPlants(map);
  askSurfaces(map);
}
/* THE MAP'S LAYERS (the owner, 2026-11-24: "Can you have checkboxes for each type of object, and maybe just make the
   turf color light blue-green for viewing purposes. Also add a slider to control opacity of the colors."): a box for
   each kind drawn over the photo and one slider for how strong the colours are; remembered on this phone only. */
// (function declarations and st, not const or let: the map can be drawn before this part of the file has run)
function layers() {
  if (st.layers) return st.layers;
  let v = null;
  try { v = JSON.parse(localStorage.getItem('scan-layers') || 'null'); } catch { v = null; }
  st.layers = v && typeof v === 'object' ? v : {};
  return st.layers;
}
function layerOn(k) { return layers()[k] !== false; }
function layerAlpha() { const a = Number(layers().alpha); return Number.isFinite(a) ? Math.max(0.1, Math.min(1, a)) : 0.55; }
function layerControls() {
  const box = $('#layers'); if (!box || box.dataset.wired) return;
  box.dataset.wired = '1';
  const save = () => { try { localStorage.setItem('scan-layers', JSON.stringify(layers())); } catch { /* this visit only */ } };
  for (const cb of box.querySelectorAll('input[data-layer]')) {
    cb.checked = cb.dataset.layer === 'erased' ? layers().erased === true : layerOn(cb.dataset.layer);   // what was erased: hidden unless asked
    cb.addEventListener('change', () => { layers()[cb.dataset.layer] = cb.checked; save(); drawMap(); });
  }
  const sl = $('#layer-alpha');
  if (sl) { sl.value = String(Math.round(layerAlpha() * 100)); sl.addEventListener('input', () => { layers().alpha = Number(sl.value) / 100; save(); drawMap(); }); }
}
/* THE ERASER (the owner, 2026-11-24: "There's definitely some errors. Give me an eraser so I can show the parts that
   are wrong. To be clear, I'll only be able to edit based on the alignment to the photo... I can't say whether the
   errors are alignment issues or legitimate mismarked grass/soil/pavement"). A square erased is the owner saying "this
   does not match the AERIAL PHOTO", no more, and the photo may itself be off the walk ("It's not ground truth"): kept
   with its kind, beside the map on the server (src/twin.js edits), as a comparison; nothing the walk made is changed.
   Only kinds shown can be erased. */
function eraseAt(m) {
  const R = (Number($('#eraser-size')?.value) || 2) / 3.281;
  if (!st.erased) st.erased = new Map();
  const S = st.surfaces;
  if (S?.kinds) {
    const c = S.cellM || 0.3048, [oe, on] = Array.isArray(S.origin) ? toLocal(st.origin, S.origin) : [0, 0];
    const q0 = Math.floor((m[0] - R - oe) / c) - S.i0, q1 = Math.floor((m[0] + R - oe) / c) - S.i0;
    const r0 = Math.floor((m[1] - R - on) / c) - S.j0, r1 = Math.floor((m[1] + R - on) / c) - S.j0;
    const vis = { 1: layerOn('turf'), 2: layerOn('paved'), 3: layerOn('bare') };
    for (let r = Math.max(0, r0); r <= Math.min(S.h - 1, r1); r++) for (let q = Math.max(0, q0); q <= Math.min(S.w - 1, q1); q++) {
      const k = S.kinds[r * S.w + q];
      if (!k || !vis[k]) continue;
      const ce = oe + (S.i0 + q + 0.5) * c, cn = on + (S.j0 + r + 0.5) * c;
      if (Math.hypot(ce - m[0], cn - m[1]) > R) continue;
      const key = `g:${S.i0 + q},${S.j0 + r}`;
      if (!st.erased.has(key)) { st.erased.set(key, k); st.eraseStroke?.push(key); }
    }
  }
  if (st.plants?.boxes?.length && layerOn('plants')) {
    const c = st.plants.cellM || 0.3048, [oe, on] = Array.isArray(st.plants.origin) ? toLocal(st.origin, st.plants.origin) : [0, 0];
    for (const [i, j] of st.plants.boxes) {
      const ce = oe + (i + 0.5) * c, cn = on + (j + 0.5) * c;
      if (Math.hypot(ce - m[0], cn - m[1]) > R) continue;
      const key = `p:${i},${j}`;
      if (!st.erased.has(key)) { st.erased.set(key, 'plant'); st.eraseStroke?.push(key); }
    }
  }
}
function undoStroke(keys) { for (const k of keys || []) st.erased?.delete(k); }
let erasedTimer = null;
function saveErased() {
  const map = st.map; if (!map || !st.erased) return;
  const KIND = { 1: 'turf', 2: 'paving', 3: 'porous', plant: 'plant' };
  const cells = [...st.erased].map(([key, k]) => { const [layer, ij] = key.split(':'); const [i, j] = ij.split(',').map(Number); return [layer, i, j, KIND[k] || String(k)]; });
  const body = JSON.stringify({ v: 1, at: new Date().toISOString(), cellM: st.surfaces?.cellM || 0.3048, groundWalk: st.surfaces?.walk || null, plantsAt: st.plants?.at || null, erased: cells });
  const note = $('#eraser-note'); if (note) note.textContent = `${cells.length} square${cells.length === 1 ? '' : 's'} erased`;
  clearTimeout(erasedTimer);
  erasedTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/scan/edits?map=${encodeURIComponent(map)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      if (note) note.textContent = r.ok ? `${cells.length} square${cells.length === 1 ? '' : 's'} erased, kept with the map` : `NOT kept (the site answered ${r.status})`;
    } catch { if (note) note.textContent = 'NOT kept yet: no signal (it is tried again at the next erase)'; }
  }, 1200);
}
async function askErased(map) {
  st.erased = new Map(); st.eraseUndo = [];
  try {
    const r = await fetch(`/api/scan/edits?map=${encodeURIComponent(map)}`, { credentials: 'same-origin' });
    const j = r.ok ? await r.json() : null;
    if (st.map !== map || !j || j.none || !Array.isArray(j.erased)) return;
    const K = { turf: 1, paving: 2, porous: 3, plant: 'plant' };
    for (const [layer, i, j2, kind] of j.erased) st.erased.set(`${layer}:${i},${j2}`, K[kind] ?? kind);
    const note = $('#eraser-note'); if (note) note.textContent = `${st.erased.size} square${st.erased.size === 1 ? '' : 's'} erased before`;
    drawMap();
  } catch { /* none read */ }
}
function eraserControls() {
  const b = $('#eraser'); if (!b || b.dataset.wired) return;
  b.dataset.wired = '1'; st.eraseUndo = st.eraseUndo || [];
  b.addEventListener('click', () => { st.eraser = !st.eraser; b.setAttribute('aria-pressed', String(st.eraser)); b.textContent = st.eraser ? 'Eraser ON (one finger erases, two move the map)' : 'Eraser'; });
  const sz = $('#eraser-size'), ft = $('#eraser-ft');
  if (sz && ft) sz.addEventListener('input', () => { ft.textContent = `${sz.value} ft`; });
  $('#eraser-undo')?.addEventListener('click', () => { const last = st.eraseUndo.pop(); if (!last) return; undoStroke(last); saveErased(); drawMap(); });
}
/* A WALK'S GROUND ON THE MAP (scan/tools/surfaces.py, surfaces-keep.mjs): paving and grass as the walk's ground points
   were labelled by the phone, drawn under the traced lawn for the owner's eyes. Read only; nothing is written. */
async function askSurfaces(map) {
  st.surfaces = null;
  try {
    const r = await fetch(`/api/scan/surfaces?map=${encodeURIComponent(map)}`, { credentials: 'same-origin' });
    const j = r.ok ? await r.json() : null;
    if (st.map !== map || !j || j.none || !j.kinds || !(j.w > 0) || !(j.h > 0)) return;
    const raw = Uint8Array.from(atob(j.kinds), (ch) => ch.charCodeAt(0));
    const kinds = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    if (kinds.length < j.w * j.h || st.map !== map) return;
    st.surfaces = { ...j, kinds };
    let paved = 0, grass = 0, bare = 0; for (const k of kinds) { if (k === 2) paved++; else if (k === 1) grass++; else if (k === 3) bare++; }
    const sq = (n) => Math.round(n * (j.cellM / 0.3048) ** 2).toLocaleString();
    log(`a walk's ground on the map: ${sq(grass)} sq ft of turf (blue-green), ${sq(paved)} of paving (grey), ${sq(bare)} of porous ground (bare soil, woodchips, moss) in patches of 4 sq ft or more (brown, not counted as turf)`);
    drawMap();
  } catch { /* nothing drawn */ }
}
/* A WALK'S PLANTS ON THE MAP (scan/tools/plants.py; the owner, 2026-11-23: "just mark trees in general and take their
   shapes at face value"; the roadmap, 2026-11-22: the AR "offering a new 3d environment with finer details, where
   it's available"). The workflow keeps one walk's plants with the map (GET /api/scan/plants); here they are drawn on
   the placement map as green squares (how high: darker is taller), and put into the scan tool's part of the map's
   record (`plants`) when the record does not hold these yet: the walk's side of the fused model (CLAUDE.md; the
   owner, 2026-11-23: "built from both parts, but is seperate from either"). */
async function askPlants(map) {
  st.plants = null;
  try {
    const r = await fetch(`/api/scan/plants?map=${encodeURIComponent(map)}`, { credentials: 'same-origin' });
    const j = r.ok ? await r.json() : null;
    const had = st.site?.tools?.scan?.data && typeof st.site.tools.scan.data === 'object' ? st.site.tools.scan.data : {};
    if (st.map !== map) return;
    // no walk on THIS map: one made on another of the account's maps of the same lot is read from the record (the main
    // site lends it, marked borrowed, measured from that map's point); shown and fused, never written back as this map's
    if (!j || j.none || !Array.isArray(j.boxes)) {
      if (had.plants?.borrowed && Array.isArray(had.plants.boxes)) { st.plants = had.plants; drawMap(); log(`a walk's plants (${had.plants.boxes.length} boxes): from a walk on another map of this lot`); }
      return;
    }
    st.plants = j; drawMap();
    if (had.plants?.at === j.at) return;
    const data = { ...had, plants: j };
    const rr = await fetch(`/api/maps/tool?id=${encodeURIComponent(map)}&tool=scan`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, basedOn: st.site?.at || null }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    if (rr.ok && st.site) st.site.tools = { ...(st.site.tools || {}), scan: { ...(st.site.tools?.scan || {}), data } };
    log(`a walk's plants (${j.boxes.length} boxes): ${rr.ok ? 'put into the map\'s record' : `NOT put into the map's record (the site answered ${rr.status})`}`);
  } catch { /* no signal: the next opening tries again */ }
  finally { if (st.plants && st.map === map) fuseForWalk(map, st.plants).catch((e) => log(`fused model: ${e.message || e}`)); }
}
/* THE FUSED MODEL, MADE HERE WHEN THE WALK'S SIDE CHANGES (docs/MAPS.md "The fused model"; the owner, 2026-11-23:
   "built from both parts, but is seperate from either... an entirely new 3D environment, so the original data is not
   modified in the process of fusing it"; the core session in charge of it). The shade page fuses when the lidar's
   side changes; this page does when a walk's plants are new, through the SAME module (the features session's
   public/shade/fuse.js, copied in unchanged at /lib/shade/), so the fused file is there and fresh without the shade
   map having been opened: the water map and this tool read it too. What is stored says what it was made from
   (X-Model-Made-From: the lidar file's own write time, the walk's side's time, the fusing's version); when that
   already names these three, nothing is written, so the two writers never undo each other. Neither source is
   written. Not while a walk is on: it is a few seconds of the phone's work. */
async function fuseForWalk(map, plants) {
  if (st.walk || !st.origin) return;
  const [F, { loadModel }, { modelFiles }, { fuseWalk }] = await Promise.all([import('/lib/shade/fuse.js'), import('/lib/lidar-model.js'), import('/lib/shade/model-out.js'), import('/lib/fuse-walk.js')]);
  const t0 = performance.now();
  const r = await fuseWalk({ fetchFn: (u, o) => fetch(u, o), map, plants, origin: st.origin, F, loadModel, modelFiles, still: () => !st.walk && st.map === map });
  const s = r.stats || {};
  log(`fused model: ${r.made ? `made and kept in ${Math.round(performance.now() - t0)} ms${r.withOpenAir ? ', with where the walk saw open air' : ''}: ${s.refined ?? '?'} cells refined, ${s.added ?? '?'} added, ${s.trimmed ?? '?'} trimmed, ${s.moved ?? '?'} trees moved` : `not made (${r.why})`}`);
}
function drawThings(note = '') {
  const box = $('#things-list'); if (!box) return;
  const all = st.placed || [];
  box.hidden = !all.length;
  if (!all.length) return;
  const row = (t) => `<li${t.gone ? ' class="dim"' : ''}><b>${esc(t.id)}</b> ${esc(kindOf(t.kind)?.short || t.kind)}${t.pair ? ` (downspout ${esc(t.pair)})` : ''}: ${t.gone ? 'taken away' : `${esc(GRADE_WORDS[t.grade] || t.grade || '')}, sighted ${(t.seen || []).length}x`} <button type="button" class="plain" data-thing="${esc(t.id)}" data-do="${t.gone ? 'back' : 'away'}">${t.gone ? 'Put back' : 'Take away'}</button></li>`;
  box.innerHTML = `<p class="dim" style="margin:8px 0 2px">Placed on this map on earlier walks (each is on the map above by its id):</p><ul style="margin:0;padding-left:1.1rem;line-height:2.1">${all.map(row).join('')}</ul>${note ? `<p class="dim" style="margin:2px 0">${esc(note)}</p>` : ''}`;
  for (const b of box.querySelectorAll('button[data-thing]')) b.addEventListener('click', () => {
    // two taps to take one away: a slip of the thumb on a phone should not
    if (b.dataset.do === 'away' && !b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Tap again to take it away'; return; }
    changeThing(b.dataset.thing, b.dataset.do);
  });
}
async function changeThing(id, what) {
  const map = st.map; if (!map) return;
  drawThings('Saving...');
  // read again first: a walk on another phone may have added to the list since this page opened
  let old;
  try { const r = await fetch(`/api/scan/things?map=${encodeURIComponent(map)}`, { credentials: 'same-origin' }); if (!r.ok) throw new Error(`the site answered ${r.status}`); old = decodeThings(await r.text()); } catch (e) { drawThings(`Not changed: ${e.message || 'no signal'}.`); return; }
  const next = pairGutters(what === 'away' ? takeAway(old, id, 'by hand') : putBack(old, id));
  const r = await fetch(`/api/scan/things?map=${encodeURIComponent(map)}`, { method: 'PUT', credentials: 'same-origin', body: encodeThings(next), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }).catch(() => null);
  if (!r?.ok) { drawThings(`Not changed: ${r ? `the site answered ${r.status}` : 'no signal'}.`); return; }
  st.placed = next;
  const shared = await shareThings(next);
  drawThings(`${id} ${what === 'away' ? 'taken away' : 'put back'}${shared}.`); drawMap();
}

/** The pins given a kind, put into the map's things. Returns what happened, in words, or null when none was placed. */
async function keepThings(L, w) {
  const map = st.map, pins = (w?.pins || []).filter((p) => p.kind && kindOf(p.kind));
  if (!map || !L || !pins.length) return null;
  const add = [];
  const closing = closingOf(L.marks || [], w?.pins || []);
  for (const p of pins) {
    const at = mapOf(L, pinNow(p), p.odo);
    if (!at) continue;
    const g = groundUnder(L, p.at);
    /* A corner vouches for what was placed NEAR it in the walk, not 900 ft later: placed by corners more than 60 m of
       walking from the nearest corner mark, in a walk that has not shown it came back to itself, a thing is 'unsure'
       (2026-11-22: the same gutter ends pinned at a walk's start and its end landed 6-7 ft apart, both 'corners3'). */
    let grade = gradeOfFix(L, p.odo);
    const nearM = Math.min(...(L.marks || []).filter((m) => m.kind === 'ref').map((m) => Math.abs(p.odo - m.odo)), Infinity);
    if (grade.startsWith('corners') && nearM > 60 && !(closing && closing.m <= CLOSE_M)) grade = 'unsure';
    add.push({ kind: p.kind, at, h: Number.isFinite(g) ? p.at.y - g : null, walk: String(w.startedAt), grade, aimM: p.aim, t: Date.now() });
  }
  /* A WALK THAT DID NOT COME BACK TO ITSELF DOES NOT PLACE ONE THING TWICE (2026-11-23; the walk in the rain kept
     each end of one gutter as two things 6-7 ft apart): of two pins of one kind within 3 m, the later is not kept. */
  let twice = 0;
  if (closing && closing.m > CLOSE_M) for (let i = add.length - 1; i > 0; i--) if (add.slice(0, i).some((a) => a.kind === add[i].kind && Math.hypot(a.at[0] - add[i].at[0], a.at[1] - add[i].at[1]) <= 3)) { add.splice(i, 1); twice++; }
  if (!add.length) return `The ${pins.length} thing${pins.length === 1 ? '' : 's'} placed could NOT be kept: this walk has no place on the map (mark two roof corners).`;
  let old = [];
  try { const r = await fetch(`/api/scan/things?map=${encodeURIComponent(map)}`, { credentials: 'same-origin' }); if (r.ok) old = decodeThings(await r.text()); else return `The things placed were NOT kept: the site answered ${r.status}.`; } catch { return 'The things placed were NOT kept: no signal. (They are in the walk\'s own record.)'; }
  const u = addSightings(old, add);
  u.things = pairGutters(u.things);   // a gutter's outlet with its top: a downspout (things.js)
  const r = await fetch(`/api/scan/things?map=${encodeURIComponent(map)}&walk=${encodeURIComponent(String(w.startedAt))}`, { method: 'PUT', credentials: 'same-origin', body: encodeThings(u.things), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }).catch(() => null);
  if (!r?.ok) return `The things placed were NOT kept: ${r ? `the site answered ${r.status}` : 'no signal'}.`;
  const unsure = add.filter((a) => a.grade === 'unsure').length;
  const shared = await shareThings(u.things);
  st.placed = u.things; drawThings();
  return `Things kept with the map: ${u.added} new, ${u.again} sighted again${u.moved.length ? ` (${u.moved.length} moved, the most ${Math.round(Math.max(...u.moved.map((m) => m.m)) * 39.37)} in)` : ''}${unsure ? `; ${unsure} placed while the walk's own place on the map was unsure` : ''}${twice ? `; ${twice} placed a second time after the walk had slid ${ftIn(closing.m)} NOT kept` : ''}${shared}.`;
}

/* ------------------------------------------------ the map's earlier walk */
/** The map's reference walk (scan/lib/walkref.js), if it has one: read once, matched in its own worker. */
async function loadReference() {
  if (!st.map) { st.ref = null; return; }
  if (st.ref?.map === st.map && (st.ref.worker || st.ref.none)) return;
  st.ref?.worker?.terminate?.();
  const mine = st.ref = { map: st.map, worker: null, ready: null, none: false, error: null, tries: (st.refTries = (st.refTries || 0) + 1) };
  /* (2026-11-10) the walk of 2026-11-09 evening was told "no reference" though one had been kept two hours before,
     and nothing recorded why: any 404 counted as none, for the whole session. Now only the site's own "no reference"
     is none; anything else is said in the log and tried again, a few times. */
  const again = (why) => {
    mine.error = why; log(`earlier walk: ${why}${mine.tries < 6 ? '; trying again' : ''}`);
    if (mine.tries < 6) setTimeout(() => { if (st.ref === mine) { st.ref = null; loadReference(); } }, 20000);
  };
  try {
    const r = await fetch(`/api/scan/reference?map=${encodeURIComponent(st.map)}`, { credentials: 'same-origin' });
    if (r.status === 404) {
      const j = await r.json().catch(() => null);
      if (j?.error === 'no reference') { st.ref.none = true; st.refTries = 0; log('earlier walk: none kept for this map yet'); return; }
      return again('the site answered 404 without saying there is none (signed out, or a slip)');
    }
    if (!r.ok) return again(`the site answered ${r.status}`);
    const bytes = await r.arrayBuffer();
    const w = new Worker('/ref-worker.js', { type: 'module' });
    st.ref.worker = w;
    w.onmessage = ({ data }) => {
      if (data.ready) {
        pagePerf.stage('earlier walk read'); st.ref.ready = data.ready; st.refTries = 0;
        /* A NEW SET OF POINTS IS A NEW START (2026-11-10): the reference stands where the marks of ITS walk put it.
           When every point on the map was placed after it was made (the owner's "Start a new set"), this walk is
           placed by its own marks and becomes the next reference; the old one would pull it onto the old marks. */
        const pts = st.points || [];
        st.ref.stale = !st.refUse && pts.length > 0 && pts.every((q) => Number(q.id) > data.ready.at); // chosen at the start: used
        log(`earlier walk read: ${data.ready.stand} standing and ${data.ready.ground} ground points${st.ref.stale ? '; made before this set of points, so not used on this walk' : ''}`);
      }
      if (data.error) { st.ref.error = data.error; log(`earlier walk: ${data.error}`); }
      if (data.fix && st.prevAsk && data.id === st.prevAsk.id) {
        const a = st.prevAsk; st.prevAsk = null;
        st.prevStats.lastMs = data.fix.ms ?? null;
        /* TWO IN A ROW (walkref.js sameFix): a fix is used only when the one before it, made with less of the walk,
           put the phone in the same place; a first answer, or one that has moved, waits for the next to confirm it. */
        const here = st.lastTracked ? [st.lastTracked.x, -st.lastTracked.z] : [0, 0];
        const cand = data.fix.ok ? { Ts: data.fix.Ts || data.fix.T, odo: a.odo } : null;
        const confirmed = !!cand && !!st.prevCand && a.odo - st.prevCand.odo >= 5 && sameFix(st.prevCand.Ts, cand.Ts, here);
        if (cand && !confirmed) st.prevStats.lastWhy = st.prevCand ? 'the match moved since the last one: waiting for two alike' : 'a first match: waiting for the next to agree';
        st.prevCand = cand;
        if (data.fix.ok && confirmed && st.L) {
          const first = !st.L.prev?.ok;
          st.L.prev = { ok: true, T: data.fix.T, Ts: data.fix.Ts || null, tz: data.fix.tz, landed: data.fix.landed, second: data.fix.second, walkedM: a.odo, at: Date.now() };
          st.prevStats.ok++; st.prevStats.lastWhy = null;
          /* every confirmed fix, kept with the walk (2026-11-22: the walk in the rain drifted 6-7 ft and its live state
             said nothing of what the earlier walk's fit did meanwhile): how far walked, how well it landed, the fit */
          { const T = data.fix.T, r4 = (v) => +(+v).toFixed(4); (st.prevStats.fixes ||= []).push({ walkedM: +a.odo.toFixed(1), landed: data.fix.landed, T: { theta: r4(T.theta), tx: r4(T.tx), ty: r4(T.ty), s: r4(T.s ?? 1) } }); if (st.prevStats.fixes.length > 60) st.prevStats.fixes.splice(1, 1); }
          if (st.prevStats.firstOkM == null) st.prevStats.firstOkM = Math.round(a.odo);
          if (first) flash('Placed by your earlier walk');
        } else if (!data.fix.ok) st.prevStats.lastWhy = data.fix.why;
      }
    };
    w.onerror = (e) => { st.ref.error = e.message || 'the earlier walk could not be matched'; log(`earlier walk: ${st.ref.error}`); };
    w.postMessage({ ref: bytes }, [bytes]);
  } catch (e) { again(e.message); }
}

/**
 * SAVED WALK OR FRESH (the owner, 2026-11-11: "when I start the 2nd walk, I can select the saved reference walk to use
 * as the fix. Or select fresh to make a new reference walk"). Asked of the site when a map opens: is there a saved
 * walk, and from when. With one, two buttons by Start; without, the first walk is kept by itself.
 */
const refChoice = () => (st.refPick === 'fresh' ? 'fresh' : 'saved');
async function askReference() {
  const box = $('#ref-choice'); if (!box) return;
  st.refMeta = null; st.refPick = 'saved'; box.hidden = true;
  const map = st.map; if (!map) return;
  try {
    const r = await fetch(`/api/scan/reference?map=${encodeURIComponent(map)}&meta=1`, { credentials: 'same-origin' });
    if (r.ok) { const j = await r.json(); if (st.map === map) st.refMeta = j; }
  } catch { /* offline: as if none; the walk still works */ }
  /* THE MAP CAME AFTER THE WALK BEGAN (2026-11-25): that walk never chose "fresh", so the saved walk places it from
     here on, and at its end it is added to the reference. (The owner's second walk of 2026-11-24 began mapless, and at
     its end REPLACED the map's reference as though "fresh" had been chosen; the one it replaced is in the backups.) */
  if (st.lateMap && st.map === map) { st.lateMap = false; if (st.refMeta && st.twin) { st.refUse = true; loadReference(); log('earlier walk: the map came after the walk began; the saved walk is used from here'); } }
  drawRefChoice();
}
function drawRefChoice() {
  const box = $('#ref-choice'); if (!box) return;
  const M = st.refMeta;
  box.hidden = false;
  if (!M) { box.innerHTML = '<span class="dim">No walk is saved for this map: this walk, once its roof corners are marked, is saved to place the next one.</span>'; return; }
  const when = M.at ? new Date(M.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'earlier';
  /* WHICH WALK, not only when the file was written (the owner, 2026-11-23: "the ar page says 'A walk saved Nov 22,
     5:53 PM can place this one'... despite it being determined that the walk was bad": that was the walk of Nov 20,
     made into the reference afresh on Nov 22 to take the bad walk back out). A walk's id is when it started. */
  const wt = Number(M.walk), walked = Number.isFinite(wt) && wt > 1.5e12 ? new Date(wt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  box.innerHTML = `<span class="dim" style="flex-basis:100%">${walked ? `Your walk of ${esc(walked)} can place this one (kept as the reference ${esc(when)}):` : `A walk saved ${esc(when)} can place this one:`}</span><button type="button" id="ref-saved" class="${refChoice() === 'saved' ? '' : 'plain'}">Use the saved walk</button><button type="button" id="ref-fresh" class="${refChoice() === 'fresh' ? '' : 'plain'}">Fresh: this walk replaces it</button>`;
  $('#ref-saved').addEventListener('click', () => { st.refPick = 'saved'; drawRefChoice(); });
  $('#ref-fresh').addEventListener('click', () => { st.refPick = 'fresh'; drawRefChoice(); });
}

/**
 * A WALK KEPT AS ITS MAP'S REFERENCE, BY ITSELF (the owner, 2026-11-11: "make it so that a first walk now automatically
 * generates the comparison shape mesh for the 2nd walk"). At the walk's end, unless the saved walk was placing this
 * one: the walk's own marks must agree with the map (walkref.js referenceFit: two roof corners the same distance
 * apart as on the lidar within a foot, or three marks each within a foot), then its standing things and ground are
 * put on the map by them and sent to the site, which keeps the one it replaces as a backup. Tried three times.
 * Returns what happened, in words, for the walk's card.
 */
async function keepReference(L, walkId) {
  const map = st.map;
  if (!map) return null;
  if (st.recordOnly) return 'Not saved as the reference: a testing-only walk (the box on the start page).';
  /* KEEP WHAT IS GOOD, AND BUILD ON IT (lib/refkeep.js; the owner, 2026-11-15: "This will literally never work if an
     entire walk has to be pixel perfect every time. Keep what is good... Future walks should build upon that
     reference so they get better each time and uncertainty gets corrected"). The part of the walk its agreeing roof
     corners vouch for is added to the map's reference and corrects it where this walk saw the yard. A walk with no
     such corners, but placed by the reference itself, only fills in what the reference had nothing of. */
  /* EVERY WALK IS KEPT (refkeep.js keepPlan; the owner, 2026-11-16: "When I do a walk, i want it to be saved as a
     reference... Always"). The whole walk, each part of it placed by the roof corners sighted nearest it in the walk
     (a corner sighted twice keeps both marks). Corners that disagree are asked for again during the walk (locate.js);
     at its end they no longer stop it being kept. Two corners are checked before the walk starts (startWalk). */
  const plan = keepPlan(L?.marks || [], L?.jumps || []);
  /* THE SHAPE AND WHERE IT IS, APART (refkeep.js updateRef; the owner, 2026-11-16). F: this walk on the saved shape,
     by the match that placed it (when the saved reference was in use): it adds to the shape, and with the corners'
     fit C gives one more reading of where the shape is. Without F, the walk goes in already placed on the map. */
  const jumps = L?.jumps || [];
  const F = st.refUse && L?.prev?.ok && L.prev.Ts && (!plan.ok || matchUsable(plan, jumps)) ? L.prev.Ts : null;
  if (!plan.ok && !F) return `NOT saved as the reference: ${plan.why}.`;
  /* ONLY WHAT ITS CORNERS VOUCH FOR (the goal, 2026-11-22: a reference is overwritten "only... if there's a high
     degree of confidence that the new info is actually better"). A walk whose corners disagree so that none can be
     told right (refkeep.js goodPart) is not put into the reference by them: the walk of 2026-11-20 was, by a corner
     marked 20 ft from its place, and the next walk matched to it was moved 675 in. Matched to the saved shape (F) it
     may still add to the shape; its corners then say nothing of where the shape sits. */
  if (!F && !plan.g?.ok) return `NOT saved as the reference: ${plan.g?.why || 'its roof corners do not agree with the map'}. The walk itself is kept.`;
  /* AND ONLY A WALK THAT CAME BACK TO ITSELF (refkeep.js closingOf; the walk in the rain, 2026-11-22: corners agreeing
     within 7 in at its start, 6 ft 11 in out at the same corner 930 ft later, and it corrected 45,000 points of the
     reference). Where the walk gives a reading of its own closing (a plain pin on a marked corner late in the walk, or
     a corner marked again) and it is over CLOSE_M, the walk is not put into the reference. */
  const closing = closingOf(L?.marks || [], st.walk?.pins || []);
  if (closing && closing.m > CLOSE_M) return `NOT saved as the reference: the walk did not come back to itself (${ftIn(closing.m)} out at ${closing.by}, after ${Math.round(closing.walkedM * FT)} ft of walking). The walk itself is kept.`;
  const rawStand = [...(st.prevStand?.values() || [])], rawGround = [...(st.prevGround?.values() || [])];
  if (rawStand.length < REF_MIN_STAND) return `NOT saved as the reference: too little of the yard's standing things was seen (${rawStand.length} points of ${REF_MIN_STAND}).`;
  const ps = F ? null : placeWalk(rawStand, plan.use, plan.C, jumps), pg = F ? null : placeWalk(rawGround, plan.use, plan.C, jumps);
  const part = F ? { stand: rawStand, ground: rawGround } : { stand: ps.pts, ground: pg.pts };
  const unplaced = F ? 0 : ps.left + pg.left;
  if (part.stand.length < REF_MIN_STAND) return `NOT saved as the reference: the phone's tracking jumped and no roof corner was sighted after it, so only ${part.stand.length} standing points could be placed (of ${REF_MIN_STAND}). Aim at a roof corner again after the phone loses its place.`;
  const C = F ? (plan.ok && plan.g?.ok ? plan.C : null) : REF_AS_IS;
  // the map's earlier reference, to build on (none, or "Fresh" chosen at the start: this walk makes it)
  let old = null;
  // (read whenever "fresh" was not chosen: a walk whose map came late has st.refUse false and chose nothing)
  if (st.refUse || !st.refMeta || refChoice() === 'saved') { try { const r = await fetch(`/api/scan/reference?map=${encodeURIComponent(map)}`, { credentials: 'same-origin' }); if (r.ok) old = decodeRef(new Uint8Array(await r.arrayBuffer())); } catch { /* none read */ } }
  const u = updateRef(old, part, { C, F, w: plan.agree ? plan.g.n : 1, phone: plan.agree && plan.g.T?.s && plan.g.T.s !== 1 ? plan.g.T.s : null });
  if (!u.ref) return `NOT saved as the reference: ${u.why}.`;
  if (u.how === 'shape only' && !u.added) return 'The reference already has everything this walk saw: nothing to add.';
  const bytes = encodeRef(u.ref);
  const names = new Set(plan.use.map((m) => m.id)).size;
  const corners = !plan.ok ? 'no two roof corners'
    : plan.agree ? `${names} roof corners agreeing within ${(plan.g.worstM * 39.37).toFixed(0)} in${plan.g.T?.s && plan.g.T.s !== 1 ? `, this phone's distances scaled ${((plan.g.T.s - 1) * 100).toFixed(1)}% to the map's` : ''}`
      : `${names} roof corners, not all agreeing with the map; each part of the walk placed by the corners sighted nearest it`;
  const jumpNote = unplaced ? `; ${unplaced.toLocaleString()} points seen after the phone's tracking jumped, with no corners sighted after it, could not be placed` : '';
  const what = (u.how === 'made' ? `the first for this map: ${corners}`
    : u.how === 'shape and place' ? `${corners}. The yard's shape gained ${u.added.toLocaleString()} points (${u.replaced.toLocaleString()} corrected); where it sits on the map moved ${(u.movedM * 39.37).toFixed(0)} in, the middle of ${u.ref.seen.length} walks' corners`
    : u.how === 'shape only' ? `matched to the saved shape, which gained ${u.added.toLocaleString()} points; where it sits on the map is unchanged (${corners})`
    : `${corners}; placed by its corners rather than matched to the saved shape, so it filled in ${u.added.toLocaleString()} points the shape lacked`) + jumpNote;
  try {
    const r = await fetch(`/api/scan/reference?map=${encodeURIComponent(map)}&walk=${encodeURIComponent(walkId)}`, { method: 'PUT', credentials: 'same-origin', body: bytes, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    if (r.ok) return `Saved ${old ? 'into' : 'as'} this map's reference (${what}${closing ? `; the walk closed within ${ftIn(closing.m)} at ${closing.by}` : '; the walk gave no reading of its own closing: a plain pin on the first corner at the end would'}). The next walk here builds on it.`;
    // the site refused it (not the signal): say what it said
    if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && r.status !== 404 && r.status !== 408 && r.status !== 429) { let why = ''; try { why = (await r.json())?.error || ''; } catch { /* none */ } return `NOT saved as the reference: the site refused it (${r.status}${why ? `, ${why}` : ''}). Tell the core session.`; }
  } catch { /* no signal: the outbox has it */ }
  /* NO SIGNAL IS NOT A REFUSAL (the 1:48 pm walk, 2026-11-16: a good walk lost to a weak signal). The reference waits
     in the outbox with the walk's own parts, kept on the phone, and goes up when there is signal, this visit or the
     next time the page opens (sendPartNow, a part named "ref:"). */
  if (st.outbox) { try { await st.outbox.add(walkId, `ref:${map}`, 'application/octet-stream', bytes); return `Kept on the phone as this map's reference (${what}); it goes up with the walk's other parts when there is signal.`; } catch { /* the phone's store refused */ } }
  return 'NOT saved as the reference: it could not be sent and the phone could not hold it. Tell the core session.';
}

/** This walk's standing things and ground, one point to a small cube, for the earlier walk's match. */
function keepForPrev(L, pts) {
  for (const p of pts) {
    const g = groundUnder(L, p);
    if (g == null || !Number.isFinite(g)) continue;
    const h = p.y - g, u = p.x, v = -p.z;
    const which = Math.abs(h) < 0.15 ? st.prevGround : h >= REF_STAND[0] && h <= REF_STAND[1] ? st.prevStand : null;
    if (!which) continue;
    const k = `${Math.floor(u / REF_VOX)},${Math.floor(v / REF_VOX)},${Math.floor(p.y / REF_VOX)}`;
    // with how far the walk had gone when it was seen (refkeep.js partOf keeps a stretch of the walk); a cell seen
    // again keeps the later sight, so what was seen before a tracking jump gives way to what was seen after
    if (which.has(k) || which.size < PREV_MAX) which.set(k, [u, v, p.y, st.walk?.odo ?? 0]);
  }
}

/** What the earlier walk's match did, for the walk's twin (live.json). */
function prevKept() {
  if (!st.ref || st.ref.none) return st.ref?.none ? { reference: false, why: 'none kept for this map' } : null;
  if (!st.ref.ready || st.ref.stale) return { reference: !!st.ref.ready, why: st.ref.stale ? 'made before this set of points' : st.ref.error || 'still loading', ...st.prevStats, fix: null };
  const P = st.L?.prev, r = (v) => (Number.isFinite(v) ? +v.toFixed(4) : null);
  return { reference: !!st.ref.ready, ...st.prevStats, fix: P ? { T: { theta: r(P.T.theta), tx: r(P.T.tx), ty: r(P.T.ty), s: r(P.T.s ?? 1) }, tz: r(P.tz), landed: P.landed, second: P.second, walkedM: r(P.walkedM) } : null };
}

/** The depth grid of a picture just taken: key-NNNN.depth (see KEY_DEPTH), or null when there is no depth. */
function keyDepth(f, name) {
  try {
    const D = f.depth?.dense ? f.depth.dense(KEY_DEPTH.nx, KEY_DEPTH.ny) : f.depth;
    if (!D?.at || !f.pose) return null;
    const { nx, ny } = KEY_DEPTH, c = f.pose.position, a = new Uint16Array(2 + nx * ny);
    a[0] = nx; a[1] = ny;
    let n = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = D.at((i + 0.5) / nx, (j + 0.5) / ny);
      if (!p) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
      if (d > 0 && d < 65) { a[2 + j * nx + i] = Math.round(d * 1000); n++; }
    }
    return n ? { name: name.replace(/\.jpg$/, '.depth'), type: 'application/octet-stream', body: new Blob([a.buffer]) } : null;
  } catch { return null; }
}

/** THE FILLED-IN DEPTH OF A PICTURE JUST TAKEN: key-NNNN.sdepth, in key-NNNN.depth's format (2026-11-19). The .depth
 *  grid is the camera's own measured depth at the live confidence cut, and on the walks of 2026-11-18 it had a
 *  distance under only a fifth of its cells: 4,915 of one walk's 5,671 shapes had no depth under them, so they could
 *  not be matched from photo to photo or placed in 3D. ARCore also keeps a SMOOTHED depth with no holes (what hides
 *  the drawing behind real things). It is less sure, so it is kept apart and never read as measurement: a study may
 *  use it to say which shape of one photo is which shape of the next. The app only (bridge 5). */
function keySmooth(f, name) {
  try {
    const D = f.depth?.smooth ? f.depth.smooth(KEY_DEPTH.nx, KEY_DEPTH.ny) : null;
    if (!D?.at || !f.pose) return null;
    const { nx, ny } = KEY_DEPTH, c = f.pose.position, a = new Uint16Array(2 + nx * ny);
    a[0] = nx; a[1] = ny;
    let n = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = D.at((i + 0.5) / nx, (j + 0.5) / ny);
      if (!p) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
      if (d > 0 && d < 65) { a[2 + j * nx + i] = Math.round(d * 1000); n++; }
    }
    return n ? { name: name.replace(/\.jpg$/, '.sdepth'), type: 'application/octet-stream', body: new Blob([a.buffer]) } : null;
  } catch { return null; }
}

/** THE RAW DEPTH OF A PICTURE WITH NOTHING THROWN AWAY: key-NNNN.rdepth (the owner, 2026-11-20: "Every photo is
 *  supposed to have depth. That's why we switched to the raw depth API"). key-NNNN.depth is the raw depth too, but
 *  at the live confidence cut and to 30 m, and that left a distance under a fifth of its cells. This keeps every
 *  cell the camera gave, to 65 m, with how sure it was: Uint16 [nx, ny, nx*ny distances in mm (0 none), nx*ny
 *  confidences x 255]. A study chooses its cut afterwards. */
function keyRaw(f, name) {
  try {
    const D = f.depth?.rawAll ? f.depth.rawAll(KEY_DEPTH.nx, KEY_DEPTH.ny) : null;
    if (!D?.at || !f.pose) return null;
    const { nx, ny } = KEY_DEPTH, c = f.pose.position, a = new Uint16Array(2 + 2 * nx * ny);
    a[0] = nx; a[1] = ny;
    let n = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) / nx, y = (j + 0.5) / ny, p = D.at(x, y);
      if (!p) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
      if (d > 0 && d < 65) { a[2 + j * nx + i] = Math.round(d * 1000); a[2 + nx * ny + j * nx + i] = Math.round(255 * (D.conf(x, y) ?? 0)); n++; }
    }
    const out = n ? { name: name.replace(/\.jpg$/, '.rdepth'), type: 'application/octet-stream', body: new Blob([a.buffer]) } : null;
    const sem = keySem(D, name, nx, ny);
    return out ? Object.assign(out, { sem }) : sem ? { name: sem.name, type: sem.type, body: sem.body } : null;
  } catch { return null; }
}

/** THE PHONE'S OWN LABELS OVER THE WHOLE PICTURE: key-NNNN.sem (core session, 2026-11-24). The owner: "The arcore
 *  scene semantics has a label for sky... it largely avoids marking trees as sky when it does it's own segmentation".
 *  The walk kept the labels only on depth points, and the sky has no depth, so a picture's sky was never kept (3 of a
 *  walk's points). The label of every cell of the grid kept with each picture, sky included, in the picture's own
 *  frame: Uint8 [nx lo, nx hi, ny lo, ny hi, nx*ny labels (ARCore's numbers 0 unlabeled, 1 sky, 2 building, 3 tree,
 *  ...; 255 none), nx*ny confidences x 255], rows from the top. Read by scan/tools/crown_sky_study.py: where the
 *  pictures say sky against where the lidar says crown, the owner's idea for what the depth cannot reach. */
function keySem(D, name, nx, ny) {
  try {
    if (!D?.label) return null;
    const a = new Uint8Array(4 + 2 * nx * ny);
    a[0] = nx & 255; a[1] = nx >> 8; a[2] = ny & 255; a[3] = ny >> 8;
    let n = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) / nx, y = (j + 0.5) / ny, l = D.label(x, y), k = SEM_LABELS.indexOf(l);
      a[4 + j * nx + i] = k >= 0 ? k : 255;
      a[4 + nx * ny + j * nx + i] = Math.round(255 * (D.labelConf ? D.labelConf(x, y) ?? 0 : 0));
      if (k >= 0) n++;
    }
    return n ? { name: name.replace(/\.jpg$/, '.sem'), type: 'application/octet-stream', body: new Blob([a.buffer]) } : null;
  } catch { return null; }
}

function sendTwin(parts) {
  const walk = st.twin?.walk || st.twinUp?.walk;
  if (!walk || !parts?.length) return;
  if (st.twinUp) st.twinUp.walk = walk;
  if (!st.outbox) { setTimeout(() => sendTwin(parts), 500); return; }
  (st.wperf || st.upPerf?.perf)?.uploadOpen();
  for (const p of parts) st.outbox.add(walk, p.name, p.type, p.body).catch(() => {});
}

/** EVERYTHING STILL ON ITS WAY TO THE SITE, IN ONE PLACE (the owner, 2026-11-15: "The upload stuff is very unclear
    and fragmented... The top of the page shows an upload status that apparently isn't actually the upload? The actual
    upload progress is extremely hard to find"). Three things leave the phone after a walk, each by its own sender: the
    walk's points and pictures (the page's outbox), the replay recording (the app, a video of the whole walk: by far
    the biggest) and, in the dev build, the thermal camera's file. The top line said only the first. Now one box at
    the top lists all three with what is left of each, and says in one line whether anything is left at all. */
function renderUploads() {
  const el = $('#uploads');
  if (!el) return;
  const mb = (b) => (b >= 1e7 ? `${Math.round(b / 1e6)} MB` : b >= 1e5 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const rows = [];
  let left = 0, trouble = false;
  // 1. the walk's points, track and pictures
  const u = uploadsNow();
  if (u) {
    if (u.off) { rows.push(['Walk data (points, pictures)', `off: ${u.off}; ${u.pending} parts kept on this phone`]); trouble = true; }
    else if (u.pending) { left += u.bytes || 0; rows.push(['Walk data (points, pictures)', `${mb(u.bytes || 0)} left in ${u.pending} part${u.pending === 1 ? '' : 's'}${u.sending ? ', sending' : `, waiting to try again${u.lastError ? ` (${u.lastError})` : ''}`}`]); if (!u.sending) trouble = true; }
    else rows.push(['Walk data (points, pictures)', `all sent${u.sent ? ` (${mb(u.sentBytes || 0)} this visit)` : ''}${u.dropped ? `; ${u.dropped} refused by the site` : ''}`]);
  }
  // 2. the replay recordings (the app sends them; a video of the walk, about 100-300 MB)
  const N = window.LawnARNative;
  if (N && typeof N.pendingRecordings === 'function') {
    let pend = [];
    try { pend = JSON.parse(N.pendingRecordings()) || []; } catch { pend = []; }
    const live = st.recUp && !st.recUp.done ? st.recUp : null;
    let total = 0, sent = 0;
    for (const r of pend) { total += r.bytes || 0; sent += live && String(live.walk) === String(r.walk) ? live.sent || 0 : r.sent || 0; }
    if (pend.length) { left += Math.max(0, total - sent); rows.push([`Replay recording${pend.length === 1 ? '' : 's'} (video of the walk)`, `${mb(sent)} of ${mb(total)} sent${pend.length > 1 ? `, ${pend.length} recordings` : ''}${live?.error ? `; stopped (${String(live.error).slice(0, 50)}), tried again when the app opens` : ''}`]); if (live?.error) trouble = true; }
    else rows.push(['Replay recordings (video of the walk)', 'all sent']);
  }
  // 3. dev only: the thermal camera's file
  if (window.LawnARThermal) {
    let t = null;
    try { t = JSON.parse(window.LawnARThermal.status())?.upload || null; } catch { t = null; }
    if (t) {
      if (t.waiting) { const s2 = t.sending; left += s2 ? Math.max(0, (t.bytes || 0) - (s2.sent || 0)) : t.bytes || 0; rows.push(['Thermal camera file', `${s2 ? `${mb(s2.sent || 0)} of ${mb(s2.total || 0)} sent` : `${mb(t.bytes || 0)} waiting`}${t.error ? `; stopped (${String(t.error).slice(0, 50)})` : ''}`]); if (t.error) trouble = true; }
      else rows.push(['Thermal camera file', 'all sent']);
    }
  }
  if (!rows.length) { el.textContent = ''; el.className = 'dim'; return; }
  el.className = left ? 'uploads busy' : 'uploads';
  const away = u?.byApp ? 'It carries on with the app in the background or the screen off (a notification shows it)' : 'Keep the app open';
  const head = left ? `Uploading: ${mb(left)} still to send. ${away}${trouble ? ' (something is waiting to try again)' : ''}.` : 'Uploads: everything is on the site.';
  el.innerHTML = `<strong>${esc(head)}</strong>${rows.map(([k, v]) => `<br><span>${esc(k)}:</span> ${esc(v)}`).join('')}`;
  // while walking, the HUD's own line (app.js hud) says the walk data only; this box is the page's
}
setInterval(() => { try { renderUploads(); } catch { /* next time */ } }, 2000);

/** A walk to the site's own database (scan/src/walks.js); failing that it stays on this phone. */
async function post(s) {
  let saved = false, why = '';
  try {
    const res = await fetch('/api/scan/walks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    saved = res.ok;
    if (!res.ok) why = (await res.json().catch(() => ({})))?.error || `${res.status}`;
  } catch (e) { why = e.message; }
  const all = kept(), mine = all.find((x) => x.id === s.id);
  if (mine) { mine.saved = saved; mine.savedWhy = saved ? null : why; keep(all); }
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
    keep(all); renderResults(id); post(s);
  }));
}

function walkCard(s, open) {
  const pc = (v) => `${(Math.abs(v) * 100).toFixed(1)}% ${v > 0 ? 'short' : 'long'}`;
  const pins = s.pins.map((p) => `<tr><td>${esc(p.name)}${p.anchored ? '*' : ''}<br><span class="dim">${p.type === 'DEPTH' ? 'depth' : 'plane'}${p.planeOffYM != null ? `; plane ${ftIn(Math.abs(p.planeOffYM))} ${p.planeOffYM > 0 ? 'above' : 'below'}` : ''}</span></td><td>${p.aimM != null ? ftIn(p.aimM) : '?'}</td><td>${p.checks.length ? p.checks.map((c) => `<strong>${ftIn(c.offLevelM)}</strong>${c.offAnchorLevelM != null ? ` / <strong>${ftIn(c.offAnchorLevelM)}</strong>*` : ''} after ${ftIn(c.walkedSinceM)}`).join('<br>') : '<span class="dim">not checked</span>'}</td></tr>`).join('');
  const measures = s.measures.map((m, i) => `<tr><td>${ftIn(m.metres)} <span class="dim">(${m.metres} m)</span></td><td>tape <input type="number" step="0.1" min="0" inputmode="decimal" data-tape="${esc(s.id)}:${i}" value="${m.tapedM ? (m.tapedM * FT).toFixed(1) : ''}" aria-label="What the tape said, feet"> ft</td><td>${m.shortBy != null ? `<strong>${pc(m.shortBy)}</strong>` : ''}</td></tr>`).join('');
  const checks = (s.checks || []).map((c) => `<tr><td>${esc(c.name)}</td><td><strong>${ftIn(c.errorM)}</strong> off</td><td class="dim">${c.by === 'fix' ? `lidar fix, ${ftIn(c.walkedSinceFixM || 0)} of walk before` : 'references'}${c.errorRefsM != null && c.by === 'fix' ? `; by the references alone ${ftIn(c.errorRefsM)}` : ''}; aimed from ${c.aimM != null ? ftIn(c.aimM) : '?'}</td></tr>`).join('');
  const near = (s.pinsNear || []).filter((p) => p.nearest).map((p) => `${esc(p.name)} is ${ftIn(p.nearest.m)} from ${esc(p.nearest.name)}${p.nearest.byRefsM != null ? ` (${ftIn(p.nearest.byRefsM)} by the references alone)` : ''}`).join('; ');
  const refs = (s.references || []).filter((r) => r.marks).map((r) => `${esc(r.name)} marked ${r.marks === 1 ? 'once' : `${r.marks} times`}${r.leftOutM != null ? ` (<strong>${ftIn(r.leftOutM)}</strong> off when the others line it up)` : ''}`).join('; ');
  const fx = s.fix;
  const x = s.stats;
  return `<details class="card"${open ? ' open' : ''}><summary><strong>${esc(NAME[s.engine] || s.engine)}</strong> · ${new Date(s.when).toLocaleString()} · ${Math.round(s.seconds / 60)} min${s.failed ? ' · <span class="warn">did not start</span>' : ''}</summary>
    ${s.failed ? `<p class="warn">${esc(s.failed)}</p>` : ''}
    <p class="dim">${s.saved === true ? 'Saved to the site.' : s.saved === false ? `On this phone only (not saved: ${esc(s.savedWhy || '?')}).` : 'Saving…'}</p>
    <p>Walked ${Math.round(x.walkedM * FT)} ft; lost its place ${x.losses} time${x.losses === 1 ? '' : 's'}; ${x.resets} jump${x.resets === 1 ? '' : 's'}; ${x.fastTurns} fast turn${x.fastTurns === 1 ? '' : 's'}; tracked ${x.trackedShare != null ? Math.round(x.trackedShare * 100) : '?'}% of frames${s.points?.maxAtOnce ? `; up to ${s.points.maxAtOnce} points seen at once` : ''}.</p>
    ${fx ? `<p><strong>Where you were:</strong> ${fx.fixes} lidar fix${fx.fixes === 1 ? '' : 'es'} from ${fx.asks} tries${fx.fixes ? ` (${Math.round(100 * fx.fixHits.reduce((a, b) => a + b, 0) / fx.fixHits.length)}% of points landed on average)` : ''}; ${fx.references} reference${fx.references === 1 ? '' : 's'}, ${fx.marks} marks. ${Object.keys(fx.refused || {}).length ? `Refused: ${esc(Object.entries(fx.refused).map(([k, v]) => `${k} (${v})`).join('; '))}.` : ''}${s.lidar?.error ? ` <span class="warn">Lidar: ${esc(s.lidar.error)}</span>` : s.lidar ? ` Lidar: ${s.lidar.points.toLocaleString()} points, ${s.lidar.solid.toLocaleString()} solid cells.` : ''}</p>` : ''}
    ${s.twin ? `<p>Twin: ${s.twin.points.toLocaleString()} points, ${s.twin.keys} picture${s.twin.keys === 1 ? '' : 's'}${s.twin.off ? ` <span class="warn">not kept: ${esc(s.twin.off)}</span>` : s.twin.failed ? ` <span class="warn">(${s.twin.failed} part${s.twin.failed === 1 ? '' : 's'} did not upload)</span>` : ''}. <a href="/twin.html?walk=${encodeURIComponent(s.id)}">See how it lines up</a> &middot; <a href="/inspect.html?walk=${encodeURIComponent(s.id)}">Inspect it</a></p>` : ''}
    ${s.app?.recording || st.recUp ? `<p class="dim" id="rec-up">${esc(recUpText() || 'Recording: being finished, then sent.')}</p>` : ''}${s.replayOf ? `<p class="dim">A replay of the walk of ${esc(new Date(+s.replayOf).toLocaleString())}.</p>` : ''}
    ${refs ? `<p class="dim">References: ${refs}.</p>` : ''}
    ${s.perf ? `<details><summary class="dim">Speed (what the phone measured)</summary>${perfLines(s.perf).map((l) => `<p class="dim">${esc(l.replace(/^speed, /, ''))}</p>`).join('')}</details>` : ''}
    ${s.reference ? `<p class="${/^NOT/.test(s.reference) ? 'warn' : 'ok'}">${esc(s.reference)}</p>` : ''}
    ${(s.roofSights || []).length ? `<p class="dim">Roof corners: ${s.roofSights.map((r) => `${esc(r.name)} ${r.ok ? `marked from ${r.sights} aims ${r.turnDeg}&deg; apart (lines ${Math.round((r.missM || 0) * 39.37)} in apart, ${Math.abs(r.eaveOffM || 0).toFixed(1)} m off the lidar's eave)` : `not marked: ${esc(r.why || '')}`}`).join('; ')}.</p>` : ''}
    ${near ? `<p class="dim">Pins on the map: ${near}.</p>` : ''}
    ${checks ? `<table><tr><th>Check point</th><th>On the map</th><th>By</th></tr>${checks}</table>` : ''}
    ${pins ? `<table style="margin-top:8px"><tr><th>Pin</th><th>Aimed from</th><th>Off its spot when checked (as placed / *anchored)</th></tr>${pins}</table>` : '<p class="dim">No pins.</p>'}
    ${measures ? `<table style="margin-top:8px"><tr><th>Measured</th><th>Tape</th><th>Error</th></tr>${measures}</table>` : ''}
    ${s.errors?.length ? `<details><summary class="dim">Messages (${s.errors.length})</summary><pre>${esc(s.errors.join('\n'))}</pre></details>` : ''}
    <div class="tools"><button type="button" data-copy="${esc(s.id)}">Copy results</button><button type="button" class="plain" data-forget="${esc(s.id)}">Forget this walk</button></div>
  </details>`;
}

wire(); wireMap(); wirePhotoTools();
// for a browser test without a phone (?debug=1): the mini map's pieces, nothing else
if (new URLSearchParams(location.search).get('debug') === '1') window.__scan = { st, mini, drawMini, arrows };
main().catch((e) => { $('#status').textContent = `This page could not start: ${e.message}`; });
// DEV ONLY: the USB thermal camera, when the app is the dev build (public/thermal.js; the store build offers no such thing)
if (window.LawnARThermal) import('/thermal.js').catch((e) => log(`thermal: ${e.message}`));
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) setTimeout(() => { if (st.has8w) load8thWall(ENGINE_URL).catch(() => {}); }, 1500);
