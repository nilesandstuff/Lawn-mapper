/**
 * THE CONFIDENCE SLIDER, CHECKED AGAINST REAL PREDICTIONS (owner, 2026-11-03: on a condo complex "the measurement
 * actually decreased from about 125,000 to just 810 square feet" at 40%, nothing at 45% or above 50%).
 *
 * The page re-cuts the decoder's picture with public/lib/finish.js finishLot, the same function the model server
 * finished the lot with, so at 50% the re-cut must equal the served mask and a lower cut can only add lawn. This
 * reads the newest predictions' pictures out of the corpus bucket (alpha/masks/<call>.png the served mask,
 * <call>-raw.png the decoder's picture, <call>-canopy|roof|void.png, <call>.json the answer) and prints, per
 * prediction, the lawn cells of the served mask and of the re-cut at every slider setting, exactly as the page
 * computes it. Run by .github/workflows/recut-check.yml; the files are fetched there with wrangler.
 *
 *   DIR=masks node tools/recut-check.mjs           every <call> that has a -raw.png in DIR
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { finishLot, predictionMask, LAWN_THRESHOLD } from '../public/lib/finish.js';

const dir = process.env.DIR || 'masks';
const read = (f) => (existsSync(f) ? PNG.sync.read(readFileSync(f)) : null);
const cells = (m) => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i] ? 1 : 0; return n; };
const lawnOf = (png) => { if (!png) return null; let n = 0; for (let i = 0; i < png.width * png.height; i++) n += png.data[i * 4] >= 128 ? 1 : 0; return n; };

/** The decoder picture's histogram in eight bins, to see where its values sit. */
function histogram(png) {
  const h = new Array(8).fill(0);
  for (let i = 0; i < png.width * png.height; i++) h[Math.min(7, png.data[i * 4] >> 5)]++;
  return h;
}

const calls = readdirSync(dir).filter((f) => f.endsWith('-raw.png')).map((f) => f.slice(0, -'-raw.png'.length)).sort();
if (!calls.length) { console.log(`No predictions in ${dir} (no *-raw.png).`); process.exit(0); }
const PCTS = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
let bad = 0;
for (const call of calls) {
  const served = read(join(dir, `${call}.png`)), prob = read(join(dir, `${call}-raw.png`));
  const canopy = read(join(dir, `${call}-canopy.png`)), roof = read(join(dir, `${call}-roof.png`)), voidMask = read(join(dir, `${call}-void.png`));
  let answer = null;
  try { answer = JSON.parse(readFileSync(join(dir, `${call}.json`), 'utf8')); } catch { /* none */ }
  console.log(`\n== ${call}: served ${served ? `${served.width}x${served.height}` : 'missing'}, raw ${prob ? `${prob.width}x${prob.height}` : 'missing'}, canopy ${canopy ? `${canopy.width}x${canopy.height}` : 'none'}, roof ${roof ? 'yes' : 'none'}, void ${voidMask ? 'yes' : 'none'}, mpp ${answer?.mpp ?? '?'}, leafOff ${answer?.leafOff ?? '?'}, version ${answer?.version ?? '?'}`);
  if (!prob) continue;
  console.log(`   raw histogram (0-31 .. 224-255): ${histogram(prob).join(' ')}`);
  const w = prob.width, h = prob.height, mpp = Number.isFinite(answer?.mpp) ? answer.mpp : 0.15, leafOff = typeof answer?.leafOff === 'boolean' ? answer.leafOff : null;
  const servedCells = lawnOf(served);
  const plain = cells(predictionMask(prob, w, h, LAWN_THRESHOLD));
  console.log(`   served lawn cells ${servedCells}; the raw picture cut at 128 alone ${plain}`);
  const rows = [];
  for (const pct of PCTS) {
    const threshold = Math.round((pct * 255) / 100);
    let n;
    try { n = cells(finishLot({ prob, canopy, roof, voidMask, height: null, w, h, mpp, threshold, leafOff })); } catch (e) { n = `error: ${e.message}`; }
    rows.push(`${pct}%:${n}`);
    if (pct === 50 && servedCells != null && n !== servedCells) { bad++; console.log(`   !! the re-cut at 50% (${n}) is not the served mask (${servedCells})`); }
  }
  console.log(`   re-cut lawn cells by setting: ${rows.join('  ')}`);
}
console.log(`\n${calls.length} prediction(s); ${bad} where the 50% re-cut differs from the served mask.`);
