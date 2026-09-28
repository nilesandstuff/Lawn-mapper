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

/* ------------------------------------------ not-lawn examples (the real idea) */
/*
 * NEW FRAMES, AWAY FROM OUR MAPS (owner, 2026-09-27): a pond, a house, a pool,
 * a driveway, a car park or a road near our corpus, photographed as a map is,
 * with public outlines on it. Training will teach only the outlined ground as
 * "not lawn" and ignore the rest of the frame. Each is a draft until the owner
 * approves or rejects it on /outlines.html; the outlines he drops stay in the
 * file, marked.
 */
export const EXAMPLE_PREFIX = 'examples/';
const EXAMPLE_ID = /^[a-z]+-\d{3}$/;
export const isExampleId = (id) => EXAMPLE_ID.test(String(id || ''));
export const exampleKey = (id) => `${EXAMPLE_PREFIX}${id}.json`;
export const exampleImageKey = (id) => `${EXAMPLE_PREFIX}${id}.png`;

/** Kept outlines by class, e.g. { water: 1, building: 3 }. */
export function keptByClass(doc) {
  const out = {};
  for (const f of Array.isArray(doc?.features) ? doc.features : []) {
    if (f?.properties?.dropped) continue;
    const c = f?.properties?.class || 'other';
    out[c] = (out[c] || 0) + 1;
  }
  return out;
}

/*
 * OUTLINES MOVED ONTO THE PHOTOGRAPH (owner, 2026-09-28: "we might need to
 * make shapes draggable, or apply the same alignment fix" as NAIP got). A
 * public outline is often a metre or two off the Mapbox photograph. The page
 * finds the shift that lays the outlines on the photo's edges and lets the
 * owner nudge all of them, or drag one. Stored as metres (east, north), never
 * as new geometry: the public shape stays as delivered, training adds the
 * shift, and a shift is bounded so a slip of the finger cannot move a pond
 * into the next field.
 */
/*
 * 60 M, AND NEVER DROPPED SILENTLY (2026-09-28). The first cap was 15 m and a
 * move past it was thrown away without a word while the page showed it
 * moved: the owner went back over approved examples and found outlines where
 * the public map had put them. A pond can sit 20 m off. A frame is at most
 * about 110 m across, so 60 m in either direction is the most any real move
 * needs; past it the move is held AT 60 m (the page holds it there too),
 * never discarded. Only something that is not a number is refused.
 */
export const MAX_SHIFT_M = 60;
export function cleanShift(v) {
  const east = Number(v?.east);
  const north = Number(v?.north);
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  if (!east && !north) return null;
  const hold = (x) => Math.round(Math.max(-MAX_SHIFT_M, Math.min(MAX_SHIFT_M, x)) * 100) / 100;
  return { east: hold(east), north: hold(north) };
}

/** A review of an example: keep/drop by index, shifts, and approve, reject or leave as draft. */
export function reviewExample(stored, review) {
  const saved = applyReview(stored, review);
  saved.status = ['approved', 'rejected'].includes(review?.status) ? review.status : 'draft';
  const all = cleanShift(review?.shift);
  if (all) saved.shift = { ...all, source: review.shift.source === 'auto' ? 'auto' : 'person' };
  else delete saved.shift;
  const each = review?.shifts && typeof review.shifts === 'object' ? review.shifts : {};
  saved.features = saved.features.map((f, i) => {
    const one = cleanShift(each[i]);
    const properties = { ...f.properties };
    if (one) properties.shift = one; else delete properties.shift;
    return { ...f, properties };
  });
  /*
   * WHAT THE OWNER SAW AND KEPT, fixed at review (2026-09-28). Training
   * reads an approved example through keptOutlines() and nothing else: only
   * the outlines listed here, by position, and only if they are still the
   * same count -- so an outline that was not on the page when the owner
   * reviewed it can never be taught, even if the file somehow gained one.
   */
  saved.reviewed = {
    at: saved.reviewedAt,
    count: saved.features.length,
    kept: saved.features.map((f, i) => (f.properties?.dropped ? -1 : i)).filter((i) => i >= 0),
  };
  return saved;
}

/**
 * The outlines training may teach from an example: approved, reviewed, and
 * exactly the ones kept at review. Anything else -- a draft, a rejected
 * example, a file whose outline count changed since review -- gives none.
 */
export function keptOutlines(doc) {
  if (doc?.status !== 'approved') return [];
  const features = Array.isArray(doc.features) ? doc.features : [];
  /* Approved before the record existed (2026-09-28 morning): what was kept
     on the page then. An outline wholly outside the photo has no pixels to
     teach, so the ones that page still listed cost nothing. */
  if (!doc.reviewed) return doc.reviewedAt ? features.filter((f) => !f.properties?.dropped) : [];
  if (features.length !== doc.reviewed.count) return [];
  return doc.reviewed.kept.map((i) => features[i]).filter((f) => f && !f.properties?.dropped);
}
