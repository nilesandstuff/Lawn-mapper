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

/** What the browser needs to build the picker, without a second copy of it. */
export const modelCatalogue = () =>
  Object.entries(MODELS).map(([id, m]) => ({
    id, label: m.label, note: m.note, needsPoints: Boolean(m.needsPoints),
  }));

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

/** The threshold to send, clamped to the range the model accepts. */
export function samThreshold(env) {
  const raw = Number(env?.SAM_THRESHOLD);
  if (!Number.isFinite(raw)) return DEFAULT_THRESHOLD;
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

