/** The home page build (tools/home-prepare.js).   node tools/home.test.js */
import { readFileSync } from 'node:fs';
import { homeDomainFor, fillHome, wranglerFor, buildHome } from './home-prepare.js';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); if (!ok) failures++; };

check('the home domain is the parent of the app\'s', homeDomainFor('lawnmap.nilesandstuff.com') === 'nilesandstuff.com');
check('HOME_DOMAIN wins when it is set', homeDomainFor('lawnmap.nilesandstuff.com', 'Example.org') === 'example.org');
check('a bare domain has no parent to put a home page on', homeDomainFor('nilesandstuff.com') === null);

const page = readFileSync(new URL('../home/public/index.html', import.meta.url), 'utf8');
const appPage = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const filled = buildHome(page, appPage, appCss, 'nilesandstuff.com', 'lawnmap.nilesandstuff.com');
check('every placeholder is filled', !/__HOME__|__LAWNMAP__|__SITE__|<!-- LANDING -->|<!-- SEO -->|LANDING_CSS/.test(filled));
/* THE LANDING LIVES HERE NOW (owner, 2026-10-16). */
check('the home page carries Lawn Mapper\'s pitch, comparison, county list and questions',
  ['lp-intro-title', 'lp-compare', 'lp-coverage-title', 'lp-faq-title'].every((id) => filled.includes(id)));
check('and its search tags, pointed here',
  filled.includes('<link rel="canonical" href="https://nilesandstuff.com/">') && filled.includes('"@type": "FAQPage"'));
check('one h1, and the button that opens the dashboard instead of an address bar',
  (filled.match(/<h1/g) || []).length === 1 && filled.includes('href="/dashboard">Start or resume a lawn map')
  && !filled.includes('id="address-form"'));
check('the landing\'s own links lead to the app; nothing points at a file this site lacks',
  filled.includes('href="https://lawnmap.nilesandstuff.com/shade"')
  && !/href="\/(styles\.css|shade|lib)/.test(filled) && !filled.includes('data-coverage-open'));
let threw = false;
try { buildHome(page, '<html></html>', appCss, 'a.b', 'x.a.b'); } catch { threw = true; }
check('a page that lost its landing fails the build rather than shipping without it', threw);
const dash = fillHome(readFileSync(new URL('../home/public/dashboard.html', import.meta.url), 'utf8'), 'nilesandstuff.com', 'lawnmap.nilesandstuff.com');
check('the dashboard is not for search, and starts a new map in the lawn mapper',
  dash.includes('content="noindex, nofollow"') && dash.includes('href="https://lawnmap.nilesandstuff.com/?new=1"'));

/* The same tools as Lawn Mapper's "More lawn tools" menu, so the two lists
   cannot drift apart. */
const app = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const menu = app.slice(app.indexOf('id="tools-menu"'), app.indexOf('</div>', app.indexOf('id="tools-menu"')));
const links = [...menu.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
check('the menu was found', links.length >= 2, links.join(', '));
const missing = links.filter((l) => !filled.includes(`href="${l}"`));
check('every "More lawn tools" link has a card on the home page', missing.length === 0, missing.join(', ') || links.join(', '));
check('and every link that opens a new tab carries rel="noopener"',
  [...filled.matchAll(/<a [^>]*target="_blank"[^>]*>/g)].every((m) => /rel="[^"]*noopener/.test(m[0])));

const w = wranglerFor('nilesandstuff.com');
check('the Worker goes on the bare domain and on www',
  w.includes('pattern = "nilesandstuff.com"') && w.includes('pattern = "www.nilesandstuff.com"')
  && w.includes('run_worker_first = true'));
check('and reaches Lawn Mapper\'s accounts over a service binding, at its own host',
  /\[\[services\]\]\nbinding = "LAWNMAP"\nservice = "lawn-mapper"/.test(w) && wranglerFor('a.b', 'x.a.b').includes('LAWNMAP_HOST = "x.a.b"'));

/* The dashboard's tool states (home/public/dashboard.js). */
const { toolState } = await import('../home/public/dashboard.js');
const T = { lawn: { id: 'lawn', needs: [] }, slices: { id: 'slices', needs: ['lawn'] }, shade: { id: 'shade', needs: [] },
  water: { id: 'water', needs: ['shade'] }, soon: { id: 'x', needs: [], soon: true } };
const fresh = { at: '2026-10-16T10:00:00Z', squareFeet: 0, tools: {} };
check('a map started elsewhere: the lawn is ready, the slices wait for it, the shade is ready, the water waits for the shade',
  toolState(fresh, T.lawn) === 'ready' && toolState(fresh, T.slices) === 'locked'
  && toolState(fresh, T.shade) === 'ready' && toolState(fresh, T.water) === 'locked');
const measured = { at: '2026-10-16T10:00:00Z', squareFeet: 5000, tools: { slices: { updatedAt: '2026-10-16T11:00:00Z' }, shade: { updatedAt: '2026-10-16T09:00:00Z' } } };
check('measured, with slices after: lawn and slices done, the water ready once the shade is',
  toolState(measured, T.lawn) === 'done' && toolState(measured, T.slices) === 'done' && toolState(measured, T.water) === 'ready');
const redrawn = { ...measured, at: '2026-10-16T12:00:00Z' };
check('the lawn redrawn after the slices: the slices need an update', toolState(redrawn, T.slices) === 'stale');
check('a tool still being built says so', toolState(measured, T.soon) === 'soon');

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
