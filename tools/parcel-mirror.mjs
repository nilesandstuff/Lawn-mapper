/**
 * FILL THE PARCEL COPY (core session, 2026-11-09; worker/src/parcel-mirror.js has the why and the format). Workflow
 * "P2. Parcel mirror" runs this on a schedule: every county service in the registry is copied in squares of TILE
 * degrees, the stalest first, within a time budget, and picked up where it stopped by the next run. A service is
 * copied again once its copy is MAX_AGE_DAYS old.
 *
 * Politely: one request at a time to a county's server (two where a host serves many), the layer's own page size, and
 * a pause between pages. Every parcel is asked for by object id (returnIdsOnly over the square, then the ids in
 * pages), which every ArcGIS server can answer, paginating or not.
 *
 * Writes into the CORPUS bucket by the Cloudflare API (the deploy's token), under the API's rate limit with room to
 * spare for a deploy running at the same time:
 *   parcels/<key>/<cx>_<cy>.bin    the cells
 *   parcels/_state.json            which squares of which service are copied, when, and why one failed
 *   parcels/_summary.json          the totals, for the console
 * The log prints totals only (squares, parcels, bytes, failures by kind): no county, no place, no coordinate.
 *
 *   CLOUDFLARE_API_TOKEN=... node tools/parcel-mirror.mjs                 # the scheduled run
 *   OUT=dir ONLY=key1,key2 node tools/parcel-mirror.mjs                    # to files, for a test; no bucket
 */
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync, createWriteStream, createReadStream, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ALL_COUNTIES, COUNTY_BBOX } from '../worker/src/counties.js';
import { VERIFIED_COUNTIES } from '../worker/src/counties-verified.js';
import { endpointsFor } from '../worker/src/parcel.js';
import { CELL, cellOf, encodeParcel, encodeCell, mirrorKeys, PREFIX } from '../worker/src/parcel-mirror.js';
import { tidyAttributes, clipRing, clipLine } from '../worker/src/water-layers.js';
import { waterIdOf, WATER_PREFIX } from '../worker/src/water-copy.js';

export const TILE = 0.5;                       // degrees: 10 x 10 cells
const PER = Math.round(TILE / CELL);
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 30);
const RETRY_FAILED_DAYS = 3;
export const FALLBACKS_AT = '2026-11-18T05:40:00Z';   // smaller squares, pages by count, halved pages, the wider file search, the whole layer by ids (every endpoint), pages without the number, waiting out a 429
const BUDGET_MS = Math.min(320, Number(process.env.BUDGET_MIN) || 320) * 60e3;
const HARD_MS = BUDGET_MS + 25 * 60e3;         // squares still going then are dropped, not half-written
const SERVICES_AT_ONCE = Number(process.env.AT_ONCE || 8);
const PER_HOST = 2;
const PAGE_MAX = 1000;
const PAUSE_MS = 250;                          // between one page and the next on the same server
const TIMEOUT_MS = 90e3;
const API_PER_SEC = 2;                         // R2 writes: the API allows 4 a second for everything on the account
const BUCKET = 'lawn-mapper-corpus';
const API = 'https://api.cloudflare.com/client/v4';
const UA = 'lawn-mapper-parcel-mirror (non-commercial; one request at a time)';

const t0 = Date.now();
const elapsed = () => Date.now() - t0;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/* ------------------------------------------------------------ where things go */
let r2base = null, token = null;
const OUT = process.env.OUT || null;
async function r2init() {
  if (OUT) return;
  token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('no CLOUDFLARE_API_TOKEN (or set OUT for a test to files)');
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const j = await (await fetch(`${API}/accounts?per_page=5`, { headers: { Authorization: `Bearer ${token}` } })).json();
    account = j.result?.[0]?.id;
    if (!account) throw new Error('no account for the token');
  }
  r2base = `${API}/accounts/${account}/r2/buckets/${BUCKET}/objects/`;
}
// the API's pace: API_PER_SEC calls a second, shared by every write and delete of the run
let nextSlot = 0;
async function apiSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / API_PER_SEC;
  if (at > now) await sleep(at - now);
}
const objUrl = (key) => r2base + key.split('/').map(encodeURIComponent).join('/');
async function api(method, key, body = undefined, type = 'application/octet-stream') {
  for (let t = 0; t < 6; t++) {
    if (t) await sleep(Math.min(60e3, 2000 * 2 ** t) * (0.75 + Math.random() / 2));
    await apiSlot();
    const r = await fetch(objUrl(key), { method, body, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': type } : {}) } }).catch(() => null);
    if (r && (r.ok || (method !== 'PUT' && r.status === 404))) return r;
    if (r && r.status < 500 && r.status !== 429) throw new Error(`the bucket answered ${r.status}`);
  }
  throw new Error('the bucket did not answer');
}
async function put(key, bytes, type) {
  if (OUT) { const f = join(OUT, key); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, bytes); return; }
  await api('PUT', key, bytes, type);
}
async function del(key) {
  if (OUT) return;
  await api('DELETE', key);
}
async function getJson(key) {
  if (OUT) { const f = join(OUT, key); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; }
  const r = await api('GET', key);
  if (r.status === 404) return null;
  try { return await r.json(); } catch { return null; }
}

/* ---------------------------------------------------------- the county's server */
const hosts = new Map();
async function hostTurn(url, fn) {
  const h = new URL(url).host;
  if (!hosts.has(h)) hosts.set(h, { busy: 0, queue: [] });
  const s = hosts.get(h);
  while (s.busy >= PER_HOST) await new Promise((ok) => s.queue.push(ok));
  s.busy++;
  try { return await fn(); } finally {
    await sleep(PAUSE_MS);
    s.busy--;
    s.queue.shift()?.();
  }
}
export class Refused extends Error {}
async function ask(url, params, { post = false, tries = 3, timeoutMs = TIMEOUT_MS } = {}) {
  return hostTurn(url, async () => {
    let last = null;
    for (let t = 0; t < tries; t++) {
      if (t) await sleep(3000 * 2 ** t);
      try {
        const body = new URLSearchParams({ f: 'json', ...params });
        const r = post
          ? await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
          : await fetch(`${url}?${body}`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
        // an answer that is not used is still read to its end: left half read, Node's fetch (undici) can fail an
        // assertion when the server closes the socket, and that ends the whole run (the probe of 2026-11-17)
        if (!r.ok) { last = `http ${r.status}`; await r.arrayBuffer().catch(() => {}); if (r.status === 403 || r.status === 401) throw new Refused(last); if (r.status < 500 && r.status !== 429) break; continue; }
        const text = await r.text();
        let j;
        try { j = JSON.parse(text); } catch { last = 'not JSON'; continue; }
        if (j.error) {
          const code = Number(j.error.code);
          if (code === 499 || code === 498 || code === 403 || /token/i.test(j.error.message || '')) throw new Refused(`refused ${code}`);
          last = `error ${j.error.code ?? ''}`.trim();
          // too many requests, said in the answer rather than the status (2026-11-18: one county's server): waited
          // out and asked again, as an http 429 is
          if (code === 429) { await sleep(10000); continue; }
          return { error: last };
        }
        return j;
      } catch (e) {
        if (e instanceof Refused) throw e;
        last = e?.name === 'TimeoutError' ? 'timeout' : 'unreachable';
      }
    }
    return { error: last || 'no answer' };
  });
}

/*
 * WHAT STILL FAILED AFTER A WEEK (the report of 2026-11-16; the owner: "use your best judgement"). Of 49 services:
 *   - the square's ids not given (error 500 x9, error 400 x8, timeouts, ArcGIS's -2147467259): most such servers can
 *     list a smaller square. ArcGIS answers "400 Unable to complete operation" as readily as a 500 to a query too big
 *     for it. So the square is asked for in quarters, down to SPLIT_DEPTH (0.5 degrees to about 7 km); a quarter that
 *     still fails ends it, so a server that is simply down costs four tries, not 85.
 *   - still no ids: the parcels in pages by count (resultOffset), which needs no list of ids at all.
 *   - a page failed (http 404 x8: a long list of ids in the address, which IIS answers 404; error 500, error 400): the
 *     page by the other method (POST for GET), then in halves, down to PAGE_MIN.
 * A service that has moved (404 on the ids) is the registry's: its nightly search finds the new address
 * (tools/verify-counties.js movedOnServer) and the next try here uses it.
 */
export const SPLIT_DEPTH = 3;
export const PAGE_MIN = 25;
/** An error a smaller question may get past: not a service gone, refused, or unreachable. */
export const splittable = (why) => !/http 40[1346]|error 40[1346]\b|unreachable|refused|skip/i.test(String(why || '')) && !!why;
/** A box in quarters: south-west, south-east, north-west, north-east. */
export const quarters = ([w, s, e, n]) => { const x = (w + e) / 2, y = (s + n) / 2; return [[w, s, x, y], [x, s, e, y], [w, y, x, n], [x, y, e, n]]; };

const envelope = ([w, s, e, n]) => ({ inSR: '4326', spatialRel: 'esriSpatialRelIntersects', geometryType: 'esriGeometryEnvelope', geometry: JSON.stringify({ xmin: w, ymin: s, xmax: e, ymax: n, spatialReference: { wkid: 4326 } }) });

/** The object ids in a box, the box in quarters where the server cannot list it whole. Throws { kind: 'ids' }. */
export async function idsOf(svc, url, endpoint, box, depth = 0) {
  const idq = { where: endpoint.where || '1=1', returnIdsOnly: 'true', ...envelope(box) };
  // POST first (a page of ids is too long for some servers' URLs); a server that will not take POST, by GET
  let ids = svc.get ? { error: 'skip' } : await ask(url, idq, { post: true });
  if (ids.error) { ids = await ask(url, idq); if (!ids.error) { svc.get = true; svc.page = Math.min(svc.page, 300); } }
  if (!ids.error) return ids.objectIds || [];
  if (depth < SPLIT_DEPTH && splittable(ids.error)) {
    const out = new Set();
    for (const q of quarters(box)) for (const id of await idsOf(svc, url, endpoint, q, depth + 1)) out.add(id);
    svc.split = Math.max(svc.split || 0, depth + 1);
    return [...out];
  }
  throw Object.assign(new Error(ids.error), { kind: 'ids' });
}

/** A page of features asked for by id: by the other method when one fails, then in halves. Throws { kind: 'page' }. */
async function pageOf(svc, url, base, batch) {
  const q = { ...base, objectIds: batch.join(',') };
  const tries = [!svc.get, svc.get];   // the method in use, then the other
  let last = null;
  for (const post of tries) {
    let j = svc.precise !== false ? await ask(url, { ...q, geometryPrecision: '7' }, { post }) : { error: 'skip' };
    if (j.error) { const k = await ask(url, q, { post }); if (!k.error && svc.precise === undefined) svc.precise = false; j = k; }
    if (!j.error) {
      if (svc.precise === undefined) svc.precise = true;
      if (post === svc.get) { svc.get = !post; if (svc.get) svc.page = Math.min(svc.page, 300); }   // the other method answered: it is the one used now
      return j.features || [];
    }
    last = j.error;
  }
  /* WITHOUT THE PARCEL NUMBER (2026-11-18: three servers answered every page "error 400", halved down to 25; the field
     the registry names for the parcel number is the likeliest cause, so the page is asked once more for the shapes
     alone). The parcels are copied with no number rather than not at all; it is kept on the service (svc.noPin). */
  if (base.outFields && !svc.water && /error 400|http 400/.test(String(last))) {
    const bare = await pageOf(svc, url, { ...base, outFields: '' }, batch).catch(() => null);
    if (bare) { svc.noPin = true; return bare; }
  }
  if (batch.length > PAGE_MIN) {
    const h = Math.ceil(batch.length / 2);
    const a = await pageOf(svc, url, base, batch.slice(0, h)), b = await pageOf(svc, url, base, batch.slice(h));
    svc.page = Math.max(PAGE_MIN, Math.min(svc.page, h));
    return [...a, ...b];
  }
  throw Object.assign(new Error(last), { kind: 'page' });
}

/** Every feature in a box by pages of a count (resultOffset): no list of ids needed. Throws { kind: 'offset' }. */
export async function byOffset(svc, url, endpoint, box, outFields) {
  const n = Math.min(svc.page, PAGE_MAX), out = [];
  for (let k = 0, pages = 0; pages < 5000; k += n, pages++) {
    if (elapsed() > HARD_MS) throw Object.assign(new Error('out of time'), { kind: 'time' });
    const j = await ask(url, { where: endpoint.where || '1=1', ...envelope(box), outFields, returnGeometry: 'true', outSR: '4326', resultOffset: String(k), resultRecordCount: String(n), ...(svc.water ? { maxAllowableOffset: '0.000005' } : {}) }, { post: !svc.get });
    if (j.error) throw Object.assign(new Error(j.error), { kind: 'offset' });
    const f = j.features || [];
    out.push(...f);
    if (!f.length || (!j.exceededTransferLimit && f.length < n)) break;
  }
  return out;
}

/* WHAT A FAILING SERVER WILL ANSWER (PROBE=yes with REPORT=yes; 2026-11-17: 13 servers still answered 500 or 400 to a
   square's ids in quarters down to 7 km and to pages by count). Each failed service's first endpoint is asked: its
   own description, a count of everything, every id with no area, a tiny box (about 1 km) at the middle of its
   county, a point there (what the site asks of it, and the nightly registry check), and a page of ten with no area.
   One line each, numbered, saying only what answered: no address, host, county or coordinate. */
export function probeLine(n, r) {
  const say = (x) => (x == null ? '-' : x.ok ? `ok${x.n != null ? ` ${x.n}` : ''}` : x.why);
  return `  service ${n}: description ${say(r.info)}${r.info?.ok ? ` (pagination ${r.info.paging ? 'yes' : 'no'}, max ${r.info.max ?? '?'}, ${r.info.sr})` : ''}; `
    + `count ${say(r.count)}; ids, no area ${say(r.idsAll)}; tiny box ${say(r.tiny)}; point ${say(r.point)}; ten by count, no area ${say(r.offset)}`;
}
async function probeFailed(list) {
  console.log(`Asking the ${list.length} failed services what they will answer:`);
  // a request that breaks inside Node's own fetch is said and skipped, not the end of the probe
  process.on('uncaughtException', (e) => console.log(`  (a request broke inside Node: ${e?.code || e?.name || 'error'})`));
  // each question once, 20 s at most: the probe says what answers, it does not wait out a server that is down
  const Q = { tries: 1, timeoutMs: 20000 };
  let n = 0;
  for (const svc of list) {
    n++;
    const ep = svc.endpoints?.[0];
    if (!ep) { console.log(`  service ${n}: no endpoint`); continue; }
    const url = `${ep.service}/${ep.layer}/query`, [w, s0, e, nn] = svc.box, cx = (w + e) / 2, cy = (s0 + nn) / 2, d = 0.005;
    const r = {};
    const tryIt = async (fn) => { try { return await fn(); } catch (x) { return { ok: false, why: x instanceof Refused ? String(x.message) : 'threw' }; } };
    const as = (j, pick) => (j.error ? { ok: false, why: j.error } : { ok: true, n: pick(j) });
    r.info = await tryIt(async () => {
      const j = await ask(`${ep.service}/${ep.layer}`, {}, Q);
      if (j.error) return { ok: false, why: j.error };
      const wk = j.extent?.spatialReference?.latestWkid ?? j.extent?.spatialReference?.wkid ?? j.sourceSpatialReference?.wkid;
      return { ok: true, paging: !!j.advancedQueryCapabilities?.supportsPagination, max: j.maxRecordCount ?? null, sr: wk === 4326 ? 'geographic' : wk === 3857 || wk === 102100 ? 'web mercator' : wk ? 'projected' : 'no reference' };
    });
    const where = ep.where || '1=1';
    r.count = await tryIt(async () => as(await ask(url, { where, returnCountOnly: 'true' }, Q), (j) => j.count));
    r.idsAll = await tryIt(async () => as(await ask(url, { where, returnIdsOnly: 'true' }, { ...Q, post: true }), (j) => (j.objectIds || []).length));
    r.tiny = await tryIt(async () => as(await ask(url, { where, returnIdsOnly: 'true', ...envelope([cx - d, cy - d, cx + d, cy + d]) }, Q), (j) => (j.objectIds || []).length));
    r.point = await tryIt(async () => as(await ask(url, { where, returnIdsOnly: 'true', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', geometryType: 'esriGeometryPoint', geometry: `${cx},${cy}` }, Q), (j) => (j.objectIds || []).length));
    r.offset = await tryIt(async () => as(await ask(url, { where, outFields: ep.fields?.pin || '', returnGeometry: 'true', outSR: '4326', resultOffset: '0', resultRecordCount: '10' }, Q), (j) => (j.features || []).length));
    console.log(probeLine(n, r));
  }
}

/*
 * THE WHOLE LAYER BY ITS IDS (the probe of 2026-11-17: 8 of the failing servers answered every other question -- their
 * description, a count, every id with no area, a tiny box, a point -- and failed only a square of the county, even an
 * eighth of one). Every id of the layer at once, with no area; the parcels by those ids in pages (pageOf: the other
 * method, then halves); each parcel into the squares its box touches, kept on the disk per square so a county of
 * 900,000 parcels is never all in memory; then each square written as a copied square is. Only when the server's
 * count and its list of ids agree (a list cut short at the server's own limit would leave parcels out unsaid) and
 * the count is at most WHOLE_MAX. Returns { n, bytes, squares } or throws { kind: 'whole' }.
 */
export const WHOLE_MAX = 3_000_000;
export async function wholeLayer(svc, endpoint, st, write = writeSquare) {
  const url = `${endpoint.service}/${endpoint.layer}/query`, where = endpoint.where || '1=1';
  const fail = (why) => Object.assign(new Error(why), { kind: 'whole' });
  const c = await ask(url, { where, returnCountOnly: 'true' });
  if (c.error || !Number.isFinite(c.count)) throw fail(`no count (${c.error || 'none'})`);
  if (c.count > WHOLE_MAX) throw fail(`${c.count} parcels: too many to take whole`);
  let ids = await ask(url, { where, returnIdsOnly: 'true' }, { post: true });
  if (ids.error) ids = await ask(url, { where, returnIdsOnly: 'true' });
  if (ids.error) throw fail(`no ids (${ids.error})`);
  const all = (ids.objectIds || []).slice().sort((a, b) => a - b);
  if (all.length !== c.count) throw fail(`${all.length} ids for ${c.count} parcels: the list is cut short`);
  const pin = endpoint.fields?.pin;
  const base = { outFields: pin || '', returnGeometry: 'true', outSR: '4326' };
  const work = join(tmpdir(), `parcel-whole-${process.pid}-${String(svc.key).replace(/[^\w-]/g, '_')}`);
  mkdirSync(work, { recursive: true });
  try {
    const files = new Map();
    const fileOf = (id) => { if (!files.has(id)) files.set(id, createWriteStream(join(work, `${id}.jsonl`))); return files.get(id); };
    const [bw, bs, be, bn] = svc.box;
    for (let i = 0; i < all.length;) {
      if (elapsed() > HARD_MS) throw Object.assign(new Error('out of time'), { kind: 'time' });
      const batch = all.slice(i, i + svc.page);
      for (const f of await pageOf(svc, url, base, batch)) {
        const rings = f.geometry?.rings;
        if (!Array.isArray(rings) || !rings.length) continue;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const ring of rings) for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
        if (!(e >= bw && w <= be && n >= bs && s <= bn)) continue;   // a statewide layer's parcel outside this county
        const line = `${JSON.stringify({ pin: pin ? f.attributes?.[pin] ?? null : null, rings })}\n`;
        for (let tx = Math.floor(w / TILE); tx <= Math.floor(e / TILE); tx++) for (let ty = Math.floor(s / TILE); ty <= Math.floor(n / TILE); ty++) fileOf(squareId(tx, ty)).write(line);
      }
      i += batch.length;
    }
    await Promise.all([...files.values()].map((f) => new Promise((ok) => f.end(ok))));
    let n = 0, bytes = 0;
    const at = new Date().toISOString();
    for (const [tx, ty] of squaresOf(svc.box)) {
      const id = squareId(tx, ty), parcels = [];
      if (files.has(id)) for await (const line of createInterface({ input: createReadStream(join(work, `${id}.jsonl`)) })) if (line) parcels.push(JSON.parse(line));
      const got = await write(svc, tx, ty, parcels, st.squares?.[id]);
      (st.squares ||= {})[id] = { at, n: got.n, mask: got.mask, whole: true };
      n += got.n; bytes += got.bytes;
    }
    return { n, bytes, squares: squaresOf(svc.box).length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** One square of one service: every parcel in it, each with its rings and number. Throws with a kind on failure. */
export async function fetchSquare(svc, endpoint, box) {
  const url = `${endpoint.service}/${endpoint.layer}/query`;
  const pin = endpoint.fields?.pin;
  const outFields = svc.water ? '*' : pin || '';
  let features = [], asked = 0;
  let all = null;
  try { all = (await idsOf(svc, url, endpoint, box)).slice().sort((a, b) => a - b); } catch (e) {
    if (e instanceof Refused || e.kind !== 'ids') throw e;
    // no ids, even in quarters: the parcels by pages of a count instead
    try { features = await byOffset(svc, url, endpoint, box, outFields); svc.offset = true; } catch (o) {
      if (o instanceof Refused || o.kind === 'time') throw o;
      throw Object.assign(new Error(`${e.message}; by pages: ${o.message}`), { kind: 'ids' });
    }
  }
  if (all) {
    asked = all.length;
    const base = {
      outFields, returnGeometry: 'true', outSR: '4326',
      // a water layer as the water route shows it: shapes simplified to about half a metre (water-layers.js queryUrl)
      ...(svc.water ? { maxAllowableOffset: '0.000005' } : {}),
    };
    // the page size can shrink inside pageOf: each step moves on by the batch just fetched
    for (let i = 0; i < all.length;) {
      if (elapsed() > HARD_MS) throw Object.assign(new Error('out of time'), { kind: 'time' });
      const batch = all.slice(i, i + svc.page);
      features.push(...await pageOf(svc, url, base, batch));
      i += batch.length;
    }
  } else asked = features.length;
  const out = [];
  for (const f of features) {
    if (svc.water) {
      // a water layer's feature: its shape (area, line or points) and its tidied attributes, in the number's place
      const g = f.geometry || {};
      const parts = g.rings ? ['a', g.rings] : g.paths ? ['l', g.paths] : Number.isFinite(g.x) ? ['p', [[[g.x, g.y]]]]
        : Array.isArray(g.points) ? ['p', g.points.map((q) => [q])] : null;
      if (parts) out.push({ pin: JSON.stringify({ g: parts[0], a: tidyAttributes(f.attributes) }), rings: parts[1] });
      continue;
    }
    const rings = f.geometry?.rings;
    if (!Array.isArray(rings) || !rings.length) continue;
    out.push({ pin: pin ? f.attributes?.[pin] ?? null : null, rings });
  }
  return { parcels: out, asked };
}

/* ---------------------------------------------------------------- the squares */
const squareId = (tx, ty) => `${tx}_${ty}`;
function squaresOf([w, s, e, n]) {
  const out = [];
  for (let tx = Math.floor(w / TILE); tx <= Math.floor(e / TILE); tx++) {
    for (let ty = Math.floor(s / TILE); ty <= Math.floor(n / TILE); ty++) out.push([tx, ty]);
  }
  return out;
}
// which of a square's 100 cells hold something: a bit each, base64
const maskOf = (cells) => { const b = new Uint8Array(Math.ceil((PER * PER) / 8)); for (const i of cells) b[i >> 3] |= 1 << (i & 7); return Buffer.from(b).toString('base64'); };
const cellsOfMask = (m) => { const b = Buffer.from(m || '', 'base64'), out = []; for (let i = 0; i < PER * PER; i++) if (b[i >> 3] & (1 << (i & 7))) out.push(i); return out; };

/** Copy one square: fetch, cut into cells, write them, drop cells it no longer fills. Returns { n, mask, bytes }. */
async function copySquare(svc, endpoint, key, tx, ty, old) {
  const [bw, bs, be, bn] = svc.box;
  const box = [Math.max(bw, tx * TILE), Math.max(bs, ty * TILE), Math.min(be, (tx + 1) * TILE), Math.min(bn, (ty + 1) * TILE)];
  const { parcels } = await fetchSquare(svc, endpoint, box);
  return writeSquare(svc, tx, ty, parcels, old);
}

/** A water record cut to one cell (a hair over, so no seam shows): encoded, or null when nothing of it is in the cell. */
function cutToCell(p, cx, cy, minPoints) {
  const pad = CELL * 1e-4;
  const b = [cx * CELL - pad, cy * CELL - pad, (cx + 1) * CELL + pad, (cy + 1) * CELL + pad];
  let g = 'a';
  try { g = JSON.parse(p.pin).g; } catch { /* an area */ }
  const rings = g === 'a' ? p.rings.map((r) => clipRing(r, b)).filter((r) => r && r.length >= 3)
    : g === 'l' ? p.rings.flatMap((r) => clipLine(r, b))
      : p.rings.filter((r) => r[0] && r[0][0] >= b[0] && r[0][0] <= b[2] && r[0][1] >= b[1] && r[0][1] <= b[3]);
  if (!rings.length) return null;
  const rec = encodeParcel({ pin: p.pin, rings }, minPoints);
  return rec.rings ? rec : null;
}

/** One square's parcels into its cells: written, and cells it no longer fills dropped. Returns { n, mask, bytes }. */
async function writeSquare(svc, tx, ty, parcels, old) {
  const cellAt = (cx, cy) => `${svc.prefix}/${cx}_${cy}.bin`;
  const cx0 = tx * PER, cy0 = ty * PER;
  const cells = new Map();
  for (const p of parcels) {
    let rec;
    try { rec = encodeParcel(p, svc.minPoints || 3); } catch { continue; }
    if (!rec.rings) continue;
    const [w, s, e, n] = rec.box;
    const [x0, y0] = cellOf(w, s), [x1, y1] = cellOf(e, n);
    const many = x1 > x0 || y1 > y0;
    // only this square's cells: a parcel across its edge is in the next square's answer too
    for (let cx = Math.max(x0, cx0); cx <= Math.min(x1, cx0 + PER - 1); cx++) {
      for (let cy = Math.max(y0, cy0); cy <= Math.min(y1, cy0 + PER - 1); cy++) {
        const i = (cy - cy0) * PER + (cx - cx0);
        // a water shape across cells is cut to each (a county's flood zone can be one polygon of a million corners)
        const r = svc.water && many ? cutToCell(p, cx, cy, svc.minPoints || 1) : rec;
        if (!r) continue;
        if (!cells.has(i)) cells.set(i, []);
        cells.get(i).push(r);
      }
    }
  }
  let bytes = 0;
  const at = Date.now();
  for (const [i, recs] of cells) {
    const cx = cx0 + (i % PER), cy = cy0 + Math.floor(i / PER);
    const gz = gzipSync(encodeCell(cx, cy, recs, at), { level: 9 });
    bytes += gz.length;
    await put(cellAt(cx, cy), gz, 'application/octet-stream');
  }
  for (const i of cellsOfMask(old?.mask)) {
    if (!cells.has(i)) await del(cellAt(cx0 + (i % PER), cy0 + Math.floor(i / PER)));
  }
  return { n: parcels.length, mask: maskOf([...cells.keys()]), bytes };
}

/* ------------------------------------------------- the county's published file */
/*
 * WHEN THE SERVER CANNOT BE COPIED, THE FILE (owner, 2026-11-09: "Yes, add the file fallback"). A county whose parcel
 * server refused a login-less query during a republish still offered the same parcels as a public download on its own
 * portal. The server names its portal (/rest/info owningSystemUrl); the portal is searched for a public parcel file
 * (File Geodatabase, shapefile or GeoPackage) and the newest is copied (tools/parcel_file.py reads it). Only the
 * county's own portal: on ArcGIS Online, only the organisation the service belongs to.
 */
const FILE_TYPES = ['File Geodatabase', 'Shapefile', 'GeoPackage'];
const FILE_MAX = 2e9;
/* WHERE TO LOOK (2026-11-17: the three login-only services had no file found, and the log could not say whether a
   portal was even named). A server names its portal at /rest/info, but one that wants a login may not answer that
   either. So also: a service hosted on ArcGIS Online, its own organisation's items on ArcGIS Online (orgid keeps it to
   that county); and an ArcGIS Enterprise server, the portal at its usual address on the same host. Why none was found
   is kept (svc.fileWhy) for the report. */
export async function findFile(svc) {
  const service = svc.cfg.service;
  const root = service.replace(/\/rest\/services\/.*$/i, '');
  const org = /services\d*\.arcgis\.com\/([^/]+)\//i.exec(service)?.[1];
  const info = await ask(`${root}/rest/info`, {}).catch(() => null);
  const portals = [...new Set([info?.owningSystemUrl, org ? 'https://www.arcgis.com' : null, org ? null : `${new URL(root).origin}/portal`].filter(Boolean).map((u) => u.replace(/\/$/, '')))];
  const q = `parcel AND access:public AND (${FILE_TYPES.map((t) => `type:"${t}"`).join(' OR ')})${org ? ` AND orgid:${org}` : ''}`;
  let searched = 0;
  for (const portal of portals) {
    const found = await ask(`${portal}/sharing/rest/search`, { q, num: '50', sortField: 'modified', sortOrder: 'desc' }).catch(() => null);
    if (!found || found.error || !Array.isArray(found.results)) continue;
    searched++;
    const it = pickFile(found.results, svc.box);
    if (it) return { url: `${portal}/sharing/rest/content/items/${it.id}/data`, modified: it.modified, type: it.type };
  }
  svc.fileWhy = searched ? `${searched} portal${searched === 1 ? '' : 's'} searched: no public parcel file for its area` : `no portal answered (${portals.length} tried${info?.owningSystemUrl ? '' : '; the server names none'})`;
  return null;
}

/** Of a portal's search results, the parcel file for a service's box: the newest public one, or null. */
export function pickFile(results, [w, s, e, n]) {
  const items = (results || []).filter((it) => FILE_TYPES.includes(it.type) && it.access === 'public'
    && /parcel/i.test(it.title || '') && !/(point|address|annotation|\banno|centroid|label|line|fabric|history|retired)/i.test(it.title || '')
    && !(it.size > FILE_MAX)
    // where the item says where it is, it has to be here
    && (!Array.isArray(it.extent) || it.extent.length !== 2 || !(it.extent[1][0] < w || it.extent[0][0] > e || it.extent[1][1] < s || it.extent[0][1] > n)));
  return items.sort((a, b) => b.modified - a.modified)[0] || null;
}

/** Copy a service from its county's published file: every square at once. Returns { n, bytes } or throws. */
async function copyFromFile(svc, st, file) {
  const work = join(tmpdir(), `parcel-file-${process.pid}-${svc.key}`);
  mkdirSync(work, { recursive: true });
  try {
    const zip = join(work, 'file.zip'), out = join(work, 'parcels.jsonl');
    const r = await fetch(file.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30 * 60e3) });
    if (!r.ok || !r.body) throw Object.assign(new Error(`the file answered ${r.status}`), { kind: 'file' });
    await pipeline(Readable.fromWeb(r.body), createWriteStream(zip));
    if (statSync(zip).size > FILE_MAX) throw Object.assign(new Error('the file is too big'), { kind: 'file' });
    const pin = endpointsFor(svc.cfg)[0]?.fields?.pin || '-';
    const py = spawnSync(process.env.PYTHON || 'python3', [join(dirname(new URL(import.meta.url).pathname), 'parcel_file.py'), zip, out, pin, svc.box.join(',')], { encoding: 'utf8', maxBuffer: 1 << 24 });
    if (py.status !== 0) throw Object.assign(new Error(`the file could not be read: ${(py.stderr || py.stdout || '').trim().split('\n').pop()?.slice(0, 100)}`), { kind: 'file' });
    // every parcel into each square its box touches
    const squares = new Map();
    for await (const line of createInterface({ input: createReadStream(out) })) {
      if (!line) continue;
      const p = JSON.parse(line);
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (const ring of p.rings) for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
      for (let tx = Math.floor(w / TILE); tx <= Math.floor(e / TILE); tx++) {
        for (let ty = Math.floor(s / TILE); ty <= Math.floor(n / TILE); ty++) {
          const id = squareId(tx, ty);
          if (!squares.has(id)) squares.set(id, []);
          squares.get(id).push(p);
        }
      }
    }
    let n = 0, bytes = 0;
    const at = new Date().toISOString();
    for (const [tx, ty] of squaresOf(svc.box)) {
      const id = squareId(tx, ty);
      const got = await writeSquare(svc, tx, ty, squares.get(id) || [], st.squares[id]);
      st.squares[id] = { at, n: got.n, mask: got.mask, file: true };
      n += got.n; bytes += got.bytes;
    }
    return { n, bytes };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- the services */
function servicesToCopy() {
  const keys = mirrorKeys(ALL_COUNTIES);
  const out = [];
  for (const [key, mk] of Object.entries(keys)) {
    if (key !== mk) continue;
    const cfg = ALL_COUNTIES[key];
    const box = COUNTY_BBOX[key] || VERIFIED_COUNTIES[key]?.box;
    if (!box || box.length !== 4) continue;
    out.push({ key, cfg, box, page: PAGE_MAX, prefix: `${PREFIX}${key}`, endpoints: endpointsFor(cfg) });
  }
  return out;
}

/*
 * THE WATER MAP'S COUNTY LAYERS TOO (owner, 2026-11-09, after the owner's county's drain network went behind a login:
 * "If it's similar, that's fine"). Every layer the water catalogue keeps (D1 water_layers, workflow 44), copied the
 * same way under water/<id>/ (worker/src/water-copy.js reads it when the layer does not answer). From the catalogue,
 * or for a test from WATER_LAYERS (JSON: [{ url, west, south, east, north }]).
 */
const waterFeatures = { n: 0 };
async function waterLayersToCopy() {
  if (process.env.NO_WATER) return [];
  let rows;
  try {
    if (process.env.WATER_LAYERS) rows = JSON.parse(process.env.WATER_LAYERS);
    else if (OUT) return [];
    else rows = (await import('./corpus-db.js')).query('SELECT url, west, south, east, north, features FROM water_layers WHERE ok = 1');
  } catch (e) {
    console.log(`Water layers: the catalogue could not be read (${String(e.message || e).slice(0, 80)}); parcels only this run.`);
    return [];
  }
  const out = [];
  for (const r of rows || []) {
    const box = [r.west, r.south, r.east, r.north].map(Number);
    const m = /^(.*)\/(\d+)\/?$/.exec(r.url || '');
    if (!m || !box.every(Number.isFinite) || !(box[2] > box[0] && box[3] > box[1])) continue;
    // every layer, however big (owner, 2026-11-09: the 4 statewide ones over 1.5 million features had been left out;
    // the copy goes by half-degree squares, so size costs time, not memory)
    waterFeatures.n += Number(r.features) || 0;
    const id = await waterIdOf(r.url);
    out.push({
      key: `water:${id}`, water: true, cfg: { service: m[1] }, box, page: PAGE_MAX, minPoints: 1,
      prefix: `${WATER_PREFIX}${id}`, endpoints: [{ service: m[1], layer: m[2], where: null, fields: {} }],
    });
  }
  return out;
}

/** Which services this run works on, best first: parcel services never copied or under way, then water layers never
 *  copied or under way, then the oldest copies of either. */
export function order(services, state, now) {
  const age = (k) => state.services[k];
  const stale = (s) => {
    const st = age(s.key);
    if (!st) return true;
    // a parcel service that failed before the fallbacks of 2026-11-17 existed is tried with them at once, not in 3 days
    if (st.failed && now - Date.parse(st.failed.at) < RETRY_FAILED_DAYS * 864e5 && (s.water || Date.parse(st.failed.at) >= Date.parse(FALLBACKS_AT))) return false;
    if (st.round && !st.done) return true;
    return !st.done || now - Date.parse(st.done) > MAX_AGE_DAYS * 864e5;
  };
  const area = (s) => (s.box[2] - s.box[0]) * (s.box[3] - s.box[1]);
  const rank = (s) => { const st = age(s.key); return !st ? 0 : st.round && !st.done ? 1 : 2; };
  /* PARCELS BEFORE WATER LAYERS, ALL OF THEM (the one-week check, 2026-11-16): ordered rank first, a parcel service
     half copied (rank 1) waited behind every water layer never copied (rank 0), and with 8,500 water layers in the
     catalogue the same 98 parcel services sat "under way" for five days (runs from 2026-11-12: 0 to 99,000 parcels a
     run, where they had copied 12 million). The parcel line is what every tool needs first: every parcel service
     never copied or under way goes first, then the water layers likewise, then the oldest copies of either. */
  const tier = (s) => (rank(s) < 2 ? (s.water ? 1 : 0) : 2);
  return services.filter(stale).sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b)
    || (rank(a) === 2 ? Date.parse(age(a.key).done || 0) - Date.parse(age(b.key).done || 0) : area(a) - area(b)));
}

async function main() {
  await r2init();
  const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  let services = [...servicesToCopy(), ...await waterLayersToCopy()];
  if (only.length) services = services.filter((s) => only.includes(s.key) || (s.water && only.includes('water')));
  const state = (await getJson(`${PREFIX}_state.json`)) || { v: 1, services: {} };
  state.services ||= {};
  const now = Date.now();
  /* WHY THE FAILED ONES FAILED (REPORT=yes; the one-week check, 2026-11-16: the log counts them by kind and no more).
     Each parcel service that could not be copied, grouped by kind and by the server's own message, with every web
     address and host taken out (the log is public: no county is named). Nothing is copied. */
  if (/^(1|yes|true)$/i.test(process.env.REPORT || '')) {
    const groups = new Map();
    for (const svc of services) {
      if (svc.water) continue;
      const f = state.services[svc.key]?.failed;
      if (!f) continue;
      const why = String(f.why || '').replace(/https?:\/\/\S+/g, '[address]').replace(/\b[\w-]+(\.[\w-]+)+\.(gov|us|com|org|net|io)\b/gi, '[host]').trim() || '(no message)';
      const k = `${f.kind} | ${why}`;
      if (!groups.has(k)) groups.set(k, { n: 0, last: f.at });
      const g = groups.get(k); g.n++; if (f.at > g.last) g.last = f.at;
    }
    console.log(`Parcel services that could not be copied, by kind and the server's message (addresses taken out):`);
    for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${g.n} x ${k} (last tried ${g.last.slice(0, 10)})`);
    // the county's published file, for those it was looked for: found and unreadable, or none found
    const files = new Map();
    for (const svc of services) {
      if (svc.water) continue;
      const S = state.services[svc.key];
      if (!S?.failed) continue;
      const why = S.fileFailed ? String(S.fileFailed.why || '').replace(/https?:\/\/\S+/g, '[address]').replace(/\b[\w-]+(\.[\w-]+)+\.(gov|us|com|org|net|io)\b/gi, '[host]').trim() : 'not looked for (failed before 2026-11-17, or out of time)';
      files.set(why, (files.get(why) || 0) + 1);
    }
    if (files.size) { console.log('Their county\'s published file:'); for (const [k, n] of [...files].sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${k}`); }
    const how = { split: 0, offset: 0, whole: 0 };
    for (const svc of services) { const src = state.services[svc.key]?.source; if (src?.split) how.split++; if (src?.offset) how.offset++; if (src?.whole) how.whole++; }
    console.log(`Copied with the fallbacks of 2026-11-17: ${how.split} asked for in smaller squares, ${how.offset} by pages of a count, ${how.whole} taken whole by their ids.`);
    const wholeWhy = new Map();
    for (const svc of services) { const S = state.services[svc.key]; if (S?.failed && S.wholeFailed) { const k = String(S.wholeFailed.why).replace(/\d{4,}/g, 'N'); wholeWhy.set(k, (wholeWhy.get(k) || 0) + 1); } }
    if (wholeWhy.size) { console.log('Not taken whole by their ids:'); for (const [k, n] of [...wholeWhy].sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${k}`); }
    if (/^(1|yes|true)$/i.test(process.env.PROBE || '')) await probeFailed(services.filter((x) => !x.water && state.services[x.key]?.failed));
    return;
  }
  const todo = order(services, state, now);
  const totals = { squares: 0, parcels: 0, bytes: 0, services: 0, failed: {} };
  if (services.some((x) => x.water)) {
    console.log(`Water catalogue: ${services.filter((x) => x.water).length} layers holding ${waterFeatures.n.toLocaleString()} features.`);
  }
  console.log(`Parcel copy: ${services.filter((x) => !x.water).length} parcel services in the registry and ${services.filter((x) => x.water).length} water layers in the catalogue; ${todo.length} want copying (never copied, under way, `
    + `or over ${MAX_AGE_DAYS} days old); ${SERVICES_AT_ONCE} at a time, for up to ${Math.round(BUDGET_MS / 60e3)} min.`);

  let saving = Promise.resolve(), lastSave = 0;
  const save = (force = false) => {
    if (!force && Date.now() - lastSave < 120e3) return saving;
    lastSave = Date.now();
    saving = saving.then(() => put(`${PREFIX}_state.json`, Buffer.from(JSON.stringify(state)), 'application/json')).catch(() => {});
    return saving;
  };
  const progress = setInterval(() => {
    console.log(`  ${Math.round(elapsed() / 60e3)} min: ${totals.squares} squares, ${totals.parcels.toLocaleString()} parcels, `
      + `${(totals.bytes / 1e6).toFixed(1)} MB written; ${totals.services} services finished.`);
  }, 15 * 60e3);

  let next = 0;
  const worker = async () => {
    while (next < todo.length && elapsed() < BUDGET_MS) {
      const svc = todo[next++];
      const st = (state.services[svc.key] ||= {});
      if (!st.round || st.done) { st.round = new Date().toISOString(); st.done = null; st.squares ||= {}; }
      st.squares ||= {};
      delete st.failed;
      delete st.fileFailed;
      delete st.wholeFailed;
      const squares = squaresOf(svc.box);
      const endpoints = svc.endpoints;
      let ep = st.endpoint != null ? endpoints[st.endpoint] || endpoints[0] : endpoints[0];
      try {
        // FILE_ONLY=1: straight to the published file (a test of the fallback)
        if (process.env.FILE_ONLY) throw new Refused('file only');
        for (const [tx, ty] of squares) {
          if (elapsed() > BUDGET_MS) break;
          const id = squareId(tx, ty), old = st.squares[id];
          if (old && Date.parse(old.at) >= Date.parse(st.round)) continue;
          let got = null, err = null;
          // the first endpoint that answers, as the site does (parcel.js endpointsFor)
          for (const e of [ep, ...endpoints.filter((x) => x !== ep)]) {
            try { got = await copySquare(svc, e, svc.key, tx, ty, old); ep = e; break; } catch (x) { err = x; if (x.kind === 'time') break; }
          }
          if (!got) throw err;
          st.endpoint = endpoints.indexOf(ep);
          st.squares[id] = { at: new Date().toISOString(), n: got.n, mask: got.mask };
          totals.squares++; totals.bytes += got.bytes;
          if (svc.water) totals.features = (totals.features || 0) + got.n; else totals.parcels += got.n;
          save();
        }
        if (squares.every(([tx, ty]) => { const q = st.squares[squareId(tx, ty)]; return q && Date.parse(q.at) >= Date.parse(st.round); })) {
          st.done = new Date().toISOString();
          st.source = { kind: 'server', ...(svc.split ? { split: svc.split } : {}), ...(svc.offset ? { offset: true } : {}) };
          st.count = squares.reduce((s, [tx, ty]) => s + (st.squares[squareId(tx, ty)]?.n || 0), 0);
          if (svc.water) totals.water = (totals.water || 0) + 1; else totals.services++;
        }
      } catch (e) {
        const kind = e instanceof Refused ? 'refused' : e.kind === 'time' ? 'out of time' : e.kind === 'ids' ? 'ids not given' : e.kind === 'page' ? 'a page failed' : 'error';
        // the server cannot be copied square by square, but may give its whole layer by ids (wholeLayer)
        if (!svc.water && (kind === 'ids not given' || kind === 'a page failed') && elapsed() < BUDGET_MS) {
          try {
            // each of the service's endpoints in turn, the one in use first (the probe asked the first; the copy may be
            // on another that answers nothing at all)
            let got = null, whyNot = null;
            for (const e of [ep, ...svc.endpoints.filter((x) => x !== ep)]) {
              try { got = await wholeLayer(svc, e, st); st.endpoint = svc.endpoints.indexOf(e); break; } catch (x) { if (x.kind === 'time') throw x; whyNot = x; }
            }
            if (!got) throw whyNot;
            st.done = new Date().toISOString();
            st.count = got.n;
            st.source = { kind: 'server', whole: true, because: kind };
            totals.squares += got.squares; totals.parcels += got.n; totals.bytes += got.bytes;
            totals.services++; totals.whole = (totals.whole || 0) + 1;
            save();
            continue;
          } catch (we) {
            if (we.kind === 'time') { totals.failed['out of time'] = (totals.failed['out of time'] || 0) + 1; continue; }
            st.wholeFailed = { at: new Date().toISOString(), why: String(we.message || we).slice(0, 120) };
          }
        }
        // the server cannot be copied: the same parcels as the county publishes them for download, when it does
        if (!svc.water && kind !== 'out of time' && elapsed() < BUDGET_MS) {
          try {
            const file = await findFile(svc);
            if (!file) st.fileFailed = { at: new Date().toISOString(), why: svc.fileWhy || 'none found' };
            if (file) {
              const got = await copyFromFile(svc, st, file);
              st.done = new Date().toISOString();
              st.count = got.n;
              st.source = { kind: 'file', type: file.type, published: new Date(file.modified).toISOString(), because: kind };
              totals.squares += squaresOf(svc.box).length; totals.parcels += got.n; totals.bytes += got.bytes;
              totals.services++; totals.fromFile = (totals.fromFile || 0) + 1;
              save();
              continue;
            }
          } catch (fe) {
            totals.fileFailed = (totals.fileFailed || 0) + 1;
            st.fileFailed = { at: new Date().toISOString(), why: String(fe.message || fe).slice(0, 120) };
          }
        }
        if (kind !== 'out of time') st.failed = { at: new Date().toISOString(), kind, why: String(e.message || e).slice(0, 120) };
        totals.failed[kind] = (totals.failed[kind] || 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SERVICES_AT_ONCE, todo.length || 1) }, worker));
  clearInterval(progress);

  // the totals, for the console (routes-admin.js parcel-mirror)
  const all = services.filter((s) => !s.water).map((s) => state.services[s.key]).filter(Boolean);
  const done = all.filter((s) => s.done);
  const wall = services.filter((s) => s.water).map((s) => state.services[s.key]).filter(Boolean);
  const summary = {
    at: new Date().toISOString(), services: services.filter((s) => !s.water).length,
    copied: done.length, underway: all.filter((s) => s.round && !s.done).length,
    failed: all.filter((s) => s.failed).length,
    failures: Object.entries(all.filter((s) => s.failed).reduce((m, s) => ({ ...m, [s.failed.kind]: (m[s.failed.kind] || 0) + 1 }), {})),
    parcels: done.reduce((s, x) => s + (x.count || 0), 0),
    oldest: done.map((s) => s.done).sort()[0] || null,
    newest: done.map((s) => s.done).sort().pop() || null,
    water: {
      layers: services.filter((s) => s.water).length, copied: wall.filter((s) => s.done).length,
      underway: wall.filter((s) => s.round && !s.done).length, failed: wall.filter((s) => s.failed).length,
      features: wall.filter((s) => s.done).reduce((s, x) => s + (x.count || 0), 0),
    },
  };
  await save(true);
  await put(`${PREFIX}_summary.json`, Buffer.from(JSON.stringify(summary)), 'application/json');
  const failed = Object.entries(totals.failed).map(([k, n]) => `${n} ${k}`).join(', ');
  console.log(`This run: ${totals.squares} squares, ${totals.parcels.toLocaleString()} parcels, ${(totals.bytes / 1e6).toFixed(1)} MB written; `
    + `${totals.services} services finished${totals.water ? `, and ${totals.water} water layers (${(totals.features || 0).toLocaleString()} features)` : ''}${totals.fromFile ? ` (${totals.fromFile} from the county's published file, its server refusing)` : ''}`
    + `${totals.whole ? ` (${totals.whole} taken whole by their ids, their servers refusing squares)` : ''}`
    + `${totals.fileFailed ? `; ${totals.fileFailed} published file${totals.fileFailed === 1 ? '' : 's'} could not be read` : ''}`
    + `${failed ? `; stopped on ${failed}` : ''}. (${Math.round(elapsed() / 60e3)} min)`);
  console.log(`The copy now: ${summary.copied} of ${summary.services} services copied whole (${summary.parcels.toLocaleString()} parcels), `
    + `${summary.underway} under way, ${summary.failed} could not be copied${summary.failures.length ? ` (${summary.failures.map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}; `
    + `the oldest copy ${summary.oldest ? summary.oldest.slice(0, 10) : 'none yet'}. Water layers: ${summary.water.copied} of ${summary.water.layers} copied `
    + `(${summary.water.features.toLocaleString()} features), ${summary.water.underway} under way, ${summary.water.failed} could not be copied.`);
}

if (process.argv[1]?.endsWith('parcel-mirror.mjs')) main().catch((e) => { console.log(`Parcel copy: ${e.message}`); process.exit(1); });
