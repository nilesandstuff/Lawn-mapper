/**
 * Does the browser check ever reach for a control that is not on screen?
 *
 * THIS EXISTS BECAUSE REASONING ABOUT IT FAILED, FOUR TIMES.
 *
 * Splitting the panel into tabs made every control conditional: a button is on
 * the page but not reachable unless its step is open. Playwright waits for an
 * unreachable control, retries, and eventually throws -- so the symptom is not
 * a failed check, it is the whole run stopping dead partway through with no
 * indication of which control or why. Three separate sections were found this
 * way, one per run, each after a full round trip through a workflow and a
 * report from the person waiting on it.
 *
 * The information needed to catch all of them is sitting in two files. The
 * markup says which pane each id lives in; app.js says which step each map tool
 * belongs to; and the check script says, in order, which tab it opens and what
 * it presses. Walking that is not clever, and it answers in milliseconds what
 * otherwise costs a four-minute run and somebody's afternoon.
 *
 * WHAT IT DOES NOT DO: this reads the script in a straight line. A control
 * pressed inside a branch that also switched tabs will be judged against
 * whichever tab the linear read last saw. False alarms are therefore possible
 * and are meant to be fixed by making the script's tab explicit -- an
 * unconditional goTab before the branch -- rather than by loosening this.
 *
 *   node tools/testflow.test.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const js = readFileSync(join(root, 'public/app.js'), 'utf8');
const script = readFileSync(join(root, 'tools/browser-test.mjs'), 'utf8');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

/* ------------------------------------------- which step owns which control */

/** The span of one element, found by counting its own kind of tag. */
function spanOf(source, startIndex, tag) {
  let depth = 0;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = startIndex;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return [startIndex, m.index];
  }
  return [startIndex, source.length];
}

/** id -> the step whose pane contains it, for ids that live in a pane. */
const owner = new Map();
for (const m of html.matchAll(/<div class="tabpane" id="pane-([a-z]+)"/g)) {
  const [from, to] = spanOf(html, m.index, 'div');
  for (const id of html.slice(from, to).matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) {
    if (id[1] !== `pane-${m[1]}`) owner.set(id[1], m[1]);
  }
}

check('the panes were found and are not empty', owner.size > 6,
  `${owner.size} controls live inside a step's pane`);

/*
 * The map's tools belong to steps too -- that table is in app.js, because the
 * rail and the panel are two halves of one decision.
 */
const modeTable = js.match(/const MODE_TAB = \{([^}]*)\}/);
for (const [, mode, tab] of modeTable[1].matchAll(/([a-z]+):\s*'([a-z]+)'/g)) {
  owner.set(`mode-${mode}`, tab);
}

/*
 * The sub-tools appear inside lawn mode, which is a drawing-step mode, so they
 * are reachable from exactly the step that mode is. Derived rather than
 * written down, so moving lawn mode to another step moves these with it.
 */
const lawnStep = owner.get('mode-shape');
for (const m of html.matchAll(/\bid="(tool-[a-z]+|size-[a-z]+|shape-tools|brush-sizes)"/g)) {
  owner.set(m[1], lawnStep);
}

/*
 * Controls built at runtime are not in the markup, so they are owned by
 * whatever container they are built into.
 *
 * The exclusion tick boxes are the case: "#excl-built" exists only once the
 * catalogue has arrived from the Worker, and nothing in index.html mentions
 * it. Without this the linter would see a press it has no opinion about, which
 * is the one outcome worse than a wrong opinion -- it looks like coverage.
 */
const GENERATED = [
  [/^excl-/, owner.get('exclude-list')],
];
const ownerOf = (id) => owner.get(id)
  || (GENERATED.find(([re]) => re.test(id)) || [])[1];

check('the runtime-built controls have a step as well',
  Boolean(owner.get('exclude-list')),
  `the tick boxes are built into #exclude-list, on the "${owner.get('exclude-list')}" step`);

/* ------------------------------------------------ walk the check script */

/*
 * Only the calls that need the control to be on screen and pressable.
 * `page.evaluate(() => document.querySelector('#x').click())` deliberately
 * bypasses that and is used on purpose in places, so it is not counted.
 */
const ACTIONS = [
  /page\.click\('#([A-Za-z0-9_-]+)'\)/,
  /page\.(?:check|uncheck)\('#([A-Za-z0-9_-]+)'\)/,
  /page\.fill\('#([A-Za-z0-9_-]+)'/,
  /page\.selectOption\('#([A-Za-z0-9_-]+)'/,
  /page\.locator\('#([A-Za-z0-9_-]+)'\)\.(?:click|fill|check|uncheck)\(/,
  /page\.locator\('#([A-Za-z0-9_-]+)'\)\.is(?:Visible|Checked|Enabled)\(/,
];

const lines = script.split('\n');
let tab = 'address';          // where confirmLocation leaves you
let depth = 0;                 // inside a helper definition?
const problems = [];
/*
 * Counted, and asserted on below.
 *
 * A linter that silently examines nothing passes every time, and this one
 * skips helper bodies by a heuristic -- so "how much did it actually look at"
 * is not a detail, it is whether the PASS above means anything. The first
 * version of this skipped two thirds of the file and reported all clear.
 */
const seen = { actions: 0, gated: 0, hops: 0, skipped: 0, whileLocked: 0, lockOn: 0 };

/*
 * The two facts the locks are made of.
 *
 * A step is locked when redoing it would undo later work: the AI step once the
 * lawn has been corrected by hand, the boundary step once a lawn has been
 * measured against it. A locked step greys its pane AND takes its map tools
 * away, so anything reached for there waits forever -- the same hang as a
 * control on another tab, wearing a different hat.
 */
let lawn = false;
let edited = false;
const locked = (step) => (step === 'detect' && edited) || (step === 'address' && lawn);

for (const [i, raw] of lines.entries()) {
  const line = raw.trim();

  /*
   * Helper bodies are skipped: the control they press depends on the argument,
   * so they are judged at the call site instead (see reachableIn below).
   */
  if (/^(const \w+ = async|async function )/.test(line)) depth = 1;
  if (depth) {
    seen.skipped++;
    if (line === '};' || line === '}') depth = 0;
    continue;
  }

  // Navigating away resets everything; nothing is known until the next goTab.
  if (/page\.goto\(/.test(line)) { tab = null; continue; }

  const opened = line.match(/goTab\(page, '([a-z]+)'\)/);
  if (opened) { tab = opened[1]; seen.hops++; continue; }
  // Clearing the lock is done from the AI step and stays there.
  if (/unlockDetect\(page\)/.test(line)) {
    tab = 'detect';
    lawn = false;
    edited = false;
    continue;
  }

  /* reachableIn('mode') presses a map tool; reachableIn('x', 'tool') a sub-tool. */
  const reached = line.match(/reachableIn\('([a-z]+)'(?:,\s*'([a-z]+)')?\)/);
  if (reached) {
    const need = reached[2] ? lawnStep : ownerOf(`mode-${reached[1]}`);
    if (tab && need && need !== tab) {
      problems.push(`line ${i + 1}: reachableIn('${reached[1]}') needs the `
        + `"${need}" step, but the script is on "${tab}"`);
    } else if (need && locked(need)) {
      problems.push(`line ${i + 1}: reachableIn('${reached[1]}') needs the `
        + `"${need}" step, which is locked — its map tools are gone`);
    }
    // Opening a brush is the start of painting, which is a hand correction.
    if (reached[2] === 'add' || reached[2] === 'erase') edited = true;
    continue;
  }

  for (const re of ACTIONS) {
    const hit = line.match(re);
    if (!hit) continue;
    seen.actions++;
    const need = ownerOf(hit[1]);
    if (need) seen.gated++;
    if (locked(need)) seen.whileLocked++;
    if (tab && need && need !== tab) {
      problems.push(`line ${i + 1}: #${hit[1]} is on the "${need}" step, `
        + `but the script is on "${tab}"`);
    } else if (need && locked(need)) {
      problems.push(`line ${i + 1}: #${hit[1]} is on the "${need}" step, which is `
        + `locked by ${edited ? 'hand corrections' : 'a measured lawn'} — clear first`);
    }
    /*
     * What the press does to the locks, for the presses that decide them.
     *
     * Not a simulation of the app, just the handful of buttons whose effect on
     * the two flags is unambiguous from the name. Anything subtler is left
     * alone rather than guessed at: a linter that invents state produces false
     * alarms, and a false alarm here is a green suite somebody stops trusting.
     */
    if (hit[1] === 'btn-parcel-shape') { lawn = true; edited = true; seen.lockOn++; }
    if (hit[1] === 'btn-draw' || hit[1] === 'tool-add' || hit[1] === 'tool-erase') edited = true;
    if (hit[1] === 'btn-detect') { lawn = true; edited = false; }
    if (hit[1] === 'btn-clear' || hit[1] === 'btn-lock-clear') { lawn = false; edited = false; }
    break;
  }
}

check('the check script never reaches for a control on another step',
  problems.length === 0,
  problems.length
    ? problems.join('\n      ')
    : `${seen.actions} presses read, ${seen.gated} of them on a step`);

/*
 * The linter looked at enough of the file to mean something.
 *
 * These floors are not arbitrary: below them the script could not be doing
 * what it says it does -- it opens tabs constantly and presses step-owned
 * controls throughout -- so a number under them means the walk broke, not that
 * the script got simpler.
 */
check('and it actually read the script rather than skipping it',
  seen.actions >= 40 && seen.gated >= 15 && seen.hops >= 8,
  `${seen.actions} presses, ${seen.gated} step-owned, ${seen.hops} tab changes, `
  + `${seen.skipped} lines inside helpers`);

/*
 * And the lock half is doing something too.
 *
 * A lock that never engages during the walk would make the check above pass
 * for the wrong reason -- it would be asserting nothing, which is the failure
 * mode of every guard written after the bug it guards against. The script
 * seeds a lawn repeatedly, so the flags must turn on somewhere.
 */
check('and the lock tracking engages somewhere in the run',
  seen.lockOn > 0, `${seen.lockOn} presses put a step into a locked state`);

/*
 * A press on a locked step is the same failure wearing a different hat: the
 * pane stops taking pointer events and the map tools go away, so anything
 * reached for there waits forever. The script has to clear the lock first,
 * which is what unlockDetect is for -- so it has to exist and be used.
 */
check('and it has a way to clear a lock rather than pressing through one',
  /async function unlockDetect/.test(script) && /unlockDetect\(page\)/.test(script),
  'unlockDetect presses the notice\'s own button, the way a person would');

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
