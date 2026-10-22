// The build: the page, its modules beside it, a domain that is never in the repository.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, routeDomainFor, wranglerFor } from '../tools/prepare.mjs';

assert.equal(routeDomainFor('lawnmap.example.com'), 'route.example.com');
assert.equal(routeDomainFor(' LawnMap.Example.com '), 'route.example.com');
assert.equal(routeDomainFor('example.com'), null);
assert.equal(routeDomainFor(''), null);
assert.match(wranglerFor('route.example.com'), /pattern = "route\.example\.com"\ncustom_domain = true/);

const dir = mkdtempSync(join(tmpdir(), 'route-'));
const out = build(join(dir, 'build'));
for (const f of ['index.html', 'app.js', 'lib/parse.js', 'lib/solve.js', 'favicon.svg', 'robots.txt']) assert.ok(existsSync(join(out, f)), f);
// every module the page imports is in the build
const app = readFileSync(join(out, 'app.js'), 'utf8');
for (const [, m] of app.matchAll(/from '\.\/(.+?)'/g)) assert.ok(existsSync(join(out, m)), m);
rmSync(dir, { recursive: true, force: true });

// no address in the page: the shop is typed, or comes in the link
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8') + app;
assert.doesNotMatch(page, /\b\d{3,5}\s+\d*(st|nd|rd|th)?\s*(street|st|ave|avenue|rd|road|dr|drive)\b/i);

console.log('route site: ok');
