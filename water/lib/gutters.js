/**
 * WHERE A ROOF'S RAIN LANDS (water session, 2026-10-18).
 *
 * Owner, 2026-10-18: "Gutters will divide the output of rain collected on
 * roofs." The user enters, per downspout, the spot on the roof edge it
 * empties FROM and the spot on the ground it empties TO; and may draw
 * gutter runs along the eaves.
 *
 *   - Every roof cell sheds to its nearest roof edge (walking the roof).
 *   - An edge under a drawn gutter (within GUTTER_M of the line) sends its
 *     water along that gutter to the gutter's downspout(s): the downspout
 *     whose FROM spot is nearest along the run.
 *   - With downspouts and no gutter lines, every edge of that roof piece is
 *     taken as guttered, and each roof cell goes to the downspout whose FROM
 *     spot is nearest.
 *   - An edge with no gutter drips onto the ground beside it.
 *   - A roof piece with nothing entered sends all its water to its lowest
 *     neighbouring ground cell, as before (lib/impervious.js weightedFlow),
 *     and is marked GUESSED so the page can ask for its downspouts.
 *
 * Places come in as [lng, lat]; `cellOf` turns one into a grid index.
 */

import { toMerc } from './ept.js';

export const GUTTER_M = 1.5, SNAP_M = 2.5;

const N8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/** [lng, lat] -> grid index, or -1 off the grid. */
export function cellOf(g, lngLat) {
  const [x, y] = toMerc(lngLat);
  const [fc, fr] = g.toCell(x, y);
  const c = Math.floor(fc), r = Math.floor(fr);
  return c < 0 || r < 0 || c >= g.W || r >= g.H ? -1 : r * g.W + c;
}

/** Distance (in cells) from cell centre (c, r) to segment a-b (cells). */
function segDist(c, r, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((c - a[0]) * dx + (r - a[1]) * dy) / L)) : 0;
  return Math.hypot(c - (a[0] + t * dx), r - (a[1] + t * dy));
}

/**
 * -> { roofTo: Int32Array (per roof cell, the ground cell its water lands on), pieces: [{ cells, m2,
 *      guessed, downspouts: [index], outlets: { groundCell: m2 } }], unused: [downspout indexes that
 *      matched no roof] }
 * wall: roof mask; filled: the filled ground (for the lowest neighbour); downspouts: [{ from, to }];
 * gutters: [[[lng, lat], ...], ...] (lines).
 */
export function roofRouting(g, wall, filled, { downspouts = [], gutters = [] } = {}) {
  const N = g.W * g.H;
  const roofTo = new Int32Array(N).fill(-1);
  const piece = new Int32Array(N).fill(-1);
  const pieces = [];
  for (let s = 0; s < N; s++) {
    if (!wall[s] || piece[s] >= 0) continue;
    const cells = [s]; piece[s] = pieces.length;
    for (let q = 0; q < cells.length; q++) {
      const i = cells[q], r = Math.floor(i / g.W), c = i % g.W;
      for (const [dr, dc] of N8) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
        const j = rr * g.W + cc;
        if (wall[j] && piece[j] < 0) { piece[j] = pieces.length; cells.push(j); }
      }
    }
    pieces.push({ cells, m2: cells.length * g.cell * g.cell, guessed: false, downspouts: [], outlets: {} });
  }

  // downspouts onto roof pieces: the FROM spot on (or within SNAP_M of) a roof piece
  const snap = Math.ceil(SNAP_M / g.cell);
  const spouts = downspouts.map((d, k) => {
    const from = cellOf(g, d.from), to = cellOf(g, d.to);
    if (from < 0 || to < 0) return null;
    const r = Math.floor(from / g.W), c = from % g.W;
    let best = -1, bd = Infinity;
    for (let rr = Math.max(0, r - snap); rr <= Math.min(g.H - 1, r + snap); rr++) for (let cc = Math.max(0, c - snap); cc <= Math.min(g.W - 1, c + snap); cc++) {
      const j = rr * g.W + cc;
      if (!wall[j]) continue;
      const dd = Math.hypot(rr - r, cc - c);
      if (dd < bd) { bd = dd; best = j; }
    }
    if (best < 0) return null;
    // the outlet must be ground: step off the roof if the tap landed on it
    let out = to;
    if (wall[out]) out = nearestGround(g, wall, out);
    return out < 0 ? null : { k, pieceId: piece[best], fromRC: [best % g.W + 0.5, Math.floor(best / g.W) + 0.5], to: out };
  });
  const unused = [];
  spouts.forEach((s, k) => { if (!s) unused.push(k); else pieces[s.pieceId].downspouts.push(k); });

  const lines = gutters.map((line) => line.map((p) => { const [x, y] = toMerc(p); return g.toCell(x, y); })).filter((l) => l.length >= 2);
  const gutterOf = (c, r) => { // the nearest gutter line within GUTTER_M of a point, -1 none
    let best = -1, bd = GUTTER_M / g.cell;
    lines.forEach((l, li) => { for (let k = 1; k < l.length; k++) { const d = segDist(c, r, l[k - 1], l[k]); if (d <= bd) { bd = d; best = li; } } });
    return best;
  };

  for (const p of pieces) {
    const mine = p.downspouts.map((k) => spouts[k]);
    if (!mine.length && !lines.length) { // nothing entered: the lowest neighbour, as before
      p.guessed = true;
      let outlet = -1;
      for (const i of p.cells) {
        const r = Math.floor(i / g.W), c = i % g.W;
        for (const [dr, dc] of N8) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
          const j = rr * g.W + cc;
          if (!wall[j] && (outlet < 0 || filled[j] < filled[outlet])) outlet = j;
        }
      }
      for (const i of p.cells) roofTo[i] = outlet;
      continue;
    }
    // each roof cell -> its nearest edge cell (breadth first from the edge, over the roof)
    const edgeOf = new Map(), q = [];
    for (const i of p.cells) {
      const r = Math.floor(i / g.W), c = i % g.W;
      let drip = -1;
      for (const [dr, dc] of N8) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
        const j = rr * g.W + cc;
        if (!wall[j] && (drip < 0 || filled[j] < filled[drip])) drip = j;
      }
      if (drip >= 0) { edgeOf.set(i, { edge: i, drip }); q.push(i); }
    }
    for (let h = 0; h < q.length; h++) {
      const i = q[h], r = Math.floor(i / g.W), c = i % g.W, e = edgeOf.get(i);
      for (const [dr, dc] of N8) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
        const j = rr * g.W + cc;
        if (wall[j] && piece[j] === piece[i] && !edgeOf.has(j)) { edgeOf.set(j, e); q.push(j); }
      }
    }
    for (const i of p.cells) {
      const e = edgeOf.get(i);
      if (!e) continue;
      const er = Math.floor(e.edge / g.W), ec = e.edge % g.W;
      let target = e.drip;
      const guttered = lines.length ? gutterOf(ec + 0.5, er + 0.5) >= 0 : mine.length > 0;
      if (guttered && mine.length) {
        let best = null, bd = Infinity;
        for (const s of mine) { const d = Math.hypot(s.fromRC[0] - (ec + 0.5), s.fromRC[1] - (er + 0.5)); if (d < bd) { bd = d; best = s; } }
        target = best.to;
      }
      roofTo[i] = target;
    }
  }
  for (const p of pieces) for (const i of p.cells) if (roofTo[i] >= 0) p.outlets[roofTo[i]] = (p.outlets[roofTo[i]] || 0) + g.cell * g.cell;
  return { roofTo, pieces, unused };
}

function nearestGround(g, wall, i) {
  const r0 = Math.floor(i / g.W), c0 = i % g.W;
  for (let rad = 1; rad <= 6; rad++) {
    let best = -1, bd = Infinity;
    for (let r = r0 - rad; r <= r0 + rad; r++) for (let c = c0 - rad; c <= c0 + rad; c++) {
      if (r < 0 || c < 0 || r >= g.H || c >= g.W) continue;
      const j = r * g.W + c;
      if (wall[j]) continue;
      const d = Math.hypot(r - r0, c - c0);
      if (d < bd) { bd = d; best = j; }
    }
    if (best >= 0) return best;
  }
  return -1;
}
