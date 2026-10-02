/**
 * County orthophotos banked beside the Mapbox photo (tools/county-imagery.js),
 * a person's verdict on whether one lines up (/county.html), and outlines
 * traced on one in the editor.
 */
import { cleanShapes, cleanGeometries, MAX_BYTES } from './corpus.js';
import jpeg from 'jpeg-js';
import { decodePng, looksLikePhoto } from './png-probe.js';
import { isMercatorCache, pickLevel } from './tile-mosaic.js';

/** A service's own JSON, cached at the edge for a day. */
export async function serviceMeta(url, fetcher = fetch) {
  const res = await fetcher(`${url}?f=json`, { signal: AbortSignal.timeout(8000), cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

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

/* ---------------------------------------------------- for any address */

/** The service the editor gets, as the Worker passes it around (frame.svc). */
const svcOf = (r) => (r ? {
  id: Number(r.id), url: r.url, type: r.type, title: r.title, year: r.year,
  nativeCm: r.native_cm, maxPx: r.max_px,
  /* Tiles only: the Worker stitches the frame from them (tile-mosaic.js). */
  tiled: !Number(r.export_ok) && Boolean(Number(r.tile_merc)),
} : null);

/*
 * A box bigger than this is not a county's or a state's: Virginia's VBMP
 * claimed one that took in New Jersey (2026-10-01). 40 square degrees holds
 * any state east of the Rockies.
 */
export const MAX_SERVICE_SQ_DEG = 40;

/**
 * The county or state photos for a point, from county_services, best first:
 * ones that draw an arbitrary box (export_ok), whose box covers the point and
 * is no bigger than a state; the newest flight, then the smallest box (a
 * county's own over a state's), then the finest. The editor tries them in
 * order and takes the first with no gaps over the lot -- a box says where a
 * service might have pictures, not that it has one here.
 */
export async function countyServicesAt(env, lng, lat, n = 4, { probe = true } = {}) {
  if (!env?.DB || !Number.isFinite(lng) || !Number.isFinite(lat)) return [];
  let rows;
  try {
    rows = (await env.DB.prepare(
      `SELECT * FROM county_services
        WHERE (export_ok = 1 OR tile_merc = 1) AND west <= ?1 AND east >= ?1 AND south <= ?2 AND north >= ?2
          AND (east - west) * (north - south) <= ?3
        ORDER BY COALESCE(year, 0) DESC, (east - west) * (north - south) ASC, COALESCE(native_cm, 99) ASC
        LIMIT ?4`
    ).bind(lng, lat, MAX_SERVICE_SQ_DEG, n * 2).all()).results || [];
  } catch { return []; }
  const list = rows.map(svcOf);
  if (!probe) return list.slice(0, n);
  /*
   * AND A LOOK AT THE SPOT ITSELF (owner, 2026-10-02): a box covering the
   * point is not a picture of it. 32 x 32 pixels over 40 m, all candidates at
   * once, four seconds each, cached a week by the edge. A service that does
   * not answer in time is kept, after the ones that showed ground -- the
   * editor's own gap and sharpness checks still stand behind this.
   */
  const verdicts = await Promise.all(list.map((svc) => probeService(svc, lng, lat)));
  const yes = list.filter((_, i) => verdicts[i] === true);
  const unsure = list.filter((_, i) => verdicts[i] === null);
  return [...yes, ...unsure].slice(0, n);
}

/** True: ground here. False: nothing, or not a photo. Null: no answer. */
export async function probeService(svc, lng, lat, { fetcher = fetch } = {}) {
  const R = 6378137;
  const x = (lng * Math.PI / 180) * R;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
  /* A tile cache: the one tile over the spot, at about 30 cm. */
  if (svc.tiled) {
    try {
      const m = await serviceMeta(svc.url, fetcher);
      if (!isMercatorCache(m)) return null;
      const ti = m.tileInfo, size = ti.rows || 256;
      const pick = pickLevel(m, 0.3 / Math.cos((lat * Math.PI) / 180));
      if (!pick) return null;
      const l = pick.byRes[pick.at];
      const span = l.resolution * size;
      const res = await fetcher(`${svc.url}/tile/${l.level}/${Math.floor((ti.origin.y - y) / span)}/${Math.floor((x - ti.origin.x) / span)}`,
        { signal: AbortSignal.timeout(4000), cf: { cacheTtl: 604800, cacheEverything: true } });
      if (res.status === 404) return false;
      if (!res.ok) return null;
      const b = new Uint8Array(await res.arrayBuffer());
      const img = b[0] === 0xff ? (() => { const d = jpeg.decode(b, { useTArray: true, formatAsRGBA: true }); return { width: d.width, height: d.height, data: d.data }; })()
        : await decodePng(b);
      return img ? looksLikePhoto(img) : null;
    } catch { return null; }
  }
  const half = 20 / Math.cos((lat * Math.PI) / 180);
  const params = new URLSearchParams({
    bbox: [x - half, y - half, x + half, y + half].join(','), bboxSR: '3857', imageSR: '3857',
    size: '32,32', format: 'png32', transparent: 'true', f: 'image',
  });
  const url = `${svc.url}/${svc.type === 'ImageServer' ? 'exportImage' : 'export'}?${params}`;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(4000), cf: { cacheTtl: 604800, cacheEverything: true } });
    if (!res.ok) return null;
    const img = await decodePng(new Uint8Array(await res.arrayBuffer()));
    return img ? looksLikePhoto(img) : null;
  } catch { return null; }
}

/** The best one, or null. */
export async function countyServiceAt(env, lng, lat) {
  return (await countyServicesAt(env, lng, lat, 1, { probe: false }))[0] || null;
}

/** One service by its id, only if it is in the catalogue and can draw a box. */
export async function countyServiceById(env, id) {
  const n = Number(id);
  if (!env?.DB || !Number.isInteger(n) || n <= 0) return null;
  try {
    return svcOf(await env.DB.prepare('SELECT * FROM county_services WHERE id = ?1 AND (export_ok = 1 OR tile_merc = 1)').bind(n).first());
  } catch { return null; }
}
