// scan/lib/geo.js: ARCore's Geospatial pose as a placement on the map. node scan/test/geo.test.js
import assert from 'node:assert/strict';
import { geoReading, geoT, geoPrior, geoFit, rotate, GEO_FRESH_MS } from '../lib/geo.js';
import { fromLocal } from '../lib/frames.js';
import { apply } from '../lib/align.js';
import { newLocate, priorFor, fitFor, fitSource, status } from '../lib/locate.js';

const near = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);
const axis = ([x, y, z], deg) => { const h = (deg * Math.PI) / 360, s = Math.sin(h), n = Math.hypot(x, y, z); return { x: (x / n) * s, y: (y / n) * s, z: (z / n) * s, w: Math.cos(h) }; };
const mul = (a, b) => ({ x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z });
const origin = [-77.1, 38.9];

// rotate: a quarter turn about up takes x to -z
{ const [x, y, z] = rotate(axis([0, 1, 0], 90), [1, 0, 0]); near(x, 0); near(y, 0); near(z, -1); }

// the session turned by alpha about up from East-Up-South: the reading gives back alpha and lands the phone where ARCore says
for (const alpha of [0, 37, 90, 181, -120]) for (const tilt of [axis([1, 0.3, 0.2], 50), axis([0, 0, 1], -20), { x: 0, y: 0, z: 0, w: 1 }]) {
  const qs = mul(axis([0, 1, 0], 15), tilt);                       // the camera in the session: any pitch and roll
  const qe = mul(axis([0, 1, 0], alpha), qs);                      // the same camera in East-Up-South
  const [lng, lat] = fromLocal(origin, [10, 20]);
  const geo = { state: 'ENABLED', lat, lng, hacc: 1.2, yawAcc: 2, eus: [qe.x, qe.y, qe.z, qe.w] };
  const r = geoReading(geo, { position: { x: 3, y: 1.5, z: -4 }, quaternion: qs }, origin);
  near(Math.cos(r.theta), Math.cos((alpha * Math.PI) / 180), 1e-9, `alpha ${alpha}`);
  near(Math.sin(r.theta), Math.sin((alpha * Math.PI) / 180), 1e-9, `alpha ${alpha}`);
  assert.deepEqual(r.phone, [3, 4]);
  const [e, n] = apply(geoT(r), r.phone);
  near(e, 10, 1e-6); near(n, 20, 1e-6);
}
// a quarter turn: the session's x axis points north on the map
{
  const qs = { x: 0, y: 0, z: 0, w: 1 }, qe = axis([0, 1, 0], 90);
  const [lng, lat] = fromLocal(origin, [0, 0]);
  const r = geoReading({ state: 'ENABLED', lat, lng, hacc: 1, yawAcc: 1, eus: [qe.x, qe.y, qe.z, qe.w] }, { position: { x: 0, y: 0, z: 0 }, quaternion: qs }, origin);
  const [e, n] = apply(geoT(r), [1, 0]); near(e, 0, 1e-9); near(n, 1, 1e-9);
}
// not whole: no reading
assert.equal(geoReading({ state: 'ENABLED' }, { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }, origin), null);
assert.equal(geoReading({ state: 'ENABLED', lat: 1, lng: 2, hacc: 1, eus: [0, 0, 0] }, { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }, origin), null);

// the prior and the fit, by ARCore's own accuracies and the reading's age
{
  const base = { at: [10, 20], phone: [3, 4], theta: 0.5, t: 1000 };
  const sure = { ...base, hacc: 1, yawAcc: 2 }, turn = { ...base, hacc: 4, yawAcc: 10 }, place = { ...base, hacc: 9, yawAcc: 40 }, bad = { ...base, hacc: 30, yawAcc: 3 };
  assert.ok(geoFit(sure, 2000)); assert.equal(geoFit(turn, 2000), null);
  assert.equal(geoFit(sure, 1000 + GEO_FRESH_MS + 1), null, 'stale');
  const p1 = geoPrior(sure, 2000); assert.ok(p1.T); assert.equal(p1.searchM, 2); assert.equal(p1.searchDeg, 6); assert.equal(p1.from, 'Street View');
  const p2 = geoPrior(turn, 2000); assert.ok(p2.T); assert.equal(p2.searchM, 6); assert.equal(p2.searchDeg, 20);
  const p3 = geoPrior(place, 2000); assert.equal(p3.T, undefined); assert.deepEqual(p3.at, [10, 20]); assert.equal(p3.radiusM, 13.5);
  assert.equal(geoPrior(bad, 2000), null);

  // in locate.js: Street View goes before GPS (unless GPS is the closer place and Street View has no turn), after the references
  const L = newLocate();
  L.gps = { at: [0, 0], phone: [0, 0], acc: 5, t: 1500 };
  assert.equal(priorFor(L, 0, 2000).from, 'GPS');
  L.geo = place; assert.equal(priorFor(L, 0, 2000).from, 'GPS', 'GPS 5 m beats a 9 m place');
  L.geo = turn; assert.equal(priorFor(L, 0, 2000).from, 'Street View');
  L.geo = sure;
  assert.equal(fitSource(L, 0, 2000), 'geo');
  const T = fitFor(L, 0, 2000); const [e, n] = apply(T, [3, 4]); near(e, 10, 1e-9); near(n, 20, 1e-9);
  assert.match(status(L, 0), /Not placed yet|Street View/);
  assert.equal(fitFor(L, 0, 1000 + GEO_FRESH_MS + 5), null, 'stale: no fit');
}
// (2026-11-07) a walk's live.json with its Street View trail must pass the site's guard against degrees: every
// live.json was refused while the trail kept lat/lng, and the walks lost their pins and trails with it
{
  const { liveOf } = await import('../lib/twin.js');
  const { leaks } = await import('../src/twin.js');
  const trail = [{ tms: 1, at: [10.5, 20.25], theta: 0.5, alt: 30, hacc: 1.2, vacc: 2, yawAcc: 3, phone: [1, 2], y: 1.5, odo: 4 }];
  const live = liveOf(null, { pins: [{ name: 'P1', at: { x: 1, y: 0, z: 2 }, odo: 3 }] }, { geoTrail: trail, crumbs: [{ odo: 1, m: 0.1, level: 0.1, at: { x: 0, y: 0, z: 0 }, at0: { x: 0, y: 0, z: 0 } }] });
  assert.equal(leaks(JSON.stringify(live)), false, 'live.json passes the guard');
  assert.equal(leaks(JSON.stringify({ geoTrail: [{ lat: 1, lng: 2 }] })), true, 'the guard still catches degrees');
}
console.log('geo: ok');
