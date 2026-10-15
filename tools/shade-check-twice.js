/**
 * TWICE-FLOWN STREETS (owner, 2026-10-14: "Some places in the USGS catalogue
 * were flown twice, once in leaf and once without ... run it"). The NEON test
 * (shade-check-leafon.js, findings 13-14) put the leaf fill against a laser
 * that saw the leaves, but in research forests. 3DEP itself has flown a few
 * towns in summer and again bare, which is the same test over lawns, houses
 * and street trees:
 *
 *   OURS    the page's model from the LEAF-OFF flight, summer leaves filled in
 *   TRUTH   the same canopy maths on the LEAF-ON flight as flown (solid only
 *           under roofs)
 *
 * Pairs come from the footprints and WESM's collection dates: the leaf-on
 * flight inside June-September, the other leaf-off, east of 100 W (broadleaf
 * country), at most MAX_GAP years apart; windows of 250 m inside a Census
 * 2020 urban area and both flights' outlines, kept when they hold houses
 * (roofs 3%+ of the ground) and trees (10%+). Scored as in the NEON test,
 * plus the sky view (the diffuse half of the light).
 *
 *   node tools/shade-check-twice.js [maxWindows]
 *
 * Counts and shares, and the flights' names; never a window's place.
 */

import { writeFileSync } from 'node:fs';
import { FOOTPRINTS, lidarAt, covers } from '../worker/src/shade.js';
import { WESM, leafSeason } from '../public/shade/find.js';
import { pointsIn, toMerc, mercScale, walk, hierarchyReader } from '../public/shade/ept.js';
import { lazDecoder } from '../public/shade/laz.js';
import { compareWindow, report } from './shade-check-leafon.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_GAP = Number(process.env.MAX_GAP) || 3;
const WIN_M = 250, MARGIN_M = 40, STEP_M = 700;
const URBAN = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Urban/MapServer/0/query';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function get(u, as = 'json', tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`${r.status}`);
      return as === 'json' ? await r.json() : await r.arrayBuffer();
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
    }
  }
}

const vendor = (f) => fileURLToPath(new URL(`../public/shade/vendor/${f}`, import.meta.url));
let factory = null;
function lazCreate(opts) {
  if (!factory) {
    // eslint-disable-next-line no-new-func
    const create = new Function('window', 'process', 'require', `${readFileSync(vendor('laz-perf.js'), 'utf8')}; return createLazPerf;`)({ location: { href: '' } }, undefined, undefined);
    const wasmBinary = readFileSync(vendor('laz-perf.wasm'));
    factory = (o) => create({ ...o, wasmBinary });
  }
  return factory(opts);
}
const io = { getJson: (u) => get(u, 'json'), getBytes: (u) => get(u, 'bytes'), decompress: lazDecoder(() => lazCreate) };

/**
 * When the laser actually passed over a box: the GPS times of the points in
 * one of the deepest octree nodes there, as [first, median, last] in ms, or
 * null (no GPS time, or GPS week time). WESM's dates span a whole campaign
 * (one ran March to November), the points' own times say which swath.
 */
export async function flightDays(eptUrl, box3857) {
  const base = eptUrl.replace(/\/ept\.json$/, '');
  const ept = await get(`${base}/ept.json`);
  const nodes = await walk(ept.bounds, box3857, hierarchyReader(base, (u) => get(u)));
  const deep = nodes.sort((a, b) => Number(b.key.split('-')[0]) - Number(a.key.split('-')[0]))[0];
  if (!deep) return null;
  const { header, points } = await io.decompress(await get(`${base}/ept-data/${deep.key}.laz`, 'bytes'));
  const at = [1, 3, 4, 5].includes(header.format) ? 20 : header.format >= 6 ? 22 : -1;
  if (at < 0) return null;
  const dv = new DataView(points.buffer, points.byteOffset, points.byteLength), L = header.recordLength, n = Math.floor(points.byteLength / L);
  const ts = [];
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 2000))) {
    const g = dv.getFloat64(i * L + at, true);
    if (g > 1e5 && g < 2e9) ts.push(GPS_EPOCH + (g < 1e9 ? g + 1e9 : g) * 1000);
  }
  if (ts.length < 10) return null;
  ts.sort((a, b) => a - b);
  return [ts[0], ts[ts.length >> 1], ts[ts.length - 1]];
}
const GPS_EPOCH = Date.UTC(1980, 0, 6);

/** Leaf state by date (northern broadleaf): 'on' 1 Jun - 15 Sep, 'off' 10 Nov - 20 Apr, else null. */
export function leafByDate(ms) {
  const d = new Date(ms), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  if ((m >= 6 && m <= 8) || (m === 9 && day <= 15)) return 'on';
  if (m === 12 || m <= 3 || (m === 11 && day >= 10) || (m === 4 && day <= 20)) return 'off';
  return null;
}

/** A footprint's bounding box. */
function bboxOf(geom) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  walk(geom.coordinates);
  return [w, s, e, n];
}

/** Is a WESM collection a summer one (June-September, under four months)? */
export function summer(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 120 * 864e5) return false;
  const m0 = new Date(start).getUTCMonth() + 1, m1 = new Date(end).getUTCMonth() + 1;
  return m0 >= 6 && m1 <= 9 && m0 <= m1;
}

/** Leaf-on / leaf-off pairs of flights whose boxes overlap. */
export async function findPairs() {
  const feats = (await get(FOOTPRINTS)).features.map((f) => ({ name: f.properties.name, bbox: bboxOf(f.geometry) }));
  const units = [];
  for (let off = 0; ; off += 1000) {
    const q = new URLSearchParams({ where: '1=1', outFields: 'workunit,collect_start,collect_end', returnGeometry: 'false', f: 'json', resultOffset: String(off), resultRecordCount: '1000', orderByFields: 'workunit' });
    const j = await get(`${WESM}?${q}`);
    if (!j.features?.length) break;
    units.push(...j.features.map(({ attributes: a }) => ({ key: norm(a.workunit), start: a.collect_start, end: a.collect_end })));
    if (j.features.length < 1000) break;
  }
  const unitOf = (name) => { const n = norm(name); return units.filter((u) => u.key && n.includes(u.key)).sort((a, b) => b.key.length - a.key.length)[0] || null; };
  const P = feats.map((f) => ({ ...f, unit: unitOf(f.name) })).filter((f) => f.unit && f.bbox[2] > -100);
  const on = P.filter((p) => summer(p.unit.start, p.unit.end)), off = P.filter((p) => leafSeason(p.unit.start, p.unit.end) === 'off');
  const pairs = [];
  for (const a of on) for (const b of off) {
    const box = [Math.max(a.bbox[0], b.bbox[0]), Math.max(a.bbox[1], b.bbox[1]), Math.min(a.bbox[2], b.bbox[2]), Math.min(a.bbox[3], b.bbox[3])];
    const gap = Math.abs((a.unit.start + a.unit.end) / 2 - (b.unit.start + b.unit.end) / 2) / (365.25 * 864e5);
    if (box[2] > box[0] && box[3] > box[1] && gap <= MAX_GAP) pairs.push({ on: a.name, off: b.name, box, gap });
  }
  return pairs.sort((x, y) => x.gap - y.gap);
}

async function urban(lng, lat) {
  const q = new URLSearchParams({ geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'NAME', returnGeometry: 'false', f: 'json' });
  const j = await get(`${URBAN}?${q}`).catch(() => null);
  return !!j?.features?.length;
}

/** Candidate window centres for a pair: a grid over the overlap, in town, under both flights. */
export async function windowsFor(pair, max = 6) {
  const [w, s, e, n] = pair.box, lat0 = (s + n) / 2;
  const dLat = STEP_M / 111320, dLng = STEP_M / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const pts = [];
  for (let lat = s + dLat / 2; lat < n; lat += dLat) for (let lng = w + dLng / 2; lng < e; lng += dLng) pts.push([lng, lat]);
  /* Spread the tries over the overlap rather than walking it from one corner. */
  const order = pts.map((p, i) => [p, (i * 2654435761) % 4294967296]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  const out = [];
  let tries = 0;
  for (const [lng, lat] of order) {
    if (out.length >= max || ++tries > 200) break;
    if (!(await urban(lng, lat))) continue;
    const found = await lidarAt(lng, lat).catch(() => null);
    const cOn = found?.clouds?.find((c) => c.name === pair.on), cOff = found?.clouds?.find((c) => c.name === pair.off);
    if (cOn && cOff) out.push({ lng, lat, cOn, cOff });
  }
  return out;
}

export async function twiceCheck(maxWindows = 24) {
  const pairs = await findPairs();
  const rows = [], log = [`${pairs.length} leaf-on/leaf-off pairs of flights within ${MAX_GAP} years, east of 100 W.`];
  for (const pair of pairs) {
    if (rows.filter((r) => !r.skip).length >= maxWindows) break;
    const wins = await windowsFor(pair);
    let kept = 0;
    for (const wdw of wins) {
      if (rows.filter((r) => !r.skip).length >= maxWindows) break;
      const k = mercScale(wdw.lat), half = (WIN_M / 2 + MARGIN_M) / k, [cx, cy] = toMerc([wdw.lng, wdw.lat]);
      const box3857 = [cx - half, cy - half, cx + half, cy + half];
      try {
        const truth = (await pointsIn(wdw.cOn.url, box3857, io)).cols;
        const r = await compareWindow({ cloud: wdw.cOff, box3857, lat: wdw.lat, lng: wdw.lng, neonCols: truth, truthFill: false, sky: true });
        if (r.roofShare < 0.03 || r.crownShare < 0.1) { rows.push({ skip: `${r.roofShare < 0.03 ? 'no houses' : 'few trees'}` }); continue; }
        rows.push({ site: `${pair.on} / ${pair.off}`, tile: [], win: kept++, ...r });
      } catch (e) {
        rows.push({ skip: `error: ${e.message}` });
      }
    }
    log.push(`  ${pair.on} (leaf-on) / ${pair.off} (leaf-off), ${pair.gap.toFixed(1)} years apart: ${wins.length} windows in town, ${kept} with houses and trees`);
  }
  return { rows, log };
}

/* Eastern and midwestern metros (broadleaf country, 33-47 N), for sampling
   by the points' own clocks rather than WESM's dates. City centres only. */
export const METROS = [[-84.39, 33.75], [-86.80, 33.52], [-86.78, 36.16], [-84.51, 39.10], [-83.00, 39.96], [-81.69, 41.50], [-83.05, 42.33], [-85.67, 42.96], [-87.63, 41.88], [-87.91, 43.04], [-89.40, 43.07], [-93.27, 44.98], [-93.61, 41.59], [-94.58, 39.10], [-90.20, 38.63], [-86.16, 39.77], [-85.76, 38.25], [-84.50, 38.04], [-80.84, 35.23], [-78.64, 35.78], [-79.79, 36.07], [-77.44, 37.54], [-76.29, 36.85], [-77.04, 38.91], [-76.61, 39.29], [-75.17, 39.95], [-75.49, 40.60], [-76.88, 40.27], [-79.99, 40.44], [-73.76, 42.65], [-76.15, 43.05], [-77.61, 43.16], [-78.88, 42.89], [-71.06, 42.36], [-72.68, 41.76], [-71.41, 41.82], [-72.92, 41.31], [-73.95, 40.73], [-74.17, 40.74], [-71.46, 42.99], [-70.26, 43.66], [-73.21, 44.48], [-82.46, 36.55], [-83.92, 35.96], [-85.31, 35.05], [-90.05, 35.15], [-92.29, 34.75], [-97.52, 35.47], [-95.99, 36.15], [-96.70, 40.81], [-95.94, 41.26], [-88.24, 40.12], [-89.64, 39.80], [-91.53, 41.66], [-92.10, 46.79], [-88.01, 44.52], [-84.55, 42.73], [-83.74, 42.28], [-85.59, 42.29], [-86.25, 41.68]];

/** Sample points around each metro; per point, every flight's own dates; pairs on/off by the points' clocks. */
export async function clockSample({ perMetro = 4, radiusKm = 12, maxGapYears = 3 } = {}) {
  const found = [], labels = { agree: 0, disagree: 0, unknown: 0 }, wrong = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const [cx, cy] of METROS) {
    for (let i = 0; i < perMetro; i++) {
      const r = radiusKm * Math.sqrt(rnd()), a = 2 * Math.PI * rnd();
      const lat = cy + (r * Math.sin(a)) / 111.32, lng = cx + (r * Math.cos(a)) / (111.32 * Math.cos((cy * Math.PI) / 180));
      if (!(await urban(lng, lat))) continue;
      const got = await lidarAt(lng, lat).catch(() => null);
      const k = mercScale(lat), h = 60 / k, [x, y] = toMerc([lng, lat]);
      const flights = [];
      for (const c of got?.clouds || []) {
        const d = await flightDays(c.url, [x - h, y - h, x + h, y + h]).catch(() => null);
        if (!d) continue;
        const byClock = leafByDate(d[1]);
        flights.push({ c, at: d[1], byClock });
        if (c.unit?.season === 'on' || c.unit?.season === 'off') {
          if (!byClock) labels.unknown++;
          else if (byClock === c.unit.season) labels.agree++;
          else { labels.disagree++; wrong.push(`${c.name}: WESM ${c.unit.season}, flown ${new Date(d[1]).toISOString().slice(0, 7)}`); }
        }
      }
      for (const on of flights.filter((f) => f.byClock === 'on')) for (const off of flights.filter((f) => f.byClock === 'off')) {
        if (Math.abs(on.at - off.at) <= maxGapYears * 365.25 * 864e5) found.push({ lng, lat, cOn: on.c, cOff: off.c, onAt: on.at, offAt: off.at });
      }
    }
  }
  return { found, labels, wrong: [...new Set(wrong)] };
}

/** The sky view part of the report. */
export function skyLines(rows) {
  const S = {};
  for (const r of rows.filter((x) => !x.skip)) for (const [k, L] of Object.entries(r.light)) {
    if (!L.sky?.n) continue;
    const t = (S[k] ||= { n: 0, sumT: 0, sumO: 0, sumB: 0, absD: 0 });
    for (const q of Object.keys(t)) t[q] += L.sky[q];
  }
  return ['\nSKY VIEW AT A PHONE\'S HEIGHT (the diffuse half of the light; 1 = open sky):',
    ...Object.entries(S).map(([k, t]) => `  ${k} (${t.n} points): leaf-on ${(t.sumT / t.n).toFixed(2)}, ours ${(t.sumO / t.n).toFixed(2)}, bare ${(t.sumB / t.n).toFixed(2)}; ours off by ${(t.absD / t.n).toFixed(2)} on average`)];
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === '--clocks') {
  const { found, labels, wrong } = await clockSample({ perMetro: Number(process.argv[3]) || 4 });
  console.log(`WESM's leaf season against the points' own clocks (flights sampled in ${METROS.length} metros): agree ${labels.agree}, disagree ${labels.disagree}, clock in between ${labels.unknown}`);
  for (const w of wrong) console.log(`  ${w}`);
  const rows = [];
  const seen = new Set();
  for (const f of found) {
    const key = `${f.cOn.name}|${f.cOff.name}`;
    if ((seen.has(key) && [...seen].filter((s) => s === key).length) || rows.filter((r) => !r.skip).length >= 24) continue;
    const k = mercScale(f.lat), half = (WIN_M / 2 + MARGIN_M) / k, [cx, cy] = toMerc([f.lng, f.lat]);
    const box3857 = [cx - half, cy - half, cx + half, cy + half];
    try {
      const truth = (await pointsIn(f.cOn.url, box3857, io)).cols;
      const r = await compareWindow({ cloud: f.cOff, box3857, lat: f.lat, lng: f.lng, neonCols: truth, truthFill: false, sky: true });
      if (r.roofShare < 0.03 || r.crownShare < 0.1) { rows.push({ skip: r.roofShare < 0.03 ? 'no houses' : 'few trees' }); continue; }
      rows.push({ site: `${f.cOn.name} (${new Date(f.onAt).toISOString().slice(0, 7)}) / ${f.cOff.name} (${new Date(f.offAt).toISOString().slice(0, 7)})`, tile: [], win: rows.length, ...r });
      seen.add(key);
    } catch (e) { rows.push({ skip: `error: ${e.message}` }); }
  }
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(rows));
  console.log(`${found.length} sample points with a summer and a bare flight by their clocks, ${rows.filter((r) => !r.skip).length} windows scored`);
  console.log(report(rows.filter((r) => !r.skip)).replace(/NEON's leaf-on lidar/g, 'a leaf-on 3DEP flight').replace(/NEON's cloud/g, 'the leaf-on cloud').replace(/  NEON flies at peak greenness[^\n]*\n/, ''));
  console.log(skyLines(rows).join('\n'));
  for (const r of rows.filter((x) => !x.skip)) { const L = r.light['open, within 20 m of trees'], E = r.light['under a crown edge']; console.log(`  ${r.site}: roofs ${Math.round(100 * r.roofShare)}%, crown ${Math.round(100 * r.crownShare)}%; open ${L ? `${(L.sumT / L.n).toFixed(2)}/${(L.sumO / L.n).toFixed(2)}` : '-'}, edge ${E ? `${(E.sumT / E.n).toFixed(2)}/${(E.sumO / E.n).toFixed(2)}` : '-'}`); }
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const { rows, log } = await twiceCheck(Number(process.argv[2]) || 24);
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(rows));
  console.log(log.join('\n'));
  const skips = {};
  for (const r of rows.filter((x) => x.skip)) skips[r.skip] = (skips[r.skip] || 0) + 1;
  console.log(`windows left out: ${Object.entries(skips).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
  console.log(report(rows.filter((r) => !r.skip)).replace(/NEON's leaf-on lidar/g, 'a leaf-on 3DEP flight').replace(/NEON's cloud/g, 'the leaf-on cloud').replace(/  NEON flies at peak greenness[^\n]*\n/, ''));
  console.log(skyLines(rows).join('\n'));
  console.log('\nPer window (roofs / leaf-on crown share of the ground; open-near-trees beam leaf-on vs ours):');
  for (const r of rows.filter((x) => !x.skip)) {
    const L = r.light['open, within 20 m of trees'];
    console.log(`  ${r.site} #${r.win}: roofs ${Math.round(100 * r.roofShare)}%, crown ${Math.round(100 * r.crownShare)}%; ${L ? `${(L.sumT / L.n).toFixed(2)} vs ${(L.sumO / L.n).toFixed(2)}` : '-'}`);
  }
}
