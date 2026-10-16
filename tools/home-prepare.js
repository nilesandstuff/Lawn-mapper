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

/** The text between two markers, or null. */
const between = (text, start, end) => {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  return a < 0 || b < 0 ? null : text.slice(a + start.length, b);
};

/**
 * THE HOME PAGE IS LAWN MAPPER'S LANDING (owner, 2026-10-16). From the app's
 * page (as ci-prepare left it: site origin and county list filled in) this
 * takes the search tags and the landing, from its stylesheet the landing's
 * rules, and puts them into the home template:
 *
 *   - the tags point at the home page: the app's origin becomes the home's,
 *     and an unfilled __SITE__ (a test, or no CUSTOM_DOMAIN) the same;
 *   - the landing's own links go to the app, which is where they lead;
 *   - the button that opens the app's county search is dropped: that dialog
 *     lives in the app, and the list itself is right there in the table.
 *
 * Throws when a marker is missing, so a page that lost its landing fails the
 * deploy's home step rather than shipping a home page with no pitch on it.
 */
export function buildHome(template, appHtml, appCss, home, lawnmap) {
  const seo = between(appHtml, '<!-- SEO:START (tools/home-prepare.js copies this block to the home page) -->', '<!-- SEO:END -->');
  const landing = between(appHtml, '<!-- LANDING:START (tools/home-prepare.js builds the home page from this) -->', '<!-- LANDING:END -->');
  const css = between(appCss, '/* LANDING-CSS:START (tools/home-prepare.js copies these rules to the home page) */', '/* LANDING-CSS:END */');
  if (seo === null || landing === null || css === null) {
    throw new Error('public/index.html or styles.css lost a SEO, LANDING or LANDING-CSS marker');
  }
  const homeOrigin = `https://${home}`;
  const appOrigin = `https://${lawnmap}`;
  const head = seo.split(appOrigin).join(homeOrigin).split('__SITE__').join(homeOrigin);
  const body = landing
    .replace(/\s*<p><button class="link" data-coverage-open[^]*?<\/button><\/p>/, '')
    .replace(/href="\//g, `href="${appOrigin}/`);
  return fillHome(template, home, lawnmap)
    .replace('<!-- SEO -->', head.trim())
    .replace('/* LANDING_CSS */', css.trim())
    .replace('<!-- LANDING -->', body.trim());
}

export function wranglerFor(home, lawnmap = `lawnmap.${home}`) {
  return `# Written by tools/home-prepare.js at deploy time. Not checked in.
name = "nilesandstuff-home"
main = "src/index.js"
compatibility_date = "2025-09-01"

[assets]
directory = "./build"
binding = "ASSETS"
# Through the Worker first, so www can be sent to the bare domain.
run_worker_first = true

# THE DASHBOARD'S ACCOUNT (owner, 2026-10-16): /api/maps*, /api/tools and
# /api/auth/* are handed to Lawn Mapper's Worker over this binding, so the
# dashboard's calls are same-origin and the shared sign-in cookie travels.
[[services]]
binding = "LAWNMAP"
service = "lawn-mapper"

[vars]
LAWNMAP_HOST = "${lawnmap}"

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
  const app = readFileSync(join(root, 'public/index.html'), 'utf8');
  const css = readFileSync(join(root, 'public/styles.css'), 'utf8');
  writeFileSync(join(build, 'index.html'), buildHome(page, app, css, home, lawnmap));
  for (const f of ['dashboard.html', 'dashboard.js']) {
    writeFileSync(join(build, f), fillHome(readFileSync(join(root, 'home/public', f), 'utf8'), home, lawnmap));
  }
  for (const f of ['favicon.svg', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png', 'og-image.png']) {
    copyFileSync(join(root, 'public', f), join(build, f));
  }
  writeFileSync(join(build, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: https://${home}/sitemap.xml\n`);
  writeFileSync(join(build, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + `  <url><loc>https://${home}/</loc></url>\n</urlset>\n`);
  writeFileSync(join(root, 'home/wrangler.toml'), wranglerFor(home, lawnmap));
  env(`HOME_DOMAIN_RESOLVED=${home}`);
  console.log(`Home page built for https://${home} (and www.${home}), linking to https://${lawnmap}.`);
}

if (process.argv[1] && process.argv[1].endsWith('home-prepare.js')) main();
