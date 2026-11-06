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

// ------------------------------------------------ a day under way, re-split as helpers come free
{
  const { rebalance, costFor, orderStops: order } = await import('../lib/split.js');
  // points: 0..13 stops, 14 = shop, 15 = the helper's position
  const n = 16;
  const pts = Array.from({ length: n }, () => [rand() * 20000, rand() * 20000]);
  const D = pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.hypot(a[0] - b[0], a[1] - b[1]) / 13 + 40)));
  const service = pts.map((_, i) => (i < 14 ? 1200 : 0));
  const shop = 14;
  const helperAt = 15;
  // the heavy route: on stop 0 (kept: its job still to finish), 13 more to go; nobody else yet
  const heavy = { anchor: 0, fixed: 1200 };
  const pool = Array.from({ length: 13 }, (_, i) => i + 1);
  const alone = costFor(D, heavy, order(D, pool, shop, {}, 0), shop, service);

  // a helper free NOW, where they are
  const now = rebalance(D, { persons: [heavy, { anchor: helperAt, fixed: 0 }], current: [pool, []], shop, service });
  assert.deepEqual(now.routes.flat().sort((a, b) => a - b), pool, 'every stop still to do, once');
  assert.ok(!now.routes.flat().includes(0), 'the stop the heavy route is on stays with them');
  const [h1, h2] = now.costs;
  assert.ok(Math.max(h1, h2) < alone * 0.65, 'one helper brings the day in a lot earlier');
  assert.ok(Math.abs(h1 - h2) < Math.max(h1, h2) * 0.2, `both back at about the same time (${Math.round(h1 / 60)} / ${Math.round(h2 / 60)} min)`);

  // the same helper, free only in an hour: takes fewer stops, still evens the ends out
  const later = rebalance(D, { persons: [heavy, { anchor: helperAt, fixed: 3600 }], current: [pool, []], shop, service });
  assert.ok(later.routes[1].length < now.routes[1].length, 'a helper free later takes fewer stops');
  assert.ok(Math.abs(later.costs[0] - later.costs[1]) < Math.max(...later.costs) * 0.25);

  // nothing to gain: nothing moves
  const again = rebalance(D, { persons: [heavy, { anchor: helperAt, fixed: 0 }], current: now.routes, shop, service });
  assert.equal(again.moved, 0, 'a balanced day is left as it is');

  // a second helper later: the stops still to do shared three ways, the ends even
  const left = now.routes.map((r) => r.slice(2)); // two done by each
  const third = rebalance(D, {
    persons: [{ anchor: now.routes[0][1], fixed: 0 }, { anchor: now.routes[1][1], fixed: 0 }, { anchor: 3, fixed: 0 }],
    current: [left[0], left[1], []], shop, service,
  });
  assert.deepEqual(third.routes.flat().sort((a, b) => a - b), [...left[0], ...left[1]].sort((a, b) => a - b));
  assert.ok(third.routes[2].length > 0, 'the new helper gets stops');
  const ends = third.costs;
  assert.ok((Math.max(...ends) - Math.min(...ends)) < Math.max(...ends) * 0.35, `three ends close (${ends.map((c) => Math.round(c / 60)).join(' / ')} min)`);

  // small days: the best re-split there is (brute force), with nothing charged for moves
  let gap = 0;
  for (let t = 0; t < 8; t += 1) {
    const m = 9;
    const P = Array.from({ length: m }, () => [rand() * 15000, rand() * 15000]);
    const DD = P.map((a, i) => P.map((b, j) => (i === j ? 0 : Math.hypot(a[0] - b[0], a[1] - b[1]) / 13 + 40)));
    const sv = P.map((_, i) => (i < 6 ? 900 + Math.floor(rand() * 900) : 0));
    // 0..5 stops, 6 shop, 7 and 8 two people's positions; the second free in 20 minutes
    const persons = [{ anchor: 7, fixed: 0 }, { anchor: 8, fixed: 1200 }];
    const got = rebalance(DD, { persons, current: [[0, 1, 2, 3, 4, 5], []], shop: 6, service: sv, tol: 0, moveCost: 0 });
    let best = Infinity;
    for (let code = 0; code < 64; code += 1) {
      const g = [[], []];
      for (let s = 0; s < 6; s += 1) g[(code >> s) & 1].push(s);
      best = Math.min(best, Math.max(...g.map((r, p) => costFor(DD, persons[p], order(DD, r, 6, {}, persons[p].anchor), 6, sv))));
    }
    gap = Math.max(gap, Math.max(...got.costs) / best - 1);
  }
  assert.ok(gap < 0.03, `re-split within 3% of the best on small days (worst ${(gap * 100).toFixed(1)}%)`);
  console.log(`route re-split: ok (helper now ${now.routes[1].length} stops, in an hour ${later.routes[1].length}; worst ${(gap * 100).toFixed(1)}% over best)`);
}
