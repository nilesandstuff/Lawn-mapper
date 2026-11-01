// scan/tools/prepare.mjs: the domain and the Worker's config. node scan/test/prepare.test.js
import assert from 'node:assert/strict';
import { scanDomainFor, wranglerFor, engineDist, ENGINE_VERSION } from '../tools/prepare.mjs';

assert.equal(scanDomainFor('lawnmap.nilesandstuff.com'), 'scan.nilesandstuff.com');
assert.equal(scanDomainFor('Lawnmap.Example.Co.UK'), 'scan.example.co.uk');
assert.equal(scanDomainFor('example.com'), null, 'a bare domain has no sibling');
assert.equal(scanDomainFor(''), null);
const toml = wranglerFor('scan.example.com', 'lawnmap.example.com');
assert.match(toml, /pattern = "scan\.example\.com"/);
assert.match(toml, /custom_domain = true/);
assert.match(toml, /LAWNMAP_HOST = "lawnmap\.example\.com"/);
assert.match(toml, /ADMIN_ONLY = "1"/, 'admin only until phase 3');
assert.match(toml, /service = "lawn-mapper"/);
assert.match(toml, /run_worker_first = true/);
assert.match(wranglerFor('scan.example.com', 'lawnmap.example.com', false), /ADMIN_ONLY = "0"/);
assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/, 'the engine is pinned');
assert.equal(engineDist('/nowhere'), null, 'no engine installed, none copied');
console.log('prepare: ok');
