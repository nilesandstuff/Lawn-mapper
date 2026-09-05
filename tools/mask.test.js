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
  binarize,
  labelComponents,
  traceRegion,
  simplify,
  maskToPolygons,
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

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
