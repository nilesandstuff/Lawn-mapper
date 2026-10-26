/**
 * Drive times kept on the phone (route session, 2026-10-26).
 *
 * Mapbox bills the matrix by the pair (sources x destinations), and a route
 * of n stops needs (n + 2)^2 of them: every stop to every other, because the
 * order is not known until they all are. Most stops come back -- the same
 * customers, round after round -- so each pair is kept, keyed by the two
 * places' points (to about a metre), and only the pairs not kept are asked
 * for. A pair is any two places in any later route, next to each other in it
 * or not.
 *
 * KEPT FOR 60 DAYS FROM ITS LAST USE (owner: "2 months, and the clock resets
 * each time that cache is called"). The GPS start ("Start where I am") is
 * never kept: it is somewhere new each time.
 *
 * The cache is a plain object { "lng,lat>lng,lat": [seconds, metres, day] },
 * stored by the page in localStorage.
 */

export const TTL_DAYS = 60;
export const MAX_PAIRS = 40000;
const DAY = 86400000;

export const today = (now = Date.now()) => Math.floor(now / DAY);
export const placeKey = (p) => `${Number(p.lng).toFixed(5)},${Number(p.lat).toFixed(5)}`;
const pairKey = (a, b) => `${placeKey(a)}>${placeKey(b)}`;
const table = (n) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : null)));

/**
 * The tables as far as the cache knows them, null where it does not. Every
 * pair it answers has its clock reset. Two jobs at one place are 0 apart.
 *   keep[i] false: point i is never looked up or kept (the GPS start)
 */
export function fromCache(cache, points, { now = Date.now(), keep = points.map(() => true) } = {}) {
  const n = points.length;
  const durations = table(n);
  const distances = table(n);
  const day = today(now);
  let hits = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j || !keep[i] || !keep[j]) continue;
      if (placeKey(points[i]) === placeKey(points[j])) { durations[i][j] = 0; distances[i][j] = 0; continue; }
      const e = cache[pairKey(points[i], points[j])];
      if (!e || day - e[2] > TTL_DAYS) continue;
      durations[i][j] = e[0];
      distances[i][j] = e[1];
      e[2] = day;
      hits += 1;
    }
  }
  return { durations, distances, hits };
}

/**
 * What to ask Mapbox for, as [{ sources, destinations }]. The missing pairs
 * are covered by a few points -- usually the new stops -- chosen greedily
 * (the point with the most missing pairs, until none are left). Then: those
 * points to everywhere, and everywhere else to them. Every pair between two
 * other points is already known.
 */
export function toFetch(durations) {
  const n = durations.length;
  const all = Array.from({ length: n }, (_, i) => i);
  const open = new Set();
  for (const i of all) for (const j of all) if (i !== j && durations[i][j] == null) open.add(`${Math.min(i, j)},${Math.max(i, j)}`);
  const cover = [];
  while (open.size) {
    const count = new Map();
    for (const p of open) for (const x of p.split(',').map(Number)) count.set(x, (count.get(x) || 0) + 1);
    const pick = [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    cover.push(pick);
    for (const p of [...open]) if (p.split(',').map(Number).includes(pick)) open.delete(p);
  }
  if (!cover.length) return [];
  cover.sort((a, b) => a - b);
  const rest = all.filter((i) => !cover.includes(i));
  return rest.length
    ? [{ sources: cover, destinations: all }, { sources: rest, destinations: cover }]
    : [{ sources: all, destinations: all }];
}

export const elementsOf = (requests) => requests.reduce((a, r) => a + r.sources.length * r.destinations.length, 0);

/** Copy what one answer filled in (non-null) into the tables. */
export function fill(target, part) {
  for (let i = 0; i < target.durations.length; i += 1) {
    for (let j = 0; j < target.durations.length; j += 1) {
      if (part.durations[i]?.[j] != null && target.durations[i][j] == null) {
        target.durations[i][j] = part.durations[i][j];
        target.distances[i][j] = part.distances?.[i]?.[j] ?? null;
      }
    }
  }
}

/** Keep every known pair between keepable points, dated today. */
export function remember(cache, points, durations, distances, { now = Date.now(), keep = points.map(() => true) } = {}) {
  const day = today(now);
  for (let i = 0; i < points.length; i += 1) {
    for (let j = 0; j < points.length; j += 1) {
      if (i === j || !keep[i] || !keep[j] || durations[i][j] == null) continue;
      if (placeKey(points[i]) === placeKey(points[j])) continue;
      cache[pairKey(points[i], points[j])] = [Math.round(durations[i][j] * 10) / 10, Math.round(distances[i][j] ?? 0), day];
    }
  }
}

/** Drop pairs unused for 60 days, then the least recently used beyond max. Returns how many are left. */
export function prune(cache, { now = Date.now(), max = MAX_PAIRS } = {}) {
  const day = today(now);
  for (const [k, e] of Object.entries(cache)) if (!Array.isArray(e) || day - e[2] > TTL_DAYS) delete cache[k];
  const keys = Object.keys(cache);
  if (keys.length > max) {
    keys.sort((a, b) => cache[a][2] - cache[b][2]);
    for (const k of keys.slice(0, keys.length - max)) delete cache[k];
  }
  return Object.keys(cache).length;
}
