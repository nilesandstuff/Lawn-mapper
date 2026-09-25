/**
 * Which 3DEP point cloud covers each dumped frame.
 *
 * The first step of stage 4 (docs/DETECTOR-FINDINGS.md, THE PLAN). Workflow
 * 17 asked "is there lidar under our lawns" from the corpus; this asks it of
 * the FRAMES a run has just written, so the answer lines up with exactly the
 * photographs, labels and canopy masks beside them, and hands the lidar reader
 * (tools/lidar_frame.py) one URL per frame.
 *
 * No database: the frame's own box in scale.json says where it is. One 8.7 MB
 * download of footprints, a point-in-polygon per frame, one JSON file out.
 *
 *   FRAMES=frames OUT=lidar-plan.json node tools/lidar-plan.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FOOTPRINTS, fetchFootprints, covers, densityPerSqM, flownYear, pickBest,
} from './lidar-cover.js';

const FRAMES = process.env.FRAMES || 'frames';
const OUT = process.env.OUT || 'lidar-plan.json';

const R = 6378137;
/** Web Mercator metres back to degrees, for the footprints, which are in degrees. */
export const fromMercator = ([x, y]) => [
  (x / R) * (180 / Math.PI),
  (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI),
];

/** The plan for one set of boxes against one set of footprints. Pure. */
export function planFrames(features, boxes) {
  const plan = {};
  for (const [id, box] of Object.entries(boxes || {})) {
    const [lng, lat] = fromMercator([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
    const matches = [];
    for (const f of features || []) {
      if (!covers(f.geometry, lng, lat)) continue;
      matches.push({
        name: f.properties?.name || '(unnamed)',
        url: f.properties?.url || null,
        density: densityPerSqM(f),
      });
    }
    const best = pickBest(matches);
    plan[id] = best
      ? { name: best.name, url: best.url, year: flownYear(best.name), density: best.density, others: matches.length - 1 }
      : null;
  }
  return plan;
}

async function main() {
  const scale = JSON.parse(readFileSync(join(FRAMES, 'scale.json'), 'utf8'));
  const boxes = scale.boxes || {};
  const ids = Object.keys(boxes);
  if (!ids.length) {
    console.log(`scale.json in ${FRAMES} carries no frame boxes. The dump step writes them`);
    console.log('since 2026-09-25; an older dump cannot be matched against the lidar.');
    process.exit(1);
  }

  console.log('Fetching the 3DEP project footprints…');
  const fc = await fetchFootprints(FOOTPRINTS);
  const plan = planFrames(fc?.features || [], boxes);
  writeFileSync(OUT, JSON.stringify(plan, null, 1));

  let covered = 0;
  for (const id of ids) {
    const p = plan[id];
    if (p) covered++;
    console.log(`  ${id.slice(0, 28).padEnd(30)} ${p
      ? `${String(p.year ?? '—').padStart(4)}  ${(p.density === null ? '  ?' : p.density.toFixed(1)).padStart(5)} pts/m²  ${p.name}`
      : 'NO LIDAR'}`);
  }
  console.log(`\n${covered} of ${ids.length} frames have a 3DEP point cloud over them; plan in ${OUT}.`);
}

if (process.argv[1] && process.argv[1].endsWith('lidar-plan.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
