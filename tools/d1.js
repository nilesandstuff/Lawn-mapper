/**
 * A D1 binding backed by real SQLite, for tests.
 *
 * NOT A MOCK, AND THAT IS THE POINT. The interesting behaviour in db.js is not
 * JavaScript -- it is SQL. "Spend a credit if there is one" is correct because
 * of a WHERE clause and a `changes` count; a magic link is single-use because
 * of `used_at IS NULL` inside an UPDATE; one account per email is a UNIQUE
 * constraint. A hand-written stub would have to reimplement all of that to be
 * exercised, and would then be testing the reimplementation.
 *
 * node:sqlite is the same engine D1 runs, so the schema file, the constraints
 * and the statements are the real ones. What this adds is only the shape of
 * the binding: prepare/bind/first/all/run/batch, and `meta.changes`.
 *
 * Experimental in Node 22, which is fine for a test harness and is why it is
 * in tools/ rather than anywhere the Worker can reach.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '../worker/schema.sql');

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }

  /*
   * D1 hands back plain objects; node:sqlite returns null-prototype ones,
   * which behave differently under spread and `in`. Normalised here so a test
   * failure is about the code under test rather than about prototypes.
   */
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (!row) return null;
    const plain = { ...row };
    return column === undefined ? plain : plain[column];
  }

  async all() {
    const rows = this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r }));
    return { results: rows, success: true, meta: { rows_read: rows.length } };
  }

  async run() {
    const out = this.db.prepare(this.sql).run(...this.args);
    return {
      success: true,
      meta: {
        changes: Number(out.changes),
        last_row_id: Number(out.lastInsertRowid),
      },
    };
  }
}

/**
 * A fresh database with the real schema in it.
 *
 * Foreign keys are switched on explicitly because SQLite leaves them off by
 * default and D1 has them on -- so an ON DELETE CASCADE that works in
 * production and silently does nothing here would be a test that proves the
 * opposite of what it claims.
 */
export function testDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(SCHEMA, 'utf8'));

  return {
    prepare: (sql) => new Statement(db, sql),
    /*
     * D1's batch is one transaction. Reproduced faithfully rather than as a
     * loop, because "these two deletes happen together" is a property some
     * callers rely on and a loop would let one succeed alone.
     */
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    /** For a test that wants to look at the tables directly. */
    raw: db,
  };
}

/** An env with accounts switched on and nothing else configured. */
export const testEnv = (extra = {}) => ({ DB: testDb(), ...extra });
