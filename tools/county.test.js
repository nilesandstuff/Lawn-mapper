/**
 * County photos: the verdict the API stores (worker/src/county.js) and the
 * compare page's filters and projection (public/county.js).
 *   node tools/county.test.js
 */
import { cleanCountyReview, cleanCountyOutlines, MAX_NUDGE_M, countyServiceAt, countyServiceById, MAX_SERVICE_SQ_DEG } from '../worker/src/county.js';
import { decodePng, looksLikePhoto } from '../worker/src/png-probe.js';
import { probeService } from '../worker/src/county.js';
import { stitch, encodePng, isMercatorCache } from '../worker/src/tile-mosaic.js';
import { PNG } from 'pngjs';
import { providerCatalogue, imageryUrl, detectionProvider, countyExportUrl, frameBbox3857 } from '../worker/src/imagery.js';
import { FILTERS, shown, stepIn, doubtful, pathFor, polygonsOf, editHref } from '../public/county.js';
import { lngLatToFramePx } from '../public/lib/mercator.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

check('a verdict of ok with a nudge is kept, to the centimetre',
  JSON.stringify(cleanCountyReview({ review: 'ok', east: 0.123, north: -0.5 })) === JSON.stringify({ review: 'ok', east: 0.12, north: -0.5 }));
check('off and null are verdicts too',
  cleanCountyReview({ review: 'off' })?.review === 'off' && cleanCountyReview({ review: null })?.review === null);
check('anything else is refused', cleanCountyReview({ review: 'maybe' }) === null && cleanCountyReview({ review: 'ok', east: 'x' }) === null);
check(`a nudge is held at ${MAX_NUDGE_M} m`, cleanCountyReview({ review: 'ok', east: 50, north: -50 }).east === MAX_NUDGE_M);

const list = [
  { id: 'a', review: null, fit: 0.6, residual_m: 0.05, east: 1, north: 0 },
  { id: 'b', review: 'ok', fit: 0.6, residual_m: 0.05, east: 1, north: 0 },
  { id: 'c', review: null, fit: 0.2, residual_m: 0.05, east: 1, north: 0 },
  { id: 'd', review: 'off', fit: 0.6, residual_m: 0.6, east: 1, north: 0 },
];
check('to check: the unjudged', JSON.stringify(shown(list, 'todo')) === '[0,2]');
check('doubtful: unjudged with a weak fit', JSON.stringify(shown(list, 'doubtful')) === '[2]' && doubtful(list[3]));
check('lines up / do not use', JSON.stringify(shown(list, 'ok')) === '[1]' && JSON.stringify(shown(list, 'off')) === '[3]');
check('stepping wraps within the filter', stepIn(list, 'todo', 2, 1) === 0 && stepIn(list, 'todo', 0, -1) === 2);
check('every filter is a function', Object.values(FILTERS).every((f) => typeof f === 'function'));

/* The outline is projected exactly as training rasterises it: lngLatToFramePx
   against the map's frame and the photo's own pixels. */
const frame = { lng: -85.86, lat: 42.87, zoom: 19.5, size: 640, height: 640 };
const ring = [[-85.8601, 42.8701], [-85.8599, 42.8701], [-85.8599, 42.8699], [-85.8601, 42.8701]];
const d = pathFor([ring], frame, 1280, 1280);
const [x0, y0] = lngLatToFramePx(frame, ring[0], 1280, 1280);
check('outlines use the training projection', d.startsWith(`M${x0.toFixed(1)},${y0.toFixed(1)}`), d.slice(0, 30));
check('multipolygons draw every part', polygonsOf({ type: 'MultiPolygon', coordinates: [[ring], [ring]] }).length === 2);

/* Measured by lib/register.js: doubtful unless it was sure AND the banked file
   measures within 10 cm of Mapbox. */
check('measured and landed is not doubtful', !doubtful({ reg_confident: 1, residual_m: 0.03 }));
check('not sure is doubtful, whatever else', doubtful({ reg_confident: 0, residual_m: 0.01, fit: 0.9 }));
check('sure but the banked file is off, or not measurable, is doubtful',
  doubtful({ reg_confident: 1, residual_m: 0.4 }) && doubtful({ reg_confident: 1, residual_m: null }));
check('Edit outlines opens the editor on the county photo and comes back',
  editHref('a b:c') === '/#review=a%20b%3Ac&photo=county&back=county');

/* Outlines saved from the editor on a county photo. */
const sq = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const kept = cleanCountyOutlines({ shapes: [{ geometry: sq, properties: { inferred: true, junk: 1 } }], notLawn: [sq] });
check('outlines are cleaned as a finished map\'s are, inferred flag and all',
  kept && JSON.parse(kept.shapes)[0].properties.inferred === true && !('junk' in JSON.parse(kept.shapes)[0].properties)
  && JSON.parse(kept.notLawn).length === 1, JSON.stringify(kept));
check('not-lawn alone is a set of outlines', cleanCountyOutlines({ shapes: [], notLawn: [sq] })?.shapes === '[]');
check('nothing at all is refused', cleanCountyOutlines({ shapes: [], notLawn: [] }) === null && cleanCountyOutlines({}) === null);

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
    && /ORDER BY COALESCE\(year, 0\) DESC, \(east - west\) \* \(north - south\) ASC/.test(seen[0][0]), JSON.stringify(at));
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
  check('a service is asked for 32 px over the spot and judged on them',
    await probeService({ url: 'https://x/ImageServer', type: 'ImageServer' }, -85.6, 42.9, { fetcher: answer(png(ground)) }) === true
    && await probeService({ url: 'https://x/MapServer', type: 'MapServer' }, -85.6, 42.9, { fetcher: answer(png(() => [0, 0, 0, 0])) }) === false);
  check('and one that does not answer is "not known", not "no"',
    await probeService({ url: 'https://x/ImageServer', type: 'ImageServer' }, -85.6, 42.9, { fetcher: async () => { throw new Error('timeout'); } }) === null);
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
  const small = await countyPicture({ url: 'https://gis.example/x/ImageServer', type: 'ImageServer', maxPx: 100 }, frame, { W: 300, H: 200, fetcher });
  check('a service that draws smaller is stretched to the size asked', small?.width === 300 && small?.height === 200);
}

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
