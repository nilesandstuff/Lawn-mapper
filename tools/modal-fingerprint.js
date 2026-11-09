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
 *   node tools/modal-fingerprint.js --legacy -> the same by the rule before 2026-11-09 (see legacyServerFiles)
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
/* Python in tools/ that the server never runs: changing it must not redeploy
   (and warm, at a few cents) the model server. */
const NOT_SERVED_PY = new Set(['modal-logs.py', 'upernet_head.py', 'intensity_errors.py']); // never imported by the server: the log reader; the S26 trial head; S38's measurement

/*
 * ONLY THE PYTHON THE SERVER CAN REACH (owner, 2026-11-09, after a deploy redeployed and warmed the server because a
 * new parcel-file reader, tools/parcel_file.py, had been added to tools/: "We shouldn't have done anything that
 * required a modal deploy and warm press"). It used to be every tools/*.py but a short list, so every new study
 * script was a new server. Now: modal_serve.py and every tools module it reaches -- by `import` / `from`, or named as
 * a .py file (a script it runs) -- and the same from the JavaScript the server runs. Mentions are over-counted on
 * purpose (a comment naming a file counts), which can only redeploy when nothing changed, never miss a change.
 */
export function pyClosure() {
  const dir = join(ROOT, 'tools');
  const mods = new Set(readdirSync(dir).filter((n) => n.endsWith('.py')).map((n) => n.slice(0, -3)));
  const refs = (text) => {
    const out = [];
    for (const m of text.matchAll(/^\s*(?:from\s+([A-Za-z_]\w*)|import\s+([A-Za-z_][\w, ]*))/gm)) {
      if (m[1]) out.push(m[1]); else out.push(...m[2].split(',').map((x) => x.trim().split(/\s+/)[0]));
    }
    for (const m of text.matchAll(/([A-Za-z_][\w-]*)\.py\b/g)) out.push(m[1]);
    return out.filter((x) => mods.has(x));
  };
  const stack = ['modal_serve'];
  for (const f of jsClosure()) { try { stack.push(...refs(readFileSync(f, 'utf8'))); } catch { /* gone */ } }
  const seen = new Set();
  while (stack.length) {
    const m = stack.pop();
    if (seen.has(m)) continue;
    seen.add(m);
    try { stack.push(...refs(readFileSync(join(dir, `${m}.py`), 'utf8'))); } catch { /* gone */ }
  }
  return [...seen].map((m) => join(dir, `${m}.py`));
}

const served = (n) => n.endsWith('.py') && !n.endsWith('_test.py') && !NOT_SERVED_PY.has(n);

export function serverFiles() {
  const py = pyClosure().filter((f) => served(f.split('/').pop()));
  return [...new Set([...py, ...jsClosure()])].map((f) => relative(ROOT, f)).sort();
}

/**
 * The files the fingerprint covered before 2026-11-09 (every tools/*.py but the short list). The deploy accepts a
 * kept fingerprint made this way as "unchanged" when it still matches, so the change of rule did not itself
 * redeploy the server: that set holds everything the new one does, so a match means nothing served has changed.
 */
export function legacyServerFiles() {
  const py = readdirSync(join(ROOT, 'tools')).filter(served).map((n) => join(ROOT, 'tools', n));
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
  console.log(process.argv.includes('--legacy') ? fingerprint(legacyServerFiles()) : fingerprint());
}
