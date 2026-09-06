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
  imagery: [],        // sources, from /api/config
  provider: 'mapbox', // which one is on screen and will be detected from
  detectedWith: null, // which one the shapes on screen actually came from
  models: [],         // detection methods, from /api/config
  model: 'sam3',      // which one Detect will use
  detectedBy: null,   // which one the shapes on screen actually came from
  pins: [],           // [lng, lat] the point-prompted model is told to look at
  mode: null,         // 'parcel' | 'pins' | 'shape' | null -- what taps act on
  shapeTool: 'points',// within shape mode: 'points' | 'add' | 'erase'
  sensitivity: 128,   // the cut between lawn and not-lawn in the mask
  drawingParcel: false,
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
  /* How many shapes the measurement is actually made of. */
  window.__lmShapeCount = () => (draw ? draw.getAll().features.length : 0);

  /*
   * What the imagery picker has actually done to the map.
   *
   * The only property that matters is that the photograph on screen covers the
   * frame the detector measures against -- everything else about a second
   * source is cosmetic, and a wrong answer here would look completely
   * plausible. So report both rectangles and let the test compare them, rather
   * than reporting "a layer exists", which is true of a picture of anywhere.
   */
  /* Layer order, bottom first. The photograph must sit under the shapes. */
  window.__lmLayerOrder = () => (map ? map.getStyle().layers.map((l) => l.id) : []);

  /* The pins the point-prompted model would be sent. */
  window.__lmPins = () => state.pins.map((p) => [...p]);

  /* Whether the numbered markers are actually ON the map right now. */
  window.__lmPinsDrawn = () => {
    const src = map?.getSource('lawn-pins');
    return Boolean(src?._data?.features?.length);
  };

  window.__lmImagery = () => ({
    provider: state.provider,
    detectsWith: effectiveProvider(state.provider),
    detectedWith: state.detectedWith,
    layer: !!(map && map.getLayer('imagery-alt')),
    sourceType: map?.getSource('imagery-alt')?.type ?? null,
    corners: map?.getSource('imagery-alt')?.coordinates ?? null,
    frameCorners: state.frame ? frameCorners(state.frame) : null,
    frameImageUrl: state.frame && !providerInfo(state.provider).tiles
      ? imageryUrlFor(state.provider, state.frame)
      : null,
  });

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

  const { mapboxToken, imagery, models } = await api('/api/config');
  state.imagery = Array.isArray(imagery) ? imagery : [];
  state.models = Array.isArray(models) ? models : [];
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

  // A polygon drawn while "Draw the property line" is armed becomes the
  // boundary rather than a patch of lawn.
  map.on('draw.create', (e) => {
    if (!state.drawingParcel) return;
    state.drawingParcel = false;
    adoptDrawnParcel(e.features?.[0]);
  });

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

  map.addSource('erase-stroke', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'erase-stroke', type: 'line', source: 'erase-stroke',
    paint: {
      'line-color': '#e53935',
      'line-width': 24,
      'line-opacity': 0.45,
      'line-cap': 'round',
      'line-join': 'round',
    },
  });

  // Grab handles for every corner, shown only while the adjust tool is open.
  // Mapbox Draw draws handles for a shape it has selected and never for the
  // parcel, which is not one of its features -- so without these there is
  // nothing to aim at on the property line.
  /*
   * Pins for the point-prompted model. Numbered, because "did that tap
   * register?" is the question a person asks on a phone, and a count in the
   * panel is not an answer about THIS pin.
   */
  map.addSource('lawn-pins', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'lawn-pins-halo', type: 'circle', source: 'lawn-pins',
    paint: {
      'circle-radius': 13,
      'circle-color': '#ffd54f',
      'circle-opacity': 0.9,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#5d4037',
    },
  });
  map.addLayer({
    id: 'lawn-pins-label', type: 'symbol', source: 'lawn-pins',
    layout: {
      'text-field': ['get', 'n'],
      'text-size': 13,
      'text-font': ['DIN Offc Pro Bold', 'Arial Unicode MS Bold'],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#3e2723' },
  });

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
      $('#btn-draw-parcel').hidden = true;

      const a = measure(state.parcel.geometry);
      setStatus(
        `Found your property line — ${a.acres} acres total ` +
        `(${state.parcel.properties.county}). Press "Detect my lawn".`
      );
    } else {
      map.getSource('parcel').setData(empty());
      state.surveyed = [];
      $('#btn-parcel-shape').hidden = true;
      $('#btn-draw-parcel').hidden = false;
      map.flyTo({ center: [lng, lat], zoom: IMAGERY_ZOOM_FALLBACK, duration: 600 });
      state.frame = { lng, lat, zoom: IMAGERY_ZOOM_FALLBACK, size: FRAME_SIZE };
      setStatus(
        data.covered
          ? 'Your county has records, but not for this parcel. Trace the property line and you can still measure it.'
          : 'No county record for this address. Press "Draw the property line" and trace your boundary — detection needs it to know where your lot ends.'
      );
    }

    updatePromptHint();
    // The pickers measure against the frame, so they only become real once
    // there is one.
    buildImageryPicker();
    buildModelPicker();
    refreshRail();
    refreshPins();
    setHint(state.parcel
      ? 'Press "Detect my lawn" — or extend the boundary first if your lawn runs to the road'
      : 'Trace your property line first');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    idle();
    refreshQuota();
  }
}

/* ---------------------------------------------------------------- eraser */
/**
 * Rub out anything the detector got wrong, by dragging over it.
 *
 * Dragging corners is right for nudging a boundary and wrong for "this whole
 * lobe is not lawn" -- that is fifteen precise drags to express one obvious
 * intention. A stroke says it once.
 *
 * It works by going back through the raster. The shapes are painted into a
 * pixel grid, the stroke is painted as holes, and the result is traced by the
 * same code that turns a SAM mask into polygons. That is not a detour: it
 * means splitting one shape into two, opening a hole in the middle, and
 * dropping a piece entirely all fall out for free, where polygon subtraction
 * would need a geometry library and three special cases.
 *
 * The grid is fitted to the shapes and the stroke rather than reusing the
 * detection frame, because a hand-drawn shape can sit outside that frame and
 * would be quietly erased by the round trip.
 */
const ERASER_RADIUS_PX = 22;   // a fingertip, near enough
const ERASE_GRID = 1280;       // same resolution the detector traces at

/*
 * The same stroke, in both directions.
 *
 * Subtracting and adding are the identical operation with one bit flipped:
 * paint the shapes into a grid, set the stroke's pixels to 0 or to 1, trace
 * what is left. Writing "add" as its own feature would have meant a second
 * copy of the rasterise-and-retrace round trip, and two places for a bug in
 * the brush-size maths to live.
 *
 * Adding has one thing subtracting does not: it works from nothing. There is
 * no shape to require before you start, because painting IS the shape.
 */
const BRUSH = {
  erase: {
    paint: 0,
    label: 'Erase',
    active: 'Done erasing',
    hint: 'Drag over anything that is not lawn',
    status: 'Erasing. Drag across the map to rub out what should not be there.',
    needsShapes: true,
  },
  add: {
    paint: 1,
    label: 'Add',
    active: 'Done adding',
    hint: 'Drag over lawn the detector missed',
    status: 'Adding. Drag across the map to paint in lawn that was missed.',
    needsShapes: false,
  },
};

let eraser = null; // the active brush, or null

function enterEraserMode(mode = 'erase') {
  const spec = BRUSH[mode] || BRUSH.erase;
  if (spec.needsShapes && !draw.getAll().features.some((f) => outerRing(f))) {
    setStatus('Nothing to erase yet — detect or draw a lawn first.', 'warn');
    return;
  }
  eraser = { stroke: [], mode: BRUSH[mode] ? mode : 'erase' };
  map.getCanvas().style.cursor = 'crosshair';
  setHint(spec.hint);
  setStatus(spec.status);
  armLawnPicker(); // reuses the touch and mouse plumbing
}

function exitEraserMode({ quiet = false } = {}) {
  eraser = null;
  map.getCanvas().style.cursor = '';
  map.getSource('erase-stroke')?.setData(empty());
  if (!quiet) {
    disarmLawnPicker();
    updatePromptHint();
  }
}

/** Show the stroke as it is drawn, so it is obvious what will change. */
function drawEraseStroke() {
  if (!map.getSource('erase-stroke')) return;
  const pts = eraser?.stroke || [];
  // Red takes away, green puts back. The stroke is the only feedback there is
  // until the finger lifts, so it has to say which direction it is going.
  if (map.getLayer('erase-stroke')) {
    map.setPaintProperty('erase-stroke', 'line-color',
      eraser?.mode === 'add' ? '#43a047' : '#e53935');
  }
  map.getSource('erase-stroke').setData(pts.length < 2
    ? empty()
    : { type: 'Feature', geometry: { type: 'LineString', coordinates: pts } });
}

/**
 * Apply the stroke: paint the shapes, punch out the stroke, trace what is left.
 */
function applyErase() {
  const stroke = eraser?.stroke || [];
  const mode = BRUSH[eraser?.mode] || BRUSH.erase;
  const features = draw.getAll().features.filter((f) => outerRing(f));
  // Erasing nothing is a no-op; adding to nothing is how you start.
  if (stroke.length < 2 || (!features.length && mode.paint === 0)) return;

  // A frame around everything involved, so nothing outside it is lost.
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  const see = ([lng, lat]) => {
    w = Math.min(w, lng); e = Math.max(e, lng);
    s = Math.min(s, lat); n = Math.max(n, lat);
  };
  for (const f of features) for (const ring of f.geometry.coordinates) ring.forEach(see);
  stroke.forEach(see);

  const pad = 0.0004; // a few dozen metres, so nothing sits on the edge
  const bbox = [w - pad, s - pad, e + pad, n + pad];
  const frame = {
    lng: (bbox[0] + bbox[2]) / 2,
    lat: (bbox[1] + bbox[3]) / 2,
    zoom: zoomToFit(bbox, ERASE_GRID / 2),
    size: ERASE_GRID / 2,
  };
  const project = (ll) => lngLatToFramePx(frame, ll, ERASE_GRID, ERASE_GRID);

  // What the shapes cover.
  const keep = new Uint8Array(ERASE_GRID * ERASE_GRID);
  for (const f of features) {
    const m = rasterizePolygon(f.geometry.coordinates, ERASE_GRID, ERASE_GRID, project);
    for (let i = 0; i < keep.length; i++) if (m[i]) keep[i] = 1;
  }

  /*
   * The stroke, as overlapping discs along it. Sampling only the points the
   * pointer reported would leave gaps at speed, so consecutive points are
   * joined by stepping along the segment.
   */
  /*
   * The brush is a fingertip on screen, so its size in metres depends on how
   * far the user has zoomed in -- and then that has to be expressed in this
   * grid's pixels, which are a different size again. Measuring the screen
   * scale by unprojecting two points beats deriving it: it asks the map what
   * it is actually showing rather than assuming the zoom maths agree.
   */
  const a = map.unproject([0, 0]);
  const b = map.unproject([ERASER_RADIUS_PX, 0]);
  const brushMetres = Math.hypot(
    (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180),
    (b.lat - a.lat) * 111320
  );
  const radius = Math.max(2, brushMetres / metresPerPixel(frame, ERASE_GRID));

  const disc = (cx, cy) => {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(ERASE_GRID - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(ERASE_GRID - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) keep[y * ERASE_GRID + x] = mode.paint;
      }
    }
  };

  let prev = project(stroke[0]);
  disc(prev[0], prev[1]);
  for (let i = 1; i < stroke.length; i++) {
    const cur = project(stroke[i]);
    const steps = Math.ceil(Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) / (radius / 2)) || 1;
    for (let k = 1; k <= steps; k++) {
      disc(prev[0] + ((cur[0] - prev[0]) * k) / steps,
           prev[1] + ((cur[1] - prev[1]) * k) / steps);
    }
    prev = cur;
  }

  // Back through the tracer, which owns simplification and hole handling.
  const data = new Uint8ClampedArray(ERASE_GRID * ERASE_GRID * 4);
  for (let p = 0; p < keep.length; p++) {
    const v = keep[p] ? 255 : 0;
    data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v;
    data[p * 4 + 3] = 255;
  }

  const polygons = maskToPolygons(
    { width: ERASE_GRID, height: ERASE_GRID, data },
    (x, y) => framePxToLngLat(frame, [x, y], ERASE_GRID, ERASE_GRID),
    {
      tolerance: TRACE_TOLERANCE_M / metresPerPixel(frame, ERASE_GRID),
      maxVertices: MAX_TRACE_VERTICES,
    }
  );

  pushHistory();
  draw.deleteAll();
  for (const geometry of polygons) draw.add({ type: 'Feature', properties: {}, geometry });

  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();

  const count = polygons.length;
  const sections = `${count} section${count > 1 ? 's' : ''}`;
  setStatus(
    mode.paint
      ? `Added. ${sections} of lawn.`
      : count
        ? `Erased. ${sections} left.`
        : 'Erased everything. Undo, or detect again.'
  );
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
    // Placing pins is work too. Undo that skipped them would quietly make
    // "remove all pins" the only way back from one stray tap.
    pins: state.pins.map((p) => [...p]),
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

  state.pins = (prev.pins || []).map((p) => [...p]);
  refreshPins();

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
  if (eraser) {
    eraser.stroke = [];
    eraser.painting = true;
    map.dragPan.disable();
    return true;
  }
  const hit = vertexAt(clientX, clientY);
  if (!hit) return false;
  drag = { ...hit, startX: clientX, startY: clientY, moved: false };
  diag.dragGrabbed++;
  return true;
}

function updateDrag(clientX, clientY) {
  if (eraser?.painting) {
    const rect = map.getCanvasContainer().getBoundingClientRect();
    const ll = map.unproject([clientX - rect.left, clientY - rect.top]);
    eraser.stroke.push([ll.lng, ll.lat]);
    drawEraseStroke();
    return true;
  }
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
  if (eraser?.painting) {
    eraser.painting = false;
    map.dragPan.enable();
    const painted = eraser.stroke.length >= 2;
    if (painted) applyErase();
    eraser.stroke = [];
    drawEraseStroke();
    return painted;
  }
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

  if (state.edgeEdit) return selectNear([lngLat.lng, lngLat.lat]);
  if (placingPins()) addPin([lngLat.lng, lngLat.lat]);
}

/* ------------------------------------------------------------------ pins */
/*
 * Where to look, for the model that has to be told.
 *
 * The text-prompted model reads the whole frame and needs nothing placed. The
 * point-prompted one segments what you point at and nothing else, so the pins
 * ARE the request: no pins, no prediction, which is why the Worker refuses
 * that call before touching the quota rather than charging for an empty
 * answer.
 */
const modelInfo = (id) =>
  state.models.find((m) => m.id === id) || { id, label: id, needsPoints: false };

const pinsWanted = () => Boolean(state.frame) && modelInfo(state.model).needsPoints;

/** Taps place pins only while that is the mode you chose. */
const placingPins = () => state.mode === 'pins' && pinsWanted();

function addPin(lngLat) {
  pushHistory('pin');
  state.pins.push(lngLat);
  refreshPins();
}

function clearPins() {
  if (state.pins.length) pushHistory();
  state.pins = [];
  refreshPins();
}

function refreshPins() {
  /*
   * Shown only while you are placing them.
   *
   * Seven numbered markers sitting over the lawn while you are trying to
   * correct its outline are seven things in the way that cannot be moved and
   * do not do anything. They belong to the pin step, so they live and die
   * with it.
   */
  const visible = placingPins() ? state.pins : [];
  map.getSource('lawn-pins')?.setData({
    type: 'FeatureCollection',
    features: visible.map((p, i) => ({
      type: 'Feature',
      properties: { n: String(i + 1) },
      geometry: { type: 'Point', coordinates: p },
    })),
  });

  const wanted = placingPins();
  $('#pin-panel').hidden = !wanted;
  $('#btn-pins-clear').disabled = !state.pins.length;
  if (wanted) {
    const n = state.pins.length;
    $('#pin-count').textContent = n
      ? `${n} pin${n > 1 ? 's' : ''} placed — add more for any patch not covered`
      : 'Tap each part of your lawn to place a pin';
  }
  updatePromptHint();
}

function updatePromptHint() {
  // Already detected from THIS photograph, with THIS model, is the only case
  // worth blocking. Re-running the same pair returns the same mask and charges
  // again; changing either is a real second opinion, and the whole reason the
  // two pickers exist.
  const same = state.detected &&
    state.detectedWith === effectiveProvider(state.provider) &&
    state.detectedBy === state.model;

  // The point-prompted model cannot run on nothing, so the button says why it
  // is dark rather than just being dark.
  const needsPins = pinsWanted() && !state.pins.length;

  /*
   * No property line, no detection.
   *
   * The detector reads the whole frame, and the frame is wider than the lot --
   * so without a boundary to clip against, what comes back includes the
   * neighbours' grass. On the lot this was first tested against that was 3,721
   * sq ft of someone else's lawn, a third of everything found, and the number
   * looked entirely reasonable. A measurement nobody can tell is wrong is
   * worse than no measurement, so the boundary is now a precondition rather
   * than an improvement.
   *
   * Nothing is taken away by this: an address with no county record can still
   * draw its own boundary, which is what "Draw the property line" is for.
   */
  const needsParcel = !parcelRing();

  $('#btn-detect').disabled = !state.frame || same || needsPins || needsParcel;
  $('#btn-detect').textContent = same
    ? 'Lawn detected'
    : needsParcel
      ? 'Property line needed first'
      : needsPins
        ? 'Tap your lawn to place a pin'
        : state.detected
          ? 'Detect again'
          : 'Detect my lawn';
}

/* ---------------------------------------------------------- model picker */

function buildModelPicker() {
  const select = $('#model-choice');
  if (state.models.length < 2) { $('#model-panel').hidden = true; return; }

  select.innerHTML = '';
  for (const m of state.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    select.append(opt);
  }
  select.value = state.model;
  $('#model-panel').hidden = false;
  $('#model-note').textContent = modelInfo(state.model).note || '';
}

function setModel(id) {
  if (id === state.model) return;
  state.model = id;
  $('#model-choice').value = id;
  $('#model-note').textContent = modelInfo(id).note || '';

  /*
   * Pins belong to the model that uses them. Switching to the text-prompted
   * one leaves them on the map as clutter that does nothing; switching back
   * would silently reuse pins placed for a different question. Dropping them
   * is the honest move, and undo still has them.
   */
  if (state.pins.length && !modelInfo(id).needsPoints) clearPins();

  /*
   * Picking the precise method puts you straight into placing pins, because
   * that is the only thing you can do next -- it cannot run without them. And
   * leaving it drops you out of a mode that no longer exists.
   */
  if (modelInfo(id).needsPoints) setMode('pins');
  else if (state.mode === 'pins') setMode(null);
  else { refreshPins(); refreshRail(); updatePromptHint(); }
}

/* ------------------------------------------------------------- detection */

async function detect() {
  if (!state.frame) return;

  const frame = state.frame;
  const provider = effectiveProvider(state.provider);
  const model = state.model;

  /*
   * Pins, converted here rather than in the Worker.
   *
   * The model is shown the image, so its coordinates are image pixels -- and
   * the browser is the side that knows how big that image is. Mapbox renders
   * the static endpoint at @2x, so a 640 frame comes back 1280 px wide; a pin
   * sent in frame units would land at half the distance from the corner, which
   * is a plausible-looking spot somewhere else on the property.
   */
  const imgPx = Math.min(frame.size * 2, 2560);
  const points = state.pins.map((ll) => {
    const [x, y] = lngLatToFramePx(frame, ll, imgPx, imgPx);
    return [Math.round(x), Math.round(y)];
  });

  /*
   * Detecting replaces every shape on the map, so when there is work on screen
   * that did not come from this run, say so before destroying it. Before the
   * picker existed this could not happen -- the button disabled itself after a
   * detection -- and re-arming it for a second source quietly put hand-drawn
   * shapes and every correction at risk.
   */
  if (draw.getAll().features.length && !confirm(
    'Detecting again replaces the shapes on the map, including any corrections ' +
    'you have made. Carry on?'
  )) return;

  busy('Detecting your lawn…');
  $('#btn-detect').disabled = true;

  try {
    let data = await api('/api/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...frame, provider, model, points, clientId: state.clientId }),
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
      { clipMask, fillGapsUnderPx, tolerance, maxVertices: MAX_TRACE_VERTICES,
        threshold: state.sensitivity }
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
    // The server's word for which source it used, not ours: it falls back for
    // a look-only source, and the status line has to name the real one.
    state.detectedWith = rendered.provider || provider;
    state.detectedBy = data.model || model;
    state.lastMask = { url, frame: rendered, image };
    if ($('#toggle-overlay').checked) showOverlay();
    refreshSensitivity();

    refreshMeasurement();
    refreshSurveyed();
    updateSelectionButtons();
    refreshRail();
    setHint('Use the buttons on the right of the map to correct the shape');

    const gaps = polygons.filledGaps
      ? ` ${polygons.filledGaps} gap${polygons.filledGaps > 1 ? 's' : ''} counted as grass under trees` +
        ` (about ${Math.round(polygons.filledGapPx * sqFtPerPx).toLocaleString()} sq ft) —` +
        ' untick the box below if any of those is a pool or a shed.'
      : '';

    // Name the source only when it is not the one showing, i.e. when a
    // look-only choice was silently substituted. Saying "on Mapbox satellite"
    // after every ordinary detection is noise; saying it when the user picked
    // Esri is the difference between a fallback and a lie.
    const on = state.detectedWith === state.provider
      ? ''
      : ` on ${providerInfo(state.detectedWith).label}` +
        ` (${providerInfo(state.provider).label} cannot be measured from)`;

    setStatus(
      `Found ${polygons.length} section${polygons.length > 1 ? 's' : ''} of lawn` +
      (ring ? ', trimmed to your property line' : '') + on + '.' + gaps +
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

/* --------------------------------------------------------- imagery source */

/*
 * Which photograph to look at, and to measure from.
 *
 * The same lawn photographed in April and in July is two different problems:
 * bare trees and long shadows against full canopy and a high sun. We were
 * chasing a shaded strip for an hour that turned out not to be lawn at all,
 * which no amount of prompt tuning would have settled -- a second picture of
 * the same ground would have, in seconds and for free.
 *
 * Every source draws the same rectangle: the frame. That is what makes this
 * safe. Switching pictures cannot move the measurement, because the ground the
 * pixels cover is fixed by the frame and verified per source in
 * tools/probe-imagery.js -- both USGS services return our exact extent, to
 * 0.000 m. Esri cannot return an arbitrary extent at all, so it is here to look
 * at and detection falls back to Mapbox, out loud, in the status line.
 */

const providerInfo = (id) =>
  state.imagery.find((p) => p.id === id) || { id, label: id, detect: true };

/**
 * The lowest layer that belongs to us, so a photograph can go underneath it.
 *
 * This is the whole of a real bug: choosing USGS imagery made every drawn and
 * detected shape disappear, and switching back to Mapbox brought them all
 * back. Nothing was lost -- the photograph was on top of them. Mapbox GL Draw
 * adds its `gl-draw-*` layers when the control is added, which happens before
 * the app adds its own, so the draw layers sit at the BOTTOM of our stack.
 * Inserting the photo before 'parcel-fill' therefore put it above every shape.
 *
 * Asking the style where our layers actually begin beats naming one, because
 * the answer changes with load order and the failure is silent: a correct
 * photograph, correctly placed, hiding the thing being measured.
 */
function bottomOfOurLayers() {
  const ours = /^(gl-draw|parcel-|edge-highlight|erase-stroke|points|surveyed|mask-overlay|lawn-pins)/;
  for (const layer of map.getStyle().layers) {
    if (layer.id !== 'imagery-alt' && ours.test(layer.id)) return layer.id;
  }
  return undefined; // nothing of ours yet: the top of the basemap will do
}

/** Mirrors the Worker's detectionProvider: a look-only source detects on Mapbox. */
const effectiveProvider = (id) => (providerInfo(id).detect ? id : 'mapbox');

function buildImageryPicker() {
  const select = $('#imagery-source');
  const panel = $('#imagery-panel');

  // One source is not a choice. If the Worker is old enough not to send a
  // list, the picker simply does not appear and everything behaves as before.
  if (state.imagery.length < 2) {
    panel.hidden = true;
    return;
  }

  select.innerHTML = '';
  for (const p of state.imagery) {
    const opt = document.createElement('option');
    opt.value = p.id;
    // Say it in the list too, not only after choosing. Picking a source and
    // then being told it cannot measure is a wasted step.
    opt.textContent = p.detect ? p.label : `${p.label} — view only`;
    select.append(opt);
  }
  select.value = state.provider;
  panel.hidden = false;
  renderProviderNote(state.provider);
}

/**
 * The note under the picker, with the limitation stated first and in bold.
 *
 * Built from DOM nodes rather than innerHTML: the text arrives over HTTP from
 * /api/config, and while that is our own Worker, "it is our own string" is
 * exactly the assumption that stops being true later.
 */
function renderProviderNote(id) {
  const info = providerInfo(id);
  const el = $('#imagery-note');
  el.textContent = '';
  if (!info.detect) {
    const strong = document.createElement('strong');
    strong.textContent = 'AI detection not available for this imagery source.';
    el.append(strong, ' ');
  }
  el.append(info.note || '');
}

async function setProvider(id) {
  if (id === state.provider) return;
  state.provider = id;
  $('#imagery-source').value = id;
  renderProviderNote(id);

  await showImagery();
  // Switching sources re-arms detection: a different photograph is a genuinely
  // different prediction, not a second charge for the same one.
  updatePromptHint();
}

function hideImagery() {
  if (map.getLayer('imagery-alt')) map.removeLayer('imagery-alt');
  if (map.getSource('imagery-alt')) map.removeSource('imagery-alt');
}

/**
 * Put the chosen photograph on the map.
 *
 * Two shapes of source, for the reason the probe found: a tiled basemap (Esri)
 * is painted as tiles across the whole map, while an image service is fetched
 * as one picture of exactly the frame -- literally the image the detector will
 * be shown, placed on its own corners. Seeing precisely what the AI sees is
 * worth more here than covering the whole screen.
 */
async function showImagery() {
  hideImagery();
  if (state.provider === 'mapbox') return;

  const info = providerInfo(state.provider);
  const before = bottomOfOurLayers();

  if (info.tiles) {
    map.addSource('imagery-alt', {
      type: 'raster', tiles: [info.tiles], tileSize: 256, maxzoom: 23,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    });
    map.addLayer({ id: 'imagery-alt', type: 'raster', source: 'imagery-alt' }, before);
    return;
  }

  if (!state.frame) return;

  const url = imageryUrlFor(state.provider, state.frame);

  /*
   * Ask for it before handing it to Mapbox GL.
   *
   * An image source that 404s fails silently -- the layer is simply never
   * painted, and the user sees the Mapbox basemap and concludes the new source
   * looks identical. NAIP genuinely has gaps, so "no photo here" is a real
   * answer that deserves saying rather than hiding.
   */
  /*
   * Say something while it loads.
   *
   * USGS took 6.7 seconds to answer a cold request for one frame, through the
   * Worker, on a fast network. Six seconds of a map that has not changed reads
   * as a dead button, and the natural response is to press it again. The wait
   * is the source's, not ours -- but silence about it is.
   */
  busy(`Fetching ${info.label}…`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    idle();
    setStatus(
      `${info.label} has no photograph of this spot (${err.message}). Staying on Mapbox.`,
      'warn'
    );
    state.provider = 'mapbox';
    $('#imagery-source').value = 'mapbox';
    renderProviderNote('mapbox');
    return;
  }

  map.addSource('imagery-alt', {
    type: 'image', url, coordinates: frameCorners(state.frame),
  });
  map.addLayer({ id: 'imagery-alt', type: 'raster', source: 'imagery-alt' }, before);
  idle();
  setStatus(info.detect
    ? `Showing ${info.label} over the measurement frame. Detect again to use it.`
    : `Showing ${info.label}. This one is for looking at — detection uses Mapbox.`);
}

/** The same URL the Worker builds, asked for through our own origin. */
function imageryUrlFor(provider, frame) {
  return '/api/imagery?' + new URLSearchParams({
    lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size, provider,
  });
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

/* --------------------------------------------------------------- modes */
/*
 * One thing at a time.
 *
 * Every tool used to be live at once: the property line, the lawn outlines and
 * the detection pins all responded to the same tap, and which one you got
 * depended on what happened to be nearest. That is fine until two of them
 * overlap, which on a lawn traced to its own boundary is always.
 *
 * So there are three modes and you are in exactly one, or none:
 *
 *   parcel  the property line, and nothing else, responds
 *   pins    the detection pins -- placed, numbered, and visible ONLY here
 *   shape   the lawn outlines, with two sub-tools:
 *             points  drag, add and delete corners
 *             add / erase  paint the outline bigger or smaller
 *
 * Leaving a mode puts its handles away, which is why the pins vanish when you
 * are not placing them: a numbered marker you cannot move and did not ask for
 * is just something in front of the lawn.
 */
const MODES = ['parcel', 'pins', 'shape'];

function setMode(mode, tool = null) {
  const next = MODES.includes(mode) ? mode : null;

  // Tear the old one down first, so no two modes ever hold the map at once.
  if (eraser) exitEraserMode({ quiet: true });
  state.edgeEdit = null;
  clearEdgeHighlight();
  clearPoints();
  $('#edge-panel').hidden = true;
  $('#point-controls').hidden = true;
  $('#edge-controls').hidden = true;
  disarmLawnPicker();

  state.mode = next;
  if (next === 'shape') state.shapeTool = tool || state.shapeTool || 'points';

  if (next === 'parcel') enterRingEditing('parcel');
  else if (next === 'shape' && state.shapeTool === 'points') enterRingEditing('shape');
  else if (next === 'shape') enterEraserMode(state.shapeTool);
  else if (next === 'pins') {
    armLawnPicker();
    setHint('Tap each separate patch of lawn');
    setStatus(state.pins.length
      ? 'Placing pins. Tap to add more, or press Detect.'
      : 'Tap your lawn to place pins, then press Detect. The AI segments exactly what you point at.');
  } else {
    setHint('');
  }

  refreshPins();
  refreshRail();
  updatePromptHint();
}

/** Corner-and-edge editing, for whichever outline the mode owns. */
function enterRingEditing(which) {
  const rings = editableRings();
  if (!rings.length) {
    setStatus(which === 'parcel'
      ? 'No property line yet. Use "Draw the property line" to trace one.'
      : 'No lawn shape yet. Detect one, or draw it by hand.', 'warn');
    return;
  }

  state.edgeEdit = { featureId: null, edgeIndex: null, vertexIndex: null, baseRing: null };
  $('#edge-panel').hidden = false;
  $('#edge-info').textContent = which === 'parcel'
    ? 'Tap a line to extend that edge out to the road, or a corner to move it.'
    : 'Tap a line to slide that edge, or a corner dot to move, add or delete it.';
  $('#edge-info').className = 'edge-info';
  setHint('Tap a line to extend it, or a corner to move it');
  armLawnPicker(); // same tap plumbing; handleMapPoint routes the tap
  drawPoints();    // the corners have to be visible to be aimed at
}

/* -------------------------------------------------------- sensitivity */
/*
 * How much of the mask counts as lawn -- moved without paying again.
 *
 * The detector hands back a picture, and turning that picture into a yes/no
 * per pixel needs a cut. That cut is ours, not the model's, which matters here
 * because the point-prompted model publishes no threshold of its own: its
 * schema is `image` and `input_points` and nothing else, so there is no
 * model-side knob to turn. This is the one that exists.
 *
 * It costs nothing to move, because the mask is already downloaded and
 * decoded: re-tracing is arithmetic on pixels we have. Detection is the
 * expensive step and it does not run again.
 *
 * It only does something if the mask has mid-tones. A model that returns pure
 * black and white has already made the decision, and no cut between 1 and 254
 * will change a single pixel -- so measure the mask when it arrives and say so
 * rather than offering a control that silently does nothing.
 */
const DEFAULT_SENSITIVITY = 128;

/** Share of pixels that are neither nearly-black nor nearly-white. */
function maskSoftness(image) {
  const d = image.data;
  let mid = 0;
  // Every 4th pixel: this is a 1280x1280 image and the answer is a proportion.
  for (let i = 0; i < d.length; i += 16) {
    const v = d[i];
    if (v > 24 && v < 231) mid++;
  }
  return mid / (d.length / 16);
}

function refreshSensitivity() {
  const panel = $('#sens-panel');
  if (!panel) return;

  const mask = state.lastMask;
  if (!mask?.image) { panel.hidden = true; return; }

  const soft = maskSoftness(mask.image);
  panel.hidden = false;
  $('#sens-slider').disabled = soft < 0.01;
  $('#sens-note').textContent = soft < 0.01
    ? 'This model returns a hard yes/no mask, so there is nothing to loosen or tighten. Use Erase to take out what it got wrong.'
    : 'Right is stricter — less gets called lawn. Free: it re-reads the picture you already paid for.';
}

/** Re-trace the mask already in hand at the current cut. */
function retrace() {
  const mask = state.lastMask;
  if (!mask?.image) return;

  const { image, frame: rendered } = mask;
  const w = image.width;
  const h = image.height;

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

  const sqFtPerPx = (metresPerPixel(rendered, w) ** 2) / 0.09290304;
  const polygons = maskToPolygons(
    image,
    (x, y) => framePxToLngLat(rendered, [x, y], w, h),
    {
      clipMask,
      fillGapsUnderPx: $('#toggle-trees').checked ? Math.round(TREE_GAP_SQFT / sqFtPerPx) : 0,
      tolerance: TRACE_TOLERANCE_M / metresPerPixel(rendered, w),
      maxVertices: MAX_TRACE_VERTICES,
      threshold: state.sensitivity,
    }
  );

  // A snapshot per change would bury the detection under a hundred steps of
  // slider, so the whole drag collapses into one undoable move.
  pushHistory('sensitivity');
  draw.deleteAll();
  for (const geometry of polygons) draw.add({ type: 'Feature', properties: {}, geometry });

  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  setStatus(polygons.length
    ? `${polygons.length} section${polygons.length > 1 ? 's' : ''} of lawn at this setting.`
    : 'Nothing left at this setting — move it back to the left.', polygons.length ? '' : 'warn');
}

/**
 * Turn a just-drawn polygon into the property line.
 *
 * Taken out of Draw entirely rather than left as a feature with a flag: the
 * boundary and the lawn are measured against each other, and a boundary that
 * is also one of the shapes being measured would count its own area.
 */
function adoptDrawnParcel(feature) {
  const ring = feature && outerRing(feature);
  if (!ring || ring.length < 4) {
    setStatus('That outline was not closed. Try tracing the boundary again.', 'warn');
    return;
  }

  draw.delete(feature.id);

  state.parcel = {
    type: 'Feature',
    // `county` is what the print-out and the status line quote as the source.
    // Saying "traced by hand" there is the difference between an estimate the
    // reader can weigh and a number that implies a survey.
    properties: { county: 'traced by hand', drawn: true },
    geometry: { type: 'Polygon', coordinates: [ring.map((p) => [...p])] },
  };
  map.getSource('parcel').setData(state.parcel);

  // No corner here came from a county record, so none of them get the yellow
  // "surveyed" treatment.
  state.surveyed = [];

  const bbox = geometryBounds(state.parcel);
  if (bbox) {
    state.frame = {
      lng: (bbox[0] + bbox[2]) / 2,
      lat: (bbox[1] + bbox[3]) / 2,
      zoom: zoomToFit(bbox, FRAME_SIZE),
      size: FRAME_SIZE,
    };
  }

  const a = measure(state.parcel.geometry);
  $('#btn-draw-parcel').hidden = true;
  $('#btn-parcel-shape').hidden = false;
  refreshSurveyed();
  refreshRail();
  updatePromptHint();
  setHint('');
  setStatus(`Property line traced — ${a.acres} acres. Press "Detect my lawn".`);
}

/** Paint every rail button with what is actually live. */
function refreshRail() {
  const rail = $('#maprail');
  if (!rail) return;
  rail.hidden = !state.frame;

  // Pins are only a concept for the model that uses them.
  $('#mode-pins').hidden = !modelInfo(state.model).needsPoints;

  for (const m of MODES) {
    $(`#mode-${m}`)?.setAttribute('aria-pressed', String(state.mode === m));
  }

  $('#shape-tools').hidden = state.mode !== 'shape';
  for (const [id, tool] of [['#tool-points', 'points'], ['#tool-add', 'add'], ['#tool-erase', 'erase']]) {
    $(id)?.setAttribute('aria-pressed',
      String(state.mode === 'shape' && state.shapeTool === tool));
  }
}

/* Kept as the names the rest of the file already calls. */
const exitEdgeMode = () => setMode(null);

/**
 * Every editable outline, in the order a tap should consider them.
 *
 * Scoped to the mode, and that is the whole point of modes: this used to
 * return the lawn outlines AND the property line together, so a tap meant for
 * a lawn corner near the boundary moved the boundary instead. Both were
 * legitimate targets and only one was wanted, and nothing on screen said which
 * would win.
 */
function editableRings() {
  if (state.mode === 'parcel') {
    const parcel = parcelRing();
    return parcel ? [{ featureId: PARCEL_ID, ring: parcel }] : [];
  }

  if (state.mode === 'shape' && state.shapeTool === 'points') {
    return draw.getAll().features
      .map((f) => ({ featureId: f.id, ring: outerRing(f) }))
      .filter((r) => r.ring);
  }

  return [];
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
    // An image-service photograph is pinned to the frame's four corners, so
    // re-framing moves the ground out from under it. Refetch for the new
    // rectangle rather than leave a correctly-drawn picture of the old one.
    if (map.getLayer('imagery-alt') && !providerInfo(state.provider).tiles) {
      showImagery(); // deliberately not awaited: nothing here depends on it
    }
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
  if (!hasShapes) {
    // Clear the figure rather than just hiding it. A hidden panel keeps its
    // last text, which reads as a live measurement to anything looking at the
    // DOM -- a browser check did exactly that and passed on a stale number
    // while the map was empty.
    $('#result-sqft').textContent = '—';
    $('#result-sub').textContent = '';
    return;
  }

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
  hideImagery();
  disarmLawnPicker();
  map.getSource('parcel').setData(empty());
  state.marker?.remove();
  state.chosen = state.parcel = state.frame = null;
  state.lastMask = null;
  state.detected = false;
  state.detectedWith = null;
  state.detectedBy = null;
  state.provider = 'mapbox';
  state.model = 'sam3';
  state.pins = [];
  state.mode = null;
  state.shapeTool = 'points';
  state.drawingParcel = false;
  state.sensitivity = DEFAULT_SENSITIVITY;
  $('#sens-slider').value = String(DEFAULT_SENSITIVITY);
  $('#sens-panel').hidden = true;
  $('#btn-draw-parcel').hidden = true;
  refreshPins();
  refreshRail();
  $('#maprail').hidden = true;
  $('#imagery-panel').hidden = true;
  $('#model-panel').hidden = true;
  $('#pin-panel').hidden = true;
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

$('#imagery-source').addEventListener('change', (e) => setProvider(e.target.value));
$('#model-choice').addEventListener('change', (e) => setModel(e.target.value));
/*
 * `input` would re-trace on every pixel of travel, which on a 1280px mask is a
 * visible stutter and a lot of wasted work for positions nobody stopped at.
 * `change` fires once the finger lifts.
 */
$('#sens-slider').addEventListener('change', (e) => {
  state.sensitivity = Number(e.target.value) || DEFAULT_SENSITIVITY;
  retrace();
});

$('#btn-pins-clear').addEventListener('click', () => {
  clearPins();
  setStatus('Pins removed. Tap the lawn to place new ones.');
});

/*
 * Tracing your own boundary.
 *
 * Detection needs a property line to clip against, and only seven counties
 * publish one. Without this, every address outside them would be refused a
 * measurement it used to be given -- so requiring a boundary and providing no
 * way to supply one would be a straight loss of function dressed up as rigour.
 *
 * A boundary drawn here is treated exactly like a surveyed one, except that
 * refreshSurveyed() knows none of its corners came from the county, so nothing
 * on the map claims a precision it does not have.
 */
$('#btn-draw-parcel').addEventListener('click', () => {
  setMode(null);
  state.drawingParcel = true;
  draw.changeMode('draw_polygon');
  setHint('Tap each corner of your property. Tap the first one again to close it.');
  setStatus('Tracing the property line. Follow the kerb, the fences and the neighbours’ edges.');
});

$('#btn-draw').addEventListener('click', () => {
  setMode(null); // drawing owns the map while it is open
  pushHistory();
  draw.changeMode('draw_polygon');
  setHint('Click around the edge of your lawn. Click the first point again to finish.');
  setStatus('Drawing by hand. Every shape you add counts toward the total.');
});

$('#btn-clear').addEventListener('click', () => {
  pushHistory();
  draw.deleteAll();
  if (state.mode === 'shape') setMode(null);
  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  state.detected = false;
  updatePromptHint();
  setStatus('Cleared. Detect again, or draw the lawn by hand.');
});

$('#btn-parcel-shape').addEventListener('click', useParcelShape);
$('#btn-undo').addEventListener('click', undo);
/*
 * The rail. Pressing the live mode turns it off; pressing another switches
 * straight to it -- making you close one before opening the next would be a
 * press per correction, and corrections come in runs.
 */
for (const mode of MODES) {
  $(`#mode-${mode}`).addEventListener('click', () => {
    setMode(state.mode === mode ? null : mode);
  });
}

for (const tool of ['points', 'add', 'erase']) {
  $(`#tool-${tool}`).addEventListener('click', () => {
    if (state.mode === 'shape' && state.shapeTool === tool) setMode(null);
    else setMode('shape', tool);
  });
}

$('#btn-edge-done').addEventListener('click', () => setMode(null));
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
