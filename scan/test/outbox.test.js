// scan/lib/outbox.js: parts wait on the phone until the site has them. node scan/test/outbox.test.js
import assert from 'node:assert/strict';
import { newOutbox, memoryStore, statusText, sizeOf, RETRY_MS } from '../lib/outbox.js';

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

// all goes when the site answers
{
  const store = memoryStore(), got = [];
  const ob = newOutbox({ store, send: async (p) => { got.push(p.name); return 'ok'; }, sleep: async () => {} });
  await ob.add('w1', 'a.json', 'application/json', '{"x":1}');
  await ob.add('w1', 'b.bin', 'application/octet-stream', new Float32Array(4).buffer);
  await settle();
  assert.deepEqual(got.sort(), ['a.json', 'b.bin']);
  assert.equal((await store.all()).length, 0);
  assert.equal(ob.status().sent, 2);
  assert.match(statusText(ob.status()), /^Upload: all saved \(2 parts/);
}

// no connection: everything stays, waits, and goes once the connection is back; the same name replaces the waiting one
{
  const store = memoryStore(); let online = false; const sleeps = [], got = [];
  const ob = newOutbox({ store, send: async (p) => { if (!online) throw new Error('offline'); got.push(p.name); return 'ok'; }, sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= 3) online = true; } });
  await ob.add('w2', 'live.json', 'application/json', '{"v":1}');
  await ob.add('w2', 'key-0000.jpg', 'image/jpeg', 'JPEGBYTES');
  await ob.add('w2', 'live.json', 'application/json', '{"v":2}');
  await settle(60);
  assert.deepEqual(sleeps.slice(0, 3), [RETRY_MS, RETRY_MS * 2, RETRY_MS * 4], 'backs off, doubling');
  assert.equal(got.filter((n) => n === 'live.json').length, 1, 'one live.json, the newest');
  assert.ok(got.includes('key-0000.jpg'));
  assert.equal((await store.all()).length, 0, 'nothing lost, nothing left');
}

// a part the site refuses is set aside, not retried for ever; 'off' keeps everything on the phone
{
  const store = memoryStore();
  const ob = newOutbox({ store, send: async (p) => (p.name === 'bad' ? 'drop' : 'ok'), sleep: async () => {} });
  await ob.add('w3', 'bad', 'text/plain', 'x'); await ob.add('w3', 'good', 'text/plain', 'y');
  await settle();
  assert.equal(ob.status().dropped, 1); assert.equal(ob.status().sent, 1);
  const s2 = memoryStore();
  const off = newOutbox({ store: s2, send: async () => 'off', sleep: async () => {} });
  await off.add('w4', 'p', 'text/plain', 'z');
  await settle();
  assert.equal((await s2.all()).length, 1, 'kept on the phone');
  assert.match(statusText(off.status()), /^Upload: off/);
}

// parts left by an earlier walk (the app closed) go up when the page opens again
{
  const store = memoryStore();
  await store.put({ id: 'old/cloud-0000.bin', walk: 'old', name: 'cloud-0000.bin', type: 'application/octet-stream', body: new ArrayBuffer(24), at: 1 });
  const got = [];
  const ob = newOutbox({ store, send: async (p) => { got.push(p.walk); return 'ok'; }, sleep: async () => {} });
  await ob.refresh();
  assert.match(statusText(ob.status()), /^Upload: 1 part \(1 KB\) waiting/);
  ob.kick(); await settle();
  assert.deepEqual(got, ['old']);
}
// (2026-11-07) a part written again while its older copy is on its way: the newer copy is not deleted with it, and goes
{
  const store = memoryStore(), got = []; let ob;
  ob = newOutbox({ store, sleep: async () => {}, send: async (p) => {
    got.push(p.body);
    if (p.body === '{"v":1}') await ob.add('w5', 'live.json', 'application/json', '{"v":2,"ended":true}'); // the walk ends meanwhile
    return 'ok';
  } });
  await ob.add('w5', 'live.json', 'application/json', '{"v":1}');
  await settle(60);
  assert.deepEqual(got, ['{"v":1}', '{"v":2,"ended":true}'], 'the end\'s copy goes too');
  assert.equal((await store.all()).length, 0);
}
// and one replaced while it waited in the round's list behind another part
{
  const store = memoryStore(), got = []; let ob;
  ob = newOutbox({ store, sleep: async () => {}, send: async (p) => {
    got.push(`${p.name}:${p.body}`);
    if (p.name === 'key-0000.jpg') await ob.add('w6', 'live.json', 'application/json', 'B');
    return 'ok';
  } });
  await store.put({ id: 'w6/key-0000.jpg', walk: 'w6', name: 'key-0000.jpg', type: 'image/jpeg', body: 'J', at: 1 });
  await store.put({ id: 'w6/live.json', walk: 'w6', name: 'live.json', type: 'application/json', body: 'A', at: 2 });
  ob.kick(); await settle(60);
  assert.deepEqual(got, ['key-0000.jpg:J', 'live.json:A', 'live.json:B']);
  assert.equal((await store.all()).length, 0);
}
assert.equal(sizeOf('abc'), 3); assert.equal(sizeOf(new ArrayBuffer(10)), 10); assert.equal(sizeOf(null), 0);
console.log('outbox: ok');
