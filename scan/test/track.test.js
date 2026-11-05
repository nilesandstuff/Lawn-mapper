// scan/lib/track.js: the pure parts of the tracking interface. node scan/test/track.test.js
import assert from 'node:assert/strict';
import { rankHits, trackingOf8w, engineChoice, CROSS, worldPointsOf } from '../lib/track.js';

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
console.log('track: ok');
