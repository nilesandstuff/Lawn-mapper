/**
 * One day's stops split between several people (route session, 2026-11-06).
 *
 * Owner: "split a route between X number of people, so drive time and the
 * stop durations are split evenly ... a blank start point, but still the
 * shop as the end point."
 *
 * So each person's route starts at its first stop (getting there is not
 * counted: everyone comes from somewhere else) and ends at the shop. A
 * route's TOTAL is its driving -- first stop to the last, then to the shop --
 * plus its stops' job time. The split makes the LONGEST total as short as it
 * can, and then the sum of them all: the day ends when the last person is
 * back, and nobody drives further than they need to.
 *
 *   1. one route through every stop to the shop (solve.js), then cut into
 *      X consecutive runs as evenly as possible (exact, by dynamic programming)
 *   2. then moves until none helps: a stop from one person to another (at the
 *      best place in their route), or two stops swapped; each route touched
 *      re-ordered by solve.js
 *
 * D is the drive-time matrix in seconds; service the job seconds per point.
 */

import { solvePath } from './solve.js';

const BIG = 1e9;
const d = (D, a, b) => (a === b ? 0 : D[a][b] == null ? BIG : D[a][b]);

/** A person's total: driving from the first stop on, then to the shop, plus job time. */
export function routeCost(D, route, shop, service) {
  if (!route.length) return 0;
  let s = 0;
  for (let i = 0; i + 1 < route.length; i += 1) s += d(D, route[i], route[i + 1]);
  s += d(D, route[route.length - 1], shop);
  for (const p of route) s += service[p] || 0;
  return s;
}

/** The best order for some stops, starting anywhere, ending at the shop. */
export function orderStops(D, stops, shop, opts = {}) {
  if (stops.length <= 1) return [...stops];
  // a made-up start, nothing from it to any stop: the route may begin anywhere
  const nodes = [-1, ...stops, shop];
  const last = nodes.length - 1;
  const M = nodes.map((a, i) => nodes.map((b, j) => {
    if (i === j) return 0;
    if (i === 0) return j === last ? BIG : 0;
    if (j === 0) return BIG;
    return d(D, a, b);
  }));
  return solvePath(M, opts).slice(1, -1).map((i) => nodes[i]);
}

/** One ordered run cut into `people` consecutive pieces, the longest as short as possible. */
export function cutEvenly(D, run, shop, service, people) {
  const n = run.length;
  const P = Math.max(1, Math.min(people, n || 1));
  const piece = (i, j) => routeCost(D, run.slice(i, j), shop, service);
  // best[p][j]: the longest of the first p pieces covering run[0..j)
  const best = Array.from({ length: P + 1 }, () => Array(n + 1).fill(Infinity));
  const from = Array.from({ length: P + 1 }, () => Array(n + 1).fill(0));
  best[0][0] = 0;
  for (let p = 1; p <= P; p += 1) {
    for (let j = 1; j <= n; j += 1) {
      for (let i = p - 1; i < j; i += 1) {
        const v = Math.max(best[p - 1][i], piece(i, j));
        if (v < best[p][j]) { best[p][j] = v; from[p][j] = i; }
      }
    }
  }
  const out = [];
  let j = n;
  for (let p = P; p >= 1; p -= 1) { const i = from[p][j]; out.unshift(run.slice(i, j)); j = i; }
  while (out.length < people) out.push([]);
  return out;
}

const score = (costs) => [Math.max(...costs), costs.reduce((a, b) => a + b, 0)];
const better = (a, b) => a[0] < b[0] - 1e-6 || (Math.abs(a[0] - b[0]) <= 1e-6 && a[1] < b[1] - 1e-6);

/** The cheapest place for a stop in a route, keeping the rest in order. */
function insertBest(D, route, s, shop, service) {
  let bestRoute = null;
  let bestCost = Infinity;
  for (let k = 0; k <= route.length; k += 1) {
    const r = [...route.slice(0, k), s, ...route.slice(k)];
    const c = routeCost(D, r, shop, service);
    if (c < bestCost) { bestCost = c; bestRoute = r; }
  }
  return { route: bestRoute, cost: bestCost };
}

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/** Moves until none helps: a stop to another person, or two stops swapped. */
function improve(D, routes, shop, service, opts, maxRounds) {
  let costs = routes.map((r) => routeCost(D, r, shop, service));
  for (let round = 0; round < maxRounds; round += 1) {
    const now = score(costs);
    let found = null;
    const order = costs.map((c, i) => i).sort((a, b) => costs[b] - costs[a]);
    for (const a of order) {
      for (let x = 0; x < routes[a].length && !found; x += 1) {
        const s = routes[a][x];
        const rest = routes[a].filter((_, k) => k !== x);
        const restCost = routeCost(D, rest, shop, service);
        for (let b = 0; b < routes.length && !found; b += 1) {
          if (b === a) continue;
          const ins = insertBest(D, routes[b], s, shop, service);
          const moved = costs.slice();
          moved[a] = restCost; moved[b] = ins.cost;
          if (better(score(moved), now)) { found = { a, b, ra: rest, rb: ins.route }; break; }
          for (let y = 0; y < routes[b].length; y += 1) {
            const t = routes[b][y];
            const restB = routes[b].filter((_, k) => k !== y);
            const intoA = insertBest(D, rest, t, shop, service);
            const intoB = insertBest(D, restB, s, shop, service);
            const swapped = costs.slice();
            swapped[a] = intoA.cost; swapped[b] = intoB.cost;
            if (better(score(swapped), now)) { found = { a, b, ra: intoA.route, rb: intoB.route }; break; }
          }
        }
      }
      if (found) break;
    }
    if (!found) break;
    for (const [k, r] of [[found.a, found.ra], [found.b, found.rb]]) {
      const ordered = orderStops(D, r, shop, opts);
      routes[k] = routeCost(D, ordered, shop, service) <= routeCost(D, r, shop, service) ? ordered : r;
    }
    costs = routes.map((r) => routeCost(D, r, shop, service));
  }
  return { routes, costs };
}

/**
 * The split: routes (lists of point indices, each in driving order, ending
 * at the shop) and each one's total in seconds.
 *   stops    the point indices to visit
 *   shop     the shop's index
 *   service  job seconds by point index
 *   timeMs   how long to keep shaking the answer for a better one (iterated local search)
 */
export function splitRoutes(D, { stops, shop, service = [], people = 2, maxRounds = 400, seed = 7, timeMs = 1500, kicks = 200 } = {}) {
  const opts = { seed };
  if (people <= 1) {
    const r = orderStops(D, stops, shop, opts);
    return { routes: [r], costs: [routeCost(D, r, shop, service)] };
  }
  const start = cutEvenly(D, orderStops(D, stops, shop, opts), shop, service, people).map((r) => orderStops(D, r, shop, opts));
  let best = improve(D, start, shop, service, opts, maxRounds);
  // shake: move a few stops to someone else, improve again, keep it if the day is shorter
  const rand = rng(seed);
  const until = Date.now() + timeMs;
  for (let k = 0; k < kicks && Date.now() < until && stops.length > 1; k += 1) {
    const routes = best.routes.map((r) => [...r]);
    const moves = 1 + Math.floor(rand() * 3);
    for (let m = 0; m < moves; m += 1) {
      const from = routes.map((r, i) => i).filter((i) => routes[i].length);
      const a = from[Math.floor(rand() * from.length)];
      const s = routes[a].splice(Math.floor(rand() * routes[a].length), 1)[0];
      let b = Math.floor(rand() * (routes.length - 1));
      if (b >= a) b += 1;
      routes[b] = insertBest(D, routes[b], s, shop, service).route;
    }
    const tried = improve(D, routes.map((r) => orderStops(D, r, shop, opts)), shop, service, opts, maxRounds);
    if (better(score(tried.costs), score(best.costs))) best = tried;
  }
  // the longest first
  const idx = best.costs.map((c, i) => i).sort((a, b) => best.costs[b] - best.costs[a]);
  return { routes: idx.map((i) => best.routes[i]), costs: idx.map((i) => best.costs[i]) };
}
