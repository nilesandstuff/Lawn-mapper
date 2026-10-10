/**
 * THE SHADE MAP'S INDEX OF LIDAR PROJECTS (features session, 2026-10-10).
 *
 * Which public 3DEP point clouds might cover a point. Hobu publish one
 * footprint per project (the file tools/lidar-cover.js reads), but it is
 * 8.7 MB: too much for a phone to fetch for every property, and too much for
 * the Worker to parse inside a free-plan request. Simplifying the outlines
 * does not help -- they hold only 179k vertices; the size is the precision
 * and the pretty-printing -- so this keeps ONE BOX per project:
 *
 *   { name, count, km2, bbox }      ~300 KB, ~60 KB gzipped, for all 2,280 projects
 *
 * A BOX IS A SHORTLIST, NOT AN ANSWER. The page (public/shade/find.js) then
 * asks USGS's own 3DEP index (the WESM service tools/lidar-season.js already
 * uses) which collections were flown over the exact point, with their dates,
 * and keeps the boxes whose name matches one of those; and it only trusts a
 * cloud once its octree has points over the lot (public/shade/ept.js).
 *
 *   node tools/shade-lidar-index.js            (writes public/shade/lidar-index.json)
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { geometryAreaSqM } from '../public/lib/area.js';
import { EPT_BASE } from '../public/shade/names.js';

export const FOOTPRINTS = process.env.LIDAR_FOOTPRINTS
  || 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson';


/** One footprint feature -> the index's entry. Pure. */
export function indexEntry(f) {
  const p = f.properties || {};
  const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates]
    : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly[0] || []) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  }
  if (!p.url || !(w < e && s < n)) return null;
  const areaSqM = geometryAreaSqM({ type: 'MultiPolygon', coordinates: polys });
  return {
    name: p.name,
    ...(p.url === `${EPT_BASE}${p.name}/ept.json` ? {} : { url: p.url }),
    count: p.count || null,
    km2: Math.round(areaSqM / 1e4) / 100,
    bbox: [w, s, e, n].map((v) => Math.round(v * 1e4) / 1e4),
  };
}

async function main() {
  console.log(`Fetching ${FOOTPRINTS}`);
  const res = await fetch(FOOTPRINTS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fc = await res.json();
  const projects = (fc.features || []).map(indexEntry).filter(Boolean);
  const out = { made: new Date().toISOString().slice(0, 10), source: FOOTPRINTS, projects };
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../public/shade/lidar-index.json');
  const text = JSON.stringify(out);
  writeFileSync(path, text);
  console.log(`${projects.length} projects, ${(text.length / 1e6).toFixed(2)} MB -> ${path}`);
}

if (process.argv[1] && process.argv[1].endsWith('shade-lidar-index.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
