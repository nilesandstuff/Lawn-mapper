/**
 * ONE SPOT READ NEAR ON A SURFACE THE REST OF THE PICTURE READS FAR (core session, 2026-11-08; the owner: "that wall
 * I was facing had correct depth readings for most of it, it was just one spot on the wall with false readings").
 * Nothing compared a depth reading with its neighbours. The after-walk audit could not test it on the saved walks:
 * the twin keeps a point only in a 5 cm cube not seen before (a median 35 of a picture's 448), so a spot's neighbours
 * are mostly missing. So the page runs it on each whole picture and keeps the verdict with the point.
 *
 *   spikesIn(r, nx, ny, labels?)  r: Float32Array/array of ranges (m, 0 or NaN for none), nx x ny cells row by row;
 *                                 -> Uint8Array, 1 where the cell is a spike
 *
 * A spike: at least MIN_NB readings within RADIUS cells, the cell nearer than NEAR_SHARE of their median and by
 * NEAR_BY m or more, the neighbours agreeing with each other (AGREE of them within 15% of their median: a surface)
 * and the near cells joined to it staying inside the window (a spot up to 3 x 3 cells; a post, a branch or an edge
 * runs on past it and is not a spike). With labels, only
 * neighbours of the same label count. Synthetic yard: every planted wall spot caught, no true wall point flagged.
 */
export const RADIUS = 2, MIN_NB = 4, NEAR_SHARE = 0.6, NEAR_BY = 1.0, AGREE = 0.6;

export function spikesIn(r, nx, ny, labels = null) {
  const out = new Uint8Array(nx * ny), W = 2 * RADIUS + 1;
  const nb = [], near = new Uint8Array(W * W), seen = new Uint8Array(W * W), stack = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, rk = r[k];
    if (!(rk > 0)) continue;
    nb.length = 0; near.fill(0);
    for (let dj = -RADIUS; dj <= RADIUS; dj++) for (let di = -RADIUS; di <= RADIUS; di++) {
      if (!di && !dj) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const q = jj * nx + ii;
      if (!(r[q] > 0)) continue;
      if (labels && labels[q] !== labels[k]) continue;
      nb.push(r[q]);
      if (r[q] < rk * 1.3) near[(dj + RADIUS) * W + di + RADIUS] = 1;
    }
    if (nb.length < MIN_NB) continue;
    const s = nb.slice().sort((a, b) => a - b), med = s[s.length >> 1];
    if (!(rk < NEAR_SHARE * med && rk < med - NEAR_BY)) continue;
    let agree = 0;
    for (const v of nb) if (Math.abs(v - med) < 0.15 * med) agree++;
    if (agree / nb.length < AGREE) continue;
    // the near cells joined to this one must stay inside the window: a spot, not a post or an edge running on
    seen.fill(0); stack.length = 0;
    const c0 = RADIUS * W + RADIUS; seen[c0] = 1; stack.push(c0);
    let enclosed = true;
    while (stack.length && enclosed) {
      const c = stack.pop(), cy = Math.floor(c / W), cx = c % W;
      if (cy === 0 || cx === 0 || cy === W - 1 || cx === W - 1) { enclosed = false; break; }
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const q = (cy + a) * W + cx + b;
        if ((a || b) && near[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (enclosed) out[k] = 1;
  }
  return out;
}
