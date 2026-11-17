/**
 * A THERMAL WALK'S RECORDS ONTO THE LAWN (2026-11-15; shared since 2026-11-16 by the page, public/app.js checkWalk,
 * and the water builder, builder/headless.mjs, so the two place a walk the same way). Pure.
 *
 * The walk is the core's (GET /api/maps/thermal, docs/MAPS.md): records in the map's local metres east/north of
 * frame.lng/lat (the AR's toLocal/fromLocal, lib/ar-align.js), each kept when it is on the traced lawn or within
 * ON_TRACE_M of it (the moisture check's allowance: the photo a mark is put on and the one the lawn was traced on can
 * differ by about that much).
 */
import { fromLocal } from './ar-align.js';

export const ON_TRACE_M = 0.6;
const R = 6378137;
const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];

/** Metres from [lng, lat] to the traced lawn: 0 inside it, null with no trace. features: GeoJSON features or geometries. */
export function offLawnM([lng, lat], features) {
  if (!features?.length) return null;
  const k = Math.cos((lat * Math.PI) / 180), [px, py] = toMerc([lng, lat]);
  let inside = false, best = Infinity;
  for (const f of features) {
    const g = f.geometry || f, polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      let inPoly = false;
      poly.forEach((ring, ri) => {
        const pts = ring.map(toMerc); let c = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
          const ex = xj - xi, ey = yj - yi, L = ex * ex + ey * ey, t = L ? Math.max(0, Math.min(1, ((px - xi) * ex + (py - yi) * ey) / L)) : 0;
          best = Math.min(best, Math.hypot(px - xi - t * ex, py - yi - t * ey) * k);
        }
        if (ri === 0) inPoly = c; else if (c) inPoly = false;
      });
      if (inPoly) inside = true;
    }
  }
  return inside ? 0 : best;
}

/**
 * The walk's measurements for the check. walk: the core's walk JSON; site: { lng, lat, lawn (features) };
 * lawnAt([lng, lat]) -> bool, for a map with no trace (the plan's own lawn cells).
 * -> { records: [{ lng, lat, tm, T, band }] on the lawn, offLawn (count), kinds, notes, started, ended }
 */
export function walkRecords(walk, site, { lawnAt = () => false } = {}) {
  const recs = Array.isArray(walk?.records) ? walk.records : [];
  const kinds = [recs.length ? 'surface' : null, Array.isArray(walk?.moisture) && walk.moisture.length ? 'moisture' : null, Array.isArray(walk?.wind) && walk.wind.length ? 'wind' : null].filter(Boolean);
  const sky = walk?.sky ? { kind: walk.sky.kind, T_zenith: walk.sky.T_zenith ?? walk.sky.T, cloud_fraction: walk.sky.cloud_fraction, clear_T: walk.sky.clear_T, high_share: walk.sky.high_share } : null;
  const notes = { air: walk?.air || null, wet: walk?.wet ?? null, sprinklers: walk?.sprinklers ?? null, cloud: walk?.cloud ?? null, sky, cut: walk?.cut || null, camera: walk?.camera || null };
  const started = walk?.started ?? recs[0]?.t0, ended = walk?.ended ?? recs[recs.length - 1]?.t1 ?? null;
  const origin = [walk?.frame?.lng ?? site.lng, walk?.frame?.lat ?? site.lat], trace = site.lawn || [];
  const records = [];
  let usable = 0;
  for (const x of recs) {
    if (!Number.isFinite(x?.e) || !Number.isFinite(x?.n) || !Number.isFinite(x?.T) || !Number.isFinite(x?.tm)) continue;
    usable++;
    const [lng, lat] = fromLocal(origin, [x.e, x.n]);
    const off = offLawnM([lng, lat], trace);
    /* on the lawn by the trace (within ON_TRACE_M of it); with no trace, by the plan's own lawn cells; and on a whole
       property marked as lawn (site.wholeLot, 2026-11-17) by both: the property line holds driveways and patios too */
    const on = off === null ? lawnAt([lng, lat]) : off <= ON_TRACE_M && (!site.wholeLot || lawnAt([lng, lat]));
    if (on) records.push({ lng, lat, tm: x.tm, T: x.T, band: x.band || '0-60' });
  }
  return { records, offLawn: usable - records.length, kinds, notes, started, ended };
}
