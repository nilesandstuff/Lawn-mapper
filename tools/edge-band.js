/**
 * How much of a lawn's error lies along the true edge, and how much is a
 * mistake a person would see.
 *
 * WHY (owner, 2026-09-27): B01 was drawn all but perfectly -- "missed maybe
 * 20 sq ft in corners, overdrew maybe 10 sq ft of sidewalk" -- and scored
 * 10.8% wrong, which on a 4,987 sq ft lawn is about 540 sq ft. Most runs look
 * like that: near-perfect pictures, about 10% out. Two things can produce it
 * without either the picture or the scorer being wrong:
 *
 *   - the decoder answers once per backbone patch (about 1.5 m) and that
 *     answer is smoothed onto the 15 cm scoring grid, so the edge cannot be
 *     placed finer than a fraction of a patch. A band half a metre wide along
 *     a 100 m edge is 50 m², 540 sq ft, and is invisible at phone zoom;
 *   - the picture is the TRACE (smoothed, holes filled, speckle dropped) and
 *     the number is the raw MASK, so they describe different objects.
 *
 * This measures the first: every wrong cell's distance, in cells, from the
 * truth's boundary, and the share within `cells` of it. The second is the
 * traced error the caller computes beside it.
 */

/**
 * Distance in cells (8-neighbour steps) from the nearest cell that touches
 * the truth's edge, capped at `cap`. Only cells inside the parcel count as
 * ground; the property line is not a lawn edge.
 */
export function edgeDistance({ truth, within, w, h, cap = 64 }) {
  const n = w * h;
  const INF = 0xffff;
  const dist = new Uint16Array(n).fill(INF);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const inside = (i) => !within || within[i];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inside(i)) continue;
      const t = truth[i] ? 1 : 0;
      /* A cell is on the edge when a 4-neighbour inside the parcel differs. */
      const differs = (j) => inside(j) && (truth[j] ? 1 : 0) !== t;
      if ((x > 0 && differs(i - 1)) || (x < w - 1 && differs(i + 1))
        || (y > 0 && differs(i - w)) || (y < h - 1 && differs(i + w))) {
        dist[i] = 0;
        queue[tail++] = i;
      }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i];
    if (d >= cap) continue;
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || (!dx && !dy)) continue;
        const j = yy * w + xx;
        if (dist[j] > d + 1) { dist[j] = d + 1; queue[tail++] = j; }
      }
    }
  }
  return dist;
}

/**
 * Of the cells `got` gets wrong against `truth` (inside the parcel), how many
 * lie within each radius of the truth's edge. `radii` are in cells.
 * Returns { wrong, near: [count per radius] }.
 */
export function edgeBand({ truth, got, within, w, h, radii }) {
  const cap = Math.max(...radii) + 1;
  const dist = edgeDistance({ truth, within, w, h, cap });
  const near = radii.map(() => 0);
  let wrong = 0;
  for (let i = 0; i < w * h; i++) {
    if (within && !within[i]) continue;
    if (Boolean(got[i]) === Boolean(truth[i])) continue;
    wrong++;
    for (let k = 0; k < radii.length; k++) if (dist[i] <= radii[k]) near[k]++;
  }
  return { wrong, near };
}

/**
 * WHETHER THE PICTURE AND THE TRACE ARE OUT OF REGISTER. Every method scores
 * about 10% on B01, colour-only too (it works at 15 cm, not on patches), which
 * a systematic offset between photograph and truth would also produce. So
 * slide `got` by up to `reach` cells each way and report the shift with the
 * fewest wrong cells inside the parcel. A consistent nonzero best shift
 * across lots is a registration bug; zero is the answer to hope for.
 * Returns { dx, dy, wrong, wrongAtZero } in cells.
 */
export function bestShift({ truth, got, within, w, h, reach = 4 }) {
  let best = null;
  let atZero = 0;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      let wrong = 0;
      for (let y = 0; y < h; y++) {
        const sy = y - dy;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (within && !within[i]) continue;
          const sx = x - dx;
          const g = sx >= 0 && sx < w && sy >= 0 && sy < h ? got[sy * w + sx] : 0;
          if (Boolean(g) !== Boolean(truth[i])) wrong++;
        }
      }
      if (!dx && !dy) atZero = wrong;
      if (!best || wrong < best.wrong || (wrong === best.wrong && dx * dx + dy * dy < best.dx * best.dx + best.dy * best.dy)) {
        best = { dx, dy, wrong };
      }
    }
  }
  return { ...best, wrongAtZero: atZero };
}
