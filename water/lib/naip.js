/**
 * THE USDA'S AERIAL PHOTO, WITH ITS NEAR-INFRARED BAND, ON THE GRID (water session, 2026-10-18).
 *
 * NAIP (the National Agriculture Imagery Program) flies the lower 48 every
 * two or three years at 0.3-1 m with four bands: red, green, blue and near
 * infrared. Living grass reflects near infrared strongly; concrete,
 * blacktop and roofs do not -- the vegetation index (NIR - red) / (NIR +
 * red) tells them apart in a way the colour alone cannot. Free, no key,
 * open to browsers: the USGS National Map's NAIP image service.
 *
 * For the owner's "whatever is most accurate and fastest" (2026-10-18): one
 * request per lot, averaged onto the 1 m grid of lib/surface.js.
 */

export const NAIP = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
export const UP = 3; // pixels per cell asked for, each way, then averaged

/** g: { W, H, bbox (3857) } -> { red, green, blue, nir } Float32Arrays per cell (0-255), or null. */
export async function naipFor(g, { fetchFn = fetch } = {}) {
  const W = g.W * UP, H = g.H * UP;
  const url = `${NAIP}?bbox=${g.bbox.map((v) => v.toFixed(2)).join(',')}&bboxSR=3857&imageSR=3857&size=${W},${H}&format=bsq&pixelType=U8&interpolation=RSP_BilinearInterpolation&f=image`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < W * H * 4) return null;
  const band = (b) => {
    const out = new Float32Array(g.W * g.H);
    const off = b * W * H;
    for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
      let s = 0;
      for (let dr = 0; dr < UP; dr++) for (let dc = 0; dc < UP; dc++) s += buf[off + (r * UP + dr) * W + c * UP + dc];
      out[r * g.W + c] = s / (UP * UP);
    }
    return out;
  };
  const red = band(0), green = band(1), blue = band(2), nir = band(3);
  // an all-black frame is no photo (outside the service's cover)
  let lit = 0; for (let i = 0; i < red.length; i += 7) if (red[i] + nir[i] > 0) lit++;
  return lit ? { red, green, blue, nir } : null;
}

/** The vegetation index per cell, -1..1 (NaN where there is no light at all). */
export function ndvi(p) {
  return Float32Array.from(p.red, (r, i) => { const n = p.nir[i]; return n + r > 0 ? (n - r) / (n + r) : NaN; });
}
