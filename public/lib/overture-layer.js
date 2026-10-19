/*
 * OVERTURE'S BUILDINGS, ROADS AND SIDEWALKS ON THE EDITOR'S MAP, for tracing by eye (owner,
 * 2026-10-19: "it would be good info for every stage... the detector, the grass under canopy
 * guesser, and manual tracing").
 *
 * Measured (workflow 37): Overture sits within about a metre of the lidar (H101). Against our
 * photos it is often further off, but by eye mostly because its own shapes are wrong (a missing
 * wing) or the photo's roof leans, not because the photo is shifted (H102's correction); so it
 * is drawn where Overture puts it.
 *
 * Pure: what public/lib/overture.js returns, made into one GeoJSON collection and the line widths
 * that draw each road at its width on the ground. The map work is in app.js.
 */

/** Overture's roads and buildings ({ roads, buildings } from overtureFor) as one FeatureCollection. */
export function overtureGeoJSON(ov) {
  const features = [];
  for (const r of ov?.roads || []) {
    for (const line of r.lines || []) {
      if (line.length < 2) continue;
      features.push({ type: 'Feature', properties: { kind: r.walk ? 'walk' : 'road', w: r.width, cls: r.sub || r.cls }, geometry: { type: 'LineString', coordinates: line } });
    }
  }
  for (const poly of ov?.buildings || []) {
    if (!poly?.[0] || poly[0].length < 4) continue;
    features.push({ type: 'Feature', properties: { kind: 'building' }, geometry: { type: 'Polygon', coordinates: poly } });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * A line-width expression that draws a band `w` ground metres wide at latitude `lat`, at any zoom.
 * Mapbox GL's tiles are 512 px, so a pixel at zoom z is 40075016.686 cos(lat) / (512 2^z) metres.
 */
export function bandWidth(lat) {
  const px = (z) => (512 * 2 ** z) / (40075016.686 * Math.cos((lat * Math.PI) / 180));
  return ['interpolate', ['exponential', 2], ['zoom'], 14, ['*', ['get', 'w'], px(14)], 24, ['*', ['get', 'w'], px(24)]];
}

/** Every coordinate moved `east` and `north` ground metres (onto the photo, H102). */
export function shiftGeoJSON(fc, east, north) {
  const R = 6378137;
  const mv = ([lng, lat]) => [lng + (east / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI), lat + (north / R) * (180 / Math.PI)];
  const geom = (g) => (g.type === 'LineString' ? { ...g, coordinates: g.coordinates.map(mv) } : { ...g, coordinates: g.coordinates.map((ring) => ring.map(mv)) });
  return { ...fc, features: fc.features.map((f) => ({ ...f, geometry: geom(f.geometry) })) };
}

/** Is the box [w, s, e, n] (degrees) wholly inside `got`? Then the features fetched for `got` cover it. */
export const covers = (got, box) => !!got && box[0] >= got[0] && box[1] >= got[1] && box[2] <= got[2] && box[3] <= got[3];
