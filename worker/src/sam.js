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
 * What subtract mode asks for: everything a lawn is not.
 *
 * Ordered roughly by how much of a typical lot each covers, which costs
 * nothing and makes the list readable. The reasoning behind the membership:
 *
 *   - "building", "roof", "driveway", "road", "sidewalk", "parking lot"
 *     rather than one "man-made structures". Concept segmentation answers
 *     nouns it can picture; an abstract category is a worse handle on a
 *     driveway than the word driveway. Paved surfaces are listed separately
 *     because they are the largest non-lawn area on most suburban lots and
 *     the one a "structures" prompt is most likely to walk past.
 *   - "swimming pool" as well as "water": a pool is not what a model pictures
 *     for a body of water, and it is the one that turns up in back gardens.
 *   - "garden bed" and "mulch bed" for landscape beds, plus "shrub", since a
 *     planting bed is often read as its plants rather than as a bed.
 *   - "car" because a driveway with a car on it is otherwise a car-shaped
 *     island of lawn.
 *
 * Whether this model takes a comma-separated list as several concepts or as
 * one confused phrase is NOT KNOWN, and it is the assumption this whole mode
 * rests on. tools/probe-sam3.js with SUBTRACT=1 answers it against a real lot:
 * if a list works, the mask covers the house AND the trees AND the drive; if
 * it does not, expect one of them, or nothing.
 *
 * Overridable with SAM_NOT_LAWN_PROMPT, because this list is a guess that
 * wants retuning against real lots and should not need a deploy to change.
 */
export const NOT_LAWN_PROMPT = [
  'building', 'roof', 'driveway', 'tree', 'shrub', 'swimming pool',
  'garden bed', 'car',
].join(', ');

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
 * Which is why the list is now the eight concepts that cover the most ground
 * on an ordinary lot. What was dropped, and why it was affordable:
 *
 *   road, sidewalk, parking lot  mostly fall outside the property line, and
 *                                the clip removes them anyway
 *   woods, forest                "tree" already reaches them
 *   water                        "swimming pool" is the one in back gardens
 *   mulch bed                    "garden bed" covers the same thing
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
 * So this sits high instead: only things the model is fairly sure are not
 * lawn are taken out. 0.4 is a starting point chosen for that direction, near
 * the model's own 0.5 default, and it is a guess -- unlike DEFAULT_THRESHOLD,
 * no lot with a known answer has ranged over it yet.
 */
export const SUBTRACT_THRESHOLD = 0.4;

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
    label: 'Quick',
    note: 'One press. Finds every patch of grass it recognises, including pieces you might forget.',
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
   * NOT YET MEASURED. Every number in this file elsewhere came from a real lot
   * with a known answer. There is no such table for this mode yet, and the
   * threshold below is a starting point rather than a finding. Run
   * tools/probe-sam3.js with SUBTRACT=1 against a dormant-season lot to get
   * one, and put the numbers here when they exist.
   */
  sam3_subtract: {
    slug: 'mattsays/sam3-image',
    label: 'Subtract',
    note: 'For brown or dormant grass. Finds the buildings, trees and beds instead, and calls the rest lawn.',
    needsPoints: false,
    // Tells the browser to flip the mask before tracing. See maskToPolygons.
    invert: true,
    prompt: NOT_LAWN_PROMPT,
    promptVar: 'SAM_NOT_LAWN_PROMPT',
    threshold: SUBTRACT_THRESHOLD,
    thresholdVar: 'SAM_SUBTRACT_THRESHOLD',
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

export const normaliseModel = (value) =>
  Object.prototype.hasOwnProperty.call(MODELS, value) ? value : DEFAULT_MODEL;

/**
 * What the browser needs to build the picker, without a second copy of it.
 *
 * `invert` is here because the flip happens in the BROWSER, in the tracer, not
 * on the wire: the Worker returns the same kind of mask either way. The client
 * cannot know a mask needs inverting by looking at it -- that is the whole
 * problem with a bitmap that is 92% white -- so the fact travels with the
 * model description instead.
 */
export const modelCatalogue = () =>
  Object.entries(MODELS).map(([id, m]) => ({
    id,
    label: m.label,
    note: m.note,
    needsPoints: Boolean(m.needsPoints),
    invert: Boolean(m.invert),
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
export function samPrompt(modelId, providerPrompt, env) {
  const m = MODELS[normaliseModel(modelId)];
  if (!m.prompt) return providerPrompt;
  return String(env?.[m.promptVar] || m.prompt).trim();
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
export function samThreshold(env, modelId = DEFAULT_MODEL) {
  const m = MODELS[normaliseModel(modelId)];
  const fallback = typeof m.threshold === 'number' ? m.threshold : DEFAULT_THRESHOLD;
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

