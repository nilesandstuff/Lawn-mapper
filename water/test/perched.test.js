/**
 * Water perched on a slow layer (lib/perched.js, FINDINGS H73): which soils perch water and how slowly the layer lets
 * it through, the layer's depth under rises and hollows, the store's daily step (mass kept), flat ground staying wet,
 * the seep at the foot of a slope, and the capillary barrier under added topsoil.
 *   node water/test/perched.test.js
 */
import assert from 'node:assert/strict';
import { slowLayerOf, calibrateLayer, layerDepths, perchedRoutes, perchedCells, perchedDay, barrierExtraMm, drainToLayerMmDay } from '../lib/perched.js';
import { textureClass } from '../lib/soil.js';
import { waterPlan } from '../lib/plan.js';
import { analyse } from '../lib/lowspots.js';
import { cloud, LAT } from '../lib/synthetic.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// an Allendale-like soil: loamy sand over clay at 86 cm
const SAND_OVER_CLAY = { horizons: [{ name: 'Ap', topCm: 0, bottomCm: 25, ksatUmS: 50, sat: 40, fc: 10, awc: 0.08, sand: 85, clay: 5 }, { name: 'E', topCm: 25, bottomCm: 86, ksatUmS: 50, sat: 40, fc: 8, awc: 0.06, sand: 88, clay: 4 }, { name: '2Bt', topCm: 86, bottomCm: 150, ksatUmS: 0.5, sat: 45, fc: 35, awc: 0.12, sand: 25, clay: 40 }] };

test('which soils perch water: a slow horizon under a fast one, a named cemented band; not a loam, not clay bands in sand', () => {
  const a = slowLayerOf(SAND_OVER_CLAY);
  assert.equal(a.topCm, 86); assert.equal(a.how, 'horizon');
  assert.ok(near(a.resistDays, 14.8, 0.1), `${a.resistDays}`); // 640 mm / 43.2 mm/day
  assert.ok(near(a.phid, 0.32, 1e-9) && near(a.kLatMmDay, 4320, 1e-6));
  assert.equal(slowLayerOf({ horizons: [{ name: 'Ap', topCm: 0, bottomCm: 30, ksatUmS: 9 }, { name: 'Bt', topCm: 30, bottomCm: 150, ksatUmS: 3 }] }), null, 'a loam over a slower loam: no perching');
  assert.equal(slowLayerOf({ horizons: [{ name: 'A', topCm: 0, bottomCm: 20, ksatUmS: 100 }, { name: 'E and Bt', topCm: 60, bottomCm: 150, ksatUmS: 30 }] }), null, 'lamellae: the horizon\'s Ksat holds them');
  // a slow layer at the bottom of the data, thinner than 30 cm: taken 30 cm thick
  const thin = slowLayerOf({ horizons: [{ topCm: 0, bottomCm: 60, ksatUmS: 30 }, { topCm: 60, bottomCm: 70, ksatUmS: 0.1 }] });
  assert.ok(near(thin.cM, 0.3, 1e-9) && near(thin.resistDays, 300 / 8.64, 1e-6));
  // ortstein named only by its m suffix, the survey's Ksat no slower: a 10 cm band at 0.5 um/s, 2.3 days
  const o = slowLayerOf({ horizons: [{ name: 'A', topCm: 0, bottomCm: 10, ksatUmS: 100 }, { name: 'E', topCm: 10, bottomCm: 35, ksatUmS: 100 }, { name: 'Bhsm', topCm: 35, bottomCm: 45, ksatUmS: 100 }, { name: 'C', topCm: 45, bottomCm: 150, ksatUmS: 100 }] });
  assert.equal(o.how, 'band'); assert.equal(o.band, 'Ortstein'); assert.equal(o.topCm, 35); assert.ok(near(o.resistDays, 2.31, 0.01));
  // a fragipan named in the restrictions table: a band at its depth
  const f = slowLayerOf({ horizons: [{ topCm: 0, bottomCm: 50, ksatUmS: 9 }, { topCm: 50, bottomCm: 150, ksatUmS: 9 }], restrictions: [{ kind: 'Fragipan', topCm: 55, thickCm: 40 }] });
  assert.equal(f.band, 'Fragipan'); assert.equal(f.topCm, 55); assert.ok(near(f.resistDays, 400, 1e-6)); // 400 mm at 1 mm/day
  // a Bs without the m: nothing
  assert.equal(slowLayerOf({ horizons: [{ name: 'E', topCm: 0, bottomCm: 30, ksatUmS: 100 }, { name: 'Bs', topCm: 30, bottomCm: 150, ksatUmS: 100 }] }), null);
  // the rate the roots drain at: the sand between them and the clay, not the clay
  assert.ok(near(drainToLayerMmDay(SAND_OVER_CLAY, 30, 86, 1.8), 4320, 1e-6));
});

// a ground W x H cells, `cell` m: z(r, c)
const grid = (W, H, cell, f) => { const z = new Float32Array(W * H); for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) z[r * W + c] = f(r, c); return { g: { W, H, cell }, z }; };

test('the survey as the check: a soil recorded wet above its slow layer has the layer slowed to hold the water there', () => {
  // a Rimer-like loamy fine sand over clay at 81 cm, the survey wet at 53 cm January to April
  const rimer = slowLayerOf({ horizons: [{ topCm: 0, bottomCm: 23, ksatUmS: 92 }, { topCm: 23, bottomCm: 56, ksatUmS: 92 }, { topCm: 56, bottomCm: 81, ksatUmS: 28, sat: 40, fc: 22 }, { topCm: 81, bottomCm: 152, ksatUmS: 0.91 }] });
  const days = Array.from({ length: 365 }, (_, d) => { const date = new Date(Date.UTC(2023, 0, 1) + d * 864e5).toISOString().slice(0, 10); return { date, rain: 2.5, et0: Number(date.slice(5, 7)) <= 4 ? 0.5 : 4 }; });
  const wet = [53, 53, 53, 53, null, null, null, null, null, null, null, null];
  const c = calibrateLayer(rimer, wet, days, 1);
  // surplus 2 mm/day; C 710 mm; h 280 mm: K = 2 x 710 / 990 = 1.43 mm/day, against the survey's 78.6
  assert.ok(c.calibrated && near(c.calibrated.mmDay, 2 * 710 / 990, 1e-6) && near(c.calibrated.surveyMmDay, 78.624, 1e-3), JSON.stringify(c.calibrated));
  assert.ok(near(c.resistDays, 990 / 2, 1e-6));
  assert.deepEqual(c.calibrated.months, [0, 1, 2, 3]);
  // wet only below the layer, or never: unchanged
  assert.equal(calibrateLayer(rimer, [100, null, null, null, null, null, null, null, null, null, null, null], days, 1), rimer);
  assert.equal(calibrateLayer(rimer, new Array(12).fill(null), days, 1), rimer);
});

test('the layer\'s depth: deeper under a rise, shallower in a hollow, by the survey\'s range of depths', () => {
  // a 2 m bump in the middle of flat ground, 1 m cells
  const { g, z } = grid(80, 80, 1, (r, c) => 100 + 2 * Math.exp(-((r - 40) ** 2 + (c - 40) ** 2) / 200));
  const soilAt = new Uint8Array(80 * 80);
  const fixed = layerDepths(g, z, soilAt, [{ topCm: 80 }]); // no range: beta 0.5
  assert.equal(fixed.beta[0], 0.5);
  const top = fixed.zL[40 * 80 + 40], edge = fixed.zL[2 * 80 + 2];
  assert.ok(top > 80 + 40 && edge < 80 + 5, `top ${top} edge ${edge}`);
  // a survey range of 60-180 cm across the soil: beta set so the spread across the ground matches it (and held to 0..1)
  const ranged = layerDepths(g, z, soilAt, [{ topCm: 80, topLoCm: 60, topHiCm: 180 }]);
  assert.ok(ranged.beta[0] > 0 && ranged.beta[0] <= 1, `${ranged.beta[0]}`);
  assert.ok(Number.isNaN(layerDepths(g, z, soilAt, [null]).zL[0]), 'no slow layer: none');
});

test('one day of the store: the water is all accounted for, leaking, running downhill, and rising into the roots', () => {
  // a 2% slope falling east, every cell over a slow layer 60 cm down, roots 20 cm
  const W = 30, H = 10, { g, z } = grid(W, H, 1, (r, c) => 100 - 0.02 * c), N = W * H;
  const soilAt = new Uint8Array(N), slow = [{ topCm: 60, cM: 0.3, resistDays: 20, kLatMmDay: 2000, phid: 0.2 }];
  const zL = new Float32Array(N).fill(60);
  const par = perchedCells(N, soilAt, slow, zL);
  const routes = perchedRoutes(g, z, zL);
  assert.ok(routes.sEff[5 * W + 10] > 0.015 && routes.sEff[5 * W + 10] < 0.03, `${routes.sEff[5 * W + 10]}`);
  const st = { P: new Float32Array(N).fill(60), Dr: new Float32Array(N).fill(10), grav: new Float32Array(N), satRoom: new Float32Array(N).fill(20), pond: new Float32Array(N) };
  const tot = { leak: new Float32Array(N), latIn: new Float32Array(N), latOut: new Float32Array(N), seep: new Float32Array(N), toRoots: new Float32Array(N), fullDays: new Uint16Array(N) };
  const before = st.P.reduce((a, v) => a + v, 0);
  perchedDay(routes, st, par, new Float32Array(N).fill(20), null, tot);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const after = sum(st.P) + sum(tot.leak) + sum(tot.toRoots) + sum(tot.seep);
  assert.ok(near(before, after, 1e-2), `${before} vs ${after}`);
  assert.ok(sum(tot.latOut) > 0 && sum(tot.latIn) < sum(tot.latOut), 'what leaves sideways arrives downhill, less what runs off the east edge');
  // the room between the roots and the layer: 40 cm x 0.2 = 80 mm; 60 mm fits; the top row gets nothing from uphill
  assert.ok(st.P[5 * W] < 60 && sum(tot.seep) === 0);
  // the leak under 60 mm of water (30 cm high) over a 30 cm layer of R 20 days: (300 + 300) / 20 = 30 mm
  assert.ok(near(tot.leak[5 * W], 30, 0.01), `${tot.leak[5 * W]}`);
  // frozen: nothing moves
  const st2 = { ...st, P: new Float32Array(N).fill(10) }, tot2 = { leak: new Float32Array(N), latIn: new Float32Array(N), latOut: new Float32Array(N), seep: new Float32Array(N), toRoots: new Float32Array(N), fullDays: new Uint16Array(N) };
  perchedDay(routes, st2, par, new Float32Array(N).fill(20), null, tot2, { frozen: true });
  assert.equal(sum(tot2.leak) + sum(tot2.latOut), 0);
});

test('the foot of a slope: water perched upslope comes out at the toe as a seep', () => {
  // 40 m of 5% slope onto 20 m of flat ground, a slow layer 50 cm down everywhere, roots 15 cm
  const W = 60, H = 6, { g, z } = grid(W, H, 1, (r, c) => 100 - 0.05 * Math.min(c, 40)), N = W * H;
  const soilAt = new Uint8Array(N), slow = [{ topCm: 50, cM: 0.5, resistDays: 500, kLatMmDay: 3000, phid: 0.15 }];
  const zL = new Float32Array(N).fill(50), par = perchedCells(N, soilAt, slow, zL), routes = perchedRoutes(g, z, zL);
  const st = { P: new Float32Array(N), Dr: new Float32Array(N), grav: new Float32Array(N), satRoom: new Float32Array(N).fill(15), pond: new Float32Array(N) };
  const tot = { leak: new Float32Array(N), latIn: new Float32Array(N), latOut: new Float32Array(N), seep: new Float32Array(N), toRoots: new Float32Array(N), fullDays: new Uint16Array(N) };
  const roots = new Float32Array(N).fill(15);
  for (let d = 0; d < 60; d++) { for (let i = 0; i < N; i++) st.P[i] += 8; st.pond.fill(0); st.grav.fill(0); perchedDay(routes, st, par, roots, null, tot); }
  const at = (c) => tot.seep[3 * W + c]; // the toe is column 40, the slope's last cell
  assert.ok(at(40) > 100 && at(10) === 0, `toe ${at(40)} vs upslope ${at(10)}`);
  assert.ok(tot.latIn[3 * W + 40] > tot.latIn[3 * W + 10], 'more arrives sideways at the toe');
});

// a flat lawn for the plan: one soil, the weather of a wet spring and a dry summer
function flatPlan(profile, opts = {}) {
  const { cols, bbox } = cloud({ size: 30, density: 2, noise: 0.005, height: () => 0, roofs: [], seed: 4 });
  const res = analyse(cols, bbox, LAT, { nullRuns: 0, floor: 0.05, useShadeRoofs: false });
  const N = res.grid.W * res.grid.H;
  const unit = { name: 'test soil', drainage: 'Somewhat poorly drained', hydgrp: 'C', wetByMonth: new Array(12).fill(null), profile, polygons: [] };
  const days = Array.from({ length: 365 * 2 }, (_, d) => { const date = new Date(Date.UTC(2023, 0, 1) + d * 864e5).toISOString().slice(0, 10); const m = Number(date.slice(5, 7)); return { date, tmax: m >= 5 && m <= 9 ? 27 : 10, tmin: m >= 5 && m <= 9 ? 14 : 2, rain: m <= 6 ? (d % 3 === 0 ? 12 : 0) : d % 9 === 0 ? 8 : 0, et0: m >= 5 && m <= 9 ? 4.5 : 1 }; });
  return waterPlan(res, { lawnMask: new Uint8Array(N).fill(1), soil: { units: [unit] }, typical: days, ...opts });
}

test('flat ground over a slow layer: the perched water stands in the roots for days; a uniform sand drains', () => {
  const shallow = { horizons: [{ name: 'Ap', topCm: 0, bottomCm: 25, ksatUmS: 20, sat: 42, fc: 18, awc: 0.12, sand: 70, clay: 10 }, { name: 'Bw', topCm: 25, bottomCm: 45, ksatUmS: 20, sat: 40, fc: 15, awc: 0.1, sand: 72, clay: 10 }, { name: 'Bx', topCm: 45, bottomCm: 150, ksatUmS: 0.01, sat: 38, fc: 30, awc: 0.06, sand: 40, clay: 25 }] };
  const sand = { horizons: [{ name: 'Ap', topCm: 0, bottomCm: 150, ksatUmS: 20, sat: 42, fc: 18, awc: 0.12, sand: 70, clay: 10 }] };
  const perched = flatPlan(shallow), free = flatPlan(sand);
  assert.equal(free.perched, null);
  assert.ok(perched.perched && perched.perched.share > 0.99);
  assert.ok(perched.perched.standDaysRainAlone > 5, `stands ${perched.perched.standDaysRainAlone} days`);
  assert.ok(perched.perched.leakMm > 0 && perched.perched.toRootsMm > 0);
  assert.equal(perched.perched.soils[0].how, 'horizon');
});

test('loamy topsoil put on sand: the barrier holds about 22 mm more, and no water rises across it', () => {
  const sand = { horizons: [{ name: 'Ap', topCm: 0, bottomCm: 150, ksatUmS: 60, sat: 38, fc: 8, awc: 0.06, sand: 90, clay: 3 }] };
  assert.ok(near(barrierExtraMm(sand, 10.16, textureClass), 22.35, 0.01));
  assert.equal(barrierExtraMm({ horizons: [{ topCm: 0, bottomCm: 100, sand: 40, clay: 20 }] }, 10.16, textureClass), 0, 'loam on loam: none');
  const plain = flatPlan(sand, { topsoil: true }), none = flatPlan(sand);
  assert.ok(plain.perched && near(plain.perched.barrier[0].mm, 22.35, 0.01));
  assert.equal(none.perched, null);
  assert.ok(plain.stress.rainAlone <= none.stress.rainAlone, `short ${plain.stress.rainAlone} vs ${none.stress.rainAlone}`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
console.log(`water perched: ${tests.length - failed} passed${failed ? `, ${failed} failed` : ''}`);
if (failed) process.exit(1);
