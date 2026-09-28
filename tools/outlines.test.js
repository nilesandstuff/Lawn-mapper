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
  // Past the cap a move is HELD at it, never dropped (a 15 m cap once threw
  // the owner's longer drags away silently); only a non-number is refused.
  const far = reviewExample(doc, { shift: { east: MAX_SHIFT_M + 25, north: -(MAX_SHIFT_M + 5) }, shifts: { 0: { east: 'x', north: 1 }, 1: { east: 22.5, north: -18 } } });
  assert.deepEqual(far.shift, { east: MAX_SHIFT_M, north: -MAX_SHIFT_M, source: 'person' });
  assert.equal(far.features[0].properties.shift, undefined);
  assert.deepEqual(far.features[1].properties.shift, { east: 22.5, north: -18 }, 'a 20 m move is kept as it was made');
  assert.ok(MAX_SHIFT_M >= 50);
  assert.equal(reviewExample(doc, { shift: { east: 2, north: 0, source: 'anything' } }).shift.source, 'person');
  console.log('PASS  examples: outline shifts kept in metres, held at the cap never dropped, zero cleared');
}

// An outline counts only if some of it is inside the photo -- not when just
// its box touches (a winding stream beside the frame, an L-shaped pond).
{
  const { touchesPhoto } = await import('../public/outlines.js');
  const sq = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
  assert.equal(touchesPhoto(sq(10, 10, 20, 20), 100, 100), true, 'inside');
  assert.equal(touchesPhoto(sq(-50, -50, 200, 200), 100, 100), true, 'covers the whole photo');
  assert.equal(touchesPhoto(sq(-10, 40, 110, 60), 100, 100), true, 'a band straight across');
  assert.equal(touchesPhoto(sq(120, 0, 150, 100), 100, 100), false, 'beside it');
  // An L whose box covers the photo but whose arms go round it.
  const L = [[[-50, -50], [-10, -50], [-10, 150], [150, 150], [150, 190], [-50, 190], [-50, -50]]];
  assert.equal(touchesPhoto(L, 100, 100), false, 'an L round the outside');
  console.log('PASS  an outline counts only where some of it is in the photo');
}

// Only what the owner saw and kept at review is ever taught; a shape that
// turns up in the file afterwards is not, and an example already saved is
// never written over by a later fetch.
{
  const { reviewExample, keptOutlines } = await import('../worker/src/outlines.js');
  const { alreadySaved } = await import('./not-lawn-examples.js');
  const doc = { features: [{ properties: { class: 'water' } }, { properties: { class: 'road' } }, { properties: { class: 'building' } }] };
  const ok = reviewExample(doc, { status: 'approved', dropped: [1] });
  assert.deepEqual(keptOutlines(ok).map((f) => f.properties.class), ['water', 'building']);
  assert.deepEqual(keptOutlines(reviewExample(doc, { status: 'draft' })), [], 'a draft teaches nothing');
  assert.deepEqual(keptOutlines(reviewExample(doc, { status: 'rejected' })), [], 'a rejected example teaches nothing');
  const grown = { ...ok, features: [...ok.features, { properties: { class: 'pool' } }] };
  assert.deepEqual(keptOutlines(grown), [], 'an outline added after review voids the example rather than slipping in');
  assert.equal(alreadySaved('water-001', () => ({ ok: true, err: '' })), true);
  assert.equal(alreadySaved('water-001', () => ({ ok: false, err: 'The specified key does not exist.' })), false);
  assert.throws(() => alreadySaved('water-001', () => ({ ok: false, err: 'Authentication error' })));
  console.log('PASS  examples: only outlines kept at review are taught; a saved example is never written over');
}
{
  const { keptOutlines } = await import('../worker/src/outlines.js');
  const early = { status: 'approved', reviewedAt: '2026-09-28T09:00:00Z', features: [{ properties: { class: 'water' } }, { properties: { class: 'road', dropped: true } }] };
  assert.deepEqual(keptOutlines(early).map((f) => f.properties.class), ['water']);
  console.log('PASS  examples approved before the review record keep what was kept then');
}

// The viewer's filter: to review / approved / rejected / all, and stepping
// wraps within the filter.
{
  const { shown, stepIn } = await import('../public/outlines.js');
  const list = [{ status: 'approved' }, { status: 'draft' }, { status: 'approved' }, { status: 'rejected' }, { status: 'draft' }];
  assert.deepEqual(shown(list, 'approved'), [0, 2]);
  assert.deepEqual(shown(list, 'draft'), [1, 4]);
  assert.deepEqual(shown(list, 'all'), [0, 1, 2, 3, 4]);
  assert.equal(stepIn(list, 'approved', 0, 1), 2);
  assert.equal(stepIn(list, 'approved', 2, 1), 0, 'wraps');
  assert.equal(stepIn(list, 'approved', 0, -1), 2, 'wraps backwards');
  assert.equal(stepIn(list, 'draft', 2, 1), 4, 'from outside the filter, the next one in it');
  assert.equal(stepIn([], 'draft', 0, 1), -1);
  console.log('PASS  viewer: the filter lists the right examples and stepping stays inside it');
}
