/**
 * The watering plan: weather and ET, the soil survey's answers, the daily
 * water balance, roofs and downspouts, zones (water session).
 *   node water/test/plan.test.js
 */

import assert from 'node:assert/strict';

import { penmanMonteith, ra, hargreaves, dayOfYear } from '../lib/et.js';
import { hoursOf, hourly } from '../lib/weather.js';
import { parseWkt, rootZone, boxWkt, ROOT_CM } from '../lib/soil.js';
import { scsRunoff, cnSlope, curveNumber, buildModel, simulate, idealIrrigation, PARAMS } from '../lib/balance.js';
import { roofRouting } from '../lib/gutters.js';
import { waterPlan } from '../lib/plan.js';
import { analyse } from '../lib/lowspots.js';
import { cloud, LAT } from '../lib/synthetic.js';
import { fromMerc, toMerc, mercScale } from '../lib/ept.js';
import { terrain, hillside } from '../lib/upslope.js';
import { tileId, decodeMvt, overtureMasks } from '../lib/overture.js';
import { gridFor } from '../lib/surface.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('FAO-56 Penman-Monteith gives the paper\'s own worked example', () => {
  // FAO-56 example 18 (Brussels, 6 July): 3.9 mm/day; example 8: Ra 32.2 MJ/m2 at 20 S on 3 September
  assert.ok(Math.abs(penmanMonteith({ tmax: 21.5, tmin: 12.3, ea: 1.409, wind: 2.078, rs: 22.07 }, 50.8, 187, 100) - 3.9) < 0.1);
  assert.ok(Math.abs(ra(-20, 246) - 32.2) < 0.1);
  assert.equal(dayOfYear('2026-07-06'), 187);
  const h = hargreaves(30, 15, 43, 196);
  assert.ok(h > 4 && h < 7, `Hargreaves on a summer day ${h}`);
});

test('the forecast grid\'s intervals become hours, and rain amounts are shared over them', () => {
  assert.equal(hoursOf('PT3H'), 3); assert.equal(hoursOf('P1DT6H'), 30);
  const m = hourly({ values: [{ validTime: '2026-07-01T00:00:00+00:00/PT6H', value: 6 }] }, { share: true });
  assert.equal(m.size, 6); assert.equal([...m.values()].reduce((s, v) => s + v, 0), 6);
});

test('the soil survey\'s shapes and a profile\'s root zone read right, topsoil included', () => {
  assert.equal(parseWkt('POLYGON ((0 0, 1 0, 1 1, 0 0))')[0][0].length, 4);
  const mp = parseWkt('MULTIPOLYGON (((0 0, 2 0, 2 2, 0 0), (0.5 0.5, 1 0.5, 1 1, 0.5 0.5)), ((5 5, 6 5, 6 6, 5 5)))');
  assert.equal(mp.length, 2); assert.equal(mp[0].length, 2, 'the hole is kept');
  assert.match(boxWkt([-85, 42, -84.9, 42.1]), /^POLYGON\(\(-85\.0000000 42\.1000000,/);
  const sand = { horizons: [{ topCm: 0, bottomCm: 50, awc: 0.07, ksatUmS: 100 }, { topCm: 50, bottomCm: 150, awc: 0.1, ksatUmS: 1 }] };
  const rz = rootZone(sand);
  assert.ok(Math.abs(rz.tawMm - ROOT_CM * 10 * 0.07) < 1e-9, 'TAW = root depth x available water');
  assert.ok(Math.abs(rz.ksatMmH - 360) < 1e-9 && Math.abs(rz.belowMmH - 3.6) < 1e-9);
  const top = rootZone(sand, { topsoil: true });
  assert.ok(top.tawMm > rz.tawMm, '4 in of loam holds more than sand');
});

test('curve numbers: nearly all of a storm runs off paving, little off a lawn, more on a slope', () => {
  assert.ok(scsRunoff(50, 98) > 44);
  assert.equal(scsRunoff(25, 61), 0);
  assert.ok(Math.abs(scsRunoff(50, 80) - 37.3 ** 2 / (50 + 0.8 * 63.5)) < 0.05);
  assert.ok(Math.abs(cnSlope(70, 0.05) - 70) < 0.01, 'Williams\' slope form is the table value at 5%');
  assert.ok(cnSlope(70, 0.2) > 70 && cnSlope(70, 0.01) < 70);
  assert.equal(curveNumber('C/D', 'lawn', false), 74); assert.equal(curveNumber('C/D', 'lawn', true), 80);
});

// a 40 m square sloping 2% to the east, a 10 x 10 m roof in the middle
function lot({ roofs = [[15, 15, 25, 25]] } = {}) {
  const { cols, bbox } = cloud({ size: 40, density: 2, noise: 0.005, height: (x) => -0.02 * x, roofs, seed: 3 });
  return analyse(cols, bbox, LAT, { nullRuns: 0, floor: 0.05, useShadeRoofs: false });
}
const summer = (n = 120, { et0 = 5, rainEvery = 10, rainMm = 12 } = {}) => Array.from({ length: n }, (_, d) => {
  const date = new Date(Date.UTC(2025, 4, 15) + d * 864e5).toISOString().slice(0, 10);
  return { date, tmax: 28, tmin: 15, rain: d % rainEvery === 0 ? rainMm : 0, et0 };
});
const loam = { name: 'loam', drainage: 'Well drained', hydgrp: 'B', wetByMonth: new Array(12).fill(null), profile: { horizons: [{ topCm: 0, bottomCm: 150, awc: 0.15, ksatUmS: 3.7 }] }, polygons: [] };

test('the water balance adds up: rain = use + drained + run off the grid + what is still held', () => {
  const res = lot();
  const N = res.grid.W * res.grid.H;
  const kinds = Uint8Array.from(res.wall, (w) => (w ? 2 : 1));
  const routing = roofRouting(res.grid, res.wall, res.runoff.filled, {});
  const soils = [{ rz: rootZone(loam.profile), drainage: loam.drainage, hydgrp: loam.hydgrp, wetByMonth: loam.wetByMonth }];
  const model = buildModel(res, { kinds, soilAt: new Int16Array(N), soils, roofTo: routing.roofTo });
  const days = summer(90, { rainMm: 40, rainEvery: 7 });
  const out = simulate(model, days);
  let use = 0, drained = 0, left = 0, held = 0, roofLoss = 0;
  const rainDays = days.filter((d) => d.rain > 0).length;
  for (let i = 0; i < N; i++) {
    if (kinds[i] === 2) { roofLoss += rainDays * PARAMS.roofLossMm; continue; }
    use += out.et[i]; drained += out.drained[i];
    if (model.nRecv[i] === 0) left += out.ranOff[i];
    held += -out.end.Dr[i] + out.end.grav[i] + out.end.pond[i];
  }
  const rain = days.reduce((s, d) => s + d.rain, 0) * N;
  const err = rain - (use + drained + left + held + roofLoss);
  assert.ok(Math.abs(err) / rain < 1e-3, `off by ${err.toFixed(1)} of ${rain.toFixed(0)} L`);
});

test('watered the day before it would stress, a lawn cell never passes its readily available water', () => {
  const res = lot({ roofs: [] });
  const N = res.grid.W * res.grid.H;
  const soils = [{ rz: rootZone(loam.profile), drainage: loam.drainage, hydgrp: loam.hydgrp, wetByMonth: loam.wetByMonth }];
  const model = buildModel(res, { kinds: new Uint8Array(N).fill(1), soilAt: new Int16Array(N), soils, roofTo: new Int32Array(N).fill(-1) });
  const out = simulate(model, summer(), { irrigate: idealIrrigation(model) });
  assert.equal(Math.max(...out.dryDays), 0);
  const without = simulate(model, summer());
  assert.ok(Math.min(...without.dryDays) > 30, 'rain alone leaves it dry for weeks');
});

test('a downspout sends the roof to where it empties; two split it; none is a guess', () => {
  const res = lot();
  const g = res.grid;
  const at = (x, y) => fromMerc([g.bbox[0] + x / g.k, g.bbox[1] + y / g.k]); // m east/north of the corner -> lng/lat
  const roofCells = res.wall.reduce((s, v) => s + v, 0);
  const none = roofRouting(g, res.wall, res.runoff.filled, {});
  assert.equal(none.pieces.length, 1); assert.ok(none.pieces[0].guessed);
  const one = roofRouting(g, res.wall, res.runoff.filled, { downspouts: [{ from: at(25, 20), to: at(30, 20) }] });
  const outlets = Object.entries(one.pieces[0].outlets);
  assert.equal(outlets.length, 1, 'one downspout takes it all'); assert.equal(outlets[0][1], roofCells);
  const two = roofRouting(g, res.wall, res.runoff.filled, { downspouts: [{ from: at(25, 20), to: at(30, 20) }, { from: at(15, 20), to: at(10, 20) }] });
  const split = Object.values(two.pieces[0].outlets).sort((a, b) => a - b);
  assert.equal(split.length, 2); assert.ok(split[0] / roofCells > 0.35, `split ${split}`);
  // a gutter along the east eave only: the rest of the roof drips off its edges
  const gut = roofRouting(g, res.wall, res.runoff.filled, { downspouts: [{ from: at(25, 20), to: at(30, 20) }], gutters: [[at(25, 15), at(25, 25)]] });
  const big = Math.max(...Object.values(gut.pieces[0].outlets));
  assert.ok(big < roofCells * 0.5 && big > roofCells * 0.1, `the guttered side ${big} of ${roofCells}`);
});

test('a lawn half sand, half loam: two zones, and the sand is watered more often and less each time', () => {
  const res = lot({ roofs: [] });
  const g = res.grid;
  const corner = (x, y) => fromMerc([g.bbox[0] + x / g.k, g.bbox[1] + y / g.k]);
  const half = (x0, x1) => [[corner(x0, 0), corner(x1, 0), corner(x1, 40), corner(x0, 40), corner(x0, 0)]];
  const sandy = { ...loam, name: 'sand', hydgrp: 'A', profile: { horizons: [{ topCm: 0, bottomCm: 150, awc: 0.05, ksatUmS: 100 }] }, polygons: [half(0, 20)] };
  const silty = { ...loam, name: 'silt loam', profile: { horizons: [{ topCm: 0, bottomCm: 150, awc: 0.2, ksatUmS: 2 }] }, polygons: [half(20, 40)] };
  const lawn = new Uint8Array(g.W * g.H).fill(1);
  const days = [];
  for (let y = 0; y < 3; y++) for (const d of summer(150)) days.push({ ...d, date: `${2023 + y}${d.date.slice(4)}` });
  const plan = waterPlan(res, { lawnMask: lawn, soil: { units: [sandy, silty] }, typical: days });
  assert.equal(plan.zones.length, 2);
  const [often, seldom] = plan.zones;
  assert.ok(often.soils.includes('sand') && seldom.soils.includes('silt loam'), JSON.stringify(plan.zones.map((z) => z.soils)));
  const jul = (z) => z.months[6];
  assert.ok(jul(often).waterings > jul(seldom).waterings && jul(often).mmEach < jul(seldom).mmEach);
  assert.ok(Math.abs(often.m2 - seldom.m2) < 200, `${often.m2} / ${seldom.m2}`);
  assert.equal(plan.roofs.pieces, 0);
});

test('a lawn at the foot of a steep hill is flagged; one on a gentle rise is not', () => {
  // 600 m square, 10 m cells, row 0 north: a 15% hill falling south onto a flat strip, which falls 1% east
  const W = 60, H = 60, cell = 10, z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) z[r * W + c] = (r < 40 ? (40 - r) * cell * 0.15 : 0) - c * cell * 0.01 + (r >= 40 ? (r - 40) * 0.05 : 0);
  const [cx, cy] = toMerc([-85, 43]), k = mercScale(43), h = 300 / k;
  const dem = { W, H, cell, z, bbox: [cx - h, cy - h, cx + h, cy + h], k };
  const t = terrain(dem);
  const at = (r, c) => fromMerc([dem.bbox[0] + ((c + 0.5) / W) * (dem.bbox[2] - dem.bbox[0]), dem.bbox[3] - ((r + 0.5) / H) * (dem.bbox[3] - dem.bbox[1])]);
  const foot = hillside(dem, t, [28, 29, 30, 31, 32, 33].flatMap((c) => [at(40, c), at(41, c)]));
  assert.ok(foot.belowHill && foot.upslopeHa > 1, JSON.stringify(foot));
  assert.notEqual(foot.level, 'unlikely');
  const top = hillside(dem, t, [at(2, 30), at(3, 30)]);
  assert.equal(top.belowHill, false); assert.ok(top.twiPercentile < foot.twiPercentile);
});

test('grass beside paving to its south uses more water than grass in the open, and less to its north', () => {
  const res = lot({ roofs: [] });
  const g = res.grid, N = g.W * g.H;
  const kinds = new Uint8Array(N).fill(1);
  for (let r = 18; r < 22; r++) for (let c = 0; c < g.W; c++) kinds[r * g.W + c] = 3; // an east-west drive across the middle
  const soils = [{ rz: rootZone(loam.profile), drainage: loam.drainage, hydgrp: loam.hydgrp, wetByMonth: loam.wetByMonth }];
  const m = buildModel(res, { kinds, soilAt: new Int16Array(N), soils, roofTo: new Int32Array(N).fill(-1) });
  const north = m.heat[17 * g.W + 20], south = m.heat[22 * g.W + 20], far = m.heat[2 * g.W + 20];
  assert.ok(Math.abs(north - (1 + PARAMS.edgeBoost * (1 - 1 / PARAMS.edgeReachM))) < 1e-6, `north edge ${north}`); // drive to its south
  assert.ok(south > 1 && south < north, `south edge ${south}`);
  assert.equal(far, 1);
});

test('a downspout\'s water fans out downhill over several cells, not one line', () => {
  const res = lot();
  const g = res.grid, N = g.W * g.H;
  const at = (x, y) => fromMerc([g.bbox[0] + x / g.k, g.bbox[1] + y / g.k]);
  const kinds = Uint8Array.from(res.wall, (w) => (w ? 2 : 1));
  const routing = roofRouting(g, res.wall, res.runoff.filled, { downspouts: [{ from: at(25, 20), to: at(27, 20) }] });
  const soils = [{ rz: rootZone({ horizons: [{ topCm: 0, bottomCm: 150, awc: 0.05, ksatUmS: 0.5 }] }), drainage: 'Poorly drained', hydgrp: 'D', wetByMonth: new Array(12).fill(null) }];
  const m = buildModel(res, { kinds, soilAt: new Int16Array(N), soils, roofTo: routing.roofTo });
  const storm = [{ date: '2025-06-01', tmax: 25, tmin: 15, rain: 30, et0: 0 }];
  const withRoof = simulate(m, storm);
  const noRoof = simulate(buildModel(res, { kinds, soilAt: new Int16Array(N), soils, roofTo: new Int32Array(N).fill(-1) }), storm);
  // cells that took in more water because of the downspout
  let fed = 0;
  const held = (o, i) => o.end.grav[i] - o.end.Dr[i] + o.end.pond[i];
  for (let i = 0; i < N; i++) if (kinds[i] === 1 && held(withRoof, i) - held(noRoof, i) > 0.5) fed++;
  assert.ok(fed >= 10, `cells reached by the downspout's water: ${fed}`);
});

test('Overture: PMTiles tile ids follow the spec, a vector tile decodes, a road becomes a band its width', () => {
  // the PMTiles v3 spec's own examples
  assert.deepEqual([tileId(0, 0, 0), tileId(1, 0, 0), tileId(1, 0, 1), tileId(1, 1, 1), tileId(1, 1, 0), tileId(2, 0, 0)], [0, 1, 2, 3, 4, 5]);
  assert.equal(tileId(20, 0, 0), 366503875925);
  // a hand-built tile: layer "segment", one line (0,0)->(10,0) with class=residential
  const vint = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
  const zz = (n) => (n << 1) ^ (n >> 31);
  const field = (f, w, bytes) => [...vint((f << 3) | w), ...(w === 2 ? vint(bytes.length) : []), ...bytes];
  const str = (t) => [...new TextEncoder().encode(t)];
  const geom = [...vint((1 & 7) | (1 << 3)), ...vint(zz(0)), ...vint(zz(0)), ...vint((2 & 7) | (1 << 3)), ...vint(zz(10)), ...vint(zz(0))];
  const feat = [...field(2, 2, [0, 0]), ...field(3, 0, vint(2)), ...field(4, 2, geom)];
  const layer = [...field(1, 2, str('segment')), ...field(2, 2, feat), ...field(3, 2, str('class')), ...field(4, 2, field(1, 2, str('residential'))), ...field(5, 0, vint(4096))];
  const tile = decodeMvt(Uint8Array.from(field(3, 2, layer)));
  assert.equal(tile.segment.features[0].props.class, 'residential');
  assert.deepEqual(tile.segment.features[0].geom[0], [[0, 0], [10, 0]]);
  // an 8 m road across a 40 m grid, and a 10 x 10 m building
  const { bbox } = cloud({ size: 40, density: 0.1, height: () => 0 });
  const g = gridFor(bbox, LAT);
  const at = (x, y) => fromMerc([g.bbox[0] + x / g.k, g.bbox[1] + y / g.k]);
  const m = overtureMasks(g, { roads: [{ cls: 'residential', width: 8, walk: false, lines: [[at(0, 20), at(40, 20)]] }], buildings: [[[at(5, 5), at(15, 5), at(15, 15), at(5, 15), at(5, 5)]]] });
  let col = 0; for (let r = 0; r < g.H; r++) if (m.paved[r * g.W + 20]) col++;
  assert.ok(col >= 7 && col <= 9, `road band ${col} cells across`);
  const b = m.building.reduce((a, v) => a + v, 0);
  assert.ok(b >= 90 && b <= 110, `building ${b} cells`);
});

test('zones hold still: marking a 3 x 3 m bed moves no more lawn between zones than about the bed itself', () => {
  const res = lot({ roofs: [] });
  const g = res.grid;
  const corner = (x, y) => fromMerc([g.bbox[0] + x / g.k, g.bbox[1] + y / g.k]);
  const half = (x0, x1) => [[corner(x0, 0), corner(x1, 0), corner(x1, 40), corner(x0, 40), corner(x0, 0)]];
  const sandy = { ...loam, name: 'sand', hydgrp: 'A', profile: { horizons: [{ topCm: 0, bottomCm: 150, awc: 0.05, ksatUmS: 100 }] }, polygons: [half(0, 20)] };
  const silty = { ...loam, name: 'silt loam', profile: { horizons: [{ topCm: 0, bottomCm: 150, awc: 0.2, ksatUmS: 2 }] }, polygons: [half(20, 40)] };
  const days = [];
  for (let y = 0; y < 3; y++) for (const d of summer(150)) days.push({ ...d, date: `${2023 + y}${d.date.slice(4)}` });
  const opts = { lawnMask: new Uint8Array(g.W * g.H).fill(1), soil: { units: [sandy, silty] }, typical: days };
  const a = waterPlan(res, opts);
  const b = waterPlan(res, { ...opts, areas: [{ kind: 'bed', ring: [corner(30, 30), corner(33, 30), corner(33, 33), corner(30, 33)] }] });
  assert.equal(a.zones.length, b.zones.length);
  let moved = 0;
  for (let i = 0; i < g.W * g.H; i++) if (a.zoneOf[i] >= 0 && b.zoneOf[i] >= 0 && a.zoneOf[i] !== b.zoneOf[i]) moved++;
  assert.ok(moved <= 20, `${moved} cells changed zone`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water plan: ${tests.length} passed`);
