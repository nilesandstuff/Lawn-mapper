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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const BUCKET = 'lawn-scan-twins';
export const API = 'https://api.cloudflare.com/client/v4';

export const walkOk = (w) => /^[0-9a-zA-Z_-]{1,40}$/.test(w || '');
const TYPES = { json: 'application/json', jpg: 'image/jpeg', splat: 'application/octet-stream', bin: 'application/octet-stream', png: 'image/png', npz: 'application/octet-stream' };

export async function account(token) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const j = await (await fetch(`${API}/accounts?per_page=5`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const id = j.result?.[0]?.id;
  if (!id) throw new Error('no account for the token');
  return id;
}

export async function list(base, token, prefix) {
  const out = [];
  let cursor = '';
  do {
    // the listing is asked again when the API refuses it or answers with nothing: two runs reading one large walk at
    // once met the rate limit, and the second died here on an empty answer (run 475, 2026-11-21)
    let j = null;
    for (let t = 0; t < 8 && !j; t++) {
      if (t) await new Promise((ok) => setTimeout(ok, Math.min(60000, 4000 * 2 ** (t - 1))));
      const r = await fetch(`${base}/objects?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
      j = r?.ok ? await r.json().catch(() => null) : null;
    }
    if (!j) throw new Error('the bucket would not list its parts (asked eight times)');
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

/** One object written to a bucket (the map's reference walk: scan/tools/reference-build.mjs). */
export async function writeObject(bucket, key, bytes, type = 'application/octet-stream', meta = null) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('no CLOUDFLARE_API_TOKEN');
  const base = `${API}/accounts/${await account(token)}/r2/buckets/${bucket}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': type };
  if (meta) for (const [k, v] of Object.entries(meta)) headers[`cf-r2-custom-metadata-${k}`] = String(v);
  for (let t = 0; t < 4; t++) {
    const r = await fetch(`${base}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', headers, body: bytes }).catch(() => null);
    if (r?.ok) return true;
    await new Promise((ok) => setTimeout(ok, 2000 * 2 ** t));
  }
  throw new Error(`the object could not be written to ${bucket}`);
}

/** One object taken out of a bucket (gone already is fine). */
export async function deleteObject(bucket, key) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('no CLOUDFLARE_API_TOKEN');
  const base = `${API}/accounts/${await account(token)}/r2/buckets/${bucket}`;
  const r = await fetch(`${base}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  return !!(r && (r.ok || r.status === 404));
}

/** One object's bytes from a bucket (the main site's models among them), or null when it is not there. */
export const CORPUS_BUCKET = 'lawn-mapper-corpus';
export async function readObject(bucket, key) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('no CLOUDFLARE_API_TOKEN');
  const base = `${API}/accounts/${await account(token)}/r2/buckets/${bucket}`;
  for (let t = 0; t < 3; t++) {
    const r = await fetch(`${base}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (r?.status === 404) return null;
    if (r?.ok) return Buffer.from(await r.arrayBuffer());
  }
  throw new Error(`the object could not be read from ${bucket}`);
}

async function main() {
  let [cmd, walk, ...rest] = process.argv.slice(2);
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('no CLOUDFLARE_API_TOKEN');
  const base = `${API}/accounts/${await account(token)}/r2/buckets/${BUCKET}`;
  // "refs": which maps have a reference walk kept (the owner, 2026-11-15: "Have any walks been saved as references???").
  // Dates and sizes only: a map's id is a place, and this is printed in a public log.
  if (cmd === 'refs') {
    const all = await list(base, token, 'refs/');
    const now = all.filter((o) => !o.key.startsWith('refs/backup/')), old = all.filter((o) => o.key.startsWith('refs/backup/'));
    console.log(`\nReference walks kept: ${now.length} map${now.length === 1 ? '' : 's'} have one (${old.length} replaced earlier ones kept as backups).`);
    now.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified)).forEach((o, i) => console.log(`  map ${i + 1}: saved ${new Date(o.last_modified).toISOString()}, ${(o.size / 1e6).toFixed(1)} MB`));
    return;
  }
  // "thermal-index": every walk with a thermal placement filed under its map (2026-11-16: the site's old map rule
  // refused the owner's home map's id, so its walk was converted but never filed and the water site saw none). The
  // key holds the id encoded (scan/src/thermal.js mapKey). Counts only: a map's id is a place, and this log is public.
  // HOW MUCH THE BUCKET HOLDS, WALK BY WALK (2026-11-20; the owner: the full recordings are "probably over 5 GB... and
  // we've never actually used them"). Sizes and counts only.
  if (cmd === 'sizes') {
    const by = new Map();
    let other = 0;
    for (const o of await list(base, token, '')) {
      const m = /^twins\/([^/]+)\/(.+)$/.exec(o.key);
      if (!m) { other += o.size || 0; continue; }
      const w = by.get(m[1]) || { all: 0, rec: 0, pics: 0, thermal: 0, n: 0 };
      w.all += o.size || 0; w.n++;
      if (/^recording\./.test(m[2])) w.rec += o.size || 0;
      else if (/^key-\d+\.jpg$/.test(m[2])) w.pics++;
      else if (/^thermal/.test(m[2])) w.thermal += o.size || 0;
      by.set(m[1], w);
    }
    const mb = (b) => (b / 1e6).toFixed(0), rows = [...by.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    const tot = rows.reduce((a, [, w]) => a + w.all, 0), rec = rows.reduce((a, [, w]) => a + w.rec, 0);
    console.log(`\nTHE TWIN BUCKET: ${rows.length} walks, ${(tot / 1e9).toFixed(2)} GB; of that the full recordings ${(rec / 1e9).toFixed(2)} GB in ${rows.filter(([, w]) => w.rec).length} walks; everything outside the walks ${mb(other)} MB.`);
    for (const [id, w] of rows) console.log(`  ${/^\d{13}$/.test(id) ? new Date(Number(id)).toISOString().slice(0, 16) : 'undated'}  walk ${id}: ${mb(w.all)} MB (${w.n} parts, ${w.pics} photos)${w.rec ? `, recording ${mb(w.rec)} MB` : ''}${w.thermal ? `, thermal ${mb(w.thermal)} MB` : ''}`);
    return;
  }
  // THE OLD FULL RECORDINGS DELETED (the owner, 2026-11-20: "Yes delete the old full recordings"; 4 GB in 17 walks, never
  // opened, all made with Geospatial Depth on). Only twins/<walk>/recording.*, only walks begun before BEFORE (a date),
  // listed before anything goes, and nothing goes if the list is longer than MOST. Sizes and dates only.
  if (cmd === 'prune-recordings') {
    const before = Date.parse(process.env.BEFORE || ''), most = Number(process.env.MOST || 0);
    if (!Number.isFinite(before) || !most) throw new Error('BEFORE (a date) and MOST (how many at most) are needed');
    const all = (await list(base, token, 'twins/')).filter((o) => /^twins\/\d{13}\/recording\.[a-z0-9]+$/.test(o.key));
    const go = all.filter((o) => Number(o.key.split('/')[1]) < before), stay = all.filter((o) => !go.includes(o));
    const gb = (a) => (a.reduce((x, o) => x + (o.size || 0), 0) / 1e9).toFixed(2);
    console.log(`\nFull recordings: ${all.length} kept in the bucket (${gb(all)} GB). Begun before ${new Date(before).toISOString().slice(0, 10)}: ${go.length} (${gb(go)} GB); from then on: ${stay.length} (${gb(stay)} GB), which stay.`);
    for (const o of go) console.log(`  to go: ${new Date(Number(o.key.split('/')[1])).toISOString().slice(0, 16)}  ${((o.size || 0) / 1e6).toFixed(0)} MB`);
    for (const o of stay) console.log(`  stays: ${new Date(Number(o.key.split('/')[1])).toISOString().slice(0, 16)}  ${((o.size || 0) / 1e6).toFixed(0)} MB`);
    if (go.length > most) { console.log(`That is more than the ${most} expected: NOTHING deleted.`); process.exit(1); }
    if (process.env.CONFIRM !== 'delete') { console.log('Listed only (no CONFIRM=delete): nothing deleted.'); return; }
    let done = 0, failed = 0;
    for (const o of go) {
      const r = await fetch(`${base}/objects/${o.key.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
      if (r?.ok) done++; else { failed++; console.log(`  NOT deleted (${r?.status || 'no answer'}): the recording of ${new Date(Number(o.key.split('/')[1])).toISOString().slice(0, 16)}`); }
    }
    const left = (await list(base, token, 'twins/')).filter((o) => /^twins\/\d{13}\/recording\.[a-z0-9]+$/.test(o.key));
    console.log(`Deleted ${done} recordings${failed ? `, ${failed} could NOT be deleted` : ''}. Full recordings now in the bucket: ${left.length} (${gb(left)} GB).`);
    if (failed) process.exitCode = 1;
    return;
  }
  if (cmd === 'thermal-index') {
    const placed = (await list(base, token, 'twins/')).filter((o) => /^twins\/[^/]+\/thermal-placement\.json$/.test(o.key));
    const have = new Set((await list(base, token, 'thermal-index/')).map((o) => o.key));
    let filed = 0, already = 0, bad = 0;
    for (const o of placed) {
      const w = o.key.split('/')[1];
      let p = null; try { p = JSON.parse(Buffer.from(await readObject(BUCKET, o.key)).toString('utf8')); } catch { p = null; }
      const map = p?.map;
      if (typeof map !== 'string' || !/^[^\x00-\x1f\x7f/]{1,256}$/.test(map) || !walkOk(w)) { bad++; continue; }
      const key = `thermal-index/${encodeURIComponent(map)}/${w}`;
      if (have.has(key)) { already++; continue; }
      const origin = Array.isArray(p.origin) && p.origin.length === 2 && p.origin.every(Number.isFinite) ? p.origin : null;
      await writeObject(BUCKET, key, Buffer.from(JSON.stringify({ walk: w, map, origin, at: Date.now() })), 'application/json');
      filed++;
    }
    console.log(`\nThermal walks filed under their maps: ${placed.length} walks with a placement; ${filed} filed now, ${already} already filed, ${bad} unreadable.`);
    return;
  }
  // "latest": the walk whose twin was written to last (so nobody copies an id off a phone)
  if (walk === 'latest') {
    const all = await list(base, token, 'twins/');
    const newest = all.filter((o) => /\/live\.json$/.test(o.key)).sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified))[0];
    if (!newest) throw new Error('no twins yet');
    walk = newest.key.split('/')[1];
    console.log(`The latest walk: ${walk}`);
  }
  if (!walkOk(walk)) throw new Error('which walk? (the number on its twin page)');
  // the later steps of workflow S2 use the walk as found here
  // "parts <walk> <dir> <name>...": only the named parts of a twin (a study that needs two files does not read 4,000)
  if (cmd === 'parts') {
    if (!walkOk(walk)) throw new Error('which walk?');
    const [dir, ...names] = rest;
    mkdirSync(dir, { recursive: true });
    let got = 0, bytes = 0;
    // a name ending in * is every part beginning so ("cloud-*": the walk's own points), found by listing
    const all = [];
    for (const n of names) {
      if (n.endsWith('*')) all.push(...(await list(base, token, `twins/${walk}/${n.slice(0, -1)}`)).map((o) => basename(o.key)));
      else all.push(n);
    }
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < all.length) {
        const n = all[i++];
        let b = null;
        for (let t = 0; t < 5 && !b; t++) { if (t) await new Promise((ok) => setTimeout(ok, 3000 * 2 ** t)); b = await readObject(BUCKET, `twins/${walk}/${n}`).catch(() => undefined); if (b === null) break; }
        if (b) { writeFileSync(join(dir, n), b); got++; bytes += b.length; }
      }
    }));
    console.log(`Twin parts read: ${got} of ${all.length}, ${(bytes / 1e6).toFixed(1)} MB.`);
    if (!got) throw new Error('none of the parts asked for is there');
    return;
  }
  if (cmd === 'get' && process.env.GITHUB_ENV) (await import('node:fs')).appendFileSync(process.env.GITHUB_ENV, `WALK=${walk}\n`);
  if (cmd === 'get') {
    const dir = rest[0] || 'twin';
    mkdirSync(dir, { recursive: true });
    const objs = (await list(base, token, `twins/${walk}/`)).filter((o) => !/\/splat[.-]/.test(o.key) && !(!process.env.WITH_SEGMENTS && /\/segments-/.test(o.key)) && !/\/study-/.test(o.key) && !/\/seg-\d+\.png$/.test(o.key) && !/\/segments-[a-z-]+\.(png|jpg)$/.test(o.key) && !/\/recording\.mp4$/.test(o.key) && !(process.env.NO_PICTURES && /\/key-\d+\.jpg$/.test(o.key)));
    let bytes = 0, failed = 0;
    const why = {};
    // backs off on a refusal: four place runs at once (8 requests each, retried at once) lost 218 of 566 parts to
    // the API's rate limit on 2026-11-08
    // a walk of 2,500 parts met the API's rate limit even so (21 parts refused seven times each, 2026-11-21, and the
    // 3D view was then made from a walk with a part missing): fewer at once, more tries, a longer wait on a 429
    let wait429 = 0;
    await pool(objs, 4, async (o) => {
      let last = 'no answer';
      for (let t = 0; t < 12; t++) {
        if (t) await new Promise((ok) => setTimeout(ok, (last === '429' ? Math.min(90000, 5000 * 2 ** Math.min(t - 1, 4)) : Math.min(30000, 1000 * 2 ** (t - 1))) * (0.75 + Math.random() / 2)));
        if (last === '429') wait429++;
        const r = await fetch(`${base}/objects/${o.key.split('/').map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
        const b = r?.ok ? await r.arrayBuffer().then((x) => Buffer.from(x), () => null) : null;
        if (b) { writeFileSync(join(dir, basename(o.key)), b); bytes += b.length; return; }
        last = r ? (r.ok ? 'cut off' : String(r.status)) : 'no answer';
        if (r?.status === 404) break;
      }
      failed++; why[last] = (why[last] || 0) + 1;
    });
    const pics = objs.filter((o) => /\/key-\d+\.jpg$/.test(o.key)).length;
    console.log(`Twin read: ${objs.length - failed} parts, ${(bytes / 1e6).toFixed(1)} MB, ${pics} pictures${failed ? `, ${failed} could not be read (${Object.entries(why).map(([k, n]) => `${n} x ${k}`).join(', ')})` : ''}.`);
    if (!existsSync(join(dir, 'meta.json')) && objs.some((o) => /\/meta\.json$/.test(o.key))) { console.log('The twin\'s meta.json could not be read: run it again.'); process.exit(1); }
    if (!objs.length) { console.log('No twin under that walk.'); process.exit(1); }
    // STRICT: a step that MAKES something from the whole walk (the 3D view's files, the classes) must not run on a
    // walk with parts missing
    if (process.env.STRICT && failed) { console.log(`STRICT: ${failed} parts could not be read: nothing is made from a walk with parts missing. Run it again.`); process.exit(1); }
  } else if (cmd === 'put') {
    for (const f of rest) {
      if (!existsSync(f)) continue; // a pattern that matched nothing (twin/study-*)
      const name = basename(f), body = readFileSync(f);
      // tried again on a refusal: one 5xx among 267 parts failed two naming runs on 2026-11-19
      let r = null;
      for (let t = 0; t < 5 && !r?.ok; t++) {
        if (t) await new Promise((ok) => setTimeout(ok, 1500 * 2 ** (t - 1)));
        r = await fetch(`${base}/objects/twins/${encodeURIComponent(walk)}/${encodeURIComponent(name)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': TYPES[name.split('.').pop()] || 'application/octet-stream' }, body }).catch(() => null);
      }
      console.log(`${name}: ${r?.ok ? `kept (${(body.length / 1e6).toFixed(1)} MB)` : `NOT kept (${r?.status || 'no answer'})`}`);
      if (!r?.ok) process.exitCode = 1;
    }
  } else throw new Error('get or put');
}

if (process.argv[1] && process.argv[1].endsWith('twin-r2.mjs')) main().catch((e) => { console.log(`Twin: ${e.message}`); process.exit(1); });
