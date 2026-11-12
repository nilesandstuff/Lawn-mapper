/**
 * Shared days, live (route session, 2026-11-06): a plan kept under a short
 * random id, for links each person opens on their own phone, and kept up to
 * date as stops are ticked and helpers come free (lib/live.js).
 *
 *   POST /api/share { plan }               -> { id }        a new shared day
 *   GET  /api/share/<id>                   -> the doc (lib/live.js)
 *   POST /api/share/<id>/tick { stop, done, by }  a stop ticked or unticked
 *   PUT  /api/share/<id> { version, people, events }  a re-split or a joiner;
 *        refused (409, with the doc as it is now) if anything changed since
 *        the page read it, so two phones can never overwrite each other
 *   /s/<id>                                the page that shows it (public/share.html)
 *
 * Kept in the planner's own D1 (the USAGE binding, database "route-planner"),
 * one row a day, 30 days from its last change. Days shared before this
 * (KV "share:<id>", read-only plans) are moved over the first time opened.
 *
 * The id is the only key: 12 random letters and digits, passed on by link,
 * not guessed. It holds customers' names and addresses.
 */

import { checkUpdate, MAX_EVENTS, planToLive } from '../lib/live.js';
import { messagesFor, notify } from './push.js';

export const KEEP_DAYS = 30;
const MAX_BYTES = 600 * 1024;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export function newId(n = 12) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
}

const ready = new WeakSet();
async function init(db) {
  if (ready.has(db)) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS live (id TEXT PRIMARY KEY, doc TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)').run();
  ready.add(db);
}

async function load(db, id) {
  const row = await db.prepare('SELECT doc, version FROM live WHERE id = ?1').bind(id).first();
  if (!row) return null;
  const doc = JSON.parse(row.doc);
  doc.version = row.version;
  return doc;
}

/** Save over the version read, or nothing (false) if someone else saved first. */
async function save(db, doc, readVersion, now) {
  doc.version = readVersion + 1;
  const body = JSON.stringify(doc);
  if (body.length > MAX_BYTES) throw Object.assign(new Error('Too big to keep'), { status: 413 });
  const r = await db.prepare('UPDATE live SET doc = ?1, version = ?2, updated_at = ?3 WHERE id = ?4 AND version = ?5')
    .bind(body, doc.version, now, doc.id, readVersion).run();
  return r.meta.changes === 1;
}

const str = (v, n) => String(v ?? '').slice(0, n);
const leg = (l) => {
  if (!l || !Number.isFinite(l.duration)) return null;
  const out = { duration: Math.round(l.duration * 10) / 10, distance: Math.round(Number(l.distance) || 0) };
  if (l.ride === 'road' || l.ride === 'yard') { out.ride = l.ride; out.saved = Math.max(0, Math.min(1800, Number(l.saved) || 0)); }
  return out;
};
const point = (p) => (p && Number.isFinite(p.lng) && Number.isFinite(p.lat) ? { lng: p.lng, lat: p.lat, label: str(p.label, 200) } : null);

/** Only the fields a person has, each in its shape. */
function cleanPerson(p) {
  const stops = (p.stops || []).map(String);
  const into = {};
  for (const s of stops) into[s] = leg(p.into?.[s]);
  const geometry = Array.isArray(p.geometry)
    ? p.geometry.slice(0, 6000).filter((x) => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite))
    : null;
  return {
    id: str(p.id, 20), name: str(p.name, 40).trim(), stops, into, back: leg(p.back), geometry,
    readyAt: Number.isFinite(p.readyAt) ? p.readyAt : null, start: point(p.start), free: Boolean(p.free), helper: Boolean(p.helper),
  };
}

export async function share(request, env, url, now = Date.now(), fetcher = fetch) {
  const db = env.USAGE;
  if (!db) return json({ error: 'No storage on this deploy' }, 503);
  await init(db);
  try {
    if (url.pathname === '/api/share' && request.method === 'POST') {
      const text = await request.text();
      if (text.length > MAX_BYTES) return json({ error: 'Too big to share' }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: 'Not JSON' }, 400); }
      const plan = body?.plan;
      if (!Array.isArray(plan?.people) || !plan.people.length || !plan.shop) return json({ error: 'A route, please' }, 400);
      const id = newId();
      const doc = planToLive(plan, { id, now });
      doc.people = doc.people.map(cleanPerson);
      await db.prepare('INSERT INTO live (id, doc, version, updated_at) VALUES (?1, ?2, 1, ?3)').bind(id, JSON.stringify(doc), now).run();
      await db.prepare('DELETE FROM live WHERE updated_at < ?1').bind(now - KEEP_DAYS * 86400000).run();
      return json({ id, keepDays: KEEP_DAYS }, 201);
    }
    const m = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,20})(\/tick)?$/);
    if (!m) return json({ error: 'Not found' }, 404);
    const [, id, tick] = m;
    let doc = await load(db, id);
    if (!doc && env.ROUTE) {
      // shared before days went live: move it over
      const old = await env.ROUTE.get(`share:${id}`);
      if (old) {
        doc = planToLive(JSON.parse(old).plan, { id, now });
        doc.people = doc.people.map(cleanPerson);
        await db.prepare('INSERT OR IGNORE INTO live (id, doc, version, updated_at) VALUES (?1, ?2, 1, ?3)').bind(id, JSON.stringify(doc), now).run();
        doc = await load(db, id);
      }
    }
    if (!doc) return json({ error: 'This link has expired or never existed' }, 404);
    if (request.method === 'GET' && !tick) return json(doc);

    if (tick && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const sid = String(body.stop || '');
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!doc.stops[sid]) return json({ error: 'No such stop' }, 400);
        doc.stops[sid].done = body.done ? { at: now, by: str(body.by, 40) } : null;
        const read = doc.version;
        if (await save(db, doc, read, now)) return json(doc);
        doc = await load(db, id);
      }
      return json({ error: 'Busy, try again' }, 503);
    }

    if (!tick && request.method === 'PUT') {
      const body = await request.json().catch(() => null);
      if (!body || body.version !== doc.version) return json({ error: 'Changed since you looked', doc }, 409);
      const people = (body.people || []).map(cleanPerson);
      const why = checkUpdate(doc, { people });
      if (why) return json({ error: why }, 400);
      const events = (Array.isArray(body.events) ? body.events : []).slice(0, 5).map((t) => ({ at: now, text: str(t, 200) })).filter((e) => e.text);
      const next = { ...doc, people, events: [...(doc.events || []), ...events].slice(-MAX_EVENTS) };
      if (!(await save(db, next, doc.version, now))) return json({ error: 'Changed since you looked', doc: await load(db, id) }, 409);
      // phones whose page is shut hear about it (src/push.js); never the one who did it
      try {
        await notify(env, id, messagesFor(doc, next, events.map((e) => e.text), { actor: str(body.by, 20) || null, id }), { fetcher, origin: url.origin, now });
      } catch { /* a re-split is saved whether or not a phone hears of it */ }
      return json(next);
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message || String(e) }, e.status || 500);
  }
}
