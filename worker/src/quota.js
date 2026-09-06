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

async function bump(kv, key, limit) {
  const raw = await kv.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used >= limit) return { allowed: false, used, limit };
  await kv.put(key, String(used + 1), { expirationTtl: TTL_SECONDS });
  return { allowed: true, used: used + 1, limit };
}

async function unbump(kv, key) {
  const raw = await kv.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used <= 0) return;
  await kv.put(key, String(used - 1), { expirationTtl: TTL_SECONDS });
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
export async function checkQuota(request, env, clientId) {
  if (!env.QUOTA) return { allowed: true, used: 0, limit: DAILY_LIMIT_PER_CLIENT };

  const day = dayKey();
  const ip = clientIp(request);
  const byClient = await peek(env.QUOTA, `c:${day}:${clientId}`, DAILY_LIMIT_PER_CLIENT);
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
export async function consumeQuota(request, env, clientId) {
  if (!env.QUOTA) return { allowed: true, used: 0, limit: DAILY_LIMIT_PER_CLIENT };

  const day = dayKey();
  const ip = clientIp(request);

  const byClient = await bump(env.QUOTA, `c:${day}:${clientId}`, DAILY_LIMIT_PER_CLIENT);
  if (!byClient.allowed) return byClient;

  const byIp = await bump(env.QUOTA, `i:${day}:${ip}`, DAILY_LIMIT_PER_IP);
  if (!byIp.allowed) {
    // The client bump already landed. Hand it back -- being turned away by
    // the shared-network cap should not also cost a personal measurement.
    await unbump(env.QUOTA, `c:${day}:${clientId}`);
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
export async function refundQuota(request, env, clientId) {
  if (!env.QUOTA) return;
  const day = dayKey();
  await unbump(env.QUOTA, `c:${day}:${clientId}`);
  await unbump(env.QUOTA, `i:${day}:${clientIp(request)}`);
}

export { DAILY_LIMIT_PER_CLIENT, DAILY_LIMIT_PER_IP, clientIp };
