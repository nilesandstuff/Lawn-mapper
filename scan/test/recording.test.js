// A walk's ARCore recording (src/recording.js): sent in pieces into the private bucket, fetched back whole, listed;
// the admin only.
import assert from 'node:assert/strict';
import { isAdmin } from '../src/index.js';
import { recording, PIECE, keyOf } from '../src/recording.js';

const objs = new Map(), uploads = new Map();
const R2 = {
  list: async ({ prefix }) => ({ objects: [...objs.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.byteLength, uploaded: '2026-11-08T00:00:00Z' })), truncated: false }),
  get: async (k) => (objs.has(k) ? { body: objs.get(k), size: objs.get(k).byteLength } : null),
  createMultipartUpload: async (key) => { const id = `u${uploads.size + 1}`; uploads.set(id, { key, parts: new Map() }); return { uploadId: id }; },
  resumeMultipartUpload: (key, id) => ({
    uploadPart: async (n, body) => { uploads.get(id).parts.set(n, new Uint8Array(body)); return { etag: `e${n}` }; },
    complete: async (parts) => { const u = uploads.get(id); const bufs = parts.map((p) => { assert.equal(p.etag, `e${p.partNumber}`); return u.parts.get(p.partNumber); }); const all = new Uint8Array(bufs.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of bufs) { all.set(b, o); o += b.length; } objs.set(key, all); return { size: all.length }; },
  }),
};
const lawnmap = (who) => ({ fetch: async () => new Response(JSON.stringify({ user: { admin: who === 'admin' } }), { headers: { 'Content-Type': 'application/json' } }) });
const env = (who) => ({ LAWNMAP_HOST: 'lawnmap.example.com', LAWNMAP: lawnmap(who), TWIN: R2 });
const call = (e, method, path, body) => recording(new Request(`https://scan.example.com${path}`, { method, headers: { Cookie: 'lm_session=x' }, body }), e, new URL(`https://scan.example.com${path}`), { isAdmin });

assert.equal(await call(env('admin'), 'GET', '/api/scan/twins'), null, 'not its route');
assert.equal((await call(env('user'), 'GET', '/api/scan/recordings')).status, 404, 'not the admin: nothing');
assert.equal((await call(env('admin'), 'POST', '/api/scan/recording/start?walk=../x')).status, 400, 'a walk named strictly');
const { upload, piece } = await (await call(env('admin'), 'POST', '/api/scan/recording/start?walk=w1')).json();
assert.equal(piece, PIECE);
const a = new Uint8Array(PIECE).fill(1), b = new Uint8Array(1000).fill(2);
const p1 = await (await call(env('admin'), 'PUT', `/api/scan/recording/part?walk=w1&upload=${upload}&n=1`, a)).json();
const p2 = await (await call(env('admin'), 'PUT', `/api/scan/recording/part?walk=w1&upload=${upload}&n=2`, b)).json();
assert.equal((await call(env('admin'), 'PUT', `/api/scan/recording/part?walk=w1&upload=${upload}&n=3`, new Uint8Array(PIECE + 1))).status, 413, 'a piece too big');
const done = await (await call(env('admin'), 'POST', `/api/scan/recording/done?walk=w1&upload=${upload}`, JSON.stringify({ parts: [{ n: p2.n, etag: p2.etag }, { n: p1.n, etag: p1.etag }] }))).json();
assert.equal(done.bytes, PIECE + 1000, 'the pieces in order, whole');
assert.ok(objs.has(keyOf('w1')), 'beside the twin');
const got = await call(env('admin'), 'GET', '/api/scan/recording?walk=w1');
assert.equal(got.headers.get('Content-Type'), 'video/mp4');
assert.equal((await got.arrayBuffer()).byteLength, PIECE + 1000);
assert.deepEqual((await (await call(env('admin'), 'GET', '/api/scan/recordings')).json()).recordings.map((r) => r.walk), ['w1']);
assert.equal((await call(env('admin'), 'GET', '/api/scan/recording?walk=w2')).status, 404);
console.log('recording: ok');
