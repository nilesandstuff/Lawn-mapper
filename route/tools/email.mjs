/**
 * Email Routing for the planner's inbox (route session, 2026-10-27): mail to
 * the address kept in KV ("inbox-address") goes to the route-planner Worker.
 * Run by the deploy after the Worker is up. The address is never printed: the
 * repository and its logs are public.
 *
 *   1. the zone of the address's domain
 *   2. Email Routing on for it (adds the MX and SPF records; the domain had
 *      none on 2026-10-27, so nothing is displaced)
 *   3. a rule: that address -> the Worker
 *
 * The deploy's token may not be allowed to do 2 or 3 (they need Email
 * Routing permissions, which the Workers token template does not carry).
 * Then it says so, the deploy still succeeds, and the setup is done once by
 * hand in the dashboard (route/README.md).
 *
 *   CLOUDFLARE_API_TOKEN [CLOUDFLARE_ACCOUNT_ID] ROUTE_KV_ID node route/tools/email.mjs
 */

import { appendFileSync } from 'node:fs';
import { accountFor } from './kv.mjs';

const API = 'https://api.cloudflare.com/client/v4';
export const WORKER = 'route-planner';

/** What happened, as one line, and whether mail now reaches the Worker. */
export async function setUpEmail(fetcher, { token, account, kvId }) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const get = async (path) => (await fetcher(`${API}${path}`, { headers }));
  const send = async (path, method, body) => (await fetcher(`${API}${path}`, { method, headers, body: JSON.stringify(body) })).json();
  const denied = (r) => r?.errors?.some((e) => e.code === 10000 || /auth|permission/i.test(e.message || ''));
  if (!kvId) return { ok: false, note: 'no storage, so no inbox address' };
  if (!account) account = await accountFor(fetcher, token);

  const a = await get(`/accounts/${account}/storage/kv/namespaces/${kvId}/values/inbox-address`);
  if (a.status === 404) return { ok: false, note: 'no inbox address set yet' };
  const address = (await a.text()).trim().toLowerCase();
  const domain = address.split('@')[1];
  if (!domain) return { ok: false, note: 'the inbox address is not an address' };

  const zones = await (await get(`/zones?name=${encodeURIComponent(domain)}`)).json();
  if (!zones.success || !zones.result?.length) return { ok: false, note: denied(zones) ? 'the token cannot see the domain\'s zone' : 'no Cloudflare zone for the inbox domain', manual: true };
  const zone = zones.result[0].id;

  const routing = await (await get(`/zones/${zone}/email/routing`)).json();
  if (!routing.success) return { ok: false, note: 'the deploy\'s token cannot manage Email Routing', manual: true };
  if (!routing.result?.enabled) {
    const on = await send(`/zones/${zone}/email/routing/dns`, 'POST', {});
    if (!on.success) return { ok: false, note: `Email Routing could not be switched on (${on.errors?.[0]?.message || 'refused'})`, manual: true };
  }

  const rules = await (await get(`/zones/${zone}/email/routing/rules?per_page=50`)).json();
  if (!rules.success) return { ok: false, note: 'the deploy\'s token cannot read Email Routing rules', manual: true };
  const mine = (rules.result || []).find((r) => r.matchers?.some((m) => m.type === 'literal' && m.field === 'to' && String(m.value).toLowerCase() === address));
  const action = (r) => r.actions?.some((x) => x.type === 'worker' && (x.value || []).includes(WORKER));
  if (mine && action(mine) && mine.enabled) return { ok: true, note: 'email inbox already routed to the planner' };
  const rule = {
    name: 'Route planner inbox', enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: address }],
    actions: [{ type: 'worker', value: [WORKER] }],
  };
  const made = mine
    ? await send(`/zones/${zone}/email/routing/rules/${mine.id || mine.tag}`, 'PUT', rule)
    : await send(`/zones/${zone}/email/routing/rules`, 'POST', rule);
  if (!made.success) return { ok: false, note: `the routing rule could not be made (${made.errors?.[0]?.message || 'refused'})`, manual: true };
  return { ok: true, note: 'email inbox routed to the planner' };
}

async function main() {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, ROUTE_KV_ID: kvId, GITHUB_ENV } = process.env;
  let r;
  try { r = await setUpEmail(fetch, { token, account, kvId }); } catch (e) { r = { ok: false, note: `could not check (${e.message})` }; }
  const line = r.ok ? `Email: ${r.note}.` : `Email: not set up -- ${r.note}.${r.manual ? ' One-time setup in the Cloudflare dashboard: see route/README.md.' : ''}`;
  console.log(line);
  if (GITHUB_ENV) appendFileSync(GITHUB_ENV, `ROUTE_EMAIL=${line}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('email.mjs')) main();
