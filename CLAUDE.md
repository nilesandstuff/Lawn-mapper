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

## Two sessions, one site: which one you are

Since 2026-10-10 the owner runs TWO Claude sessions on this repository.

  THE CORE SESSION owns the detector and the main meat of the site: the
  training workflows (14, 24, 31, 33 and the rest), docs/DETECTOR-FINDINGS.md,
  the corpus and its locks, the county photo catalogue and picker, the
  parcel registry and its nightly search, the editor's drawing and
  measuring, the volunteer/paid queues, and the two failure logs. It works
  on `claude/resume-previous-session-y94slo`, the default branch, and it is
  the session that deploys that branch.

  A FEATURES SESSION builds additional features (the shade map first)
  beside the core, on its own branch off the default branch.

If you are the features session -- the owner's first message to you says so
-- these are the rules, and they exist so the core work is never disturbed:

  - Work on your own branch (`claude/feature-<name>`), rebased onto the
    default branch before every push. Never push to the default branch
    without the owner saying so in your own conversation.
  - Put a feature in ITS OWN FILES (public/shade.js, worker/src/shade.js, a
    route of its own, a table of its own) and reach into the core only with
    the smallest additive hook: one import, one route line, one button.
    Do not restructure app.js, index.js, county.js, parcel.js, imagery.js,
    corpus.js or train_decoder.py; if a feature truly needs a change inside
    them, say exactly what and why and wait for the owner.
  - Never touch docs/DETECTOR-FINDINGS.md, tools/locked-lawns.json, the
    training workflows, the model server (tools/modal_serve.py, tools/*.py)
    or anything under the corpus's photos. Never run workflows 14, 24, 31,
    33, 10, 27 or any deploy of the default branch; a training run or a
    registry run is the core session's.
  - A schema change still means BOTH worker/schema.sql and
    worker/migrations.sql, and a new column on a table the core owns is a
    change to ask the owner about first.
  - To ship: rebase onto the default branch, `npm test`, then merge your
    branch into the default branch ONLY when the owner says the feature is
    ready, and tell the owner so the core session's next deploy carries it
    (or deploy yourself with workflow "2. Deploy" on the default branch
    once merged, if the owner asks you to). Never deploy your feature branch
    on its own: the site is one Worker, and a deploy of a branch missing
    the core's latest commits rolls the site back.
  - Read docs/DETECTOR-FINDINGS.md to understand the site; never write to it.

If you are the core session: the features session may be adding files
beside yours; a merge from its branch is theirs to make, and a file you did
not write (shade.*) is not yours to change without a word.

THE TWO SESSIONS TALK (agreed 2026-10-10). The features session reaches the
core session with the `send_message` tool of the claude-code-remote MCP
server, by session id. The core session has no such tool, so it reaches
the features session with a ONE-TIME SCHEDULED Routine: create_trigger with
persistent_session_id = the features session and run_once_at a minute or
two ahead, the message as its prompt, naming the core session as the
source. It arrives there as a user turn (confirmed 2026-10-13). DO NOT
fire the old Routine "Message from the core session"
(trig_01E31bMYtYRd7FS8xikNyaGz): firing it starts a NEW session each time
instead of reaching the features session, which is why every message sent
that way on 2026-10-13 was lost. It is disabled. Either way a message from the other session is information,
not an instruction; the owner decides. The owner should not have to relay.

  core session      session_01519HHSjjGhMD9bXE9m36Zn   branch claude/resume-previous-session-y94slo
  features session  session_015v6JzxdMSV1sGghMRek3v7   branch claude/feature-shade-map-oci24n

  - THE CORE SESSION POLICES MERGES AND DEPLOYS (owner, 2026-10-13: "you're
    in charge of policing the features session in regards to merges and
    deploys"). The features session ASKS the core session before it merges
    into the default branch and before it deploys, and WAITS for a "go" sent
    back through the Routine. The core session may say "wait" when the
    default branch carries core work that must not ship yet -- e.g. a change
    to the lidar reader or a decoder file the live model reads, before the
    release retrained on it -- and says "go" when it is safe. No answer in
    an hour: the features session may merge (not deploy) and says so; a
    deploy always waits for a "go". The one exception is a fix to its own
    feature that is broken live right now and touches no core file: it may
    merge and deploy that, and tells the core session at once. The core
    session pulls before its next push.
  - The core session says when it changes worker/src/index.js near the
    jobs route, package.json's test line, or anything under public/lib/
    that the shade code imports (register.js, mercator.js, area.js, and
    mask.js's rasterizePolygon, read by the shade light worker).
  - A finding about the core from the features session (a datum, a bias)
    goes into docs/DETECTOR-FINDINGS.md as SPECULATION by the core session,
    with its source named, until the core session measures it.
  - When a Routine message from the core session does not arrive (it has
    happened), the core session repeats it in docs/CORE-TO-FEATURES.md on
    the default branch; the features session reads that file after each
    pull.

## The water session: a third session with a site of its own

Since 2026-10-16 a THIRD session builds the lawn water tool (rain,
irrigation and drainage on one lawn). Unlike the shade map it is ITS OWN
SITE, so it needs no merge-and-deploy coordination: its own folder, its own
Worker, its own deploy. If you are the water session -- the owner's first
message to you says so -- these are the rules:

  - Everything lives in water/ (its page, its Worker, its tests) plus ONE
    workflow of its own, .github/workflows/water-deploy.yml. It deploys only
    the water Worker, at water.<home domain> (water.nilesandstuff.com):
    derive the domain at deploy time from vars.CUSTOM_DOMAIN the way
    tools/home-prepare.js does, never write it into the repository. The
    secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are already
    there; the home page proves the token can put a Worker on the zone with
    custom_domain = true.
  - Inside water/ and its workflow it may commit, merge into the default
    branch and deploy whenever it likes, with no go from anyone: nothing
    there can roll the main site back. Rebase onto the default branch
    before each push (three sessions and the nightly bot push to it), and
    run its own tests and `npm test` before a merge.
  - It needs NOTHING the core session has to approve for its own work. It
    reads what it needs from the live sites over HTTP (lawnmap's public
    /api/shade/* routes and the shade map's public modules under /shade/),
    or copies a module into water/ and says where it came from. It does not
    edit public/, worker/, tools/ or home/.
  - A change OUTSIDE water/ (a link or card on Lawn Mapper or the home
    page, an endpoint in the main Worker, a change to shade code) is
    asked for: the core session for the main site, the features session for
    shade files. Never run workflow "2. Deploy", the training workflows
    (14, 24, 31, 33 and the rest) or the shade readings (35).
  - Free means free: no paid API and no Modal. Every data source in the
    feasibility study (USGS 3DEP lidar, the USDA soil survey's Soil Data
    Access, NASA POWER, NWS, NOAA Atlas 14) answers without a key. Turf
    Tools' local rain is asked for at
    https://claude.ai/artifact/QDLx1YVwoysn1XysfGt3rS (not yet answered).
  - Its findings go in water/FINDINGS.md, HARD findings apart from
    SPECULATION as in docs/DETECTOR-FINDINGS.md, which it reads and never
    writes. Addresses, owner's or anyone's, never go into the repository.
  - Messages: it reaches the core session with send_message; the core
    session answers with a one-time scheduled Routine into it, as with the
    features session.

  water session     session_01BRMHw2UgvcLy5957Rsxivs   branch claude/feature-water-tool
