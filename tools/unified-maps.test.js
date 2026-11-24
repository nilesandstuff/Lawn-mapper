/**
 * ONE MAP, EVERY TOOL (owner, 2026-10-16), against real SQLite and the real
 * routes: a signed-out visitor is a guest with one map and a shared cookie,
 * each tool keeps its own part, the lawn mapper re-saving leaves those alone,
 * and signing in takes the guest's map along.
 *
 *   node tools/unified-maps.test.js
 */
import { testDb } from './d1.js';
import { handleMaps } from '../worker/src/routes-maps.js';
import { handleAuth } from '../worker/src/routes-auth.js';
import { findOrCreateUser, createSession } from '../worker/src/db.js';
import { SESSION_COOKIE, safeNext } from '../worker/src/auth.js';
import {
  GUEST_COOKIE, homeDomainOf, sharedCookie, adoptGuest, sweepGuests, toolsFor, TOOLS,
} from '../worker/src/unified.js';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); if (!ok) failures++; };
const json = (data, status) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const ctx = { waitUntil() {} };
const HOST = 'https://lawnmap.example.test';

const req = (path, { method = 'GET', body = null, cookie = '' } = {}) => new Request(`${HOST}${path}`, {
  method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const call = async (env, r) => {
  const res = await handleMaps(r, env, new URL(r.url), '', ctx, json);
  return { res, body: await res.json(), cookies: res.headers.getSetCookie?.() || [] };
};
const cookieFrom = (setCookies, name) => {
  const c = setCookies.find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : '';
};
const save = (over = {}) => ({ id: '1 elm st|sam3|find', address: '1 Elm St', lng: -85.1, lat: 42.1, squareFeet: 5000, ...over });

/* ------------------------------------------------------------- domains */
check('the shared domain is the home domain for every host under it',
  homeDomainOf('lawnmap.nilesandstuff.com') === 'nilesandstuff.com'
  && homeDomainOf('water.nilesandstuff.com') === 'nilesandstuff.com'
  && homeDomainOf('nilesandstuff.com') === 'nilesandstuff.com');
check('and none where a browser would refuse it',
  homeDomainOf('lawn-mapper.x.workers.dev') === null && homeDomainOf('localhost:8787') === null && homeDomainOf('127.0.0.1') === null);
check('the cookie carries Domain only when there is one',
  /Domain=example\.test/.test(sharedCookie('a', 'b', { maxAge: 1, host: 'lawnmap.example.test' }))
  && !/Domain/.test(sharedCookie('a', 'b', { maxAge: 1, host: 'localhost:8787' })));
check('safeNext lets a sign-in land on the home dashboard, and nowhere else',
  safeNext('home:/dashboard') === 'home:/dashboard' && safeNext('home://evil.example') === 'home:/');

/* ---------------------------------------------------------------- tools */
{
  const t = toolsFor('lawnmap.nilesandstuff.com');
  check('the tools open on the right hosts',
    t.find((x) => x.id === 'shade').url === 'https://shade.nilesandstuff.com/?map={id}'
    && toolsFor('lawn-mapper.example.workers.dev').find((x) => x.id === 'shade').url === 'https://lawn-mapper.example.workers.dev/shade?map={id}'
    && t.find((x) => x.id === 'water').url === 'https://water.nilesandstuff.com/?map={id}');
  check('the water map is listed for everyone (owner, 2026-10-23)',
    t.some((x) => x.id === 'water') && toolsFor('lawnmap.nilesandstuff.com', { admin: true }).some((x) => x.id === 'water'));
  check('the water map carries its experimental note',
    /highly experimental and early in development/i.test(t.find((x) => x.id === 'water').note || ''));
  check('the lawn sections tool opens on lawnmap and needs the lawn',
    t.find((x) => x.id === 'sections')?.url === 'https://lawnmap.nilesandstuff.com/sections?map={id}'
    && t.find((x) => x.id === 'sections').needs.join() === 'lawn');
  check('every tool a tool needs is a tool', TOOLS.every((x) => x.needs.every((n) => TOOLS.some((y) => y.id === n))));
}

/* ---------------------------------------------------------------- guest */
const env = { DB: testDb() };
let guestCookie;
{
  const first = await call(env, req('/api/maps'));
  check('signed out with nothing kept: an empty list, no guest made',
    first.body.maps.length === 0 && first.body.guest === false && !first.cookies.length);

  const saved = await call(env, req('/api/maps', { method: 'POST', body: save() }));
  guestCookie = cookieFrom(saved.cookies, GUEST_COOKIE);
  check('saving signed out makes this browser a guest, with a shared cookie',
    saved.body.saved === 1 && saved.body.guest === true && guestCookie
    && saved.cookies.some((c) => /Domain=example\.test/.test(c) && /HttpOnly/.test(c)), JSON.stringify(saved));

  const again = await call(env, req('/api/maps', { method: 'POST', body: save({ squareFeet: 5100 }), cookie: guestCookie }));
  check('re-saving the same map is fine', again.res.status === 200 && again.body.saved === 1);

  const second = await call(env, req('/api/maps', { method: 'POST', body: save({ id: '2 oak st|sam3|find', address: '2 Oak St' }), cookie: guestCookie }));
  check('a second map asks the guest to sign in', second.res.status === 409 && second.body.error === 'guest-limit', JSON.stringify(second.body));

  const other = await call(env, req('/api/maps/new', { method: 'POST', body: { address: '3 Pine', lng: 1, lat: 1, source: 'shade' }, cookie: guestCookie }));
  check('and so does a map started in another tool', other.res.status === 409);
}

/* ---------------------------------------------------- a tool's own part */
{
  const id = save().id;
  const put = await call(env, req(`/api/maps/tool?id=${encodeURIComponent(id)}&tool=shade`, {
    method: 'POST', body: { data: { erased: [1, 2, 3] }, basedOn: 'x' }, cookie: guestCookie,
  }));
  check('a tool writes its part', put.res.status === 200 && put.body.tool === 'shade', JSON.stringify(put.body));

  const bad = await call(env, req(`/api/maps/tool?id=${encodeURIComponent(id)}&tool=lawn`, { method: 'POST', body: { data: 1 }, cookie: guestCookie }));
  check('but not the lawn mapper\'s record, and not an unknown tool', bad.res.status === 400);

  const none = await call(env, req('/api/maps/tool?id=nope&tool=shade', { method: 'POST', body: { data: 1 }, cookie: guestCookie }));
  check('nor a map that is not there', none.res.status === 404);

  await call(env, req('/api/maps', { method: 'POST', body: save({ squareFeet: 5200, tools: { shade: 'clobber' } }), cookie: guestCookie }));
  const one = await call(env, req(`/api/maps/one?id=${encodeURIComponent(id)}`, { cookie: guestCookie }));
  check('the lawn mapper re-saving leaves the tool\'s part alone',
    one.body.map?.squareFeet === 5200 && one.body.map?.tools?.shade?.data?.erased?.length === 3, JSON.stringify(one.body));

  const list = await call(env, req('/api/maps', { cookie: guestCookie }));
  check('the list says which tools have run, without their data',
    list.body.maps[0].tools.shade?.updatedAt && list.body.maps[0].tools.shade.data === undefined);

  const stranger = await call(env, req(`/api/maps/one?id=${encodeURIComponent(id)}`));
  check('nobody else can open it', stranger.res.status === 404);
}

/* ------------------------------------------------- signing in adopts it */
{
  const user = await findOrCreateUser(env, { email: 'g@example.test', provider: 'email', subject: 'g' });
  const guestId = (await env.DB.prepare('SELECT id FROM guests').first()).id;
  const moved = await adoptGuest(env, guestId, user.id);
  const { token } = await createSession(env, user.id);
  const mine = await call(env, req(`/api/maps/one?id=${encodeURIComponent(save().id)}`, { cookie: `${SESSION_COOKIE}=${token}` }));
  check('signing in takes the guest\'s map and its tools along',
    moved === 1 && mine.body.map?.tools?.shade?.data?.erased?.length === 3 && mine.body.signedIn === true, JSON.stringify(mine.body));
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM guests').first();
  check('and the guest is gone', Number(left.n) === 0);

  const plain = await call(env, req('/api/tools', { cookie: `${SESSION_COOKIE}=${token}` }));
  check('an ordinary account is shown the water map',
    plain.res.status === 200 && plain.body.tools.some((x) => x.id === 'water'));
  const boss = await findOrCreateUser({ ...env, ADMIN_EMAILS: 'boss@example.test' }, { email: 'boss@example.test', provider: 'email', subject: 'boss' });
  const bossSession = await createSession(env, boss.id);
  const admin = await call(env, req('/api/tools', { cookie: `${SESSION_COOKIE}=${bossSession.token}` }));
  check('an admin is', admin.body.tools.some((x) => x.id === 'water'), JSON.stringify(admin.body));

  const many = await call(env, req('/api/maps/new', { method: 'POST', body: { address: '3 Pine', lng: 1, lat: 1, source: 'shade' }, cookie: `${SESSION_COOKIE}=${token}` }));
  check('an account keeps more than one', many.res.status === 200 && many.body.id);

  const me = await handleAuth(req('/api/auth/me', { cookie: `${SESSION_COOKIE}=${token}` }), env, new URL(`${HOST}/api/auth/me`), '', ctx, json);
  const set = me.headers.getSetCookie();
  check('an old host-only sign-in is handed back as the shared cookie',
    set.some((c) => c.startsWith(`${SESSION_COOKIE}=${token}`) && /Domain=example\.test/.test(c)), JSON.stringify(set));
}

/* ----------------------------------------- the finished lidar model (R2) */
{
  const store = new Map();
  const fakeR2 = {
    async put(k, body, opts) { store.set(k, { body: body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer(), ...opts }); },
    async get(k) { const o = store.get(k); return o ? { body: o.body, size: o.body.byteLength, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata } : null; },
    async head(k) { return store.has(k) ? {} : null; },
    async delete(k) { store.delete(k); },
    async list({ prefix }) { return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
  const env3 = { DB: testDb(), CORPUS: fakeR2 };
  const s = await call(env3, req('/api/maps', { method: 'POST', body: save() }));
  const gc = cookieFrom(s.cookies, GUEST_COOKIE), id = encodeURIComponent(save().id);
  const { encodeModel, packModel, unpackModel, isGzip } = await import('../public/lib/lidar-model.js');
  const grid = { w: 50, h: 40, x0: 0, y1: 0, cell: 1, lat: 42 };
  const mdl = { ground: new Float32Array(2000).fill(100), kind: new Uint8Array(2000), mu: new Float32Array(2000 * 30) };
  mdl.mu[777] = 0.4;
  const bytes = new Uint8Array(encodeModel({ tool: 'shade', grid, layers: { z0: 99, dz: 1, nz: 30 } }, mdl));
  const raw = (path, method, cookie, body) => handleMaps(new Request(`${HOST}${path}`, { method, headers: { Cookie: cookie }, ...(body ? { body } : {}) }), env3, new URL(`${HOST}${path}`), '', ctx, json);
  const missing = await raw(`/api/maps/model?id=${id}&tool=shade`, 'GET', gc);
  check('no model yet: 404', missing.status === 404 && (await missing.json()).error === 'no-model');
  const put = await raw(`/api/maps/model?id=${id}&tool=shade`, 'PUT', gc, bytes);
  const pj = await put.json();
  check('a raw model is kept, gzipped here and far smaller', put.status === 200 && pj.gzippedHere === true && pj.bytes * 10 < bytes.length, JSON.stringify(pj));
  const got = await raw(`/api/maps/model?id=${id}&tool=shade`, 'GET', gc);
  const gotBytes = await got.arrayBuffer();
  const back = await unpackModel(gotBytes);
  check('and it comes back gzip, private, and reads as the same model', got.status === 200 && isGzip(gotBytes) && back.arrays.mu[777] === mdl.mu[777] && back.meta.grid.w === 50 && /no-store/.test(got.headers.get('Cache-Control')));
  const packed = await packModel({ tool: 'shade', grid, layers: { z0: 99, dz: 1, nz: 30 } }, mdl);
  const put2 = await raw(`/api/maps/model?id=${id}&tool=shade`, 'PUT', gc, packed);
  const p2 = await put2.json();
  check('a packed model is kept as it came', put2.status === 200 && p2.gzippedHere === false && p2.bytes === packed.byteLength, JSON.stringify(p2));
  const junk = await raw(`/api/maps/model?id=${id}&tool=shade`, 'PUT', gc, new TextEncoder().encode('hello, not a model'));
  check('something that is not a model is refused', junk.status === 400);
  const { storedModelBytes } = await import('../worker/src/unified.js');
  const tooBig = await storedModelBytes(new Blob([bytes]).stream(), { maxIn: 1000 });
  check('an upload over the limit is refused while it streams', tooBig.error === 'too-big', tooBig.error || 'kept');
  const chunked = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 4096) c.enqueue(bytes.subarray(i, i + 4096)); c.close(); } });
  const tooBig2 = await storedModelBytes(chunked, { maxIn: 50000 });
  check('and so is one that arrives in many pieces', tooBig2.error === 'too-big', tooBig2.error || 'kept');
  const stranger = await raw(`/api/maps/model?id=${id}&tool=shade`, 'GET', '');
  check('a stranger gets nothing', stranger.status === 404);
  const badTool = await raw(`/api/maps/model?id=${id}&tool=lawn`, 'PUT', gc, bytes);
  check('only a tool may write one', badTool.status === 400);
  const noMap = await raw(`/api/maps/model?id=nope&tool=shade`, 'PUT', gc, bytes);
  check('and only for a map the owner has', noMap.status === 404);
  // OVERFLOW PARTS (the owner, 2026-11-16: an overflow file rather than data left out): &part=1..8, each a model file
  // of its own beside the main one, checked the same way; no part is the main file, as before
  const pPut = await raw(`/api/maps/model?id=${id}&tool=shade&part=2`, 'PUT', gc, packed);
  const pj2 = await pPut.json();
  check('a part is kept beside the main file', pPut.status === 200 && pj2.part === 2 && [...store.keys()].some((k) => k.endsWith('/shade.2.bin')), JSON.stringify(pj2));
  const pGot = await raw(`/api/maps/model?id=${id}&tool=shade&part=2`, 'GET', gc);
  const mGot = await raw(`/api/maps/model?id=${id}&tool=shade`, 'GET', gc);
  check('read back by its number, the main file untouched', pGot.status === 200 && new Uint8Array(await pGot.arrayBuffer()).byteLength === packed.byteLength && mGot.status === 200);
  check('a part not written is 404', (await raw(`/api/maps/model?id=${id}&tool=shade&part=3`, 'GET', gc)).status === 404);
  // A SECOND FILE BESIDE THE MODEL (2026-11-23: the lidar's shapes refined by a walk, never written over the lidar's)
  {
    const before = new Uint8Array(await (await raw(`/api/maps/model?id=${id}&tool=shade`, 'GET', gc)).arrayBuffer());
    check('no fused file until one is written', (await raw(`/api/maps/model?id=${id}&tool=shade&file=fused`, 'GET', gc)).status === 404);
    const fPut = await raw(`/api/maps/model?id=${id}&tool=shade&file=fused`, 'PUT', gc, bytes);
    const fj = await fPut.json();
    check('the fused file is kept and says which it is', fPut.status === 200 && fj.file === 'fused' && fj.tool === 'shade', JSON.stringify(fj));
    const fGot = await raw(`/api/maps/model?id=${id}&tool=shade&file=fused`, 'GET', gc);
    check('the fused file reads back', fGot.status === 200 && (await fGot.arrayBuffer()).byteLength > 0);
    const after = new Uint8Array(await (await raw(`/api/maps/model?id=${id}&tool=shade`, 'GET', gc)).arrayBuffer());
    check('writing the fused file leaves the lidar\'s own file as it was', after.length === before.length && after.every((v, i) => v === before[i]));
    check('a fused overflow part is its own object', (await raw(`/api/maps/model?id=${id}&tool=shade&file=fused&part=1`, 'PUT', gc, packed)).status === 200 && (await raw(`/api/maps/model?id=${id}&tool=shade&file=fused&part=1`, 'GET', gc)).status === 200 && (await raw(`/api/maps/model?id=${id}&tool=shade&part=1`, 'GET', gc)).status !== 200);
    // what it was made from comes back on HEAD, so a second writer can skip a write that would change nothing
    const mf = '2026-11-23T10:00:00.000Z|2026-11-23T11:00:00.000Z|1';
    const mPut = await handleMaps(new Request(`${HOST}/api/maps/model?id=${id}&tool=shade&file=fused`, { method: 'PUT', headers: { Cookie: gc, 'X-Model-Made-From': mf }, body: bytes }), env3, new URL(`${HOST}/api/maps/model?id=${id}&tool=shade&file=fused`), '', ctx, json);
    const mHead = await raw(`/api/maps/model?id=${id}&tool=shade&file=fused`, 'HEAD', gc);
    check('what the fused file was made from is kept and read back without the file', mPut.status === 200 && mHead.status === 200 && mHead.headers.get('X-Model-Made-From') === mf, mHead.headers.get('X-Model-Made-From'));
    check('a file of any other name is refused', (await raw(`/api/maps/model?id=${id}&tool=shade&file=other`, 'GET', gc)).status === 400 && (await raw(`/api/maps/model?id=${id}&tool=shade&file=other`, 'PUT', gc, bytes)).status === 400);
  }
  const badParts = [];
  for (const v of [65, '01', 'x', '-1']) badParts.push((await raw(`/api/maps/model?id=${id}&tool=shade&part=${v}`, 'GET', gc)).status);
  check('part 65, 01, a word or -1 is refused', badParts.every((st) => st === 400) && (await raw(`/api/maps/model?id=${id}&tool=shade&part=65`, 'PUT', gc, packed)).status === 400, badParts.join(','));
  const { modelPart } = await import('../worker/src/unified.js');
  check('64 parts at most; { part } as the shade builder passes it', modelPart('64') === 64 && modelPart({ part: 37 }) === 37 && modelPart({}) === 0 && modelPart(0) === 0);
  check('a part that is not a model is refused', (await raw(`/api/maps/model?id=${id}&tool=shade&part=1`, 'PUT', gc, new TextEncoder().encode('nope'))).status === 400);
  const gone = await call(env3, req(`/api/maps?id=${id}`, { method: 'DELETE', cookie: gc }));
  check('deleting the map deletes its model, parts and all', gone.res.status === 200 && store.size === 0);
  const noBucket = await handleMaps(new Request(`${HOST}/api/maps/model?id=${id}&tool=shade`, { method: 'PUT', headers: { Cookie: gc }, body: bytes }), { DB: env3.DB }, new URL(`${HOST}/api/maps/model?id=${id}&tool=shade`), "", ctx, json);
  check("without a bucket the site says so", noBucket.status === 503 || noBucket.status === 404, `${noBucket.status} ${await noBucket.text()}`);
}

/* ------------------------- the photo a map was traced on, kept with it */
{
  const store = new Map();
  const r2 = {
    async put(k, body, opts) { store.set(k, { body: body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer()), ...opts }); },
    async get(k) { const o = store.get(k); return o ? { body: o.body, size: o.body.byteLength, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata } : null; },
    async head(k) { const o = store.get(k); return o ? { customMetadata: o.customMetadata } : null; },
    async delete(k) { store.delete(k); },
    async list({ prefix }) { return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
  const env4 = { DB: testDb(), CORPUS: r2, MAPBOX_SERVER_TOKEN: 'test-token' };
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async (u) => { fetched++; return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } }); };
  const pending = [];
  const ctx4 = { waitUntil(p) { pending.push(p); } };
  const go = (path, method = 'GET', cookie = '', body = null) => handleMaps(new Request(`${HOST}${path}`, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env4, new URL(`${HOST}${path}`), '', ctx4, json);
  const frame = { lng: -85.1, lat: 42.1, zoom: 19.5, size: 640, height: 640 };
  const first = await go('/api/maps', 'POST', '', save({ frame, provider: 'mapbox' }));
  const gc = cookieFrom(first.headers.getSetCookie?.() || [], GUEST_COOKIE), id = encodeURIComponent(save().id);
  await Promise.all(pending.splice(0));
  check('saving a map keeps the photo it was traced on', fetched === 1 && [...store.keys()].some((k) => k.endsWith('/photo.bin')), `fetched ${fetched}`);
  const got = await go(`/api/maps/photo?id=${id}`, 'GET', gc);
  const fr = JSON.parse(got.headers.get('X-Photo-Frame') || 'null');
  check('and serves it with its frame and source, without fetching again',
    got.status === 200 && fr && Number.isFinite(fr.zoom) && got.headers.get('X-Photo-Source') === 'mapbox' && fetched === 1, `${got.status} ${fetched}`);
  await go('/api/maps', 'POST', gc, save({ frame, provider: 'mapbox', squareFeet: 5100 }));
  await Promise.all(pending.splice(0));
  check('re-saving on the same photo takes nothing new', fetched === 1, `fetched ${fetched}`);
  await go('/api/maps', 'POST', gc, save({ frame, provider: 'county', countySvc: 'no-such-service', countyAlign: { east: 0.4, north: -0.2, scale: 1.001 } }));
  await Promise.all(pending.splice(0));
  const wrong = await go(`/api/maps/photo?id=${id}`, 'GET', gc);
  check('saved on a photo that cannot be had: an error, never the old photo in its place', wrong.status === 502, `${wrong.status}`);
  const stranger = await go(`/api/maps/photo?id=${id}`, 'GET', '');
  check("a stranger gets no one's photo", stranger.status === 404);
  globalThis.fetch = realFetch;
}

/* ------------------------------------- a walk follows the place, not the record */
{
  const envW = { DB: testDb() };
  const user = await findOrCreateUser(envW, { email: 'w@example.test', provider: 'email', subject: 'w' });
  const { token } = await createSession(envW, user.id);
  const c = `${SESSION_COOKIE}=${token}`;
  const one = async (id) => (await call(envW, req(`/api/maps/one?id=${encodeURIComponent(id)}`, { cookie: c }))).body.map;
  // three maps of one lot (one a few metres off, as two geocodes of one address are) and one across town
  await call(envW, req('/api/maps', { method: 'POST', cookie: c, body: save({ id: 'walked', lng: -85.1, lat: 42.1 }) }));
  await call(envW, req('/api/maps', { method: 'POST', cookie: c, body: save({ id: 'same lot', lng: -85.10004, lat: 42.10002 }) }));
  await call(envW, req('/api/maps', { method: 'POST', cookie: c, body: save({ id: 'across town', lng: -85.2, lat: 42.2 }) }));
  const plants = { v: 1, cellM: 0.3048, boxes: [[1, 2, 0, 15]], walk: 'w1', at: '2026-11-23T21:37:00.000Z' };
  await call(envW, req('/api/maps/tool?id=walked&tool=scan', { method: 'POST', cookie: c, body: { data: { things: [1], plants } } }));
  const own = await one('walked'), lot = await one('same lot'), far = await one('across town');
  check("the walk's own map reads its plants as they are", own.tools.scan.data.plants.at === plants.at && !own.tools.scan.data.plants.borrowed && !own.tools.scan.data.plants.origin);
  const lent = lot.tools.scan?.data?.plants;
  check('another map of the same lot reads the same walk, marked borrowed, with the point it is measured from',
    lent?.at === plants.at && lent.borrowed === true && lent.boxes.length === 1 && lent.origin?.[0] === -85.1 && lent.origin?.[1] === 42.1 && lot.tools.scan.borrowed === true,
    JSON.stringify(lot.tools.scan || null).slice(0, 200));
  check('only the plants are lent, not the things placed on the other map', lot.tools.scan.data.things === undefined);
  check('a map across town reads none', !far.tools.scan);
  // a tool posting the borrowed part back does not make it the map's own
  await call(envW, req('/api/maps/tool?id=same%20lot&tool=scan', { method: 'POST', cookie: c, body: { data: { things: [7], plants: lent } } }));
  const kept = await envW.DB.prepare(`SELECT data FROM map_tools WHERE map_key = 'same lot' AND tool = 'scan'`).first();
  check('a borrowed walk posted back is not kept in the record', JSON.parse(kept.data).plants === undefined && JSON.parse(kept.data).things[0] === 7, kept.data.slice(0, 120));
  const again = await one('same lot');
  check('and the map still reads the walk, beside its own things', again.tools.scan.data.plants?.borrowed === true && again.tools.scan.data.things[0] === 7 && !again.tools.scan.borrowed);
  // a newer walk on the first map shows through at once
  await call(envW, req('/api/maps/tool?id=walked&tool=scan', { method: 'POST', cookie: c, body: { data: { plants: { ...plants, at: '2026-11-25T10:00:00.000Z' } } } }));
  check('a newer walk shows through at once', (await one('same lot')).tools.scan.data.plants.at === '2026-11-25T10:00:00.000Z');
  // another account's walk on the same lot is nobody else's
  const other = await findOrCreateUser(envW, { email: 'x@example.test', provider: 'email', subject: 'x' });
  const c2 = `${SESSION_COOKIE}=${(await createSession(envW, other.id)).token}`;
  await call(envW, req('/api/maps', { method: 'POST', cookie: c2, body: save({ id: 'theirs', lng: -85.1, lat: 42.1 }) }));
  const theirs = (await call(envW, req('/api/maps/one?id=theirs', { cookie: c2 }))).body.map;
  check("another account's map of the lot reads no walk", !theirs.tools.scan);
}

/* -------------------------------------------------------- idle guests go */
{
  const env2 = { DB: testDb() };
  const s = await call(env2, req('/api/maps', { method: 'POST', body: save() }));
  check('a guest is made', s.body.saved === 1);
  await env2.DB.prepare(`UPDATE guests SET seen_at = '2000-01-01T00:00:00.000Z'`).run();
  await sweepGuests(env2);
  const n = await env2.DB.prepare('SELECT (SELECT COUNT(*) FROM guests) + (SELECT COUNT(*) FROM guest_maps) AS n').first();
  check('a guest unseen for 90 days goes with its map', Number(n.n) === 0);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
