/**
 * MAPS FOR THE LIDAR-TREES VIEWER (owner, 2026-10-05: "use lidar to replace
 * the tree canopy model all together ... tee up the results in a separate
 * viewer page. That's just going to have to be purely manual review").
 *
 * Per approved map with lidar (tools/lidar_canopy.py ran first), writes
 * lidar-trees/model/<name>.json: the photo key, the traced lawn and its
 * INFERRED parts, the lidar's tree patches (each flagged on the lawn or not,
 * by tree-maps.js's own rule) and dense patches, and the tree model's patches
 * from workflow 28 (trees/model/<name>.json, where there is one) to compare.
 * And lidar-trees/index.json, the list /lidar-trees.html opens with.
 *
 * WHAT IT PRINTS IS A HINT, NOT A SCORE. The only truth to hand is the
 * owner's inferred marks, which are lawn under leaf-on canopy only, and whose
 * edges are not the canopy's edges. So: how much of the inferred lawn each
 * method calls tree, side by side. A method that covers more of it is finding
 * trees over lawn the other misses; it says nothing about trees it invents.
 *
 *   node tools/lidar-trees.js       (workflow 30, after lidar_canopy.py)
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { query } from './corpus-db.js';
import { lawnRings, lawnMask, REACH_M, KEEP_M2 } from './tree-maps.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { lngLatToFramePx } from '../public/lib/mercator.js';
import { mapName } from '../worker/src/benchmark-ids.js';
import { lawnSetClause, lawnSetDescription } from './lawn-set.js';

const CANOPY = process.env.CANOPY || 'lidar-canopy';
const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
export const PREFIX = 'lidar-trees/';

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const identity = (p) => p;
const closed = (ring) => (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
  ? [...ring, ring[0]] : ring);

/** The inferred shapes' rings in the photo's pixels. */
export function inferredRings(shapes, frame, w, h) {
  const list = Array.isArray(shapes) ? shapes : shapes?.features || [];
  const out = [];
  for (const f of list) {
    if (!f?.properties?.inferred || !f.geometry) continue;
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) out.push(rings.map((r) => r.map((ll) => lngLatToFramePx(frame, ll, w, h).map((v) => Math.round(v * 10) / 10))));
  }
  return out;
}

/** One mask of every patch in a list (polygon minus holes). */
export function patchMask(patches, w, h) {
  const m = new Uint8Array(w * h);
  for (const c of patches || []) {
    if (!Array.isArray(c.polygon) || c.polygon.length < 3) continue;
    const one = rasterizePolygon([closed(c.polygon), ...(c.holes || []).map(closed)], w, h, identity);
    for (let i = 0; i < m.length; i++) if (one[i]) m[i] = 1;
  }
  return m;
}

/** Of the pixels in `within`, the share `cover` marks. null if `within` is empty. */
export function coveredShare(within, cover) {
  let n = 0, k = 0;
  for (let i = 0; i < within.length; i++) if (within[i]) { n++; if (cover[i]) k++; }
  return n ? k / n : null;
}

/** Each patch marked onLawn by tree-maps.js's rule: KEEP_M2 of it in the lawn grown by REACH_M. */
export function markOnLawn(patches, lawn, w, h, m2PerPx, keepM2 = KEEP_M2) {
  return (patches || []).map((c) => {
    const one = rasterizePolygon([closed(c.polygon), ...(c.holes || []).map(closed)], w, h, identity);
    let on = 0;
    for (let i = 0; i < one.length; i++) if (one[i] && lawn[i]) on++;
    return { ...c, onLawn: on * m2PerPx >= keepM2, onLawnSqM: Math.round(on * m2PerPx * 10) / 10 };
  });
}

function r2(args) {
  return execFileSync('npx', ['wrangler', 'r2', 'object', ...args, '--remote'], { stdio: ['ignore', 'pipe', 'pipe'] });
}
const put = (key, file) => r2(['put', `${BUCKET}/${key}`, '--file', file, '--content-type', 'application/json']);
function get(key, file) {
  try { r2(['get', `${BUCKET}/${key}`, '--file', file]); return existsSync(file) ? readFileSync(file, 'utf8') : null; } catch { return null; }
}

async function main() {
  if (!existsSync(CANOPY)) {
    console.log(`No ${CANOPY}/ directory. Run tools/lidar_canopy.py first.`);
    process.exitCode = 1;
    return;
  }
  const rows = query(`
    SELECT id, lot_no, county, frame, image_frame, shapes, image_key
      FROM corpus
     WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL${lawnSetClause()}
     ORDER BY created_at`);
  console.log(`${rows.length} approved maps: ${lawnSetDescription()}.\n`);
  const dir = mkdtempSync(join(tmpdir(), 'lidar-trees-'));
  const index = [];
  const sums = { inferredPx: 0, lidar: 0, model: 0, both: 0, mapsWithInferred: 0, modelMaps: 0 };

  for (const row of rows) {
    const safe = row.id.replace(/\//g, '_');
    const found = existsSync(join(CANOPY, `${safe}.json`)) ? parse(readFileSync(join(CANOPY, `${safe}.json`), 'utf8')) : null;
    const frame = parse(row.image_frame) || parse(row.frame);
    const name = mapName(row.id, row.lot_no);
    if (!found || !frame || !name) continue;
    const w = found.framePx, h = found.framePy || found.framePx;
    const mpp = found.metresAcross / w;
    const shapes = parse(row.shapes);
    const lawn = lawnRings(shapes, frame, w, h);
    if (!lawn.length) continue;
    const inferred = inferredRings(shapes, frame, w, h);
    const near = lawnMask(lawn, w, h, REACH_M / mpp);
    const lidar = markOnLawn(found.clumps, near, w, h, mpp * mpp);

    /* The tree model's patches from workflow 28, if it made this map at the
       same size. They are the on-lawn ones only; that is all it kept. */
    const tm = parse(get(`trees/model/${name}.json`, join(dir, `tm-${name}.json`)));
    const model = tm && tm.w === w && tm.h === h ? tm.clumps || [] : null;

    let lidarOnInferred = null, modelOnInferred = null;
    if (inferred.length) {
      const inf = new Uint8Array(w * h);
      for (const rings of inferred) {
        const one = rasterizePolygon(rings.map(closed), w, h, identity);
        for (let i = 0; i < inf.length; i++) if (one[i]) inf[i] = 1;
      }
      const lm = patchMask(lidar, w, h);
      lidarOnInferred = coveredShare(inf, lm);
      let n = 0; for (const v of inf) n += v;
      if (model) {
        const mm = patchMask(model, w, h);
        modelOnInferred = coveredShare(inf, mm);
        let both = 0; for (let i = 0; i < inf.length; i++) if (inf[i] && (lm[i] || mm[i])) both++;
        sums.inferredPx += n; sums.lidar += lidarOnInferred * n; sums.model += modelOnInferred * n; sums.both += both;
        sums.modelMaps++;
      }
      sums.mapsWithInferred++;
    }

    const doc = {
      name, id: row.id, county: row.county || null, imageKey: row.image_key,
      w, h, mpp: Math.round(mpp * 1000) / 1000, at: new Date().toISOString(),
      lidar: { project: found.project || null, year: found.year || null },
      lawn, inferred, lidarClumps: lidar, dense: found.dense || [], modelClumps: model,
    };
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(doc));
    put(`${PREFIX}model/${name}.json`, file);
    const onLawn = lidar.filter((c) => c.onLawn);
    const entry = {
      name, county: row.county || null, project: found.project || null, year: found.year || null,
      lidarOnLawn: onLawn.length, lidarOnLawnSqM: Math.round(onLawn.reduce((a, c) => a + c.onLawnSqM, 0)),
      modelOnLawn: model ? model.length : null, modelOnLawnSqM: model ? Math.round(model.reduce((a, c) => a + (c.onLawnSqM || 0), 0)) : null,
      inferredCovered: lidarOnInferred === null ? null : { lidar: Math.round(lidarOnInferred * 100), model: modelOnInferred === null ? null : Math.round(modelOnInferred * 100) },
    };
    index.push(entry);
    console.log(`  ${name.padEnd(5)} lidar ${String(entry.lidarOnLawn).padStart(3)} patches / ${String(entry.lidarOnLawnSqM).padStart(5)} m² on the lawn;`
      + ` model ${model ? `${String(entry.modelOnLawn).padStart(3)} / ${String(entry.modelOnLawnSqM).padStart(5)} m²` : ' -- (no tree map)'}`
      + `${entry.inferredCovered ? `;  inferred lawn under tree: lidar ${entry.inferredCovered.lidar}%${entry.inferredCovered.model === null ? '' : `, model ${entry.inferredCovered.model}%`}` : ''}`
      + `  ${found.project || ''}`);
  }

  index.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const file = join(dir, 'index.json');
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), maps: index }));
  put(`${PREFIX}index.json`, file);
  const pct = (x) => `${Math.round((x / Math.max(1, sums.inferredPx)) * 100)}%`;
  console.log(`\n${index.length} maps with lidar trees written for /lidar-trees.html.`);
  console.log(`On the ${sums.modelMaps} maps with inferred lawn AND a tree-model map, the inferred lawn (the owner's "grass under a tree") lies under:`);
  console.log(`  lidar trees ${pct(sums.lidar)}, the tree model ${pct(sums.model)}, either ${pct(sums.both)}.`);
  console.log('A hint only: inferred marks are leaf-on canopy and their edges are not the canopy\'s. Look at the pictures.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
