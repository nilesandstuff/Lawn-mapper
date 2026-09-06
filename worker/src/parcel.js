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

import { COUNTIES, candidateCounties } from './counties.js';

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
function queryVariants(lng, lat) {
  const base = {
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outSR: '4326',            // <-- normalizes every county to WGS84
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
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
  if (cfg.service) list.push({ service: cfg.service, layer: cfg.layer, fields: cfg.fields });
  for (const f of cfg.fallbacks || []) {
    list.push({ service: f.service, layer: f.layer, fields: f.fields || cfg.fields });
  }
  return list;
}

async function queryCounty(countyKey, lng, lat) {
  const cfg = COUNTIES[countyKey];
  if (!cfg || !cfg.service) return null;

  for (const endpoint of endpointsFor(cfg)) {
    const parcel = await queryEndpoint(cfg, countyKey, endpoint, lng, lat);
    if (parcel) return parcel;
  }
  return null;
}

async function queryEndpoint(cfg, countyKey, endpoint, lng, lat) {
  let data = null;
  for (const params of queryVariants(lng, lat)) {
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

  const feature = data.features[0];
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

/**
 * Look up the parcel containing a point. Tries each candidate county in
 * turn; the bbox filter usually leaves exactly one.
 */
async function lookupParcel(lng, lat) {
  for (const key of candidateCounties(lng, lat)) {
    const parcel = await queryCounty(key, lng, lat);
    if (parcel) return parcel;
  }
  return null;
}

export { lookupParcel, queryCounty, esriToGeoJSON };
