/**
 * Lawn Mapper frontend.
 *
 * The flow, and why it is ordered this way:
 *
 *   address -> pick candidate -> CONFIRM ON MAP -> parcel
 *           -> detect grass -> clip to the property line -> edit -> export
 *
 * The confirm step is not decoration. Every step after it is either slow or
 * costs money, and a geocode that lands one street over produces a number
 * that looks entirely credible and is wrong. Making the user look at their
 * own roof first is the cheapest correctness check available.
 */

import { measure } from './lib/area.js';
import { maskToPolygons, rasterizePolygon } from './lib/mask.js';
import {
  offsetEdge, nearestEdge, edgeRun, edgeLength, edgeBearing, openRing,
  nearestVertex, moveVertex, insertVertex, deleteVertex, tidyRing,
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
  quota: null,
};

/**
 * Gaps smaller than this are counted as lawn rather than subtracted.
 *
 * A tree canopy hides grass that is really there; a pool or a shed does not.
 * Size is the only signal an overhead photograph offers, so the line is drawn
 * at roughly a large tree's footprint and what it did is always reported.
 */
const TREE_GAP_SQFT = 900;

/**
 * How closely the traced outline follows the mask, in metres on the ground.
 *
 * 0.3 m was chosen as the point where the measurement stopped changing, which
 * was the wrong thing to optimise. Drawing the same lawn by hand takes about
 * twenty corners in total and looks right, so the outline does not need to be
 * faithful to the mask -- it needs to be faithful to the lawn, and a person
 * with ten corners beats a tracer with ninety.
 *
 * Coarser also loses less than it appears to. Douglas-Peucker cuts inside one
 * bend and outside the next, so the errors are signed and largely cancel:
 * measured on a real lot, 0.8 m moved the total by 2% while removing seven
 * eighths of the handles.
 */
const TRACE_TOLERANCE_M = 0.8;

/**
 * A ceiling on handles per shape.
 *
 * Also a real limiter now, not just a backstop. Holes get half this, so a lawn
 * wrapping a flower bed can still exceed it in total -- which is how a shape
 * came back with 89 points at a tolerance that should have given far fewer.
 */
const MAX_TRACE_VERTICES = 30;

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
const diag = {
  clicks: 0, rejected: 0, lastMode: null, armed: false, viaTouch: 0, viaClick: 0,
  // Dragging a corner has three ways to look identical from outside: the press
  // never found a corner, it found one but the finger never travelled far
  // enough to count, or it moved and the shape barely changed because the
  // neighbouring corners were inches away. Counting them apart is the only way
  // to tell a broken drag from an undramatic one.
  dragGrabbed: 0, dragMoved: 0,
};
if (typeof window !== 'undefined') {
  window.__lm = diag;
  /*
   * Where the corner handles are, in viewport coordinates.
   *
   * A browser test cannot aim at a corner it cannot locate, and reading them
   * off a screenshot would be guesswork. One entry per editable outline, in
   * the order a tap considers them.
   */
  window.__lmPoints = (want = null) => {
    if (!map || !state.edgeEdit) return [];
    const rect = map.getCanvasContainer().getBoundingClientRect();
    return editableRings().map(({ featureId, ring }) => {
      const verts = openRing(ring);

      /*
       * Report the corner whose neighbours are furthest apart, not the first
       * one.
       *
       * Moving a vertex changes the area by half the cross product of
       * (next - prev) with the movement, so a corner whose neighbours sit on
       * top of each other can travel twenty-five metres and change nothing --
       * which is exactly what vertex 0 of a real Ottawa parcel does, its
       * neighbours being 10 cm apart. A test aimed there passes whether the
       * measurement tracks the edit or not.
       */
      let index = 0;
      if (want === null) {
        let widest = -1;
        for (let i = 0; i < verts.length; i++) {
          const prev = verts[(i - 1 + verts.length) % verts.length];
          const next = verts[(i + 1) % verts.length];
          const span = Math.hypot(next[0] - prev[0], next[1] - prev[1]);
          if (span > widest) { widest = span; index = i; }
        }
      } else {
        // Moving a vertex changes its *neighbours'* spans, so "the widest" can
        // name a different corner afterwards. A caller comparing before with
        // after has to be able to ask for the same one twice.
        index = ((want % verts.length) + verts.length) % verts.length;
      }

      const at = map.project(verts[index]);
      return {
        featureId,
        count: verts.length,
        index,
        x: at.x + rect.left,
        y: at.y + rect.top,
        at: verts[index],
        sqft: measure({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } }).squareFeet,
        prev: verts[(index - 1 + verts.length) % verts.length],
        next: verts[(index + 1) % verts.length],
      };
    });
  };
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

async function api(path, options = {}) {
  // Every request gets a deadline. Without one, a Worker holding a connection
  // open leaves the UI stuck on a spinner with nothing to react to -- which is
  // exactly how "Detecting your lawn..." hung forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  let res;
  try {
    res = await fetch(path, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('The server took too long to answer.');
      e.status = 0;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

  // Grab handles for every corner, shown only while the adjust tool is open.
  // Mapbox Draw draws handles for a shape it has selected and never for the
  // parcel, which is not one of its features -- so without these there is
  // nothing to aim at on the property line.
  map.addSource('points', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'points', type: 'circle', source: 'points',
    paint: {
      'circle-radius': ['case', ['==', ['get', 'selected'], 1], 8, 5],
      'circle-color': ['case', ['==', ['get', 'selected'], 1], '#ff6f00', '#ffffff'],
      'circle-stroke-width': 2,
      'circle-stroke-color': ['case', ['==', ['get', 'selected'], 1], '#7a3500', '#2f7d32'],
    },
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

  /*
   * Mapbox Draw moves vertices itself, and reports only after the fact, so the
   * pre-change state has to be captured when the user enters the editing mode.
   * A whole direct_select session collapses into one undo entry -- coarser
   * than per-vertex, and the right grain for "undo what I was just doing".
   */
  map.on('draw.modechange', (e) => {
    if (e.mode === 'direct_select') pushHistory('direct_select');
    else endHistoryGroup();
  });
  map.on('draw.update', endHistoryGroup);

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
      state.surveyed = (parcelRing() || []).map((p) => [...p]);
      $('#btn-parcel-shape').hidden = false;

      const a = measure(state.parcel.geometry);
      setStatus(
        `Found your property line — ${a.acres} acres total ` +
        `(${state.parcel.properties.county}). Press "Detect my lawn".`
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

    updatePromptHint();
    setHint(state.parcel
      ? 'Press "Detect my lawn" — or extend the boundary first if your lawn runs to the road'
      : 'Press "Detect my lawn", or draw it by hand');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    idle();
    refreshQuota();
  }
}

/* ------------------------------------------------------------------ undo */
/**
 * Undo, scoped to the step you are in.
 *
 * The three stages cost different things to redo. A property line is a free
 * lookup; a detection is money and a wait; hand corrections are only your
 * time. So undo never crosses a stage boundary: the history is emptied the
 * moment a detection lands, which makes that trace the floor. Pressing undo
 * enough times returns you to the shape the model produced and stops there,
 * and getting a different trace stays an explicit, separate decision.
 *
 * Snapshots rather than inverse operations. The state that matters is small --
 * a handful of polygons -- and a snapshot cannot drift out of step with the
 * thing it claims to reverse, which is the usual way undo goes wrong.
 */
const MAX_HISTORY = 30;
let history = [];

function snapshot() {
  return {
    features: JSON.parse(JSON.stringify(draw.getAll().features)),
    parcel: state.parcel ? JSON.parse(JSON.stringify(state.parcel.geometry)) : null,
  };
}

/**
 * Record the state as it is now, before the caller changes it.
 *
 * Call this once per *interaction*, not once per change: a slider drag fires
 * a hundred times and is one thing the user did. `key` collapses a run of
 * changes into a single entry -- passing the same key again while that
 * interaction is still current adds nothing.
 */
let historyKey = null;
function pushHistory(key = null) {
  if (key !== null && key === historyKey) return;
  historyKey = key;
  history.push(snapshot());
  if (history.length > MAX_HISTORY) history.shift();
  updateUndoButton();
}

/** End the current interaction, so the next one starts a new undo entry. */
const endHistoryGroup = () => { historyKey = null; };

function clearHistory() {
  history = [];
  historyKey = null;
  updateUndoButton();
}

function undo() {
  const prev = history.pop();
  if (!prev) return;
  historyKey = null;

  draw.deleteAll();
  for (const f of prev.features) draw.add(f);

  // Restoring the parcel has to go through setParcelRing: extending a boundary
  // widened the photograph's frame, so undoing it has to narrow it back or the
  // next detection would still be framed for a boundary that no longer exists.
  if (prev.parcel && state.parcel) {
    const ring = prev.parcel.type === 'Polygon'
      ? prev.parcel.coordinates[0]
      : prev.parcel.coordinates[0][0];
    setParcelRing(ring);
  }

  if (state.edgeEdit) {
    state.edgeEdit = { featureId: null, edgeIndex: null, vertexIndex: null, baseRing: null };
    $('#edge-controls').hidden = true;
    $('#point-controls').hidden = true;
    clearEdgeHighlight();
  }

  drawPoints();
  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  updateUndoButton();
  setStatus(history.length
    ? 'Undone.'
    : 'Undone — back to where this step started.');
}

function updateUndoButton() {
  const btn = $('#btn-undo');
  if (btn) btn.disabled = history.length === 0;
}

/* --------------------------------------------------------- map interaction */

/**
 * The map is tapped for two things now: choosing a boundary to extend, and
 * grabbing one of its corners.
 *
 * Detection used to need a pin in every separate patch of lawn, because the
 * model could only segment what it was pointed at. Asking for "grass" finds
 * all of them at once, including the ones a person would forget, so the taps
 * went away and the plumbing stayed.
 */
function armLawnPicker() {
  diag.armed = true;
  map.getCanvas().style.cursor = 'crosshair';
  map.on('click', onMapClick);
  const el = map.getCanvasContainer();
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  // Not passive: dragging a corner has to stop the map panning under it, and
  // preventDefault is the only way to say so.
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  el.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function disarmLawnPicker() {
  diag.armed = false;
  endDrag();
  map.getCanvas().style.cursor = '';
  map.off('click', onMapClick);
  const el = map.getCanvasContainer();
  el.removeEventListener('touchstart', onTouchStart);
  el.removeEventListener('touchmove', onTouchMove);
  el.removeEventListener('touchend', onTouchEnd);
  el.removeEventListener('mousedown', onMouseDown);
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
}

/* ---------------------------------------------------- dragging a corner */
/*
 * Tapping a corner selects it; pressing on one and moving drags it. Both come
 * through the same press, so the drag only begins once the finger has actually
 * travelled -- otherwise every tap would register as a zero-length drag and
 * the distinction between "select this" and "move this" would vanish.
 *
 * While a drag is live the map must not pan: on a phone the gesture is
 * identical, and without this the whole map slides away under the finger.
 */
let drag = null;
const DRAG_START_PX = 4;

/** The corner under a screen position, if a tap there would grab one. */
function vertexAt(clientX, clientY) {
  if (!state.edgeEdit) return null;
  const rect = map.getCanvasContainer().getBoundingClientRect();
  const at = { x: clientX - rect.left, y: clientY - rect.top };

  // Only corners that are actually drawn can be grabbed. Grabbing an invisible
  // one would be indistinguishable from the map moving on its own.
  let found = null;
  for (const { featureId, ring } of handleRings()) {
    openRing(ring).forEach((p, i) => {
      const px = map.project(p);
      const d = Math.hypot(px.x - at.x, px.y - at.y);
      if (d <= VERTEX_GRAB_PX && (!found || d < found.d)) {
        found = { featureId, ring, index: i, d };
      }
    });
  }
  return found;
}

function beginDrag(clientX, clientY) {
  const hit = vertexAt(clientX, clientY);
  if (!hit) return false;
  drag = { ...hit, startX: clientX, startY: clientY, moved: false };
  diag.dragGrabbed++;
  return true;
}

function updateDrag(clientX, clientY) {
  if (!drag) return false;
  if (!drag.moved) {
    if (Math.hypot(clientX - drag.startX, clientY - drag.startY) < DRAG_START_PX) return false;
    drag.moved = true;
    diag.dragMoved++;
    pushHistory('drag');
    // Select it on the first real movement, so the panel shows what is moving.
    selectVertex({ featureId: drag.featureId, ring: drag.ring, index: drag.index });
    map.dragPan.disable();
  }

  const rect = map.getCanvasContainer().getBoundingClientRect();
  const lngLat = map.unproject([clientX - rect.left, clientY - rect.top]);
  moveSelectedVertex([lngLat.lng, lngLat.lat]);
  return true;
}

/** Finish a drag. Returns true if a corner actually moved. */
function endDrag() {
  const moved = Boolean(drag?.moved);
  if (moved) {
    endHistoryGroup();
    map.dragPan.enable();
    setStatus('Corner moved.');
  }
  drag = null;
  return moved;
}

function onMouseDown(e) {
  if (e.button === 0) beginDrag(e.clientX, e.clientY);
}

function onMouseMove(e) {
  if (updateDrag(e.clientX, e.clientY)) e.preventDefault();
}

function onMouseUp() {
  // A click follows a mouseup. Suppress it after a real drag so releasing the
  // finger does not immediately re-select whatever is under it.
  if (endDrag()) handled = { at: Date.now(), x: null, y: null };
}

function onTouchMove(e) {
  if (e.touches.length !== 1) return;
  if (updateDrag(e.touches[0].clientX, e.touches[0].clientY)) e.preventDefault();
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
 * a touch we just handled -- position as well as time.
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
  if (touchStart) beginDrag(touchStart.x, touchStart.y);
}

function onTouchEnd(e) {
  const start = touchStart;
  touchStart = null;

  // A finished drag is not also a tap: the corner has already moved, and
  // re-selecting under the finger would fight the thing the user just did.
  if (endDrag()) return;
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
  // suppress when both positions are known -- treating "position unknown" as
  // "same position" would swallow legitimate taps.
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

  if (state.edgeEdit) selectNear([lngLat.lng, lngLat.lat]);
}

/** Detection needs only a frame; there is nothing for the user to place. */
function updatePromptHint() {
  const ready = !!state.frame && !state.detected;
  $('#btn-detect').disabled = !ready;
  $('#btn-detect').textContent = state.detected ? 'Lawn detected' : 'Detect my lawn';
}

/* ------------------------------------------------------------- detection */

async function detect() {
  if (!state.frame) return;

  const frame = state.frame;

  busy('Detecting your lawn…');
  $('#btn-detect').disabled = true;

  try {
    let data = await api('/api/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...frame, clientId: state.clientId }),
      // Replicate holds the connection for about a minute before answering.
      timeoutMs: 90000,
    });

    // A cold model takes longer than Replicate will hold the connection, so
    // the server hands back an id instead of a mask and we wait it out here.
    if (data.pending && data.id) data = await waitForPrediction(data.id, data.frame || frame);

    const url = maskUrl(data.mask);
    if (!url) throw new Error('The detector returned no mask. Try drawing it by hand.');

    // data.frame is authoritative: the server clamps zoom and size, so the
    // frame we sent is not necessarily the frame that was rendered.
    const rendered = data.frame || frame;
    const image = await loadMask(url);
    const w = image.width;
    const h = image.height;

    /*
     * Clip to the property line before measuring anything.
     *
     * Asking for "grass" finds every lawn in the photograph, the neighbours'
     * included -- on a real lot that was 3,700 sq ft of someone else's grass,
     * a third of everything detected. Painting the parcel into the same pixel
     * grid and intersecting is exact for any parcel shape and needs no
     * polygon-boolean library.
     */
    const ring = parcelRing();
    const clipMask = ring
      ? rasterizePolygon(
          state.parcel.geometry.type === 'Polygon'
            ? state.parcel.geometry.coordinates
            : state.parcel.geometry.coordinates[0],
          w, h,
          (ll) => lngLatToFramePx(rendered, ll, w, h)
        )
      : null;

    // Canopy gaps, in pixels, from the frame's own ground resolution.
    const sqFtPerPx = (metresPerPixel(rendered, w) ** 2) / 0.09290304;
    const fillGapsUnderPx = $('#toggle-trees').checked
      ? Math.round(TREE_GAP_SQFT / sqFtPerPx)
      : 0;

    /*
     * How finely to trace the outline, in metres on the ground rather than in
     * pixels.
     *
     * The default was 1.5 px, which sounds conservative and is not: at this
     * frame's resolution it is about 5 cm, finer than a lawn edge is knowable
     * and far finer than anyone can aim at. It produced 308 handles on a real
     * lot -- a necklace of dots with the boundary somewhere underneath, which
     * is not an editing surface. Expressing it in metres also makes it mean
     * the same thing at every zoom, which a pixel count does not.
     *
     * Measured on that lot, against the 3,636 sq ft the fine trace gave:
     *
     *   0.15 m   140 vertices   +0.03%
     *   0.3 m     78 vertices   -0.77%
     *   0.5 m     55 vertices   -1.54%
     *
     * 0.3 m is where the curve turns: a quarter of the handles for under one
     * percent, on a figure the app already labels an estimate rather than a
     * survey. Below that, precision nobody can use costs handles everybody
     * has to look at.
     */
    const tolerance = TRACE_TOLERANCE_M / metresPerPixel(rendered, w);

    const polygons = maskToPolygons(
      image,
      (x, y) => framePxToLngLat(rendered, [x, y], w, h),
      { clipMask, fillGapsUnderPx, tolerance, maxVertices: MAX_TRACE_VERTICES }
    );

    if (!polygons.length) {
      setStatus(
        ring
          ? 'No grass found inside your property line. Draw the lawn by hand, or extend the boundary if it stops short of the road.'
          : 'No grass found in that view. Draw the lawn by hand.',
        'warn'
      );
      return;
    }

    draw.deleteAll();
    for (const geometry of polygons) {
      draw.add({ type: 'Feature', properties: {}, geometry });
    }

    // Re-running with the same prompt point returns the same mask, so keep
    // the button from quietly charging for a duplicate. "Clear shapes" re-arms
    // the picker for a genuine second attempt somewhere else.
    /*
     * The trace is where this step begins, so nothing before it is reachable
     * by undo. Redoing a detection costs money and a wait; making that an
     * explicit choice rather than one press too many is the whole point of
     * scoping undo to a stage.
     */
    clearHistory();

    state.detected = true;
    state.lastMask = { url, frame: rendered };
    if ($('#toggle-overlay').checked) showOverlay();

    refreshMeasurement();
    refreshSurveyed();
    updateSelectionButtons();
    setHint('Drag the white dots to correct the shape');

    const gaps = polygons.filledGaps
      ? ` ${polygons.filledGaps} gap${polygons.filledGaps > 1 ? 's' : ''} counted as grass under trees` +
        ` (about ${Math.round(polygons.filledGapPx * sqFtPerPx).toLocaleString()} sq ft) —` +
        ' untick the box below if any of those is a pool or a shed.'
      : '';

    setStatus(
      `Found ${polygons.length} section${polygons.length > 1 ? 's' : ''} of lawn` +
      (ring ? ', trimmed to your property line' : '') + '.' + gaps +
      ' Correct anything it got wrong.'
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
 * Wait out a prediction that outlived the server's hold on the connection.
 *
 * The first run of the day is the slow one -- the model has to be loaded onto
 * a GPU before it can look at anything. Saying so beats a silent spinner.
 */
async function waitForPrediction(id, frame) {
  const started = Date.now();
  const DEADLINE_MS = 4 * 60 * 1000;

  while (Date.now() - started < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 2500));

    const secs = Math.round((Date.now() - started) / 1000);
    busy(secs < 25
      ? 'Detecting your lawn…'
      : `Still working — the AI is warming up (${secs}s)`);

    let p;
    try {
      p = await api(`/api/prediction?id=${encodeURIComponent(id)}`);
    } catch {
      continue; // a dropped poll is not a failed prediction
    }

    if (p.status === 'succeeded') return { ...p, frame };
    if (p.status === 'failed' || p.status === 'canceled') {
      throw new Error(p.detail || `The detector ${p.status}.`);
    }
  }

  throw new Error('The detector is taking unusually long. Draw the lawn by hand for now.');
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

/**
 * The parcel outline is editable too, and deliberately before detection.
 *
 * Where a sidewalk sits between the recorded line and the kerb, the lawn on
 * the far side exists only outside the parcel. The frame sent to SAM is built
 * from the parcel's extent, so that strip is not even in the photograph unless
 * the boundary is pushed out first -- and a pin dropped there would be
 * discarded as outside the frame.
 */
const PARCEL_ID = '__parcel__';

function enterEdgeMode() {
  const hasShape = draw.getAll().features.some((f) => outerRing(f));
  if (!hasShape && !state.parcel) {
    setStatus('Find a property first, or draw a lawn, then you can extend an edge to the road.', 'warn');
    return;
  }

  state.edgeEdit = { featureId: null, edgeIndex: null, vertexIndex: null, baseRing: null };
  $('#edge-panel').hidden = false;
  $('#edge-controls').hidden = true;
  $('#point-controls').hidden = true;
  $('#edge-info').textContent = hasShape
    ? 'Tap a line to extend that edge, or a corner dot to move, add or delete it.'
    : 'Tap the property line nearest the road. Extend it first if your lawn runs past it.';
  $('#edge-info').className = 'edge-info';
  setHint('Tap a line to extend it, or a corner to move it');
  armLawnPicker(); // same tap plumbing; handleMapPoint routes the tap
  drawPoints();    // the corners have to be visible to be aimed at
}

function exitEdgeMode() {
  state.edgeEdit = null;
  $('#edge-panel').hidden = true;
  $('#point-controls').hidden = true;
  clearEdgeHighlight();
  clearPoints();
  disarmLawnPicker();
  updatePromptHint();
}

/** Every editable outline, in the order a tap should consider them. */
function editableRings() {
  const rings = draw.getAll().features
    .map((f) => ({ featureId: f.id, ring: outerRing(f) }))
    .filter((r) => r.ring);
  const parcel = parcelRing();
  if (parcel) rings.push({ featureId: PARCEL_ID, ring: parcel });
  return rings;
}

/**
 * How near a tap must land on a corner to grab the corner rather than the
 * edge, in screen pixels.
 *
 * Deliberately tighter than a fingertip. Extending an edge is the common
 * operation and the one that preserves the survey's bearings, so it wins every
 * ambiguous tap; grabbing a point is something you have to mean. Widening this
 * would quietly make the careful tool the harder one to reach.
 */
const VERTEX_GRAB_PX = 16;

/**
 * Route a tap to a corner or an edge.
 *
 * Distance to an edge goes to zero at its endpoints, so comparing the two in
 * metres would always favour the edge and never select a point. The decision
 * is made in screen pixels instead, which is also the space the user is
 * actually aiming in.
 */
function selectNear(lngLat) {
  const tap = map.project(lngLat);
  let corner = null;

  for (const { featureId, ring } of handleRings()) {
    const hit = nearestVertex(ring, lngLat);
    if (!hit) continue;
    const at = map.project(openRing(ring)[hit.index]);
    const px = Math.hypot(at.x - tap.x, at.y - tap.y);
    if (px <= VERTEX_GRAB_PX && (!corner || px < corner.px)) {
      corner = { featureId, ring, index: hit.index, px };
    }
  }

  if (corner) selectVertex(corner);
  else selectEdgeNear(lngLat);
}

/** Find the edge nearest a tap, across every shape, and select it. */
function selectEdgeNear(lngLat) {
  let best = null;

  const consider = (ring, featureId) => {
    if (!ring) return;
    const hit = nearestEdge(ring, lngLat);
    if (hit && (!best || hit.distanceM < best.distanceM)) {
      best = { ...hit, featureId, ring };
    }
  };

  for (const { featureId, ring } of editableRings()) consider(ring, featureId);

  if (!best || best.distanceM > 40) {
    $('#edge-info').textContent = 'No edge near there — tap closer to a boundary line.';
    return;
  }

  state.edgeEdit = {
    // Where the tap landed, so "Add a point" knows where to put one.
    tapAt: [lngLat[0], lngLat[1]],
    featureId: best.featureId,
    edgeIndex: best.index,
    // The slider is absolute, so every offset is measured from the shape as
    // it was when the edge was picked rather than compounding.
    baseRing: best.ring.map((p) => [...p]),
  };

  // A surveyed boundary is usually digitised as a run of nearly-collinear
  // segments; the user thinks of it as one line and it moves as one.
  const run = edgeRun(best.ring, best.index);
  const n = openRing(best.ring).length;
  let runFeet = 0;
  for (let k = 0; k < run.count; k++) runFeet += metresToFeet(edgeLength(best.ring, (run.start + k) % n));

  const slider = $('#edge-slider');
  slider.value = '0';
  $('#edge-controls').hidden = false;
  $('#edge-info').textContent =
    (best.featureId === PARCEL_ID ? 'Property line' : 'Lawn edge') +
    ` selected — ${Math.round(runFeet)} ft long` +
    (run.count > 1 ? ` (${run.count} segments, moving together).` : '.');
  $('#edge-info').className = 'edge-info active';
  $('#edge-bearing').textContent = `bearing ${Math.round(edgeBearing(best.ring, best.index))}\u00b0 — kept exactly`;
  $('#edge-value').textContent = '0 ft';
  $('#point-controls').hidden = true;
  setHint('Slide to extend, drag a corner to move it, or tap another edge');
  drawEdgeHighlight();
  drawPoints();
}

/* ------------------------------------------------------ editing corners */
/**
 * Selecting a corner rather than an edge.
 *
 * Extending keeps the recorded bearings and is the right tool for a frontage.
 * It is the wrong one for a corner the county digitised badly, or for the runs
 * of three points a foot apart that make a boundary fiddly to work with --
 * hence moving, adding and deleting individual points.
 */
function selectVertex({ featureId, ring, index }) {
  state.edgeEdit = {
    featureId,
    vertexIndex: index,
    edgeIndex: null,
    baseRing: ring.map((p) => [...p]),
  };

  $('#edge-controls').hidden = true;
  $('#point-controls').hidden = false;
  $('#edge-info').textContent =
    `Corner ${index + 1} of ${openRing(ring).length} on your ` +
    (featureId === PARCEL_ID ? 'property line' : 'lawn outline') +
    ' — drag it to move it.';
  $('#edge-info').className = 'edge-info active';

  // Three points are a polygon; two are nothing. Say so on the button rather
  // than letting the press fail.
  const canDelete = openRing(ring).length > 3;
  $('#btn-point-delete').disabled = !canDelete;

  setHint('Drag this corner, or delete it');
  clearEdgeHighlight();
  drawPoints();
}

/** The ring of whatever shape is being edited, read fresh. */
function ringOf(featureId) {
  if (featureId === PARCEL_ID) return parcelRing();
  return outerRing(draw.get(featureId));
}

/** Write a ring back to whichever kind of shape it came from. */
function writeRing(featureId, ring) {
  if (featureId === PARCEL_ID) {
    setParcelRing(ring);
    return true;
  }
  const feature = draw.get(featureId);
  if (!feature) return false;
  feature.geometry.coordinates = [ring, ...feature.geometry.coordinates.slice(1)];
  draw.add(feature); // same id: this updates in place
  return true;
}

/** Move the selected corner. Called continuously during a drag. */
function moveSelectedVertex(lngLat) {
  const edit = state.edgeEdit;
  if (!edit || edit.vertexIndex == null) return;

  const ring = ringOf(edit.featureId);
  if (!ring) return;

  writeRing(edit.featureId, moveVertex(ring, edit.vertexIndex, lngLat));
  drawPoints();
  refreshMeasurement();
  refreshSurveyed();
}

/** Add a corner where the user tapped on the selected edge. */
function addPointOnEdge() {
  const edit = state.edgeEdit;
  if (!edit || edit.edgeIndex == null || !edit.tapAt) return;

  const ring = ringOf(edit.featureId);
  if (!ring) return;

  pushHistory();
  const grown = insertVertex(ring, edit.edgeIndex, edit.tapAt);
  if (!writeRing(edit.featureId, grown)) return;

  // Select it straight away: adding a point is nearly always the first half of
  // moving it somewhere.
  selectVertex({ featureId: edit.featureId, ring: grown, index: edit.edgeIndex + 1 });
  setStatus('Corner added on the line. Drag it where you want it.');
  refreshMeasurement();
  refreshSurveyed();
}

/** Remove the selected corner. */
function deleteSelectedVertex() {
  const edit = state.edgeEdit;
  if (!edit || edit.vertexIndex == null) return;

  const ring = ringOf(edit.featureId);
  if (!ring) return;

  const shrunk = deleteVertex(ring, edit.vertexIndex);
  if (!shrunk) {
    setStatus('That shape is down to three corners — deleting another would leave no shape at all.', 'warn');
    return;
  }

  pushHistory();
  writeRing(edit.featureId, shrunk);
  state.edgeEdit = { featureId: null, vertexIndex: null, edgeIndex: null, baseRing: null };
  $('#point-controls').hidden = true;
  $('#edge-info').textContent = 'Corner deleted. Tap another corner or edge.';
  $('#edge-info').className = 'edge-info';
  drawPoints();
  refreshMeasurement();
  refreshSurveyed();
}

/**
 * Drop the corners that carry no shape, across every outline being edited.
 *
 * A county boundary is digitised rather than drawn, and comes with runs of
 * points a few centimetres apart -- 61 vertices on the parcel this was built
 * against, one pair 10 cm from each other. Deleting them one at a time works
 * and is tedious, which is the clunkiness this answers.
 *
 * It reports what it did, including when it did nothing: a tool that silently
 * changes a boundary is worse than one that says it found nothing to change.
 */
function tidyShapes() {
  let removed = 0;
  let before = 0;

  pushHistory();
  for (const { featureId, ring } of editableRings()) {
    before += openRing(ring).length;
    const tidied = tidyRing(ring);
    if (tidied.removed) {
      writeRing(featureId, tidied.ring);
      removed += tidied.removed;
    }
  }

  if (!removed) {
    setStatus('Nothing to tidy — every corner on this boundary is doing something.');
    return;
  }

  // The selection indexes into a ring that just changed shape, so it no longer
  // means what it meant. Drop it rather than let it point at another corner.
  state.edgeEdit = { featureId: null, edgeIndex: null, vertexIndex: null, baseRing: null };
  $('#edge-controls').hidden = true;
  $('#point-controls').hidden = true;
  $('#edge-info').textContent =
    `Removed ${removed} redundant corner${removed === 1 ? '' : 's'} of ${before}. ` +
    'The boundary is unchanged — they were sitting on top of each other.';
  $('#edge-info').className = 'edge-info';

  clearEdgeHighlight();
  drawPoints();
  refreshMeasurement();
  refreshSurveyed();
}

/**
 * Draw every corner of every editable outline, with the selected one picked
 * out.
 *
 * Mapbox Draw shows handles only for a shape it has selected, and never for
 * the parcel, which is not one of its features at all. Without these the
 * corners are invisible and there is nothing to aim at.
 */
/**
 * The outlines whose corners get handles.
 *
 * Only the shape being worked on. Showing every corner of every shape at once
 * put over a thousand handles on the map, which is not an editing surface --
 * it is a wall of dots with the boundary somewhere underneath. A tap on a line
 * selects a shape and reveals its corners; until then there is nothing to aim
 * at but the lines themselves, which is the correct number of things to think
 * about.
 */
function handleRings() {
  const edit = state.edgeEdit;
  if (!edit?.featureId) return [];
  return editableRings().filter((r) => r.featureId === edit.featureId);
}

function drawPoints() {
  if (!map.getSource('points')) return;
  const edit = state.edgeEdit;
  if (!edit) return map.getSource('points').setData(empty());

  const features = [];
  for (const { featureId, ring } of handleRings()) {
    openRing(ring).forEach((p, i) => {
      features.push({
        type: 'Feature',
        properties: {
          selected: featureId === edit.featureId && i === edit.vertexIndex ? 1 : 0,
        },
        geometry: { type: 'Point', coordinates: p },
      });
    });
  }
  map.getSource('points').setData({ type: 'FeatureCollection', features });
}

function clearPoints() {
  map.getSource('points')?.setData(empty());
}

function applyEdgeOffset(feet) {
  const edit = state.edgeEdit;
  if (!edit?.baseRing) return;

  // The slider is absolute, so every event re-derives the shape from baseRing.
  // One entry for the whole drag, keyed on the edge being moved.
  pushHistory(`offset:${edit.featureId}:${edit.edgeIndex}`);

  const ring = offsetEdge(edit.baseRing, edit.edgeIndex, feetToMetres(feet));

  if (edit.featureId === PARCEL_ID) {
    setParcelRing(ring);
  } else {
    const feature = draw.get(edit.featureId);
    if (!feature) return;
    feature.geometry.coordinates = [ring, ...feature.geometry.coordinates.slice(1)];
    draw.add(feature); // same id: this updates in place
  }

  $('#edge-value').textContent = `${feet > 0 ? '+' : ''}${feet} ft`;
  drawEdgeHighlight();
  refreshMeasurement();
  refreshSurveyed();
}

/** The parcel's outer ring, whatever geometry type it arrived as. */
function parcelRing() {
  const g = state.parcel?.geometry;
  if (!g) return null;
  if (g.type === 'Polygon') return g.coordinates[0];
  if (g.type === 'MultiPolygon') return g.coordinates[0][0];
  return null;
}

/**
 * Replace the parcel outline and re-frame the photograph around it.
 *
 * Re-framing is the point: SAM only ever sees the frame we send, so extending
 * the boundary has to widen the picture too, or the new strip is invisible to
 * the detector and any pin dropped on it is discarded.
 */
function setParcelRing(ring) {
  const g = state.parcel.geometry;
  if (g.type === 'Polygon') g.coordinates = [ring, ...g.coordinates.slice(1)];
  else if (g.type === 'MultiPolygon') g.coordinates[0] = [ring, ...g.coordinates[0].slice(1)];

  map.getSource('parcel').setData(state.parcel);

  const bbox = geometryBounds(state.parcel);
  if (bbox) {
    state.frame = {
      lng: (bbox[0] + bbox[2]) / 2,
      lat: (bbox[1] + bbox[3]) / 2,
      zoom: zoomToFit(bbox, FRAME_SIZE),
      size: FRAME_SIZE,
    };
  }
}

function currentEdgeRing() {
  const edit = state.edgeEdit;
  if (!edit?.featureId) return null;
  if (edit.featureId === PARCEL_ID) return parcelRing();
  return outerRing(draw.get(edit.featureId));
}

function drawEdgeHighlight() {
  const ring = currentEdgeRing();
  const edit = state.edgeEdit;
  if (!ring || edit.edgeIndex == null) return clearEdgeHighlight();

  // Highlight the whole run that will move, not just the segment tapped.
  const verts = openRing(ring);
  const n = verts.length;
  const run = edgeRun(ring, edit.edgeIndex);
  const line = [];
  for (let k = 0; k <= run.count; k++) line.push(verts[(run.start + k) % n]);

  map.getSource('edge-highlight').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: line },
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
  const pr = parcelRing();
  if (pr) live.push(...pr);

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
  const ring = parcelRing();
  if (!ring) return;

  pushHistory();
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
  clearHistory();
  draw.deleteAll();
  hideOverlay();
  disarmLawnPicker();
  map.getSource('parcel').setData(empty());
  state.marker?.remove();
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
  pushHistory();
  draw.changeMode('draw_polygon');
  setHint('Click around the edge of your lawn. Click the first point again to finish.');
  setStatus('Drawing by hand. Every shape you add counts toward the total.');
});

$('#btn-clear').addEventListener('click', () => {
  pushHistory();
  draw.deleteAll();
  if (state.edgeEdit) exitEdgeMode();
  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  state.detected = false;
  updatePromptHint();
  setStatus('Cleared. Detect again, or draw the lawn by hand.');
});

$('#btn-parcel-shape').addEventListener('click', useParcelShape);
$('#btn-undo').addEventListener('click', undo);

$('#btn-edges').addEventListener('click', () => {
  state.edgeEdit ? exitEdgeMode() : enterEdgeMode();
});
$('#btn-edge-done').addEventListener('click', exitEdgeMode);
$('#btn-tidy').addEventListener('click', tidyShapes);
$('#btn-point-add').addEventListener('click', addPointOnEdge);
$('#btn-point-delete').addEventListener('click', deleteSelectedVertex);
$('#edge-slider').addEventListener('input', (e) => applyEdgeOffset(Number(e.target.value)));

$('#btn-delete').addEventListener('click', () => {
  const ids = draw.getSelected().features.map((f) => f.id);
  if (!ids.length) return;
  pushHistory();
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
