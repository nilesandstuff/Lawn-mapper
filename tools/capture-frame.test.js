/**
 * The frame a training photograph is banked at.
 *
 * WHAT THIS GUARDS, and it is the whole of H20. The DISPLAY frame fits the
 * parcel into a fixed 640 logical pixels, so the resolution of a stored
 * photograph was a side effect of how big the lot was -- 2 cm a pixel on a
 * small garden, 25 cm on a 319 m lot. The detector wants 10 cm, so the big
 * lots were upsampled into it and handed interpolation dressed as imagery.
 * That is why the canopy model read worse on big lawns.
 *
 * `captureFrame` pins the resolution instead and lets the size vary. Three
 * properties have to hold or it is not an improvement:
 *
 *   1. NEVER WORSE than the display frame already managed. A small lot is
 *      already finer than 10 cm for free, and pinning everything to the target
 *      would throw that away permanently -- the photograph is the archive, and
 *      the imagery gets reflown.
 *   2. STILL COVERS THE WHOLE LOT. Raising the resolution without raising the
 *      size would crop the back garden off, which is a far worse bug than
 *      being blurry and much harder to notice.
 *   3. WITHIN MAPBOX'S CAP of 1280 logical, and where the target cannot be
 *      reached inside it, `capped` says so rather than the caller assuming it
 *      got what it asked for.
 */

import assert from 'node:assert/strict';
import { captureFrame, groundPerPixel, groundAcross, TARGET_GROUND_M, MAX_LOGICAL } from '../worker/src/imagery.js';
const EQ = 40075016.686;
const display = (across, lat = 42.9, size = 640) => ({
  lng: -85, lat, size,
  zoom: Math.log2((EQ * Math.cos(lat * Math.PI / 180) * size) / (512 * across)),
});
for (const across of [12, 25, 50, 108, 122, 171, 172, 197, 231, 256, 319, 500]) {
  const d = display(across);
  const c = captureFrame(d);
  const now = groundPerPixel(d), got = c.groundM;
  assert.ok(got <= now + 1e-9, `${across} m got WORSE: ${now} -> ${got}`);
  assert.ok(Math.abs(groundAcross(c.frame) - across) < across * 0.01, `${across} m: coverage drifted`);
  assert.ok(c.frame.size <= MAX_LOGICAL, `${across} m: over Mapbox's cap`);
  if (!c.capped) assert.ok(got <= TARGET_GROUND_M + 1e-6, `${across} m: uncapped but coarser than target`);
  if (c.capped) assert.equal(c.frame.size, MAX_LOGICAL, `${across} m: capped but not at the cap`);
}
// latitude must not break coverage
for (const lat of [25.8, 42.9, 61.2]) {
  const d = display(197, lat);
  const c = captureFrame(d);
  assert.ok(Math.abs(groundAcross(c.frame) - 197) < 2, `lat ${lat}: coverage drifted`);
  assert.ok(c.groundM <= TARGET_GROUND_M + 1e-6, `lat ${lat}: coarser than target`);
}
console.log('capture frame: ok');
