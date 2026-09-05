/**
 * Lawn Mapper frontend.
 *
 * The flow, and why it is ordered this way:
 *
 *   address -> pick candidate -> CONFIRM ON MAP -> parcel -> tap lawn
 *           -> SAM -> edit polygon -> export
 *
 * The confirm step is not decoration. Every step after it is either slow or
 * costs money, and a geocode that lands one street over produces a number
 * that looks entirely credible and is wrong. Making the user look at their
 * own roof first is the cheapest correctness check available.
 */

import { measure } from './lib/area.js';
import { maskToPolygons } from './lib/mask.js';
import {
  offsetEdge, nearestEdge, edgeLength, edgeBearing, edgeMidpoint,
  feetToMetres, metresToFeet,
} from './lib/edges.js';
import {
  framePxToLngLat,
  lngLatToFramePx,
  frameCorners,
  metresPerPixel,
  zoomToFit,
  geometryBounds,
  worldSize,
} from './lib/mercator.js';

/* ------------------------------------------------------------------ state */

const FRAME_SIZE = 640;          // logical px requested; the PNG comes back @2x
const IMAGERY_ZOOM_FALLBACK = 19; // used when we have no parcel to fit

const state = {
  clientId: clientId(),
  chosen: null,       // { label, lng, lat }
  parcel: null,       // GeoJSON Feature or null
  frame: null,        // { lng, lat, zoom, size } used for the last/next SAM call
  promptPoints: [],   // one [lng, lat] per separate lawn area the user marked
  promptMarkers: [],
  quota: null,
};

const MAX_PROMPT_POINTS = 8;

let map;
let draw;

/**
 * Support hook, exposed as window.__lm.
 *
 * "Tapping the map does nothing" has several possible causes that look
 * identical from outside: the handler never fires, it fires and bails on a
 * guard, or the map never armed the picker at all. Recording which one lets a
 * browser test -- or anyone with a console open -- tell them apart in one go.
 * Read-only counters; no tokens or personal data.
 */
const diag = { clicks: 0, rejected: 0, lastMode: null, armed: false, viaTouch: 0, viaClick: 0 };
if (typeof window !== 'undefined') {
  window.__lm = diag;
  Object.defineProperty(diag, 'drawMode', {
    get() {
      try {
        return draw ? draw.getMode() : 'draw not initialised';
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },
  });
}

/** Stable per-browser id for quota bucketing. Not identity, just a bucket. */
function clientId() {
  const KEY = 'lawn-mapper-client';
  let id = null;
  try {
    id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
  } catch {
    // Private browsing with storage disabled. A per-session id still works;
    // the user simply gets a fresh allowance next visit.
    id = crypto.randomUUID();
  }
  return id;
}

/* --------------------------------------------------------------- plumbing */

const $ = (sel) => document.querySelector(sel);

async function api(path, options) {
  const res = await fetch(path, options);
  const type = res.headers.get('Content-Type') || '';
  const body = type.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function showStep(name) {
  for (const el of document.querySelectorAll('.step')) {
    el.hidden = el.id !== `step-${name}`;
  }
}

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `statusline ${kind}`;
}

function setHint(text) {
  const el = $('#map-hint');
  el.textContent = text || '';
  el.hidden = !text;
}

function busy(text) {
  $('#busy-text').textContent = text;
  $('#busy').hidden = false;
}
const idle = () => { $('#busy').hidden = true; };

/* ------------------------------------------------------------------- map */

/**
 * Show a blocking, visible error.
 *
 * Anything that stops the map from existing stops the whole product, and the
 * inline status line lives inside a panel that is hidden until later steps --
 * so a failure here would otherwise look like a search box that quietly does
 * nothing. Say so instead.
 */
function fatal(message) {
  $('#fatal-text').textContent = message;
  showStep('fatal');
  setHint('');
  idle();
}

async function initMap() {
  // Mapbox GL and Draw come from Mapbox's CDN. A blocked network, a corporate
  // filter, or a CDN outage leaves the globals undefined, and every later call
  // fails with an unhelpful ReferenceError.
  if (typeof mapboxgl === 'undefined' || typeof MapboxDraw === 'undefined') {
    fatal(
      'We could not load the mapping library from Mapbox. Check your internet ' +
      'connection, or any ad blocker or network filter that might be blocking ' +
      'api.mapbox.com, then try again.'
    );
    return;
  }

  const { mapboxToken } = await api('/api/config');
  if (!mapboxToken) {
    fatal(
      'This site is missing its Mapbox key, so the map cannot start. ' +
      'If you run this site: set it with `npx wrangler secret put MAPBOX_TOKEN`.'
    );
    return;
  }

  mapboxgl.accessToken = mapboxToken;
  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: [-85.67, 43.0],
    zoom: 9,
    // Required so the map canvas can still be read after the browser has
    // composited it -- without this, "Save image" produces a blank PNG.
    preserveDrawingBuffer: true,
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

  draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    defaultMode: 'simple_select',
  });
  map.addControl(draw);

  for (const evt of ['draw.create', 'draw.update', 'draw.delete']) {
    map.on(evt, refreshMeasurement);
  }

  await new Promise((resolve) => map.on('load', resolve));

  map.addSource('parcel', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'parcel-fill', type: 'fill', source: 'parcel',
    paint: { 'fill-color': '#ffd54f', 'fill-opacity': 0.08 },
  });
  map.addLayer({
    id: 'parcel-line', type: 'line', source: 'parcel',
    paint: { 'line-color': '#ffd54f', 'line-width': 2, 'line-dasharray': [2, 1.5] },
  });

  map.addSource('edge-highlight', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'edge-highlight', type: 'line', source: 'edge-highlight',
    paint: { 'line-color': '#ff6f00', 'line-width': 5, 'line-opacity': 0.9 },
  });

  // Corners still backed by the county record. Drawn above everything so the
  // user can see at a glance which parts of the outline are authoritative.
  map.addSource('surveyed', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'surveyed', type: 'circle', source: 'surveyed',
    paint: {
      'circle-radius': 5,
      'circle-color': '#ffd54f',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#5d4600',
    },
  });

  map.on('draw.selectionchange', updateSelectionButtons);
  for (const evt of ['draw.create', 'draw.update', 'draw.delete']) {
    map.on(evt, refreshSurveyed);
  }

  verifyProjection();
}

const empty = () => ({ type: 'FeatureCollection', features: [] });

/**
 * Cross-checks mercator.js's TILE_SIZE against Mapbox GL's own projection.
 *
 * mercator.js has to assume how many pixels wide Mapbox considers the world
 * at a given zoom. If that assumption is wrong, every traced lawn is off by a
 * clean factor of four in area -- the kind of error that ships quietly. GL JS
 * knows the true answer, so we ask it and complain loudly on a mismatch
 * rather than letting a plausible-looking wrong number through.
 */
function verifyProjection() {
  const c = map.getCenter();
  const z = map.getZoom();
  const dLng = 0.01;
  const a = map.project(c);
  const b = map.project([c.lng + dLng, c.lat]);
  const measured = Math.abs(b.x - a.x) / dLng;   // css px per degree of lng
  const predicted = worldSize(z) / 360;
  const ratio = measured / predicted;

  if (Math.abs(ratio - 1) > 0.01) {
    console.error(
      `[lawn-mapper] Projection mismatch: Mapbox GL reports ${ratio.toFixed(3)}x ` +
      `the scale mercator.js predicts. TILE_SIZE in public/lib/mercator.js is ` +
      `wrong, and AI-detected lawn areas will be off by about ${(ratio ** 2).toFixed(2)}x. ` +
      `Hand-drawn shapes are unaffected.`
    );
    setStatus('Heads up: AI detection may be misaligned. Drawing by hand is accurate.', 'warn');
  }
}

/* -------------------------------------------------------------- geocoding */

async function search(query) {
  busy('Looking up that address…');
  try {
    const { results } = await api(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (!results.length) {
      setStatus('');
      showStep('address');
      alert("We couldn't find that address. Try including the city and state.");
      return;
    }
    if (results.length === 1) return choose(results[0]);
    renderCandidates(results);
    showStep('candidates');
  } catch (err) {
    alert(err.message);
    showStep('address');
  } finally {
    idle();
  }
}

function renderCandidates(results) {
  const list = $('#candidate-list');
  list.replaceChildren();

  for (const r of results) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';

    const addr = document.createElement('span');
    addr.className = 'addr';
    addr.textContent = r.label;

    const meta = document.createElement('span');
    meta.className = 'meta';
    const pill = document.createElement('span');
    pill.className = r.inCoverage ? 'pill' : 'pill grey';
    pill.textContent = r.inCoverage ? 'Property line available' : 'Trace by hand';
    meta.append(pill, document.createTextNode(`match: ${r.accuracy}`));

    btn.append(addr, meta);
    btn.addEventListener('click', () => choose(r));
    li.append(btn);
    list.append(li);
  }
}

function choose(result) {
  state.chosen = result;
  $('#chosen-label').textContent = result.label;
  showStep('confirm');
  setHint('Does this look like your property?');

  map.flyTo({ center: [result.lng, result.lat], zoom: 18.5, duration: 900 });

  if (state.marker) state.marker.remove();
  state.marker = new mapboxgl.Marker({ color: '#2f7d32' })
    .setLngLat([result.lng, result.lat])
    .addTo(map);
}

/* ----------------------------------------------------------------- parcel */

async function confirmLocation() {
  showStep('work');
  busy('Checking county records for your property line…');

  try {
    const { lng, lat } = state.chosen;
    const data = await api(`/api/parcel?lng=${lng}&lat=${lat}`);
    state.parcel = data.parcel || null;

    if (state.parcel) {
      map.getSource('parcel').setData(state.parcel);
      const bbox = geometryBounds(state.parcel);
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 60, duration: 800 });
      state.frame = {
        lng: (bbox[0] + bbox[2]) / 2,
        lat: (bbox[1] + bbox[3]) / 2,
        zoom: zoomToFit(bbox, FRAME_SIZE),
        size: FRAME_SIZE,
      };
      // Remember the county's own corners so the map can show which parts of
      // the final outline are still survey-accurate.
      const ring = outerRing(state.parcel) ||
        (state.parcel.geometry.type === 'MultiPolygon'
          ? state.parcel.geometry.coordinates[0][0]
          : []);
      state.surveyed = ring.map((p) => [...p]);
      $('#btn-parcel-shape').hidden = false;

      const a = measure(state.parcel.geometry);
      setStatus(
        `Found your property line — ${a.acres} acres total ` +
        `(${state.parcel.properties.county}). Now show us the grass.`
      );
    } else {
      map.getSource('parcel').setData(empty());
      state.surveyed = [];
      $('#btn-parcel-shape').hidden = true;
      map.flyTo({ center: [lng, lat], zoom: IMAGERY_ZOOM_FALLBACK, duration: 600 });
      state.frame = { lng, lat, zoom: IMAGERY_ZOOM_FALLBACK, size: FRAME_SIZE };
      setStatus(
        data.covered
          ? "Your county has records, but not for this parcel. You can still measure it."
          : 'No property line available for this address. Trace your lawn instead — the measurement is just as accurate.'
      );
    }

    armLawnPicker();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    idle();
    refreshQuota();
  }
}

/* ------------------------------------------------------- lawn prompt point */

/**
 * SAM segments whatever its prompt points touch, and the geocoded pin sits on
 * the house. Asking the user to tap the grass is more reliable than any
 * centroid heuristic and easier to explain than why the tool outlined a roof.
 *
 * One tap per separate area: a lawn cut in two by a driveway is two shapes,
 * and a single prompt point finds one of them and silently misses the other.
 */
function armLawnPicker() {
  state.detected = false;
  diag.armed = true;
  updatePromptHint();
  map.getCanvas().style.cursor = 'crosshair';
  map.on('click', onMapClick);
  const el = map.getCanvasContainer();
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
}

function disarmLawnPicker() {
  diag.armed = false;
  map.getCanvas().style.cursor = '';
  map.off('click', onMapClick);
  const el = map.getCanvasContainer();
  el.removeEventListener('touchstart', onTouchStart);
  el.removeEventListener('touchend', onTouchEnd);
}

/*
 * Why there are two paths into the same handler.
 *
 * Mapbox GL Draw calls preventDefault on touchend. That stops the browser
 * synthesising the click event that map.on('click') is built on, so on a
 * phone -- and only on a phone -- tapping the map did nothing at all, with no
 * error to show for it. A mouse click still worked, which is why it survived
 * every test until someone used it on an actual phone.
 *
 * So touches are read natively from the canvas container, and the click path
 * is kept for mice. A device that delivers both would otherwise register one
 * interaction twice, so a click is ignored when it lands in the same place as
 * a touch we just handled -- position as well as time, because two genuine
 * taps on two different lawn areas can easily fall inside any sane time
 * window, and dropping the second is exactly the bug this feature is for.
 */
let touchStart = null;
let handled = { at: 0, x: null, y: null };

const TAP_SLOP_PX = 14;    // a finger never lands perfectly still
const TAP_MAX_MS = 700;    // longer than this is a press, or a slow pan
const ECHO_MS = 700;       // a synthetic click follows its touch closely
const ECHO_SLOP_PX = 30;   // ...and lands on the same spot

function onTouchStart(e) {
  touchStart = e.touches.length === 1
    ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() }
    : null; // two fingers is a zoom, never a tap
}

function onTouchEnd(e) {
  const start = touchStart;
  touchStart = null;
  if (!start) return;

  const t = e.changedTouches && e.changedTouches[0];
  if (!t) return;
  if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > TAP_SLOP_PX) return;
  if (Date.now() - start.at > TAP_MAX_MS) return;

  const rect = map.getCanvasContainer().getBoundingClientRect();
  const lngLat = map.unproject([t.clientX - rect.left, t.clientY - rect.top]);
  diag.viaTouch++;
  handleMapPoint(lngLat, t.clientX, t.clientY);
}

function onMapClick(e) {
  const src = e.originalEvent || {};
  const x = Number.isFinite(src.clientX) ? src.clientX : null;
  const y = Number.isFinite(src.clientY) ? src.clientY : null;

  // The echo of a touch we already handled: same place, moments later. Only
  // suppress when both positions are actually known -- treating "position
  // unknown" as "same position" would swallow legitimate second taps.
  const known = x !== null && handled.x !== null;
  if (known &&
      Date.now() - handled.at < ECHO_MS &&
      Math.hypot(x - handled.x, y - handled.y) < ECHO_SLOP_PX) {
    return;
  }

  diag.viaClick++;
  handleMapPoint(e.lngLat, x, y);
}

function handleMapPoint(lngLat, x = null, y = null) {
  diag.clicks++;
  handled = { at: Date.now(), x, y };

  let mode;
  try {
    mode = draw.getMode();
  } catch (err) {
    mode = `ERROR: ${err.message}`;
  }
  diag.lastMode = mode;

  // Ignore taps meant for a shape the user is drawing or editing.
  if (mode !== 'simple_select') {
    diag.rejected++;
    return;
  }

  if (state.edgeEdit) return selectEdgeNear([lngLat.lng, lngLat.lat]);

  addPromptPoint([lngLat.lng, lngLat.lat]);
}

function addPromptPoint(lngLat) {
  if (state.promptPoints.length >= MAX_PROMPT_POINTS) {
    setStatus(`That is the most areas we can detect at once (${MAX_PROMPT_POINTS}). Remove one first.`, 'warn');
    return;
  }

  state.promptPoints.push(lngLat);
  state.promptMarkers.push(
    new mapboxgl.Marker({ color: '#ffd54f', scale: 0.7 }).setLngLat(lngLat).addTo(map)
  );
  state.detected = false;
  updatePromptHint();
}

function removeLastPromptPoint() {
  state.promptPoints.pop();
  state.promptMarkers.pop()?.remove();
  updatePromptHint();
}

function clearPromptPoints() {
  for (const m of state.promptMarkers) m.remove();
  state.promptMarkers = [];
  state.promptPoints = [];
  updatePromptHint();
}

/** Keep the buttons and the wording in step with how many areas are marked. */
function updatePromptHint() {
  const n = state.promptPoints.length;
  const left = state.quota ? Math.max(0, state.quota.limit - state.quota.used) : null;

  $('#btn-detect').disabled = n === 0 || state.detected;
  $('#btn-detect').textContent =
    n <= 1 ? 'Detect my lawn' : `Detect my lawn (${n} areas)`;
  $('#btn-undo-pin').hidden = n === 0;

  if (n === 0) {
    setHint('Tap the middle of your lawn');
    setStatus(state.parcel
      ? 'Tap each separate part of your lawn — front, back, side strips.'
      : 'Tap each separate part of your lawn, or draw it by hand.');
    return;
  }

  setHint(n === 1
    ? 'Tap any other separate patch of lawn, or press Detect'
    : `${n} areas marked — tap more, or press Detect`);
  setStatus(
    `${n} area${n > 1 ? 's' : ''} marked.` +
    (left === null ? '' : ` Detecting uses 1 of your ${left} remaining today, however many areas you mark.`)
  );
}

/* ------------------------------------------------------------- detection */

async function detect() {
  if (!state.promptPoints.length || !state.frame) return;

  const frame = state.frame;
  const img = frame.size * 2; // the static image is requested @2x

  // Points outside the photographed frame cannot be segmented; drop them
  // rather than sending coordinates SAM will read as the nearest corner.
  const inside = [];
  let dropped = 0;
  for (const p of state.promptPoints) {
    const [px, py] = lngLatToFramePx(frame, p, img, img);
    if (px < 0 || py < 0 || px > img || py > img) { dropped++; continue; }
    inside.push([Math.round(px), Math.round(py)]);
  }

  if (!inside.length) {
    setStatus('Those spots are outside the area we photographed. Tap closer to the house.', 'warn');
    return;
  }
  if (dropped) {
    setStatus(`${dropped} marked area${dropped > 1 ? 's are' : ' is'} outside the photo and will be skipped.`, 'warn');
  }

  busy('Detecting your lawn…');
  $('#btn-detect').disabled = true;

  try {
    const data = await api('/api/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...frame,
        clientId: state.clientId,
        promptPoint: inside,
      }),
    });

    const url = maskUrl(data.mask);
    if (!url) throw new Error('The detector returned no mask. Try drawing it by hand.');

    // data.frame is authoritative: the server clamps zoom and size, so the
    // frame we sent is not necessarily the frame that was rendered.
    const rendered = data.frame || frame;
    const image = await loadMask(url);
    const scale = { w: image.width, h: image.height };

    const polygons = maskToPolygons(image, (x, y) =>
      framePxToLngLat(rendered, [x, y], scale.w, scale.h)
    );

    if (!polygons.length) {
      setStatus('Nothing recognisable there. Try tapping a clearer patch of grass, or draw it by hand.', 'warn');
      return;
    }

    draw.deleteAll();
    for (const geometry of polygons) {
      draw.add({ type: 'Feature', properties: {}, geometry });
    }

    // Re-running with the same prompt point returns the same mask, so keep
    // the button from quietly charging for a duplicate. "Clear shapes" re-arms
    // the picker for a genuine second attempt somewhere else.
    state.detected = true;
    state.lastMask = { url, frame: rendered };
    if ($('#toggle-overlay').checked) showOverlay();

    refreshMeasurement();
    refreshSurveyed();
    updateSelectionButtons();
    disarmLawnPicker();
    setHint('Drag the white dots to correct the shape');

    const mpp = metresPerPixel(rendered, scale.w);
    setStatus(
      `Detected ${polygons.length} area${polygons.length > 1 ? 's' : ''} at ` +
      `${(mpp * 100).toFixed(0)}cm per pixel. Correct anything it got wrong.` +
      (typeof data.remaining === 'number' ? ` ${data.remaining} detections left today.` : '')
    );
  } catch (err) {
    if (err.status === 429) {
      const b = err.body || {};
      setStatus(
        b.reason === 'shared-network'
          ? "Your network has hit today's detection limit. You can still draw the lawn by hand."
          : "You've used today's detections. You can still draw the lawn by hand.",
        'warn'
      );
    } else {
      setStatus(`${err.message} — you can still draw the lawn by hand.`, 'error');
    }
  } finally {
    idle();
    updatePromptHint();
    refreshQuota();
  }
}

/**
 * Replicate's output shape varies between model versions -- sometimes a bare
 * URL, sometimes an array, sometimes an object of named masks. Rather than
 * pin one shape, dig for the first thing that looks like a URL.
 */
function maskUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') return output.startsWith('http') ? output : null;
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = maskUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof output === 'object') {
    for (const key of ['combined_mask', 'mask', 'output', 'image', 'individual_masks']) {
      const found = maskUrl(output[key]);
      if (found) return found;
    }
  }
  return null;
}

/** Fetch the mask through our own origin so the canvas stays readable. */
function loadMask(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      try {
        resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
      } catch (e) {
        reject(new Error(`Could not read the mask image (${e.message})`));
      }
    };
    img.onerror = () => reject(new Error('Could not load the mask image'));
    img.src = `/api/mask?url=${encodeURIComponent(url)}`;
  });
}

/* ---------------------------------------------------------- mask overlay */

/**
 * Draws the raw mask, georeferenced, on top of the satellite basemap. If the
 * projection maths in mercator.js is right the mask sits exactly over the
 * grass it traced; if it is wrong, the misalignment is obvious at a glance.
 * Cheap insurance against the one assumption this app cannot verify offline.
 */
function showOverlay() {
  if (!state.lastMask) return;
  hideOverlay();
  map.addSource('mask-overlay', {
    type: 'image',
    url: `/api/mask?url=${encodeURIComponent(state.lastMask.url)}`,
    coordinates: frameCorners(state.lastMask.frame),
  });
  map.addLayer({
    id: 'mask-overlay', type: 'raster', source: 'mask-overlay',
    paint: { 'raster-opacity': 0.45 },
  }, 'parcel-fill');
}

function hideOverlay() {
  if (map.getLayer('mask-overlay')) map.removeLayer('mask-overlay');
  if (map.getSource('mask-overlay')) map.removeSource('mask-overlay');
}

/* ------------------------------------------------------------ edge tools */

/**
 * Extending a boundary out to the road.
 *
 * A recorded parcel often stops at the right-of-way easement, several feet
 * short of the kerb, while the homeowner mows the whole way. Dragging the two
 * corners by hand fixes the size and ruins the shape: the frontage ends up
 * slightly skewed off the surveyed bearing, and every later measurement
 * inherits that error.
 *
 * So the user picks an edge and slides it outward instead. edges.js keeps it
 * exactly parallel and slides the neighbouring corners along their own lines,
 * so every bearing the county recorded survives untouched.
 */

function outerRing(feature) {
  return feature?.geometry?.type === 'Polygon' ? feature.geometry.coordinates[0] : null;
}

function enterEdgeMode() {
  const features = draw.getAll().features.filter((f) => outerRing(f));
  if (!features.length) {
    setStatus('Draw or detect a lawn first, then you can extend an edge to the road.', 'warn');
    return;
  }

  state.edgeEdit = { featureId: null, edgeIndex: null, baseRing: null };
  $('#edge-panel').hidden = false;
  $('#edge-controls').hidden = true;
  $('#edge-info').textContent = 'Tap the edge of your lawn nearest the road.';
  $('#edge-info').className = 'edge-info';
  setHint('Tap an edge to select it');
  armLawnPicker(); // same tap plumbing; handleMapPoint routes to edge select
}

function exitEdgeMode() {
  state.edgeEdit = null;
  $('#edge-panel').hidden = true;
  clearEdgeHighlight();
  updatePromptHint();
}

/** Find the edge nearest a tap, across every shape, and select it. */
function selectEdgeNear(lngLat) {
  let best = null;
  for (const f of draw.getAll().features) {
    const ring = outerRing(f);
    if (!ring) continue;
    const hit = nearestEdge(ring, lngLat);
    if (hit && (!best || hit.distanceM < best.distanceM)) {
      best = { ...hit, featureId: f.id, ring };
    }
  }

  if (!best || best.distanceM > 40) {
    $('#edge-info').textContent = 'No edge near there — tap closer to a boundary line.';
    return;
  }

  state.edgeEdit = {
    featureId: best.featureId,
    edgeIndex: best.index,
    // The slider is absolute, so every offset is measured from the shape as
    // it was when the edge was picked rather than compounding.
    baseRing: best.ring.map((p) => [...p]),
  };

  const slider = $('#edge-slider');
  slider.value = '0';
  $('#edge-controls').hidden = false;
  $('#edge-info').textContent = `Edge selected — ${Math.round(metresToFeet(edgeLength(best.ring, best.index)))} ft long.`;
  $('#edge-info').className = 'edge-info active';
  $('#edge-bearing').textContent = `bearing ${Math.round(edgeBearing(best.ring, best.index))}\u00b0 — kept exactly`;
  $('#edge-value').textContent = '0 ft';
  setHint('Slide to extend, or tap a different edge');
  drawEdgeHighlight();
}

function applyEdgeOffset(feet) {
  const edit = state.edgeEdit;
  if (!edit?.baseRing) return;

  const feature = draw.get(edit.featureId);
  if (!feature) return;

  const ring = offsetEdge(edit.baseRing, edit.edgeIndex, feetToMetres(feet));
  feature.geometry.coordinates = [ring, ...feature.geometry.coordinates.slice(1)];
  draw.add(feature); // same id: this updates in place

  $('#edge-value').textContent = `${feet > 0 ? '+' : ''}${feet} ft`;
  drawEdgeHighlight();
  refreshMeasurement();
  refreshSurveyed();
}

function currentEdgeRing() {
  const edit = state.edgeEdit;
  if (!edit?.featureId) return null;
  return outerRing(draw.get(edit.featureId));
}

function drawEdgeHighlight() {
  const ring = currentEdgeRing();
  const edit = state.edgeEdit;
  if (!ring || edit.edgeIndex == null) return clearEdgeHighlight();

  const n = ring.length - 1;
  const a = ring[edit.edgeIndex % n];
  const b = ring[(edit.edgeIndex + 1) % n];
  map.getSource('edge-highlight').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [a, b] },
  });
}

function clearEdgeHighlight() {
  map.getSource('edge-highlight')?.setData({ type: 'FeatureCollection', features: [] });
}

/**
 * Mark the corners that still come straight from the county record.
 *
 * Once an edge is pushed out, its two corners are the app's estimate rather
 * than the survey's, and the dots disappear from them. That keeps the map
 * honest about which parts of the outline are authoritative -- and it is
 * recomputed by comparing against the original parcel vertices, so no
 * bookkeeping can drift out of step with the actual shape.
 */
function refreshSurveyed() {
  if (!map.getSource('surveyed')) return;
  if (!state.surveyed?.length) {
    map.getSource('surveyed').setData(empty());
    return;
  }

  const live = [];
  for (const f of draw.getAll().features) {
    const ring = outerRing(f);
    if (ring) live.push(...ring);
  }

  // ~0.3 m: tighter than any real edit, looser than floating-point noise.
  const TOL = 3e-6;
  const stillSurveyed = state.surveyed.filter((s) =>
    live.some((p) => Math.abs(p[0] - s[0]) < TOL && Math.abs(p[1] - s[1]) < TOL)
  );

  map.getSource('surveyed').setData({
    type: 'FeatureCollection',
    features: stillSurveyed.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: p },
      properties: {},
    })),
  });
}

/** Seed an editable shape from the parcel boundary. */
function useParcelShape() {
  const ring = outerRing(state.parcel) ||
    (state.parcel?.geometry?.type === 'MultiPolygon' ? state.parcel.geometry.coordinates[0][0] : null);
  if (!ring) return;

  draw.add({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring.map((p) => [...p])] },
  });
  refreshMeasurement();
  refreshSurveyed();
  setStatus('Started from your property line. Trim the house and driveway out, or extend an edge to the road.');
}

/* ----------------------------------------------------------- measurement */

function refreshMeasurement() {
  const fc = draw.getAll();
  const hasShapes = fc.features.length > 0;
  $('#result').hidden = !hasShapes;
  if (!hasShapes) return;

  const m = measure(fc);
  const patches = fc.features.length;

  $('#result-sqft').textContent = m.squareFeet.toLocaleString();
  $('#result-sub').textContent =
    `${m.thousandSqFt.toFixed(2)}k sq ft · ${m.acres} acres` +
    (patches > 1 ? ` · ${patches} areas` : '');

  $('#print-sqft').textContent = m.squareFeet.toLocaleString();
  $('#print-address').textContent = state.chosen?.label || '';
  $('#print-detail').textContent =
    `${m.acres} acres · ${m.thousandSqFt.toFixed(2)} thousand sq ft` +
    (state.parcel ? ` · parcel from ${state.parcel.properties.county}` : '');
}

function updateSelectionButtons() {
  let selected = 0;
  try {
    selected = draw.getSelected().features.length;
  } catch {
    selected = 0;
  }
  // Phones have no Delete key, so removing a patch you do not mow needs a
  // button; without one, a wrongly detected shape could not be removed at all.
  $('#btn-delete').disabled = selected === 0;
}

/* ---------------------------------------------------------------- quota */

async function refreshQuota() {
  try {
    state.quota = await api(`/api/quota?clientId=${encodeURIComponent(state.clientId)}`);
    const left = Math.max(0, state.quota.limit - state.quota.used);
    const badge = $('#quota-badge');
    badge.textContent = `${left} of ${state.quota.limit} detections left today`;
    badge.hidden = false;
  } catch {
    // A quota read failing is not worth interrupting anyone over.
  }
}

/* --------------------------------------------------------------- exports */

/** Composite the map canvas with a caption bar into a downloadable PNG. */
function exportPng() {
  const src = map.getCanvas();
  const barH = 84;
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height + barH;
  const ctx = canvas.getContext('2d');

  ctx.drawImage(src, 0, 0);

  ctx.fillStyle = '#16211a';
  ctx.fillRect(0, src.height, canvas.width, barH);

  const m = measure(draw.getAll());
  const scale = src.width / 900;
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(30 * scale)}px system-ui, sans-serif`;
  ctx.fillText(`${m.squareFeet.toLocaleString()} sq ft`, 22 * scale, src.height + 38 * scale);
  ctx.fillStyle = '#b9c9bd';
  ctx.font = `${Math.round(16 * scale)}px system-ui, sans-serif`;
  ctx.fillText(
    `${state.chosen?.label || ''} · ${m.acres} acres · estimate, not a survey`,
    22 * scale,
    src.height + 64 * scale
  );

  const link = document.createElement('a');
  link.download = 'lawn-measurement.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

/* ------------------------------------------------------------------ wiring */

function reset() {
  draw.deleteAll();
  hideOverlay();
  disarmLawnPicker();
  map.getSource('parcel').setData(empty());
  state.marker?.remove();
  clearPromptPoints();
  state.chosen = state.parcel = state.frame = null;
  state.lastMask = null;
  state.detected = false;
  state.edgeEdit = null;
  state.surveyed = [];
  $('#result').hidden = true;
  $('#toggle-overlay').checked = false;
  setStatus('');
  setHint('');
  showStep('address');
}

$('#address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  search($('#address').value.trim());
});

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'restart') reset();
  if (action === 'confirm') confirmLocation();
});

$('#btn-detect').addEventListener('click', detect);

$('#btn-draw').addEventListener('click', () => {
  if (state.edgeEdit) exitEdgeMode();
  disarmLawnPicker();
  draw.changeMode('draw_polygon');
  setHint('Click around the edge of your lawn. Click the first point again to finish.');
  setStatus('Drawing by hand. Every shape you add counts toward the total.');
});

$('#btn-clear').addEventListener('click', () => {
  draw.deleteAll();
  clearPromptPoints();
  if (state.edgeEdit) exitEdgeMode();
  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  armLawnPicker();
  setStatus('Cleared. Tap your lawn to detect it again, or draw it by hand.');
});

$('#btn-undo-pin').addEventListener('click', removeLastPromptPoint);

$('#btn-parcel-shape').addEventListener('click', useParcelShape);

$('#btn-edges').addEventListener('click', () => {
  state.edgeEdit ? exitEdgeMode() : enterEdgeMode();
});
$('#btn-edge-done').addEventListener('click', exitEdgeMode);
$('#edge-slider').addEventListener('input', (e) => applyEdgeOffset(Number(e.target.value)));

$('#btn-delete').addEventListener('click', () => {
  const ids = draw.getSelected().features.map((f) => f.id);
  if (!ids.length) return;
  draw.delete(ids);
  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  setStatus('Removed. The total now covers only the shapes still on the map.');
});

$('#btn-png').addEventListener('click', exportPng);
$('#btn-print').addEventListener('click', () => window.print());
$('#toggle-overlay').addEventListener('change', (e) => {
  e.target.checked ? showOverlay() : hideOverlay();
});

initMap()
  .then(refreshQuota)
  .catch((err) => {
    console.error(err);
    fatal(`${err.message}. Reloading the page usually clears this.`);
  });
