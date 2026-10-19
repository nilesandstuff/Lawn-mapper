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
import { overtureFor, overtureMasks } from '../lib/overture.js';
import { rng } from '../lib/synthetic.js';
import { lidarAt } from '../../worker/src/shade.js';
import { shadeRoofs } from '../lib/roofs.js';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

/* DUMP=<dir>: for each held-out test square, what water/tools/flair_score.py needs to score IGNF's FLAIR
   land-cover U-Nets (the core session's find, 2026-10-19) on exactly the cells everything else is scored
   on: the NAIP photo at FLAIR's 0.2 m, height above ground from the lidar, the land use as a simple code,
   the roof finder's mask and the in-use paving model's chance per cell. Numbers only, no places. */
const DUMP = process.env.DUMP || '';

/* THE PAID CANDIDATE (owner, 2026-10-18: "whatever is most accurate and fastest"; his Replicate token,
   REPLICATE_TOKEN, the one the main site uses): SAM 3 on Replicate (mattsays/sam3-image, the model the
   main site asks for "grass"), asked here for paving -- one concept per prompt, as the core found works
   best -- on the same NAIP photo. Only with SAM=1; at most SAM_MAX predictions in all. */
const SAM = process.env.SAM === '1' && !!process.env.REPLICATE_TOKEN;
const SAM_PROMPTS = (process.env.SAM_PROMPTS || 'pavement,driveway,road').split(',').map((s) => s.trim()).filter(Boolean);
const SAM_MAX = Number(process.env.SAM_MAX || 80);
const samStats = { predictions: 0, seconds: 0, failed: 0 };
let samVersion = null;

async function samMask(png, prompt, w, h) {
  if (samStats.predictions >= SAM_MAX) return null;
  const auth = { Authorization: `Bearer ${process.env.REPLICATE_TOKEN}`, 'Content-Type': 'application/json' };
  if (!samVersion) samVersion = (await (await fetch('https://api.replicate.com/v1/models/mattsays/sam3-image', { headers: auth })).json()).latest_version?.id;
  samStats.predictions++;
  let p = await (await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST', headers: { ...auth, Prefer: 'wait' },
    body: JSON.stringify({ version: samVersion, input: { image: `data:image/png;base64,${png.toString('base64')}`, prompt, mask_only: true, save_overlay: false, return_zip: false, threshold: 0.2 } }),
  })).json();
  for (let k = 0; k < 60 && p && !['succeeded', 'failed', 'canceled'].includes(p.status); k++) {
    await new Promise((r) => setTimeout(r, 2000));
    p = await (await fetch(`https://api.replicate.com/v1/predictions/${p.id}`, { headers: auth })).json();
  }
  if (p?.metrics?.predict_time) samStats.seconds += p.metrics.predict_time;
  const url = Array.isArray(p?.output) ? p.output[0] : p?.output;
  if (p?.status !== 'succeeded' || !url) { samStats.failed++; return null; }
  const img = PNG.sync.read(Buffer.from(await (await fetch(url)).arrayBuffer()));
  // the mask, white = found, onto the picture's pixel grid (it may come back at another size)
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.width - 1, Math.floor((x / w) * img.width)), sy = Math.min(img.height - 1, Math.floor((y / h) * img.height));
    const o = (sy * img.width + sx) * 4;
    out[y * w + x] = img.data[o] + img.data[o + 1] + img.data[o + 2] > 382 && img.data[o + 3] > 0 ? 1 : 0;
  }
  return out;
}

/** The photo as a PNG the model can see: 3 pixels a metre (lib/naip.js UP), red-green-blue. */
async function samShare(g) {
  const UPX = 3, W = g.W * UPX, H = g.H * UPX;
  const url = `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox=${g.bbox.map((v) => v.toFixed(2)).join(',')}&bboxSR=3857&imageSR=3857&size=${W},${H}&format=bsq&pixelType=U8&interpolation=RSP_BilinearInterpolation&f=image`;
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  if (buf.length < W * H * 3) return null;
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) { png.data[i * 4] = buf[i]; png.data[i * 4 + 1] = buf[W * H + i]; png.data[i * 4 + 2] = buf[2 * W * H + i]; png.data[i * 4 + 3] = 255; }
  const file = PNG.sync.write(png);
  const union = new Uint8Array(W * H);
  let any = false;
  for (const prompt of SAM_PROMPTS) {
    const m = await samMask(file, prompt, W, H).catch(() => { samStats.failed++; return null; });
    if (!m) continue;
    any = true;
    for (let i = 0; i < m.length; i++) union[i] |= m[i];
  }
  if (!any) return null;
  const share = new Float32Array(g.W * g.H);
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    let s = 0;
    for (let dr = 0; dr < UPX; dr++) for (let dc = 0; dc < UPX; dc++) s += union[(r * UPX + dr) * W + c * UPX + dc];
    share[r * g.W + c] = s / (UPX * UPX);
  }
  return share;
}

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
  // Overture's roads, sidewalks and buildings (lib/overture.js; owner 2026-10-19: "use that on top of current system")
  const ovm = await overtureFor(g.bbox).then((ov) => overtureMasks(g, ov)).catch(() => null);
  const finders = {
    water: res.ownRoofs, shadeFlat: shade.flat, shadeSolid: shade.solid, shade: shade.roof,
    either: Uint8Array.from(res.ownRoofs, (v, i) => (v || shade.roof[i] ? 1 : 0)),
    both: Uint8Array.from(res.ownRoofs, (v, i) => (v && shade.roof[i] ? 1 : 0)),
    waterNoEvergreen: Uint8Array.from(res.ownRoofs, (v, i) => (v && !shade.evergreen[i] ? 1 : 0)),
    ...(ovm ? {
      overture: ovm.building,
      eitherOverture: Uint8Array.from(res.ownRoofs, (v, i) => (v || shade.roof[i] || ovm.building[i] ? 1 : 0)),
      eitherAndOverture: Uint8Array.from(res.ownRoofs, (v, i) => ((v || shade.roof[i]) && ovm.building[i] ? 1 : 0)),
    } : {}),
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
  const sam = SAM ? await samShare(g).catch(() => null) : null;
  const cells = [];
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(I[i]) || res.wall[i]) continue;
    const t = truth[i];
    const imp = t === G.road || t === G.impervious;
    const perv = t === G.pervious;
    const turf = t === G.turf;
    if (!imp && !perv && !turf) continue;
    cells.push({
      i,
      cls: imp ? 'imp' : perv ? 'perv' : 'turf',
      raw: I[i], box: pc.groundP75 ? I[i] / pc.groundP75 : NaN, lawn: lawnI ? I[i] / lawnI : NaN,
      lr: Number.isFinite(roofI) && lawnI !== roofI ? (I[i] - roofI) / (lawnI - roofI) : NaN,
      // for the combined model: smoothness, single returns, return density
      sam: sam ? sam[i] : NaN,
      ovRoad: ovm ? (ovm.paved[i] === 1 ? 1 : 0) : NaN, ovWalk: ovm ? (ovm.paved[i] === 2 ? 1 : 0) : NaN,
      x: [Math.log(Math.max(0.02, I[i] / lawnI)), Number.isFinite(res.sd[i]) ? Math.min(0.3, res.sd[i]) : 0.05, all3[i] ? single3[i] / all3[i] : 0, Math.log(all3[i] / 9 + 0.1),
        // 4-7: the photo -- vegetation index, it against the turf's, brightness against the turf's, blueness
        V ? V[i] : NaN, V ? V[i] - lawnV : NaN, bright ? Math.log(Math.max(1, bright[i]) / Math.max(1, lawnB)) : NaN, photo ? (photo.blue[i] - photo.red[i]) / 255 : NaN],
    });
  }
  let dump = null;
  if (DUMP) {
    const hag = new Float32Array(N);
    const P = res.points;
    for (let k = 0; k < P.n; k++) {
      if (P.cls[k] === 7 || P.cls[k] === 18) continue;
      const [fc, fr] = g.toCell(P.x[k], P.y[k]);
      const c = Math.floor(fc), r = Math.floor(fr);
      if (c < 0 || r < 0 || c >= g.W || r >= g.H) continue;
      const j = r * g.W + c, h = P.z[k] - res.z[j];
      if (h > hag[j]) hag[j] = h;
    }
    // 1 roof, 2 paved, 3 pervious, 4 turf, 5 other land use, 0 not to be judged (no answer, canopy over impervious)
    const simple = Uint8Array.from(truth, (t) => (!t || t === G.canopyOverImpervious ? 0 : t === G.structure ? 1 : t === G.road || t === G.impervious ? 2 : t === G.pervious ? 3 : t === G.turf ? 4 : 5));
    dump = { W: g.W, H: g.H, bbox: g.bbox, hag, simple, roof: finders.either };
  }
  return {
    dump,
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
  const label = { water: 'water map (surface.js)', shadeFlat: 'shade: flat-roof rule alone', shadeSolid: 'shade: + solid at the grass, + eaves', shade: 'shade: + tree-vs-roof patch test (full)', either: 'either says roof', both: 'both say roof', waterNoEvergreen: 'water map, less what shade calls evergreen',
    overture: 'Overture buildings alone', eitherOverture: 'either, or an Overture building', eitherAndOverture: 'either, and an Overture building' };
  const names = [...new Set(done.flatMap((d) => Object.keys(d.roofScores)))];
  const withOv = done.filter((d) => d.roofScores.overture);
  for (const [name, list, tag] of [...names.map((n) => [n, done.filter((d) => d.roofScores[n]), '']), ['either', withOv, ' (Overture squares)']]) {
    if (!list.length) continue;
    const t = list.reduce((a, d) => { for (const k of Object.keys(a)) a[k] += d.roofScores[name][k]; return a; }, { tp: 0, fp: 0, fn: 0, tpNear: 0, predN: 0, foundNear: 0, truthN: 0 });
    const f = (v) => `${Math.round(100 * v)}%`;
    console.log(`    ${(label[name] + tag).padEnd(42)} ${f(t.tp / (t.tp + t.fn))} | ${f(t.foundNear / t.truthN)}   ${f(t.tp / (t.tp + t.fp))} | ${f(t.tpNear / t.predN)}   ${(t.tp / (t.tp + t.fp + t.fn)).toFixed(2)}   (${list.length} squares)`);
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
  {
    // OVERTURE ON TOP (owner 2026-10-19): its road and sidewalk bands, alone, OR'd with the in-use model, and
    // as two more inputs to it -- on the test squares' cells that have the lidar, the photo and Overture
    const has = (list) => list.filter((c) => c.x.every(Number.isFinite) && Number.isFinite(c.ovRoad));
    const F = has(fitC), T = has(testC);
    if (T.length) {
      const score = (label, pred) => {
        const right = T.filter((c) => pred(c) === (c.cls === 'imp')).length / T.length;
        const impT = T.filter((c) => c.cls === 'imp'), found = impT.filter(pred).length / Math.max(1, impT.length);
        const called = T.filter(pred), precise = called.filter((c) => c.cls === 'imp').length / Math.max(1, called.length);
        console.log(`  ${label}: right on ${(right * 100).toFixed(1)}% of cells, finds ${(found * 100).toFixed(0)}% of paving, ${(precise * 100).toFixed(0)}% of what it calls paving is paving`);
      };
      const val = (c, k) => (k === 8 ? c.ovRoad : k === 9 ? c.ovWalk : c.x[k]);
      const fitZ = (keys) => {
        const m = fitLogistic(thin(F, 40000).map((c) => [keys.map((k) => val(c, k)), c.cls === 'imp' ? 1 : 0]));
        return (c) => { let v = m.b; keys.forEach((k, j) => { v += m.w[j] * ((val(c, k) - m.mean[j]) / m.sd[j]); }); return v; };
      };
      console.log(`  OVERTURE, on ${T.length} test cells with lidar, photo and Overture (${T.filter((c) => c.ovRoad).length} under a road band, ${T.filter((c) => c.ovWalk).length} under a sidewalk or path band):`);
      const inUse = fitZ([0, 1, 2, 3, 5, 6, 7]);
      score('lidar + photo against the lawn (in use)', (c) => inUse(c) > 0);
      score('Overture road and sidewalk bands alone', (c) => c.ovRoad === 1 || c.ovWalk === 1);
      score('in use OR an Overture band', (c) => inUse(c) > 0 || c.ovRoad === 1 || c.ovWalk === 1);
      const both = fitZ([0, 1, 2, 3, 5, 6, 7, 8, 9]);
      score('in use + Overture bands as two more inputs', (c) => both(c) > 0);
      // under trees, where the photo and the laser see least: the Chesapeake class "pervious" is not here, but
      // the bands are judged on the cells they fall on
      const band = T.filter((c) => c.ovRoad || c.ovWalk);
      console.log(`    of the cells under an Overture band, ${(100 * band.filter((c) => c.cls === 'imp').length / Math.max(1, band.length)).toFixed(0)}% are paved in the land use`);
    }
  }
  if (DUMP) {
    // the in-use model (lidar + photo against the lawn, lib/impervious.js PAVED_MODEL_PHOTO's inputs), fitted
    // on the even squares as above; each odd (test) square written out for flair_score.py
    const keys = [0, 1, 2, 3, 5, 6, 7];
    const m = fitLogistic(rowsOf(fitB, keys));
    const z = (c) => { let v = m.b; keys.forEach((k, j) => { v += m.w[j] * ((c.x[k] - m.mean[j]) / m.sd[j]); }); return v; };
    mkdirSync(DUMP, { recursive: true });
    let n = 0;
    for (let j = 1; j < done.length; j += 2) {
      const d = done[j];
      if (!d.dump) continue;
      const { W, H, bbox, hag, simple, roof } = d.dump;
      const UPX = 5;
      const url = `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox=${bbox.map((v) => v.toFixed(2)).join(',')}&bboxSR=3857&imageSR=3857&size=${W * UPX},${H * UPX}&format=bsq&pixelType=U8&interpolation=RSP_BilinearInterpolation&f=image`;
      const photo = Buffer.from(await (await fetch(url)).arrayBuffer());
      if (photo.length < W * H * UPX * UPX * 4) continue;
      const cells = d.cells.filter((c) => c.x.every(Number.isFinite)).map((c) => [c.i, c.cls === 'imp' ? 1 : c.cls === 'perv' ? 2 : 3, +(1 / (1 + Math.exp(-z(c)))).toFixed(4)]);
      const id = `sq${String(++n).padStart(2, '0')}`;
      writeFileSync(`${DUMP}/${id}.json`, JSON.stringify({ W, H, up: UPX, cells }));
      writeFileSync(`${DUMP}/${id}-naip.bsq`, photo.subarray(0, W * H * UPX * UPX * 4));
      writeFileSync(`${DUMP}/${id}-hag.f32`, Buffer.from(hag.buffer));
      writeFileSync(`${DUMP}/${id}-truth.u8`, Buffer.from(simple.buffer));
      writeFileSync(`${DUMP}/${id}-roof.u8`, Buffer.from(Uint8Array.from(roof).buffer));
    }
    console.log(`  written for FLAIR: ${n} test squares`);
  }
  if (SAM) {
    // the paid model: on the test squares' cells it saw, alone (its mask as it is) and as a ninth input
    const seen = (list) => list.filter((c) => c.x.every(Number.isFinite) && Number.isFinite(c.sam));
    const F = seen(fitC), T = seen(testC);
    console.log(`  SAM 3 on Replicate (prompts ${SAM_PROMPTS.join(', ')}): ${samStats.predictions} predictions, ${samStats.failed} failed, ${samStats.seconds.toFixed(0)} s of GPU; cells it saw: ${F.length} to fit, ${T.length} to test`);
    if (T.length) {
      const score = (label, pred) => {
        const right = T.filter((c) => pred(c) === (c.cls === 'imp')).length / T.length;
        const impT = T.filter((c) => c.cls === 'imp'), found = impT.filter(pred).length / Math.max(1, impT.length);
        const called = T.filter(pred), precise = called.filter((c) => c.cls === 'imp').length / Math.max(1, called.length);
        console.log(`  ${label}: right on ${(right * 100).toFixed(1)}% of cells, finds ${(found * 100).toFixed(0)}% of paving, ${(precise * 100).toFixed(0)}% of what it calls paving is paving`);
      };
      score('SAM 3 alone (half the cell or more in its mask)', (c) => c.sam >= 0.5);
      for (const [keys, label] of [[[0, 1, 2, 3, 5, 6, 7], 'lidar + photo against the lawn (in use), on the same cells'], [[0, 1, 2, 3, 5, 6, 7, 8], 'lidar + photo + SAM 3']]) {
        const rows = (list) => thin(list, 40000).map((c) => [keys.map((k) => (k === 8 ? c.sam : c.x[k])), c.cls === 'imp' ? 1 : 0]);
        const m = fitLogistic(rows(F));
        const z = (c) => { let v = m.b; keys.forEach((k, j) => { v += m.w[j] * (((k === 8 ? c.sam : c.x[k]) - m.mean[j]) / m.sd[j]); }); return v; };
        score(label, (c) => z(c) > 0);
      }
    }
  }
  const lr = all.filter((x) => Number.isFinite(x.lr));
  for (const c of ['imp', 'perv', 'turf']) {
    const v = lr.filter((x) => x.cls === c).map((x) => x.lr).sort((a, b) => a - b);
    if (v.length) console.log(`  roof 0 .. lawn 1 scale, ${c.padEnd(4)}: 10th ${v[Math.floor(v.length * 0.1)].toFixed(2)}  median ${v[v.length >> 1].toFixed(2)}  90th ${v[Math.floor(v.length * 0.9)].toFixed(2)}`);
  }
}

main().catch((e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });
