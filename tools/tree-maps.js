/**
 * MAPS FOR LABELLING TREES (owner, 2026-10-04).
 *
 * WHY. The leaf-off question turned out to be per tree, not per photo -- a
 * fall photo had one tree in leaf beside bare ones -- and tracing a bare tree
 * by eye is hard, where the tree model (restor/tcd) outlines canopy well. So
 * the model draws the canopy and a person only says what each part of it is:
 * evergreen, in leaf, bare, or not a tree at all (/trees.html). Those labels
 * are the answer key for telling the three apart automatically -- the crown
 * colour test and a classifier over crown features -- never something asked
 * of anybody measuring a lawn.
 *
 * WHAT THIS WRITES, per approved map with canopy (tools/tree-canopy.py ran
 * first over the same frames, at the banked photo's own pixels):
 *   trees/model/<name>.json  the photo it was read on, the traced lawn and
 *                            the canopy patches that touch it, all in the
 *                            photo's pixels. Re-running replaces these.
 *   trees/index.json         the list /trees.html opens with.
 * The labels are saved by the page under trees/labels/, which this never
 * touches, so a re-run cannot lose them.
 *
 * Canopy NOT in the lawn is left out (owner: "remove any canopy traces that
 * are not in a lawn"): a patch is kept when at least KEEP_M2 of it lies
 * inside the lawn's outer edge -- holes included, since a tree in a lawn is
 * usually traced round -- or within REACH_M of it (lawnMask).
 *
 *   node tools/tree-maps.js        (workflow 28, after tree-canopy.py)
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { query } from './corpus-db.js';
import { geometries } from './train-detector.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { lngLatToFramePx } from '../public/lib/mercator.js';
import { mapName } from '../worker/src/benchmark-ids.js';
import { lawnSetClause, lawnSetDescription } from './lawn-set.js';

const CANOPY = process.env.CANOPY || 'canopy';
const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
export const KEEP_M2 = Number(process.env.KEEP_M2 || 1);
/* How far past the lawn's outer edge a tree still counts as in it. */
export const REACH_M = Number(process.env.REACH_M || 1);
export const PREFIX = 'trees/';

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const identity = (p) => p;
const closed = (ring) => (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
  ? [...ring, ring[0]] : ring);

/** The traced lawn's rings in the photo's pixels, one list per polygon. */
export function lawnRings(shapes, frame, w, h) {
  const out = [];
  for (const g of geometries(shapes)) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) {
      out.push(rings.map((ring) => ring.map((ll) => lngLatToFramePx(frame, ll, w, h).map((v) => Math.round(v * 10) / 10))));
    }
  }
  return out;
}

/**
 * WHERE A TREE COUNTS AS "IN THE LAWN": inside any lawn polygon's OUTER
 * ring, its holes included, and within `reachPx` of it.
 *
 * Holes included (owner, 2026-10-04: B13 lost most of its trees, "mostly
 * evergreens"): a tree in a lawn is usually traced round, as a hole in the
 * lawn, so its canopy overlapped no lawn and was dropped. And a little
 * beyond the edge, so a tree standing in the gap between two traced pieces,
 * or right on the lawn's edge, is kept too.
 */
export function lawnMask(polys, w, h, reachPx = 0) {
  const m = new Uint8Array(w * h);
  for (const rings of polys) {
    if (!rings?.[0]) continue;
    const one = rasterizePolygon([closed(rings[0])], w, h, identity);
    for (let i = 0; i < m.length; i++) if (one[i]) m[i] = 1;
  }
  return reachPx > 0 ? grow(m, w, h, Math.round(reachPx)) : m;
}

/** A mask grown by r pixels (square), in two passes. */
function grow(m, w, h, r) {
  const row = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    for (let x = 0; x < w; x++) { if (m[y * w + x]) last = x; if (x - last <= r) row[y * w + x] = 1; }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) last = x; if (last - x <= r) row[y * w + x] = 1; }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) { if (row[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) { if (row[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

/**
 * The canopy patches that touch the lawn, each with how much of it does.
 * `clumps` as tree-canopy.py writes them: polygon + holes in the photo's px.
 */
export function clumpsOnLawn(clumps, lawn, w, h, m2PerPx, keepM2 = KEEP_M2) {
  const kept = [];
  for (const c of clumps || []) {
    if (!Array.isArray(c.polygon) || c.polygon.length < 3) continue;
    const mask = rasterizePolygon([closed(c.polygon), ...(c.holes || []).map(closed)], w, h, identity);
    let on = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] && lawn[i]) on++;
    if (on * m2PerPx >= keepM2) {
      kept.push({ polygon: c.polygon, holes: c.holes || [], areaSqM: c.areaSqM, onLawnSqM: Math.round(on * m2PerPx * 10) / 10 });
    }
  }
  return kept;
}

const put = (key, file) => execFileSync('npx', [
  'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file,
  '--content-type', 'application/json', '--remote',
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function main() {
  if (!existsSync(CANOPY)) {
    console.log(`No ${CANOPY}/ directory. Run tools/tree-canopy.py first.`);
    process.exitCode = 1;
    return;
  }
  const rows = query(`
    SELECT id, lot_no, county, frame, image_frame, shapes, image_key
      FROM corpus
     WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL${lawnSetClause()}
     ORDER BY created_at`);
  console.log(`${rows.length} approved maps: ${lawnSetDescription()}.\n`);
  const dir = mkdtempSync(join(tmpdir(), 'trees-'));
  const index = [];
  let patches = 0, dropped = 0;

  for (const row of rows) {
    const found = existsSync(join(CANOPY, `${row.id}.json`)) ? parse(readFileSync(join(CANOPY, `${row.id}.json`), 'utf8')) : null;
    const frame = parse(row.image_frame) || parse(row.frame);
    const name = mapName(row.id, row.lot_no);
    if (!found || !frame || !name) continue;
    const w = found.framePx, h = found.framePy || found.framePx;
    const mpp = found.metresAcross / w;
    const lawn = lawnRings(parse(row.shapes), frame, w, h);
    if (!lawn.length) continue;
    const kept = clumpsOnLawn(found.clumps, lawnMask(lawn, w, h, REACH_M / mpp), w, h, mpp * mpp);
    patches += kept.length;
    dropped += (found.clumps || []).length - kept.length;
    const doc = {
      name, id: row.id, county: row.county || null, imageKey: row.image_key,
      w, h, mpp: Math.round(mpp * 1000) / 1000, model: found.model, at: new Date().toISOString(),
      lawn, clumps: kept,
    };
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(doc));
    put(`${PREFIX}model/${name}.json`, file);
    index.push({ name, county: row.county || null, clumps: kept.length,
      canopyOnLawnSqM: Math.round(kept.reduce((a, c) => a + c.onLawnSqM, 0)) });
    console.log(`  ${name.padEnd(5)} ${String(kept.length).padStart(3)} canopy patch(es) on the lawn, ${(found.clumps || []).length - kept.length} off it left out`);
  }

  index.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const file = join(dir, 'index.json');
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), maps: index }));
  put(`${PREFIX}index.json`, file);
  console.log(`\n${index.length} maps for labelling trees, ${patches} canopy patches on lawns (${dropped} off the lawns left out).`);
  console.log(`${index.filter((m) => m.clumps).length} have canopy on the lawn to label. Open /trees.html.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
