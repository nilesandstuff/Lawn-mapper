/**
 * LAYS OUT THE WATER BUILDER'S IMAGE (water/builder/app/, not checked in): the water library (links followed: the
 * shade map's modules come in as they are on this commit), the page's analysis worker and the station list, the
 * builder's own modules, and build.json / build.js with this commit, which the Worker compares with the running
 * container's /health before each job.
 *   node water/builder/prepare.mjs
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url)), water = join(here, '..'), app = join(here, 'app');
rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, 'public', 'data'), { recursive: true });
mkdirSync(join(app, 'builder'), { recursive: true });
cpSync(join(water, 'lib'), join(app, 'lib'), { recursive: true, dereference: true });
cpSync(join(water, 'public', 'analyse.js'), join(app, 'public', 'analyse.js'));
cpSync(join(water, 'public', 'data', 'asos-stations.json'), join(app, 'public', 'data', 'asos-stations.json'));
for (const f of ['server.mjs', 'headless.mjs', 'loader.mjs', 'boot-worker.mjs', 'io-shim.mjs']) cpSync(join(here, f), join(app, 'builder', f));
let build = 'dev';
try { build = execSync('git rev-parse --short HEAD', { cwd: water }).toString().trim(); } catch { /* not a checkout */ }
writeFileSync(join(app, 'builder', 'build.json'), JSON.stringify({ build }));
writeFileSync(join(app, 'builder', 'build.js'), `export const BUILD = ${JSON.stringify(build)};\n`);
const root = JSON.parse(readFileSync(join(water, '..', 'package.json'), 'utf8'));
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'water-builder', private: true, type: 'module', dependencies: { pngjs: root.dependencies?.pngjs || root.devDependencies?.pngjs || '^7.0.0' } }, null, 2));
console.log(`water builder laid out at build ${build}`);
