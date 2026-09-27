/**
 * PUBLIC OUTLINES OF THINGS THAT ARE CERTAINLY NOT LAWN, per corpus map,
 * waiting for the owner to look at them.
 *
 * Buildings, water, pools, roads, driveways, parking, sidewalks and rail, as
 * OpenStreetMap, USGS NHD and Microsoft's footprints already draw them
 * (tools/public_negatives.py; workflow 25 fetches them). They can teach the
 * detector "not lawn" on ground nobody traced -- the pond is the case in
 * point: one pond in 55 lots, and the lot that has it is held out whenever it
 * is scored (docs/DETECTOR-FINDINGS.md).
 *
 * THE OWNER SEES THEM FIRST (2026-09-27): "let me see them once you get them
 * set up, and potentially let me tweak them, before saving them as something
 * the detector will be shown." So each map's file is a DRAFT until the owner
 * approves it on /outlines.html, and only approved files are ever read by
 * training. What he drops stays in the file, marked, so a later refetch can
 * tell "rejected" from "new".
 *
 * Stored in R2 beside the photographs, one JSON per map, keyed from the
 * corpus id -- which is checked against the corpus before anything is
 * written, so this can never be made to write outside `outlines/`.
 */

export const OUTLINE_PREFIX = 'outlines/';

/** The R2 key for a corpus id. Encoded so the id's ':' and ',' are harmless. */
export const outlineKey = (id) => `${OUTLINE_PREFIX}${encodeURIComponent(id)}.json`;

/**
 * Every key a map's outlines may be stored under: encoded as outlineKey
 * builds it, or with the id as-is -- the upload goes through wrangler, which
 * may decode the %2C and %3A on the way in (the owner saw a page of maps with
 * no outlines on it, 2026-09-27). The list reads either; so must a lookup.
 */
export const outlineKeys = (id) => [outlineKey(id), `${OUTLINE_PREFIX}${id}.json`];

/** The corpus id back out of a key, or null. */
export const idOfOutlineKey = (key) => {
  if (!key.startsWith(OUTLINE_PREFIX) || !key.endsWith('.json')) return null;
  try { return decodeURIComponent(key.slice(OUTLINE_PREFIX.length, -'.json'.length)); } catch { return null; }
};

export const OUTLINE_CLASSES = ['building', 'water', 'pool', 'road', 'driveway', 'parking', 'sidewalk', 'rail'];

/**
 * What the page sends back, cleaned to what training may read.
 *
 * Only the features that were in the stored draft can be kept or dropped --
 * matched by index and source id -- so a browser cannot slip new geometry
 * into the labels through this route. Editing shapes is a later step; today
 * the owner keeps or drops each one.
 */
export function applyReview(stored, review) {
  const features = Array.isArray(stored?.features) ? stored.features : [];
  const dropped = new Set(
    (Array.isArray(review?.dropped) ? review.dropped : [])
      .filter((i) => Number.isInteger(i) && i >= 0 && i < features.length)
  );
  const status = review?.status === 'approved' ? 'approved' : 'draft';
  return {
    ...stored,
    status,
    reviewedAt: new Date().toISOString(),
    features: features.map((f, i) => ({
      ...f,
      properties: { ...(f.properties || {}), dropped: dropped.has(i) || undefined },
    })),
  };
}
