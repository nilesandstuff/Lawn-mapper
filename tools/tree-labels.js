/**
 * WHAT THE TREE LABELS SAY (owner, 2026-10-05: "see if you can do anything
 * with the ones I did").
 *
 * The owner labels the tree model's canopy on /trees.html -- evergreen, in
 * leaf, bare, not a tree -- and this reads those labels against the photos to
 * answer the two questions the labels exist for (findings S22, H71):
 *
 *   1. BARE VS IN LEAF (the owner's option #1). A bare crown shows a web of
 *      grey, brown and black branch lines; a crown in leaf, evergreen or not,
 *      is mostly solid foliage. How well does each colour and texture measure
 *      of a crown tell them apart -- and the colour rule stage 3 already has
 *      (stage3.js bareCanopy)?
 *   2. EVERGREEN VS IN LEAF (option #4). Which crown features separate them,
 *      and how well a small classifier over all of them does.
 *
 * A "crown" here is a connected run of one label inside one canopy patch, at
 * least MIN_CROWN_M2: that is the unit somebody painted. Every score is held
 * out BY MAP (a threshold or a classifier is fitted on the other maps and
 * tried on this one), because crowns on one map share a photo, a season and
 * a light, and scoring them against each other would flatter everything.
 *
 *   node tools/tree-labels.js     (workflow 29)
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { fetchImage } from './train-detector.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { bareCanopy } from './stage3.js';

const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
export const MIN_CROWN_M2 = Number(process.env.MIN_CROWN_M2 || 2);
export const CODES = { 1: 'evergreen', 2: 'leaf', 3: 'bare', 4: 'nottree' };

const closed = (ring) => (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
  ? [...ring, ring[0]] : ring);

/** Which patch each pixel is in (k + 1), as /trees.html computes it. */
export function patchIds(clumps, w, h) {
  const ids = new Int32Array(w * h);
  clumps.forEach((c, k) => {
    const m = rasterizePolygon([closed(c.polygon), ...(c.holes || []).map(closed)], w, h, (p) => p);
    for (let i = 0; i < m.length; i++) if (m[i] && !ids[i]) ids[i] = k + 1;
  });
  return ids;
}

/**
 * The crowns: connected runs (8 neighbours) of one label code inside one
 * patch. Returns [{ code, patch, px: Int32Array of pixel indices }].
 */
export function crowns(labels, ids, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < labels.length; s++) {
    if (seen[s] || !ids[s] || !CODES[labels[s]]) continue;
    const code = labels[s], patch = ids[s];
    let top = 0, n = 0;
    const px = [];
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top];
      px.push(i); n++;
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (!dx && !dy)) continue;
          const j = yy * w + xx;
          if (!seen[j] && ids[j] === patch && labels[j] === code) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    out.push({ code, patch, px: Int32Array.from(px) });
  }
  return out;
}

/**
 * A crown's colour and texture, from RGBA `rgba` (w x h), and the colour
 * rule's own verdict per pixel (`ruleBare`, bareCanopy over the canopy).
 */
export function features(px, rgba, w, h, ruleBare) {
  let r = 0, g = 0, b = 0, exg = 0, leafy = 0, notGreen = 0, dark = 0, greyBrown = 0, edge = 0, ruled = 0;
  let lum = 0, lum2 = 0;
  const L = (i) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  for (const i of px) {
    const R = rgba[i * 4], G = rgba[i * 4 + 1], B = rgba[i * 4 + 2];
    const sum = R + G + B;
    const e = sum ? (2 * G - R - B) / sum : 0;
    r += R; g += G; b += B; exg += e;
    if (sum < 90) dark++;
    else if (e < 0.03) notGreen++;
    else leafy++;
    /* Grey or brown: not green at all, and not dark (branches, bark, dead
       leaves, dormant ground showing through). */
    if (sum >= 90 && e < 0) greyBrown++;
    const l = L(i);
    lum += l; lum2 += l * l;
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && x < w - 1 && y > 0 && y < h - 1) edge += Math.hypot(L(i + 1) - L(i - 1), L(i + w) - L(i - w)) / 2;
    if (ruleBare && ruleBare[i]) ruled++;
  }
  const n = px.length;
  const mean = lum / n;
  return {
    brightness: (r + g + b) / (3 * n),
    exg: exg / n,
    blueShare: b / Math.max(1, r + g + b),
    redShare: r / Math.max(1, r + g + b),
    leafyShare: leafy / n,
    notGreenShare: notGreen / n,
    darkShare: dark / n,
    greyBrownShare: greyBrown / n,
    edge: edge / n,
    texture: Math.sqrt(Math.max(0, lum2 / n - mean * mean)),
    ruleBareShare: ruled / n,
  };
}
export const FEATURES = ['brightness', 'exg', 'blueShare', 'redShare', 'leafyShare', 'notGreenShare', 'darkShare',
  'greyBrownShare', 'edge', 'texture', 'ruleBareShare'];

/*
 * THE LIDAR UNDER EACH CROWN (owner, 2026-10-05: first returns against later
 * ones), from tools/tree_lidar.py: the median over the crown's 1 m cells of
 * each layer. See that file for what each means.
 */
export const LIDAR_FEATURES = ['l_height', 'l_first_h', 'l_last_h', 'l_spread', 'l_penetration', 'l_multi', 'l_veg_class', 'l_building_class'];

/** One frame's tree-lidar layers, or null. */
export function readLidar(dir, id, readFile = readFileSync, exists = existsSync) {
  const safe = String(id).replace(/\//g, '_');
  const metaFile = join(dir, `${safe}.json`), dataFile = join(dir, `${safe}.f32`);
  if (!exists(metaFile) || !exists(dataFile)) return null;
  const meta = JSON.parse(readFile(metaFile, 'utf8'));
  const buf = readFile(dataFile);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = meta.gw * meta.gh;
  const layers = {};
  meta.layers.forEach((k, j) => { layers[k] = all.subarray(j * n, (j + 1) * n); });
  return { ...meta, layers };
}

/** Medians of the lidar layers over a crown's cells (photo w x h onto the lidar grid). */
export function lidarFeatures(px, w, h, lid) {
  const out = {};
  const cells = new Set();
  for (const i of px) {
    const x = i % w, y = (i / w) | 0;
    const c = Math.min(lid.gw - 1, Math.floor((x * lid.gw) / w)) + lid.gw * Math.min(lid.gh - 1, Math.floor((y * lid.gh) / h));
    cells.add(c);
  }
  for (const k of LIDAR_FEATURES) {
    const layer = lid.layers[k.slice(2)];
    const vals = [...cells].map((c) => layer?.[c]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    out[k] = vals.length ? vals[vals.length >> 1] : NaN;
  }
  return out;
}

/* ----------------------------------------------------------- the reading */

/** Area under the ROC curve of `score` for pos vs neg (0.5 = no better than chance). */
export function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Balanced accuracy of "positive when value >= t" (dir +1) or "<= t" (dir -1). */
function balanced(rows, key, t, dir) {
  let tp = 0, p = 0, tn = 0, n = 0;
  for (const r of rows) {
    const says = dir > 0 ? r.f[key] >= t : r.f[key] <= t;
    if (r.y) { p++; if (says) tp++; } else { n++; if (!says) tn++; }
  }
  return p && n ? (tp / p + tn / n) / 2 : null;
}

/** The threshold on `key` that best separates the rows, and its direction. */
function bestCut(rows, key) {
  const vals = [...new Set(rows.map((r) => r.f[key]))].sort((a, b) => a - b);
  let best = { acc: -1, t: null, dir: 1 };
  for (const t of vals) {
    for (const dir of [1, -1]) {
      const acc = balanced(rows, key, t, dir);
      if (acc !== null && acc > best.acc) best = { acc, t, dir };
    }
  }
  return best;
}

/** Held out by map: the cut chosen on the other maps, scored on this one. */
export function heldOutCut(rows, key) {
  const maps = [...new Set(rows.map((r) => r.map))];
  const scored = [];
  for (const m of maps) {
    const train = rows.filter((r) => r.map !== m);
    if (!train.some((r) => r.y) || !train.some((r) => !r.y)) continue;
    const { t, dir } = bestCut(train, key);
    for (const r of rows.filter((x) => x.map === m)) scored.push({ y: r.y, says: dir > 0 ? r.f[key] >= t : r.f[key] <= t });
  }
  const p = scored.filter((s) => s.y), n = scored.filter((s) => !s.y);
  return p.length && n.length ? (p.filter((s) => s.says).length / p.length + n.filter((s) => !s.says).length / n.length) / 2 : null;
}

/** Logistic regression over every feature, standardised, held out by map. */
export function heldOutLogistic(rows, keys = FEATURES, { iters = 400, rate = 0.3, l2 = 0.01 } = {}) {
  const maps = [...new Set(rows.map((r) => r.map))];
  const scored = [];
  for (const m of maps) {
    const train = rows.filter((r) => r.map !== m);
    const test = rows.filter((r) => r.map === m);
    if (!train.some((r) => r.y) || !train.some((r) => !r.y)) continue;
    const mu = keys.map((k) => train.reduce((a, r) => a + r.f[k], 0) / train.length);
    const sd = keys.map((k, j) => Math.sqrt(train.reduce((a, r) => a + (r.f[k] - mu[j]) ** 2, 0) / train.length) || 1);
    const x = (r) => keys.map((k, j) => (r.f[k] - mu[j]) / sd[j]);
    /* Classes weighted equally, so a rare class is not simply ignored. */
    const wp = train.length / (2 * train.filter((r) => r.y).length), wn = train.length / (2 * train.filter((r) => !r.y).length);
    let wgt = new Array(keys.length).fill(0), bias = 0;
    const X = train.map(x);
    for (let it = 0; it < iters; it++) {
      const gw = new Array(keys.length).fill(0);
      let gb = 0;
      train.forEach((r, i) => {
        const z = bias + X[i].reduce((a, v, j) => a + v * wgt[j], 0);
        const err = (1 / (1 + Math.exp(-z)) - (r.y ? 1 : 0)) * (r.y ? wp : wn);
        X[i].forEach((v, j) => { gw[j] += err * v; });
        gb += err;
      });
      wgt = wgt.map((v, j) => v - rate * (gw[j] / train.length + l2 * v));
      bias -= rate * (gb / train.length);
    }
    for (const r of test) {
      const z = bias + x(r).reduce((a, v, j) => a + v * wgt[j], 0);
      scored.push({ y: r.y, says: z >= 0 });
    }
  }
  const p = scored.filter((s) => s.y), n = scored.filter((s) => !s.y);
  return p.length && n.length ? (p.filter((s) => s.says).length / p.length + n.filter((s) => !s.says).length / n.length) / 2 : null;
}

function question(title, rows, posName, negName, keys = FEATURES) {
  rows = rows.filter((r) => keys.every((k) => Number.isFinite(r.f[k])));
  const pos = rows.filter((r) => r.y), neg = rows.filter((r) => !r.y);
  const maps = new Set(rows.map((r) => r.map)).size;
  console.log(`\n${title}: ${pos.length} ${posName} crowns vs ${neg.length} ${negName}, on ${maps} maps.`);
  if (pos.length < 3 || neg.length < 3 || maps < 3) {
    console.log('  Too few to read (needs at least 3 of each, on 3 maps). Label more first.');
    return null;
  }
  console.log(`  ${'feature'.padEnd(16)}${'AUC'.padStart(7)}${'best cut'.padStart(12)}${'held out by map'.padStart(18)}`);
  const lines = [];
  for (const k of keys) {
    const a = auc(pos.map((r) => r.f[k]), neg.map((r) => r.f[k]));
    const sep = a === null ? null : Math.max(a, 1 - a);
    const ho = heldOutCut(rows, k);
    lines.push({ k, a, sep, ho });
  }
  lines.sort((x, y) => (y.sep ?? 0) - (x.sep ?? 0));
  for (const { k, a, ho } of lines) {
    const dir = a === null ? '' : a >= 0.5 ? `higher = ${posName}` : `lower = ${posName}`;
    console.log(`  ${k.padEnd(16)}${(a === null ? '--' : a.toFixed(2)).padStart(7)}${(ho === null ? '--' : `${(ho * 100).toFixed(0)}%`).padStart(30)}   ${dir}`);
  }
  const lr = heldOutLogistic(rows, keys);
  console.log(`  every feature together (logistic regression, held out by map): ${lr === null ? '--' : `${(lr * 100).toFixed(0)}% balanced accuracy`}`);
  return { n: { [posName]: pos.length, [negName]: neg.length, maps }, features: lines, logistic: lr };
}

/* ------------------------------------------------------------------ main */

function get(key, file) {
  try {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`, '--file', file, '--remote'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    return existsSync(file) ? readFileSync(file) : null;
  } catch { return null; }
}

async function main() {
  const decoders = { png: await import('pngjs'), jpeg: (await import('jpeg-js')).default };
  const dir = mkdtempSync(join(tmpdir(), 'tree-labels-'));
  const index = JSON.parse(get('trees/index.json', join(dir, 'index.json')) || '{"maps":[]}');
  const rows = [];
  const pixels = { 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0] }; // [labelled px, of them the colour rule calls bare]
  const perMap = [];
  for (const m of index.maps || []) {
    const raw = get(`trees/labels/${m.name}.json`, join(dir, `${m.name}-labels.json`));
    if (!raw) continue;
    const saved = JSON.parse(raw);
    const model = JSON.parse(get(`trees/model/${m.name}.json`, join(dir, `${m.name}.json`)) || 'null');
    if (!model || !saved.labels) continue;
    const { w, h } = model;
    const png = decoders.png.PNG.sync.read(Buffer.from(saved.labels.split(',')[1], 'base64'));
    if (png.width !== w || png.height !== h) { console.log(`  ${m.name}: labels ${png.width}x${png.height}, photo ${w}x${h} -- skipped`); continue; }
    const labels = new Uint8Array(w * h);
    for (let i = 0; i < labels.length; i++) labels[i] = png.data[i * 4];
    const photo = fetchImage(BUCKET, model.imageKey, dir, decoders);
    if (!photo.ok || photo.width !== w || photo.height !== h) { console.log(`  ${m.name}: photo ${photo.ok ? `${photo.width}x${photo.height}` : photo.reason} -- skipped`); continue; }
    /* The outlines the editor shows: the saved ones unless the map was made
       again since (outlines fixed 2026-10-04, B09 and B13). A save older
       than the map was painted on outlines that are gone; only what it put
       on today's canopy counts. */
    const fresh = !saved.at || !model.at || saved.at >= model.at;
    const ids = patchIds((fresh ? saved.clumps : model.clumps) || model.clumps || [], w, h);
    const canopy = new Uint8Array(w * h);
    for (let i = 0; i < canopy.length; i++) canopy[i] = ids[i] ? 1 : 0;
    const ruleBare = bareCanopy(canopy, photo.data, w, h, { mpp: model.mpp });
    let labelled = 0;
    for (let i = 0; i < labels.length; i++) {
      if (!ids[i] || !pixels[labels[i]]) continue;
      labelled++;
      pixels[labels[i]][0]++;
      if (ruleBare[i]) pixels[labels[i]][1]++;
    }
    const m2 = model.mpp * model.mpp;
    const cs = crowns(labels, ids, w, h).filter((c) => c.px.length * m2 >= MIN_CROWN_M2);
    const lid = process.env.LIDAR ? readLidar(process.env.LIDAR, model.id) : null;
    for (const c of cs) {
      rows.push({ map: m.name, code: c.code, areaM2: c.px.length * m2,
        f: { ...features(c.px, photo.data, w, h, ruleBare), ...(lid ? lidarFeatures(c.px, w, h, lid) : {}) },
        lidar: lid ? { project: lid.project, year: lid.year } : null });
    }
    let canopyPx = 0;
    for (let i = 0; i < ids.length; i++) if (ids[i]) canopyPx++;
    perMap.push({ name: m.name, status: saved.status, stale: !fresh, labelledM2: Math.round(labelled * m2),
      canopyM2: Math.round(canopyPx * m2), crowns: cs.length,
      byCode: Object.fromEntries(Object.entries(CODES).map(([k, v]) => [v, cs.filter((c) => c.code === Number(k)).length])) });
    console.log(`  ${m.name.padEnd(5)} ${saved.status.padEnd(5)} ${String(Math.round(labelled * m2)).padStart(6)} of ${String(Math.round(canopyPx * m2)).padStart(5)} m² canopy labelled${fresh ? '' : ' (saved before the outlines were remade)'}, ${cs.length} crowns`
      + ` (${Object.entries(CODES).map(([k, v]) => `${v} ${cs.filter((c) => c.code === Number(k)).length}`).join(', ')})`);
  }
  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${perMap.length} maps labelled, ${rows.length} crowns of at least ${MIN_CROWN_M2} m².`);
  const stale = perMap.filter((p) => p.stale);
  if (stale.length) {
    console.log(`${stale.length} were saved before their outlines were remade; what they painted counts only where it lands on today's canopy:`);
    console.log(`  ${stale.map((p) => `${p.name} ${p.canopyM2 ? Math.round((p.labelledM2 / p.canopyM2) * 100) : 0}%`).join(', ')}`);
  }
  console.log('\nTHE COLOUR RULE STAGE 3 HAS (bareCanopy: not green over ~1 m, not dark), per labelled pixel:');
  for (const [k, v] of Object.entries(CODES)) {
    const [n, bare] = pixels[k];
    if (n) console.log(`  ${v.padEnd(10)} ${String(n).padStart(9)} px, called bare ${((bare / n) * 100).toFixed(0).padStart(3)}%`);
  }

  const leafy = (r) => r.code === 1 || r.code === 2;
  const q1 = question('1. BARE VS IN LEAF (evergreen or broadleaf)',
    rows.filter((r) => r.code === 3 || leafy(r)).map((r) => ({ ...r, y: r.code === 3 })), 'bare', 'in-leaf');
  const q2 = question('2. EVERGREEN VS BROADLEAF IN LEAF',
    rows.filter(leafy).map((r) => ({ ...r, y: r.code === 1 })), 'evergreen', 'broadleaf');

  /* THE LIDAR (owner, 2026-10-05): the same two questions on the crowns with
     lidar under them, on lidar alone and on lidar with the colour. */
  let q3 = null, q4 = null, q5 = null;
  if (rows.some((r) => r.lidar)) {
    const withLidar = rows.filter((r) => r.lidar);
    console.log(`\nLIDAR under ${withLidar.length} of ${rows.length} crowns, on ${new Set(withLidar.map((r) => r.map)).size} maps`
      + ` (projects flown ${[...new Set(withLidar.map((r) => r.lidar.year).filter(Boolean))].sort().join(', ')}).`);
    q3 = question('3. EVERGREEN VS BROADLEAF IN LEAF, lidar alone',
      withLidar.filter(leafy).map((r) => ({ ...r, y: r.code === 1 })), 'evergreen', 'broadleaf', LIDAR_FEATURES);
    q4 = question('4. EVERGREEN VS BROADLEAF IN LEAF, lidar and colour together',
      withLidar.filter(leafy).map((r) => ({ ...r, y: r.code === 1 })), 'evergreen', 'broadleaf', [...FEATURES, ...LIDAR_FEATURES]);
    q5 = question('5. NOT A TREE VS A TREE (the tree model wrong), lidar alone',
      withLidar.map((r) => ({ ...r, y: r.code === 4 })), 'not-a-tree', 'tree', LIDAR_FEATURES);
  }

  if (process.env.OUT) {
    writeFileSync(process.env.OUT, JSON.stringify({ at: new Date().toISOString(), minCrownM2: MIN_CROWN_M2, perMap, pixels, q1, q2, q3, q4, q5,
      crowns: rows.map((r) => ({ map: r.map, kind: CODES[r.code], areaM2: Math.round(r.areaM2 * 10) / 10,
        ...Object.fromEntries(Object.entries(r.f).map(([k, v]) => [k, Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null])) })) }, null, 1));
    console.log(`\nEvery crown's numbers in ${process.env.OUT}.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
