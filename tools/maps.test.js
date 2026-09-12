/**
 * Saved maps in an account, and who pays for a detection.
 *
 * Both against a real SQLite database with the real schema, through the real
 * route handlers -- so what is exercised is the SQL that does the work: the
 * UNIQUE constraint that makes re-measuring update rather than duplicate, and
 * the conditional UPDATE that stops two presses spending one credit twice.
 *
 *   node tools/maps.test.js
 */

import { testDb } from './d1.js';
import { handleMaps, MAX_MAPS } from '../worker/src/routes-maps.js';
import { charge, refund, allowance } from '../worker/src/allowance.js';
import { findOrCreateUser, createSession, publicUser } from '../worker/src/db.js';
import { SESSION_COOKIE } from '../worker/src/auth.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const json = (data, status) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

/** A KV stand-in, for the address backstop that applies to everyone. */
const kv = () => {
  const store = new Map();
  return {
    store,
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
  };
};

const ctx = { waitUntil() {} };

async function signedInEnv(extra = {}) {
  const env = { DB: testDb(), QUOTA: kv(), ...extra };
  const user = await findOrCreateUser(env, {
    email: extra.email || 'a@b.com', provider: 'email', subject: 'a',
  });
  const { token } = await createSession(env, user.id);
  return { env, user, token };
}

const asUser = (token, { method = 'GET', body = null, path = '/api/maps' } = {}) =>
  new Request(`https://site.test${path}`, {
    method,
    headers: {
      Cookie: token ? `${SESSION_COOKIE}=${token}` : '',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const call = async (env, req) => {
  const url = new URL(req.url);
  return (await handleMaps(req, env, url, '', ctx, json)).json();
};

const sample = (over = {}) => ({
  id: '7315 brooks lane|sam3_exclude|exclude',
  address: '7315 Brooks Lane',
  lng: -85.6, lat: 43.0, county: 'Ottawa',
  model: 'sam3_exclude', mode: 'exclude',
  squareFeet: 42727,
  shapes: [{ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }],
  ...over,
});

/* ------------------------------------------------------------ signed out */
/*
 * NOT AN ERROR. A signed-out visitor falls back to their own browser's store,
 * and answering 401 would make a perfectly ordinary state look like something
 * had gone wrong.
 */
{
  const env = { DB: testDb() };
  const out = await call(env, asUser(null));
  check('a signed-out request is answered, not refused',
    out.signedIn === false && Array.isArray(out.maps) && out.maps.length === 0,
    JSON.stringify(out));
}

/* With no database at all, the route says so rather than throwing. */
{
  const res = await handleMaps(asUser(null), {}, new URL('https://s/api/maps'), '', ctx, json);
  check('with no account store, the route says so plainly', res.status === 501,
    String(res.status));
}

/* ------------------------------------------------------- keeping a map */
{
  const { env, token } = await signedInEnv();

  await call(env, asUser(token, { method: 'POST', body: sample() }));
  const list = await call(env, asUser(token));
  check('a map is kept against the account',
    list.maps.length === 1 && list.maps[0].address === '7315 Brooks Lane',
    JSON.stringify(list.maps.map((m) => m.address)));
  check('and comes back whole, not just the columns',
    list.maps[0].shapes?.length === 1 && list.maps[0].squareFeet === 42727,
    'restoring must never depend on the table keeping up with what a save is made of');

  /*
   * THE SAME THREE THINGS MAKE THE SAME MAP: address, method, arithmetic.
   * Re-measuring the same lot the same way updates that one rather than
   * piling up a third -- enforced by a UNIQUE constraint rather than by the
   * application remembering to.
   */
  await call(env, asUser(token, { method: 'POST', body: sample({ squareFeet: 41000 }) }));
  const again = await call(env, asUser(token));
  check('re-measuring the same lot the same way updates that map',
    again.maps.length === 1 && again.maps[0].squareFeet === 41000,
    `${again.maps.length} map(s), ${again.maps[0].squareFeet} sq ft`);

  /* But the other arithmetic is a different answer worth keeping beside it. */
  await call(env, asUser(token, {
    method: 'POST',
    body: sample({ id: '7315 brooks lane|sam3|find', mode: 'find', model: 'sam3' }),
  }));
  const both = await call(env, asUser(token));
  check('while the same address measured the other way is a second map',
    both.maps.length === 2, `${both.maps.length} maps`);
}

/* One account cannot see another's. */
{
  const { env, token } = await signedInEnv();
  await call(env, asUser(token, { method: 'POST', body: sample() }));

  const other = await findOrCreateUser(env, { email: 'other@b.com', provider: 'email', subject: 'o' });
  const otherToken = (await createSession(env, other.id)).token;
  const theirs = await call(env, asUser(otherToken));
  check('one account cannot see another account\'s maps',
    theirs.maps.length === 0, `${theirs.maps.length} leaked`);
}

/* Deleting, and refusing to delete without saying which. */
{
  const { env, token } = await signedInEnv();
  await call(env, asUser(token, { method: 'POST', body: sample() }));

  const bad = await handleMaps(
    asUser(token, { method: 'DELETE' }), env,
    new URL('https://site.test/api/maps'), '', ctx, json
  );
  check('a delete with no id is refused', bad.status === 400, String(bad.status));

  await handleMaps(
    asUser(token, { method: 'DELETE' }), env,
    new URL(`https://site.test/api/maps?id=${encodeURIComponent(sample().id)}`), '', ctx, json
  );
  check('and one with an id removes it',
    (await call(env, asUser(token))).maps.length === 0);
}

/* A pile at once, which is what the first sign-in sends. */
{
  const { env, token } = await signedInEnv();
  const many = Array.from({ length: 8 }, (_, i) =>
    sample({ id: `lot ${i}|sam3|find`, address: `${i} Example St` }));

  const out = await call(env, asUser(token, { method: 'POST', body: { maps: many } }));
  check('a browser\'s whole store can be handed up in one request',
    out.saved === 8, `${out.saved} saved`);
  check('and all of it is there',
    (await call(env, asUser(token))).maps.length === 8,
    'doing this one at a time on a phone connection is how a migration half-finishes');
}

/* The cap is enforced by keeping the newest, not by refusing the newest. */
{
  const { env, token } = await signedInEnv();
  const over = Array.from({ length: MAX_MAPS + 10 }, (_, i) =>
    sample({ id: `lot ${i}|sam3|find`, address: `${i} Example St` }));
  await call(env, asUser(token, { method: 'POST', body: { maps: over } }));

  const kept = await call(env, asUser(token));
  check('an account keeps a bounded number of maps',
    kept.maps.length <= MAX_MAPS, `${kept.maps.length} of ${MAX_MAPS}`);
}

/* A map with nothing to identify it is not stored as a blank row. */
{
  const { env, token } = await signedInEnv();
  await call(env, asUser(token, { method: 'POST', body: { id: '', address: '' } }));
  check('a map with no address is dropped rather than half-stored',
    (await call(env, asUser(token))).maps.length === 0);
}

/* ----------------------------------------------------------- who pays */
/*
 * Signed out: today's allowance, counted per browser and per address.
 * Signed in: credits, which are the account's and do not reset.
 */
{
  const env = { DB: testDb(), QUOTA: kv() };
  const req = new Request('https://site.test/api/segment', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });

  const anon = await charge(req, env, { user: null, clientId: 'c1', n: 2 });
  check('a signed-out press spends the daily allowance',
    anon.allowed && anon.paidWith === 'allowance', JSON.stringify(anon));

  const seen = await allowance(req, env, { user: null, clientId: 'c1' });
  check('and is told about an allowance, which resets', seen.kind === 'daily', seen.kind);
}

{
  const { env, user } = await signedInEnv();
  const req = new Request('https://site.test/api/segment', { headers: { 'CF-Connecting-IP': '5.6.7.8' } });

  const paid = await charge(req, env, { user, clientId: 'c1', n: 2, detail: 'two passes' });
  check('a signed-in press spends credits instead',
    paid.allowed && paid.paidWith === 'credits' && paid.spent === 2,
    JSON.stringify(paid));
  check('and the balance goes down by what it cost',
    paid.credits === user.credits - 2, `${user.credits} -> ${paid.credits}`);

  const seen = await allowance(req, env, { user: { ...user, credits: paid.credits }, clientId: 'c1' });
  check('and is told about credits, which do not reset', seen.kind === 'credits', seen.kind);
}

/* An empty balance refuses, and says so as its own thing. */
{
  const { env, user } = await signedInEnv();
  await env.DB.prepare('UPDATE users SET credits = 1 WHERE id = ?').bind(user.id).run();
  const req = new Request('https://site.test/api/segment', { headers: { 'CF-Connecting-IP': '9.9.9.9' } });

  const broke = await charge(req, env, { user: { ...user, credits: 1 }, clientId: 'c', n: 3 });
  check('a press that costs more than is left is refused',
    broke.allowed === false && broke.reason === 'no-credits', JSON.stringify(broke));

  /*
   * ALL OR NOTHING. Letting one of three passes through because that is what
   * was affordable produces a measurement missing two exclusions -- not a
   * smaller answer, a wrong one, with the missing concepts counted as lawn.
   */
  const left = await env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  check('and nothing is taken for the passes it could have afforded',
    left.credits === 1, `${left.credits} left`);
}

/* An unlimited account is never short, and is not charged. */
{
  const { env, user } = await signedInEnv({ ADMIN_EMAILS: 'a@b.com' });
  const req = new Request('https://site.test/api/segment', { headers: { 'CF-Connecting-IP': '2.2.2.2' } });
  const free = await charge(req, env, { user, clientId: 'c', n: 4 });
  check('the owner\'s account detects without paying',
    free.allowed && free.spent === 0 && free.unlimited === true, JSON.stringify(free));
}

/* -------------------------------------------------- the address backstop */
/*
 * THE PART WORTH DEFENDING. An account starts with a welcome balance, so
 * "make more accounts" is the obvious way to turn a cost guardrail into a
 * formality -- twenty free predictions at a time, as fast as you can click
 * through a sign-up. The per-address ceiling is what makes that tedious.
 */
{
  const { env, user } = await signedInEnv();
  await env.DB.prepare('UPDATE users SET credits = 10000 WHERE id = ?').bind(user.id).run();
  const rich = { ...user, credits: 10000 };
  const req = new Request('https://site.test/api/segment', { headers: { 'CF-Connecting-IP': '3.3.3.3' } });

  let refused = null;
  for (let i = 0; i < 200 && !refused; i++) {
    const out = await charge(req, env, { user: rich, clientId: 'c', n: 1 });
    if (!out.allowed) refused = out;
  }
  check('a signed-in account still meets the shared-address ceiling',
    refused?.reason === 'shared-network', JSON.stringify(refused));

  /* And being turned away by it must not have cost credits on the way. */
  const before = await env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  const again = await charge(req, env, { user: rich, clientId: 'c', n: 1 });
  const after = await env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  check('and that refusal costs nothing',
    again.allowed === false && after.credits === before.credits,
    `${before.credits} -> ${after.credits}`);
}

/* A refusal upstream gives the money back. */
{
  const { env, user } = await signedInEnv();
  const req = new Request('https://site.test/api/segment', { headers: { 'CF-Connecting-IP': '4.4.4.4' } });

  await charge(req, env, { user, clientId: 'c', n: 3 });
  const spent = await env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();

  await refund(req, env, { user: { ...user, credits: spent.credits }, clientId: 'c', n: 3 });
  const back = await env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  check('a detector that refuses does not keep the credits',
    back.credits === user.credits, `${user.credits} -> ${spent.credits} -> ${back.credits}`);
}

/* What the badge is told, which is not the same question in the two cases. */
{
  const { env, user } = await signedInEnv({ ADMIN_EMAILS: 'a@b.com' });
  const req = new Request('https://site.test/api/quota');
  const seen = await allowance(req, env, { user, clientId: 'c' });
  check('an unlimited account has no number to count down',
    seen.unlimited === true && seen.credits === null, JSON.stringify(seen));
  check('and the same is true of what reaches the browser',
    publicUser(user).credits === null);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
