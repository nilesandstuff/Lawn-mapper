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
import { pointsIn, toMerc, mercScale } from '../public/shade/ept.js';
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
