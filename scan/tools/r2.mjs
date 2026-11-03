/**
 * The yard AR tool's R2 bucket for the walks' twins (core session; scan/src/twin.js): find "lawn-scan-twins", or make
 * it. Run by .github/workflows/scan-deploy.yml before the deploy; prints SCAN_R2 to GITHUB_ENV. Like scan/tools/d1.mjs,
 * NO BUCKET IS A REAL ANSWER: the site still deploys, and the page says the twin was not kept. Prints names only.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const BUCKET = 'lawn-scan-twins';

/** Is the bucket named in `wrangler r2 bucket list`'s output (any shape: "name: x" lines or JSON)? */
export function listed(stdout, name = BUCKET) {
  return new RegExp(`(^|[\\s"':])${name}($|[\\s"',])`, 'm').test(String(stdout));
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  const env = (line) => process.env.GITHUB_ENV && appendFileSync(process.env.GITHUB_ENV, `${line}\n`);
  try {
    if (!listed(wrangler(['r2', 'bucket', 'list']))) {
      console.log(`Making the "${BUCKET}" R2 bucket…`);
      try { wrangler(['r2', 'bucket', 'create', BUCKET]); } catch (err) { if (!/already exists|already own/i.test(String(err.stderr || err.message))) throw err; }
    }
  } catch (err) {
    console.log(`No twin bucket (${String(err.stderr || err.message).split('\n').find((l) => l.trim()) || 'unknown'}): the site deploys without saved twins.`);
    return;
  }
  console.log(`Twin bucket "${BUCKET}" ready.`);
  env(`SCAN_R2=${BUCKET}`);
}

if (process.argv[1] && process.argv[1].endsWith('r2.mjs')) main();
