/**
 * The water tool's D1 database (water session): find "lawn-water", or make it, and apply water/schema.sql
 * and water/migrations.sql. Run by .github/workflows/water-deploy.yml before the deploy; prints the id
 * (WATER_D1_ID) to GITHUB_ENV. NO DATABASE IS A REAL ANSWER: if the token cannot make one, the site still
 * deploys, without a place to keep gauge readings (the Worker answers 503 there).
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DB_NAME = 'lawn-water';
const water = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The databases out of `wrangler d1 list --json`, tolerating banners round the JSON. */
export function parseList(stdout) {
  const s = String(stdout), a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b < a) return [];
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return []; }
}
/** The id out of `wrangler d1 create`'s output, whatever shape it took. */
export function parseCreated(stdout) {
  const s = String(stdout);
  return s.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)?.[1] || s.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i)?.[1] || s.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1] || null;
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  const env = (line) => process.env.GITHUB_ENV && appendFileSync(process.env.GITHUB_ENV, `${line}\n`);
  let id = null;
  try {
    id = parseList(wrangler(['d1', 'list', '--json'])).find((d) => d.name === DB_NAME)?.uuid || null;
    if (!id) { console.log(`Making the "${DB_NAME}" D1 database…`); id = parseCreated(wrangler(['d1', 'create', DB_NAME])); }
  } catch (err) {
    console.log(`No water database (${String(err.stderr || err.message).split('\n')[0]}): the site deploys without gauge readings.`);
    return;
  }
  if (!id) { console.log('No water database id came back: the site deploys without gauge readings.'); return; }
  try {
    wrangler(['d1', 'execute', DB_NAME, '--remote', `--file=${join(water, 'schema.sql')}`, '--yes']);
    for (const stmt of readFileSync(join(water, 'migrations.sql'), 'utf8').split(';').map((x) => x.replace(/--.*$/gm, '').trim()).filter(Boolean)) {
      try { wrangler(['d1', 'execute', DB_NAME, '--remote', `--command=${stmt}`, '--yes']); } catch { /* already applied */ }
    }
    console.log(`Water database "${DB_NAME}" ready; schema applied.`);
  } catch (err) {
    console.log(`The water schema did not apply (${String(err.stderr || err.message).split('\n')[0]}).`);
  }
  env(`WATER_D1_ID=${id}`);
}

if (process.argv[1] && process.argv[1].endsWith('d1.mjs')) main();
