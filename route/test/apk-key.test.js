// Route Reader's signing key: made once and kept in KV, the same one after.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keystore } from '../tools/apk-key.mjs';

const kv = new Map();
const fetcher = async (url, init = {}) => {
  const key = url.split('/values/')[1];
  if (init.method === 'PUT') { kv.set(key, init.body); return new Response('{}'); }
  return kv.has(key) ? new Response(kv.get(key)) : new Response('', { status: 404 });
};
const dir = mkdtempSync(join(tmpdir(), 'rr-'));
let makes = 0;
const make = (out) => { makes += 1; writeFileSync(out, 'KEYSTORE-BYTES'); };
const a = await keystore(fetcher, { token: 't', account: 'a', kvId: 'k', out: join(dir, 'one.jks'), make });
assert.equal(a.made, true);
assert.equal(Buffer.from(kv.get('android-keystore'), 'base64').toString(), 'KEYSTORE-BYTES');
const b = await keystore(fetcher, { token: 't', account: 'a', kvId: 'k', out: join(dir, 'two.jks'), make });
assert.equal(b.made, false, 'the second build reuses it');
assert.equal(b.pass, a.pass);
assert.equal(readFileSync(join(dir, 'two.jks'), 'utf8'), 'KEYSTORE-BYTES');
assert.equal(makes, 1);
console.log('route apk key: ok');
