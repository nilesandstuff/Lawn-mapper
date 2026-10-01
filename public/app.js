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

import { measure, fromSquareMeters, geometryAreaSqM, polygonRings, SQM_PER_SQFT } from './lib/area.js';
import {
  maskToPolygons, rasterizePolygon, maskBinary, unionMasks, subtractMasks,
  coverage, polygonsFromBinary, distinctFraction, overTrimmed,
  editTraceLimits, editHoleLimit, TRACE_TOLERANCE_M, MAX_TRACE_VERTICES,
} from './lib/mask.js';
import {
  offsetEdge, nearestEdge, edgeRun, edgeLength, edgeBearing, openRing,
  nearestVertex, moveVertex, insertVertex, deleteVertex, tidyRing,
  feetToMetres, metresToFeet, ringInsideRing, ringContains, nearestPointOnRing,
  heldInsideRings,
} from './lib/edges.js';
import { afterStroke, restoreAway } from './lib/stitch.js';
import { strokeOnShapes } from './lib/brush-vector.js';
import { extendToRoads, mergeButtonPoint, mergeRings, placeInside } from './lib/frontage.js';
import { alignImages, luminance, movedCorners } from './lib/align.js';
import { snapPoint, nearestOnRings } from './lib/snap.js';
import { notchShapes } from './lib/cutout.js';
// Pasting the pieces of a big lot's detection back into one mask.
import { stitchMasks } from './lib/tiles.js';
import {
  planHandles, HANDLE_DOT_PX, HANDLE_REACH_PX, HANDLE_MAX_CORNERS,
} from './lib/handles.js';
import {
  movedEnoughToCancelHold as gestureMoved, gestureIsOurs, isTap,
  HOLD_SLOP_PX, HOLD_MS,
} from './lib/gesture.js';
import {
  planSegments,
  MIN_SEGMENT_SQFT, MAX_SEGMENT_SQFT, SEGMENT_STEP_SQFT,
  MIN_WIDTH_FT, MAX_WIDTH_FT, DEFAULT_WIDTH_FT,
} from './lib/segments.js';
import { imageFeatures, standardise, FEATURE_COUNT } from './lib/features.js';
import { mountCoverage } from './lib/coverage-ui.js';
import { predict, reviveModel } from './lib/head.js';
import {
  framePxToLngLat,
  lngLatToFramePx,
  frameCorners,
  metresPerPixel,
  zoomToFit,
  frameFor as parcelFrame,
  geometryBounds,
  worldSize,
} from './lib/mercator.js';

/* ------------------------------------------------------------------ state */

const FRAME_SIZE = 640;          // logical px on the LONGER side; the PNG comes back @2x
/*
 * How much beyond the property line the picture reaches, in metres, on
 * every side. Context the detectors need -- the house, the drive, the road
 * the grass is read against (H21) -- and no more: 12% of a 319 m lot was
 * 38 m of somebody else's garden.
 */
const FRAME_MARGIN_M = 10;
const IMAGERY_ZOOM_FALLBACK = 19; // used when we have no parcel to fit

const state = {
  clientId: clientId(),
  chosen: null,       // { label, lng, lat }
  /*
   * Whether a tap on the map moves the property pin. True only on the confirm
   * step, and set by showStep rather than by the code that enters it -- there
   * are several ways out of that step and a flag cleared by hand in each of
   * them is one the next exit will forget.
   */
  placingPin: false,
  pinMove: null,      // the latest move, so a slow lookup cannot label a new pin
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
  defaultModel: 'sam3', // what a fresh page starts on; /api/config says (the trained model where it is served)
  detectedBy: null,   // which one the shapes on screen actually came from
  detectedVersion: null, // which release of the trained model drew them, for the corpus (feedback loop 1)
  exclusions: [],     // what exclude mode can remove, from /api/config
  exclude: [],        // which of those are ticked -- one AI pass each
  detectedExcluding: null, // the tick set the shapes on screen came from
  pins: [],           // [lng, lat] the point-prompted model is told to look at
  mode: null,         // 'parcel' | 'pins' | 'shape' | null -- what taps act on
  shapeTool: 'points',// within shape mode: 'points' | 'add' | 'erase'
  /*
   * Which brush the one collapsed Brushes icon opens. The two are used in runs
   * -- three sheds rubbed out, not one shed and then one missed patch -- so
   * the useful default is whichever was last in hand rather than a fixed one.
   */
  lastBrush: 'erase',
  /*
   * Whether to come back to Points once a hand-drawn shape is finished.
   *
   * Drawing takes the map: Draw's polygon mode owns every tap while it is
   * open, so the corner tools have to be put away and the way back cannot be
   * inferred afterwards. Set only by the rail buttons, which are the ones
   * pressed from inside Points.
   */
  returnToPoints: false,
  /*
   * Corner handles: off unless asked for.
   *
   * They are genuinely crowded on a detected outline, which can carry a
   * corner every few pixels -- the placement rules stop them OVERLAPPING and
   * cannot make a hundred stalks restful to look at. Off by default so the
   * map is legible, on for the fiddly lot where reaching a corner is the
   * whole problem.
   */
  handlesOn: false,
  /*
   * Within the corner tool: tapping removes the corner instead of selecting
   * it. Never inherited -- see setMode, where entering lawn mode always puts
   * a destructive tool away.
   */
  pointEraser: false,
  brushSize: 'bulk',  // 'fine' for trimming, 'bulk' for clearing
  measureOutside: false, // may the brush paint past the property line?

  edgeFt: 0,          // shrink (-) or grow (+) the detected outline, in feet

  /*
   * What the NEXT polygon drawn by hand is for. Both default to false, which
   * means "a patch of lawn" -- the ordinary case, and the one a stale flag
   * would silently steal.
   */
  drawingParcel: false,
  drawingHole: false,   // trace a shed; it becomes a hole in the lawn under it

  /*
   * DRAWING THE INFERRED LAYER RATHER THAN THE LAWN.
   *
   * Not a different tool -- the same polygon and the same brushes -- but
   * everything drawn while it is on lands on its own layer and is marked
   * "I know this is lawn, I cannot see it".
   *
   * It has to be a layer rather than a flag on a shape because a traced lawn
   * is usually one big outline containing both kinds of ground: grass you can
   * see, then a canopy, then grass again. Marking the whole shape would say
   * the visible parts were guessed at, which is worse than saying nothing.
   *
   * The two layers are allowed to overlap, and this is the ONLY place on the
   * map where that is true -- an inferred patch normally sits on top of lawn
   * already outlined. The measurement counts ground once however many shapes
   * cover it, so overlapping adds nothing to the total and a patch reaching
   * past the edge of the lawn adds exactly the part that reaches past.
   */
  inferredMode: false,
  /*
   * Should an inferred patch be held inside the lawn?
   *
   * The same rule the property line applies to an ordinary corner, one level
   * down: usually right, because the ground under a canopy running through a
   * traced lawn is lawn on both sides. Sometimes wrong, because a lawn that
   * carries on past where anybody could see it stops at a boundary the tracer
   * guessed, and the inferred patch is the correction to that guess.
   *
   * SO IT ONLY GOVERNS WHAT MOVES WHILE IT IS ON. Switching it either way
   * changes nothing already on the map. A setting that reshapes work done
   * under a different setting is one nobody can trust, and this one would be
   * reshaping the careful layer using the sloppy one as its boundary.
   */
  inferredInside: false,
  /*
   * NOT-LAWN TRACES (tinker mode, owner 2026-09-29): polygons of ground that
   * is definitely not lawn -- a parking lot, a road, a pond -- traced to its
   * edges, for training. A plain list of geometries, NOT shapes in Draw:
   * everything in Draw is lawn to the measurement, the brushes and the merge,
   * and these must never be any of that. Drawn with Draw's polygon tool, then
   * lifted out of it the moment they close (see draw.create).
   */
  notLawn: [],
  notLawnMode: false,
  /* True for the moment it takes Draw to close a not-lawn trace that was cut
     short (see leaveNotLawnMode): the flag above is already off by then. */
  notLawnClosing: false,
  // The training candidate being corrected, when the console sent us here.
  // Null far more often than not, and the way back out is shown only while it
  // is set -- see leaveReview.
  reviewingId: null,

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
  /*
   * CAN THIS DEPLOYMENT SEND A SIGN-IN LINK? THREE ANSWERS, NOT TWO.
   *
   *   null   nobody has managed to ask yet
   *   true   yes
   *   false  no, and the panel says so
   *
   * It was a plain false to start with, so a single dropped /api/auth/me on a
   * phone -- the ordinary event this app is used inside of -- left the default
   * standing, and the sign-in panel then TOLD people the site cannot send
   * email. One field missing, no way back except a reload nobody knows to do.
   *
   * Not knowing is its own answer and has to be stored as one.
   */
  emailSignin: null,
  saves: [],          // the account's maps, cached so the list is not a wait
  saveMax: 0,         // how many an account keeps, as the Worker reports it
  plan: null,         // the last application split, or null for none drawn

  /*
   * The paid queue. All three are null for everybody who did not arrive from a
   * crowd platform, which is everybody -- see the job-mode section.
   *
   *   worker         their id as the platform names them, out of the link
   *   job            the one lawn they are holding, or null between lawns
   *   askedUnchanged they have been told once that the outline is untouched,
   *                  so sending it again goes through and is flagged
   */
  worker: null,
  job: null,
  askedUnchanged: false,
  /* 'crowd', 'hired' or 'volunteer' -- the server decides, see routeFor. */
  jobRoute: 'crowd',
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

/*
 * The two numbers that decide what a traced outline looks like --
 * TRACE_TOLERANCE_M and MAX_TRACE_VERTICES -- live in lib/mask.js beside the
 * tracer, and are imported above. They moved there when the training tool
 * started drawing the outline a model would hand the drawing tools: the
 * picture is only worth looking at if it is traced the way this app traces,
 * and two copies of a number are two numbers eventually.
 */

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
   * A browser test cannot aim at a handle it cannot locate, and reading one
   * off a screenshot would be guesswork. One entry per placed handle, with the
   * corner it drives, so a test can tap a stalk and then assert that the right
   * corner is the one that moved.
   */
  /*
   * UNROUNDED, which cost a false failure. Rounding each coordinate for
   * readability moves a point by up to half a pixel in each axis, so a pair
   * genuinely 15.2 px apart can measure 14.6 -- and the check asserting that
   * no two handles come within the clearance then fails on arithmetic it did
   * itself. A probe reports what it knows; the caller can round to print.
   */
  window.__lmHandles = () => handlePlan.map((h) => ({
    x: h.at.x,
    y: h.at.y,
    index: h.index,
    reach: Math.hypot(h.dx, h.dy),
  }));
  /** Whether the map declined to place any, because there is no room. */
  window.__lmHandlesCrowded = () => handlesCrowded;

  /*
   * The corners themselves, for aiming at and for counting.
   *
   * A delete that silently did nothing and a delete that worked look identical
   * on a map, so the eraser is checked by counting rather than by looking --
   * and a test cannot tap a corner whose position it has to guess.
   */
  window.__lmCorners = () => editableRings().flatMap(({ ringId, ring }) =>
    openRing(ring).map((p) => {
      const q = map.project(p);
      // `hole` so a check can aim at a cut-out's corner specifically: that
      // those exist at all is the thing under test, and a tap at a corner
      // that turns out to belong to the outline proves nothing about them.
      return { x: q.x, y: q.y, hole: isHoleRing(ringId), notLawn: isNotLawnRing(ringId) };
    }));
  window.__lmCornerCount = () => editableRings()
    .reduce((n, { ring }) => n + openRing(ring).length, 0);

  /*
   * CUT A SQUARE OUT OF THE BIGGEST SHAPE, without drawing it by hand.
   *
   * Mapbox Draw's polygon mode is driven by a run of synthetic clicks and a
   * closing tap on the first corner, which is exactly the kind of gesture that
   * fails for reasons having nothing to do with what is under test. So the
   * gesture is checked where it can be -- the button arms Draw and sets the
   * flag -- and the thing the gesture PRODUCES is handed to the real
   * cutHoleFromDrawn from here.
   *
   * The square is placed at the point furthest from the outline, with a
   * half-width of half that distance. Every corner of it is then within
   * r*sqrt(2) of a centre that is 2r from the nearest edge, so it is inside
   * whatever shape this is -- rather than inside a bounding box, which on a
   * concave parcel is not the same thing and is how this kind of helper
   * usually starts failing on real geometry.
   */
  window.__lmCutSquare = () => {
    const shapes = draw.getAll().features.filter((f) => outerRing(f));
    if (!shapes.length) return { ok: false, why: 'no shapes' };

    const host = shapes
      .map((f) => ({ f, ring: outerRing(f) }))
      .sort((a, b) => measure(b.f.geometry).squareFeetRaw - measure(a.f.geometry).squareFeetRaw)[0];

    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lng, lat] of host.ring) {
      w = Math.min(w, lng); e = Math.max(e, lng);
      s = Math.min(s, lat); n = Math.max(n, lat);
    }

    let best = null;
    const STEPS = 16;
    for (let i = 1; i < STEPS; i++) {
      for (let j = 1; j < STEPS; j++) {
        const p = [w + ((e - w) * i) / STEPS, s + ((n - s) * j) / STEPS];
        if (!ringContains(host.ring, p)) continue;
        const clear = nearestEdge(host.ring, p)?.distanceM ?? 0;
        if (!best || clear > best.clear) best = { p, clear };
      }
    }
    if (!best || best.clear < 2) return { ok: false, why: 'nowhere clear enough inside' };

    // Metres -> degrees at this latitude, so the square really is square.
    const r = best.clear / 2;
    const dLat = r / 111320;
    const dLng = r / (111320 * Math.cos((best.p[1] * Math.PI) / 180));
    const [x, y] = best.p;
    const ring = [
      [x - dLng, y - dLat], [x + dLng, y - dLat],
      [x + dLng, y + dLat], [x - dLng, y + dLat], [x - dLng, y - dLat],
    ];

    /*
     * Measured on the HOST SHAPE, not on the panel's total. The total is
     * corrected for shapes that overlap, which is a raster estimate -- exact
     * enough for a measurement and not exact enough to assert "the number fell
     * by precisely the size of the cut" against. The host's own geodesic area
     * already subtracts its holes, so it answers that question exactly.
     */
    const hostArea = () => {
      const live = draw.get(host.f.id);
      // squareFeetRaw, not squareFeet: the published figure is rounded to the
      // nearest ten, which is right on screen and would swamp the difference
      // a small cut makes when a check subtracts one from the other.
      return live ? measure(live.geometry).squareFeetRaw : 0;
    };
    const before = hostArea();

    // Stand in for the drawing finishing: Draw leaves polygon mode on its own
    // when a real outline closes, and leaving it armed here would have the
    // next tap in the check start tracing another one.
    try { draw.changeMode('simple_select'); } catch { /* Draw not ready */ }
    state.drawingHole = false;
    cutHoleFromDrawn({ geometry: { type: 'Polygon', coordinates: [ring] } });
    return {
      ok: true,
      before,
      after: hostArea(),
      total: totalSquareFeet(),
      cutSqFt: measure({ type: 'Polygon', coordinates: [ring] }).squareFeetRaw,
      said: document.querySelector('#status')?.textContent || '',
    };
  };

  /*
   * A cut AT THE EDGE (owner, 2026-10-01): a square straddling the middle of
   * the largest shape's first edge, two corners outside the lawn. It must take
   * a notch out -- some area, less than the whole square -- not be refused.
   */
  window.__lmCutAtEdge = () => {
    const shapes = draw.getAll().features.filter((f) => outerRing(f));
    if (!shapes.length) return { ok: false, why: 'no shapes' };
    const host = shapes.sort((a, b) => measure(b.geometry).squareFeetRaw - measure(a.geometry).squareFeetRaw)[0];
    const [p0, p1] = outerRing(host);
    const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const r = 1.5; // metres
    const dLat = r / 111320;
    const dLng = r / (111320 * Math.cos((mid[1] * Math.PI) / 180));
    const [x, y] = mid;
    const ring = [
      [x - dLng, y - dLat], [x + dLng, y - dLat],
      [x + dLng, y + dLat], [x - dLng, y + dLat], [x - dLng, y - dLat],
    ];
    const before = totalSquareFeet();
    try { draw.changeMode('simple_select'); } catch { /* Draw not ready */ }
    state.drawingHole = false;
    cutHoleFromDrawn({ geometry: { type: 'Polygon', coordinates: [ring] } });
    return {
      ok: true,
      before,
      after: totalSquareFeet(),
      cutSqFt: measure({ type: 'Polygon', coordinates: [ring] }).squareFeetRaw,
      said: document.querySelector('#status')?.textContent || '',
    };
  };

  /* Is the next hand-drawn polygon armed to become a cut-out? */
  window.__lmDrawingHole = () => ({
    armed: state.drawingHole,
    drawMode: (() => { try { return draw.getMode(); } catch { return null; } })(),
  });

  /*
   * How much of the lawn is OUTSIDE the property line, in square feet.
   *
   * The number the "measure outside" option is really about. Asserting on the
   * panel total instead would pass a corner dragged twenty metres over the
   * boundary as long as the total moved at all, which is the bug: the total
   * did move, and that was the complaint.
   *
   * Rasterised rather than clipped with polygon boolean geometry, for the
   * reason lib/mask.js gives at length -- it is exact for any shape, holes
   * included, and needs no library.
   */
  window.__lmOutsideSqFt = () => {
    const parcel = parcelRing();
    const shapes = draw.getAll().features.filter((f) => outerRing(f));
    if (!parcel || !shapes.length) return 0;

    const G = 512;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    const see = ([lng, lat]) => {
      w = Math.min(w, lng); e = Math.max(e, lng);
      s = Math.min(s, lat); n = Math.max(n, lat);
    };
    parcel.forEach(see);
    for (const f of shapes) for (const ring of f.geometry.coordinates) ring.forEach(see);

    const pad = 0.0002;
    const bbox = [w - pad, s - pad, e + pad, n + pad];
    const frame = {
      lng: (bbox[0] + bbox[2]) / 2,
      lat: (bbox[1] + bbox[3]) / 2,
      zoom: zoomToFit(bbox, G),
      size: G,
    };
    const project = (ll) => lngLatToFramePx(frame, ll, G, G);

    const inside = rasterizePolygon([parcel], G, G, project);
    const lawn = unionMasks(shapes.map(
      (f) => rasterizePolygon(f.geometry.coordinates, G, G, project)
    ));

    let out = 0;
    for (let p = 0; p < lawn.length; p++) if (lawn[p] && !inside[p]) out++;

    const mPerPx = metresPerPixel(frame, G);
    return (out * mPerPx * mPerPx) / SQM_PER_SQFT;
  };

  /*
   * WHAT THE TRIM CAN PROMISE, which is not what it looks like it promises.
   *
   * Trimming to the property line rasterises, keeps the pixels inside, and
   * then TRACES THE MASK BACK to a polygon at TRACE_TOLERANCE_M. That last
   * step is a deliberate trade -- the table in lib/mask.js measures it -- and
   * it means the traced outline may sit up to a tolerance either side of the
   * pixel boundary, including outside the line.
   *
   * So the guarantee is "no PIXEL of the kept mask is outside the parcel, on
   * the trim's own grid", not "no POINT of the resulting polygon is outside
   * the parcel". A residue is expected, and its ceiling is the tolerance
   * times the length of line it could wander along.
   *
   * Exposed as the two facts rather than as the bound, so a test does the
   * arithmetic in front of the reader instead of trusting a number from here.
   */
  window.__lmParcelEdge = () => {
    const ring = parcelRing();
    if (!ring) return null;
    const verts = openRing(ring);
    let perimetreM = 0;
    for (let i = 0; i < verts.length; i++) perimetreM += edgeLength(ring, i);
    return { perimetreM, traceToleranceM: TRACE_TOLERANCE_M, corners: verts.length };
  };

  /* How many shapes the measurement is actually made of. */
  window.__lmShapeCount = () => (draw ? draw.getAll().features.length : 0);

  /* The measured area, from the geometry rather than the formatted panel. */
  window.__lmSqft = () => (draw ? totalSquareFeet() : 0);
  /* Not-lawn traces kept apart from the lawn, and whether the open trace is
     being drawn in their colour (tinker mode). */
  window.__lmNotLawn = () => ({
    count: state.notLawn.length,
    corners: state.notLawn.reduce((n, g) => n + Math.max(0, (g?.coordinates?.[0]?.length || 1) - 1), 0),
    tracing: state.notLawnMode,
    draftRed: (() => {
      try {
        return (map.getStyle().layers || []).some((l) => l.id.startsWith('gl-draw-polygon-fill-active')
          && map.getPaintProperty(l.id, 'fill-color') === '#e53935');
      } catch { return false; }
    })(),
  });

  /*
   * How deep the undo stack is.
   *
   * The button's disabled state answers "is there anything at all", which is
   * not the question when the worry is a step that undoes NOTHING -- an action
   * that pushed history and then changed its mind leaves the button looking
   * exactly right and does nothing when pressed. Only the depth catches that.
   */
  window.__lmHistory = () => history.length;
  // Zoom in on the i-th merge button's neighbour, as a person would to tap it.
  window.__lmZoomToNeighbour = (i = 0, zoomBy = 2.5) => {
    const m = neighbourState.markers[i];
    if (!m?.lmPlace) return false;
    map.jumpTo({ center: m.lmPlace.pref, zoom: map.getZoom() + zoomBy });
    return true;
  };
  // Tinker mode's neighbours and their merge buttons: whether each button is
  // shown, and whether every corner of it sits inside its own parcel.
  window.__lmNeighbours = () => {
    const inPoly = (poly, [x, y]) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const box = map.getContainer().getBoundingClientRect();
    return {
      count: neighbourState.all.length,
      parcelM2: state.parcel ? measure(state.parcel.geometry).squareMeters ?? null : null,
      parcelSqFt: state.parcel ? measure(state.parcel.geometry).squareFeetRaw : null,
      buttons: neighbourState.markers.map((m) => {
        const el = m.lmPlace?.el;
        const shown = Boolean(el && el.style.display !== 'none' && el.style.visibility !== 'hidden');
        const r = el ? el.getBoundingClientRect() : null;
        const poly = m.lmPlace ? m.lmPlace.nb.ring.map((ll) => { const q = map.project(ll); return [q.x, q.y]; }) : [];
        const corners = r ? [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]]
          .map(([x, y]) => [x - box.left, y - box.top]) : [];
        return { shown, label: el?.textContent, diag: m.lmDiag, inside: corners.length === 4 && corners.every((c) => inPoly(poly, c)),
          x: r ? (r.left + r.right) / 2 : null, y: r ? (r.top + r.bottom) / 2 : null };
      }),
    };
  };
  // The drawing in progress: which Draw mode, how many corners, both stacks.
  window.__lmDraft = () => ({
    mode: draw ? draw.getMode() : null,
    corners: draftCorners(),
    history: history.length,
    future: future.length,
  });

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
   * The property pin, and whether a tap would move it.
   *
   * Here because "the pin only moves by dragging" is not visible from the
   * screen: the tap listener was registered by armLawnPicker, so it existed
   * on every screen with a drawing tool and on none without one -- and the
   * confirm step has no tool. A listener that is present and a listener that
   * is reached are different claims, and only the second one matters.
   */
  window.__lmChosen = () => (state.chosen
    ? { lng: state.chosen.lng, lat: state.chosen.lat, label: state.chosen.label || '' }
    : null);
  window.__lmPlacingPin = () => state.placingPin === true;

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
    /*
     * The SHAPES a tap can reach, deduped -- which is the question modes
     * answer. What editableRings hands back is one entry per ring, and a lawn
     * with two sheds cut out of it is three of those and still one shape; a
     * check about isolation asking "how many rings" would start failing the
     * day somebody cut a hole.
     */
    ids: [...new Set(editableRings().map((r) => ringOwner(r.ringId).featureId))],
    rings: editableRings().length,
    holes: editableRings().filter((r) => isHoleRing(r.ringId)).length,
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
    /*
     * PINCH, READ FROM THE PINCH HANDLER RATHER THAN FROM THE WRAPPER -- which
     * is the same mistake the tapDragZoom fix was written to correct, one
     * field over, and it reported a working map as broken for a week.
     *
     * map.touchZoomRotate is a wrapper around THREE handlers, and its
     * isEnabled is an AND over all of them:
     *
     *   isEnabled() { return this._touchZoom.isEnabled()
     *                     && (this._rotationDisabled || this._touchRotate.isEnabled())
     *                     && this._tapDragZoom.isEnabled() }
     *
     * We deliberately disable tapDragZoom -- it is the tap-then-drag gesture
     * that collided head-on with tap, pan, tap -- so the wrapper reads false
     * for ever afterwards while pinch-to-zoom is perfectly alive. Read
     * verbatim out of mapbox-gl-js v3.9.0; not deduced.
     */
    touchZoom: Boolean(map?.handlers?._handlersById?.touchZoom?.isEnabled()),
    /* The wrapper's own answer, kept because it is what a reader would reach
       for first and it needs to be visibly NOT the pinch answer. */
    touchZoomRotateWrapper: Boolean(map?.touchZoomRotate?.isEnabled()),
    /*
     * THE TWO ZOOM-BY-TAPPING SWITCHES, separately, because reading one of
     * them as though it covered both is what kept this bug alive.
     *
     * `doubleClickZoom` wraps the mouse double-click and the touch double-tap.
     * It does NOT wrap tapDragZoom -- tap, then touch and drag -- which is the
     * gesture that collides head-on with tap, pan, tap, and which read as
     * "off" here for weeks while being on. They are reported apart now so the
     * panel cannot say the thing is disabled when only its neighbour is.
     */
    doubleClickZoom: Boolean(map?.doubleClickZoom?.isEnabled()),
    tapDragZoom: Boolean(map?.handlers?._handlersById?.tapDragZoom?.isEnabled()),
    panning: panningHeld(),
    holdMs: PAN_HOLD_MS,
    /*
     * The two distances that decide who owns a one-finger gesture, reported
     * because they were once one number and the bug that caused was invisible
     * from the screen: a stroke that stayed inside the tap slop got discarded
     * half a second in, and the map started moving instead.
     */
    holdSlopPx: HOLD_SLOP_PX,
    touchAction: map ? map.getContainer().style.touchAction || '(default)' : null,
    armed: diag.armed,
    painting: Boolean(eraser?.painting),
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
    /* A step's own tool has no button (restMode); it is on the rail when it
       is in hand, which on its step is always. */
    rail: MODES.filter((m) => {
      const btn = document.querySelector(`#mode-${m}`);
      return btn ? btn.hidden === false : state.mode === m;
    }),
    locked: TABS.filter((t) => Boolean(tabLock(t))),
    noticeVisible: document.querySelector('#lock-notice')?.hidden === false,
    handEdited: state.handEdited,
    hasParcel: Boolean(state.parcel),
  });

  /*
   * The paid queue, as a browser test can see it.
   *
   * Everything here is readable from the DOM except the first three, and those
   * three are the ones worth asserting: whether a lawn was actually CLAIMED is
   * the difference between a preview that browsed and a preview that took a
   * lawn out of the queue for an hour. `sheet` is the title only -- the whole
   * refusal wording is the server's and is checked where it is written.
   */
  window.__lmJob = () => ({
    worker: state.worker,
    jobId: state.job?.id || null,
    handEdited: state.handEdited,
    barVisible: document.querySelector('#job-bar')?.hidden === false,
    prompts: document.querySelectorAll('#job-prompts .job-ask').length,
    sheet: document.querySelector('#job-sheet')?.hidden === false
      ? document.querySelector('#job-sheet-title')?.textContent || ''
      : null,
    code: document.querySelector('#job-code')?.hidden === false
      ? document.querySelector('#job-code')?.textContent || ''
      : null,
    /* What a paid worker must not be offered: the steps that do not exist for
       somebody who never typed an address and has no account. */
    offered: ['tab-detect', 'tab-saved', 'tab-plan', 'btn-finish', 'account-btn']
      .filter((id) => {
        const el = document.querySelector(`#${id}`);
        return el && !el.hidden && getComputedStyle(el).display !== 'none';
      }),
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
      return { ringId: m.ringId, edgeIndex: m.edgeIndex,
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

  /*
   * The tour, and where each of its arrows ends. Same reasoning as __lmTip:
   * the words cannot be wrong, the aim can -- so every card reports the
   * rectangle it claims to point at and the point its arrow actually reaches.
   */
  window.__lmTour = () => ({
    stage: tour.stage,
    visible: !document.getElementById('tour').hidden,
    stepping: tour.stepping,
    index: tour.index,
    total: tour.total,
    items: tour.placed.map((p) => ({ ...p })),
  });

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
    // What THIS visitor at THIS address is offered: no developer-only
    // methods, and no land cover map outside Virginia.
    offered: offeredModels().map((m) => m.id),
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
      // The photographs only; the overlays under "Compare against" are not sources.
      options: [...list.querySelectorAll('button[data-provider]')].map((b) => ({
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
    /* Where the picture SHOULD sit: the frame, moved by NAIP's alignment
       with Mapbox when NAIP is showing (lib/align.js), else the frame. */
    alignedCorners: state.frame
      ? (alignOf(state.provider)
        ? movedCorners(frameCorners(frameFor(state.provider, state.frame)),
          alignOf(state.provider).east, alignOf(state.provider).north, alignOf(state.provider).scale)
        : frameCorners(frameFor(state.provider, state.frame)))
      : null,
    naipAlign: state.naipAlign || null,
    googleAlign: state.googleAlign || null,
    frameImageUrl: state.frame && !providerInfo(state.provider).tiles
      ? imageryUrlFor(state.provider, frameFor(state.provider, state.frame))
      : null,
  });

  window.__lmPoints = (want = null) => {
    if (!map || !state.edgeEdit) return [];
    const rect = map.getCanvasContainer().getBoundingClientRect();
    return editableRings().map(({ ringId, ring }) => {
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
        ringId,
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
  /* The caller's own cancel (the detection timer's Cancel and Retry). */
  const outer = options.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let res;
  try {
    res = await fetch(path, { ...options, signal: controller.signal });
  } catch (err) {
    if (outer?.aborted) {
      const e = new Error('Cancelled.');
      e.cancelled = true;
      throw e;
    }
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
  /*
   * Taps on the map move the pin ONLY while the confirm step is up.
   *
   * Cleared here rather than at each place that leaves the step, because
   * there are several ways out -- confirming, going back, starting over -- and
   * a flag that has to be cleared in every one of them is a flag that will be
   * left set by the next one somebody adds. A stray tap on the measuring
   * screen relocating the property would be a very bad way to find that out.
   */
  state.placingPin = name === 'confirm';
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
const idle = () => {
  $('#busy').hidden = true;
  stopDetectionTimer();
};

/* ------------------------------------------------ the detection timer */
/*
 * HOW LONG, AND A WAY OUT (owner, 2026-09-29). A detection can take a minute
 * or more -- the trained model's first lot of a quiet spell starts a GPU --
 * and a spinner alone gives no way to tell slow from stuck. So the overlay
 * counts, and at 90 seconds offers Cancel and Retry.
 *
 * NEITHER COSTS A DETECTION. The allowance is charged when the press starts
 * (every prediction is billed from then); cancelling asks the Worker to hand
 * it back, which it does unless the detector had in fact already answered --
 * in which case the answer is shown rather than thrown away. See presses.js.
 */
const DETECT_PATIENCE_S = 90;
let detection = null;   // {press, abort, started, timer, action}

function startDetectionTimer(run) {
  const tick = () => {
    const secs = Math.floor((Date.now() - run.started) / 1000);
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    /* What to expect (owner, 2026-09-29), and an honest word once past it. */
    $('#busy-timer').textContent = secs < 60
      ? `${clock} · usually takes less than 60 seconds`
      : `${clock} · taking longer than usual`;
    $('#busy-timer').hidden = false;
    if (secs >= DETECT_PATIENCE_S && !run.action) $('#busy-actions').hidden = false;
  };
  tick();
  run.timer = setInterval(tick, 1000);
}

function stopDetectionTimer() {
  if (detection?.timer) clearInterval(detection.timer);
  $('#busy-timer').hidden = true;
  $('#busy-actions').hidden = true;
}

/** Ask the Worker to hand a press back. Never throws. */
async function releasePress(press, reason) {
  try {
    return await api('/api/segment/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ press, clientId: state.clientId, reason }),
      timeoutMs: 40000,
    });
  } catch {
    return { refunded: false };
  }
}

/** Cancel or Retry, pressed on the overlay. */
async function giveUpOnDetection(action) {
  const run = detection;
  if (!run || run.action) return;
  run.action = action;
  $('#busy-actions').hidden = true;
  busy(action === 'retry' ? 'Starting again…' : 'Cancelling…');
  const got = await releasePress(run.press, action);
  if (got.finished) {
    /* It answered while the buttons were up: show it rather than bin it. */
    run.action = 'finishing';
    busy('It has just finished — loading it…');
    return;
  }
  run.released = true;
  run.abort.abort();
}

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
    coverage, overlays, defaultModel,
  } = await api('/api/config');
  state.accountsOn = Boolean(accounts);
  /*
   * Before the map, deliberately. This writes the "where property lines come
   * from" sentence on the very first screen, and that screen is already on
   * show -- a visitor reading it while Mapbox loads should be reading the
   * real numbers, not the placeholder that has to be there in case this
   * request fails.
   */
  mountCoverage({ summary: coverage, fetchList: () => api('/api/coverage') });
  state.imagery = Array.isArray(imagery) ? imagery : [];
  /* Things drawn ON the photograph rather than instead of it. A deployment
     without them simply has none, and the picker shows no second section. */
  state.overlays = Array.isArray(overlays) ? overlays : [];
  state.overlaysOn = new Set();
  state.models = Array.isArray(models) ? models : [];
  /* The trained model where the Worker serves one, "Find grass" where not.
     Only a method that is actually offered, so an old Worker or a pulled
     release lands on the one that always works. */
  state.defaultModel = knownModel(defaultModel) ? defaultModel : 'sam3';
  state.model = state.defaultModel;
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
    /*
     * SET AT CONSTRUCTION, not disabled afterwards.
     *
     * Disabling it after the map was built did not stop the gesture, reported
     * twice. The constructor option is the documented way and means the
     * handler is never turned on in the first place, so there is no window and
     * nothing to re-enable it.
     *
     * The gesture is Mapbox's tap-drag zoom: a second touch inside the
     * double-tap window, dragged. Correcting a lawn is tap, pan, tap -- the
     * same gesture -- so the map had to guess which was meant.
     */
    doubleClickZoom: false,
    // Required so the map canvas can still be read after the browser has
    // composited it -- without this, "Save image" produces a blank PNG.
    preserveDrawingBuffer: true,
  });
  // The constructor flag covers the mouse; this is the two-finger twist, which
  // is a separate handler and the one that actually gets triggered by accident.
  map.touchZoomRotate.disableRotation();

  /*
   * DOUBLE-TAP ZOOM IS OFF, and it is the gesture, not a setting, that is
   * wrong here.
   *
   * THE REPORT: "tap and drag shortly after and the view zooms -- very
   * disruptive if your workflow is tap, pan, tap, repeat." That is Mapbox's
   * tap-drag zoom: a second touch within the double-tap window, dragged, zooms
   * instead of panning. Correcting a lawn IS tap, pan, tap, repeat -- select a
   * corner, move the map, select the next -- so the app's main gesture and the
   * zoom gesture are the same gesture, and the map was guessing which one was
   * meant. It guessed wrong about as often as not.
   *
   * `doubleClickZoom` covers both halves: the mouse's dblclick and the touch
   * tap-drag, which are two handlers behind one switch.
   *
   * OFF EVERYWHERE, rather than only while editing. Turning a handler on and
   * off by mode is exactly the pattern that produced the dragPan bugs further
   * down this file -- one handler serving two gestures, left in the wrong
   * state by whichever path exited last. And it costs nothing: every tap on
   * this map means something from the moment a lot is on screen, pinch still
   * zooms, and the +/- control is in the corner.
   */
  // Belt and braces with the constructor option above. Harmless if already off.
  map.doubleClickZoom.disable();

  /*
   * AND THE THIRD HANDLER, which is the one that was actually doing it.
   *
   * Reported three times, and twice "fixed" against the wrong switch. Mapbox
   * GL v3 registers THREE zoom-by-tapping handlers, not two, and the names do
   * not divide the way they read:
   *
   *   clickZoom     a mouse double-click          } both wrapped by
   *   tapZoom       a touch double-tap            } map.doubleClickZoom
   *   tapDragZoom   tap, then touch and drag      } NOT wrapped by anything
   *
   * `doubleClickZoom` is constructed as `new DoubleClickZoomHandler(clickZoom,
   * tapZoom)` -- tapDragZoom is added to the handler list separately and is
   * owned by `touchZoomRotate` instead. So the constructor flag and
   * `.disable()` both turn off the two that were never the problem, and
   * `touchZoomRotate.disableRotation()` disables the rotate handler only. The
   * gesture in the report -- tap, then tap and drag -- is tapDragZoom, and
   * nothing here had ever touched it. Read out of the running map rather than
   * guessed at: with both of the above applied, tapDragZoom.isEnabled() is
   * still true.
   *
   * It is not exposed on the map object (map.tapDragZoom is undefined), so
   * this reaches into the handler registry -- which is why it is wrapped. The
   * alternative, touchZoomRotate.disable(), would take pinch-to-zoom with it.
   *
   * Confirmed in a browser that this leaves touchZoom enabled, so pinch still
   * works, which is the whole point of not using the blunt switch.
   */
  try {
    const tapDrag = map.handlers?._handlersById?.tapDragZoom;
    if (tapDrag?.disable) tapDrag.disable();
    diag.tapDragZoomOff = tapDrag ? !tapDrag.isEnabled() : 'no handler';
  } catch (err) {
    /* A private field that moved in a Mapbox upgrade is a gesture coming
       back, not a broken map. Record it and carry on -- and the developer
       panel reports it, so it is visible rather than silently undone. */
    diag.tapDragZoomOff = `failed: ${err.message}`;
  }

  /*
   * TAPS ARE LISTENED FOR ALWAYS, and this is the second half of "the pin
   * only moves by dragging".
   *
   * This listener used to be added by armLawnPicker and removed by
   * disarmLawnPicker, so a tap only reached handleMapPoint while a DRAWING
   * TOOL was armed. That was invisible for as long as every tap-driven feature
   * was a drawing tool. The confirm step is not: nothing is armed there, so
   * `map.on('click')` was never registered, and the branch that moves the
   * property pin could not run however correct it was.
   *
   * Registering it for the life of the map instead. handleMapPoint already
   * decides for itself what a tap means -- it returns early mid-draw, and
   * otherwise does nothing at all unless the pin, an edge or the detection
   * pins are expecting one. A listener whose handler is a no-op costs nothing;
   * a listener that is absent costs a feature, silently, and only on the
   * screens nobody thought to arm.
   *
   * The touch path still calls handleMapPoint directly while a tool is armed,
   * and still records the tap in `handled`, so the synthetic click that
   * follows a touch is suppressed exactly as before.
   */
  map.on('click', onMapClick);

  /*
   * AND THE TOUCH HALF OF THE SAME FIX, which was left behind.
   *
   * Moving `map.on('click')` to the life of the map fixed a tap on a MOUSE.
   * The touch listeners stayed inside armLawnPicker, so on a phone -- the only
   * device this app is really used on -- a tap on the confirm step still
   * reached nothing at all, and the pin still moved only by dragging. The
   * browser check caught it saying "reached handler 0x (touch 0, click 0)".
   *
   * It has to be a touch listener rather than the click one, because Mapbox GL
   * Draw calls preventDefault on touchend and the browser then synthesises no
   * click. That is the whole reason there are two paths into handleMapPoint.
   *
   * ONLY THE TAP, and only while nothing is armed. The armed path owns the
   * hold-to-pan timer, the corner drag and touch-action, and running two
   * touchend handlers over one gesture would double-fire the tap. This is the
   * narrow case the armed path cannot cover: a screen with no tool on it that
   * still means something by a tap.
   */
  const el = map.getContainer();
  el.addEventListener('touchstart', onBareTouchStart, { capture: true, passive: true });
  el.addEventListener('touchend', onBareTouchEnd, { capture: true, passive: true });

  // One listener, for the life of the map: see watchTileErrors.
  watchTileErrors();
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
      draw_polygon: stepwisePolygonMode(MapboxDraw.modes.draw_polygon),
      /*
       * AND NO WHOLE-SHAPE DRAG OUTSIDE MOVE, WHATEVER MODE DRAW IS IN. The
       * lock above covers our own modes; these cover Draw's, which it enters
       * by itself (simple_select on load, direct_select on a second tap). A
       * press on a shape there used to grab it and stop the map panning, so a
       * pan that started over a shape slid the shape instead. Declined here,
       * the press is the map's and the drag pans.
       */
      simple_select: {
        ...MapboxDraw.modes.simple_select,
        startOnActiveFeature(st, e) {
          if (!moveArmed()) return undefined;
          return MapboxDraw.modes.simple_select.startOnActiveFeature.call(this, st, e);
        },
      },
      direct_select: {
        ...MapboxDraw.modes.direct_select,
        onFeature(st, e) {
          if (!moveArmed()) return this.stopDragging(st);
          return MapboxDraw.modes.direct_select.onFeature.call(this, st, e);
        },
      },
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
    /*
     * A polygon drawn here is one of three things, and which one was decided
     * before the drawing started: the property line, a cut-out, or a patch of
     * lawn. The flags are cleared FIRST in both special cases -- an outline
     * that fails to become a boundary or a hole must not leave the next
     * drawing armed to become one.
     */
    /*
     * Back to where the drawing was started from, when it was started from the
     * corner tools. Without this the loop does not close: you press Patch from
     * inside Points, trace it, and land in no mode at all with the rail
     * collapsed -- having to find your own way back in to carry on correcting.
     */
    /*
     * Deferred, like the lock below: this runs inside Draw's own changeMode,
     * and a changeMode from in here is overwritten by the one still unwinding
     * (it re-enters the polygon mode's onStop, too).
     */
    const wasReturning = state.returnToPoints;
    state.returnToPoints = false;
    const back = () => {
      queueMicrotask(() => {
        if (wasReturning) setMode('shape', 'points');
        // A drawing started from the panel lands on its points, ready to
        // adjust -- not on Pan, the Draw step's resting tool.
        else if (!state.mode && restMode() === 'pan') setMode('shape', 'points');
        else if (!state.mode && restMode()) settleMode();
        /*
         * A CLOSED SHAPE IS A FINISHED SHAPE: blue, and not draggable. Left in
         * simple_select it stayed orange and selected, and the next drag meant
         * as a pan slid the whole patch across the map. Only Move moves.
         */
        else if (state.mode !== 'move') setDrawLock(true);
        refreshHistoryButtons();
      });
    };

    if (state.drawingParcel) {
      state.drawingParcel = false;
      adoptDrawnParcel(e.features?.[0]);
      back();
      return;
    }

    /*
     * UNDO REOPENS IT. The entry recorded for a closed patch or cut-out is the
     * map as it was before the shape existed, plus the corners it was closed
     * with -- so Undo takes the map back AND puts the drawing back open with
     * every corner still placed, and the next Undo takes corners off one at a
     * time. Taken now, before anything below changes the map, with the new
     * shape left out of it.
     */
    const made0 = e.features?.[0];
    const reopen = made0 ? {
      corners: (outerRing(made0) || []).slice(0, -1).map((p) => [...p]),
      hole: Boolean(state.drawingHole),
      returnToPoints: wasReturning,
    } : null;
    const before = snapshot({ without: made0?.id });
    const depth = history.length;
    const recordClose = () => {
      if (!reopen || reopen.corners.length < 3) return;
      if (history.length > depth) history[history.length - 1].reopen = reopen;
      else pushHistory(null, { ...before, reopen });
    };

    if (state.drawingHole) {
      state.drawingHole = false;
      cutHoleFromDrawn(e.features?.[0]);
      recordClose();
      back();
      return;
    }
    /* A NOT-LAWN TRACE leaves Draw at once and joins its own list, so no lawn
       tool ever sees it (tinker mode; see state.notLawn). */
    if ((state.notLawnMode || state.notLawnClosing) && e.features?.[0]) {
      state.notLawnClosing = false;
      const traced = e.features[0];
      try { draw.delete(traced.id); } catch { /* already gone */ }
      pushHistory(); // Undo takes the trace back off
      state.notLawn.push(traced.geometry);
      refreshNotLawn();
      setStatus(`Not-lawn traced (${state.notLawn.length} on this map). It is kept `
        + 'for training only and does not change the total. Its points are editable '
        + 'with Points, like a lawn shape. Press "Trace not-lawn" for another.');
      /* LIKE A NEW SHAPE (owner, 2026-10-01): closed with the checkmark, and
         landing on Points so its corners can be fixed straight away. */
      queueMicrotask(() => setMode('shape', 'points'));
      return;
    }
    // A patch drawn by hand is a hand correction, whether it is the first
    // shape on the map or the tenth on top of a detection.
    markHandEdited();
    /*
     * And if it landed on lawn that was already there, the two become one
     * shape. This is the only tool on the map that adds without removing, so
     * it was the only way to end up with two outlines over the same ground --
     * see mergeDrawnPatch, including what merging does NOT fix.
     */
    /*
     * Marked BEFORE the merge, because the merge decides what a shape may
     * join by asking which layer it is on. Setting the flag afterwards would
     * let a fresh inferred patch fuse into the lawn it was drawn over, which
     * is the normal way somebody would use this.
     */
    const made = e.features?.[0];
    if (state.inferredMode && made) {
      draw.setFeatureProperty(made.id, 'inferred', true);
      made.properties = { ...(made.properties || {}), inferred: true };
      /*
       * A freshly traced outline has no hand-placed corners to lose, so this
       * one is safe to clip whole -- unlike a shape being edited, where the
       * round trip would move every vertex on it. See lib/stitch.js.
       */
      if (state.inferredInside) holdShapeInsideLawn(made);
    }
    const joined = mergeDrawnPatch(made);
    if (joined) {
      refreshMeasurement();
      refreshSurveyed();
      updateSelectionButtons();
      setStatus(`Joined into the ${joined === 1 ? 'patch' : `${joined} patches`} `
        + 'underneath, so the same ground is not outlined twice. The total is '
        + 'unchanged — this tidies the outlines, it does not take anything away.');
    }
    recordClose();
    back();
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
      /*
       * Sized for a fingertip rather than for a mouse.
       *
       * Was 5 / 4 / 8, which reads well on a laptop and is genuinely hard to
       * hit on a phone -- and the thing being aimed at is a corner of somebody's
       * property line, so a near miss moves the wrong point rather than doing
       * nothing. A real corner is now 7, which is 14 across and still smaller
       * than the 16-pixel grab radius, so the dot never promises a target
       * bigger than the one that actually responds.
       */
      'circle-radius': [
        'case',
        ['==', ['get', 'selected'], 1], 10,
        ['==', ['get', 'phantom'], 1], 5.5,
        7,
      ],
      'circle-color': ['case', ['==', ['get', 'selected'], 1], '#ff6f00', '#ffffff'],
      'circle-opacity': ['case', ['==', ['get', 'phantom'], 1], 0.45, 1],
      'circle-stroke-width': ['case', ['==', ['get', 'phantom'], 1], 1.5, 2],
      'circle-stroke-opacity': ['case', ['==', ['get', 'phantom'], 1], 0.55, 1],
      'circle-stroke-color': ['case', ['==', ['get', 'selected'], 1], '#7a3500', '#2f7d32'],
    },
  });

  /*
   * Drag handles: a dot on a stalk, one per corner, offset far enough that a
   * fingertip on it is nowhere near the edges meeting at that corner.
   *
   * WHY THE STALK. A dot floating beside a corner does not say which corner it
   * belongs to, and on a busy outline the nearest one is often not the right
   * one. The leader makes the pairing unambiguous, which is the whole reason
   * this is a handle rather than just a bigger circle.
   *
   * Leader first so the dot covers its end rather than the line crossing the
   * dot, and both after `points` so a handle is never hidden by the corner it
   * is there to reach.
   */
  map.addSource('point-handles', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'point-leaders', type: 'line', source: 'point-handles',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: {
      'line-color': ['case', ['==', ['get', 'selected'], 1], '#ff6f00', '#2f7d32'],
      'line-width': 1.6,
      'line-opacity': 0.75,
    },
  });
  map.addLayer({
    id: 'point-handle-dots', type: 'circle', source: 'point-handles',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': HANDLE_DOT_PX,
      'circle-color': ['case', ['==', ['get', 'selected'], 1], '#ff6f00', '#ffffff'],
      'circle-opacity': 0.92,
      'circle-stroke-width': 2,
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
  /*
   * SHAPES MARKED "INFERRED, NOT SEEN", drawn as their own layer.
   *
   * Mapbox Draw owns how it paints its own features, and replacing its whole
   * style array to key one colour off one property is a lot of surface to
   * disturb for a hatch. This sits underneath instead: the same outlines, in a
   * colour that says "this one is a judgement", refreshed whenever the shapes
   * change.
   *
   * It matters that this is visible while editing rather than only in the
   * saved record. A mark nobody can see is a mark nobody checks, and the whole
   * value of separating inferred from seen is that the separation is right.
   */
  map.addSource('inferred', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'inferred-fill', type: 'fill', source: 'inferred',
    paint: { 'fill-color': '#b388ff', 'fill-opacity': 0.35 },
  });
  map.addLayer({
    id: 'inferred-line', type: 'line', source: 'inferred',
    paint: {
      'line-color': '#7c4dff',
      'line-width': 2,
      /* Dashed, because "I could not see this" is exactly what a dashed
         boundary means to anybody who has read a map. */
      'line-dasharray': [2, 2],
    },
  });

  /* Not-lawn traces (tinker mode): their own colour, never Draw's. */
  map.addSource('not-lawn', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'not-lawn-fill', type: 'fill', source: 'not-lawn',
    paint: { 'fill-color': '#e53935', 'fill-opacity': 0.3 },
  });
  map.addLayer({
    id: 'not-lawn-line', type: 'line', source: 'not-lawn',
    paint: { 'line-color': '#b71c1c', 'line-width': 2 },
  });

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

/*
 * FIND ME WHERE I AM STANDING.
 *
 * The coordinates go to the Worker to be reverse-geocoded rather than
 * straight into the parcel lookup, and that is not a detour. The lookup needs
 * the county NAME to tell "your county is not configured" from "your county
 * is configured and has no record of this parcel" -- getting that wrong is
 * the Gwinnett bug, where a bounding box reaching into the next county sent
 * somebody debugging a server that was never involved. It also means the pin
 * lands on the matched address rather than on the fix, which is the
 * difference between a rooftop and wherever in the garden you happen to be.
 *
 * AND IT ENDS AT THE SAME CONFIRM STEP as a typed address, deliberately. A
 * phone's fix is good to five or ten metres on a good day and much worse
 * indoors, and a suburban lot is about twenty metres wide -- so standing in
 * your own kitchen can put you on the neighbour's parcel. The step that asks
 * "does this look like your property?" is the answer to that, and it already
 * exists.
 */
const LOCATE_TIMEOUT_MS = 12000;
/*
 * Past this, the fix is not about a house. A hundred metres covers a whole
 * street and several parcels, which is what a laptop on wifi typically
 * returns -- worth proceeding with, worth being told about.
 */
const VAGUE_FIX_M = 100;

function locateNote(text) {
  const note = $('#locate-note');
  note.textContent = text;
  note.hidden = !text;
}

async function useMyLocation() {
  const btn = $('#btn-locate');
  if (!navigator.geolocation || !window.isSecureContext) {
    locateNote('This browser will not give out a location. Type the address instead.');
    return;
  }

  btn.disabled = true;
  btn.classList.add('working');
  locateNote('Asking your browser where you are…');

  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: LOCATE_TIMEOUT_MS,
        /*
         * A fix from the last minute is fine and saves waiting for the radio.
         * Anything older risks measuring the last place you stood still,
         * which on a phone is often the last house you were in.
         */
        maximumAge: 60000,
      });
    });

    const { longitude, latitude, accuracy } = pos.coords;
    locateNote('Looking up that spot…');

    const { results } = await api(
      `/api/geocode?lng=${encodeURIComponent(longitude)}&lat=${encodeURIComponent(latitude)}`
    );
    if (!results.length) {
      locateNote('Nothing is mapped at that spot. Try typing the address.');
      return;
    }
    /* One result, always, from a reverse lookup -- so straight to confirm,
       which is where a single forward match goes too. */
    locateNote('');
    choose(results[0]);

    /*
     * THE WARNING BELONGS ON THE SCREEN THAT ACTS ON IT.
     *
     * It was written into the note beside the address field, one line before
     * moving to the confirm step -- which hides that field. The caution was
     * technically displayed and could not be read, which is worse than not
     * showing it: the code looked like it had handled the case.
     *
     * So it sharpens the confirm step's own question instead. That step
     * already asks whether this is your property; a vague fix is precisely
     * the situation where the honest answer might be no.
     */
    if (accuracy > VAGUE_FIX_M) {
      setHint(`Your device placed you to within about ${Math.round(accuracy)} m, `
        + 'which covers several properties — drag the pin onto yours.');
    }
  } catch (err) {
    /*
     * SAY WHICH REFUSAL IT WAS. "Location unavailable" covers a denied
     * permission, a phone with the radio off and a browser that timed out,
     * and those need three different things done about them -- only one of
     * which the app can even hint at.
     */
    const code = err?.code;
    locateNote(
      code === 1
        ? 'Your browser is set to refuse this site your location. You can change '
          + 'that in its site settings, or just type the address.'
        : code === 3
          ? 'Your device took too long to find a position. Try again outdoors, '
            + 'or type the address.'
          : code === 2
            ? 'Your device could not work out where it is. Type the address instead.'
            : `That did not work: ${err?.message || 'unknown error'}`
    );
  } finally {
    btn.disabled = false;
    btn.classList.remove('working');
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
  setHint('Wrong house? Drag the pin, or tap the roof that is yours.');

  map.flyTo({ center: [result.lng, result.lat], zoom: 18.5, duration: 900 });

  if (state.marker) state.marker.remove();
  /*
   * DRAGGABLE, because the pin is a guess and sometimes it is wrong.
   *
   * A phone's fix is good to five or ten metres outdoors and much worse
   * indoors, against a suburban lot about twenty metres wide -- so "use my
   * location" from inside your own kitchen can land on the neighbour's roof.
   * A geocoder makes the same class of mistake on a rural route or a new
   * street, where the number it knows about is two doors down.
   *
   * Both used to mean going back and typing something different, which does
   * not help when the address itself is what the geocoder has wrong. Moving
   * the pin does, and it is the one correction that always works: you can see
   * your own roof.
   */
  state.marker = new mapboxgl.Marker({ color: '#2f7d32', draggable: true })
    .setLngLat([result.lng, result.lat])
    .addTo(map);
  state.marker.on('dragend', () => movePin(state.marker.getLngLat()));
}

/*
 * The pin has been put somewhere on purpose. Find out where that is.
 *
 * THE COORDINATES STAY WHERE THEY WERE PUT, and only the name is looked up --
 * which is the opposite of what "use my location" does, on purpose. There the
 * fix is noisy and the geocoder's rooftop is the better guess, so the pin
 * snaps to it. Here somebody has looked at a photograph of their own house
 * and pointed at it, which beats any guess, and a pin that jumped after being
 * placed would be the app arguing with the person using it.
 *
 * The name is still worth asking for. It is what the status line quotes, what
 * a saved map is called, and -- through the county -- what tells a missing
 * property line from an unconfigured county.
 */
async function movePin(lngLat) {
  const lng = Number(lngLat.lng ?? lngLat[0]);
  const lat = Number(lngLat.lat ?? lngLat[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;

  state.marker?.setLngLat([lng, lat]);
  /*
   * Answer immediately with the coordinates, then improve it -- a label that
   * goes blank while a request is in flight reads as something breaking.
   *
   * THE OLD SPOT'S COUNTY IS DROPPED, NOT CARRIED. Spreading the previous
   * `chosen` kept `county` and `state` from wherever the pin used to be, and
   * a pin dragged three streets over would file its parcel request under the
   * old county's name. That is the Gwinnett bug with the two sides swapped:
   * the lookup answers "that county has no record of this parcel" when the
   * truth is that the wrong county was asked. Nothing is the honest value
   * here -- servesCounty already falls back to the box when it has no name.
   */
  state.chosen = { lng, lat, label: state.chosen?.label || '' };
  $('#chosen-label').textContent = 'Looking up that spot…';

  /* Each move is its own request, and they can come back out of order -- a
     slow one landing after a fast one would label the new pin with the old
     spot. Only the latest move gets to write. */
  const token = Symbol('move');
  state.pinMove = token;

  try {
    const { results } = await api(
      `/api/geocode?lng=${encodeURIComponent(lng)}&lat=${encodeURIComponent(lat)}`
    );
    if (state.pinMove !== token) return;
    const found = results[0];
    state.chosen = {
      ...(found || {}),
      /* Theirs, not the geocoder's. See above. */
      lng,
      lat,
      label: found?.label || 'The spot you picked',
    };
  } catch {
    if (state.pinMove !== token) return;
    /*
     * A failed lookup is not a failed placement. The point is the thing the
     * measurement needs; the address is a caption. Saying so beats an error
     * over a pin that is sitting exactly where it should be.
     *
     * With no county name, for the reason above: a lookup that failed knows
     * nothing about where this is, and inheriting the last answer would be
     * the app making one up.
     */
    state.chosen = { lng, lat, label: 'The spot you picked' };
  }
  $('#chosen-label').textContent = state.chosen.label;
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
    /*
     * The county and state come back from the geocoder and go straight back
     * out again, so a lookup that finds no boundary can be filed under a place
     * name. Without them the console's list of unserved counties would be one
     * enormous "unknown" row -- the coordinates alone cannot be read as a
     * place by anybody deciding which county to add next.
     *
     * The client id is the one the allowance already uses, and it is here to
     * separate "fifty people asked" from "one person asked fifty times" --
     * opposite findings that a hit count alone cannot tell apart.
     */
    const where = new URLSearchParams({ lng, lat });
    if (state.chosen.county) where.set('county', state.chosen.county);
    if (state.chosen.state) where.set('state', state.chosen.state);
    if (state.clientId) where.set('clientId', state.clientId);
    const data = await api(`/api/parcel?${where}`);
    state.parcel = data.parcel || null;

    if (state.parcel) {
      /*
       * TIDIED ON ARRIVAL, NOT ON REQUEST.
       *
       * A county boundary is digitised rather than drawn and arrives with runs
       * of points centimetres apart -- 62 corners on the parcel this was built
       * against, one pair 10 cm from each other. "Tidy up this boundary" has
       * always been able to drop them; it was a button somebody had to know to
       * press, and nobody pressing it is the ordinary case.
       *
       * The cost of leaving them is not cosmetic. Corners and edges compete for
       * the same pixels, and at that density the corner always wins -- so
       * tapping the middle of the longest edge on the parcel, as far from both
       * its corners as the geometry allows, still selects a corner. Dragging an
       * edge out to the kerb is the main thing property-line mode is FOR, and
       * it was unreachable on exactly the boundaries that need it most.
       *
       * Safe to do unasked because tidyRing is not shape-simplification: it
       * only ever removes a point lying within 10 cm of the straight line
       * between its neighbours, so every corner carrying any shape survives and
       * the area moves by a fraction of a percent -- comfortably inside the
       * accuracy of the survey it came from. See tidyRing in lib/edges.js.
       *
       * Before state.surveyed is taken, so the record of which corners came
       * from the county describes the ones that are actually still there.
       */
      let tidiedAway = 0;
      const raw = parcelRing();
      if (raw) {
        const tidied = tidyRing(raw);
        if (tidied.removed) {
          setParcelRingQuietly(tidied.ring);
          tidiedAway = tidied.removed;
        }
      }

      map.getSource('parcel').setData(state.parcel);
      const bbox = geometryBounds(state.parcel);
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 60, duration: 800 });
      /*
       * THE PARCEL'S BOX PLUS A MARGIN, CROPPED BOTH WAYS. This was a square
       * around the longer side, so a long thin lot was photographed with the
       * neighbours on both sides of its short one -- and every detector read
       * them, paid for them, and drew on them. See frameFor in lib/mercator.js (parcelFrame here).
       */
      state.frame = parcelFrame(bbox, FRAME_SIZE, { marginM: FRAME_MARGIN_M });
      // Remember the county's own corners so the map can show which parts of
      // the final outline are still survey-accurate.
      state.surveyed = (parcelRing() || []).map((p) => [...p]);
      $('#btn-parcel-shape').hidden = false;
      $('#btn-draw-parcel').hidden = true;

      const a = measure(state.parcel.geometry);
      // Names the next STEP rather than the next button, because the button is
      // on a tab you are not looking at -- "press Detect" with no Detect on
      // screen reads as the app having lost it.
      /*
       * Said, not done quietly. Changing somebody's boundary without telling
       * them is the thing the tidy button was careful not to do, and doing it
       * automatically is not a licence to stop saying so -- it is the reason
       * to keep saying it, since now nobody asked.
       */
      const tidyNote = tidiedAway
        ? ` Dropped ${tidiedAway} duplicate corner${tidiedAway === 1 ? '' : 's'} ` +
          'the county had stacked on top of each other — the line is unchanged.'
        : '';
      setStatus(
        `Found your property line — ${a.acres} acres total ` +
        `(${state.parcel.properties.county}).${tidyNote} Check it, then open AI ` +
        'to detect your lawn — or Draw to trace it yourself.'
      );
      /*
       * Neighbours, merge, and the line out to the road: for everybody since
       * 2026-09-30 (the owner, after trying them in tinker mode). Not on the
       * paid tracing queue, where the lot is the job's to set, not the
       * tracer's to grow.
       */
      clearNeighbours();
      if (!document.body.classList.contains('job-mode')) aroundParcel();
    } else {
      clearNeighbours();
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
      ? (document.body.classList.contains('job-mode')
        ? 'Check the property line, then open the Draw step'
        : 'Check the property line, then open the AI or Draw step')
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
 * How hard to smooth a BRUSH EDIT, as against a detection.
 *
 * A detection arrives as a noisy mask and wants real smoothing. A brush edit
 * arrives as a polygon somebody already corrected, and the only new boundary
 * in it is the few metres under the stroke -- so smoothing is nearly all
 * damage. About one pixel of the grid, and a cap high enough that corners are
 * never dropped to fit it: what survives here is put back on its original
 * line by restoreAway, and a corner deleted by the cap cannot be.
 */
const BRUSH_TRACE_PX = 1.2;
const MAX_BRUSH_VERTICES = 400;

/*
 * What a hand edit is allowed to throw away: see editTraceLimits in lib/mask.js,
 * which is where the reasoning and the arithmetic live. Short version: nearly
 * nothing, because every pixel a brush changed was changed on purpose.
 */
const EDIT_TRACE_LIMITS = editTraceLimits(ERASE_GRID, ERASE_GRID);

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
  /*
   * The brush sees only the layer being drawn on. In inferred mode an add
   * stroke over existing lawn makes a new inferred patch rather than growing
   * the lawn underneath, and an erase stroke takes back inferred ground
   * without touching what is visible beneath it.
   */
  const everything = draw.getAll().features;
  const features = everything
    .filter((f) => outerRing(f) && isInferred(f) === state.inferredMode);
  /*
   * AND EVERYTHING THIS STROKE IS NOT ALLOWED TO TOUCH, held so it can be put
   * back. This ends in draw.deleteAll(), which does exactly what it says: the
   * shapes that go back afterwards are the ones named here and in `untouched`,
   * and anything left out of both is simply gone.
   *
   * That is how the first inferred stroke on a finished map deleted the map.
   * The filter above was added so a stroke works on one layer; the rebuild
   * below was written when there was only one layer to rebuild. Each was right
   * and together they threw the lawn away and left the total reading only the
   * patch that had just been drawn.
   */
  const spared = everything.filter((f) => !features.includes(f));
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
  let limit = (mode.paint && !state.measureOutside)
    ? parcelRaster(ERASE_GRID, ERASE_GRID, project)
    : null;

  /*
   * AND, ON THE INFERRED LAYER, THE LAWN ITSELF.
   *
   * Narrowed rather than replaced: an inferred patch held inside a lawn that
   * itself runs past the property line would still be past the property line.
   * Both limits or neither, and the tighter one wins pixel by pixel.
   *
   * Only while painting. An erase stroke that could not reach past the lawn
   * would be unable to take back a patch drawn before the toggle was on, and
   * this setting is not supposed to reach backwards.
   */
  if (mode.paint && state.inferredMode && state.inferredInside) {
    const rings = seenLawnRings();
    if (rings.length) {
      const lawn = new Uint8Array(ERASE_GRID * ERASE_GRID);
      for (const ring of rings) {
        const m = rasterizePolygon([ring], ERASE_GRID, ERASE_GRID, project);
        for (let i = 0; i < m.length; i++) if (m[i]) lawn[i] = 1;
      }
      if (limit) for (let i = 0; i < lawn.length; i++) lawn[i] = lawn[i] && limit[i] ? 1 : 0;
      limit = lawn;
    }
  }

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

  const mPerPx = metresPerPixel(frame, ERASE_GRID);
  const touchedShapes = candidates.filter((f) => touched.includes(f));

  /*
   * THE STROKE AS A SHAPE, CLIPPED AGAINST THE OUTLINES (lib/brush-vector.js).
   * Only the stroke goes through the tracer; the shapes are cut or joined as
   * outlines, so every corner the brush did not cover comes back exactly --
   * which the pixel round trip below could not promise, and on small shapes
   * visibly did not. The round trip stays as the fallback if clipping fails.
   */
  const strokeData = new Uint8ClampedArray(ERASE_GRID * ERASE_GRID * 4);
  for (let p = 0; p < strokeMask.length; p++) {
    const v = strokeMask[p] ? 255 : 0;
    strokeData[p * 4] = strokeData[p * 4 + 1] = strokeData[p * 4 + 2] = v;
    strokeData[p * 4 + 3] = 255;
  }
  const strokePolys = maskToPolygons(
    { width: ERASE_GRID, height: ERASE_GRID, data: strokeData },
    (x, y) => framePxToLngLat(frame, [x, y], ERASE_GRID, ERASE_GRID),
    { tolerance: BRUSH_TRACE_PX, maxVertices: MAX_BRUSH_VERTICES, ...EDIT_TRACE_LIMITS }
  ).map((g) => g.coordinates);
  const clipped = strokeOnShapes(
    touchedShapes.map((f) => f.geometry.coordinates),
    strokePolys,
    { paint: Boolean(mode.paint), clip: window.polygonClipping, minAreaM2: mPerPx * mPerPx * 4, minWidthM: mPerPx * 1.5 }
  );
  if (clipped) {
    pushHistory();
    draw.deleteAll();
    for (const f of afterStroke(spared, untouched, clipped, {
      inferred: state.inferredMode,
    })) draw.add(f);
    refreshMeasurement();
    refreshSurveyed();
    updateSelectionButtons();
    const n = clipped.length + untouched.length;
    const secs = `${n} section${n > 1 ? 's' : ''}`;
    setStatus(mode.paint
      ? `Added. ${secs} of lawn.`
      : n ? `Erased. ${secs} left.` : 'Erased everything. Undo, or detect again.');
    return;
  }

  // Back through the tracer, which owns simplification and hole handling.
  const data = new Uint8ClampedArray(ERASE_GRID * ERASE_GRID * 4);
  for (let p = 0; p < keep.length; p++) {
    const v = keep[p] ? 255 : 0;
    data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v;
    data[p * 4 + 3] = 255;
  }

  /*
   * TRACED FOR AN EDIT, NOT FOR A DETECTION.
   *
   * TRACE_TOLERANCE_M and MAX_TRACE_VERTICES exist to turn a noisy model mask
   * into a clean outline: two and a half feet of smoothing and a cap of thirty
   * corners. Right for a mask, ruinous here. What goes into this round trip is
   * a polygon somebody already corrected, and re-simplifying it moves every
   * edge on the whole shape while the cap deletes corners metres from the
   * brush that were placed on purpose. That is the "edges creep in across the
   * whole shape" report, and it is why sparing untouched SHAPES did not fix
   * it -- the damage was inside the shape the brush legitimately touched.
   *
   * So the edit path smooths by about a pixel and keeps as many corners as the
   * result needs. There is no noise to remove: the staircase this leaves along
   * the untouched edges is put back on its original line below.
   */
  const polygons = maskToPolygons(
    { width: ERASE_GRID, height: ERASE_GRID, data },
    (x, y) => framePxToLngLat(frame, [x, y], ERASE_GRID, ERASE_GRID),
    {
      tolerance: BRUSH_TRACE_PX,
      maxVertices: MAX_BRUSH_VERTICES,
      ...EDIT_TRACE_LIMITS,
    }
  );

  /*
   * ...and then the parts the brush could not have reached go back exactly
   * onto the outline they came from. See lib/stitch.js. The reach is the brush
   * radius plus a pixel of margin, so a vertex spared here is one the stroke
   * provably did not touch.
   */
  const originals = candidates
    .filter((f) => touched.includes(f))
    .flatMap((f) => f.geometry.coordinates);
  const reachM = brushMetres + mPerPx * 2;
  const restored = polygons.map((geometry) => ({
    ...geometry,
    coordinates: restoreAway(geometry.coordinates, {
      originals,
      stroke,
      reachM,
      snapM: mPerPx * 2.5,
    }),
  }));

  pushHistory();
  draw.deleteAll();
  /*
   * Everything that should exist afterwards, assembled in one place. See
   * afterStroke in lib/stitch.js: the list it builds is the whole of what
   * survives, and the bug it is named for was a shape left out of it.
   */
  for (const f of afterStroke(spared, untouched, restored, {
    inferred: state.inferredMode,
  })) draw.add(f);

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
  const all = draw.getAll().features.filter((f) => outerRing(f));
  if (!all.length || !parcelRing()) return { trimmed: 0, before: 0, after: 0 };

  /*
   * ONE LAYER AT A TIME, and that is not tidiness.
   *
   * The clip works by rasterising every shape into one grid and tracing back
   * what survives. Run over both kinds at once it would hand back a single
   * merged outline -- so an inferred patch lying over visible lawn, which is
   * the ordinary case, would come out of a boundary trim as one shape that is
   * either wholly inferred or wholly seen. Either answer is a lie, and it
   * would be told silently by a tool nobody suspects of touching the marks.
   */
  const before = totalSquareFeet();
  const groups = [
    all.filter((f) => !isInferred(f)),
    all.filter((f) => isInferred(f)),
  ];

  const rebuilt = [];
  let clipped = false;
  for (const [i, features] of groups.entries()) {
    if (!features.length) continue;
    const out = clipGroupToParcel(features, i === 1);
    if (!out) { rebuilt.push(...features); continue; }
    clipped = true;
    rebuilt.push(...out);
  }
  if (!clipped) return { trimmed: 0, before, after: before };

  pushHistory();
  draw.deleteAll();
  for (const f of rebuilt) draw.add(f);

  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();

  const after = totalSquareFeet();
  return { trimmed: Math.max(0, before - after), before, after };
}

/**
 * One kind of shape, trimmed to the property line.
 *
 * Returns the replacement features, or null when this group has nothing
 * crossing the line and should be left exactly as it is -- which is not an
 * optimisation but the point: see the round-trip warning below.
 */
function clipGroupToParcel(features, inferred) {
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
  if (!inside) return null;

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
  let crossing = 0;
  for (const f of features) {
    const m = rasterizePolygon(f.geometry.coordinates, ERASE_GRID, ERASE_GRID, project);
    let outside = 0;
    for (let i = 0; i < m.length; i++) if (m[i] && !inside[i]) { outside = 1; break; }
    if (!outside) { untouched.push(f); continue; }
    crossing++;
    for (let i = 0; i < keep.length; i++) if (m[i] && inside[i]) keep[i] = 1;
  }
  if (!crossing) return null;

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
      /*
       * Clipping must not also tidy: a hole somebody cut by hand inside the
       * property line has nothing to do with the boundary and must survive
       * being trimmed to it.
       *
       * The HOLE floor only. A clip cuts along the boundary, which is exactly
       * where the grid leaves slivers, so the piece floor stays at the
       * tracer's own default here -- those fragments are the artefact it is
       * there for, and it reports what it dropped.
       */
      ...editHoleLimit(ERASE_GRID, ERASE_GRID),
    }
  );

  const props = () => (inferred ? { inferred: true } : {});
  return [
    ...untouched,
    ...polygons.map((geometry) => ({ type: 'Feature', properties: props(), geometry })),
  ];
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

function snapshot({ without = null } = {}) {
  return {
    features: JSON.parse(JSON.stringify(
      draw.getAll().features.filter((f) => without == null || f.id !== without))),
    parcel: state.parcel ? JSON.parse(JSON.stringify(state.parcel.geometry)) : null,
    // Placing pins is work too. Undo that skipped them would quietly make
    // "remove all pins" the only way back from one stray tap.
    pins: state.pins.map((p) => [...p]),
    // Not-lawn traces are edited with the same tools, so Undo has to cover them.
    notLawn: JSON.parse(JSON.stringify(state.notLawn)),
  };
}

/**
 * Record the state as it is now, before the caller changes it.
 *
 * Call this once per *interaction*, not once per change: a slider drag fires
 * a hundred times and is one thing the user did. `key` collapses a run of
 * changes into a single entry -- passing the same key again while that
 * interaction is still current adds nothing.
 *
 * Anything new done to the map ends the redo trail: redoing past a change
 * made since would silently throw that change away.
 */
let historyKey = null;
let future = [];
function pushHistory(key = null, entry = null) {
  if (key !== null && key === historyKey) return;
  historyKey = key;
  history.push(entry || snapshot());
  if (history.length > MAX_HISTORY) history.shift();
  future = [];
  refreshHistoryButtons();
}

/** End the current interaction, so the next one starts a new undo entry. */
const endHistoryGroup = () => { historyKey = null; };

function clearHistory() {
  history = [];
  future = [];
  historyKey = null;
  refreshHistoryButtons();
}

/*
 * THE DRAWING IN PROGRESS, corner by corner.
 *
 * Draw's own polygon mode knows one undo -- Delete, which throws the whole
 * outline away -- and closing it left the shape selected, orange, and
 * draggable by the next pan. This wraps it so that:
 *   - Undo while drawing takes the last corner off, Redo puts it back;
 *   - closing lands in the locked mode, so the shape is finished (blue) and
 *     only Move can move it;
 *   - it can be reopened with corners already placed (Undo after a close).
 * `drafting` is the live one, for the Undo and Redo buttons to reach.
 */
let drafting = null;

/** Whole shapes move only in Move mode (see the Draw modes in initMap). */
const moveArmed = () => state.mode === 'move';

function stepwisePolygonMode(base) {
  const close = (mode) => mode.changeMode(LOCKED_MODE);
  return {
    ...base,
    onSetup(opts = {}) {
      const st = base.onSetup.call(this, opts);
      const corners = Array.isArray(opts.corners) ? opts.corners : [];
      corners.forEach((p, i) => st.polygon.updateCoordinate(`0.${i}`, p[0], p[1]));
      if (corners.length) {
        st.currentVertexPosition = corners.length;
        const last = corners[corners.length - 1];
        st.polygon.updateCoordinate(`0.${corners.length}`, last[0], last[1]);
      }
      st.undone = [];
      drafting = { mode: this, state: st };
      queueMicrotask(refreshHistoryButtons);
      return st;
    },
    clickAnywhere(st, e) {
      if (precisePlacing()) return placePoint(this, base, st, e);
      const pos = st.currentVertexPosition;
      const last = pos > 0 ? st.polygon.coordinates[0][pos - 1] : null;
      if (last && last[0] === e.lngLat.lng && last[1] === e.lngLat.lat) return close(this);
      // A new corner: whatever was undone is gone for good, as with any edit.
      st.undone = [];
      future = [];
      base.clickAnywhere.call(this, st, e);
      refreshHistoryButtons();
      return undefined;
    },
    /* New shape and Cut out finish with the checkmark only: a tap on or near
       a placed point is another point (placePoint), not "done". */
    clickOnVertex(st, e) {
      if (precisePlacing()) return placePoint(this, base, st, e);
      return close(this);
    },
    onKeyUp(st, e) {
      if (e.keyCode === 13) return close(this);
      if (e.keyCode === 27) {
        this.deleteFeature([st.polygon.id], { silent: true });
        queueMicrotask(settleMode); // once the polygon mode has let go
        return this.changeMode(LOCKED_MODE);
      }
      return undefined;
    },
    onStop(st) {
      if (drafting?.state === st) drafting = null;
      base.onStop.call(this, st);
      queueMicrotask(refreshHistoryButtons);
      // However the drawing ended -- closed, abandoned, too few points to be a
      // shape -- the step's own tool comes back (restMode). A close has
      // usually done this already through draw.create.
      queueMicrotask(() => { if (!state.mode && restMode()) settleMode(); });
    },
    // Delete / Backspace while drawing: the last corner, not the whole outline.
    onTrash(st) { draftUndo(); },
  };
}

const draftCorners = () => (drafting ? drafting.state.currentVertexPosition : 0);

/*
 * NEW SHAPE AND CUT OUT PLACE POINTS UNTIL THE CHECKMARK (owner, 2026-09-30).
 *
 * Tapping the first point used to close the shape, and tapping near ANY
 * point hit Draw's vertex and closed it too -- so a careful run of points
 * along a fence ended itself halfway. Now every tap is a point, snapped
 * (lib/snap.js), except one squarely on a point already placed, which would
 * only make a zero-length edge. Tracing a property line and not-lawn keep
 * the old first-point close; nobody asked for those to change.
 */
const precisePlacing = () => Boolean(drafting) && !state.drawingParcel;
const ON_A_POINT_PX = 4;

/** The rings a point placed now may snap to, and what counts as inside. */
function snapTargets() {
  const proj = (ll) => { const q = map.project(ll); return [q.x, q.y]; };
  const polys = (g) => (g?.type === 'Polygon' ? [g.coordinates]
    : g?.type === 'MultiPolygon' ? g.coordinates : []);
  const rings = [];
  const areas = [];
  const add = (poly) => {
    const px = poly.map((r) => r.map(proj));
    rings.push(...px);
    areas.push({ outer: px[0], holes: px.slice(1) });
  };
  if (state.notLawnMode) {
    /* A not-lawn trace snaps onto a lawn edge it comes near -- the road ends
       where the lawn starts -- but nothing holds it in: a road, a pond, a car
       park can be anywhere, so the whole map counts as inside. */
    const own = drafting?.state.polygon.id;
    for (const f of draw.getAll().features) {
      if (f.id !== own) polys(f.geometry).forEach((poly) => rings.push(...poly.map((r) => r.map(proj))));
    }
    const far = 1e7;
    areas.push({ outer: [[-far, -far], [far, -far], [far, far], [-far, far], [-far, -far]], holes: [] });
  } else if (state.drawingHole) {
    // The lawn as it is, not the outline being drawn.
    const own = drafting?.state.polygon.id;
    for (const f of draw.getAll().features) if (f.id !== own) polys(f.geometry).forEach(add);
  } else if (!state.measureOutside && state.parcel?.geometry) {
    polys(state.parcel.geometry).forEach(add);
  }
  return { rings, areas };
}

function placePoint(mode, base, st, e) {
  const placed = st.polygon.coordinates[0].slice(0, st.currentVertexPosition)
    .map((p) => map.project(p));
  const near = (q, tol) => placed.some((v) => Math.hypot(v.x - q.x, v.y - q.y) <= tol);
  if (near(map.project(e.lngLat), ON_A_POINT_PX)) return undefined;
  const q = map.project(e.lngLat);
  const { point } = snapPoint([q.x, q.y], snapTargets());
  // Snapping two taps to the same corner must not stack two points on it
  // (Draw would also read that as "close").
  if (near({ x: point[0], y: point[1] }, 1)) return undefined;
  const at = map.unproject(point);
  st.undone = [];
  future = [];
  base.clickAnywhere.call(mode, st, { ...e, lngLat: { lng: at.lng, lat: at.lat } });
  refreshHistoryButtons();
  return undefined;
}

/** Take the last corner off the open drawing. */
function draftUndo() {
  const d = drafting;
  if (!d) return false;
  const st = d.state;
  const pos = st.currentVertexPosition;
  if (pos === 0) return false;
  const ring = st.polygon.coordinates[0];
  st.undone.push([...ring[pos - 1]]);
  st.polygon.removeCoordinate(`0.${pos - 1}`);
  st.currentVertexPosition = pos - 1;
  d.mode._ctx.store.render();
  refreshHistoryButtons();
  setStatus(st.currentVertexPosition
    ? `Corner removed — ${st.currentVertexPosition} left.`
    : 'All corners removed. Tap to start again, or Undo once more to stop drawing.');
  return true;
}

/** Put the last corner taken off back on. */
function draftRedo() {
  const d = drafting;
  if (!d || !d.state.undone.length) return false;
  const st = d.state;
  const p = st.undone.pop();
  const pos = st.currentVertexPosition;
  st.polygon.updateCoordinate(`0.${pos}`, p[0], p[1]);
  st.currentVertexPosition = pos + 1;
  st.polygon.updateCoordinate(`0.${pos + 1}`, p[0], p[1]);
  d.mode._ctx.store.render();
  refreshHistoryButtons();
  setStatus('Corner put back.');
  return true;
}

/** Abandon the open drawing without it becoming a shape. */
function draftCancel() {
  const d = drafting;
  if (!d) return;
  d.mode.deleteFeature([d.state.polygon.id], { silent: true });
  drafting = null;
  state.drawingHole = false;
  state.drawingParcel = false;
  state.returnToPoints = false;
  setDrawLock(true);
  setHint('');
  settleMode(); // back to the step's own tool, now the drawing is gone
}

/** Put the map back to a recorded state. */
function restore(prev) {
  draw.deleteAll();
  for (const f of prev.features) draw.add(f);

  // Restoring the parcel has to go through setParcelRing: extending a boundary
  // widened the photograph's frame, so undoing it has to narrow it back or the
  // next detection would still be framed for a boundary that no longer exists.
  /*
   * ONLY WHEN THE LINE ACTUALLY DIFFERS. Every undo entry carries the parcel,
   * so this re-set it on every Undo -- and setParcelRing re-frames, which
   * re-fetches a Google or NAIP photograph: with one showing, each Undo of a
   * brush stroke looked like the map reloading (owner, 2026-10-01).
   */
  if (prev.parcel && state.parcel) {
    const ring = prev.parcel.type === 'Polygon'
      ? prev.parcel.coordinates[0]
      : prev.parcel.coordinates[0][0];
    if (JSON.stringify(ring) !== JSON.stringify(parcelRing())) setParcelRing(ring);
  }

  if (state.edgeEdit) {
    state.edgeEdit = { ringId: null, edgeIndex: null, vertexIndex: null, baseRing: null };
    $('#edge-controls').hidden = true;
    $('#point-controls').hidden = true;
    clearEdgeHighlight();
  }

  state.pins = (prev.pins || []).map((p) => [...p]);
  if (Array.isArray(prev.notLawn)) {
    state.notLawn = JSON.parse(JSON.stringify(prev.notLawn));
    refreshNotLawn();
  }
  refreshPins();

  drawPoints();
  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  // A merge undone brings its neighbour's button back.
  if (neighbourState.all.length) refreshNeighbours();
}

/** Open a closed patch or cut-out again, every corner in place. */
function reopenDrawing(reopen) {
  setMode(null);
  state.drawingHole = reopen.hole;
  state.drawingParcel = false;
  state.returnToPoints = reopen.returnToPoints;
  draw.changeMode('draw_polygon', { corners: reopen.corners });
  setHint('Drawing again. Undo takes points off; press the ✓ to finish.');
}

function undo() {
  // While drawing, Undo is about corners.
  if (drafting) {
    if (draftUndo()) return;
    // No corners left: stop drawing, and that is this press.
    draftCancel();
    refreshHistoryButtons();
    setStatus('Stopped drawing.');
    return;
  }

  const prev = history.pop();
  if (!prev) return;
  historyKey = null;
  future.push({ ...snapshot(), reopen: prev.reopen || null });
  restore(prev);
  if (prev.reopen) {
    reopenDrawing(prev.reopen);
    setStatus('Reopened — the shape is back to its corners. Undo again to take them off one at a time.');
  } else {
    setStatus(history.length
      ? 'Undone.'
      : 'Undone — back to where this step started.');
  }
  refreshHistoryButtons();
}

function redo() {
  if (drafting) {
    if (draftRedo()) return;
    // Every corner is back: Redo closes it again, as it was.
    if (!future.length || !future[future.length - 1].reopen) return;
    draftCancel();
  }
  const next = future.pop();
  if (!next) return;
  historyKey = null;
  history.push({ ...snapshot(), reopen: next.reopen || null });
  if (history.length > MAX_HISTORY) history.shift();
  restore(next);
  setStatus('Redone.');
  refreshHistoryButtons();
}

function refreshHistoryButtons() {
  // Two of each, one state: the panel's and the one on the map. Undo is
  // pressed while looking at whatever went wrong, which is on the map.
  const canUndo = history.length > 0 || Boolean(drafting);
  const canRedo = future.length > 0 || Boolean(drafting?.state.undone.length);
  for (const id of ['#btn-undo', '#rail-undo']) {
    const btn = $(id);
    if (btn) btn.disabled = !canUndo;
  }
  for (const id of ['#btn-redo', '#rail-redo']) {
    const btn = $(id);
    if (btn) btn.disabled = !canRedo;
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
  /*
   * TELL THE BROWSER UP FRONT, as well as per event.
   *
   * preventDefault on touchmove stops a scroll only if the browser has not
   * already committed to one, and it commits on the first move -- so a single
   * unclaimed event loses the whole gesture. touch-action says "this element
   * never scrolls" before any finger lands, which removes the race rather than
   * winning it.
   *
   * It does not disable Mapbox's pan or pinch: those are driven in JavaScript
   * from touch events, not by the browser's own scrolling. Only the page
   * scrolling under the map goes away, which is what is wanted while a tool is
   * armed and never wanted while one is.
   */
  map.getContainer().style.touchAction = 'none';
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
  // Put the page's own scrolling back: with no tool armed, a drag on the map
  // is the map's, and a flick that runs off it should scroll the panel as it
  // would anywhere else.
  map.getContainer().style.touchAction = '';
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
const PAN_HOLD_MS = HOLD_MS;
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

  /*
   * A HANDLE WINS, and before anything else is considered.
   *
   * It is the only thing on screen placed specifically so that nothing else is
   * near it, so a tap inside one cannot reasonably have been meant for an edge
   * or a neighbouring corner. Checking corners first would let a corner that
   * happens to sit under somebody else's handle steal the tap.
   */
  const viaHandle = handleAt(at.x, at.y);
  if (viaHandle) {
    return {
      ringId: viaHandle.ringId,
      ring: ringOf(viaHandle.ringId) || viaHandle.ring,
      index: viaHandle.index,
      d: viaHandle.d,
    };
  }

  // Only corners that are actually drawn can be grabbed. Grabbing an invisible
  // one would be indistinguishable from the map moving on its own.
  let found = null;
  for (const { ringId, ring } of handleRings()) {
    openRing(ring).forEach((p, i) => {
      const px = map.project(p);
      const d = Math.hypot(px.x - at.x, px.y - at.y);
      if (d <= VERTEX_GRAB_PX && (!found || d < found.d)) {
        found = { ringId, ring, index: i, d };
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
  /*
   * No dragging with the eraser armed. Otherwise a tap that wandered a few
   * pixels would move the corner it was pointed at instead of removing it,
   * and the two outcomes are not recoverable from one another by eye.
   */
  if (state.pointEraser) return false;

  const hit = vertexAt(clientX, clientY);
  if (!hit) return false;

  /*
   * THE CORNER KEEPS ITS DISTANCE FROM THE FINGER.
   *
   * Without this the corner jumps to wherever the touch landed, which is the
   * whole point of a handle undone: the handle exists so the fingertip is
   * somewhere other than the corner, and teleporting the corner under the
   * finger puts it straight back where it cannot be seen.
   *
   * Recorded as a screen-space offset at grab time and held for the life of
   * the drag. It also removes a small jump when a corner is grabbed directly:
   * a tap fifteen pixels off used to snap the corner fifteen pixels before
   * moving it anywhere.
   */
  const rect = map.getCanvasContainer().getBoundingClientRect();
  const corner = map.project(openRing(hit.ring)[hit.index]);
  drag = {
    ...hit,
    startX: clientX,
    startY: clientY,
    moved: false,
    offsetX: corner.x - (clientX - rect.left),
    offsetY: corner.y - (clientY - rect.top),
  };
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
    selectVertex({ ringId: drag.ringId, ring: drag.ring, index: drag.index });
    holdMapStill();
  }

  const rect = map.getCanvasContainer().getBoundingClientRect();
  const lngLat = map.unproject([
    clientX - rect.left + (drag.offsetX || 0),
    clientY - rect.top + (drag.offsetY || 0),
  ]);
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
  if (e.button !== 0 || onMarker(e)) return;
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

/**
 * Has the pointer travelled far enough that this is a stroke, not a hold?
 *
 * HOLD_SLOP_PX, not TAP_SLOP_PX. They were the same number, and they answer
 * different questions -- see lib/gesture.js. Using the tap's generous 14px
 * here meant a careful stroke stayed "still" for the whole half second, so the
 * hold matured, discardStroke() threw away what was being painted, and the map
 * began moving under the finger. Reported as "I can't draw without the map
 * moving around on mobile".
 */
function movedEnoughToCancelHold(x, y) {
  return Boolean(panHold) && !panHold.active
    && gestureMoved({ x: panHold.x, y: panHold.y }, { x, y });
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

  /*
   * CLAIMED BY WHAT IS UNDER THE FINGER, NOT BY WHAT HAS HAPPENED YET.
   *
   * This used to claim only when updateDrag reported a visible change, which
   * meant the first events of a corner drag -- the ones before the 4px
   * threshold -- went to the map, and it panned a little before the drag took
   * hold. The visible jump was the smaller half of the problem: a browser
   * decides whether a touch is a scroll on the FIRST move it sees, and once it
   * has decided, every later preventDefault is ignored for the rest of that
   * gesture. Letting the first event through does not cost a few pixels, it
   * costs the whole stroke.
   */
  const ours = gestureIsOurs({
    touches: 1,
    painting: Boolean(eraser?.painting),
    grabbed: Boolean(drag),
  });
  const changed = updateDrag(t.clientX, t.clientY);
  if (ours || changed) claim(e);
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
let handled = { at: 0, x: null, y: null, touch: false };

// TAP_SLOP_PX and TAP_MAX_MS live in lib/gesture.js beside the hold slop they
// were once confused with; isTap() is the only reader either needs.
const ECHO_MS = 700;       // a synthetic click follows its touch closely
const ECHO_SLOP_PX = 30;   // ...and lands on the same spot

/*
 * A TAP ON A SCREEN WITH NO TOOL ARMED.
 *
 * The armed path (onTouchStart/onTouchEnd) owns the hold-to-pan timer, the
 * corner drag and touch-action, all of which belong to a drawing tool. This
 * pair owns nothing: it watches for a tap and hands it to handleMapPoint,
 * which decides for itself whether anything wanted one.
 *
 * It stands down entirely while the picker is armed, because the armed
 * listeners are capturing the same gesture and two handlers over one touchend
 * would move the pin twice.
 */
let bareTouch = null;

function onBareTouchStart(e) {
  if (onMarker(e)) { bareTouch = null; touchStart = null; return; }
  if (diag.armed || e.touches.length !== 1) { bareTouch = null; return; }
  bareTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() };
}

function onBareTouchEnd(e) {
  const start = bareTouch;
  bareTouch = null;
  if (diag.armed || !start) return;

  const t = e.changedTouches && e.changedTouches[0];
  if (!t) return;
  /* The same definition of "that was a tap" the armed path uses, from
     lib/gesture.js -- two answers to that question is one too many. */
  if (!isTap(start, { x: t.clientX, y: t.clientY }, Date.now())) return;

  const point = map.unproject([
    t.clientX - map.getContainer().getBoundingClientRect().left,
    t.clientY - map.getContainer().getBoundingClientRect().top,
  ]);
  diag.viaTouch++;
  handleMapPoint(point, t.clientX, t.clientY, true);
}

function onTouchStart(e) {
  if (onMarker(e)) { touchStart = null; return; }
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
  // One definition of "that was a tap", shared with the rules it belongs
  // beside -- the hold slop and the tap slop drifting apart is the bug.
  if (!isTap(start, { x: t.clientX, y: t.clientY }, Date.now())) return;

  const rect = map.getCanvasContainer().getBoundingClientRect();
  const lngLat = map.unproject([t.clientX - rect.left, t.clientY - rect.top]);
  diag.viaTouch++;
  handleMapPoint(lngLat, t.clientX, t.clientY, true);
}

function onMapClick(e) {
  const src = e.originalEvent || {};
  // A click on a merge button is the button's; it must not also select an edge under it.
  if (onMarker(src)) return;
  const x = Number.isFinite(src.clientX) ? src.clientX : null;
  const y = Number.isFinite(src.clientY) ? src.clientY : null;

  /*
   * The echo of a TOUCH we already handled: same place, moments later.
   *
   * `handled.touch` is the word that was missing, and leaving it out cost a
   * whole tool. `handled` used to be stamped by every tap from either path, so
   * two MOUSE clicks close together in quick succession looked exactly like a
   * touch and its synthetic echo -- and the second one was dropped in silence.
   *
   * That is not a rare shape. It is precisely what the point eraser is for:
   * clearing a run of strays off a traced outline, where the corners sit well
   * inside thirty pixels of each other and nobody waits seven hundred
   * milliseconds between them. The browser run found it as "31 corners -> 31,
   * the second tap did nothing".
   *
   * Only positions that are both known are compared: treating "position
   * unknown" as "same position" would swallow legitimate taps.
   */
  const known = x !== null && handled.x !== null;
  if (known && handled.touch &&
      Date.now() - handled.at < ECHO_MS &&
      Math.hypot(x - handled.x, y - handled.y) < ECHO_SLOP_PX) {
    return;
  }

  diag.viaClick++;
  handleMapPoint(e.lngLat, x, y);
}

function handleMapPoint(lngLat, x = null, y = null, fromTouch = false) {
  diag.clicks++;
  /* `fromTouch` is what lets onMapClick tell a synthetic echo from a second
     deliberate click. Without it, two quick mouse clicks in the same place are
     indistinguishable from one touch -- see the note there. */
  handled = { at: Date.now(), x, y, touch: fromTouch };

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

  /*
   * Moving the property pin comes first, because on the confirm step there is
   * nothing else a tap could mean: no shapes exist yet, no edge is being
   * edited, and the detection pins belong to a screen two steps later.
   */
  if (state.placingPin) return movePin(lngLat);
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

const knownModel = (id) => typeof id === 'string' && state.models.some((m) => m.id === id);

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
/*
 * THE LAND COVER MAP, ONLY WHERE IT IS (owner, 2026-09-30: "only Virginia
 * right now"). Its method in the AI picker and its two overlays in the layer
 * list were offered everywhere, and outside the raster the method only ever
 * fell back to the AI -- an option that is a detour, shown to everyone.
 *
 * The state comes from the geocoder's region code, or failing that from the
 * county the parcel came from ('va-fairfax'): a dragged pin or a reopened save
 * can have one without the other.
 */
const LAND_COVER_STATES = ['VA'];
const STATE_NAMES = { VIRGINIA: 'VA' };

function stateHere() {
  const said = String(state.chosen?.state || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(said)) return said;
  if (STATE_NAMES[said]) return STATE_NAMES[said];
  const key = String(state.parcel?.properties?.countyKey || '');
  return /^[a-z]{2}-/.test(key) ? key.slice(0, 2).toUpperCase() : null;
}

const landCoverHere = () => LAND_COVER_STATES.includes(stateHere());
const isLandCoverModel = (m) => m.id === 'landcover';
/* Every overlay there is today is the land cover raster (landcover.js). */
const overlaysHere = () => (landCoverHere() ? state.overlays : []);

const offeredModels = () =>
  state.models.filter((m) => (!m.devOnly || state.dev) && (!isLandCoverModel(m) || landCoverHere()));

function buildModelPicker() {
  const select = $('#model-choice');
  const offered = offeredModels();
  // A method this address cannot have (the land cover map outside Virginia)
  // is not left selected with nothing in the menu to say so.
  if (offered.length && !offered.some((m) => m.id === state.model)) {
    state.model = offered.some((m) => m.id === state.defaultModel) ? state.defaultModel : offered[0].id;
  }
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
  else if (state.mode === 'pins') settleMode();
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
    /*
     * WHOSE ALLOWANCE THIS COMES OUT OF.
     *
     * A paid worker arrives signed out, where the allowance is five passes a
     * day for a whole browser -- and the automatic outline is the thing they
     * are paid to correct, so fifteen maps would break on the sixth. Sending
     * the claim lets the JOB pay instead. Not a credential: the server checks
     * that the row exists, is claimed, and is held by this worker, and a
     * worker holds one lawn at a time. See spendJobDetection.
     *
     * THE ID IS SENT WHEN THERE IS ONE, AND THE JOB EITHER WAY. On the paid
     * route there is no worker id to send: it is the account, read from the
     * session, because it decides who gets paid. Requiring both here meant a
     * paid tracer's passes came out of their own daily allowance instead of the
     * lawn's -- invisible while the outline was run for them once on arrival,
     * and no longer invisible now that pressing Detect is the only way they get
     * one at all. The server fills in the account for them.
     */
    ...(state.job
      ? { job: state.job.id, ...(state.worker ? { worker: state.worker } : {}) }
      : {}),
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
    /*
     * The trained model also takes the property line and the NAIP alignment.
     * The line only decides how unsure it reports being (feedback loop 2 ranks
     * lots by that); the alignment is the one training read NAIP with.
     */
    ...(modelInfo(model).fixedPolarity
      ? { parcel: state.parcel?.geometry || null, naipAlign: state.naipAlign || null }
      : {}),
  };
}

async function detect({ again = false } = {}) {
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
  const imgW = Math.min(frame.size * 2, 2560);
  const imgH = Math.min((frame.height || frame.size) * 2, 2560);
  const points = state.pins.map((ll) => {
    const [x, y] = lngLatToFramePx(frame, ll, imgW, imgH);
    return [Math.round(x), Math.round(y)];
  });

  /*
   * Detecting replaces every shape on the map, so when there is work on screen
   * that did not come from this run, say so before destroying it. Before the
   * picker existed this could not happen -- the button disabled itself after a
   * detection -- and re-arming it for a second source quietly put hand-drawn
   * shapes and every correction at risk.
   */
  if (!again && draw.getAll().features.length && !confirm(
    'Detecting again replaces the shapes on the map, including any corrections ' +
    'you have made. Carry on?'
  )) return;

  busy('Detecting your lawn…');
  $('#btn-detect').disabled = true;
  const run = {
    press: (crypto.randomUUID && crypto.randomUUID()) || `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    abort: new AbortController(),
    started: Date.now(),
    action: null,
    accepted: false,
  };
  detection = run;
  startDetectionTimer(run);

  try {
    let data = await api('/api/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...detectionRequest(frame, provider, model, points), press: run.press }),
      signal: run.abort.signal,
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

    run.accepted = true;
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
    /*
     * AND EVERY PIECE OF EVERY PASS. A lot too big to reach the model at
     * 10 cm a pixel in one picture comes back as an n x n grid of masks per
     * pass, laid out by the Worker to abut exactly; they are pasted onto one
     * bitmap here, the size of the stitched frame, and from then on nothing
     * downstream knows there were pieces. A pass of one piece is the old
     * shape and takes the old path.
     */
    const tiling = data.tiling || { cols: 1, rows: 1 };
    /* Which release of the trained model answered, when it was that. */
    let version = null;
    const layers = await Promise.all((data.passes || [{ ...data, exclusion: null }])
      .map(async (pass) => {
        const label = pass.exclusion ? exclusionInfo(pass.exclusion).label : null;
        const pieces = await Promise.all((pass.tiles || [pass]).map(async (tile) => {
          const done = tile.status === 'succeeded'
            ? tile
            : await waitForPrediction(tile.id, rendered, run.abort.signal);
          if (done.version) version = done.version;
          const url = maskUrl(done.mask);
          if (!url) {
            throw new Error(label
              ? `The detector returned nothing for "${label}".`
              : 'The detector returned no mask. Try drawing it by hand.');
          }
          return { col: tile.col || 0, row: tile.row || 0, url, image: await loadMask(url) };
        }));
        return {
          url: pieces[0].url,
          exclusion: pass.exclusion || null,
          label,
          image: pieces.length === 1
            ? pieces[0].image
            : stitchMasks(pieces, tiling.cols, tiling.rows),
        };
      }));

    const subtractive = Boolean(data.subtractive);
    /* A picture that was moved onto Mapbox is traced where it was shown, so
       the outline lands on the grass the person saw (Google; see alignKey). */
    const traceFrame = rendered.provider === 'google' || (!rendered.provider && provider === 'google')
      ? alignedFrame(rendered, state.googleAlign)
      : rendered;
    const traced = traceDetection({
      layers, subtractive, rendered: traceFrame,
      /*
       * A source whose outline is genuinely blockier gets a bigger handle
       * budget, from the catalogue rather than from a list kept here. See the
       * landcover entry in sam.js for the measurements: a 1 m class raster
       * steps where a model mask curves, and spending a budget chosen for
       * curves on a staircase leaves the tracer cutting chords across the real
       * edge -- which is what "the shapes are diverging from the mask" was.
       */
      maxVertices: modelInfo(model).maxVertices || MAX_TRACE_VERTICES,
      // Whatever produced these pixels decides the polarity, not the picker,
      // which the user may change before the next re-trace.
      invert: modelInverts(model),
      fixedPolarity: Boolean(modelInfo(data.model || model).fixedPolarity),
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

    /*
     * THE AI'S OWN OUTLINE, COPIED BEFORE ANYBODY CAN TOUCH IT.
     *
     * Taken here for the same reason detectedSqFt is taken further down: the
     * shapes are edited IN PLACE, so by the time somebody presses finish the
     * detector's answer has been overwritten by the corrected one and is gone
     * for good.
     *
     * A total was never enough. detectedSqFt says how far the answer MOVED;
     * this says WHERE it was wrong, and those are different questions. The
     * known fault is a tree line overshooting by about a quarter, and no pair
     * of totals can show that one outline sits outside the other along the
     * canopy edge -- only the two outlines can.
     *
     * Structured-cloned so later editing of the drawn features cannot reach
     * back into this copy through a shared reference.
     */
    state.detectedShapes = polygons.map((geometry) => structuredClone(geometry));

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
    state.detectedVersion = version;
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
      traceFrame,
      layers,
      subtractive,
      invert: modelInverts(model),
      fixedPolarity: Boolean(modelInfo(data.model || model).fixedPolarity),
      /*
       * Carried with the mask, not looked up again at re-trace time. The edge
       * slider re-traces THIS mask, and by then the picker may say something
       * else -- so a budget read from the picker would quietly re-coarsen a
       * land cover outline the moment somebody nudged the edge.
       */
      maxVertices: modelInfo(model).maxVertices || MAX_TRACE_VERTICES,
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

    /*
     * Point at the edge stepper when the tree pass has eaten the lawn.
     *
     * The trees prompt reads about 25% wider than the trees are, and on a
     * small lot the lawn is the strip left between that and the buildings --
     * so the overshoot lands entirely on the answer. See overTrimmed() for the
     * measurements this is built on.
     *
     * Worth a sentence because the remedy is already on screen and free: the
     * stepper re-traces the mask that was already paid for, so pushing the
     * outline out costs no detection. Nothing in the old wording connected a
     * disappointing number to the control that fixes it.
     */
    const parcelSqFt = state.parcel ? measure(state.parcel.geometry).squareFeet : 0;
    const lawnSqFt = totalSquareFeet();
    /*
     * WHAT THE AI SAID, BEFORE ANYBODY TOUCHED IT.
     *
     * The number that decides whether a finished map is worth keeping as a
     * training example. `handEdited` only says somebody drew SOMETHING; this
     * says how far the answer actually moved, which separates a real
     * correction from nudging one corner -- and training on barely-touched
     * output is training a model on its own predictions.
     *
     * Taken here rather than where the other detection state is set, because
     * the shapes only reach the map a few lines above this and totalSquareFeet
     * would have measured the PREVIOUS lawn. Unrecoverable later either way:
     * the shapes are edited in place, so by the time anyone asks, the AI's own
     * answer is gone.
     */
    state.detectedSqFt = Math.round(lawnSqFt);
    const overTrim = overTrimmed({
      subtractive,
      trimmedTrees: layers.some((l) => l.exclusion === 'woods')
        && !collapsed.includes(exclusionInfo('woods').label),
      lawnSqFt,
      parcelSqFt,
    })
      ? ` That is only ${Math.round((lawnSqFt / parcelSqFt) * 100)}% of the lot,`
        + ' which usually means the tree remover read wider than the trees really are.'
        + ' Use "Trim or extend the edge" below to push the outline back out a foot'
        + ' or two — it costs no detections.'
      : '';

    // Name the source only when it is not the one showing, i.e. when a
    // look-only choice was silently substituted. Saying "on Mapbox satellite"
    // after every ordinary detection is noise; saying it when the user picked
    // Esri is the difference between a fallback and a lie.
    const on = state.detectedWith === state.provider
      ? ''
      : ` on ${providerInfo(state.detectedWith).label}` +
        ` (${providerInfo(state.provider).label} cannot be measured from)`;

    /*
     * WHICH OF THE TWO ANSWERED, always said out loud.
     *
     * The land cover method and the AI are being shipped side by side to find
     * out which is better, and an outline with no label makes that impossible
     * to judge -- somebody reporting "it was blocky today" or "it missed the
     * side yard" has told us nothing unless we know what produced it.
     *
     * It also has to be said because the two cost different things. A free
     * press that looked identical to a paid one would train people to avoid
     * the free one, and a fallback to the AI that said nothing would spend a
     * detection somebody thought was free.
     */
    const source = data.free
      ? ' Read from the 1 m land cover map rather than the AI, so it cost no detections'
        + ' — expect straighter, blockier edges.'
      : data.fellBack === 'landcover'
        ? ' The land cover map has no data at this address, so the AI answered instead'
          + ' and this press used a detection.'
        : data.fellBack === 'alpha'
          ? ' The trained model is not switched on right now, so "Find grass" answered instead.'
          : '';

    /*
     * SAY WHEN THE LOT WAS PHOTOGRAPHED IN PIECES, because it cost that many
     * passes per box and because the resolution the model read is the fact
     * that decides whether a bad outline is the model's fault or the
     * picture's. Said only when it happened: "one picture" after every press
     * is noise.
     */
    const tiled = tiling.cols > 1
      ? ` This lot is big, so it was photographed in ${tiling.cols * tiling.rows} pieces`
        + ` and the AI read it at ${tiling.groundCm} cm a pixel`
        + (tiling.capped
          ? ', the finest the piece limit allows here — an even bigger lot would need the limit raised.'
          : '.')
      : '';

    setStatus(
      (subtractive
        ? `${polygons.length} section${polygons.length > 1 ? 's' : ''} of lawn left after removing `
          + `${layers.length} thing${layers.length > 1 ? 's' : ''}`
        : `Found ${polygons.length} section${polygons.length > 1 ? 's' : ''} of lawn`) +
      (parcelRing() ? ', trimmed to your property line' : '') + on + '.' + source + tiled + lost + gaps + scraps +
      overTrim + ' Correct anything it got wrong.'
    );
  } catch (err) {
    /*
     * CANCELLED OR RETRIED from the timer, and already handed back.
     */
    if (run.released || err.cancelled || err.body?.cancelled) {
      if (run.action !== 'retry') {
        setStatus('Cancelled. It did not count against today\'s detections.', 'warn');
      }
      return;
    }
    /*
     * ANY OTHER FAILURE AFTER THE PRESS STARTED is handed back too: no trace
     * reached the person, so it does not count (the Worker checks the
     * detector really did not answer). Before it started, nothing was charged.
     */
    /* Timed out waiting for the first answer counts too: the Worker may have
       started (and charged) it, and a cancel left before it records the press
       is read when it does. */
    if (run.accepted || err.status === 0) {
      const back = await releasePress(run.press, 'failed');
      if (back.refunded) err.message = `${err.message} It did not count against today's detections.`;
    }
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
      /*
       * The free method, named exactly when it matters.
       *
       * Somebody out of passes is the one person who most needs to know there
       * is a method that does not use them, and this sentence used to offer
       * only "draw it by hand" -- which is true, unlimited, and much more work
       * than picking the other option in a menu they may not have opened.
       *
       * Read off `local` in the catalogue rather than by naming the method
       * here, so that a second free method, or the removal of this one, needs
       * no edit in this file.
       */
      const free = offeredModels().find((m) => m.local);
      setStatus(
        `${left} of your ${b.limit || 0} AI passes left today and this press `
        + `needs ${b.wanted || 1}. They come back in the morning. `
        + (free ? `"${free.label}" uses no passes and may have your address — try that first. ` : '')
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
       * THE LAWN'S OWN PASSES, WHICH ARE NOT ANYBODY'S ALLOWANCE.
       *
       * On the two public routes the AI is free and the ceiling belongs to the
       * property rather than to the person: twenty goes at one lawn, nothing
       * charged to them either way. This branch is FIRST because the refusal
       * carries `used` and `limit` like the daily one does, and the handler
       * below would read those as the day's counter -- telling a volunteer they
       * had used up an allowance they have not touched, on a screen with no
       * counter on it. The server's sentence says what actually happened and
       * what to do next.
       */
      if (b.jobSpent) {
        setStatus(b.reason || 'That lawn has had its goes at the AI. '
          + 'Draw it by hand from here.', 'warn');
        return;
      }

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
      /*
       * WHY IT NEEDED SO MANY, when the lot is the reason. "Needs 8" with two
       * boxes ticked reads as broken unless the pieces are named: a lot too
       * big to reach the AI at 10 cm a pixel in one picture is photographed
       * in several, and every piece of every box is a pass.
       */
      const because = b.pieces > 1
        ? `This lot is big enough to be photographed in ${b.pieces} pieces, so each box is `
          + `${b.pieces} passes. `
        : '';
      setStatus(
        short
          ? `${because}That needs ${b.wanted} AI passes and you have ${left} left today. `
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
    if (detection === run) detection = null;
    updatePromptHint();
    refreshQuota();
    if (run.action === 'retry') setTimeout(() => detect({ again: true }), 0);
  }
}

/**
 * Wait out a prediction that outlived the server's hold on the connection.
 *
 * The first run of the day is the slow one -- the model has to be loaded onto
 * a GPU before it can look at anything. Saying so beats a silent spinner.
 */
async function waitForPrediction(id, frame, signal = null) {
  const started = Date.now();
  const DEADLINE_MS = 4 * 60 * 1000;
  const cancelled = () => {
    const e = new Error('Cancelled.');
    e.cancelled = true;
    return e;
  };

  while (Date.now() - started < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 2500));
    if (signal?.aborted) throw cancelled();

    const secs = Math.round((Date.now() - started) / 1000);
    /* The overlay's own timer counts; this only says why it is slow. And it
       leaves the words alone while Cancel or Retry is being answered. */
    if (!detection?.action) {
      busy(secs < 25 ? 'Detecting your lawn…' : 'Still working — the AI is warming up');
    }

    let p;
    try {
      p = await api(`/api/prediction?id=${encodeURIComponent(id)}`, { signal });
    } catch (e) {
      if (e.cancelled) throw e;
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
  /*
   * The bitmap the tracer read, not the file the detector wrote. They were
   * the same thing until big lots were cut into pieces: now the first
   * piece's file is a quarter of the lot, and stretching it over the whole
   * frame would put the mask in the wrong place -- the exact misalignment
   * this overlay exists to catch, manufactured by the overlay itself. So the
   * stitched pixels are drawn back into a canvas and shown from there, for
   * every detection, pieces or not.
   */
  const image = state.lastMask.layers?.[0]?.image;
  const canvas = document.createElement('canvas');
  let url = `/api/mask?url=${encodeURIComponent(state.lastMask.url)}`;
  if (image?.width && image?.data) {
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').putImageData(
      image instanceof ImageData ? image : new ImageData(image.data, image.width, image.height),
      0, 0
    );
    url = canvas.toDataURL('image/png');
  }
  map.addSource('mask-overlay', {
    type: 'image',
    url,
    coordinates: frameCorners(state.lastMask.traceFrame || state.lastMask.frame),
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
  /* `lulc-` is in here for a reason worth keeping: without it the alternative
     aerial is inserted ABOVE the land cover overlay and hides it, which breaks
     the one thing that overlay exists to do -- be compared against the
     photograph. A comparison layer under the thing it is compared with is not
     a cosmetic fault. */
  const ours = /^(gl-draw|parcel-|edge-highlight|erase-stroke|points|point-|surveyed|mask-overlay|lawn-pins|lulc-)/;
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

  /*
   * OVERLAYS, under a rule, and as checkboxes rather than radios.
   *
   * They are a different kind of thing from the photographs above them:
   * choosing an aerial replaces what you are looking at, switching one of
   * these on adds to it, and several can be on at once. A radio group cannot
   * say that, and putting them in the same group would make picking the land
   * cover silently drop you off Mapbox.
   *
   * The list does NOT close on a toggle. Comparing three things means flicking
   * them on and off against each other, and a menu that shut after every tap
   * would turn that into nine taps.
   */
  // Overlays left on from a Virginia address come off away from it.
  const here = overlaysHere();
  for (const id of [...state.overlaysOn]) {
    if (!here.some((o) => o.id === id)) toggleOverlay(id);
  }
  if (!here.length) return;

  const rule = document.createElement('div');
  rule.className = 'layerrule';
  rule.textContent = 'Compare against';
  list.append(rule);

  for (const o of here) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitemcheckbox');
    b.setAttribute('aria-checked', String(state.overlaysOn.has(o.id)));
    b.dataset.overlay = o.id;
    if (o.note) b.title = o.note;

    const label = document.createElement('span');
    label.textContent = o.label;
    b.append(label);

    b.addEventListener('click', () => toggleOverlay(o.id));
    list.append(b);
  }
}

/** Repaint the ticks without rebuilding, so the open list does not flicker. */
function refreshLayerList() {
  for (const b of $('#layer-list').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.overlay
      ? state.overlaysOn.has(b.dataset.overlay)
      : b.dataset.provider === state.provider));
  }
}

/* ------------------------------------------------- land cover overlays */
/**
 * Put the land cover raster on the map, or take it off.
 *
 * WHAT THIS IS FOR. The first real test of the land cover method produced
 * outlines that did not follow the mask they were traced from, and from the
 * screen there was no way to tell whether the raster, the mask or the tracer
 * was at fault. With these on, the raster is visible underneath the mask
 * overlay and the drawn shapes, so the three can be compared where they
 * disagree instead of argued about.
 *
 * UNDER THE PROPERTY LINE, like the mask overlay, so the shapes and the
 * boundary stay on top. An overlay that hid the thing it is being compared
 * against would be worse than not having it.
 */
function overlayInfo(id) {
  return state.overlays.find((o) => o.id === id) || null;
}

function showOverlayLayer(id) {
  const info = overlayInfo(id);
  if (!info?.tiles || map.getSource(id)) return;
  map.addSource(id, {
    type: 'raster',
    tiles: [info.tiles],
    /*
     * 256 because that is what the tile template asks the service for. A
     * mismatch here is not an error -- it is a raster quietly drawn at the
     * wrong scale, which on a comparison layer is the worst possible fault.
     */
    tileSize: 256,
    /*
     * The raster is 1 m and the map is routinely past z20, where there is no
     * more detail to be had. Stopping the request at 19 and letting Mapbox
     * upscale shows the real pixels as real pixels, rather than asking the
     * service to invent a smooth version of them -- which would hide exactly
     * the blockiness being investigated.
     */
    maxzoom: 19,
  });
  map.addLayer({
    id, type: 'raster', source: id,
    paint: { 'raster-opacity': 0.6, 'raster-resampling': 'nearest' },
  }, map.getLayer('parcel-fill') ? 'parcel-fill' : undefined);
}

function hideOverlayLayer(id) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

function toggleOverlay(id) {
  if (state.overlaysOn.has(id)) {
    state.overlaysOn.delete(id);
    hideOverlayLayer(id);
  } else {
    state.overlaysOn.add(id);
    showOverlayLayer(id);
  }
  refreshLayerList();
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
  // Looked at on this map: the save check asks whether it lined up.
  if (isAligned(id)) state.altViewed = id;
  $('#imagery-source').value = id;
  renderProviderNote(id);
  refreshLayerList();

  await showImagery();
  // Switching sources re-arms detection: a different photograph is a genuinely
  // different prediction, not a second charge for the same one.
  updatePromptHint();
}

function hideImagery() {
  // Nothing is watching once nothing is shown: a tile request already in
  // flight for the source you just left must not report against the one you
  // switched to.
  tileWatch = null;
  if (map.getLayer('imagery-alt')) map.removeLayer('imagery-alt');
  if (map.getSource('imagery-alt')) map.removeSource('imagery-alt');
  const panel = document.getElementById('naip-align');
  if (panel) panel.hidden = true;
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

/*
 * Which tile source is on screen, so a failure can be reported against the
 * name the person chose rather than against a source id they have never seen.
 * `reported` keeps one message per switch: a blank map is a hundred failed
 * tiles, and a hundred status lines is not more informative than one.
 */
let tileWatch = null;

/**
 * Mapbox GL's own complaint about a tile it could not load.
 *
 * Registered once, at map setup. Registering it inside showImagery would add a
 * listener per switch, and by the fourth look at Esri one dead tile would say
 * so four times.
 */
function watchTileErrors() {
  map.on('error', (e) => {
    if (e?.sourceId !== 'imagery-alt' || !tileWatch || tileWatch.reported) return;
    tileWatch.reported = true;

    const status = e.error?.status;
    const name = tileWatch.label || 'That source';
    setStatus(
      status === 404
        ? `${name} has no photograph of this spot at this zoom. Zoom out a little, or switch back.`
        : status === 401 || status === 403
          ? `${name} refused the request (${status}) — it may now require an account. Switch back for now.`
          : `${name} did not load${status ? ` (${status})` : ''}. The map underneath is Mapbox, not it.`,
      'warn'
    );
  });
}

/*
 * WHICH IMAGERY REQUEST PUT "Fetching…" UP, if one did. A newer choice takes
 * it down: the older request, when it finally lands, sees it is stale and
 * returns without touching the overlay -- which left "Fetching USGS
 * vegetation index…" over the map for good whenever USGS took longer than
 * the next choice (the browser test, 2026-09-27: 17 s for one NDVI frame).
 * Only an overlay imagery put up is taken down; detection's is its own.
 */
let imageryBusyRun = 0;

async function showImagery() {
  const run = ++imageryRun;
  if (imageryBusyRun) { idle(); imageryBusyRun = 0; }
  hideImagery();
  if (state.provider === 'mapbox') return;

  const info = providerInfo(state.provider);
  const before = bottomOfOurLayers();

  if (info.tiles) {
    /*
     * A TILE SOURCE THAT FAILS PAINTS NOTHING, AND SAYS NOTHING.
     *
     * The paragraph below says this about the image path and it is just as
     * true here, where nothing was watching: a tile that 404s leaves the
     * Mapbox basemap showing through, so switching to Esri and seeing Mapbox
     * looks like a source that is identical rather than one that is absent.
     * That is how "Esri hasn't been providing any imagery" went unexplained --
     * the app had the answer and never mentioned it.
     *
     * `maxzoom` WAS the cause, and it is now measured rather than assumed --
     * see the table in worker/src/imagery.js. Telling Mapbox that tiles exist
     * to 23 makes it REQUEST z20, z21, z22; past the end of Esri's cache those
     * come back as a 200 carrying a "map data not yet available" placeholder,
     * so nothing errors and the map shows that instead of the ground. The
     * listener above would never have fired for it.
     *
     * Which is also why the ceiling has to be SENT by the Worker rather than
     * discovered here: a valid JPEG of the words "not available" is not
     * something the browser can tell from photography.
     */
    tileWatch = { provider: state.provider, label: info.label, reported: false };
    map.addSource('imagery-alt', {
      type: 'raster',
      tiles: [info.tiles],
      tileSize: 256,
      maxzoom: Number.isFinite(info.maxzoom) ? info.maxzoom : 19,
      attribution: info.attribution || 'Esri, Maxar, Earthstar Geographics',
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
  imageryBusyRun = run;
  /* NAIP's own picture, kept for lining it up with Mapbox: USGS is slow
     (seven to eleven seconds a picture) and asking it twice made the next
     request queue behind the first (the browser test, 2026-09-27). */
  let naipBlob = null;
  try {
    /* A source that never answers must not leave "Fetching…" over the map
       for good: the browser test caught USGS doing exactly that. */
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (res.ok && (state.provider === 'naip' || state.provider === 'google')) {
      naipBlob = await res.clone().blob();
    }
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
    idle(); imageryBusyRun = 0;
    setStatus(
      err.refused
        ? `${info.label} refused the request — this is a set-up problem, not a gap in the photography. It said: “${err.message}” Staying on Mapbox.`
        : err.name === 'TimeoutError'
          ? `${info.label} did not answer within 30 seconds. Staying on Mapbox — try it again in a moment.`
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
    type: 'image', url,
    coordinates: alignOf(state.provider)
      ? movedCorners(frameCorners(served), alignOf(state.provider).east,
        alignOf(state.provider).north, alignOf(state.provider).scale)
      : frameCorners(served),
  });
  map.addLayer({ id: 'imagery-alt', type: 'raster', source: 'imagery-alt' }, before);
  applyAlignOpacity();
  idle(); imageryBusyRun = 0;
  if (isAligned(state.provider)) alignNaip(served, run, naipBlob);
  setStatus(info.detect
    ? `Showing ${info.label} over the measurement frame. Detect again to use it.`
    : `Showing ${info.label}. This one is for looking at — detection uses Mapbox.`);
}

/* ------------------------------------------ NAIP, lined up with Mapbox */
/**
 * NAIP IS MOVED ONTO THE MAPBOX PHOTOGRAPH, not the other way round (owner,
 * 2026-09-27): it is sometimes shifted or a little off in scale, and Mapbox
 * is the trusted one. On showing NAIP (or the NDVI drawn from it), both
 * pictures of the same frame are compared edge for edge (lib/align.js) and
 * NAIP's corners moved by what fits best. The person can nudge it from the
 * panel; whatever they settle on is saved with the map (corpus.naip_align)
 * and applied again before the detector reads NAIP's near-infrared, so the
 * check happens here, in front of somebody, rather than only in a pipeline.
 */
const NAIP_STEP_M = 0.25;
const NAIP_STEP_SCALE = 0.0025;
const isNaip = (id) => id === 'naip' || id === 'ndvi';

/*
 * AND GOOGLE, THE SAME WAY (owner, 2026-09-30: "Google and Mapbox don't line
 * up very well, sometimes worse than others"). Same edge-for-edge comparison
 * and the same nudges, with its own record: Google's error at a place has
 * nothing to do with NAIP's, and NAIP's is the one saved for the detector.
 * Google's search reaches further, because its misfit is the larger one.
 */
const alignKey = (id) => (isNaip(id) ? 'naipAlign' : id === 'google' ? 'googleAlign' : null);
const isAligned = (id) => Boolean(alignKey(id));
const alignOf = (id) => (alignKey(id) ? state[alignKey(id)] || null : null);
const ALIGN_REACH_M = { naipAlign: 5, googleAlign: 8 };

/**
 * A frame moved onto the Mapbox photograph by an alignment: centre shifted,
 * ground per pixel scaled. The picture is drawn on it, and a detection made
 * from that picture is traced against it, so the outline lands where the
 * picture showed the grass rather than where the source's own frame puts it.
 */
function alignedFrame(frame, a) {
  if (!frame || !a) return frame;
  const lat = frame.lat * Math.PI / 180;
  return {
    ...frame,
    lng: frame.lng + (a.east / (6378137 * Math.cos(lat))) * 180 / Math.PI,
    lat: frame.lat + (a.north / 6378137) * 180 / Math.PI,
    zoom: frame.zoom - Math.log2(a.scale || 1),
  };
}

async function greyOf(source, w, h) {
  let blob = source;
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return luminance(ctx.getImageData(0, 0, w, h).data, w, h);
}

function applyNaipAlign(served) {
  const src = map.getSource('imagery-alt');
  const a = alignOf(state.provider);
  if (src?.setCoordinates && served) {
    src.setCoordinates(a
      ? movedCorners(frameCorners(served), a.east, a.north, a.scale)
      : frameCorners(served));
  }
  renderNaipPanel(served);
}

async function alignNaip(served, run, naipBlob = null) {
  state.naipServed = served;
  const key = alignKey(state.provider);
  const provider = state.provider;
  const name = providerInfo(provider).label || provider;
  /* A nudge somebody made stands; the machine does not overrule a person. */
  if (state[key]?.source === 'person') { applyNaipAlign(served); return; }
  /*
   * ONLY FROM THE NAIP PICTURE ALREADY DOWNLOADED. NDVI is drawn from the
   * same NAIP, so it takes whatever alignment NAIP got; fetching NAIP again
   * just to align NDVI would put a second slow USGS request in front of
   * whatever the person asks for next.
   */
  if (!naipBlob && !state[key]) naipBlob = state.alignBlobs?.[key] || null;
  if (!naipBlob) { applyNaipAlign(served); return; }
  state.alignBlobs = { ...(state.alignBlobs || {}), [key]: naipBlob };
  const acrossM = metresPerPixel(served, 1);
  const downM = acrossM * ((served.height || served.size) / served.size);
  /* Small on purpose: this runs on the phone's main thread. 192 cells and a
     5 m search over five scales is about 40 million steps, well under a
     second, where 256 cells, 6 m and seven scales was nearly four times it. */
  const cellM = Math.max(0.6, acrossM / 192);
  const w = Math.max(48, Math.round(acrossM / cellM));
  const h = Math.max(48, Math.round(downM / cellM));
  renderNaipPanel(served, `Lining ${name} up with the Mapbox photograph…`);
  try {
    const [ref, mov] = await Promise.all([
      greyOf(imageryUrlFor('mapbox', served), w, h),
      greyOf(naipBlob, w, h),
    ]);
    if (run !== imageryRun || state.provider !== provider) return;
    await new Promise((resolve) => setTimeout(resolve, 0));  // let the message paint first
    const r = alignImages(ref, mov, w, h, {
      maxShift: Math.max(2, Math.round(ALIGN_REACH_M[key] / cellM)),
      scales: [0.99, 0.995, 1, 1.005, 1.01],
    });
    state[key] = {
      east: r.dx * cellM, north: -r.dy * cellM, scale: r.scale, source: 'auto',
      fit: Math.round(r.ncc * 100) / 100, fit0: Math.round(r.ncc0 * 100) / 100,
    };
    applyNaipAlign(served);
  } catch (e) {
    if (run !== imageryRun) return;
    renderNaipPanel(served, `Could not compare ${name} with Mapbox here (${e.message}); shown as delivered.`);
  }
}

function nudgeNaip(dEast, dNorth, dScale) {
  const key = alignKey(state.provider);
  if (!key) return;
  const a = state[key] || { east: 0, north: 0, scale: 1 };
  state[key] = {
    east: a.east + dEast, north: a.north + dNorth,
    scale: Math.min(1.05, Math.max(0.95, a.scale + dScale)), source: 'person',
  };
  applyNaipAlign(state.naipServed);
}

/*
 * THE LINE-UP PANEL: COLLAPSED UNTIL ASKED FOR (owner, 2026-10-01: "it takes
 * up too much space"). Collapsed it is one small button under Layers. Open it
 * is a bar along the bottom of the map with the nudges and an opacity slider
 * (Google or NAIP over the Mapbox photograph, 60% to start, so the two can be
 * lined up by eye), and the drawing tools are put away and switched off while
 * it is: nudging a picture and editing a lawn are not one job.
 */
const ALIGN_OPACITY_DEFAULT = 0.6;

function applyAlignOpacity() {
  if (!map?.getLayer('imagery-alt')) return;
  const v = state.alignOpen ? (state.alignOpacity ?? ALIGN_OPACITY_DEFAULT) : 1;
  try { map.setPaintProperty('imagery-alt', 'raster-opacity', v); } catch { /* not ready */ }
}

/*
 * THE IMAGERY TOUR, AND WHO HAS SEEN THE LINE-UP PANEL (owner, 2026-10-01).
 * Once a session, for whichever of Google or NAIP is opened first; and on
 * demand from the save check (imageryTourDue). Session storage, so a reload
 * does not ask again; a fresh tab does.
 */
const IMAGERY_TOUR_KEY = 'lm_imagery_tour';
const ALIGN_OPENED_KEY = 'lm_align_opened';
const sessionFlag = (key) => { try { return sessionStorage.getItem(key) === '1'; } catch { return false; } };
const setSessionFlag = (key) => { try { sessionStorage.setItem(key, '1'); } catch { /* private mode */ } };
let imageryTourDue = false;

function maybeImageryTour() {
  if (!isAligned(state.provider) || state.alignOpen || tour.stage === 'imagery') return;
  const btn = document.querySelector('#naip-align .naipalign-open');
  if (!btn || btn.offsetParent === null) return;
  if (!imageryTourDue && sessionFlag(IMAGERY_TOUR_KEY)) return;
  imageryTourDue = false;
  setSessionFlag(IMAGERY_TOUR_KEY);
  showTour('imagery', { force: true });
}

function setAlignOpen(open) {
  const was = Boolean(state.alignOpen);
  state.alignOpen = Boolean(open) && isAligned(state.provider);
  if (state.alignOpen) setSessionFlag(ALIGN_OPENED_KEY);
  if (state.alignOpen && !was) {
    setMode(null);
    if (tips.stage) hideTip();
  }
  applyAlignOpacity();
  refreshRail();
  renderNaipPanel(state.naipServed);
  if (!state.alignOpen && was) settleMode();
}

function renderNaipPanel(served, message) {
  const panel = document.getElementById('naip-align');
  if (!panel) return;
  panel.hidden = !isAligned(state.provider);
  if (panel.hidden) {
    if (state.alignOpen) { state.alignOpen = false; refreshRail(); }
    return;
  }
  panel.classList.toggle('open', Boolean(state.alignOpen));
  panel.textContent = '';
  const a = alignOf(state.provider);
  const who = isNaip(state.provider) ? 'NAIP' : (providerInfo(state.provider).label || 'This picture');
  let said;
  if (message) {
    said = message;
  } else if (!a || (!a.east && !a.north && a.scale === 1)) {
    said = a?.source === 'auto'
      ? `${who} already lines up with Mapbox here. Nudge it if it looks off.`
      : `${who} as delivered.`;
  } else {
    const ew = `${Math.abs(a.east).toFixed(1)} m ${a.east >= 0 ? 'east' : 'west'}`;
    const ns = `${Math.abs(a.north).toFixed(1)} m ${a.north >= 0 ? 'north' : 'south'}`;
    const sc = a.scale !== 1 ? `, scaled ${((a.scale - 1) * 100).toFixed(1)}%` : '';
    said = `${who} moved ${ew}, ${ns}${sc} to line up with Mapbox`
      + (a.source === 'person' ? ' (set by you).' : ' (automatic).');
  }

  if (!state.alignOpen) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'naipalign-open';
    open.textContent = `Line up ${isNaip(state.provider) ? 'NAIP' : 'Google'} ▸`;
    open.title = said;
    open.addEventListener('click', () => setAlignOpen(true));
    panel.append(open);
    requestAnimationFrame(maybeImageryTour);
    return;
  }

  const head = document.createElement('div');
  head.className = 'naipalign-head';
  const say = document.createElement('p');
  say.textContent = said;
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'naipalign-done';
  done.textContent = 'Done';
  done.addEventListener('click', () => setAlignOpen(false));
  head.append(say, done);
  panel.append(head);

  const row = document.createElement('div');
  row.className = 'naipalign-buttons';
  const btn = (text, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = text; b.title = title;
    b.addEventListener('click', fn);
    row.append(b);
  };
  btn('◀', `Move ${who} west 25 cm`, () => nudgeNaip(-NAIP_STEP_M, 0, 0));
  btn('▶', `Move ${who} east 25 cm`, () => nudgeNaip(NAIP_STEP_M, 0, 0));
  btn('▲', `Move ${who} north 25 cm`, () => nudgeNaip(0, NAIP_STEP_M, 0));
  btn('▼', `Move ${who} south 25 cm`, () => nudgeNaip(0, -NAIP_STEP_M, 0));
  btn('−', `Shrink ${who} a quarter of a percent`, () => nudgeNaip(0, 0, -NAIP_STEP_SCALE));
  btn('+', `Grow ${who} a quarter of a percent`, () => nudgeNaip(0, 0, NAIP_STEP_SCALE));
  const blob = state.alignBlobs?.[alignKey(state.provider)];
  if (blob) {
    btn('Auto', 'Line it up automatically again', () => {
      state[alignKey(state.provider)] = null;
      alignNaip(state.naipServed || served, imageryRun, blob);
    });
  }
  panel.append(row);

  // See-through, so the picture can be lined up against Mapbox underneath.
  const fade = document.createElement('label');
  fade.className = 'naipalign-fade';
  const pct = Math.round((state.alignOpacity ?? ALIGN_OPACITY_DEFAULT) * 100);
  const words = document.createElement('span');
  words.textContent = `${who} opacity ${pct}%`;
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '5';
  slider.value = String(pct);
  slider.setAttribute('aria-label', `${who} opacity over the Mapbox photograph`);
  slider.addEventListener('input', () => {
    state.alignOpacity = Number(slider.value) / 100;
    words.textContent = `${who} opacity ${slider.value}%`;
    applyAlignOpacity();
  });
  fade.append(words, slider);
  panel.append(fade);
}

/** The same URL the Worker builds, asked for through our own origin. */
function imageryUrlFor(provider, frame) {
  return '/api/imagery?' + new URLSearchParams({
    lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size,
    height: frame.height || frame.size, provider,
  });
}

/* ------------------------------------------------- the trained model */
/**
 * Draw what the trained head thinks, over the photograph, in developer mode.
 *
 * TO BE LOOKED AT, NOT USED. It does not become shapes, it cannot be edited,
 * and nothing it says reaches a measurement. The point is to see HOW it is
 * wrong -- a number saying 38% tells you the size of the mistake and nothing
 * about its shape, and "it loses dormant grass" and "it claims the driveway"
 * are the same 38% and want opposite fixes.
 *
 * It runs entirely here: eleven numbers a pixel and a sixteen-unit head is
 * arithmetic a phone does in a moment. The version that also reads a
 * pretrained backbone cannot run in a browser -- that is a two-hundred-megabyte
 * download to look at one garden -- and it scored worse anyway.
 */
let trainedHead = null;

async function loadTrainedHead() {
  if (trainedHead !== null) return trainedHead;
  try {
    const res = await fetch('/api/model');
    if (!res.ok) throw new Error(String(res.status));
    trainedHead = reviveModel(await res.json());
  } catch {
    trainedHead = false;       // asked once, absent; do not ask again
  }
  return trainedHead;
}

async function showTrainedModel() {
  if (!state.frame) { setStatus('Measure a frame first.', 'warn'); return; }

  const model = await loadTrainedHead();
  if (!model) {
    setStatus('No trained model has been published yet. Run workflow 12 with '
      + '"Publish the trained model" ticked — no deploy needed after it.', 'warn');
    return;
  }

  /*
   * A MODEL TRAINED ON A DIFFERENT FEATURE VECTOR CANNOT BE USED, and saying
   * so is not optional.
   *
   * The published weights carry the width they were fitted at. When the
   * feature vector grows -- as it did on 2026-09-19, from 11 columns to 14 --
   * an older model is still perfectly loadable and every number handed to it
   * is a different quantity from the one it learnt. standardise() would slice
   * the rows at the old width, so the columns would silently shear and the
   * page would draw a confident, meaningless wash. Nothing would throw.
   */
  if (model.inputs !== FEATURE_COUNT) {
    setStatus(`That model was trained on ${model.inputs} numbers a pixel and this `
      + `build reads ${FEATURE_COUNT}. Re-run workflow 12 with "Publish" ticked to `
      + 'replace it — drawing it as it is would be meaningless, not merely stale.', 'warn');
    return;
  }

  busy('Running the trained model over this frame…');
  try {
    const img = await new Promise((ok, fail) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => ok(el);
      el.onerror = () => fail(new Error('the photograph would not load'));
      el.src = imageryUrlFor('mapbox', state.frame);
    });

    /*
     * At the grid the model was TRAINED at. Its idea of "rough at five pixels"
     * is a fact about that resolution, so reading features at another one asks
     * it a question in a unit it has never seen.
     *
     * AND THAT GRID FOLLOWS METRES since 2026-09-23: 15 cm a cell, floored at
     * 512 and capped at 1024 -- the same rule as gridFor in the trainer, and
     * it has to be the same rule, because a head trained on 15 cm cells read
     * at 512 over a 200 m lot would be asked about 40 cm cells it never saw.
     */
    const across = metresPerPixel(state.frame, 1);
    const G = Math.min(1024, Math.max(512, Math.ceil(across / 0.15 - 1e-9)));
    /* The frame is a rectangle now, so the raster is too: the same cells
       per metre down as across, or the texture windows would be squashed. */
    const GH = Math.max(1, Math.round((G * (state.frame.height || state.frame.size)) / state.frame.size));
    const canvas = document.createElement('canvas');
    canvas.width = G;
    canvas.height = GH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, G, GH);
    const { data } = ctx.getImageData(0, 0, G, GH);

    /* The same scale the training run measured its windows at, or the texture
       columns mean something different here from what they meant there. */
    const rows = imageFeatures(data, G, GH, { mpp: metresPerPixel(state.frame, G) });
    standardise(rows, { mean: model.mean, sd: model.sd }, model.inputs);
    const p = predict(model, rows);

    /* Painted as a translucent wash rather than traced into an outline: an
       outline would invite dragging it, and this is not editable. */
    const out = ctx.createImageData(G, GH);
    let lit = 0;
    for (let i = 0; i < p.length; i++) {
      const on = p[i] > 0.5;
      if (on) lit++;
      out.data[i * 4] = 255;
      out.data[i * 4 + 1] = 90;
      out.data[i * 4 + 2] = 200;
      out.data[i * 4 + 3] = on ? 110 : 0;
    }
    ctx.putImageData(out, 0, 0);

    const corners = frameCorners(state.frame);
    if (map.getLayer('trained-model')) map.removeLayer('trained-model');
    if (map.getSource('trained-model')) map.removeSource('trained-model');
    map.addSource('trained-model', {
      type: 'image', url: canvas.toDataURL('image/png'), coordinates: corners,
    });
    map.addLayer({
      id: 'trained-model', type: 'raster', source: 'trained-model',
      paint: { 'raster-opacity': 0.75 },
    });

    idle();
    const share = ((100 * lit) / p.length).toFixed(0);
    setStatus(
      `The trained model in pink, over ${share}% of the frame. It was `
      + `${model.errorPct}% wrong on lawns it had never seen`
      + (model.samErrorPct ? `, against ${model.samErrorPct}% for the AI` : '')
      + '. Look at WHERE it is wrong — that is what the number cannot say.'
    );
  } catch (err) {
    idle();
    setStatus(`Could not run it: ${err.message}`, 'warn');
  }
}

/** Take it off again, so the photograph can be seen. */
function hideTrainedModel() {
  if (map.getLayer('trained-model')) map.removeLayer('trained-model');
  if (map.getSource('trained-model')) map.removeSource('trained-model');
  setStatus('Trained model hidden.');
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

/*
 * SOURCE ORDER IS NOT A STACKING POLICY.
 *
 * Every .sheet is `position: fixed; inset: 0; z-index: 20`, so when two are
 * open the one painted on top is whichever sits later in index.html. That was
 * invisible for as long as only one could be open at a time, and stopped being
 * invisible the moment one sheet learned to open another.
 *
 * The paid route does exactly that. Signed out, `?via=paid` shows the job
 * sheet -- "Sign in to be paid", with a Sign in button -- and that button
 * opens the sign-in sheet, which is declared EIGHTY LINES EARLIER in the
 * markup. So it opened underneath. The address field was covered, taps landed
 * on the job sheet instead, and the job sheet has no close button by design,
 * so there was no way out of it at all: the one route where signing in is not
 * optional was the one route where it was impossible.
 *
 * A counter rather than a fixed z-index for the sign-in sheet, because that
 * would only fix the pair that happens to be known about today.
 */
let sheetsOpen = 0;

function openSheet(id) {
  const el = $(id);
  if (el.hidden) sheetsOpen += 1;
  el.style.zIndex = String(20 + sheetsOpen);
  el.hidden = false;
  // The first thing a keyboard lands on should be inside the dialog, not
  // behind it -- otherwise tabbing walks the page underneath.
  el.querySelector('input, button:not(.sheet-x)')?.focus({ preventScroll: true });
}

function closeSheet(id) {
  const el = $(id);
  if (!el.hidden) sheetsOpen = Math.max(0, sheetsOpen - 1);
  el.hidden = true;
  /* Back to the stylesheet's own z-index, so nothing accumulates a number
     across a long session. */
  el.style.zIndex = '';
}

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
  const label = $('#account-label');
  if (me) {
    label.textContent = me.email.split('@')[0];
    return;
  }
  /* On a phone the bar also carries the passes badge and the support heart,
     so the button keeps the half nobody expects -- it is one click -- and
     drops the half everybody assumes. Same single action either way. */
  label.innerHTML = '<span class="a-long">Sign in / 1-click sign up</span>'
    + '<span class="a-short" aria-hidden="true">1-click sign up</span>';
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
/* `=== true` on purpose: an offer nobody asked for stays quiet while the
   answer is still unknown. Volunteering is the one case where guessing wrong
   costs something -- a deliberate press is answered either way. */
const canOfferAccount = () =>
  state.accountsOn && state.emailSignin === true && !signedIn();

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
  /*
   * UNKNOWN SHOWS THE FORM. The two ways of being wrong here are not equal:
   * offering a form that turns out to have no mail behind it costs one tap and
   * ends in the server's own sentence, while withholding it from somebody who
   * could have signed in perfectly well is a dead end with nothing to press.
   *
   * Only a definite no closes the door.
   */
  $('#signin-email-form').hidden = state.emailSignin === false;
  if (state.emailSignin !== false) {
    /* Still guessing? Go and find out, and correct this panel if it was
       optimistic. The tap that opened it is the moment this matters. */
    if (state.emailSignin === null) confirmSigninAvailable();
    return;
  }

  $('#signin-note').textContent =
    'This site cannot send email yet, so there is no way to sign in. '
    + 'Measuring and saving to this browser still work.';
  $('#signin-note').className = 'sheet-note warn';
}

/**
 * Ask again, because the answer was never obtained.
 *
 * The boot-time lookup gets one try. On a phone that is one try on the worst
 * connection of the day, and its failure used to be indistinguishable from a
 * deployment with no mail provider -- for the rest of the visit.
 *
 * Silent when it fails again: the form is already up, and the submit will
 * carry a real answer from the server rather than a guess from here.
 */
async function confirmSigninAvailable() {
  if (state.emailSignin !== null) return;
  try {
    const me = await api('/api/auth/me', { timeoutMs: 8000 });
    state.emailSignin = Boolean(me.email);
    state.user = me.user || null;
  } catch {
    return;
  }
  /* Repaint only on a definite no, and only while the panel is still up --
     anything else would wipe a "check your email" the person is reading. */
  if (state.emailSignin === false && !$('#signin').hidden) renderSigninOptions();
}

/** Ask who is signed in. Never throws: not knowing means signed out. */
async function refreshAccount() {
  if (!state.accountsOn) return;
  try {
    const me = await api('/api/auth/me');
    state.user = me.user || null;
    state.emailSignin = Boolean(me.email);
  } catch {
    /*
     * Signed out is the right conclusion from a failed lookup. WHETHER THE
     * SITE CAN SEND MAIL IS NOT -- that is a fact about the deployment, this
     * request learned nothing about it, and leaving it unknown is what lets
     * the sign-in panel ask again instead of announcing a false answer.
     */
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
/*
 * /#review=<id> -- the console's Edit button, arriving here.
 *
 * Read before the sign-in handler clears the fragment, and cleared the same
 * way once used: a bookmarked URL that reopens somebody else's candidate every
 * time the map loads is a confusing way to lose work.
 */
function readReviewRequest() {
  const raw = location.hash.slice(1);
  if (!raw.startsWith('review=')) return;
  const params = new URLSearchParams(raw);
  const id = params.get('review');
  // Where to go afterwards: the console by default, /maps when it sent us.
  state.reviewBack = params.get('back') === 'maps' ? '/maps.html' : '/admin.html';
  window.history.replaceState(null, '', location.pathname + location.search);
  if (id) openCandidate(id);
}

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
    modelVersion: state.detectedVersion || null,
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
    /*
     * Properties are carried, not blanked. The only one that matters is the
     * inferred flag, and dropping it here would lose the distinction between
     * "I saw this grass" and "I know it is there" on every reload.
     */
    shapes: lawn.map((f) => ({
      type: 'Feature',
      properties: f.properties?.inferred ? { inferred: true } : {},
      geometry: f.geometry,
    })),
    notLawn: state.notLawn.length ? state.notLawn.slice() : undefined,
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
  openMap(s);
}

/*
 * A CANDIDATE FROM THE REVIEW QUEUE, opened for correction.
 *
 * Reached as /#review=<id> from the console's Edit button, because the editing
 * tools are here and duplicating them over there would leave two copies to
 * disagree with each other about what a lawn is.
 *
 * Shaped like a save by the server and opened by the same code, so a restored
 * map means one thing in this file rather than two. Refused for anybody who is
 * not an administrator, by the API rather than by this function.
 */
async function openCandidate(id) {
  let s;
  try {
    const res = await fetch(`/api/admin/candidate?id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(String(res.status));
    s = await res.json();
  } catch {
    setStatus('That candidate could not be opened.', 'warn');
    return;
  }
  openMap(s);
  /*
   * Remembered so finishing can hand the reviewer back to the queue. Finishing
   * also resets the row to unreviewed -- the approval was of the old outline --
   * so the corrected version returns to be judged on its own merits.
   */
  state.reviewingId = id;
  $('#review-bar').hidden = false;
  const toList = state.reviewBack === '/maps.html';
  $('#btn-review-save').textContent = toList ? 'Save and return to the map list' : 'Save and return to the console';
  setStatus('Reviewing a training candidate. Fix whatever is off, then use the buttons above to go back.');
}

/**
 * Back to the console, with or without keeping the corrections.
 *
 * `save` runs the same finish the button at the foot of the panel does, which
 * is what puts the corrected outline in the queue -- and resets the row to
 * unreviewed, because the approval was of the old outline and the new one has
 * to be judged on its own merits.
 *
 * Without it, nothing is written at all: a candidate that turned out to need
 * no correction should go back exactly as it was, and saving an unchanged map
 * would send it round the queue a second time for no reason.
 */
function leaveReview(save) {
  if (!state.reviewingId) return;
  if (save) keepFinished();
  state.reviewingId = null;
  $('#review-bar').hidden = true;
  window.location.href = state.reviewBack || '/admin.html';
}

/* ====================================================== the paid queue ==== */
/*
 * SOMEBODY BEING PAID FIFTY CENTS TO TRACE ONE LAWN.
 *
 * They arrive from a crowd platform at /?w=<their id>, are handed one lawn by
 * the server, correct the automatic outline and send it back for a code they
 * paste into the platform. No account, no address, no sign-up: the id in the
 * link is the whole of their identity here, which is right for a five-minute
 * task -- see worker/src/jobs.js.
 *
 * THE SAME DRAWING TOOLS, NOT A COPY OF THEM. This is a handful of removals
 * on top of the app (see body.job-mode in styles.css) rather than a stripped
 * second page, because the tools people are PAID to use are the last ones that
 * should drift from the ones everybody else gets.
 */

/*
 * What a crowd platform sends before anybody has accepted the task.
 *
 * MTurk shows the task to workers who are only looking, and it says so by
 * putting this literal string in the assignment id. Claiming a lawn for a
 * browser in preview would take a lawn out of the queue for somebody who never
 * agreed to do it, hold it for an hour, and -- worse -- an id-less preview
 * would do it once per curious visitor. So preview shows the instructions and
 * claims nothing.
 */
const MTURK_PREVIEW = 'ASSIGNMENT_ID_NOT_AVAILABLE';

/**
 * A message where the map would be, for every state that has no lawn in it.
 *
 * Deliberately not dismissable. The other sheets sit on top of a working app;
 * for somebody with no lawn open this IS the app, and an × revealing an empty
 * address form behind it is a worker filing a support ticket.
 */
const MYWORK_LINK = { href: '/mywork.html', label: 'Your maps, balance and payouts →' };

function jobSheet({ title, why, code = null, note = null, go = null, link }) {
  /* Every sheet on the paid route carries the way to the tracer's own page
     unless it says otherwise (`link: null`): "no lawn just now" and the day's
     cap are exactly when somebody wants to check what they are owed. */
  if (link === undefined) link = state.jobVia === 'paid' ? MYWORK_LINK : null;
  $('#job-sheet-title').textContent = title;
  $('#job-sheet-why').textContent = why;
  $('#job-code').hidden = !code;
  $('#job-code').textContent = code || '';
  $('#job-sheet-note').hidden = !note;
  $('#job-sheet-note').textContent = note || '';
  const btn = $('#job-sheet-go');
  btn.hidden = !go;
  btn.textContent = go?.label || '';
  btn.onclick = go?.onClick || null;

  const away = $('#job-sheet-link');
  away.hidden = !link;
  away.textContent = link?.label || '';
  if (link) away.href = link.href;

  /* Through openSheet like every other sheet, so the stacking counter knows
     this one is up. It is the sheet most likely to have another opened on top
     of it -- "Sign in to be paid" does exactly that. */
  openSheet('#job-sheet');
}

const hideJobSheet = () => closeSheet('#job-sheet');

/**
 * /?w=<worker id> -- somebody arriving from the platform.
 *
 * A query string rather than a fragment, because the platform builds this URL
 * by substituting into a template it controls and the worker id has to survive
 * that. It is not a secret: it decides which rate limits apply and who the
 * platform pays, and inventing one gets you a fresh set of limits and no way
 * to prove to the platform that you did the work.
 */
/**
 * A name for somebody who arrived through a link that has no name in it.
 *
 * ONE PUBLIC LINK, POSTED SOMEWHERE, IS THE WHOLE POINT OF THE VOLUNTEER
 * ROUTE -- which means it cannot carry an id, and everybody would otherwise
 * share one. That is not a small problem: a worker holds ONE lawn at a time,
 * so two volunteers on one identity would fight over the same claim, and the
 * second would be told a lawn was already open that they could not see.
 *
 * So the browser mints one and remembers it. Not an account and not a
 * credential -- it buys nothing except the right to do unpaid work -- but it
 * keeps claims apart, it survives a reload so a closed tab comes back to the
 * same lawn, and it lets the owner see that eleven maps came from one person
 * rather than from eleven.
 *
 * A browser that refuses storage gets a fresh name each visit, which costs
 * that person their claim on a reload and nothing else. Better than refusing
 * to let them help at all.
 */
const HELPER_KEY = 'lm.helper';

/** Whatever they typed, reduced to something safe to key a queue on. */
const helperSlug = (raw) => `helper-${String(raw || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40)}`;

const storedHelper = () => {
  try { return localStorage.getItem(HELPER_KEY) || null; } catch { return null; }
};

const rememberHelper = (name) => {
  try { localStorage.setItem(HELPER_KEY, name); } catch { /* private window */ }
};

/**
 * ASKED FOR ONCE, AND THE ONLY REASON IT IS ASKED AT ALL.
 *
 * A minted random name kept claims apart, which was the point, and got one
 * thing wrong that only showed up afterwards: it lives in localStorage, so the
 * same person on a phone and a laptop was two people. Eleven maps from one
 * helper read as two strangers with five and six, which is the opposite of
 * what a page about people is for.
 *
 * Nothing carried in a browser can fix that. Identity across devices needs
 * something the PERSON carries, and for somebody who followed a link off a
 * forum to do an unpaid favour, the only acceptable version of that is a name
 * they type. So they are asked, once, and told why.
 *
 * TWO PEOPLE WHO PICK THE SAME NAME BECOME ONE ROW. That is what a name-based
 * identity means and there is no way around it without an account. It is an
 * acceptable trade here and would not be if money moved: a merged volunteer
 * tally is a slightly wrong number on the owner's screen, where a merged paid
 * identity would be somebody's wages.
 *
 * Cancelling or leaving it blank still lets them in, under a random name. The
 * work is the point; the name is bookkeeping, and bookkeeping must never be
 * the thing that turns a volunteer away.
 */
function askHelperName() {
  const kept = storedHelper();
  if (kept) return kept;

  const typed = window.prompt(
    'What should I call you? Use the same name on your phone and your computer '
    + 'and your maps will add up. (Optional — leave it blank to stay anonymous.)',
    ''
  );

  const slug = typed ? helperSlug(typed) : '';
  /* `helper-` on its own means they typed only punctuation. Treat as blank. */
  const name = slug.length > 'helper-'.length
    ? slug
    : `helper-${Math.random().toString(36).slice(2, 10)}`;

  rememberHelper(name);
  return name;
}

function readJobRequest() {
  const params = new URLSearchParams(location.search);
  const worker = (params.get('w') || params.get('workerId') || '').trim();
  /*
   * `via=volunteer` is the only route a LINK may assert, and it is safe
   * because it buys nothing worth forging: what somebody gains by faking it is
   * the right to work for free. Everything else is decided by a row the owner
   * wrote. See routeFor in routes-jobs.js.
   */
  const via = params.get('via');
  const volunteer = via === 'volunteer';
  /*
   * The paid link carries no id either, and unlike the volunteer one it must
   * not invent a name: the id is the account, read from the session by the
   * server, because it decides who gets paid. See identify() in
   * routes-jobs.js.
   */
  const paid = via === 'paid';

  if (!worker && !volunteer && !paid) return null;
  return {
    worker: worker ? worker.slice(0, 64) : (paid ? null : askHelperName()),
    volunteer,
    paid,
    preview: params.get('assignmentId') === MTURK_PREVIEW,
  };
}

async function enterJobMode({ worker, preview, volunteer, paid }) {
  state.worker = worker;
  state.jobVia = paid ? 'paid' : (volunteer ? 'volunteer' : null);
  document.body.classList.add('job-mode');
  $('#job-mywork').hidden = !paid;

  if (preview) {
    /*
     * Previewing. Nothing is claimed, and the sheet says what the task is so
     * somebody can decide whether to accept it -- which is the entire purpose
     * of a preview, and a preview that shows an error is a task nobody takes.
     *
     * ANSWERED BEFORE THE MAP IS CHECKED, deliberately. A preview needs no map
     * -- it is a paragraph of text and it claims nothing either way -- and a
     * platform may well show the preview inside a frame the real task does not
     * use. Reporting a map failure here would turn somebody else's iframe
     * policy into a reason not to accept a task that would have worked.
     */
    jobSheet({
      title: 'Trace one lawn',
      why: 'You will be shown one property on a satellite photograph with a '
        + 'rough outline of its lawn already drawn. Correct that outline — '
        + 'mostly along the drive and the hard edges — and send it back. About '
        + 'five minutes. Accept the task to start.',
      note: 'Nothing has been assigned to you yet. This is the preview.',
    });
    return;
  }

  /*
   * NO MAP, NO CLAIM -- and this was a bug, found by the browser test.
   *
   * initMap RETURNS NORMALLY when the Mapbox CDN is unreachable: it says so on
   * screen and stops, which is right for a visitor who can try again. But the
   * boot chain carries on, so job mode went ahead and claimed a lawn for
   * somebody whose page had no map and no drawing tools on it. That lawn was
   * then out of the queue for an hour, the worker saw a crash, and the whole
   * thing read as the task being broken -- which, for them, it was.
   *
   * An ad blocker, a corporate filter or a CDN outage is exactly the case the
   * message in initMap exists for, and somebody arriving from a crowd platform
   * is more likely to be behind one of those than the average visitor, not
   * less.
   *
   * So: say what happened, claim nothing, and let them return the task without
   * having cost anybody a lawn.
   */
  if (!map || !draw) {
    jobSheet({
      title: 'The map would not load',
      why: 'The mapping library could not be reached from this browser, so '
        + 'there is nothing to trace on. An ad blocker or a network filter '
        + 'blocking api.mapbox.com is the usual cause. Nothing has been '
        + 'assigned to you and you have not lost anything — try again in '
        + 'another browser, or return the task.',
      go: { label: 'Try again', onClick: () => window.location.reload() },
    });
    return;
  }

  await claimNextJob();
}

/** Ask for a lawn, and put whatever comes back on the screen. */
async function claimNextJob(skipped = '') {
  let data;
  let status = 0;
  try {
    /* `via` rides along so a volunteer's FIRST claim knows what it is: there
       is no stored row for them until they have done something. */
    /*
     * No `w` on the paid route. The server reads that identity from the
     * session, because it decides who gets paid and a query string is typed
     * by whoever is typing.
     */
    const res = await fetch(`/api/job?${new URLSearchParams({
      ...(state.worker ? { w: state.worker } : {}),
      ...(state.jobVia ? { via: state.jobVia } : {}),
      /*
       * THE ONE THEY JUST PUT BACK, so the queue does not hand it straight
       * back. Sending the id is what makes "can't do this one" mean
       * something on a batch with one lawn left in it -- moving the row to
       * the back of a queue of one moves it nowhere.
       */
      ...(skipped ? { not: skipped } : {}),
    })}`);
    status = res.status;
    data = await res.json();
  } catch {
    jobSheet({
      title: 'That did not load',
      why: 'The server could not be reached. Your connection may have dropped '
        + '— reload this page and it will try again.',
      go: { label: 'Try again', onClick: () => claimNextJob() },
    });
    return;
  }

  if (status !== 200 || !data?.job) {
    /*
     * EVERY REFUSAL IS A SENTENCE THE SERVER WROTE, not one composed here.
     *
     * The wording of "you are waiting on a review" and "there is no more of
     * this work for you" is the difference between a worker who comes back
     * tomorrow and a worker who writes about the requester on a forum, and it
     * is decided in one place -- claimVerdict in jobs.js -- so that the two
     * gates cannot drift apart and a change to either does not need a deploy
     * of this file to take effect.
     */
    jobSheet({
      title: data?.stopped ? 'Thank you for the maps you sent'
        : data?.waiting ? 'Your maps are being checked'
          /*
           * THE DAY'S CEILING IS NOT A REVIEW, and it used to be titled as
           * one. A worker at the cap read "your maps are being checked" over
           * a sentence about a daily limit, which invites exactly the wrong
           * conclusion: that somebody is deciding something about them. It
           * lifts at midnight and nobody has to do anything.
           */
          : data?.capped ? 'That is the day’s lot'
            : data?.error === 'Nothing left' ? 'That is the lot'
              /*
               * A LINK FAULT IS NOT "no lawn just now", and this is the one
               * refusal most likely to be seen on the day a batch goes out.
               * "No lawn just now" invites somebody to wait and try again,
               * which will never work and wastes their time; the title has to
               * say the link itself is wrong so they return the task and say
               * so. The reason underneath, from the server, explains it.
               */
              : data?.needsAccount ? 'Sign in to be paid'
                : (data?.error === 'Unfilled link' || data?.error === 'No worker id')
                    ? 'Something is wrong with this link'
                    : 'No lawn just now',
      why: data?.reason || 'There is nothing to hand out at the moment.',
      /*
       * Waiting is the one refusal that a later visit actually resolves -- and
       * the sign-in one is the other, since it is resolved by the button
       * rather than by time.
       */
      link: data?.needsAccount ? null : undefined,
      go: data?.needsAccount
        ? {
          label: 'Sign in',
          onClick: () => promptSignin({
            force: true,
            title: 'Sign in to be paid',
            why: 'One emailed link, no password. It is how the money reaches '
              + 'you, how you can change where it goes, and how I can tell you '
              + 'if a payment bounces. Come back to this link afterwards and '
              + 'there will be a lawn waiting.',
          }),
        }
        : data?.waiting || data?.wait
          ? { label: 'Check again', onClick: () => claimNextJob() }
          : null,
    });
    return;
  }

  hideJobSheet();
  state.jobRoute = data.route || 'crowd';
  /*
   * THE SAME LAWN BACK, SAID OUT LOUD.
   *
   * When the batch has nothing else approved, the server hands the skipped
   * lawn back rather than leaving somebody with an empty screen -- and the
   * one thing it must not do then is stay quiet. "Can't do this one" followed
   * by the same lawn and no explanation reads as a broken button, and the
   * report that started this was exactly that.
   */
  await openJob(data.job, data.prompts || [], data.only
    ? 'That is the only lawn left open in this batch right now, so it is back '
      + 'on your screen. Nothing is wrong with the button — there is simply '
      + 'nothing else to hand you. Leave it and come back later if you cannot '
      + 'do it.'
    : (data.cleared || null));
}

/**
 * Put one claimed lawn on the map, ready to correct.
 *
 * It goes through confirmLocation, which is the ordinary path a chosen address
 * takes: county parcel lookup, frame fitted to the property line, surveyed
 * corners remembered. A separate path would be a second place for the frame
 * arithmetic to be wrong, and the frame is what every square foot is measured
 * against.
 */
async function openJob(job, prompts, cleared) {
  state.job = job;
  clearHistory();
  draw.deleteAll();
  hideOverlay();
  state.lastMask = null;
  state.pins = [];
  state.handEdited = false;
  state.askedUnchanged = false;

  /*
   * NO ADDRESS, ON PURPOSE. The queue stores a point and a county and nothing
   * else -- see the lawn_jobs table -- so a stranger being handed a stream of
   * properties is never handed a list of where people live. The county is
   * enough for them to know the picture loaded correctly.
   */
  state.chosen = { lng: job.lng, lat: job.lat, label: job.county || 'This property' };

  $('#job-bar').hidden = false;
  $('#job-where').textContent = [
    'One lawn to trace',
    job.county || null,
    job.parcelSqFt ? `${Number(job.parcelSqFt).toLocaleString()} sq ft plot` : null,
  ].filter(Boolean).join(' · ');

  const box = $('#job-prompts');
  box.textContent = '';
  for (const p of prompts) {
    const para = document.createElement('p');
    para.className = `job-ask${p.optional ? ' optional' : ''}`;
    const title = document.createElement('b');
    title.textContent = p.title;
    para.append(title, p.body);
    box.append(para);
  }

  await confirmLocation();

  /*
   * NO STARTING OUTLINE, ON ANY ROUTE. The AI is off the job routes entirely
   * (volunteer, paid and crowd alike) until there is something better to put
   * in its place: a wrong outline has to be dismantled corner by corner, which
   * tracers said was slower than drawing on an empty map. See body.job-mode in
   * styles.css, which takes the AI tab away too.
   */
  /*
   * Detection counts as the map appearing rather than as somebody editing it,
   * and `edited` is the one machine-checkable thing about a submission. detect
   * clears the flag itself; this is here so a failed detection cannot leave a
   * stale true behind from the previous lawn.
   */
  state.handEdited = false;

  /*
   * AND THEY LAND ON THE PROPERTY LINE, WITH IT ALREADY ARMED.
   *
   * The boundary is the first thing that has to be right, and not because it
   * is tidy: the detection is CLIPPED to it, so grass outside the line cannot
   * be drawn at all until the line is moved. The road prompt asks for exactly
   * that grass -- the verge between a boundary and the kerb -- and somebody
   * who has not understood that the yellow line is draggable will read the
   * prompt, look for the verge, fail to reach it, and quietly leave it out.
   *
   * So the tool is on when they arrive rather than waiting to be found. They
   * move to Draw themselves, which is one press and is the press that teaches
   * what the two tabs are.
   */
  setTab('address');
  setMode('parcel');
  roadTip();

  /*
   * AND, WHERE NOTHING WAS TRACED, SAY SO RATHER THAN SHOWING AN EMPTY MAP.
   *
   * An empty map on a screen that has just said "one lawn to trace" is
   * ambiguous: it looks equally like "draw it" and like "the picture failed to
   * load". One sentence removes that, and names the tab -- the AI is opt-in
   * here, not absent, and somebody who wanted a first attempt should not have
   * to go looking for where it went.
   */
  setStatus([
    cleared,
    'Nothing is traced for you here. Check the yellow property line first, '
      + 'then draw the lawn on the Draw tab.',
  ].filter(Boolean).join(' '));
}

/**
 * "Drag the yellow line out to the road."
 *
 * THE ONE THING SOMEBODY CAN GET WRONG WITHOUT NOTICING. Detection is clipped
 * to the property line, so grass outside it cannot be drawn until the line is
 * moved -- and the boundary very often stops short of the kerb while the lawn
 * does not. Somebody who has not understood that the yellow line is draggable
 * reads the road prompt, looks for the verge, cannot reach it, and leaves it
 * out. Nothing on screen tells them why, and the map they send looks finished.
 *
 * ONCE A SESSION, NOT ONCE A LAWN. It is aimed at somebody meeting the tool
 * for the first time, and on the fortieth lawn it is furniture. The prompt in
 * the job bar is the standing reminder and never goes away.
 *
 * It borrows the coaching box but not the tips MACHINERY: showTip is gated on
 * a preference and on a seen-set, both of which are right for optional advice
 * about a tool you will find anyway, and wrong for the one instruction this
 * job cannot be done correctly without.
 */
let roadTipShown = false;

function roadTip() {
  if (roadTipShown) return;
  roadTipShown = true;

  /* No arrow: the boundary editor is on for the whole step now (restMode),
     so there is no button to point at -- the box sits at the top of the map. */
  tips.stage = 'job-road';
  tips.target = null;
  $('#coach-title').textContent = 'Check the boundary first';
  $('#coach-text').textContent =
    'The yellow line is the property boundary, and it can be dragged. If this '
    + 'property fronts a road and there is grass between the line and the '
    + 'kerb, pull the line out to the kerb now — the lawn cannot be drawn '
    + 'outside it.';
  $('#coach').hidden = false;
  placeTip();
}

/**
 * "Where should the money go?" -- asked once, and only once.
 *
 * ASKED AFTER A MAP RATHER THAN BEFORE ONE. Before, it is a form standing
 * between somebody and the thing they came to do, for money they have not
 * earned and may decide not to bother earning. After their first map they know
 * what the work is and the question is about something real.
 *
 * ONCE, because it is stored on the account. That is the whole reason this
 * route goes through sign-in: typed in a URL it would be re-entered on every
 * device, uncorrectable after a typo, and sitting in every access log the
 * request touched. Here it follows them, and they can change it.
 *
 * Skipping costs them nothing today. The maps are recorded against the account
 * either way, so a destination added next week still gets paid for work done
 * this one -- which is what makes it safe to let somebody say "not now".
 */
async function askPayout() {
  let already = null;
  try {
    const res = await fetch('/api/auth/payout');
    if (res.ok) already = await res.json();
  } catch { /* offline: ask again next time rather than blocking the queue */ }
  if (already?.handle) return;

  const typed = window.prompt(
    'Where should payments go? Enter your Venmo username or your PayPal email '
    + '— you can change it later, and maps already sent still count.',
    ''
  );
  const handle = (typed || '').trim();
  if (!handle) return;

  /*
   * VENMO OR PAYPAL, GUESSED FROM THE SHAPE and never silently. An address
   * with an @ and a dot after it is an email, which Venmo usernames are not.
   * The guess is shown back to them, because getting this wrong means the
   * money goes nowhere and the only person who can catch it is the one
   * reading the confirmation.
   */
  const kind = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(handle) ? 'paypal' : 'venmo';

  try {
    const res = await fetch('/api/auth/payout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, handle }),
    });
    if (!res.ok) throw new Error(String(res.status));
    setStatus(`Saved — ${kind === 'paypal' ? 'PayPal' : 'Venmo'}: ${handle}. `
      + 'Change it any time on your work page.');
  } catch {
    setStatus('That did not save. You can add it later from your work page — '
      + 'the maps still count.', 'warn');
  }
}

/**
 * Send it, and hand back the code.
 *
 * The map goes into the corpus by exactly the same road every other finished
 * map takes -- same body, same cleaning, same id -- because the corpus cannot
 * tell which maps came from where and should not: they are judged the same.
 */
async function submitJob() {
  if (!state.job) return;
  const body = finishedBody();
  if (!body) {
    setStatus('There is no outline on the map yet. Draw the lawn before sending it.', 'warn');
    return;
  }

  $('#btn-job-submit').disabled = true;
  busy('Sending your map…');
  let data;
  let status = 0;
  try {
    /*
     * `via` on the submission too, and not only on the claim. The server works
     * the route out from the query string when there is no stored row yet --
     * which is exactly a volunteer's first map. Left off, their first
     * submission would be judged as a paid stranger's: held to the time floor
     * and handed a completion code with nowhere to paste it.
     */
    const res = await fetch(`/api/job/submit${state.jobVia ? `?via=${state.jobVia}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        worker: state.worker,
        id: state.job.id,
        edited: state.handEdited,
        /* Set only after they have been asked once and said yes. See below. */
        confirmedUnchanged: state.askedUnchanged === true,
      }),
    });
    status = res.status;
    data = await res.json();
  } catch {
    idle();
    $('#btn-job-submit').disabled = false;
    setStatus('That did not send. Check your connection and try again.', 'error');
    return;
  }
  idle();
  $('#btn-job-submit').disabled = false;

  if (status !== 200) {
    /*
     * AN UNCHANGED OUTLINE ASKS A QUESTION RATHER THAN SLAMMING THE DOOR.
     *
     * Now and then the automatic outline really is right, and a hard refusal
     * would leave an honest worker who checked it carefully with four minutes
     * of work they cannot submit. Work done that cannot be paid for is the
     * fastest way for a requester to be written up on a worker forum -- and
     * here it would be our bug producing it, not their behaviour. So: refused
     * once with the reason, and sending again goes through, flagged for the
     * owner. See submissionVerdict.
     */
    if (data?.unchanged) state.askedUnchanged = true;
    setStatus(data?.reason || 'That did not go through. Have another look.', 'warn');
    return;
  }

  $('#job-bar').hidden = true;
  state.job = null;

  /*
   * A CODE ONLY WHERE THERE IS SOMEWHERE TO PASTE ONE.
   *
   * The completion code is proof of work for a crowd platform. Somebody hired
   * directly has no platform and a volunteer has no transaction, so for both
   * of them a code is a puzzle rather than a receipt -- eight characters, no
   * field to put them in, and a nagging sense of having missed a step. The
   * server decides which of the three this is; the page only lays it out.
   */
  jobSheet({
    title: data.route === 'volunteer' ? 'Sent — thank you' : 'Sent',
    why: data.thanks || 'That one is in.',
    code: data.code || null,
    note: data.code
      ? 'Maps are checked by a person, usually within a day. New workers do '
        + 'a few at a time while that happens; you are paid either way.'
      : null,
    go: { label: 'Trace another lawn', onClick: () => claimNextJob() },
    /* A paid tracer needs somewhere to check what was approved and change
       where the money goes. Nobody else has a page to be sent to. */
    link: data.route === 'paid' ? MYWORK_LINK : null,
  });

  /*
   * AND ASKED WHERE THE MONEY GOES, ONCE, after the first map rather than
   * before it.
   *
   * Before it would be a form between somebody and the thing they came to do,
   * for money they have not earned yet and may decide not to bother earning.
   * After the first map they know what the work is, and the question is about
   * something real.
   *
   * Never for the other routes: a volunteer is not owed anything, and crowd
   * and hired are paid somewhere else entirely.
   */
  if (data.route === 'paid') await askPayout();
}

/**
 * A skip is not a rejection, and must not cost the worker anything.
 *
 * One person being unable to see a boundary says nothing about the lawn, so it
 * goes back in the queue for somebody else. What it must NOT do is leave them
 * holding it: a worker blocked for an hour by a lawn they cannot trace is a
 * worker who leaves.
 */
async function skipJob() {
  if (!state.job) return;
  if (!confirm('Put this lawn back for somebody else? Nothing you have drawn '
    + 'on it is kept, and it does not count against you.')) return;

  const id = state.job.id;
  state.job = null;
  $('#job-bar').hidden = true;
  busy('Finding you another one…');
  try {
    /*
     * `via` ON THE SKIP TOO, and leaving it off broke this button outright for
     * every paid tracer.
     *
     * On the paid route there is no worker id in the request to send: the
     * server reads the identity from the session, because it decides who gets
     * paid. Without `via` it does not know to look there, falls back to the id
     * in the body -- which is null on that route -- and refuses the whole
     * request with "need a worker and a job". Nothing here reads the response,
     * so the press looked like it worked, the claim stayed standing, and the
     * next claim resumed the same lawn. See identify() in routes-jobs.js.
     */
    await fetch(`/api/job/skip${state.jobVia ? `?via=${state.jobVia}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker: state.worker, id, why: 'skipped from the map' }),
    });
  } catch {
    /* The claim expires by itself within the hour, so a skip that did not
       reach the server costs the queue an hour and the worker nothing. */
  }
  idle();
  /*
   * The id goes with the request whether or not the skip above succeeded --
   * INCLUDING when it threw. A skip that never reached the server is exactly
   * the case where the queue still has this lawn at the front, and asking for
   * "anything but this one" is the only thing standing between the worker and
   * the lawn they just refused.
   */
  await claimNextJob(id);
}

function openMap(s) {
  /*
   * Whatever visit was in progress is over. Opening a SAVED map from the
   * history list while a review was open would otherwise leave the way-back
   * bar on screen pointing at the candidate -- and "Save and return to the
   * console" would put this other lawn into the queue under that candidate's
   * id. openCandidate sets it again immediately afterwards, which is the only
   * place it should ever be set.
   */
  state.reviewingId = null;
  $('#review-bar').hidden = true;

  clearHistory();
  draw.deleteAll();
  hideOverlay();
  state.lastMask = null;

  state.chosen = { label: s.address, lng: s.lng, lat: s.lat };
  state.parcel = s.parcel || null;
  state.frame = s.frame || null;
  state.provider = s.provider || 'mapbox';
  state.model = knownModel(s.model) ? s.model : state.defaultModel;
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
  state.detectedVersion = s.modelVersion || null;
  state.detectedWith = s.provider || null;
  state.detectedExcluding = state.exclude.length ? state.exclude.slice().sort().join(',') : null;
  state.handEdited = true;
  /*
   * A reopened save has no detector outline and must not borrow the last one.
   * What is on screen is the FINISHED shape from that save -- the AI's own
   * answer was overwritten when it was first corrected and never stored. Left
   * null, the row records "no detection to compare against", which is true;
   * carried over, it would pair one lawn's corrected outline with a different
   * lawn's detection and look entirely plausible.
   */
  state.detectedShapes = null;
  /* NAIP's alignment belongs to the place; a reopened map starts from what
     the pipeline or the editor finds again rather than a stale nudge. */
  state.naipAlign = null;
  state.googleAlign = null;
  state.alignBlobs = {};

  map.getSource('parcel').setData(state.parcel || empty());
  for (const f of (s.shapes || [])) {
    /* The saved record carries the inferred flag, so restoring must too --
       otherwise reopening a map silently downgrades every inferred area to
       ordinary lawn and the distinction survives only until the next reload. */
    draw.add({
      type: 'Feature',
      properties: f.properties?.inferred ? { inferred: true } : {},
      geometry: f.geometry,
    });
  }
  /* Not-lawn traces come back with the map (a save, or a candidate reopened
     for review), so correcting a lawn does not drop them. */
  state.notLawn = Array.isArray(s.notLawn) ? s.notLawn.filter((g) => g?.type && g.coordinates) : [];
  refreshNotLawn();

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
  /*
   * NEVER OF A PAID WORKER. They did not choose this lawn, they are on the
   * clock, and answering uploads the map and the address -- which for them is
   * a stranger's property they were handed, not their own. It is also a modal
   * question standing between somebody and the work they are being paid for.
   */
  if (state.job) return false;
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
  requestAnimationFrame(maybeToolTour);
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
        /*
         * Fall back to the frame, because state.chosen is the GEOCODED address
         * and a session that never typed one has none: a restored save, a
         * shared link, anything opened from the Saved tab. Reports were
         * arriving with no coordinates at all and the review page could not
         * draw them, which read as "the image did not upload" -- there is no
         * image, the page rebuilds the map from these numbers.
         */
        lng: state.chosen?.lng ?? state.frame?.lng ?? state.lastMask?.frame?.lng ?? null,
        lat: state.chosen?.lat ?? state.frame?.lat ?? state.lastMask?.frame?.lat ?? null,
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
        /*
       * The inferred flag travels with the shape. Geometry alone cannot say
       * which lawn was seen and which was worked out, and this is the path
       * that feeds training -- so it is the one where the distinction is
       * worth anything at all.
       */
      shapes: shapes.map((f) => ({
        type: 'Feature',
        properties: f.properties?.inferred ? { inferred: true } : {},
        geometry: f.geometry,
      })),
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
 * TWO LOCKS. Running the AI again replaces every shape on the map, so doing
 * it by accident from a tab you wandered into destroys hand corrections that
 * took real work. That is worth a gate. And the property line locks once the
 * AI has traced (owner, 2026-09-30) -- see the end of this function.
 *
 * HISTORY, since the second lock reverses it: the property line was once
 * gated on hand edits, on the reasoning that moving the
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
  /*
   * AND THE PROPERTY LINE, ONCE THE AI HAS TRACED (owner, 2026-09-30). This
   * reverses the paragraph above on purpose: the line is meant to be settled
   * BEFORE detecting -- the tip on this step says so -- and a line moved under
   * an AI trace leaves that trace clipped to a boundary that no longer exists.
   * Clearing the lawn keeps the line and lifts this, same as the AI step's.
   */
  if (tab === 'address' && state.detected) {
    return {
      text: 'The AI has already traced this lawn against this property line, so '
        + 'the line is locked. To change it, clear the lawn — the line is kept — '
        + 'then adjust it and detect again.',
      clear: true,
      redetect: false,
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
  /*
   * No AI on the job routes (see openJob): every way into that tab -- a
   * finished property line, "Find the lawn", a clear -- lands on Draw instead.
   */
  const asked = (name === 'detect' && document.body.classList.contains('job-mode')) ? 'draw' : name;
  const next = TABS.includes(asked) ? asked : 'address';
  state.tab = next;

  /*
   * Leaving a tab puts its map tools away.
   *
   * A mode whose button is no longer on screen is a mode you cannot get out
   * of: the map would still be routing every tap to the brush with nothing
   * visible saying so. Whether the mode belongs to the tab is the same
   * question the rail asks, so it is answered in one place.
   */
  /*
   * ...and arriving at a step puts ITS tool in hand (owner, 2026-09-30): the
   * boundary editor on the Property line step, the lawn tools on Draw. See
   * restMode. A tool whose step is locked is not usable either, even if it
   * belongs to the step you are arriving at -- see refreshRail.
   */
  const rest = restMode();
  if (state.mode && (!modeBelongsTo(state.mode, next) || tabLock(next))) setMode(rest);
  else if (!state.mode && rest) setMode(rest);

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
  // Merge buttons belong to the Property line step only (owner, 2026-09-30).
  // A frame later: setTab runs during start-up, before placeMergeButtons' own
  // state further down this file exists.
  requestAnimationFrame(() => placeMergeButtons());
  updatePromptHint();

  // Arriving at the drawing tools after a detection IS the handover, however
  // you got here -- the tab, the "correct it by hand" button, or a map tool.
  // A tip waiting for this tab queues behind it; see closeFeedback.
  if (next === 'draw' && askFeedback()) return;

  flushPendingTip();
  requestAnimationFrame(maybeToolTour);
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
const MODE_TAB = { parcel: 'address', pins: 'detect', move: 'draw', pan: 'draw', shape: 'draw' };
const modeBelongsTo = (mode, tab) => MODE_TAB[mode] === tab;

/*
 * THE TOOL A STEP HOLDS WHEN NOTHING ELSE IS IN HAND (owner, 2026-09-30).
 *
 * "Line" and "Lawn" were buttons, and each was the only tool of its step: the
 * Property line step is for editing the property line, the Draw step is for
 * editing the lawn. So pressing one was a chore on every visit, and not
 * pressing it was the commonest way to be stuck -- dragging at a corner that
 * would not move. The buttons are gone and the tools are simply on while you
 * are on their step. The Draw step's only other state is Move; pressing Move
 * again comes back here.
 *
 * Nothing while a drawing is open: Draw's polygon mode owns every tap then,
 * and a corner tool arming underneath it would take the next one.
 */
function restMode() {
  if (!state.frame || !map || !draw || drafting) return null;
  // Pan (owner, 2026-10-01): arriving on Draw changes nothing by accident.
  if (state.tab === 'draw') return 'pan';
  if (state.tab === 'address' && parcelRing() && !tabLock('address')) return 'parcel';
  return null;
}

/** Put down whatever is in hand, and pick up the step's own tool. */
const settleMode = () => setMode(restMode());

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
  // The note travels with the button: it is about what pressing it does.
  const finishNote = $('#finish-note');
  if (finishNote && finish) finishNote.hidden = finish.hidden;

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
const MODES = ['parcel', 'pins', 'move', 'pan', 'shape'];
/* The two with no button of their own: the boundary editor is simply on on the
   Property line step, and the lawn tools are reached through Points/Brushes. */
const BUTTONLESS_MODES = ['parcel', 'shape'];

function setMode(mode, tool = null) {
  // No tool while the line-up panel is open: it switches them off.
  const next = MODES.includes(mode) && !state.alignOpen ? mode : null;
  /* Any other tool ends not-lawn tracing, so the next lawn patch drawn is
     never swallowed into the not-lawn list. */
  if (state.notLawnMode) leaveNotLawnMode();

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
  // Remembered for the collapsed Brushes icon, which opens the one last used.
  if (state.shapeTool === 'add' || state.shapeTool === 'erase') {
    state.lastBrush = state.shapeTool;
  }
  /*
   * And the point eraser goes away on every mode change, for the reason the
   * comment above gives about brushes: a destructive tool inherited from
   * several steps ago deletes a corner somebody meant to select.
   */
  state.pointEraser = false;

  if (next === 'pan') {
    // Nothing armed: every drag pans and no shape can be touched.
    setHint('Drag to move around. Pick Points or Brushes to edit.');
  } else if (next === 'move') {
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
  requestAnimationFrame(maybeToolTour);
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
    /* On the Draw step this is the ordinary start of a hand-drawn lawn, not a
       mistake: the lawn tools are on by default there (restMode). */
    if (which === 'parcel') setStatus('No property line yet. Use "Draw the property line" to trace one.', 'warn');
    else setHint('No lawn yet: paint one in with the brushes, or press New shape');
    return;
  }

  state.edgeEdit = { ringId: null, edgeIndex: null, vertexIndex: null, baseRing: null };
  $('#edge-panel').hidden = false;
  // The two outlines share one panel, so whatever the last one left open has
  // to be shut -- the edge slider is a property-line control and must not be
  // sitting there from a previous visit when a lawn is being edited.
  $('#edge-controls').hidden = true;
  $('#point-controls').hidden = true;
  $('#edge-info').textContent = which === 'parcel'
    ? 'Tap a line to extend that edge out to the road, or a corner to move it.'
    : 'Tap a corner dot to move or delete it, or a hollow dot between two to add one.';
  $('#edge-info').className = 'edge-info';
  setHint(which === 'parcel'
    ? 'Tap a line to extend it, or a corner to move it'
    : 'Tap a corner to move it, or a hollow dot to add one');
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
 * a foot or two; correcting an exclusion is not. Measured at the test lot, the
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

  // Same bargain as the trees box: the number only means anything once the
  // shapes are redrawn, so it does not move unless they are.
  const was = state.edgeFt;
  state.edgeFt = next;
  if (state.lastMask?.layers?.length && !retrace('Changing how generous the edge is')) {
    state.edgeFt = was;
    setStatus('Left as it is — your hand corrections are untouched.');
  }
  refreshSensitivity();
}

/**
 * A pass whose mask covers this much of the property is not an answer.
 *
 * The documented failure of this model is a concept that floods the entire
 * frame: at the test lot the not-lawn prompt masked 100% of the parcel at three
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
function traceDetection({
  layers, subtractive, invert, rendered, edgeFt = 0, maxVertices = MAX_TRACE_VERTICES, fixedPolarity = false,
}) {
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
    maxVertices,
    growPx: Math.round((edgeFt * 0.3048) / mPerPx),
  };

  const unproject = (x, y) => framePxToLngLat(rendered, [x, y], w, h);

  if (!subtractive) {
    return {
      sqFtPerPx,
      collapsed: [],
      polygons: polygonsFromBinary(
        /* The trained model's mask is lawn = white however much of the frame
           that is; the guess that mostly-white means upside down is for SAM. */
        maskBinary(layers[0].image, { invert: Boolean(invert), ...(fixedPolarity ? { autoPolarity: false } : {}) }),
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

/**
 * ASK BEFORE REDRAWING OVER SOMEBODY'S CORRECTIONS.
 *
 * Every control that re-traces the mask -- the edge setting, "count grass
 * under trees" -- rebuilds all the shapes from the model's answer, which
 * throws away every corner moved, every shed rubbed out, every bit of the
 * work that is the whole reason a person is still on this screen. It was
 * silent, and a warning printed AFTERWARDS is not consent: the report was an
 * hour of editing gone to a switch that looked like a display option.
 *
 * Undo still puts it back. This exists so that nobody has to know that.
 *
 * Returns false when the caller must leave the map alone, so a checkbox can
 * put itself back rather than sit there claiming a setting it did not apply.
 */
function mayRedrawFromMask(what) {
  if (!state.handEdited) return true;
  return confirm(
    `${what} redraws the lawn from the AI's answer, and that would undo the `
    + 'corrections you have made by hand. Carry on?'
  );
}

/**
 * Re-trace the masks already in hand at the current edge setting.
 *
 * Returns true if the shapes were rebuilt, false if there was nothing to
 * rebuild from or the person declined to lose their corrections.
 */
function retrace(what = 'That') {
  const mask = state.lastMask;
  if (!mask?.layers?.length) return false;
  if (!mayRedrawFromMask(what)) return false;

  const { polygons } = traceDetection({
    layers: mask.layers,
    subtractive: mask.subtractive,
    invert: mask.invert,
    fixedPolarity: Boolean(mask.fixedPolarity),
    rendered: mask.traceFrame || mask.frame,
    maxVertices: mask.maxVertices || MAX_TRACE_VERTICES,
    // Feet on the ground -> pixels of this particular mask.
    edgeFt: state.edgeFt,
  });

  // A snapshot per change would bury the detection under a hundred steps of
  // slider, so the whole drag collapses into one undoable move.
  pushHistory('sensitivity');
  /*
   * The inferred layer survives this, because the slider re-traces the
   * DETECTOR'S mask and an inferred patch was never part of it. Somebody who
   * has marked the ground under a canopy and then nudges the edge should not
   * lose that work to a control that has nothing to do with it.
   *
   * A fresh detection is different and still replaces everything: that is an
   * explicit request for the AI's answer from scratch, and leaving purple
   * marks floating over a new outline would be worse than losing them.
   */
  const keptInferred = draw.getAll().features.filter(isInferred);
  draw.deleteAll();
  for (const f of keptInferred) draw.add(f);
  for (const geometry of polygons) draw.add({ type: 'Feature', properties: {}, geometry });

  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  describeEdgeShift();

  if (!polygons.length) {
    setStatus('Nothing left at this setting — slide back to the right.', 'warn');
    state.handEdited = false;
    return true;
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
  /*
   * And the shapes really are the model's own work again now, so the flag says
   * so. It is what "corrected by hand" means on a saved map and in the
   * training corpus, and leaving it set would mark a pure AI trace as a
   * correction -- a worse lie than the silence this replaced, because it would
   * travel into the training set rather than just onto the screen.
   */
  state.handEdited = false;
  setStatus(
    `${polygons.length} section${polygons.length > 1 ? 's' : ''} of lawn at this setting.`
    + (lost ? ' Your hand corrections were redrawn from the AI mask — Undo puts them back.' : ''),
    lost ? 'warn' : ''
  );
  return true;
}

/**
 * Turn a just-drawn polygon into the property line.
 *
 * Taken out of Draw entirely rather than left as a feature with a flag: the
 * boundary and the lawn are measured against each other, and a boundary that
 * is also one of the shapes being measured would count its own area.
 */
/**
 * Turn a just-drawn polygon into a hole in the lawn underneath it.
 *
 * WHY A HOLE RATHER THAN A SHAPE THAT SUBTRACTS. The measurement already
 * subtracts interior rings, the raster already fills them even-odd, and the
 * editor now selects them -- so a cut expressed as a hole is a cut every part
 * of this app already understands. A "negative shape" would be a second kind
 * of feature that every one of those places would have to learn about, and
 * would be wrong in whichever place got missed.
 *
 * WHY NOT THE BRUSH'S ROUND TRIP. The eraser rasterises, punches and re-traces,
 * which is the right answer for a freehand stroke and the wrong one here: the
 * corners of a shed are exactly where the person put them, and sending them
 * through a pixel grid would move every one of them. Inserting the ring keeps
 * them to the last decimal, which is also what makes the cut editable
 * afterwards -- the corners you tap are the corners you drew.
 *
 * It is punched into EVERY shape that contains it. Two shapes over the same
 * ground is something the add brush and "Use property line" can both produce,
 * and cutting the hole out of one of them would leave the other still counting
 * the shed -- with the total unchanged and nothing on screen to explain it.
 */
function cutHoleFromDrawn(feature) {
  const ring = feature && outerRing(feature);
  // Draw owns the outline until this point; taking it out first means a cut
  // that lands and a cut that misses both leave the map with one fewer shape
  // than the tracing did, rather than a stray square sitting on the lawn.
  if (feature?.id) draw.delete(feature.id);

  if (!ring || ring.length < 4) {
    setStatus('That outline was not closed. Trace right around the thing you want taken out.', 'warn');
    return;
  }

  /*
   * ON THE EDGE IS A NOTCH, NOT A HOLE. Cut out snaps to the lawn's edge, so a
   * cut traced at the boundary has corners on it -- a fraction of a pixel to
   * either side. Inside by a hair, a hole would leave a hairline of lawn
   * between it and the edge; outside by a hair, it used to be refused as
   * "hangs over the edge". Either way what was meant is the cut's area taken
   * out of the lawn (lib/cutout.js), so that is what happens.
   */
  const px = (ll) => { const q = map.project(ll); return [q.x, q.y]; };
  const cutPx = openRing(ring).map(px);
  const touchesEdge = (f) => {
    const rings = (f.geometry?.coordinates || []).map((r) => r.map(px));
    return cutPx.some((p) => (nearestOnRings(p, rings)?.dist ?? Infinity) < 1);
  };

  const hosts = draw.getAll().features.filter((f) => {
    const outer = outerRing(f);
    return outer && ringInsideRing(ring, outer);
  });

  if ((!hosts.length || hosts.some(touchesEdge)) && notchFromDrawn(ring)) return;

  if (!hosts.length) {
    /*
     * SAY WHICH OF THE TWO WAYS IT MISSED, because they need different
     * answers: a cut with no lawn under it is aimed at the wrong place, and a
     * cut hanging over the edge is the right idea in the wrong tool.
     */
    const overlaps = draw.getAll().features.some((f) => {
      const outer = outerRing(f);
      return outer && openRing(ring).some((p) => ringContains(outer, p));
    });
    setStatus(overlaps
      ? 'That cut hangs over the edge of the lawn. A cut-out has to sit inside one patch — '
        + 'for something on the boundary, use the Erase brush.'
      : 'There is no lawn under that. Trace around something inside a patch of lawn.', 'warn');
    return;
  }

  pushHistory();
  markHandEdited();
  for (const f of hosts) {
    f.geometry.coordinates = [...f.geometry.coordinates, ring.map((p) => [...p])];
    draw.add(f); // same id: this updates in place
  }

  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();

  const a = measure({ type: 'Polygon', coordinates: [ring] });
  setStatus(
    `Cut out ${Math.round(a.squareFeet).toLocaleString()} sq ft`
    + (hosts.length > 1 ? ` from ${hosts.length} overlapping shapes` : '')
    + '. Its corners are editable with Points, like any other.'
  );
}

/**
 * Take a cut that reaches the lawn's edge out of every shape it overlaps, as a
 * notch (see cutHoleFromDrawn and lib/cutout.js). A shape cut right through
 * becomes two; one covered entirely goes. Returns false when the cut touches
 * no lawn, so the caller can say why.
 */
function notchFromDrawn(ring) {
  const clip = window.polygonClipping;
  if (!clip) return false;
  const features = draw.getAll().features.filter((f) => f.geometry?.type === 'Polygon');
  const results = notchShapes(clip, features.map((f) => f.geometry.coordinates), ring);
  if (!results.some(Boolean)) return false;

  pushHistory();
  markHandEdited();
  const before = totalSquareFeet();
  features.forEach((f, i) => {
    const left = results[i];
    if (!left) return;
    if (!left.length) { draw.delete(f.id); return; }
    const [first, ...rest] = left;
    f.geometry = { type: 'Polygon', coordinates: first };
    draw.add(f); // same id: this updates in place
    for (const poly of rest) {
      draw.add({ type: 'Feature', properties: { ...(f.properties || {}) },
        geometry: { type: 'Polygon', coordinates: poly } });
    }
  });

  refreshMeasurement();
  refreshSurveyed();
  updateSelectionButtons();
  setStatus(`Cut out ${Math.round(Math.max(0, before - totalSquareFeet())).toLocaleString()} sq ft `
    + 'at the edge of the lawn. Its corners are editable with Points, like any other.');
  return true;
}

/**
 * A patch drawn over lawn that is already there becomes ONE shape with it.
 *
 * WHY THIS HAD TO EXIST. Drawing a patch was the only edit on the whole map
 * that ADDED a shape without taking one away -- everything else (the brush,
 * the clip, undo, a re-trace) empties the map and puts back what it worked
 * out. So a patch drawn on top of the detector's outline left both, and what
 * got saved was the two of them stacked. Which reads, in the corpus, as a lawn
 * with a piece of itself drawn twice, and reads on the review card as a mess
 * nobody can pick apart.
 *
 * WHAT IT DOES NOT FIX, and this matters more than what it does. If the
 * detector painted a driveway as grass and somebody drew a patch over the real
 * lawn beside it, merging the two makes one shape that STILL COVERS THE
 * DRIVEWAY. The union is the same ground either way; all that changes is how
 * many outlines it is written in. The only thing that takes the detector's
 * mistake off the map is erasing it -- the brush, a cut-out, or moving its
 * corners. This is tidying, not correcting, and it should not be mistaken for
 * the second.
 *
 * NOTHING HAPPENS WHEN NOTHING OVERLAPS, which is the common case: a patch for
 * the strip by the garage sits beside the lawn, not on it. Then the corners
 * are left exactly where they were put, to the last decimal. The round trip
 * through a pixel grid is only paid by the shapes that actually touch -- and
 * at the same resolution the detector's own outline was traced at, so a merge
 * with a detected shape costs it nothing it had not already lost.
 *
 * Returns how many existing shapes were swallowed. 0 means it stood alone.
 */
function mergeDrawnPatch(feature) {
  const ring = feature && outerRing(feature);
  if (!ring || ring.length < 4) return 0;

  const mine = geometryBounds(feature.geometry);
  /*
   * ONLY SHAPES OF THE SAME KIND. Merging an inferred patch into the lawn
   * underneath would either mark visible ground as guessed at or lose the
   * mark entirely, depending which shape won -- and it would happen the
   * instant somebody drew one, which is the normal way to use the tool.
   */
  const sameKind = isInferred(feature);
  const others = draw.getAll().features
    .filter((f) => f.id !== feature.id && outerRing(f) && isInferred(f) === sameKind);
  if (!mine || !others.length) return 0;

  /*
   * BOXES FIRST. Two shapes whose bounding boxes miss cannot overlap, and on a
   * map with several patches that is most pairs. Rasterising to find that out
   * would be a megabyte of work per shape to learn what four comparisons say.
   */
  const near = [];
  let [w, s, e, n] = mine;
  for (const f of others) {
    const b = geometryBounds(f.geometry);
    if (!b || b[2] < mine[0] || b[0] > mine[2] || b[3] < mine[1] || b[1] > mine[3]) continue;
    near.push(f);
    w = Math.min(w, b[0]); s = Math.min(s, b[1]);
    e = Math.max(e, b[2]); n = Math.max(n, b[3]);
  }
  if (!near.length) return 0;

  /*
   * A frame around ONLY the shapes in question. Spanning the whole map would
   * coarsen every pixel in it for the sake of one patch in a corner -- the
   * same fault the clip had, which cost about 3% of a lot that had nothing to
   * do with what was being changed.
   */
  const pad = 0.0002;
  const bbox = [w - pad, s - pad, e + pad, n + pad];
  const frame = {
    lng: (bbox[0] + bbox[2]) / 2,
    lat: (bbox[1] + bbox[3]) / 2,
    zoom: zoomToFit(bbox, ERASE_GRID / 2),
    size: ERASE_GRID / 2,
  };
  const project = (ll) => lngLatToFramePx(frame, ll, ERASE_GRID, ERASE_GRID);

  const patch = rasterizePolygon(feature.geometry.coordinates, ERASE_GRID, ERASE_GRID, project);
  const touching = [];
  const masks = [patch];
  for (const f of near) {
    const m = rasterizePolygon(f.geometry.coordinates, ERASE_GRID, ERASE_GRID, project);
    let hit = false;
    for (let i = 0; i < m.length; i++) if (m[i] && patch[i]) { hit = true; break; }
    if (!hit) continue;
    touching.push(f);
    masks.push(m);
  }
  /* Boxes that cross but shapes that do not. An L-shaped lawn does this. */
  if (!touching.length) return 0;

  const union = unionMasks(masks);
  const data = new Uint8ClampedArray(ERASE_GRID * ERASE_GRID * 4);
  for (let p = 0; p < union.length; p++) {
    const v = union[p] ? 255 : 0;
    data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v;
    data[p * 4 + 3] = 255;
  }

  const polygons = maskToPolygons(
    { width: ERASE_GRID, height: ERASE_GRID, data },
    (x, y) => framePxToLngLat(frame, [x, y], ERASE_GRID, ERASE_GRID),
    {
      tolerance: TRACE_TOLERANCE_M / metresPerPixel(frame, ERASE_GRID),
      maxVertices: MAX_TRACE_VERTICES,
      /*
       * Absolute floors, not fractions of the frame. A shed cut out of the
       * lawn has to survive this: the frame here is small, so a fraction-based
       * floor would be a few square feet and would swallow it.
       */
      ...editTraceLimits(ERASE_GRID, ERASE_GRID),
    }
  );
  /*
   * If the trace came back with nothing, leave the map alone. Two stacked
   * shapes are untidy; silently deleting the lawn is not a trade worth making
   * for tidiness.
   */
  if (!polygons.length) return 0;

  draw.delete(feature.id);
  for (const f of touching) draw.delete(f.id);
  for (const geometry of polygons) draw.add({ type: 'Feature', properties: {}, geometry });
  return touching.length;
}

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
    state.frame = parcelFrame(bbox, FRAME_SIZE, { marginM: FRAME_MARGIN_M });
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
  rail.hidden = !state.frame || onSaves || Boolean(state.alignOpen);

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
  /*
   * THE CHECKMARK, for a New shape or a Cut out with three points down (owner,
   * 2026-09-30): the fewest a shape can have. Tapping the first point again
   * still closes it, and was the only way -- which nobody guessed. Not for the
   * property line or not-lawn traces, which were not asked for.
   */
  const finish = $('#tool-finish');
  const finishing = Boolean(state.frame) && Boolean(drafting) && !state.drawingParcel
    && drafting.state.currentVertexPosition >= 3;
  const cancel = $('#tool-cancel');
  const placing = Boolean(state.frame) && precisePlacing();
  if (cancel) cancel.hidden = !placing;
  if (placing) anyTool = true;
  if (finish) {
    const was = !finish.hidden;
    finish.hidden = !finishing;
    if (finishing) anyTool = true;
    // Shown once, the first time it appears: what it does and what still works.
    if (finishing && !was && !tips.seen.has('finish')) requestAnimationFrame(() => showTip('finish'));
  }

  const undo = $('#rail-undo');
  const redoBtn = $('#rail-redo');
  if (undo) rail.hidden = rail.hidden || (!anyTool && undo.disabled && (!redoBtn || redoBtn.disabled));

  // "Done adjusting" means nothing where the editor is the step's own tool.
  const done = $('#btn-edge-done');
  if (done) done.hidden = Boolean(state.mode) && state.mode === restMode();

  // With Pan in hand the lawn tools stay one tap away (Points, Brushes).
  const panning = state.mode === 'pan';
  $('#shape-tools').hidden = state.mode !== 'shape' && !panning;
  for (const [id, tool] of [['#tool-points', 'points'], ['#tool-add', 'add'], ['#tool-erase', 'erase']]) {
    $(id)?.setAttribute('aria-pressed',
      String(state.mode === 'shape' && state.shapeTool === tool));
  }

  /*
   * THE RAIL TRADES ONE SET FOR THE OTHER.
   *
   * Correcting corners and painting with a brush are two jobs, and the rail is
   * drawn over the map rather than beside it -- so every button belonging to
   * the job you are NOT doing is covering the lawn you are working on.
   *
   * With Points live, Add and Erase fold into a single Brushes icon: neither
   * is reachable from a corner, and one way back is all that is needed. With a
   * brush live the pair comes back, because THEN switching between them is
   * exactly what you want, and the corner tools go away instead.
   */
  const onPoints = state.mode === 'shape' && state.shapeTool === 'points';
  const brushLive = state.mode === 'shape' && state.shapeTool !== 'points';
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };

  show('#tool-brushes', onPoints || panning);
  show('#tool-add', brushLive);
  show('#tool-erase', brushLive);

  /* The corner tools appear with Points, and only with it. */
  const pointTools = $('#point-tools');
  if (pointTools) pointTools.hidden = !onPoints;

  /*
   * Delete-the-last-corner is dead until there IS one. A one-shot that does
   * nothing when pressed is indistinguishable from a broken button, and this
   * one sits next to a mode toggle that always works.
   */
  refreshDeletePoint();
  $('#tool-handles')?.setAttribute('aria-pressed', String(Boolean(state.handlesOn)));
  $('#tool-unpoint')?.setAttribute('aria-pressed', String(Boolean(state.pointEraser)));

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
  const notLawnTools = $('#not-lawn-tools');
  if (notLawnTools) notLawnTools.hidden = !state.dev;
  if (!state.dev && state.notLawnMode) setNotLawnMode(false);
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
    /*
     * No arrow: the boundary editor is simply on while you are on this step
     * (restMode), so there is no button left to point at. The owner's words,
     * 2026-09-30 -- including leaving out "you can come back and do that at
     * any time", because the line should be right BEFORE the AI traces.
     */
    return parcelRing()
      ? {
          target: null,
          title: 'First: check your property line',
          text: 'The dashed outline is your lot, from the county record (when '
              + 'available). Only grass inside it gets measured — so if your '
              + 'lawn runs past it to the road, manually drag the points out OR '
              + 'select the line and slide the line using the slider tool in the '
              + 'drawer. Make sure the property line is correct before continuing.',
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

  return { target: null, title: '', text: '' }; // the tours below cover the rest
}

/*
 * THE TOURS: every button in a group at once, each with its own arrow (owner,
 * 2026-09-30). The Draw step's rail is a dozen unlabelled icons, and a first
 * visit ended with people not knowing the brushes existed. Words are the
 * owner's.
 *
 *   tools    the first time the Draw step's rail appears
 *   points   the first time the point tools do (straight after `tools`)
 *   brushes  the first time a brush is picked up
 *   finish   the third point of a New shape or Cut out
 *
 * `panel` rather than `target` for the one card that points into the drawer:
 * a coach tip cannot reach the panel (markup.test.js), a tour can.
 */
const TOURS = {
  /*
   * GOOGLE AND NAIP ARE FOR LOOKING (owner, 2026-10-01). Shown the first time
   * either is opened in a session, and again from the save check if the
   * line-up panel was never opened. Shapes are kept against Mapbox, which is
   * what the detector learns from, so a photo that sits off it moves every
   * corner traced on it by the same amount.
   */
  imagery: [
    { target: '#naip-align .naipalign-open', name: 'Line it up',
      text: 'This photo can sit a little off. If it does, open this and nudge it until it lines up '
        + 'with Mapbox. Auto tries for you, and the slider fades between the two.' },
    { target: '#btn-layers', name: 'Mapbox is what gets saved',
      text: 'Your shapes are saved on the Mapbox photo, and that is what goes to the lawn detector. '
        + 'Trace on this one if it is clearer, but line it up first, then switch back to Mapbox to '
        + 'check the shapes sit right.' },
  ],
  tools: [
    { target: '#mode-pan', name: 'Pan', text: 'Move around the map without changing any shapes. Where the Draw step starts.' },
    { target: '#mode-move', name: 'Move', text: 'Drag whole lawn shapes.' },
    { target: '#tool-points', name: 'Points',
      text: 'Manually add, remove, and drag points of the lawn outline (slow but precise).' },
    { target: '#tool-brushes', name: 'Brushes',
      text: 'Add or remove lawn areas with a brush (fast but imprecise). Great on mobile devices.' },
    { panel: '#pane-draw', name: 'The drawer',
      text: 'Some of the same tools, and more, are also in the drawer.' },
  ],
  points: [
    { target: '#tool-delpoint', name: 'Delete point', text: 'Delete the selected point.' },
    { target: '#tool-unpoint', name: 'Point eraser', text: 'Tap/click to delete points.' },
    { target: '#tool-newpatch', name: 'New shape',
      text: 'Manually place points to create a new lawn shape from scratch.' },
    { target: '#tool-cutout', name: 'Cut out',
      text: 'The inverse of the new shape tool. Place points to create a shape that '
          + 'removes that part of the map from an existing lawn shape. Useful for sheds, '
          + 'playsets, and anything that’s not grass and is in the middle of a lawn.' },
  ],
  brushes: [
    { target: '#tool-erase', name: 'Erase', text: 'Draw to erase from the lawn shape.' },
    { target: '#tool-add', name: 'Add',
      text: 'Draw to add to existing lawn shapes, create new shapes, or merge shapes.' },
    { target: '#brush-sizes', name: 'Fine and Bulk', text: 'Change the size of the brushes.' },
  ],
  finish: [
    { target: '#tool-finish', name: 'Finish',
      text: 'Hit the checkmark to finish placing new points. You can still move the '
          + 'placed points or create new points by tapping/clicking the middle of an '
          + 'existing line, while in point mode.' },
  ],
};

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
  if (TOURS[stage]) { showTour(stage); return; }
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
  $('#tour').hidden = true;
  tour.stage = null;
  placeMergeButtons(); // the room the tip took is free again
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
  // The merge buttons keep out from under the tip, wherever it lands.
  requestAnimationFrame(() => placeMergeButtons());
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

/* ------------------------------------------------------------ the tours */
/*
 * Several cards at once, one per button, each with an arrow to it: see TOURS.
 *
 * Shares the tips' switch, seen-set and single pending slot, so "Show me tips
 * as I go" governs all of it and a tour whose buttons are a tab away waits
 * for that tab exactly as a tip does.
 */
const tour = { stage: null, placed: [], stepping: false, index: 0, total: 0 };

function showTour(stage, { force = false } = {}) {
  if (!force && (!tipsOn() || tips.seen.has(stage))) return;
  if (!state.frame) return;
  /* Not on the paid queue: the job bar carries that page's instructions, and
     a dimmed window between a tracer and the lawn they are paid to trace is
     in the way on every lawn after the first. */
  if (document.body.classList.contains('job-mode')) return;
  const first = $(TOURS[stage][0].target);
  if (!first || first.offsetParent === null) { pendingTip = stage; return; }
  // A modal question goes first, and the tour follows it (closeFeedback).
  if (!$('#feedback').hidden) { pendingTip = stage; return; }
  pendingTip = null;

  hideTip(); // one box at a time, and the tour is the more useful one here
  tips.seen.add(stage);
  tips.stage = stage;
  tour.stage = stage;
  tour.stepping = false;
  tour.index = 0;
  $('#tour').hidden = false;
  placeTour();
}

/**
 * The next tour the Draw step owes, if any: the rail itself first, then the
 * set of tools in hand. Run a frame late, so a modal question opened in the
 * same breath (askFeedback) is already up and goes first.
 */
function maybeToolTour() {
  if (state.tab !== 'draw' || tour.stage) return;
  if (!tips.seen.has('tools')) { showTip('tools'); return; }
  if (state.mode !== 'shape') return;
  showTip(state.shapeTool === 'points' ? 'points' : 'brushes');
}

/**
 * Cards in one column to the left of the rail, each as near its button's
 * height as the ones above it allow; the drawer's card under them. Arrows run
 * from the card's nearest edge to the button's, so a card pushed below its
 * button comes in from underneath rather than across its neighbour.
 */
function placeTour() {
  const box = $('#tour');
  if (box.hidden || !tour.stage) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clip = (r) => {
    const c = {
      left: Math.max(r.left, 0), right: Math.min(r.right, vw),
      top: Math.max(r.top, 0), bottom: Math.min(r.bottom, vh),
    };
    return c.right - c.left > 8 && c.bottom - c.top > 8 ? c : null;
  };

  const items = [];
  for (const it of TOURS[tour.stage]) {
    const el = $(it.target || it.panel);
    if (!el || el.offsetParent === null) continue;
    // The drawer can be mostly scrolled away; aim at the part on screen.
    const r = it.panel
      ? clip(el.getBoundingClientRect()) || clip($('#panel').getBoundingClientRect())
      : el.getBoundingClientRect();
    if (r) items.push({ ...it, r: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
  }
  tour.total = items.length;
  if (tour.stepping) {
    tour.index = Math.min(tour.index, items.length - 1);
    items.splice(0, items.length, ...items.slice(tour.index, tour.index + 1));
  }

  const onRail = items.filter((it) => it.target);
  /* Cards beside the buttons, on whichever side has the room: left of the
     rail (the tool tours), right of the Layers column (the imagery tour). */
  const leftSide = onRail.length && onRail.every((it) => (it.r.left + it.r.right) / 2 < vw / 2);
  let width;
  let left;
  if (leftSide) {
    left = Math.max(...onRail.map((it) => it.r.right)) + 26;
    width = Math.max(140, Math.min(232, vw - left - 10));
    left = Math.min(left, vw - width - 8);
  } else {
    const colRight = (onRail.length ? Math.min(...onRail.map((it) => it.r.left)) : vw) - 26;
    width = Math.max(140, Math.min(232, colRight - 10));
    left = Math.max(8, colRight - width);
  }

  const cards = $('#tour-cards');
  cards.textContent = '';
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'tour-card';
    card.style.width = `${width}px`;
    card.style.left = `${left}px`;
    const name = document.createElement('b');
    name.textContent = it.name;
    card.append(name, document.createTextNode(it.text));
    cards.append(card);
    it.card = card;
  }

  const GAP = 8;
  const OK_H = 40;
  let y = GAP;
  const mid = (r) => (r.top + r.bottom) / 2;
  const order = [...onRail].sort((a, b) => (mid(a.r) - mid(b.r)) || (a.r.left - b.r.left));
  for (const it of order) {
    const h = it.card.offsetHeight;
    it.y = Math.max(mid(it.r) - h / 2, y);
    y = it.y + h + GAP;
  }
  /*
   * The drawer's card: under the others on a phone, where the drawer is the
   * bottom of the screen; beside the panel on a wide screen, where it is the
   * left-hand column, so the arrow is short rather than a line across the map.
   */
  for (const it of items.filter((i) => i.panel)) {
    const beside = it.r.right < left - 40;
    if (beside) {
      it.card.style.left = `${Math.round(it.r.right + 30)}px`;
      it.y = Math.max(GAP, Math.min(vh - it.card.offsetHeight - GAP,
        (it.r.top + it.r.bottom) / 2 - it.card.offsetHeight / 2));
    } else {
      it.y = y + 6;
      y = it.y + it.card.offsetHeight + GAP;
    }
  }
  // Too tall for the window: slide the column up, never off the top.
  const over = y + OK_H + GAP - vh;
  if (over > 0 && items.length) {
    const shift = Math.min(over, Math.min(...items.map((it) => it.y)) - GAP);
    for (const it of items) it.y -= shift;
    y -= shift;
  }
  for (const it of items) it.card.style.top = `${it.y}px`;

  /*
   * NUMBERED WHEN TWO BUTTONS SHARE A ROW. The point tools sit two to a row,
   * and two arrows into one row start side by side -- which card meant which
   * button was a guess. A number on the card and the same number on the
   * button settles it; where every button has a row of its own the arrows
   * already do, and numbers would be noise.
   */
  const shareRow = onRail.some((a) => onRail.some((b) => a !== b
    && a.r.top < b.r.bottom && b.r.top < a.r.bottom));
  if (shareRow) {
    [...items].sort((a, b) => a.y - b.y).forEach((it, k) => {
      it.num = k + 1;
      const badge = document.createElement('span');
      badge.className = 'tour-num';
      badge.textContent = String(it.num);
      it.card.querySelector('b').prepend(badge);
    });
  }

  const ok = $('#tour-ok');
  ok.style.top = `${Math.max(GAP, Math.min(y, vh - OK_H - GAP))}px`;
  ok.style.left = `${Math.max(GAP, left + width - ok.offsetWidth)}px`;

  /* The picture: the window dimmed, a hole and a ring round each button, and
     an arrow from each card. Only numbers go into this markup. */
  const near = (r, px, py) => [Math.min(Math.max(px, r.left), r.right), Math.min(Math.max(py, r.top), r.bottom)];
  const n = (v) => Math.round(v * 10) / 10;
  const PAD = 4;
  let holes = '';
  let rings = '';
  let arrows = '';
  tour.placed = [];
  const cardRects = items.map((it) => it.card.getBoundingClientRect());
  /* Does the segment a-b pass through rectangle r (Liang-Barsky)? */
  const crosses = (a, b, r) => {
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const edges = [[-dx, a[0] - r.left], [dx, r.right - a[0]], [-dy, a[1] - r.top], [dy, r.bottom - a[1]]];
    for (const [pp, q] of edges) {
      if (pp === 0) { if (q < 0) return false; continue; }
      const t = q / pp;
      if (pp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
    return t1 - t0 > 0.02;
  };
  const shrink = (r, by) => ({ left: r.left + by, right: r.right - by, top: r.top + by, bottom: r.bottom - by });
  for (const [k, it] of items.entries()) {
    const c = cardRects[k];
    /*
     * The straight line to the nearest point can run through a neighbouring
     * button -- two point tools share a row -- or through another card. Try
     * the nearest point first, then the target's corners and edge middles,
     * and take the shortest that crosses nothing else.
     */
    const others = [
      ...items.filter((o, j) => j !== k && o.target).map((o) => shrink(o.r, 2)),
      ...cardRects.filter((_, j) => j !== k).map((r) => shrink(r, 2)),
    ];
    const r0 = it.r;
    const cx = (c.left + c.right) / 2;
    const cy = (c.top + c.bottom) / 2;
    const candidates = [
      near(r0, cx, cy),
      [(r0.left + r0.right) / 2, r0.top], [(r0.left + r0.right) / 2, r0.bottom],
      [r0.left, r0.top], [r0.left, r0.bottom], [r0.right, r0.top], [r0.right, r0.bottom],
    ];
    let best = null;
    for (const e of candidates) {
      const a = near(c, e[0], e[1]);
      if (others.some((o) => crosses(a, e, o))) continue;
      const d = Math.hypot(e[0] - a[0], e[1] - a[1]);
      if (!best || d < best.d - 12) best = { e, d };
    }
    if (!best) it.tangled = true;
    let end = best ? best.e : candidates[0];
    /*
     * On a phone the drawer is the lower half of the screen and the column of
     * cards runs down into it, so the drawer's card can land ON the drawer
     * and "the nearest point" is the card itself. Point straight down into it
     * instead.
     */
    if (it.panel && end[0] >= c.left && end[0] <= c.right && end[1] >= c.top && end[1] <= c.bottom) {
      end = [(c.left + c.right) / 2, Math.min(vh - 10, Math.max(c.bottom + 46, it.r.top + 24))];
    }
    const start = near(c, end[0], end[1]);
    const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (it.target) {
      const [x, yy, w, h] = [it.r.left - PAD, it.r.top - PAD, it.r.right - it.r.left + 2 * PAD, it.r.bottom - it.r.top + 2 * PAD];
      holes += `<rect x="${n(x)}" y="${n(yy)}" width="${n(w)}" height="${n(h)}" rx="12" fill="#000"/>`;
      rings += `<rect x="${n(x)}" y="${n(yy)}" width="${n(w)}" height="${n(h)}" rx="12" fill="none" stroke="#fff" stroke-width="2"/>`;
      if (it.num) {
        rings += `<circle cx="${n(x + 3)}" cy="${n(yy + 3)}" r="9" fill="#2e7d32" stroke="#fff" stroke-width="1.5"/>`
          + `<text x="${n(x + 3)}" y="${n(yy + 3)}" fill="#fff" font-size="11" font-weight="700" `
          + `text-anchor="middle" dominant-baseline="central" font-family="inherit">${it.num}</text>`;
      }
    }
    if (len > 10) {
      // Stop just short of the edge, so the head sits on the ring, not in it.
      const k = (len - PAD - 2) / len;
      end = [start[0] + (end[0] - start[0]) * k, start[1] + (end[1] - start[1]) * k];
      arrows += `<line x1="${n(start[0])}" y1="${n(start[1])}" x2="${n(end[0])}" y2="${n(end[1])}" `
        + 'stroke="#fff" stroke-width="2.2" stroke-linecap="round" marker-end="url(#tour-head)"/>';
    }
    it.seg = len > 10 ? [start, end] : null;
    tour.placed.push({
      name: it.name,
      target: it.target || it.panel,
      arrow: len > 10 ? { x: end[0], y: end[1] } : null,
      rect: it.r,
      card: { left: c.left, right: c.right, top: c.top, bottom: c.bottom },
    });
  }
  /*
   * ONE AT A TIME WHEN THE ARROWS WOULD TANGLE. The point tools sit two to a
   * row in a block much shorter than their five cards, so on a phone the
   * arrows fan in across each other and the numbers are all that says which
   * is which. Then the tour steps instead -- one card, one arrow, "Next".
   */
  if (!tour.stepping && items.length > 1) {
    const cross = (p1, p2, p3, p4) => {
      const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      return d(p1, p2, p3) * d(p1, p2, p4) < 0 && d(p3, p4, p1) * d(p3, p4, p2) < 0;
    };
    const segs = items.map((it) => it.seg).filter(Boolean);
    const tangled = items.some((it) => it.tangled)
      || segs.some((a, i) => segs.some((b, j) => j > i && cross(a[0], a[1], b[0], b[1])));
    if (tangled) {
      tour.stepping = true;
      tour.index = 0;
      placeTour();
      return;
    }
  }
  ok.textContent = tour.stepping && tour.index < tour.total - 1
    ? `Next · ${tour.index + 1} of ${tour.total}`
    : 'Got it';
  ok.style.left = `${Math.max(GAP, left + width - ok.offsetWidth)}px`;

  $('#tour-lines').innerHTML = `
    <defs>
      <mask id="tour-mask"><rect width="100%" height="100%" fill="#fff"/>${holes}</mask>
      <marker id="tour-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7"
              orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#fff"/></marker>
    </defs>
    <rect width="100%" height="100%" fill="rgb(10,20,14)" fill-opacity=".55" mask="url(#tour-mask)"/>
    ${rings}${arrows}`;
}

/* Kept as the names the rest of the file already calls. */
const exitEdgeMode = () => settleMode();

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
    return parcel ? [{ ringId: ringKey(PARCEL_ID), ring: parcel }] : [];
  }

  if (state.mode === 'shape' && state.shapeTool === 'points') {
    /* Not-lawn traces too (tinker mode): their corners are fixed with the same
       tool as the lawn's, though they never count toward it. */
    const notLawn = state.notLawn.flatMap((g, i) => (g?.type === 'Polygon' ? g.coordinates : [])
      .map((ring, j) => ({ ringId: ringKey(notLawnId(i), j), ring }))
      .filter((r) => Array.isArray(r.ring) && r.ring.length >= 4));
    /*
     * EVERY RING, HOLES INCLUDED. A shed cut out of a lawn is a hole, and a
     * hole whose corners cannot be tapped is a cut you can make once and never
     * adjust -- which was the state of it: this read coordinates[0] and the
     * inner rings were invisible to the whole editor.
     */
    return draw.getAll().features.flatMap((f) => {
      const rings = f.geometry?.type === 'Polygon' ? f.geometry.coordinates : [];
      return rings
        .map((ring, i) => ({ ringId: ringKey(f.id, i), ring }))
        .filter((r) => Array.isArray(r.ring) && r.ring.length >= 4);
    }).concat(notLawn);
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
const VERTEX_GRAB_PX = 20;
/*
 * RAISED FROM 16, and the paragraph above is the reason it stayed at 16 for so
 * long: every pixel given to corners is taken from edges, because a tap near a
 * corner is also a tap near the two edges meeting there.
 *
 * Twenty is a compromise and not a solution. Sixteen was measurably too tight
 * on a phone -- a fingertip is about forty pixels across, so aiming at a
 * thirty-two pixel target means missing, and missing here selects an edge you
 * did not want. Twenty-eight or forty would fix the miss and would quietly
 * make sliding an edge the hard thing, which is the operation that preserves
 * a surveyed bearing and the one worth protecting.
 *
 * The real fix is a separate target that belongs to the corner alone, so
 * corners and edges stop competing for the same pixels. Until that exists this
 * number is the least-bad place to stand.
 */

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

  /* Same precedence as a drag: the handle is the unambiguous target. */
  const viaHandle = handleAt(tap.x, tap.y);
  if (viaHandle) {
    if (state.pointEraser) return removeVertexAt(viaHandle.ringId, viaHandle.index);
    return selectVertex({
      ringId: viaHandle.ringId,
      ring: ringOf(viaHandle.ringId) || viaHandle.ring,
      index: viaHandle.index,
    });
  }

  let corner = null;

  for (const { ringId, ring } of handleRings()) {
    const hit = nearestVertex(ring, lngLat);
    if (!hit) continue;
    const at = map.project(openRing(ring)[hit.index]);
    const px = Math.hypot(at.x - tap.x, at.y - tap.y);
    if (px <= VERTEX_GRAB_PX && (!corner || px < corner.px)) {
      corner = { ringId, ring, index: hit.index, px };
    }
  }

  if (corner) {
    /*
     * CORNERS ONLY. The eraser deliberately does not fall through to the
     * phantom midpoints or to edges below -- those two CREATE a corner and
     * select an edge, so a miss with a delete tool armed would add geometry
     * rather than remove it, which is the most surprising thing it could do.
     * A miss does nothing and says so.
     */
    if (state.pointEraser) return removeVertexAt(corner.ringId, corner.index);
    return selectVertex(corner);
  }
  if (state.pointEraser) {
    setStatus('Nothing there to remove. Tap a corner dot itself.', 'warn');
    return;
  }

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
  if (phantom) return addPointAt(phantom.ringId, phantom.edgeIndex, phantom.at);

  /*
   * EDGES BELONG TO THE PROPERTY LINE ONLY.
   *
   * Sliding an edge keeps a surveyed bearing exactly, which is the whole
   * reason it exists and is genuinely the right tool on a boundary the county
   * recorded. A lawn edge has no bearing worth preserving -- where the mowing
   * stops is not a surveyed line -- so on a lawn the tool did nothing useful
   * and cost a great deal: every corner tap that missed by a few pixels
   * grabbed the edge instead, and the two share the same pixels by geometry
   * (distance to a segment goes to zero at its endpoints). Taking edges out of
   * lawn editing hands those pixels back to the corners, which is the thing
   * being aimed at here.
   */
  if (state.mode !== 'parcel') {
    setStatus('Tap a corner dot to move it, or a hollow dot between two to add one.');
    return;
  }

  selectEdgeNear(lngLat);
}

/** Find the edge nearest a tap, across every shape, and select it. */
function selectEdgeNear(lngLat) {
  let best = null;

  const consider = (ring, ringId) => {
    if (!ring) return;
    const hit = nearestEdge(ring, lngLat);
    if (hit && (!best || hit.distanceM < best.distanceM)) {
      best = { ...hit, ringId, ring };
    }
  };

  for (const { ringId, ring } of editableRings()) consider(ring, ringId);

  if (!best || best.distanceM > 40) {
    $('#edge-info').textContent = 'No edge near there — tap closer to a boundary line.';
    return;
  }

  state.edgeEdit = {
    // Where the tap landed, so "Add a point" knows where to put one.
    tapAt: [lngLat[0], lngLat[1]],
    ringId: best.ringId,
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
    (isParcelRing(best.ringId) ? 'Property line' : 'Lawn edge') +
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
function selectVertex({ ringId, ring, index }) {
  state.edgeEdit = {
    ringId,
    vertexIndex: index,
    edgeIndex: null,
    baseRing: ring.map((p) => [...p]),
  };

  $('#edge-controls').hidden = true;
  $('#point-controls').hidden = false;
  const hint = $('#point-hint');
  if (hint) {
    hint.textContent = isParcelRing(ringId)
      ? 'Drag it to move it. To extend a whole edge instead, tap the line between two corners.'
      : 'Drag it to move it. Tap a hollow dot to add a corner there.';
  }
  $('#edge-info').textContent =
    `Corner ${index + 1} of ${openRing(ring).length} on your ` +
    ringLabel(ringId) +
    ' — drag it to move it.';
  $('#edge-info').className = 'edge-info active';

  /*
   * Three points are a polygon; two are nothing. Say so on the button rather
   * than letting the press fail -- except on a cut-out, where the press at
   * three corners removes the cut instead of failing, so the button stays
   * live and says what it is about to do.
   */
  const hole = isHoleRing(ringId);
  const last = openRing(ring).length <= 3;
  $('#btn-point-delete').disabled = last && !hole;
  $('#btn-point-delete').textContent = (hole && last)
    ? 'Remove this cut-out'
    : 'Delete this corner';

  setHint('Drag this corner, or delete it');
  clearEdgeHighlight();
  drawPoints();
}

/* ------------------------------------------------------------ ring ids */
/**
 * WHAT THE EDITOR SELECTS IS A RING, NOT A SHAPE.
 *
 * A polygon is an outline plus any number of holes, and a shed cut out of a
 * lawn is a hole. Everything here used to be keyed by the shape's id alone and
 * read coordinates[0], so the corners of a hole were not merely hard to tap --
 * they did not exist as far as the editor was concerned. They were drawn by
 * nothing, hit-tested by nothing, and a shed traced into a lawn could never be
 * adjusted afterwards.
 *
 * One opaque string rather than a pair of fields, because the identity is
 * compared in a dozen places -- "is this the corner that is selected", "is
 * this handle's ring still the one being dragged" -- and every one of those
 * comparisons stays a single ===. A pair would be a dozen chances to compare
 * half of it.
 *
 * The separator is a '#'. Draw's own ids are UUIDs and the property line's is
 * `__parcel__`, so none of them contains one -- and the split takes the LAST
 * separator anyway, so an id that did would still decode correctly.
 */
const RING_SEP = '#';
const ringKey = (featureId, ringIndex = 0) => `${featureId}${RING_SEP}${ringIndex}`;

/** The shape and the ring within it that a ring id names. */
function ringOwner(ringId) {
  const at = String(ringId).lastIndexOf(RING_SEP);
  if (at < 0) return { featureId: String(ringId), ringIndex: 0 };
  return {
    featureId: String(ringId).slice(0, at),
    ringIndex: Number(String(ringId).slice(at + RING_SEP.length)) || 0,
  };
}

/** Whether a ring id names a hole rather than an outline. */
const isHoleRing = (ringId) => ringOwner(ringId).ringIndex > 0;

/** Whether a ring id names the property line. */
const isParcelRing = (ringId) => ringOwner(ringId).featureId === PARCEL_ID;

/*
 * Not-lawn traces are not Draw features (state.notLawn), so like the property
 * line they get a made-up feature id: the prefix and their place in the list.
 */
const NOT_LAWN_PREFIX = '__notlawn__';
const notLawnId = (i) => `${NOT_LAWN_PREFIX}${i}`;
const notLawnIndex = (featureId) => (String(featureId).startsWith(NOT_LAWN_PREFIX)
  ? Number(String(featureId).slice(NOT_LAWN_PREFIX.length)) : null);
const isNotLawnRing = (ringId) => notLawnIndex(ringOwner(ringId).featureId) !== null;

/** Does editing this ring change the lawn? Not the boundary, not a not-lawn trace. */
const editsLawn = (ringId) => state.mode === 'shape' && !isNotLawnRing(ringId);

/** What to call this ring in a sentence aimed at the person editing it. */
const ringLabel = (ringId) => (isParcelRing(ringId)
  ? 'property line'
  : isNotLawnRing(ringId) ? 'not-lawn outline'
    : isHoleRing(ringId) ? 'cut-out' : 'lawn outline');

/** The ring a ring id names, read fresh. */
function ringOf(ringId) {
  const { featureId, ringIndex } = ringOwner(ringId);
  if (featureId === PARCEL_ID) return ringIndex === 0 ? parcelRing() : null;
  const nl = notLawnIndex(featureId);
  if (nl !== null) return state.notLawn[nl]?.coordinates?.[ringIndex] || null;
  const rings = draw.get(featureId)?.geometry?.coordinates;
  return Array.isArray(rings) ? rings[ringIndex] || null : null;
}

/** Write a ring back to whichever shape and ring it came from. */
function writeRing(ringId, ring) {
  const { featureId, ringIndex } = ringOwner(ringId);
  if (featureId === PARCEL_ID) {
    if (ringIndex !== 0) return false;
    setParcelRing(ring);
    return true;
  }
  const nl = notLawnIndex(featureId);
  if (nl !== null) {
    const g = state.notLawn[nl];
    if (!g?.coordinates?.[ringIndex]) return false;
    state.notLawn[nl] = { ...g, coordinates: g.coordinates.map((r, i) => (i === ringIndex ? ring : r)) };
    refreshNotLawn();
    return true;
  }
  const feature = draw.get(featureId);
  const rings = feature?.geometry?.coordinates;
  if (!Array.isArray(rings) || !rings[ringIndex]) return false;
  feature.geometry.coordinates = rings.map((r, i) => (i === ringIndex ? ring : r));
  draw.add(feature); // same id: this updates in place
  return true;
}

/**
 * Drop a whole ring. Only ever a hole -- deleting an outline would delete the
 * shape, which is what "Delete selected" is for and is a different decision.
 */
function dropRing(ringId) {
  const { featureId, ringIndex } = ringOwner(ringId);
  if (featureId === PARCEL_ID || ringIndex === 0 || notLawnIndex(featureId) !== null) return false;
  const feature = draw.get(featureId);
  const rings = feature?.geometry?.coordinates;
  if (!Array.isArray(rings) || !rings[ringIndex]) return false;
  feature.geometry.coordinates = rings.filter((_, i) => i !== ringIndex);
  draw.add(feature);
  return true;
}

/** Move the selected corner. Called continuously during a drag. */
/**
 * THE PROPERTY LINE HOLDS A CORNER IN, and that is what the option says.
 *
 * "Measure outside the property line" gated the Add brush and nothing else, so
 * a corner dragged past the boundary went past it and the square footage went
 * up -- the option switched off, the line drawn on the map, and the total
 * counting ground beyond it anyway. An option that governs one of the two ways
 * to reach the same mistake is worse than none, because it reads as a promise.
 *
 * HELD AT THE LINE RATHER THAN REFUSED. A corner that stops dead under a
 * moving finger reads as a bug, and one that snaps back loses the drag. The
 * nearest point on the boundary is where the finger is, as near as the
 * boundary allows, so the corner slides along the line -- which is also the
 * shape somebody dragging out to the kerb is trying to draw.
 *
 * The boundary's OWN corners are never held: they are the thing that defines
 * where outside is, and a boundary that could not be extended to the kerb is
 * the problem the edge slider exists for.
 */
/**
 * The outlines of the ordinary lawn -- what an inferred patch is held inside.
 *
 * The rings of every shape NOT marked inferred, which is the closest thing to
 * "the lawn" that exists on the map. Empty when there is no ordinary lawn yet,
 * and an empty list holds nothing: being unable to draw an inferred patch on a
 * blank map would be a worse rule than letting one go where it likes.
 */
function seenLawnRings() {
  const out = [];
  for (const f of draw.getAll().features) {
    if (isInferred(f)) continue;
    const rings = f.geometry?.type === 'Polygon' ? f.geometry.coordinates : null;
    if (rings?.length) out.push(rings[0]);
  }
  return out;
}

/**
 * Hold a corner of an inferred patch inside the lawn.
 *
 * Deliberately the same shape as heldInsideParcel below, including the part
 * that matters most: held AT the edge rather than refused. A corner that stops
 * dead under a moving finger reads as a bug and one that snaps back loses the
 * drag, so it slides along the lawn's edge instead -- which is the shape
 * somebody tracing the boundary of a canopy is trying to draw anyway.
 *
 * Inside ANY ordinary shape counts as inside. A lawn is often several
 * disconnected pieces, and requiring one particular piece would hold a corner
 * at the edge of a shape it has nothing to do with.
 */
/**
 * Is the corner tool currently working on an inferred patch?
 *
 * Asked of the SHAPE rather than of the mode. Somebody who turned inferred
 * drawing on and then reached over to fix a corner of the ordinary lawn is
 * editing the lawn, and a rule about keeping patches inside it would be
 * holding that lawn inside itself.
 */
function editingInferred() {
  const id = state.edgeEdit?.ringId;
  if (!id || isParcelRing(id)) return false;
  const { featureId } = ringOwner(id);
  return isInferred(draw.getAll().features.find((f) => String(f.id) === featureId));
}

function heldInsideLawn(lngLat) {
  if (!state.inferredInside) return lngLat;
  return heldInsideRings(seenLawnRings(), lngLat);
}

/**
 * Trim a freshly drawn inferred patch to the lawn under it.
 *
 * ONLY FOR A SHAPE JUST CREATED. The round trip through a pixel grid moves
 * every vertex a little, which is ruinous on an outline somebody has already
 * corrected -- that is the whole subject of lib/stitch.js. A brand new trace
 * has no hand-placed corners to lose, so here it costs nothing.
 *
 * Replaces the drawn feature with its clipped pieces, because a patch drawn
 * across two separate lawn shapes really is two patches and pretending
 * otherwise would put ground between them into the total.
 */
function holdShapeInsideLawn(feature) {
  const rings = seenLawnRings();
  const own = feature?.geometry?.coordinates;
  if (!rings.length || !own?.length) return;

  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lng, lat] of own[0]) {
    w = Math.min(w, lng); e = Math.max(e, lng);
    s = Math.min(s, lat); n = Math.max(n, lat);
  }
  const pad = 0.0002;
  const bbox = [w - pad, s - pad, e + pad, n + pad];
  const frame = {
    lng: (bbox[0] + bbox[2]) / 2,
    lat: (bbox[1] + bbox[3]) / 2,
    zoom: zoomToFit(bbox, ERASE_GRID / 2),
    size: ERASE_GRID / 2,
  };
  const project = (ll) => lngLatToFramePx(frame, ll, ERASE_GRID, ERASE_GRID);

  const mine = rasterizePolygon(own, ERASE_GRID, ERASE_GRID, project);
  const lawn = new Uint8Array(ERASE_GRID * ERASE_GRID);
  for (const ring of rings) {
    const m = rasterizePolygon([ring], ERASE_GRID, ERASE_GRID, project);
    for (let i = 0; i < m.length; i++) if (m[i]) lawn[i] = 1;
  }

  let kept = 0;
  const data = new Uint8ClampedArray(ERASE_GRID * ERASE_GRID * 4);
  for (let i = 0; i < mine.length; i++) {
    const on = mine[i] && lawn[i];
    if (on) kept++;
    const v = on ? 255 : 0;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }

  /* Entirely outside: the patch goes, and says so. Silently deleting what
     somebody just drew would read as the tool having failed to register it. */
  if (!kept) {
    draw.delete(feature.id);
    setStatus('That patch was entirely outside the lawn, so nothing was added. '
      + 'Untick "Keep inferred patches inside the lawn" to draw past it.', 'warn');
    return;
  }

  const polygons = maskToPolygons(
    { width: ERASE_GRID, height: ERASE_GRID, data },
    (x, y) => framePxToLngLat(frame, [x, y], ERASE_GRID, ERASE_GRID),
    {
      tolerance: TRACE_TOLERANCE_M / metresPerPixel(frame, ERASE_GRID),
      maxVertices: MAX_TRACE_VERTICES,
      ...editHoleLimit(ERASE_GRID, ERASE_GRID),
    }
  );
  if (!polygons.length) return;

  draw.delete(feature.id);
  for (const geometry of polygons) {
    draw.add({ type: 'Feature', properties: { inferred: true }, geometry });
  }
  setStatus('Trimmed to the lawn underneath.');
}

function heldInsideParcel(lngLat) {
  if (state.measureOutside) return lngLat;
  if (state.mode !== 'shape') return lngLat;

  const parcel = parcelRing();
  if (!parcel || ringContains(parcel, lngLat)) return lngLat;

  const near = nearestPointOnRing(parcel, lngLat);
  return near ? near.at : lngLat;
}

function moveSelectedVertex(lngLat) {
  const edit = state.edgeEdit;
  if (!edit || edit.vertexIndex == null) return;

  const ring = ringOf(edit.ringId);
  if (!ring) return;

  /*
   * TWO HOLDS, OUTER FIRST. The property line binds every corner on the map;
   * the lawn binds a corner of an inferred patch and only while the sub-toggle
   * is on. Applying the parcel's first means a patch can never be held onto a
   * lawn edge that is itself outside the boundary.
   *
   * Which shape is being dragged decides whether the second applies at all --
   * not which mode the map happens to be in. Somebody who switched the mode on
   * and then dragged a corner of the ORDINARY lawn is editing the lawn, and
   * holding that inside itself is meaningless.
   */
  /* A not-lawn trace is held by nothing: a road is outside the boundary. */
  let at = isNotLawnRing(edit.ringId) ? lngLat : heldInsideParcel(lngLat);
  let heldBy = at !== lngLat ? 'parcel' : null;
  if (!heldBy && editingInferred()) {
    const held = heldInsideLawn(at);
    if (held !== at) { at = held; heldBy = 'lawn'; }
  }
  if (heldBy === 'parcel') {
    setHint('Held at the property line — switch on “Measure outside the property line” to go past it.');
  } else if (heldBy === 'lawn') {
    setHint('Held at the edge of the lawn — untick “Keep inferred patches inside the lawn” to go past it.');
  }

  // A corner of the LAWN is a hand correction; a corner of the property line
  // is not -- the lock exists to protect work the AI would overwrite, and the
  // AI does not draw boundaries.
  if (editsLawn(edit.ringId)) markHandEdited();
  writeRing(edit.ringId, moveVertex(ring, edit.vertexIndex, at));
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
function addPointAt(ringId, edgeIndex, at) {
  const ring = ringOf(ringId);
  if (!ring) return;

  pushHistory();
  if (editsLawn(ringId)) markHandEdited();
  const grown = insertVertex(ring, edgeIndex, at);
  if (!writeRing(ringId, grown)) return;

  // Select it straight away: adding a point is nearly always the first half of
  // moving it somewhere.
  selectVertex({ ringId, ring: grown, index: edgeIndex + 1 });
  setStatus('Corner added. Drag it where you want it.');
  refreshMeasurement();
  refreshSurveyed();
}

function addPointOnEdge() {
  const edit = state.edgeEdit;
  if (!edit || edit.edgeIndex == null || !edit.tapAt) return;
  addPointAt(edit.ringId, edit.edgeIndex, edit.tapAt);
}

/** Remove the selected corner. */
function deleteSelectedVertex() {
  const edit = state.edgeEdit;
  if (!edit || edit.vertexIndex == null) return;
  removeVertexAt(edit.ringId, edit.vertexIndex);
}

/**
 * Remove one corner, named rather than selected.
 *
 * Split out of deleteSelectedVertex so the point eraser can delete what was
 * tapped without first selecting it -- selecting and then deleting would put
 * a corner in the panel for the instant before it ceased to exist, and would
 * leave the panel describing a corner that is gone if the delete is refused.
 */
function removeVertexAt(ringId, index) {
  const ring = ringOf(ringId);
  if (!ring || index == null) return;

  const shrunk = deleteVertex(ring, index);

  /*
   * A CUT-OUT AT THREE CORNERS IS REMOVED, NOT REFUSED.
   *
   * Three points is the floor for any ring, and for an outline the only
   * sensible answer is to stop -- deleting the fourth would leave a shape with
   * no shape, and throwing away somebody's lawn is what "Delete selected" is
   * for. A hole is different: taking the last corner off it means "I did not
   * want this cut", which is a thing to do rather than an error to report, and
   * refusing left the only way to undo a cut being undo itself.
   */
  if (!shrunk) {
    if (isHoleRing(ringId)) {
      pushHistory();
      markHandEdited();
      dropRing(ringId);
      state.edgeEdit = { ringId: null, vertexIndex: null, edgeIndex: null, baseRing: null };
      $('#point-controls').hidden = true;
      $('#edge-info').textContent = 'Cut-out removed — that ground counts as lawn again.';
      $('#edge-info').className = 'edge-info';
      drawPoints();
      refreshMeasurement();
      refreshSurveyed();
      return;
    }
    setStatus('That shape is down to three corners — deleting another would leave no shape at all.', 'warn');
    return;
  }

  pushHistory();
  if (editsLawn(ringId)) markHandEdited();
  writeRing(ringId, shrunk);
  state.edgeEdit = { ringId: null, vertexIndex: null, edgeIndex: null, baseRing: null };
  $('#point-controls').hidden = true;
  $('#edge-info').textContent = state.pointEraser
    ? 'Point removed. Tap another to remove it, or press Point eraser again to stop.'
    : state.mode === 'parcel'
      ? 'Corner deleted. Tap another corner or edge.'
      : 'Corner deleted. Tap another corner.';
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

  /*
   * WORKED OUT FIRST, WRITTEN SECOND, so that a press which changes nothing
   * leaves no undo step behind.
   *
   * This used to push history before knowing whether it had anything to do.
   * Harmless while the boundary always arrived untidy -- and now it arrives
   * tidy, so the ordinary press is the one that finds nothing, and every one
   * of those left a dead entry on the stack. Pressing undo afterwards did
   * nothing at all, which is precisely the failure this file warns about a
   * few hundred lines down: "undo that quietly does nothing is the classic
   * way this feature ships broken".
   */
  const plan = [];
  for (const { ringId, ring } of editableRings()) {
    before += openRing(ring).length;
    const tidied = tidyRing(ring);
    if (tidied.removed) {
      plan.push({ ringId, ring: tidied.ring });
      removed += tidied.removed;
    }
  }

  if (!removed) {
    /*
     * SAID WHERE THE BUTTON IS, not only in the status line.
     *
     * Success writes to #edge-info, which is the panel the button sits in and
     * the thing somebody who just pressed it is looking at; "nothing to do"
     * went to the status line alone. That was survivable while nothing-to-do
     * was the rare outcome. Now the boundary arrives tidy, so it is the
     * ORDINARY outcome -- and the ordinary outcome was landing where nobody
     * was looking, under whatever the last edit happened to say.
     */
    const nothing = 'Nothing to tidy — every corner on this boundary is doing something.';
    setStatus(nothing);
    $('#edge-info').textContent = nothing;
    $('#edge-info').className = 'edge-info';
    return;
  }

  pushHistory();
  for (const { ringId, ring } of plan) writeRing(ringId, ring);

  // The selection indexes into a ring that just changed shape, so it no longer
  // means what it meant. Drop it rather than let it point at another corner.
  state.edgeEdit = { ringId: null, edgeIndex: null, vertexIndex: null, baseRing: null };
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
 * The outlines whose corners can be grabbed.
 *
 * EVERY OUTLINE THIS MODE CAN EDIT, which must stay the same set drawPoints
 * draws -- a dot you can see and cannot tap is indistinguishable from a dead
 * tool.
 *
 * It used to be the selected shape alone, and that is the point eraser bug:
 * deleting a corner clears the selection, so the tap after a successful delete
 * was tested against an empty list and answered "nothing there to remove"
 * while the dots were still on screen. The first delete worked, every one
 * after it failed, and nothing on the map had changed to explain why.
 *
 * The wall-of-dots worry the old restriction answered is handled where it
 * belongs: drawPoints decides what is drawn, and handles are planned only for
 * corners on screen and suppressed entirely when they cannot be placed clear
 * of each other.
 */
function handleRings() {
  return editableRings();
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
  for (const { ringId, ring } of editableRings()) {
    const verts = openRing(ring);
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const pa = map.project(a);
      const pb = map.project(b);
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < MIDPOINT_MIN_PX) continue;
      out.push({
        ringId,
        edgeIndex: i,
        at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      });
    }
  }
  return out;
}

/**
 * Delete-the-last-corner is dead until there IS one.
 *
 * A one-shot that does nothing when pressed is indistinguishable from a broken
 * button, and this one sits beside a mode toggle that always works. Called
 * from drawPoints rather than only from refreshRail, because what it depends
 * on is the SELECTION -- which changes on every tap and every drag, neither of
 * which touches the rail.
 */
function refreshDeletePoint() {
  const del = $('#tool-delpoint');
  if (!del) return;
  const edit = state.edgeEdit;
  del.disabled = !(edit?.ringId && edit.vertexIndex != null);
}

function drawPoints() {
  refreshDeletePoint();
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
  for (const { ringId, ring } of editableRings()) {
    openRing(ring).forEach((p, i) => {
      features.push({
        type: 'Feature',
        properties: {
          phantom: 0,
          selected: ringId === edit.ringId && i === edit.vertexIndex ? 1 : 0,
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
  drawHandles();
}

/*
 * State for the handles, kept out of `state` because none of it is the user's
 * work -- it is a cache of where dots currently are, rebuilt whenever the map
 * moves, and restoring it would mean restoring pixel positions from a
 * different screen.
 */
let handlePlan = [];
let handlesCrowded = false;

/**
 * Work out where every corner's handle goes, and draw them.
 *
 * SCREEN SPACE, RECOMPUTED ON MOVE. Whether two handles collide depends on
 * zoom, so this is not something that can be solved once and stored with the
 * shape -- the same lawn at z17 and z20 needs entirely different answers.
 *
 * NOT ON EVERY FRAME. Mapbox fires `move` continuously through a pan, and
 * re-planning a few hundred corners per frame is how a map starts to stutter
 * on a phone. Handles are cleared when a gesture starts and re-planned when it
 * settles; during the gesture the corners themselves are still there and still
 * grabbable, so nothing is lost but the stalks.
 */
function drawHandles() {
  const source = map.getSource('point-handles');
  if (!source) return;

  if (!state.edgeEdit || !state.handlesOn) {
    handlePlan = [];
    handlesCrowded = false;
    return source.setData(empty());
  }

  /*
   * MID-DRAG, NOTHING IS RE-PLANNED.
   *
   * moveSelectedVertex redraws on every pointer frame, so planning here would
   * solve a few hundred corners per frame -- and worse, the handle under the
   * finger would jump to a new direction as the corner moved, which is the one
   * thing a handle must never do.
   *
   * Each handle keeps the offset it was placed at, so carrying it is an
   * addition. The corner being dragged takes its handle with it; the others
   * are unchanged because their corners are. The map is held still during a
   * drag, so the screen positions stay meaningful throughout.
   */
  if (drag?.moved && handlePlan.length) return redrawHandlePlan(source);

  /*
   * Only what is on screen, with a margin so a handle just outside the edge
   * still counts as an obstacle for one just inside it. Off-screen corners
   * cannot be tapped and cannot collide with anything visible.
   */
  const canvas = map.getCanvas();
  const pad = HANDLE_REACH_PX * 2;
  const onScreen = (q) => q.x >= -pad && q.y >= -pad
    && q.x <= canvas.clientWidth + pad && q.y <= canvas.clientHeight + pad;

  const meta = [];
  const rings = [];
  for (const { ringId, ring } of editableRings()) {
    const open = openRing(ring);
    const projected = open.map((p) => {
      const q = map.project(p);
      return { x: q.x, y: q.y };
    });
    if (!projected.some(onScreen)) continue;
    meta.push({ ringId, ring, open });
    rings.push(projected);
  }

  const { handles, crowded } = planHandles(rings);
  handlesCrowded = crowded;

  /*
   * SILENT ABSENCE READS AS A BUG. At a zoom where hundreds of corners are on
   * screen they are a few pixels apart and no handle can be placed clear of
   * anything -- which is correct, and indistinguishable from the feature being
   * broken unless it is said. The corners themselves are still there and still
   * grabbable meanwhile, so this is a nudge rather than a blockage.
   */
  if (crowded) setHint('Zoom in for corner handles — too many corners to place them here.');
  else if ($('#map-hint')?.textContent.startsWith('Zoom in for corner handles')) setHint('');

  const edit = state.edgeEdit;
  const features = [];
  handlePlan = [];

  for (const h of handles) {
    const owner = meta[h.ring];
    if (!owner) continue;
    /* A handle for a corner scrolled off screen is arithmetic nobody can use. */
    if (!onScreen(h.at)) continue;

    const selected = owner.ringId === edit.ringId && h.index === edit.vertexIndex ? 1 : 0;
    const at = map.unproject([h.at.x, h.at.y]);
    const from = owner.open[h.index];

    handlePlan.push({
      ringId: owner.ringId,
      ring: owner.ring,
      index: h.index,
      at: { x: h.at.x, y: h.at.y },
      /* The offset, so a corner being dragged can carry its handle along
         without any of this being solved again. See the drag branch below. */
      dx: h.at.x - h.from.x,
      dy: h.at.y - h.from.y,
    });
    features.push({
      type: 'Feature',
      properties: { selected },
      geometry: { type: 'LineString', coordinates: [from, [at.lng, at.lat]] },
    });
    features.push({
      type: 'Feature',
      properties: { selected },
      geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
    });
  }

  source.setData({ type: 'FeatureCollection', features });
}

/**
 * Re-emit the handles already planned, following their corners.
 *
 * No geometry is solved: each handle sits at its corner plus the offset chosen
 * when it was placed, so this is one projection and one addition per handle.
 */
function redrawHandlePlan(source) {
  const edit = state.edgeEdit;
  const features = [];

  for (const h of handlePlan) {
    /*
     * LOOKED UP FRESH, never the ring captured when this was planned.
     *
     * moveVertex returns a NEW ring rather than editing one, so the array this
     * plan was built from is stale the instant a corner moves -- and a stale
     * ring here would anchor every leader to where its corner used to be while
     * the corner slid away from it. Which is the exact frame this branch
     * exists to draw.
     */
    const live = ringOf(h.ringId) || h.ring;
    const from = openRing(live)[h.index];
    if (!from) continue;
    const q = map.project(from);
    h.at = { x: q.x + h.dx, y: q.y + h.dy };
    const at = map.unproject([h.at.x, h.at.y]);
    const selected = h.ringId === edit?.ringId && h.index === edit?.vertexIndex ? 1 : 0;

    features.push({
      type: 'Feature',
      properties: { selected },
      geometry: { type: 'LineString', coordinates: [from, [at.lng, at.lat]] },
    });
    features.push({
      type: 'Feature',
      properties: { selected },
      geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
    });
  }

  source.setData({ type: 'FeatureCollection', features });
}

/**
 * Which corner a tap on a handle belongs to, or null.
 *
 * Generous, because a handle exists precisely so that a fingertip has
 * somewhere unambiguous to land: nothing else is within the clearance by
 * construction, so a wide catchment cannot steal a tap from anything.
 */
const HANDLE_GRAB_PX = 24;
function handleAt(x, y) {
  let found = null;
  for (const h of handlePlan) {
    const d = Math.hypot(h.at.x - x, h.at.y - y);
    if (d <= HANDLE_GRAB_PX && (!found || d < found.d)) found = { ...h, d };
  }
  return found;
}

function clearPoints() {
  map.getSource('points')?.setData(empty());
  map.getSource('point-handles')?.setData(empty());
  handlePlan = [];
  handlesCrowded = false;
}

function applyEdgeOffset(feet) {
  const edit = state.edgeEdit;
  if (!edit?.baseRing) return;

  // The slider is absolute, so every event re-derives the shape from baseRing.
  // One entry for the whole drag, keyed on the edge being moved.
  pushHistory(`offset:${edit.ringId}:${edit.edgeIndex}`);

  // One writer for every ring, so sliding an edge cannot disagree with
  // dragging a corner about which ring it is writing to.
  writeRing(edit.ringId, offsetEdge(edit.baseRing, edit.edgeIndex, feetToMetres(feet)));

  $('#edge-value').textContent = `${feet > 0 ? '+' : ''}${feet} ft`;
  drawEdgeHighlight();
  refreshMeasurement();
  refreshSurveyed();
}

/* ------------------------------------------- neighbours, merge, the road */
/*
 * ON FOR EVERYBODY since 2026-09-30 (tinker mode only from 2026-09-27 until
 * the owner had tried it); off on the paid tracing queue.
 *
 * The parcels around this one come from the county's own layer
 * (/api/parcel/neighbours). They are drawn as thin dashed lines, and each one
 * that shares a line with this parcel gets a "Merge this parcel" button a
 * little way inside it, for somebody who owns two lots and mows both.
 *
 * Then the front edges go out to the road: public/lib/frontage.js decides
 * which edges are frontage and where the pavement is, from the road
 * centrelines already in the map's own street data, and refuses any move that
 * would run over a neighbour. It is one undo step, and it says what it did.
 */
const neighbourState = { all: [], markers: [] };

function clearNeighbours() {
  for (const m of neighbourState.markers) m.remove();
  neighbourState.markers = [];
  neighbourState.all = [];
  if (map?.getSource('neighbours')) map.getSource('neighbours').setData(empty());
  $('#btn-parcel-road') && ($('#btn-parcel-road').hidden = true);
}

function outerRingsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((p) => p[0]);
  return [];
}

/** A neighbour already inside the parcel (merged, or the parcel itself). */
function neighbourAbsorbed(ring) {
  const pr = parcelRing();
  if (!pr) return false;
  const pts = openRing(ring);
  const inside = pts.filter((p) => ringContains(pr, p) || nearestPointOnRing(pr, p)?.distanceM < 0.5).length;
  return inside >= pts.length * 0.8;
}

function refreshNeighbours() {
  if (!map) return;
  if (!map.getSource('neighbours')) {
    map.on('move', placeMergeButtons);
    map.addSource('neighbours', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'neighbours', type: 'line', source: 'neighbours',
      paint: { 'line-color': '#ffffff', 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 2] },
    }, map.getLayer('parcel-line') ? 'parcel-line' : undefined);
  }
  for (const m of neighbourState.markers) m.remove();
  neighbourState.markers = [];
  const live = neighbourState.all.filter((nb) => !neighbourAbsorbed(nb.ring));
  map.getSource('neighbours').setData({
    type: 'FeatureCollection',
    features: live.map((nb) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [nb.ring] } })),
  });
  const pr = parcelRing();
  if (!pr) return;
  for (const nb of live) {
    const at = mergeButtonPoint(pr, nb.ring);
    if (!at) continue;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'merge-parcel';
    el.textContent = 'Merge this parcel';
    /*
     * A TAP HERE IS THE BUTTON'S, NOT THE MAP'S. The map's own touch
     * listeners capture on its container, which holds the marker, so they see
     * this touch first; they now step aside for anything inside a marker
     * (see onMarker). And the merge runs on the touch itself as well as on
     * click, once, so a browser that never turns the touch into a click
     * still merges.
     */
    let fired = 0;
    const go = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - fired < 600) return;
      fired = Date.now();
      mergeNeighbour(nb, el);
    };
    el.addEventListener('touchend', go, { passive: false });
    el.addEventListener('click', go);
    const marker = new mapboxgl.Marker({ element: el }).setLngLat(at).addTo(map);
    neighbourState.markers.push(marker);
    marker.lmPlace = { nb, pref: at, el };
  }
  placeMergeButtons();
}

/** A pointer event that landed on a marker (the merge buttons): not the map's. */
const onMarker = (e) => Boolean(e?.target?.closest?.('.mapboxgl-marker'));

/*
 * WHOLE, INSIDE ITS PARCEL, OR NOT SHOWN (the owner, 2026-09-27). The button
 * is placed in SCREEN pixels, because how much of a parcel it covers depends
 * on the zoom: the nearest spot to the 20 ft point where the whole button
 * fits inside the neighbour, re-checked whenever the map moves. Too little
 * room for "Merge this parcel" tries "Merge"; too little for that, hidden.
 */
let placeQueued = false;
function placeMergeButtons() {
  if (placeQueued) return;
  placeQueued = true;
  requestAnimationFrame(() => {
    placeQueued = false;
    /*
     * ON THE PROPERTY LINE STEP ONLY (owner, 2026-09-30). Merging is a
     * boundary decision, so the buttons show where the boundary is being
     * decided and nowhere else; the dashed neighbour lines stay on every step,
     * as context.
     */
    const onBoundaryStep = state.tab === 'address' && !tabLock('address');
    for (const m of neighbourState.markers) {
      const { nb, pref, el } = m.lmPlace || {};
      if (!el) continue;
      if (!onBoundaryStep) { el.style.display = 'none'; continue; }
      const poly = nb.ring.map((ll) => { const p = map.project(ll); return [p.x, p.y]; });
      const want = map.project(pref);
      // Whatever floats over the map right now, in the map's own pixels.
      const box = map.getContainer().getBoundingClientRect();
      const avoid = ['#coach', '#maprail', '#maprail-left', '#layer-list', '#edge-panel', '#map-hint', '#naip-align']
        .map((sel) => $(sel))
        .filter((node) => node && !node.hidden && node.offsetParent !== null)
        .map((node) => node.getBoundingClientRect())
        .filter((r) => r.width && r.height)
        .map((r) => [r.left - box.left, r.top - box.top, r.right - box.left, r.bottom - box.top]);
      let spot = null;
      const tried = [];
      for (const label of ['Merge this parcel', 'Merge']) {
        el.textContent = label;
        el.style.visibility = 'hidden';
        el.style.display = '';
        tried.push([label, el.offsetWidth, el.offsetHeight]);
        spot = placeInside(poly, [want.x, want.y], el.offsetWidth, el.offsetHeight, { avoid });
        if (spot) break;
      }
      // For the browser test: what it measured and where it looked.
      const xs = poly.map((q) => q[0]);
      const ys = poly.map((q) => q[1]);
      m.lmDiag = {
        tried, pref: [Math.round(want.x), Math.round(want.y)],
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round),
        verts: poly.length, spot: spot && spot.map(Math.round),
      };
      /* Only a spot inside the map is a spot: off its edge the button is
         for ground nobody can see, and where the map's stylesheet has not
         loaded nothing clips it, so it lands on the panel instead. */
      if (spot && (spot[0] < 0 || spot[1] < 0 || spot[0] > box.width || spot[1] > box.height)) spot = null;
      if (spot) {
        m.setLngLat(map.unproject(spot));
        el.style.visibility = '';
      } else {
        el.style.display = 'none';
      }
    }
  });
}

function mergeNeighbour(nb, el = null) {
  const pr = parcelRing();
  const merged = pr && window.polygonClipping ? mergeRings(window.polygonClipping, pr, nb.ring) : null;
  if (!merged) {
    setStatus('Those two parcels do not join into one outline, so they cannot be merged.', 'warn');
    // Said on the button too: the status line can be off screen on a phone.
    if (el) {
      el.textContent = 'Can\'t merge';
      setTimeout(() => placeMergeButtons(), 2000);
    }
    return;
  }
  pushHistory();
  setParcelRing(merged);
  state.parcel.properties.merged = [...(state.parcel.properties.merged || []), nb.pin ?? null];
  // The neighbour's corners are the county's too.
  state.surveyed = [...(state.surveyed || []), ...openRing(nb.ring).map((p) => [...p])];
  refreshSurveyed();
  refreshMeasurement();
  refreshNeighbours();
  setStatus(`Merged — the property line is now ${measure(state.parcel.geometry).acres} acres. Undo takes it back apart.`);
}

/** Road centrelines near the parcel, from the map's own street data. */
async function roadsNearParcel() {
  const src = map.getSource('composite') ? 'composite' : null;
  if (!src) return [];
  // The tiles for where the map is now; give them a moment to arrive.
  for (let t = 0; t < 30 && !map.isSourceLoaded(src); t++) await new Promise((r) => setTimeout(r, 200));
  const bbox = geometryBounds(state.parcel);
  const pad = 0.0008;
  const inBox = ([x, y]) => x > bbox[0] - pad && x < bbox[2] + pad && y > bbox[1] - pad && y < bbox[3] + pad;
  const roads = [];
  for (const f of map.querySourceFeatures(src, { sourceLayer: 'road' })) {
    if (f.properties?.structure === 'tunnel') continue;
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const coords of lines) {
      if (coords.some(inBox)) roads.push({ cls: f.properties?.class, coords });
    }
  }
  return roads;
}

async function extendParcelToRoad({ quiet = false } = {}) {
  const pr = parcelRing();
  if (!pr || !window.polygonClipping) return;
  const roads = await roadsNearParcel();
  const neighbours = neighbourState.all.filter((nb) => !neighbourAbsorbed(nb.ring)).map((nb) => nb.ring);
  const r = extendToRoads(pr, roads, { neighbours, clip: window.polygonClipping });
  if (!r.moved.length) {
    if (!quiet) {
      const why = r.skipped.length ? ` (${r.skipped.map((k) => k.reason).join('; ')})` : '';
      setStatus(`No front edge to move out to the road${why}.`);
    }
    return;
  }
  pushHistory();
  setParcelRing(r.ring);
  refreshSurveyed();
  refreshNeighbours();
  const skipped = r.skipped.length ? ` Left alone: ${r.skipped.map((k) => k.reason).join('; ')}.` : '';
  setStatus(`Moved ${r.moved.length} front edge${r.moved.length === 1 ? '' : 's'} out to the road. `
    + `Undo puts ${r.moved.length === 1 ? 'it' : 'them'} back, or adjust with Property line.${skipped}`);
}

async function aroundParcel() {
  const parcel = state.parcel;
  const key = parcel?.properties?.countyKey;
  const bbox = geometryBounds(parcel);
  if (!key || !bbox) return;
  const pad = 0.0004;
  const q = new URLSearchParams({ county: key, bbox: [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad].join(',') });
  try {
    const data = await api(`/api/parcel/neighbours?${q}`);
    if (state.parcel !== parcel) return; // a different address since
    const own = parcelRing();
    neighbourState.all = (data.features || []).flatMap((f) => outerRingsOf(f.geometry).map((ring) => ({ ring, pin: f.properties?.pin ?? null })))
      .filter((nb) => !(nb.pin && nb.pin === parcel.properties?.pin))
      .filter((nb) => !(own && neighbourAbsorbed(nb.ring)));
  } catch {
    neighbourState.all = [];
  }
  refreshNeighbours();
  if ($('#btn-parcel-road')) $('#btn-parcel-road').hidden = false;
  // After the fly-in, so the street tiles for this place are the ones loaded.
  await new Promise((resolve) => (map.isMoving() ? map.once('moveend', resolve) : resolve()));
  if (state.parcel === parcel) await extendParcelToRoad({ quiet: true });
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
/**
 * Put a ring into the parcel's geometry and do nothing else about it.
 *
 * Split out for the moment the parcel arrives, which tidies it before anything
 * has been drawn or framed. Everything setParcelRing does afterwards -- redraw,
 * re-frame, refetch the photograph -- that path is about to do for itself, and
 * doing it twice means fetching an aerial photograph of a frame that is
 * replaced a millisecond later.
 */
function setParcelRingQuietly(ring) {
  const g = state.parcel.geometry;
  if (g.type === 'Polygon') g.coordinates = [ring, ...g.coordinates.slice(1)];
  else if (g.type === 'MultiPolygon') g.coordinates[0] = [ring, ...g.coordinates[0].slice(1)];
}

function setParcelRing(ring) {
  setParcelRingQuietly(ring);

  map.getSource('parcel').setData(state.parcel);

  const bbox = geometryBounds(state.parcel);
  if (bbox) {
    state.frame = parcelFrame(bbox, FRAME_SIZE, { marginM: FRAME_MARGIN_M });
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
  return edit?.ringId ? ringOf(edit.ringId) : null;
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
  /*
   * SELECTED BY GEOMETRY TYPE, the way geometryAreaSqM selects.
   *
   * This duck-typed `coordinates` instead -- any non-empty array counted as a
   * polygon -- and a LineString's coordinates are a non-empty array whose
   * members are NUMBERS, not [lng, lat] pairs. The bbox loop below then
   * destructures a number and throws. The browser suite reported it as
   * "PAGEERROR: .for is not iterable", which is V8's way of naming a failed
   * destructuring pattern rather than the expression being iterated -- an
   * uncatchable-looking message that named no file until the suite started
   * printing stacks.
   *
   * measure() never had this problem: geometryAreaSqM answers 0 for anything
   * that is not a Polygon or a MultiPolygon, so the two halves of this
   * function disagreed about what counts as a shape. They agree now.
   *
   * MultiPolygon is SPLIT into its parts rather than passed through whole. Its
   * coordinates nest one level deeper, so `rings[0]` was a whole polygon where
   * the loop below wants an outer ring -- no throw, just a silently wrong
   * bounding box, which is the worse of the two failures.
   */
  const usable = polygonRings(fc);
  if (usable.length < 2) return { ...plain, overlapSqFt: 0 };

  /*
   * Bounding boxes first, because they are nearly free and almost always
   * settle it. Detection hands back disconnected components and most lawns are
   * one or two of them, so the raster below usually never runs at all.
   */
  const boxes = usable.map((rings) => {
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
    usable, OVERLAP_GRID, OVERLAP_GRID,
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

  /* The point tool, on by default on the Draw step, found nothing to edit
     when it came on over an empty map. Now there is a lawn, arm it -- there
     is no Lawn button left to press to do that by hand. */
  if (hasShapes && state.mode === 'shape' && state.shapeTool === 'points' && !state.edgeEdit) {
    queueMicrotask(() => {
      if (state.mode === 'shape' && state.shapeTool === 'points' && !state.edgeEdit && hasLawn()) {
        enterRingEditing('shape');
      }
    });
  }

  /* Every path that changes the shapes ends up here, which makes it the one
     place the inferred overlay can be repainted without hunting for callers. */
  refreshInferred();

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

/** Is this drawn feature marked as inferred rather than seen? */
/*
 * A declaration rather than a const, so it is available to callers that run
 * before this line is reached. `user_inferred` is the same flag seen through
 * Mapbox Draw, which prefixes properties it is given; both spellings mean one
 * thing and a reader should not have to know which path a feature arrived by.
 */
function isInferred(f) {
  return Boolean(f?.properties?.inferred || f?.properties?.user_inferred);
}

/**
 * Repaint the inferred overlay from whatever Draw currently holds.
 *
 * Read from Draw rather than kept in a parallel list, because a second copy of
 * which-shapes-are-inferred is a second thing to keep in step, and the one
 * that drifts is always the one nobody is looking at.
 */
function refreshInferred() {
  if (!map || !map.getSource('inferred')) return;
  let features = [];
  try {
    features = draw.getAll().features.filter(isInferred);
  } catch {
    features = [];
  }
  map.getSource('inferred').setData({ type: 'FeatureCollection', features });
}

/*
 * THE OPEN TRACE IN THE NOT-LAWN COLOUR. Draw paints every outline being drawn
 * the same way, so a not-lawn trace looked exactly like a lawn patch until it
 * closed -- and nobody could tell which one they were making. Draw's own
 * "active" layers are recoloured red for as long as the mode is on, and put
 * back exactly as they were after.
 */
const draftPaintSaved = new Map();
function paintNotLawnDraft(on) {
  if (!map || !map.getStyle) return;
  let layers = [];
  try { layers = map.getStyle().layers || []; } catch { return; }
  for (const layer of layers) {
    if (!layer.id.startsWith('gl-draw-') || !/-active/.test(layer.id) || /inactive/.test(layer.id)) continue;
    const prop = layer.type === 'fill' ? 'fill-color'
      : layer.type === 'line' ? 'line-color'
        : layer.type === 'circle' ? 'circle-color' : null;
    if (!prop) continue;
    const key = `${layer.id}|${prop}`;
    try {
      if (on) {
        if (!draftPaintSaved.has(key)) draftPaintSaved.set(key, map.getPaintProperty(layer.id, prop));
        map.setPaintProperty(layer.id, prop, '#e53935');
      } else if (draftPaintSaved.has(key)) {
        map.setPaintProperty(layer.id, prop, draftPaintSaved.get(key));
        draftPaintSaved.delete(key);
      }
    } catch { /* a layer Draw has not added yet */ }
  }
}

/** Repaint the not-lawn traces and the button that removes them. */
function refreshNotLawn() {
  if (map && map.getSource('not-lawn')) {
    map.getSource('not-lawn').setData({
      type: 'FeatureCollection',
      features: state.notLawn.map((geometry) => ({ type: 'Feature', properties: {}, geometry })),
    });
  }
  const undo = $('#btn-not-lawn-undo');
  if (undo) undo.disabled = !state.notLawn.length;
}

/**
 * The flag and the button only -- no change to what Draw is doing.
 *
 * BUT DRAW MAY BE ABOUT TO CLOSE A TRACE. Stopping, or picking any other tool,
 * takes Draw out of draw_polygon, and Draw closes an open outline of three or
 * more corners by itself on the way out -- firing draw.create AFTER this flag
 * is off. That trace landed as an ordinary blue lawn shape and the total went
 * up by its area (owner, 2026-10-01). notLawnClosing carries it across that
 * one step, synchronous inside the changeMode, and is dropped right after.
 */
function leaveNotLawnMode() {
  if (state.notLawnMode) {
    state.notLawnClosing = true;
    setTimeout(() => { state.notLawnClosing = false; }, 0);
  }
  state.notLawnMode = false;
  paintNotLawnDraft(false);
  const btn = $('#btn-not-lawn');
  if (btn) {
    btn.classList.remove('on');
    btn.textContent = 'Trace not-lawn';
  }
}

/** Tracing not-lawn on or off. Tinker mode only. */
function setNotLawnMode(on) {
  if (on && state.dev) {
    /* Everything else off FIRST: setMode ends not-lawn tracing by design. */
    setMode(null);
    state.drawingHole = false;
    state.drawingParcel = false;
    setInferredMode(false);
    state.notLawnMode = true;
    paintNotLawnDraft(true);
    const btn = $('#btn-not-lawn');
    if (btn) {
      btn.classList.add('on');
      btn.textContent = 'Tracing not-lawn';
    }
    draw.changeMode('draw_polygon');
    setHint('Tap around the edge of something that is NOT lawn -- a parking lot, '
      + 'a road, a pond -- then press the ✓.');
    setStatus('Tracing not-lawn. These are for training only and never count toward the total.');
  } else {
    const was = state.notLawnMode;
    leaveNotLawnMode();
    if (was) {
      try { if (draw.getMode() === 'draw_polygon') draw.changeMode('simple_select'); } catch { /* not ready */ }
    }
  }
}

function updateSelectionButtons() {
  let chosen = [];
  try {
    chosen = draw.getSelected().features;
  } catch {
    chosen = [];
  }
  const selected = chosen.length;
  // Phones have no Delete key, so removing a patch you do not mow needs a
  // button; without one, a wrongly detected shape could not be removed at all.
  $('#btn-delete').disabled = selected === 0;

  /*
   * The label says what pressing it will DO, not what the shape currently is.
   * A button reading "Inferred" on an already-inferred shape is ambiguous
   * about which way it goes, and this is a flag people will set dozens of
   * times in a review session.
   *
   * A mixed selection unmarks: turning a mark off is the recoverable
   * direction, and marking ground as inferred when it was plainly visible is
   * the error that quietly teaches the detector to stop looking.
   */
  const btn = $('#btn-inferred');
  btn.disabled = selected === 0;
  btn.textContent = selected && chosen.every(isInferred) ? 'Mark as seen' : 'Mark as inferred';
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
    sub.textContent = s.label;
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
  /*
   * THE NOTES COME FROM THE PLANNER, WHOLE.
   *
   * This used to compute an uncovered-ground note of its own and put it in
   * front of the planner's. Two places writing about the same fact is how they
   * end up disagreeing -- and the planner's version is the better one anyway,
   * because it knows WHY the ground is uncovered (a drive, a building, a
   * target nothing can reach) and this only knew that it was.
   */
  const box = $('#seg-notes');
  box.innerHTML = '';
  for (const text of plan.notes) {
    const p = document.createElement('p');
    p.textContent = text;
    box.append(p);
  }
  box.hidden = !plan.notes.length;

  /*
   * Covered AND total, always, not just when they differ.
   *
   * Pieces are only drawn where one genuinely fits now, so a plan covering
   * part of a lawn is the normal case rather than a failure -- and the two
   * numbers side by side are what tell somebody at a glance how much of their
   * lawn they are about to treat off-plan.
   */
  $('#seg-summary').textContent =
    `${plan.segments.length} piece${plan.segments.length === 1 ? '' : 's'}`
    + ` · ${plan.coveredSqFt.toLocaleString()} of ${plan.totalSqFt.toLocaleString()} sq ft`
    + (plan.sections > 1 ? ` · ${plan.sections} sections` : '');
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
      setQuotaBadge(badge, `${free} of ${state.quota.limit} AI passes left today`
        + (bought ? `, plus ${bought.toLocaleString()} bought` : ''),
      `${free}/${state.quota.limit} AI${bought ? ` +${bought.toLocaleString()}` : ''}`);
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

    setQuotaBadge(badge, (state.quota.reason === 'shared-network'
      ? `${left} of ${state.quota.limit} AI passes left today on this network`
      : `${left} of ${state.quota.limit} AI passes left today`) + offer,
    `${left}/${state.quota.limit} AI`);
    badge.hidden = false;
  } catch {
    // A quota read failing is not worth interrupting anyone over.
  }
}

/**
 * The badge in two lengths: the sentence, and "5/5 AI" for a phone's
 * top bar, where the heart and the account button leave room for about that
 * much and the sentence was cut to "5..". CSS picks one; the short one is
 * hidden from screen readers, which get the sentence either way.
 */
function setQuotaBadge(badge, long, short) {
  badge.textContent = '';
  const full = document.createElement('span');
  full.className = 'q-long';
  full.textContent = long;
  const brief = document.createElement('span');
  brief.className = 'q-short';
  brief.setAttribute('aria-hidden', 'true');
  brief.textContent = short;
  badge.append(full, brief);
  badge.title = long;
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
  state.detectedVersion = null;
  state.detectedExcluding = null;
  state.detectedShapes = null;
  state.naipAlign = null;
  state.googleAlign = null;
  state.alignBlobs = {};
  state.provider = 'mapbox';
  state.model = state.defaultModel;
  state.pins = [];
  state.mode = null;
  state.shapeTool = 'points';
  state.brushSize = 'bulk';
  state.measureOutside = false;
  $('#toggle-outside').checked = false;
  $('#outside-opt').hidden = true;
  /* A new map starts on the ordinary layer. Leaving inferred drawing armed
     from the last property is how somebody marks a lawn they never meant to. */
  setInferredMode(false);
  state.inferredInside = false;
  $('#toggle-inside-lawn').checked = false;
  /* Not-lawn traces belong to the map they were drawn on. */
  setNotLawnMode(false);
  state.notLawn = [];
  /* So does having looked at Google or NAIP, and having been asked about it. */
  state.altViewed = null;
  state.alignAsked = false;
  refreshNotLawn();
  // Back to Find grass, and to both defaults for the gap option.
  state.fillGaps = { find: true, exclude: false };
  state.handEdited = false;
  setTab('address');
  state.drawingParcel = false;
  state.drawingHole = false;
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
  // Starting over is leaving the candidate, so the way back out goes with it.
  state.reviewingId = null;
  $('#review-bar').hidden = true;
  $('#result').hidden = true;
  $('#toggle-overlay').checked = false;
  setStatus('');
  setHint('');
  locateNote('');
  showStep('address');
}

$('#address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  locateNote('');
  search($('#address').value.trim());
});
$('#btn-locate').addEventListener('click', useMyLocation);

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'restart') reset();
  if (action === 'confirm') confirmLocation();
});

$('#btn-detect').addEventListener('click', () => detect());
$('#busy-cancel').addEventListener('click', () => giveUpOnDetection('cancel'));
$('#busy-retry').addEventListener('click', () => giveUpOnDetection('retry'));

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
$('#btn-parcel-road').addEventListener('click', () => extendParcelToRoad());

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
  state.drawingHole = false;
  state.drawingParcel = true;
  draw.changeMode('draw_polygon');
  setHint('Tap each corner of your property. Tap the first one again to close it.');
  setStatus('Tracing the property line. Follow the kerb, the fences and the neighbours’ edges.');
});

/*
 * The trained model, in developer mode only. It draws over the photograph and
 * touches nothing else -- see showTrainedModel for why it is not editable.
 */
$('#dev-model')?.addEventListener('click', () => { showTrainedModel(); });
$('#dev-model-off')?.addEventListener('click', hideTrainedModel);

$('#btn-draw').addEventListener('click', () => {
  setMode(null); // drawing owns the map while it is open
  state.drawingHole = false;
  // No pushHistory: each corner is its own undo step while the drawing is
  // open, and closing it records one entry that can reopen it (draw.create).
  draw.changeMode('draw_polygon');
  setHint(state.measureOutside || !state.parcel
    ? 'Tap around the edge of your lawn, then press the ✓ to finish.'
    : 'Tap around the edge of your lawn, then press the ✓. Points snap to the property line.');
  setStatus('Drawing by hand. Every shape you add counts toward the total.');
});

/*
 * THE SAME GESTURE, SUBTRACTING.
 *
 * Rubbing a shed out with the brush works and is loose by nature: a shed has
 * four straight sides and a fingertip does not. Tracing its corners is the
 * accurate way to do it, and until now the point tool could only ever edit an
 * outline that already existed -- there was no way to MAKE one that takes
 * ground away. This is that, and what it produces is an ordinary hole whose
 * corners the point tools can move, add to and delete afterwards.
 *
 * No pushHistory here: cutHoleFromDrawn takes the snapshot once it knows the
 * cut lands somewhere, so an outline that misses costs no undo step.
 */
$('#btn-cut').addEventListener('click', () => {
  if (!hasLawn()) {
    setStatus('Nothing to cut out of yet — detect a lawn or draw a patch first.', 'warn');
    return;
  }
  setMode(null);
  state.drawingHole = true;
  draw.changeMode('draw_polygon');
  setHint('Tap each corner of the shed, pool or patio, then press the ✓. Points snap to the lawn\'s edge.');
  setStatus('Cutting out. Trace right around the thing, inside one patch of lawn.');
});

function clearAll() {
  if (drafting) draftCancel();
  pushHistory();
  draw.deleteAll();
  if (state.mode === 'shape') settleMode(); // the corner tool re-reads what is left
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
}
$('#btn-clear').addEventListener('click', clearAll);
$('#btn-clear-detect').addEventListener('click', clearAll);

$('#btn-parcel-shape').addEventListener('click', useParcelShape);
for (const id of ['#btn-undo', '#rail-undo']) {
  $(id).addEventListener('click', undo);
}
for (const id of ['#btn-redo', '#rail-redo']) {
  $(id).addEventListener('click', redo);
}
/*
 * The rail. Pressing the live mode turns it off; pressing another switches
 * straight to it -- making you close one before opening the next would be a
 * press per correction, and corrections come in runs.
 */
/* Only Move and Pins still have buttons; the other two are a step's own tool
   (restMode), so pressing Move off lands back on the lawn tools. */
for (const mode of MODES) {
  $(`#mode-${mode}`)?.addEventListener('click', () => {
    if (state.mode === mode) settleMode();
    else setMode(mode);
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

/*
 * Handles on or off, remembered.
 *
 * Off by default, because a detected outline can carry a corner every few
 * pixels and a stalk on each is unreadable -- the placement rules stop them
 * overlapping and cannot make a hundred of them restful. Remembered rather
 * than reset each visit, because it is a preference about how somebody likes
 * to work, and re-finding it every session is its own annoyance. A browser
 * that refuses storage simply starts off every time, which is the default
 * anyway.
 */
const HANDLES_KEY = 'lawnmap.handles.v1';
/* Only while the button is on offer: with it put away (index.html), a
   remembered "on" would leave stalks on the map and no way to turn them off. */
try {
  state.handlesOn = !$('#tool-handles').hidden && localStorage.getItem(HANDLES_KEY) === '1';
} catch { /* off */ }

$('#tool-handles').addEventListener('click', () => {
  state.handlesOn = !state.handlesOn;
  try { localStorage.setItem(HANDLES_KEY, state.handlesOn ? '1' : '0'); } catch { /* fine */ }
  refreshRail();
  drawHandles();
  setHint(state.handlesOn
    ? 'Drag the dot on a stalk to move its corner'
    : 'Tap a corner to move it');
});

/*
 * The point eraser. A MODE rather than a button that deletes the selection,
 * because removing a run of stray corners from a traced outline is a dozen
 * taps and picking each one first would double that.
 */
$('#tool-unpoint').addEventListener('click', () => {
  state.pointEraser = !state.pointEraser;
  refreshRail();
  if (state.pointEraser) {
    setHint('Tap a corner to remove it');
    setStatus('Point eraser on. Tap any point to delete it — press Point eraser again to stop.');
  } else {
    setHint('Tap a corner to move it');
    setStatus('Back to moving corners.');
  }
});

for (const tool of ['points', 'add', 'erase']) {
  $(`#tool-${tool}`).addEventListener('click', () => {
    const live = state.mode === 'shape' && state.shapeTool === tool;
    setMode('shape', live ? 'points' : tool);
  });
}

/*
 * The collapsed brushes: one icon, which opens whichever was last in hand.
 *
 * Remembered rather than always Erase, because the two are used in runs -- you
 * rub out three sheds, not one shed and then one patch of missed lawn -- so
 * the useful default is the one you were just using.
 */
$('#tool-brushes').addEventListener('click', () => setMode('shape', state.lastBrush || 'erase'));

/*
 * MAKING GEOMETRY FROM THE MAP, and coming back to where you were.
 *
 * Both of these are the panel's own buttons, reached without the trip to the
 * panel: while correcting corners you notice a missed patch or a shed, and
 * pressing them used to mean leaving the map, scrolling, pressing, drawing,
 * and then finding your way back into Points by hand.
 *
 * `returnToPoints` is what closes that loop. Drawing takes the map -- Draw's
 * polygon mode owns every tap while it is open, which is why setMode(null) is
 * right -- so the way back has to be remembered rather than inferred.
 */
$('#tool-newpatch').addEventListener('click', () => {
  state.returnToPoints = true;
  $('#btn-draw').click();
});
$('#tool-cutout').addEventListener('click', () => {
  state.returnToPoints = true;
  $('#btn-cut').click();
});

/*
 * Delete the corner last touched. A ONE-SHOT, where Remove is a mode.
 *
 * After dragging a corner it is still selected, so this is "that one was a
 * mistake" without aiming at it a second time. It refuses rather than guessing
 * when nothing is selected: deleting *some* corner because none was named is
 * the kind of help nobody can undo by eye.
 */
$('#tool-delpoint').addEventListener('click', () => {
  const edit = state.edgeEdit;
  if (!edit?.ringId || edit.vertexIndex == null) {
    setStatus('Tap a point first — Delete point removes the one you last touched.', 'warn');
    return;
  }
  deleteSelectedVertex();
});

$('#btn-edge-done').addEventListener('click', () => settleMode());

/*
 * THE CANCEL X: put the open New shape or Cut out away -- and keep it in the
 * undo history with every point, the way a closed shape is kept (see
 * draw.create), so a slip of the thumb is one Undo from being back.
 */
$('#tool-cancel').addEventListener('click', () => {
  if (!drafting || !precisePlacing()) return;
  const st = drafting.state;
  const corners = st.polygon.coordinates[0].slice(0, st.currentVertexPosition).map((p) => [...p]);
  if (corners.length) {
    pushHistory(null, {
      ...snapshot({ without: st.polygon.id }),
      reopen: { corners, hole: Boolean(state.drawingHole), returnToPoints: Boolean(state.returnToPoints) },
    });
  }
  draftCancel();
  refreshHistoryButtons();
  setStatus(corners.length
    ? 'Cancelled. Undo brings it back with every point in place.'
    : 'Cancelled.');
});

/* The checkmark: close the open New shape or Cut out, exactly as tapping its
   first point does (stepwisePolygonMode's close). draw.create takes it from
   there, back into Points when that is where it was started. */
$('#tool-finish').addEventListener('click', () => {
  if (!drafting || drafting.state.currentVertexPosition < 3) return;
  drafting.mode.changeMode(LOCKED_MODE);
});
$('#btn-tidy').addEventListener('click', tidyShapes);
$('#btn-point-add').addEventListener('click', addPointOnEdge);
$('#btn-point-delete').addEventListener('click', deleteSelectedVertex);
$('#edge-slider').addEventListener('input', (e) => applyEdgeOffset(Number(e.target.value)));

/**
 * Turn the inferred layer on or off for drawing.
 *
 * Everything else about the map stays exactly as it was -- same polygon tool,
 * same brushes, same selection. The only difference is which layer the next
 * shape lands on, so there is no mode to get stuck in and nothing to undo if
 * it is left switched on by accident.
 */
function setInferredMode(on) {
  state.inferredMode = Boolean(on);
  const btn = $('#btn-inferred-mode');
  btn.classList.toggle('on', state.inferredMode);
  btn.textContent = state.inferredMode ? 'Drawing inferred lawn' : 'Draw inferred lawn';
  /*
   * The panel says which layer is live, because the tools look identical in
   * both and the difference only shows once something has been drawn. A mode
   * you cannot tell you are in is a mode that quietly mislabels a lawn.
   */
  document.body.classList.toggle('inferred-mode', state.inferredMode);
  /* The sub-toggle only exists inside this mode, so it appears and disappears
     with it. Its setting is remembered across a trip out and back, because
     somebody who turned it on meant it. */
  $('#inside-lawn-opt').hidden = !state.inferredMode;
  setStatus(state.inferredMode
    ? 'Drawing inferred lawn. Outline or brush the ground you know is there '
      + 'but cannot see — under a canopy, or through a shadow. It may sit on '
      + 'top of lawn you have already drawn; the total counts ground once.'
    : 'Back to ordinary lawn.');
}

$('#btn-inferred-mode').addEventListener('click', () => setInferredMode(!state.inferredMode));
$('#btn-not-lawn')?.addEventListener('click', () => setNotLawnMode(!state.notLawnMode));
$('#btn-not-lawn-undo')?.addEventListener('click', () => {
  state.notLawn.pop();
  refreshNotLawn();
  setStatus(`Removed. ${state.notLawn.length} not-lawn trace${state.notLawn.length === 1 ? '' : 's'} left on this map.`);
});

$('#toggle-inside-lawn').addEventListener('change', (e) => {
  state.inferredInside = e.target.checked;
  /*
   * NOTHING ALREADY ON THE MAP MOVES, either way. That is the difference
   * between this and the property-line toggle, which trims everything when it
   * is switched off -- and the difference is deliberate. The boundary is a
   * recorded fact that either applies or does not; the lawn's edge is one
   * person's tracing, and reshaping the careful layer to fit the sloppy one,
   * retroactively, is not a thing anybody asked for.
   */
  setStatus(state.inferredInside
    ? 'Inferred patches will be kept inside the lawn from now on. Nothing '
      + 'already drawn has moved.'
    : 'Inferred patches can go past the lawn again.');
});

$('#btn-inferred').addEventListener('click', () => {
  const chosen = draw.getSelected().features;
  if (!chosen.length) return;
  /* All-or-nothing on a mixed selection, and the direction is "unmark", which
     is what the label already promised. */
  const marking = !chosen.every(isInferred);
  pushHistory();
  markHandEdited();
  for (const f of chosen) {
    /*
     * setFeatureProperty rather than editing f.properties: the object handed
     * back by getSelected is a copy, so writing to it changes nothing Draw
     * will ever save, silently, which is the worst kind of nothing.
     */
    draw.setFeatureProperty(f.id, 'inferred', marking ? true : undefined);
  }
  refreshInferred();
  updateSelectionButtons();
  setStatus(marking
    ? 'Marked as inferred. The total still counts it; the training now knows '
      + 'you worked it out rather than saw it.'
    : 'Marked as seen. It counts as ordinary visible lawn again.');
});

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
  $(`#mode-${mode}`)?.addEventListener('click', () => {
    if (tips.stage) hideTip();
  });
}

window.addEventListener('resize', placeTip);

/* A tap anywhere on the tour puts it away -- "Got it" is the obvious place,
   not the only one -- and brings on the next one the Draw step owes. */
$('#tour').addEventListener('click', () => {
  if (tour.stage && tour.stepping && tour.index < tour.total - 1) {
    tour.index += 1;
    placeTour();
    return;
  }
  hideTip();
  requestAnimationFrame(maybeToolTour);
});
window.addEventListener('resize', placeTour);

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
/**
 * Keep this finished map, to train a detector on one day.
 *
 * Finishing is the only moment anybody says "this is right" about a lawn, so
 * it is the only moment worth recording. Everything before it is a work in
 * progress and the AI's own answer is one of those.
 *
 * NO AWAIT AND NO ERROR, exactly like sendFeedback: the person has finished
 * measuring their lawn, and a corpus for a model that does not exist yet must
 * never be the reason that looks broken.
 *
 * What goes is the outline, the frame and how much the detector was out by.
 * Not the address, not the account -- see the corpus table in schema.sql.
 */
/*
 * THE RECORD ITSELF, SEPARATED FROM SENDING IT.
 *
 * Two things post one of these now: finishing an ordinary map, and a paid
 * worker submitting the lawn they were handed. The submission goes to a
 * different route -- it carries a worker id and a claim, and the reply is a
 * completion code rather than nothing -- but the ROW has to be identical, and
 * the corpus deliberately cannot tell which maps came from where, because they
 * are judged the same. Two builders would be two chances for the id
 * derivation, the shape cleaning or the inferred flag to drift.
 *
 * Null when there is nothing to record, which both callers check.
 */
function finishedBody() {
  const shapes = draw.getAll().features.filter((f) => outerRing(f));
  if (!shapes.length) return null;
  const m = measureLawn({ type: 'FeatureCollection', features: shapes });

  return {
      /*
       * THE ROW THIS IS, when we already know -- rather than one worked out
       * again from where it is.
       *
       * The id is built from the frame's centre at five decimal places, about
       * a metre. The frame is also UPDATED IN PLACE by the upsert while the id
       * is not, so any map whose frame has ever moved since it was created
       * carries an id that no longer matches its own coordinates. Re-saving it
       * then derived a different id and minted a second row: the same lawn
       * twice, one with the inferred marks and one without, both approved.
       *
       * That is worse than untidy. Leave-one-out trains on one copy and tests
       * on its twin, and reports a number far better than the model deserves.
       *
       * Reviewing is the one path that knows which row it opened, so it says
       * so. Everything else still derives an id, which is right: a fresh
       * measurement has no row yet.
       */
      ...(state.reviewingId ? { id: state.reviewingId } : {}),
      lng: state.chosen?.lng ?? state.frame?.lng ?? null,
      lat: state.chosen?.lat ?? state.frame?.lat ?? null,
      /*
       * A TRACED BOUNDARY HAS NO COUNTY, and used to get the word "traced by
       * hand" in the county column.
       *
       * `properties.county` is what the print-out quotes as the source of the
       * line, so for a hand-traced parcel it literally reads "traced by hand"
       * -- correct on the page, nonsense in a column that groups by place.
       * Every hand-traced row would have joined one enormous fake county, and
       * the leave-one-county-out check would have held it out as if it were a
       * region.
       *
       * Null instead, which is true, and costs nothing: `lng`/`lat` are always
       * present, so the export can look the real county up from the
       * coordinates when it wants one.
       */
      county: state.parcel?.properties?.drawn
        ? null
        : state.parcel?.properties?.county || null,
      // Whether the line is a county record or a person's best guess. The
      // model is scored only inside it, so the two are not equal ground truth.
      parcelSource: state.parcel ? (state.parcel.properties?.drawn ? 'hand' : 'county') : null,
      provider: state.detectedWith || state.provider,
      model: state.detectedBy || null,
      /* Which release drew the outline being corrected (feedback loop 1). */
      modelVersion: state.detectedBy ? state.detectedVersion || null : null,
      mode: saveMode(),
      handEdited: state.handEdited,
      // Null when nothing was detected: a lawn drawn entirely by hand is a
      // good training example and a different kind from a correction.
      detectedSqFt: state.detectedBy ? state.detectedSqFt ?? null : null,
      squareFeet: Math.round(m.squareFeet),
      parcelSqFt: state.parcel ? Math.round(measure(state.parcel.geometry).squareFeet) : null,
      frame: state.lastMask?.frame || state.frame || null,
      parcel: state.parcel || null,
      /*
       * The inferred flag travels with the shape. Geometry alone cannot say
       * which lawn was seen and which was worked out, and this is the path
       * that feeds training -- so it is the one where the distinction is
       * worth anything at all.
       */
      shapes: shapes.map((f) => ({
        type: 'Feature',
        properties: f.properties?.inferred ? { inferred: true } : {},
        geometry: f.geometry,
      })),
      /*
       * Not-lawn traces (tinker mode). Sent as a list whenever tinker mode is
       * on -- an empty list means "I removed them" -- and as null otherwise,
       * which the server reads as "leave whatever is stored alone".
       */
      notLawn: state.dev || state.notLawn.length ? state.notLawn.slice() : null,
      // Null, not empty, when nothing was detected: "no detection happened"
      // and "the detector found nothing" are different examples.
      detectedShapes: state.detectedShapes
        ? state.detectedShapes.map((geometry) => ({ geometry }))
        : null,
      // Which exclusion prompts ran. A lawn that needed `woods` is a lawn with
      // a tree line, which is what the hard half of the eval is made of.
      exclusions: state.exclude?.length ? state.exclude.slice().sort() : null,
      /* How NAIP lines up here, if somebody looked at it in NAIP. Absent, the
         pipeline aligns it itself (tools/naip_bands.py). */
      naipAlign: state.naipAlign
        ? { east: state.naipAlign.east, north: state.naipAlign.north,
            scale: state.naipAlign.scale, source: state.naipAlign.source }
        : null,
  };
}

function keepFinished() {
  const body = finishedBody();
  if (!body) return;
  api('/api/finished', { method: 'POST', body: JSON.stringify(body) })
    .catch(() => { /* Never the finisher's problem. */ });
}

/*
 * The two ways out of a review. Same destination, different promise -- and
 * both of them named on screen rather than implied by a status line that the
 * next status line replaces.
 */
$('#btn-job-submit').addEventListener('click', submitJob);
$('#btn-job-skip').addEventListener('click', skipJob);

$('#btn-review-save').addEventListener('click', () => leaveReview(true));
$('#btn-review-back').addEventListener('click', () => {
  if (!confirm('Go back without saving? Any corrections you have made here are lost.')) return;
  leaveReview(false);
});

/*
 * BEFORE SAVING, DID THE PHOTO LINE UP? (owner, 2026-10-01). Asked once per
 * map, only when Google or NAIP was looked at while it was being drawn: shapes
 * are kept against Mapbox, so a photo that sat off it moved every corner
 * traced on it. "Check" goes back to that photo, and shows the imagery tour if
 * the line-up panel has never been opened -- otherwise opens the panel itself.
 */
function askAlignCheck() {
  if (!state.altViewed || state.alignAsked || state.job) return false;
  state.alignAsked = true;
  const name = providerInfo(state.altViewed).label || 'the other photo';
  $('#align-check-why').textContent = `You looked at ${name} on this map. Your shapes are saved on the `
    + 'Mapbox photo, and that is what the lawn detector learns from, so if that photo sat off Mapbox '
    + 'the shapes are off too.';
  $('#align-check').hidden = false;
  return true;
}

$('#align-check-ok')?.addEventListener('click', () => {
  $('#align-check').hidden = true;
  $('#btn-finish').click();
});
$('#align-check-look')?.addEventListener('click', async () => {
  $('#align-check').hidden = true;
  const opened = sessionFlag(ALIGN_OPENED_KEY);
  if (!opened) imageryTourDue = true;
  setTab('draw');
  if (state.provider !== state.altViewed) await setProvider(state.altViewed);
  if (opened) setAlignOpen(true);
  else requestAnimationFrame(maybeImageryTour);
  setStatus('Line the photo up with Mapbox if it needs it, then press Finish again.');
});

$('#btn-finish').addEventListener('click', () => {
  if (askAlignCheck()) return;
  keepFinished();

  /*
   * Straight back to the queue when this was opened for review, because the
   * reviewer's next action is judging the next candidate, not planning
   * segments on this one. Finishing has already reset the row to unreviewed,
   * so the corrected outline is waiting there to be approved.
   */
  if (state.reviewingId) {
    state.reviewingId = null;
    $('#review-bar').hidden = true;
    setStatus('Saved. Going back.');
    window.location.href = state.reviewBack || '/admin.html';
    return;
  }

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
  const mode = fillGapsMode();
  const was = Boolean(state.fillGaps[mode]);
  state.fillGaps[mode] = e.target.checked;

  /*
   * With no mask in hand there is nothing to redraw and nothing to lose: the
   * setting is simply remembered for the next detection.
   */
  if (!state.lastMask?.layers?.length) return;

  /*
   * PUT THE BOX BACK IF THE REDRAW DID NOT HAPPEN.
   *
   * A checkbox that stays ticked after the answer was "no, keep my work" is
   * claiming a measurement the map is not showing, and the next thing that
   * re-traces would then apply it without asking again.
   */
  if (!retrace('Counting grass under trees')) {
    state.fillGaps[mode] = was;
    e.target.checked = was;
    setStatus('Left as it is — your hand corrections are untouched.');
  }
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

/* Support (owner, 2026-09-30): only ever opened by a press. */
$('#support-btn').addEventListener('click', () => openSheet('#support-sheet'));
for (const b of document.querySelectorAll('[data-support-open]')) {
  b.addEventListener('click', () => openSheet('#support-sheet'));
}
for (const id of ['#support-close', '#support-later', '#support-go']) {
  $(id).addEventListener('click', () => closeSheet('#support-sheet'));
}
$('#signin-close').addEventListener('click', () => closeSheet('#signin'));
$('#account-close').addEventListener('click', () => closeSheet('#account-sheet'));
/* Two ways out, because the × is small on a phone and this one has nothing to
   agree to -- "Got it" is an acknowledgement, not a decision. */

/* Tapping the darkened area behind a sheet closes it, which is what everyone
 * tries first. The test is on the target itself, so a press inside the card
 * does not count as a press outside it. */
for (const id of ['#signin', '#account-sheet', '#support-sheet']) {
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeSheet(id); });
}
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeSheet('#signin');
  closeSheet('#account-sheet');
  closeSheet('#support-sheet');
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
      /*
       * THE QUERY STRING IS THE LINK, and sending only the path threw it away.
       *
       * Everything that makes this page anything other than the front page
       * lives in the search: `?via=paid` is the paid route, `?w=<id>` is a
       * crowd worker's assignment. Signing in from the paid link therefore
       * landed people back on the ordinary site with no lawn, no job mode and
       * nothing to say what had happened -- on the one route where signing in
       * is compulsory, so it was the whole of that journey.
       *
       * safeNext on the Worker keeps this to a path on this site.
       */
      body: JSON.stringify({ email, next: location.pathname + location.search }),
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
   * After the account, because a candidate is only openable by an
   * administrator and the API decides that -- asking before sign-in has
   * resolved would ask as a stranger and be refused.
   */
  .then(afterMap('the review request', readReviewRequest))
  /*
   * Somebody arriving from a crowd platform to trace one lawn for money.
   *
   * After the map, because it puts a lawn on it; before the saved-map
   * shortcut, because a paid worker has no account and no saves, and offering
   * them a list of somebody else's maps would be both confusing and wrong.
   */
  .then(afterMap('the paid queue', async () => {
    const asked = readJobRequest();
    if (asked) await enterJobMode(asked);
  }))
  /*
   * After the account, because whether there are saved maps depends on whether
   * this is an account with maps in it -- asking before signing in is resolved
   * would offer the shortcut to an empty list, or hide it from somebody whose
   * maps are about to load.
   */
  .then(afterMap('the saved-map shortcut', async () => {
    if (state.worker) return;      // no account, so nothing to shortcut to
    const saves = await loadSaves();
    $('#btn-open-saved').hidden = !saves.length;
  }))
  .catch(() => {});                  // already reported above
