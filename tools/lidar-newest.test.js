/** The newest-lidar plan (tools/lidar-newest.js), offline.   node tools/lidar-newest.test.js */
import { norm, workUnits, unitOf, dateOctree, unitFolder, tileSets, pickNewest } from './lidar-newest.js';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); if (!ok) failures++; };
const ms = (s) => Date.parse(s);

// WESM over the Macon GA lot (H94), as the service returns it.
const wesm = { features: [
  { attributes: { workunit: 'GA_SW_Georgia_B4_2017', project: 'GA_SW_Georgia_22_County_Lidar_2017_B17', collect_start: ms('2021-01-15'), collect_end: ms('2021-01-30'), ql: 'QL 2' } },
  { attributes: { workunit: 'GA_Central_5_2018', project: 'GA_Central_2018', collect_start: ms('2018-12-01'), collect_end: ms('2019-02-01'), ql: 'QL 2' } },
  { attributes: { workunit: 'GA_Bibb_2010', project: 'GA_Bibb_Jasper_Jones_Monroe_2010', collect_start: ms('2010-02-01'), collect_end: ms('2010-03-01'), ql: 'Other' } },
] };
const units = workUnits(wesm);
check('a flight\'s epoch is the middle of its collection', Math.abs(units[0].epoch - 2021.05) < 0.01, String(units[0].epoch));
check('names are compared without case or punctuation', norm('USGS_LPC_IL-5County') === 'usgslpcil5county');
check('an octree is matched to the work unit its name contains',
  unitOf('USGS_LPC_GA_SW_Georgia_B4_2017_LAS_2021', units)?.workunit === 'GA_SW_Georgia_B4_2017');

const octrees = [
  { name: 'GA_Central_5_2018', url: 'u1', density: 2 },
  { name: 'GA_SW_Georgia_B4_2017', url: 'u2', density: 2 },
  { name: 'GA_Bibb_Jasper_Jones_Monroe_2010', url: 'u3', density: 1 },
].map((o) => dateOctree(o, units));
check('THE PICKER FIX: the 2021 flight beats the 2018 one its name\'s year put first',
  pickNewest(octrees, [])?.name === 'GA_SW_Georgia_B4_2017');
check('an octree no work unit names keeps its name\'s year',
  dateOctree({ name: 'KY_FullState_2020' }, []).dated === 'name' && dateOctree({ name: 'KY_FullState' }, []).dated === 'none');

const url = 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/IL_19County_D24/IL_19County_4_D24/LAZ/USGS_LPC_IL_19County_D24_1051_1757.laz';
check('the work unit is the folder above LAZ', unitFolder(url) === 'IL_19County_4_D24');

const il = workUnits({ features: [
  { attributes: { workunit: 'IL_19County_4_D24', project: 'IL_19County_D24', collect_start: ms('2024-11-26'), collect_end: ms('2025-01-04') } },
  { attributes: { workunit: 'IL_5County_WillCo_2014', project: 'IL_5_County_2014_15', collect_start: ms('2014-11-01'), collect_end: ms('2015-04-01') } },
] });
const items = [
  { downloadLazURL: url, sizeInBytes: 69191535 },
  { downloadLazURL: url.replace('1757', '1759'), sizeInBytes: 57452406 },
  { downloadLazURL: url, sizeInBytes: 69191535 },
  { downloadLazURL: 'https://rockyweb.usgs.gov/.../IL_5County_WillCo_2014/LAZ/x.laz', sizeInBytes: 1 },
];
const willCo = [dateOctree({ name: 'USGS_LPC_IL_5County_WillCo_2014_LAS_2016', url: 'w', density: 2 }, il)];
const sets = tileSets(items, il, willCo.map((o) => o.unit));
check('a collection with no octree is offered as its tiles, each once',
  sets.length === 1 && sets[0].tiles.length === 2 && Math.round(sets[0].mb) === 127, JSON.stringify(sets.map((s) => [s.unit, s.tiles.length, s.mb])));
check('the 2024 tiles are picked over the 2014 octree', pickNewest(willCo, sets)?.kind === 'tiles');
const near = [{ ...sets[0], end: willCo[0].end + 200 * 86400000 }];
check('but not when they are under a year newer: an octree is read in seconds', pickNewest(willCo, near)?.kind === 'octree');
check('a legacy collection is never offered',
  tileSets([{ downloadLazURL: '.../X_2001/LAZ/a.laz' }], workUnits({ features: [{ attributes: { workunit: 'X_2001', project: 'legacy', collect_start: 1, collect_end: 2 } }] }), []).length === 0);
check('no lidar at all is no pick', pickNewest([], []) === null);

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
