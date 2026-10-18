/**
 * THE SOIL UNDER A LOT, FROM THE USDA SOIL SURVEY (water session, 2026-10-18).
 *
 * Owner, 2026-10-18 (water/VISION.md): "soil drainage classes (assume native
 * soil, maybe we'll add an option to place a 4 inch layer of loamy topsoil
 * on top of lawns if the user says that applies to their lawn)".
 *
 * Soil Data Access (https://sdmdataaccess.sc.egov.usda.gov), no key, open to
 * browsers (Access-Control-Allow-Origin: *). Over the lot's box: each map
 * unit's polygon clipped to the box, its major components (drainage class,
 * hydrologic group), the dominant one's horizons (Ksat, available water,
 * texture), the map unit's annual minimum water-table depth, and by month
 * the top of any "Wet" soil layer -- the seasonal water table.
 *
 * `post(sql)` is the caller's: it sends one query and resolves to the rows
 * (arrays of strings, no header). sdaPost below does it with fetch.
 */

export const SDA = 'https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest';

/** One query to Soil Data Access -> rows (arrays), [] when it answers nothing. */
export async function sdaPost(sql, fetchFn = fetch, { tries = 3, timeoutMs = 20000 } = {}) {
  /* Each query answers in well under a second, but now and then one hangs for minutes (seen once,
     2026-10-18: 211 s): give up on it after timeoutMs and ask again. */
  let last;
  for (let k = 0; k < tries; k++) {
    try {
      const res = await fetchFn(SDA, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql, format: 'JSON' }), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`soil survey answered ${res.status}`);
      const text = await res.text();
      if (!text.trim()) return [];
      return JSON.parse(text).Table || [];
    } catch (e) { last = e; }
  }
  throw last;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Drainage classes, wettest last, as the survey spells them. */
export const DRAINAGE = ['Excessively drained', 'Somewhat excessively drained', 'Well drained', 'Moderately well drained', 'Somewhat poorly drained', 'Poorly drained', 'Very poorly drained'];

/** [w, s, e, n] degrees -> the WKT polygon the survey intersects with. */
export function boxWkt([w, s, e, n]) {
  const f = (v) => v.toFixed(7);
  return `POLYGON((${f(w)} ${f(n)},${f(e)} ${f(n)},${f(e)} ${f(s)},${f(w)} ${f(s)},${f(w)} ${f(n)}))`;
}

/** WKT POLYGON / MULTIPOLYGON -> GeoJSON-style polygons ([[ring], [hole], ...] lists of [lng, lat]). */
export function parseWkt(wkt) {
  const s = String(wkt || '').trim();
  const body = s.replace(/^[A-Z]+\s*/i, '');
  if (!/^(MULTI)?POLYGON/i.test(s) || /EMPTY/i.test(s)) return [];
  const polys = [];
  // each polygon is ((ring),(ring)); split on the double parentheses
  const inner = /^MULTI/i.test(s) ? body.slice(1, -1) : body;
  for (const p of inner.split(/\)\)\s*,\s*\(\(/)) {
    const rings = p.replace(/^\(+|\)+$/g, '').split(/\)\s*,\s*\(/).map((r) => r.split(',').map((pt) => pt.trim().split(/\s+/).map(Number)));
    polys.push(rings);
  }
  return polys;
}

/**
 * Everything the survey says about the ground in `box` ([w, s, e, n] degrees).
 * -> { units: [{ mukey, name, share, polygons, drainage, hydgrp, slope, wtMinCm,
 *                components: [...], profile: { name, horizons }, wetByMonth: [12 x cm|null] }] }
 * share: the unit's part of the box (0-1). Urban-land components carry no horizons; the
 * dominant component WITH horizons gives the profile, and is named.
 */
export async function soilFor(box, post) {
  const wkt = boxWkt(box);
  const geom = `geometry::STGeomFromText('${wkt}', 4326)`;
  const polys = await post(`SELECT mukey, mupolygongeo.STIntersection(${geom}).STAsText() AS g, mupolygongeo.STIntersection(${geom}).STArea() AS a FROM mupolygon WHERE mupolygongeo.STIntersects(${geom}) = 1`);
  if (!polys.length) return { units: [] };
  const byKey = new Map();
  let total = 0;
  for (const [mukey, g, a] of polys) {
    const u = byKey.get(mukey) || { mukey, polygons: [], area: 0 };
    u.polygons.push(...parseWkt(g)); u.area += Number(a) || 0; total += Number(a) || 0;
    byKey.set(mukey, u);
  }
  const keys = [...byKey.keys()].map((k) => `'${String(k).replace(/\D/g, '')}'`).join(',');
  const [comps, hz, wet] = await Promise.all([post(`SELECT mu.mukey, mu.muname, ma.wtdepannmin, c.cokey, c.compname, c.comppct_r, c.majcompflag, c.drainagecl, c.hydgrp, c.slope_r FROM mapunit mu JOIN muaggatt ma ON ma.mukey = mu.mukey JOIN component c ON c.mukey = mu.mukey WHERE mu.mukey IN (${keys}) ORDER BY mu.mukey, c.comppct_r DESC`),
    post(`SELECT c.cokey, h.hzname, h.hzdept_r, h.hzdepb_r, h.ksat_r, h.awc_r, h.sandtotal_r, h.claytotal_r, h.om_r, h.wthirdbar_r, h.wfifteenbar_r FROM component c JOIN chorizon h ON h.cokey = c.cokey WHERE c.mukey IN (${keys}) AND c.majcompflag = 'Yes' ORDER BY c.cokey, h.hzdept_r`),
    post(`SELECT c.cokey, cm.month, MIN(sm.soimoistdept_r) FROM component c JOIN comonth cm ON cm.cokey = c.cokey JOIN cosoilmoist sm ON sm.comonthkey = cm.comonthkey WHERE c.mukey IN (${keys}) AND c.majcompflag = 'Yes' AND sm.soimoiststat = 'Wet' GROUP BY c.cokey, cm.month`)]);

  const horizons = new Map();
  for (const [cokey, name, top, bottom, ksat, awc, sand, clay, om, fc, wp] of hz) {
    if (!horizons.has(cokey)) horizons.set(cokey, []);
    horizons.get(cokey).push({ name, topCm: num(top), bottomCm: num(bottom), ksatUmS: num(ksat), awc: num(awc), sand: num(sand), clay: num(clay), om: num(om), fc: num(fc), wp: num(wp) });
  }
  const wetBy = new Map();
  for (const [cokey, month, depth] of wet) {
    if (!wetBy.has(cokey)) wetBy.set(cokey, new Array(12).fill(null));
    const m = MONTHS.indexOf(month);
    if (m >= 0) wetBy.get(cokey)[m] = num(depth);
  }

  for (const [mukey, name, wtMin, cokey, compname, pct, major, drainage, hydgrp, slope] of comps) {
    const u = byKey.get(mukey);
    if (!u) continue;
    u.name = name; u.wtMinCm = num(wtMin);
    (u.components ||= []).push({ cokey, name: compname, pct: num(pct), major: String(major).trim() === 'Yes', drainage: drainage || null, hydgrp: hydgrp || null, slope: num(slope) });
  }
  const units = [...byKey.values()].map((u) => {
    const comps2 = u.components || [];
    const withProfile = comps2.find((c) => c.major && (horizons.get(c.cokey) || []).some((h) => h.awc !== null));
    const top = comps2.find((c) => c.major) || comps2[0] || {};
    const main = withProfile || top;
    return {
      mukey: u.mukey, name: u.name || null, share: total ? u.area / total : 0, polygons: u.polygons,
      drainage: main.drainage || top.drainage || null, hydgrp: main.hydgrp || top.hydgrp || null, slope: main.slope ?? null,
      wtMinCm: u.wtMinCm ?? null,
      components: comps2.map(({ cokey, ...c }) => c),
      profile: { name: main.name || null, horizons: horizons.get(main.cokey) || [] },
      wetByMonth: wetBy.get(main.cokey) || new Array(12).fill(null),
      urban: comps2.some((c) => /urban land/i.test(c.name || '')),
    };
  }).sort((a, b) => b.share - a.share);
  return { units };
}

/* A 4 INCH LAYER OF LOAMY TOPSOIL (owner's option): loam holds 0.12-0.16 of its volume as water the
   roots can use (FAO-56 Table 19; Rawls, Brakensiek & Saxton 1982: 0.153), taken here as 0.14; its
   saturated conductivity is 13.2 mm/h by Rawls 1982/1993's texture averages but 3.4 mm/h as the
   Green-Ampt effective value (Rawls, Brakensiek & Miller 1983) -- the slower, since a laid lawn is packed
   (water/PARAMS-SOURCES.md 4a, 4d). */
export const TOPSOIL = { cm: 10.16, awc: 0.14, ksatMmH: 3.4, name: 'loamy topsoil (added)' };

/** The root zone a lawn draws on, in cm: 12 in (owner, 2026-10-18: "Root depth varies based on species.
    But let's call it 12 inches for now."). Practice runs 6-12 in; FAO-56's 0.5-1.0 m is a maximum. */
export const ROOT_CM = 30.48;

/* HOW FAST THE GROUND TAKES SPRINKLER WATER BEFORE IT RUNS OFF, in/h, by texture and slope, under turf
   (USDA/NRCS "Maximum precipitation rates for slopes", as Hunter Industries' Irrigation Notes Table 3
   gives it; the "cover" column). Rows: coarse sandy, light sandy loam, silt loam, heavy clay / clay loam;
   each with a compact subsoil under it. Columns: 0-5%, 5-8%, 8-12%, 12%+ slope. */
const MAX_RATE = {
  sand: [2.0, 2.0, 1.5, 1.0], sandCompact: [1.75, 1.25, 1.0, 0.75],
  sandyLoam: [1.75, 1.25, 1.0, 0.75], sandyLoamCompact: [1.25, 1.0, 0.75, 0.5],
  siltLoam: [1.0, 0.8, 0.6, 0.4], siltLoamCompact: [0.6, 0.5, 0.4, 0.3],
  clay: [0.2, 0.15, 0.12, 0.1], clayCompact: [0.2, 0.15, 0.12, 0.1],
};

/** in/h the lawn takes before water runs off: rz from rootZone, slope m/m. */
export function maxSprinklerRate(rz, slope) {
  const sand = rz?.texture?.sand ?? 40, clay = rz?.texture?.clay ?? 20;
  const row = sand >= 80 ? 'sand' : clay >= 27 ? 'clay' : sand >= 50 ? 'sandyLoam' : 'siltLoam';
  const compact = rz?.belowMmH !== null && rz?.ksatMmH && rz.belowMmH < 0.25 * rz.ksatMmH;
  const col = slope < 0.05 ? 0 : slope < 0.08 ? 1 : slope < 0.12 ? 2 : 3;
  return { inPerH: MAX_RATE[compact ? `${row}Compact` : row][col], texture: row, compact: !!compact };
}

/**
 * What a profile holds and passes, over the root zone.
 * -> { tawMm: water the roots can use between full and wilting, ksatMmH: the surface's
 *      intake (the slowest layer in the root zone), belowMmH: the slowest layer in the metre
 *      under the roots (how fast the root zone drains), texture: { sand, clay } of the top }
 */
export function rootZone(profile, { rootCm = ROOT_CM, topsoil = false } = {}) {
  let layers = (profile?.horizons || []).filter((h) => h.topCm !== null && h.bottomCm !== null && h.bottomCm > h.topCm)
    .map((h) => ({ top: h.topCm, bottom: h.bottomCm, awc: h.awc, ksat: h.ksatUmS === null ? null : h.ksatUmS * 3.6, sand: h.sand, clay: h.clay }));
  if (topsoil) {
    const t = TOPSOIL.cm;
    layers = [{ top: 0, bottom: t, awc: TOPSOIL.awc, ksat: TOPSOIL.ksatMmH, sand: 40, clay: 20 }, ...layers.map((l) => ({ ...l, top: l.top + t, bottom: l.bottom + t }))];
  }
  if (!layers.length) return null;
  let taw = 0, ksat = Infinity, below = Infinity, depth = 0;
  for (const l of layers) {
    const a = Math.max(l.top, 0), b = Math.min(l.bottom, rootCm);
    if (b > a && l.awc !== null) { taw += (b - a) * 10 * l.awc; depth += b - a; }
    if (b > a && l.ksat !== null) ksat = Math.min(ksat, l.ksat);
    const a2 = Math.max(l.top, rootCm), b2 = Math.min(l.bottom, rootCm + 100);
    if (b2 > a2 && l.ksat !== null) below = Math.min(below, l.ksat);
  }
  if (depth < rootCm && depth > 0) taw *= rootCm / depth; // a profile shallower than the roots: as its own
  return {
    tawMm: taw, rootCm,
    ksatMmH: Number.isFinite(ksat) ? ksat : null,
    belowMmH: Number.isFinite(below) ? below : (Number.isFinite(ksat) ? ksat : null),
    texture: { sand: layers[0].sand, clay: layers[0].clay },
    topsoil: !!topsoil,
  };
}

/** The shallowest seasonal water table (cm) in a month, survey "Wet" layers, else the annual minimum, else null. */
export function waterTableCm(unit, month) {
  const v = unit?.wetByMonth?.[month];
  if (v !== null && v !== undefined) return v;
  return null;
}
