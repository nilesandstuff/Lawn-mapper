/**
 * ONE COUNTY PICTURE OF A FRAME, MADE ON THE SERVER.
 *
 * Whatever the service is -- one that draws any box (export / exportImage) or
 * a tiles-only cache (stitched from its own tiles, tile-mosaic.js) -- the
 * answer is RGBA pixels of exactly the frame's ground at the size asked for.
 *
 * With `align`, the picture is of what the editor SHOWED: the county photo
 * is drawn on the map moved by the editor's alignment (app.js movedCorners),
 * so a pixel of the result shows what the person saw at that spot -- the
 * ground their outlines were drawn on.
 *
 * Possible since the Workers Paid plan (owner, 2026-10-02): a tile cache is
 * tens to hundreds of fetches and a second or two of decoding, which the free
 * plan's 50 fetches and 10 ms could not hold.
 */
import jpeg from 'jpeg-js';
import { decodePng } from './png-probe.js';
import { stitch } from './tile-mosaic.js';
import { serviceMeta, countyServiceById } from './county.js';
import { frameBbox3857, countyBoxUrl, captureFrame, imagePixels, imageHeightPixels } from './imagery.js';
import { encodePng } from './tile-mosaic.js';

/**
 * The box to ask a service for so that, drawn on `bbox` after being moved
 * east/north metres and scaled about the centre (the editor's alignment), it
 * lands where it was shown. tools/county-imagery.js shiftedBbox, the same sum.
 */
export function shiftedBbox(bbox, east, north, scale, lat) {
  const k = 1 / Math.cos((lat * Math.PI) / 180);
  const [w, s, e, n] = bbox;
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const tx = east * k, ty = north * k;
  const inv = (x, y) => [cx + (x - cx - tx) / scale, cy + (y - cy - ty) / scale];
  const [x0, y0] = inv(w, s);
  const [x1, y1] = inv(e, n);
  return [x0, y0, x1, y1];
}

/** PNG or JPEG bytes to RGBA, or null. */
export async function decodeImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xd8) {
    const d = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
    return { width: d.width, height: d.height, data: d.data };
  }
  if (b[0] === 0x89 && b[1] === 0x50) return decodePng(b, { maxPixels: 1 << 24 });
  return null;
}

/** Bilinear resample of RGBA to W x H. */
export function resample(img, W, H) {
  if (img.width === W && img.height === H) return img;
  const out = new Uint8ClampedArray(W * H * 4);
  const sx = img.width / W, sy = img.height / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(img.height - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(img.height - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.max(0, Math.min(img.width - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(img.width - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * img.width + x0) * 4, b = (y0 * img.width + x1) * 4;
      const c = (y1 * img.width + x0) * 4, d = (y1 * img.width + x1) * 4;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) {
        out[o + k] = (img.data[a + k] * (1 - tx) + img.data[b + k] * tx) * (1 - ty)
          + (img.data[c + k] * (1 - tx) + img.data[d + k] * tx) * ty;
      }
    }
  }
  return { width: W, height: H, data: out };
}

/**
 * RGBA of `frame`'s ground from `svc`, W x H, or null when the service has
 * nothing there. `align` = {east, north, scale} as the editor showed it.
 */
export async function countyPicture(svc, frame, { W, H, align = null, fetcher = fetch, maxTiles = 400 } = {}) {
  let bbox = frameBbox3857(frame);
  if (align && (align.east || align.north || (align.scale && align.scale !== 1))) {
    bbox = shiftedBbox(bbox, Number(align.east) || 0, Number(align.north) || 0, Number(align.scale) || 1, frame.lat);
  }
  if (svc.tiled) {
    const m = await serviceMeta(svc.url, fetcher);
    return stitch(svc.url, m, bbox, W, H, { fetcher, maxTiles });
  }
  const res = await fetcher(countyBoxUrl(svc, bbox, W, H), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  const img = await decodeImage(new Uint8Array(await res.arrayBuffer()));
  return img ? resample(img, W, H) : null;
}

/*
 * A MAP MADE ON A COUNTY PHOTO KEEPS THAT PHOTO (owner, 2026-10-02: "save the
 * county photo with those maps").
 *
 * The corpus row still banks Mapbox (storeImage), as every row does; this
 * banks the county photo beside it, in county_imagery -- where training's
 * PHOTOS=county reads -- over the same image_frame at the same pixel size,
 * and with the map's own outlines as the ones traced on it, because they
 * were. Shown moved by the editor's alignment when there was one, so the
 * picture is what the person saw under their outlines.
 */

export const countyImageKey = (id) => `maps/county/${String(id).replace(/[^A-Za-z0-9._-]+/g, '_')}.png`;

export async function storeCountyImage(env, row, { svcId, align = null, fetcher = fetch } = {}) {
  if (!env?.CORPUS || !env?.DB || !row?.frame || row.provider !== 'county') return { ok: false, reason: 'not-county' };
  const svc = await countyServiceById(env, svcId);
  if (!svc) return { ok: false, reason: 'no-service' };
  const shot = captureFrame(row.frame);
  const W = imagePixels(shot.frame), H = imageHeightPixels(shot.frame);
  try {
    const img = await countyPicture(svc, shot.frame, { W, H, align, fetcher });
    if (!img) return { ok: false, reason: 'no-picture' };
    const key = countyImageKey(row.id);
    await env.CORPUS.put(key, await encodePng(img), { httpMetadata: { contentType: 'image/png' } });
    const at = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO county_imagery (id, service, service_type, title, year, native_cm, image_key,
              east, north, scale, checked_at, banked_at, reg_why, shapes, not_lawn, outlines_at, outlines_by)
       SELECT c.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11,
              'made on this photo in the app', c.shapes, c.not_lawn, ?11, 'app'
         FROM corpus c WHERE c.id = ?1
       ON CONFLICT(id) DO UPDATE SET
         service = excluded.service, service_type = excluded.service_type, title = excluded.title,
         year = excluded.year, native_cm = excluded.native_cm, image_key = excluded.image_key,
         east = excluded.east, north = excluded.north, scale = excluded.scale,
         checked_at = excluded.checked_at, banked_at = excluded.banked_at, reg_why = excluded.reg_why,
         shapes = excluded.shapes, not_lawn = excluded.not_lawn,
         outlines_at = excluded.outlines_at, outlines_by = excluded.outlines_by`
    ).bind(row.id, svc.url, svc.tiled ? 'tiles' : svc.type || null, svc.title || null, svc.year || null,
      svc.nativeCm || null, key, Number(align?.east) || 0, Number(align?.north) || 0,
      Number(align?.scale) || 1, at).run();
    return { ok: true, key, W, H };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 120) };
  }
}
