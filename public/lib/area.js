/**
 * Geodesic area calculation for lawn polygons.
 *
 * Lives under public/lib/ because both sides need it: the browser imports it
 * over HTTP to show a live figure while the user drags vertices, and the
 * Worker imports it at build time to measure parcels server-side. One copy,
 * so the number the user watches and the number the API returns cannot drift.
 *
 * CRITICAL: All input coordinates are [lng, lat] in WGS84 (EPSG:4326).
 * Never pass projected (Web Mercator / EPSG:3857) coordinates to these
 * functions. At Michigan's latitude (~43N), computing area in Web Mercator
 * inflates the result by roughly 87% because of the projection's scale
 * distortion. That error is invisible without a ground-truth check, which
 * is exactly how a measurement tool ships quietly wrong.
 *
 * Implementation uses the spherical-excess method (Chamberlain & Duquette,
 * NASA JPL) -- the same approach Turf.js uses. Accurate to well under 0.1%
 * for parcel-sized polygons, which is far tighter than the underlying
 * imagery and hand-drawn boundaries.
 */

const EARTH_RADIUS_M = 6378137; // WGS84 semi-major axis
const SQM_PER_SQFT = 0.09290304;
const SQM_PER_ACRE = 4046.8564224;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Signed area of a single closed ring, in square meters.
 * Sign indicates winding order; callers use the absolute value.
 */
function ringAreaSqM(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;

  // Tolerate rings that are not explicitly closed.
  const pts = ring.slice();
  const [fx, fy] = pts[0];
  const [lx, ly] = pts[pts.length - 1];
  if (fx !== lx || fy !== ly) pts.push([fx, fy]);

  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [lng1, lat1] = pts[i];
    const [lng2, lat2] = pts[i + 1];
    total +=
      (toRad(lng2) - toRad(lng1)) *
      (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }

  return (total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2;
}

/**
 * Area of a GeoJSON Polygon or MultiPolygon, in square meters.
 * Interior rings (holes) are subtracted -- this is what makes a tree
 * canopy cutout or a driveway exclusion actually reduce the total.
 */
function geometryAreaSqM(geometry) {
  if (!geometry || !geometry.type) return 0;

  if (geometry.type === 'Polygon') {
    const [outer, ...holes] = geometry.coordinates;
    let area = Math.abs(ringAreaSqM(outer));
    for (const hole of holes) area -= Math.abs(ringAreaSqM(hole));
    return Math.max(0, area);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce(
      (sum, poly) => sum + geometryAreaSqM({ type: 'Polygon', coordinates: poly }),
      0
    );
  }

  if (geometry.type === 'Feature') return geometryAreaSqM(geometry.geometry);

  if (geometry.type === 'FeatureCollection') {
    return (geometry.features || []).reduce(
      (sum, f) => sum + geometryAreaSqM(f),
      0
    );
  }

  return 0;
}

/**
 * Primary entry point. Returns the measurement in every unit the UI needs.
 *
 * `precision` mirrors what we can honestly claim: satellite imagery is
 * roughly 0.5-1 ft/px and users trace by hand, so square footage is
 * rounded to the nearest 10 sq ft. Reporting 4,127 sq ft implies accuracy
 * the input data does not have.
 */
function measure(geometry) {
  const sqm = geometryAreaSqM(geometry);
  const sqft = sqm / SQM_PER_SQFT;

  return {
    squareMeters: Math.round(sqm * 10) / 10,
    squareFeet: Math.round(sqft / 10) * 10,
    squareFeetRaw: sqft,
    acres: Math.round((sqm / SQM_PER_ACRE) * 1000) / 1000,
    // Turf application units -- Jake's audience thinks in these.
    thousandSqFt: Math.round((sqft / 1000) * 100) / 100,
  };
}

export { measure, geometryAreaSqM, ringAreaSqM, SQM_PER_SQFT };
