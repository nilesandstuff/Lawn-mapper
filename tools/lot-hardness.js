/**
 * WHAT MAKES A LOT HARD -- the photo itself, measured, against the model's
 * error on that lot (owner, 2026-10-08).
 *
 * The owner's point: "source" is a poor handle. Mapbox photos vary wildly in
 * sharpness, lighting and leaf-on/off; county photos vary less but still do;
 * heavy shadow has nothing to do with source; and a leaf-off photo, sharper
 * to the eye, has LESS contrast between dormant grass and bare dirt or leaf
 * litter at a woodline. So this measures those things on each lot's own
 * banked photograph, inside its property line, and asks which of them track
 * THE PLAN's per-lot error -- within the Mapbox lots alone and within the
 * county lots alone as well as over all of them, so the source is held fixed
 * while the appearance varies.
 *
 * Per lot, from the photo resampled to one ground scale (7.5 cm a pixel, so
 * a sharp county photo and a soft Mapbox one are measured alike):
 *
 *   green     mean excess-green of the LAWN's pixels: (2G - R - B) / (R+G+B).
 *             Lush grass is high, dormant grass low.
 *   contrast  how far the lawn's excess-green sits from the rest of the lot's,
 *             in units of their spread (a d'): low means grass and not-grass
 *             look alike in this photo, whatever the reason.
 *   shadow    share of the lot's pixels that are dark (luma under 50 of 255).
 *   sharp     focus, as the blur ratio: the lot's edge energy over that of
 *             the same picture softened by a 3 x 3 box. Well over 1 is crisp;
 *             near 1 was already soft. Content cancels. Edges touching
 *             shadow are left out, since a shadow's edge is not focus.
 *   bright    median luma of the lot.
 *   lawn      share of the lot that is lawn.
 *
 * and, from the run's results: the error (mean over the runs given), the
 * lot's size, and how much of the wrong ground lies within 1 m of the true
 * edge (near10: 100 means the model was only ever slightly off at the edge).
 *
 * Shadow pixels are left out of green, contrast and sharp, so a shadowed lot
 * is measured on what can be seen and its shadow is its own number.
 *
 *   node tools/lot-hardness.js --results a.json,b.json [--row "row name"]
 *   (workflow 33; needs the database and the corpus bucket)
 */
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import sharp from 'sharp';

import { pool, PLAN_ROW, median } from './compare-runs.js';
import { query } from './corpus-db.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { lngLatToFramePx, metresPerPixel } from '../public/lib/mercator.js';
import { mapName } from '../worker/src/benchmark-ids.js';

const MPP = 0.075;          // the one ground scale everything is measured at
const DARK = 50;            // luma (0-255) under which a pixel is shadow
const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

/** Geometry lists as stored: bare geometries or Features, either way. */
export function geometriesOf(stored) {
  const list = Array.isArray(stored) ? stored : stored?.features || [];
  return list.map((g) => (g?.geometry ? g.geometry : g)).filter((g) => g && g.type);
}

/** Polygon or MultiPolygon -> list of ring lists. */
export const polygonsOf = (g) => (g?.type === 'Polygon' ? [g.coordinates]
  : g?.type === 'MultiPolygon' ? g.coordinates : []);

/** One mask (Uint8Array w*h) covering every polygon of `geoms`. */
export function maskOf(geoms, w, h, project) {
  const out = new Uint8Array(w * h);
  for (const g of geoms) {
    for (const rings of polygonsOf(g)) {
      const m = rasterizePolygon(rings, w, h, project);
      for (let i = 0; i < out.length; i++) if (m[i]) out[i] = 1;
    }
  }
  return out;
}

/**
 * The covariates of one photo: `rgb` is w*h*3 bytes, `within` the lot's mask
 * (or null for the whole picture), `lawn` the lawn's mask. Pure, so the
 * test can hand it a drawn picture.
 */
export function covariates(rgb, w, h, { within = null, lawn }) {
  const luma = new Float32Array(w * h);
  const exg = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2];
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    exg[i] = (2 * g - r - b) / (r + g + b + 1);
  }
  const inLot = (i) => !within || within[i];
  let lot = 0, dark = 0, lawnPx = 0;
  const lumas = [];
  for (let i = 0; i < w * h; i++) {
    if (!inLot(i)) continue;
    lot++;
    lumas.push(luma[i]);
    if (luma[i] < DARK) dark++;
    if (lawn[i]) lawnPx++;
  }
  if (!lot) return null;
  const seen = (i) => inLot(i) && luma[i] >= DARK;

  /* Excess green of the lawn and of the rest, and their separation. */
  const stats = (pick) => {
    let n = 0, s = 0, s2 = 0;
    for (let i = 0; i < w * h; i++) {
      if (!seen(i) || !pick(i)) continue;
      n++; s += exg[i]; s2 += exg[i] * exg[i];
    }
    const mean = n ? s / n : null;
    const sd = n > 1 ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : null;
    return { n, mean, sd };
  };
  const L = stats((i) => lawn[i]);
  const O = stats((i) => !lawn[i]);
  const pooledSd = L.n && O.n ? Math.sqrt(((L.sd ** 2) * L.n + (O.sd ** 2) * O.n) / (L.n + O.n)) : null;
  const contrast = pooledSd ? (L.mean - O.mean) / Math.max(pooledSd, 1e-6) : null;

  /*
   * FOCUS, as the blur ratio: the picture's edge energy over the edge energy
   * of the same picture softened by a 3 x 3 box. A sharp photo loses most of
   * its fine edges to the box (ratio well over 1); a photo that was already
   * soft -- Mapbox upsampled past its native detail -- loses little (near 1).
   * Content cancels: a busy lot and a plain one blur alike. Only where the
   * whole 3 x 3 is lit, since a shadow's edge is not focus and is the
   * strongest edge there is.
   */
  const soft = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let t = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) t += luma[(y + dy) * w + (x + dx)];
      soft[y * w + x] = t / 9;
    }
  }
  const sobel = (img, x, y) => {
    const at = (dx, dy) => img[(y + dy) * w + (x + dx)];
    const gx = (at(1, -1) + 2 * at(1, 0) + at(1, 1)) - (at(-1, -1) + 2 * at(-1, 0) + at(-1, 1));
    const gy = (at(-1, 1) + 2 * at(0, 1) + at(1, 1)) - (at(-1, -1) + 2 * at(0, -1) + at(1, -1));
    return Math.hypot(gx, gy);
  };
  let fine = 0, coarse = 0, gn = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      let lit = true;
      for (let dy = -2; dy <= 2 && lit; dy++) for (let dx = -2; dx <= 2; dx++) if (!seen((y + dy) * w + (x + dx))) { lit = false; break; }
      if (!lit) continue;
      fine += sobel(luma, x, y); coarse += sobel(soft, x, y); gn++;
    }
  }
  const sharpness = gn && coarse > 1e-6 ? fine / coarse : null;

  return {
    green: L.mean, contrast, shadow: dark / lot, sharp: sharpness,
    bright: median(lumas), lawn: lawnPx / lot, lotPx: lot,
  };
}

/** Average ranks, ties shared. */
export function ranks(xs) {
  const idx = xs.map((v, i) => i).sort((a, b) => xs[a] - xs[b]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Spearman's rho and a permutation p-value (two-sided). */
export function spearman(xs, ys, { perms = 2000, seed = 7 } = {}) {
  const n = xs.length;
  if (n < 4) return { n, rho: null, p: null };
  const rx = ranks(xs), ry = ranks(ys);
  const rho = pearson(rx, ry);
  const rand = rng(seed);
  let hits = 0;
  const sh = [...ry];
  for (let k = 0; k < perms; k++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    if (Math.abs(pearson(rx, sh)) >= Math.abs(rho) - 1e-12) hits++;
  }
  return { n, rho, p: (hits + 1) / (perms + 1) };
}

/* ------------------------------------------------------------ the photo */
async function photoOf(row, dir) {
  if (!row.image_key) return null;
  const raw = `${dir}/${row.image_key.replace(/[^A-Za-z0-9.-]+/g, '_')}.bin`;
  execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'get', `${BUCKET}/${row.image_key}`,
    '--file', raw, '--remote'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const frame = parse(row.image_frame) || parse(row.frame);
  const meta = await sharp(raw).metadata();
  const scale = metresPerPixel(frame, meta.width) / MPP;
  const w = Math.max(16, Math.round(meta.width * scale));
  const h = Math.max(16, Math.round(meta.height * scale));
  const { data } = await sharp(raw).resize(w, h, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, w, h, frame };
}

export function lotCovariates(row, photo) {
  const { rgb, w, h, frame } = photo;
  const project = (ll) => lngLatToFramePx(frame, ll, w, h);
  const parcel = parse(row.parcel);
  const within = parcel ? maskOf([parcel.geometry || parcel], w, h, project) : null;
  const lawn = maskOf(geometriesOf(parse(row.shapes)), w, h, project);
  return covariates(rgb, w, h, { within, lawn });
}

/* ----------------------------------------------------------- the report */
const f1 = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '   —' : v.toFixed(d).padStart(5));

function corrLine(name, lots, key) {
  const xs = lots.filter((l) => Number.isFinite(l[key])).map((l) => l[key]);
  const ys = lots.filter((l) => Number.isFinite(l[key])).map((l) => l.error);
  const s = spearman(xs, ys);
  if (s.rho === null) return `  ${name.padEnd(9)} ${String(s.n).padStart(3)} lots   too few`;
  const m = median(xs);
  const lo = ys.filter((_, i) => xs[i] <= m), hi = ys.filter((_, i) => xs[i] > m);
  return `  ${name.padEnd(9)} ${String(s.n).padStart(3)} lots   rank corr with error ${s.rho >= 0 ? '+' : ''}${s.rho.toFixed(2)}  p ${s.p.toFixed(3)}`
    + `   median error: low half ${f1(median(lo))}%, high half ${f1(median(hi))}%`;
}

export function report(lots) {
  const out = [];
  const keys = ['contrast', 'green', 'shadow', 'sharp', 'bright', 'lawn', 'sizeM2', 'near10'];
  const groups = [['all lots', lots], ['Mapbox lots only', lots.filter((l) => l.source !== 'county')],
    ['county lots only', lots.filter((l) => l.source === 'county')]];
  for (const [name, g] of groups) {
    out.push(`\n${name} (${g.length}; median error ${f1(median(g.map((l) => l.error)))}%):`);
    for (const k of keys) out.push(corrLine(k, g, k));
  }
  /* Source with the lawn's contrast held level: thirds by contrast rank. */
  const byC = lots.filter((l) => Number.isFinite(l.contrast)).sort((a, b) => a.contrast - b.contrast);
  const third = Math.ceil(byC.length / 3);
  out.push('\nSource, with contrast held level (thirds of the lots by contrast):');
  for (let t = 0; t < 3; t++) {
    const band = byC.slice(t * third, (t + 1) * third);
    const c = band.filter((l) => l.source === 'county'), m = band.filter((l) => l.source !== 'county');
    out.push(`  contrast ${['low', 'middle', 'high'][t].padEnd(6)} (${f1(band[0]?.contrast, 2)} to ${f1(band[band.length - 1]?.contrast, 2)}): `
      + `county ${String(c.length).padStart(2)} lots ${f1(median(c.map((l) => l.error)))}%   Mapbox ${String(m.length).padStart(2)} lots ${f1(median(m.map((l) => l.error)))}%`);
  }
  const leaf = lots.filter((l) => l.leafOff === 1), on = lots.filter((l) => l.leafOff === 0);
  out.push(`\nThe owner's leaf-off mark: leaf-off ${leaf.length} lots ${f1(median(leaf.map((l) => l.error)))}%, `
    + `leaf-on ${on.length} lots ${f1(median(on.map((l) => l.error)))}%, unmarked ${lots.length - leaf.length - on.length}.`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const files = (get('--results') || '').split(',').filter(Boolean).map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const row = get('--row') || PLAN_ROW;
  if (!files.length) { console.log('usage: --results a.json,b.json [--row "row name"]'); process.exit(2); }
  const { mean } = pool(files, row);
  const ids = [...mean.keys()];
  const rows = query(`SELECT id, lot_no, image_key, image_frame, frame, shapes, parcel, image_provider, leaf_off
                        FROM corpus WHERE id IN (${ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(',')})`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dir = 'hardness-photos';
  mkdirSync(dir, { recursive: true });
  const lots = [];
  const first = files[0].rows.find((r) => r.name === row);
  const diag = new Map((first?.lots || []).map((l) => [l.id, l]));
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    let cov = null;
    try {
      const photo = await photoOf(r, dir);
      cov = photo && lotCovariates(r, photo);
    } catch (e) {
      console.log(`${mapName(id, r.lot_no) || id}: no photo (${String(e.stderr || e.message).slice(0, 100)})`);
    }
    if (!cov) continue;
    const d = diag.get(id) || {};
    lots.push({
      id, name: mapName(id, r.lot_no) || id.split(':')[0], error: mean.get(id).error,
      source: r.image_provider === 'county' ? 'county' : 'mapbox', leafOff: r.leaf_off === null ? null : Number(r.leaf_off),
      sizeM2: d.truthM2 ?? null, near10: d.nearEdge10 ?? null, ...cov,
    });
  }
  rmSync(dir, { recursive: true, force: true });

  lots.sort((a, b) => b.error - a.error);
  console.log(`\n${lots.length} lots, worst first   (error %, source, contrast, green, shadow, sharp, bright, lawn share, size m2, near-edge %)`);
  for (const l of lots) {
    console.log(`  ${l.name.padEnd(5)} ${f1(l.error)}%  ${l.source.padEnd(6)} c ${f1(l.contrast, 2)}  g ${f1(l.green, 2)}  sh ${f1(100 * l.shadow, 0)}%  `
      + `sharp ${f1(l.sharp, 2)}  br ${f1(l.bright, 0)}  lawn ${f1(100 * l.lawn, 0)}%  ${String(Math.round(l.sizeM2 ?? 0)).padStart(5)} m2  edge ${f1(l.near10, 0)}%`);
  }
  console.log(`\n${'='.repeat(64)}`);
  for (const line of report(lots)) console.log(line);
  console.log('\nRead: a rank correlation near +1 means the higher this number, the worse the lot;');
  console.log('near -1, the better. p under 0.05 is worth believing at this corpus size; the rest is noise.');
  console.log(`${'='.repeat(64)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
