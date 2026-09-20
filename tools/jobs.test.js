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
  countsAsPass, MIN_SECONDS, MAX_HELD, DAILY_CAP, GATES, PASS_RATE,
  REVIEW_OUTCOMES,
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

/* ------------------------------------------------------------- the gates */
{
  const [FIRST, SECOND] = GATES;

  /*
   * THE GATES REPLACED AN AUDITION, and then replaced a one-map version of
   * themselves. Both changes are worth keeping in view:
   *
   * An audition pays somebody to trace a lawn that is already traced, which
   * buys a signal and no map. A gate buys the same signal out of real work.
   *
   * The one-map version let somebody through on ONE kept map out of five,
   * which is the wrong way round. The addresses are already vetted and the
   * owner intends to tidy every map anyway, so a refusal here means the map
   * was truly bad rather than imperfect -- and four bad out of five is not
   * somebody having an off day.
   */
  check('a new worker may do their first few',
    claimVerdict({ submittedEver: FIRST - 1, now: NOW }).ok,
    `${FIRST} before anything has been reviewed`);

  const held = claimVerdict({ submittedEver: FIRST, now: NOW });
  check('and is held at the first gate until they have been looked at',
    !held.ok && held.waiting,
    `${FIRST} maps is the whole cost of finding out somebody cannot do this`);

  /*
   * THE WORDING IS AS MUCH OF THE FEATURE AS THE NUMBER. Somebody here has
   * done five maps, been paid for five maps and done nothing wrong -- and the
   * workers who read carefully enough to be worth keeping are exactly the ones
   * who will read this. It has to say what is happening, how long, and that
   * more follows.
   */
  check('and told this is not a mark against them',
    /not a mark against you/i.test(held.reason), held.reason);
  check('and that they are paid either way',
    /paid/i.test(held.reason), held.reason);
  check('and roughly how long the wait is',
    /inside a day/i.test(held.reason), held.reason);
  check('and that there is more work after it',
    /there will be more/i.test(held.reason), held.reason);

  /*
   * AND NO PROMISE ABOUT THE OUTCOME. Telling somebody their maps will be
   * kept before anybody has looked is a promise this cannot keep, and a broken
   * one costs more than the wait it was meant to soften.
   */
  check('while promising nothing about whether they will be kept',
    !/will be (accepted|kept|approved)/i.test(held.reason), held.reason);

  /* Four out of five clears it; three out of five does not. */
  const pass = Math.ceil(FIRST * PASS_RATE);
  check(`${pass} of ${FIRST} clears the first gate`,
    claimVerdict({ submittedEver: FIRST, passed: pass, refused: FIRST - pass, now: NOW }).ok,
    'the owner tidies every map, so a refusal means the map was truly bad');

  const stopped = claimVerdict({
    submittedEver: FIRST, passed: pass - 1, refused: FIRST - pass + 1, now: NOW,
  });
  check('and one below it does not',
    !stopped.ok && stopped.stopped,
    `${pass - 1} of ${FIRST} against a bar of ${PASS_RATE}`);

  /*
   * THE ONE REFUSAL A WORKER CANNOT FIX BY WAITING, read by somebody who has
   * just been told there is no more work. A person who feels insulted writes
   * about it, and the next batch is harder to fill.
   */
  check('and is thanked and confirmed paid rather than lectured',
    /paid/i.test(stopped.reason) && /thank you/i.test(stopped.reason)
    && !/ban|abuse|poor|bad work/i.test(stopped.reason),
    stopped.reason);

  /*
   * A HARD LAWN IS NOT A BLACK MARK. The queue hands lawns out in order, so
   * who gets the awkward ones is pure luck -- and without the excuse button a
   * run of them would end a good worker's run. An excused map is not kept, and
   * still counts for them.
   */
  check('an excused map counts as a pass, though it is not kept',
    countsAsPass('excused') && countsAsPass('kept') && !countsAsPass('refused'),
    REVIEW_OUTCOMES.join(' / '));
  check('so a worker excused through the gate carries on',
    claimVerdict({ submittedEver: FIRST, passed: FIRST, refused: 0, now: NOW }).ok,
    'whoever draws the awkward lawns must not be punished for the draw');

  /*
   * THE SECOND GATE, which is the point of there being two. The first is
   * cheap and catches somebody who cannot do this at all; the second tells a
   * careful worker from a lucky one, and costs at most ten more maps to find
   * out.
   */
  check('past the first gate they are let out to a larger batch, not the whole queue',
    claimVerdict({ submittedEver: SECOND - 1, passed: FIRST, refused: 0, now: NOW }).ok
    && !claimVerdict({ submittedEver: SECOND, passed: FIRST, refused: 0, now: NOW }).ok,
    `${FIRST}, then ${SECOND}, then the daily cap`);

  const second = claimVerdict({ submittedEver: SECOND, passed: FIRST, refused: 0, now: NOW });
  check('and held at the second gate the same way, with the same wording',
    second.waiting && /not a mark against you/i.test(second.reason),
    'two gates that drift apart in their wording are two features to explain');

  const bar = Math.ceil(SECOND * PASS_RATE);
  check(`${bar} of ${SECOND} clears the second gate`,
    claimVerdict({ submittedEver: SECOND, passed: bar, refused: SECOND - bar, now: NOW }).ok,
    `${(bar / SECOND).toFixed(2)} against a bar of ${PASS_RATE}`);
  check('and one below it stops there',
    !claimVerdict({
      submittedEver: SECOND, passed: bar - 1, refused: SECOND - bar + 1, now: NOW,
    }).ok,
    'a worker can be lucky over five maps and not over fifteen');

  check('and the daily cap still applies once they are through both',
    !claimVerdict({
      submittedEver: 99, passed: 99, refused: 0, submittedToday: DAILY_CAP, now: NOW,
    }).ok,
    'proving yourself does not remove the ceiling');
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
  check('an untouched automatic outline is refused the first time',
    !untouched.ok && untouched.unchanged, untouched.reason);

  /*
   * BUT IT IS A QUESTION, NOT A LOCKED DOOR, and that is the whole reputation
   * of the task. Now and then the automatic outline really is right, and a
   * hard refusal would leave an honest worker who checked it carefully with
   * four minutes of work they cannot submit. Work done that cannot be paid for
   * is the fastest way for a requester to be written up on a worker forum --
   * and here it would be OUR bug producing it, not their behaviour.
   *
   * Sending it again goes through, flagged, so somebody waving work through
   * still does it twice and still lands in a review queue.
   */
  const confirmed = submissionVerdict({
    claimedAt: claimed(300), now: NOW, edited: false, confirmedUnchanged: true,
  });
  check('and goes through on a second send, flagged for the owner',
    confirmed.ok && confirmed.flag === 'unchanged',
    JSON.stringify(confirmed));
  check('while an ordinary corrected map carries no flag',
    submissionVerdict({ claimedAt: claimed(300), now: NOW, edited: true }).flag === null,
    'only the unusual ones should surface first in a review queue');
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
