// scan/lib/walkfix.js: the whole walk placed at once from the trail and the ground's shape. node scan/test/walkfix.test.js
import assert from 'node:assert/strict';
import { walkPrior, groundScore, refineGround, walkFix } from '../lib/walkfix.js';

// a lot with shape: a slope, a swale and a mound, on 0.25 m cells
const cell = 0.25, W = 240, H = 200, box = [0, 0, W * cell, H * cell];
const data = new Float32Array(W * H);
const zAt = (e, n) => 0.02 * e + 0.01 * n + 0.5 * Math.exp(-((e - 20) ** 2 + (n - 30) ** 2) / 30) - 0.4 * Math.exp(-((e - 40) ** 2 + (n - 15) ** 2) / 50);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) data[r * W + c] = zAt((c + 0.5) * cell, box[3] - (r + 0.5) * cell);
const dem = { box, cell, W, H, data };
// the walk: session points, under the true placement
const T = { theta: 0.6, tx: 30, ty: 20, s: 1 }, tz = 3.0;
const inv = (e, n) => { const de = e - T.tx, dn = n - T.ty, c = Math.cos(T.theta), s = Math.sin(T.theta); return [c * de + s * dn, -s * de + c * dn]; };
const ground = [];
for (let i = 0; i < 1500; i++) {
  const e = 8 + ((i * 7.3) % 45), n = 6 + ((i * 3.7) % 36);
  const [u, v] = inv(e, n); ground.push([u, v, zAt(e, n) - tz + Math.sin(i) * 0.03]);
}
const at = groundScore(dem, ground, T);
assert.ok(at.share > 0.9, `share at the truth ${at.share}`); assert.ok(Math.abs(at.tz - tz) < 0.05);
const off = { theta: T.theta + 0.07, tx: T.tx + 3, ty: T.ty - 2.5 };
assert.ok(groundScore(dem, ground, off).share < at.share);
const r = refineGround(dem, ground, off);
assert.ok(Math.hypot(r.T.tx - T.tx, r.T.ty - T.ty) < 0.5, `refined ${r.T.tx} ${r.T.ty}`);
assert.ok(Math.abs(r.T.theta - T.theta) < 0.02);
const w = walkFix(dem, ground, { T: off });
assert.equal(w.ok, true, w.why); assert.ok(w.margin > 0.02);
// a flat lot: no shape to pin it
const flat = { ...dem, data: new Float32Array(W * H).fill(5) };
const wf = walkFix(flat, ground.map(([u, v]) => [u, v, 2]), { T: off });
assert.equal(wf.ok, false);
assert.equal(walkFix(dem, ground.slice(0, 10), { T: off }).ok, false);
assert.equal(walkFix(dem, ground, null).ok, false);
// the trail: Street View's readings first, GPS's otherwise
const trail = (n, acc, src) => Array.from({ length: n }, (_, i) => { const u = i * 3, v = 0, c = Math.cos(T.theta), s = Math.sin(T.theta); return { at: [c * u - s * v + T.tx, s * u + c * v + T.ty], phone: [u, v], [src]: acc, odo: u }; });
const gps = trail(20, 5, 'acc'), geo = trail(20, 3, 'hacc');
assert.match(walkPrior(gps, geo).from, /Street View/);
assert.match(walkPrior(gps, []).from, /GPS/);
assert.equal(walkPrior([], []), null);
console.log('walkfix: ok');
// in locate.js: the walk's placement before a windowed fix when there are no references, after the references
{
  const { newLocate, fitFor, fitSource } = await import('../lib/locate.js');
  const L = newLocate();
  L.walk = { ok: true, T: { theta: 0.1, tx: 5, ty: 6, s: 1 }, share: 0.8, walkedM: 40 };
  L.holds = [{ odo0: 0, odo1: 5, T: { theta: 0, tx: 0, ty: 0, s: 1 }, vouched: 2 }];
  assert.equal(fitSource(L, 5, 0), 'walk'); assert.equal(fitFor(L, 5, 0).tx, 5);
  L.walk = { ok: false }; assert.equal(fitSource(L, 5, 0), 'fix');
}
console.log('walkfix in locate: ok');
