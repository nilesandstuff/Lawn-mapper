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

// Not-lawn examples: ids are shape-checked, kept outlines counted by kind,
// a review approves, rejects or leaves a draft, and the page's totals add up.
{
  const { isExampleId, exampleKey, keptByClass, reviewExample } = await import('../worker/src/outlines.js');
  const { approvedTotals } = await import('../public/outlines.js');
  assert.equal(isExampleId('water-001'), true);
  assert.equal(isExampleId('../corpus/x'), false);
  assert.equal(isExampleId('water-1'), false);
  assert.equal(exampleKey('pool-015'), 'examples/pool-015.json');
  const doc = { features: [
    { properties: { class: 'water', target: true } }, { properties: { class: 'building' } },
    { properties: { class: 'building' } }, { properties: { class: 'road' } },
  ] };
  const saved = reviewExample(doc, { status: 'approved', dropped: [3] });
  assert.equal(saved.status, 'approved');
  assert.deepEqual(keptByClass(saved), { water: 1, building: 2 });
  assert.equal(reviewExample(doc, { status: 'rejected' }).status, 'rejected');
  assert.equal(reviewExample(doc, { status: 'publish' }).status, 'draft');
  const t = approvedTotals([
    { status: 'approved', kept: { water: 1, building: 2 } },
    { status: 'approved', kept: { water: 1 } },
    { status: 'rejected', kept: { water: 1 } },
    { status: 'draft', kept: {} },
  ]);
  assert.deepEqual(t, { examples: 2, kept: { water: 2, building: 2 } });
  console.log('PASS  examples: ids checked, kinds counted, approvals and rejections kept apart');
}

// Outlines moved onto the photograph: a whole-example shift and per-outline
// drags are kept in metres, bounded, and a zero or absurd one is dropped.
{
  const { reviewExample, MAX_SHIFT_M } = await import('../worker/src/outlines.js');
  const doc = { features: [{ properties: { class: 'water' } }, { properties: { class: 'building', shift: { east: 1, north: 1 } } }] };
  const s = reviewExample(doc, { status: 'draft', shift: { east: 1.234, north: -0.5, source: 'auto' }, shifts: { 0: { east: 0.25, north: 0 }, 1: { east: 0, north: 0 } } });
  assert.deepEqual(s.shift, { east: 1.23, north: -0.5, source: 'auto' });
  assert.deepEqual(s.features[0].properties.shift, { east: 0.25, north: 0 });
  assert.equal(s.features[1].properties.shift, undefined, 'a drag put back to zero is cleared');
  const far = reviewExample(doc, { shift: { east: MAX_SHIFT_M + 1, north: 0 }, shifts: { 0: { east: 'x', north: 1 } } });
  assert.equal(far.shift, undefined);
  assert.equal(far.features[0].properties.shift, undefined);
  assert.equal(reviewExample(doc, { shift: { east: 2, north: 0, source: 'anything' } }).shift.source, 'person');
  console.log('PASS  examples: outline shifts kept in metres, bounded, zero cleared');
}
