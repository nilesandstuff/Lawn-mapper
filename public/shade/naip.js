/**
 * HOW GREEN EACH SQUARE METER IS IN THE SUMMER AERIAL PHOTO (owner,
 * 2026-11-04: "I just don't want us to be seeing structures where there
 * aren't any"; structures.js uses it to keep small trees from being called
 * sheds).
 *
 * NAIP, the USDA's National Agriculture Imagery Program, flies the lower 48
 * every two or three years in summer at 0.3-1 m with a near-infrared band.
 * Living leaves reflect near infrared strongly and roofs, wood, stone and
 * paint do not, so the vegetation index (NIR - red) / (NIR + red) tells a
 * small tree from a shed where the lidar's shape cannot.
 *
 * THE PHOTO FROM THE LIDAR'S OWN YEAR (owner, 2026-11-04: "is it not
 * possible to pull an naip photo from the same year?"). Microsoft's
 * Planetary Computer serves every NAIP year (STAC search, then a crop of
 * one frame; free, no key, open to browsers), so given the flight's date
 * (the laser's own clock, find.js) the frame nearest it is read: a tree the
 * laser saw is green in it, a shed built since is in neither. Without a
 * date the newest frame is read. When no one frame covers the whole lot,
 * or the service does not answer, the USGS National Map's NAIP service (the
 * newest mosaic; the water session's reading, water/lib/naip.js) stands in.
 * This is the check's photo only: the picture under the map stays the one
 * the map was traced on.
 */

import { fromMerc } from './ept.js';

export const NAIP = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
export const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
export const CROP = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox';
export const UP = 2; // pixels asked for per cell, each way, then averaged
export const NEAR_YEARS = 3; // a frame this far from the flight still counts as its year's

const asked = new Map(); // one request per lot and date per page, however many callers ask

/**
 * The vegetation index per column of `grid` (grid.js gridOver: x0, y1, cell,
 * cellY, w, h; EPSG:3857), as a Float32Array (-1..1) with `.frame` ({ id,
 * date, source }) on it, or null when nothing answers. `flownMs`: the
 * lidar flight's date, for the frame nearest it.
 */
export function greenOver(grid, { flownMs = null, fetchFn = (u, i) => globalThis.fetch(u, i), decodePng = decodeInBrowser, timeoutMs = 45000 } = {}) {
  const w = grid.w, h = grid.h, cy = grid.cellY || grid.cell;
  const bbox = [grid.x0, grid.y1 - h * cy, grid.x0 + w * grid.cell, grid.y1];
  const key = `${bbox.map((v) => v.toFixed(1)).join(',')}|${flownMs ? new Date(flownMs).toISOString().slice(0, 7) : 'newest'}`;
  if (!asked.has(key)) {
    const p = readGreen(bbox, w, h, { flownMs, fetchFn, decodePng, timeoutMs });
    asked.set(key, p);
    p.then((g) => { if (!g) asked.delete(key); }); // a failure is asked again next time
  }
  return asked.get(key);
}

async function readGreen(bbox, w, h, o) {
  const fromFrame = await readFrame(bbox, w, h, o).catch(() => null);
  if (fromFrame) return fromFrame;
  return readMosaic(bbox, w, h, o);
}

/** Planetary Computer: the NAIP frame nearest the flight that covers the whole box. */
async function readFrame(bbox, w, h, { flownMs, fetchFn, decodePng, timeoutMs }) {
  const ring = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]].map(fromMerc);
  const res = await fetchFn(STAC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ collections: ['naip'], intersects: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, limit: 60 }),
  });
  if (!res.ok) return null;
  const items = ((await res.json())?.features || []).map((f) => ({ id: f.id, date: Date.parse(f.properties?.datetime), gsd: f.properties?.gsd, geometry: f.geometry }));
  const frame = pickFrame(items, ring, flownMs);
  if (!frame) return null;
  const W = w * UP, H = h * UP;
  /* One opaque PNG: NIR as red, red as green, green as blue (no alpha, so a
     canvas cannot premultiply the values away). */
  const url = `${CROP}/${bbox.map((v) => v.toFixed(2)).join(',')}/${W}x${H}.png?collection=naip&item=${encodeURIComponent(frame.id)}&assets=image&asset_bidx=image%7C4,1,2&coord_crs=EPSG:3857&dst_crs=EPSG:3857`;
  const png = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!png.ok) return null;
  const rgba = await decodePng(await png.arrayBuffer(), W, H);
  if (!rgba) return null;
  const out = ndviFromRgba(rgba, w, h);
  if (out) out.frame = { id: frame.id, date: new Date(frame.date).toISOString().slice(0, 10), source: 'planetary-computer' };
  return out;
}

/** The USGS mosaic (the newest photo), band-sequential bytes. */
async function readMosaic(bbox, w, h, { fetchFn, timeoutMs }) {
  const W = w * UP, H = h * UP;
  const url = `${NAIP}?bbox=${bbox.map((v) => v.toFixed(2)).join(',')}&bboxSR=3857&imageSR=3857&size=${W},${H}&format=bsq&pixelType=U8&interpolation=RSP_BilinearInterpolation&f=image`;
  let buf;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    buf = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
  const out = ndviFromBsq(buf, w, h);
  if (out) out.frame = { id: 'usgs-mosaic', date: null, source: 'usgs' };
  return out;
}

/**
 * Of the STAC items, the one nearest `flownMs` (the newest without a date)
 * whose footprint holds every corner of the lot's ring (lng/lat); null when
 * none covers it. Items at 1 m or finer only.
 */
export function pickFrame(items, ring, flownMs = null) {
  const covers = items.filter((it) => Number.isFinite(it.date) && (!it.gsd || it.gsd <= 1.01) && ring.every((p) => inPolygon(p, it.geometry)));
  if (!covers.length) return null;
  const score = (it) => (flownMs ? Math.abs(it.date - flownMs) : -it.date);
  covers.sort((a, b) => score(a) - score(b) || b.date - a.date);
  const best = covers[0];
  if (flownMs && Math.abs(best.date - flownMs) > NEAR_YEARS * 365.25 * 864e5) {
    /* Nothing near the flight's year: take the newest, as before, rather than an old frame. */
    covers.sort((a, b) => b.date - a.date);
    return covers[0];
  }
  return best;
}

/** Point in a GeoJSON Polygon or MultiPolygon (outer rings; even-odd). */
export function inPolygon([x, y], geom) {
  if (!geom) return false;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const poly of polys) {
    const ring = poly[0] || [];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** A PNG's bytes -> { data (RGBA Uint8ClampedArray), width, height } in a browser (main thread or worker). */
async function decodeInBrowser(buf, W, H) {
  if (typeof createImageBitmap !== 'function') return null;
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
  const Canvas = typeof OffscreenCanvas === 'function' ? OffscreenCanvas : null;
  if (!Canvas) return null;
  const c = new Canvas(bmp.width, bmp.height), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { data: img.data, width: img.width, height: img.height };
}

/** RGBA pixels with NIR in R and red in G (w*up x h*up) -> per-column vegetation index, or null. */
export function ndviFromRgba(rgba, w, h, up = UP) {
  if (!rgba?.data || rgba.width !== w * up || rgba.height !== h * up) return null;
  const { data, width: W } = rgba;
  const out = new Float32Array(w * h);
  let lit = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let red = 0, nir = 0;
    for (let dr = 0; dr < up; dr++) for (let dc = 0; dc < up; dc++) {
      const p = ((r * up + dr) * W + c * up + dc) * 4;
      nir += data[p];
      red += data[p + 1];
    }
    if (red + nir > 0) lit++;
    out[r * w + c] = (nir - red) / Math.max(1, nir + red);
  }
  return lit > 0.5 * w * h ? out : null; // a frame mostly black is not this lot's
}

/** The band-sequential bytes (red, green, blue, NIR planes of w*UP x h*UP) -> per-column vegetation index, or null. */
export function ndviFromBsq(buf, w, h, up = UP) {
  const W = w * up, H = h * up;
  if (!buf || buf.length < W * H * 4) return null;
  const out = new Float32Array(w * h);
  let lit = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let red = 0, nir = 0;
    for (let dr = 0; dr < up; dr++) for (let dc = 0; dc < up; dc++) {
      const p = (r * up + dr) * W + c * up + dc;
      red += buf[p];
      nir += buf[3 * W * H + p];
    }
    if (red + nir > 0) lit++;
    out[r * w + c] = (nir - red) / Math.max(1, nir + red);
  }
  return lit ? out : null; // an all-black frame is outside the service's cover
}
