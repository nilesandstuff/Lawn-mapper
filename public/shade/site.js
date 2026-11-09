/**
 * A SAVED MAP AS THE SHADE MAP READS IT, with no page (moved out of
 * public/shade.js on 2026-11-09 so rebuild.js reads a map exactly as the
 * page does): the site from GET /api/maps/one's record, the lot's bounds,
 * and whether the erasures kept with the map belong to a model's grid.
 */
import { tracedOn } from './traced.js';
import { lotFeature, lotProblem } from './trace.js';

export const asFeature = (p) => (p?.type === 'Feature' ? p : p?.type ? { type: 'Feature', properties: {}, geometry: p } : null);

/** The site from a saved map (the unified record, docs/MAPS.md). */
export function siteFromSave(s) {
  const part = s.tools?.shade?.data || null;
  const site = {
    label: s.address || 'Saved map', lng: s.lng, lat: s.lat,
    parcel: asFeature(s.parcel),
    lawn: (s.shapes || []).map(asFeature).filter(Boolean),
    tracedOn: tracedOn(s),
    county: s.county || null,
    map: { id: s.id, at: s.at || null, shade: part },
  };
  /* The line traced here last time, when the county had none. */
  if (!site.parcel && part?.lot && !lotProblem(part.lot)) site.parcel = lotFeature(part.lot);
  return site;
}

/** [w, s, e, n] in degrees of everything we know about the site. */
export function siteBounds(site) {
  const pts = [];
  const add = (g) => {
    if (!g) return;
    const walk = (c) => (typeof c[0] === 'number' ? pts.push(c) : c.forEach(walk));
    walk(g.coordinates);
  };
  add(site.parcel?.geometry);
  site.lawn.forEach((f) => add(f.geometry));
  /* A field-readings check covers the whole track (shade/log.js: area). */
  if (site.area) { pts.push([site.area[0], site.area[1]], [site.area[2], site.area[3]]); }
  if (!pts.length) {
    const d = 15 / 111320;
    return [site.lng - d / Math.cos(site.lat * Math.PI / 180), site.lat - d, site.lng + d / Math.cos(site.lat * Math.PI / 180), site.lat + d];
  }
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

/** Do the erasures kept with a map (its shade part) belong to this grid (`grid` gridOver, `nz` the canopy's layers)? */
export function partFits(part, grid, nz = null) {
  if (!part?.grid || !grid) return false;
  const nzOk = !part.grid.nz || !nz || part.grid.nz === nz;
  return nzOk && grid.w === part.grid.w && grid.h === part.grid.h && Math.abs(grid.x0 - part.grid.x0) < 0.5 && Math.abs(grid.y1 - part.grid.y1) < 0.5;
}
