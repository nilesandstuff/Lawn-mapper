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
  captureFrame, capturePlan, detectionPlan, groundPerPixel, groundAcross,
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

/* ------------------------------------------------- the live detection */
/*
 * THE SAME RULE ON THE PATH THAT MEASURES REAL LAWNS. SAM reads its input at
 * a fixed 1008 px, so the display frame -- the parcel in 1280 px -- reaches
 * it at (metres across / 1008) a pixel: 6 cm on a 60 m lot, 17 cm on a 172 m
 * one. detectionPlan cuts anything past 10 cm into pieces at the target.
 */
{
  const INPUT = 1008;

  /* A lot the model already reads at 10 cm or better is sent untouched:
     one picture, the display frame, byte for byte what was sent before. */
  for (const across of [25, 60, 100]) {
    const d = display(across);
    const plan = detectionPlan('mapbox', d, { inputPx: INPUT });
    assert.equal(plan.tiles.length, 1, `${across} m should be one picture`);
    assert.deepEqual(plan.frame, d, `${across} m: the display frame was altered`);
    assert.ok(plan.groundM <= TARGET_GROUND_M + 1e-6,
      `${across} m: one picture, yet coarser than the target (${plan.groundM})`);
    assert.equal(plan.capped, false);
  }

  /* Past the target it is cut, and every piece is at most the model's input
     size at EXACTLY 10 cm a pixel -- a lot that only just needed cutting is
     two pieces of 430 px, not two of 1008 at 5 cm (H21: finer pieces over-
     called) -- abutting in world pixels like the banked tiles. */
  for (const across of [101, 130, 172, 197]) {
    for (const lat of [25.8, 42.9, 61.2]) {
      const plan = detectionPlan('mapbox', display(across, lat), { inputPx: INPUT, maxAcross: 2 });
      assert.equal(plan.cols, 2, `${across} m at lat ${lat}: should be 2 across`);
      assert.equal(plan.tiles.length, 4);
      assert.equal(plan.capped, false, `${across} m: should fit the piece budget`);
      assert.ok(Math.abs(plan.groundM - TARGET_GROUND_M) < 0.0015,
        `${across} m at lat ${lat}: pieces are ${plan.groundM} m/px, want the target`);
      assert.ok(groundAcross(plan.frame) >= across - 1, `${across} m: the pieces do not cover the lot`);
      for (const t of plan.tiles) {
        assert.ok(t.frame.size * 2 <= INPUT, 'a piece is bigger than the model\'s input');
        assert.equal(t.frame.zoom, plan.frame.zoom);
      }
      const at = (c, r) => plan.tiles.find((t) => t.col === c && t.row === r);
      const a = lngLatToWorld([at(0, 0).frame.lng, at(0, 0).frame.lat], plan.frame.zoom);
      const b = lngLatToWorld([at(1, 0).frame.lng, at(1, 0).frame.lat], plan.frame.zoom);
      const c = lngLatToWorld([at(0, 1).frame.lng, at(0, 1).frame.lat], plan.frame.zoom);
      assert.ok(Math.abs((b[0] - a[0]) - plan.tileSize) < 0.01, `${across} m: columns do not abut`);
      assert.ok(Math.abs((c[1] - a[1]) - plan.tileHeight) < 0.01, `${across} m: rows do not abut`);
    }
  }

  /* Past the piece budget the pieces get coarser, and the plan says so
     rather than pretending: a 319 m lot in a 2 x 2 is about 16 cm. */
  const big = detectionPlan('mapbox', display(319), { inputPx: INPUT, maxAcross: 2 });
  assert.equal(big.tiles.length, 4);
  assert.equal(big.capped, true, 'a lot past the budget must say it was capped');
  assert.equal(big.wanted, 4, 'and say what it would have taken');
  assert.ok(big.groundM > TARGET_GROUND_M && big.groundM < 0.17, `capped resolution ${big.groundM}`);
  assert.ok(groundAcross(big.frame) >= 318, 'capped, but still covering the lot');

  /* With the budget raised, the same lot reaches the target. */
  const raised = detectionPlan('mapbox', display(319), { inputPx: INPUT, maxAcross: 4 });
  assert.equal(raised.cols, 4);
  assert.equal(raised.capped, false);
  assert.ok(Math.abs(raised.groundM - TARGET_GROUND_M) < 0.0015, `raised budget: ${raised.groundM}`);

  /* A RECTANGULAR frame is cut per side. A lot 172 m across and 60 m deep
     is two pieces across and one down, and the stitched frame keeps the
     shape. */
  const wide = detectionPlan('mapbox', { ...display(172), height: 223 }, { inputPx: INPUT, maxAcross: 4 });
  assert.equal(wide.cols, 2, `wide lot: ${wide.cols} across`);
  assert.equal(wide.rows, 1, `wide lot: ${wide.rows} down`);
  assert.ok(Math.abs(wide.frame.height / wide.frame.size - 223 / 640) < 0.01, 'the stitch lost its shape');
  assert.ok(Math.abs(wide.groundM - TARGET_GROUND_M) < 0.0015);

  /* PIECES OFF MEANS THE PICTURE AS ASKED. With maxAcross 1 a 300 m lot used
     to come back as one "piece" of 1500 logical px at the target -- which
     Mapbox refuses -- rather than the display frame the app asked for. */
  const off = detectionPlan('mapbox', display(300), { inputPx: INPUT, maxAcross: 1 });
  assert.equal(off.tiles.length, 1);
  assert.equal(off.capped, false);
  assert.equal(off.frame.size, 640, `pieces off: asked Mapbox for ${off.frame.size} logical px`);
  assert.deepEqual(off.frame, display(300), 'pieces off must be the display frame itself');
  /* And with pieces on, no piece is ever bigger than Mapbox serves. */
  const huge = detectionPlan('mapbox', display(700), { inputPx: INPUT, maxAcross: 2 });
  assert.equal(huge.capped, true);
  for (const t of huge.tiles) {
    assert.ok(t.frame.size <= 1280 && t.frame.height <= 1280,
      `a piece of ${t.frame.size}x${t.frame.height} logical px is more than Mapbox serves`);
  }

  /* NAIP is never cut: it has no 10 cm to give, and comes back as a plan of
     one in the same shape. */
  const naipPlan = detectionPlan('naip', display(197), { inputPx: INPUT });
  assert.equal(naipPlan.tiles.length, 1, 'naip should never be tiled');
  assert.equal(naipPlan.cols, 1);
  /* A look-only source detects on the default, which IS cut -- Esri, and
     Google since it became view only (2026-10-01). */
  for (const provider of ['esri', 'google']) {
    assert.equal(detectionPlan(provider, display(197), { inputPx: INPUT }).tiles.length, 4,
      `${provider} is view only, so it detects on Mapbox`);
  }
}

/* --------------------------------------------- rectangular frames */
/*
 * A frame cropped to a long thin parcel stays long and thin through the
 * capture and the tiling, at the same resolution on both axes. Growing it
 * back into a square would put the neighbours back in.
 */
{
  const thin = { ...display(300), height: 200 };   // 300 m across, ~94 m down
  const c = captureFrame(thin);
  assert.ok(Math.abs(c.frame.height / c.frame.size - 200 / 640) < 0.01, 'captureFrame lost the shape');
  assert.ok(c.groundM <= TARGET_GROUND_M + 1e-6, `thin lot: ${c.groundM}`);
  assert.ok(Math.abs(groundAcross(c.frame) - 300) < 3, 'thin lot: width drifted');

  const plan = capturePlan(thin);
  /* 300 m at 10 cm is 1500 logical px, two requests of Mapbox's 1280. */
  assert.equal(plan.cols, 2, `thin lot: ${plan.cols} across`);
  assert.equal(plan.rows, 1, `thin lot: ${plan.rows} down`);
  assert.equal(plan.frame.size, plan.tileSize * plan.cols);
  assert.equal(plan.frame.height, plan.tileHeight * plan.rows);
  for (const t of plan.tiles) {
    assert.ok(t.frame.size <= MAX_LOGICAL && t.frame.height <= MAX_LOGICAL, 'a tile is over the cap');
  }
  const at = (col) => plan.tiles.find((t) => t.col === col && t.row === 0);
  const a = lngLatToWorld([at(0).frame.lng, at(0).frame.lat], plan.frame.zoom);
  const b = lngLatToWorld([at(1).frame.lng, at(1).frame.lat], plan.frame.zoom);
  assert.ok(Math.abs((b[0] - a[0]) - plan.tileSize) < 0.01, 'thin lot: columns do not abut');
}

console.log('capture frame: ok');
