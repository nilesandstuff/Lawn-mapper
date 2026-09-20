# Paying people to trace lawns

The corpus is the constraint on everything (S3 in DETECTOR-FINDINGS.md), and
the detector cannot help build it until it beats SAM, which it does not (H11).
So the corpus grows by paying people.

**Mechanical Turk is gone.** Amazon closed it to new requester accounts on
30 July 2026 and the service shuts down on 30 September. This file is written
for what replaced it.

## The shape of it

1. **Sample.** Workflow `15. Sample lawns` throws darts at county parcel
   services and keeps the ones that look like house plots. Rows land as
   `candidate`.
2. **Screen.** `/screen.html` on your phone. One property line on one
   photograph, Yes or No. A lawn rejected here costs a glance; the same lawn
   rejected after somebody has traced it costs fifty cents and a review.
3. **Trace.** A worker opens their link, is handed one `approved` lawn,
   corrects the automatic outline, and sends it. The row becomes `submitted`
   and a corpus row is written as `new` — a candidate, not training data.
4. **Grade.** `/grade.html` on your phone. Keep it, excuse it, or refuse it.
   Keeping approves the corpus row; the other two reject it.

A paid map never reaches a training run without step 4.

## Two kinds of worker, one queue

**A crowd platform** gives you many anonymous strangers. The gates exist for
them: five maps, then a wait; four in five must pass; then ten more and the
same bar; then a cap of forty a day.

**Somebody hired directly** is one known person, usually paid by the hour. For
them the gates are a bill — a worker sitting at a five-map wall is being paid
to wait for a review. So the grading card has a **Trust this worker** switch
that lifts the gates and the daily cap.

Trust lifts those two things and nothing else. One lawn at a time still holds,
because that is what stops a lawn being paid for twice, and no judgement about
a person changes that arithmetic.

It does not care where somebody came from. A crowd worker who turns out to be
excellent is exactly who should be let off the leash.

## What it costs

Both surviving platforms take a cut **on top of** what you pay, and both judge
whether a task underpays by dividing the reward by the **median time workers
actually take** — not by the estimate you type into the listing. `/grade.html`
reports that median once maps start coming back. Set the reward from it.

| Route | Floor | Cut | Per map | $200 buys |
| ----- | ----- | --- | ------- | --------- |
| CloudResearch Connect | $6/hr | 40%, **0% for the first ~10 days** | $0.50 | ~285, or ~400 inside the free window |
| Hired directly | your call | none | ~$0.67 at $8/hr | ~250–300 |
| Prolific (for reference) | $8/hr | 42.8% | $0.95 | ~210 |

Check the current numbers before committing — these move.

**The app has no idea what anything costs** and will hand out every approved
lawn in the queue until it runs out. The batch size on the platform, or the
hours you agree with a freelancer, is the only thing that stops it.

## The link

```
https://lawnmap.nilesandstuff.com/?w=<the worker's id>
```

Every platform substitutes its own placeholder into one link, and each spells
it differently — `${workerId}`, `{{%PROLIFIC_PID%}}`, `%%participant_id%%`.
Whatever the platform calls it goes in place of `<the worker's id>`.

**If the substitution does not happen, the app now refuses and says so.** That
used to be the worst failure available here: the placeholder reaches every
worker, the punctuation gets stripped, and the whole batch becomes one person
sharing one claim, one daily cap and one set of gates. Nothing about it looked
like a fault.

For somebody hired directly there is no platform and no substitution — give
them a link with their name in it:

```
https://lawnmap.nilesandstuff.com/?w=jane
```

**The completion code** is the job's own short id. It is not a secret and does
not need to be: you do not have to trust it, you look it up. Was that lawn
actually submitted, by that worker, with a map attached — the database already
knows.

## Setting up a crowd batch

Post it as a study or task with an external link. Fill in:

**Title** — Trace the lawn on one satellite photo (about 5 minutes)

**Description** — You are shown one house from above with a rough outline of
its lawn already drawn. Fix the outline — mostly along the driveway and the
hard edges — and send it back for a code. No sign-up, no software.

**Reward** — from the median in `/grade.html`, against the platform's floor.
For the first batch, before there is a median, five minutes is the estimate
this was designed around.

**Time allowed** — 30 minutes. Generous on purpose: the app releases an
abandoned claim after an hour anyway, and a tight timer makes people rush the
edges, which is the one thing being paid for.

**Approval window** — as long as the platform allows, so you have time to grade
before it auto-approves. Approve by hand where you can.

**Requirements** — approval rate ≥ 95%, at least 100 previous tasks. Nothing
stricter: the gates do the rest, and a narrow qualification on a small batch
means nobody takes it.

## Hiring somebody directly

Post for an image-annotation job, hourly. Ask for a short trial — five maps
through the ordinary gates tells you as much as an interview would, and they
are paid for it either way.

When you are happy with them, open `/grade.html`, find one of their cards and
press **Trust this worker**. Write who they are in the note while you are there
— a worker id says nothing on a small screen three weeks later.

The rest is the same page you were already using.

## Paying, and not getting a reputation

Approve almost everything. The addresses are screened before anybody sees them
and you intend to tidy every map anyway, so a map that is merely imperfect is a
map you keep. Reject only for something that is not an attempt at the lawn.

Control quality by **assignment**, not by rejection: somebody who cannot do this
stops getting work at a gate, having been paid for everything they sent. That
is the whole reason the gates exist.

Work that was done and cannot be paid for is the fastest way for a requester to
be written up on a worker forum — and in this app it would usually be our bug
producing it, not their behaviour. That is why an untouched outline asks a
question instead of slamming the door, and why a browser that cannot reach
Mapbox is told so before a lawn is claimed rather than after.

## Sources

- [Amazon is shutting down Mechanical Turk](https://www.techspot.com/news/113643-amazon-shutting-down-mechanical-turk-after-more-than.html)
- [CloudResearch Connect pricing and FAQs](https://www.cloudresearch.com/cloudresearch-connect-faqs/)
- [Prolific pricing](https://www.prolific.com/pricing)
- [How much should I pay participants? — Prolific](https://researcher-help.prolific.com/en/articles/445266-how-much-should-i-pay-participants)
