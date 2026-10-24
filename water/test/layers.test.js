/**
 * Drains and water from the county's and the nation's maps (lib/layers.js): the copy kept with the map, the
 * box asked for, what the page says, and a tap. Made-up shapes with known answers.
 *   node water/test/layers.test.js
 */

import assert from 'node:assert/strict';
import { compact, askBox, freshEnough, summary, pick, intakesNear, distanceM, enuOf } from '../lib/layers.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const O = [-85.6, 42.9];
const at = (e, n) => [O[0] + (e / (6378137 * Math.cos((O[1] * Math.PI) / 180))) * (180 / Math.PI), O[1] + (n / 6378137) * (180 / Math.PI)];
const square = (e0, n0, e1, n1) => ({ type: 'Polygon', coordinates: [[at(e0, n0), at(e1, n0), at(e1, n1), at(e0, n1), at(e0, n0)]] });
const answer = (extra = {}) => ({
  box: [-85.61, 42.89, -85.59, 42.91],
  layers: [
    { kind: 'flood_zone', from: 'national', source: 'FEMA', title: 'Flood Hazard Zones', features: [{ type: 'Feature', geometry: square(-5, -5, 5, 5), properties: { FLD_ZONE: 'AE', SFHA_TF: 'T', OBJECTID: 7 } }] },
    { kind: 'storm_main', from: 'county', source: 'Kent County, MI', title: 'Storm Mains', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [at(-50, 30), at(50, 30)] }, properties: { DIAMETER: 12, MATERIAL: 'RCP', SUBTYPE: 4 } }] },
    { kind: 'storm_inlet', from: 'county', source: 'Kent County, MI', title: 'Storm Inlets', features: Array.from({ length: 40 }, (_, k) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: at(20 + k * 5, 30) }, properties: { TOP_OF_CASTING: 806.612, SUBTYPE: 15, FACILITYID: 'X' } })) },
    { kind: 'watershed', from: 'county', source: 'Kent County, MI', title: 'Watersheds', features: [{ type: 'Feature', geometry: square(-500, -500, 500, 500), properties: { NAME: 'Plaster Creek' } }] },
  ],
  failed: [], ...extra,
});

test('the kept copy: only the fields the page reads, coordinates to 0.1 m, complete only when every source answered', () => {
  const c = compact(answer(), { centre: O });
  const inlet = c.layers.find((l) => l.kind === 'storm_inlet').features[0];
  assert.deepEqual(inlet.p, { TOP_OF_CASTING: 806.61 }, 'no ids, no coded subtypes');
  assert.ok(inlet.g.coordinates.every((v) => Math.abs(v * 1e6 - Math.round(v * 1e6)) < 1e-6));
  assert.equal(c.complete, true); assert.deepEqual(c.sources, ['FEMA', 'Kent County, MI']);
  const part = compact(answer({ pending: [{ title: 'Flowline - Large Scale' }] }), { centre: O });
  assert.equal(part.complete, false); assert.deepEqual(part.failed, ['Flowline - Large Scale']);
  assert.equal(freshEnough(c), true); assert.equal(freshEnough(part), false);
  assert.equal(freshEnough(c, Date.now() + 31 * 86400000), false, 'a month old: asked again');
});

test('past its budget the least useful kind goes first, its farthest features first', () => {
  const full = compact(answer(), { centre: O });
  const small = compact(answer(), { centre: O, budget: JSON.stringify(full).length - 150 });
  assert.ok(JSON.stringify(small).length <= JSON.stringify(full).length - 150);
  assert.ok(!small.layers.some((l) => l.kind === 'watershed'), 'the watershed goes before any inlet');
  assert.equal(small.layers.find((l) => l.kind === 'storm_inlet').features.length, 40);
  const tiny = compact(answer(), { centre: O, budget: 2500 });
  const kept = tiny.layers.find((l) => l.kind === 'storm_inlet')?.features || [];
  assert.ok(kept.length < 40 && tiny.trimmed > 0);
  // the nearest inlets are the ones kept
  const far = Math.max(...kept.map((f) => Math.hypot(...enuOf(O, f.g.coordinates))));
  assert.ok(far <= 20 + kept.length * 5 + 0.5, `kept out to ${far.toFixed(0)} m`);
});

test('the box asked for is the map\'s, at most 1,100 m across', () => {
  const b = askBox([-85.62, 42.88, -85.58, 42.92]); // about 3.3 x 4.4 km
  const [we] = enuOf([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], [b[2], (b[1] + b[3]) / 2]);
  assert.ok(Math.abs(2 * we - 1100) < 2, `${2 * we}`);
  const small = [-85.601, 42.899, -85.599, 42.901];
  assert.deepEqual(askBox(small), small.map((v) => +v.toFixed(6)));
});

test('what the page says: the nearest inlet to the lawn, a flood zone on it, distances to a line and inside an area', () => {
  const c = compact(answer(), { centre: O });
  const lawn = [[at(-10, -10), at(10, -10), at(10, 10), at(-10, 10), at(-10, -10)]];
  const lines = summary(c, { lawn, mid: O });
  assert.match(lines[0], /40 inlets/); assert.match(lines[0], /nearest inlet is about 73 ft/); // at 20 m east, 30 north; the lawn's corner at (10, 10): 22.4 m
  assert.ok(lines.some((t) => /flood hazard zone \(AE\)/.test(t)));
  assert.equal(distanceM(O, square(-5, -5, 5, 5)), 0);
  assert.ok(Math.abs(distanceM(O, { type: 'LineString', coordinates: [at(-50, 30), at(50, 30)] }) - 30) < 0.01);
});

test('a tap finds the inlet under the finger before the area round it; a low spot with an inlet in it is a drain', () => {
  const c = compact(answer(), { centre: O });
  assert.equal(pick(c, at(21, 30), 3).kind, 'storm_inlet');
  assert.equal(pick(c, at(0, 0), 3).kind, 'flood_zone');
  assert.equal(pick(c, at(0, 200), 3)?.kind, 'watershed');
  assert.equal(intakesNear(c, at(40, 31), 3)[0].kind, 'storm_inlet');
  assert.equal(intakesNear(c, at(-30, -30), 3).length, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water layers: ${tests.length} passed`);
