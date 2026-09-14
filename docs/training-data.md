# Training data and eval data

What goes into the corpus, what comes back out of it, and which maps are held
back to prove a model with. Written down because most of these decisions are
cheap now and expensive later: a split chosen after seeing the results is not a
split, and coverage that was never collected cannot be recovered.

Nothing here is running yet. The corpus is filling up; the export workflow that
reads it does not exist. This file is what that workflow will be built to.

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
| the numbers | `detected_sq_ft` (before editing), `square_feet` (final), `parcel_sq_ft` |
| the context | `county`, `provider`, `model`, `mode`, `hand_edited` |

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

## Rule 3 — split by county, never at random

**What a split is.** Every row gets one label — train, tune or test — and the
only question is how that label is decided. Deciding it per row, by coin flip,
is a random split. Deciding it per *county*, so whole places move together, is
what this rule asks for:

```sql
-- test: whole counties, chosen once, never trained on
SELECT * FROM corpus WHERE county IN ('mi-kent','md-montgomery', …);
```

The mechanism is that trivial. Choosing the counties is the part that matters.

A random split leaks, in two separate ways:

1. **Neighbours.** Houses on one street share an imagery tile, a construction
   year, a builder's landscaping and a lawn species. Train on one and test on
   its neighbour and you are testing memory.
2. **The same lawn twice.** A corpus row is keyed on place *plus method*
   (`idFor(lng, lat, model, mode)`), so re-finishing the same lawn in a
   different mode writes a second row of the same garden. A random split can
   put one in train and the other in eval. A county split cannot.

`county` is already on every row, so the assignment is deterministic and applies
to maps collected long before the rule was fixed.

### Three buckets, not two

An earlier draft of this rule said the eval set is "never tuned on" and gave
nowhere else to tune, which is an instruction that gets broken out of necessity:
something has to be checked against while picking a threshold or deciding when
to stop training, and if the held-out set is the only candidate it will be used.
It then stops being held out, quietly, and the final number is a fiction.

| bucket | counties | looked at |
|---|---|---|
| **train** | everything not below | constantly |
| **tune** | a few, chosen for variety | as often as needed — thresholds, early stopping, "is this working" |
| **test** | a few, chosen for variety | ONCE, when a model is otherwise finished |

Tune is the pressure valve. It exists so test can stay sealed, and it is
expected to get worn out — a number you have optimised against twenty times is
no longer an independent measurement, which is fine for tune and fatal for test.

If test has been read more than once for a given model, it has become a tune
set, and the next honest number needs counties that have never been looked at.

### Choosing the counties

Deliberately, not randomly, and then frozen. They need:

- enough maps between them to reach the sizes in Rule 4
- a spread of regions and climates
- at least two with heavy tree cover, or the hard slice has nothing in it
- a mix of imagery providers
- nothing with a handful of maps in it — three maps is noise, not a county

Written into this file when chosen, and not revisited afterwards. A split
adjusted after seeing results is not a split.

**The honest cost:** this produces a worse number than a random split would.
That is the point — it is the true one. It also means the figure is not
comparable to published results that split at random, which most do.

---

## Rule 4 — two slices, not one

Cut across the held-out counties from Rule 3 — both tune and test get the same
two slices, because a fix that shows up in tune and not in test has not been
demonstrated.

| slice | what is in it | the question it answers |
|---|---|---|
| **representative** | natural proportions, as collected | how accurate is this in practice? |
| **hard** | corrections, and heavy tree cover | did we actually fix the overshoot? |

One slice cannot do both. Weighting the hard cases up gives a headline accuracy
that understates real-world performance; leaving them at natural proportions
means a handful of tree cases decide nothing, and the fault the whole exercise
exists to fix is invisible in the score.

**Ship a model only when the hard slice improves and the representative slice
does not regress.**

Sizes **for the test bucket**, against the ~1,000–1,500 finished maps expected
for a first useful fine-tune. Tune can be smaller, since a worn-out number is
what it is for:

| | total test maps | of which corrected | distinct counties |
|---|---|---|---|
| bare minimum | ~100 | ~40 | 5+ |
| comfortable | 200–300 | ~100 | 10+ |

Below about 50 the confidence interval is wide enough that a 10% improvement
and a 10% regression look the same, and you are reading noise. The second
column is the one that binds: 300 test maps with eight tree cases in them cannot
tell you whether the overshoot is fixed.

---

## Rule 5 — score in square feet, not IoU

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
- **Which counties are the tune counties and which are the test counties.**
  Fixed before the first training run, written into this file when chosen, and
  not revisited afterwards.
