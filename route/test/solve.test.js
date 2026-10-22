// The route solver: fixed ends, exact on small problems, near-exact on big ones.
import assert from 'node:assert/strict';
import { pathCost, solvePath } from '../lib/solve.js';

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/** Points on a plane; one-way-ish costs (a little more one way than the other). */
function problem(n) {
  const pts = Array.from({ length: n }, () => [rand() * 10000, rand() * 10000]);
  return pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.hypot(a[0] - b[0], a[1] - b[1]) * (i < j ? 1 : 1.07) + 30)));
}

/** Every order, for checking. */
function brute(D) {
  const n = D.length;
  const mid = Array.from({ length: n - 2 }, (_, i) => i + 1);
  let best = Infinity;
  const perm = (a, k) => {
    if (k === a.length) { best = Math.min(best, pathCost(D, [0, ...a, n - 1])); return; }
    for (let i = k; i < a.length; i += 1) {
      [a[k], a[i]] = [a[i], a[k]];
      perm(a, k + 1);
      [a[k], a[i]] = [a[i], a[k]];
    }
  };
  perm(mid, 0);
  return best;
}

const valid = (order, n) => {
  assert.equal(order[0], 0, 'starts at the start');
  assert.equal(order[order.length - 1], n - 1, 'ends at the end');
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i), 'every stop once');
};

// exact against brute force
for (let t = 0; t < 20; t += 1) {
  const D = problem(4 + (t % 6));
  const o = solvePath(D);
  valid(o, D.length);
  assert.ok(Math.abs(pathCost(D, o) - brute(D)) < 1e-6, 'Held-Karp is exact');
}

// the local search (forced) against Held-Karp
let worst = 0;
for (let t = 0; t < 30; t += 1) {
  const D = problem(12 + (t % 4));
  const exact = pathCost(D, solvePath(D));
  const o = solvePath(D, { exactUpTo: 0, seed: t + 1 });
  valid(o, D.length);
  worst = Math.max(worst, pathCost(D, o) / exact - 1);
}
assert.ok(worst < 0.01, `local search within 1% of exact on 12-15 stops (worst ${(worst * 100).toFixed(2)}%)`);

// a big day: valid, and much better than the listed order
const D = problem(42);
const t0 = Date.now();
const o = solvePath(D);
valid(o, D.length);
const listed = pathCost(D, D.map((_, i) => i));
assert.ok(pathCost(D, o) < listed * 0.5, 'beats the listed order on random stops');
assert.ok(Date.now() - t0 < 5000, `40 stops in under 5 s (${Date.now() - t0} ms)`);

// no road between two points is a cost, not a crash
const N = problem(6);
N[1][2] = null;
valid(solvePath(N), 6);
assert.deepEqual(solvePath([[0]]), [0]);
assert.deepEqual(solvePath([[0, 5], [5, 0]]), [0, 1]);

console.log(`route solve: ok (local search worst ${(worst * 100).toFixed(2)}% over exact; 40 stops ${Date.now() - t0} ms)`);
