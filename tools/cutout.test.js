/**
 * A Cut out reaching the lawn's edge takes a notch out (public/lib/cutout.js).
 *   node tools/cutout.test.js
 */
import { readFileSync } from 'node:fs';
import { notchShapes } from '../public/lib/cutout.js';

// The UMD build, run as the page runs it (see brush-vector.test.js).
const clip = (() => {
  const module = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../public/lib/vendor/polygon-clipping.umd.min.js', import.meta.url), 'utf8'))(module, module.exports);
  return module.exports;
})();

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}
const area = (r) => Math.abs(r.slice(0, -1).reduce((s, [x, y], i) => {
  const [x2, y2] = r[i + 1]; return s + x * y2 - x2 * y;
}, 0)) / 2;
const polyArea = (p) => area(p[0]) - p.slice(1).reduce((s, h) => s + area(h), 0);
const total = (ps) => ps.reduce((s, p) => s + polyArea(p), 0);

const lawn = [[[0, 0], [100, 0], [100, 50], [0, 50], [0, 0]]];   // 5000
const other = [[[300, 0], [400, 0], [400, 50], [300, 50], [300, 0]]];

// A patio on the right edge: two corners snapped onto x = 100.
const onEdge = [[80, 10], [100, 10], [100, 30], [80, 30], [80, 10]];
let [a, b] = notchShapes(clip, [lawn, other], onEdge);
check('a cut with corners on the lawn edge takes a notch out', a && Math.abs(total(a) - 4600) < 1e-6,
  a && String(total(a)));
check('and leaves a shape it does not touch alone', b === null);

// Hanging over the edge: the part outside is simply not lawn to begin with.
const over = [[80, 10], [130, 10], [130, 30], [80, 30], [80, 10]];
[a] = notchShapes(clip, [lawn], over);
check('a cut hanging past the edge removes only what was lawn', a && Math.abs(total(a) - 4600) < 1e-6,
  a && String(total(a)));

// Right across the lawn: it splits in two.
const across = [[40, -10], [60, -10], [60, 60], [40, 60], [40, -10]];
[a] = notchShapes(clip, [lawn], across);
check('a cut right across a shape leaves two pieces', a && a.length === 2 && Math.abs(total(a) - 4000) < 1e-6,
  a && `${a.length} piece(s), ${total(a)}`);

// Over everything: nothing left.
[a] = notchShapes(clip, [lawn], [[-10, -10], [110, -10], [110, 60], [-10, 60], [-10, -10]]);
check('a cut over the whole shape leaves nothing', Array.isArray(a) && a.length === 0);

// Corners the person placed stay exactly where they were.
[a] = notchShapes(clip, [lawn], onEdge);
const pts = a[0][0].map((p) => p.join(','));
check('the cut\'s own corners are kept exactly', ['80,10', '80,30', '100,10', '100,30'].every((p) => pts.includes(p)),
  pts.join(' '));

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
