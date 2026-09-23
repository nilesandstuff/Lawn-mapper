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
import {
  captureFrame, capturePlan, groundPerPixel, groundAcross,
  TARGET_GROUND_M, MAX_LOGICAL, MAX_TILES_ACROSS,
} from '../worker/src/imagery.js';
import { lngLatToWorld } from '../public/lib/mercator.js';
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
  /* The ideal frame may be wider than ONE request allows -- that is what
     tiling is for, and capturePlan splits it. What it must not exceed is the
     whole grid's worth, which is the real ceiling. */
  assert.ok(c.frame.size <= MAX_LOGICAL * MAX_TILES_ACROSS,
    `${across} m: past what even a full grid of tiles could carry`);
  if (!c.capped) assert.ok(got <= TARGET_GROUND_M + 1e-6, `${across} m: uncapped but coarser than target`);
  if (c.capped) {
    assert.equal(c.frame.size, MAX_LOGICAL * MAX_TILES_ACROSS,
      `${across} m: capped but not at the grid's ceiling`);
  }
}
// latitude must not break coverage
for (const lat of [25.8, 42.9, 61.2]) {
  const d = display(197, lat);
  const c = captureFrame(d);
  assert.ok(Math.abs(groundAcross(c.frame) - 197) < 2, `lat ${lat}: coverage drifted`);
  assert.ok(c.groundM <= TARGET_GROUND_M + 1e-6, `lat ${lat}: coarser than target`);
}
/* ----------------------------------------------------------- the tiling */

{
  /*
   * A SEAM IS THE BUG THAT WOULD NOT SHOW UP UNTIL IT HAD POISONED THE
   * TRAINING DATA. If two tiles overlap or leave a gap, the stitched
   * photograph has a line through it -- and a line running across a lawn is a
   * feature the detector would happily learn, on every big lot, for ever.
   *
   * So the tiles are checked for abutting exactly, in world pixels, which is
   * the space the split is done in. Degrees would drift with latitude.
   */
  for (const across of [300, 400, 500]) {
    for (const lat of [25.8, 42.9, 61.2]) {
      const plan = capturePlan(display(across, lat));
      assert.ok(plan.tiles.length > 1, `${across} m at lat ${lat} should need tiling`);
      assert.equal(plan.tiles.length, plan.cols * plan.rows);
      assert.ok(plan.cols <= MAX_TILES_ACROSS, 'more tiles than the limit allows');

      for (const t of plan.tiles) {
        assert.ok(t.frame.size <= MAX_LOGICAL, 'a tile is over Mapbox\'s cap');
        assert.equal(t.frame.zoom, plan.frame.zoom, 'a tile is at a different zoom');
      }

      /* Neighbours must be exactly one tile width apart in world pixels. */
      const at = (c, r) => plan.tiles.find((t) => t.col === c && t.row === r);
      for (let r = 0; r < plan.rows; r++) {
        for (let c = 0; c + 1 < plan.cols; c++) {
          const a = lngLatToWorld([at(c, r).frame.lng, at(c, r).frame.lat], plan.frame.zoom);
          const b = lngLatToWorld([at(c + 1, r).frame.lng, at(c + 1, r).frame.lat], plan.frame.zoom);
          assert.ok(Math.abs((b[0] - a[0]) - plan.tileSize) < 0.01,
            `${across} m lat ${lat}: columns ${c}/${c + 1} are ${(b[0] - a[0]).toFixed(2)} apart, want ${plan.tileSize}`);
          assert.ok(Math.abs(b[1] - a[1]) < 0.01, 'neighbouring columns drifted vertically');
        }
      }
      for (let c = 0; c < plan.cols; c++) {
        for (let r = 0; r + 1 < plan.rows; r++) {
          const a = lngLatToWorld([at(c, r).frame.lng, at(c, r).frame.lat], plan.frame.zoom);
          const b = lngLatToWorld([at(c, r + 1).frame.lng, at(c, r + 1).frame.lat], plan.frame.zoom);
          assert.ok(Math.abs((b[1] - a[1]) - plan.tileSize) < 0.01,
            `${across} m lat ${lat}: rows ${r}/${r + 1} are ${(b[1] - a[1]).toFixed(2)} apart, want ${plan.tileSize}`);
        }
      }

      /* And the stitched whole still covers the lot, at the target or better. */
      assert.ok(groundAcross(plan.frame) >= across - 1,
        `${across} m at lat ${lat}: the stitch does not cover the lot`);
      assert.ok(plan.groundM <= TARGET_GROUND_M + 1e-6,
        `${across} m at lat ${lat}: tiled and still coarser than the target`);
    }
  }

  /* A lot that fits in one request is still a list of one, so callers have a
     single path rather than two. */
  const small = capturePlan(display(100));
  assert.equal(small.tiles.length, 1);
  assert.equal(small.tiles[0].frame.size, small.frame.size);
}

console.log('capture frame: ok');
