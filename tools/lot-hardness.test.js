/**
 * The photo measures behind workflow 33 (tools/lot-hardness.js), on pictures
 * drawn here so every number has a known answer.
 *
 *   node tools/lot-hardness.test.js
 */
import { covariates, ranks, spearman, report } from './lot-hardness.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* A 40 x 40 picture: green lawn on the left half, brown dirt on the right,
   a black shadow in the top-left 10 x 10 corner. */
const w = 40, h = 40;
const rgb = new Uint8Array(w * h * 3);
const lawn = new Uint8Array(w * h);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const left = x < 20;
    lawn[i] = left ? 1 : 0;
    /* Deterministic texture, different in each channel, so neither half is
       flat and the colour spread is realistic rather than a hairline. */
    const n1 = ((x * 7 + y * 13) % 25) - 12, n2 = ((x * 11 + y * 3) % 25) - 12, n3 = ((x * 5 + y * 17) % 25) - 12;
    let c = left ? [70 + n1, 160 + n2, 60 + n3] : [150 + n1, 120 + n2, 90 + n3];
    if (left && x < 10 && y < 10) c = [10, 10, 10];
    rgb.set(c, 3 * i);
  }
}
const cov = covariates(rgb, w, h, { lawn });
check('the lawn reads green and the dirt does not, so contrast is high',
  cov.green > 0.2 && cov.contrast > 3, `green ${cov.green?.toFixed(2)} contrast ${cov.contrast?.toFixed(2)}`);
check('the shadow is a sixteenth of the picture', Math.abs(cov.shadow - 100 / 1600) < 1e-6, String(cov.shadow));
check('half the picture is lawn', Math.abs(cov.lawn - 0.5) < 1e-6);
/* Sharpness: the same picture blurred (3 x 3 box) must read softer. */
const blurred = new Uint8Array(rgb);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) for (let ch = 0; ch < 3; ch++) {
  let s = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += rgb[3 * ((y + dy) * w + (x + dx)) + ch];
  blurred[3 * (y * w + x) + ch] = Math.round(s / 9);
}
const bcov = covariates(blurred, w, h, { lawn });
check('sharpness is defined and a blurred copy reads softer',
  Number.isFinite(cov.sharp) && cov.sharp > 0 && bcov.sharp < cov.sharp * 0.8, `sharp ${cov.sharp?.toFixed(2)} blurred ${bcov.sharp?.toFixed(2)}`);

/* The same lawn, dormant: brown-green grass on brown dirt -- low contrast. */
const dull = new Uint8Array(rgb);
for (let i = 0; i < w * h; i++) {
  if (!lawn[i] || dull[3 * i] <= 20) continue;
  const x = i % w, y = Math.floor(i / w);
  const n1 = ((x * 7 + y * 13) % 25) - 12, n2 = ((x * 11 + y * 3) % 25) - 12, n3 = ((x * 5 + y * 17) % 25) - 12;
  dull.set([140 + n1, 130 + n2, 85 + n3], 3 * i);
}
const dcov = covariates(dull, w, h, { lawn });
check('dormant grass on dirt is low contrast and low green', dcov.contrast < cov.contrast / 2 && dcov.green < cov.green / 2,
  `contrast ${dcov.contrast?.toFixed(2)} green ${dcov.green?.toFixed(2)}`);

/* Ranks and the correlation. */
check('ties share a rank', ranks([3, 1, 3, 2]).join() === '3.5,1,3.5,2');
const up = spearman([1, 2, 3, 4, 5, 6, 7, 8], [2, 4, 5, 7, 8, 9, 11, 12]);
check('a monotone pair is rho 1 with a small p', Math.abs(up.rho - 1) < 1e-9 && up.p < 0.01, `rho ${up.rho} p ${up.p}`);
const noise = spearman([1, 2, 3, 4, 5, 6, 7, 8], [5, 1, 7, 3, 8, 2, 6, 4]);
check('a shuffled pair is near 0 with a large p', Math.abs(noise.rho) < 0.5 && noise.p > 0.1, `rho ${noise.rho} p ${noise.p}`);

/* The report runs on a handful of lots and says how many there were. */
const lots = Array.from({ length: 9 }, (_, i) => ({
  name: `L${i}`, error: 10 + i * 5, source: i % 3 ? 'mapbox' : 'county', leafOff: i % 2,
  contrast: 2 - i * 0.2, green: 0.3, shadow: 0.05, sharp: 0.3, bright: 120, lawn: 0.4, sizeM2: 500, near10: 60,
}));
const lines = report(lots);
check('the report covers all, Mapbox-only and county-only',
  lines.some((l) => l.startsWith('\nall lots (9')) && lines.some((l) => l.includes('Mapbox lots only (6')) && lines.some((l) => l.includes('county lots only (3')));
check('and contrast tracks error here', lines.some((l) => /contrast .*rank corr with error -1\.00/.test(l)), lines.find((l) => /contrast/.test(l)));

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
