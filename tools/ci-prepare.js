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
 *   CUSTOM_DOMAIN         optional, e.g. lawnanswers.online
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CONFIG = new URL('../wrangler.toml', import.meta.url);
const PLACEHOLDER = 'REPLACE_WITH_KV_NAMESPACE_ID';

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

/** Substitute the KV id and, if asked, append a custom-domain route. */
export function applyConfig(toml, { kvId, customDomain } = {}) {
  let out = toml;

  if (kvId) out = out.split(PLACEHOLDER).join(kvId);

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

const firstLine = (err) =>
  String(err.stderr || err.message || err).trim().split('\n')[0].slice(0, 160);

function main() {
  try {
    const kvId = resolveKvId();
    const customDomain = (process.env.CUSTOM_DOMAIN || '').trim() || null;

    const updated = applyConfig(readFileSync(CONFIG, 'utf8'), { kvId, customDomain });
    writeFileSync(CONFIG, updated);

    console.log(`\nwrangler.toml prepared:`);
    console.log(`  KV namespace : ${kvId}`);
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
