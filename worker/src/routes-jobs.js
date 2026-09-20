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
import { currentUser } from './auth.js';
import {
  claimVerdict, submissionVerdict, cleanWorker, looksUnsubstituted, staleBefore,
  dayStart, cleanRoute, routeFromLink, routeInWrongParam, needsCode, GATES,
  FREE_DETECTS_PER_JOB,
  PAID_RATE_CENTS,
} from './jobs.js';

/**
 * Is this detection on somebody's own claimed lawn, and is it still free?
 *
 * WHY THE ALLOWANCE HAS A HOLE IN IT AT ALL. The automatic outline is the
 * thing a paid worker is paid to correct, and they arrive signed out from a
 * crowd platform -- where the public allowance is five passes a day for a
 * whole browser. Fifteen maps would run out on the sixth and the task would
 * look broken through no fault of theirs.
 *
 * WHY IT IS NOT A HOLE. Nothing here is taken on trust: the row must exist, be
 * in state 'claimed', and be held by the worker whose id was sent. A worker
 * holds ONE lawn at a time and may claim only so many a day, so the queue is
 * the rate limit; the count is only what stops one claim being held open and
 * detected against all afternoon.
 *
 * Counted with the guard inside the UPDATE rather than read and then written,
 * because two requests arriving together would both read the old number.
 *
 * A NEGATIVE `n` HANDS PASSES BACK, which is what a detection that failed
 * upstream has to do. The ordinary allowance refunds itself the same way, and
 * a worker who was charged for a prediction the detector refused would run out
 * of starting outlines because of somebody else's bad afternoon. The floor is
 * in the same statement as the ceiling, so neither can be walked past.
 */
export async function spendJobDetection(env, jobId, workerId, n = 1) {
  const worker = cleanWorker(workerId);
  const id = String(jobId || '');
  if (!worker || !id || !env?.DB) return false;

  const spent = await env.DB.prepare(
    `UPDATE lawn_jobs SET detections = detections + ?3
      WHERE id = ?1 AND worker = ?2 AND state = 'claimed'
        AND detections + ?3 <= ?4 AND detections + ?3 >= 0
    RETURNING detections`
  ).bind(id, worker, n, FREE_DETECTS_PER_JOB).first().catch(() => null);

  return Boolean(spent);
}

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
    /*
     * CALLED WHAT THE BUTTONS CALL IT. This said "the purple tool", which is
     * what it looks like and not what anything on screen is labelled -- so
     * somebody looking for it found "Draw inferred lawn" and "Mark as
     * inferred" and had to work out those were the same thing.
     */
    title: 'Inferred areas are optional',
    body: 'There is a tool for marking ground you believe is lawn but cannot '
      + 'actually see — it is called inferred lawn, and it draws in purple. '
      + 'You are welcome to leave it alone: it takes a careful hand and it is '
      + 'not what this job is asking for.',
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
 * Which of the three routes is this person on?
 *
 * THE STORED ROW WINS, AND THE LINK MAY ONLY PROPOSE. A link is forgeable and
 * two of the three routes lift real protections, so a paid stranger appending
 * `&via=hired` must not walk through the gates that exist to stop exactly
 * that. The single exception is claiming to be a VOLUNTEER, which is safe
 * because it buys nothing worth forging: what a forger gains is the right to
 * work for nothing.
 *
 * One function rather than the same three lines in three places, because the
 * three places are a claim, a resume and a submission -- and a route that
 * disagreed between them would show somebody a completion code on one path and
 * not the other.
 */
async function routeFor(env, url, worker) {
  const known = await env.DB.prepare(
    'SELECT kind FROM lawn_workers WHERE worker = ?1'
  ).bind(worker).first().catch(() => null);
  if (known?.kind) return cleanRoute(known.kind);
  return routeFromLink(url.searchParams.get('via')) || 'crowd';
}

/**
 * WHO IS THIS, and on the paid route the answer comes from the SESSION.
 *
 * Every other route takes the worker id out of the request, because there is
 * nothing there worth forging: a crowd id is issued by a platform that will
 * not pay a stranger for it, and a volunteer id buys the right to work for
 * nothing.
 *
 * Money changes that. An id in a query string can be typed by anybody, so a
 * worker id would be a claim on somebody else's earnings -- and, more likely
 * than theft, a way to attach rubbish to a real person's record. The session
 * cookie is the one thing here that was actually proved, by a link sent to an
 * address that received it.
 *
 * It is also what makes the rest of the promise keepable: a stable identity
 * across devices, a payout destination that can be corrected, and a verified
 * address to fall back on when a payment bounces.
 */
async function identify(request, url, env, ctx, given) {
  const asked = routeFromLink(url.searchParams.get('via'));

  if (asked === 'paid') {
    const me = await currentUser(request, env, ctx);
    if (!me) {
      return {
        refusal: {
          error: 'Sign in first',
          needsAccount: true,
          reason: 'Paid tracing needs an account. It is one emailed link and no '
            + 'password — it is how the 75c a map reaches you, how you can '
            + 'change where it goes, and how I can tell you if a payment '
            + 'bounces. If you would rather not, the same work is open '
            + 'unpaid: change "paid" to "volunteer" in the link.',
        },
      };
    }
    /* The account's own id. Stable across every device they sign in on, which
       is the whole reason this route goes through sign-in at all. */
    return { worker: me.id, route: 'paid', account: me };
  }

  const worker = cleanWorker(given);
  if (!worker) return { refusal: null };
  return { worker, route: await routeFor(env, url, worker) };
}

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
        SET state = 'approved', worker = NULL, claimed_at = NULL, route = NULL
      WHERE state = 'claimed' AND claimed_at < ?1`
  ).bind(staleBefore(now)).run();
}

/**
 * Hand out a lawn to somebody already identified.
 *
 * Split out because there are two ways to BE identified -- an id in the link,
 * or a session on the paid route -- and exactly one way to be given a lawn.
 * Two copies of the gate arithmetic would be two chances for the rules to
 * disagree about the same person.
 */
async function claimFor(worker, route, env, now, json, origin) {
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
    /* The route travels with the resume too: without it a crowd worker
       sees no completion code on the path they take most often, which is
       reopening the link after closing the tab. */
    return json({
      job: jobForWorker(open), prompts: PROMPTS, resumed: true, route,
    }, 200, origin);
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

  /*
   * HAS THE OWNER ALREADY DECIDED ABOUT THIS PERSON?
   *
   * A row exists only for somebody the owner has said something about --
   * usually one or two people hired directly and paid by the hour, for whom
   * the gates below are a ceiling on work that has already been bought. No
   * row is the ordinary case and means "a stranger", which is what
   * everything else here is written for.
   */
  const known = await env.DB.prepare(
    'SELECT trusted FROM lawn_workers WHERE worker = ?1'
  ).bind(worker).first().catch(() => null);

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
    trusted: Number(known?.trusted || 0) === 1,
    route,
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
  /*
   * AND THE ROUTE IS WRITTEN DOWN, not just acted on.
   *
   * It was already known here -- it decides the gates, the daily cap and what
   * somebody sees when they finish -- and it was thrown away every time. The
   * page that shows the owner who is tracing then had nothing to read, so it
   * called everybody a crowd worker by default. See lawn_jobs.route.
   */
  const taken = await env.DB.prepare(
    `UPDATE lawn_jobs
        SET state = 'claimed', worker = ?1, claimed_at = ?2, route = ?3
      WHERE id = (SELECT id FROM lawn_jobs WHERE state = 'approved'
                   ORDER BY created_at ASC LIMIT 1)
    RETURNING *`
  ).bind(worker, claimedAt, route).first();

  if (!taken) {
    return json({
      error: 'Nothing left',
      reason: 'Every lawn in this batch has been taken. Thank you — there '
        + 'is nothing more to do here today.',
    }, 404, origin);
  }

  return json({ job: jobForWorker(taken), prompts: PROMPTS, cleared, route }, 200, origin);
}

export async function handleJobs(request, url, env, origin, ctx, json) {
  if (!env.DB) return json({ error: 'No database' }, 503, origin);

  const path = url.pathname.replace(/^\/api\/job\/?/, '');
  const now = Date.now();

  /* ------------------------------------------------ give me a lawn */
  if (path === '' || path === 'next') {
    /*
     * THE PAID ROUTE IS IDENTIFIED BEFORE ANYTHING ELSE, because on that one
     * the worker id comes from the session rather than from the link -- see
     * identify(). Everything below this block is about an id that arrived in
     * a URL, which a paid worker does not have.
     */
    const asPaid = routeFromLink(url.searchParams.get('via')) === 'paid';
    if (asPaid) {
      const who = await identify(request, url, env, ctx);
      if (who.refusal) return json(who.refusal, 401, origin);
      return claimFor(who.worker, who.route, env, now, json, origin);
    }

    const raw = url.searchParams.get('w');
    /*
     * THE TEMPLATE, UNFILLED, IS ITS OWN FAULT AND HAS ITS OWN MESSAGE.
     *
     * It is not the worker's mistake and there is nothing they can do about
     * it, so the wording is aimed past them at whoever set the task up -- a
     * worker who reads "ask the requester to check the link" can report it,
     * and a worker who reads "this link is missing its id" tries their
     * bookmark again and gives up. See looksUnsubstituted for what it costs to
     * let one of these through.
     */
    /*
     * THE ROUTE NAME IN THE WORKER-ID SLOT, which has its own message because
     * it has an exact fix. `?w=volunteer` is well-formed and would hand out
     * lawns -- to one worker called "volunteer" shared by everybody who
     * clicked. See routeInWrongParam for what that costs.
     */
    if (routeInWrongParam(raw)) {
      return json({
        error: 'Wrong link',
        reason: `This link says "w=${cleanWorker(raw)}" where it should say `
          + `"via=${cleanWorker(raw)}". As it stands everybody who opens it `
          + 'becomes the same person and shares one lawn between them. Ask '
          + 'whoever posted it to change the w to via.',
      }, 400, origin);
    }

    if (looksUnsubstituted(raw)) {
      return json({
        error: 'Unfilled link',
        reason: 'This link still has the platform\'s own placeholder in it '
          + 'instead of your worker id, so it cannot hand out a lawn. That is '
          + 'a mistake in how the task was set up, not anything you did — '
          + 'please return the task and let the requester know.',
      }, 400, origin);
    }

    const worker = cleanWorker(raw);
    if (!worker) {
      return json({
        error: 'No worker id',
        reason: 'This link is missing the id your platform adds to it. Open '
          + 'the task again from the platform rather than from a bookmark.',
      }, 400, origin);
    }

    const route = await routeFor(env, url, worker);
    return claimFor(worker, route, env, now, json, origin);
  }

  /* --------------------------------------- I could not do this one */
  if (path === 'skip' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const who = await identify(request, url, env, ctx, body?.worker);
    if (who.refusal) return json(who.refusal, 401, origin);
    const worker = who.worker;
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
     *
     * AND IT GOES TO THE BACK OF THE QUEUE, which was a bug found by the
     * browser test. The queue hands out the OLDEST approved lawn, so a skip
     * that only cleared the claim handed the very same lawn straight back to
     * the person who had just said they could not do it -- a loop with no way
     * out of it, on the one screen where somebody is being paid by the minute.
     *
     * Moving created_at is enough and costs nothing: it is only ever read as
     * the handout order (the screening queue reads it too, but that is over
     * 'candidate' rows and a skip can only happen to an approved one). It also
     * does something useful on its own -- a lawn several people have skipped
     * sinks, which is exactly where an awkward one belongs.
     */
    await env.DB.prepare(
      `UPDATE lawn_jobs
          SET state = 'approved', worker = NULL, claimed_at = NULL, route = NULL,
              note = ?3, created_at = ?4
        WHERE id = ?1 AND worker = ?2 AND state = 'claimed'`
    ).bind(
      id, worker,
      `skipped by ${worker}: ${String(body?.why || '').slice(0, 120)}`,
      new Date(now).toISOString(),
    ).run();

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

    const who = await identify(request, url, env, ctx, body?.worker);
    if (who.refusal) return json(who.refusal, 401, origin);
    const worker = who.worker;
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

    const known = await env.DB.prepare(
      'SELECT trusted FROM lawn_workers WHERE worker = ?1'
    ).bind(worker).first().catch(() => null);
    const route = who.route;

    const verdict = submissionVerdict({
      claimedAt: row.claimed_at,
      now,
      edited: Boolean(body?.edited),
      confirmedUnchanged: Boolean(body?.confirmedUnchanged),
      trusted: Number(known?.trusted || 0) === 1,
      route,
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
          SET state = 'submitted', submitted_at = ?2, map_id = ?3, note = ?4,
              seconds = ?5
        WHERE id = ?1`
    ).bind(
      id, new Date(now).toISOString(), kept.row?.id || null,
      verdict.flag ? `flag: ${verdict.flag}` : null,
      /*
       * Kept because the reward has to be defensible: the platforms judge
       * underpayment on the MEDIAN observed time, not on the estimate. See the
       * column comment in schema.sql.
       */
      verdict.seconds,
    ).run();

    /*
     * A COUNT, AND A CODE ONLY WHERE THERE IS SOMEWHERE TO PASTE ONE.
     *
     * The completion code exists so a crowd platform can be shown proof of
     * work. Somebody hired directly has no platform, and a volunteer has no
     * transaction at all -- for both of them a code is a puzzle rather than a
     * receipt: eight characters, no field to put them in, and a nagging sense
     * of having missed a step.
     *
     * What those two actually want is the count. "That is your ninth today" is
     * the thing that answers how it is going, and for a volunteer it is the
     * only thanks the screen can offer.
     */
    const doneToday = await env.DB.prepare(
      `SELECT COUNT(*) n FROM lawn_jobs
        WHERE worker = ?1 AND submitted_at >= ?2`
    ).bind(worker, dayStart(now)).first().catch(() => null);
    const today = Number(doneToday?.n || 1);

    return json({
      ok: true,
      route,
      today,
      seconds: verdict.seconds,
      ...(needsCode(route)
        ? {
          code: shortId(id),
          thanks: 'Sent. Paste the code above into the task to be paid for it.',
        }
        : {
          thanks: route === 'volunteer'
            ? `Sent — thank you. That is ${today} ${today === 1 ? 'lawn' : 'lawns'} `
              + 'you have mapped, and every one of them goes into training a '
              + 'detector that is currently not good enough.'
            : route === 'paid'
              /*
               * SAID PLAINLY, EVERY TIME. Nothing was promised in advance on
               * this route -- 75c is owed for an APPROVED map and nothing at
               * all for one that is not -- so "sent" must not be allowed to
               * read as "earned". Somebody who discovers that distinction
               * after twenty maps has a fair complaint; somebody told it on
               * every single one cannot.
               */
              ? `Sent. That is ${today} today. Each one that is approved earns `
                + `${PAID_RATE_CENTS}c — they are checked by hand, usually `
                + 'within a day.'
              : `Sent. That is ${today} today.`,
        }),
    }, 200, origin);
  }

  return json({ error: 'Not found' }, 404, origin);
}
