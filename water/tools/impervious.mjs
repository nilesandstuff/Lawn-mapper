/**
 * ROOFS, AND HOW IMPERVIOUS THE REST IS, SCORED ON THE CHESAPEAKE BAY
 * PROGRAM'S 1 m LAND USE (water session, 2026-10-17; FINDINGS H12).
 *
 * Owner, 2026-10-17: "grass will always be marked by the time a map reaches
 * the water map. So we need to determine how impervious to water the
 * non-lawn areas are. Brightness of returns should be a pretty good proxy
 * for that, it just probably needs some calibration on a per map basis, and
 * you can use marked lawn and roofs for that."
 *
 * Squares of SIZE m drawn at random (seeded) inside a few suburban counties
 * of the Bay watershed, kept when the land use calls them residential (turf
 * and structures both present). For each: the lidar (the shade map's pick),
 * the water map's analysis, and the land use on the same 1 m grid
 * (lib/chesapeake.js). Then:
 *
 *   ROOFS   the water map's roof cells against "Structures": precision,
 *           recall, IoU, pooled over the squares.
 *   IMPERVIOUS  open ground that is not turf and not a roof: "Roads" and
 *           "Other Impervious" (drives, walks, patios, lots) against the
 *           pervious classes. The mean intensity of each cell's ground
 *           returns (3 x 3 cells), three ways, pooled over squares -- a
 *           threshold has to work across maps, so pooling is the test:
 *             raw          as the flight recorded it
 *             box          over the box's 75th percentile (H11's measure)
 *             lawn         over the median of this map's LAWN cells
 *             lawn+roof    0 at this map's roofs' median, 1 at its lawn's
 *           (Here the land use's turf stands in for the traced lawn; on a
 *           real map the lawn is the one the person traced.)
 *
 * Numbers only. The squares are drawn from county boxes; no address.
 *
 *   SQUARES=24 node water/tools/impervious.mjs
 */

import { pointsIn, toMerc, mercScale } from '../lib/ept.js';
import { nodeIo } from '../lib/node-io.js';
import { analyse } from '../lib/lowspots.js';
import { truthFor, GROUP_NAMES } from '../lib/chesapeake.js';
import { auc, fitLogistic } from '../lib/cells.js';
import { rng } from '../lib/synthetic.js';
import { lidarAt } from '../../worker/src/shade.js';

const SQUARES = Number(process.env.SQUARES || 24);
const SIZE = Number(process.env.SIZE || 160);
const COUNTIES = [ // [name, w, s, e, n] -- suburban parts of Bay-watershed counties
  ['Fairfax VA', -77.40, 38.75, -77.15, 38.95],
  ['Montgomery MD', -77.25, 39.00, -77.05, 39.15],
  ['Howard MD', -76.95, 39.15, -76.80, 39.30],
  ['Chesterfield VA', -77.65, 37.35, -77.45, 37.50],
  ['Lancaster PA', -76.40, 40.00, -76.25, 40.10],
  ['York PA', -76.80, 39.92, -76.65, 40.00],
  ['Dauphin PA', -76.95, 40.25, -76.80, 40.33],
];
const G = Object.fromEntries(GROUP_NAMES.map((n, i) => [n, i]));
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

function box3(g, a) {
  const out = new Float64Array(a.length);
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    let s = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < g.H && cc < g.W) s += a[rr * g.W + cc];
    }
    out[r * g.W + c] = s;
  }
  return out;
}

async function one(lng, lat) {
  const pick = await lidarAt(lng, lat);
  const cloud = pick?.clouds?.[0];
  if (!cloud) return { skip: 'no lidar' };
  const k = mercScale(lat), [cx, cy] = toMerc([lng, lat]), h = SIZE / 2 / k;
  const bbox = [cx - h, cy - h, cx + h, cy + h];
  const { cols } = await pointsIn(cloud.url, bbox, nodeIo());
  const res = analyse(cols, bbox, lat, { epoch: cloud.epoch, nullRuns: 0 });
  const g = res.grid, N = g.W * g.H;
  const truth = await truthFor(g, res.shift);
  if (!truth) return { skip: 'no land use' };
  const share = (n) => truth.filter((t) => t === G[n]).length / N;
  if (share('turf') < 0.15 || share('structure') < 0.05) return { skip: 'not residential' };

  // roofs
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < N; i++) {
    if (truth[i] === G.canopyOverImpervious || !truth[i]) continue; // canopy over roads OR roofs: ambiguous
    const t = truth[i] === G.structure, p = !!res.wall[i];
    if (t && p) tp++; else if (p) fp++; else if (t) fn++;
  }

  // brightness of the ground returns, per cell, 3 x 3
  const pc = res.perCell, gi = box3(g, pc.groundI), gn = box3(g, pc.groundN);
  const all3 = box3(g, pc.all), single3 = box3(g, pc.single);
  const I = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) if (gn[i] > 0) I[i] = gi[i] / gn[i];
  const lawnI = med(Array.from(I).filter((v, i) => truth[i] === G.turf && !res.wall[i]));
  let rI = 0, rN = 0;
  for (let i = 0; i < N; i++) { rI += pc.roofI[i]; rN += pc.roofN[i]; }
  const roofCells = []; for (let i = 0; i < N; i++) if (pc.roofN[i]) roofCells.push(pc.roofI[i] / pc.roofN[i]);
  const roofI = med(roofCells);
  const cells = [];
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(I[i]) || res.wall[i]) continue;
    const t = truth[i];
    const imp = t === G.road || t === G.impervious;
    const perv = t === G.pervious;
    const turf = t === G.turf;
    if (!imp && !perv && !turf) continue;
    cells.push({
      cls: imp ? 'imp' : perv ? 'perv' : 'turf',
      raw: I[i], box: pc.groundP75 ? I[i] / pc.groundP75 : NaN, lawn: lawnI ? I[i] / lawnI : NaN,
      lr: Number.isFinite(roofI) && lawnI !== roofI ? (I[i] - roofI) / (lawnI - roofI) : NaN,
      // for the combined model: smoothness, single returns, return density
      x: [Math.log(Math.max(0.02, I[i] / lawnI)), Number.isFinite(res.sd[i]) ? Math.min(0.3, res.sd[i]) : 0.05, all3[i] ? single3[i] / all3[i] : 0, Math.log(all3[i] / 9 + 0.1)],
    });
  }
  return {
    cloud: cloud.name, roofs: { tp, fp, fn }, cells, lawnI, roofI, p75: pc.groundP75,
    shares: { turf: share('turf'), structure: share('structure'), road: share('road'), impervious: share('impervious'), pervious: share('pervious') },
  };
}

async function main() {
  const r = rng(2026);
  const done = [];
  let tries = 0;
  while (done.length < SQUARES && tries < SQUARES * 4) {
    const [name, w, s, e, n] = COUNTIES[tries % COUNTIES.length];
    tries++;
    const lng = w + r() * (e - w), lat = s + r() * (n - s);
    try {
      const out = await one(lng, lat);
      if (out.skip) { console.log(`try ${tries} (${name}): ${out.skip}`); continue; }
      done.push({ name, ...out });
      const c = out.cells, a = (key) => auc(c.filter((x) => x.cls === 'imp').map((x) => -x[key]), c.filter((x) => x.cls !== 'imp').map((x) => -x[key]));
      const { tp, fp, fn } = out.roofs;
      console.log(`#${done.length} ${name}: ${out.cloud.replace(/^USGS_LPC_/, '')}; turf ${Math.round(100 * out.shares.turf)}% roofs ${Math.round(100 * out.shares.structure)}% paved ${Math.round(100 * (out.shares.road + out.shares.impervious))}%;`
        + ` roofs found ${tp ? Math.round(100 * tp / (tp + fn)) : 0}% (precision ${tp + fp ? Math.round(100 * tp / (tp + fp)) : 0}%);`
        + ` brightness lawn ${Math.round(out.lawnI)} roof ${Math.round(out.roofI)}; paved-vs-rest AUC in this square ${a('raw').toFixed(2)}`);
    } catch (e) {
      console.log(`try ${tries} (${name}): failed -- ${String(e.message).replace(/-?\d+\.\d{3,}/g, '…')}`);
    }
  }

  const all = done.flatMap((d) => d.cells);
  const score = (key, a, b) => auc(all.filter((x) => a.includes(x.cls) && Number.isFinite(x[key])).map((x) => -x[key]), all.filter((x) => b.includes(x.cls) && Number.isFinite(x[key])).map((x) => -x[key]));
  const R = done.reduce((t, d) => ({ tp: t.tp + d.roofs.tp, fp: t.fp + d.roofs.fp, fn: t.fn + d.roofs.fn }), { tp: 0, fp: 0, fn: 0 });
  const within = (key) => med(done.map((d) => auc(d.cells.filter((x) => x.cls === 'imp').map((x) => -x[key]), d.cells.filter((x) => x.cls === 'perv').map((x) => -x[key]))));
  console.log('\n==============================================================');
  console.log(`ROOFS AND IMPERVIOUSNESS ON THE CHESAPEAKE LAND USE: ${done.length} residential squares of ${SIZE} m (${tries} tried)`);
  console.log(`  roofs (cells; "Structures" is the truth): found ${Math.round(100 * R.tp / (R.tp + R.fn))}% of roof cells, ${Math.round(100 * R.tp / (R.tp + R.fp))}% of what it calls roof is roof, IoU ${(R.tp / (R.tp + R.fp + R.fn)).toFixed(2)}`);
  const n = (c) => all.filter((x) => x.cls === c).length;
  console.log(`  open ground cells with a ground return: ${n('imp')} paved (roads, drives, walks, lots), ${n('perv')} pervious non-turf, ${n('turf')} turf`);
  console.log('  AUC, darker = more impervious, pooled over all squares (one threshold for every map):');
  console.log('                              paved vs pervious   paved vs turf   paved vs both');
  for (const [key, label] of [['raw', 'raw brightness'], ['box', 'over the box 75th pct'], ['lawn', 'over this map\'s lawn'], ['lr', 'roof 0 .. lawn 1']]) {
    console.log(`    ${label.padEnd(26)} ${score(key, ['imp'], ['perv']).toFixed(3).padStart(10)} ${score(key, ['imp'], ['turf']).toFixed(3).padStart(15)} ${score(key, ['imp'], ['perv', 'turf']).toFixed(3).padStart(15)}`);
  }
  console.log(`  within one square (median over squares, paved vs pervious): ${within('raw').toFixed(3)} -- the ceiling a per-map calibration can reach with brightness alone`);
  // brightness over the lawn, with smoothness, single returns and density: fit on odd squares, test on even
  const fitC = done.filter((_, j) => j % 2 === 0).flatMap((d) => d.cells), testC = done.filter((_, j) => j % 2 === 1).flatMap((d) => d.cells);
  const thin = (list, n) => list.filter((_, j) => j % Math.max(1, Math.floor(list.length / n)) === 0);
  const rowsOf = (list, keys) => thin(list, 40000).filter((c) => c.x.every(Number.isFinite)).map((c) => [keys.map((k) => c.x[k]), c.cls === 'imp' ? 1 : 0]);
  for (const [keys, label] of [[[0], 'brightness over the lawn alone'], [[0, 1, 2, 3], 'brightness + smoothness + single returns + density']]) {
    const m = fitLogistic(rowsOf(fitC, keys));
    const p = (c) => { let z = m.b; keys.forEach((k, j) => { z += m.w[j] * ((c.x[k] - m.mean[j]) / m.sd[j]); }); return z; };
    const T = testC.filter((c) => c.x.every(Number.isFinite));
    console.log(`  ${label}, fitted on ${Math.ceil(done.length / 2)} squares, tested on ${Math.floor(done.length / 2)}: paved vs both ${auc(T.filter((c) => c.cls === 'imp').map(p), T.filter((c) => c.cls !== 'imp').map(p)).toFixed(3)}, paved vs pervious ${auc(T.filter((c) => c.cls === 'imp').map(p), T.filter((c) => c.cls === 'perv').map(p)).toFixed(3)}; weights ${JSON.stringify({ keys, mean: m.mean.map((v) => +v.toFixed(4)), sd: m.sd.map((v) => +v.toFixed(4)), w: m.w.map((v) => +v.toFixed(3)), b: +m.b.toFixed(3) })}`);
  }
  const lr = all.filter((x) => Number.isFinite(x.lr));
  for (const c of ['imp', 'perv', 'turf']) {
    const v = lr.filter((x) => x.cls === c).map((x) => x.lr).sort((a, b) => a - b);
    if (v.length) console.log(`  roof 0 .. lawn 1 scale, ${c.padEnd(4)}: 10th ${v[Math.floor(v.length * 0.1)].toFixed(2)}  median ${v[v.length >> 1].toFixed(2)}  90th ${v[Math.floor(v.length * 0.9)].toFixed(2)}`);
  }
}

main().catch((e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });
