/**
 * The brush must leave every corner it did not cover EXACTLY where it was --
 * on small, fine-tuned shapes too, which is where the pixel round trip
 * rebuilt the whole outline.
 *
 *   node tools/brush-vector.test.js
 */

import { readFileSync } from 'node:fs';
import { strokeOnShapes } from '../public/lib/brush-vector.js';

// The page loads the UMD build with a <script> tag; the package here is
// "type": "module", so node would read it as ESM. Run it as the page does.
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

const LAT = 43.0;
const at = (e, n) => [-85.6 + e / (111320 * Math.cos((LAT * Math.PI) / 180)), LAT + n / 111320];
const disc = (cx, cy, r, k = 24) => {
  const ring = [];
  for (let i = 0; i < k; i++) ring.push(at(cx + r * Math.cos((2 * Math.PI * i) / k), cy + r * Math.sin((2 * Math.PI * i) / k)));
  return [[...ring, ring[0]]];
};
const has = (geoms, p) => geoms.some((g) => g.coordinates.some((r) => r.some((q) => q[0] === p[0] && q[1] === p[1])));

// A small fine-tuned shape: 1.5 m across, a corner every 10-20 cm.
const tiny = [];
for (let i = 0; i < 30; i++) {
  const t = (2 * Math.PI * i) / 30;
  const r = 0.75 + 0.06 * Math.sin(5 * t);
  tiny.push(at(r * Math.cos(t), r * Math.sin(t)));
}
const tinyPoly = [[...tiny, tiny[0]]];

const erased = strokeOnShapes([tinyPoly], [disc(0.75, 0, 0.2)], { paint: false, clip });
const far = tiny.filter((p, i) => {
  const t = (2 * Math.PI * i) / 30;
  return Math.hypot(0.75 * Math.cos(t) - 0.75, 0.75 * Math.sin(t)) > 0.35;
});
check('an erase notch on a 1.5 m shape leaves every far corner exactly in place',
  far.every((p) => has(erased, p)), `${far.filter((p) => !has(erased, p)).length} of ${far.length} moved`);
check('and it is still one shape', erased.length === 1);

const added = strokeOnShapes([tinyPoly], [disc(-0.8, 0, 0.25)], { paint: true, clip });
const farAdd = tiny.filter((p, i) => Math.cos((2 * Math.PI * i) / 30) > -0.3);
check('an add stroke on one side leaves the other side exactly in place', farAdd.every((p) => has(added, p)));

const big = [[at(0, 0), at(20, 0), at(20, 15), at(0, 15), at(0, 0)]];
const hole = strokeOnShapes([big], [disc(10, 7, 1)], { paint: false, clip });
check('erasing in the middle makes a hole and keeps the four corners',
  hole.length === 1 && hole[0].coordinates.length === 2 && big[0].every((p) => has(hole, p)));

const gone = strokeOnShapes([disc(0, 0, 0.1)], [disc(0, 0, 0.5)], { paint: false, clip });
check('rubbing a whole small shape out leaves nothing', gone.length === 0);

const two = strokeOnShapes([[[at(0, 0), at(4, 0), at(4, 1), at(0, 1), at(0, 0)]]], [[[at(1.9, -1), at(2.1, -1), at(2.1, 2), at(1.9, 2), at(1.9, -1)]]], { paint: false, clip });
check('an erase right across a strip cuts it in two', two.length === 2);

const sliver = strokeOnShapes([big], [[[at(-1, -1), at(21, -1), at(21, 14.999), at(-1, 14.999), at(-1, -1)]]], { paint: false, clip });
check('a sliver thinner than the brush could mean is dropped', sliver.length === 0, JSON.stringify(sliver.length));

check('no clip library: null, so the caller falls back', strokeOnShapes([big], [disc(1, 1, 1)], { paint: true, clip: null }) === null);

if (failures) { console.log(`\n${failures} failed.`); process.exit(1); }
console.log('\nAll checks passed.');
