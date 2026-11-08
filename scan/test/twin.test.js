/**
 * scan/lib/twin.js: the walk's twin as parts to upload, and back.
 *   node scan/test/twin.test.js
 */
import assert from 'node:assert/strict';
import { newTwin, addPoints, addPose, wantKey, addKey, flush, flushDue, liveOf, readCloud, readTrack, turnDeg, FLUSH_EVERY, KEY_MAX } from '../lib/twin.js';

const T0 = 1_700_000_000_000;
const tw = newTwin({ walk: '123', map: 'm1', engine: 'webxr', started: T0 });
// one point per 5 cm cube: the same spot seen twice is kept once
assert.equal(addPoints(tw, T0 + 500, 0.2, [{ x: 1, y: 0, z: -2 }, { x: 1.01, y: 0.01, z: -1.99 }, { x: 1.2, y: 0, z: -2 }, null], -1.4), 2);
assert.equal(addPoints(tw, T0 + 750, 0.3, [{ x: 1.02, y: 0.02, z: -1.98 }]), 0, 'already seen');
// poses at most five a second
const q = { x: 0, y: 0, z: 0, w: 1 };
assert.equal(addPose(tw, T0 + 100, 0, { x: 0, y: 1.4, z: 0 }, q), true);
assert.equal(addPose(tw, T0 + 200, 0, { x: 0, y: 1.4, z: 0 }, q), false, 'too soon');
assert.equal(addPose(tw, T0 + 300, 0.1, { x: 0, y: 1.4, z: -0.1 }, q, 'limited'), true);
// pictures: the first, then not until a second has passed and the phone has moved or turned
const pos = { x: 0, y: 1.4, z: 0 };
assert.equal(wantKey(tw, T0, pos, q), true);
const cam = { w: 640, h: 480, proj: new Float32Array(16).fill(0.5), view: new Float32Array(16).fill(0.25) };
assert.equal(addKey(tw, T0, 0, pos, q, cam), 'key-0000.jpg');
assert.equal(wantKey(tw, T0 + 2000, pos, q), false, 'still, so no new picture');
assert.equal(wantKey(tw, T0 + 500, { ...pos, x: 1 }, q), false, 'too soon');
assert.equal(wantKey(tw, T0 + 2000, { ...pos, x: 0.4 }, q), true, 'moved');
const turned = { x: 0, y: Math.sin((15 * Math.PI) / 360), z: 0, w: Math.cos((15 * Math.PI) / 360) };
assert.ok(Math.abs(turnDeg(q, turned) - 15) < 1e-6);
assert.equal(wantKey(tw, T0 + 2000, pos, turned), true, 'turned');
// the parts
assert.equal(flushDue(tw, T0 + 1000), false);
assert.ok(flushDue(tw, T0 + FLUSH_EVERY + 1));
const L = { fixes: [{ odo: 2, T: { theta: 0.5, tx: 1, ty: 2, s: 1 }, hits: 0.8, from: 'GPS' }], marks: [{ id: 'r', kind: 'ref', map: [3, 4], ar: [0, 1], y: -1.3, odo: 1 }] };
const w = { odo: 3, pins: [{ name: 'P1', at: { x: 1, y: -1.3, z: -2 }, anchorAt: null, odo: 2.5 }], checks: [] };
const parts = flush(tw, T0 + FLUSH_EVERY + 1, liveOf(L, w));
assert.deepEqual(parts.map((p) => p.name), ['meta.json', 'cloud-0000.bin', 'track-0000.bin', 'keys-0000.json', 'live.json', 'meta.json']);
const meta = JSON.parse(parts[5].body);
assert.deepEqual(meta.camera, { w: 640, h: 480 }, 'the camera size once pictures are taken');
const cloud = readCloud(parts[1].body);
assert.equal(cloud.length, 2); assert.equal(cloud[0].x, 1); assert.ok(Math.abs(cloud[0].t - 0.5) < 1e-6); assert.ok(Math.abs(cloud[0].ground + 1.4) < 1e-6);
const track = readTrack(parts[2].body);
assert.equal(track.length, 2); assert.equal(track[1].tracking, 'limited'); assert.ok(Math.abs(track[1].pos.z + 0.1) < 1e-6);
const keys = JSON.parse(parts[3].body);
assert.equal(keys[0].name, 'key-0000.jpg'); assert.equal(keys[0].proj.length, 16);
const live = JSON.parse(parts[4].body);
assert.equal(live.fixes[0].T.tx, 1); assert.deepEqual(live.marks[0].map, [3, 4]); assert.equal(live.pins[0].at.z, -2);
// no degrees and no address anywhere in what is sent
for (const p of parts) if (typeof p.body === 'string') assert.ok(!/"(lng|lat|latitude|longitude|address)"/.test(p.body), p.name);
// emptied; the next flush only what is new, numbered on
addPoints(tw, T0 + 20000, 4, [{ x: 5, y: 0, z: 0 }]);
assert.deepEqual(flush(tw, T0 + 40000).map((p) => p.name), ['cloud-0001.bin']);
// a cap on pictures
const tw2 = newTwin({ walk: 'x', started: T0 });
for (let i = 0; i < KEY_MAX; i++) addKey(tw2, T0 + i * 2000, i, { x: i, y: 0, z: 0 }, q, cam);
assert.equal(wantKey(tw2, T0 + 1e9, { x: -50, y: 0, z: 0 }, q), false, 'no more than KEY_MAX');
console.log('twin: ok');
// the viewer's sums: a point placed by the fix nearest in the walk, else the references; classed by its height
{
  const { placer, placeCloud, lineUp, kindOf } = await import('../lib/twin.js');
  assert.deepEqual([kindOf(0.1), kindOf(1), kindOf(3), kindOf(0.3), kindOf(NaN)], ['ground', 'stand', 'high', 'other', 'other']);
  const live = { fixes: [{ odo: 10, T: { theta: 0, tx: 100, ty: 50, s: 1 } }], marks: [] };
  const recs = [{ odo: 12, x: 1, y: 1, z: -2, ground: 0 }, { odo: 40, x: 0, y: 0, z: 0, ground: 0 }];
  const { pts, placed, unplaced } = placeCloud(recs, placer(live));
  assert.equal(placed, 1); assert.equal(unplaced, 1, 'past FIX_REACH and no references: not placed');
  assert.deepEqual([...pts], [101, 52, 1, 1]);
  assert.equal(placeCloud(recs, placer(live, 'refs')).placed, 0, 'references alone: none marked');
  const dist = { box: [100, 50, 104, 54], cell: 1, W: 4, H: 4, data: new Float32Array(16).fill(0.2) };
  assert.deepEqual(lineUp(pts, dist), { n: 1, within30cm: 1, medianM: Float32Array.of(0.2)[0] });
}
console.log('twin viewer sums: ok');
// ARCore's label with each point (app bridge 2): a labels part beside the cloud part, one pair per record, written
// only when a point had a label; the site takes it
{
  const { readLabels, LABELS } = await import('../lib/twin.js');
  const { PART } = await import('../src/twin.js');
  const tw = newTwin({ walk: 'l', started: T0 });
  addPoints(tw, T0 + 100, 1, [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0, label: 'building', lconf: 0.8, dconf: 0.3, spike: true }, { x: 2, y: 0, z: 0, label: 'sky', lconf: null }]);
  const parts = flush(tw, T0 + 20000);
  const cloud = parts.find((p) => p.name === 'cloud-0000.bin'), labels = parts.find((p) => p.name === 'labels-0000.bin');
  assert.ok(labels, 'a labels part with the cloud part');
  assert.ok(PART.test('labels-0000.bin'), 'the site keeps it');
  const recs = readCloud(cloud.body);
  assert.deepEqual(readLabels(labels.body, recs.length), [{ label: null, conf: null, depthConf: null, spike: false, geoDepth: false }, { label: 'building', conf: 204 / 255, depthConf: 77 / 255, spike: true, geoDepth: false }, { label: 'sky', conf: 0, depthConf: null, spike: false, geoDepth: false }]);
  assert.equal(readLabels(labels.body, recs.length + 1), null, 'a part of the wrong length is not trusted');
  assert.deepEqual(LABELS, (await import('../lib/track.js')).SEM_LABELS, 'the same labels, in the same order, as the app sends');
  addPoints(tw, T0 + 30000, 2, [{ x: 5, y: 0, z: 0 }]);
  assert.deepEqual(flush(tw, T0 + 40000).map((p) => p.name), ['cloud-0001.bin'], 'no labels part when nothing was labelled');
  addPoints(tw, T0 + 50000, 3, [{ x: 9, y: 0, z: 0, dconf: 0.9 }]);
  const p3 = flush(tw, T0 + 60000);
  assert.deepEqual(readLabels(p3[1].body, 1), [{ label: null, conf: null, depthConf: 230 / 255, spike: false, geoDepth: false }], 'depth confidence alone writes the part');
  addPoints(tw, T0 + 70000, 4, [{ x: 40, y: 0, z: 0, geoDepth: true }]);
  assert.equal(readLabels(flush(tw, T0 + 80000)[1].body, 1)[0].geoDepth, true, 'a Geospatial Depth point is flagged');
}
console.log('twin labels: ok');
