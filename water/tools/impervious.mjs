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
import { naipFor, ndvi } from '../lib/naip.js';
import { rng } from '../lib/synthetic.js';
import { lidarAt } from '../../worker/src/shade.js';
import { shadeRoofs } from '../lib/roofs.js';

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

  // roofs, each finder and each stage of the shade map's (lib/roofs.js), exact and within 1 m
  const shade = shadeRoofs(res.points, bbox, lat, { parts: true }); // the points as analysed: moved onto the web map's ground
  const finders = {
    water: res.ownRoofs, shadeFlat: shade.flat, shadeSolid: shade.solid, shade: shade.roof,
    either: Uint8Array.from(res.ownRoofs, (v, i) => (v || shade.roof[i] ? 1 : 0)),
    both: Uint8Array.from(res.ownRoofs, (v, i) => (v && shade.roof[i] ? 1 : 0)),
    waterNoEvergreen: Uint8Array.from(res.ownRoofs, (v, i) => (v && !shade.evergreen[i] ? 1 : 0)),
  };
  const near = (mask, i) => {
    const r = Math.floor(i / g.W), c = i % g.W;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < g.H && cc < g.W && mask[rr * g.W + cc]) return true;
    }
    return false;
  };
  const isRoof = Uint8Array.from(truth, (t) => (t === G.structure ? 1 : 0));
  const roofScores = {};
  for (const [name, m] of Object.entries(finders)) {
    const sc = { tp: 0, fp: 0, fn: 0, tpNear: 0, predN: 0, foundNear: 0, truthN: 0 };
    for (let i = 0; i < N; i++) {
      if (truth[i] === G.canopyOverImpervious || !truth[i]) continue;
      const t = isRoof[i], p = !!m[i];
      if (t && p) sc.tp++; else if (p) sc.fp++; else if (t) sc.fn++;
      if (p) { sc.predN++; if (near(isRoof, i)) sc.tpNear++; }
      if (t) { sc.truthN++; if (near(m, i)) sc.foundNear++; }
    }
    roofScores[name] = sc;
  }
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
  // the USDA photo with its near-infrared band (lib/naip.js), calibrated on this square's own turf like the brightness
  const photo = await naipFor(g).catch(() => null);
  const V = photo ? ndvi(photo) : null;
  const bright = photo ? Float32Array.from(photo.red, (r, i) => (r + photo.green[i] + photo.blue[i]) / 3) : null;
  const lawnV = V ? med(Array.from(V).filter((v, i) => truth[i] === G.turf && !res.wall[i] && Number.isFinite(v))) : NaN;
  const lawnB = bright ? med(Array.from(bright).filter((v, i) => truth[i] === G.turf && !res.wall[i])) : NaN;
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
      x: [Math.log(Math.max(0.02, I[i] / lawnI)), Number.isFinite(res.sd[i]) ? Math.min(0.3, res.sd[i]) : 0.05, all3[i] ? single3[i] / all3[i] : 0, Math.log(all3[i] / 9 + 0.1),
        // 4-7: the photo -- vegetation index, it against the turf's, brightness against the turf's, blueness
        V ? V[i] : NaN, V ? V[i] - lawnV : NaN, bright ? Math.log(Math.max(1, bright[i]) / Math.max(1, lawnB)) : NaN, photo ? (photo.blue[i] - photo.red[i]) / 255 : NaN],
    });
  }
  return {
    cloud: cloud.name, roofs: { tp, fp, fn }, roofScores, cells, lawnI, roofI, p75: pc.groundP75,
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
  console.log('  roof finders, pooled (exact | within 1 m):       found      precise     IoU');
  const label = { water: 'water map (surface.js)', shadeFlat: 'shade: flat-roof rule alone', shadeSolid: 'shade: + solid at the grass, + eaves', shade: 'shade: + tree-vs-roof patch test (full)', either: 'either says roof', both: 'both say roof', waterNoEvergreen: 'water map, less what shade calls evergreen' };
  for (const name of Object.keys(done[0]?.roofScores || {})) {
    const t = done.reduce((a, d) => { for (const k of Object.keys(a)) a[k] += d.roofScores[name][k]; return a; }, { tp: 0, fp: 0, fn: 0, tpNear: 0, predN: 0, foundNear: 0, truthN: 0 });
    const f = (v) => `${Math.round(100 * v)}%`;
    console.log(`    ${label[name].padEnd(42)} ${f(t.tp / (t.tp + t.fn))} | ${f(t.foundNear / t.truthN)}   ${f(t.tp / (t.tp + t.fp))} | ${f(t.tpNear / t.predN)}   ${(t.tp / (t.tp + t.fp + t.fn)).toFixed(2)}`);
  }
  const perFlight = {};
  for (const d of done) { const f = (perFlight[d.cloud] ||= { water: [0, 0, 0], shade: [0, 0, 0], waterNoEvergreen: [0, 0, 0] }); for (const n of ['water', 'shade', 'waterNoEvergreen']) { f[n][0] += d.roofScores[n].tp; f[n][1] += d.roofScores[n].fp; f[n][2] += d.roofScores[n].fn; } }
  for (const [fl, f] of Object.entries(perFlight)) console.log(`    by flight ${fl.replace(/^USGS_LPC_/, '').padEnd(34)} IoU water ${(f.water[0] / (f.water[0] + f.water[1] + f.water[2])).toFixed(2)}, shade ${(f.shade[0] / (f.shade[0] + f.shade[1] + f.shade[2])).toFixed(2)}, water less evergreen ${(f.waterNoEvergreen[0] / (f.waterNoEvergreen[0] + f.waterNoEvergreen[1] + f.waterNoEvergreen[2])).toFixed(2)}`);
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
  /* the same cells for every model: those with the photo too, so the comparison is like for like */
  const both = (list) => list.filter((c) => c.x.every(Number.isFinite));
  const fitB = both(fitC), testB = both(testC);
  console.log(`  cells with lidar and photo: ${fitB.length} to fit, ${testB.length} to test (of ${fitC.length} / ${testC.length})`);
  for (const [keys, label] of [[[0], 'lidar brightness over the lawn alone'], [[0, 1, 2, 3], 'lidar: brightness + smoothness + single returns + density (in use)'],
    [[4, 5], 'photo: vegetation index'], [[4, 5, 6, 7], 'photo: vegetation index + brightness + blueness'], [[0, 1, 2, 3, 4, 5, 6, 7], 'lidar + photo, all eight'],
    [[0, 1, 2, 3, 5, 6, 7], 'lidar + photo, all against the lawn (no raw vegetation index)'], [[0, 5, 6], 'lidar brightness + photo greenness and brightness, against the lawn']]) {
    const m = fitLogistic(rowsOf(fitB, keys));
    const p = (c) => { let z = m.b; keys.forEach((k, j) => { z += m.w[j] * ((c.x[k] - m.mean[j]) / m.sd[j]); }); return z; };
    const T = testB;
    // right how often: the share of test cells on the right side of an even-odds line
    const right = T.filter((c) => (p(c) > 0) === (c.cls === 'imp')).length / Math.max(1, T.length);
    const impT = T.filter((c) => c.cls === 'imp'), found = impT.filter((c) => p(c) > 0).length / Math.max(1, impT.length);
    const called = T.filter((c) => p(c) > 0), precise = called.filter((c) => c.cls === 'imp').length / Math.max(1, called.length);
    console.log(`  ${label}: right on ${(right * 100).toFixed(1)}% of cells, finds ${(found * 100).toFixed(0)}% of paving, ${(precise * 100).toFixed(0)}% of what it calls paving is paving`);
    console.log(`  ${label}, fitted on ${Math.ceil(done.length / 2)} squares, tested on ${Math.floor(done.length / 2)}: paved vs both ${auc(T.filter((c) => c.cls === 'imp').map(p), T.filter((c) => c.cls !== 'imp').map(p)).toFixed(3)}, paved vs pervious ${auc(T.filter((c) => c.cls === 'imp').map(p), T.filter((c) => c.cls === 'perv').map(p)).toFixed(3)}; weights ${JSON.stringify({ keys, mean: m.mean.map((v) => +v.toFixed(4)), sd: m.sd.map((v) => +v.toFixed(4)), w: m.w.map((v) => +v.toFixed(3)), b: +m.b.toFixed(3) })}`);
  }
  const lr = all.filter((x) => Number.isFinite(x.lr));
  for (const c of ['imp', 'perv', 'turf']) {
    const v = lr.filter((x) => x.cls === c).map((x) => x.lr).sort((a, b) => a - b);
    if (v.length) console.log(`  roof 0 .. lawn 1 scale, ${c.padEnd(4)}: 10th ${v[Math.floor(v.length * 0.1)].toFixed(2)}  median ${v[v.length >> 1].toFixed(2)}  90th ${v[Math.floor(v.length * 0.9)].toFixed(2)}`);
  }
}

main().catch((e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });
