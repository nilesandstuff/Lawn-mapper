/**
 * The route planner's storage, found or made (route session, 2026-10-26):
 *   KV "route-planner"  the shop's address and the first document  -> ROUTE_KV_ID
 *   D1 "route-planner"  the Mapbox meter (src/usage.js)             -> ROUTE_D1_ID
 * Run by .github/workflows/route-deploy.yml before the build; writes both to GITHUB_ENV.
 * WITHOUT THE D1 the Worker sends nothing to Mapbox (it cannot count it), so that one fails the deploy.
 * NO NAMESPACE IS A REAL ANSWER: the site still deploys and routes, without the Shop button or
 * the kept document (the Worker answers 503 there), and the log says so.
 *
 *   CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID node route/tools/kv.mjs
 */

import { appendFileSync } from 'node:fs';

export const TITLE = 'route-planner';

/** The account the token belongs to, when CLOUDFLARE_ACCOUNT_ID is not set (wrangler finds it the same way). */
export async function accountFor(fetcher, token) {
  const res = await (await fetcher('https://api.cloudflare.com/client/v4/accounts?per_page=5', { headers: { Authorization: `Bearer ${token}` } })).json();
  if (!res.success || !res.result?.length) throw new Error(res.errors?.[0]?.message || 'the token sees no account');
  return res.result[0].id;
}

export async function findOrMake(fetcher, account, token, title = TITLE) {
  if (!account) account = await accountFor(fetcher, token);
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (let page = 1; page <= 10; page += 1) {
    const res = await (await fetcher(`${base}?per_page=100&page=${page}`, { headers })).json();
    if (!res.success) throw new Error(res.errors?.[0]?.message || 'could not list namespaces');
    const hit = res.result.find((n) => n.title === title);
    if (hit) return { id: hit.id, made: false };
    if (res.result.length < 100) break;
  }
  const res = await (await fetcher(base, { method: 'POST', headers, body: JSON.stringify({ title }) })).json();
  if (!res.success) throw new Error(res.errors?.[0]?.message || 'could not make a namespace');
  return { id: res.result.id, made: true };
}

/** The D1 database by name, or a new one. */
export async function findOrMakeD1(fetcher, account, token, name = TITLE) {
  if (!account) account = await accountFor(fetcher, token);
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const list = await (await fetcher(`${base}?name=${encodeURIComponent(name)}&per_page=100`, { headers })).json();
  if (!list.success) throw new Error(list.errors?.[0]?.message || 'could not list databases');
  const hit = list.result.find((d) => d.name === name);
  if (hit) return { id: hit.uuid, made: false };
  const res = await (await fetcher(base, { method: 'POST', headers, body: JSON.stringify({ name }) })).json();
  if (!res.success) throw new Error(res.errors?.[0]?.message || 'could not make a database');
  return { id: res.result.uuid, made: true };
}

async function main() {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, GITHUB_ENV } = process.env;
  try {
    const { id, made } = await findOrMake(fetch, account, token);
    if (GITHUB_ENV) appendFileSync(GITHUB_ENV, `ROUTE_KV_ID=${id}\n`);
    console.log(`${made ? 'Made' : 'Found'} the "${TITLE}" KV namespace.`);
  } catch (err) {
    console.log(`No KV namespace (${err.message}): the site deploys without the Shop button or the kept document.`);
    if (GITHUB_ENV) appendFileSync(GITHUB_ENV, 'ROUTE_NOTE=no storage: no Shop button, no kept document\n');
  }
  try {
    const { id, made } = await findOrMakeD1(fetch, account, token);
    if (GITHUB_ENV) appendFileSync(GITHUB_ENV, `ROUTE_D1_ID=${id}\n`);
    console.log(`${made ? 'Made' : 'Found'} the "${TITLE}" D1 database (the Mapbox meter).`);
  } catch (err) {
    console.log(`No D1 database for the Mapbox meter (${err.message}). Without it nothing can be sent to Mapbox: not deploying.`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('kv.mjs')) main();
