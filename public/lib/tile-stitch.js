/**
 * A TILE CACHE'S PICTURE OF A FRAME, stitched from its own tiles.
 *
 * Shared by the editor, which stitches in the browser (owner, 2026-10-02:
 * the Worker's free plan allows 50 fetches a request, and a 0.9-acre lot in
 * Ketchum at Blaine County's 2026 Nearmap is about 50 tiles), and by the
 * Worker, which can still do a small one itself. `getTile(level, row, col)`
 * is the caller's: it returns RGBA {width, height, data} or null.
 */
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

/**
 * The frame's box (Web Mercator [w, s, e, n]) at W x H, from the cache at
 * `url` with metadata `m`. Null when the cache has nothing here.
 */
export async function stitch(m, bbox, W, H, getTile, { maxTiles = 100 } = {}) {
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
    centre = await getTile(l.level, Math.floor((oy - midY) / span), Math.floor((midX - ox) / span));
    if (centre) { lod = l; break; }
  }
  if (!lod) return null;
  const res = lod.resolution, span = res * size;
  const c0 = Math.floor((bbox[0] - ox) / span), c1 = Math.floor((bbox[2] - ox) / span);
  const r0 = Math.floor((oy - bbox[3]) / span), r1 = Math.floor((oy - bbox[1]) / span);
  const cols = c1 - c0 + 1, rows = r1 - r0 + 1;
  const tiles = await Promise.all([...Array(rows * cols)].map((_, i) => {
    const r = r0 + Math.floor(i / cols), c = c0 + (i % cols);
    return getTile(lod.level, r, c);
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

