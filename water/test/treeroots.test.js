/**
 * Trees drinking from the lawn (water/lib/treeroots.js) and the balance taking it (lib/balance.js simulate).
 *   node water/test/treeroots.test.js
 */
import assert from 'node:assert/strict';
import { treeDrawCoefs, TREE } from '../lib/treeroots.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok  ${name}`); }

const grid = (W, H) => ({ W, H, cell: 1, bbox: [0, 0, W, H] }); // 1 unit = 1 m here

test("a crown's draw: f x K_t x its area, centred on the crown, out to twice its radius, none under a building", () => {
  const g = grid(60, 60), N = 3600, kinds = new Uint8Array(N).fill(1);
  const lab = new Int32Array(N).fill(-1);
  for (let y = 26; y < 34; y++) for (let x = 26; x < 34; x++) lab[y * 60 + x] = 0;
  const crowns = { lab, list: [{ id: 0, cx: 30, cy: 30, R: 4.5, A: 64, H: 12 }] }; // the middle at x 30, y 30 (y up)
  const c = treeDrawCoefs(g, kinds, crowns);
  const sum = c.broad.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sum - TREE.f * TREE.kt * 64) < 0.05, `all of it from the lawn: ${sum.toFixed(2)} L per mm of ET0`);
  const at = (x, y) => c.broad[(60 - 1 - y) * 60 + x];
  assert.ok(at(30, 30) > at(34, 30) && at(34, 30) > at(38, 30), 'most near the middle');
  assert.equal(at(30 + 10, 30), 0, 'nothing past twice the radius (9 m)');
  // a building in the disc: its cells share the weights (roots run under it) but nothing is taken there
  const k2 = Uint8Array.from(kinds); for (let y = 20; y < 40; y++) for (let x = 31; x < 40; x++) k2[y * 60 + x] = 3; // paving east of the middle
  const p = treeDrawCoefs(g, k2, crowns);
  const sp = p.broad.reduce((a, v) => a + v, 0);
  assert.ok(sp < sum * 0.75, `under paving the roots drink nothing from the lawn: ${sp.toFixed(2)}`);
  // the shade map's evergreen: a conifer
  const sk = new Uint8Array(N); for (let i = 0; i < N; i++) if (lab[i] === 0) sk[i] = 2;
  const cc = treeDrawCoefs(g, kinds, crowns, { shadeKinds: sk });
  assert.ok(cc.broad.every((v) => v === 0) && Math.abs(cc.conifer.reduce((a, v) => a + v, 0) - TREE.f * TREE.ktConifer * 64) < 0.05);
  assert.equal(treeDrawCoefs(g, kinds, null), null);
});

console.log(`water tree roots: ${passed} passed`);
