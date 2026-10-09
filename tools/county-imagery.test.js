/**
 * The arithmetic of tools/county-imagery.js, without a network.
 *   node tools/county-imagery.test.js
 */
import {
  agolKeep, rankCandidates, coverage, blockiness, resizeRGBA, shiftedBbox,
  resampleThrough, padFor, nudged,
  imageryVerdict,
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

check('a "most recent" service is tried first, not with the undated',
  rankCandidates([
    { url: 'https://v/VBMP_Imagery/VBMP2023_WGS/MapServer', title: 'VBMP_Imagery/VBMP2023_WGS' },
    { url: 'https://v/VBMP_Imagery/Orthos/MapServer', title: 'Orthos' },
    { url: 'https://v/VBMP_Imagery/MostRecentImagery_WGS/MapServer', title: 'VBMP_Imagery/MostRecentImagery_WGS' },
  ], 2016).map((c) => c.title.split('/').pop()).join() === 'MostRecentImagery_WGS,VBMP2023_WGS,Orthos');

/* Coverage. */
const W = 40, H = 40;
const fill = (fn) => { const d = new Uint8Array(W * H * 4); for (let i = 0; i < W * H; i++) d.set(fn(i), i * 4); return d; };
check('a photograph is covered', coverage(fill((i) => [(i * 7) % 200 + 20, 120, 80, 255]), W, H) > 0.98);
check('a few saturated white pixels (a sunlit driveway) are not missing data',
  coverage(fill((i) => (i % 250 === 0 ? [255, 255, 255, 255] : [90, 120, 80, 255])), W, H) > 0.99);
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

/* Banking through a measured map: the county picture is fetched with a margin
   and read through A onto Mapbox's grid. */
{
  const W = 8, H = 6, padX = 2, padY = 3;
  const src = { width: W + 2 * padX, height: H + 2 * padY, data: new Uint8Array((W + 2 * padX) * (H + 2 * padY) * 4) };
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
    const i = (y * src.width + x) * 4; src.data[i] = x * 10; src.data[i + 1] = y * 10; src.data[i + 3] = 255;
  }
  const same = resampleThrough(src, [1, 0, 0, 0, 1, 0], W, H, padX, padY);
  check('through no map, the frame is the middle of the widened picture',
    same.data[0] === padX * 10 && same.data[1] === padY * 10 && same.data[((H - 1) * W + W - 1) * 4] === (W - 1 + padX) * 10);
  const moved = resampleThrough(src, [1, 0, 1, 0, 1, -2], W, H, padX, padY);
  check('through a shift, each pixel reads the ground the map says',
    moved.data[0] === (padX + 1) * 10 && moved.data[1] === (padY - 2) * 10);
  const half = resampleThrough(src, [1, 0, 0.5, 0, 1, 0], W, H, padX, padY);
  check('between pixels it blends', half.data[0] === padX * 10 + 5);
}
check('the margin covers where the map reaches, and a little more',
  JSON.stringify(padFor([1, 0, 0, 0, 1, 0], 100, 80)) === '[4,4]'
  && JSON.stringify(padFor([1, 0, -10, 0, 1, 6], 100, 80)) === '[14,10]');
check('a person nudging the photo 1 m east moves where Mapbox reads it 10 px west (10 cm pixels)',
  JSON.stringify(nudged([1, 0, 5, 0, 1, 5], 1, 0, 0.1)) === JSON.stringify([1, 0, -5, 0, 1, 5])
  && JSON.stringify(nudged([1, 0, 5, 0, 1, 5], 0, 1, 0.1)) === JSON.stringify([1, 0, 5, 0, 1, 15]));


/* ArcGIS Online by the county's name (owner, 2026-10-02): the query, and the layers a web map draws. */
{
  const { agolNameSearchUrl, webMapLayers, itemIdsIn, countyWords } = await import('./county-imagery.js');
  const u = new URL(agolNameSearchUrl({ name: 'Mono County, CA', box: [-119.66, 37.46, -117.83, 38.71] }));
  check('the name search asks for the county by name, inside its box, web maps and apps included',
    u.searchParams.get('q').startsWith('"Mono County" AND') && /Web Map/.test(u.searchParams.get('q'))
      && u.searchParams.get('bbox') === '-119.66,37.46,-117.83,38.71');
  check('and nothing for a statewide entry', countyWords({ name: 'Montana (found)', statewide: true }) === null
    && agolNameSearchUrl({ name: 'Montana (found)', statewide: true, box: [0, 0, 1, 1] }) === null);
  const layers = webMapLayers({
    operationalLayers: [{ title: 'Parcels', url: 'https://a.gov/arcgis/rest/services/Parcels/FeatureServer/0' },
      { title: 'Group', layers: [{ title: '2026 Nearmap', url: 'https://a.gov/server/rest/services/2026_Nearmap/MapServer' }] }],
    baseMap: { baseMapLayers: [{ title: 'Ortho', url: 'https://a.gov/image/rest/services/Ortho/ImageServer/' }] },
  });
  check('a web map gives up its map and image services, nested ones too, and not feature layers',
    layers.length === 2 && layers[0].title === '2026 Nearmap' && layers[1].type === 'ImageServer', JSON.stringify(layers));
  check('an app names its web maps by id', itemIdsIn({ map: { itemId: '0123456789abcdef0123456789abcdef' } })[0] === '0123456789abcdef0123456789abcdef');
}


/* Names that say what the metadata does not (2026-10-02). */
{
  const { namedCm, NOT_A_PHOTO } = await import('./county-imagery.js');
  const { pickImagery } = await import('./compare-imagery.js');
  check('a resolution in the name is read', namedCm('wv_imagery_NAIP_2024_60cm') === 60 && Math.abs(namedCm('NH_2021_2022_6in_RGB') - 15.24) < 0.01
    && Math.abs(namedCm('CT 2023 Spring Aerial Imagery (4-band, 3 inch)') - 7.62) < 0.01 && namedCm('Orthos2020') === null);
  check('NAIP is refused wherever it sits in a name', NOT_A_PHOTO.test('Imagery_BaseMaps_EarthCover/wv_imagery_NAIP_2024_60cm')
    && NOT_A_PHOTO.test('ImageServices/NH_NAIP_2023_30cm') && !NOT_A_PHOTO.test('Orthoimagery_2020_2023')
    && NOT_A_PHOTO.test('wms/2025_cir_summer') && !NOT_A_PHOTO.test('wms/2025_summer') && !NOT_A_PHOTO.test('Circle_City_Ortho_2024'));
  const kept = pickImagery([{ name: 'wms/Latest', type: 'MapServer', root: 'https://orthos.its.ny.gov/arcgis/rest/services' },
    { name: 'wms/Latest', type: 'MapServer', root: 'https://gis.example.gov/arcgis/rest/services' }]);
  check('a server that is about imagery keeps every service, others only imagery-named ones',
    kept.length === 1 && kept[0].root.includes('orthos.its.ny.gov'), JSON.stringify(kept));
}

/* Athens County, 2026-10-03: an 1897 Sanborn map and a comments layer passed as photos. */
{
  const { yearHints } = await import('./compare-imagery.js');
  const { NOT_A_PHOTO } = await import('./county-imagery.js');
  check('an 1800s year in a name is a year', yearHints('1897_Cambridge_Sanborn_Map').includes(1897));
  const { historic } = await import('./county-imagery.js');
  check('a 1972 mosaic published in 2025 is historic; a 2015-2024 series is not',
    historic('AirPhotos/Niagara1972mosaic_2025') && !historic('Ortho_2015_2024') && !historic('Aerial 2025'));
  check('a Sanborn map and a comments layer are not photos',
    NOT_A_PHOTO.test('1897_Cambridge_Sanborn_Map') && NOT_A_PHOTO.test('WestSideComments_WTL1')
    && !NOT_A_PHOTO.test('Sanborn 2024 Ortho'));
  check('raw camera frames are not a photo of the ground, an orthophoto is',
    NOT_A_PHOTO.test('Misc/Raw_Image_Frames_2026') && NOT_A_PHOTO.test('Oblique_2024')
    && !NOT_A_PHOTO.test('Imagery/Orthophotos_2026') && !NOT_A_PHOTO.test('Frankfort_Ortho_2025'));
}

/* What the nightly search records for a county's photos (owner, 2026-10-03). */
{
  const ok = imageryVerdict({ found: 2, notes: ['OK Ortho 2024 2024 6 cm'], candidates: 5 });
  check('a county with photo services is recorded as covered, new ones named',
    ok.status === 'covered' && /Ortho 2024/.test(ok.reason), JSON.stringify(ok));
  const bad = imageryVerdict({ found: 0, notes: ['x A: no picture here', 'x B: no picture here', 'x C: too coarse (said 60 cm, measured detail 0.04)'], candidates: 3 });
  check('a failure says why, the commonest reasons first',
    bad.status === 'failed' && /no picture here \(2\); too coarse \(1\)/.test(bad.reason), JSON.stringify(bad));
  check('and nothing found at all is said as that',
    imageryVerdict({ found: 0, notes: [], candidates: 0 }).status === 'none');
}

/* WHAT A SERVICE SAYS ABOUT ITS SEASON (owner, 2026-10-04). */
{
  const { leafWording, flownWording, catalogueDates, seasonOf } = await import('./county-imagery.js');
  check('"leaf-off" in a description reads as leaf-off, with the words kept',
    leafWording('<p>4-band orthoimagery, spring <b>leaf-off</b> flight, 3 inch</p>').leaf === 'off'
      && /spring leaf-off flight/.test(leafWording('<p>4-band orthoimagery, spring <b>leaf-off</b> flight</p>').note));
  check('and the other spellings', ['Leaf Off 2024', 'leafoff', 'leaves-off imagery', 'leafless conditions'].every((t) => leafWording(t).leaf === 'off'));
  check('"leaf-on" reads as leaf-on, and is not taken for leaf-off', leafWording('Summer leaf-on NAIP').leaf === 'on');
  check('both mentioned is both', leafWording('leaf-off 2022 and leaf-on 2023 collections').leaf === 'both');
  check('nothing said is nothing', leafWording('Orthoimagery 2025').leaf === null);
  check('flight dates in the words', flownWording('Imagery flown March 15, 2024; also 04/02/2024 and spring 2023') === 'March 15, 2024; 04/02/2024; spring 2023',
    flownWording('Imagery flown March 15, 2024; also 04/02/2024 and spring 2023'));
  check('no date, no answer', flownWording('Ortho 2024') === null);
  const m = { fields: [{ name: 'AcquisitionDate', type: 'esriFieldTypeDate' }] };
  const fake = async () => ({ features: [{ attributes: { AcquisitionDate: Date.UTC(2024, 2, 10) } }, { attributes: { AcquisitionDate: Date.UTC(2024, 3, 2) } }] });
  check('an image catalogue gives its acquisition dates',
    (await catalogueDates('https://x/arcgis/rest/services/Ortho/ImageServer', m, fake)) === '2024-03-10..2024-04-02');
  check('a MapServer is not asked', (await catalogueDates('https://x/arcgis/rest/services/Ortho/MapServer', m, fake)) === null);
  const s = await seasonOf('https://x/arcgis/rest/services/Ortho/ImageServer', 'Ortho 2024',
    { ...m, serviceDescription: 'Leaf-off, flown in April 2024.' }, fake);
  check('all of it together', s.leaf === 'off' && s.flown === '2024-03-10..2024-04-02; April 2024', JSON.stringify(s));
}

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
