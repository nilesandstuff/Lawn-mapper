// scan/lib/semantics.js: ARCore's labels and anchors on the page. node scan/test/semantics.test.js
import assert from 'node:assert/strict';
import { keepPoint, viewFromSem, newSemCount, noteSem, semSummary, newCrumbs, crumbDue, addCrumb, crumbMoves, CRUMB_M, CRUMB_MAX } from '../lib/semantics.js';
import { depthFromGrid, SEM_LABELS } from '../lib/track.js';

// people and cars are dropped when ARCore is sure; everything else kept
assert.equal(keepPoint('person', 0.9), false); assert.equal(keepPoint('vehicle', 0.6), false);
assert.equal(keepPoint('vehicle', 0.2), true, 'unsure: kept'); assert.equal(keepPoint('building', 0.9), true); assert.equal(keepPoint(null, null), true);

// the nudges' views from the label shares
assert.deepEqual([viewFromSem({ sky: 0.3, building: 0.2 }, 5).sky, viewFromSem({ sky: 0.3, building: 0.2 }, 5).pave], [true, false]);
assert.equal(viewFromSem({ sky: 0.3, building: 0.01 }, 5).sky, false, 'open sky with nothing against it is no skyline');
assert.equal(viewFromSem({ sky: 0.3, building: 0.2 }, -30).sky, false, 'looking down');
assert.equal(viewFromSem({ road: 0.1, sidewalk: 0.1 }, -30).pave, true);
assert.equal(viewFromSem(null), null);

// counting, and the alignment check
{
  const c = newSemCount();
  noteSem(c, 'sky', 0.9, 0); noteSem(c, 'sky', 0.9, 3); noteSem(c, 'terrain', 0.8, 2); noteSem(c, 'tree', 0.1, 5); noteSem(c, null, null, 1);
  const s = semSummary(c);
  assert.equal(s.cells, 4); assert.equal(s.sure, 0.75); assert.equal(s.by.sky, 0.667); assert.equal(s.skyWithNearDepth, 0.5);
  assert.equal(semSummary(newSemCount()), null);
}

// the grid's labels as the page reads them
{
  const g = { kind: 'raw', nx: 2, ny: 1, t: 5, p: [0, 0, -1, null, null, null], d: [1, 0], c: [255, 0], l: [2, 1], lc: [200, 100] };
  const d = depthFromGrid(g);
  assert.equal(d.label(0.1, 0.5), 'building'); assert.equal(d.label(0.9, 0.5), 'sky'); assert.ok(Math.abs(d.labelConf(0.9, 0.5) - 100 / 255) < 1e-9);
  assert.equal(depthFromGrid({ ...g, l: undefined, lc: undefined }).label, null);
  assert.equal(SEM_LABELS[11], 'water');
}

// the drift log
{
  const c = newCrumbs();
  assert.ok(crumbDue(c, 0));
  addCrumb(c, 1, { x: 0, y: 1.5, z: 0 }, 0);
  assert.equal(crumbDue(c, CRUMB_M - 1), false); assert.ok(crumbDue(c, CRUMB_M));
  addCrumb(c, 2, { x: 0, y: 1.5, z: -10 }, 10);
  addCrumb(c, null, { x: 0, y: 1.5, z: -20 }, 20);
  addCrumb(c, 3, { x: 0, y: 1.5, z: -30 }, 30);
  const now = { 1: { x: 0, y: 1.5, z: 0 }, 2: { x: 0.3, y: 1.5, z: -10.4 }, 3: null };
  const m = crumbMoves(c, (h) => now[h]);
  assert.equal(m.n, 3); assert.equal(m.held, 2); assert.equal(m.lost, 1); assert.equal(m.refused, 1);
  assert.equal(m.maxM, 0.5); assert.equal(m.maxLevelM, 0.5); assert.equal(m.worstOdo, 10);
  const full = newCrumbs(); for (let i = 0; i < CRUMB_MAX; i++) addCrumb(full, i + 1, { x: 0, y: 0, z: 0 }, i * CRUMB_M);
  assert.equal(crumbDue(full, 1e6), false, 'capped');
}
console.log('semantics: ok');
