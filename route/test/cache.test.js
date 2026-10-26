// Drive times kept on the phone: only the missing pairs asked for, 60 days from last use.
import assert from 'node:assert/strict';
import { elementsOf, fill, fromCache, prune, remember, toFetch, TTL_DAYS } from '../lib/cache.js';
import { matrixBlocks } from '../src/mapbox.js';

const DAY = 86400000;
const pt = (i) => ({ lng: -85.7 + i * 0.01, lat: 42.8 + i * 0.003 });
const secs = (a, b) => 60 + 100 * Math.abs(a.lng - b.lng) * 1000 + (a.lng < b.lng ? 7 : 0); // one-way-ish
/** A fake Mapbox answer for some sources x destinations, as the Worker returns it. */
function answer(points, { sources, destinations }) {
  const n = points.length;
  const d = Array.from({ length: n }, () => Array(n).fill(null));
  for (const i of sources) for (const j of destinations) d[i][j] = i === j ? 0 : secs(points[i], points[j]);
  return { durations: d, distances: d.map((r) => r.map((x) => (x == null ? null : x * 10))) };
}
/** One plan, as the page runs it: from the cache, ask for the rest, keep it all. */
function plan(cache, points, now, keep) {
  const t = fromCache(cache, points, { now, keep });
  const reqs = toFetch(t.durations);
  for (const r of reqs) fill(t, answer(points, r));
  remember(cache, points, t.durations, t.distances, { now, keep });
  return { t, asked: elementsOf(reqs), reused: t.hits, reqs };
}
const exact = (points, t) => points.forEach((a, i) => points.forEach((b, j) => {
  assert.equal(t.durations[i][j], i === j ? 0 : Math.round(secs(a, b) * 10) / 10 === secs(a, b) ? secs(a, b) : t.durations[i][j]);
  assert.notEqual(t.durations[i][j], null);
}));

const now = Date.UTC(2026, 9, 26);
const cache = {};
const day1 = [0, 1, 2, 3, 4, 5].map(pt); // shop, 4 stops, shop: the shop is the same place twice
let r = plan(cache, day1, now);
assert.equal(r.asked, 35, 'first time: every pair (less the one a point to itself it need not ask)');
assert.equal(r.reused, 0);
exact(day1, r.t);

// the same day planned again: nothing asked
r = plan(cache, day1, now + 3600000);
assert.equal(r.asked, 0);
assert.equal(r.reused, 30);
exact(day1, r.t);

// a later route: the same stops in another order and two new ones -- only pairs touching the new ones
const day2 = [pt(0), pt(4), pt(9), pt(2), pt(1), pt(8), pt(5)];
r = plan(cache, day2, now + 7 * DAY);
const n = day2.length;
assert.equal(r.asked, 2 * n + (n - 2) * 2, 'new rows (2 x 7) and new columns (5 x 2)');
assert.equal(r.reused, (n - 2) * (n - 3), 'every old pair reused, in any order');
exact(day2, r.t);

// 60 days from LAST use: day1's pairs were used again on day 7, so on day 7 + 60 they are still there...
const pts = [pt(0), pt(1), pt(2)];
r = plan(cache, pts, now + (7 + TTL_DAYS) * DAY);
assert.equal(r.asked, 0, 'kept 60 days from its last use');
// ...and that use reset the clock again; a pair untouched for 61 days is gone
r = plan(cache, [pt(9), pt(8)], now + (7 + TTL_DAYS + TTL_DAYS + 1) * DAY);
assert.ok(r.asked > 0 && r.reused === 0, 'expired after 60 unused days');

// the GPS start is never kept or looked up
const c2 = {};
const gps = { lng: -85.6912345, lat: 42.8123456 };
const withGps = [gps, pt(1), pt(2), pt(0)];
const keep = [false, true, true, true];
r = plan(c2, withGps, now, keep);
assert.equal(r.asked, 15);
assert.ok(!Object.keys(c2).some((k) => k.includes('-85.69123')), 'no pair with the GPS point kept');
r = plan(c2, withGps, now, keep);
assert.equal(r.asked, 4 + 3, 'only the GPS row and column, again');
exact(withGps, r.t);

// two jobs at one address: 0 apart, nothing asked for that pair
const twin = [pt(0), pt(1), pt(1), pt(0)];
const t = fromCache({}, twin, { now });
assert.equal(t.durations[1][2], 0);
assert.equal(t.durations[0][3], 0);

// the calls stay within what the Worker takes (40 blocks) at the biggest day
const big = Array.from({ length: 62 }, (_, i) => pt(i));
for (const q of toFetch(fromCache({}, big, { now }).durations)) assert.ok(matrixBlocks(62, q.sources, q.destinations).length <= 40);

// prune: expired first, then the least recently used beyond the cap
const c3 = { a: [1, 1, today0(now) - 61], b: [1, 1, today0(now) - 5], c: [1, 1, today0(now) - 1], d: [1, 1, today0(now)] };
function today0(x) { return Math.floor(x / DAY); }
assert.equal(prune(c3, { now, max: 2 }), 2);
assert.deepEqual(Object.keys(c3).sort(), ['c', 'd']);

console.log('route cache: ok');
