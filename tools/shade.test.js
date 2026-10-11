/**
 * The shade map's pieces (public/shade/), without the network.
 *
 *   node tools/shade.test.js
 */
import { lasHeader, makeColumns, readRecord } from '../public/shade/las.js';
import { nodeBox, walk, hierarchyReader, pointsIn, toMerc, fromMerc, mercScale } from '../public/shade/ept.js';
import { nad83Correction } from '../public/shade/datum.js';
import { rankClouds, leafSeason, nameYear } from '../public/shade/find.js';
import { gridOver, gridForFrame, gridBox, rasterise, fillGaps, resample } from '../public/shade/grid.js';
import { alignToPhoto, dilate } from '../public/shade/align.js';
import { kindOf, mercUnits } from '../public/shade/view3d.js';
import { aboutLocal, ramp } from '../public/shade/sun-ui.js';
import { tracedOn, lineUpAt } from '../public/shade/traced.js';
import { sunAt, solarNoon, sunPath, clearSky, airMass, parMol } from '../public/shade/sun.js';
import { buildCanopy } from '../public/shade/canopy.js';
import { transmittance, skyView, sunlitNow, dayLight, samplePoints, groundAt } from '../public/shade/rays.js';
import { movedCorners } from '../public/lib/align.js';
import { frameCorners } from '../public/lib/mercator.js';
import { footprintEntry, covers, lidarAt, handleShade, isShadePath } from '../worker/src/shade.js';
import { metresPerPixel } from '../public/lib/mercator.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------- LAS */

/** A LAS file in memory: a 375-byte 1.4 header and the given records. */
function lasFile(format, recordLength, points, { scale = 0.01, offset = [100, 200, 10] } = {}) {
  const head = 375;
  const buf = new ArrayBuffer(head + recordLength * points.length);
  const v = new DataView(buf);
  'LASF'.split('').forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  v.setUint8(24, 1); v.setUint8(25, 4);
  v.setUint32(96, head, true);
  v.setUint8(104, format | 0x80);
  v.setUint16(105, recordLength, true);
  v.setUint32(107, 0, true);
  v.setBigUint64(247, BigInt(points.length), true);
  [scale, scale, scale].forEach((s, i) => v.setFloat64(131 + 8 * i, s, true));
  offset.forEach((o, i) => v.setFloat64(155 + 8 * i, o, true));
  points.forEach((p, i) => {
    const at = head + i * recordLength;
    v.setInt32(at, Math.round((p.x - offset[0]) / scale), true);
    v.setInt32(at + 4, Math.round((p.y - offset[1]) / scale), true);
    v.setInt32(at + 8, Math.round((p.z - offset[2]) / scale), true);
    v.setUint16(at + 12, p.i, true);
    if (format >= 6) {
      v.setUint8(at + 14, p.ret | (p.nret << 4));
      v.setUint8(at + 16, p.cls);
    } else {
      v.setUint8(at + 14, p.ret | (p.nret << 3));
      v.setUint8(at + 15, p.cls);
    }
  });
  return buf;
}

{
  const pts = [{ x: 101.5, y: 203.25, z: 12.5, i: 900, ret: 1, nret: 3, cls: 1 }, { x: 99, y: 199, z: 9, i: 40, ret: 3, nret: 3, cls: 2 }];
  for (const [format, L] of [[1, 28], [6, 30]]) {
    const buf = lasFile(format, L, pts);
    const h = lasHeader(buf);
    const cols = makeColumns(2);
    const dv = new DataView(buf, h.pointOffset);
    readRecord(dv, 0, h.format, h, cols, 0);
    readRecord(dv, L, h.format, h, cols, 1);
    check(`LAS format ${format}: header (1.4 count, scale, offset, compression bit masked)`,
      h.count === 2 && h.format === format && h.recordLength === L && h.offset[2] === 10);
    check(`LAS format ${format}: position, intensity, return of how many, class`,
      near(cols.x[0], 101.5, 1e-9) && near(cols.y[0], 203.25, 1e-9) && near(cols.z[0], 12.5, 1e-6)
      && cols.intensity[0] === 900 && cols.ret[0] === 1 && cols.nret[0] === 3 && cols.cls[0] === 1
      && cols.ret[1] === 3 && cols.cls[1] === 2, JSON.stringify([cols.x[0], cols.ret[1], cols.cls[1]]));
  }
}

/* ------------------------------------------------------------- EPT */

{
  const b = [0, 0, 0, 100, 100, 100];
  check('a node box halves per depth', JSON.stringify(nodeBox(b, '1-1-0-0')) === JSON.stringify([50, 0, 100, 50]));
  const [lng, lat] = fromMerc(toMerc([-85.86, 42.87]));
  check('3857 there and back', near(lng, -85.86, 1e-9) && near(lat, 42.87, 1e-9));
  check('a web-mercator metre is cos(lat) of a real one', near(mercScale(60), 0.5, 1e-12));

  /* A hierarchy whose depth-2 subtree lives in its own file (Entwine's -1). */
  const files = {
    '0-0-0-0': { '0-0-0-0': 10, '1-0-0-0': 5, '1-1-1-0': 5, '2-0-0-0': -1 },
    '2-0-0-0': { '2-0-0-0': 7, '3-0-0-0': 3 },
  };
  const asked = [];
  const read = hierarchyReader('B', async (url) => { const k = url.match(/([\d-]+)\.json$/)[1]; asked.push(k); return files[k] || null; });
  const got = await walk(b, [1, 1, 10, 10], read);
  const keys = got.map((n) => n.key).sort();
  check('walk: every node with points touching the box, subtree file followed',
    JSON.stringify(keys) === JSON.stringify(['0-0-0-0', '1-0-0-0', '2-0-0-0', '3-0-0-0']), JSON.stringify(keys));
  check('walk: a missing node is not fetched as a file', asked.length === 2, JSON.stringify(asked));

  /* pointsIn with fake I/O: two nodes, crop to the box. */
  const ept = { bounds: b, srs: { horizontal: '3857' } };
  const nodes = { '0-0-0-0': lasFile(6, 30, [{ x: 5, y: 5, z: 1, i: 1, ret: 1, nret: 1, cls: 2 }, { x: 80, y: 80, z: 1, i: 1, ret: 1, nret: 1, cls: 2 }], { offset: [0, 0, 0] }),
    '1-0-0-0': lasFile(6, 30, [{ x: 6, y: 7, z: 2, i: 1, ret: 1, nret: 1, cls: 1 }], { offset: [0, 0, 0] }) };
  const io = {
    getJson: async (url) => (url.endsWith('ept.json') ? ept : url.endsWith('0-0-0-0.json') ? { '0-0-0-0': 2, '1-0-0-0': 1 } : null),
    getBytes: async (url) => nodes[url.match(/([\d-]+)\.laz$/)[1]],
    decompress: async (buf) => { const h = lasHeader(buf); return { header: h, points: new Uint8Array(buf, h.pointOffset) }; },
  };
  const { cols } = await pointsIn('X/ept.json', [0, 0, 10, 10], io);
  check('pointsIn: points from every node, cropped to the box', cols.n === 2, `n=${cols.n}`);
  let threw = false;
  try { await pointsIn('X/ept.json', [0, 0, 1, 1], { ...io, getJson: async () => ({ ...ept, srs: { horizontal: '26916' } }) }); } catch { threw = true; }
  check('pointsIn refuses a cloud that is not EPSG:3857', threw);
}

/* ------------------------------------------------------------ datum */

{
  /* The predictions written into datum.js's header, which matched the
     measured offsets on four lots (2026-10-10). */
  const cases = [[42.86220, -87.95621, 2017.5, -0.85, 0.90], [41.93372, -70.62126, 2021.5, -0.44, 1.14],
    [40.60945, -75.52344, 2019.5, -0.54, 1.04], [42.87, -85.86, 2016.5, -0.78, 0.93]];
  for (const [lat, lng, ep, e, n] of cases) {
    const c = nad83Correction(lat, lng, ep);
    check(`NAD83 -> WGS84 at ${lat}, ${lng}: ${e} E ${n} N`, near(c.east, e, 0.01) && near(c.north, n, 0.01), JSON.stringify(c));
  }
  const west = nad83Correction(37.8, -122.3, 2018), east = nad83Correction(37.8, -122.3, 2008);
  check('the correction is 1-2 m on the West Coast too, and plate motion moves it a few cm a year',
    Math.hypot(west.east, west.north) > 0.8 && Math.hypot(west.east, west.north) < 2.2
    && near(Math.hypot(west.east - east.east, west.north - east.north), 0.2, 0.15), JSON.stringify([west, east]));
}

/* ------------------------------------------------------------- find */

{
  const d = (s) => Date.parse(`${s}T00:00:00Z`);
  const box = (name, b, extra = {}) => ({ name, count: 1e9, km2: 100, bbox: b, ...extra });
  const index = { projects: [
    box('NV_USFSR4_2_D23', [-115, 39, -110, 42]),
    box('UT_StatewideNCentral_4_2020', [-112.5, 40, -111, 41.5]),
    box('USGS_LPC_UT_Wasatch_L4_2013_LAS_2016', [-112.2, 40, -111.5, 41]),
  ] };
  const wesm = { features: [
    { attributes: { workunit: 'UT_SALTLAKE_1X4M_2006', project: 'UT_SALTLAKE_1X4M_2006_Legacy_Data', ql: 'Other', collect_start: d('2006-04-01'), collect_end: d('2007-05-15') } },
    { attributes: { workunit: 'UT_Wasatch_L4_2013', project: 'Wasatch_Fault_UT_LiDAR', ql: 'QL 1', collect_start: d('2013-09-01'), collect_end: d('2014-03-22') } },
    { attributes: { workunit: 'UT_2023_SaltLakeCo_1_C24', project: 'UT_2023SaltLakeCo_C24', ql: 'QL 1', collect_start: d('2023-10-01'), collect_end: d('2023-11-05') } },
  ] };
  const { clouds, notOnAws } = rankClouds(index, wesm, -111.86, 40.57);
  check('a cloud USGS confirms by name comes first, with its flight epoch',
    clouds[0].name === 'USGS_LPC_UT_Wasatch_L4_2013_LAS_2016' && clouds[0].confirmed && near(clouds[0].epoch, 2013.9, 0.15), JSON.stringify(clouds[0]));
  check('box-only clouds follow, unconfirmed (the Nevada survey cannot win on its box)',
    clouds.slice(1).every((c) => !c.confirmed) && clouds.length === 3);
  check('a newer flight with no public octree is reported, legacy data is not',
    notOnAws.length === 1 && notOnAws[0].workunit === 'UT_2023_SaltLakeCo_1_C24', JSON.stringify(notOnAws.map((u) => u.workunit)));
  check('season from the flight dates', leafSeason(d('2013-11-01'), d('2014-03-22')) === 'off');
  check('years from names, including the new letter-and-year suffix', nameYear('USGS_LPC_MI_31Co_Kent_2016_LAS_2019') === 2016 && nameYear('RI_Statewide_1_D22') === 2022);

  /* The Worker's side: outlines, holes, and the whole answer with fake fetches. */
  const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const fp = footprintEntry({ properties: { name: 'X_2019', url: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/X_2019/ept.json', count: 1000 },
    geometry: { type: 'MultiPolygon', coordinates: [[square(-1, 0, 1, 1), square(-0.5, 0.25, 0.5, 0.75)]] } });
  check('footprint entry: box, outline, area, no URL when it is the usual one',
    fp && !fp.url && fp.bbox.join() === '-1,0,1,1' && fp.km2 > 15000 && fp.km2 < 20000, JSON.stringify({ ...fp, polys: undefined }));
  check('a point in the outline is covered, one in its hole is not, one outside the box is not',
    covers(fp, 0.9, 0.9) && !covers(fp, 0, 0.5) && !covers(fp, 2, 0.5));
  const L = (name, ring) => ({ type: 'Feature', properties: { name, count: 1e9 }, geometry: { type: 'Polygon', coordinates: [ring] } });
  const fakeFetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('resources.geojson')
      ? { features: [L('NV_USFSR4_2_D23', [[-115, 39], [-110, 39], [-114.9, 42], [-115, 42], [-115, 39]]),
        L('USGS_LPC_UT_Wasatch_L4_2013_LAS_2016', square(-112.2, 40, -111.5, 41))] }
      : wesm),
  });
  const at = await lidarAt(-111.86, 40.57, { fetchImpl: fakeFetch });
  check('the Worker drops a cloud whose BOX covers the point but whose OUTLINE does not',
    at.clouds.length === 1 && at.clouds[0].name === 'USGS_LPC_UT_Wasatch_L4_2013_LAS_2016' && at.clouds[0].confirmed && at.wesm,
    JSON.stringify(at.clouds.map((c) => c.name)));
  const json = (data, status) => ({ data, status });
  check('the route: /api/shade/ is ours, a bad point is a 400',
    isShadePath('/api/shade/lidar') && !isShadePath('/api/shader')
    && (await handleShade({ method: 'GET' }, new URL('https://x/api/shade/lidar?lng=abc'), {}, '', null, json)).status === 400);
}

/* ------------------------------------------------------------- grid */

{
  const frame = { lng: -85.86, lat: 42.87, zoom: 19, size: 640, height: 480 };
  const g = gridForFrame(frame, 64, 48);
  const [x0, , x1] = gridBox(g);
  const want = metresPerPixel(frame, 640) * 640;
  check('a frame grid spans exactly what the photo spans', near((x1 - x0) * mercScale(frame.lat), want, 1e-6), `${(x1 - x0) * mercScale(frame.lat)} vs ${want}`);

  const gg = gridOver([0, 0, 10, 10], 1, 0);
  const cols = makeColumns(4);
  [[0.5, 9.5, 5, 2, 1, 1, 100], [0.6, 9.4, 3, 2, 1, 1, 300], [0.5, 9.5, 12, 1, 1, 3, 50], [5.5, 5.5, 4, 7, 1, 1, 9]]
    .forEach(([x, y, z, c, r, nr, i], k) => { cols.x[k] = x; cols.y[k] = y; cols.z[k] = z; cols.cls[k] = c; cols.ret[k] = r; cols.nret[k] = nr; cols.intensity[k] = i; });
  const ras = rasterise(cols, gg);
  check('rasterise: top-left cell holds the ground minimum, the surface maximum, mean ground intensity',
    ras.n[0] === 3 && ras.zGround[0] === 3 && ras.zTop[0] === 12 && ras.iGround[0] === 200 && ras.nFirstOfMany[0] === 1);
  check('rasterise: noise (class 7) is ignored', ras.n[4 * 10 + 5] === 0);
  check('rasterise: a shift moves points between cells', rasterise(cols, gg, { shift: [1, 0] }).n[1] === 3);
  const filled = fillGaps(Float32Array.from([1, NaN, 3, NaN, NaN, NaN, 7, NaN, 9]), 3, 3, 1);
  check('fillGaps fills from neighbours', Number.isFinite(filled[4]) && Number.isFinite(filled[1]));
  check('resample keeps a constant constant', resample(new Float32Array(16).fill(5), 4, 4, 9, 9).every((v) => near(v, 5, 1e-6)));
  const m = new Uint8Array(25); m[12] = 1;
  check('dilate grows a cell into a cross', dilate(m, 5, 5, 1).reduce((a, b) => a + b, 0) === 5);
}

/* ------------------------------------------------------------ align */

{
  /* A made-up neighbourhood: roads, drives and paths as bright bands on
     grass, curving and straight in every quarter, and two "houses" with no
     ground under them. The photo is that scene; the lidar is the same scene
     sampled at 4 points a square metre, offset by a known amount. Lining up
     must recover the offset and say it is sure. */
  const frame = { lng: -85.86, lat: 42.87, zoom: 19, size: 640, height: 640 };
  const k = mercScale(frame.lat);
  const g = gridForFrame(frame, 1, 1);
  const [bx0, by0, bx1, by1] = gridBox(g);
  const W = (bx1 - bx0) * k; // real metres across
  const bright = (ex, ny) => { // real metres east / north of the frame's SW corner
    const d1 = Math.abs(Math.hypot(ex - 10, ny - 5) - 40); // a curving road
    const d2 = Math.abs(ny - 0.35 * ex - 45); // a straight one
    const d3 = Math.abs(ex - 55); // a drive
    const path = Math.abs(Math.hypot(ex - 25, ny - 55) - 9);
    const yard = ((Math.floor(ex / 7) + Math.floor(ny / 9)) % 3 === 0) ? 15 : 0;
    return (d1 < 3.5 || d2 < 2.5 || d3 < 1.5 ? 200 : path < 0.8 ? 170 : 90) + yard;
  };
  const house = (ex, ny) => (ex > 14 && ex < 26 && ny > 14 && ny < 24) || (ex > 44 && ex < 54 && ny > 40 && ny < 50);

  const P = 640;
  const data = new Uint8ClampedArray(P * P * 4);
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const ex = ((x + 0.5) / P) * W, ny = W - ((y + 0.5) / P) * W;
    const v = house(ex, ny) ? 60 : bright(ex, ny);
    const i = (y * P + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  const photo = { data, width: P, height: P };

  const TRUE_E = 0.6, TRUE_N = -0.4; // the lidar sits this far off; the answer is the opposite
  /* mulberry32: a linear congruential step in plain JS numbers overflows the
     53-bit mantissa and lays the "random" points out in rows. */
  let seed = 7;
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.round(W * W * 4);
  const cols = makeColumns(n);
  let j = 0;
  for (let t = 0; t < n; t++) {
    const ex = rnd() * W, ny = rnd() * W;
    const onRoof = house(ex, ny);
    cols.x[j] = bx0 + (ex + TRUE_E) / k; cols.y[j] = by0 + (ny + TRUE_N) / k;
    cols.z[j] = onRoof ? 108 : 100 + rnd() * 0.05;
    cols.cls[j] = onRoof ? 6 : 2; cols.ret[j] = 1; cols.nret[j] = 1;
    cols.intensity[j] = Math.max(0, Math.round(3 * bright(ex, ny) + (rnd() - 0.5) * 120));
    j++;
  }
  const a = alignToPhoto(cols, frame, photo);
  check('lining up recovers a known offset to 10 cm', a.east !== null && near(a.east, -TRUE_E, 0.1) && near(a.north, -TRUE_N, 0.1),
    `east ${a.east?.toFixed(3)} north ${a.north?.toFixed(3)} (${a.why})`);
  check('... and says it is sure', a.confident && a.shift && a.errorM < 0.2, a.why);

  const b = alignToPhoto(cols, frame, photo, { pre: [-TRUE_E / k, -TRUE_N / k] });
  check('with the offset applied first, almost nothing is left over', near(b.east, 0, 0.1) && near(b.north, 0, 0.1),
    `east ${b.east?.toFixed(3)} north ${b.north?.toFixed(3)}`);

  const flat = { data: new Uint8ClampedArray(P * P * 4).fill(128), width: P, height: P };
  const c = alignToPhoto(cols, frame, flat);
  check('a photo with nothing in it is "not measured", never a guess', !c.confident && c.shift === null, c.why);
}

/* ----------------------------------------------------------- traced */

{
  const frame = { lng: -87.9562, lat: 42.8622, zoom: 19.5, size: 900, height: 700 };
  const county = { provider: 'county', countySvc: 4123, countyAlign: { east: 0.4, north: 0.11, scale: 1.004, source: 'auto' }, frame, lng: -87.95, lat: 42.86 };
  const t = tracedOn(county);
  check('a map saved on a county photo is matched to that photo, with its saved line-up',
    t.provider === 'county' && t.svc === 4123 && t.align.east === 0.4 && t.about[0] === frame.lng);
  check('saved without a line-up (unsure): the county photo where the county put it',
    tracedOn({ ...county, countyAlign: null }).align === null && tracedOn({ ...county, countyAlign: null }).provider === 'county');
  check('Mapbox, NAIP and old saves without a service are on Mapbox\'s ground',
    tracedOn({ provider: 'mapbox' }).provider === 'mapbox' && tracedOn({ provider: 'naip' }).provider === 'mapbox'
    && tracedOn({ provider: 'county' }).provider === 'mapbox' && tracedOn(null).provider === 'mapbox');

  /* lineUpAt must move a point exactly as the editor's movedCorners moves
     the photo's corners (scale about the saved frame's centre). */
  const corners = frameCorners(frame);
  const moved = movedCorners(corners, 0.4, 0.11, 1.004, [frame.lng, frame.lat]);
  let worst = 0;
  corners.forEach((c, i) => {
    const m = lineUpAt(t, c);
    const [x0, y0] = toMerc(c), [x1, y1] = toMerc(moved[i]);
    const kk = mercScale(c[1]);
    worst = Math.max(worst, Math.hypot((x1 - x0) * kk - m.east, (y1 - y0) * kk - m.north));
  });
  check('lineUpAt agrees with the editor\'s movedCorners at every corner, to a millimetre', worst < 0.001, `worst ${worst.toFixed(5)} m`);
  check('at the saved frame centre the line-up is just its shift', near(lineUpAt(t, [frame.lng, frame.lat]).east, 0.4, 1e-9));
}

/* -------------------------------------------------------------- sun */

{
  const lat = 42.87, lng = -85.86;
  const at = (y, m, d) => sunAt(lat, lng, solarNoon(lng, Date.UTC(y, m, d, 17)));
  const eq = at(2026, 2, 20), su = at(2026, 5, 21), wi = at(2026, 11, 21);
  check('noon sun at 42.87 N: 90 - lat at the equinox, +/- 23.44 at the solstices (refraction included)',
    near(eq.elevation, 90 - lat, 0.15) && near(su.elevation, 90 - lat + 23.44, 0.1) && near(wi.elevation, 90 - lat - 23.44, 0.15)
    && near(eq.azimuth, 180, 0.2), `${eq.elevation.toFixed(2)} ${su.elevation.toFixed(2)} ${wi.elevation.toFixed(2)}`);
  const hours = (m, d) => sunPath(lat, lng, Date.UTC(2026, m, d, 17), 2).length * 2 / 60;
  check('daylight: ~12.1 h at the equinox, ~15.3 h midsummer, ~9.0 h midwinter',
    near(hours(2, 20), 12.1, 0.15) && near(hours(5, 21), 15.3, 0.15) && near(hours(11, 21), 9.0, 0.15),
    `${hours(2, 20).toFixed(2)} ${hours(5, 21).toFixed(2)} ${hours(11, 21).toFixed(2)}`);
  const p = sunPath(lat, lng, Date.UTC(2026, 2, 20, 17), 10);
  check('equinox: the sun rises close to due east and sets close to due west',
    near(p[0].azimuth, 90, 3) && near(p.at(-1).azimuth, 270, 3), `${p[0].azimuth.toFixed(1)} ${p.at(-1).azimuth.toFixed(1)}`);
  check('air mass is 1 overhead and about 2 at 30 degrees', near(airMass(90), 1, 0.01) && near(airMass(30), 2, 0.02));
  const mj = (m, d, hM) => sunPath(lat, lng, Date.UTC(2026, m, d, 17), 10).reduce((t, q) => t + clearSky(q.elevation, hM, q.R).ghi * 600, 0) / 1e6;
  check('clear-sky day at 42.87 N: ~30 MJ/m2 midsummer (~60 mol/m2 DLI), ~7-8 midwinter',
    near(mj(5, 21, 200), 30.5, 2) && near(mj(11, 21, 200), 7.5, 1.2) && near(parMol(1e6 / 86400, 86400), 2.04, 1e-9),
    `${mj(5, 21, 200).toFixed(1)} ${mj(11, 21, 200).toFixed(1)}`);
  check('higher ground gets more: 2,000 m up is 10-20% brighter than sea level on a clear day',
    mj(5, 21, 2000) / mj(5, 21, 0) > 1.1 && mj(5, 21, 2000) / mj(5, 21, 0) < 1.2);
}

check('about-local time: Milwaukee in October is UTC-5 (daylight time), in December UTC-6',
  aboutLocal(Date.UTC(2026, 9, 11, 12, 3), -87.95) === '7:03 am' && aboutLocal(Date.UTC(2026, 11, 21, 22, 15), -87.95) === '4:15 pm',
  `${aboutLocal(Date.UTC(2026, 9, 11, 12, 3), -87.95)} ${aboutLocal(Date.UTC(2026, 11, 21, 22, 15), -87.95)}`);
check('the colour ramp runs dark to bright and clamps', ramp(-1).join() === '68,1,84' && ramp(2).join() === '253,231,37');

/* ---------------------------------------------------- canopy and rays */

{
  /* A 60 m square of flat lawn at 100 m with a 10 x 10 m, 10 m tall house
     in the middle and a round crown 5-10 m up, 4 m across in radius, that
     stops half the pulses (each stopped pulse returns once, from a random
     height in the crown). Pulses every 0.25 m. */
  const lat = 40, k = mercScale(lat);
  const box = [0, 0, 60 / k, 60 / k];
  const grid = gridOver(box, 1, lat);
  let seed = 3;
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pts = [];
  const house = (e, n) => e >= 25 && e < 35 && n >= 25 && n < 35;
  const crown = (e, n) => Math.hypot(e - 45, n - 45) < 4;
  for (let e = 0.125; e < 60; e += 0.25) {
    for (let n = 0.125; n < 60; n += 0.25) {
      if (house(e, n)) pts.push([e, n, 110, 6]);
      else if (crown(e, n) && rnd() < 0.5) pts.push([e, n, 105 + rnd() * 5, 1]);
      else pts.push([e, n, 100, 2]);
    }
  }
  const cols = makeColumns(pts.length);
  pts.forEach(([e, n, z, c], i) => { cols.x[i] = e / k; cols.y[i] = n / k; cols.z[i] = z; cols.cls[i] = c; cols.ret[i] = 1; cols.nret[i] = 1; });
  const model = buildCanopy(cols, grid);
  /* A point at (east, north) metres, in grid cells (y runs south). */
  const P = (e, n) => [e, 60 - n];
  const T = (e, n, dir) => { const [gx, gy] = P(e, n); return transmittance(model, gx, gy, groundAt(model, gx, gy) + 0.1, dir); };
  const s45 = Math.SQRT1_2;
  const fromSouth = [0, -s45, s45]; // sun due south, 45 degrees up
  check('canopy: ground found flat at 100 m, model reaches the roof', near(groundAt(model, 10, 10), 100, 1e-3) && model.top >= 110 && model.top <= 112);
  check('a 10 m house throws a 10 m shadow with the sun 45 degrees up: 5 m north of it is dark, 15 m north is lit',
    T(30, 40, fromSouth) < 0.01 && T(30, 50, fromSouth) > 0.99, `${T(30, 40, fromSouth).toFixed(3)} ${T(30, 50, fromSouth).toFixed(3)}`);
  check('... and the sun behind the house from the north does not shade the south side',
    T(30, 20, [0, s45, s45]) < 0.01 && T(30, 20, fromSouth) > 0.99);
  const up = [0, 0, 1];
  /* Averaged over nine columns: one 1 m column holds only 16 pulses. */
  const mean = (f) => { let t = 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) t += f(a, b); return t / 9; };
  const vert = mean((a, b) => T(45 + a, 45 + b, up));
  check('a crown that stops half the pulses lets about half the overhead sun through', near(vert, 0.5, 0.08), vert.toFixed(3));
  /* Sun 30 degrees up in the south: the beam climbs the crown's 5 m depth over
     8.7 m, crossing ~10 m of crown -- twice the vertical path, so ~0.5^2. */
  const low = [0, -Math.cos(Math.PI / 6), 0.5];
  const slant = mean((a) => T(45 + a, 57.5, low));
  check('a beam crossing twice as much crown keeps about the square of it', slant < vert && near(slant, vert * vert, 0.1), `${slant.toFixed(3)} vs ${vert.toFixed(3)}^2`);
  check('the house is solid to the ground: a low sun does not shine under the roof',
    T(30, 37, [0, -Math.cos(10 * Math.PI / 180), Math.sin(10 * Math.PI / 180)]) < 0.01);
  const solid = buildCanopy(cols, grid, { opaqueCanopy: true });
  const vSolid = transmittance(solid, 45, 15, 100.1, up);
  check('"trees as solid" stops the overhead sun under the crown entirely', vSolid < 0.01, vSolid.toFixed(3));

  const xy = Float32Array.from([...P(10, 10), ...P(30, 36), ...P(45, 45)]);
  const svf = skyView(model, xy);
  /* A 10 m wall 1 m away hides most of its half of the sky (a long wall
     would leave (1 + cos 84 deg) / 2 = 0.55); a half-gap crown 5-10 m up and
     4 m across hides half of the sky within ~40 degrees of overhead (~0.8). */
  check('sky view: 1 in the open, ~0.55-0.7 hard by the house wall, ~0.8 under the crown',
    near(svf[0], 1, 0.02) && svf[1] > 0.5 && svf[1] < 0.72 && svf[2] > 0.7 && svf[2] < 0.9, Array.from(svf).map((v) => v.toFixed(2)).join(' '));
  const now = sunlitNow(model, xy, fromSouth);
  check('sunlit now: open lit, north of the house dark', now[0] > 0.99 && now[1] < 0.01);
  const path = sunPath(lat, -100, Date.UTC(2026, 5, 21, 18), 10);
  const day = dayLight(model, xy, path, { svf, heightM: 100 });
  check('a day in the open gets the open-sky DLI; beside the house and under the crown get less',
    near(day.dli[0], day.openDli, day.openDli * 0.02) && day.dli[1] < day.dli[0] && day.dli[2] < day.dli[0] * 0.8
    && day.sunHours[0] > 14.5, `${day.dli[0].toFixed(1)} / ${day.openDli.toFixed(1)}, ${day.dli[1].toFixed(1)}, ${day.dli[2].toFixed(1)}; sun h ${day.sunHours[0].toFixed(1)} ${day.sunHours[1].toFixed(1)}`);
  const mask = new Uint8Array(model.w * model.h); mask[0] = 1;
  check('sample points: sub x sub points per masked cell, at their centres', samplePoints(model, mask, 2).xy.length === 8 && samplePoints(model, mask, 2).xy[0] === 0.25);
}

/* ------------------------------------------------------------- view */

check('kinds: ground, low, through (pulse went on), solid',
  kindOf(2, 1, 1, 0) === 'ground' && kindOf(1, 1, 1, 0.5) === 'low' && kindOf(1, 1, 3, 8) === 'through' && kindOf(1, 1, 1, 8) === 'solid' && kindOf(1, 3, 3, 8) === 'solid');
check('mercator units: the origin is the middle of the world', mercUnits(0, 0).every((v) => near(v, 0.5, 1e-12)));

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nshade map: ok');
