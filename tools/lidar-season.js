/**
 * WHEN THE LIDAR WAS FLOWN, AND WHETHER IN LEAF (owner, 2026-10-05).
 *
 * USGS's 3DEP index (layer 8, "Lidar Point Cloud") holds, for every work unit,
 * the first and last day of collection -- the same collections our point
 * clouds come from (most county and state lidar is contributed to 3DEP). Two
 * uses:
 *   - the tree lidar (tools/tree_lidar.py): last returns stopping in a crown
 *     mean "evergreen" only when the flight was leaf-off; in a summer flight a
 *     broadleaf stops them too;
 *   - the owner's question: which counties with a county photo also have
 *     lidar, when, and how far from the photo's year.
 *
 * LEAF-OFF here is "nine days in ten of the collection between 1 November
 * and 10 May" -- a rule of thumb for the temperate US, wrong in the far South
 * and at altitude, and said as such wherever it is printed.
 */
export const WESM = 'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/8/query';
/** Is a day (UTC) in the leaf-off window, 1 November to 10 May? */
const leafOffDay = (t) => {
  const d = new Date(t), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return m >= 11 || m <= 4 || (m === 5 && day <= 10);
};

/** 'off' if 90%+ of the collection's days are in the leaf-off window, 'on' if 10% or fewer, else 'mixed'; null without dates. */
export function leafSeason(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const DAY = 86400000;
  let off = 0, n = 0;
  for (let t = startMs; t <= endMs && n < 3660; t += DAY, n++) if (leafOffDay(t)) off++;
  const share = off / Math.max(1, n);
  return share >= 0.9 ? 'off' : share <= 0.1 ? 'on' : 'mixed';
}

/** The 3DEP lidar collections over a point, newest first: [{ workunit, ql, start, end, season, year }]. */
export async function lidarAt(lng, lat, { fetchJson = defaultFetch } = {}) {
  const q = new URLSearchParams({
    geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false', f: 'json',
    outFields: 'workunit,project,collect_start,collect_end,ql,lpc_category',
  });
  const d = await fetchJson(`${WESM}?${q}`);
  if (d?.error) throw new Error(d.error.message || 'query failed');
  return (d?.features || []).map(({ attributes: a }) => ({
    workunit: a.workunit, project: a.project, ql: a.ql,
    start: a.collect_start ? new Date(a.collect_start).toISOString().slice(0, 10) : null,
    end: a.collect_end ? new Date(a.collect_end).toISOString().slice(0, 10) : null,
    season: leafSeason(a.collect_start, a.collect_end),
    year: a.collect_end ? new Date(a.collect_end).getUTCFullYear() : null,
  })).sort((x, y) => String(y.end).localeCompare(String(x.end)));
}

async function defaultFetch(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.ok) return res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw last;
}
