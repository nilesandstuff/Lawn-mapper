# Paying strangers to trace lawns

The corpus is the constraint on everything (S3 in DETECTOR-FINDINGS.md), and
the detector cannot help build it until it beats SAM, which it does not (H11).
So the corpus grows by paying people.

This is the whole arrangement in one place: what a worker sees, what you see,
and what you have to type into Amazon Mechanical Turk to start it. Nothing here
needs a terminal.

## The shape of it

1. **Sample.** Workflow `15. Sample lawns` throws darts at county parcel
   services and keeps the ones that look like house plots. Rows land as
   `candidate`.
2. **Screen.** `/screen.html` on your phone. One property line on one
   photograph, Yes or No. A lawn rejected here costs a glance; the same lawn
   rejected after somebody has traced it costs fifty cents and a review.
   Yes makes it `approved`, which is what the queue hands out.
3. **Trace.** A worker opens the task link, is handed one `approved` lawn,
   corrects the automatic outline, and sends it. The row becomes `submitted`
   and a corpus row is written as `new` — a candidate, not training data.
4. **Grade.** `/grade.html` on your phone. Keep it, excuse it, or refuse it.
   Keeping approves the corpus row; the other two reject it.

A crowdsourced map never reaches a training run without step 4.

## What a worker gets

**One link for the whole batch.** Not one per lawn — four hundred links pasted
into four hundred tasks is not a workflow, it is an afternoon. The platform
appends the worker's own id and the SERVER decides which lawn each person gets.

They never sign in. The id in the link is the whole of their identity, which is
right for a five-minute task: an account would be a password to forget and a
sign-up step between somebody and fifty cents.

They get the ordinary map app with the address step, the AI tab, Saved and Plan
removed, and a green bar carrying the four things the job is asking for. The
starting outline is detected for them on arrival, paid for by the job rather
than by their browser's signed-out allowance.

## What stops somebody farming it

Nothing here can tell a careless worker from a careful one — that is your eye,
in step 4. What it can do is make volume impossible to fake:

- one lawn at a time, so nobody holds twenty and submits rubbish for all;
- ninety seconds minimum, because a lawn traced in forty seconds was not;
- an untouched automatic outline is refused once, with a way through for the
  honest case where it really was already right (flagged for you afterwards);
- forty a day, once somebody is through both gates;
- six AI passes per LAWN, across every claim it ever has.

## The gates

A new worker does **five** maps and then waits while they are looked at. Four
in five must pass. Then **ten more**, and the same bar again. After that, the
daily cap is all that is left.

A **pass** is *kept* or *excused*. Excused is the button that says "I would not
keep this, but the lawn was hard and I do not fault them" — the queue hands
lawns out in order, so who draws the awkward ones is pure luck, and without it
a run of bad luck would end a good worker's run.

**All three outcomes are paid.** Payment is Amazon's business, not this app's.
The gates only decide whether somebody gets more work.

**A worker at a gate is waiting on you.** They cannot see the grading queue,
cannot ask, and the message they get promises review "usually inside a day".
An empty `/grade.html` means nobody is stuck.

## Setting up the Mechanical Turk task

Create a project with the **Survey Link** template. Fill it in like this.

**Title**
> Trace the lawn on one satellite photo (about 5 minutes)

**Description**
> You are shown one house from above with a rough outline of its lawn already
> drawn. Fix the outline — mostly along the driveway and the hard edges — and
> send it back for a code. No sign-up, no software.

**Keywords** — `map, image, tracing, outline, satellite, annotation`

**Reward per assignment** — `$0.50`

**Number of assignments** — however many lawns you want traced. Each assignment
is one lawn.

**Time allotted** — `30 minutes`. Generous on purpose: the app releases an
abandoned claim after an hour anyway, and a tight timer makes people rush the
edges, which is the one thing being paid for.

**Auto-approve** — `3 days`, so you have time to grade before Amazon pays
automatically. Approve by hand where you can.

**Worker requirements** — HIT approval rate ≥ 95%, at least 100 approved HITs.
Nothing stricter: the gates in this app do the rest, and a narrow qualification
on a small batch means nobody takes it.

**The link itself**

```
https://lawnmap.nilesandstuff.com/?w=${workerId}&assignmentId=${assignmentId}
```

Both substitutions are MTurk's own. `workerId` is what the app uses to hand out
lawns and apply the limits; `assignmentId` is only read to notice the preview —
MTurk sends `ASSIGNMENT_ID_NOT_AVAILABLE` to people who are only looking, and
the app shows them what the task is without taking a lawn out of the queue.

**The completion code** is the job's own short id. It is not a secret and does
not need to be: you do not have to trust it, you look it up. Was that lawn
actually submitted, by that worker, with a map attached — the database already
knows.

## Paying, and not getting a reputation

Approve almost everything. The addresses are screened before anybody sees them
and you intend to tidy every map anyway, so a map that is merely imperfect is a
map you keep. Reject an assignment only for something that is not an attempt at
the lawn at all.

Control quality by **assignment**, not by rejection: somebody who cannot do this
stops getting work at a gate, having been paid for everything they sent. That
is the whole reason the gates exist.

Work that was done and cannot be paid for is the fastest way for a requester to
be written up on a worker forum — and in this app it would usually be our bug
producing it, not their behaviour. That is why an untouched outline asks a
question instead of slamming the door.

## The $200 ceiling

MTurk charges a commission **on top of** the reward, and the rate goes up for
batches of ten or more assignments. Check the current numbers on Amazon's
pricing page before committing — but the arithmetic is:

| commission | what $200 buys at $0.50 a map |
| ---------- | ----------------------------- |
| 20%        | about 330 maps                |
| 40%        | about 285 maps                |

Set the assignment count to match what you intend to spend. **The app has no
idea what anything costs** and will hand out every approved lawn in the queue
until it runs out; the batch size on MTurk is the only thing that stops it.
