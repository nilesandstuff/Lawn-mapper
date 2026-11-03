// scan/src/index.js: the scan Worker's gate and forwarding. node scan/test/worker.test.js
import assert from 'node:assert/strict';
import worker, { upstreamFor, isAdmin, homeOf, ACCOUNT, PROXIED } from '../src/index.js';

const url = (p) => new URL(`https://scan.example.com${p}`);
// what goes to Lawn Mapper
{
  assert.equal(upstreamFor(url('/api/maps/one?id=7'), 'lawnmap.example.com'), 'https://lawnmap.example.com/api/maps/one?id=7');
  assert.equal(upstreamFor(url('/api/maps/tool?id=7&tool=scan'), 'lawnmap.example.com', 'POST'), 'https://lawnmap.example.com/api/maps/tool?id=7&tool=scan');
  assert.equal(upstreamFor(url('/api/imagery?lng=1'), 'lawnmap.example.com'), 'https://lawnmap.example.com/api/imagery?lng=1');
  assert.equal(upstreamFor(url('/api/imagery'), 'lawnmap.example.com', 'POST'), null, 'the public routes are GET only');
  assert.equal(upstreamFor(url('/api/admin/users'), 'lawnmap.example.com'), null, 'nothing else is passed on');
  assert.equal(upstreamFor(url('/api/maps'), ''), null, 'no host, nothing');
  assert.ok(ACCOUNT('/api/auth/me') && ACCOUNT('/api/tools') && !ACCOUNT('/api/parcel'));
  assert.ok(PROXIED.includes('/api/shade/lidar'));
  assert.equal(homeOf('lawnmap.example.com'), 'example.com');
}
// the gate: the admin sees the page; anyone else gets "not open yet" and no data; it fails closed
{
  const lawnmap = (who) => ({ fetch: async (req) => new Response(JSON.stringify(who ? { user: { admin: who === 'admin' } } : {}), { status: who ? 200 : 401, headers: { 'Content-Type': 'application/json' } }) });
  const assets = { fetch: async () => new Response('<html>page</html>', { headers: { 'Content-Type': 'text/html' } }) };
  const env = (who) => ({ ADMIN_ONLY: '1', LAWNMAP_HOST: 'lawnmap.example.com', LAWNMAP: lawnmap(who), ASSETS: assets });
  const get = (e, p) => worker.fetch(new Request(`https://scan.example.com${p}`, { headers: { Cookie: 'lm_session=x' } }), e);
  let r = await get(env('admin'), '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store', 'nothing behind the gate is cached for others');
  r = await get(env('admin'), '/vendor/xr/xr.js');
  assert.equal(r.headers.get('Cache-Control'), 'private, max-age=86400', "the engine's big files may sit in the phone's own cache");
  r = await get(env('user'), '/');
  assert.equal(r.status, 404);
  assert.match(await r.text(), /isn't open yet/);
  r = await get(env('user'), '/api/maps');
  assert.equal(r.status, 404);
  r = await get(env(null), '/');
  assert.equal(r.status, 404, 'signed out: not open');
  r = await get({ ADMIN_ONLY: '1', ASSETS: assets }, '/');
  assert.equal(r.status, 404, 'no binding: closed');
  assert.equal(await isAdmin(new Request('https://scan.example.com/'), { LAWNMAP: { fetch: async () => { throw new Error('down'); } }, LAWNMAP_HOST: 'x' }), false, 'an error is no');
  // sign-in routes pass through the gate so the admin can sign in at all
  r = await get(env(null), '/api/auth/me');
  assert.equal(r.status, 401, 'forwarded, answered by Lawn Mapper');
  // open: the page as is, the API forwarded
  const open = { ...env('user'), ADMIN_ONLY: '0' };
  r = await get(open, '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), null);
  r = await get(open, '/api/maps');
  assert.equal(r.status, 200);
  r = await get(open, '/api/nothing');
  assert.equal(r.status, 404);
}
// the walks kept on the site: the admin posts, lists, reads one, deletes; nothing with coordinates is kept
{
  const { cleanWalk, walks } = await import('../src/walks.js');
  assert.equal(cleanWalk(null).error, 'no walk');
  assert.equal(cleanWalk({ id: 'x y', engine: 'webxr' }).error, 'a walk needs an id');
  assert.equal(cleanWalk({ id: '1', engine: 'arkit' }).error, 'engine must be webxr or 8thwall');
  assert.match(cleanWalk({ id: '1', engine: 'webxr', pins: [{ lat: 42 }] }).error, /no coordinates/);
  const ok = cleanWalk({ id: '1793573191838', engine: 'webxr', when: '2026-11-01T22:46:31.838Z', phone: 'Mozilla/5.0', stats: { walkedM: 276.9 } });
  assert.equal(ok.row.at, Date.parse('2026-11-01T22:46:31.838Z'));
  assert.equal(ok.row.engine, 'webxr');
  // a fake D1
  const rows = new Map();
  const DB = { prepare: (sql) => ({ bind: (...v) => ({
    run: async () => { if (/INSERT/.test(sql)) rows.set(v[0], { id: v[0], at: v[1], engine: v[2], phone: v[3], json: v[4] }); if (/DELETE/.test(sql)) rows.delete(v[0]); return {}; },
    first: async () => rows.get(v[0]) || null,
    all: async () => ({ results: [...rows.values()].sort((a, b) => b.at - a.at) }),
  }), all: async () => ({ results: [...rows.values()].sort((a, b) => b.at - a.at) }) }) };
  const lawnmap = (who) => ({ fetch: async () => new Response(JSON.stringify({ user: { admin: who === 'admin' } }), { headers: { 'Content-Type': 'application/json' } }) });
  const env = (who, db = DB) => ({ ADMIN_ONLY: '1', LAWNMAP_HOST: 'lawnmap.example.com', LAWNMAP: lawnmap(who), DB: db });
  const call = (e, method, q = '', body = null) => walks(new Request(`https://scan.example.com/api/scan/walks${q}`, { method, headers: { Cookie: 'lm_session=x', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), e, new URL(`https://scan.example.com/api/scan/walks${q}`), { isAdmin });
  assert.equal(await walks(new Request('https://scan.example.com/api/other'), env('admin'), new URL('https://scan.example.com/api/other'), { isAdmin }), null, 'not its route');
  let r = await call(env('user'), 'GET');
  assert.equal(r.status, 404, 'not the admin: nothing');
  r = await call(env('admin', undefined), 'GET');
  assert.equal(r.status, 200);
  r = await call({ ...env('admin'), DB: undefined }, 'GET');
  assert.equal(r.status, 503, 'no database: says so');
  r = await call(env('admin'), 'POST', '', { id: 'w1', engine: 'webxr', when: '2026-11-01T22:00:00Z', pins: [] });
  assert.equal(r.status, 200);
  r = await call(env('admin'), 'POST', '', { id: 'w2', engine: '8thwall', when: '2026-11-01T23:00:00Z', pins: [{ name: 'P1' }] });
  assert.equal(r.status, 200);
  r = await call(env('admin'), 'POST', '', { id: 'w1', engine: 'webxr', when: '2026-11-01T22:00:00Z', measures: [{ tapedM: 10 }] });
  assert.equal(r.status, 200, 'posting again replaces');
  r = await call(env('admin'), 'GET');
  const list = (await r.json()).walks;
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'w2', 'newest first');
  assert.equal(list[1].summary.measures[0].tapedM, 10, 'the replacement is what is kept');
  r = await call(env('admin'), 'GET', '?id=w2');
  assert.equal((await r.json()).pins[0].name, 'P1');
  r = await call(env('admin'), 'GET', '?id=nope');
  assert.equal(r.status, 404);
  r = await call(env('admin'), 'POST', '', { id: 'w3', engine: 'webxr', pins: [{ at: { lng: 1 } }] });
  assert.equal(r.status, 400, 'coordinates refused');
  r = await call(env('admin'), 'DELETE', '?id=w1');
  assert.equal(r.status, 200);
  assert.equal(rows.size, 1);
  // through the Worker: the route answers before the static page would
  const full = { ...env('admin'), ASSETS: { fetch: async () => new Response('page') } };
  r = await worker.fetch(new Request('https://scan.example.com/api/scan/walks', { headers: { Cookie: 'lm_session=x' } }), full);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).walks.length, 1);
}
// the walks' twins (src/twin.js): parts in R2, admin only, named strictly, no degrees in the JSON
{
  const { twin, checkPart, typeOf } = await import('../src/twin.js');
  const { listed } = await import('../tools/r2.mjs');
  assert.ok(listed('name: lawn-scan-twins\ncreation_date: x') && listed('[{"name":"lawn-scan-twins"}]') && !listed('name: lawn-scan-twins-old'));
  assert.equal(checkPart('w 1', null).error, 'which walk?');
  assert.equal(checkPart('w1', '../x').error, 'not a twin part');
  for (const ok of ['meta.json', 'live.json', 'cloud-0003.bin', 'track-0000.bin', 'keys-0001.json', 'key-0042.jpg']) assert.ok(!checkPart('w1', ok).error, ok);
  assert.equal(typeOf('key-0001.jpg'), 'image/jpeg');
  const objs = new Map();
  const R2 = {
    put: async (k, body, o) => { objs.set(k, { body: new Uint8Array(body), type: o?.httpMetadata?.contentType, uploaded: new Date().toISOString() }); },
    get: async (k) => (objs.has(k) ? { body: objs.get(k).body } : null),
    list: async ({ prefix }) => ({ objects: [...objs.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.byteLength, uploaded: o.uploaded })), truncated: false }),
    delete: async (keys) => { for (const k of [].concat(keys)) objs.delete(k); },
  };
  const lawnmap = (who) => ({ fetch: async () => new Response(JSON.stringify({ user: { admin: who === 'admin' } }), { headers: { 'Content-Type': 'application/json' } }) });
  const env = (who, b = R2) => ({ ADMIN_ONLY: '1', LAWNMAP_HOST: 'lawnmap.example.com', LAWNMAP: lawnmap(who), TWIN: b });
  const call = (e, method, path, q = '', body) => twin(new Request(`https://scan.example.com${path}${q}`, { method, headers: { Cookie: 'lm_session=x' }, body }), e, new URL(`https://scan.example.com${path}${q}`), { isAdmin });
  assert.equal(await call(env('admin'), 'GET', '/api/scan/other'), null, 'not its route');
  assert.equal((await call(env('user'), 'GET', '/api/scan/twins')).status, 404, 'not the admin: nothing');
  assert.equal((await call({ ...env('admin'), TWIN: undefined }, 'GET', '/api/scan/twins')).status, 503, 'no bucket: says so');
  let r = await call(env('admin'), 'PUT', '/api/scan/twin', '?walk=w1&part=cloud-0000.bin', new Float32Array([1, 2, 3]).buffer);
  assert.equal(r.status, 200); assert.equal((await r.json()).bytes, 12);
  r = await call(env('admin'), 'PUT', '/api/scan/twin', '?walk=w1&part=live.json', JSON.stringify({ fixes: [], marks: [{ map: [1, 2] }] }));
  assert.equal(r.status, 200);
  r = await call(env('admin'), 'PUT', '/api/scan/twin', '?walk=w1&part=meta.json', JSON.stringify({ lat: 42 }));
  assert.equal(r.status, 400, 'degrees refused');
  r = await call(env('admin'), 'PUT', '/api/scan/twin', '?walk=w1&part=evil.html', 'x');
  assert.equal(r.status, 400, 'only twin parts');
  await call(env('admin'), 'PUT', '/api/scan/twin', '?walk=w2&part=key-0000.jpg', new Uint8Array([255, 216, 255]).buffer);
  r = await call(env('admin'), 'GET', '/api/scan/twins');
  const tl = (await r.json()).twins;
  assert.deepEqual(tl.map((x) => x.walk).sort(), ['w1', 'w2']); assert.equal(tl.find((x) => x.walk === 'w2').keys, 1);
  r = await call(env('admin'), 'GET', '/api/scan/twin', '?walk=w1');
  assert.deepEqual((await r.json()).parts.map((p) => p.name).sort(), ['cloud-0000.bin', 'live.json']);
  r = await call(env('admin'), 'GET', '/api/scan/twin', '?walk=w1&part=cloud-0000.bin');
  assert.deepEqual([...new Float32Array(await r.arrayBuffer())], [1, 2, 3]);
  assert.equal((await call(env('admin'), 'GET', '/api/scan/twin', '?walk=w1&part=track-0000.bin')).status, 404);
  r = await call(env('admin'), 'DELETE', '/api/scan/twin', '?walk=w1');
  assert.equal((await r.json()).deleted, 2); assert.equal(objs.size, 1);
  // through the Worker
  r = await worker.fetch(new Request('https://scan.example.com/api/scan/twins', { headers: { Cookie: 'lm_session=x' } }), { ...env('admin'), ASSETS: { fetch: async () => new Response('page') } });
  assert.equal((await r.json()).twins.length, 1);
}
// scan/tools/walks.mjs: the one-line headline and wrangler's JSON rows
{
  const { headline, rowsOf } = await import('../tools/walks.mjs');
  const h = headline({ engine: 'webxr', when: '2026-11-01T22:46:31.838Z', seconds: 487, stats: { walkedM: 276.9, losses: 0, resets: 0, fastTurns: 93 }, pins: [{ name: 'P2', anchored: true, checks: [{ offLevelM: 0.239, offAnchorLevelM: 0.1, walkedSinceM: 149.16 }] }, { name: 'P3', checks: [] }], measures: [{ shortBy: 0.04 }] });
  assert.match(h, /webxr 2026-11-01T22:46:31.838Z 8 min, walked 908 ft, losses 0, resets 0, fast turns 93/);
  assert.match(h, /P2\*:9 in\/4 in@149m P3:-/);
  assert.match(h, /tape: 4.0% short/);
  assert.deepEqual(rowsOf('Banner\n[{"results":[{"id":"a"}],"success":true}]\n'), [{ id: 'a' }]);
  assert.deepEqual(rowsOf('nothing'), []);
}
console.log('worker: ok');
