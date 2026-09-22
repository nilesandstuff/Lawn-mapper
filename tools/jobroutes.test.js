/**
 * The paid queue, end to end, against a real database.
 *
 * WHY AGAINST A DATABASE RATHER THAN A STUB. Every failure worth catching here
 * is about WHICH ROW a statement touched, and a stub cannot have that bug. Two
 * workers handed the same lawn, a skip that releases somebody else's claim, a
 * submission accepted for a job the worker does not hold: all of those are one
 * mis-scoped WHERE, all of them pass a mocked query, and all of them are found
 * by the owner afterwards as money paid twice for one map.
 *
 *   node tools/jobroutes.test.js
 */

import { testDb } from './d1.js';
import { handleJobs, PROMPTS, spendJobDetection } from '../worker/src/routes-jobs.js';
import { MIN_SECONDS, DAILY_CAP, FREE_DETECTS_PER_JOB } from '../worker/src/jobs.js';
import { SESSION_COOKIE, createSession } from '../worker/src/auth.js';
import { findOrCreateUser } from '../worker/src/db.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const json = (data, status) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const ctx = { waitUntil() {} };

const env = { DB: testDb() };

/*
 * Ids shaped like the ones the sampler makes, which are randomUUID. It matters
 * to one check: the completion code is cut from the id, so a test using "job-0"
 * would measure a four-character code that production never produces.
 */
const idFor = (k) => `0000${String(k).padStart(4, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;

/*
 * WHICH LAWN EACH WORKER WAS ACTUALLY HANDED.
 *
 * The queue is SHUFFLED now -- lawns arrive a county at a time, so handing out
 * the oldest walked one county to exhaustion and gave a tracer twenty maps from
 * the same few streets. So a check can no longer name the row it expects; it
 * has to remember what it was given. Held out here rather than inside the
 * blocks because the blocks below build on each other: one claims, the next
 * detects against that claim, the next submits it.
 */
let w1 = null;
let w2 = null;

/** Any lawn nobody is holding, for the checks that need an unclaimed id. */
const anyApproved = async () => (await env.DB.prepare(
  "SELECT id FROM lawn_jobs WHERE state = 'approved' LIMIT 1"
).first())?.id;

/** Put `many` approved lawns in the queue, oldest first. */
async function seed(many, from = 0) {
  for (let i = 0; i < many; i++) {
    await env.DB.prepare(
      `INSERT INTO lawn_jobs (id, lng, lat, county, parcel_sqft, state, created_at)
       VALUES (?1, ?2, ?3, 'Testshire', 8000, 'approved', ?4)`
    ).bind(
      idFor(from + i), -80 + i * 0.01, 40 + i * 0.01,
      new Date(Date.parse('2026-09-01T00:00:00Z') + (from + i) * 1000).toISOString(),
    ).run();
  }
}

const ask = (path, { method = 'GET', body, search = '', cookie = '' } = {}) => handleJobs(
  new Request(`https://x${path}${search}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      /* The paid route reads who somebody is from the session and never from
         the request, so a test of it has to arrive with a real cookie. */
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }),
  new URL(`https://x${path}${search}`),
  env, null, ctx, json,
);
const read = async (res) => ({ status: res.status, body: await res.json() });

/* --------------------------------------------------- a lawn, and its rules */
{
  await seed(3);

  const none = await read(await ask('/api/job'));
  check('a link with no worker id is refused, and says why',
    none.status === 400 && /platform/i.test(none.body.reason),
    none.body.reason);

  /*
   * AND A LINK NOBODY FILLED IN, which is a different fault with different
   * words. Cleaning `{{%PROLIFIC_PID%}}` leaves the plausible id
   * `PROLIFIC_PID`, so without this the whole batch quietly becomes one
   * worker: one claim between all of them, one daily cap, one set of gates.
   */
  const raw = await read(await ask('/api/job', { search: '?w=%7B%7B%25PROLIFIC_PID%25%7D%7D' }));
  check('and a link still carrying the platform\'s placeholder is refused too',
    raw.status === 400 && /placeholder/i.test(raw.body.reason || ''),
    raw.body.reason);
  check('and the worker is told it is not their mistake',
    /not anything you did/i.test(raw.body.reason || ''),
    'there is nothing they can do about it, so the wording aims past them');

  const held = await env.DB.prepare(
    "SELECT COUNT(*) n FROM lawn_jobs WHERE state = 'claimed'"
  ).first();
  check('and no lawn was handed to the placeholder',
    Number(held.n) === 0,
    'one shared identity would hold one lawn for the whole batch');

  /*
   * AND THE ROUTE NAME IN THE WORKER-ID SLOT, which is one letter's difference
   * in a URL and was very nearly the link that went to Reddit.
   *
   * `?w=volunteer` is well-formed and would hand out lawns -- to one worker
   * called "volunteer" shared by everybody who clicked it. One claim between
   * the whole thread, one daily cap, and the gates applying to all of them
   * together, because with no `via` the route falls back to crowd.
   */
  for (const route of ['volunteer', 'paid', 'hired', 'crowd']) {
    const wrong = await read(await ask('/api/job', { search: `?w=${route}` }));
    check(`a route name in the worker slot is refused: ?w=${route}`,
      wrong.status === 400 && /via=/.test(wrong.body.reason || ''),
      wrong.body.reason);
  }

  const swapped = await read(await ask('/api/job', { search: '?w=volunteer' }));
  check('and the message names the exact fix rather than describing the fault',
    /should say "via=volunteer"/.test(swapped.body.reason || ''),
    'somebody reading this has to be able to correct the link from it');

  const shared = await env.DB.prepare(
    "SELECT COUNT(*) n FROM lawn_jobs WHERE worker IN ('volunteer','paid','hired','crowd')"
  ).first();
  check('and no lawn is handed to the shared name',
    Number(shared.n) === 0,
    'everybody who clicked would otherwise be one person with one claim');

  const first = await read(await ask('/api/job', { search: '?w=WORKER1' }));
  w1 = first.body.job?.id;
  check('a worker gets a lawn',
    first.status === 200 && [idFor(0), idFor(1), idFor(2)].includes(w1),
    JSON.stringify(first.body.job));
  check('and is told what the job actually is',
    Array.isArray(first.body.prompts) && first.body.prompts.length === PROMPTS.length
    && first.body.prompts.some((p) => /driveway|drive/i.test(p.body)),
    `${first.body.prompts?.length} prompts`);
  check('and the purple tool is marked optional',
    first.body.prompts.some((p) => p.optional && /purple/i.test(p.title + p.body)),
    'a deft-hand tool is not what a five-minute task is being paid for');

  /*
   * REOPENING THE LINK MUST HAND BACK THE SAME LAWN. Closing the tab is the
   * commonest thing that happens to a crowd task, and "you already have one
   * open" without showing it is a dead end that ends in an abandoned claim.
   */
  const again = await read(await ask('/api/job', { search: '?w=WORKER1' }));
  check('reopening the link resumes the same lawn rather than refusing',
    again.status === 200 && again.body.job.id === w1 && again.body.resumed,
    JSON.stringify({ id: again.body.job?.id, resumed: again.body.resumed }));

  /* And a different worker gets a DIFFERENT lawn, which is the whole race. */
  const other = await read(await ask('/api/job', { search: '?w=WORKER2' }));
  w2 = other.body.job?.id;
  check('a second worker is never handed the first worker\'s lawn',
    w2 && w2 !== w1,
    `${w2} -- handing two people one lawn is paying twice for one map`);
}

/* ------------------------------------------------------------ skipping */
{
  const before = await env.DB.prepare('SELECT state, worker FROM lawn_jobs WHERE id = ?1')
    .bind(w2).first();
  check('a claimed lawn is held by the worker who claimed it',
    before.state === 'claimed' && before.worker === 'WORKER2', JSON.stringify(before));

  /*
   * A SKIP MAY ONLY RELEASE YOUR OWN. A mis-scoped WHERE here lets any worker
   * free any other worker's lawn, which on a busy batch would be indisponible
   * chaos that looks like the queue misbehaving.
   */
  await ask('/api/job/skip', { method: 'POST', body: { worker: 'WORKER1', id: w2 } });
  const stolen = await env.DB.prepare('SELECT state, worker FROM lawn_jobs WHERE id = ?1')
    .bind(w2).first();
  check('one worker cannot skip another worker\'s lawn',
    stolen.state === 'claimed' && stolen.worker === 'WORKER2', JSON.stringify(stolen));

  await ask('/api/job/skip', {
    method: 'POST', body: { worker: 'WORKER2', id: w2, why: 'cannot see the boundary' },
  });
  const freed = await env.DB.prepare('SELECT state, worker, note FROM lawn_jobs WHERE id = ?1')
    .bind(w2).first();
  check('and a worker skipping their own puts it back for somebody else',
    freed.state === 'approved' && !freed.worker,
    'one person being unable to trace a lawn says nothing about the lawn');
  check('and the reason is kept, because several skips on one lawn is a signal',
    /cannot see the boundary/.test(freed.note || ''), freed.note);

  /*
   * AND IT SINKS BELOW THE REST, which a browser run caught and this pins.
   *
   * A skip that only cleared the claim handed the very same lawn straight back
   * to the person who had just said they could not do it -- a loop with no way
   * out, on the one screen where somebody is being paid by the minute. The
   * order is shuffled now, so what keeps the skipped one out of their hands is
   * that every lawn nobody has put back is offered ahead of it.
   */
  const after = await read(await ask('/api/job', { search: '?w=WORKER2' }));
  check('and the worker who skipped is not handed it straight back',
    after.body.job?.id && after.body.job.id !== w2,
    `${after.body.job?.id} -- getting the same lawn again is a loop with no `
    + 'way out of it');

  /* Put it back, so the blocks below start where they expect to. */
  await ask('/api/job/skip', {
    method: 'POST', body: { worker: 'WORKER2', id: after.body.job?.id },
  });
}

/* ------------------------------------------- who pays for the AI passes */
{
  /*
   * A HOLE IN THE ALLOWANCE, AND WHY IT IS NOT ONE.
   *
   * A paid worker arrives signed out, from a crowd platform, and the automatic
   * outline is the thing they are paid to CORRECT -- so they have to be able
   * to get one. The signed-out allowance is five passes a day for a whole
   * browser, which fifteen maps exhausts on the sixth, and raising it would
   * hand the same number to every visitor on the internet.
   *
   * So the job pays. Everything that makes that safe is a condition on one
   * UPDATE, and each of them is the difference between a queue and a way for
   * a stranger to spend somebody else's Replicate bill.
   */
  check('a worker may detect on the lawn they are holding',
    await spendJobDetection(env, w1, 'WORKER1'),
    'the outline is what they are paid to correct, so they must be able to get one');

  check('but not on somebody else\'s',
    !(await spendJobDetection(env, w1, 'WORKER9')),
    'a job id is not a secret -- the claim is what makes this safe');

  check('and not on a lawn nobody is holding',
    !(await spendJobDetection(env, await anyApproved(), 'WORKER1')),
    'an unclaimed row would be free predictions for anybody who guessed an id');

  check('and not without an id at all',
    !(await spendJobDetection(env, w1, ''))
    && !(await spendJobDetection(env, '', 'WORKER1')),
    'an unnamed worker cannot be rate limited and cannot be paid either');

  /*
   * AND IT RUNS OUT -- PER LAWN, NOT PER CLAIM, which is the condition that
   * actually bounds the bill. A skip puts the lawn back in the queue and is
   * deliberately free, so a count that reset with each claim would make
   * "claim, detect, skip, repeat" an unbounded way to spend somebody else's
   * Replicate account. Kept on the row, the whole batch costs at most this
   * many passes per lawn however many times it goes round.
   */
  const spent = [];
  for (let i = 0; i < FREE_DETECTS_PER_JOB + 2; i++) {
    spent.push(await spendJobDetection(env, w1, 'WORKER1'));
  }
  check(`and gets ${FREE_DETECTS_PER_JOB} of them before the job runs out`,
    spent.filter(Boolean).length === FREE_DETECTS_PER_JOB - 1
    && spent[spent.length - 1] === false,
    `${spent.filter(Boolean).length + 1} allowed in total`);

  /*
   * A FAILED DETECTION HANDS ITS PASS BACK. The ordinary allowance refunds
   * itself the same way, and a worker charged for a prediction the detector
   * refused would run out of starting outlines because of somebody else's bad
   * afternoon -- for which they would be blamed, since all anybody sees is a
   * task that stopped working.
   */
  check('a pass handed back after a failed detection can be spent again',
    (await spendJobDetection(env, w1, 'WORKER1', -1))
    && (await spendJobDetection(env, w1, 'WORKER1')),
    'the detector refusing us is not the worker\'s mistake');

  const row = await env.DB.prepare('SELECT detections FROM lawn_jobs WHERE id = ?1')
    .bind(w1).first();
  check('and the count never goes below nothing',
    !(await spendJobDetection(env, w1, 'WORKER1', -99))
    && Number(row.detections) === FREE_DETECTS_PER_JOB,
    `${row.detections} spent -- a negative count would be free passes for ever`);

  /*
   * AND A SKIP DOES NOT WIPE IT. This is the check the whole design rests on:
   * skips are free by design, so if the count came back with the lawn, then
   * claim-detect-skip-repeat would be a loop with no ceiling on it at all.
   */
  await seed(1, 50);
  const spun = idFor(50);
  /* Put it in their hands directly rather than through the queue: what is
     being tested is the release, not which lawn comes next. */
  await env.DB.prepare(
    `UPDATE lawn_jobs SET state = 'claimed', worker = 'SPINNER', claimed_at = ?2
      WHERE id = ?1`
  ).bind(spun, new Date().toISOString()).run();
  await spendJobDetection(env, spun, 'SPINNER', 2);
  await ask('/api/job/skip', { method: 'POST', body: { worker: 'SPINNER', id: spun } });

  const after = await env.DB.prepare('SELECT state, detections FROM lawn_jobs WHERE id = ?1')
    .bind(spun).first();
  check('and a skip hands the lawn back without handing the passes back',
    after.state === 'approved' && Number(after.detections) === 2,
    `${after.detections} still spent -- a count that reset per claim would make `
    + 'claim, detect, skip, repeat a loop with no ceiling on it');
}

/* ---------------------------------------------------------- submitting */
{
  const mapBody = (over = {}) => ({
    worker: 'WORKER1',
    id: w1,
    edited: true,
    frame: { lng: -80, lat: 40, zoom: 19, size: 640 },
    shapes: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[-80, 40], [-79.999, 40], [-79.999, 40.001], [-80, 40.001], [-80, 40]]],
      },
    }],
    ...over,
  });

  /* Claimed a moment ago, so the floor should refuse it. */
  const rushed = await read(await ask('/api/job/submit', { method: 'POST', body: mapBody() }));
  check(`a map sent inside ${MIN_SECONDS} seconds is refused`,
    rushed.status === 400 && /another look/i.test(rushed.body.error),
    rushed.body.reason);

  /* Wind the claim back so it looks like real work happened. */
  await env.DB.prepare('UPDATE lawn_jobs SET claimed_at = ?2 WHERE id = ?1')
    .bind(w1, new Date(Date.now() - 300_000).toISOString()).run();

  const untouched = await read(await ask('/api/job/submit', {
    method: 'POST', body: mapBody({ edited: false }),
  }));
  check('and an untouched automatic outline is refused even after five minutes',
    untouched.status === 400 && /starting point/i.test(untouched.body.reason),
    untouched.body.reason);

  /*
   * A SUBMISSION FOR A LAWN YOU DO NOT HOLD. Without the worker in the WHERE,
   * anybody who learned a job id could submit against somebody else's claim --
   * and the owner would pay the wrong person for a map they did not draw.
   */
  const notMine = await read(await ask('/api/job/submit', {
    method: 'POST', body: mapBody({ worker: 'WORKER9' }),
  }));
  check('a worker cannot submit against a lawn they do not hold',
    notMine.status === 409, JSON.stringify(notMine.body));

  const good = await read(await ask('/api/job/submit', { method: 'POST', body: mapBody() }));
  check('a corrected map, sent after real work, is accepted',
    good.status === 200 && good.body.ok, JSON.stringify(good.body));
  check('and comes back with a code to paste into the platform',
    typeof good.body.code === 'string' && good.body.code.length >= 6,
    good.body.code);

  const row = await env.DB.prepare('SELECT * FROM lawn_jobs WHERE id = ?1').bind(w1).first();
  check('the lawn is marked submitted and tied to the map it produced',
    row.state === 'submitted' && row.map_id && row.submitted_at,
    JSON.stringify({ state: row.state, map: Boolean(row.map_id) }));

  const corpus = await env.DB.prepare('SELECT COUNT(*) n FROM corpus').first();
  check('and the map went into the corpus by the ordinary road',
    Number(corpus.n) === 1,
    'a separate path for paid maps is a second place for shape-cleaning to drift');

  /* The same submission twice must not pay twice. */
  const dupe = await read(await ask('/api/job/submit', { method: 'POST', body: mapBody() }));
  check('and sending it again is refused rather than counted twice',
    dupe.status === 409, JSON.stringify(dupe.body));
}

/* ------------------------------------------------ an abandoned claim */
{
  await seed(1, 90);
  const mine = await read(await ask('/api/job', { search: '?w=SLOWPOKE' }));
  check('a worker takes a lawn',
    mine.status === 200, mine.body.job?.id);

  /* Two hours ago: past the hour a claim survives. */
  await env.DB.prepare('UPDATE lawn_jobs SET claimed_at = ?2 WHERE id = ?1')
    .bind(mine.body.job.id, new Date(Date.now() - 2 * 3600_000).toISOString()).run();

  const rescued = await read(await ask('/api/job', { search: '?w=SOMEBODYELSE' }));
  check('somebody else is handed a lawn', rescued.status === 200, rescued.body.reason);
  /*
   * CHECKED ON THE ROW RATHER THAN ON WHICH LAWN CAME BACK. The order is
   * shuffled, so the released lawn is one of several the next person might be
   * given -- what releaseStale guarantees is that it is no longer held by
   * somebody who never came back, which is the thing that was broken.
   */
  const abandoned = await env.DB.prepare('SELECT state, worker FROM lawn_jobs WHERE id = ?1')
    .bind(mine.body.job.id).first();
  check('and a claim nobody came back to is out of that person\'s hands',
    abandoned.worker !== 'SLOWPOKE'
    && (abandoned.state === 'approved' || abandoned.state === 'claimed'),
    'people close tabs, and a lawn nobody can reach is a lawn nobody gets paid for');
}

/* ------------------------------------------------ the gates, over real rows */
{
  /*
   * THE ARITHMETIC OF THE GATES LIVES IN TWO PLACES and they have to agree: a
   * pure function that decides, and a SUM over the table that feeds it. The
   * pure half is tested in jobs.test.js and cannot have this bug -- a CASE
   * WHEN that forgets 'excused' does not throw, it silently counts an excused
   * map as neither a pass nor a refusal, which quietly holds a good worker at
   * a gate for ever while the owner sees nothing wrong.
   *
   * So these go in against real rows, in the states the review queue writes.
   */
  const history = async (who, states, at = '2026-09-10T00:00:00Z') => {
    for (let i = 0; i < states.length; i++) {
      await env.DB.prepare(
        `INSERT INTO lawn_jobs
           (id, lng, lat, state, worker, submitted_at, created_at)
         VALUES (?1, -80, 40, ?2, ?3, ?4, ?4)`
      ).bind(`${who}-${i}-aaaa-4bbb-8ccc-dddddddddddd`, states[i], who, at).run();
    }
  };

  await seed(4, 200);

  /* Five sent, nothing reviewed: held, and told why. */
  await history('GATED', ['submitted', 'submitted', 'submitted', 'submitted', 'submitted']);
  const held = await read(await ask('/api/job', { search: '?w=GATED' }));
  check('a worker whose first five are still with the reviewer is held',
    held.status === 429 && held.body.waiting,
    held.body.reason);
  check('and the hold reads as a wait, not as the end of the road',
    /not a mark against you/i.test(held.body.reason) && !held.body.stopped,
    'a worker who thinks they have been cut off does not come back tomorrow');

  /*
   * FOUR KEPT AND ONE EXCUSED IS FIVE PASSES. The excused one is the check
   * that matters: it is not in the corpus, and it must still count.
   */
  await history('EXCUSED', ['kept', 'kept', 'kept', 'kept', 'excused']);
  const through = await read(await ask('/api/job', { search: '?w=EXCUSED' }));
  check('and an excused map counts towards the gate, though it was not kept',
    through.status === 200 && Boolean(through.body.job),
    JSON.stringify(through.body).slice(0, 160));
  check('and the good news counts KEPT maps rather than passes',
    /^4 of your maps have been kept/.test(through.body.cleared || ''),
    `${through.body.cleared} -- calling an excused map "kept" is a small lie `
    + 'the owner\'s own review queue contradicts');

  /* Three kept, two refused: below four in five, so this is the end. */
  await history('SLOPPY', ['kept', 'kept', 'kept', 'refused', 'refused']);
  const stopped = await read(await ask('/api/job', { search: '?w=SLOPPY' }));
  check('and a worker below the bar is stopped rather than held',
    stopped.status === 429 && stopped.body.stopped && !stopped.body.waiting,
    stopped.body.reason);
  check('and is thanked and told they were paid',
    /thank you/i.test(stopped.body.reason) && /paid/i.test(stopped.body.reason),
    'this is the one refusal that cannot be fixed by waiting');

  /* Through the first gate, working the second: ten more, then held again. */
  await history('SECOND', [
    ...Array(5).fill('kept'),
    ...Array(10).fill('submitted'),
  ]);
  const again = await read(await ask('/api/job', { search: '?w=SECOND' }));
  check('and the second gate holds them again after ten more',
    again.status === 429 && again.body.waiting,
    `15 submitted, 5 reviewed -- ${again.body.reason}`);

  /*
   * AND THE OWNER CAN LIFT IT, which is what makes hiring somebody directly
   * workable at all. Paid by the hour, a person held at a five-map wall is
   * being paid to wait for a review -- so the gates, which exist to find out
   * whether an anonymous stranger can do this, become a bill.
   *
   * Written against the same worker who was just refused, because the pair is
   * the claim: nothing about them changed except the owner's decision.
   */
  await env.DB.prepare(
    `INSERT INTO lawn_workers (worker, trusted, note, created_at)
     VALUES ('GATED', 1, 'hired directly, paid hourly', '2026-09-19T00:00:00Z')`
  ).run();
  const lifted = await read(await ask('/api/job', { search: '?w=GATED' }));
  check('and a worker the owner trusts walks through the gate that just refused them',
    lifted.status === 200 && Boolean(lifted.body.job),
    `${held.body.reason ? 'was held' : '?'} -> ${lifted.body.job?.id || lifted.body.reason}`);

  /*
   * BUT NOT THROUGH ONE LAWN AT A TIME. Trust is a judgement about somebody's
   * work; holding two lawns is how one lawn gets paid for twice, and no
   * judgement about a person changes that arithmetic.
   */
  const twice = await read(await ask('/api/job', { search: '?w=GATED' }));
  check('while still being handed the one they already hold, not a second',
    twice.body.job?.id === lifted.body.job?.id && twice.body.resumed,
    JSON.stringify({ first: lifted.body.job?.id, again: twice.body.job?.id }));
}

/* --------------------------------------- the three ways somebody arrives */
{
  await seed(4, 300);

  /*
   * A VOLUNTEER ARRIVES THROUGH ONE SHARED PUBLIC LINK with no id in it, so
   * the browser mints a name and the link says which route it is. That is the
   * only route a link may assert, and it is safe because what a forger gains
   * by faking it is the right to work for nothing.
   */
  const helper = await read(await ask('/api/job', { search: '?w=helper-abc123&via=volunteer' }));
  check('a volunteer with no history at all is handed a lawn',
    helper.status === 200 && helper.body.route === 'volunteer',
    JSON.stringify({ route: helper.body.route, job: Boolean(helper.body.job) }));

  /*
   * AND THE ROUTE IS WRITTEN ON THE JOB, not merely acted on and discarded.
   *
   * It was computed on every claim -- it decides the gates, the cap and what
   * somebody sees at the end -- and then thrown away, so the page that shows
   * the owner who is tracing had nothing to read and called everybody a crowd
   * worker. Seven volunteers listed as crowd workers on a batch where no
   * crowd link had ever been handed out.
   */
  const written = await env.DB.prepare(
    'SELECT route, worker FROM lawn_jobs WHERE id = ?1'
  ).bind(helper.body.job.id).first();
  check('and the link they used is recorded on the lawn they were given',
    written.route === 'volunteer' && written.worker === 'helper-abc123',
    `route=${written.route} -- computed and discarded is how a page ends up `
    + 'asserting a route nobody used');

  /*
   * AND IS NOT HELD TO THE TIME FLOOR. A timer on donated work can only ever
   * turn it away -- there is no money to protect by refusing it.
   */
  const map = {
    worker: 'helper-abc123',
    id: helper.body.job.id,
    edited: true,
    frame: { lng: -80, lat: 40, zoom: 19, size: 640 },
    shapes: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[-80, 40], [-79.999, 40], [-79.999, 40.001], [-80, 40]]],
      },
    }],
  };
  const quick = await read(await ask('/api/job/submit', {
    method: 'POST', body: map, search: '?via=volunteer',
  }));
  check('and may send it straight away, with no floor to clear',
    quick.status === 200 && quick.body.ok,
    quick.body.reason || 'sent within seconds of claiming');

  /*
   * AND GETS A COUNT RATHER THAN A CODE. There is no platform and no
   * transaction, so eight characters with nowhere to paste them is a puzzle
   * rather than a receipt.
   */
  check('and is thanked with a count rather than a completion code',
    !quick.body.code && /thank you/i.test(quick.body.thanks || '')
    && /1 lawn/.test(quick.body.thanks || ''),
    quick.body.thanks);

  /*
   * A HIRED WORKER IS NOT SOMETHING A LINK CAN CLAIM TO BE. That route lifts
   * the completion code, and more importantly the row it is stored in is what
   * the owner uses to lift the gates -- a query string must not reach it.
   */
  await env.DB.prepare(
    `INSERT INTO lawn_workers (worker, trusted, kind, created_at)
     VALUES ('JANE', 1, 'hired', '2026-09-19T00:00:00Z')`
  ).run();
  const jane = await read(await ask('/api/job', { search: '?w=JANE' }));
  check('somebody the owner marked as hired is recognised from the row, not the link',
    jane.status === 200 && jane.body.route === 'hired',
    jane.body.route);

  const faker = await read(await ask('/api/job', { search: '?w=CHANCER&via=hired' }));
  check('while a link claiming to be hired is ignored',
    faker.body.route === 'crowd',
    `${faker.body.route} -- otherwise the gates are a suggestion in a URL`);
}

/* ------------------------------------------ the paid public link */
{
  /*
   * THE ONE ROUTE WHERE THE ID IS NOT TAKEN FROM THE REQUEST.
   *
   * Every other worker id arrives in a URL, because there is nothing there
   * worth forging: a crowd id is issued by a platform that will not pay a
   * stranger for it, and a volunteer id buys the right to work for nothing.
   *
   * Money changes that. An id in a query string is typed by whoever is typing,
   * so trusting one here would be a claim on somebody else's earnings -- and,
   * far likelier than theft, a way to hang rubbish on a real person's record.
   */
  await seed(3, 400);

  const anon = await read(await ask('/api/job', { search: '?via=paid' }));
  check('the paid link refuses somebody who is not signed in',
    anon.status === 401 && anon.body.needsAccount === true,
    anon.body.reason);
  check('and says why the account is needed, in terms of what it buys them',
    /pay|bounce/i.test(anon.body.reason || ''),
    'an account demanded without a reason reads as a data grab');
  check('and points at the unpaid version rather than ending there',
    /volunteer/i.test(anon.body.reason || ''),
    'somebody who will not sign in should still be able to help');

  /* And a forged id in the link buys nothing, because it is never read. */
  const forged = await read(await ask('/api/job', { search: '?via=paid&w=NOTTHEIRNAME' }));
  check('and an id typed into the paid link is ignored entirely',
    forged.status === 401,
    'otherwise the link is a claim on another person\'s earnings');

  const touched = await env.DB.prepare(
    "SELECT COUNT(*) n FROM lawn_jobs WHERE worker = 'NOTTHEIRNAME'"
  ).first();
  check('and no lawn is attached to the name it tried to use',
    Number(touched.n) === 0, 'a refused claim must not leave a trace on somebody');
}

/* ------------------------------------------------ an empty queue */
{
  await env.DB.prepare("UPDATE lawn_jobs SET state = 'submitted' WHERE state != 'submitted'").run();
  const empty = await read(await ask('/api/job', { search: '?w=LATECOMER' }));
  check('an empty batch thanks somebody rather than erroring at them',
    empty.status === 404 && /thank you/i.test(empty.body.reason),
    empty.body.reason);
}

/* -------------------------------------------------- a shuffled queue */
{
  /*
   * NOT IN THE ORDER THEY WERE SCREENED, and this is the check that pins why.
   *
   * Addresses are imported a county at a time, from one county's parcel server
   * in one run, so created_at is sorted by county almost perfectly. Handing out
   * the oldest approved lawn therefore emptied one county before starting the
   * next, and somebody doing twenty maps in an evening got twenty maps from the
   * same few streets. Several said so. It is worse than dull: the variety is
   * exactly what the detector is bad at, and a volunteer who is bored stops.
   *
   * Tested by claiming the same position in the queue many times over and
   * seeing more than one row come back. A shuffle that happened to be
   * chronological would pass an "is it different from oldest" check on a lucky
   * run, which is why this counts distinct answers instead.
   */
  await env.DB.prepare("UPDATE lawn_jobs SET state = 'done' WHERE state = 'approved'").run();
  await seed(12, 800);

  const seenIds = new Set();
  for (let i = 0; i < 12; i++) {
    const got = await read(await ask('/api/job', { search: `?w=SHUFFLE${i}` }));
    if (got.body.job?.id) seenIds.add(got.body.job.id);
    /* Hand it straight back, so every one of these is the same draw from the
       same twelve rows rather than twelve draws from a shrinking queue. */
    await ask('/api/job/skip', {
      method: 'POST', body: { worker: `SHUFFLE${i}`, id: got.body.job?.id },
    });
  }
  check('twelve workers drawing from twelve lawns do not all get the same one',
    seenIds.size > 1,
    `${seenIds.size} distinct lawns in 12 draws -- oldest-first would give 1`);

  /*
   * AND A LAWN PEOPLE KEEP PUTTING BACK STILL SINKS. Moving created_at used to
   * do this and stopped meaning anything the moment the order became random, so
   * the skip note carries it instead -- which is a thing that can silently stop
   * working, because nothing about it throws. See SKIP_NOTE.
   */
  await env.DB.prepare("UPDATE lawn_jobs SET state = 'done' WHERE state = 'approved'").run();
  await seed(2, 850);
  await env.DB.prepare(
    "UPDATE lawn_jobs SET note = 'skipped by SOMEBODY: too wooded' WHERE id = ?1"
  ).bind(idFor(850)).run();

  const draws = new Set();
  for (let i = 0; i < 10; i++) {
    const got = await read(await ask('/api/job', { search: `?w=SINK${i}` }));
    draws.add(got.body.job?.id);
    await env.DB.prepare(
      "UPDATE lawn_jobs SET state = 'approved', worker = NULL, claimed_at = NULL WHERE id = ?1"
    ).bind(got.body.job?.id).run();
  }
  check('a lawn somebody has already put back is offered last',
    draws.size === 1 && draws.has(idFor(851)),
    `${[...draws].join(', ')} -- an awkward lawn belongs at the bottom, not in `
    + 'rotation at the top');
}

/* ----------------------------------- the skip that came back anyway */
/*
 * REPORTED BY A VOLUNTEER: "when they click they can't do this one, they get
 * the same one back". Moving created_at to the back of the queue -- the fix
 * the block above pins -- turns out not to be enough, in two ways.
 */
{
  /*
   * ONE: A QUEUE OF ONE HAS NO BACK. With a single approved lawn left,
   * "oldest approved" is the lawn that was just refused however its
   * created_at is rearranged. Reordering cannot solve this; excluding it can.
   */
  await env.DB.prepare("UPDATE lawn_jobs SET state = 'done'").run();
  await seed(1, 500);
  const first = await read(await ask('/api/job', { search: '?w=SOLO' }));
  check('with one lawn in the batch, that is the one handed out',
    first.body.job?.id === idFor(500), first.body.job?.id);

  await ask('/api/job/skip', { method: 'POST', body: { worker: 'SOLO', id: idFor(500) } });
  const again = await read(await ask('/api/job', {
    search: `?w=SOLO&not=${idFor(500)}`,
  }));
  check('skipping the only one hands it back rather than an empty screen',
    again.body.job?.id === idFor(500), again.body.job?.id);
  check('AND SAYS SO, which is the whole difference between this and a bug',
    again.body.only === true,
    'silence here reads as a broken button, which is how it was reported');

  /* With something else available, the skipped one must not come back. */
  await ask('/api/job/skip', { method: 'POST', body: { worker: 'SOLO', id: idFor(500) } });
  await seed(1, 501);
  const other = await read(await ask('/api/job', {
    search: `?w=SOLO&not=${idFor(500)}`,
  }));
  check('but with anything else open, the skipped one is not offered',
    other.body.job?.id === idFor(501), other.body.job?.id);
  check('and nothing claims it was the only one',
    other.body.only === undefined, JSON.stringify(other.body.only));
}

{
  /*
   * TWO: THE CLAIM HAD ALREADY EXPIRED, and the skip silently did nothing.
   *
   * releaseStale puts a claim back after an hour, and an hour is roughly how
   * long somebody spends on a lawn they cannot do before giving up on it. By
   * then the row is 'approved' with no worker, the skip's WHERE matches
   * nothing, and the old code returned { ok: true } to a browser that asked
   * for the next lawn -- which was this one, because its place in the queue
   * had never moved. The skip looked broken because for that person it was.
   */
  await env.DB.prepare("UPDATE lawn_jobs SET state = 'done'").run();
  await seed(2, 600);
  const mine = await read(await ask('/api/job', { search: '?w=SLOW' }));
  const theirs = mine.body.job.id;
  const rivalId = theirs === idFor(600) ? idFor(601) : idFor(600);

  /* Exactly what releaseStale does to an abandoned claim. */
  await env.DB.prepare(
    `UPDATE lawn_jobs SET state = 'approved', worker = NULL, claimed_at = NULL
      WHERE id = ?1`
  ).bind(theirs).run();

  const r = await read(await ask('/api/job/skip', {
    method: 'POST', body: { worker: 'SLOW', id: theirs, why: 'gave up' },
  }));
  check('skipping a claim that already expired still moves the lawn',
    r.body.moved === true,
    'it used to answer ok:true having changed nothing at all');

  const row = await env.DB.prepare('SELECT created_at, note FROM lawn_jobs WHERE id = ?1')
    .bind(theirs).first();
  const rival = await env.DB.prepare('SELECT created_at FROM lawn_jobs WHERE id = ?1')
    .bind(rivalId).first();
  check('and the note that sinks it in the queue is written',
    /^skipped by /.test(row.note || ''),
    `${row.note} -- the handout order reads this prefix, so a note in another `
    + 'shape stops sinking anything and nothing throws');
  check('and it is still marked as touched just now',
    row.created_at > rival.created_at, `${row.created_at} vs ${rival.created_at}`);
  check('and the reason is still recorded', /gave up/.test(row.note || ''), row.note);

  const next = await read(await ask('/api/job', { search: '?w=SLOW' }));
  check('so the lawn they gave up on is not the one handed back',
    next.body.job?.id === rivalId,
    `${next.body.job?.id} -- this is the loop the whole block exists for`);
}

{
  /*
   * AND IT STILL MAY NOT TOUCH SOMEBODY ELSE'S. The new fallback updates an
   * unclaimed row, so the check that a worker cannot reach a lawn another
   * person is holding has to be made again against it.
   */
  await env.DB.prepare("UPDATE lawn_jobs SET state = 'done'").run();
  await seed(1, 700);
  await read(await ask('/api/job', { search: '?w=HOLDER' }));

  const r = await read(await ask('/api/job/skip', {
    method: 'POST', body: { worker: 'INTRUDER', id: idFor(700) },
  }));
  check('a stranger skipping a held lawn changes nothing',
    r.body.moved === false, JSON.stringify(r.body));
  const held = await env.DB.prepare('SELECT state, worker FROM lawn_jobs WHERE id = ?1')
    .bind(idFor(700)).first();
  check('and it stays with the worker holding it',
    held.state === 'claimed' && held.worker === 'HOLDER', JSON.stringify(held));
}

/* ------------------------- "I cannot do this one", on the paid route */
/*
 * REPORTED TWICE, AND THE SECOND REPORT WAS THE USEFUL ONE: "when they click
 * they can't do this one, they get the same one back". The first round of this
 * was fixed for a volunteer. The person was on the PAID route, where the button
 * was not merely unreliable -- it could not work at all.
 *
 * The paid route is the one route where the worker id is not in the request:
 * it comes from the session, because it decides who gets paid. The browser
 * posted the skip with no `via`, so the server looked in the body instead,
 * found nothing there, and refused the whole request. Nothing reads that
 * response, so the press looked as though it had worked, the claim stayed
 * standing, and the next claim RESUMED it -- before the exclusion, the sink or
 * the "that is the only one left" sentence were ever reached.
 */
{
  await env.DB.prepare("UPDATE lawn_jobs SET state = 'done'").run();
  await seed(2, 900);

  const me = await findOrCreateUser(env, {
    email: 'tracer@example.com', name: 'A Tracer', provider: 'email',
  });
  const { token } = await createSession(env, me.id);
  const signedIn = { cookie: `${SESSION_COOKIE}=${token}` };

  const got = await read(await ask('/api/job', { search: '?via=paid', ...signedIn }));
  check('a signed-in paid tracer is handed a lawn',
    got.status === 200 && got.body.route === 'paid', JSON.stringify(got.body).slice(0, 140));
  const theirs = got.body.job.id;
  check('and it is recorded against the ACCOUNT, not against anything they typed',
    (await env.DB.prepare('SELECT worker FROM lawn_jobs WHERE id = ?1')
      .bind(theirs).first()).worker === me.id,
    'this is why the skip has to read the session too');

  /*
   * THE OLD CLIENT'S SKIP, KEPT AS THE WITNESS. With no `via` there is no
   * identity to be had on this route, and the honest answer is a refusal --
   * which is what the server gave, and what the browser threw away.
   */
  const blind = await read(await ask('/api/job/skip', {
    method: 'POST', body: { worker: null, id: theirs }, ...signedIn,
  }));
  check('a skip that does not say which route it is on cannot name the worker',
    blind.status === 400,
    `${blind.status} -- and the page never looked at this, which is why the `
    + 'button seemed to work while doing nothing');
  check('and the lawn is still in their hands, as the report described',
    (await env.DB.prepare('SELECT state FROM lawn_jobs WHERE id = ?1')
      .bind(theirs).first()).state === 'claimed',
    'the claim standing is what made the next request resume it');

  /*
   * BUT THE NEXT CLAIM STILL GETS THEM OUT OF IT. The browser sends `not`, and
   * a claim that names the lawn the worker is holding releases it rather than
   * resuming it -- so a skip that fails for ANY reason, offline or 500 or this
   * one, cannot put somebody back in the loop.
   */
  const away = await read(await ask('/api/job', {
    search: `?via=paid&not=${theirs}`, ...signedIn,
  }));
  check('a claim that says "anything but this one" is not handed that one back',
    away.status === 200 && away.body.job?.id && away.body.job.id !== theirs,
    `${away.body.job?.id} vs ${theirs}`);
  const released = await env.DB.prepare('SELECT state, worker, note FROM lawn_jobs WHERE id = ?1')
    .bind(theirs).first();
  check('and the lawn they could not do is back in the queue for somebody else',
    released.state === 'approved' && !released.worker, JSON.stringify(released));
  check('marked so that it sinks rather than coming round again',
    /^skipped by /.test(released.note || ''), released.note);

  /* And with `via` on it, the button does its own job properly. */
  const proper = await read(await ask('/api/job/skip', {
    method: 'POST',
    search: '?via=paid',
    body: { id: away.body.job.id, why: 'all under canopy' },
    ...signedIn,
  }));
  check('and a paid skip that carries its route moves the lawn itself',
    proper.status === 200 && proper.body.moved === true, JSON.stringify(proper.body));
  const back = await env.DB.prepare('SELECT state, worker, note FROM lawn_jobs WHERE id = ?1')
    .bind(away.body.job.id).first();
  check('putting it back with the reason on it',
    back.state === 'approved' && !back.worker && /all under canopy/.test(back.note || ''),
    JSON.stringify(back));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
