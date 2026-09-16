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
  SELECT id, county, tree_line, square_feet, shapes, detected_shapes, parcel
    FROM corpus
   WHERE status = 'approved'
   ORDER BY at DESC
   LIMIT 500
`;

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
    if (!score) {
      scored.push(null);
      continue;
    }
    score.canopy = row.tree_line === null || row.tree_line === undefined
      ? 'ungraded' : Number(row.tree_line);
    score.county = row.county;
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
  }

  /*
   * THE LAST FEW LINES ARE THE REPORT, because this is read on a phone and
   * nobody scrolls a CI log there. Everything above is the working.
   */
  console.log(`\n${'='.repeat(60)}`);
  for (const line of verdict(summary)) console.log(`\n${line}`);
  console.log(`\n${'='.repeat(60)}`);
}

/*
 * Only when this file is what was RUN, so importing it in a test cannot shell
 * out to wrangler. A basename comparison would have been one identically named
 * file away from doing exactly that.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
