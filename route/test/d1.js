// A D1 binding on real SQLite (node:sqlite, the engine D1 runs), for the route tests:
// the meter's guarantee is one SQL statement, so it is tested against SQL, not a stub.
import { DatabaseSync } from 'node:sqlite';

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async first(col) { const r = this.db.prepare(this.sql).get(...this.args); return r ? (col === undefined ? { ...r } : r[col]) : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })), success: true }; }
  async run() { const o = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(o.changes) } }; }
}

export function testDb() {
  const db = new DatabaseSync(':memory:');
  return { prepare: (sql) => new Statement(db, sql), raw: db };
}
