/** tools/lidar-season.js.   node tools/lidar-season.test.js */
import { leafSeason, lidarAt } from './lidar-season.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};
const d = (s) => Date.parse(`${s}T00:00:00Z`);
check('Kent County, Nov 2017 to Apr 2018, is leaf-off', leafSeason(d('2017-11-27'), d('2018-04-20')) === 'off');
check('Kent County as flown, to 2 May, is still leaf-off', leafSeason(d('2017-11-27'), d('2018-05-02')) === 'off');
check('a spring flight running into June is mixed', leafSeason(d('2018-03-01'), d('2018-06-30')) === 'mixed');
check('a summer flight is leaf-on', leafSeason(d('2019-06-01'), d('2019-08-30')) === 'on');
check('no dates, no answer', leafSeason(null, d('2019-08-30')) === null);
const fake = async () => ({ features: [
  { attributes: { workunit: 'A_2012', ql: 'QL 3', collect_start: d('2012-03-01'), collect_end: d('2012-04-01') } },
  { attributes: { workunit: 'B_2018', ql: 'QL 2', collect_start: d('2017-11-27'), collect_end: d('2018-04-02') } },
] });
const got = await lidarAt(-85.6, 43.0, { fetchJson: fake });
check('collections come back newest first, each with its season and year',
  got[0].workunit === 'B_2018' && got[0].season === 'off' && got[0].year === 2018 && got[1].year === 2012, JSON.stringify(got[0]));
if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nlidar season: ok');
