/**
 * Build route.<home domain> for the deploy (route session, 2026-10-22).
 *
 * The domain is never written into the repository: it comes from
 * CUSTOM_DOMAIN (lawnmap.nilesandstuff.com) the way the water site's does --
 * its parent, with "route." in front. Writes route/build (the page, with
 * lib/ beside it for the browser's imports) and route/wrangler.toml.
 *
 *   CUSTOM_DOMAIN=lawnmap.example.com node route/tools/prepare.mjs
 */

import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const route = join(dirname(fileURLToPath(import.meta.url)), '..');

/** lawnmap.nilesandstuff.com -> route.nilesandstuff.com; null without a parent domain. */
export function routeDomainFor(custom) {
  const parts = String(custom || '').trim().toLowerCase().split('.').filter(Boolean);
  return parts.length >= 3 ? `route.${parts.slice(1).join('.')}` : null;
}

export function wranglerFor(domain) {
  return `# Written by route/tools/prepare.mjs at deploy time. Not checked in.
name = "route-planner"
main = "src/index.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./build"
binding = "ASSETS"

[[routes]]
pattern = "${domain}"
custom_domain = true
`;
}

export function build(out = join(route, 'build')) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(route, 'public'), out, { recursive: true });
  cpSync(join(route, 'lib'), join(out, 'lib'), { recursive: true });
  for (const f of ['favicon.svg', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png']) {
    cpSync(join(route, '..', 'public', f), join(out, f));
  }
  writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  return out;
}

function main() {
  const domain = routeDomainFor(process.env.CUSTOM_DOMAIN);
  if (!domain) {
    console.log('No route site: CUSTOM_DOMAIN is not a subdomain.');
    process.exit(1);
  }
  build();
  writeFileSync(join(route, 'wrangler.toml'), wranglerFor(domain));
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `ROUTE_DOMAIN=${domain}\n`);
  console.log(`Route planner built for https://${domain}`);
}

if (process.argv[1] && process.argv[1].endsWith('prepare.mjs')) main();
