/**
 * Route Reader's signing key (route session, 2026-11-19): the same key for
 * every build, so a new version installs over the old one. Kept in the route
 * planner's KV ("android-keystore", "android-keystore-pass"), never in the
 * repository; made the first time (keytool) and kept. Writes the keystore to
 * a file and RR_KEYSTORE / RR_KEYSTORE_PASS to GITHUB_ENV, the password masked
 * in the log.
 *
 *   CLOUDFLARE_API_TOKEN [CLOUDFLARE_ACCOUNT_ID] ROUTE_KV_ID OUT=path node route/tools/apk-key.mjs
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { accountFor } from './kv.mjs';

export async function keystore(fetcher, { token, account, kvId, out, make }) {
  if (!account) account = await accountFor(fetcher, token);
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${kvId}/values`;
  const auth = { Authorization: `Bearer ${token}` };
  const get = async (k) => { const r = await fetcher(`${base}/${k}`, { headers: auth }); return r.ok ? (await r.text()).trim() : null; };
  const put = async (k, v) => {
    const r = await fetcher(`${base}/${k}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/plain' }, body: v });
    if (!r.ok) throw new Error(`could not keep ${k} (${r.status})`);
  };
  let b64 = await get('android-keystore');
  let pass = await get('android-keystore-pass');
  let made = false;
  if (!b64 || !pass) {
    pass = randomBytes(18).toString('base64url');
    make(out, pass);
    b64 = readFileSync(out).toString('base64');
    await put('android-keystore-pass', pass);
    await put('android-keystore', b64);
    made = true;
  } else writeFileSync(out, Buffer.from(b64, 'base64'));
  return { pass, made };
}

function keytool(out, pass) {
  if (existsSync(out)) rmSync(out);
  execFileSync('keytool', ['-genkeypair', '-keystore', out, '-storetype', 'PKCS12', '-alias', 'routereader', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '10000', '-storepass', pass, '-keypass', pass, '-dname', 'CN=Route Reader'], { stdio: 'ignore' });
}

async function main() {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, ROUTE_KV_ID: kvId, OUT: out, GITHUB_ENV } = process.env;
  if (!kvId || !out) { console.log('No storage: Route Reader will not be signed, so it is not built.'); process.exit(1); }
  const { pass, made } = await keystore(fetch, { token, account, kvId, out, make: keytool });
  console.log(`::add-mask::${pass}`);
  if (GITHUB_ENV) appendFileSync(GITHUB_ENV, `RR_KEYSTORE=${out}\nRR_KEYSTORE_PASS=${pass}\n`);
  console.log(made ? 'Made Route Reader a signing key and kept it.' : 'Signing with the kept Route Reader key.');
}

if (process.argv[1] && process.argv[1].endsWith('apk-key.mjs')) main().catch((e) => { console.log(`No signing key: ${e.message}`); process.exit(1); });
