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
 * The two ways to ask.
 *
 * A text prompt is one press and finds every patch at once, including the
 * disconnected ones a person would forget. What it cannot do is be argued
 * with: when it decides a shaded strip is not grass, there is no way to say
 * "yes it is" -- only to draw the strip by hand afterwards. Point prompts are
 * the other trade: slower, and you are telling it exactly what to include.
 *
 * Neither is better in general, so both are offered and the person picks per
 * property. They differ in what they need from the browser, which is why this
 * is a table rather than a slug: `needsPoints` drives the whole interaction,
 * and `input` is the only place the wire format for each model lives.
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
   * The point-prompted one.
   *
   * A note on what this is, because the obvious choice does not exist:
   * meta/sam-2 on Replicate is the AUTOMATIC mask generator -- image, use_m2m,
   * points_per_side -- with no way to say "this patch". Of everything
   * tools/find-sam-model.js could reach, exactly three take point prompts:
   *
   *   meta/sam-2-video       real SAM 2, binary masks, wants a VIDEO file --
   *                          which a Worker cannot build from one PNG
   *   casia-iva-lab/fastsam  well used, point_prompt/point_label documented,
   *                          but it returns the photograph with masks drawn
   *                          ON it and has no mask_only, so the tracer would
   *                          be reading colours off an annotated picture
   *   ocg2347/sam-pointprompt   image + input_points, and nothing else
   *
   * So this one, by elimination rather than enthusiasm. It is lightly used
   * (about 1,800 runs) and publishes no description of its point format or its
   * output, which is why tools/probe-points.js exists: the format is settled by
   * one paid prediction rather than by a guess that fails in production.
   *
   * Overridable by env, so a better model can be swapped in without a deploy
   * of new code -- which matters more than usual for a dependency this thin.
   */
  sam2: {
    slug: 'ocg2347/sam-pointprompt',
    slugVar: 'SAM2_MODEL',
    label: 'Precise',
    note: 'You place pins on the lawn and it segments exactly what you point at. Slower, but it cannot decide your grass is not grass.',
    needsPoints: true,
    fields: ['image', 'input_points'],
    // Pixel coordinates in the image we send, which is the convention every
    // SAM port uses. Sent as JSON in a string because the schema types this
    // field as a string, not an array.
    input: (image, { points }) => ({
      image,
      input_points: JSON.stringify(points),
    }),
  },
};

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
 * Note what that table does NOT contain: a plateau. Recovered area climbs
 * smoothly all the way to 0.05, so no threshold is picked out as correct by
 * the numbers, and any claim that one is would be invented. This is a choice
 * about which way to be wrong.
 *
 * Inclusive is the right way to be wrong here. A patch that should not be
 * there is visible on the map and one tap to delete; a patch that is missing
 * is invisible unless the owner happens to know their own back lawn is gone,
 * and it silently understates every quote built on the number. 0.1 lands at
 * about a third of this lot, which is credible for a property carrying a
 * house, a pool, a patio and a drive.
 *
 * Overridable with a SAM_THRESHOLD variable, because the right value is a
 * property of the imagery and not something to hard-code forever.
 */
export const DEFAULT_THRESHOLD = 0.1;

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

