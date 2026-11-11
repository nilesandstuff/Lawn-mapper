/**
 * ADMIN SAVES (worker/src/admin-saves.js; owner, 2026-11-11), against real SQLite and the real routes. The owner's
 * condition comes first: "this shouldn't change anything about the functionality of the site for regular users".
 *
 *   node tools/admin-saves.test.js
 */
import { PNG } from 'pngjs';
import { testDb } from './d1.js';
import { handleMaps } from '../worker/src/routes-maps.js';
import { handleAdmin } from '../worker/src/routes-admin.js';
import { findOrCreateUser, createSession } from '../worker/src/db.js';
import { SESSION_COOKIE } from '../worker/src/auth.js';
import { finishTraces, INDEX_KEY, stillWaitingWhy } from '../worker/src/admin-saves.js';
import worker from '../worker/src/index.js';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); if (!ok) failures++; };
const json = (data, status) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const ctx = { waitUntil(p) { (ctx.all ||= []).push(p); } };
const settle = async () => { await Promise.allSettled(ctx.all || []); ctx.all = []; };
const HOST = 'https://lawnmap.example.test';
const req = (path, { method = 'GET', body = null, cookie = '' } = {}) => new Request(`${HOST}${path}`, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
const maps = async (env, r) => { const res = await handleMaps(r, env, new URL(r.url), '', ctx, json); return { status: res.status, body: await res.json() }; };
const admin = async (env, r) => { const res = await handleAdmin(r, env, new URL(r.url), '', ctx, json); return { status: res.status, body: await res.json().catch(() => null) }; };
const bucket = () => { const m = new Map(); return { m, async get(k) { const v = m.get(k); return v == null ? null : { body: v, async json() { return JSON.parse(typeof v === 'string' ? v : Buffer.from(v).toString('utf8')); }, async arrayBuffer() { return v.buffer; } }; }, async put(k, v) { m.set(k, typeof v === 'string' ? v : new Uint8Array(v)); }, async head(k) { return m.has(k) ? {} : null; }, async delete(k) { m.delete(k); } }; };
const save = (over = {}) => ({ id: '1 elm st|alpha|find', address: '1 Elm St', lng: -85.1, lat: 42.1, squareFeet: 5000, shapes: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-85.1, 42.1], [-85.0999, 42.1], [-85.0999, 42.1001], [-85.1, 42.1]]] } }], ...over });

const env = { DB: testDb(), ADMIN_EMAILS: 'owner@b.com', CORPUS: bucket(), ALPHA_URL: 'https://model.example.test/start', ALPHA_TOKEN: 't', MAPBOX_TOKEN: 'pk.test' };
const owner = await findOrCreateUser(env, { email: 'owner@b.com', provider: 'email', subject: 'o' });
const person = await findOrCreateUser(env, { email: 'person@b.com', provider: 'email', subject: 'p' });
const oc = `${SESSION_COOKIE}=${(await createSession(env, owner.id)).token}`, pc = `${SESSION_COOKIE}=${(await createSession(env, person.id)).token}`;

/* ------------------------------------------------ a regular user: nothing changed */
{
  await maps(env, req('/api/maps', { method: 'POST', cookie: pc, body: save() }));
  // a regular user who SENDS the flag gets no admin save: the list they see is their whole list
  await maps(env, req('/api/maps', { method: 'POST', cookie: pc, body: save({ id: '2 oak st|alpha|find', address: '2 Oak St', adminSave: true }) }));
  const list = await maps(env, req('/api/maps', { cookie: pc }));
  check('a regular user keeps fifty maps, as before', list.body.max === 50, `${list.body.max}`);
  check('their first map is listed as before', list.body.maps.some((m) => m.address === '1 Elm St'));
  check('and a flag they sent themselves hides nothing from them', list.body.maps.length === 2 && list.body.maps.some((m) => m.address === '2 Oak St'));
  const none = await admin(env, req('/api/admin/admin-saves', { cookie: pc }));
  check('the admin saves are a 404 to them', none.status === 404, `${none.status}`);
  const tr = await admin(env, req('/api/admin/admin-saves/trace', { method: 'POST', cookie: pc, body: { map: save(), segment: { lng: -85.1, lat: 42.1 } } }));
  check('and so is the save-and-trace', tr.status === 404, `${tr.status}`);
  const out = await admin(env, req('/api/admin/admin-saves/trace', { method: 'POST', body: { map: save(), segment: { lng: -85.1, lat: 42.1 } } }));
  check('and to somebody signed out', out.status === 404, `${out.status}`);
  const rows = await env.DB.prepare('SELECT COUNT(*) n FROM admin_traces').first();
  check('nothing was started for them', rows.n === 0);
}

/* ------------------------------------------------ the administrator: save and trace */
const realFetch = globalThis.fetch;
let modelState = 'running', started = 0;
globalThis.fetch = async (u, init) => {
  const s = String(u);
  if (s === 'https://model.example.test/start' && init?.method === 'POST') { started++; return json({ id: `call-${started}` }, 200); }
  if (s.startsWith('https://model.example.test')) return json(modelState === 'running' ? { status: 'running', stage: 'reading the lot' } : { status: 'failed', error: 'x' }, 200);
  return realFetch(u, init);
};
{
  await maps(env, req('/api/maps', { method: 'POST', cookie: oc, body: save({ id: 'own home|alpha|find', address: 'Own Home' }) }));
  const tr = await admin(env, req('/api/admin/admin-saves/trace', { method: 'POST', cookie: oc, body: { map: save({ id: '9 test rd|alpha|find', address: '9 Test Rd', shapes: [], squareFeet: 0 }), segment: { lng: -85.1, lat: 42.1, zoom: 19, size: 640, height: 640, provider: 'mapbox' } } }));
  await settle();
  check('the save-and-trace answers with the map and a pending trace', tr.status === 200 && tr.body.id === '9 test rd|alpha|find' && tr.body.trace === 'pending', JSON.stringify(tr.body));
  check('the trained model was started once', started === 1);
  const normal = await maps(env, req('/api/maps', { cookie: oc })), adm = await maps(env, req('/api/maps?admin=1', { cookie: oc }));
  check('the admin save is not in the ordinary list', normal.body.maps.length === 1 && normal.body.maps[0].address === 'Own Home', normal.body.maps.map((m) => m.address).join());
  check('and is the only one in the admin list', adm.body.maps.length === 1 && adm.body.maps[0].address === '9 Test Rd');
  const list = await admin(env, req('/api/admin/admin-saves', { cookie: oc }));
  check('the admin saves page lists it, trace pending', list.body.maps.length === 1 && list.body.maps[0].trace?.status === 'pending', JSON.stringify(list.body.maps[0]?.trace));
  const one = await maps(env, req(`/api/maps/one?id=${encodeURIComponent('9 test rd|alpha|find')}`, { cookie: oc }));
  check('every tool can open it like any map', one.status === 200 && one.body.map?.address === '9 Test Rd');

  // the page is closed; the timer runs while the model is still working: nothing changes
  check('a press still running is left waiting', await finishTraces(env) === 0);
  // the model finishes: its mask (a 200 x 200 lawn square in a 640 frame) and answer are kept, as pollAlpha keeps them
  const png = new PNG({ width: 640, height: 640 });
  for (let y = 0; y < 640; y++) for (let x = 0; x < 640; x++) { const on = x >= 220 && x < 420 && y >= 220 && y < 420 ? 255 : 0, k = (y * 640 + x) * 4; png.data[k] = png.data[k + 1] = png.data[k + 2] = on; png.data[k + 3] = 255; }
  await env.CORPUS.put('alpha/masks/call-1.png', PNG.sync.write(png));
  await env.CORPUS.put('alpha/masks/call-1.json', JSON.stringify({ status: 'succeeded', mask: 'x', version: 'beta 7', uncertainty: 0.1, seconds: 12 }));
  const fin = await finishTraces(env);
  check('the timer finishes it with nobody there', fin === 1, JSON.stringify((await env.DB.prepare('SELECT status, detail FROM admin_traces').all()).results));
  const done = (await maps(env, req(`/api/maps/one?id=${encodeURIComponent('9 test rd|alpha|find')}`, { cookie: oc }))).body.map;
  check('the lawn is in the map', done.shapes.length === 1 && done.shapes[0].geometry.type === 'Polygon' && done.squareFeet > 500, `${done.shapes.length} shapes, ${done.squareFeet} sq ft`);
  check('still an admin save, its trace done', done.adminSave === true && done.trace?.status === 'done');
  const c = done.shapes[0].geometry.coordinates[0], xs = c.map((p) => p[0]), ys = c.map((p) => p[1]), mid = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  check('the lawn sits at the frame\'s middle', Math.abs(mid[0] + 85.1) < 2e-5 && Math.abs(mid[1] - 42.1) < 2e-5, mid.join());
  check('the timer has nothing more to do', await finishTraces(env) === 0);
  // no builder bound: the row waits for its lidar, and the list says so
  let l = (await admin(env, req('/api/admin/admin-saves', { cookie: oc }))).body.maps[0].lidar;
  check('traced, its lidar is waiting', l?.status === 'waiting', JSON.stringify(l));
  // the builder bound (a stand-in): one build, claimed once, its answer on the row and the model stored
  let builds = 0;
  const benv = { ...env, SHADE_BUILDER: { async fetch() { builds++; return json({ ok: true, seconds: 12, result: { build: 7 }, part: { data: { lidar: 'kept' }, basedOn: null }, model: Buffer.from('not a real model').toString('base64') }, 200); } } };
  await finishTraces(benv); await finishTraces(benv);
  l = (await admin(env, req('/api/admin/admin-saves', { cookie: oc }))).body.maps[0].lidar;
  check('the builder is called once for it', builds === 1, `${builds}`);
  check('and the list says what happened', l && (l.status === 'done' || l.status === 'failed') && !!l.detail, JSON.stringify(l));
  const atAfter = (await maps(env, req(`/api/maps/one?id=${encodeURIComponent('9 test rd|alpha|find')}`, { cookie: oc }))).body.map.at;
  check('the map\'s record is not written again by the build', atAfter === done.at, `${done.at} -> ${atAfter}`);

  // edited in the Lawn Mapper: the page's record has no flag, and it stays an admin save
  await maps(env, req('/api/maps', { method: 'POST', cookie: oc, body: save({ id: '9 test rd|alpha|find', address: '9 Test Rd', handEdited: true }) }));
  const after = await maps(env, req('/api/maps', { cookie: oc })), afterAdm = await maps(env, req('/api/maps?admin=1', { cookie: oc }));
  check('an admin save edited in the Lawn Mapper stays one', after.body.maps.length === 1 && afterAdm.body.maps.length === 1 && afterAdm.body.maps[0].handEdited === true);

  // for the other sessions: the index in the private bucket, and the key route
  const idx = JSON.parse(Buffer.from(env.CORPUS.m.get(INDEX_KEY)).toString('utf8'));
  check('the bucket\'s index lists it with its address', idx.maps.length === 1 && idx.maps[0].address === '9 Test Rd' && idx.maps[0].id === '9 test rd|alpha|find');
  const keyed = await admin({ ...env, MAPS_READ_TOKEN: 'k' }, new Request(`${HOST}/api/admin/saved-maps`, { headers: { Authorization: 'Bearer k' } }));
  check('the key route marks it', keyed.body.maps.find((m) => m.address === '9 Test Rd')?.adminSave === true && keyed.body.maps.find((m) => m.address === 'Own Home')?.adminSave === false);
  check('an administrator keeps more than fifty', (await maps(env, req('/api/maps', { cookie: oc }))).body.max === 500);
}
/* a press that fails says so in the map, and the map stays */
{
  modelState = 'failed';
  const tr = await admin(env, req('/api/admin/admin-saves/trace', { method: 'POST', cookie: oc, body: { map: save({ id: '3 fail ln|alpha|find', address: '3 Fail Ln', shapes: [] }), segment: { lng: -85.2, lat: 42.2 } } }));
  await settle();
  await finishTraces(env);
  const m = (await maps(env, req(`/api/maps/one?id=${encodeURIComponent(tr.body.id)}`, { cookie: oc }))).body.map;
  check('a failed trace leaves the map, saying so', m?.adminSave === true && m.trace?.status === 'failed', JSON.stringify(m?.trace));
}
check('a press given up on blames the GPU provider when it had none free', /no GPU free/.test(stillWaitingWhy('Waiting for a GPU to come free -- the GPU provider is busy right now (29:40)'))
  && stillWaitingWhy('Fetching the aerial photograph') === 'no answer in half an hour' && stillWaitingWhy(null) === 'no answer in half an hour');
check('the Worker has its timer', typeof worker.scheduled === 'function' && typeof worker.fetch === 'function');
globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILED` : '\nadmin-saves: ok');
process.exit(failures ? 1 : 0);
