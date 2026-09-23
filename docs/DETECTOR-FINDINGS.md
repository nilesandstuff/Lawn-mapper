# What we know about training a lawn detector

**This file is the memory. Read it before configuring a training run, choosing
a backbone, or interpreting a result — and add to it after every run.**

Nothing here is written from recollection. Every HARD FINDING is a number this
repository produced, from a workflow run whose log can be found again, or a
citation with a link. Everything else is labelled SPECULATION and is not to be
repeated as though it were established.

The distinction matters more than usual here because the measurement is noisy
(see H7) and because two "fixes" have already been argued for on the strength
of a theory that later measured as nothing.

---

## Legend

- **HARD FINDING** — measured here, or cited with a link. Repeatable.
- **SPECULATION** — a theory that fits the evidence and has not been tested.
  It may be worth acting on. It is not worth asserting.
- **THE PLAN** — what is being built, decided by the owner. A decision, not a
  result. It is not evidence for itself, and a stage being in the plan says
  nothing about whether it works.

A finding can also be **RETRACTED**, and one is (H18). Retractions are struck
through and kept rather than deleted: the wrong version is how the mistake
stays findable, and this file exists because results get misremembered in good
faith.

Every finding carries the date and the corpus it came from, because the corpus
changes and results from different corpora are not comparable.

---

## The numbers that matter right now

**CORPUS `1wxlejo`, 31 lawns, 2026-09-22 — the current state.**

| | error | notes |
|---|---|---|
| SAM (what we pay for) | **23.8%** | the line to beat, 25 lawns with a stored answer, all drawn by `sam3` |
| best of ours | **34.4%** | Scale-MAE 896px, **both**, beat SAM on 10 of 25 |

Gap: **1.45×**. It was 1.39× at 23 lawns.

**Everything below the corpus `14a2t7k` line is from a different 23-lawn set and
is NOT comparable to the table above.** The backbone-free control moved from
28.6% to 37.8% between them, which by H10 means the corpus moved and by H7
means nothing else in either table can be set beside the other. The old numbers
are kept because the *comparisons within* each run still hold.

> **WORK RESTARTED on 2026-09-22 at the owner's request**, after the pause on
> 2026-09-19. Eight more approved maps, 23 → 31. See H15 for what they changed,
> which is: nothing that helps.
>
> The earlier pause reasoning stands and is now better supported. H11: the
> model cannot help build the corpus until it beats SAM. It is no closer.

**1280 against 896 is UNSETTLED, by the owner's decision on 2026-09-19, pending
more corpus.** 1280 holds the better number — 26.1% against 28.2% — but 2.1
points at 23 lawns decides nothing, and the case swung twice in an hour on
readings that did not survive the next run. **Work at 896 in the meantime, for
the run times**; revisit when the corpus is big enough for 2 points to mean
something.

The row-by-row oddity stands and is unexplained: the two sizes swap which
configuration wins. The eye ALONE is much better at 896 (28.2% against 32.5%);
the ring row is much better at 1280 (26.1% against 32.1%).

Best-of-six is a *selected* number: six configurations were scored and the
lowest is quoted. At a fixed corpus that selection is reproducible (H10), which
is not the same as saying it would hold on the next twenty lawns.

---

## THE PLAN — decided, not measured

**This is the shape the project is being built to, as of 2026-09-23. It is
recorded here because it governs what gets built; it is NOT a finding, and
nothing in it has been measured end to end.** Where a stage already has
evidence, the evidence is named. Where it does not, that is said.

    1. a trained Scale-MAE finds VISIBLE lawn only, shadows included
    2. restor/tcd finds tree canopy
    3. reasoning -- a model or plain geometry -- decides where lawn continues
       under canopy:
         - canopy surrounded by grass through more than ~180 degrees
           probably has grass under it
         - canopy sitting on a lawn edge: follow that edge under the tree
         - lawn cannot appear more than about 10-15 ft from where stage 1
           actually saw grass
    4. LiDAR and infrared find the DRIVEWAYS, SIDEWALKS AND PATIOS THAT ARE
       HIDDEN UNDER CANOPY, and cancel any lawn stage 3 invented over them --
       the job Virginia's land cover layer already does (E7)

**Stage 4 is narrower than "find hard surfaces", and the narrowness is the
point.** The case it exists for is a driveway running under a tree: the camera
cannot see it, so stage 3 will confidently pave it with grass. LiDAR is the
right instrument precisely there, because returns reach the ground between
leaves where the camera cannot. E8 records that 3DEP's ImageServer serves
**bare earth only**, so this needs the Entwine point cloud's returns or an nDSM
from a DSM we do not have. Infrared is the cheaper half: NAIP carries a
near-infrared band, this repo already has an `ndvi` provider, and NDVI
separates vegetation from pavement nearly for free -- on the NAIP subset.

**The numbers in stage 3 are placeholders.** 180 degrees and 10-15 ft are
starting points to be swept, not settings.

**What is already known, per stage.**

- **Stage 1: measured.** H17 -- dropping unseen ground from training improved
  the visible half by 2.1-3.5 points on four of six rows. "Find only what you
  can see" is the configuration that scored better, not a hope.
- **Stage 2: works by eye, unmeasured** (H19), free, and precomputable --
  workflow 19, about 18 minutes of CPU, nothing bought. Its open problem is
  H20, resolution on big lots.
- **Stage 3: untested, and the cheapest thing here to test.** All three rules
  are ordinary raster geometry over two masks that already exist: an angular
  test round a blob, a geodesic dilation along an edge, a bounded dilation. No
  training, no corpus, no money, scoreable over all 33 approved maps in
  minutes.
- **Stage 4: the expensive one.** H16 says 29 of 31 lawns have LiDAR over them,
  flown 2011-2020, a median of ten years before the photographs.

**The two known problems, which are problems to solve rather than reasons to
stop.**

1. **Pines and mulch beds defeat the 180-degree rule.** Both are common in
   exactly the suburban lots this is for.
2. **Three hand-set numbers fitted on 33 lawns will fit noise** (H7: one map
   here is worth up to 10 points). The mitigation is real and is why this is
   worth trying where a bigger model is not: **three parameters can be swept
   and shown as a curve.** A flat curve means the rule does not work; a peak
   that moves when a lawn is added means it was noise. Neither is available
   from a network.

**Each stage is useful alone for building the corpus**, which S3 names as the
binding constraint.

**Crowns are out of scope** until everything above works. The measured crown
area per lawn is small enough that it is not where the square footage is, and
the one thing that made them attractive -- an off-the-shelf, well-tested
delineator -- turned out not to exist for our imagery. See H18's retraction.

---

## HARD FINDINGS — our own measurements

### H20. Resolution was a side effect of lot size. FIXED at capture, 2026-09-23
*Arithmetic over the frame sizes in the code and the per-lawn read sizes logged
by runs 35762129844 and 35781727027, 2026-09-23. The chain is measured; that it
is WHY the canopy reads worse on big lots is not.*

**THE FIX, and it makes most of what follows history.** `zoomToFit` chooses a
zoom that fits the parcel inside a fixed 640 logical pixels, so the RESOLUTION
of a banked photograph fell out of how big the lot was. The detector's needs
never entered into it. `captureFrame` in `worker/src/imagery.js` now pins the
resolution and lets the SIZE vary instead — 10 cm a pixel or better wherever
one Mapbox request reaches it, and **never coarser than the display frame
already managed**:

| lot across | was banked at | now banked at |
|---|---|---|
| 25 m | 2.0 cm/px | 2.0 cm/px — already finer, left alone |
| 122 m | 9.5 cm/px | 9.5 cm/px — already clears it |
| 172 m | 13.4 cm/px | **10.0 cm/px** |
| 197 m | 15.4 cm/px | **10.0 cm/px** |
| 231 m | 18.0 cm/px | **10.0 cm/px** |
| 319 m | 24.9 cm/px | **12.5 cm/px** (capped: needs tiling for 10) |

Small lots keep the extra resolution they were already getting free — the
photograph is the archive, and imagery gets reflown, so throwing it away to hit
a number would be permanent. Lots past about 256 m cannot reach 10 cm in one
request (Mapbox caps a static image at 1280 logical) and are flagged `capped`
rather than quietly returned as if they had. The frame the picture was taken on
is stored in `corpus.image_frame`, so nothing downstream has to infer the
ground size — it is exact Web Mercator from zoom and latitude, never a guess.

**The rest of this entry describes the problem as it stood before that.**

`public/app.js` sets `FRAME_SIZE = 640` logical pixels and Mapbox is asked at
`@2x`, so **every stored photograph is 1280×1280 whatever the lot**. Ground
coverage varies with the parcel, so ground resolution does:

| lot across | stored | after `DUMP_SIZE=1024` | to reach the model's 0.10 m/px |
|---|---|---|---|
| 25 m | 0.020 m/px | 0.024 | 4× **down**sample — real detail |
| 63 m | 0.049 | 0.061 | 1.6× down — real detail |
| 102 m | 0.080 | 0.100 | break-even |
| 194 m | 0.152 | 0.190 | 1.9× **up**sample — interpolated |
| 319 m | 0.249 | 0.312 | 3.1× up |

**The crossover is 102 m across**, and above it `tree-canopy.py` is inventing
pixels with a bilinear resize and handing them to a model that was trained on
10 cm imagery. That is E2 from the usual direction.

> **THE CROSSOVER IS NOT ONE NUMBER. It is a fact about each address.**
> *(Owner, 2026-09-23: "some mapbox photos are legitimately lower resolution".)*
>
> Every figure in the table above assumes a stored 1280 px frame holds 1280 px
> of **real** detail. Mapbox stitches its satellite layer out of many sources —
> Maxar in one place, a state orthophoto in another, something older elsewhere
> — so what is actually available differs from address to address, and past
> that limit the static API upscales its own tiles and returns them without
> comment.
>
> Where that is happening, the stored frame is *already* interpolated, the true
> crossover for that lawn is **below** 102 m, and `sourceMpp` and `upsampled`
> in every canopy run are **optimistic** for it. The single-number framing
> above is the convenient case, not the general one.
>
> **STILL NOT MEASURED. Runs 35812991329 and 35813325014 are VOID** — see the
> retraction under item 2 below. The reasoning in this box stands; nothing has
> yet tested it.

**11 of the 32 lawns in run 35762129844 were above the crossover.** The three
Bullitt County lawns that returned 0.0% canopy were all read at 107–112 m
across, inside the upsampled group — suggestive at n=5, and not more than that.

> **CONFIRMED and partly REFUTED by run 35809715707, 2026-09-23**, the first
> run with `DUMP_SIZE=1280`.
>
> **The arithmetic held.** Upsampled lawns went **11 of 32 → 6 of 33**, and the
> worst case **2.3× → 1.6×**. The prediction above was that five lawns would
> come off the list; five did.
>
> **The Bullitt County guess was wrong, and it is worth saying so plainly.**
> Those three lawns are now comfortably below the crossover and were not
> upsampled in this run — and they still return **0 clumps and 0.0% canopy**.
> Whatever is happening there, resolution is not it. The n=5 correlation was a
> coincidence, which is why it was written down as one.
>
> **And it is not a failure at all.** The owner checked the lots: they have no
> trees on the property. 0.0% canopy is the model being right. The whole thread
> — three lawns, a resolution hypothesis, a refutation — was chasing a correct
> answer, which is the cost of reading a number without looking at the ground
> behind it.

**Two separate losses, and the first is free to fix.**

1. ~~**The dump discards pixels it was given.**~~ **FIXED**, run 35809715707.
   `DUMP_SIZE` is 1280, the crossover moved to 128 m, and five lawns came off
   the upsampled list exactly as the arithmetic said they would.
2. **STILL OPEN.** Above 128 m, 1280 px is genuinely not enough. `imagePixels` in
   `worker/src/imagery.js` caps at 2560, so Mapbox *can* be asked for more —
   but whether more pixels means more detail, or just Mapbox doing the
   upsampling instead of us, depends on what imagery it holds at that zoom.
   **Still not measured; workflow 20 exists to settle it.** It also only helps
   newly captured photographs; the 33 already in the bucket are 1280 px and
   would need refetching.

   > ### RETRACTED, 2026-09-23: workflow 20 runs 35812991329 and 35813325014
   >
   > Both measured nothing about resolution, and every number they produced is
   > void — including "8 of 12 have detail we are not asking for" and "2 are
   > already stretched at 1280", both of which were written into this file as
   > results.
   >
   > **The error.** In the Mapbox static API the ground a frame covers is
   > `size × EQUATOR_M × cos(lat) / (512 × 2^zoom)`, so ground per returned
   > pixel is `EQUATOR_M × cos(lat) / (512 × 2^zoom × 2)` — **a function of the
   > zoom alone.** The probe fetched at sizes 320, 640 and 1280 at a FIXED
   > zoom. Measured: at z19 all three come back at **5.47 cm a pixel**, covering
   > 35 m, 70 m and 140 m of ground.
   >
   > So it compared three different-sized CROPS at one resolution and read the
   > differences as detail. A wider crop contains more varied scenery than a
   > narrow one; that is what those numbers were.
   >
   > **Why nothing caught it.** The tests cover the arithmetic — the residual
   > measure and the labelling — and both are correct. Neither knows what the
   > images handed to them are, so a probe fetching the wrong images passes
   > every test and prints a confident verdict. The three bugs found before
   > this one were all *inside* the tested part, which made the tested part
   > feel like the whole of it.
   >
   > **The fix.** Zoom and size move together: one zoom step up with twice the
   > size is the same lot at twice the linear resolution.

   **RE-RUN CORRECTLY, run 35848980523, the 12 biggest lots.** The answer is
   the opposite of what the void runs said.

   | | |
   |---|---|
   | Sharper imagery exists above what we store | **2** |
   | What we store is already the ceiling | **8** |
   | Already stretched at what we store | 1 |
   | Flat ground, nothing to gain | 1 |

   **Detail falls at every zoom step up, on every lawn**, which is the
   signature of running out of native imagery rather than of our request being
   too small. Kent at 197 m: 0.246 → 0.164 → 0.062. Ottawa at 87 m:
   0.073 → 0.028 → 0.015. Bytes per pixel one step up came back **0.65×** — the
   higher-zoom image compresses *better* per pixel, which independently says
   there is less in it.

   **So a bigger request does not fix H20's other half.** For 10 of 12 lots we
   are already at or past what Mapbox holds there. Closing it needs different
   imagery — NAIP, or a county orthophoto service (E7 has Virginia's) — not
   more pixels from the same source. That also means **the 33 banked
   photographs are not obviously worth refetching**, which was the expensive
   option on the table.

   **What this run still cannot tell you, and it is worth naming.** There is no
   control here for what a *genuinely native* zoom step looks like under this
   measure. `extra` was tested at a single size against known images; it was
   never checked for scale-invariance across two zooms of real imagery. So the
   ORDERING is trustworthy — Ottawa at 87 m loses far more per step than Kent
   at 197 m — while the absolute "8 are at the ceiling" rests on thresholds
   that have not been validated for this particular comparison. The cheap
   control is a lot in a city centre where Mapbox certainly holds fine imagery:
   if its steps stay flat while these fall, the measure is doing its job.

   **Why a bigger request was not obviously a fix.** Past a place's real
   coverage the Mapbox static API upscales its own tiles and returns them
   without comment. The measure is tested against images with known answers
   (`tools/probe-resolution.test.js`), and that testing caught two things: a
   first version that ranked flat grass as more suspicious than invented
   pixels, and — worse — that thresholds calibrated on synthetic images do not
   transfer at all. Real Mapbox frames score 0.017–0.164 where a synthetic 2×
   upscale scores 0.37, so an absolute cut read off made-up images would have
   called **every** real frame an upscale. Only the ratio between consecutive
   sizes transfers.

Every run now records `sourceMpp` and `upsampled` per lawn and prints the split
at the end of the log, so this is answerable from the output instead of being
re-derived.

**And the figure is computed from what R2 holds, not from the frame file.**
`resize` upscales as readily as it downscales, so a frame dumped larger than
its own photograph carries no extra detail — and a resolution figure taken from
the file would then claim resolution that does not exist, in the one number
whose entire job is to report exactly that. `scale.json` carries `storedPx`
and the Python says in the log when it has had to fall back.

---

### H19. The canopy mask is the good half. The crowns are not.
*Owner's reading of all 33 pictures from run 35781727027, 2026-09-22.*

**This is an eyeball reading, not a measurement, and it is recorded as one.**
Nobody has scored this canopy mask against anything — there is no canopy truth
in the corpus to score it against. What follows is what the pictures showed to
the person who drew most of the maps in them. It is evidence, it is the reason
to go and measure, and it is not a number.

1. **The raw mask outlines canopy well, including on leaf-off imagery.** The
   crown shapes drawn from it are "not good at all".
2. **It is near perfect on smaller lawns and gets worse on bigger ones.**
3. **On leaf-on imagery the mask is more accurate than our own `inferred`
   markings** — and looking at it revealed that parts of some inferred areas
   were plain shadow, not grass shaded by a canopy.

**What (1) means structurally.** `restor/tcd-segformer-mit-b5` is a SEMANTIC
model: per-pixel tree / no-tree, which is E5's own wording. It produces
**canopy**. Every "crown" in H18 is this repo's watershed guessing where one
canopy ends and the next begins — distance transform, peak finder,
`CROWN_GAP_M = 3` — and none of it is the model's. So (1) says the model's
actual output is good and our interpretation of it is not. Restor publish a
real crown model (`tcd-mask-rcnn-r50`); it was skipped because detectron2 is a
source build pinned to particular torch versions, and their own card says it
cannot separate touching crowns either.

It also means **H18's crown counts should not be read as tree counts.** A lawn
reported at 63 crowns may be one canopy split 63 ways.

**Update, run 35809715707:** mechanism (2) below was tested and **does not
explain the Bullitt County failures** — see the box in H20. It did move the
resolution of every big lot, and the canopy figures moved a long way with it
(see the run log), but two things changed in that run at once, so nothing there
is attributable yet.

**A candidate mechanism for (2), PARTLY TESTED — see H20.** Frames are dumped at a fixed
1024 px whatever the lot, so a 25 m lot arrives at ~2.4 cm/px and a 194 m lot
at ~19 cm/px. `tree-crowns.py` then resamples every frame to the model's own
0.1 m/px — which for the big lot is an UPSAMPLE from coarser imagery, adding
pixels and no detail. Two lawns also hit the 2048 px clamp and were read at
0.113 and 0.156 m/px instead of 0.10. That is E2's lesson from the usual
direction and it fits the observation, which is not the same as being the
cause. Dumping bigger frames for bigger lots would test it.

**(3) is a corpus-quality finding and the most consequential of the three.**
It says some `inferred` ground is mismarked — shadow recorded as
grass-under-canopy. That is error in the truth data, sitting exactly where the
detector is being asked to learn the hardest thing, and it bears directly on
H17 and on S2. The cheap test is already possible: the canopy mask is in the
run folder, so measuring how much of each lawn's inferred ground falls under
canopy would find the mismarked areas without anyone re-reviewing by eye.

---

### H18. ~~The tree model finds tappable crowns~~ — HALF RETRACTED. The crown counts were a fact about our own watershed
*Run 35764574338, 2026-09-22, 33 approved maps, `1wxlejo`,
`restor/tcd-segformer-mit-b5` at 0.1 m/px. Pictures at
`/predictions.html?set=crowns`. No predictions bought — 18 minutes of CPU.*

> **RETRACTED, 2026-09-23: every crown number below.** `tcd-segformer` is a
> SEMANTIC model — tree / no tree, per pixel, with no notion of where one tree
> ends (E5 says so in its own words). The crowns came out of a watershed in
> `tools/tree-canopy.py`, driven by a `CROWN_GAP_M` this repo chose. So "0 to
> 63 crowns, middle 9" and "middle 6 big enough to tap" are measurements of
> that parameter, not of those lawns, and **they were published here as
> results.** A lawn reported at 63 crowns may be one canopy split 63 ways.
>
> **What survives:** `onLawnPct` and `insidePct`. Watershed labels are
> disjoint, so summing over crowns is summing over the canopy mask minus
> simplification and the patches under `MIN_CROWN_M2`. Those two were always
> near enough canopy statistics, and the 32%-inside result stands.
>
> The watershed has been removed. See H19 for what replaced it, and the note
> below is kept unedited as the record of what was claimed.

The idea being tested is a tracer's interface, not a detector: hand somebody
each tree crown as a toggle — on for grass underneath, off to ignore — and the
slowest part of tracing a wooded lot becomes a row of taps. This run asked the
only question that decides whether that is worth building: are the crowns clean
enough to BE toggles.

**What was measured.**

| | |
|---|---|
| Maps drawn | 33 of 33 |
| Crowns per lawn | 0 to 63, middle **9** |
| Big enough to tap (≥ 1/12 of the frame across) | middle **6** of 9 |
| Crown area sitting on the traced lawn | 0% to 51%, middle **7%** |

**Crowns exist and are mostly tappable.** Six of nine on the middle lawn clear
a thumb-sized target, which is the number that makes a toggle list an interface
rather than a fiddle. That is the encouraging half and it is a real measurement.

**The tappability collapses exactly where the list would be longest.** Two
lawns: 28 crowns of which **1** is tappable, and 39 crowns of which **2** are.
The 63-crown lawn yields 13. So the lawns with the most trees — the ones the
whole idea exists to speed up — are also where the model shatters the canopy
into pieces too small to hit. A 63-item list of which 13 can be tapped is not
the interface that was proposed.

**Five of 33 lawns returned zero crowns** (three adjacent Bullitt County KY
addresses, one Utah, one North Carolina), all at 0.0% canopy. Whether those
lots are genuinely treeless or the model failed on that imagery is not settled
by any number here; the pictures are the place to check.

**The 7% turned out to be mostly about somebody else's trees.** *(Settled by
run 35781727027, same settings, same 33 maps, which added the second number.)*

A low share on the traced lawn had two explanations the first run could not
separate: the tracer looked at the tree and said no grass — a toggle correctly
starting OFF, the idea working — or the crown belongs to a neighbour and was
never a candidate. The second number settles it:

| | |
|---|---|
| Crown area inside the property line at all | 0% to 69%, middle **32%** |
| Lawns mostly on the property and mostly *not* on the lawn | **2** of 33 |
| Lawns mostly *off* the property | **9** of 33 |

So on the middle lawn **two thirds of the crown area was never anybody's to
decide**, and the "tracer declined these trees" reading — the one that would
support the toggles — is clean on 2 lawns out of 33. The 7% was a measurement
taken mostly over trees that are not on the property.

**This does not say the toggles fail. It says they have not been measured
yet.** The question was always about crowns a tracer would be offered, and a
crown outside the property line would never be offered. The measurement has to
be redone over parcel-clipped crowns before the headline means anything, and
that needs no re-segmentation — the clipping is in `tools/tree-crowns.js` and
the mask is already in the run folder.

*The two counts use cut points chosen here, not derived: "mostly on the
property" is `insidePct >= 50` and "not on the lawn" is `onLawnPct < 10`. They
are there to make the shape of the distribution legible in a log, and a lawn
sitting near either line will move between the groups if the cut moves.*

What the spread does rule out is the flattest failure: the values are not all
bunched in the middle. Of 28 lawns with any canopy, 16 sit below 10% and 9 sit
above 25%. That is a cluster near zero with a long tail, not two clean groups —
so "the crowns line up with the tracer's judgement" is not supported, and
neither is its opposite.

**Same county, opposite answers.** Kent County appears nine times with values
from 0.4% to 39%, so whatever drives the number is not the imagery source.

**Not measured, and worth being explicit about:** whether a crown corresponds
to one tree. The watershed splits a tree/no-tree raster; nothing here checks
its pieces against actual trunks, and `CROWN_GAP_M` (3 m) was chosen on the
argument that over-splitting costs more taps than under-splitting, not on a
measurement.

---

### H17. Dropping unseen ground from training improves the visible half by 2–3.5 points
*Run 35719107798, 2026-09-22, 31 lawns, `1wxlejo`, Scale-MAE 896px, twelve rows:
every configuration and a twin of it trained with the pixels marked "inferred,
not seen" dropped from the sample.*

**The question, and why it was open by omission.** `truth` is every shape the
tracer drew, inferred patches included, so the head has always been told to
answer 1 on ground whose appearance is indistinguishable from woods — the same
dark canopy labelled 1 on a lawn with one tree and 0 on a wooded lot. The marks
have been SCORED separately since that column existed and were never separated
in TRAINING. Nobody decided that; it was never asked.

```
what it looked at                 as-is  seen-only   change
colour and texture only           37.8%      34.3%      -3.5
the pretrained eye only           35.4%      33.3%      -2.1
both                              33.5%      31.3%      -2.2   <- best seen error here
both, 96 numbers a patch          37.7%      39.6%      +1.9
colour, with surroundings         39.6%      37.5%      -2.1
both, with surroundings           35.1%      35.8%      +0.6
```

**Four of six better, consistent in direction, 2.1 to 3.5 points.**

**AND THE TOP ROW'S −3.5 IS NOT RE-RUN NOISE.** `colour and texture only` is
backbone-free, and H10 says that row is exact; both halves of the pair sit in
ONE run on one corpus with one set of folds and one seed, so the only
difference between them is which pixels were sampled. Re-running would produce
−3.5 again. H13's "under 3 points needs a repeat" applies to backbone rows
across runs and does not apply here.

**What it does NOT establish.** H7 still stands: the lawn set is the biggest
term in every number, and a different 31 lawns could move this. The effect is
real and reproducible *on this corpus*; it is not established as a property of
the problem.

**The two rows that got worse are the two widest** — 110 and 174 numbers a
pixel. A twin trains on about 5% fewer rows (H6's typical marked share), so the
widest configurations lose the most sample per parameter. That is a plausible
account and it is not tested.

**Hard-rimmed shade moved a long way on the best row: 58.7% → 50.1%.**
Building shadow is not canopy, so this was not the target. Offered as an
observation only; see S5 on how unreliable the shade columns have been.

**The inferred column got much worse, exactly as designed** — colour-only went
24.7% → 55.8%. Nothing taught the twins what is under a tree. Predicted in
advance and in the code comments before the run, so it is the arrangement
working rather than a regression, and it is the reason a seen-only model is
**stage one of two rather than a drop-in**: SAM's 23.8% is measured against all
ground including inferred, so a model that answers only the visible half is not
comparable to it on total square footage and cannot replace it alone.

### H16. 29 of our 31 lawns have free LiDAR over them, flown 2011–2020
*Run 35716717308, 2026-09-22, workflow 17, corpus `1wxlejo`. Phase one of the
E8 idea, built to be able to abandon it cheaply.*

**94% covered.** Every approved map's point was matched against the 2,279
project footprints of the public Entwine copy of 3DEP.

```
covered                29 of 31
nothing flown           2  (both Maryland (MD iMAP))
flown                   2011 to 2020, middle year 2016
no year in the name     3 projects
8 pts/m² or better      8
below 2 pts/m²          0   <- 3DEP's own floor; none of ours is under it
```

**The two Maryland misses are a real local gap, not a hole in the index.** That
was worth checking before reporting, because "the index is missing projects"
and "the ground was never flown" look identical from one lawn. The index holds
19 Maryland projects, and a 377-point grid across the state comes back **88%
covered**, with every miss in the lower Chesapeake — water and the bottom of
the Eastern Shore. So Maryland is flown; those two properties sit in a gap in
it.

**THE PROBLEM IS THE DATE, NOT THE COVERAGE.** The middle flight year is 2016
and the maps were traced in 2026. Ten years is two or three trees' worth of
growth and several felled ones, and **the gap cannot even be measured**,
because the corpus stores when somebody traced a map and not when the aerial
was taken. That is the single most likely way a canopy height feature comes out
disagreeing with a photograph for a reason that has nothing to do with the
model.

Three more limits, all in the tool's own output so they cannot travel without
it: a footprint is a collection boundary rather than a promise of returns; the
year is parsed from the project's name, which is a convention and not a field
(`KY_FullState` carries none); and the density is the point count over the
footprint area, in POINTS where 3DEP's quality levels are in PULSES — so it
reads high, which makes "below QL2" strong evidence and "QL1" weak.

**Verdict, printed by the run: worth building phase two.** Not because the
canopy answer is expected to help — E8 is explicit that height is not species,
and this separates a shrub from bare ground while leaving grass and mulch
identical — but because the one blocking question, "do we even have the data",
is answered yes at 94%.

### H15. Eight more maps moved nothing. The gap is 1.45×, it was 1.39×
*Run 35683684006, 2026-09-22, 31 lawns, fingerprint `1wxlejo`, Scale-MAE large
at 896px. The previous 896 run was 35452491362, 23 lawns, `14a2t7k`.*

```
                            23 lawns   31 lawns
colour and texture only       28.6%      37.8%    <- CONTROL, backbone-free
the pretrained eye only       28.2%      35.6%
both                          34.9%      34.4%    <- best here
both, 96 numbers a patch      31.9%      37.0%
colour, with surroundings     37.0%      39.8%
both, with surroundings       33.6%      34.9%
SAM                           20.3%      23.8%
best / SAM                     1.39×      1.45×
beat SAM on                   (n/a)    10 of 25
```

**THE CONTROL MOVED 9.2 POINTS WORSE, so this is not the same measurement.**
That row reads no backbone at all, so its entire change is the corpus: the
eight new maps are harder than the twenty-three. SAM moved 3.5 points worse
too, on its own 25, which says the same thing from outside.

**So "did more data help" CANNOT be answered from this run, and that is the
finding.** Corpus size and corpus difficulty both changed, in opposite
directions for what we want to know, and they are not separable here. What can
be said:

- **The ratio did not improve.** 1.39× → 1.45×. Whatever the extra maps bought,
  it was not closing on SAM.
- **The win count did not improve.** 10 of 25 (40%) against 8 of 19 (42%) on
  the best 1280 run. Flat.
- **S3 is not confirmed and not refuted.** "The corpus is the binding
  constraint" predicts improvement from 23 → 31; none arrived. But 8 maps is a
  35% increase against a noise floor of up to 10 points (H7), and the new maps
  are demonstrably harder, so this is consistent with S3 being true and the
  signal being buried. Do not quote this run as evidence either way.

**The winner changed identity and the top three are 0.5 points apart.** "both"
34.4%, "both, with surroundings" 34.9%, "the pretrained eye only" 35.6%. At 23
lawns the 896 winner was the eye alone. By rule 3 none of that is a result:
which configuration wins is not stable at this corpus size, and a run that
picks a different winner has not discovered anything.

**One map is grotesque and should be looked at.** Prince William County, 3,425
sq ft, **234.8% wrong** against SAM's 45.2%. H8 is the precedent: a 309% map
was rejected on the owner's judgement because wild over-prediction by both
points at the map rather than at the model. Two more to eye: Prince William
8,836 sq ft at 73.6% (no stored SAM), and North Carolina 7,948 sq ft at 77.1%
against SAM's 32.2%. The median is the reported figure so these do not drag the
table, but H7 says one map is worth up to 10 points.

**Six of the 31 have no stored SAM outline**, so the comparison runs on 25. The
baseline is confirmed clean: the run now prints who drew it, and it is `sam3`
for all 25 — no land-cover answers have leaked into the line to beat.

### H1. Our imagery is 5–38 cm per grid cell, typically 10–15 cm
*Computed 2026-09-19 from the frame-fitting arithmetic, not measured from a
file.* The frame is fitted to the parcel and scored on a 512 grid, so the
ground sample distance varies with lot size:

```
2,656 sq ft lawn   ~25 m frame   ->   5 cm per cell
16,487 (typical)   ~63 m frame   ->  12 cm
22,484 (Kent)      ~73 m frame   ->  14 cm
158,451 (largest) ~194 m frame   ->  38 cm
```

This is the single most decisive fact about backbone choice, because almost
every remote-sensing backbone is trained an order of magnitude coarser.

### H2. A ground-pretrained backbone reads this imagery badly
*Run 35404198905, 2026-09-18, 24 lawns, DINOv2 tiled at 224px.*
Eye-only **48.5%** against colour-only **34.5%** — 14.0 points worse. Adding it
to colour made things worse than colour alone (37.1% vs 34.5%).

### H3. A satellite-pretrained, scale-aware backbone reads it far better
*Run 35409315409, 2026-09-19, 23 lawns, Scale-MAE large at 672px.*
Eye-only **36.4%** against colour-only **32.9%** — 3.5 points worse.

**The gap to colour closed from 14.0 points to 3.5.** That is much larger than
the noise floor in H7 and is the strongest result this project has.

It is still *worse* than colour alone on its own — but combining now helps for
the first time: "both" 31.2% beats colour alone 32.9%. Under DINOv2 it never
did.

### H4. The ring (neighbourhood sampling) has no consistent effect
Measured three times. **Negative twice, mildly positive once, and the tool
called the positive one "within noise" itself.**

| run | ring result |
|---|---|
| DINOv2 224px, 24 lawns | colour+ring **43.7%** vs colour **34.5%** — 9.2 WORSE |
| Scale-MAE 672px, 23 lawns | "everything visible 3.8 points worse, and inferred areas no better. The ring is costing and not paying." |
| Scale-MAE 896px, 23 lawns | both+ring **32.1%** vs both **34.6%** — 2.5 BETTER; tool: "inferred areas 3.5 points better, everything visible 3.1 points better — within noise." |
| Scale-MAE 1280px, 23 lawns | both+ring **26.1%** vs both **33.2%** — **7.1 BETTER**, and the best number this project has measured |
| Scale-MAE 1280px, repeat | both+ring **26.4%** vs both **35.9%** — **9.5 BETTER**; survives H13's drift |

**A CONFOUND IN EVERY RING ROW BEFORE 2026-09-19.** The row named "colour, with
surroundings" declares `backbone: false` and existed to answer one question:
does the ring's gain need the backbone, or is "is it green over there" the
whole of it. It could never answer that, because the ring sampled backbone
features whenever the LAWN had them rather than whenever the CONFIGURATION
asked — so that row carried six backbone numbers per ring point throughout.
Fixed, with a test. Every "colour, with surroundings" figure above it in this
file is really "colour, with a backbone-carrying ring".

**ANSWERED at 896, run 35449083419.** With the fix, that row went **35.7% →
31.2%** — and every other row in the table came back identical, because the fix
touches exactly one configuration. So:

- **The backbone features in the ring were making it WORSE by 4.5 points.**
  Neighbouring patch embeddings are apparently noise at ring distance; the two
  colour numbers per point are the useful part.
- **A colour-only ring beats colour alone: 31.2% against 32.9%.** So the ring's
  gain does not need the backbone, which is the question that row was built to
  answer. But 1.7 points is small — supportive, not conclusive.
- **`both, with surroundings` is unchanged**, at 32.1% (896) and 26.1% (1280),
  because it declares `backbone: true` and legitimately keeps its eye-carrying
  ring. The fix could never have touched it.

**So the 26.1% best result is NOT an artefact of the bug**, which is what it
was suspected of being. The suspicion was careless: the fix only affects a
configuration that asks for `backbone: false`, and the winning row asks for
`backbone: true`. It was never in scope.

Taken with H4's history — negative, negative, mildly positive, strongly
positive, and now the colour-only version at +1.7 points at both sizes — the
ring is doing two separable things:

- **as colour alone, a small real help:** 31.2% against 32.9%, reproduced
  exactly at 896 and 1280;
- **carrying backbone features, it depends entirely on the size:** it costs
  4.5 points at 896 and gains 7.1 at 1280.

That second line is the open question now, and it is a sharper one than "does
the ring work".

**Do not read the 896 run as vindication.** The tool prints an encouraging
sentence next to that row ("this is the result the ring was built for"), and
the same paragraph says the movement is within noise. Given H7's floor, a
2.5-point swing is not a result.

**The 1280 run is the first ring result large enough to be worth arguing
about**, at 7.1 points — and the tool still printed "neither column moved
beyond noise" beside it, because the seen/inferred split it reads did not move.
Two things are true at once: the ring's own diagnostic says nothing happened,
and the headline error dropped further than any other single change here.

**Fifth run, 896px on the new 31-lawn corpus `1wxlejo`, run 35683684006:
0.5 points WORSE.** both 34.4% against both+ring 34.9%. Colour-only ring is
39.8% against colour alone 37.8%, so 2.0 worse there too — which reverses the
+1.7 that had reproduced at both sizes on the old corpus. Different corpus, so
by H7 this is not a contradiction of that number; it is the ring failing to
reproduce its one consistent result the first time the lawns changed.

**And the run's own advice printed "This is the result the ring was built for"
directly beneath its own sentence saying the movement was within noise** —
inferred 6.2 better, everything visible 1.7 worse. That is rule 6 happening
again, on the same row it happened on before. The encouraging sentence fires on
the inferred column alone, and H6 says that column is 5% of a map.

The honest summary: across five runs the ring is **negative, negative, mildly
positive, strongly positive, negative**, and the tidy story that order told has
now been broken by the fifth point. It is not established as harmful and it is
not established as useful. It is the most interesting open question in this
file (S6).

See also E3 — the published result saying receptive field alone is not the
lever for occlusion.

**SPECULATION (S6):** the ring may only be able to help once the centre
features are good enough to be worth contextualising, which would explain why
its two best showings are the two best backbone settings, in order. Still
SPECULATION — four points on a curve that was *drawn after* the numbers came
in, and exactly the kind of story that sounds right and has twice measured as
nothing here.

**The fifth point does not fit it.** 896 on the new corpus is the same backbone
setting as the fourth-best point and the ring came out negative again, while
the colour-only ring — which S6 says nothing about — reversed from +1.7 to
−2.0. S6 is a story about backbone quality and the thing that changed was the
lawns. Treat it as weakened, not refuted: the corpus changed underneath it, so
it was never tested.

**How to actually test it, since the story is now cheap to break:** run 1280
again with the ring on the *worse* eye settings, or 448px with the ring on. If
the ring's benefit tracks backbone quality it should shrink or reverse there.
Nothing in this file currently distinguishes S6 from "1280 happens to suit the
ring".

### H5. A wider squeeze of the backbone's output helps
- *DINOv2:* 96 numbers a patch **34.0%** vs 32 numbers **37.1%**.
- *Scale-MAE:* 96 numbers **30.9%** vs 32 numbers **31.2%**.

Consistent in direction across both backbones. The effect is much smaller under
Scale-MAE, which may mean the 32-number squeeze was mostly discarding DINOv2's
noise rather than signal.

### H6. Marked "inferred" ground is only about 3–5% of a typical map
*23 lawns, 2026-09-19.* 17 of 23 maps carry inferred marks. Marked ground is
**3% of a typical map, 44% of the most-marked**.

*31 lawns, 2026-09-22, corpus `1wxlejo`.* **21 of 31 carry marks, and it is 5%
of a typical map** — the most-marked is still 44%. So the share is creeping up
as more maps are traced by people who use the tool, and it is still small
enough that S4 stands: at 5% the inferred column is a few thousand pixels per
lawn, and this run's swings across configurations (17.6% to 40.2%) are again
too wide to read as anything.

At 3% the inferred error column is measuring a few thousand pixels per lawn.
Its swings between configurations (17.8% to 53.5% in one run) are not currently
readable as signal.

### H7. THE NOISE FLOOR IS LARGE: one map is worth up to 10 points
*The most important methodological finding here, and the newest.*

Between the DINOv2 run (24 lawns) and the Scale-MAE run (23 lawns), one map was
rejected. Two of the six configurations use **no backbone at all**, so their
entire change is the corpus change:

```
colour and texture only      34.5% -> 32.9%    +1.6 points
colour, with surroundings    43.7% -> 33.2%   +10.5 points
```

**Removing a single map moved backbone-free configurations by between 1.6 and
10.5 points, depending on configuration.**

Consequences, and these are rules rather than observations:

1. Never compare two runs on different corpora without checking a
   backbone-free row first. It is the control.
2. Differences under ~10 points between configurations are not conclusive at
   this corpus size.
3. The lawn-set fingerprint printed by the tool exists for exactly this. Use it.

### H9. RESOLUTION IS A REAL LEVER — 896px beat 672px, cleanly
*Runs 35409315409 and 35411040880, 2026-09-19, same 23 lawns, same fingerprint
`14a2t7k`, Scale-MAE large at 672px then 896px.*

**This is the cleanest experiment this project has run**, because the
backbone-free control came back byte-identical:

*Run 35417355609, 2026-09-19, added 1280px — the frames' own size.*

**This is the cleanest experiment this project has run**, because the
backbone-free control came back byte-identical at every size:

```
                            672px   896px  1280px
colour and texture only     32.9%   32.9%   32.9%   <- CONTROL, never moves
the pretrained eye only     36.4%   28.2%   32.5%
both                        31.2%   34.6%   33.2%
both, 96 numbers a patch    30.9%   32.4%   31.5%
colour, with surroundings   33.2%   35.7%   34.4%
both, with surroundings     33.8%   32.1%   26.1%   <- best measured here, ever
```

The control moving 0.0 points means the corpus, the split and the seed are all
identical. Every other difference **is** the resolution.

1. **672 → 896 moved the eye alone 8.2 points better, 36.4% → 28.2%** — far
   outside anything else measured, and the first time it beat colour alone.
   This confirmed S1: we were starving a scale-aware backbone of the resolution
   we actually have.

2. **896 → 1280 moved it 4.3 points BACK, to 32.5%.** So resolution is a lever
   with a top to it, and among the three sizes measured **the eye alone peaks
   at 896**. Native size is not automatically the best size. Do not state
   "bigger is better" as a finding of this project; state that 896 won.

3. **1280 produced the best single number this project has: 26.1%**, "both,
   with surroundings", beating SAM on 8 of 19 — more lawns than any row before
   it. It is 5.4 points clear of the next row in its own table.

4. **The combined rows recovered.** At 896 every combination was worse than at
   672 (S7); at 1280 they are back in line — "both" 33.2%, "both, 96" 31.5%.
   Whatever S7 is about, it is not monotone in resolution either.

### H11. The 26.1% model's outlines are NOT usable for building the corpus
*Owner's judgement, 2026-09-19, looking at the renderings from run 35417355609
on /predictions.html — the best model this project has produced.*

The plan was: once the detector is good enough, let it draw first and correct
its outline by hand, so the corpus grows faster. The outlines were built and
looked at. **The verdict was no.** Not "nearly"; not usable.

**Why the bar was always higher than it looked, and this is the part to
remember before proposing the idea again:** the app already hands you a
starting outline. `worker/src/sam.js` runs SAM on every detection and the
result is stored as `detected_shapes` — so a person tracing a map is not
starting from an empty screen, they are correcting SAM. Our model therefore
has to be **easier to correct than SAM**, not merely better than nothing. SAM
is at 20.3% and our best is 26.1%, so it is not there, and nothing about the
pictures suggests it is close in a way the error figure was hiding.

Consequence: **there is no shortcut to the corpus through the model yet.** Any
plan that depends on one is blocked on beating SAM first — which is the same
line every other row in this file is measured against.

### H12. What the 1280 model is good and bad at, by eye
*Owner's reading of the same renderings, 2026-09-19. Observations, not theory —
the explanations are S8 below and are not established.*

**Better than expected, and better than SAM:**
- **Ambiguous ground around trees, and thin shadows.** The hard-looking case is
  not the one costing time.
- **Inferred areas** — "vastly better than SAM was", on this little training
  data.

**Worse, and this is where the labour actually goes:**
- **Dense shade from BUILDING shadows.** Not tree shade, which it handles.
- **Crisp edges — driveways and sidewalks — are performing very poorly.** Big
  effect on both square footage and the cost of correcting.

The worked example: the **10,553 sq ft North Carolina lawn**, 47.6% wrong on
the best row. The lawn is dormant but the edges are unambiguous — "nearly zero
ambiguity". A clear-edged lot is exactly where a detector should be safe, and
it is the one it fails hardest on.

**This inverts the assumption the work has been organised around.** The effort
has gone into shade, occlusion and the ring (H4, E3, S2) on the premise that
ambiguity is the hard part. By eye, ambiguity is handled and the *unambiguous*
boundaries are not.

**Second reading of the outlines, 1280 run 35449091188, owner, 2026-09-19.**
Viewed on their own rather than against the earlier set:

- **Dense shadow is still under-called, visibly unchanged.**
- **Clear edges are ODDLY INCONSISTENT** — and this is the new observation.
  Not uniformly bad: *"sometimes the edge is cleanly cut, sometimes it goes
  nowhere near the edge and misses large sections of grass, other times it
  counts plenty of a house or driveway as being lawn."* A model that were
  simply blind to sharp edges would fail the same way every time. This one
  fails three different ways on the same kind of boundary, which is a
  different complaint from H12's average and is not explained by it.
- **Some obvious trees are fully marked as lawn.** Not ambiguous canopy —
  *"this is obviously a tree, shouldn't be inferred as lawn"*.
- **Inferred areas are good, possibly better than the training data should
  allow.** The owner's own caution: that may be because the model is generous
  about trees, and generosity happens to be right where the reviewer marked
  ground they could not see. If so the inferred column is flattering for a
  reason that is a fault elsewhere, and H6 already says that column is too
  small to read.

**SPECULATION (S8):** a crisp albedo edge — dry dormant grass against pale
concrete — may be exactly what a scale-conditioned satellite backbone smooths
over, since at the resolutions it was pretrained on a sidewalk is sub-pixel.
That would also explain why building shadow is harder than tree shade: a
building shadow has a hard edge, a tree's does not. Untested, and it is the
kind of story that has measured as nothing twice in this file.

**MEASURED, 2026-09-19, run 35422422911. The pattern is real and large. The
explanation above is NOT supported.** Those are two separate results and the
second is the one that gets misremembered.

```
what it looked at            sharp    soft   hard shade  soft shade  middle
colour and texture only      50.3%   37.3%      41.8%      14.8%     28.3%
the pretrained eye only      64.5%   46.3%      48.9%      11.1%     26.6%
both                         61.7%   43.5%      48.8%      14.4%     28.2%
both, 96 numbers a patch     61.4%   43.2%      50.5%      14.4%     24.3%
colour, with surroundings    58.9%   48.4%      52.1%      23.9%     29.4%
both, with surroundings      60.7%   43.5%      59.4%      18.7%     19.3%
```

**H12 is confirmed, in both halves, in every configuration.**

- **Sharp boundaries are 10.5–18.2 points worse than soft ones.** Six rows out
  of six, same direction.
- **Hard-rimmed shade is 27–41 points worse than soft-rimmed shade** — a bigger
  gap than the boundary one, and the one nobody was looking at. Building shadow
  really is the expensive case and tree shade really is not.
- The interior control sits at 19–29%, well below either sharp column, so this
  is not merely "edges are hard".

**But S8 blames the backbone, and the backbone is not to blame.** S8's story —
a sidewalk is sub-pixel at the resolutions Scale-MAE was pretrained on, so it
smooths the edge away — predicts the gap should be much wider with the eye than
without it. **Colour and texture alone, with no backbone at any resolution,
shows the same pattern at 13.0 points.** The eye widens it to 18.2, which is
5 points and inside the noise this corpus carries (H7, H13).

So: sharp boundaries and hard-rimmed shade are hard for **this whole approach**
— a per-pixel head reading local features — and not for a satellite model
specifically. Anything proposed on the strength of "Scale-MAE can't see
sidewalks" is proposed on a premise this run does not support.

The run now prints that comparison itself, because the first version of the
verdict said "supports S8" from the best row alone and would have promoted the
guess on evidence that a model with no satellite in it reproduces.

Read it with three more things in mind.

**REPRODUCED ON A DIFFERENT CORPUS, 2026-09-22, run 35683684006, 31 lawns.**
This is the strongest thing about H12 now: the pattern survived a corpus change
that moved every headline number by 9 points.

```
what it looked at            sharp    soft   hard shade  soft shade  middle
colour and texture only      47.8%   39.6%      50.4%      18.7%     38.0%
the pretrained eye only      71.5%   53.4%      54.5%      13.9%     24.9%
both                         61.4%   44.8%      58.7%      23.1%     29.5%
both, 96 numbers a patch     61.5%   47.0%      50.5%      20.3%     32.1%
colour, with surroundings    58.2%   42.9%      45.3%      27.5%     36.4%
both, with surroundings      62.2%   48.0%      55.6%      22.0%     27.3%
```

Six rows of six, same direction again: sharp worse than soft by 8.2–18.1
points, hard-rimmed shade worse than soft-rimmed by 18–41. **H12 is the only
finding in this file that has held across two corpora**, which makes it the
one to act on if anything is.

S8's premise is no better supported than before. Without any backbone the
sharp/soft gap is 8.2 points and with the eye it is 16.6, so the eye widens it
by 8.4 — larger than the 5 points seen at 23 lawns, and still on the wrong side
of H7's floor to call it the backbone's fault.

- **The interior column is the control and is not decoration.** Error
  concentrates at boundaries in every segmentation model ever built, so "the
  edge is worse than the middle" is a definition. Sharp against soft is the
  comparison with an answer in it.
- **It finds sharp edges, not driveways**, and hard-rimmed shade, not
  buildings. A result here is evidence for S8, never proof of it. The
  unambiguous version needs a real surface mask.
- **Ten points is still the bar** (H7). A small gap at 23 lawns is nothing.

Two faults were found and fixed while building it, both of which would have
produced a confident wrong table rather than an obvious bug — see the tests in
`tools/boundary.test.js`. The one worth knowing about: splitting cells by their
own gradient makes the median land in the flat ground either side of an edge,
so every real transition comes out "above median" and the sharp column quietly
means *is this a boundary at all*. That would have reported sharp boundaries as
carrying the error **on any lawn whatsoever**, and it would have looked exactly
like a confirmation of the theory it was built to test. Sharpness is now taken
as the peak within reach, so it is a property of a stretch of boundary rather
than of a cell.

### H14. The shade features helped the colour row 4.3 points — and not where aimed
*Run 35452491362, 2026-09-19, 896px, corpus `14a2t7k`. FEATURE_COUNT 11 → 14:
normalised excess green, regional brightness, relative brightness, and the
texture windows converted from pixels to metres.*

```
                            before   after
colour and texture only      32.9%   28.6%   -4.3   <- the target of all four changes
the pretrained eye only      28.2%   28.2%    0.0   <- reads no colour, cannot move
both                         34.6%   34.9%   +0.3
both, 96 numbers a patch     32.4%   31.9%   -0.5
colour, with surroundings    31.2%   37.0%   +5.8   <- WORSE, and unexplained
both, with surroundings      32.1%   33.6%   +1.5
```

**4.3 points is the largest single improvement the colour row has ever had
here.** It is also the row that matters least: the best of six is unchanged at
28.2%, because the winner reads no colour at all, and the gap to SAM is still
1.4×.

**The improvement is not where it was aimed**, which is the part to remember:

```
colour and texture only     before   after
sharp boundary               50.3%   48.0%   -2.3
soft boundary                37.3%   35.6%   -1.7
hard-rimmed shade            41.8%   38.2%   -3.6   <- the target
soft-rimmed shade            14.8%   19.6%   +4.8   <- worse
the middle of the lawn       28.3%   23.4%   -4.9   <- biggest gain, not a target
```

Hard shade did improve, by 3.6 points. But open lawn improved more, and soft
shade got worse. So these read as **better general colour features that happen
to help in shade**, not as the shadow fix they were designed as. Do not repeat
"the shadow features fixed shadows"; the table does not say that.

**NEW BASELINE: the control is 28.6%, not 32.9%.** Every run before
2026-09-19 used an 11-column vector. A table with a 32.9% control is from the
old features and is not comparable to one with 28.6%.

**And the two error columns are NOT the same pixels: the overlap is 7%.** That
was a real worry — both splits read one gradient map, so hard-rimmed shade
beside a driveway would be counted in both, and the table would report one
finding as two confirmations. Measured, they are separate ground. H12's two
halves stand as two findings.

### H13. Extraction usually reproduces exactly. One run in five did not.
*Five runs on corpus `14a2t7k`, 2026-09-19: 35411040880 and 35449083419 at
896px; 35417355609, 35422422911 and 35449091188 at 1280px.*

**THIS ENTRY HAS BEEN WRONG TWICE, and the way it was wrong is the useful
part.** It first said "backbone rows drift ±2.7 points", generalised from one
pair. Then it said "1280 does not reproduce, 896 does", generalised from two
more. A third 1280 run agreed with the first 1280 run *exactly* and killed that
story too. Two confident readings off small samples, both wrong, in one day —
which is H7's lesson arriving from a different direction.

What five runs actually show:

```
                          896 r1  896 r2 | 1280 r1  1280 r2  1280 r3
colour and texture only    32.9    32.9  |  32.9     32.9     32.9
the pretrained eye only    28.2    28.2  |  32.5     35.0     32.5
both                       34.6    34.6  |  33.2     35.9     33.2
both, 96 numbers a patch   32.4    32.4  |  31.5     32.2     31.5
both, with surroundings    32.1    32.1  |  26.1     26.4     26.1
colour, with surroundings  35.7  → 31.2  |  34.4     34.8   → 31.2
```

- **Four runs out of five reproduce their pair exactly**, to the decimal, on
  every row.
- **One run — 35422422911 — differed on every backbone row.** It is also the
  slow one: 39 minutes of extraction against 21, 22 and 16.5 for the others.
- The control is 32.9% in all five.
- `colour, with surroundings` moved only where the ring fix moved it, and now
  reads **31.2% at both sizes**, identical down to its whole class table. It is
  genuinely backbone-free at last, so size cannot touch it — which is the
  cleanest confirmation available that the fix does what it says.

**PROBABLE CAUSE, NOT ESTABLISHED:** a differently-provisioned runner. A
different core count changes the thread count, which changes the order of a
float reduction, which changes low bits that a 23-lawn leave-one-out amplifies.
The one anomalous run being the one that took twice as long fits that and
proves nothing. It is not size-specific — two 1280 runs agree perfectly.

**The rule that survives all three versions of this entry:** the control and
any genuinely backbone-free row are exact, so use them to confirm two tables
are comparable. For a backbone row, **a gap under about 3 points needs the
identical configuration run again before it means anything** — occasionally it
will come back different, and you cannot tell which kind of run you have
without a second one.

### H10. The backbone-free control is reproducible to the decimal
*Runs 35409315409 (672px), 35411040880 (896px), 35416318719 (workflow 12,
DINOv2 tiled 224px) and 35417355609 (1280px), all 23 lawns, fingerprint
`14a2t7k`.*

"Colour and texture only" came back at **32.9%** in all four — and a fifth time
in run 35422422911 — across two workflows, two languages and four backbone
settings, because none of them touch that row. The corpus, the split and the
seed are deterministic.

**This applies to the control ALONE.** H13 is the other half of it: every row
that touches the backbone drifts between identical runs. When this entry was
written it said "the corpus, the split and the seed are deterministic", which
is true, and it was easy to read as "the table is reproducible", which is not.

That is what makes H9's comparison valid, and it is the check to run first on
any future result: **if the control has moved, the corpus moved, and nothing
else in the table is comparable to anything before it** (H7).

It also bounds the noise claim usefully. H7's ±10 points is the cost of
CHANGING THE CORPUS, not run-to-run variance. At a fixed corpus this is exact.

### H8. Two maps dominated the error, and one was rejected for it
*DINOv2 run, 24 lawns.* An NC map measured **309.1% wrong** (SAM: 164.2%) — both
wildly over-predicting, which points at the map rather than the model. Rejected
by the owner on 2026-09-19.

A Kent map at **84.6% wrong** (SAM: 382.0%) was **kept deliberately**. The owner's
reasoning, which is the benchmark's whole value: *the majority of the property
is unambiguously woods, some of the lawn is ambiguous (shade and tree lines,
but not overhanging), and most of it is clearly lawn.* Being far too high or
too low there is a good read on real performance.

**Treat that Kent map as a benchmark, not as a problem to remove.**

---

## HARD FINDINGS — external, cited

### E1. Scale-MAE beats SatMAE on segmentation
By **0.9 mIoU**; ConvMAE by 1.3; vanilla MAE by 1.0. Same pretraining data
(fMoW-RGB), so there is no case for SatMAE over Scale-MAE.
[Scale-MAE, ICCV 2023](https://arxiv.org/pdf/2212.14532)

### E2. Scale-MAE is conditioned on ground sample distance
It is handed the ground distance a pixel covers and builds its position
encoding from it. Its advantage over SatMAE and ConvMAE **grows** as the GSD
departs from what it trained on. This is why it suits us despite H1, and why
the frame dump writes `scale.json` and the run refuses to guess.

### E3. Bigger receptive fields do NOT solve occlusion
*The published result on our exact problem — inferring what is under tree
canopy.* A U-Net gets **84% recall on unoccluded roads, 63.5% on roads under
canopy**. Architectures with much larger receptive fields barely differ
(DeepLabV3+ ResNet-50: 63.9%). Recall falls to **30–40%** for occluded pixels
furthest from anything visible.

> "Expanding receptive fields alone does not meaningfully enhance the ability
> to reason about hidden road segments. Models remain heavily biased toward
> local features."

[Seeing the roads through the trees](https://arxiv.org/html/2401.06762v1) ·
[ChesapeakeRSC](https://github.com/isaaccorley/chesapeakersc)

This is the independent corroboration of H4.

### E4. There is no free lawn model
Searched 2026-09-19. The turfgrass deep-learning literature is **ground-level**
weed detection in turf. Roboflow "lawn and grass" sets are ground photos.
[One paper](https://arxiv.org/abs/2004.10382) claims 94–97% on lawn measurement
but releases no dataset or model and does not state its imagery, so it is not a
benchmark. **Nothing off-the-shelf does residential lawn from the air.**

### E5. OAM-TCD is a tree model at exactly our resolution
Restor's tree crown delineation: **10 cm/px**, globally diverse OpenAerialMap
imagery, 5,072 tiles, 280k labelled trees. Per-pixel **tree / no-tree**. Open
weights: `restor/tcd-unet-r34`, `restor/tcd-unet-r50`. Loads with
`segmentation_models_pytorch` in three lines.
[dataset](https://arxiv.org/abs/2407.11743) ·
[model](https://huggingface.co/restor/tcd-unet-r34) ·
[pipeline](https://github.com/Restor-Foundation/tcd)

### E6. Licensing of the candidates
**DECIDED 2026-09-21: this tool is free to use and non-commercial.** The owner
had previously said non-commercial was *acceptable*; it is now the stated
position, which turns the rows below from a constraint into a settled fact.
Recorded because it is the sort of decision a later change of mind would have
to unpick deliberately rather than by accident.

| | licence | commercial? |
|---|---|---|
| Scale-MAE (torchgeo) | CC-BY-NC-4.0 | no |
| Restor TCD U-Nets | CC-BY-NC (CC-BY planned) | not yet |
| SatlasPretrain / NAIP | ODC-BY | yes |
| Chesapeake U-Net (torchgeo) | MIT | yes |
| **VGIN / CBP 1 m LULC (Virginia)** | **no re-distribution for profit** | **no** |

[TorchGeo weights](https://docs.torchgeo.org/en/stable/api/models.html)

### E7. Virginia publishes a 1 m land cover layer that names turf grass
*Looked up 2026-09-21, from VGIN's own dataset descriptions.*

Produced by the **Chesapeake Conservancy** with the **University of Vermont
Spatial Analysis Laboratory** and **USGS**, under a six-year EPA cooperative
agreement for the Chesapeake Bay Program; extended to the 33 Virginia
localities outside the Bay watershed by Virginia DEQ. One metre, **56 classes**,
all 133 counties and independent cities, for 2014 and 2021.

The input is **NAIP imagery** for the 2014 and 2021 editions, and VBMP
orthophotography for 2016.

Two of its classes are the thing this project is trying to measure:

    Turf Grass
    Tree Canopy over Turf Grass

The second is our inferred-areas question, answered at scale by somebody else:
what is underneath a canopy you cannot see through. H6 puts marked inferred
ground at 3% of a typical map here, and E3 is the published finding that wider
receptive fields do not solve occlusion.

**Resolution is the catch and it is not small.** H1 puts our imagery at 5-38 cm,
typically 10-15 cm. This is 1 m: seven to ten times coarser, on a boundary
problem where H9 showed resolution is a real lever. A 1 m label cannot place
the grass/driveway edge better than about a metre, and H7 warns that
*directional* error does not average out the way scattered error does.

Nothing has been measured against it. It is not in the corpus and should not
go in one without the resolution mismatch being handled deliberately.

**VGIN's copy is a picture. The Conservancy's copy is a database.**
*Checked 2026-09-21 against both services.* This entry said "nothing can ask
it what class a point is", and that was a fact about one service stated as a
fact about the data. VGIN serves it at

    .../VA_Base_Layers/VA_Land_Cover_Land_Use_2021/MapServer

as a `singleFusedMapCache` with capabilities `Map` and nothing else: no
identify, no query, JPEG tiles to level 17 and HTTP 500 above that, and a
`legend` endpoint that answers HTML. All true, and all beside the point,
because the people who made the data publish it themselves as an ImageServer:

    https://cicgis.org/arcgis/rest/services/LULC/bay_lu_tif/ImageServer

`identify` returns the raw class number at 1 m. `rasterAttributeTable` returns
all **54 classes** with their codes, names and palette. The two that matter:

    28   code 2210   Turf Grass
    27   code 2240   Tree Canopy over Turf Grass

*Measured on a 7x7 grid over a Midlothian, VA suburb:* turf, canopy-over-turf,
structures, roads and driveways all separate cleanly on a single house lot.

**And it will render the mask server-side.** `exportImage` accepts a `Remap`
rendering rule, so one request returns a PNG in which turf and canopy-over-turf
are white and everything else is nothing:

    renderingRule={"rasterFunction":"Remap","rasterFunctionArguments":
      {"InputRanges":[27,29],"OutputValues":[255],"AllowUnmatched":false}}

*Measured:* 256x256 over that same suburb comes back 8-bit, 27% white. That is
the same shape of thing SAM returns, which is the whole reason this matters --
`maskToPolygons` in public/lib/mask.js already turns exactly this into
polygons.

**Coverage is wider than Virginia and narrower than the country.** Probed
point by point: Virginia Beach, Roanoke, Washington DC, Baltimore, Harrisburg,
Binghamton NY and Wilmington DE all return data; Bristol in far south-west
Virginia and Charleston WV return NoData. So it is the Bay watershed plus
adjacent counties, across six states and DC. The gaps in VA, WV and PA are
filled by a separate EPA Region 3 dataset built to the same classification --
not checked, and not the same endpoint.

**How they decided what is under a canopy, which is the interesting part.**
*From the Bay Program's own classification methods document, read properly on
2026-09-21 after two wrong summaries of it.* The first guess was "canopy on
developed land not over a road or a building". The second repeated it. The
third said "a 60 ft distance rule", which is a real number from the document
and still not how the classification works. The owner pushed back both times,
correctly. The actual scheme, quoted:

> **Tree Canopy over Turf Grass (TCTG)** = Tree cover within **30-ft** of
> structures or adjacent turf grass and other impervious **in rural wooded
> areas** and within **60-ft** of structures or adjacent turf grass and other
> impervious **in developed areas. Developed areas include U.S. Census Bureau
> defined urban areas and clusters. Rural areas include all lands outside
> Census urban areas and clusters.** The understory in all TCTG areas is
> assumed to be turf grass or otherwise altered through compaction, removal of
> surface organic material, and/or fertilization.

> **41 Forest (>= 1 acre, 240-ft width)** ... 2. If the patch is at least an
> acre in area and has a width of at least 72 meters, it is forest.
> **3. Remove areas that are Tree Canopy over Turf Grass.**

> **42 Other Tree Canopy** ... All tree canopy that does not meet the forest
> metrics. For patches of tree canopy surrounded by agriculture, this class
> takes priority over [tree cano]py over turf grass.

**THE ORDER IS THE PART THAT MATTERS, AND IT IS THE OPPOSITE OF WHAT THIS
ENTRY SAID.** Forest is not a category that wins and leaves the leftovers to
TCTG. Forest is computed as a size-and-girth test on the whole canopy layer --
one acre and 240 ft wide somewhere in the patch -- and then **TCTG is
subtracted from it**. Canopy near a house is taken OUT of the forest it is
part of.

And TCTG is parcel-scoped, not a free-floating distance from any building:

> Decision rules were created and applied to three unique and mutually
> exclusive parcel types: agricultural, densely developed, and less densely
> developed. ... Densely developed parcels contain a structure and are within
> Census Urban Areas and Clusters. Less-densely developed parcels are
> represented by all remaining parcels **with a structure**.

So a parcel with no structure on it is not eligible for TCTG at all.

**AND HERE IS WHERE IT ACTUALLY COMES FROM.** The numbered steps were missing
from three earlier readings of this document because twenty of its text runs
are in a subset CID font -- hex strings whose codes are ASCII minus 29 -- and
every plain-text extractor silently drops them, leaving sentences like "Buffer
and and sharing boundary of". Decoded, in full:

> **2. For agricultural parcels:** Buffer "Structures" and "Other Impervious"
> and "Turf Grass" sharing boundary of "Structure" parcel segments by **10
> meters**. Reclassify "Tree Canopy" *that is not surrounded by agriculture*
> within the buffer as "Tree Canopy over Turf Grass".
>
> **3. For densely developed parcels:** Buffer "Structures" and "Other
> Impervious" and "Turf Grass" sharing boundary of "Structure" parcel segments
> by **20 meters**. Classify any "Tree Canopy" within the buffer as "Tree
> Canopy over Turf Grass".
>
> **4. For less densely developed parcels:** ... by **10 meters**. Classify any
> "Tree Canopy" within the buffer as "Tree Canopy over Turf Grass".

So: 20 m inside Census urban areas, 10 m outside. Those are the 60 ft and 30 ft
of the definitions table, rounded.

**THE SEED IS NOT THE HOUSE.** It is structures AND other impervious AND turf
grass -- the already-classified lawn is itself a seed. So the collar is 20 m
from the nearest lawn, paving or building edge, not 20 m from the building.
Every earlier summary in this file said or implied the latter, and on a lot
with a deep lawn that is a materially different and much larger region. It is
a single pass, so it does not chain outwards for ever; it does mean the reach
past the house is roughly the lawn's own extent plus 20 m.

Turf grass itself is parcel-scoped the same way: *"all low vegetation within
small, developed parcels (<= 5 acre and contains >= 55 m2 of impervious
surface)"*, plus named land uses -- golf courses, cemeteries, sports complexes,
shopping centres, airports, hospitals.

**TCTG IS THE RESIDUAL, WHICH IS WHY THE MULCH BED IS THE PROBLEM.** It is not
"everything under a tree is turf". Canopy over roads, structures and other
impervious gets its own three classes (24, 25, 26), and all three are
*"directly mapped in the land cover data"* -- so where something underneath was
independently known, from LiDAR or from a road or footprint layer, the canopy
is labelled by it. Class 27 is what is left: canopy near the house with nothing
known underneath. "Assumed to be turf grass" is the document's own word for
that residual.

So the things it gets wrong are the things no ancillary layer names. A mulch
ring round a tree, a foundation bed under overhanging branches, ivy, gravel,
bare dirt -- all class 27, all counted by us as lawn. And that is not a rare
corner: a mulch bed under a canopy near the house is where mulch actually
goes, so the error sits exactly on top of its own worst case.

Plain Turf Grass (28) does not have this problem in the same way -- it is low
vegetation, so an OPEN mulch bed is barren rather than turf. The fault is
specific to mulch under canopy.

**WHICH EDITION THIS DESCRIBES.** The document is the 2017/18 classification
methods. The raster this app reads is the 2021/22 edition, and whether these
distances were retuned for it has not been checked. Treat 10/20 m as the
mechanism, confirmed, and as the current numbers, unconfirmed.

**WHAT THIS PREDICTS FOR US, and it is testable.** On a wooded lot inside a
Census urban area, a **20 m collar around the lawn and buildings is cut out of
the woods and called lawn** -- whatever is actually growing under it. That is a
one-directional over-call, on exactly the lots where H8's Kent benchmark says
this project is already weakest, and H7 warns that directional error does not
average out. It is the first thing to look for when comparing this source
against a traced map, and nothing here has measured it yet.

The honest summary of the whole scheme: nothing sees under the tree. Size
decides forest, a structure on the parcel decides eligibility, and a buffer
decides the rest. It is the same inference our tracers make, done
systematically -- and its mistakes will be systematic too, which is worse than
scattered ones for the same average error.

The other route is VGIN's download application, which hands out the raster by
locality. That suits building a training batch in CI. It does not suit asking
a question about one address while somebody waits.

### E8. Hyperspectral + LiDAR gets 99% on urban grass — and never looks under a tree
*[Man, Dong, Yang, Wu & Han, "Automatic Extraction of Grasses and Individual
Trees in Urban Areas Based on Airborne Hyperspectral and LiDAR Data", Remote
Sensing 12(17):2725, 2020](https://doi.org/10.3390/rs12172725). Read in full
2026-09-22, brought by the owner as a possible answer to grass under canopy.*

**It is not about grass under canopy, and the word that makes it look as though
it is means something else.** The abstract's selling point is that point-cloud
segmentation "can preserve the understory trees" where a canopy-height-model
watershed loses them — **understory TREES**, small trees beneath larger ones.
Occluded ground is not discussed anywhere in the paper. Its grass class is
grass visible from above.

What it actually is: 144 hyperspectral bands (380–1050 nm, 4.8 nm) at **2.5 m**
ground resolution, plus airborne LiDAR, random-forest and object-based
classification for the 2D map, then watershed-on-CHM against point-cloud
clustering for individual trees.

**Do not quote its 99%.** It is validation-sample accuracy for visible classes
on one controlled site. And 2.5 m is twenty times coarser than our 10–15 cm
(H1), on a problem where H9 says resolution is a real lever and H12 says the
error is concentrated at boundaries.

**The one transferable idea, and it is the paper's ingredient rather than its
method: LiDAR is the only instrument here that receives anything from beneath
a canopy.** Pulses find gaps and return from the ground. Everything this file
has considered so far INFERS what is under a tree — E3 says receptive fields
cannot, E7's Chesapeake class is a 20 m buffer rule whose own document says the
understory "is assumed to be turf grass", and our tracers use their judgement.
A ground return is the first thing that would MEASURE it.

**What that would and would not buy, stated before anybody gets excited.**
LiDAR gives height, not species. It separates bare ground and mulch (~0 cm)
from shrubs and small trees (0.5–2 m). **It does not separate grass from
mulch, gravel or bare dirt** — which is precisely the failure mode E7 records
for the Chesapeake layer. So on its own it answers the owner's second reading
of H12 ("some obvious trees are fully marked as lawn — this is obviously a
tree") and does not answer "is the ground under this canopy lawn".

**WHAT IS AVAILABLE TO US, probed against the live services on 2026-09-22 —
these are our own checks, not the paper's claims:**

- **USGS 3DEP publishes exactly one dynamic service, and it is BARE EARTH.**
  `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer`
  — F32, single band, `identify` and `exportImage` both work, the same shape of
  endpoint as E7's land cover service. Ground elevation answered at all four
  corpus regions tested: Kent MI 253.6 m, Prince William VA 85.9 m, NC 109.5 m,
  Bullitt KY 142.2 m. The service directory holds `3DEPElevation` and nothing
  else, so **there is no DSM and no canopy height model behind a URL.** Bare
  earth alone says nothing about trees.
- **So a canopy height model needs the point cloud.** The public Entwine copy
  is live: `usgs-lidar-public` on S3, 1,000+ projects, and the per-project
  footprints are published as
  [`resources.geojson`](https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson)
  (8.7 MB, fetched). EPT is an octree, so a reader can pull just the nodes over
  one 60 m frame rather than a county.
- **Specification facts, cited:** 3DEP's minimum is QL2 — [≥2 pulses/m² and ≥3
  returns per pulse](https://www.usgs.gov/ngp-standards-and-specifications/lidar-base-specification-collection-requirements),
  with [QL1/QL0 at 8 pulses/m²](https://www.usgs.gov/3d-elevation-program/topographic-data-quality-levels-qls)
  — and **leaf-off is the collection standard**, which is also the honest
  answer to the leaf-off question asked on 2026-09-21: there is no leaf-off
  *imagery* source, but the structure is flown leaf-off as a rule.
- **The cost is the tooling.** `pip install pdal` is a source distribution
  needing libpdal, so a CI job would install PDAL from apt first. Not verified
  on a runner. Nothing else here needs a new dependency.

**Two mismatches to settle before any of it is worth a feature column:** the
LiDAR year against the photograph's year — trees grow and get felled — and the
1 m posting against our 10–15 cm. Neither is fatal and neither has been
measured.

---

## SPECULATION — theories not yet tested

Marked so they are not later quoted as findings.

### ~~S1. Resolution mismatch is what caps Scale-MAE~~ — CONFIRMED, now H9
Tested 2026-09-19 and **supported**: 672px → 896px improved the eye-only row by
8.2 points against an unchanged control. Promoted to H9.

The open part is now closed too, and the answer is no: **1280px, the frames'
own size, moved the eye-only row 4.3 points back to 32.5%** (run 35417355609).
The gain does not continue past 896. Whatever resolution mismatch was being
relieved at 896 is over-corrected at native size — so this was a mismatch to
tune, not a ceiling to remove.

Worth noticing before repeating the original reasoning anywhere: that reasoning
predicted native size would be best, and it was not.

### S7. Why does colour HURT once the eye is good?
H9's second finding, unexplained. At 672px "both" beat the eye alone; at 896px
the eye alone beats every combination.

Candidates, none tested:
- **Dimensionality.** More features against 23 lawns, so the extra columns fit
  noise. Would predict that the gap narrows as the corpus grows.
- **The squeeze.** Colour is 11 raw numbers; the eye is projected down to 32 or
  96. Mixing raw and projected features may be scaling them badly against each
  other.
- **Redundancy.** A backbone reading this well may already encode what colour
  says, so colour adds only its failure mode — shadow.

Worth resolving, because it decides whether the published model should carry
colour at all.

**Update, 1280px run 35417355609: the effect did not survive the next size.**
There the combinations are back in line with the eye alone (eye 32.5%, both
33.2%, both+96 31.5%) and the best row of all is a combination *with* the ring
at 26.1%. So "colour hurts a good eye" was a description of one column of one
run, not a property of good eyes. Keep the question — the 896 numbers are real
— but do not carry the sentence forward as a finding.

### S2. A tree mask would help more than another backbone
E5 gives a tree/no-tree probability per pixel at our resolution. Our biggest
confusion is woods vs lawn — H8's Kent benchmark is mostly woods. Feeding tree
probability as a feature might do what the ring failed to do: supply context,
but *learned and at the right scale* rather than raw colour samples.
**Untested, and the ring's failure is a reason for caution, not confidence.**

**A SECOND WAY TO GET THE SAME COLUMN, from E8: height above ground, from
3DEP's point cloud.** Restor's model INFERS tree from pixels; a LiDAR canopy
height model MEASURES it, and is not fooled by the dark green that catches a
colour feature. On the owner's own reading of the outlines — "some obvious
trees are fully marked as lawn" — that is the complaint both would address.

**And the sharper version of it, which is the part actually worth testing:**
the interesting number under a canopy may not be the canopy height at all, but
**how many pulses reached the ground there, and how high the lowest returns
sit**. Ground-return density is literally "how much of the ground the laser
saw"; a lowest-return height near zero is bare ground, mulch or grass, and half
a metre up is a shrub. That would put a *measurement* where this project
currently has an inference — but it still cannot tell grass from mulch (E8), so
it prunes the wrong answers rather than producing the right one.

**Untested, and everything above the last paragraph is a mechanism rather than
a result.** Two ideas in this file have been argued at length and then measured
as nothing.

### S3. The corpus, not the features, is the binding constraint
H7 says one map is worth up to 10 points; the gap to SAM is about 6 points.
That is suspicious. **Untested** — the crossover point is unknown, and "more
data will fix it" is the most over-claimed sentence in machine learning.

If it is true, it is now also **the only route open**, because H11 closed the
other one: the model cannot help build the corpus until it beats SAM, and it
needs the corpus to beat SAM. So the corpus grows by hand or not at all, and
anything that makes hand-tracing faster is worth as much as a backbone.

### S4. The inferred column needs far more marked ground to be readable
H6 puts it at 3% of a typical map. **Untested.** It is not known how much
marking is enough.

### S5. The shade/sun split may currently be noise
Under DINOv2 every configuration was *better* in shade, which is implausible.
Under Scale-MAE at 672px the signs were mixed. At 896px **four of six
configurations are again "better in shade"**, including colour-only, which
cannot be reading anything but brightness.

Three runs, no stable story, and one reading that is close to impossible.
**Treat the shade/sun columns as unreliable until investigated.** Not
investigated.

**Fourth run, 31 lawns, 2026-09-22: FIVE of six configurations are "better in
shade", and colour-only by 17.6 points.** That row reads eleven colour and
three texture numbers and nothing else; a model that were reading brightness
cannot be 17.6 points better where it is dark. The run prints "so whatever it
is reading, it is not brightness" five times, which is the advice being
confidently wrong five times (rule 6).

This is now the most likely-broken thing in the toolchain. The split is almost
certainly not measuring shade — a candidate worth one hour: `darkPct` and
`brightPct` are medians over lawns, and if the threshold lands such that "in
shade" is mostly a few tiny well-lit lawns, the column is measuring lot size.
**Still not investigated**, and four runs of an impossible reading is enough to
stop printing a conclusion beside it.

### S8. Split the job by what the camera can see
*The owner's proposal, 2026-09-21. Written down as a proposal.*

High resolution RGB and hand-traced maps handle the ground that is visible;
a coarse multispectral source handles the ground that is not. Do not ask one
model to do both, because the two halves fail for different reasons: the
visible half is a boundary problem where H9 says resolution decides, and the
hidden half is an inference problem where E3 says architecture does not.

What makes it worth testing rather than just plausible: E7's layer names
"Tree Canopy over Turf Grass" as its own class, so somebody has already
produced the hidden half at scale, and its 1 m resolution costs far less on
ground nobody can see the edges of anyway.

Three things to settle before any of it is a finding, none of them settled:

1. Whether "Tree Canopy over Turf Grass" means what this project means by
   inferred lawn. E7 now answers most of this from the published method, and
   the answer is that they are closer than this entry first assumed: both are
   inferences about ground nobody can see, and neither sees through the tree.
   Theirs is systematic and ours is by eye, so expect theirs to be steadier
   and ours to catch the mulch bed under the canopy. What is left to settle
   is the disagreement RATE, which a handful of Virginia lots would give.
2. What it would be worth. H6 puts marked inferred ground at 3% of a typical
   map and H7 puts the noise floor at up to 10 points, so on the headline
   number this cannot show up. If it pays, it pays as a tracing aid — and
   S3 argues that is worth as much as a backbone — or as a Virginia-sized
   batch of training labels. Not as a better inferred column.
3. ~~How to read the layer at all.~~ **Settled.** The Conservancy's own
   ImageServer answers identify per pixel and will render the two-class mask
   server-side. See E7.

**Untested.** Nothing here has been measured, and the two ideas this file has
argued at length and then measured as nothing (H4's ring, E3's receptive
fields) were both more obviously right than this one.

---

## Rules for running and reading these experiments

1. **Check the fingerprint and lawn count first.** Two tables from two corpora
   are not comparable (H7).
2. **Use a backbone-free row as the control** when the corpus has changed.
3. **Do not trust a difference under about 10 points** at this corpus size —
   and for any row using the backbone, re-run the identical configuration
   before believing a gap under 3 points at all (H13).
4. **Keep the Kent benchmark** (H8). It is the hard case on purpose.
5. **What /predictions.html shows is the TRACE, and it answers a different
   question from the table.** The table asks how accurate the model is. The
   pictures ask whether a person could fix its outline faster than drawing one
   — which is the question that decides whether a not-yet-good model can start
   doing the tracing and make the corpus grow faster (S3). Those two can
   disagree completely: 30% wrong in one clean sweep is two brush strokes,
   while 15% wrong as a hundred crumbs along every boundary is worse than an
   empty map. So read the **piece and handle counts** beside each picture, not
   only the error figure. The outline is drawn with the app's own tracer
   settings (`TRACE_TOLERANCE_M`, `MAX_TRACE_VERTICES` in `public/lib/mask.js`)
   so it is the shape the drawing tools would actually receive, and the scraps
   the tracer binned are reported because they are invisible by definition.

   Before 2026-09-19 these pictures were a disagreement map — red for missed,
   orange for over-called. That answered the accuracy question the table
   already answers, and could not answer the editing one at all.

   **Since 2026-09-22 the page shows BOTH, and every run keeps its own
   folder.** The button at the top flips every picture between the traced
   shapes and the model's raw per-pixel answer, which is where the tracer's
   smoothing, hole-filling and speckle removal actually show — `filledSqFt`
   and `trimmedSqFt` say how much that was worth, and only the flip says
   where. Runs no longer overwrite each other: each writes to
   `runs/<date>-<time>-<zone>-<model>/` and appears in the picker with the
   sentence whoever started it typed about what it was testing. The old flat
   `predictions/` and `crowns/` sets are still served, so the links in the
   run log above keep working.

   **Which object each number describes, because they are not the same
   object.** The per-lawn figures under a picture are measured on the TRACED
   OUTLINE; the `% out` pill is the run's own figure, from the raw mask, so it
   still matches the training table. They can differ a lot: the tracer fills
   any hole below 0.15% of the frame — **about 60 sq ft on a typical lot** —
   so a scatter of pinholes in the mask is simply absent from the polygon.
   This was found by a reader comparing a caption that said "it missed 17.8%
   of the inferred ground" with a picture whose outline covered that ground
   completely. Both were right. Each row now also says how much the tracer
   filled in and shaved off, so a tidied outline cannot flatter the model
   silently.
6. **The advice printed at the end of the run is code, and code can be stale.**
   It once explained a Scale-MAE result with a sentence about models trained on
   ground-level photographs — true of DINOv2, false of what had run, and it
   recommended as the next step the thing the run had just done. Fixed on
   2026-09-19, but read the advice as a helper, not as an oracle.

---

## Run log

| date | run | corpus | backbone | best | SAM | note |
|---|---|---|---|---|---|---|
| 2026-09-18 | 35404198905 | 24 | DINOv2 tiled 224px | 34.0% | 21.6% | ring first measured, negative |
| 2026-09-19 | 35409315409 | 23 | Scale-MAE large 672px | 30.9% | 20.3% | eye-vs-colour gap 14.0 -> 3.5 |
| 2026-09-19 | 35411040880 | 23 | Scale-MAE large 896px | **28.2%** | 20.3% | S1 confirmed; control identical, eye-only -8.2; combined rows worse (S7) |
| 2026-09-19 | 35416318719 | 23 | DINOv2 tiled 224px | 32.9% | 20.3% | control reproduced a third time (H10); first outline rendering, drawn from the **colour-only** row since that won here |
| 2026-09-19 | 35417355609 | 23 | Scale-MAE large 1280px | **26.1%** | 20.3% | best ever; ring +7.1 (H4); eye alone REGRESSED 28.2 -> 32.5, so 896 is the peak for it (H9); beat SAM on 8 of 19 |
| 2026-09-19 | 35422422911 | 23 | Scale-MAE large 1280px | 26.4% | 20.3% | repeat of the above: control exact, every backbone row moved (H13). First "where the error lives" table — H12 confirmed, S8's blame on the backbone not supported |
| 2026-09-19 | 35449083419 | 23 | Scale-MAE large 896px | 28.2% | 20.3% | ring fix. Every row identical to the earlier 896 run except the one the fix touches (35.7 → **31.2**) |
| 2026-09-19 | 35449091188 | 23 | Scale-MAE large 1280px | **26.1%** | 20.3% | ring fix. Matches 1280 run 1 exactly on every backbone row, so run 35422422911 was the anomaly, not 1280 (H13 revised again). Colour-only ring now 31.2% at BOTH sizes |
| 2026-09-19 | 35452491362 | 23 | Scale-MAE large 896px | 28.2% | 20.3% | **14-column features** (H14). Colour row 32.9 → 28.6, its biggest gain ever, but the best of six does not move and the gap stays 1.4×. Control baseline is now 28.6%. Last run before the pause |
| 2026-09-22 | 35719107798 | 31 | Scale-MAE large 896px | 34.4% | 23.8% | **Seen-only twins** (H17). Dropping unseen ground from TRAINING improves the visible half by 2.1-3.5 points on 4 of 6 rows; best seen error 33.5 -> 31.3. The backbone-free row's -3.5 is deterministic within the run, so not re-run noise. Headline unchanged: a seen-only model answers half the question |
| 2026-09-22 | 35716717308 | 31 | — (workflow 17, no training) | — | — | **Lidar coverage, phase one of E8.** 29 of 31 lawns over a 3DEP project, flown 2011-2020, middle year 2016, none below QL2. The 2 misses are a real gap in Maryland, checked against an 88%-covered state grid. Verdict: build phase two. The unmeasurable risk is the 10-year gap to the photographs (H16) |
| 2026-09-22 | 35683684006 | **31** | Scale-MAE large 896px | 34.4% | 23.8% | **NEW CORPUS `1wxlejo`** — work restarted. Control 28.6 → 37.8, so nothing compares to the rows above (H15). Gap 1.39× → 1.45×, wins flat at 10 of 25. Winner changed to "both"; top three within 0.5 points. H12 reproduced on a second corpus, ring negative again, S5 worse than ever. Baseline confirmed all `sam3`. 31 of 31 outlines drawn to /predictions.html |
| 2026-09-22 | 35764574338 | **33** | — (workflow 19, no training) | — | — | **Tree crowns (H18).** `restor/tcd-segformer-mit-b5` at 0.1 m/px over 33 approved maps, 18 min CPU, nothing bought. Crowns per lawn 0-63, middle 9; middle 6 of them big enough to tap. Crown area on traced lawn 0-51%, middle 7% — **not interpretable yet**, because `insidePct` (crown inside the property line at all) is not summarised, so "the tracer said no" and "it is a neighbour's tree" are not separated. Tappability collapses on the busiest lawns: 1 of 28, 2 of 39. Pictures at /predictions.html?set=crowns |
| 2026-09-22 | 35781727027 | 33 | — (workflow 19, no training) | — | — | **Crowns again, into the first dated run folder** (`2026-09-22-1659-edt-restor-tcd-segformer-mit-b5`). Same model and settings as 35764574338, so the crown numbers are identical — the point was the two things the last run could not do. **Settles the H18 caveat:** only 32% of crown area is inside the property line (0-69%), 9 of 33 lawns are mostly OFF the property and just 2 are in the "tracer declined these trees" quadrant. The 7% on-lawn figure was measured mostly over neighbours' trees. Also the first run with a raw-mask picture per lawn, so a 63-crown lawn can be checked against the raster it was split from |
| 2026-09-23 | — | 33 | — (no run; arithmetic over the code) | — | — | **H20, and H18 half retracted.** The crown counts were measurements of our own watershed's gap parameter, not of trees — `tcd-segformer` is semantic and has no notion of where one tree ends. `onLawnPct`/`insidePct` survive and the 32%-inside result stands. The watershed is removed; the tool reports canopy plus contiguous patches, which are not trees. Separately: `FRAME_SIZE=640` @2x means every stored photograph is 1280px whatever the lot, so **above 102 m across the canopy model is fed upsampled pixels** — 11 of 32 lawns in the last run. The `DUMP_SIZE=1024` resize is free waste on top of that |
| 2026-09-23 | 35809715707 | 33 | — (workflow 19, no training) | — | — | **First canopy run, no watershed, `DUMP_SIZE=1280`.** Folder `2026-09-22-2236-edt-restor-tcd-segformer-mit-b5`. **H20 confirmed:** upsampled lawns 11 of 32 → **6 of 33**, worst 2.3× → **1.6×**, exactly the five lawns the arithmetic predicted. **H20's Bullitt County guess refuted:** those three are no longer upsampled and still return 0 canopy, so resolution is not what ails them. Patches per lawn 0–47, middle 6. Canopy on traced lawn 0–51% **middle 20%** (was 7%); inside the property line 0–73% **middle 44%** (was 32%). **Those two shifts are NOT attributable** — the watershed was removed and the resolution changed in the same run, so this is exactly the two-variables-at-once the rules forbid reading. A decomposition run (this code at `DUMP_SIZE=1024`) would separate them for ~20 min of free CI |
| 2026-09-23 | 35813325014 | 12 | — (workflow 20, no training) | — | — | **The other half of H20, answered.** Each of the 12 biggest lots fetched at 640/1280/2560 px and asked where its detail stops being real. **8 have real imagery at 2560 we are not requesting**, 0 top out at 1280, **2 are already stretched at 1280** (the Bullitt pair, 0.047 → 0.019), 2 are flat ground. Bytes per pixel 1.01× agrees independently. So: raise the stored frame **per lawn**, not globally — four times the R2 bytes buys nothing on 4 of 12. Confirms the owner's point that resolution is a fact about the address, so H20's 128 m crossover is a best case rather than a rule. Weakest calls: 4 of the 8 sit just above the noise floor |
| 2026-09-23 | 35812991329, 35813325014 | 12 | — (workflow 20) | — | — | **BOTH VOID, retracted same day.** The probe varied the static API's `size` at a FIXED zoom, but ground per returned pixel depends on the zoom alone — at z19, sizes 320/640/1280 all return 5.47 cm/px covering 35/70/140 m. So it compared three different-sized crops at one resolution and read the differences as detail. Every figure is withdrawn, including "8 of 12 have detail we are not asking for" and "2 are already stretched at 1280". The tests passed throughout: they cover the residual measure and the labelling, and both were right — neither knows what images it is handed. Fixed by moving zoom and size together; not yet re-run |
| 2026-09-23 | 35848980523 | 12 | — (workflow 20, corrected) | — | — | **The other half of H20: a bigger request will NOT fix it.** Zoom and size moved together this time, so each step really is the same lot at twice the resolution. Detail falls at every step up on every lawn (Kent 197 m: 0.246 → 0.164 → 0.062), which is what running out of native imagery looks like; bytes per pixel one step up is 0.65×, agreeing independently. **8 of 12 are already at Mapbox's ceiling, 2 have a little more, 1 is already stretched, 1 is flat.** So closing H20 needs different imagery — NAIP or a county orthophoto service — and the 33 banked photographs are probably not worth refetching. **Caveat:** no control for what a genuinely native zoom step scores under this measure, so the ordering is solid and the absolute counts are provisional |
| 2026-09-23 | — | — | — (no run; a capture fix) | — | — | **H20 fixed at the source.** The banked photograph's resolution was a side effect of lot size, because `zoomToFit` fits the parcel into a fixed 640 logical px. `captureFrame` now pins resolution and varies size: 10 cm/px or better wherever one request reaches it, never coarser than before, `capped` flagged past ~256 m where Mapbox's 1280-logical limit bites. 172 m lot 13.4 → 10.0 cm/px; 319 m lot 24.9 → 12.5. Small lots keep the finer imagery they already got free. `corpus.image_frame` stores the frame the picture was taken on, so ground size is exact arithmetic rather than inference. **Applies to newly banked photographs only** — the 33 existing rows keep their old frames and the readers fall back to `frame` for them |
| 2026-09-23 | 35866737322 | 32 | — (workflow 19, no training) | — | — | **The H20 test, and the prediction held exactly.** Run started with a falsifiable claim in its own description: the canopy should move on the re-banked lawns and nowhere else. **Six lawns changed — precisely the six flagged UPSAMPLED last run — and 26 are byte-identical.** Log ends "No lawn was upsampled: every frame was at or finer than 10 cm". On-lawn share rose on five of six, fell 0.7 on one, all by 1–3 points: the right direction, at a size H7 says not to trust alone. Establishes the causal chain, NOT that the canopy is better — there is no canopy truth to score against, so the pictures decide. Note: 33 approved maps became 32 between runs, unexplained; workflow 21 touches no status, so most likely a map re-finished in between |
