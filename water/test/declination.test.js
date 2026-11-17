/**
 * Magnetic declination (water/lib/declination.js, the World Magnetic Model 2025) against the model's own published
 * test values, and a compass bearing turned to true north.
 *   node water/test/declination.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { declination, trueBearing } from '../lib/declination.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok  ${name}`); }

test('every one of the model\'s 100 test values, to its two decimals', () => {
  const rows = readFileSync(new URL('./data/wmm2025-test-values.txt', import.meta.url), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.equal(rows.length, 100);
  for (const l of rows) {
    const [y, alt, lat, lng, want] = l.trim().split(/\s+/).map(Number);
    assert.ok(Math.abs(declination(lat, lng, y, alt) - want) < 0.006, `${lat},${lng}: ${declination(lat, lng, y, alt).toFixed(3)} not ${want}`);
  }
});

test('a compass bearing to true north: west declination subtracts, east adds, wrapped to 0-360', () => {
  const t = Date.UTC(2026, 10, 17);
  const west = declination(41.9, -87.6, 2026.88), east = declination(47.6, -122.3, 2026.88); // Chicago, Seattle
  assert.ok(west < -3 && west > -9, `${west}`); assert.ok(east > 13 && east < 17, `${east}`);
  assert.ok(Math.abs(trueBearing(0, 41.9, -87.6, t) - (360 + west)) < 0.05);
  assert.ok(Math.abs(trueBearing(90, 47.6, -122.3, t) - (90 + east)) < 0.05);
});

console.log(`${passed} passed`);
