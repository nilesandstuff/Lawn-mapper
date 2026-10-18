/**
 * Build shade.<home domain> -- the shade map's own address -- for the deploy
 * (owner, 2026-10-18). The domain is not written into the repository: it is
 * shade. under the home domain, the parent of CUSTOM_DOMAIN
 * (lawnmap.nilesandstuff.com -> shade.nilesandstuff.com), as
 * tools/home-prepare.js finds the home page's.
 *
 * Writes shade-site/build (Lawn Mapper's public/ as ci-prepare left it, so
 * every module the shade pages import is there, with the shade page's search
 * tags pointed at the new address) and shade-site/wrangler.toml, which puts
 * shade-site/src/index.js on the subdomain with a service binding to Lawn
 * Mapper's Worker for /api/. Prints SHADE_HOST for the deploy to pass on.
 *
 *   CUSTOM_DOMAIN [HOME_DOMAIN]   node tools/shade-prepare.js
 */

import { appendFileSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDomainFor } from './home-prepare.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The shade page's canonical and share address moved from Lawn Mapper's /shade to the subdomain's root. */
export function pointAtShade(html, lawnmap, shade) {
  return html
    .split(`https://${lawnmap}/shade"`).join(`https://${shade}/"`)
    .split('__SITE__/shade"').join(`https://${shade}/"`);
}

export function wranglerFor(shade, lawnmap) {
  return `# Written by tools/shade-prepare.js at deploy time. Not checked in.
name = "lawn-mapper-shade"
main = "src/index.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./build"
binding = "ASSETS"
# Through the Worker first: the shade map is at /, and the old names redirect.
run_worker_first = true

# /api/ goes to Lawn Mapper's Worker over this binding (same-origin here, the
# shared sign-in cookie travels), as the home page's dashboard does.
[[services]]
binding = "LAWNMAP"
service = "lawn-mapper"

[vars]
LAWNMAP_HOST = "${lawnmap}"

[[routes]]
pattern = "${shade}"
custom_domain = true
`;
}

function main() {
  const lawnmap = (process.env.CUSTOM_DOMAIN || '').trim();
  const home = homeDomainFor(lawnmap, process.env.HOME_DOMAIN);
  const env = (line) => process.env.GITHUB_ENV && appendFileSync(process.env.GITHUB_ENV, `${line}\n`);
  if (!lawnmap || !home) {
    console.log('No shade subdomain: CUSTOM_DOMAIN is not a subdomain and HOME_DOMAIN is not set.');
    process.exit(0);
  }
  const shade = `shade.${home}`;
  const site = join(root, 'shade-site');
  const build = join(site, 'build');
  rmSync(build, { recursive: true, force: true });
  cpSync(join(root, 'public'), build, { recursive: true });
  const page = join(build, 'shade.html');
  writeFileSync(page, pointAtShade(readFileSync(page, 'utf8'), lawnmap, shade));
  writeFileSync(join(site, 'wrangler.toml'), wranglerFor(shade, lawnmap));
  env(`SHADE_HOST_RESOLVED=${shade}`);
  console.log(`Shade map: built for https://${shade} (/api/ to ${lawnmap}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
