/**
 * public/lib/register.js: does it find the ground's offset, and only the
 * ground's, and say so when it cannot?
 *   node tools/register.test.js
 *
 * The scenes are drawn here rather than fetched, so the right answer is known
 * exactly: a street with kerbs, drives, beds and houses, then the same street
 * moved, scaled and turned by a known amount -- and in one case with every
 * roof leaning a further 2 m, the way a second camera angle shows them.
 */
import {
  registerImages, applyAffine, invertAffine, fitAffine, fitShiftScale, robustFit, alignFromRegistration,
} from '../public/lib/register.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

/* A deterministic street, in ground metres, rendered by a function. */
function rand(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function scene(seed = 3) {
  const r = rand(seed);
  const rects = [];
  /* A road along the south, kerbs and a footway, drives, beds, sheds, houses. */
  rects.push({ x0: -5, y0: 95, x1: 125, y1: 105, v: 70, ground: true });
  rects.push({ x0: -5, y0: 90, x1: 125, y1: 92, v: 190, ground: true });
  for (let i = 0; i < 4; i++) {
    const x = 8 + i * 28 + r() * 4;
    rects.push({ x0: x, y0: 35 + r() * 8, x1: x + 14 + r() * 4, y1: 52 + r() * 8, v: 95 + r() * 30, ground: false });
    rects.push({ x0: x + 3, y0: 60, x1: x + 8, y1: 90, v: 175, ground: true });
    rects.push({ x0: x + 15, y0: 62 + r() * 10, x1: x + 22, y1: 66 + r() * 10, v: 60, ground: true });
    rects.push({ x0: x + 2, y0: 10 + r() * 10, x1: x + 6, y1: 14 + r() * 10, v: 150, ground: false });
  }
  /* Mow stripes and texture so a lawn is not a blank. */
  return (X, Y, lean = [0, 0]) => {
    let v = 120 + 6 * Math.sin(X * 1.7) + 5 * Math.sin(Y * 2.3 + X * 0.3);
    for (const q of rects) {
      const dx = q.ground ? 0 : lean[0], dy = q.ground ? 0 : lean[1];
      if (X >= q.x0 + dx && X < q.x1 + dx && Y >= q.y0 + dy && Y < q.y1 + dy) v = q.v;
    }
    return v;
  };
}

const GROUND = 120; // metres across
const PX = 480; // 25 cm pixels
const mpp = GROUND / PX;
function render(fn, A = null, lean) {
  /* Pixel p of the result shows the ground that pixel A^-1(p) shows in the
     unmoved render: A takes unmoved pixels to moved ones. */
  const inv = A ? invertAffine(A) : null;
  const data = new Uint8Array(PX * PX * 4);
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const [sx, sy] = inv ? applyAffine(inv, [x + 0.5, y + 0.5]) : [x + 0.5, y + 0.5];
      const v = fn(sx * mpp, sy * mpp, lean);
      const i = (y * PX + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v)); data[i + 3] = 255;
    }
  }
  return { data, width: PX, height: PX };
}
/* A moved by east/north metres, scaled and turned about the centre. */
function motion(east, north, scale = 1, deg = 0) {
  const c = PX / 2, t = (deg * Math.PI) / 180;
  const a = scale * Math.cos(t), b = -scale * Math.sin(t), d = scale * Math.sin(t), e = scale * Math.cos(t);
  return [a, b, c - a * c - b * c + east / mpp, d, e, c - d * c - e * c - north / mpp];
}
/* Worst disagreement between two pixel maps over the frame, in metres. */
function worst(A, B) {
  let w = 0;
  for (let y = 0; y <= PX; y += PX / 6) {
    for (let x = 0; x <= PX; x += PX / 6) {
      const [p, q] = applyAffine(A, [x, y]);
      const [r, s] = applyAffine(B, [x, y]);
      w = Math.max(w, Math.hypot(p - r, q - s) * mpp);
    }
  }
  return w;
}

const street = scene();
const ref = render(street);

{
  const truth = motion(1.3, -0.8);
  const r = registerImages(ref, render(street, truth), GROUND);
  check('a plain shift is found to within 5 cm everywhere in the frame',
    r.confident && worst(r.A, truth) < 0.05, `${r.model}, ${r.why}, worst ${worst(r.A, truth).toFixed(3)} m`);
  check('and said in metres east and north',
    Math.abs(r.offsetM.east - 1.3) < 0.05 && Math.abs(r.offsetM.north + 0.8) < 0.05,
    JSON.stringify(r.offsetM));
  check('and it is a shift, not a richer model', r.model === 'shift', r.model);
}
{
  const truth = motion(6, 4, 1.012, 0.5);
  const r = registerImages(ref, render(street, truth), GROUND);
  check('6 m away, 1.2% bigger and turned half a degree: found to within 8 cm',
    r.confident && worst(r.A, truth) < 0.08, `${r.model}, ${r.why}, worst ${worst(r.A, truth).toFixed(3)} m`);
}
{
  /* Every roof and shed leans 2 m further east in the moved picture. The
     ground moved 0.5 m west; the roofs, 1.5 m east. */
  const truth = motion(-0.5, 0.4);
  const r = registerImages(ref, render(street, truth, [2, 0]), GROUND);
  check('roofs leaning 2 m do not move the answer: the ground is found to within 8 cm',
    r.confident && worst(r.A, truth) < 0.08, `${r.model}, worst ${worst(r.A, truth).toFixed(3)} m, ${r.inliers}/${r.patches}`);
  check('and the roof patches are the ones left out',
    r.vectors.filter((v) => !v.inlier).length > 0);
}
{
  /* Canopy: soft crowns and nothing straight -- and, as between two flights,
     every crown a little different (wind, season, a year's growth). */
  const r0 = rand(11);
  const blobs = Array.from({ length: 90 }, () => [r0() * 120, r0() * 120, 3 + r0() * 6]);
  const crowns = (jit) => {
    const r1 = rand(jit);
    const b = blobs.map(([x, y, s]) => (jit ? [x + (r1() - 0.5) * 3, y + (r1() - 0.5) * 3, s * (0.8 + r1() * 0.4)] : [x, y, s]));
    return (X, Y) => {
      let v = 70;
      for (const [bx, by, br] of b) v += 25 * Math.exp(-((X - bx) ** 2 + (Y - by) ** 2) / (br * br));
      return v;
    };
  };
  const r = registerImages(render(crowns(0)), render(crowns(5), motion(0.7, 0.2)), GROUND);
  check('a frame of canopy that changed between flights is not certified', !r.confident, `${r.why}`);
}
{
  const truth = motion(1, 1);
  const mov = render(street, truth);
  const a = registerImages(ref, mov, GROUND), b = registerImages(ref, mov, GROUND);
  check('the same pictures always give the same answer', JSON.stringify(a.A) === JSON.stringify(b.A));
}
{
  /* The fits themselves. */
  const P = [[0, 0], [10, 0], [0, 10], [10, 10], [5, 3]];
  const T = [1.01, 0.02, 3, -0.01, 0.99, -2];
  const A = fitAffine(P, P.map((p) => applyAffine(T, p)));
  check('an affine is recovered exactly from exact points', A.every((v, i) => Math.abs(v - T[i]) < 1e-9));
  const S = fitShiftScale(P, P.map(([x, y]) => [1.02 * x + 4, 1.02 * y - 1]));
  check('as is a shift and scale', Math.abs(S[0] - 1.02) < 1e-9 && Math.abs(S[2] - 4) < 1e-9 && Math.abs(S[5] + 1) < 1e-9);
  const I = invertAffine(T);
  const [x, y] = applyAffine(I, applyAffine(T, [7, -3]));
  check('the inverse undoes it', Math.abs(x - 7) < 1e-9 && Math.abs(y + 3) < 1e-9);
  /* Twelve agreeing patches and four leaning ones: the mode, not the mean. */
  const p = [], q = [];
  for (let i = 0; i < 12; i++) { p.push([i * 10, (i % 4) * 25]); q.push([i * 10 + 2, (i % 4) * 25 + 1]); }
  for (let i = 0; i < 4; i++) { p.push([i * 30 + 5, 40]); q.push([i * 30 + 5 + 2 + 3 + i, 40 + 1]); }
  const { pick } = robustFit(p, q, p.map(() => 1), 1.5, { kernel: 0.75 });
  check('the agreeing patches decide, not the average of all of them',
    pick && Math.abs(pick.A[2] - 2) < 1e-6 && Math.abs(pick.A[5] - 1) < 1e-6 && pick.inliers.length === 12,
    pick && `${pick.name} ${pick.A.map((v) => v.toFixed(3))}`);
}

{
  /* The editor's Auto: a photo whose ground sits 1.3 m east and 0.8 m south
     of Mapbox's is moved 1.3 m west and 0.8 m north, and one 1% too big is
     shrunk by 1%. */
  const r = registerImages(ref, render(street, motion(1.3, -0.8)), GROUND);
  const a = alignFromRegistration(r);
  check('Auto moves the photo back by what was measured',
    Math.abs(a.east + 1.3) < 0.05 && Math.abs(a.north - 0.8) < 0.05 && a.scale === 1, JSON.stringify(a));
  const big = alignFromRegistration({ A: [1.01, 0, 0, 0, 1.01, 0], offsetM: { east: 0, north: 0 } });
  check('and a photo whose ground is 1% bigger is scaled by 1/1.01', Math.abs(big.scale - 1 / 1.01) < 1e-4, JSON.stringify(big));
}

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
