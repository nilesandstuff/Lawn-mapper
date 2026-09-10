/**
 * Measurement quota.
 *
 * Deliberately a cost guardrail, not real enforcement. Anyone determined can
 * clear storage or switch off wifi and get a fresh allowance -- that is
 * accepted. The job here is to stop a script from running a few thousand
 * SAM predictions against Jake's Replicate card overnight.
 *
 * Counted on IP *and* a browser-stored client id, whichever has used more.
 * IP alone is genuinely dangerous: carrier NAT puts thousands of mobile
 * users behind one address, so a strict per-IP cap could lock out every
 * Verizon customer in Grand Rapids after five of them try the tool. The
 * client id gives normal users their own bucket; the IP cap is the backstop
 * that a scraper rotating client ids still runs into.
 */

const DAILY_LIMIT_PER_CLIENT = 20;

/**
 * The allowance in developer mode.
 *
 * Tuning a prompt means running the same lot a dozen times, and exclude mode
 * spends one of these per ticked box -- so twenty is three or four real
 * experiments, which is not enough to answer a question with.
 *
 * NOT A PRIVILEGE, AND NOT GUARDED. The browser asks for this by sending a
 * flag, and anyone can send that flag. It is worth being blunt about why that
 * is acceptable rather than implying a check that does not exist: the unlock
 * key is a plain string in app.js that anybody can read, so no client-side
 * secret could make this stronger than it is. What actually caps the damage is
 * DAILY_LIMIT_PER_IP below, which developer mode does NOT raise -- so the
 * worst a stranger gains from finding the flag is their share of a per-address
 * ceiling that was already there.
 */
const DAILY_LIMIT_PER_DEV = 50;

const DAILY_LIMIT_PER_IP = 80; // generous -- shared/NAT addresses are real
// Long enough that a key always outlives the day it belongs to, whatever the
// offset. The key name is what resets the count; the TTL only sweeps up.
const TTL_SECONDS = 60 * 60 * 48;

/*
 * Which day it is, where the users are.
 *
 * This was the UTC date, which rolls over at 7 or 8 in the evening in
 * Michigan depending on daylight saving. So an allowance spent in the
 * afternoon came back a few hours later, and one spent at nine in the evening
 * was already on tomorrow's count -- both of which read as "the reset is
 * broken" because neither matches the day a person is having.
 *
 * en-CA formats as YYYY-MM-DD, which is what the key wants, and the timezone
 * database is available in Workers. If it ever is not, UTC is the fallback:
 * a wrong-by-hours reset beats a thrown error inside quota accounting.
 */
const RESET_ZONE = 'America/Detroit';

export function dayKey(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: RESET_ZONE }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    'unknown'
  );
}

/*
 * `n` is how many predictions this one press will run.
 *
 * Exclude mode charges per ticked box, because that is what Replicate charges:
 * four concepts is four predictions, four waits and four times the money. A
 * measurement that costs four times as much and one twentieth of the allowance
 * would be a guardrail that stops guarding the moment the interesting mode is
 * used.
 *
 * All or nothing, deliberately. Letting three of four passes through because
 * that is what was left would produce a measurement missing one exclusion,
 * which is not a smaller answer -- it is a wrong one, silently, with the
 * missing concept counted as lawn.
 */
async function bump(kv, key, limit, n = 1) {
  const raw = await kv.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used + n > limit) return { allowed: false, used, limit, wanted: n };
  await kv.put(key, String(used + n), { expirationTtl: TTL_SECONDS });
  return { allowed: true, used: used + n, limit };
}

async function unbump(kv, key, n = 1) {
  const raw = await kv.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used <= 0) return;
  await kv.put(key, String(Math.max(0, used - n)), { expirationTtl: TTL_SECONDS });
}

async function peek(kv, key, limit) {
  const raw = await kv.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  return { allowed: used < limit, used, limit };
}

/**
 * Check quota without consuming it. Use before showing the UI so the user
 * is told up front, not after they have drawn a boundary.
 */
export async function checkQuota(request, env, clientId, dev = false) {
  const limit = personalLimit(dev);
  if (!env.QUOTA) return { allowed: true, used: 0, limit };

  const day = dayKey();
  const ip = clientIp(request);
  const byClient = await peek(env.QUOTA, `c:${day}:${clientId}`, limit);
  const byIp = await peek(env.QUOTA, `i:${day}:${ip}`, DAILY_LIMIT_PER_IP);

  return byClient.allowed && byIp.allowed
    ? byClient
    : { ...(byClient.allowed ? byIp : byClient), allowed: false };
}

/**
 * Consume one measurement. Call this ONLY at the point real cost is
 * incurred -- the SAM prediction. Geocoding and parcel lookup are free
 * enough that charging quota for them just frustrates people who mistyped
 * an address.
 */
export async function consumeQuota(request, env, clientId, n = 1, dev = false) {
  const limit = personalLimit(dev);
  if (!env.QUOTA) return { allowed: true, used: 0, limit };

  const day = dayKey();
  const ip = clientIp(request);

  const byClient = await bump(env.QUOTA, `c:${day}:${clientId}`, limit, n);
  if (!byClient.allowed) return byClient;

  const byIp = await bump(env.QUOTA, `i:${day}:${ip}`, DAILY_LIMIT_PER_IP, n);
  if (!byIp.allowed) {
    // The client bump already landed. Hand it back -- being turned away by
    // the shared-network cap should not also cost a personal measurement.
    await unbump(env.QUOTA, `c:${day}:${clientId}`, n);
    return { ...byIp, allowed: false, reason: 'shared-network' };
  }

  return byClient;
}

/**
 * Give back a measurement that was charged but never delivered.
 *
 * Quota has to be taken *before* the Replicate call -- charging afterwards
 * would let a flood of parallel requests all pass the check at once. The cost
 * of that ordering is that a failed prediction still bills the user, and a
 * misconfiguration (wrong model slug, expired token) would burn every
 * visitor's daily allowance on errors that produced nothing. Refunding on
 * failure keeps the guardrail while making a broken deploy merely broken
 * rather than broken *and* locked out for the rest of the UTC day.
 */
export async function refundQuota(request, env, clientId, n = 1) {
  if (!env.QUOTA) return;
  const day = dayKey();
  await unbump(env.QUOTA, `c:${day}:${clientId}`, n);
  await unbump(env.QUOTA, `i:${day}:${clientIp(request)}`, n);
}

/**
 * One person's ceiling for today.
 *
 * The SAME counter either way -- developer mode raises the line, it does not
 * open a second bucket. Counting dev runs separately would let one browser
 * spend twenty ordinary detections and then fifty more by flipping a switch.
 */
const personalLimit = (dev) => (dev ? DAILY_LIMIT_PER_DEV : DAILY_LIMIT_PER_CLIENT);

export {
  DAILY_LIMIT_PER_CLIENT, DAILY_LIMIT_PER_DEV, DAILY_LIMIT_PER_IP,
  personalLimit, clientIp,
};
