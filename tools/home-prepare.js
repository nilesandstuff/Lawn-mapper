/**
 * Build nilesandstuff.com -- the home page -- for the deploy (owner, 2026-09-30).
 *
 * The domain is not written into the repository any more than Lawn Mapper's
 * is: it is the parent of CUSTOM_DOMAIN (lawnmap.nilesandstuff.com ->
 * nilesandstuff.com), or HOME_DOMAIN if that variable is set. From it this
 * writes home/build (the page with its links filled in, the icons, robots.txt
 * and a sitemap) and home/wrangler.toml, which puts the Worker on the bare
 * domain and on www (which the Worker sends to the bare domain).
 *
 *   CUSTOM_DOMAIN [HOME_DOMAIN]   node tools/home-prepare.js
 */

import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** lawnmap.nilesandstuff.com -> nilesandstuff.com; a two-label name has no parent. */
export function homeDomainFor(custom, explicit = '') {
  const pick = String(explicit || '').trim().toLowerCase();
  if (pick) return pick;
  const parts = String(custom || '').trim().toLowerCase().split('.').filter(Boolean);
  return parts.length >= 3 ? parts.slice(1).join('.') : null;
}

export const fillHome = (html, home, lawnmap) =>
  html.split('__HOME__').join(`https://${home}`).split('__LAWNMAP__').join(`https://${lawnmap}`);

export function wranglerFor(home) {
  return `# Written by tools/home-prepare.js at deploy time. Not checked in.
name = "nilesandstuff-home"
main = "src/index.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./build"
binding = "ASSETS"
# Through the Worker first, so www can be sent to the bare domain.
run_worker_first = true

[[routes]]
pattern = "${home}"
custom_domain = true

[[routes]]
pattern = "www.${home}"
custom_domain = true
`;
}

function main() {
  const lawnmap = (process.env.CUSTOM_DOMAIN || '').trim();
  const home = homeDomainFor(lawnmap, process.env.HOME_DOMAIN);
  const env = (line) => process.env.GITHUB_ENV && appendFileSync(process.env.GITHUB_ENV, `${line}\n`);
  if (!lawnmap || !home) {
    console.log('No home page: CUSTOM_DOMAIN is not a subdomain and HOME_DOMAIN is not set.');
    env('HOME_STATE=off -- no domain to put it on');
    process.exit(0);
  }
  const build = join(root, 'home/build');
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  const page = readFileSync(join(root, 'home/public/index.html'), 'utf8');
  writeFileSync(join(build, 'index.html'), fillHome(page, home, lawnmap));
  for (const f of ['favicon.svg', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png']) {
    copyFileSync(join(root, 'public', f), join(build, f));
  }
  writeFileSync(join(build, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: https://${home}/sitemap.xml\n`);
  writeFileSync(join(build, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + `  <url><loc>https://${home}/</loc></url>\n</urlset>\n`);
  writeFileSync(join(root, 'home/wrangler.toml'), wranglerFor(home));
  env(`HOME_DOMAIN_RESOLVED=${home}`);
  console.log(`Home page built for https://${home} (and www.${home}), linking to https://${lawnmap}.`);
}

if (process.argv[1] && process.argv[1].endsWith('home-prepare.js')) main();
