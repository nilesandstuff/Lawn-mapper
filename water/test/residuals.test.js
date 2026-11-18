/** The model's knobs nudged (lib/residuals.js): each moves a sunny afternoon's surface the way the physics says. */
import assert from 'node:assert/strict';
import { NUDGES, KNOBS, KNOB_WHAT, SQUARE_COLS, rowOf } from '../lib/residuals.js';
import { stepColumn, columnProps } from '../lib/soiltemp.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const props = columnProps({ sand: 40, clay: 20 }, 15, 0.8);
const T0 = new Float64Array(8).fill(12);
const f = { swNet: 450, rnIso: 330, ta: 18, ra: 70, beta: 0.5, fence: 20, paving: 15, air: -0.8, tBottom: 10 };
const ts = (g, dT = 0) => stepColumn(Float64Array.from(T0, (v) => v + dT), props, g, 600).ts;
const base = ts(f);
const J = Object.fromEntries(NUDGES.map((n) => [n.key, ts(n.apply(f)) - base]));

test('every knob is described; the columns and the knobs do not overlap', () => {
  for (const k of KNOBS) assert.ok(KNOB_WHAT[k], k);
  assert.equal(new Set([...SQUARE_COLS, ...KNOBS.map((k) => `J_${k}`)]).size, SQUARE_COLS.length + KNOBS.length);
});

test('a sunny afternoon: more sun, sky, paving, fences and warmer air warm it; more wind and evaporation cool it', () => {
  for (const k of ['sun', 'paving', 'fence', 'air']) assert.ok(J[k] > 0, `${k} ${J[k]}`);
  for (const k of ['wind', 'evap']) assert.ok(J[k] < 0, `${k} ${J[k]}`);
  assert.ok(J.air > 0.2 && J.air < 1.2, `air ${J.air}`);
  assert.ok(J.sun > J.paving, 'ten percent of the sun moves it more than ten percent of the paving');
  assert.ok(J.treecool < 0, 'more of the trees\' cooling: cooler');
  assert.ok(ts(f, 1) > base, 'warmer soil, warmer surface');
});

test('rows rounded, and missing values kept as null', () => {
  assert.deepEqual(rowOf({ a: 1.23456, b: NaN }, ['a', 'b', 'c']), [1.235, null, null]);
});

console.log(`\n${passed} passed`);
