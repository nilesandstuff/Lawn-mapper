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

const ORIGIN = 20037508.342787;

/** Is this a cache the Worker can stitch? From the service's own JSON. */
export function isMercatorCache(m) {
  const ti = m?.tileInfo;
  const wkid = ti?.spatialReference?.latestWkid || ti?.spatialReference?.wkid
    || m?.spatialReference?.latestWkid || m?.spatialReference?.wkid;
  return Boolean(ti?.lods?.length && [3857, 102100, 900913].includes(wkid)
    && Math.abs(Math.abs(ti.origin?.x) - ORIGIN) < 1 && Math.abs(ti.origin?.y - ORIGIN) < 1);
}

/** The level whose pixels best match `want` metres (Mercator), never finer than the data. */
export function pickLevel(m, want) {
  const lods = (m.tileInfo.lods || []).filter((l) => !(Number(m.maxScale) > 0) || l.scale >= Number(m.maxScale) - 1);
  if (!lods.length) return null;
  const byRes = lods.slice().sort((a, b) => a.resolution - b.resolution);
  let at = byRes.findIndex((l) => l.resolution >= want * 0.999);
  if (at < 0) at = byRes.length - 1;
  else if (byRes[at].resolution > want * 1.001 && at > 0) at -= 1;
  return { byRes, at };
}

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

/**
 * The frame's box (Web Mercator [w, s, e, n]) at W x H, from the cache at
 * `url` with metadata `m`. Null when the cache has nothing here.
 */
export async function stitch(url, m, bbox, W, H, { fetcher = fetch, maxTiles = 100 } = {}) {
  if (!isMercatorCache(m)) return null;
  const ti = m.tileInfo;
  const size = ti.rows || 256;
  const ox = ti.origin.x, oy = ti.origin.y;
  const want = (bbox[2] - bbox[0]) / W;
  const pick = pickLevel(m, want);
  if (!pick) return null;
  const midX = (bbox[0] + bbox[2]) / 2, midY = (bbox[1] + bbox[3]) / 2;
  /* The finest level the cache really holds here: some list levels they never
     filled (Massachusetts' 2025, Ingham's 2025), so the centre tile is tried
     at the level wanted, then coarser. Too many tiles is coarser too. */
  let lod = null, centre = null;
  for (let k = pick.at; k < pick.byRes.length && k < pick.at + 6; k++) {
    const l = pick.byRes[k];
    const span = l.resolution * size;
    const n = (Math.floor((bbox[2] - ox) / span) - Math.floor((bbox[0] - ox) / span) + 1)
      * (Math.floor((oy - bbox[1]) / span) - Math.floor((oy - bbox[3]) / span) + 1);
    if (n > maxTiles) continue;
    centre = await getTile(`${url}/tile/${l.level}/${Math.floor((oy - midY) / span)}/${Math.floor((midX - ox) / span)}`, fetcher);
    if (centre) { lod = l; break; }
  }
  if (!lod) return null;
  const res = lod.resolution, span = res * size;
  const c0 = Math.floor((bbox[0] - ox) / span), c1 = Math.floor((bbox[2] - ox) / span);
  const r0 = Math.floor((oy - bbox[3]) / span), r1 = Math.floor((oy - bbox[1]) / span);
  const cols = c1 - c0 + 1, rows = r1 - r0 + 1;
  const tiles = await Promise.all([...Array(rows * cols)].map((_, i) => {
    const r = r0 + Math.floor(i / cols), c = c0 + (i % cols);
    return getTile(`${url}/tile/${lod.level}/${r}/${c}`, fetcher);
  }));
  if (!tiles.some(Boolean)) return null;
  const out = new Uint8Array(W * H * 4);
  const at = (mx, my) => {
    const tc = Math.floor(mx / size), tr = Math.floor(my / size);
    if (tc < 0 || tr < 0 || tc >= cols || tr >= rows) return null;
    const t = tiles[tr * cols + tc];
    if (!t) return null;
    const x = Math.min(t.width - 1, Math.floor(mx - tc * size)), y = Math.min(t.height - 1, Math.floor(my - tr * size));
    return (y * t.width + x) * 4 + 0 >= 0 ? [t, (y * t.width + x) * 4] : null;
  };
  for (let y = 0; y < H; y++) {
    const gy = bbox[3] - ((y + 0.5) * (bbox[3] - bbox[1])) / H;
    const my = (oy - gy) / res - r0 * size - 0.5;
    for (let x = 0; x < W; x++) {
      const gx = bbox[0] + ((x + 0.5) * (bbox[2] - bbox[0])) / W;
      const mx = (gx - ox) / res - c0 * size - 0.5;
      const x0 = Math.floor(mx), y0 = Math.floor(my), fx = mx - x0, fy = my - y0;
      const p00 = at(x0, y0), p10 = at(x0 + 1, y0), p01 = at(x0, y0 + 1), p11 = at(x0 + 1, y0 + 1);
      const o = (y * W + x) * 4;
      if (!p00 || !p10 || !p01 || !p11) {
        const any = p00 || p10 || p01 || p11;
        if (any) for (let c = 0; c < 4; c++) out[o + c] = any[0].data[any[1] + c];
        continue; // otherwise stays transparent: no picture here
      }
      for (let c = 0; c < 4; c++) {
        out[o + c] = Math.round(
          p00[0].data[p00[1] + c] * (1 - fx) * (1 - fy) + p10[0].data[p10[1] + c] * fx * (1 - fy)
          + p01[0].data[p01[1] + c] * (1 - fx) * fy + p11[0].data[p11[1] + c] * fx * fy);
      }
    }
  }
  return { width: W, height: H, data: out, cm: res * 100 };
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
