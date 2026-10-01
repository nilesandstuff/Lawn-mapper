/**
 * County orthophotos banked beside the Mapbox photo (tools/county-imagery.js),
 * a person's verdict on whether one lines up (/county.html), and outlines
 * traced on one in the editor.
 */
import { cleanShapes, cleanGeometries, MAX_BYTES } from './corpus.js';

/* A nudge is a correction on top of what the alignment found; the search
   itself reaches 10 m, so a correction past that is a different photo. */
export const MAX_NUDGE_M = 10;

/**
 * The verdict a page may store: 'ok' (lines up, use it), 'off' (do not use)
 * or null (not judged), and a further nudge in metres for the rebank pass.
 * Anything else is refused rather than guessed at.
 */
export function cleanCountyReview(body) {
  const review = body?.review === null || body?.review === undefined ? null : String(body.review);
  if (review !== null && review !== 'ok' && review !== 'off') return null;
  const metres = (v) => {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n)) return null;
    return Math.round(Math.max(-MAX_NUDGE_M, Math.min(MAX_NUDGE_M, n)) * 100) / 100;
  };
  const east = metres(body?.east);
  const north = metres(body?.north);
  if (east === null || north === null) return null;
  return { review, east, north };
}

/**
 * Outlines traced on a county photo (owner, 2026-10-01: "add an edit button
 * so I can make the necessary changes to the outlines"). Cleaned exactly as a
 * finished map's are -- the same shapes, the same inferred flag, the same
 * not-lawn traces -- so training reads them the same way. Lawn or not-lawn,
 * at least one; null for anything else, or too big.
 */
export function cleanCountyOutlines(body) {
  const shapes = cleanShapes(body?.shapes);
  const notLawn = cleanGeometries(body?.notLawn);
  if (!shapes.length && !notLawn.length) return null;
  const out = { shapes: JSON.stringify(shapes), notLawn: notLawn.length ? JSON.stringify(notLawn) : null };
  if (out.shapes.length + (out.notLawn?.length || 0) > MAX_BYTES) return null;
  return out;
}
