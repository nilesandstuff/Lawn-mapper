/**
 * Checks for the water map's layers: worker/src/water-layers.js (the route and
 * its national sources) and tools/water-layers.js (the county catalogue).
 * No network: every service here is a stand-in.   node tools/water-layers.test.js
 */
import {
  classifyLayer, boxFrom, esriToGeoJSON, tidyAttributes, queryUrl, waterLayersAt, handleWaterLayers, NATIONAL, KINDS, MAX_SPAN_M,
} from '../worker/src/water-layers.js';
import { registryRoots, sweepOrder, extentDegrees, waterLayersOf, upsertSql, sensibleBox, rootOf } from './water-layers.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${detail}`); }
};

/* --------------------------------------------------------- what a layer is */
const P = 'esriGeometryPoint', L = 'esriGeometryPolyline', A = 'esriGeometryPolygon';
check('storm inlets, manholes and mains are what they say',
  classifyLayer('Storm Inlets', P) === 'storm_inlet' && classifyLayer('Catch Basins', P) === 'storm_inlet'
  && classifyLayer('Storm Manholes', P) === 'storm_manhole' && classifyLayer('Storm Mains (Kent Owned)', L) === 'storm_main'
  && classifyLayer('Storm_Sewer_Gravity_Main', L) === 'storm_main' && classifyLayer('Storm Laterals', L) === 'storm_main');
check('basins, districts, easements, culverts and outfalls',
  classifyLayer('Storm Detention Basins', A) === 'detention_basin' && classifyLayer('Retention Ponds', A) === 'detention_basin'
  && classifyLayer('Storm Drain Districts', A) === 'drain_district' && classifyLayer('Storm Easements (Kent Owned)', A) === 'drain_easement'
  && classifyLayer('Culverts', L) === 'culvert' && classifyLayer('Culverts', P) === 'culvert' && classifyLayer('Outfalls', P) === 'outfall');
check('lakes, streams, wetlands, flood zones and watersheds',
  classifyLayer('Lakes', A) === 'water_body' && classifyLayer('Rivers and Streams', L) === 'stream'
  && classifyLayer('Wetlands', A) === 'wetland' && classifyLayer('Flood Zones', A) === 'flood_zone'
  && classifyLayer('Watersheds', A) === 'watershed' && classifyLayer('County Drains', L) === 'open_drain');
check('the geometry has to fit: a "Lakes" point layer is not a lake', classifyLayer('Lakes', P) === null && classifyLayer('Storm Inlets', A) === null);
check('drinking water, sanitary sewers and bookkeeping are never water collection',
  classifyLayer('Water Mains', L) === null && classifyLayer('Sanitary ManHoles', P) === null && classifyLayer('Fire Hydrants', P) === null
  && classifyLayer('Inspected Storm Mains By Year', L) === null && classifyLayer('Drain_Commission_Complaints', P) === null
  && classifyLayer('2005 FEMA Flood DRAFT Layer', A) === null && classifyLayer('Water_Outside_of_Kent', A) === null);
check('every rule lands on a known kind', ['storm_inlet', 'stream', 'water_body'].every((k) => KINDS[k]));

/* ------------------------------------------------------------------ the box */
{
  const b = boxFrom({ lng: -85.6, lat: 42.9, m: 150 });
  const wide = (b[2] - b[0]) * 111320 * Math.cos((42.9 * Math.PI) / 180);
  check('a centre and a half-width make a box that wide', Array.isArray(b) && Math.abs(wide - 300) < 1, JSON.stringify(b));
  check('a box can be given straight', JSON.stringify(boxFrom({ box: '-85.601,42.899,-85.599,42.901' })) === JSON.stringify([-85.601, 42.899, -85.599, 42.901]));
  check('no point, no box', typeof boxFrom({}) === 'string' && typeof boxFrom({ box: '1,2,0,3' }) === 'string');
  check(`more than ${MAX_SPAN_M} m across is refused`, /most one answer covers/.test(String(boxFrom({ lng: -85.6, lat: 42.9, m: 700 }))));
}

/* ----------------------------------------------------------------- geometry */
check('a point', JSON.stringify(esriToGeoJSON({ x: -85.1, y: 42.2 })) === JSON.stringify({ type: 'Point', coordinates: [-85.1, 42.2] }));
check('a pipe with two runs is a multi-line', esriToGeoJSON({ paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }).type === 'MultiLineString'
  && esriToGeoJSON({ paths: [[[0, 0], [1, 1]]] }).type === 'LineString');
{
  const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];          // clockwise: ArcGIS's outer ring
  const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];               // anticlockwise: its hole
  const other = [[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]];
  const g = esriToGeoJSON({ rings: [outer, hole, other] });
  check('an outer ring keeps its hole, and a second outer ring is a second polygon',
    g.type === 'MultiPolygon' && g.coordinates.length === 2 && g.coordinates[0].length === 2 && g.coordinates[1].length === 1, JSON.stringify(g));
}
check('attributes lose ids, shapes and empties',
  JSON.stringify(tidyAttributes({ OBJECTID: 1, Shape_Length: 2, GlobalID: 'x', DIAMETER: 12, NOTE: ' ', BFE: -9999, NAME: ' Pond ' })) === JSON.stringify({ DIAMETER: 12, NAME: 'Pond' }));
check('the query asks in degrees, over the box, with the fields asked',
  /outSR=4326/.test(queryUrl('https://x/arcgis/rest/services/a/MapServer/3', [1, 2, 3, 4], { fields: ['A', 'B'] }))
  && /geometry=1%2C2%2C3%2C4/.test(queryUrl('https://x/MapServer/3/', [1, 2, 3, 4])) && /outFields=A%2CB/.test(queryUrl('https://x/MapServer/3', [1, 2, 3, 4], { fields: ['A', 'B'] })));

/* ----------------------------------------------------------- the answer */
const box = [-85.71, 42.83, -85.70, 42.84];
const fake = (handler) => async (url) => {
  const body = handler(String(url));
  if (body === 'slow') throw new Error('This operation was aborted');
  return { ok: true, json: async () => body };
};
const countyRows = [{ url: 'https://county/arcgis/rest/services/Drains/MapServer/26', kind: 'storm_inlet', title: 'Storm Inlets', source: 'Kent County, MI', county_key: 'mi-kent' }];
const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: countyRows }) }) }) } };
{
  const fetcher = fake((u) => {
    if (u.includes('county/arcgis')) return { features: [{ attributes: { OBJECTID: 1, TOP_OF_CASTING: 687 }, geometry: { x: -85.705, y: 42.835 } }] };
    if (u.includes('NFHL')) return 'slow';
    if (u.includes('Wetlands')) return { features: [{ attributes: { WETLAND_TYPE: 'Freshwater Pond' }, geometry: { rings: [[[-85.71, 42.83], [-85.71, 42.835], [-85.705, 42.835], [-85.71, 42.83]]] } }] };
    return { features: [] };
  });
  const r = await waterLayersAt(env, box, { fetcher });
  check('the county\'s inlets and the national wetland come back, labelled',
    r.layers.some((l) => l.kind === 'storm_inlet' && l.from === 'county' && l.features[0].properties.TOP_OF_CASTING === 687)
    && r.layers.some((l) => l.kind === 'wetland' && l.from === 'national'), JSON.stringify(r.layers.map((l) => [l.kind, l.from])));
  check('a layer with nothing in the box is left out', !r.layers.some((l) => l.kind === 'water_body'));
  check('a source that did not answer is named, not dropped', r.failed.length === 1 && r.failed[0].kind === 'flood_zone', JSON.stringify(r.failed));
  check('areas are listed before lines and points', r.layers.findIndex((l) => l.kind === 'wetland') < r.layers.findIndex((l) => l.kind === 'storm_inlet'));
  check('every national source names its kind and service', NATIONAL.every((n) => KINDS[n.kind] && /^https:\/\/.+\/(MapServer|FeatureServer)\/\d+$/.test(n.url)));
}
{
  const r = await waterLayersAt({}, box, { fetcher: fake(() => ({ features: [] })) });
  check('with no database, the national layers still answer', r.asked.county === 0 && r.failed.length === 0);
}

/* ------------------------------------------------------------- the route */
{
  const store = new Map();
  const cache = { match: async (k) => store.get(k.url) || null, put: async (k, res) => { store.set(k.url, res); } };
  const json = (data, status) => ({ status, data });
  let asks = 0;
  const fetcher = fake(() => { asks++; return { features: [] }; });
  const url = new URL('https://lawnmap.example/api/water/layers?lng=-85.705&lat=42.835&m=100');
  const first = await handleWaterLayers({ method: 'GET' }, url, {}, '', null, json, { fetcher, cache });
  const before = asks;
  const second = await handleWaterLayers({ method: 'GET' }, url, {}, '', null, json, { fetcher, cache });
  check('the route answers a box', first.status === 200 && Array.isArray(first.data.layers) && first.data.box.length === 4);
  check('and a second ask for the same box is the cached answer', second.data.cached === true && asks === before);
  const bad = await handleWaterLayers({ method: 'GET' }, new URL('https://x/api/water/layers'), {}, '', null, json, { fetcher, cache });
  check('no box is a 400', bad.status === 400);
  const store2 = new Map();
  const cache2 = { match: async (k) => store2.get(k.url) || null, put: async (k, res) => { store2.set(k.url, res); } };
  await handleWaterLayers({ method: 'GET' }, url, {}, '', null, json, { fetcher: fake((u) => (u.includes('NFHL') ? 'slow' : { features: [] })), cache: cache2 });
  check('an answer with a failed source is not kept', store2.size === 0);
}

/* ---------------------------------------------------------- the catalogue */
{
  const roots = registryRoots({
    a: { service: 'https://gis.a.gov/arcgis/rest/services/Parcels/MapServer', box: [-86, 42, -85, 43] },
    b: { service: 'https://gis.a.gov/arcgis/rest/services/Other/MapServer', box: [-85, 42, -84, 43] },
    c: { service: 'https://c.gov/server/rest/services/P/FeatureServer', box: [-90, 30, -89, 31], fallbacks: [{ service: 'https://c2.gov/arcgis/rest/services/Q/MapServer' }] },
  });
  check('one root per server, with every county on it', roots.length === 3 && roots.find((r) => r.root === 'https://gis.a.gov/arcgis/rest/services').keys.join() === 'a,b');
  check('a root is the /rest/services part', rootOf('https://h/agisprod/rest/services/Folder/X/MapServer') === 'https://h/agisprod/rest/services');
  const now = Date.parse('2026-10-23T00:00:00Z');
  const done = new Map([['https://c.gov/server/rest/services', '2026-10-20T00:00:00Z'], ['https://c2.gov/arcgis/rest/services', '2026-01-01T00:00:00Z']]);
  const order = sweepOrder(roots, [[-85.5, 42.5], [-85.4, 42.6]], done, now, 90);
  check('servers under saved maps go first, and one looked at this month is skipped',
    order[0].root === 'https://gis.a.gov/arcgis/rest/services' && order[0].maps === 2 && !order.some((r) => r.root === 'https://c.gov/server/rest/services')
    && order.some((r) => r.root === 'https://c2.gov/arcgis/rest/services'), JSON.stringify(order.map((r) => [r.root, r.maps])));
}
check('an extent in degrees or web mercator is read; another projection is not guessed',
  JSON.stringify(extentDegrees({ xmin: -85, ymin: 42, xmax: -84, ymax: 43, spatialReference: { wkid: 4326 } })) === '[-85,42,-84,43]'
  && Math.abs(extentDegrees({ xmin: -9462000, ymin: 5287000, xmax: -9461000, ymax: 5288000, spatialReference: { wkid: 102100 } })[0] + 85.0) < 0.1
  && extentDegrees({ xmin: 1, ymin: 2, xmax: 3, ymax: 4, spatialReference: { wkid: 2253 } }) === null);
check('a placeholder extent is not a place', !sensibleBox([-180, -90, 180, 90]) && sensibleBox([-85.8, 42.7, -85.3, 43.3]));
{
  const found = waterLayersOf('https://h/rest/services/D/MapServer', { layers: [
    { id: 17, name: 'Storm Mains', type: 'Group Layer', subLayers: [{ id: 18 }] },
    { id: 18, name: 'Storm Mains (Kent Owned)', type: 'Feature Layer', geometryType: L },
    { id: 29, name: 'Fire Hydrants', type: 'Feature Layer', geometryType: P },
    { id: 26, name: 'Storm Inlets', type: 'Feature Layer', geometryType: P },
  ] });
  check('a service\'s water layers: leaves only, hydrants out', found.map((f) => `${f.kind}:${f.url.split('/').pop()}`).join() === 'storm_main:18,storm_inlet:26', JSON.stringify(found));
}
{
  const sql = upsertSql({ url: "https://h/x/MapServer/1", kind: 'stream', title: "O'Brien Drain", ok: 1, west: -85, features: null });
  check('a row is quoted and updates in place', /'O''Brien Drain'/.test(sql) && /ON CONFLICT\(url\) DO UPDATE/.test(sql) && /NULL/.test(sql));
}

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nwater layers: ok');
