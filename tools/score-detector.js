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

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { scoreMap, summarise, verdict, CANOPY_LABEL } from '../worker/src/score.js';

const DB_NAME = process.env.DB_NAME || 'lawn-mapper';

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
`.replace(/\s+/g, ' ').trim();

function wrangler(args) {
  return execFileSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
}

/**
 * Wrangler prints banners, update notices and occasionally a warning before
 * the JSON. Find the payload rather than trusting the whole of stdout to parse
 * -- which is the same lesson tools/ci-prepare.js learned about `d1 list`.
 */
export function parseRows(stdout) {
  const lines = String(stdout || '').split('\n');

  /*
   * FROM THE FIRST LINE THAT OPENS THE JSON, not from the first '[' in the
   * output. Wrangler's proxy warning is printed as "▲ [WARNING] ..." -- so
   * scanning for a bracket finds that one, parses the banner, fails, and
   * reports an empty corpus on a database that is full. The quietest possible
   * way for this to be wrong.
   */
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim();
    if (head[0] !== '[' && head[0] !== '{') continue;
    try {
      const parsed = JSON.parse(lines.slice(i).join('\n'));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.flatMap((r) => r?.results || []);
    } catch {
      /* Not the start of the payload after all; keep looking. */
    }
  }
  return [];
}

/**
 * The line of wrangler's output that actually says what went wrong.
 *
 * NOT THE FIRST LINE. The first line of stderr here is a proxy warning that
 * every run prints, so reporting it turned "your token cannot read D1" into
 * "Proxy environment variables detected" -- a true sentence about something
 * else, which is the worst kind of diagnostic. The real complaint carries an
 * X, the word ERROR, or is simply the last thing said before it gave up.
 */
export function reasonFrom(err) {
  const raw = err?.stderr ?? err?.message ?? err;
  // `String({})` is "[object Object]", which is not a reason and reads like
  // one. An error with nothing usable in it says so plainly instead.
  const text = typeof raw === 'string' ? raw : '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const named = lines.find((l) => /error|unauthorized|forbidden|not found|✘|✗/i.test(l));
  return named || lines[lines.length - 1] || 'no reason given';
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
    rows = parseRows(wrangler([
      'd1', 'execute', DB_NAME, '--remote', '--json', '--command', QUERY,
    ]));
  } catch (err) {
    console.log('Could not read the corpus, so nothing was measured.');
    console.log(reasonFrom(err));
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
 * Only when this file is what was RUN. score.test.js imports it for parseRows
 * and reasonFrom, and a basename comparison would have been one identically
 * named file away from shelling out to wrangler inside the test suite.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
