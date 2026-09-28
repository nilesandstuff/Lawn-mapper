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
import { captureFrame, imageryUrl } from '../worker/src/imagery.js';
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

function wranglerGet(key) {
  try {
    execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'get', key, '--pipe', '--remote'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, err: '' };
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

if (process.argv[1] && process.argv[1].endsWith('not-lawn-examples.js')) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'seeds') seeds();
  else if (cmd === 'fetch') await fetchAll(a, b || 'examples');
  else if (cmd === 'upload') upload(a || 'examples');
  else { console.error('usage: not-lawn-examples.js seeds | fetch candidates.json DIR | upload DIR'); process.exit(2); }
}
