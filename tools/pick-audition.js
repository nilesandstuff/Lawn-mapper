/**
 * Hold back a few hand-traced lawns as an answer key.
 *
 *   node tools/pick-audition.js
 *
 * WHY AN ANSWER KEY AND NOT A SECOND OPINION. A stranger's first attempts have
 * to be judged before they are paid for more, and judging them by eye is both
 * slow and unreliable -- the whole reason for paying people is that looking at
 * lawns is the expensive step. Scored against an outline already traced by
 * hand, an audition is a number: how much of the real lawn did they find, how
 * much did they invent.
 *
 * WHICH LAWNS, and this is picked by evidence rather than by taste.
 *
 * An audition lawn has to be one where a competent person and a careful person
 * get the same answer. If the audition itself is ambiguous then a good worker
 * fails it for having a different opinion, which is the worst outcome
 * available: it rejects exactly the people worth keeping.
 *
 * So the ranking is:
 *
 *   NO INFERRED AREAS. Ground the owner marked "I know it is lawn, I cannot
 *     see it" is a judgement call by definition. A stranger cannot make the
 *     same one, should not be asked to, and is explicitly told these are
 *     optional -- so a lawn that needs them cannot score anybody.
 *   NO TREE LINE, or as little as the corpus has. H12 says the ambiguous
 *     ground around trees is where two careful people disagree.
 *   ORDINARY SIZE. The corpus holds a 158,000 sq ft lot; an audition that
 *     takes half an hour tests stamina rather than skill, and nobody is being
 *     paid for the audition.
 *   HAND EDITED. A map nobody corrected is SAM's opinion, not a person's, and
 *     scoring a stranger against SAM would be scoring them against the thing
 *     they were hired to beat.
 *
 * Nothing here is deleted or moved. An audition lawn stays in the corpus and
 * stays in training -- it is used twice, and nothing is lost by that.
 */

import { query, resolveDatabase } from './corpus-db.js';

/** What an audition lawn may be, in square feet. */
export const EASY_MIN_SQFT = 3000;
export const EASY_MAX_SQFT = 30000;

/**
 * Score a candidate: lower is easier, and easier is what this wants.
 *
 * Exported and pure so the ordering can be tested without a database. The
 * weights are not tuned and do not need to be -- they encode an order of
 * importance, not a measurement, and the printed list is checked by eye before
 * anything is written.
 */
export function difficulty(row) {
  const sqft = Number(row.square_feet) || 0;
  const canopy = row.tree_line === null || row.tree_line === undefined
    ? 1                                   // ungraded: assume the worst
    : Number(row.tree_line);
  const inferred = Number(row.inferred_shapes || 0);

  /* Inferred ground is disqualifying rather than expensive, so it dominates. */
  let score = inferred > 0 ? 1000 : 0;
  score += canopy * 100;

  /* Distance from a comfortable middle, so both a tiny courtyard and a small
     estate rank below an ordinary garden. */
  const middle = (EASY_MIN_SQFT + EASY_MAX_SQFT) / 2;
  score += Math.abs(sqft - middle) / middle * 10;

  if (!Number(row.hand_edited)) score += 50;
  return score;
}

export const sizeIsOrdinary = (sqft) => sqft >= EASY_MIN_SQFT && sqft <= EASY_MAX_SQFT;

function main() {
  const want = Number(process.env.WANT || 4);
  const apply = /^(1|true|yes)$/i.test(String(process.env.APPLY || ''));

  resolveDatabase();

  const rows = query(
    `SELECT id, county, square_feet, parcel_sq_ft, tree_line, hand_edited,
            audition, shapes
       FROM corpus
      WHERE status = 'approved'`
  );

  if (!rows.length) {
    console.log('No approved maps, so there is nothing to hold back.');
    process.exitCode = 1;
    return;
  }

  /*
   * How many shapes carry the inferred mark. Counted here rather than in SQL
   * because the shapes are JSON in a text column, and both stored forms have
   * to be understood -- maps traced before the flag existed hold bare
   * geometries, maps traced since hold Features with properties.
   */
  const withCounts = rows.map((r) => {
    let inferred = 0;
    try {
      for (const f of JSON.parse(r.shapes || '[]')) {
        if (f?.properties?.inferred) inferred++;
      }
    } catch { /* an unreadable map simply scores as having none */ }
    return { ...r, inferred_shapes: inferred };
  });

  const ranked = withCounts
    .filter((r) => sizeIsOrdinary(Number(r.square_feet) || 0))
    .sort((a, b) => difficulty(a) - difficulty(b));

  console.log(`${rows.length} approved maps, ${ranked.length} of an ordinary size.\n`);
  console.log('The easiest, which is what an audition wants:\n');

  const chosen = ranked.slice(0, want);
  for (const r of ranked.slice(0, Math.max(want + 3, 8))) {
    const mark = chosen.includes(r) ? '->' : '  ';
    console.log(
      `${mark} ${String(r.county || 'traced by hand').padEnd(22).slice(0, 22)} `
      + `${String(Number(r.square_feet).toLocaleString()).padStart(8)} sq ft  `
      + `canopy ${r.tree_line === null ? ' ?' : String(r.tree_line).padStart(2)}  `
      + `${r.inferred_shapes ? `${r.inferred_shapes} inferred` : 'nothing inferred'}  `
      + `${Number(r.hand_edited) ? 'hand edited' : 'NOT hand edited'}`
    );
  }

  if (!chosen.length) {
    console.log('\nNothing is both approved and of an ordinary size.');
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log('\nNothing was changed. Run this again with APPLY=1 to hold these back.');
    return;
  }

  const ids = chosen.map((c) => `'${String(c.id).replace(/'/g, "''")}'`).join(',');
  /* Cleared first, so a second run REPLACES the set rather than growing it --
     otherwise every run would hold back four more lawns for ever. */
  query('UPDATE corpus SET audition = 0 WHERE audition = 1');
  query(`UPDATE corpus SET audition = 1 WHERE id IN (${ids})`);

  console.log(`\nHeld back ${chosen.length} as the audition set.`);
  console.log('They stay in the corpus and stay in training; the flag only');
  console.log('says an audition may ask for them.');
}

if (process.argv[1] && process.argv[1].endsWith('pick-audition.js')) {
  try {
    main();
  } catch (e) {
    console.log('Could not pick an audition set:', e.message);
    process.exitCode = 1;
  }
}
