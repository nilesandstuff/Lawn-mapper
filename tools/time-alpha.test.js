import assert from 'node:assert/strict';
import { summarise, banding, patchReport, pieces } from './time-alpha.js';

const s = summarise([
  { seconds: { total: 20, backbone: 4, canopy: 2, decoder: 1, waited: 10 } },
  { seconds: { total: 30, backbone: 5, canopy: 3, decoder: 3, waited: 15 } },
  { seconds: { total: 10, backbone: 3, canopy: 1, decoder: 0.5, waited: 4 } },
]);
assert.equal(s.lots, 3);
assert.equal(s.total, 20);
assert.equal(s.decoder, 1);
assert.equal(s.decoderShareOfTotal, 0.05);
/* Stripes across a lot, against a lawn shaped like a lawn. */
{
  const w = 64, h = 64;
  const img = (lawnAt) => { const d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[(y * w + x) * 4] = lawnAt(x, y) ? 255 : 0; return d; };
  const stripes = banding(img((x, y) => Math.floor(y / 4) % 2 === 0), w, h);
  const blob = banding(img((x, y) => (x - 30) ** 2 + (y - 34) ** 2 < 400), w, h);
  assert.ok(stripes.ratio > 3, `stripes read as stripes (${stripes.ratio})`);
  assert.ok(blob.ratio > 0.5 && blob.ratio < 2, `a round lawn does not (${blob.ratio})`);
}

console.log('time alpha: ok');

/* Why a patch was left out (owner, 2026-10-24): two separate pieces, sizes and shares. */
{
  const w = 40, h = 20, mpp = 0.3;
  const probGrey = new Uint8Array(w * h), canopy = new Uint8Array(w * h), final = new Uint8Array(w * h);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) { probGrey[y * w + x] = 200; final[y * w + x] = 1; }
  for (let y = 10; y < 16; y++) for (let x = 20; x < 30; x++) { probGrey[y * w + x] = 100; canopy[y * w + x] = 1; }
  assert.equal(pieces(probGrey.map((v) => (v >= 77 ? 1 : 0)), w, h).n, 2);
  const r = patchReport({ probGrey, final, canopy, roof: null, voidMask: null, within: null, w, h, mpp });
  assert.equal(r.length, 2);
  const [big, small] = r;
  assert.equal(Math.round(big.sqft), Math.round(60 * 0.09 * 10.7639));
  assert.equal(big.surePct, 0);
  assert.equal(big.canopyPct, 100);
  assert.equal(big.keptPct, 0);
  assert.equal(small.keptPct, 100);
  assert.equal(small.meanPct, 78);
}
console.log('time-alpha patches: ok');

/* The serving grid comparison's arithmetic (S64). */
{
  const { upsample, wrongShare, signTest } = await import('./time-alpha.js');
  assert.deepEqual([...upsample(Uint8Array.from([1, 0, 0, 1]), 2, 2, 4, 4)], [1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);
  const s = wrongShare(Uint8Array.from([1, 1, 0, 0]), Uint8Array.from([1, 0, 1, 0]), null);
  assert.equal(s.pct, 100);
  assert.equal(wrongShare(Uint8Array.from([1, 1]), Uint8Array.from([1, 0]), Uint8Array.from([1, 0])).pct, 0);
  assert.ok(Math.abs(signTest(9, 1) - 0.0215) < 0.001);
  assert.equal(signTest(5, 5), 1);
}
console.log('time-alpha grids: ok');
