/**
 * HOW IMPERVIOUS IS THE GROUND THAT IS NOT LAWN (water session, 2026-10-17;
 * owner: "grass will always be marked by the time a map reaches the water
 * map. So we need to determine how impervious to water the non-lawn areas
 * are. Brightness of returns should be a pretty good proxy for that, it just
 * probably needs some calibration on a per map basis").
 *
 * Per map, the laser's brightness is calibrated on the person's own traced
 * lawn: each cell's ground returns' mean intensity (3 x 3 cells) over the
 * median of the lawn's (open lawn, not under a canopy). Asphalt and most
 * concrete come back darker than grass; a hard surface also stops the pulse
 * in one return. A logistic model over those (and the ground's scatter and
 * the return density) gives each cell a chance of being paved.
 *
 * Fitted on 12 residential squares in VA/MD/PA and tested on 11 others
 * against the Chesapeake Bay Program's 1 m land use (water/tools/
 * impervious.mjs, FINDINGS H12): paved vs everything else AUC 0.896 (0.890
 * with brightness alone), paved vs beds and bare ground 0.840. Roofs as a
 * second calibration point were tried and made it worse (0.80): roof
 * brightness swings with the roofing.
 *
 * Roofs (lib/surface.js) count as impervious outright; the traced lawn as
 * pervious. Under a canopy the few ground returns are a guess, so a cell
 * mostly under trees is left out of the paved share.
 */

/** Fitted 2026-10-17 (FINDINGS H12). x = [log(I / lawn I), ground scatter (m), single-return share, log(returns per cell + 0.1)]. */
export const PAVED_MODEL = {
  mean: [-0.2954, 0.061, 0.8931, 1.4465],
  sd: [0.5343, 0.0518, 0.2066, 0.6285],
  w: [-1.86, -0.224, 0.738, -0.108],
  b: -0.177,
};

/** Runoff coefficients (the share of rain that runs off), for the weighted flow. Rational-method textbook values. */
export const RUNOFF = { roof: 0.9, paved: 0.85, lawn: 0.15, ground: 0.3 };

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

/**
 * Per cell: P(paved) (NaN where it cannot be judged: no ground return, or
 * under a canopy), and the runoff coefficient. `res` from lib/lowspots.js
 * analyse(); `lawnMask` the traced lawn on its grid. Returns null when the
 * lawn gives nothing to calibrate on.
 */
export function imperviousness(res, lawnMask, model = PAVED_MODEL) {
  const g = res.grid, pc = res.perCell, N = g.W * g.H;
  const gi = box3(g, pc.groundI), gn = box3(g, pc.groundN), all3 = box3(g, pc.all), single3 = box3(g, pc.single), tall3 = box3(g, pc.tall);
  const lawnVals = [];
  for (let i = 0; i < N; i++) if (lawnMask[i] && !res.wall[i] && gn[i] > 0 && (!all3[i] || tall3[i] / all3[i] < 0.2)) lawnVals.push(gi[i] / gn[i]);
  if (lawnVals.length < 20) return null;
  lawnVals.sort((a, b) => a - b);
  const lawnI = lawnVals[lawnVals.length >> 1];
  if (!(lawnI > 0)) return null;
  const paved = new Float32Array(N).fill(NaN), runoff = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (res.wall[i]) { paved[i] = 1; runoff[i] = RUNOFF.roof; continue; }
    if (lawnMask[i]) { paved[i] = 0; runoff[i] = RUNOFF.lawn; continue; }
    const canopy = all3[i] ? tall3[i] / all3[i] : 0;
    if (!gn[i] || canopy >= 0.5) { runoff[i] = RUNOFF.ground; continue; }
    const x = [Math.log(Math.max(0.02, (gi[i] / gn[i]) / lawnI)), Number.isFinite(res.sd?.[i]) ? Math.min(0.3, res.sd[i]) : 0.05, all3[i] ? single3[i] / all3[i] : 0, Math.log(all3[i] / 9 + 0.1)];
    let z = model.b;
    for (let j = 0; j < x.length; j++) z += model.w[j] * ((x[j] - model.mean[j]) / model.sd[j]);
    const p = 1 / (1 + Math.exp(-z));
    paved[i] = p;
    runoff[i] = RUNOFF.ground + p * (RUNOFF.paved - RUNOFF.ground);
  }
  return { paved, runoff, lawnI };
}

/**
 * Flow weighted by runoff: how many square meters of RUNOFF-PRODUCING
 * surface drain through each cell (a roof's square meter counts 0.9, a
 * lawn's 0.15). Roof water is let off at the roof's edge, toward its lowest
 * neighbouring ground (where a gutter would most likely bring it down; the
 * real downspouts are not in the lidar).
 */
export function weightedFlow(res, runoff) {
  const g = res.grid, N = g.W * g.H, { down, filled } = res.runoff;
  const acc = new Float32Array(N);
  const roofDrops = []; // [outlet cell, m^2 of runoff] per roof piece
  // roofs: each roof cell sends its runoff to the lowest open cell next to its roof piece (per piece)
  const seen = new Uint8Array(N);
  for (let s0 = 0; s0 < N; s0++) {
    if (!res.wall[s0] || seen[s0]) continue;
    const piece = [s0]; seen[s0] = 1;
    let outlet = -1;
    for (let q = 0; q < piece.length; q++) {
      const i = piece[q], r = Math.floor(i / g.W), c = i % g.W;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
        const j = rr * g.W + cc;
        if (res.wall[j]) { if (!seen[j]) { seen[j] = 1; piece.push(j); } } else if (outlet < 0 || filled[j] < filled[outlet]) outlet = j;
      }
    }
    if (outlet >= 0) {
      let m2 = 0;
      for (const i of piece) m2 += runoff[i] * g.cell * g.cell;
      acc[outlet] += m2;
      roofDrops.push([outlet, m2]);
    }
  }
  const order = [];
  for (let i = 0; i < N; i++) if (!res.wall[i]) order.push(i);
  order.sort((a, b) => filled[b] - filled[a]);
  for (const i of order) acc[i] += runoff[i] * g.cell * g.cell;
  for (const i of order) if (down[i] >= 0) acc[down[i]] += acc[i];
  acc.roofDrops = roofDrops;
  return acc;
}
