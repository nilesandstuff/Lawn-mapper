/**
 * Ground-truth checks for area.js.
 * Run from the repo root: node tools/area.test.js
 *
 * Imports the canonical copy from worker/src -- that is the version that
 * actually runs in production, so this test needs to exercise that file,
 * not a separate copy that could drift out of sync with it.
 */
import { measure, geometryAreaSqM, SQM_PER_SQFT } from '../worker/src/area.js';

let failures = 0;
function check(label, actual, expected, tolerancePct) {
  const errPct = Math.abs((actual - expected) / expected) * 100;
  const ok = errPct <= tolerancePct;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${actual.toFixed(1)}  expected ~${expected.toFixed(1)}  (${errPct.toFixed(3)}% off)`
  );
}

// --- Test 1: rectangle of independently known size at Rockford, MI latitude
// 0.001 deg lat x 0.001 deg lng centered near 43.12N.
// 1 deg lat  ~ 111,132 m ; 1 deg lng ~ 111,320 * cos(lat)
const LAT = 43.12;
const dLatM = 111132.95 * 0.001;
const dLngM = 111319.49 * Math.cos((LAT * Math.PI) / 180) * 0.001;
const expectedSqM = dLatM * dLngM;

const rect = {
  type: 'Polygon',
  coordinates: [[
    [-85.560, LAT],
    [-85.559, LAT],
    [-85.559, LAT + 0.001],
    [-85.560, LAT + 0.001],
    [-85.560, LAT],
  ]],
};
// Tolerance is 0.25%, not 0.01%, and that gap is expected rather than sloppy:
// the spherical-excess method models Earth as a sphere while the expected
// value above uses ellipsoidal degree lengths. The residual is ~0.17% at this
// latitude -- about 8 sq ft on a 5,000 sq ft lawn, far below the error from
// 0.5 ft/px imagery and a hand-traced boundary. Turf.js carries the same
// approximation. Not worth an ellipsoidal rewrite.
check('rectangle at 43.12N', geometryAreaSqM(rect), expectedSqM, 0.25);

// --- Test 2: the Web Mercator trap.
// Project the same rectangle to EPSG:3857 and compute planar area.
// If we ever feed projected coords into a planar area function, this is
// the magnitude of the error we would silently ship.
const R = 6378137;
const toMerc = ([lng, lat]) => [
  R * (lng * Math.PI) / 180,
  R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2)),
];
const mercRing = rect.coordinates[0].map(toMerc);
let shoelace = 0;
for (let i = 0; i < mercRing.length - 1; i++) {
  shoelace += mercRing[i][0] * mercRing[i + 1][1] - mercRing[i + 1][0] * mercRing[i][1];
}
const mercArea = Math.abs(shoelace / 2);
const inflation = mercArea / expectedSqM;
console.log(
  `\nINFO  Web Mercator planar area would be ${inflation.toFixed(3)}x the true area at ${LAT}N`
);
console.log(`      (predicted 1/cos^2(lat) = ${(1 / Math.cos((LAT * Math.PI) / 180) ** 2).toFixed(3)}x)`);

// --- Test 3: hole subtraction (tree canopy / driveway cutout)
const withHole = {
  type: 'Polygon',
  coordinates: [
    rect.coordinates[0],
    [
      [-85.5598, LAT + 0.0002],
      [-85.5594, LAT + 0.0002],
      [-85.5594, LAT + 0.0006],
      [-85.5598, LAT + 0.0006],
      [-85.5598, LAT + 0.0002],
    ],
  ],
};
const solid = geometryAreaSqM(rect);
const holed = geometryAreaSqM(withHole);
console.log(
  `\n${holed < solid ? 'PASS' : 'FAIL'}  hole subtraction: ${solid.toFixed(0)} -> ${holed.toFixed(0)} sqm`
);
if (holed >= solid) failures++;

// --- Test 4: a realistic quarter-acre suburban lawn, sanity check
const quarterAcreSqM = 4046.86 / 4;
console.log(
  `\nINFO  reference: 1/4 acre = ${(quarterAcreSqM / SQM_PER_SQFT).toFixed(0)} sq ft`
);

// --- Test 5: winding order must not matter
const reversed = {
  type: 'Polygon',
  coordinates: [rect.coordinates[0].slice().reverse()],
};
check('reversed winding order', geometryAreaSqM(reversed), expectedSqM, 0.25);

// --- Test 6: measure() output shape
const m = measure(rect);
console.log('\nmeasure() output:', JSON.stringify(m, null, 2));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
