/**
 * Who pays for a detection, and how.
 *
 * TWO ARRANGEMENTS, ONE DECISION, AND IT BELONGS IN ONE PLACE. A signed-out
 * visitor spends from a daily allowance counted per browser and per address;
 * a signed-in one spends credits from their account. Both cost the same thing
 * upstream -- one Replicate prediction per pass -- so both are counted in
 * passes, and both can refuse a press before any money is spent.
 *
 * quota.js knows about KV counters. db.js knows about SQL. Neither should have
 * to know which kind of person is asking, which is what this file is for.
 *
 * THE ADDRESS BACKSTOP APPLIES TO EVERYONE, and that is the part worth
 * defending. An account starts with a welcome balance, so "make accounts" is
 * the obvious way to turn a cost guardrail into a formality -- twenty free
 * predictions at a time, as fast as you can click through a sign-up. The
 * per-address ceiling is what makes that tedious rather than free. It is
 * generous enough that a household sharing an address never meets it and tight
 * enough that a script does.
 */

import {
  consumeQuota, refundQuota, checkQuota, addressLimit, clientIp, dayKey,
} from './quota.js';
import { spendCredits, refundCredits, accountsEnabled } from './db.js';

const TTL_SECONDS = 60 * 60 * 48;

/** The shared-address counter, which signed-in people are subject to as well. */
async function bumpAddress(env, request, n, dev) {
  if (!env.QUOTA) return { allowed: true };
  const key = `i:${dayKey()}:${clientIp(request)}`;
  const limit = addressLimit(dev);
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
  if (!user || !accountsEnabled(env)) {
    const out = await consumeQuota(request, env, clientId, n, dev);
    return { ...out, paidWith: 'allowance' };
  }

  // The backstop first: it is the cheaper check, and being turned away by it
  // should not have cost credits on the way.
  const address = await bumpAddress(env, request, n, dev);
  if (!address.allowed) {
    return { ...address, allowed: false, paidWith: 'credits', reason: 'shared-network' };
  }

  const paid = await spendCredits(env, user, n, detail);
  if (!paid.ok) {
    await unbumpAddress(env, request, n);
    return {
      allowed: false,
      paidWith: 'credits',
      reason: 'no-credits',
      credits: paid.balance,
      wanted: n,
    };
  }

  return {
    allowed: true,
    paidWith: 'credits',
    credits: paid.balance,
    unlimited: paid.unlimited,
    spent: paid.spent,
  };
}

/**
 * Hand back what was charged for something that never happened.
 *
 * Payment is taken BEFORE the detector is called -- charging afterwards would
 * let a flood of parallel requests all pass the check at once -- so a refusal
 * upstream has already cost the person something. Giving it back is what keeps
 * a broken deploy merely broken, rather than broken and expensive.
 */
export async function refund(request, env, { user, clientId, n = 1 }) {
  if (!user || !accountsEnabled(env)) {
    await refundQuota(request, env, clientId, n);
    return;
  }
  await unbumpAddress(env, request, n);
  await refundCredits(env, user, n, 'the detector refused');
}

/**
 * What to show before anything is spent.
 *
 * A signed-in person is told about credits, which are theirs and do not reset;
 * everybody else about today's allowance, which is not and does. Two different
 * things, so the answer says which one it is rather than handing back a number
 * whose meaning the browser has to guess.
 */
export async function allowance(request, env, { user, clientId, dev = false }) {
  if (user && accountsEnabled(env)) {
    return {
      kind: 'credits',
      unlimited: Boolean(user.unlimited),
      credits: user.unlimited ? null : user.credits,
      allowed: Boolean(user.unlimited) || user.credits > 0,
    };
  }
  return { kind: 'daily', ...(await checkQuota(request, env, clientId, dev)) };
}
