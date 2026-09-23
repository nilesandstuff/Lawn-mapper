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
  FREE_DETECTS_PER_JOB, FREE_DETECTS_PER_OPEN_JOB, isOpenLink,
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
export async function spendJobDetection(
  env, jobId, workerId, n = 1, ceiling = FREE_DETECTS_PER_JOB
) {
  const worker = cleanWorker(workerId);
  const id = String(jobId || '');
  if (!worker || !id || !env?.DB) return false;

  const spent = await env.DB.prepare(
    /*
     * THE CEILING APPLIES TO SPENDING AND THE FLOOR TO BOTH, which reads like
     * pedantry and is not: the ceiling differs by route now, and a hand-back
     * that had to satisfy it would silently fail on any lawn already above the
     * caller's idea of the limit -- costing a worker a pass for a detection the
     * detector itself refused, and doing it invisibly.
     */
    `UPDATE lawn_jobs SET detections = detections + ?3
      WHERE id = ?1 AND worker = ?2 AND state = 'claimed'
        AND (?3 <= 0 OR detections + ?3 <= ?4) AND detections + ?3 >= 0
    RETURNING detections`
  ).bind(id, worker, n, ceiling).first().catch(() => null);

  return Boolean(spent);
}

/**
 * The same spend, with the LAWN'S OWN ROUTE deciding the ceiling.
 *
 * Two questions in one round trip, because /api/segment needs both answers and
 * they have to be about the same row: did this pass come out of the lawn, and
 * -- if it could not -- is this a route where the person's own allowance may be
 * charged instead. On the two public links the answer to the second is no. A
 * volunteer is doing the owner a favour and somebody on the paid link is owed
 * 75c for a map that is approved; billing either of them for the tool is the
 * wrong way round, and a detection refused for want of THEIR passes is a
 * refusal on a screen where the work is being donated.
 *
 * Returns null when this is not a detection on somebody's own claimed lawn at
 * all, which is the ordinary case for every visitor to the site and means "the
 * usual rules apply".
 */
export async function jobDetection(env, jobId, workerId, n = 1) {
  const worker = cleanWorker(workerId);
  const id = String(jobId || '');
  if (!worker || !id || !env?.DB) return null;

  const row = await env.DB.prepare(
    `SELECT route, detections FROM lawn_jobs
      WHERE id = ?1 AND worker = ?2 AND state = 'claimed'`
  ).bind(id, worker).first().catch(() => null);
  if (!row) return null;

  const free = isOpenLink(cleanRoute(row.route));
  const ceiling = free ? FREE_DETECTS_PER_OPEN_JOB : FREE_DETECTS_PER_JOB;
  return {
    free,
    ceiling,
    used: Number(row.detections || 0),
    spent: await spendJobDetection(env, id, worker, n, ceiling),
  };
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

/**
 * THE SAME JOB, DESCRIBED HONESTLY FOR THE ROUTE SOMEBODY IS ON.
 *
 * A crowd worker gets an outline drawn for them on arrival and is paid to
 * correct it. A volunteer or a paid tracer no longer does: they said the
 * drawn-on outline made the work more annoying rather than less, and they were
 * right about the arithmetic -- a wrong outline has to be dismantled corner by
 * corner before the lawn can be traced, which is slower than tracing it on an
 * empty map. See openJob in app.js.
 *
 * SO THE PROMPTS CANNOT SAY "the automatic outline" TO THEM, and that is not a
 * cosmetic point. Two of these prompts describe where that outline goes wrong,
 * which for somebody looking at an empty map is an instruction about a thing
 * that is not on their screen -- the surest way to make a person think they
 * have missed a step and go looking for it.
 *
 * Rewritten here rather than in the browser because the route is decided here,
 * and a second copy of this wording in app.js would be a second copy to
 * forget.
 */
const OPEN_LINK_PROMPTS = {
  edges: 'Where the grass meets a driveway, path, patio or building, follow '
    + 'that line closely. These edges are sharp in the photograph and they are '
    + 'what makes a map worth keeping — a lawn that runs a foot into the drive '
    + 'all the way round is the commonest thing wrong with one. This is most '
    + 'of the job.',
  shade: 'Grass in the shadow of a house or a tree is dark and easy to leave '
    + 'out. If you can tell it is lawn, include it. If a tree canopy hides the '
    + 'ground so completely that you are guessing, leave it out.',
  ai: 'Nothing is traced for you on this one. Draw the lawn yourself — or open '
    + 'the AI tab and press "Detect my lawn" for a rough first attempt to '
    + 'correct, if you would rather start from one. It is free either way, and '
    + 'you can clear it and start again from the Draw tab.',
};

export function promptsFor(route) {
  if (!isOpenLink(route)) return PROMPTS;
  return [
    /* First, because it is the thing that has changed about their screen. */
    { key: 'ai', title: 'The AI is yours to ask for', body: OPEN_LINK_PROMPTS.ai },
    ...PROMPTS.map((p) => (OPEN_LINK_PROMPTS[p.key]
      ? { ...p, body: OPEN_LINK_PROMPTS[p.key] }
      : p)),
  ];
}

const shortId = (id) => String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase();

/**
 * How a note says "somebody put this lawn back", and why it is a constant.
 *
 * The handout order READS this now. Lawns are handed out shuffled so nobody
 * gets twenty maps from one county, and a random order cannot also sink a lawn
 * people keep refusing -- which moving created_at used to do. So the note is
 * the signal, and a prefix typed out in three places would be a prefix that
 * eventually disagrees with the LIKE pattern in the query and quietly stops
 * sinking anything.
 *
 * A screener's own note on an approved row never starts with this: theirs is
 * typed into the admin console about an address, and this is written by the
 * skip handler about a claim.
 */
export const SKIP_NOTE = 'skipped by ';

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
async function claimFor(worker, route, env, now, json, origin, avoid = '') {
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

  /*
   * UNLESS IT IS THE ONE THEY HAVE JUST SAID THEY CANNOT DO.
   *
   * This is the last hole in "can't do this one", and it swallowed the whole
   * fix: if the skip did not land, the claim is still standing, and the resume
   * above hands the very same lawn back -- before the queue, the exclusion and
   * the `only` sentence are ever reached. The worker presses the button, waits,
   * and gets their lawn back with nothing said. That is precisely the report.
   *
   * And the skip not landing was the ordinary case on the paid route, not a
   * rare one: the browser posted it with no `via`, so the server read the id
   * out of the request body -- which on that route is empty, because the
   * identity comes from the session. Every paid skip was refused with "need a
   * worker and a job", a 400 the page does not look at. The browser now sends
   * `via`; this releases the claim anyway, so a skip that fails for any other
   * reason -- offline, a dropped request, a 500 -- cannot put somebody back in
   * the loop either.
   *
   * Only ever their own claim, and only the id they nominated.
   */
  if (open && avoid && open.id === String(avoid)) {
    await env.DB.prepare(
      `UPDATE lawn_jobs
          SET state = 'approved', worker = NULL, claimed_at = NULL, route = NULL,
              created_at = ?3, note = ?4
        WHERE id = ?1 AND worker = ?2 AND state = 'claimed'`
    ).bind(
      open.id, worker, new Date(now).toISOString(),
      /* The same prefix the skip handler writes, because the handout order
         reads it to sink a lawn people keep putting back. */
      `${SKIP_NOTE}${worker}: the skip did not reach the server`,
    ).run();
  } else if (open) {
    /* The route travels with the resume too: without it a crowd worker
       sees no completion code on the path they take most often, which is
       reopening the link after closing the tab. */
    return json({
      job: jobForWorker(open), prompts: promptsFor(route), resumed: true, route,
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
      /* Three different shapes of "no", and the page says different things
         about them: one is a wait on a person, one is a ceiling that lifts by
         itself at midnight, and one is the end of the road. */
      waiting: Boolean(verdict.waiting),
      capped: Boolean(verdict.capped),
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
  /*
   * THE ONE THEY JUST SKIPPED IS TRIED LAST, not merely sunk.
   *
   * Sinking it was supposed to be enough and is not, for two reasons that both
   * end with the same lawn coming straight back at somebody who has just said
   * they cannot do it. A batch with ONE approved lawn in it has a bottom of the
   * queue that is also the top. And a claim that had already gone stale leaves
   * the skip with nothing to update at all -- see the skip handler, which now
   * says so instead of reporting success.
   *
   * So the id is excluded outright, and only if that finds nothing is it
   * offered again with `only` set, which the browser turns into a sentence.
   * Handing it back silently is the one thing that must not happen: it reads
   * as the button being broken, and the person stops pressing it.
   */
  /*
   * SHUFFLED, NOT OLDEST FIRST -- and the reason is the shape of the queue
   * rather than fairness.
   *
   * Addresses arrive a county at a time, from one county's parcel server in
   * one import, so created_at is sorted by county almost perfectly. Handing
   * out the oldest approved lawn therefore walked one county to exhaustion
   * before starting the next, and a tracer doing twenty maps in an evening got
   * twenty maps from the same few streets. Several said so. It is worse than
   * dull: the same suburb over and over is the least informative thing the
   * corpus can be fed, because what the detector is bad at is the variety --
   * and a volunteer who is bored stops.
   *
   * RANDOM() over the approved rows, which needs no column and no ordering to
   * maintain. It costs a scan of the approved rows, and there are hundreds of
   * them, not millions.
   *
   * ONE THING IS STILL ORDERED: a lawn somebody has put back sinks below the
   * rest, which is where an awkward one belongs. It used to be done by moving
   * created_at, and that stopped meaning anything the moment the order became
   * random -- so the skip note is read instead. See SKIP_NOTE, which both
   * places that release a claim write.
   */
  const pick = async (exclude) => env.DB.prepare(
    `UPDATE lawn_jobs
        SET state = 'claimed', worker = ?1, claimed_at = ?2, route = ?3
      WHERE id = (SELECT id FROM lawn_jobs WHERE state = 'approved'
                    AND (?4 = '' OR id != ?4)
                   ORDER BY (CASE WHEN note LIKE ?5 THEN 1 ELSE 0 END), RANDOM()
                   LIMIT 1)
    RETURNING *`
  ).bind(worker, claimedAt, route, exclude, `${SKIP_NOTE}%`).first();

  let onlyOneLeft = false;
  let taken = await pick(String(avoid || ''));
  if (!taken && avoid) {
    taken = await pick('');
    onlyOneLeft = Boolean(taken);
  }

  if (!taken) {
    return json({
      error: 'Nothing left',
      reason: 'Every lawn in this batch has been taken. Thank you — there '
        + 'is nothing more to do here today.',
    }, 404, origin);
  }

  return json({
    job: jobForWorker(taken), prompts: promptsFor(route), cleared, route,
    /* Present ONLY when the queue had nothing else, so the browser never has
       to tell false from absent. */
    ...(onlyOneLeft ? { only: true } : {}),
  }, 200, origin);
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
      return claimFor(who.worker, who.route, env, now, json, origin,
        url.searchParams.get('not') || '');
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
    return claimFor(worker, route, env, now, json, origin,
      url.searchParams.get('not') || '');
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
     * AND IT SINKS BELOW THE REST OF THE QUEUE, which was a bug found by the
     * browser test. The queue used to hand out the OLDEST approved lawn, so a
     * skip that only cleared the claim handed the very same lawn straight back
     * to the person who had just said they could not do it -- a loop with no
     * way out of it, on the one screen where somebody is being paid by the
     * minute.
     *
     * THE NOTE IS WHAT SINKS IT, not created_at. Moving created_at was the
     * first fix and it worked only while the order was chronological; lawns
     * are handed out shuffled now, so the note carries the signal instead --
     * see SKIP_NOTE and the pick query. created_at is still moved, because the
     * admin screens read it as when this lawn was last touched.
     */
    const note = `${SKIP_NOTE}${worker}: ${String(body?.why || '').slice(0, 120)}`;
    const at = new Date(now).toISOString();

    const released = await env.DB.prepare(
      `UPDATE lawn_jobs
          SET state = 'approved', worker = NULL, claimed_at = NULL, route = NULL,
              note = ?3, created_at = ?4
        WHERE id = ?1 AND worker = ?2 AND state = 'claimed'`
    ).bind(id, worker, note, at).run();

    let moved = Number(released?.meta?.changes || 0) > 0;

    /*
     * THE CLAIM MAY ALREADY BE GONE, and this used to report success anyway.
     *
     * releaseStale puts a claim back after an hour, and an hour is exactly how
     * long somebody spends on a lawn they cannot do before pressing this
     * button. By then the row is already 'approved' with no worker on it, the
     * UPDATE above matches nothing, and the old code returned { ok: true } to
     * a browser that then asked for the next lawn -- which was this one,
     * because nothing had moved its place in the queue. The skip looked
     * broken because for that person it WAS.
     *
     * So an unclaimed row is still sent to the back. Safe because it is
     * unclaimed: the worst anybody can do with it is reorder a queue, and
     * the row somebody else is holding is untouched by the WHERE below.
     */
    if (!moved) {
      const freed = await env.DB.prepare(
        `UPDATE lawn_jobs
            SET note = ?2, created_at = ?3
          WHERE id = ?1 AND state = 'approved' AND worker IS NULL`
      ).bind(id, note, at).run();
      moved = Number(freed?.meta?.changes || 0) > 0;
    }

    /* `moved` is reported rather than assumed. The browser does not act on it
       today -- it excludes the id from the next claim either way -- but a skip
       that changed nothing is the kind of thing that should be visible from
       outside rather than only in a report weeks later. */
    return json({ ok: true, moved }, 200, origin);
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
