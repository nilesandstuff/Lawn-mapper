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
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CONFIG = new URL('../wrangler.toml', import.meta.url);
const PLACEHOLDER = 'REPLACE_WITH_KV_NAMESPACE_ID';
const DB_PLACEHOLDER = 'REPLACE_WITH_D1_DATABASE_ID';
const DB_NAME = 'lawn-mapper';
const BUCKET_NAME = 'lawn-mapper-corpus';

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
    console.log('');
    console.log('  TRAINING IMAGES ARE OFF for this deploy. Everything else is');
    console.log('  fine, and finished maps still record their outline -- only the');
    console.log('  aerial photograph is skipped, and the frame re-fetches it.');
    console.log('');
    console.log('  Usually the API token: R2 is newer than this project, so a');
    console.log('  token made earlier carries Workers, KV and D1 and not R2. Edit');
    console.log('  it at https://dash.cloudflare.com/profile/api-tokens, add');
    console.log('  "Workers R2 Storage: Edit", and deploy again.');
    console.log('');
    console.log('  Or make it by hand: Cloudflare dashboard -> R2 -> Create');
    console.log(`  bucket, named "${BUCKET_NAME}".`);
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

    /*
     * The schema runs AFTER the id is in the file, because wrangler resolves
     * the database from the config it is pointed at. Running it first finds
     * a placeholder and fails in a way that reads like a missing database.
     */
    let schema = false;
    if (dbId) {
      console.log('Applying the account schema…');
      schema = migrate();
    }

    console.log(`\nwrangler.toml prepared:`);
    console.log(`  KV namespace : ${kvId}`);
    console.log(`  D1 database  : ${dbId ? `${dbId}${schema ? '' : ' (schema NOT applied)'}` : '(none -- accounts are off)'}`);
    console.log(`  R2 bucket    : ${bucket ? BUCKET_NAME : '(none -- training images are off)'}`);
    console.log(`  custom domain: ${customDomain || '(none -- will deploy to *.workers.dev)'}`);
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
