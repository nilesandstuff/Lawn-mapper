// Splitting a day between people: every stop once, ends at the shop, the longest day as short as it can be.
import assert from 'node:assert/strict';
import { cutEvenly, orderStops, routeCost, splitRoutes } from '../lib/split.js';

let seed = 99;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
function problem(n) {
  const pts = Array.from({ length: n }, () => [rand() * 20000, rand() * 20000]);
  const D = pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.hypot(a[0] - b[0], a[1] - b[1]) / 13 * (i < j ? 1 : 1.05) + 40)));
  const service = pts.map((_, i) => (i === n - 1 ? 0 : 600 + Math.floor(rand() * 1800)));
  return { D, service, stops: pts.slice(0, -1).map((_, i) => i), shop: n - 1 };
}
const valid = (routes, stops) => assert.deepEqual(routes.flat().sort((a, b) => a - b), stops, 'every stop exactly once');

// the best possible split, by trying every assignment (small problems)
function brute({ D, service, stops, shop }, people) {
  let best = Infinity;
  const total = people ** stops.length;
  for (let code = 0; code < total; code += 1) {
    const groups = Array.from({ length: people }, () => []);
    let c = code;
    for (const s of stops) { groups[c % people].push(s); c = Math.floor(c / people); }
    const worst = Math.max(...groups.map((g) => routeCost(D, orderStops(D, g, shop), shop, service)));
    best = Math.min(best, worst);
  }
  return best;
}

let worstGap = 0;
for (let t = 0; t < 12; t += 1) {
  const pr = problem(7 + (t % 3));
  const people = 2 + (t % 2);
  const { routes, costs } = splitRoutes(pr.D, { ...pr, people });
  valid(routes, pr.stops);
  assert.equal(routes.length, people);
  costs.forEach((c, i) => assert.ok(Math.abs(c - routeCost(pr.D, routes[i], pr.shop, pr.service)) < 1e-6));
  worstGap = Math.max(worstGap, Math.max(...costs) / brute(pr, people) - 1);
}
assert.ok(worstGap < 0.03, `within 3% of the best split on small days (worst ${(worstGap * 100).toFixed(1)}%)`);

// a realistic day: 30 stops, 3 people -- even, and far better than one person doing it all
const pr = problem(31);
const t0 = Date.now();
const three = splitRoutes(pr.D, { ...pr, people: 3 });
valid(three.routes, pr.stops);
const spread = (Math.max(...three.costs) - Math.min(...three.costs)) / Math.max(...three.costs);
assert.ok(spread < 0.2, `the three days within 20% of each other (${(spread * 100).toFixed(1)}%)`);
const one = splitRoutes(pr.D, { ...pr, people: 1 });
assert.ok(Math.max(...three.costs) < one.costs[0] * 0.5, 'three people finish in well under half the time of one');
assert.ok(Date.now() - t0 < 15000, `in reasonable time (${Date.now() - t0} ms)`);

// the cut is exact for its order
const run = [0, 1, 2, 3, 4, 5];
const flat = { D: run.concat(6).map(() => run.concat(6).map(() => 0)), service: [5, 5, 5, 5, 5, 5, 0] };
assert.deepEqual(cutEvenly(flat.D, run, 6, flat.service, 3), [[0, 1], [2, 3], [4, 5]]);
// more people than stops: some get none
const tiny = problem(3);
const r = splitRoutes(tiny.D, { ...tiny, people: 4 });
valid(r.routes, tiny.stops);
assert.equal(r.routes.length, 4);
assert.equal(r.routes.filter((x) => !x.length).length, 2);
// the free start: a route's cost does not count getting to its first stop
assert.equal(routeCost([[0, 100], [100, 0]], [0], 1, [30, 0]), 100 + 30);

console.log(`route split: ok (worst ${(worstGap * 100).toFixed(1)}% over the best split; 30 stops / 3 people within ${(spread * 100).toFixed(1)}%, ${Date.now() - t0} ms)`);
