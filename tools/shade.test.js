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
import { niceStep, bandsFor, rasterOf, smooth, valueAt, boxStats } from '../public/shade/readout.js';
import { msOf, fromPush, fromExport, perSecond, poseOf, posePerSecond, joinTrack, splitVisits, usable, sunOrShade, sunOrShadeAround, sunOffFace, sunGain, compassOffset, operatorShadow, score, unzipText, metersBetween } from '../public/shade/truth.js';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { tracedOn, lineUpAt } from '../public/shade/traced.js';
import { findTrucks, truckEffect, flatStretches } from '../public/shade/truck.js';
import { sunAt, solarNoon, sunPath, clearSky, airMass, parMol } from '../public/shade/sun.js';
import { buildCanopy } from '../public/shade/canopy.js';
import { seasonalCanopy, muWithLeaves, leafCalendar, G_OMEGA, LAI_MAX } from '../public/shade/seasonal.js';
import { transmittance, skyView, sunlitNow, dayLight, samplePoints, groundAt, beamShare } from '../public/shade/rays.js';
import { dayIndex, typicalYear, growthPotential, growingSeason, dliOn, dayLabel } from '../public/shade/climate.js';
import { climateAt } from '../worker/src/shade.js';
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
  check('a web-mercator meter is cos(lat) of a real one', near(mercScale(60), 0.5, 1e-12));

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
  check('fillGaps fills from neighbors', Number.isFinite(filled[4]) && Number.isFinite(filled[1]));
  check('resample keeps a constant constant', resample(new Float32Array(16).fill(5), 4, 4, 9, 9).every((v) => near(v, 5, 1e-6)));
  const m = new Uint8Array(25); m[12] = 1;
  check('dilate grows a cell into a cross', dilate(m, 5, 5, 1).reduce((a, b) => a + b, 0) === 5);
}

/* ------------------------------------------------------------ align */

{
  /* A made-up neighborhood: roads, drives and paths as bright bands on
     grass, curving and straight in every quarter, and two "houses" with no
     ground under them. The photo is that scene; the lidar is the same scene
     sampled at 4 points a square meter, offset by a known amount. Lining up
     must recover the offset and say it is sure. */
  const frame = { lng: -85.86, lat: 42.87, zoom: 19, size: 640, height: 640 };
  const k = mercScale(frame.lat);
  const g = gridForFrame(frame, 1, 1);
  const [bx0, by0, bx1, by1] = gridBox(g);
  const W = (bx1 - bx0) * k; // real meters across
  const bright = (ex, ny) => { // real meters east / north of the frame's SW corner
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
     the photo's corners (scale about the saved frame's center). */
  const corners = frameCorners(frame);
  const moved = movedCorners(corners, 0.4, 0.11, 1.004, [frame.lng, frame.lat]);
  let worst = 0;
  corners.forEach((c, i) => {
    const m = lineUpAt(t, c);
    const [x0, y0] = toMerc(c), [x1, y1] = toMerc(moved[i]);
    const kk = mercScale(c[1]);
    worst = Math.max(worst, Math.hypot((x1 - x0) * kk - m.east, (y1 - y0) * kk - m.north));
  });
  check('lineUpAt agrees with the editor\'s movedCorners at every corner, to a millimeter', worst < 0.001, `worst ${worst.toFixed(5)} m`);
  check('at the saved frame center the line-up is just its shift', near(lineUpAt(t, [frame.lng, frame.lat]).east, 0.4, 1e-9));
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
check('the color ramp runs dark to bright and clamps', ramp(-1).join() === '0,0,4' && ramp(2).join() === '252,255,164');
{
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let up = true;
  for (let i = 1; i <= 20; i++) if (lum(ramp(i / 20)) <= lum(ramp((i - 1) / 20))) up = false;
  check('and gets brighter all the way, so shade reads darker than sun', up);
  check('round steps, at most seven bands: 51 DLI in 10s, 15.2 h in 2.5s, 0.8 in 0.2s',
    niceStep(51) === 10 && niceStep(15.2) === 2.5 && Math.abs(niceStep(0.8) - 0.2) < 1e-9, `${niceStep(51)} ${niceStep(15.2)} ${niceStep(0.8)}`);
  const b = bandsFor(51);
  check('bands run 0 to 60 in six, the ramp\'s ends at the ends, and a value finds its band',
    b.n === 6 && b.edges[6] === 60 && b.colors[0].join() === ramp(0).join() && b.colors[5].join() === ramp(1).join()
    && b.of(0) === 0 && b.of(9.99) === 0 && b.of(10) === 1 && b.of(59) === 5 && b.of(80) === 5 && b.of(-1) === 0);
  const hb = bandsFor(15.3, { step: 1 });
  check('hours of sun go by the hour: 16 bands to 16 h, the ramp from end to end',
    hb.n === 16 && hb.edges[16] === 16 && hb.of(2.99) === 2 && hb.of(3) === 3 && hb.colors[15].join() === ramp(1).join());
  /* 4 x 3 raster: a building (empty) in one corner. */
  const r = rasterOf([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110], [0, 0, 0.5, 0, 1, 0, 1.5, 0, 0, 0.5, 0.5, 0.5, 1, 0.5, 1.5, 0.5, 0, 1, 0.5, 1, 1, 1], 4, 3);
  check('the answers land on their pixels, the rest empty', r[0] === 10 && r[3] === 40 && r[10] === 110 && Number.isNaN(r[11]));
  const sm = smooth(r, 4, 3, 1);
  check('smoothing averages over the neighbors that have a value, and the empty pixel stays empty',
    Math.abs(sm[0] - (10 + 20 + 50 + 60) / 4) < 1e-4 && Number.isNaN(sm[11]) && Math.abs(sm[10] - (60 + 70 + 80 + 100 + 110) / 5) < 1e-4, `${sm[0]} ${sm[10]}`);
  check('a pin on the empty pixel reads its nearest neighbor',
    valueAt(r, 4, 3, 3.5, 2.5) === 80 || valueAt(r, 4, 3, 3.5, 2.5) === 110, `${valueAt(r, 4, 3, 3.5, 2.5)}`);
  check('and one far outside reads nothing', Number.isNaN(valueAt(r, 4, 3, 10, 10)));
  const s = boxStats(r, 4, 3, [3.9, 2.9, 1, 1]);
  check('a box drawn either way round gives the lowest, highest and average of what is in it, skipping the empty pixel',
    s.n === 5 && s.min === 60 && s.max === 110 && Math.abs(s.mean - (60 + 70 + 80 + 100 + 110) / 5) < 1e-4, JSON.stringify(s));
  const t = boxStats(Float32Array.from([2, 2, 3, NaN]), 2, 2, [0, 0, 1, 1], { counts: true });
  check('and for the trees, the share of each kind', t.n === 3 && t.tally[2] === 2 && t.tally[3] === 1);
}

/* ---------------------------------------------------- canopy and rays */

{
  /* A long field-readings visit's box: 600 m square, 360,000 cells (the
     owner's "Maximum call stack size exceeded", 2026-10-14). */
  const lat = 43, k = mercScale(lat), grid = gridOver([0, 0, 600 / k, 600 / k], 1, lat);
  const cols = makeColumns(400);
  for (let i = 0; i < 400; i++) { cols.x[i] = ((i * 37) % 600) / k; cols.y[i] = ((i * 53) % 600) / k; cols.z[i] = 190 + (i % 7); cols.cls[i] = 2; cols.ret[i] = 1; cols.nret[i] = 1; }
  let ok = false, err = '';
  try { ok = buildCanopy(cols, grid).w === grid.w; } catch (e) { err = e.message; }
  check('the canopy builds over a 600 m box (360,000 cells) without overflowing the stack', ok, err);
}

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
  /* A point at (east, north) meters, in grid cells (y runs south). */
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
  const bs = beamShare(model, xy, path, { heightM: 100 });
  check('beam share: 1 in the open, less north of the house and under the crown',
    near(bs[0], 1, 0.01) && bs[1] < 0.8 && bs[2] < 0.8, Array.from(bs).map((v) => v.toFixed(2)).join(' '));
  const mask = new Uint8Array(model.w * model.h); mask[0] = 1;
  check('sample points: sub x sub points per masked cell, at their centers', samplePoints(model, mask, 2).xy.length === 8 && samplePoints(model, mask, 2).xy[0] === 0.25);
}

/* --------------------------------------------------------- seasonal */

{
  /* A leaf-off flight over 60 m of flat lawn at 100 m: an evergreen-like
     crown (6 m across, 4-12 m up) where 60% of pulses stop in it, a bare
     deciduous crown (same size, 6-14 m up) where 8% do, each stopped pulse
     returning once from the crown and once more if it gets through (as
     the last return); a TANGLE (same size, 6-14 m up: vines or dead leaves
     on bare branches) that 30% of pulses stop in and nothing splits, so it
     keeps as many last returns up high as an evergreen but measures no
     denser than the bare crown; an OAK holding its dead leaves (12 m
     across, 6-14 m up, a dome) that stops pulses like the evergreen; a SPRUCE (8 m across in the middle, to 18 m up) that
     nothing gets through, every pulse splitting on it, whose skirt (out to
     7 m) splits every pulse in its needles, half of them then reaching the
     ground and half stopping under 4 m; a smaller one (6 m
     across) whose every pulse comes back once, off a cone; and a flat roof
     at 108 m. Pulses every 0.25 m. */
  const lat = 40, k = mercScale(lat);
  const grid = gridOver([0, 0, 60 / k, 60 / k], 1, lat);
  let seed = 11;
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let seed3 = 47; // the oak's own draws
  const rnd3 = () => {
    seed3 = (seed3 + 0x6D2B79F5) | 0;
    let t = Math.imul(seed3 ^ (seed3 >>> 15), 1 | seed3);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let seed2 = 29; // the tangle's own draws, leaving rnd()'s to the others
  const rnd2 = () => {
    seed2 = (seed2 + 0x6D2B79F5) | 0;
    let t = Math.imul(seed2 ^ (seed2 >>> 15), 1 | seed2);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pts = [];
  const add = (e, n, z, c, ret, nret) => pts.push([e, n, z, c, ret, nret]);
  for (let e = 0.125; e < 60; e += 0.25) {
    for (let n = 0.125; n < 60; n += 0.25) {
      const ever = Math.hypot(e - 15, n - 15) < 6, bare = Math.hypot(e - 45, n - 15) < 6, tangle = Math.hypot(e - 15, n - 45) < 6, roof = e > 30 && e < 40 && n > 40 && n < 50;
      if (roof) { add(e, n, 108, 6, 1, 1); continue; }
      const r = Math.hypot(e - 50, n - 45);
      if (r < 4) { add(e, n, 118 - 2 * r, 1, 1, 2); add(e, n, 116 - 2 * r, 1, 2, 2); continue; }
      if (r < 7) { add(e, n, 118 - 2 * r, 1, 1, 3); add(e, n, 104.5, 1, 2, 3); add(e, n, (e + n) % 0.5 < 0.25 ? 101.5 : 100, (e + n) % 0.5 < 0.25 ? 1 : 2, 3, 3); continue; }
      const r2 = Math.hypot(e - 55, n - 56);
      if (r2 < 3) { add(e, n, 110 - 2.5 * r2, 1, 1, 1); continue; }
      const ro = Math.hypot(e - 30, n - 28);
      if (ro < 6 && rnd3() < 0.85) { add(e, n, 106 + rnd3() * (8 - 0.05 * ro * ro), 1, 1, 1); continue; }
      if (tangle && rnd2() < 0.3) { add(e, n, 106 + rnd2() * 8, 1, 1, 1); continue; }
      if (ever || bare) {
        const lo = ever ? 104 : 106, stop = ever ? 0.85 : 0.08;
        /* The evergreen is a cone: its top falls 1.2 m a meter from the tip. */
        const span = ever ? 8 - 1.2 * Math.hypot(e - 15, n - 15) : 8;
        if (rnd() < stop) { add(e, n, lo + rnd() * span, 1, 1, 1); continue; }
        if (rnd() < 0.5) { add(e, n, lo + rnd() * span, 1, 1, 2); add(e, n, 100, 2, 2, 2); continue; }
      }
      add(e, n, 100, 2, 1, 1);
    }
  }
  const cols = makeColumns(pts.length);
  pts.forEach(([e, n, z, c, r, nr], i) => { cols.x[i] = e / k; cols.y[i] = n / k; cols.z[i] = z; cols.cls[i] = c; cols.ret[i] = r; cols.nret[i] = nr; });
  const model = buildCanopy(cols, grid);
  const s = seasonalCanopy(cols, model);
  const T0 = (e, n) => transmittance(model, e, 60 - n, 100.1, [0, 0, 1]);
  const at = (e, n) => Math.floor(60 - n) * grid.w + Math.floor(e);
  check('seasons: a crown that stopped most pulses in winter reads evergreen, one that let them through deciduous, the roof a roof',
    s.kind[at(15, 15)] === 2 && s.kind[at(45, 15)] === 3 && s.kind[at(35, 45)] === 1 && s.kind[at(5, 50)] === 0,
    `${s.kind[at(15, 15)]} ${s.kind[at(45, 15)]} ${s.kind[at(35, 45)]}`);
  /* Over each crown's columns (one meter holds only 16 pulses): the share
     called evergreen, and the median overhead sun through it as measured. */
  const crown = (ce, cn) => {
    const ts = [];
    let ever = 0;
    for (let n = cn - 4.5; n <= cn + 4.5; n++) for (let e = ce - 4.5; e <= ce + 4.5; e++) {
      if (Math.hypot(e - ce, n - cn) > 4.5) continue;
      ts.push(T0(e, n));
      if (s.kind[at(e, n)] === 2) ever++;
    }
    ts.sort((a, b) => a - b);
    return { ever: ever / ts.length, through: ts[ts.length >> 1] };
  };
  const tangleC = crown(15, 45), everC = crown(15, 15), bareC = crown(45, 15);
  check('seasons: a tree nothing got through is solid like a roof but labelled evergreen, the roof still a roof',
    s.kind[at(50, 45)] === 2 && T0(50.5, 45.5) < 0.01 && s.kind[at(35, 45)] === 1, `${s.kind[at(50, 45)]}, through ${T0(50.5, 45.5).toFixed(3)}`);
  check('seasons: and its skirt, which the 4 m line alone would call bare, is the same tree',
    s.kind[at(56.5, 45)] === 2 && s.kind[at(43.5, 45)] === 2, `${s.kind[at(56.5, 45)]} ${s.kind[at(43.5, 45)]}`);
  check('seasons: so is a small one whose pulses all came back once, by its rough cone of a top',
    s.kind[at(55, 56)] === 2 && T0(55.5, 56.5) < 0.01, `${s.kind[at(55, 56)]}`);
  check('seasons: an oak holding its dead leaves, which stopped the laser like the evergreen, is a dome and not evergreen',
    s.kind[at(30, 28)] === 3 && s.kind[at(15, 15)] === 2 && s.counts.domed > 0, `${s.kind[at(30, 28)]} (domed ${s.counts.domed})`);
  check('seasons: a tangle that keeps returns up high but let most of the overhead sun through in winter is deciduous, unlike the evergreen; (was: a crown that keeps last returns up high but measured no denser than the bare one is not evergreen',
    tangleC.ever < 0.1 && everC.ever > 0.9 && tangleC.through > everC.through + 0.2,
    `evergreen share ${tangleC.ever.toFixed(2)} (the evergreen ${everC.ever.toFixed(2)}); through ${tangleC.through.toFixed(2)}, bare ${bareC.through.toFixed(2)}, evergreen ${everC.through.toFixed(2)}`);
  const T = (mu, e, n) => transmittance({ ...model, mu }, e, 60 - n, 100.1, [0, 0, 1]);
  const bareT = T(s.muOff, 45, 15), leafT = T(s.muOn, 45, 15);
  /* Bare: 8% of pulses stop in it and half the rest split, leaving half a
     pulse there each -- about 0.69 gets through. In leaf: the crown is ~7 m
     deep, so its leaf area index is capped at LAI_MAX and the sun straight
     down keeps exp(-G Omega LAI_MAX) ~ 0.105, times what the branches stop. */
  const full = Math.exp(-G_OMEGA * LAI_MAX);
  check(`seasons: the deciduous crown lets ~0.7 of the overhead sun through bare, ~${full.toFixed(2)} or a little less in leaf`,
    near(bareT, 0.69, 0.08) && leafT <= full * 1.05 && leafT > full * 0.6, `bare ${bareT.toFixed(2)}, in leaf ${leafT.toFixed(3)}`);
  check('seasons: a low sun crossing more of the crown in leaf keeps less than the overhead sun',
    transmittance({ ...model, mu: s.muOn }, 45, 60 - 22, 100.1, [0, -Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)]) < leafT);
  check('seasons: the evergreen is as the laser measured it in every season (no leaves added)',
    near(T(s.muOff, 15, 15), T(s.muOn, 15, 15), 1e-6) && near(T(s.muOn, 15, 15), T(model.mu, 15, 15), 1e-6));
  check('seasons: in the leaf-off months every crown is as measured', s.muOff === model.mu);
  check('seasons: in leaf a crown keeps the edge the leaf-off laser found (the August NAIP shadows), and leaves its lawn open',
    T(s.muOn, 45 + 6.5, 15) > 0.99 && T(s.muOn, 45 + 5.5, 15) < 0.5, `${T(s.muOn, 45 + 6.5, 15).toFixed(2)} outside, ${T(s.muOn, 45 + 5.5, 15).toFixed(2)} at the edge`);
  check('seasons: half the leaves out sits between bare and full leaf',
    T(muWithLeaves(s, 0.5), 45, 15) < bareT && T(muWithLeaves(s, 0.5), 45, 15) > leafT && muWithLeaves(s, 0) === s.muOff && muWithLeaves(s, 1) === s.muOn);
  /* A bare tree over a winter shrub layer (honeysuckle, 1-3 m): half the
     pulses that get through its crown stop in the shrubs, not on the ground
     (on the owner's lot 18% of last returns did, 59% reached the ground).
     It is still deciduous (S36: a last return below 4 m got through). */
  const shrubbed = makeColumns(cols.n);
  for (const key of ['x', 'y', 'z', 'intensity', 'ret', 'nret', 'cls']) shrubbed[key].set(cols[key]);
  for (let i = 0; i < cols.n; i++) {
    const e = cols.x[i] * k, n = cols.y[i] * k;
    if (Math.hypot(e - 45, n - 15) < 6 && cols.cls[i] === 2 && i % 2) { shrubbed.z[i] = 101 + 2 * ((i * 7919) % 100) / 100; shrubbed.cls[i] = 1; }
  }
  const sh = seasonalCanopy(shrubbed, buildCanopy(shrubbed, grid));
  check('seasons: a bare tree over winter shrubs stays deciduous', sh.kind[at(45, 15)] === 3 && sh.kind[at(15, 15)] === 2, `${sh.kind[at(45, 15)]}`);
  const unclassified = seasonalCanopy(cols, model, { classify: false });
  check('seasons: without classification (a leaf-on flight) nothing is called evergreen',
    unclassified.kind[at(15, 15)] === 3 && unclassified.counts.evergreen === 0);

  /* A typical year: -5 C in mid-January to 23 C in mid-July. */
  const tMean = Array.from({ length: 365 }, (_, d) => 9 - 14 * Math.cos(((d - 14) / 365) * 2 * Math.PI));
  const cal = leafCalendar(tMean);
  const greenUp = tMean.findIndex((t, d) => d > 14 && t >= 14.5), c10down = tMean.findIndex((t, d) => d > 196 && t < 10);
  check('leaf calendar: half the shade 12 days after the typical mean passes 14.5 C (green-up), half gone two weeks before it drops below 10 C',
    cal.halfOut === greenUp + 12 && cal.fall === c10down - 14 && near(cal.share(cal.halfOut), 0.5, 0.03), `${dayLabel(cal.halfOut)} / ${dayLabel(cal.fall)}`);
  check('leaf calendar: bare in winter, five weeks to full leaf, full in July, half gone at the fall date, bare two weeks after',
    cal.share(10) === 0 && near(cal.share(cal.out + 7), 7 / 35, 1e-9) && cal.share(196) === 1
    && near(cal.share(cal.fall), 0.5, 0.04) && cal.share(cal.fall + 15) === 0, `${cal.share(cal.fall).toFixed(2)}`);
  /* A cool summer (warmest 15 C): green-up 7.5 C under it, not at 14.5. */
  const coolT = Array.from({ length: 365 }, (_, d) => 5 - 10 * Math.cos(((d - 14) / 365) * 2 * Math.PI));
  const cool = leafCalendar(coolT);
  check('leaf calendar: a cool summer greens 7.5 C under its warmest', cool.halfOut === coolT.findIndex((t, d) => d > 14 && t >= 7.5) + 12, `${dayLabel(cool.halfOut)}`);
  /* A short season (10 C passed for under three months) keeps its leaves for a while. */
  const short = leafCalendar(Array.from({ length: 365 }, (_, d) => 2 - 10 * Math.cos(((d - 14) / 365) * 2 * Math.PI)));
  check('leaf calendar: a short summer still gets full leaf', !short.always && !short.never && short.share(short.out + 36) === 1, `${dayLabel(short.out)} ${dayLabel(short.fall)}`);
  check('leaf calendar: always warm means always in leaf; never warm, never',
    leafCalendar(new Array(365).fill(20)).share(0) === 1 && leafCalendar(new Array(365).fill(0)).share(180) === 0);
}

/* ---------------------------------------------------------- climate */

{
  check('day of year: 1 Jan is 0, 31 Dec is 364 in any year, 29 Feb folds onto 28 Feb',
    dayIndex('20250101') === 0 && dayIndex('20251231') === 364 && dayIndex('20241231') === 364
    && dayIndex('20240229') === dayIndex('20240228') && dayIndex('20240301') === dayIndex('20250301'));
  /* Two made-up years: sunlight 10 + 10 sin(season), half of it diffuse,
     temperature -5 to 25 C, one fill value to ignore. */
  const days = {}, diff = {}, temp = {};
  for (const y of [2023, 2024]) {
    for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += 86400000) {
      const d = new Date(t), key = `${y}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      const k = dayIndex(key), phase = Math.sin(((k - 80) / 365) * 2 * Math.PI);
      days[key] = 10 + 10 * phase; diff[key] = days[key] / 2; temp[key] = 10 + 15 * phase;
    }
  }
  days['20230615'] = -999;
  const ty = typicalYear({ header: { fill_value: -999 }, properties: { parameter: { ALLSKY_SFC_SW_DWN: days, ALLSKY_SFC_SW_DIFF: diff, T2M: temp } } });
  check('typical year: 365 days, the season\'s shape kept, fills ignored, diffuse share 0.5',
    ty.ghi.length === 365 && near(ty.ghi[171], 20, 0.2) && near(ty.ghi[354], 0.3, 0.5) && near(ty.diffuse[100], 0.5, 1e-6) && ty.years === 2,
    `${ty.ghi[171].toFixed(2)} ${ty.ghi[354].toFixed(2)}`);
  check('growth potential: 1 at the optimum, ~0.5 a little over one spread away, warm grass prefers 31 C',
    near(growthPotential(20, 'cool'), 1, 1e-9) && near(growthPotential(20 + 5.5 * 1.1774, 'cool'), 0.5, 0.01) && growthPotential(31, 'warm') > growthPotential(31, 'cool'));
  const s1 = growingSeason(ty.tMean, 'cool');
  /* 10 + 15 sin(...) reaches 13.5 C (GP 0.5, cool) ~14 days after day 80 and
     leaves it ~14 days before day 262: days ~94 to ~249. */
  check('season: one run from ~day 94 to ~day 249 for cool-season grass in this made-up climate',
    near(s1.start, 94, 2) && near(s1.end, 249, 2) && s1.mainRun === s1.days.length, `${dayLabel(s1.start)} to ${dayLabel(s1.end)}`);
  const warmAll = growingSeason(new Array(365).fill(30), 'warm');
  const wrap = growingSeason(Array.from({ length: 365 }, (_, k) => (k < 60 || k > 300 ? 30 : 5)), 'warm');
  check('season: all year where it is always warm; a winter season wraps round New Year',
    warmAll.allYear && wrap.start > 300 && wrap.end < 60 && wrap.mainRun === wrap.days.length);
  check('a patch\'s light: open ground gets 2.04 mol per MJ; full shade under open sky keeps only its diffuse share',
    near(dliOn(20, 0.4, 1, 1), 40.8, 1e-9) && near(dliOn(20, 0.4, 0, 1), 2.04 * 8, 1e-9) && near(dliOn(20, 0.4, 0, 0.5), 2.04 * 4, 1e-9));
  const calls = [];
  const fake = async (url) => { calls.push(String(url)); return { ok: true, json: async () => ({ header: { fill_value: -999 }, properties: { parameter: { ALLSKY_SFC_SW_DWN: days, ALLSKY_SFC_SW_DIFF: diff, T2M: temp } } }) }; };
  const cl = await climateAt(-87.9562, 42.8622, { fetchImpl: fake, now: new Date(Date.UTC(2026, 9, 11)) });
  check('climate route: the last ten whole years from NASA POWER, the AG community, a 0.05 degree cell, 365 days back',
    calls.length === 1 && calls[0].includes('start=20160101') && calls[0].includes('end=20251231') && calls[0].includes('community=AG')
    && cl.lat === 42.85 && cl.lng === -87.95 && cl.ghi.length === 365 && cl.tMean.length === 365, calls[0]);
}

/* ------------------------------------------------------------- view */

check('kinds: ground, low, through (pulse went on), solid',
  kindOf(2, 1, 1, 0) === 'ground' && kindOf(1, 1, 1, 0.5) === 'low' && kindOf(1, 1, 3, 8) === 'through' && kindOf(1, 1, 1, 8) === 'solid' && kindOf(1, 3, 3, 8) === 'solid');
check('mercator units: the origin is the middle of the world', mercUnits(0, 0).every((v) => near(v, 0.5, 1e-12)));

/* ------------------------------------------------------ ground truth */

{
  check('Sensor Logger times: nanoseconds as a number or a string become milliseconds',
    msOf('1760270400123456789') === 1760270400123 && msOf(1760270400123456789) === 1760270400123 && msOf(1760270400123) === 1760270400123);
  const push = fromPush({ messageId: 3, sessionId: 'abc', deviceId: 'd', payload: [
    { name: 'location', time: 1760270400000000000, values: { latitude: 43.1, longitude: -85.5, horizontalAccuracy: 3, speed: 1.2, bearing: 90 } },
    { name: 'light', time: 1760270400200000000, values: { lux: 41000 } },
    { name: 'accelerometer', time: 1760270400300000000, values: { x: 1, y: 2, z: 3 } },
  ] });
  check('a push: its session, the fix and the light, nothing else',
    push.session === 'abc' && push.fix.length === 1 && push.fix[0][1] === 43.1 && push.fix[0][3] === 3 && push.lux.length === 1 && push.lux[0][1] === 41000, JSON.stringify(push));
  const exp = fromExport({
    'Location.csv': 'time,seconds_elapsed,bearingAccuracy,speedAccuracy,verticalAccuracy,horizontalAccuracy,speed,bearing,altitude,longitude,latitude\n1760270400000000000,0,1,1,2,3.5,1.1,45,200,-85.5,43.1\n',
    'Light.csv': 'time,seconds_elapsed,lux\n1760270400100000000,0.1,40000\n1760270400600000000,0.6,42000\n',
    'Accelerometer.csv': 'time,seconds_elapsed,z,y,x\n1760270400000000000,0,1,2,3\n',
  });
  check('an export: Location.csv for fixes, Light.csv for lux, other sensors ignored',
    exp.fix.length === 1 && exp.fix[0][3] === 3.5 && exp.lux.length === 2 && exp.lux[1][1] === 42000, JSON.stringify(exp));
  check('light per second is the second\'s median (a lone fleck of sun does not lift it), with its brightest sample',
    JSON.stringify(perSecond([[1000, 2000], [1250, 60000], [1500, 2100], [1750, 1900], [2100, 5]])) === '[[1000,2050,60000,4],[2000,5,5,1]]');
  /* A walk east at 1 m/s from sun into shade, a fill-up cut out, then a truck jump. */
  const fix = [], lux = [];
  const t0 = 1760270400000, m = 1 / 111320 / Math.cos(43.1 * Math.PI / 180);
  for (let i = 0; i < 120; i++) {
    fix.push([t0 + i * 1000, 43.1, -85.5 + i * m, 3, 1, 90]);
    lux.push([t0 + i * 1000 + 200, i < 60 ? 40000 + (i % 7) * 500 : 3000 + (i % 5) * 200]);
  }
  for (let i = 0; i < 40; i++) { fix.push([t0 + 400000 + i * 1000, 43.12, -85.5 + i * m, 3, 1, 90]); lux.push([t0 + 400000 + i * 1000, 39000]); }
  const track = joinTrack(fix, lux, { cuts: [[t0 + 10000, t0 + 19999]] });
  check('the track: each fix with its light, the cut seconds left out', track.length === 150 && !track.some((s) => s.t >= t0 + 10000 && s.t < t0 + 20000), track.length);
  const visits = splitVisits(track);
  check('visits: split where the track jumps 2 km', visits.length === 2 && visits[0].length === 110 && visits[1].length === 40, visits.map((v) => v.length).join(' '));
  const parked = [...Array(50)].map((_, i) => ({ t: t0 + i * 1000, lat: 43.1, lng: -85.5, acc: 3, speed: 0, bearing: null, lux: 1 }));
  const fast = [{ t: t0 + 60000, lat: 43.1, lng: -85.5 + 30 * m, acc: 3, speed: 15, bearing: 90, lux: 1 }];
  const u = usable([...parked, ...fast]);
  check('usable: a stop counts once, the truck not at all', u.length === 1, u.length);
  const u2 = usable(visits[0]);
  check('usable: walking at 1 m/s keeps one a meter, heading east', u2.length > 100 && near(u2[5].heading, 90, 1), `${u2.length} ${u2[5].heading}`);
  const so = sunOrShade(u2.map((s) => s.lux));
  check('sun or shade by the visit\'s own light: cut between 3,800 and 40,000, clear, the sun about 41,500',
    so.clear && so.cut > 3800 && so.cut < 40000 && near(so.sunLux, 41500, 1500) && so.sun[2] === true && so.sun[u2.length - 3] === false, `${so.cut} ${so.sunLux} ${so.contrast}`);
  const cloudy = sunOrShade([...Array(60)].map((_, i) => 12000 + (i % 9) * 900));
  check('a cloudy visit has no second group, and says so', !cloudy.clear, cloudy.contrast);
  check('the operator\'s shadow: heading east, sun in the west is behind him; sun in the south is not',
    operatorShadow(90, 270) && operatorShadow(90, 250) && !operatorShadow(90, 180) && !operatorShadow(null, 270));
  const sc = score([true, true, false, false, true], [0.9, 0.2, 0.1, 0.7, 0.8], [1, 1, 1, 1, 0]);
  check('the score: agreement and each way of disagreeing',
    sc.n === 4 && sc.sunSun === 1 && sc.shadeSun === 1 && sc.shadeShade === 1 && sc.sunShade === 1 && sc.agree === 0.5, JSON.stringify(sc));
  /* A two-file zip, one stored and one deflated, as an export arrives. */
  const enc = new TextEncoder();
  const files = [['Light.csv', enc.encode('time,lux\n1,2\n'), 0], ['dir/Location.csv', enc.encode('time,latitude,longitude\n1,43,-85\n'.repeat(20)), 8]];
  const parts = [], central = [];
  let off = 0;
  for (const [name, raw, method] of files) {
    const data = method === 8 ? deflateRawSync(raw) : raw, nm = enc.encode(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(method, 8); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(method, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, Buffer.from(nm), Buffer.from(data)); central.push(c, Buffer.from(nm));
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  const zipped = await unzipText(Buffer.concat([...parts, cd, e]), { inflate: async (d) => inflateRawSync(d) });
  check('a zip: stored and deflated entries, folders dropped from the names',
    zipped['Light.csv'] === 'time,lux\n1,2\n' && zipped['Location.csv']?.startsWith('time,latitude') && Object.keys(zipped).length === 2, Object.keys(zipped).join(','));
  check('meters between: 0.001 degree of latitude is about 111 m', near(metersBetween([43, -85], [43.001, -85]), 111.2, 0.2));

  /* Orientation (owner's first log, 2026-10-12: the phone tipped in the
     truck, flat on the hopper, its compass ~110 degrees off the travel). */
  const s15 = Math.sin(Math.PI / 12), c15 = Math.cos(Math.PI / 12);
  const flatNorth = poseOf({ qx: 0, qy: 0, qz: 0, qw: 1 }), flatEast = poseOf({ qx: 0, qy: 0, qz: -Math.SQRT1_2, qw: Math.SQRT1_2 }), tipped = poseOf({ qx: s15, qy: 0, qz: 0, qw: c15 });
  check('the pose: flat facing north, flat facing east, tipped 30 degrees',
    near(flatNorth[2], 1, 1e-9) && near(flatNorth[3], 0, 1e-9) && near(flatEast[2], 1, 1e-9) && near(flatEast[3], 90, 1e-6) && near(tipped[2], Math.cos(Math.PI / 6), 1e-9), JSON.stringify([flatNorth, flatEast, tipped]));
  const pushO = fromPush({ sessionId: 'o', payload: [{ name: 'orientation', time: 1760270400000000000, values: { qx: 0, qy: 0, qz: 0, qw: 1, roll: 0, pitch: 0, yaw: 0 } }] });
  const expO = fromExport({ 'Orientation.csv': 'time,seconds_elapsed,qz,qy,qx,qw,roll,pitch,yaw\n1760270400000000000,0,0,0,0,1,0,0,0\n1760270400010000000,0.01,-0.7071068,0,0,0.7071068,0,0,-1.57\n' });
  check('orientation from a push and from Orientation.csv', pushO.orient.length === 1 && expO.orient.length === 2 && near(expO.orient[1][4], 90, 1e-3), JSON.stringify(expO.orient));
  const ps = posePerSecond([[1000, 0, 0, 1, 359], [1500, 0, 0, 1, 3], [2000, 0.6, 0, 0.8, 90]]);
  check('pose per second: the heading averaged on the circle (359 and 3 make 1)', ps.length === 2 && near(ps[0][4], 1, 1e-6) && near(ps[1][1], 0.6, 1e-9), JSON.stringify(ps));
  const jo = joinTrack([[t0, 43.1, -85.5, 3, 1, 90], [t0 + 1000, 43.1, -85.5 + 2 * m, 3, 1, 90]], [[t0, 40000], [t0 + 1000, 41000]], { orient: [[t0, 0, 0, 1, 340], [t0 + 1000, 0.5, 0, 0.866, 340]] });
  check('the track carries the pose; usable drops the phone tipped 30 degrees', jo[0].face === 340 && jo[1].up[2] === 0.866 && usable(jo).length === 1, JSON.stringify(jo));
  const drive = [];
  for (let i = 0; i < 40; i++) drive.push({ t: t0 + i * 1000, lat: 43.1, lng: -85.5 + i * m, acc: 3, speed: 1, bearing: 90, lux: 40000 });
  for (let i = 0; i < 30; i++) drive.push({ t: t0 + 40000 + i * 1000, lat: 43.1, lng: -85.5 + (40 + 20 * i) * m, acc: 3, speed: 20, bearing: 90, lux: 40000 });
  for (let i = 0; i < 40; i++) drive.push({ t: t0 + 70000 + i * 1000, lat: 43.1, lng: -85.5 + (640 + i) * m, acc: 3, speed: 1, bearing: 90, lux: 40000 });
  check('visits: the truck at 20 m/s splits two stops even though it never jumps', splitVisits(drive).length === 2, splitVisits(drive).map((v) => v.length).join(' '));
  /* Two minutes of sun and shade, three of even shade (a tree line; clouds are not recorded), two of open sun. */
  const sky = [];
  for (let i = 0; i < 420; i++) sky.push({ t: t0 + i * 1000, lux: i < 120 ? (Math.floor(i / 10) % 2 ? 3000 : 40000) : i < 300 ? 5000 + (i % 7) * 150 : 40000 + (i % 5) * 300 });
  const around = sunOrShadeAround(sky);
  const strip = around.judged.slice(215, 295).every(Boolean) && around.sun.slice(215, 295).every((v) => v === false), early = around.sun[5] === true && around.sun[15] === false && around.judged[15], open = around.judged.slice(395).every(Boolean) && around.sun.slice(395).every(Boolean);
  check('judged around each reading: sun and shade early, a long strip of shade judged shade (not dropped as a cloud), open sun later still sun', strip && early && open, JSON.stringify({ strip, early, open }));
  /* The hopper tipping: sun read at 95,000 x cos^2.5 of its angle off the face plus 4,000 of sky, shade at 2,500. */
  check('sensor gain: cos^2.5 of the sun off the face, none from behind', near(sunGain(0), 1, 1e-9) && near(sunGain(60), 0.5 ** 2.5, 1e-9) && near(sunGain(60, 2), 0.25, 1e-9) && sunGain(95) === 0);
  const tip = [];
  for (let i = 0; i < 240; i++) {
    const off = i >= 200 ? 87 : 40 + (i * 37) % 32; // 40-71 degrees, then a face turned nearly edge-on
    const inSun = Math.floor(i / 8) % 2 === 0;
    tip.push({ t: t0 + i * 1000, gain: sunGain(off), lux: inSun ? 95000 * sunGain(off) + 4000 : 2500, inSun });
  }
  const tj = sunOrShadeAround(tip);
  const right = tip.slice(0, 200).every((s, i) => tj.judged[i] && tj.sun[i] === s.inSun);
  const edgeOn = tip.slice(200).every((s, i) => !tj.judged[200 + i] && tj.faint[200 + i]);
  check('with the angle known: every tipped reading judged right, the face-on sun found, edge-on readings left out as faint',
    right && edgeOn && Math.abs(tj.sunLux - 95000) < 8000 && Math.abs(tj.shadeLux - 2500) < 1, JSON.stringify({ right, edgeOn, sun: tj.sunLux, shade: tj.shadeLux }));
  {
    /* A stop: the phone set flat on the machine in the box (at rest 20 s), out the back (south) and round the lawn, back in, at rest, picked up. */
    const lat0 = 42.88, lng0 = -85.8, mN = 1 / 111195, mE = 1 / (111195 * Math.cos(lat0 * Math.PI / 180));
    const at = (e, n) => ({ lat: lat0 + n * mN, lng: lng0 + e * mE });
    const stop = [];
    let t = Date.parse('2026-10-13T15:00:00Z');
    const add = (e, n, up = [0, 0, 1]) => { stop.push({ t, ...at(e, n), lux: 500, up, acc: 4 }); t += 1000; };
    for (let i = 0; i < 15; i++) add(0.3 * (i % 3) - 0.3, 0.2 * (i % 2), [0.7, 0, 0.71]); // walking up, phone in hand
    for (let i = 0; i < 20; i++) add((i % 3) * 0.4 - 0.4, (i % 2) * 0.4);
    for (let i = 1; i <= 10; i++) add(0, -i); // down the ramp, south
    for (let i = 0; i < 120; i++) add(15 * Math.sin(i / 19), -10 - 15 * (1 - Math.cos(i / 19)));
    for (let i = 10; i >= 1; i--) add(0, -i);
    for (let i = 0; i < 20; i++) add((i % 2) * 0.5, -0.3 + (i % 3) * 0.3);
    for (let i = 0; i < 10; i++) add(0.5, 0, [0, 0.8, 0.6]); // picked up
    const tr = findTrucks(stop);
    const one = tr.length === 1 && Math.hypot((tr[0].lat - lat0) / mN, (tr[0].lng - lng0) / mE) < 1.5 && Math.abs(((tr[0].rear - 180 + 540) % 360) - 180) < 15;
    check('the truck from the routine: one truck where the phone rested, its back toward where the machine went out', one && flatStretches(stop).length === 1, JSON.stringify(tr.map(({ anchors, ...x }) => ({ ...x, anchors: anchors.length }))));
    const tm = stop[60].t;
    const near = truckEffect({ t: tm, ...at(2, 1) }, tr, { elevation: 30, azimuth: 180 });
    const north = (el) => truckEffect({ t: tm, ...at(0, 8) }, tr, { elevation: el, azimuth: 180 });
    const behind = truckEffect({ t: tm, ...at(0, -6) }, tr, { elevation: 15, azimuth: 180 });
    const later = truckEffect({ t: stop[stop.length - 1].t + 3600e3, ...at(2, 1) }, tr, { elevation: 30, azimuth: 180 });
    check('the truck\'s readings: beside it near, north of it in its shadow when the sun is low in the south, not at 30 degrees, not behind it on the sun side, not after it left',
      near === 'near' && north(15) === 'shadow' && north(30) === null && behind === null && later === null, JSON.stringify({ near, low: north(15), high: north(30), behind, later }));
  }
  check('the sun off the phone\'s face: flat with the sun 30 degrees up is 60; tipped toward it, less',
    near(sunOffFace(null, 30, 180), 60, 1e-6) && near(sunOffFace([0, -0.5, 0.866], 30, 180), 30, 0.1));
  const straight = [...Array(20)].map((_, i) => ({ t: t0 + i * 1000, speed: 2, bearing: 90, face: 340 + (i % 3) }));
  const wild = straight.map((s, i) => ({ ...s, face: (i * 97) % 360 }));
  const co = compassOffset(straight);
  check('the compass offset from straight runs (~110 degrees), none when the compass wanders', co && near(co.offset, 109, 1.5) && compassOffset(wild) === null, JSON.stringify(co));
}

{
  /* The readings routes over SQLite with the real schema (D1's prepare/bind/batch). */
  const sq = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
  sq.exec(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS shade_lux')));
  const stmt = (sql) => {
    const st = sq.prepare(sql);
    let args = [];
    const api = { bind(...a) { args = a; return api; }, first: async () => st.get(...args) ?? null, run: async () => ({ meta: { last_row_id: Number(st.run(...args).lastInsertRowid) } }), all: async () => ({ results: st.all(...args) }), go: () => st.run(...args) };
    return api;
  };
  const DB = { prepare: stmt, batch: async (list) => list.map((x) => x.go()) };
  sq.prepare('INSERT INTO shade_push_keys (key, created_at) VALUES (?, ?)').run('secret123', 'now');
  const json = (d, status) => new Response(JSON.stringify(d), { status });
  const call = (path, init) => handleShade(new Request(`https://x${path}`, init), new URL(`https://x${path}`), { DB }, '', null, json);
  const body = { messageId: 1, sessionId: 'day1', payload: [] };
  for (let i = 0; i < 40; i++) {
    body.payload.push({ name: 'location', time: String((1760270400000 + i * 1000) * 1e6), values: { latitude: 43.1, longitude: -85.5 + i * 1e-5, horizontalAccuracy: 3 } });
    body.payload.push({ name: 'light', time: String((1760270400000 + i * 1000 + 300) * 1e6), values: { lux: 40000 } });
    body.payload.push({ name: 'light', time: String((1760270400000 + i * 1000 + 700) * 1e6), values: { lux: 42000 } });
    for (let k = 0; k < 10; k++) body.payload.push({ name: 'orientation', time: String((1760270400000 + i * 1000 + k * 100) * 1e6), values: { qx: 0, qy: 0, qz: 0, qw: 1 } });
  }
  const r1 = await call('/api/shade/readings?key=secret123', { method: 'POST', body: JSON.stringify(body) });
  const j1 = await r1.json();
  const again = await (await call('/api/shade/readings?key=secret123', { method: 'POST', body: JSON.stringify(body) })).json();
  const rows = sq.prepare('SELECT COUNT(*) AS n FROM shade_fixes').get().n, lux = sq.prepare('SELECT lux FROM shade_lux LIMIT 1').get().lux;
  check('a push with the key is stored: 40 fixes, 40 seconds of light averaged, a repeat ignored',
    r1.status === 200 && j1.fix === 40 && j1.lux === 40 && rows === 40 && lux === 41000 && again.ok && sq.prepare('SELECT COUNT(*) AS n FROM shade_lux').get().n === 40, JSON.stringify(j1));
  const plog = sq.prepare('SELECT status, entries, lux, fix, orient FROM shade_push_log ORDER BY id').all();
  check('every push is logged: kept, with what it carried', plog.length === 2 && plog[0].status === 200 && plog[0].entries === 520 && plog[0].lux === 40 && plog[0].orient === 40, JSON.stringify(plog));
  check('the pose is stored one per second, flat', j1.orient === 40 && sq.prepare('SELECT COUNT(*) AS n FROM shade_orient').get().n === 40 && sq.prepare('SELECT nz FROM shade_orient LIMIT 1').get().nz === 1, JSON.stringify(j1));
  const bad = await call('/api/shade/readings?key=wrong', { method: 'POST', body: JSON.stringify(body) });
  const anon = await call('/api/shade/readings/sessions', { method: 'GET' });
  const anonPost = await call('/api/shade/readings', { method: 'POST', body: JSON.stringify(body) });
  check('a wrong key, or no sign-in, is a 404 like the console\'s routes', bad.status === 404 && anon.status === 404 && anonPost.status === 404, `${bad.status} ${anon.status} ${anonPost.status}`);
  const junk = await call('/api/shade/readings?key=secret123', { method: 'POST', body: '{nope' });
  check('bad JSON is a 400', junk.status === 400);
  const refused = sq.prepare("SELECT status, error FROM shade_push_log WHERE status <> 200 ORDER BY id").all();
  check('refused pushes are logged too: the wrong address and the bad JSON', refused.length === 2 && refused[0].status === 404 && refused[1].status === 400, JSON.stringify(refused));
  const { pushes } = await import('./shade-readings.js');
  const pl = pushes([{ at: new Date(Date.now() - 60e3).toISOString(), status: 500, entries: 10, bytes: 999, ms: 12, error: 'boom' }]);
  check('readings report: refused pushes are counted and say why', /REFUSED 500/.test(pl) && /boom/.test(pl) && /1 of these 1 refused/.test(pl), pl);
}

{
  /* Where the model's shade comes from along a low sun's ray (tools/shade-ray-check.js; owner,
     2026-10-14: is the leaf filling lowering the crowns?). A tall leaf-off tree, crown 8-16 m
     up, with a shrub at 2.5-3.5 m touching it -- one clump, so its leaves start at the shrub's
     height -- and a phone 12 m north of the trunk with the sun low in the south, its ray
     passing under the crown. */
  const { canopyParts, rayParts, branchFloor } = await import('./shade-ray-check.js');
  const lat = 40, k = mercScale(lat);
  const grid = gridOver([0, 0, 60 / k, 60 / k], 1, lat);
  let seed = 5;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pts = [];
  for (let e = 0.125; e < 60; e += 0.25) for (let n = 0.125; n < 60; n += 0.25) {
    const inTree = Math.hypot(e - 30, n - 30) < 6, inShrub = e >= 35.5 && e < 40 && n >= 27 && n < 33;
    if (inTree && rnd() < 0.3) { pts.push([e, n, 108 + rnd() * 8, 1, 1, 2], [e, n, 100, 2, 2, 2]); continue; }
    if (inShrub && rnd() < 0.5) { pts.push([e, n, 102.5 + rnd(), 1, 1, 2], [e, n, 100, 2, 2, 2]); continue; }
    pts.push([e, n, 100, 2, 1, 1]);
  }
  const cols = makeColumns(pts.length);
  pts.forEach(([e, n, z, c, r, nr], i) => { cols.x[i] = e / k; cols.y[i] = n / k; cols.z[i] = z; cols.cls[i] = c; cols.ret[i] = r; cols.nret[i] = nr; });
  const model = buildCanopy(cols, grid);
  const season = seasonalCanopy(cols, model);
  const site = { model, season, cols, grid, shift: null };
  const at = (e, n) => Math.floor(60 - n) * grid.w + Math.floor(e);
  const fl = branchFloor(site);
  check('ray check: the lowest branch the laser saw is the crown\'s, 8 m, under the tree and the shrub\'s under the shrub', Math.abs(fl[at(30, 30)] - 8) < 0.5 && fl[at(38, 30)] < 3.6, `${fl[at(30, 30)]} ${fl[at(38, 30)]}`);
  const cp = canopyParts(site, season.muOn);
  const R = Math.PI / 180, el = 20 * R, dir = [0, -Math.cos(el), Math.sin(el)]; // sun due south, 20 degrees up
  const gx = 30, gy = 60 - 42, z = groundAt(model, gx, gy) + 1.27;
  const asIs = transmittance({ ...model, mu: season.muOn }, gx, gy, z, dir), noLow = transmittance({ ...model, mu: cp.noLowLeaves }, gx, gy, z, dir);
  const rp = rayParts(model, cp.parts, gx, gy, z, dir);
  check('ray check: the leaves put below the crown stop a low sun that passes under it; without them it reaches the phone',
    asIs < 0.5 && noLow > 0.9 && rp.tau.leafLow / rp.total > 0.9 && rp.heightOver > 2 && rp.heightOver < 8, `${asIs.toFixed(2)} ${noLow.toFixed(2)} ${JSON.stringify(rp)}`);
  const sum = new Float32Array(cp.parts.measured.length);
  for (const p of Object.values(cp.parts)) for (let i = 0; i < sum.length; i++) sum[i] += p[i];
  let worst = 0;
  for (let i = 0; i < sum.length; i++) worst = Math.max(worst, Math.abs(sum[i] - season.muOn[i]));
  check('ray check: the parts add up to the model', worst < 1e-5, worst);
}

{
  /* The leaf fill against NEON's leaf-on lidar (tools/shade-check-leafon.js): the pure parts. */
  const { utmToLatLng, bestShift } = await import('./shade-check-leafon.js');
  const [la, lo] = utmToLatLng(500000, 4300000, 17);
  const [la2, lo2] = utmToLatLng(756500, 4337500, 17);
  /* 38.84882: where the meridian arc (integrated numerically, x0.9996) is 4,300,000 m. */
  check('leaf-on check: UTM to latitude and longitude (zone 17: the central meridian, and 256 km east of it)',
    Math.abs(lo + 81) < 1e-9 && Math.abs(la - 38.84882) < 1e-5 && Math.abs(lo2 + 78.0319) < 0.001 && Math.abs(la2 - 39.1489) < 0.001, `${la} ${lo} ${la2} ${lo2}`);
  const w = 40, h = 40, A = new Float32Array(w * h).fill(NaN), B = new Float32Array(w * h).fill(NaN);
  let sd = 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { sd = (sd * 1103515245 + 12345) % 2147483648; A[y * w + x] = 100 + (sd % 997) / 50; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const xs = x - 2, ys = y + 1; if (xs >= 0 && ys < h) B[y * w + x] = A[ys * w + xs]; }
  const bs = bestShift(A, B, w, h, 4);
  check('leaf-on check: the cloud move that fits the tops is found', bs.dx === 2 && bs.dy === -1, JSON.stringify(bs));
}

{
  /* The readings follow the lidar onto the photo (truth-ui.js moveTrack), and the field check's GPS offset scan. */
  const { moveTrack } = await import('../public/shade/truth-ui.js');
  const fx = [[1, 43, -85.5, 3, 1, 90]];
  const mv = moveTrack(fx, [1, -2]);
  check('check view: the track moves as the lidar did, meters east and north; no move leaves it alone',
    Math.abs((mv[0][1] - 43) * 111320 + 2) < 1e-6 && Math.abs((mv[0][2] + 85.5) * 111320 * Math.cos(43 * Math.PI / 180) - 1) < 1e-6 && mv[0][3] === 3 && moveTrack(fx, [0, 0]) === fx && moveTrack(fx, null) === fx);
  const { offsetScan, OFFSETS } = await import('./shade-field-check.js');
  const j = OFFSETS.findIndex(([e, n]) => e === 2 && n === -1);
  const scan = offsetScan([...Array(10)].map((_, i) => ({ phoneSun: i % 2 === 0, off: Float32Array.from(OFFSETS, (_, q) => (q === j ? (i % 2 === 0 ? 1 : 0) : 0.3)) })));
  check('field check: the GPS move that fits best is found, against the track as recorded', scan.best.e === 2 && scan.best.n === -1 && scan.best.agree === 10 && scan.atZero === 5, JSON.stringify(scan.best));
}

{
  /* The trees page (public/shade/trees-ui.js): the model's columns as runs of light-stopping cubes. */
  const { treeRuns, overhead, kindOf, BANDS } = await import('../public/shade/trees-ui.js');
  const nz = 20, model = { w: 2, h: 1, nz, dz: 1, z0: 100, ground: Float32Array.from([100, 100]) };
  const mu = new Float32Array(2 * nz);
  for (let l = 8; l < 16; l++) mu[l] = 0.2; // a crown 8-16 m up, about 82% a meter through
  for (let l = 14; l < 16; l++) mu[l] = 1.5; // its top 2 m dense
  for (let l = 0; l < 9; l++) mu[nz + l] = 4.6; // a roof 9 m tall, solid
  const season = { classified: true, kind: Uint8Array.from([3, 1]), muOn: mu, muOff: mu };
  const runs = treeRuns(model, mu, season);
  check('trees page: a crown is drawn from its lowest to its highest cube, split where its density changes; the roof from the ground',
    runs.length === 3 && runs[0].base === 8 && runs[0].top === 14 && runs[0].kind === 'deciduous' && runs[1].base === 14 && runs[1].top === 16 && runs[1].band === BANDS.length - 1
    && runs[2].kind === 'roof' && runs[2].base === 0 && runs[2].top === 9, JSON.stringify(runs));
  check('trees page: buildings can be left out, and everything below a height cut away',
    treeRuns(model, mu, season, { roofs: false }).length === 2 && treeRuns(model, mu, season, { cutBelow: 10 })[0].base === 10);
  check('trees page: the overhead sun through the crown, and a column with leaves filled in is told apart',
    Math.abs(overhead(model, mu, 0) - Math.exp(-(0.2 * 6 + 1.5 * 2))) < 1e-6 && kindOf({ classified: true, kind: [0] }, 0, true) === 'filled' && kindOf(null, 0, false) === 'other');
}

{
  /* Shade usage and errors (worker/src/shade-usage.js): visitors only, nothing that places anyone. */
  const { isAutomated, scrub, usageReport } = await import('../worker/src/shade-usage.js');
  const phone = 'Mozilla/5.0 (Linux; Android 14; SM-G998U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  check('automated callers are told apart: headless Chrome, node, curl, GitHub, Claude, bots, no agent; a phone is a visitor',
    ['Mozilla/5.0 HeadlessChrome/129.0', 'node', 'undici', 'curl/8.5', 'python-requests/2.31', 'GitHub-Hookshot/1', 'Claude-User/1.0', 'Googlebot/2.1', ''].every(isAutomated) && !isAutomated(phone));
  check('error text keeps no coordinates or house numbers', scrub('No lidar at 12.34567,-98.76543 for 4321 Elm') === 'No lidar at #,# for # Elm', scrub('No lidar at 12.34567,-98.76543 for 4321 Elm'));
  const qs = scrub('Failed to fetch https://x/api/geocode?q=12%20Elm%20St%20Springfield (502) at shade.js:88');
  check('error text keeps no query string: a failing URL\'s address or point is cut', qs === 'Failed to fetch https://x/api/geocode?… (#) at shade.js:88' && !/Elm/.test(qs), qs);
  const sq = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
  sq.exec(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS shade_lux')));
  const stmt = (sql) => { const st = sq.prepare(sql); let args = []; const api = { bind(...a) { args = a; return api; }, first: async () => st.get(...args) ?? null, run: async () => ({}), all: async () => ({ results: st.all(...args) }) }; api.run = async () => { st.run(...args); return {}; }; return api; };
  const DB = { prepare: stmt };
  const json = (d, status) => new Response(JSON.stringify(d), { status });
  const call = (path, init, ua = phone) => handleShade(new Request(`https://x${path}`, { ...init, headers: { 'User-Agent': ua, 'Content-Type': 'application/json' } }), new URL(`https://x${path}`), { DB }, '', null, json);
  const post = (path, body, ua) => call(path, { method: 'POST', body: JSON.stringify(body) }, ua);
  const client = 'abcdef12-3456-7890-abcd-ef1234567890';
  const r1 = await post('/api/shade/event', { kind: 'open', detail: 'blank', client, page: 'shade' });
  await post('/api/shade/event', { kind: 'built', detail: '42 s, lined up', client });
  await post('/api/shade/event', { kind: 'open', client }, 'Mozilla/5.0 HeadlessChrome/129.0');
  await post('/api/shade/event', { kind: 'open', client, self: true });
  await post('/api/shade/error', { where: 'status', message: 'The map would not load at 12.34567,-98.76543', client });
  await post('/api/shade/error', { where: 'status', message: 'boom' }, 'node');
  const ev = sq.prepare('SELECT kind, client, detail FROM shade_events ORDER BY id').all(), er = sq.prepare('SELECT source, message FROM shade_errors').all();
  check('usage: a visitor\'s events and errors kept; automated callers and the owner\'s own device are not; numbers blanked',
    r1.status === 204 && ev.length === 2 && ev[0].kind === 'open' && ev[1].detail === '42 s, lined up' && er.length === 1 && er[0].message === 'The map would not load at #,#', JSON.stringify({ ev, er }));
  const bad = await post('/api/shade/event', { kind: '<script>' });
  const anon = await call('/api/shade/admin/usage', { method: 'GET' });
  check('usage: a junk kind is refused; the figures are a 404 to anyone not an admin', bad.status === 400 && anon.status === 404, `${bad.status} ${anon.status}`);
  const rep = await usageReport(DB);
  check('usage report: visitors, opens, builds and errors over 1/7/30 days, by kind and by day, latest rows',
    rep.totals.day.visitors === 1 && rep.totals.month.opens === 1 && rep.totals.month.builds === 1 && rep.totals.week.errors === 1 && rep.byKind.length === 2 && rep.byDay.length === 1 && rep.events.length === 2 && rep.errors.length === 1, JSON.stringify(rep.totals));
  const { usageHtml, errorsHtml } = await import('../public/shade/admin.js');
  const uh = usageHtml(rep), eh = errorsHtml(rep);
  check('admin page: tiles, bars, the kinds and the latest rows; the errors listed', /visitors today/.test(uh) && /class="bars"/.test(uh) && /built/.test(uh) && /abcdef/.test(uh) && /The map would not load at #,#/.test(eh), uh.slice(0, 200));

  /* An error carries its place in its own columns (owner, 2026-10-14), admin-only, blanked after 90 days. */
  const { placeOf, forgetOldPlaces, logServerError, PLACE_DAYS } = await import('../worker/src/shade-usage.js');
  check('error place: the address one line and short, the point to five decimals, junk points dropped',
    JSON.stringify(placeOf({ place: ' 12 Elm St,\n Springfield ', lng: -85.123456789, lat: 42.987654321 })) === '{"place":"12 Elm St, Springfield","lng":-85.12346,"lat":42.98765}'
    && placeOf({ lng: 'x', lat: 1 }).lng === null && placeOf({ lng: 10, lat: 89 }).lat === null && placeOf({ lng: null, lat: null }).lng === null && placeOf(null).place === null);
  await post('/api/shade/error', { where: 'status', message: 'No lidar answered', place: '12 Elm St, Springfield', lng: -85.123456, lat: 42.987654, client });
  await logServerError(new Request('https://x/', { headers: { 'User-Agent': phone } }), { DB }, 'lidar', 'The lidar index could not be read', { lng: -85.5, lat: 43.1 });
  const placed = sq.prepare('SELECT source, message, place, lng, lat FROM shade_errors WHERE lng IS NOT NULL ORDER BY id').all();
  check('error place: kept with a page error (address and point) and a server error (point); the message itself still blanks numbers',
    placed.length === 2 && placed[0].place === '12 Elm St, Springfield' && placed[0].lng === -85.12346 && placed[0].lat === 42.98765 && placed[1].source === 'server' && placed[1].lat === 43.1 && placed[1].place === null, JSON.stringify(placed));
  const rep2 = await usageReport(DB);
  check('error place: the admin report carries it', rep2.errors.some((e) => e.place === '12 Elm St, Springfield' && e.lat === 42.98765));
  sq.prepare("UPDATE shade_errors SET at = ? WHERE place = '12 Elm St, Springfield'").run(new Date(Date.now() - (PLACE_DAYS + 1) * 86400000).toISOString());
  await forgetOldPlaces(DB);
  const aged = sq.prepare("SELECT message, place, lng, lat FROM shade_errors WHERE message = 'No lidar answered'").get();
  const fresh = sq.prepare("SELECT lng FROM shade_errors WHERE source = 'server'").get();
  check(`error place: blanked after ${PLACE_DAYS} days, the error kept; a newer one untouched`, aged && aged.place === null && aged.lng === null && aged.lat === null && fresh.lng === -85.5, JSON.stringify(aged));
  const { placeHtml } = await import('../public/shade/admin.js');
  const ph = placeHtml({ place: '12 <b>Elm</b>', lng: -85.12346, lat: 42.98765 });
  check('admin page: an error\'s place escaped, its point a link that opens the shade map there; none is a dash',
    /12 &lt;b&gt;Elm/.test(ph) && /href="\/shade\?at=42\.98765%2C%20-85\.12346"/.test(ph) && /—/.test(placeHtml({ place: null, lng: null, lat: null })), ph);
}

{
  /* Tracing the property by hand when an address has no property line (shade/trace.js). */
  const { lotFeature, lotSqFt, lotProblem, lotParam, parseLot, spanM, MAX_SPAN_M } = await import('../public/shade/trace.js');
  const d = 30 / 111320, lat0 = 42.9, k = Math.cos(lat0 * Math.PI / 180);
  const sq30 = [[-85.5, lat0], [-85.5 + d / k, lat0], [-85.5 + d / k, lat0 + d], [-85.5, lat0 + d]];
  const f = lotFeature(sq30);
  check('trace: the corners close into a polygon; under three is nothing',
    f.geometry.type === 'Polygon' && f.geometry.coordinates[0].length === 5 && f.geometry.coordinates[0][4][0] === sq30[0][0] && lotFeature(sq30.slice(0, 2)) === null);
  check('trace: a 30 m square is about 9,700 sq ft and 30 m across', Math.abs(lotSqFt(sq30) - 9688) < 60 && Math.abs(spanM(sq30) - 30) < 0.5, `${lotSqFt(sq30)} ${spanM(sq30)}`);
  const big = sq30.map(([x, y]) => [-85.5 + (x + 85.5) * 12, lat0 + (y - lat0) * 12]);
  const line = [[-85.5, lat0], [-85.4999, lat0], [-85.4998, lat0]];
  check(`trace: refused when under three corners, over ${MAX_SPAN_M} m across, or with no area`,
    lotProblem(sq30) === null && /three/.test(lotProblem(sq30.slice(0, 2))) && /across/.test(lotProblem(big)) && /no area/.test(lotProblem(line)));
  const back = parseLot(lotParam(sq30));
  check('trace: the outline survives the link, to six decimals; a bad or oversized one is refused',
    back.length === 4 && back.every((p, i) => Math.abs(p[0] - sq30[i][0]) < 1e-6 && Math.abs(p[1] - sq30[i][1]) < 1e-6)
    && parseLot('1,2;3') === null && parseLot('') === null && parseLot(null) === null && parseLot(lotParam(big)) === null && parseLot('-85.5,42.9;x,y;1,1') === null);
}

{
  /* Workflow 35's report: counts and times, never a place. */
  const { report } = await import('./shade-readings.js');
  const now = Date.UTC(2026, 9, 13, 18, 0);
  const r = report([{ session: 'abc', first: now - 3600e3, last: now - 120e3, fixes: 3400, lux: 1500, lastLux: now - 125e3, orient: 1500 }], { n: 1, made: '2026-10-12' }, now);
  check('readings report: how long ago, the light share, orientation, and the sleepy sensor flagged',
    /newest reading 2 min ago/.test(r) && /Light came in for 43%/.test(r) && /LOW/.test(r) && /orientation is arriving/.test(r) && !/\d+\.\d{4}/.test(r), r);
  check('readings report: nothing yet says so', /nothing has arrived/.test(report([], { n: 0 }, now)));
  const { localMs, tiltWindow } = await import('./shade-readings.js');
  const noonish = Date.parse('2026-10-13T12:00:00Z');
  check('readings window: local times read in New York time (EDT in October)', localMs('12:38', noonish) === Date.parse('2026-10-13T16:38:00Z') && localMs('2026-01-05 09:00') === Date.parse('2026-01-05T14:00:00Z') && Number.isNaN(localMs('noon')));
  const tw = tiltWindow([[noonish, 50000], [noonish + 1000, 9000]], [[noonish, 0, 0, 1, 0], [noonish + 1000, 0, -Math.sin(Math.PI / 4), Math.cos(Math.PI / 4), 0]], () => ({ elevation: 45, azimuth: 180 }));
  check('readings window: tilt, face heading and the sun off the face, no places', /50000\s+0°\s+0°\s+45°/.test(tw) && /9000\s+45°\s+180°\s+0°/.test(tw) && /sun 45° up at 180°/.test(tw) && !/\d\.\d{3}/.test(tw), tw);
  const { sunLevels } = await import('./shade-readings.js');
  const lv = [];
  for (let i = 0; i < 200; i++) { const gain = 0.2 + (i % 9) * 0.05; lv.push({ t: noonish + i * 1000, el: 38, gain, lux: Math.floor(i / 8) % 2 ? 2000 : 90000 * gain + 4000 }); }
  const lt = sunLevels(lv);
  check('readings levels: face-on sun and shade per half hour, with the counts', /sun 38° up\s+200 readings\s+face-on sun\s+9\d,\d{3} \(brightest tenth\s+[\d,]+\), shade\s+2,000; \d+ sun, \d+ shade/.test(lt), lt);
  const { lidarAges } = await import('./shade-readings.js');
  const la = lidarAges([{ used: { year: 2016, end: Date.UTC(2018, 1, 5) }, newer: [] }, { used: { year: 2016, end: Date.UTC(2018, 1, 5) }, newer: [] }, { used: { year: 2015, end: null }, newer: [{ end: Date.UTC(2023, 3, 1), tiles: true }] }]);
  check('readings lidar: areas grouped by flight, a newer one not used called out, no names', /2 areas: flown to 2018-02; nothing newer/.test(la) && /1 area : flown in 2015; NEWER FLIGHT NOT USED: 2023 \(download tiles only\)/.test(la), la);
  const { sessionLabel } = await import('./shade-readings.js');
  check('readings: an uploaded file\'s name (maybe a street) never printed, Sensor Logger\'s uuid as is', /^upload #[0-9a-f]{8}$/.test(sessionLabel('upload a7f42cff-Some_Street-2026-10-12')) && sessionLabel('32676200-a76a-4dc1-b4c4-72b950a880e3') === '32676200-a76a-4dc1-b4c4-72b950a880e3' && !/Street/.test(report([{ session: 'upload Some_Street', first: 1, last: 2, fixes: 1, lux: 1, orient: 0 }], { n: 1, made: 'x' })));
  const { pickSessions } = await import('./shade-field-check.js');
  const picked = pickSessions([{ session: 'abc', a: 0, b: 100 }, { session: 'upload day', a: 50, b: 300 }, { session: 'later', a: 400, b: 500 }]).map((r) => r.session).join(',');
  check('field check: an uploaded day wins over the pushed recording it overlaps; others stay', picked === 'upload day,later', picked);
  const { addUp, sourceLine } = await import('./shade-field-photos.js');
  const tly = (n, photo, model, mo, po) => ({ n, photo, model, both: model - mo, modelOnly: mo, photoOnly: po, lit: n - model - po });
  const ph = addUp([{ source: 'county ImageService/Aerial2021', year: 2021, leaf: 'on', trees: tly(100, 10, 20, 12, 2), treesOtherSeason: tly(100, 10, 12, 5, 3) }, { source: 'mapbox', skip: 'buildings\' shadows only 1.4x darker' }, { source: 'county X', year: 2024, leaf: 'off', trees: tly(50, 4, 5, 2, 1), treesOtherSeason: tly(50, 4, 9, 6, 1) }]);
  const pl = [...ph].map(([k, a]) => sourceLine(k, a)).join('\n');
  check('photos against the lidar: by source year, the leafy and bare canopies both, skips counted, no places', /county 2021 \(1 square, read as 1 leaf-on\)/.test(pl) && /trees in leaf: model shade 20%, agree 86%, model only 12%, photo only 2%/.test(pl) && /county 2024[\s\S]*trees bare: model shade 10%, agree 94%/.test(pl) && /mapbox: not scored \(1 buildings' shadows only Nx darker\)/.test(pl) && !/Aerial|\d\.\d{4}/.test(pl), pl);
  const { timeline } = await import('./shade-readings.js');
  const tl = timeline([{ t: now, fixes: 290, lux: 280, orient: 295, speed: 1.3 }, { t: now + 300e3, fixes: 60, lux: 0, orient: 0, speed: null }]);
  check('readings timeline: five-minute steps with counts and mph, no places', /gps 290\s+light 280\s+orientation 295\s+3 mph/.test(tl) && /-\s*mph/.test(tl), tl);
}

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nshade map: ok');
