/**
 * The heat view's numbers (water/lib/heat.js).
 *   node water/test/heat.test.js
 */
import assert from 'node:assert/strict';
import { heatOfMonth, monthWeather, W_PER_MJ } from '../lib/heat.js';
import { PARAMS } from '../lib/balance.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok  ${name}`); }

// July days, Michigan-like: 28/16 C, wind 2.5 m/s, sunshine 24 MJ/m2
const july = (over = {}) => Array.from({ length: 10 }, (_, k) => ({ date: `2024-07-${String(k + 10).padStart(2, '0')}`, tmax: 28, tmin: 16, rh: 65, wind: 2.5, rs: 24, ...over }));

test('night sky cooling falls as the air gets damper and as it clouds over (FAO-56 net longwave)', () => {
  const dry = monthWeather(july({ rh: 45 }), 6, 43), damp = monthWeather(july({ rh: 85 }), 6, 43);
  const clear = monthWeather(july({ rs: 27 }), 6, 43), cloudy = monthWeather(july({ rs: 12 }), 6, 43);
  assert.ok(damp.rnl < dry.rnl * 0.85, `damp ${damp.rnl.toFixed(2)} against dry ${dry.rnl.toFixed(2)} MJ/m2`);
  assert.ok(cloudy.rnl < clear.rnl * 0.6, `cloudy ${cloudy.rnl.toFixed(2)} against clear ${clear.rnl.toFixed(2)} MJ/m2`);
  assert.equal(monthWeather(july(), 0, 43), null, 'no January days: no month');
});

test('against the open lawn: a shaded spot gets less sun and loses less to the sky; a fence and paving add; trees cool the air', () => {
  // three spots: open lawn; under a crown (20% of the sun, 30% of the sky); beside paving with a fence
  const one = (a) => Float32Array.from(a);
  const rad = Array.from({ length: 12 }, () => ({ parB: one([1, 0.2, 1]), parD: one([1, 0.3, 0.8]), nirB: one([1, 0.35, 1]), nirD: one([1, 0.45, 0.8]) }));
  const fenceHeat = { beam: Array.from({ length: 12 }, () => one([0, 0, 0.05])), reflSky: one([0, 0, 0.02]), sky: one([0, 0, 0.1]) };
  const model = { N: 3, params: { ...PARAMS, kc: 0.8 }, g: { lat: 43 }, rad, fenceHeat, edgeHeat: one([1, 1, 1.06]), canopy: one([0, 0.8, 0.1]) };
  const h = heatOfMonth(model, july(), 6);
  const { sun, sky, fence, paving, net } = h.ground;
  assert.ok(Math.abs(sun[0]) < 1e-3 && Math.abs(sky[0]) < 1e-3 && net[0] === 0, 'the open lawn is the zero');
  assert.ok(sun[1] < -100, `shade takes most of the sun: ${sun[1].toFixed(0)} W/m2`);
  assert.ok(sky[1] > 10, `and keeps the heat the open sky would take: ${sky[1].toFixed(0)} W/m2`);
  assert.ok(net[1] < 0, 'in July the shade is cooler on balance');
  assert.ok(fence[2] > 0 && paving[2] > 0 && net[2] > 0, `the fence and paving side is warmer: ${net[2].toFixed(1)} W/m2`);
  assert.ok(Math.abs(paving[2] - 0.06 * 2.45 * 0.8 * h.weather.et0 * W_PER_MJ) < 1e-3);
  assert.ok(h.night[0] > h.night[1], 'the open spot loses the most to the night sky');
  assert.ok(h.air[1] < h.air[2] && h.air[2] < 0 && h.air[0] === 0, `trees cool the air round them: ${h.air[1].toFixed(2)} C`);
  assert.ok(h.air[1] >= -PARAMS.airCoolC);
  // without the shade map's radiation the sun is the shade share, and the sky is the open sky
  const flat = heatOfMonth({ N: 2, params: { ...PARAMS, kc: 0.8 }, g: { lat: 43 }, light: one([1, 0.5]) }, july(), 6);
  assert.ok(flat.ground.sun[1] < 0 && flat.ground.sky[1] === 0 && flat.air[1] === 0);
  // out of the growing season the air's cooling is not applied by the balance, and the view says so
  assert.equal(heatOfMonth(model, july(), 6, { season: new Set([0, 1, 2]) }).inSeason, false);
});

console.log(`water heat: ${passed} passed`);
