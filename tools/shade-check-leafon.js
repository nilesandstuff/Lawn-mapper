/**
 * THE LEAF FILL AGAINST A LASER THAT SAW THE LEAVES (features session; owner,
 * 2026-10-14: "I think it's probably more to do with how trees are being
 * filled in. Are there any public 3d models of leaf on trees at known sites
 * in the US where we could compare our fill model with hard reality?").
 *
 * NEON flies lidar over each of its field sites at peak greenness
 * (DP1.30003.001, about 4 points a square meter, 1 km tiles, free). Most of
 * those places were also flown leaf-off by USGS 3DEP, which is what the shade
 * map builds from. So, at the same trees:
 *
 *   OURS    the page's model from the 3DEP leaf-off cloud with its summer
 *           leaves filled in (canopy.js + seasonal.js, full leaves)
 *   TRUTH   the same canopy model built from NEON's leaf-on cloud as flown
 *           (the leaves where the laser found them; nothing filled)
 *   BARE    the 3DEP cloud as flown, no leaves added (what the fill adds)
 *
 * on one 1 m grid, after lining NEON's cloud up on 3DEP's by their canopy
 * tops. Tiles are picked from NEON's canopy height model (DP3.30015.001) with
 * 25-60% tree cover: fields, yards, roadsides and woodlot edges, where single
 * trees and crown edges are -- the lawn's case, which NEON's under-forest
 * light sensors (finding 1) never saw.
 *
 * Measured, per class of place (open ground near trees; under a crown at its
 * edge; deep under a canopy; small isolated crowns):
 *   - footprint: where each says there is crown;
 *   - where the leaves sit: crown base heights and the overhead sun through;
 *   - the light at a phone's height for sun angles from 20 to 65 degrees.
 *
 *   NEON_TOKEN=... node tools/shade-check-leafon.js SCBI:2021-08 BLAN:2021-08 ...
 *
 * Counts and shares only. NEON's sites are public research sites.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lidarAt } from '../worker/src/shade.js';
import { pointsIn, toMerc, mercScale } from '../public/shade/ept.js';
import { lazDecoder } from '../public/shade/laz.js';
import { lasHeader, makeColumns, readRecord } from '../public/shade/las.js';
import { nad83Correction } from '../public/shade/datum.js';
import { buildCanopy } from '../public/shade/canopy.js';
import { seasonalCanopy } from '../public/shade/seasonal.js';
import { gridOver, cellOf } from '../public/shade/grid.js';
import { transmittance, groundAt, skyDirections } from '../public/shade/rays.js';

const API = 'https://data.neonscience.org/api/v0';
const TOKEN = process.env.NEON_TOKEN || '';
const WORK = process.env.WORK_DIR || '/tmp/leafon';
const WIN_M = Number(process.env.WIN_M) || 250, MARGIN_M = 40, PHONE_M = 1.27, CROWN_M = 2;

/* ---------------------------------------------------------------- NEON */

async function get(u, as = 'json', tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(u, { headers: TOKEN && u.startsWith(API) ? { 'X-API-Token': TOKEN } : {} });
      if (!r.ok) throw new Error(`${r.status}`);
      return as === 'json' ? await r.json() : Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i + 1 >= tries) throw new Error(`${e.message} ${u.slice(0, 120)}`);
      await new Promise((ok) => setTimeout(ok, 2000 * 2 ** i));
    }
  }
}
const files = async (product, site, month) => (await get(`${API}/data/${product}/${site}/${month}`))?.data?.files || [];
const tileOf = (name) => { const m = /_(\d{6})_(\d{7})_/.exec(name); return m ? [Number(m[1]), Number(m[2])] : null; };

/** Share of a NEON canopy height tile over 3 m (cells with data). */
export async function coverOf(buf) {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(buf).raw({ depth: 'float' }).toBuffer({ resolveWithObject: true });
  const f = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
  let n = 0, c = 0;
  for (let i = 0; i < f.length; i += info.channels) { const v = f[i]; if (v > -1 && v < 80) { n++; if (v > 3) c++; } }
  return n > 1000 ? c / n : null;
}

/* ------------------------------------------------------------- UTM, WGS84 */

/** UTM (zone, north) -> [lat, lng], WGS84 (Snyder 1987). */
export function utmToLatLng(E, N, zone) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), ep2 = e2 / (1 - e2), k0 = 0.9996;
  const x = E - 500000, M = N / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const C = ep2 * Math.cos(p) ** 2, T = Math.tan(p) ** 2, Nn = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  const R = a * (1 - e2) / (1 - e2 * Math.sin(p) ** 2) ** 1.5, D = x / (Nn * k0);
  const lat = p - (Nn * Math.tan(p) / R) * (D * D / 2 - (5 + 3 * T + 10 * C - 4 * C * C - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T + 298 * C + 45 * T * T - 252 * ep2 - 3 * C * C) * D ** 6 / 720);
  const lng = (D - (1 + 2 * T + C) * D ** 3 / 6 + (5 - 2 * C + 28 * T - 3 * C * C + 8 * ep2 + 24 * T * T) * D ** 5 / 120) / Math.cos(p);
  return [lat * 180 / Math.PI, (zone * 6 - 183) + lng * 180 / Math.PI];
}

/* ---------------------------------------------------------- reading LAZ */

const vendor = (f) => fileURLToPath(new URL(`../public/shade/vendor/${f}`, import.meta.url));
let createFn = null, lazModule = null;
/** laz-perf's module factory, as tools/shade-site.js makes it. */
function lazCreate() {
  if (!createFn) {
    // eslint-disable-next-line no-new-func
    const create = new Function('window', 'process', 'require', `${readFileSync(vendor('laz-perf.js'), 'utf8')}; return createLazPerf;`)({ location: { href: '' } }, undefined, undefined);
    const wasmBinary = readFileSync(vendor('laz-perf.wasm'));
    createFn = (opts) => create({ ...opts, wasmBinary });
  }
  return createFn;
}
async function lazPerf() {
  if (!lazModule) lazModule = await lazCreate()({});
  return lazModule;
}

/**
 * A NEON LAZ tile's points inside the given 3857 boxes, in 3857, as columns
 * (one per box), read point by point so the 200 MB tile never sits decoded.
 */
async function readTile(path, zone, boxes) {
  const M = await lazPerf();
  const buf = readFileSync(path);
  const h = lasHeader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const filePtr = M._malloc(buf.byteLength);
  M.HEAPU8.set(buf, filePtr);
  const zip = new M.LASZip();
  const outs = boxes.map(() => ({ pts: [] }));
  try {
    zip.open(filePtr, buf.byteLength);
    const L = zip.getPointLength(), n = zip.getCount(), fmt = zip.getPointFormat();
    const ptr = M._malloc(L);
    const one = makeColumns(1);
    for (let i = 0; i < n; i++) {
      zip.getPoint(ptr);
      const dv = new DataView(M.HEAPU8.buffer, ptr, L);
      readRecord(dv, 0, fmt, h, one, 0);
      if (one.cls[0] === 7 || one.cls[0] === 18) continue;
      /* Every window the point is in: they overlap by their margins, and a
         point given only to the first left 40 m strips of the others empty
         (found 2026-10-14, after finding 13's first numbers). */
      let mx = NaN, my = NaN;
      for (let b = 0; b < boxes.length; b++) {
        const u = boxes[b].utm;
        if (!(one.x[0] >= u[0] && one.x[0] <= u[2] && one.y[0] >= u[1] && one.y[0] <= u[3])) continue;
        if (Number.isNaN(mx)) { const [lat, lng] = utmToLatLng(one.x[0], one.y[0], zone); [mx, my] = toMerc([lng, lat]); }
        outs[b].pts.push(mx, my, one.z[0], one.ret[0], one.nret[0], one.cls[0]);
      }
    }
    M._free(ptr);
  } finally {
    zip.delete();
    M._free(filePtr);
  }
  return outs.map(({ pts }) => {
    const c = makeColumns(pts.length / 6);
    for (let j = 0, i = 0; j < pts.length; j += 6, i++) { c.x[i] = pts[j]; c.y[i] = pts[j + 1]; c.z[i] = pts[j + 2]; c.ret[i] = pts[j + 3]; c.nret[i] = pts[j + 4]; c.cls[i] = pts[j + 5]; }
    return c;
  });
}

/* --------------------------------------------------------- the comparison */

/** Highest return over the ground per cell, NaN where none (for lining the clouds up). */
export function topGrid(cols, grid, shift) {
  const top = new Float32Array(grid.w * grid.h).fill(NaN);
  for (let i = 0; i < cols.n; i++) {
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k >= 0 && !(top[k] >= cols.z[i])) top[k] = cols.z[i];
  }
  return top;
}

/** The whole-meter move of B (3857 units per meter `cell`) that best fits its tops to A's, within r m. */
export function bestShift(a, b, w, h, r = 4) {
  let best = { dx: 0, dy: 0, score: -Infinity };
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    let s = 0, n = 0;
    for (let y = r; y < h - r; y += 2) for (let x = r; x < w - r; x += 2) {
      const va = a[y * w + x], vb = b[(y + dy) * w + (x + dx)];
      if (Number.isFinite(va) && Number.isFinite(vb)) { s -= Math.min(Math.abs(va - vb), 10); n++; }
    }
    if (n && s / n > best.score) best = { dx, dy, score: s / n };
  }
  return best;
}

/** Height over the ground of the lowest layer stopping light above CROWN_M, NaN for none. */
export function baseOf(model, mu, k) {
  const { nz, dz, z0, ground } = model;
  for (let l = 0; l < nz; l++) {
    const lo = z0 + l * dz - ground[k];
    if (lo + dz <= CROWN_M) continue;
    if (mu[k * nz + l] > 0.02) return Math.max(lo, CROWN_M);
  }
  return NaN;
}
/** Height over the ground of the top of the highest layer stopping light, NaN for none. */
export function topOf(model, mu, k) {
  const { nz, dz, z0, ground } = model;
  for (let l = nz - 1; l >= 0; l--) if (mu[k * nz + l] > 0.02) return z0 + (l + 1) * dz - ground[k];
  return NaN;
}
export function overheadT(model, mu, k) {
  const { nz, dz, z0, ground } = model;
  let tau = 0;
  for (let l = 0; l < nz; l++) if (z0 + (l + 0.5) * dz > ground[k] + 0.5) tau += mu[k * nz + l] * dz;
  return Math.exp(-tau);
}

/** Crown columns: something stops light above CROWN_M, and it is not a building. */
export function crownMask(model, mu, roof) {
  const out = new Uint8Array(model.w * model.h);
  for (let k = 0; k < out.length; k++) if (!roof[k] && Number.isFinite(baseOf(model, mu, k))) out[k] = 1;
  return out;
}

/** Each crown column's clump size (8-neighbour), m2. */
export function clumpSizes(mask, w, h) {
  const size = new Int32Array(w * h);
  const seen = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    const q = [s]; seen[s] = 1;
    for (let i = 0; i < q.length; i++) {
      const x = q[i] % w, y = (q[i] / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, j = yy * w + xx;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[j] && !seen[j]) { seen[j] = 1; q.push(j); }
      }
    }
    for (const j of q) size[j] = q.length;
  }
  return size;
}

/** Distance (m, capped) from each cell to the nearest cell where mask is `want`. */
export function distTo(mask, w, h, want, cap = 25) {
  const d = new Float32Array(w * h).fill(cap);
  const q = [];
  for (let k = 0; k < w * h; k++) if (mask[k] === want) { d[k] = 0; q.push(k); }
  for (let i = 0; i < q.length; i++) {
    const k = q[i], x = k % w, y = (k / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy, j = yy * w + xx;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && d[j] > d[k] + 1) { d[j] = d[k] + 1; if (d[j] < cap) q.push(j); }
    }
  }
  return d;
}

const ELEVATIONS = [20, 35, 50, 65], AZIMUTHS = [90, 135, 180, 225, 270];
const SKY = skyDirections(4, 12);

/** One window: OURS, TRUTH and BARE on one grid, scored. */
/* -------------------------------------------------------------- the cache */

const KEYS = [['x', Float64Array], ['y', Float64Array], ['z', Float32Array], ['ret', Uint8Array], ['nret', Uint8Array], ['cls', Uint8Array]];
function packCols(c) {
  const parts = KEYS.map(([k]) => Buffer.from(c[k].buffer, c[k].byteOffset, c.n * c[k].BYTES_PER_ELEMENT));
  return Buffer.concat([Buffer.from(new Uint32Array([c.n]).buffer), ...parts]);
}
function unpackCols(buf, at = 0) {
  const n = buf.readUInt32LE(at);
  let o = at + 4;
  const c = makeColumns(n);
  for (const [k, T] of KEYS) {
    const bytes = n * T.BYTES_PER_ELEMENT;
    c[k] = new T(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + bytes));
    o += bytes;
  }
  c.intensity = new Uint16Array(n);
  return { c, end: o };
}
/** Save one window's two clouds and what is needed to rebuild it. */
export function saveWindow(dir, name, meta, cols3, neonCols) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.json`, JSON.stringify(meta));
  writeFileSync(`${dir}/${name}.bin`, Buffer.concat([packCols(cols3), packCols(neonCols)]));
}
export function loadWindow(dir, name) {
  const meta = JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8'));
  const buf = readFileSync(`${dir}/${name}.bin`);
  const a = unpackCols(buf, 0), b = unpackCols(buf, a.end);
  return { ...meta, cols3: a.c, neonCols: b.c };
}

/**
 * One window: OURS, TRUTH and BARE on one grid, scored. `fill` is the
 * leaf-fill choice (seasonal.js); `truthFill` whether NEON's model fills
 * solid under its densest layers in trees too (true, as the page does) or
 * only under roofs.
 */
export async function compareWindow({ cloud, box3857, lat, lng, neonCols, cols3 = null, epoch = null, fill = {}, truthFill = true, cache = null, sky = false }) {
  const k = mercScale(lat);
  let cols = cols3;
  if (!cols) {
    const io = { getJson: (u) => get(u, 'json'), getBytes: (u) => get(u, 'bytes').then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), decompress: lazDecoder(lazCreate) };
    cols = (await pointsIn(cloud.url, box3857, io)).cols;
    if (cache) saveWindow(cache.dir, cache.name, { box3857, lat, lng, epoch: cloud.epoch, ...cache.meta }, cols, neonCols);
  }
  const d = nad83Correction(lat, lng, epoch ?? cloud.epoch), shift = [d.east / k, d.north / k];
  const grid = gridOver(box3857, 1, lat);
  /* Line NEON up on 3DEP by canopy and roof tops. */
  const A = topGrid(cols, grid, shift), B0 = topGrid(neonCols, grid, null);
  const fit = bestShift(A, B0, grid.w, grid.h, 4);
  const nShift = [-fit.dx * grid.cell, fit.dy * grid.cell];
  const model = buildCanopy(cols, grid, { shift });
  const season = seasonalCanopy(cols, model, { shift, classify: true, fill });
  const roof = Uint8Array.from(season.kind, (v) => (v === 1 ? 1 : 0));
  let truth = buildCanopy(neonCols, grid, { shift: nShift });
  if (!truthFill) {
    /* Under a dense leaf-on layer the laser saw nothing; in a tree that is
       trunk space, not wall. Solid only under roofs. */
    const open = buildCanopy(neonCols, grid, { shift: nShift, fillUnder: false });
    const mu = Float32Array.from(open.mu);
    for (let kk = 0; kk < grid.w * grid.h; kk++) if (roof[kk]) for (let l = 0; l < truth.nz && l < open.nz; l++) mu[kk * open.nz + l] = truth.mu[kk * truth.nz + l];
    truth = { ...open, mu };
  }
  const ours = { ...model, mu: season.muOn }, bare = { ...model, mu: season.muOff };
  const cT = crownMask(truth, truth.mu, roof), cO = crownMask(model, season.muOn, roof), cB = crownMask(model, season.muOff, roof);
  const { w, h } = grid, m = MARGIN_M;
  const inside = (x, y) => x >= m && y >= m && x < w - m && y < h - m;
  const sizeT = clumpSizes(cT, w, h), toOpen = distTo(cT, w, h, 0), toCrown = distTo(cT, w, h, 1);

  /* Footprint, and where the leaves sit, per crown class (truth's). */
  const cls = (kk) => (sizeT[kk] < 300 ? 'small crown' : toOpen[kk] <= 3 ? 'crown edge' : 'deep canopy');
  const foot = { truth: 0, ours: 0, both: 0, bare: 0, bareBoth: 0 };
  const byCls = {};
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside(x, y)) continue;
    const kk = y * w + x;
    if (roof[kk]) continue;
    foot.truth += cT[kk]; foot.ours += cO[kk]; foot.both += cT[kk] & cO[kk]; foot.bare += cB[kk]; foot.bareBoth += cT[kk] & cB[kk];
    if (!cT[kk] || !cO[kk]) continue;
    const c = (byCls[cls(kk)] ||= { n: 0, baseO: [], baseT: [], tO: [], tT: [], tB: [], topO: [], topT: [] });
    c.n++;
    c.baseO.push(baseOf(model, season.muOn, kk)); c.baseT.push(baseOf(truth, truth.mu, kk));
    c.topO.push(topOf(model, season.muOn, kk)); c.topT.push(topOf(truth, truth.mu, kk));
    c.tO.push(overheadT(model, season.muOn, kk)); c.tT.push(overheadT(truth, truth.mu, kk)); c.tB.push(overheadT(model, season.muOff, kk));
  }

  /* Light at a phone's height, every 3 m, by place. */
  const R = Math.PI / 180;
  const light = {};
  for (let y = m; y < h - m; y += 3) for (let x = m; x < w - m; x += 3) {
    const kk = y * w + x;
    if (roof[kk]) continue;
    const place = cT[kk] ? (toOpen[kk] <= 3 ? 'under a crown edge' : sizeT[kk] < 300 ? 'under a small crown' : 'deep under canopy') : toCrown[kk] <= 20 ? 'open, within 20 m of trees' : null;
    if (!place) continue;
    const L = (light[place] ||= { n: 0, agree: 0, bareAgree: 0, sumT: 0, sumO: 0, sumB: 0, tooDark: 0, tooBright: 0, byEl: ELEVATIONS.map(() => ({ n: 0, agree: 0, sumT: 0, sumO: 0 })), sky: { n: 0, sumT: 0, sumO: 0, sumB: 0, absD: 0 } });
    if (sky) {
      /* The sky view at a phone's height (the diffuse half of the light; rays.js skyView's even sky, 48 directions). */
      const gx = x + 0.5, gy = y + 0.5, zT = groundAt(truth, gx, gy) + PHONE_M, zO = groundAt(model, gx, gy) + PHONE_M;
      let vT = 0, vO = 0, vB = 0;
      for (const d of SKY) { vT += d.w * transmittance(truth, gx, gy, zT, d.dir); vO += d.w * transmittance(ours, gx, gy, zO, d.dir); vB += d.w * transmittance(bare, gx, gy, zO, d.dir); }
      L.sky.n++; L.sky.sumT += vT; L.sky.sumO += vO; L.sky.sumB += vB; L.sky.absD += Math.abs(vO - vT);
    }
    ELEVATIONS.forEach((el, ei) => {
      for (const az of AZIMUTHS) {
        const ce = Math.cos(el * R), dir = [Math.sin(az * R) * ce, Math.cos(az * R) * ce, Math.sin(el * R)];
        const gx = x + 0.5, gy = y + 0.5;
        const tT = transmittance(truth, gx, gy, groundAt(truth, gx, gy) + PHONE_M, dir);
        const tO = transmittance(ours, gx, gy, groundAt(model, gx, gy) + PHONE_M, dir);
        const tB = transmittance(bare, gx, gy, groundAt(model, gx, gy) + PHONE_M, dir);
        L.n++; L.sumT += tT; L.sumO += tO; L.sumB += tB;
        const sT = tT >= 0.5, sO = tO >= 0.5;
        if (sT === sO) L.agree++; else if (sO) L.tooBright++; else L.tooDark++;
        if (sT === (tB >= 0.5)) L.bareAgree++;
        const b = L.byEl[ei]; b.n++; b.sumT += tT; b.sumO += tO; if (sT === sO) b.agree++;
      }
    });
  }
  let cells = 0, roofs = 0;
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) { cells++; roofs += roof[y * w + x]; }
  return { fit: { east: -fit.dx, north: fit.dy, score: fit.score }, foot, cols3: byCls, light, points3dep: cols.n, pointsNeon: neonCols.n, season: season.counts, roofShare: roofs / cells, crownShare: foot.truth / cells };
}

const med = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };

/** Tiles to use at a site: NEON canopy height tiles sampled evenly, kept at 25-60% cover, nearest 40% first. */
async function pickTiles(site, month, want = 2, sample = 24) {
  const chm = (await files('DP3.30015.001', site, month)).filter((f) => /_CHM\.tif$/.test(f.name));
  const step = Math.max(1, Math.floor(chm.length / sample));
  const scored = [];
  for (let i = 0; i < chm.length; i += step) {
    const c = await coverOf(await get(chm[i].url, 'bytes')).catch(() => null);
    if (c !== null) scored.push({ tile: tileOf(chm[i].name), cover: c });
  }
  return scored.filter((s) => s.cover >= 0.25 && s.cover <= 0.6).sort((a, b) => Math.abs(a.cover - 0.4) - Math.abs(b.cover - 0.4)).slice(0, want);
}

export async function siteCheck(site, month, { tiles = 2 } = {}) {
  const s = (await get(`${API}/sites/${site}`)).data;
  const zone = Math.floor((s.siteLongitude + 180) / 6) + 1;
  const picked = await pickTiles(site, month, tiles);
  const laz = (await files('DP1.30003.001', site, month)).filter((f) => /classified_point_cloud.*\.laz$/.test(f.name));
  const out = [];
  if (!existsSync(WORK)) mkdirSync(WORK, { recursive: true });
  for (const p of picked) {
    const f = laz.find((x) => { const t = tileOf(x.name); return t && t[0] === p.tile[0] && t[1] === p.tile[1]; });
    if (!f) continue;
    const [lat, lng] = utmToLatLng(p.tile[0] + 500, p.tile[1] + 500, zone);
    const found = await lidarAt(lng, lat).catch(() => null);
    const cloud = (found?.clouds || []).find((c) => c.unit?.season === 'off' || c.unit?.season === 'mixed');
    if (!cloud) { out.push({ site, tile: p.tile, skip: 'no leaf-off 3DEP flight here' }); continue; }
    /* Four windows, one per quarter of the tile. */
    const wins = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => {
      const e0 = p.tile[0] + 250 * i + 125 - WIN_M / 2 - MARGIN_M, n0 = p.tile[1] + 250 * j + 125 - WIN_M / 2 - MARGIN_M;
      const e1 = e0 + WIN_M + 2 * MARGIN_M, n1 = n0 + WIN_M + 2 * MARGIN_M;
      const [la0, lo0] = utmToLatLng(e0, n0, zone), [la1, lo1] = utmToLatLng(e1, n1, zone);
      const [x0, y0] = toMerc([Math.min(lo0, lo1), Math.min(la0, la1)]), [x1, y1] = toMerc([Math.max(lo0, lo1), Math.max(la0, la1)]);
      /* The UTM box a little wider than the 3857 one (they are not quite parallel). */
      return { utm: [e0 - 10, n0 - 10, e1 + 10, n1 + 10], box3857: [x0, y0, x1, y1], lat: (la0 + la1) / 2, lng: (lo0 + lo1) / 2 };
    });
    const path = `${WORK}/${site}-${p.tile.join('_')}.laz`;
    writeFileSync(path, await get(f.url, 'bytes'));
    const neon = await readTile(path, zone, wins);
    unlinkSync(path);
    for (let i = 0; i < wins.length; i++) {
      try {
        const cache = process.env.CACHE_DIR ? { dir: process.env.CACHE_DIR, name: `${site}-${p.tile.join('_')}-${i}`, meta: { site, month, tile: p.tile, cover: p.cover, win: i, flight: cloud.name } } : null;
        const r = await compareWindow({ cloud, box3857: wins[i].box3857, lat: wins[i].lat, lng: wins[i].lng, neonCols: neon[i], cache });
        out.push({ site, month, tile: p.tile, cover: p.cover, win: i, flight: `${cloud.name} ${cloud.unit?.season} to ${cloud.unit?.end ? new Date(cloud.unit.end).toISOString().slice(0, 7) : '?'}`, ...r });
      } catch (e) {
        out.push({ site, tile: p.tile, win: i, skip: `error: ${e.message}` });
      }
    }
  }
  return out;
}

/** The report over windows: counts and shares only. */
export function report(rows) {
  const ok = rows.filter((r) => !r.skip);
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');
  const out = [`Leaf fill against NEON's leaf-on lidar: ${ok.length} windows of ${WIN_M} m (${rows.length - ok.length} skipped).`];
  for (const r of rows.filter((x) => x.skip)) out.push(`  skipped ${r.site} ${r.tile?.join('_') || ''}${r.win != null ? ` #${r.win}` : ''}: ${r.skip}`);
  const F = { truth: 0, ours: 0, both: 0, bare: 0, bareBoth: 0 };
  for (const r of ok) for (const k of Object.keys(F)) F[k] += r.foot[k];
  out.push(`\nFOOTPRINT (1 m columns, buildings out): leaf-on crown ${F.truth}; ours filled ${F.ours} (${pct(F.both, F.truth)} of the real crown covered, ${pct(F.ours - F.both, F.ours)} of ours where there is none); bare as flown ${F.bare} (${pct(F.bareBoth, F.truth)} covered).`);
  const C = {};
  for (const r of ok) for (const [k, c] of Object.entries(r.cols3)) {
    const t = (C[k] ||= { n: 0, baseO: [], baseT: [], tO: [], tT: [], tB: [] });
    t.n += c.n; for (const q of ['baseO', 'baseT', 'tO', 'tT', 'tB']) t[q].push(...c[q]);
  }
  out.push('\nWHERE THE LEAVES SIT (columns both call crown):');
  for (const [k, c] of Object.entries(C)) {
    const dBase = c.baseO.map((v, i) => v - c.baseT[i]);
    out.push(`  ${k} (${c.n}): crown base ours ${f2(med(c.baseO))} m, leaf-on ${f2(med(c.baseT))} m (ours minus leaf-on, median ${f2(med(dBase))} m); overhead sun through: ours ${f2(med(c.tO))}, leaf-on ${f2(med(c.tT))}, bare ${f2(med(c.tB))}`);
  }
  const Lg = {};
  for (const r of ok) for (const [k, L] of Object.entries(r.light)) {
    const t = (Lg[k] ||= { n: 0, agree: 0, bareAgree: 0, sumT: 0, sumO: 0, sumB: 0, tooDark: 0, tooBright: 0, byEl: ELEVATIONS.map(() => ({ n: 0, agree: 0, sumT: 0, sumO: 0 })) });
    for (const q of ['n', 'agree', 'bareAgree', 'sumT', 'sumO', 'sumB', 'tooDark', 'tooBright']) t[q] += L[q];
    L.byEl.forEach((b, i) => { for (const q of ['n', 'agree', 'sumT', 'sumO']) t.byEl[i][q] += b[q]; });
  }
  out.push(`\nLIGHT AT A PHONE'S HEIGHT (sun ${ELEVATIONS.join('/')} degrees up, from ${AZIMUTHS.join('/')}; sun or shade at half the beam):`);
  for (const [k, L] of Object.entries(Lg)) {
    out.push(`  ${k} (${L.n} rays): agree ${pct(L.agree, L.n)} (ours too dark ${pct(L.tooDark, L.n)}, too bright ${pct(L.tooBright, L.n)}; bare would agree ${pct(L.bareAgree, L.n)}); mean beam: leaf-on ${f2(L.sumT / L.n)}, ours ${f2(L.sumO / L.n)}, bare ${f2(L.sumB / L.n)}`);
    out.push(`    by sun height: ${L.byEl.map((b, i) => `${ELEVATIONS[i]} deg agree ${pct(b.agree, b.n)}, beam ${f2(b.sumT / b.n)} vs ours ${f2(b.sumO / b.n)}`).join(' | ')}`);
  }
  out.push('\n  NEON flies at peak greenness, so ours is drawn with full summer leaves. The leaf-on model is the same canopy maths on a cloud that saw the leaves.');
  out.push(`  Lined up: NEON's cloud moved ${ok.map((r) => `${r.fit.east},${r.fit.north}`).join(' ')} m (east,north; per window, by canopy and roof tops).`);
  return out.join('\n');
}

/** Every cached window scored with one fill choice. */
export async function fromCache(dir, { fill = {}, truthFill = true } = {}) {
  const { readdirSync } = await import('node:fs');
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const w = loadWindow(dir, f.replace(/\.json$/, ''));
    const r = await compareWindow({ box3857: w.box3857, lat: w.lat, lng: w.lng, neonCols: w.neonCols, cols3: w.cols3, epoch: w.epoch, fill, truthFill });
    out.push({ site: w.site, tile: w.tile, win: w.win, ...r });
  }
  return out;
}

/** One line per place for a fill choice: agreement, too dark / too bright, mean beam against leaf-on. */
export function variantLine(name, rows) {
  const Lg = {};
  for (const r of rows) for (const [k, L] of Object.entries(r.light)) {
    const t = (Lg[k] ||= { n: 0, agree: 0, sumT: 0, sumO: 0, tooDark: 0, tooBright: 0 });
    for (const q of Object.keys(t)) t[q] += L[q];
  }
  const F = { truth: 0, ours: 0, both: 0 };
  for (const r of rows) for (const q of Object.keys(F)) F[q] += r.foot[q];
  const p = (a, b) => `${Math.round((100 * a) / b)}%`;
  const short = { 'open, within 20 m of trees': 'open', 'under a crown edge': 'edge', 'deep under canopy': 'deep', 'under a small crown': 'small' };
  return `${name.padEnd(28)} ${['open, within 20 m of trees', 'under a crown edge', 'deep under canopy', 'under a small crown'].map((k) => { const L = Lg[k]; return L ? `${short[k]} ${p(L.agree, L.n)} (dk ${p(L.tooDark, L.n)} br ${p(L.tooBright, L.n)}; ${(L.sumO / L.n).toFixed(2)}/${(L.sumT / L.n).toFixed(2)})` : `${short[k]} -`; }).join(' | ')} | crown ${p(F.ours, F.truth)} of leaf-on, ${p(F.ours - F.both, F.ours)} extra`;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === '--variants') {
  const dir = process.argv[3];
  const variants = JSON.parse(process.argv[4] || '{"as shipped":{}}');
  const truthFill = process.env.TRUTH_FILL !== '0';
  for (const [name, fill] of Object.entries(variants)) console.log(variantLine(name, await fromCache(dir, { fill, truthFill })));
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const all = [];
  for (const arg of process.argv.slice(2)) {
    const [site, month] = arg.split(':');
    const rows = await siteCheck(site, month, { tiles: Number(process.env.TILES) || 2 });
    all.push(...rows);
    if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(all));
    console.error(`${site}: ${rows.length} windows`);
  }
  console.log(report(all));
}
