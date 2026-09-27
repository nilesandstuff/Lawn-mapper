import assert from 'node:assert/strict';
import { bboxOfFrame, outlineFile } from './fetch-outlines.js';
import { outlineKey, idOfOutlineKey, applyReview } from '../worker/src/outlines.js';

const id = '-85.60000,42.90000:sam3:manual';

// The tool's file name and the worker's key name the same object.
assert.equal(`outlines/${outlineFile(id)}`, outlineKey(id));
assert.equal(idOfOutlineKey(outlineKey(id)), id);
assert.equal(idOfOutlineKey('corpus/x.png'), null);
console.log('PASS  the fetch tool and the worker agree on where a map\'s outlines live');

// The box covers the frame's own corners.
{
  const frame = { lng: -85.6, lat: 42.9, zoom: 19, size: 640, height: 480 };
  const [w, s, e, n] = bboxOfFrame(frame);
  assert.ok(w < -85.6 && e > -85.6 && s < 42.9 && n > 42.9);
  assert.ok(e - w > n - s, 'a wide frame gives a wide box');
  console.log('PASS  the box is the photograph\'s frame');
}

// Review: keep or drop by index only; nothing can be added; status is one of two.
{
  const stored = { id, status: 'draft', features: [
    { type: 'Feature', properties: { class: 'building' }, geometry: { type: 'Polygon', coordinates: [] } },
    { type: 'Feature', properties: { class: 'water' }, geometry: { type: 'Polygon', coordinates: [] } },
  ] };
  const out = applyReview(stored, { dropped: [1, 7, -1, 'x'], status: 'approved',
    features: [{ injected: true }] });
  assert.equal(out.status, 'approved');
  assert.equal(out.features.length, 2);
  assert.equal(out.features[0].properties.dropped, undefined);
  assert.equal(out.features[1].properties.dropped, true);
  assert.equal(applyReview(stored, { status: 'whatever' }).status, 'draft');
  console.log('PASS  a review keeps or drops what was fetched and cannot add to it');
}
