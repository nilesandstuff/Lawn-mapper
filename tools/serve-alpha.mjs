/**
 * The JavaScript half of serving THE PLAN's detector (tools/modal_serve.py).
 *
 * WHY NODE AT ALL. The score every finding is measured on comes from
 * tools/train-detector.js: the lot's grid (gridDims), the decoder's picture
 * cut at 128 (predictionMask), stage 3 over the tree model's canopy, then the
 * lidar veto. Serving the same model through a Python copy of that arithmetic
 * would serve a slightly different detector from the one that was measured,
 * and nothing would say so. So the server calls these, the same functions.
 *
 *   node tools/serve-alpha.mjs prepare < {frame}            -> {w, h, mpp, span, down, bbox, lidarUrl}
 *   node tools/serve-alpha.mjs finish  < {dir, w, h, mpp, frame, parcel}
 *                                                           -> writes dir/final.png, prints {uncertainty, ...}
 *
 * `dir` holds what the Python half wrote: prob.png (the decoder's picture on
 * the w x h grid, 255 = lawn), and where they exist canopy.png (the tree
 * model's mask at the photograph's pixels), roof.png, void.png, height.png
 * (tools/lidar_frame.py's layers on its 2 m grid).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  gridDims, predictionMask, canopyMask, heightMask, lidarVeto,
} from './train-detector.js';
import { stage3, seeThroughFor } from './stage3.js';
import { frameBbox3857 } from '../worker/src/imagery.js';
import { metresPerPixel, lngLatToFramePx } from '../public/lib/mercator.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { planFrames } from './lidar-plan.js';
import { FOOTPRINTS, fetchFootprints } from './lidar-cover.js';

/* THE PLAN's stage 3 (H39, H60): span 8 m, reach 1 m, bridge over 180°. */
export const STAGE3 = { spanM: 8, reachM: 1, minRing: 0.5 };

/*
 * SEE-THROUGH CANOPY (owner, 2026-10-03, for leaf-off county photos):
 * 'off', 'colour' or 'trust' -- tools/stage3.js seeThroughFor. OFF until
 * workflow 14's stage 3 sweep has scored it on leaf-off county maps; this
 * line is the only thing to change to switch it on.
 */
export const SEE_THROUGH = 'off';

/** Where a lot is and what grid it is judged on -- the scorer's own numbers. */
export function prepareFrame(frame) {
  const { w, h } = gridDims(frame);
  const mpp = metresPerPixel(frame, w);
  const span = mpp * w;
  const height = Number.isFinite(frame?.height) && frame.height > 0 ? frame.height : frame.size;
  return { w, h, mpp, span, down: span * (height / frame.size), bbox: frameBbox3857(frame) };
}

/** The 3DEP point cloud over a frame, as tools/lidar-plan.js would pick it. */
export async function lidarUrlFor(bbox, footprints) {
  return planFrames(footprints?.features || [], { lot: bbox }).lot?.url || null;
}

async function footprintsCached() {
  const file = process.env.LIDAR_FOOTPRINTS_FILE;
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const got = await fetchFootprints(FOOTPRINTS);
  if (file) writeFileSync(file, JSON.stringify(got));
  return got;
}

/** A frame-sized mask of the parcel, or null (then the whole frame counts). */
export function parcelMask(parcel, frame, w, h) {
  const g = parcel?.geometry || parcel;
  if (!g || !Array.isArray(g.coordinates)) return null;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  if (!polys?.length) return null;
  const out = new Uint8Array(w * h);
  for (const rings of polys) {
    const m = rasterizePolygon(rings, w, h, (ll) => lngLatToFramePx(frame, ll, w, h));
    for (let i = 0; i < out.length; i++) if (m[i]) out[i] = 1;
  }
  return out;
}

/**
 * HOW UNSURE THE DETECTOR IS ABOUT THIS LOT, for the tracing queue (feedback
 * loop 2). The share of the lot's cells whose probability sits between 0.2 and
 * 0.8 -- neither clearly lawn nor clearly not. Inside the parcel when there
 * is one. A number to sort by, not a calibrated probability.
 */
export function uncertaintyOf(probGrey, within) {
  let n = 0;
  let unsure = 0;
  for (let i = 0; i < probGrey.length; i++) {
    if (within && !within[i]) continue;
    n++;
    const v = probGrey[i];
    if (v > 51 && v < 204) unsure++;
  }
  return n ? unsure / n : null;
}

/** THE PLAN's final answer from the pieces the Python half wrote. */
export function finishLot({ prob, canopy, roof, voidMask, height, w, h, mpp, photo = null, seeThrough = SEE_THROUGH }) {
  let mask = predictionMask(prob, w, h);
  if (!mask) throw new Error(`prob.png is ${prob?.width}x${prob?.height}, not the ${w}x${h} grid`);
  const can = canopy ? canopyMask(canopy, w, h) : null;
  /* The photo on the grid (photo.png, written by the Python half), only read
     by the 'colour' mode. */
  const rgba = photo && photo.width === w && photo.height === h ? photo.data : null;
  const bare = can ? seeThroughFor(seeThrough, can, rgba, w, h, { mpp }) : null;
  if (can) mask = stage3(mask, can, w, h, { mpp, height: height ? heightMask(height, w, h) : null, bare, ...STAGE3 }).mask;
  mask = lidarVeto(mask, roof ? canopyMask(roof, w, h) : null, voidMask ? canopyMask(voidMask, w, h) : null);
  return mask;
}

async function main() {
  const { PNG } = await import('pngjs');
  const cmd = process.argv[2];
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (cmd === 'prepare') {
    const out = prepareFrame(input.frame);
    try {
      out.lidarUrl = await lidarUrlFor(out.bbox, await footprintsCached());
    } catch (e) {
      out.lidarUrl = null;
      out.lidarError = String(e?.message || e).slice(0, 200);
    }
    process.stdout.write(JSON.stringify(out));
    return;
  }
  if (cmd === 'finish') {
    const read = (name) => {
      const f = join(input.dir, name);
      return existsSync(f) ? PNG.sync.read(readFileSync(f)) : null;
    };
    const prob = read('prob.png');
    const mask = finishLot({
      prob, canopy: read('canopy.png'), roof: read('roof.png'), voidMask: read('void.png'),
      height: read('height.png'), w: input.w, h: input.h, mpp: input.mpp,
      photo: SEE_THROUGH === 'colour' ? read('photo.png') : null,
    });
    const png = new PNG({ width: input.w, height: input.h });
    let lawn = 0;
    for (let i = 0; i < mask.length; i++) {
      const v = mask[i] ? 255 : 0;
      lawn += mask[i] ? 1 : 0;
      png.data[i * 4] = v; png.data[i * 4 + 1] = v; png.data[i * 4 + 2] = v; png.data[i * 4 + 3] = 255;
    }
    writeFileSync(join(input.dir, 'final.png'), PNG.sync.write(png));
    const grey = new Uint8Array(input.w * input.h);
    for (let i = 0; i < grey.length; i++) grey[i] = prob.data[i * 4];
    const within = parcelMask(input.parcel, input.frame, input.w, input.h);
    process.stdout.write(JSON.stringify({
      uncertainty: uncertaintyOf(grey, within),
      lawnCells: lawn,
      cells: mask.length,
    }));
    return;
  }
  throw new Error('usage: serve-alpha.mjs prepare|finish < json');
}

if (process.argv[1] && process.argv[1].endsWith('serve-alpha.mjs')) {
  main().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
}
