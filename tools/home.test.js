/** The home page build (tools/home-prepare.js).   node tools/home.test.js */
import { readFileSync } from 'node:fs';
import { homeDomainFor, fillHome, wranglerFor } from './home-prepare.js';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); if (!ok) failures++; };

check('the home domain is the parent of the app\'s', homeDomainFor('lawnmap.nilesandstuff.com') === 'nilesandstuff.com');
check('HOME_DOMAIN wins when it is set', homeDomainFor('lawnmap.nilesandstuff.com', 'Example.org') === 'example.org');
check('a bare domain has no parent to put a home page on', homeDomainFor('nilesandstuff.com') === null);

const page = readFileSync(new URL('../home/public/index.html', import.meta.url), 'utf8');
const filled = fillHome(page, 'nilesandstuff.com', 'lawnmap.nilesandstuff.com');
check('every placeholder is filled', !/__HOME__|__LAWNMAP__/.test(filled));
check('the flagship card goes to Lawn Mapper', filled.includes('href="https://lawnmap.nilesandstuff.com/"'));

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

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
