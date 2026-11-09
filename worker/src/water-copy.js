/**
 * OUR OWN COPY OF THE WATER MAP'S COUNTY LAYERS (core session, 2026-11-09). The owner's county put its whole drain
 * network behind a login in a republish, and the water map lost fourteen layers at once; the owner, on keeping a copy
 * of every county water layer the way the parcels are kept: "If it's similar, that's fine".
 *
 * tools/parcel-mirror.mjs (workflow "P2. Parcel mirror") copies every layer of the water catalogue (D1 water_layers)
 * in the parcel copy's format (parcel-mirror.js), under water/<id>/<cx>_<cy>.bin, id = the first 16 hex of SHA-1 of the
 * layer's URL. Each record's number slot holds { g: 'a' | 'l' | 'p', a: attributes }: an area's rings, a line's paths
 * or points. water-layers.js waterLayersAt asks the county first, always; a county layer that does not answer is read
 * from here, saying so (copiedAt), and is listed as answered.
 */
import { CELL, cellsOfBox, parcelsInBox, gunzip, cellAt } from './parcel-mirror.js';

export const WATER_PREFIX = 'water/';
const MAX_CELLS = 16;

/** A water layer's id in the copy: the first 16 hex of SHA-1 of its URL. */
export async function waterIdOf(url) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(url))));
  return Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One copied feature as GeoJSON: { geometry, properties } or null. */
export function featureOf(rec, toGeoJSON) {
  let meta;
  try { meta = JSON.parse(rec.pin || '{}'); } catch { return null; }
  const parts = rec.rings || [];
  let geometry = null;
  if (meta.g === 'a') geometry = toGeoJSON({ rings: parts });
  else if (meta.g === 'l') geometry = parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts };
  else if (meta.g === 'p') {
    const pts = parts.map((r) => r[0]).filter(Boolean);
    geometry = pts.length === 1 ? { type: 'Point', coordinates: pts[0] } : { type: 'MultiPoint', coordinates: pts };
  }
  return geometry ? { geometry, properties: meta.a || {} } : null;
}

/**
 * The copy of one county layer over a box, in waterLayersAt's shape ([{ kind, label, source, title, url, features,
 * copiedAt, ... }]), or null when there is no copy there. `tidy` turns raw attributes into what the route shows
 * (water-layers.js tidyAttributes(decodeAttributes(a, codebook))), `clip` cuts a geometry to the box, `label` names
 * the kind.
 */
export async function copiedLayer(env, layer, box, { toGeoJSON, clip, tidy, label }) {
  if (!env?.CORPUS || !layer?.url) return null;
  const cells = cellsOfBox(box);
  if (!cells.length || cells.length > MAX_CELLS) return null;
  const id = await waterIdOf(layer.url);
  const features = [], seen = new Set();
  let at = null, any = false;
  for (const [cx, cy] of cells) {
    const obj = await env.CORPUS.get(`${WATER_PREFIX}${id}/${cx}_${cy}.bin`).catch(() => null);
    if (!obj) continue;
    let bytes;
    try { bytes = await gunzip(new Uint8Array(await obj.arrayBuffer())); } catch { continue; }
    any = true;
    const when = cellAt(bytes);
    if (when && (!at || when < at)) at = when;
    for (const rec of parcelsInBox(bytes, box)) {
      // a feature across two cells is in both: once
      const k = `${rec.pin}|${rec.rings?.[0]?.[0]?.join(',')}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const f = featureOf(rec, toGeoJSON);
      const geometry = f && clip(f.geometry);
      if (geometry) features.push({ type: 'Feature', geometry, properties: tidy(f.properties) });
    }
  }
  if (!any) return null;
  return [{
    kind: layer.kind, label: label(layer.kind), source: layer.source, title: layer.title, url: layer.url,
    truncated: false, type: 'FeatureCollection', features, copiedAt: at,
  }];
}

