/**
 * Workflow 25's other half: photographs for the not-lawn examples.
 *
 *   node tools/not-lawn-examples.js seeds > seeds.json
 *       every approved map's centre, for tools/not_lawn_candidates.py to
 *       search near (same regions, same kind of photography) and keep clear of
 *   node tools/not-lawn-examples.js fetch candidates.json DIR
 *       a Mapbox photograph of each candidate's frame, captured exactly as a
 *       finished map's is (worker/src/imagery.js captureFrame: ~10 cm a
 *       pixel), beside a JSON of its outlines, as a DRAFT
 *   node tools/not-lawn-examples.js upload DIR
 *       both to R2 under examples/, for /outlines.html
 *
 * Why these exist and what training will do with them: worker/src/outlines.js
 * and docs/DETECTOR-FINDINGS.md. Nothing here reaches the detector until the
 * owner approves it.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { frameFor } from '../public/lib/mercator.js';
import { captureFrame, imageryUrl, frameBbox3857 } from '../worker/src/imagery.js';
import { lngLatToFramePx, metresPerPixel } from '../public/lib/mercator.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { keptOutlines } from '../worker/src/outlines.js';
import { query } from './corpus-db.js';

const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
export const EXAMPLE_PREFIX = 'examples/';

/** The display frame for a box (the same rule a map's frame follows), then the capture. */
export function exampleFrame(bbox) {
  const display = frameFor(bbox, 640, { marginM: 0 });
  return captureFrame(display).frame;
}

function seeds() {
  const rows = query(`SELECT lng, lat FROM corpus WHERE status = 'approved' AND lng IS NOT NULL`);
  process.stdout.write(`${JSON.stringify(rows.map((r) => ({ lng: r.lng, lat: r.lat })))}\n`);
  console.error(`${rows.length} approved maps to search near and keep clear of.`);
}

async function fetchAll(candidatesPath, dir) {
  const token = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_SERVER_TOKEN (or MAPBOX_TOKEN) is needed to photograph the examples');
  const candidates = JSON.parse(readFileSync(candidatesPath, 'utf8'));
  mkdirSync(dir, { recursive: true });
  let got = 0;
  for (const c of candidates) {
    const frame = exampleFrame(c.bbox);
    const url = imageryUrl('mapbox', frame, token);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('image/')) throw new Error(`HTTP ${res.status} ${type}`);
      writeFileSync(join(dir, `${c.id}.png`), Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      console.log(`  ${c.id}: no photograph (${e.message})`);
      continue;
    }
    writeFileSync(join(dir, `${c.id}.json`), JSON.stringify({
      id: c.id, status: 'draft', target: c.target, frame, bbox: c.bbox,
      features: c.features, errors: c.errors || undefined,
      fetchedAt: new Date().toISOString(),
      attribution: 'Imagery (c) Mapbox. Outlines: (c) OpenStreetMap contributors, ODbL; USGS NHD (public domain).',
    }));
    got++;
  }
  console.log(`${got} of ${candidates.length} examples photographed.`);
}

/*
 * NEVER OVER AN EXAMPLE ALREADY SAVED (owner, 2026-09-28: "it'd be
 * unfortunate if there's missing shapes that get inserted later on"). A
 * top-up or a rerun numbers the same ids again; writing over one would
 * replace an example the owner reviewed with a fresh draft carrying
 * different outlines. So an id already in the bucket is skipped, JSON and
 * photo both, and said so. Any other failure to look stops the upload
 * rather than guessing.
 */
export function alreadySaved(id, get = wranglerGet) {
  const r = get(`${BUCKET}/${EXAMPLE_PREFIX}${id}.json`);
  if (r.ok) return true;
  if (/not.?found|does not exist|NoSuchKey|404/i.test(r.err)) return false;
  throw new Error(`could not tell whether ${id} is already saved: ${r.err.split('\n')[0]}`);
}

/*
 * TO A FILE, NEVER THROUGH A PIPE: a pond's example carries USGS outlines of
 * a megabyte and more, past execFileSync's 1 MB pipe limit -- the call then
 * failed, left wrangler running, and the orphans piled up until GitHub shut
 * the runner down (the first audit, twice, 2026-09-28).
 */
const TMP = join(process.env.RUNNER_TEMP || '/tmp', 'not-lawn-get.json');
function wranglerGet(key) {
  try {
    execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'get', key, '--file', TMP, '--remote'],
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, err: '', text: () => readFileSync(TMP, 'utf8') };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.stdout || e.message) };
  }
}

function upload(dir) {
  const ids = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  let wrote = 0;
  const kept = [];
  for (const id of ids) {
    if (alreadySaved(id)) { kept.push(id); continue; }
    for (const [f, type] of [[`${id}.png`, 'image/png'], [`${id}.json`, 'application/json']]) {
      execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${EXAMPLE_PREFIX}${f}`,
        '--file', join(dir, f), '--content-type', type, '--remote'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    wrote++;
  }
  if (kept.length) console.log(`${kept.length} already saved and left alone: ${kept.join(', ')}`);
  console.log(`${wrote} new examples written to ${BUCKET}/${EXAMPLE_PREFIX}.`);
}

/*
 * READ-ONLY: what is stored for every example -- status, when reviewed, the
 * whole-example shift and each outline's own, and the review record. Asked
 * for when the owner saw approved examples load with outlines where the
 * public map had them, not where he had moved them (2026-09-28).
 */
function audit() {
  const kinds = { water: 75, building: 20, pool: 2, driveway: 15, parking: 15, road: 5, sidewalk: 5 };
  const rows = [];
  for (const [kind, n] of Object.entries(kinds)) {
    for (let i = 1; i <= n; i++) {
      const id = `${kind}-${String(i).padStart(3, '0')}`;
      const got = wranglerGet(`${BUCKET}/${EXAMPLE_PREFIX}${id}.json`);
      if (!got.ok) { console.log(`${id}: not read (${got.err.split('\n')[0].slice(0, 100)})`); continue; }
      const doc = JSON.parse(got.text());
      if (doc.status === 'draft' && !doc.reviewedAt) continue;
      const own = (doc.features || []).map((f, k) => (f.properties?.shift ? `${k}:${f.properties.shift.east},${f.properties.shift.north}` : null)).filter(Boolean);
      const dropped = (doc.features || []).filter((f) => f.properties?.dropped).length;
      const row = (`${id.padEnd(13)} ${String(doc.status).padEnd(9)} ${String(doc.reviewedAt || '').slice(0, 19).padEnd(20)}`
        + ` shift=${doc.shift ? `${doc.shift.east},${doc.shift.north} (${doc.shift.source})` : '-'}`
        + ` own=[${own.join(' ')}] dropped=${dropped}/${(doc.features || []).length}`
        + ` record=${doc.reviewed ? `${doc.reviewed.kept.length}/${doc.reviewed.count}` : '-'}`);
      console.log(row);
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.slice(24, 44).localeCompare(b.slice(24, 44)));
  console.log('\nIn review order:\n' + rows.join('\n'));
  console.log(`${rows.length} examples reviewed at least once.`);
}

/*
 * THE APPROVED EXAMPLES AS TRAINING FRAMES (owner, 2026-09-28: "run some
 * fused runs with the outlines"). Each approved example is written into
 * workflow 14's frames directory exactly as a corpus lot is -- the photo,
 * a labels PNG on the scoring grid, and its entries in scale.json -- so the
 * canopy, lidar, NAIP and backbone steps treat it like any other frame.
 *
 * The labels say only what the owner kept: G (graded ground) is 255 inside
 * the kept outlines, moved by the example's and each outline's own shift,
 * and 0 everywhere else, so nothing outside them is taught at all; R (lawn)
 * is 0. tools/train_decoder.py recognises the id (':example:') and trains on
 * it without ever holding it out; the scorer never sees it (it scores the
 * corpus only). Only keptOutlines() is read: a draft, a rejected example or
 * one whose outline count changed since review contributes nothing.
 */
export const exampleFrameId = (doc) => `${doc.frame.lng.toFixed(5)},${doc.frame.lat.toFixed(5)}:example:${doc.id}`;

/** The kept outlines, shifts applied, as a mask on a w x h grid over the example's frame. */
export function exampleMask(doc, w, h) {
  const out = new Uint8Array(w * h);
  const cell = metresPerPixel(doc.frame, w);
  const all = doc.shift || { east: 0, north: 0 };
  for (const f of keptOutlines(doc)) {
    const own = f.properties?.shift || { east: 0, north: 0 };
    const dx = (all.east + own.east) / cell;
    const dy = -(all.north + own.north) / cell;
    const project = (ll) => { const [x, y] = lngLatToFramePx(doc.frame, ll, w, h); return [x + dx, y + dy]; };
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) {
      const m = rasterizePolygon(rings, w, h, project);
      for (let i = 0; i < m.length; i++) if (m[i]) out[i] = 1;
    }
  }
  return out;
}

/** Pixel size of a PNG or JPEG from its header, or null. */
export function imageDims(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

async function framesMode(dir) {
  const { PNG } = await import('pngjs');
  const { gridDims } = await import('./train-detector.js');
  const scalePath = join(dir, 'scale.json');
  const scale = JSON.parse(readFileSync(scalePath, 'utf8'));
  for (const k of ['frames', 'downs', 'boxes', 'storedPx', 'storedPy']) scale[k] = scale[k] || {};
  const kinds = ['water', 'building', 'pool', 'driveway', 'parking', 'road', 'sidewalk', 'rail'];
  const counts = {};
  let written = 0;
  /* At most this many frames of each kind (owner, 2026-09-29: "possibly we
     just gave it the wrong number of outlines"); unset means all of them.
     The lowest-numbered approved ones, so a run is repeatable. */
  const perKind = Number(process.env.EXAMPLES_PER_KIND) || Infinity;
  for (const kind of kinds) {
    let ofKind = 0;
    for (let i = 1, misses = 0; misses < 3 && ofKind < perKind; i++) {
      const id = `${kind}-${String(i).padStart(3, '0')}`;
      const got = wranglerGet(`${BUCKET}/${EXAMPLE_PREFIX}${id}.json`);
      if (!got.ok) { misses++; continue; }
      misses = 0;
      const doc = JSON.parse(got.text());
      if (!keptOutlines(doc).length || !doc.frame) continue;
      const { w, h } = gridDims(doc.frame);
      const mask = exampleMask(doc, w, h);
      if (!mask.some(Boolean)) continue;
      const fid = exampleFrameId(doc);
      const img = wranglerGet(`${BUCKET}/${EXAMPLE_PREFIX}${id}.png`);
      if (!img.ok) { console.log(`  ${id}: photo not read, left out`); continue; }
      writeFileSync(join(dir, `${fid}.png`), readFileSync(TMP));
      const png = new PNG({ width: w, height: h });
      for (let k = 0; k < w * h; k++) {
        png.data[k * 4] = 0; png.data[k * 4 + 1] = mask[k] ? 255 : 0; png.data[k * 4 + 2] = 0; png.data[k * 4 + 3] = 255;
      }
      writeFileSync(join(dir, `${fid}-labels.png`), PNG.sync.write(png));
      const across = metresPerPixel(doc.frame, 1);
      const height = doc.frame.height || doc.frame.size;
      scale.frames[fid] = across;
      scale.downs[fid] = across * (height / doc.frame.size);
      scale.boxes[fid] = frameBbox3857(doc.frame);
      const dims = imageDims(readFileSync(TMP)) || { w: doc.frame.size * 2, h: height * 2 };
      scale.storedPx[fid] = dims.w;
      scale.storedPy[fid] = dims.h;
      for (const f of keptOutlines(doc)) {
        const c = f.properties?.class || 'other';
        counts[c] = (counts[c] || 0) + 1;
      }
      written++;
      ofKind++;
    }
  }
  writeFileSync(scalePath, JSON.stringify(scale));
  console.log(`${written} approved not-lawn examples written as training frames; `
    + `outlines kept: ${Object.entries(counts).map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}.`);
}

/*
 * APPROVED NOT-LAWN-ONLY MAPS AS EXAMPLE FRAMES (owner, 2026-10-02): the
 * substitute for the public outlines, mostly for ponds, which the corpus has
 * almost none of in lawns. A map of only not-lawn traces, once approved on
 * the console ('notlawn-approved'), says "this shape is not lawn" and nothing
 * about its surroundings -- "the not lawn shapes may not necessarily be
 * surrounded by lawn". So it is written exactly as an approved public outline
 * was: G (graded) 255 inside the traces and 0 everywhere else, R (lawn) 0, and
 * an id carrying ':example:', which train_decoder.py trains on, never holds
 * out and never scores. Its photo is the map's own banked one, on its
 * image_frame -- the county photo for a map made on one.
 */
export const mapExampleId = (row, frame) => `${frame.lng.toFixed(5)},${frame.lat.toFixed(5)}:example:map-${
  String(row.id).replace(/[^A-Za-z0-9]+/g, '').slice(-12)}`;

/** A map's not-lawn traces as a mask on a w x h grid over `frame`. */
export function notLawnMask(notLawn, frame, w, h) {
  const out = new Uint8Array(w * h);
  const project = (ll) => lngLatToFramePx(frame, ll, w, h);
  for (const f of notLawn || []) {
    const g = f?.geometry || f;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) {
      const m = rasterizePolygon(rings, w, h, project);
      for (let i = 0; i < m.length; i++) if (m[i]) out[i] = 1;
    }
  }
  return out;
}

async function mapsMode(dir) {
  const { PNG } = await import('pngjs');
  const { gridDims } = await import('./train-detector.js');
  const scalePath = join(dir, 'scale.json');
  const scale = JSON.parse(readFileSync(scalePath, 'utf8'));
  for (const k of ['frames', 'downs', 'boxes', 'storedPx', 'storedPy']) scale[k] = scale[k] || {};
  let rows = [];
  try {
    rows = query(`SELECT id, image_key, image_frame, not_lawn FROM corpus
                   WHERE status = 'notlawn-approved' AND image_key IS NOT NULL AND image_frame IS NOT NULL`);
  } catch (e) {
    console.log(`Could not read the approved not-lawn maps (${e.message}); none written.`);
    return;
  }
  let written = 0;
  for (const row of rows) {
    const frame = JSON.parse(row.image_frame);
    const { w, h } = gridDims(frame);
    const mask = notLawnMask(JSON.parse(row.not_lawn || '[]'), frame, w, h);
    if (!mask.some(Boolean)) { console.log(`  ${row.id}: no trace inside its photo, left out`); continue; }
    const img = wranglerGet(`${BUCKET}/${row.image_key}`);
    if (!img.ok) { console.log(`  ${row.id}: photo not read, left out`); continue; }
    const fid = mapExampleId(row, frame);
    writeFileSync(join(dir, `${fid}.png`), readFileSync(TMP));
    const png = new PNG({ width: w, height: h });
    for (let k = 0; k < w * h; k++) {
      png.data[k * 4] = 0; png.data[k * 4 + 1] = mask[k] ? 255 : 0; png.data[k * 4 + 2] = 0; png.data[k * 4 + 3] = 255;
    }
    writeFileSync(join(dir, `${fid}-labels.png`), PNG.sync.write(png));
    const across = metresPerPixel(frame, 1);
    const height = frame.height || frame.size;
    scale.frames[fid] = across;
    scale.downs[fid] = across * (height / frame.size);
    scale.boxes[fid] = frameBbox3857(frame);
    const dims = imageDims(readFileSync(TMP)) || { w: frame.size * 2, h: height * 2 };
    scale.storedPx[fid] = dims.w;
    scale.storedPy[fid] = dims.h;
    written++;
  }
  writeFileSync(scalePath, JSON.stringify(scale));
  console.log(`${written} of ${rows.length} approved not-lawn-only maps written as example frames `
    + '(graded inside their traces only).');
}

if (process.argv[1] && process.argv[1].endsWith('not-lawn-examples.js')) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'seeds') seeds();
  else if (cmd === 'fetch') await fetchAll(a, b || 'examples');
  else if (cmd === 'upload') upload(a || 'examples');
  else if (cmd === 'audit') audit();
  else if (cmd === 'frames') await framesMode(a || 'frames');
  else if (cmd === 'maps') await mapsMode(a || 'frames');
  else { console.error('usage: not-lawn-examples.js seeds | fetch candidates.json DIR | upload DIR | frames DIR | maps DIR'); process.exit(2); }
}
