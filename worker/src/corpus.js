/**
 * Keeps finished lawn maps, to train a segmentation model on later.
 *
 * One row per finished measurement: where it is, what the detector said, what
 * the person ended up with, and the outline itself. No address, no account, no
 * image -- see the table comment in schema.sql for why each of those is absent
 * rather than forgotten.
 *
 * NEVER THROWS AND NEVER BLOCKS. This is bookkeeping for a model that does not
 * exist yet, and a measurement that worked must not turn into an error because
 * a corpus write failed. Every path returns a reason instead.
 */

import { captureFrame, imageryUrl } from './imagery.js';

const round = (n) => Math.round(n * 1e6) / 1e6;
/*
 * `Number(null)` IS ZERO, and that is not a missing value.
 *
 * Caught by the tests here rather than in the field, where it would have been
 * invisible twice over. A map with no coordinates would have been written at
 * 0,0 -- a real point in the Atlantic -- instead of being refused, quietly
 * seeding the corpus with lawns in the ocean. And a lawn drawn entirely by
 * hand would have recorded the detector as finding ZERO square feet rather
 * than as never having run, which is a different claim and the wrong one: it
 * says the AI failed completely on a lot it was never asked about.
 *
 * Empty string goes the same way for the same reason. Only a real number, or
 * nothing.
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/*
 * The same ceiling the feedback store uses, and for the same reason: one lawn
 * is a few KB of coordinates, so anything approaching this is not a lawn.
 */
export const MAX_BYTES = 96 * 1024;

/** Off unless a database is bound. A missing binding is not an error here. */
export const corpusEnabled = (env) => Boolean(env?.DB);

/**
 * Which imagery to BANK for a lawn drawn on a given source.
 *
 * Not always the source it was drawn on, and the difference is the owner's
 * decision after reading Mapbox's and Google's terms rather than mine.
 *
 *   drawn on          banked         why
 *   mapbox            mapbox         the same photograph; nothing to reconcile
 *   naip, ndvi        naip           both are the USGS server, NDVI is a
 *                                    rendering rule over the same pixels
 *   google, esri      mapbox         Google's terms are the restrictive ones,
 *                                    and Esri's are its own question -- so
 *                                    neither is stored, and the Mapbox tile
 *                                    for the identical frame is banked instead
 *
 * The last row is a deliberate mismatch: the outline was drawn on one
 * photograph and paired with another of the same place, possibly a different
 * season or year. Close enough to be useful and not close enough to hide, so
 * `image_provider` records what was actually stored and the export can filter
 * on it. Anything unknown lands on mapbox, which is the safe default because
 * it is the one source this deployment is certain to have a key for.
 */
export function imageSourceFor(provider) {
  return provider === 'naip' || provider === 'ndvi' ? 'naip' : 'mapbox';
}

/**
 * Where one map's picture lives in the bucket.
 *
 * The row id carries commas and colons, which are legal in an R2 key and
 * miserable in a URL and a shell, so they are flattened. Grouped by banked
 * source because that is how a training run wants to pull them: everything
 * NAIP, or everything Mapbox, not a mixed directory to be sorted afterwards.
 */
export const imageKeyFor = (id, source) =>
  `maps/${source}/${String(id).replace(/[^A-Za-z0-9._-]+/g, '_')}.png`;

/**
 * Fetch the aerial photograph for one finished map and keep it.
 *
 * SEPARATE FROM THE ROW, and after it. The row is a few KB of D1 and lands in
 * milliseconds; this is a megabyte or two over the network from somebody
 * else's server. Making the person who just pressed Finish wait for it -- or
 * lose the row entirely because the image 500s -- would be paying for the
 * corpus with the thing the corpus is supposed to improve.
 *
 * Runs under waitUntil, which is not the same as fire-and-forget: a Worker
 * cancels any promise still pending when the handler returns, so an unawaited
 * call here would store nothing at all. The detection log learned that one the
 * hard way; see index.js.
 */
export async function storeImage(env, row) {
  if (!env?.CORPUS || !env?.DB || !row?.frame) return { ok: false, reason: 'no-bucket' };

  const source = imageSourceFor(row.provider);
  const token = env.MAPBOX_SERVER_TOKEN || env.MAPBOX_TOKEN;
  if (source === 'mapbox' && !token) return { ok: false, reason: 'no-token' };

  /*
   * CAPTURED AT THE DETECTOR'S SCALE, not at the phone's.
   *
   * The display frame fits the parcel into a fixed 640 logical pixels, so its
   * resolution is a side effect of lot size -- which is H20, and is why the
   * canopy model read worse on big lawns. This asks for 10 cm a pixel or
   * better wherever one request can reach it, and never for less than the
   * display frame already managed.
   */
  const shot = captureFrame(row.frame);
  const url = imageryUrl(source, shot.frame, token, env);
  if (!url) return { ok: false, reason: 'no-url' };

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const type = res.headers.get('content-type') || '';
    /*
     * Both sources answer a bad request with a JSON error and a 200, so the
     * content type is the only thing that separates a photograph from an
     * apology. Storing the apology would fill the bucket with 200-byte files
     * that look like coverage.
     */
    if (!type.startsWith('image/')) return { ok: false, reason: 'not-an-image' };

    const key = imageKeyFor(row.id, source);
    await env.CORPUS.put(key, res.body, { httpMetadata: { contentType: type } });
    /* The frame the picture was taken on travels with it. A mask rasterised
       against the display frame would not line up with a photograph taken at a
       different zoom, and nothing downstream should have to infer which. */
    await env.DB.prepare(
      'UPDATE corpus SET image_key = ?2, image_provider = ?3, image_frame = ?4 WHERE id = ?1'
    ).bind(row.id, key, source, JSON.stringify(shot.frame)).run();
    return {
      ok: true, key, source,
      groundCm: Math.round(shot.groundM * 1000) / 10,
      capped: shot.capped,
    };
  } catch (e) {
    return { ok: false, reason: e?.name === 'TimeoutError' ? 'timed-out' : 'fetch-failed' };
  }
}

/**
 * How NAIP lines up with Mapbox on this map, as the editor sends it, or null.
 *
 * Bounded rather than trusted: a shift past 20 m or a scale past 5% is not
 * NAIP being a little off, it is a bug or somebody's thumb, and storing it
 * would move a lawn's near-infrared onto the neighbour's house.
 */
export function naipAlignOf(a) {
  if (!a || typeof a !== 'object') return null;
  const east = Number(a.east), north = Number(a.north), scale = Number(a.scale ?? 1);
  if (![east, north, scale].every(Number.isFinite)) return null;
  if (Math.abs(east) > 20 || Math.abs(north) > 20 || Math.abs(scale - 1) > 0.05) return null;
  const source = a.source === 'person' ? 'person' : 'auto';
  const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  return JSON.stringify({ east: r(east, 2), north: r(north, 2), scale: r(scale, 4), source });
}

/**
 * One ring, cleaned to finite numbers at six decimal places.
 *
 * Six is about eleven centimetres, which is finer than any lawn edge is
 * knowable and a third of the bytes of a raw double. The same rounding the
 * feedback store uses -- a corpus of seventeen-digit coordinates is mostly
 * noise by volume.
 */
function cleanGeometry(g, maxRings = 60, maxPoints = 6000) {
  if (!g || typeof g !== 'object') return null;
  const rings = g.type === 'Polygon' ? g.coordinates
    : g.type === 'MultiPolygon' ? (g.coordinates || []).flat()
      : null;
  if (!Array.isArray(rings)) return null;

  const out = [];
  let points = 0;
  for (const ring of rings.slice(0, maxRings)) {
    if (!Array.isArray(ring)) continue;
    const clean = [];
    for (const p of ring) {
      if (points >= maxPoints) break;
      const lng = Number(p?.[0]);
      const lat = Number(p?.[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      clean.push([round(lng), round(lat)]);
      points++;
    }
    if (clean.length >= 4) out.push(clean);
  }
  return out.length ? { type: 'Polygon', coordinates: out } : null;
}

/**
 * The outlines, as GeoJSON Features rather than bare geometries.
 *
 * THIS USED TO DROP PROPERTIES, and that was invisible until there was a
 * property worth keeping. Shapes can now be marked "I know this is lawn, I
 * cannot see it" -- grass under a canopy with lawn either side -- and that
 * mark is the only thing separating a detector that bridges what cannot be
 * seen from one that has stopped looking at what can. Stripped here, the flag
 * left the browser, survived the wire, and vanished one line before the
 * database: set in the app, gone from the training, with nothing anywhere
 * saying so.
 *
 * WRITTEN AS FEATURES, READ AS EITHER. Every row stored before today holds
 * bare geometries, and they stay perfectly readable -- `geometries()` in the
 * training tools already accepts both, and the console now does too. Writing
 * the richer form from here means the corpus converges on it as maps are
 * re-finished, without a migration over a TEXT column full of JSON.
 *
 * Unmarked shapes carry an empty properties object rather than the flag set
 * false. "Not marked" and "marked as seen" are the same thing, and a false
 * that has to be written everywhere is a false that will be missed somewhere.
 */
/**
 * The detector's own outlines, as bare geometries.
 *
 * Separate from cleanShapes, and it must stay separate. Both cleaned the same
 * way until the traced shapes needed somewhere to carry the inferred flag, and
 * sharing the richer form here would have changed a column nothing asked to
 * change -- for no gain, because the detector has no opinion about what it
 * could not see. It draws what is in the picture. That is the whole of it.
 */
export const cleanGeometries = (list) => (Array.isArray(list) ? list : [])
  .slice(0, 40)
  .map((f) => cleanGeometry(f?.geometry || f))
  .filter(Boolean);

export const cleanShapes = (list) => (Array.isArray(list) ? list : [])
  .slice(0, 40)
  .map((f) => {
    const geometry = cleanGeometry(f?.geometry || f);
    if (!geometry) return null;
    return {
      type: 'Feature',
      properties: f?.properties?.inferred === true ? { inferred: true } : {},
      geometry,
    };
  })
  .filter(Boolean);

/**
 * One row per place and method.
 *
 * Derived from the coordinates rather than the address, because the address is
 * deliberately not stored -- and rounded to five decimal places, about a
 * metre, so that finishing the same lawn twice updates one row instead of
 * leaving two nearly identical examples to be drawn in the same training
 * batch. Two genuinely different houses are never a metre apart.
 */
function idFor(lng, lat, model, mode) {
  const at = `${lng.toFixed(5)},${lat.toFixed(5)}`;
  return `${at}:${model || 'manual'}:${mode || 'find'}`;
}

/**
 * Record one finished map. Returns { ok } or { ok: false, reason }.
 *
 * Upserts: a person who finishes, corrects further and finishes again should
 * leave their best answer behind, not their first one and their best one.
 */
export async function recordFinished(env, body, { adminId = null } = {}) {
  if (!corpusEnabled(env)) return { ok: false, reason: 'off' };

  const frame = body?.frame && typeof body.frame === 'object' ? {
    lng: num(body.frame.lng), lat: num(body.frame.lat),
    zoom: num(body.frame.zoom), size: num(body.frame.size), height: num(body.frame.height) || num(body.frame.size),
  } : null;

  /*
   * The centre comes from the frame first. That is where the PHOTOGRAPH was
   * taken, which is the thing being re-fetched later; the geocoded point is
   * only where the address sits, and on a long lot they are not the same
   * place. Same ordering the review page needed, for the same reason.
   */
  const lng = Number.isFinite(frame?.lng) ? frame.lng : num(body?.lng);
  const lat = Number.isFinite(frame?.lat) ? frame.lat : num(body?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return { ok: false, reason: 'no-location' };
  }

  const shapes = cleanShapes(body?.shapes);
  /*
   * NOT-LAWN TRACES AND NO LAWN (tinker mode, owner 2026-10-01) is a map too:
   * a parking lot, a road. It is stored with status 'notlawn', never 'new',
   * so it stays out of the review queue and out of every query that reads
   * approved maps as lawns -- an empty lawn there would teach "nothing on this
   * lot is lawn", which nobody said.
   */
  const notLawnOnly = !shapes.length && Array.isArray(body?.notLawn)
    && cleanGeometries(body.notLawn).length > 0;
  if (!shapes.length && !notLawnOnly) return { ok: false, reason: 'no-shapes' };

  const model = text(body?.model, 40);
  const mode = text(body?.mode, 20);
  const now = new Date().toISOString();

  /*
   * AN ID THE CALLER ALREADY KNOWS BEATS ONE DERIVED AGAIN.
   *
   * idFor builds a key out of the frame centre at five decimal places -- about
   * a metre -- and the upsert below UPDATES the frame while leaving the id
   * alone. So a map whose frame has moved since it was created has an id that
   * no longer matches its own coordinates, and re-saving it derived a
   * different key and wrote a SECOND row: the same lawn twice, one with the
   * reviewer's inferred marks and one without, both approved.
   *
   * Leave-one-out then trains on one copy and tests on its twin, which reports
   * a number far better than the model has earned. Duplicates are not untidy
   * here, they are a lie in the measurement.
   *
   * Shape-checked rather than trusted: this endpoint takes whatever a browser
   * posts, and an id is no more sensitive than the coordinates it would
   * otherwise be built from -- but a value that is not id-shaped is a bug
   * somewhere, and writing it would scatter rows nothing can find again.
   */
  const given = text(body?.id, 120);
  const known = given && /^-?\d+\.\d+,-?\d+\.\d+:[^:]*:[^:]*$/.test(given) ? given : null;

  const row = {
    id: known || idFor(lng, lat, model, mode),
    at: now,
    lng: round(lng),
    lat: round(lat),
    county: text(body?.county, 80),
    provider: text(body?.provider, 30),
    model,
    mode,
    hand_edited: body?.handEdited ? 1 : 0,
    detected_sq_ft: num(body?.detectedSqFt),
    square_feet: num(body?.squareFeet),
    parcel_sq_ft: num(body?.parcelSqFt),
    frame: frame ? JSON.stringify(frame) : null,
    parcel: (() => {
      const p = cleanGeometry(body?.parcel?.geometry || body?.parcel);
      return p ? JSON.stringify(p) : null;
    })(),
    shapes: JSON.stringify(shapes),
    /* See the upsert below: one marked shape settles the question for the
       whole map, and nothing marked settles nothing. */
    inferred_checked_at: shapes.some((f) => f.properties?.inferred) ? now : null,
    /*
     * Cleaned exactly like `shapes`, and allowed to be empty.
     *
     * A detection that found nothing is a real and interesting example -- it
     * is the detector being wrong in the most complete way available -- so an
     * empty list is stored as an empty list, not turned into null. Null here
     * means "there was never a detection", which is the hand-drawn case and a
     * different thing entirely.
     */
    detected_shapes: Array.isArray(body?.detectedShapes)
      ? JSON.stringify(cleanGeometries(body.detectedShapes))
      : null,
    /*
     * Only the two values this can mean. Anything else is somebody's typo
     * arriving from a client we do not control, and storing it would put a
     * third category into a column the export reads as a pair.
     */
    parcel_source: ['county', 'hand'].includes(body?.parcelSource)
      ? body.parcelSource
      : null,
    naip_align: naipAlignOf(body?.naipAlign),
    /*
     * NOT-LAWN TRACES (tinker mode, owner 2026-09-29), cleaned like any
     * geometry. Null when the finish did not say -- which every ordinary
     * finish does not -- and an empty list when somebody deleted them all.
     */
    /* The trained model's release, with the outline it drew (loop 1). */
    model_version: text(body?.modelVersion, 40),
    not_lawn: Array.isArray(body?.notLawn)
      ? JSON.stringify(cleanGeometries(body.notLawn))
      : null,
    exclusions: Array.isArray(body?.exclusions) && body.exclusions.length
      ? text(body.exclusions.filter((e) => typeof e === 'string').join(','), 200)
      : null,
    /* From the session, never from the body: a flag a browser could set for
       itself would say nothing about who saved the map. */
    admin_edited_at: adminId ? now : null,
    admin_edited_by: adminId ? text(String(adminId), 80) : null,
  };

  const size = (row.shapes?.length || 0) + (row.parcel?.length || 0) + (row.not_lawn?.length || 0);
  if (size > MAX_BYTES) return { ok: false, reason: 'too-big' };

  try {
    await env.DB.prepare(
      `INSERT INTO corpus (
         id, at, lng, lat, county, provider, model, mode, hand_edited,
         detected_sq_ft, square_feet, parcel_sq_ft, frame, parcel, shapes,
         detected_shapes, parcel_source, exclusions, created_at,
         inferred_checked_at, naip_align, not_lawn, model_version,
         admin_edited_at, admin_edited_by, status
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?2,?19,?20,?21,?22,?23,?24,?25)
       ON CONFLICT(id) DO UPDATE SET
         at = ?2, county = ?5, provider = ?6, hand_edited = ?9,
         detected_sq_ft = ?10, square_feet = ?11, parcel_sq_ft = ?12,
         frame = ?13, parcel = ?14, shapes = ?15,
         /*
          * COALESCE, NOT ASSIGNMENT, and this one is a trap worth naming.
          *
          * Reopening a saved map deliberately clears the detector's outline --
          * carrying it over would pair one lawn's detection with another
          * lawn's correction. But that means finishing after a review edit
          * arrives here with nothing, and a plain assignment would write that
          * nothing over the stored original, deleting the only record of what
          * the AI actually drew. Silent, permanent, and precisely the thing
          * that makes the overshoot measurable.
          *
          * So a fresh detection replaces it and an absent one leaves it alone.
          */
         detected_shapes = COALESCE(?16, corpus.detected_shapes),
         parcel_source = ?17, exclusions = ?18,
         /*
          * EDITING AN OUTLINE INVALIDATES ITS APPROVAL. The approval was of
          * the shape, and the shape just changed -- carrying it forward would
          * mark work as verified that nobody has looked at.
          *
          * This is also the review-edit flow working as designed: tweak,
          * finish, and the row comes back to the top of the queue to be
          * approved in its corrected form.
          */
         status = ?25, reviewed_at = NULL, reviewed_by = NULL,
         review_note = NULL, review_queue = NULL,
         /*
          * MARKING A SHAPE IS PROOF SOMEBODY LOOKED, so a map that arrives
          * carrying one is checked by definition and never needs to appear in
          * the catch-up queue.
          *
          * The reverse does not hold, which is why this is COALESCE and why
          * the console has its own button: a map with NO marks is either one
          * with nothing to mark or one nobody has been asked about, and only
          * a person can say which. Assignment here would also un-check a map
          * every time its outline was edited afterwards.
          */
         inferred_checked_at = COALESCE(?19, corpus.inferred_checked_at),
         /* A finish without looking at NAIP says nothing about NAIP, so it
            must not erase an alignment somebody set. */
         naip_align = COALESCE(?20, corpus.naip_align),
         /* A finish that sent no not-lawn list (every ordinary one) leaves
            the owner's traces alone; one that sent a list, even an empty
            one, replaces them. */
         not_lawn = COALESCE(?21, corpus.not_lawn),
         /* Travels with detected_shapes: a fresh detection brings its own
            release (or none, for SAM), an absent one leaves both alone. */
         model_version = CASE WHEN ?16 IS NOT NULL THEN ?22 ELSE corpus.model_version END,
         /* Once an admin has saved it, it stays marked: a later save by
            somebody else does not undo that an admin fixed it. */
         admin_edited_at = COALESCE(?23, corpus.admin_edited_at),
         admin_edited_by = COALESCE(?24, corpus.admin_edited_by)`
    ).bind(
      row.id, row.at, row.lng, row.lat, row.county, row.provider, row.model,
      row.mode, row.hand_edited, row.detected_sq_ft, row.square_feet,
      row.parcel_sq_ft, row.frame, row.parcel, row.shapes,
      row.detected_shapes, row.parcel_source, row.exclusions,
      row.inferred_checked_at, row.naip_align, row.not_lawn, row.model_version,
      row.admin_edited_at, row.admin_edited_by, notLawnOnly ? 'notlawn' : 'new'
    ).run();
    /*
     * The row is handed back so the caller can pass it to storeImage under
     * waitUntil. Returning the id rather than having recordFinished fetch the
     * picture itself keeps the two failures separate: a row that saved and an
     * image that did not is a good outcome, and lumping them together would
     * lose the row whenever somebody else's image server was having a bad
     * afternoon.
     */
    return { ok: true, row: { id: row.id, provider: row.provider, frame } };
  } catch {
    return { ok: false, reason: 'store' };
  }
}

/**
 * What has been collected, for the console.
 *
 * Counts rather than rows: the question this answers is "is there enough yet,
 * and how much of it is worth anything", and the second half is why the
 * hand-edited and per-provider splits are here rather than one total. A corpus
 * that is ten thousand untouched AI outputs is a corpus of nothing.
 */
export async function corpusSummary(env) {
  if (!corpusEnabled(env)) return null;
  try {
    const total = await env.DB.prepare(
      `SELECT COUNT(*) AS n,
              SUM(hand_edited) AS edited,
              SUM(CASE WHEN detected_sq_ft IS NULL THEN 1 ELSE 0 END) AS by_hand
         FROM corpus`
    ).first();
    const byProvider = await env.DB.prepare(
      `SELECT provider, COUNT(*) AS n, SUM(hand_edited) AS edited
         FROM corpus GROUP BY provider ORDER BY n DESC`
    ).all();
    return {
      total: total?.n || 0,
      handEdited: total?.edited || 0,
      drawnFromScratch: total?.by_hand || 0,
      byProvider: byProvider?.results || [],
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ what is still needed */

/*
 * The targets a first useful fine-tune is aimed at, from docs/training-data.md.
 *
 * Every one of these is a considered guess rather than a measurement, and they
 * are here rather than in the page so there is one place to change when the
 * corpus starts answering the questions the doc leaves open. Changing a number
 * here changes the advice everywhere.
 */
export const TARGETS = {
  maps: 1000,       // enough to fine-tune at all
  corrected: 300,   // the binding one -- see below
  blocks: 60,       // independent places, roughly 1 km apart
  counties: 5,      // enough for leave-one-county-out to mean anything
  /*
   * Lawns where CANOPY DECIDED THE EDGE -- the hard slice, and the fault the
   * whole exercise exists to fix.
   *
   * Not "lawns with trees on them", which in a wooded county is every lawn:
   * a flag true of everything selects nothing, and a target you meet by
   * approving anything is not a target. See the review route for the grade.
   */
  heavyCanopy: 150,
};

/**
 * What to go and map next, most-needed first.
 *
 * A COUNT ALONE DOES NOT TELL SOMEBODY WHERE TO SPEND A SATURDAY. "412 maps"
 * reads like progress whether those 412 are spread over four states or sitting
 * in one cul-de-sac, and the second is worth a fraction of the first. Each
 * target here is a different way the pile can be lopsided, and the ranking is
 * simply which one is furthest behind.
 *
 * Pure, and separate from the SQL, so the advice can be checked against made-up
 * corpora without a database -- including the lopsided ones that are the whole
 * reason it exists.
 */
export function corpusGaps(stats = {}, targets = TARGETS) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const gaps = [
    {
      key: 'corrected',
      label: 'Maps where you disagreed with the AI',
      have: n(stats.corrected),
      need: targets.corrected,
      why: 'The only evidence of what the detector gets wrong, and much rarer '
        + 'than finished maps. This is the number that decides when there is '
        + 'enough to train on.',
      what: 'Map properties the AI is likely to struggle with, and fix what it '
        + 'gets wrong rather than accepting a close-enough outline.',
    },
    {
      key: 'heavyCanopy',
      label: 'Lawns where canopy decided the edge',
      have: n(stats.heavyCanopy),
      need: targets.heavyCanopy,
      why: 'The known fault is a tree line overshooting by about a quarter. '
        + 'Without these there is no way to tell whether a fix worked.',
      what: 'Lots where the lawn runs under a canopy edge and you had to '
        + 'decide where the grass stops — then mark canopy as "decided the '
        + 'edge" when you review it, since that is what this counts. Trees '
        + 'merely being present is not it; on a wooded street that is every '
        + 'lawn, and a number that counts every map is not a gap.',
    },
    {
      key: 'blocks',
      label: 'Separate places (about a kilometre apart)',
      have: n(stats.blocks),
      need: targets.blocks,
      why: 'Houses on one street share grass, sun angle and the day the photo '
        + 'was taken, so twenty maps from one street count for little more '
        + 'than one.',
      what: 'Spread out. A few maps in many neighbourhoods beat many maps in '
        + 'one.',
    },
    {
      key: 'counties',
      label: 'Counties',
      have: n(stats.counties),
      need: targets.counties,
      why: 'The only way to find out whether the model travels to a part of '
        + 'the country it has never seen.',
      what: 'Map a few properties somewhere genuinely far away, even a handful.',
    },
    {
      key: 'maps',
      label: 'Finished maps in total',
      have: n(stats.total),
      need: targets.maps,
      why: 'Accepted maps are most of what a model will meet and are where its '
        + 'sense of an ordinary lawn comes from.',
      what: 'Anything at all. This one only needs volume.',
    },
  ];

  for (const g of gaps) {
    g.done = g.have >= g.need;
    g.remaining = Math.max(0, g.need - g.have);
    g.share = g.need > 0 ? Math.min(1, g.have / g.need) : 1;
  }

  /*
   * Furthest behind first, and finished ones last rather than dropped -- a
   * target that has been MET is information too, and hiding it makes a page
   * that only ever shows bad news.
   */
  return gaps.sort((a, b) => (a.done === b.done ? a.share - b.share : a.done ? 1 : -1));
}

/* ------------------------------------------------------- the review queue */

/**
 * How much reviewing this candidate would be worth, given what the set lacks.
 *
 * SCARCITY DECIDES, not any property of the map on its own. A heavy-canopy lawn
 * is worth a lot when there are nine of them and very little when there are
 * four hundred, so every term below is switched off once its target in
 * `corpusGaps` is met. Otherwise the queue would spend somebody's afternoon
 * deepening a pile that is already deep enough.
 *
 * Pure, and scored against a snapshot of what is already approved rather than
 * against the row's own merits, so the ordering can be checked against
 * made-up corpora -- including the lopsided ones it exists to fix.
 */
export function candidateScore(row = {}, have = {}, targets = TARGETS) {
  const short = (key, target) => (Number(have[key]) || 0) < target;
  let score = 0;
  const why = [];

  const detected = row.detected_sq_ft;
  const final = row.square_feet;
  const corrected = detected === null || detected === undefined
    ? true
    : Number(detected) > 0 && Math.abs(final - detected) * 10 >= Number(detected);

  if (corrected && short('corrected', targets.corrected)) {
    score += 50;
    why.push(detected === null || detected === undefined
      ? 'drawn by hand' : 'you disagreed with the AI');
  }
  /*
   * STILL THE EXCLUSION LIST HERE, and deliberately, even though the COUNT no
   * longer uses it. Ordering a queue is guessing which candidate is worth
   * looking at next, and a guess is all this has to be -- somebody ticked
   * Trees, so there are probably trees. The count is a different job: it says
   * how many tree lines are actually in the set, and only an eye on the
   * photograph can answer that.
   */
  if (/woods/.test(row.exclusions || '') && short('heavyCanopy', targets.heavyCanopy)) {
    score += 30;
    why.push('trees were excluded, so probably heavy canopy');
  }
  /*
   * A place nobody has approved anything in yet. Worth more than another map
   * from a street already covered, because twenty maps from one street count
   * for little more than one.
   */
  if (row.new_block && short('blocks', targets.blocks)) {
    score += 25;
    why.push('somewhere new');
  }
  if (row.new_county && short('counties', targets.counties)) {
    score += 40;
    why.push('a county with nothing approved yet');
  }
  /*
   * NO PICTURE, NO TRAINING EXAMPLE. The outline is still fine and the frame
   * can re-fetch, but nothing can be trained on it as it stands -- so it sinks
   * rather than being hidden, because it is still reviewable and still counts.
   */
  if (!row.image_key) {
    score -= 35;
    why.push('no photograph stored yet');
  }

  return { score, why };
}
