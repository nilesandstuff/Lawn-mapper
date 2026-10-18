/**
 * THE LAWN'S WATERING ZONES (water session, 2026-10-18; owner: "Tool draws
 * zones", which the user can redraw).
 *
 * Each lawn cell's ideal watering, from the cell-by-cell run of the
 * balance over ten typical years (lib/balance.js idealIrrigation), comes
 * down to two numbers:
 *
 *   HOW MUCH   the readily available water: what the root zone can take
 *              between "needs water" and "full" (mm per watering)
 *   HOW OFTEN  that, divided by what the cell loses a day in its thirstiest
 *              month (its ideal irrigation that month, per day)
 *
 * Cells with the same pair belong in one zone. k-means on the two (as
 * logarithms, so a doubling counts the same anywhere) for k = 1..MAX_ZONES,
 * the fewest zones that explain most of the spread; then tidied on the map
 * (a majority filter, and patches under MIN_M2 joined to their neighbour).
 */

export const MAX_ZONES = 4, MIN_M2 = 12, ENOUGH = 0.25;

function kmeans(pts, k, iters = 40) {
  // deterministic start: spread along the first feature's quantiles
  const sorted = pts.map((p, i) => [p[0] + p[1], i]).sort((a, b) => a[0] - b[0]);
  let cent = Array.from({ length: k }, (_, j) => pts[sorted[Math.min(sorted.length - 1, Math.floor(((j + 0.5) / k) * sorted.length))][1]].slice());
  const lab = new Int32Array(pts.length);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      let b = 0, bd = Infinity;
      for (let j = 0; j < k; j++) { const d = (pts[i][0] - cent[j][0]) ** 2 + (pts[i][1] - cent[j][1]) ** 2; if (d < bd) { bd = d; b = j; } }
      if (lab[i] !== b) { lab[i] = b; moved = true; }
    }
    const sum = Array.from({ length: k }, () => [0, 0, 0]);
    for (let i = 0; i < pts.length; i++) { sum[lab[i]][0] += pts[i][0]; sum[lab[i]][1] += pts[i][1]; sum[lab[i]][2]++; }
    cent = sum.map((s, j) => (s[2] ? [s[0] / s[2], s[1] / s[2]] : cent[j]));
    if (!moved && it) break;
  }
  let sse = 0;
  for (let i = 0; i < pts.length; i++) sse += (pts[i][0] - cent[lab[i]][0]) ** 2 + (pts[i][1] - cent[lab[i]][1]) ** 2;
  return { lab, cent, sse };
}

/**
 * model: lib/balance.js buildModel; perMonth: Float32Array[12] of ideal irrigation mm per cell
 * (summed over the years); years: how many years were run.
 * -> { zoneOf: Int16Array (-1 off the lawn), n, peakMonth, cellNeed: { depth, interval } }
 */
export function drawZones(model, perMonth, years, { maxZones = MAX_ZONES } = {}) {
  const { g, N, kinds, raw } = model;
  const lawn = [];
  for (let i = 0; i < N; i++) if (kinds[i] === 1) lawn.push(i);
  const zoneOf = new Int16Array(N).fill(-1);
  if (!lawn.length) return { zoneOf, n: 0, peakMonth: null };
  // the thirstiest month over the whole lawn
  let peakMonth = 6, peak = -1;
  for (let m = 0; m < 12; m++) { let s = 0; for (const i of lawn) s += perMonth[m][i]; if (s > peak) { peak = s; peakMonth = m; } }
  const daysIn = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][peakMonth] * years;
  const depth = new Float32Array(N), interval = new Float32Array(N);
  const pts = lawn.map((i) => {
    const perDay = Math.max(0.05, perMonth[peakMonth][i] / daysIn);
    depth[i] = raw[i]; interval[i] = raw[i] / perDay;
    return [Math.log(Math.max(1, raw[i])), Math.log(Math.max(0.5, interval[i]))];
  });
  let best = kmeans(pts, 1);
  const total = best.sse || 1;
  // a lawn whose cells all need about the same (spread under ~10% either way) is one zone
  for (let k = 2; k <= maxZones && total / pts.length > 0.01; k++) {
    if (lawn.length < k * MIN_M2) break;
    const r = kmeans(pts, k);
    if (best.sse / total <= ENOUGH) break;
    best = r;
  }
  // order zones by how often they need water (most often first)
  const k = best.cent.length;
  const rank = best.cent.map((c, j) => [c[1], j]).sort((a, b) => a[0] - b[0]).map(([, j]) => j);
  const remap = new Int16Array(k); rank.forEach((j, r) => { remap[j] = r; });
  lawn.forEach((i, n) => { zoneOf[i] = remap[best.lab[n]]; });
  tidy(g, zoneOf, k);
  // a zone left under MIN_M2 in all (scattered single cells) joins the zone whose need is nearest
  const count = new Array(k).fill(0);
  for (const i of lawn) count[zoneOf[i]]++;
  const big = [...Array(k).keys()].filter((z) => count[z] * g.cell * g.cell >= MIN_M2);
  if (big.length) {
    const cent = best.cent;
    lawn.forEach((i, n) => {
      if (big.includes(zoneOf[i])) return;
      let b = big[0], bd = Infinity;
      for (const z of big) { const c = cent[rank[z]]; const d = (pts[n][0] - c[0]) ** 2 + (pts[n][1] - c[1]) ** 2; if (d < bd) { bd = d; b = z; } }
      zoneOf[i] = b;
    });
  }
  // renumber to the zones that survived
  const used = [...new Set(lawn.map((i) => zoneOf[i]))].filter((z) => z >= 0).sort((a, b) => a - b);
  const re = new Map(used.map((z, j) => [z, j]));
  for (const i of lawn) zoneOf[i] = re.get(zoneOf[i]) ?? 0;
  return { zoneOf, n: used.length, peakMonth, cellNeed: { depth, interval } };
}

/** A 3x3 majority filter over the lawn (twice), then patches under MIN_M2 joined to their commonest neighbour. */
export function tidy(g, zoneOf, k) {
  const N = g.W * g.H;
  for (let pass = 0; pass < 2; pass++) {
    const next = Int16Array.from(zoneOf);
    for (let i = 0; i < N; i++) {
      if (zoneOf[i] < 0) continue;
      const r = Math.floor(i / g.W), c = i % g.W, count = new Array(k).fill(0);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
        const z = zoneOf[rr * g.W + cc];
        if (z >= 0) count[z]++;
      }
      let b = zoneOf[i];
      for (let z = 0; z < k; z++) if (count[z] > count[b]) b = z;
      if (count[b] >= 5) next[i] = b;
    }
    zoneOf.set(next);
  }
  const seen = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    if (zoneOf[s] < 0 || seen[s]) continue;
    const z = zoneOf[s], patch = [s]; seen[s] = 1;
    const around = new Array(k).fill(0);
    for (let q = 0; q < patch.length; q++) {
      const i = patch[q], r = Math.floor(i / g.W), c = i % g.W;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
        const j = rr * g.W + cc;
        if (zoneOf[j] === z && !seen[j]) { seen[j] = 1; patch.push(j); } else if (zoneOf[j] >= 0 && zoneOf[j] !== z) around[zoneOf[j]]++;
      }
    }
    if (patch.length * g.cell * g.cell < MIN_M2) {
      let b = -1;
      for (let j = 0; j < k; j++) if (around[j] && (b < 0 || around[j] > around[b])) b = j;
      if (b >= 0) for (const i of patch) zoneOf[i] = b;
    }
  }
}
