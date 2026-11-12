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
import { roofCorners } from '../lib/roof-corner.js';
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
  // where each thing is, as a distance from the traced lawn's middle only (no place; the biggest building on the
  // owner's map is the neighbour's house)
  const lp = lawn.flat(), lm = lp.length ? [lp.reduce((t, p) => t + p[0], 0) / lp.length, lp.reduce((t, p) => t + p[1], 0) / lp.length] : null;
  const far = (at) => (lm && at ? `${Math.hypot(at[0] - lm[0], at[1] - lm[1]).toFixed(0)} m from the lawn's middle` : '');
  for (const d of debug.filter((x) => x.kind === 'building' || x.kind === 'object').slice(0, 40)) console.log(`  ${d.kind} ${d.area} m2: ${far(d.middle)}, crowns round it ${d.woods}`);
  // the roof corners a walk may take as references (lib/roof-corner.js), with and without the rules
  const RC = roofCorners(M, P, lawn), RA = roofCorners(M, P, [], { maxEaveM: 99 });
  console.log(`Roof corners offered: ${RC.length} (of ${RA.length} outward corners with long sides, before the eave-height and lawn rules): ${RC.map((c) => `${c.label} of the ${M.objects.find((o) => o.id === c.of)?.area} m2 building, eave ${c.eaveM} m, ${c.lawnM} m from the lawn, sides ${c.sidesM.join(' and ')} m, ${c.sure ? 'sure' : `within ${c.within ?? '?'} m`}`).join('; ') || 'none'}`);
  console.log(`  all of them: ${RA.map((c) => `${M.objects.find((o) => o.id === c.of)?.area} m2 ${c.label} eave ${c.eaveM} m${c.sure ? ' sure' : ''}`).join('; ') || 'none'}`);
  const wd = debug.filter((d) => d.kind === 'in the woods');
  console.log(`Left out as in the woods (crowns over the ground round it): ${wd.length}; ${wd.map((d) => `${d.was} ${d.n} returns at ${d.top} m (${d.woods})`).slice(0, 20).join('; ')}`);
  const dk = debug.filter((d) => d.kind === 'deck off a house');
  console.log(`Decks split off a house: ${dk.length}; ${dk.map((d) => `${d.n} returns at ${d.top} m`).join('; ')}`);
  const ns2 = debug.filter((d) => d.kind === 'not solid');
  console.log(`Left out as not solid (the laser went through, or every height): ${ns2.length}; sizes ${ns2.map((d) => `${d.n} returns (through ${d.through}, rough ${d.rough} m)`).slice(0, 15).join('; ')}`);
  // each raised thing as it was classed: a building is 3.5 m or more up at its middle return AND over 30% of its returns the shade map's roof
  const cl = debug.filter((d) => d.kind === 'classed' && d.m2 >= 15).sort((a, b) => b.m2 - a.m2).slice(0, 15);
  console.log(`Raised solid things of 15 m2 or more, as classed: ${cl.map((d) => `${d.as} ~${d.m2} m2, middle return ${d.top} m up, heights span ${d.pitch} m, ${Math.round(d.bld * 100)}% roof by the shade map`).join('; ') || 'none'}`);
  const tr = debug.filter((d) => d.kind === 'called a tree').sort((a, b) => b.m2 - a.m2);
  console.log(`Groups the shade map calls trees, 20 m2 or more: ${tr.length}; SOLID ones (a roof taken for a crown?): ${tr.filter((d) => d.solid).map((d) => `~${d.m2} m2 at ${d.top} m (through ${d.through}, rough ${d.rough})`).join('; ') || 'none'}`);
  console.log(`  the biggest of the rest: ${tr.filter((d) => !d.solid).slice(0, 6).map((d) => `~${d.m2} m2 at ${d.top} m (through ${d.through}, rough ${d.rough})`).join('; ') || 'none'}`);
  /* WHICH STEP OF THE SHADE MAP'S RULE LOST A SOLID "TREE" (asked by the features session, 2026-11-12, whose rule it is):
     over the patch's own columns, structures.js's reason for each (the model's `why`), their kinds, and what the
     returns themselves say. Counts only; where the patch is stays out of the log. */
  for (const d of tr.filter((x) => x.solid)) {
    const A = model.arrays, cols = new Set(), by = (o, k) => { o[k] = (o[k] || 0) + 1; return o; };
    let n = 0, firstOfMany = 0, last = 0, lastGround = 0, single = 0; const cls = {};
    for (let i = 0; i < P.n; i++) {
      if (!d.cells.has(`${Math.floor(P.e(i))},${Math.floor(P.nn(i))}`)) continue;
      const j = P.col(i); if (j >= 0) cols.add(j);
      n++;
      const ret = A.ptRet ? A.ptRet[i] >> 4 : 0, of = A.ptRet ? A.ptRet[i] & 15 : 0, c = A.ptCls ? A.ptCls[i] : -1;
      by(cls, c);
      if (ret === 1 && of > 1) firstOfMany++;
      if (of === 1) single++;
      if (ret === of) { last++; if (c === 2) lastGround++; }
    }
    const why = {}, kinds = {};
    for (const j of cols) { by(why, A.why ? A.why[j] : 'none'); by(kinds, A.kind ? A.kind[j] : 'none'); }
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
    console.log(`  the solid ~${d.m2} m2 patch: ${cols.size} columns; why codes ${JSON.stringify(why)}; kinds ${JSON.stringify(kinds)} (rule ${JSON.stringify(model.meta?.rule?.kinds || null)})`);
    console.log(`    its ${n} returns (all heights, in its 1 m cells): first of several ${pct(firstOfMany, n)}, single ${pct(single, n)}, last returns ${last} of which class 2 (ground) ${pct(lastGround, last)}; classes ${JSON.stringify(cls)}`);
  }
  const pv = debug.filter((d) => d.kind === 'paving');
  console.log(`Paving candidates, each threshold's slabs over 8 m2: ${pv.length}`);
  for (const d of pv.filter((x) => x.square)) console.log(`  KEPT: ${d.n} returns, ${d.area} m2, contrast ${d.contrast}, ${far(d.middle)} (${d.why})`);
  for (const d of pv.sort((a, b) => b.n - a.n).slice(0, 15)) console.log(`  ${d.n} returns, ${d.area} m2, ${far(d.middle)}: ${d.square ? 'KEPT' : 'not kept'} (${d.why || 'not fitted'})`);
  console.log(`Paving drawn: ${M.objects.filter((o) => o.kind === 'paving').map((o) => `${o.area} m2 ${o.traced ? 'traced' : 'straight-edged'}, ${far(o.middle)}`).join('; ') || 'none'}`);
  const why = {}; for (const d of pv) { const k = d.square ? 'kept' : (d.why || '').startsWith('held') ? 'not straight-edged' : d.why; why[k] = (why[k] || 0) + 1; }
  console.log(`Paving reasons: ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

main().catch((e) => { console.log(`Marks check: ${e.message}`); process.exit(1); });
