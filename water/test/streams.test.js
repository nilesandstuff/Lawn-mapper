/**
 * Streams and the flood plain (lib/streams.js, src/streams.js; FINDINGS H63). Made-up streams and flood maps.
 *   node water/test/streams.test.js
 */
import assert from 'node:assert/strict';
import { streamKind, streamReading } from '../lib/streams.js';
import { handleStreams } from '../src/streams.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const lat = 42.9, lng = -85.7, kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
const at = (e, n) => [lng + e / kx, lat + n / ky];
// a 20 x 20 m lawn centred on (0, 0), ground falling 1 m from north to south edge, 200 m above sea level at its middle
const lawn = []; for (let n = -10; n <= 10; n += 2) for (let e = -10; e <= 10; e += 2) lawn.push({ p: at(e, n), z: 200 + n / 20 });

test('NHD codes in words', () => {
  assert.equal(streamKind(46006), 'perennial'); assert.equal(streamKind(46003), 'intermittent'); assert.equal(streamKind(33600), 'ditch or canal');
});

test('the nearest stream that flows all year, and the lawn\'s height above its water', () => {
  const streams = [
    { name: 'Mill Creek', kind: 'perennial', km2: 12, line: [at(-300, -150), at(300, -150)] },
    { name: null, kind: 'intermittent', km2: 0.5, line: [at(-300, -40), at(300, -40)] },
  ];
  const r = streamReading({ streams, lawn, waterAt: (p) => (p[1] < at(0, -100)[1] ? 196.5 : 199.2) });
  assert.equal(r.perennial.name, 'Mill Creek'); assert.ok(Math.abs(r.perennial.distM - 150) <= 1, `${r.perennial.distM}`);
  assert.ok(Math.abs(r.perennial.aboveM - 3.5) < 0.06, `above ${r.perennial.aboveM}`);
  assert.equal(r.nearest.kind, 'intermittent'); assert.ok(Math.abs(r.nearest.distM - 40) <= 1);
});

test('FEMA: the zones over the lawn by share, and the 1% flood water from the nearest sections on one reach', () => {
  // zone AE over the south half of the lawn, X elsewhere; sections across the stream: 200.2 m upstream 30 m east, 200.0 m 30 m west, and another stream's at 210 m nearer
  const ring = (w, s, e, n) => [at(w, s), at(e, s), at(e, n), at(w, n), at(w, s)];
  const flood = {
    zones: [{ zone: 'AE', subtype: null, rings: [ring(-50, -60, 50, 0)] }, { zone: 'X', subtype: 'AREA OF MINIMAL FLOOD HAZARD', rings: [ring(-50, 0.01, 50, 60)] }],
    levels: [
      { m: 210.0, line: [at(-5, 20), at(-5, 30)], from: 'cross-section', datum: 'NAVD88' },
      { m: 200.2, line: [at(30, -60), at(30, 60)], from: 'cross-section', datum: 'NAVD88' },
      { m: 200.0, line: [at(-30, -60), at(-30, 60)], from: 'cross-section', datum: 'NAVD88' },
    ],
  };
  const r = streamReading({ streams: [], flood, lawn });
  const ae = r.zones.find((z) => z.zone === 'AE');
  assert.ok(ae && ae.share > 0.4 && ae.share < 0.6, JSON.stringify(r.zones));
  // the 210 m section is nearest, so it leads; with nothing within 2 m of it the plan takes it alone -- the reach rule
  assert.ok(Math.abs(r.flood.m - 210) < 1e-9 && /cross-section/.test(r.flood.from));
  // with the other stream gone, the two sections on the lawn's reach, by distance: 200.1
  const r2 = streamReading({ streams: [], flood: { ...flood, levels: flood.levels.slice(1) }, lawn });
  assert.ok(Math.abs(r2.flood.m - 200.1) < 1e-6, `${r2.flood.m}`);
  // a lawn in zone X with the river's sections 500 m off: no flood level quoted for it
  const far = streamReading({ streams: [], flood: { zones: [{ zone: 'X', subtype: 'AREA OF MINIMAL FLOOD HAZARD', rings: [ring(-60, -60, 60, 60)] }], levels: [{ m: 190, line: [at(500, -60), at(500, 60)], from: 'cross-section' }, { m: 190.3, line: [at(520, -60), at(520, 60)], from: 'cross-section' }] }, lawn });
  assert.equal(far.flood, null);
  assert.ok(r2.flood.depthShare > 0.4 && r2.flood.depthShare < 0.7 && Math.abs(r2.flood.maxDepthM - 0.6) < 1e-6, `${r2.flood.depthShare} ${r2.flood.maxDepthM}`);
});

test('the water site\'s stream route: asks again when the service drops a request, and answers its features', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; if (n < 2) return { ok: false, status: 504 }; return { ok: true, json: async () => ({ features: [{ attributes: { gnis_name: 'Rush Creek', fcode: 46006 }, geometry: { paths: [[[0, 0], [1, 1]]] } }] }) }; };
  const res = await handleStreams(new Request('https://x/api/water/streams?lng=-85.86&lat=42.87'), new URL('https://x/api/water/streams?lng=-85.86&lat=42.87'), null, { fetchImpl, cache: null });
  const j = await res.json();
  assert.equal(res.status, 200); assert.equal(n, 2); assert.equal(j.features[0].attributes.gnis_name, 'Rush Creek');
  assert.match(res.headers.get('Cache-Control'), /max-age=2592000/);
  const bad = await handleStreams(new Request('https://x/api/water/streams'), new URL('https://x/api/water/streams'), null, { fetchImpl, cache: null });
  assert.equal(bad.status, 400);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water streams: ${tests.length} passed`);
