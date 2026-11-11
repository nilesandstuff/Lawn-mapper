/**
 * ONE MAP, EVERY TOOL (owner, 2026-10-16).
 *
 * Every saved map lives on the server, signed in or not, and every tool --
 * the lawn mapper, the slices, the shade map, the water map -- opens the same
 * record and keeps its own part of it. The browser holds only a cookie.
 *
 *   OWNER   who a map belongs to: an account ('user'), or for somebody signed
 *           out a GUEST, a random token in a cookie set for the whole home
 *           domain (lm_guest), so every tool on every subdomain sees the same
 *           one. A guest keeps ONE map; signing in moves it into the account.
 *   MAP     the lawn mapper's save record, as it always was (maps, guest_maps).
 *   TOOL    one row per (owner, map, tool) in map_tools, written only by that
 *           tool. The lawn mapper re-saving its record never touches them.
 *
 * The contract the other tools build against is docs/MAPS.md.
 */

import { hash, newId, newSecret } from './db.js';

/** A guest's one map (owner: "sign in should be required for more than 1 map"). */
export const GUEST_MAX_MAPS = 1;
/** Fifty for an account, as before (routes-maps.js MAX_MAPS). */
export const USER_MAX_MAPS = 50;
/** An address of somebody who never signed up is not kept for ever. */
export const GUEST_IDLE_DAYS = 90;
/** One tool's part of one map. A traced line and a few hundred erased cells fit easily. */
export const TOOL_MAX_BYTES = 64 * 1024;

export const GUEST_COOKIE = 'lm_guest';
const GUEST_MAX_AGE = 60 * 60 * 24 * 400; // a browser caps a cookie at 400 days

const nowIso = () => new Date().toISOString();

/* ---------------------------------------------------------------- the tools */

/**
 * THE TOOLS AND THEIR ORDER. `needs` lists the tools whose work this one reads:
 * a tool is ready when every one of them is done, and needs an update when
 * any of them changed after it last ran. A tool that needs nothing can run at
 * any point. `url` is filled with the map's id; `{lawnmap}` and `{home}` with
 * the two hosts. `entry` is true for a tool that can start a map by itself
 * (the shade map's own address search), which the dashboard offers beside
 * "New map".
 *
 * `note`, when set, is a warning the dashboard prints on the tool's card.
 *
 * 'lawn' is the lawn mapper's own record (the maps row), not a map_tools row.
 */
export const TOOLS = [
  { id: 'lawn', name: 'Lawn Mapper', blurb: 'Measure the lawn from the address: the property line, the lawn, its square footage.',
    needs: [], url: 'https://{lawnmap}/?map={id}' },
  { id: 'slices', name: 'Calibrate product usage by area', blurb: 'Split the lawn into measured pieces to check a spreader or sprayer against the bag.',
    needs: ['lawn'], url: 'https://{lawnmap}/?map={id}&tool=slices' },
  /* Lawn sections (owner, 2026-10-27: "Let's add the lawn slice tool", its
     own tool on the dashboard): the lawn cut into named sections that add
     up to the whole. public/sections.html. */
  { id: 'sections', name: 'Lawn sections', blurb: 'Cut the lawn into named sections (front, back, side), each with its size.',
    needs: ['lawn'], url: 'https://{lawnmap}/sections?map={id}' },
  { id: 'shade', name: 'Shade analyzer', blurb: 'The trees around the lawn in 3D from lidar, and the sun and shade through the year.',
    needs: [], url: 'https://{shade}?map={id}', entry: 'https://{shade}' },
  { id: 'water', name: 'Water map', blurb: 'Where rain and irrigation go on this lawn, and how much to water.',
    needs: ['shade'], url: 'https://water.{home}/?map={id}',
    /* Shown on the card under the blurb (owner, 2026-10-23). */
    note: 'Highly experimental and early in development.' },
  /* The yard AR tool (owner, 2026-11-01; docs/SCAN-PLAN.md): walk the lawn, aim at a sprinkler head, tap. Its own
     Worker at scan.<home> (scan/). ADMIN ONLY while phase 1, the tracking test on both phones, is measured. It needs
     the shade map because that is where the lot's lidar and its photo line-up come from (phase 2). */
  { id: 'scan', name: 'Yard AR', blurb: 'Walk the lawn with the camera on: place sprinkler heads where you see them, and later see the shade and water results on the real lawn.',
    needs: ['shade'], url: 'https://scan.{home}/?map={id}', note: 'Experimental: a tracking test, on the admin account only.', admin: true },
];
const TOOL_IDS = new Set(TOOLS.map((t) => t.id));
export const isTool = (id) => TOOL_IDS.has(id) && id !== 'lawn';

/* ------------------------------------------------------------------ domains */

/**
 * The domain a cookie is shared across: the home domain, for any host under it
 * (lawnmap.nilesandstuff.com, water.nilesandstuff.com and nilesandstuff.com
 * itself all give nilesandstuff.com). Null where a shared cookie would be
 * refused or wrong: localhost, an IP, and *.workers.dev / *.pages.dev, which
 * are public suffixes a browser will not set a cookie on.
 */
export function homeDomainOf(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h || h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':')) return null;
  if (/\.(workers|pages)\.dev$/.test(h)) return null;
  const parts = h.split('.');
  if (parts.length < 2) return null;
  return parts.length >= 3 ? parts.slice(1).join('.') : h;
}

/** The two hosts a tool url is written in terms of, from any host under home. */
/*
 * `shade` is the shade map's own address (owner, 2026-10-18:
 * shade.<home>, shade-site/), written with its trailing slash so a tool url
 * is 'https://{shade}?map={id}'. With no home domain (workers.dev, a local
 * run) there is no subdomain, and the shade map is lawnmap's own /shade.
 */
export function hostsOf(host) {
  const home = homeDomainOf(host);
  if (!home) return { home: host, lawnmap: host, shade: `${host}/shade` };
  return { home, lawnmap: `lawnmap.${home}`, shade: `shade.${home}/` };
}

/**
 * The tools as one asker sees them. A tool marked `admin` is still being built
 * and is listed only for an admin account (owner, 2026-10-16: the water map,
 * "for the admin account only at this point"); everyone else never sees it.
 * The water map was, until it opened to everyone on 2026-10-23 (owner, to
 * the water session: "Make the water map accessible to everyone now"); the
 * yard AR tool is, since 2026-11-01 (docs/SCAN-PLAN.md phase 1).
 */
export function toolsFor(host, { admin = false } = {}) {
  const { home, lawnmap, shade } = hostsOf(host);
  const fill = (u) => u && u.replace('{home}', home).replace('{lawnmap}', lawnmap).replace('{shade}', shade);
  return TOOLS.filter((t) => admin || !t.admin)
    .map((t) => ({ ...t, url: fill(t.url), entry: fill(t.entry) }));
}

/* ------------------------------------------------------------------ cookies */

/** Every value of one cookie: a host-only and a domain-wide copy can both arrive. */
export function readCookies(request, name) {
  const out = [];
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      const v = part.slice(at + 1).trim();
      if (v) out.push(v);
    }
  }
  return out;
}

/** A cookie for the whole home domain when there is one, host-only otherwise. */
export function sharedCookie(name, value, { maxAge, secure = true, host }) {
  const bits = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  const domain = homeDomainOf(host);
  if (domain) bits.push(`Domain=${domain}`);
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Clear a cookie both ways: the host-only copy and the domain-wide one. */
export function clearCookie(name, { secure = true, host }) {
  const host1 = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) host1.push('Secure');
  const out = [host1.join('; ')];
  if (homeDomainOf(host)) out.push(sharedCookie(name, '', { maxAge: 0, secure, host }));
  return out;
}

/* ------------------------------------------------------------------- guests */

/** The guest this browser is, or null. Touches it so it is not swept. */
export async function findGuest(request, env) {
  if (!env?.DB) return null;
  for (const token of readCookies(request, GUEST_COOKIE)) {
    const id = await hash(token);
    const row = await env.DB.prepare('SELECT id FROM guests WHERE id = ?').bind(id).first();
    if (row) {
      await env.DB.prepare('UPDATE guests SET seen_at = ? WHERE id = ?').bind(nowIso(), id).run();
      return { id, token };
    }
  }
  return null;
}

/** A new guest and the Set-Cookie that makes this browser it. */
export async function newGuest(request, env) {
  const token = newSecret();
  const id = await hash(token);
  const t = nowIso();
  await env.DB.prepare('INSERT INTO guests (id, created_at, seen_at) VALUES (?, ?, ?)').bind(id, t, t).run();
  const url = new URL(request.url);
  return {
    guest: { id, token },
    cookie: sharedCookie(GUEST_COOKIE, token, { maxAge: GUEST_MAX_AGE, secure: url.protocol === 'https:', host: url.host }),
  };
}

/** Guests not seen for GUEST_IDLE_DAYS go, with their maps and tools. */
export async function sweepGuests(env) {
  if (!env?.DB) return;
  const before = new Date(Date.now() - GUEST_IDLE_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM map_tools WHERE owner_kind = 'guest' AND owner_id IN (SELECT id FROM guests WHERE seen_at < ?)`).bind(before),
    env.DB.prepare(`DELETE FROM guest_maps WHERE guest_id IN (SELECT id FROM guests WHERE seen_at < ?)`).bind(before),
    env.DB.prepare('DELETE FROM guests WHERE seen_at < ?').bind(before),
  ]);
}

/* ------------------------------------------------------------------- owners */

/** An owner: { kind: 'user' | 'guest', id, max }. */
/* An administrator keeps more (2026-11-11): the admin saves (admin-saves.js) are test maps made by the dozen, and
   upsertMap deletes whatever falls off the end of an owner's newest `max`. Every other account: fifty, as before. */
export const ADMIN_MAX_MAPS = 500;
export const userOwner = (user) => ({ kind: 'user', id: user.id, max: user?.role === 'admin' ? ADMIN_MAX_MAPS : USER_MAX_MAPS });
export const guestOwner = (guest) => ({ kind: 'guest', id: guest.id, max: GUEST_MAX_MAPS });

const T = (owner) => (owner.kind === 'user'
  ? { table: 'maps', col: 'user_id' }
  : { table: 'guest_maps', col: 'guest_id' });

const asSave = (row) => {
  let payload = {};
  try { payload = JSON.parse(row.payload) || {}; } catch { payload = {}; }
  return { ...payload, id: row.key, at: row.updated_at };
};

/** Every map of an owner, newest first, each with its tools' dates. */
export async function listMaps(env, owner) {
  const { table, col } = T(owner);
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE ${col} = ? ORDER BY updated_at DESC LIMIT ?`
  ).bind(owner.id, owner.max).all();
  const tools = await env.DB.prepare(
    'SELECT map_key, tool, based_on, updated_at FROM map_tools WHERE owner_kind = ? AND owner_id = ?'
  ).bind(owner.kind, owner.id).all();
  const byMap = new Map();
  for (const t of tools.results || []) {
    if (!byMap.has(t.map_key)) byMap.set(t.map_key, {});
    byMap.get(t.map_key)[t.tool] = { updatedAt: t.updated_at, basedOn: t.based_on };
  }
  return (results || []).map((r) => ({ ...asSave(r), tools: byMap.get(r.key) || {} }));
}

/** One map with every tool's data, or null. */
export async function getMap(env, owner, key) {
  const { table, col } = T(owner);
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${col} = ? AND key = ?`).bind(owner.id, key).first();
  if (!row) return null;
  const { results } = await env.DB.prepare(
    'SELECT tool, data, based_on, updated_at FROM map_tools WHERE owner_kind = ? AND owner_id = ? AND map_key = ?'
  ).bind(owner.kind, owner.id, key).all();
  const tools = {};
  for (const t of results || []) {
    let data = null;
    try { data = JSON.parse(t.data); } catch { data = null; }
    tools[t.tool] = { data, basedOn: t.based_on, updatedAt: t.updated_at };
  }
  return { ...asSave(row), tools };
}

async function countOthers(env, owner, key) {
  const { table, col } = T(owner);
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ? AND key != ?`).bind(owner.id, key).first();
  return Number(r?.n || 0);
}

/**
 * Write the lawn mapper's record of one map. A guest at its one map gets
 * { error: 'guest-limit' } for a second; an account keeps its newest fifty.
 */
export async function upsertMap(env, owner, map) {
  const key = String(map?.id || '').trim();
  if (!key || !map?.address) return { error: 'bad-map' };
  if (owner.kind === 'guest' && await countOthers(env, owner, key) >= owner.max) return { error: 'guest-limit' };
  const payload = { ...map };
  delete payload.rowId;
  delete payload.tools; // a tool's part is never written through the lawn mapper's record
  const t = nowIso();
  const vals = [
    String(map.address).slice(0, 200),
    Number.isFinite(map.lng) ? map.lng : null,
    Number.isFinite(map.lat) ? map.lat : null,
    map.county ? String(map.county).slice(0, 60) : null,
    map.model ? String(map.model).slice(0, 40) : null,
    map.mode ? String(map.mode).slice(0, 20) : null,
    Number.isFinite(map.squareFeet) ? Math.round(map.squareFeet) : null,
    JSON.stringify(payload),
  ];
  const set = `address = excluded.address, lng = excluded.lng, lat = excluded.lat,
       county = excluded.county, model = excluded.model, mode = excluded.mode,
       square_feet = excluded.square_feet, payload = excluded.payload, updated_at = excluded.updated_at`;
  if (owner.kind === 'user') {
    await env.DB.prepare(
      `INSERT INTO maps (id, user_id, key, address, lng, lat, county, model, mode, square_feet, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, key) DO UPDATE SET ${set}`
    ).bind(newId('map'), owner.id, key, ...vals, t, t).run();
    // The newest fifty, and the tools of any map that falls off.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM maps WHERE user_id = ? AND id NOT IN (
         SELECT id FROM maps WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?)`).bind(owner.id, owner.id, owner.max),
      env.DB.prepare(`DELETE FROM map_tools WHERE owner_kind = 'user' AND owner_id = ?
         AND map_key NOT IN (SELECT key FROM maps WHERE user_id = ?)`).bind(owner.id, owner.id),
    ]);
  } else {
    await env.DB.prepare(
      `INSERT INTO guest_maps (guest_id, key, address, lng, lat, county, model, mode, square_feet, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guest_id, key) DO UPDATE SET ${set}`
    ).bind(owner.id, key, ...vals, t, t).run();
  }
  return { key, at: t };
}

export async function deleteMap(env, owner, key) {
  const { table, col } = T(owner);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${table} WHERE ${col} = ? AND key = ?`).bind(owner.id, key),
    env.DB.prepare('DELETE FROM map_tools WHERE owner_kind = ? AND owner_id = ? AND map_key = ?').bind(owner.kind, owner.id, key),
  ]);
  await deleteModels(env, owner, key);
}

/*
 * THE FINISHED LIDAR MODEL (core session, 2026-11-04; public/lib/lidar-model.js): one binary file per map and tool,
 * written by the tool that builds it (the shade map) and read by every other, kept in the CORPUS bucket under
 * models/<owner kind>/<owner id>/<sha-256 of the map key>/<tool>.bin. The map key can hold anything (an address
 * once did), so it is hashed, never written into a key. Deleting the map deletes its models; signing in moves a
 * guest's along with the maps (adoptGuest).
 */
/* THE SIZE OF A MODEL (2026-11-05; the owner's lot came to 23.1 MB raw against the first cap of 24 MB). Every file
   is KEPT GZIPPED: a lot is mostly empty air, and gzip takes the owner's real file from 23.1 MB to 1.29 MB. A writer may send it packed (public/lib/lidar-model.js packModel, the small upload) or raw, which this
   gzips while it streams in, so a raw upload never sits whole in the Worker's 128 MB.
     MODEL_MAX_UPLOAD  what may come in: under the 100 MB request body Cloudflare takes on a Free or Pro zone
     MODEL_MAX_STORED  what is kept, gzipped: room for a lot many times the owner's, inside the Worker's memory */
const modelPrefix = async (owner, key) => `models/${owner.kind}/${owner.id}/${await hash(key)}/`;
export async function modelKey(owner, key, tool) { return `${await modelPrefix(owner, key)}${tool}.bin`; }
export const MODEL_MAX_UPLOAD = 95 * 1024 * 1024;
export const MODEL_MAX_STORED = 48 * 1024 * 1024;
const MAGIC = [0x4c, 0x4d, 0x44, 0x4c]; // "LMDL"

/** The bytes to keep from an upload stream: gzip as it came, or gzipped here. { bytes } or { error }. */
export async function storedModelBytes(body, { maxIn = MODEL_MAX_UPLOAD, maxOut = MODEL_MAX_STORED } = {}) {
  if (!body) return { error: 'empty' };
  const reader = body.getReader();
  let head = new Uint8Array(0);
  while (head.length < 4) { const { done, value } = await reader.read(); if (done) break; const n = new Uint8Array(head.length + value.length); n.set(head); n.set(value, head.length); head = n; }
  if (head.length < 4) return { error: 'empty' };
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  if (!gz && !MAGIC.every((v, i) => head[i] === v)) return { error: 'not-a-model' };
  if (head.length > maxIn) { await reader.cancel(); return { error: 'too-big', max: maxIn }; }
  let seen = head.length, over = false;
  const stream = new ReadableStream({
    start(c) { c.enqueue(head); },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) { c.close(); return; }
      seen += value.length;
      if (seen > maxIn) { over = true; c.error(new Error('too-big')); return; }
      c.enqueue(value);
    },
  });
  const out = (gz ? stream : stream.pipeThrough(new CompressionStream('gzip'))).getReader();
  const parts = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await out.read();
      if (done) break;
      total += value.length;
      if (total > maxOut) { await out.cancel(); return { error: 'too-big', max: maxOut }; }
      parts.push(value);
    }
  } catch { return over ? { error: 'too-big', max: maxIn } : { error: 'unreadable' }; }
  const bytes = new Uint8Array(total); let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  return { bytes, gzipped: !gz };
}

export async function putModel(env, owner, key, tool, body, contentLength = 0) {
  if (!isTool(tool)) return { error: 'unknown-tool' };
  if (!env.CORPUS) return { error: 'no-bucket' };
  if (contentLength > MODEL_MAX_UPLOAD) return { error: 'too-big', max: MODEL_MAX_UPLOAD };
  const { table, col } = T(owner);
  const exists = await env.DB.prepare(`SELECT 1 AS y FROM ${table} WHERE ${col} = ? AND key = ?`).bind(owner.id, key).first();
  if (!exists) return { error: 'no-map' };
  const got = await storedModelBytes(body);
  if (got.error) return got;
  const t = nowIso();
  await env.CORPUS.put(await modelKey(owner, key, tool), got.bytes, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { at: t, tool } });
  return { tool, at: t, bytes: got.bytes.byteLength, gzippedHere: got.gzipped };
}

/** The model's R2 object, or null. */
export async function getModel(env, owner, key, tool) {
  if (!isTool(tool) || !env.CORPUS) return null;
  return env.CORPUS.get(await modelKey(owner, key, tool));
}

export async function deleteModels(env, owner, key) {
  if (!env?.CORPUS) return;
  const prefix = await modelPrefix(owner, key);
  const listed = await env.CORPUS.list({ prefix });
  for (const o of listed.objects || []) await env.CORPUS.delete(o.key);
}

/** A guest's models become the account's (an object the account already has for the same map and tool stays). */
async function adoptModels(env, guestId, userId, keys) {
  if (!env?.CORPUS) return;
  for (const key of keys) {
    const from = await modelPrefix({ kind: 'guest', id: guestId }, key), to = await modelPrefix({ kind: 'user', id: userId }, key);
    const listed = await env.CORPUS.list({ prefix: from });
    for (const o of listed.objects || []) {
      const dest = to + o.key.slice(from.length);
      if (!(await env.CORPUS.head(dest))) { const obj = await env.CORPUS.get(o.key); if (obj) await env.CORPUS.put(dest, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata }); }
      await env.CORPUS.delete(o.key);
    }
  }
}

/**
 * One tool's part of one map. The map must exist and belong to the owner;
 * `basedOn` is the base map's `at` the tool worked from.
 */
export async function putTool(env, owner, key, tool, data, basedOn) {
  if (!isTool(tool)) return { error: 'unknown-tool' };
  const body = JSON.stringify(data ?? null);
  if (body.length > TOOL_MAX_BYTES) return { error: 'too-big', max: TOOL_MAX_BYTES };
  const { table, col } = T(owner);
  const exists = await env.DB.prepare(`SELECT 1 AS y FROM ${table} WHERE ${col} = ? AND key = ?`).bind(owner.id, key).first();
  if (!exists) return { error: 'no-map' };
  const t = nowIso();
  await env.DB.prepare(
    `INSERT INTO map_tools (owner_kind, owner_id, map_key, tool, data, based_on, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_kind, owner_id, map_key, tool) DO UPDATE SET
       data = excluded.data, based_on = excluded.based_on, updated_at = excluded.updated_at`
  ).bind(owner.kind, owner.id, key, tool, body, basedOn ? String(basedOn).slice(0, 40) : null, t).run();
  return { tool, at: t };
}

/**
 * SIGNING IN TAKES THE GUEST'S MAP ALONG. Its maps become the account's (a map
 * the account already has under the same key keeps whichever is newer), its
 * tools follow, and the guest is deleted.
 */
export async function adoptGuest(env, guestId, userId) {
  if (!env?.DB || !guestId || !userId) return 0;
  const { results } = await env.DB.prepare('SELECT * FROM guest_maps WHERE guest_id = ?').bind(guestId).all();
  for (const r of results || []) {
    await env.DB.prepare(
      `INSERT INTO maps (id, user_id, key, address, lng, lat, county, model, mode, square_feet, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, key) DO UPDATE SET
         address = excluded.address, lng = excluded.lng, lat = excluded.lat, county = excluded.county,
         model = excluded.model, mode = excluded.mode, square_feet = excluded.square_feet,
         payload = excluded.payload, updated_at = excluded.updated_at
       WHERE excluded.updated_at > maps.updated_at`
    ).bind(newId('map'), userId, r.key, r.address, r.lng, r.lat, r.county, r.model, r.mode, r.square_feet,
      r.payload, r.created_at, r.updated_at).run();
  }
  await adoptModels(env, guestId, userId, (results || []).map((r) => r.key)).catch(() => {});
  await env.DB.batch([
    // A tool row the account already has for the same map stays; the guest's copy goes.
    env.DB.prepare(`UPDATE OR IGNORE map_tools SET owner_kind = 'user', owner_id = ?
       WHERE owner_kind = 'guest' AND owner_id = ?`).bind(userId, guestId),
    env.DB.prepare(`DELETE FROM map_tools WHERE owner_kind = 'guest' AND owner_id = ?`).bind(guestId),
    env.DB.prepare('DELETE FROM guest_maps WHERE guest_id = ?').bind(guestId),
    env.DB.prepare('DELETE FROM guests WHERE id = ?').bind(guestId),
  ]);
  return (results || []).length;
}
