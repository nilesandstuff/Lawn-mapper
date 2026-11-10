/**
 * THE PLACEMENT MAP'S LIDAR CORNERS ON A REAL MAP, COUNTED (core session, 2026-11-10; scan/lib/lidar-marks.js,
 * docs/SCAN-PLAN.md section 21). The owner, on the first look at their lot: the deck right, the drive missed although it
 * stands out strongly from the grass, and shapes all over the woods where there is nothing square. This runs the page's
 * own code on the map a walk was made on, over the box the page uses (the lawn and the lot, 20 m round), and says what
 * was found and why each candidate was kept or not.
 *
 *   node scan/tools/marks-check.mjs <walk>
 *
 * Prints counts, sizes and reasons only: no place (the repository and its logs are public).
 */
import { readMap, readModel } from './twin-io.mjs';
import { readObject, BUCKET } from './twin-r2.mjs';
import { gridsFromModel } from '../lib/lidar-load.js';
import { lidarMarks, returnsFrom } from '../lib/lidar-marks.js';
import { ringsOf, toMerc } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';

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
  // the ground's brightness, as numbers only
  const gb = [];
  for (let i = 0; i < P.n; i++) { const h = P.hag(i), e = P.e(i), n = P.nn(i); if (Math.abs(h) < 0.3 && e >= box[0] && e < box[2] && n > box[1] && n <= box[3]) gb.push(P.bright(i)); }
  gb.sort((a, b) => a - b);
  const pc = (f) => gb[Math.min(gb.length - 1, Math.floor(gb.length * f))];
  console.log(`Box ${(box[2] - box[0]).toFixed(0)} x ${(box[3] - box[1]).toFixed(0)} m; ${P.n.toLocaleString()} returns in the model, ${gb.length.toLocaleString()} on the ground in the box.`);
  console.log(`The ground's brightness, percentiles 5/25/50/75/95: ${[0.05, 0.25, 0.5, 0.75, 0.95].map(pc).join(' / ')}`);
  const debug = [], t0 = Date.now();
  const M = lidarMarks(box, P, { debug });
  console.log(`${M.objects.length} things, return spacing ${M.spacing} m, ${Date.now() - t0} ms:`);
  for (const kind of ['building', 'object', 'paving']) {
    const os = M.objects.filter((o) => o.kind === kind);
    const cs = M.corners.filter((c) => c.kind === 'corner' && os.some((o) => o.id === c.of));
    console.log(`  ${kind}: ${os.length} (${os.filter((o) => o.square).length} squared), ${cs.length} corners, ${cs.filter((c) => c.sure).length} sure; sizes ${os.map((o) => `${o.area} m2 at ${o.top} m`).slice(0, 12).join(', ')}`);
  }
  const ns2 = debug.filter((d) => d.kind === 'not solid');
  console.log(`Left out as not solid (the laser went through, or every height): ${ns2.length}; sizes ${ns2.map((d) => `${d.n} returns (through ${d.through}, rough ${d.rough} m)`).slice(0, 15).join('; ')}`);
  const pv = debug.filter((d) => d.kind === 'paving');
  console.log(`Paving candidates, each threshold's slabs over 8 m2: ${pv.length}`);
  for (const d of pv.filter((x) => x.square)) console.log(`  KEPT: ${d.n} returns, ${d.area} m2 (${d.why})`);
  for (const d of pv.sort((a, b) => b.n - a.n).slice(0, 15)) console.log(`  ${d.n} returns, ${d.area} m2: ${d.square ? 'KEPT' : 'not kept'} (${d.why || 'not fitted'})`);
}

main().catch((e) => { console.log(`Marks check: ${e.message}`); process.exit(1); });
