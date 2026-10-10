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
import { indexEntry } from './shade-lidar-index.js';
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
  const e = indexEntry({ properties: { name: 'X_2019', url: 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/X_2019/ept.json', count: 1000 },
    geometry: { type: 'MultiPolygon', coordinates: [[[[-1, 0], [1, 0], [1, 1], [-1, 1], [-1, 0]]]] } });
  check('index entry: a box, no URL when it is the usual one', e && !e.url && e.bbox.join() === '-1,0,1,1' && e.km2 > 1000, JSON.stringify(e));
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

/* ------------------------------------------------------------- view */

check('kinds: ground, low, through (pulse went on), solid',
  kindOf(2, 1, 1, 0) === 'ground' && kindOf(1, 1, 1, 0.5) === 'low' && kindOf(1, 1, 3, 8) === 'through' && kindOf(1, 1, 1, 8) === 'solid' && kindOf(1, 3, 3, 8) === 'solid');
check('mercator units: the origin is the middle of the world', mercUnits(0, 0).every((v) => near(v, 0.5, 1e-12)));

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nshade map: ok');
