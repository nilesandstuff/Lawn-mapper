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
 * Cells with the same rhythm belong in one zone: fixed bands of HOW OFTEN (BANDS, days), so a cell
 * changes zone only when its own need crosses an edge (owner, 2026-10-19, zones that changed between
 * loads); then tidied on the map (a majority filter, and patches under MIN_M2 joined to their neighbour).
 */

export const MAX_ZONES = 4, MIN_M2 = 12, ENOUGH = 0.25;
/** Band edges, days between waterings in the thirstiest month; a band under MIN_SHARE of the lawn joins a
    neighbour, and neighbours within NEAR times each other's rhythm merge. */
export const BANDS = [2, 3, 4.5, 7, 10], MIN_SHARE = 0.08, NEAR = 1.3;

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
  /* FIXED BANDS, NOT CLUSTERS (owner, 2026-10-19: "the map loads a bit differently each time... there
     wasn't a zone 3 this time"). Clustering looks at the whole lawn at once, so a small change anywhere (a
     marked deck, a roof that came out a little different) moved every zone. Now each cell falls in a band of
     how often it needs water in its thirstiest month -- edges at BANDS days -- and changes zone only when its
     own need crosses an edge. Bands under MIN_SHARE of the lawn join their nearest neighbour; neighbours
     needing water within NEAR of each other's rhythm merge; at most maxZones. */
  const bandOf = (v) => { let k = 0; while (k < BANDS.length && v >= BANDS[k]) k++; return k; };
  const lab = lawn.map((i) => bandOf(interval[i]));
  let groups = Array.from({ length: BANDS.length + 1 }, (_, k) => ({ bands: [k], n: 0, logSum: 0 }));
  lawn.forEach((i, n) => { const gp = groups[lab[n]]; gp.n++; gp.logSum += pts[n][1]; });
  groups = groups.filter((gp) => gp.n);
  const mean = (gp) => gp.logSum / gp.n;
  const merge = (a, b) => ({ bands: [...a.bands, ...b.bands], n: a.n + b.n, logSum: a.logSum + b.logSum });
  const minN = Math.max(MIN_M2 / (g.cell * g.cell), MIN_SHARE * lawn.length);
  for (;;) {
    if (groups.length <= 1) break;
    // the closest pair of neighbours, by rhythm
    let j = -1, d = Infinity;
    for (let k = 0; k + 1 < groups.length; k++) { const dd = Math.abs(mean(groups[k + 1]) - mean(groups[k])); if (dd < d) { d = dd; j = k; } }
    const small = groups.findIndex((gp) => gp.n < minN);
    if (small >= 0) {
      const left = small - 1, right = small + 1;
      const into = left < 0 ? right : right >= groups.length ? left : Math.abs(mean(groups[left]) - mean(groups[small])) <= Math.abs(mean(groups[right]) - mean(groups[small])) ? left : right;
      const [lo, hi] = [Math.min(small, into), Math.max(small, into)];
      groups.splice(lo, 2, merge(groups[lo], groups[hi]));
      continue;
    }
    if (groups.length > maxZones || d < Math.log(NEAR)) { groups.splice(j, 2, merge(groups[j], groups[j + 1])); continue; }
    break;
  }
  const k = groups.length;
  const zoneOfBand = new Int16Array(BANDS.length + 1);
  groups.forEach((gp, z) => { for (const b0 of gp.bands) zoneOfBand[b0] = z; });
  lawn.forEach((i, n) => { zoneOf[i] = zoneOfBand[lab[n]]; });
  tidy(g, zoneOf, k);
  // a zone left under MIN_M2 in all (scattered single cells) joins the zone whose rhythm is nearest
  const count = new Array(k).fill(0);
  for (const i of lawn) count[zoneOf[i]]++;
  const big = [...Array(k).keys()].filter((z) => count[z] * g.cell * g.cell >= MIN_M2);
  if (big.length) {
    lawn.forEach((i, n) => {
      if (big.includes(zoneOf[i])) return;
      let b1 = big[0], bd = Infinity;
      for (const z of big) { const dd = Math.abs(pts[n][1] - mean(groups[z])); if (dd < bd) { bd = dd; b1 = z; } }
      zoneOf[i] = b1;
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
