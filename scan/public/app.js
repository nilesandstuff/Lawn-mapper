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
import { detect, start, engineChoice, load8thWall } from '/lib/track.js';
import { newWalk, step, dropPin, checkPin, measure, tapeFor, undo, far, summary, pinNow } from '/lib/walk.js';
import { makeDrawer, lidarMeshes, OCC_RANGE, OCC_RANGE_FULL } from '/lib/draw.js';
import { lookMeshes } from '/lib/look.js';
import { snapTo } from '/lib/lidar-marks.js';
import { levelDist, toLocal, fromLocal } from '/lib/frames.js';
import { frameFor, bboxOf, toPx, fromPx, ringsOf, toMerc } from '/lib/photo.js';
import { newLocate, mark, noteGround, addDepth, nextAsk, answer, fitFor, mapOf, sessionOf, checkError, nearestNamed, agreement, groundOffset, groundUnder, status as fixStatus, summaryOf } from '/lib/locate.js';
import { STAND as REF_STAND, MIN_STAND as REF_MIN_STAND, VOX as REF_VOX, referenceFit, buildRef, encodeRef } from '/lib/walkref.js';
import { leftOut, mapToSession } from '/lib/align.js';
import { newTwin, addPoints, addPose, wantKey, addKey, flush, flushDue, liveOf } from '/lib/twin.js';
import { newAnchors, viewOf, noteView, nudge, pitchOf, anchorsKept, SHOW_S } from '/lib/anchors.js';
import { surfaceOf } from '/lib/surface.js';
import { geoReading } from '/lib/geo.js';
import { spikesIn } from '/lib/spikes.js';
import { walkPrior } from '/lib/walkfix.js';
import { keepPoint, viewFromSem, newSemCount, noteSem, semSummary, newCrumbs, crumbDue, addCrumb, crumbMoves } from '/lib/semantics.js';
import { newOutbox, idbStore, memoryStore, statusText } from '/lib/outbox.js';
import { byDistance, nearestMap, mapLabel } from '/lib/maps-pick.js';
import { enhance } from '/lib/enhance.js';
import { newSight, sight } from '/lib/roof-corner.js';
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
const COLOR = { dot: [0.3, 1, 0.6, 0.9], dotPlane: [1, 0.8, 0.2, 0.9], pin: [0.9, 0.22, 0.2, 0.95], placed: [0.9, 0.22, 0.2, 0.45], mark: [0.35, 0.6, 1, 0.95], ref: [0.25, 0.5, 1, 0.9], check: [0.75, 0.3, 0.9, 0.9] };
const CSS = { ref: '#2f7cf6', check: '#a54bd8', pin: '#e53935', lawn: '#4cc38a' };
/* THE LIVE LIDAR FIX IS SET ASIDE (the owner, 2026-11-09: "let's go back to just placing references manually and set
   aside everything about getting a live fix from lidar and finding the best fit after a walk... it looks like automatic
   lidar alignment is just too difficult to make work"; SCAN-H28-H31). The walk is placed by its reference marks; the
   lidar is still read and drawn. ?lidarfix=1 turns the old live fix back on, for a test. */
const LIDAR_LIVE = (() => { try { return new URLSearchParams(location.search).get('lidarfix') === '1'; } catch { return false; } })();
const FAR_AGAIN = 3000;
const DEPTH_EVERY = 250;
const LIVE_RANGE = 30; // m: the live match and the walk's ground take depth this near, as far as the twin keeps it (track.js; 8 until 2026-11-08)
const WALK_EVERY = 10000; // ms between placements of the whole walk (walkfix.js)
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
  lidarOn: true, agree: null,
};
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
  /* RECORD FIRST, FIX AFTERWARDS (owner, 2026-11-05): no live lidar fix on this walk; it is recorded (points, track,
     pictures, marks, pins) and placed afterwards on a GitHub runner (workflow "S. Yard AR tool", task fix). The
     references still line the camera view up meanwhile. */
  if (pick.offered.length) {
    const lab = document.createElement('label'); lab.className = 'dim'; lab.style.display = 'block'; lab.style.margin = '8px 0';
    lab.innerHTML = '<input type="checkbox" id="record-only"> Record only: no live lidar fix; the walk is fixed afterwards';
    box.append(lab);
    $('#record-only').addEventListener('change', (e) => { st.recordOnly = e.target.checked; });
    /* RECORDING AND REPLAY (the app's bridge 3; the owner, 2026-11-08: "so I don't have to keep doing the same walks
       over and over"): ARCore records the walk's camera and motion; it goes to the site after the walk, and any
       recorded walk can be run again through ARCore and this page from the couch. */
    if ((st.caps.native?.bridge ?? 0) >= 3) {
      const rec = document.createElement('label'); rec.className = 'dim'; rec.style.display = 'block'; rec.style.margin = '8px 0';
      rec.innerHTML = '<input type="checkbox" id="record-arcore" checked> Record this walk for replay (ARCore\'s camera and motion; sent to the site after the walk, about 100-300 MB, best on wifi)';
      box.append(rec);
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
  if (st.map) { await loadMap(st.map).catch((e) => { $('#mapnote').textContent = `The map could not be opened (${e.message}): tracking only, no references or lidar.`; }); changeButton(); }
  else await pickMap().catch(() => { $('#mapnote').textContent = 'No map: open this page from the dashboard to use references and the lidar. Tracking still works.'; });
}

/* WHICH MAP (scan/lib/maps-pick.js; owner, 2026-11-07): the app cannot be handed a map by the dashboard (that opens
   in the browser), so the page picks one itself: the nearest saved map within reach of the phone's place opens by
   itself, otherwise a list, nearest first; Change map lists them again. */
async function pickMap({ auto = true } = {}) {
  const note = $('#mapnote');
  note.textContent = 'Finding your maps…';
  let maps = [];
  try { maps = (await (await fetch('/api/maps', { credentials: 'same-origin' })).json())?.maps || []; } catch { maps = []; }
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

async function openMap(id, how) {
  st.map = id;
  try { const u = new URL(location.href); u.searchParams.set('map', id); history.replaceState(null, '', u); } catch { /* the address bar can wait */ }
  const back = $('#back');
  if (back) back.href = `${(back.getAttribute('href') || '').split('?')[0]}?map=${encodeURIComponent(id)}`;
  try { await loadMap(id); $('#mapnote').textContent += ` Opened ${how}.`; } catch (e) { $('#mapnote').textContent = `The map could not be opened (${e.message}).`; }
  changeButton();
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
  $('#setup').hidden = false;
  // which map: the owner has more than one of the same house (2026-11-09), so its date and size say which
  const saved = m.at ? new Date(m.at) : null;
  $('#mapnote').textContent = `Map opened (${[saved && !Number.isNaN(+saved) ? `saved ${saved.toLocaleDateString()}` : '', m.squareFeet ? `${Math.round(m.squareFeet).toLocaleString()} sq ft of lawn` : ''].filter(Boolean).join(', ') || 'no lawn traced yet'}).`;
  drawMap();
  startLidar(m);
  askReference();
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
const savePoints = () => { try { localStorage.setItem(KEYP(), JSON.stringify(st.points)); } catch { /* this phone only */ } };
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
  if (rn) { const R = st.lid?.roofs; rn.hidden = !R; if (R) rn.textContent = R.length ? `Roof corners (white diamonds): ${R.length} offered. Tap one to make it a reference; in the walk you aim up at that corner from two places and it marks itself. Two to four, on different sides of the house, are enough.${R.some((c) => c.tier === 2) ? ` Fewer than three met the first rule (15 ft up, 15 ft from the lawn), so ${R.filter((c) => c.tier === 2).length} more are offered up to 18 ft up and 30 ft from the lawn.` : ''}` : 'No roof corner is offered on this map: none has two long straight roof edges, under 18 ft up and within 30 ft of the lawn.'; }
  againTools();
  if (st.againMode) {
    const t = againTodo();
    el.innerHTML = st.points.map((p) => `<li><span style="color:${p.kind === 'ref' ? CSS.ref : CSS.check};font-weight:600">${esc(p.name)}</span> ${p.again ? 'placed again' : p === t ? '<strong>tap its spot now</strong>' : 'to do'}</li>`).join('');
    return;
  }
  el.innerHTML = st.points.map((p) => `<li><span style="color:${p.kind === 'ref' ? CSS.ref : CSS.check};font-weight:600">${esc(p.name)}</span> ${p.roof ? `reference · the roof's ${esc(p.roof.label)}, ${Math.round(p.roof.eaveM * 3.281)} ft up (aim up at it in the walk, from two places)` : p.kind === 'ref' ? 'reference' : 'check point'}${p.on === 'lidar' ? (p.snap ? (p.snap.kind === 'middle' ? ' · on a small thing\'s middle' : p.snap.sure ? ' · on a sure corner' : ' · on a less sure corner') : ' · on the lidar, not on a corner') : ''}</li>`).join('') || '<li class="dim">None yet. Tap the photo.</li>';
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
    if (downAt && !moved && Math.hypot(xy[0] - downAt[0], xy[1] - downAt[1]) > SLIDE * cssK()) {
      moved = true;
      // slid before the hold was up: the finger meant the map, not the point
      if (drag && performance.now() - downT < HOLD_MS) { delete drag.grab; drag = null; }
    }
    if (drag && moved) { const b = toBase(xy), gr = drag.grab || [0, 0]; drag.map = unpx([b[0] + gr[0], b[1] + gr[1]]); st.dragging = drag; st.dragLoupeLeft = xy[0] > cv.width / 2; drawMap(); } else if (pan && moved) { st.view.ox = pan.ox + xy[0] - pan.x; st.view.oy = pan.oy + xy[1] - pan.y; clampView(); drawMap(); }
  });
  const up = (ev, cancelled) => {
    ptrs.delete(ev.pointerId);
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
      st.points.push({ id: `${Date.now()}`, kind: 'ref', name: nextName('ref'), map: rc.at.slice(), roof: { eaveM: rc.eaveM, label: rc.label, sure: rc.sure, within: rc.within } });
      flash(`${st.points[st.points.length - 1].name}: the roof's ${rc.label}, ${Math.round(rc.eaveM * 3.281)} ft up`);
      savePoints(); listPoints(); drawMap(); return;
    }
    const sp = snapped(unpx(b));
    st.points.push({ id: `${Date.now()}`, kind: st.adding, name: nextName(st.adding), map: sp.at, on: st.photoChoice || undefined, snap: sp.snap || undefined });
    if (st.photoChoice === 'lidar') flash(`${st.points[st.points.length - 1].name} ${snapWord(sp.snap)}`);
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
    st.lid.worker = w;
    const pts = [...st.lawn.flat(), ...st.parcel.flat()], es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
    const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
    w.onmessage = ({ data }) => {
      if (data.progress) { st.lid.progress = data.progress; showLidar(); }
      if (data.ready) { st.lid.ready = data.ready; log(`lidar model read: ${data.ready.points} columns, ${data.ready.solid} solid cells, shift ${data.ready.shift}`); showLidar(); keepShadeFresh(m, data.ready); }
      if (data.roofs) { st.lid.roofs = data.roofs; log(`roof corners offered: ${data.roofs.length}`); drawMap(); listPoints(); }
      if (data.ground) { st.lid.ground = data.ground; groundPhoto().catch((e) => log(`lidar ground picture: ${e.message}`)); }
      if (data.marks && st.lid.overlay?.picture) { st.lid.overlay.picture.marks = data.marks; if (st.photoChoice === 'lidar') { photoTools(); drawMap(); } }
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
    w.postMessage({ load: { origin: st.origin, box, map: st.map, lawn: st.lawn } });
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
    st.lid = { ...st.lid, worker: null, ready: null, error: null, progress: 'Reading the updated lidar…', overlay: null, meshes: null, ground: null, roofs: null };
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
}

/* --------------------------------------------------------------- the AR */

function flash(text) { const f = $('#flash'); f.textContent = text; f.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => f.classList.remove('show'), 2400); }
const log = (what) => { st.errors.push({ t: Date.now(), what }); if (st.errors.length > 80) st.errors.shift(); };

async function startAR(engine) {
  const overlay = $('#overlay');
  st.walk = newWalk({ engine, phone: navigator.userAgent });
  st.dy = null; st.dyFrom = null; st.gpsTrail = []; st.anchors = newAnchors(); st.nudge = null; st.depthFill = null; st.geoTrail = []; st.geoSeen = null; st.sem = newSemCount(); st.lastSem = null; st.semDims = null; st.occ = null; st.occFull = 0; st.occAt = 0; st.walkGround = new Map(); st.spikes = { pictures: 0, cells: 0, flagged: 0 }; st.walkAsk = null; st.walkAt = 0; st.walkStats = { asks: 0, ok: 0, lastWhy: null, firstOkM: null }; st.crumbs = newCrumbs();
  st.walk.checks = [];
  st.L = newLocate();
  st.prevStand = new Map(); st.prevGround = new Map(); st.prevAsk = null; st.prevAt = 0; st.prevStats = { asks: 0, ok: 0, lastWhy: null, firstOkM: null, lastMs: null };
  // the owner's choice at the start (2026-11-11): the saved walk places this one, or this one is a fresh reference
  st.refUse = st.refMeta && refChoice() === 'saved';
  if (st.refUse) loadReference(); else { st.ref?.worker?.terminate?.(); st.ref = st.map ? { map: st.map, worker: null, ready: null, none: true, error: null, fresh: !!st.refMeta } : null; log(st.refMeta ? 'earlier walk: not used (fresh chosen); this walk is kept as the new one' : 'earlier walk: none kept for this map; this walk is kept as it'); }
  mini.view = null; mini.mode = 'fit'; mini.locked = false; $('#arrows').innerHTML = '';
  st.surfCount = { grass: 0, pave: 0 };
  st.chosen = null; st.undoMarks = [];
  // the walk's twin (scan/lib/twin.js): its points, track and pictures go up to the site as it goes (src/twin.js)
  st.twin = newTwin({ walk: `${st.walk.startedAt}`, map: st.map || null, engine, started: st.walk.startedAt });
  st.twinUp = { queue: [], busy: false, off: null, sent: 0, failed: 0 };
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
      nativeOptions: (st.replayOf ? st.replayImage === '1920x1080' : st.fullRes) ? { cameraImage: 'largest', grabW: st.replayOf && st.replaySmall ? 480 : 1080 } : {} });
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
  if (st.chosen) { const c = st.points.find((p) => p.id === st.chosen); if (c) return c; st.chosen = null; }
  const markedIds = new Set(st.L.marks.map((m) => m.id));
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
  if (st.sight) { try { stepSight(f); } catch (e) { log(`roof sighting: ${e.message}`); st.sight = null; } }
  if (!st.walk) return;
  st.ar = f;
  if (f.events) replayActs(f); // a replay: what was done at this frame of the recorded walk
  const w = st.walk, L = st.L, odo = w.odo;
  const warnings = step(w, { t: f.t, pos: f.pose?.position, quat: f.pose?.quaternion, tracking: f.tracking, reset: f.reset, points: f.points });
  for (const x of warnings) {
    if (x === 'lost') flash('Lost its place: look around slowly');
    if (x === 'reset') flash('The tracking jumped: mark a reference again');
    if (x === 'fast') flash('Turn slower');
  }
  // the ground near the phone: the crosshair's depth when it is on the ground (0.8-2.5 m below the camera)
  if ((f.hit?.type === 'DEPTH' || /SURFACE$/.test(f.hit?.type || '')) && f.pose) { const drop = f.pose.position.y - f.hit.position.y; if (drop > 0.8 && drop < 2.5) noteGround(L, f.hit.position.y); }
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
    if (st.twin) addPoints(st.twin, Date.now(), odo, pts, L.groundY);
    /* GEOSPATIAL DEPTH (bridge 3, where Google has VPS): ARCore's smoothed depth carried to 65 m by Streetscape
       Geometry, kept in the twin past where the camera's own depth reaches (25 m), flagged, and not matched live:
       it is Google's buildings and terrain placed by the Geospatial pose, not something the camera measured */
    if (st.twin && f.depth.geoDepth && st.started?.streetscape) {
      const gd = f.depth.geoDepth(), far = [];
      if (gd) for (let j = 0; j < 28; j++) for (let i = 0; i < 16; i++) {
        const p = gd.at((i + 0.5) / 16, (j + 0.5) / 28);
        if (p && Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z) > 25) { p.geoDepth = true; far.push(p); }
      }
      if (far.length) { st.geoDepthN = (st.geoDepthN || 0) + far.length; addPoints(st.twin, Date.now(), odo, far, L.groundY); }
    }
  }
  // 8th Wall: no depth map, but its world points, at the same pace (scan/lib/track.js worldPointsOf); no camera
  // picture to colour them, so they go in as standing candidates too, each still needing two sightings
  if (!f.depth && f.world && f.pose && f.t - st.depthAt > DEPTH_EVERY) {
    st.depthAt = f.t;
    addDepth(L, f.world, odo, f.pose.position);
    if (st.twin) addPoints(st.twin, Date.now(), odo, f.world, L.groundY);
  }
  // THE GROUND'S COLOUR (scan/lib/surface.js): about once a second, the camera's picture read back, and the depth
  // under a grid of it labelled grass or paving, for the lawn-edge term of the match. The same read serves the twin.
  let grabbed = null;
  if (f.grab && f.pose && f.tracking === 'normal' && f.t - (st.colourAt || 0) > COLOUR_EVERY) {
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
      if (n) { st.nudge = { ...n, until: now + SHOW_S }; flash(n.text); }
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
  // the twin: the camera's track, a picture now and then, and what has piled up sent every 15 s
  if (st.twin && f.pose) {
    const now = Date.now();
    addPose(st.twin, now, odo, f.pose.position, f.pose.quaternion, f.tracking);
    if (f.grab && f.tracking === 'normal' && !st.twinUp.off && wantKey(st.twin, now, f.pose.position, f.pose.quaternion)) {
      const g = grabbed || f.grab();
      if (g) {
        const name = addKey(st.twin, now, odo, f.pose.position, f.pose.quaternion, g);
        g.blob.then((b) => b && sendTwin([{ name, type: 'image/jpeg', body: b }]), () => {});
        const dep = keyDepth(f, name);
        if (dep) sendTwin([dep]);
      }
    }
    if (flushDue(st.twin, now)) sendTwin(flush(st.twin, now, liveOf(L, w, { recordOnly: !!st.recordOnly, points: pointsKept(), gpsTrail: trailKept(), geoTrail: geoKept(), anchors: st.anchors ? anchorsKept(st.anchors) : null, prev: prevKept() })));
  }
  // PLACED BY THE MAP'S EARLIER WALK (walkref.js, SCAN-H32): every PREV_EVERY, this walk's points so far against it
  if (st.ref?.ready && !st.ref.stale && !st.prevAsk && f.tracking === 'normal' && Date.now() - st.prevAt > PREV_EVERY && st.prevStand.size >= REF_MIN_STAND) {
    const id = `p${Date.now()}`;
    st.prevAt = Date.now(); st.prevAsk = { id, odo }; st.prevStats.asks++;
    st.ref.worker.postMessage({ fix: { id, stand: [...st.prevStand.values()], ground: [...st.prevGround.values()] } });
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
  // draw
  if (f.gl && f.view && f.proj) {
    try {
      if (!st.drawer || st.drawer.gl !== f.gl) st.drawer = { gl: f.gl, d: makeDrawer(f.gl) };
      const items = [];
      for (const p of w.pins) {
        if (p.anchor) { const a = st.tracker?.anchorAt(p.anchor); if (a) p.anchorAt = a; }
        const now = pinNow(p);
        items.push({ kind: 'pin', at: now, color: COLOR.pin });
        if (now !== p.at) items.push({ kind: 'mark', at: p.at, color: COLOR.placed });
      }
      // the references and check points where the fit puts them: on the real corner when the fix is right
      const T = fitFor(L, odo);
      if (T) for (const p of st.points) { const s = sessionOf(L, p.map, odo, L.groundY ?? (f.pose ? f.pose.position.y - 1.4 : 0)); if (s && f.pose && levelDist(s, f.pose.position) < 30) items.push({ kind: 'mark', at: s, color: p.kind === 'ref' ? COLOR.ref : COLOR.check }); }
      if (w.pendingMeasure) items.push({ kind: 'mark', at: w.pendingMeasure.a, color: COLOR.mark });
      if (f.hit) items.push({ kind: 'dot', at: f.hit.position, color: f.hit.type === 'DEPTH' ? COLOR.dot : COLOR.dotPlane });
      // THE LIDAR IN THE CAMERA (owner, 2026-11-03: "so that I can see how it's lining up... mostly transparent, but
      // still visible... then add a black dot on them if the AR agrees with them"): the solid cells the match matches
      // against (blue), the canopy (green) and the roofs (orange), through the fit for this moment; black dots where
      // the phone's standing points land on a solid cell, red where they land on nothing
      const statics = [], dots = [];
      if (st.lidarOn && T && st.lid.overlay && f.pose) {
        if (!st.lid.meshes || st.lid.meshes.gl !== f.gl) {
          /* THE LOOK (lib/look.js; the owner, 2026-11-10): black roofs, white walls, green trees, orange for other
             objects, smooth surfaces on 0.5 m, drawn solidly. The old blue/green/orange boxes only if a worker from
             before the look answered. */
          if (st.lid.overlay.show) st.lid.meshes = { gl: f.gl, look: lookMeshes(st.lid.overlay.show).map((m) => ({ mesh: st.drawer.d.makeMesh(m.verts), color: m.color })) };
          else {
            const m = lidarMeshes(st.lid.overlay);
            st.lid.meshes = { gl: f.gl, solids: st.drawer.d.makeMesh(m.solids), canopy: st.drawer.d.makeMesh(m.canopy), roofs: st.drawer.d.makeMesh(m.roofs) };
          }
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
  if (f.t - st.hudAt > 200) { st.hudAt = f.t; hud(f); }
  if (f.t - (st.miniAt || 0) > 120) { st.miniAt = f.t; try { drawMini(f); arrows(f); } catch (e) { log(`mini map: ${e.message}`); } }
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
  const fixLine = st.origin ? `<br>${st.recordOnly ? '<strong>Recording only</strong>: no live lidar fix; the walk is placed afterwards (workflow S, task fix). ' : ''}${esc(st.lid.ready ? fixStatus(L, w.odo) : st.lid.error ? `No lidar (${st.lid.error}); references only: ${fixStatus(L, w.odo)}` : `Lidar: ${st.lid.progress || 'reading…'}`)}${ag}${target ? `<br>Next to mark: <strong style="color:${target.kind === 'ref' ? '#8ab4ff' : '#d9a6ff'}">${esc(target.name)}</strong> (aim where it meets the ground, within 10 ft, tap Mark; tap another point on the mini map to mark that one instead)` : ''}` : '';
  const last = st.errors.length && Date.now() - st.errors[st.errors.length - 1].t < 6000 && /engine|start/.test(st.errors[st.errors.length - 1].what) ? `<br><span class="bad">${esc(st.errors[st.errors.length - 1].what)}</span>` : '';
  $('#hud').innerHTML = `${NAME[w.engine]} · ${tr} · walked ${Math.round(w.stats.walked * FT)} ft${pts} · ${aim} · ${w.pins.length} pin${w.pins.length === 1 ? '' : 's'}${w.pendingMeasure ? ' · <span class="warn">now aim at the second mark</span>' : ''}${fixLine}${prevLine}${st.nudge ? `<br><span class="warn">${esc(st.nudge.text)}</span>` : ''}${st.upStatus && (st.upStatus.pending > 3 || st.upStatus.off || (st.upStatus.pending && !st.upStatus.sending)) ? `<br><span class="dim">${esc(statusText(st.upStatus))}</span>` : ''}${last}`;
  const can = !!f.hit && f.tracking !== 'lost';
  $('#pin').disabled = !can; $('#measure').disabled = !can; $('#check').disabled = !can || !w.pins.length; $('#mark').disabled = !target || (target.roof ? f.tracking === 'lost' : !can);
  const again = target && L.marks.some((m) => m.id === target.id);
  $('#mark').textContent = target ? (st.sight?.target.id === target.id ? `Cancel ${target.name}` : `Mark ${target.name}${target.roof ? ' (roof)' : ''}${again ? ' again' : ''}`) : 'Mark';
  if (f.t - (st.mapAt || 0) > 1000 && fitFor(L, w.odo)) { st.mapAt = f.t; drawMap(); }
}

/** The lidar ground at a map point from the 1 m grid the worker sent; `fallback` off the grid. */
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
        if (best) { st.chosen = best.q.id; flash(`Next to mark: ${best.q.name}`); if (st.ar) drawMini(st.ar); }
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
    flash(`Pin ${p.name} dropped (${ftIn(p.aim || 0)}, by ${p.type === 'DEPTH' ? 'depth' : 'plane'})`);
    if (st.tracker?.anchor) st.tracker.anchor(p.at).then((a) => { if (a && st.walk && st.walk.pins.includes(p)) { p.anchor = a; p.anchorAt = st.tracker?.anchorAt(a) || { ...p.at }; } });
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
  if (st.sight?.target.id === target.id) { st.sight = null; $('#guide').hidden = true; flash(`${target.name}: cancelled`); return; }
  const groundY = st.L.groundY ?? (f.pose ? f.pose.position.y - 1.4 : 0);
  st.sight = { S: newSight({ eaveM: target.roof.eaveM, groundY }), target, rays: 0 };
  log(`roof corner ${target.name} (${target.roof.label}, eave ${target.roof.eaveM} m): sighting started, ground y ${groundY.toFixed(2)}`);
}
function stepSight(f) {
  const s = st.sight; if (!s) return;
  sight(s.S, { t: f.t, pos: f.pose?.position, quat: f.pose?.quaternion, tracking: f.tracking });
  const S = s.S, el = $('#guide');
  if (S.rays.length !== s.rays) { s.rays = S.rays.length; try { navigator.vibrate?.(60); } catch { /* no buzz */ } }
  el.hidden = false; $('#guide-say').textContent = `${s.target.name}, the roof's ${s.target.roof.label}: ${S.say}`; $('#guide-detail').textContent = S.detail || ''; $('#guide-bar').style.width = `${Math.round((S.progress || 0) * 100)}%`;
  if (!S.done) return;
  st.sight = null; setTimeout(() => { if (!st.sight) el.hidden = true; }, 1800);
  (st.walk.roofSights ||= []).push({ name: s.target.name, ok: S.done.ok, why: S.done.why || null, sights: S.done.sights ?? S.rays.length, missM: S.done.missM != null ? +S.done.missM.toFixed(3) : null, turnDeg: S.done.turnDeg != null ? Math.round(S.done.turnDeg) : null, eaveOffM: S.done.eaveOffM != null ? +S.done.eaveOffM.toFixed(2) : null, steps: S.log });
  if (!S.done.ok) { flash(`${s.target.name} not marked: ${S.done.why}`); log(`roof corner ${s.target.name} not marked: ${S.done.why}`); return; }
  try { navigator.vibrate?.([60, 60, 120]); } catch { /* no buzz */ }
  mark(st.L, s.target, { position: S.done.position, distance: S.done.distance, type: 'ROOF' }, st.walk.odo);
  const n = new Set(st.L.marks.filter((m) => m.kind === 'ref').map((m) => m.id)).size;
  flash(n >= 2 ? `${s.target.name} marked: lined up by ${n} references` : `${s.target.name} marked: one more reference lines the map up`);
  log(`roof corner ${s.target.name} marked: ${S.done.sights} aims ${Math.round(S.done.turnDeg)} degrees apart, lines ${(S.done.missM * 100).toFixed(0)} cm apart, ${S.done.eaveOffM.toFixed(2)} m off the lidar's eave`);
  st.undoMarks.push({ id: s.target.id, name: s.target.name, check: false, at: Date.now() });
  st.chosen = null;
}
function doMark(f, { replay = false, target: tid = null } = {}) {
    const target = tid != null ? st.points.find((q) => q.id === tid) : nextTarget(); if (!target) return;
    if (target.roof && f?.pose) { recordAct({ a: 'mark', target: target.id }); startSight(f, target); return; }
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
    page: 'yard AR test v2', roofSights: w.roofSights || null, recordOnly: !!st.recordOnly, features: w.features || null, depthType: w.depthType || null, anchors: st.anchors ? anchorsKept(st.anchors) : null, depthFill: st.depthFill ? { frames: st.depthFill.frames, holes: +(st.depthFill.zero / Math.max(1, st.depthFill.cells)).toFixed(3), past8m: +(st.depthFill.far / Math.max(1, st.depthFill.cells)).toFixed(3), weak: +(st.depthFill.weak / Math.max(1, st.depthFill.cells)).toFixed(3), minConf: st.depthFill.minConf } : null, rawAsked: !!st.rawDepth, geo: geoSummary(), depthSpikes: st.spikes ? { ...st.spikes, share: +(st.spikes.flagged / Math.max(1, st.spikes.cells)).toFixed(4), recordOnly: true } : null, walkFix: st.walkStats ? { ...st.walkStats, share: L?.walk?.ok ? +L.walk.share.toFixed(3) : null, margin: L?.walk?.ok ? +L.walk.margin.toFixed(3) : null, walkedM: L?.walk?.ok ? Math.round(L.walk.walkedM) : null } : null, semantics: st.caps?.native ? { on: !!st.tracker?.semantics, dims: st.semDims || null, ...(semSummary(st.sem) || {}) } : null, crumbs: crumbs ? { n: crumbs.n, held: crumbs.held, lost: crumbs.lost, refused: crumbs.refused, medianM: crumbs.medianM, maxM: crumbs.maxM, maxLevelM: crumbs.maxLevelM, worstOdo: crumbs.worstOdo } : null, app: st.caps?.native ? { app: st.caps.native.app, bridge: st.caps.native.bridge, device: st.caps.native.device, camera: st.started?.camera ?? null, image: st.started?.image ?? null, modes: st.started?.modes ?? null, streetscape: st.started?.streetscape ?? null, streetError: st.started?.streetError ?? null, recording: st.started?.recording ?? null, recordError: st.started?.recordError ?? null, geoDepthPoints: st.geoDepthN || 0, grabW: st.grabW || null } : null, replayOf: st.replayOf || null, failed: w.failed || null, errors: st.errors.map((e) => e.what).slice(-30),
    references: refs, checks: (w.checks || []).map((c) => ({ ...c, errorM: r3(c.errorM), errorFixM: r3(c.errorFixM), errorRefsM: r3(c.errorRefsM), walkedSinceFixM: r2(c.walkedSinceFixM), aimM: r2(c.aimM), walkedM: r2(c.walkedM) })),
    pinsNear: w.pins.map((p) => ({ name: p.name, nearest: p.nearest ? { name: p.nearest.name, m: r2(p.nearest.m), byRefsM: r2(p.nearest.byRefsM) } : null })),
    fix: L ? summaryOf(L) : null, surfaceSeen: st.surfCount || null, lidar: st.lid.ready ? { points: st.lid.ready.points, solid: st.lid.ready.solid, shift: st.lid.ready.shift, rule: st.lid.ready.rule || null, structures: st.lid.ready.structures || null, tallCells: st.lid.overlay ? st.lid.overlay.tall.length / 5 : null } : st.lid.error ? { error: st.lid.error } : null,
  });
  s.id = `${w.startedAt}`; s.saved = null;
  if (st.twin) {
    sendTwin(flush(st.twin, Date.now(), liveOf(L, w, { ended: true, summary: s.id, crumbs: crumbs ? crumbs.list : null, walk: L?.walk?.ok ? { T: L.walk.T, share: L.walk.share, margin: L.walk.margin, walkedM: L.walk.walkedM, from: L.walk.from } : null, recordOnly: !!st.recordOnly, points: pointsKept(), gpsTrail: trailKept(), geoTrail: geoKept(), anchors: st.anchors ? anchorsKept(st.anchors) : null })));
    s.twin = { ...st.twin.counts, camera: st.twin.camera, off: st.twinUp.off };
  }
  st.twin = null;
  st.tracker = null; st.walk = null; st.L = null; st.ar = null; st.drawer = null;
  st.replayOf = null; st.replayImage = null; st.replaySmall = false; // a replay is one walk; the next starts from the camera again
  $('#overlay').hidden = true; document.body.classList.remove('in-ar');
  const list = kept(); list.push(s); keep(list);
  renderResults(s.id); drawMap();
  post(s);
  // kept as its map's reference, by itself (keepReference): said on the walk's card when it is known
  if (L && !s.failed) {
    const say = (text) => { const all = kept(), mine = all.find((x) => x.id === s.id); if (mine) { mine.reference = text; keep(all); renderResults(s.id); } };
    say('Saving this walk as the map\'s reference…');
    keepReference(L, String(w.startedAt)).then((text) => { say(text || ''); if (text) { log(text); flash(/^Saved/.test(text) ? 'Saved as this map\'s reference' : 'Not saved as the reference: see the walk\'s card'); } askReference(); })
      .catch((e) => say(`NOT saved as the reference: ${e.message}`));
  }
}
const r2 = (v) => (v == null ? null : +Number(v).toFixed(2)), r3 = (v) => (v == null ? null : +Number(v).toFixed(3));

/** The twin's parts up to the site (src/twin.js), one at a time, each tried twice; a missing bucket stops it. */
/* THE OUTBOX (scan/lib/outbox.js, 2026-11-07): every part of a walk is kept on the phone first and leaves only when
   the site has it; a failed part waits and goes again, and parts left by a walk closed early go up the next time the
   page opens. Walk summaries the site did not take are posted again then too. */
async function startOutbox() {
  const store = (await idbStore().catch(() => null)) || memoryStore();
  st.outbox = newOutbox({ store, send: sendPart, onChange: (u) => { st.upStatus = u; if (st.twinUp) { st.twinUp.off = u.off; st.twinUp.sent = u.sent; st.twinUp.failed = u.dropped; } renderUploads(); } });
  await st.outbox.refresh();
  st.outbox.kick();
  for (const w of kept().filter((x) => x.saved === false)) post(w);
  window.addEventListener('online', () => { st.outbox?.kick(); for (const w of kept().filter((x) => x.saved === false)) post(w); });
}

/** One part to the site: 'ok', 'retry' (no answer, 5xx, 408, 429), 'drop' (refused) or 'off' (no bucket). */
async function sendPart(p) {
  const res = await fetch(`/api/scan/twin?walk=${encodeURIComponent(p.walk)}&part=${encodeURIComponent(p.name)}`, { method: 'PUT', headers: { 'Content-Type': p.type }, body: p.body });
  if (res.ok) return 'ok';
  if (res.status === 503) { p.offWhy = 'the site has no twin bucket yet'; return 'off'; }
  if (res.status === 408 || res.status === 429 || res.status >= 500) return 'retry';
  if (res.status === 401 || res.status === 403 || res.status === 404) return 'retry'; // signed out for now: keep it for later
  p.dropWhy = ((await res.json().catch(() => ({})))?.error || `${res.status}`).slice(0, 80);
  return 'drop';
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
        st.ref.ready = data.ready; st.refTries = 0;
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
        if (data.fix.ok && st.L) {
          const first = !st.L.prev?.ok;
          st.L.prev = { ok: true, T: data.fix.T, tz: data.fix.tz, landed: data.fix.landed, second: data.fix.second, walkedM: a.odo, at: Date.now() };
          st.prevStats.ok++; st.prevStats.lastWhy = null;
          if (st.prevStats.firstOkM == null) st.prevStats.firstOkM = Math.round(a.odo);
          if (first) flash('Placed by your earlier walk');
        } else st.prevStats.lastWhy = data.fix.why;
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
  drawRefChoice();
}
function drawRefChoice() {
  const box = $('#ref-choice'); if (!box) return;
  const M = st.refMeta;
  box.hidden = false;
  if (!M) { box.innerHTML = '<span class="dim">No walk is saved for this map: this walk, once its roof corners are marked, is saved to place the next one.</span>'; return; }
  const when = M.at ? new Date(M.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'earlier';
  box.innerHTML = `<span class="dim" style="flex-basis:100%">A walk saved ${esc(when)} can place this one:</span><button type="button" id="ref-saved" class="${refChoice() === 'saved' ? '' : 'plain'}">Use the saved walk</button><button type="button" id="ref-fresh" class="${refChoice() === 'fresh' ? '' : 'plain'}">Fresh: this walk replaces it</button>`;
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
  if (st.refUse) return 'Not saved as the reference: the saved walk was placing this one.';
  if (st.recordOnly) return 'Not saved as the reference: a recording-only walk.';
  const fit = referenceFit(L?.marks || []);
  if (!fit.ok) return `NOT saved as the reference: ${fit.why}.`;
  const stand = [...(st.prevStand?.values() || [])], ground = [...(st.prevGround?.values() || [])];
  if (stand.length < REF_MIN_STAND) return `NOT saved as the reference: too little of the yard's standing things was seen (${stand.length} points of ${REF_MIN_STAND}).`;
  const bytes = encodeRef(buildRef({ stand, ground }, fit.T, Date.now()));
  const how = `${fit.n} ${fit.roof ? 'roof corners' : 'marks'} agreeing within ${(fit.worstM * 39.37).toFixed(0)} in`;
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(`/api/scan/reference?map=${encodeURIComponent(map)}&walk=${encodeURIComponent(walkId)}`, { method: 'PUT', credentials: 'same-origin', body: bytes });
      if (r.ok) return `Saved as this map's reference (${how}; ${stand.length.toLocaleString()} points of standing things, ${(bytes.length / 1e6).toFixed(1)} MB). The next walk here can use it.`;
      if (r.status === 404 || r.status === 413) return `NOT saved as the reference: the site answered ${r.status}.`;
    } catch { /* signal: again */ }
    await new Promise((res) => setTimeout(res, 4000 * (k + 1)));
  }
  return 'NOT saved as the reference: it could not be sent (no signal?). Walk again with signal, or tell the core session.';
}

/** This walk's standing things and ground, one point to a small cube, for the earlier walk's match. */
function keepForPrev(L, pts) {
  for (const p of pts) {
    const g = groundUnder(L, p);
    if (g == null || !Number.isFinite(g)) continue;
    const h = p.y - g, u = p.x, v = -p.z;
    const which = Math.abs(h) < 0.15 ? st.prevGround : h >= REF_STAND[0] && h <= REF_STAND[1] ? st.prevStand : null;
    if (!which || which.size >= PREV_MAX) continue;
    const k = `${Math.floor(u / REF_VOX)},${Math.floor(v / REF_VOX)},${Math.floor(p.y / REF_VOX)}`;
    if (!which.has(k)) which.set(k, [u, v, p.y]);
  }
}

/** What the earlier walk's match did, for the walk's twin (live.json). */
function prevKept() {
  if (!st.ref || st.ref.none) return st.ref?.none ? { reference: false, why: 'none kept for this map' } : null;
  if (!st.ref.ready || st.ref.stale) return { reference: !!st.ref.ready, why: st.ref.stale ? 'made before this set of points' : st.ref.error || 'still loading', ...st.prevStats, fix: null };
  const P = st.L?.prev, r = (v) => (Number.isFinite(v) ? +v.toFixed(4) : null);
  return { reference: !!st.ref.ready, ...st.prevStats, fix: P ? { T: { theta: r(P.T.theta), tx: r(P.T.tx), ty: r(P.T.ty), s: 1 }, tz: r(P.tz), landed: P.landed, second: P.second, walkedM: r(P.walkedM) } : null };
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

function sendTwin(parts) {
  const walk = st.twin?.walk || st.twinUp?.walk;
  if (!walk || !parts?.length) return;
  if (st.twinUp) st.twinUp.walk = walk;
  if (!st.outbox) { setTimeout(() => sendTwin(parts), 500); return; }
  for (const p of parts) st.outbox.add(walk, p.name, p.type, p.body).catch(() => {});
}

/** The upload line on the page (and in the HUD while walking, when anything waits). */
function renderUploads() {
  const el = $('#uploads');
  if (el) el.textContent = st.upStatus ? statusText(st.upStatus) : '';
}

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
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) setTimeout(() => { if (st.has8w) load8thWall(ENGINE_URL).catch(() => {}); }, 1500);
