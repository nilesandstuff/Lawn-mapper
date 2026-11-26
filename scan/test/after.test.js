import assert from 'node:assert/strict';
import { afterWalks } from '../src/after.js';

// a bucket in memory: two walks of one map, one settled and not yet taken up
const now = Date.UTC(2026, 10, 26, 4, 0);
const objs = new Map([
  ['twins/1795651200000/meta.json', { body: JSON.stringify({ map: 'M' }), uploaded: new Date(now - 3600e3) }],
  ['twins/1795651200000/cloud-0000.bin', { body: '', uploaded: new Date(now - 3600e3) }],
  ['twins/1795658400000/meta.json', { body: JSON.stringify({ map: 'M' }), uploaded: new Date(now - 60e3) }],   // still being sent
  ['auto/M.json', { body: JSON.stringify({ walks: [] }), uploaded: new Date(now) }],
]);
const bucket = {
  async list({ prefix }) { return { objects: [...objs].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded })), truncated: false }; },
  async get(k) { const o = objs.get(k); return o ? { text: async () => o.body } : null; },
  async put(k, body) { objs.set(k, { body, uploaded: new Date(now) }); },
};
const calls = [];
const fetcher = async (url, init) => { calls.push({ url, init }); return { status: 204 }; };
const r = await afterWalks({ TWIN: bucket, GH_DISPATCH_TOKEN: 't', GH_REPO: 'o/r', GH_REF: 'b' }, now, fetcher);
assert.equal(r.due, 1); assert.equal(r.dispatched, true);
assert.match(calls[0].url, /repos\/o\/r\/actions\/workflows\/scan-after-walk\.yml\/dispatches$/);
assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'b' });
// not again within 50 minutes
const r2 = await afterWalks({ TWIN: bucket, GH_DISPATCH_TOKEN: 't', GH_REPO: 'o/r' }, now + 60e3, fetcher);
assert.equal(r2.dispatched, false); assert.equal(calls.length, 1);
// no token: said, nothing sent
objs.delete('auto/_dispatch.json');
const r3 = await afterWalks({ TWIN: bucket, GH_REPO: 'o/r' }, now, fetcher);
assert.equal(r3.why, 'no token'); assert.equal(calls.length, 1);
console.log('after (the site starts S3): ok');
