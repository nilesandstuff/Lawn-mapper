/**
 * The pressure at the heads, measured (lib/measured.js): a gauge, a throw, and every head from them.
 *   node water/test/measured.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inletFromGauge, inletFromThrow, spreadReadings } from '../lib/measured.js';
import { catalogue, sprayBodyId, unEnu, enu } from '../lib/heads.js';
import { headFlow } from '../lib/hydraulics.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const dir = new URL('../lib/heads/', import.meta.url);
const cat = catalogue(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'))));
const rvan = { body: sprayBodyId(4, null), nozzle: 'rb-r-van24', arc: 180 };

test('a throw read back through the chart gives the pressure that throws that far', () => {
  for (const psi of [30, 40, 45]) {
    const ft = headFlow(rvan, cat, psi).radiusFt;
    const got = inletFromThrow(rvan, ft, cat);
    assert.ok(Math.abs(got.psi - psi) < 0.5, `${psi} psi throws ${ft.toFixed(1)} ft, read back ${got.psi.toFixed(1)}`);
    assert.equal(got.edge, null);
  }
  // where the chart stops gaining throw (the R-VAN24 reaches 24 ft at 50 psi and holds it) a throw that far
  // says only "at least": flagged
  const top = inletFromThrow(rvan, 24, cat);
  assert.equal(top.edge, 'over'); assert.ok(Math.abs(top.psi - 50) < 0.5, `at least ${top.psi}`);
  // a head screwed down reads as if at the chart's low end (flagged), never a negative pressure
  assert.equal(inletFromThrow(rvan, 3, cat).edge, 'under');
});

test("a pitot reading on a regulated body is the nozzle's: under the setting, the inlet is that plus the regulator's need", () => {
  const reg = { ...rvan, body: sprayBodyId(4, 45) };
  const under = inletFromGauge(reg, { psi: 35, method: 'pitot' }, cat), at = inletFromGauge(reg, { psi: 45, method: 'pitot' }, cat);
  assert.ok(under.psi > 35 && !under.atLeast);
  assert.ok(at.atLeast && at.psi >= 45);
  assert.equal(inletFromGauge(rvan, { psi: 40, method: 'riser' }, cat).psi, 40);
});

test('every head from the readings: by height (downhill gains 0.433 psi a foot), nearest reading weighs most', () => {
  const o = [-85.5, 43];
  const heads = [{ id: 'a', at: unEnu(o, [0, 0]) }, { id: 'b', at: unEnu(o, [10, 0]) }, { id: 'c', at: unEnu(o, [20, 0]) }];
  // the ground falls 1 m (3.28 ft) a 10 m eastward
  const elev = (at) => -enu(o, at)[0] / 10;
  const dist = (p, q) => Math.hypot(...enu(p, q));
  const one = spreadReadings(heads, [{ id: 'a', at: heads[0].at, psi: 40 }], elev, dist);
  assert.equal(one.get('a').psi, 40);
  assert.ok(Math.abs(one.get('b').psi - (40 + 0.433 * 3.28084)) < 0.01, `b ${one.get('b').psi}`);
  const two = spreadReadings(heads, [{ id: 'a', at: heads[0].at, psi: 40 }, { id: 'c', at: heads[2].at, psi: 38 }], elev, dist);
  assert.ok(two.get('b').psi > 38 && two.get('b').psi < 42.9);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water measured: ${tests.length} passed`);
