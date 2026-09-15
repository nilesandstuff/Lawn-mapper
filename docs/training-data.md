# Training data and eval data

What goes into the corpus, what comes back out of it, and which maps are held
back to prove a model with. Written down because most of these decisions are
cheap now and expensive later: a split chosen after seeing the results is not a
split, and coverage that was never collected cannot be recovered.

Nothing here is running yet. The corpus is filling up; the export workflow that
reads it does not exist. This file is what that workflow will be built to.

---

## The plan, in order

Four stages, and the first two do not involve training anything. Most of the
value arrives before a model does, which is the least obvious thing in this
file.

**Now — collect, and watch the shape of what is collected.** The console's
training-data panel ranks what the pile is short of. Follow the top item. Map
count is the least important thing on that list and the one that grows on its
own.

**At 50–100 maps — measure the tree overshoot and trim it in post-processing.**
The detector's own outline is now stored next to the corrected one, so the
overshoot can be measured directly: how far outside the true edge it lands, per
imagery source and per mode. Then shrink the mask by that much. Days of work,
no training, and it targets the fault that produced the Boyds screenshot. This
is the best return available and it needs a fiftieth of the data a model does.

**At ~1,000 maps with ~300 corrections — the first fine-tune.** Crops at a
fixed resolution, the parcel as a separate input, scoring stopped at the
property line, split by ~1 km block. Ship only if the hard slice improves and
the representative slice does not regress.

**Before leaning on it anywhere new — leave-one-county-out.** Counties take
turns as the test fold. This is the only estimate of what happens in a part of
the country the model has never seen, and it is worth having before somebody
there opens the site rather than after.

### What is worth arguing about, and what is not

Most of this file was settled by argument, and three of those arguments changed
it substantially. The load-bearing conclusions, in the order they matter:

1. **The property line does most of the work.** It is the one thing never
   guessed, so the model is scored only inside it. That single decision makes
   the neighbour problem small, the split light, and the task narrow enough
   that a few hundred examples can beat a general-purpose detector.
2. **Corrections are the scarce input.** Not the only valuable one — that was
   wrong and is corrected in Rule 1 — but the one that runs out first and the
   one that fixes a known fault.
3. **Everything else is cheap insurance.** The block split, the buffer, the
   resolution target: each is a guess that costs little if wrong and that the
   corpus can settle later. None is worth delaying collection over.

---

## What a row is

One finished map — somebody pressed **finish, save, and see more options**, which
is the only moment the app treats an outline as done.

| | |
|---|---|
| the picture | an aerial photograph in R2, `image_key` |
| the label | `shapes`, the lawn outline as polygons |
| the frame | centre, zoom and size — re-fetches the same photograph at will |
| the parcel | the property boundary, when the county had one |
| the AI's version | `detected_shapes`, the outline before anybody edited it |
| the numbers | `detected_sq_ft` (before editing), `square_feet` (final), `parcel_sq_ft` |
| the context | `county`, `provider`, `model`, `mode`, `hand_edited`, `parcel_source`, `exclusions` |

`detected_shapes` is the one that had to be caught at detection time or lost
forever — the outline is edited in place, so by the time anybody presses finish
the detector's own answer has been overwritten. A total was never enough:
`detected_sq_ft` says how far the answer moved, and only the two outlines
together say WHERE it was wrong, which is what measuring the tree overshoot
needs.

`parcel_source` separates a county record from a line somebody traced, because
the whole plan rests on the boundary being trustworthy and those two are not
equally trustworthy. `exclusions` names the prompts that ran, which is a
*hint* that a lawn was hard — see the canopy grade below, which is the
measurement.

A hand-traced boundary stores **no county**, rather than the words "traced by
hand". It is not a place, and counting it as one would have put every such row
into a single enormous fake county — which the leave-one-county-out check would
then have held out as though it were a region.

`frame` is what makes a row durable: even with no image stored, the photograph
can be fetched again from the same rectangle of ground. A row with a null
`image_key` is recoverable, not lost.

---

## Rule 1 — keep every finished map, corrected or not

Both kinds are wanted, and for opposite reasons.

**Accepted maps** — the detector's outline, endorsed by a person — are most of
what a model will actually meet. A model's sense of an ordinary suburban lawn
comes from these, and a training set built only of failures produces a model
that expects every lawn to be a hard case and goes hunting for pathology in
plain back gardens.

**Corrected maps** — hand-drawn, or edited far enough to move the number — are
the only evidence of what the detector gets *wrong*. They are also far rarer.

An earlier draft of this rule said accepted maps were near-worthless because
training on them only teaches a model to imitate the detector. That is wrong: a
student trained on its teacher's own labels routinely beats the teacher once the
task is narrow enough, and this task is very narrow — one class, fixed
viewpoint, a parcel boundary handed over as a prompt. These are not raw teacher
labels either; a person looked at each one and endorsed it.

What is true is narrower, and worth keeping in mind:

- **Scattered label error averages out.** More accepted rows are close to free.
- **Directional error does not.** The detector's habit of overshooting a tree
  line by roughly a quarter is wrong the same way every time. No quantity of
  quietly accepted rows will cancel it — only disagreement carries that signal.
- **Acceptance is the weaker evidence.** It can mean the trace was right, or
  that nobody looked closely. A correction is unambiguous.

So: collect everything, and count the two separately. The console does
(`total`, and `corrected` beneath it).

**Corrected** means `detected_sq_ft IS NULL` (drawn from scratch, so there was
never a detection to agree with) **or** the final number differs from the
detected one by 10% or more. Ten per cent is the line between a correction and a
nudge: dragging a vertex a few feet is somebody tidying an edge, a tenth of the
lawn is somebody saying the detector was wrong.

---

## Rule 2 — mind which photograph the outline was drawn on

`provider` is what the person was **looking at**. `image_provider` is what was
**stored**. They are not always the same, and a training set that assumed one
field meant both would silently pair a mask traced on one photograph with a
different photograph of the same ground.

| drawn on | stored | same capture? |
|---|---|---|
| `mapbox` | mapbox | yes |
| `naip` | naip | yes |
| `ndvi` | naip | yes — NDVI is the near-infrared rendering of the same NAIP capture |
| `google` | mapbox | **no** — often a different year |
| `esri` | mapbox | **no** — often a different year |

Google's imagery is not stored because its terms are the restrictive ones, so a
lawn drawn on Google is banked against the Mapbox tile for the same frame.

This is *not* a geometry problem. Every source draws the same rectangle — the
frame fixes the ground, and `tools/probe-imagery.js` verifies each source
returns that exact extent to 0.000 m. The problem is **time**: if a tree came
down, a patio went in, or the lawn was re-turfed between the two captures, the
outline is right about the ground the person saw and wrong about the ground in
the stored photograph.

- **Training:** include them, flagged. The ground usually has not changed, and
  they are a minority.
- **Eval: exclude them.** A held-out label has to be unambiguous, or a model
  gets punished for being right.

`ndvi` rows deserve a note of their own. The person had near-infrared to look
at, so the label may be *better* than anything visible in the stored RGB. That
makes for excellent ground truth and a slightly unfair question — it is still a
correct answer, so keep them, but do not be surprised if they are the hardest
rows in the set.

---

## Rule 3 — what an example is, and why the answer is never in it

Two decisions about what a training example physically looks like, both easy to
get wrong in ways that are invisible until the model is useless.

**Crop to the parcel plus a buffer, and hold the GROUND RESOLUTION fixed rather
than the pixel size.**

An earlier draft said train on the whole frame, on the grounds that inference
gets a frame and nothing tighter. That is true of renting SAM and false of a
model of our own: whoever owns the model owns what inference looks like too, so
the rule is that the two MATCH, not that either is the frame.

Cropping is worth doing because it puts more of the picture on the thing being
judged, and it cuts what two neighbouring examples have in common — 82% of a
whole frame, against 29% of a crop with a 5 m buffer. Keep a buffer of roughly
5–10 m: where a lawn stops is usually decided by what is beside it, a driveway
or a sidewalk or the neighbour's differently-mown grass, and a crop with no
margin deletes the evidence.

The resolution part matters more, and is easy to miss. `zoomToFit` picks the
zoom so the parcel FILLS the frame, which means the corpus already varies about
sixteenfold in how much ground a pixel covers:

| zoom | ground per pixel | frame width |
|---|---|---|
| z16 | 0.89 m | 568 m |
| z18 | 0.22 m | 142 m |
| z20 | 0.055 m | 36 m |

A small suburban lot is stored at 5.5 cm per pixel and a large rural one at
89 cm. Grass at those two scales does not look alike — blades against a green
smear — and a model trained across that mixture spends most of itself learning
every texture at every size.

So resample every example to one resolution and let the pixel dimensions vary
with the lot. **Around 0.25 m per pixel** is the honest target: NAIP is 30 cm
natively and Mapbox is typically 15–30 cm, so anything finer is a server
enlarging pixels it does not have — which is exactly what a z20 frame at 5.5 cm
is.

Two consequences to plan for. Very large parcels become very large images at a
fixed resolution, so cap the size and let those drop to a coarser resolution, or
leave them out of the first model. And images of different sizes have to be
padded or grouped by size before training, which is ordinary work but not free.

**The parcel polygon still goes in as a separate input**, cropping or no
cropping — an extra channel, or a box prompt to SAM. A crop is a rectangle and a
lot is not, so the corners of every crop are somebody else's land. The crop
narrows the picture; the boundary is what says where the answer stops. It is
already on the row.

**Outside the property line, the model gets no opinion — not a wrong one.**

This is the most important line in the file and the easiest to build backwards.
Inside the boundary, every pixel is lawn or not-lawn and the model is marked on
it. Outside the boundary, the model is marked on NOTHING: no credit, no blame,
no answer attached.

The tempting shortcut is to call everything outside the line "not lawn", because
it makes the target a simple rectangle. That teaches the model that the
neighbour's perfectly good grass is not grass — and the neighbour's grass is
usually pressed right up against the edge this is all trying to get right. It
would make the model worse at precisely the boundary that matters most.

Doing it properly is also what makes the light split in Rule 4 defensible. Once
the score stops at the property line, a neighbour's lawn in the corner of the
picture carries no answer, so two overlapping frames are far less alike than
their pixels suggest. Build this wrong and Rule 4 has to get much stricter.

**The outline is a separate mask channel and is NEVER painted into the RGB.**
An image with the answer drawn on it teaches a model to find the drawing, and at
inference there is no drawing. This is the single most expensive mistake
available here and it fails silently: training loss looks wonderful, and the
model is worth nothing.

---

## Rule 4 — split by place, never at random

**What a split is.** Every row gets one label — train, tune or test — and the
only question is how that label is decided. Deciding it per row, by coin flip,
is a random split. Deciding it per *place*, so everything nearby moves together,
is what this rule asks for.

### There is no single right strictness — pick the question first

Three splits, three different questions, all legitimate. The mistake is
reporting one and believing it answered another.

| split | the question it answers |
|---|---|
| random | a new lawn on a street we already have maps for |
| **~1 km blocks** | **a new street in a town we already have maps for** |
| leave out a county | a new part of the country entirely |

The middle one is the everyday number, because it is what the app does most.
The county one matters the first time somebody in an unmapped state opens the
site; it stays a rotating check rather than a permanent holdout, below.

### How strict, and why it is lighter than it first looked

Two earlier drafts of this rule were stricter, and both overstated the danger in
the same way — by treating shared PIXELS as shared ANSWERS.

The pixel overlap is real and large: a 640 px frame is 142 m across at z18 while
a suburban lot is 18–30 m, so two houses 25 m apart share about 82% of their
picture. From that this file concluded a 4 km block was needed.

Two things in Rule 3 take most of that away. The score stops at the property
line, so the neighbour's lawn in the corner has no answer attached — no credit,
no blame, nothing learned; shared pixels are not shared labels. And the example
is a CROP rather than a whole frame, which cuts the raw sharing as well:

| what gets sent | shared with the neighbour |
|---|---|
| whole frame, 142 m | 82% |
| crop, 5 m buffer | 29% |
| crop, 10 m buffer | 44% |

What genuinely survives is smaller:

- **The same lawn saved twice**, which is the one unambiguous leak and needs
  only "everything at one address stays together".
- **Houses on one street looking alike** — same grass, same mowing week, same
  photograph on the same day. Real, but mostly this is the model *working*:
  recognising grass is the job. It only becomes cheating if a model memorises a
  specific picture, which is a second-order risk rather than the main event.

So the block is **~1 km** (slippy z15): large enough that two crops from one
street cannot land on opposite sides, small enough to cost nothing.

Ranked honestly, **keeping one address together is the necessary part and the
block is insurance** — cheap insurance against a model memorising a particular
photograph, which is why it stays, but not the load-bearing rule it started as.

| slippy zoom | ground size, lat 30° → 42° | |
|---|---|---|
| z13 | 4.2 → 3.6 km | what two earlier drafts said; stricter than needed |
| z14 | 2.1 → 1.8 km | fine, and the lever if edges ever look material |
| **z15** | **1.1 → 0.9 km** | **use this** |
| z17 | 265 → 227 m | too close to one frame — neighbours would straddle |

The block id comes from `lng`/`lat` with `lngLatToWorld` in
`public/lib/mercator.js`, so like `county` it needs no new data and applies to
maps collected long before the rule existed.

**Assign by hashing the block id.** That makes the bucket a function of the
data rather than a judgement call, so there is no "was the split chosen after
seeing the results" question to answer — there was nothing to choose. The hard
slice of Rule 5 is then built by FILTERING the test blocks for corrections and
tree cover, never by picking which blocks are test. Split honest, slice
deliberate.

What a random split actually costs, in order of how much it matters:

1. **The same lawn twice — the one unambiguous leak.** A corpus row is keyed on
   place *plus method* (`idFor(lng, lat, model, mode)`), so re-finishing one
   garden in a different mode writes a second row of the same place, same
   outline. A random split can put one in train and the other in test, which is
   simply testing on training data. Not 82% alike — 100%. Any grouping by place
   kills it, including a much smaller one than a block.

2. **Neighbours — real, and milder than it looks.** Houses on one street share
   grass species, mowing week, sun angle and capture date, so a model that does
   well on one will do well on the next. Under Rule 3 that is mostly the model
   WORKING: it has learned what grass looks like, which is the job. It only
   becomes cheating if it has memorised a particular photograph — a genuine but
   second-order risk, and what the ~1 km block is for.

   What it is NOT is the neighbour's answer leaking. Their lawn appears in the
   frame with no label attached and teaches nothing about its own outline.

Two leaks survive a block split, and neither earns much machinery:

- **Block edges.** Two houses either side of one are metres apart, and at ~1 km
  a larger share of a block is near an edge than at 4 km. Drop to z14 or buffer
  the edges if it ever looks material — but it is the same mild neighbour effect
  as above, not a new one.
- **Imagery vintage.** A survey flight line covers far more than a kilometre, so
  train and test blocks in one county usually share a capture date. This one
  cannot be blocked away at any size, which is part of why the county check
  below exists.

### Three buckets, not two

An earlier draft of this rule said the eval set is "never tuned on" and gave
nowhere else to tune, which is an instruction that gets broken out of necessity:
something has to be checked against while picking a threshold or deciding when
to stop training, and if the held-out set is the only candidate it will be used.
It then stops being held out, quietly, and the final number is a fiction.

| bucket | share of blocks | looked at |
|---|---|---|
| **train** | ~70% | constantly |
| **tune** | ~15% | as often as needed — thresholds, early stopping, "is this working" |
| **test** | ~15% | ONCE, when a model is otherwise finished |

Tune is the pressure valve. It exists so test can stay sealed, and it is
expected to get worn out — a number you have optimised against twenty times is
no longer an independent measurement, which is fine for tune and fatal for test.

If test has been read more than once for a given model, it has become a tune
set, and the next honest number needs blocks nobody has looked at.

### Counties still have a job: leave-one-county-out

The block split answers the everyday question — **a new property in an area we
already know**, which is most of what the app does. It does not answer the other
one: **a new area entirely**, which is what happens the first time somebody in a
state with no maps in it opens the site.

Counties answer that, as a diagnostic rather than a permanent holdout. With five
counties in the corpus, run five folds: train on four, test on the fifth,
rotate. Every county takes a turn, all the data is used, nothing is sacrificed,
and the result is a DISTRIBUTION of "how badly does a genuinely new region go"
rather than one number from one unlucky county.

Run it when the question is whether the model travels — before leaning on it in
a new market — not as the thing to optimise against. Optimising against it would
burn the only estimate of new-region performance there is.

**Two numbers, two meanings:** the block test says how the model does for the
people using it; leave-one-county-out says what to expect from the next place.
Expect the second to be worse, and do not average them together.

### When the split is decided

At export, and frozen before the first training run. Export itself is just
reading rows out and can be repeated harmlessly; what must never move is the
assignment, and it must never move *after a score has been seen*.

Hashing the block id (above) makes this nearly self-enforcing — the assignment
is computed, not chosen, so re-deciding it is something you would have to do on
purpose. Record the hash rule and the block zoom in this file when fixed.

**The honest cost:** any place-based split produces a worse number than a random
one. That is the point — it is the true one. It also means the figure is not
comparable to published results that split at random, which most do.

---

## Rule 5 — two slices, not one

Cut across the held-out blocks from Rule 4 — both tune and test get the same
two slices, because a fix that shows up in tune and not in test has not been
demonstrated.

| slice | what is in it | the question it answers |
|---|---|---|
| **representative** | natural proportions, as collected | how accurate is this in practice? |
| **hard** | corrections, and canopy that decided the edge | did we actually fix the overshoot? |

One slice cannot do both. Weighting the hard cases up gives a headline accuracy
that understates real-world performance; leaving them at natural proportions
means a handful of tree cases decide nothing, and the fault the whole exercise
exists to fix is invisible in the score.

### What "canopy" means here, exactly

This was asked directly, and the first answer given — a tick box labelled
"has a tree line" — could not be answered: did it mean **a row of trees**, or
**any trees that make the lawn cover ambiguous**?

The second is what the hard slice is about. The fault being chased is the
detector's idea of where grass stops under a canopy edge, and a single wide
maple over the middle of a lawn produces exactly the same disagreement as a row
of them along a fence. A row of trees is a shape, not a difficulty.

But taken literally the second reading is true of **every lawn on a wooded
street**, which is most of the corpus so far — and a flag that is true of
everything selects nothing. It would have made the hard slice the whole test
set and the target something you meet by approving anything.

So it is a grade rather than a flag, and the reviewer answers it against the
photograph:

| grade | what it means | counts toward the target |
|---|---|---|
| **none** | the edge of the lawn is plainly visible | no |
| **some** | canopy overhangs, but you could still see where the lawn stops | no |
| **decided the edge** | you had to *judge* where the grass stops under the trees | **yes** |

The test is about **you**, not about the trees: if drawing the outline meant
making a decision that another careful person could reasonably have made
differently, that is the top grade. If you could simply see it, it is not — no
matter how many trees are in shot.

A row left ungraded stays `null`, which is deliberately different from "none".
"Nobody looked" and "looked, and there is none" are not the same evidence, and
the second one is worth having.

*Recorded as `corpus.tree_line`, which keeps its original name: the column is
an integer and renaming it in SQLite would break the migration's re-runs for
nothing. 0 / 1 / 2, null for ungraded.*

**Ship a model only when the hard slice improves and the representative slice
does not regress.**

Sizes **for the test bucket**, against the ~1,000–1,500 finished maps expected
for a first useful fine-tune. Tune can be smaller, since a worn-out number is
what it is for:

| | total test maps | of which corrected | distinct blocks |
|---|---|---|---|
| bare minimum | ~100 | ~40 | 30+ |
| comfortable | 200–300 | ~100 | 60+ |

Blocks rather than counties in that last column, because a hashed block split
already spreads the test bucket across every county in the corpus — county
coverage comes free, and is no longer the thing to check. What can still go
wrong is *concentration*: 100 test maps sitting in five blocks is five
independent places, not a hundred, whatever the row count says.

Below about 50 the confidence interval is wide enough that a 10% improvement
and a 10% regression look the same, and you are reading noise. The second
column is the one that binds: 300 test maps with eight tree cases in them cannot
tell you whether the overshoot is fixed.

---

## Rule 6 — score in square feet, not IoU

The product outputs a number of square feet. So the metric is relative error
against the human's final figure:

    |predicted − actual| / actual

A model with worse mask overlap but better-calibrated area is **better for this
app**, and IoU will say the opposite. Report the median and the 90th percentile;
a mean is dominated by the few catastrophic ones and hides whether the ordinary
case got better.

Keep IoU as a diagnostic — it says *where* a mask is wrong when the area number
says only *that* it is. It is not the thing being optimised.

---

## What gets trained, and what does not

**Decided: a segmentation head on a frozen pretrained backbone.** One class,
lawn or not, with the loss masked to the property line.

Not a fine-tune of SAM 3, and not a trim on top of it. The reasoning, since
this will be re-argued:

- **The task is narrower than SAM 3 is.** One class, a known region of
  interest, and no prompt needed at inference. SAM 3's promptability is
  machinery that would be paid for per prediction, forever, and not used at
  detect time.
- **The labels already are what it eats.** Dense masks inside a known boundary
  is exactly a segmentation training set. Nothing about collection changes, and
  nothing already collected is wasted.
- **Frozen backbone, not from scratch.** At ~1,000 examples the features are
  most of the value; the head is the cheap part. This is the option that gets
  foundation-model features without foundation-model serving costs.
- **A post-processing trim was considered and rejected.** The known tree
  overshoot suggested fitting one number — shrink the mask by N feet — and the
  owner's read is that the error is too varied for that: not only trees, and
  not the same way about trees each time. A single parameter fitted to a
  multi-modal error improves the median and widens the spread, and this app
  quotes per lot rather than on average.

**What it costs:** exclude mode is prompt-driven and does not come along. It
either stays on SAM 3 alongside, or it retires.

**What stays on SAM 3 meanwhile:** everything, plus the property line as a
geometric prompt where the hosted model accepts one — text-only prompting
measures worst for irregular targets, and the boundary is the one cue here
nobody has to guess. Off until a real prediction says it helps.

**When:** not until the corpus is there. The binding number is still corrected
maps, and none of this changes what to do this month, which is measure and
approve.

---

## What to watch while the corpus fills

These cannot be fixed retroactively, which is why they are worth watching from
early rather than discovering at training time:

- **Counties.** A corpus from one metro produces a model that works in one
  metro. Spread matters more than volume; 300 maps across ten counties beat
  1,000 from one.
- **The corrected share.** If almost nothing is ever corrected, either the
  detector is better than we think or nobody is looking hard — and those want
  opposite responses.
- **Hard cases.** Heavy canopy, small lots, shaded strips. If people only ever
  finish easy properties, the hard slice cannot be built at any corpus size.
- **Imagery mix.** A corpus that is entirely `mapbox` is fine for training and
  leaves nothing to check generalisation against.

---

## Decided later, deliberately

- **Whether to upweight corrections in training**, and by how much. 2–3× is the
  obvious first thing to try, and natural proportions is a defensible baseline.
  Testable once there is enough data; guessing now buys nothing.
- **Whether cross-capture rows** (`google`, `esri`) earn their place in training
  at all. Keep and flag them until there is enough data to measure it.
- **The block zoom and the hash rule.** z15 (~1 km) and a plain hash of the
  block id are the defaults above; both get written into this file when fixed,
  before the first training run, and not revisited afterwards. z14 is the lever
  to reach for if edge effects ever look material.
- **The crop buffer and the target resolution.** 5–10 m and ~0.25 m per pixel
  are the defaults in Rule 3, and both are guesses that the corpus can settle:
  the export can report the real spread of parcel sizes and native resolutions,
  and those numbers should pick the values rather than these.
- **What to do with parcels too large to crop at full resolution.** Cap and
  coarsen, or leave out of the first model. Needs the size distribution to
  decide, which is one query once there is a corpus worth querying.
