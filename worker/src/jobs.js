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

/** How many a worker may submit in a day, before anybody has reviewed them. */
export const DAILY_CAP = 40;

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
export function claimVerdict({ held = 0, submittedToday = 0, lastSubmitAt = null, now = Date.now() }) {
  if (held >= MAX_HELD) {
    return {
      ok: false,
      reason: 'You already have a lawn open. Finish or skip that one first.',
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
