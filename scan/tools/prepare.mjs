/**
 * Build scan.<home domain> -- the yard AR tool -- for the deploy (core session,
 * docs/SCAN-PLAN.md).
 *
 * The domain is never written into the repository: it is derived from
 * CUSTOM_DOMAIN (lawnmap.nilesandstuff.com) the way tools/home-prepare.js
 * derives the home page's -- its parent, with "scan." in front. Writes
 * scan/build (the page, lib/ beside it for the browser's imports, and the
 * 8th Wall engine binary under vendor/xr/ when npm has put it in
 * node_modules at deploy time) and scan/wrangler.toml.
 *
 *   CUSTOM_DOMAIN=lawnmap.example.com node scan/tools/prepare.mjs
 *
 * THE ENGINE BINARY is not checked in (30 MB of binary chunks under a
 * limited-use license that wants it distributed as it is): the deploy
 * workflow installs @8thwall/engine-binary at the pinned version and this
 * copies its dist/ unchanged, notice and LICENSE included.
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scan = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(scan, '..');
export const ENGINE_VERSION = '1.0.0';

/** lawnmap.nilesandstuff.com -> scan.nilesandstuff.com; null without a parent domain. */
export function scanDomainFor(custom) {
  const parts = String(custom || '').trim().toLowerCase().split('.').filter(Boolean);
  return parts.length >= 3 ? `scan.${parts.slice(1).join('.')}` : null;
}

export function wranglerFor(domain, lawnmap, adminOnly = true, d1Id = null) {
  return `# Written by scan/tools/prepare.mjs at deploy time. Not checked in.
name = "lawn-scan"
main = "src/index.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./build"
binding = "ASSETS"
# Through the Worker first, or the page is served before the admin-only gate runs.
run_worker_first = true

# THE SAVED MAPS (docs/MAPS.md): /api/maps*, /api/tools and /api/auth/* go to
# Lawn Mapper's Worker over this binding, so the page's calls are same-origin
# and the shared sign-in cookie travels.
[[services]]
binding = "LAWNMAP"
service = "lawn-mapper"

[vars]
LAWNMAP_HOST = "${lawnmap}"
# Admin only while the tracking test runs (docs/SCAN-PLAN.md phase 1).
ADMIN_ONLY = "${adminOnly ? '1' : '0'}"

[[routes]]
pattern = "${domain}"
custom_domain = true
${d1Id ? `
# The tool's own database (scan/schema.sql): the walks' results, so nobody copies and pastes them.
[[d1_databases]]
binding = "DB"
database_name = "lawn-scan"
database_id = "${d1Id}"
` : ''}`;
}

/** The engine's dist/ in node_modules, or null. */
export function engineDist(from = root) {
  const d = join(from, 'node_modules', '@8thwall', 'engine-binary', 'dist');
  return existsSync(join(d, 'xr.js')) ? d : null;
}

function main() {
  const lawnmap = (process.env.CUSTOM_DOMAIN || '').trim().toLowerCase();
  const domain = scanDomainFor(lawnmap);
  const env = (line) => process.env.GITHUB_ENV && appendFileSync(process.env.GITHUB_ENV, `${line}\n`);
  if (!domain) {
    console.log('No scan site: CUSTOM_DOMAIN is not a subdomain.');
    process.exit(1);
  }
  const build = join(scan, 'build');
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  cpSync(join(scan, 'public'), build, { recursive: true });
  const home = lawnmap.split('.').slice(1).join('.');
  const page = join(build, 'index.html');
  writeFileSync(page, readFileSync(page, 'utf8').split('__LAWNMAP__').join(`https://${lawnmap}`).split('__HOME__').join(`https://${home}`));
  cpSync(join(scan, 'lib'), join(build, 'lib'), { recursive: true });
  for (const f of ['favicon.svg', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png']) {
    if (existsSync(join(root, 'public', f))) cpSync(join(root, 'public', f), join(build, f));
  }
  const dist = engineDist();
  let engine = 'NOT on this site (npm did not install @8thwall/engine-binary): the page offers WebXR only';
  if (dist) {
    cpSync(dist, join(build, 'vendor', 'xr'), { recursive: true });
    writeFileSync(join(build, 'vendor', 'xr', 'VERSION'), `${ENGINE_VERSION}\n`);
    engine = `8th Wall engine binary ${ENGINE_VERSION} at /vendor/xr/`;
  }
  writeFileSync(join(build, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  writeFileSync(join(scan, 'wrangler.toml'), wranglerFor(domain, lawnmap, true, (process.env.SCAN_D1_ID || '').trim() || null));
  env(`SCAN_DOMAIN=${domain}`);
  env(`SCAN_ENGINE=${engine}`);
  console.log(`Scan site built for https://${domain} (accounts via https://${lawnmap}); ${engine}.`);
}

if (process.argv[1] && process.argv[1].endsWith('prepare.mjs')) main();
