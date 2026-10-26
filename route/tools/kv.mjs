/**
 * The route planner's KV namespace, "route-planner": found, or made (route session, 2026-10-26).
 * Run by .github/workflows/route-deploy.yml before the build; writes ROUTE_KV_ID to GITHUB_ENV.
 * NO NAMESPACE IS A REAL ANSWER: the site still deploys and routes, without the Shop button or
 * the kept document (the Worker answers 503 there), and the log says so.
 *
 *   CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID node route/tools/kv.mjs
 */

import { appendFileSync } from 'node:fs';

export const TITLE = 'route-planner';

export async function findOrMake(fetcher, account, token, title = TITLE) {
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
}

if (process.argv[1] && process.argv[1].endsWith('kv.mjs')) main();
