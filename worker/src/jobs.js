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
 * SIXTY, LOWERED FROM NINETY BECAUSE IT FIRED ON A REAL MAP. The owner traced
 * an easy lawn on the first live run and was refused. That is the exact
 * failure this number is supposed to avoid: it exists to catch somebody
 * clicking submit on an untouched outline, not to punish somebody quick on a
 * small garden -- and a floor that rejects good work is worse than no floor,
 * because the person it rejects has already done the work.
 *
 * Still well under the real task rather than near it. A floor set near the
 * average would reject half of everything by construction.
 */
export const MIN_SECONDS = 60;

/** How many a worker may hold at once. One, so nothing can be stockpiled. */
export const MAX_HELD = 1;

/** How many a worker may submit in a day, once they are through both gates. */
export const DAILY_CAP = 40;

/**
 * THE GATES, and why there are two of them.
 *
 * A worker does five maps, then waits while they are looked at. Pass, and they
 * do ten more, then wait again. Pass again and the ordinary daily cap is all
 * that is left.
 *
 * This replaced an audition, and then replaced a one-map version of itself.
 * The one-map version let somebody through on one good map out of five, which
 * is the wrong way round: the addresses are already vetted and the owner
 * intends to tidy every map anyway, so a REFUSAL here means the map was truly
 * bad rather than imperfect. Four out of five bad is not somebody having an
 * off day.
 *
 * Two gates rather than one because the first is cheap and the second is
 * informative: five maps is enough to spot somebody who cannot do this at all,
 * and fifteen is enough to tell a careful worker from a lucky one -- while
 * costing at most ten more maps to find out.
 */
export const GATES = [5, 15];

/**
 * The share that must pass at each gate.
 *
 * Four out of five, which is the same number at both gates and is deliberately
 * forgiving. A map only fails if it is genuinely bad; a hard lawn somebody made
 * a reasonable attempt at is EXCUSED, which counts as a pass here even though
 * the map itself is not kept. See reviewOutcome.
 */
export const PASS_RATE = 0.8;

/**
 * What a review can conclude, and what each means for the worker.
 *
 *   kept     the map goes into the corpus. Counts for them.
 *   excused  the map is not kept, but the lawn was hard and the attempt was
 *            reasonable. STILL COUNTS FOR THEM -- this is the whole reason the
 *            button exists. Without it a run of awkward lawns would end a good
 *            worker's run, and the queue hands lawns out in order, so who gets
 *            the awkward ones is pure luck.
 *   refused  genuinely bad. The only thing that counts against them.
 *
 * All three are paid. Payment is the platform's business and is not decided
 * here; this decides only whether somebody gets more work.
 */
export const REVIEW_OUTCOMES = ['kept', 'excused', 'refused'];

/*
 * WHICH STATES BELONG TO WHICH QUESTION.
 *
 * lawn_jobs.state carries the whole life of a lawn, and two different pages
 * report a tally of it: screening decides which addresses are worth paying to
 * have traced, grading decides whether the map that came back is any good.
 *
 * Both were counting EVERY state, so each showed the other's work. The
 * grading page read "104 approved · 171 rejected" -- which are screening
 * decisions about addresses, not verdicts on anybody's map -- next to the two
 * maps actually kept. A page that answers "how is the grading going" must not
 * put a number in front of somebody that is about something else entirely.
 *
 * `claimed` is in neither on purpose: a lawn out with a worker is not a
 * decision anybody has made, and "So far:" is a list of decisions.
 */
export const SCREEN_STATES = ['candidate', 'approved', 'rejected'];
export const GRADE_STATES = ['submitted', ...REVIEW_OUTCOMES];
export const countsAsPass = (outcome) => outcome === 'kept' || outcome === 'excused';

/** How long a claim survives without a submission. */
export const CLAIM_EXPIRY = HOUR;

/**
 * THE FOUR WAYS SOMEBODY ARRIVES HERE, and what each of them is owed.
 *
 *   crowd      A paid stranger from a platform. Everything in this file was
 *              written for them: they are unknown, numerous, and being paid by
 *              the piece, so they get the gates, the cap, the floor and a
 *              completion code to paste back as proof of work.
 *
 *   hired      Somebody engaged directly and paid by the hour. There is no
 *              platform, so a completion code is a puzzle rather than a
 *              receipt -- nowhere to paste it and nothing that reads it. They
 *              get a running count instead, which is the thing that actually
 *              answers "how am I doing".
 *
 *   volunteer  Somebody who followed a public link to help for nothing. No
 *              code, no gates, no floor. Probation on a person doing you a
 *              favour is an insult, and a timer on unpaid work is worse: the
 *              only thing it can achieve is turning a good deed into a
 *              refusal.
 *
 *   paid       The same public link, with 75c an APPROVED map attached. The
 *              rules are the volunteer's rules exactly, and that is the point:
 *              nothing was promised in advance, so an unapproved map costs
 *              nobody anything and there is no committed money for a gate to
 *              protect. What it adds is a sign-in, because money needs a
 *              stable identity, somewhere to send it that can be corrected,
 *              and a verified address to fall back on when a payment bounces.
 *
 * The daily cap stays on the last two, and it is the only thing that does --
 * not against anybody, but because a link posted in public is the one place a
 * single bad actor could flood the queue.
 */
export const ROUTES = ['crowd', 'hired', 'volunteer', 'paid'];

/**
 * THE TWO ROUTES THAT CAME IN THROUGH A PUBLIC LINK, and what they have in
 * common that matters more than what separates them.
 *
 * Nobody was promised anything up front on either. A volunteer is doing a
 * favour; somebody on the paid link is owed 75c for each map that is APPROVED
 * and nothing at all for one that is not. That is the opposite of a crowd
 * platform, where accepting the task is the promise and refusing to pay
 * afterwards is the thing that gets a requester written about.
 *
 * So neither gets the gates, and neither gets the time floor. The gates exist
 * to decide whether to keep spending money on a stranger, and there is no
 * committed money here to protect: an unapproved map costs nothing. The daily
 * cap stays on both, and it is the only thing that does -- not against anybody,
 * but because a link posted in public is the one place a single bad actor
 * could empty the queue into the review pile in an afternoon.
 */
export const isOpenLink = (route) => route === 'volunteer' || route === 'paid';
export const cleanRoute = (raw) => (ROUTES.includes(String(raw || '')) ? String(raw) : 'crowd');

/** Does this route paste a code into something? Only a platform does. */
export const needsCode = (route) => cleanRoute(route) === 'crowd';

/**
 * What an approved map is worth, and the smallest payment worth sending.
 *
 * Only APPROVED maps earn. An excused one -- "not good enough, but a hard
 * lawn" -- counts as a pass at a gate and is explicitly not an approval, so it
 * pays nothing. That has to be said on screen before anybody starts rather
 * than discovered afterwards.
 */
export const PAID_RATE_CENTS = 75;
export const MIN_PAYOUT_CENTS = 500;

/** Where money can be sent. */
export const PAYOUT_KINDS = ['venmo', 'paypal'];

/**
 * What can have happened to a request for money.
 *
 *   requested  they pressed the button. Subtracts from the balance at once, so
 *              the same money cannot be asked for twice.
 *   paid       the owner sent it and said so.
 *   returned   the owner could not send it. Stops subtracting, so the balance
 *              comes back and they can fix their details and ask again.
 */
export const PAYOUT_STATES = ['requested', 'paid', 'returned'];
/** The two that still lay claim to money. `returned` releases it. */
export const PAYOUT_SETTLES = ['requested', 'paid'];

/**
 * What somebody is owed right now.
 *
 * ONE FUNCTION BECAUSE THERE ARE TWO SCREENS. The worker sees this on their
 * own page and the owner sees it on theirs, and a version of this arithmetic
 * written twice is a version that eventually disagrees -- at which point one
 * of them is telling somebody they are owed money they are not, or the
 * reverse. Neither is a bug anyone wants to find out about from a stranger.
 *
 * DERIVED, NEVER STORED. A balance column would be a second copy of a number
 * the maps already imply, and it would drift the first time a review changed
 * or a request was created twice.
 */
export const owedCents = ({ approved = 0, settledCents = 0 }) =>
  Math.max(0, approved * PAID_RATE_CENTS - settledCents);

/**
 * A payment address, kept as typed.
 *
 * DELIBERATELY NOT cleanWorker, and the difference is the whole point of this
 * function existing. cleanWorker strips everything that is not a letter, a
 * digit or ._:- because a worker id goes into a queue and onto a screen --
 * which turns dave@example.com into daveexample.com and leaves the owner
 * guessing where the at sign went.
 *
 * A payment address is not an identifier. It has to survive verbatim or it is
 * useless, so this trims, bounds the length, and removes only control
 * characters -- the things that could break a log line or a screen, and
 * nothing a real Venmo handle or PayPal email contains.
 */
export const cleanPayoutHandle = (raw) => String(raw || '')
  .trim()
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .slice(0, 120);

/**
 * What the LINK is allowed to say about where somebody came from.
 *
 * A link is forgeable, and two of the three routes lift real protections -- so
 * a paid stranger who added `&via=volunteer` would walk through the gates that
 * exist to stop exactly that. The stored row is what actually decides.
 *
 * The one thing a link may do on its own is claim to be a VOLUNTEER, and that
 * is safe because it buys nothing worth forging: a volunteer is not paid, so
 * the gates they skip were only ever protecting money that is not there. What
 * a forger would gain is the right to work for free.
 */
export const routeFromLink = (raw) => {
  const asked = String(raw || '');
  /*
   * Both public routes may be asserted by a link, and neither buys anything
   * worth forging. Volunteer gains the right to work for nothing. Paid gains
   * nothing either: it lifts no rule the volunteer route does not already
   * lift, it requires a signed-in account the server reads from the session
   * rather than from the URL, and it promises money only for maps the owner
   * approves by hand afterwards.
   *
   * `hired` and `crowd` are still refused here, because those two are decided
   * by a row the owner wrote and one of them skips the completion code.
   */
  return asked === 'volunteer' || asked === 'paid' ? asked : null;
};

/**
 * How many AI passes one LAWN gets for free, across every claim it ever has.
 *
 * A worker arrives signed out, from a crowd platform, where the public
 * allowance is five passes a day for a whole browser -- and the automatic
 * outline is the thing they are paid to CORRECT, so they have to be able to
 * get one. Somebody doing fifteen maps would run out on the sixth and the task
 * would simply look broken. Raising the public allowance instead would hand
 * the same number to every visitor on the internet, which is real money.
 *
 * PER LAWN RATHER THAN PER CLAIM, and that is the part worth being careful
 * about. A skip puts the lawn back in the queue, so a count that reset with
 * each claim would make "claim, detect, skip, repeat" an unbounded way to
 * spend somebody else's Replicate bill -- skips are deliberately free, because
 * a worker blocked by a lawn they cannot trace is a worker who leaves. Kept on
 * the row, the whole batch can cost at most this many passes per lawn however
 * many times it goes round.
 *
 * Six because the ordinary course is one -- run once on arrival -- and the
 * rest is slack for the things that legitimately need another: reloading a
 * closed tab, and extending the property line out to the kerb, which the road
 * prompt asks for. It degrades rather than blocking: a lawn that has used its
 * six falls back to the browser's own signed-out allowance, so the worst case
 * for the second worker on a much-skipped lawn is the app behaving normally.
 */
export const FREE_DETECTS_PER_JOB = 6;

/**
 * And how many on a lawn from one of the two PUBLIC links, where the answer is
 * "as many as anybody sensibly needs, and nothing comes out of their own".
 *
 * WHY IT IS NOT SIX. Six was sized for a screen where the outline was run once,
 * automatically, on arrival -- one pass in the ordinary course and five of
 * slack. On the volunteer and paid routes nothing is traced until somebody asks
 * for it, so asking is now the whole interaction with the AI, and the useful
 * things to do with it are all repeats: try the free land cover method, try
 * SAM, drag the property line out to the kerb and run it again, switch to a
 * different year's photograph because this one is in shadow. Exclude mode
 * counts one pass PER TICKED BOX, so a single press there can spend three.
 * Six is a wall somebody meets while doing the work properly, and meeting it
 * would mean a refusal on a screen where the work is a favour.
 *
 * WHY THERE IS A CEILING AT ALL. Every pass is a Replicate prediction and
 * these two links are posted in public. Skips are free by design and the count
 * lives on the LAWN rather than on the claim (see FREE_DETECTS_PER_JOB), so
 * without a ceiling "claim, detect, detect, detect" is an unbounded way to
 * spend the owner's money, from a link anybody can open. Twenty is chosen to
 * sit well past deliberate use and well short of a bill worth noticing.
 *
 * NOTHING SPILLS ONTO THE PERSON. When this is spent the detection is refused
 * outright, with a sentence saying so -- it does not fall through to their own
 * daily allowance, which is what "free in these workflows" has to mean if it
 * is to mean anything. See /api/segment.
 */
export const FREE_DETECTS_PER_OPEN_JOB = 20;

/**
 * "That is the day's limit" -- written once, because it is reached from two
 * different places and must not read like the gates from either.
 *
 * The cap and the gates are different in kind and a worker cannot tell them
 * apart from the wording alone: one lifts at midnight whatever anybody does,
 * the other lifts when a person has looked at their maps. So this says the
 * number, says when it lifts, and says nothing at all about review -- which is
 * the part that was wrong when an open-link worker at the cap was handed the
 * probation sentence instead of this one.
 *
 * `capped` is carried so a page can title it "that is the day's lot" rather
 * than "no lawn just now", and it is deliberately not the same flag as
 * `waiting`: that one offers a Check again button, and checking again before
 * tomorrow cannot help here.
 */
const capRefusal = (route) => ({
  ok: false,
  capped: true,
  reason: `That is ${DAILY_CAP} today, which is the daily limit. `
    + (isOpenLink(route)
      ? 'It is a ceiling on the link rather than anything about your maps — '
        + 'come back tomorrow and there will be more of the batch.'
      : 'Come back tomorrow — the rest of the batch will still be here.'),
});

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
  submittedEver = 0, passed = 0, refused = 0, trusted = false, route = 'crowd',
}) {
  if (held >= MAX_HELD) {
    return {
      ok: false,
      reason: 'You already have a lawn open. Finish or skip that one first.',
    };
  }

  /*
   * SOMEBODY THE OWNER HAS ALREADY DECIDED ABOUT.
   *
   * The queue is fed from two directions now: a crowd platform, where workers
   * are anonymous and unknown, and one or two people hired directly and paid
   * by the hour. Everything below this line exists to find out whether a
   * stranger can do this -- and for the second group that question has already
   * been answered, expensively, by a person looking at their maps.
   *
   * Applied AFTER the one-at-a-time rule and BEFORE the gates and the cap,
   * which is the whole of what trust means here. Holding two lawns is how one
   * lawn gets paid for twice, and that is not a question about character. The
   * ninety-second floor below is skipped too, for the same reason it exists:
   * it catches somebody clicking submit on an untouched outline, and the
   * person it would actually inconvenience is a fast worker on a small garden
   * -- which, by this point, is who this is.
   */
  if (trusted) return { ok: true, trusted: true };

  /*
   * AND SOMEBODY WHO CAME IN THROUGH A PUBLIC LINK.
   *
   * The gates exist to decide whether to keep spending money on a stranger.
   * There is no committed money on either open route: a volunteer followed a
   * public link to do the owner a favour, and somebody on the paid link is
   * owed 75c for each map the owner APPROVES and nothing at all for one they
   * do not. Holding either at a five-map wall to wait for a review is a way of
   * turning a good deed into a chore. The same goes for the time floor, which
   * at worst refuses donated work outright.
   *
   * THE DAILY CAP IS THE ONLY THING THAT STILL APPLIES, and it returns from
   * here rather than falling through -- which is the bug this shape fixes.
   *
   * It used to read `isOpenLink(route) && submittedToday < DAILY_CAP`, so an
   * open-link worker who reached the cap fell past this line and into the
   * gates, and was handed the probation wording: "that is 40 maps, and they
   * are with the reviewer now... new workers do a few at a time". Every clause
   * of that is wrong for them. They are not on probation, nothing is being
   * decided about them, and waiting for a review would not help -- what they
   * have hit is a ceiling that lifts at midnight. It was reported by a paid
   * tracer whose maps had all been approved, which is exactly the person the
   * gates are not for.
   *
   * The cap itself stays, and not as a judgement on anybody: a link posted in
   * public is the one place a single bad actor could empty the queue into the
   * review pile in an afternoon. Everything they send is looked at by a person
   * anyway.
   */
  if (isOpenLink(route)) {
    if (submittedToday >= DAILY_CAP) return capRefusal(route);
    return { ok: true, openLink: true };
  }

  /*
   * THE GATES. Written as a loop over GATES rather than as two branches, so
   * adding a third stage is a number rather than a new code path -- and so the
   * two existing stages cannot drift apart in their wording or their arithmetic.
   */
  const reviewed = passed + refused;
  for (const gate of GATES) {
    if (submittedEver < gate) break;          // still working within this stage

    if (reviewed < gate) {
      /*
       * AT THE GATE, WAITING. Somebody here has done the work, been paid for
       * the work, and done nothing wrong -- and the workers who read carefully
       * enough to be worth keeping are exactly the ones who read this. It says
       * what is happening, that it is not a mark against them, that they are
       * paid either way, roughly how long, and that more follows.
       *
       * It promises nothing about the OUTCOME. Telling somebody their maps
       * will be kept before anybody has looked is a promise this cannot keep,
       * and a broken one costs more than the wait it was meant to soften.
       */
      return {
        ok: false,
        waiting: true,
        reason: `That is ${submittedEver} maps, and they are with the reviewer `
          + 'now. New workers do a few at a time while the work is checked — it '
          + 'is how quality is kept up here, not a mark against you, and you are '
          + 'paid for these either way. Review is usually done inside a day. '
          + 'Open this link again then and there will be more.',
      };
    }

    if (reviewed > 0 && passed / reviewed < PASS_RATE) {
      /*
       * STOPPED, and the wording matters more here than anywhere else. This is
       * the one refusal a worker cannot fix by waiting, and it is going to be
       * read by somebody who has just been told there is no more work. It
       * confirms they were paid, thanks them, and does not lecture -- a person
       * who feels insulted writes about it, and the next batch is harder to
       * fill.
       */
      return {
        ok: false,
        stopped: true,
        reason: 'Thank you for the maps you sent — they have all been paid for. '
          + 'This batch needs outlines closer to what it is asking for than we '
          + 'managed between us, so there is no more of this work for you today.',
      };
    }
  }

  if (submittedToday >= DAILY_CAP) return capRefusal(route);
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
  trusted = false, route = 'crowd',
}) {
  const seconds = claimedAt ? (now - new Date(claimedAt).getTime()) / 1000 : 0;
  /*
   * The floor is skipped for somebody the owner has decided about, and for
   * anybody who is not being paid -- and only the floor.
   *
   * It exists to catch a paid stranger waving an untouched outline through.
   * The person it actually inconveniences is somebody quick on a small garden,
   * which is who both of these are. On a volunteer it is worse than useless:
   * it refuses donated work, which is the one thing that could not possibly be
   * worth doing.
   *
   * The unchanged-outline question below still applies to everybody. It costs
   * one press, it is occasionally right, and the map is flagged either way.
   */
  const floorApplies = !trusted && !isOpenLink(route);
  if (floorApplies && seconds < MIN_SECONDS) {
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

/**
 * Is this a link template that was never filled in?
 *
 * EVERY CROWD PLATFORM HANDS OUT ONE LINK AND SUBSTITUTES THE WORKER'S ID INTO
 * IT, and each spells the placeholder differently -- `${workerId}`,
 * `{{%PROLIFIC_PID%}}`, `%%pid%%`. Pasting the link into the wrong field, or
 * into a platform that does not do substitution, sends the placeholder itself
 * to every worker.
 *
 * WHICH WOULD NOT LOOK LIKE A FAILURE. cleanWorker strips punctuation, so
 * `{{%PROLIFIC_PID%}}` arrives here as the perfectly plausible id
 * `PROLIFIC_PID` -- and then every worker in the batch IS that one person.
 * They share a claim, so a second worker is told somebody else's lawn is
 * already open; they share the daily cap, so the batch stops after forty
 * between all of them; and they share the gates, so one careless person ends
 * the work for everybody. Every one of those reads as the task being broken,
 * and none of them says why.
 *
 * Tested on the RAW value, before cleaning, because the punctuation is the
 * evidence. A real id from any of these platforms is letters and digits: no
 * brace, dollar, percent or bracket appears in one. The bare names are here
 * for the person who copies the template without its wrapper, which is the
 * same mistake with the evidence already rubbed off.
 */
const PLACEHOLDER_NAMES = /^(worker_?id|participant_?id|prolific_?pid|assignment_?id|pid|rid|id)$/i;

/**
 * Is this a ROUTE NAME that has been typed into the worker-id slot?
 *
 * `?via=volunteer` says which route; `?w=jane` says who. They are one letter
 * apart in a URL and a mile apart in meaning, and getting them the wrong way
 * round is the easiest mistake available here -- it was very nearly made
 * before the first Reddit post went up.
 *
 * AND IT WOULD NOT HAVE LOOKED LIKE A MISTAKE. `?w=volunteer` is a perfectly
 * well-formed request: it hands out lawns, to a worker whose id is the word
 * "volunteer". Everyone who clicked the link would be that one person -- one
 * claim between the whole thread, so the second reader is told a lawn is
 * already open that they cannot see; one daily cap of forty between everybody;
 * and the gates apply, because with no `via` the route falls back to crowd, so
 * the link stops for all of them after five maps in total.
 *
 * A separate check from looksUnsubstituted because it deserves a separate
 * sentence: that one is aimed at a platform template nobody filled in, and the
 * only useful thing to say is "ask the requester". This one has an exact fix,
 * and the message gives it.
 */
export const routeInWrongParam = (raw) => ROUTES.includes(String(raw || '').trim().toLowerCase());

export const looksUnsubstituted = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return false;                     // absent is a different fault
  if (/[{}$%[\]<>()]/.test(value)) return true;
  return PLACEHOLDER_NAMES.test(value);
};
