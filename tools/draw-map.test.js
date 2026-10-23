/**
 * The pure parts of tools/draw-map.mjs: the point asked, the saved map it
 * names, the mask resampling and the press built for it.
 *
 *   node tools/draw-map.test.js
 */

import { parseLngLat, nearestMap, nearest, resizeRgba, pressFor, evalEntry, svcOfRow, mapsOfRows } from './draw-map.mjs';
import { runKeys } from './run-folder.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

{
  const p = parseLngLat(' -85.70712, 42.83547 ');
  check('reads "lng,lat" with spaces', p && p[0] === -85.70712 && p[1] === 42.83547);
  check('refuses words, a lone number and an impossible latitude',
    parseLngLat('byron center') === null && parseLngLat('42.8') === null && parseLngLat('-85.7,142.8') === null);
}

{
  const maps = [
    { lng: -85.70712, lat: 42.83547, at: 'a' },
    { lng: -85.70800, lat: 42.83547, at: 'b' },   // about 72 m west
    { lng: -85.60000, lat: 42.83547, at: 'c' },   // kilometres away
    { lng: null, lat: null, at: 'd' },
  ];
  const hit = nearestMap(maps, [-85.70720, 42.83547]);
  check('the nearest saved map within 150 m is chosen', hit?.map.at === 'a' && hit.d < 10, `got ${hit?.map.at} at ${hit?.d?.toFixed(1)} m`);
  check('nothing within 150 m means null', nearestMap(maps, [-85.65, 42.83547]) === null);
  check('a map without coordinates is skipped, not matched', nearestMap([maps[3]], [0, 0]) === null);
}

{
  const m = new Uint8Array([1, 0, 0, 1]);          // 2x2: diagonal
  const up = nearest(m, 2, 2, 4, 4);
  check('nearest resampling keeps each source cell as a 2x2 block',
    up[0] === 1 && up[1] === 1 && up[2] === 0 && up[5] === 1 && up[10] === 1 && up[15] === 1 && up[3] === 0);
  const down = nearest(up, 4, 4, 2, 2);
  check('and comes back to itself', Array.from(down).join('') === '1001');
  const rgba = resizeRgba(new Uint8Array([10, 20, 30, 255, 50, 60, 70, 255]), 2, 1, 4, 1, 1);
  check('the photo resize averages the box', rgba[0] === 30 && rgba[1] === 40 && rgba[2] === 50 && rgba[3] === 255);
}

{
  const map = {
    lng: -85.70712, lat: 42.83547, provider: 'county', countySvc: 363,
    frame: { lng: -85.7057, lat: 42.8358, zoom: 16.31, size: 604, height: 637 },
    parcel: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    naipAlign: { east: 1, north: 2 },
  };
  const press = pressFor(map, 'https://lawnmap.example.com');
  check('the county photo is asked of the site by its service id',
    press.imageUrl.startsWith('https://lawnmap.example.com/api/imagery?') && press.imageUrl.includes('provider=county') && press.imageUrl.includes('svc=363'));
  /* 390 m across: more than one request serves at 10 cm, so the plan is a
     grid of tiles the server stitches (the fix of the photo cap, 2026-10-22),
     each inside the site's one-request limit. */
  check('a big lot is a grid of tiles at 10 cm, each inside the site\'s one-request cap',
    press.frame.zoom > map.frame.zoom && press.groundCm <= 10.01 && press.pieces > 1 && press.pieces === press.cols * press.rows
      && press.tiles.every((t) => /size=\d+/.test(t.url) && Number(t.url.match(/size=(\d+)/)[1]) <= 1280 && t.url.includes('svc=363')),
    `${press.groundCm} cm, ${press.pieces} pieces (${press.cols}x${press.rows}), frame ${press.frame.size} logical px`);
  check('the first tile is also the one-picture url, for the server\'s check', press.imageUrl === press.tiles[0].url);
  /* The database route (2026-10-23): the county's own export, not the site. */
  const svc = svcOfRow({ id: 363, url: 'https://gis.example.gov/arcgis/rest/services/Imagery/ImageServer', type: 'image', max_px: 4096, export_ok: 1, tile_merc: 0 });
  const direct = pressFor(map, 'https://lawnmap.example.com', { svc });
  check('with the service row the tiles are asked of the county export directly',
    direct.photoFrom === 'the county export' && direct.tiles.every((t) => t.url.startsWith('https://gis.example.gov/')) && direct.pieces === press.pieces);
  const mbd = pressFor({ ...map, provider: 'mapbox', countySvc: null }, 'https://lawnmap.example.com', { mapboxToken: 'pk.test' });
  check('and a Mapbox map of Mapbox with the token', mbd.photoFrom === 'Mapbox' && mbd.tiles.every((t) => t.url.includes('mapbox.com') && t.url.includes('pk.test')));
  const rows = mapsOfRows([{ key: 'k1', lng: -85.7, lat: 42.8, payload: JSON.stringify({ frame: { lng: -85.7, lat: 42.8, zoom: 18, size: 640 }, provider: 'county', lng: -85.70001, lat: 42.80001 }), updated_at: '2026-10-22T17:45:50Z' },
    { key: 'k2', lng: -80, lat: 40, payload: '{broken', updated_at: 'x' }]);
  check('database rows become the API\'s records, the payload first, the columns as fallback',
    rows[0].id === 'k1' && rows[0].lng === -85.70001 && rows[0].provider === 'county' && rows[1].lng === -80 && rows[1].at === 'x');
  const small = pressFor({ ...map, frame: { lng: -85.7057, lat: 42.8358, zoom: 19, size: 640, height: 640 } }, 'https://lawnmap.example.com');
  check('a small lot is one picture, as every press before', small.pieces === 1 && small.tiles === undefined);
  check('the property line travels as its geometry', press.parcel.type === 'Polygon');
  check('NAIP\'s Mapbox alignment is not applied to a county photo', press.naipAlign === null);
  const mb = pressFor({ ...map, provider: 'mapbox', countySvc: null }, 'https://lawnmap.example.com');
  check('a Mapbox map asks for Mapbox and keeps its alignment', mb.imageUrl.includes('provider=mapbox') && mb.naipAlign.east === 1);

  const keys = runKeys('2026-10-22-1200-edt');
  const e = evalEntry({
    keys, n: 104, map, prep: { w: 1024, h: 900, mpp: 0.38, span: 390 }, rec: { lidar: true, naip: false, seconds: { backbone: 600 } },
    trace: { pieces: 3, vertices: 40, droppedPieces: 2, droppedPx: 10, renderPx: 1280, renderPy: 1125 },
    lawnCells: 1000, county: 'Kent County', provider: 'county', windows: 36,
  });
  check('the entry is marked drawn only, scoreless, and named by position', e.evalOnly === true && e.errorPct === null && e.key === 'runs/2026-10-22-1200-edt/104.png');
  check('and names no address', !JSON.stringify(e).toLowerCase().includes('drive') && e.id === '-85.70712,42.83547:eval:draw');
  check('its lawn area comes from the cells and the grid scale', e.squareFeet === Math.round((1000 * 0.38 * 0.38) / 0.09290304));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
