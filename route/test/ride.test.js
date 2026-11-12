// Riding between close stops: by road within 1,000 ft, or across back yards; 5 minutes saved a time.
import assert from 'node:assert/strict';
import { closeness, metres, rideAdjust, rideLeg, RIDE_DEFAULTS, rulesFrom } from '../lib/ride.js';
import { pathCost, solvePath } from '../lib/solve.js';
import { routeCost, splitRoutes } from '../lib/split.js';

const at = (dx, dy) => ({ lng: -85.7 + dx / 81900, lat: 42.8 + dy / 111000 }); // metres east, north
assert.ok(Math.abs(metres(at(0, 0), at(300, 400)) - 500) < 2);

// close by road; across the yards (road round is long); neither
assert.equal(closeness(at(0, 0), at(250, 0), 280), 'road');
assert.equal(closeness(at(0, 0), at(0, 60), 900), 'yard', 'back to back: 60 m across, 900 m by road');
assert.equal(closeness(at(0, 0), at(0, 400), 600), null);
assert.equal(closeness(at(0, 0), at(250, 0), 280, { ...RIDE_DEFAULTS, save: 0 }), null, 'switched off');
const r = rulesFrom({ roadFt: 1000, yardFt: 230, saveMin: 5 });
assert.ok(Math.abs(r.road - 304.8) < 0.01 && Math.abs(r.yard - 70.1) < 0.1 && r.save === 300);

// a day where riding changes the order: two close pairs far apart, the shop between
const pts = [at(0, 0), at(200, 0), at(3000, 0), at(3000, 60), at(1500, 1500)]; // 0-1 by road, 2-3 back to back, 4 shop
const roadM = (a, b) => (Math.abs(a.lat - b.lat) * 111000 > 50 && Math.abs(a.lng - b.lng) < 1e-6 ? 900 : metres(a, b) * 1.3);
const M = pts.map((a) => pts.map((b) => (a === b ? 0 : roadM(a, b))));
const D = M.map((row) => row.map((m) => m / 11 + (m ? 30 : 0)));
const { D: R, close } = rideAdjust(D, M, pts, (i) => i < 4);
assert.equal(close(0, 1), 'road');
assert.equal(close(2, 3), 'yard');
assert.equal(close(0, 4), null, 'never to the shop');
assert.ok(R[0][1] < 0 && R[2][3] < 0, 'a close step costs less than nothing: the saving outweighs it');
assert.equal(R[0][2], D[0][2], 'far steps unchanged');

// one person: the close pairs come out next to each other
const order = solvePath([[0, ...R[0].slice(0)], ...R.map((row) => [1e9, ...row])].map((row, i) => (i === 0 ? row.map((x, j) => (j === 0 ? 0 : j === 5 ? 1e9 : 0)) : row)));
const visit = order.slice(1, -1).map((i) => i - 1);
const pos = (s) => visit.indexOf(s);
assert.equal(Math.abs(pos(0) - pos(1)), 1, '0 and 1 together');
assert.equal(Math.abs(pos(2) - pos(3)), 1, '2 and 3 together');

// two people: each close pair stays with one person
const service = [1200, 1200, 1200, 1200, 0];
const { routes } = splitRoutes(R, { stops: [0, 1, 2, 3], shop: 4, service, people: 2, timeMs: 300 });
for (const pair of [[0, 1], [2, 3]]) assert.ok(routes.some((rt) => pair.every((s) => rt.includes(s))), `pair ${pair} on one route`);
assert.ok(routeCost(R, routes[0], 4, service) < routeCost(D, routes[0], 4, service), 'the saving counted');

// a leg as shown
const leg = rideLeg({ duration: 60, distance: 250 }, at(0, 0), at(250, 0));
assert.equal(leg.ride, 'road');
assert.equal(leg.saved, 300);
assert.deepEqual(rideLeg({ duration: 400, distance: 3000 }, at(0, 0), at(2500, 0)), { duration: 400, distance: 3000 });
const yard = rideLeg({ duration: 200, distance: 900 }, at(0, 0), at(0, 60));
assert.equal(yard.ride, 'yard');
assert.ok(yard.duration < 200, 'across the yards beats the road round');
console.log('route ride: ok');
