// public/lib/predictions-overture.js: the frame's box, the layer list, the caption.
import assert from 'node:assert/strict';
import { OVERTURE_LAYERS, withOverture, linesText, frameBox } from '../public/lib/predictions-overture.js';

{
  // a 640-logical-pixel frame at zoom 19 (512 px tiles) at the equator is about 95 m across
  const { box, k } = frameBox({ lng: 0, lat: 0, zoom: 19, size: 640 });
  const w = box[2] - box[0], h = box[3] - box[1];
  assert.ok(Math.abs(w - 95.4) < 0.5 && Math.abs(w - h) < 1e-6, `${w} x ${h}`);
  assert.ok(Math.abs(box[0] + w / 2) < 1e-6 && Math.abs(box[1] + h / 2) < 1e-6, 'centred on the frame');
  assert.equal(k, 1);
  const tall = frameBox({ lng: 0, lat: 45, zoom: 19, size: 640, height: 320 });
  assert.ok(Math.abs((tall.box[3] - tall.box[1]) / (tall.box[2] - tall.box[0]) - 0.5) < 1e-6 && Math.abs(tall.k - Math.SQRT1_2) < 1e-9, 'height honoured, cos(lat) given');
}
{
  const run = [{ id: 'truth' }, { id: 'roof' }, { id: 'shapes' }, { id: 'line' }];
  const defs = withOverture(run);
  assert.deepEqual(defs.map((l) => l.id), ['truth', 'roof', 'ovtRoad', 'ovtWalk', 'shapes', 'line'], 'under the outline and the property line');
  assert.deepEqual(withOverture(defs).map((l) => l.id), defs.map((l) => l.id), 'added once');
  assert.deepEqual(withOverture([{ id: 'truth' }]).map((l) => l.id), ['truth', ...OVERTURE_LAYERS.map((l) => l.id)], 'at the end when there is no outline');
  assert.ok(OVERTURE_LAYERS.every((l) => l.client && l.colour.length === 3 && l.label));
  assert.ok(!OVERTURE_LAYERS.some((l) => /building/i.test(l.id)), 'no building layer (owner, 2026-10-20)');
}
{
  assert.equal(linesText(0, 0), 'No road or sidewalk line from OpenStreetMap (via Overture) over this frame.');
  assert.match(linesText(1, 2), /^1 road centreline, 2 sidewalk or path lines from OpenStreetMap via Overture\./);
  assert.match(linesText(3, 0), /not always its middle\.$/);
}
console.log('predictions-overture: ok');
