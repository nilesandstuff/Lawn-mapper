/**
 * THE FINISHING STEPS, shared by the model server and the page (2026-10-24).
 *
 * The live model's answer is its decoder's picture (prob.png: grey, 255 =
 * certainly lawn) cut at 50%, then stage 3 over the tree model's canopy
 * (public/lib/stage3.js), then the lidar veto (roofs and voids). The server
 * runs this (tools/serve-alpha.mjs finish) and sends the result as the mask.
 *
 * The page's confidence slider (owner, 2026-10-24: "a confidence (or
 * sensitivity) adjustment that adjusts what confidence gets traced, that a
 * user could tweak without running a new detection") runs the SAME steps on
 * the same pictures with the cut moved, so 50% on the slider is exactly the
 * server's mask and any other setting differs from it only by the cut.
 *
 * Moved here from tools/train-detector.js and tools/serve-alpha.mjs, which
 * re-export them. No imports beyond public/lib: it runs in the browser.
 */

import { stage3, seeThroughFor } from './stage3.js';

/* THE PLAN's stage 3 (H39, H60): span 8 m, reach 1 m, bridge over 180°. */
export const STAGE3 = { spanM: 8, reachM: 1, minRing: 0.5 };

/*
 * SEE-THROUGH CANOPY (owner, 2026-10-03, for leaf-off county photos):
 * 'off', 'colour' or 'trust' -- stage3.js seeThroughFor. OFF: H69 measured
 * 'colour' as no gain overall and 'trust' as worse (inferred 26 -> 43%).
 * This line is the only thing to change to switch one on.
 */
export const SEE_THROUGH = 'off';

/** The decoder's cut, 0-255: 128 is 50%. */
export const LAWN_THRESHOLD = 128;

/**
 * A decoder's answer, read back off its picture as a mask on the grid.
 *
 * Grey, 255 meaning certainly lawn, cut at the middle -- the same 0.5 the
 * head's own answers are cut at in runFold. `threshold` (0-255) moves the
 * cut for the page's confidence slider; 128 everywhere else. Null when the picture is not
 * the size of the grid it claims to answer, because a resample here would
 * hide exactly the registration bug the Python side's tests exist to catch.
 */
export function predictionMask(png, G, GH = G, threshold = LAWN_THRESHOLD) {
  if (!png || png.width !== G || png.height !== GH) return null;
  const out = new Uint8Array(G * GH);
  for (let i = 0; i < out.length; i++) out[i] = png.data[i * 4] >= threshold ? 1 : 0;
  return out;
}

/**
 * The tree model's mask, written at the frame's own pixels, brought to the
 * scoring grid by nearest neighbour. Both cover the same frame, so a cell
 * reads the mask pixel under its top-left corner; at 15 cm cells over a 10 cm
 * mask that is never more than a cell out. Null for a picture with no pixels.
 */
export function canopyMask(png, G, GH = G) {
  if (!png || !png.width || !png.height) return null;
  const out = new Uint8Array(G * GH);
  for (let y = 0; y < GH; y++) {
    const sy = Math.min(png.height - 1, Math.floor((y * png.height) / GH));
    for (let x = 0; x < G; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / G));
      out[y * G + x] = png.data[(sy * png.width + sx) * 4] >= 128 ? 1 : 0;
    }
  }
  return out;
}

/**
 * The lidar's height above ground, from the grey PNG tools/lidar_frame.py
 * writes (a tenth of a metre a level, on its own 2 m grid), sampled nearest
 * onto the scoring grid as metres. Nearest for the same reason as the canopy
 * mask: a 2 m reading copied into the 15 cm cells under it is the reading;
 * an average would invent heights between two trees.
 */
export function greyMask(png, G, GH = G) {
  /* A grey picture (one byte a pixel) sampled nearest onto the grid, as the
     masks are; 0 stays 0, "nothing there". */
  if (!png || !png.width || !png.height) return null;
  const out = new Uint8Array(G * GH);
  for (let y = 0; y < GH; y++) {
    const sy = Math.min(png.height - 1, Math.floor((y * png.height) / GH));
    for (let x = 0; x < G; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / G));
      out[y * G + x] = png.data[(sy * png.width + sx) * 4];
    }
  }
  return out;
}

export function heightMask(png, G, GH = G) {
  if (!png || !png.width || !png.height) return null;
  const out = new Float32Array(G * GH);
  for (let y = 0; y < GH; y++) {
    const sy = Math.min(png.height - 1, Math.floor((y * png.height) / GH));
    for (let x = 0; x < G; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / G));
      out[y * G + x] = png.data[(sy * png.width + sx) * 4] / 10;
    }
  }
  return out;
}

/**
 * THE LIDAR VETO (H38): a cell the point cloud calls roof or void is not
 * lawn, whatever stage 1 and stage 3 said. Returns a copy; a missing mask
 * vetoes nothing.
 */
export function lidarVeto(mask, roof, voidMask) {
  if (!roof && !voidMask) return mask;
  const out = Uint8Array.from(mask);
  for (let i = 0; i < out.length; i++) {
    if ((roof && roof[i]) || (voidMask && voidMask[i])) out[i] = 0;
  }
  return out;
}

/**
 * THE PLAN's final answer from the pieces the model server writes: the
 * decoder's picture cut at `threshold`, stage 3 over the canopy, the lidar
 * veto. Pictures are {width, height, data} with RGBA data (pngjs or a
 * canvas's ImageData); roof, void, height and photo may be null.
 */
export function finishLot({
  prob, canopy, roof, voidMask, height, w, h, mpp, photo = null, seeThrough = SEE_THROUGH, threshold = LAWN_THRESHOLD,
}) {
  let mask = predictionMask(prob, w, h, threshold);
  if (!mask) throw new Error(`prob.png is ${prob?.width}x${prob?.height}, not the ${w}x${h} grid`);
  const can = canopy ? canopyMask(canopy, w, h) : null;
  /* The photo on the grid, only read by the 'colour' mode. */
  const rgba = photo && photo.width === w && photo.height === h ? photo.data : null;
  const bare = can ? seeThroughFor(seeThrough, can, rgba, w, h, { mpp }) : null;
  if (can) mask = stage3(mask, can, w, h, { mpp, height: height ? heightMask(height, w, h) : null, bare, ...STAGE3 }).mask;
  mask = lidarVeto(mask, roof ? canopyMask(roof, w, h) : null, voidMask ? canopyMask(voidMask, w, h) : null);
  return mask;
}

/** A 0/1 mask as a picture (white lawn, opaque), the shape the page traces. */
export function maskPicture(mask, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i] ? 255 : 0;
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
