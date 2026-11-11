/**
 * THE OWNER'S TEST OF THE HARD-EDGED GROUND PICTURE (core session, 2026-11-11; scan/lib/ground-picture.js, SCAN-PLAN
 * section 23): "I want to measure the width of my driveway to see if this worked... My drive has a long straight
 * section with a uniform width. I measured it with a tape measure so I know the exact width... Tell me the measurement
 * and I'll [tell] you the true measurement."
 *
 * The page's own picture on the walk's map; within the lot's boundary, the dark strip's longest straight run of one
 * width, and its width across every half metre (stripWidth). Edges under a tree's crown are left out (the ground
 * there reads dark whatever it is).
 *
 *   node scan/tools/drive-width.mjs <walk>
 *
 * Prints widths, lengths and counts only: no place (the repository and its logs are public).
 */
import { readMap, readModel } from './twin-io.mjs';
import { readObject, BUCKET } from './twin-r2.mjs';
import { gridsFromModel } from '../lib/lidar-load.js';
import { returnsFrom } from '../lib/lidar-marks.js';
import { groundPicture, stripWidth } from '../lib/ground-picture.js';
import { ringsOf, toMerc } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';

const ftIn = (m) => { const inch = m * 39.3701, ft = Math.floor(inch / 12); return `${ft} ft ${(inch - ft * 12).toFixed(1)} in`; };

async function main() {
  const walk = process.argv[2];
  if (!walk) throw new Error('which walk? (its map is the one looked at)');
  const meta = JSON.parse(Buffer.from(await readObject(BUCKET, `twins/${walk}/meta.json`)).toString('utf8'));
  const m = await readMap(meta.map);
  const model = await readModel(meta.map, m.ownerId);
  const origin = [m.lng, m.lat];
  const lawn = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(origin, p)));
  const parcel = ringsOf(m.parcel ? [m.parcel] : []).map((r) => r.map((p) => toLocal(origin, p)));
  const pts = [...lawn.flat(), ...parcel.flat()], es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
  const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
  const S = await import('../../public/shade/structures.js');
  const G = gridsFromModel(model, { origin, box, lawn: [], S, toMerc });
  const P = returnsFrom({ ...G, model });
  if (!P) throw new Error('the model keeps no returns');
  const t0 = Date.now(), pic = groundPicture(box, P);
  let nodata = 0, dark = 0; for (let k = 0; k < pic.W * pic.H; k++) { if (Number.isNaN(pic.dark[k])) nodata++; else if (pic.dark[k] >= 0.5) dark++; }
  console.log(`The ground picture: ${pic.W} x ${pic.H} cells of ${pic.cell.toFixed(3)} m (a return every ${pic.spacing} m), ${Date.now() - t0} ms.`);
  console.log(`  Levels of brightness: light ${pic.levels.light}, dark ${pic.levels.dark}, the cut ${pic.levels.cut}, a surface's own noise ${pic.levels.noise}.`);
  console.log(`  ${(100 * dark / (pic.W * pic.H)).toFixed(0)}% dark, ${(100 * nodata / (pic.W * pic.H)).toFixed(0)}% no ground seen.`);
  // crowns: the 1 m squares a tree's crown (2 m or more up) covers
  const crowns = new Set();
  for (let i = 0; i < P.n; i++) if (P.kind(i) === 2 && P.hag(i) >= 2) crowns.add(`${Math.floor(P.e(i))},${Math.floor(P.nn(i))}`);
  const skip = (e, n) => crowns.has(`${Math.floor(e)},${Math.floor(n)}`);
  const rings = parcel.length ? parcel : lawn;
  if (!rings.length) throw new Error('the map has no lot boundary to look within');
  for (const [label, sk] of [['edges under crowns left out', skip], ['every edge', null]]) {
    let best = null;
    for (const ring of rings) { const w = stripWidth(pic, ring, { skip: sk }); if (w && (!best || w.lengthM > best.lengthM)) best = w; }
    if (!best) { console.log(`  The drive's straight run (${label}): none found.`); continue; }
    console.log(`  The drive's straight run (${label}): ${best.lengthM.toFixed(1)} m long, ${best.sections} cross-sections read, ${best.rejected} left out.`);
    console.log(`    WIDTH: median ${best.widthM.toFixed(2)} m = ${ftIn(best.widthM)} (mean ${best.meanM.toFixed(2)} m; the middle half of the cross-sections ${best.q25.toFixed(2)}-${best.q75.toFixed(2)} m = ${ftIn(best.q25)} to ${ftIn(best.q75)})`);
  }
}

main().catch((e) => { console.log(`Drive width: ${e.message}`); process.exit(1); });
