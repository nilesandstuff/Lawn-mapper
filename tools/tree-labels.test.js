/**
 * The tree-label reader (tools/tree-labels.js).
 *   node tools/tree-labels.test.js
 */
import { crowns, features, auc, heldOutCut, heldOutLogistic } from './tree-labels.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

/* Two patches; patch 1 painted half evergreen, half bare; patch 2 all bare. */
const w = 20, h = 10;
const ids = new Int32Array(w * h), labels = new Uint8Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x;
  if (x < 10) { ids[i] = 1; labels[i] = x < 5 ? 1 : 3; } else if (x > 11) { ids[i] = 2; labels[i] = 3; }
}
const cs = crowns(labels, ids, w, h);
check('a crown is one label inside one patch', cs.length === 3 && cs.every((c) => c.px.length === 50 || c.px.length === 80),
  cs.map((c) => `${c.code}:${c.px.length}`).join(' '));

/* Green foliage against grey branches over brown. */
const rgba = new Uint8Array(w * h * 4);
for (let i = 0; i < w * h; i++) {
  const green = (i % w) < 5;
  rgba.set(green ? [40, 110, 40, 255] : [125, 105, 95, 255], i * 4);
}
const f1 = features(cs[0].px, rgba, w, h, null), f3 = features(cs[1].px, rgba, w, h, null);
check('foliage reads green, branches grey-brown', f1.leafyShare === 1 && f3.greyBrownShare === 1 && f3.exg < 0 && f1.exg > 0.2);

check('AUC: perfectly separated is 1, the other way 0, mixed 0.5',
  auc([3, 4], [1, 2]) === 1 && auc([1, 2], [3, 4]) === 0 && auc([1, 2], [1, 2]) === 0.5);

/* Held out by map: a feature that separates on every map scores 100%. */
const rows = [];
for (const map of ['A', 'B', 'C', 'D']) {
  for (let k = 0; k < 5; k++) {
    rows.push({ map, y: true, f: { a: 1 + k * 0.01, b: Math.random() } });
    rows.push({ map, y: false, f: { a: 0 + k * 0.01, b: Math.random() } });
  }
}
check('a cut that holds on every map is 100% held out', heldOutCut(rows, 'a') === 1);
check('and a classifier over it gets it too', heldOutLogistic(rows, ['a', 'b']) >= 0.9, String(heldOutLogistic(rows, ['a', 'b'])));

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\ntree labels: ok');
