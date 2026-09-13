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

import { measure, fromSquareMeters, geometryAreaSqM } from './lib/area.js';
import {
  maskToPolygons, rasterizePolygon, maskBinary, unionMasks, subtractMasks,
  coverage, polygonsFromBinary, distinctFraction,
} from './lib/mask.js';
import {
  offsetEdge, nearestEdge, edgeRun, edgeLength, edgeBearing, openRing,
  nearestVertex, moveVertex, insertVertex, deleteVertex, tidyRing,
  feetToMetres, metresToFeet,
} from './lib/edges.js';
import {
  planSegments,
  MIN_SEGMENT_SQFT, MAX_SEGMENT_SQFT, SEGMENT_STEP_SQFT,
  MIN_WIDTH_FT, MAX_WIDTH_FT, DEFAULT_WIDTH_FT,
} from './lib/segments.js';
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
  dev: false,         // developer mode: prompt/threshold by hand
  devPrompt: '',
  devThreshold: null, // null means "let the model decide"
  devInvert: false,   // Testing's inversion, which no shipped model owns
  model: 'sam3',      // which one Detect will use
  detectedBy: null,   // which one the shapes on screen actually came from
  exclusions: [],     // what exclude mode can remove, from /api/config
  exclude: [],        // which of those are ticked -- one AI pass each
  detectedExcluding: null, // the tick set the shapes on screen came from
  pins: [],           // [lng, lat] the point-prompted model is told to look at
  mode: null,         // 'parcel' | 'pins' | 'shape' | null -- what taps act on
  shapeTool: 'points',// within shape mode: 'points' | 'add' | 'erase'
  brushSize: 'bulk',  // 'fine' for trimming, 'bulk' for clearing
  measureOutside: false, // may the brush paint past the property line?

  edgeFt: 0,          // shrink (-) or grow (+) the detected outline, in feet
  drawingParcel: false,

  /*
   * "Count grass under trees", remembered per arithmetic rather than globally.
   *
   * The option means opposite things in the two modes. Finding grass, a hole in
   * the lawn is somewhere the model could not see through canopy, and filling
   * it is the better guess -- so it is on. Excluding objects, a hole is
   * something a ticked box removed, and filling it hands that straight back --
   * so it is off, and ticking it is a deliberate "the trees box is too greedy,
   * give me the small gaps back".
   *
   * Two remembered values rather than one, because a single switch would carry
   * a decision made about one arithmetic into the other, where it means the
   * reverse. Whichever mode is showing puts its own answer in the box.
   */
  fillGaps: { find: true, exclude: false },

  tab: 'address',     // which step's tools are on screen -- see setTab
  handEdited: false,  // has the lawn been corrected by hand since it appeared?

  // Accounts. `accountsOn` is what the deployment supports; `user` is who is
  // signed in, which is null far more often than not and must never be a
  // precondition for measuring a lawn.
  accountsOn: false,
  user: null,
  emailSignin: false, // can this deployment send a sign-in link?
  saves: [],          // the account's maps, cached so the list is not a wait
  saveMax: 0,         // how many an account keeps, as the Worker reports it
  plan: null,         // the last application split, or null for none drawn
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
 * How many separate pieces of lawn exclude mode may hand back.
 *
 * Find-grass mode keeps six, which is the number of shapes a person can
 * reasonably be handed to drag. Exclude mode earns a larger one: it starts
 * from the whole lot and cuts pieces out of it, so each additional ticked box
 * fragments what is left, and a lot with a drive and scattered trees really is
 * more than six pieces of grass. The old cap silently discarded the rest --
 * ground no prompt had claimed, vanishing in proportion to how many boxes were
 * ticked.
 *
 * Twenty-four rather than unlimited because the tail of that list is speckle
 * along a mask edge, not lawn anyone mows, and every shape past the first
 * handful is one more thing to scroll past on a phone. Whatever the cap does
 * drop is now named on screen with its area, so the number on the total is
 * never quietly short.
 */
const MAX_EXCLUDE_POLYGONS = 24;

/**
 * Below this, dropped scraps are not worth a sentence.
 *
 * 200 sq ft is a patch about fourteen feet square -- small enough that nobody
 * quotes it separately, large enough that leaving it out of a total without
 * saying so would be hiding something.
 */
const DROPPED_NOTE_SQFT = 200;

/**
 * The smallest hole exclude mode will cut out of the lawn.
 *
 * 40 sq ft is a patch about six feet across -- smaller than anything a person
 * would call an object, and the point below which a hole in a mask is speckle
 * rather than a thing. Everything above it gets traced, so a ticked box
 * removes what it says it removes.
 */
const MIN_HOLE_SQFT = 40;

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

  /* The measured area, from the geometry rather than the formatted panel. */
  window.__lmSqft = () => (draw ? totalSquareFeet() : 0);

  /*
   * Duplicate the largest shape exactly on top of itself.
   *
   * There is no gesture that reliably produces two shapes on the same ground,
   * which is why the double-counting survived so long: geodesic area sums a
   * FeatureCollection, so a lawn drawn twice measured twice, and the map looked
   * completely normal because the copy sat exactly on the original. This makes
   * that case reachable from a test rather than only from a user who happens to
   * paint over their own work.
   */
  window.__lmDuplicateShape = () => {
    if (!draw) return 0;
    const shapes = draw.getAll().features.filter((f) => f.geometry?.type === 'Polygon');
    if (!shapes.length) return 0;
    const biggest = shapes
      .slice()
      .sort((a, b) => measure(b.geometry).squareFeetRaw - measure(a.geometry).squareFeetRaw)[0];
    // Through the same undo stack a real edit uses, so this is a duplicate the
    // user could have made and can take back, not a poke at internal state.
    pushHistory();
    draw.add({
      type: 'Feature',
      properties: {},
      geometry: JSON.parse(JSON.stringify(biggest.geometry)),
    });
    refreshMeasurement();
    return draw.getAll().features.length;
  };

  /*
   * The real body a detection would post, built by the real function.
   *
   * Not a reconstruction: detect() calls this same function. A test that built
   * its own copy of the body would agree with itself no matter what the app
   * sent, which is exactly how the developer allowance shipped broken -- the
   * Worker honoured the flag, the badge asked for it, and nothing checked that
   * the browser put it in the request.
   */
  window.__lmDetectBody = () => detectionRequest(
    state.frame || { lng: 0, lat: 0, zoom: 19, size: 640 },
    effectiveProvider(state.provider),
    state.model,
    []
  );

  /*
   * The edge tool, driven through the real setter.
   *
   * Its panel only appears once there is a mask, so the free browser run cannot
   * click the buttons -- but the buttons are the trivial part. What can go
   * wrong is the parsing: a half-typed "-" snapping the outline to zero, a
   * pasted "20ft" clamping somewhere unexpected, a value accepted past the
   * range the tracer can actually honour. That is reachable without spending a
   * detection, so it is tested.
   */
  window.__lmEdge = () => ({
    ft: state.edgeFt,
    max: MAX_EDGE_FT,
    step: EDGE_STEP_FT,
    field: document.getElementById('edge-ft')?.value,
    note: document.getElementById('sens-note')?.textContent || '',
  });
  window.__lmSetEdge = (v) => { setEdgeFt(v); return state.edgeFt; };

  /* Developer mode: whether it is unlocked, and what it would send. */
  window.__lmDev = () => ({
    on: state.dev,
    /*
     * Real visibility, not the element's own `hidden` attribute. The panel
     * once sat inside the measure step, so its own attribute said "shown"
     * while an ancestor kept it off screen -- a diagnostic that reports
     * visible for something nobody can see is worse than none.
     */
    panelVisible: document.getElementById('dev-panel').offsetParent !== null,
    overrides: devOverrides(),
    blocked: devPromptBlocked(),
    model: state.model,
    inverts: modelInverts(state.model),
    /* Which methods the picker is offering right now -- the thing that has to
     * differ between an ordinary visitor and an unlocked one. */
    offered: offeredModels().map((m) => m.id),
  });

  /*
   * Choose a method without going through the <select>.
   *
   * The picker lives inside the measure step, so it is not visible until an
   * address has been confirmed -- and the developer-mode checks run on a fresh
   * page, deliberately, to prove the key survives a reload. This drives the
   * real setModel path; that the picker itself lists and switches methods is
   * covered where the measure step is actually on screen.
   */
  window.__lmSetModel = (id) => { setModel(id); return state.model; };

  /* lng/lat -> a point on screen, so a test can aim at a shape that is really
   * there rather than at the middle of the map and hope. */
  window.__lmProject = (lngLat) => {
    if (!map || !Array.isArray(lngLat)) return null;
    const p = map.project(lngLat);
    return { x: p.x, y: p.y };
  };

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

  /*
   * What the current mode will actually let a tap reach.
   *
   * This IS the mode mechanism -- editableRings() is what handleMapPoint
   * searches, so whatever it returns is precisely the set of things that can
   * be selected right now. Reporting it directly beats aiming a synthetic tap
   * at a corner and inferring from the result: a tap can miss for reasons that
   * have nothing to do with modes (the shape moved, the corner went
   * off-screen), and then the check reports "modes are broken" about a
   * gesture that hit empty space.
   */
  window.__lmEditable = () => ({
    mode: state.mode,
    tool: state.shapeTool,
    ids: editableRings().map((r) => r.featureId),
    parcelId: PARCEL_ID,
    // Draw's own mode: 'static' means a finger cannot drag a whole shape.
    drawMode: (() => { try { return draw.getMode(); } catch { return null; } })(),
  });

  /*
   * Every shape's full outline, to the coordinate.
   *
   * Centroids were not enough to catch the bug this exists for: a stroke
   * re-traced every shape on the map, so vertices everywhere shifted by a
   * fraction of a pixel while the centroid barely moved. Comparing the actual
   * coordinate lists is the only way to see it.
   */
  window.__lmRings = () => draw.getAll().features
    .map((f) => outerRing(f))
    .filter(Boolean)
    .map((ring) => ring.map((p) => [...p]));

  /*
   * The brush, as both numbers that have to agree: what the preview line
   * draws, and what the raster actually paints. The bug was that they did not.
   */
  window.__lmBrush = () => ({
    size: state.brushSize,
    diameterPx: brushDiameterPx(),
    previewWidth: map?.getLayer('erase-stroke')
      ? map.getPaintProperty('erase-stroke', 'line-width')
      : null,
  });

  /*
   * The map's own gesture settings, for proving north stays north and that a
   * tool never takes panning away with it.
   *
   * dragPan is the one that matters: it is a single handler for one finger and
   * two, so a brush that switched it off to protect its stroke also removed the
   * two-finger pan. "Is it still enabled while a brush is live" is the exact
   * question, and it is not answerable by looking at the screen.
   */
  window.__lmGestures = () => ({
    bearing: map ? map.getBearing() : null,
    pitch: map ? map.getPitch() : null,
    dragRotate: Boolean(map?.dragRotate?.isEnabled()),
    dragPan: Boolean(map?.dragPan?.isEnabled()),
    touchZoom: Boolean(map?.touchZoomRotate?.isEnabled()),
    panning: panningHeld(),
    holdMs: PAN_HOLD_MS,
  });

  /*
   * Which step is on screen, and what it is offering.
   *
   * The rail is reported alongside the tab because they are one decision: the
   * map's buttons and the panel's tools belong to the same step, and the bug
   * this guards against is them disagreeing -- a brush live on the map while
   * the panel shows the boundary editor.
   */
  window.__lmTabs = () => ({
    on: state.tab,
    tabs: TABS.slice(),
    visiblePanes: TABS.filter((t) => document.querySelector(`#pane-${t}`)?.hidden === false),
    rail: MODES.filter((m) => document.querySelector(`#mode-${m}`)?.hidden === false),
    locked: TABS.filter((t) => Boolean(tabLock(t))),
    noticeVisible: document.querySelector('#lock-notice')?.hidden === false,
    handEdited: state.handEdited,
    hasParcel: Boolean(state.parcel),
  });

  /*
   * The feedback question: whether it is up, and whether it should be.
   *
   * `detected` travels with it because the rule worth checking is not "does
   * the dialog open" but "does it open about something the AI produced". A
   * question with no possible answer is how people learn to dismiss dialogs.
   */
  window.__lmFeedback = () => ({
    open: document.querySelector('#feedback')?.hidden === false,
    detected: Boolean(state.detected && state.lastMask),
    asked: asked.size,
  });

  /*
   * Who is signed in, and whether this deployment can sign anybody in.
   *
   * Both, because the property worth checking is that they agree: a button
   * offering a sign-in that cannot work is worse than no button, and a signed
   * -in person with no button is a session nobody can get out of.
   */
  window.__lmAccount = () => ({
    accountsOn: state.accountsOn,
    user: state.user,
    emailSignin: state.emailSignin,
  });

  /* The saved maps, as the list itself would show them. */
  window.__lmSaves = () => ({
    max: MAX_SAVES,
    entries: (signedIn() ? state.saves : readLocalSaves()).map((s) => ({
      id: s.id, address: s.address, mode: s.mode,
      model: s.model, squareFeet: s.squareFeet, at: s.at,
    })),
    rendered: [...document.querySelectorAll('#saved-list .save-addr')].map((n) => n.textContent),
  });

  /* The phantom midpoints, where they are on screen, ready to be tapped. */
  window.__lmMidpoints = () => {
    if (!state.edgeEdit) return [];
    const rect = map.getCanvasContainer().getBoundingClientRect();
    return midpointHandles().map((m) => {
      const at = map.project(m.at);
      return { featureId: m.featureId, edgeIndex: m.edgeIndex,
        x: rect.left + at.x, y: rect.top + at.y };
    });
  };

  /* Every shape's centroid, for proving nothing moved when it should not. */
  window.__lmCentroids = () => draw.getAll().features.map((f) => {
    const ring = outerRing(f) || [];
    const n = Math.max(1, ring.length);
    return ring.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
  });

  /* Whether the numbered markers are actually ON the map right now. */
  window.__lmPinsDrawn = () => {
    const src = map?.getSource('lawn-pins');
    return Boolean(src?._data?.features?.length);
  };

  /*
   * The tip, and whether its arrow really points at the control it names.
   *
   * Reporting "a tip is showing" would pass for a box in the corner pointing
   * at nothing, which is the only way this feature can fail: the words are
   * static text and cannot be wrong, the aim can. So hand back both rectangles
   * -- the arrow's and the target button's -- and let the check compare them.
   */
  window.__lmTip = () => {
    const box = document.getElementById('coach');
    const arrow = document.getElementById('coach-arrow');
    const t = tips.target?.getBoundingClientRect();
    const a = arrow.hidden ? null : arrow.getBoundingClientRect();
    return {
      stage: tips.stage,
      visible: !box.hidden,
      targetId: tips.target?.id || null,
      /*
       * Whether the thing being pointed at is actually on screen.
       *
       * The failure this exists for is silent in both directions: showTip
       * declines to open when its target is hidden, so the tip simply never
       * appears, and a tip that DID open while its target got hidden would
       * point at nothing. Moving the tools onto tabs made both reachable, and
       * the first tip in the app stopped appearing with nothing failing.
       */
      targetVisible: Boolean(tips.target && tips.target.offsetParent !== null),
      text: document.getElementById('coach-text').textContent,
      arrow: a ? { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 } : null,
      target: t ? { left: t.left, right: t.right, top: t.top, bottom: t.bottom } : null,
    };
  };

  /* The imagery catalogue as the Worker described it, for checks that must be
   * made against what this deployment really offers rather than a hard-coded
   * list (Google only exists when a key is configured for it). */
  window.__lmImageryCatalogue = () => state.imagery.map((p) => ({ ...p }));

  /* The detection methods this deployment offers, which is what decides
   * whether the picker appears at all, plus which one is selected and whether
   * it inverts -- the flag that cannot be checked by looking at the map. */
  window.__lmModels = () => ({
    chosen: state.model,
    panelVisible: !document.getElementById('model-panel').hidden,
    options: state.models.map((m) => ({ ...m })),
    /*
     * The exclusion boxes as they actually are on screen, not as state thinks.
     * `rendered` is read back out of the DOM on purpose: the bug worth catching
     * is a tick list that has drifted from the boxes somebody is looking at.
     */
    excludes: {
      // Real visibility, not the element's own attribute -- the panel sits
      // inside the measure step, which has its own hidden ancestor.
      visible: document.getElementById('exclude-panel')?.offsetParent != null,
      ticked: state.exclude.slice(),
      rendered: [...document.querySelectorAll('#exclude-list input')]
        .map((b) => ({ id: b.id.replace(/^excl-/, ''), checked: b.checked })),
      cost: document.getElementById('exclude-cost')?.textContent || '',
    },
  });

  /* The on-map source list: what it offers, and which one is ticked. */
  window.__lmLayers = () => {
    const list = document.getElementById('layer-list');
    return {
      buttonVisible: !document.getElementById('maprail-left').hidden,
      open: !list.hidden,
      options: [...list.querySelectorAll('button')].map((b) => ({
        id: b.dataset.provider,
        checked: b.getAttribute('aria-checked') === 'true',
      })),
    };
  };

  window.__lmImagery = () => ({
    provider: state.provider,
    detectsWith: effectiveProvider(state.provider),
    detectedWith: state.detectedWith,
    layer: !!(map && map.getLayer('imagery-alt')),
    sourceType: map?.getSource('imagery-alt')?.type ?? null,
    corners: map?.getSource('imagery-alt')?.coordinates ?? null,
    // The frame as this source serves it: for Google that is a whole zoom
    // level, and the photograph must be compared against THAT rectangle.
    frameCorners: state.frame ? frameCorners(frameFor(state.provider, state.frame)) : null,
    frameImageUrl: state.frame && !providerInfo(state.provider).tiles
      ? imageryUrlFor(state.provider, frameFor(state.provider, state.frame))
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

  const {
    mapboxToken, imagery, models, exclusions, defaultExclusions, accounts,
  } = await api('/api/config');
  state.accountsOn = Boolean(accounts);
  state.imagery = Array.isArray(imagery) ? imagery : [];
  state.models = Array.isArray(models) ? models : [];
  state.exclusions = Array.isArray(exclusions) ? exclusions : [];
  state.exclude = Array.isArray(defaultExclusions)
    ? defaultExclusions.slice()
    : state.exclusions.filter((e) => e.byDefault).map((e) => e.id);
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
    /*
     * NORTH IS UP, AND STAYS UP.
     *
     * A two-finger twist is easy to do by accident while pinching to zoom, and
     * a rotated aerial photograph is genuinely disorienting: the roof you were
     * using to find your house is suddenly at the wrong angle, and there is no
     * compass on screen to put it back with (the navigation control is built
     * without one). Worse for this app than for a map in general -- every
     * measurement is read against a satellite image, and "which way is the
     * street" is how a person checks they are looking at the right lot.
     *
     * Tilt goes with it. There is nothing to see in three dimensions here, and
     * a pitched view makes the shapes on the ground the wrong shape.
     */
    bearing: 0,
    pitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    // Required so the map canvas can still be read after the browser has
    // composited it -- without this, "Save image" produces a blank PNG.
    preserveDrawingBuffer: true,
  });
  // The constructor flag covers the mouse; this is the two-finger twist, which
  // is a separate handler and the one that actually gets triggered by accident.
  map.touchZoomRotate.disableRotation();
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

  /*
   * A locked mode of our own.
   *
   * The shapes must be undraggable except in Move mode, and Draw's built-in
   * `static` is not registered in this build -- changeMode('static') threw,
   * the fallback quietly put it back in simple_select, and every shape stayed
   * draggable while the code claimed otherwise. The browser check caught it by
   * asking Draw what mode it was actually in, which is the only reason this is
   * not still shipping.
   *
   * So define one. A mode that renders every feature and registers no
   * handlers is the whole requirement, and it cannot go missing from a
   * library version.
   */
  draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    defaultMode: 'simple_select',
    modes: {
      ...MapboxDraw.modes,
      [LOCKED_MODE]: {
        onSetup() { this.setActionableState(); return {}; },
        toDisplayFeatures(state, geojson, display) { display(geojson); },
      },
    },
  });
  map.addControl(draw);

  for (const evt of ['draw.create', 'draw.update', 'draw.delete']) {
    map.on(evt, refreshMeasurement);
  }

  // A polygon drawn while "Draw the property line" is armed becomes the
  // boundary rather than a patch of lawn.
  map.on('draw.create', (e) => {
    if (!state.drawingParcel) {
      // A patch drawn by hand is a hand correction, whether it is the first
      // shape on the map or the tenth on top of a detection.
      markHandEdited();
      return;
    }
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
      // Phantoms are smaller and see-through: present enough to aim at,
      // faint enough that the real corners still read as the real corners.
      'circle-radius': [
        'case',
        ['==', ['get', 'selected'], 1], 8,
        ['==', ['get', 'phantom'], 1], 4,
        5,
      ],
      'circle-color': ['case', ['==', ['get', 'selected'], 1], '#ff6f00', '#ffffff'],
      'circle-opacity': ['case', ['==', ['get', 'phantom'], 1], 0.45, 1],
      'circle-stroke-width': ['case', ['==', ['get', 'phantom'], 1], 1.5, 2],
      'circle-stroke-opacity': ['case', ['==', ['get', 'phantom'], 1], 0.55, 1],
      'circle-stroke-color': ['case', ['==', ['get', 'selected'], 1], '#7a3500', '#2f7d32'],
    },
  });

  /*
   * The application plan: pieces to walk, and the pass count written on each.
   *
   * Added before `surveyed` so the survey dots stay on top of it, and drawn
   * with a fill light enough to read the grass through -- the picture has to
   * work as a thing you hold up and compare against what is in front of you,
   * which means the lawn underneath must still be recognisable.
   */
  map.addSource('segments', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'segments-fill', type: 'fill', source: 'segments',
    paint: {
      // Alternating so two neighbouring pieces are never the same colour.
      // Which piece is which matters more than what the colours mean, and
      // stripes are the cheapest way to say "this one, not that one".
      'fill-color': ['case', ['==', ['%', ['get', 'index'], 2], 0], '#ffffff', '#ffe082'],
      'fill-opacity': 0.22,
    },
  });
  map.addLayer({
    id: 'segments-line', type: 'line', source: 'segments',
    paint: { 'line-color': '#1b5e20', 'line-width': 2, 'line-opacity': 0.9 },
  });
  /*
   * Labels on their OWN point source, not on the polygons.
   *
   * Mapbox places a polygon's label at its centroid, and the centroid of a
   * band bent around a corner is in the neighbour's driveway. planSegments
   * already works out a point that is guaranteed to be inside the piece, so
   * the label is anchored to that instead of to a number Mapbox derives.
   */
  map.addSource('segment-labels', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'segments-label', type: 'symbol', source: 'segment-labels',
    layout: {
      'text-field': ['get', 'caption'],
      'text-size': 12,
      'text-line-height': 1.2,
      // Overlapping labels are unreadable, but a piece with NO label is a
      // piece somebody cannot follow -- so they are kept apart by padding
      // rather than dropped.
      'text-allow-overlap': false,
      'text-padding': 2,
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
    },
    paint: {
      'text-color': '#10281a',
      'text-halo-color': '#ffffff',
      'text-halo-width': 2,
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

  /*
   * Touching the map puts the tip away.
   *
   * A tip is advice about what to do next, and the moment someone starts doing
   * something it is a box sitting in the middle of their photograph. It cannot
   * swallow the gesture that dismisses it -- this fires only for taps that
   * reached the map, so pressing "Got it" still goes to the button.
   */
  map.on('click', () => { if (tips.stage) hideTip(); });
  map.on('dragstart', () => { if (tips.stage) hideTip(); });

  /*
   * Which segments are long enough to deserve a phantom midpoint is a question
   * about screen pixels, so zooming changes the answer. On `moveend` rather
   * than `move`: projecting every vertex on every animation frame is real work
   * for a dot that nobody can tap mid-gesture anyway.
   */
  map.on('moveend', () => { if (state.edgeEdit) drawPoints(); });

  // The map moves under a fixed box, so a tip pinned to a rail button has to
  // be re-aimed when the layout changes rather than when the map pans.
  map.on('resize', placeTip);

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
  // The address tab is where you land: the property line is the first thing
  // that has to be right, and everything after it is measured against it.
  $('#work-address').textContent = state.chosen?.label || '';
  setTab('address');
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
      // Names the next STEP rather than the next button, because the button is
      // on a tab you are not looking at -- "press Detect" with no Detect on
      // screen reads as the app having lost it.
      setStatus(
        `Found your property line — ${a.acres} acres total ` +
        `(${state.parcel.properties.county}). Check it, then open AI to detect ` +
        'your lawn — or Draw to trace it yourself.'
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

    /*
     * You land on step one, whether or not the county had a line on file.
     *
     * Skipping ahead when there is a boundary looks helpful and is not. The
     * boundary is the thing every later number is measured against, and the
     * first tip exists to say "check it before you detect" -- advice that
     * cannot be given from a tab where the tool it names is not on screen.
     * Moving to step two yourself is one press, and it is the press that
     * teaches what the tabs are.
     */
    setTab('address');

    updatePromptHint();
    // The pickers measure against the frame, so they only become real once
    // there is one.
    buildImageryPicker();
    buildModelPicker();
    refreshRail();
    refreshPins();
    setHint(state.parcel
      ? 'Check the property line, then open the AI or Draw step'
      : 'Trace your property line first');
    showTip('parcel');
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
/**
 * Brush sizes, as DIAMETERS in screen pixels.
 *
 * Diameters, and stated once, because the previous bug was exactly the
 * confusion this prevents: the preview line was 24 px WIDE while the brush
 * painted a 22 px RADIUS, so every stroke came out 44 px across -- 1.8 times
 * the line the user had just watched themselves draw. Both numbers now come
 * from here, and the preview is set from the same constant that drives the
 * raster, so they cannot drift apart again.
 *
 * Two sizes because the job is two jobs. Rubbing out a driveway wants a
 * roller; taking a foot off the edge of a bed wants a pencil, and one brush
 * cannot be both without being wrong for one of them.
 */
const BRUSH_PX = { fine: 12, bulk: 40 };
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

/** The live brush width on screen, in pixels. One number, two consumers. */
const brushDiameterPx = () => BRUSH_PX[state.brushSize] || BRUSH_PX.bulk;

/**
 * Make the preview line exactly as wide as the brush actually paints.
 *
 * This is the whole fix for "it paints a strip about double the brush": the
 * only brush the user can see is this line, so it IS the brush as far as they
 * are concerned, and any disagreement between it and the raster is the tool
 * lying about what it is going to do.
 */
function refreshBrushWidth() {
  if (map?.getLayer('erase-stroke')) {
    map.setPaintProperty('erase-stroke', 'line-width', brushDiameterPx());
  }
  for (const size of Object.keys(BRUSH_PX)) {
    $(`#size-${size}`)?.setAttribute('aria-pressed', String(state.brushSize === size));
  }
}

function setBrushSize(size) {
  if (!BRUSH_PX[size]) return;
  state.brushSize = size;
  refreshBrushWidth();
  setStatus(size === 'fine'
    ? 'Fine brush. Narrow enough to trim an edge or take out a path.'
    : 'Bulk brush. Wide, for clearing or filling a whole area quickly.');
}

function enterEraserMode(mode = 'erase') {
  const spec = BRUSH[mode] || BRUSH.erase;
  if (spec.needsShapes && !draw.getAll().features.some((f) => outerRing(f))) {
    setStatus('Nothing to erase yet — detect or draw a lawn first.', 'warn');
    return;
  }
  eraser = { stroke: [], mode: BRUSH[mode] ? mode : 'erase' };
  refreshBrushWidth();
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
 * The property line, painted into a pixel grid.
 *
 * One definition, used by detection to trim the AI's answer and by the brush
 * to stop you painting over the boundary. Two copies of "which pixels are
 * inside the lot" would be two chances to disagree about where someone's
 * property ends, on the same screen, in the same measurement.
 *
 * Returns null when there is no boundary, which callers read as "no limit"
 * rather than "nothing is allowed".
 */
function parcelRaster(w, h, project) {
  if (!parcelRing() || !state.parcel) return null;
  const rings = state.parcel.geometry.type === 'Polygon'
    ? state.parcel.geometry.coordinates
    : state.parcel.geometry.coordinates[0];
  return rasterizePolygon(rings, w, h, project);
}

/** The brush's radius on the ground, in degrees-ish, for reach tests. */
function brushGroundRadius() {
  const a = map.unproject([0, 0]);
  const b = map.unproject([brushDiameterPx() / 2, 0]);
  // Longitude degrees are the wider of the two here, so using them for both
  // axes overestimates reach slightly. Overestimating is the safe direction:
  // it can only pull a shape INTO the re-trace that did not need it.
  return Math.max(Math.abs(b.lng - a.lng), Math.abs(b.lat - a.lat));
}

/** The ground the stroke can affect: its extent, grown by the brush. */
function strokeBounds(stroke, pad) {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lng, lat] of stroke) {
    w = Math.min(w, lng); e = Math.max(e, lng);
    s = Math.min(s, lat); n = Math.max(n, lat);
  }
  return [w - pad, s - pad, e + pad, n + pad];
}

const boxesOverlap = (a, b) =>
  Boolean(a && b) && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/**
 * Apply the stroke: paint the shapes, punch out the stroke, trace what is left.
 */
function applyErase() {
  const stroke = eraser?.stroke || [];
  const mode = BRUSH[eraser?.mode] || BRUSH.erase;
  const features = draw.getAll().features.filter((f) => outerRing(f));
  // Erasing nothing is a no-op; adding to nothing is how you start.
  if (stroke.length < 2 || (!features.length && mode.paint === 0)) return;
  markHandEdited();

  /*
   * Only re-trace what the stroke actually reached.
   *
   * This is the "using the brush subtly shifts every point in the whole shape"
   * bug. Rasterising a polygon and tracing it back is lossy -- corners land on
   * pixel centres and the simplifier trims them -- so a shape that makes that
   * round trip comes back a little smaller. Do it on every stroke and the
   * shrinking accumulates, which is what the nudging is.
   *
   * The bounding box below only narrows the field to shapes worth rasterising,
   * and is not the test. A box that overlaps is not proof of contact: swipe
   * the add brush inside a square you already have and its box overlaps, so
   * the coarse test alone still sent it round the loop and still shaved its
   * corners, for a stroke that changed nothing. The real test is pixel
   * contact with the stroke, made further down once there is a raster to make
   * it against, and after that a check for whether the stroke altered a single
   * pixel at all.
   */
  const strokeBox = strokeBounds(stroke, brushGroundRadius());
  const candidates = features.filter((f) => boxesOverlap(strokeBox, geometryBounds(f.geometry)));

  // A frame around everything involved, so nothing outside it is lost. Built
  // from the candidates alone, which also makes its pixels finer.
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  const see = ([lng, lat]) => {
    w = Math.min(w, lng); e = Math.max(e, lng);
    s = Math.min(s, lat); n = Math.max(n, lat);
  };
  for (const f of candidates) for (const ring of f.geometry.coordinates) ring.forEach(see);
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

  // Each candidate's own pixels, kept separately: which of them the stroke
  // really reaches is decided below, and that needs them one at a time.
  const rasters = candidates.map(
    (f) => rasterizePolygon(f.geometry.coordinates, ERASE_GRID, ERASE_GRID, project)
  );

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
  const b = map.unproject([brushDiameterPx() / 2, 0]);
  const brushMetres = Math.hypot(
    (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180),
    (b.lat - a.lat) * 111320
  );
  const radius = Math.max(1, brushMetres / metresPerPixel(frame, ERASE_GRID));

  /*
   * Adding stops at the property line; erasing never needs to.
   *
   * Painting past the boundary put someone else's ground into the total, and
   * because a brush stroke is loose by nature it happened by accident rather
   * than by intent -- a wide brush run along the frontage would pick up the
   * verge and the neighbour's grass without anyone meaning it. The line is
   * already the thing the AI is trimmed to, so the brush honouring it makes
   * the two agree.
   *
   * The toggle exists because the boundary is not always where the mowing
   * stops: a recorded parcel often ends at the easement while the owner mows
   * to the kerb. Extending the edge is the better answer there, because it
   * keeps the boundary meaningful -- but the choice belongs to the person who
   * knows the property.
   */
  const limit = (mode.paint && !state.measureOutside)
    ? parcelRaster(ERASE_GRID, ERASE_GRID, project)
    : null;

  /*
   * Paint the stroke into a mask of its OWN, rather than straight into the
   * shapes. Which shapes it truly reaches is the whole question below, and
   * that cannot be asked once the two are mixed together.
   */
  const strokeMask = new Uint8Array(ERASE_GRID * ERASE_GRID);
  const disc = (cx, cy) => {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(ERASE_GRID - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(ERASE_GRID - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
        const idx = y * ERASE_GRID + x;
        if (limit && !limit[idx]) continue; // outside the lot: not yours to add
        strokeMask[idx] = 1;
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

  /*
   * WHICH SHAPES THE STROKE ACTUALLY REACHED, in pixels rather than in
   * bounding boxes.
   *
   * This is the rest of the "the brush nudges every corner inward" bug. The
   * first fix spared shapes the stroke came nowhere near, which was real but
   * only half of it: a box that OVERLAPS is not proof of contact. Swipe the
   * add brush inside a square you already have and its box overlaps, so the
   * square went through rasterise-and-retrace and came back with its corners
   * resnapped to the pixel grid -- a little smaller, every single time, for a
   * stroke that changed nothing whatsoever.
   *
   * Sharing one pixel with the stroke is the real test, and it is exact for
   * both directions: erasing can only alter a shape it overlaps, and adding
   * can only grow or merge one it overlaps. A stroke that touches nothing
   * becomes its own new shape and leaves every existing one alone.
   */
  const reaches = (m) => {
    for (let i = 0; i < m.length; i++) if (m[i] && strokeMask[i]) return true;
    return false;
  };
  const touched = candidates.filter((f, i) => reaches(rasters[i]));
  const untouched = features.filter((f) => !touched.includes(f));

  // The touched shapes as one raster, before the stroke is applied to it.
  const keep = new Uint8Array(ERASE_GRID * ERASE_GRID);
  for (let i = 0; i < candidates.length; i++) {
    if (!touched.includes(candidates[i])) continue;
    const m = rasters[i];
    for (let p = 0; p < keep.length; p++) if (m[p]) keep[p] = 1;
  }

  /*
   * Now the stroke, and a check for whether it changed anything at all.
   *
   * Rubbing out where there is nothing, or painting over ground already
   * counted, is a stroke with no effect -- and the round trip is not free, so
   * "no effect" has to mean the shapes are left strictly alone rather than
   * rebuilt identically. Returning here is what makes an idle swipe cost
   * nothing: no history entry to undo, no redraw, no resnapped corners.
   */
  let changed = false;
  for (let p = 0; p < keep.length; p++) {
    if (!strokeMask[p]) continue;
    if (keep[p] === mode.paint) continue;
    keep[p] = mode.paint;
    changed = true;
  }
  if (!changed) {
    setStatus(mode.paint
      ? 'That is already counted as lawn.'
      : 'Nothing to erase there.');
    return;
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
  // The shapes the brush never reached go back exactly as they were, keeping
  // every corner the user placed by hand.
  for (const f of untouched) draw.add(f);
  for (const geometry of polygons) draw.add({ type: 'Feature', properties: {}, geometry });

  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();

  const count = polygons.length + untouched.length;
  const sections = `${count} section${count > 1 ? 's' : ''}`;
  setStatus(
    mode.paint
      ? `Added. ${sections} of lawn.`
      : count
        ? `Erased. ${sections} left.`
        : 'Erased everything. Undo, or detect again.'
  );
}

/**
 * Trim everything on the map back inside the property line.
 *
 * The detection SURVIVES this. That is the point of doing it here rather than
 * by detecting again: the shapes are transformed where they stand, so going
 * back to measuring inside the boundary costs neither the wait nor the money
 * of a second prediction, and nothing that was already inside the line moves.
 *
 * Same round trip as the brush -- rasterise, intersect, re-trace -- because
 * clipping a polygon to an arbitrary boundary is the operation that pixel grid
 * already does exactly, including splitting one shape into several where the
 * line cuts through it.
 */
function clipShapesToParcel() {
  const features = draw.getAll().features.filter((f) => outerRing(f));
  if (!features.length || !parcelRing()) return { trimmed: 0, before: 0, after: 0 };

  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  const see = ([lng, lat]) => {
    w = Math.min(w, lng); e = Math.max(e, lng);
    s = Math.min(s, lat); n = Math.max(n, lat);
  };
  for (const f of features) for (const ring of f.geometry.coordinates) ring.forEach(see);

  const pad = 0.0004;
  const bbox = [w - pad, s - pad, e + pad, n + pad];
  const frame = {
    lng: (bbox[0] + bbox[2]) / 2,
    lat: (bbox[1] + bbox[3]) / 2,
    zoom: zoomToFit(bbox, ERASE_GRID / 2),
    size: ERASE_GRID / 2,
  };
  const project = (ll) => lngLatToFramePx(frame, ll, ERASE_GRID, ERASE_GRID);
  const inside = parcelRaster(ERASE_GRID, ERASE_GRID, project);
  if (!inside) return { trimmed: 0, before: 0, after: 0 };

  /*
   * Only round-trip the shapes that actually cross the line.
   *
   * The same lossy loop as the brush, in a second place. Rasterising a polygon
   * and tracing it back snaps its corners to pixel centres, and here the frame
   * spans EVERY shape at once -- so one blob painted out at the edge of the
   * map stretches the frame, coarsens every pixel in it, and the untouched
   * lawn in the middle comes back measurably smaller for it. Toggling
   * "measure outside the line" off cost about 3% of a real lot that way, none
   * of which had anything to do with the boundary.
   *
   * A shape wholly inside the parcel has nothing to clip, so it is passed
   * through vertex for vertex. Only shapes with pixels on the wrong side go
   * into the raster -- and a shape wholly OUTSIDE simply contributes nothing
   * to it, which is how it disappears.
   */
  const keep = new Uint8Array(ERASE_GRID * ERASE_GRID);
  const untouched = [];
  for (const f of features) {
    const m = rasterizePolygon(f.geometry.coordinates, ERASE_GRID, ERASE_GRID, project);
    let outside = 0;
    for (let i = 0; i < m.length; i++) if (m[i] && !inside[i]) { outside = 1; break; }
    if (!outside) { untouched.push(f); continue; }
    for (let i = 0; i < keep.length; i++) if (m[i] && inside[i]) keep[i] = 1;
  }

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

  const before = totalSquareFeet();
  pushHistory();
  draw.deleteAll();
  // The shapes that were already inside go back exactly as they were.
  for (const f of untouched) draw.add(f);
  for (const geometry of polygons) draw.add({ type: 'Feature', properties: {}, geometry });

  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();

  const after = totalSquareFeet();
  return { trimmed: Math.max(0, before - after), before, after };
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
  // Two buttons, one state: the panel's and the one on the map. Undo is
  // pressed while looking at whatever went wrong, which is on the map.
  for (const id of ['#btn-undo', '#rail-undo']) {
    const btn = $(id);
    if (btn) btn.disabled = history.length === 0;
  }

  /*
   * On a step with no map tools of its own, Undo is the only reason the rail
   * exists -- so whether there is anything to undo decides whether the rail is
   * on screen at all. Without this the bar would appear and disappear one
   * refresh late, or not at all.
   */
  if (map) refreshRail();
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
/*
 * WHY THE TOUCH LISTENERS SIT ON THE CONTAINER, IN THE CAPTURE PHASE.
 *
 * Mapbox registers its own touch handlers on the canvas container, and it
 * registers them at construction -- before any of ours. Two listeners on the
 * same element both run, in registration order, and preventDefault does not
 * stop the other one. So while a brush was armed there was no way to say "this
 * drag is mine" except `map.dragPan.disable()`.
 *
 * That worked, and it is what made the map unpannable with a tool selected:
 * dragPan is ONE handler covering one finger and two, so switching it off to
 * protect a brush stroke also switched off the two-finger pan that would have
 * been the way out.
 *
 * Capturing on the container -- the parent of the element Mapbox listens on --
 * means our handler runs FIRST and can decide, per event, who the gesture
 * belongs to. stopPropagation keeps a one-finger paint away from the map;
 * letting the event through hands the map a real two-finger gesture with its
 * own handlers fully enabled, so pan and pinch-zoom work exactly as they do
 * with no tool armed. Nothing is disabled, so nothing has to be remembered and
 * put back.
 *
 * The mouse keeps dragPan.disable(), because Mapbox listens for mousemove on
 * the document and a capture listener on the map cannot get in front of that.
 * A mouse has no second finger to pan with anyway; press-and-hold is its way
 * out, and that path drives the map directly.
 */
function armLawnPicker() {
  diag.armed = true;
  map.getCanvas().style.cursor = 'crosshair';
  map.on('click', onMapClick);
  const el = map.getContainer();
  el.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  // Not passive: a gesture we claim has to stop the page scrolling under it,
  // and preventDefault is the only way to say so.
  el.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  el.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  el.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
  el.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function disarmLawnPicker() {
  diag.armed = false;
  endPanHold();
  endDrag();
  map.getCanvas().style.cursor = '';
  map.off('click', onMapClick);
  const el = map.getContainer();
  el.removeEventListener('touchstart', onTouchStart, { capture: true });
  el.removeEventListener('touchmove', onTouchMove, { capture: true });
  el.removeEventListener('touchend', onTouchEnd, { capture: true });
  el.removeEventListener('touchcancel', onTouchEnd, { capture: true });
  el.removeEventListener('mousedown', onMouseDown);
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
}

/* ------------------------------------------------- panning with a tool on */
/**
 * Press and hold, and the tool gets out of the way.
 *
 * The complaint this answers: with a brush selected there was no way to move
 * the map. Every drag painted. On a phone that is a dead end -- you cannot
 * reach the part of the lawn that is off screen without first putting the tool
 * away, scrolling, and picking it up again, three times per lawn.
 *
 * Two ways out, because they suit different moments. Two fingers is the one
 * people already know and it needs no waiting, so it is the main answer. A
 * held press is the one-handed answer, and half a second is long enough that
 * no ordinary brush stroke starts with one: a stroke begins by moving, and any
 * movement at all cancels the hold.
 *
 * The pan is driven here rather than handed back to Mapbox. Handing over
 * mid-gesture means Mapbox has to pick up a drag it never saw begin, which it
 * has no way to do; panBy from our own deltas is exact, works identically for
 * a finger and a mouse, and cannot leave the map in a half-started state.
 */
const PAN_HOLD_MS = 500;
let panHold = null; // { x, y, timer, active }

/**
 * Which kind of pointer started the gesture in progress.
 *
 * It decides how the map is kept still while a tool paints, and the two
 * answers are not interchangeable. A touch gesture is stopped by claiming the
 * event in the capture phase, which leaves every Mapbox handler enabled and
 * ready for a second finger. A mouse cannot be stopped that way -- Mapbox
 * listens for mousemove on the document, in front of which nothing on the map
 * can get -- so it still needs dragPan switched off and switched back on.
 *
 * Using the mouse answer for touch is the bug this replaces: dragPan is one
 * handler for one finger and two, so disabling it to protect a brush stroke
 * disabled the two-finger pan as well.
 */
let gestureIsTouch = false;

/** Stop the map moving under a stroke, by whichever means suits the pointer. */
function holdMapStill() {
  if (!gestureIsTouch) map.dragPan.disable();
}

function beginPanHold(x, y) {
  cancelPanHold();
  panHold = {
    x, y, active: false,
    timer: setTimeout(() => {
      if (!panHold) return;
      panHold.active = true;
      // Whatever was half-drawn belongs to the gesture being abandoned.
      discardStroke();
      map.getCanvas().style.cursor = 'grabbing';
      $('#pan-badge').hidden = false;
      setHint('Panning — lift your finger to go back to the tool');
    }, PAN_HOLD_MS),
  };
}

/** Movement means it was a stroke after all, so the hold never matures. */
function cancelPanHold() {
  if (panHold?.timer) clearTimeout(panHold.timer);
  panHold = null;
}

const panningHeld = () => Boolean(panHold?.active);

/** Drag the map by the distance the pointer has travelled since the last event. */
function panHoldTo(x, y) {
  if (!panHold) return;
  map.panBy([panHold.x - x, panHold.y - y], { duration: 0 });
  panHold.x = x;
  panHold.y = y;
}

function endPanHold() {
  const was = panningHeld();
  cancelPanHold();
  if (!was) return false;
  $('#pan-badge').hidden = true;
  map.getCanvas().style.cursor = eraser || diag.armed ? 'crosshair' : '';
  updatePromptHint();
  return true;
}

/**
 * Abandon a stroke without applying it.
 *
 * A pan must not erase a swathe of lawn on its way past, and a second finger
 * landing mid-stroke is a person changing their mind about what this gesture
 * was. endDrag() would commit what had been painted so far; this throws it
 * away, which is the only safe reading of "I did not mean that".
 */
function discardStroke() {
  if (eraser) {
    eraser.painting = false;
    eraser.stroke = [];
    drawEraseStroke();
    map.dragPan.enable();
  }
  drag = null;
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
  /*
   * In Move mode the drag belongs to Draw. Snapshot first so the move can be
   * undone: Draw reports the change only after it has happened, by which time
   * the previous position is gone. The key collapses one drag into one entry.
   */
  if (state.mode === 'move') {
    pushHistory('move');
    return false;
  }
  if (eraser) {
    eraser.stroke = [];
    eraser.painting = true;
    holdMapStill();
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
    holdMapStill();
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
  if (e.button !== 0) return;
  gestureIsTouch = false;
  beginPanHold(e.clientX, e.clientY);
  beginDrag(e.clientX, e.clientY);
}

function onMouseMove(e) {
  if (panningHeld()) {
    panHoldTo(e.clientX, e.clientY);
    e.preventDefault();
    return;
  }
  if (movedEnoughToCancelHold(e.clientX, e.clientY)) cancelPanHold();
  if (updateDrag(e.clientX, e.clientY)) e.preventDefault();
}

function onMouseUp() {
  // A held press that turned into a pan is not also a click on the map.
  if (endPanHold()) { handled = { at: Date.now(), x: null, y: null }; return; }
  // A click follows a mouseup. Suppress it after a real drag so releasing the
  // finger does not immediately re-select whatever is under it.
  if (endDrag()) handled = { at: Date.now(), x: null, y: null };
}

/** Has the pointer travelled far enough that this is a stroke, not a hold? */
function movedEnoughToCancelHold(x, y) {
  return Boolean(panHold) && !panHold.active
    && Math.hypot(x - panHold.x, y - panHold.y) > TAP_SLOP_PX;
}

/**
 * One finger is the tool's. Two are the map's. A held one is the map's too.
 *
 * Every branch either claims the gesture -- stopPropagation, so Mapbox's own
 * handlers never see it -- or lets it through untouched. There is no third
 * state, and nothing is left disabled afterwards, which is what went wrong
 * with the version that switched dragPan off: the switch protected the brush
 * and took the way out with it.
 */
function onTouchMove(e) {
  if (panningHeld()) {
    const t = e.touches[0];
    if (t) panHoldTo(t.clientX, t.clientY);
    claim(e);
    return;
  }

  /*
   * A SECOND FINGER HANDS THE MAP BACK.
   *
   * Not swallowed, so Mapbox gets a genuine multi-touch gesture with pan and
   * pinch-zoom both live -- the ordinary map behaviour, available without
   * putting the tool down. Whatever the first finger had started is thrown
   * away rather than committed: two fingers is somebody changing their mind,
   * not somebody finishing a stroke.
   */
  if (e.touches.length !== 1) {
    cancelPanHold();
    discardStroke();
    touchStart = null;
    return;
  }

  const t = e.touches[0];
  if (movedEnoughToCancelHold(t.clientX, t.clientY)) cancelPanHold();
  if (updateDrag(t.clientX, t.clientY)) claim(e);
}

/** This gesture is ours: no map pan, no page scroll, no Mapbox handlers. */
function claim(e) {
  e.preventDefault();
  e.stopPropagation();
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
  /*
   * Deliberately NOT claimed, however many fingers there are.
   *
   * Mapbox arms its pan on touchstart and only acts on touchmove, so letting
   * the start through costs nothing and keeps its handlers primed. Swallowing
   * it would leave the map unable to pan even once we decide the gesture is
   * not ours -- which is the whole point of deciding per move.
   */
  if (e.touches.length !== 1) {
    // Two fingers is a zoom or a pan, never a tap, and never a stroke.
    touchStart = null;
    cancelPanHold();
    discardStroke();
    return;
  }
  gestureIsTouch = true;
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() };
  beginPanHold(touchStart.x, touchStart.y);
  beginDrag(touchStart.x, touchStart.y);
}

function onTouchEnd(e) {
  const start = touchStart;
  touchStart = null;

  // A held press that became a pan is not a tap on whatever is underneath it.
  if (endPanHold()) return;

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

  /*
   * Ignore taps only while a polygon is being drawn.
   *
   * This used to require simple_select, which was a proxy for "not mid-draw"
   * and stopped being true the moment shapes were locked with `static`. The
   * question it is really asking is whether Draw is collecting points for a
   * new outline; ask that.
   */
  if (/^draw_/.test(String(mode))) {
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
/*
 * Does this method trace the mask inverted?
 *
 * Every shipped method answers for itself. The Testing method has no answer of
 * its own on purpose: it exists so a prompt can be tried without also
 * inheriting Subtract's inversion and threshold, which is the exact ambiguity
 * that made panel results unreadable -- a surprising number had two possible
 * causes and the screen could not say which. So for that one the checkbox in
 * the panel decides, and nothing else does.
 */
const modelInverts = (id) =>
  modelInfo(id).devOnly ? state.devInvert : Boolean(modelInfo(id).invert);

const modelInfo = (id) =>
  state.models.find((m) => m.id === id)
  // The fallback must default `invert` to false, not leave it undefined: an
  // unknown id already means something has gone wrong, and the safe reading of
  // a mask you cannot identify is the literal one.
  || { id, label: id, needsPoints: false, invert: false };

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
    state.detectedBy === state.model &&
    // A different set of tick boxes is a different question, even on the same
    // method and the same photograph. Without this the button would stay dark
    // after unticking "Woods", which reads as the app being stuck rather than
    // as a saving.
    (!excludesWanted() || state.detectedExcluding === excludeKey());

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

  /*
   * Exclude mode with nothing ticked has no question to ask.
   *
   * It would not be a cheap detection, it would be a meaningless one: the
   * answer is "your whole lot is lawn", which the app already knows for free
   * from the property line. Refused here as well as in the Worker, because
   * being told after the press why nothing happened is worse than the button
   * saying what it needs.
   */
  const needsExclusion = excludesWanted() && !state.exclude.length;

  // Nothing to measure outside of until there is a boundary to be outside of.
  $('#outside-opt').hidden = needsParcel;

  refreshTreesOption();

  // A locked tab greys its controls out, but the button has to be genuinely
  // dead as well: opacity is not a guard, and a keyboard can still reach it.
  const locked = Boolean(tabLock('detect'));

  $('#btn-detect').disabled =
    !state.frame || same || needsPins || needsParcel || needsExclusion || locked;
  $('#btn-detect').textContent = locked
    ? 'Corrected by hand'
    : same
      ? 'Lawn detected'
      : needsParcel
        ? 'Property line needed first'
        : needsPins
          ? 'Tap your lawn to place a pin'
          : needsExclusion
            ? 'Tick something to remove'
            : state.detected
              ? 'Detect again'
              : 'Detect my lawn';

  // "Correct it by hand" is only an offer once there is something to correct.
  const toDraw = $('#btn-to-draw');
  if (toDraw) toDraw.hidden = !hasLawn();

  // ...and its opposite number one step earlier: "Find the lawn" appears once
  // there is a boundary to measure inside, which is what finishing step one
  // means. Updated from here because this already runs on every change that
  // could produce or remove a property line.
  const toDetect = $('#btn-to-detect');
  if (toDetect) toDetect.hidden = !parcelRing();
}

/* ---------------------------------------------------------- model picker */

/*
 * The methods on offer here and now.
 *
 * Developer-only ones travel in the catalogue and are filtered out here rather
 * than withheld by the Worker -- which runs whatever id it is given, so
 * withholding the name would suggest a guard that does not exist.
 */
const offeredModels = () =>
  state.models.filter((m) => !m.devOnly || state.dev);

function buildModelPicker() {
  const select = $('#model-choice');
  const offered = offeredModels();
  if (offered.length < 2) { $('#model-panel').hidden = true; return; }

  select.innerHTML = '';
  for (const m of offered) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    select.append(opt);
  }
  select.value = state.model;
  $('#model-panel').hidden = false;
  $('#model-note').textContent = modelInfo(state.model).note || '';
  buildExclusions();
}

/* ------------------------------------------------------------- exclusions */
/*
 * What to take off the property, one tick box per concept.
 *
 * These are separate boxes rather than one longer prompt because the model
 * resolves ONE CONCEPT PER PREDICTION -- a comma list comes back as one vague
 * phrase, and at three concepts it can collapse to nothing and hand back the
 * whole parcel looking like a clean answer. So each concept is its own
 * prediction, and the masks are added together before anything is traced.
 *
 * Which makes the cost real and visible: four ticks is four predictions, four
 * items of the daily allowance and four times the money for one press. The
 * cost line is not decoration.
 */
function exclusionInfo(id) {
  return state.exclusions.find((e) => e.id === id) || { id, label: id, note: '' };
}

/** A stable fingerprint of the tick set, for "have I already run this?". */
const excludeKey = () => state.exclude.slice().sort().join(',');

const excludesWanted = () => Boolean(modelInfo(state.model).exclusions);

/**
 * Which arithmetic the tree option is currently answering for.
 *
 * The measurement on screen wins over the picker, because the option re-traces
 * what is already there -- and the picker can be changed without detecting
 * again, which would otherwise flip the box under a result it does not belong
 * to.
 */
const fillGapsMode = () =>
  (state.lastMask ? Boolean(state.lastMask.subtractive) : excludesWanted())
    ? 'exclude'
    : 'find';

/**
 * Put the remembered answer for this mode in the box, and say what it does
 * HERE.
 *
 * The same sentence cannot describe both. Finding grass, filling a gap is a
 * correction to the model. Excluding objects, it is an override of a box the
 * user ticked -- worth offering, since the trees prompt reads about 25% wider
 * than the trees really are, but not worth doing silently.
 */
function refreshTreesOption() {
  const opt = $('#trees-opt');
  if (!opt) return;
  const mode = fillGapsMode();
  const box = $('#toggle-trees');
  box.checked = Boolean(state.fillGaps[mode]);

  /*
   * NAME THE THRESHOLD, because "small" is the entire question.
   *
   * The cut-off is a real number -- TREE_GAP_SQFT -- and it is what decides
   * whether the shed in the middle of the lawn gets counted as grass. Leaving
   * it as "small" made the option something to try and see, which on a lot
   * with a pool is a wrong total that looks like a right one. The figure comes
   * from the constant rather than the sentence, so the two cannot drift.
   *
   * Built from nodes rather than innerHTML. There is no user text in here
   * today and there does not need to be a first time.
   */
  const note = $('#trees-note');
  note.textContent = '';
  const gap = `${TREE_GAP_SQFT.toLocaleString()} square feet`;
  const bold = (t) => { const b = document.createElement('b'); b.textContent = t; return b; };

  if (mode === 'exclude') {
    note.append(
      'Gaps left inside your lawn are counted as grass again — including ',
      bold('small trees'),
      ` the box above removed. "Small" means under ${gap}.`
    );
  } else {
    note.append(
      'Canopy hides lawn that is really there. ',
      bold('Small gaps'),
      ` inside your lawn — under ${gap} — are counted as grass; bigger ones `,
      '(a pool, a shed) are not.'
    );
  }
}

function buildExclusions() {
  const list = $('#exclude-list');
  if (!list) return;
  list.innerHTML = '';

  for (const e of state.exclusions) {
    const row = document.createElement('label');
    row.className = 'excl-item';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `excl-${e.id}`;
    box.checked = state.exclude.includes(e.id);
    box.addEventListener('change', () => toggleExclusion(e.id, box.checked));

    const text = document.createElement('span');
    text.textContent = e.label;
    if (e.note) {
      const note = document.createElement('small');
      note.textContent = e.note;
      text.append(note);
    }

    row.append(box, text);
    list.append(row);
  }

  refreshExclusions();
}

function toggleExclusion(id, on) {
  state.exclude = on
    ? [...new Set([...state.exclude, id])]
    : state.exclude.filter((x) => x !== id);
  refreshExclusions();
  // A different set of boxes is a different question, so the button has to
  // come back to life -- see updatePromptHint.
  updatePromptHint();
}

function refreshExclusions() {
  const panel = $('#exclude-panel');
  if (!panel) return;
  panel.hidden = !excludesWanted();
  if (panel.hidden) return;

  for (const e of state.exclusions) {
    const box = $(`#excl-${e.id}`);
    if (box) box.checked = state.exclude.includes(e.id);
  }

  const n = state.exclude.length;
  const cost = $('#exclude-cost');
  if (!cost) return;

  /*
   * Say the cost before it is spent.
   *
   * There used to be a warning here about ticking Trees and Woods together --
   * two boxes measuring the same ground at twice the price. They are one box
   * now, which is the better fix: a warning about a trap is worse than not
   * digging it.
   */
  /*
   * Cost, not time. The passes run together again, so a second box costs a
   * second prediction and barely any extra wait -- see the note in index.js
   * about the sequential version, which was built on a wrong diagnosis and
   * charged real seconds for it.
   */
  cost.textContent = n === 0
    ? 'Nothing ticked — there is nothing for the AI to remove.'
    : `${n} AI pass${n > 1 ? 'es' : ''} per detection, out of your daily allowance.`;
  cost.style.color = n === 0 ? '#b3261e' : '';
}

function setModel(id) {
  if (id === state.model) return;
  state.model = id;
  $('#model-choice').value = id;
  $('#model-note').textContent = modelInfo(id).note || '';
  refreshExclusions();

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

  // The panel's note names the method it is driving, so it has to follow.
  refreshDevPanel();
}

/* ------------------------------------------------------------- detection */

/**
 * Exactly what a detection posts.
 *
 * A named function rather than an object literal inside detect(), so a test can
 * look at the real thing instead of at a reconstruction of it. That distinction
 * is the whole reason this exists: "the developer allowance is not being
 * applied" was reported with the badge reading fifty and the refusal counting
 * against twenty, and every layer had a passing test -- the Worker honours the
 * flag, the badge asks for it -- because nothing tested whether the browser
 * actually PUT it in the body. A second copy of this logic written for a test
 * would have agreed with itself and proved nothing.
 */
function detectionRequest(frame, provider, model, points) {
  return {
    ...frame, provider, model, points, clientId: state.clientId,
    // One prediction per ticked box. Sent even when the method does not use
    // them, because the Worker decides which fields apply and a second copy of
    // that rule here is a second copy that can be wrong.
    exclude: state.exclude,
    /*
     * Asks for the larger developer allowance.
     *
     * `true` or absent, never `false`: the Worker tests `=== true`, and sending
     * an explicit false is a third state for something that has two.
     *
     * Not a credential and not treated as one -- see quota.js for why a
     * client-side secret could not make it stronger than the unlock key that is
     * already plain text in this file.
     */
    ...(state.dev ? { dev: true } : {}),
    ...devOverrides(),
    /*
     * The address and the lot size ride along for the test log. Neither changes
     * what gets detected -- the server measures from the frame -- but "it got
     * my back lawn wrong" cannot be reproduced from a pair of coordinates
     * alone, and the county's own acreage is the yardstick any complaint about
     * a lawn figure is really being made against.
     */
    address: state.chosen?.label || null,
    parcelSqFt: state.parcel ? measure(state.parcel.geometry).squareFeet : null,
    county: state.parcel?.properties?.county || null,
  };
}

async function detect() {
  if (!state.frame) return;

  // Developer mode can type a prompt the encoder cannot take. Stopping here
  // costs nothing; letting it through costs a prediction and an allowance slot
  // for an answer that was never going to arrive.
  const blocked = devPromptBlocked();
  if (blocked) { setStatus(blocked, 'warn'); return; }

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
      body: JSON.stringify(detectionRequest(frame, provider, model, points)),
      /*
       * Room for a throttled pass to wait and try again.
       *
       * Replicate holds each connection for about a minute, and a 429 now backs
       * off for as long as the server asks before retrying. A flat 90 seconds
       * would abort a detection that was merely being patient, leaving the
       * quota spent on predictions nobody collected.
       */
      timeoutMs: 150000,
    });

    // data.frame is authoritative: the server clamps zoom and size, so the
    // frame we sent is not necessarily the frame that was rendered.
    const rendered = data.frame || frame;

    /*
     * Every pass, waited out and downloaded.
     *
     * A cold model takes longer than Replicate will hold the connection, so
     * some passes come back with an id instead of a mask. They are polled in
     * PARALLEL -- four passes waited on one after another would be four cold
     * starts end to end, when they were all started at the same moment and are
     * warming up together.
     */
    const layers = await Promise.all((data.passes || [{ ...data, exclusion: null }])
      .map(async (pass) => {
        const done = pass.status === 'succeeded'
          ? pass
          : await waitForPrediction(pass.id, rendered);
        const url = maskUrl(done.mask);
        if (!url) {
          throw new Error(pass.exclusion
            ? `The detector returned nothing for "${exclusionInfo(pass.exclusion).label}".`
            : 'The detector returned no mask. Try drawing it by hand.');
        }
        return {
          url,
          exclusion: pass.exclusion || null,
          label: pass.exclusion ? exclusionInfo(pass.exclusion).label : null,
          image: await loadMask(url),
        };
      }));

    const subtractive = Boolean(data.subtractive);
    const traced = traceDetection({
      layers, subtractive, rendered,
      // Whatever produced these pixels decides the polarity, not the picker,
      // which the user may change before the next re-trace.
      invert: modelInverts(model),
    });
    const { polygons, collapsed } = traced;

    if (!polygons.length) {
      setStatus(
        subtractive
          ? 'Everything inside your property line was excluded, so there is no lawn left. '
            + 'Untick a box, or draw the lawn by hand.'
          : parcelRing()
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
    /*
     * A fresh detection replaces every shape on the map, so there are no hand
     * corrections left to protect and the lock comes off. Leaving it on would
     * mean the first detection after a corrected one locked itself out.
     */
    state.handEdited = false;
    refreshTabs();
    // The server's word for which source it used, not ours: it falls back for
    // a look-only source, and the status line has to name the real one.
    state.detectedWith = rendered.provider || provider;
    state.detectedBy = data.model || model;
    state.detectedExcluding = excludesWanted() ? excludeKey() : null;
    /*
     * How to read these pixels is stored WITH them, not looked up at re-trace
     * time. The sensitivity slider re-traces this same set, and by then the
     * user may well have changed the method or the tick boxes -- which must not
     * silently reverse the polarity, or the arithmetic, of a measurement
     * already on screen.
     */
    state.lastMask = {
      url: layers[0].url,
      frame: rendered,
      layers,
      subtractive,
      invert: modelInverts(model),
    };
    refreshOverlayLabel();
    if ($('#toggle-overlay').checked) showOverlay();
    refreshSensitivity();
    // The measurement now on screen decides which arithmetic the gap option is
    // answering for, so it has to be re-read against the result rather than
    // against whatever the picker says next.
    refreshTreesOption();

    refreshMeasurement();
    refreshSurveyed();
    updateSelectionButtons();
    refreshRail();
    setHint('Use the buttons on the right of the map to correct the shape');
    showTip('tools');

    const gaps = polygons.filledGaps
      ? ` ${polygons.filledGaps} gap${polygons.filledGaps > 1 ? 's' : ''} counted as grass under trees` +
        ` (about ${Math.round(polygons.filledGapPx * traced.sqFtPerPx).toLocaleString()} sq ft) —` +
        ' untick the box below if any of those is a pool or a shed.'
      : '';

    /*
     * Name any pass that swallowed the whole lot.
     *
     * This is the documented failure of this model: at the wrong cut a concept
     * comes back covering the entire frame, and subtracting that leaves zero
     * lawn. Dropping the pass keeps the other exclusions usable, but doing it
     * silently would report a suspiciously large lawn with no hint that a box
     * the user ticked did nothing.
     */
    const lost = collapsed.length
      ? ` "${collapsed.join('" and "')}" covered the whole lot, so ${collapsed.length > 1 ? 'they were' : 'it was'} ignored —`
        + ' that concept is not usable on this photograph.'
      : '';

    /*
     * Say what the shape limits threw away.
     *
     * Scraps too small to be worth a draggable shape are dropped, and that is
     * the right call -- but they are still lawn, and a total that is short by
     * an unnamed amount is the kind of error nobody can report because there is
     * nothing on screen to point at. Reported only when it adds up to something
     * a person would care about; a few stray pixels along a mask edge is noise
     * in a sentence, not information.
     */
    const droppedSqFt = Math.round((polygons.droppedPx || 0) * traced.sqFtPerPx);
    const scraps = droppedSqFt >= DROPPED_NOTE_SQFT
      ? ` ${polygons.droppedCount} scrap${polygons.droppedCount > 1 ? 's' : ''} too small to edit`
        + ` (about ${droppedSqFt.toLocaleString()} sq ft) ${polygons.droppedCount > 1 ? 'are' : 'is'} not counted —`
        + ' paint them in with Add if they are lawn.'
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
      (subtractive
        ? `${polygons.length} section${polygons.length > 1 ? 's' : ''} of lawn left after removing `
          + `${layers.length} thing${layers.length > 1 ? 's' : ''}`
        : `Found ${polygons.length} section${polygons.length > 1 ? 's' : ''} of lawn`) +
      (parcelRing() ? ', trimmed to your property line' : '') + on + '.' + lost + gaps + scraps +
      ' Correct anything it got wrong.'
    );
  } catch (err) {
    /*
     * An account out of today's passes. 402 rather than 429 because nothing is
     * rate limited -- the day's allowance is simply spent.
     *
     * IT COMES BACK IN THE MORNING, and this sentence used to say the opposite:
     * when credits were a permanent balance it read "you have 0 credits", which
     * sent people looking for a way to buy some. The allowance resets, so the
     * sentence names both ways forward -- wait, or draw it by hand now.
     */
    if (err.status === 402) {
      const b = err.body || {};
      const left = Math.max(0, (b.limit || 0) - (b.used || 0));
      setStatus(
        `${left} of your ${b.limit || 0} AI passes left today and this press `
        + `needs ${b.wanted || 1}. They come back in the morning. `
        + 'Drawing by hand is unlimited and costs nothing — open the Draw step.'
        // Only reachable signed out on a deployment where 402 can happen
        // without an account; harmless either way, and it means the invitation
        // lives in one place rather than in each branch's idea of it.
        + offerMoreDetections(b.limit),
        'warn'
      );
      refreshQuota();
      return;
    }

    if (err.status === 429) {
      const b = err.body || {};

      /*
       * NOT EVERY 429 IS OUR ALLOWANCE.
       *
       * Replicate answers 429 when it throttles the account, and this branch
       * used to read every 429 as a quota refusal -- so an upstream rate limit
       * arrived with no `limit`, `used` or `reason` on it, fell through every
       * test below, and came out as "You've used today's detections" on a
       * counter that had just reset. The Worker had sent the correct sentence;
       * the browser replaced it with a wrong one.
       *
       * Which is why it only happened with more than one box ticked: several
       * boxes fire several predictions at once, and a burst is what trips the
       * throttle. One box never did.
       */
      if (b.rateLimited) {
        /*
         * Show the detector's OWN sentence alongside ours.
         *
         * "The detector is rate limited" is true and unactionable. What it
         * actually says -- "your rate limit for creating predictions is reduced
         * to 6 requests per minute" -- names a number and, in the word
         * "reduced", a condition on the account that the owner can change. That
         * is the difference between waiting and knowing why.
         */
        setStatus(
          `${b.error} Nothing was charged for it.`
          + (b.detail ? ` The detector said: “${b.detail}”` : ''),
          'warn'
        );
        return;
      }

      /*
       * AND NEITHER IS A 429 THAT CARRIES NO ACCOUNTING AT ALL.
       *
       * Fixing the rate-limit case above only fixed the case that announced
       * itself. Every OTHER 429 still fell through to the daily-limit sentence:
       * one from Cloudflare's edge, a throttle from a proxy, anything that
       * answers with an HTML body the client cannot parse. `err.body` is null
       * for those, so `used` and `limit` are undefined, every test below is
       * false, and the app confidently blames an allowance it never consulted.
       *
       * Our own refusal always carries both numbers. If they are not here, this
       * did not come from our counter, and saying so beats inventing a cause.
       */
      if (!Number.isFinite(b.used) || !Number.isFinite(b.limit)) {
        setStatus(
          `${b.error || 'The detector turned that request away.'} `
          + 'This is not your daily limit — try again in a minute, '
          + 'or draw the lawn by hand.',
          'warn'
        );
        return;
      }

      /*
       * "You have used today's detections" is a lie when four are left and this
       * press wanted five. The counter on screen would plainly disagree with
       * the refusal, which reads as the app being broken rather than as a
       * choice the user can change by unticking a box.
       */
      const left = Number.isFinite(b.limit - b.used) ? b.limit - b.used : null;
      const short = b.wanted > 1 && left !== null && left > 0;
      /*
       * NAME THE CEILING THAT REFUSED IT.
       *
       * "You've used today's detections" was true and useless. The badge said
       * fifty left and the refusal counted against twenty, and the message
       * carried neither number -- so the one screen that could have shown the
       * two halves disagreeing showed a sentence instead. A refusal that
       * reports "20 of 20" next to a badge reading 50 diagnoses itself.
       */
      const counted = left !== null ? ` (${b.used} of ${b.limit} used)` : '';

      /*
       * THE INVITATION GOES ON THE "YOU ARE OUT" CASE ONLY.
       *
       * Not on `short`, where there are passes left and the answer is to untick
       * a box -- offering an account there would be answering a question
       * nobody asked with a sign-up. And not on the shared-network refusal,
       * where an account genuinely would not help: the address ceiling is the
       * one limit an account does not raise, so saying it would is a promise
       * the next press would break.
       */
      setStatus(
        short
          ? `That needs ${b.wanted} AI passes and you have ${left} left today. `
            + 'Untick a box or two, or draw the lawn by hand.'
          : b.reason === 'shared-network'
            ? `Your network has hit today's detection limit${counted}. You can still draw the lawn by hand.`
            : `You've used today's detections${counted}. You can still draw the lawn by hand.`
              + offerMoreDetections(b.limit),
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

/**
 * Say which way round the overlay is.
 *
 * This checkbox exists to catch misalignment, and it does that by inviting the
 * eye to confirm "the white bit is on the grass". In exclude mode the white bit
 * is on the HOUSE, and a check meant to expose a bug becomes a very convincing
 * report of one. The mask is raw either way -- what changes is what was asked
 * for -- so the label has to say which.
 *
 * And with several passes there are several masks, of which only the first is
 * drawn: overlaying four translucent bitmaps would produce a grey wash that
 * cannot be aligned against anything. Naming the one on show is the difference
 * between a partial view and a wrong one.
 */
function refreshOverlayLabel() {
  const el = $('#overlay-label');
  if (!el) return;
  const mask = state.lastMask;
  const layers = mask?.layers || [];
  const first = layers[0];

  el.textContent = mask?.subtractive
    ? `Show the raw AI mask — this is "${first?.label || 'the first pass'}"`
      + (layers.length > 1 ? ` (1 of ${layers.length}), ` : ', ')
      + 'so it covers what was removed, not the lawn'
    : mask?.invert
      ? 'Show the raw AI mask — this covers what was removed, not the lawn'
      : 'Show the raw AI mask (alignment check)';
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

/**
 * The frame as the chosen source will actually serve it.
 *
 * Mirrors providerFrame() in the Worker. Google Static Maps takes whole zoom
 * levels only and floors anything else, so asking it for z19.66 returns z19 --
 * a photograph of a wider piece of ground than the frame describes. Left
 * unadjusted here, the preview would be laid on the frame's corners and every
 * feature in it would sit about 60% too far from the centre: a picture that
 * looks perfectly sharp and is in the wrong place.
 *
 * Floored, never rounded, on both sides for the same reason: rounding up
 * crops, and a parcel that fitted the frame would lose its edges.
 */
const frameFor = (provider, frame) =>
  (frame && providerInfo(provider).integerZoom
    ? { ...frame, zoom: Math.floor(frame.zoom) }
    : frame);

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
  buildLayerList();
}

/* ------------------------------------------------------- the Layers button */
/*
 * The same choice, on the map.
 *
 * The picker in the panel works, but it is below a result, a status line, two
 * other panels and a row of buttons -- and on a phone the panel is under the
 * map entirely, so choosing a photograph means scrolling away from the
 * photograph. The stack-of-sheets icon is the one control everybody already
 * knows means "change what I am looking at", so it goes where everybody
 * expects it: the opposite edge from the editing tools.
 */
function buildLayerList() {
  const list = $('#layer-list');
  list.innerHTML = '';

  for (const p of state.imagery) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(p.id === state.provider));
    b.dataset.provider = p.id;

    const label = document.createElement('span');
    label.textContent = p.label;
    b.append(label);

    // Which sources the AI can be pointed at is the single most consequential
    // thing about this list, and it is invisible in the pictures themselves.
    if (!p.detect) {
      const tag = document.createElement('span');
      tag.className = 'viewonly';
      tag.textContent = 'view only';
      b.append(tag);
    }

    b.addEventListener('click', () => {
      closeLayerList();
      setProvider(p.id);
    });
    list.append(b);
  }
}

/** Repaint the ticks without rebuilding, so the open list does not flicker. */
function refreshLayerList() {
  for (const b of $('#layer-list').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.provider === state.provider));
  }
}

function closeLayerList() {
  $('#layer-list').hidden = true;
  $('#btn-layers').setAttribute('aria-pressed', 'false');
}

function toggleLayerList() {
  const list = $('#layer-list');
  const open = list.hidden;
  list.hidden = !open;
  $('#btn-layers').setAttribute('aria-pressed', String(open));
  if (open) refreshLayerList();
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
  refreshLayerList();

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
/*
 * Which fetch is allowed to paint.
 *
 * showImagery is async and is fired from more than one place, one of them
 * deliberately un-awaited when the frame is rebuilt. Two calls could therefore
 * both run hideImagery(), both wait on their fetch, and both addSource --
 * which throws "There is already a source with ID imagery-alt" and leaves the
 * map without the picture either of them was fetching.
 *
 * A counter settles it, and settles ordering too: a slow fetch for the source
 * you have just switched AWAY from must not paint over the one you switched
 * to, however long it took to arrive.
 */
let imageryRun = 0;

async function showImagery() {
  const run = ++imageryRun;
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

  // The frame this source will really serve, not the one we asked for -- the
  // picture has to be laid on the ground it actually covers.
  const served = frameFor(state.provider, state.frame);
  const url = imageryUrlFor(state.provider, served);

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
    if (!res.ok) {
      /*
       * Say which kind of failure this is, because they need opposite actions.
       *
       * "No photograph of this spot" is a real answer -- NAIP genuinely has
       * gaps -- but it was also what got said when a brand new Google key was
       * refused for not having its API enabled. That sentence sent someone
       * looking for a coverage problem while the response body sat there
       * saying "This API project is not authorized to use this API".
       *
       * A 4xx from the source is the source refusing US: configuration, not
       * geography. Anything else is the picture genuinely not being there.
       */
      let body = null;
      try { body = await res.json(); } catch { /* not our JSON: keep the code */ }
      const err = new Error(body?.reason || `HTTP ${res.status}`);
      err.refused = body?.upstream >= 400 && body?.upstream < 500;
      throw err;
    }
  } catch (err) {
    // A failure for a source the user has already moved on from is not news,
    // and falling back to Mapbox on their behalf would undo their choice.
    if (run !== imageryRun) return;
    idle();
    setStatus(
      err.refused
        ? `${info.label} refused the request — this is a set-up problem, not a gap in the photography. It said: “${err.message}” Staying on Mapbox.`
        : `${info.label} has no photograph of this spot (${err.message}). Staying on Mapbox.`,
      err.refused ? 'error' : 'warn'
    );
    state.provider = 'mapbox';
    $('#imagery-source').value = 'mapbox';
    renderProviderNote('mapbox');
    refreshLayerList();
    return;
  }

  // Someone else has asked for a different picture since this one was
  // requested. Theirs is the one the user is waiting to see.
  if (run !== imageryRun) return;
  hideImagery(); // in case a later-started run already put something up

  map.addSource('imagery-alt', {
    type: 'image', url, coordinates: frameCorners(served),
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

/** Draw's mode when shapes must not be draggable. Registered in initMap. */
const LOCKED_MODE = 'lm_locked';

/* ------------------------------------------------------------- account */
/*
 * SIGNING IN IS OPTIONAL, AND STAYS OPTIONAL.
 *
 * The app worked before accounts existed and still does: measure, correct,
 * keep it in this browser. An account adds one thing -- the maps follow the
 * person rather than the device -- and later it is where detection credits
 * live. Nothing here may become a wall in front of measuring a lawn, so every
 * failure lands on "signed out" rather than on an error page, and a deployment
 * with no account store simply does not show the button.
 *
 * The email address is the identity and a provider is a door to it, which is
 * why a magic link and Google reach the same account. See worker/src/auth.js.
 */
/** What went wrong following a link, in words rather than in a code. */
const SIGNIN_ERRORS = {
  expired: 'That link had expired, or had already been used. Ask for another '
    + '— they work once and last twenty minutes.',
};

function openSheet(id) {
  $(id).hidden = false;
  // The first thing a keyboard lands on should be inside the dialog, not
  // behind it -- otherwise tabbing walks the page underneath.
  $(id).querySelector('input, button:not(.sheet-x)')?.focus({ preventScroll: true });
}
const closeSheet = (id) => { $(id).hidden = true; };

function renderAccountButton() {
  const btn = $('#account-btn');
  if (!btn) return;
  btn.hidden = !state.accountsOn;

  /*
   * Signed in: the first part of the address rather than the whole of it. A
   * topbar is not where a long email belongs, and it is the part people
   * recognise as theirs.
   *
   * Signed out: "1-click sign up" as well as "Sign in", because there being no
   * separate sign-up is the part nobody expects. There is no form and no
   * password -- type an address, press the link in the mail, and that single
   * action both creates the account and signs you into it. A bare "Sign in"
   * reads as a door for people who already have something.
   */
  const me = state.user;
  $('#account-label').textContent = me
    ? me.email.split('@')[0]
    : 'Sign in / 1-click sign up';
}

function renderAccountSheet() {
  const me = state.user;
  if (!me) return;
  $('#account-name').textContent = 'Your account';
  $('#account-email').textContent = me.email;
  /*
   * The day's allowance, not a balance, and the sheet has to say so.
   *
   * This is where somebody looks the moment the badge refuses a press, so it
   * is the place that has to answer "is this coming back". "2 credits left"
   * reads as an account winding down; "2 of 30 AI passes left today" reads as
   * a morning away, which is what it is.
   */
  const daily = me.daily;
  const bought = Number(me.credits || 0);
  $('#account-credits').textContent = me.unlimited
    ? 'Unlimited detections'
    : (daily
      ? `${Math.max(0, daily.limit - daily.used)} of ${daily.limit} AI passes left today`
      : 'Daily AI passes')
      + (bought ? `, plus ${bought.toLocaleString()} bought` : '');
  $('#account-admin').hidden = !me.admin;
}

/**
 * Is an account a thing this visitor could actually get?
 *
 * `emailSignin` is part of it because an UNPROMPTED offer has to be one that
 * works: a deployment with no mail provider cannot send a link, and inviting
 * somebody into a panel that can only apologise is worse than not asking.
 *
 * A deliberate press is the other case and is not gated on it -- see the
 * `force` path in promptSignin. Somebody who taps "sign in" and gets nothing
 * at all has found a broken button; they should get the explanation.
 */
const canOfferAccount = () => state.accountsOn && state.emailSignin && !signedIn();

/*
 * ASKED ONCE A SESSION, NOT ONCE A REFUSAL.
 *
 * Running out of passes is not a single event -- somebody who has run out will
 * press Detect again, and a sheet that reappears every time turns a reasonable
 * offer into something to fight past on the way to drawing by hand. The status
 * line keeps saying it; the sheet asks once.
 */
let offeredAccount = false;

/**
 * Open the sign-in sheet with a reason attached.
 *
 * The sheet's own wording answers "why would I". When it opens because the
 * day's AI passes are gone, that answer is a different one and a better one --
 * it is the thing the person wanted thirty seconds ago -- so the copy is
 * written from the reason rather than being one paragraph that has to cover
 * every way in.
 */
function promptSignin({ title, why, force = false } = {}) {
  if (signedIn() || !state.accountsOn) return false;
  if (!force && (!canOfferAccount() || offeredAccount)) return false;
  offeredAccount = true;

  $('#signin-title').textContent = title || 'Keep your maps';
  $('#signin-why').textContent = why
    || 'An account keeps your measurements across devices, so the lawn you '
    + 'mapped on your phone is there on your laptop. It also raises how many '
    + 'AI detections you get each day.';
  $('#signin-note').textContent = 'No password. We send a link that signs you '
    + 'in and expires in 20 minutes.';
  $('#signin-note').className = 'sheet-note';
  renderSigninOptions();
  openSheet('#signin');
  return true;
}

/**
 * The offer made when the day's passes run out, in one place.
 *
 * Both refusal paths -- 402 for an account, 429 for a browser -- end up here,
 * because "you are out" is the same moment whichever counter said so, and the
 * sentence that follows it should not depend on which branch of an error
 * handler the reader happened to reach.
 */
function offerMoreDetections(limit) {
  if (!canOfferAccount()) return '';
  const more = state.quota?.accountLimit;
  promptSignin({
    title: 'Out of AI passes for today',
    why: more
      ? `A free account gets ${more} AI detections a day instead of `
        + `${limit || state.quota?.limit || 'a handful'}, and keeps your saved `
        + 'maps across devices. No password — just an emailed link.'
      : 'A free account gets more AI detections each day, and keeps your saved '
        + 'maps across devices. No password — just an emailed link.',
  });
  return more
    ? ` A free account gets ${more} a day and saves your maps across devices.`
    : ' A free account gets more each day and saves your maps across devices.';
}

/**
 * One door, so there is nothing to choose between.
 *
 * The panel is a single field and a button. If the site cannot send mail there
 * is no way in at all, and it says that rather than showing a form that would
 * fail on submit.
 */
function renderSigninOptions() {
  $('#signin-email-form').hidden = !state.emailSignin;
  if (state.emailSignin) return;

  $('#signin-note').textContent =
    'This site cannot send email yet, so there is no way to sign in. '
    + 'Measuring and saving to this browser still work.';
  $('#signin-note').className = 'sheet-note warn';
}

/** Ask who is signed in. Never throws: not knowing means signed out. */
async function refreshAccount() {
  if (!state.accountsOn) return;
  try {
    const me = await api('/api/auth/me');
    state.user = me.user || null;
    state.emailSignin = Boolean(me.email);
  } catch {
    state.user = null;
  }
  renderAccountButton();

  /*
   * The moment an account has to be worth making: whatever this browser was
   * holding goes up with it. Showing an empty list where three measurements
   * used to be would be the feature taking something away.
   */
  if (state.user) {
    await liftSavesToAccount();
    if (state.tab === 'saved') renderSaves();
  }
}

/**
 * Read the outcome of a sign-in out of the URL, then take it back out.
 *
 * The Worker lands the browser on a fragment rather than a query string so
 * that the outcome is not left in history, is never sent to the server, and
 * cannot be bookmarked into a page that permanently claims you just signed in.
 * Clearing it with replaceState means a refresh does not say it twice.
 */
function readSigninOutcome() {
  const raw = location.hash.slice(1);
  if (!raw) return;

  const error = raw.startsWith('signin-error=') ? raw.slice('signin-error='.length) : null;
  if (raw !== 'signed-in' && !error) return;

  /*
   * WINDOW.history, SPELLED OUT, and never the bare name in this file.
   *
   * This module declares `let history = []` for the undo stack, which shadows
   * the DOM's `history` for the whole file -- so the bare name is an Array and
   * `.replaceState` is undefined. The failure is nastier than it looks: this
   * runs during boot, on the return from a sign-in link, so the throw took the
   * map's own setup down with it and the visible symptom was "The map didn't
   * load" on a working map, for signed-in visitors only, unfixable by
   * reloading because the fragment was still in the URL.
   */
  window.history.replaceState(null, '', location.pathname + location.search);

  if (error) {
    setStatus(SIGNIN_ERRORS[error] || 'That sign-in did not complete.', 'warn');
    return;
  }
  setStatus('Signed in. Your saved maps now follow you between devices.');
}

/* --------------------------------------------------------------- saves */
/*
 * MAPS YOU HAVE MADE, KEPT SO YOU CAN COME BACK TO THEM.
 *
 * IN THE ACCOUNT WHEN THERE IS ONE, in this browser when there is not. Both
 * are real answers: signing in is optional here and always will be, so the
 * local store is not a stepping stone to be removed -- it is what a
 * signed-out visitor gets, permanently. What an account adds is that the maps
 * follow the person to their laptop instead of staying on the phone.
 *
 * Every save is a self-contained, JSON-serialisable record of one measurement
 * -- address, boundary, shapes, and the settings that produced them -- which
 * is what made moving it to a table a change to four functions rather than to
 * everything that touches a save. See loadSaves/putSave/dropSave.
 *
 * WHAT MAKES TWO SAVES THE SAME SAVE: the address, the AI method, and which
 * arithmetic it used. Those three are what a person is choosing between when
 * they say "the other one I did for this house" -- the same lot measured by
 * finding grass and by excluding objects are two genuinely different answers
 * worth keeping side by side, and re-running either should update that one
 * rather than pile up a third. Everything else about a measurement is a
 * refinement of one of those, not a new one.
 *
 * Saving happens on its own. A "save" button would mean losing work by
 * forgetting to press it, and there is nothing here worth making somebody
 * decide about: the measurement exists, so it is kept.
 */
const SAVES_KEY = 'lawnmapper.saves.v1';

/**
 * How many maps to keep.
 *
 * Five is the number a phone can show without scrolling and roughly the number
 * of properties anybody is comparing at once. It is a default rather than a
 * limit of the format -- the account version will want more, and nothing about
 * the record shape changes when it does.
 */
const MAX_SAVES = 5;

/** Settle before writing: a brush stroke is a hundred changes and one edit. */
const SAVE_DEBOUNCE_MS = 1200;
let saveTimer = null;

/**
 * Reading and writing, either of which can simply fail.
 *
 * Private browsing refuses localStorage outright, a full quota throws on
 * write, and another tab can leave something unparseable behind. None of that
 * is worth interrupting a measurement over: a history that cannot be kept is a
 * feature that is missing, not a session that is broken.
 */
function readLocalSaves() {
  try {
    const raw = localStorage.getItem(SAVES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.saves) ? parsed.saves : [];
  } catch {
    return [];
  }
}

function writeLocalSaves(saves) {
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify({ v: 1, saves }));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------ the store, either kind */
/*
 * TWO STORES, ONE SHAPE, AND THE REST OF THE FILE CANNOT TELL THEM APART.
 *
 * Signed out, a save lives in this browser and there is nowhere else for it to
 * go. Signed in, it lives in the account and follows the person to their
 * laptop -- which is the whole reason accounts exist here. Everything above
 * and below this point asks for "the saves" and gets them.
 *
 * The account copy is cached in `state.saves` so that drawing the list is not
 * a round trip: it is re-read after every write, and a stale list is the one
 * thing a list of your own measurements must not be.
 */
const signedIn = () => Boolean(state.user);

/** The saves, from wherever this visitor's live. */
async function loadSaves() {
  if (!signedIn()) return readLocalSaves();
  try {
    const out = await api('/api/maps');
    state.saves = Array.isArray(out.maps) ? out.maps : [];
    // The Worker's own cap, not a second copy of the number here. Two
    // constants for one rule drift, and this one is only ever shown to
    // somebody as a promise about how many maps they get to keep.
    if (Number.isFinite(out.max)) state.saveMax = out.max;
    return state.saves;
  } catch {
    /*
     * A network failure falls back to what this browser has rather than to an
     * empty list. "Your saved maps are gone" is a far worse thing to say to
     * somebody than showing them a slightly old copy.
     */
    return state.saves.length ? state.saves : readLocalSaves();
  }
}

/** Keep one. Writes where this visitor's saves live, and nowhere else. */
async function putSave(entry) {
  if (!signedIn()) {
    const saves = readLocalSaves().filter((s) => s.id !== entry.id);
    saves.unshift(entry);
    writeLocalSaves(saves.slice(0, MAX_SAVES));
    return;
  }
  try {
    await api('/api/maps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    state.saves = [entry, ...state.saves.filter((s) => s.id !== entry.id)];
  } catch {
    /*
     * Kept locally when the account could not be reached, so the measurement
     * is not lost -- and picked up by the next sign-in sweep, which is the
     * same path that carries saves made before there was an account at all.
     */
    const saves = readLocalSaves().filter((s) => s.id !== entry.id);
    saves.unshift(entry);
    writeLocalSaves(saves.slice(0, MAX_SAVES));
  }
}

async function dropSave(id) {
  if (!signedIn()) {
    writeLocalSaves(readLocalSaves().filter((s) => s.id !== id));
    return;
  }
  try {
    await api(`/api/maps?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.saves = state.saves.filter((s) => s.id !== id);
  } catch { /* the list is re-read after this, so a failure simply shows */ }
}

/**
 * Hand this browser's saves up to the account, once.
 *
 * SOMEBODY WHO MEASURED THREE LAWNS BEFORE SIGNING UP HAS NOT LOST THEM. That
 * is the entire job here, and it is the moment an account has to be worth
 * making: if the first thing signing in does is show an empty list where three
 * measurements used to be, the feature has taken something away.
 *
 * The account wins on a clash. A map that exists in both was measured on this
 * device and then again somewhere else, and the account's copy is the newer of
 * the two by definition -- it is the one that has been synced since. Sending
 * ours anyway would quietly overwrite a correction made on the laptop.
 */
async function liftSavesToAccount() {
  const local = readLocalSaves();
  if (!local.length) return;

  try {
    const existing = new Set((await api('/api/maps')).maps?.map((m) => m.id) || []);
    const fresh = local.filter((s) => !existing.has(s.id));
    if (fresh.length) {
      await api('/api/maps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maps: fresh }),
      });
    }
    /*
     * Cleared only after they are safely up. Clearing first and failing would
     * be the one outcome worse than not migrating at all.
     */
    writeLocalSaves([]);
    if (fresh.length) {
      setStatus(`${fresh.length} map${fresh.length > 1 ? 's' : ''} from this browser `
        + 'moved into your account.');
    }
  } catch { /* tried again on the next sign-in */ }
}

/** Which arithmetic produced the shapes on screen, in words a save can carry. */
function saveMode() {
  if (!state.detectedBy) return 'manual';
  return modelInfo(state.detectedBy).subtractive ? 'exclude' : 'find';
}

const MODE_LABEL = {
  find: 'Find grass',
  exclude: 'Exclude objects',
  manual: 'Drawn by hand',
};

/** Address + method + arithmetic. Same three, same save. */
const saveKeyFor = (address, model, mode) =>
  `${String(address || '').trim().toLowerCase()}|${model || 'none'}|${mode}`;

/**
 * Everything needed to put this measurement back on the map.
 *
 * Deliberately the whole picture rather than a reference to one: an imagery
 * frame and a set of tick boxes are not recoverable from the shapes, and a
 * saved map that comes back measuring something different from what it said is
 * worse than no saved map.
 */
function snapshotForSave() {
  const shapes = draw.getAll();
  const lawn = shapes.features.filter((f) => outerRing(f));
  if (!lawn.length || !state.chosen) return null;

  const m = measureLawn({ type: 'FeatureCollection', features: lawn });
  const mode = saveMode();

  return {
    id: saveKeyFor(state.chosen.label, state.detectedBy || state.model, mode),
    at: new Date().toISOString(),
    address: state.chosen.label,
    lng: state.chosen.lng,
    lat: state.chosen.lat,
    county: state.parcel?.properties?.county || null,
    model: state.detectedBy || state.model,
    modelLabel: modelInfo(state.detectedBy || state.model).label || null,
    mode,
    provider: state.detectedWith || state.provider,
    exclude: state.detectedExcluding ? state.detectedExcluding.split(',') : [],
    edgeFt: state.edgeFt,
    fillGaps: { ...state.fillGaps },
    handEdited: state.handEdited,
    squareFeet: m.squareFeet,
    acres: m.acres,
    frame: state.frame ? { ...state.frame } : null,
    parcel: state.parcel || null,
    // Ids are Draw's own and mean nothing after a reload, so they are dropped
    // rather than restored into a Draw instance that has its own idea of them.
    shapes: lawn.map((f) => ({ type: 'Feature', properties: {}, geometry: f.geometry })),
  };
}

/** Keep this measurement, replacing the one it supersedes. */
async function recordSave() {
  const entry = snapshotForSave();
  if (!entry) return;
  await putSave(entry);
  if (state.tab === 'saved') renderSaves();
}

/** Called from everywhere a measurement changes; writes once it settles. */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(recordSave, SAVE_DEBOUNCE_MS);
}

async function deleteSave(id) {
  await dropSave(id);
  renderSaves();
}

/** "3 minutes ago", because a timestamp is not what anybody is asking. */
function agoText(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

async function renderSaves() {
  const list = $('#saved-list');
  if (!list) return;

  /*
   * Say something while it loads, rather than showing an empty list that
   * happens to be right for a moment. "Nothing saved yet" appearing and then
   * being replaced by four maps is the list lying to you, briefly, about the
   * thing it exists to be trusted about.
   */
  if (signedIn() && !state.saves.length) $('#saved-lead').textContent = 'Loading your maps…';

  const saves = await loadSaves();
  list.innerHTML = '';

  $('#saved-lead').textContent = saves.length
    ? `${saves.length} of ${MAX_SAVES} kept. Opening one puts it back on the map.`
    : 'Nothing saved yet. Measure a lawn and it is kept here automatically.';

  /*
   * WHERE THESE ACTUALLY LIVE, which is a different answer per visitor.
   *
   * The markup said "Accounts are coming, and will carry them with you" -- true
   * when it was written and now a promise the site already keeps, which is the
   * worst kind of stale copy: it tells somebody to wait for a thing that is on
   * the screen behind it.
   *
   * Signed in, these follow the person; signed out, they are in this browser
   * and one cleared cache from gone. That difference is the whole argument for
   * an account, so this is where it belongs -- next to the maps it is about,
   * rather than only in a sheet nobody opens.
   */
  const note = $('#saved-note');
  const invite = $('#saved-signin');
  if (signedIn()) {
    note.textContent = 'Kept with your account, so they are on every device you '
      + `sign in on.${state.saveMax ? ` Up to ${state.saveMax} of them.` : ''}`;
    invite.hidden = true;
  } else {
    note.textContent = 'Saved in this browser only — clearing your browser data '
      + 'clears these.'
      + (canOfferAccount() ? ' An account keeps them on every device instead.' : '');
    invite.hidden = !canOfferAccount();
  }

  for (const s of saves) {
    const li = document.createElement('li');
    li.className = 'save';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'save-open';
    main.innerHTML = `
      <span class="save-addr"></span>
      <span class="save-meta"></span>
      <span class="save-figure"></span>`;
    main.querySelector('.save-addr').textContent = s.address;
    main.querySelector('.save-meta').textContent =
      `${MODE_LABEL[s.mode] || s.mode}${s.handEdited ? ' · corrected' : ''} · ${agoText(s.at)}`;
    main.querySelector('.save-figure').textContent =
      `${Number(s.squareFeet || 0).toLocaleString()} sq ft`;
    main.addEventListener('click', () => openSave(s.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'save-del';
    del.setAttribute('aria-label', `Forget the ${MODE_LABEL[s.mode] || s.mode} map of ${s.address}`);
    del.textContent = '×';
    del.addEventListener('click', () => deleteSave(s.id));

    li.append(main, del);
    list.append(li);
  }
}

/**
 * Put a saved map back.
 *
 * Restores the settings BEFORE the shapes, so everything that reads them --
 * the pickers, the rail, the measurement -- sees a consistent world. The
 * shapes are the last thing in, and the map is moved to them rather than to
 * the saved frame's centre, because a boundary that was extended after the
 * frame was taken would otherwise sit half off screen.
 */
async function openSave(id) {
  const s = (await loadSaves()).find((x) => x.id === id);
  if (!s) return;

  clearHistory();
  draw.deleteAll();
  hideOverlay();
  state.lastMask = null;

  state.chosen = { label: s.address, lng: s.lng, lat: s.lat };
  state.parcel = s.parcel || null;
  state.frame = s.frame || null;
  state.provider = s.provider || 'mapbox';
  state.model = s.model || 'sam3';
  state.exclude = Array.isArray(s.exclude) ? s.exclude.filter(Boolean) : [];
  state.edgeFt = Number.isFinite(s.edgeFt) ? s.edgeFt : DEFAULT_EDGE_FT;
  state.fillGaps = { find: true, exclude: false, ...(s.fillGaps || {}) };
  state.surveyed = [];
  state.pins = [];

  /*
   * A restored map is somebody else's answer as far as this session is
   * concerned: there is no mask in hand, so the AI cannot be "re-run" on it
   * and the corrections are already baked into the shapes. Marking it
   * hand-edited is the honest reading -- it locks the detection controls until
   * the user explicitly clears, which is exactly the choice they should be
   * making before overwriting a saved measurement.
   */
  state.detected = true;
  state.detectedBy = s.model || null;
  state.detectedWith = s.provider || null;
  state.detectedExcluding = state.exclude.length ? state.exclude.slice().sort().join(',') : null;
  state.handEdited = true;

  map.getSource('parcel').setData(state.parcel || empty());
  for (const f of (s.shapes || [])) {
    draw.add({ type: 'Feature', properties: {}, geometry: f.geometry });
  }

  showStep('work');
  $('#work-address').textContent = s.address;
  $('#chosen-label').textContent = s.address;

  buildImageryPicker();
  buildModelPicker();
  refreshExclusions();
  refreshSensitivity();
  refreshTreesOption();
  refreshSurveyed();
  refreshMeasurement();
  updateSelectionButtons();
  setTab('draw');

  const box = state.parcel ? geometryBounds(state.parcel) : null;
  if (box) {
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 60, duration: 700 });
  } else if (Number.isFinite(s.lng)) {
    map.flyTo({ center: [s.lng, s.lat], zoom: s.frame?.zoom || IMAGERY_ZOOM_FALLBACK, duration: 700 });
  }

  setStatus(`Opened your ${(MODE_LABEL[s.mode] || s.mode).toLowerCase()} map of ${s.address}`
    + ` — ${Number(s.squareFeet || 0).toLocaleString()} sq ft, saved ${agoText(s.at)}.`
    + ' Correct it further, or clear it to detect again.');
  refreshQuota();
}

/* ------------------------------------------------------------ feedback */
/*
 * "HOW DID THE AI DO?" -- ASKED ONCE, AT THE HANDOVER.
 *
 * The AI's answer can only be judged at one moment: it is on screen, the
 * person has looked at it, and they are about to start correcting it. Earlier
 * there is nothing to judge. Later they are elbow-deep in a brush and the
 * original answer no longer exists to have an opinion about.
 *
 * So it is asked exactly there, exactly once per detection, and never for a
 * measurement the AI did not produce -- asking somebody how the machine did on
 * a lawn they drew themselves is a question with no answer.
 *
 * WHAT IS SENT IS ON THE DIALOG, NOT UNDER IT. Answering uploads the map and
 * the address, which together say where an identifiable person lives. That is
 * a sentence above the buttons in ordinary type, because a disclosure nobody
 * reads before pressing is not a disclosure. Skip sends nothing at all, and
 * says so on the button.
 */
let feedbackFor = null; // the detection currently being asked about

/** Has this exact measurement already been asked about? One ask, one answer. */
const asked = new Set();

/**
 * Offer the question, if there is anything to ask about.
 *
 * Silent about every reason not to: no detection, already answered, nothing on
 * the map. A dialog that appears after a hand-drawn lawn would be noise, and
 * one that appears twice for the same detection reads as a bug.
 */
function askFeedback() {
  if (!state.detected || !state.lastMask || !state.chosen) return false;
  const key = `${state.chosen.label}|${state.detectedBy}|${state.detectedExcluding || ''}`;
  if (asked.has(key)) return false;
  asked.add(key);

  feedbackFor = key;
  $('#feedback-note').value = '';
  $('#feedback').hidden = false;
  return true;
}

function closeFeedback() {
  $('#feedback').hidden = true;
  feedbackFor = null;
  /*
   * The tip this dialog jumped in front of.
   *
   * Both want the same moment -- arriving at the drawing tools -- and a
   * coaching box underneath a modal question is a box nobody can read and a
   * question that looks broken. The question goes first because it is modal
   * and asked once; the tip is about tools that will still be there.
   */
  flushPendingTip();
}

/**
 * Send one report, and never let it matter to the person sending it.
 *
 * No await on the way out of the dialog, no error if it fails, no retry. The
 * measurement is what they came for; feedback is a favour they are doing, and
 * a favour that produces an error message is a punishment for helping.
 */
async function sendFeedback(rating) {
  const note = $('#feedback-note').value;
  closeFeedback();
  setStatus('Thank you — that is genuinely how this gets better.');

  const shapes = draw.getAll().features.filter((f) => outerRing(f));
  const m = measureLawn({ type: 'FeatureCollection', features: shapes });

  try {
    await api('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({
        rating,
        note,
        clientId: state.clientId,
        address: state.chosen?.label || null,
        lng: state.chosen?.lng,
        lat: state.chosen?.lat,
        county: state.parcel?.properties?.county || null,
        model: state.detectedBy,
        modelLabel: modelInfo(state.detectedBy).label || null,
        mode: saveMode(),
        provider: state.detectedWith,
        exclude: state.detectedExcluding ? state.detectedExcluding.split(',') : [],
        edgeFt: state.edgeFt,
        fillGaps: $('#toggle-trees').checked,
        squareFeet: m.squareFeet,
        parcelSqFt: state.parcel ? Math.round(measure(state.parcel.geometry).squareFeet) : null,
        frame: state.lastMask?.frame || state.frame || null,
        parcel: state.parcel || null,
        shapes: shapes.map((f) => ({ geometry: f.geometry })),
      }),
    });
  } catch {
    /* A report that did not arrive is not the reporter's problem. */
  }
}

/* ---------------------------------------------------------------- tabs */
/*
 * THREE JOBS, AND ONLY ONE OF THEM IS YOURS AT A TIME.
 *
 * Everything used to be in one column: the address, the AI, the drawing tools
 * and the boundary editor, all on screen and all live. It worked, and it made
 * the app impossible to read. There was no moment at which you had finished
 * with the AI and started correcting by hand -- which is the moment that
 * matters most, because it is where a measurement stops being the machine's
 * answer and starts being yours.
 *
 * So: one tab per job, and the map's own buttons follow the tab. Pressing
 * "Line" while you meant to paint was never a thing anyone wanted to be able
 * to do; now it is not on screen to press.
 *
 * The tab is a view, not a mode -- switching never changes a measurement, and
 * a tab whose tools WOULD change one you have already corrected is greyed out
 * with the reason on it rather than silently allowed to undo your work.
 */
const TABS = ['address', 'detect', 'draw', 'saved', 'plan'];

/**
 * Why a tab's tools are not available, or null when they are.
 *
 * ONE LOCK, AND ONLY ONE. Running the AI again replaces every shape on the
 * map, so doing it by accident from a tab you wandered into destroys hand
 * corrections that took real work. That is worth a gate.
 *
 * THE PROPERTY LINE IS NOT. It was gated too, on the reasoning that moving the
 * boundary re-trims a lawn measured against the old one -- which sounded right
 * and was wrong in practice. Noticing that your lawn runs past the recorded
 * line to the road is something you notice AFTER seeing the detection, and the
 * lock made fixing it cost a second paid detection. Moving the line does not
 * touch the shapes on the map; it changes what the NEXT measurement is clipped
 * to, and the edge tools re-clip what is there for free. Gating a free,
 * reversible correction behind a paid one is the wrong trade.
 */
function tabLock(tab) {
  if (tab === 'detect' && state.handEdited) {
    return {
      /*
       * NAMES WHAT IS STILL LIVE, because two of the controls on this tab are.
       *
       * The lock is about a PAID re-detection replacing work you did by hand.
       * The trees option and the raw-mask overlay cost nothing -- one re-reads
       * a mask already downloaded, the other only draws it -- so they stay
       * usable, and a notice saying "the detection controls are off" while two
       * of them plainly still work is the notice being wrong about its own
       * page.
       */
      text: 'You have corrected this lawn by hand. Running the AI again would '
        + 'throw those corrections away, so detecting is off until you say '
        + 'which you want. The two free settings at the bottom still work.',
      clear: true,
      redetect: true,
    };
  }
  return null;
}

const hasLawn = () => Boolean(draw?.getAll().features.some((f) => outerRing(f)));

/**
 * Anything the user did to the shapes themselves.
 *
 * Not "opened the drawing tab" -- looking at a tool is not using one, and
 * locking the AI because somebody glanced at the brushes would be maddening.
 * The lock is about work that would be lost, so it starts when there is work.
 */
function markHandEdited() {
  if (state.handEdited) return;
  state.handEdited = true;
  refreshTabs();
}

function setTab(name) {
  const next = TABS.includes(name) ? name : 'address';
  state.tab = next;

  /*
   * Leaving a tab puts its map tools away.
   *
   * A mode whose button is no longer on screen is a mode you cannot get out
   * of: the map would still be routing every tap to the brush with nothing
   * visible saying so. Whether the mode belongs to the tab is the same
   * question the rail asks, so it is answered in one place.
   */
  if (state.mode && !modeBelongsTo(state.mode, next)) setMode(null);
  // ...and a tool whose step is locked is not usable either, even if it
  // belongs to the step you are arriving at. See refreshRail.
  else if (state.mode && tabLock(next)) setMode(null);

  for (const t of TABS) {
    const tab = $(`#tab-${t}`);
    const pane = $(`#pane-${t}`);
    if (tab) tab.setAttribute('aria-selected', String(t === next));
    if (tab) tab.classList.toggle('is-on', t === next);
    if (pane) pane.hidden = t !== next;
  }

  if (next === 'saved') renderSaves();
  if (next === 'plan') refreshPlanTab();
  refreshTabs();
  refreshRail();
  updatePromptHint();

  // Arriving at the drawing tools after a detection IS the handover, however
  // you got here -- the tab, the "correct it by hand" button, or a map tool.
  // A tip waiting for this tab queues behind it; see closeFeedback.
  if (next === 'draw' && askFeedback()) return;

  flushPendingTip();
}

/**
 * Show a tip that was waiting for its tab, now that the tab is open.
 *
 * See pendingTip: a tip explaining the brushes is worth reading when you
 * arrive at the brushes, so one that fired while they were a tab away waits
 * rather than being lost or pointed somewhere else.
 */
function flushPendingTip() {
  if (!pendingTip) return;
  const waiting = pendingTip;
  pendingTip = null;
  showTip(waiting); // puts it back if the control is still not on screen
}

/** Which tab each map tool belongs to. One table, two readers. */
const MODE_TAB = { parcel: 'address', pins: 'detect', move: 'draw', shape: 'draw' };
const modeBelongsTo = (mode, tab) => MODE_TAB[mode] === tab;

function refreshTabs() {
  const bar = $('#tabs');
  if (!bar) return;

  const lock = tabLock(state.tab);
  const pane = $(`#pane-${state.tab}`);
  if (pane) pane.classList.toggle('is-locked', Boolean(lock));

  const notice = $('#lock-notice');
  notice.hidden = !lock;
  if (lock) {
    $('#lock-text').textContent = lock.text;
    $('#btn-lock-clear').hidden = !lock.clear;
    $('#btn-lock-redetect').hidden = !lock.redetect;
  }

  // A tab with a lock on it says so on the tab itself, so the reason is
  // findable without opening it and wondering why everything is grey.
  for (const t of TABS) {
    $(`#tab-${t}`)?.classList.toggle('is-locked', Boolean(tabLock(t)));
  }

  /*
   * The plan tab and the button that leads to it both wait for a lawn.
   *
   * A tab of tools that all need a measurement is four taps of nothing before
   * there is one, and the button under the figure would be offering to finish
   * something that has not started. `hasLawn()` is the same test the "correct
   * it by hand" button uses, so the two appear together and mean the same
   * thing by "there is something here now".
   */
  const ready = hasLawn();
  const planTab = $('#tab-plan');
  if (planTab) planTab.hidden = !ready;

  const finish = $('#btn-finish');
  if (finish) finish.hidden = !ready || (state.tab !== 'detect' && state.tab !== 'draw');

  /*
   * The map's half of this step has to follow the lock in the same breath.
   *
   * A lock engages the moment somebody paints, and the rail is redrawn from
   * elsewhere -- so without this the "Line" button stayed pressable until the
   * next unrelated refresh, which is exactly long enough to use it.
   */
  if (map) refreshRail();
}

/**
 * Clear the lawn, keep the property line.
 *
 * "Start over" that also threw away the boundary would be punishing: tracing
 * one by hand is the slowest thing in the app, and it is not what went wrong.
 * So this rewinds exactly as far as the lock was protecting and no further.
 */
function clearLawnAndUnlock({ toDetect = false } = {}) {
  pushHistory();
  draw.deleteAll();
  state.handEdited = false;
  state.detected = false;
  state.detectedExcluding = null;
  state.lastMask = null;
  state.edgeFt = DEFAULT_EDGE_FT;
  hideOverlay();
  refreshSensitivity();
  refreshMeasurement();
  updateSelectionButtons();
  setTab(toDetect ? 'detect' : state.tab);
  setStatus(toDetect
    ? 'Cleared. The property line is kept — press "Detect my lawn" for a fresh answer.'
    : 'Lawn cleared. The property line is kept.');
}

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
const MODES = ['parcel', 'pins', 'move', 'shape'];

function setMode(mode, tool = null) {
  const next = MODES.includes(mode) ? mode : null;

  // Tear the old one down first, so no two modes ever hold the map at once.
  if (eraser) exitEraserMode({ quiet: true });

  /*
   * Hand the map back to Draw in the right state for the mode being entered.
   *
   * Two problems, one lever. The first: selecting a corner leaves Draw in
   * direct_select and it stays there after the mode that selected it has
   * gone, which made the map silently deaf afterwards. The second: in
   * simple_select, Draw lets a finger drag a whole shape -- so a single tap
   * with the eraser could grab the lawn and slide it across the map, which is
   * both invisible while it happens and catastrophic to the measurement.
   *
   * So shapes are LOCKED everywhere except Move mode, using Draw's own
   * `static` mode. Nothing about our tap handling depends on simple_select
   * any more (see handleMapPoint), and moving a whole shape is now a thing
   * you ask for rather than a thing that happens to you.
   */
  setDrawLock(next !== 'move');
  state.edgeEdit = null;
  clearEdgeHighlight();
  clearPoints();
  $('#edge-panel').hidden = true;
  $('#point-controls').hidden = true;
  $('#edge-controls').hidden = true;
  disarmLawnPicker();

  state.mode = next;
  /*
   * Entering lawn mode without naming a tool always lands on Points.
   *
   * Resuming whichever brush was last used means pressing "Lawn" can arm the
   * eraser, and the next drag over the map removes lawn rather than selecting
   * a corner. A destructive tool should be chosen deliberately every time, not
   * inherited from something you did several steps ago.
   */
  if (next === 'shape') state.shapeTool = tool || 'points';

  if (next === 'move') {
    // Our own listeners run first and decline everything here, which is what
    // lets beginDrag() take the undo snapshot before Draw moves the shape.
    armLawnPicker();
    setHint('Tap a shape, then drag it');
    setStatus('Move mode. Drag a whole patch of lawn into place — nothing else responds while this is on.');
  } else if (next === 'parcel') enterRingEditing('parcel');
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

/**
 * Lock or unlock Draw's own dragging.
 *
 * The locked mode renders every shape and responds to nothing, which is
 * exactly what is wanted while a brush or a corner tool owns the gesture.
 * The browser check asserts which mode is actually in force rather than
 * trusting that the call landed -- that is how the missing `static` was found.
 */
function setDrawLock(locked) {
  try {
    const want = locked ? LOCKED_MODE : 'simple_select';
    if (draw.getMode() !== want) draw.changeMode(want);
  } catch {
    try { draw.changeMode('simple_select'); } catch { /* Draw not ready */ }
  }
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
 * How generous to be about the edge of the lawn -- moved without paying again.
 *
 * The first version of this moved the brightness cut used to turn the
 * detector's picture into a yes/no per pixel. That was built on an assumption
 * that turned out to be false for every model actually in use: both return
 * pure black and white, so there are no mid-tones and no line to move. The
 * control correctly reported that it could do nothing, which is honest and
 * useless.
 *
 * What a hard mask does admit is moving the edge itself: pull it in and less
 * counts as lawn, push it out and more does. That is growMask() in mask.js,
 * and it is still free -- the mask is already downloaded and decoded, so this
 * is arithmetic on pixels in hand and runs no new detection.
 *
 * Expressed in feet on the ground rather than pixels, so it means the same
 * thing at every zoom and reads as a decision about a lawn rather than about
 * an image.
 */
const DEFAULT_EDGE_FT = 0;

/**
 * How far the edge tool can move the outline, in feet.
 *
 * WIDENED FROM 3, because 3 was sized for the wrong job. Tidying a lawn edge is
 * a foot or two; correcting an exclusion is not. Measured at Brooks Lane, the
 * AI's idea of the woods is about 25% wider than the owner's -- 42,727 sq ft
 * against 34,500 -- and closing that means pulling the treeline in something
 * like five feet, which the old range could not reach. A control that stops
 * short of the correction it exists for is a control that looks broken.
 *
 * 15 is generous rather than precise: past about ten feet a lawn edge is being
 * invented rather than trimmed, and the number is right there on screen to say
 * so.
 */
const MAX_EDGE_FT = 15;

/** One foot a press: fine enough to aim, coarse enough to get somewhere. */
const EDGE_STEP_FT = 1;

/**
 * Read a typed distance, or refuse it.
 *
 * Returns null for anything that is not a number, so a half-typed "-" or a
 * stray letter leaves the setting alone instead of snapping it to zero and
 * silently re-tracing the lawn underneath the person typing.
 */
function parseEdgeFt(text) {
  const cleaned = String(text).trim().replace(/[^0-9.+-]/g, '');
  /*
   * A DIGIT IS REQUIRED, and leaving that out was a real bug this test caught:
   * stripping "abc" leaves "", and Number("") is 0, not NaN -- so typing a word
   * snapped the outline flat instead of being ignored. Same for "-", "+", "."
   * and the bare "ft" left behind by a half-deleted entry.
   */
  if (!/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // Quarter feet, which is finer than anyone can see on the map and keeps the
  // field from filling with floating-point dust.
  const clamped = Math.min(Math.max(n, -MAX_EDGE_FT), MAX_EDGE_FT);
  return Math.round(clamped * 4) / 4;
}

/** Set the edge distance and re-trace, unless nothing actually changed. */
function setEdgeFt(ft) {
  const next = parseEdgeFt(ft);
  if (next === null) { refreshSensitivity(); return; }
  if (next === state.edgeFt) { refreshSensitivity(); return; }
  state.edgeFt = next;
  refreshSensitivity();
  retrace();
}

/**
 * A pass whose mask covers this much of the property is not an answer.
 *
 * The documented failure of this model is a concept that floods the entire
 * frame: at Brooks Lane the not-lawn prompt masked 100% of the parcel at three
 * different cuts. Subtracting that leaves nothing, so the measurement reads
 * zero and the cause is invisible.
 *
 * 0.98 rather than something like 0.9, because a genuinely wooded lot really
 * can be 95% trees and that is a real answer, not a collapse. The line is set
 * where "there is no lot left at all" begins, and what is dropped is always
 * named on screen.
 */
const COLLAPSE_FRACTION = 0.98;

/**
 * Mask pixels -> polygons, for both questions the app can ask.
 *
 * Shared by the detection and by the sensitivity slider, which re-runs exactly
 * this on masks already downloaded. Keeping it in one place is not tidiness:
 * the two used to be near-copies, and a near-copy of "which way round is this
 * bitmap" is a measurement that can disagree with itself between the moment it
 * was detected and the moment the slider was nudged.
 *
 * TWO ARITHMETICS, and the difference only appears at two masks:
 *
 *   FIND GRASS traces the mask and clips the result to the property line.
 *
 *   EXCLUDE starts from the property line as solid lawn and takes each mask
 *   away. Adding a second exclusion adds a second subtraction, which is what
 *   makes them stack. Inverting each mask instead -- the old arrangement --
 *   would INTERSECT them: a pixel would have to be simultaneously not-a-tree
 *   and not-a-building, and two independently noisy masks intersect to
 *   slivers. Same pixels for one concept, incompatible for two.
 */
function traceDetection({ layers, subtractive, invert, rendered, edgeFt = 0 }) {
  const { width: w, height: h } = layers[0].image;

  // All passes are the same model on the same image, so this should never
  // fire. If it ever does, the layers cannot be combined pixel for pixel and
  // saying so beats indexing one mask with another's dimensions.
  for (const l of layers) {
    if (l.image.width !== w || l.image.height !== h) {
      throw new Error('The detector returned masks of different sizes, so they cannot be combined.');
    }
  }

  const mPerPx = metresPerPixel(rendered, w);
  const sqFtPerPx = (mPerPx ** 2) / 0.09290304;
  // One definition of "inside the lot", shared with the brush -- see
  // parcelRaster. Two copies would be two chances to disagree about where
  // someone's property ends, in the same measurement.
  const clipMask = parcelRaster(w, h, (ll) => lngLatToFramePx(rendered, ll, w, h));

  const options = {
    /*
     * Clip to the property line, always.
     *
     * Asking for "grass" finds every lawn in the photograph, the neighbours'
     * included -- on a real lot that was 3,700 sq ft of someone else's grass,
     * a third of everything detected. Painting the parcel into the same pixel
     * grid and intersecting is exact for any parcel shape and needs no
     * polygon-boolean library.
     */
    clipMask,
    /*
     * FILLING GAPS IS A FIND-GRASS IDEA, AND IT IS WRONG IN EXCLUDE MODE.
     *
     * In find-grass mode a hole in the lawn is somewhere the detector could not
     * see grass, and a small one is usually canopy hiding grass that is really
     * there -- so filling it is the better guess.
     *
     * In exclude mode a hole in the lawn is, by construction, something the
     * user TICKED A BOX to remove. Filling it hands back exactly what they
     * asked to be taken off, and the size test cannot tell a tree clump from a
     * shed any better here than anywhere else.
     *
     * Worse, it changed with the number of boxes. A tree clump touching the
     * property line is not an enclosed hole, so nothing filled it; tick
     * buildings as well and the extra subtraction can close the gap around that
     * same clump, which turns it into a hole and fills it back in as lawn. So
     * adding a second exclusion could ADD square footage -- the thing that
     * cannot happen when you take more away, and the reason this is off here.
     */
    /*
     * FILLING GAPS MEANS OPPOSITE THINGS IN THE TWO MODES, which is why the
     * answer is remembered per mode rather than read off one global switch.
     *
     * Finding grass, a hole in the lawn is somewhere the detector could not see
     * -- usually canopy over grass that is really there -- so filling it is the
     * better guess and it is on by default.
     *
     * Excluding objects, a hole IS the thing a ticked box removed. Filling it
     * hands that straight back, and at 900 sq ft the limit covers most
     * individual trees, so the box would largely undo itself. Off by default
     * here, and still offered, because the trees prompt reads about 25% wider
     * than the trees really are and giving the small gaps back is a reasonable
     * thing to want. Deliberate, not silent.
     */
    fillGapsUnderPx: $('#toggle-trees').checked
      ? Math.round(TREE_GAP_SQFT / sqFtPerPx)
      : 0,
    /*
     * The same hole, in the other limit.
     *
     * Holes below this are not traced at all, which counts them as lawn just
     * as effectively as filling them -- and unlike the tick box, nothing on
     * screen says so. The default is 0.15% of the frame, around 90 sq ft on a
     * typical lot: a shed, a hot tub, a parking pad. Fine when a hole means
     * "the model did not find grass here"; wrong when it means "the user
     * ticked a box to remove this".
     *
     * Not zero, because every speck along a mask edge would then become a ring
     * to trace and a handle to drag. MIN_HOLE_SQFT is below anything anyone
     * would call an object, which is the line that belongs here.
     */
    minHoleFraction: subtractive
      ? (MIN_HOLE_SQFT / sqFtPerPx) / (w * h)
      : undefined,
    /*
     * How many separate pieces of lawn to hand back.
     *
     * Six is plenty for "find the grass", which comes back as a front lawn, a
     * back lawn and some strips. Exclude mode is different in kind: every
     * concept subtracted cuts the remainder into more pieces, and a lot with
     * scattered trees and a drive genuinely IS twenty pieces of lawn. Capping
     * that at six drops real ground that neither prompt claimed, and it drops
     * more of it the more boxes are ticked -- so the cap has to follow the
     * arithmetic rather than the other way round. Anything still dropped is
     * named on screen.
     */
    maxPolygons: subtractive ? MAX_EXCLUDE_POLYGONS : undefined,
    /*
     * How finely to trace the outline, in metres on the ground rather than in
     * pixels. The default was 1.5 px, which sounds conservative and is not: at
     * this frame's resolution it is about 5 cm, finer than a lawn edge is
     * knowable and far finer than anyone can aim at. Measured on a real lot,
     * against the 3,636 sq ft the fine trace gave: 0.15 m gave 140 vertices
     * and +0.03%, 0.3 m gave 78 and -0.77%, 0.5 m gave 55 and -1.54%.
     */
    tolerance: TRACE_TOLERANCE_M / mPerPx,
    maxVertices: MAX_TRACE_VERTICES,
    growPx: Math.round((edgeFt * 0.3048) / mPerPx),
  };

  const unproject = (x, y) => framePxToLngLat(rendered, [x, y], w, h);

  if (!subtractive) {
    return {
      sqFtPerPx,
      collapsed: [],
      polygons: polygonsFromBinary(
        maskBinary(layers[0].image, { invert: Boolean(invert) }),
        w, h, unproject, options
      ),
    };
  }

  // Exclude mode is defined against the property line, so without one there is
  // nothing to subtract from. The detect button already refuses this; the
  // check is here because a measurement with no base is not a small error.
  if (!clipMask) return { sqFtPerPx, collapsed: [], polygons: [] };

  const collapsed = [];
  const kept = [];
  for (const layer of layers) {
    /*
     * Read literally. autoPolarity guesses that a mostly-white bitmap must be
     * upside down, on the premise that nothing legitimately covers most of a
     * frame -- which is false here, where a mask of the woods on a wooded lot
     * is exactly that. Guessing would hand back the lawn as the thing to
     * remove: confident, silent, and exactly inverted.
     */
    const bin = maskBinary(layer.image, { autoPolarity: false });
    if (coverage(bin, clipMask) > COLLAPSE_FRACTION) {
      collapsed.push(layer.label || 'that concept');
      continue;
    }
    kept.push(bin);
  }

  const lawn = subtractMasks(clipMask, unionMasks(kept));
  return { sqFtPerPx, collapsed, polygons: polygonsFromBinary(lawn, w, h, unproject, options) };
}

function refreshSensitivity() {
  const panel = $('#sens-panel');
  if (!panel) return;
  panel.hidden = !state.lastMask?.layers?.length;

  /*
   * Do not fight the person typing. Writing the value back while the field has
   * focus would move the caret mid-keystroke and make "-12" impossible to type,
   * so the field owns its own text until it is committed.
   */
  const field = $('#edge-ft');
  if (field && document.activeElement !== field) field.value = String(state.edgeFt);

  const minus = $('#edge-minus');
  const plus = $('#edge-plus');
  if (minus) minus.disabled = state.edgeFt <= -MAX_EDGE_FT;
  if (plus) plus.disabled = state.edgeFt >= MAX_EDGE_FT;

  describeEdgeShift();
}

function describeEdgeShift() {
  const ft = state.edgeFt;
  $('#sens-note').textContent = ft === 0
    ? `As detected. Minus pulls the outline in, plus pushes it out, up to ${MAX_EDGE_FT} ft.`
    : ft < 0
      ? `Pulled in ${Math.abs(ft)} ft all round — tighter, and thin strips drop out.`
      : `Pushed out ${ft} ft all round, still trimmed to your property line.`;
}

/** Re-trace the masks already in hand at the current edge setting. */
function retrace() {
  const mask = state.lastMask;
  if (!mask?.layers?.length) return;

  const { polygons } = traceDetection({
    layers: mask.layers,
    subtractive: mask.subtractive,
    invert: mask.invert,
    rendered: mask.frame,
    // Feet on the ground -> pixels of this particular mask.
    edgeFt: state.edgeFt,
  });

  // A snapshot per change would bury the detection under a hundred steps of
  // slider, so the whole drag collapses into one undoable move.
  pushHistory('sensitivity');
  draw.deleteAll();
  for (const geometry of polygons) draw.add({ type: 'Feature', properties: {}, geometry });

  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  describeEdgeShift();

  if (!polygons.length) {
    setStatus('Nothing left at this setting — slide back to the right.', 'warn');
    return;
  }

  /*
   * SAY SO WHEN THIS REPLACED WORK SOMEBODY DID BY HAND.
   *
   * Re-tracing rebuilds every shape from the mask, so hand corrections are
   * gone -- and that is fine and reversible (the snapshot above is exactly
   * one undo away), but only if it is not silent. These controls are reachable
   * after hand-editing precisely because they cost no detection, which makes
   * "free" and "harmless" two different things worth not conflating: the money
   * is free, the corrections are not.
   */
  const lost = state.handEdited;
  setStatus(
    `${polygons.length} section${polygons.length > 1 ? 's' : ''} of lawn at this setting.`
    + (lost ? ' Your hand corrections were redrawn from the AI mask — Undo puts them back.' : ''),
    lost ? 'warn' : ''
  );
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
  /*
   * Step one is finished the moment a boundary exists, however it got there --
   * and tracing one by hand is deliberate enough that moving on is welcome
   * rather than presumptuous. Unlike the county lookup, which happens TO you.
   */
  setTab('detect');
  refreshRail();
  updatePromptHint();
  setHint('');
  setStatus(`Property line traced — ${a.acres} acres. Detect your lawn, or open Draw to trace it yourself.`);
  // The boundary is what the imagery choice is for, so the moment it exists is
  // the moment to say which pictures the AI can be shown.
  showTip('layers');
}

/** Paint every rail button with what is actually live. */
function refreshRail() {
  const rail = $('#maprail');
  if (!rail) return;
  const onSaves = state.tab === 'saved';
  rail.hidden = !state.frame || onSaves;

  // One source is not a choice, so the Layers button only exists when there is
  // something to switch between.
  const layers = $('#maprail-left');
  if (layers) {
    layers.hidden = !state.frame || state.imagery.length < 2 || onSaves;
    if (layers.hidden) closeLayerList();
  }

  /*
   * THE MAP'S BUTTONS FOLLOW THE TAB.
   *
   * The rail is the other half of the panel, not a separate thing: "Line",
   * "Pins" and "Lawn" are the tools of three different steps, and having all
   * of them live at once was the same confusion as the one long column in the
   * panel. Pressing Line while meaning to paint is not a mistake worth being
   * able to make, so on the drawing tab it is not there to press.
   *
   * Pins are additionally only a concept for the model that uses them.
   */
  /*
   * A LOCKED STEP'S MAP TOOLS ARE LOCKED TOO.
   *
   * The lock greys out the panel, and the panel is only half of a step: "Line"
   * lives on the map. Leaving it pressable meant the boundary tools were
   * visibly disabled and still completely usable -- you could drag the property
   * line with the panel greyed out beside you, re-trimming the very lawn the
   * lock exists to protect. A lock with a way round it is worse than no lock,
   * because it says the work is safe.
   */
  const shut = Boolean(tabLock(state.tab));

  let anyTool = false;
  for (const m of MODES) {
    const btn = $(`#mode-${m}`);
    if (!btn) continue;
    const mine = modeBelongsTo(m, state.tab);
    btn.hidden = !mine || shut || (m === 'pins' && !modelInfo(state.model).needsPoints);
    if (!btn.hidden) anyTool = true;
    btn.setAttribute('aria-pressed', String(state.mode === m));
  }

  /*
   * A rail with nothing in it is a bar of empty space over the map.
   *
   * The AI step is the case: the text-prompted model needs no pins, so none of
   * the four tools belong to it and every button is hidden while the rail
   * itself stayed on screen. Undo is the exception -- it is useful on any step
   * and is the only undo reachable from one where the panel's copy is a tab
   * away -- so the rail survives for its sake alone.
   */
  const undo = $('#rail-undo');
  if (undo) rail.hidden = rail.hidden || (!anyTool && undo.disabled);

  $('#shape-tools').hidden = state.mode !== 'shape';
  for (const [id, tool] of [['#tool-points', 'points'], ['#tool-add', 'add'], ['#tool-erase', 'erase']]) {
    $(id)?.setAttribute('aria-pressed',
      String(state.mode === 'shape' && state.shapeTool === tool));
  }

  // Brush width belongs to the brushes, so it appears with them and not with
  // the corner tool, where it would do nothing.
  const sizes = $('#brush-sizes');
  if (sizes) {
    sizes.hidden = !(state.mode === 'shape' && state.shapeTool !== 'points');
    if (!sizes.hidden) refreshBrushWidth();
  }
}

/* ------------------------------------------------------------ the tips */
/*
 * One tip per stage, pointed at the control it is about.
 *
 * There are three moments where this app expects something a first-time
 * visitor cannot possibly know:
 *
 *   parcel  the measurement is clipped to the property line, so a boundary
 *           that stops short of the road silently costs you frontage
 *   layers  there are several photographs of the same ground, they disagree,
 *           and only some of them can be sent to the AI at all
 *   tools   the detected outline is a first guess that you are expected to
 *           correct, using nine unlabelled icons on the map
 *
 * Every one of those was already written down in the panel, and every one of
 * them was missed, because the panel is below the map (and on a phone, off
 * the bottom of the screen entirely) at exactly the moment it matters. The
 * arrow is the part that does the work: "press Layers" means nothing when
 * Layers is an icon among icons.
 *
 * Stages fire once each per address. The switch at the top of the panel turns
 * the whole thing off, and is remembered.
 */
/* ------------------------------------------------------ developer mode */
/**
 * A hidden panel for trying prompts and thresholds against the real map.
 *
 * OBSCURED, NOT SECURED, and worth being exact about the difference. The
 * Worker accepts a prompt and a threshold from anybody -- this key hides the
 * controls, it does not guard the endpoint. That is a deliberate choice rather
 * than an oversight: an arbitrary prompt costs exactly one prediction, the
 * daily allowance already caps how many of those anyone gets, and a
 * segmentation model has nothing to be injected into. The thing being avoided
 * is a friend testing their lawn and finding a box of knobs that produce
 * confidently wrong numbers, not an attacker.
 *
 * Unlocked from the URL because that is the only thing typeable on a phone
 * without a keyboard shortcut, and remembered afterwards so the key is needed
 * once rather than every visit. "Leave developer mode" in the panel forgets
 * it.
 */
const DEV_KEY = 'tinker';
const DEV_STORE = 'lm_dev';

const devUnlocked = () => {
  try {
    if (localStorage.getItem(DEV_STORE) === '1') return true;
  } catch { /* private mode */ }
  // Hash rather than a query string: it never reaches the Worker, so it stays
  // out of request logs, and it survives as a bookmark.
  const asked = location.hash.replace(/^#/, '').toLowerCase() === DEV_KEY;
  if (asked) {
    try { localStorage.setItem(DEV_STORE, '1'); } catch { /* private mode */ }
    /*
     * Take it back out of the address bar so a shared screenshot or a copied
     * link does not hand the key to someone who was not looking for it.
     *
     * WINDOW.history, spelled out. This module declares `let history = []`
     * for the undo stack, which shadows the DOM's history for the whole file
     * -- so the bare name resolves to an Array and `history.replaceState` is
     * not a function. It threw here, after the unlock had been stored but
     * before it was returned, which made the mode look half-on: remembered on
     * the next visit, invisible on this one.
     */
    window.history.replaceState(null, '', location.pathname + location.search);
    return true;
  }
  return false;
};

const devExit = () => {
  try { localStorage.removeItem(DEV_STORE); } catch { /* private mode */ }
  state.dev = false;
  state.devPrompt = '';
  state.devThreshold = null;
  refreshDevPanel();
  // The ceiling just dropped back to the ordinary one, and a badge still
  // showing the developer figure would promise detections that get refused.
  refreshQuota();
  setStatus('Developer mode off. Detection is back to its own settings.');
};

/**
 * What developer mode will send, or nothing at all.
 *
 * An empty prompt and an untouched slider mean "use the defaults", so the
 * fields are omitted entirely rather than sent as blanks -- the Worker treats
 * absent and empty the same way, and this keeps an idle panel from looking
 * like an override in the test log.
 */
/*
 * NOTE: the larger developer allowance is NOT requested from here. This
 * function answers "what is the panel changing about the detection", and the
 * daily cap changes nothing about it -- folding the two together would make an
 * idle panel look like an override in the test log, which is the exact thing
 * the paragraph above is about. detect() sends the flag on its own.
 */
function devOverrides() {
  if (!state.dev) return {};
  const out = {};
  const typed = ($('#dev-prompt')?.value || '').trim();
  if (typed) out.prompt = typed;
  if (state.devThreshold !== null) out.threshold = state.devThreshold;
  /*
   * Testing always sends a number, even untouched. Letting it fall through to
   * a server-side default would put a setting in play that the panel does not
   * show -- the precise thing this method exists to avoid.
   */
  if (modelInfo(state.model).devOnly && state.devThreshold === null) {
    out.threshold = DEV_TESTING_CUT;
  }
  return out;
}

/** Mirror of the Worker's estimate, so the count is live as you type. */
const DEV_MAX_TOKENS = 32;

/*
 * Testing's cut when the slider has not been moved.
 *
 * It needs a number of its own because "the model default" would be a hidden
 * setting, and this method's whole claim is that it sends only what the panel
 * shows. Same value as the grass default, so an untouched panel reproduces
 * Quick when you type "grass" -- which makes it a usable baseline rather than
 * a fourth unknown.
 */
const DEV_TESTING_CUT = 0.05;
const devTokens = (prompt) =>
  String(prompt).trim().split(/\s+/).filter(Boolean).length
  + (String(prompt).match(/,/g) || []).length
  + 3;

function refreshDevPanel() {
  const panel = $('#dev-panel');
  if (!panel) return;
  panel.hidden = !state.dev;
  if (!state.dev) return;

  const typed = ($('#dev-prompt')?.value || '').trim();
  const est = typed ? devTokens(typed) : 0;
  const over = est > DEV_MAX_TOKENS;

  /*
   * The token count is shown because going over does not degrade the answer,
   * it errors -- the encoder refuses past 32 and the prediction fails outright.
   * Better to see that while typing than to spend an allowance discovering it.
   */
  const tokens = $('#dev-tokens');
  if (tokens) {
    tokens.textContent = typed ? `~${est}/${DEV_MAX_TOKENS} tokens` : '';
    tokens.style.color = over ? '#b3261e' : '';
  }

  const cut = state.devThreshold;
  const value = $('#dev-threshold-value');
  if (value) value.textContent = cut === null ? 'model default' : cut.toFixed(2);

  /*
   * Say which method the panel is actually driving.
   *
   * This is the confusion the Testing method exists to end: with Exclude
   * selected, a typed prompt used to be combined with that method's own
   * settings, and nothing on screen said so. Now the note names the method and
   * says exactly which of its settings the panel has taken over.
   */
  const testing = modelInfo(state.model).devOnly;
  const note = $('#dev-note');
  if (note) {
    if (over) {
      note.textContent = 'Too long — the model errors past 32 tokens rather than answering.';
    } else if (testing) {
      note.textContent = typed
        ? `Testing sends exactly this: "${typed}", cut ${cut === null ? DEV_TESTING_CUT : cut}`
          + `, ${state.devInvert ? 'inverted' : 'not inverted'}.`
        : 'Testing needs a prompt — it has none of its own.';
    } else if (excludesWanted()) {
      /*
       * On Exclude a typed prompt REPLACES the tick boxes with one pass of its
       * own, rather than joining them. Combining would put a surprising mask
       * beyond attribution -- which of five things produced it? -- and this is
       * the method whose whole job is to be readable. Saying so here matters
       * because the boxes stay visible and ticked while the prompt overrides
       * them, which otherwise looks like they are still in play.
       */
      note.textContent = typed
        ? `Sending one pass of "${typed}" instead of the ticked boxes, and taking it off the property.`
        : `The ticked boxes decide. Type a prompt to run that one concept instead of them.`;
    } else {
      note.textContent = `Prompt and cut override ${modelInfo(state.model).label}`
        + `, which still ${modelInverts(state.model) ? 'inverts' : 'does not invert'} the mask.`
        + ' Pick "Testing" to control that too.';
    }
  }

  /* The inversion box only decides anything for Testing; everywhere else the
   * method owns it, and a live control that does nothing is a lie. */
  const invertBox = $('#dev-invert');
  if (invertBox) {
    invertBox.disabled = !testing;
    invertBox.closest('.devcheck')?.style.setProperty('opacity', testing ? '1' : '0.45');
  }

}

/*
 * Refuse an over-long prompt here rather than by disabling the button.
 *
 * The detect button's enabled state is owned by the normal flow -- whether
 * there is a frame yet, whether a detection is running -- and a second writer
 * would fight it: this function would grey it out and the next refresh would
 * turn it straight back on. So the panel warns, and the press is what stops.
 */
function devPromptBlocked() {
  if (!state.dev) return null;
  const typed = ($('#dev-prompt')?.value || '').trim();
  // Testing has no prompt of its own, so a blank box is not "use the default",
  // it is "nothing to ask". Say that rather than quietly sending "grass".
  if (!typed && modelInfo(state.model).devOnly) {
    return 'Testing has no prompt of its own — type one before detecting.';
  }
  if (!typed) return null;
  const est = devTokens(typed);
  if (est <= DEV_MAX_TOKENS) return null;
  return `That prompt is about ${est} tokens and the model's limit is `
    + `${DEV_MAX_TOKENS}. It would fail rather than answer badly — use fewer words.`;
}

function wireDevPanel() {
  const prompt = $('#dev-prompt');
  const slider = $('#dev-threshold');
  if (prompt) prompt.addEventListener('input', refreshDevPanel);
  if (slider) {
    slider.addEventListener('input', () => {
      state.devThreshold = Number(slider.value);
      refreshDevPanel();
    });
  }
  const invert = $('#dev-invert');
  if (invert) {
    invert.addEventListener('change', () => {
      state.devInvert = invert.checked;
      refreshDevPanel();
    });
  }
  $('#dev-reset')?.addEventListener('click', () => {
    if (prompt) prompt.value = '';
    state.devThreshold = null;
    state.devInvert = false;
    if (invert) invert.checked = false;
    refreshDevPanel();
  });
  $('#dev-exit')?.addEventListener('click', devExit);
}

const TIPS_KEY = 'lm_tips';

/*
 * `on` is held here rather than read back from storage each time. A browser in
 * private mode can throw on both reading and writing localStorage, and a
 * preference that reads back as "on" because the write failed is a switch that
 * does nothing -- the setting is remembered where it can be, and obeyed
 * always.
 */
const tips = {
  seen: new Set(),
  stage: null,
  target: null,
  on: (() => {
    try { return localStorage.getItem(TIPS_KEY) !== '0'; } catch { return true; }
  })(),
};

const tipsOn = () => tips.on;

function setTipsOn(on) {
  tips.on = on;
  try { localStorage.setItem(TIPS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  $('#toggle-tutorials').checked = on;
  if (on) {
    // Turning them back on resumes from wherever the user actually is, rather
    // than replaying steps they have already worked out for themselves.
    tips.seen.clear();
    showTip(currentStage());
  } else {
    hideTip();
  }
}

/** Which tip belongs to where the user has got to. */
function currentStage() {
  if (state.detected || draw.getAll().features.length) return 'tools';
  if (parcelRing()) return 'layers';
  return 'parcel';
}

/**
 * What each stage says, built when it is shown.
 *
 * The imagery text is generated from the catalogue rather than written out,
 * because which sources exist depends on what the Worker is configured with:
 * Google only appears when there is a key for it, and a tip that names a
 * source the user cannot see is worse than no tip.
 */
function tipContent(stage) {
  if (stage === 'parcel') {
    return parcelRing()
      ? {
          target: '#mode-parcel',
          title: 'First: check your property line',
          text: 'The dashed outline is your lot, from the county record. Only '
              + 'grass inside it gets measured — so if your lawn runs past it '
              + 'to the road, press Line and slide that edge out — you can '
              + 'come back and do that at any time, even after measuring.',
        }
      : {
          target: null,
          title: 'First: trace your property line',
          text: 'Your county has no line on file for this lot, so draw one: '
              + 'press "Draw the property line" and tap each corner. Detection '
              + 'needs it — without a boundary the AI counts the neighbours’ '
              + 'grass as yours.',
        };
  }

  if (stage === 'layers') {
    const detect = state.imagery.filter((p) => p.detect).map((p) => p.label);
    const look = state.imagery.filter((p) => !p.detect).map((p) => p.label);
    return {
      target: '#btn-layers',
      title: 'Next: pick the clearest picture',
      text: 'These are photographs of the same ground taken in different years '
          + 'and different light, and they disagree about where your lawn is. '
          + `Only ${listSentence(detect)} can be sent to the AI — pick whichever `
          + 'of those shows your grass most clearly, then detect. '
          + (look.length
              ? `${listSentence(look)} ${look.length > 1 ? 'are' : 'is'} there to look at; `
                + 'choosing one of those measures from Mapbox instead.'
              : ''),
    };
  }

  return {
    target: '#mode-shape',
    title: 'Last: correct what it got wrong',
    text: 'The AI is a good first guess, not the final word. Press Lawn, then '
        + 'Erase to rub out a driveway or a flower bed, Add to paint in grass '
        + 'it missed, or Points to drag a corner. Move is the only mode where a '
        + 'whole patch can be dragged, and Undo is on the map next to them.',
  };
}

/** "a", "a and b", "a, b and c" — the list is built from live data. */
function listSentence(items) {
  if (items.length <= 1) return items[0] || 'nothing here';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * A tip whose control is on another tab, waiting for that tab.
 *
 * THE MISTAKE THIS REPLACES, TWICE OVER. Once the tools moved onto tabs, a tip
 * would routinely fire while the button it is about was on a tab you were not
 * looking at -- and showTip, correctly refusing to point at a hidden control,
 * silently showed nothing at all. The first attempt at a fix pointed the tip at
 * the TAB instead, which required the box to escape the map, and it landed on
 * top of the tab strip: the tabs stopped being clickable, which is a great deal
 * worse than a missing tip.
 *
 * The honest answer is that a tip belongs beside the thing it explains, and if
 * that thing is not here yet then neither is the tip. So it waits. Opening the
 * tab brings the control and its explanation at the same moment, which is also
 * when it is useful -- the drawing tips are worth reading when you reach the
 * drawing tools, not while you are still looking at the AI.
 */
let pendingTip = null;

function showTip(stage) {
  if (!tipsOn() || tips.seen.has(stage) || !state.frame) return;
  const { target, title, text } = tipContent(stage);

  /*
   * Not now, but not never. Deliberately NOT added to `seen`, so opening the
   * tab it belongs to brings it back rather than skipping it for good.
   */
  const el = target ? $(target) : null;
  if (target && (!el || el.offsetParent === null)) {
    pendingTip = stage;
    return;
  }
  pendingTip = null;

  tips.seen.add(stage);
  tips.stage = stage;
  tips.target = el;

  $('#coach-title').textContent = title;
  $('#coach-text').textContent = text;
  $('#coach').hidden = false;
  placeTip();
}

function hideTip() {
  $('#coach').hidden = true;
  tips.stage = null;
  tips.target = null;
}

/**
 * Put the box beside its target, with the arrow still aimed at it.
 *
 * The box is clamped inside the map, which on a narrow phone can mean it no
 * longer sits directly beside the button. The arrow is positioned from the
 * target's own centre rather than from the box, so it keeps pointing at the
 * right control even when the box has been pushed away from it.
 */
function placeTip() {
  const box = $('#coach');
  const arrow = $('#coach-arrow');
  if (box.hidden) return;

  /*
   * The map, which is also the only place the box can be.
   *
   * Every tip points at a button on the map; one whose control is on a tab you
   * are not looking at waits for that tab rather than pointing somewhere else
   * (see pendingTip). Clamping to the map is therefore not a limitation -- it
   * is what keeps the box off the panel, and off the tab strip, which it
   * covered and made unclickable the one time it was allowed out.
   */
  const wrap = $('#map').parentElement.getBoundingClientRect();
  const target = tips.target;

  if (!target) {
    // Nothing to point at: sit under the hint, centred, no arrow.
    arrow.hidden = true;
    box.style.left = `${Math.max(8, (wrap.width - box.offsetWidth) / 2)}px`;
    box.style.top = '58px';
    return;
  }

  const t = target.getBoundingClientRect();
  const GAP = 12;
  const EDGE = 8;
  const w = box.offsetWidth;
  const h = box.offsetHeight;

  // A target on the left half gets the box on its right, and vice versa.
  const onLeft = (t.left + t.width / 2 - wrap.left) < wrap.width / 2;
  let left = onLeft ? (t.right - wrap.left + GAP) : (t.left - wrap.left - GAP - w);
  left = Math.min(Math.max(left, EDGE), Math.max(EDGE, wrap.width - w - EDGE));

  let top = t.top - wrap.top + t.height / 2 - h / 2;
  top = Math.min(Math.max(top, EDGE), Math.max(EDGE, wrap.height - h - EDGE));

  box.style.left = `${left}px`;
  box.style.top = `${top}px`;

  arrow.hidden = false;
  arrow.className = `coach-arrow ${onLeft ? 'at-left' : 'at-right'}`;
  const ay = t.top - wrap.top + t.height / 2 - top;
  arrow.style.top = `${Math.min(Math.max(ay - 6, 12), Math.max(12, h - 24))}px`;
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

  if (corner) return selectVertex(corner);

  /*
   * Then a phantom midpoint, which turns into a real corner where it stands.
   *
   * Checked after real corners and before edges: a corner is the thing you had
   * to aim hardest at, and tapping the line generally is still how you grab a
   * whole edge to slide it. The phantom sits in between because it is visible
   * and small, so hitting one is a deliberate act.
   */
  let phantom = null;
  for (const m of midpointHandles()) {
    const at = map.project(m.at);
    const px = Math.hypot(at.x - tap.x, at.y - tap.y);
    if (px <= VERTEX_GRAB_PX && (!phantom || px < phantom.px)) phantom = { ...m, px };
  }
  if (phantom) return addPointAt(phantom.featureId, phantom.edgeIndex, phantom.at);

  selectEdgeNear(lngLat);
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

  // A corner of the LAWN is a hand correction; a corner of the property line
  // is not -- the lock exists to protect work the AI would overwrite, and the
  // AI does not draw boundaries.
  if (state.mode === 'shape') markHandEdited();
  writeRing(edit.featureId, moveVertex(ring, edit.vertexIndex, lngLat));
  drawPoints();
  refreshMeasurement();
  refreshSurveyed();
}

/** Add a corner where the user tapped on the selected edge. */
/**
 * Put a corner on an edge, wherever it was asked for.
 *
 * Shared by the phantom midpoints on the map and the button in the panel, so
 * the two cannot drift into behaving differently -- the button is now just a
 * second way to reach this.
 */
function addPointAt(featureId, edgeIndex, at) {
  const ring = ringOf(featureId);
  if (!ring) return;

  pushHistory();
  if (state.mode === 'shape') markHandEdited();
  const grown = insertVertex(ring, edgeIndex, at);
  if (!writeRing(featureId, grown)) return;

  // Select it straight away: adding a point is nearly always the first half of
  // moving it somewhere.
  selectVertex({ featureId, ring: grown, index: edgeIndex + 1 });
  setStatus('Corner added. Drag it where you want it.');
  refreshMeasurement();
  refreshSurveyed();
}

function addPointOnEdge() {
  const edit = state.edgeEdit;
  if (!edit || edit.edgeIndex == null || !edit.tapAt) return;
  addPointAt(edit.featureId, edit.edgeIndex, edit.tapAt);
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
  if (state.mode === 'shape') markHandEdited();
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

/**
 * How long a segment must look on screen before it is offered a midpoint.
 *
 * A traced outline can carry two hundred corners a few pixels apart, and
 * putting a phantom between every neighbouring pair would bury the real
 * corners under twice as many fake ones. A segment you cannot see is not a
 * segment you want to split.
 */
const MIDPOINT_MIN_PX = 30;

/**
 * The phantom midpoints: one per segment long enough to be worth splitting.
 *
 * Tapping one adds a corner there. Before this, adding a corner meant tapping
 * the line, then scrolling the panel below the map, then pressing "Add a
 * corner here" -- three actions and a trip away from the thing being edited,
 * for what every other editor on earth does with one tap on a hollow dot.
 */
function midpointHandles() {
  const out = [];
  for (const { featureId, ring } of editableRings()) {
    const verts = openRing(ring);
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const pa = map.project(a);
      const pb = map.project(b);
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < MIDPOINT_MIN_PX) continue;
      out.push({
        featureId,
        edgeIndex: i,
        at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      });
    }
  }
  return out;
}

function drawPoints() {
  if (!map.getSource('points')) return;
  const edit = state.edgeEdit;
  if (!edit) return map.getSource('points').setData(empty());

  const features = [];

  /*
   * Real corners, for every outline this mode can edit -- not only the one
   * already selected. The handles are what tell you a shape is editable at
   * all, and hiding them until after a successful tap meant the first tap was
   * always aimed at something invisible.
   */
  for (const { featureId, ring } of editableRings()) {
    openRing(ring).forEach((p, i) => {
      features.push({
        type: 'Feature',
        properties: {
          phantom: 0,
          selected: featureId === edit.featureId && i === edit.vertexIndex ? 1 : 0,
        },
        geometry: { type: 'Point', coordinates: p },
      });
    });
  }

  for (const { at } of midpointHandles()) {
    features.push({
      type: 'Feature',
      properties: { phantom: 1, selected: 0 },
      geometry: { type: 'Point', coordinates: at },
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
/**
 * Start the measurement from the property line.
 *
 * REPLACES what is on the map. It used to add, which made the button a way to
 * count your lot twice: press it with a detected lawn on screen and the whole
 * parcel was added on top, press it again and another whole parcel went on top
 * of that. The total climbed by an acre a tap and nothing on the map looked
 * wrong, because the duplicate sat exactly on the original.
 *
 * "Started from your property line" was always what the button said it did.
 * Now it does it.
 */
function useParcelShape() {
  const ring = parcelRing();
  if (!ring) return;

  // Same protection detection gives: shapes on the map may be hand corrections
  // that took real work, and replacing them silently is not the button's call.
  if (draw.getAll().features.length && !confirm(
    'Start again from the property line? This replaces the shapes on the map, ' +
    'including any corrections you have made.'
  )) return;

  pushHistory();
  // A lawn the size of the lot is a starting point somebody chose, and a
  // detection would wipe it. That is exactly what the lock is for.
  markHandEdited();
  draw.deleteAll();
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

/**
 * The measurement, as a number, from the shapes themselves.
 *
 * Read from the geometry rather than from the text in the panel: that text is
 * formatted, localised and rounded, and anything comparing before with after
 * by parsing it back is measuring the formatter.
 */
const totalSquareFeet = () => measureLawn(draw.getAll()).squareFeet;

/*
 * How finely the overlap is measured.
 *
 * Not ERASE_GRID (1280): this runs on every measurement refresh, which
 * includes every frame of a corner drag, and 1.6M pixels per shape per frame
 * is a stutter on a phone for a correction that does not need that resolution.
 * The answer wanted is a RATIO, and at 320 across a 400 ft lot each pixel is
 * about 1.6 sq ft -- so a thousand square feet of double-counted lawn is some
 * six hundred pixels, which is far more precision than a figure rounded to the
 * nearest ten needs.
 */
const OVERLAP_GRID = 320;

/**
 * The lawn total, counting ground that two shapes share only once.
 *
 * WHY THIS IS NOT JUST measure(). Geodesic area sums a FeatureCollection,
 * because plain spherical maths cannot tell that two shapes cover the same
 * grass. Draw a square, draw it again on top, and the panel reported both --
 * 48,810 sq ft became 97,620. Nothing in the app prevented that: the add
 * brush, "Use property line", and drawing by hand can all put one shape over
 * another, and the result looked like a bigger lawn rather than like a bug.
 *
 * THE SHAPES ARE LEFT ALONE. The obvious alternative is to merge overlapping
 * shapes on the map, and that would mean a rasterise-and-retrace round trip --
 * the same lossy loop that used to nudge every corner inward on an idle brush
 * stroke. Corners the user placed by hand must survive being measured. So the
 * geometry is untouched and only the total is corrected, with the panel saying
 * when it has done so, because a number smaller than the visible parts adds up
 * to needs explaining.
 */
function measureLawn(fc) {
  const plain = measure(fc);
  const shapes = (fc?.features || [])
    .map((f) => f.geometry?.coordinates)
    .filter((rings) => Array.isArray(rings) && rings.length);

  if (shapes.length < 2) return { ...plain, overlapSqFt: 0 };

  /*
   * Bounding boxes first, because they are nearly free and almost always
   * settle it. Detection hands back disconnected components and most lawns are
   * one or two of them, so the raster below usually never runs at all.
   */
  const boxes = shapes.map((rings) => {
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lng, lat] of rings[0]) {
      w = Math.min(w, lng); e = Math.max(e, lng);
      s = Math.min(s, lat); n = Math.max(n, lat);
    }
    return [w, s, e, n];
  });

  let mayTouch = false;
  for (let i = 0; i < boxes.length && !mayTouch; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [aw, as, ae, an] = boxes[i];
      const [bw, bs, be, bn] = boxes[j];
      if (aw <= be && bw <= ae && as <= bn && bs <= an) { mayTouch = true; break; }
    }
  }
  if (!mayTouch) return { ...plain, overlapSqFt: 0 };

  // One frame around everything, so every shape lands in the same pixel grid.
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [bw, bs, be, bn] of boxes) {
    w = Math.min(w, bw); e = Math.max(e, be);
    s = Math.min(s, bs); n = Math.max(n, bn);
  }
  const pad = 0.0001;
  const bbox = [w - pad, s - pad, e + pad, n + pad];
  const frame = {
    lng: (bbox[0] + bbox[2]) / 2,
    lat: (bbox[1] + bbox[3]) / 2,
    zoom: zoomToFit(bbox, OVERLAP_GRID),
    size: OVERLAP_GRID,
  };

  const fraction = distinctFraction(
    shapes, OVERLAP_GRID, OVERLAP_GRID,
    (ll) => lngLatToFramePx(frame, ll, OVERLAP_GRID, OVERLAP_GRID)
  );

  // Exactly 1 when the boxes overlapped but the shapes did not, which is the
  // common case this has to leave completely alone.
  if (!(fraction < 1)) return { ...plain, overlapSqFt: 0 };

  const corrected = fromSquareMeters(geometryAreaSqM(fc) * fraction);
  return {
    ...corrected,
    overlapSqFt: Math.round((plain.squareFeetRaw - corrected.squareFeetRaw) / 10) * 10,
  };
}

function refreshMeasurement() {
  const fc = draw.getAll();
  const hasShapes = fc.features.length > 0;
  $('#result').hidden = !hasShapes;

  /*
   * A PLAN DRAWN OVER A LAWN THAT HAS SINCE CHANGED IS A WRONG PLAN.
   *
   * The pieces are cut from the shapes as they were, so any edit -- a brush
   * stroke, a dragged corner, a re-detection -- leaves them describing ground
   * that is no longer the lawn. Silently stale is the dangerous version here,
   * because the numbers still look authoritative while being about a shape
   * nobody can see any more. They go, and the tool says so when reopened.
   *
   * Cleared rather than recomputed: recomputing on every vertex drag would
   * redraw a dozen bands per second, and the person moving a corner has not
   * asked for a plan yet.
   */
  if (state.plan) clearSegments({ quiet: true });
  // The plan tab and the finish button both appear with the first shape and
  // leave with the last one, so they are refreshed wherever shapes change.
  refreshTabs();

  if (!hasShapes) {
    // Clear the figure rather than just hiding it. A hidden panel keeps its
    // last text, which reads as a live measurement to anything looking at the
    // DOM -- a browser check did exactly that and passed on a stale number
    // while the map was empty.
    $('#result-sqft').textContent = '—';
    $('#result-sub').textContent = '';
    return;
  }

  const m = measureLawn(fc);
  const patches = fc.features.length;

  $('#result-sqft').textContent = m.squareFeet.toLocaleString();
  /*
   * Say when ground has been counted once rather than twice.
   *
   * Without this the panel would show a total smaller than the shapes visibly
   * add up to, with nothing to explain it -- which reads as the measurement
   * losing lawn rather than as it declining to sell the same grass twice.
   */
  $('#result-sub').textContent =
    `${m.thousandSqFt.toFixed(2)}k sq ft · ${m.acres} acres` +
    (patches > 1 ? ` · ${patches} areas` : '') +
    (m.overlapSqFt > 0
      ? ` · ${m.overlapSqFt.toLocaleString()} sq ft of overlap counted once`
      : '');

  $('#print-sqft').textContent = m.squareFeet.toLocaleString();
  $('#print-address').textContent = state.chosen?.label || '';
  $('#print-detail').textContent =
    `${m.acres} acres · ${m.thousandSqFt.toFixed(2)} thousand sq ft` +
    (state.parcel ? ` · parcel from ${state.parcel.properties.county}` : '');

  /*
   * Every change to the measurement is worth keeping, so this is where the
   * save is triggered from rather than from a button.
   *
   * Debounced, because this runs on every event of a brush stroke and a stroke
   * is one edit; and placed after the figure is on screen, so a save never
   * holds up the number somebody is waiting for.
   */
  scheduleSave();
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

/* ------------------------------------------------------- the plan tab */

/**
 * What the plan tools have to work with.
 *
 * Everything here acts on a finished measurement, so the tab says how big it
 * is rather than making somebody switch back to check. The figure is also the
 * sanity check on the pieces: if the total here and the pieces below disagree,
 * something is wrong and it is visible.
 */
function refreshPlanTab() {
  const sqft = totalSquareFeet();
  $('#plan-lead').textContent = sqft
    ? `${Math.round(sqft).toLocaleString()} sq ft measured. These tools work on the finished map.`
    : 'Measure a lawn first and these tools will work on it.';
}

/** The lawn as planSegments wants it: one ring list per polygon, lng/lat. */
function lawnRings() {
  return draw.getAll().features
    .map((f) => f.geometry?.coordinates)
    .filter((rings) => Array.isArray(rings) && rings[0]?.length >= 4);
}

const clampSize = (n) => Math.min(
  MAX_SEGMENT_SQFT,
  Math.max(MIN_SEGMENT_SQFT, Math.round(n / SEGMENT_STEP_SQFT) * SEGMENT_STEP_SQFT)
);
const clampWidth = (n) => Math.min(MAX_WIDTH_FT, Math.max(MIN_WIDTH_FT, n));

const segSize = () => clampSize(parseFloat($('#seg-size').value) || 5000);
const segWidth = () => clampWidth(parseFloat($('#seg-width').value) || DEFAULT_WIDTH_FT);

function writeSegInputs() {
  $('#seg-size').value = String(segSize());
  $('#seg-width').value = String(segWidth());
}

/**
 * Run the split and draw it.
 *
 * Synchronous and on the main thread, deliberately: the raster is a few
 * hundred pixels a side and this takes single-digit milliseconds on a phone.
 * A worker would be a second file, a message protocol and a loading state to
 * make a fast thing feel slower.
 */
function runSegments() {
  const rings = lawnRings();
  if (!rings.length) {
    setStatus('There is no lawn to split yet.', 'warn');
    return;
  }

  writeSegInputs();
  const plan = planSegments({ rings, targetSqFt: segSize(), widthFt: segWidth() });
  state.plan = plan;

  map.getSource('segments').setData({
    type: 'FeatureCollection',
    features: plan.segments.map((s, i) => ({
      type: 'Feature',
      properties: { index: i },
      geometry: s.geometry,
    })),
  });
  map.getSource('segment-labels').setData({
    type: 'FeatureCollection',
    features: plan.segments
      .filter((s) => s.at)
      .map((s, i) => ({
        type: 'Feature',
        // Two lines: the number you are on, and what to do with it. The order
        // matters -- you find your place by the number and then read the
        // instruction, not the other way round.
        properties: {
          caption: `${i + 1}\n${s.label}\n${s.squareFeet.toLocaleString()} sq ft`,
        },
        geometry: { type: 'Point', coordinates: s.at },
      })),
  });

  renderSegmentList(plan);
  $('#seg-done').hidden = !plan.segments.length;
  $('#seg-clear').hidden = !plan.segments.length;

  if (!plan.segments.length) {
    setStatus(plan.notes[0] || 'That lawn could not be split.', 'warn');
    return;
  }
  setStatus(
    `${plan.segments.length} piece${plan.segments.length === 1 ? '' : 's'} of about `
    + `${segSize().toLocaleString()} sq ft. Save the picture and take it outside.`
  );
}

function renderSegmentList(plan) {
  const list = $('#seg-list');
  list.innerHTML = '';

  for (const [i, s] of plan.segments.entries()) {
    const li = document.createElement('li');
    li.className = 'seg-item';
    const head = document.createElement('b');
    head.textContent = `${s.squareFeet.toLocaleString()} sq ft`;
    const sub = document.createElement('small');
    sub.textContent = s.label + (s.split ? ' · in two parts' : '');
    li.append(head, sub);
    list.append(li);
  }

  /*
   * THE NOTES ARE PART OF THE ANSWER, not a footnote.
   *
   * A plan that quietly covers most of a lawn is worse than no plan, because
   * the part it missed is invisible until somebody is standing on it. So the
   * total covered is stated against the total measured whenever they differ,
   * and every reason a piece is odd is printed rather than counted.
   */
  const box = $('#seg-notes');
  box.innerHTML = '';
  const short = plan.totalSqFt - plan.coveredSqFt;
  const lines = [...plan.notes];
  if (short > plan.totalSqFt * 0.02) {
    lines.unshift(
      `${short.toLocaleString()} sq ft is not in any piece — scraps too small to `
      + 'be worth walking as their own section.'
    );
  }
  for (const text of lines) {
    const p = document.createElement('p');
    p.textContent = text;
    box.append(p);
  }
  box.hidden = !lines.length;

  $('#seg-summary').textContent =
    `${plan.coveredSqFt.toLocaleString()} sq ft in ${plan.segments.length} piece`
    + `${plan.segments.length === 1 ? '' : 's'}`
    + (plan.sections > 1 ? `, across ${plan.sections} sections` : '');
}

/**
 * Take the pieces off the map.
 *
 * `quiet` when this is a consequence of something else -- editing the lawn
 * drops a plan that no longer describes it, and announcing that over the top
 * of "3 sections of lawn at this setting" would replace the message about what
 * the person just did with one about the bookkeeping behind it.
 */
function clearSegments({ quiet = false } = {}) {
  state.plan = null;
  // Guarded because this runs from refreshMeasurement, which can fire before
  // the map's sources exist -- restoring a save sets shapes up first.
  map?.getSource?.('segments')?.setData(empty());
  map?.getSource?.('segment-labels')?.setData(empty());
  $('#seg-done').hidden = true;
  $('#seg-clear').hidden = true;
  if (!quiet) setStatus('Pieces cleared.');
}

/* ---------------------------------------------------------------- quota */

async function refreshQuota() {
  try {
    // The badge must count against the ceiling a detection will actually meet,
    // or an unlocked panel reads "12 left" and then gets refused at 20.
    state.quota = await api(
      `/api/quota?clientId=${encodeURIComponent(state.clientId)}${state.dev ? '&dev=1' : ''}`
    );
    const badge = $('#quota-badge');

    /*
     * ONE SENTENCE FOR BOTH KINDS OF VISITOR, because there is now one kind of
     * number: a daily allowance that comes back in the morning, bigger if you
     * are signed in.
     *
     * This used to read "4 credits" for an account and "4 of 20 left today"
     * for everybody else, which was two units on one badge -- and the first
     * one quietly meant "and then never again". Saying "of" and saying "today"
     * is what makes the number mean the same thing to everyone looking at it.
     *
     * Bought credits are named separately when there are any, for the same
     * reason: they do not reset, so adding them into the day's count would
     * produce a total that half comes back tomorrow.
     */
    if (state.quota.kind === 'credits') {
      if (state.quota.unlimited) {
        badge.textContent = 'Unlimited detections';
        badge.hidden = false;
        return;
      }
      const free = Math.max(0, (state.quota.limit || 0) - (state.quota.used || 0));
      const bought = Number(state.quota.credits || 0);
      badge.textContent = `${free} of ${state.quota.limit} AI passes left today`
        + (bought ? `, plus ${bought.toLocaleString()} bought` : '');
      badge.hidden = false;
      return;
    }

    const left = Math.max(0, state.quota.limit - state.quota.used);
    /*
     * Say when the number being shown is the SHARED one.
     *
     * The Worker now reports whichever ceiling has the least headroom, because
     * reporting the personal one while the address was nearly full produced
     * "30 of 50 detections left today" immediately followed by a refusal. The
     * count was honest about a limit that was not the one in the way; naming
     * which limit it is makes the two agree on screen.
     */
    /*
     * PASSES, NOT DETECTIONS, because passes are what the counter counts.
     *
     * It said "detections" while counting Replicate predictions, which are the
     * same thing only until a second box is ticked -- then one detection costs
     * two and the badge drops by two, so the number on screen stops matching
     * the word beside it. The exclusion panel says "2 AI passes per detection"
     * right above this, which is what makes the unit readable rather than
     * jargon.
     */
    /*
     * SAY WHAT AN ACCOUNT WOULD BE WORTH, and only once it matters.
     *
     * The signed-out allowance is small on purpose, so the badge is where
     * somebody finds out that signing in is the answer rather than waiting
     * until tomorrow. Naming the actual number beats "sign in for more" --
     * and it comes from the Worker, so it is the real one rather than a
     * figure in the browser that goes stale the moment the owner changes it.
     *
     * Held back until the allowance is half gone. Before that it is an advert
     * on a number nobody is having a problem with.
     */
    const offer = state.accountsOn && !signedIn() && state.quota.accountLimit
      && left <= Math.floor((state.quota.limit || 0) / 2)
      ? ` · an account gets ${state.quota.accountLimit} a day`
      : '';

    badge.textContent = (state.quota.reason === 'shared-network'
      ? `${left} of ${state.quota.limit} AI passes left today on this network`
      : `${left} of ${state.quota.limit} AI passes left today`) + offer;
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

  const m = measureLawn(draw.getAll());
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
  state.detectedExcluding = null;
  state.provider = 'mapbox';
  state.model = 'sam3';
  state.pins = [];
  state.mode = null;
  state.shapeTool = 'points';
  state.brushSize = 'bulk';
  state.measureOutside = false;
  $('#toggle-outside').checked = false;
  $('#outside-opt').hidden = true;
  // Back to Find grass, and to both defaults for the gap option.
  state.fillGaps = { find: true, exclude: false };
  state.handEdited = false;
  setTab('address');
  state.drawingParcel = false;
  state.edgeFt = DEFAULT_EDGE_FT;
  $('#edge-ft').value = String(DEFAULT_EDGE_FT);
  $('#sens-panel').hidden = true;
  $('#btn-draw-parcel').hidden = true;
  tips.seen.clear();
  hideTip();
  closeLayerList();
  refreshPins();
  refreshRail();
  $('#maprail').hidden = true;
  $('#maprail-left').hidden = true;
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
 * Re-tracing is not free -- it is a full pass over a 1280px mask -- so it runs
 * on a committed value, never on a keystroke. Typing "12" would otherwise
 * re-trace at 1 on the way past.
 */
$('#edge-minus').addEventListener('click', () => setEdgeFt(state.edgeFt - EDGE_STEP_FT));
$('#edge-plus').addEventListener('click', () => setEdgeFt(state.edgeFt + EDGE_STEP_FT));

/* `change` fires on blur and on Enter; the explicit keydown makes Enter commit
 * without dismissing the on-screen keyboard first, which is how a phone user
 * actually finishes typing. */
$('#edge-ft').addEventListener('change', (e) => setEdgeFt(e.target.value));
$('#edge-ft').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); setEdgeFt(e.target.value); }
});

$('#btn-pins-clear').addEventListener('click', () => {
  clearPins();
  setStatus('Pins removed. Tap the lawn to place new ones.');
});

/* ------------------------------------------------------------- the tabs */
for (const t of TABS) {
  $(`#tab-${t}`).addEventListener('click', () => {
    if (tips.stage) hideTip();
    setTab(t);
  });
}

/*
 * The handover from the machine's answer to yours.
 *
 * A button rather than only a tab, because this is the step people do not
 * realise is a step: the AI gives you a shape, and the next thing to do is
 * argue with it. Naming that as an action makes the drawing tools findable
 * for somebody who has never scrolled past the detect button.
 */
$('#btn-to-draw').addEventListener('click', () => {
  setTab('draw');
  setStatus('Correcting by hand. Use Lawn on the map to drag corners or paint '
    + 'with a brush; the total follows every change.');
});

/*
 * The same handover one step earlier.
 *
 * The tabs name the steps and nothing says which one comes next, so a person
 * who has just set a property line is finished and has no indication of it.
 * "Correct it by hand" already does this job between steps two and three; this
 * is its opposite number between one and two, and the pair is what turns four
 * tabs into a sequence.
 */
$('#btn-to-detect').addEventListener('click', () => {
  setTab('detect');
});

/*
 * `force`, because this one is a deliberate press.
 *
 * The once-a-session guard exists to stop the sheet appearing UNASKED after
 * every refused detection. Somebody who taps a button labelled "sign in" has
 * asked, and refusing to open because an automatic offer was already spent
 * would be the guard working against the person it protects.
 */
$('#saved-signin').addEventListener('click', () => {
  promptSignin({
    title: 'Keep your maps',
    why: 'Saved maps live in this browser until you have an account. Signing '
      + 'in carries the ones you already have with you and keeps new ones on '
      + 'every device. It also raises how many AI detections you get each day.',
    force: true,
  });
});

$('#btn-lock-clear').addEventListener('click', () => clearLawnAndUnlock());
$('#btn-lock-redetect').addEventListener('click', () => clearLawnAndUnlock({ toDetect: true }));

for (const btn of document.querySelectorAll('#feedback .fb-opt')) {
  btn.addEventListener('click', () => sendFeedback(btn.dataset.rating));
}
$('#feedback-skip').addEventListener('click', () => {
  closeFeedback();
  // No thank-you, no guilt, no second ask. Skipping is a complete answer.
  setStatus('No problem. Correct the shape however you like.');
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
  // Nothing left to protect, so the AI and the boundary are free again. A
  // lock that outlived the work it was guarding would just be in the way.
  state.handEdited = false;
  refreshTabs();
  updatePromptHint();
  setStatus('Cleared. Detect again, or draw the lawn by hand.');
});

$('#btn-parcel-shape').addEventListener('click', useParcelShape);
for (const id of ['#btn-undo', '#rail-undo']) {
  $(id).addEventListener('click', undo);
}
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

/*
 * Pressing the live sub-tool falls back to Points -- it does NOT leave lawn
 * mode. Leaving would take the other tools off the screen with it, so going
 * from Erase to Add would cost a trip back through the Lawn button, and
 * corrections alternate constantly. Lawn is the button that closes lawn mode.
 */
for (const size of ['fine', 'bulk']) {
  $(`#size-${size}`).addEventListener('click', () => setBrushSize(size));
}

for (const tool of ['points', 'add', 'erase']) {
  $(`#tool-${tool}`).addEventListener('click', () => {
    const live = state.mode === 'shape' && state.shapeTool === tool;
    setMode('shape', live ? 'points' : tool);
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
  markHandEdited();
  draw.delete(ids);
  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  setStatus('Removed. The total now covers only the shapes still on the map.');
});

/*
 * Pressing the button a tip is pointing at is the tip being taken. Leaving the
 * box open on top of the list it just told you to open is the sort of thing
 * that makes people hunt for a close button.
 */
$('#btn-layers').addEventListener('click', () => {
  if (tips.stage === 'layers') hideTip();
  toggleLayerList();
});

/* Tips ------------------------------------------------------------------- */
$('#toggle-tutorials').checked = tipsOn();
$('#toggle-tutorials').addEventListener('change', (e) => setTipsOn(e.target.checked));

$('#coach-ok').addEventListener('click', () => {
  const done = tips.stage;
  hideTip();
  // The property-line tip leads straight into the imagery one when there is
  // already a boundary; when there is not, the tip that follows tracing it
  // fires from adoptDrawnParcel instead.
  if (done === 'parcel' && parcelRing()) showTip('layers');
});

for (const mode of MODES) {
  $(`#mode-${mode}`).addEventListener('click', () => {
    if (tips.stage) hideTip();
  });
}

window.addEventListener('resize', placeTip);

$('#btn-png').addEventListener('click', exportPng);
$('#btn-print').addEventListener('click', () => window.print());

/* ------------------------------------------------------ the plan, wired */

/*
 * "Finish" is a handover, not a save button.
 *
 * The map is already saved -- it has been since the measurement settled, and
 * offering to do again something that has happened would be a button that
 * teaches people the app does not save on its own. What this actually does is
 * name the moment the measuring is over and show what comes next, which is
 * the thing the tabs could not say on their own.
 */
$('#btn-finish').addEventListener('click', () => {
  setTab('plan');
  setStatus('Measuring done. These tools work on the finished map.');
});

for (const [id, delta] of [['#seg-size-minus', -SEGMENT_STEP_SQFT], ['#seg-size-plus', SEGMENT_STEP_SQFT]]) {
  $(id).addEventListener('click', () => {
    $('#seg-size').value = String(clampSize(segSize() + delta));
    if (state.plan) runSegments();
  });
}
for (const [id, delta] of [['#seg-width-minus', -1], ['#seg-width-plus', 1]]) {
  $(id).addEventListener('click', () => {
    $('#seg-width').value = String(clampWidth(segWidth() + delta));
    if (state.plan) runSegments();
  });
}

/*
 * Typed values are clamped when the field is left, not as they are typed.
 * Clamping on every keystroke makes "12000" impossible to type, because the
 * "1" becomes 1000 before the "2" arrives.
 */
for (const id of ['#seg-size', '#seg-width']) {
  $(id).addEventListener('change', () => { writeSegInputs(); if (state.plan) runSegments(); });
}

$('#seg-run').addEventListener('click', runSegments);
$('#seg-clear').addEventListener('click', clearSegments);
$('#seg-png').addEventListener('click', exportPng);
$('#seg-pdf').addEventListener('click', () => window.print());

/*
 * A saved map is a reason to skip the address entirely.
 *
 * Somebody coming back to look at last week's measurement should not have to
 * type an address they already measured to reach it. Offered only when there
 * is something saved, so a first visit is one field and one button.
 */
$('#btn-open-saved').addEventListener('click', () => {
  showStep('work');
  setTab('saved');
});

/*
 * Ticking this used to do NOTHING until the next detection.
 *
 * The option changes how a mask already in hand is traced, which costs nothing
 * and takes no time -- so the only reason it waited for a fresh prediction was
 * that nothing was listening. A switch whose effect appears several minutes and
 * one payment later is indistinguishable from a switch that does not work.
 */
$('#toggle-trees').addEventListener('change', (e) => {
  state.fillGaps[fillGapsMode()] = e.target.checked;
  retrace();
});
/*
 * Going back inside the line must not cost a detection.
 *
 * Unticking this re-clips what is already on the map rather than asking for a
 * fresh prediction: the AI's work is kept and simply trimmed, so switching
 * between the two ways of measuring is free and reversible with undo.
 */
$('#toggle-outside').addEventListener('change', (e) => {
  state.measureOutside = e.target.checked;

  if (state.measureOutside) {
    setStatus('Measuring outside the property line. The Add brush will paint '
      + 'anywhere — take care not to pick up the neighbours\' grass.', 'warn');
    return;
  }

  const { trimmed } = clipShapesToParcel();
  setStatus(trimmed > 0
    ? `Trimmed back to your property line — ${Math.round(trimmed).toLocaleString()} sq ft removed. Your detected lawn is kept.`
    : 'Back inside your property line. Nothing was outside it.');
});

$('#toggle-overlay').addEventListener('change', (e) => {
  e.target.checked ? showOverlay() : hideOverlay();
});

/*
 * Developer mode is decided before the map loads, so the panel is either there
 * from the start or never appears -- a box of knobs that materialises later
 * looks like a bug to anyone who was not expecting it.
 */
state.dev = devUnlocked();
wireDevPanel();
refreshDevPanel();

/*
 * Typing the key onto a page that is ALREADY OPEN has to work too.
 *
 * Adding a hash to the current URL is a same-document navigation: the browser
 * fires hashchange and does not reload, so nothing above this line runs again.
 * Without this the key appears broken in the most likely way anyone would try
 * it -- you are looking at your lawn, you append the word, the address bar
 * takes it, and absolutely nothing happens.
 */
window.addEventListener('hashchange', () => {
  if (state.dev) return;
  state.dev = devUnlocked();
  if (state.dev) {
    // The picker was built before the unlock, so it has no Testing entry in it
    // yet. Rebuilding is what makes the method appear without a reload.
    buildModelPicker();
    refreshDevPanel();
    // The allowance is larger in here, so the badge has to say so.
    refreshQuota();
    setStatus('Developer mode on. Pick "Testing" under AI method to control the prompt, cut and inversion.');
  }
});

/* ---------------------------------------------------- the account, wired */
$('#account-btn').addEventListener('click', () => {
  if (state.user) {
    renderAccountSheet();
    openSheet('#account-sheet');
  } else {
    // force: tapping the account button IS the ask, so the once-a-session
    // guard on the automatic offer must not swallow it.
    promptSignin({ force: true });
  }
});

$('#signin-close').addEventListener('click', () => closeSheet('#signin'));
$('#account-close').addEventListener('click', () => closeSheet('#account-sheet'));

/* Tapping the darkened area behind a sheet closes it, which is what everyone
 * tries first. The test is on the target itself, so a press inside the card
 * does not count as a press outside it. */
for (const id of ['#signin', '#account-sheet']) {
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeSheet(id); });
}
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeSheet('#signin');
  closeSheet('#account-sheet');
  closeTools();
});

/* ------------------------------------------------------- the tools menu */
/*
 * Two links to the rest of the toolbox, which lives on another site.
 *
 * A menu and not two more buttons in the header: they are a set, and the bar
 * already carries the allowance badge and the account on a 390px screen.
 *
 * `aria-expanded` is set here rather than only in the markup because it is the
 * thing a screen reader reads to say whether the menu is open, and a static
 * "false" on a button that opens something is worse than no attribute -- it is
 * an assertion, and it would be wrong half the time.
 */
function setTools(open) {
  const menu = $('#tools-menu');
  const btn = $('#tools-btn');
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}
const closeTools = () => setTools(false);

$('#tools-btn').addEventListener('click', (e) => {
  // Or the document listener below sees this same click and closes it again.
  e.stopPropagation();
  setTools($('#tools-menu').hidden);
});

/*
 * Anywhere else closes it, which is what everybody tries first -- and a menu
 * that can only be dismissed by pressing its own button is one people navigate
 * away from instead. The links close it too: a target="_blank" leaves this page
 * exactly as it was, so without this the menu is still hanging open on the tab
 * they come back to.
 */
document.addEventListener('click', (e) => {
  if (!$('#tools-menu').hidden && !e.target.closest('#tools-menu')) closeTools();
});
for (const link of document.querySelectorAll('#tools-menu a')) {
  link.addEventListener('click', () => closeTools());
}

$('#signin-email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#signin-note');
  const button = $('#signin-send');
  const email = $('#signin-email').value.trim();

  button.disabled = true;
  note.textContent = 'Sending…';
  note.className = 'sheet-note';

  try {
    await api('/api/auth/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, next: location.pathname }),
    });
    /*
     * THE SAME ANSWER WHETHER OR NOT AN ACCOUNT EXISTED. The link makes one if
     * it has to, so there is nothing to disclose -- and a form that said "no
     * such account" would be a way to ask the site which of your friends have
     * signed up, one address at a time.
     */
    note.textContent = `Check ${email}. The link works once and expires in 20 minutes.`;
    note.className = 'sheet-note ok';
  } catch (err) {
    note.textContent = err.body?.message || 'That did not send. Try again in a moment.';
    note.className = 'sheet-note error';
  } finally {
    button.disabled = false;
  }
});

$('#account-signout').addEventListener('click', async () => {
  try { await api('/api/auth/signout', { method: 'POST' }); } catch { /* going anyway */ }
  state.user = null;
  renderAccountButton();
  closeSheet('#account-sheet');
  setStatus('Signed out. Maps you measure now stay in this browser.');
});

$('#account-admin').addEventListener('click', () => { location.href = '/admin.html'; });

/*
 * THE FATAL BANNER SPEAKS FOR THE MAP AND NOTHING ELSE.
 *
 * These used to be one chain with one catch, so anything that threw after the
 * map -- the quota badge, the account lookup, the sign-in notice -- was
 * reported as "The map didn't load". That shipped, and the bug it hid took a
 * report to find: a sign-in notice threw during boot, the map was already on
 * screen and working, and the app covered it with a banner blaming the map and
 * telling people to reload. Which could not help, because the thing that threw
 * was reading the URL fragment that a reload preserves.
 *
 * A wrong diagnosis is worse than a bare stack trace. It sends the reader to
 * the wrong file, and it tells the person at the other end to do the one thing
 * that cannot work.
 *
 * So: the map's own failure is fatal, because without it there is no app. What
 * comes after it is decoration on a working map -- a badge, a name in the
 * corner, a sentence about signing in -- and none of it is worth taking the
 * page down for. Each says so in the console and lets the rest continue.
 */
const afterMap = (name, fn) => async () => {
  try {
    await fn();
  } catch (err) {
    console.error(`${name} failed, which does not stop the map:`, err);
  }
};

initMap()
  .catch((err) => {
    console.error(err);
    fatal(`${err.message}. Reloading the page usually clears this.`);
    throw err;                       // the steps below need a map to decorate
  })
  // After the map, because /api/config is what says whether this deployment
  // has accounts at all -- and before nothing, because a signed-out visitor is
  // the normal case and must not wait on it.
  .then(afterMap('the allowance badge', refreshQuota))
  .then(afterMap('the account lookup', refreshAccount))
  .then(afterMap('the sign-in notice', readSigninOutcome))
  /*
   * After the account, because whether there are saved maps depends on whether
   * this is an account with maps in it -- asking before signing in is resolved
   * would offer the shortcut to an empty list, or hide it from somebody whose
   * maps are about to load.
   */
  .then(afterMap('the saved-map shortcut', async () => {
    const saves = await loadSaves();
    $('#btn-open-saved').hidden = !saves.length;
  }))
  .catch(() => {});                  // already reported above
