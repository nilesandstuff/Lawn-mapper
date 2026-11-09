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
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ALL_COUNTIES, COUNTY_BBOX } from '../worker/src/counties.js';
import { VERIFIED_COUNTIES } from '../worker/src/counties-verified.js';
import { endpointsFor } from '../worker/src/parcel.js';
import { CELL, cellOf, cellKey, encodeParcel, encodeCell, mirrorKeys, PREFIX } from '../worker/src/parcel-mirror.js';

export const TILE = 0.5;                       // degrees: 10 x 10 cells
const PER = Math.round(TILE / CELL);
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 30);
const RETRY_FAILED_DAYS = 3;
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
class Refused extends Error {}
async function ask(url, params, { post = false } = {}) {
  return hostTurn(url, async () => {
    let last = null;
    for (let t = 0; t < 3; t++) {
      if (t) await sleep(3000 * 2 ** t);
      try {
        const body = new URLSearchParams({ f: 'json', ...params });
        const r = post
          ? await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
          : await fetch(`${url}?${body}`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!r.ok) { last = `http ${r.status}`; if (r.status === 403 || r.status === 401) throw new Refused(last); if (r.status < 500 && r.status !== 429) break; continue; }
        const j = await r.json();
        if (j.error) {
          const code = Number(j.error.code);
          if (code === 499 || code === 498 || code === 403 || /token/i.test(j.error.message || '')) throw new Refused(`refused ${code}`);
          last = `error ${j.error.code ?? ''}`.trim();
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

/** One square of one service: every parcel in it, each with its rings and number. Throws with a kind on failure. */
async function fetchSquare(svc, endpoint, box) {
  const url = `${endpoint.service}/${endpoint.layer}/query`;
  const [w, s, e, n] = box;
  const idq = {
    where: endpoint.where || '1=1', returnIdsOnly: 'true', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    geometryType: 'esriGeometryEnvelope', geometry: JSON.stringify({ xmin: w, ymin: s, xmax: e, ymax: n, spatialReference: { wkid: 4326 } }),
  };
  // POST first (a page of ids is too long for some servers' URLs); a server that will not take POST, by GET
  let ids = svc.get ? { error: 'skip' } : await ask(url, idq, { post: true });
  if (ids.error) { ids = await ask(url, idq); if (!ids.error) { svc.get = true; svc.page = Math.min(svc.page, 300); } }
  if (ids.error) throw Object.assign(new Error(ids.error), { kind: 'ids' });
  const all = (ids.objectIds || []).slice().sort((a, b) => a - b);
  const pin = endpoint.fields?.pin;
  const out = [];
  for (let i = 0; i < all.length; i += svc.page) {
    const page = svc.page;
    if (elapsed() > HARD_MS) throw Object.assign(new Error('out of time'), { kind: 'time' });
    const batch = all.slice(i, i + page);
    const base = { objectIds: batch.join(','), outFields: pin || '', returnGeometry: 'true', outSR: '4326' };
    const post = !svc.get;
    let j = svc.precise !== false ? await ask(url, { ...base, geometryPrecision: '7' }, { post }) : { error: 'skip' };
    if (j.error) { j = await ask(url, base, { post }); if (!j.error && svc.precise === undefined) svc.precise = false; }
    if (j.error) throw Object.assign(new Error(j.error), { kind: 'page' });
    if (svc.precise === undefined) svc.precise = true;
    for (const f of j.features || []) {
      const rings = f.geometry?.rings;
      if (!Array.isArray(rings) || !rings.length) continue;
      out.push({ pin: pin ? f.attributes?.[pin] ?? null : null, rings });
    }
  }
  return { parcels: out, asked: all.length };
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
  const cx0 = tx * PER, cy0 = ty * PER;
  const cells = new Map();
  for (const p of parcels) {
    let rec;
    try { rec = encodeParcel(p); } catch { continue; }
    if (!rec.rings) continue;
    const [w, s, e, n] = rec.box;
    const [x0, y0] = cellOf(w, s), [x1, y1] = cellOf(e, n);
    // only this square's cells: a parcel across its edge is in the next square's answer too
    for (let cx = Math.max(x0, cx0); cx <= Math.min(x1, cx0 + PER - 1); cx++) {
      for (let cy = Math.max(y0, cy0); cy <= Math.min(y1, cy0 + PER - 1); cy++) {
        const i = (cy - cy0) * PER + (cx - cx0);
        if (!cells.has(i)) cells.set(i, []);
        cells.get(i).push(rec);
      }
    }
  }
  let bytes = 0;
  const at = Date.now();
  for (const [i, recs] of cells) {
    const cx = cx0 + (i % PER), cy = cy0 + Math.floor(i / PER);
    const gz = gzipSync(encodeCell(cx, cy, recs, at), { level: 9 });
    bytes += gz.length;
    await put(cellKey(key, cx, cy), gz, 'application/octet-stream');
  }
  for (const i of cellsOfMask(old?.mask)) {
    if (!cells.has(i)) await del(cellKey(key, cx0 + (i % PER), cy0 + Math.floor(i / PER)));
  }
  return { n: parcels.length, mask: maskOf([...cells.keys()]), bytes };
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
    out.push({ key, cfg, box, page: PAGE_MAX });
  }
  return out;
}

/** Which services this run works on, best first: never copied, then a copy under way, then the oldest copy. */
function order(services, state, now) {
  const age = (k) => state.services[k];
  const stale = (s) => {
    const st = age(s.key);
    if (!st) return true;
    if (st.failed && now - Date.parse(st.failed.at) < RETRY_FAILED_DAYS * 864e5) return false;
    if (st.round && !st.done) return true;
    return !st.done || now - Date.parse(st.done) > MAX_AGE_DAYS * 864e5;
  };
  const area = (s) => (s.box[2] - s.box[0]) * (s.box[3] - s.box[1]);
  const rank = (s) => { const st = age(s.key); return !st ? 0 : st.round && !st.done ? 1 : 2; };
  return services.filter(stale).sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 2 ? Date.parse(age(a.key).done || 0) - Date.parse(age(b.key).done || 0) : area(a) - area(b)));
}

async function main() {
  await r2init();
  const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  let services = servicesToCopy();
  if (only.length) services = services.filter((s) => only.includes(s.key));
  const state = (await getJson(`${PREFIX}_state.json`)) || { v: 1, services: {} };
  state.services ||= {};
  const now = Date.now();
  const todo = order(services, state, now);
  const totals = { squares: 0, parcels: 0, bytes: 0, services: 0, failed: {} };
  console.log(`Parcel copy: ${services.length} services in the registry; ${todo.length} want copying (never copied, under way, `
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
      const squares = squaresOf(svc.box);
      const endpoints = endpointsFor(svc.cfg);
      let ep = st.endpoint != null ? endpoints[st.endpoint] || endpoints[0] : endpoints[0];
      try {
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
          totals.squares++; totals.parcels += got.n; totals.bytes += got.bytes;
          save();
        }
        if (squares.every(([tx, ty]) => { const q = st.squares[squareId(tx, ty)]; return q && Date.parse(q.at) >= Date.parse(st.round); })) {
          st.done = new Date().toISOString();
          st.count = squares.reduce((s, [tx, ty]) => s + (st.squares[squareId(tx, ty)]?.n || 0), 0);
          totals.services++;
        }
      } catch (e) {
        const kind = e instanceof Refused ? 'refused' : e.kind === 'time' ? 'out of time' : e.kind === 'ids' ? 'ids not given' : e.kind === 'page' ? 'a page failed' : 'error';
        if (kind !== 'out of time') st.failed = { at: new Date().toISOString(), kind, why: String(e.message || e).slice(0, 120) };
        totals.failed[kind] = (totals.failed[kind] || 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SERVICES_AT_ONCE, todo.length || 1) }, worker));
  clearInterval(progress);

  // the totals, for the console (routes-admin.js parcel-mirror)
  const all = services.map((s) => state.services[s.key]).filter(Boolean);
  const done = all.filter((s) => s.done);
  const summary = {
    at: new Date().toISOString(), services: services.length,
    copied: done.length, underway: all.filter((s) => s.round && !s.done).length,
    failed: all.filter((s) => s.failed).length,
    failures: Object.entries(all.filter((s) => s.failed).reduce((m, s) => ({ ...m, [s.failed.kind]: (m[s.failed.kind] || 0) + 1 }), {})),
    parcels: done.reduce((s, x) => s + (x.count || 0), 0),
    oldest: done.map((s) => s.done).sort()[0] || null,
    newest: done.map((s) => s.done).sort().pop() || null,
  };
  await save(true);
  await put(`${PREFIX}_summary.json`, Buffer.from(JSON.stringify(summary)), 'application/json');
  const failed = Object.entries(totals.failed).map(([k, n]) => `${n} ${k}`).join(', ');
  console.log(`This run: ${totals.squares} squares, ${totals.parcels.toLocaleString()} parcels, ${(totals.bytes / 1e6).toFixed(1)} MB written; `
    + `${totals.services} services finished${failed ? `; stopped on ${failed}` : ''}. (${Math.round(elapsed() / 60e3)} min)`);
  console.log(`The copy now: ${summary.copied} of ${summary.services} services copied whole (${summary.parcels.toLocaleString()} parcels), `
    + `${summary.underway} under way, ${summary.failed} could not be copied${summary.failures.length ? ` (${summary.failures.map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}; `
    + `the oldest copy ${summary.oldest ? summary.oldest.slice(0, 10) : 'none yet'}.`);
}

if (process.argv[1]?.endsWith('parcel-mirror.mjs')) main().catch((e) => { console.log(`Parcel copy: ${e.message}`); process.exit(1); });
