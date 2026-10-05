/**
 * The tree-labelling maps (tools/tree-maps.js): only canopy on the lawn.
 *   node tools/tree-maps.test.js
 */
import { clumpsOnLawn, lawnMask } from './tree-maps.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

/* A 100 x 100 photo at 0.1 m a pixel (0.01 m2 a pixel); the lawn is the left half. */
const w = 100, h = 100;
const lawn = lawnMask([[[[0, 0], [50, 0], [50, 100], [0, 100], [0, 0]]]], w, h);
const clumps = [
  { polygon: sq(10, 10, 20), areaSqM: 4 },          // wholly on the lawn
  { polygon: sq(45, 60, 20), areaSqM: 4 },          // half on it
  { polygon: sq(70, 10, 20), areaSqM: 4 },          // off it
  { polygon: sq(10, 60, 20), holes: [sq(12, 62, 16)], areaSqM: 1 }, // a ring of canopy round a clearing
];
const kept = clumpsOnLawn(clumps, lawn, w, h, 0.01, 1);
check('canopy on the lawn is kept, canopy off it is left out',
  kept.length === 3 && !kept.some((c) => c.polygon[0][0] === 70), JSON.stringify(kept.map((c) => [c.polygon[0], c.onLawnSqM])));
check('and how much of each is on the lawn is said',
  Math.abs(kept[0].onLawnSqM - 4) < 0.5 && kept[1].onLawnSqM < 2, kept.map((c) => c.onLawnSqM).join(', '));
check('a clearing inside a patch is not counted as canopy on the lawn',
  kept[2].onLawnSqM < 2 && kept[2].holes.length === 1, String(kept[2].onLawnSqM));
check('a sliver under the bar is left out', clumpsOnLawn([{ polygon: sq(49, 0, 3) }], lawn, w, h, 0.01, 1).length === 0);

/* B13 (owner, 2026-10-04): evergreens traced round as holes in the lawn. */
const holed = lawnMask([[[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], sq(40, 40, 20)]], w, h);
check('a tree traced round, as a hole in the lawn, is in the lawn',
  clumpsOnLawn([{ polygon: sq(42, 42, 16) }], holed, w, h, 0.01, 1).length === 1);
const two = lawnMask([[[[0, 0], [45, 0], [45, 100], [0, 100], [0, 0]]], [[[55, 0], [100, 0], [100, 100], [55, 100], [55, 0]]]], w, h, 10);
check('and a tree in the gap between two traced pieces, within the reach', clumpsOnLawn([{ polygon: sq(46, 20, 8) }], two, w, h, 0.01, 0.3).length === 1);
check('but not one well away from the lawn',
  clumpsOnLawn([{ polygon: sq(70, 70, 10) }], lawnMask([[[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]]]], w, h, 10), w, h, 0.01, 0.3).length === 0);

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\ntree maps: ok');
