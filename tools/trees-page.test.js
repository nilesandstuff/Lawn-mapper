/**
 * The tree labelling page's own arithmetic (public/trees.js).
 *   node tools/trees-page.test.js
 */
import { patchIds, dab, fillAt, counts } from '../public/trees.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
const w = 60, h = 40;
const clumps = [{ polygon: sq(5, 5, 20) }, { polygon: sq(35, 5, 20), holes: [sq(40, 10, 10)] }];
const ids = patchIds(clumps, w, h);
check('each patch has its own number, a clearing none', ids[10 * w + 10] === 1 && ids[8 * w + 37] === 2 && ids[15 * w + 45] === 0 && ids[35 * w + 2] === 0);

const labels = new Uint8Array(w * h);
dab(labels, ids, w, h, 25, 15, 8, 3);
check('the brush paints only inside the canopy', labels[15 * w + 24] === 3 && labels[15 * w + 30] === 0 && labels[15 * w + 26] === 0,
  `${labels[15 * w + 24]} ${labels[15 * w + 30]}`);
const k = fillAt(labels, ids, w, 37, 8, 1);
let whole = true;
for (let i = 0; i < ids.length; i++) if (ids[i] === 2 && labels[i] !== 1) whole = false;
check('a tap fills the whole patch it lands in, and only that one', k === 2 && whole && labels[10 * w + 10] === 0);
check('a tap off the canopy fills nothing', fillAt(labels, ids, w, 2, 35, 4) === 0);
const n = counts(labels, ids, 0.01);
check('the areas add up to the canopy', Math.abs(n.unlabelled + n.evergreen + n.bare - (400 + 300) * 0.01) < 0.11, JSON.stringify(n));

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\ntrees page: ok');
