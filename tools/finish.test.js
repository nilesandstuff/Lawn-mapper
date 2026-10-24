/**
 * The finishing steps shared by the model server and the page's confidence
 * slider (public/lib/finish.js).
 *
 *   node tools/finish.test.js
 */

import { finishLot, predictionMask, maskPicture, LAWN_THRESHOLD, STAGE3 } from '../public/lib/finish.js';
import { finishLot as serverFinish } from './serve-alpha.mjs';
import { stage3 } from '../public/lib/stage3.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${detail}`); }
};

/* A 60 x 40 lot at 15 cm: lawn on the left (prob 230), a grey island on the
   right (prob 100, "half sure"), a tree over the middle of the lawn, a roof
   the decoder half-likes in the corner. */
const w = 60, h = 40, mpp = 0.15;
const pic = (fn) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = fn(x, y), i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
};
const prob = pic((x, y) => (x < 30 ? 230 : (x >= 40 && x < 50 && y >= 10 && y < 30) ? 100 : (x >= 52 && y < 8) ? 110 : 20));
const canopy = pic((x, y) => ((x - 15) ** 2 + (y - 20) ** 2 < 36 ? 255 : 0));
const roof = pic((x, y) => (x >= 52 && y < 8 ? 255 : 0));
const count = (m) => m.reduce((a, b) => a + b, 0);
const at = (m, x, y) => m[y * w + x];

const served = finishLot({ prob, canopy, roof, voidMask: null, height: null, w, h, mpp });
check('the page\'s finish is the server\'s, step for step',
  JSON.stringify([...served]) === JSON.stringify([...serverFinish({ prob, canopy, roof, voidMask: null, height: null, w, h, mpp })]));
check('at 50% it is the decoder cut at 128, then stage 3, then the veto',
  LAWN_THRESHOLD === 128 && JSON.stringify([...served]) === JSON.stringify([...stage3(predictionMask(prob, w, h), (() => {
    const c = new Uint8Array(w * h); for (let i = 0; i < c.length; i++) c[i] = canopy.data[i * 4] >= 128 ? 1 : 0; return c;
  })(), w, h, { mpp, ...STAGE3 }).mask]));
check('at 50% the half-sure island is not lawn', at(served, 45, 20) === 0);

const low = finishLot({ prob, canopy, roof, voidMask: null, height: null, w, h, mpp, threshold: Math.round((30 * 255) / 100) });
check('at 30% the half-sure island is traced', at(low, 45, 20) === 1 && count(low) > count(served));
check('at 30% a roof the decoder half-likes is still vetoed', at(low, 55, 3) === 0);
check('the tree in the lawn is filled at both cuts', at(served, 15, 20) === 1 && at(low, 15, 20) === 1);

const high = finishLot({ prob, canopy, roof, voidMask: null, height: null, w, h, mpp, threshold: Math.round((80 * 255) / 100) });
check('at 80% the sure lawn stays', at(high, 5, 5) === 1 && count(high) <= count(served));

const heightPic = pic(() => 120);
check('the height picture changes nothing at THE PLAN\'s settings (the woods rule is off), so the page may leave it out',
  JSON.stringify([...finishLot({ prob, canopy, roof, voidMask: null, height: heightPic, w, h, mpp })]) === JSON.stringify([...served]));

const p = maskPicture(served, w, h);
check('a mask becomes an opaque white-on-black picture the tracer reads',
  p.width === w && p.height === h && p.data[(20 * w + 5) * 4] === 255 && p.data[(20 * w + 45) * 4] === 0 && p.data[3] === 255);

let threw = false;
try { finishLot({ prob, canopy, roof: null, voidMask: null, w: w + 1, h, mpp }); } catch { threw = true; }
check('a decoder picture of the wrong size is refused, not resampled', threw);

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nfinish: ok');
