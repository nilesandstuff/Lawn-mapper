/**
 * LINE NAIP UP WITH THE MAPBOX PHOTOGRAPH.
 *
 * WHY (owner, 2026-09-27): switching the editor to NAIP, the picture is
 * sometimes shifted a little, or a little off in scale, against Mapbox. The
 * detector's fused inputs read NAIP's near-infrared beside the photograph, so
 * a shifted NAIP puts "vegetation" a metre or two from where the grass is.
 * The owner ranks the sources: Mapbox first, lidar next, NAIP last -- so NAIP
 * is the one that moves.
 *
 * HOW. Both pictures are reduced to the same small grid over the same frame,
 * turned into edge strength (roof edges, kerbs, fences and tree outlines are
 * in both, whatever the colours), and NAIP is slid and scaled until its edges
 * best match the photograph's (normalised correlation). The answer is only
 * taken when it clearly beats leaving NAIP where it is; otherwise nothing
 * moves, because a confident wrong shift is worse than a known small one.
 *
 * The same arithmetic runs in tools/naip_align.py for maps nobody looked at
 * in NAIP, so the two must stay in step: tests on both sides check the same
 * synthetic cases.
 */

/** Luminance of RGBA pixel data, as floats. */
export function luminance(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return out;
}

/** Edge strength: central-difference gradient magnitude, zero on the border. */
export function edges(grey, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = grey[i + 1] - grey[i - 1];
      const gy = grey[i + w] - grey[i - w];
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/** A 3x3 box blur, so a sharp photograph's edges meet a soft NAIP's halfway. */
export function blur3(a, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += a[yy * w + xx]; n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

/*
 * Correlation of `ref` with `mov` placed by (dx, dy, s): the moved picture's
 * pixel p shows mov at c + (p - d - c) / s. Only where both are defined, and
 * only over the inner part of the frame so a shift never scores on a sliver.
 */
function score(ref, mov, w, h, dx, dy, s, margin) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = margin; y < h - margin; y++) {
    const qy = Math.round(cy + (y - dy - cy) / s);
    if (qy < 0 || qy >= h) continue;
    for (let x = margin; x < w - margin; x++) {
      const qx = Math.round(cx + (x - dx - cx) / s);
      if (qx < 0 || qx >= w) continue;
      const a = ref[y * w + x];
      const b = mov[qy * w + qx];
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
  }
  if (n < 16) return -1;
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1;
}

/** Where a parabola through three scores peaks, as an offset in (-0.5, 0.5). */
function subStep(m, c0, p) {
  const d = m - 2 * c0 + p;
  if (d >= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, 0.5 * (m - p) / d));
}

export const SCALES = [0.985, 0.99, 0.995, 1, 1.005, 1.01, 1.015];

/**
 * The shift (pixels, +x right, +y down) and scale that best lay `mov` on
 * `ref`, both greyscale on the same w x h grid over the same frame.
 *
 * Returns { dx, dy, scale, ncc, ncc0, moved } where ncc0 is the correlation
 * with NAIP left alone, and `moved` says whether the fit was clear enough to
 * use (otherwise dx = dy = 0 and scale = 1).
 */
export function alignImages(refGrey, movGrey, w, h, { maxShift = 8, scales = SCALES, minGain = 0.02, scaleGain = 0.01 } = {}) {
  const ref = blur3(edges(refGrey, w, h), w, h);
  const mov = blur3(edges(movGrey, w, h), w, h);
  const margin = maxShift + 2;
  const ncc0 = score(ref, mov, w, h, 0, 0, 1, margin);
  const search = (s) => {
    let b = null;
    for (let dy = -maxShift; dy <= maxShift; dy++) {
      for (let dx = -maxShift; dx <= maxShift; dx++) {
        const v = score(ref, mov, w, h, dx, dy, s, margin);
        if (!b || v > b.v + 1e-9) b = { dx, dy, s, v };
      }
    }
    return b;
  };
  /* Scale 1 first; another scale has to beat it clearly, because on a small
     grid a 0.5% scale moves nothing by a whole pixel and near-ties are noise. */
  let best = search(1);
  for (const s of scales) {
    if (s === 1) continue;
    const b = search(s);
    if (b.v > best.v + scaleGain) best = b;
  }
  /* Half a pixel more, from the neighbours of the peak. */
  const at = (dx, dy) => score(ref, mov, w, h, dx, dy, best.s, margin);
  const fx = subStep(at(best.dx - 1, best.dy), best.v, at(best.dx + 1, best.dy));
  const fy = subStep(at(best.dx, best.dy - 1), best.v, at(best.dx, best.dy + 1));
  const moved = best.v - ncc0 >= minGain && (best.dx || best.dy || best.s !== 1);
  return moved
    ? { dx: best.dx + fx, dy: best.dy + fy, scale: best.s, ncc: best.v, ncc0, moved: true }
    : { dx: 0, dy: 0, scale: 1, ncc: ncc0, ncc0, moved: false };
}

/**
 * The four corners of a frame after NAIP is moved by (east, north) metres
 * and scaled by `scale` about the frame's centre. `corners` are
 * [[lng,lat] x4] as Mapbox GL image sources take them; the arithmetic is in
 * Web Mercator metres, where a shift is a shift everywhere in the frame.
 */
export function movedCorners(corners, east, north, scale) {
  const R = 6378137;
  const toM = ([lng, lat]) => [R * (lng * Math.PI / 180), R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2))];
  const toLL = ([x, y]) => [x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
  const m = corners.map(toM);
  const cx = m.reduce((a, p) => a + p[0], 0) / m.length;
  const cy = m.reduce((a, p) => a + p[1], 0) / m.length;
  /* Mercator metres are ground metres divided by cos(lat); convert so a
     "1.0 m east" means a metre on the ground. */
  const k = 1 / Math.cos((corners.reduce((a, p) => a + p[1], 0) / corners.length) * Math.PI / 180);
  return m.map(([x, y]) => toLL([cx + (x - cx) * scale + east * k, cy + (y - cy) * scale + north * k]));
}
