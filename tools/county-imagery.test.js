/**
 * The arithmetic of tools/county-imagery.js, without a network.
 *   node tools/county-imagery.test.js
 */
import {
  agolKeep, rankCandidates, chooseBest, coverage, blockiness, resizeRGBA, shiftedBbox,
} from './county-imagery.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

/* ArcGIS Online results: local, over the point, a real service. */
const kept = agolKeep([
  { title: 'Aerial Imagery 2024', url: 'https://gis.x.gov/image/rest/services/A2024/ImageServer', extent: [[-86, 42], [-85, 43]] },
  { title: 'World Imagery', url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer', extent: [[-180, -85], [180, 85]] },
  { title: 'Ortho 2020', url: 'https://gis.y.gov/arcgis/rest/services/O2020/MapServer/', extent: [[-80, 30], [-79, 31]] },
  { title: 'Ortho layer', url: 'https://gis.z.gov/arcgis/rest/services/O/MapServer/0', extent: [[-86, 42], [-85, 43]] },
], -85.5, 42.5);
check('ArcGIS Online: a local image service over the point is kept',
  kept.length === 1 && kept[0].type === 'ImageServer', JSON.stringify(kept));

/* Ranking: newest first, old flights dropped, duplicates dropped, cached twin after. */
check('false colour and other non-photos are not candidates',
  rankCandidates([{ url: 'https://t/MA_2025_CIR/MapServer', title: 'Massachusetts 2025 Aerial Imagery - CIR (Tile Service)' },
    { url: 'https://t/Ortho_Index/MapServer', title: 'Ortho index' },
    { url: 'https://t/NDVI2023/ImageServer', title: 'NDVI 2023' }]).length === 0);
const ranked = rankCandidates([
  { url: 'https://a/Aerial2008/ImageServer', title: 'Aerial 2008' },
  { url: 'https://a/Aerial2024_Cached/ImageServer', title: 'Aerial 2024' },
  { url: 'https://a/Aerial2024/ImageServer', title: 'Aerial 2024' },
  { url: 'https://a/Orthos/MapServer', title: 'Orthos' },
  { url: 'https://a/Aerial2021/ImageServer', title: 'Aerial 2021' },
  { url: 'https://A/Aerial2021/ImageServer', title: 'dup' },
]).map((c) => c.url);
check('candidates: newest first, the cached twin after, undated last, pre-2012 and duplicates gone',
  JSON.stringify(ranked) === JSON.stringify([
    'https://a/Aerial2024/ImageServer', 'https://a/Aerial2024_Cached/ImageServer',
    'https://a/Aerial2021/ImageServer', 'https://a/Orthos/MapServer']), ranked.join(' '));

/* Choosing: usable only; newest; finer on a tie. */
const best = chooseBest([
  { url: 'old', usable: true, year: 2019, nativeCm: 8 },
  { url: 'coarse', usable: true, year: 2023, nativeCm: 15 },
  { url: 'fine', usable: true, year: 2023, nativeCm: 7 },
  { url: 'newest-unusable', usable: false, year: 2025, nativeCm: 5 },
]);
check('the newest usable flight wins, the finer on a tie', best?.url === 'fine', best?.url);
check('and nothing usable chooses nothing', chooseBest([{ usable: false }]) === null);

/* Coverage. */
const W = 40, H = 40;
const fill = (fn) => { const d = new Uint8Array(W * H * 4); for (let i = 0; i < W * H; i++) d.set(fn(i), i * 4); return d; };
check('a photograph is covered', coverage(fill((i) => [(i * 7) % 200 + 20, 120, 80, 255]), W, H) > 0.98);
check('a few saturated white pixels (a sunlit driveway) are not missing data',
  coverage(fill((i) => (i % 50 === 0 ? [255, 255, 255, 255] : [90, 120, 80, 255])), W, H) > 0.99);
check('transparent or white no-data is not',
  coverage(fill((i) => (i % 2 ? [255, 255, 255, 255] : [0, 0, 0, 0])), W, H) < 0.05);

/* Blockiness: a 4x nearest-neighbour enlargement reads as about 4. */
const fine = fill((i) => [(i * 37) % 251, (i * 53) % 241, (i * 11) % 239, 255]);
const blocky = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = Math.floor(x / 4) * 4, sy = Math.floor(y / 4) * 4;
  blocky.set(fine.slice((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (y * W + x) * 4);
}
check('a picture at its own resolution is not blocky', blockiness(fine, W, H) === 1);
const b4 = blockiness(blocky, W, H);
check('a 4x nearest-neighbour enlargement reads as about 4', b4 > 3.3 && b4 < 4.7, b4.toFixed(2));

/* Resize keeps a flat colour flat and lands on the asked size. */
const r = resizeRGBA(fill(() => [10, 20, 30, 255]), W, H, 17, 9);
check('resizing lands on the size asked, colours intact', r.length === 17 * 9 * 4 && r[0] === 10 && r[4 * 50 + 2] === 30);

/*
 * The shifted box. align.js says "move the county photo east by T and scale
 * it by s about the centre to line up"; the box asked for must be the Mapbox
 * box moved by -T (and shrunk by s). At the equator a metre is a Mercator
 * metre, so the numbers read directly.
 */
const box = [0, 0, 100, 100];
const moved = shiftedBbox(box, 2, -1, 1, 0);
check('a county photo that must move 2 m east and 1 m south is asked for 2 m west and 1 m north',
  JSON.stringify(moved.map((v) => Math.round(v * 1e6) / 1e6)) === JSON.stringify([-2, 1, 98, 101]), JSON.stringify(moved));
const scaled = shiftedBbox(box, 0, 0, 1.25, 0);
check('and one that must be enlarged 1.25x is asked for a box 1/1.25 the size about the same centre',
  Math.abs(scaled[2] - scaled[0] - 80) < 1e-9 && Math.abs((scaled[0] + scaled[2]) / 2 - 50) < 1e-9, JSON.stringify(scaled));
const north = shiftedBbox(box, 0, 1, 1, 60);
check('at 60 degrees a ground metre is two Mercator metres', Math.abs(north[1] + 2) < 1e-9, JSON.stringify(north));

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
