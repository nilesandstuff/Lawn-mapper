/**
 * TREES DRINKING FROM THE LAWN (water session; owner, 2026-11-09: "Do we even need trunks? It's really the canopy
 * that matters, right?" -- yes: the draw centres on each crown, not on a trunk). The model proposed in
 * research-trees.md (H40), built as proposed; every number in it is SPECULATION until a probe transect measures it
 * (S29):
 *
 *   a tree's day:      T = K_t x ET0 x A            litres; A the crown's area (m2), ET0 capped at treeEt0Cap mm
 *                      K_t broadleaf 0.4, conifer 0.5 (Peters et al. 2010's suburban sap flow ~0.3 to the humid
 *                      plant factor 0.7; Lindsey & Bassuk's sizing rule ~1.0)
 *   from the turf's root zone:  f = 0.4 of it (Jackson et al. 1996: 38-50% of forest roots in the top 20 cm, nudged
 *                      down for turf's suppression of tree roots, Watson 1988); the rest is deeper than the balance
 *   where:             a cone round the crown's middle out to k x R, k = 2 (Gilman 1988: roots 1.7-3.8 crown radii
 *                      on young trees), w = 1 - d/(kR), shared over the cells that are not buildings (roots run under
 *                      paving), and taken only from the cells the balance carries (lawn and the rest of the ground)
 *   when:              broadleaf by the shade map's leaf calendar (its share of leaves out that day), conifers on any
 *                      day the soil is not frozen; and less as the cell dries, by the same Ks the turf uses
 *
 * A crown is conifer when most of its columns are the shade map's evergreen (kind 2), else broadleaf.
 * -> { broad: Float32Array, conifer: Float32Array } per cell: mm drawn per mm of the day's ET0 at full leaf, or null.
 */

export const TREE = { kt: 0.4, ktConifer: 0.5, f: 0.4, k: 2, et0Cap: 5, minR: 1.5 };

export function treeDrawCoefs(grid, kinds, crowns, { shadeKinds = null, opts = TREE } = {}) {
  if (!crowns?.list?.length || !crowns.lab) return null;
  const { W, H, bbox } = grid, N = W * H;
  const cw = (bbox[2] - bbox[0]) / W, ch = (bbox[3] - bbox[1]) / H, cellM = grid.cell || 1; // 3857 units per cell; metres per cell
  // conifer or broadleaf, by the shade map's own reading of each crown's columns
  let conifer = null;
  if (shadeKinds?.length === N) {
    const ev = new Float32Array(crowns.list.length), all = new Float32Array(crowns.list.length);
    for (let i = 0; i < N; i++) { const c = crowns.lab[i]; if (c < 0) continue; all[c]++; if (shadeKinds[i] === 2) ev[c]++; }
    conifer = Uint8Array.from(all, (n, c) => (n && ev[c] / n > 0.5 ? 1 : 0));
  }
  const broad = new Float32Array(N), con = new Float32Array(N);
  for (const c of crowns.list) {
    if (!(c.R >= opts.minR) || !(c.A > 0)) continue;
    const gx = (c.cx - bbox[0]) / cw - 0.5, gy = (bbox[3] - c.cy) / ch - 0.5; // the crown's middle, in cells
    const Rr = (opts.k * c.R) / cellM, r = Math.ceil(Rr);
    const x0 = Math.max(0, Math.floor(gx - r)), x1 = Math.min(W - 1, Math.ceil(gx + r)), y0 = Math.max(0, Math.floor(gy - r)), y1 = Math.min(H - 1, Math.ceil(gy + r));
    let sum = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - gx, y - gy);
      if (d < Rr && kinds[y * W + x] !== 2) sum += 1 - d / Rr;
    }
    if (!(sum > 0)) continue;
    const isCon = conifer ? conifer[c.id] === 1 : false;
    const kt = isCon ? opts.ktConifer : opts.kt, out = isCon ? con : broad;
    const per = (opts.f * kt * c.A * cellM * cellM) / sum / (cellM * cellM); // litres over a cell's m2 = mm, per mm of ET0
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x, k = kinds[i];
      if (k !== 0 && k !== 1) continue; // lawn and the rest of the ground: what the balance carries
      const d = Math.hypot(x - gx, y - gy);
      if (d < Rr) out[i] += per * (1 - d / Rr);
    }
  }
  return { broad, conifer: con };
}
