/**
 * A COUNTY PHOTO THAT ONLY COMES AS TILES, AS ONE PICTURE OF THE LOT.
 *
 * Many of the sharpest county photos are tile caches that will not draw an
 * arbitrary box: Blaine County ID's 2026 Nearmap (owner, 2026-10-02: "It has
 * 2026 nearmap"), Massachusetts' 2025 flights, Ingham County's, everything
 * hosted on tiles.arcgis.com. The editor, the alignment and the detectors all
 * want one picture of the frame, so the Worker stitches one: the cache's own
 * Web Mercator tiles at the level that matches the frame, decoded (JPEG with
 * jpeg-js's decoder, PNG with png-probe's), sampled onto the frame's pixels,
 * and handed back as a PNG.
 *
 * Web Mercator caches only (the standard ArcGIS scheme, which is what nearly
 * all of these are); one in a state plane is left to the catalogue's own
 * tools, which can reproject.
 */
import jpeg from 'jpeg-js';
import { decodePng } from './png-probe.js';
import { isMercatorCache, pickLevel, stitch as stitchWith } from '../../public/lib/tile-stitch.js';

export { isMercatorCache, pickLevel };

/** One tile, decoded to RGBA, or null. */
async function getTile(url, fetcher) {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(15000), cf: { cacheTtl: 604800, cacheEverything: true } });
    if (!res.ok) return null;
    const b = new Uint8Array(await res.arrayBuffer());
    if (b[0] === 0xff && b[1] === 0xd8) {
      const d = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 });
      return { width: d.width, height: d.height, data: d.data };
    }
    if (b[0] === 0x89 && b[1] === 0x50) return decodePng(b);
    return null;
  } catch { return null; }
}

/** The Worker's own stitch: tiles fetched from `url` and decoded here. */
export function stitch(url, m, bbox, W, H, { fetcher = fetch, maxTiles = 40 } = {}) {
  return stitchWith(m, bbox, W, H, (l, r, c) => getTile(`${url}/tile/${l}/${r}/${c}`, fetcher), { maxTiles });
}

/* ------------------------------------------------------------ PNG out */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA pixels to a PNG: RGB when nothing is transparent, RGBA when something is. */
export async function encodePng({ width, height, data }) {
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { alpha = true; break; }
  const ch = alpha ? 4 : 3;
  const raw = new Uint8Array(height * (width * ch + 1));
  for (let y = 0; y < height; y++) {
    let o = y * (width * ch + 1);
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[o++] = data[i]; raw[o++] = data[i + 1]; raw[o++] = data[i + 2];
      if (alpha) raw[o++] = data[i + 3];
    }
  }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width); v.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
