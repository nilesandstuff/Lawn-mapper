/**
 * Spearman's rank correlation, ties given their mean rank (water session, 2026-11-04): the water map's check of the
 * model's soil wetness against a hand meter's readings, which are on the meter's own scale, so only their order counts.
 * -> rho in -1..1, or null with fewer than 3 pairs or no spread on either side.
 */
export function spearman(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = new Array(n);
    for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
    return r;
  };
  const ra = rank(a), rb = rank(b), m = (n + 1) / 2;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (ra[i] - m) * (rb[i] - m); saa += (ra[i] - m) ** 2; sbb += (rb[i] - m) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}
