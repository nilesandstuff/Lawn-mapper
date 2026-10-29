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

import { gridDims } from './train-detector.js';
import { finishLot, STAGE3, SEE_THROUGH, seeThroughReadsPhoto, photoLooksLeafOff } from '../public/lib/finish.js';
import { frameBbox3857 } from '../worker/src/imagery.js';
import { metresPerPixel, lngLatToFramePx } from '../public/lib/mercator.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { planFrames } from './lidar-plan.js';
import { newestFor } from './lidar-newest.js';
import { FOOTPRINTS, fetchFootprints } from './lidar-cover.js';

/* THE PLAN's stage 3 settings and the see-through switch live with the
   finishing steps in public/lib/finish.js, shared with the page. */
export { STAGE3, SEE_THROUGH };

/** Where a lot is and what grid it is judged on -- the scorer's own numbers. */
/*
 * THE SERVING GRID (owner, 2026-10-24: "That's detail being thrown away").
 * Training caps a lot at GRID_MAX (1024) cells across because every lot is
 * held in memory at once, so the condo's 450 m frame is drawn on 44 cm cells
 * although the photo is read at 10 cm and the edge refiner was trained at
 * 15 cm on every lot under 154 m. The server reads one lot at a time and need
 * not share that cap: a press may ask for up to SERVE_GRID_LIMIT cells
 * (`gridMax`), and SERVE_GRID_MAX is what it gets unasked: 3072 cells, 15 cm
 * up to a 460 m frame (S64, H124).
 */
/* 3072 since 2026-10-25 (H124: on the 10 approved lots the old cap coarsened,
   level or better on every one, never worse, the same GPU time). */
export const SERVE_GRID_MAX = 3072;
export const SERVE_GRID_LIMIT = 4096;
export function serveCap(asked) {
  const n = Number(asked);
  if (!Number.isFinite(n) || n <= 0) return SERVE_GRID_MAX;
  return Math.min(SERVE_GRID_LIMIT, Math.max(1024, Math.round(n)));
}

export function prepareFrame(frame, { gridMax } = {}) {
  const { w, h } = gridDims(frame, undefined, serveCap(gridMax));
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

/** THE PLAN's final answer from the pieces the Python half wrote (public/lib/finish.js). */
export { finishLot };

async function main() {
  const { PNG } = await import('pngjs');
  const cmd = process.argv[2];
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (cmd === 'prepare') {
    const out = prepareFrame(input.frame, { gridMax: input.gridMax });
    try {
      const fc = await footprintsCached();
      out.lidarUrl = await lidarUrlFor(out.bbox, fc);
      /* THE NEWEST FLIGHT, BY USGS'S OWN DATES (H96), with its epoch for the
         datum move (H95) -- as training plans it (tools/lidar-newest.js).
         When that flight is only USGS's tiles, the newest octree is read now
         and the tiles are fetched onto the server's volume for next time
         (tools/modal_serve.py). USGS not answering leaves the name's pick. */
      const e = await newestFor(out.bbox, fc).catch(() => null);
      if (e?.source === 'tiles') {
        out.lidarTiles = e.tiles;
        out.lidarTilesEpoch = e.epoch;
        out.lidarTilesMb = e.mb ?? null; // the server fetches them before the first read when modest (alpha_sources.py)
        out.lidarUrl = e.octreeUrl || out.lidarUrl;
        out.lidarEpoch = e.octreeEpoch ?? null;
      } else if (e?.url) {
        out.lidarUrl = e.url;
        out.lidarEpoch = e.epoch ?? null;
      }
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
    const canopy = read('canopy.png');
    const photo = seeThroughReadsPhoto() ? read('photo.png') : null;
    /* H127: whether the photo looks leaf-off, sent with the lot so the
       page's confidence slider re-cuts the same way without the photo. */
    const leafOff = photoLooksLeafOff({ canopy, photo, w: input.w, h: input.h, mpp: input.mpp });
    const mask = finishLot({
      prob, canopy, roof: read('roof.png'), voidMask: read('void.png'),
      height: read('height.png'), w: input.w, h: input.h, mpp: input.mpp,
      photo, leafOff,
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
      leafOff,
    }));
    return;
  }
  throw new Error('usage: serve-alpha.mjs prepare|finish < json');
}

if (process.argv[1] && process.argv[1].endsWith('serve-alpha.mjs')) {
  main().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
}
