/** Checks for public/lib/sharp-tiles.js.   node tools/sharp-tiles.test.js */
import { sharpTiles, metresPerImagePx } from '../public/lib/sharp-tiles.js';
import { frameFor, frameCorners } from '../public/lib/mercator.js';
import { movedCorners } from '../public/lib/align.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${detail}`); }
};
const box = (m) => { const d = m / 2 / 111320; return [-85.67 - d / Math.cos(43 * Math.PI / 180), 43 - d, -85.67 + d / Math.cos(43 * Math.PI / 180), 43 + d]; };

const small = frameFor(box(40), 640, { marginM: 10 });
check('a small lot is already sharp enough: no pieces', sharpTiles(small, 0.075).length === 0,
  `${metresPerImagePx(small.lat, small.zoom).toFixed(3)} m/px`);
const big = frameFor(box(300), 640, { marginM: 10 });
const t = sharpTiles(big, 0.075);
const got = t.length ? metresPerImagePx(t[0].lat, t[0].zoom) : null;
check('a 300 m lot comes in pieces at about the photo\'s own 7.5 cm', t.length > 1 && got < 0.09, `${t.length} pieces at ${got}`);
check('no piece is bigger than the server allows', t.every((f) => f.size <= 1281 && f.height <= 1281));
const huge = sharpTiles(frameFor(box(2000), 640, { marginM: 10 }), 0.03);
check('a huge lot is capped at 6 pieces', huge.length > 0 && huge.length <= 6, String(huge.length));
check('no piece is under the server\'s 256', [...t, ...huge].every((f) => f.size >= 256 && f.height >= 256));
check('an unknown resolution asks for nothing', sharpTiles(big, null).length === 0);
const zoom20 = sharpTiles(frameFor(box(120), 640, { marginM: 10 }), 0.01);
check('never past zoom 20, what the server will serve', zoom20.every((f) => f.zoom <= 20));
const c = frameCorners(big);
const whole = movedCorners(c, 1, -2, 1.01);
const same = movedCorners(c, 1, -2, 1.01, [big.lng, big.lat]);
check('moving about the frame\'s own centre is unchanged', whole.every((p, i) => Math.abs(p[0] - same[i][0]) < 1e-9 && Math.abs(p[1] - same[i][1]) < 1e-9));
if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nsharp tiles: ok');
