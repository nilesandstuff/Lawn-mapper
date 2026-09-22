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
  claimVerdict, submissionVerdict, cleanWorker, looksUnsubstituted, staleBefore, dayStart,
  countsAsPass, MIN_SECONDS, MAX_HELD, DAILY_CAP, GATES, PASS_RATE,
  REVIEW_OUTCOMES, ROUTES, cleanRoute, needsCode, routeFromLink, cleanPayoutHandle,
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

  /*
   * EXCEPT FOR SOMEBODY THE OWNER HAS ALREADY DECIDED ABOUT.
   *
   * The queue is fed from two directions: a crowd platform, where workers are
   * anonymous and unknown, and one or two people hired directly and paid by
   * the hour. Everything above this line exists to find out whether a stranger
   * can do this -- and for the second group it has already been answered, by a
   * person looking at their maps. Left in place, the gates bill the owner for
   * a hired worker sitting at a five-map wall waiting on a review.
   */
  const hired = { submittedEver: FIRST, passed: 0, refused: FIRST, trusted: true, now: NOW };
  check('somebody the owner trusts is not held at a gate',
    claimVerdict(hired).ok,
    'a hired worker waiting on a review is being paid to wait');
  check('nor stopped by a bad record from before they were trusted',
    claimVerdict({ ...hired, submittedEver: 40, passed: 1, refused: 39 }).ok,
    'the owner looked and decided anyway, which outranks the arithmetic');
  check('nor capped at forty a day',
    claimVerdict({ ...hired, submittedToday: DAILY_CAP * 3 }).ok,
    `${DAILY_CAP} is a ceiling on a stranger, not on somebody engaged to do more`);

  /*
   * BUT ONE LAWN AT A TIME STILL HOLDS, and that is the line worth drawing:
   * holding two is how one lawn gets paid for twice, which is not a question
   * about anybody's character.
   */
  check('and still may not hold two lawns at once',
    !claimVerdict({ ...hired, held: MAX_HELD }).ok,
    'stockpiling is an arithmetic problem, not a trust one');

  /*
   * AND SOMEBODY WHO IS NOT BEING PAID AT ALL.
   *
   * The gates decide whether to keep spending money on a stranger. There is no
   * money here -- a volunteer followed a public link to do the owner a favour
   * -- so holding one at a five-map wall to wait for a review turns a good
   * deed into a chore, and the pass rate is a judgement nobody asked them to
   * submit to.
   */
  const helper = { route: 'volunteer', now: NOW };
  check('a volunteer is never held at a gate',
    claimVerdict({ ...helper, submittedEver: FIRST }).ok
    && claimVerdict({ ...helper, submittedEver: SECOND }).ok,
    'probation on somebody doing you a favour is an insult');
  check('nor stopped by a pass rate',
    claimVerdict({ ...helper, submittedEver: 20, passed: 1, refused: 19 }).ok,
    'they are not being paid, so there is nothing to protect by refusing them');
  check('nor made to wait between maps',
    claimVerdict({ ...helper, lastSubmitAt: new Date(NOW - 5000).toISOString() }).ok,
    'a timer on donated work can only ever turn it away');

  /*
   * BUT THE DAILY CAP STAYS, and it is the only thing that does. Not as a
   * judgement on anybody: one shared public link is the single place where one
   * bad actor could empty the queue into the review pile in an afternoon.
   */
  check('while the daily cap still holds, because the link is public',
    !claimVerdict({ ...helper, submittedToday: DAILY_CAP }).ok,
    'the one thing a shared link makes possible is one person flooding it');
  check('and they still hold one lawn at a time',
    !claimVerdict({ ...helper, held: MAX_HELD }).ok,
    'two volunteers on one claim would fight over a lawn neither can see');
}

/* --------------------------------------------- what each route is owed */
{
  /*
   * A COMPLETION CODE IS PROOF OF WORK FOR A PLATFORM. Somebody hired directly
   * has no platform and a volunteer has no transaction, so for both of them a
   * code is a puzzle rather than a receipt: eight characters, no field to put
   * them in, and a nagging sense of having missed a step.
   */
  check('only a crowd worker needs a completion code',
    needsCode('crowd') && !needsCode('hired') && !needsCode('volunteer'),
    ROUTES.join(' / '));

  check('and an unknown route is treated as the guarded one',
    cleanRoute('nonsense') === 'crowd' && cleanRoute(null) === 'crowd',
    'guessing wrong has to fail towards the rules, not away from them');

  /*
   * A LINK MAY ONLY EVER PROPOSE "VOLUNTEER", and this is the check that keeps
   * the whole arrangement honest: two of the three routes lift real
   * protections, so a paid stranger appending `&via=hired` must not walk
   * through the gates that exist to stop exactly that. Volunteer is safe to
   * assert because what a forger gains by it is the right to work for free.
   */
  check('a link can offer to be a volunteer',
    routeFromLink('volunteer') === 'volunteer', 'nothing worth forging');
  check('and to be the paid public link',
    routeFromLink('paid') === 'paid',
    'it lifts no rule the volunteer route does not, and the identity behind it '
    + 'is read from a session rather than from the URL');
  check('and cannot claim anything that lifts a protection',
    routeFromLink('hired') === null && routeFromLink('crowd') === null
    && routeFromLink('trusted') === null,
    'otherwise the gates are a suggestion in a query string');
}

/* ------------------------------------------- the paid public link */
{
  /*
   * THE SAME RULES AS A VOLUNTEER, deliberately and exactly.
   *
   * Nothing is promised in advance on either: a volunteer is doing a favour,
   * and somebody on the paid link is owed 75c for an APPROVED map and nothing
   * for one that is not. There is no committed money for a gate to protect, so
   * gating them would be a hurdle in front of work that costs nothing when it
   * turns out badly.
   */
  const paid = { route: 'paid', now: NOW };
  check('the paid link is gated exactly as lightly as the volunteer one',
    claimVerdict({ ...paid, submittedEver: 20, passed: 0, refused: 20 }).ok
    && claimVerdict({ ...paid, lastSubmitAt: new Date(NOW - 2000).toISOString() }).ok,
    'nothing was promised up front, so an unapproved map costs nobody anything');
  check('and keeps the same daily cap, for the same reason',
    !claimVerdict({ ...paid, submittedToday: DAILY_CAP }).ok,
    'a link posted in public is where one person could flood the queue');

  /*
   * THE CAP MUST NOT TURN INTO THE GATES, and it did.
   *
   * The open-link exemption used to read `isOpenLink(route) && submittedToday <
   * DAILY_CAP`, so a worker who reached the cap fell straight past it into the
   * gate loop -- where forty submitted maps with fewer than forty reviewed is
   * "waiting", and the sentence they were handed was the probation one: your
   * maps are with the reviewer, new workers do a few at a time, it is not a
   * mark against you. Every clause of that is wrong for them. Nothing is being
   * decided about them, and no review will lift it; it lifts at midnight.
   *
   * Reported by a paid tracer whose maps had all been approved, which is
   * exactly the person the gates are not for. Checked on the WORDING as well
   * as on the flags, because the flags are what a page titles the sheet with
   * and the wording is what somebody actually reads.
   */
  for (const route of ['paid', 'volunteer']) {
    const capped = claimVerdict({
      route, now: NOW, submittedToday: DAILY_CAP,
      /* Enough history to be past both gates, with nothing reviewed yet --
         which is the state the gates would have called probation. */
      submittedEver: DAILY_CAP, passed: 0, refused: 0,
    });
    check(`${route}: the cap is the cap and not a gate`,
      !capped.ok && capped.capped === true && !capped.waiting && !capped.stopped,
      JSON.stringify(capped));
    check(`${route}: and it says nothing about being reviewed`,
      !/review/i.test(capped.reason) && /daily limit/i.test(capped.reason),
      capped.reason);
  }

  /*
   * And a bad pass rate still cannot stop them, at the cap or under it. This is
   * the same claim as the gate check above, made at the boundary where the old
   * code changed its mind.
   */
  check('a refused history never stops an open-link worker',
    !claimVerdict({
      ...paid, submittedEver: 20, passed: 0, refused: 20, submittedToday: DAILY_CAP,
    }).stopped,
    'the batch cannot end for somebody it was never spending money on');
  check('and clears the time floor too',
    submissionVerdict({
      claimedAt: new Date(NOW - 5000).toISOString(), now: NOW, edited: true, route: 'paid',
    }).ok,
    'the floor guards committed money, and there is none here');

  check('and neither open route pastes a code anywhere',
    !needsCode('paid') && !needsCode('volunteer') && needsCode('crowd'),
    'there is no platform waiting for proof of work');

  /*
   * A PAYMENT ADDRESS IS NOT AN IDENTIFIER, and this is the check that keeps
   * the two apart. cleanWorker strips '@' -- it has to, because a worker id
   * goes into a queue and onto a screen -- which would turn an email into
   * nonsense and leave the owner guessing where the at sign went.
   */
  const handles = ['dave@example.com', '@dave-smith', 'Dave.Smith@gmail.com'];
  check('a payout handle survives exactly as typed',
    handles.every((h) => cleanPayoutHandle(h) === h),
    handles.map((h) => `${h} -> ${cleanPayoutHandle(h)}`).join(' | '));
  check('where the worker-id cleaner would have mangled it',
    cleanWorker('dave@example.com') === 'daveexample.com',
    'which is why these are two functions and not one');
  check('and control characters are still taken out',
    cleanPayoutHandle('dave\u0000@ex\u001fample.com') === 'dave@example.com',
    'the one thing that could break a log line or a screen');
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

  /*
   * THE FLOOR IS SKIPPED FOR A TRUSTED WORKER, AND ONLY THE FLOOR.
   *
   * It catches a stranger waving an untouched outline through; the person it
   * would otherwise inconvenience is a fast worker on a small garden, which by
   * this point is exactly who this is. The unchanged-outline question still
   * applies to everybody -- it costs one press, it is occasionally right, and
   * the map is flagged for review either way.
   */
  check('a trusted worker is not held to the ninety-second floor',
    submissionVerdict({ claimedAt: claimed(40), now: NOW, edited: true, trusted: true }).ok,
    'a small garden traced quickly by somebody known is not the pattern being caught');
  const trustedBlank = submissionVerdict({
    claimedAt: claimed(40), now: NOW, edited: false, trusted: true,
  });
  check('but is still asked about an outline they did not touch',
    !trustedBlank.ok && trustedBlank.unchanged,
    'one press, occasionally right, and flagged either way');
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

  /*
   * AND A LINK TEMPLATE THAT WAS NEVER FILLED IN.
   *
   * Every platform hands out one link and substitutes the worker's id into it,
   * each spelling the placeholder differently. Paste it into the wrong field
   * and the placeholder itself reaches every worker -- and it does NOT look
   * like a failure, because cleanWorker strips the punctuation and leaves a
   * perfectly plausible id behind. Then every worker in the batch IS that one
   * person: they share the single claim, the daily cap and the gates, so the
   * second worker is told somebody else's lawn is open, the batch stops after
   * forty between all of them, and one careless person ends the work for
   * everybody. Each of those reads as the task being broken.
   */
  const templates = [
    '${workerId}',                 // MTurk
    '{{%PROLIFIC_PID%}}',          // Prolific
    '%%participant_id%%',
    '[worker_id]',
    '{{participantId}}',
    'workerId',                    // the wrapper copied off by hand
    'PROLIFIC_PID',
  ];
  check('an unfilled link template is spotted, however it is spelled',
    templates.every(looksUnsubstituted),
    templates.filter((t) => !looksUnsubstituted(t)).join(', ') || 'all of them');

  check('and cleaning one would have left a plausible id behind',
    cleanWorker('{{%PROLIFIC_PID%}}') === 'PROLIFIC_PID',
    'which is exactly why this is checked on the raw value, before cleaning');

  /*
   * AND A REAL ID IS NOT MISTAKEN FOR ONE, which is the half that costs money
   * if it is wrong: refusing a genuine worker is work they cannot submit.
   */
  const real = ['A2X9QJ3KLM0ZZ1', '5f8a2c1e9b3d4a6f7c0e1234', 'w-7781', 'nilesjac3.helper'];
  check('while a real worker id is left alone',
    real.every((r) => !looksUnsubstituted(r)),
    real.filter(looksUnsubstituted).join(', ') || 'none refused');

  check('and an absent id is a different fault, not this one',
    !looksUnsubstituted('') && !looksUnsubstituted(null),
    'a missing id and a link nobody filled in need different things said');
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
