/**
 * A detect press that may still be handed back (owner, 2026-09-29: "make sure
 * it's only counted against the daily total if the user receives a trace").
 *
 * The allowance is charged when the press starts -- every prediction is
 * billed from that moment, and charging afterwards would let a press run
 * that the allowance should have refused. So the rule is kept the other way
 * round: remember the press, and hand it back when no trace reached the
 * person -- cancelled at the 90-second prompt, failed, or out of time.
 *
 * TWO THINGS KEEP IT HONEST.
 *   - Once only: the row moves from 'open' to 'refunded' in one UPDATE.
 *   - Not after an answer: if every prediction in the press had already
 *     SUCCEEDED upstream, the trace was there to be had, and "cancel" is
 *     refused. That is checked against Replicate / Modal themselves, not
 *     against anything the browser says.
 *
 * A cancel can reach the Worker before the press is recorded (the person
 * gives up while the first request is still waiting on Replicate). It leaves
 * a 'cancelled' row, and the press, finding it, hands itself back.
 */

import { isAlphaId, alphaStatus, cancelAlpha } from './alpha.js';

const PRESS = /^[A-Za-z0-9-]{8,64}$/;
export const pressIdOf = (v) => (typeof v === 'string' && PRESS.test(v) ? v : null);

const now = () => new Date().toISOString();

/**
 * Record a charged press. Returns 'open', 'cancelled' (a cancel got here
 * first: hand it back now), or null when there is nothing to record against.
 */
export async function openPress(env, press, row) {
  if (!env?.DB || !press) return null;
  try {
    await env.DB.prepare('DELETE FROM detect_presses WHERE created_at < ?1')
      .bind(new Date(Date.now() - 86400000).toISOString()).run();
    const made = await env.DB.prepare(
      `INSERT INTO detect_presses (id, client_id, user_id, n, from_daily, job, claimant, ceiling, ids, state, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'open', ?10)
       ON CONFLICT(id) DO NOTHING RETURNING state`
    ).bind(
      press, row.clientId || null, row.userId || null, row.n, row.fromDaily ?? null,
      row.job || null, row.claimant || null, row.ceiling ?? null, JSON.stringify(row.ids || []), now()
    ).first();
    if (made) return 'open';
    const was = await env.DB.prepare('SELECT state FROM detect_presses WHERE id = ?1').bind(press).first();
    if (was?.state !== 'cancelled') return null;       // a reused id: not refundable
    /* Take the tombstone over, so the hand-back below happens once. */
    const took = await env.DB.prepare(
      `UPDATE detect_presses SET state = 'refunded', client_id = ?2, user_id = ?3, n = ?4, ids = ?5
        WHERE id = ?1 AND state = 'cancelled' RETURNING id`
    ).bind(press, row.clientId || null, row.userId || null, row.n, JSON.stringify(row.ids || [])).first();
    return took ? 'cancelled' : null;
  } catch {
    return null;       // no table yet (before the deploy's schema step): charged as before
  }
}

/** Where one prediction has got to, from the service that runs it. */
async function upstreamStatus(env, id) {
  try {
    if (isAlphaId(id)) return await alphaStatus(env, id);
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${env.REPLICATE_TOKEN}` },
    });
    if (!res.ok) return 'unknown';
    return (await res.json()).status || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Stop a prediction nobody is waiting for any more. Best effort. */
export async function stopPrediction(env, id) {
  try {
    if (isAlphaId(id)) { await cancelAlpha(env, id); return; }
    await fetch(`https://api.replicate.com/v1/predictions/${id}/cancel`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.REPLICATE_TOKEN}` },
    });
  } catch { /* it finishes and is billed; nothing else to do */ }
}

/**
 * Hand a press back, if it may be. Returns one of:
 *   {refunded: true, row}         the caller credits `row` back and stops `row.ids`
 *   {finished: true}              every prediction had answered: it counts
 *   {pending: true}               not recorded yet: the press will hand itself back
 *   {already: true}               handed back before
 *   {forbidden: true}             somebody else's press
 */
export async function releasePress(env, press, { clientId, userId }) {
  if (!env?.DB || !press) return { already: true };
  let row;
  try {
    row = await env.DB.prepare('SELECT * FROM detect_presses WHERE id = ?1').bind(press).first();
  } catch {
    return { already: true };
  }
  if (!row) {
    await env.DB.prepare(
      `INSERT INTO detect_presses (id, client_id, state, created_at) VALUES (?1, ?2, 'cancelled', ?3)
       ON CONFLICT(id) DO NOTHING`
    ).bind(press, clientId || null, now()).run();
    row = await env.DB.prepare('SELECT * FROM detect_presses WHERE id = ?1').bind(press).first();
    if (!row || row.state === 'cancelled') return { pending: true };
  }
  if (row.state !== 'open') return { already: true };
  if (row.client_id && row.client_id !== clientId) return { forbidden: true };
  if (row.user_id && row.user_id !== userId) return { forbidden: true };

  let ids = [];
  try { ids = JSON.parse(row.ids || '[]'); } catch { ids = []; }
  const statuses = await Promise.all(ids.map((id) => upstreamStatus(env, id)));
  if (ids.length && statuses.every((s) => s === 'succeeded')) return { finished: true };

  const claimed = await env.DB.prepare(
    `UPDATE detect_presses SET state = 'refunded' WHERE id = ?1 AND state = 'open' RETURNING *`
  ).bind(press).first();
  if (!claimed) return { already: true };
  return { refunded: true, row: claimed, stop: ids.filter((id, i) => statuses[i] !== 'succeeded') };
}
