/**
 * The yard AR tool's R2 bucket for the walks' twins (core session; scan/src/twin.js): find "lawn-scan-twins", or make
 * it. Run by .github/workflows/scan-deploy.yml before the deploy; prints SCAN_R2 to GITHUB_ENV. A bucket that cannot be
 * asked for STOPS THE DEPLOY (since 2026-11-22; before, the site went out without it). Prints names only.
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
/* ASKED AGAIN, SLOWLY (2026-11-22: a deploy went out while another run was reading a walk from the bucket; Cloudflare
   refused the list, this said "no twin bucket", and the site was deployed WITHOUT its bucket: the twins page read
   "no-bucket" and the studies were gone, and a walk made then would not have been kept). A refusal is not "there is
   no bucket". Five tries, then the deploy STOPS: the site already out keeps its bucket. */
export function patiently(fn, { tries = 5, waitS = 8, sleep = (s) => execFileSync('sleep', [String(s)]) } = {}) {
  let last;
  for (let t = 0; t < tries; t++) {
    try { return fn(); } catch (err) { last = err; if (t < tries - 1) sleep(waitS * 2 ** t); }
  }
  throw last;
}

function main() {
  const env = (line) => process.env.GITHUB_ENV && appendFileSync(process.env.GITHUB_ENV, `${line}\n`);
  try {
    if (!listed(patiently(() => wrangler(['r2', 'bucket', 'list'])))) {
      console.log(`Making the "${BUCKET}" R2 bucket…`);
      try { patiently(() => wrangler(['r2', 'bucket', 'create', BUCKET]), { tries: 3 }); } catch (err) { if (!/already exists|already own/i.test(String(err.stderr || err.message))) throw err; }
    }
  } catch (err) {
    console.log(`The twin bucket could not be asked for (${String(err.stderr || err.message).split('\n').find((l) => l.trim()) || 'unknown'}), five times over. NOT DEPLOYING: a site deployed without its bucket keeps no walk and shows none. The site already out is unchanged. (Was another run reading a walk? One at a time.)`);
    process.exit(1);
  }
  console.log(`Twin bucket "${BUCKET}" ready.`);
  env(`SCAN_R2=${BUCKET}`);
}

if (process.argv[1] && /(^|[\\/])r2\.mjs$/.test(process.argv[1])) main();   // not twin-r2.mjs or app-r2.mjs, which end the same
