/**
 * County photos: the verdict the API stores (worker/src/county.js) and the
 * compare page's filters and projection (public/county.js).
 *   node tools/county.test.js
 */
import { countyServiceAt, countyServiceById, MAX_SERVICE_SQ_DEG, drawsTo } from '../worker/src/county.js';
import { decodePng, looksLikePhoto } from '../worker/src/png-probe.js';
import { probeService, countyServicesAt, countyChoicesAt, oldestYear, SHARP_AT_12CM } from '../worker/src/county.js';
import { stitch, encodePng, isMercatorCache } from '../worker/src/tile-mosaic.js';
import { PNG } from 'pngjs';
import { providerCatalogue, imageryUrl, detectionProvider, countyExportUrl, frameBbox3857 } from '../worker/src/imagery.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

/* No finer than a service draws (2026-10-09, C48: Prince William's 2025 layer stops at 1:300). */
{
  const meta = { maxScale: 100, layers: [
    { id: 0, name: '2025', defaultVisibility: true, maxScale: 300 },
    { id: 1, name: '2023', defaultVisibility: false, maxScale: 300 },
    { id: 3, name: '2019', defaultVisibility: false, maxScale: 100 },
  ] };
  check('the closest a service draws is its default layers\' limit', drawsTo(meta) === 300 && drawsTo({}) === 0 && drawsTo({ maxScale: 0, layers: [{ maxScale: 0 }] }) === 0);
  const frame = { lng: -77.459066, lat: 38.726504, zoom: 19.19, size: 637, height: 434 };
  const box = frameBbox3857(frame);
  const size = (u) => new URL(u).searchParams.get('size').split(',').map(Number);
  const [w0] = size(countyExportUrl({ url: 'https://x/MapServer', type: 'MapServer' }, frame));
  const [w1, h1] = size(countyExportUrl({ url: 'https://x/MapServer', type: 'MapServer', maxScale: 300 }, frame));
  const scale = ((box[2] - box[0]) / w1) * (96 / 0.0254);
  check('a frame asked closer than that is asked at the limit instead, same shape', w1 < w0 && scale >= 300 && scale < 320 && Math.abs(w1 / h1 - 1274 / 868) < 0.01,
    `${w0} -> ${w1}x${h1}, 1:${scale.toFixed(0)}`);
  const [w2] = size(countyExportUrl({ url: 'https://x/MapServer', type: 'MapServer', maxScale: 50 }, frame));
  check('and one that draws closer is asked at the frame\'s own size', w2 === w0);
}

/* The county photo as a source, for any address (owner, 2026-10-01). */
{
  const cat = providerCatalogue({}).find((p) => p.id === 'county');
  check('the county photo is in the list, detects, and is offered per lot only',
    cat && cat.detect === true && cat.perLot === true, JSON.stringify(cat));
  check('and it detects as itself, not Mapbox', detectionProvider('county') === 'county');
  const f = { lng: -85.86, lat: 42.87, zoom: 19.5, size: 640, height: 400 };
  check('no service, no picture: never a guess', imageryUrl('county', f) === null);
  const img = new URL(imageryUrl('county', { ...f, svc: { url: 'https://gis.example/arcgis/rest/services/Ortho2024/ImageServer', type: 'ImageServer', maxPx: 4096 } }));
  check('an image service is asked for exactly the frame at the frame\'s pixels',
    img.pathname.endsWith('/ImageServer/exportImage') && img.searchParams.get('size') === '1280,800'
    && img.searchParams.get('bbox') === frameBbox3857(f).join(',') && img.searchParams.get('bboxSR') === '3857',
    img.search.slice(0, 120));
  const small = new URL(countyExportUrl({ url: 'https://gis.example/x/MapServer', type: 'MapServer', maxPx: 1000 }, f));
  check('a map service that draws less is asked for its most, same shape',
    small.pathname.endsWith('/MapServer/export') && small.searchParams.get('size') === '1000,625'
    && small.searchParams.get('format') === 'png32', small.search.slice(0, 120));
  /* The lookup, against a stand-in database. */
  const rows = [{ id: 7, url: 'https://a/ImageServer', type: 'ImageServer', title: 'Ortho 2024', year: 2024, native_cm: 7.5, max_px: 4000 }];
  const seen = [];
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => { seen.push([sql, a]); return { first: async () => rows[0], all: async () => ({ results: rows }) }; } }) } };
  const at = await countyServiceAt(env, -85.86, 42.87);
  check('the lookup asks for a service that draws a box and covers the point, newest then finest',
    at?.id === 7 && at.maxPx === 4000 && /export_ok = 1/.test(seen[0][0]) && /west <= \?1 AND east >= \?1/.test(seen[0][0])
    && /ORDER BY COALESCE\(year, CASE .*recent.* THEN 9999 ELSE 0 END\) DESC, \(east - west\) \* \(north - south\) ASC/s.test(seen[0][0]), JSON.stringify(at));
  check('and never a box bigger than a state (Virginia\'s claimed New Jersey)',
    /\(east - west\) \* \(north - south\) <= \?3/.test(seen[0][0]) && seen[0][1][2] === MAX_SERVICE_SQ_DEG);
  check('by id: only a whole number, never a URL', await countyServiceById(env, 'https://evil') === null
    && (await countyServiceById(env, '7'))?.url === 'https://a/ImageServer');
  check('no database, no answer', await countyServiceAt({}, 1, 2) === null);
}

/* Is there a photograph at the spot? (worker/src/png-probe.js) */
{
  const png = (fill, { colorType = 6 } = {}) => {
    const p = new PNG({ width: 32, height: 32, colorType });
    for (let i = 0; i < 32 * 32; i++) { const [r, g, b, a] = fill(i); p.data[i * 4] = r; p.data[i * 4 + 1] = g; p.data[i * 4 + 2] = b; p.data[i * 4 + 3] = a; }
    return new Uint8Array(PNG.sync.write(p, { colorType }));
  };
  const ground = (i) => [60 + ((i * 37) % 90), 90 + ((i * 53) % 70), 50 + ((i * 29) % 60), 255];
  const img = await decodePng(png(ground));
  check('a PNG is decoded in the Worker, pixel for pixel', img && img.width === 32 && img.data[4 * 5] === ground(5)[0] && img.data[4 * 5 + 1] === ground(5)[1]);
  check('and an RGB one too', (await decodePng(png(ground, { colorType: 2 })))?.data[3] === 255);
  check('textured ground is a photo', looksLikePhoto(img));
  check('flat grey is not (New Hampshire\'s habitat layer)', !looksLikePhoto(await decodePng(png(() => [214, 214, 214, 255]))));
  check('transparent is not (a box with no picture in it)', !looksLikePhoto(await decodePng(png(() => [0, 0, 0, 0]))));
  const answer = (bytes) => async () => new Response(bytes, { headers: { 'content-type': 'image/png' } });
  check('a service is asked for its picture of the spot and judged on it',
    await probeService({ url: 'https://x/ImageServer', type: 'ImageServer' }, -85.6, 42.9, { fetcher: answer(png(ground)) }) === true
    && await probeService({ url: 'https://x/MapServer', type: 'MapServer' }, -85.6, 42.9, { fetcher: answer(png(() => [0, 0, 0, 0])) }) === false);
  check('and one that does not answer is "not known", not "no"',
    await probeService({ url: 'https://x/ImageServer', type: 'ImageServer' }, -85.6, 42.9, { fetcher: async () => { throw new Error('timeout'); } }) === null);
}

/* The newest sharp one; ten years at most (owner, 2026-10-02: Marquette's 2020 beats its 2025). */
{
  const big = (fill) => {
    const p = new PNG({ width: 256, height: 256 });
    for (let i = 0; i < 256 * 256; i++) { const [r, g, b] = fill(i % 256, Math.floor(i / 256)); p.data.set([r, g, b, 255], i * 4); }
    return new Uint8Array(PNG.sync.write(p));
  };
  /* Soft: gentle swells, like a 60 cm photo blown up. Sharp: texture pixel by pixel. */
  const noise = (x, y) => ((x * 73856093) ^ (y * 19349663)) % 97;
  const soft = big((x, y) => { const v = Math.round(100 + 40 * Math.sin(x / 7) * Math.cos(y / 9)); return [v, v + 30, v - 10]; });
  const sharp = big((x, y) => { const v = 60 + noise(x, y); return [v, v + 30, v - 10]; });
  const rows = [
    { id: 1, url: 'https://a/Ortho2025/ImageServer', type: 'ImageServer', title: '2025', year: 2025, export_ok: 1 },
    { id: 2, url: 'https://a/Ortho2020/ImageServer', type: 'ImageServer', title: '2020', year: 2020, export_ok: 1 },
  ];
  const seen = [];
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => { seen.push([sql, a]); return { all: async () => ({ results: rows }) }; } }) } };
  const fetcher = async (u) => new Response(String(u).includes('2020') ? sharp : soft);
  const list = await countyServicesAt(env, -87.4, 46.5, 4, { fetcher, now: new Date('2026-10-02') });
  check('a soft 2025 photo is passed over for a sharp 2020 one, and kept as a last resort',
    list.map((s) => s.id).join() === '2,1' && list[1].detail < SHARP_AT_12CM && list[0].detail >= SHARP_AT_12CM,
    JSON.stringify(list.map((s) => [s.id, s.detail])));
  const both = await countyServicesAt(env, -87.4, 46.5, 4, { fetcher: async () => new Response(sharp), now: new Date('2026-10-02') });
  check('of two sharp enough, the newer, however much sharper the older', both.map((s) => s.id).join() === '1,2');
  /* Newest means the date of flight; the sharper wins a tie; the newer, softer flight is still offered (owner, 2026-10-09). */
  {
    const rows3 = [
      { id: 3, url: 'https://o/osip_most_current_cache/MapServer', type: 'MapServer', title: "Ohio's Most Current (Cached)", year: null, export_ok: 1 },
      { id: 4, url: 'https://c/Imagery2025/MapServer', type: 'MapServer', title: 'Imagery2025', year: 2025, export_ok: 1 },
      { id: 5, url: 'https://c/LeafOn2025/MapServer', type: 'MapServer', title: '2025 Leaf-On', year: 2025, flown: 'Fall of 2025', export_ok: 1 },
      { id: 6, url: 'https://o/osip_dynamic/ImageServer', type: 'ImageServer', title: 'Ohio dynamic', year: 2024, export_ok: 1 },
    ];
    const env3 = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows3 }) }) }) } };
    const sharper = big((x, y) => { const v = 40 + (noise(x, y) * 3) % 150; return [v, v + 30, v - 10]; });
    const f3 = async (u) => new Response(/LeafOn/.test(String(u)) ? soft : /dynamic/.test(String(u)) ? sharper : sharp);
    const { services, recent } = await countyChoicesAt(env3, -83.2, 40.0, 4, { fetcher: f3, now: new Date('2026-10-09') });
    check('the newest sharp flight first, "most current" with no date after the dated ones, the soft newest last',
      services.map((s) => s.id).join() === '4,6,3,5', services.map((s) => [s.id, s.detail]).join(' '));
    check('and the newer, softer flight is offered beside it as recent', recent?.id === 5, JSON.stringify(recent));
    const tie = [
      { id: 7, url: 'https://c/A2025/MapServer', type: 'MapServer', title: 'A 2025', year: 2025, export_ok: 1 },
      { id: 8, url: 'https://c/B2025/MapServer', type: 'MapServer', title: 'B 2025', year: 2025, export_ok: 1 },
    ];
    const envT = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: tie }) }) }) } };
    const got = await countyChoicesAt(envT, -83.2, 40.0, 4, { fetcher: async (u) => new Response(/B2025/.test(String(u)) ? sharper : sharp), now: new Date('2026-10-09') });
    check('the same flight date: the sharper one, and nothing newer to offer', got.services.map((s) => s.id).join() === '8,7' && got.recent === null, JSON.stringify(got.services.map((s) => [s.id, s.detail])));
  }
  check('two dozen boxes are looked at the spot, not twice the answer (Manassas behind Fairfax and Loudoun)',
    seen[0][1][3] === 24, JSON.stringify(seen[0][1]));
  {
    const old = [{ id: 9, url: 'https://n/AirPhotos/Niagara1972mosaic_2025/MapServer', type: 'MapServer', title: 'AirPhotos/Niagara1972mosaic_2025', year: 2025, export_ok: 1 }, ...rows];
    const env2 = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: old }) }) }) } };
    const got = await countyServicesAt(env2, -87.4, 46.5, 4, { probe: false });
    check('a 1972 mosaic published in 2025 is never offered', !got.some((s) => s.id === 9) && got.length === rows.length);
  }
  check('nothing flown more than ten years ago (2016 is the oldest in 2026); undated kept',
    oldestYear(new Date('2026-10-02')) === 2016 && /\(year IS NULL OR year >= \?5\)/.test(seen[0][0]) && seen[0][1][4] === 2016);
}

/* A tiles-only cache, stitched into one picture of the frame (tile-mosaic.js). */
{
  const O = 20037508.342787;
  /* A two-level Web Mercator cache whose finest level is z20, every tile
     coloured by its column and row so the stitch can be checked by colour. */
  const lods = [{ level: 19, resolution: 0.29858214164761665, scale: 1128.497176 }, { level: 20, resolution: 0.14929107082380833, scale: 564.248588 }];
  const meta = { tileInfo: { rows: 256, cols: 256, origin: { x: -O, y: O }, spatialReference: { wkid: 102100 }, lods }, maxScale: 564.248588 };
  check('a standard Web Mercator cache is one the Worker can stitch', isMercatorCache(meta) && !isMercatorCache({ ...meta, tileInfo: { ...meta.tileInfo, spatialReference: { wkid: 2252 } } }));
  const tile = (r, c) => { const p = new PNG({ width: 256, height: 256 }); for (let i = 0; i < 256 * 256; i++) { p.data[i * 4] = c % 256; p.data[i * 4 + 1] = r % 256; p.data[i * 4 + 2] = 99; p.data[i * 4 + 3] = 255; } return new Uint8Array(PNG.sync.write(p)); };
  const asked = [];
  const fetcher = async (u) => { const m = u.match(/tile\/(\d+)\/(\d+)\/(\d+)/); asked.push(m[1]); return new Response(tile(+m[2], +m[3])); };
  const res = lods[1].resolution;
  /* A box of exactly 4 x 3 tiles at z20, asked at that level's pixel size. */
  const c0 = 280000, r0 = 390000, span = res * 256;
  const box = [-O + c0 * span, O - (r0 + 3) * span, -O + (c0 + 4) * span, O - r0 * span];
  const img = await stitch('https://x/MapServer', meta, box, 1024, 768, { fetcher });
  const px = (x, y) => [img.data[(y * 1024 + x) * 4], img.data[(y * 1024 + x) * 4 + 1]];
  check('the tiles land where they belong: column and row read back from the colour',
    img && JSON.stringify(px(10, 10)) === JSON.stringify([c0 % 256, r0 % 256]) && JSON.stringify(px(1000, 760)) === JSON.stringify([(c0 + 3) % 256, (r0 + 2) % 256]),
    JSON.stringify([px(10, 10), px(1000, 760)]));
  check('at the finest level, not a coarser one', asked.every((l) => l === '20'), asked.slice(0, 3).join());
  const png = await encodePng(img);
  const back = PNG.sync.read(Buffer.from(png));
  check('and handed back as a PNG that reads back pixel for pixel', back.width === 1024 && back.data[0] === img.data[0] && back.data[(767 * 1024 + 1023) * 4 + 1] === img.data[(767 * 1024 + 1023) * 4 + 1]);
  const url = new URL(countyExportUrl({ url: 'https://x/MapServer', id: 9, tiled: true, selfOrigin: 'https://lawnmap.example' }, { lng: -114.36, lat: 43.68, zoom: 19.6, size: 640, height: 500 }));
  check('a detector is pointed at the Worker\'s own stitched picture of a tile cache',
    url.origin === 'https://lawnmap.example' && url.pathname === '/api/imagery' && url.searchParams.get('svc') === '9' && url.searchParams.get('provider') === 'county');
}

/* A MAP MADE ON A COUNTY PHOTO KEEPS IT (owner, 2026-10-02). */
{
  const { testDb } = await import('./d1.js');
  const { storeCountyImage, countyPicture, shiftedBbox } = await import('../worker/src/county-picture.js');
  const { captureFrame, imagePixels: px, imageHeightPixels: pxH } = await import('../worker/src/imagery.js');
  const DB = testDb();
  await DB.prepare(`INSERT INTO county_services (id, url, type, title, year, native_cm, west, south, east, north, max_px, export_ok, tile_merc)
    VALUES (7, 'https://gis.example/arcgis/rest/services/Ortho2025/ImageServer', 'ImageServer', 'Ortho2025', 2025, 7.5,
            -86, 42, -85, 43, 4096, 1, 0)`).run();
  const frame = { lng: -85.5, lat: 42.5, zoom: 19, size: 640, height: 480 };
  const shapes = JSON.stringify([{ type: 'Polygon', coordinates: [[[-85.5, 42.5], [-85.4999, 42.5], [-85.4999, 42.5001], [-85.5, 42.5]]] }]);
  await DB.prepare(`INSERT INTO corpus (id, at, created_at, lng, lat, provider, hand_edited, square_feet, frame, shapes, not_lawn)
    VALUES ('m1', '2026-10-02', '2026-10-02', -85.5, 42.5, 'county', 0, 4000, ?1, ?2, '[]')`).bind(JSON.stringify(frame), shapes).run();
  const asked = [];
  const fetcher = async (u) => {
    asked.push(String(u));
    const q = new URL(String(u)).searchParams; const [w, h] = q.get('size').split(',').map(Number);
    const png = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) { png.data[i * 4] = 40; png.data[i * 4 + 1] = 160; png.data[i * 4 + 2] = 60; png.data[i * 4 + 3] = 255; }
    return new Response(PNG.sync.write(png), { headers: { 'content-type': 'image/png' } });
  };
  const put = [];
  const env = { DB, CORPUS: { put: async (k, v) => put.push([k, v]) } };
  const row = { id: 'm1', provider: 'county', frame };
  const got = await storeCountyImage(env, row, { svcId: 7, align: { east: 1, north: -0.5, scale: 1 }, fetcher });
  const shot = captureFrame(frame);
  check('a county-photo map banks the county photo at the size a Mapbox capture would be',
    got.ok && got.W === px(shot.frame) && got.H === pxH(shot.frame), JSON.stringify(got));
  const saved = PNG.sync.read(Buffer.from(put[0]?.[1] || []));
  check('the file is that size, under maps/county/', put[0]?.[0] === 'maps/county/m1.png'
    && saved.width === got.W && saved.height === got.H, `${put[0]?.[0]} ${saved.width}x${saved.height}`);
  const c = await DB.prepare('SELECT image_key, image_provider, image_frame FROM corpus WHERE id = ?1').bind('m1').first();
  check('it IS the map\'s photo: no Mapbox one beside it, nor a second record',
    c.image_key === 'maps/county/m1.png' && c.image_provider === 'county'
      && c.image_frame === JSON.stringify(shot.frame) && put.length === 1
      && !(await DB.prepare('SELECT 1 FROM county_imagery WHERE id = ?1').bind('m1').first()), JSON.stringify(c));
  const bbox = new URL(asked[0]).searchParams.get('bbox').split(',').map(Number);
  const want = shiftedBbox(frameBbox3857(shot.frame), 1, -0.5, 1, shot.frame.lat);
  check('and the picture is of what was shown: the box moved by the editor\'s alignment',
    bbox.every((v, i) => Math.abs(v - want[i]) < 1e-6) && Math.abs(bbox[0] - frameBbox3857(shot.frame)[0]) > 1,
    `${bbox} vs ${want}`);
  check('a Mapbox map does nothing', (await storeCountyImage(env, { ...row, provider: 'mapbox' }, { svcId: 7, fetcher })).ok === false);
  check('nor an unknown service', (await storeCountyImage(env, row, { svcId: 999, fetcher })).reason === 'no-service');
  /* The dispatcher: county maps with a service get the county photo, others Mapbox. */
  const { storeMapPhoto } = await import('../worker/src/county-picture.js');
  const before = put.length;
  const viaMapbox = await storeMapPhoto({ ...env, MAPBOX_TOKEN: null }, { ...row, provider: 'mapbox' }, {});
  check('a Mapbox map still goes the Mapbox way', viaMapbox.reason === 'no-token' && put.length === before, JSON.stringify(viaMapbox));
  /* Through the save path, with the line-up as the editor sends it (owner,
     2026-10-04: the stored photo ignored it, so the card showed the outlines
     off the photo they were drawn on). */
  asked.length = 0;
  const viaSave = await storeMapPhoto(env, row, { countySvc: 7, countyAlign: { east: 1, north: -0.5, scale: 1, source: 'person' } }, { fetcher });
  const saveBox = asked[0] ? new URL(asked[0]).searchParams.get('bbox').split(',').map(Number) : [];
  check('the finish banks the photo moved by the editor\'s line-up, not as delivered',
    viaSave.ok && saveBox.length === 4 && saveBox.every((v, i) => Math.abs(v - want[i]) < 1e-6), `${saveBox} vs ${want}`);
  const small = await countyPicture({ url: 'https://gis.example/x/ImageServer', type: 'ImageServer', maxPx: 100 }, frame, { W: 300, H: 200, fetcher });
  check('a service that draws smaller is stretched to the size asked', small?.width === 300 && small?.height === 200);
}

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
