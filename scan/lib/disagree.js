/**
 * WHERE A WALK AND THE LIDAR MODEL DISAGREE (core session, 2026-11-18). The owner, working on the water map: "it's
 * hard to say what error comes from the model and what comes from the lidar. Since ar provides a literal view from
 * the ground, that seems like the best possible way to trim out that error". This is the first step and changes
 * nothing: a walk's points, placed on the map by its own roof corners, set against the shade map's finished model on
 * 1 m cells, and the disagreements counted.
 *
 *   seen, not in the lidar   the phone saw something standing (0.4-2.4 m over its ground, SEEN_MIN points) where the
 *                            model has nothing solid at that height within NEAR_M: by the phone's own label, and as
 *                            patches (a long thin one is a fence, a wall or a hedge)
 *   in the lidar, not seen   the model is solid at the phone's height where the phone saw the ground through it
 *                            (GROUND_MIN ground points and no standing ones): by the model's kind
 *   the lawn's line          ground the phone labelled grass outside the traced lawn; ground it labelled paving
 *                            (road, sidewalk) inside it
 *
 * Only cells the phone looked at count, and a cell within NEAR_M of the other side's answer is agreement: a walk is
 * placed to about a foot at best. Pure; the tool (tools/disagree.mjs) reads the twin and the model.
 */
export const CELL = 1;          // m
export const SEEN_MIN = 6;      // standing points in a cell before the phone "saw something" there
export const GROUND_MIN = 12;   // ground points in a cell before the phone "saw the ground" there
export const NEAR_M = 1;        // the other side's answer this near is agreement
export const SURE = 0.5;        // a label's confidence
export const THIN = 1.6;        // a patch this many cells wide at most, per cell of length, is a line
const PAVE = new Set(['road', 'sidewalk']);

/**
 * pts: [{ e, n, h (m over the phone's ground), label, conf, i (optional: the caller's index, kept on patches) }] on the map (metres round its origin).
 * model: { solid(e, n) -> bool (anything of the model's there: what the phone's standing points may agree with),
 *          standing(e, n) -> bool (solid AT THE PHONE'S HEIGHT, what the phone should not see the ground through;
 *          solid when absent), kind(e, n) -> string|null, lawn(e, n) -> bool|null }.
 */
export function disagree(pts, model) {
  const cells = new Map();
  const at = (e, n) => { const k = `${Math.floor(e / CELL)},${Math.floor(n / CELL)}`; let c = cells.get(k); if (!c) { c = { x: Math.floor(e / CELL), y: Math.floor(n / CELL), stand: 0, ground: 0, by: {}, grass: 0, pave: 0 }; cells.set(k, c); } return c; };
  for (const p of pts) {
    if (!Number.isFinite(p.e) || !Number.isFinite(p.n) || !Number.isFinite(p.h)) continue;
    const sure = p.label && (p.conf == null || p.conf >= SURE) ? p.label : null;
    const c = at(p.e, p.n);
    // every sure label counts toward a standing cell's name (2026-11-18: named only by the standing kinds, most
    // patches came out "unlabelled" on a walk whose points were all labelled)
    if (p.h > 0.4 && p.h < 2.4) { c.stand++; if (p.i != null) (c.idx || (c.idx = [])).push(p.i); if (sure) c.by[sure] = (c.by[sure] || 0) + 1; else c.none = (c.none || 0) + 1; }
    else if (Math.abs(p.h) < 0.2) { c.ground++; if (sure === 'terrain') c.grass++; else if (sure && PAVE.has(sure)) c.pave++; }
  }
  const mid = (c) => [(c.x + 0.5) * CELL, (c.y + 0.5) * CELL];
  const near = (c, fn) => { const [e, n] = mid(c); for (let dy = -NEAR_M; dy <= NEAR_M; dy += CELL) for (let dx = -NEAR_M; dx <= NEAR_M; dx += CELL) if (fn(e + dx, n + dy)) return true; return false; };
  const seenNear = (c) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const o = cells.get(`${c.x + dx},${c.y + dy}`); if (o && o.stand >= SEEN_MIN) return true; } return false; };

  const out = { looked: 0, stood: 0, agree: 0, extra: { cells: 0, by: {}, patches: [] }, missing: { cells: 0, by: {} },
    lawn: { grassCells: 0, grassOutside: 0, paveCells: 0, paveInside: 0 } };
  const extra = [];
  for (const c of cells.values()) {
    const [e, n] = mid(c);
    const stood = c.stand >= SEEN_MIN, sawGround = c.ground >= GROUND_MIN;
    if (!stood && !sawGround) continue;
    out.looked++;
    if (stood) {
      out.stood++;
      if (near(c, model.solid)) out.agree++;
      else {
        out.extra.cells++; extra.push(c);
        const top = Object.entries(c.by).sort((a, b) => b[1] - a[1])[0];
        const name = (c.none || 0) > c.stand * 0.7 ? 'unlabelled' : top && top[1] >= c.stand * 0.3 ? top[0] : 'mixed labels';
        out.extra.by[name] = (out.extra.by[name] || 0) + 1; c.name = name;
      }
    } else if ((model.standing || model.solid)(e, n) && !seenNear(c)) {
      out.missing.cells++;
      const k = model.kind(e, n) || 'unknown';
      out.missing.by[k] = (out.missing.by[k] || 0) + 1;
    }
    if (sawGround && !stood) {
      const inLawn = model.lawn(e, n);
      if (inLawn != null) {
        if (c.grass >= c.ground * 0.6) { out.lawn.grassCells++; if (!inLawn && !near(c, (x, y) => model.lawn(x, y) === true)) out.lawn.grassOutside++; }
        if (c.pave >= c.ground * 0.6) { out.lawn.paveCells++; if (inLawn && !near(c, (x, y) => model.lawn(x, y) === false)) out.lawn.paveInside++; }
      }
    }
  }
  // the extra cells as patches: joined when they touch (corners count)
  const left = new Map(extra.map((c) => [`${c.x},${c.y}`, c]));
  for (const c0 of extra) {
    if (!left.has(`${c0.x},${c0.y}`)) continue;
    const q = [c0], got = []; left.delete(`${c0.x},${c0.y}`);
    while (q.length) { const c = q.pop(); got.push(c); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const k = `${c.x + dx},${c.y + dy}`; if (left.has(k)) { q.push(left.get(k)); left.delete(k); } } }
    const xs = got.map((c) => c.x), ys = got.map((c) => c.y);
    const len = Math.hypot(Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1) * CELL;
    const names = {}; for (const c of got) names[c.name] = (names[c.name] || 0) + 1;
    out.extra.patches.push({ cells: got.length, lengthM: +len.toFixed(1), line: got.length >= 3 && got.length <= len * THIN, label: Object.entries(names).sort((a, b) => b[1] - a[1])[0][0] });
    // which of the caller's points (those given an index i) the patch is made of: for the segment trial, never printed
    const idx = got.flatMap((c) => c.idx || []); if (idx.length) out.extra.patches[out.extra.patches.length - 1].idx = idx;
  }
  out.extra.patches.sort((a, b) => b.cells - a.cells);
  return out;
}

/**
 * HEIGHT OVER THE GROUND THE WALK ITSELF SAW NEARBY (2026-11-18). The report first took each point's height over
 * the ground height the page kept under it while walking; the owner looked at every patch "seen, not in the lidar"
 * on two walks and found ground nearly every time ("All but 2 are just regular ground or a real slope"; "pink dots
 * appear to all fall on the ground, or an arborvitae"). So the ground is taken from the points instead: on GROUND_CELL
 * squares, the low edge (5th percentile, GROUND_PTS points or more) of the heights seen there IN THE SAME STRETCH OF
 * THE WALK (GROUND_SECS: tracking drifts in height, and the same spot seen twice sits at two heights), and a point's
 * ground is the lowest of those over its square and the eight round it. With none of them, the kept height stands.
 *
 * recs: [{ e, n, y (session height), t (s), ground (the kept height) }] -> Float64Array of heights.
 */
export const GROUND_CELL = 0.5, GROUND_PTS = 8, GROUND_SECS = 20;
export function heights(recs) {
  const key = (r, dx = 0, dy = 0, dt = 0) => `${Math.floor(r.e / GROUND_CELL) + dx},${Math.floor(r.n / GROUND_CELL) + dy},${Math.floor(r.t / GROUND_SECS) + dt}`;
  const cols = new Map();
  for (const r of recs) { if (!Number.isFinite(r.y) || !Number.isFinite(r.e)) continue; const k = key(r); let c = cols.get(k); if (!c) cols.set(k, c = []); c.push(r.y); }
  const low = new Map();
  for (const [k, ys] of cols) { if (ys.length < GROUND_PTS) continue; ys.sort((a, b) => a - b); low.set(k, ys[Math.floor(ys.length * 0.05)]); }
  const out = new Float64Array(recs.length);
  recs.forEach((r, i) => {
    let g = Infinity;
    for (let dt = -1; dt <= 1; dt++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = low.get(key(r, dx, dy, dt)); if (v != null && v < g) g = v; }
    out[i] = r.y - (g === Infinity ? r.ground : g);
  });
  return out;
}

/** The report as lines: counts, lengths and shares only, never a place. */
export function lines(r) {
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  const P = r.extra.patches, fences = P.filter((p) => p.line);
  return [
    `Looked at: ${r.looked} square metres (the phone saw something standing in ${r.stood}, only the ground in ${r.looked - r.stood}).`,
    `Standing things: ${pct(r.agree, r.stood)} of what the phone saw is in the lidar model within ${NEAR_M} m (${r.agree} of ${r.stood} m2).`,
    `SEEN, NOT IN THE LIDAR: ${r.extra.cells} m2 (${pct(r.extra.cells, r.stood)}); by the phone's label: ${list(r.extra.by)}.`,
    `  in ${P.length} patches; ${fences.length} are long and thin (a fence, a wall, a hedge): ${fences.slice(0, 8).map((p) => `${Math.round(p.lengthM * 3.281)} ft ${p.label}`).join(', ') || 'none'}.`,
    `  the biggest: ${P.slice(0, 6).map((p) => `${p.cells} m2 ${p.label}${p.line ? ' (a line)' : ''}`).join(', ') || 'none'}.`,
    `IN THE LIDAR, NOT SEEN (the phone saw the ground there): ${r.missing.cells} m2; by the model's kind: ${list(r.missing.by)}.`,
    `THE LAWN'S LINE: of ${r.lawn.grassCells} m2 the phone called grass, ${r.lawn.grassOutside} are outside the traced lawn by over ${NEAR_M} m (${pct(r.lawn.grassOutside, r.lawn.grassCells)}); of ${r.lawn.paveCells} m2 it called paving, ${r.lawn.paveInside} are inside it (${pct(r.lawn.paveInside, r.lawn.paveCells)}).`,
  ];
}
