/*
 * THE ROAD AND SIDEWALK CENTRELINES ON THE EDITOR'S MAP, for tracing by eye.
 *
 * What is left of Overture's layer after the owner looked at the shapes on the
 * predictions page (2026-10-20): "the overture building outlines are bad. Some
 * shapes are just plain wrong when aligned correctly. Let's completely scrap
 * the overture shapes for the lawn map." The roads and sidewalks are "a mixed
 * bag... the lines aren't always perfectly centered on roads/sidewalks, so the
 * full width of the lines sometimes overlaps with lawn", but "the center lines
 * of the shapes do seem to always fall on actual roads/sidewalks, just not
 * always on the center." So: thin lines only, no buildings, no band at a
 * typical width. (H101-H105 are the measurements behind this.)
 *
 * Pure: what public/lib/overture.js returns, made into one GeoJSON collection
 * of the lines. The map work is in app.js.
 */

/** OpenStreetMap's road and sidewalk centrelines ({ roads } from overtureFor) as one FeatureCollection. Buildings are ignored. */
export function overtureGeoJSON(ov) {
  const features = [];
  for (const r of ov?.roads || []) {
    for (const line of r.lines || []) {
      if (line.length < 2) continue;
      features.push({ type: 'Feature', properties: { kind: r.walk ? 'walk' : 'road', cls: r.sub || r.cls }, geometry: { type: 'LineString', coordinates: line } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Is the box [w, s, e, n] (degrees) wholly inside `got`? Then the features fetched for `got` cover it. */
export const covers = (got, box) => !!got && box[0] >= got[0] && box[1] >= got[1] && box[2] <= got[2] && box[3] <= got[3];
