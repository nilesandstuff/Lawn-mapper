/**
 * Parcel boundary lookup against county ArcGIS REST services.
 *
 * MUST run server-side. Two reasons, both hard blockers for browser calls:
 *   1. County GIS servers generally do not send CORS headers.
 *   2. We want to cache responses -- parcel boundaries change on the order
 *      of years, so a cached hit costs nothing and spares the county's
 *      server, which is a small public asset we should not hammer.
 *
 * Returns GeoJSON in WGS84 or null. Null is a normal, expected outcome:
 * unmapped parcels, condos, new construction, and every address outside the
 * five-county footprint. The UI must treat "no parcel" as the default path
 * (user draws their own bounds), not as an error state.
 */

// ALL_COUNTIES, not COUNTIES: candidateCounties nominates generated atlas keys
// as well as hand-written ones, and a nomination this cannot resolve is a
// silently missing property line.
import { ALL_COUNTIES, candidateCounties } from './counties.js';
import { geometryAreaSqM } from '../../public/lib/area.js';

const REQUEST_TIMEOUT_MS = 6000;

/** Convert an Esri polygon geometry to GeoJSON Polygon/MultiPolygon. */
function esriToGeoJSON(esri) {
  if (!esri || !Array.isArray(esri.rings) || esri.rings.length === 0) return null;

  // Esri uses clockwise for outer rings and counter-clockwise for holes.
  // GeoJSON's spec is the opposite, but area.js takes absolute values and
  // subtracts interior rings explicitly, so winding does not affect our
  // measurement. We still separate outer rings from holes by signed area so
  // the geometry renders correctly in Mapbox.
  const signedArea = (ring) => {
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return s / 2;
  };

  const outers = [];
  const holes = [];
  for (const ring of esri.rings) {
    (signedArea(ring) < 0 ? holes : outers).push(ring);
  }

  if (outers.length === 0) return { type: 'Polygon', coordinates: [esri.rings[0]] };

  if (outers.length === 1) {
    return { type: 'Polygon', coordinates: [outers[0], ...holes] };
  }

  // Multiple outer rings: assign each hole to the first outer ring whose
  // bbox contains it. Good enough -- split parcels with holes are rare.
  const bbox = (r) => r.reduce(
    ([w, s, e, n], [x, y]) => [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
  const polys = outers.map((o) => [o]);
  const boxes = outers.map(bbox);
  for (const hole of holes) {
    const [hw, hs, he, hn] = bbox(hole);
    const idx = boxes.findIndex(([w, s, e, n]) => hw >= w && hs >= s && he <= e && hn <= n);
    polys[idx >= 0 ? idx : 0].push(hole);
  }
  return { type: 'MultiPolygon', coordinates: polys };
}

/**
 * Query parameters, most capable first.
 *
 * Not every county server accepts the same options, and an unsupported one is
 * rejected outright rather than ignored: `resultRecordCount` makes Allegan and
 * Muskegon answer "Pagination is not supported", and some layers reject
 * `geometryPrecision` with "Invalid or missing input parameters". Both were
 * silently costing us real parcels. We ask for the good version first and fall
 * back, rather than sending the lowest common denominator to everyone.
 */
function queryVariants(lng, lat, where) {
  const base = {
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outSR: '4326',            // <-- normalizes every county to WGS84
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    /*
     * Most counties publish only current parcels and need no filter. Champaign
     * does not: its layer is a parcel fabric carrying RetiredByRecord and
     * LegalEndDate, so a point sits inside the current lot AND every retired
     * parent it was split from, and the first feature back is not reliably the
     * live one. `where` lets an entry say which records count. Omitted, the
     * query is exactly what it always was.
     */
    ...(where ? { where } : {}),
  };
  return [
    // Full precision. Esri's default generalization can shave real footage.
    { ...base, geometryPrecision: '8' },
    base,
  ];
}

/**
 * Every endpoint to try for a county, best first.
 *
 * Kent's configured MapServer began timing out on every point query while a
 * FeatureServer on the same host answered instantly -- load, not
 * decommissioning, and it may well swap back. A county that publishes more
 * than one parcel service should use them: falling through to the second costs
 * one timeout and saves the property line, where failing costs the user their
 * boundary and tells them nothing.
 */
function endpointsFor(cfg) {
  const list = [];
  if (cfg.service) {
    list.push({ service: cfg.service, layer: cfg.layer, fields: cfg.fields, where: cfg.where });
  }
  for (const f of cfg.fallbacks || []) {
    list.push({
      service: f.service,
      layer: f.layer,
      fields: f.fields || cfg.fields,
      // A fallback states its own filter, and states it as null to mean none.
      // Inheriting cfg.where would make "the same query without the filter"
      // impossible to express, which is exactly what Champaign needs.
      where: f.where === undefined ? cfg.where : f.where,
    });
  }
  return list;
}

async function queryCounty(countyKey, lng, lat) {
  const cfg = ALL_COUNTIES[countyKey];
  if (!cfg || !cfg.service) return null;

  for (const endpoint of endpointsFor(cfg)) {
    const parcel = await queryEndpoint(cfg, countyKey, endpoint, lng, lat);
    if (parcel) return parcel;
  }
  return null;
}

async function queryEndpoint(cfg, countyKey, endpoint, lng, lat) {
  let data = null;
  for (const params of queryVariants(lng, lat, endpoint.where)) {
    const url = `${endpoint.service}/${endpoint.layer}/query?${new URLSearchParams(params)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null; // this endpoint is unhappy; the caller tries the next

      const body = await res.json();
      // ArcGIS returns HTTP 200 with an { error } body on failure.
      if (body.error) continue; // try the simpler parameter set
      data = body;
      break;
    } catch {
      // Timeout, DNS failure, county server down -- all non-fatal.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  if (!data || !data.features || data.features.length === 0) return null;
  return featureFrom(cfg, countyKey, endpoint, data.features[0]);
}

/** One of the county's features as the app's parcel, or null. */
function featureFrom(cfg, countyKey, endpoint, feature) {
  const geometry = esriToGeoJSON(feature.geometry);
  if (!geometry) return null;

  const attrs = feature.attributes || {};
  const f = endpoint.fields;
  const address =
    attrs[f.address] ||
    [attrs[f.streetNum], attrs[f.streetName]].filter(Boolean).join(' ') ||
    null;

  return {
    type: 'Feature',
    geometry,
    properties: {
      county: cfg.name,
      countyKey,
      pin: attrs[f.pin] ?? null,
      address: address ? String(address).trim() : null,
      source: 'county-gis',
    },
  };
}

/* ------------------------------------------- the parcel a queued lawn IS */
/*
 * A POINT IS NOT A PARCEL (2026-10-10). The lawn queue stored a point and the
 * editor asked the county what is there -- and for an L-shaped lot the
 * sampler's point, the middle of its bounding box, is in the notch: the
 * neighbour's. A lot queued at 24,465 sq ft opened as the 225-acre quarry
 * beside it (Grant County, WV). So a lookup can carry what the queue knows
 * about the parcel it meant: its number (pin), asked for directly, or
 * failing that its size (sqft), used to pick the right one of the parcels
 * around the point. A parcel found another way than the point says so in
 * properties.matched; one that matches neither carries properties.mismatch
 * so the editor can say the record has changed under the job.
 */
const SQFT_PER_SQM = 10.7639;
const SQFT_SLACK = 0.05;       // the sampler measured the same geometry; 5% is generous
const PIN_REACH_DEG = 0.01;    // ~1 km: a number that matches across the county is not this lot
const AROUND_DEG = 0.002;      // ~200 m around the point, the sampler's own reach

const sqftOf = (geometry) => { try { return geometryAreaSqM(geometry) * SQFT_PER_SQM; } catch { return NaN; } };

/** Degrees from a point to a geometry's box: 0 inside it. */
function distanceToBox([lng, lat], geometry) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); return; }
    for (const part of c) walk(part);
  };
  walk(geometry?.coordinates || []);
  if (!Number.isFinite(w)) return Infinity;
  const dx = lng < w ? w - lng : lng > e ? lng - e : 0;
  const dy = lat < s ? s - lat : lat > n ? lat - n : 0;
  return Math.hypot(dx, dy);
}

/** `where` for one parcel by number: quoted first (most pin fields are text), then bare for a numeric one. */
function pinClauses(field, pin) {
  const out = [`${field} = '${String(pin).replace(/'/g, "''")}'`];
  if (/^\d+$/.test(String(pin))) out.push(`${field} = ${pin}`);
  return out;
}

async function queryByPin(cfg, countyKey, endpoint, pin, near) {
  const field = endpoint.fields?.pin;
  if (!field) return null;
  for (const where of pinClauses(field, pin)) {
    const params = { f: 'json', where, outFields: '*', returnGeometry: 'true', outSR: '4326' };
    const url = `${endpoint.service}/${endpoint.layer}/query?${new URLSearchParams(params)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let body;
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      body = await res.json();
    } catch { return null; } finally { clearTimeout(timer); }
    if (body?.error) continue; // the bare number next, if there is one to try
    const feats = Array.isArray(body?.features) ? body.features : [];
    /* The nearest of them: a number can repeat (a condominium's units, the
       halves of a split), and one nowhere near the point is another lot. */
    let best = null, bestD = Infinity;
    for (const feat of feats) {
      const f = featureFrom(cfg, countyKey, endpoint, feat);
      if (!f) continue;
      const d = distanceToBox(near, f.geometry);
      if (d < bestD) { best = f; bestD = d; }
    }
    return best && bestD <= PIN_REACH_DEG ? best : null;
  }
  return null;
}

/**
 * Look up the parcel containing a point. Tries each candidate county in
 * turn; the bbox filter usually leaves exactly one.
 */
async function lookupParcel(lng, lat, { pin = null, sqft = null } = {}) {
  const keys = candidateCounties(lng, lat);
  if (pin) {
    for (const key of keys) {
      const cfg = ALL_COUNTIES[key];
      if (!cfg?.service) continue;
      for (const endpoint of endpointsFor(cfg)) {
        const parcel = await queryByPin(cfg, key, endpoint, pin, [lng, lat]);
        if (parcel) { parcel.properties.matched = 'pin'; return parcel; }
      }
    }
  }
  let found = null;
  for (const key of keys) {
    found = await queryCounty(key, lng, lat);
    if (found) break;
  }
  if (!found || !(Number(sqft) > 0)) return found;
  const want = Number(sqft);
  const area = sqftOf(found.geometry);
  if (!(area > 0) || Math.abs(area - want) / want <= SQFT_SLACK) return found;
  /* The point's parcel is not the one queued: the one of that size beside it. */
  const around = await lookupNeighbours(found.properties.countyKey,
    [lng - AROUND_DEG, lat - AROUND_DEG, lng + AROUND_DEG, lat + AROUND_DEG]);
  let best = null, bestD = Infinity;
  for (const n of around) {
    const a = sqftOf(n.geometry);
    if (!(a > 0) || Math.abs(a - want) / want > SQFT_SLACK) continue;
    const d = distanceToBox([lng, lat], n.geometry);
    if (d < bestD) { best = n; bestD = d; }
  }
  if (best) {
    best.properties = { ...best.properties, address: best.properties.address ?? null, source: 'county-gis', matched: 'sqft' };
    return best;
  }
  found.properties.mismatch = { queuedSqFt: Math.round(want), foundSqFt: Math.round(area) };
  return found;
}

/**
 * THE PARCELS AROUND ONE, for tinker mode's "merge this parcel" and for
 * checking that a front edge moved out to the road does not run over
 * somebody else's lot (public/lib/frontage.js).
 *
 * One envelope query on the county's own layer, the box the caller names
 * (the parcel's, padded). Same endpoints and fallbacks as the point lookup.
 * At most MAX_NEIGHBOURS come back: a box around a house lot holds a dozen,
 * and one around a farm in a subdivision should not return the subdivision.
 */
const MAX_NEIGHBOURS = 60;

export function envelopeParams(bbox, where) {
  const [w, s, e, n] = bbox;
  return {
    f: 'json',
    geometry: JSON.stringify({ xmin: w, ymin: s, xmax: e, ymax: n, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    ...(where ? { where } : {}),
  };
}

async function lookupNeighbours(countyKey, bbox) {
  const cfg = ALL_COUNTIES[countyKey];
  if (!cfg || !cfg.service) return [];
  for (const endpoint of endpointsFor(cfg)) {
    const url = `${endpoint.service}/${endpoint.layer}/query?${new URLSearchParams(envelopeParams(bbox, endpoint.where))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const body = await res.json();
      if (body.error || !Array.isArray(body.features)) continue;
      const f = endpoint.fields || {};
      return body.features.slice(0, MAX_NEIGHBOURS).map((feat) => {
        const geometry = esriToGeoJSON(feat.geometry);
        if (!geometry) return null;
        const attrs = feat.attributes || {};
        return {
          type: 'Feature',
          geometry,
          properties: { pin: attrs[f.pin] ?? null, county: cfg.name, countyKey },
        };
      }).filter(Boolean);
    } catch {
      // Next endpoint; a county that will not answer simply has no neighbours today.
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

export { lookupParcel, lookupNeighbours, queryCounty, esriToGeoJSON };
