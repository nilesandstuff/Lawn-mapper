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

import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const route = join(dirname(fileURLToPath(import.meta.url)), '..');

/** lawnmap.nilesandstuff.com -> route.nilesandstuff.com; null without a parent domain. */
export function routeDomainFor(custom) {
  const parts = String(custom || '').trim().toLowerCase().split('.').filter(Boolean);
  return parts.length >= 3 ? `route.${parts.slice(1).join('.')}` : null;
}

/**
 * The SHA-256 of the route session's key, which sets the shop's address and reads the kept document
 * (src/store.js). The key itself is not in the repository.
 */
export const KEY_SHA256 = '4e3957cfaa2018eb570b9cc61fb690b2cf0c24981a6f26e25630b39ca52bde72';

export function wranglerFor(domain, kvId = null, d1Id = null) {
  return `# Written by route/tools/prepare.mjs at deploy time. Not checked in.
name = "route-planner"
main = "src/index.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./build"
binding = "ASSETS"

[vars]
ROUTE_KEY_SHA256 = "${KEY_SHA256}"

[[routes]]
pattern = "${domain}"
custom_domain = true
${kvId ? `
# The shop's address and the first document (src/store.js); found or made by tools/kv.mjs.
[[kv_namespaces]]
binding = "ROUTE"
id = "${kvId}"
` : ''}${d1Id ? `
# The Mapbox meter (src/usage.js); found or made by tools/kv.mjs. Without it nothing is sent to Mapbox.
[[d1_databases]]
binding = "USAGE"
database_name = "route-planner"
database_id = "${d1Id}"
` : ''}`;
}

/** The page's link home: "https://nilesandstuff.com" and "nilesandstuff.com", from the route domain. */
export function fillHome(html, domain) {
  const home = domain ? domain.split('.').slice(1).join('.') : '';
  return html.split('__HOME_URL__').join(home ? `https://${home}/` : '/').split('__HOME_NAME__').join(home || 'home');
}

export function build(out = join(route, 'build'), domain = null) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(route, 'public'), out, { recursive: true });
  writeFileSync(join(out, 'index.html'), fillHome(readFileSync(join(out, 'index.html'), 'utf8'), domain));
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
  build(join(route, 'build'), domain);
  writeFileSync(join(route, 'wrangler.toml'), wranglerFor(domain, (process.env.ROUTE_KV_ID || '').trim() || null, (process.env.ROUTE_D1_ID || '').trim() || null));
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `ROUTE_DOMAIN=${domain}\n`);
  console.log(`Route planner built for https://${domain}`);
}

if (process.argv[1] && process.argv[1].endsWith('prepare.mjs')) main();
