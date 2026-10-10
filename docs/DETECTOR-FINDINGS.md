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

- **THE LIVE MODEL HAS A NAME AND A VERSION HISTORY (owner, 2026-10-06):**
  "Turf Trace - alpha version 2 (79% accuracy)". Every release ships with a
  row in worker/src/model-versions.js: the next version number, the date,
  and the accuracy of the configuration that picked it, rounded. Accuracy
  is 100 minus the median held-out lot error of THE PLAN's row in those
  runs. Version 1 (2026-09-29) is 76%, from 24.0%; version 2 is 79%, from
  21.0 / 21.3 / 21.0. The stage follows the owner's thresholds: alpha below
  82%, beta below 86%, none after. The picker's "Version history" lists them.
- **THE PLAN CHANGED, 2026-10-06 (H78): its decoder is now TAUGHT UNDER
  TREES with the CANOPY AS AN INPUT** (`UNDER_TREES=1`, `FUSE_CANOPY=1`).
  Stage 3, the span rule, the edge refiner and the lidar veto all stay. It
  beat the old PLAN lot by lot on two independent extractions × 3 seeds:
  sign test p 0.036 and 0.027 on all 80; -1.1 and -0.9 points (p 0.002,
  0.001) on the 48 untuned lots. Adopted by the owner's standing rule
  ("if one is measurably better, then that's the one"). A release trained
  that way on 80 lots replaces the 55-lot 2026-09-29 one; the old weights
  are kept on the Modal volume under alpha/history/. The old decoder is in
  git before commit "THE PLAN: taught under trees" if it is ever wanted.
- **THE PLAN IS LIVE AS "Trained model (alpha release)" (owner, 2026-09-29)**,
  the default method wherever a release is on Modal. The configuration is the
  one that scored 24.0% in run 36601001355 (S20 A, seed 7: fused + edge
  refiner, canopy on lawn, windows off, lawns all, no outlines). That run kept
  no weights, so the served model is trained ONCE MORE on every approved lot,
  with no folds, by workflow 14 `release: alpha`. **Its own score is therefore
  UNMEASURED.** It is the configuration that scored 24.0% under folds, not a
  model that did, and it saw the lots it would be scored on. The pieces:
  tools/modal_serve.py (L4, max 3 containers of 4 lots each, 20 s idle, memory snapshot; lidar and NAIP on a CPU machine -- all 2026-09-30), alpha_infer.py
  (Python half) and serve-alpha.mjs (stage 3 + lidar veto via the scorer's own
  functions); worker/src/alpha.js; deploy step "Serve the trained model".
  Measuring the LIVE model means scoring maps finished AFTER the release.
  Those carry `corpus.model_version`.
  **First release: 2026-09-29T21:10:24Z** (workflow 14 run 36629128194,
  `gpu: modal`, 23 min end to end). It was trained on 55 lots: dim 1031
  (1024 + 7 fused), refiner on, canopy on lawn, seed 7, 30 epochs, final
  train loss 0.194. That loss is a training number, not a score. Earlier
  copies are kept under alpha/history/ on the Modal volume for rollback.
- **The two feedback loops are built (owner asked 2026-09-29; they were parked
  until the release existed):**
  1. **Corrections as training data.** Every finish records which release
     drew the outline (`corpus.model_version`, beside `detected_shapes`).
     Approved corrections join `lawns: all`, so re-running workflow 14
     `release: alpha` ships a model trained on them. Nothing retrains by
     itself: there is no schedule, and a release should be a decision.
  2. **Active learning.** Workflow 26 (COSTS MONEY, ask first) runs the live
     model over approved, unclaimed lawn_jobs and writes
     `lawn_jobs.uncertainty`: the share of the lot put between 20% and 80%
     lawn. The queue (claimFor) hands out the least sure first; unscored lots
     stay random after them. **SPECULATION until measured:** that this
     uncertainty tracks where the model is wrong. Nothing here has tested it.
     The check is whether lots scored as unsure end up with larger
     corrections (detected vs finished) than the sure ones.
- **(Was parked by the owner, 2026-09-29, until the best arrangement was loaded
  into the live app. It now is; see the two entries above.)** Both needed the
  best arrangement loaded into the live app and the paid / volunteer / crowd
  tracing flows, which is why they waited on it.
  1. **Corrections as training data.** Every map a person finishes (or
     adjusts the detector's outline on) is a labelled example; training
     images already go to R2 on finish. Close the loop: those become the
     next training set, so the detector improves as the app is used.
  2. **Active learning -- the detector chooses what gets traced next.** NOT
     the training maps (they are already traced). It is the UNTRACED
     addresses: the detector is run over a pool of candidates (addresses
     people ask the live app about, or a batch of residential parcels), and
     the ones it is least sure of -- lowest confidence along the edge, or
     most disagreement between seeds -- go to the front of the tracing queue.
  Discussed and set aside: a second model "grading" the first (it cannot
  know the truth without human labels, and the remaining error is the edge
  band of H53, not implausible shapes); self-training on the detector's own
  confident output (possible later, but H57 says added data must be
  measured, not assumed).
- **The public outlines are dropped (owner, 2026-09-29).** They were mostly the
  middle of a road, roof or pond and rarely its edge. Replaced by NOT-LAWN
  TRACES the owner draws in tinker mode (#tinker: "Trace not-lawn" beside the
  inferred tools). Stored per map in `corpus.not_lawn`, written beside the
  labels as `<id>-notlawn.png` when workflow 14 runs with `not_lawn: on`
  (default off until measured), and graded "not lawn" by the decoder and the
  edge refiner -- even outside the property line. The cache ignores them.
  The `examples` input and its step are gone; tools/not-lawn-examples.js stays.
- **Not-lawn-only maps as examples (owner, 2026-10-02)** -- mostly for ponds,
  which the corpus barely has in lawns. A map of only not-lawn traces, once
  approved on the console (status `notlawn-approved`), is added by workflow 14
  with `not_lawn: on` as an EXAMPLE frame (`:example:` id): graded "not lawn"
  inside its traces and NOT AT ALL elsewhere, because "the not lawn shapes may
  not necessarily be surrounded by lawn". Trained on, never held out, never
  scored -- the same handling the approved public outlines had. Its photo is
  the map's own banked one. Nothing measured yet: a `not_lawn: on` run from
  now on is not comparable with one before it once such maps exist.
- **The pictures of S20's runs are the PLAIN decoder's, not THE PLAN's**
  (found 2026-09-29 from the owner's report that the edge-refiner layers were
  empty): the drawn-row lookup took the first row that could be THE PLAN's,
  and a `fused + edge` run scores the plain decoder first. Fixed
  (findPlanRow, tested); pictures from the next run on are THE PLAN's.
- **Measured (2026-09-29): H61 (S20), fewer outlines still worse overall**
  (14 better / 33 worse, +0.8) -- but they fixed the parking-lot lots (B20
  75 -> 36, B19 46 -> 30) and broke others (B03 57 -> 97, B23 33 -> 55).
  Not adopted; `examples: off` stays. Weighting the examples less is the
  untried next step (owner's call).
- **Measured (2026-09-29): H60, the edge refiner PASSES its bar.** 34
  better / 9 worse, -1.7 [-2.6, -0.5], p 0.0002; approved since 12 / 5,
  -0.5. **ADOPTED into THE PLAN (owner, 2026-09-29):** THE PLAN's row is
  now "decoder, edge refined + stage 3, span, lidar veto" (PLAN_ROW in
  train-detector.js and compare-runs.js), and workflow 14's default decoder
  is `fused + edge`, which still scores the plain decoder beside it. Runs
  before this name the old row; compare against them with --row.
- **Research done (2026-09-29): E11.** Published work agrees with H55-H59
  (bigger context wins; scales only combine well when a network learns the
  choice per location, trained on far more images than 55) and points at
  edge refinement for our actual error (PointRend, FeatUp's guided
  upsampling, boundary losses). Proposed as S19, not started.
- **Next, in this order (owner, 2026-09-29):** (a) S18's result; (b) DONE, see below: cache
  the frames, canopy, lidar, NAIP and backbone features per arrangement so
  an experiment is decoder + scoring only (free runner); (c) research what is
  PUBLISHED on tiling / windows / multi-scale for aerial segmentation with
  fine edges (candidates to check, from memory and unverified: hierarchical
  multi-scale attention, Tao et al. 2020; PointRend boundary refinement,
  Kirillov et al. 2020) and write it into the external-findings section.

- **The pictures were the same picture (found 2026-09-25, after H39).**
  Every run from H33 on drew its pictures for the lowest median, "canopy
  everywhere + stage 3, span", which is deterministic (H36), so the owner
  was shown the same drawings run after run while the row under test was
  never drawn. Fixed: a run draws THE PLAN's row (`PLAN_ROW` in
  tools/train-detector.js) when it scored it, and the picker names the row
  each run drew. Runs before the fix are unchanged on the page.
- **Pictures of THE PLAN's row are up (2026-09-26):** `runs/2026-09-25-2152-edt-scalemae-large-896px`, the first drawn for the row actually adopted.
- **Decided (2026-09-27): H50, the fused inputs are NOT adopted.** 55
  lots, folds by place, three seeds a side: THE PLAN's row 23 lots better,
  20 worse, median change -0.1 [-0.7, +0.4]. The seeds of one setting
  differ by 2.5 points, more than the setting does -- so from here a
  single-seed comparison is a screen, never a result. H51 (the 10-fold
  method check) is superseded by it. The six unfused runs are the x1
  baseline S12 is read against.
  **Workflow 24 cannot be dispatched yet:** GitHub only offers manual
  workflows that exist on the default branch (`claude/new-session-8204jd`),
  and compare-runs.yml exists only on this branch; the same code
  (tools/compare-runs.js) was run on the six downloaded lot-results files.
- **Decided (2026-09-28): H54, colour on the edges is NOT adopted.** 55
  lots, fused, seeds 7/8/9: 25 better / 20 worse, -0.3 [-1.0, +0.3], p
  0.55; on the lots approved since, 7 better / 10 worse. The row stays
  scored beside THE PLAN's at no cost.
- **Decided (2026-09-28): H55, fixed blocks (S13) NOT adopted.** 6 cm:
  21 better / 31 worse, +0.9; 10 cm: 23 / 25, +0.2. Both move the same lots
  by tens of points (B28 and B03 far better, B20 far worse) -- and NOT by
  lot size (B13, the biggest, got much worse). S13 closed.
- **In flight (2026-09-28): S16, the not-lawn examples in training** --
  nine runs: whole lot, windows and tiles 6 cm, each with the approved
  examples, three seeds each. Bars written above before they ran.
- **Also in flight (2026-09-28): S17, both scales** -- whole-lot and 6 cm
  block features stacked for every lot (`windows: both`), examples on,
  canopy on lawn, three seeds. Bars in S17, written before the runs.
- **Decided (2026-09-28): H57, the not-lawn examples are NOT adopted.**
  Worse at the whole lot (14 better / 38 worse, +2.7 [+1.1, +4.6]) and under
  windows (11 / 40, +3.3 [+1.4, +5.0]). The pond (B12) improved; many lawns
  did not. The relaunched runs on 6792729 still carry examples (cropped),
  so they measure the arrangements WITH examples and the crop; the clean
  both-scales question is three more runs without examples against S14.
- **Cache built (2026-09-29, owner's order):** workflow 14 `cache: use` (the
  default) saves the canopy, lidar, lidar plan and NAIP under a key of the
  frames' fingerprint (every byte of every photo, label and scale.json) +
  the code that makes them, and the backbone's features under the
  fingerprint + model + size + arrangement + extractor code. A hit skips
  those steps; a new lot, a re-trace or a code change misses by itself.
  `rebuild` ignores the saved copy. Free runner only (`gpu: github`).
  **Measured (2026-09-29): it hits.** The frame dump is byte-identical run to
  run (fingerprint d7a05dc197df67e7d9d7 both times). Run 36528025528 built
  the caches (canopy/lidar/NAIP 4.7 MB, features 657 MB); its extraction job
  took 43 min (canopy 9, lidar 12.5, NAIP 1, backbone 17). Run 36535770825,
  the next commit with the same frames, restored both, skipped all five steps,
  and its extraction job took 2 min 40 s. So an experiment now costs just
  the decoders and the scoring: about 13 min per decoder, and three for a
  canopy comparison. **Same scores (checked 2026-09-29):** the three rows
  that depend on the features and frames alone ("colour and texture only",
  "the pretrained eye only", "both") match on all 55 lots to the hundredth
  between the run that built the cache and the run that restored it. The
  decoder rows differ, as they should: those two runs used seeds 7 and 8.
- **Decided (2026-09-29): H59, both scales is closed; the whole lot stays.**
  Six seeds a side: 26 better / 19 worse, -0.2 [-1.2, +0.4], p 0.37 --
  weaker than H58's three-seed lean. Every arrangement tried (windows,
  blocks, max block, both scales) has now failed against the whole lot.
- **H58 (2026-09-29): both scales leans better, misses its bar** (27 better
  / 16 worse, -0.4 [-1.4, +0.2], p 0.13). S18 is the deciding test: six
  seeds a side, both sides on the GPU, bar written before the runs.
- **Modal is opt-in, with the owner's approval (2026-09-29):** $8.78 in the
  first day, about $1 a run -- well over the $0.20-0.40 estimated. Default
  back to `gpu: github`; job limit 360 min (GitHub's ceiling) for each of the
  two jobs. S18's two relaunched seeds (A seed 11, B seed 10) were moved off
  Modal to the CPU runner: S18 is therefore NOT all-GPU as barred -- two of
  its twelve runs are CPU, a known shift of about half a seed on those two.
- **Modal refuses a burst (2026-09-29):** of eight S18 runs dispatched in one
  minute, two (36503989380, 36503994244) died four minutes in on Modal's
  "App create rate limit exceeded". tools/modal-run.sh now retries that
  error, and only that, up to six times with a growing random wait; the two
  seeds were relaunched. No result was lost -- they never reached the GPU.
- **Modal GPU, built 2026-09-28 (owner set up the account):** workflow 14
  `gpu: modal` runs the tree model, the backbone and the decoders on a GPU
  on Modal (tools/modal_gpu.py, plan from tools/modal_plan.py, pinned to
  the workflow by modal_plan_test.py); downloads and the scorer stay on
  GitHub. The scripts use the GPU when there is one and are unchanged on
  the CPU (decoder smoke run: identical losses). FIRST CHECK, not a result:
  a repeat of S14 seed 7 on the GPU, against 36355253442 -- GPU arithmetic
  differs from the CPU's in the last digits, so how far that moves lots is
  itself worth knowing before GPU runs are compared with CPU ones.
  **Measured (run 36488404436, S14 seed 7 on an L4):** THE PLAN's row 26.3
  -> 26.2%, paired change +0.2 [-0.4, +0.8], 19 better / 23 worse / 13
  level, p 0.64. A lot moves 1.2 points (median |GPU - CPU|; max 53, the
  Georgia lot) against 2.6 for seed 7 -> seed 8 on the CPU. So GPU and CPU
  runs may be compared, and a GPU-vs-CPU difference is about half a seed's.
  **Time:** canopy 3 min (7 on CPU, incl. the first image build), backbone
  + three decoders 12 min (~42), extraction job 28 min (~73), whole run
  ~60 min (1 h 43). Workflow 14's `gpu` default is now `modal`.
- **The two-job split failed its first real run (2026-09-28, 21:02):**
  artifacts refuse file names with a colon, and every lot id has two. All
  twelve runs on 6792729 / cffd94b were cancelled or died at that step (no
  results). Fixed by handing over one tar file. RELAUNCHED, and narrowed
  after H57: both scales WITHOUT examples (S17's real question, vs S14) and
  the whole lot with the CROPPED examples (does the crop change H57?). Tiles
  and both scales WITH examples are dropped -- H57 already says examples
  are not adopted, so those runs would decide nothing.
- **The examples made every run ~3.6x longer (2026-09-28, measured):** 90
  examples, 145 frames beside 55 lots. Whole-lot backbone 12 -> 46 min, each
  decoder 10 -> 33 min; windows backbone 78-91 min. The 6 cm tile runs and
  S17 could not finish inside a job's six hours, so they were CANCELLED
  mid-backbone (runs 36450763774 / 36450766989 / 36450771744 and
  36453431102 / 36453434382 / 36453439067 -- no results; do not read them).
  Fixed in workflow 14: extraction and training are now TWO jobs (the work
  passed as an artifact), each with its own limit; and the decoder trains on
  each example cropped to its graded cells plus 4 (more than its reach).
  The crop changes batching and the standardiser for examples, so S16's
  whole-lot and windows runs (uncropped) are NOT like-for-like with the
  relaunched tiles and S17 runs: whole-lot with examples is re-run on the
  new code as S17's comparison side, and the old-vs-new whole-lot pair says
  what the crop moved.
- **Decided (2026-09-28): H56, the owner's "maximum block size" (S15,
  `windows: on`) is NOT adopted.** Three seeds against the fair baseline
  (S14's runs -- H50's predate NAIP alignment): 18 better / 28 worse,
  +0.6 [-0.1, +1.4]; lots approved since 6 / 15. The whole-lot squeeze
  stays. B28 improves under every finer reading (85 -> ~30).
- **Owner decisions and a scoring question, 2026-09-27 (afternoon):**
  - **Lidar canopy is shelved** ("the canopy model is doing the intended
    function better"): the "lidar ∩ NAIP canopy" rows now run only with
    LIDAR_CANOPY=1. It never fed THE PLAN's row, whose veto is roof and
    void, and that veto STAYS (owner, confirmed the same evening).
  - **Trust order (owner):** the Mapbox photograph first, then lidar, then
    NAIP last -- NAIP is soft and sometimes shifted or slightly mis-scaled
    against Mapbox in the editor. Note the near-infrared IS NAIP (bands
    3,0,1); there is no other NIR source. Nothing currently imposes the
    order except modality dropout (NAIP 0.2, lidar 0.3, the photograph
    never dropped) and the photograph's 1024 numbers a patch against seven.
    **Built 2026-09-27:** NAIP is lined up with the photograph edge for
    edge (public/lib/align.js; the same arithmetic in tools/naip_align.py).
    In the EDITOR, showing NAIP or NDVI aligns it on the spot, says how far
    it moved, and offers nudges (25 cm, 0.25% scale); what the person
    settles on is saved as corpus.naip_align. In the PIPELINE,
    tools/naip_bands.py applies a saved alignment, otherwise aligns each
    frame against its own photograph, and prints the move per frame
    (naip-align.json). Not yet measured: whether it changes any score.
  - **The frame is not to grow** (owner). Padding is still to be cut for
    lots that sit diagonally (a rotated crop); not yet done.
  - **Water:** the owner will add a handful of maps with ponds.
  - **Public already-drawn outlines (owner: yes, but he reviews and tweaks
    them before the detector is shown any).** tools/public_negatives.py
    (44 offline checks) fetches, per box: OSM via Overpass (buildings,
    water, pools, roads/driveways/parking/sidewalks buffered by a class
    half-width, rail), USGS NHD waterbodies, Microsoft building footprints.
    Live: works; overpass-api.de refuses this sandbox, mirrors answer, busy
    mirrors 504. Positional accuracy is 1-3 m (OSM), ~12 m (NHD) -- worse
    than H53's half-metre edge band, so these are to be trusted in their
    INTERIORS only (shrunk ~1 m, ignore band at their edges) and never used
    to score. Licence: OSM and Microsoft are ODbL -- attribution, and
    share-alike if the derived label set is ever published. Not wired in.
    **Fetched 2026-09-27 (workflow 25, run 36352185509):** drafts for all 55
    approved maps, 2 to 38 outlines each, mostly buildings and roads; one
    map got no OSM (every Overpass mirror busy), NHD/Microsoft still
    answered. Water on only 3 maps and a pool on 1 -- and **not on B12: the
    pond is in neither OSM nor NHD**, so public outlines will not teach the
    pond. The owner's handful of pond maps is the route for water.
    **And they were built in the wrong place (the owner, same night):**
    fetched over the corpus's own frames, they mostly repeat what the
    tracing already says inside the lot line -- the only new ground is the
    padding, which is being cut. The owner's idea was examples of not-lawn
    from ANYWHERE: frames centred on public outlines away from our maps,
    labelled only on the outline, the rest ignored. Not built yet.
  - **ANSWERED (H53): the ~10% is a half-metre band along the true edge (94%
    of B01's error within 0.5 m), not registration, not the tracing.**
  - **B01 scores ~10% on a near-perfect picture, under every method, colour
    too.** The picture is the TRACE; the "% out" is the raw MASK. The scorer
    now prints, for THE PLAN's row, the outline's own error, the share of
    the mask's wrong ground within 0.5 m and 1 m of the true edge, and the
    shift (up to 0.6 m) that best lays the mask on the truth, which would
    expose a registration offset; the page shows the outline's figure
    beside the mask's. Run launched to read it.
  - **THE MAIN SET-UP IS FUSED (owner, 2026-09-27 evening):** workflow 14's
    decoder defaults to `fused`; `on` stays as the other arm. H50 measured
    them level; the owner's reasoning is that fused should scale better.
- **Decided (2026-09-27): H52, Scale-MAE keeps being told metres a
  pixel.** Its pretraining used a relative scale of 2.2-5 (E2's
  correction), but x5, x10 and x25 each scored 1.4-2.6 points worse lot
  by lot than x1 on 55 lots. S12 closed. **Nothing in flight.** Next, by
  the owner's priorities: the padding test (blank the ground outside the
  lot line vs keep it, S12's note), and teaching lawn under trees.
- **Before that (2026-09-26, after H48).** The fused inputs (S11)
  FAIL their bar on THE PLAN's row (26.6 → 26.5%, bar 24.6) and are not
  adopted — but the fused decoder ON ITS OWN reads 25.0%, below THE PLAN's
  26.6% with no stage 3 and no veto (H48). A different row from the one the
  bar was written for, so recorded as a lead, not a result. Open, in order:
  (1) the canopy-channel leak H48 names (the "on lawn" decoder learns
  "canopy input = not lawn"); (2) stale lidar — B28, whose trees are gone
  (H40), went 69.5 → 79.5%; (3) a bar for "fused decoder, no stage 3" as a
  candidate plan. H47's woods row is still unbuilt.
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

  **Since 2026-09-29 stage 1 ends in the edge refiner (H60, adopted by the
  owner):** tools/edge_refine.py, a small net on the 15 cm scoring grid that
  sees the photograph and the decoder's answer and re-draws the edge, trained
  with the decoder in every fold. 34 lots better / 9 worse, -1.7 [-2.6,
  -0.5]. Workflow 14 `decoder: fused + edge`, the default.

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

### H91. The decoder's flips and quarter turns are worth nothing measurable at 81 lots: the same decoder trained with every grid as drawn scores the same, lot by lot (28 better / 23 worse / 30 level, paired change -0.0 [-0.3, +0.1], p 0.58) -- 2026-10-10

S34's trial, workflow 14 `refiner_trial: no flips`, seeds 7 / 8 / 9 (runs
37999935674 / 38000318035 / 38000326730), the locked 81, CPU. Read with
workflow 24 run 38017280676: THE PLAN's row ("decoder, edge refined + stage
3, span, lidar veto") against "decoder, no flips + stage 3, span, lidar
veto" of the same runs, so the features, folds and seeds are shared and
only the orientation of the training grids differs.

| lots | no flips better / worse / level | paired change [95%] | sign test |
|---|---|---|---|
| all 81 | 28 / 23 / 30 | -0.0 [-0.3, +0.1] | p 0.58 |
| the frozen 32 (tuned on) | 12 / 5 / 15 | -0.2 [-0.7, +0.1] | p 0.14 |
| approved since (untuned) | 16 / 18 / 15 | +0.0 [-0.2, +0.6] | p 0.86 |
| county photo | 5 / 5 / 1 | -0.2 [-2.8, +2.8] | p 1.00 |
| Mapbox photo | 23 / 18 / 29 | -0.0 [-0.2, +0.1] | p 0.53 |

- **Read as S34 said before the runs: NO DIFFERENCE.** Geometric
  augmentation buys nothing measurable at this size, and more of the same
  kind (crops, resizing) is unlikely to. Colour augmentation stays an open
  question, weaker for this; it would need the backbone run again per copy.
- **The headline medians said otherwise, and were noise.** Seed 7 alone read
  22.4% with flips and 20.7% without; across the three seeds THE PLAN's own
  medians were 20.4 / 22.4 / 21.5 and the no-flips row's 22.0 / 20.7 / 20.7.
  A seed moves a median two points (rule 2); the paired lots do not move.
- **Flips stay on.** Nothing here says to change THE PLAN, and taking out a
  regulariser on the strength of "no difference" at 81 lots would be reading
  the absence of evidence as evidence.
- Eleven county lots, not twelve: the Franklin County map is Mapbox-drawn
  since 2026-10-09 (H88's note).

### H90. County examples in training are worth nothing measurable to the county lots: scored by a decoder that never saw a county photo they come out the same (5 better / 6 worse, +0.9 [-1.9, +5.4]), and the matched Mapbox control moves as little (6 / 4, -0.8) -- 2026-10-08

Three seeds (7/8/9), free runner, `lawns: locked` (81), `refiner_trial: held
out by photo`: 37791602756, 37791654341, 37791705849. Each arm against THE
PLAN's own row of the same runs (place folds, so a county lot's usual decoder
trained on about 75 lots including up to 11 county ones). Workflow 24
37810027839 and 37810065383; workflow 33 37810102936.

| arm | lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|---|
| county lots, decoder trained on the 69 Mapbox lots only | 12 | 5 / 6 / 1 | 55.5 -> 54.7% | +0.9 [-1.9, +5.4] | p 1.0 |
| 12 Mapbox lots held out the same way (control) | 12 | 6 / 4 / 2 | 24.5 -> 23.5% | -0.8 [-2.0, +0.8] | p 0.75 |

County lots A -> B: C99 130 -> 141, C94 101 -> 84, C79 76 -> 82, C88 61 ->
66, C87 56 -> 55, C80 56 -> 47, C89 55 -> 55, C74 46 -> 57, C81 29 -> 34,
C66 25 -> 25, C82 21 -> 23, C71 7 -> 5.

- **Taking every county photo out of training changes nothing for the
  county lots.** The arm's change (+0.9) and the control's (-0.8) are 1.7
  points apart with intervals that overlap zero on both sides; losing the
  training lots themselves costs nothing visible either way.
- **So H88's 55% vs 19% is not a want of same-look examples.** What H89
  measured -- the lawn's contrast with the rest of the lot, and how little
  of these lots is lawn -- stands as the explanation on the table. Nothing
  here says the county default is hurting the AI, and nothing says it is
  not; that is the live split (S32 design 1).
- **What it cannot say:** the usual decoder had at most 11 county examples
  to learn from, so this is "11 against none", not "a hundred against
  none". Whether many county examples would form a pocket of their own
  (the B case) is untested and untestable until there are many.
- Workflow 33's change report over the 12 lots found no measure tracking
  the change (every p over 0.1); at twelve lots it would have to be large.
- Nothing adopted; the `held out by photo` arm stays for the next question
  of this shape.

### H89. What makes a lot hard, measured on each lot's own photo: the lawn's CONTRAST with the rest of the lot predicts the error within each source (rank -0.41 Mapbox, -0.63 county); sharpness does not; the share of the lot that is lawn predicts it most of all (-0.62) -- 2026-10-08

Workflow 33 run 37783174587 (tools/lot-hardness.js), over THE PLAN's row of
the S31 runs (the locked 81, error averaged over 3 seeds). Each lot's banked
photo, inside its property line, resampled to 7.5 cm a pixel; shadow pixels
(luma under 50) left out of the colour and focus measures. Rank correlations
with the lot's error, permutation p; "low / high" are the median error of the
lots below and above that measure's median.

| measure | all 81 | Mapbox 69 | county 12 | low half -> high half (all) |
|---|---|---|---|---|
| contrast: lawn vs rest, excess-green d' | **-0.47, p <0.001** | **-0.41, p 0.001** | **-0.63, p 0.03** | 31.8% -> 14.2% |
| green: the lawn's excess-green | -0.20, p 0.08 | -0.08, p 0.47 | -0.43, p 0.15 | 25.9% -> 17.8% |
| shadow: share of the lot dark | +0.18, p 0.10 | **+0.26, p 0.03** | -0.29, p 0.35 | 23.4% -> 20.6% |
| sharp: focus (blur ratio) | +0.08, p 0.47 | +0.03, p 0.80 | +0.07, p 0.83 | 20.7% -> 22.7% |
| bright: median luma | -0.15, p 0.20 | -0.23, p 0.06 | +0.28, p 0.38 | 23.8% -> 17.4% |
| **lawn: share of the lot that is lawn** | **-0.62, p <0.001** | **-0.54, p <0.001** | **-0.75, p 0.007** | 33.7% -> 14.8% |
| size of the lawn, m2 | -0.31, p 0.004 | -0.19, p 0.13 | -0.48, p 0.12 | 25.7% -> 19.0% |

Source with contrast held level (thirds by contrast rank): low third county 6
lots 66.1% / Mapbox 21 lots 33.7%; middle third county 6 / 37.3% vs Mapbox
21 / 22.9%; high third county **0** lots, Mapbox 27 lots 13.5%.

- **The owner's reading holds (owner, 2026-10-08: less contrast between
  dormant grass and bare dirt or leaf litter):** how far the lawn's colour
  sits from the rest of the lot's, in THIS photo, predicts the error, and it
  does so inside the Mapbox lots alone and inside the county lots alone. The
  lawn's greenness by itself barely does (a dull lawn on dull ground is the
  problem, not dullness). Not one county photo is in the high-contrast
  third: they are leaf-off flights, as the owner said, and the county lots'
  excess-green runs 0.00-0.12 against Mapbox's up to 0.36.
- **Sharpness is not it.** The focus measure separates the sources (county
  1.06-1.47, Mapbox 1.04-1.16) and tracks error nowhere. "Sharper photos
  confuse the model" is not supported.
- **Shadow: a modest, real effect within Mapbox** (+0.26, p 0.03), none
  visible in the 12 county lots, which carry little shadow (0-21%). Fits the
  owner's "heavy shadows have no correlation with the source".
- **The strongest predictor is how much of the lot is lawn, and that is
  partly the METRIC.** Error is wrong ground as a share of the TRUE lawn, so
  the same misread driveway costs a lot that is 4% lawn a hundred times what
  it costs one that is 80% lawn. C29 (406%) is 4% lawn; C80 (56%) 12%; B19
  (79%) 18%; C88 (60%) 19%. Every "worst lots" list in this file is partly a
  list of lots with little lawn in them. A second figure that does not
  depend on how much lawn there is (wrong ground as a share of the LOT, or
  intersection over union) would read those lots fairly; not changed here,
  because every accuracy figure the owner has been given is on the current
  one.
- **County lots are still worse at matched contrast** (6 vs 21 lots a cell,
  so roughly), and they also have less lawn in them (median share about 45%
  against Mapbox's about 58%). Contrast and lawn share together explain much
  of H88's 55% vs 19%; whether anything is left for "the decoder has seen
  only 12 county photos" is S32's remaining question.
- Correlations over 81 lots, not an experiment: the measures are
  confounded with each other and with source. The within-source contrast
  result is the cleanest piece. The owner's leaf-off mark is set on one lot
  of the 81, so it could not be used.

### H88. The 12 locked lots drawn on county photos are the worst group in the corpus: median 55.2% error against 19.0% for the 69 drawn on Mapbox -- cause NOT established, 2026-10-08

THE PLAN's row ("decoder, edge refined + stage 3, span, lidar veto") over the
S31 runs 37666184686 / 37666283016 / 37666382432 (the locked 81), split by the
photo each map was drawn and saved on (workflow 24 run 37766196684, the new
`--photos` split; image_provider from the database).

| photo the map was drawn on | lots | median error |
|---|---|---|
| county photo | 12 | 55.2% |
| Mapbox | 69 | 19.0% |

The county lots, worst first: C99 130.0, C94 101.2, C79 76.0, C88 59.5, C87
56.1, C80 55.9, C89 54.5, C74 45.7, C81 28.9, C66 25.3, C82 20.7, C71 6.6.
Four of the lots that recur in H79-H86's "most worsened" lists (C79, C80,
C89, C94) are county lots; C29, the worst lot in the corpus (400%+), is not.

- **Corrected first (owner):** an earlier answer said all 81 train on
  Mapbox. Wrong: training reads each map's SAVED photo (photoKeyFor ->
  image_key), and maps drawn on a county photo save that photo
  (storeCountyImage). Of the 25 newest approved maps 15 were drawn on county
  photos and all 15 have it saved; 12 are in the locked 81.
- **What this does NOT say:** that county photos are the cause. The county
  lots are also the newest maps, and newer maps may simply be harder lots;
  nothing here tells the two apart. Lot difficulty and photo are confounded.
- Plausible mechanisms, all speculation until tested: 12 county lots against
  69 Mapbox ones, so the decoder mostly learned the Mapbox look; county
  photos are sharper (about 6 cm against 10-15) and Scale-MAE is told one
  scale for both (see S12); colour and season differ by flight.
- The test that would separate them is in S32.
- **One of the 12 was not a county lot (owner, 2026-10-09).** The Franklin
  County, OH map (`-83.19566,40.04976:manual:manual`, 9,103 sq ft, hand
  drawn, saved 2026-10-02 15:15Z) "was falsely marked as being drawn on
  county photo, it was drawn on mapbox": a Mapbox outline over a saved
  county photo, the one mismatch the corpus decision ruled out, in the lock
  since 2026-10-02 and so in this table, in H89's county group and in H90's
  held-out county set. The record was corrected the same day (the county
  page's "It was drawn on Mapbox": Mapbox's photo becomes the map's own),
  and the app now records the photo that is ON the map at Finish rather than
  the one picked (shownProvider in app.js: 'county' was set before the
  picture had arrived). The 12 county lots are 11, and the lot's own error
  under the mismatch is unknown; nothing here was re-run.
- **And "county photo" is not one kind of photo (2026-10-09).** That map's
  banked county photo was Franklin County's 2025 LEAF-ON tile layer
  (catalogue #1151: 22.9 cm native, "Summer of 2025"), upsampled to the
  frame's 5.9 cm a pixel -- green lawns, soft, long summer shadows -- while
  every service the picker offers there today (Ohio's "most current" #531 /
  #543, Columbus Imagery2025 #3052) serves the same leaf-off 2025 flight,
  sharp. On 2 October the ranking was newest year first with no sharpness
  check, and #1151 (2025) was the newest; the newest-SHARP rule (3b08d42,
  that evening) now puts it last. So county lots banked on 2 October may
  carry a softer, leaf-on photo than the one a person sees today, and the
  lot-hardness measures (H89) read the banked file, which is right. Which
  other lots: not yet listed (workflow 9 now prints each map's pair row and
  the catalogued services over it).
- **The pair photos were all re-banked on 2026-10-09 (~04:00 EDT)** under
  the new rule (newest flight, the sharper of a tie; chooseBest). Meant for
  one map: a `-- remark` inside the SQL, flattened to one line by the
  database helper, had swallowed the LIMIT, the id and the "never replace a
  traced photo" guard (fixed: corpus-db.js flatSql). 60 of 87 approved maps
  got a county photo from the current best service, 45 measured as landing
  within 0.1 m; every "lines up" verdict on them was reset to unjudged, as a
  new picture always is. This touches county_imagery only -- the pair's
  county side -- never a map's own photo or the training lock.

### H87. The live model measured on real use for the first time: release 1 changed by a median 23.4% on 25 approved maps, against the 24.0% its folds predicted -- 2026-10-08

Workflow 7 run 37709290743, its new section "The live releases" (2026-10-08):
every map finished with a release recorded (`corpus.model_version`), the
outline that release drew against the one the person finished with. Free.

| release (trainedAt) | review state | maps | median changed | kept as drawn |
|---|---|---|---|---|
| 2026-10-07T15:52:29Z (v3) | not yet reviewed | 1 | 0.0% | 1 |
| 2026-09-29T21:10:24Z (v1) | approved | 25 | 23.4% | 0 |
| 2026-09-29T21:10:24Z (v1) | not yet reviewed | 8 | 0.0% | 5 |

- **The one solid number:** release 1, on the 25 approved maps people
  finished with it, was changed by a median 23.4%. The configuration that
  chose it scored 24.0% under folds (run 36601001355). Those lots were not
  in release 1's training set (it was trained on the 55 before it), so this
  is the first out-of-sample check of the fold scores, and they held.
  One release and 25 maps; not a rule.
- **What it is not:** "changed" is how much the person moved the outline,
  not checked error. An outline accepted as drawn scores 0 whether it was
  right or not. That is why the not-yet-reviewed rows sit at 0: 5 of v1's 8
  and v3's 1 were finished untouched. Approval is what makes a row a score.
- **v2 drew no finished map** in the week it was live, and v3 has one. The
  live score of the current model needs more finished, approved maps; until
  then the fold numbers are the best estimate and H87 says they are honest.

### H86. Less of the middle layers (S31) does not pay either: layer 8 alone 28 / 24, layer 16 alone 30 / 19, both small 28 / 25 -- none passes, 2026-10-07

Three seeds (7/8/9), free runner, `lawns: locked` (81), `layers: variants`
(features from the cache): 37666184686, 37666283016, 37666382432. Workflow 24
(37701688682 / 37701716621 / 37701744745) for each arm against "decoder, edge
refined + stage 3, span, lidar veto" of the same runs (A's run medians 21.2 /
22.0 / 22.4).

| arm | all 81: better / worse / level | paired change [95%] | sign test | frozen 32 | untuned 49 | B's run medians |
|---|---|---|---|---|---|---|
| layer 8 (256) | 28 / 24 / 29 | -0.1 [-0.4, +0.2] | p 0.68 | 14 / 5, -0.4 [-1.0, +0.1], p 0.06 | 14 / 19, -0.0 [-0.3, +0.6], p 0.49 | 22.2 / 21.2 / 21.9 |
| layer 16 (256) | 30 / 19 / 32 | -0.1 [-0.4, +0.0] | p 0.15 | 12 / 8, -0.0, p 0.50 | 18 / 11, -0.2 [-0.5, -0.0], p 0.27 | 22.6 / 21.3 / 22.7 |
| both, 64 each | 28 / 25 / 28 | -0.0 [-0.2, +0.2] | p 0.78 | 13 / 6, -0.2, p 0.17 | 15 / 19, +0.1 [-0.1, +0.8], p 0.61 | 22.6 / 21.9 / 20.9 |

The lots S31 was chasing (A -> B):

| lot | layer 8 | layer 16 | both small | (H85, both at 256) |
|---|---|---|---|---|
| B20 (parking lot) | 73.0 -> 57.1 | 73.0 -> 59.2 | 73.0 -> 56.7 | 73 -> 48 |
| B19 (parking lot) | 79.3 -> 68.2 | 79.3 -> 70.6 | 79.3 -> 69.7 | 79 -> 65 |
| C29 | 406.3 -> 423.0 | not in the five worst | 406.3 -> 520.4 | 407 -> 479 |
| C80 | 55.9 -> 65.9 | not in the five worst | 55.9 -> 61.6 | 56 -> 67 |

- **S31's bar fails for all three.** No arm has a sign test under 0.05.
  Layer 16 comes closest (30 / 19, interval touching zero), and that is
  still within what one of three arms tried at once does by luck.
- **The parking-lot gain is real and repeatable, and it does not come free.**
  Every arm and H85 cut B20 by 14-25 points and B19 by 9-14. Every cut
  shrinks as the layers shrink. The cost moves rather than vanishing: layer 8
  and both-small pay at C29 and C80 as H85 did. Layer 16 avoids those but
  loses B28 (30.8 -> 34.7) and C94 (101 -> 114).
- Reading (speculation, not a finding): the texture that tells pavement from
  grass sits in the middle blocks, and the decoder uses it everywhere, not
  only where it helps. Something that applies it only near uncertain cells
  might keep the gain. That would be a bigger change than this trial and is
  not built.
- Nothing adopted. `layers` stays `last`; the variants machinery stays.

### H85. Scale-MAE's middle layers (S30) do not pay overall (29 lots better / 23 worse, p 0.49) -- but they cut the parking-lot lots by 15-25 points, 2026-10-07

Three seeds (7/8/9), free runner, `lawns: locked` (81), `layers: compare`
(blocks 8 and 16, 256 numbers each, beside the last layer): 37628852627,
37628956583, 37629069477 -- a fresh extraction (the cache key changed).
Workflow 24 (37657411739) against "decoder, edge refined + stage 3, span,
lidar veto" of the same runs.

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 81 | 29 / 23 / 29 | 22.1 -> 21.1% | -0.1 [-0.4, +0.1] | p 0.49 |
| frozen 32 | 13 / 6 / 13 | 24.5 -> 25.2% | -0.3 [-0.7, +0.1] | p 0.17 |
| untuned 49 | 16 / 17 / 16 | 21.9 -> 19.8% | -0.0 [-0.3, +0.4] | p 1.0 |

Runs' medians B 20.8 / 21.3 / 20.8 (A as before, about 21-22).

- **S30's bar fails:** no overall change; the interval spans zero. The
  median's 1-2 point drop is level lots reshuffling, not a paired change.
- **But the biggest movers are the lots nothing else fixes:** B20 73 -> 48,
  B19 79 -> 65 (the two parking lots, H81), B03 72 -> 59, B32 33 -> 27, C88
  60 -> 55. Worse: C29 407 -> 479, C80 56 -> 67, C30, C94, B12 by 4-5.
  Reading (speculation): the middle layers keep texture -- pavement against
  grass -- that the last layer has abstracted away; that helps where the
  decoder confuses the two and costs a little elsewhere. A future arrangement
  (fewer dims, one layer, or the middle layers only near uncertain cells)
  might keep the gain without the cost. Not adopted.
- The S30 machinery stays (`layers: compare`, default `last`).

### H84. 30 epochs stays: 15 is worse (21 lots better / 45 worse), 60 is no different (25 / 31) -- 2026-10-07

Three seeds (7/8/9), free runner, `lawns: locked` (81), `refiner_trial:
epochs`: 37618116401, 37618210051, 37618300740. Workflow 24 (37653137736,
37653169547) against "decoder, edge refined + stage 3, span, lidar veto" (30
epochs) of the same runs.

| epochs | better / worse / level | paired change [95%], all 81 | untuned 49 | runs' medians |
|---|---|---|---|---|
| 15 | 21 / **45** / 15, **p 0.004** | **+0.8 [+0.3, +0.9]** | 11 / 28, +0.8, p 0.009 | 22.6 / 21.3 / 23.2 |
| 60 | 25 / 31 / 25, p 0.50 | -0.1 [-0.3, +0.5] | 13 / 20, p 0.30 | 21.3 / 22.5 / 21.7 |

- **Half the training is clearly worse**, with C29 blowing up (407 -> 665)
  and C40 34 -> 58, though B03, C88 and B19 improve.
- **Twice the training changes nothing measurable.** By the owner's rule
  (equivalent -> the cheaper one), 30 stays; 60 would double training time
  for no gain. Untested: whether more epochs matter for an average of three
  (H83), or once the corpus grows.
- **Release v3 (three decoders averaged, 30 epochs) shipped the same day**
  (run 37643197968, trainedAt 2026-10-07T15:52:29Z) and answers on the live
  server: workflow 32, 4 lots, decoder step 0.1-0.2 s (37652744226).

### H83. An average of three decoders (S28) beats THE PLAN's single one, modestly: 31 lots better, 9 worse, -0.3 [-0.4, -0.1] -- passes its bar, not released, 2026-10-07

Three seeds (7/8/9), free runner, `lawns: locked` (81, `05cs4ud`),
`refiner_trial: average of 3`: 37582634690, 37582729096, 37582829432.
Workflow 24 (37615148959) against "decoder, edge refined + stage 3, span,
lidar veto" of the same runs (runs' medians 20.9 / 22.5 / 22.0).

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 81 | **31 / 9 / 41** | 22.0 -> **20.3%** | **-0.3 [-0.4, -0.1]** | **p 0.001** |
| frozen 32 | 7 / 3 / 22 | 24.5 -> 24.5% | -0.2 [-0.3, +0.0] | p 0.34 |
| untuned 49 | 24 / 6 / 19 | 21.9 -> 20.3% | -0.4 [-0.9, -0.2] | p 0.001 |

Runs' medians B 20.3 / 22.1 / 20.7.

- **S28's bar passes on every part:** p 0.001 with more lots better, the
  interval wholly below zero, the untuned 49 the same way.
- **Small per lot, consistent:** half the lots do not move (41 level); the
  ones that do mostly improve, by about a third of a point at the middle.
  The median's 1.7-point drop is mostly level lots reshuffling -- the paired
  change (-0.3) is the honest size.
- **Best:** B20 73 -> 66, C88 61 -> 56, C99 130 -> 126, B19 80 -> 76 -- the
  parking-lot lots the refiner hurts (H81) recover part of it. **Worst:** C29
  407 -> 426, C94 101 -> 111, C33, B04, B22 by 1.5-2.5.
- **Cost:** training 3x (seed 9: 2 h 07 m against 42 m for one refined
  decoder; free runner). Live: three decoder + refiner passes, Scale-MAE once.
  NOT MEASURED; estimated from the arithmetic as 1-10 % more GPU work a lot
  (Scale-MAE ~2 TFLOP at 896 px; one decoder + refiner ~10 GFLOP on a typical
  lot, ~100 on the largest), and less in time, since a lot's time is mostly
  downloads and CPU. Not wired for a release yet (train_decoder RELEASE_OUT
  saves one decoder).
- **Cost, MEASURED 2026-10-07 (workflow 32, run 37618404581, 8 lots on the
  live L4, the first a cold start):** median per warm lot, server seconds:
  total 12.3, of which waiting for the lidar/NAIP downloads 11.0, Scale-MAE
  0.8, tree canopy 0.1, decoder + refiner 0.1 (the server rounds to 0.1 s;
  0.0-0.1 on every lot, up to 633 x 1024 cells). So two more decoders add
  about 0.2 s to a ~12 s lot: about 2 % of the GPU's billed time, a fraction
  of a cent per thousand lots, and no visible wait for the person.
- **Seen in passing (not acted on):** the GPU sits for ~11 s of a lot's
  ~12 s waiting on downloads (C88: 13.9 of 17.8). If the GPU were woken only
  after the downloads, most of each lot's GPU bill would go. A cost lever,
  bigger than anything decoder-side; for the owner to decide.
- **Tried and undone the same day (owner: "fix the GPU waiting"):** fetching
  the lidar and NAIP at once instead of one after the other. Workflow 32,
  same 8 lots, median GPU wait: **11.0 s before; 14.8 s together on one CPU;
  10.9 s together on two CPUs** -- no gain, both changes reverted. The lots
  show why: once NAIP is cached it takes 0.2-0.9 s, and the LIDAR (6-21 s)
  is nearly all of the wait, so overlapping the two saves little. Also: on a
  COLD press the GPU is still starting while the downloads run (C99 waited
  0.6-1.9 s), so the wait only costs on a press that finds the GPU warm.
- **Done 2026-10-08 (owner: "do 2"): downloads first, then the GPU.**
  modal_serve.py `lot`, a small CPU function, waits for the downloads and
  only then calls the GPU. Same inputs, same outlines. Workflow 32, same 8
  lots, from cold (run 37710689178): **GPU seconds per warm lot 2.7, of which
  1.1 is still waiting** (collecting the downloaded lidar/NAIP), against
  12.3 and 11.0 before -- about a fifth of the GPU bill per lot. Wall time
  per warm lot 10-12 s, as before. A cold press took 29 s end to end (C99).
  **The first press after the deploy itself** (run 37709603931) was very
  slow: C99 gave up at the tool's 5 minutes and C88 took 284 s, then the
  rest ran normally. A new function plus Modal rebuilding the memory
  snapshot is the likely cause (not checked). If it recurs after later
  deploys, warming the GPU at the end of the deploy would hide it, for a
  few cents per deploy.

### H82. Aiming the refiner (S27) does not pay: photo edges change nothing (22 / 24), a doubt-gated wide reach is worse but less so than the plain wide one (20 / 42); the wide reach, isolated, is what took B28, 2026-10-07

Three seeds (7/8/9), free runner, `lawns: locked` (81, `05cs4ud`),
`refiner_trial: compare`: 37563074383, 37563158493, 37563241262. Workflow
24 against "decoder, edge refined + stage 3, span, lidar veto" of the same
runs (runs' medians 22.0 / 22.5 / 20.8).

| row (B) | better / worse / level | paired change [95%], all 81 | frozen 32 | untuned 49 | runs' medians |
|---|---|---|---|---|---|
| hard edges (photo edges in) | 22 / 24 / 35, p 0.88 | -0.1 [-0.2, +0.1] | 12 / 5, -0.2 [-1.0, -0.0], p 0.14 | 10 / 19, +0.1 [-0.2, +0.5], p 0.14 | 20.8 / 22.2 / 20.8 |
| wide gated (wide + edges + gate) | 20 / **42** / 19, **p 0.007** | **+0.5 [+0.0, +0.9]** | +0.7 [-0.3, +1.4] | +0.3 [+0.0, +0.9], p 0.04 | 22.7 / 22.6 / 22.5 |

(37582145163, 37582166398.)

- **S27's bar fails for both.** Hard edges is nothing: the refiner already
  reads the photo's colour, and handing it the edge strength adds no
  information it uses. Worst C99 130 -> 139, B28 28.5 -> 36; best B03
  72 -> 66.
- **The gate halves the wide reach's harm (+0.5 against H80's +0.9) but does
  not turn it into a gain.** It is the one variant that helps the parking
  lots -- B19 80 -> 71, B20 73 -> 71 -- and it costs C99 130 -> 146, C41
  17 -> 25, B32 33 -> 39, B28 28.5 -> 34.
- **The live refiner against its true twin, second extraction (37582187973):
  55 / 17, -1.5 [-1.9, -0.8]** -- H81 replicates exactly.
- **The wide reach drawn against the live refiner, seed 7 alone
  (37562487510, 37582123151):** 21 / 44, +0.8 [+0.1, +1.3], p 0.006, and
  **B28 28 -> 68**: the black chunk the owner saw in B28's mid-lawn is the
  extra reach's own doing. Pictures: that run's folder, "decoder, wide edge"
  drawn with navy/black against the live refiner.

**What this says (reading, not measured):** the refiner's gains are local
-- the half-metre band H53 found -- and every way tried of letting it act
further out (plain, gated, with edge hints) costs more on lawns it had right
than it wins on the misses the owner circled. Those misses are the decoder's,
2-6 m wide, and the next lever is upstream of the refiner. Nothing from
S25/S27 is released; `edge_reach` and `refiner_trial` stay in workflow 14,
off by default.

### H81. The live edge refiner, against its TRUE twin at 81 lots, still pays: 55 lots better, 18 worse -- but it is the refiner that turns B19 and B20's parking lots worse, 2026-10-07

Three seeds (7/8/9), free runner, `lawns: locked` (81, `05cs4ud`), `decoder:
fused + edge`: 37556372070, 37556456369, 37556539907 -- the first runs where
the plain decoder is THE PLAN's decoder without the refiner (taught under
trees, canopy input). Workflow 24 (37575972747): A = "the pretrained eye,
decoder + stage 3, span, lidar veto", B = "decoder, edge refined + ..." of
the same runs.

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 81 | **55 / 18 / 8** | 24.1 -> **22.0%** | **-1.5 [-1.9, -0.9]** | p < 0.001 |
| frozen 32 | 21 / 8 / 3 | 25.5 -> 24.5% | -1.5 [-2.1, -0.5] | p 0.02 |
| untuned 49 | 34 / 10 / 5 | 23.3 -> 21.9% | -1.5 [-1.9, -0.7] | p < 0.001 |

Runs' medians A 24.8 / 24.7 / 24.3, B 20.9 / 22.5 / 22.0.

- **H60 replicates, on more lots and against the right twin.** The owner's
  reading of the S25 pictures ("the bad behaviour is often more costly")
  was of the wide refiner against a mixed twin; the live refiner, alone,
  helps three lots for every one it hurts, by about the same amount H60
  measured at 55 lots (-1.7).
- **But the owner's B19 observation holds for the live refiner too:** its
  worst lots are B19 67.6 -> 79.6 and B20 57.1 -> 73.3 (both parking lots,
  as in H60), C19 40 -> 57, C88 53 -> 61, C29 372 -> 407. Its best: C41
  30.5 -> 16.8, C59 22 -> 15, B04 55 -> 46, C87 63 -> 56, C99 139 -> 130.
  Where the decoder has already called pavement lawn, the refiner extends
  the mistake along the pavement's edge rather than retreating from it.
- The run draws THE PLAN's row now; pictures in
  `runs/2026-10-06-2308-edt-scalemae-large-896px` (seed 7), navy/black the
  live refiner alone.

**Also from these runs -- see-through colour (S22) is not a gain.** It has
the lowest median of any row in every recent run (here 21.4 against 22.0),
and lot by lot it is nothing: 11 better / 14 worse / 56 level, p 0.69
(37576047303), with B22 68 -> 109 and B24 14 -> 26. The lower median is the
level lots shuffling, not a change. It stays off.

### H80. An edge refiner that reaches ~4.6 m instead of ~1 m (S25) measures WORSE on most lots -- not adopted, 2026-10-06

Three seeds (7/8/9), free runner, `decoder: fused + edge`, `lawns: all`,
`edge_reach: compare`: 37509209045, 37509342504, 37509477275. **81 maps,
the first locked set (fingerprint `05cs4ud`, with C99).** Read with
workflow 24 (37540760687) against A = "decoder, edge refined + stage 3,
span, lidar veto" of the same runs (runs' medians 22.0 / 22.5 / 20.8).

| row (B) | lots better / worse / level | paired change [95%], all 81 | frozen 32 | untuned 49 | runs' medians |
|---|---|---|---|---|---|
| wide edge + stage 3, span, veto | 13 / **49** / 19, **p < 0.001** | **+0.9 [+0.4, +1.4]** | +0.9 [+0.1, +1.6], p 0.02 | +0.9 [+0.4, +2.0], p < 0.001 (7 / 31) | 23.3 / 24.8 / 22.9 |

- **S25's bar fails on every part**, the wrong way: worse on almost four lots
  for every one it helps, and the interval is wholly above zero on the
  tuned and untuned lots alike. Every seed's median is worse (by 1.3, 2.3,
  2.1 points).
- **Worst:** C94 101 -> 116, B28 29 -> 41, C99 130 -> 140, C41 17 -> 26,
  C28 13.5 -> 21. **Best:** B19 80 -> 74, B20 73 -> 68 (the parking-lot
  lots), B02 44 -> 41. Small, well-drawn lots (C28, C41) are hurt most in
  relative terms: the extra reach moves edges that were right.
- **Reading (speculation, S25's own warning):** given more room, the refiner
  follows colour edges that are not the lawn's. Seeing the woodline from 4 m
  away is not the same as knowing it is THE edge, and 81 lots did not teach
  that. The owner's circled misses are real; this way of reaching them
  does not work. Untried: a wide reach trained only where the decoder is
  unsure, or a larger crop; neither is planned.
- `edge_reach` stays in workflow 14, default `normal`. Version 2 stays live.
- **C99, the map approved today, scores 130-140%** under both refiners: the
  detector draws well over twice its lawn. Worth a look at its pictures.

### Owner's reading of the S25 pictures, and what they actually showed (2026-10-07)

**The owner (B19, B28, C99, navy/black layers on, "detector: raw answer"):**
B19: the detector traced a large area of blacktop and concrete, and the
refiner pushed that trace further into the parking lot, while dialling in
edges that were already close. B28: two patches of lawn in mild shadow
missed and only crept towards by the refiner; a false trace on the roof
(lidar omitted on that lot) that the refiner removed most of, not all; and
a large black area that took a chunk out of the middle of a plain, treeless,
evenly dormant lawn "for seemingly no reason". C99: "horrific", the refiner
did not help; a low-contrast, leaf-off county photo. Overall: "a mix of good
and bad behaviour, but the bad behaviour is often more costly than the good
behaviour is helpful."

**What those pictures were, found the same day (my error in telling the
owner the layers were the refiner alone):**
- **The drawn row was the WIDE refiner** (S25's trial row, which H80 measured
  worse), not the live one. Every S25 run drew "decoder, wide edge + ...".
- **Navy/black compared it with "the pretrained eye, decoder", which since
  H78 was not THE PLAN's decoder minus the refiner:** it was neither taught
  under trees nor given the canopy as input. So the layers showed three
  changes at once: the wider refiner, teaching under trees, and the canopy
  input. B28's black chunk in mid-lawn could be any of the three.
- Ordinary runs before S25 drew TRIAL_ROW (S22's see-through colour), also not
  the live model's row.

**Fixed 2026-10-07:** in a `fused + edge` run the plain decoder is now THE
PLAN's decoder without the refiner (taught under trees, canopy input), so
the layers isolate the refiner; the wide row is drawn against the ordinary
refined row; and TRIAL_ROW is off the drawing list, so ordinary runs draw
THE PLAN's row. **Not yet measured:** whether the refiner, against its true
twin, still helps at 81 lots (H60 measured it at 55, against the untaught
decoder of the time). The owner's reading says it may not; three free runs
(the next run log rows) answer that.

### H79. Weighting training 3x toward the release's own corrected cells (S21) measures WORSE; the pond maps measure as nothing overall but carry B12, 2026-10-06

Three seeds (7/8/9), free runner, 80 lots, `corrections: on` + `not_lawn: on`:
37455590620, 37455705640, 37455821616. 21 of the 80 lots carry a
release-drawn outline to weight (S21's dump). Read with workflow 24
(37499176071, 37499196754) against A = "decoder, edge refined + stage 3,
span, lidar veto" of the same runs (pond maps in; runs' medians 20.9 /
21.2 / 21.4).

| row (B) | lots better / worse / level | paired change [95%], all 80 | frozen 32 | untuned 48 | runs' medians |
|---|---|---|---|---|---|
| corrections weighted + stage 3, span, veto | 15 / **34** / 31, **p 0.009** | **+0.3 [+0.1, +0.7]** | +0.1 [-0.1, +0.3], p 0.80 | **+0.7 [+0.3, +1.5], p 0.005** (8 / 25) | 20.9 / 24.3 / 22.0 |
| no pond maps + stage 3, span, veto | 33 / 27 / 20, p 0.52 | -0.2 [-0.6, +0.1] | -0.1 [-0.5, +0.2], p 1.0 | -0.3 [-0.8, +0.5], p 0.52 | 20.7 / 22.0 / 21.0 |

- **S21 fails, clearly.** Worse on more than twice as many lots as it helps,
  and the interval is wholly above zero on all 80 and on the untuned 48.
  Worst: B28 27.6 -> 51.7, C89 56 -> 69, B03 42 -> 52, C94 101 -> 111.
  Best: C80 66 -> 60, B20 68 -> 64. One seed (8) moved its median 3 points,
  so the weight also makes training less stable. As S21's own warning said
  (and H57 before it), extra weight on the corrected band did not help. Shelved,
  `corrections` off by default. The dump of `<id>-detected.png` stays; it
  costs nothing and a different use of it is not ruled out by this.
- **The ponds: nothing measurable overall** (sign reversed: B is WITHOUT them,
  so -0.2 means removing them is, if anything, marginally better, well
  inside noise). **B12, the pond, is the one lot they clearly carry:** 15.0%
  with them, 21.3% without. Also worse without: C88 52 -> 68, C33 45 -> 60.
  Better without: C29 563 -> 490, B04 64 -> 46, C80 66 -> 49. **Correction, the same
  day:** the live release (version 2, run 37421464211) was trained WITHOUT
  them -- its log has `NOT_LAWN` empty and `"examples": 0`. With no measured
  difference either way, it stays as it is; the cheaper side is without.
- **No change to the release.** Neither row is a measured win, so version 2
  stays live and nothing was retrained.

### H78. Taught under trees AND given the canopy as an input, then put through stage 3 and the veto, the decoder beats THE PLAN lot by lot on two extractions -- adopted, 2026-10-06

Two sets of three seeds (7/8/9), free runner, `fused + edge + trees`, 80 lots.
Each is its own extraction:
- **C** (canopy input only): 37393325860, 37393416186, 37393510265.
- **D** (canopy input, plus `distrust_lidar: on`): 37397123260,
  37397209793, 37397296473.

All are read with workflow 24 against THE PLAN's row of the same runs.

**A labelling bug changed the rows, not the training.** The arm was named
"taught under trees, canopy input", and PREDICTIONS_DIRS splits on commas.
So it was scored as "decoder, canopy input", like any decoder, with stage 3
and the veto over it, and never alone + veto as intended. That turned out
to be the row that matters. The label has no comma now.

| row (B) | set | lots better / worse / level | paired change [95%], all 80 | untuned 48 | worst lot |
|---|---|---|---|---|---|
| **canopy input + stage 3, span, veto** | C | 38 / 21 / 21, **p 0.036** | -0.3 [-1.0, +0.0] | **-1.1 [-2.6, -0.3], p 0.002** | B17 31→39, C82 18→27 |
| **canopy input + stage 3, span, veto** | D | 35 / 18 / 27, **p 0.027** | -0.2 [-0.8, +0.0] | **-0.9 [-2.2, -0.2], p 0.001** | B17 31→39 |
| canopy input + … + see-through colour | C | 40 / 24 / 16, p 0.06 | -0.5 [-1.1, -0.0] | -1.1 [-2.7, -0.3] | **B22 65→184** |
| canopy input, alone | C | 36 / 30 / 14, p 0.54 | -0.4 [-0.8, +0.3] | -0.5 [-1.7, -0.1] | B22 65→247 |
| taught (no canopy input) + veto, alone | C | 36 / 24 / 20 | -0.4 [-1.2, +0.1] | -0.9 [-1.9, -0.1], p 0.03 | B22 65→256 |

The tuned 32 sit at +0.1 to +0.3 in every row.

- **Stage 3 tames the tail.** Alone, every taught decoder blows B22 up to
  ~250%. Under stage 3 and the veto, B22 goes 65 → 70 and C29 improves.
  The decoder's gain in the open and at canopy edges survives. The
  see-through colour variant re-opens B22 (184%), so it is NOT the one.
- **By S24's rule.** "Beats THE PLAN lot by lot with the interval below
  zero": on all 80 the upper bound is +0.0, touching zero. On the 48
  untuned lots it is clearly below, twice. The sign test is under 0.05
  twice, on independent extractions. Read as measurably better, with that
  caveat recorded. The tuned 32 favour the rules they were tuned on, as
  every time.
- **`distrust_lidar` measures as nothing** (C vs D, same row: -0.3 against
  -0.2). With H76's photo check (3 of the 10 hidden lots have lidar that is
  right), it is shelved, off by default.
- **Owner's earlier review (H75's seed 8, the no-canopy-input arm):**
  "very promising but needs work"; "much better on blurry Mapbox photos".
  The adopted row is stage 3 over a better decoder, so its pictures should
  look like THE PLAN's with fewer misses at canopy edges, not like seed 8's.
  To be confirmed in the release's own pictures.

### H77. The taught decoder's lead on the untuned lots replicates (-1.2 [-1.7, -0.2], p 0.02); using it only under the canopy changes almost nothing lot by lot, and keeps both blow-ups -- they are under the canopy, 2026-10-06

Runs 37382857695, 37382974993 and 37383081694: free runner, seeds 7/8/9,
`decoder: fused + edge + trees`, the same code as H75 plus the combined row.
These are a fresh extraction, so the taught arm here is a REPLICATE of
H75's. Workflow 24, against THE PLAN's row of the same runs (medians 23.6,
22.5, 24.1):

| B row | lots better / worse / level | paired change [95%] | untuned 48 |
|---|---|---|---|
| taught under trees (alone) | 38 / 27 / 15 | -0.4 [-1.3, +0.1] | **-1.2 [-1.7, -0.2], p 0.024** |
| THE PLAN, taught under the canopy | 18 / 19 / **43** | +0.0 [-0.1, +0.0] | -0.0 [-0.2, +0.1] |

- **The untuned-lots lead is now seen twice:** H75 -1.1 [-2.3, +0.1] p
  0.08, and here -1.2 [-1.7, -0.2] p 0.02. On the 32 the rules were tuned on
  it is +0.3 both times. A rule tuned on a set wins on that set, so the 48
  are the fairer test. The PLAN-vs-taught gap overall is still inside the
  interval (-0.4 [-1.3, +0.1]).
- **Under the canopy only: 43 of 80 lots are level**, since most lots
  have little canopy. The same blow-ups survive in it: B22 65 → 254, C88
  61 → 82, C29, B24, B27. **So the taught decoder's big misses are UNDER the
  tree model's canopy, not in the open.** The open-ground loss (+2.9 seen,
  H75) is real but spread thin; the tail is in the canopy. This is the
  canopy-input question H76's runs are testing.
- Medians of the combined row (21.6, 20.4, 23.2) sit below THE PLAN's on
  every seed. With 43 lots tied, the paired test cannot see it. Lot by lot,
  this is not a win.

### H76. The lidar finds the ground almost everywhere; on 10 of 72 lots it shows something 1–25 m tall standing on lawn the photo shows open, and those include most of the owner's worst taught-decoder lots, 2026-10-06

Workflow 23 run 37394492053, lawns `all`, 2 m cells,
tools/lidar_ground_check.py. On ground the tracer called VISIBLE lawn
(lidar_frame.py `classes == 0`), "highest return minus the ground surface"
should be ~0.

- **The owner's question** ("times when the lidar isn't zero-ing at ground")
  **is answered no, as asked.** On 70 of 72 lots, 90–100% of visible-lawn
  cells have a ground return of their own; the other two are 82% (C88) and
  ~90% (B22). On 62 lots the lawn's median height is 0.05–0.19 m. Nothing
  reads below the ground anywhere (0% under -0.3 m).
- **But on 10 lots the lidar stands TALL over visible lawn:**
  - B28 +25.3 m: its trees are gone, H40.
  - B31 +10.5
  - B06 +7.7: Kent 8,626, "the roof" lot.
  - C88 +7.2
  - C57 +6.5
  - B02 +2.9
  - C42 +2.8
  - C87 +1.7
  - C94 +1.0
  - C43 +1.0

  The ground is found, so this is not the ground surface. **The lidar shows
  a different scene from the photo**: trees since felled, buildings since
  built or changed, or a survey misregistered against the photo. This
  check cannot tell those apart.
- **It lines up with the owner's review of the taught decoder (seed 8,
  H75):** C88 (ate into woods), C94 (lawn on a roof), C87 (missed lawn
  under leaf-off canopy) and B28 are all flagged. B22, his other big miss,
  is not (+0.12 m).
- A softer flag (25–39% of the lawn over 1 m, median ~0.1 m) on 11 more lots
  is most likely branches overhanging the lawn's edge in 2 m cells. It is
  not acted on.
- **CHECKED AGAINST DATED PHOTOS (owner, 2026-10-06: "confirm, to rule out
  issues with the data").** The Esri World Imagery Wayback archive gives each
  release's source date per point. For each flagged lot, the dated photo
  nearest the middle of its lidar flight sits beside today's Mapbox photo
  and the lidar (page: https://claude.ai/artifact/Wr6pM3jh2oMVPtT3kPcGPR).
  The photos are within months of the flight, except C43's, which is three
  years earlier. **None of it is bad data:**
  - **6 are trees removed since the flight. The lidar is stale.**
    - B28: forest in Nov 2016, a subdivision now.
    - B31: Feb 2020 yard full of large bare trees, open lawn now.
    - C88: wooded in Apr 2011.
    - C57: dense canopy in Jul 2016.
    - B02: trees in Nov 2017.
    - C42: tree-lined in Nov 2020, cleared now, probably by a hurricane.
  - **3 are the lidar RIGHT: bare deciduous trees standing over lawn**
    traced through their branches in a leaf-off Mapbox photo: B06, C87,
    C94. All three were flown leaf-off. The lidar is correct information
    exactly where the detector needs it. C87 is the lot the taught decoder
    missed.
  - **1 (C43) is a canopy edge overlapping the traced lawn, mild.**
  - **So "distrust lidar over visible lawn" hides real trees on 3 of 10.**
    The `distrust_lidar` runs (37397123260, 37397209793, 37397296473)
    treat all 10 alike and read as a mixed test. A cleaner rule needs a way
    to tell stale from bare: e.g. the lidar's year against the photo's, or
    whether the photo shows trunks and branch texture where the lidar
    stands tall.
  - **Side finding, a BUG, fixed 2026-10-06:** USGS also lists a 2022 QL1
    survey over C88 (RI_Statewide_1_D22), and our reader took the 2011
    cloud. tools/lidar-cover.js `flownYear` read only four-digit years.
    Newer 3DEP projects end in a letter and the work package's fiscal year
    (`_D22`, `_B23`), so they read as UNDATED and sorted last. **7 of 80
    frames read an older cloud:**
    - B22, B23, B24, C31: VA 2011 → 2022. B22 is the taught decoder's
      other big miss (H75).
    - C88: RI 2011 → 2022.
    - C84: DE 2013 → 2023.
    - C82: OH 2019 → 2021.

    The suffix is now read as 20NN. Every run from here reads the newer
    clouds, all arms alike, so within-run comparisons stay fair. Runs
    before this are not comparable lot by lot on those seven.
- **Built: `distrust_lidar: on`** (workflow 14). The taught decoders TRAIN
  with the lidar zeroed on lots over 0.5 m. The check needs the tracing, so
  held-out lots are answered with their lidar as it is. THE PLAN's
  decoders are untouched. Not run yet.

### H75. A decoder taught under trees ties THE PLAN overall, 80 lots × 3 seeds: much better under the trees, worse in the open, with two lots blown up; the lidar by return adds nothing measurable, 2026-10-05

S24 as written. Workflow 14, `decoder: fused + edge + trees`, lawns `all` (80,
place folds), canopy on lawn, **gpu: modal** (owner: "run it on modal now"),
seeds 7, 8 and 9: runs **37360685855, 37361011304, 37361320989**. Every arm is
in every run, over one extraction. (A GitHub Actions outage dropped the scoring
job twice on seeds 7 and 8; re-run with the Modal output kept. A first CPU run,
37342022957, died on a bug in the new test, not the method.)

| row | seed 7 | seed 8 | seed 9 |
|---|---|---|---|
| THE PLAN (edge refined + stage 3, span, veto) | 22.5% | 22.6% | 24.7% |
| … seen / inferred | 19.2 / 16.7 | 18.0 / 19.6 | 19.1 / 29.3 |
| **taught under trees** (alone) | **20.9%** | **20.8%** | **22.8%** |
| … seen / inferred | 21.6 / 14.7 | 20.7 / 14.7 | 22.7 / 16.7 |
| taught under trees + returns (alone) | 22.6% | 21.3% | 22.8% |
| … seen / inferred | 22.5 / 18.9 | 21.9 / 14.0 | 22.4 / 13.1 |
| beat SAM on (of 55), PLAN → taught → +returns | 38 → 40 → 37 | 35 → 35 → 37 | 33 → 34 → 35 |

**Lot by lot, pooled over the seeds (workflow 24, runs 37382273833 and
37382313158).** Each taught arm is compared with THE PLAN's row.

| | lots better / worse / level | paired median change [95%] | p |
|---|---|---|---|
| taught, all 80 | 37 / 27 / 16 | **-0.1 [-1.5, +0.2]** | 0.26 |
| … frozen 32 (tuned on) | 11 / 13 / 8 | +0.3 [-0.9, +1.4] | 0.84 |
| … 48 approved since (untuned) | 26 / 14 / 8 | -1.1 [-2.3, +0.1] | 0.08 |
| taught + returns, all 80 | 38 / 27 / 15 | -0.5 [-1.1, +0.3] | 0.22 |

- **By S24's rule this is EQUIVALENT: the interval spans zero.** It is not
  a win. The lead is on the lots the rules were never tuned on (-1.1, p
  0.08): a lead only.
- **The two error types trade.** Under the trees (inferred) the taught
  decoder is far better on every seed: 14.7–16.7 against THE PLAN's
  16.7–29.3. In the open (seen) it is worse on every seed: 20.7–22.7
  against 18.0–19.2, about +2.9. Stage 3 plus the edge refiner keeps the
  open edge cleaner. The taught decoder knows more about what is under a
  tree.
- **Tails.** Most worsened: C29 537 → 1236% (a tiny lawn, so the percentage
  explodes), **B22 63 → 272%**, C88 57 → 90%, B24 15 → 30%, B27 10 → 22%.
  Most improved: C80 68 → 49, C31 52 → 37, C23 28 → 14, C89 64 → 53, B03
  54 → 43. B22 and C88 look like the H27 failure, lawn claimed into
  canopy that is not lawn. That is not checked against the pictures yet.
- **The lidar by return measures as nothing over the taught decoder**
  (-0.5 against -0.1, overlapping). By S24's rule, equal means the one
  without returns: bookmarked, not shipped.
- **Not shipped.** S24 said "equivalent → ship the cheaper". I wrote the
  taught decoder as cheaper because it needs no stage 3. Stage 3 is cheap
  arithmetic, so that premise is weak. The tails (B22, C88) are an outline
  difference the median hides. Owner: "the lawn outline is the only thing
  that matters". So: no ship on a median tie with a worse tail.
- **What the trade suggests (NOT measured):** use the taught decoder only
  under the canopy, and THE PLAN's answer everywhere else. That puts each
  where it measured better. It needs no new training: one more scorer row
  over the masks these runs already make. **Built (2026-10-05):** THE
  PLAN's row with the taught decoder's answer on every tree-model canopy
  cell, "…, taught under the canopy". `decoder: fused + edge + trees` now
  trains only the taught arm. The returns arm is bookmarked under
  `fused + edge + trees + returns`. Runs on the free runner, seeds 7/8/9.
- **OWNER'S REVIEW OF SEED 8's PICTURES (2026-10-06).** The drawn row
  there was "taught under trees + returns", the first in TRIAL_ROWS at the
  time. His words, condensed:
  - "Very promising but needs work."
  - It aced properties never got right before, and made big errors on
    some that had been good.
  - It is more willing to trace bare ground and pavement. That made it
    less afraid of edges: sometimes perfect, sometimes leaking into
    parking lots.
  - It is not afraid of tree shadows, finds difficult lawn at canopy edges,
    and finds grass under large canopies where stage 3 was bad.
  - **Much better on blurry Mapbox photos "by a LOT".**
  - C88: it ate into bare winter dirt (forgivable) and into genuine woods.
  - B22: it ate into dense leaf-on canopy.
  - C94: it traced lawn on a roof.
  - C87: it missed lawn visible through leaf-off canopy.
  - It never avoided an evergreen.
  - "When it messed up, it often did it in a very big way."
- **Two causes the review points at, reasoned not measured:**
  1. **No canopy input.** `FUSE_CANOPY=0` in canopy-on-lawn mode (kept
     out since H48). Taught "lawn" on leaf-coloured pixels without being
     told where the canopy is, a decoder can only learn "not-grass can be
     lawn" everywhere: the pavement and bare-ground leaks. H48's reason
     (every canopy cell it saw was not lawn) no longer holds once canopy
     over lawn is graded lawn.
  2. **No veto on the taught row.** It was scored alone with no lidar
     roof/void veto, which THE PLAN's row always has: C94's roof.
- **Built (2026-10-06):** a third taught arm, "taught under trees, canopy
  input" (`FUSE_CANOPY=1`). Every taught row is now also scored "+ lidar
  veto" (no stage 3). Each taught arm also gets a "… under the canopy"
  combination with THE PLAN. The canopy-input + veto row is drawn first.

### H74. Trees from the lidar alone, first pass: on the owner's inferred lawn (grass under a tree) lidar trees cover 52%, the tree model 73%, either 85%; lidar finds trees the model missed on some maps and almost none on others, 2026-10-05

Workflow 30 run 37313636940 (tools/lidar_canopy.py at its defaults: a 1 m
cell is a tree at ≥ 2 m, with a 3x3 multi-return share ≥ 0.15 or classed
vegetation or a first-to-last spread ≥ 1 m, and not classed building; no
opening). **75 of 80 approved maps** have lidar. Viewer: /lidar-trees.html.

**A HINT, NOT A SCORE.** The only truth is the inferred marks. They are leaf-on
canopy only, stop short of the canopy's edges, and cover trees standing in
the photo, while the lidar is a median 6 years older (H72). On the 56 maps
with inferred lawn AND a tree-model map, the inferred lawn lies under:

| | share of inferred lawn |
|---|---|
| lidar trees | 52% |
| tree model (restor/tcd, workflow 28) | 73% |
| either | 85% |

- **Not uniform.** Maps where lidar covers far MORE inferred lawn than the
  model: B06 96 v 0, C76 99 v 27, C35 60 v 13, C27 62 v 0, C86 34 v 0, B15
  70 v 40, B30 54 v 19, C37 100 v 74, C87 100 v 71. Maps where it covers
  almost NONE of what the model does: B16 2 v 69, C69 1 v 56, C71 3 v 51,
  C66 13 v 81, C26 0 v 49, C28 15 v 89, C24 15 v 91, B22 13 v 83, C36 0 v 55.
  On C33 and C36 (GA_Central_5_2018) the lidar finds no tree on the lawn at
  all, where the model has 56 and 231 m².
- **"Either 85%" is the useful number if this works as an addition rather
  than a replacement.** Each method finds inferred lawn the other misses.
- **Unexplained.** Candidate reasons, NOT measured: trees younger than the
  lidar; a sparse or old cloud whose pulses rarely split (2011 VA, ND); the
  frame and the lidar box disagreeing; the thresholds. The pictures decide.
- Lidar on-lawn area exceeds the model's on many maps (B28 1323 v 0 m², C88
  2226 v 803, C42 1484 v 319). That is either trees the model missed or
  things the lidar wrongly calls trees. Unknown until looked at.
- **OWNER'S REVIEW OF THE PICTURES (2026-10-05): discouraging.**
  - B28: the whole frame is dense, and there is not one tree in it.
  - Many roofs are marked dense, especially their edges.
  - **Alignment is the biggest issue**: "if we can't get imagery to line up
    with lidar, then lidar as a whole can't be used."
  - Trunks are often dense (harmless).
  - The lidar trees miss in both directions. They miss trees or part of a
    canopy, and occasionally mark bare ground.
  - Some whole deciduous canopies are marked dense.
- **What each points at.** These are reasoned, not measured:
  - ~~B28 is a GROUND failure.~~ Wrong, written without reading H40/H48:
    **B28's trees are gone**. NAIP-CHM said so (H40), and the owner confirmed
    it on the Mapbox photo in September. The 2016 lidar still has them. It
    is stale lidar, the same lot the fused inputs got 10 points worse on
    (H48).
  - Roof EDGES: a pulse that falls half on the eave and half on the ground
    splits into two returns metres apart. That is the tree signature
    exactly. The 3x3 smoothing in lidar_canopy.py then spread it into the
    roof. A sloped roof alone does not split pulses: returns closer than
    ~2–3 m merge into one.
  - Dense broadleaf: the 0.8 cut is loose. The in-leaf median is 94%
    reaching the ground and the evergreen median 64%. Some flights are
    mixed season.
  - Alignment has two parts. One is a constant offset per map, which can
    be measured and corrected. The other is relief displacement (H43's
    note): an aerial photo shows a tall crown leaned metres off where it
    stands, by an amount and in a direction that vary across the photo.
    No single shift fixes that. And the lawn hidden in the PHOTO is under
    the leaned crown, not under the lidar's.
- **Owner, on aligning by the canopy (2026-10-05):** it would not work.
  "The shapes of the lidar drawn trees are different from the shapes the
  tree model draws, often significantly so." Not run.
- **This repeats H38** (2026-09-25: "the lidar's canopy is not a replacement
  for the tree model, as built"). It should have been read first. What has
  held up is lidar as an ATTRIBUTE of a crown the photo model found (H73:
  76–77% evergreen vs broadleaf). There, a few metres of offset only blurs
  a per-crown average.


### H73. Lidar by return, per labelled crown: evergreen vs broadleaf in leaf, 290 crowns: colour 61%, lidar 76% held out by map, 77% on leaf-off flights alone (share of pulses reaching the ground 75% by itself), 2026-10-05

Workflow 29 run 37256336621 (tools/tree_lidar.py, then tools/tree-labels.js
with LIDAR on). The same 46 maps and 205 crowns as H71. **Lidar lies under
194 of the 205 crowns, on 42 maps**, from projects flown 2011 to 2020. Per
1 m cell it keeps which return of its pulse each point was. Each crown gets
the median over its cells.

| question | crowns | best single feature (held out) | all together (logistic, held out) |
|---|---|---|---|
| 2. evergreen vs broadleaf, colour only | 36 v 103 | exg / darkShare 61% | 54% |
| 3. same, lidar only | 35 v 92 | l_last_h 65% (AUC 0.65, higher = evergreen) | 64% |
| 4. same, lidar + colour | 35 v 92 | l_last_h 65% | 65% |
| 6. evergreen vs broadleaf, lidar only, leaf-off flights | 29 v 66 | l_penetration 69% | 71% |
| 5. not a tree vs tree, lidar only | 5 v 184 | l_multi 69% | 73% |

- **The direction is what the physics predicts.** In evergreens the last
  return sits higher (l_last_h, AUC 0.65), fewer pulses reach the ground
  (l_penetration 0.35), and fewer pulses split (l_multi 0.36). Total
  height (l_height 0.49) and first-return height (l_first_h 0.51) say
  nothing, as they should not.
- **But 64% is weak, and this run mixes flight seasons.** A broadleaf in a
  summer flight stops MORE last returns than in winter, so the gap between it
  and an evergreen should narrow. ~~"Cannot work by construction"~~: that was
  written here first and is wrong as stated. Pulses do get through gaps in a
  leaf-on canopy; that is how ground models are made under summer forest.
  How much of the gap survives is unmeasured: none of our crowns has leaf-on
  lidar (below). H72 says roughly half of counties have leaf-off lidar. The
  split by flight season is q6, below.
- **Leaf-off flights only (q6, run 37257508411): 71%** held out by map,
  from 29 evergreen and 66 broadleaf crowns on 23 maps. The best single
  features are l_penetration at 69% (AUC 0.31) and l_last_h at 65% (AUC
  0.71). Of the 194 crowns under lidar, the flight was **leaf-off for 153,
  mixed for 41, and leaf-on for none**. So "summer lidar is what drags it
  down" could not be tested here: there is no summer lidar among our maps.
  Mixed flights are what was left out. 64 → 71% on a third fewer crowns and
  23 maps is within what one map can move (H7). **It is a direction, not
  a result.** More labelled evergreens would settle it: there are 29.
- **WITH MORE LABELS THE LEAF-OFF GAIN WENT AWAY (run 37299473566, 61 maps,
  290 crowns, 58 evergreens).** Leaf-off lidar alone: **71% → 65%** (34 v 80,
  31 maps). All seasons, lidar alone: 64 → 65%. The 71% was what one batch
  of maps gave, as H7 warns. Meanwhile **colour got better**: evergreen vs
  broadleaf on colour alone went from 54% to 61%, with edge at AUC 0.75 and
  68% alone. Colour plus lidar is 68%. Bare vs in leaf FELL from 91% to 86%
  (99 v 188, 60 maps). Read every number in this entry as ±5 at least.
  Lidar season among the crowns: off 201, mixed 66, on 4.
- **The penetration and multi-return numbers in all of H73 so far are
  saturated.** Each crown took the MEDIAN of its 1 m cells. A share per
  cell is mostly exactly 0 or 1, so the median "share of last returns
  reaching the ground" was 100% for evergreens and broadleaf alike. That is
  why the second-look list came back empty. The shares are now averaged
  over the cells (tools/tree-labels.js `SHARE_FEATURES`). Heights still use
  the median.
- **AVERAGED (run 37302462833, same 290 crowns, the current reading):**
  lidar alone, evergreen vs broadleaf in leaf, **76%** held out by map (57 v
  112, 43 maps; was 65%). Lidar plus colour 75%. **Leaf-off flights only 77%**
  (34 v 80, 31 maps). The share of last returns reaching the ground ALONE is
  **75%** there (AUC 0.22, i.e. 0.78 for "evergreen = fewer reach the
  ground"). In leaf-off lidar, the median evergreen crown sends 64% of its
  last returns to the ground and the median in-leaf crown 94%. The owner
  said pulses get through gaps in an evergreen too, and they do. Multi-
  return share is 65% alone. Not a tree, with 3 crowns: 49%, meaningless.
  Second-look list: 15 crowns on B27, B31, C22, C25, C32, C34, C80, C86, C94
  (11 labelled in leaf that look evergreen, 4 the reverse). **Every H73
  number above this bullet is superseded by it.** Still ±5: H7.
- **OWNER'S VERDICT on the second-look list (2026-10-05):** he looked at
  every flagged crown. Each one was "very likely an evergreen and/or the
  foliage was so dense and low that there's no way that grass would be
  growing under it". He left the labels as they were. Some evergreens were
  clustered tightly with broadleaf trees in leaf, and he could not trace
  their footprints. He considers it **settled for the purpose that matters**:
  leaf-off lidar marks "evergreen, or anything grass would not grow under".
  This is an owner judgement from looking, not a held-out number. The
  measured part is the 75–77% above, against labels that are noisiest in
  exactly that direction. The three "not a tree" crowns were fixed: two
  were mistakes, and one really is not a tree.
- **Next, on the owner's direction (2026-10-05): lidar instead of the tree
  model.** Workflow 30 (tools/lidar_canopy.py → /lidar-trees.html) calls a
  1 m cell a tree when it is ≥ 2 m tall, the pulses split there or the
  survey classed it vegetation, and it is not a building. That is unlike
  stage 4's height-only layer, which could not tell a roof from a tree.
  Judged by eye only. The one truth to hand is the inferred marks, which
  cover leaf-on canopy only and stop short of canopy edges.
- **After the owner's not-a-tree fixes (run 37313702985):** lidar alone
  77%, leaf-off only 74% (35 v 80), penetration alone 76%. Colour alone 62%.
  Bare vs in leaf on colour 86% (100 v 189, 60 maps; best single feature
  "not green share" 85%). One not-a-tree crown remains, too few to read.
- **The labels are known to be noisy (owner, 2026-10-05).** Some
  evergreens may be labelled in leaf, and probably not the reverse. "Not a
  tree" was used for trees over pavement. Every number in H71 and H73 is
  against those labels. Workflow 29 now prints LABELS WORTH A SECOND LOOK
  (in-leaf labels whose leaf-off lidar stops pulses like an evergreen's,
  and the reverse) and every "not a tree" crown with its place. The
  numbers should be re-read after those are checked.
- **Owner's framing, for weighting this work (2026-10-05).** These are not
  findings. The tree model misses many trees, especially narrow ones, and
  does not mark non-trees. Whether a crown in the PHOTO is bare must come
  from colour, since Mapbox gives no date (q1, 91%). Lidar's evergreen vs
  deciduous is a bonus path, separate from leaf-on vs leaf-off and from
  tree-or-not.
- **Not a tree: 5 examples.** AUCs from 5 crowns are noise. Do not read
  73% as a finding.
- Adding colour to lidar gives nothing (64 → 65%).
- The colour results repeat H71 exactly (same labels): bare vs in leaf 91%.

### H72. Lidar under the county photos: 106 of the 111 counties we could place have 3DEP lidar; the newest is leaf-off in 50, mixed in 31, leaf-on in 25, and six years older than the county photo at the median, 2026-10-05

Workflow 8, county mode `lidar`, run 37256816474 (tools/county-imagery.js
`countyLidar`, USGS 3DEP index layer 8 via tools/lidar-season.js). One point
per county where the catalogue found a county photo; the newest lidar
collection over that point.

- **176 counties** have a county photo. **111** could be placed: a sweep
  point, or the middle of a photo service filed under the county. **65 could
  not**: they were found by name search, which stores no point, and their
  services are filed under another key. They are not counted either way.
- **106 of 111 (95%) have lidar**; 54 have more than one collection.
- Newest collection's season: **leaf-off 50, mixed 31, leaf-on 25**. The
  season is judged by the rule "nine days in ten between 1 Nov and 10 May".
  That is a rule of thumb for the temperate US, not something the index says.
- Newest lidar by year: 2012 1, 2016 4, 2017 16, 2018 5, 2019 14, 2020 22,
  2021 7, 2022 14, 2023 14, 2024 4, 2025 5.
- **Years from that lidar to the newest county photo: median 6.** The photo
  is newer by 5+ years in 69 counties, and the lidar is newer in none. So a
  tree or building seen in lidar may not be in the photo, or the reverse. The
  lidar is a separate, older survey, not on the photo's schedule.

The first run of this mode (37256641186) said 70 of 176 (40%). That was a
bug: name-searched counties had no point, so USGS was asked about (0, 0).
**Do not quote 40%.**

What this means for trees: for about half the counties, the lidar was flown
leaf-off. There, last returns stopping inside a crown can mean evergreen
(H73). For the other half, a broadleaf in leaf stops more of them too, so
the test should be weaker there. It was first written that it "cannot
work". That overstates it: pulses do pass through gaps in leaves (owner,
2026-10-05). Unmeasured either way.

### H71. The owner's tree labels, first reading: colour tells a bare crown from one in leaf (91% held out by map); colour and texture do NOT tell an evergreen from a broadleaf in leaf (54-61%, about chance), 2026-10-05

Workflow 29 run 37255000075 (tools/tree-labels.js) over the first labelling
session on /trees.html: **46 maps, 205 painted crowns of 2 m² or more** (61
bare, 36 evergreen, 103 broadleaf in leaf, a few "not a tree"). One person's
labels, one evening, on workflow 28's canopy. A "crown" is a connected run of
one label inside one canopy patch. Every crown score is HELD OUT BY MAP (a
cut or classifier chosen on the other maps, scored on this one).

**Per pixel, stage 3's existing colour rule (bareCanopy) against the
labels:** labelled bare 82% called bare; in leaf 5%; evergreen 9%; not a
tree 71%. **Caveat:** pixel totals are dominated by a few maps whose woods
patch fills the frame (B09 29,600 m², B12 13,600, B11 7,300), so read the
crowns for the general picture. (Correction, owner 2026-10-05: the saved outlines on
the earlier maps were not inverted, as the first reading's note said, but
very large -- woods running well past the property line, correctly marking
trees, though not only trees over lawn. The second reading used today's
outlines either way.)

**1. Bare vs in leaf (option #1), 61 vs 139 crowns on 45 maps:** excess
green alone 85% balanced accuracy held out (AUC 0.88 as "less green =
bare"); share of not-green pixels 84%; red share 82%; the colour rule's own
share 83%; brightness 73%; grey/brown share 71%; edge density and texture
near useless (47%, 61%). **All features together (logistic regression):
91%.** So the owner's idea holds on these labels: a bare crown is
measurably less green, redder and brighter. The "web of branch lines" as I
measured it (luminance edges) does NOT separate them -- the colour does.

**2. Evergreen vs broadleaf in leaf (option #4), 36 vs 103 crowns on 36
maps:** no single feature beats 61% held out; all together 54%. **Colour and
texture from one photo cannot separate them here**, as expected: in a
leaf-on photo both are green foliage. The signals S22's discussion named for
this -- lidar ground returns under the crown (evergreens block leaf-off
lidar), and the crown's greenness in a photo from another season -- are not
in this reading yet; they are the next step.

**What this does NOT say.** Nothing about stage 3's score: H69's
see-through `colour` mode reads per cell and was measured on the lot's
lawn, not on crowns. These labels make a crown-level version possible (fit
on labels, scored held out by map). And one labeller, one evening.

### H70. What county photo services say about their season: 93 of 2,910 say leaf-off, 16 leaf-on, 2 both, 2,799 nothing; 370 give some date, 2026-10-04

Workflow 8 county mode "season", run 37232174494 (84 min), over every
catalogued service's own metadata (tools/county-imagery.js seasonOf).
**Leaf wording is rare (4%) but clear where present** -- KyFromAbove's
phases ("leaf-off 3\"" in the very name), Loudoun ("annually obtains
leaf-off, aerial imagery in the spring"). **Dates are commoner (13%) and
noisy:** good ones ("March 27th 2025", Virginia's VBMP "Spring 2022", DC
"January 2026" snow imagery), but also what are surely metadata-edit dates
("Orthos2017Spring" -> 6/11/2024), year-start placeholders ("2023-01-01"),
and a vendor mosaic's whole span ("2018-01-01..2026-08-29"). Only 25
services expose per-frame acquisition dates in an image catalogue. So: a
leaf-off word is worth trusting; a month in spring or winter is a hint; a
January-1st date is nothing. Most services say nothing, so the photo itself
has to answer for the rest (the crown tests in S22's discussion).

### H69. 80 lawns, pond examples on, one seed: THE PLAN's row 21.2% (was 24.0% at 55); see-through `colour` 20.6% and better on the lots that look leaf-off; the `evergreen` rule FAILS -- it doubles the error under the trees on leaf-off lots, 2026-10-04

Run 37195418220 (the owner's run; its first launch, 37186132376, died at the
see-through table on a bug of mine -- a local name shadowing an import -- after
training, so it left no results). `lawns: all` = **80 approved lots** (all 80
on the console's card), `not_lawn: on` (the approved pond-only maps as
examples), fused + edge, `canopy: on lawn`, seed 7, CPU, extraction 69 min
on the first launch (cache miss: new lots), training + scoring 1 h 57 min.
Every lot now carries its map number (#N, as on the console).

**Headline, THE PLAN's row (decoder, edge refined + stage 3, span, lidar
veto): 21.2%** over 80 lots; better than SAM on 39 of the 55 where SAM's
answer is stored. Wrong ground: 43% within 0.5 m of the true edge, 60%
within 1 m; median best shift 0.00, 0.00 m (no registration bug).

**Lot by lot against run 36601001355** (S20 A, the configuration the alpha
release uses; seed 7, 55 lots, no examples), workflow 24 run 37202209391,
on the 55 lots both scored: **29 better / 15 worse / 11 level, median 24.0%
-> 19.3%, paired change -0.8 [-1.5, +0.0], p 0.049.** Frozen 32: 17 / 8,
-0.7; approved since: 12 / 7, -0.8. Most improved B28 #10 81.0 -> 23.0, B20
#40 75.0 -> 39.2, B03 #29 56.7 -> 26.9, #62 92.6 -> 66.6, B24 #36 36.1 ->
15.2. Most worsened #61 321 -> 344 (an 870 sq ft lawn; any miss is a huge
percentage), B19 #42 46.5 -> 64.0, #72 25.7 -> 35.2, B04 #47 57.7 -> 66.2,
#66 10.8 -> 19.3. **NOT attributable:** two things changed at once (25 more
lots to learn from, and the pond examples on), on one seed each, and a seed
alone moves a lot about 2.6 points (H50). It says the larger corpus with
ponds is not worse and probably better; it does not say which did it. H57
measured examples (public outlines then) as clearly worse; these are the
owner's own pond traces, and a pond-only map adds no lawn-edge labels.

**See-through canopy (S22), at THE PLAN's cell over the refined decoder,
headline / seen / inferred:**

| mode | every lot (80) | looks leaf-off (22) | county photo (11) |
|---|---|---|---|
| off (as served) | 21.1 / 18.0 / 26.2 | 26.3 / 22.6 / 34.9 | 58.5 / 53.0 / 36.7 |
| colour | 20.5 / 19.2 / 32.5 | **22.6 / 22.1 / 37.2** | 49.7 / 52.7 / 33.4 |
| evergreen | 21.3 / 19.1 / 44.3 | 29.0 / 20.1 / **73.1** | 51.5 / 47.1 / 73.1 |
| trust | 24.0 / 17.7 / 43.4 | 22.6 / 21.3 / 41.9 | 50.1 / 52.5 / 67.4 |

As full rows (with the veto): colour 20.6%, evergreen 21.4%, THE PLAN 21.2%.
Colour against THE PLAN on the 55 shared with 36601001355 (workflow 24 run
37202215454): 28 better / 18 worse, p 0.18 -- weaker than THE PLAN's own row
against it, so colour's gain is concentrated, not general.

- **`colour` helps the headline where it should** (leaf-off 26.3 -> 22.6),
  but its INFERRED column gets worse on those lots (34.9 -> 37.2) and over
  all lots (26.2 -> 32.5). S22's bar needed both to fall: **NOT MET.** The
  gain is on visible ground under bare crowns being kept, the guessing
  under the remaining canopy got worse.
- **`evergreen` FAILS outright:** the inferred column on leaf-off lots goes
  34.9 -> 73.1. Calling every not-bare crown on a leaf-off photo an
  evergreen and clearing lawn under it removes far more traced lawn than it
  saves -- the colour rule's known blind spot (green grass through bare
  branches reads green) and the "too dark to see" cells, which this rule
  also counted as evergreen. The owner's premise (no grass under
  evergreens) is not tested by this: the rule did not find evergreens.
  Kept in code, NOT for serving; a better evergreen test is needed (needle
  texture, or leaf-on lidar returns), not this one.
- **Leaf-off is common on Mapbox too:** 22 of 80 lots read leaf-off, 13 of
  them Mapbox photos (B05 98%, B12 94%, B06 85%, B10 84%, B09 84%) -- the
  owner's point that leaf-off is a property of the photo, confirmed. Only 22
  lots: above S22's "about 15" floor, but one seed.
- **The owner's reading of the pictures (2026-10-04), lot by lot.** What
  a person saw, not a measurement; the lots are named for the next run to
  check. (The pictures are of the evergreen row, so stage 3 there is that
  mode's.)
  - **B12 (the big Kent pond): fixed by the pond examples** -- "it perfectly
    traced out the pond". The one lot H57's examples also helped; these are
    the owner's own pond traces.
  - **Lots by the "#N" this run printed; C numbers since (old #N above 47
    is C(N-32): all 32 benchmark lots had numbers up to #47).** #110 (now C78): stage 3 put lawn under a canopy NOT adjacent to any lawn -- a rule
    reaching where none should.
  - **#63 (now C31), grass islands in a parking lot:** narrow strips (1-5 m) interrupted
    by 6-10 m of canopy that overhangs both grass and asphalt. Of ~6 tree
    spots, one was filled whole; the rest got only ~1 m under the canopy edge
    (the reach), so span did not join the strips across the trees. Fills
    drifted ~0.5 m into the lot (1 m both sides on one tree). One large tree
    was missed largely because the detector stopped short of the canopy edge
    at a shadow, leaving span nothing to join from.
  - **#62 (now C30) and B04: the biggest misses of easy ground** -- plain green grass
    and grass in tree shade, not unique to this run.
  - **#66 (now C34): one large leaf-on tree in the middle of a lawn, marked wholly
    inferred.** The detector missed the big shadow on one side; stage 3 drew
    an "I" (1 m strips along two edges of the crown joined by a straight bar
    through the middle) instead of filling the crown. The owner suggests the
    single-tree case (a clump with lawn all round) should just be filled --
    which is what the bridge rule is for; the missed shadow presumably broke
    the ring of lawn round it. The straight bar looks like span's
    row/column walk.
  - **#98 (now C66), leaf-off:** a long row of evergreens was mostly avoided by the
    detector (some drift onto it) and correctly not filled by stage 3; every
    other (deciduous) tree was filled but one, with very dense branches and
    no grass showing through.
  - **The owner agrees with H69's reading of the colour rule:** stage 3
    cannot tell evergreens, leaf-on canopy and grass through bare branches
    apart from colour alone. **Built the same day (owner's request), as
    LABELS, not inputs:** in tinker mode "Trace evergreen" (crowns, saved as
    `corpus.evergreens`, apart from not-lawn) and "This photo is leaf-off /
    leaf-on" (`corpus.leaf_off`, for the photo the map is finished on).
    Nobody measuring a lawn is asked either; they exist to dial in the
    automatic guesses. From the next run, workflow 14's stage 3 output
    prints the marked lots against "looks leaf-off" and the traced crowns
    against the canopy the colour rule left standing (found / right). Not
    trained on; a few dozen marked lots first.
  - **Superseded the same evening by THE TREE EXPERIMENT (owner,
    2026-10-04).** Leaf-off is per tree (a fall Mapbox photo had one tree in
    leaf beside bare ones), and bare trees are hard to trace by eye where the
    tree model outlines canopy well. So: workflow 28 runs restor/tcd over every
    approved map's banked photo and keeps the canopy patches that touch the
    traced lawn (tools/tree-maps.js); /trees.html labels that canopy per pixel
    -- evergreen / in leaf / bare / not a tree -- with a brush confined to the
    canopy, tap-to-fill a patch, and point editing of the outlines. Labels in
    R2 `trees/labels/<name>.json` (class codes in a PNG's red channel), apart
    from the model's maps so a re-run cannot lose them. **Plan (owner chose
    #1 and #4):** (1) a per-crown colour test -- a bare crown shows a web of
    grey / brown / black branch lines, a crown in leaf (evergreen or not)
    mostly solid foliage; (4) a small classifier over crown features (colour,
    branch-line share, lidar ground-return share, shape, greenness in another
    season's photo) to separate an evergreen from a lone tree still in leaf.
    The labels score both. NOTHING MEASURED YET.
- **The pictures were drawn for the evergreen row** (TRIAL_ROW was set
  before the run). It differs from THE PLAN's only under canopy on the 22
  leaf-off lots, where it is the worst of the four. TRIAL_ROW is now the
  colour row for the next run.

### H68. A bug, not a measurement: every map saved on a county photo before 2026-10-04 banked that photo UNMOVED by the editor's line-up, while its outlines were drawn on the moved photo, 2026-10-04

What was wrong (found from the owner's report: card on the county photo,
outlines off it). county-picture.js storeMapPhoto passed `naipAlignOf(...)`,
which returns the column's JSON TEXT, where countyPicture wanted an object; it
read `.east` off a string, found nothing, and drew the frame as delivered.
Tested only by calling storeCountyImage directly with an object, which is why
the tests never saw it. Fixed in b399dde, with a test through the save path.

What it means for training. The banked county photo of such a map is offset
from its outlines by the line-up the editor had applied: H64 puts the typical
ground offset from Mapbox at a median 0.54 m, so roughly that, more where it
was nudged by hand. Mapbox-photo maps are unaffected. The line-up itself was
not saved at the time (corpus.county_align is new), so these photos cannot be
corrected from the row alone; re-banking one means re-measuring it (the
console's fetch-photo) or opening and saving it again on the county photo.
How many maps this covers was not counted. Before training on county photos,
count `provider = 'county' AND county_align IS NULL AND image_provider =
'county'` and treat those pairs as suspect.

Also fixed with it: reopening re-measured the line-up instead of restoring
it, so a hand nudge never survived a reopen; both are now kept with the map
(county_svc, county_align) and put back.

### H67. County photo catalogue, second sweep (vendor names, "too coarse" measured, statewide states by county name): 2,902 services; 2,904 of 3,427 sweep points (85%) have a photo, 2026-10-03

*Workflow 8 on claude/resume-previous-session-y94slo. Three runs from 20:46
UTC 2026-10-02 (bb948b3), continued from 03:05 UTC 2026-10-03 (b73897b),
continued again 09:05 UTC (e687d20) where the 340-min limit stopped them.
Rule changes since H66: "too coarse" is measured on the picture at 12 cm
(detail under 0.10 refused) instead of read from metadata or the name;
services named for a vendor (Nearmap, EagleView, Pictometry, Woolpert...)
searched for; counties in statewide-parcel states searched by name; from
b73897b, "most recent / latest / current" with no year ranks as newest.*

- **FINAL (all three runs done, 18:06 UTC 2026-10-03).** The last
  catalogue run's summary, verbatim: "2902 in the catalogue: 2008 draw any
  box, 778 tiles only (stitched live by the Worker), 116 tiles in another
  projection (not used live yet). Points swept: 3427, 2904 with a county or
  state photo service." By county name in the statewide-parcel states: 1,261
  counties looked at, 523 with a county or state photo service. H66 was
  1,491 services and 2,709 points. The ten-year rule (oldest 2016) and the
  nightly pruning that came after (workflow 27) will take some of the 2,902
  out; the live lookup already ignored them.
- **Canadian layers from New York's border grid:** York Region and Durham
  (Ontario) 2022-2025 5 cm caches, Brock University 2023 -- harmless for US
  addresses, which they do not cover.
- **A false year the year rule could not catch:**
  "AirPhotos/Niagara1972mosaic_2025", a 1972 mosaic whose name carries
  2025, was OFFERED FIRST at -78.95,43.05 (Grand Island / North Tonawanda,
  NY), ahead of New York's own 0.086 "Latest". Fixed: a year before 1990
  anywhere in a name now marks a layer historic, in the sweep, the nightly
  pruning and the live lookup.
- **The catalogue sweep (vendor re-sweep) finished**, its summary verbatim:
  "2090 in the catalogue: 1439 draw any box, 563 tiles only (stitched live
  by the Worker), 88 tiles in another projection (not used live yet).
  Points swept: 3427, 2801 with a county or state photo service." H66 was
  1,491 services and 2,707 points (the retry made it 2,709).
- **By county name, statewide states: still running.** 899 counties looked
  at so far, 357 with a service; 557 services added across the two runs.
- **The 233-county re-check (the 121 empty counties and the 126 with a
  "too coarse" refusal): 153 counties done, through nm-eddy, still running.**
  Of the first 100, only five empty counties gained anything, and all five
  look doubtful: a Mecklenburg County NC 2025 tile cache qualified at the
  Cherokee County AL point; Monterey 2014; FDOT 2013-2016 in Santa Rosa FL;
  Allatoona Lake 2015 in Chattahoochee GA; a 2017 library ortho in Sutter.
  The live lookup does not offer the Mecklenburg one at Cherokee (it returns
  nothing there), so its look at the spot filters it; the old years are
  past the ten-year limit (oldest 2016) the live lookup now applies.
- **Kept by the measurement where the metadata said coarse** (named only
  where the log shows no native resolution, i.e. measured): Wisconsin's
  WROC 2020, 2023 and 2025; "2025 Aerials - Woolpert"; Alabama's Barbour,
  Dallas, Elmore and Monroe county aerials; Orange County's 2022 1 ft.
- **Vendor flights found:** Woolpert 2022-2026 in several counties;
  Pictometry/EagleView in Fairbanks AK (2023 at 3 cm, 2026), Sonoma CA
  2025, St. Louis MN 2025 (5 cm), Steele MN 2025 (5 cm), Scott MN 2024
  (5 cm), Waterloo IA 2020, Butler 2020.
- **Virginia.** VBMP2025 covers only part of the state: fully transparent at
  -78.5,37.6 and -79.0,37.6. VBMP's statewide MostRecentImagery_WGS was
  never tried before b73897b -- undated, it sorted behind fourteen dated
  VBMP years, past the twelve tries a point gets. It is now catalogued (its
  metadata says 2025) and offered at both points, measuring 0.083 and 0.081
  at 12 cm, under the 0.10 line: offered after any sharp service, and the
  editor's own comparison with Mapbox decides whether it becomes the
  default. At Richmond the city/county 2020-2024 layers measure 0.38-0.54.
- **Virginia's resolution, from VGIN's own tile index (owner's lead,
  2026-10-03).** MostRecentImagery_WGS_Tile_Index records a Product per
  tile: 12 inch over most of the state, 6 inch and 3 inch where a locality
  bought up (30,355 bought-up tiles, 75 clusters at 0.25°). **The state's
  web services serve the 12 inch everywhere:** inside a 3-inch Richmond
  tile, MostRecentImagery_WGS at 7.5 cm a pixel measures 0.045 against
  0.049 and 0.031 in two 12-inch places, and VBMP2025_WGS 0.027. So the
  bought-up pictures reach us only from the localities' own portals. Of
  the 75 clusters, 60 get a local photo measuring 0.10 or more from the
  live lookup; 11 get only the state mosaic (0.05-0.10) -- southwest
  Virginia, Campbell/Bedford/Lynchburg, Orange/Louisa, Brunswick, James
  City/York -- and an ArcGIS search found no public portal for them; 4 in
  the far southwest are offered Kentucky's statewide services first, which
  did not answer the look in time. Fairfax, Loudoun and Arlington serve
  their own 2026 flights (0.14-0.25); Alexandria's public server stops at
  a 2016 ortho, its 2019-2025 flights only as tile indexes.
- **The live lookup looked at too few boxes (fixed 2026-10-03).**
  It took the eight newest services whose boxes cover the point and then
  looked at the spot. In Manassas those eight were Fairfax's and Loudoun's
  2026 services with no picture there, so the 0.19 Prince William catalogue
  was never looked at and only the soft state mosaic was offered. It now
  looks at 24.
- **Not established:** whether 0.10 at 12 cm is the right line for rural
  ground. The detail measure reads the scene as well as the camera; open
  fields read lower than a suburb at the same resolution. The Virginia
  readings may be that.

### H66. County photo catalogue, first full sweep: 1,491 services; 2,707 of 3,427 sweep points (79%) have a county or state photo, 2026-10-02

*Workflow 8, county_mode catalogue, four passes because each hit the 340-min
limit and resumed: 36915622764, 36954939684, 36982672486, then 37018721378
(completed 15:35 UTC, commit 0fe35bf). Qualifying rule as in
tools/county-imagery.js on that commit: a photograph, 2012 or later, 25 cm or
finer, picture checked at the point (flat, transparent, NAIP, habitat and
land-cover layers refused). The final pass's own summary, verbatim:*

    1491 in the catalogue: 1093 draw any box, 328 tiles only (stitched live
    by the Worker), 70 tiles in another projection (not used live yet).
    Points swept: 3427, 2707 with a county or state photo service.

- **A sweep point is not a person's address:** points are each county's parcel
  layer centre, or a 0.5 degree grid for statewide parcel services, so 79% is
  coverage of those points, not of homes or of land area.
- **Not in the 1,491:** services that refused without a token (seen in every
  pass, e.g. "arcgis 499 Token Required" in North Carolina and Wyoming), and
  the 70 tile caches in a projection the live app cannot stitch yet.
- Service ids are stable across passes (upsert on url). An apparent change
  (Blaine's 2026 Nearmap 379 -> 3) was a log line cut at 110 characters.

### H65. A live county-photo detection (Blaine County ID, 2026 Nearmap tile cache) traced 1.5-2 m south of the photo's features: the uploaded picture was of the frame before the property line moved, 2026-10-02

*Owner's report from the live app, not a run: the trained model (alpha
release 2026-09-29, never trained on a county photo) on a Ketchum lot,
county photo stitched in the browser. The outline hugged the north edge of
the roof and stopped 1.5-2 m short of the front walk on the south side, and
"lines up a bit better with Mapbox". Measured here afterwards, frame
158.7 m across centred on the lot:*

- **The two photographs agree north-south.** Whole-frame normalised
  cross-correlation, 1-pixel (0.2 m) steps, county vs Mapbox: 0.0 m north,
  Mapbox 0.79 m west (ncc 0.39); the road band alone 0.0 m north, 0.40 m
  west (ncc 0.48). They are years apart -- Mapbox shows a building site where
  the county photo has finished houses, and the lawn was rebuilt -- which is
  why agreement is low, not canopy (the lot has very few trees; owner).
- **CORRECTED, same day:** an earlier entry here said "county ground 1.08 m
  north of Mapbox's" from register.js with only 25 of 220 patches agreeing.
  It was wrong; the cross-correlation above replaces it. register.js's
  "confident" passed on a pair this different, which is worth knowing.
- **The served pipeline's own NAIP alignment** (naip_bands.naip_for, photo
  given, no stored alignment, which is what a county detection sends): left
  alone on the county photo ("edges 0.21"); moved 1.34 m east on the Mapbox
  photo ("edges 0.47 -> 0.54").
- **No lidar at this lot.** The 3DEP project the plan picks
  (ID_SouthernID_13_2018) has points over 31% of the frame at 1 m and 2 m
  cells, under MIN_COVERED (0.5), so the model ran on photo + NAIP.
- **The code path was read, not traced from logs:** the Worker sends the
  uploaded county picture (svc.frameUrl) to the model with the same frame
  the browser stitched; the outline is placed with the same alignment
  that places the photo on the map. No record of the press itself was read.

So the photos cannot explain a 1.5-2 m north-south shift, and an outline
"closer to Mapbox" has no route to Mapbox: the detector is never shown it.

**CAUSE FOUND, same day: a placement fault, not the model.** Reproduced in a
browser at the lot. The county photo is stitched for the frame of the moment;
about 4 s in, the property line is moved out to the road, which re-frames the
lot; the stitched picture, and the copy uploaded for the detector, were still
of the OLD frame (centre lat 43.717870, zoom 18.60, 503 px) while detection
sent the NEW one (43.717852, zoom 18.54, 483 px). The Worker lays the mask on
the frame it is sent, so the outline landed 1.96 m south -- the owner's
1.5-2 m. The owner's next try, after switching Layers to Mapbox and back
(which re-stitches for the current frame), "worked really well". Fixed in
public/app.js: re-framing re-stitches a county photo still on its way, only
the current stitch may upload, and detection re-stitches when the uploaded
picture's frame is not the one being sent. Nothing here says anything about
how the model reads county photos; that is still unmeasured.

**Decided the same day (owner):** the corpus maps keep their Mapbox outlines
unless the owner re-traced them on the county photo ("even the ones where the
imagery lines up well, the lawn outlines still don't fit because of the
different perspectives, times of year"). PHOTOS=county now trains on a county
photo only where outlines were traced on it, Mapbox elsewhere.

### H64. Corpus-wide: 55 of 55 approved maps that had a county photo banked are re-lined-up; 38 measured on the ground and landed within 0.1 m of Mapbox, 17 not measurable; the ground offset from Mapbox is a median 0.54 m and always a plain shift but one, 2026-10-01

*Two workflow 8 runs. The full search (36889876365, commit 0f82df2, old
alignment, before the approved-only filter): 103 corpus maps looked at, 92
with usable county or state imagery, median native 6 cm, median offset 0.43 m
by the old whole-frame method, 42 called doubtful by it. Then MODE=realign
(36915494071, commit d65b480): every APPROVED map with a banked county photo,
from its stored service, measured with lib/register.js as in H63 and banked
through the measurement. Per-map lines are in that run's log and its
county-imagery artifact.*

- **55 approved maps** have a county or state photo (20 hosts; Kent County MI
  9, Cass County ND 6, Virginia VBMP 4, Maryland six-inch 4, ...).
- **38 of 55 measured and landed**: the banked file re-measured within 0.1 m
  of Mapbox (median 0.01 m left). Median ground offset from Mapbox **0.54 m**;
  range about 0.15 m to 1.8 m (DeKalb GA 1.49 E -1.01 N).
- **Every measured map was a plain shift except one** (Onslow NC, an affine
  -- 18 of 46 patches). Same as H63's five.
- **15 "not sure"** -- too few agreeing patches (canopy-heavy frames: Kent MI,
  Prince William VA, Island WA, Indiana, Maryland) -- banked as delivered.
- **2 did not land**: Lawrence County AL, a tile cache read in a mosaic (0.19 m
  left after banking); one NC OneMap lot whose measurement said 3.60 m W and
  whose banked file could not be measured again. Both are in the 17 shown
  first on /county.html.
- SPECULATION, not tested: the shifts look regional (PA, NJ, KY, IL, MA about
  0.4-0.7 m E and 0.3-0.8 m S of north; Cass ND about 0.7 m N; Ottawa MI near
  zero), which is the size of the NAD83-to-WGS84 difference that ArcGIS
  services apply or do not. Nothing here measures which.

### H63. Lining photos up: on five county-imagery lots the ground differs from Mapbox by a plain shift of 0.15-0.8 m, measured to about 0.15 m; roofs and trees lean differently in each photo by up to metres; the old whole-frame alignment was pulled toward the roofs; parcel lines cannot be checked against any photo per lot, 2026-10-01

*Local bench, not CI and not the corpus: five lots chosen because the
earlier county runs found imagery there (Milwaukee WI -87.95621,42.86220;
Monmouth NJ -74.07922,40.37016; Northampton PA -75.52344,40.60945; Ottawa MI
-85.86,42.87, no parcel; Plymouth MA -70.62126,41.93372). Each: the Mapbox
frame from the site's own /api/imagery, the county photo the tool picked over
the same frame, NAIP over the same frame. Measured with public/lib/register.js
(patch-by-patch offsets, 9 m patches every 5 m, 20 cm cells; the mode of the
offsets, then a shift, shift+scale or affine kept only if it predicts
held-out patches better). No training, nothing scored. Five lots is an
anecdote about the method, not a measurement of the corpus.*

- **Synthetic, known answers** (tools/register.test.js, and the same on a real
  Mapbox photo warped by hand): a shift found to 0.02 m; 6 m + 1.2% scale +
  0.5 degrees to 0.01-0.07 m; a 2.5 m "lean" over a third of the frame left
  out, the rest found to 0.05 m.
- **County photo against Mapbox, all five: a SHIFT.** No lot needed scale or
  shear -- the richer models never predicted held-out patches better. The
  shifts (Mapbox's ground in the county photo): Milwaukee 0.40 m E 0.11 m N,
  NJ 0.48 E 0.24 N, PA 0.55 E -0.64 N, Ottawa 0.14 E -0.02 N, MA -0.28 E
  -0.73 N. Agreeing patches scatter 0.13-0.17 m about the fit, and the answer
  moved by 0.02 m or less as the tolerance went 0.25 -> 0.4 m.
- **Consistent around a triangle:** county->NAIP plus NAIP->Mapbox against
  county->Mapbox closes to 0.12 m (NJ) and 0.23 m (PA), the lots where all
  three were measurable.
- **Lean is real and large.** On Milwaukee the ground patches (road, kerbs)
  read about -0.35 m E, the house patches -0.8 to -1.3 m E; in NJ the walkway
  curve lines up where the roof is displaced by a metre or more. The old
  whole-frame alignment (lib/align.js on 30 cm cells, every edge) reported
  -0.95 m E on Milwaukee with an "affine" 2% squash -- the roofs, not the
  ground. With 14 m patches and a loose tolerance the new one still merged
  roofs and said -0.49 m; the mode with a 15 cm kernel said -0.41 m.
- **Banked and measured again:** fetched with a margin and resampled onto
  Mapbox's pixel grid, every one of the five measured 0.005-0.034 m from
  Mapbox afterwards.
- **Canopy defeats it, and it says so:** MA (leaf-on Mapbox, leaf-off
  county, mostly trees) was "not sure" in one direction (9 of 31 patches
  agreeing, covering 0.28 of the frame).
- **Parcel lines against photos: inconclusive.** Scoring how well each
  parcel line sits on line features (fences, kerbs) at offsets up to 3 m
  gave best offsets of 1-3 m that disagreed between photos and peaks barely
  above background. Nothing here says which photo, if any, the county's
  property lines are drawn true to.

**What it decided (not measured):** every photo is put on MAPBOX's ground,
because every outline in the corpus was traced there with the property line
drawn over it, and the detector runs there; then a property line lands on the
same ground in every photo. Which photo is "true" to the property records is
not known (last bullet), and lining photos up cannot fix a parcel that is
itself off.

### H62. Imagery: county or state orthophotos cover 22 of 60 lots at a median 6 cm native, sharper than Mapbox wherever sharpness could be measured; NAIP is about a third as detailed; USGS has nothing finer than NAIP; Google was 13 of 102 maps, 2026-10-01

*Workflow 8 "compare on our lawns" (tools/compare-imagery.js), run
36864827736 on commit 1411e80: the 60 newest approved lots, the same frame from
Mapbox and from every source found, each compared with Mapbox on the same
1280 px grid. Not a detector result: no training run, nothing scored against
traces. The full per-lot table is that run's imagery-probe artifact.*

- **USGS has no high-resolution ortho service.** Its catalogues list NAIP
  (USGSNAIPPlus, USGSNAIPImagery) and USGSImageryOnly, a cache that stops at
  1:9,028 -- about 1.8 m a pixel here, 2.1 m from Mapbox (median), covering
  50 of 60 lots.
- **NAIP** covers 60 of 60, about 23 cm native, median 0.9 m from Mapbox.
  Detail against Mapbox **0.36x** (more than Mapbox on 6 of 60).
- **County or state imagery** was found for **22 of 60 lots**; the finest per
  lot is a median **6 cm** native, **1.0 m** from Mapbox. Where detail could be
  scored (image services only) it beat Mapbox every time: Ottawa County MI
  2024 3.74x (2 lots), Will County IL 2023 2.69x (1), gis.acimap.us 2015 2.19x
  (1). Most county sources are map services, whose detail cannot be scored
  (see the retraction note below).
- **Season, not established.** The share of clearly green pixels against
  Mapbox's was low for some (Maryland 0.02x, Will 0.03x, Virginia VBMP 2025
  0.10x) and near Mapbox for others (Ottawa 0.82x, Cass ND 0.77x). That fits
  "often flown leaf-off or dormant, not always" -- but the measure has not been
  checked against a single real flight date, so it is SPECULATION, not a
  finding.
- **Google**: 13 of 102 corpus maps were drawn on it (89 on Mapbox). Made view
  only the same day (owner).
- Native figures for map services whose metadata has no `maxScale` come from
  the tile scheme and are not real (Virginia's "1 cm"); treat those as unknown.

**The first run of this (36860455959) is void for detail.** It asked servers
for their default resampling, nearest-neighbour, and the block edges of an
enlarged coarse picture read as fine detail: NAIP "1.73x", the 1.8 m USGS cache
"2.75x" sharper than Mapbox. Measured on one frame: NAIP 0.022 default,
0.007 bilinear; Ottawa 2024 0.045 either way. Its coverage, offsets and counts
stand.

**What this does not say:** that the detector would do better on county
imagery. It was trained on Mapbox. Changing the picture under it changes the
corpus, and that is a training question with its own runs.

### H61. Fewer not-lawn outlines (S20: 26 frames, 4 per kind) under THE PLAN: worse overall -- but they fix exactly the lots that took parking lots, and break others, 2026-09-29

*Runs 36601001355 (A, `examples: off`) / 36601005719 (B, `examples: some`),
commit 8ecfe8f, seed 7, `decoder: fused + edge`, `canopy: on lawn`,
`windows: off`, `lawns: all`, free runner. B trained on 26 example frames:
outlines road 62, sidewalk 27, building 25, water 17, driveway 8, parking 5,
pool 2. compare-runs.js locally, THE PLAN's row.*

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 55 | 14 / 33 / 8 | 24.0 -> 27.3% | +0.8 [+0.3, +1.4] | p 0.008 |
| frozen 32 | 9 / 17 / 6 | 26.0 -> 28.5% | +0.7 [-0.1, +1.1] | p 0.17 |
| approved since | 5 / 16 / 2 | 21.9 -> 23.7% | +1.4 [+0.7, +3.5] | p 0.03 |

The plain decoder's row moves the same way (14 / 37, +1.3 [+0.7, +2.3]).

**The screen (S20, before the runs): failed** -- the median paired change is
above zero with more lots worse than better. One seed, so this is a screen;
but it is the wrong side by more than its own interval, so seeds 8 and 9
were not run.

**Lot by lot, which is the interesting part:** the lots the owner named for
parking lots got much better -- **B20 75.0 -> 36.2, B19 46.5 -> 29.8**,
Georgia -84.06045,33.94050 321 -> 112, -84.53700,38.97534 57 -> 36, B16 19.3
-> 14.3. B12 (the pond) 25.9 -> 26.5, level. And others got much worse:
**B03 56.7 -> 96.6**, -77.40500,38.46195 52.9 -> 86.6, -76.89019,39.64422
28.8 -> 52.8, B23 32.9 -> 55.5, B04 57.7 -> 78.5.

**What this establishes:** the outlines teach what they are meant to -- the
lots whose error was pavement or water called lawn improved by 5-200 points
-- and cost more than that elsewhere, at 26 frames as at ~90 (H57). The
number of outlines is not what made H57 fail, or not all of it.

**Speculation, not established:** that the cost is the decoder becoming
generally more reluctant to call lawn (every graded cell in an example is
"not lawn", so 26 frames of them shift its sense of how much of a picture
is lawn), which would make the lost lots under-called rather than
over-called; the pictures would say. If so, weighting the examples' cells
less, rather than showing fewer of them, is the next thing to try -- not
run, needs the owner's word.

### H60. The edge refiner (S19) PASSES its bar: learned edge re-drawing on the 15 cm grid beats the plain decoder -- 34 lots better, 9 worse, 2026-09-29

*Runs 36555664599 / 36558441061 / 36558444702 (seeds 7 / 8 / 9), commit
0ecdfff, `lawns: all` (55), folds by place, `decoder: fused + edge`,
`windows: off`, `canopy: on lawn`, `cache: use`, free CPU runner. Each run
trains the plain fused decoder and the refined one over the SAME features,
folds and seed, so the comparison is within each run. compare-runs.js run
locally on the three lot-results files.*

THE PLAN's row, A = "the pretrained eye, decoder + stage 3, span, lidar
veto" (plain), B = "decoder, edge refined + stage 3, span, lidar veto":

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 55 | **34 / 9 / 12** | 25.1 -> **22.6%** | **-1.7 [-2.6, -0.5]** | p 0.0002 |
| frozen 32 | 22 / 4 / 6 | 28.2 -> 26.0% | -2.3 [-3.0, -0.7] | p 0.001 |
| approved since | 12 / 5 / 6 | 25.1 -> 21.2% | -0.5 [-2.3, -0.2] | p 0.14 |

Runs' medians A 26.1 / 26.4 / 27.0, B 23.9 / 25.6 / 21.3. The decoder rows
alone (before stage 3): 38 better / 9 worse, -2.2 [-2.8, -1.0], p < 0.001;
on the lots approved since 15 / 4, -1.4 [-2.9, -0.5], p 0.02.

**Bar (written in S19 before the runs): all three parts pass** -- p well
under 0.1, the interval wholly below zero, and better (not worse) on the
lots approved since. Seed 7 alone passed too (36 / 14, -1.3), so this is
not one lucky seed.

**Named lots (mean of three seeds, THE PLAN's row):** H53's near-all-edge
lots, where it should help if anywhere: B01 10.6 -> 9.6, B05 11.4 -> 9.0,
B21 5.4 -> 4.6, B29 4.9 -> 4.9. Real-mistake lots: B28 85.6 -> 83.2, B04
64.3 -> 62.5, **B20 47.0 -> 57.0 (worse)**. Biggest gains B03 69.5 -> 53.9,
B32 47.6 -> 36.4, B18 49.1 -> 43.2 and two unlettered lots by 12-14 points;
biggest losses B19 38.9 -> 53.2, B20, -84.53700,38.97534 46.5 -> 57.2, B16
13.1 -> 17.6.

**What this establishes:** re-deciding the decoder's answer on the 15 cm
grid from the photograph, with a small net trained jointly with the decoder,
lowers the error on most lots, on the frozen benchmark and on the lots
added since. It costs about 2x a decoder's training time (14-35 min on the
free runner against 6-13).

**The owner, from the pictures (2026-09-29):** B19 and B20's losses in
seeds 8 and 9 are both PARKING LOTS called lawn; seed 7 took no parking lot.
B16 is a mess in both the plain and refined answers: it misses featureless
open ground and is confused by leaf-off trees. Note: these three runs had
`examples: off` -- the not-lawn examples (parking lots among them) were NOT
in training, because H57 found them worse overall. So "shown many not-lawn
examples and still took a parking lot" is not what happened here; whether
examples help THIS decoder on parking lots specifically is untested.
The owner also saw the colour-edges layers appear to add where they should
subtract: the layers were computed correctly (added = in the colour-edges
answer and not THE PLAN's; taken out = the reverse), but "taken out" was
yellow beside stage 3's amber "put back under trees", which reads as an
addition. "Taken out" is red from 2026-09-29. **Confirmed by the owner:** the
parking lot in seed 7 was under "colour edges: taken out" -- colour edges
REMOVED it, correctly. From the same date the pictures carry two more layers,
"edge refiner: added" (navy) and "taken out" (black): THE PLAN's final
answer against the plain decoder's, same run, both after stage 3 and the
veto. The two decoders are scored as separate rows in every `fused + edge`
run ("the pretrained eye, decoder ..." and "decoder, edge refined ...").

**Not established -- speculation:** WHY B19 and B20 got worse (B20 also got
worse under colour edges' opposite, and is a real-mistake lot per H53), or
whether the gain is mostly the edge band or partly the refiner fixing
whole regions (B03's 16 points is more than an edge band). A per-lot
edge-band split (tools/edge-band.js, H53) on the refined row would say.
Also untested: whether stage 3 still helps on top -- on seed 7 the refined
decoder ALONE (22.8) beat the refined row WITH stage 3 (23.9).

### H59. Both scales, six seeds a side (S18): no better than the whole lot -- S17/S18 closed; the whole-lot squeeze stays, 2026-09-29

*A = the whole lot (`windows: off`, `canopy: compare`, fused, no examples)
seeds 7-12: 36488404436, 36503982887, 36503985030, 36503987452,
36507985116, 36503991446. B = both scales (`windows: both`, `canopy: on
lawn`) seeds 7-12: 36495279827, 36495282695, 36495284820, 36507987770,
36503996787, 36503998921. All on Modal's GPU except A seed 11 and B seed 10,
moved to the CPU runner (owner's cost rule) -- a known shift of about half a
seed on those two. Rows as barred; compare-runs.js locally.*

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 55 | 26 / 19 / 10 | 24.2 -> 23.6% | -0.2 [-1.2, +0.4] | p 0.37 |
| frozen 32 | 14 / 10 / 8 | 27.3 -> 26.0% | -0.1 [-1.3, +0.5] | p 0.54 |
| approved since | 12 / 9 / 2 | 24.1 -> 23.0% | -0.7 [-1.6, +0.7] | p 0.66 |

**Bar (S18): not met.** Doubling the seeds made the lean SMALLER (H58's
-0.4, p 0.13 -> -0.2, p 0.37): the three-seed lean was mostly seed noise,
which is what three seeds cannot rule out and six were for. **Both scales is
closed. The whole-lot squeeze stays.**

**By name (mean of six):** B24 38.7 -> 23.6 and B32 48.9 -> 39.6 are real
and large; B03 67.0 -> 61.6, B13 20.8 -> 17.1, B12 28.2 -> 25.9. B20 41.8
-> 49.3, B10 21.2 -> 26.1, B02 51.9 -> 56.8. B28 84.2 -> 86.4 -- not
rescued, as in H58.

**Where the arrangement question stands, on this backbone and decoder:**
every alternative to the whole-lot squeeze measured so far has failed its
bar -- windows (H56), fixed blocks at 6 and 10 cm (H55), the max-block rule
(H56), both scales stacked (H58/H59). Each reshuffles WHICH lots are wrong
(B28, B24, B20 move by tens of points) without moving how many. What is
NOT known is why a lot prefers one reading; see the research note in
where-things-stand before designing another arrangement.

### H58. Both scales (S17: the whole-lot pass and the 6 cm blocks stacked) LEANS better but misses its bar -- not adopted yet; S18 decides, 2026-09-29

*Runs 36495279827 / 36495282695 / 36495284820 (commit cd91b92, `windows:
both`, fused, `canopy: on lawn`, no examples, 55 lots, folds by place, seeds
7/8/9, **on Modal's GPU**), row "the pretrained eye, decoder + stage 3,
span, lidar veto", against S14's 36355253442 / 36355254898 / 36355256268
(CPU), row "decoder, canopy on lawn + stage 3, span, lidar veto" --
compare-runs.js locally.*

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 55 | 27 / 16 / 12 | 25.3 -> 24.1% | -0.4 [-1.4, +0.2] | p 0.13 |
| frozen 32 | 17 / 9 / 6 | 28.1 -> 25.5% | -0.8 [-1.9, +0.2] | p 0.17 |
| approved since | 10 / 7 / 6 | 24.8 -> 23.9% | -0.2 [-1.3, +0.5] | p 0.63 |

**Bar (S17): not met** -- more lots better than worse and not worse on the
lots since, but the sign test is 0.13 (bar 0.1) and the interval reaches
+0.2. It is the first arrangement since H50 whose every row leans the right
way, and it is still inside what three seeds cannot tell from nothing.

**Confounded, mildly:** B ran on the GPU, A on the CPU. The GPU was measured
the same as the CPU to +0.2 [-0.4, +0.8] (a lot moves 1.2 points against 2.6
for a seed), so it is not the explanation, but it is not nothing either.

**By name (mean of three seeds):** B28 85.6 -> 86.0 -- NOT rescued, though
blocks alone took it to ~28 (H55): stacked, the decoder listens to the whole
pass there. B03 53.6 -> 48.5, B13 20.2 -> 16.7, B12 28.8 -> 25.9, B24 39.5
-> 22.5, B32 48.7 -> 38.9; B20 45.6 -> 53.4 (blocks' worst lot, less bad
than blocks' 122-136), B10 20.8 -> 25.3, B23 37.4 -> 42.0.

**Time on Modal:** 57 min a run -- canopy 1.5 min, the whole pass + the 6 cm
blocks + the decoder 24 min, scoring 15 min. On the CPU the blocks alone were
91 min of backbone and 48 min a decoder.

### H57. The owner's not-lawn examples (S16) make the detector WORSE at the whole lot and under windows -- not adopted, 2026-09-28

*Runs on commit eb3dc3d, `examples: on`, fused, 55 lots, folds by place,
seeds 7/8/9. Whole lot (`windows: off`, `canopy: compare`): 36450737419 /
36450743019 / 36450746563, against S14's 36355253442 / 36355254898 /
36355256268, THE PLAN's row ("decoder, canopy on lawn + stage 3, span, lidar
veto") -- compare-runs.js run locally on the six lot-results files, because
workflow 24 run 36481560815 sat queued behind the training runs. Windows
(`windows: on`, `canopy: on lawn`): 36450750741 / 36450754828 / 36450758924
against S15's 36409834421 / 36411745885 / 36411749028, row "the pretrained
eye, decoder + stage 3, span, lidar veto" both sides, workflow 24 run
36481564377. In every one of these runs the examples trained on the whole
example frame (uncropped; see where-things-stand).*

**What went in:** 90 approved examples written as frames (outlines kept:
water 68, road 148, building 77, sidewalk 62, parking 23, driveway 20, pool
2); the decoder counted 90 (water 35, building 19, parking 15, driveway 10,
sidewalk 5, road 4, pool 2 -- by the id's kind). 145 frames in all beside
the 55 lots. Folds left out 1 to 13 examples within 2 km of a held-out lot.

**Whole lot, against S14:**

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 55 | 14 / 38 / 3 | 25.3 -> 31.1% | +2.7 [+1.1, +4.6] | p 0.001 |
| frozen 32 | 9 / 22 / 1 | 28.1 -> 32.8% | +2.7 [+1.0, +6.1] | p 0.029 |
| approved since | 5 / 16 / 2 | 24.8 -> 23.3% | +2.7 [+0.8, +5.2] | p 0.027 |

**Windows, against S15:**

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 55 | 11 / 40 / 4 | 27.6 -> 29.9% | +3.3 [+1.4, +5.0] | p 0.000 |
| frozen 32 | 6 / 23 / 3 | 28.9 -> 31.8% | +2.8 [+1.1, +5.2] | p 0.002 |
| approved since | 5 / 17 / 1 | 23.4 -> 28.9% | +4.3 [+1.1, +5.3] | p 0.017 |

**Bar 1 (whole lot) and bar 2 (windows): both fail, and not narrowly** --
the 95% intervals sit wholly ABOVE zero. This is the first setting in this
file measured as clearly worse by three seeds a side, both ways.

**Where it helped, as hoped:** the pond, B12, 28.8 -> 22.0 at the whole
lot; the Georgia lot (-84.06045, 33.94050) 409 -> 148 at the whole lot and
440 -> 300 under windows; B19 41 -> 31 and 36 -> 24. **Where it hurt:** at
the whole lot B03 53.6 -> 95.2, B02 51.6 -> 91.0, B23 37.4 -> 66.3, B10
20.8 -> 47.9, -77.40500,38.46195 45.2 -> 71.2; under windows B16 10.8 ->
86.4, B15 9.4 -> 52.2, B18 40.6 -> 66.7, B28 30.2 -> 50.4.

**Not known:** whether those lots lost lawn or gained it -- the per-lot
files carry the error, not its direction. The pictures of these runs would
say. S16's "why it might not" (the examples shift the decoder's balance and
push the lawn's edge in everywhere) is the obvious reading of lots going
from 10% to 86%, and it is SPECULATION until a picture shows it.

**The crop does not rescue them (2026-09-29).** Whole lot with the examples
CROPPED to their graded cells (runs 36484570562 / 36484573224 / 36484577454,
commit 071becf, CPU): against S14 without examples 10 better / 41 worse,
+3.8 [+2.7, +5.4], p 0.000 -- worse than the uncropped runs, and against
them +0.7 [+0.0, +1.0], 16 better / 30 worse. On the lots approved since,
+3.8 [+2.9, +5.6]. The Georgia lot improves again (409 -> 152) and B19 (41
-> 21); little else. Examples are closed as built.

**Also measured:** the examples made the run ~3.6x longer (backbone 12 ->
46 min, a decoder 10 -> 33 min) for 145 frames against 55 -- the example
photographs are bigger frames than the lots on average (19 s a frame at the
backbone against 13).

### H56. A maximum block size (S15: whole below ~90 m, windows above) is no better, and on the lots approved since it is worse -- not adopted, 2026-09-28

*Runs 36409834421 (seed 7, commit 0fdfee7), 36411745885 (seed 8) and
36411749028 (seed 9) (both commit 7cbae83 -- the first seed-8/9 launches,
36409837637 and 36409840302, died installing packages when PyPI timed out,
fixed by a longer pip timeout; no code difference), `windows: on`, fused,
`canopy: on lawn` (one decoder, THE PLAN's row named "the pretrained eye,
decoder + stage 3, span, lidar veto"), `lawns: all` (55), folds by place.*

**THE BASELINE, CORRECTED:** H50's fused runs predate NAIP alignment
(e8e9bf7, 2026-09-27 evening), so a comparison with them changes two things
at once. The S14 runs (36355253442 / 36355254898 / 36355256268, commit
79f28ba, fused, windows off, seeds 7/8/9) include it and are the fair
baseline. Both are given; they agree.

| B against | lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|---|
| S14 (fair) | all 55 | 18 / 28 / 9 | 25.3 -> 27.6% | +0.6 [-0.1, +1.4] | p 0.18 |
| S14 (fair) | frozen 32 | 12 / 13 / 7 | 28.1 -> 28.9% | +0.1 [-1.2, +0.9] | p 1.00 |
| S14 (fair) | approved since | 6 / 15 / 2 | 24.8 -> 23.4% | +1.4 [+0.1, +5.6] | p 0.08 |
| H50 | all 55 | 18 / 31 / 6 | 25.6 -> 27.6% | +0.8 [+0.0, +1.4] | p 0.09 |

Workflow 24 runs 36442768901 (against S14) and 36442743520 (against H50).
Runs' medians 26.1 / 27.3 / 28.7.

**Bar (before the runs): failed** -- more lots worse than better, the
interval does not lie below zero, and on the lots approved since it is
worse with an interval above zero. S15 is closed.

**H55 re-read against the fair baseline (same workflow, S14 as side A):**
tiles 6 cm 21 better / 29 worse, +0.8 [-0.6, +2.3] (run 36442789494);
tiles 10 cm 23 / 25, -0.1 [-1.6, +1.0] (run 36442793651). The conclusion
stands: neither screens.

**One lot every variant helps:** B28 (NC 10,556, semi-dormant, trees gone
since the lidar) goes 85.6 -> 30.2 under windows, 27.5 at 6 cm, 28.5 at
10 cm. The lots windows hurt most are B10 (20.8 -> 36.8), and three
approved since. B20, which blocks sent past 120%, windows IMPROVE
(45.6 -> 33.7) -- so the lots each reading helps are not the same lots.
**Speculation, not established:** that B28 suffers from the whole-lot
squeeze specifically (it improves under every finer reading); nothing
about it has been checked beyond the numbers.

### H55. Reading every lot in fixed blocks (S13) does not screen -- at 6 cm or at 10 cm -- but it moves the SAME lots by tens of points both times, 2026-09-28

*Run 36358021364, commit 16f0f62, `windows: tiles 10 cm`, `lawns: all`
(55), folds by place, `decoder: fused`, seed 7: every lot at 10 cm a pixel
in 448 px blocks (45 m, kept middle 35 m, 4.8 m of context past it), a
backbone patch 1.60 m on every lot, blocks over 8 m from the lot skipped.
Against H50's three fused runs (36299639542 / 36299640699 / 36299641884),
THE PLAN's row, workflow 24 run 36367542993. **The 6 cm run** (the one S13
is about: 27 m blocks, 0.96 m patches): run 36358019744, same commit and
settings, workflow 24 run 36377343429 -- second table.*

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 55 | 23 / 25 / 7 | 25.6 -> 28.0% | +0.2 [-1.4, +1.4] | p 0.89 |
| frozen 32 | 12 / 15 / 5 | 28.2 -> 28.7% | +0.3 [-1.1, +2.1] | p 0.70 |
| approved since | 11 / 10 / 2 | 25.1 -> 22.7% | -0.3 [-2.9, +2.2] | p 1.00 |

**6 cm, against the same three fused runs:**

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 55 | 21 / 31 / 3 | 25.6 -> 27.5% | +0.9 [-0.7, +2.4] | p 0.21 |
| frozen 32 | 12 / 19 / 1 | 28.2 -> 28.4% | +1.6 [-1.1, +5.6] | p 0.28 |
| approved since | 9 / 12 / 2 | 25.1 -> 22.9% | +0.8 [-1.5, +2.0] | p 0.66 |

**Screening bar (before the runs): not met by either** -- the median
paired change is above zero and fewer lots are better than worse, and the
finer blocks (6 cm) are, if anything, worse than the coarser (10 cm).
One seed each, so a screen, not a result; seeds 8 and 9 are not worth
running on this. **S13 is closed as built.** The 6 cm run cost 91 min of
backbone and 48 min a decoder (19 at 10 cm).

**But it is not "nothing happened".** The lots that move, move by tens of
points, both ways: B28 82.3 -> 28.5, B03 72.1 -> 33.8, B18 49.4 -> 31.4,
B04 65.1 -> 53.0; and B20 45.5 -> 121.7, B02 51.6 -> 75.5, B24 40.6 ->
63.8, B19 39.8 -> 61.6. H50's seeds move lots by a few points; these are
ten times that. Reading in fixed blocks changes WHICH lots the detector
gets wrong, not how many. **And it is the same lots at both scales:** at
6 cm B28 82.3 -> 27.5 and B03 72.1 -> 29.1 again, B18 49.4 -> 38.0; B20
45.5 -> 135.9 again, B23 37.1 -> 68.4, B13 20.3 -> 39.7, B10 20.9 -> 39.0.
Two runs agreeing on which lots move is not seed noise. The Georgia lot at -84.06045, 33.94050 (870 sq
ft traced) is 428 -> 514%, broken in both (see H54).

Extraction was cheap: the backbone step took 18 minutes (7 windows a
typical lot, 40 on the largest), the run 2 h 8 min, no memory trouble.

**Checked 2026-09-28, and it is NOT size:** the lots blocks helped are
B28 (10,556 sq ft), B03 (13,689), B18 (10,304), B04 (19,932); the lots they
hurt include B13 (105,584) and B10 (26,207) as well as B20 (11,947), B23
(5,042), B02 (4,315). The biggest lot got much worse, mid-sized ones much
better. So the earlier guess ("big lots gain, small lose") is wrong as
stated. What separates them is not known. If it holds, the idea to try is
not blocks for every lot but the whole-lot pass PLUS block features for
lots too big for one pass -- which the size check above does not support;
see S15 for the owner's version of it, measured anyway.

### H54. Colour on the edges (S14) fails its bar: a small gain on the lots it was designed on, none on the lots since -- not adopted, 2026-09-28

*Runs 36355253442 / 36355254898 / 36355256268 (seeds 7 / 8 / 9), commit
79f28ba, `lawns: all` (55), folds by place, `decoder: fused`, `windows:
off`. Each run scores THE PLAN's row and the same row with colour edges
(tools/colour-edges.js), so the comparison is within the same decoders.
Workflow 24 run 36362309179.*

| lots | better / worse / level | median | paired change [95%] | sign test |
|---|---|---|---|---|
| all 55 | 25 / 20 / 10 | 25.3 -> 24.8% | -0.3 [-1.0, +0.3] | p 0.55 |
| frozen 32 (tuned on) | 18 / 10 / 4 | 28.1 -> 27.1% | -0.8 [-1.7, +0.1] | p 0.19 |
| approved since | 7 / 10 / 6 | 24.8 -> 24.3% | +0.2 [-0.3, +0.9] | p 0.63 |

**Bar (written before the run): all three parts failed** -- p 0.55 not
under 0.1, the interval crosses zero, and worse on the lots approved since.
Runs' medians A 25.7 / 26.3 / 26.3, B 25.0 / 25.0 / 26.5.

**Lot by lot:** big gains on three lots -- B20 45.6 -> 31.9, B19 41.3 ->
30.3, B23 37.4 -> 30.4 -- and losses of 2-5 points spread over B22, B28,
B02, B06 and others. A lot at -84.06045, 33.94050 (Georgia, approved since
the freeze) is 409% wrong WITHOUT colour edges and 441% with: its traced
lawn is tiny against what the detector calls lawn. That lot is broken in
both columns and is worth the owner's eye; it is not colour edges' doing.

**What this establishes:** re-deciding the metre next to the decoder's
edge from the lot's own colours does not, on balance, move the edge the
right way. It stays scored beside THE PLAN's row (no cost), but is not
part of THE PLAN.

**Speculation, not established:** that it helps a particular kind of lot
(B19/B20/B23 all gained 7-14 points) and hurts another. Three lots is not
a pattern; nothing here says what they share.

### H53. The ~10% on a near-perfect picture is a thin band along the true edge -- not a scoring bug, not misregistration, not the tracing, 2026-09-27

*Run 36339575912, commit 400d0d1, `lawns: all` (55), folds by place,
`decoder: on`, `canopy: compare`, seed 7 -- a repeat of H50's unfused seed 7
with the new per-lot diagnosis (tools/edge-band.js). Asked by the owner:
B01 is drawn all but perfectly and reads 10.8% out.*

**Reproducible:** all 32 benchmark lots' errors on THE PLAN's row match
H50's seed 7 run (36299643380) to the tenth. Same seed, same corpus, same
answer.

**B01 (Cass ND, 4,987 sq ft):** mask 10.9%, traced outline 11.1%; **94% of
its wrong ground lies within 0.5 m of the true edge**, 96% within 1 m; the
best shift (0.13 m, -0.13 m) only takes it to 10.4%. 10.9% of 463 m² is
about 50 m², which along a lawn edge of roughly 100 m is a band averaging
half a metre -- a foot and a half of wobble, invisible at phone zoom and
counted in full.

**Across all 55 lots (medians):** 41% of the wrong ground is within 0.5 m
of the true edge, 60% within 1 m. The lots that score well are almost all
edge (B29 5.6%: 92% within 0.5 m; Cass 10,554 4.0%: 94%; B21 6.3%: 85%;
B05 11.6%: 83%); the lots that score badly are mostly real mistakes away
from the edge (B04 61.5%: 13%; B20 57.2%: 16%; B28 76.3%: 21%; B16 20.2%:
14%).

**Not registration:** the best shift within 0.6 m has median (0.00, 0.00)
m and takes the median from 25.5% to 25.3%. **Not the tracing:** the
outline the picture shows scores 25.8% median against the mask's 25.5%.

**What this establishes:** the scorer counts what it says it counts. On a
lawn the detector gets right, ~10% is the price of placing the edge to
about half a metre; a small lawn has more edge per square foot, so the
same band is a larger share of it. A lot's error has two
parts that the headline adds together: edge wobble, and real mistakes.

**The owner on B01, from the pictures (2026-09-27) -- and the rule it
sets: TRACING IS TO BE TAKEN AS NEARLY PERFECT.** The trace stops at a
white vinyl fence on the north side and the detector ran a little past it
(it did not read the fence as not-lawn); the property line takes in two or
three inches of the neighbour's lawn, which nothing can help; on the south
side the trace is perhaps two inches off where it skips part of a fence's
shadow, and there the detector matched the line almost exactly. The owner
judges the ~1.5 m patch broadly responsible for the edge error.

**What it does NOT establish -- speculation:** how much a finer output would
recover. The patch is 1.3-5.4 m depending on the lot: every lot is squeezed
into ONE 896 px pass (`windows: off`), 5.4 to 33.5 cm a pixel in this run,
so the frame's size -- padding included -- sets the patch. A fence one
patch wide cannot be resolved. The colour-and-texture row answers per
15 cm cell and scores ~9.5% on B01, so pixel-level colour may help place
edges where the decoder cannot (the owner's question: colour as a helper,
not a replacement).

### H52. Telling Scale-MAE a scale inside its pretraining range makes it WORSE, not better: x1 (metres a pixel) stands, 2026-09-27

*Runs 36303807284 (x5), 36303809104 (x10), 36303810721 (x25; factors
read back from each log's "res factor xN"), commit a2a1ead, `lawns: all`
(55, fingerprint `00fp0bu`), folds by place, `decoder: on`,
`canopy: compare`, seed 7 each. Against the three H50 unfused runs (x1,
seeds 7/8/9, per-lot mean). S12's test. One seed a factor: a SCREEN.*

THE PLAN's row, lot by lot against x1:

| factor (res passed for 10 cm) | all 55: better / worse, median change [95%] | frozen 32 | since (23) |
|---|---|---|---|
| x5 (0.5) | 19 / 33, **+1.6** [-0.2, +2.6], p 0.07 | 8 / 23, +2.4 [+1.0, +5.7], p 0.01 | 11 / 10, -0.4 |
| x10 (1.0, torchgeo's default) | 16 / 31, **+1.4** [-0.0, +3.1], p 0.04 | 6 / 23, +3.6 [+1.1, +9.3], p 0.002 | 10 / 8, -0.3 |
| x25 (2.5, inside pretraining's 2.2-5) | 19 / 33, **+2.6** [+0.2, +6.0], p 0.07 | 12 / 18, +1.7 | 7 / 15, +2.6 |

Every factor is worse on more lots than it is better, on THE PLAN's row
and on the decoder alone ("no canopy": x5 +1.8, x10 +2.2, x25 +1.9), and
the eye alone (no decoder) is worse too at x5 (+2.5 [+1.1, +3.9], 16 / 37).
**S12's bar (median change below zero with more lots better) is failed by
all three. None is confirmed with more seeds; x1 stands.**

**What this establishes:** passing metres a pixel -- outside the range
Scale-MAE was pretrained on (E2's correction) -- is not costing us
anything measurable, and moving into that range costs one to three points.
S12's worry is measured as nothing, the third idea in this file argued for
and then measured as nothing.

**What it does NOT establish -- speculation:** why. The frozen 32 lose
more than the lots since (x5, x10 are level there), and the stage-3 and
veto settings were tuned on the 32 with x1 features, so part of the loss
may be retuning owed rather than worse features. That would still not
make any factor better on the untuned lots, where none is. S12's side
remark that H4's 896-over-1280 might be this effect is unsupported.

### H50. The first decision under the new protocol: the fused inputs are worth NOTHING on 55 lots, folds by place, three seeds each — not adopted, 2026-09-27

*Workflow 14 runs on commit 2ca74ca, `lawns: all` (**55** approved lots,
fingerprint `00fp0bu`; the corpus grew from 53), `FOLDS=place` (15 folds,
neighbourhoods within 2 km held out together; sizes 6, 4×7, 3×7),
`canopy: compare`. Fused: 36299639542, 36299640699, 36299641884 (seeds 7,
8, 9). Unfused: 36299643380, 36299644583, 36299645971 (seeds 7, 8, 9).
Seed and decoder read back from each run's lot-results.json. Compared with
tools/compare-runs.js, per-lot mean over each side's three seeds.*

**THE PLAN's row, "decoder, canopy on lawn + stage 3, span, lidar veto":**

| lots | fused better / worse / level | median paired change [95%] | sign test |
|---|---|---|---|
| all 55 | 23 / 20 / 12 | **-0.1 [-0.7, +0.4]** | p = 0.76 |
| the frozen 32 | 12 / 13 / 7 | -0.0 [-0.8, +0.6] | p = 1.00 |
| approved since (23) | 11 / 7 / 5 | -0.5 [-0.8, +0.7] | p = 0.48 |

**The bar (written before the run) is not met on any of its three
counts.** No other row clears it either: canopy everywhere + stage 3,
veto 25 / 18, -0.3 [-1.2, +0.2], p 0.36; the decoders alone -0.1 to -0.5
with every interval crossing zero, the best being canopy everywhere alone
at 28 / 17, p 0.14.

**The seeds matter as much as the setting.** Run medians on THE PLAN's
row: unfused 25.5, 25.1, 27.6; fused 26.3, 26.3, 27.0. The spread between
seeds of the SAME setting (2.5 points) is larger than anything the fused
inputs did. On "decoder, canopy everywhere" alone, unfused went 27.6,
23.4, 23.8.

**Also checked:** the two Peach County, GA lots are now "treated as no
lidar" (0% of cells with points) and score 57% and 12-18% on the veto rows,
no longer 100% (H49's bug is fixed). The lot-results files label their
folds "leave-one-out"; that was only the label (the scorer was not given
FOLDS); the decoder logs say "15 folds by place". Label fixed.

**What this establishes:** under folds by place and averaged over three
seeds, the seven fused channels do not move THE PLAN's row, on the tuned
32 or on the lots since. H48's lead (fused decoders alone under THE PLAN)
and H51's 25-to-6 do not survive it.

**What it does NOT establish -- speculation, not measured:** WHY H51 and
H50 disagree on the same 32. Two candidates, untested: (a) H51 was ONE
seed a side, and a seed shifts a whole decoder, so its 32 lot-by-lot
results are not independent and its p = 0.001 was overconfident; (b)
random folds let a lot's neighbours into training and the fused channels
(lidar, NAIP, both local) exploit that more than the eye does. (a) alone
is enough to explain it given the 2.5-point seed spread above.

### H51. 10 folds did not manufacture or hide the fused result: on the 32 it reproduces, and lot by lot it is stronger, 2026-09-27

*Runs 36298873117 (fused) and 36298874496 (unfused), commit ecc9678, the
frozen 32 (fingerprint `1rijjz2`), `lawns: benchmark, 10 folds` (about 3
lawns held out a fold, random, not by place), `canopy: compare`, seed 7.
Asked by the owner: "are you sure the 10 groups thing didn't mess it up?"
The same pair as H48 in every setting except the folds.*

| row | H48, leave one out: unfused → fused | 10 folds: unfused → fused |
|---|---|---|
| **THE PLAN's row** | 26.6 → 26.5 | **26.5 → 25.2** |
| decoder alone, no canopy | 28.5 → 26.1 | 27.5 → 25.8 |
| decoder alone, canopy on lawn | 29.8 → 25.0 | 28.0 → 26.1 |
| decoder alone, canopy everywhere | 24.3 → 24.5 | 25.8 → 28.2 |
| canopy everywhere + stage 3, span, veto | — | 23.9 → 23.5 |

**Lot by lot on THE PLAN's row** (paired from the log's "Lawn by lawn"
tables, tools/compare-runs.js statistics): fused better on **25**, worse
on **6**, sign test **p = 0.001**, median paired change **-1.2 points**,
95% bootstrap interval **[-2.0, -0.45]**. H48 on the same row was 18
better / 7 worse. On "canopy everywhere + stage 3, span, veto": 22 / 9,
p = 0.03, median -1.0 [-1.4, -0.2].

**What this establishes:**
- Leave-one-out to 10 folds moved the UNFUSED medians by 0.1 (plan row)
  to 1.8 points (decoders alone), within the run-to-run spread this file
  has already recorded (H13, H49's rejected-map note). The protocol change
  did not break the pipeline.
- The fused direction on THE PLAN's row held under the other protocol and
  was clearer lot by lot. The one row that reversed is the canopy-
  everywhere decoder alone (+2.4 fused), which H48 already had level.

**SUPERSEDED BY H50 (same day): under folds by place and three seeds a
side, fused is worth nothing on these same 32 (12 better / 13 worse). The
p = 0.001 above treats 32 lots as independent draws, and within one seed
they are not -- one seed shifts the whole decoder (H50 measured 2.5 points
between seeds of the same setting). Read this entry as "10 folds did not
break the pipeline", and nothing about the fused inputs.**

**What it does NOT establish:** that fused is adopted. One seed, random
folds (neighbours can share a fold's training set), the 32 only. H50 (53
lots, place folds, three seeds each) is the decision; this is its first
supporting data point and nothing more. The 10-fold medians are NOT
comparable to leave-one-out medians as levels, only as directions.

### H49. On all 53 maps the fused inputs are worth a point or two at most — and the run found the lidar veto erasing two lots whole, 2026-09-27

Runs 36290696462 (`decoder: fused`) and 36290697360 (`decoder: on`),
workflow 14, `canopy: compare`, **`lawns: all`, 53 maps, fingerprint
17dzt95, NOT the benchmark**, and for the first time **10 folds** rather
than leave-one-out (H49's first attempt died on the 3-hour limit). The
canopy-on-lawn decoder had no canopy channel (H48's fix 1). Compared only
with each other. Lidar on 50 lots, NAIP on 52.

**THE VETO BUG, first.** Both Peach County, GA lots went to 100% wrong on
every veto row, in both runs ("2 of 53 folds answered the same thing
everywhere"). GA_Central_5_2018's footprint claims them, and its point
cloud returns ZERO points over either frame (12 nodes read, 0 points inside
— checked directly). "Nothing came back" read as void everywhere, and the
veto took 5,514 m² of the tracer's lawn (0 m² on the benchmark 32, H39).
**Fixed** (tools/lidar_frame.py): a frame with returns in under half its
cells is written as having no lidar at all, and "nothing came back" is void
only in a frame the lidar otherwise covers (90%+). So **every veto row in
both runs is void as a comparison**, and the fair rows are the ones without
it.

| row (median wrong) | unfused | fused |
|---|---|---|
| decoder, no canopy (alone) | 21.7% | 21.6% |
| decoder, canopy on lawn (alone) | 21.7% | 21.9% |
| decoder, canopy everywhere (alone) | 20.8% | 21.7% |
| no canopy + stage 3, span | 23.0% | **21.1%** |
| canopy on lawn + stage 3, span | 22.1% | **20.9%** |
| canopy everywhere + stage 3, span | 21.7% | **20.4%** |
| THE PLAN (on lawn + span + veto) — **void, veto bug** | 23.2% | 25.2% |
| sharp-boundary error, decoders alone | 69.4–71.6% | 71.0–72.6% |
| on-lawn decoder, inferred column | 43.2% | 43.1% |

**Against the bar: neither half passes.** (a) THE PLAN's row cannot be
read (the veto bug); lot by lot on it, fused is 22 better against 16
worse, median change 0.0; on the 32 benchmark lots inside the 53, 16
better against 10 worse, median −0.45 — H48's direction, a third of its
size. (b) The best fused decoder alone (21.6%) is 1.6 points under the
void plan row and 0.5 under the fair "on lawn + span" row: fails.

**What held and what did not.** The stage-3 rows are 1.2–1.9 points
better fused, in all three decoders — consistent, and under the two-point
bar. The decoders alone are level. **H48's sharp-edge gain did not
replicate** (fused is 1–1.5 points worse here). **Fix 1 changed nothing
measurable:** at 53 lawns the unfused on-lawn decoder leaks just as much
(inferred 43.2%), so the leak is the on-lawn WEIGHTING, not the canopy
channel. And 53 lawns made everything better: the unfused on-lawn + span
row reads 22.1% against the benchmark's 26.6% — not comparable, but the
owner's "more data" is the largest lever this file has seen.

### H48. Fused inputs: THE PLAN's row does not move, 18 lots better against 7, and the fused decoder alone reads under THE PLAN — not adopted, a lead, 2026-09-26

Run 36271469618, workflow 14, `canopy: compare`, `decoder: fused`,
benchmark (32, fingerprint 1rijjz2). S11 as built: seven more numbers a
patch beside the eye's 1024 (lidar height, ground-return share, log return
count, has-lidar, NAIP NDVI, has-NAIP, canopy share), lidar dropout 0.3,
NAIP 0.2. Lidar on 29 lots, NAIP on 31 of 32, canopy on 32 (0 for the
no-canopy decoder, by design). Baseline: run 36263512588, the same 32, same
seed, same code otherwise.

| row | baseline | **fused** |
|---|---|---|
| **THE PLAN (canopy on lawn + stage 3, span, veto)** | 26.6% | **26.5%** |
| … seen / inferred | 22.2 / 28.5 | 21.8 / **32.5** |
| … in shade / in sun | 24.8 / 32.2 | 23.2 / 34.3 |
| … over SAM | 16 of 26 | 17 of 26 |
| decoder, no canopy (alone) | 28.5% | **26.1%** |
| **decoder, canopy on lawn (alone)** | 29.8% | **25.0%** (18 of 26 over SAM) |
| … seen / inferred | 24.3 / 34.5 | 22.1 / **44.6** |
| decoder, canopy everywhere (alone) | 24.3% | 24.5% |
| canopy everywhere + stage 3, span, veto (lowest) | 23.4% | 23.2% |
| sharp-boundary error, decoders alone | 72.0–76.3% | **69.7–71.9%** |
| hard-shade error, plan row | 40.2% | 36.9% |

**Against the bar (THE PLAN's row 24.6% or better): fails. Not adopted.**
The median moved a tenth of a point.

**Lot by lot on THE PLAN's row: 18 better, 7 worse, 7 within half a point**
(median change −0.7). B03 Utah 65.8 → 26.4, B02 −6.5, B06 (Kent 8,626, the
roof) −4.6, B21 −3.4, B09 −3.2, B04 −1.9, B23 −1.1; worse: **B28 69.5 →
79.5** (NC 10,556, the lot whose trees NAIP says are gone, H40 — stale
lidar, exactly the owner's worry, and dropout at 0.3 did not stop it; the
owner confirms the trees are gone from the Mapbox photograph too, so the
lidar is the one source that is wrong there), B24
+9.3 (the one-cell registration oddity), B22 +4.7, B26 +2.3, B25 +1.9. B12
(the pond) unchanged; the veto still took 382–397 m² of void, so the
decoder did not learn water. It took 196–201 m² of roof it would otherwise
have kept, against 245–311 before, so it learned some roofs.

**WHY THE PLAN'S ROW DID NOT MOVE, read from the table rather than
guessed:** the gains are in the decoders alone (−2.4, −4.8) and stage 3
replaces the decoder's answer under every canopy cell. Much of what the
fused decoder learned is what stage 3 already does — the "on lawn"
decoder's inferred column went 34.5 → 44.6 while its total fell, i.e. it
learned to call canopy not-lawn. **That is a leak of this run's own
making:** that decoder is trained with canopy over traced lawn weightless
(H27) and canopy the tracer left out as weighted zeros, so every graded
canopy cell it sees is not lawn, and a canopy channel lets it learn "canopy
= not lawn" directly. The everywhere decoder, where canopy carries no
weight at all, did not move (24.3 → 24.5).

**WHAT IS REAL, and only a lead:** on visible ground the fused inputs help
where they were expected to — sharp boundaries 4–7 points better (the
driveway edge that S8 said the eye makes worse), hard shade 3.3 points
better, seen 22.2 → 21.8 on the plan row and 24.3 → 22.1 on its decoder.
And the fused "on lawn" decoder alone, with no stage 3 and no veto, reads
25.0% against THE PLAN's 26.6%. That is the owner's thesis in one number —
a learned model matching the hand logic — but it is a different row from
the one the bar was written for, one run, and inside H7's noise; so it is
SPECULATION until a bar written for it is met.

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

*Again on 2026-10-09 (run 37958772105, 87 approved maps): 81 of 87 covered
(93%); flown 2013 to 2023, middle year 2018; roughly 2016: 19 lots (Kent,
Ottawa, NC Union), 2022: 12 (Cass ND, Prince William), 2020: 11, 2018: 9,
2015: 6, 2017: 6, 2021: 6 (Massachusetts, Franklin OH at 57.9 pts/m²),
2014: 4, 2019: 2, 2023: 2, 2013: 1, undated 3 (KY_FullState). 27 at 8
pts/m² or better. The six with nothing flown: Maryland x2, NC x1, Whatcom WA,
Island WA, one hand-traced. The project is chosen newest year first, then
densest (tools/lidar-cover.js pickBest). The gap to the photograph is still
unmeasurable from the corpus.*

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

**CORRECTED 2026-09-27, from the authors' code rather than the paper.** The
paper writes the scale as g/G, "G a reference GSD, nominally set to 1 m". The
pretraining code never reads a ground size: `mae/dataloaders/utils.py` sets
`res = ratios * base_resolution`, where `ratios` is crop pixels over output
pixels from a random 20-100% crop of a 448 px piece, `base_resolution` is 2.5
(`config/fmow.yaml`), and the encoder's 224 px input doubles it. So the
encoder saw `res` of about **2.2 to 5.0** in pretraining: a RELATIVE zoom
against each FMoW image's own pixels, not metres. The kNN evaluation passes
`eval_base_resolution * 224 / eval_scale`, again relative. torchgeo's loader
(`scalemae_large_patch16`) defaults `res` to 1.0 and multiplies the position
grid by it. **This project passes metres a pixel, 0.07-0.10**, so the
position encoding is squeezed 20-70x tighter than anything in pretraining.
Whether that costs anything is NOT measured: see S12. **Settled
2026-09-27:** torchgeo's own docstring for `ScaleMAE(res=...)` reads
"Spatial resolution of the image in meters", and the paper's G is 1 m, so
metres a pixel is what both the paper and the loader we use ask for; only the
authors' pretraining script counts differently. H52 measured the
alternatives as worse. We pass metres; nothing to change. Sources: the paper
(arXiv 2212.14532, sec. 3), github.com/bair-climate-initiative/scale-mae,
torchgeo/models/scale_mae.py.

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

### E11. What is published on tiles, windows and scales -- and where our edge error is actually addressed
*Looked up 2026-09-29, at the owner's request, after H55-H59 closed every
arrangement we tried. Cited sources checked; what each would mean HERE is
marked as reading, not finding.*

**1. Bigger context wins, and tile edges cost accuracy.** "Systematic
Evaluation of Image Tiling Adverse Effects on Deep Learning Semantic
Segmentation" ([PMC7020775](https://pmc.ncbi.nlm.nih.gov/articles/PMC7020775/)):
a U-Net on SpaceNet-Vegas 650 px images scored F1 0.748 on 128 px tiles, 0.803
on 256, 0.838 on 496 and 0.847 on the whole image -- the whole image best;
the gains shrinking to almost nothing by 496 px (about three-quarters of the
width, ~150 m of ground at their ~30 cm), then flat to the whole. (Written
earlier as "about half the image", which was loose: the owner asked whether
that meant halving images is better. It does not -- bigger was never worse.)
Disagreements concentrate on object borders, and even a
one-pixel shift of the input changes them. Authors: use the largest tile that
fits, whole images when possible. **Reading for us:** consistent with H55/H59
-- 6 cm blocks give each patch 27 m of context against the whole lot's
whole lot, and they lost.

**2. Combining scales works when the network LEARNS, per location, which
scale to trust.** Tao, Sapra & Catanzaro, "Hierarchical Multi-Scale Attention
for Semantic Segmentation" ([arXiv 2005.10821](https://arxiv.org/abs/2005.10821)):
predictions at different scales fix different failure modes, and an attention
head learns to favour the right scale for each. GLNet, Chen et al. CVPR 2019
([arXiv 1905.06368](https://arxiv.org/abs/1905.06368v1)): a global branch on
the downsampled whole image and a local branch on full-resolution crops,
sharing features both ways, on aerial images up to 30 MP. **Reading for us:**
this is what S17 was reaching for, and it matches H55's "the blocks and the
whole lot are right on DIFFERENT lots". Our both-scales stacked frozen
features into a three-layer decoder trained on 55 lots; both papers train the
fusion end to end on thousands of images. Whether 55 lots can teach a
per-location choice is not known.

**3. The error we actually have -- a thin band on the true edge (H53) -- is
addressed by edge refinement, not by tiling.**
- PointRend, Kirillov et al. CVPR 2020
  ([paper](https://openaccess.thecvf.com/content_CVPR_2020/html/Kirillov_PointRend_Image_Segmentation_As_Rendering_CVPR_2020_paper.html)):
  re-predicts only the uncertain points along a coarse mask's boundary, at
  high resolution, iteratively; crisp borders where others over-smooth.
- FeatUp, Fu et al. ICLR 2024 ([arXiv 2403.10516](https://arxiv.org/abs/2403.10516)):
  raises a ViT's 16-px-patch features to the input's own resolution with an
  upsampler guided by the photograph (joint bilateral upsampling), keeping
  their meaning; gains in segmentation without retraining the backbone.
  AnyUp ([arXiv 2510.12764](https://arxiv.org/pdf/2510.12764)) is a 2025
  follow-up that works across backbones.
- Boundary losses (e.g. [arXiv 1905.07852](https://arxiv.org/pdf/1905.07852)):
  a loss term that penalises boundary misalignment, which Dice / cross-entropy
  barely do; shown on remote-sensing buildings.
**Reading for us:** our backbone sees 16 px patches -- at 896 px over a lot,
1-5 m of ground each -- and the decoder answers at that grid before it is
resized to the 15 cm scoring grid. Tiling tried to shrink the patch by
shrinking the ground per image, and cost context (point 1). These methods
keep the whole-lot context and sharpen only the edge, which is where H53 put
the error. H54 (colour edges) was a crude hand-made version of this; it did
not pass, which says the crude version was not enough, not that the idea is
wrong.

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

### S12. We may be telling Scale-MAE the wrong scale (found 2026-09-27, checking the setup at the owner's request)

**What is established** (E2's correction): pretraining fed the encoder a
relative scale of about 2.2-5.0; we pass metres a pixel, 0.07-0.10. The
encoder builds its position encoding by multiplying each patch's position by
that number, so ours are compressed far past anything it trained on. Nothing
errors; the features do move with it (the extractor's check), which proves
the number arrives and nothing about whether it is the right number.

**What is NOT established:** that this costs accuracy. Arguments both ways,
neither measured here:
- For a cost: an encoding outside the training range is a textbook way to
  get worse features without an error. H4's 896 beating 1280 is at least
  consistent with it (a bigger picture at the same `res` spans still less of
  the range the model knows), and H22 found 10 cm windows no better than
  squeezing whole, which a mis-scaled model would also produce.
- Against: the decoder is trained on whatever comes out, and a consistent
  distortion applied to every lot may be learnable. The eye-alone numbers
  already beat colour (H3/H4).

**MEASURED 2026-09-27 -- H52: x5, x10 and x25 are all WORSE than x1
(metres a pixel) on THE PLAN's row, by 1.4 to 2.6 points lot by lot. x1
stands; this theory is closed.**

**The test (launched 2026-09-27):** the same model told 5x, 10x and 25x the
metres a pixel (`model: scalemae-large, res xN` in workflow 14; 0.1 m ->
0.5, 1.0, 2.5), each against the three H50 unfused runs (x1) with workflow
24. Not argued further until that is in.

**The owner's other two questions, answered here so they are not re-asked:**
- *Padding teaches it woodland, roads and farmland.* Not in this setup: the
  backbone is frozen (it learns nothing from our lots), and the decoder's
  loss gives ground outside the lot line weight 0, so nothing outside the
  line is taught as lawn or as not-lawn. What padding does do: it is context
  every patch's features are computed with, the same at test time as in
  training, and it costs compute. Whether blanking it helps or hurts (the
  segmentation literature mostly finds context helps) is a cheap test and
  is not run yet.
- *One model should see all maps minus a few for testing.* That is what the
  folds are: each fold trains a fresh decoder on every lot except the held-
  out group, so every lot gets scored by a decoder that never saw it or its
  neighbours. The folds only MEASURE the recipe; the model that would ship
  (`publish`) trains once on all lots. "Make them compete, keep the best,
  train it more" is model selection, which is what comparing settings is;
  picking a winner by its score on the same lots it is then reported on is
  the trap the protocol exists to avoid.

### S13. Every lot in the same-sized blocks at one ground resolution (the owner's, 2026-09-27)

**CLOSED 2026-09-28 by H55: neither 6 cm nor 10 cm passed the screen.**

**The idea (owner):** instead of squeezing each lot into one 896 px pass
(5.4 to 33.5 cm a pixel, so a backbone patch of 0.9 to 5.4 m, set by how
big the frame is), read every lot in standard blocks that show the same
ground at the same pixels, overlapping a little, and skip the padding
(which is how "A", cutting the padding of diagonal lots, is implemented:
blocks that do not come within 8 m of the lot are never read, so no
rotation is needed). **Built** (`windows: tiles` in workflow 14;
TILE_MPP 0.06, TILE_SIZE 448 in tools/extract_features.py). The owner's
numbers were a starting point to be refined; refined to: **6 cm a pixel,
448 px blocks = 27 m, kept middle 17 m, 5 m of context past it each side**
(TILE_OVERLAP_M; the first launch used 3 m and was stopped -- a patch near a
block edge should see well past it). A patch is 0.96 m on every lot. The
photograph (~10 cm) is enlarged 1.7x to get there: no new detail, but an
answer every 0.96 m instead of every 1.6 m; past ~2x (5 cm) there is little
left to gain. **Control, `tiles 10 cm`:** the same blocks at the
photograph's own resolution (45 m, 1.6 m patches) -- separates "every lot
read at one scale" (a 3x3 decoder step is 4 m on one lot and 16 m on another
today) from "finer patches". **Why it might help:** H53 -- the error on lawns
the detector gets right is almost all a half-metre band along the edge,
and the owner judges the ~1.5 m patch broadly responsible. **Why it might
not:** a 27 m block is less context than a whole lot, and H4 once found
896 beat 1280. **Bar, before the run:** one seed screens it against H50's
fused runs (the main set-up); worth confirming with seeds 8 and 9 if THE
PLAN's median paired change is below zero with more lots better than worse;
adopted only under the protocol's full bar.

### S34. What the flips and quarter turns are worth, before trying more augmentation (owner, 2026-10-09 -- MEASURED: NO DIFFERENCE, H91; flips stay on)

**The owner's question.** A paper with a similar task stretched a small
set of maps with augmentation: crops, flips and turns, resizing, colour.
Could we? The decoder already gives every training grid one of eight
orientations at random (flips and quarter turns); the backbone is frozen
and its readings cached, so anything that changes pixels -- colour,
resizing, crops -- means running the backbone again for each copy. Before
paying for that, measure what the augmentation we already have is worth;
H13's caveats called it "a guess, not a setting anyone swept".

**The trial.** Workflow 14 `refiner_trial: no flips`: THE PLAN's decoder a
second time over the same features, seed and place folds, with every grid
as drawn (`FLIPS=0`, tools/train_decoder.py). The random draws are still
made, so shuffling, dropout and the refiner's crops are the same and only
the orientation differs (tools/flips_test.py). Row "no flips", read
against THE PLAN's own row of the same runs with workflow 24, three seeds
(7, 8, 9), the locked 81, free runner.

**How it will be read, before the runs.**
- Removing flips HURTS (THE PLAN better on most lots, interval clear of
  zero): augmentation earns its place at this size, and colour jitter --
  the one most relevant to H89's contrast and season -- is worth a run.
- NO DIFFERENCE: geometric augmentation buys nothing measurable at 81
  lots, and more of the same kind is unlikely to; colour stays an open
  question, weaker for it.
- Removing flips HELPS: the orientations do harm somewhere (shadows fall
  one way in every photo; turning a grid puts them where no photo has
  them), and that would be worth knowing in itself.

### S33. Some inferred lawn is a guess, and a guess should not be taught (owner, 2026-10-08 -- BUILT, NOT MEASURED)

**The owner's point.** The hidden ground on C29 was marked inferred as the
rules say, and so is every area under a tree that had to be guessed at; but
the owner's own trace of C29 would have been "150 sq ft rather than 870". Since
H78 THE PLAN teaches every inferred mark as lawn, so a guess like that is
taught as fact. Rejecting the map was turned down (the seen part is sound),
and an "unsure" status was turned down (it is the inferred part that is unsure,
not the map).

**What is built.** Two things, neither of which changes any run until used:

- A per-map mark, `corpus.inferred_doubt` (schema and migration), set on the
  console card beside the canopy grade: "Teach it" / "Don't teach it". With it
  set, workflow 14 writes the id to `inferred-doubt.json` (sent to Modal with
  the lidar) and `train_decoder.py` grades that lot on seen ground only --
  exactly as every lot was before H78 -- while the rest stay taught under
  trees. The decoder's log says how many, and which. No mark set yet, so
  every run so far, and the next, is unchanged.
- `measure: seen` on workflows 24 and 33: the comparison or the hardness
  report judges every lot on its seen ground (`seen` in lot-results, the
  per-lot figure H78's scoring already splits out), leaving the inferred ground
  out of the figure entirely. A lot with no inferred marks reads the same
  either way; one from results older than the figure drops out. Default is
  the whole-lawn error, as always.

**What is NOT claimed.** Whether un-teaching a guessed lot helps, or whether
the seen measure ranks settings differently from the whole-lawn one, is
unmeasured. The seen measure is the fairer reading of a lot like C29; it is
also blind to the inferred ground THE PLAN is supposed to get right since
H78, so a setting cannot be adopted on it alone -- the protocol's bar stays
on the whole-lawn error, and `seen` is a second reading beside it.

### S32. Is it the county photo or the lot? (2026-10-08 -- design 2 MEASURED, H90: not a want of county examples; design 1, the live split, still open; PAIRS ABANDONED 2026-10-09)

**Pairs abandoned (owner, 2026-10-09: "I don't want to do the dual map
thing anymore. It's too confusing and there's been too many complications.
That issue with the rebank was pretty scary. From now on, we're just going
to have 1 map per corpus entry.")** Everything below that needed a second
outline or a second photo of the same lot -- the paired traces, `PHOTOS=both`,
the county page's verdicts -- is closed. A corpus entry has the one photo it
was drawn on and the one outline. The county photo stays as a LIVE source to
draw on; nothing is banked beside a map. Design 1, the live split of
workflow 7 by `image_provider`, needs no pair and remains the way to ask the
question.

**Why (H88):** the 12 county-photo lots score 55% against 19% for Mapbox
lots, and the county photo is now the default for most addresses, so most
live detections run on one. Whether the photo or the lot is to blame decides
whether the county default should stay.

**Withdrawn (owner, 2026-10-08: "the photos don't line up perfectly"):**
scoring the 12 county-drawn outlines on the Mapbox photo of the same frame.
The ground lines up to about half a metre (H64), but roofs and trees lean
differently by metres (H63) and the owner's own experience is that a lawn
outline drawn on one photo does not fit the other. So that test measures the
misfit at least as much as the model, and a "Mapbox is worse" result would
not mean the lots are hard. The clean version needs an outline drawn on EACH
photo of the same lot; only 3 approved maps have both (B08, C59, C35, all
drawn on Mapbox first), too few.

**H89 answered part of it:** contrast (the lawn against the rest of the
lot, in that photo) and how much of the lot is lawn predict the error within
each source, and every county photo in the set is low- or middle-contrast.
What is left open is whether the decoder would do better on county photos
with more of them to learn from -- design 2 below.

**Two designs that answer the rest:**

1. **Live use, split by photo (cheap, no misfit, slow).** Workflow 7's
   live-release score (H87) already compares what the release drew with what
   the person finished; both are on the photo the AI read, so there is no
   misfit. Split it by `image_provider`. Needs finished, approved maps on
   county photos drawn by the current release -- the county default means
   they accumulate from real use.
2. **Does county training data help county lots? (free runner, one run.)**
   Train on the 69 Mapbox lots only and score the 12 county lots, against the
   usual folds where the other 11 county lots are in training. A clear gain
   from having county examples says the county look is a separate thing the
   decoder has to learn (the B case in the owner's question) and 12 is not
   enough of it; no gain leaves "the lots are hard" and "12 is too few to
   matter" both open. Lot held fixed, photo held fixed; only the training
   set moves.

**Paired traces (owner, 2026-10-08: "I can do that, slowly"):** the owner
will trace the same lawn on both photos. Storage for both directions exists
since 2026-10-08: a Mapbox-drawn map's county outline in
county_imagery.shapes (the county editor, as before), and a county-drawn
map's Mapbox outline in county_imagery.mapbox_shapes with Mapbox's picture
of the frame banked as mapbox_image_key (/#review=<id>&photo=mapbox from
/county.html). DECIDED: a pair is NOT a duplicate -- the same ground under
two appearances, each with its own correct outline, is exactly the B case --
and it goes into training as a SETTING TO MEASURE (PHOTOS=both, not built
until pairs exist), with both versions of a lot held out together (place
folds already group by position, and a pair shares one). Until it passes
the bar, training keeps one version per lot. With pairs, the exact test:
each photo against the outline drawn on it, same lot.

### S31. Chasing H85's parking-lot gain with less of the middle layers (owner, 2026-10-07 -- MEASURED: NONE PASSES, H86)

**Why (owner: "do a little chasing of the parking lot gains"):** H85's middle
layers cut B20 73 -> 48 and B19 79 -> 65 but cost elsewhere (C29, C80) and
came out even overall. If the gain is texture and the cost is 512 more
inputs to 81 lots, less of it may keep the first and shed the second.

**Three arms, one set of runs** (workflow 14 `layers: variants`, cached
middle layers, `WHOLE_SLICE` picks channels): **layer 8** (block 8 only,
256), **layer 16** (block 16 only, 256), **layers small** (both, 64 each --
the first 64 of each projection is itself a 64-number random projection).

**The test, written before the runs:** seeds 7/8/9, `lawns: locked`, free
runner, each arm against "decoder, edge refined + stage 3, span, lidar veto"
of the same runs, the usual bar; B19/B20 reported but not the bar. Three
arms tried at once means one may pass by luck -- a pass is re-run on fresh
seeds before anything ships.

### S30. Read Scale-MAE's middle layers as well as its last (owner, 2026-10-07 -- MEASURED: NO OVERALL GAIN, H85)

**Why (owner, from SegFormer's All-MLP decoder):** that decoder's strength is
mixing descriptions at several scales, which SegFormer's encoder hands it.
Scale-MAE is a plain ViT: one grid, and the decoder has only ever read its
LAST layer. Earlier blocks keep finer, more local detail (texture, edges);
later ones what a place is. Using several layers is how plain-ViT
segmenters (ViTDet, DPT) get multi-scale features. An All-MLP decoder on one
layer would be a simpler decoder than ours, so the transferable idea is the
layers, not the decoder.

**Built:** extract_features.py `MULTI_LAYERS=8,16` keeps the outputs of
blocks 8 and 16 (of 24) on the same pass, each squeezed 1024 -> 256 by a
fixed random projection, written to `feats-multi`; the decoder stacks them
beside the last layer (FEATURES_WHOLE, identity resample). Workflow 14
`layers: compare` trains THE PLAN once more on all three, row "decoder,
middle layers + ...". Lots read in windows get zeros there (none with
`windows: off`). multi_layers_test.py checks the projection, the grid and,
in CI, the hook on a real ViT.

**Why it might not help (speculation):** H58/H59 (two scales by arrangement)
found nothing; the decoder already gets the photo's own pixels through the
refiner; 512 more inputs to 81 lots is more room to overfit; the random
projection loses some of each layer.

**The test, written before the runs:** seeds 7/8/9, `lawns: locked`, free
runner, against "decoder, edge refined + stage 3, span, lidar veto" of the
same runs; the usual bar. If it wins, the live server needs the same layers
read (alpha_infer), which costs nothing extra on the GPU (one pass).

### S29. How many epochs (owner, 2026-10-07 -- MEASURED: 30 STAYS, H84)

**Why (owner's question):** every decoder trains for 30 epochs, a number set
on 2026-09-24 at 32 lots for the first decoder (H25) and never tested since.
The corpus is now 81 lots, so an epoch is longer, and the decoder now has the
refiner, the canopy input and teaching under trees.

**The test, written before the runs:** workflow 14 `refiner_trial: epochs`,
seeds 7/8/9, `lawns: locked`, free runner: THE PLAN at 15 and at 60 epochs
beside the usual 30, same features and folds. Each read with workflow 24
against "decoder, edge refined + stage 3, span, lidar veto". A change of
default needs the same bar as everything else (sign test under 0.05, more
lots better, interval at or below zero, untuned not the other way); if
neither passes, 30 stays. Training only: no change to live cost.

### S28. Average three decoders instead of trusting one (overnight 2026-10-07 -- BUILT, PASSES: H83, NOT RELEASED)

**Why:** seed alone moves a run's median by up to 1.7 points (THE PLAN's row,
H81/H82: 20.8 / 22.5 / 22.0), as large as most changes measured here. An
average of decoders trained from different seeds is the standard way to take
that noise out of the answer itself, not just out of the comparison. The
decoder and refiner are small next to Scale-MAE, which runs once either way,
so three of them would add little to the live GPU's time (to be measured
before any release; cost is the owner's second goal).

**Built:** `ENSEMBLE=k` in train_decoder.py trains k decoders (with the
refiner) per fold from seeds SEED+f, +1000, +2000 and averages their answers
before stage 3. Workflow 14 `refiner_trial: average of 3`, row "decoder,
averaged x3 + ...". Not yet wired for a release.

**Why it might not help (speculation):** the three may make the same mistakes
(same features, same lots), so the average only smooths the edge band.

**The test, written before the runs:** seeds 7/8/9, `lawns: locked`, free
runner, against "decoder, edge refined + stage 3, span, lidar veto" of the
same runs. Adopt-worthy only if the sign test is under 0.05 with more lots
better, the interval on all 81 at or below zero, and the untuned 49 not the
other way. Nothing is released from it without the owner.

### S27. Aiming the refiner: hand it the photo's edges, and let a wide reach act only where the decoder is unsure (owner, 2026-10-07 overnight -- BUILT, MEASURED: NO GAIN, H82)

**Why (owner):** the misses that look easy are 2-6 m out along strong edges
(driveways, houses, roads) and softer ones (woodlines). H80's plain wide
reach saw them but also moved edges that were right, and ate into confident
lawn (B28's mid-lawn black, though that picture also mixed in other changes,
see the owner's reading above).

**Built (tools/edge_refine.py):**
- `REFINE_EDGES=1`, row "decoder, hard edges ...": two fixed input channels,
  the Sobel strength of the brightness at 15 cm and over a ~0.75 m blur.
  Nothing learned; the refiner no longer has to discover from 81 lots what a
  kerb or a woodline looks like. Normal reach.
- "decoder, wide gated ...": the same edges, the wide reach (31 cells, ~4.6 m),
  and `REFINE_GATE=1`: its change is multiplied by sigmoid(level - steep *
  |decoder logit|), both learned, so it can move ground the decoder is unsure
  of and barely touch ground it is confident about.

**Why it might not work (speculation):** a strong edge is often not the
lawn's (a patio inside the lawn, a shadow); the gate may learn to stay shut
and change nothing; three seeds on 81 lots may not separate a small effect.

**The test, written before the runs:** workflow 14 `refiner_trial: compare`,
`lawns: locked` (81, `05cs4ud`), free runner, seeds 7/8/9 (37563074383,
37563158493, 37563241262). Each arm read with workflow 24 against "decoder,
edge refined + stage 3, span, lidar veto" of the same runs. **Adopt-worthy
only if** the sign test is under 0.05 with more lots better, the interval
on all 81 is at or below zero, and the untuned 49 do not go the other way.
The same runs also give the live refiner against its true twin (THE PLAN's
decoder without it), a second extraction beside 37556372070 / 37556456369 /
37556539907. Nothing is released from this without the owner.

### S26. A standard segmentation head instead of our own small decoder (owner, 2026-10-06 -- PARKED UNTIL 150 MAPS, owner 2026-10-07; was 500)

**The question (owner):** is our own four-layer decoder (and the edge
refiner beside it) really a better fit than a named, published design?

**What was said, and how sure it is:**
- Object detectors such as Deformable DETR and DINO (the detector, not
  DINOv2) are the wrong kind of tool: they find countable things with boxes,
  and a lawn is a region, a per-point answer (semantic segmentation). That is
  a statement about what they do, not a measurement here.
- The fair rivals are standard segmentation heads over the same frozen
  Scale-MAE features: **UperNet** (the head in Scale-MAE's own paper) and
  **Mask2Former**. NEITHER HAS BEEN MEASURED HERE. The case for starting
  small (80 lots against heads with millions of weights built for thousands
  of images; minutes on the free runner; H53 says most of a good lot's error
  is the edge band) is a reason, not a result.

**Parked until the corpus has 150 approved maps** (owner's choice; 500 until 2026-10-07), when a
bigger head has enough to learn from. tools/milestones.js then says so at
the end of every deploy log, and train_decoder.py at the start of every
training run's. **The test, when it comes:** UperNet first, as one more
decoder over the same features, seeds and folds as THE PLAN's, scored lot by
lot with workflow 24; Mask2Former only if UperNet shows something.

### S25. A wider-reaching edge refiner (owner, 2026-10-06 -- BUILT, MEASURED WORSE: H80)

**The owner's picture (a leaf-off county lot):** the outline stops 2-6 m
short of, or runs 2-6 m past, edges that are plain to the eye: a hard
woodline, and the kerb of a driveway, with fairly even colour on each side.
The owner circled those as the refiner's easy wins; the circles are where
to look, not the outline it should draw.

**Why the refiner as built cannot reach them (a fact about the code, not a
measurement):** its convolutions (3x3, then dilations 2 and 4) let a cell
see 7 cells, about 1 m, either side. A cell 3 m inside the woods cannot see
the woodline, so the refiner has nothing to move it by. H60's gains are the
half-metre band (H53) it can see.

**Built:** `REFINE_REACH=wide` adds two layers dilated 8 and 16, so a cell
sees 31 cells, about 4.6 m, either side (refine_test.py checks both reaches
by gradient). Everything else the same: inputs, crops (17 m squares, mostly
on traced edges), loss, training beside the decoder. Workflow 14
`edge_reach: compare` trains it over THE PLAN's features, seed and folds as
row "decoder, wide edge + stage 3, span, lidar veto"; `edge_reach: wide`
makes a release with it. The live release records its reach (`refineReach`)
and alpha_infer.py builds the matching net; v2 loads unchanged.

**Why it might not help (speculation):** more reach is also more room to
follow a colour edge that is not the lawn's (a shadow, a mulch bed, H54),
and 80 lots is not many to learn the difference from. The pictures' navy
and black layers on the drawn row show what it moved.

**The bar (written before the runs):** three seeds (7/8/9), `lawns: all`,
free runner, read with workflow 24 against "decoder, edge refined + stage
3, span, lidar veto" of the same runs. Adopted if the sign test is under
0.05 with more lots better than worse and the paired interval on all 80 at
or below zero; not if the untuned 48 go the other way.

### S24. Teach the decoder what is under a tree, and give it the lidar by return (owner, 2026-10-05 -- BUILT, ON TRIAL)

**The owner's question.** "Would it be able to solve all of this simply by
giving it the depth measurements? Then we don't need to classify trees at
all ... simply letting scale Mae figure out the scenarios where there's
likely to be grass (which it learns ... from the markings on lawn maps we
already have)." And the standing rule for this trial: "the lawn outline is
the only thing that matters ... If 2 fully equivalent paths exist, ship the
cheaper option and bookmark the more expensive ... if one is measurably
better, that's the one."

**What was true before it (checked, not recalled).**
- Scale-MAE sees the photo only.
- The fused inputs (S11, H48, H50) already give the decoder lidar
  height, ground-return share and return count per patch. They were
  measured level with no fusion (H50).
- Nothing teaches it what is under a tree. Inferred lawn and canopy over
  traced lawn carry NO weight (H17; train_decoder.py `read_lawn`), and
  stage 3's rules decide there.

**Built.**
- `UNDER_TREES=1` grades inferred lawn and canopy over traced lawn as lawn.
  Canopy the tracer drew no lawn under was already a weighted not-lawn,
  and stays one.
- `FUSE_RETURNS=tree-lidar` adds four fused numbers a patch: the share of
  last returns reaching the ground, the share of split pulses, the
  first-to-last spread, and a flag. All are from tools/tree_lidar.py and
  hidden with the lidar in dropout.
- Workflow 14 `decoder: fused + edge + trees` trains THE PLAN's two decoders
  and two more over the SAME features, seed and folds:
  - **"decoder, taught under trees"**
  - **"decoder, taught under trees + returns"**

  Both are fused, with the edge refiner. They are scored ALONE (stage 3
  would overwrite the very cells they were taught) and drawn as the row on
  trial.

**The test, written before the runs.** Lawns `all` (80), place folds, seeds
7, 8 and 9, canopy on lawn. One run carries every arm, so H28's extraction
drift cancels.
- Read lot by lot against THE PLAN's row of the same run, pooled over the
  three seeds (workflow 24).
- **Adopt** a taught decoder if it beats THE PLAN's row lot by lot with the
  interval on the median change below zero.
- **Equivalent** (interval spans zero): the taught decoder alone is the
  CHEAPER path, because it needs no stage 3, so ship the cheaper one by the
  owner's rule. But the "+ returns" arm costs a second point download, so
  between the two taught arms, equal means the one without returns.
- **Watch** the inferred column (where it was taught) and the woods lots
  (Kent 22,481, the edge creeping into trees in H27).

**Risks, said in advance.**
- The inferred marks are leaf-on only, with fuzzy edges, so it learns
  them fuzz and all.
- 80 lots is small.
- Stale lidar (B28, H40) is in the training data.

### S23. How much sun a spot gets, as evidence for lawn under trees (owner, 2026-10-03 -- IDEA, NOT BUILT, APPROACH OPEN)

**The idea (owner).** Sites exist that map sunlight and shade over a
property from the sun's path and the 3D shape of what surrounds a spot.
Grass needs a certain amount of sun; under enough shade it does not grow.
So a measure of how much sun each part of a lot receives over the growing
season could tell stage 3 where lawn plausibly continues under a canopy and
where it cannot -- the lawn-tree-or-woods question H34-H37 tried to answer
from height and clump size alone.

**What exists to build on.** The per-lot lidar the pipeline already reads
(heights, roofs, canopy), the tree-canopy model, the lot's location and
date. Nothing about the method is decided: **the owner expects the best
approach to differ from the obvious one**, so none is recorded here as the
plan.

**Known complications, whatever the method.** Lidar is usually flown
leaf-off and can be years old (H40: one lot's trees are gone); point
density varies by county; grasses differ in how much shade they tolerate,
so any threshold is a range, not a line.

**How it would be judged.** As every stage 3 idea is: by the INFERRED
column on the corpus, before anything reaches the app. Speculation until
then. A sun map of a yard may also be worth showing people on its own
(where grass will and will not take), which is a product question, not a
detector one.

### S22. See-through canopy on leaf-off county photos: let stage 1's answer stand under bare crowns (owner, 2026-10-03 -- BUILT, OFF, NOT MEASURED)

**The worry (owner).** County photos are often flown leaf-off. The tree model
still marks a bare crown as canopy, correctly, and stage 3 then clears what
stage 1 saw there and guesses (span, reach, bridge) -- when the grass under
the branches is plainly visible. Guessing cannot be as good as seeing.

**What is established and what is not.** H30 measured clearing stage 1
under canopy as worth 3.6 points on visible ground -- on a corpus of
leaf-on Mapbox photos, where stage 1's opinion under a tree was untrained
and wrong. Nothing has measured stage 1 under bare branches. It is still
untrained there (canopy carries no weight in its training), so it may read
the grass well, or it may trip on branch shadows and leaf litter.

**Built (tools/stage3.js), three modes, `off` in serving:**
- `off` -- every canopy cell is hidden ground, as since H30.
- `colour` -- a canopy cell whose photo, averaged over about a metre, is
  not green (excess green under 0.03, not dark shadow) is bare: stage 1's
  answer stands there and the rules leave it alone. Decided per cell, so an
  evergreen in a leaf-off photo stays canopy. **Known blind spot:** green
  grass showing through bare branches reads green and is taken for leaves,
  so this only catches bare crowns over dormant or brown ground. Autumn
  colours would read bare; untested.
- `trust` -- every canopy cell keeps stage 1's answer; the rules only add.

**Leaf-off is a property of the photo, not its source (owner, 2026-10-03):**
some Mapbox photos are leaf-off and some county photos leaf-on; county ones
are only more often leaf-off. So the table groups lots by what the photo
looks like -- "looks leaf-off" is a lot whose canopy reads at least 30% bare
under the colour rule -- with the county group kept as a weaker proxy, and
lists each lot's bare share so the grouping can be checked by eye. The colour
rule's blind spot (green grass under bare branches) means it UNDER-counts
leaf-off lots whose grass was already green; the list is how to catch that.

**How it is read.** Workflow 14's stage 3 output prints a SEE-THROUGH
CANOPY table at THE PLAN's cell (span 8 m, reach 1 m, bridge over 180°):
each mode over every lot, the lots that look leaf-off, and the county-photo
lots, headline / seen / inferred. Canopy over traced lawn is scored as inferred, so the
inferred column is the ground under the trees. Switching serving on is one
line, `SEE_THROUGH` in tools/serve-alpha.mjs.

**Bar, before the run.** Adopt a mode only if, on the lots that look
leaf-off, it lowers the inferred column's median and the headline, with more
lots better than worse, and does not raise the headline over every lot by
more than a point. Fewer than about 15 leaf-off lots is too few to read; say
so rather than read it.

**A fourth mode, `evergreen` (owner, 2026-10-04: "evergreens are unlikely
to have grass under them").** `colour`, plus: on a photo that looks leaf-off,
the canopy that did NOT read bare (still green, or too dark to see into) is
taken for evergreen, and stage 3 neither keeps stage 1's lawn there nor
fills it (stage3.js evergreensOf). A summer photo is left alone: there every
crown is green. SPECULATION, with the colour rule's blind spot reversed:
green grass under bare branches reads green and would be lost. From the
first run with it, `colour` and `evergreen` are also scored as full rows
beside THE PLAN's ("..., see-through colour" / "..., see-through
evergreen"), so their lot-by-lot figures are in lot-results.json, and the
pictures are drawn for the evergreen row (TRIAL_ROW).

**The first run (owner, 2026-10-04), its purpose and its limits, written
before it ran.** One run, seed 7, `lawns: all`, `not_lawn: on` (the
not-lawn-only maps are all ponds, per the owner), `photos: mapbox`, free
runner. The owner asked for raw accuracy and the look of the outlines, NOT a
decision: no control run. It is read lot by lot against run 36601001355
(the S20 A run whose configuration the alpha release uses, also seed 7, all
lawns) on the lots both runs scored. What it can say: how THE PLAN does on
the bigger corpus, and how the three canopy modes compare on the lots that
look leaf-off. What it cannot: whether any mode should be adopted -- that
needs S22's bar (15+ leaf-off lots, more better than worse) and more than
one seed; two things changed against the comparison run (more lots,
pond examples on), so a difference from it is not attributable to either.

**Feeding it (owner, already doing it).** On leaf-off photos, grass seen
under a bare tree is traced as ordinary lawn, not marked inferred. If a mode
passes, the next step is letting training weight those cells instead of
ignoring all canopy.

### S21. Learn from the PAIRING: weight training toward where the detector's own outline was corrected (owner, 2026-09-30 -- BUILT 2026-10-06, MEASURED WORSE: H79)

**Built 2026-10-06** (owner: "most, or all, of the 25 newest maps are
corrections ... try running them while they're still useful"). Workflow 14
`corrections: on` dumps the live release's own outline on each lot it drew
(`model_version` set) as `<id>-detected.png`. A decoder like THE PLAN's
then trains with the cells where the finished lawn disagrees with it
weighted 3x (`CORRECTIONS_WEIGHT`), scored as "decoder, corrections
weighted + stage 3, span, lidar veto". The same runs carry `not_lawn: on`
(the pond maps), plus a third decoder without them ("no pond maps",
`SKIP_EXAMPLES`), so the ponds' effect is measured in the same runs too.
The test is lot by lot against THE PLAN's row (with ponds), three seeds.
The ponds are read as THE PLAN vs "no pond maps".

**What.** Every finished map already stores both halves of a correction:
`detected_shapes` (what the AI drew) and `shapes` (what the person left). Since
2026-09-29 it also stores `model_version` (which release drew it). Training
today uses only `shapes`, as truth, the same way as a hand-traced map. The
original outline is read only by the scorer, as the SAM baseline. So the
decoder is never pointed at WHERE it went wrong. The owner's point
(2026-09-30): zeroing in on its mistakes was the reason for recording
corrections.

**The proposal.** Up-weight the loss on cells where the detector's outline and
the corrected one disagree, the "error band", in train_decoder.py. Every other
cell keeps its ordinary weight. Use it only on rows whose `model_version` is a
trained-model release: a SAM outline's mistakes are SAM's, not this decoder's.

**Why it might not help (keep it speculation until measured).** The residual
error is already concentrated in the edge band (H53), which the edge refiner
(H60) targets. Extra weight there may just re-weight the same pixels. With few
release-drawn corrections so far, a handful of lots would dominate. H57 is the
warning: extra "helpful" training signal measured worse.

**The test.** THE PLAN with and without the error-band weight. Same seed, same
folds, lawns all, free runner. It only becomes meaningful once there are
enough release-drawn corrections, some dozens, to weight.

### S20. The not-lawn outlines again, fewer of them, under THE PLAN (owner, 2026-09-29)

**The owner:** "we abandoned the outlines, but I don't think that was the
right move, possibly we just gave it the wrong number of outlines." H57
trained ~90 examples beside 55 lots (more not-lawn frames than lawns) on the
old plain decoder, and was worse (+3.8). Since then THE PLAN changed (the
edge refiner, H60), and B19 / B20's refined answers took parking lots.

**The runs:** two, identical but for `examples` -- THE PLAN's settings
(`decoder: fused + edge`, `canopy: on lawn`, `windows: off`, `lawns: all`,
seed 7, free runner): A `examples: off`, B `examples: some` = at most 4
frames of each of the 8 kinds (EXAMPLES_PER_KIND; about 30), against ~90 in
H57. The decoder trains on them; the refiner does not (an example has no
scoring grid of its own to refine -- its frame is cropped to its outlines).

**Bar, before the runs:** THE PLAN's row, B against A. One seed a side is a
SCREEN (H50: a seed moves the median 2.5 points). Worth seeds 8 and 9 if the
median paired change is below zero with more lots better than worse;
adopted only under the full bar (sign test p < 0.1, the 95% interval below
zero, not worse on the lots approved since). Also reported: B19, B20 (the
parking lots), B16, B12 (the pond).

**Also from 2026-09-29, not run any more (owner):** the NAIP-CHM read, the
colour-edges row and its two layers, and the lidar-canopy and NAIP-CHM
picture layers. Code kept behind NAIP_CHM=1 / COLOUR_EDGES=1 /
LIDAR_CANOPY=1.

### S19. Keep the whole-lot reading; sharpen only the edge (proposed 2026-09-29 from E11; owner go-ahead, built and running the same day)
**The idea:** the arrangement question is settled for this backbone (H59) --
the whole lot wins on context. The remaining error is the edge band (H53),
and it is set by the 16 px patch grid, not by the arrangement. So: an
image-guided upsampler on the decoder's answer (joint bilateral upsampling,
the cheap core of FeatUp), or a PointRend-style second pass that re-decides
only the uncertain edge cells from full-resolution colour plus the coarse
features. Both run after the backbone, so with the cache (where-things-stand)
an experiment is decoder + scoring only, on the free runner. **Why it might
not work:** H54's colour edges were a similar idea and failed; the photo's
colour edge is not always the lawn's edge (shade, mulch beds). **Needs the
owner's go-ahead before it is built.**

**Owner's go-ahead 2026-09-29 ("give smarter edge refinement a shot"). Built
as the learned kind, not the hand-made kind:** tools/edge_refine.py, a
~20,000-weight net on the 15 cm scoring grid that sees the photograph's
colour, the decoder's answer and its last hidden layer (both stretched
exactly as to_photo stretches them; refine_test.py checks this to 1e-5),
and outputs a CHANGE to the decoder's logit, starting at zero. Trained
together with the decoder in each fold (not after it, so it does not learn
to correct a decoder that is overconfident on its own training lots), on
112-cell squares, 70% centred on a traced edge; targets are the trace cell
by cell. Workflow 14 `decoder: fused + edge` trains the plain fused decoder
and the refined one over the same features, folds and seed, and scores both.
The difference from H54: H54 re-decided the edge by a fixed rule from the
lot's colours; this LEARNS, from 55 lots of traced edges, when a colour edge
is the lawn's edge and when it is shade or mulch. Synthetic check only (a
clean ellipse, 9 lots): 4.4% -> 2.6% median; says the plumbing works, not
that real edges will move. About 2x a decoder's training time.

**Bar, before the runs (three seeds 7 / 8 / 9, `lawns: all`, folds by place,
`windows: off`, `canopy: on lawn`, `cache: use`, free runner):** A = "the
pretrained eye, decoder + stage 3, span, lidar veto" (the plain fused
decoder, THE PLAN's row in a single-decoder run), B = "decoder, edge refined
+ stage 3, span, lidar veto", same runs. Adopted if more lots better than
worse with a sign-test p under 0.1, the 95% interval of the median paired
change below zero, and not worse on the lots approved since. If it leans
better and misses, three more seeds (10 / 11 / 12) before deciding, as S18.
Also reported: B01, B29, B21, B05 (H53's near-all-edge lots, where it should
help if anywhere) and B20, B28, B04 (real mistakes, where it should not
matter).

### S18. Both scales, decided: six seeds a side, both sides on the GPU (2026-09-29)

**Why:** H58 leans better (27 / 16, -0.4) and misses its bar at three seeds,
with the two sides on different hardware. Written BEFORE the runs, so the
extra seeds are a pre-registered test and not a second look until it passes.
**Runs:** A = the whole lot on Modal (`windows: off`, `canopy: compare`,
fused, no examples) seeds 7-12 (seed 7 is 36488404436); B = both scales on
Modal (`windows: both`, `canopy: on lawn`) seeds 7-12 (7-9 are H58's).
**Bar:** A row "decoder, canopy on lawn + stage 3, span, lidar veto", B row
"the pretrained eye, decoder + stage 3, span, lidar veto"; adopted if more
lots better than worse with a sign-test p under 0.1, the 95% interval of the
median paired change below zero, and not worse on the lots approved since.
If not, both scales is closed and the whole lot stays. Also reported: B28,
B03, B20, B13.

### S17. Both scales: the whole-lot pass AND the 6 cm blocks, stacked for every lot (2026-09-28)

**The idea:** H55 found the 6 cm blocks and the whole-lot squeeze each far
better on DIFFERENT lots (B28 82 -> 28 and B03 72 -> 29 under blocks; B20
46 -> 122-136 and B13 20 -> 40 worse), the same lots at both block sizes,
and not by lot size -- so picking one reading per lot by a rule (S15) failed
(H56). This gives the decoder both at every cell and lets it learn which to
trust: the blocks' numbers and the whole-lot pass's, resampled onto the
block grid, side by side (workflow 14 `windows: both`; FEATURES_WHOLE in
tools/train_decoder.py; decoder_grid.onto_grid, checked in decoder_test.py).
**Why it might help:** neither reading has to be given up. **Why it might
not:** twice the numbers a cell for the same 55 lots is more room to
overfit, and a decoder that averages the two may land between them on both
kinds of lot.

**Bars, before the runs (three seeds, fused, 55 lots, folds by place,
`canopy: on lawn`, `examples: on` so it sits beside S16's runs):**
1. **Against the whole lot with examples, re-run on the same code** (the
   arrangement that stands; S16's own whole-lot runs trained on uncropped
   examples, see where-things-stand). **Added after H57 (examples lose):**
   both scales WITHOUT examples against S14's three runs, same bar -- the
   question S17 was really about:
   THE PLAN's row; adopted if more lots better than worse with a sign-test p
   under 0.1, the 95% interval of the median paired change below zero, and
   not worse on the lots approved since.
2. **Also reported, not a bar:** against S16's tiles with examples, and
   B28, B03, B20, B13 by name -- the lots H55 says the two readings split on.
   If both scales is level with the whole lot overall but takes B28 and B03
   without losing B20 and B13, that is what it was for, and it is said so.

### S16. The owner's not-lawn examples in training, under each arrangement (owner, 2026-09-28)

**The idea (owner):** public outlines of things that are certainly not lawn
-- ponds above all, then houses, driveways, car parks, roads, sidewalks --
photographed away from our maps, reviewed by the owner on /outlines.html
(drop, move, approve, reject), taught as "not lawn" and nothing else in the
picture. **Built** (workflow 14 `examples: on`; tools/not-lawn-examples.js
`frames`; tools/train_decoder.py): only keptOutlines() -- approved, the
outlines kept at review, moved as the owner moved them -- are graded 0;
everything else in an example is weight 0; the part under the tree model's
canopy is unseen; examples are trained on in every fold but never held out
or scored, and a fold leaves out any example within 2 km of a lot it holds
out. **Why it might help:** the pond (B12 and others) is one of a kind in
55 lots, and water is the most-approved class. **Why it might not:** a few
dozen frames of negatives against 55 lots of mixed labels can shift the
decoder's balance (pos_weight is computed over the training set) and push
lawn edges inward everywhere.

**Bars, before the runs (three seeds each, fused, 55 lots, folds by place):**
1. **The main question -- whole lot (`windows: off`, `canopy: compare`) with
   examples against S14's three runs without:** THE PLAN's row; adopted if
   more lots better than worse with a sign-test p under 0.1, the 95% interval
   of the median paired change below zero, and not worse on the lots
   approved since. **Also reported, not a bar:** the lots with water in them
   (B12 and any the owner names).
2. **Windows (`windows: on`, `canopy: on lawn`) with examples against S15's
   three runs without** -- the same bar; says whether examples help there.
3. **The arrangements with examples against each other:** tiles 6 cm
   (`canopy: on lawn`, three seeds) and windows, each against the whole lot
   with examples, same bar. Nothing is adopted from 3 alone unless 1 holds.

### S15. A MAXIMUM block size instead of a fixed one: small lots whole, big lots split (owner, 2026-09-28)

**CLOSED 2026-09-28 by H56: failed its bar (18 better / 28 worse; worse on the lots approved since).**

**The idea (owner):** "rather than a standardized size tile, just a maximum
tile size... small lots fit into 1 tile, but big lots get more." **This is
already built** as `windows: on` (tools/windows.py): a frame that fits one
896 px pass at the photograph's own ~10 cm (about 90 m) is read whole, as
today; a bigger one is read in overlapping 896 px windows at 10 cm. The
maximum is therefore ~90 m, set by the backbone's 896 px input at the
photo's native resolution -- smaller would mean enlarging past the photo or
cutting lots that fit. Measured once, 2026-09-24 (H22 retracted): within
1.5 points either way, on the old method (32 lots, leave-one-out, one seed,
unfused). **Never measured under the protocol.** Caveat written before the
run: H55's size check says the lots blocks moved were not the big ones, so
there is no measured reason to expect a gain; this is run because the
owner asked and it is cheap. **Bar, before the runs:** `windows: on`,
fused, seeds 7/8/9, THE PLAN's row against H50's three fused runs: more
lots better than worse with a sign-test p under 0.1, a 95% interval for
the median paired change below zero, and not worse on the lots approved
since. Otherwise closed.

### S14. Colour on the edges only (the owner liked it, 2026-09-27)

**CLOSED 2026-09-28 by H54: failed its bar on every part.**

**The idea:** colour cannot find a lawn (dormant grass, shade), but once
the decoder has found it, colour at 15 cm can say which side of the line a
cell falls on. **Built** (tools/colour-edges.js, 4 checks): per lot, a
logistic model on the 14 colour/texture numbers, fitted to that lot's own
confident ground (over 1.5 m inside or outside the decoder's edge, inside
the property line, off the canopy), re-decides only cells within 1 m of the
edge, never under canopy, then a 3x3 majority pass; the lidar veto still
has the last word. Every run from now scores "THE PLAN's row, colour edges"
beside THE PLAN's row, so the comparison is within the same runs and seeds.
**Bar, before the run:** on THE PLAN's row versus the same row with colour
edges, across seeds 7, 8, 9: more lots better than worse with a sign-test p
under 0.1, a 95% interval for the median paired change below zero, and not
worse on the lots approved since. Then it joins THE PLAN.

## Rules for running and reading these experiments

**THE LOCKED SET (owner, 2026-10-06).** Tests run on `lawns: locked`, the
default in workflow 14: exactly the maps listed in tools/locked-lawns.json.
Maps approved while a test series runs wait outside it, so every run in the
series is on the same maps. Workflow 31 ("Let in the next batch of maps")
rewrites the list, when the owner says or when a series is finished; write
the new count and fingerprint in the run log when it moves. **First lock (2026-10-06, 20:18 UTC): 81 maps, fingerprint `05cs4ud`** --
the 80 of every run through H79 plus **C99**, approved by the owner between
11:20 and 18:10 UTC that day. The S25 runs (37509209045 / 37509342504 /
37509477275) have 81 frames, so they are on the locked set; every earlier
80-lot run (H75-H79, the version 2 release) is not. S25 compares within its
own runs, so its verdict stands; its medians are not comparable with H79's. The end of every
deploy log says how many are locked and how many are waiting.

- **HOW A DECISION IS MADE, FROM 2026-09-27** (owner: "get the most out of
  the training data"; "neighbouring lots leak into each other"). Four
  weaknesses in how every result above was read, fixed together:
  1. **Neighbours leaked.** Leave-one-out scored a lot with a decoder
     trained on the lot next door -- same photograph, same light, same
     grass. On the benchmark, 12 of 32 lots have another within 2 km (5
     neighbourhoods of 2-3). Full-corpus runs now hold out a NEIGHBOURHOOD
     at a time (lots within 2 km, single linkage) in 15 folds
     (tools/folds.py; workflow 14 `lawns: all`). Not by county: a lot still
     learns from its county across town, as the site will be used.
     (The frame's padding is NOT a leak: ground outside a lot's line has no
     weight in training. Its cost is resolution on big and diagonal lots.)
  2. **One seed per setting.** A seed moves a decoder about a point (H28),
     the size of several effects here. Each setting is now run 2-3 times
     with different `seed`, in parallel.
  3. **The headline median decided.** A median moves on a lot or two; the
     same lots compared under both settings do not. Decisions are read from
     workflow 24 (tools/compare-runs.js): per lot, the mean over a setting's
     runs; then wins/losses, the median paired change with a 95% bootstrap
     interval, and a sign test. (H48's 18-against-7 is p = 0.043; its 0.1
     on the median said nothing.)
  4. **Every rule was tuned on the frozen 32.** So workflow 24 also prints
     the lots approved since the freeze on their own -- the nearest thing to
     an untouched test -- and a decision should hold there too.
  The site's own model is still trained on every lot. Tables before this
  are leave-one-out on the 32 and are not comparable with runs after it.

- **Actions minutes are not a constraint (owner, 2026-09-27).** Run
  comparisons side by side, and repeat a run when noise is the question,
  rather than economising on runner time. The limits that do bind are the
  job's own `timeout-minutes` (300 in workflow 14; GitHub's hosted ceiling
  is 6 hours) and CPU-only runners.

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
| 2026-09-26 | 36271469618 | 32 | `canopy: compare`, **`decoder: fused`** (S11: lidar height, ground share, returns, NAIP NDVI, canopy + flags; dropout 0.3 / 0.2) | 23.2% (everywhere + span, veto) | 24.7% | **H48: fails its bar, not adopted.** Plan's row 26.6 → 26.5 (bar 24.6); seen 22.2 → 21.8, inferred 28.5 → 32.5; 18 lots better, 7 worse; B03 −39, B06 −4.6; B28 +10 (stale lidar), B24 +9. Fused decoders alone 28.5 → 26.1 and **29.8 → 25.0** (under the plan's 26.6, a lead); sharp edges −4 to −7. Pictures `runs/2026-09-26-1839-edt-scalemae-large-896px` |
| 2026-09-27 | 36290696462 + 36290697360 | **53** | `canopy: compare`, **`lawns: all`, 10 folds**, `decoder: fused` beside `decoder: on` (no canopy channel on the on-lawn decoder) — **NOT COMPARABLE** with the benchmark | 20.4% fused (everywhere + span) / 20.8% unfused (everywhere decoder) | — | **H49: no bar met.** Stage-3 rows 1.2–1.9 pts better fused; decoders alone level; sharp-edge gain did not replicate. **Veto bug:** Peach County GA lots have a lidar project with 0 points over them → void everywhere → both lots 100% wrong on every veto row (5,514 m² of lawn taken). Fixed in lidar_frame.py (MIN_COVERED, VOID_NEEDS_COVERED) |
| 2026-09-27 | 36298873117 + 36298874496 | 32 | `canopy: compare`, **`lawns: benchmark, 10 folds`**, `decoder: fused` beside `decoder: on`, seed 7 — the method check | 23.5% (everywhere + span, veto, fused) | 24.7% | **H51: 10 folds did not break it.** Plan row 26.5 → 25.2 fused; **25 lots better, 6 worse, p 0.001, median −1.2 [−2.0, −0.45]** (H48 LOO: 18 / 7). Unfused medians within 0.1–1.8 of LOO. Supporting only; H50 decides |
| 2026-09-27 | 36299639542 36299640699 36299641884 (fused) vs 36299643380 36299644583 36299645971 (unfused) | **55** | `canopy: compare`, `lawns: all`, **folds by place (15)**, seeds 7/8/9 each side — the first decision under the protocol | 22.0% (everywhere + span, veto, unfused s8) | — | **H50: fused NOT adopted.** Plan row 23 better / 20 worse, −0.1 [−0.7, +0.4], p 0.76; frozen 32: 12 / 13; since: 11 / 7. Seed spread 2.5 pts within one setting. Peach County fixed (no lidar). Supersedes H51 |
| 2026-09-27 | 36303807284 (x5) 36303809104 (x10) 36303810721 (x25) | 55 | `model: scalemae-large, res xN`, `decoder: on`, `canopy: compare`, folds by place, seed 7 — S12 | — | — | **H52: every factor worse than x1.** Plan row vs H50 unfused (3 seeds): x5 19 better / 33 worse +1.6; x10 16 / 31 +1.4; x25 19 / 33 +2.6. x1 stands; S12 closed |
| 2026-09-27 | 36339575912 | 55 | repeat of H50 unfused seed 7 with the per-lot diagnosis (outline error, edge share, best shift) | — | — | **H53: the ~10% is edge wobble.** All 32 benchmark lots identical to 36299643380. B01 10.9% mask / 11.1% outline, 94% within 0.5 m of the edge, best shift → 10.4%. Median over 55: 41% within 0.5 m, 60% within 1 m; best shift (0, 0); outline 25.8% vs mask 25.5% |
| 2026-09-28 | 36355253442 36355254898 36355256268 | 55 | `decoder: fused`, folds by place, seeds 7/8/9; THE PLAN's row with and without **colour edges** (S14), compared within the runs by workflow 24 (36362309179) | — | — | **H54: fails its bar, not adopted.** 25 better / 20 worse, -0.3 [-1.0, +0.3], p 0.55; frozen 32 18 / 10; since 7 / 10 (+0.2). B20 -13.7, B19 -11.0, B23 -7.0; B22 +4.6, B28 +4.2. Lot -84.06045,33.94050 is 409% in both columns |
| 2026-09-28 | 36358021364 | 55 | **`windows: tiles 10 cm`** (S13's control: 45 m blocks, 1.6 m patch, padding skipped), fused, folds by place, seed 7; vs H50 fused s7/8/9 (workflow 24 36367542993) | — | — | **H55: screen not met, but a reshuffle.** Plan row 23 better / 25 worse, +0.2 [-1.4, +1.4]; B28 -54, B03 -38, B18 -18; B20 +76, B02 +24, B24 +23, B19 +22. Backbone 18 min |
| 2026-09-28 | 36358019744 | 55 | **`windows: tiles`** (S13: 6 cm, 27 m blocks, 0.96 m patch, padding skipped), fused, folds by place, seed 7; vs H50 fused s7/8/9 (workflow 24 36377343429) | — | — | **H55: screen not met; S13 closed.** Plan row 21 better / 31 worse, +0.9 [-0.7, +2.4]; B28 -55, B03 -43; B20 +90, B23 +31, B13 +19, B10 +18 -- same lots as the 10 cm run. Backbone 91 min, 48 min a decoder |
| 2026-09-28 | 36409834421 36411745885 36411749028 | 55 | **`windows: on`** (S15: whole below ~90 m, 10 cm windows above), fused, `canopy: on lawn`, seeds 7/8/9; vs S14's fused s7/8/9 (workflow 24 36442768901) and H50's (36442743520). Seeds 8/9 first died at the pip install (PyPI timeouts; 36409837637, 36409840302) and were rerun | — | — | **H56: fails its bar, S15 closed.** vs S14: 18 better / 28 worse, +0.6 [-0.1, +1.4]; since 6 / 15, +1.4 [+0.1, +5.6]. B28 85.6 -> 30.2, B20 45.6 -> 33.7; B10 20.8 -> 36.8. H55's tiles re-read against S14: 6 cm +0.8, 10 cm -0.1 -- unchanged |
| 2026-09-28 | 36450737419 36450743019 36450746563 | 55 (+90 examples) | **`examples: on`** (S16), whole lot, fused, `canopy: compare`, seeds 7/8/9, uncropped examples; vs S14 s7/8/9 (compare-runs.js locally) | — | — | **H57: worse.** 14 better / 38 worse, +2.7 [+1.1, +4.6], p 0.001. B12 28.8 -> 22.0; B03 +42, B02 +39, B23 +29, B10 +27. Backbone 46 min, 33 min a decoder |
| 2026-09-28 | 36450750741 36450754828 36450758924 | 55 (+90 examples) | **`examples: on`** (S16), `windows: on`, fused, `canopy: on lawn`, seeds 7/8/9, uncropped; vs S15 (workflow 24 36481564377) | — | — | **H57: worse.** 11 better / 40 worse, +3.3 [+1.4, +5.0], p 0.000. B16 10.8 -> 86.4, B15 9.4 -> 52.2. Backbone 78-91 min |
| 2026-09-28 | 36450763774 36450766989 36450771744, 36453431102 36453434382 36453439067 | — | S16 tiles 6 cm and the first S17 (both scales), examples on | — | — | **CANCELLED mid-backbone** -- could not finish in one job's time with the examples. No results |
| 2026-09-28 | 36488404436 | 55 | **`gpu: modal`** -- S14 seed 7 (windows off, fused, `canopy: compare`) repeated on an L4 GPU; vs 36355253442 (compare-runs.js locally) | — | — | **GPU = CPU within half a seed.** Plan row +0.2 [-0.4, +0.8], p 0.64; median lot moves 1.2 (seed change 2.6). Canopy 3 min, backbone + 3 decoders 12 min, run ~60 min vs 1 h 43. Default flipped to modal |
| 2026-09-29 | 36495279827 36495282695 36495284820 | 55 | **`windows: both`** (S17), fused, `canopy: on lawn`, no examples, seeds 7/8/9, **Modal**; vs S14 (CPU) s7/8/9 (compare-runs.js locally) | — | — | **H58: leans better, bar missed.** 27 better / 16 worse, -0.4 [-1.4, +0.2], p 0.13; since -0.2. B28 not rescued (86); B24 -17, B32 -10, B03 -5; B20 +8. 57 min a run on Modal |
| 2026-09-29 | 36484570562 36484573224 36484577454 | 55 (+90 examples) | `examples: on`, **cropped** to graded cells, whole lot, fused, `canopy: compare`, seeds 7/8/9, CPU; vs S14 and vs the uncropped runs (compare-runs.js locally) | — | — | **H57 stands, stronger.** vs S14 10 better / 41 worse, +3.8 [+2.7, +5.4]; vs uncropped +0.7 [+0.0, +1.0]. Examples closed as built |
| 2026-09-29 | A 36488404436 36503982887 36503985030 36503987452 36507985116 36503991446; B 36495279827 36495282695 36495284820 36507987770 36503996787 36503998921 | 55 | **S18**: whole lot vs both scales, six seeds a side, Modal except A s11 / B s10 (CPU) | — | — | **H59: both scales closed.** 26 better / 19 worse, -0.2 [-1.2, +0.4], p 0.37. B24 -15, B32 -9; B20 +8, B10 +5; B28 unchanged |
| 2026-09-29 | 36555664599 36558441061 36558444702 | 55 | **S19 edge refiner** (`decoder: fused + edge`), windows off, `canopy: on lawn`, seeds 7/8/9, CPU, cache hit (extract 4 min); plain vs refined within each run | — | — | **H60: passes.** 34 better / 9 worse, -1.7 [-2.6, -0.5], p 0.0002; since 12 / 5. B03 -16, B32 -11; B19 +14, B20 +10. Refiner 14-35 min |
| 2026-09-29 | A 36601001355, B 36601005719 | 55 (+26 examples in B) | **S20**: THE PLAN, `examples: off` vs `some` (4 per kind), seed 7, CPU | — | — | **H61: screen failed.** 14 better / 33 worse, +0.8 [+0.3, +1.4], p 0.008. B20 75 -> 36, B19 46 -> 30; B03 57 -> 97, B23 33 -> 55 |
| 2026-10-04 | 37186132376 | 80 | THE PLAN + see-through rows, `not_lawn: on`, seed 7, CPU | — | — | **Died at the see-through table** (my bug: a local `bareShare` shadowed the import) after 2 h 50 min; no results. Its extraction is the cache the next run used |
| 2026-10-04 | 37195418220 | **80** (+ pond-only examples) | THE PLAN (fused + edge, canopy on lawn), `not_lawn: on`, `lawns: all`, seed 7, CPU, cache hit; colour and evergreen as rows | **21.2%** (colour row 20.6%) | — | **H69.** vs 36601001355 on 55 shared: 29 better / 15 worse, 24.0 -> 19.3, -0.8 [-1.5, +0.0], p 0.049 (workflow 24 37202209391). Colour better on leaf-off headline, worse inferred: S22 bar not met. Evergreen fails (inferred 34.9 -> 73.1 on leaf-off). Every lot tagged #N |
| 2026-10-04 | 37221751475 | 80 | Same settings as 37195418220, redrawn: pictures of the see-through colour row, with the edge refiner's layers filled (they were empty on a trial row) and B/C names | 21.2% (colour row 20.8%, evergreen 21.2%) | — | **Still 80 lots** (two new maps since were not approved). The cache missed because the run's names (now C numbers) are written into scale.json, which the fingerprint covers; the rebuilt extraction moved the rows a little -- colour 20.6 -> 20.8, evergreen 21.4 -> 21.2, THE PLAN unchanged -- the size of H13's drift, so read nothing into it |
| 2026-10-05 | 37342022957 | 80 | S24 `fused + edge + trees`, seed 7, CPU | — | — | **Died at the taught decoder's own test** (my bug: the test ran inside a REFINE=1 step and read a photo it never made). Seeds 8/9 on CPU (37348436269, 37348623524) cancelled for the same reason |
| 2026-10-05 | 37360685855 | 80 | S24 `fused + edge + trees`, `lawns: all`, canopy on lawn, seed 7, **Modal** | 20.9% (taught) | — | **H75.** PLAN 22.5, taught 20.9, + returns 22.6. Scoring re-run twice through a GitHub Actions outage |
| 2026-10-05 | 37361011304 | 80 | as above, seed 8, Modal | 20.8% (taught) | — | **H75.** PLAN 22.6, taught 20.8, + returns 21.3 |
| 2026-10-05 | 37361320989 | 80 | as above, seed 9, Modal | 22.8% (taught, + returns) | — | **H75.** PLAN 24.7, taught 22.8, + returns 22.8. Pooled lot by lot (37382273833): taught -0.1 [-1.5, +0.2], equivalent; untuned 48 -1.1 [-2.3, +0.1] |
| 2026-10-05 | 37382857695 / 37382974993 / 37383081694 | 80 | `fused + edge + trees` + the combined row, seeds 7/8/9, CPU | 21.6 / 20.4 / 23.2% (combined) | — | **H77.** PLAN 23.6 / 22.5 / 24.1; taught 21.6 / 21.4 / 22.1. Taught on the untuned 48: -1.2 [-1.7, -0.2], p 0.024 (replicates H75). Combined: 43 of 80 level, +0.0 |
| 2026-10-06 | 37393325860 / 37393416186 / 37393510265 | 80 | `fused + edge + trees`, canopy-input arm (scored as "decoder, canopy input": label comma bug), seeds 7/8/9, CPU | 21.0 / 21.3 / 21.0% (canopy input + stage 3, span, veto) | — | **H78.** Against PLAN 24.1 / 22.5 / 23.6: 38 better / 21 worse, p 0.036; untuned -1.1 [-2.6, -0.3] |
| 2026-10-06 | 37397123260 / 37397209793 / 37397296473 | 80 | as above + `distrust_lidar: on` | 20.6 / 21.1 / 21.3% (same row) | — | **H78.** 35 / 18, p 0.027; untuned -0.9 [-2.2, -0.2]. Distrust adds nothing |
| 2026-10-06 | 37421464211 | 80 | **RELEASE (H78)**: `release: alpha`, fused + edge, canopy on lawn, UNDER_TREES + FUSE_CANOPY, seed 7, CPU | — (no folds; unscored by construction) | — | Shipped to the live server, trainedAt 2026-10-06T06:44:39Z, train loss 0.209. Deploy 37425627495: "Trained model (alpha release): ON ... 80 lots". The 2026-09-29 55-lot weights are kept under alpha/history/ |
| 2026-10-06 | 37451515396 / 37451627810 / (37451740510 cancelled) | 80 | S21 `corrections: on` + `not_lawn: on`, seeds 7/8/9 | — | — | **Died in the extractor** (my bug): it took every `.png` in frames/ but `-labels.png` for a photograph, so the new `<id>-detected.png` masks were read as frames with no ground size. `-notlawn.png` had the same latent bug. Fixed in extract_features.py and tree-canopy.py. The dump found **21 of 80 lots drawn by the live release (2026-09-29T21:10:24Z)**, 34 more by SAM or land cover, and 4 approved not-lawn-only maps |
| 2026-10-06 | 37455590620 / 37455705640 / 37455821616 | 80 | S21 `corrections: on` + `not_lawn: on` (third decoder without pond maps), seeds 7/8/9, CPU | 20.9 / 21.2 / 21.4% (edge refined + stage 3, span, veto) | — | **H79.** Corrections weighted: 15 better / 34 worse, p 0.009, +0.3 [+0.1, +0.7]; untuned +0.7. No pond maps: 33 / 27, p 0.52, -0.2 [-0.6, +0.1]; B12 15.0 -> 21.3 without. Neither adopted |
| 2026-10-06 | 37509209045 / 37509342504 / 37509477275 | **81** (locked, `05cs4ud`, + C99) | S25 `edge_reach: compare` (wide refiner, dilations to 16), `decoder: fused + edge`, seeds 7/8/9, CPU | 22.0 / 22.5 / 20.8% (edge refined + stage 3, span, veto) | — | **H80.** Wide edge: 13 better / 49 worse, p < 0.001, +0.9 [+0.4, +1.4]; medians 23.3 / 24.8 / 22.9. Not adopted |
| 2026-10-07 | 37556372070 / 37556456369 / 37556539907 | **81** (locked `05cs4ud`) | `decoder: fused + edge`, plain decoder now THE PLAN minus the refiner, seeds 7/8/9, CPU | 20.9 / 22.5 / 22.0% (edge refined + stage 3, span, veto) | — | **H81.** Refiner vs true twin 55 / 18, -1.5 [-1.9, -0.9], p < 0.001; worst B19, B20 (parking lots). See-through colour vs THE PLAN 11 / 14, p 0.69 |
| 2026-10-07 | 37562487510 | 81 (locked) | `edge_reach: compare`, seed 7, CPU: pictures of the wide row against the live refiner | 22.0% (edge refined + stage 3, span, veto) | — | H82 (supplementary to H80): wide vs live 21 / 44, +0.8; B28 28 -> 68 |
| 2026-10-07 | 37563074383 / 37563158493 / 37563241262 | 81 (locked) | S27 `refiner_trial: compare` (hard edges; wide + edges + gate), seeds 7/8/9, CPU | 22.0 / 22.5 / 20.8% | — | **H82.** Hard edges 22 / 24, p 0.88; wide gated 20 / 42, +0.5 [+0.0, +0.9]. Refiner vs twin 55 / 17 (H81 replicates). Neither adopted |
| 2026-10-07 | 37582634690 / 37582729096 / 37582829432 | 81 (locked) | S28 `refiner_trial: average of 3`, seeds 7/8/9, CPU | 20.9 / 22.5 / 22.0% (edge refined + stage 3, span, veto) | — | **H83.** Averaged x3: 31 / 9, -0.3 [-0.4, -0.1], p 0.001; medians 20.3 / 22.1 / 20.7. Passes; not released |
| 2026-10-07 | 37643197968 | 81 (locked) | **RELEASE v3 (H83)**: `release: alpha`, `refiner_trial: average of 3`, fused + edge, canopy on lawn, UNDER_TREES + FUSE_CANOPY, 30 epochs, seed 7, CPU | — (no folds) | — | Three decoders averaged, trained on all 81 in 306 s, train loss 0.202, trainedAt 2026-10-07T15:52:29Z. Shipped to the live server; v2 kept under alpha/history/. Named "alpha version 3 (79%)": mean of the averaged row's run medians 21.0 (the single-decoder setup on the same runs 21.8) |
| 2026-10-07 | 37618116401 / 37618210051 / 37618300740 | 81 (locked) | S29 `refiner_trial: epochs` (15 and 60 beside 30), seeds 7/8/9, CPU | 20.9 / 22.5 / 22.0% (30 epochs) | — | **H84.** 15: 21 / 45, +0.8, p 0.004 (worse); 60: 25 / 31, p 0.50 (nothing). 30 stays |
| 2026-10-07 | 37628852627 / 37628956583 / 37629069477 | 81 (locked) | S30 `layers: compare` (blocks 8 and 16 squeezed to 256 each, fresh extraction), seeds 7/8/9, CPU | ~21-22% (edge refined + stage 3, span, veto) | — | **H85.** Middle layers 29 / 23, -0.1 [-0.4, +0.1], p 0.49; B20 73 -> 48, B19 79 -> 65. Not adopted |
| 2026-10-07 | 37666184686 / 37666283016 / 37666382432 | 81 (locked) | S31 `layers: variants` (block 8 alone 256; block 16 alone 256; both at 64), cached features, seeds 7/8/9, CPU | 21.2 / 22.0 / 22.4% (edge refined + stage 3, span, veto) | — | **H86.** Layer 8 28 / 24, p 0.68; layer 16 30 / 19, p 0.15; both small 28 / 25, p 0.78. B20 73 -> 57-59, B19 79 -> 68-71. None adopted |
| 2026-10-08 | 37709290743 (workflow 7) | 25 approved maps drawn by release 1 | live-release score: the release's outline vs the finished one, by `model_version` | — | 23.4% (release 1, live) | **H87.** First live measurement; folds had said 24.0%. v2 drew none, v3 one (unreviewed) |
| 2026-10-08 | 37709603931 / 37710689178 (workflow 32) | 8 timing lots | live server after `lot` (downloads first, then GPU) | — | — | GPU 2.7 s per warm lot (12.3 before), waiting 1.1 (11.0). First press after the deploy timed out; cold press 29 s |
| 2026-10-08 | 37766196684 (workflow 24 split) | 81 (locked), S31 runs | THE PLAN's row split by the photo each map was drawn on | — | county 55.2% (12 lots) / Mapbox 19.0% (69) | **H88.** County-photo lots are the worst group; cause not established (confounded with the lots being the newest) |
| 2026-10-08 | 37783174587 (workflow 33) | 81 (locked), S31 runs | each lot's photo measured (contrast, green, shadow, focus, brightness, lawn share) against THE PLAN's error | — | — | **H89.** Contrast predicts error within each source (-0.41 / -0.63); focus does not; lawn share -0.62 (partly the metric) |
| 2026-10-08 | 37791602756 / 37791654341 / 37791705849 | 81 (locked) | S32 `refiner_trial: held out by photo` (county lots answered by a decoder trained on the 69 Mapbox lots; 12 Mapbox lots held out the same way), seeds 7/8/9, CPU | 20.9 / 22.5 / 22.0% (edge refined + stage 3, span, veto) | — | **H90.** County arm 5 / 6, +0.9 [-1.9, +5.4]; control 6 / 4, -0.8. County examples in training worth nothing measurable |
| 2026-10-10 | 37999935674 / 38000318035 / 38000326730 | 81 (locked) | S34 `refiner_trial: no flips` (THE PLAN's decoder with every training grid as drawn), seeds 7/8/9, CPU | 20.4 / 22.4 / 21.5% (edge refined + stage 3, span, veto) | 22.0 / 20.7 / 20.7% (no flips, same) | **H91.** Workflow 24 run 38017280676: 28 / 23 / 30, -0.0 [-0.3, +0.1], p 0.58; untuned 49 lots +0.0. No difference; flips stay on |
