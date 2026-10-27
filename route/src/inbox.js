/**
 * Route sheets by email (route session, 2026-10-27).
 *
 * Service Autopilot emails route sheets from its Dispatch Board, and anyone
 * can forward one. Cloudflare Email Routing hands mail for the planner's
 * address to this Worker (the `email` handler in index.js); it is taken
 * apart here (lib/mail.js) and kept, and the page -- holding the inbox key --
 * fetches it and reads it exactly as it reads a picked file. Nothing is read
 * or routed on the server: the PDF, spreadsheet or HTML is parsed in the
 * browser, as everything else is.
 *
 * PRIVATE: route sheets are customers' names and addresses. So
 *   - the address is not in the repository (KV "inbox-address"),
 *   - reading needs the inbox key (X-Inbox-Key; its SHA-256 in KV
 *     "inbox-key-sha256") or the route session's key,
 *   - a message is kept 14 days at most, and only the 20 newest.
 */

import { parseMail } from '../lib/mail.js';
import { keyed, sha256 } from './store.js';

export const KEEP_DAYS = 14;
export const MAX_MESSAGES = 20;
const MAX_RAW = 20 * 1024 * 1024;
const MAX_VALUE = 24 * 1024 * 1024; // a KV value is at most 25 MiB

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** One email in: kept for the page. Refused only when it cannot be kept at all. */
export async function receive(message, env, now = Date.now()) {
  const kv = env.ROUTE;
  if (!kv) { message.setReject('This address is not taking mail right now.'); return null; }
  if (message.rawSize > MAX_RAW) { message.setReject('Too big: route sheets up to 20 MB.'); return null; }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const mail = parseMail(raw);
  const at = new Date(now).toISOString();
  const id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    id, at,
    from: String(message.from || mail.from || '').slice(0, 300),
    subject: String(mail.subject || '').slice(0, 300),
    text: String(mail.text || '').slice(0, 50000),
    html: String(mail.html || '').slice(0, 3000000),
    attachments: mail.attachments.map((a) => ({ name: a.name, type: a.type, size: a.bytes.length, base64: toBase64(a.bytes) })),
    dropped: [],
  };
  // too big for one KV value: drop the biggest attachments, and say so
  let body = JSON.stringify(record);
  while (body.length > MAX_VALUE && record.attachments.length) {
    record.attachments.sort((a, b) => b.size - a.size);
    record.dropped.push(record.attachments.shift().name);
    body = JSON.stringify(record);
  }
  await kv.put(`inbox:${id}`, body, {
    expirationTtl: KEEP_DAYS * 86400,
    metadata: { at, from: record.from.slice(0, 120), subject: record.subject.slice(0, 160), files: record.attachments.map((a) => a.name.slice(0, 80)).slice(0, 8) },
  });
  const { keys } = await kv.list({ prefix: 'inbox:' });
  const old = keys.map((k) => k.name).sort().reverse().slice(MAX_MESSAGES);
  for (const name of old) await kv.delete(name);
  return id;
}

async function allowed(request, env) {
  if (await keyed(request, env)) return true;
  const k = request.headers.get('X-Inbox-Key');
  if (!k) return false;
  const want = await env.ROUTE.get('inbox-key-sha256');
  return Boolean(want) && (await sha256(k)) === want;
}

/** /api/inbox: the list; /api/inbox/<id>: one message; /api/inbox/config: the address and key (route key). */
export async function inbox(request, env, url) {
  const kv = env.ROUTE;
  if (!kv) return json({ error: 'No storage on this deploy' }, 503);
  const m = request.method;
  if (url.pathname === '/api/inbox/config') {
    if (m !== 'PUT' || !(await keyed(request, env))) return json({ error: 'Not allowed' }, 403);
    const body = await request.json().catch(() => ({}));
    if (body.address) await kv.put('inbox-address', String(body.address).trim().toLowerCase());
    if (/^[0-9a-f]{64}$/.test(body.keySha256 || '')) await kv.put('inbox-key-sha256', body.keySha256);
    return json({ address: await kv.get('inbox-address'), key: Boolean(await kv.get('inbox-key-sha256')) });
  }
  if (!(await allowed(request, env))) return json({ error: 'Not allowed' }, 403);
  if (url.pathname === '/api/inbox' && m === 'GET') {
    const { keys } = await kv.list({ prefix: 'inbox:' });
    const messages = keys.sort((a, b) => (a.name < b.name ? 1 : -1)).map((k) => ({ id: k.name.slice(6), ...(k.metadata || {}) }));
    return json({ address: await kv.get('inbox-address'), keepDays: KEEP_DAYS, messages });
  }
  const id = url.pathname.match(/^\/api\/inbox\/([a-z0-9-]{6,40})$/)?.[1];
  if (!id) return json({ error: 'Not found' }, 404);
  if (m === 'GET') {
    const v = await kv.get(`inbox:${id}`);
    return v ? new Response(v, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) : json({ error: 'Gone' }, 404);
  }
  if (m === 'DELETE') { await kv.delete(`inbox:${id}`); return json({ deleted: true }); }
  return json({ error: 'Not found' }, 404);
}
