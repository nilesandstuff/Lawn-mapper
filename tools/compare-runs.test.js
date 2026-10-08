/**
 * The paired comparison of two settings across runs.
 *
 *   node tools/compare-runs.test.js
 */

import { bootstrapMedianCI, compare, pool, signTestP, photoOf } from './compare-runs.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const run = (errs, row = 'r') => ({
  fingerprint: 'x',
  rows: [{ name: row, lots: errs.map((e, i) => ({ id: `lot${i}`, benchmark: i < 5, tag: i < 5 ? `B0${i}` : null, error: e })) }],
});

// Two seeds of A average per lot.
const a = pool([run([10, 20, 30, 40, 50, 60, 70, 80]), run([12, 22, 32, 42, 52, 62, 72, 82])], 'r');
check('a lot\'s figure is its mean over the runs', a.mean.get('lot0').error === 11);
check('and each run\'s median is kept, to show the seed spread', a.medians.join() === '45,47');

// B better by 5 on every lot but one.
const b = pool([run([6, 16, 26, 36, 46, 56, 66, 90])], 'r');
const c = compare(a, b);
check('wins, losses and ties counted on the paired lots', c.wins === 7 && c.losses === 1 && c.ties === 0, JSON.stringify(c));
check('the paired median change is the typical lot\'s change', c.medianChange === -5);
check('and its interval excludes zero here', c.ci[1] < 0, c.ci.join());
const bench = compare(a, b, { only: 'benchmark' });
const fresh = compare(a, b, { only: 'new' });
check('the frozen lots and the ones since are read apart', bench.lots === 5 && fresh.lots === 3);

check('a sign test: 7 against 1 is p = 0.070', Math.abs(signTestP(7, 1) - 0.0703) < 0.001, String(signTestP(7, 1)));
check('and 18 against 7 is p = 0.043', Math.abs(signTestP(18, 7) - 0.0433) < 0.001, String(signTestP(18, 7)));
check('an even split is p = 1', signTestP(5, 5) === 1);
check('the same data give the same interval', bootstrapMedianCI([1, 2, 3, 4, 5]).join() === bootstrapMedianCI([1, 2, 3, 4, 5]).join());
check('a missing row is simply absent, not an error', pool([run([1, 2, 3])], 'nope').mean.size === 0);

/* Split by the photo a lot was drawn on (2026-10-08). */
{
  const mk = (rows) => pool([{ rows: [{ name: 'r', lots: rows }] }], 'r');
  const a = mk([{ id: 'x', error: 10 }, { id: 'y', error: 20, photo: 'county' }, { id: 'z', error: 30 }]);
  const b = mk([{ id: 'x', error: 12 }, { id: 'y', error: 10, photo: 'county' }, { id: 'z', error: 31 }]);
  const county = compare(a, b, { photo: 'county', photos: { z: 'county' } });
  check('a lot is county by its own record or by the database', county.lots === 2 && county.wins === 1 && county.losses === 1);
  check('and everything else is Mapbox', compare(a, b, { photo: 'mapbox', photos: { z: 'county' } }).lots === 1);
  check('a missing record is Mapbox', photoOf('q', {}, null) === 'mapbox' && photoOf('q', {}, { q: 'county' }) === 'county');
}

if (failures) { console.log(`\n${failures} failed.`); process.exit(1); }
console.log('\nAll checks passed.');
