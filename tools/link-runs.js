/**
 * Link two workflow 14 runs' pictures as twins on the predictions page
 * (owner, 2026-10-26: independent runs, "link them after the fact so I can
 * still view them like twins"). Workflow 24 calls this when it compares
 * exactly one run against one other.
 *
 *   node tools/link-runs.js <run id A> <run id B>
 *
 * Each run's picture folder is found in the run list by the GitHub run id it
 * recorded (`ghRun`, written since 2026-10-26). A run that drew no pictures,
 * or drew them before ids were recorded, is reported and nothing is linked;
 * the page's twin picker links any two runs by hand.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunList } from './run-folder.js';
import { linkTwins, TWINS_KEY } from '../worker/src/run-twins.js';

/** The folder each GitHub run id drew, from the run list's rows. */
export function slugsFor(runs, ids) {
  return ids.map((id) => (runs.find((r) => r && String(r.ghRun || '') === String(id) && !/-control$/.test(r.slug)) || {}).slug || null);
}

async function main() {
  const [a, b] = process.argv.slice(2).map((s) => String(s || '').trim());
  if (!/^\d+$/.test(a || '') || !/^\d+$/.test(b || '')) {
    console.log('Linking needs exactly one run id on each side; nothing linked.');
    return;
  }
  if (a === b) {
    console.log('Both sides are the same run (two rows of one run); nothing to link.');
    return;
  }
  const bucket = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
  const dir = mkdtempSync(join(tmpdir(), 'link-runs-'));
  const runs = readRunList(bucket, dir);
  const [sa, sb] = slugsFor(runs, [a, b]);
  if (!sa || !sb) {
    console.log(`Not linked: ${!sa ? `run ${a}` : ''}${!sa && !sb ? ' and ' : ''}${!sb ? `run ${b}` : ''} drew no pictures the list knows by run id. Pick the twin on the predictions page instead.`);
    return;
  }
  const file = join(dir, 'twins.json');
  let pairs = {};
  try {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${bucket}/${TWINS_KEY}`, '--file', file, '--remote'], { stdio: ['ignore', 'pipe', 'pipe'] });
    pairs = JSON.parse(readFileSync(file, 'utf8'))?.pairs || {};
  } catch { /* none yet */ }
  pairs = linkTwins(pairs, sa, sb);
  writeFileSync(file, `${JSON.stringify({ updatedAt: new Date().toISOString(), pairs })}\n`);
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${TWINS_KEY}`, '--file', file, '--content-type', 'application/json', '--remote'], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`LINKED ON THE PREDICTIONS PAGE: ${sa} <-> ${sb}. Each card there flips to the other run's picture of the same lot.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.log(`Not linked: ${e.message}`); });
}
