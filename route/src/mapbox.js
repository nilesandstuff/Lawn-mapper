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

/** The blocks a matrix of n points is asked in: [{ ids, sources, destinations }]. */
export function matrixBlocks(n, size = BLOCK) {
  const groups = [];
  for (let i = 0; i < n; i += size) groups.push(Array.from({ length: Math.min(size, n - i) }, (_, k) => i + k));
  const blocks = [];
  for (const a of groups) {
    for (const b of groups) {
      const ids = a === b ? a : [...a, ...b];
      blocks.push({ ids, from: a, to: b, sources: a.map((x) => ids.indexOf(x)), destinations: b.map((x) => ids.indexOf(x)) });
    }
  }
  return blocks;
}

export async function matrix(fetcher, token, points) {
  const n = points.length;
  const durations = Array.from({ length: n }, () => Array(n).fill(null));
  const distances = Array.from({ length: n }, () => Array(n).fill(null));
  await inBatches(matrixBlocks(n).map((b) => async () => {
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
