/**
 * Trunks from the crowns and the stem returns under them (water/lib/trunks.js).
 *   node water/test/trunks.test.js
 */
import assert from 'node:assert/strict';
import { trunksOf } from '../lib/trunks.js';
import { makeColumns } from '../lib/las.js';
import { rng, gauss, LAT, LNG } from '../lib/synthetic.js';
import { toMerc, mercScale } from '../lib/ept.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok  ${name}`); }

/** A flat lot with ground returns, trees (dome crowns, optional stem returns) and a flat roof nobody sees under. */
function lot({ size = 60, density = 1.5, trees = [], roofs = [], seed = 3 }) {
  const r = rng(seed), k = mercScale(LAT), [x0, y0] = toMerc([LNG, LAT]);
  const pts = [];
  const inRoof = (x, y) => roofs.find(([a, b, c, d]) => x >= a && x < c && y >= b && y < d);
  const inTree = (x, y) => trees.find((t) => Math.hypot(x - t.x, y - t.y) < t.R);
  const nG = Math.round(size * size * density);
  for (let m = 0; m < nG; m++) {
    const x = r() * size, y = r() * size;
    if (inRoof(x, y)) continue;
    const t = inTree(x, y);
    if (t && r() < 0.85) continue; // the crown stops most pulses
    pts.push({ x, y, z: 0.02 * gauss(r), cls: 2, ret: t ? 2 : 1, nret: t ? 2 : 1 });
  }
  for (const [a, b, c, d] of roofs) for (let m = 0; m < (c - a) * (d - b) * 4; m++) pts.push({ x: a + r() * (c - a), y: b + r() * (d - b), z: 6 + 0.03 * gauss(r), cls: 1, ret: 1, nret: 1 });
  for (const t of trees) {
    for (let m = 0; m < Math.PI * t.R * t.R * 2.5; m++) {
      const rr = t.R * Math.sqrt(r()), th = r() * 2 * Math.PI, x = t.x + rr * Math.cos(th), y = t.y + rr * Math.sin(th);
      const zTop = t.H - (rr / t.R) ** 2 * (t.H * 0.45), inside = r() < 0.5;
      pts.push({ x, y, z: inside ? zTop - r() * t.H * 0.3 : zTop + 0.1 * gauss(r), cls: 1, ret: inside ? 2 : 1, nret: 2 });
    }
    for (let m = 0; m < (t.stem || 0); m++) pts.push({ x: t.sx + 0.15 * gauss(r), y: t.sy + 0.15 * gauss(r), z: 0.6 + r() * 1.8, cls: 1, ret: 2, nret: 2 });
  }
  const cols = makeColumns(pts.length);
  pts.forEach((p, i) => { cols.x[i] = x0 + p.x / k; cols.y[i] = y0 + p.y / k; cols.z[i] = p.z; cols.cls[i] = p.cls; cols.ret[i] = p.ret; cols.nret[i] = p.nret; });
  const bbox = [x0, y0, x0 + size / k, y0 + size / k];
  return { cols, bbox, k, x0, y0 };
}
const at = (l, x, y) => [l.x0 + x / l.k, l.y0 + y / l.k];

test('a tree with stem returns gets its trunk at the stem; one without, at its top; a roof is no tree', () => {
  const trees = [{ x: 20, y: 30, R: 5, H: 12, stem: 6, sx: 21.6, sy: 28.9 }, { x: 42, y: 14, R: 4, H: 8 }];
  const l = lot({ trees, roofs: [[4, 44, 16, 54]] });
  const { trunks } = trunksOf(l.cols, l.bbox, LAT);
  const near = (t, x, y) => Math.hypot(t.x - at(l, x, y)[0], t.y - at(l, x, y)[1]) * l.k;
  const a = trunks.filter((t) => near(t, 20, 30) < 6), b = trunks.filter((t) => near(t, 42, 14) < 6);
  assert.equal(a.length, 1, `one crown at the first tree, got ${a.length} of ${trunks.length}`);
  assert.equal(b.length, 1, `one crown at the second tree, got ${b.length} of ${trunks.length}`);
  assert.equal(a[0].how, 'stem'); assert.ok(a[0].stemReturns >= 3);
  assert.ok(near(a[0], 21.6, 28.9) < 0.7, `stem trunk ${near(a[0], 21.6, 28.9).toFixed(2)} m off`);
  assert.equal(b[0].how, 'top'); assert.ok(near(b[0], 42, 14) < 1.5, `top trunk ${near(b[0], 42, 14).toFixed(2)} m off`);
  assert.ok(Math.abs(a[0].H - 12) < 1.5 && Math.abs(a[0].R - 5) < 2, `H ${a[0].H} R ${a[0].R}`);
  const onRoof = trunks.filter((t) => { const x = (t.x - l.x0) * l.k, y = (t.y - l.y0) * l.k; return x >= 4 && x < 16 && y >= 44 && y < 54; });
  assert.equal(onRoof.length, 0, 'no trunk on the roof');
  assert.ok(Number.isFinite(a[0].lng) && Math.abs(a[0].lat - LAT) < 0.01);
});

test('stem returns too few, or too high up the crown, do not make a stem', () => {
  const l = lot({ trees: [{ x: 30, y: 30, R: 5, H: 12, stem: 2, sx: 31, sy: 29 }] });
  const { trunks } = trunksOf(l.cols, l.bbox, LAT);
  assert.equal(trunks.length >= 1 && trunks[0].how, 'top');
  // a low crown: 0.4 x 4.5 m = 1.8 m, so returns at 2-2.4 m are its underside, not a stem
  const l2 = lot({ trees: [{ x: 30, y: 30, R: 3, H: 4.5 }] });
  const r2 = rng(9); for (let m = 0; m < 8; m++) { /* no stem points added: nothing to find */ r2(); }
  const { trunks: t2 } = trunksOf(l2.cols, l2.bbox, LAT);
  assert.ok(t2.every((t) => t.how === 'top'));
});

test('two trees the canopy model cannot part: the stem near the crown top is the trunk, the far one is not taken (H79)', () => {
  // the lower tree's top lies within the taller one's search radius, so the canopy model sees one crown. Until
  // 2026-11-05 each stem became a trunk; against the owner's 7 marked trunks every stem farther than max(3 m, 0.4 R)
  // from the crown's top was wrong (shrubs, posts, low limbs), so now only the near one is taken, and it keeps the
  // crown's whole area. A real second tree 5 m off is the cost; its water is still in the crown's area.
  const trees = [{ x: 24, y: 30, R: 5, H: 14, stem: 7, sx: 24.2, sy: 30.1 }, { x: 29, y: 30, R: 4, H: 9, stem: 7, sx: 29.3, sy: 29.8 }];
  const l = lot({ trees, seed: 5 });
  const { trunks } = trunksOf(l.cols, l.bbox, LAT);
  const near = (t, x, y) => Math.hypot(t.x - at(l, x, y)[0], t.y - at(l, x, y)[1]) * l.k;
  const a = trunks.filter((t) => near(t, 24.2, 30.1) < 1), b = trunks.filter((t) => near(t, 29.3, 29.8) < 1);
  assert.equal(a.length, 1, `a trunk at the stem by the top (${trunks.map((t) => [t.how, near(t, 24.2, 30.1).toFixed(1)]).join('; ')})`);
  assert.equal(a[0].how, 'stem');
  if (b.length === 0) { assert.equal(a[0].stemsInCrown, 1); assert.ok(Math.abs(a[0].R - a[0].crownR) < 1e-9, 'one trunk keeps the crown whole'); }
  else assert.notEqual(b[0].crown, a[0].crown, 'the second stem found only if the canopy model parted the crowns');
});

console.log(`water trunks: ${passed} passed`);
