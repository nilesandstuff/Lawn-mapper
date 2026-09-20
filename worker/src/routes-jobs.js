/**
 * The three things a paid worker's browser asks for: give me a lawn, I could
 * not do this one, here is my map.
 *
 * NO ACCOUNTS AND NO TOKENS. A worker arrives with an id their crowd platform
 * put in the URL, and that is the whole of their identity. There is nothing to
 * forge that is worth forging: the id decides which rate limits apply and who
 * gets paid, and somebody who invents one gets a fresh set of limits and no
 * way to prove to the platform that they did the work.
 *
 * THE COMPLETION CODE IS NOT A SECRET, and that is deliberate. Crowd platforms
 * want a code pasted back as proof of work, and the usual way is a signed
 * string with a secret behind it. Here the code is simply the job's own short
 * id -- because the owner does not have to trust it. They look it up: was that
 * lawn actually submitted, by that worker, with a map attached. A database
 * that already knows the answer beats a signature that asserts it.
 */

import { recordFinished, storeImage } from './corpus.js';
import {
  claimVerdict, submissionVerdict, cleanWorker, staleBefore, dayStart,
  GATES,
} from './jobs.js';

/** What the worker is asked to do, in the order it matters. */
export const PROMPTS = [
  {
    key: 'edges',
    title: 'Hug the hard edges',
    body: 'Where the grass meets a driveway, path, patio or building, follow '
      + 'that line closely. These edges are sharp in the photograph and they '
      + 'are where the automatic outline is worst — it drifts into the drive '
      + 'or stops short of it. This is most of the job.',
  },
  {
    key: 'road',
    title: 'Grass by the road counts',
    body: 'The property line often stops before the kerb, but the grass does '
      + 'not. If there is lawn between the boundary and the road — a verge, a '
      + 'strip past the pavement — include it. Drag the yellow boundary out to '
      + 'the kerb first if the grass is outside the frame.',
  },
  {
    key: 'shade',
    title: 'Shaded grass is still grass',
    body: 'Grass in the shadow of a house or a tree is dark, and the automatic '
      + 'outline usually drops it. If you can tell it is lawn, include it. If '
      + 'a tree canopy hides the ground so completely that you are guessing, '
      + 'leave it out.',
  },
  {
    key: 'inferred',
    title: 'The purple tool is optional',
    body: 'There is a tool for marking ground you believe is lawn but cannot '
      + 'actually see. You are welcome to leave it alone — it takes a careful '
      + 'hand and it is not what you are being paid for.',
    optional: true,
  },
];

const shortId = (id) => String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase();

/** The fields a worker's browser needs, and nothing else about the row. */
const jobForWorker = (row) => ({
  id: row.id,
  code: shortId(row.id),
  lng: Number(row.lng),
  lat: Number(row.lat),
  county: row.county || null,
  parcelSqFt: row.parcel_sqft === null || row.parcel_sqft === undefined
    ? null : Number(row.parcel_sqft),
  claimedAt: row.claimed_at,
});

/**
 * Put abandoned claims back.
 *
 * Run before every claim rather than on a timer, because a Worker has no
 * timer and this is the only moment anybody cares. People close tabs, and a
 * lawn nobody can reach is a lawn nobody gets paid for.
 */
async function releaseStale(env, now) {
  await env.DB.prepare(
    `UPDATE lawn_jobs
        SET state = 'approved', worker = NULL, claimed_at = NULL
      WHERE state = 'claimed' AND claimed_at < ?1`
  ).bind(staleBefore(now)).run();
}

export async function handleJobs(request, url, env, origin, ctx, json) {
  if (!env.DB) return json({ error: 'No database' }, 503, origin);

  const path = url.pathname.replace(/^\/api\/job\/?/, '');
  const now = Date.now();

  /* ------------------------------------------------ give me a lawn */
  if (path === '' || path === 'next') {
    const worker = cleanWorker(url.searchParams.get('w'));
    if (!worker) {
      return json({
        error: 'No worker id',
        reason: 'This link is missing the id your platform adds to it. Open '
          + 'the task again from the platform rather than from a bookmark.',
      }, 400, origin);
    }

    await releaseStale(env, now);

    /*
     * ALREADY HOLDING ONE? HAND IT BACK, rather than refusing. Somebody who
     * closed the tab and reopened the link is the common case by far, and
     * telling them "you already have a lawn open" while not showing them the
     * lawn is a dead end that ends in an abandoned claim.
     */
    const open = await env.DB.prepare(
      `SELECT * FROM lawn_jobs WHERE worker = ?1 AND state = 'claimed'
        ORDER BY claimed_at ASC LIMIT 1`
    ).bind(worker).first();
    if (open) {
      return json({ job: jobForWorker(open), prompts: PROMPTS, resumed: true }, 200, origin);
    }

    /*
     * Everything the limits need, in one pass: today's count for the daily
     * cap, the whole history for the gates, and how the reviewed ones went.
     *
     * A PASS IS 'kept' OR 'excused', and the sum has to say so here as well as
     * in jobs.js. An excused map is one the owner would not keep from a lawn
     * that was genuinely hard -- it is thrown away and it still counts for the
     * worker, because who draws the awkward lawns is pure luck.
     */
    const stats = await env.DB.prepare(
      `SELECT
         COUNT(*) AS ever,
         SUM(CASE WHEN submitted_at >= ?2 THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN state IN ('kept', 'excused') THEN 1 ELSE 0 END) AS passed,
         SUM(CASE WHEN state = 'refused' THEN 1 ELSE 0 END) AS refused,
         SUM(CASE WHEN state = 'kept' THEN 1 ELSE 0 END) AS kept,
         MAX(submitted_at) AS last
       FROM lawn_jobs
      WHERE worker = ?1 AND submitted_at IS NOT NULL`
    ).bind(worker, dayStart(now)).first();

    const ever = Number(stats?.ever || 0);
    const passed = Number(stats?.passed || 0);
    const kept = Number(stats?.kept || 0);
    const verdict = claimVerdict({
      held: 0,
      submittedToday: Number(stats?.today || 0),
      submittedEver: ever,
      passed,
      refused: Number(stats?.refused || 0),
      lastSubmitAt: stats?.last || null,
      now,
    });
    if (!verdict.ok) {
      return json({
        error: 'Not yet',
        reason: verdict.reason,
        wait: verdict.wait || 0,
        /* Two different shapes of "no", and the page says different things
           about them: one is a wait, the other is the end of the road. */
        waiting: Boolean(verdict.waiting),
        stopped: Boolean(verdict.stopped),
      }, 429, origin);
    }

    /*
     * THE GOOD NEWS, WHEN THERE IS ANY.
     *
     * Nothing here can push a message to somebody -- there is no address and
     * there should not be one. What it can do is tell them the moment they
     * come back, which is when they are looking anyway. A worker who was held
     * at a gate yesterday and returns to "your maps were kept, carry on" is a
     * worker who keeps coming back.
     *
     * It counts KEPT maps rather than passes, because "3 of your maps have
     * been kept" has to be true. Telling somebody an excused map was kept
     * would be a small lie that the owner's review queue contradicts.
     *
     * The platform does the other half: approving an assignment notifies them
     * that they have been paid.
     */
    const cleared = kept > 0 && ever >= GATES[0]
      ? `${kept} of your maps have been kept — thank you. There is more of the `
        + 'batch open to you now.'
      : null;

    /*
     * Claimed in ONE statement, so two workers arriving together cannot be
     * handed the same lawn. A read-then-write would have a gap between them,
     * and the gap is exactly where a crowd platform puts forty people.
     */
    const claimedAt = new Date(now).toISOString();
    const taken = await env.DB.prepare(
      `UPDATE lawn_jobs
          SET state = 'claimed', worker = ?1, claimed_at = ?2
        WHERE id = (SELECT id FROM lawn_jobs WHERE state = 'approved'
                     ORDER BY created_at ASC LIMIT 1)
      RETURNING *`
    ).bind(worker, claimedAt).first();

    if (!taken) {
      return json({
        error: 'Nothing left',
        reason: 'Every lawn in this batch has been taken. Thank you — there '
          + 'is nothing more to do here today.',
      }, 404, origin);
    }

    return json({ job: jobForWorker(taken), prompts: PROMPTS, cleared }, 200, origin);
  }

  /* --------------------------------------- I could not do this one */
  if (path === 'skip' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const worker = cleanWorker(body?.worker);
    const id = String(body?.id || '');
    if (!worker || !id) return json({ error: 'Need a worker and a job' }, 400, origin);

    /*
     * A SKIP IS NOT A REJECTION. The lawn goes back to 'approved' and somebody
     * else gets it -- one worker being unable to see a boundary says nothing
     * about the lawn. What it must NOT do is leave them holding it: a worker
     * blocked for an hour by a lawn they cannot trace is a worker who leaves.
     *
     * The note is kept because several skips on one lawn is a signal the owner
     * should see, even though no single skip is.
     */
    await env.DB.prepare(
      `UPDATE lawn_jobs
          SET state = 'approved', worker = NULL, claimed_at = NULL,
              note = ?3
        WHERE id = ?1 AND worker = ?2 AND state = 'claimed'`
    ).bind(id, worker, `skipped by ${worker}: ${String(body?.why || '').slice(0, 120)}`)
      .run();

    return json({ ok: true }, 200, origin);
  }

  /* ------------------------------------------------ here is my map */
  if (path === 'submit' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400, origin);
    }

    const worker = cleanWorker(body?.worker);
    const id = String(body?.id || '');
    if (!worker || !id) return json({ error: 'Need a worker and a job' }, 400, origin);

    const row = await env.DB.prepare(
      `SELECT * FROM lawn_jobs WHERE id = ?1 AND worker = ?2 AND state = 'claimed'`
    ).bind(id, worker).first();
    if (!row) {
      return json({
        error: 'Not yours',
        reason: 'That lawn is not open under your id any more. It may have '
          + 'timed out — open the task link again for a fresh one.',
      }, 409, origin);
    }

    const verdict = submissionVerdict({
      claimedAt: row.claimed_at,
      now,
      edited: Boolean(body?.edited),
      confirmedUnchanged: Boolean(body?.confirmedUnchanged),
    });
    if (!verdict.ok) {
      return json({
        error: 'Have another look',
        reason: verdict.reason,
        /* So the page can offer "I checked, it was already right" rather than
           leaving somebody stuck with work they cannot send. */
        unchanged: Boolean(verdict.unchanged),
      }, 400, origin);
    }

    /*
     * The map goes into the corpus by the same road every other finished map
     * takes. A separate path for paid maps would be a second place for the
     * shape-cleaning, the id derivation and the image fetch to drift out of
     * step -- and the corpus cannot tell which maps came from where anyway,
     * which is the point: they are judged the same.
     */
    const kept = await recordFinished(env, body);
    if (!kept.ok) {
      return json({
        error: 'That did not save',
        reason: kept.reason === 'no-shapes'
          ? 'There is no outline on the map. Draw the lawn before sending it.'
          : 'Something went wrong saving that map. Try sending it again.',
      }, 400, origin);
    }
    if (kept.row) ctx.waitUntil(storeImage(env, kept.row));

    await env.DB.prepare(
      `UPDATE lawn_jobs
          SET state = 'submitted', submitted_at = ?2, map_id = ?3, note = ?4
        WHERE id = ?1`
    ).bind(
      id, new Date(now).toISOString(), kept.row?.id || null,
      verdict.flag ? `flag: ${verdict.flag}` : null,
    ).run();

    return json({
      ok: true,
      code: shortId(id),
      seconds: verdict.seconds,
      thanks: 'Sent. Paste the code above into the task to be paid for it.',
    }, 200, origin);
  }

  return json({ error: 'Not found' }, 404, origin);
}
