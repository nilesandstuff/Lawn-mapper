/**
 * The property line out to the road, and the neighbouring parcels -- on the
 * owner's own list of awkward lots (2026-09-27).
 *
 *   node tools/frontage.test.js
 */

import { readFileSync } from 'node:fs';
import { extendToRoads, mergeButtonPoint, mergeRings, placeInside } from '../public/lib/frontage.js';
import { makeFrame, openRing } from '../public/lib/edges.js';
import { envelopeParams } from '../worker/src/parcel.js';

const clip = (() => {
  const module = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../public/lib/vendor/polygon-clipping.umd.min.js', import.meta.url), 'utf8'))(module, module.exports);
  return module.exports;
})();

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const F = makeFrame([-85.6, 43.0]);
const ll = (x, y) => F.toLngLat([x, y]);
const ring = (...xy) => { const r = xy.map(([x, y]) => ll(x, y)); return [...r, r[0]]; };
const xy = (r) => openRing(r).map(F.toXY);
const near = (a, b, tol = 0.05) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
const road = (cls, ...pts) => ({ cls, coords: pts.map(([x, y]) => ll(x, y)) });
const show = (r) => xy(r).map(([x, y]) => `(${x.toFixed(2)},${y.toFixed(2)})`).join(' ');

// A 20 x 30 m lot, front on y = 0, a residential street's centreline 9 m in front (y = -9):
// pavement edge at y = -5, so the front moves 5 m and the sides extend straight down.
const lot = ring([0, 0], [0, 30], [20, 30], [20, 0]);
const street = road('street', [-100, -9], [100, -9]);
let r = extendToRoads(lot, [street], { clip });
check('the front moves to the pavement edge and the sides follow at their own angle',
  r.moved.length === 1 && near(xy(r.ring)[0], [0, -5]) && near(xy(r.ring)[3], [20, -5]), show(r.ring));
check('and the back corners do not move', near(xy(r.ring)[1], [0, 30]) && near(xy(r.ring)[2], [20, 30]));

// No setback: the parcel already runs to the pavement.
r = extendToRoads(lot, [road('street', [-100, -4], [100, -4])], { clip });
check('a lot already at the road is left alone', r.moved.length === 0 && r.ring === lot);

// Too far: the road is 40 m away (a big front lawn behind a wide verge is not this).
r = extendToRoads(lot, [road('street', [-100, -44], [100, -44])], { clip });
check('a road beyond the 20 ft limit moves nothing', r.moved.length === 0);

// Corner lot: a second street down the west side, centreline at x = -9.
r = extendToRoads(lot, [street, road('street', [-9, -100], [-9, 100])], { clip });
const c = xy(r.ring);
check('a corner lot moves both frontages, and they meet at the new corner',
  r.moved.length === 2 && near(c[0], [-5, -5]) && near(c[1], [-5, 30]) && near(c[3], [20, -5]), show(r.ring));

// A service road (driveway, alley) is not frontage.
r = extendToRoads(lot, [road('service', [-100, -9], [100, -9])], { clip });
check('a service road or alley is not frontage', r.moved.length === 0);

// The shared-driveway point: a lot whose only approach to the road is one corner.
const diamond = ring([0, -2], [-15, 12], [0, 26], [15, 12]);
r = extendToRoads(diamond, [street], { clip });
check('one corner near the road, no edge along it: nothing moves', r.moved.length === 0);

// The flag lot: a house lot 40 m back with a 4 m access strip down to the road.
const flag = ring([8, 0], [8, 40], [0, 40], [0, 70], [20, 70], [20, 40], [12, 40], [12, 0]);
r = extendToRoads(flag, [street], { clip });
const f = xy(r.ring);
check('the flag lot: the end of the strip moves, the house lot does not',
  r.moved.length === 1 && near(f[0], [8, -5]) && near(f[7], [12, -5]) && near(f[3], [0, 70]) && near(f[2], [0, 40]), show(r.ring));

// A neighbour in the way: the lot behind another. The road-side parcel fills the strip.
const inFront = ring([-5, -6], [-5, 0], [25, 0], [25, -6]);
r = extendToRoads(lot, [street], { clip, neighbours: [inFront] });
check('a parcel in front of this one stops it', r.moved.length === 0 && r.skipped.some((s) => /parcel/.test(s.reason)), JSON.stringify(r.skipped));

// A neighbour beside, not in front: does not stop it.
const beside = ring([20, 0], [20, 30], [40, 30], [40, 0]);
r = extendToRoads(lot, [street], { clip, neighbours: [beside] });
check('a neighbour beside the lot does not stop it', r.moved.length === 1);

// A bent frontage along a gently curving road: two edges at an angle, both move, still one clean outline.
const bent = ring([0, 0], [0, 30], [30, 30], [30, 3], [15, 0]);
const curve = road('street', [-50, -9], [15, -9], [60, 0]);
r = extendToRoads(bent, [curve], { clip });
check('a bent frontage moves as one piece', r.moved.length === 2 && clip.union([r.ring]).length === 1, show(r.ring));

// Merging: two lots that share a side.
const merged = mergeRings(clip, lot, beside);
check('two adjoining parcels merge into one outline', merged && Math.abs(openRing(merged).length - 4) <= 2, merged && show(merged));
const gap = ring([20.2, 0], [20.2, 30], [40, 30], [40, 0]);
check('a hair\'s gap between them (20 cm) still merges', mergeRings(clip, lot, gap) !== null);
// The owner's case (2026-09-27): the button showed and the merge did nothing.
// A 1.5 m gap between the two lines, corners not opposite each other.
const gapped = ring([21.5, -3], [21.5, 33], [40, 33], [40, -3]);
check('a gap the button allows (1.5 m, corners not lined up) merges too',
  mergeButtonPoint(lot, gapped) !== null && mergeRings(clip, lot, gapped) !== null);
check('a parcel across the street does not', mergeRings(clip, lot, ring([0, -20], [0, -50], [20, -50], [20, -20])) === null);

const btn = mergeButtonPoint(lot, beside);
const b = btn && F.toXY(btn);
check('the merge button sits inside the neighbour, about 20 ft from the shared line',
  b && b[0] > 25 && b[0] < 27.5 && b[1] > 0 && b[1] < 30, b && b.map((v) => v.toFixed(2)).join(','));
check('no button on a parcel that does not touch this one', mergeButtonPoint(lot, ring([0, -20], [0, -50], [20, -50], [20, -20])) === null);

const q = envelopeParams([-85.61, 43.02, -85.60, 43.03], "STATUS='A'");
check('the neighbours query is an envelope in WGS84, with the county\'s own filter',
  q.geometryType === 'esriGeometryEnvelope' && JSON.parse(q.geometry).xmin === -85.61 && q.inSR === '4326' && q.where === "STATUS='A'");

// The button, whole inside the parcel or nowhere.
const box = [[0, 0], [300, 0], [300, 200], [0, 200], [0, 0]];
const at = placeInside(box, [150, 100], 120, 26);
check('a button fits where it was asked to go', at && at[0] === 150 && at[1] === 100);
const edge = placeInside(box, [5, 100], 120, 26);
check('asked to sit on the edge, it moves inside instead of overhanging',
  edge && edge[0] - 60 >= 0 && edge[0] + 60 <= 300, edge && edge.join(','));
check('a parcel too small on screen gets no button at all', placeInside([[0, 0], [60, 0], [60, 20], [0, 20], [0, 0]], [30, 10], 120, 26) === null);
const ell = [[0, 0], [300, 0], [300, 40], [40, 40], [40, 200], [0, 200], [0, 0]];
const inL = placeInside(ell, [20, 100], 120, 26);
check('in an L-shaped parcel it goes where it fits whole, not across the notch',
  inL && inL[1] + 16 <= 40 && inL[1] - 16 >= 0, inL && inL.join(','));

const dodged = placeInside(box, [150, 100], 120, 26, { avoid: [[60, 60, 240, 140]] });
check('and it keeps out from under the tip box floating over the map (the owner\'s tap that did nothing)',
  dodged && (dodged[1] + 16 <= 60 || dodged[1] - 16 >= 140 || dodged[0] + 63 <= 60 || dodged[0] - 63 >= 240), dodged && dodged.join(','));

if (failures) { console.log(`\n${failures} failed.`); process.exit(1); }
console.log('\nAll checks passed.');
