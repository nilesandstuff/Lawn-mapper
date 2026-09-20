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

const ask = (path, { method = 'GET', body, search = '' } = {}) => handleJobs(
  new Request(`https://x${path}${search}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
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

  const first = await read(await ask('/api/job', { search: '?w=WORKER1' }));
  check('a worker gets a lawn',
    first.status === 200 && first.body.job?.id === idFor(0),
    JSON.stringify(first.body.job));
  check('and the oldest one, so the queue drains rather than churns',
    first.body.job.id === idFor(0), first.body.job.id);
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
    again.status === 200 && again.body.job.id === idFor(0) && again.body.resumed,
    JSON.stringify({ id: again.body.job?.id, resumed: again.body.resumed }));

  /* And a different worker gets a DIFFERENT lawn, which is the whole race. */
  const other = await read(await ask('/api/job', { search: '?w=WORKER2' }));
  check('a second worker is never handed the first worker\'s lawn',
    other.body.job.id === idFor(1),
    `${other.body.job.id} -- handing two people one lawn is paying twice for one map`);
}

/* ------------------------------------------------------------ skipping */
{
  const before = await env.DB.prepare('SELECT state, worker FROM lawn_jobs WHERE id = ?1')
    .bind(idFor(1)).first();
  check('a claimed lawn is held by the worker who claimed it',
    before.state === 'claimed' && before.worker === 'WORKER2', JSON.stringify(before));

  /*
   * A SKIP MAY ONLY RELEASE YOUR OWN. A mis-scoped WHERE here lets any worker
   * free any other worker's lawn, which on a busy batch would be indisponible
   * chaos that looks like the queue misbehaving.
   */
  await ask('/api/job/skip', { method: 'POST', body: { worker: 'WORKER1', id: idFor(1) } });
  const stolen = await env.DB.prepare('SELECT state, worker FROM lawn_jobs WHERE id = ?1')
    .bind(idFor(1)).first();
  check('one worker cannot skip another worker\'s lawn',
    stolen.state === 'claimed' && stolen.worker === 'WORKER2', JSON.stringify(stolen));

  await ask('/api/job/skip', {
    method: 'POST', body: { worker: 'WORKER2', id: idFor(1), why: 'cannot see the boundary' },
  });
  const freed = await env.DB.prepare('SELECT state, worker, note FROM lawn_jobs WHERE id = ?1')
    .bind(idFor(1)).first();
  check('and a worker skipping their own puts it back for somebody else',
    freed.state === 'approved' && !freed.worker,
    'one person being unable to trace a lawn says nothing about the lawn');
  check('and the reason is kept, because several skips on one lawn is a signal',
    /cannot see the boundary/.test(freed.note || ''), freed.note);

  /*
   * AND IT GOES TO THE BACK, which a browser run caught and this pins.
   *
   * The queue hands out the oldest approved lawn. A skip that only cleared the
   * claim handed the very same lawn straight back to the person who had just
   * said they could not do it -- a loop with no way out, on the one screen
   * where somebody is being paid by the minute.
   */
  const after = await read(await ask('/api/job', { search: '?w=WORKER2' }));
  check('and the worker who skipped is not handed it straight back',
    after.body.job?.id === idFor(2),
    `${after.body.job?.id} -- getting the same lawn again is a loop with no `
    + 'way out of it');

  /* Put it back, so the blocks below start where they expect to. */
  await ask('/api/job/skip', {
    method: 'POST', body: { worker: 'WORKER2', id: idFor(2) },
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
    await spendJobDetection(env, idFor(0), 'WORKER1'),
    'the outline is what they are paid to correct, so they must be able to get one');

  check('but not on somebody else\'s',
    !(await spendJobDetection(env, idFor(0), 'WORKER9')),
    'a job id is not a secret -- the claim is what makes this safe');

  check('and not on a lawn nobody is holding',
    !(await spendJobDetection(env, idFor(2), 'WORKER1')),
    'an unclaimed row would be free predictions for anybody who guessed an id');

  check('and not without an id at all',
    !(await spendJobDetection(env, idFor(0), ''))
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
    spent.push(await spendJobDetection(env, idFor(0), 'WORKER1'));
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
    (await spendJobDetection(env, idFor(0), 'WORKER1', -1))
    && (await spendJobDetection(env, idFor(0), 'WORKER1')),
    'the detector refusing us is not the worker\'s mistake');

  const row = await env.DB.prepare('SELECT detections FROM lawn_jobs WHERE id = ?1')
    .bind(idFor(0)).first();
  check('and the count never goes below nothing',
    !(await spendJobDetection(env, idFor(0), 'WORKER1', -99))
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
    id: idFor(0),
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
    .bind(idFor(0), new Date(Date.now() - 300_000).toISOString()).run();

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

  const row = await env.DB.prepare('SELECT * FROM lawn_jobs WHERE id = ?1').bind(idFor(0)).first();
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
  check('and a claim nobody came back to is given to the next person',
    rescued.status === 200 && rescued.body.job.id === mine.body.job.id,
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
}

/* ------------------------------------------------ an empty queue */
{
  await env.DB.prepare("UPDATE lawn_jobs SET state = 'submitted' WHERE state != 'submitted'").run();
  const empty = await read(await ask('/api/job', { search: '?w=LATECOMER' }));
  check('an empty batch thanks somebody rather than erroring at them',
    empty.status === 404 && /thank you/i.test(empty.body.reason),
    empty.body.reason);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
