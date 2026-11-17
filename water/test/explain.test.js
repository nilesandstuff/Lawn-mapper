/**
 * What is behind one spot's prediction (water/lib/explain.js), shared by the admin's explorer and, later, the public
 * view (TODO 30): the energy balances, nothing is left without a kind, and the page's formats.
 *   node water/test/explain.test.js
 */
import assert from 'node:assert/strict';
import { surfaceExplain, soilExplain, windExplain, moistureExplain, fmt } from '../lib/explain.js';
import { momentOf, forcingAt } from '../lib/surfacenow.js';
import { columnProps, stepColumn, skinParts, CENTRES } from '../lib/soiltemp.js';
import { PARAMS } from '../lib/balance.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok  ${name}`); }

const model = { params: PARAMS, rad: null, fenceHeat: null, edgeHeat: null, canopy: null, winds: [1], windAt: null };
const w = momentOf({ t: Date.UTC(2026, 6, 15, 17, 40), lat: 42.5, lng: -85.5, ta: 28, rh: 50, wind: 2, cloud: 0.2 });
const f = forcingAt(model, 0, 0.7, w, { month: 6, ks: 0.8 });
const props = columnProps({ sand: 40, clay: 20 }, 15, 0.8);
const T = Float64Array.from(CENTRES, () => 20);
const ts = stepColumn(T, props, { ...f, tBottom: 12 }, 3600).ts;
const parts = skinParts(T[0], f, ts);
const a = { ts, f, parts, w, beam: 0.7, ks: 0.8, skyView: 0.9, shelter: 0.6, column: Array.from(T), centres: CENTRES, props, texture: { sand: 40, clay: 20 }, rootCm: 15, full: 0.8, shadeWeeks: 0.5, tBottom: 12, v1: ts + 1, reading: ts - 2 };

test('the surface\'s energy terms balance: net radiation = into the soil + to the air + to evaporation', () => {
  assert.ok(Math.abs(parts.rn - parts.g - parts.h - parts.le) < 1e-6);
  const e = surfaceExplain(a), rows = e.groups.find((g) => g.title.startsWith('The energy')).rows;
  const v = (label) => rows.find((r) => r.label === label).v;
  assert.ok(Math.abs(v('Net radiation') - v('Into the soil') - v('To the air') - v('To evaporation')) < 1e-6);
  assert.equal(e.value, ts); assert.equal(e.reading, ts - 2); assert.equal(e.others[0].v, ts + 1);
});

test('every row of every view carries a kind the page can format, and nothing is NaN', () => {
  const all = [surfaceExplain(a), soilExplain({ ...a, depthCm: 10, value: 21 }), windExplain({ w, u2: 1.2, shelter: 0.6, open: 2, ra: 173 }),
    moistureExplain({ wet: 0.7, taw: 25, raw: 12, rootCm: 15, texture: null, Dr: 7.5, grav: 0, pond: 0, ks: 1, week: { rain: 12, et0: 20, et: 15, drained: 2, ranOff: 0, rose: 0 }, etFactor: 0.9, light: 0.8, days: 7, reading: 34, unit: 'scale' })];
  for (const e of all) {
    assert.ok(e.label && e.kind && e.groups.length);
    for (const g of e.groups) for (const r of g.rows) {
      assert.ok(['temp', 'dtemp', 'flux', 'share', 'speed', 'mm', 'cm', 'm', 'deg', 'num', 'text'].includes(r.kind), `${r.label}: ${r.kind}`);
      assert.ok(r.v === null || typeof r.v === 'string' || Number.isFinite(r.v), `${r.label}: ${r.v}`);
      assert.notEqual(fmt(r.v, r.kind), 'NaN');
    }
  }
  assert.match(all[3].groups[0].rows[0].v, /not in the survey/);
});

test('the formats: degrees F from C, differences signed, shares as percents, speeds in mph, missing as a dash', () => {
  assert.equal(fmt(20, 'temp'), '68.0 °F');
  assert.equal(fmt(20, 'temp', { f: false }), '20.0 °C');
  assert.equal(fmt(-1, 'dtemp'), '-1.8 °F');
  assert.equal(fmt(1, 'dtemp'), '+1.8 °F');
  assert.equal(fmt(0.456, 'share'), '46%');
  assert.equal(fmt(2, 'speed'), '4.5 mph');
  assert.equal(fmt(25.4, 'mm'), '1.00 in');
  assert.equal(fmt(null, 'temp'), '-');
  assert.equal(fmt(0, 'flux'), '0 W/m²');
});

console.log(`${passed} passed`);
