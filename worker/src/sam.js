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
export const SAM_INPUT_FIELDS = ['image', 'prompt', 'mask_only', 'save_overlay', 'return_zip'];

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
export function samInput(imageUrl, prompt) {
  return {
    image: imageUrl,
    prompt,
    // The bare mask, not an overlay on the photograph, and not zipped: the
    // browser traces these pixels directly.
    mask_only: true,
    save_overlay: false,
    return_zip: false,
  };
}
