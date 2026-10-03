/**
 * WHAT THE NIGHTLY PARCEL SEARCH FOUND, county by county, into county_search
 * (kind 'parcels'), for the console's county search card -- the place to
 * troubleshoot a county that keeps failing (owner, 2026-10-03).
 *
 * Reads tools/find-report.json (tools/find-parcels.js) and the verifier's
 * tools/verify-log.json, which says for each candidate whether it passed and
 * why not.
 *
 *   node tools/record-county-search.js
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => (existsSync(resolve(here, name)) ? JSON.parse(readFileSync(resolve(here, name), 'utf8')) : null);

export const lit = (v) => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/**
 * One row per county. `keyOf` maps a FIPS code to the candidate key the
 * verifier logged it under; `log` is verify-log.json.
 */
export function rowsFrom(report, log, keyOf) {
  return (report?.results || []).filter((r) => r.fips || r.status === 'unknown').map((r) => {
    const key = r.fips ? keyOf(r.fips) : null;
    const v = key ? log?.[key] : null;
    let status = r.status;
    let reason = r.detail;
    if (r.status === 'found') {
      if (v?.ok) { status = 'covered'; reason = `verified ${v.at}${v.acres ? `, a ${v.acres} ac sample` : ''}`; }
      else if (v) { status = 'failed'; reason = v.why || 'did not verify'; }
      else { status = 'found'; reason = `found, not yet verified: ${r.detail}`; }
    } else if (r.status === 'registered') status = 'registry-miss';
    else if (r.status === 'none') status = 'failed';
    return {
      fips: r.fips || `?${r.county}|${r.state}`, kind: 'parcels', county: r.name || r.county, state: r.state,
      people: r.people, status, reason, detail: r.status === 'found' ? r.detail : null,
    };
  });
}

export const upsertSql = (row, at) => `INSERT INTO county_search (fips, kind, county, state, people, status, reason, detail, checked_at)
  VALUES (${[row.fips, row.kind, row.county, row.state, row.people, row.status, row.reason, row.detail, at].map(lit).join(', ')})
  ON CONFLICT(fips, kind) DO UPDATE SET county = excluded.county, state = excluded.state, people = excluded.people,
    status = excluded.status, reason = excluded.reason, detail = excluded.detail, checked_at = excluded.checked_at`;

async function main() {
  const report = read('find-report.json');
  if (!report) { console.log('No find-report.json: nothing searched this run.'); return; }
  const log = read('verify-log.json') || {};
  const { candidatePool } = await import('./candidates.js');
  const pool = candidatePool();
  const keyOf = (fips) => pool.candidates.find((c) => String(c.fips) === String(fips))?.key || null;
  const { wrangler, resolveDatabase } = await import('./corpus-db.js');
  const db = resolveDatabase(true);
  const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8')
    .match(/CREATE TABLE IF NOT EXISTS county_search \([\s\S]*?\n\);/)[0];
  wrangler(['d1', 'execute', db, '--remote', '--command', schema.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ')]);
  const at = new Date().toISOString();
  const rows = rowsFrom(report, log, keyOf);
  for (const row of rows) {
    wrangler(['d1', 'execute', db, '--remote', '--command', upsertSql(row, at).replace(/\s+/g, ' ')]);
    console.log(`${row.status.padEnd(14)} ${row.county}: ${String(row.reason).slice(0, 120)}`);
  }
  console.log(`\n${rows.length} counties recorded in county_search (parcels).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
