import assert from 'node:assert/strict';
import { summarise, banding } from './time-alpha.js';

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
