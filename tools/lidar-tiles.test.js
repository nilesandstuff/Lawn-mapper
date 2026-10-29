/**
 * USGS's tile-only lidar for the pages (public/lib/lidar-tiles.js,
 * worker/src/lidar-tiles.js, the pointsFromServer hook in the readers).
 *
 *   node tools/lidar-tiles.test.js
 */
import { readFileSync } from 'node:fs';
import {
  YEAR_MS, tileSets, tileClouds, withTiles, parseBox, tilesOf, tilesQuery, tnmUrl, pickNewest, areaAround, AREA_HALF_M,
} from '../public/lib/lidar-tiles.js';
import { addTileClouds, handleLidarTiles, tilesUrl, tilesEnabled } from '../worker/src/lidar-tiles.js';
import { warmUrl, warmLidar, handleLidarWarm } from '../worker/src/lidar-warm.js';
import { pointsFromServer, pointsIn } from '../public/shade/ept.js';
import { pointsIn as waterPointsIn } from '../water/lib/ept.js';
import { nodeIo } from '../water/lib/node-io.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failed++;
};

const DAY = 86400000;
const T2018 = Date.UTC(2018, 9, 1), T2024 = Date.UTC(2024, 7, 27), T2019 = Date.UTC(2019, 3, 1);
const gaps = { workunit: 'ID_SouthernGaps_2_D23', project: 'ID_SouthernGaps_D23', ql: 'QL 1', start: Date.UTC(2023, 8, 12), end: T2024, epoch: 2024.1 };
const old = { workunit: 'ID_SouthernID_13_2018', project: 'ID_SouthernID_2018_D19', ql: 'QL 2', start: Date.UTC(2018, 5, 1), end: T2018, epoch: 2018.6 };
const base = 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/ID_SouthernGaps_D23/ID_SouthernGaps_2_D23/LAZ/';
const items = [
  { downloadLazURL: `${base}USGS_LPC_ID_SouthernGaps_D23_7110_8430.laz`, sizeInBytes: 92e6 },
  { downloadLazURL: `${base}USGS_LPC_ID_SouthernGaps_D23_7110_8440.laz`, sizeInBytes: 40e6 },
  { downloadLazURL: `${base}USGS_LPC_ID_SouthernGaps_D23_7110_8430.laz`, sizeInBytes: 92e6 }, // listed twice
  { downloadURL: 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/ID_SouthernID_2018_D19/ID_SouthernID_13_2018/LAZ/x.laz', sizeInBytes: 1e6 },
];

/* ----------------------------------------------------------- pure parts */
{
  const sets = tileSets(items, [gaps, old], ['ID_SouthernID_13_2018']);
  check('a flight with no octree is offered as its tiles, each once, with its work unit', sets.length === 1 && sets[0].tiles.length === 2 && Math.round(sets[0].mb) === 132 && sets[0].record === gaps, JSON.stringify(sets));
  const clouds = tileClouds(sets);
  check('a tile cloud looks like an octree cloud to the pages', clouds[0].kind === 'tiles' && clouds[0].name === gaps.workunit && clouds[0].confirmed && clouds[0].year === 2024 && clouds[0].epoch === 2024.1 && clouds[0].unit === gaps && clouds[0].mb === 132, JSON.stringify(clouds[0]));
  check('its url is the Worker\'s route naming the tiles', clouds[0].url.startsWith('/api/lidar/tiles?unit=ID_SouthernGaps_2_D23&tiles=') && decodeURIComponent(clouds[0].url).includes('7110_8440.laz'), clouds[0].url);
  check('the page adds its box and a spacing', tilesQuery(clouds[0].url, [1.234, 2, 3, 4.006], 1.8).endsWith('&box=1.23,2.00,3.00,4.01&spacing=1.8'));
  check('no spacing, no spacing', !tilesQuery(clouds[0].url, [1, 2, 3, 4]).includes('spacing'));

  const octree2018 = { name: 'ID_SouthernID_13_2018', url: 'https://s3/ept.json', year: 2018, density: 0.05, unit: null, epoch: 2018.5, confirmed: false };
  const ranked = { clouds: [octree2018], notOnAws: [gaps] };
  const w = withTiles(ranked, clouds);
  check('KETCHUM: the tiles come first when no octree is confirmed, and the unit leaves notOnAws', w.clouds[0].kind === 'tiles' && w.clouds[1] === octree2018 && w.notOnAws.length === 0, JSON.stringify(w.clouds.map((c) => c.name)));
  const confirmed2018 = { ...octree2018, unit: old, confirmed: true };
  const w2 = withTiles({ clouds: [confirmed2018], notOnAws: [gaps] }, clouds);
  check('over a year newer than the newest confirmed octree: the tiles first', w2.clouds[0].kind === 'tiles' && w2.clouds[1] === confirmed2018);
  const near = tileClouds(tileSets(items, [{ ...gaps, end: T2019, epoch: 2019.2 }, old], ['ID_SouthernID_13_2018']));
  const w3 = withTiles({ clouds: [confirmed2018, { ...octree2018, name: 'box-only', confirmed: false }], notOnAws: [gaps] }, near);
  check('under a year newer: after the confirmed octrees, before the box-only ones (a hole falls through to them)', w3.clouds.map((c) => c.kind === 'tiles' ? 'T' : c.confirmed ? 'C' : 'B').join('') === 'CTB', w3.clouds.map((c) => c.name).join(','));
  check('no tiles: the answer as it was', withTiles(ranked, []).clouds === ranked.clouds && withTiles(ranked, []).notOnAws.length === 1);
  check('pickNewest (the detector\'s rule) still reads the tiles when over a year newer', pickNewest([{ ...confirmed2018, end: T2018 }], sets)?.kind === 'tiles' && pickNewest([{ ...confirmed2018, end: T2024 - 100 * DAY }], sets)?.kind === 'octree');
  check('YEAR_MS is a year', Math.abs(YEAR_MS / DAY - 365.25) < 1e-9);
}
{
  check('a box is w,s,e,n in mercator metres, at most 1.5 km across', JSON.stringify(parseBox('-12733000,5415000,-12732900,5415100')) === '[-12733000,5415000,-12732900,5415100]'
    && parseBox('1,2,3') === null && parseBox('3,2,1,4') === null && parseBox('0,0,1600,10') === null && parseBox('a,b,c,d') === null && parseBox('0,0,10,10') !== null);
  const p = new URLSearchParams({ tiles: `${base}a.laz,${base}b_2.laz` });
  check('only USGS\'s staged LPC urls are tiles', tilesOf(p)?.length === 2
    && tilesOf(new URLSearchParams({ tiles: 'https://evil.example/x.laz' })) === null
    && tilesOf(new URLSearchParams({ tiles: `${base}a.laz;rm` })) === null
    && tilesOf(new URLSearchParams({})) === null
    && tilesOf(new URLSearchParams({ tiles: Array.from({ length: 13 }, (_, i) => `${base}t${i}.laz`).join(',') })) === null);
  const u = new URL(tnmUrl(-114.38, 43.72));
  const bb = u.searchParams.get('bbox').split(',').map(Number);
  check('the TNM query is a box about 500 m across round the point', u.origin + u.pathname === 'https://tnmaccess.nationalmap.gov/api/v1/products' && Math.abs((bb[3] - bb[1]) * 111320 - 500) < 2 && bb[0] < -114.38 && bb[2] > -114.38 && u.searchParams.get('datasets') === 'Lidar Point Cloud (LPC)');
}

/* ------------------------------------------------------- the Worker's part */
const wesm = { features: [{ attributes: { workunit: gaps.workunit, project: gaps.project, ql: gaps.ql, collect_start: gaps.start, collect_end: gaps.end } }] };
{
  let asked = 0;
  const fetchImpl = async (url) => { asked++; return { ok: true, json: async () => ({ items }) }; };
  const ranked = { clouds: [{ name: 'ID_SouthernID_13_2018', confirmed: false, unit: null }], notOnAws: [{ workunit: gaps.workunit }] };
  const out = await addTileClouds(ranked, wesm, -114.38, 43.72, { fetchImpl });
  check('addTileClouds asks the TNM API and puts the tiles first at Ketchum', asked === 1 && out.clouds[0].kind === 'tiles' && out.clouds[0].tiles.length === 2 && out.notOnAws.length === 0, JSON.stringify(out.clouds.map((c) => c.name)));
  asked = 0;
  const same = await addTileClouds({ clouds: ranked.clouds, notOnAws: [] }, wesm, -114.38, 43.72, { fetchImpl });
  check('nothing is asked when every flight has an octree', asked === 0 && same.clouds === ranked.clouds);
  const down = await addTileClouds(ranked, wesm, -114.38, 43.72, { fetchImpl: async () => { throw new Error('timeout'); } });
  check('the TNM API not answering leaves the answer as it was', down === ranked);
  const refused = await addTileClouds(ranked, wesm, -114.38, 43.72, { fetchImpl: async () => ({ ok: false, status: 503 }) });
  check('... or refusing', refused === ranked);
}
{
  check('the tiles endpoint sits beside start', tilesUrl({ ALPHA_URL: 'https://ws--lawn-mapper-alpha-start.modal.run' }) === 'https://ws--lawn-mapper-alpha-lidar-tiles.modal.run'
    && tilesUrl({ ALPHA_URL: 'https://x', ALPHA_TILES_URL: 'https://y' }) === 'https://y' && tilesUrl({}) === null && tilesUrl({ ALPHA_URL: 'https://odd.example/run' }) === null);
  check('enabled only with the server and its token', tilesEnabled({ ALPHA_URL: 'https://ws--lawn-mapper-alpha-start.modal.run', ALPHA_TOKEN: 't' }) && !tilesEnabled({ ALPHA_URL: 'https://ws--lawn-mapper-alpha-start.modal.run' }));
}
{
  const json = (data, status) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://lawn.example' } });
  const env = { ALPHA_URL: 'https://ws--lawn-mapper-alpha-start.modal.run', ALPHA_TOKEN: 'secret' };
  const req = { method: 'GET' };
  const route = (q) => new URL(`https://lawn.example/api/lidar/tiles?${q}`);
  const good = `tiles=${encodeURIComponent(`${base}a.laz,${base}b.laz`)}&box=-12733000,5415000,-12732900,5415100`;
  let r = await handleLidarTiles(req, route('tiles=https://evil.example/x.laz&box=0,0,1,1'), env, 'https://lawn.example', null, json);
  check('a foreign tile url is refused', r.status === 400);
  r = await handleLidarTiles(req, route(`tiles=${encodeURIComponent(`${base}a.laz`)}&box=0,0,5000,1`), env, 'https://lawn.example', null, json);
  check('a box too wide is refused', r.status === 400);
  r = await handleLidarTiles(req, route(good), {}, 'https://lawn.example', null, json);
  check('without the model server the route is off (503), so the pages fall back to the octrees', r.status === 503);
  r = await handleLidarTiles({ method: 'POST' }, route(good), env, 'https://lawn.example', null, json);
  check('GET only', r.status === 405);

  const calls = [];
  const laz = readFileSync('tools/fixtures/tile-crop.laz');
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (calls.length === 1) return new Response(JSON.stringify({ status: 'fetching', missing: ['a.laz'], started: true }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    return new Response(laz, { status: 200, headers: { 'Content-Type': 'application/vnd.laszip' } });
  };
  r = await handleLidarTiles(req, route(`${good}&spacing=1.8`), env, 'https://lawn.example', null, json, { fetchImpl });
  const body = await r.json();
  check('202 from the server is 202 to the page, with its words', r.status === 202 && body.status === 'fetching' && body.missing[0] === 'a.laz');
  const c = calls[0];
  check('the server is asked at the tiles endpoint with the token, the tiles, the box and the spacing',
    c.url.origin === 'https://ws--lawn-mapper-alpha-lidar-tiles.modal.run' && c.init.headers.authorization === 'Bearer secret'
    && c.url.searchParams.get('tiles') === `${base}a.laz,${base}b.laz` && c.url.searchParams.get('box') === '-12733000,5415000,-12732900,5415100' && c.url.searchParams.get('spacing') === '1.8', c.url.href);
  r = await handleLidarTiles(req, route(good), env, 'https://lawn.example', null, json, { fetchImpl });
  const bytes = new Uint8Array(await r.arrayBuffer());
  check('the LAZ comes through as bytes, cacheable a week, with CORS', r.status === 200 && bytes.length === laz.length && bytes[0] === 0x4c && bytes[1] === 0x41 && bytes[2] === 0x53
    && r.headers.get('Content-Type') === 'application/vnd.laszip' && r.headers.get('Cache-Control')?.includes('604800') && r.headers.get('Access-Control-Allow-Origin') === 'https://lawn.example' && r.headers.get('X-Lidar-Tiles') === '2');
  r = await handleLidarTiles(req, route(good), env, 'https://lawn.example', null, json, { fetchImpl: async () => new Response('boom', { status: 500 }) });
  check('a server error is 502 with its words', r.status === 502 && (await r.json()).detail === 'boom');
}

/* ------------------------------------------------- the pages' reader hook */
{
  const io = nodeIo();
  const laz = readFileSync('tools/fixtures/tile-crop.laz');
  const buf = laz.buffer.slice(laz.byteOffset, laz.byteOffset + laz.byteLength);
  const seen = [];
  let n = 0;
  const fetchImpl = async (url) => {
    seen.push(url);
    n++;
    if (n === 1) return new Response(JSON.stringify({ status: 'fetching', missing: ['a.laz'] }), { status: 202 });
    return new Response(buf, { status: 200 });
  };
  const notes = [];
  const url = '/api/lidar/tiles?unit=U&tiles=x';
  const box = [-12733000, 5415000, -12732950, 5415100];
  const got = await pointsFromServer(url, box, io, { progress: (d, t, more) => notes.push([d, t, more]), fetchImpl, waitMs: 1 });
  const inBox = [...Array(got.cols.n).keys()].every((i) => got.cols.x[i] >= box[0] && got.cols.x[i] <= box[2]);
  check('pointsFromServer waits out a 202, then decodes the LAZ and crops it to the box', n === 2 && got.cols.n > 0 && got.cols.n < 60 && inBox && got.ept.srs.horizontal === '3857' && got.nodes === 1, `n=${got.cols.n}`);
  check('the page is told it is fetching, then that it is done', notes[0][2]?.fetching?.status === 'fetching' && notes.at(-1)[0] === 1 && notes.at(-1)[1] === 1);
  check('the box rides on the url', seen[0] === `${url}&box=-12733000.00,5415000.00,-12732950.00,5415100.00` && seen[1] === seen[0]);
  check('the flight\'s clock gives flown, as from an octree', got.flown && new Date(got.flown.start).getUTCFullYear() === 2022 && got.flown.mids.length === 1, JSON.stringify(got.flown));
  const spaced = await pointsFromServer(url, box, io, { fetchImpl: async (u) => { seen.push(u); return new Response(buf, { status: 200 }); }, spacingM: 1.8 });
  check('a spacing is passed to the server', seen.at(-1).endsWith('&spacing=1.8') && spaced.cols.n > 0);
  const bad = await pointsFromServer(url, box, io, { fetchImpl: async () => new Response(JSON.stringify({ error: 'The lidar tile reader is off: no model server is configured' }), { status: 503 }) }).catch((e) => e);
  check('503 throws the route\'s own words (the page says so and tries the next cloud)', bad instanceof Error && /no model server/.test(bad.message));
  const never = await pointsFromServer(url, box, io, { fetchImpl: async () => new Response('{}', { status: 202 }), waitMs: 1, tries: 3 }).catch((e) => e);
  check('a fetch that never finishes gives up with a reason', never instanceof Error && /still being fetched/.test(never.message));

  /* The hook in both readers: a url that is not an ept.json goes to the server; an ept.json walks the octree as before. */
  globalThis.fetch = async (u) => (String(u).includes('/api/lidar/tiles') ? new Response(buf, { status: 200 }) : new Response('nope', { status: 500 }));
  const viaShade = await pointsIn(url, box, io);
  const viaWater = await waterPointsIn(url, box, io, { spacingM: 0 });
  check('shade\'s pointsIn and water\'s both take the server path for a route url', viaShade.cols.n === got.cols.n && viaWater.cols.n === got.cols.n);
  let walked = false;
  const octIo = { ...io, getJson: async () => { walked = true; throw new Error('stop here'); } };
  await pointsIn('https://s3/ept.json', box, octIo).catch(() => {});
  check('an ept.json still walks the octree', walked);
}

/* THE ADDRESS'S WARM-UP (2026-10-29): asked of the server only for a tile flight, with the area round the point. */
{
  const [w, s, e, n] = areaAround(-114.38468, 43.71751);
  const k = Math.cos((43.71751 * Math.PI) / 180);
  check('the area is AREA_HALF_M ground metres each way', Math.abs((e - w) * k - 2 * AREA_HALF_M) < 0.01 && Math.abs((n - s) * k - 2 * AREA_HALF_M) < 0.01 && e - w <= 1500, `${((e - w) * k).toFixed(2)} m`);
  const env = { ALPHA_URL: 'https://ws--lawn-mapper-alpha-start.modal.run', ALPHA_TOKEN: 't' };
  check('the warm endpoint sits beside the tile one', warmUrl(env) === 'https://ws--lawn-mapper-alpha-lidar-warm.modal.run', warmUrl(env));
  check('and an explicit one wins', warmUrl({ ...env, ALPHA_WARM_URL: 'https://x.modal.run' }) === 'https://x.modal.run');
  const tiles = ['https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/A/LAZ/USGS_LPC_A_1.laz', 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/A/LAZ/USGS_LPC_A_2.laz'];
  const sent = [];
  const fetchImpl = async (u, init) => { sent.push({ u: String(u), auth: init?.headers?.authorization }); return new Response(JSON.stringify({ status: 'warming', started: true }), { status: 200 }); };
  const tileFirst = async () => ({ clouds: [{ kind: 'tiles', name: 'ID_SouthernGaps_2_D23', tiles, mb: 126 }, { kind: 'ept', name: 'old' }] });
  const got = await warmLidar(-114.38468, 43.71751, env, { fetchImpl, find: tileFirst });
  const q = sent[0] ? new URL(sent[0].u).searchParams : null;
  check('a tile flight first is warmed: its tiles and the area, with the token', got.warmed && sent.length === 1 && q.get('tiles') === tiles.join(',') && q.get('box').split(',').length === 4 && sent[0].auth === 'Bearer t', JSON.stringify(got));
  sent.length = 0;
  const octreeFirst = async () => ({ clouds: [{ kind: 'ept', name: 'new octree' }, { kind: 'tiles', tiles, name: 'older tiles' }] });
  const no = await warmLidar(-114.38, 43.72, env, { fetchImpl, find: octreeFirst });
  check('nothing is asked when the newest flight is an octree', !no.warmed && sent.length === 0 && /octree/.test(no.why));
  const none = await warmLidar(-114.38, 43.72, {}, { fetchImpl, find: tileFirst });
  check('nor without a model server', !none.warmed && sent.length === 0);
  const json = (b, st) => new Response(JSON.stringify(b), { status: st });
  const bad = await handleLidarWarm(new Request('https://x/api/lidar/warm?lng=abc&lat=1'), new URL('https://x/api/lidar/warm?lng=abc&lat=1'), env, '*', null, json, { fetchImpl, find: tileFirst });
  check('a point that is not one is refused', bad.status === 400);
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const u = new URL('https://x/api/lidar/warm?lng=-114.38468&lat=43.71751');
  const quick = await handleLidarWarm(new Request(u), u, env, '*', ctx, json, { fetchImpl, find: tileFirst });
  await Promise.all(waits);
  check('the app is answered at once and the warm-up runs after', quick.status === 202 && waits.length === 1 && sent.length === 1);
}

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
