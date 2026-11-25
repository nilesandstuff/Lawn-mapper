// scan/lib/track.js: the pure parts of the tracking interface. node scan/test/track.test.js
import assert from 'node:assert/strict';
import { rankHits, trackingOf8w, engineChoice, CROSS, worldPointsOf, depthTypeOf } from '../lib/track.js';

// the crosshair is the exact centre, so one hit test serves both engines
assert.deepEqual(CROSS, { x: 0.5, y: 0.5 });

// 8th Wall's hit estimates: a found surface first, then an estimated one, then the nearest point; noise dropped
{
  const from = { x: 0, y: 1.5, z: 0 };
  const r = rankHits([
    { type: 'FEATURE_POINT', position: { x: 0, y: 0, z: -2 }, distance: 2.5 },
    { type: 'ESTIMATED_SURFACE', position: { x: 0, y: 0, z: -2.1 }, distance: 2.6 },
    { type: 'FEATURE_POINT', position: { x: 0, y: 0, z: -1 }, distance: 1.8 },
  ], from);
  assert.equal(r.type, 'ESTIMATED_SURFACE');
  const pts = rankHits([
    { type: 'FEATURE_POINT', position: { x: 0, y: 0, z: -2 }, distance: 2.5 },
    { type: 'FEATURE_POINT', position: { x: 0, y: 0, z: -1 }, distance: 1.8 },
  ], from);
  assert.equal(pts.distance, 1.8, 'the nearest point');
  assert.equal(rankHits([{ type: 'FEATURE_POINT', position: { x: 0, y: 0, z: -0.1 }, distance: 0.1 }], from), null, 'too close is noise');
  assert.equal(rankHits([{ type: 'FEATURE_POINT', position: { x: 0, y: 0, z: -40 }, distance: 40 }], from), null, 'too far is noise');
  assert.equal(rankHits([], from), null);
  assert.equal(rankHits(null, from), null);
  const noD = rankHits([{ type: 'DETECTED_SURFACE', position: { x: 0, y: 0, z: -2 } }], from);
  assert.ok(Math.abs(noD.distance - 2.5) < 1e-9, 'a distance worked out from the camera when the engine gives none');
}
// the engine's two words for tracking, and what they mean to us
{
  assert.equal(trackingOf8w('NORMAL', 'UNSPECIFIED'), 'normal');
  assert.equal(trackingOf8w('LIMITED', 'INITIALIZING'), 'lost');
  assert.equal(trackingOf8w('LIMITED', 'UNSPECIFIED'), 'limited');
}
// which engines to offer
{
  assert.deepEqual(engineChoice({ hasXR: true, has8w: true }), { offered: ['webxr', '8thwall'], start: 'webxr' });
  assert.deepEqual(engineChoice({ hasXR: false, has8w: true, ios: true }), { offered: ['8thwall'], start: '8thwall' });
  assert.deepEqual(engineChoice({ hasXR: true, has8w: true, prefer: '8thwall' }), { offered: ['webxr', '8thwall'], start: '8thwall' });
  assert.deepEqual(engineChoice({ hasXR: false, has8w: false, ios: true }), { offered: [], start: null, why: 'no8w-ios' });
  assert.deepEqual(engineChoice({}), { offered: [], start: null, why: 'none' });
}
// 8th Wall's world points: confident, finite ones, as plain session points
{
  const w = worldPointsOf([{ confidence: 0.9, position: { x: 1, y: 0.2, z: -3 } }, { confidence: 0.2, position: { x: 2, y: 0, z: -1 } }, { confidence: 0.8, position: { x: NaN, y: 0, z: 0 } }, { x: 0.5, y: 1, z: -2 }]);
  assert.deepEqual(w, [{ x: 1, y: 0.2, z: -3 }, { x: 0.5, y: 1, z: -2 }]);
  assert.deepEqual(worldPointsOf(null), []);
}
// the depth type is the session's (the spec), not the frame's
assert.equal(depthTypeOf({ depthType: 'raw', depthUsage: 'cpu-optimized', depthDataFormat: 'luminance-alpha' }), 'raw (cpu-optimized, luminance-alpha)');
assert.equal(depthTypeOf({ depthType: 'smooth' }), 'smooth');
assert.match(depthTypeOf({ depthType: null }), /^not said/);
assert.match(depthTypeOf({}), /^not said/);
console.log('track: ok');

// bridge 5: the app's occlusion picture ("w,h,t,<base64 bytes>") as the drawer takes it
{
  const { occFromBridge } = await import('../lib/track.js');
  const bytes = Uint8Array.from([0, 1, 128, 255, 7, 9]);
  const o = occFromBridge(`3,2,12.5,${Buffer.from(bytes).toString('base64')}`, 51);
  assert.deepEqual([o.w, o.h, o.t, o.range], [3, 2, 12.5, 51]); assert.deepEqual(Array.from(o.data), Array.from(bytes));
  assert.equal(occFromBridge('', 51), null); assert.equal(occFromBridge('3,3,1,AAAA', 51), null, 'a picture of the wrong size is refused');
  console.log('track (occlusion picture): ok');
}

// THE APP'S PICTURE WITHOUT UNPACKING ALL OF IT (2026-11-25): one pixel read from its own letters of base64 is the
// pixel the whole unpacking gives, at every offset's remainder
{ const { pictureOf } = await import('../lib/track.js');
  const w = 7, h = 5, raw = new Uint8Array(w * h * 4); for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + 11) & 255;
  const b64 = (u) => Buffer.from(u).toString('base64');
  const str = `{"w":${w},"h":${h},"t":1.5,"view":[1,0,0,0],"proj":[2,0,0,0],"rgba":"${b64(raw)}","jpeg":"${b64(Uint8Array.from([255, 216, 1, 2, 3]))}"}`;
  const g = pictureOf(str);
  assert.equal(g.w, w); assert.equal(g.h, h); assert.deepEqual(g.proj, [2, 0, 0, 0]);
  for (let k = 0; k < w * h; k++) assert.deepEqual(g.rgb(k), [raw[k * 4], raw[k * 4 + 1], raw[k * 4 + 2]], `pixel ${k}`);
  assert.deepEqual([...g.pixels], [...raw], 'and the whole, when asked for');
  const jb = new Uint8Array(await (await g.blob).arrayBuffer()); assert.deepEqual([...jb], [255, 216, 1, 2, 3]);
  assert.equal(pictureOf('null'), null); assert.equal(pictureOf(''), null); }
console.log('track (the app\'s picture, a pixel at a time): ok');
