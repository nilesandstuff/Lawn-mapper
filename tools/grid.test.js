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
