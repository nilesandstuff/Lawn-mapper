/**
 * The surface at this minute (water/lib/surfacenow.js).
 *   node water/test/surfacenow.test.js
 */
import assert from 'node:assert/strict';
import { sunshineNow, skyLongwave, momentOf, surfaceNowAt, openNow } from '../lib/surfacenow.js';
import { PARAMS } from '../lib/balance.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok  ${name}`); }

const LAT = 42.5, LNG = -85.5;
const noonJuly = Date.UTC(2026, 6, 15, 17, 40); // about solar noon at 85.5 W
const nightJuly = Date.UTC(2026, 6, 16, 9, 0); // 5 am EDT
const model = { params: PARAMS, rad: null, fenceHeat: null, edgeHeat: null, canopy: null, winds: [1], windAt: null };

test('sunshine: none at night; a clear July noon near 900 W/m2; overcast far less; the split moves to the sky', () => {
  assert.equal(sunshineNow(-5).ghi, 0);
  const clear = sunshineNow(68), dull = sunshineNow(68, { cloud: 1 });
  assert.ok(clear.ghi > 800 && clear.ghi < 1050, `clear ${clear.ghi.toFixed(0)}`);
  assert.ok(dull.ghi < 0.3 * clear.ghi, `overcast ${dull.ghi.toFixed(0)}`);
  assert.ok(clear.beam > clear.sky && dull.sky > dull.beam, 'clear mostly beam, overcast mostly sky');
  assert.equal(sunshineNow(68, { ghi: 500 }).ghi, 500, 'a measured value is used as it is');
});

test('the sky\'s longwave: 280-360 W/m2 clear at 20 C, the full black body under cloud', () => {
  const clear = skyLongwave(20, 50, 0), cloudy = skyLongwave(20, 50, 1);
  assert.ok(clear > 280 && clear < 360, `clear ${clear.toFixed(0)}`);
  assert.ok(Math.abs(cloudy - 5.67e-8 * 293.15 ** 4) < 1, `cloudy ${cloudy.toFixed(0)}`);
  assert.ok(skyLongwave(20, 90, 0) > clear, 'damper air radiates more');
});

test('a sunny July noon: watered grass near the air, dry grass much hotter, shade cooler, wind cools', () => {
  const w = momentOf({ t: noonJuly, lat: LAT, lng: LNG, ta: 28, rh: 55, wind: 2 });
  assert.ok(w.el > 60, `sun at ${w.el.toFixed(0)} degrees`);
  const wet = surfaceNowAt(model, 0, 1, w, { month: 6, ks: 1 });
  const dry = surfaceNowAt(model, 0, 1, w, { month: 6, ks: 0.2 });
  const shade = surfaceNowAt(model, 0, 0, w, { month: 6, ks: 1 });
  const calm = surfaceNowAt(model, 0, 1, { ...w, wind: 0.5 }, { month: 6, ks: 0.2 });
  assert.ok(wet.dT > -2 && wet.dT < 6, `watered ${wet.dT.toFixed(1)} C over the air`);
  assert.ok(dry.dT > wet.dT + 6, `dry ${dry.dT.toFixed(1)} against watered ${wet.dT.toFixed(1)}`);
  assert.ok(shade.dT < wet.dT, `shade ${shade.dT.toFixed(1)} against sun ${wet.dT.toFixed(1)}`);
  assert.ok(calm.dT > dry.dT, 'still air: hotter');
  assert.ok(Math.abs(openNow(w, PARAMS).dT - wet.dT) < 1e-9, 'the open reference is the open, watered cell');
});

test('before dawn: below the air under a clear sky, near it under cloud; a sheltered spot cools less', () => {
  const clear = momentOf({ t: nightJuly, lat: LAT, lng: LNG, ta: 16, rh: 70, wind: 1, cloud: 0 });
  const cloudy = momentOf({ t: nightJuly, lat: LAT, lng: LNG, ta: 16, rh: 70, wind: 1, cloud: 1 });
  assert.ok(clear.el < 0);
  const a = surfaceNowAt(model, 0, 0, clear, { month: 6 }), b = surfaceNowAt(model, 0, 0, cloudy, { month: 6 });
  assert.ok(a.dT < -1, `clear night ${a.dT.toFixed(1)} C`);
  assert.ok(b.dT > a.dT + 1 && b.dT <= 0.01, `cloudy night ${b.dT.toFixed(1)} C`);
  const under = { ...model, rad: [0, 0, 0, 0, 0, 0, 1].map(() => ({ parB: [0], parD: [0.3], nirB: [0], nirD: [0.4] })) };
  assert.ok(surfaceNowAt(under, 0, 0, clear, { month: 6 }).dT > a.dT, 'less sky seen: less cooling');
});

test('the cloud is read back from measured sunshine when not given', () => {
  const w = momentOf({ t: noonJuly, lat: LAT, lng: LNG, ta: 28, rh: 55, wind: 2, ghi: 250 });
  assert.ok(w.cloud > 0.7, `cloud ${w.cloud.toFixed(2)} from 250 W/m2 at noon`);
  assert.equal(w.cloudFrom, 'from the sunshine');
});

console.log(`\n${passed} passed`);
