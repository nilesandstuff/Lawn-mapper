/**
 * Where a run's pictures go, and the list of every run that has gone there.
 *
 * WHAT CHANGED AND WHY. Every run used to overwrite the last one at
 * `predictions/`, and the argument for that was written down: the numbers in
 * docs/DETECTOR-FINDINGS.md are the history, so the pictures only ever needed
 * to show the model as it is now. That argument was wrong in the one way that
 * matters. The findings file records what a run SCORED; it cannot record what
 * the shapes looked like, and "is this outline usable" is a question only the
 * picture answers. Two runs a point apart can draw completely different
 * pictures, and under the old layout the earlier one was already gone by the
 * time anybody thought to compare.
 *
 * So a run now writes to a folder of its own and nothing is overwritten.
 *
 * THE NAME IS THE LABEL. `2026-09-22-1425-EDT-scale-mae-896` is the date, the
 * eastern wall-clock time, and the model -- readable in a bucket listing
 * without opening anything, and sortable because the date leads.
 *
 * ABOUT "EST". The folder was asked to carry EST and it carries EASTERN time
 * with whichever abbreviation was true that day: EDT from March to November,
 * EST the rest of the year. Stamping "EST" on a summer run would put a name on
 * the folder an hour away from the clock the run was watched on, and these are
 * meant to be found again by when they happened.
 *
 * WHAT IS IN A FOLDER:
 *
 *   runs/<slug>/index.json     the run: its description, its settings, its lawns
 *   runs/<slug>/<n>.png        the interpreted shapes -- what the tools get
 *   runs/<slug>/<n>-mask.png   the raw mask -- what the model actually said
 *
 * and one list beside them:
 *
 *   runs/index.json            every run, newest first
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every run lives under this one prefix, so a listing is one call. */
export const RUNS = 'runs';

/**
 * How many runs the list remembers.
 *
 * The list is read by the page on every load, so it is the one file here that
 * must not grow without limit. The FOLDERS are never touched -- an old run
 * keeps its pictures and its URL for ever, and only falls off the picker. Two
 * hundred is years of runs at the rate this project produces them.
 */
export const KEEP_IN_LIST = 200;

/**
 * A folder name, from the clock and the model.
 *
 * Lowercase, digits and hyphens only, and that is load-bearing rather than
 * tidy: this string ends up in a bucket key that a browser asks for by name,
 * and the Worker's allowlist for those keys has no way to spell a dot. A model
 * id like `restor/tcd-segformer-mit-b5` has to come through that filter
 * unrecognisable as a path or not come through at all.
 */
export function runSlug({ at = new Date(), models = [], suffix = '' } = {}) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  /* Hour 24 is midnight in this formatter's answer, and "24:05" in a folder
     name would sort after the evening of the day it belongs to. */
  const hour = get('hour') === '24' ? '00' : get('hour');
  const stamp = `${get('year')}-${get('month')}-${get('day')}-${hour}${get('minute')}`
    + `-${get('timeZoneName')}`;

  const name = [...(Array.isArray(models) ? models : [models]), suffix]
    .filter(Boolean)
    .map((m) => String(m))
    .join('-');

  return clean(`${stamp}-${name}`);
}

/**
 * Anything at all, as something safe to put in a bucket key.
 *
 * An owner's slash becomes a hyphen rather than disappearing, because
 * `restor/tcd-segformer` and `restortcd-segformer` are the same folder to a
 * reader and only one of them is the model's name.
 */
export const clean = (s) => String(s)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 96)
  .replace(/-+$/, '');

/**
 * The shape of one row in runs/index.json.
 *
 * Deliberately small and deliberately flat: the page loads this list before it
 * loads anything else, so everything a picker needs to label a run has to be
 * here, and nothing else should be. The per-lawn entries stay in the run's own
 * index where they are only paid for when a run is opened.
 */
export function runRow({ slug, at, title, about, settings, lawns, headline }) {
  return {
    slug,
    at: (at || new Date()).toISOString(),
    /* What kind of run it was, in two or three words: "Scale-MAE 896px",
       "tree crowns". */
    title: title || slug,
    /* WHY IT WAS RUN -- the broad concept being tested, in the words of
       whoever started it. A settings dump says what was different; it does
       not say what the difference was meant to prove, and six weeks later
       that is the only part nobody can reconstruct. */
    about: about || '',
    /* Every knob that was turned, as given. Free-form on purpose: the two
       tools that write these have almost nothing in common, and forcing a
       shared schema would mean one of them lying. */
    settings: settings || {},
    lawns: lawns ?? null,
    /* One number for the picker, where there is one. The tree crowns have
       none, and inventing one for them would be worse than the gap. */
    headline: headline ?? null,
  };
}

const put = (bucket, key, file, type) => execFileSync('npx', [
  'wrangler', 'r2', 'object', 'put', `${bucket}/${key}`,
  '--file', file, '--content-type', type, '--remote',
], { stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The run list as it stands, or an empty one.
 *
 * A MISSING LIST AND AN UNREADABLE LIST ARE THE SAME ANSWER HERE, and that is
 * a decision rather than a shrug: the first run ever has no list, and the
 * alternative -- failing the run because the index could not be parsed --
 * would throw away an hour of work to protect a file that is rebuilt from
 * scratch on the next line anyway.
 *
 * It is not the same as overwriting silently. The caller is told how many rows
 * came back, so a list that reads as empty when it should not shows up as
 * "1 run" in a log that said 14 last time.
 */
export function readRunList(bucket, dir) {
  const file = join(dir, 'runs-index.json');
  try {
    execFileSync('npx', [
      'wrangler', 'r2', 'object', 'get', `${bucket}/${RUNS}/index.json`,
      '--file', file, '--remote',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

/**
 * Add this run to the list and write it back.
 *
 * Read, prepend, write. There is no locking and none is needed: these runs are
 * started by hand from a phone, one at a time, and two overlapping would cost
 * one row in a picker rather than any pictures.
 *
 * A RE-RUN REPLACES ITS OWN ROW rather than adding a second one. Slugs carry
 * the minute, so this only bites when a run is repeated inside sixty seconds
 * -- but when it does, two identical rows pointing at one folder is a puzzle
 * with no answer in it.
 */
export function publishRunList(bucket, dir, row) {
  const existing = readRunList(bucket, dir).filter((r) => r?.slug !== row.slug);
  const runs = [row, ...existing].slice(0, KEEP_IN_LIST);
  const file = join(dir, 'runs-index-out.json');
  writeFileSync(file, `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    note: 'Every run that has drawn pictures, newest first. A run keeps its '
      + 'folder for ever; this list is only what the picker shows.',
    runs,
  }, null, 1)}\n`);
  put(bucket, `${RUNS}/index.json`, file, 'application/json');
  return { runs: runs.length, kept: existing.length };
}

/** The keys inside one run's folder. One place, so nothing spells them twice. */
export const runKeys = (slug) => ({
  index: `${RUNS}/${slug}/index.json`,
  shapes: (n) => `${RUNS}/${slug}/${n}.png`,
  mask: (n) => `${RUNS}/${slug}/${n}-mask.png`,
});
