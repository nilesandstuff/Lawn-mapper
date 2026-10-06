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
 *   LAWN_SET=locked      exactly the maps listed in tools/locked-lawns.json
 *
 * The default is the benchmark, because a run that is not comparable should
 * be a choice and not an accident. train-detector.js checks the fingerprint
 * of what it actually got against the one the benchmark was frozen with and
 * says so loudly if they differ.
 */

import { readFileSync } from 'node:fs';

/*
 * THE LOCKED SET (owner, 2026-10-06: "keep adding maps to the corpus while
 * we're doing tests without throwing off the data"). tools/locked-lawns.json
 * lists the ids of the maps tests are run on. Maps approved after it was
 * written wait outside until workflow "Let in the next batch of maps"
 * (tools/lock-lawns.js) rewrites it -- when the owner says, or when a test
 * series is finished. A locked map later un-approved drops out (it is not
 * trained on unapproved); one edited in place trains on its new outline.
 */
export const LOCK_FILE = new URL('./locked-lawns.json', import.meta.url);

export function readLock(file = LOCK_FILE) {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(lock?.ids) && lock.ids.length ? lock : null;
  } catch {
    return null;
  }
}

/** The same label train-detector.js prints for a run's set, over ids. */
export function printOf(ids) {
  let h = 2166136261;
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}

const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

export const BENCHMARK = 'benchmark-1rijjz2';
export const BENCHMARK_PRINT = '1rijjz2';

export function lawnSetName(env = process.env) {
  const raw = String(env.LAWN_SET || 'benchmark').trim().toLowerCase();
  if (raw === 'all' || raw === 'new' || raw === 'benchmark' || raw === 'locked') return raw;
  throw new Error(`LAWN_SET must be benchmark, all, new or locked, not "${env.LAWN_SET}"`);
}

function lockOrThrow(lock) {
  if (!lock) throw new Error('LAWN_SET=locked but tools/locked-lawns.json lists no maps: run workflow "Let in the next batch of maps" first');
  return lock;
}

/** The SQL to append to a WHERE clause over `corpus`, leading space included. */
export function lawnSetClause(env = process.env, lock = readLock()) {
  const set = lawnSetName(env);
  if (set === 'all') return '';
  if (set === 'locked') return ` AND id IN (${lockOrThrow(lock).ids.map(sqlString).join(',')})`;
  if (set === 'new') return ' AND cohort IS NULL';
  return ` AND cohort = '${BENCHMARK}'`;
}

/** One line for a run's log. */
export function lawnSetDescription(env = process.env, lock = readLock()) {
  const set = lawnSetName(env);
  if (set === 'locked') {
    const l = lockOrThrow(lock);
    return `the locked set: ${l.ids.length} maps, locked ${l.lockedAt || '?'} (fingerprint ${l.fingerprint || printOf(l.ids)})`;
  }
  if (set === 'all') return 'every approved map (NOT the benchmark: compare with care)';
  if (set === 'new') return 'only maps approved since the benchmark was frozen';
  return `the frozen benchmark (${BENCHMARK})`;
}
