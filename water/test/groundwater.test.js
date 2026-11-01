/**
 * The water table under a lawn (lib/groundwater.js, FINDINGS H70): the water on the national maps, the height above
 * it, the water levels round a lawn, the depth month by month, and AquaCrop's water rising into the roots.
 *   node water/test/groundwater.test.js
 */
import assert from 'node:assert/strict';
import { nwiCode, nwiKind, streamHold, bodyHold, waterOnGround, handGrid, burnedTerrain, waterLevels, tableDepths, seasonShape, capRise, subsoilOf, CR_CLASS, demCell } from '../lib/groundwater.js';
import { terrain } from '../lib/upslope.js';
import { toMerc, fromMerc } from '../lib/ept.js';
import { textureClass } from '../lib/soil.js';
import { waterPlan } from '../lib/plan.js';
import { analyse } from '../lib/lowspots.js';
import { cloud, LAT } from '../lib/synthetic.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('NWI codes: a dug pond and a lake hold the water table all year; a seasonal marsh in the wet half', () => {
  assert.deepEqual(nwiCode('PEM1C'), { system: 'P', cls: 'EM', regime: 'C' });
  assert.deepEqual(nwiCode('PUBHx'), { system: 'P', cls: 'UB', regime: 'H' });
  assert.equal(nwiCode('PFO1/EM1A').regime, 'A');
  assert.equal(nwiKind('PUBHx'), 'permanent'); assert.equal(nwiKind('L1UBH'), 'permanent'); assert.equal(nwiKind('R2UBH'), 'permanent');
  assert.equal(nwiKind('PEM1F'), 'permanent'); assert.equal(nwiKind('PEM1C'), 'seasonal'); assert.equal(nwiKind('PFO1A'), 'seasonal');
  assert.equal(nwiKind('nonsense'), null);
  assert.equal(streamHold('perennial'), 'permanent'); assert.equal(streamHold('intermittent'), 'seasonal'); assert.equal(streamHold('ditch or canal'), 'seasonal');
  assert.equal(bodyHold(39004), 'permanent'); assert.equal(bodyHold(46600), 'seasonal'); assert.equal(bodyHold(36100), null);
});

// a 10 m ground 60 x 60 cells: falling east at 2%, a creek along the east edge (col 55), a pond in the west
const LNG = -85.7, LATT = 42.8;
function ground() {
  const W = 60, H = 60, cell = 10, k = Math.cos((LATT * Math.PI) / 180), [cx, cy] = toMerc([LNG, LATT]), h = (W * cell) / 2 / k;
  const z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) z[r * W + c] = 220 - 0.2 * c + 0.01 * r;
  return { W, H, cell, z, bbox: [cx - h, cy - h, cx + h, cy + h], k };
}
const cellLngLat = (dem, c, r) => fromMerc([dem.bbox[0] + ((c + 0.5) * (dem.bbox[2] - dem.bbox[0])) / dem.W, dem.bbox[3] - ((r + 0.5) * (dem.bbox[3] - dem.bbox[1])) / dem.H]);

test('the water on the ground, and the height above it down the flow path', () => {
  const dem = ground(), t = terrain(dem);
  const creek = { kind: 'perennial', line: [cellLngLat(dem, 55, 0), cellLngLat(dem, 55, 59)] };
  const sq = (c0, r0, c1, r1) => [[cellLngLat(dem, c0, r0), cellLngLat(dem, c1, r0), cellLngLat(dem, c1, r1), cellLngLat(dem, c0, r1), cellLngLat(dem, c0, r0)]];
  const marsh = { code: 'PEM1C', rings: sq(20, 20, 24, 24) };
  const hold = waterOnGround(dem, t, { streams: [creek], wetlands: [marsh] });
  assert.equal(hold[30 * 60 + 55], 1, 'the creek');
  assert.equal(hold[22 * 60 + 22], 2, 'the marsh, inside');
  assert.equal(hold[10 * 60 + 10], 0, 'open ground');
  const hg = handGrid(dem, burnedTerrain(dem, hold, terrain), hold);
  // a cell 15 columns west of the creek, out of the marsh's way: 15 cells x 0.2 m above the creek
  const i = 45 * 60 + 40;
  assert.ok(Math.abs(hg.perm.h[i] - 3) < 0.15, `${hg.perm.h[i]}`);
  assert.ok(hg.perm.dist[i] >= 140 && hg.perm.dist[i] <= 200, `${hg.perm.dist[i]}`);
  // a cell just west of the marsh drains into it in the wet half
  const j = 22 * 60 + 17;
  assert.ok(hg.wet.h[j] < hg.perm.h[j], `${hg.wet.h[j]} vs ${hg.perm.h[j]}`);
});

test('water levels round a point: the near water counts most', () => {
  const dem = ground();
  const hold = new Uint8Array(60 * 60);
  hold[30 * 60 + 31] = 1; // a pond cell, 10 m east of the point
  hold[30 * 60 + 59] = 2; // a marsh far east
  const lv = waterLevels(dem, hold, [30 * 60 + 30]).get(30 * 60 + 30);
  const zPond = dem.z[30 * 60 + 31];
  assert.ok(Math.abs(lv.perm - zPond) < 1e-4, 'only the pond is permanent');
  assert.ok(lv.any > zPond - 0.6 && lv.any < zPond, `${lv.any}: weighted to the pond, pulled a little toward the lower marsh`);
});

test('the depth month by month: highest in April, deepest in October, held up by year-round water, the survey when shallower', () => {
  assert.ok(seasonShape(3) < 0.01 && seasonShape(9) > 0.99);
  // 2 m above the water round it, 3 m above the permanent water: half of each
  const d = tableDepths(102, { any: 100, perm: 99 });
  assert.equal(Math.round(d[3]), 100 + Math.round(75 * seasonShape(3)));
  assert.ok(d[9] > d[3] && d[9] <= 150 + 1e-3, `${d[9]}`); // the swing stops at half the height above the permanent water
  // a pond close and low: the water table cannot sink far
  const held = tableDepths(100.6, { any: 100.4, perm: 100.2 });
  assert.ok(held[9] <= 20 + 1e-3, `${held[9]}`);
  // the survey's wet soil at 15 cm in the wet months wins where it is shallower
  const s = tableDepths(103, { any: 100, perm: 99 }, [15, 15, 15, 15, 15, 15, null, null, null, null, 15, 15]);
  assert.equal(s[0], 15); assert.ok(s[8] > 15 && s[8] <= 15 + 75 + 1e-3, `${s[8]}`);
  // far above any water and no wet soil: deeper than 4 m, unknown
  assert.ok(Number.isNaN(tableDepths(130, { any: 100, perm: 100 })[5]));
});

test('AquaCrop\'s rise: the research note\'s table, and none from 4 m or more', () => {
  const near = (a, b) => Math.abs(a - b) / b < 0.02;
  assert.ok(near(capRise(1, 800, 1), 1.46) && near(capRise(1, 800, 0.5), 12.8));
  assert.ok(near(capRise(1, 300, 1), 0.69) && near(capRise(2, 100, 1), 1.15) && near(capRise(2, 100, 0.5), 4.74));
  assert.ok(near(capRise(4, 10, 1), 0.63));
  assert.equal(capRise(1, 800, 4), 0); assert.equal(capRise(1, 800, 0), 0);
  assert.equal(capRise(1, 800, 0.1), 99);
  // Ksat held to each class's range: a loam at 778 mm/day lifts no more than one at 750
  assert.ok(capRise(2, 778, 1) === capRise(2, 750, 1));
  assert.equal(CR_CLASS['silty clay loam'], 4);
  const sub = subsoilOf({ horizons: [{ topCm: 0, bottomCm: 20, ksatUmS: 30, sand: 80, clay: 5 }, { topCm: 20, bottomCm: 100, ksatUmS: 5, sand: 40, clay: 20 }] }, 15, 200, textureClass);
  assert.equal(sub.texture, 'loam'); assert.equal(sub.cls, 2); assert.ok(Math.abs(sub.ksatMmDay - 432) < 1e-6);
});

test('in the plan: a lawn over a shallow water table is lifted water and kept less short of it', () => {
  const { cols, bbox } = cloud({ size: 30, density: 2, noise: 0.005, height: () => 0, roofs: [], seed: 4 });
  const res = analyse(cols, bbox, LAT, { nullRuns: 0, floor: 0.05, useShadeRoofs: false });
  const N = res.grid.W * res.grid.H;
  const lawn = new Uint8Array(N).fill(1);
  const loam = { name: 'loam', drainage: 'Moderately well drained', hydgrp: 'B', wetByMonth: new Array(12).fill(null), profile: { horizons: [{ topCm: 0, bottomCm: 150, awc: 0.15, ksatUmS: 1.2, sand: 40, clay: 20 }] }, polygons: [] };
  const days = Array.from({ length: 365 * 2 }, (_, d) => { const date = new Date(Date.UTC(2023, 0, 1) + d * 864e5).toISOString().slice(0, 10); const m = Number(date.slice(5, 7)); return { date, tmax: m >= 5 && m <= 9 ? 28 : 8, tmin: m >= 5 && m <= 9 ? 15 : 0, rain: d % 12 === 0 ? 10 : 0, et0: m >= 5 && m <= 9 ? 4.5 : 1 }; });
  const zMid = (() => { const v = Array.from(res.z).filter(Number.isFinite).sort((a, b) => a - b); return v[v.length >> 1]; })();
  // the water round the lawn 0.8 m below it (the table 40 cm down in April, held near it by year-round water)
  const gw = { levelAny: new Float32Array(N).fill(zMid - 0.8), levelPerm: new Float32Array(N).fill(zMid - 1.0) };
  const dry = waterPlan(res, { lawnMask: lawn, soil: { units: [loam] }, typical: days });
  const wet = waterPlan(res, { lawnMask: lawn, soil: { units: [loam] }, typical: days, groundwater: gw });
  assert.equal(dry.groundwater, null);
  assert.ok(wet.groundwater && wet.groundwater.riseRainAloneMm > 50, `lifted ${wet.groundwater?.riseRainAloneMm} mm a year`);
  assert.ok(wet.groundwater.byMonthCm[3] <= 41 && wet.groundwater.byMonthCm[8] > wet.groundwater.byMonthCm[3]);
  assert.ok(wet.stress.rainAlone < dry.stress.rainAlone, `short of water ${wet.stress.rainAlone} vs ${dry.stress.rainAlone} of the season`);
  assert.ok(Number.isFinite(wet.groundwater.late.find(Number.isFinite)));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`water groundwater: ${tests.length - failed} passed${failed ? `, ${failed} failed` : ''}`);
if (failed) process.exit(1);
