/**
 * Build water.<home domain> for the deploy (water session).
 *
 * The domain is never written into the repository: it is derived from
 * CUSTOM_DOMAIN (lawnmap.nilesandstuff.com) the way tools/home-prepare.js
 * derives the home page's -- its parent, with "water." in front. Writes
 * water/build (the page, and lib/ beside it for the browser's imports) and
 * water/wrangler.toml.
 *
 *   CUSTOM_DOMAIN=lawnmap.example.com node water/tools/prepare.mjs
 */

import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const water = join(dirname(fileURLToPath(import.meta.url)), '..');

/** lawnmap.nilesandstuff.com -> water.nilesandstuff.com; null without a parent domain. */
export function waterDomainFor(custom) {
  const parts = String(custom || '').trim().toLowerCase().split('.').filter(Boolean);
  return parts.length >= 3 ? `water.${parts.slice(1).join('.')}` : null;
}

export function wranglerFor(domain, lawnmap, adminOnly = false, d1Id = null) {
  return `# Written by water/tools/prepare.mjs at deploy time. Not checked in.
name = "lawn-water"
main = "src/index.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./build"
binding = "ASSETS"
# Through the Worker first, or the page and its files are served before the
# admin-only gate runs (found 2026-10-16: the page answered 200 signed out).
run_worker_first = true

# THE SAVED MAPS (docs/MAPS.md): /api/maps*, /api/tools and /api/auth/*, and
# the property lookups, go to Lawn Mapper's Worker over this binding, so the
# page's calls are same-origin and the shared sign-in cookie travels.
[[services]]
binding = "LAWNMAP"
service = "lawn-mapper"

[vars]
LAWNMAP_HOST = "${lawnmap}"
# Open to everyone (owner, 2026-10-23: "Make the water map accessible to everyone now"); admin only
# from 2026-10-16 until then. "1" closes it to all but the admin again.
ADMIN_ONLY = "${adminOnly ? '1' : '0'}"

[[routes]]
pattern = "${domain}"
custom_domain = true
${d1Id ? `
# The water tool's own database (water/schema.sql): gauge readings, ground truth for the pressure model.
[[d1_databases]]
binding = "DB"
database_name = "lawn-water"
database_id = "${d1Id}"
` : ''}`;
}

function main() {
  const lawnmap = (process.env.CUSTOM_DOMAIN || '').trim().toLowerCase();
  const domain = waterDomainFor(lawnmap);
  const env = (line) => process.env.GITHUB_ENV && appendFileSync(process.env.GITHUB_ENV, `${line}\n`);
  if (!domain) {
    console.log('No water site: CUSTOM_DOMAIN is not a subdomain.');
    process.exit(1);
  }
  const build = join(water, 'build');
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  cpSync(join(water, 'public'), build, { recursive: true });
  const home = lawnmap.split('.').slice(1).join('.');
  for (const f of ['index.html', 'admin.html']) {
    const page = join(build, f);
    writeFileSync(page, readFileSync(page, 'utf8').split('__LAWNMAP__').join(`https://${lawnmap}`).split('__HOME__').join(`https://${home}`));
  }
  cpSync(join(water, 'lib'), join(build, 'lib'), { recursive: true, filter: (src) => !src.endsWith('node-io.js') });
  for (const f of ['favicon.svg', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png']) {
    cpSync(join(water, '..', 'public', f), join(build, f));
  }
  writeFileSync(join(build, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  writeFileSync(join(water, 'wrangler.toml'), wranglerFor(domain, lawnmap, false, (process.env.WATER_D1_ID || '').trim() || null));
  env(`WATER_DOMAIN=${domain}`);
  console.log(`Water site built for https://${domain}, asking https://${lawnmap} for addresses, property lines and photos.`);
}

if (process.argv[1] && process.argv[1].endsWith('prepare.mjs')) main();
