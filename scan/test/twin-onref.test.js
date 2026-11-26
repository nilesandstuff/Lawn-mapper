import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { m4Of, moveTwin } from '../tools/twin-onref.mjs';
import { place } from '../lib/walkref.js';

const T = { theta: 0.6, tx: 4, ty: -3, s: 1.04 };
// a point and the camera at (1, 1.5, -2) in the session; a picture there, kept the app's way (session to camera)
const d = mkdtempSync(join(tmpdir(), 'onref-'));
writeFileSync(join(d, 'cloud-0000.bin'), Buffer.from(Float32Array.from([0, 5, 2, 0.8, -6, -1.2]).buffer));
writeFileSync(join(d, 'track-0000.bin'), Buffer.from(Float32Array.from([1, 5, 1, 1.5, -2, 0, 0, 0, 1, 0]).buffer));
const c2w = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1.5, -2, 1];                 // facing -z, at the camera's place
const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, -1.5, 2, 1];               // its inverse: what the app keeps
writeFileSync(join(d, 'keys-0000.json'), JSON.stringify([{ t: 1, odo: 5, view }]));
const r = moveTwin(d, () => T);
assert.equal(r.pts, 1); assert.equal(r.keys, 1); assert.equal(r.appWay, true, 'the app\'s way found from the track');
const f32 = (f) => { const b = readFileSync(join(d, f)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const a = f32('cloud-0000.bin');
const [e, n] = place(T, 2, 6);
assert.ok(Math.abs(a[2] - e) < 1e-4 && Math.abs(-a[4] - n) < 1e-4, `the point on the map (${a[2]}, ${-a[4]} against ${e}, ${n})`);
assert.ok(Math.abs(a[3] - 0.8 * 1.04) < 1e-5 && Math.abs(a[5] + 1.2 * 1.04) < 1e-5, 'its height and its ground stretched alike');
const tr = f32('track-0000.bin');
const k = JSON.parse(readFileSync(join(d, 'keys-0000.json'), 'utf8'))[0];
// the picture's camera, read back the app's way (the inverse of its view), sits where the moved track says
const inv = (m) => { // rigid-with-scale inverse is enough to read the place: solve V * p = 0
  const A = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]], b = [-m[12], -m[13], -m[14]];
  const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det(A); return [0, 1, 2].map((c) => det(A.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)))) / D); };
const cam = inv(k.view);
assert.ok(Math.hypot(cam[0] - tr[2], cam[1] - tr[3], cam[2] - tr[4]) < 1e-4, `the picture's camera on the moved track (${cam} vs ${[tr[2], tr[3], tr[4]]})`);
void c2w; void m4Of;
console.log('twin-onref: ok');
