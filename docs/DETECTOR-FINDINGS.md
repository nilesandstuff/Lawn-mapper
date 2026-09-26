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

## Where things stand — for whoever opens this next

*Kept current so a fresh session can pick up without the conversation that
got here. Update it whenever the in-flight run changes.*

- **The pictures were the same picture (found 2026-09-25, after H39).**
  Every run from H33 on drew its pictures for the lowest median, "canopy
  everywhere + stage 3, span", which is deterministic (H36), so the owner
  was shown the same drawings run after run while the row under test was
  never drawn. Fixed: a run draws THE PLAN's row (`PLAN_ROW` in
  tools/train-detector.js) when it scored it, and the picker names the row
  each run drew. Runs before the fix are unchanged on the page.
- **Pictures of THE PLAN's row are up (2026-09-26):** `runs/2026-09-25-2152-edt-scalemae-large-896px`, the first drawn for the row actually adopted.
- **In flight (2026-09-26, after H47): S11, the fused inputs** — workflow 14,
  `canopy: compare`, `decoder: fused`, benchmark. Write it up as H48. **The
  baseline** is run 36263512588 on the same 32 (THE PLAN's row 26.6%, seen
  22.2%, inferred 28.5%, in shade 24.8%; the plan's decoder alone 29.8%, seen
  24.3%). **The bar, written before the run:** THE PLAN's row with fused
  inputs reads **24.6% or better (two points, twice the seed's one, H28)**
  with more benchmark lots better than worse; below that it is noise and not
  adopted. Read also, because this is where it should act: the seen column,
  the in-shade column, B06 and Kent 8,626 (roofs), B12 (the pond), B04 and
  B23 (shadow), and whether the lidar veto still takes anything. Prediction:
  better on the seen column and the roof/pond lots, little change under the
  trees; an honest chance it reads worse at 31 training lawns.
- **Nothing in flight (2026-09-26, after H47).** Telling woods from lawn
  trees PASSES its bar for the first time, per crown segment and with the
  detector's own lawn edge (H47): "no visible lawn on the segment's border"
  finds 85.0% of the woods canopy for 7.5% of the lawn under canopy. That is
  a measurement, not a pipeline row: stage 3 already reasons from the lawn
  edge (span, reach), so how much of this it already gets is unknown. **Next:
  the row** — stage 3 over the plan's decoder with segments that fail the
  rule taken out of the canopy it may refill, scored on the 32.
- **Before that (2026-09-26, after H46).** NAIP-CHM is closed as a canopy (H42, H43, H45); telling woods from lawn trees is closed at the clump level (H35, H36, H37, H46) — the lawn border separates clumps (AUC 0.16) but joined clumps make any clump rule cost a third of the lawn. Open: the per-crown unit (SPECULATION, H46). More maps helped more lots
  than they hurt (15 against 8 on the benchmark lots) and fixed Utah, but
  broke Island County and did not fix the pond. Open: the owner's look at
  B04 and B03 in the layered pictures of the 44-lawn run; S9 (tree count per
  clump) and S10 (small things in the open against the detector's own false
  lawn), both on `lawns: all`; and whether to refreeze a larger benchmark.
- **Pictures of THE PLAN's row are up (2026-09-26):** `runs/2026-09-25-2152-edt-scalemae-large-896px`, the first drawn for the row actually adopted.
- **In flight (2026-09-26, after H43): workflow 14 on `lawns: all`** (write it up as H44) — the
  32 and the 20-odd maps approved since, NOT comparable with any benchmark
  table. What it is for: the owner's point that the pond (B12), the roofs
  (B06) and the shadowed grass (B23) should yield to more training data —
  read B12, B06, B23, B09 and B04 lot by lot against their benchmark
  figures, and the layered pictures of THE PLAN's row.
- **Pictures of THE PLAN's row are up (2026-09-26):** `runs/2026-09-25-2152-edt-scalemae-large-896px`, the first drawn for the row actually adopted.
- **In flight (2026-09-26): workflow 14, `canopy: compare`, benchmark,
  with the "lidar ∩ NAIP canopy" row** — THE PLAN's row with stage 3 over the
  tree model's canopy plus the cells the lidar and NAIP-CHM (cover) both call
  canopy, NAIP alone on the three lots with no lidar. Stage 3 only: training
  and scoring still use the tree model's canopy. The log prints the canopy
  added (m², and how much over the tracer's lawn) and every lot moved a point
  or more. **The pictures are drawn for this row, with every layer separate
  and switchable** (first run with layers), and lots carry B-numbers.
  **Prediction, written before the run:** the median within half a point of
  the plan's row either way; B06 and B04 better (B04 only if NAIP adds canopy
  there, which H41 says it does); seen column no better, because stage 3
  clears the detector's answer under the new canopy and refills it only by
  span. Write H42.
- **Nothing in flight (2026-09-25, after H39).** The lidar veto (roof and
  void never lawn) is adopted into THE PLAN's row: same medians, the pond
  and Kent 8,626's roof fixed, none worse. Next, in order: (1) look at
  Kent 8,626 in the pictures to see what roof was being called lawn;
  (2) on `lawns: all` (20+ maps approved since the freeze, not comparable
  with the benchmark tables), the tree count per canopy clump as an AUC
  against lawn under it (S9), and a "something stands here" mask against
  the detector's OWN false lawn (S10); (3) the lidar canopy's lidar-only
  cells (8,759) looked at in pictures before it is anything. The woods
  question is closed for height, size and understory (H35–H37).
- **What stage 4 is and is not doing with the lidar (owner's question,
  2026-09-25):** its stated job was hidden hard surfaces. Roofs it finds
  for free (no ground return, 3–10 m of height) and that mask is unused;
  hidden driveways it cannot find on these clouds (H34, intensity is a
  coin toss under trees). The woods rule is a stage 3 rule that borrowed
  the lidar's height, not stage 4's job. A third use, checking or
  replacing the tree model's canopy with the lidar's height (canopy =
  taller than 2 m and not a roof), is unmeasured; the cheap first
  measurement is the agreement between the two on the benchmark.
- **The plan's row today:** decoder (canopy on lawn) + stage 3, span
  (H33). Best median: everywhere + span. Default stays on lawn for the
  wooded lots.
- **Stage 4:** the lidar reaches the ground under every canopy but cannot
  tell lawn from not-lawn there; it tells woods from lawn trees by height
  (H34). Hidden pavement is not findable this way and is not being pursued.
- **After H35:** more maps (the corpus can grow; the benchmark is frozen,
  `lawns: benchmark`), the two stage 1 lots the decoder gets wrong (NC
  10,556 is semi-dormant grass, H32), and the roof mask the lidar gives for
  free (H34), unused.

---

## The benchmark lawns by name — B01 to B32

*Fixed 2026-09-26 at the owner's request (`worker/src/benchmark-ids.js`). Never
renumbered. Every run's log prints this legend with its own square feet, and
the pictures page puts the name on each card. Square feet here are the
scorer's (true lawn); the lidar reader's own estimate differs by a few, which
is how "B28 (NC 10,556; written B28 NC 10,556 at first, the lidar reader's own square feet)" came to be written for B28 on 2026-09-26 (H40, H41).*

| | lawn | | lawn | | lawn | | lawn |
|---|---|---|---|---|---|---|---|
| B01 | Cass ND 4,987 | B09 | Kent 22,481 | B17 | Wayne 12,426 | B25 | Maryland 2,657 |
| B02 | traced by hand, TX 4,315 | B10 | Kent 26,207 | B18 | traced by hand, OH 10,304 | B26 | Maryland 6,658 |
| B03 | Utah 13,689 | B11 | Kent 29,680 | B19 | Bullitt KY 8,615 | B27 | NC 7,945 |
| B04 | Island WA 19,932 | B12 | Kent 72,863 (the pond) | B20 | Bullitt KY 11,947 | B28 | NC 10,556 (semi-dormant; trees gone, H41) |
| B05 | Kent 8,134 | B13 | Kent 105,584 | B21 | Bullitt KY 19,619 | B29 | NC 13,165 |
| B06 | Kent 8,626 (the tree strip) | B14 | Ottawa 8,573 | B22 | Prince William 3,429 | B30 | NC 14,668 |
| B07 | Kent 10,429 | B15 | Ottawa 19,091 | B23 | Prince William 5,042 | B31 | NC 16,331 |
| B08 | Kent 16,488 | B16 | Ottawa 158,238 | B24 | Prince William 8,841 | B32 | NC 114,992 |

---

## The numbers that matter right now

**CORPUS `1rijjz2`, 32 lawns, 2026-09-23 — the current state.**

| | error | notes |
|---|---|---|
| SAM (what we pay for) | **23.3%** | the line to beat, 26 lawns with a stored answer, all drawn by `sam3` |
| best of ours | **30.2%** | Scale-MAE 896px squeezed whole, 15 cm grid, **both, with surroundings**, beat SAM on 12 of 26 (run 35914319694). The control at 512 read 31.4% with the eye alone; 1.2 points is inside H13's drift |

Gap: **1.30×**. It was 1.45× on `1wxlejo` (31 lawns) and 1.39× at 23. One map
left and one arrived between `1wxlejo` and this, so by H7 the two tables are
not the same measurement; the ratio is the only number worth carrying across.

**CORPUS `1rijjz2`, 32 lawns, RECTANGULAR FRAMES, 2026-09-24 — the current state (H25).**
*These 32 are frozen as the benchmark from 2026-09-24 (`lawns: benchmark`,
the default). New maps join the corpus but not this table.*

| | error | notes |
|---|---|---|
| SAM (what we pay for) | **24.7%** | 26 lawns with a stored answer, all `sam3`, rasterised on the rectangular grids (23.3% on the square ones) |
| best headline | **24.3%** | **decoder, canopy everywhere**: Scale-MAE 896px whole, a conv decoder over the full 1024-number grid, trained with the hand marks and every canopy cell as don't-care; 16 of 26 over SAM; reproduced four times (H27, H28, H29). 23.4% on visible ground, 18.7% under the trees. Its 4.1 points over the no-canopy decoder (28.4) are all under the trees (H29), and it gets them by guessing lawn under any tree near lawn: Kent 22,481 sq ft 170% wrong, Prince William 3,429 319% |
| THE PLAN's row | **26.6%** | **decoder (canopy on lawn) + stage 3, span + lidar veto** (roof and void never lawn, H39: same median, in sun 36.2 → 32.2, Kent 72,863 37 → 31, Kent 8,626 51 → 41). Span alone (H33) as follows: (span 8 m, reach 1 m, bridge over 180°): 16 of 26 over SAM; 22.2% on visible ground, 28.5% under the trees; **Kent 22,481 at 40%, Prince William 3,429 at 60%, the best any row reads on the wooded lots**. One run (H33). The reach-3 m row it replaced: 25.8 / 26.0 / 12.2, 17 of 26, PW 80 |
| best median | **23.3%** | **decoder (canopy everywhere) + stage 3, span**: 17 of 26 over SAM, **21.7% on visible ground, the best any row has**, 18.3% under the trees; Kent 38% (was 50% under reach), Prince William 91% (the visible gaps inside the wood, H31). One run (H33) |

Gap: **0.94×** on the best median, **1.08×** on the plan's row, both a tie
at 32 lawns (H7). Stage 3 is measured (H30–H33): clearing the canopy alone
is worth about 3 points on visible ground; reach trades visible for hidden
a metre at a time and creeps into the woods; span (lawn under canopy joins
the visible lawn on both sides of it, then a little beyond) keeps visible
ground within two points of cleared, leaves the woods alone, and gets half
of reach's hidden gain — the half with lawn on one side only is the traced
wood-edge strip (H32) and the setback along a house (H33), which no rule
over two masks reaches. **Stage 4 measured (H34): the lidar reaches the
ground under every canopy but its ground intensity cannot tell lawn from
not-lawn there; what it can tell is woods from lawn trees, by height
(3.7 m against 7.3 m).** What is left: telling woods from lawn trees (height alone is a
trade the wrong way, H35; height and size is nothing, H36; the understory
under the crown is weaker still, H37: closed), the roof mask, two lots where the decoder is 30–50
points worse than colour (Utah's photograph is bad, NC 10,556 is
semi-dormant grass, H32), and more maps.

**H22 is retracted** (2026-09-24): with the registration bug fixed, windows
are within noise of squeezing whole, both ways. The default stays off for the
run time, not for any measured loss.

**Rectangular frames, 2026-09-23/24 (H24, H25): SAM 27.1% on 31 lawns as the
app asks (was 33.8% on the squares that morning); the canopy medians
unchanged; the first backbone run VOID from a scale bug in the extractor; the
second run gave the decoder row above but its head rows are void again from a
registration bug in the squeeze (`shrink` dropped the cover), which also puts
H22 under re-test. The head rows on rectangles have not yet been validly
measured.**

*(The table below is the 2026-09-23 square-frame state, kept for the history.)*

**Three things were tried on 2026-09-23 to get every detector 10 cm a pixel.
Two were measured worse and are off:** cutting SAM's lot into pieces (H21)
and reading the backbone in windows (H22). **The third, the 15 cm scoring
grid, was measured as nothing (H23) and is kept.** The canopy model already
read 10 cm and was unchanged. The day's lesson, twice over: for the
pretrained models, the whole lot in view is worth more than the resolution.

*(The paragraph below is the 2026-09-22 state, kept for the history.)*

**CORPUS `1wxlejo`, 31 lawns, 2026-09-22.**

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

**The numbers in stage 3 were placeholders, and have now been swept once
(H30):** reach 3 m and 180° sit at the peak of a 4 × 3 sweep on the
benchmark; the peak is a trade between the seen and inferred columns, not a
setting that is right.

**What is already known, per stage.**

- **Stage 1: measured.** H17 -- dropping unseen ground from training improved
  the visible half by 2.1-3.5 points on four of six rows. "Find only what you
  can see" is the configuration that scored better, not a hope.

  **Since 2026-09-23 stage 1 has a reader built for it: `tools/train_decoder.py`.**
  Every "backbone" row before this went through the same door -- the eye's 1024
  numbers a patch squeezed through a FIXED RANDOM projection to 32 (or 96) and
  then a 16-unit head deciding each 15 cm cell on its own. Nothing in that path
  learns which of the eye's directions matter, and it is the reader H22 ran into,
  not the eye. The decoder is a small convolutional net (1x1 1024→128, two 3x3
  layers, 1x1→1; about 220k weights) over the WHOLE patch grid, trained per
  fold on visible ground only (inferred and off-property cells carry no weight,
  as H17 says), and scored by the same `judgeFold` as every other row, as
  **"the pretrained eye, decoder"** in workflow 14's table. UNMEASURED at the
  time of writing; the first run is the row after this one in the run log.

  **Since 2026-09-24 the tree model's canopy counts as unseen ground too**
  (workflow 14's `canopy` input, on by default). The owner's reasoning, which
  is right: the canopy mask in every run so far is a better record of what the
  camera could not see than the hand-drawn "inferred" marks, and stage 1 is
  being taught to find only visible lawn. So the decoder carries no weight on
  canopy cells (in addition to the marked ones) and the SEEN column is scored
  outside them. One refinement to how it was put: canopy is DON'T-CARE, never
  "not lawn". A zero label there would teach "canopy means not lawn", which is
  stage 3's question and the wrong answer to it (the same reasoning as
  `seenOnlyTwin`). The headline column still includes canopy, so it still
  answers the whole question; the seen column answers stage 1's. **Measured
  and settled in H29 (three decoders over one extraction): the canopy is
  worth 4.1 points on the headline and none on visible ground** — none 23.0,
  everywhere 23.4, on lawn 24.3 on the seen column, inside seed noise. The
  headline gain is the everywhere decoder guessing lawn under trees near
  lawn, which is stage 3's question answered by accident, right on lawn trees
  and wrong in the woods (Kent 22,481 sq ft 170%). The owner's refinement
  from the pictures — canopy unseen ONLY where the tracer drew lawn — keeps
  the woods out but is the worst of the three on every column as a stage 1
  alone (H29). Since stage 3 clears the canopy before it reasons (H30), the
  choice was to be made after stage 3, and H31 made the measurement: over
  stage 3 the everywhere decoder is best on every median (24.2, 22.6 on
  visible ground, 18 of 26) and worst on the wooded lots (Kent 22,481 at
  50%, Prince William 3,429 at 130%), because it claims the visible gaps
  inside a wood and the clearing only removes canopy. On lawn stays the
  default for the tail, not the median; the enclosure rule is the next
  measurement.

  **And the colour row is a control from here, not a candidate.** It stays in
  the table because it is reproducible to the decimal (H10) and so says when the
  corpus moved, and because it is the only head a browser can run; it no longer
  gets to be "best", set the verdict or draw the pictures. The 96-number squeeze
  and the two ring rows were dropped the same day: six rows of the same random
  projection into the same head were six ways of asking one narrow question, and
  the winner among them moved with the corpus (H4, H13, H23). **Tables from
  runs after this have three head rows plus the decoder, so they do not line up
  row for row with the ones above.**
- **Stage 2: works by eye, unmeasured** (H19), free, and precomputable --
  workflow 19, about 18 minutes of CPU, nothing bought. Its open problem is
  H20, resolution on big lots.
- **Stage 3: MEASURED 2026-09-24 (H30).** Over the on-lawn decoder:
  clearing the canopy alone takes visible ground 24.3 → 20.7; reach 3 m with
  a 180° bridge reads **25.8% headline, 17 of 26 over SAM, 12.2% under the
  trees**, the wooded lots intact. Reach trades the seen column for the
  inferred one a metre at a time (the walk fills the edge of the woods as
  readily as a lawn tree), and peaks at 3 m. The fixed row's cell was chosen
  before the sweep was seen. Over all three decoders (H31): the everywhere
  decoder feeds it best on the median and worst on the wooded lots; the
  no-canopy decoder is no better than on lawn. The enclosure rule (H32)
  recovers the visible ground reach cost and loses most of the hidden gain:
  one-sided ground under canopy, traced or not, looks the same to geometry.
  **The owner's rule, `span`, MEASURED 2026-09-25 (H33) and now THE PLAN's
  row.** Lawn under canopy joins the lawn that can be seen: canopy with
  visible lawn on both sides of it along some straight line, within the
  span each way, is filled; then a small reach goes "a little beyond, not
  far"; then the bridge. A wood edge has lawn on one side only along every
  line and is never spanned; a tree in a lawn, or a row of trees with lawn
  either side, is. Measured: visible ground within two points of cleared
  (reach cost five), the wooded lots the best any row reads, half of
  reach's hidden gain, headline a wash. The half it misses has lawn on one
  side only — the wood-edge strip and the setback along a house — and
  needs a third mask (stage 4). Workflow 14 sweeps span 4 / 8 / 12 m ×
  reach 0 / 1 / 1.5 m per decoder and scores the fixed "+ stage 3, span"
  row (8 m, 1 m, 180°) beside the reach row. **A fourth rule, WOODS, built
  2026-09-25 from the lidar (H34) and UNMEASURED: a canopy clump whose
  median height above ground is H metres or more is woods and is never
  filled by span, reach or bridge. Workflow 14 reads the lidar after the
  canopy (LIDAR_DIR), sweeps H at off / 4 / 6 / 8 / 12 m at the span cell,
  and scores a fixed "+ stage 3, span, woods" row at 6 m, chosen from the
  two class medians before the sweep was seen.** MEASURED (H35): fixes
  Prince William under every decoder (60–91% → 28–35%) and costs nearly
  all the hidden lawn at 6 m, because a lawn tree is tall too; 12 m is a
  gentler trade. MEASURED (H36): tall AND big (12 m and a size floor of
  200, 500 or 1,000 m², all identical) leaves Prince William unfixed and is
  span alone on two decoders; not adopted. The understory under the crown
  was measured next (H37) and is weaker than height: the woods question is
  closed, the rule stays in the code switched off. Built as: `tools/stage3.js`: the
  canopy is cleared from stage 1's answer (its opinion under a tree is
  untrained and is not evidence), then canopy within `reach` metres of
  visible lawn becomes lawn (a walk that only enters canopy, so it cannot
  cross a driveway to a second tree), then a clump of canopy with lawn round
  more than `ring` of its rim is filled (off-grid counts as not-grass, so
  woods running off the frame are not "surrounded"). Workflow 14 sweeps
  reach {0, 1.5, 3, 4.5 m} × rim {off, 180°, 126°} over the first decoder's
  masks and prints headline / seen / inferred for each cell, and adds a
  "+ stage 3" row (reach 3 m, 180°) per decoder to the table. The inferred
  column is the one to read: it is the only ground stage 3 may change. All
  three rules are ordinary raster geometry over two masks that already
  exist; no training, no corpus, no money, scored over all 32 maps in
  seconds at the end of a run.
- **Stage 4: the expensive one.** H16 says 29 of 31 lawns have LiDAR over them,
  flown 2011-2020, a median of ten years before the photographs.
  **Phase two BUILT 2026-09-25, UNMEASURED: workflow 23, `tools/lidar_frame.py`.**
  The public Entwine octree is walked over each frame's own rectangle (the
  frame dump now writes the frames' Web Mercator boxes into scale.json, and
  the point clouds are in Web Mercator, so nothing is reprojected); every
  touching node is downloaded (probed on the Kent County project: 13 nodes,
  3 MB, 9 s, 9,321 points over a 70 m square, 1.9 points/m², 0.7 ground
  returns/m², classes ground and unclassified, intensity present). Three
  layers at 2 m cells — a QL2 cloud has under one ground return a square
  metre, so 15 cm is out of the question — ground-return density, ground
  intensity, height above ground; four classes from the labels and the
  canopy mask; and the number stage 4 turns on: an AUC per layer for lawn
  against not-lawn UNDER CANOPY, beside the same on visible ground as the
  sanity check. No PDAL: laspy and lazrs are pure wheels. **MEASURED (H34):
  the pulses reach the ground under 95–100% of canopy cells, ground
  intensity does NOT tell lawn from not-lawn under the trees (a coin toss
  pooled, direction flips lawn to lawn), ground density barely does, and
  HEIGHT does: lawn under canopy is under 3.7 m of tree, the woods are 7.3 m
  (AUC 0.23 pooled). So the "driveway under a tree" case has no instrument
  here after all, and stage 4's product is a canopy height model that says
  which canopy is woods — a fourth stage 3 rule, unmeasured.** (It was
  measured as a rule in H35 and H36 and failed both ways: a lawn tree is
  tall and can be big.) **A fourth layer, BUILT 2026-09-25 and UNMEASURED:
  the understory** — of the returns from below 3 m, the share from 0.5 to
  3 m above ground, per 2 m cell and over a 6 m square (`understory`,
  `understory_6m`), with its AUC beside the other three. Mown grass under a
  lawn tree should have none; a wood's floor should have shrubs. That is a
  theory until the AUC is read, and a candidate rule only after stage 3
  scores it, because height read 0.23 here and still failed as a rule.
  MEASURED (H37): 0.35–0.38 over 6 m, weaker than height, and as strong in
  the open as under the trees. Not a woods signal; the woods question is
  closed for this instrument. **Stage 4's product, MEASURED and ADOPTED
  (H38, H39): the lidar veto.** Roof (no ground return, 2.5 m up, returns
  within 1.5 m, three at least) and void (nothing back over 6 m, or water)
  are never lawn, applied after stage 3. 0.2–0.5% of lawn cells under roof,
  none under void; on the benchmark it fixes the pond (Kent 72,863), a roof
  on Kent 8,626, and three lots by 1.6–7 points, moves no median, and makes
  no lot worse. The lidar's own canopy (2 m up, not roof) is measured and
  NOT used: 13.6% of visible lawn is under it (H38).

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

### The resolution rule — every detector gets 10 cm/px

*(Owner, 2026-09-23: "i want you to be sure that at the end of the day, every
detector is getting 10-15cm/px ... Every detector should be receiving and
working with 10cm/px unless we specifically demonstrate that we can drop the
resolution beyond that if performance of traces is not hurt too badly. If a
detector has to work with lower resolution, we should evaluate if we're using
the right detector.")*

This is a RULE, not a finding. Ground per pixel is `metres across the frame /
pixels the model reads`, so a fixed pixel count means the resolution falls out
of the lot size — which is H20, and it was true of every detector here, not
just the canopy one. Audited from the code on 2026-09-23. Corpus lots run 25 m
to 319 m across; 11 of 32 are over about 120 m.

| detector | what it reads | 60 m lot | 100 m | 172 m | 319 m | meets the rule? |
|---|---|---|---|---|---|---|
| canopy, `tcd-segformer` (wf 19) | the banked photo, resampled to 0.10 m/px, tiled | 10 | 10 | 10 | 10 | **yes** — since the 10 cm re-bank |
| lawn backbone, Scale-MAE at `size=896` (wf 14), BEFORE 2026-09-23 | whole frame squeezed to 896 px | 6.7 | 11.2 | **19** | **36** | only under ~90 m |
| lawn backbone at `size=1280`, BEFORE | whole frame squeezed to 1280 px | 4.7 | 7.8 | **13.4** | **25** | only under ~128 m |
| lawn backbone, windowed (`tools/windows.py`), one run | one pass under ~90 m at 896; past that, overlapping 896 px windows at the photo's own resolution | 6.7 | 7.8 | 10 | 10 | yes — and **measured worse on every backbone row** (H22), so off by default |
| lawn backbone, NOW | whole frame squeezed to 896 px, as before; `windows: on` in workflow 14 turns the windows back on | 6.7 | 11.2 | **19** | **36** | **no**, on purpose: H22 |
| lawn head, `GRID=512` | scores one cell per 1/512 of the frame | 12 | 20 | 34 | 62 | cells, not pixels — see below |
| SAM 3, live (`/api/segment`), BEFORE 2026-09-23 | the DISPLAY frame: 640 logical @2x = 1280 px, resized by SAM to about 1008 px (its published input size; not measured here) | 6 | 10 | **17** | **32** | only under ~100 m |
| SAM 3, live, for a few hours on 2026-09-23 | one picture under ~100 m; past that an n×n of 1008 px pieces at 10 cm or finer (`detectionPlan`) | 6 | 10 | 8.5 | 10 | yes — and **measured worse** (H21), so switched back off |
| SAM 3, live, NOW | one picture again, the machinery behind `SAM_MAX_TILES_ACROSS` | 6 | 10 | **17** | **32** | **no**, on purpose: H21 |

Numbers are cm per pixel; bold is coarser than 15 cm. The `512` and `896`
and `1280` that keep coming up are three different things: **512** is the grid
the lawn head SCORES on (one number per cell, and the tracer's input), **896 or
1280** is the picture the backbone LOOKS AT, and **1280** is also the size of
the published rendering. None of them is a resolution until you divide the
lot size by it.

**As of the audit only the canopy detector honoured the rule.** The lawn
detector and SAM both inherited H20 unfixed: they read a whole-lot picture at a
fixed pixel count, so a big lot was a blurry lot. The fix in both cases is the
one the canopy path already has — capture at 10 cm and TILE, so a big lot is
more pictures rather than a coarser one.

**SAM is fixed, same day.** `detectionPlan` in `worker/src/imagery.js` cuts a
lot over about 100 m across into an n×n grid of 1008 px pieces (SAM's input
size) at 10 cm or finer, the Worker asks once per piece, and the browser
pastes the masks back together (`public/lib/tiles.js`) before tracing. Under
100 m nothing changed. What it costs, said plainly: **every piece of every box
is an AI pass.** A 172 m lot is 4 passes for "find grass" and 8 for two boxes,
against a signed-out allowance of 5 a day. The grid was capped at 2×2 for a
few hours because Replicate throttled the account at 6 requests a minute; the
owner raised the account to the standard 600 the same day, so the cap is 4×4
(~400 m at 10 cm, past anything the corpus holds; `SAM_MAX_TILES_ACROSS`
moves it) and the pieces are started in parallel. Past the cap the pieces get
coarser and the response says so. Unmeasured: whether
the outlines are better for it. The pieces abut exactly in world pixels (same
arithmetic as the banked tiles) but a mask edge at a seam is still two
separate answers meeting, and nothing has yet been scored across one.

**The lawn backbone is built, same day, and MEASURED WORSE (H22): every
backbone row lost 2 to 16 points against the same corpus squeezed whole, so
the windows are off by default.** What was built, for the record —
`tools/windows.py`:
a lot the eye can read at 10 cm in one pass (under about 90 m at 896) is
resized and read exactly as before, so nothing already at the target moves. A
bigger one is read at the photograph's own resolution in overlapping 896 px
windows — a 112 px margin (about 11 m) on every side is read and thrown away,
only the middle 672 px of each window is kept, and the cores are stitched into
one feature grid the head samples as before (`cover` in the manifest keeps a
photograph pixel on its own patch; `tools/windows_test.py` proves the
registration with a picture that is its own coordinates). Workflow 14 dumps
frames `native` now rather than at the model's size, which is where the
squeeze used to happen. Cost: a 319 m lot is a 5×5 of windows, 25 passes
where there was one; over this corpus roughly 80 extra passes, about 40
minutes at 896.

*(Owner, 2026-09-23, on tiling the backbone: "can we stitch it BEFORE sending
it the lawn detector so it's not losing context of features that cut off on
the edge of one grid?")* — the photograph already is stitched; it is the
model's WINDOW that cannot be, because attention cost is quadratic in tokens
(a whole 3192 px photograph is about 40,000 patches, 160× the work of 896).
Overlap is the answer to the context concern, and it is also the answer to
this file's own earlier objection to tiling (workflow 12's 224 px tiles, "a
patch in the middle of a tile cannot see the garden it sits in"): every kept
patch here had 11 m of real picture on every side when it was read.

**The head's grid follows metres too, built the same day, and MEASURED AS
NOTHING (H23): every row within 3 points either way on the same corpus, so it
is kept for the rule's sake and costs a few minutes.** What was built:
`GRID = 512` over the frame was 20 cm a cell on a 100 m lot and 62 cm on a
319 m one — the cheap colour-and-texture features are computed from the
photograph resampled to that grid, the texture window (`FINE_M`) is 0.25 m so
on any lot over about 128 m a cell was wider than the window and the feature
measured nothing, and the outline is quantised to the cell. `gridFor` in
`tools/train-detector.js` now gives each lawn ceil(across / 0.15 m) cells,
floored at 512 and capped at 1024; the browser's developer-mode head uses the
same rule. Under about 77 m nothing moves, cell for cell. The cap is memory
(14 floats per cell per lawn, held for the whole corpus), so a 319 m lot is
31 cm a cell — half what it was, not the target, and the run's settings say
how many lawns hit the cap. **Every number in this file before this date was
measured at 512**, so the first run at the new grid is not comparable to the
table above it on the big lots; a control at 512 on the same corpus is what
makes it readable, and the windowed-backbone run of 2026-09-23 (grid still
512) is that control.

Not at 10 cm anywhere: the canopy tool's overlap statistics (`onLawnPct`,
`insidePct`) are counted on its own 512 grid, which is a statistic's
resolution and not a detector's; the canopy model itself reads 10 cm.

**And, before 2026-09-24, counted on outlines with no holes.** Every clump
outline was the longest contour of the patch, which is its outer boundary, so
a clearing ringed by woods was drawn as canopy and counted as canopy in
`onLawnPct`. The owner found it in the pictures of the Kent county lot: a few
thousand square feet of grass, no trees in the raw mask, inside the outline.
Fixed by tracing the holes too (`tools/clumps.py`, `canopy_test.py`). The
raster never had the bug, so nothing the decoder or stage 3 measured moves;
only workflow 19's two overlap numbers and its outline pictures were wrong,
and every `onLawnPct` quoted above is from before the fix.

**Crowns are out of scope** until everything above works. The measured crown
area per lawn is small enough that it is not where the square footage is, and
the one thing that made them attractive -- an off-the-shelf, well-tested
delineator -- turned out not to exist for our imagery. See H18's retraction.

---

## HARD FINDINGS — our own measurements

### H47. One segment per crown, judged by its own lawn border, tells woods from lawn trees — and still does with the detector's edge instead of the tracer's, 2026-09-26

Runs 36263514117 (workflow 23) and 36263512588 (workflow 14, `canopy:
compare`, benchmark), 29 lots with lidar. The unit H46 left open: every
cell of the tree model's canopy inside the lines goes to its nearest lidar
tree top in the same clump (tools/crowns_lidar.py `crown_segments`); a
clump with no top is one segment. Each segment: its border share of visible
lawn, median distance to visible lawn, other tops within 10 m (crowding),
top height, area. Bar written before the run: a rule finds at least half
the woods canopy for at most a tenth of the lawn under canopy, pooled by
area, **judged on (b)**.

**THE LEAK, and its size.** H46 and this test's first form took "visible
lawn" from the TRACER, which the pipeline never has. So workflow 14 now
writes the drawn row's held-out mask per lot (PRED_OUT) and
tools/segments_pred.py repeats the test with (b) the detector's answer
outside the canopy as the visible lawn. Workflow 23's block and (a)
reproduce to the digit. **497 segments: 96 mostly lawn under them, 401
mostly not** (the lawn/not-lawn truth is the tracer's in both).

| per segment, AUC (not-lawn above lawn) | (a) tracer's edge | **(b) detector's edge** |
|---|---|---|
| border lawn share | 0.06 | **0.08** |
| distance to visible lawn | 0.95 | **0.94** |
| crowding (tops within 10 m) | 0.87 | 0.87 |
| top height | 0.85 | 0.85 |
| area | 0.74 | 0.74 |

| rule calling a segment woods (area-weighted) | (a) lawn lost / woods found | **(b) lawn lost / woods found** |
|---|---|---|
| **border lawn 0%** | 5.6% / 83.0% | **7.5% / 85.0%** |
| border lawn < 10% | 8.8% / 83.8% | 12.1% / 86.7% |
| border lawn < 25% | 12.3% / 89.1% | 18.2% / 90.2% |
| distance 6 m+ | 10.7% / 88.5% | 16.4% / 90.4% |
| **distance 10 m+** | 2.4% / 79.0% | **3.1% / 79.5%** |
| crowding 2+ | 23.4% / 67.1% | 23.4% / 67.1% |
| crowding 2+ and border 0% | 5.5% / 58.9% | 6.7% / 60.4% |
| height 12 m+ and distance 6 m+ | 8.1% / 77.3% | 10.0% / 79.3% |

**Against the bar, on (b): passes.** "Border lawn 0%" finds 85.0% of the
woods for 7.5% of the lawn under canopy; "distance 10 m+" finds 79.5% for
3.1%. Five rules pass on (b). The first woods test to pass after H35, H36,
H37 and H46, and the difference from H46 is only the unit: a lawn tree
touching a wood is its own segment, with its own lawn border, instead of a
corner of the wood's clump.

**The leak was real and small.** The prediction was that (b) would be
worse; it is, by one to six points of lawn cost, never by enough to change
a verdict. The detector's visible lawn is close enough to the tracer's at
the edges that matter here. H46's border AUC (0.16) carried the same leak;
its verdict (no clump rule passes) does not depend on it, since every clump
rule failed on the lawn cost with the tracer's edge already.

**WHAT THIS DOES NOT SAY.** It is a separation, not a score. Stage 3
already works outward from the visible lawn edge (span 8 m, reach 1 m), so
the segments "distance 10 m+" calls woods may be ground stage 3 never
refills anyway, and the gain on the benchmark could be anything from none
to most of it. The crowding and height columns do not use the lawn edge at
all and are unchanged between (a) and (b), and neither alone passes.
SPECULATION until the row is scored: stage 3 with segments failing "border
lawn 0%" removed from the canopy it may refill.

### H46. Counting crowns per clump does not tell woods from lawn trees; a lawn border does, per clump, but no clump-level rule is cheap enough — the clumps are joined, 2026-09-26

Run 36256482254, workflow 23, benchmark (29 lots with lidar), the owner's
S9: tree tops on the lidar CHM by Popescu & Wynne's variable window
(deciduous crown width, tops 3 m and up, 3x3-smoothed), counted per clump of
the tree model's canopy inside the lines; each clump's border of visible
lawn; area-weighted trades for rules calling a clump woods. It repeated the
preview on H43's saved layers to the clump count and every AUC.

**95 clumps: 57 mostly lawn under them, 38 mostly not.** Medians: crowns 0
against 1 (most small clumps have no 3 m top the 2 m lidar can see), area
19 against 37 m², border lawn **69% against 34%**.

| per clump, AUC (not-lawn above lawn) | |
|---|---|
| crowns | 0.69 |
| crowns per 100 m² | 0.67 |
| **border lawn share** | **0.16** (i.e. 0.84 the other way — the best single separation any woods test has shown) |
| median height | 0.63 |
| area | 0.66 |

| rule calling a clump woods (area-weighted) | lawn under canopy it loses | woods canopy it finds |
|---|---|---|
| 3+ crowns | 48.5% | 94.5% |
| 6+ crowns | 33.0% | 93.4% |
| border lawn < 25% | 31.5% | 94.9% |
| **3+ crowns and border < 25%** | **30.4%** | **92.5%** |
| height 12 m+ (H35) | 28.6% | 81.1% |

**Against the bar (half the woods for a tenth of the lawn): no rule passes.**
Every rule finds nine tenths of the woods, because the woods are a few huge
joined clumps; and every one loses a third to a half of the lawn under
canopy, because those same clumps hold much of it — **the owner's
prediction that crowns join exactly where it matters (H36's speculation) is
now measured.** The crown count adds little the border does not; the border
is the owner's idea that works, and it works per clump, not per square metre.

**Closed at the clump level.** SPECULATION, the one form left: the unit
below the clump — each crown's own segment (the cells nearest each top), or
the canopy within some metres of the visible-lawn border — judged by its own
neighbours and border, so a lawn tree touching a wood is judged as itself.

### H45. Used as tall, tree-sized cover, NAIP-CHM passes the agreement bars from 4 m up but never the lawn bar — which was badly chosen; closed as a canopy anyway, 2026-09-26

Run 36247435370, workflow 23, benchmark (29 lots with lidar), the owner's
"we are not using CHM right": NAIP-CHM cover (half the 2 m cell) at H m, not
roof, in objects of at least A m². Everything H41 printed reproduced.

| H / A | both (bar > 80) | neither (bar < 10) | traced visible lawn called canopy (bar < 5) | lidar 4 m trees found |
|---|---|---|---|---|
| 2 m / 0 | 98.2% | 8.6% | 15.6% | 89.5% |
| 3 m / 0 | 97.1% | 6.8% | 13.5% | 87.3% |
| 4 m / 0 | 95.7% | 5.4% | 11.8% | 84.0% |
| 4 m / 50 | 95.5% | 5.1% | 10.7% | 81.0% |
| 5 m / 0 | 94.0% | 4.3% | 10.3% | 79.6% |
| **5 m / 50** | **93.8%** | **4.0%** | **9.4%** | **77.1%** |

(20 m² sits between 0 and 50 at every height.)

**Against the bar written before the run: no cell passes.** Taller and bigger
does what the owner expected — the false canopy where neither the tree model
nor the lidar sees a tree falls from 8.6% to 4.0% — but the traced lawn it
calls canopy never falls below 9.4%, and the size floor buys only a point.

**The lawn bar was badly chosen, and that is recorded rather than quietly
fixed.** "Visible lawn" is the tracer's lawn outside the TREE MODEL's
canopy, and the tree model misses trees (H41): the lidar itself calls 13.6%
of that same ground canopy (H38). So a perfect canopy map would fail a 5%
bar too. The fair version is lawn over ground the lidar calls flat, which
this run did not print; H43 put it at 13.3% for NAIP-CHM's tallest pixel.

**Closed as a canopy for this project regardless**, for the reason H42
measured: any canopy stage 3 is given clears the detector's own answer under
it, and at its best setting NAIP-CHM still covers a tenth of the traced lawn
and loses a quarter of the real trees. It stays a switch on the pictures page
(off by default) and a column in workflow 23.

### H44. Twelve more maps: fifteen of the benchmark lots better and eight worse, Utah fixed, Island County broken; the pond not fixed — NOT COMPARABLE with any benchmark table, 2026-09-26

Run 36219427024, `canopy: compare`, **`lawns: all`: 44 lawns** (fingerprint
`0rjzt1k`) — the 32 and 12 approved since the freeze (Georgia, Alabama,
Louisiana, Iowa, Kentucky, North Dakota, Maryland). Leave-one-out, so each
benchmark lot was drawn by a model trained on 43 lawns instead of 31. The
headline table is over 44 lawns and 30 SAM outlines and compares with
nothing: THE PLAN's row 23.7% (seen 20.2, inferred 26.7), 20 of 30 over
SAM at 32.2%; everywhere + span 19.5%.

**The comparable part is lot by lot.** The per-lawn table (printed for
everywhere + span, the same row the benchmark runs printed) against H39's,
on the 32: **15 better by more than a point, 8 worse, median change −0.6.**

| better | before → after | worse | before → after |
|---|---|---|---|
| **B03 Utah** | **86.2 → 38.3** | **B04 Island County** | **33.3 → 64.7** |
| B17 | 42.6 → 32.8 | B18 | 25.0 → 32.7 |
| B20 | 23.8 → 14.1 | B24 | 15.4 → 18.9 |
| B22 | 91.1 → 81.4 | **B12 (the pond)** | 34.1 → 37.3 |
| B28 | 79.0 → 73.4 | B19 | 22.8 → 25.5 |
| B06 | 47.4 → 42.9 | B16 | 13.6 → 16.2 |
| B09, B23, B02, B27, B13, B21, B29, B08, B01 | 1–3 points each | B15, B11 | 1–2 points |

**The owner's three questions:** the pond (B12) did not yield to more data —
slightly worse; B06's roof lot improved 4.5 points on this row (and the veto
takes it further on the plan's row); B23's shadowed grass improved 3 points.
Utah (B03), stuck at 86% since H30 under every decoder, came down to 38%.
Island County (B04) doubled its error, which one run cannot explain.

**One run, one extraction** (H13, H28: the extraction comes back in
states); a lot moving 3 points is inside what a re-run can do, and 30-plus
points (B03, B04) is not. The plan's row had no lot-by-lot table in this run
(only the lots a rule moved); from here every run prints it too.

**Pictures**: THE PLAN's row, every layer, 44 lawns,
`runs/2026-09-26-0253-edt-scalemae-large-896px`. B04 and B03 are the two to
open.

### H43. NAIP-CHM is registered but not trustworthy at lawn scale: right in the median, a tenth of flat lawn reads 4 m or more, and on some lots the lawn itself reads 2–3 m; not a canopy source here, 2026-09-26

*The owner's reading, 2026-09-26, then measured.* In the pictures of H42 the
NAIP-CHM canopy "extends far beyond canopies, marks open spaces nowhere near
trees or buildings, and follows shapes with no correlation to anything". In
the NAIP-CHM Earth Engine app, B25's lawn reads a little over 2 m, its roof
6–7 m, and a "tree line" under 1 m — which Street View shows to be shrubs of
about 1 m. The owner's diagnosis: poorly calibrated below about 3 m.

**Measured from run 36208871886's saved layers** (the 2 m lidar grid,
NAIP-CHM's tallest pixel a cell, 29 lots with lidar):

- **Registration is not the problem.** Sliding NAIP-CHM against the lidar's
  height ±12 m, the best correlation sits at zero or one 2 m cell on 27 of
  29 lots (r 0.6–0.9). Two exceptions: B28 (r 0.1 — its trees are gone since
  the flight, H41) and **B24 (r 0.26 at zero, 0.83 one cell north — unexplained,
  noted)**.
- **On ground the lidar calls flat (under 0.5 m, with a ground return), NAIP-
  CHM's median is 0.08 m — but its tail is heavy:** 16.9% of those cells read
  2 m or more, 14.2% 3 m or more, **11.9% 4 m or more**. On the tracer's
  visible lawn over lidar-flat ground: 13.3% / 10.7% / 8.7%.
- **On some lots the lawn itself reads 2–3 m:** visible-lawn median B22 2.6,
  **B23 3.1**, B24 2.2, B06 1.7, B02 1.3, B31 1.2 (every other lot 0.0–0.3).
  B25 and B26, with no lidar to check against, read a median of 5.2 and 5.9 m
  over the whole frame.

**So the owner is right that it is unreliable low down, and a higher cutoff
does not rescue it**: 4 m instead of 2 m only takes the false share on lawn
from 13% to 9%, and on B22–B24 the lawn sits at the cutoff either way. Some
of the tail may be real change since the flights (2011–2020 against
2021–2023), which nothing here separates; for a lawn tool it does not
matter which. H41's tie-breaker (the tree model misses trees) was read
against a floor of 8.6% and stands; its use as a canopy failed in H42 and
this is why.

**NAIP-CHM is not a canopy source for this project.** Its read stays in
workflow 23 and as a switch on the pictures page, off by default.

**The lidar roof, from the same pictures (owner):** it misses part of the
roof and sits off the Mapbox photograph a little. Both are expected and
neither is a bug found: the roof test needs "no ground return", so the 2 m
cells along the eaves fail it; and an aerial photograph shows a roof leaned
a few metres off its footprint (relief displacement) where the lidar has it
where it stands. The veto's measured cost stays 69–102 m² of lawn (H39).

### H42. Widening the tree model's canopy with lidar ∩ NAIP-CHM costs four points: stage 3 clears the detector's own lawn under every added cell, and the added cells are coarse, 2026-09-26

Run 36212931237, `canopy: compare`, benchmark. THE PLAN's row with one
change: stage 3 worked over the tree model's canopy plus the cells the lidar
(2 m or more, not roof) and NAIP-CHM (half the cell 2 m or more) both call
canopy — NAIP-CHM alone on B04, B25, B26, which have no point cloud. Training
and scoring unchanged. Decoder rows 28.5 / 29.8 / 24.3; the plan's row 26.6
to the decimal of H39. NAIP index 8 s, files over 32 of 32.

| stage 1 | + span + veto (the plan) | **+ lidar ∩ NAIP canopy** | over SAM |
|---|---|---|---|
| no canopy | 27.0 / 22.4 / 24.8 | **30.9 / 26.4 / 31.4** | 16 → 14 |
| canopy on lawn (THE PLAN) | 26.6 / 22.2 / 28.5 | **30.4 / 27.2 / 31.4** | 16 → 14 |
| canopy everywhere | 23.4 / 21.6 / 19.3 | **28.2 / 23.7 / 25.3** | 17 → 15 |

Canopy added inside the lines: **15,476 m², 6,719 m² of it over the
tracer's lawn.** Worse by a point or more, under the plan's decoder: **B25
9.4 → 71.3**, B26 45.1 → 60.7, **B31 14.3 → 31.6**, B28 69.5 → 78.5, B04
56.3 → 61.2, B08 18.3 → 22.4, and nine more by 1–4. Better: B22 60.0 → 58.7,
B09 39.9 → 38.5, B30 21.5 → 19.1 (and B06, B16 on other decoders).

**The prediction failed on every clause** but the direction of the seen
column: the median moved 3.8 points, not under half a point; B04 got worse,
not better; B06 did not move on the plan's decoder.

**Why, as far as this run shows.** Stage 3 CLEARS stage 1's answer under
every canopy cell and puts lawn back only by span. So every added cell over
lawn the detector had right is lawn thrown away unless span refills it, and
the added cells are the lidar's and NAIP-CHM's 2 m squares copied onto a
15 cm grid — blocky at every crown edge. Where NAIP-CHM stood alone (B25,
B26, B04) there was not even the lidar's agreement to thin it. H41 said the
two instruments find trees the tree model misses; this says **a missed tree
is not a reason to discard what the detector saw under it.**

**Not adopted.** THE PLAN's row stays span + lidar veto over the tree
model's canopy. The row stays in the code and in the tables; the pictures
page draws THE PLAN's row again. **SPECULATION, the shape to try if the
missed trees are to be used:** let the added canopy only ADD — stage 3 may
fill under it from visible lawn, but may not clear what stage 1 called lawn
there.

**Pictures**, drawn for the losing row with every layer separate (the first
layered run): `runs/2026-09-26-0041-edt-scalemae-large-896px`. B25 is the
one to open: switch on "NAIP-CHM canopy" and "detector: raw answer".

### H41. Read as cover, NAIP-CHM passes its bar, and it says the tree model misses trees far more often than the lidar is stale, 2026-09-26

Run 36208871886, workflow 23, benchmark: H40 with one change fixed before the
run — NAIP canopy is **half the 2 m cell's NAIP pixels 2 m or more** (cover),
not the tallest pixel. Everything else reproduced.

| tree model / lidar | cells | NAIP canopy, H40 (tallest) | **H41 (cover)** |
|---|---|---|---|
| both | 14,006 | 99.3% | **98.2%** |
| lidar only | 8,759 | 76.0% | **67.4%** |
| model only | 2,216 | 79.4% | **68.6%** |
| neither | 45,977 | 13.7% | **8.6%** |

**The bar ('both' over 80%, 'neither' under 10%, written before H40): passed.**

| class | NAIP canopy (cover) | lidar canopy (H38) |
|---|---|---|
| visible lawn | 15.6% | 13.6% |
| lawn under canopy | 78.4% | 62.7% |
| not lawn, under canopy | 96.1% | 89.2% |
| not lawn, visible | 20.7% | 18.7% |

**What the tie-breaker says, against a floor of 8.6%:** two thirds of the
cells only the lidar calls canopy are still canopy in the 2021–2023 NAIP
(67.4%), and two thirds of the cells only the tree model calls canopy are
canopy in NAIP too (68.6%). The lidar-only cells are 8,759 against 2,216, so
**most of the disagreement is trees the tree model misses, not trees felled
since the flight**. The caution from H40 still applies in part: the disputed
cells are edge cells, and an edge is where cover is closest to half.

**Per lot:** Kent 8,626 (the owner's strip) 66% still canopy; **B28 NC 10,556
16%** — the one lot whose lidar-only trees are mostly gone (the tree model
found none there at all); NC 115,085 62% of 6,711 m²; Kent 72,863 83%.
**No lidar** (m², both / model only / NAIP only): Island County 363 / 216 /
**706**; Maryland 0 / 0 / 216 and 329 / 62 / 466. NAIP-CHM finds more canopy
than the tree model on all three.

**What it is not yet:** a canopy for the detector. 15.6% of the visible lawn
is under NAIP canopy (the lidar's is 13.6%); whether that is trees over lawn
the tree model missed or NAIP's own error, nothing here separates, and a
canopy that makes a sixth of the visible lawn "unseen" costs stage 1 its
training ground. The measurement that decides is a scored row in workflow 14.

### H40. NAIP-CHM sees nearly every tree the other two agree on, and too much besides; as read (tallest pixel a 2 m cell) it fails its own bar, but it says the tree model misses trees and one lot's trees are gone, 2026-09-26

Run 36207546426, workflow 23, benchmark. The NAIP-CHM index read in 11 s and
had files over all 32 frames (NAIP 2021–2023); 29 with lidar, no read failed.
NAIP canopy = the TALLEST NAIP-CHM pixel in the 2 m cell is 2 m or more, not
the lidar's roof. Every H34/H37/H38 number reproduced.

| class | cells | NAIP canopy | lidar canopy (H38) |
|---|---|---|---|
| visible lawn | 29,386 | 21.8% | 13.6% |
| lawn under canopy | 1,734 | **88.9%** | 62.7% |
| not lawn, under canopy | 14,488 | 97.5% | 89.2% |
| not lawn, visible | 25,350 | 25.8% | 18.7% |

| tree model / lidar | cells | NAIP says canopy |
|---|---|---|
| both | 14,006 | **99.3%** |
| lidar only | 8,759 | 76.0% |
| model only | 2,216 | 79.4% |
| neither | 45,977 | **13.7%** |

**The bar written before the run: 'both' over 80% (99.3%, passed) and
'neither' under 10% (13.7%, FAILED).** As read, NAIP-CHM calls a fifth of the
visible lawn canopy. The likely cause is the read, not the data: the tallest
of ~11 NAIP pixels decides a 2 m cell, so a crown's edge or an eave flags the
cell — the lidar's own canopy uses its tallest return too, but four returns a
cell, not eleven pixels. The same bias sits on the tie-breaker, because the
cells where the two disagree are edge cells. So 76% and 79% cannot yet be read
as "missed tree" and "stale lidar".

**Two lots read clearly anyway.** Kent 8,626 (the owner's strip): 724 m²
lidar-only, **77% still canopy in 2022** — a tree-model miss, as the owner
said. B28 NC 10,556: 1,482 m² lidar-only on a lot where the tree model found no
canopy at all, **only 20% still canopy in 2022** — trees gone since the 2016
flight, and the only lot below 60%.

**Frames with no lidar** (m², tree model and NAIP both / model only / NAIP
only): Island County 19,932: 429 / 150 / **830** — NAIP-CHM sees twice the
canopy the tree model does there, the lot the owner called the starkest
missed-lawn case; the two Maryland lots 0 / 0 / 291 and 367 / 24 / 571.

**Next, fixed before it runs:** the same read with NAIP canopy = at least
half the cell's NAIP pixels 2 m or more (cover, not the tallest pixel),
judged on the same bars ('both' over 80%, 'neither' under 10%).

### H39. The lidar veto fixes the pond and three more lots, moves no median, and makes no lot worse; it joins THE PLAN, 2026-09-25

Run 36182100031, `canopy: compare`, benchmark, roof and void from the point
cloud applied as "never lawn" after stage 3 (span 8 m, reach 1 m, 180°), a
fixed row per decoder. Decoder rows 28.5 / 29.8 / 24.3; head rows in the
36.5 / 32.1 state (H29). Lidar on 29 of 32.

| stage 1 | span (H33) | span + lidar veto | in sun, before → after | what the veto took of stage 3's lawn |
|---|---|---|---|---|
| no canopy | 27.0 / 22.5 / 24.8 | 27.0 / 22.4 / 24.8 | 39.7 → 35.2 | roof 102 m² tracer's lawn / 311 m² not; void 0 / 388 |
| canopy on lawn | 26.6 / 22.2 / 28.5 | 26.6 / 22.2 / 28.5 | 36.2 → 32.2 | roof 100 / 303; void 0 / 389 |
| canopy everywhere | 23.3 / 21.7 / 18.3 | 23.4 / 21.6 / 19.3 | 28.1 → 25.5 | roof 69 / 245; void 0 / 373 |

(headline / seen / inferred; 16, 16, 17 of 26 over SAM, unchanged.)

**Every lot the veto moved by a point or more moved the right way:**

| lot | no canopy | on lawn | everywhere |
|---|---|---|---|
| Kent 72,863 (the pond) | 36.9 → **31.1** | 37.1 → **31.3** | 34.1 → **28.6** |
| Kent 8,626 | 51.6 → **40.1** | 51.3 → **41.0** | 47.4 → **36.9** |
| Utah 13,689 | 86.1 → 83.7 | 68.8 → 65.8 | — |
| Wayne 12,426 | 36.2 → 34.5 | 33.8 → 32.2 | 42.6 → 41.0 |
| Prince William 3,429 | — | — | 91.1 → 84.0 |

**The prediction (H38) held on three of four clauses.** Medians moved by 0.0 /
0.0 / +0.1 (under half a point); Kent 72,863 came down 5.5–5.8 points (3 to
8 predicted); no lot got worse by a point or more. **The fourth failed:** the
roof veto took 69–102 m² of the tracer's lawn, not under 20. The prediction
was bad arithmetic, not a surprise in the data — H38's own shares (0.2% of
29,386 visible-lawn cells, 0.5% of 1,734 under canopy) already put ~200 m² of
lawn under roof. It took three times as much wrong lawn as right, and
on the everywhere decoder the cost shows as a point on the inferred column
(18.3 → 19.3); on the other two it does not show at all.

**The void is the pond, exactly:** 373–389 m² taken, all of it not-lawn,
~5.8% of Kent 72,863's 6,769 m² — the whole of the point it gained.

**Kent 8,626 was not predicted** and is the largest gain: 10–11 points on
every decoder, from the roof mask alone (void is 0 there). Some 80 m² of roof
was being called lawn on that lot. Which roof, and whether it is under the
tree strip the tree model missed (the owner, 2026-09-25), the pictures have to
say; the pictures of this run were drawn for everywhere + span *without* the
veto (it lost the headline by 0.1), in
`runs/2026-09-25-1739-edt-scalemae-large-896px`.

**Adopted.** The lidar veto joins THE PLAN's row: decoder (canopy on lawn) +
stage 3 span + roof and void never lawn. It moves no median and cannot be
said to beat anything at 32 lawns (H7); it is adopted because it is right
where it acts (3:1 by area, four lots better, none worse) and costs nothing
where it does not. Three lots in 32 have no point cloud and are unaffected.

### H38. The lidar finds roofs and the pond cleanly and almost never touches lawn; its own canopy is not clean, and sees far more trees than the tree model, 2026-09-25

Run 36179937840, workflow 23, benchmark, 29 of 32 frames (the same three
missing), every H34 and H37 number reproduced. Three masks, thresholds fixed
in the code before the run: **roof** = no ground return, top 2.5 m or more,
all returns within 1.5 m, three returns at least; **void** = nothing back
over a 6 m square, or mostly water-classed; **lidar canopy** = 2 m or more
and not roof. Share of each class's 2 m cells under each, pooled:

| class | cells | roof | void | lidar canopy |
|---|---|---|---|---|
| visible lawn | 29,386 | **0.2%** | **0.0%** | 13.6% |
| lawn under canopy | 1,734 | **0.5%** | **0.0%** | 62.7% |
| not lawn, under canopy | 14,488 | 1.0% | 0.0% | 89.2% |
| not lawn, visible | 25,350 | **26.2%** | 0.7% | 18.7% |

**Roof is clean.** A quarter of the visible not-lawn is roof by this test and
a fifth of a percent of the visible lawn; the most lawn it touches on any lot
is 18 cells (Ottawa 158,244). But it is almost never under a tree (1.0% of
not-lawn under canopy): a roof with a crown over it has ground returns or
spread, so stage 3 was not filling roofs much to begin with. Its use is a
veto on stage 1, where the detector calls roof lawn.

**Void found the pond and nothing else.** 186 cells of not-lawn on Kent
72,885 sq ft (the owner's pond, 2026-09-25) and zero lawn cells on any lot;
every other lot reads 0 in the not-lawn column too.

**The lidar's canopy is not a replacement for the tree model, as built.**
13.6% of visible lawn sits under it. Three explanations, not separated here:
trees the tree model missed over lawn the tracer drew, trees felled since the
flight (2011–2020), and 2 m cells catching a crown's or an eave's edge. Inside
the line the two agree on 14,006 cells (IoU 0.56); **the lidar alone calls
8,759 cells canopy, the tree model alone 2,216.** Kent 8,626 (the owner's
missed strip): 724 m² lidar-only, 0 model-only. NC 115,085: 6,711 m²
lidar-only. B28 NC 10,556: 1,482 m² lidar-only on a lot where the tree model found
no canopy at all. As a *check* on the tree model's misses it points the right
way on the one lot the owner named; the pictures would have to say which of
the three explanations the rest are before it becomes a rule.

**Next, built with this finding: the lidar veto.** Workflow 14 applies roof
and void as "never lawn" after stage 3 over the span row, per decoder, and
prints what each took of the tracer's lawn against lawn the tracer did not
draw, in m², and every lot moved by a point or more. **Prediction, written
before the run:** the medians move by under half a point; Kent 72,885 comes
down by 3 to 8 points (the pond, if the detector called it lawn); no lot gets
worse by more than a point; the roof veto takes under 20 m² of the tracer's
lawn in all.

### H37. The understory does not tell a wood from a lawn tree: weaker than height, and as strong in the open as under the trees, so the woods question is closed, 2026-09-25

Run 36168701134, workflow 23, benchmark, 29 of 32 frames read (the same
three missing as H34). New layer: of the returns from below 3 m, the share
from 0.5 to 3 m above ground, per 2 m cell and summed over a 6 m square.
Every other number in the log matches H34 to the digit (densities,
intensities, heights, the other three AUCs), so the read is the same cloud.

| AUC, lawn against not-lawn | under canopy, pooled | under canopy, middle lawn (10 lots) | visible, pooled | visible, middle lawn (29) |
|---|---|---|---|---|
| height (H34, same run) | 0.23 | 0.32 | 0.35 | 0.34 |
| understory, per cell | 0.45 | 0.45 | 0.43 | 0.40 |
| understory, over 6 m | 0.38 | 0.35 | 0.38 | 0.33 |

**The direction is the one the theory wanted** (lawn under a tree has less
understory than not-lawn under canopy) **and the size is not.** Over 6 m it
reads 0.35–0.38, weaker than height's 0.23–0.32 — and height already failed
as a rule twice (H35, H36). Per cell it is nearly a coin toss. Three things
say it is not a woods signal in particular:

- **It separates about as well in the open (0.33–0.38) as under the trees.**
  Whatever it sees there — shrubs, beds, fences, the eaves of a house — is
  not specific to a wood's floor.
- **The median share is 0.00 in every class.** Most cells have no return at
  all from 0.5–3 m, lawn or not; the AUC is carried by a minority of cells.
  At 1–2 points/m² (Kent and Kentucky, the wooded lots) and flown leaf-off,
  a 2 m cell holds a handful of returns, most of them ground.
- **It flips lot to lot**: over 6 m, 0.10 to 0.76 across the ten lots with
  20+ cells each side; three read above 0.5 (0.58, 0.73, 0.76). That is the
  pattern H34 found for ground intensity and called a coin toss.

**The woods question is closed for this instrument.** Height alone is a trade
the wrong way (H35), height and size is nothing (H36), and the understory is
weaker than height. What is left would be a combination of layers trained
per clump, on a benchmark with ten wooded lots in it, which is fitting noise.
THE PLAN's row stays span without woods. **Next: the roof mask** (no ground
return and several metres of height, a building whatever the photograph
shows), which is stage 4's stated job and has not been used.

### H36. Tall AND big does nothing useful: a size floor switches the woods rule off where it helped and leaves it on where it hurt, and Prince William is not fixed; two identical runs agree to the decimal, 2026-09-25

Runs 36151868024 and 36152888443, both at 262efc2, both `canopy: compare`
on the benchmark, launched ten minutes apart by two sessions by accident.
**From the first score line to the last, the two logs are identical** —
every sweep cell, every per-lawn figure, the badly-wrong table. Decoder rows
28.4 / 29.8 / 24.3 (the seventh and eighth exact repeats). Lidar on 29 of 32.

The size sweep at 12 m, headline / seen / inferred, beside span alone and
12 m at any size (H35):

| stage 1 | span alone (H33) | 12 m, any size | 12 m, ≥ 200 m² | ≥ 500 m² (the fixed row) | ≥ 1,000 m² |
|---|---|---|---|---|---|
| no canopy | 26.9 / 22.5 / 24.8 | 27.4 / 21.9 / 29.8 | 26.9 / 21.9 / 24.8 | 26.9 / 21.9 / 24.8 | 26.9 / 21.9 / 24.8 |
| canopy on lawn | 26.6 / 22.2 / 28.5 | 28.2 / 22.1 / 31.3 | 26.6 / 22.2 / 28.5 | 26.6 / 22.2 / 28.5 | 26.6 / 22.2 / 28.5 |
| canopy everywhere | 23.3 / 21.7 / 18.3 | 23.3 / 21.0 / 26.0 | 23.3 / 21.0 / 23.8 | 23.3 / 21.0 / 23.8 | 23.3 / 21.0 / 23.8 |

**The prediction failed on its first and main clause.** Prince William
3,429 sq ft under the fixed woods row: 67 / 60 / 91% — exactly span alone,
on every decoder. It is not fixed. (H35's "stays fixed" assumed 12 m fixed
it, and the per-lawn table was only ever printed for 6 m; whether 12 m at any
size fixed it is not known.) The hidden column came back to span alone on
two decoders, but only because on those two the floored rule does nothing at
all — canopy on lawn reads span alone to the decimal. On the everywhere
decoder the floored rule still costs 5.5 points of hidden lawn (18.3 →
23.8) for 0.7 of visible (21.7 → 21.0). Median unmoved, 16 / 16 / 17 of 26
over SAM, as span alone.

**200, 500 and 1,000 m² are identical on every decoder, to the decimal.** No
tall clump on the benchmark falls between 200 and 1,000 m² in a way that
changes a score. Everything the 12 m rule did on the first two decoders was
done by clumps under 200 m², and a 12 m clump under 200 m² is a single crown
— which is what the floor was built to spare, and which on Prince William is
evidently the part that was doing the fixing. *Why* there are no clumps in
between is not measured; that canopy clumps join up — a lawn tree whose crown
touches the wood edge is part of the wood's clump — would explain it and is
SPECULATION. It is the owner's objection of 2026-09-25 in concrete form: a
big lawn tree and a wood cannot be told apart by size, and on these lots
size mostly measures what touches what.

**Not changed.** THE PLAN's row stays span without woods; the canopy default
stays on lawn. Height alone is a trade the wrong way (H35); height and size is
nothing on two decoders and the same trade on the third. **Next, as decided
before this run: the ground UNDER the crown** — lidar returns in the 0.5–3 m
band beneath the canopy, which mown grass under a lawn tree lacks and a wood's
understory is full of. Measured first as an AUC in workflow 23, the way H34
measured height, before any rule is built on it.

**Pictures**: `runs/2026-09-25-1324-edt-scalemae-large-896px` (and the twin
run's folder), drawn for everywhere + span.

### H35. The woods rule fixes Prince William under every decoder and gives back the hidden lawn, because a lawn tree is tall too: 6 m was the wrong cutoff, 12 m is a trade, and "tall AND big" is the next shape, 2026-09-25

Run 36111426731, `canopy: compare`, the woods rule swept at H off / 4 / 6 /
8 / 12 m at the span cell for every decoder, and a fixed row at 6 m. Lidar
height on 29 of 32 lawns. Decoder rows 28.4 / 29.8 / 24.3 (sixth exact
repeat). Headline / seen / inferred:

| stage 1 | off (span, H33) | 4 m | 6 m (the fixed row) | 8 m | 12 m |
|---|---|---|---|---|---|
| no canopy | 26.9 / 22.5 / 24.8 | 26.4 / 20.7 / 43.3 | 27.1 / 21.3 / 42.1 | 27.4 / 21.3 / 37.4 | 27.4 / 21.9 / 29.8 |
| canopy on lawn | 26.6 / 22.2 / 28.5 | 27.0 / 20.9 / 42.3 | 26.4 / 21.4 / 42.1 | 27.5 / 21.4 / 39.4 | 28.2 / 22.1 / 31.3 |
| canopy everywhere | 23.3 / 21.7 / 18.3 | 23.3 / 19.3 / 43.7 | 23.7 / 19.3 / 43.6 | 23.3 / 19.3 / 31.8 | 23.3 / 21.0 / 26.0 |

The tail, span → span + woods at 6 m: **Prince William 3,429 sq ft 67 → 30
(none), 60 → 28 (on lawn), 91 → 35 (everywhere)** — the best that lot has
ever read under any row, from 261–319% under the heads. Kent 22,481: 36 →
40, 40 → 43, 38 → 40. NC 7,945 and the rest unchanged. Over SAM: 17 of 26
on every decoder (from 16, 16, 17).

**The prediction was half right.** Prince William came down under every
decoder, and the median did not move (+0.2, −0.2, +0.4). Kent did not come
down: span had already fixed it (H33), and the woods rule takes 2 to 4
points back there by removing lawn the tracer put under tall trees. And
the visible-ground column improves by a point on every decoder — **19.3 on
the everywhere decoder, the best any row has read, within a point of its
cleared 18.6.**

**What it costs: the hidden lawn, nearly all of it.** Inferred 24.8 → 42.1,
28.5 → 42.1, 18.3 → 43.6 at 6 m — back to the "cleared plus bridge" level
of 42–43 (H30). **A lawn tree is tall.** H34's 3.7 m for "lawn under
canopy" was a median over CELLS, and the cells at a crown's edge are low;
the woods rule takes a clump's median, which is the crown's, and a mature
oak standing in a lawn is 15 m. So at 4, 6 and 8 m the rule called most of
the tracer's own lawn trees woods and would not fill under them. **At 12 m
the trade is gentler**: seen 21.9 / 22.1 / 21.0 (still better than span
alone), inferred 29.8 / 31.3 / 26.0 (5 to 8 points worse than span alone),
headline within noise. There is no H at which height alone keeps both.

**The next shape, built and unmeasured: tall AND big.** A wood is many
trees. A single crown, however tall, is not one, and the two Kent lots' 4,500
and 7,000 canopy cells of woods are. `woods()` now takes a size floor as
well, workflow 14 sweeps it at 12 m over any size / 200 / 500 / 1,000 m²,
and the fixed "+ stage 3, span, woods" row moves to 12 m and 500 m², chosen
after the height sweep and before the size sweep. Prediction: Prince
William stays fixed (its woods are big), the hidden column comes back to
within two points of span alone, the visible column keeps most of its
point.

**Not changed:** THE PLAN's row stays span without woods; the canopy default
stays on lawn. The woods rule at 6 m is measured as a trade the wrong way on
the hidden column and is not adopted; its Prince William result is the
reason to keep going.

**Pictures**: `runs/2026-09-25-0626-edt-scalemae-large-896px`, drawn for
everywhere + span (the best median), amber for stage 3's additions.

### H34. The lidar reaches the ground under every canopy, and what it tells apart is not the ground but the TREES: lawn sits under 4 m of canopy, the woods under 7, 2026-09-25

Run 36095115276, workflow 23, the first read of the 3DEP point clouds over
the benchmark frames: 29 of 32 read (three have no project over them, H16's
Maryland gap and one more), 3 minutes for all of them, 2 m cells.

**The instrument does what E8 said it would.** Middle lawn: 2.4 points/m²,
1.05 ground returns/m² (0.6 to 9.9 across the corpus; the Carolinas are flown
at 10 to 30 points/m², Kent County and Kentucky at 1 to 2). **Under the
canopy 95 to 100% of 2 m cells have at least one ground return**, against
66% on visible not-lawn, which is roofs. So the pulses reach the ground
between leaves everywhere we have trees, at about four returns a cell.

Per class, middle lawn:

| | ground returns/m² | cells with ground | ground intensity | height above ground |
|---|---|---|---|---|
| visible lawn | 1.34 | 99% | 28,650 | 0.1 m |
| lawn under canopy | 1.14 | 100% | 26,911 | **3.7 m** |
| not lawn, under canopy | 0.98 | 95% | 25,898 | **7.3 m** |
| not lawn, visible | 0.70 | 66% | 24,850 | 1.6 m |

Can each layer tell lawn from not-lawn? AUC, 0.5 is a coin toss:

| | ground density | ground intensity | height |
|---|---|---|---|
| under canopy, pooled | 0.68 | 0.45 | **0.23** |
| under canopy, middle of 10 lawns with 20+ cells each side | 0.59 | 0.61 | **0.32** |
| visible, pooled | 0.68 | 0.79 | 0.35 |
| visible, middle of 29 | 0.74 | 0.77 | 0.34 |

**Ground intensity is not the third mask.** In the open it tells lawn from
pavement and roof moderately (0.77 to 0.79, lawn brighter), which is the
sanity check passing. Under the canopy it is a coin toss pooled (0.45) and
inconsistent lawn by lawn: 0.20, 0.40, 0.43 on some, 0.74, 0.77, 0.83 on
others, direction and all. Intensity is not calibrated across projects or
even flight lines, and four returns a cell is thin. It does not answer
"driveway under a tree", which was the case stage 4 was written for, and no
amount of rules over it will.

**Ground density is a weak yes** (0.68 pooled, 0.59 middle): lawn under
canopy gets slightly more pulses to the ground than the woods do. Real,
small, and it is the same fact as the next one seen from below.

**HEIGHT IS THE SIGNAL, and it is a fact about the trees, not the ground.**
Lawn under canopy sits under 3.7 m of canopy on the middle lawn; canopy the
tracer did not call lawn is 7.3 m tall. Pooled AUC 0.23 (0.77 in the
"lower means lawn" direction), 0.32 on the middle lawn, and the direction
holds on most lawns with the cells to say (0.08, 0.09, 0.10, 0.16, 0.21,
0.30, 0.31 against 0.55 to 0.76 on a few). This is the owner's suggestion of
2026-09-25 measured — "maybe the actual geometry of the tree needs to be
taken into account" — and it is the distinction every stage 3 rule has been
groping for: a tree standing in a lawn, a row along a drive, an edge tree, is
SHORT; the woods are TALL. Reach could not tell them apart because it only
knew where the canopy was, not what it was.

**Two things the lidar gives for free that it was not asked for.** Roofs:
a cell inside the line with no ground return and 3 to 10 m of height is a
building, whatever the photograph shows (66% of visible not-lawn cells
have a ground return; the rest are roofs). And the canopy's height, which
the tree model (a picture) cannot know.

**The caveats travel with it.** The lidar is 2011 to 2020 and the
photographs are not dated (H16); tall woods are stable over ten years and
young lawn trees are not, which biases the height rule toward being right
about the woods and wrong about a sapling. Three Bullitt County lots match
`KY_FullState`, undated. The pooled figures are dominated by the two Kent
lots with 4,500 and 7,000 canopy cells of woods — which are also the lots
the tail table is about.

**Verdict: stage 4 as "lidar finds the hidden pavement" stops here; stage 4
as "lidar says which canopy is woods" is worth one rule.** Speculation, to
be measured next: a fourth stage 3 rule, WOODS — a canopy clump whose median
height is above H metres is woods and is never filled by span, reach or
bridge — swept over H in workflow 14 with the lidar layers read in.
Prediction, written before the run: it takes the everywhere decoder's
Prince William and Kent lots down without touching the median, because the
median lot has no woods. The layers are in the run's artifact and the reader
is a step any workflow can add.

### H33. Span, the owner's rule, is the first stage 3 that does not creep into the woods: visible ground within two points of cleared, the wooded lots the best any row has read, and half of reach's hidden gain, 2026-09-25

Run 36078758001, `canopy: compare`, span swept 4 / 8 / 12 m × reach 0 / 1 /
1.5 m (bridge over 180°) over all three decoders, and a fixed row per
decoder at span 8 m, reach 1 m, chosen before the sweep. Decoder rows
28.4 / 29.8 / 24.3 (fifth exact repeat). Headline / seen / inferred:

| stage 1 | cleared | reach 3 m (H30's row) | **span 8 m + reach 1 m** | span 12 m + 1.5 m |
|---|---|---|---|---|
| no canopy | 26.4 / 20.3 / 93.6 | 26.3 / 26.7 / 12.2 (17 of 26) | 26.9 / 22.5 / 24.8 (16) | 26.1 / 23.7 / 22.3 |
| canopy on lawn | 27.9 / 20.7 / 93.7 | 25.8 / 26.0 / 12.2 (17) | 26.6 / 22.2 / 28.5 (16) | 25.8 / 23.0 / 26.2 |
| canopy everywhere | 23.3 / 18.6 / 90.2 | 24.2 / 22.6 / 11.7 (18) | 23.3 / 21.7 / 18.3 (17) | 23.3 / 22.2 / 16.3 |

The wooded lots, reach 3 m → span 8 m + 1 m: Prince William 3,429 sq ft
89 → 67 (none), 80 → 60 (on lawn), 130 → 91 (everywhere); Kent 22,481
37 → 36, 39 → 40, **50 → 38**; NC 7,945 25 → 22, 25 → 21, 25 → 21.

**On visible ground span does what reach could not.** Reach cost 5 to 6
points of visible ground on every decoder; span costs 1.5 to 3 (22.5,
22.2, 21.7 against cleared 20.3, 20.7, 18.6). And the woods creep is gone
from the tail: the everywhere decoder's Kent lot goes from 50% to 38%,
which is where the on-lawn decoder reads it, and every decoder's Prince
William lot improves by 20 to 40 points. These are the best figures any
row has read on those lots.

**Under the trees it gets about half of what reach got.** Inferred 24.8 /
28.5 / 18.3 against reach's 12.2 / 12.2 / 11.7, from 90+ cleared. The half
it does not get is hidden lawn with visible lawn on ONE side only: the
traced strip along a wood edge (H32's ambiguity, which no rule over two
masks resolves) and lawn that runs along a house under trees, where the
boundary is the house's setback rather than a join between two lawns (the
owner's 2026-09-25 picture, the blue line). A bigger span with a little
more reach (12 m, 1.5 m) reads a point better on the headline and the
hidden column on every decoder and a point worse on visible ground: the
same trade at a gentler slope, and inside noise of the fixed cell.

**On the headline it is a wash**: +0.6, +0.8, −0.9 against reach, one
lawn fewer over SAM on each decoder, all inside seed noise (H28). The
headline does not decide between them; the columns and the tail do, and
they say span.

**Decided:** THE PLAN's row is now "+ stage 3, span" (8 m, 1 m, 180°),
because it is the rule as the owner stated it, it is the only stage 3
that leaves the woods alone, and the headline cost is noise. The reach
row stays in the table as the comparison. The canopy default stays on
lawn: the everywhere decoder + span reads the best headline and visible
ground of any row (23.3, 21.7) and its Kent lot is fixed, but its Prince
William lot is still 91% against on-lawn's 60% — the visible gaps inside
a wood again (H31), which span rightly does not touch and clearing does
not remove.

**Pictures**: `runs/2026-09-24-2251-edt-scalemae-large-896px`, drawn for
everywhere + span, the first with stage 3's additions in amber.

**Speculation, unmeasured.** The setback rule: where visible lawn runs
along a hard surface and enters canopy, continue the lawn's boundary
under the trees at the same distance from that surface. It is the owner's
blue line, it is what the half span misses on lots like the one in the
picture, and it is a rule over three masks (lawn, canopy, hard surface),
which stage 4 is about to provide.

### H32. Enclosure takes the seen column back to the cleared figure and gives back most of the hidden gain: the hand-marked inferred ground is itself a wood edge, and geometry cannot tell a traced edge from an untraced one, 2026-09-24

Run 36054887434, `canopy: compare`, stage 3 and the enclosure rule swept
over all three decoders (decoder rows 28.4 / 29.8 / 24.3, fourth exact
repeat). The fixed cell (reach 3 m, bridge over 180°, sides 0) against the
same cell with enclosure at 4 of 8 sides, headline / seen / inferred:

| stage 1 | cleared, no rules | reach 3 m, 180° | + enclosure 4 of 8 | 6 of 8 |
|---|---|---|---|---|
| no canopy | 26.4 / 20.3 / 93.6 | 26.3 / 26.7 / 12.2 | 27.6 / 21.4 / 28.2 | 27.9 / 21.3 / 41.1 |
| canopy on lawn | 27.9 / 20.7 / 93.7 | 25.8 / 26.0 / 12.2 | 27.8 / 21.5 / 33.5 | 27.5 / 21.4 / 41.3 |
| canopy everywhere | 23.3 / 18.6 / 90.2 | 24.2 / 22.6 / 11.7 | 23.3 / 20.8 / 20.9 | 23.3 / 20.1 / 35.9 |

(Reach 1.5 and 4.5 m with enclosure are within a point of the 3 m cells on
every column; the full tables are in the run's log.)

**On the seen column it does exactly what it was built to do.** Reach had
cost 5 to 6 points of visible ground on every decoder (20.3 → 26.7, 20.7 →
26.0, 18.6 → 22.6); with lawn required in four of eight directions the
column comes back to within a point of the cleared figure (21.4, 21.5,
20.8). So the seen-column cost of reach is, as H30 guessed, cells with lawn
on one side only: the edge of the untraced woods.

**And it gives back most of the hidden gain**: 12.2 → 28.2 and 33.5 on the
two decoders that do not guess under trees, 11.7 → 20.9 on the one that
does. What the rule loses is ONE-SIDED ground: canopy with visible lawn in
three or fewer of eight directions, which is a wood edge, or a tree against
a house or a driveway. The size of the loss says a large share of the
marked inferred ground within 3 m of lawn is of that kind. *(First written
as "the inferred ground is mostly a wood edge"; the owner corrected it on
2026-09-25: plenty of the marked ground is isolated trees in lawns, trees
at the edge of a house, rows of a few trees with lawn either side. Those
pass the four-sides test and were never the loss. The measurement is about
what the rule dropped, not about what the tracer marks.)* For the one-sided
kind, no rule over two masks can tell a traced wood edge from an untraced
one: the tracer's mark is the only thing that distinguishes them, and stage
3 does not have it at inference time. Reach fills both alike. **But the rule
itself was the wrong shape** — it counted directions with lawn without
asking whether they were opposite each other, so it could not express the
owner's actual rule, which is that lawn under canopy joins the lawn on
either side of it. That rule is `span` (below, H33's run).

**Six of eight is the bridge alone.** Its inferred column (36–41) is the
reach-0-with-bridge cell's (42–43): nothing reach adds survives six sides
except a tree standing in a lawn, which the bridge already fills.

**On the headline** enclosure costs the no-canopy and on-lawn decoders 1.3
to 2 points (the hidden loss outweighs the visible gain on the median lot)
and moves the everywhere decoder not at all: its headline reads 23.3 in nine
of the twelve sweep cells and every enclosure cell. The median lot has
little canopy at stake, so the everywhere decoder's headline is not a
measure of stage 3 and should not be read as one; its seen and inferred
columns are.

**The tail was not measured under enclosure** — the badly-wrong table
prints the fixed rows only, and enclosure was built for the everywhere
decoder's wooded lots. Fixed for the next run: a second fixed row per
decoder, "+ stage 3, 4 sides", so the tail table carries it.

**What the tail table said about the fixed rows.** Seven lots over 60%
wrong under some row; every row's figure beside them. Two kinds:

| lot | eye (head) | both | none | on lawn | everywhere | none + s3 | on lawn + s3 | everywhere + s3 |
|---|---|---|---|---|---|---|---|---|
| Prince William 3,429 | 269 | 261 | 182 | 94 | 319 | 89 | 80 | 130 |
| Kent 22,481 | 85 | 79 | 38 | 42 | 170 | 37 | 39 | 50 |
| NC 7,945 | 65 | 84 | 38 | 36 | 41 | 25 | 25 | 25 |
| Utah 13,689 | 39 | 36 | 86 | 69 | 86 | 86 | 69 | 86 |
| NC 10,556 | 48 | 42 | 74 | 69 | 79 | 74 | 69 | 79 |

The first three are canopy lots: stage 3 helps every decoder on them, and
the everywhere decoder's remaining excess on Kent and Prince William is
the visible gaps inside the woods (H31). **The last two are not canopy
lots at all**: stage 3 does not move them (86 → 86, 74 → 74), and the old
head reading colour and texture is 30 to 50 points BETTER than every
decoder on them. The owner read the pictures (2026-09-25): **Utah 13,689 is
the worst photograph in the corpus**, so it says nothing about any
detector. **NC 10,556 is one of the most straightforward lawns in the
corpus** — good imagery, almost no shadow, no trees, one continuous section
with a couple of objects in it — **and the grass is semi-dormant.** SAM
struggled with it too when its threshold was low. So this is a stage 1
finding: the decoder over Scale-MAE reads dormant grass as not-lawn on a lot
where colour reads it as lawn. Speculation: too few dormant lawns among 32
for the decoder to learn the look, which more maps would fix, and which the
colour control was never in a position to be fooled by.

**Not changed:** the fixed cell (reach 3 m, 180°) and the on-lawn default.
Stage 3 is at the floor these rules can reach: what remains under the trees
is the traced/untraced ambiguity above, and what remains on visible ground
is stage 1's, led by the two lots in the last two rows.

### H31. Stage 3 over all three decoders: the everywhere decoder is the best input on the median and the worst on the wooded lots, and H30's guess about the no-canopy decoder measured as nothing, 2026-09-24

Run 36035231729, `canopy: compare` with stage 3 in the code: one extraction,
seed 7, three decoders, each scored alone and with stage 3 (reach 3 m, bridge
over 180°). Head rows 36.5 / 32.1 this time — the other of H28's two states —
and every decoder row matched again to the decimal (28.5 / 29.8 / 24.3), which
is H29 confirmed a second way.

| stage 1 | alone: headline / seen / inferred | over SAM | + stage 3 | over SAM |
|---|---|---|---|---|
| no canopy | 28.5 / 23.0 / 28.8 | 15 of 26 | 26.4 / 26.7 / 12.2 | 17 of 26 |
| canopy on lawn | 29.8 / 24.3 / 34.5 | 15 of 26 | 25.8 / 26.0 / 12.2 | 17 of 26 |
| canopy everywhere | 24.3 / 23.4 / 18.7 | 16 of 26 | **24.2 / 22.6 / 11.7** | **18 of 26** |

Sweep over the no-canopy decoder, headline / seen / inferred: cleared, no
rules 26.5 / 20.3 / 93.6 (from 28.5); reach 3 m + 180° 26.4 / 26.7 / 12.2;
the rest within a point of H30's table on the on-lawn decoder.

**H30's speculation (2) measured as nothing.** The no-canopy decoder has the
best visible-ground column of the three alone (23.0), so I expected stage 3
over it to read best. It reads 26.4 against the on-lawn decoder's 25.8, and
26.7 against 26.0 on visible ground: the wrong direction, inside noise. Two
decoders that differ by a point on visible ground do not differ once the
canopy is cleared and re-filled by the same rules. That is the third idea in
this file argued for and then measured as nothing.

**The everywhere decoder + stage 3 is the best row on every median.** 24.2
headline, **22.6 on visible ground (the best any row has read)**, 11.7 under
the trees, **18 of 26 over SAM (the most any row has)**. Stage 3 took it from
24.3 to 24.2 on the headline, which is nothing, and from 23.4 to 22.6 on
visible ground and 18.7 to 11.7 under the trees, which is the canopy question
answered by the rules instead of by the decoder's guess.

**And it is the worst row on the wooded lots.** Kent 22,481 sq ft 49.8%
(on-lawn + stage 3: 39.1%), Prince William 3,429 130% (80%), Utah 86% (69%),
NC 10,556 79% (69%). Stage 3 clears every CANOPY cell, but the everywhere
decoder also claims lawn on the visible gaps inside a wood — understory, the
tree model's holes — and those are not canopy, so they survive the clearing
and the reach grows from them. The on-lawn decoder learned that the untraced
woods are not lawn and does not claim the gaps. **Median against tail:** the
everywhere decoder wins on the lawn in the middle of the table by 1.6 points
and loses on the three lots the owner reads by 10 to 50. The owner has said
which of those matters ("counting buildings as lawn" and the creep into the
woods were the two things worth writing about), so the default does not move
on this run.

**Not changed:** workflow 14's canopy default stays on lawn. **What would
settle it:** the enclosure rule (H30, built) is aimed at exactly the reach's
creep into the woods, and the next run prints it for all three decoders, with
a table of every lot any row gets more than 60% wrong so the tail is read
beside the median rather than from one row's per-lawn list.

### H30. Stage 3 measured: clearing the canopy is worth 3.6 points on visible ground, reach trades visible for hidden, and the plan's own row reads 25.8% with the wooded lots intact, 2026-09-24

Run 36020948046, the first with `tools/stage3.js` in it: the on-lawn decoder
(seed 7, canopy on lawn, 29.8 / 24.3 / 34.5 — reproduced to the decimal for
the third time) with stage 3 swept over its masks. Each cell is headline /
seen / inferred, the median lawn:

| rim | reach 0 m | reach 1.5 m | reach 3 m | reach 4.5 m |
|---|---|---|---|---|
| no bridge | 27.9 / 20.7 / 93.7 | 28.9 / 22.0 / 38.6 | 25.9 / 26.0 / 21.7 | 26.8 / 29.8 / 7.0 |
| > 180° | 27.1 / 21.4 / 42.3 | 26.7 / 22.0 / 29.4 | **25.8 / 26.0 / 12.2** | 26.8 / 29.8 / 7.0 |
| > 126° | 29.5 / 23.7 / 21.0 | 28.2 / 25.2 / 12.2 | 28.2 / 28.1 / 11.2 | 28.1 / 30.2 / 6.1 |

Stage 1 as it came: 29.8 / 24.3 / 34.5.

**Clearing the canopy is a finding on its own.** Reach 0, no bridge — take
stage 1's answer and remove every canopy cell — reads 27.9 on the headline and
**20.7 on visible ground, from 24.3**. The seen column under on-lawn mode
includes the canopy the tracer never drew (the woods), and stage 1 was
claiming lawn there. Its opinion under a tree it was never taught about is not
evidence, and removing it is worth 3.6 points on the column stage 1 is
supposed to be judged on. Inferred goes to 93.7, as it must: nothing under a
tree is lawn until a rule puts it back.

**Reach trades the seen column for the inferred one, a metre at a time.**
Seen 20.7 → 22.0 → 26.0 → 29.8 as reach goes 0 → 1.5 → 3 → 4.5 m; inferred
93.7 → 38.6 → 21.7 → 7.0. The walk enters any canopy touching visible lawn,
and the edge of a wood touches the lawn as surely as a lawn tree does, so
reach fills the wood's edge too, and that edge is scored as seen. The
headline peaks at 3 m (25.9 / 25.8), which is where the two columns cross,
not where either is good.

**The bridge helps only where reach has not already filled the clump.** Over
180°: 27.9 → 27.1 at reach 0, 28.9 → 26.7 at 1.5, nothing at 3 (25.9 → 25.8),
identical at 4.5. Over 126° is worse on the headline in every column: it
fills clumps the tracer did not.

**The plan's own row: 25.8%, 17 of 26 over SAM, inferred 12.2.** The
"+ stage 3" row uses reach 3 m and 180°, fixed in the code before the sweep
was seen, so it is not chosen on the lawns it is scored on; the sweep says it
sits at the peak. Against the on-lawn decoder alone: 4.0 points better on the
headline, 22 points better under the trees, 1.7 worse on visible ground.
Against the everywhere decoder alone (H29: 24.3 / 23.4 / 18.7, 16 of 26):
the same headline within noise, better under the trees (12.2 against 18.7),
and **the wooded lots stay intact — Kent 22,481 sq ft 39.1% (170% under
everywhere), Prince William 3,429 80% (319%), Utah 69% (86%)**. It beats SAM
on more lawns than any row has. 25.8 against 24.7 is 1.04×, a tie at 32 lawns
(H7), and it is the first tie reached the way THE PLAN says to reach it:
stage 1 finds visible lawn, stage 3 decides under the trees.

**Speculation, unmeasured.** (1) The seen-column cost of reach is the edge of
the untraced woods; a reach that requires lawn on more than one side, or one
that stops at the property line, might keep the inferred gain without it.
*Built the same evening as `enclose` in `tools/stage3.js`: a reached cell
stays only with visible lawn in at least N of 8 directions within the reach
(a straight wood edge gives three at most, a tree in a lawn eight). Workflow
14 prints a second small table, sides 4 and 6 × reach 1.5 / 3 / 4.5 m, under
the sweep. Unmeasured until the run after the one below.*
(2) Stage 3 over the no-canopy decoder, whose visible-ground column is the
best of the three (H29), should read better than over the on-lawn one; the
run launched as this is written (`canopy: compare` with stage 3 in the code)
puts stage 3 over all three and answers it.

### H29. The canopy's credit is settled: 4.1 points, all of it under the trees, and the extraction was never in two states, 2026-09-24

Run 36013573532, `canopy: compare`: one extraction, seed 7, three decoders,
three rows. The scorer excluded canopy-on-lawn from the seen column for all
three, so the seen figures are on one set and comparable for the first time.

| decoder trained with | headline | seen | inferred | over SAM |
|---|---|---|---|---|
| no canopy | 28.4 | **23.0** | 28.8 | 15 of 26 |
| canopy on lawn | 29.8 | 24.3 | 34.5 | 15 of 26 |
| canopy everywhere | **24.3** | 23.4 | **18.7** | 16 of 26 |

Head rows 33.3 / 34.2 / 31.8 — the state that in H28 had only ever come with
"everywhere".

**The H28 confound is dissolved, and the wrong way round.** Every decoder row
reproduced its single-run figure to within 0.1 (none 28.5 → 28.4, on lawn
29.8 → 29.8, everywhere 24.3 → 24.3) although this run's head rows sit in the
state that H28 said belonged only to the everywhere runs. So the extraction
does not come in two states as far as the decoder can tell; whatever moves
the head rows by two points is in the head, not in the features, and the
alignment with the canopy setting was five coin tosses. The canopy's
28.5 → 24.3 stands: **4.1 points**.

**And all 4.1 of them are under the trees.** No canopy and everywhere read
the same on visible ground, 23.0 against 23.4, and differ by ten points on
the inferred ground, 28.8 against 18.7. Training with every canopy cell as
don't-care does not make stage 1 see lawn better. It makes stage 1 guess lawn
under trees that are near lawn, which the hand-drawn inferred marks reward
and the wooded lots punish (H28's pictures: Kent 22,481 sq ft 170%, Prince
William 3,429 319%). The headline is a median over lawns and the wooded lots
are a minority of them, so the median rises while four lots are badly wrong.

**On lawn is the worst of the three on every column**: 1.4 worse than none on
the headline, 1.3 on visible ground, 5.7 under the trees. Taking the on-lawn
trees out of training while the off-lawn trees stay in as hard "not lawn"
teaches "a tree is not lawn" and then asks about the lawn trees, where the
inferred marks say the opposite. It is still the mode that kept the wooded
lots intact as a stage 1 alone; it is not the mode that sees best.

**Which mode to keep.** THE PLAN puts the canopy question in stage 3, and
stage 3's first move is to clear the canopy from stage 1's answer (H30), so
what stage 1 says under a tree is discarded either way. Stage 1 is then to be
chosen on the seen column: none 23.0, everywhere 23.4, on lawn 24.3 — a
1.3-point spread, inside seed noise (H28). **No measured reason to prefer
any of the three as stage 3's input yet.** The default stays on lawn until
the run that puts stage 3 over all three (launched with this entry) says
otherwise. H27's "18.6% on visible ground" for the everywhere decoder was on
a smaller set (all canopy excluded) and is not comparable to the 23.4 here.

### H28. The decoder repeats to the decimal, the seed moves it a point, and the extraction comes in two states — so the canopy's credit is NOT yet attributable, 2026-09-24

> **Superseded by H29 (same day):** the compare run put the decoder rows
> back to within 0.1 in the other head state. The two states are the head's,
> not the extraction's, and the canopy's 4.1 points are attributable.

Three runs on `1rijjz2`, same settings as H27, launched the same minute
after the GitHub Actions allowance ran out and the account went to Pro:

| run | canopy mode | seed | colour | eye (head) | both (head) | decoder | over SAM | seen | inferred |
|---|---|---|---|---|---|---|---|---|---|
| 35945907897 (H26) | none | 7 | 33.3 | **36.5** | **32.1** | 28.5 | 15 of 26 | 29.7 | 30.5 |
| 36002884707 | on lawn | 7 | 33.3 | **36.5** | **32.1** | 29.8 | 15 of 26 | 24.3 | 34.5 |
| 35948780766 (H27) | everywhere | 7 | 33.3 | **34.2** | **31.8** | 24.3 | 16 of 26 | 18.6 | 60.4 |
| 36002889613 | everywhere | 7 | 33.3 | **34.2** | **31.8** | 24.3 | 16 of 26 | 18.6 | 60.4 |
| 36002894789 | everywhere | 11 | 33.3 | **34.2** | **31.8** | 25.5 | 16 of 26 | 18.6 | 64.1 |

**The decoder is deterministic.** 24.3% came back to the decimal, every
per-lawn figure identical, in the exact repeat (36002889613 against
35948780766). Three for three now (H26 was the first pair).

**The seed is worth about a point.** Seed 11 read 25.5% against seed 7's
24.3% on the headline; the seen column did not move (18.6 both). So a
decoder number carries about ±1 point of seed noise on top of H7's corpus
noise — small, and now measured rather than guessed.

**The extraction comes in two states, and that is the finding that matters.**
The head rows do not train on the canopy at all (checked: nothing in the
head's sampling or scoring reads the unseen mask except the seen/inferred
columns), yet they came back as 36.5/32.1 in both runs without
canopy-everywhere and 34.2/31.8 in all three runs with it — to the decimal
each time. There is no code path for that. What there is, is H13: the
Scale-MAE extraction does not always reproduce, and these look like two
stable outcomes of it (most plausibly different runner hardware taking
different arithmetic paths). Five runs landing 2–3 exactly along the canopy
setting has about a one-in-sixteen chance if the state is a coin toss per
run. **So the decoder's 28.5 → 24.3 (H27) is CONFOUNDED with the extraction
state: the "everywhere" decoders all read features from the state whose
head rows are 2.3 points better, and the "none" and "on lawn" decoders all
read the other.** Within the 36.5-state, no canopy 28.5 and on-lawn 29.8
differ by 1.3 — inside seed noise. The 4.2-point gain could be the canopy,
the extraction state, or both; three runs each side cannot say.

**On lawn against everywhere, on the lawns the pictures were about.** The
per-lawn figures are where the two modes actually differ, and they differ
in the direction the owner's reading predicted: Kent 22,481 sq ft 170.2%
(everywhere) → 41.5% (on lawn); Prince William 3,429 sq ft 319.4% → 94.3%;
Utah 86.4% → 68.8%. Those are the wooded lots where every-canopy-unseen let
the lawn creep into the trees. Elsewhere "everywhere" is a few points
better on most lawns, which is the median. On-lawn's seen column reads 24.3
against colour's 33.6 and the head's 34.3–37.0 on the same set — 9 to 13
points clear; the sets differ between modes (on-lawn's seen set includes
untraced canopy, everywhere's excludes all canopy), so the two decoders'
seen figures are not comparable to each other.

**What settles it: three decoders over ONE extraction.** Workflow 14's
`canopy` input gained `compare`: the same features, the same seed, the same
folds, and the decoder trained three times — no canopy, on lawn, everywhere
— scored as three rows in one table. The extraction state is then common to
all three and drops out. That run is launched as this is written.

### H27. With the canopy as unseen ground, the decoder reads 24.3% — under SAM's 24.7% for the first time, 2026-09-24

Run 35948780766: the H26 run with one change, the tree model's canopy mask
merged into each lawn's unseen ground (workflow 14's `canopy` input; the
owner's suggestion, see THE PLAN, stage 1). 32 of 32 lawns got a mask. The
decoder carries no weight on canopy cells; the SEEN column scores outside
them; the headline column is unchanged in what it counts.

| row | H26 (no canopy) | this run | over SAM | seen | inferred |
|---|---|---|---|---|---|
| colour and texture only (control) | 33.3% | 33.3% | 12 of 26 | 26.0 | 71.1 |
| the pretrained eye only (head) | 36.5% | 34.2% | 12 of 26 | 26.6 | 61.0 |
| both (head) | 32.1% | 31.8% | 13 of 26 | 27.4 | 67.5 |
| **the pretrained eye, decoder** | 28.5% | **24.3%** | **16 of 26** | **18.6** | 60.4 |
| SAM, same 26 lawns | 24.7% | 24.7% | | | |

**The decoder is the first row of ours under the SAM line**, by 0.4 points,
and over SAM on 16 of the 26 shared lawns. The run's own verdict printed
"AHEAD, BUT NOT BY ENOUGH TO TRUST", which is the right reading: 0.4 points
at 32 lawns is nothing (H7), and this is one run.

**On the visible ground — stage 1's own question — it reads 18.6%**, against
26.0–27.4% for the three head rows. That column now excludes canopy on every
lawn, so it is the first time it measures what the plan actually asks stage 1
for. The inferred column is enormous for every row (60–71%) because it now
holds every canopy cell, most of which the tracer did not draw as lawn, so
any lawn called there is an error; the decoder is still the best of the four
on it.

**How much of the 4.2-point gain is the canopy?** The head rows do not train
on the unseen mask, so they should not have moved — and they did, by −2.3
(eye alone) and −0.3 (both). That is H13: the extraction did not reproduce
byte for byte this time, and the head rows drifted inside the 3-point band
it allows. So of the decoder's 4.2 points, up to about 3 could be drift and
the rest is the canopy, or all of it is the canopy and the drift went the
other way; one run cannot say. **A repeat is owed before this is a finding
about the canopy rather than about the run.** What is not in doubt: the
decoder with canopy-as-unseen is at or under SAM on this corpus, and it is 7
to 9 points better on visible ground than any head row on the same eye.

Per lawn: the same three small lots carry the loss (Prince William 3,429 sq
ft 319% wrong, Utah 86%, NC 10,556 sq ft 79%), and the Kent 22,481 sq ft lot
went from 38% to 170% — still a fifth of SAM's 382% there, but it is the one
lawn the canopy change clearly hurt.

**What the pictures showed, which the table did not (the owner, reading the
`2356-edt` folder):** the lawn's edge crept deeper into the wood lines. The
mechanism is plain once said. The tracer's inferred marks say "probably some
grass under these edge trees, not deeper in the woods"; woods they never drew
were weighted not-lawn examples, the decoder's only lessons in what a forest
looks like. Making EVERY canopy cell don't-care threw those lessons away, so
the decoder had nothing pushing back at a tree line. The Kent lot going 38 →
170% is the same thing in a number. **Since 2026-09-24 the default is "on
lawn": canopy is unseen only where the tracer drew lawn (marked inferred or
not); canopy they left out stays what they said, not lawn.** "Everywhere" is
kept as an option so the two can be measured on the same corpus; the run is
queued behind the H27 repeats. Pictures in
`runs/2026-09-23-2356-edt-scalemae-large-896px`. Decoder 52 s a fold (28
min), the canopy step 11 min.

### H26. The decoder reproduces to the decimal, and the head rows on rectangles are finally valid, 2026-09-24

Run 35945907897: identical to 35937239958 (H25) except that `shrink` now
keeps the cover. Corpus `1rijjz2`, rectangular frames, Scale-MAE 896 px
squeezed whole, 15 cm grid, windows off.

| row | H25 run | this run | over SAM |
|---|---|---|---|
| colour and texture only (control) | 33.3% | 33.3% | 12 of 26 |
| the pretrained eye only (head) | ~~80.5%~~ | **36.5%** | 12 of 26 |
| both (head) | ~~35.5%~~ | **32.1%** | 12 of 26 |
| the pretrained eye, decoder | 28.5% | **28.5%** | 15 of 26 |
| SAM, same 26 lawns | 24.7% | 24.7% | |

**The decoder reproduced exactly** — the median and all 32 per-lawn figures
are the same to the decimal. It is seeded, and the extraction reproduced
byte for byte (as H13 says it usually does), so this is determinism rather
than a second measurement; it says the 28.5% is not a lucky draw of the
seed's dropout and flips, and nothing about what a different seed would
give. A different-seed run is still owed.

**The head rows are valid for the first time on rectangles, and the fix
was the whole story:** the eye alone went from 80.5% to 36.5% with no change
but the cover travelling through the squeeze. Against the last valid
square-frame run at the same grid (35914319694: eye alone 34.1, both 33.1)
the head rows moved 2.4 and −1.0 points — inside H13's drift. So for the
old head, cropping the neighbours out changed nothing measurable; the crop's
gains were SAM's (H24) and the decoder's.

**The decoder against the head, on the same features, is now a clean
comparison:** 28.5% against the head's best of 32.1% (both) and 36.5% (the
eye alone) — 8 points better than the head reading the same eye. The seen
column tells the same story (29.7 against 37.3 and 33.4). Its inferred
column is worse (30.5 against 18.5–22.1), which is the seen-only training
showing: it was never taught what is under a tree.

H22 stays suspended: the windows-on twin of this run (35945911259) is still
extracting at the time of writing.

### H25. The decoder: 28.5%, over SAM on 15 of 26, the best number this corpus has given — and a second bug in the head rows, 2026-09-24

Run 35937239958, corpus `1rijjz2` (32 lawns), rectangular frames, Scale-MAE
large at 896 px squeezed whole (coarsest lawn 33.5 cm/px, the scale bug of
H24 gone), 15 cm grid. Stage 1's own reader, `tools/train_decoder.py`, ran for
the first time: one 223,489-weight convolutional decoder per held-out lawn over
the eye's FULL 1024-number patch grid, 30 epochs, trained on visible ground
only, 35 s a fold.

| row | wrong | shade | sun | over SAM | seen | inferred |
|---|---|---|---|---|---|---|
| colour and texture only (control) | 33.3% | 24.1 | 39.7 | 12 of 26 | 33.9 | 25.6 |
| the pretrained eye only (head) | 80.5% | 59.7 | 93.9 | 3 of 26 | 80.9 | 23.1 |
| both (head) | 35.5% | 34.7 | 52.7 | 10 of 26 | 35.5 | 21.5 |
| **the pretrained eye, decoder** | **28.5%** | 25.5 | 37.7 | **15 of 26** | 29.7 | 30.5 |
| SAM, same 26 lawns | 24.7% | | | | | |

**What the decoder says.** 28.5% is the lowest headline any of our rows has
ever read on this corpus (30.2% was the selected best-of-six on squares), and
it is the first row to beat SAM on MORE than half the lawns it shares with it.
The gap is 1.15×; it was 1.30×. It beats colour by 4.8 points and the head
reading the same eye by 52 — the eye was never the ceiling, the reader was.
Its middle-of-lawn error is 17.6% against colour's 26.9%, and soft shade 9.9%
against 13.6%. Where it is worse: sharp boundaries (76.3% against colour's
58.3%), which is the S8 pattern, and the inferred column (30.5% against
21.5–25.6%) — expected, it was never taught what is under a tree; that is
stage 3's job. Per lawn it is 181% and 86% wrong on two small lots (Prince
William 3,429 sq ft and Utah) and 74% on one NC lot; those three are the
whole difference from SAM. Pictures: `runs/2026-09-23-2048-edt-scalemae-large-896px`.

**Caveats, in order.** One run (H13: a backbone row can move 3 points on a
re-run; the decoder has its own seed and has not been repeated). 32 lawns
(H7: one map is worth up to 10 points). Seen-only training, so the headline
carries an inferred column it was never taught. And a 223k-weight model on
31 lawns is fitting noise somewhere; the dihedral flips, dropout and weight
decay are guesses, not settings anyone swept.

**The second bug, found because the decoder worked.** After the scale fix
the head's "eye only" row STILL read 80.5%, while the decoder read the same
.f32 files at 28.5%. Same features, two readers: the reader was wrong.
`shrink` — the random squeeze from 1024 to 32 numbers — returned a grid
without its `coverX`/`coverY`, so `sampleAt` read every squeezed grid as if
it covered the photograph exactly. On a rectangle padded to a square the
photo is only part of the grid (cover up to 2.9), so the head read features
stretched by the aspect ratio: a cell at the right edge of a wide lot read a
patch of padding. **So every head row that reads the eye on a padded or
windowed grid was mis-registered**, and that includes H22: a windowed grid
carries a cover of about 1.15, so its head rows were read about 15% off,
right-and-down, by more the further from the top-left. H22's "windows made
every backbone row worse" was measured with that error in it and is
**suspended pending a re-run** — not retracted, because the squeezed-whole
rows in that comparison had cover 1 and were read correctly, and 16 points is
more than a 15% stretch obviously explains. Fixed in `shrink` (test in
`tools/grid.test.js`); the head rows on rectangles have still not been
validly measured.

**What this does NOT say.** It does not say the decoder is the detector: it
is 3.8 points behind SAM on the median and worse than SAM on 11 of 26. It
does not say seen-only is right for the headline. It does not say anything
about 1280 px, windows, or more epochs, none of which have been tried with it.

### H24. The first runs on rectangular frames, 2026-09-23 — SAM better, canopy unchanged, the backbone rows VOID

Three runs on the re-banked photographs (parcel box plus 10 m, cropped both
ways, ≤ 10 cm/px; run 35926500588), same 32 lawns, fingerprint `1rijjz2`.

**SAM (workflow 22, run 35927233073), one picture per lawn as the app asks:
median 27.1% over 31 lawns, against 33.8% on the square frames that morning
(35891200799, same model, prompt and threshold).** Six points better with the
neighbours cropped out. Read with care: different frames, and 31 lawns rather
than 32 — the 300 m Ottawa lot was skipped with Mapbox HTTP 422, because with
pieces switched off `detectionPlan` still asked for one piece at the target,
1500 logical px, which Mapbox refuses. That was a live bug: the biggest lots
could not be detected in the app either. Fixed the same evening (pieces off
now means the display frame, as H21 measured). The Kent 183 m lot is still
419% over-called: cropping the neighbours did not cure over-calling.

**Canopy (workflow 19, run 35927223633): canopy on traced lawn 0–68%, middle
19% (was 19%); inside the property line 0–87%, middle 35% (was 38%); patches
0–26, middle 6 (was 7); 9 lawns still mostly off the property (was 9).** The
box-plus-margin still holds neighbours' trees where a parcel is not
rectangular, so the crop did not change the medians. Pictures in
`2026-09-23-1825-edt-restor-tcd-segformer-mit-b5`. No canopy truth, so the
pictures are the measurement.

**Training (workflow 14, run 35927228827): the colour control read 33.3%
(35.0% on the squares at the same grid — within H13), and every backbone row
is VOID.** The eye alone read 81.6%, 2 of 26 over SAM, 80.6% wrong in the
middle of lawns — not a bad model, a broken input. The cause is in the
extraction log: wide lots were read at "0.980 m/px", "0.483", "0.275" when
no lot in the corpus is coarser than 0.36. The extractor pads a rectangle to
a square and tells Scale-MAE the scale from the metres ACROSS; it multiplied
by `max(cover)`, which on a wide lot is the height ratio, so a 319 m lot was
told it was 932 m across. Every wide lot went in at the wrong scale, every
tall one at the right scale, and a head trained across both had no consistent
eye to read. Fixed in `padded_side_metres` (tools/windows.py, tested). **So
there is still no valid backbone number on rectangular frames**; the next
workflow 14 run is the first. The decoder run queued on the broken features
was cancelled (35932533679) rather than measured.

What this run does say: the colour row moved 1.7 points between square and
rectangular frames at the same grid, which is inside noise — the crop did not
change what colour can do.

### H23. The 15 cm scoring grid moved nothing outside noise, 2026-09-23

*Four runs on corpus `1rijjz2`, 32 lawns, Scale-MAE large at 896, a 2×2 of
the two switches: windows off/on × grid 512/15 cm. Runs 35900673594 (off,
512), 35886436057 (on, 512), 35900680556 (on, 15 cm), 35914319694 (off,
15 cm).*

```
                              windows OFF            windows ON
                              512      15 cm         512      15 cm
colour and texture only      33.7%    35.0%         33.7%    35.0%    <- backbone-free
the pretrained eye only      31.4%    34.1%         47.4%    44.4%
both                         34.7%    33.1%         40.3%    39.9%
both, 96 numbers a patch     33.5%    33.0%         35.6%    35.8%
colour, with surroundings    35.5%    34.1%         35.5%    34.1%    <- backbone-free
both, with surroundings      31.6%    30.2%         38.0%    39.3%
SAM, same 26 lawns           23.3%    23.3%         23.3%    23.3%
best                         31.4%    30.2%         33.7%    34.1%
```

**The grid column moves every row by 0.5 to 2.7 points, in both directions,
and none of it clears the 3-point line H13 draws for this corpus.** The two
backbone-free rows, which are deterministic, went 1.3 worse (colour) and 1.4
better (colour with surroundings). The best number in the table is 30.2% —
"both, with surroundings" at 15 cm, windows off — against 31.4% at 512, and
1.2 points is not a result. Windows, by contrast, cost 3 to 16 points in
both grid columns, so H22 stands at either grid.

**Read as: the grid is not where the error is.** The cell went from 20 cm to
15 on a 100 m lot and from 62 cm to 31 on the biggest, the texture window
became meaningful on the lots where it had been wider than a cell, the
outline is quantised finer — and the leave-one-out error did not care. That
is consistent with the rest of this file: the error lives at sharp
boundaries and in what 32 lawns can teach, not in the cell size.

**Kept, because it did not hurt and the rule asks for it.** 15 cm a cell is
the default; `grid: 512` in workflow 14 is the control. The cost is a few
extra minutes of scoring. The developer-mode head in the browser reads at the
same rule, so a published head and the frame it is asked about agree.

**Headline moves to 30.2%, with the caveat printed beside it:** it is a
selected best-of-six on one run, 1.2 points from the control's 31.4, and H13
says a backbone row can drift that much between identical runs.

### H22. ~~Reading the backbone in 10 cm windows made EVERY backbone row worse~~ — RETRACTED 2026-09-24. Re-run with the registration fix: windows are within noise of squeezing whole, both ways

Run 35945911259, the H26 run with windows ON (11 of 32 lawns read in
overlapping 896 px windows, coarsest lawn 13.5 cm/px against 33.5 whole),
same corpus, same minute, the squeeze keeping the cover this time:

| row | whole (H26) | windows | over SAM |
|---|---|---|---|
| colour and texture only (control) | 33.3% | 33.3% | 12 of 26 |
| the pretrained eye only (head) | 36.5% | 35.9% | 11 of 26 |
| both (head) | 32.1% | 30.8% | 11 of 26 |
| the pretrained eye, decoder | 28.5% | 30.0% | 16 of 26 |

Every row within 1.5 points, both directions. **The 16-point loss H22
reported was the registration bug (H25), not the windows.** What windows
actually cost is time: extraction 60 min against 19, the decoder 53 min
against 21 (a windowed grid is up to 13× the patches). What they buy is
nothing measurable at 32 lawns, so the default stays OFF — but for the
run-time reason now, not because the whole lot in view was "worth more than
the resolution". That sentence, argued at length in the extractor's own
header and in this file, was a measurement of a bug. Per lawn the decoder
moved a lot in both directions (Utah 86% → 28%, Prince William 3,429 sq ft
181% → 76%, Kent 26,207 sq ft 24% → 44%), which is H7's noise, not a
pattern. Pictures in `runs/2026-09-24-0009-edt-scalemae-large-896px`.

*(The entry below is as written on 2026-09-23, kept as the record of what
was believed and why.)*

*Runs 35900673594 (control: every lot squeezed whole into 896 px, the
pre-2026-09-23 way) and 35886436057 (windowed: 11 of 32 lots read in
overlapping 896 px windows at the photograph's own resolution), both on corpus
`1rijjz2`, 32 lawns, Scale-MAE large at 896, fixed 512 grid, same folds, same
seed. The two backbone-free rows are BYTE-IDENTICAL between the runs (33.7 and
35.5), which is what says the comparison is clean.*

```
                               squeezed whole   in windows
                               (coarsest 36 cm)  (coarsest 10 cm)
colour and texture only            33.7%          33.7%    <- control row, identical
the pretrained eye only            31.4%          47.4%    <- 16 points worse
both                               34.7%          40.3%
both, 96 numbers a patch           33.5%          35.6%
colour, with surroundings          35.5%          35.5%    <- control row, identical
both, with surroundings            31.6%          38.0%
SAM, same 26 lawns                 23.3%          23.3%
best / SAM                          1.35×          1.45×
```

**Every row that reads the backbone is worse in windows, by 2 to 16 points,
and the eye alone — the row that says what the backbone sees — is worse by
16.** The finer picture cost more than it bought, on exactly the lots it was
meant to help: read whole, a 319 m lot reached the model at 36 cm a pixel and
the eye still scored 31.4 over the corpus; read at 10 cm in 25 windows it
scored 47.4.

**CORRECTED THE SAME EVENING, after the owner asked what was actually
trained: this was NOT a clean test of 10 cm a pixel, and the first reading
above overclaimed.** Two setup facts decide what the numbers can mean:

1. **What is trained is a 16-unit, one-hidden-layer head on 6,000 sampled
   cells a lawn, reading each cell alone.** Scale-MAE is frozen, and its
   1,024 numbers per patch are cut to 32 (or 96) by a FIXED RANDOM matrix
   (`projection()` in tools/backbone.js) before the head sees them. There is
   no learned projection and no spatial decoder. That pipeline is a feature
   probe: whatever the backbone resolves at 10 cm is squashed through a
   random 32-number straw and read one cell at a time. It has a ceiling
   resolution cannot move, and every table in this file sits under it.
2. **The windowed run mixed two feature dialects in one training set.** 11
   lawns' features came from windows (told 0.10 m/px, each window seeing an
   eighth of a lot); 21 came from whole squeezes (told 0.12–0.36). Each fold
   trained on the mix and standardised over the mix, so all 32 answers moved,
   not just the 11 — which is why the eye alone fell from 31.4 to 47.4 across
   the whole corpus. The fair test is windows on EVERY lawn or on none, and
   it was not run.

So the honest statement of H22 is: **mixing windowed and squeezed features
under a random-projection head made every backbone row worse.** Whether
10 cm a pixel helps Scale-MAE is still unmeasured. H21 (SAM) does not
share this flaw — no training, each lawn independent — and stands.

**Done about it.** Workflow 14's `windows` input defaults to `off`. The next
resolution test waits for a head that can use the resolution: a
convolutional decoder over the full 1,024-number patch grid, trained per
fold in PyTorch with flips and rotations, no random projection — and then
windows on every lawn against squeeze on every lawn. Colour rows leave the
candidate table at the same time (the owner: "colour will never be the
answer"); one backbone-free row stays as the corpus-drift control only.

### H21. Cutting a big lot into 10 cm pieces made SAM WORSE, 2026-09-23

**The measurement.** Workflow 22 (run 35891200799, 32 lawns, 93 predictions)
asked `mattsays/sam3-image` for "grass" at 0.05 about every approved lawn the
way the app asked from that morning: one picture under about 100 m across,
pieces of 1008 px at 10 cm a pixel or finer past that. Every lawn that was
cut into pieces was ALSO asked the old way in the same minute — one picture
of the display frame, which SAM reads at 1008 px — so the two masks differ in
nothing but the cut. Raw mask against the hand trace, inside the property
line, at 1280 px over the same rectangle of ground.

| lot | pieces | cm/px in pieces | one picture | in pieces |
|---|---|---|---|---|
| 108 m | 4 | 5.4 | 50.1% | **68.2%** |
| 108 m | 4 | 5.3 | 30.3% | **48.5%** |
| 111 m | 4 | 5.5 | 13.4% | 14.2% |
| 112 m | 4 | 5.5 | 17.6% | **70.8%** |
| 122 m | 4 | 6.1 | 21.8% | **33.5%** |
| 172 m | 4 | 8.5 | 45.4% | 50.6% |
| 190 m | 4 | 9.4 | 23.4% | 27.3% |
| 197 m | 4 | 9.8 | 405% | 482% |
| 197 m | 4 | 9.8 | 33.3% | **53.0%** |
| 231 m | 9 | 7.6 | 36.8% | **33.8%** |
| 319 m | 16 | 7.9 | 14.2% | **8.9%** |

**Worse on 9 of 11; median 30.3% as one picture, 48.5% in pieces.** The two
that improved are the two biggest lots, where one picture had been 23 and
32 cm a pixel. The lots just over the line — 108 to 122 m, where one picture
was already 10.7 to 12 cm — were hurt most, and they were cut the finest
(5.4 to 6.1 cm a pixel, because the plan fills the grid). Over all 32 lawns
the median was 33.8%, against the 20.3% "SAM" column in the tables above —
but that column is the stored `detected_shapes`, drawn another day, clipped
and traced, not a raw mask, so the two are not the same measurement.

**What it means, as far as n=11 can say.** SAM with a text prompt appears to
need the whole property in view more than it needs 10 cm a pixel: a piece
that is a quarter of a lot has lost the house, the drive and the road it was
reading the grass against. That is the same objection the backbone workflow
made about tiling in 2026-09-19, now measured on the live detector. It is
also the owner's own rule applied honestly — "unless we specifically
demonstrate that we can drop the resolution … if performance of traces is not
hurt too badly" — the demonstration went the other way: on lots under about
200 m, one picture at 11 to 20 cm beat pieces at 5 to 10 cm.

**The caveat is closed, and the mechanism is visible.** The diagnostic re-run
(35892399654, same 93 predictions, byte-identical scores — SAM is
deterministic here) recorded each mask's on-fraction and whether the >90%-on
polarity flip fired. **It fired on none of the 22 masks.** What it showed
instead is the shape of the failure: in pieces, **over-calling rose on 11 of
11 lots and misses fell on 10 of 11.** The 112 m lot went from 10.9% over
and 6.8% missed as one picture to 64.8% over and 6.0% missed in pieces; the
108 m lot from 13.3 over / 17.0 missed to 37.1 / 11.4. The finer picture did
find more of the lawn's edge (misses down), but a piece with less of the
non-grass world in it gets far more of itself called "grass" at the same
0.05 threshold — a field edge, a verge, rough ground that read as not-lawn
when the house and drive were in the same picture. The two lots that gained
were the two where misses had been the big term (30% and 12%) and over-call
stayed small. So the leading explanation is now the measured one: the text
prompt's threshold is calibrated against what else is in the picture, and a
quarter of a lot is a different picture. Resolution helped where it was
missing; context was worth more.

**Done about it, same day.** The live path is back to one picture
(`samMaxTilesAcross` defaults to 1); the machinery stays behind
`SAM_MAX_TILES_ACROSS` for the next experiment, which is pieces that
OVERLAP so that each keeps most of the lot in view — the backbone's
window-and-margin idea applied to SAM — and pieces at exactly 10 cm rather
than filling the grid finer. Neither is measured.

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

### E9. NAIP-CHM: a 0.6 m canopy height raster for the whole of CONUS, mostly 2022–2023, precomputed
*Looked up 2026-09-26 at the owner's question; probed from this container.*

Morford et al. 2026, *Sci Data*, [doi:10.1038/s41597-026-07549-w](https://doi.org/10.1038/s41597-026-07549-w);
code and weights at [smorf-ntsg/naip-chm](https://github.com/smorf-ntsg/naip-chm);
[catalog entry](https://gee-community-catalog.org/projects/naip_chm_conus/).
A U-Net (~22 M parameters, attention, climate/soil/elevation conditioning)
trained on 22.8 M NAIP–lidar CHM pairs, run over every NAIP quarter-quad.
**Pixel RMSE 2.28 m, r² 0.87**; no breakdown by height, land cover or
developed areas was found. **NAIP 2012–2023, 96% of it 2022–2023** — a
decade newer than 3DEP here (2011–2020, H16). **Buildings are in it**: it
maps every elevated structure, not just trees. Licence: the catalog says
CC-BY 4.0, the download README says MIT.

**Probed:** the files are served by the University of Montana at
`rangeland.ntsg.umt.edu/data/naip-chm/<year>/<utm zone>/…_chm.tif`, one per
NAIP quarter-quad, uint16 centimetres, **tiled 512×512, deflate, with
overviews, and the server answers byte ranges** — so one lot is one or two
tile reads, a few hundred KB, no model run at all. The index is 256 MB CSV /
299 MB GeoJSON (quad id, date, URL per file). Reached from this container;
not yet tried from a GitHub runner.

What it is NOT: lidar, although lidar taught it. Its inputs at inference are
NAIP's four bands (red, green, blue, near-infrared) and static climate, soil
and elevation rasters -- which is what makes it nationwide and recent; the
lidar was only the training target (owner's question, 2026-09-26). So it
cannot see through leaves (it is a surface estimated from an image), says
nothing about the ground under a crown, can be no better than the lidar it
imitates, and at 0.6 m with 2.3 m RMSE is not a shrub-height instrument. What it could be: a
second, much newer opinion on WHERE the trees are and how tall, over the
three benchmark lots with no lidar too (Island County among them).

### E10. Open Forest Observatory's tree-detection-framework is a wrapper, and its useful piece is the owner's own idea
*Looked up 2026-09-26.*

[open-forest-observatory/tree-detection-framework](https://github.com/open-forest-observatory/tree-detection-framework)
(BSD-3, active development) standardises training and inference over
DeepForest, Detectree2 (Mask R-CNN, detectron2), SAM2/SAM3, and a
learning-free **geometric detector on a canopy height model: Popescu & Wynne
(2004) variable-window tree tops plus Silva et al. (2016) crown
segmentation** — the "search window grows with height" method S9 describes.
It is built for **drone orthomosaics of forest**; its docker image bundles
detectron2 and SAM. No speed figures published.

For this project the framework is heavy for what it would add: the learned
detectors are crown detectors (H19: our problem was never crowns), and the
geometric one is a few dozen lines that can run on any CHM we already have
(3DEP at 2 m) or could fetch (E9 at 0.6 m).

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

### Owner's reading of the plan's-row pictures (H39's run drawn again), 2026-09-26

- **B12 (the pond):** about a third of the pond is gone from the lawn; two
  thirds remain — the void mask is a 6 m square of no returns, and the rest
  of the pond evidently returned something.
- **B06:** most of the roof that was called lawn is gone; not all.
- Both, in the owner's words, "should be easy for the detector to solve once
  it gets more training data".
- **B13 (Kent 105,584):** "worked perfectly" — it caught many small trees the
  tree model did not, and what stage 3 added and removed was practically
  perfect as to trees. One large tree has lawn under it, so the square
  footage is likely well off: **the numbers alone cannot judge this; where
  the square feet are matters more than how many.** Hence every layer drawn
  separately on the pictures page, with switches.

### Owner's reading of the 44-lawn pictures (H44), 2026-09-26

- **The detector itself has improved a lot**, and on some lawns did much
  better than it ever had; it still feels like it should do better on the
  straightforward lawns.
- **B03 (Utah):** took a lot more real lawn than before and over-did it, but
  is closer than ever. The photograph is blurry; the lawn is straightforward.
- **B04 (Island County):** missed a lot of lawn, some of it easy. The
  photograph is clear but has shadows.

**The owner's relative-height idea for NAIP-CHM, tested the same day on
H43's saved layers:** subtracting a local ground level (the 10th percentile
of NAIP-CHM within 14, 30 or 50 m) takes the traced lawn reading 2 m or more
from 13.3% only to 12.5–12.9%, and the trees the lidar calls 4 m or more
still read 2 m or more from 89.5% down to 68–82%. It lowers the lots whose
lawn reads high as a whole (B22 2.6 → 1.5 m, B23 3.1 → 2.4 m median) but
about 45% of those lawns still read 2 m or more: **the false heights are
speckle within the lawn, not an offset under it.** Tested on the
tallest-pixel read (H40), which exaggerates speckle; cover (H41) not yet.

### S9. Count the trees, not the canopy: woods are several crowns with no lawn between them (the owner's, 2026-09-25)

After H37 closed the woods question for height, size and understory. A tree
is one or two highest returns with a skirt of lower ones round it, the skirt
wider the taller the tree (not in proportion: species and pruning). So count
crowns by peaks in the lidar's canopy height model, with a search window that
grows with height — the published method for single-tree detection is this
(variable-window local maxima). Then: **several crowns in a group with no
seen lawn between them is woods; one or two with a good border of lawn is a
lawn tree.** The owner's constraint: decent and reliable over perfect and
brittle.

**Why it might work where H35–H36 did not:** it asks the question size could
not. A big lawn tree and a small wood can have the same area; they should
not have the same crown count. And "no lawn between them" is the owner's
measure of joined-up, not the raster's (H36: clumps join at the canopy).

**Why it might not, as far as is known now:** the wooded lots are the
sparsest clouds (Kent and Kentucky at 1–2 points/m², flown leaf-off), and a
bare deciduous crown gives few returns at its top; at 2 m cells peaks will
merge and split. The test before any rule: per canopy clump, crown count
against whether the tracer called lawn under it, as an AUC, the way H34 did
it — at clump level, which H35 showed is the level that matters. With the
20+ maps approved since the freeze, on `lawns: all`, because the benchmark
holds about ten wooded lots.

### S10. Small things standing in the open: shrubs, sheds, pools, playsets, planters (the owner's, 2026-09-25)

H37's understory separated lawn from not-lawn IN THE OPEN about as well as
under canopy (0.33–0.38 over 6 m). That was read as "not a woods signal",
which it is not; the owner's point is that it may be a *not-lawn* signal in
its own right, for exactly the things the tree model misses: shrubs under
2–3 m, sheds, above-ground pools, playsets, raised planters. **Unmeasured.**
Against it: a shrub is often under 1 m across and a 2 m cell is 4 m²; the
cloud is a median of ten years older than the photograph (H16), and sheds,
pools and playsets move; and the detector may already get most of them right
from the photograph. So the number to measure is not the AUC but the
overlap with the detector's OWN false lawn: of the cells stage 1 calls lawn
and the tracer did not, how many does a "something stands here" mask cover,
against how many of its true lawn. That needs workflow 14's predictions.

### Owner's reading of the H36 pictures, 2026-09-25

Not measurements — what the owner saw in `runs/2026-09-25-1324-edt-…`, drawn
for everywhere + span. Kept because each points at a different stage.

- **Prince William 3,429:** at least half is dense woods running up to the
  house; two tree clusters may have grass under them, and the trace makes
  that look feasible. **Its truth under the woods is uncertain even to the
  owner**, so it should stop being the lot every woods rule is tuned to.
- **Maryland 6,658:** very good except one large front-yard tree marked as
  having no grass under it, which probably does. A label question.
- **Kent 8,626:** a narrow strip of tall trees across the back yard, north to
  south, with no canopy detected — a tree-model miss; the lawn marks there are
  all the detector's. The lidar canopy (H38) is the check.
- **NC 114,992:** a big crown rooted in a non-turf area overhangs lawn; there
  is certainly grass under the overhang. Lawn on one side only: the case span
  cannot reach (H33).
- **Prince William 5,042:** a big lawn tree missed, but the detector also
  missed the grass round it in shadow — stage 1, more training data.
- **Kent 22,481:** the best run yet there; misses turf between canopies,
  almost certainly stage 1.
- **Kent 72,863:** fantastic, except the detector reads a large pond as lawn.
  Not canopy; the lidar's void/water mask (H38) and NIR are candidates.
- **Island County 19,932:** the starkest case of lawn under canopy fully
  missed: big trees, some in clusters of two or three, with enough lawn round
  them that grass should be inferred; one stretch runs along the house where
  the lawn is narrow. No lidar project over it. Span at 8 m cannot bridge a
  cluster wider than 8 m.

### S11. Give the detector every source and let it learn the rules (the owner's, 2026-09-26)

**The question.** Rather than hand-written logic over each source (the lidar
veto, stage 3's woods reasoning, NAIP-CHM as a canopy), feed lidar, NAIP's
near-infrared and the tree model to the detector beside the photograph and
let it learn how to use them; worse at first on a small corpus, perhaps, but
it should scale where rules do not.

**Why it is plausible (external).** Height above ground is the input that
separates "low vegetation" from "tree" on the ISPRS Vaihingen/Potsdam
benchmarks, which is their commonest confusion and ours (Audebert, Le Saux &
Lefèvre 2018, arXiv 1711.08681: early fusion learns the sources jointly but
is more sensitive to missing data than late fusion). The Chesapeake 1 m land
cover, which has a turf-grass class, is built from NAIP plus lidar height.
NDVI is a band ratio, so it survives shadow (the note on the `ndvi` provider
in worker/src/imagery.js); that provider was rejected as SAM's ONLY picture
for being soft at 3.5 cm, which does not apply to one number per 1.4 m patch.

**What it cannot do, from this repo's own findings.** The decoder is trained
on visible ground only (H17), so no input teaches it what lies under a
canopy; stage 3 keeps that. It cannot be TOLD to trust RGB over stale lidar;
it learns that only from examples, so the lidar is hidden at random in
training (modality dropout, 0.3; NAIP 0.2) and a lot with no point cloud
reads as zeros with a flag down, which dropout has shown it. Registration
is less of a worry than it sounds at this grain: a patch is 1.4 m and the
lidar cell 2 m, and NAIP-CHM measured 0-1 cell off (H43).

**Built (tools/fuse_layers.py, naip_bands.py; workflow 14 `decoder: fused`):**
seven more numbers a patch beside the eye's 1024 -- lidar height (m/10,
clipped at 30 m), ground-return share, log return count (H38's void), a
has-lidar flag, NAIP NDVI, a has-NAIP flag, the tree model's canopy share --
each area-averaged onto the patch grid exactly as the labels are.

## Rules for running and reading these experiments

1. **Check the fingerprint and lawn count first.** Two tables from two corpora
   are not comparable (H7). **Since 2026-09-24 the 32 lawns of `1rijjz2` are
   frozen as the benchmark** (`cohort = 'benchmark-1rijjz2'` in the corpus
   table, stamped once by a migration; `tools/lawn-set.js`). Workflows 14, 19
   and 22 take a `lawns` input: `benchmark` (the default, comparable with every
   table from 2026-09-23 on), `all` (everything approved, for training on the
   most; compares with nothing here), `new` (only maps approved since the
   freeze). A benchmark run checks its own fingerprint against `1rijjz2` and
   shouts if it differs. The corpus can grow freely; the benchmark does not
   move, and a new benchmark is a decision to be written here when it is made.
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
| 2026-09-23 | 35890603985 | 32 | — (workflow 22, first attempt) | — | — | **Void.** Paid for about sixty predictions and scored nothing: the tool read Mapbox's JPEG as a PNG. Fixed by decoding by signature and fetching the photograph before asking SAM |
| 2026-09-23 | 35891200799 | 32 | — (workflow 22: SAM scored, 93 predictions) | — | 33.8% raw mask, as the app asked that morning | **H21: pieces made SAM worse on 9 of 11 big lots** — median 30.3% as one picture, 48.5% in pieces, same model, prompt and minute. The two biggest lots (231, 319 m) improved; the 108–122 m lots were hurt most. Live path put back to one picture the same afternoon. Polarity-flip caveat open until the diagnostic re-run |
| 2026-09-23 | 35892399654 | 32 | — (workflow 22, diagnostic re-run, 93 predictions) | — | 33.8% raw mask | **H21 confirmed and explained.** Scores byte-identical to the run before. The polarity flip fired on none of the 22 masks. In pieces, over-calling rose on 11 of 11 lots and misses fell on 10 of 11: SAM's "grass" at 0.05 claims far more of a piece that has less of the non-grass world in it. Context beat resolution on every lot under 200 m |
| 2026-09-23 | 35890608444 | 32 | — (workflow 19, no training) | — | — | **The canopy at 10 cm, drawn at 1280 px.** Same inputs as 35866737322 (native frames, every lawn at or finer than 10 cm, "No lawn was upsampled"), so the canopy itself is unchanged; this run exists for the pictures, which open full size on /predictions.html now. Patches per lawn 0–46, middle 7; canopy on traced lawn 0–53%, middle 19%; inside the line 0–69%, middle 38%; 9 lawns mostly off the property. Still no canopy truth to score against — the pictures are the measurement |
| 2026-09-23 | 35886436057 | 32 | Scale-MAE large 896px, **windowed** (11 lawns in overlapping windows, coarsest 10.0 cm/px), grid 512 | 33.7% | 23.3% | **NEW CORPUS `1rijjz2`** (32 lawns; one map was rejected and one arrived since `1wxlejo`), so nothing above compares (H7). Colour-only 33.7 is the best row; the eye ALONE 47.4, both 40.3, both-96 35.6. The backbone rows sit far behind colour here, which they did not at 896 before — but the corpus moved too, and there is no control on this fingerprint yet. **Not a finding until the same corpus is run with windows off.** 118 passes of 896 px, 41 minutes of extraction |
| 2026-09-23 | 35900673594 | 32 | Scale-MAE large 896px, squeezed whole (**the control**, coarsest 35.6 cm/px), grid 512 | **31.4%** | 23.3% | **H22: the control for the windowed run, same corpus `1rijjz2`.** Backbone-free rows byte-identical to 35886436057 (33.7, 35.5); every backbone row better squeezed whole — eye alone 31.4 vs 47.4 in windows, both 34.7 vs 40.3, both-96 33.5 vs 35.6, both+ring 31.6 vs 38.0. Best row is the eye ALONE, 13 of 26 over SAM, gap 1.35×. Windows off by default from here |
| 2026-09-23 | 35900680556 | 32 | Scale-MAE large 896px, windowed, **15 cm grid** (512–1024 cells) | 34.1% | 23.3% | **H23, windows-on column.** Against the windowed run at 512: every row within 3 points (colour 33.7→35.0, eye 47.4→44.4, both+ring 38.0→39.3). The grid moved nothing; the windows' cost is the same at either grid. Extraction 73 minutes on a slower runner, scoring 22 |
| 2026-09-23 | 35914319694 | 32 | Scale-MAE large 896px, squeezed whole, **15 cm grid** | **30.2%** | 23.3% | **H23, windows-off column: the 2×2 is complete.** Against the control at 512: colour 33.7→35.0, eye 31.4→34.1, both 34.7→33.1, both-96 33.5→33.0, colour+ring 35.5→34.1, both+ring 31.6→**30.2**. All within H13's 3-point drift, both directions. Best number of the day, 12 of 26 over SAM, gap 1.30× — a selected best-of-six 1.2 points from the control. Grid kept at 15 cm for the rule's sake |
| 2026-09-23 | 35926500588 | 56 rows (all Mapbox rows, approved or not) | — (workflow 21, the rectangular re-bank) | — | — | **Every photograph is the parcel's box plus 10 m, cropped both ways, at 10 cm or finer.** 56 re-banked, 0 failed, 2 stitched (3004×1028 and 2592×2572). Shapes run from 544×1520 to 1996×1614; the widest lot is 1714×678. Small lots are slightly coarser than the square used to give them (middle 0.9×, e.g. 4.7 → 5.9 cm) because the 10 m margin is wider than the old 12% on a small lot and the longer side still fits 640 logical px; every one is under 10 cm. **Every number in this file before this row was measured on square frames with the neighbours in them**; the runs that follow are a new baseline, whatever the fingerprint says |
| 2026-09-23 | 35927233073 | 32 | — (workflow 22, 31 predictions) | — | **27.1%** raw mask, one picture per lawn | **H24: SAM on the rectangular frames.** 33.8% → 27.1% median against the square frames that morning, same model and prompt. 31 of 32: the 300 m Ottawa lot got Mapbox HTTP 422 because pieces-off still planned one 1500 px piece at the target — a live bug on the biggest lots, fixed that evening. Kent 183 m still 419% over |
| 2026-09-23 | 35927223633 | 32 | — (workflow 19, no training) | — | — | **H24: canopy on the rectangular frames.** On traced lawn middle 19% (was 19%), inside the line middle 35% (was 38%), patches middle 6 (was 7), 9 lawns mostly off the property (was 9). The crop did not move the medians; the parcel's box still holds neighbours' trees. No lawn upsampled. Folder `2026-09-23-1825-edt-restor-tcd-segformer-mit-b5` |
| 2026-09-23 | 35927228827 | 32 | Scale-MAE large 896px, squeezed whole, 15 cm grid, **rectangular frames** | 33.3% (colour) | 24.7% | **H24: backbone rows VOID.** Eye alone 81.6%, both 36.8, both-96 39.3, both+ring 43.0 — the extractor told Scale-MAE the wrong scale on every wide lot (`max(cover)` instead of the across ratio: a 319 m lot read at 98 cm/px). Colour 33.3 vs 35.0 on squares at the same grid, inside noise. The SAM column reads 24.7 rather than 23.3 because the stored outlines are now rasterised on rectangular grids. Fixed; not yet re-run. The decoder run on these features (35932533679) was cancelled |
| 2026-09-24 | 35937239958 | 32 | Scale-MAE large 896px, squeezed whole (coarsest 33.5 cm/px), 15 cm grid, rectangular frames, **+ decoder** | **28.5%** (decoder) | 24.7% | **H25: THE DECODER'S FIRST RUN.** Conv decoder over the full 1024-number grid, seen-only, 30 epochs, 35 s a fold: **28.5%, over SAM on 15 of 26**, gap 1.15× — the best number this corpus has given and the first row over SAM on more than half. Colour control 33.3 (byte-identical to the void run, as H10 says). Head rows VOID AGAIN: eye alone 80.5, both 35.5 — `shrink` dropped `coverX/coverY`, so the head read padded grids stretched by the aspect ratio; same files, read right by the decoder. H22 suspended pending re-run. Pictures in `runs/2026-09-23-2048-edt-scalemae-large-896px` |
| 2026-09-24 | 35945907897 | 32 | Scale-MAE large 896px, squeezed whole, 15 cm grid, rectangular frames, + decoder, **squeeze fix** | **28.5%** (decoder) | 24.7% | **H26: the first valid head rows on rectangles, and the decoder to the decimal.** Eye alone 80.5 → **36.5** with nothing changed but the cover kept through `shrink`; both 32.1; colour 33.3 (identical); decoder **28.5, 15 of 26**, every per-lawn figure identical to H25 (seeded; extraction byte-identical). Head rows within H13 drift of the last square-frame run (34.1 / 33.1). Decoder 21 min for 32 folds, 35 s each. Pictures in `runs/2026-09-23-2254-edt-scalemae-large-896px` |
| 2026-09-24 | 35945911259 | 32 | Scale-MAE large 896px, **windowed** (11 lawns, coarsest 13.5 cm/px), 15 cm grid, rectangular frames, + decoder, squeeze fix | 30.0% (decoder) | 24.7% | **H22 RETRACTED.** Against the whole-lot twin the same minute: eye alone 35.9 vs 36.5, both 30.8 vs 32.1, decoder 30.0 vs 28.5 (16 of 26 over SAM either way). Within noise both ways; the 16-point loss was the registration bug. Extraction 60 min, decoder 53 min (100 s a fold on windowed grids). Default stays off for the time. Pictures in `runs/2026-09-24-0009-edt-scalemae-large-896px` |
| 2026-09-24 | 35955276222, 35955279657, 35989581358, 35989586854, 35989591674, 35993754388 | — | — (nothing ran) | — | — | **GitHub Actions stopped starting jobs at about 04:00 UTC.** Six runs in a row, workflow 14 and then the untouched workflow 1, each "failed" in four seconds with no steps and an empty log. Not the workflow files: the eleven-input theory was tried (`render` removed) and refuted by workflow 1 failing identically. Everything that ran since 2026-09-23 22:00 UTC — 14 runs, most of them 50–125 minutes — is what an exhausted Actions allowance looks like. **Three runs are owed and will be started when jobs run again:** canopy on lawn, seed 7 (the new default, against 35948780766); canopy everywhere, seed 7 (the exact H27 repeat); canopy everywhere, seed 11 |
| 2026-09-24 | 36002884707 | 32 | as 35948780766 but canopy **on lawn only**, seed 7 | 29.8% (decoder) | 24.7% | **H28.** Head rows 36.5 / 32.1 (the no-canopy state, to the decimal). Decoder 29.8, 15 of 26, seen 24.3. The wooded lots came back: Kent 22,481 sq ft 170 → 41.5%, PW 3,429 319 → 94%, Utah 86 → 69%. Pictures `runs/2026-09-24-1001-edt-scalemae-large-896px` |
| 2026-09-24 | 36002889613 | 32 | as 35948780766 exactly (canopy everywhere, seed 7) | **24.3%** (decoder) | 24.7% | **H28: reproduced to the decimal**, every per-lawn figure and both head rows (34.2 / 31.8). Pictures `runs/2026-09-24-1016-edt-scalemae-large-896px` |
| 2026-09-24 | 36002894789 | 32 | as 35948780766 but **seed 11** | 25.5% (decoder) | 24.7% | **H28: the seed is worth about a point.** 16 of 26, seen 18.6 (unchanged), inferred 64.1. Head rows 34.2 / 31.8 again. Pictures `runs/2026-09-24-1010-edt-scalemae-large-896px` |
| 2026-09-24 | 35948780766 | 32 | Scale-MAE large 896px, squeezed whole, 15 cm grid, rectangular frames, + decoder, **canopy as unseen ground** | **24.3%** (decoder) | 24.7% | **H27: UNDER THE SAM LINE, by 0.4, first time.** Decoder 24.3, **16 of 26**, SEEN 18.6 against 26.0–27.4 for the head rows; the run printed "AHEAD, BUT NOT BY ENOUGH TO TRUST". Canopy on 32 of 32 lawns (the tree step, 11 min). Head rows drifted −2.3 / −0.3 with no training reason (H13), so of the decoder's 4.2-point gain some may be drift; repeat owed. Kent 22,481 sq ft 38 → 170%. Pictures in `runs/2026-09-23-2356-edt-scalemae-large-896px` |
| 2026-09-24 | 36013573532 | 32 | as 35948780766, `canopy: compare` — three decoders over ONE extraction (none / on lawn / everywhere), seed 7 | **24.3%** (decoder, everywhere) | 24.7% | **H29: the canopy's 4.1 points are real and all under the trees.** none 28.4 / seen 23.0 / inferred 28.8; on lawn 29.8 / 24.3 / 34.5; everywhere 24.3 / 23.4 / 18.7 (15, 15, 16 of 26). Head rows 34.2 / 31.8 — the state H28 had only seen with "everywhere", yet every decoder row matched its single run within 0.1, so the "two extraction states" were the head's. On lawn worst on every column. Pictures `runs/2026-09-24-1241-edt-scalemae-large-896px` (drawn for the everywhere row) |
| 2026-09-24 | 36020948046 | 32 | as 36002884707 (canopy on lawn, seed 7) + **stage 3** swept and scored | **25.8%** (decoder + stage 3) | 24.7% | **H30: stage 3's first measurement.** Stage 1 29.8 / 24.3 / 34.5 (third exact repeat). Canopy cleared, no rules: 27.9 / 20.7 / 93.7. Reach 3 m + 180°: 25.8 / 26.0 / 12.2, **17 of 26**, Kent 22,481 sq ft 39.1%, PW 3,429 80.3%. Reach trades seen for inferred (20.7 → 29.8 against 93.7 → 7.0 from 0 to 4.5 m); bridge over 126° worse everywhere. Same folder as the row above (same minute); the pictures there are the compare run's |
| 2026-09-24 | 36035231729 | 32 | `canopy: compare` + stage 3 over all three decoders, seed 7, benchmark set (first run with `lawns`) | **24.2%** (decoder, everywhere + stage 3) | 24.7% | **H31.** Alone 28.5 / 29.8 / 24.3 (third exact repeat, head rows in the 36.5 / 32.1 state this time — H29 confirmed). + stage 3: none 26.4 / 26.7 / 12.2 (17 of 26); on lawn 25.8 / 26.0 / 12.2 (17); everywhere **24.2 / 22.6 / 11.7 (18 of 26)** but Kent 22,481 sq ft 49.8%, PW 3,429 130%, Utah 86%. H30's guess (none feeds stage 3 best) measured as nothing. Fast runner: 12 min a decoder, 68 min in all. Pictures `runs/2026-09-24-1440-edt-scalemae-large-896px` |
| 2026-09-24 | 36054887434 | 32 | `canopy: compare`, stage 3 + **enclosure** swept over all three decoders, badly-wrong table | **24.2%** (everywhere + stage 3) | 24.7% | **H32.** Decoder rows 28.4 / 29.8 / 24.3 (fourth exact repeat). Enclosure at 4 of 8 sides, reach 3 m: seen back to 21.4 / 21.5 / 20.8 (from 26.7 / 26.0 / 22.6), inferred up to 28.2 / 33.5 / 20.9 (from 12.2 / 12.2 / 11.7). The traced inferred strip is a wood edge too. Tail table: Utah 13,689 and NC 10,556 are 69–86% under every decoder and 36–48% under the head, untouched by stage 3. Pictures `runs/2026-09-24-1830-edt-scalemae-large-896px` |
| 2026-09-25 | 36078758001 | 32 | `canopy: compare`, stage 3 **span** swept 4/8/12 m × reach 0/1/1.5 m over all three decoders, fixed "+ stage 3, span" row (8 m, 1 m), amber pictures | **23.3%** (everywhere + span) | 24.7% | **H33.** Decoder rows 28.4 / 29.8 / 24.3 (fifth exact repeat). Span 8 m + 1 m: none 26.9 / 22.5 / 24.8 (16 of 26), on lawn 26.6 / 22.2 / 28.5 (16), everywhere 23.3 / 21.7 / 18.3 (17). Visible ground within 2 points of cleared (reach cost 5–6); Kent 22,481 36 / 40 / 38 (everywhere was 50), PW 3,429 67 / 60 / 91 (was 89 / 80 / 130); hidden column half of reach's. Span is THE PLAN's row from here. Pictures `runs/2026-09-24-2251-edt-scalemae-large-896px` (first with amber) |
| 2026-09-25 | 36095115276 | 32 | — (workflow 23, the 3DEP point clouds over the benchmark frames, 2 m cells, no training) | — | — | **H34: stage 4, first read.** 29 of 32 frames read in 3 min; 0.8–31 points/m², 1.05 ground returns/m² on the middle lawn; 95–100% of canopy cells have a ground return. Under canopy, lawn vs not: ground intensity AUC 0.45 pooled / 0.61 middle (a coin toss that flips lawn to lawn), ground density 0.68 / 0.59, **height 0.23 / 0.32 — lawn is under 3.7 m of canopy, the woods under 7.3**. In the open intensity reads 0.79. Hidden pavement is not findable this way; which canopy is woods is. Layers in the run's artifact |
| 2026-09-25 | 36111426731 | 32 | `canopy: compare`, stage 3 **woods** (lidar clump median height ≥ H) swept off/4/6/8/12 m at the span cell, fixed row at 6 m; lidar on 29 of 32 | **23.3%** (everywhere + span) | 24.7% | **H35.** At 6 m: seen improves a point on every decoder (everywhere 21.7 → **19.3**, best ever), Prince William 3,429 **67 / 60 / 91 → 30 / 28 / 35**, Kent +2–4, median unmoved, 17 of 26 on all three — and inferred 24.8 / 28.5 / 18.3 → 42–44: a lawn tree is tall too. 12 m keeps most of the visible gain for 5–8 points hidden. Not adopted; rule reshaped to tall AND big for the next run. Pictures `runs/2026-09-25-0626-edt-scalemae-large-896px` |
| 2026-09-25 | 36151868024, 36152888443 | 32 | `canopy: compare`, woods at **12 m AND a size floor** swept any / 200 / 500 / 1,000 m², fixed row 12 m and 500 m²; two identical runs launched by two sessions | **23.3%** (everywhere + span) | 24.7% | **H36: prediction failed.** The two runs identical to the decimal from the first score on. 200 = 500 = 1,000 m² on every decoder. Fixed woods row: none 26.9 / 21.9 / 24.8, on lawn 26.6 / 22.2 / 28.5 (span alone exactly), everywhere 23.3 / 21.0 / 23.8 (hidden +5.5). **Prince William 3,429 67 / 60 / 91, unfixed.** Size cannot tell a big lawn tree from a wood here. Next: understory returns under the crown (workflow 23). Pictures `runs/2026-09-25-1324-edt-scalemae-large-896px` |
| 2026-09-25 | 36168701134 | 32 | — (workflow 23 with the **understory** layer: share of sub-3 m returns from 0.5–3 m, per 2 m cell and over 6 m) | — | — | **H37: no.** Under canopy, lawn vs not: understory 0.45 / 0.45 per cell, **0.38 / 0.35 over 6 m** (pooled / middle), against height 0.23 / 0.32 in the same run; in the open 0.43 / 0.40 and 0.38 / 0.33, so not a woods signal. Median share 0.00 in every class; 0.10–0.76 lot to lot. The woods question is closed; next the roof mask. Every H34 number reproduced to the digit |
| 2026-09-25 | 36179937840 | 32 | — (workflow 23: **roof / void / lidar canopy** masks, thresholds fixed before the run) | — | — | **H38.** Roof 0.2 / 0.5% of the lawn classes against 26.2% of visible not-lawn; void 0.0% of lawn, 186 cells on Kent 72,885 (the pond) and nowhere else; lidar canopy 13.6% of visible lawn, IoU 0.56 with the tree model, lidar-only 8,759 cells against 2,216 model-only, Kent 8,626 724 m² lidar-only. Roof and void built as a veto after stage 3 |
| 2026-09-25 | 36182100031 | 32 | `canopy: compare`, **lidar veto** (roof + void never lawn, after stage 3 span), fixed row per decoder | **23.3%** (everywhere + span) | 24.7% | **H39: adopted.** Medians 27.0 / 26.6 / 23.3 → 27.0 / 26.6 / 23.4; in sun 39.7 / 36.2 / 28.1 → 35.2 / 32.2 / 25.5. Kent 72,863 −5.5 to −5.8 (the pond, void 373–389 m², all not-lawn), **Kent 8,626 −10 to −11 (roof)**, Utah −2 to −3, Wayne −1.6, PW 3,429 −7 (everywhere); none worse. Roof took 69–102 m² of the tracer's lawn against 245–311 not (predicted under 20: failed, bad arithmetic). Pictures `runs/2026-09-25-1739-edt-scalemae-large-896px` (span without veto) |
| 2026-09-26 | 36207546426 | 32 | — (workflow 23 + **NAIP-CHM**, tallest pixel a 2 m cell ≥ 2 m, not roof) | — | — | **H40: fails its bar.** Index 11 s, files over 32 of 32 (NAIP 2021–23). Where tree model and lidar agree: canopy 99.3% (bar > 80), neither 13.7% (bar < 10: failed). Visible lawn 21.8% under it. Lidar-only 76% / model-only 79% NAIP canopy, confounded by edge cells. Kent 8,626 strip 77% still canopy (tree-model miss); B28 NC 10,556 20% (trees gone). Island County: NAIP-only 830 m² vs model 579 |
| 2026-09-26 | 36208871886 | 32 | — (workflow 23 + NAIP-CHM as **cover**: half the 2 m cell's pixels ≥ 2 m, not roof) | — | — | **H41: passes its bar.** Both 98.2% (> 80), neither 8.6% (< 10). Lidar-only 67.4%, model-only 68.6% NAIP canopy: most of the 8,759 lidar-only cells are trees the tree model misses. Kent 8,626 66%, B28 NC 10,556 16% (trees gone). Visible lawn 15.6% under NAIP canopy. Island County NAIP-only 706 m² against the model's 579 |
| 2026-09-26 | 36201920931 | 32 | as 36182100031 (H39), the first run to **draw THE PLAN's row** (canopy on lawn + span + lidar veto) instead of the lowest median | 23.3% (everywhere + span) | 24.7% | Pictures of the plan's row for the first time, `runs/2026-09-25-2152-edt-scalemae-large-896px`. The plan's row 26.6% to the decimal of H39, everywhere 23.3 / 23.4 likewise; head rows back in the 34.2 / 31.8 state and the no-canopy decoder 28.4 against H39's 28.5 (H28/H29's two extraction states). Kent 72,863 37.1 → 31.3 and Kent 8,626 51.3 → 41.0 under the plan's decoder, as H39 |
| 2026-09-26 | 36212931237 | 32 | `canopy: compare`; THE PLAN's row + **stage 3 over tree model ∪ (lidar ∩ NAIP-CHM) canopy** (NAIP alone without lidar); first **layered pictures**; B-numbers | 23.3% (everywhere + span) | 24.7% | **H42: worse, not adopted.** Plan's row 26.6 / 22.2 / 28.5 → 30.4 / 27.2 / 31.4, 16 → 14 over SAM; 15,476 m² canopy added, 6,719 over lawn. B25 9 → 71, B26 45 → 61, B31 14 → 32, B04 56 → 61; B22, B09, B30 slightly better. Pictures (the losing row, every layer) `runs/2026-09-26-0041-edt-scalemae-large-896px` |
| 2026-09-26 | 36219427024 | **44** | `canopy: compare`, **`lawns: all`** (the 32 + 12 since the freeze) — **NOT COMPARABLE** | 19.5% (everywhere + span); plan's row 23.7% | 32.2% (30 lawns) | **H44.** On the 32, lot by lot (everywhere + span) against H39: 15 better, 8 worse, median −0.6. B03 86 → 38, B17 −10, B20 −10, B22 −10, B06 −4.5; B04 33 → 65, B18 +8, B12 (pond) +3. Pictures (plan's row, layered) `runs/2026-09-26-0253-edt-scalemae-large-896px` |
| 2026-09-26 | 36247435370 | 32 | — (workflow 23: **NAIP-CHM cover swept** 2/3/4/5 m × objects 0/20/50 m², not roof) | — | — | **H45: no cell passes.** Both 98.2 → 93.8%, neither 8.6 → 4.0% (passing from 4 m up); traced visible lawn called canopy 15.6 → 9.4% (bar < 5, never met — and a bar a perfect map would fail, since the lidar calls 13.6% of that ground canopy); lidar 4 m trees found 89.5 → 77.1%. Closed as a canopy |
| 2026-09-26 | 36256482254 | 32 | — (workflow 23: **S9, crowns per canopy clump** from the lidar CHM, lawn border, rule trades) | — | — | **H46: no clump rule passes.** 95 clumps (57 lawn, 38 not); AUC border lawn 0.16, crowns 0.69, height 0.63. Best: 3+ crowns & border < 25% finds 92.5% of woods for 30.4% of lawn under canopy; 12 m height 81% / 29%. Clumps are joined; closed at the clump level |
| 2026-09-26 | 36263514117 + 36263512588 | 32 | — (workflow 23: **H47, one segment per crown**; workflow 14 `canopy: compare` repeats it with the **detector's** visible lawn) | — | 24.7% | **H47: passes on the detector's edge.** 497 segments (96 lawn). (b) AUC distance 0.94, border 0.08, crowding 0.87. Border lawn 0% finds 85.0% of woods for 7.5% of lawn under canopy; distance 10 m+ 79.5% for 3.1%. Tracer's edge (a) 83.0/5.6 and 79.0/2.4: the leak is small. A separation, not yet a row |
