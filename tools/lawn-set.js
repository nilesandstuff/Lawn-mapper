/**
 * Which lawns a run is over: the frozen benchmark, everything, or only what
 * arrived since.
 *
 * WHY A FROZEN SET. Every number in docs/DETECTOR-FINDINGS.md is a number on a
 * particular set of lawns, and one map moves a table by up to ten points
 * (H7). The corpus has to keep growing -- more maps is the biggest lever
 * left -- and the moment it does, a run over "all approved maps" is a run on
 * a different set from every table before it, and nothing compares.
 *
 * So the 32 lawns that every measurement from 2026-09-23 onward was made on
 * (fingerprint `1rijjz2`) carry `cohort = 'benchmark-1rijjz2'` in the corpus
 * table, stamped once by a migration, and a run says which set it wants:
 *
 *   LAWN_SET=benchmark   the frozen 32, comparable with every table since
 *   LAWN_SET=all         everything approved, for training on the most
 *   LAWN_SET=new         only lawns approved since the freeze
 *
 * The default is the benchmark, because a run that is not comparable should
 * be a choice and not an accident. train-detector.js checks the fingerprint
 * of what it actually got against the one the benchmark was frozen with and
 * says so loudly if they differ.
 */

export const BENCHMARK = 'benchmark-1rijjz2';
export const BENCHMARK_PRINT = '1rijjz2';

export function lawnSetName(env = process.env) {
  const raw = String(env.LAWN_SET || 'benchmark').trim().toLowerCase();
  if (raw === 'all' || raw === 'new' || raw === 'benchmark') return raw;
  throw new Error(`LAWN_SET must be benchmark, all or new, not "${env.LAWN_SET}"`);
}

/** The SQL to append to a WHERE clause over `corpus`, leading space included. */
export function lawnSetClause(env = process.env) {
  const set = lawnSetName(env);
  if (set === 'all') return '';
  if (set === 'new') return ' AND cohort IS NULL';
  return ` AND cohort = '${BENCHMARK}'`;
}

/** One line for a run's log. */
export function lawnSetDescription(env = process.env) {
  const set = lawnSetName(env);
  if (set === 'all') return 'every approved map (NOT the benchmark: compare with care)';
  if (set === 'new') return 'only maps approved since the benchmark was frozen';
  return `the frozen benchmark (${BENCHMARK})`;
}
