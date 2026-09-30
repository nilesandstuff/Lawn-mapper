/**
 * HTTPS ONLY, for the custom domain (owner, 2026-09-30: "someone said there's
 * SSL errors on the site").
 *
 * The certificate is fine. What was not: http://<domain>/ served the whole
 * site unencrypted instead of sending people to https, so anybody arriving by
 * an http link, or typing the address without it, got a browser warning that
 * the page was "Not secure". The pages are static assets served before the
 * Worker runs, so the Worker cannot redirect them; Cloudflare's own zone
 * setting "Always Use HTTPS" does, for every request.
 *
 * Turned on here, on every deploy, rather than described in a README -- this
 * project has no terminal at the other end (CLAUDE.md). The deploy token may
 * not be allowed to change zone settings (the "Edit Cloudflare Workers"
 * template does not include it); then this says so, and exactly where the
 * one switch is, in HTTPS_STATE for the end of the log. It never fails the
 * deploy: the site works either way, this is about the warning.
 *
 *   CUSTOM_DOMAIN, CLOUDFLARE_API_TOKEN     node tools/https-only.js
 */

import { appendFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';

/** The zone a hostname lives in: the longest suffix Cloudflare knows. */
export function zoneCandidates(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join('.'));
  return out;
}

async function cf(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok && body?.success !== false, body };
}

const say = (state) => {
  console.log(`HTTPS: ${state}`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `HTTPS_STATE=${state}\n`);
};

async function main() {
  const host = (process.env.CUSTOM_DOMAIN || '').trim();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!host) return say('not checked -- no custom domain (workers.dev is always https)');
  if (!token) return say('not checked -- no Cloudflare token');

  const manual = 'turn it on at dash.cloudflare.com -> your domain -> SSL/TLS -> '
    + 'Edge Certificates -> "Always Use HTTPS" (or give the deploy token "Zone Settings: Edit")';

  let zone = null;
  for (const name of zoneCandidates(host)) {
    const r = await cf(`/zones?name=${encodeURIComponent(name)}`, token);
    if (r.ok && r.body?.result?.length) { zone = r.body.result[0]; break; }
  }
  if (!zone) return say(`could not look up the zone for ${host} with this token -- ${manual}`);

  const now = await cf(`/zones/${zone.id}/settings/always_use_https`, token);
  if (now.ok && now.body?.result?.value === 'on') return say('ON -- http:// redirects to https://');

  const set = await cf(`/zones/${zone.id}/settings/always_use_https`, token, {
    method: 'PATCH', body: JSON.stringify({ value: 'on' }),
  });
  if (set.ok) return say('turned ON just now -- http:// redirects to https://');
  return say(`OFF, and this token may not change it (HTTP ${set.status}) -- ${manual}`);
}

if (process.argv[1] && process.argv[1].endsWith('https-only.js')) {
  main().catch((e) => say(`not checked -- ${String(e?.message || e).slice(0, 160)}`));
}
