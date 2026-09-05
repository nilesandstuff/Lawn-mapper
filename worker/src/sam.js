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
let cachedVersion = null;

export async function samVersion(env) {
  if (cachedVersion) return cachedVersion;

  const res = await fetch(`https://api.replicate.com/v1/models/${SAM_MODEL}`, {
    headers: { Authorization: `Bearer ${env.REPLICATE_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Could not look up ${SAM_MODEL} (HTTP ${res.status})`);

  const model = await res.json();
  const id = model.latest_version?.id;
  if (!id) throw new Error(`${SAM_MODEL} has no published version to run`);

  cachedVersion = id;
  return id;
}

/** The input object for one segmentation, in one place. */
export function samInput(imageUrl, prompt, threshold = DEFAULT_THRESHOLD) {
  return {
    image: imageUrl,
    prompt,
    // The bare mask, not an overlay on the photograph, and not zipped: the
    // browser traces these pixels directly.
    mask_only: true,
    save_overlay: false,
    return_zip: false,
    threshold,
  };
}
