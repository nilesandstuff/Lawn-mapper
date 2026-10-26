/**
 * Mapbox, asked by the route Worker (route session, 2026-10-22).
 *
 * The token stays here on the server. Three questions:
 *
 *   geocode  one address -> a point (Geocoding v6, US addresses, nearest the shop first)
 *   matrix   every point -> every other, seconds and metres (Matrix v1). It
 *            takes at most 25 points a call, so a big day is asked in blocks
 *            of 12 x 12 and put back together.
 *   route    the roads along the chosen order, for the map and the leg times
 *            (Directions v5, 25 points a call, consecutive calls sharing a point).
 */

export const MAX_POINTS = 62; // 6 x 6 matrix blocks = 36 calls, under a free Worker's 50
const BLOCK = 12;
const API = 'https://api.mapbox.com';

const coord = ([lng, lat]) => `${Number(lng).toFixed(6)},${Number(lat).toFixed(6)}`;

export function validPoints(points) {
  return Array.isArray(points) && points.length >= 2 && points.length <= MAX_POINTS
    && points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
      && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
}

async function getJson(fetcher, url) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetcher(url);
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Mapbox ${res.status}`);
    return res.json();
  }
}

/** A few at a time: Mapbox's per-minute limits are generous, a burst of 36 is not. */
async function inBatches(jobs, size = 6) {
  const out = [];
  for (let i = 0; i < jobs.length; i += size) out.push(...(await Promise.all(jobs.slice(i, i + size).map((j) => j()))));
  return out;
}

export async function geocode(fetcher, token, q, near) {
  const params = new URLSearchParams({ q, access_token: token, country: 'us', types: 'address', limit: '1', autocomplete: 'false' });
  if (near) params.set('proximity', coord(near));
  const data = await getJson(fetcher, `${API}/search/geocode/v6/forward?${params}`);
  const f = (data.features || [])[0];
  if (!f) return null;
  const [lng, lat] = f.geometry.coordinates;
  const p = f.properties || {};
  return { lng, lat, label: p.full_address || p.name || q, accuracy: p.match_code?.confidence || 'unknown' };
}

const range = (n) => Array.from({ length: n }, (_, i) => i);
const chunk = (xs, size) => { const out = []; for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size)); return out; };

/**
 * The blocks a matrix is asked in: every source against every destination,
 * at most 12 of each a call (so at most 24 points). With no lists, every
 * point against every point.
 */
export function matrixBlocks(n, sources = range(n), destinations = range(n), size = BLOCK) {
  const blocks = [];
  for (const a of chunk(sources, size)) {
    for (const b of chunk(destinations, size)) {
      const ids = [...new Set([...a, ...b])];
      blocks.push({ ids, from: a, to: b, sources: a.map((x) => ids.indexOf(x)), destinations: b.map((x) => ids.indexOf(x)) });
    }
  }
  return blocks;
}

/** Mapbox bills a matrix by its elements: sources x destinations. */
export const elements = (sources, destinations) => sources.length * destinations.length;

/**
 * Seconds and metres from each source to each destination, as full n x n
 * tables (null where not asked). The page asks only for the pairs it has not
 * kept (lib/cache.js), so a stop driven to before costs nothing again.
 */
export async function matrix(fetcher, token, points, sources = range(points.length), destinations = range(points.length)) {
  const n = points.length;
  const durations = Array.from({ length: n }, () => Array(n).fill(null));
  const distances = Array.from({ length: n }, () => Array(n).fill(null));
  for (let i = 0; i < n; i += 1) { durations[i][i] = 0; distances[i][i] = 0; }
  await inBatches(matrixBlocks(n, sources, destinations).map((b) => async () => {
    const params = new URLSearchParams({
      sources: b.sources.join(';'), destinations: b.destinations.join(';'),
      annotations: 'duration,distance', access_token: token,
    });
    const data = await getJson(fetcher, `${API}/directions-matrix/v1/mapbox/driving/${b.ids.map((i) => coord(points[i])).join(';')}?${params}`);
    if (data.code && data.code !== 'Ok') throw new Error(`Mapbox matrix: ${data.code}`);
    b.from.forEach((i, s) => b.to.forEach((j, d) => {
      durations[i][j] = data.durations?.[s]?.[d] ?? null;
      distances[i][j] = data.distances?.[s]?.[d] ?? null;
    }));
  }));
  return { durations, distances };
}

/** Index lists for a matrix call: whole numbers in range, no repeats; null if not. */
export function validIndexes(xs, n) {
  if (xs == null) return range(n);
  if (!Array.isArray(xs) || !xs.length || xs.length > n) return null;
  if (!xs.every((x) => Number.isInteger(x) && x >= 0 && x < n) || new Set(xs).size !== xs.length) return null;
  return xs;
}

/** Consecutive runs of at most 25 points, each starting where the last ended. */
export function routeChunks(n, size = 25) {
  const out = [];
  for (let i = 0; i < n - 1; i += size - 1) out.push([i, Math.min(n - 1, i + size - 1)]);
  return out;
}

export async function route(fetcher, token, points) {
  const parts = await inBatches(routeChunks(points.length).map(([a, b]) => async () => {
    // continue_straight=false: a U-turn at a stop is allowed, as the matrix allows it. Without it every
    // stop on a dead-end or across the street is reached by looping the block (found 2026-10-22: 3 min a leg).
    const params = new URLSearchParams({ geometries: 'geojson', overview: 'full', steps: 'false', continue_straight: 'false', access_token: token });
    const data = await getJson(fetcher, `${API}/directions/v5/mapbox/driving/${points.slice(a, b + 1).map(coord).join(';')}?${params}`);
    const r = data.routes?.[0];
    if (!r) throw new Error(`Mapbox directions: ${data.code || 'no route'}`);
    return r;
  }));
  const legs = [];
  const geometry = [];
  for (const r of parts) {
    for (const l of r.legs) legs.push({ duration: l.duration, distance: l.distance });
    const line = r.geometry.coordinates.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
    geometry.push(...(geometry.length ? line.slice(1) : line));
  }
  return { legs, geometry };
}
