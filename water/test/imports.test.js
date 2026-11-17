/**
 * Every relative import in the water library resolves to a file the site ships (water/lib, links followed). A shade
 * module copied in may import a new neighbour (2026-11-16: light-worker.js began importing ../lib/lidar-model.js, the
 * water site shipped without it, and its shade failed live until the link was added).
 *   node water/test/imports.test.js
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const lib = resolve(dirname(fileURLToPath(import.meta.url)), '../lib');
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== 'vendor') walk(p); } else if (/\.m?js$/.test(f)) files.push(p); } })(lib);
let n = 0;
const missing = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    n++;
    if (!existsSync(resolve(dirname(f), m[1]))) missing.push(`${f.slice(lib.length + 1)} -> ${m[1]}`);
  }
}
assert.deepEqual(missing, [], `imports that do not resolve:\n${missing.join('\n')}`);
console.log(`ok  ${n} relative imports in ${files.length} library files all resolve`);
/* ...and every page's own imports from the site's root ('/lib/...' the library, '/frame.js' a page module beside it):
   the explorer (2026-11-17) shares public/frame.js with the water map */
const pub = resolve(lib, '../public');
const pageMissing = [];
let np = 0;
for (const f of readdirSync(pub).filter((x) => /\.m?js$/.test(x))) {
  const src = readFileSync(join(pub, f), 'utf8');
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\/[^'"]+)['"]/g)) {
    np++;
    const p = m[1].startsWith('/lib/') ? join(lib, m[1].slice(5)) : join(pub, m[1].slice(1));
    if (!existsSync(p)) pageMissing.push(`${f} -> ${m[1]}`);
  }
}
assert.deepEqual(pageMissing, [], `page imports that do not resolve:\n${pageMissing.join('\n')}`);
console.log(`ok  ${np} imports in the pages all resolve`);
console.log('\n2 passed');
