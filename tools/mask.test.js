/**
 * Ground-truth tests for the mask -> polygon pipeline.
 *
 * The failure mode this guards against is not a crash. It is a traced lawn
 * that looks perfectly reasonable on screen and is off by a constant factor,
 * which is precisely the class of bug area.test.js exists to catch on the
 * other half of the pipeline. So every check here builds a synthetic mask of
 * known pixel dimensions, runs the real code, and compares the measured area
 * against what the frame's ground resolution says it must be.
 *
 *   node tools/mask.test.js
 */

import {
  rasterizePolygon,
  binarize,
  growMask,
  labelComponents,
  traceRegion,
  simplify,
  maskToPolygons,
  distinctFraction,
  maskBinary,
  unionMasks,
  subtractMasks,
  coverage,
  polygonsFromBinary,
  overTrimmed,
} from '../public/lib/mask.js';
import {
  framePxToLngLat,
  lngLatToFramePx,
  metresPerPixel,
  zoomToFit,
  geometryBounds,
} from '../public/lib/mercator.js';
import { measure, geometryAreaSqM } from '../public/lib/area.js';

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

function closeTo(actual, expected, tolerancePct, name) {
  const off = Math.abs(actual - expected) / expected;
  check(
    name,
    off <= tolerancePct / 100,
    `got ${actual.toFixed(1)}  expected ~${expected.toFixed(1)}  (${(off * 100).toFixed(3)}% off)`
  );
}

/** Build an RGBA ImageData-alike with a white-on-black rectangle painted in. */
function blankMask(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255; // opaque black
  return { width, height, data };
}

function paintRect(image, x0, y0, w, h, value = 255) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
    }
  }
}

/* A frame over a residential block in Grand Rapids, matching what the app
 * actually requests: 640 logical px at @2x, so a 1280px image. */
const FRAME = { lng: -85.6681, lat: 42.9634, zoom: 19, size: 640 };
const IMG = 1280;
const unproject = (x, y) => framePxToLngLat(FRAME, [x, y], IMG, IMG);
const MPP = metresPerPixel(FRAME, IMG);

console.log(`\nframe: zoom ${FRAME.zoom} @ ${IMG}px  ->  ${MPP.toFixed(4)} m/px\n`);

/* ------------------------------------------------- 1. projection round-trip */
{
  const original = [-85.6695, 42.9641];
  const px = lngLatToFramePx(FRAME, original, IMG, IMG);
  const back = framePxToLngLat(FRAME, px, IMG, IMG);
  const driftM = Math.hypot(
    (back[0] - original[0]) * 111320 * Math.cos((original[1] * Math.PI) / 180),
    (back[1] - original[1]) * 110540
  );
  check('projection round-trips', driftM < 0.01, `drift ${(driftM * 100).toFixed(4)} cm`);
}

/* ------------------------------------------------------ 2. a known rectangle */
{
  const img = blankMask(IMG, IMG);
  // 400 x 300 pixels of "lawn".
  paintRect(img, 300, 400, 400, 300);

  const polys = maskToPolygons(img, unproject, { tolerance: 0.5 });
  check('single rectangle -> one polygon', polys.length === 1, `got ${polys.length}`);

  // Tracing follows pixel centres, so an N-pixel-wide block spans N-1 pixels
  // of distance from first centre to last.
  const expected = (399 * MPP) * (299 * MPP);
  closeTo(geometryAreaSqM(polys[0]), expected, 0.5, 'rectangle area matches ground resolution');

  const m = measure(polys[0]);
  console.log(`      -> ${m.squareFeet.toLocaleString()} sq ft / ${m.acres} ac`);
}

/* ------------------------------------------------ 3. the house-shaped hole */
{
  const img = blankMask(IMG, IMG);
  paintRect(img, 300, 300, 600, 600);   // lawn
  paintRect(img, 500, 500, 200, 200, 0); // house punched out of it

  const polys = maskToPolygons(img, unproject, { tolerance: 0.5 });
  check('lawn with a house in it -> one polygon', polys.length === 1, `got ${polys.length}`);
  check('house became an interior ring', polys[0].coordinates.length === 2,
    `${polys[0].coordinates.length} ring(s)`);

  const expected = (599 * MPP) ** 2 - (201 * MPP) ** 2;
  closeTo(geometryAreaSqM(polys[0]), expected, 1.5, 'hole is subtracted from the total');

  // The check that matters commercially: ignoring the hole would overstate
  // the billable area by this much.
  const outerOnly = geometryAreaSqM({ type: 'Polygon', coordinates: [polys[0].coordinates[0]] });
  const inflation = outerOnly / geometryAreaSqM(polys[0]);
  console.log(`      ignoring the hole would overstate by ${((inflation - 1) * 100).toFixed(0)}%`);
  check('hole is material to the result', inflation > 1.05);
}

/* ------------------------------------------- 4. front and back yard, split */
{
  const img = blankMask(IMG, IMG);
  paintRect(img, 200, 200, 400, 200); // front
  paintRect(img, 200, 700, 400, 300); // back

  const polys = maskToPolygons(img, unproject, { tolerance: 0.5 });
  check('two detached patches -> two polygons', polys.length === 2, `got ${polys.length}`);

  const total = polys.reduce((s, p) => s + geometryAreaSqM(p), 0);
  const expected = (399 * MPP) * (199 * MPP) + (399 * MPP) * (299 * MPP);
  closeTo(total, expected, 0.5, 'patches sum to the right total');

  check('largest patch is returned first',
    geometryAreaSqM(polys[0]) > geometryAreaSqM(polys[1]));
}

/* ------------------------------------------------------ 5. noise rejection */
{
  const img = blankMask(IMG, IMG);
  paintRect(img, 300, 300, 500, 500);
  paintRect(img, 50, 50, 6, 6);   // stray speck
  paintRect(img, 90, 90, 4, 4);   // another

  const polys = maskToPolygons(img, unproject);
  check('specks are discarded', polys.length === 1, `got ${polys.length}`);
}

/* -------------------------------------------------- 6. inverted-mask guard */
{
  const img = blankMask(IMG, IMG);
  paintRect(img, 0, 0, IMG, IMG);          // all white...
  paintRect(img, 400, 400, 300, 300, 0);   // ...with a dark square

  const bin = binarize(img);
  const on = bin.reduce((s, v) => s + v, 0);
  check('near-total mask is treated as inverted', on < 0.5 * bin.length,
    `${((on / bin.length) * 100).toFixed(1)}% foreground after polarity fix`);

  /*
   * ...and that the caller can switch it off, which subtract mode depends on.
   *
   * The guard's premise -- "nothing we segment legitimately covers >90%" -- is
   * false for a not-lawn mask on a wooded lot. If autoPolarity ignored the
   * flag, this mask would be flipped here and flipped BACK by invert, and the
   * mode would report the buildings as the lawn.
   */
  const kept = binarize(img, 128, { autoPolarity: false });
  const keptOn = kept.reduce((s, v) => s + v, 0);
  check('polarity can be left alone for subtract mode', keptOn > 0.9 * kept.length,
    `${((keptOn / kept.length) * 100).toFixed(1)}% foreground with autoPolarity off`);
}

/* ---------------------------------------------- 6b. subtract-mode inversion */
{
  /*
   * The whole mode in one check: a mask of what is NOT lawn must trace as the
   * complement, and the property line must still be the last word.
   *
   * A 400x400 px "building" in the middle of the frame. Inverted, the lawn is
   * everything else -- so the measured area has to be the CLIP area minus the
   * building, not the building, and not the whole frame.
   */
  const img = blankMask(IMG, IMG);
  paintRect(img, 440, 440, 400, 400);      // the structure the model found

  const plain = maskToPolygons(img, unproject);
  const flipped = maskToPolygons(img, unproject, { invert: true });

  const areaOf = (ps) => ps.reduce((s, p) => s + geometryAreaSqM(p), 0);
  const frameArea = (IMG * MPP) ** 2;
  const buildingArea = (400 * MPP) ** 2;

  closeTo(areaOf(plain), buildingArea, 2, 'without invert, the structure is what gets measured');
  closeTo(areaOf(flipped), frameArea - buildingArea, 2,
    'with invert, the lawn is the frame minus the structure');

  /*
   * The hole matters as much as the area. Inverting produces one polygon with
   * the building as an interior ring -- not two, and not a solid rectangle
   * that happens to have the right total. A mode that measured correctly but
   * drew a lawn over the house would be unusable on screen.
   */
  check('the structure survives as a hole, not a second polygon',
    flipped.length === 1 && flipped[0].coordinates.length === 2,
    `${flipped.length} polygon(s), ${flipped[0]?.coordinates.length} ring(s)`);

  /*
   * And the ordering rule from maskToPolygons: invert, THEN clip. Get it
   * backwards and the clip would be inverted too, handing back everything
   * outside the property line.
   */
  const clipMask = new Uint8Array(IMG * IMG);
  for (let y = 200; y < 1080; y++) for (let x = 200; x < 1080; x++) clipMask[y * IMG + x] = 1;
  const clipped = maskToPolygons(img, unproject, { invert: true, clipMask });
  closeTo(areaOf(clipped), (880 * MPP) ** 2 - buildingArea, 2,
    'inverting happens before the clip, so the property line still bounds it');
}

/* ------------------------------------------------------ 7. vertex budgeting */
{
  const img = blankMask(IMG, IMG);
  // A circle: the worst case for staircase vertices.
  for (let y = 0; y < IMG; y++) {
    for (let x = 0; x < IMG; x++) {
      if (Math.hypot(x - 640, y - 640) < 400) {
        const i = (y * IMG + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      }
    }
  }

  const raw = traceRegion(binarize(img), IMG, IMG);
  const polys = maskToPolygons(img, unproject);
  const verts = polys[0].coordinates[0].length;

  check('circle stays under the vertex budget', verts <= 240, `${raw.length} traced -> ${verts} kept`);

  const expected = Math.PI * (400 * MPP) ** 2;
  closeTo(geometryAreaSqM(polys[0]), expected, 2, 'circle area survives simplification');
}

/* ------------------------------------------------------------ 8. zoomToFit */
{
  const parcel = {
    type: 'Polygon',
    coordinates: [[
      [-85.6690, 42.9630], [-85.6670, 42.9630],
      [-85.6670, 42.9642], [-85.6690, 42.9642], [-85.6690, 42.9630],
    ]],
  };
  const bbox = geometryBounds(parcel);
  const zoom = zoomToFit(bbox, 640);
  const frame = { lng: -85.668, lat: 42.9636, zoom, size: 640 };

  // Every corner of the parcel must land inside the image we are about to
  // send to SAM. A parcel cropped at the edge loses real lawn.
  const inside = parcel.coordinates[0].every(([lng, lat]) => {
    const [x, y] = lngLatToFramePx(frame, [lng, lat], 1280, 1280);
    return x >= 0 && y >= 0 && x <= 1280 && y <= 1280;
  });
  check('zoomToFit keeps the whole parcel in frame', inside, `zoom ${zoom}`);
  check('zoomToFit does not zoom out further than needed', zoom > 16, `zoom ${zoom}`);
}

/* ------------------------------------------------------- 9. simplify basics */
{
  const line = [[0, 0], [1, 0.05], [2, 0], [3, 0.05], [4, 0]];
  check('collinear-ish points collapse', simplify(line, 0.5).length === 2);
  check('real corners survive', simplify([[0, 0], [5, 0], [5, 5]], 0.5).length === 3);

  const { sizes } = labelComponents(new Uint8Array([1, 0, 1, 0]), 4, 1);
  check('labelling separates disconnected pixels', sizes.length === 3);
}


/* ------------------------------------- 10. clipping to the property line */
{
  // A lawn strip that runs well past the parcel on both sides -- the
  // neighbours' grass, which a text prompt will happily return too.
  const img = blankMask(IMG, IMG);
  paintRect(img, 0, 400, IMG, 300);

  // The parcel: a box covering only the middle of the frame.
  const parcelRing = [
    unproject(400, 300), unproject(880, 300),
    unproject(880, 980), unproject(400, 980), unproject(400, 300),
  ];
  const project = (lngLat) => lngLatToFramePx(FRAME, lngLat, IMG, IMG);
  const clip = rasterizePolygon([parcelRing], IMG, IMG, project);

  const painted = clip.reduce((n, v) => n + v, 0);
  closeTo(painted, 480 * 680, 3000, 'the parcel rasterises to its own pixel area');

  const unclipped = maskToPolygons(img, unproject, { tolerance: 0.5 });
  const clipped = maskToPolygons(img, unproject, { tolerance: 0.5, clipMask: clip });

  const before = geometryAreaSqM(unclipped[0]);
  const after = geometryAreaSqM(clipped[0]);
  check('clipping shrinks the lawn to the parcel', after < before * 0.45,
    `${before.toFixed(0)} -> ${after.toFixed(0)} m^2`);

  // 480 px wide by 300 px of lawn: only the part inside the parcel survives.
  closeTo(after, (479 * MPP) * (299 * MPP), 25, 'what survives is the overlap exactly');
}

/* ---------------------------------------- 11. gaps under a tree canopy */
{
  const img = blankMask(IMG, IMG);
  paintRect(img, 300, 300, 600, 600);      // lawn
  paintRect(img, 420, 420, 90, 90, 0);     // a tree: small gap
  paintRect(img, 650, 650, 200, 200, 0);   // a pool: large gap

  const subtracted = maskToPolygons(img, unproject, { tolerance: 0.5 });
  check('with no fill, both gaps are subtracted',
    subtracted[0].coordinates.length === 3, `${subtracted[0].coordinates.length} rings`);

  // Fill anything under ~120x120 px: the tree goes, the pool stays.
  const filled = maskToPolygons(img, unproject, { tolerance: 0.5, fillGapsUnderPx: 120 * 120 });
  check('the tree-sized gap is counted as lawn',
    filled[0].coordinates.length === 2, `${filled[0].coordinates.length} rings`);
  check('the pool-sized gap is still subtracted',
    geometryAreaSqM(filled[0]) < (599 * MPP) ** 2 - (150 * MPP) ** 2);
  check('it reports how many gaps it filled', filled.filledGaps === 1,
    `filledGaps=${filled.filledGaps}`);

  const gained = geometryAreaSqM(filled[0]) - geometryAreaSqM(subtracted[0]);
  closeTo(gained, (89 * MPP) ** 2, 2, 'the recovered area is the canopy exactly');
}

/* ------------------------------------------- an outline a person can edit */
/*
 * A mask traced too finely is not more accurate, it is unusable: 308 handles
 * on a real lawn, packed a few pixels apart, with the boundary somewhere
 * underneath them. The app asks for 0.3 m on the ground; this asserts that
 * asking buys what it is supposed to buy.
 *
 * A ragged edge stands in for the pixel staircase a real mask has. A clean
 * rectangle would simplify to four points at any tolerance and prove nothing.
 */
{
  const image = blankMask(IMG, IMG);
  paintRect(image, 300, 300, 600, 600);
  // A deterministic 0-3 px wobble on two edges. Multiplying by a prime and
  // taking the remainder gives a different bump on every row without a random
  // source, so the test says the same thing on every run.
  for (let y = 300; y < 900; y++) {
    const bump = (y * 7919) % 4;
    if (bump) paintRect(image, 900, y, bump, 1);
  }
  for (let x = 300; x < 900; x++) {
    const bump = (x * 6271) % 4;
    if (bump) paintRect(image, x, 300 - bump, 1, bump);
  }

  /*
   * Both with a cap far above what either will hit, so this measures the
   * tolerance and nothing else. With the cap in play the ring gets simplified
   * again and again until it fits, and on an edge whose wobble is all one size
   * -- as this synthetic one is, unlike a real boundary -- that loosening goes
   * over a cliff, 303 vertices to 6 in a single step. Worth knowing about, but
   * it is not what this check is for.
   */
  const count = (ps) => ps.reduce((n, p) => n + p.coordinates[0].length, 0);
  const fine = maskToPolygons(image, unproject, { tolerance: 1.5, maxVertices: 1000 });
  const coarse = maskToPolygons(image, unproject, { tolerance: 0.3 / MPP, maxVertices: 1000 });

  check('a ragged edge really does trace finely at the old default', count(fine) > 100,
    `${count(fine)} vertices`);
  check('0.3 m on the ground gives an outline a thumb can hit',
    count(coarse) <= 60, `${count(coarse)} vertices`);
  check('and it is a real reduction, not a rounding difference',
    count(coarse) < count(fine) / 4, `${count(fine)} -> ${count(coarse)}`);

  const fineArea = geometryAreaSqM(fine[0]);
  const coarseArea = geometryAreaSqM(coarse[0]);
  closeTo(coarseArea, fineArea, 2,
    'while the measurement stays within a couple of percent');

  // The cap is the backstop, not the usual limiter, so it must actually cap.
  const capped = maskToPolygons(image, unproject, { tolerance: 0.05, maxVertices: 24 });
  check('the vertex ceiling is enforced even at a fine tolerance',
    capped.every((p) => p.coordinates[0].length <= 24),
    capped.map((p) => p.coordinates[0].length).join(', '));
}


/* --------------------------------------------------- shrinking and growing */
/*
 * The sensitivity control that a hard mask actually admits.
 *
 * Checked against a shape whose answer is known by hand: a 20x20 square
 * eroded by r must be exactly (20-2r) on a side, because erosion by a disc
 * takes r off every straight edge. Dilation is deliberately NOT checked
 * against (20+2r)^2 -- growing by a disc rounds the corners, so the true area
 * is 400 + 4*20*r + pi*r^2, and asserting the square figure would be
 * asserting a bug.
 */
{
  const W = 40, H = 40;
  const square = new Uint8Array(W * H);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) square[y * W + x] = 1;
  const area = (b) => b.reduce((n, v) => n + v, 0);

  check('growMask(0) changes nothing', area(growMask(square, W, H, 0)) === 400);

  for (const r of [1, 3, 5]) {
    const side = 20 - 2 * r;
    check(`eroding by ${r} px leaves a ${side}x${side} square`,
      area(growMask(square, W, H, -r)) === side * side,
      `${area(growMask(square, W, H, -r))} px, expected ${side * side}`);
  }

  for (const r of [2, 5]) {
    const got = area(growMask(square, W, H, r));
    const ideal = 400 + 4 * 20 * r + Math.PI * r * r; // square grown by a disc
    check(`dilating by ${r} px grows toward a rounded square`,
      Math.abs(got - ideal) / ideal < 0.05,
      `${got} px vs ${ideal.toFixed(0)} ideal (${(100 * (got - ideal) / ideal).toFixed(1)}%)`);
  }

  check('eroding past the shape empties it',
    area(growMask(square, W, H, -20)) === 0);

  /* Growing must not invent lawn where none was found at all. */
  check('growing an empty mask keeps it empty',
    area(growMask(new Uint8Array(W * H), W, H, 4)) === 0);
}

/* ------------------------------------------- 9. stacking exclusions */
/*
 * EXCLUDE MODE: start from the property, take each mask away.
 *
 * The whole reason this replaced per-mask inversion is that inversion cannot
 * stack. For ONE concept the two are the same pixels written from opposite
 * ends, and the first check below proves exactly that. For TWO they are
 * opposites -- and the trap is that the broken version still returns a
 * plausible-looking polygon, so only arithmetic catches it.
 *
 * These work on binary layers rather than traced polygons on purpose: the
 * question here is set algebra, and putting it through the tracer would answer
 * it approximately, with the simplifier's tolerance mixed into the number.
 */
{
  const W = 100;
  const H = 100;
  const on = (m) => m.reduce((n, v) => n + v, 0);

  // A 60x60 lot, with a 20x20 building and a 20x20 stand of trees inside it.
  const rect = (x0, y0, w, h) => {
    const m = new Uint8Array(W * H);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m[y * W + x] = 1;
    return m;
  };

  const parcel = rect(20, 20, 60, 60);   // 3,600 px
  const house = rect(25, 25, 20, 20);    //   400 px, wholly inside
  const trees = rect(55, 55, 20, 20);    //   400 px, wholly inside, disjoint

  check('one exclusion leaves the property minus that thing',
    on(subtractMasks(parcel, unionMasks([house]))) === 3600 - 400,
    `${on(subtractMasks(parcel, unionMasks([house])))} px`);

  /*
   * THE CHECK THE OLD ARRANGEMENT FAILS.
   *
   * Subtracting both leaves 2,800. Inverting each mask and intersecting -- what
   * "invert: true" would have done with two masks -- leaves everything that is
   * neither, which on these two disjoint blobs happens to agree; the moment the
   * masks overlap at all, or either covers most of the frame, it does not. The
   * value of asserting the sum here is that it pins the arithmetic to
   * "accumulates", so a return to per-mask inversion changes a number.
   */
  const both = subtractMasks(parcel, unionMasks([house, trees]));
  check('two exclusions both come off, and the losses add up',
    on(both) === 3600 - 400 - 400, `${on(both)} px, wanted 2800`);

  /*
   * OVERLAPPING CONCEPTS MUST NOT BE CHARGED TWICE.
   *
   * "Trees" and "Woods" measured 61.5% and 58.3% of the same parcel -- almost
   * the same pixels. A union counts the shared ground once. Anything that
   * subtracted areas rather than pixels would take it off twice and report a
   * lawn smaller than the lot can hold.
   */
  const woods = rect(50, 50, 20, 20); // overlaps `trees` over 15x15
  const overlapping = subtractMasks(parcel, unionMasks([trees, woods]));
  check('overlapping exclusions are counted once, not twice',
    on(overlapping) === 3600 - on(unionMasks([trees, woods])),
    `${on(overlapping)} px left of 3600`);

  /* A mask reaching outside the lot cannot take the neighbours' land with it:
   * the property is the base, so there is nothing out there to remove. */
  const spilling = rect(0, 0, 40, 40); // half outside the parcel
  check('an exclusion that spills over the line only removes what is inside',
    on(subtractMasks(parcel, unionMasks([spilling]))) === 3600 - on(unionMasks([
      ((m) => { for (let p = 0; p < m.length; p++) m[p] &= parcel[p]; return m; })(spilling.slice()),
    ])));

  check('excluding nothing leaves the whole property',
    on(subtractMasks(parcel, unionMasks([]))) === 3600,
    'the union of no masks is nothing to remove, not everything');

  /*
   * THE COLLAPSE THIS MODEL ACTUALLY DOES. At the wrong cut a concept comes
   * back covering the entire frame; subtracting it leaves zero lawn. The
   * coverage reading is what lets the app drop that pass and name it rather
   * than reporting nought square feet with no explanation.
   */
  const everything = rect(0, 0, W, H);
  check('a flooded mask reads as covering the whole property',
    coverage(everything, parcel) === 1);
  check('and an ordinary one does not',
    Math.abs(coverage(house, parcel) - 400 / 3600) < 1e-9,
    `${coverage(house, parcel)}`);
  check('a mask entirely outside the lot reads as zero, not as an error',
    coverage(rect(0, 0, 10, 10), parcel) === 0);

  /*
   * ONE CONCEPT: THE TWO ARITHMETICS AGREE.
   *
   * This is what made the change safe to make. Inverting the house mask and
   * clipping to the parcel, and subtracting the house mask from the parcel,
   * are the same set -- so "Find grass" and single-box "Exclude" cannot
   * disagree about a lot, and the rebuild changed no existing measurement.
   */
  const inverted = new Uint8Array(W * H);
  for (let p = 0; p < inverted.length; p++) inverted[p] = (house[p] ^ 1) & parcel[p];
  const subtracted = subtractMasks(parcel, house);
  check('for one mask, inverting-then-clipping and subtracting are identical',
    inverted.every((v, p) => v === subtracted[p]),
    'which is why the old single-concept measurements still stand');

  /*
   * POLARITY IS NOT GUESSED IN EXCLUDE MODE.
   *
   * binarize flips a mask that is more than 90% white, on the premise that
   * nothing legitimately covers most of a frame. That premise is false for a
   * mask of the woods on a wooded lot, and guessing would hand back the LAWN
   * as the thing to remove -- confident, silent, exactly inverted.
   */
  const mostlyWhite = blankMask(20, 20);
  paintRect(mostlyWhite, 0, 0, 20, 19); // 95% on
  check('a mostly-white mask is read literally when asked to be',
    on(maskBinary(mostlyWhite, { autoPolarity: false })) === 380,
    `${on(maskBinary(mostlyWhite, { autoPolarity: false }))} px of 380`);
  check('and the guess is still there for the mode that wants it',
    on(maskBinary(mostlyWhite, { autoPolarity: true })) === 20,
    'find-grass keeps the polarity guard; exclude mode switches it off');

  /*
   * GAP FILLING GIVES BACK EXACTLY WHAT THE TICK BOX TOOK OFF.
   *
   * "Count grass under trees" fills an enclosed hole smaller than a large tree
   * canopy, on the reasoning that the detector could not see the grass beneath
   * it. Sound in find-grass mode, where a hole is somewhere the model failed to
   * find lawn.
   *
   * In exclude mode a hole is not a failure -- it IS the thing a ticked box
   * removed. So a tree clump under the canopy limit was subtracted and then
   * added straight back, and a 900 sq ft limit is a tree about 30 ft across:
   * most individual trees on an ordinary lot. The box did the least on exactly
   * the lots it was ticked for, and the amount given back grew with the number
   * of boxes, because every extra concept punches more holes.
   *
   * So it is off by default in exclude mode -- still offered, because the trees
   * prompt reads about 25% wider than the trees really are and asking for the
   * small gaps back is a reasonable thing to want, but never the silent
   * default.
   *
   * These clumps are 100 px each against a 400 px limit -- the same shape as a
   * scattered-tree lot, and the arithmetic to pin, because the tracer is where
   * it would come back.
   */
  const unproject = (x, y) => [x, y];
  const clumps = new Uint8Array(W * H);
  for (const [cx, cy] of [[30, 30], [50, 30], [30, 50], [50, 50]]) {
    for (let y = cy; y < cy + 10; y++) for (let x = cx; x < cx + 10; x++) clumps[y * W + x] = 1;
  }
  const trueLawn = subtractMasks(parcel, clumps);
  const filling = { clipMask: parcel, minAreaFraction: 0, minHoleFraction: 0, fillGapsUnderPx: 400 };

  const filled = polygonsFromBinary(trueLawn.slice(), W, H, unproject, filling);
  check('gap filling hands back ground the ticked box removed',
    filled.filledGapPx === on(clumps),
    `${filled.filledGapPx} px of the ${on(clumps)} px removed came straight back`);

  const honest = polygonsFromBinary(trueLawn.slice(), W, H, unproject,
    { ...filling, fillGapsUnderPx: 0 });
  check('and with it off, what was removed stays removed',
    honest.filledGapPx === 0 && honest[0].coordinates.length === 1 + 4,
    `${honest[0].coordinates.length - 1} holes traced, wanted 4`);

  /*
   * THE SAME HOLE IN THE OTHER LIMIT. Holes below minHoleFraction are not
   * traced either, which fills them just as silently and is not something the
   * tick box controls -- the default floor is around 90 sq ft on a typical
   * lot, which is a shed. Exclude mode drops it to roughly 40 sq ft, below
   * anything anyone would call an object, so a ticked box removes what it says
   * it removes.
   */
  const coarse = polygonsFromBinary(trueLawn.slice(), W, H, unproject,
    { clipMask: parcel, minAreaFraction: 0, minHoleFraction: 0.1, fillGapsUnderPx: 0 });
  check('a hole floor fills small exclusions back in without being asked to',
    coarse[0].coordinates.length === 1,
    `${coarse[0].coordinates.length - 1} of 4 holes survived a 10% floor`);

  /*
   * NOTHING IS DROPPED SILENTLY.
   *
   * The shape limits exist for the editor's sake -- speckle is not worth a
   * draggable handle, and forty handles on a phone is not usable -- but what
   * they drop is lawn, and it is exactly the fragments a second exclusion
   * creates. A total short by an unnamed amount is an error nobody can report,
   * so the tracer hands back what it left out and the screen says so.
   */
  const bands = new Uint8Array(W * H);
  for (let i = 0; i < 5; i++) {
    for (let y = 24 + i * 10; y < 28 + i * 10; y++) {
      for (let x = 20; x < 80; x++) bands[y * W + x] = 1;
    }
  }
  const fragmented = subtractMasks(parcel, bands);
  const strips = 6; // five bands across the lot leave six strips of grass

  const capped = polygonsFromBinary(fragmented.slice(), W, H, unproject,
    { clipMask: parcel, maxPolygons: 2, minAreaFraction: 0 });
  check('the shape cap reports the pieces it left out',
    capped.length === 2 && capped.droppedCount === strips - 2 && capped.droppedPx > 0,
    `${capped.length} kept, ${capped.droppedCount} dropped, ${capped.droppedPx} px`);

  const uncapped = polygonsFromBinary(fragmented.slice(), W, H, unproject,
    { clipMask: parcel, maxPolygons: 24, minAreaFraction: 0 });
  check('a cap large enough for a fragmented lawn drops nothing',
    uncapped.length === strips && uncapped.droppedCount === 0 && uncapped.droppedPx === 0,
    `${uncapped.length} kept, ${uncapped.droppedCount} dropped`);

  /* The dropped pixels are the lawn that is missing from the shapes, exactly. */
  check('and what was dropped accounts for the difference',
    capped.droppedPx === on(fragmented) - stripsPx(capped, labelComponents, fragmented),
    `${capped.droppedPx} px`);
}

/** Pixels belonging to the components a polygon list actually kept. */
function stripsPx(kept, label, mask) {
  const { sizes } = label(mask, 100, 100);
  return sizes.slice(1).sort((a, b) => b - a).slice(0, kept.length).reduce((n, v) => n + v, 0);
}

/* ------------------------------ 10. overlapping shapes on the map */
/*
 * THE ADDITIVE HALF OF THE SAME PROBLEM.
 *
 * Exclusions union, so two masks covering the same trees remove that ground
 * once. The shapes on the MAP had no such protection: geodesic area sums a
 * FeatureCollection, so a square drawn twice measured 97,620 sq ft where the
 * square itself is 48,810. The add brush, "Use property line" and drawing by
 * hand can all produce that, and it looked like a bigger lawn rather than a
 * bug.
 *
 * distinctFraction is the correction, and the property that matters most is
 * the one about shapes that DON'T overlap: it must return exactly 1, so an
 * ordinary lawn measures exactly what it measured before.
 */
{
  const W = 200;
  const H = 200;
  // A plain pixel-space projection: this function's job is set overlap, and a
  // real map projection would only add curvature to an answer about pixels.
  const project = ([x, y]) => [x, y];
  const box = (x0, y0, w, h) => [[
    [x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0],
  ]];

  check('one shape needs no correction at all',
    distinctFraction([box(10, 10, 50, 50)], W, H, project) === 1);

  check('two shapes that do not touch measure exactly as before',
    distinctFraction([box(10, 10, 40, 40), box(100, 100, 40, 40)], W, H, project) === 1,
    'anything other than exactly 1 here would move every ordinary measurement');

  /*
   * TOUCHING IS NOT OVERLAPPING. Front and back lawn meeting along the side of
   * a house share an edge and no ground; a correction that fired on that would
   * quietly shave real lawn off most results.
   */
  check('and shapes that merely share an edge are not counted as overlapping',
    distinctFraction([box(10, 10, 40, 40), box(50, 10, 40, 40)], W, H, project) === 1);

  /* The same shape twice: half the sum is duplicate, so half of it survives. */
  const twice = distinctFraction([box(20, 20, 60, 60), box(20, 20, 60, 60)], W, H, project);
  check('the same shape drawn twice counts once',
    Math.abs(twice - 0.5) < 1e-9, `${twice}`);

  /*
   * A QUARTER OVERLAP, checked against arithmetic rather than against itself.
   * Two 60x60 squares offset by 30 in both axes share a 30x30 corner: the sum
   * is 7,200 px, the distinct ground is 6,300, so 0.875.
   */
  const quarter = distinctFraction([box(20, 20, 60, 60), box(50, 50, 60, 60)], W, H, project);
  check('a partial overlap is measured, not guessed',
    Math.abs(quarter - 6300 / 7200) < 0.01, `${quarter} vs ${(6300 / 7200).toFixed(4)}`);

  /* Three shapes stacked on one another must not subtract the shared ground
   * twice over -- a pixel is either counted or it is not. */
  const thrice = distinctFraction(
    [box(20, 20, 60, 60), box(20, 20, 60, 60), box(20, 20, 60, 60)], W, H, project);
  check('three copies still count the ground exactly once',
    Math.abs(thrice - 1 / 3) < 1e-9, `${thrice}`);

  /*
   * A HOLE IS NOT LAWN, so ground under a shape's cut-out is not "shared" with
   * the shape sitting in it. Rasterising fills even-odd, so this comes out
   * right without being special-cased -- which is worth pinning, because a
   * lawn wrapping a flower bed is the ordinary case, not an exotic one.
   */
  const ring = [
    [[20, 20], [100, 20], [100, 100], [20, 100], [20, 20]],
    [[40, 40], [80, 40], [80, 80], [40, 80], [40, 40]],
  ];
  const inHole = box(45, 45, 30, 30);
  check('a shape sitting in another shape\'s hole overlaps nothing',
    distinctFraction([ring, inHole], W, H, project) === 1,
    'the hole is not lawn, so nothing there is being counted twice');
}

/* ------------------------------------------------- the over-trimmed notice */
/*
 * The case this was built from, and the cases it must stay silent for.
 *
 * A notice that fires on every ordinary detection is worse than none: people
 * stop reading the status line, and the messages that matter -- a collapsed
 * pass, uncounted scraps -- go with it. So the quiet cases are tested as
 * carefully as the loud one.
 */
{
  const whiteTrellis = { subtractive: true, trimmedTrees: true, lawnSqFt: 2353, parcelSqFt: 12830 };

  check('the lot this was built from trips the notice',
    overTrimmed(whiteTrellis) === true,
    '2,353 of 12,830 sq ft is 18% of the lot');

  check('and the hand-drawn answer for the same lot does not',
    overTrimmed({ ...whiteTrellis, lawnSqFt: 3700 }) === false,
    '3,700 sq ft is 29%, inside what a small lawn can be');

  /*
   * The pass with the documented overshoot is the trees one. Buildings held to
   * within 1% across the whole threshold range on the measured lot, so a small
   * lawn behind them alone is not evidence of over-trimming.
   */
  check('buildings alone never trip it, however small the lawn',
    overTrimmed({ ...whiteTrellis, trimmedTrees: false }) === false,
    'only the trees pass reads wide');

  check('find-grass mode never trips it',
    overTrimmed({ ...whiteTrellis, subtractive: false }) === false,
    'nothing was trimmed, so there is nothing to push back out');

  /*
   * Zero already says "everything inside your property line was excluded,
   * untick a box". Adding a second sentence about the same emptiness, pointing
   * at a control that cannot recover anything from nothing, is noise.
   */
  check('an empty result stays with its own message',
    overTrimmed({ ...whiteTrellis, lawnSqFt: 0 }) === false,
    'the zero case is already explained elsewhere');

  check('and no property line means no fraction to judge',
    overTrimmed({ ...whiteTrellis, parcelSqFt: 0 }) === false,
    'dividing by a parcel nobody found is not a measurement');

  /*
   * A genuinely small lawn on a big wooded lot is a real answer. Guarded
   * because the whole risk of this feature is telling people their correct
   * result is wrong.
   */
  check('a big lot that really is mostly woods is left alone at 30%',
    overTrimmed({ subtractive: true, trimmedTrees: true, lawnSqFt: 24000, parcelSqFt: 80000 }) === false,
    '30% sits inside the believable band');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);