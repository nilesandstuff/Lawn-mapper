/**
 * Handing lawns to people who are being paid to trace them.
 *
 * ONE LINK FOR THE WHOLE BATCH, not one per lawn. A crowd platform takes a
 * single URL in the task description and appends the worker's own id to it, so
 * the link is the same for everybody and the SERVER decides which lawn each
 * person gets. Four hundred links pasted into four hundred tasks is not a
 * workflow, it is an afternoon.
 *
 * NO ACCOUNTS. These people never sign in. They arrive with a worker id from
 * the platform and that is the whole of their identity here -- which is right:
 * an account would be a password to forget, an email to store and a sign-up
 * step between somebody and a fifty-cent task.
 *
 * WHAT STOPS SOMEBODY FARMING IT. Nothing here can tell a careless worker from
 * a careful one -- that is the owner's eye, afterwards. What it CAN do is make
 * volume impossible to fake:
 *
 *   one lawn at a time, so nobody can hold twenty and submit rubbish for all;
 *   a floor on how fast a map can arrive, because a lawn traced in forty
 *     seconds was not traced;
 *   a ceiling per worker per day, so one person cannot take the whole batch
 *     before anybody has looked at their first map.
 *
 * A claim that is never submitted goes back in the queue after an hour. People
 * close tabs, and a lawn nobody can reach is a lawn nobody gets paid for.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * The floor on a map, in seconds.
 *
 * Ninety seconds against a five-minute task. Deliberately well under the real
 * time rather than near it: this is here to catch somebody clicking submit on
 * an untouched SAM outline, not to punish somebody fast on an easy lawn. A
 * floor set near the average would reject good work on small gardens, and the
 * whole point of paying people is that the owner's eye is the expensive part.
 */
export const MIN_SECONDS = 90;

/** How many a worker may hold at once. One, so nothing can be stockpiled. */
export const MAX_HELD = 1;

/** How many a worker may submit in a day, once they have proved themselves. */
export const DAILY_CAP = 40;

/**
 * How many a NEW worker may submit before one of their maps has been kept.
 *
 * THIS IS THE WHOLE QUALITY CONTROL, and it replaced an audition. An audition
 * pays somebody to trace a lawn that is already traced, which buys a signal
 * and no map. Probation buys the same signal out of real work: the first few
 * maps are ordinary lawns that count, and if they turn out to be bad the whole
 * cost of finding out is five maps rather than forty.
 *
 * Five rather than one, because one map says almost nothing -- an awkward lot
 * or a bad afternoon looks identical to somebody who cannot do this. Five is
 * enough to see a pattern and cheap enough to be wrong about.
 */
export const PROBATION_CAP = 5;

/** How long a claim survives without a submission. */
export const CLAIM_EXPIRY = HOUR;

/**
 * Is this worker allowed another lawn right now, and if not, why not?
 *
 * Pure, and separated from the database on purpose: these rules are the whole
 * defence against one person taking the batch, and they are worth testing
 * without a Worker runtime around them.
 *
 * `now` is passed in for the same reason.
 */
export function claimVerdict({
  held = 0, submittedToday = 0, lastSubmitAt = null, now = Date.now(),
  submittedEver = 0, accepted = 0,
}) {
  if (held >= MAX_HELD) {
    return {
      ok: false,
      reason: 'You already have a lawn open. Finish or skip that one first.',
    };
  }

  /*
   * PROBATION, and the wording is as much of the feature as the number.
   *
   * Somebody who hits this has done five maps, been paid for five maps, and
   * done nothing wrong. If the message reads like a punishment they will not
   * come back -- and the workers who read carefully enough to be worth keeping
   * are exactly the ones who read this. So it says what is happening, how long
   * it takes, and that more work follows.
   *
   * No promise is made about the OUTCOME, only about the wait. Telling
   * somebody their maps will be accepted before anybody has looked is a
   * promise this cannot keep.
   */
  if (accepted === 0 && submittedEver >= PROBATION_CAP) {
    return {
      ok: false,
      probation: true,
      reason: `That is your first ${PROBATION_CAP}, and they are with the `
        + 'reviewer now. New workers do a few maps before the rest of the batch '
        + 'opens up — it is how quality is checked here, not a mark against '
        + 'you, and you are paid for these either way. Review is usually done '
        + 'inside a day. Open this link again then and there will be more.',
    };
  }

  if (submittedToday >= DAILY_CAP) {
    return {
      ok: false,
      reason: `That is ${DAILY_CAP} today, which is the daily limit. `
        + 'Come back tomorrow — the rest of the batch will still be here.',
    };
  }
  /*
   * The floor is checked on the CLAIM as well as the submission, because a
   * worker who submits instantly and immediately takes another is the pattern
   * this is looking for, and catching it here costs them a wait rather than a
   * rejected map.
   */
  if (lastSubmitAt) {
    const since = (now - new Date(lastSubmitAt).getTime()) / 1000;
    if (since >= 0 && since < MIN_SECONDS) {
      return {
        ok: false,
        wait: Math.ceil(MIN_SECONDS - since),
        reason: `Take a moment — the last one was ${Math.round(since)} seconds ago.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Was this map plausibly traced, or was it waved through?
 *
 * Time is the only signal available at submission, and it is a weak one: it
 * catches a worker who submitted SAM's outline untouched and nothing else. A
 * careless map traced slowly still passes here, which is correct -- that
 * judgement is the owner's, and pretending a number can make it would put bad
 * maps into the corpus with a tick beside them.
 */
export function submissionVerdict({
  claimedAt, now = Date.now(), edited = false, confirmedUnchanged = false,
}) {
  const seconds = claimedAt ? (now - new Date(claimedAt).getTime()) / 1000 : 0;
  if (seconds < MIN_SECONDS) {
    return {
      ok: false,
      reason: `That took ${Math.round(seconds)} seconds. Have another look — `
        + 'the outline almost always needs correcting along the drive and the '
        + 'edges, and a map that has not been corrected is not worth paying for.',
    };
  }
  /*
   * AN UNCHANGED OUTLINE ASKS A QUESTION RATHER THAN SLAMMING THE DOOR, and
   * the difference is the whole reputation of the task.
   *
   * This started as a hard refusal. That is a trap: now and then the automatic
   * outline really is right, and an honest worker who checked it carefully
   * would have done four minutes of real work and be unable to submit it. Work
   * done that cannot be paid for is the single fastest way for a requester to
   * be written up on a worker forum -- and it would be OUR bug producing it,
   * not their behaviour.
   *
   * So: the first attempt is refused with an explanation, and if they come
   * back saying they looked and it was already correct, that goes through and
   * is flagged for the owner instead. Somebody waving work through still has
   * to do it twice and still ends up in a review queue; somebody honest gets
   * paid.
   */
  if (!edited && !confirmedUnchanged) {
    return {
      ok: false,
      unchanged: true,
      reason: 'Nothing was changed from the automatic outline. That outline is '
        + 'the starting point, not the answer — it is what you are being paid '
        + 'to correct. If you have checked it and it really is already right, '
        + 'send it again and it will go through.',
    };
  }

  return {
    ok: true,
    seconds: Math.round(seconds),
    /* Carried so the owner's review queue can show these first. */
    flag: !edited ? 'unchanged' : null,
  };
}

/** Claims older than the expiry, so they can go back in the queue. */
export const staleBefore = (now = Date.now()) => new Date(now - CLAIM_EXPIRY).toISOString();

/** The start of the worker's day, in UTC, for the daily cap. */
export const dayStart = (now = Date.now()) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};

/**
 * A worker id, cleaned up.
 *
 * It arrives in a URL from a crowd platform and goes into a database and onto
 * an owner's screen, so it is bounded and stripped to the characters those
 * platforms actually use. An empty result means "no id", which the caller
 * refuses rather than treating as anonymous -- an unnamed worker cannot be
 * rate limited, and cannot be paid either.
 */
export const cleanWorker = (raw) => String(raw || '')
  .trim()
  .replace(/[^A-Za-z0-9._:-]/g, '')
  .slice(0, 64);
