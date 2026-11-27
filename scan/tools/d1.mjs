/**
 * The yard AR tool's D1 database (core session): find "lawn-scan", or make it, and apply scan/schema.sql and
 * scan/migrations.sql. Run by .github/workflows/scan-deploy.yml before the deploy; prints the id (SCAN_D1_ID)
 * to GITHUB_ENV. Carried from water/tools/d1.mjs (water session). NO DATABASE IS A REAL ANSWER: if the token
 * cannot make one, the site still deploys, and walks stay on the phone (the Worker answers 503 for them).
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patiently } from './r2.mjs';

export const DB_NAME = 'lawn-scan';
const scan = join(dirname(fileURLToPath(import.meta.url)), '..');

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
    id = parseList(patiently(() => wrangler(['d1', 'list', '--json']))).find((d) => d.name === DB_NAME)?.uuid || null;
    if (!id) { console.log(`Making the "${DB_NAME}" D1 database…`); id = parseCreated(wrangler(['d1', 'create', DB_NAME])); }
  } catch (err) {
    // (2026-11-22, with r2.mjs) a refusal is not "there is no database": the deploy stops, the site out is unchanged
    console.log(`The scan database could not be asked for (${String(err.stderr || err.message).split('\n')[0]}), five times over. NOT DEPLOYING: a site deployed without its database keeps no walk. The site already out is unchanged.`);
    process.exit(1);
  }
  if (!id) { console.log('No scan database id came back. NOT DEPLOYING: a site deployed without its database keeps no walk.'); process.exit(1); }
  try {
    wrangler(['d1', 'execute', DB_NAME, '--remote', `--file=${join(scan, 'schema.sql')}`, '--yes']);
    for (const stmt of readFileSync(join(scan, 'migrations.sql'), 'utf8').split(';').map((x) => x.replace(/--.*$/gm, '').trim()).filter(Boolean)) {
      try { wrangler(['d1', 'execute', DB_NAME, '--remote', `--command=${stmt}`, '--yes']); } catch { /* already applied */ }
    }
    console.log(`Scan database "${DB_NAME}" ready; schema applied.`);
  } catch (err) {
    console.log(`The scan schema did not apply (${String(err.stderr || err.message).split('\n')[0]}).`);
  }
  console.log(`::add-mask::${id}`); // the later steps print their env; the id is kept out of the public log
  env(`SCAN_D1_ID=${id}`);
}

if (process.argv[1] && process.argv[1].endsWith('d1.mjs')) main();
