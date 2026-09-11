/**
 * "Was the AI's answer any good?" -- asked once, at the only moment anybody
 * knows.
 *
 * The question can only be answered at the handover: the detection is on
 * screen, the person has looked at it, and they are about to start correcting
 * it. Before that they have nothing to judge; after that they are busy and the
 * original answer is gone. So it is asked there, once, and never again for the
 * same measurement.
 *
 * WHERE THIS GOES, AND WHY IT IS NOT SOMEBODY ELSE'S ENDPOINT.
 *
 * A report is a street address, a property outline and a lawn shape -- which
 * together say where an identifiable person lives and what their garden looks
 * like. A form service, a webhook into a chat app, a spreadsheet in somebody's
 * cloud: each of those is a second organisation holding that, under terms
 * nobody read, for as long as they feel like. None of them does anything the
 * KV namespace already bound to this Worker cannot.
 *
 * So it stays here, in the same store as the test log and under the same rule:
 * WRITE-ONLY FROM THE INTERNET'S POINT OF VIEW. Nothing serves it back without
 * the reading token, there is no token unless one is configured, and the route
 * answers 404 rather than existing-but-refusing.
 *
 * WHAT IS KEPT, AND WHAT IS DELIBERATELY NOT. A report carries the map: the
 * boundary, the shapes, the frame and the settings, because "it was bad" is
 * not reproducible without them and an unreproducible complaint cannot be
 * fixed. It does not carry an IP address or a user agent. Neither helps look
 * at a bad lawn, and collecting a field because it is available is how a
 * testing log turns into something that needs a privacy policy.
 */

/** Six months: a season of imagery and a model revision or two. */
const TTL_SECONDS = 60 * 60 * 24 * 180;

/**
 * The four answers, and what each one means in the only terms that matter:
 * how much correcting it took, against doing it by hand from scratch.
 *
 * A five-star scale would collect an average nobody can act on. These are the
 * three decisions a person actually makes about a tool -- keep using it, use
 * it and fix it, or stop bothering -- and the answers sort straight into work
 * to do.
 */
export const RATINGS = {
  great: 'Little or no editing. Much faster than drawing it by hand.',
  close: 'Some editing needed. Somewhat faster than by hand.',
  bad: 'A lot of editing. As slow as drawing it by hand, or slower.',
};

/**
 * A report is capped, because the shapes are user data of unbounded size.
 *
 * A traced lawn on a wooded lot is a few tens of kilobytes; a malicious or
 * merely broken client could post megabytes. The cap is generous enough that
 * no real map hits it and small enough that the store cannot be filled.
 */
const MAX_BYTES = 96 * 1024;

/** How many reports one browser may file in a day. */
const DAILY_PER_CLIENT = 25;

/** Newest first, so the key sorts that way without reading every value. */
const keyFor = (now) =>
  `fb:${String(1e13 - now.getTime()).padStart(14, '0')}:${Math.random().toString(36).slice(2, 8)}`;

const text = (v, max = 200) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};

/**
 * Is this on?
 *
 * Explicit, like the test log's switch and for the same reason: storing where
 * people live should be a decision somebody made and can see, not a side
 * effect of a KV binding happening to exist.
 */
export const feedbackEnabled = (env) =>
  Boolean(env?.QUOTA) && /^(1|true|yes|on)$/i.test(String(env?.FEEDBACK || ''));

/**
 * Keep only the geometry, and only as much of it as is needed to look at.
 *
 * Whatever arrives is client-controlled, so nothing is stored by reference:
 * each ring is rebuilt from finite numbers, which drops properties, ids,
 * strings pretending to be coordinates, and any nesting deeper than a polygon.
 * A report that cannot be drawn is worthless; a report that can inject
 * arbitrary JSON into a review page is worse than worthless.
 */
function cleanGeometry(g, maxRings = 40, maxPoints = 3000) {
  if (!g || typeof g !== 'object') return null;
  const rings = g.type === 'Polygon' ? g.coordinates
    : g.type === 'MultiPolygon' ? (g.coordinates || []).flat()
      : null;
  if (!Array.isArray(rings)) return null;

  const out = [];
  let points = 0;
  for (const ring of rings.slice(0, maxRings)) {
    if (!Array.isArray(ring)) continue;
    const clean = [];
    for (const p of ring) {
      if (points >= maxPoints) break;
      const lng = Number(p?.[0]);
      const lat = Number(p?.[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      clean.push([round(lng), round(lat)]);
      points++;
    }
    if (clean.length >= 4) out.push(clean);
  }
  return out.length ? { type: 'Polygon', coordinates: out } : null;
}

/**
 * Six decimal places: about eleven centimetres.
 *
 * Not tidiness. A full double prints seventeen digits, and a lawn outline is
 * thousands of coordinates -- so the raw numbers are more than half the size of
 * a report, and the size of a report is what decides whether a complaint about
 * a complicated lawn gets stored at all. Eleven centimetres is an order of
 * magnitude finer than the satellite pixel any of this was traced from, so
 * nothing is lost that was ever there.
 *
 * Via toFixed rather than `Math.round(v * 1e6) / 1e6`: dividing by a power of
 * ten is not exact in binary, so that form hands back 43.000001000000004 for
 * about one coordinate in ten -- seventeen digits again, and the saving gone.
 */
const round = (v) => Number(v.toFixed(6));

const cleanShapes = (list) => (Array.isArray(list) ? list : [])
  .slice(0, 24)
  .map((f) => cleanGeometry(f?.geometry || f))
  .filter(Boolean);

/**
 * Record one report. Never throws: a measurement that worked must not turn
 * into an error because the bookkeeping failed.
 *
 * Returns what happened, so the route can answer honestly rather than saying
 * "thank you" to a write that did not land.
 */
export async function recordFeedback(env, body, request) {
  if (!feedbackEnabled(env)) return { ok: false, reason: 'off' };

  const rating = text(body?.rating, 20);
  if (!rating || !Object.prototype.hasOwnProperty.call(RATINGS, rating)) {
    return { ok: false, reason: 'rating' };
  }

  const client = text(body?.clientId, 40) || 'anon';
  const now = new Date();

  /*
   * One browser, one day, twenty-five reports.
   *
   * Not to ration honesty -- nobody measures twenty-five lawns a day in good
   * faith -- but because this route writes to a shared store on an unpaid
   * request, and an endpoint that will write forever is an endpoint that will
   * be made to.
   */
  const countKey = `fbc:${client}:${now.toISOString().slice(0, 10)}`;
  const used = Number(await env.QUOTA.get(countKey)) || 0;
  if (used >= DAILY_PER_CLIENT) return { ok: false, reason: 'too-many' };

  const entry = {
    at: now.toISOString(),
    rating,
    means: RATINGS[rating],
    // What the person typed, if anything. Feedback with a sentence attached is
    // worth ten without one, and "bad" with no detail is a mystery.
    note: text(body?.note, 500),
    address: text(body?.address),
    lng: num(body?.lng),
    lat: num(body?.lat),
    county: text(body?.county, 60),
    model: text(body?.model, 40),
    modelLabel: text(body?.modelLabel, 60),
    mode: text(body?.mode, 20),
    provider: text(body?.provider, 40),
    exclude: (Array.isArray(body?.exclude) ? body.exclude : [])
      .slice(0, 8).map((e) => text(e, 30)).filter(Boolean),
    edgeFt: num(body?.edgeFt),
    fillGaps: Boolean(body?.fillGaps),
    squareFeet: num(body?.squareFeet),
    parcelSqFt: num(body?.parcelSqFt),
    // The frame the detection actually ran in, so a review page can put the
    // same photograph back on screen rather than a guess at it.
    frame: body?.frame && typeof body.frame === 'object' ? {
      lng: num(body.frame.lng), lat: num(body.frame.lat),
      zoom: num(body.frame.zoom), size: num(body.frame.size),
    } : null,
    parcel: cleanGeometry(body?.parcel?.geometry || body?.parcel),
    shapes: cleanShapes(body?.shapes),
    client,
  };

  const payload = JSON.stringify(entry);
  if (payload.length > MAX_BYTES) return { ok: false, reason: 'too-big' };

  try {
    await env.QUOTA.put(keyFor(now), payload, { expirationTtl: TTL_SECONDS });
    // Counted after the write, so a rejected report does not spend an
    // allowance -- the same rule the detection quota learned the hard way.
    await env.QUOTA.put(countKey, String(used + 1), { expirationTtl: 60 * 60 * 36 });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'store' };
  }
}

/**
 * Read the reports back, newest first.
 *
 * Returns null when there is no token configured or the one given is wrong, so
 * the caller can answer 404 -- the same response as a route that does not
 * exist. A 403 would confirm this is here and worth attacking.
 */
export async function readFeedback(env, given, limit = 60) {
  const expected = env?.LOG_TOKEN;
  if (!expected || !given) return null;
  if (!timingSafeEqual(String(given), String(expected))) return null;
  if (!env?.QUOTA) return { entries: [] };

  const list = await env.QUOTA.list({ prefix: 'fb:', limit: Math.min(limit, 500) });
  const entries = [];
  for (const k of list.keys) {
    const raw = await env.QUOTA.get(k.name);
    if (!raw) continue;
    try { entries.push(JSON.parse(raw)); } catch { /* skip a corrupt entry */ }
  }
  return { entries, more: !list.list_complete };
}

/** Compare without leaking the answer in how long it takes. See testlog.js. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
