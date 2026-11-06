/**
 * One day's stops split between several people (route session, 2026-11-06),
 * and re-split during the day as helpers come free (2026-11-06).
 *
 * Owner: "split a route between X number of people, so drive time and the
 * stop durations are split evenly ... a blank start point, but still the
 * shop as the end point", and later: helpers come free one at a time, at
 * times nobody knows ahead; "the idea is to end up with a similar end time
 * across the board."
 *
 * A PERSON is { anchor, fixed }:
 *   anchor  the point their route goes on from (where they are, or the stop
 *           they are on and keep), or null for a blank start: getting to the
 *           first stop is not counted
 *   fixed   seconds already spoken for before that: waiting until they are
 *           free, the drive to and the job at a stop they keep
 * A route is the stops they take after the anchor, then the shop. Its TOTAL
 * is fixed + driving + job time: when, from now, they would be back.
 *
 * The split makes the LATEST return as early as it can (everyone back at
 * about the same time), then the least driving overall. When re-splitting a
 * day already under way, moving a stop off someone's list costs a little
 * (moveCost) and returns within a minute of each other count as equal, so
 * lists change only when it gains real time.
 *
 *   splitRoutes  a fresh day: one route through every stop, cut into even
 *                runs (exact for its order), then improved
 *   rebalance    a day under way: from the lists as they are, improved
 *
 * Improving: moves of a stop to someone else (at the best place in their
 * route), swaps of two stops, each touched route re-ordered (solve.js); then
 * shaking a few stops at random and improving again, kept if better.
 * D is the drive-time matrix in seconds; service the job seconds per point.
 */

import { solvePath } from './solve.js';

const BIG = 1e9;
const d = (D, a, b) => (a === b ? 0 : D[a][b] == null ? BIG : D[a][b]);
const FREE = { anchor: null, fixed: 0 };

/** A person's total: fixed, then from the anchor (if any) through the stops to the shop, plus job time. */
export function costFor(D, person, route, shop, service) {
  let s = person.fixed || 0;
  if (!route.length) return s + (person.anchor != null ? d(D, person.anchor, shop) : 0);
  if (person.anchor != null) s += d(D, person.anchor, route[0]);
  for (let i = 0; i + 1 < route.length; i += 1) s += d(D, route[i], route[i + 1]);
  s += d(D, route[route.length - 1], shop);
  for (const p of route) s += service[p] || 0;
  return s;
}

/** A blank-start route's total: driving from the first stop on, then to the shop, plus job time. */
export const routeCost = (D, route, shop, service) => costFor(D, FREE, route, shop, service);

/** The best order for some stops, from the anchor (or anywhere, with none) to the shop. */
export function orderStops(D, stops, shop, opts = {}, anchor = null) {
  if (!stops.length) return [];
  if (anchor == null && stops.length === 1) return [...stops];
  // with no anchor, a made-up start that costs nothing to leave: the route may begin anywhere
  const head = anchor == null ? -1 : anchor;
  const nodes = [head, ...stops, shop];
  const last = nodes.length - 1;
  const M = nodes.map((a, i) => nodes.map((b, j) => {
    if (i === j) return 0;
    if (anchor == null && i === 0) return j === last ? BIG : 0;
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

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/**
 * How good a split is: [the latest return, then driving and moves]. With a
 * tolerance, returns within it of each other count as the same (in buckets,
 * so it cannot creep). moveCost: seconds charged per stop taken off the list
 * it was on (owner: stop -> person index).
 */
function scorer({ tol = 0, moveCost = 0, owner = null }) {
  return (routes, costs) => {
    const max = Math.max(...costs);
    let rest = costs.reduce((a, b) => a + b, 0);
    if (moveCost && owner) routes.forEach((r, p) => { for (const s of r) if (owner.has(s) && owner.get(s) !== p) rest += moveCost; });
    return [tol ? Math.round(max / tol) : max, rest];
  };
}
const better = (a, b) => a[0] < b[0] - 1e-6 || (Math.abs(a[0] - b[0]) <= 1e-6 && a[1] < b[1] - 1e-6);

function insertBest(D, person, route, s, shop, service) {
  let bestRoute = null;
  let bestCost = Infinity;
  for (let k = 0; k <= route.length; k += 1) {
    const r = [...route.slice(0, k), s, ...route.slice(k)];
    const c = costFor(D, person, r, shop, service);
    if (c < bestCost) { bestCost = c; bestRoute = r; }
  }
  return { route: bestRoute, cost: bestCost };
}

/** Moves until none helps: a stop to another person, or two stops swapped. */
function improve(D, persons, routes, shop, service, opts, maxRounds, score) {
  let costs = routes.map((r, p) => costFor(D, persons[p], r, shop, service));
  for (let round = 0; round < maxRounds; round += 1) {
    const now = score(routes, costs);
    let found = null;
    const order = costs.map((c, i) => i).sort((a, b) => costs[b] - costs[a]);
    for (const a of order) {
      for (let x = 0; x < routes[a].length && !found; x += 1) {
        const s = routes[a][x];
        const rest = routes[a].filter((_, k) => k !== x);
        const restCost = costFor(D, persons[a], rest, shop, service);
        for (let b = 0; b < routes.length && !found; b += 1) {
          if (b === a) continue;
          const ins = insertBest(D, persons[b], routes[b], s, shop, service);
          const tryRoutes = routes.slice();
          tryRoutes[a] = rest; tryRoutes[b] = ins.route;
          const moved = costs.slice();
          moved[a] = restCost; moved[b] = ins.cost;
          if (better(score(tryRoutes, moved), now)) { found = { a, b, ra: rest, rb: ins.route }; break; }
          for (let y = 0; y < routes[b].length; y += 1) {
            const t = routes[b][y];
            const restB = routes[b].filter((_, k) => k !== y);
            const intoA = insertBest(D, persons[a], rest, t, shop, service);
            const intoB = insertBest(D, persons[b], restB, s, shop, service);
            const swapRoutes = routes.slice();
            swapRoutes[a] = intoA.route; swapRoutes[b] = intoB.route;
            const swapped = costs.slice();
            swapped[a] = intoA.cost; swapped[b] = intoB.cost;
            if (better(score(swapRoutes, swapped), now)) { found = { a, b, ra: intoA.route, rb: intoB.route }; break; }
          }
        }
      }
      if (found) break;
    }
    if (!found) break;
    routes = routes.slice();
    for (const [k, r] of [[found.a, found.ra], [found.b, found.rb]]) {
      const ordered = orderStops(D, r, shop, opts, persons[k].anchor);
      routes[k] = costFor(D, persons[k], ordered, shop, service) <= costFor(D, persons[k], r, shop, service) ? ordered : r;
    }
    costs = routes.map((r, p) => costFor(D, persons[p], r, shop, service));
  }
  return { routes, costs };
}

/** Improve, then shake and improve again for a while, keeping the best. */
function search(D, persons, start, shop, service, { maxRounds = 400, seed = 7, timeMs = 1500, kicks = 200, score }) {
  const opts = { seed };
  let best = improve(D, persons, start, shop, service, opts, maxRounds, score);
  const count = start.reduce((a, r) => a + r.length, 0);
  const rand = rng(seed);
  const until = Date.now() + timeMs;
  for (let k = 0; k < kicks && Date.now() < until && count > 1 && persons.length > 1; k += 1) {
    const routes = best.routes.map((r) => [...r]);
    const moves = 1 + Math.floor(rand() * 3);
    for (let m = 0; m < moves; m += 1) {
      const from = routes.map((r, i) => i).filter((i) => routes[i].length);
      if (!from.length) break;
      const a = from[Math.floor(rand() * from.length)];
      const s = routes[a].splice(Math.floor(rand() * routes[a].length), 1)[0];
      let b = Math.floor(rand() * (routes.length - 1));
      if (b >= a) b += 1;
      routes[b] = insertBest(D, persons[b], routes[b], s, shop, service).route;
    }
    const tried = improve(D, persons, routes.map((r, p) => orderStops(D, r, shop, opts, persons[p].anchor)), shop, service, opts, maxRounds, score);
    if (better(score(tried.routes, tried.costs), score(best.routes, best.costs))) best = tried;
  }
  return best;
}

/**
 * A fresh split: routes (lists of point indices, each in driving order,
 * ending at the shop) and each one's total in seconds, the longest first.
 *   stops    the point indices to visit
 *   shop     the shop's index
 *   service  job seconds by point index
 *   timeMs   how long to keep shaking the answer for a better one
 */
export function splitRoutes(D, { stops, shop, service = [], people = 2, maxRounds = 400, seed = 7, timeMs = 1500, kicks = 200 } = {}) {
  if (people <= 1) {
    const r = orderStops(D, stops, shop, { seed });
    return { routes: [r], costs: [routeCost(D, r, shop, service)] };
  }
  const persons = Array.from({ length: people }, () => FREE);
  const start = cutEvenly(D, orderStops(D, stops, shop, { seed }), shop, service, people).map((r) => orderStops(D, r, shop, { seed }));
  const best = search(D, persons, start, shop, service, { maxRounds, seed, timeMs, kicks, score: scorer({}) });
  const idx = best.costs.map((c, i) => i).sort((a, b) => best.costs[b] - best.costs[a]);
  return { routes: idx.map((i) => best.routes[i]), costs: idx.map((i) => best.costs[i]) };
}

/**
 * A day under way, re-split: everyone's stops still to do shared out again,
 * from the lists as they are. Routes come back in the persons' own order.
 *   persons   [{ anchor, fixed }] per person (see the top of this file)
 *   current   each person's stops still to do (point indices), as now
 *   tol       returns within this many seconds count as equal (default 60)
 *   moveCost  seconds charged per stop moved off its list (default 300)
 */
export function rebalance(D, { persons, current, shop, service = [], tol = 60, moveCost = 300, seed = 7, timeMs = 1500, kicks = 150, maxRounds = 400 } = {}) {
  const owner = new Map();
  current.forEach((r, p) => r.forEach((s) => owner.set(s, p)));
  const start = current.map((r, p) => orderStops(D, r, shop, { seed }, persons[p].anchor));
  const score = scorer({ tol, moveCost, owner });
  const best = search(D, persons, start, shop, service, { maxRounds, seed, timeMs, kicks, score });
  const moved = best.routes.reduce((a, r, p) => a + r.filter((s) => owner.get(s) !== p).length, 0);
  return { routes: best.routes, costs: best.costs, moved };
}
