/**
 * WHICH POINT CLOUD, FOR THIS PROPERTY (shade map, features session).
 *
 * Two sources, because neither is enough alone:
 *
 *   Hobu's footprints of every octree on AWS   (outlines, read by the Worker:
 *                                              worker/src/shade.js)
 *   USGS's 3DEP index (WESM)                   every collection flown over the
 *                                              exact point, with its dates and
 *                                              quality level -- the service
 *                                              tools/lidar-season.js uses
 *
 * A box alone picks wrong: a Nevada forest survey's box covers Salt Lake City
 * and its octree has nothing there (found 2026-10-10). WESM alone does not
 * say where the octree is. So a cloud is offered when its octree name
 * CONTAINS a WESM work unit's name over this point (WI_SEWRPC_2017 inside
 * USGS_LPC_WI_SEWRPC_2017_LAS_2019), newest flight first, and carries that
 * work unit's dates: the datum correction wants the flight's epoch, the
 * shade model wants its season. Box-only candidates come after, as
 * "unconfirmed".
 *
 * WESM ALSO SAYS WHAT IS MISSING. A collection flown over the point with no
 * octree on AWS (Salt Lake County 2023, QL1, on 2026-10-10) is listed as
 * `notOnAws`: newer lidar exists and this page cannot read it yet.
 */

import { eptUrlOf } from './names.js';

export const WESM = 'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/8/query';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 'off' if 90%+ of the days fall 1 Nov - 10 May (tools/lidar-season.js's rule), 'on' if 10% or fewer, else 'mixed'. */
export function leafSeason(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  let off = 0, n = 0;
  for (let t = startMs; t <= endMs && n < 3660; t += 86400000, n++) {
    const d = new Date(t), m = d.getUTCMonth() + 1;
    if (m >= 11 || m <= 4 || (m === 5 && d.getUTCDate() <= 10)) off++;
  }
  const share = off / Math.max(1, n);
  return share >= 0.9 ? 'off' : share <= 0.1 ? 'on' : 'mixed';
}

/** A decimal year for a time in ms. */
const decimalYear = (ms) => {
  const d = new Date(ms), y = d.getUTCFullYear();
  return y + (ms - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1));
};

/** The year in a project name (tools/lidar-cover.js's flownYear, repeated here: tools/ is not served). */
export function nameYear(name) {
  const ys = [...String(name || '').matchAll(/(?:^|[^0-9])(19[89]\d|20[0-4]\d)(?:[^0-9]|$)/g)].map((m) => Number(m[1]));
  if (ys.length) return Math.min(...ys);
  const m = /_[A-Z](\d{2})$/.exec(String(name || ''));
  return m ? 2000 + Number(m[1]) : null;
}

/** Entries whose box holds the point (the Worker has already checked the outlines). */
export function shortlist(index, lng, lat) {
  return (index?.projects || []).filter((p) => p.bbox[0] <= lng && lng <= p.bbox[2] && p.bbox[1] <= lat && lat <= p.bbox[3]);
}

/** WESM's answer as plain records. */
export function workUnits(wesmJson) {
  return (wesmJson?.features || []).map(({ attributes: a }) => ({
    workunit: a.workunit, project: a.project, ql: a.ql,
    start: a.collect_start ?? null, end: a.collect_end ?? null,
    season: leafSeason(a.collect_start, a.collect_end),
    epoch: Number.isFinite(a.collect_start) && Number.isFinite(a.collect_end)
      ? decimalYear((a.collect_start + a.collect_end) / 2) : null,
  }));
}

/**
 * The clouds to try, best first, and what WESM knows that AWS does not.
 * Pure: give it the index and WESM's JSON.
 */
export function rankClouds(index, wesmJson, lng, lat) {
  const boxes = shortlist(index, lng, lat);
  const units = workUnits(wesmJson);
  const used = new Set();
  const confirmed = [];
  for (const u of units) {
    const key = norm(u.workunit);
    if (!key) continue;
    const hit = boxes
      .filter((p) => norm(p.name).includes(key))
      .sort((a, b) => norm(a.name).length - norm(b.name).length)[0];
    if (hit && !used.has(hit.name)) {
      used.add(hit.name);
      confirmed.push({ ...cloud(hit), unit: u, epoch: u.epoch ?? (nameYear(hit.name) ?? 2010) + 0.5, confirmed: true });
    }
  }
  confirmed.sort((a, b) => (b.unit.end ?? 0) - (a.unit.end ?? 0));
  const others = boxes.filter((p) => !used.has(p.name))
    .map((p) => ({ ...cloud(p), unit: null, epoch: (nameYear(p.name) ?? 2010) + 0.5, confirmed: false }))
    .sort((a, b) => (nameYear(b.name) ?? 0) - (nameYear(a.name) ?? 0) || b.density - a.density);
  const matchedUnits = new Set(confirmed.map((c) => c.unit.workunit));
  const notOnAws = units.filter((u) => !matchedUnits.has(u.workunit) && !/legacy/i.test(u.project || ''))
    .sort((a, b) => (b.end ?? 0) - (a.end ?? 0));
  return { clouds: [...confirmed, ...others], notOnAws };
}

const cloud = (p) => ({
  name: p.name, url: eptUrlOf(p), year: nameYear(p.name),
  density: p.count && p.km2 ? p.count / (p.km2 * 1e6) : null,
});

/** Ask WESM about a point. */
export function wesmUrl(lng, lat) {
  const q = new URLSearchParams({
    geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false', f: 'json',
    outFields: 'workunit,project,collect_start,collect_end,ql',
  });
  return `${WESM}?${q}`;
}
