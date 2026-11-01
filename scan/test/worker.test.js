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
console.log('worker: ok');
