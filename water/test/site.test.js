/**
 * The water site's Worker and build, and the property-on-the-grid pieces
 * (water session).   node water/test/site.test.js
 */

import assert from 'node:assert/strict';

import { upstreamFor } from '../src/index.js';
import { waterDomainFor, wranglerFor } from '../tools/prepare.mjs';
import { gridFor } from '../lib/surface.js';
import { maskOf, boundsOf } from '../lib/geo.js';
import { toMerc, mercScale } from '../lib/ept.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the Worker passes only its five read routes on to Lawn Mapper', () => {
  const u = (p) => new URL(`https://water.example.com${p}`);
  assert.equal(upstreamFor(u('/api/geocode?q=1+Main'), 'lawnmap.example.com'), 'https://lawnmap.example.com/api/geocode?q=1+Main');
  assert.equal(upstreamFor(u('/api/shade/lidar?lng=1&lat=2'), 'lawnmap.example.com'), 'https://lawnmap.example.com/api/shade/lidar?lng=1&lat=2');
  for (const p of ['/api/maps', '/api/segment', '/api/admin/users', '/api/shade/readings', '/api/geocode/../maps']) {
    assert.equal(upstreamFor(u(p), 'lawnmap.example.com'), null, p);
  }
  assert.equal(upstreamFor(u('/api/geocode?q=x'), ''), null);
});

test('the domain comes from CUSTOM_DOMAIN, never from the repository', () => {
  assert.equal(waterDomainFor('lawnmap.example.com'), 'water.example.com');
  assert.equal(waterDomainFor('a.b.example.co.uk'), 'water.b.example.co.uk');
  assert.equal(waterDomainFor('example.com'), null);
  const toml = wranglerFor('water.example.com', 'lawnmap.example.com');
  assert.match(toml, /pattern = "water\.example\.com"\ncustom_domain = true/);
  assert.match(toml, /LAWNMAP = "lawnmap\.example\.com"/);
});

test('a property line lands on the right cells, holes and all', () => {
  const lat = 43, k = mercScale(lat);
  const [x0, y0] = toMerc([-85, lat]);
  const bbox = [x0, y0, x0 + 40 / k, y0 + 40 / k];
  const g = gridFor(bbox, lat);
  // a 20 m square 10-30 m east and north of the corner, with a 4 m hole in the middle
  const deg = (m) => m / 111320;
  const lng0 = -85, e = (m) => lng0 + deg(m) / Math.cos(lat * Math.PI / 180), n = (m) => lat + deg(m);
  const sq = (a, b) => [[e(a), n(a)], [e(b), n(a)], [e(b), n(b)], [e(a), n(b)], [e(a), n(a)]];
  const mask = maskOf(g, { type: 'Feature', geometry: { type: 'Polygon', coordinates: [sq(10, 30), sq(18, 22)] } });
  const cells = mask.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(cells - (400 - 16)) <= 30, `${cells} cells, expected about 384`);
  assert.deepEqual(boundsOf({ type: 'Polygon', coordinates: [sq(10, 30)] }).map((v) => +v.toFixed(6)), [e(10), n(10), e(30), n(30)].map((v) => +v.toFixed(6)));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water site: ${tests.length} passed`);
