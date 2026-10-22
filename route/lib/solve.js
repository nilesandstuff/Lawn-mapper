/**
 * The fastest order to visit the stops (route session, 2026-10-22).
 *
 * A path, not a loop: it starts at node 0 (the shop or wherever you are) and
 * ends at the last node (the shop), visiting every node between once. Costs
 * are a square matrix of seconds, D[from][to]; they need not be symmetric
 * (one-way streets, left turns), and null means no road was found.
 *
 * Up to 15 stops the answer is exact (Held-Karp). Beyond that it is iterated
 * local search -- move a run of 1-3 stops, reverse a stretch, then kick the
 * best order with a double bridge and search again -- which on route-sized
 * problems finds the exact answer nearly always and is never far from it.
 */

const BIG = 1e9;

/** Seconds along an order of node indices. */
export function pathCost(D, order) {
  let s = 0;
  for (let i = 0; i + 1 < order.length; i += 1) s += cost(D, order[i], order[i + 1]);
  return s;
}

const cost = (D, a, b) => (a === b ? 0 : D[a][b] == null ? BIG : D[a][b]);

/** A small seeded random number generator, so a test sees the same run twice. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Exact, for up to ~15 middle nodes. */
function heldKarp(D, start, end, mid) {
  const k = mid.length;
  const full = (1 << k) - 1;
  const dp = new Float64Array((1 << k) * k).fill(Infinity);
  const from = new Int8Array((1 << k) * k).fill(-1);
  for (let j = 0; j < k; j += 1) dp[(1 << j) * k + j] = cost(D, start, mid[j]);
  for (let mask = 1; mask <= full; mask += 1) {
    for (let j = 0; j < k; j += 1) {
      if (!(mask & (1 << j))) continue;
      const here = dp[mask * k + j];
      if (here === Infinity) continue;
      for (let n = 0; n < k; n += 1) {
        if (mask & (1 << n)) continue;
        const m2 = mask | (1 << n);
        const c = here + cost(D, mid[j], mid[n]);
        if (c < dp[m2 * k + n]) { dp[m2 * k + n] = c; from[m2 * k + n] = j; }
      }
    }
  }
  let best = Infinity;
  let last = -1;
  for (let j = 0; j < k; j += 1) {
    const c = dp[full * k + j] + cost(D, mid[j], end);
    if (c < best) { best = c; last = j; }
  }
  const order = [];
  let mask = full;
  while (last >= 0) {
    order.push(mid[last]);
    const p = from[mask * k + last];
    mask &= ~(1 << last);
    last = p;
  }
  return [start, ...order.reverse(), end];
}

/** Improve an order in place until no single move helps. Endpoints stay put. */
function localSearch(D, p) {
  const n = p.length;
  let improved = true;
  while (improved) {
    improved = false;
    // reverse p[i..j] (2-opt); the edges inside run backwards, so they are re-added
    for (let i = 1; i < n - 2 && !improved; i += 1) {
      let fwd = 0;
      let bwd = 0;
      for (let j = i + 1; j < n - 1; j += 1) {
        fwd += cost(D, p[j - 1], p[j]);
        bwd += cost(D, p[j], p[j - 1]);
        const delta = cost(D, p[i - 1], p[j]) + cost(D, p[i], p[j + 1]) + bwd
          - cost(D, p[i - 1], p[i]) - cost(D, p[j], p[j + 1]) - fwd;
        if (delta < -1e-6) {
          p.splice(i, j - i + 1, ...p.slice(i, j + 1).reverse());
          improved = true;
          break;
        }
      }
    }
    // move a run of 1-3 stops elsewhere, either way round (or-opt)
    for (let len = 1; len <= 3 && !improved; len += 1) {
      for (let i = 1; i + len < n && !improved; i += 1) {
        const seg = p.slice(i, i + len);
        const a = p[i - 1];
        const b = p[i + len];
        const inner = pathCost(D, seg);
        const innerRev = pathCost(D, [...seg].reverse());
        const removed = cost(D, a, seg[0]) + inner + cost(D, seg[len - 1], b) - cost(D, a, b);
        const rest = [...p.slice(0, i), ...p.slice(i + len)];
        for (let k = 0; k + 1 < rest.length && !improved; k += 1) {
          if (k === i - 1) continue;
          const x = rest[k];
          const y = rest[k + 1];
          const base = cost(D, x, y);
          const fwdAdd = cost(D, x, seg[0]) + inner + cost(D, seg[len - 1], y) - base;
          const revAdd = cost(D, x, seg[len - 1]) + innerRev + cost(D, seg[0], y) - base;
          const add = Math.min(fwdAdd, revAdd);
          if (add - removed < -1e-6) {
            const put = fwdAdd <= revAdd ? seg : [...seg].reverse();
            p.splice(0, n, ...rest.slice(0, k + 1), ...put, ...rest.slice(k + 1));
            improved = true;
          }
        }
      }
    }
  }
  return p;
}

/** Nearest stop next, from the start. */
function nearest(D, start, end, mid) {
  const left = new Set(mid);
  const order = [start];
  let at = start;
  while (left.size) {
    let best = null;
    for (const m of left) if (best == null || cost(D, at, m) < cost(D, at, best)) best = m;
    order.push(best);
    left.delete(best);
    at = best;
  }
  order.push(end);
  return order;
}

/**
 * The order to drive, as node indices from 0 to D.length - 1.
 *   iterations  kicks for the local search (more stops, more by default)
 *   seed        for the kicks, so the same input gives the same route
 */
export function solvePath(D, { iterations, seed = 7, exactUpTo = 15 } = {}) {
  const n = D.length;
  const start = 0;
  const end = n - 1;
  if (n <= 2) return n === 1 ? [0] : [0, 1];
  const mid = [];
  for (let i = 1; i < end; i += 1) mid.push(i);
  if (mid.length <= exactUpTo) return heldKarp(D, start, end, mid);

  const rand = rng(seed);
  let best = localSearch(D, nearest(D, start, end, mid));
  let bestCost = pathCost(D, best);
  const rounds = iterations ?? Math.min(4000, 300 + 60 * mid.length);
  for (let r = 0; r < rounds; r += 1) {
    // double bridge on the middle: A B C D -> A C B D
    const m = best.length - 2;
    const cuts = [0, 0, 0].map(() => 1 + Math.floor(rand() * m)).sort((a, b) => a - b);
    const [x, y, z] = cuts;
    if (x === y || y === z) continue;
    const trial = [...best.slice(0, x), ...best.slice(y, z), ...best.slice(x, y), ...best.slice(z)];
    localSearch(D, trial);
    const c = pathCost(D, trial);
    if (c < bestCost - 1e-6) { best = trial; bestCost = c; }
  }
  return best;
}
