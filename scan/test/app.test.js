// scan/src/app.js: the Android app's routes (pairing, version, download). node scan/test/app.test.js
import assert from 'node:assert/strict';
import { app, cookieOf, code, intentFor, pairCookie, apkName, APP_PACKAGE, PAIR_MS } from '../src/app.js';
import { engineChoice, depthFromGrid } from '../lib/track.js';

// cookies and codes
const req = (path, cookie = '') => new Request(`https://scan.example.com${path}`, { headers: cookie ? { Cookie: cookie } : {} });
assert.equal(cookieOf(req('/', 'a=1; lm_session=abc123; b=2'), 'lm_session'), 'abc123');
assert.equal(cookieOf(req('/', 'a=1'), 'lm_session'), null);
assert.match(code(), /^[0-9a-f]{48}$/);
assert.ok(intentFor('ab').startsWith('intent://signin?t=ab#Intent;scheme=lawnar;') && intentFor('ab').includes(`package=${APP_PACKAGE}`));
assert.ok(pairCookie('s').includes('HttpOnly') && pairCookie('s').includes('Secure') && !pairCookie('s', false).includes('Secure'));

// a D1 stand-in: one table, the three statements app.js uses
function fakeDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return { bind(...a) { return {
        run: async () => {
          if (sql.startsWith('INSERT')) rows.set(a[0], { session: a[1], expires: a[2] });
          else if (sql.includes('expires <')) { for (const [k, v] of rows) if (v.expires < a[0]) rows.delete(k); }
          else if (sql.startsWith('DELETE')) rows.delete(a[0]);
          return {};
        },
        first: async () => rows.get(a[0]) || null,
      }; } };
    },
  };
}
const env = { DB: fakeDb(), TWIN: { get: async (k) => (k === 'app/version.json' ? { json: async () => ({ code: 7, name: '7', bridge: 1 }) } : k === 'app/lawn-ar.apk' ? { body: 'APK' } : null) } };
const call = (path, cookie) => app(req(path, cookie), env, new URL(`https://scan.example.com${path}`));

assert.equal(await call('/api/other'), null, 'not an app route');
assert.deepEqual(await (await call('/api/app/version')).json(), { code: 7, name: '7', bridge: 1 });
const apk = await call('/api/app/apk');
assert.equal(apk.headers.get('Content-Type'), 'application/vnd.android.package-archive');
assert.match(apk.headers.get('Content-Disposition'), /filename="yard-ar-7\.apk"/, 'named for its version');
assert.equal(apkName({ name: '1.6' }), 'yard-ar-1.6.apk'); assert.equal(apkName(null), 'yard-ar.apk'); assert.equal(apkName({ name: '../x' }), 'yard-ar.apk');

// pairing: Chrome (signed in) -> intent link with a code; the app claims it once and gets the same session
assert.equal((await call('/api/app/pair')).status, 401, 'not signed in');
const pr = await call('/api/app/pair', 'lm_session=SESSION42');
assert.equal(pr.status, 302);
const t = new URL(pr.headers.get('Location').replace('intent://', 'https://x/')).searchParams.get('t');
assert.match(t, /^[0-9a-f]{48}$/);
const cl = await call(`/api/app/claim?t=${t}`);
assert.equal(cl.status, 302);
assert.ok(cl.headers.get('Set-Cookie').startsWith('lm_session=SESSION42;'), 'the same session');
assert.equal((await call(`/api/app/claim?t=${t}`)).status, 410, 'once only');
assert.equal((await call('/api/app/claim?t=nothex')).status, 400);
// an expired code
const pr2 = await call('/api/app/pair', 'lm_session=S2');
const t2 = new URL(pr2.headers.get('Location').replace('intent://', 'https://x/')).searchParams.get('t');
env.DB.rows.get(t2).expires = Date.now() - 1;
assert.equal((await call(`/api/app/claim?t=${t2}`)).status, 410, 'expired');
assert.ok(PAIR_MS <= 10 * 60 * 1000);

// the page: inside the app the native engine is offered first; the depth grid reads as the page's depth
assert.deepEqual(engineChoice({ hasNative: true, hasXR: true }).offered, ['native', 'webxr']);
assert.equal(engineChoice({ hasNative: true, hasXR: true }).start, 'native');
assert.deepEqual(engineChoice({ hasXR: true }).offered, ['webxr']);
const g = depthFromGrid({ kind: 'raw', nx: 2, ny: 2, p: [1, 2, 3, null, null, null, 4, 5, 6, 7, 8, 9], d: [2, 0, 9, 0.2], c: [200, 0, 200, 200] });
assert.deepEqual(g.at(0.1, 0.1), { x: 1, y: 2, z: 3 });
assert.equal(g.at(0.9, 0.1), null, 'a hole');
assert.equal(g.at(0.1, 0.9), null, 'past 8 m');
assert.equal(g.at(0.9, 0.9), null, 'nearer than 0.4 m');
assert.equal(g.m(0.9, 0.1), 0);
// the app's walks are kept like the browser's (walks.js once refused engine 'native': the owner's first two app walks)
const { cleanWalk } = await import('../src/walks.js');
assert.ok(cleanWalk({ id: '1', engine: 'native', geo: { n: 3, hacc: 1.2, yawAcc: 2 }, app: { app: '1.5', bridge: 1 } }).row, 'a native walk, with its Geospatial counts, is kept');
console.log('app: ok');
