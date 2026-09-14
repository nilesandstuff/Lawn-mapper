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
const MAX_BYTES = 96 * 1024;

/** Off unless a database is bound. A missing binding is not an error here. */
export const corpusEnabled = (env) => Boolean(env?.DB);

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

const cleanShapes = (list) => (Array.isArray(list) ? list : [])
  .slice(0, 40)
  .map((f) => cleanGeometry(f?.geometry || f))
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
export async function recordFinished(env, body) {
  if (!corpusEnabled(env)) return { ok: false, reason: 'off' };

  const frame = body?.frame && typeof body.frame === 'object' ? {
    lng: num(body.frame.lng), lat: num(body.frame.lat),
    zoom: num(body.frame.zoom), size: num(body.frame.size),
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
  if (!shapes.length) return { ok: false, reason: 'no-shapes' };

  const model = text(body?.model, 40);
  const mode = text(body?.mode, 20);
  const now = new Date().toISOString();

  const row = {
    id: idFor(lng, lat, model, mode),
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
  };

  const size = (row.shapes?.length || 0) + (row.parcel?.length || 0);
  if (size > MAX_BYTES) return { ok: false, reason: 'too-big' };

  try {
    await env.DB.prepare(
      `INSERT INTO corpus (
         id, at, lng, lat, county, provider, model, mode, hand_edited,
         detected_sq_ft, square_feet, parcel_sq_ft, frame, parcel, shapes,
         created_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?2)
       ON CONFLICT(id) DO UPDATE SET
         at = ?2, county = ?5, provider = ?6, hand_edited = ?9,
         detected_sq_ft = ?10, square_feet = ?11, parcel_sq_ft = ?12,
         frame = ?13, parcel = ?14, shapes = ?15`
    ).bind(
      row.id, row.at, row.lng, row.lat, row.county, row.provider, row.model,
      row.mode, row.hand_edited, row.detected_sq_ft, row.square_feet,
      row.parcel_sq_ft, row.frame, row.parcel, row.shapes
    ).run();
    return { ok: true };
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
