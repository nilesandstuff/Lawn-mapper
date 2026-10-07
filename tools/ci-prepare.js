/**
 * Fills in the deploy-time parts of wrangler.toml inside CI.
 *
 * Exists so the project can be deployed from a phone. Two values normally
 * require a terminal and a text editor:
 *
 *   - the KV namespace id, which only exists once you have created it
 *   - the custom domain route, which only works once the domain is in
 *     Cloudflare
 *
 * Both are resolved here instead: the namespace is found (or created) via the
 * Cloudflare API token already needed for deploying, and the domain comes from
 * a repository variable. The committed wrangler.toml keeps its placeholder and
 * is never modified in git -- this only rewrites the checkout inside the runner.
 *
 *   node tools/ci-prepare.js
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN  required, same token used to deploy
 *   KV_NAMESPACE_ID       optional; skips discovery if you already know it
 *   CUSTOM_DOMAIN         optional, e.g. lawnmap.nilesandstuff.com
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { milestonesReached } from './milestones.js';
import { fillCoverage } from './landing-coverage.js';
import { coverage } from '../worker/src/coverage.js';

const CONFIG = new URL('../wrangler.toml', import.meta.url);
const PLACEHOLDER = 'REPLACE_WITH_KV_NAMESPACE_ID';
const DB_PLACEHOLDER = 'REPLACE_WITH_D1_DATABASE_ID';
const DB_NAME = 'lawn-mapper';
const BUCKET_NAME = 'lawn-mapper-corpus';
const MIGRATIONS = new URL('../worker/migrations.sql', import.meta.url);

/* ------------------------------------------------------- pure helpers */

/**
 * Pull the JSON array out of `wrangler kv namespace list` output. Wrangler
 * interleaves banners and update notices with the payload, so slicing between
 * the outermost brackets is more durable than parsing the whole stream.
 */
export function parseNamespaceList(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.filter((n) => n && n.id) : [];
  } catch {
    return [];
  }
}

/** The namespace backing the QUOTA binding, whatever prefix wrangler gave it. */
export function pickQuota(list) {
  return list.find((n) => /(^|[-_])quota$/i.test(String(n.title || ''))) ||
         list.find((n) => /quota/i.test(String(n.title || ''))) ||
         null;
}

/** Read the new id out of `wrangler kv namespace create` output. */
export function parseCreatedId(stdout) {
  return (
    stdout.match(/id\s*=\s*"([0-9a-f]{32})"/i)?.[1] ||
    stdout.match(/"id"\s*:\s*"([0-9a-f]{32})"/i)?.[1] ||
    stdout.match(/\b([0-9a-f]{32})\b/i)?.[1] ||
    null
  );
}

/**
 * Pull the databases out of `wrangler d1 list --json`, tolerating the banners
 * wrangler interleaves with them -- same reasoning as the namespace list.
 */
export function parseDatabaseList(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.filter((d) => d && (d.uuid || d.id)) : [];
  } catch {
    return [];
  }
}

/** Ours, by name. Wrangler reports the id as `uuid` in some versions, `id` in others. */
export function pickDatabase(list, name = DB_NAME) {
  const found = list.find((d) => String(d.name || '').toLowerCase() === name);
  return found ? { name: found.name, id: found.uuid || found.id } : null;
}

/** Read the id out of `wrangler d1 create` output, whatever shape it took. */
export function parseCreatedDatabaseId(stdout) {
  return (
    stdout.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)?.[1] ||
    stdout.match(/"uuid"\s*:\s*"([0-9a-f-]{36})"/i)?.[1] ||
    stdout.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1] ||
    null
  );
}

/**
 * Which buckets already exist, out of `wrangler r2 bucket list`.
 *
 * Sliced between the outermost brackets like the other two lists, for the same
 * reason: wrangler interleaves banners and update notices with the payload.
 * Older wrangler prints a plain table instead of JSON, so a failure to parse
 * falls back to searching the raw text for the name -- finding it there is
 * weaker evidence than a parsed row, but it is the difference between reusing
 * a bucket and trying to create one that is already there.
 */
export function bucketExists(stdout, name) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        return parsed.some((b) => String(b?.name || b?.bucket_name) === name);
      }
    } catch { /* fall through to the text scan */ }
  }
  return new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(stdout);
}

/** Substitute the ids and, if asked, append a custom-domain route. */
export function applyConfig(toml, { kvId, dbId, bucket = true, customDomain } = {}) {
  let out = toml;

  if (kvId) out = out.split(PLACEHOLDER).join(kvId);

  /*
   * NO DATABASE MEANS NO BINDING, not a binding with a placeholder in it.
   *
   * Leaving "REPLACE_WITH_D1_DATABASE_ID" in the file does not deploy an app
   * without accounts -- it fails the deploy with "database not found", which
   * turns an optional feature nobody set up into a site that is down. Removing
   * the block is what actually produces the app as it was before accounts
   * existed, which is the behaviour the Worker is written for.
   */
  out = dbId
    ? out.split(DB_PLACEHOLDER).join(dbId)
    : out.replace(/\n\[\[d1_databases\]\][\s\S]*?(?=\n\[|\n#|$)/, '\n');

  /*
   * NO BUCKET MEANS NO BINDING, the same rule the database follows above and
   * for the same reason: wrangler refuses to deploy a Worker bound to a bucket
   * that does not exist, so leaving the block in would take the whole site down
   * over a corpus nobody has set up yet. Without it the Worker stores outlines
   * and no pictures, which is exactly what it did before the bucket existed.
   */
  if (!bucket) {
    out = out.replace(/\n\[\[r2_buckets\]\][\s\S]*?(?=\n\[|\n#|$)/, '\n');
  }

  if (customDomain) {
    // Only the commented example should be present; a real one means someone
    // configured routes deliberately and we must not add a second.
    if (/^\s*\[\[routes\]\]/m.test(out)) {
      throw new Error(
        'wrangler.toml already declares [[routes]]. Remove the CUSTOM_DOMAIN ' +
        'repository variable, or delete the routes block from the file.'
      );
    }
    out += `\n[[routes]]\npattern = "${customDomain}"\ncustom_domain = true\n`;
  }

  return out;
}

/* --------------------------------------------------------------- main */

function wrangler(args) {
  return execFileSync('npx', ['--no-install', 'wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}

function resolveKvId() {
  if (process.env.KV_NAMESPACE_ID) {
    console.log('Using KV namespace id from the KV_NAMESPACE_ID variable.');
    return process.env.KV_NAMESPACE_ID.trim();
  }

  console.log('Looking for an existing QUOTA KV namespace…');
  let existing = null;
  try {
    existing = pickQuota(parseNamespaceList(wrangler(['kv', 'namespace', 'list'])));
  } catch (err) {
    // Listing can fail on a token without KV read scope; creation below will
    // produce the clearer error, so keep going rather than stopping here.
    console.log(`  could not list namespaces (${firstLine(err)})`);
  }

  if (existing) {
    console.log(`  found "${existing.title}" -> ${existing.id}`);
    return existing.id;
  }

  console.log('  none found; creating one…');
  const id = parseCreatedId(wrangler(['kv', 'namespace', 'create', 'QUOTA']));
  if (!id) throw new Error('Created a KV namespace but could not read its id from wrangler output.');
  console.log(`  created -> ${id}`);
  return id;
}

/**
 * The accounts database, or null.
 *
 * NULL IS A REAL ANSWER. A deployment whose API token cannot create a D1
 * database, or that simply does not want accounts, should still deploy -- the
 * Worker reads a missing binding as "signed out, always" and the site is what
 * it was before accounts existed. Failing the whole deploy over an optional
 * feature would be the wrong trade, so every path here returns rather than
 * throws, and says what it decided.
 */
function resolveDbId() {
  if (process.env.D1_DATABASE_ID) {
    console.log('Using D1 database id from the D1_DATABASE_ID variable.');
    return process.env.D1_DATABASE_ID.trim();
  }

  console.log(`Looking for the "${DB_NAME}" D1 database…`);
  let existing = null;
  try {
    existing = pickDatabase(parseDatabaseList(wrangler(['d1', 'list', '--json'])));
  } catch (err) {
    console.log(`  could not list databases (${firstLine(err)})`);
  }
  if (existing) {
    console.log(`  found -> ${existing.id}`);
    return existing.id;
  }

  console.log('  none found; creating one…');
  try {
    const id = parseCreatedDatabaseId(wrangler(['d1', 'create', DB_NAME]));
    if (!id) {
      console.log('  created, but could not read the id from wrangler output.');
      return null;
    }
    console.log(`  created -> ${id}`);
    return id;
  } catch (err) {
    console.log(`  could not create one (${firstLine(err)})`);
    console.log('');
    console.log('  ACCOUNTS ARE OFF for this deploy. The site itself is fine --');
    console.log('  measuring, correcting and saving to the browser all work.');
    console.log('');
    console.log('  Almost always this is the API token. D1 is newer than this');
    console.log('  project, so a token made before it existed carries Workers and');
    console.log('  KV permissions and not D1. Edit the token at');
    console.log('    https://dash.cloudflare.com/profile/api-tokens');
    console.log('  add the "D1: Edit" permission, and deploy again. Nothing else');
    console.log('  changes and nothing is lost -- the database is created and the');
    console.log('  schema applied on the next run.');
    console.log('');
    console.log('  Or make it by hand (Cloudflare dashboard -> Storage & Databases');
    console.log('  -> D1 -> Create, named "lawn-mapper") and set its id as a');
    console.log('  repository variable named D1_DATABASE_ID.');
    return null;
  }
}

/**
 * What to do about a bucket that could not be created.
 *
 * THE FIRST GUESS WAS THE WRONG ONE, and it cost a deploy. This used to lead
 * with "usually the API token", reasoning that R2 is newer than the token. It
 * reads plausibly and it was not what happened: the real first blocker was
 *
 *   code: 10042 -- Please enable R2 through the Cloudflare Dashboard
 *
 * an ACCOUNT-level switch, nothing to do with the token's permissions. Somebody
 * following the old advice would have gone and edited a token that was already
 * fine, found nothing to change, and had no next step.
 *
 * So the error is read rather than guessed at. Cloudflare says which of the two
 * it is, in those words, and this repeats them -- and when it says neither, both
 * are offered rather than one asserted.
 *
 * Separated out as a pure function so the wording can be checked against the
 * real messages without a Cloudflare account.
 */
export function bucketFailureHelp(why, bucketName) {
  const lines = [
    '',
    '  TRAINING IMAGES ARE OFF for this deploy. Everything else is',
    '  fine, and finished maps still record their outline -- only the',
    '  aerial photograph is skipped, and the frame re-fetches it.',
    '',
  ];

  /*
   * 10042 is the account-level "R2 has never been switched on here". The code
   * is matched as well as the words because the prose has changed before and
   * the code has not.
   */
  const notEnabled = /\b10042\b/.test(why) || /enable R2/i.test(why);
  /* 10000 covers authentication/authorisation on the Cloudflare API. */
  const notPermitted = /\b10000\b/.test(why)
    || /authenticat|authoriz|authoris|permission|forbidden|not allowed/i.test(why);

  const enableIt = [
    '  R2 IS NOT ENABLED ON THE ACCOUNT. That is an account-level',
    '  switch, not a token permission, and it is free to turn on:',
    '  Cloudflare dashboard -> R2 -> and accept the terms. Then deploy',
    '  again. (There is a free tier; a card may be asked for.)',
  ];
  const fixTheToken = [
    '  THE API TOKEN HAS NO R2 PERMISSION. R2 is newer than this',
    '  project, so a token made earlier carries Workers, KV and D1 and',
    '  not R2. Edit it at https://dash.cloudflare.com/profile/api-tokens,',
    '  add "Workers R2 Storage: Edit", and deploy again.',
  ];

  if (notEnabled) lines.push(...enableIt);
  else if (notPermitted) lines.push(...fixTheToken);
  else {
    lines.push('  Two things cause this, and the message above does not say');
    lines.push('  which. In the order they are worth checking:');
    lines.push('');
    lines.push(...enableIt);
    lines.push('');
    lines.push(...fixTheToken);
  }

  lines.push('');
  lines.push('  Or make the bucket by hand: Cloudflare dashboard -> R2 ->');
  lines.push(`  Create bucket, named "${bucketName}".`);
  return lines;
}

/**
 * The corpus bucket, or false.
 *
 * FALSE IS A REAL ANSWER, like a missing database. Finished lawn maps are kept
 * to train a detector on one day; that is worth having and it is not worth a
 * failed deploy. A token without R2 permission, or an account that has never
 * enabled R2, should still ship the site.
 *
 * Creating a bucket that already exists is an error rather than a no-op, so
 * this looks first -- and treats "already exists" as success anyway, because
 * two deploys racing is not a reason to fail either.
 */
function resolveBucket() {
  console.log(`Looking for the "${BUCKET_NAME}" R2 bucket…`);
  try {
    if (bucketExists(wrangler(['r2', 'bucket', 'list']), BUCKET_NAME)) {
      console.log('  found.');
      return true;
    }
  } catch (err) {
    console.log(`  could not list buckets (${firstLine(err)})`);
  }

  console.log('  none found; creating one…');
  try {
    wrangler(['r2', 'bucket', 'create', BUCKET_NAME]);
    console.log('  created.');
    return true;
  } catch (err) {
    const why = firstLine(err);
    if (/already exists/i.test(why)) {
      console.log('  already there (created by a parallel run).');
      return true;
    }
    console.log(`  could not create one (${why})`);
    for (const line of bucketFailureHelp(why, BUCKET_NAME)) console.log(line);
    return false;
  }
}

/**
 * Apply the schema.
 *
 * Every statement in it is IF NOT EXISTS, so this runs on every deploy and new
 * tables simply appear. A numbered-migration scheme buys ordering guarantees
 * this does not need yet and costs a step that has to be got right from a
 * phone.
 */
function migrate() {
  try {
    wrangler(['d1', 'execute', DB_NAME, '--remote', '--file=worker/schema.sql', '--yes']);
    console.log('  schema applied.');
    return true;
  } catch (err) {
    console.log(`  schema FAILED (${firstLine(err)})`);
    return false;
  }
}

/**
 * Split worker/migrations.sql into single statements.
 *
 * One at a time, because they are not collectively idempotent: SQLite has no
 * ADD COLUMN IF NOT EXISTS, so the second run of any of them is an error, and
 * a --file execution would abort at the first one and skip every ALTER after
 * it. Run separately, each can fail harmlessly on its own.
 *
 * The parsing is deliberately dumb -- strip line comments, split on
 * semicolons -- because the file is deliberately dumb: ALTER TABLE ADD COLUMN
 * and nothing else, which cannot contain a semicolon in a string literal or
 * any other thing that would need a real parser.
 */
/**
 * The site's own origin into the public pages' share and search tags
 * (public/index.html: canonical, og:url, og:image ...). Those need an absolute
 * address and only the deploy knows it. With no custom domain every line
 * carrying the placeholder is dropped, so no tag points at "__SITE__".
 * Touches the runner's copy only, like wrangler.toml above.
 */
export const SITE_PLACEHOLDER = '__SITE__';
export function fillSiteOrigin(html, customDomain) {
  if (!html.includes(SITE_PLACEHOLDER)) return html;
  if (customDomain) return html.split(SITE_PLACEHOLDER).join(`https://${customDomain}`);
  return html.split('\n').filter((l) => !l.includes(SITE_PLACEHOLDER)).join('\n');
}

/**
 * EVERY MAP'S NUMBER, for the maps made before numbers existed (owner,
 * 2026-10-04). A new map is numbered when the Worker first saves it (one more
 * than the highest); this gives the rest theirs, in the order they were made,
 * after the highest already given. Only ever fills a blank, so it is a no-op
 * once everything has one, and a number once given never changes.
 *
 * Returns the UPDATE statements for the rows `blank` (ids in order), or [].
 */
export function numberingStatements(blank, highest, batch = 60) {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const out = [];
  for (let i = 0; i < blank.length; i += batch) {
    const part = blank.slice(i, i + batch);
    const cases = part.map((id, k) => `WHEN ${q(id)} THEN ${highest + i + k + 1}`).join(' ');
    out.push(`UPDATE corpus SET lot_no = CASE id ${cases} END WHERE lot_no IS NULL AND id IN (${part.map(q).join(',')})`);
  }
  return out;
}

/** wrangler d1 execute --json's rows, tolerating banners round the JSON. */
export function parseQueryRows(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r?.results || []);
  } catch {
    return [];
  }
}

/* The benchmark's 32 keep their B names and have no C number. */
export const BENCHMARK_COHORT = 'benchmark-1rijjz2';

function numberMaps() {
  const read = (sql) => parseQueryRows(wrangler(['d1', 'execute', DB_NAME, '--remote', '--json', `--command=${sql}`]));
  const run = (sql) => wrangler(['d1', 'execute', DB_NAME, '--remote', `--command=${sql}`, '--yes']);
  try {
    /*
     * ONCE: the first numbering (2026-10-04, morning) numbered the benchmark
     * too, as "#N". The owner asked for C numbers for every map but the B
     * ones, so a benchmark row that still has a number means that scheme is
     * in place: clear every number and start again from C01. Never again
     * after that, because no benchmark row is numbered from then on.
     */
    const old = Number(read(`SELECT COUNT(*) AS n FROM corpus WHERE lot_no IS NOT NULL AND cohort = '${BENCHMARK_COHORT}'`)[0]?.n) || 0;
    if (old) {
      run('UPDATE corpus SET lot_no = NULL');
      console.log('  cleared the first numbering (it numbered the benchmark too) to give C numbers.');
    }
    const highest = Number(read('SELECT COALESCE(MAX(lot_no), 0) AS n FROM corpus')[0]?.n) || 0;
    const blank = read(`SELECT id FROM corpus WHERE lot_no IS NULL AND (cohort IS NULL OR cohort != '${BENCHMARK_COHORT}') ORDER BY created_at, id`).map((r) => r.id);
    for (const sql of numberingStatements(blank, highest)) run(sql);
    console.log(blank.length ? `  numbered ${blank.length} map(s), C${highest + 1} to C${highest + blank.length}.` : '  every map has its number.');
    return '';
  } catch (err) {
    console.log(`  numbering maps FAILED (${firstLine(err)})`);
    return `maps not numbered (${firstLine(err)})`;
  }
}

export function parseMigrations(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

/**
 * Did this statement fail because it had already been applied?
 *
 * The same rule as an R2 bucket that already exists: the state we wanted is
 * the state we have, so the error is the success. SQLite says "duplicate
 * column name: x" and that is the ONLY error treated this way -- a typo in a
 * table name, a missing table, a syntax error all still count as failures,
 * because a migration that never lands must not report that it did.
 */
export const alreadyApplied = (why) => /duplicate column name/i.test(String(why));

/**
 * Add columns to tables that already exist.
 *
 * Returns a short human summary, or null when there is nothing to do. A
 * genuine failure is returned as text rather than thrown: a column that will
 * not add should not take the whole site offline, but it must be SAID -- this
 * bug class is invisible precisely because everything reports success.
 */
function applyMigrations() {
  let statements;
  try {
    statements = parseMigrations(readFileSync(MIGRATIONS, 'utf8'));
  } catch {
    return null;                       // no migrations file is a fine state
  }
  if (!statements.length) return null;

  let added = 0;
  let already = 0;
  const failed = [];

  for (const sql of statements) {
    try {
      wrangler(['d1', 'execute', DB_NAME, '--remote', `--command=${sql}`, '--yes']);
      added++;
      console.log(`  + ${sql}`);
    } catch (err) {
      const why = firstLine(err);
      if (alreadyApplied(why)) { already++; continue; }
      failed.push(`${sql} (${why})`);
    }
  }

  for (const f of failed) console.log(`  FAILED ${f}`);
  const summary = `${added} added, ${already} already there`
    + (failed.length ? `, ${failed.length} FAILED` : '');
  console.log(`  ${summary}`);
  return { ok: failed.length === 0, summary };
}

/**
 * What the tool actually said, not just its first line.
 *
 * Wrangler's own first line for a permissions failure is "A request to the
 * Cloudflare API (/accounts/.../d1/database) failed." -- which names the
 * endpoint and not the reason. The reason is underneath, in the lines about
 * authentication, and cutting at the first newline threw away the only part
 * anybody could act on. The colour codes go too, or the message arrives in a
 * log as escape sequences.
 */
const firstLine = (err) => {
  const text = String(err.stderr || err.message || err);
  return text
    .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' | ')
    .slice(0, 400);
};

function main() {
  try {
    const kvId = resolveKvId();
    const dbId = resolveDbId();
    const bucket = resolveBucket();
    const customDomain = (process.env.CUSTOM_DOMAIN || '').trim() || null;

    const updated = applyConfig(
      readFileSync(CONFIG, 'utf8'), { kvId, dbId, bucket, customDomain }
    );
    writeFileSync(CONFIG, updated);

    const page = new URL('../public/index.html', import.meta.url);
    /* The landing's county table, from the registry this deploy ships with
       (tools/landing-coverage.js), so crawlers read today's list as text. */
    writeFileSync(page, fillCoverage(
      fillSiteOrigin(readFileSync(page, 'utf8'), customDomain), coverage()
    ));
    console.log(customDomain
      ? `Search and share tags point at https://${customDomain}.`
      : 'No CUSTOM_DOMAIN, so the canonical and share-image tags were left out.');

    /*
     * The schema runs AFTER the id is in the file, because wrangler resolves
     * the database from the config it is pointed at. Running it first finds
     * a placeholder and fails in a way that reads like a missing database.
     */
    let schema = false;
    let migrations = null;
    let numbering = '';
    let approved = NaN;
    if (dbId) {
      console.log('Applying the account schema…');
      schema = migrate();
      /*
       * AFTER the schema, and only if it applied. schema.sql creates whatever
       * is missing; migrations.sql adds columns to what was already there. A
       * table created a moment ago by the line above is already current, so
       * every ALTER against it reports "duplicate column name" and is counted
       * as done -- which is why the order is safe either way round for a fresh
       * database, and only correct in this order for an old one.
       */
      /*
       * RUN EVEN IF THE SCHEMA REPORTED A FAILURE, which it did not used to,
       * and that gate turned one bad statement into a dead feature.
       *
       * schema.sql is executed as one file, so a single failing statement
       * aborts the rest of it. Gating the migrations on that meant a schema
       * error ALSO skipped the ALTERs -- and the statement that failed was an
       * index over a column those very ALTERs would have added. Each migration
       * is run separately and reports its own outcome, so there is nothing to
       * protect by skipping them, and plenty to lose.
       */
      console.log('Adding any columns older databases are missing…');
      migrations = applyMigrations();
      console.log('Numbering maps that have no number yet…');
      numbering = numberMaps();
      try {
        approved = Number(parseQueryRows(wrangler(['d1', 'execute', DB_NAME, '--remote', '--json',
          "--command=SELECT COUNT(*) AS n FROM corpus WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL"]))[0]?.n);
      } catch { approved = NaN; }
    }

    console.log(`\nwrangler.toml prepared:`);
    console.log(`  KV namespace : ${kvId}`);
    console.log(`  D1 database  : ${dbId ? `${dbId}${schema ? '' : ' (schema NOT applied)'}` : '(none -- accounts are off)'}`);
    if (migrations) console.log(`  columns      : ${migrations.summary}`);
    console.log(`  R2 bucket    : ${bucket ? BUCKET_NAME : '(none -- training images are off)'}`);
    console.log(`  custom domain: ${customDomain || '(none -- will deploy to *.workers.dev)'}`);

    /*
     * Hand the bucket verdict forward so the last step of the deploy can say
     * it too.
     *
     * This summary is already printed, and it is still the wrong place to read
     * it from: the deploy log is about eighteen hundred lines, the secrets
     * step alone echoes hundreds, and this project is deployed and read on a
     * PHONE. Scrolling back through that to find out whether training images
     * are on is not a thing anybody will do, and "did the bucket attach?" then
     * goes unanswered indefinitely -- which is exactly what happened.
     *
     * GITHUB_ENV is only set inside Actions; locally this does nothing.
     */
    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV, `CORPUS_BUCKET=${bucket ? BUCKET_NAME : ''}\n`);
      /*
       * Only when something went wrong, because the end of the log is scarce
       * space and "3 already there" is not news. A failed column change is:
       * it is the difference between a feature that works and one that reports
       * itself switched off, and this whole file exists because that failure
       * was silent for six deploys.
       */
      const trouble = !schema ? 'the schema did not apply'
        : migrations && !migrations.ok ? migrations.summary : numbering;
      appendFileSync(process.env.GITHUB_ENV, `DB_TROUBLE=${trouble}\n`);
      /* The corpus's size, and any reminder it has reached (tools/milestones.js). */
      appendFileSync(process.env.GITHUB_ENV, `MAPS_APPROVED=${Number.isFinite(approved) ? approved : ''}\n`);
      appendFileSync(process.env.GITHUB_ENV, `MILESTONES=${milestonesReached(approved).map((m) => `${m.maps} maps: ${m.say}`).join(' | ')}\n`);
    }
  } catch (err) {
    console.error(`\nFAIL  ${firstLine(err)}\n`);
    console.error(
      'If this is a permissions problem, the Cloudflare API token needs both\n' +
      '"Workers Scripts: Edit" and "Workers KV Storage: Edit". The "Edit\n' +
      'Cloudflare Workers" template at\n' +
      '  https://dash.cloudflare.com/profile/api-tokens\n' +
      'includes both.\n\n' +
      'Alternatively create the namespace by hand (Storage & Databases -> KV ->\n' +
      'Create) and set its id as a repository variable named KV_NAMESPACE_ID.'
    );
    process.exit(1);
  }
}

// Only act when run as a command; the helpers above are imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
