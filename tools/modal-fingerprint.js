/**
 * WHAT THE LIVE MODEL SERVER IS MADE OF, AS ONE FINGERPRINT (owner,
 * 2026-10-08: "I definitely don't want to be sending a warm press after
 * update to the cloudflare site").
 *
 * Every deploy used to run `modal deploy`, and every one of those is a new
 * version of the Modal app whose first press sits queued for over a minute.
 * The images copy in all of tools/, worker/src and public/lib, so even a
 * robots.txt edit counted as a new server. This hashes only what the server
 * actually runs -- its Python (modal_serve.py and the rest of tools/*.py) and
 * tools/serve-alpha.mjs with every file it imports -- and workflow 2 skips
 * `modal deploy`, and the warm press, when the hash matches the last one it
 * deployed (kept on the Modal volume).
 *
 *   node tools/modal-fingerprint.js          -> prints the fingerprint
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Relative imports of one JS file, static and dynamic, resolved to paths. */
export function importsOf(file, text = readFileSync(file, 'utf8')) {
  const out = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const m of text.matchAll(re)) out.push(resolve(dirname(file), m[1]));
  return out;
}

/*
 * WHERE THE TRACE STOPS. serve-alpha.mjs borrows the scorer's helpers from
 * train-detector.js, which also imports the database helper -- and through it
 * the deploy script and the whole county registry, which the nightly county
 * search rewrites. The server never reads the database (Modal holds no
 * Cloudflare credentials), so nothing past corpus-db.js can change what it
 * does, and following it would redeploy the model every night.
 */
const NOT_SERVED = new Set([join(ROOT, 'tools', 'corpus-db.js')]);

/** serve-alpha.mjs and everything it reaches by relative import. */
export function jsClosure(entry = join(ROOT, 'tools', 'serve-alpha.mjs')) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || NOT_SERVED.has(f)) continue;
    seen.add(f);
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    stack.push(...importsOf(f, text));
  }
  return [...seen];
}

/** Every file the fingerprint covers, repository-relative and sorted. */
export function serverFiles() {
  const py = readdirSync(join(ROOT, 'tools'))
    .filter((n) => n.endsWith('.py') && !n.endsWith('_test.py'))
    .map((n) => join(ROOT, 'tools', n));
  return [...new Set([...py, ...jsClosure()])].map((f) => relative(ROOT, f)).sort();
}

export function fingerprint(files = serverFiles()) {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f}\n`);
    try { h.update(readFileSync(join(ROOT, f))); } catch { h.update('(missing)'); }
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(fingerprint());
}
