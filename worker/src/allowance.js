/**
 * Who pays for a detection, and how.
 *
 * ONE ARRANGEMENT NOW, WITH TWO SIZES. A signed-out visitor and a signed-in
 * one both get a daily allowance of AI passes that comes back in the morning;
 * signing in makes it bigger. That is the whole difference, and it is a
 * deliberate simplification of what was here before -- a signed-out allowance
 * beside a permanent credit balance meant the same number on screen meant
 * "wait until tomorrow" for one person and "buy more" for another.
 *
 * Bought credits still exist and still do not expire. They are spent only once
 * the day's free passes are gone, which is the only order that does not burn
 * something somebody paid for while a free pass sat unused beside it.
 *
 * quota.js knows about KV counters. db.js knows about SQL. Neither should have
 * to know which kind of person is asking, which is what this file is for.
 *
 * ---------------------------------------------------------------------------
 * WHY MAKING ACCOUNTS IS NOT A WAY ROUND THE LIMIT.
 *
 * The obvious attack on "an account gets more" is to make accounts. Three
 * things answer it, and only the second is a wall:
 *
 * 1. THERE IS NOTHING TO FARM. An account's allowance is daily, not a signing
 *    bonus -- so a fresh account buys tomorrow's passes today and nothing
 *    beyond that. A hundred accounts do not add up to a hundred allowances;
 *    they add up to one allowance that keeps moving house. This is why the
 *    welcome grant was removed rather than reduced: a one-off grant is the
 *    only part of this that multiplies.
 *
 * 2. THE ADDRESS CEILING IS SHARED BY EVERYONE BEHIND IT, accounts included.
 *    Ten accounts on one wifi do not get ten allowances; they get the
 *    address's. It is the one number here that a new account cannot move, and
 *    it is therefore the only real limit on farming -- everything else is
 *    about making it not worth doing.
 *
 * 3. AND A CEILING NEEDS A DOOR, or it is a policy about who may not be a
 *    customer. An office of eight people sharing one IP is indistinguishable
 *    from eight accounts made by one person, and no amount of counting will
 *    ever separate them. So the separation is not attempted: an account with
 *    a hand-set daily limit is a VOUCHED account and is not counted against
 *    the shared address at all. Somebody decided that account was real. That
 *    is a judgement, made by a person, in the console, in about four seconds
 *    -- which is the right amount of process for "this is a landscaping firm,
 *    not a script", and better than any rule that tries to infer it.
 *
 * The thing NOT done here is a cap on accounts per address. It fails exactly
 * where it matters: households, offices and carrier NAT are all one address
 * with many real people behind them, and the cap turns each of them into a
 * support conversation, in exchange for stopping somebody who could clear a
 * cookie or change networks anyway.
 */

import {
  consumeQuota, refundQuota, checkQuota, clientIp, dayKey,
} from './quota.js';
import {
  spendCredits, refundCredits, accountsEnabled, dailyState,
} from './db.js';
import { limits } from './limits.js';

const TTL_SECONDS = 60 * 60 * 48;

/** Today's two ceilings, in the shape quota.js wants them. */
export async function resolveLimits(env, dev = false) {
  const all = await limits(env);
  return {
    personal: dev ? all.dev_daily : all.anon_daily,
    address: dev ? all.ip_daily_dev : all.ip_daily,
    account: all.free_daily,
  };
}

/** The shared-address counter, which signed-in people are subject to as well. */
async function bumpAddress(env, request, n, limit) {
  if (!env.QUOTA) return { allowed: true };
  const key = `i:${dayKey()}:${clientIp(request)}`;
  const raw = await env.QUOTA.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used + n > limit) return { allowed: false, used, limit, reason: 'shared-network' };
  await env.QUOTA.put(key, String(used + n), { expirationTtl: TTL_SECONDS });
  return { allowed: true, used: used + n, limit };
}

async function unbumpAddress(env, request, n) {
  if (!env.QUOTA) return;
  const key = `i:${dayKey()}:${clientIp(request)}`;
  const raw = await env.QUOTA.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  await env.QUOTA.put(key, String(Math.max(0, used - n)), { expirationTtl: TTL_SECONDS });
}

/**
 * An account somebody has looked at and decided is real.
 *
 * Vouching is spelled "give this account its own daily limit", because that is
 * what a business needs anyway and it means there is no second flag to
 * remember to set. An unlimited account -- the owner's -- is vouched by
 * definition.
 */
const vouched = (user, daily) => Boolean(user?.unlimited || daily?.own);

/**
 * Take payment for `n` passes. Nothing is charged unless all of it can be.
 *
 * ALL OR NOTHING, like the daily allowance and for the same reason: letting
 * three of four passes through because that is what was affordable produces a
 * measurement missing one exclusion, which is not a smaller answer. It is a
 * wrong one, silently, with the missing concept counted as lawn.
 *
 * The shape of the result is shared with consumeQuota so the caller does not
 * branch on which kind of visitor it is talking to -- only on `allowed`.
 */
export async function charge(request, env, { user, clientId, n = 1, dev = false, detail = null }) {
  const caps = await resolveLimits(env, dev);

  if (!user || !accountsEnabled(env)) {
    const out = await consumeQuota(request, env, clientId, n, dev, caps);
    return { ...out, paidWith: 'allowance', remaining: Math.max(0, out.limit - out.used) };
  }

  const state = await dailyState(env, user, caps.account);
  const free = vouched(user, state);

  // The backstop first: it is the cheaper check, and being turned away by it
  // should not have cost credits on the way. A vouched account skips it -- see
  // the header: the ceiling is anti-farming, and a farmed account is exactly
  // what a vouched one is not.
  if (!free) {
    const address = await bumpAddress(env, request, n, caps.address);
    if (!address.allowed) {
      return { ...address, allowed: false, paidWith: 'credits', reason: 'shared-network' };
    }
  }

  const paid = await spendCredits(env, user, n, detail, caps.account);
  if (!paid.ok) {
    if (!free) await unbumpAddress(env, request, n);
    return {
      allowed: false,
      paidWith: 'credits',
      reason: 'no-credits',
      credits: paid.balance,
      daily: paid.daily,
      used: paid.daily.used,
      limit: paid.daily.limit,
      wanted: n,
    };
  }

  return {
    allowed: true,
    paidWith: 'credits',
    credits: paid.balance,
    unlimited: paid.unlimited,
    spent: paid.spent,
    fromDaily: paid.fromDaily,
    daily: paid.daily,
    used: paid.daily.used,
    limit: paid.daily.limit,
    remaining: paid.unlimited
      ? Infinity
      : Math.max(0, paid.daily.limit - paid.daily.used) + (paid.balance || 0),
  };
}

/**
 * Hand back what was charged for something that never happened.
 *
 * Payment is taken BEFORE the detector is called -- charging afterwards would
 * let a flood of parallel requests all pass the check at once -- so a refusal
 * upstream has already cost the person something. Giving it back is what keeps
 * a broken deploy merely broken, rather than broken and expensive.
 *
 * `fromDaily` says how much of the charge came out of today's allowance rather
 * than the bought balance, so the refund goes back into the pockets it came
 * out of. Without it a failed detection would quietly convert free passes into
 * permanent credits, which is a small gift that compounds.
 */
export async function refund(request, env, { user, clientId, n = 1, fromDaily = null }) {
  if (!user || !accountsEnabled(env)) {
    await refundQuota(request, env, clientId, n);
    return;
  }
  const caps = await resolveLimits(env);
  const state = await dailyState(env, user, caps.account);
  if (!vouched(user, state)) await unbumpAddress(env, request, n);
  await refundCredits(env, user, n, 'the detector refused', fromDaily === null ? n : fromDaily);
}

/**
 * What to show before anything is spent.
 *
 * ONE SHAPE FOR BOTH KINDS OF VISITOR, now that both have a daily allowance:
 * used, limit, and when it comes back. `kind` still says which arrangement it
 * is, because the sentence on screen differs -- a signed-out visitor is told
 * an account would give them more, and a signed-in one is not told to sign in.
 */
export async function allowance(request, env, { user, clientId, dev = false }) {
  const caps = await resolveLimits(env, dev);

  if (user && accountsEnabled(env)) {
    if (user.unlimited) {
      return { kind: 'credits', unlimited: true, credits: null, allowed: true, used: 0, limit: 0 };
    }
    const state = await dailyState(env, user, caps.account);
    return {
      kind: 'credits',
      unlimited: false,
      used: state.used,
      limit: state.limit,
      // Bought credits, which outlast the day. Shown separately or the two
      // numbers add up on screen into something that resets and does not.
      credits: user.credits || 0,
      vouched: state.own,
      allowed: state.used < state.limit || (user.credits || 0) > 0,
    };
  }

  return {
    kind: 'daily',
    ...(await checkQuota(request, env, clientId, dev, caps)),
    // What signing in would be worth, so the invitation can name a number
    // rather than promising "more".
    accountLimit: caps.account,
  };
}
