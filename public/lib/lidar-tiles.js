/**
 * USGS'S NEWEST LIDAR WHEN IT IS ONLY LAZ TILES (core session, 2026-10-29).
 *
 * USGS publishes every 3DEP flight as LAZ tiles on rockyweb.usgs.gov, and
 * most of them again as Entwine octrees on AWS, which is what every reader
 * here walks. A flight that has not been made an octree yet (Salt Lake
 * County 2023; the 2023-24 ID_SouthernGaps survey that filled a hole in
 * Southern Idaho 2018 over part of Ketchum) exists only as tiles of 20-500
 * MB, which a phone cannot read and a Worker cannot decode. So:
 *
 *   - the detector's pipeline (tools/lidar-newest.js, H96) picks the newest
 *     flight by USGS's own dates, tiles included, and reads the tiles on the
 *     training runner or the model server's volume;
 *   - the shade and water maps get such a flight as a CLOUD whose url is the
 *     Worker's /api/lidar/tiles route (worker/src/lidar-tiles.js) instead of
 *     an ept.json; the model server crops the tiles to the box it is asked
 *     for and answers a small LAZ (tools/modal_serve.py lidar_tiles,
 *     tools/lidar_sources.py crop_tiles_laz), fetching the tiles onto its
 *     volume the first time (202 meanwhile). The pages' pointsIn reads that
 *     LAZ as it reads an octree node.
 *
 * The pure parts live here so the tools, the Worker and the pages share one
 * answer to "which tiles, and are they newer".
 *
 * (owner, 2026-10-29: "make sure we're pulling the newest and most up to
 * date lidar everywhere")
 */

export const YEAR_MS = 365.25 * 86400000;
export const TNM = 'https://tnmaccess.nationalmap.gov/api/v1/products';
export const TILES_ROUTE = '/api/lidar/tiles';
/** A tile url this site will fetch: USGS's staged LPC tree, nothing else. */
export const TILE_URL = /^https:\/\/rockyweb\.usgs\.gov\/vdelivery\/Datasets\/Staged\/Elevation\/LPC\/Projects\/[A-Za-z0-9_./-]+\.laz$/;
export const MAX_TILES = 12;
/** The widest box the crop answers, in Web Mercator metres (the water map's wind box is ~600 m). */
export const MAX_BOX_M = 1500;

export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The work unit folder of a rockyweb LAZ url: .../Projects/<project>/<unit>/LAZ/<file>. */
export function unitFolder(url) {
  const parts = String(url || '').split('/');
  const i = parts.lastIndexOf('LAZ');
  return i > 0 ? parts[i - 1] : null;
}

/**
 * USGS's published tile collections over a frame that no octree carries:
 * [{ unit, end, epoch, tiles: [url], mb, record }]. `items` is the TNM API's
 * list; `units` the work units USGS's index (WESM) names over the point;
 * `octreeUnits` the work units the octrees over it were built from.
 */
export function tileSets(items, units, octreeUnits) {
  const onAws = new Set((octreeUnits || []).filter(Boolean).map(norm));
  const sets = new Map();
  for (const it of items || []) {
    const url = it.downloadLazURL || (/\.laz$/i.test(it.downloadURL || '') ? it.downloadURL : null);
    if (!url) continue;
    const folder = unitFolder(url);
    const unit = units.find((u) => norm(u.workunit) === norm(folder))
      || units.find((u) => norm(folder).includes(norm(u.workunit)) && norm(u.workunit));
    if (!unit || unit.end === null || unit.end === undefined || onAws.has(norm(unit.workunit)) || /legacy/i.test(unit.project || '')) continue;
    const s = sets.get(unit.workunit) || { unit: unit.workunit, end: unit.end, epoch: unit.epoch ?? null, tiles: [], mb: 0, record: unit };
    if (!s.tiles.includes(url)) {
      s.tiles.push(url);
      s.mb += (Number(it.sizeInBytes) || 0) / 1e6;
    }
    sets.set(unit.workunit, s);
  }
  return [...sets.values()];
}

/** The newest: an octree by date (density breaks a tie), tiles only when over a year newer. */
export function pickNewest(octrees, sets) {
  const best = octrees.slice().sort((a, b) => ((b.end ?? -Infinity) - (a.end ?? -Infinity)) || ((b.density || 0) - (a.density || 0)))[0] || null;
  const tiles = sets.slice().sort((a, b) => b.end - a.end)[0] || null;
  if (tiles && (!best || best.end === null || best.end === undefined || tiles.end - best.end > YEAR_MS)) return { kind: 'tiles', ...tiles };
  return best ? { kind: 'octree', ...best } : null;
}

/** The TNM API's query for the LAZ tiles within `halfM` metres of a point. */
/*
 * THE ADDRESS'S AREA (owner, 2026-10-29: "when a user enters an address into
 * lawn map: we should initiate the download, crop it to the sizes needed by
 * the shade map and water map, save it to a cache"). The square the model
 * server cuts from USGS's tiles once an address is confirmed (WARM_ROUTE ->
 * tools/modal_serve.py warm_area), at full density: AREA_HALF_M ground metres
 * each way, the same square tnmUrl asks USGS's index about, so the tiles
 * named cover it. The shade map's box (the lot and its margin), the water
 * map's (thinned) and the detector's frame are then cut from it in a second
 * or two instead of from whole tiles.
 */
export const AREA_HALF_M = 250;
export const WARM_ROUTE = '/api/lidar/warm';

/** The area round a point, [w, s, e, n] in Web Mercator metres. */
export function areaAround(lng, lat, halfM = AREA_HALF_M) {
  const R = 6378137;
  const x = R * (lng * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const h = halfM / Math.cos((lat * Math.PI) / 180);
  return [x - h, y - h, x + h, y + h];
}

export function tnmUrl(lng, lat, halfM = AREA_HALF_M) {
  const dLat = halfM / 111320;
  const dLng = halfM / (111320 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((v) => v.toFixed(5)).join(',');
  return `${TNM}?${new URLSearchParams({ datasets: 'Lidar Point Cloud (LPC)', bbox, max: '200', outputFormat: 'JSON' })}`;
}

const year = (ms) => (ms === null || ms === undefined ? null : new Date(ms).getUTCFullYear());

/**
 * Tile sets as clouds the pages can read (the shape public/shade/find.js
 * gives an octree, plus kind, tiles and mb): the url is the Worker's route
 * naming the tiles; the page adds the box it wants.
 */
export function tileClouds(sets, route = TILES_ROUTE) {
  return sets.map((s) => ({
    name: s.unit,
    url: `${route}?unit=${encodeURIComponent(s.unit)}&tiles=${encodeURIComponent(s.tiles.join(','))}`,
    kind: 'tiles', tiles: s.tiles, mb: Math.round(s.mb),
    year: year(s.end), epoch: s.epoch ?? (year(s.end) ? year(s.end) + 0.5 : 2018),
    unit: s.record, density: null, confirmed: true,
  }));
}

/**
 * A ranked answer ({ clouds, notOnAws } from find.js's rankClouds) with the
 * tile clouds in it: BEFORE the octrees when over a year newer than the
 * newest confirmed one (or when none is confirmed), else right after them --
 * so a hole in an octree (a lot with too few points) falls through to the
 * tiles. A unit now readable as tiles leaves notOnAws.
 */
export function withTiles(ranked, tiles) {
  const clouds = ranked?.clouds || [];
  if (!tiles?.length) return { clouds, notOnAws: ranked?.notOnAws || [] };
  const confirmed = clouds.filter((c) => c.confirmed && c.kind !== 'tiles');
  const boxOnly = clouds.filter((c) => !c.confirmed && c.kind !== 'tiles');
  const newestEnd = confirmed.reduce((m, c) => Math.max(m, c.unit?.end ?? -Infinity), -Infinity);
  const byEnd = (a, b) => (b.unit?.end ?? 0) - (a.unit?.end ?? 0);
  const first = tiles.filter((t) => !Number.isFinite(newestEnd) || (t.unit?.end ?? 0) - newestEnd > YEAR_MS).sort(byEnd);
  const later = tiles.filter((t) => !first.includes(t)).sort(byEnd);
  const named = new Set(tiles.map((t) => t.name));
  return {
    clouds: [...first, ...confirmed, ...later, ...boxOnly],
    notOnAws: (ranked?.notOnAws || []).filter((u) => !named.has(u.workunit)),
  };
}

/** "w,s,e,n" in Web Mercator metres -> [w, s, e, n], or null when not a box this route answers. */
export function parseBox(s) {
  const v = String(s || '').split(',').map(Number);
  if (v.length !== 4 || !v.every(Number.isFinite)) return null;
  const [w, so, e, n] = v;
  if (!(w < e && so < n) || e - w > MAX_BOX_M || n - so > MAX_BOX_M) return null;
  if (Math.abs(w) > 20037508.35 || Math.abs(e) > 20037508.35 || Math.abs(so) > 20037508.35 || Math.abs(n) > 20037508.35) return null;
  return [w, so, e, n];
}

/** The tile urls named in a route url's query, or null when any is not USGS's. */
export function tilesOf(params) {
  const tiles = String(params.get('tiles') || '').split(',').filter(Boolean);
  if (!tiles.length || tiles.length > MAX_TILES || !tiles.every((t) => TILE_URL.test(t))) return null;
  return tiles;
}

/** A cloud's url with the box (and a thinning spacing) the page wants. */
export function tilesQuery(url, bbox, spacingM = 0) {
  const box = bbox.map((v) => Number(v).toFixed(2)).join(',');
  return `${url}${url.includes('?') ? '&' : '?'}box=${box}${spacingM > 0 ? `&spacing=${Number(spacingM)}` : ''}`;
}
