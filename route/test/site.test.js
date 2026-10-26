// The build: the page, its modules beside it, a domain that is never in the repository.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, fillHome, KEY_SHA256, routeDomainFor, wranglerFor } from '../tools/prepare.mjs';
import { findOrMake } from '../tools/kv.mjs';

assert.equal(routeDomainFor('lawnmap.example.com'), 'route.example.com');
assert.equal(routeDomainFor(' LawnMap.Example.com '), 'route.example.com');
assert.equal(routeDomainFor('example.com'), null);
assert.equal(routeDomainFor(''), null);
assert.match(wranglerFor('route.example.com'), /pattern = "route\.example\.com"\ncustom_domain = true/);
assert.doesNotMatch(wranglerFor('route.example.com'), /kv_namespaces/, 'no storage without an id');
assert.match(wranglerFor('route.example.com', 'abc123'), /\[\[kv_namespaces\]\]\nbinding = "ROUTE"\nid = "abc123"/);
assert.match(wranglerFor('route.example.com'), new RegExp(`ROUTE_KEY_SHA256 = "${KEY_SHA256}"`));
assert.match(KEY_SHA256, /^[0-9a-f]{64}$/);
assert.equal(fillHome('<a href="__HOME_URL__">More tools at __HOME_NAME__</a>', 'route.example.com'), '<a href="https://example.com/">More tools at example.com</a>');

// the namespace: found by title, else made
const calls = [];
const cf = (list) => async (url, init = {}) => {
  calls.push(init.method || 'GET');
  if (init.method === 'POST') return Response.json({ success: true, result: { id: 'new1' } });
  return Response.json({ success: true, result: list });
};
assert.deepEqual(await findOrMake(cf([{ id: 'x', title: 'other' }, { id: 'old1', title: 'route-planner' }]), 'acct', 'tok'), { id: 'old1', made: false });
assert.deepEqual(await findOrMake(cf([{ id: 'x', title: 'other' }]), 'acct', 'tok'), { id: 'new1', made: true });
// no account id given: the token's own account
const seen = [];
const withAccount = async (url, init = {}) => {
  seen.push(url);
  if (url.includes('/accounts?')) return Response.json({ success: true, result: [{ id: 'acct9' }] });
  return Response.json({ success: true, result: [{ id: 'old1', title: 'route-planner' }] });
};
assert.deepEqual(await findOrMake(withAccount, '', 'tok'), { id: 'old1', made: false });
assert.ok(seen[1].includes('/accounts/acct9/storage/kv/namespaces'));
await assert.rejects(findOrMake(async () => Response.json({ success: false, errors: [{ message: 'no permission' }] }), 'a', 't'), /no permission/);

const dir = mkdtempSync(join(tmpdir(), 'route-'));
const out = build(join(dir, 'build'), 'route.example.com');
assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /href="https:\/\/example\.com\/"[^>]*>More tools at example\.com</);
for (const f of ['index.html', 'app.js', 'lib/parse.js', 'lib/solve.js', 'favicon.svg', 'robots.txt']) assert.ok(existsSync(join(out, f)), f);
// every module the page imports is in the build
const app = readFileSync(join(out, 'app.js'), 'utf8');
for (const [, m] of app.matchAll(/from '\.\/(.+?)'/g)) assert.ok(existsSync(join(out, m)), m);
assert.ok(existsSync(join(out, 'lib/doc.js')));
rmSync(dir, { recursive: true, force: true });

// no address in the page: the shop is typed, or comes in the link
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8') + app;
assert.doesNotMatch(page, /\b\d{3,5}\s+\d*(st|nd|rd|th)?\s*(street|st|ave|avenue|rd|road|dr|drive)\b/i);

console.log('route site: ok');
