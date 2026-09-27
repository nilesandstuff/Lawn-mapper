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

function upload(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.png'));
  for (const f of files) {
    execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${EXAMPLE_PREFIX}${f}`,
      '--file', join(dir, f), '--content-type', f.endsWith('.png') ? 'image/png' : 'application/json', '--remote'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  console.log(`${files.length} files written to ${BUCKET}/${EXAMPLE_PREFIX}.`);
}

if (process.argv[1] && process.argv[1].endsWith('not-lawn-examples.js')) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'seeds') seeds();
  else if (cmd === 'fetch') await fetchAll(a, b || 'examples');
  else if (cmd === 'upload') upload(a || 'examples');
  else { console.error('usage: not-lawn-examples.js seeds | fetch candidates.json DIR | upload DIR'); process.exit(2); }
}
