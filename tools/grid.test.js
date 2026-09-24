/**
 * The scoring grid follows metres.
 *
 * WHAT THIS GUARDS. 512 cells over the whole frame was 12 cm a cell on a 60 m
 * lot and 62 cm on a 319 m one: the head's texture window is 0.25 m, so on a
 * big lot the feature measured nothing, and the outline was quantised to a
 * cell a person could see. gridFor gives each lawn ceil(across / 0.15) cells
 * between a floor of 512 and a cap of 1024, and a fold has to cope with lawns
 * on DIFFERENT grids -- sampling, building rows and answering the held-out
 * lawn each on its own -- without reading one lawn's cells with another's
 * width, which would not fail, only mis-register every feature.
 *
 *   node tools/grid.test.js
 */

import assert from 'node:assert/strict';
import { gridFor, runFold, GRID, GRID_MAX, CELL_M } from './train-detector.js';
import { imageFeatures, FEATURE_COUNT } from '../public/lib/features.js';

const EQ = 40075016.686;
const frameAcross = (across, lat = 42.9, size = 640) => ({
  lng: -85, lat, size,
  zoom: Math.log2((EQ * Math.cos(lat * Math.PI / 180) * size) / (512 * across)),
});

/* ------------------------------------------------------------ gridFor */
{
  /* Under the floor, nothing moves: these lots are exactly as they were. */
  for (const m of [12, 25, 50, 76]) {
    assert.equal(gridFor(frameAcross(m)), GRID, `${m} m should stay at the floor`);
  }
  /* Past it the cell is 15 cm. */
  for (const m of [100, 122, 150]) {
    const g = gridFor(frameAcross(m));
    assert.equal(g, Math.ceil(m / CELL_M), `${m} m`);
    assert.ok(m / g <= CELL_M + 1e-9, `${m} m: ${m / g} m a cell is coarser than the cell size`);
  }
  /* And the cap holds, coarser than the cell size and knowable as such. */
  for (const m of [172, 231, 319]) {
    const g = gridFor(frameAcross(m));
    assert.equal(g, GRID_MAX, `${m} m should hit the cap`);
    assert.ok(m / g > CELL_M, `${m} m at the cap is ${m / g} a cell, which should be coarser than the target`);
    assert.ok(m / g < 2 * (m / GRID), 'but finer than 512 was');
  }
  /* Latitude must not move it: the lot is the same size at any latitude. */
  assert.equal(gridFor(frameAcross(122, 25.8)), gridFor(frameAcross(122, 61.2)));
  /* Nonsense falls to the floor rather than to NaN. */
  assert.equal(gridFor({ lng: 0, lat: 0, zoom: NaN, size: 640 }), GRID);
}

/* --------------------------------------------- a fold across two grids */
{
  const MPP = { mpp: 0.1 };
  const makeLawn = (G, seedColour, lawnRows) => {
    const px = new Uint8Array(G * G * 4);
    const truth = new Uint8Array(G * G);
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const i = y * G + x;
        const grass = y < lawnRows;
        truth[i] = grass ? 1 : 0;
        const [r, g, b] = grass ? [60, 130 + seedColour, 55] : [140, 138, 135];
        px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
      }
    }
    return {
      grid: G, cheap: imageFeatures(px, G, G, MPP), width: FEATURE_COUNT,
      truth, within: null, detected: null, mpp: 0.1,
    };
  };

  /* Three lawns on 48 cells, two on 96: the same picture at two grids. */
  const lawns = [
    makeLawn(48, 0, 24), makeLawn(96, 6, 42), makeLawn(48, -6, 27),
    makeLawn(96, 3, 45), makeLawn(48, -3, 25),
  ];

  for (const held of [0, 1]) {
    const fold = runFold(lawns, held, { perLawn: 900, grid: 999 /* must not be used */ });
    const g = lawns[held].grid;
    assert.equal(fold.trainedOn, lawns.length - 1);
    assert.equal(fold.predicted.length, g * g,
      `held-out lawn on ${g} cells answered with ${fold.predicted.length} cells`);
    /* Colour-decidable, so a fold reading the right cells scores well; one
       reading lawn A's pixels with lawn B's width would not. */
    assert.ok(fold.mine.errorPct < 15,
      `held ${held} on ${g} cells: ${fold.mine.errorPct}% wrong`);
    /* The answer is lawn on top and not below, at THIS lawn's row count. */
    const rows = held === 0 ? 24 : 42;
    let top = 0, bottom = 0;
    for (let y = 0; y < g; y++) {
      for (let x = 0; x < g; x++) {
        if (fold.predicted[y * g + x]) { if (y < rows) top++; else bottom++; }
      }
    }
    assert.ok(top > 0.9 * rows * g, `held ${held}: only ${top} of ${rows * g} lawn cells found`);
    assert.ok(bottom < 0.1 * (g - rows) * g, `held ${held}: ${bottom} cells of ground called lawn`);
  }
}

console.log('grid: ok');

/* ------------------------------------------ rectangular frames and grids */
{
  const { gridDims } = await import('./train-detector.js');
  /* A frame twice as wide as it is tall: the rule lands on the longer side
     and the shorter one follows at the same cells per metre. */
  const wide = { ...frameAcross(150), height: 320 };
  const d = gridDims(wide);
  assert.equal(d.w, 1000, `wide: ${d.w} across`);
  assert.equal(d.h, 500, `wide: ${d.h} down`);
  /* A tall one: the longer side is the height. */
  const tall = { ...frameAcross(75), height: 1280 };   // 75 m across, 150 m down
  const t = gridDims(tall);
  assert.equal(t.h, 1000, `tall: ${t.h} down`);
  assert.equal(t.w, 500, `tall: ${t.w} across`);
  /* Under the floor the square rule still holds on the longer side. */
  const small = gridDims({ ...frameAcross(40), height: 320 });
  assert.equal(small.w, GRID);
  assert.equal(small.h, GRID / 2);
  /* Fixed mode: 512 on the longer side, the other by aspect. */
  const fixed = gridDims(wide, 0);
  assert.equal(fixed.w, GRID);
  assert.equal(fixed.h, GRID / 2);
}

{
  /* A fold over lawns whose grids are rectangles answers each on its own
     rectangle, and the right cells. */
  const MPP = { mpp: 0.1 };
  const makeLawn = (W, H, seedColour, lawnRows) => {
    const px = new Uint8Array(W * H * 4);
    const truth = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const grass = y < lawnRows;
        truth[i] = grass ? 1 : 0;
        const [r, g, b] = grass ? [60, 130 + seedColour, 55] : [140, 138, 135];
        px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
      }
    }
    return {
      grid: W, gridH: H, cheap: imageFeatures(px, W, H, MPP), width: FEATURE_COUNT,
      truth, within: null, detected: null, mpp: 0.1,
    };
  };
  const lawns = [
    makeLawn(64, 32, 0, 14), makeLawn(32, 64, 6, 30), makeLawn(64, 32, -6, 18),
    makeLawn(48, 96, 3, 40), makeLawn(96, 48, -3, 20),
  ];
  for (const held of [0, 1, 3]) {
    const fold = runFold(lawns, held, { perLawn: 900, grid: 999 });
    const L = lawns[held];
    assert.equal(fold.predicted.length, L.grid * L.gridH,
      `held ${held}: answered ${fold.predicted.length} cells for a ${L.grid}x${L.gridH} lawn`);
    assert.ok(fold.mine.errorPct < 15, `held ${held}: ${fold.mine.errorPct}% wrong`);
  }
}

console.log('grid: ok (rectangles)');

/* ------------------------------------------ the squeeze keeps the cover */
{
  /*
   * A grid that runs past the photograph -- a windowed read, or a rectangle
   * padded to a square -- says so with coverX/coverY, and sampleAt divides
   * by them. The squeeze to 32 numbers dropped them until 2026-09-24, so
   * every head row on such a grid read features stretched by the cover: a
   * tall lot padded to a square had its whole grid read as if it were the
   * photograph, and the eye alone scored 80% wrong. See H25.
   */
  const { shrink } = await import('./train-detector.js');
  const { sampleAt } = await import('./backbone.js');
  const gridW = 8, gridH = 8, dim = 64;
  const data = new Float32Array(gridW * gridH * dim);
  /* Every patch's features are its own column number, so a read that lands
     on the wrong patch reads a different number. */
  for (let p = 0; p < gridW * gridH; p++) {
    for (let d = 0; d < dim; d++) data[p * dim + d] = (p % gridW) * (d % 2 ? 1 : -1);
  }
  const full = { data, gridW, gridH, dim, coverX: 2, coverY: 1, windows: 1, mpp: 0.1 };
  const small = shrink(full, 16);
  assert.equal(small.coverX, 2, 'the squeeze must keep coverX');
  assert.equal(small.coverY, 1, 'the squeeze must keep coverY');
  assert.equal(small.dim, 16);
  /* And with the cover kept, a photograph 40 cells wide reads its last
     column from patch 3 (the photo is the left half of the grid), not
     from patch 7. Compare the squeezed read against a read of the full
     grid at the same place, projected the same way. */
  const a = new Float32Array(16), b = new Float32Array(16);
  sampleAt(small, 39, 0, 40, a, 0, 40);
  const smallNoCover = { ...small, coverX: 1 };
  sampleAt(smallNoCover, 39, 0, 40, b, 0, 40);
  assert.notDeepEqual([...a], [...b], 'dropping the cover must change what is read');
  /* Cell 35 of 40 sits exactly on patch 3's centre through cover 2
     ((35 / 40) * 8 / 2 - 0.5 = 3), and on the same patch of a grid cropped
     to the photo's own four columns with cover 1. Both must read patch 3. */
  const fullSmall = shrink({ ...full, gridW: 4, coverX: 1, data: data.filter((_, i) => ((i / dim | 0) % gridW) < 4) }, 16);
  const a35 = new Float32Array(16), c = new Float32Array(16);
  sampleAt(small, 35, 0, 40, a35, 0, 40);
  sampleAt(fullSmall, 35, 0, 40, c, 0, 40);
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(a35[i] - c[i]) < 1e-5, `with the cover kept, cell 35 reads the photo's own patch 3 (${a35[i]} vs ${c[i]})`);
  }
}

console.log('grid: ok (cover kept through the squeeze)');
