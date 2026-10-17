/**
 * IS THIS CELL LAWN? FITTED AND SCORED ON THE CORPUS'S OWN TRACES
 * (water session, 2026-10-17; FINDINGS H11).
 *
 * The locked corpus maps carry a property line and a traced lawn. Inside the
 * property line, off the roofs, every 1 m cell is LAWN (inside a traced lawn)
 * or NOT (drive, walk, patio, beds, trees, a missed roof). lib/cells.js
 * measures each from the points alone. The maps are split by their place in
 * the list -- odd to FIT, even to TEST -- and everything reported is on the
 * test half:
 *
 *   1. how well each measure alone tells lawn from not (AUC; the laser's
 *      brightness first, since that was the question), and all together
 *   2. what it does for the low-spot map with no traced lawn: of the spots
 *      called hollow on the property, the share that are really on the lawn
 *      -- with the kinds as they are, and with "and the cells look like
 *      lawn" added, at a cut chosen on the fitting half
 *
 * Prints the fitted weights as JSON, to be copied into lib/cells.js
 * LAWN_MODEL. Numbers only; maps are #1-#104, never named or placed.
 *
 *   CLOUDFLARE_API_TOKEN=.. CLOUDFLARE_ACCOUNT_ID=.. [LIMIT=n] node water/tools/surfaces.mjs
 */

import { query } from '../../tools/corpus-db.js';
import { lawnSetClause, lawnSetDescription } from '../../tools/lawn-set.js';
import { lidarAt } from '../../worker/src/shade.js';
import { nodeIo } from '../lib/node-io.js';
import { runSite } from '../lib/site.js';
import { FEATURES, cellFeatures, fitLogistic, auc } from '../lib/cells.js';
import { rng } from '../lib/synthetic.js';

const LIMIT = Number(process.env.LIMIT || 0);
const PER_LOT = Number(process.env.PER_LOT || 1500);
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const asFeature = (p) => (p?.type === 'Feature' ? p : p?.type ? { type: 'Feature', properties: {}, geometry: p } : null);

async function main() {
  const env = { ...process.env, LAWN_SET: process.env.LAWN_SET || 'locked' };
  console.log(`Maps: ${lawnSetDescription(env)}`);
  const rows = query(`SELECT id, lng, lat, parcel, shapes FROM corpus WHERE status = 'approved' AND lng IS NOT NULL${lawnSetClause(env)} ORDER BY id`);
  let maps = rows.map((r) => ({ lng: Number(r.lng), lat: Number(r.lat), parcel: asFeature(parse(r.parcel)), lawn: (parse(r.shapes) || []).map(asFeature).filter(Boolean) }))
    .filter((m) => Number.isFinite(m.lng) && m.parcel && m.lawn.length);
  if (LIMIT) maps = maps.slice(0, LIMIT);
  console.log(`${maps.length} maps with a property line and a traced lawn.\n`);

  const io = nodeIo();
  const cells = { fit: [], test: [] };
  const spots = { fit: [], test: [] };
  const r = rng(17);
  for (let k = 0; k < maps.length; k++) {
    const half = k % 2 ? 'test' : 'fit';
    try {
      const out = await runSite(maps[k], io, (lng, lat) => lidarAt(lng, lat), { nullRuns: 4 });
      if (out.error) { console.log(`#${k + 1}: ${out.error}`); continue; }
      const res = out.result, N = res.wall.length;
      const f = cellFeatures(res);
      const lot = [];
      for (let i = 0; i < N; i++) if (out.parcelMask[i] && !res.wall[i]) lot.push(i);
      const take = lot.length <= PER_LOT ? lot : lot.filter(() => r() < PER_LOT / lot.length);
      for (const i of take) cells[half].push([FEATURES.map((n) => f[n][i]), out.lawnMask[i] ? 1 : 0, k]);
      // the spots called hollow on the property: really on the lawn? (half or more of their wet cells)
      for (const s of res.spots.spots) {
        if (!s.reported || s.kind !== 'hollow' || !out.parcelMask[s.deepest]) continue;
        const wet = s.cells.filter((i) => res.spots.depth[i] >= 0.01);
        if (!wet.length) continue;
        const onLawn = wet.filter((i) => out.lawnMask[i]).length / wet.length;
        spots[half].push({ lot: k, onLawn: onLawn >= 0.5, x: wet.map((i) => FEATURES.map((n) => f[n][i])) });
      }
      console.log(`#${k + 1} (${half}): ${take.length} cells, ${lot.length ? Math.round(100 * take.filter((i) => out.lawnMask[i]).length / take.length) : 0}% lawn; ${spots[half].filter((s) => s.lot === k).length} hollow(s) on the lot`);
    } catch (e) {
      console.log(`#${k + 1}: failed -- ${String(e.message).replace(/-?\d+\.\d{3,}/g, '…')}`);
    }
  }

  const model = fitLogistic(cells.fit.map(([x, y]) => [x, y]));
  const score = (x) => { let z = model.b; x.forEach((v, j) => { z += model.w[j] * ((v - model.mean[j]) / model.sd[j]); }); return 1 / (1 + Math.exp(-z)); };
  const test = cells.test;
  const pos = (j) => test.filter((c) => c[1]).map((c) => c[0][j]), neg = (j) => test.filter((c) => !c[1]).map((c) => c[0][j]);

  console.log('\n==============================================================');
  console.log(`IS THIS CELL LAWN? (${lawnSetDescription(env)})`);
  console.log(`  cells: ${cells.fit.length} to fit (${new Set(cells.fit.map((c) => c[2])).size} maps), ${test.length} to test (${new Set(test.map((c) => c[2])).size} maps); ${Math.round(100 * test.filter((c) => c[1]).length / Math.max(1, test.length))}% of test cells are lawn`);
  console.log('  each measure alone, on the test half (AUC; 0.5 = no better than a coin, 1 = perfect; below 0.5 means "the other way round"):');
  FEATURES.forEach((n, j) => console.log(`    ${n.padEnd(7)} ${auc(pos(j), neg(j)).toFixed(3)}`));
  const withI = test.filter((c) => !c[0][FEATURES.indexOf('noI')]);
  const bj = FEATURES.indexOf('bright');
  console.log(`    bright, only cells with a ground return to be bright with (${withI.length}): ${auc(withI.filter((c) => c[1]).map((c) => c[0][bj]), withI.filter((c) => !c[1]).map((c) => c[0][bj])).toFixed(3)}`);
  console.log(`  all together (logistic, fitted on the fit half): ${auc(test.filter((c) => c[1]).map((c) => score(c[0])), test.filter((c) => !c[1]).map((c) => score(c[0]))).toFixed(3)}`);

  // the low-spot map with no traced lawn
  const mean = (s) => s.x.reduce((t, x) => t + score(x), 0) / s.x.length;
  const pick = (list, cut) => list.filter((s) => mean(s) >= cut);
  const prec = (list) => (list.length ? list.filter((s) => s.onLawn).length / list.length : NaN);
  let best = { cut: 0, p: prec(spots.fit) };
  const fitTrue = spots.fit.filter((s) => s.onLawn).length;
  for (let cut = 0.05; cut < 0.96; cut += 0.05) {
    const kept = pick(spots.fit, cut);
    if (kept.filter((s) => s.onLawn).length < 0.7 * fitTrue) break; // keep at least 70% of the real ones
    if (prec(kept) > best.p) best = { cut: +cut.toFixed(2), p: prec(kept) };
  }
  const tt = spots.test, kept = pick(tt, best.cut), trueAll = tt.filter((s) => s.onLawn).length;
  console.log('  the low-spot map with NO traced lawn, test half:');
  console.log(`    spots called hollow on the property: ${tt.length}; on the lawn ${trueAll} (${Math.round(100 * prec(tt))}%)`);
  console.log(`    adding "its cells look like lawn" (mean P >= ${best.cut}, cut chosen on the fit half): ${kept.length} kept, ${kept.filter((s) => s.onLawn).length} on the lawn (${Math.round(100 * prec(kept))}%); keeps ${trueAll ? Math.round(100 * kept.filter((s) => s.onLawn).length / trueAll) : 0}% of the real ones`);
  console.log(`  the traced lawns are the truth here: a lawn traced loosely, or a bed traced as lawn, counts against the measures`);
  console.log(`\nLAWN_MODEL = ${JSON.stringify({ features: FEATURES, mean: model.mean.map((v) => +v.toFixed(4)), sd: model.sd.map((v) => +v.toFixed(4)), w: model.w.map((v) => +v.toFixed(4)), b: +model.b.toFixed(4), hollowCut: best.cut })}`);
}

main().catch((e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });
