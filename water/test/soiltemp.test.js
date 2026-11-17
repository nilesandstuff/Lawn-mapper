/**
 * Each spot's soil column, coupled both ways to the surface (water/lib/soiltemp.js, FINDINGS H92), and the hours it
 * is spun up on (water/lib/momentweather.js spinHours).
 *   node water/test/soiltemp.test.js
 */
import assert from 'node:assert/strict';
import { soilProps, saxtonRawls, columnProps, fitAnnual, annualAt, stepColumn, skinOver, spinColumns, LAYERS, CENTRES } from '../lib/soiltemp.js';
import { spinHours } from '../lib/momentweather.js';
import { forcingAt, momentOf } from '../lib/surfacenow.js';
import { PARAMS } from '../lib/balance.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok  ${name}`); }

const DAY = 864e5;
const flat = { mean: 12, amp: 0, phase: 0, depthM: 0.1 };
// a day's forcing: the sun a half-sine 6 am-6 pm, the air swinging 6 C about 10 C, a light wind
const hourly = (h, { sun = 1, beta = 0.5, ta0 = 10 } = {}) => {
  const hr = h % 24, sw = hr >= 6 && hr < 18 ? 600 * sun * Math.sin((Math.PI * (hr - 6 + 0.5)) / 12) : 0;
  const ta = ta0 + 6 * Math.sin((2 * Math.PI * (hr - 9)) / 24);
  return { swNet: sw, rnIso: sw - 80, ta, ra: 100, beta: sw > 0 ? beta : 0 };
};
const run = (props, days, opts = {}, dt = 3600) => {
  const T = Float64Array.from(CENTRES, () => 10), skins = [];
  const per = 3600 / dt;
  for (let s = 0; s < days * 24 * per; s++) { const f = hourly(Math.floor(s / per), opts); skins.push(stepColumn(T, props, { ...f, tBottom: 10 }, dt).ts); }
  return { T, skins };
};

test('texture: Saxton & Rawls 2006 for a loam (their table: wilting 0.12, field capacity 0.26, saturation 0.45)', () => {
  const h = saxtonRawls(40, 18, 2);
  assert.ok(Math.abs(h.wp - 0.12) < 0.015 && Math.abs(h.fc - 0.26) < 0.015 && Math.abs(h.sat - 0.45) < 0.02, JSON.stringify(h));
  const clay = saxtonRawls(20, 50, 2), sand = saxtonRawls(92, 3, 2);
  assert.ok(clay.fc > h.fc && sand.fc < h.fc);
});

test('properties: a loam conducts about 0.9 W/m/K dry-ish and near 2 wet; wetter holds more heat', () => {
  const dry = soilProps({ sand: 40, clay: 20, om: 2, n: 0.45 }, 0.1), wet = soilProps({ sand: 40, clay: 20, om: 2, n: 0.45 }, 0.4);
  assert.ok(dry.lambda > 0.5 && dry.lambda < 1.3 && wet.lambda > 1.4 && wet.lambda < 2.3, `${dry.lambda} ${wet.lambda}`);
  assert.ok(wet.C > dry.C && wet.C < 3.2e6 && dry.C > 1.2e6);
  assert.equal(columnProps({ sand: 40, clay: 20 }, 15, 1).length, LAYERS.length);
});

test('a steady day: the column comes to a repeating cycle, and the day\'s swing dies away with depth (damping 10-20 cm)', () => {
  const props = columnProps({ sand: 40, clay: 20 }, 15, 1);
  const r = run(props, 30);
  // the swing in each layer over the last day, again from the top
  const T = Float64Array.from(r.T), sw = CENTRES.map(() => [Infinity, -Infinity]);
  for (let h = 0; h < 24; h++) { stepColumn(T, props, { ...hourly(h), tBottom: 10 }, 3600); T.forEach((v, k) => { sw[k][0] = Math.min(sw[k][0], v); sw[k][1] = Math.max(sw[k][1], v); }); }
  const amp = sw.map(([a, b]) => (b - a) / 2);
  const d = (CENTRES[4] - CENTRES[1]) / Math.log(amp[1] / amp[4]);
  assert.ok(d > 0.08 && d < 0.22, `damping depth ${d.toFixed(3)} m`);
  assert.ok(amp[7] < 0.05 * amp[0]);
  const last = r.skins.slice(-24), before = r.skins.slice(-48, -24);
  assert.ok(last.every((v, k) => Math.abs(v - before[k]) < 0.15), 'a repeating cycle');
});

test('energy: what goes into the ground over a cycle is what leaves at the bottom (to a few W/m2)', () => {
  const props = columnProps({ sand: 40, clay: 20 }, 15, 1);
  const T = Float64Array.from(CENTRES, () => 10);
  for (let h = 0; h < 24 * 60; h++) stepColumn(T, props, { ...hourly(h), tBottom: 10 }, 3600);
  let g = 0, out = 0;
  const kb = props[7].lambda / (LAYERS[7] / 2);
  for (let h = 0; h < 24; h++) { const s = stepColumn(T, props, { ...hourly(h), tBottom: 10 }, 3600); g += s.g + 0.05 * hourly(h).swNet; out += kb * (T[7] - 10); }
  assert.ok(Math.abs(g - out) / 24 < 3, `in ${(g / 24).toFixed(1)} out ${(out / 24).toFixed(1)}`);
});

test('the feedback: weeks of shade leave the soil colder, and the cold soil holds the shaded surface colder at night', () => {
  const props = columnProps({ sand: 40, clay: 20 }, 15, 1);
  const sun = run(props, 30, { sun: 1 }), shade = run(props, 30, { sun: 0.2 });
  assert.ok(shade.T[3] < sun.T[3] - 1, `10 cm: sun ${sun.T[3].toFixed(1)} shade ${shade.T[3].toFixed(1)}`);
  const night = hourly(2);
  assert.ok(skinOver(shade.T[0], night) < skinOver(sun.T[0], night) - 0.3);
});

test('wet ground swings less at the surface than dry (more heat taken in and given back)', () => {
  const wet = run(columnProps({ sand: 40, clay: 20 }, 15, 1), 20, { beta: 0 }), dry = run(columnProps({ sand: 40, clay: 20 }, 15, 0), 20, { beta: 0 });
  const swing = (s) => Math.max(...s.slice(-24)) - Math.min(...s.slice(-24));
  assert.ok(swing(wet.skins) < swing(dry.skins), `${swing(wet.skins).toFixed(1)} vs ${swing(dry.skins).toFixed(1)}`);
});

test('time step: hourly steps match quarter-hour ones to a few tenths', () => {
  const props = columnProps({ sand: 40, clay: 20 }, 15, 1);
  const a = run(props, 15, {}, 3600), b = run(props, 15, {}, 900);
  const late = (s, per) => s.filter((_, k) => k % per === per - 1).slice(-24);
  const da = late(a.skins, 1), db = late(b.skins, 4);
  const rms = Math.sqrt(da.reduce((x, v, k) => x + (v - db[k]) ** 2, 0) / 24);
  assert.ok(rms < 0.8, `rms ${rms.toFixed(2)}`);
  assert.ok(Math.abs(a.T[4] - b.T[4]) < 0.3);
});

test('the year\'s wave: fitted from a daily series, damped and delayed with depth', () => {
  const days = [];
  for (let d = 0; d < 730; d++) { const t = Date.UTC(2024, 0, 1) + d * DAY; days.push({ date: new Date(t).toISOString().slice(0, 10), t: 13 + 11 * Math.cos((2 * Math.PI * (d - 200)) / 365.25) }); }
  const fit = fitAnnual(days);
  assert.ok(Math.abs(fit.mean - 13) < 0.3 && Math.abs(fit.amp - 11) < 0.5, JSON.stringify(fit));
  const jul = Date.UTC(2025, 6, 19);
  assert.ok(Math.abs(annualAt(fit, 0.1, jul) - 24) < 1);
  assert.ok(annualAt(fit, 1.5, jul) < annualAt(fit, 0.1, jul) - 3);
  assert.equal(fitAnnual(days.slice(0, 30)), null);
});

test('spin-up: the hours\' forcing reaches the columns; a skipped hour leaves them alone', () => {
  const props = columnProps({ sand: 40, clay: 20 }, 15, 1);
  const hours = Array.from({ length: 24 * 10 }, (_, h) => ({ t: Date.UTC(2026, 9, 1) + h * 36e5 }));
  const r = spinColumns({ n: 2, hours, fit: flat, propsOf: () => props, forcing: (c, h) => (c === 1 ? null : hourly(h)) });
  assert.ok(r.T[0][0] !== 12 && r.T[1].every((v, k) => Math.abs(v - 12) < 1e-9 || k < 0));
  assert.equal(r.t, hours.at(-1).t + 36e5);
});

test('the archived hours: each hour from its two stamps, the sunshine from its end, a gap carried', () => {
  const t0 = Date.UTC(2026, 10, 1, 0);
  const j = { hourly: { time: ['2026-11-01T00:00', '2026-11-01T01:00', '2026-11-01T02:00', '2026-11-01T04:00'], temperature_2m: [10, 12, 14, 18], relative_humidity_2m: [80, 70, 60, 50], wind_speed_10m: [3, 3, 3, 3], shortwave_radiation: [0, 100, 200, 400], cloud_cover: [100, 50, 0, 0] } };
  const { hours, gaps } = spinHours(j, t0, t0 + 4 * 36e5);
  assert.equal(hours.length, 4);
  assert.equal(hours[0].ta, 11); assert.equal(hours[0].ghi, 100); assert.equal(hours[0].cloud, 0.5);
  assert.equal(hours[2].ta, 14); // 02:00 alone (03:00 missing)
  assert.equal(hours[3].ta, 18); assert.equal(gaps, 0);
  const g = spinHours({ hourly: { time: ['2026-11-01T00:00'], temperature_2m: [10] } }, t0, t0 + 3 * 36e5);
  assert.equal(g.hours.length, 3); assert.equal(g.gaps, 2);
});

test('forcingAt agrees with the surface at a minute: an open spot\'s skin over a top layer at the air is the version-1 skin less G', () => {
  const model = { params: PARAMS, rad: null, fenceHeat: null, edgeHeat: null, canopy: null, winds: [1], windAt: null };
  const w = momentOf({ t: Date.UTC(2026, 6, 15, 17, 40), lat: 42.5, lng: -85.5, ta: 28, rh: 50, wind: 2, cloud: 0 });
  const f = forcingAt(model, 0, 1, w, { month: 6, ks: 1 });
  assert.ok(f.swNet > 500 && f.rnIso > f.swNet - 200 && f.beta > 0.8 && f.beta < 1.1, JSON.stringify(f));
  const ts = skinOver(f.ta, f);
  assert.ok(ts > f.ta && ts < f.ta + 15, `skin ${ts.toFixed(1)}`);
});

console.log(`${passed} passed`);
