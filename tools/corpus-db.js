/**
 * Talking to the D1 database from a workflow.
 *
 * Shared by the tools that read the corpus, because every one of them has to
 * get the same three awkward things right and each was a real bug the first
 * time:
 *
 *   - the database is named by ID, not by the name in wrangler.toml, which
 *     carries a placeholder that ci-prepare fills in during a deploy
 *   - wrangler prints banners before its JSON, so the payload has to be found
 *     rather than assumed to be the whole of stdout
 *   - a failure arrives as JSON on STDOUT and sometimes exits zero, so "no
 *     rows" and "it refused" look identical unless checked for
 */

import { execFileSync } from 'node:child_process';
import { parseDatabaseList, pickDatabase } from './ci-prepare.js';

export const DB_NAME = process.env.DB_NAME || 'lawn-mapper';

export function wrangler(args) {
  return execFileSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
}

/**
 * The database by its real id.
 *
 * The committed wrangler.toml carries `REPLACE_WITH_D1_DATABASE_ID`, which
 * ci-prepare fills in on the runner during a deploy. Asking by NAME makes
 * wrangler resolve it through that binding, so a query went to a database
 * called REPLACE_WITH_D1_DATABASE_ID. Looking the id up needs no config file.
 */
export function resolveDatabase(quiet = false) {
  try {
    const found = pickDatabase(parseDatabaseList(wrangler(['d1', 'list', '--json'])), DB_NAME);
    if (found?.id) {
      if (!quiet) console.log(`Reading the "${found.name}" database.`);
      return found.id;
    }
  } catch { /* fall through to the name */ }
  return DB_NAME;
}

/**
 * The rows out of wrangler's output.
 *
 * FROM THE FIRST LINE THAT OPENS THE JSON, not from the first '[' in the
 * output: the proxy warning is printed as "▲ [WARNING] ...", so scanning for a
 * bracket finds that one, fails to parse it, and reports an empty corpus on a
 * database that is full.
 */
export function parseRows(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim();
    if (head[0] !== '[' && head[0] !== '{') continue;
    try {
      const parsed = JSON.parse(lines.slice(i).join('\n'));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.flatMap((r) => r?.results || []);
    } catch { /* not the payload; keep looking */ }
  }
  return [];
}

/**
 * A refusal that wrangler printed as JSON on stdout, or null.
 *
 * Checked BEFORE the rows are read. When it exits zero nothing throws, no rows
 * parse, and the run announces an empty corpus on a full database -- a
 * confident wrong answer, which does more damage than an error.
 */
export function wranglerError(output) {
  const lines = String(output || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()[0] !== '{') continue;
    try {
      const parsed = JSON.parse(lines.slice(i).join('\n'));
      const text = parsed?.error?.text || parsed?.error?.message
        || (typeof parsed?.error === 'string' ? parsed.error : null);
      if (text) return String(text).split('\n')[0].trim();
    } catch { /* not the payload */ }
  }
  return null;
}

/** The line of a failure that actually says what went wrong. */
export function reasonFrom(err) {
  const parts = [err?.stdout, err?.stderr, err?.message]
    .filter((v) => typeof v === 'string' && v.trim());

  for (const part of parts) {
    const named = wranglerError(part);
    if (named) return named;
  }
  for (const part of parts) {
    const lines = part.split('\n').map((l) => l.trim()).filter(Boolean)
      // Every run prints this and it is never the reason.
      .filter((l) => !/proxy environment variables/i.test(l));
    const named = lines.find((l) => /error|unauthorized|forbidden|not found|✘|✗/i.test(l));
    if (named) return named;
    if (lines.length) return lines[lines.length - 1];
  }
  return 'no reason given';
}

/**
 * Run one read-only query and hand back its rows.
 *
 * Throws with a readable message rather than returning an empty list, because
 * "the query failed" and "there is nothing there" want opposite reactions and
 * look the same from the caller.
 */
/*
 * ONE LINE FOR WRANGLER, WITHOUT THE COMMENTS. The SQL is written over many
 * lines, some of them `-- remarks`; flattened to one line, a remark ran to
 * the end of the statement and silently took every clause after it with it
 * (2026-10-09: a find pass meant for one map looked at all 87, because the
 * LIMIT, the id and the "never replace a traced photo" guard were all
 * behind a remark). So the remarks go first, then the whitespace.
 */
export const flatSql = (sql) => String(sql).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

export function query(sql) {
  const flat = flatSql(sql);
  let out = '';
  try {
    out = wrangler(['d1', 'execute', resolveDatabase(true), '--remote', '--json', '--command', flat]);
  } catch (err) {
    throw new Error(reasonFrom(err));
  }
  const refused = wranglerError(out);
  if (refused) throw new Error(refused);
  return parseRows(out);
}
