# Working on Lawn Mapper

## The detector's memory lives in a file, not in a conversation

READ docs/DETECTOR-FINDINGS.md BEFORE configuring a training run, choosing a
backbone, or interpreting a result. WRITE TO IT after every run.

It is the record of what has actually been measured here, and it exists because
these experiments are noisy enough to be misremembered in good faith: one
rejected map moved some configurations by ten points, which is the same size as
the entire gap we are trying to close. A result recalled without its corpus is
not a result.

It separates HARD FINDINGS from SPECULATION on purpose, and that separation is
the point of the file. Do not repeat a theory from it as though it were
established, and do not quietly promote one by restating it confidently. Two
ideas have already been argued for at length and then measured as nothing.

## Deploying is yours to do

Push, then run the deploy yourself when the work is ready. Do not ask first
and do not end a message with "deploy when you want it" -- that was the old
arrangement and it is not this one.

    workflow "2. Deploy", on the working branch, input confirm: deploy

The tests run first inside that workflow, so a deploy cannot ship a red branch.
Wait for it, read the last few lines of the log, and say what they said. The end
of that log is written to be the part worth reading: the site link, whether
training images are on, and a warning if the database is not fully up to date.

ASK FIRST ONLY when the change was not discussed -- something you decided to
add, or scope you widened on your own. A fix to the thing that was asked for is
discussed by definition; so is a follow-up to a bug found while doing it.

## There is no terminal at the other end

This project is built, deployed and read FROM A PHONE. Every tool it needs is a
GitHub Actions workflow for that reason.

So a message that ends in a command to run is a message that cannot be acted
on. If something needs doing -- creating a bucket, adding a column, running a
migration -- it goes in CI where it happens by itself. That is why
tools/ci-prepare.js conjures the KV namespace, the D1 database and the R2
bucket rather than documenting how to make them.

The same applies to reading. A deploy log is about 1800 lines and nobody is
scrolling it on a phone, so anything worth knowing is repeated at the end.

## Schema changes need two edits, not one

worker/schema.sql is all CREATE TABLE IF NOT EXISTS, which does NOTHING to a
table that already exists. Adding a column there changes what a fresh database
gets and silently leaves every deployed one alone, while the deploy reports
"schema applied."

Adding a column to a table that has ever shipped means editing BOTH:

  worker/schema.sql      the CREATE, for new databases
  worker/migrations.sql  the matching ALTER, for the ones already out there

This is not hypothetical -- see the commit "CREATE TABLE IF NOT EXISTS cannot
add a column". A missing column cost six deploys and looked like a feature that
was switched off.

## Modal costs money: ask before sending runs there

Workflow 14 can run its models on a paid GPU on Modal (`gpu: modal`). The
owner pays for it -- $8.78 in the first day -- so ASK FIRST, every time, with
how many runs and a rough cost. The default is `github`, the free CPU runner,
and that is what to use without asking. A job there may take six hours, and
workflow 14's two jobs get six each.

Spread launches out rather than dispatching a batch in one minute: eight at
once hit Modal's app-create rate limit.
