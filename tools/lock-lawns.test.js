import assert from 'node:assert/strict';
import { lockChange } from './lock-lawns.js';

assert.deepEqual(lockChange(null, ['a', 'b']), { added: ['a', 'b'], removed: [] });
assert.deepEqual(lockChange(['a', 'b', 'c'], ['b', 'c', 'd']), { added: ['d'], removed: ['a'] });
console.log('lock lawns: ok');
