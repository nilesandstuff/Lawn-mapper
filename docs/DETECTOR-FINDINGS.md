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

Every finding carries the date and the corpus it came from, because the corpus
changes and results from different corpora are not comparable.

---

## The numbers that matter right now

| | error | notes |
|---|---|---|
| SAM (what we pay for) | **20.3%** | the line to beat, 19 lawns with a stored SAM answer |
| best of ours | **26.1%** | Scale-MAE 1280px, **both, with surroundings**, beat SAM on 8 of 19 |

Gap: **1.3×**. It was 1.4× at 896px, 1.5× at 672px and 1.6× under DINOv2.

> **WORK ON THE MODEL IS PAUSED, by the owner's decision on 2026-09-19.** The
> reasoning is in H11: the model cannot help build the corpus until it beats
> SAM, and it is not close. Four backbones, four resolutions, a ring, a feature
> vector rebuild and two real bugs later, the gap has gone from 1.6× to 1.3×
> and every run still ends "STILL NOT BETTER than the detector we pay for".
> The corpus is the constraint (S3), so the effort moved to growing it.
>
> Nothing here is abandoned and nothing needs redoing. Pick it up by running
> workflow 14 at 896 when the corpus is meaningfully larger, and read H13 and
> H14 before comparing that table to anything above.

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

## HARD FINDINGS — our own measurements

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

The honest summary: across four runs the ring is **negative, negative, mildly
positive, strongly positive**, in that order — and that order is also the order
of backbone quality. It is not established as harmful and it is not established
as useful. It is the most interesting open question in this file (S6).

See also E3 — the published result saying receptive field alone is not the
lever for occlusion.

**SPECULATION (S6):** the ring may only be able to help once the centre
features are good enough to be worth contextualising, which would explain why
its two best showings are the two best backbone settings, in order. Still
SPECULATION — four points on a curve that was *drawn after* the numbers came
in, and exactly the kind of story that sounds right and has twice measured as
nothing here.

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

### H6. Marked "inferred" ground is only about 3% of a typical map
*23 lawns, 2026-09-19.* 17 of 23 maps carry inferred marks. Marked ground is
**3% of a typical map, 44% of the most-marked**.

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
The owner has said non-commercial is acceptable. Recorded anyway because it
constrains any later change of mind.

| | licence | commercial? |
|---|---|---|
| Scale-MAE (torchgeo) | CC-BY-NC-4.0 | no |
| Restor TCD U-Nets | CC-BY-NC (CC-BY planned) | not yet |
| SatlasPretrain / NAIP | ODC-BY | yes |
| Chesapeake U-Net (torchgeo) | MIT | yes |

[TorchGeo weights](https://docs.torchgeo.org/en/stable/api/models.html)

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
