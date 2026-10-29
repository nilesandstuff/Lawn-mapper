import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toRestore, toSave, localHashes, lotOf, sha256, fileKey, indexKey } from './bank.js';

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

const id = '-112.83597,37.70577:sam3:find';
check('a file belongs to the lot its name begins with', () => {
  assert.equal(lotOf(`${id}.npz`), id);
  assert.equal(lotOf(`${id}.json`), id);
  assert.equal(fileKey('naip-raw', `${id}.png`), `bank/naip-raw/${id}.png`);
  assert.equal(indexKey('lidar-points'), 'bank/lidar-points/index.json');
});
const index = { files: { [`${id}.npz`]: { sha256: 'a' }, 'B.npz': { sha256: 'b' }, 'C.npz': { sha256: 'c' } } };
check('restore fetches what the folder lacks or holds differently', () => {
  assert.deepEqual(toRestore(index, { [`${id}.npz`]: 'a', 'B.npz': 'old' }), ['B.npz', 'C.npz']);
});
check('and only for the lots of this run', () => {
  assert.deepEqual(toRestore(index, {}, new Set([id, 'C'])), [`${id}.npz`, 'C.npz']);
});
check('save puts what the bank lacks or holds differently, nothing else', () => {
  assert.deepEqual(toSave(index, { [`${id}.npz`]: 'a', 'B.npz': 'new', 'D.npz': 'd' }), ['B.npz', 'D.npz']);
  assert.deepEqual(toSave({ files: {} }, {}), []);
});
check('a folder is hashed by file, partial writes and sub-folders left out', () => {
  const d = mkdtempSync(join(tmpdir(), 'bank-'));
  writeFileSync(join(d, 'X.npz'), 'points');
  writeFileSync(join(d, 'Y.npz.part'), 'half');
  mkdirSync(join(d, 'sub'));
  assert.deepEqual(localHashes(d), { 'X.npz': sha256(Buffer.from('points')) });
  assert.deepEqual(localHashes(join(d, 'missing')), {});
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
