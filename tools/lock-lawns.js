/**
 * LET IN THE NEXT BATCH OF MAPS (owner, 2026-10-06). Writes
 * tools/locked-lawns.json: the ids of every approved map that has a banked
 * photo and a frame -- exactly what a training run would take -- so that
 * tests keep running on the same maps while new ones arrive. Workflow
 * "Let in the next batch of maps" runs this and commits the file.
 *
 * BEFORE (optional, ISO time): only maps last saved before then, to lock the
 * set an earlier run already used.
 *
 *   node tools/lock-lawns.js
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { query } from './corpus-db.js';
import { LOCK_FILE, readLock, printOf } from './lawn-set.js';
import { mapName } from '../worker/src/benchmark-ids.js';

/** What changes between two locks, by id. */
export function lockChange(before, after) {
  const was = new Set(before || []);
  const now = new Set(after);
  return {
    added: [...now].filter((id) => !was.has(id)),
    removed: [...was].filter((id) => !now.has(id)),
  };
}

export function main(env = process.env) {
  const before = (env.BEFORE || '').trim();
  if (before && Number.isNaN(Date.parse(before))) throw new Error(`BEFORE is not a time: "${before}"`);
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const rows = query(`
    SELECT id, lot_no FROM corpus
     WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL${before ? ` AND at < ${q(before)}` : ''}
     ORDER BY id`);
  if (!rows.length) throw new Error('No approved maps came back; the lock was left as it was.');
  const total = Number(query(`SELECT COUNT(*) AS n FROM corpus
     WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL`)[0]?.n) || rows.length;
  const old = readLock();
  const ids = rows.map((r) => r.id);
  const names = Object.fromEntries(rows.map((r) => [r.id, mapName(r.id, r.lot_no) || null]));
  const { added, removed } = lockChange(old?.ids, ids);
  const lock = {
    lockedAt: new Date().toISOString(),
    before: before || null,
    count: ids.length,
    fingerprint: printOf(ids),
    ids,
    names,
  };
  writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 1)}\n`);
  const name = (id) => names[id] || old?.names?.[id] || id;
  console.log(`Locked ${ids.length} maps (fingerprint ${lock.fingerprint})${before ? `, those saved before ${before}` : ''}.`);
  console.log(old ? `Was ${old.ids.length} (fingerprint ${old.fingerprint}).` : 'There was no lock before.');
  if (added.length) console.log(`Let in (${added.length}): ${added.map(name).join(', ')}`);
  if (removed.length) console.log(`Dropped, no longer approved (${removed.length}): ${removed.map(name).join(', ')}`);
  console.log(`Approved maps waiting outside the lock: ${Math.max(0, total - ids.length)}.`);
  return lock;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
