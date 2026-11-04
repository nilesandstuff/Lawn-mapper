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
 * small tree from a shed where the lidar's shape cannot. Free, no key, open
 * to browsers: the USGS National Map's NAIP image service, one request per
 * lot. The reading is the water session's (water/lib/naip.js, 2026-10-18),
 * here on the shade map's grid.
 */

export const NAIP = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
export const UP = 2; // pixels asked for per cell, each way, then averaged

/**
 * The vegetation index per column of `grid` (grid.js gridOver: x0, y1, cell,
 * cellY, w, h; EPSG:3857), as a Float32Array (-1..1), or null when the
 * service does not answer or has no photo there.
 */
const asked = new Map(); // one request per lot per page, however many callers ask

export function greenOver(grid, { fetchFn = (u, i) => globalThis.fetch(u, i), timeoutMs = 45000 } = {}) {
  const w = grid.w, h = grid.h, cy = grid.cellY || grid.cell;
  const bbox = [grid.x0, grid.y1 - h * cy, grid.x0 + w * grid.cell, grid.y1];
  const W = w * UP, H = h * UP;
  const url = `${NAIP}?bbox=${bbox.map((v) => v.toFixed(2)).join(',')}&bboxSR=3857&imageSR=3857&size=${W},${H}&format=bsq&pixelType=U8&interpolation=RSP_BilinearInterpolation&f=image`;
  if (!asked.has(url)) {
    const p = readGreen(url, w, h, fetchFn, timeoutMs);
    asked.set(url, p);
    p.then((g) => { if (!g) asked.delete(url); }); // a failure is asked again next time
  }
  return asked.get(url);
}

async function readGreen(url, w, h, fetchFn, timeoutMs) {
  let buf;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    buf = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
  return ndviFromBsq(buf, w, h);
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
