/**
 * The rules that stop one person taking the whole batch.
 *
 * WHY THESE ARE TESTED AWAY FROM THE DATABASE. They are the entire defence
 * against somebody farming a paid queue, and every one of them is a comparison
 * that cannot throw. A cap that reads the wrong way round does not error -- it
 * lets one worker hold forty lawns, or refuses everybody, and both look like
 * "the task had no takers" from the outside.
 *
 * The rules are also deliberately weak in one direction, and the tests say so:
 * none of this can tell a careless worker from a careful one. That is the
 * owner's eye afterwards. These only make VOLUME impossible to fake.
 *
 *   node tools/jobs.test.js
 */

import {
  claimVerdict, submissionVerdict, cleanWorker, staleBefore, dayStart,
  MIN_SECONDS, MAX_HELD, DAILY_CAP,
} from '../worker/src/jobs.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const NOW = Date.parse('2026-09-19T12:00:00Z');

/* ------------------------------------------------- one lawn at a time */
{
  check('a worker holding nothing may take one',
    claimVerdict({ held: 0, now: NOW }).ok, '');
  check('and a worker already holding one may not',
    !claimVerdict({ held: MAX_HELD, now: NOW }).ok,
    'stockpiling is how somebody submits rubbish for twenty lawns at once');

  const refused = claimVerdict({ held: 1, now: NOW });
  check('and is told what to do about it',
    /finish or skip/i.test(refused.reason),
    refused.reason);
}

/* ------------------------------------------------------- the daily cap */
{
  check('a worker under the cap may carry on',
    claimVerdict({ submittedToday: DAILY_CAP - 1, now: NOW }).ok, '');
  check('and one at it may not',
    !claimVerdict({ submittedToday: DAILY_CAP, now: NOW }).ok,
    `${DAILY_CAP} a day, so nobody takes the batch before it has been looked at`);

  /*
   * The refusal has to read as "come back", not as "you are banned". These are
   * people being paid by the piece, and a worker who thinks they have been cut
   * off does not return tomorrow -- which costs the batch its best workers.
   */
  const capped = claimVerdict({ submittedToday: DAILY_CAP, now: NOW });
  check('and is invited back rather than turned away',
    /tomorrow/i.test(capped.reason) && !/ban|block|abuse/i.test(capped.reason),
    capped.reason);
}

/* --------------------------------------------------------- the floor */
{
  const justNow = new Date(NOW - 10_000).toISOString();
  const ago = new Date(NOW - 5 * 60_000).toISOString();

  check('somebody who submitted seconds ago is asked to wait',
    !claimVerdict({ lastSubmitAt: justNow, now: NOW }).ok,
    'submitting instantly and taking another is the pattern being caught');
  check('and told how long',
    claimVerdict({ lastSubmitAt: justNow, now: NOW }).wait > 0,
    `${claimVerdict({ lastSubmitAt: justNow, now: NOW }).wait} seconds`);
  check('somebody who worked for five minutes is not',
    claimVerdict({ lastSubmitAt: ago, now: NOW }).ok, '');

  /*
   * A CLOCK THAT DISAGREES MUST NOT LOCK SOMEBODY OUT. If a stored timestamp
   * is somehow in the future, `since` goes negative -- and a naive check would
   * read that as "no time has passed" and refuse for ever.
   */
  const future = new Date(NOW + 60_000).toISOString();
  check('and a timestamp from the future does not lock anybody out for ever',
    claimVerdict({ lastSubmitAt: future, now: NOW }).ok,
    'a negative gap is a broken clock, not a fast worker');
}

/* -------------------------------------------- what a submission must clear */
{
  const claimed = (secs) => new Date(NOW - secs * 1000).toISOString();

  check('a map submitted in forty seconds is refused',
    !submissionVerdict({ claimedAt: claimed(40), now: NOW, edited: true }).ok,
    'a lawn traced in forty seconds was not traced');
  check('and one that took four minutes is not',
    submissionVerdict({ claimedAt: claimed(240), now: NOW, edited: true }).ok, '');

  /*
   * THE OUTLINE IS THE STARTING POINT, NOT THE ANSWER. A worker who submits
   * SAM's shape untouched has done nothing they are being paid for, however
   * long they sat on it -- and this is the one thing a machine can check.
   */
  const untouched = submissionVerdict({ claimedAt: claimed(300), now: NOW, edited: false });
  check('an untouched automatic outline is refused however long it was held',
    !untouched.ok, untouched.reason);
  check('and the refusal says what correcting means',
    /drive|edges/i.test(submissionVerdict({ claimedAt: claimed(10), now: NOW }).reason),
    'a refusal that does not teach gets the same map back');

  /*
   * And it is honest about what it cannot do: a slow, careless map passes.
   * Pretending otherwise would put bad maps into the corpus with a tick beside
   * them, which is worse than no check at all (H7: one bad map is worth up to
   * ten points).
   */
  check('a slow but careless map still passes, which is the owner\'s call',
    submissionVerdict({ claimedAt: claimed(600), now: NOW, edited: true }).ok,
    'no number can judge this, and a number that pretended to would be trusted');
}

/* ------------------------------------------------------- the worker id */
{
  check('a platform id survives',
    cleanWorker('A2X9QJ3KLM0ZZ1') === 'A2X9QJ3KLM0ZZ1', cleanWorker('A2X9QJ3KLM0ZZ1'));
  check('and anything that is not one is stripped',
    cleanWorker('<script>alert(1)</script>') === 'scriptalert1script',
    'this goes into a database and onto the owner\'s screen');
  check('and a long one is cut short',
    cleanWorker('x'.repeat(200)).length === 64, String(cleanWorker('x'.repeat(200)).length));
  check('and nothing at all comes back empty, not anonymous',
    cleanWorker('') === '' && cleanWorker(null) === '',
    'an unnamed worker cannot be rate limited and cannot be paid either');
}

/* ------------------------------------------------------- the clocks */
{
  check('a stale claim is an hour old',
    Date.parse(staleBefore(NOW)) === NOW - 3600_000, staleBefore(NOW));
  check('and the day starts at midnight UTC',
    dayStart(NOW) === '2026-09-19T00:00:00.000Z', dayStart(NOW));
  check('and the floor is well under the task it guards',
    MIN_SECONDS < 300 / 2,
    `${MIN_SECONDS}s against a five-minute task -- set near the average it `
    + 'would reject good work on small gardens');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
