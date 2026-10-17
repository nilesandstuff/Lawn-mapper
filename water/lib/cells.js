/**
 * WHAT EACH 1 m CELL IS MADE OF, FROM THE POINTS ALONE (water session,
 * 2026-10-17; owner: "Sure", to measuring the laser's brightness for
 * pavement and water).
 *
 * The low-spot map needs to know whether a hollow is on LAWN. A saved map's
 * traced lawn says so outright; an address alone does not. So every cell
 * gets the measures a lidar point can give, each made relative to its own
 * box so flights compare:
 *
 *   bright   ground returns' mean intensity (3 x 3 cells) over the box's
 *            75th percentile -- grass is bright at the laser's 1064 nm,
 *            asphalt dark, concrete about as bright as grass (log)
 *   dens     every return in 3 x 3 cells over the box's median (log): water,
 *            parked cars, shadowed gaps send little back
 *   tall     share of returns 2 m+ over the ground and not roof: canopy
 *   single   share of single returns: a hard surface stops the pulse
 *   rough    the ground points' scatter round the surface (cm)
 *   raised   how far the ground stands over the lowest ground within 7 m:
 *            a flat roof the survey called ground stands a story up
 *   noI      1 where the cell has no ground return to be bright with
 *
 * lawnScore() turns them into a probability that the cell is lawn, with
 * weights fitted on half the locked corpus (water/tools/surfaces.mjs) and
 * scored on the other half (FINDINGS H11). Pure.
 */

export const FEATURES = ['bright', 'dens', 'tall', 'single', 'rough', 'raised', 'noI'];

function box3(g, a) {
  const out = new Float64Array(a.length);
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    let s = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < g.H && cc < g.W) s += a[rr * g.W + cc];
    }
    out[r * g.W + c] = s;
  }
  return out;
}

/** The lowest value within `h` cells (a square window), separably. */
function minFilter(g, a, h) {
  const tmp = new Float64Array(a.length), out = new Float64Array(a.length);
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    let m = Infinity;
    for (let cc = Math.max(0, c - h); cc <= Math.min(g.W - 1, c + h); cc++) m = Math.min(m, a[r * g.W + cc]);
    tmp[r * g.W + c] = m;
  }
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    let m = Infinity;
    for (let rr = Math.max(0, r - h); rr <= Math.min(g.H - 1, r + h); rr++) m = Math.min(m, tmp[rr * g.W + c]);
    out[r * g.W + c] = m;
  }
  return out;
}

const median = (v) => { const s = Array.from(v).filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

/** { name: Float32Array } per FEATURES, for every cell of an analyse() result. */
export function cellFeatures(res) {
  const g = res.grid, pc = res.perCell, N = g.W * g.H;
  const all3 = box3(g, pc.all), single3 = box3(g, pc.single), tall3 = box3(g, pc.tall);
  const gi3 = box3(g, pc.groundI), gn3 = box3(g, pc.groundN);
  const open = []; for (let i = 0; i < N; i++) if (!res.wall[i]) open.push(pc.all[i]);
  const medAll = Math.max(0.5, median(open));
  const low = minFilter(g, res.z, 7);
  const f = Object.fromEntries(FEATURES.map((k) => [k, new Float32Array(N)]));
  for (let i = 0; i < N; i++) {
    const hasI = gn3[i] > 0 && pc.groundP75 > 0;
    f.bright[i] = hasI ? Math.log(Math.max(0.05, (gi3[i] / gn3[i]) / pc.groundP75)) : 0;
    f.noI[i] = hasI ? 0 : 1;
    f.dens[i] = Math.log((all3[i] / 9) / medAll + 0.05);
    f.tall[i] = all3[i] ? tall3[i] / all3[i] : 0;
    f.single[i] = all3[i] ? single3[i] / all3[i] : 0;
    f.rough[i] = Number.isFinite(res.sd?.[i]) ? Math.min(30, res.sd[i] * 100) : 5;
    f.raised[i] = Math.min(6, Math.max(0, res.z[i] - low[i]));
  }
  return f;
}

/** Weights: { mean, sd, w, b } over FEATURES, from water/tools/surfaces.mjs. null until fitted. */
export const LAWN_MODEL = null;

/** P(lawn) for every cell (Float32Array), or null without a model. */
export function lawnScore(feats, model = LAWN_MODEL) {
  if (!model) return null;
  const N = feats[FEATURES[0]].length, out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let z = model.b;
    FEATURES.forEach((k, j) => { z += model.w[j] * ((feats[k][i] - model.mean[j]) / model.sd[j]); });
    out[i] = 1 / (1 + Math.exp(-z));
  }
  return out;
}

/** Logistic regression by gradient descent, standardised, light L2. rows: [[...x], y]. */
export function fitLogistic(rows, { iters = 400, rate = 0.5, l2 = 1e-3 } = {}) {
  const k = rows[0][0].length, n = rows.length;
  const mean = Array(k).fill(0), sd = Array(k).fill(0);
  for (const [x] of rows) x.forEach((v, j) => { mean[j] += v / n; });
  for (const [x] of rows) x.forEach((v, j) => { sd[j] += (v - mean[j]) ** 2 / n; });
  for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const X = rows.map(([x]) => x.map((v, j) => (v - mean[j]) / sd[j])), Y = rows.map(([, y]) => y);
  const w = Array(k).fill(0); let b = 0;
  for (let t = 0; t < iters; t++) {
    const gw = Array(k).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < k; j++) z += w[j] * X[i][j];
      const e = 1 / (1 + Math.exp(-z)) - Y[i];
      for (let j = 0; j < k; j++) gw[j] += e * X[i][j];
      gb += e;
    }
    for (let j = 0; j < k; j++) w[j] -= rate * (gw[j] / n + l2 * w[j]);
    b -= rate * gb / n;
  }
  return { mean, sd, w, b };
}

/** Area under the ROC curve of scores for positives vs negatives (ties count half). */
export function auc(pos, neg) {
  const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]);
  let rank = 0, sumPos = 0;
  for (let i = 0; i < all.length;) {
    let j = i; while (j < all.length && all[j][0] === all[i][0]) j++;
    const mid = (i + 1 + j) / 2;
    for (let t = i; t < j; t++) if (all[t][1]) sumPos += mid;
    rank = j; i = j;
  }
  void rank;
  return pos.length && neg.length ? (sumPos - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length) : NaN;
}
