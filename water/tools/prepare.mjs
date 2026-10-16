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

export function wranglerFor(domain, lawnmap, adminOnly = true) {
  return `# Written by water/tools/prepare.mjs at deploy time. Not checked in.
name = "lawn-water"
main = "src/index.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./build"
binding = "ASSETS"

# THE SAVED MAPS (docs/MAPS.md): /api/maps*, /api/tools and /api/auth/*, and
# the property lookups, go to Lawn Mapper's Worker over this binding, so the
# page's calls are same-origin and the shared sign-in cookie travels.
[[services]]
binding = "LAWNMAP"
service = "lawn-mapper"

[vars]
LAWNMAP_HOST = "${lawnmap}"
# Admin only until it ships (owner, 2026-10-16). "0" opens it to everyone.
ADMIN_ONLY = "${adminOnly ? '1' : '0'}"

[[routes]]
pattern = "${domain}"
custom_domain = true
`;
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
  const page = join(build, 'index.html');
  const home = lawnmap.split('.').slice(1).join('.');
  writeFileSync(page, readFileSync(page, 'utf8').split('__LAWNMAP__').join(`https://${lawnmap}`).split('__HOME__').join(`https://${home}`));
  cpSync(join(water, 'lib'), join(build, 'lib'), { recursive: true, filter: (src) => !src.endsWith('node-io.js') });
  for (const f of ['favicon.svg', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png']) {
    cpSync(join(water, '..', 'public', f), join(build, f));
  }
  writeFileSync(join(build, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  writeFileSync(join(water, 'wrangler.toml'), wranglerFor(domain, lawnmap));
  env(`WATER_DOMAIN=${domain}`);
  console.log(`Water site built for https://${domain}, asking https://${lawnmap} for addresses, property lines and photos.`);
}

if (process.argv[1] && process.argv[1].endsWith('prepare.mjs')) main();
