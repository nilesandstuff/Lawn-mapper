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
    t.find((x) => x.id === 'shade').url === 'https://lawnmap.nilesandstuff.com/shade?map={id}'
    && t.find((x) => x.id === 'water').url === 'https://water.nilesandstuff.com/?map={id}');
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

  const many = await call(env, req('/api/maps/new', { method: 'POST', body: { address: '3 Pine', lng: 1, lat: 1, source: 'shade' }, cookie: `${SESSION_COOKIE}=${token}` }));
  check('an account keeps more than one', many.res.status === 200 && many.body.id);

  const me = await handleAuth(req('/api/auth/me', { cookie: `${SESSION_COOKIE}=${token}` }), env, new URL(`${HOST}/api/auth/me`), '', ctx, json);
  const set = me.headers.getSetCookie();
  check('an old host-only sign-in is handed back as the shared cookie',
    set.some((c) => c.startsWith(`${SESSION_COOKIE}=${token}`) && /Domain=example\.test/.test(c)), JSON.stringify(set));
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
