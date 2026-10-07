import assert from 'node:assert/strict';
import { summarise } from './time-alpha.js';

const s = summarise([
  { seconds: { total: 20, backbone: 4, canopy: 2, decoder: 1, waited: 10 } },
  { seconds: { total: 30, backbone: 5, canopy: 3, decoder: 3, waited: 15 } },
  { seconds: { total: 10, backbone: 3, canopy: 1, decoder: 0.5, waited: 4 } },
]);
assert.equal(s.lots, 3);
assert.equal(s.total, 20);
assert.equal(s.decoder, 1);
assert.equal(s.decoderShareOfTotal, 0.05);
console.log('time alpha: ok');
