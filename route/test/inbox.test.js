// Route sheets by email: kept for the page, private, 14 days and 20 messages at most.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { api } from '../src/index.js';
import { MAX_MESSAGES, KEEP_DAYS } from '../src/inbox.js';

const data = new Map();
const puts = [];
const kv = {
  get: async (k) => data.get(k)?.value ?? null,
  put: async (k, value, opts = {}) => { data.set(k, { value, metadata: opts.metadata }); puts.push({ k, opts }); },
  delete: async (k) => { data.delete(k); },
  list: async ({ prefix }) => ({ keys: [...data].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })), list_complete: true }),
};
const ROUTE_KEY = 'route-key';
const INBOX_KEY = 'inbox-key-123';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const env = { ROUTE: kv, ROUTE_KEY_SHA256: sha(ROUTE_KEY) };
const call = (path, init = {}) => {
  const url = new URL(`https://route.example.com${path}`);
  return api(new Request(url, init), env, url, async () => new Response('no'));
};

/** What Email Routing hands the Worker. */
function message(raw, from = 'dispatch@example.com') {
  const bytes = new TextEncoder().encode(raw);
  let rejected = null;
  return {
    from, to: 'route-x@example.com', rawSize: bytes.length,
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
    setReject(why) { rejected = why; },
    get rejected() { return rejected; },
  };
}
const sheet = (n) => ['From: Dispatch <dispatch@example.com>', `Subject: Route Sheet ${n}`, 'Content-Type: multipart/mixed; boundary=B', '',
  '--B', 'Content-Type: text/html', '', `<table><tr><td>Address</td><td>Time</td></tr><tr><td>${n} Maple Ct SW</td><td>20 min</td></tr></table>`,
  '--B', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="sheet.pdf"', 'Content-Transfer-Encoding: base64', '',
  Buffer.from('%PDF-1.4 x').toString('base64'), '--B--'].join('\r\n');

// set up: the address and the inbox key's hash, with the route key only
assert.equal((await call('/api/inbox/config', { method: 'PUT', body: JSON.stringify({ address: 'route-x@example.com' }) })).status, 403);
let res = await call('/api/inbox/config', { method: 'PUT', headers: { 'X-Route-Key': ROUTE_KEY }, body: JSON.stringify({ address: 'Route-X@example.com', keySha256: sha(INBOX_KEY) }) });
assert.deepEqual(await res.json(), { address: 'route-x@example.com', key: true });

// an email arrives through the Worker's email handler
const msg = message(sheet(3581));
await worker.email(msg, env);
assert.equal(msg.rejected, null);
const put = puts.find((p) => p.k.startsWith('inbox:'));
assert.equal(put.opts.expirationTtl, KEEP_DAYS * 86400, 'kept 14 days at most');

// reading it: only with the inbox key (or the route key)
assert.equal((await call('/api/inbox')).status, 403);
assert.equal((await call('/api/inbox', { headers: { 'X-Inbox-Key': 'wrong' } })).status, 403);
const list = await (await call('/api/inbox', { headers: { 'X-Inbox-Key': INBOX_KEY } })).json();
assert.equal(list.address, 'route-x@example.com');
assert.equal(list.messages.length, 1);
assert.equal(list.messages[0].subject, 'Route Sheet 3581');
assert.deepEqual(list.messages[0].files, ['sheet.pdf']);
const one = await (await call(`/api/inbox/${list.messages[0].id}`, { headers: { 'X-Inbox-Key': INBOX_KEY } })).json();
assert.match(one.html, /3581 Maple Ct SW/);
assert.equal(Buffer.from(one.attachments[0].base64, 'base64').toString(), '%PDF-1.4 x');
assert.equal(one.from, 'dispatch@example.com');
assert.equal((await call(`/api/inbox/${list.messages[0].id}`)).status, 403);
assert.equal((await call('/api/inbox', { headers: { 'X-Route-Key': ROUTE_KEY } })).status, 200);

// newest first; only the 20 newest kept
for (let i = 0; i < MAX_MESSAGES + 3; i += 1) {
  const { receive } = await import('../src/inbox.js');
  await receive(message(sheet(1000 + i)), env, Date.UTC(2026, 9, 28) + i * 60000);
}
const after = await (await call('/api/inbox', { headers: { 'X-Inbox-Key': INBOX_KEY } })).json();
assert.equal(after.messages.length, MAX_MESSAGES);
assert.equal(after.messages[0].subject, `Route Sheet ${1000 + MAX_MESSAGES + 2}`);
assert.ok(!after.messages.some((m) => m.subject === 'Route Sheet 3581'), 'the oldest dropped');

// delete
assert.equal((await call(`/api/inbox/${after.messages[0].id}`, { method: 'DELETE', headers: { 'X-Inbox-Key': INBOX_KEY } })).status, 200);
assert.equal((await (await call('/api/inbox', { headers: { 'X-Inbox-Key': INBOX_KEY } })).json()).messages.length, MAX_MESSAGES - 1);

// no storage: the mail is refused, not lost silently
const m2 = message(sheet(1));
await worker.email(m2, {});
assert.match(m2.rejected, /not taking mail/);
console.log('route inbox: ok');
