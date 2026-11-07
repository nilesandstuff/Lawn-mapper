// scan/lib/maps-pick.js: the nearest saved map. node scan/test/maps-pick.test.js
import assert from 'node:assert/strict';
import { metresBetween, byDistance, nearestMap, mapLabel, NEAR_M } from '../lib/maps-pick.js';

const here = [-77.0, 38.9];
const d = metresBetween(here, [-77.0, 38.9009]); // about 100 m north
assert.ok(Math.abs(d - 100) < 1, `${d}`);
const maps = [{ id: 'far', lng: -77.01, lat: 38.9 }, { id: 'near', lng: -77.0, lat: 38.9005 }, { id: 'noplace' }];
assert.deepEqual(byDistance(maps, here).map((x) => x.map.id), ['near', 'far'], 'nearest first; maps with no place left out');
assert.deepEqual(byDistance(maps, null).map((x) => x.map.id), ['far', 'near'], 'as given without a place');
assert.equal(nearestMap(maps, here)?.map.id, 'near');
assert.equal(nearestMap(maps, here, NEAR_M + 1), null, 'not with a fix worse than the reach');
assert.equal(nearestMap([{ id: 'far', lng: -77.01, lat: 38.9 }], here), null, 'none within reach');
assert.equal(nearestMap(maps, null), null);
assert.equal(mapLabel({ name: 'Home' }), 'Home');
console.log('maps-pick: ok');
