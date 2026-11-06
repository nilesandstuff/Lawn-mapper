import assert from 'node:assert/strict';
import { pitchOf, isSky, viewOf, newAnchors, noteView, nudge, NUDGE_M, REPEAT_M } from '../lib/anchors.js';

// pitch: identity looks level; a turn about x by +20 degrees looks up 20
const qx = (deg) => { const a = (deg * Math.PI) / 360; return { x: Math.sin(a), y: 0, z: 0, w: Math.cos(a) }; };
assert.ok(Math.abs(pitchOf({ x: 0, y: 0, z: 0, w: 1 })) < 1e-9, 'level');
assert.ok(Math.abs(pitchOf(qx(20)) - 20) < 1e-6, `up 20: ${pitchOf(qx(20))}`);
assert.ok(Math.abs(pitchOf(qx(-35)) + 35) < 1e-6, 'down 35');

assert.ok(isSky(220, 225, 230) && isSky(120, 170, 235), 'grey cloud and blue sky');
assert.ok(!isSky(90, 120, 60) && !isSky(60, 60, 60), 'not grass, not a dark roof');

// pictures: sky over a roof; grey pavement under olive grass; all grass
const W = 32, H = 64;
const pic = (rowColour) => { const p = new Uint8Array(W * H * 4); for (let y = 0; y < H; y++) { const c = rowColour(y / H); for (let x = 0; x < W; x++) p.set([...c, 255], (y * W + x) * 4); } return p; };
const skyline = pic((y) => (y < 0.35 ? [215, 220, 228] : [70, 60, 55]));
const paving = pic((y) => (y < 0.5 ? [110, 120, 70] : [150, 150, 148]));
const lawn = pic(() => [110, 125, 60]);
let v = viewOf(skyline, W, H, 12);
assert.ok(v.sky && !v.pave, `a roofline: ${JSON.stringify(v)}`);
assert.ok(!viewOf(skyline, W, H, -5).sky, 'not when looking down');
assert.ok(!viewOf(pic(() => [215, 220, 228]), W, H, 30).sky, 'all sky is no skyline');
v = viewOf(paving, W, H, -30);
assert.ok(v.pave && !v.sky, `paving: ${JSON.stringify(v)}`);
assert.ok(!viewOf(lawn, W, H, -30).pave, 'lawn is not paving');

// nudges: none early; after NUDGE_M without either, the longer-missing first; a view resets; repeats spaced
const a = newAnchors();
assert.equal(nudge(a, 3), null, 'nothing in the first metres');
noteView(a, 5, { sky: true, pave: false });
assert.equal(nudge(a, 20), null, 'too soon');
let n = nudge(a, NUDGE_M + 1);
assert.equal(n.kind, 'pave', 'pavement missing since the start');
assert.equal(nudge(a, NUDGE_M + 2)?.kind ?? null, null, 'sky not yet due, pave just given');
n = nudge(a, 5 + NUDGE_M);
assert.equal(n.kind, 'sky', 'then the skyline');
assert.equal(nudge(a, NUDGE_M + 1 + REPEAT_M - 1), null, 'pave not repeated inside REPEAT_M');
assert.equal(nudge(a, NUDGE_M + 1 + REPEAT_M)?.kind, 'pave', 'repeated after REPEAT_M');
noteView(a, 70, { sky: true, pave: true });
assert.equal(nudge(a, 80), null, 'both seen: quiet');
assert.deepEqual(a.nudges, { sky: 1, pave: 2 });
console.log('anchors: ok');
