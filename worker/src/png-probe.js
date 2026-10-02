/**
 * IS THERE A PHOTOGRAPH HERE? Read off a tiny PNG, in the Worker.
 *
 * A county service's box says where it MIGHT have pictures (Maryland's
 * six-inch box takes in northern Virginia; New Hampshire's habitat layer is a
 * flat grey raster), so before the editor is offered one, the Worker asks it
 * for 32 x 32 pixels over the spot and looks: mostly transparent, or flat (no
 * texture -- a classification, a fill), is not a photograph (owner,
 * 2026-10-02). Workers have no image library, but a small RGBA/RGB PNG is a
 * zlib stream and five row filters, and DecompressionStream does the zlib.
 */

/** Decode an 8-bit RGB or RGBA (or palette) PNG to RGBA. Null for anything else. */
export async function decodePng(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8, w = 0, h = 0, depth = 0, type = 0, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= b.length) {
    const len = view.getUint32(pos); const tag = String.fromCharCode(...b.subarray(pos + 4, pos + 8));
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (tag === 'IHDR') { w = view.getUint32(pos + 8); h = view.getUint32(pos + 12); depth = b[pos + 16]; type = b[pos + 17]; if (b[pos + 20]) return null; }
    else if (tag === 'PLTE') palette = data;
    else if (tag === 'tRNS') trns = data;
    else if (tag === 'IDAT') idat.push(data);
    else if (tag === 'IEND') break;
    pos += 12 + len;
  }
  const ch = type === 6 ? 4 : type === 2 ? 3 : type === 3 ? 1 : type === 0 ? 1 : type === 4 ? 2 : 0;
  if (!w || !h || depth !== 8 || !ch || w * h > 1 << 20) return null;
  const joined = new Uint8Array(idat.reduce((a, d) => a + d.length, 0));
  let o = 0;
  for (const d of idat) { joined.set(d, o); o += d.length; }
  const raw = new Uint8Array(await new Response(new Blob([joined]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = w * ch;
  if (raw.length < h * (stride + 1)) return null;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const up = y ? px[(y - 1) * stride + x] : 0;
      const c = y && x >= ch ? px[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c; const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (type === 6) { out.set(px.subarray(i * 4, i * 4 + 4), i * 4); continue; }
    if (type === 2) { out[i * 4] = px[i * 3]; out[i * 4 + 1] = px[i * 3 + 1]; out[i * 4 + 2] = px[i * 3 + 2]; out[i * 4 + 3] = 255; continue; }
    if (type === 0) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = px[i]; out[i * 4 + 3] = 255; continue; }
    if (type === 4) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = px[i * 2]; out[i * 4 + 3] = px[i * 2 + 1]; continue; }
    const k = px[i];
    out[i * 4] = palette?.[k * 3] ?? 0; out[i * 4 + 1] = palette?.[k * 3 + 1] ?? 0; out[i * 4 + 2] = palette?.[k * 3 + 2] ?? 0;
    out[i * 4 + 3] = trns && k < trns.length ? trns[k] : 255;
  }
  return { width: w, height: h, data: out };
}

/**
 * Does this picture show ground? No: over a quarter transparent (or flat pure
 * white/black, the other no-data fills), or so flat that nothing in it varies
 * (luminance spread under 4 levels: a classification, a fill, a "no image").
 */
export function looksLikePhoto(img) {
  if (!img) return false;
  const n = img.width * img.height;
  let gone = 0, s = 0, ss = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2], a = img.data[i * 4 + 3];
    if (a < 8 || (r === 255 && g === 255 && b === 255) || (r === 0 && g === 0 && b === 0)) { gone++; continue; }
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    s += l; ss += l * l; k++;
  }
  if (gone > n * 0.25 || k < 16) return false;
  const sd = Math.sqrt(Math.max(0, ss / k - (s / k) ** 2));
  return sd >= 4;
}
