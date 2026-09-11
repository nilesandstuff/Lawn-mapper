/**
 * A record of what has been measured, for troubleshooting.
 *
 * "It got my back lawn wrong" is not reproducible without knowing which house,
 * which photograph and which settings. This keeps that, so a report can be
 * turned back into a probe run instead of a guess.
 *
 * WHAT THIS IS AND IS NOT. It is a testing log for a tool a handful of friends
 * are trying out, kept at the owner's explicit instruction. Two consequences
 * follow, and they are the reason this is a separate module rather than four
 * lines inside the segment handler:
 *
 *   - It stores street addresses, which say where identifiable people live.
 *     So it is WRITE-ONLY from the internet's point of view: nothing serves it
 *     back without the reading token, and there is no token by default. A
 *     deployment that never sets LOG_TOKEN cannot leak this even by accident,
 *     because the endpoint answers 404 rather than existing-but-refusing.
 *   - No IP address, and no user agent. Neither helps reproduce a bad
 *     measurement, and the client id already separates one tester from
 *     another. Collecting a field because it is available is how a testing
 *     log turns into something that needs a privacy policy.
 *
 * Entries expire on their own. This exists to debug the thing being built now,
 * not to accumulate.
 */

/** Ninety days: long enough for "it was wrong last month", short enough. */
const TTL_SECONDS = 60 * 60 * 24 * 90;

/** Newest first, so the key sorts that way without reading every value. */
const keyFor = (now) =>
  `log:${String(1e13 - now.getTime()).padStart(14, '0')}:${Math.random().toString(36).slice(2, 8)}`;

/** Trim free text so one enormous "address" cannot fill a value. */
const text = (v, max = 200) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/**
 * A number, or null when there wasn't one.
 *
 * The null and empty-string guards are not decoration: `Number(null)` is 0 and
 * `Number('')` is 0, so "no parcel record" logged as a parcel of 0 sq ft and
 * "several passes, so no single threshold" logged as a cut of 0 -- both of
 * them readings a person would try to explain rather than dismiss. A missing
 * measurement has to look missing.
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};

/**
 * Is logging switched on?
 *
 * Deliberately explicit rather than "on if the KV binding happens to exist".
 * Storing where people live should be a decision somebody made, visible as a
 * setting, not a side effect of infrastructure being present.
 */
export const loggingEnabled = (env) =>
  Boolean(env?.QUOTA) && /^(1|true|yes|on)$/i.test(String(env?.LOG_TESTS || ''));

/**
 * Register a write so it actually happens.
 *
 * THE FOOTGUN THIS EXISTS FOR: a Worker cancels any promise still pending when
 * the handler returns its Response. "Fire and forget" is not a thing here --
 * it is fire and have it killed a millisecond later. The log looked correct in
 * every test, wrote nothing in production, and reported `logging: true` while
 * storing not one entry.
 *
 * waitUntil is the mechanism that was actually wanted all along: it keeps the
 * request alive until the write settles WITHOUT making the response wait for
 * it. The instinct -- "a measurement must not wait on bookkeeping" -- was
 * right; the implementation of it was the bug.
 *
 * Falls back to returning the promise when there is no ctx, so a caller
 * without one (a test, a direct invocation) can await it instead of silently
 * dropping the write.
 */
export function recordLater(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
    return true;
  }
  return promise;
}

/**
 * Record one measurement attempt.
 *
 * Never throws and never blocks the answer. A measurement that worked must not
 * turn into an error because the bookkeeping failed -- the log is here to help
 * debug the product, and a log that can break the product is a bad trade.
 */
export async function logMeasurement(env, record) {
  if (!loggingEnabled(env)) return;
  try {
    const now = new Date();
    const entry = {
      at: now.toISOString(),
      address: text(record.address),
      lng: num(record.lng),
      lat: num(record.lat),
      zoom: num(record.zoom),
      provider: text(record.provider, 40),
      model: text(record.model, 40),
      // Exclude mode joins several as "man-made @0.05 + woods @0.2", because
      // each pass runs at its own confidence cut and a single `threshold`
      // field beside a joined prompt reported the first one as if it were all
      // of them. Pairs cannot be mismatched; a separate list beside a separate
      // list can.
      prompt: text(record.prompt, 200),
      // The cut, when exactly one pass ran. Null for several -- the prompt
      // field above is where those live, attached to the concept each belongs
      // to.
      threshold: num(record.threshold),
      // How many predictions one press ran. Exclude mode charges per ticked
      // box, so this is what turns a bill into an explanation.
      passes: num(record.passes),
      // What the county said the lot is, which is the yardstick every
      // complaint about a lawn figure is really being made against.
      parcelSqFt: num(record.parcelSqFt),
      county: text(record.county, 60),
      client: text(record.clientId, 40),
      outcome: text(record.outcome, 40),
      // Why, when the outcome alone does not say. A refusal by our own
      // allowance and a refusal by the detector read identically on screen and
      // are completely different problems; this is the field that separates
      // them without another round trip through somebody's memory.
      detail: text(record.detail, 120),
    };
    await env.QUOTA.put(keyFor(now), JSON.stringify(entry), {
      expirationTtl: TTL_SECONDS,
    });
  } catch {
    /* Bookkeeping is never worth a failed measurement. */
  }
}

/**
 * Read the log back, newest first.
 *
 * Returns null when there is no token configured or the one given is wrong,
 * so the caller can answer 404 -- the same response as a route that does not
 * exist. A 403 would confirm the log is there and worth attacking.
 */
export async function readLog(env, given, limit = 100) {
  const expected = env?.LOG_TOKEN;
  if (!expected || !given) return null;
  if (!timingSafeEqual(String(given), String(expected))) return null;
  if (!env?.QUOTA) return { entries: [] };

  const list = await env.QUOTA.list({ prefix: 'log:', limit: Math.min(limit, 1000) });
  const entries = [];
  for (const k of list.keys) {
    const raw = await env.QUOTA.get(k.name);
    if (!raw) continue;
    try { entries.push(JSON.parse(raw)); } catch { /* skip a corrupt entry */ }
  }
  return { entries, more: !list.list_complete };
}

/**
 * Compare without leaking the answer in how long it takes.
 *
 * `a === b` on a secret returns as soon as two characters differ, so the
 * comparison time reports how much of a guess was right and the token can be
 * recovered a character at a time. Overkill for a log of test addresses;
 * cheap enough that using the careless version would be a choice.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
