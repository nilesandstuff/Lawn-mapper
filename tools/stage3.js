/**
 * Stage 3 of the plan: where does lawn continue under the trees?
 *
 * Stage 1 finds VISIBLE lawn and is taught nothing about canopy (the canopy
 * carries no weight in its training). Stage 2 finds the canopy. This is the
 * reasoning between them, in plain raster geometry over the two masks, with
 * no training and no corpus -- which is why it can be swept and shown as a
 * curve rather than trusted (docs/DETECTOR-FINDINGS.md, THE PLAN).
 *
 * THREE RULES, as the plan states them:
 *
 *   bridge   canopy surrounded by grass through more than ~180 degrees
 *            probably has grass under it -- a clump of canopy whose rim is
 *            mostly stage-1 lawn is filled in
 *   reach    lawn cannot appear more than about 10-15 ft from where stage 1
 *            actually saw grass -- canopy within that distance of visible
 *            lawn becomes lawn, and canopy further in does not
 *   (the "follow the edge" rule is what reach does at a lawn edge: the lawn
 *   runs under the tree as far as the reach and no further)
 *
 * The numbers are placeholders to be swept, not settings. Everything here
 * works on the scoring grid: Uint8Array masks of width w and height h, one
 * cell per CELL_M, with `cells` distances already converted from metres.
 *
 * STAGE 3 OWNS THE CANOPY. Its input is stage 1's answer with every canopy
 * cell cleared to 0 -- stage 1's opinion under a tree is untrained and is not
 * evidence -- and its output differs from that input only on canopy cells.
 * Visible ground is stage 1's and is never touched here.
 */

/** Connected clumps of a mask, 8-connected. Labels are 1-based, 0 is none. */
export function clumps(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    count++;
    let top = 0;
    stack[top++] = start;
    labels[start] = count;
    while (top) {
      const p = stack[--top];
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !labels[q]) { labels[q] = count; stack[top++] = q; }
        }
      }
    }
  }
  return { labels, count };
}

/**
 * Stage 1's answer with the canopy cleared: what stage 3 starts from.
 */
export function clearCanopy(lawn, canopy) {
  const out = new Uint8Array(lawn.length);
  for (let i = 0; i < lawn.length; i++) out[i] = lawn[i] && !canopy[i] ? 1 : 0;
  return out;
}

/**
 * REACH: canopy within `cells` of visible lawn becomes lawn.
 *
 * A breadth-first walk from every visible-lawn cell into the canopy, 8
 * neighbours a step, stopping at `cells` steps. Only canopy cells are ever
 * entered, so the walk cannot cross a driveway or a house to reach a second
 * tree: the lawn has to run under the canopy the whole way.
 */
export function reach(lawn, canopy, w, h, cells) {
  const out = Uint8Array.from(lawn);
  if (cells <= 0) return out;
  const dist = new Int32Array(w * h).fill(-1);
  let frontier = [];
  for (let i = 0; i < w * h; i++) if (lawn[i] && !canopy[i]) { dist[i] = 0; frontier.push(i); }
  for (let step = 1; step <= cells && frontier.length; step++) {
    const next = [];
    for (const p of frontier) {
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (dist[q] >= 0 || !canopy[q]) continue;
          dist[q] = step;
          out[q] = 1;
          next.push(q);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * ENCLOSURE: of the cells reach added, keep only those with visible lawn in
 * at least `sides` of the 8 directions within `cells` steps.
 *
 * WHY. H30 measured reach as a trade: every metre of it added lawn under the
 * lawn's own trees AND crept into the edge of the woods, because the edge of
 * a wood touches the lawn as surely as a lawn tree does. The two differ in
 * how much lawn is round them. A cell just inside a straight wood edge finds
 * lawn in three of eight directions (straight out and the two diagonals) and
 * canopy or nothing in the other five; a cell under a tree standing in a lawn
 * finds lawn in all eight; under a tree at a lawn's corner, five or six.
 *
 * Each ray walks through canopy only, like reach itself, and counts if it
 * meets visible lawn before leaving the canopy, the grid, or the reach.
 * `sides` 0 switches it off, which is the reach H30 measured.
 */
const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

export function enclose(lawn, canopy, reached, w, h, cells, sides) {
  const out = Uint8Array.from(reached);
  if (sides <= 0 || cells <= 0) return out;
  for (let p = 0; p < w * h; p++) {
    if (!reached[p] || !canopy[p]) continue;
    const x0 = p % w, y0 = (p / w) | 0;
    let hits = 0;
    for (const [dx, dy] of DIRS) {
      let x = x0, y = y0;
      for (let step = 1; step <= cells; step++) {
        x += dx; y += dy;
        if (x < 0 || x >= w || y < 0 || y >= h) break;
        const q = y * w + x;
        if (lawn[q]) { hits++; break; }
        if (!canopy[q]) break;
      }
      if (hits >= sides) break;
    }
    if (hits < sides) out[p] = 0;
  }
  return out;
}

/**
 * SPAN: canopy with visible lawn on BOTH sides of it, within `cells` each
 * way along some straight line, becomes lawn.
 *
 * THE OWNER'S RULE, 2026-09-25: grass inferred under canopy has to follow
 * the geometry of the grass that can be seen. Where two pieces of lawn meet
 * a canopy, the lawn under it is the shape that joins them, and it may fall a
 * little beyond that shape but not far. Reach cannot express this: it grows
 * every lawn edge outward by the same distance whether anything is on the
 * other side or not, which is how it crept into the woods (H30) -- and the
 * enclosure rule (H32) counted directions with lawn without asking whether
 * they were opposite each other, so a corner of woods passed it.
 *
 * This is a morphological closing along four line directions (across, down,
 * both diagonals), confined to canopy. A cell inside a straight wood edge
 * has lawn on one side and canopy or nothing on the other along every line
 * and is never filled. A tree standing in a lawn has lawn both ways along
 * every line. A row of trees with lawn on either side has it along the line
 * across the row. A tree against a house has lawn on one side and house on
 * the other -- not filled here, and the bridge decides it from the rim.
 *
 * Each ray walks through canopy only and counts if it meets visible lawn
 * before leaving the canopy, the grid, or `cells`. The lines meet in the
 * middle, so the widest canopy this fills is 2 x `cells` across.
 */
const AXES = [[1, 0], [0, 1], [1, 1], [1, -1]];

export function span(lawn, canopy, w, h, cells) {
  const out = Uint8Array.from(lawn);
  if (cells <= 0) return out;
  const meets = (x, y, dx, dy) => {
    for (let step = 1; step <= cells; step++) {
      x += dx; y += dy;
      if (x < 0 || x >= w || y < 0 || y >= h) return false;
      const q = y * w + x;
      if (lawn[q]) return true;
      if (!canopy[q]) return false;
    }
    return false;
  };
  for (let p = 0; p < w * h; p++) {
    if (!canopy[p] || lawn[p]) continue;
    const x = p % w, y = (p / w) | 0;
    for (const [dx, dy] of AXES) {
      if (meets(x, y, dx, dy) && meets(x, y, -dx, -dy)) { out[p] = 1; break; }
    }
  }
  return out;
}

/**
 * BRIDGE: a clump of canopy whose rim is lawn through more than `minRing`
 * of its length is filled in.
 *
 * The rim is every non-canopy cell touching the clump (8 neighbours). The
 * fraction of it that is lawn is the "degrees of grass around the tree":
 * 0.5 is the plan's 180 degrees. A neighbour OFF THE GRID counts as rim that
 * is not grass: nobody can see what is there, and woods running off the
 * frame's edge with a lawn on one side would otherwise be "surrounded" by
 * the only rim in view.
 *
 * Returns the mask, and the clumps' verdicts for reporting.
 */
export function bridge(lawn, canopy, w, h, { minRing = 0.5 } = {}) {
  const out = Uint8Array.from(lawn);
  const { labels, count } = clumps(canopy, w, h);
  if (!count) return { mask: out, filled: 0, clumps: 0 };
  const rim = new Int32Array(count + 1);
  const grass = new Int32Array(count + 1);
  const seen = new Int32Array(w * h); // which clump last counted this rim cell
  for (let p = 0; p < w * h; p++) {
    const k = labels[p];
    if (!k) continue;
    const x = p % w, y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) { rim[k]++; continue; }
        const q = yy * w + xx;
        if (canopy[q] || seen[q] === k) continue;
        seen[q] = k;
        rim[k]++;
        if (lawn[q]) grass[k]++;
      }
    }
  }
  const fill = new Uint8Array(count + 1);
  let filled = 0;
  for (let k = 1; k <= count; k++) {
    if (rim[k] && grass[k] / rim[k] > minRing) { fill[k] = 1; filled++; }
  }
  for (let p = 0; p < w * h; p++) if (labels[p] && fill[labels[p]]) out[p] = 1;
  return { mask: out, filled, clumps: count };
}

/**
 * The whole of stage 3 over one lawn: clear the canopy, span, reach, then
 * bridge. `spanM` and `reachM` in metres, converted with this lawn's own
 * cell size; `spanM` 0 (the default, and every run before 2026-09-25) is
 * the reach-only stage 3 of H30 to H32.
 *
 * Span first and reach after, so the reach is "a little beyond" the joined
 * shape: it starts from the spanned lawn as well as the visible lawn.
 */
export function stage3(lawn, canopy, w, h, {
  mpp, spanM = 0, reachM = 3, minRing = 0.5, sides = 0,
} = {}) {
  const cleared = clearCanopy(lawn, canopy);
  const spanCells = spanM > 0 && mpp > 0 ? Math.round(spanM / mpp) : 0;
  const spanned = span(cleared, canopy, w, h, spanCells);
  const cells = reachM > 0 && mpp > 0 ? Math.round(reachM / mpp) : 0;
  const reached = enclose(cleared, canopy, reach(spanned, canopy, w, h, cells), w, h, cells, sides);
  const bridged = minRing < 1 ? bridge(reached, canopy, w, h, { minRing }) : { mask: reached, filled: 0, clumps: 0 };
  return { mask: bridged.mask, filled: bridged.filled, clumps: bridged.clumps, cells };
}
