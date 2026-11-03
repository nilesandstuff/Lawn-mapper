/**
 * A walk's twin in and out of the scan site's R2 bucket, for workflow "S2. Yard AR splat" (core session). By the
 * Cloudflare API with the deploy's token, the same calls wrangler makes for `r2 object get/put`, but listed and
 * fetched many at a time.
 *
 *   node scan/tools/twin-r2.mjs get <walk> <dir>        every part of twins/<walk>/ into <dir>
 *   node scan/tools/twin-r2.mjs put <walk> <file>...    files to twins/<walk>/<their names>
 *
 * Prints counts and sizes only: a twin holds yard pictures and the repository is public.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const BUCKET = 'lawn-scan-twins';
const API = 'https://api.cloudflare.com/client/v4';

export const walkOk = (w) => /^[0-9a-zA-Z_-]{1,40}$/.test(w || '');
const TYPES = { json: 'application/json', jpg: 'image/jpeg', splat: 'application/octet-stream', bin: 'application/octet-stream' };

async function account(token) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const j = await (await fetch(`${API}/accounts?per_page=5`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const id = j.result?.[0]?.id;
  if (!id) throw new Error('no account for the token');
  return id;
}

async function list(base, token, prefix) {
  const out = [];
  let cursor = '';
  do {
    const j = await (await fetch(`${base}/objects?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    if (!j.success) throw new Error(`the list failed: ${JSON.stringify(j.errors || '').slice(0, 200)}`);
    out.push(...(j.result || []));
    cursor = j.result_info?.is_truncated ? j.result_info.cursor : '';
  } while (cursor);
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

async function main() {
  const [cmd, walk, ...rest] = process.argv.slice(2);
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('no CLOUDFLARE_API_TOKEN');
  if (!walkOk(walk)) throw new Error('which walk? (the number on its twin page)');
  const base = `${API}/accounts/${await account(token)}/r2/buckets/${BUCKET}`;
  if (cmd === 'get') {
    const dir = rest[0] || 'twin';
    mkdirSync(dir, { recursive: true });
    const objs = (await list(base, token, `twins/${walk}/`)).filter((o) => !/\/splat[.-]/.test(o.key));
    let bytes = 0, failed = 0;
    await pool(objs, 8, async (o) => {
      for (let t = 0; t < 3; t++) {
        const r = await fetch(`${base}/objects/${o.key.split('/').map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
        if (r?.ok) { const b = Buffer.from(await r.arrayBuffer()); writeFileSync(join(dir, basename(o.key)), b); bytes += b.length; return; }
      }
      failed++;
    });
    const pics = objs.filter((o) => /\/key-\d+\.jpg$/.test(o.key)).length;
    console.log(`Twin read: ${objs.length - failed} parts, ${(bytes / 1e6).toFixed(1)} MB, ${pics} pictures${failed ? `, ${failed} could not be read` : ''}.`);
    if (!objs.length) { console.log('No twin under that walk.'); process.exit(1); }
  } else if (cmd === 'put') {
    for (const f of rest) {
      const name = basename(f), body = readFileSync(f);
      const r = await fetch(`${base}/objects/twins/${encodeURIComponent(walk)}/${encodeURIComponent(name)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': TYPES[name.split('.').pop()] || 'application/octet-stream' }, body });
      console.log(`${name}: ${r.ok ? `kept (${(body.length / 1e6).toFixed(1)} MB)` : `NOT kept (${r.status})`}`);
      if (!r.ok) process.exitCode = 1;
    }
  } else throw new Error('get or put');
}

if (process.argv[1] && process.argv[1].endsWith('twin-r2.mjs')) main().catch((e) => { console.log(`Twin: ${e.message}`); process.exit(1); });
