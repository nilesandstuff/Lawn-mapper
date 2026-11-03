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
assert.ok(!/d1_databases/.test(toml), 'no database id, no binding (the Worker answers 503 for walks)');
const withDb = wranglerFor('scan.example.com', 'lawnmap.example.com', true, '12345678-1234-1234-1234-123456789abc');
assert.match(withDb, /\[\[d1_databases\]\]\nbinding = "DB"\ndatabase_name = "lawn-scan"\ndatabase_id = "12345678-1234-1234-1234-123456789abc"/);
assert.ok(!/r2_buckets/.test(withDb), 'no bucket, no binding (the Worker answers 503 for twins)');
assert.match(wranglerFor('scan.example.com', 'lawnmap.example.com', true, null, 'lawn-scan-twins'), /\[\[r2_buckets\]\]\nbinding = "TWIN"\nbucket_name = "lawn-scan-twins"/);
assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/, 'the engine is pinned');
assert.equal(engineDist('/nowhere'), null, 'no engine installed, none copied');
console.log('prepare: ok');
