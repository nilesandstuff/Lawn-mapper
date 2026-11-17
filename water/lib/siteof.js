/**
 * A SAVED MAP AS THE WATER MAP'S ANALYSIS TAKES IT (shared since 2026-11-16 by the page, public/app.js, and the water
 * builder, builder/headless.mjs: the builder works a map out exactly as opening it would). Pure.
 *   siteOf(record, id) -> the site the analysis worker (public/analyse.js) is given
 *   inputsOf(waterPart) -> the visitor's own settings kept in the map's water part
 */
import { tracedOn } from './shade/traced.js';
import { SPECIES, groupOf } from './roots.js';

export const asFeature = (p) => (p?.type === 'Feature' ? p : p?.type ? { type: 'Feature', properties: {}, geometry: p } : null);

/** The map record (GET /api/maps/one's `map`) as the analysis's site. */
export function siteOf(s, id) {
  return {
    label: s.address || 'your map', lng: s.lng, lat: s.lat,
    parcel: asFeature(s.parcel),
    lawn: (s.shapes || []).map(asFeature).filter(Boolean),
    /* THE WHOLE PROPERTY MARKED AS LAWN (the core's admin save, 2026-11-17: trace.status 'whole', no trace drawn): the
       lawn is the property line, so the roofs and the paving the survey finds inside it win over it (lib/plan.js) */
    wholeLot: s.trace?.status === 'whole' || s.model === 'whole-property',
    // the shade map's cloud, box and shift, when it has worked on this map: the same cells as its part
    lidar: s.tools?.shade?.data?.lidar || null,
    // the trees and branches erased on the shade map: gone from the water map's shade too
    shadeEdits: s.tools?.shade?.data?.grid ? { grid: s.tools.shade.data.grid, erased: s.tools.shade.data.erased || [], cubes: s.tools.shade.data.cubes || [], fences: Array.isArray(s.tools.shade.data.fences) ? s.tools.shade.data.fences : null } : null,
    mapId: id, at: s.at || null,
    // the photo the lawn was traced on (owner 2026-10-19: a county photo if one was saved, Mapbox if Mapbox)
    tracedOn: tracedOn(s),
    water: s.tools?.water?.data || null,
  };
}

/** The settings kept in the water part, as the page reads them back (public/app.js run). */
export function inputsOf(kept = {}) {
  const k = kept || {};
  const species = Array.isArray(k.species) ? k.species.filter((id) => SPECIES[id]) : [];
  return {
    downspouts: Array.isArray(k.downspouts) ? k.downspouts : [],
    gutters: Array.isArray(k.gutters) ? k.gutters : [],
    areas: Array.isArray(k.areas) ? k.areas : [],
    topsoil: !!k.topsoil,
    species,
    grass: species.length ? groupOf(species) : k.grass === 'warm' ? 'warm' : 'cool',
    texture: '', // the soil is the survey's (owner 2026-10-19: no override)
    layers: k.layers && typeof k.layers === 'object' ? k.layers : null,
    wind: k.wind && typeof k.wind === 'object' ? k.wind : null,
    mode: ['normal', 'deficit', 'dormancy'].includes(k.mode) ? k.mode : 'normal',
  };
}
