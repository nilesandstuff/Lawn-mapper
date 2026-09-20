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
import { handleJobs, PROMPTS } from '../worker/src/routes-jobs.js';
import { MIN_SECONDS, DAILY_CAP } from '../worker/src/jobs.js';

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
