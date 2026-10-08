/**
 * Score the detector against every map a person has approved.
 *
 * FREE, AND THAT IS THE POINT. The corpus already stores both outlines for an
 * approved map -- what the detector drew, and what somebody corrected it into
 * -- so the comparison needs no prediction, no imagery and no Replicate token.
 * It is a subtraction that has been sitting in the database unperformed.
 *
 * Which makes it the thing to run before changing anything about detection. A
 * different model, a different prompt, a trim: each of those is an opinion
 * until there is a number it moved, and "the screenshots look better" cannot
 * be compared with last week's screenshots.
 *
 *   npx wrangler d1 execute lawn-mapper --remote --json \
 *     --command "SELECT ..." | node tools/score-detector.js
 *
 * or, the way anybody actually runs it, workflow "7. Score the detector".
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { scoreMap, summarise, verdict, CANOPY_LABEL } from '../worker/src/score.js';
import { query } from './corpus-db.js';

/*
 * Only what the scoring needs. `SELECT *` would drag every outline of every
 * rejected map through a CI log, and the shapes are the big column.
 */
const QUERY = `
  SELECT id, county, tree_line, square_feet, shapes, detected_shapes, parcel,
         model, mode
    FROM corpus
   WHERE status = 'approved'
   ORDER BY at DESC
   LIMIT 500
`;

/*
 * THE LIVE MODEL, MEASURED ON REAL USE (owner, 2026-10-08). Every score in
 * docs/DETECTOR-FINDINGS.md is held-out folds over the training lots; none is
 * the outline a release actually drew for somebody. These are: every map
 * finished with a release recorded, its outline against what the person
 * finished with. Not yet reviewed as well as approved, kept apart -- an
 * unreviewed map's final outline is the person's word, not a checked answer.
 * What it measures is how much people had to change, which is not quite
 * error: an outline accepted as drawn scores 0 whether or not it was right.
 */
export const LIVE_QUERY = `
  SELECT id, status, model_version, at, shapes, detected_shapes, parcel
    FROM corpus
   WHERE model_version IS NOT NULL AND model_version != ''
     AND detected_shapes IS NOT NULL
     AND status != 'rejected'
   ORDER BY at DESC
   LIMIT 1000
`;

/** One line per release and review state, newest release first. */
export function liveReport(rows, score = scoreMap) {
  const groups = new Map();
  for (const row of rows) {
    const s = score({
      truth: geometries(parse(row.shapes)),
      detected: geometries(parse(row.detected_shapes)),
      parcel: parse(row.parcel),
    });
    if (!s || !Number.isFinite(s.errorPct)) continue;
    const key = `${row.model_version}|${row.status === 'approved' ? 'approved' : 'not yet reviewed'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const lines = [];
  const keys = [...groups.keys()].sort().reverse();
  for (const key of keys) {
    const [release, state] = key.split('|');
    const list = groups.get(key);
    const errs = list.map((r) => r.errorPct).sort((a, b) => a - b);
    const med = errs[Math.floor((errs.length - 1) / 2)] + errs[Math.ceil((errs.length - 1) / 2)];
    const untouched = list.filter((r) => r.errorPct < 0.5).length;
    lines.push(`  ${release.slice(0, 24).padEnd(24)} ${state.padEnd(16)} ${String(list.length).padStart(4)} maps  `
      + `${(med / 2).toFixed(1).padStart(5)}% changed (median)  ${untouched} kept as drawn`);
  }
  return lines;
}

/** A stored JSON column, tolerating the row that never had one. */
const parse = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

/*
 * The shapes column is a list of geometries; older rows stored Features. Both
 * are accepted rather than migrated, because a scorer that refuses to read
 * half the corpus is a scorer that reports an improvement it did not measure.
 */
const geometries = (stored) => {
  const list = Array.isArray(stored) ? stored : stored?.features || [];
  return list.map((g) => (g?.geometry ? g.geometry : g)).filter(Boolean);
};

function main() {
  let rows = [];
  try {
    rows = query(QUERY);
  } catch (err) {
    console.log('Could not read the corpus, so nothing was measured.');
    console.log(err.message);
    process.exitCode = 1;
    return;
  }

  console.log(`${rows.length} approved map${rows.length === 1 ? '' : 's'} in the corpus.\n`);

  const scored = [];
  for (const row of rows) {
    const score = scoreMap({
      truth: geometries(parse(row.shapes)),
      detected: geometries(parse(row.detected_shapes)),
      parcel: parse(row.parcel),
    });
    /*
     * No error figure is no score: a finished outline of no area (an approved
     * "no lawn here" map) leaves the percentage undefined, and printing it
     * crashed the whole report (2026-10-08). Counted below as unscoreable.
     */
    if (!score || !Number.isFinite(score.errorPct)) {
      scored.push(null);
      continue;
    }
    score.canopy = row.tree_line === null || row.tree_line === undefined
      ? 'ungraded' : Number(row.tree_line);
    score.county = row.county;
    /*
     * Which detector actually produced this outline. Model AND mode, because
     * Find-grass and Exclude-objects ask opposite questions of the same model
     * and score differently for it -- naming only the model would put them in
     * one bucket and call the average a baseline.
     */
    score.run = `${row.model || 'no model'} / ${row.mode || 'no mode'}`;
    scored.push(score);

    const sign = score.signedSqFt >= 0 ? '+' : '';
    console.log(
      `  ${String(row.county || 'traced by hand').padEnd(22).slice(0, 22)} `
      + `${Math.round(score.truthSqFt).toLocaleString().padStart(8)} sq ft true  `
      + `${sign}${Math.round(score.signedSqFt).toLocaleString().padStart(7)} sq ft  `
      + `${score.errorPct.toFixed(1).padStart(5)}% wrong  `
      + `${CANOPY_LABEL[score.canopy]}`
    );
  }

  const summary = summarise(scored);

  if (summary.overall) {
    console.log('\nBy canopy grade:');
    for (const [key, b] of Object.entries(summary.byCanopy)) {
      console.log(
        `  ${CANOPY_LABEL[key].padEnd(24)} ${String(b.maps).padStart(3)} maps  `
        + `${b.medianErrorPct.toFixed(1).padStart(5)}% wrong  `
        + `${b.medianSignedPct >= 0 ? '+' : ''}${b.medianSignedPct.toFixed(1)}% signed`
      );
    }

    /* And by which detector drew it, so two settings are never one average. */
    console.log('\nBy how it was detected:');
    for (const [key, b] of Object.entries(summary.byRun)) {
      if (!b) continue;
      console.log(
        `  ${key.padEnd(24).slice(0, 24)} ${String(b.maps).padStart(3)} maps  `
        + `${b.medianErrorPct.toFixed(1).padStart(5)}% wrong  `
        + `${b.medianSignedPct >= 0 ? '+' : ''}${b.medianSignedPct.toFixed(1)}% signed`
      );
    }
  }

  let live = [];
  try {
    live = liveReport(query(LIVE_QUERY));
  } catch (err) {
    live = [`  could not read: ${err.message}`];
  }

  /*
   * THE LAST FEW LINES ARE THE REPORT, because this is read on a phone and
   * nobody scrolls a CI log there. Everything above is the working.
   */
  console.log(`\n${'='.repeat(60)}`);
  for (const line of verdict(summary)) console.log(`\n${line}`);
  console.log('\nThe live releases, on maps people finished with them'
    + ' (how much of the outline was changed, not checked error):');
  for (const line of (live.length ? live : ['  none yet: no finished map has a release recorded'])) console.log(line);
  console.log(`\n${'='.repeat(60)}`);
}

/*
 * Only when this file is what was RUN, so importing it in a test cannot shell
 * out to wrangler. A basename comparison would have been one identically named
 * file away from doing exactly that.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
