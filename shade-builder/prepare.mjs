/**
 * Lay out shade-builder/app/ for the image: the shade map's modules
 * (public/shade/*.js and its vendor laz-perf), public/lib/*.js that they
 * import, server.mjs, and a package.json with the two image decoders. Run by
 * the deploy workflow before `wrangler deploy`; app/ is not committed.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const app = join(here, 'app');
rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, 'public', 'shade', 'vendor'), { recursive: true });
mkdirSync(join(app, 'public', 'lib'), { recursive: true });
for (const f of readdirSync(join(root, 'public', 'shade'))) if (f.endsWith('.js')) cpSync(join(root, 'public', 'shade', f), join(app, 'public', 'shade', f));
for (const f of ['laz-perf.js', 'laz-perf.wasm']) cpSync(join(root, 'public', 'shade', 'vendor', f), join(app, 'public', 'shade', 'vendor', f));
for (const f of readdirSync(join(root, 'public', 'lib'))) if (f.endsWith('.js')) cpSync(join(root, 'public', 'lib', f), join(app, 'public', 'lib', f));
cpSync(join(here, 'server.mjs'), join(app, 'server.mjs'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dev = pkg.devDependencies || {};
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'shade-builder', private: true, type: 'module', dependencies: { 'jpeg-js': dev['jpeg-js'], pngjs: dev.pngjs } }, null, 2));
console.log(`shade-builder/app laid out: ${readdirSync(join(app, 'public', 'shade')).length} shade files`);
