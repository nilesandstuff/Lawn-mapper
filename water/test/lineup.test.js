/** Field readings lined up with the test map of their lot, by place (lib/lineup.js). Made-up lots near a generic place. */
import assert from 'node:assert/strict';
import { placeOf, homeFor, lineUp, saveShape, TOL_M } from '../lib/lineup.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
// two 30 m square lots side by side, and a third 4 km away
const M = 1 / 111320, k = Math.cos((41.88 * Math.PI) / 180);
const lot = (e0, n0) => ({ type: 'Polygon', coordinates: [[[e0, n0], [e0 + (30 * M) / k, n0], [e0 + (30 * M) / k, n0 + 30 * M], [e0, n0 + 30 * M], [e0, n0]]] });
const A = lot(-87.63, 41.88), B = lot(-87.63 + (30 * M) / k, 41.88), C = lot(-87.58, 41.88);
const mid = (g) => [g.coordinates[0][0][0] + (15 * M) / k, g.coordinates[0][0][1] + 15 * M];
const saves = [
  saveShape('save-a', { at: '2026-11-10T00:00:00Z', parcel: { type: 'Feature', properties: { pin: 'PIN-A' }, geometry: A } }),
  saveShape('save-b', { at: '2026-11-12T00:00:00Z', parcel: B }),
];

test('a visit\'s place: the middle of its readings, else where the phone stood', () => {
  assert.deepEqual(placeOf({ lng: 1, lat: 2 }, [{ lng: 0, lat: 0 }, { lng: 2, lat: 4 }]), [1, 2]);
  assert.deepEqual(placeOf({ lng: 5, lat: 6 }, []), [5, 6]);
  assert.equal(placeOf({}, []), null);
});

test('the lot that holds it, a few metres over its line still its own, the newest of two saves of a lot', () => {
  assert.equal(homeFor(mid(A), null, saves), 'save-a');
  assert.equal(homeFor(mid(B), null, saves), 'save-b');
  const justOut = [A.coordinates[0][0][0] - ((TOL_M / 2) * M) / k, mid(A)[1]];
  assert.equal(homeFor(justOut, null, saves), 'save-a');
  assert.equal(homeFor(mid(C), null, saves), null);
  const again = [...saves, saveShape('save-a2', { at: '2026-11-15T00:00:00Z', parcel: A })];
  assert.equal(homeFor(mid(A), null, again), 'save-a2');
  // by parcel number when the place is not inside any line; by the lawn when a save has no line
  assert.equal(homeFor(mid(C), 'PIN-A', saves), 'save-a');
  assert.equal(homeFor(mid(C), null, [saveShape('save-c', { shapes: [{ type: 'Feature', geometry: C }] })]), 'save-c');
});

test('the moves: onto its lot\'s test map, off another lot\'s, left alone where it belongs; the rest wait', () => {
  const r = (g) => [{ lng: mid(g)[0], lat: mid(g)[1] }];
  const { moves, waiting } = lineUp([
    { id: 'on-plain', map_id: 'plain-map', readings: r(A) },            // on an ordinary map of lot A: to its test map
    { id: 'loose', map_id: null, readings: r(B) },                       // taken where no map was chosen: to lot B's
    { id: 'swapped', map_id: 'save-a', readings: r(C) },                 // 4 km off the test map it is on: taken off it
    { id: 'home', map_id: 'save-b', readings: r(B) },                    // already home
    { id: 'far-plain', map_id: 'plain-map', readings: r(C) },            // no test map of its lot: left on its map, waiting
  ], saves);
  assert.deepEqual(moves, [{ id: 'on-plain', from: 'plain-map', to: 'save-a' }, { id: 'loose', from: null, to: 'save-b' }, { id: 'swapped', from: 'save-a', to: null }]);
  assert.deepEqual(waiting, ['swapped', 'far-plain']);
});

console.log(`\n${passed} passed`);
