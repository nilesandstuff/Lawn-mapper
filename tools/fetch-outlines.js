/**
 * Workflow 25's two ends: which maps need public outlines, and putting the
 * drafts where the review page (/outlines.html) can find them.
 *
 *   node tools/fetch-outlines.js list  > jobs.json   every approved map with
 *                                                     no outline file yet
 *   node tools/fetch-outlines.js upload DIR           each DIR/*.json to R2
 *
 * The fetching in between is tools/public_negatives.py --jobs. See
 * worker/src/outlines.js for why these are drafts until the owner approves
 * them, and why an approved file is never overwritten from here.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { frameCorners } from '../public/lib/mercator.js';
import { query } from './corpus-db.js';

const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
const PREFIX = 'outlines/';

/** The photograph's frame as a lon/lat box: (west, south, east, north). */
export function bboxOfFrame(frame) {
  const c = frameCorners(frame);
  const lngs = c.map((p) => p[0]);
  const lats = c.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

/** One file per map, named so the worker's outlineKey finds it. */
export const outlineFile = (id) => `${encodeURIComponent(id)}.json`;

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

function existing(file) {
  try {
    const out = execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'get',
      `${BUCKET}/${PREFIX}${file}`, '--pipe', '--remote'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
    return parse(out.slice(out.indexOf('{')));
  } catch {
    return null;
  }
}

function list() {
  /* REFETCH=drafts fetches again over drafts nobody has approved; approved
     files are the owner's work and are never replaced from here. */
  const refetchDrafts = process.env.REFETCH === 'drafts';
  const rows = query(`SELECT id, frame, image_frame FROM corpus
                       WHERE status = 'approved' AND frame IS NOT NULL ORDER BY at DESC`);
  const jobs = [];
  let approved = 0, drafts = 0;
  for (const r of rows) {
    const frame = parse(r.image_frame) || parse(r.frame);
    if (!frame) continue;
    const file = outlineFile(r.id);
    const have = existing(file);
    if (have?.status === 'approved') { approved++; continue; }
    if (have && !refetchDrafts) { drafts++; continue; }
    jobs.push({ id: r.id, bbox: bboxOfFrame(frame), file });
  }
  console.error(`${rows.length} approved maps: ${approved} with approved outlines (kept), `
    + `${drafts} with drafts${refetchDrafts ? '' : ' (kept)'}, ${jobs.length} to fetch.`);
  process.stdout.write(`${JSON.stringify(jobs)}\n`);
}

function upload(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${PREFIX}${f}`,
      '--file', join(dir, f), '--content-type', 'application/json', '--remote'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  console.log(`${files.length} drafts written to ${BUCKET}/${PREFIX}.`);
}

if (process.argv[1] && process.argv[1].endsWith('fetch-outlines.js')) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'list') list();
  else if (cmd === 'upload') upload(arg || 'outlines');
  else { console.error('usage: fetch-outlines.js list | upload DIR'); process.exit(2); }
}
