/**
 * Run folder names, and the list that points at them.
 *
 * WHY THIS IS TESTED AT ALL. A slug is a string that ends up inside a bucket
 * key, and the Worker guards those keys with a pattern rather than a
 * sanitiser: `^runs/[a-z0-9][a-z0-9-]{0,95}/\d+(-mask)?\.png$`. That guard is
 * only as good as the promise made at this end -- if a model id with a slash
 * or a dot in it ever reached a folder name, every picture in that run would
 * 400 and the run would look like it had failed to upload.
 *
 * So the alphabet is the thing under test, plus the two ways the list can
 * quietly lose history: a re-run adding a second row for one folder, and a
 * long-lived list forgetting runs that still exist.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runSlug, clean, runKeys, runRow, KEEP_IN_LIST } from './run-folder.js';

/*
 * THE WORKER'S OWN PATTERNS, LIFTED OUT OF THE WORKER rather than copied here.
 *
 * A copy is what this test is for and a copy is also how it would stop being
 * worth anything: someone widens the route's pattern, the duplicate here goes
 * on passing, and the guard is untested from the day it changed. Reading the
 * source means a change to either end has to be a change to both.
 */
const admin = readFileSync(
  new URL('../worker/src/routes-admin.js', import.meta.url), 'utf8'
);
const patternIn = (label, re) => {
  const m = admin.match(re);
  assert.ok(m, `${label}: not found in routes-admin.js -- this test has gone stale`);
  return new RegExp(m[1]);
};
const SLUG = patternIn('run slug', /const RUN_SLUG = \/(.+?)\/;/);
const IMAGE = patternIn('image key', /\|\| \/(\^runs.+?)\/\.test\(key\)/);

/* --------------------------------------------------------- the clock */

{
  /* 18:25 UTC in September is 14:25 in New York, and the abbreviation that day
     is EDT. Stamping "EST" on it would name the folder an hour away from the
     clock the run was watched on. */
  const slug = runSlug({
    at: new Date('2026-09-22T18:25:48Z'),
    models: ['scalemae-large'],
    suffix: '896px',
  });
  assert.equal(slug, '2026-09-22-1425-edt-scalemae-large-896px');
  assert.match(slug, SLUG);
}

{
  /* And in January the same zone is EST, which is the whole reason the
     abbreviation is read from the clock rather than written down. */
  const slug = runSlug({ at: new Date('2026-01-15T18:25:48Z'), models: ['x'] });
  assert.ok(slug.includes('-est-'), slug);
  assert.ok(slug.startsWith('2026-01-15-1325-'), slug);
}

{
  /* Midnight eastern. This formatter answers "24" for it, and a folder called
     2026-03-02-2405 would sort after the evening of the day it belongs to --
     in a picker that is a run filed under the wrong date. */
  const slug = runSlug({ at: new Date('2026-03-02T05:05:00Z'), models: ['x'] });
  assert.ok(slug.startsWith('2026-03-02-0005-'), slug);
}

/* ------------------------------------------------------- the alphabet */

{
  /* THE CASE THAT WOULD BREAK EVERY PICTURE IN A RUN. A model id is
     owner/name, and both the slash and any dot have to be gone. */
  const slug = runSlug({
    at: new Date('2026-09-22T18:25:48Z'),
    models: ['restor/tcd-segformer-mit-b5'],
  });
  assert.match(slug, SLUG);
  assert.ok(!slug.includes('/'));
  assert.ok(!slug.includes('.'));
  assert.ok(slug.includes('restor-tcd-segformer-mit-b5'), slug);

  /* And the keys built from it pass the Worker's guard, which is the thing
     that actually matters. */
  const keys = runKeys(slug);
  assert.match(keys.shapes(0), IMAGE);
  assert.match(keys.mask(31), IMAGE);
  assert.match(keys.photo(3), IMAGE);
  assert.match(keys.layers(3), IMAGE);
  assert.equal(keys.index, `runs/${slug}/index.json`);
}

{
  /* Traversal, spelled every way it can be spelled. None of it survives. */
  for (const nasty of ['../corpus', 'a/../../b', 'x.png', 'A B', '../../']) {
    const out = clean(nasty);
    if (out) assert.match(out, SLUG, `clean(${JSON.stringify(nasty)}) = ${out}`);
    assert.ok(!out.includes('/'), nasty);
    assert.ok(!out.includes('.'), nasty);
  }
}

{
  /* An owner's slash becomes a hyphen rather than vanishing: "restor/tcd" and
     "restortcd" are the same folder to a reader and only one is the name. */
  assert.equal(clean('restor/tcd'), 'restor-tcd');
  /* Runs of rubbish collapse to one hyphen, and no name starts or ends on
     one -- the Worker's pattern requires a letter or digit first. */
  assert.equal(clean('--a???b--'), 'a-b');
  assert.match(clean('--a???b--'), SLUG);
}

{
  /* Long names are cut, and the cut does not leave a trailing hyphen behind
     -- which would be legal but reads as a truncation nobody meant. */
  const long = clean('x'.repeat(40) + '/' + 'y'.repeat(200));
  assert.ok(long.length <= 96, long.length);
  assert.match(long, SLUG);
  assert.ok(!long.endsWith('-'));
}

/* ------------------------------------------------------ the list rows */

{
  const row = runRow({
    slug: 'a-run',
    at: new Date('2026-09-22T18:25:48Z'),
    title: 'Scale-MAE 896px',
    about: 'does dropping unseen ground help the visible half',
    settings: { sizePx: 896, seenOnly: true },
    lawns: 31,
    headline: 34.4,
  });
  assert.equal(row.slug, 'a-run');
  assert.equal(row.at, '2026-09-22T18:25:48.000Z');
  assert.equal(row.headline, 34.4);
  assert.equal(row.settings.sizePx, 896);

  /* A run with no score gets null rather than a zero. The tree crowns are not
     a measurement, and "0.0%" in a picker would be read as one. */
  const crowns = runRow({ slug: 'b', title: 'tree crowns' });
  assert.equal(crowns.headline, null);
  assert.equal(crowns.about, '');
}

/* ------------------------------------------- what the list must not lose */

{
  /* The prepend-and-dedupe rule, which is what publishRunList does around its
     two bucket calls. Tested as arithmetic because the calls need wrangler
     and this does not.

     A RE-RUN INSIDE ONE MINUTE gets the same slug, and two rows pointing at
     one folder is a puzzle with no answer in it. */
  const older = [{ slug: 'b' }, { slug: 'a-run' }, { slug: 'c' }];
  const next = [{ slug: 'a-run' }, ...older.filter((r) => r.slug !== 'a-run')];
  assert.deepEqual(next.map((r) => r.slug), ['a-run', 'b', 'c']);
  assert.equal(next.length, 3, 'the repeat replaces its own row, it does not add one');
}

{
  /* The cap trims the LIST and never the folders: an old run keeps its
     pictures and its link for ever, and only falls out of the picker. */
  const many = Array.from({ length: KEEP_IN_LIST + 25 }, (_, i) => ({ slug: `r${i}` }));
  const kept = [{ slug: 'newest' }, ...many].slice(0, KEEP_IN_LIST);
  assert.equal(kept.length, KEEP_IN_LIST);
  assert.equal(kept[0].slug, 'newest');
  assert.ok(KEEP_IN_LIST >= 100, 'a short list would forget runs somebody still wants');
}

console.log('run folders: ok');
