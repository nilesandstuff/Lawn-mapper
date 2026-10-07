/**
 * Checks for the landing page's county table (tools/landing-coverage.js), and
 * for the landing itself in public/index.html.
 *
 *   node tools/landing-coverage.test.js
 */
import { readFileSync } from 'node:fs';
import { coverage } from '../worker/src/coverage.js';
import { fillCoverage, coverageBlock, reach, START, END } from './landing-coverage.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const states = coverage();
const block = coverageBlock(states);

check('every state gets a row', (block.match(/<tr><th scope="row">/g) || []).length === states.length);
check('a county served on its own is named', block.includes('Kent County'));
check('the reach reads as words',
  reach({ kind: 'whole' }) === 'Statewide'
  && reach({ kind: 'some', covered: 3, total: 105 }) === '3 of 105 counties');
check('names are escaped, never markup',
  coverageBlock([{ name: '<b>x</b>', kind: 'some', covered: 1, total: 2, counties: ['A & B'] }])
    .includes('&lt;b&gt;x&lt;/b&gt;') && !coverageBlock([{ name: '<b>x</b>', kind: 'whole', covered: 1, total: 1, counties: [] }]).includes('<b>x</b>'));

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('the page carries the markers once', page.split(START).length === 2 && page.split(END).length === 2);
const filled = fillCoverage(page, states);
check('filling keeps the page around the table',
  filled.startsWith(page.slice(0, page.indexOf(START))) && filled.endsWith(page.slice(page.indexOf(END) + END.length)));
check('filling twice changes nothing', fillCoverage(filled, states) === filled);
check('a page without markers is left alone', fillCoverage('<p>x</p>', states) === '<p>x</p>');

/* The landing itself: what it promises has to be on the page as text. */
check('the features table is a real table', /<table class="lp-table"[^>]*>[\s\S]*<caption>/.test(page));
check('it says there are no ads', /No ads/i.test(page));
check('the landing is chosen before the page paints', page.includes("classList.add('landing')"));
check('the FAQ is marked up for search', page.includes('"@type": "FAQPage"'));
check('"More lawn tools" stays off the landing',
  readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8').includes('html.landing #tools-wrap'));

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
