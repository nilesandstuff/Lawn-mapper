/** node tools/https-only.test.js */
import { zoneCandidates } from './https-only.js';
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); if (!ok) failures++; };
const z = zoneCandidates('lawnmap.nilesandstuff.com');
check('a subdomain tries itself, then its parent, never the bare TLD',
  JSON.stringify(z) === JSON.stringify(['lawnmap.nilesandstuff.com', 'nilesandstuff.com']), JSON.stringify(z));
check('an empty host tries nothing', zoneCandidates('').length === 0);
console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
