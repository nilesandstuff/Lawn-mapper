/**
 * The editor's photo enhancement (public/lib/enhance.js), on pixels with a known answer.
 *
 *   node tools/enhance.test.js
 */
import { enhance, curve } from '../public/lib/enhance.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const px = (...rgb) => { const a = new Uint8ClampedArray(4); a.set([...rgb, 255]); return a; };
const one = (r, g, b, opts = {}) => [...enhance(px(r, g, b), 1, 1, { sharpen: 0, clarity: 0, ...opts }).slice(0, 3)];

let rising = true, prev = -1;
for (let x = 0; x <= 1.0001; x += 0.01) { const v = curve(x); if (v < prev - 1e-9) rising = false; prev = v; }
check('the curve keeps black and white and never runs backwards', Math.abs(curve(0)) < 1e-9 && Math.abs(curve(1) - 1) < 1e-9 && rising);
check('shadows come up, highlights come down a little', curve(0.25) > 0.33 && curve(0.9) < 0.9 && curve(0.9) > 0.85,
  `0.25 -> ${curve(0.25).toFixed(3)}, 0.9 -> ${curve(0.9).toFixed(3)}`);

const [gr, gg, gb] = one(60, 60, 60);
check('a grey stays grey, only brighter', gr === gg && gg === gb && gr > 60, `${gr},${gg},${gb}`);
const [lr, lg] = one(90, 110, 70);
const [br, bg] = one(120, 100, 70);
check('dormant-ish green and brown are pushed apart', (lg - lr) > (110 - 90) * 1.15 && (br - bg) > (120 - 100) * 1.15,
  `green ${lg - lr} vs 20, brown ${br - bg} vs 20`);
const shade = one(30, 45, 25);
check('grass in shadow is lifted', shade[1] > 55, shade.join(','));

/* Sharpen: nothing on a flat picture, and held to a few levels at an edge. */
const W = 8, H = 8;
const flat = new Uint8ClampedArray(W * H * 4).fill(120);
const before = enhance(new Uint8ClampedArray(flat), W, H, { sharpen: 0, clarity: 0 });
const after = enhance(new Uint8ClampedArray(flat), W, H);
check('a flat picture is not sharpened', before.every((v, i) => v === after[i]));
const edge = new Uint8ClampedArray(W * H * 4);
for (let p = 0; p < W * H; p++) { const v = p % W < 4 ? 40 : 200; edge.set([v, v, v, 255], p * 4); }
const noSharp = enhance(new Uint8ClampedArray(edge), W, H, { sharpen: 0, clarity: 0 });
const sharp = enhance(new Uint8ClampedArray(edge), W, H, { clarity: 0 });
let most = 0;
for (let i = 0; i < sharp.length; i += 4) most = Math.max(most, Math.abs(sharp[i] - noSharp[i]));
check('an edge is sharpened, but by no more than the cap', most > 0 && most <= 9, `largest change ${most}`);
/* Near white, no colour is pushed: a railing stays white (the first try drew coloured specks). */
const [wr, wg, wb] = one(246, 250, 244);
check('a near-white pixel keeps its colour', Math.abs((wg - wr) - (250 - 246)) <= 2 && Math.abs((wg - wb) - (250 - 244)) <= 2, `${wr},${wg},${wb}`);
const edgeC = new Uint8ClampedArray(W * H * 4);
for (let p = 0; p < W * H; p++) edgeC.set(p % W < 4 ? [60, 90, 40, 255] : [250, 250, 250, 255], p * 4);
const cs = enhance(new Uint8ClampedArray(edgeC), W, H);
let tint = 0;
for (let p = 0; p < W * H; p++) if (p % W >= 4) tint = Math.max(tint, Math.max(cs[p * 4], cs[p * 4 + 1], cs[p * 4 + 2]) - Math.min(cs[p * 4], cs[p * 4 + 1], cs[p * 4 + 2]));
check('and the white side of an edge with grass takes no colour from sharpening', tint <= 2, `spread ${tint}`);

{
  /* A plain byte array (a Node Buffer) is clamped too, not wrapped. */
  const buf = new Uint8Array(W * H * 4);
  for (let p = 0; p < W * H; p++) buf.set(p % W < 4 ? [20, 30, 15, 255] : [254, 254, 252, 255], p * 4);
  enhance(buf, W, H);
  let worst = 0;
  for (let p = 0; p < W * H; p++) if (p % W >= 4) worst = Math.max(worst, 255 - Math.min(buf[p * 4], buf[p * 4 + 1], buf[p * 4 + 2]));
  check('a plain byte array is clamped, not wrapped round', worst < 20, `darkest white channel ${255 - worst}`);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
