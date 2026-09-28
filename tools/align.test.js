import assert from 'node:assert/strict';
import { alignImages, movedCorners } from '../public/lib/align.js';

/* A synthetic neighbourhood: a few rectangles ("roofs", "a road") on grass. */
const w = 96, h = 96;
function scene(tx = 0, ty = 0) {
  const g = new Float32Array(w * h).fill(90);
  const rect = (x0, y0, x1, y1, v) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const X = x + tx, Y = y + ty;
      if (X >= 0 && X < w && Y >= 0 && Y < h) g[Y * w + X] = v;
    }
  };
  rect(10, 12, 34, 30, 200); rect(55, 20, 80, 44, 170); rect(0, 60, 96, 68, 140);
  rect(20, 72, 40, 90, 220); rect(62, 74, 70, 94, 30);
  return g;
}

// NAIP drawn 3 px right and 2 px up of the photograph: move it back.
{
  const r = alignImages(scene(), scene(3, -2), w, h, { maxShift: 6 });
  assert.equal(r.moved, true);
  assert.ok(Math.abs(r.dx + 3) < 0.6, `dx ${r.dx}`);
  assert.ok(Math.abs(r.dy - 2) < 0.6, `dy ${r.dy}`);
  assert.equal(r.scale, 1);
  console.log('PASS  a 3 px / 2 px offset is found and undone');
}

// Already lined up: nothing moves.
{
  const r = alignImages(scene(), scene(), w, h, { maxShift: 6 });
  assert.equal(r.moved, false);
  assert.equal(r.dx, 0); assert.equal(r.dy, 0);
  console.log('PASS  a lined-up pair is left alone');
}

// Featureless ground: no confident answer, nothing moves.
{
  const flat = new Float32Array(w * h).fill(100);
  const r = alignImages(flat, flat, w, h, { maxShift: 6 });
  assert.equal(r.moved, false);
  console.log('PASS  nothing to match means no move');
}

// Corners: one metre east moves every corner the same way; scale 1 keeps size.
{
  const c = [[-97, 46.9], [-96.999, 46.9], [-96.999, 46.899], [-97, 46.899]];
  const m = movedCorners(c, 1, 0, 1);
  const dLng = m[0][0] - c[0][0];
  const metres = dLng * Math.PI / 180 * 6378137 * Math.cos(46.9 * Math.PI / 180);
  assert.ok(Math.abs(metres - 1) < 0.01, `moved ${metres} m`);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs((m[i][0] - c[i][0]) - dLng) < 1e-12);
  console.log('PASS  a metre east is a metre on the ground');
}

// NAIP 3% too big about the centre: the scale is found.
{
  const big = new Float32Array(w * h);
  const ref = scene();
  const c = (w - 1) / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const qx = Math.round(c + (x - c) / 1.03), qy = Math.round(c + (y - c) / 1.03);
    big[y * w + x] = ref[qy * w + qx];
  }
  const r = alignImages(ref, big, w, h, { maxShift: 4, scales: [0.96, 0.97, 0.98, 1, 1.02, 1.03, 1.04] });
  assert.equal(r.moved, true);
  assert.ok(Math.abs(r.scale - 1 / 1.03) < 0.012, `scale ${r.scale}`);
  console.log('PASS  a 3% scale error is found');
}

// The worker keeps an alignment only when it is a plausible one.
{
  const { naipAlignOf } = await import('../worker/src/corpus.js');
  assert.equal(naipAlignOf(null), null);
  assert.equal(naipAlignOf({ east: 25, north: 0 }), null);
  assert.equal(naipAlignOf({ east: 1, north: 0, scale: 1.2 }), null);
  assert.equal(naipAlignOf({ east: 'x', north: 0 }), null);
  const kept = JSON.parse(naipAlignOf({ east: 1.234567, north: -0.5, scale: 1.0025, source: 'person' }));
  assert.deepEqual(kept, { east: 1.23, north: -0.5, scale: 1.0025, source: 'person' });
  assert.equal(JSON.parse(naipAlignOf({ east: 0, north: 0, source: 'hacker' })).source, 'auto');
  console.log('PASS  the worker stores only plausible alignments');
}
