/**
 * The segmentation model, and how to run it.
 *
 * This lives apart from index.js for a blunt runtime reason: a Workers
 * entrypoint may only export handlers. Exporting a plain constant from it
 * kills the isolate on startup with
 *
 *   Incorrect type for map entry 'SAM_MODEL': the provided value is not of
 *   type 'function or ExportedHandler'
 *
 * which takes the entire site down, not just detection. Keeping these here
 * lets the Worker and the checking tools share one definition safely.
 */

export const SAM_MODEL = 'mattsays/sam3-image';

/** Exactly the input fields the Worker sends, for preflight to validate. */
export const SAM_INPUT_FIELDS = [
  'image', 'prompt', 'mask_only', 'save_overlay', 'return_zip', 'threshold',
];

/**
 * The things a lawn is measured by NOT being, one concept at a time.
 *
 * ONE CONCEPT PER PREDICTION, and that is the whole finding. This started as a
 * fifteen-concept list on the reasoning that a lawn is defined by everything it
 * is not, so naming more of those things must cover more ground. The table
 * below says otherwise: one concept beats every list tried, and lists misbehave
 * unpredictably rather than simply less well.
 *
 * So the way to cover several concepts is several predictions, unioned -- which
 * is what this table is for. Each entry is one pass: its own wording, its own
 * confidence cut, its own tick box, and its own cost.
 *
 * EACH CARRIES ITS OWN THRESHOLD, and that is not tidiness. The number means
 * different things to different concepts, and the two that have been measured
 * disagree by a factor of four: "man-made" reads well at 0.05 on a suburban lot
 * while "trees" needs 0.2 to avoid flooding the frame. One shared number would
 * have to be wrong for one of them.
 *
 * `env` overrides exist per entry so a concept can be retuned against real lots
 * without a deploy. There is deliberately no way to put a comma list in one:
 * see the table under NOT_LAWN_PROMPT for what that does.
 */
export const EXCLUSIONS = {
  /*
   * DEFAULT ON, because it is the one that has been tried on a real lot and
   * reported to work: the owner ran "man-made" through the developer panel at
   * the ordinary 0.05 cut and it took the house, driveway, road, pool, deck and
   * sidewalk together.
   *
   * That is a genuinely surprising result next to the rest of this file.
   * "building" alone masked 9.2% of Brooks Lane where everything built is 12.5%
   * -- decent, but only buildings. "man-made" is not a list of those things, it
   * is a category that contains them, and the model appears to resolve it as
   * one concept. Which is consistent with the finding rather than an exception
   * to it: the problem with "house, driveway, pool" was never the number of
   * THINGS, it was the number of CONCEPTS in one prompt.
   */
  built: {
    label: 'Buildings, drives and paving',
    prompt: 'man-made',
    promptVar: 'SAM_EXCLUDE_BUILT_PROMPT',
    threshold: 0.05,
    thresholdVar: 'SAM_EXCLUDE_BUILT_THRESHOLD',
    byDefault: true,
    note: 'House, garage, driveway, patio, pool, deck, sidewalk, and any road inside the line.',
  },

  /*
   * 0.2, from the sweep at Brooks Lane: "trees" masked 61.5% of a parcel that
   * is 58% not-lawn, and inverted to 28,788 sq ft against an owner-reported
   * 28,000 mown. At 0.1 and below the same prompt flooded the whole frame.
   */
  trees: {
    label: 'Trees',
    prompt: 'trees',
    promptVar: 'SAM_NOT_LAWN_PROMPT',
    threshold: 0.2,
    thresholdVar: 'SAM_SUBTRACT_THRESHOLD',
    byDefault: false,
    note: 'Canopy, whether one tree on the lawn or a whole treeline.',
  },

  /*
   * "forest" measured 58.3% against the 58% wanted -- the closest single
   * concept tried, half a point out. It overlaps "trees" almost entirely, so
   * ticking both costs two predictions for one answer; the UI says so.
   */
  forest: {
    label: 'Woods',
    prompt: 'forest',
    promptVar: 'SAM_EXCLUDE_FOREST_PROMPT',
    threshold: 0.2,
    thresholdVar: 'SAM_EXCLUDE_FOREST_THRESHOLD',
    byDefault: false,
    note: 'A continuous block of woodland. Largely the same answer as Trees, so pick one.',
  },

  /*
   * UNMEASURED, and labelled as such rather than quietly shipped as though it
   * were. There is no lot with a known pond in the record, and a swimming pool
   * is already inside "man-made" by the owner's own account -- so this earns
   * its place only on a property with real water, and it is off by default.
   */
  water: {
    label: 'Ponds and creeks',
    prompt: 'bodies of water',
    promptVar: 'SAM_EXCLUDE_WATER_PROMPT',
    threshold: 0.2,
    thresholdVar: 'SAM_EXCLUDE_WATER_THRESHOLD',
    byDefault: false,
    note: 'Untested. A swimming pool is already covered by the first box.',
  },
};

/** Which boxes start ticked. */
export const DEFAULT_EXCLUSIONS = Object.entries(EXCLUSIONS)
  .filter(([, e]) => e.byDefault)
  .map(([id]) => id);

/**
 * A ceiling on passes per detection.
 *
 * Every tick is a separate Replicate prediction, paid for and waited on. Four
 * is the whole table today, so this is not a restriction anyone can feel -- it
 * is a guard on the wire, where `exclude` is a list a caller can post whatever
 * it likes into. Without it, one request could ask for a hundred predictions.
 */
export const MAX_EXCLUSIONS = 4;

/**
 * Clean a requested exclusion list into one that can be run.
 *
 * Unknown ids are dropped rather than rejected: a browser cached from before a
 * concept was renamed should lose that box, not lose the whole detection.
 * An empty result stays empty -- "remove nothing" is a real (if useless)
 * request, and the caller refuses it with a sentence rather than silently
 * substituting the defaults, which would spend money on something not asked
 * for.
 */
export function normaliseExclusions(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = String(raw);
    if (!Object.prototype.hasOwnProperty.call(EXCLUSIONS, id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_EXCLUSIONS) break;
  }
  return out;
}

/** One pass's wording and cut, honouring any env override. */
export function exclusionPass(id, env, thresholdOverride = null) {
  const e = EXCLUSIONS[id];
  if (!e) return null;
  const raw = Number(env?.[e.thresholdVar]);
  let threshold = Number.isFinite(raw) ? raw : e.threshold;
  const dev = Number(thresholdOverride);
  if (thresholdOverride !== null && thresholdOverride !== '' && Number.isFinite(dev)) {
    threshold = dev;
  }
  return {
    id,
    prompt: String(env?.[e.promptVar] || e.prompt).trim(),
    threshold: Math.min(Math.max(threshold, 0), 1),
  };
}

/** What the browser needs to draw the tick boxes, without a second copy. */
export const exclusionCatalogue = () =>
  Object.entries(EXCLUSIONS).map(([id, e]) => ({
    id,
    label: e.label,
    note: e.note,
    byDefault: Boolean(e.byDefault),
  }));

/**
 * Kept as named exports because the probe tool sweeps against them, and
 * because the measurements they carry are the reason the trees entry has the
 * numbers it has. They are views onto the table now, not a second source.
 */
export const NOT_LAWN_PROMPT = EXCLUSIONS.trees.prompt;

/*
 * ONE CONCEPT. NOT A LIST. Measured at Brooks Lane, all at 0.2, against a
 * parcel that is 58% not-lawn and ~28,000 sq ft mown:
 *
 *   concepts  prompt                                    masked   lawn
 *      1      "trees"                                    61.5%    38%
 *      2      "trees, building"                          ~51%     49%
 *      3      "trees, building, driveway"                  0%    100%
 *      4      "trees, building, driveway, swimming pool"   0%    100%
 *      8      the original eight-item list                20.7%   78%
 *
 * The parcel is 58% not-lawn, so the "masked" column wants to be near 58 and
 * one concept is the only row that gets close.
 *
 * NOT MONOTONIC, and this comment claimed it was. Eight concepts (20.7%
 * masked) beat three and four, which found nothing at all. So "every word
 * added makes it worse" is simply false, and the real shape is worse than
 * monotonic would be: adding concepts degrades the answer ERRATICALLY, and
 * somewhere around three it can collapse to nothing and hand back the whole
 * parcel. A curve you could extrapolate would at least be predictable; this
 * has a hole in the middle of it.
 *
 * What the table does support is the thing that matters: one concept is
 * clearly best, and a list is unreliable at any length. This model is worth
 * one concept per prediction.
 *
 * That is why naming more things could never have worked, and why the 32-token
 * ceiling was a red herring: a list short enough to fit still fails.
 *
 * ALSO UNTESTED: whether a comma list behaves this badly in NORMAL mode. Every
 * row above is subtract mode on one lot. "grass", "lawn" and "grass lawn"
 * agreed to within 0.6% early on, but that is one concept phrased three ways,
 * not two concepts combined, and it says nothing about "grass, clover". Covering
 * trees AND buildings needs two predictions unioned, at twice the cost per
 * detection -- worth knowing, and not what ships today.
 *
 * "trees" is the single word to spend it on: the woods is 45% of this parcel
 * and 78% of everything subtraction has to remove, and no other concept comes
 * close. "building" alone masked 9.2% against the 58% wanted.
 */

/**
 * The text encoder takes 32 tokens. That is the budget, and it is hard.
 *
 * A fifteen-concept list came to 36 and every prediction failed outright:
 *
 *   Sequence length must be less than max_position_embeddings
 *   (got `sequence length`: 36 and max_position_embeddings: 32)
 *
 * Not a warning and not a truncation -- an error, before inference, so the
 * mode did not work at all rather than working badly. Worth knowing that this
 * is the shape of the limit: you cannot buy coverage by listing more things,
 * and a prompt that grows past the line stops producing answers entirely.
 *
 * This ceiling turned out to be a RED HERRING, and it is worth saying so where
 * it is documented: shortening the list to eight got past the error, and the
 * mode still did not work, because a list of any length is the wrong shape for
 * this model. The guard stays -- a long prompt is still a total failure rather
 * than a degraded one, and that is worth catching before it is paid for -- but
 * fitting under it was never what fixed anything.
 *
 * ESTIMATED, not measured: this counts words and commas, because the real
 * tokenizer is not available here. Calibrated against the one prompt whose
 * true count is known -- the model reported 36 for the list that failed, and
 * this returns exactly 36 for it.
 *
 * One agreeing data point is not a tokenizer. A word this happens to count as
 * one token could be two ("bermudagrass", a hyphenation, anything unusual), so
 * it can undercount on wording it has never seen. Keep a real margin rather
 * than trimming a list until it just fits: this is a tripwire for a list that
 * has clearly grown too long, not a licence to sit one token under the line.
 */
export const MAX_PROMPT_TOKENS = 32;

export const estimatePromptTokens = (prompt) =>
  String(prompt).trim().split(/\s+/).filter(Boolean).length
  + (String(prompt).match(/,/g) || []).length
  + 3; // start/end markers, plus one for the undercount above

/**
 * The confidence cut for subtract mode, where it means the OPPOSITE thing.
 *
 * DEFAULT_THRESHOLD is 0.05 because being inclusive about grass is the safe
 * way to be wrong: a stray patch is visible and one tap to delete, a missing
 * one is invisible. Reuse that number here and the same instinct produces the
 * opposite behaviour -- 0.05 is inclusive about BUILDINGS, and everything
 * subtract mode is confident about gets erased from the lawn. The safe
 * direction is not a value, it is "toward more lawn", and which value that is
 * depends on which question was asked.
 *
 * That reasoning is sound and it did not survive contact with the model. The
 * sweep at Brooks Lane with the EIGHT-CONCEPT LIST (76,250 sq ft, ~28,000 of
 * it mown, ~20,000 visible):
 *
 *   threshold   parcel masked   inverted lawn   % of parcel
 *   0.02            100%                  0        0%
 *   0.05            100%                  0        0%
 *   0.10            100%                  0        0%
 *   0.20             20.7%           59,824       78%
 *   0.40              0.0%           76,079      100%
 *   0.60              0.0%           76,079      100%
 *
 * That is not a curve, it is a cliff with one point on the face of it. The
 * mask floods the entire frame up to 0.1 and vanishes by 0.4. There is no
 * value that yields a believable lawn: the best of them, 0.2, gives 78% of a
 * lot that is 37% mown -- more than double, on a lot where "Quick" lands
 * within about 10% of the owner's own figure.
 *
 * 0.2 is kept because it is the one setting that produced anything at all with
 * that list, and because 0.4 produced the entire parcel in six vertices, which
 * is the worst failure available here: maximally wrong and shaped exactly like
 * a clean answer.
 *
 * AND THEN THE LIST TURNED OUT TO BE THE PROBLEM, NOT THE THRESHOLD.
 *
 * The owner walked the lot and gave real components: woods 34,500, everything
 * built 9,500, not-lawn 44,000 (58% of the parcel), mown lawn ~28,000. That
 * made single concepts judgeable, and at the same 0.2:
 *
 *   prompt      parcel masked   vs the 58% wanted   inverted lawn
 *   "woods"          57.2%            -0.5 points        32,768
 *   "forest"         58.3%            +0.6              31,236
 *   "trees"          61.5%            +3.8              28,788
 *   "building"        9.2%           -48.5              69,122
 *   (the 8-item list)  20.7%         -37.0              59,824
 *
 * One word lands within half a point of ground truth. The list of eight,
 * containing that same word, lands thirty-seven points away. That is the
 * assumption this mode was built on, answered: THE MODEL DOES NOT READ A
 * COMMA LIST AS SEVERAL CONCEPTS. Every earlier reading of these numbers --
 * "the threshold is wrong", "the model cannot see buildings from overhead" --
 * was an explanation for a symptom of that.
 *
 * "trees" alone inverts to 28,788 sq ft against a mown 28,000: +2.8%, where
 * Quick gets 25,059 and is -10.5%. On this lot, subtraction with one word is
 * the better measurement.
 *
 * Not a shipping default on its own, for a reason the table cannot show:
 * "trees" removes no house, drive or pool, and it only lands here because on a
 * lot this wooded those are small and partly caught anyway. On a bare suburban
 * lot with a wide driveway it would count the tarmac as lawn.
 *
 * THAT OPEN QUESTION IS NOW ANSWERED, and the answer was neither of the two on
 * offer. "Whether a SHORT list resolves where a long one does not" assumed the
 * choice was between one prompt and one prompt with more words in it. The lot
 * owner found the third option by hand in the developer panel: "man-made", one
 * concept, which covers house, drive, pool, deck and sidewalk together because
 * it names the CATEGORY rather than listing its members.
 *
 * So the shipped arrangement is several predictions unioned, one concept each,
 * and the several-unioned cost is real and per-pass. See EXCLUSIONS.
 */
export const SUBTRACT_THRESHOLD = EXCLUSIONS.trees.threshold;

/**
 * How to ask.
 *
 * A table rather than a slug because models differ in what they need from the
 * browser, not just in name: `needsPoints` would drive a whole interaction,
 * and `input` is the only place a model's wire format lives. One entry today;
 * the shape is what lets a second be added without touching the Worker.
 */
export const MODELS = {
  sam3: {
    slug: 'mattsays/sam3-image',
    // Named for the question it asks, now that the other method asks the
    // opposite one. "Quick" described how it felt to use and said nothing about
    // what it does, which was fine while it was the only option and useless
    // next to a method whose entire difference is the question.
    label: 'Find grass',
    note: 'One press, one AI pass. Finds every patch of grass it recognises, including pieces you might forget.',
    needsPoints: false,
    fields: SAM_INPUT_FIELDS,
    input: (image, { prompt, threshold }) => ({
      image,
      prompt,
      // The bare mask, not an overlay on the photograph, and not zipped: the
      // browser traces these pixels directly.
      mask_only: true,
      save_overlay: false,
      return_zip: false,
      threshold,
    }),
  },

  /*
   * SUBTRACT MODE. Same model, opposite question.
   *
   * "Grass" fails in a specific, geographic way: warm-season turf -- bermuda,
   * zoysia, St Augustine -- goes straw-brown when dormant, and imagery flown in
   * that season shows a lawn the detector does not recognise as grass at all.
   * Not a threshold problem this time. Lowering the cut finds more of a thing
   * the model is looking for; it does not make the model look for a different
   * thing. A dormant lawn can score near zero on "grass" at any threshold.
   *
   * So stop asking. A house, a driveway, a treeline, a pool and a mulch bed all
   * look like themselves whatever the season -- their appearance does not
   * depend on the grass being green. Name those, and take the lawn as the
   * remainder.
   *
   * WHAT THIS TRADES AWAY. Subtraction has no concept of grass, so it cannot
   * decline to measure something that is not grass. Anything the prompt forgot
   * to name becomes lawn: a gravel yard, a bare-earth field, a tennis court, a
   * neighbour's roof the clip did not reach. "Quick" errs by missing lawn;
   * this errs by inventing it. Which is the better failure depends entirely on
   * the lot, which is why this is a second option and not a replacement.
   *
   * IT DID NOT WORK FOR A LONG TIME, and the record of why is worth keeping,
   * because the wrong diagnosis survived three rounds of measurement. At Brooks
   * Lane the not-lawn mask flooded the whole frame up to 0.1 and disappeared by
   * 0.4, with one usable-looking point between that still reported 78% of a lot
   * that is 37% mown. That was read as a threshold problem, then as the model
   * being unable to see buildings from overhead. It was neither: the prompt was
   * a comma list, and the model resolves a list as one vague phrase rather than
   * as eight concepts. A bimodal all-or-nothing response is what that looks
   * like from outside.
   *
   * The mechanism was never the problem -- the polarity guard and the ordering
   * were proven by mask.test.js throughout. What fixed it was one concept per
   * prediction, and then the owner finding "man-made" by hand: a single concept
   * that happens to contain house, drive, pool, deck and sidewalk.
   *
   * ONE CONCEPT PER PASS, SEVERAL PASSES, ADDED UP. That is what ships, and the
   * cost is honest: every tick box is another prediction.
   */
  /*
   * TESTING. The developer panel's own method, and deliberately a separate
   * entry rather than an override applied to the shipped ones.
   *
   * The reason is that "am I testing a prompt, or a prompt plus whatever
   * Exclude already does to it?" has no answer you can see from the screen.
   * Overriding the prompt on sam3_exclude leaves its subtraction and its
   * per-concept thresholds in play, so a surprising result has two possible
   * causes and the panel cannot tell you which. This entry starts from nothing:
   * no prompt of
   * its own, no inversion of its own, no threshold of its own. Everything it
   * sends comes from the panel, so a result is attributable to what was typed.
   *
   * devOnly keeps it out of the picker for everyone else. Like the rest of
   * developer mode that is obscurity, not a guard -- the Worker will run it
   * for anyone who names it, and that costs exactly one prediction.
   */
  sam3_testing: {
    slug: 'mattsays/sam3-image',
    label: 'Testing',
    note: 'Sends exactly what the panel says. No prompt, threshold or inversion of its own.',
    needsPoints: false,
    devOnly: true,
    // Both false by design, and both overridden by the panel. Written out
    // rather than omitted so that reading this entry answers the question
    // "what does it do on its own?" -- which is: nothing.
    invert: false,
    fields: SAM_INPUT_FIELDS,
    input: (image, { prompt, threshold }) => ({
      image,
      prompt,
      mask_only: true,
      save_overlay: false,
      return_zip: false,
      threshold,
    }),
  },

  sam3_exclude: {
    slug: 'mattsays/sam3-image',
    label: 'Exclude objects',
    // Says what it starts from as well as what it removes, because that is the
    // part that changes how to read a wrong answer. It begins with the WHOLE
    // LOT counted as lawn, so anything the ticked boxes fail to find stays in
    // the total -- gravel, a bare field, a tennis court. Visible on the map and
    // one tap to delete, but only if the label told you to look.
    note: 'Starts with your whole property and takes out what you tick. Best for dormant grass. Anything not ticked counts as lawn, so check the result.',
    needsPoints: false,
    /*
     * SUBTRACTIVE, which replaced `invert: true`.
     *
     * They are the same pixels for one prompt -- "flip the mask, then clip to
     * the parcel" and "start from the parcel, then remove the mask" are the
     * same set operation written from opposite ends. The difference is what
     * happens with TWO prompts. Inverting is per-mask, so two inverted masks
     * intersect: a pixel counts as lawn only if it is neither a tree nor a
     * building, which sounds right and is unreachable, because you cannot
     * intersect two independently-flooded masks and get anything but slivers.
     * Subtracting is per-parcel, so passes accumulate the way the user
     * describes them: one shape, minus this, minus that.
     *
     * That is the whole reason for the change, and it only shows up at two.
     */
    subtractive: true,
    exclusions: true,
    fields: SAM_INPUT_FIELDS,
    input: (image, { prompt, threshold }) => ({
      image,
      prompt,
      mask_only: true,
      save_overlay: false,
      return_zip: false,
      threshold,
    }),
  },
};

/**
 * Old ids that still name something real.
 *
 * `normaliseModel` falls back to the default for anything it does not know, so
 * without this a browser cached from before the rename would ask for
 * "Subtract trees" and silently be given "Find grass" -- the opposite question,
 * answered confidently, with nothing on screen to say a substitution happened.
 * The exclusion boxes then start at their defaults, which is the honest landing
 * place: same method, and it says what it is removing.
 */
export const MODEL_ALIASES = {
  sam3_subtract: 'sam3_exclude',
};

/*
 * There was a second, point-prompted model here. It is gone.
 *
 * ocg2347/sam-pointprompt accepted pins and returned masks, so the plumbing
 * worked -- but it could not tell a tree's shadow lying across a lawn from
 * dense woodland, and that is the single distinction this product depends on.
 * Being able to point at a patch buys nothing when the model then decides the
 * patch is forest. Removed rather than left in the picker, because an option
 * that produces confidently wrong answers is worse than no option.
 *
 * The search for a replacement is deliberately not limited to point prompts:
 * see tools/find-sam-model.js. What is wanted is a model that understands
 * mown grass, however it is asked.
 */

export const DEFAULT_MODEL = 'sam3';

export const normaliseModel = (value) => {
  const id = MODEL_ALIASES[value] || value;
  return Object.prototype.hasOwnProperty.call(MODELS, id) ? id : DEFAULT_MODEL;
};

/**
 * What the browser needs to build the picker, without a second copy of it.
 *
 * `invert` and `subtractive` are here because both happen in the BROWSER, in
 * the tracer, not on the wire: the Worker returns the same kind of mask either
 * way. The client cannot know a mask needs flipping by looking at it -- that is
 * the whole problem with a bitmap that is 92% white -- so the fact travels with
 * the model description instead.
 */
export const modelCatalogue = () =>
  Object.entries(MODELS).filter(([, m]) => !m.hidden).map(([id, m]) => ({
    id,
    label: m.label,
    note: m.note,
    needsPoints: Boolean(m.needsPoints),
    invert: Boolean(m.invert),
    // Start from the property line and take the mask away, rather than tracing
    // the mask. See the sam3_exclude entry for why the distinction only
    // matters once there is more than one mask.
    subtractive: Boolean(m.subtractive),
    // Whether this method is driven by the tick boxes, and therefore costs one
    // prediction per tick rather than one per press.
    exclusions: Boolean(m.exclusions),
    /*
     * Developer-only methods travel in the catalogue and are filtered out by
     * the browser, rather than withheld here.
     *
     * That is the honest arrangement given what developer mode already is: the
     * Worker runs whatever model id it is given, so hiding the name would buy
     * nothing but would suggest a guard that does not exist. Anyone reading
     * /api/config can see there is a Testing method; nobody who has not
     * unlocked the panel gets a control for it.
     */
    devOnly: Boolean(m.devOnly),
  }));

/**
 * What to ask this model to find.
 *
 * The provider normally owns the wording, because it depends on the picture:
 * an infrared vegetation index has no "grass" in it to find, only vegetation.
 * A model that carries its own prompt overrides that, because for subtract
 * mode the wording is not a description of the imagery, it is the entire
 * method -- asking an inverting model for "grass" would measure the house.
 */
export function samPrompt(modelId, providerPrompt, env, override = null) {
  // Developer mode sends its own wording. It outranks everything, because the
  // entire point of it is to try a prompt this file does not contain.
  const typed = typeof override === 'string' ? override.trim() : '';
  if (typed) return typed;
  const m = MODELS[normaliseModel(modelId)];
  if (!m.prompt) return providerPrompt;
  return String(env?.[m.promptVar] || m.prompt).trim();
}

/**
 * Is this prompt runnable at all?
 *
 * The encoder takes 32 tokens and ERRORS past that rather than truncating, so
 * an over-long prompt is not a worse measurement, it is no measurement -- and
 * it would still cost a prediction and a slot of the daily allowance. Checked
 * here so the caller can refuse before spending either.
 *
 * Returns null when fine, or a sentence to show the person who typed it.
 */
export function promptProblem(prompt) {
  const text = String(prompt ?? '').trim();
  if (!text) return 'Type something for the detector to look for.';
  if (text.length > 300) return 'That prompt is far too long.';
  const est = estimatePromptTokens(text);
  if (est > MAX_PROMPT_TOKENS) {
    return `That is about ${est} tokens and the model's limit is ${MAX_PROMPT_TOKENS}. `
      + 'It would fail rather than answer badly. Use fewer words.';
  }
  return null;
}

/**
 * How confident the model must be before it calls something grass.
 *
 * The model's own default is 0.5, and for a long time the Worker sent no
 * threshold at all, so 0.5 is what every measurement used. On a real
 * Hudsonville lot that found 897 sq ft of a 10,900 sq ft parcel -- 8%, in one
 * piece -- and left the entire back lawn out. Measured on that same lot:
 *
 *   0.5 (default)    897 sq ft    8% of parcel   1 piece
 *   0.3            1,834 sq ft   17%             3 pieces
 *   0.2            2,048 sq ft   19%             3 pieces
 *   0.15           2,650 sq ft   24%             4 pieces
 *   0.1            3,640 sq ft   33%             4 pieces
 *   0.05           4,475 sq ft   41%             5 pieces
 *
 * Bright green turf clears 0.5 comfortably. Dormant brown grass, and grass in
 * the shade of bare trees, sits just under it -- which is also why two runs of
 * the same prompt on the same house disagreed about which sections existed:
 * marginal regions fall either side of the cut from one run to the next.
 *
 * That table had no plateau, so no value in it was picked out as correct by
 * the numbers, and 0.1 was chosen as a judgement about which way to be wrong:
 * inclusive, because a patch that should not be there is visible on the map
 * and one tap to delete, while a missing patch is invisible unless the owner
 * happens to know their own back lawn is gone.
 *
 * THEN A LOT WITH A KNOWN ANSWER SETTLED IT.
 *
 * 7315 Brooks Lane, Rockford: 76,250 sq ft, about 28,000 of it mown, with a
 * large wooded area behind the house. Photographed leaf-off with a low sun, so
 * long tree shadows lie across the grass -- and the owner's own screenshot
 * showed the detected outline tracing the boundary between sunlit and shaded
 * lawn exactly. Not confusion about what grass is: a brightness cut.
 *
 *   0.1    17,393 sq ft   23% of parcel   2 pieces
 *   0.05   25,059 sq ft   33%             2 pieces
 *   0.02   25,247 sq ft   33%             2 pieces
 *
 * 0.05 recovers 7,666 sq ft of shaded grass, which is very nearly the whole
 * gap between what this owner can see from the air and what he actually mows.
 *
 * And 0.02 adds 0.75%. THAT is the plateau the first table lacked: recovered
 * area stops growing, so 0.05 has found essentially everything this model is
 * going to find on this lot.
 *
 * WHAT THE PLATEAU DOES NOT SAY, and was claimed here for a while: that the
 * extra area is all lawn. It says the total stopped growing. It says nothing
 * about what the total is made of. The owner then looked at the result in the
 * app and reported that part of the gain is a disconnected patch away in the
 * woods -- so some woodland IS being counted at 0.05, alongside a genuine
 * increase in real lawn. Both things are true at once, and only the first was
 * visible in the numbers.
 *
 * The reasoning that was wrong is worth keeping visible: "it would run away if
 * it were eating the woods" describes a model that cannot tell trees from
 * grass anywhere, which is what lang-segment-anything did on this same lot
 * (47,930 sq ft from a mask covering 69% of the frame). It does not describe a
 * model that takes one wrong bite and stops. A flat curve cannot distinguish
 * those two.
 *
 * 0.05 stands anyway, on the owner's own judgement of the result: it recovers
 * more real lawn than it wrongly adds, and a stray section is visible on the
 * map and one tap to delete, while missing lawn is invisible. That is the same
 * which-way-to-be-wrong argument as before -- now with a measurement showing
 * what it costs, rather than a claim that it costs nothing.
 *
 * Overridable with a SAM_THRESHOLD variable, because the right value is a
 * property of the imagery and not something to hard-code forever.
 */
export const DEFAULT_THRESHOLD = 0.05;

/**
 * The threshold to send, clamped to the range the model accepts.
 *
 * Per model, because the number means opposite things in the two modes and a
 * single SAM_THRESHOLD would have quietly applied a grass-inclusive 0.05 to a
 * mode where that erases the lawn. Each model names its own variable, so
 * either can be retuned without disturbing the other.
 */
export function samThreshold(env, modelId = DEFAULT_MODEL, override = null) {
  const m = MODELS[normaliseModel(modelId)];
  const fallback = typeof m.threshold === 'number' ? m.threshold : DEFAULT_THRESHOLD;
  // Developer mode's slider, clamped like any other source for this number.
  // Note that 0 is a legitimate setting, so this tests for finite rather than
  // for truthy -- `override || fallback` would silently ignore the low end.
  const dev = Number(override);
  if (override !== null && override !== '' && Number.isFinite(dev)) {
    return Math.min(Math.max(dev, 0), 1);
  }
  const raw = Number(env?.[m.thresholdVar || 'SAM_THRESHOLD']);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, 0), 1);
}

/**
 * What we ask the model to find.
 *
 * Measured against a real 21,740 sq ft lot, "grass", "lawn" and "grass lawn"
 * agreed to within 0.6% -- the model resolves them to the same concept, so
 * elaborate wording buys nothing and the shortest one wins. Overridable with a
 * SAM_PROMPT variable so it can be retuned without a code change.
 */
export const DEFAULT_PROMPT = 'grass';

/**
 * Replicate's per-model endpoint, /v1/models/{owner}/{name}/predictions, only
 * exists for *official* models. For everything else it answers 404 -- which is
 * what it did here, in 0.4 s, with a message about the resource not being
 * found rather than anything to do with segmentation.
 *
 * The general endpoint works for any model but needs a version id, so look it
 * up. Cached per isolate: the id changes only when the model is republished,
 * and paying an extra round trip on every detection to re-learn it is waste.
 */
const cachedVersion = new Map();

/** The slug for a model, honouring its env override. */
export function modelSlug(modelId, env) {
  const m = MODELS[normaliseModel(modelId)];
  return (m.slugVar && env?.[m.slugVar]) || m.slug;
}

export async function samVersion(env, modelId = DEFAULT_MODEL) {
  const slug = modelSlug(modelId, env);
  if (cachedVersion.has(slug)) return cachedVersion.get(slug);

  const res = await fetch(`https://api.replicate.com/v1/models/${slug}`, {
    headers: { Authorization: `Bearer ${env.REPLICATE_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Could not look up ${slug} (HTTP ${res.status})`);

  const model = await res.json();
  const id = model.latest_version?.id;
  if (!id) throw new Error(`${slug} has no published version to run`);

  cachedVersion.set(slug, id);
  return id;
}

