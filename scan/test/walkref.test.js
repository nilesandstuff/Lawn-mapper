// scan/lib/walkref.js: a walk placed by an earlier walk, by its shape (SCAN-H32). node scan/test/walkref.test.js
import assert from 'node:assert/strict';
import { buildRef, encodeRef, decodeRef, shapeFix, fitRigid, place, voxel } from '../lib/walkref.js';

// a seeded generator, so the yard is the same every run
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// a yard on the map: a house's walls, a fence, shrubs; flat ground
const S = [];
for (let x = 0; x <= 12; x += 0.05) for (let k = 0; k < 2; k++) { S.push([x, 0, 0.3 + rnd() * 3.2]); S.push([x, 9, 0.3 + rnd() * 3.2]); }
for (let y = 0; y <= 9; y += 0.05) for (let k = 0; k < 2; k++) { S.push([0, y, 0.3 + rnd() * 3.2]); S.push([12, y, 0.3 + rnd() * 3.2]); }
for (let x = -15; x <= 25; x += 0.1) S.push([x, -18, 0.3 + rnd() * 1.2]);
for (const [cx, cy] of [[-8, -5], [18, -8], [20, 5], [-5, 12], [5, -12]]) for (let k = 0; k < 250; k++) S.push([cx + gauss() * 0.5, cy + gauss() * 0.5, 0.3 + rnd() * 1.3]);
const G = [];
for (let k = 0; k < 15000; k++) G.push([-15 + rnd() * 40, -18 + rnd() * 33, 0]);

// a walk's view of the yard: in its own session (map = T(session)), height offset, noise, a share of the points
function walk(T, keep, noise, dy) {
  const c = Math.cos(-T.theta), s = Math.sin(-T.theta);
  const toS = ([e, n, h]) => { const x = e - T.tx, y = n - T.ty; return [c * x - s * y + gauss() * noise, s * x + c * y + gauss() * noise, h + dy + gauss() * noise]; };
  return { stand: S.filter(() => rnd() < keep).map(toS), ground: G.filter(() => rnd() < keep).map(toS) };
}
const err = (T, truth, at) => { const a = place(T, ...at), b = place(truth, ...at); return Math.hypot(a[0] - b[0], a[1] - b[1]); };

// the reference: walk A placed by its marks (here, its true placement)
const TA = { theta: 0.7, tx: 5, ty: -3, s: 1 };
const A = walk(TA, 0.6, 0.04, 1.6);
const ref = buildRef(A, TA, 1000);
assert.ok(ref.stand.length / 3 > 1000 && ref.ground.length / 3 > 1000);
// its bytes round-trip
const back = decodeRef(encodeRef(ref));
assert.equal(back.at, 1000);
assert.deepEqual(Array.from(back.stand.slice(0, 6)), Array.from(ref.stand.slice(0, 6)));
assert.equal(back.ground.length, ref.ground.length);
assert.equal(decodeRef(new Uint8Array(10)), null);

// walk B, turned and shifted far from A's session, placed with no start
const TB = { theta: -2.1, tx: -20, ty: 30, s: 1 };
const B = walk(TB, 0.5, 0.06, -0.4);
const t0 = Date.now();
const fix = shapeFix(ref, B);
const ms = Date.now() - t0;
assert.ok(fix.ok, `placed: ${fix.why}`);
// where B's own points would be, in its session: the error there
const probe = [[2, -3], [14, 4], [-6, 6]].map(([e, n]) => { const c = Math.cos(-TB.theta), s = Math.sin(-TB.theta), x = e - TB.tx, y = n - TB.ty; return [c * x - s * y, s * x + c * y]; });
for (const p of probe) assert.ok(err(fix.T, TB, p) < 0.15, `within 15 cm: ${err(fix.T, TB, p).toFixed(3)}`);
assert.ok(Math.abs(fix.tz - 2.0) < 0.1, `height ${fix.tz}`);
assert.ok(fix.landed > 0.6, `landed ${fix.landed}`);
console.log(`shapeFix: ${fix.landed} landed, ${ms} ms, ${fix.stand} standing cells`);

// a walk somewhere else entirely does not pass the gate
seed = 99;
const other = { stand: [], ground: [] };
for (let k = 0; k < 3000; k++) other.stand.push([rnd() * 30, rnd() * 30, 0.3 + rnd() * 2]);
for (let k = 0; k < 3000; k++) other.ground.push([rnd() * 30, rnd() * 30, 0]);
const no = shapeFix(ref, other);
assert.equal(no.ok, false);
assert.match(no.why, /land on the earlier walk|walls, fences and shrubs do/);

// too little walked yet; no reference
assert.match(shapeFix(ref, { stand: B.stand.slice(0, 50), ground: [] }).why, /standing points so far/);
assert.match(shapeFix(null, B).why, /no reference/);

// fitRigid and voxel
const T = { theta: 0.3, tx: 2, ty: -1 }, pts = [[0, 0], [5, 1], [-2, 4]];
const Tf = fitRigid(pts, pts.map(([u, v]) => place(T, u, v)));
assert.ok(Math.abs(Tf.theta - 0.3) < 1e-9 && Math.abs(Tf.tx - 2) < 1e-9);
assert.equal(voxel([[0, 0, 0], [0.05, 0.05, 0.05], [1, 1, 1]]).length, 2);
console.log('walkref: ok');
