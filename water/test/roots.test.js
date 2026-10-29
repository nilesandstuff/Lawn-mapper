/**
 * The roots: species, working depths and the soil-temperature model (lib/roots.js), and the balance following them.
 *   node water/test/roots.test.js
 */
import assert from 'node:assert/strict';
import { SPECIES, ROOT_MODELS, KC, kcOf, kcFor, production, standingIndex, speciesOf, groupOf, workingCm, rootSeries, typicalRoots, attachRootRatio, DEPTH_FLOOR } from '../lib/roots.js';
import { dayIndex } from '../lib/shade/climate.js';
import { buildModel, simulate, idealIrrigation, zoneIrrigation, PARAMS, withMode } from '../lib/balance.js';
import { rootZone } from '../lib/soil.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('production: the brief\'s worked values (Yin\'s beta between base, optimum and maximum)', () => {
  const near = (a, b, tol = 0.02) => Math.abs(a - b) < tol;
  assert.ok(near(production(10, ROOT_MODELS.bent), 0.73) && near(production(16, ROOT_MODELS.bent), 1) && near(production(25, ROOT_MODELS.bent), 0.60) && near(production(30, ROOT_MODELS.bent), 0.23));
  // bluegrass: the brief's thresholds (its worked table's bluegrass column does not follow them; its text does: roots about 75% at 10 C)
  assert.ok(near(production(10, ROOT_MODELS.cool), 0.78) && near(production(18, ROOT_MODELS.cool), 1) && production(28, ROOT_MODELS.cool) < 0.7 && production(34, ROOT_MODELS.cool) < 0.15);
  assert.ok(near(production(13, ROOT_MODELS.warm), 0.32) && near(production(28, ROOT_MODELS.warm), 0.99) && near(production(36, ROOT_MODELS.warm), 0.70));
  assert.equal(production(2, ROOT_MODELS.warm), 0); assert.equal(production(8, ROOT_MODELS.warm), 0.05, 'slow growth in unfrozen winter soil');
});

test('the standing roots: a warm climate\'s year peaks in late spring and bottoms in late summer; a cold winter holds them', () => {
  const T = Float32Array.from({ length: 365 }, (_, k) => 19.5 - 10.5 * Math.cos(((k - 15) / 365) * 2 * Math.PI)); // soil 9-30 C
  const R = standingIndex(T, ROOT_MODELS.cool);
  const at = (k) => R[k];
  const peak = R.indexOf(Math.max(...R)), low = R.indexOf(Math.min(...R));
  assert.ok(peak >= 100 && peak <= 170, `peak in April-June: day ${peak}`);
  assert.ok(low >= 220 && low <= 290, `lowest in August-October: day ${low}`);
  assert.ok(at(low) < 0.6 && at(peak) > 0.7, `${at(peak)} / ${at(low)}`);
  // Michigan: soil near 0 for months, 23 C in July -- the roots hold through winter and dip a little in summer
  const mi = Float32Array.from({ length: 365 }, (_, k) => 11 - 12 * Math.cos(((k - 20) / 365) * 2 * Math.PI));
  const Rm = standingIndex(mi, ROOT_MODELS.cool);
  assert.ok(Math.min(...Rm.slice(0, 90)) > 0.7, `roots alive through winter: ${Math.min(...Rm.slice(0, 90))}`);
  // a warm-season green-up after a cold winter: the index drops and production stops for three weeks
  const Rw = standingIndex(mi, ROOT_MODELS.warm, { events: [140] });
  assert.ok(Rw[141] < Rw[139] * 0.3, 'the spring root decline');
  assert.ok(Rw[160] <= Rw[141] + 1e-6, 'and nothing grows for three weeks');
});

test('species: the working depth is the average of those checked; the group follows the majority; none means the general figure', () => {
  assert.deepEqual(speciesOf([], 'cool'), ['coolMix']); assert.deepEqual(speciesOf(['bogus'], 'warm'), ['warmMix']);
  assert.deepEqual(speciesOf(['kbg', 'kbg', 'tf']), ['kbg', 'tf']);
  assert.ok(Math.abs(workingCm(['kbg', 'tf']) - 10 * 2.54) < 1e-9, 'bluegrass 8 and tall fescue 12: 10 in');
  assert.equal(groupOf(['rye', 'bermuda', 'zoysia']), 'warm'); assert.equal(groupOf(['rye', 'bermuda']), 'cool', 'a tie: cool');
  assert.equal(groupOf([], 'warm'), 'warm');
  for (const [id, sp] of Object.entries(SPECIES)) assert.ok(sp.workingIn >= 6 && sp.workingIn <= 12 && ROOT_MODELS[sp.model || sp.group], id);
});

test('the typical year and each day\'s own soil: the root zone never under the floor, deeper in spring than late summer in a warm climate', () => {
  const T = Array.from({ length: 365 }, (_, k) => 19.5 - 10.5 * Math.cos(((k - 15) / 365) * 2 * Math.PI));
  const r = typicalRoots(T, ['tf'], 'cool');
  assert.equal(r.workingIn, 12);
  assert.ok(r.peakIn > r.lowIn + 3 && r.lowIn >= 12 * DEPTH_FLOOR - 0.01, `${r.peakIn} / ${r.lowIn}`);
  assert.ok(r.peakMonth <= 5 && r.lowMonth >= 7);
  // days: their own soil where known, the typical year's otherwise
  const days = []; for (let d = 0; d < 400; d++) { const t = new Date(Date.UTC(2024, 0, 1) + d * 864e5); days.push({ date: t.toISOString().slice(0, 10) }); }
  const own = new Map(days.slice(0, 200).map((d) => [d.date, 30])); // a hot first 200 days
  const n = attachRootRatio(days, { soilByDate: own, typical: T, ids: ['kbg'], group: 'cool', dayIndex });
  assert.equal(n, 200);
  assert.ok(days.every((d) => d.rootRatio >= DEPTH_FLOOR - 1e-6 && d.rootRatio <= 1));
  assert.ok(days[199].rootRatio < days[399].rootRatio, 'hot soil, shallower roots');
});

test('the balance follows the day\'s roots: shallower roots hold less water, and the model is restored after a run', () => {
  const profile = { horizons: [{ topCm: 0, bottomCm: 50, awc: 0.15, ksatUmS: 5, sand: 40, clay: 20 }] };
  const soils = [{ rz: rootZone(profile, { rootCm: 20 }), tawByCm: Float32Array.from({ length: 21 }, (_, cm) => (cm ? rootZone(profile, { rootCm: cm }).tawMm : 0)), drainage: 'Well drained', hydgrp: 'B', wetByMonth: new Array(12).fill(null) }];
  const res = { grid: { W: 1, H: 1, cell: 1 }, z: new Float32Array(1), runoff: { down: new Int32Array([-1]), filled: new Float32Array(1) }, spots: { spots: [], depth: new Float32Array(1) } };
  const model = buildModel(res, { kinds: new Uint8Array([1]), soilAt: new Int16Array(1), soils, roofTo: new Int32Array([-1]) });
  const full = model.taw[0];
  const days = Array.from({ length: 60 }, (_, d) => ({ date: `2024-07-${String((d % 30) + 1).padStart(2, '0')}`, tmax: 28, tmin: 16, rain: 0, et0: 5, rootRatio: d < 30 ? 1 : 0.5 }));
  let seen = null;
  simulate(model, days, { irrigate: idealIrrigation(model), record: (d, st) => { if (d === 45) seen = { taw: model.taw[0], raw: model.raw[0], Dr: st.Dr[0] }; } });
  assert.ok(Math.abs(seen.taw - full / 2) < 0.5, `half the roots, half the water: ${seen.taw} of ${full}`);
  assert.ok(seen.Dr <= seen.taw + 1e-6);
  assert.ok(Math.abs(model.taw[0] - full) < 1e-6 && Math.abs(model.raw[0] - PARAMS.p * full) < 1e-6, 'restored after the run');
});

test('how much to water: the owner\'s Kc table by species and level, the middle of each range averaged; the balance follows it', () => {
  assert.equal(Object.keys(KC).length, 8);
  for (const r of Object.values(KC)) for (const lvl of ['normal', 'deficit', 'dormancy']) assert.ok(r[lvl][0] <= r[lvl][1] && r.normal[0] >= r.deficit[0] && r.deficit[0] >= r.dormancy[0]);
  assert.deepEqual(kcOf('kbg').dormancy, [0.5, 0.5], 'bluegrass: one dormancy figure');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(kcFor(['kbg'], 'cool', 'normal').kc, 0.9) && near(kcFor(['kbg'], 'cool', 'deficit').kc, 0.725) && near(kcFor(['kbg'], 'cool', 'dormancy').kc, 0.5));
  assert.ok(near(kcFor(['kbg', 'fine'], 'cool', 'normal').kc, (0.9 + 0.75) / 2), 'two species: their middles averaged');
  assert.ok(near(kcFor([], 'warm', 'normal').kc, (0.725 + 0.675 + 0.775 + 0.625) / 4), 'not sure which: the group\'s species averaged');
  assert.ok(kcFor(['bent'], 'cool').parts[0].general && near(kcFor(['bent'], 'cool').kc, kcFor([], 'cool').kc), 'bentgrass is not in the table: the cool-season figure');
  assert.equal(kcFor(['kbg'], 'cool', 'bogus').mode, 'normal');
  assert.ok(near(kcFor(['kbg'], 'cool', 'deficit').normalKc, 0.9));
  // the balance: a dry summer's watering falls with the coefficient
  const profile = { horizons: [{ topCm: 0, bottomCm: 50, awc: 0.15, ksatUmS: 5, sand: 40, clay: 20 }] };
  const soils = [{ rz: rootZone(profile, { rootCm: 20 }), drainage: 'Well drained', hydgrp: 'B', wetByMonth: new Array(12).fill(null) }];
  const res = { grid: { W: 1, H: 1, cell: 1 }, z: new Float32Array(1), runoff: { down: new Int32Array([-1]), filled: new Float32Array(1) }, spots: { spots: [], depth: new Float32Array(1) } };
  const days = Array.from({ length: 120 }, (_, d) => ({ date: `2024-${String(5 + Math.floor(d / 30)).padStart(2, '0')}-${String((d % 30) + 1).padStart(2, '0')}`, tmax: 28, tmin: 16, rain: 0, et0: 5 }));
  const run = (mode) => {
    const model = buildModel(res, { kinds: new Uint8Array([1]), soilAt: new Int16Array(1), soils, roofTo: new Int32Array([-1]), params: withMode(PARAMS, mode, kcFor(['kbg'], 'cool', mode).kc) });
    const events = [];
    const tot = simulate(model, days, { irrigate: zoneIrrigation(model, new Int32Array([0]), 1, events) });
    return { mm: tot.irrigation[0], events, kc: model.params.kc };
  };
  const n = run('normal'), d = run('deficit'), z = run('dormancy');
  assert.ok(n.mm > 300, `a normal summer waters plenty: ${n.mm}`);
  assert.ok(Math.abs(d.mm / n.mm - 0.725 / 0.9) < 0.08, `deficit at about the coefficients' ratio: ${(d.mm / n.mm).toFixed(2)}`);
  assert.ok(Math.abs(z.mm / n.mm - 0.5 / 0.9) < 0.08, `dormancy likewise: ${(z.mm / n.mm).toFixed(2)}`);
  assert.ok(z.events.length < d.events.length && d.events.length < n.events.length, 'fewer waterings, the same depth each');
  assert.equal(withMode(PARAMS, 'bogus').mode, 'normal'); assert.equal(withMode(PARAMS, 'deficit').kc, PARAMS.kc, 'no coefficient given: the default stays');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water roots: ${tests.length} passed`);
