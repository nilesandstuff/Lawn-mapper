/**
 * Does the page contain the things the code reaches for?
 *
 * app.js addresses the DOM by id, several hundred times, and a missing id is
 * not an error anyone sees: `$('#thing')` returns null, the optional chaining
 * that guards most of these swallows it, and the feature is simply absent.
 * Moving a control between panels -- which is exactly what splitting one long
 * column into tabs is -- is the operation that produces those, and it produces
 * them silently and in bulk.
 *
 * The browser check would catch it, but only for the paths it drives, only
 * when Mapbox is reachable, and only after four minutes of real map. This is
 * two files and a regular expression, it runs offline in milliseconds, and it
 * covers every id in the file rather than the ones a script happens to click.
 *
 * It deliberately does NOT try to parse HTML. The question is not "is this
 * document well formed", it is "does app.js refer to an element that is not
 * there", and matching the id attributes answers exactly that.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const js = readFileSync(join(root, 'public/app.js'), 'utf8');
const css = readFileSync(join(root, 'public/styles.css'), 'utf8');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

/* --------------------------------------------------------- ids in the page */
const declared = new Set();
const duplicated = [];
for (const m of html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) {
  if (declared.has(m[1])) duplicated.push(m[1]);
  declared.add(m[1]);
}

check('every id in the page is unique',
  duplicated.length === 0,
  duplicated.length ? `repeated: ${[...new Set(duplicated)].join(', ')}` : `${declared.size} ids`);

/* ------------------------------------------------ ids the code asks for */
/*
 * Only the literal, unambiguous forms. A selector built from a variable --
 * `#mode-${m}`, `#tab-${t}` -- cannot be resolved by reading the file, and
 * guessing at what the variable might hold would produce false alarms about
 * ids that are fine. Those are covered below by naming the tables they come
 * from, which is the honest way to check a generated id: assert the table.
 */
const wanted = new Map(); // id -> how it was written
for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) wanted.set(m[1], `$('#${m[1]}')`);
for (const m of js.matchAll(/querySelector(?:All)?\('#([A-Za-z0-9_-]+)/g)) {
  wanted.set(m[1], `querySelector('#${m[1]}')`);
}
for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) {
  wanted.set(m[1], `getElementById('${m[1]}')`);
}

const missing = [...wanted.keys()].filter((id) => !declared.has(id));
check('every element the code reaches for is in the page',
  missing.length === 0,
  missing.length
    ? missing.map((id) => wanted.get(id)).join(', ')
    : `${wanted.size} referenced, all present`);

/* ------------------------------------------------- the generated families */
/*
 * The ids built from a table, checked against the table rather than against a
 * guess. These are the ones a rename breaks most quietly: the table moves, the
 * markup does not, and a whole row of buttons stops responding.
 */
const family = (label, prefix, names) => {
  const absent = names.filter((n) => !declared.has(`${prefix}${n}`));
  check(`every ${label} has its element`, absent.length === 0,
    absent.length ? absent.map((n) => `#${prefix}${n}`).join(', ') : names.join(', '));
};

const listFrom = (re) => {
  const m = js.match(re);
  return m ? [...m[1].matchAll(/'([a-z0-9_-]+)'/g)].map((x) => x[1]) : [];
};

const tabs = listFrom(/const TABS = \[([^\]]*)\]/);
check('the tab list is readable from the source', tabs.length >= 3, tabs.join(', '));
family('tab', 'tab-', tabs);
family('tab panel', 'pane-', tabs);

const modes = listFrom(/const MODES = \[([^\]]*)\]/);
check('the mode list is readable from the source', modes.length >= 3, modes.join(', '));
family('map mode button', 'mode-', modes);

/*
 * EVERY MODE BELONGS TO A TAB.
 *
 * The rail hides any button whose mode is not the open tab's, so a mode
 * missing from that table is a button that can never be shown -- a tool that
 * silently ceases to exist rather than one that visibly breaks.
 */
const modeTable = js.match(/const MODE_TAB = \{([^}]*)\}/);
const mapped = modeTable
  ? [...modeTable[1].matchAll(/([a-z]+):\s*'([a-z]+)'/g)].map((x) => [x[1], x[2]])
  : [];
const mappedModes = new Set(mapped.map(([mode]) => mode));
const orphans = modes.filter((m) => !mappedModes.has(m));
check('every map tool belongs to a tab', orphans.length === 0,
  orphans.length ? `no tab owns: ${orphans.join(', ')}` : mapped.map(([a, b]) => `${a}->${b}`).join(', '));
const badTabs = mapped.filter(([, tab]) => !tabs.includes(tab));
check('and every tool points at a tab that exists', badTabs.length === 0,
  badTabs.map(([a, b]) => `${a}->${b}`).join(', '));

/* ------------------------------------------------------------- styling */
/*
 * A class the code toggles but nothing styles is a state change nobody can
 * see, which is the same bug as a missing element with a better disguise.
 */
const toggled = new Set();
for (const m of js.matchAll(/classList\.(?:toggle|add)\('([a-z0-9-]+)'/g)) toggled.add(m[1]);
const unstyled = [...toggled].filter((c) => !css.includes(`.${c}`));
check('every class the code toggles is styled',
  unstyled.length === 0,
  unstyled.length ? unstyled.map((c) => `.${c}`).join(', ') : [...toggled].join(', '));

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
