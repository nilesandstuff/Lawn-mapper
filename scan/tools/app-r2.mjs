/**
 * THE ANDROID APP'S FILES in the scan site's private bucket, for workflow "A. Android app" (core session,
 * 2026-11-07; android/README.md). Only keys under app/: the APK and version.json the site serves (scan/src/app.js)
 * and the signing key, which is never served.
 *
 *   node scan/tools/app-r2.mjs domain                  the scan site's host from CUSTOM_DOMAIN, into GITHUB_ENV as SCAN_DOMAIN
 *   node scan/tools/app-r2.mjs get <key> <file>        exit 2 when there is no such object
 *   node scan/tools/app-r2.mjs put <key> <file> [type]
 *
 * Prints sizes only.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { BUCKET } from './twin-r2.mjs';
import { scanDomainFor } from './prepare.mjs';

const API = 'https://api.cloudflare.com/client/v4';

export const appKeyOk = (k) => /^app\/[A-Za-z0-9._-]{1,80}$/.test(k || '');

async function base() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('no CLOUDFLARE_API_TOKEN');
  let id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id) id = (await (await fetch(`${API}/accounts?per_page=5`, { headers: { Authorization: `Bearer ${token}` } })).json()).result?.[0]?.id;
  if (!id) throw new Error('no account for the token');
  return { url: `${API}/accounts/${id}/r2/buckets/${BUCKET}/objects`, token };
}

async function main() {
  const [cmd, key, file, type] = process.argv.slice(2);
  if (cmd === 'domain') {
    const d = scanDomainFor(process.env.CUSTOM_DOMAIN);
    if (!d) throw new Error('CUSTOM_DOMAIN is not a subdomain');
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `SCAN_DOMAIN=${d}\n`);
    console.log('Scan site host: set.');
    return;
  }
  if (!appKeyOk(key)) throw new Error('keys live under app/');
  const { url, token } = await base();
  const at = `${url}/${key.split('/').map(encodeURIComponent).join('/')}`;
  if (cmd === 'get') {
    const r = await fetch(at, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) { console.log(`${key}: not there`); process.exit(2); }
    if (!r.ok) throw new Error(`${key}: read failed (${r.status})`);
    const b = Buffer.from(await r.arrayBuffer());
    writeFileSync(file, b);
    console.log(`${key}: read (${(b.length / 1e6).toFixed(2)} MB)`);
  } else if (cmd === 'put') {
    const body = readFileSync(file);
    const r = await fetch(at, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type || 'application/octet-stream' }, body });
    if (!r.ok) throw new Error(`${key}: NOT kept (${r.status})`);
    console.log(`${key}: kept (${(body.length / 1e6).toFixed(2)} MB)`);
  } else throw new Error('domain, get or put');
}

if (process.argv[1] && process.argv[1].endsWith('app-r2.mjs')) main().catch((e) => { console.log(`App files: ${e.message}`); process.exit(1); });
