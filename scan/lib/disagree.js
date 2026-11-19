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
 * appear to all fall on the ground, or an arborvitae"). So the ground is taken from the points instead.
 *
 * On GROUND_CELL squares, IN ONE STRETCH OF THE WALK (GROUND_SECS: tracking drifts in height, and the same spot seen
 * twice sits at two heights), a square's ground is its LOWEST SUBSTANTIAL LAYER: the lowest 0.1 m band that, with
 * the band above it, holds GROUND_SHARE of the square's points (GROUND_PTS or more). A point's ground is the MEDIAN
 * of that over its square and the eight round it, in its stretch and the ones before and after. With none, the kept
 * height stands.
 *
 * (The first try, the same day, took the 5th percentile of each square and the LOWEST of the 27: on the real walks
 * the phone's depth noise below the ground dragged it down, and ground read as standing -- 96 m2 of standing became
 * 348 on one walk. A lowest-of-many is a noise detector. The test now has noise in it.)
 *
 * recs: [{ e, n, y (session height), t (s), ground (the kept height) }] -> Float64Array of heights.
 */
export const GROUND_CELL = 0.5, GROUND_PTS = 8, GROUND_SECS = 20, GROUND_SHARE = 0.2, GROUND_BAND = 0.1;
export function heights(recs) {
  const key = (r, dx = 0, dy = 0, dt = 0) => `${Math.floor(r.e / GROUND_CELL) + dx},${Math.floor(r.n / GROUND_CELL) + dy},${Math.floor(r.t / GROUND_SECS) + dt}`;
  const cols = new Map();
  for (const r of recs) { if (!Number.isFinite(r.y) || !Number.isFinite(r.e)) continue; const k = key(r); let c = cols.get(k); if (!c) cols.set(k, c = []); c.push(r.y); }
  const low = new Map();
  for (const [k, ys] of cols) {
    if (ys.length < GROUND_PTS) continue;
    ys.sort((a, b) => a - b);
    // the lowest band that, with the one above, holds GROUND_SHARE of the square: a window of 2 bands slid up the sorted heights
    let hi = 0, got = null;
    for (let lo = 0; lo < ys.length && got == null; lo++) {
      while (hi < ys.length && ys[hi] < ys[lo] + 2 * GROUND_BAND) hi++;
      if (hi - lo >= GROUND_SHARE * ys.length) got = ys[lo + ((hi - lo) >> 1)];
    }
    if (got != null) low.set(k, got);
  }
  const out = new Float64Array(recs.length);
  recs.forEach((r, i) => {
    const near = [];
    for (let dt = -1; dt <= 1; dt++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = low.get(key(r, dx, dy, dt)); if (v != null) near.push(v); }
    near.sort((a, b) => a - b);
    out[i] = r.y - (near.length ? near[near.length >> 1] : r.ground);
  });
  return out;
}

/**
 * SEEN FROM MORE THAN ONE PLACE (2026-11-19). The owner, on the phone's depth: "it correctly calls the distance up to
 * like 60-80 feet... BUT there's some jitter, occasionally, where it can get stuck at like half the distance, then
 * take a second of moving the camera around to get the right distance... there's depth noise, like with the ground,
 * but the noise tends to be clustered, and can be seen past with a change of position." And of the ground:
 * "Perhaps consensus/majority votes from different angles?"
 *
 * So each point is asked two things of the rest of the walk, on CUBE cubes (depth_audit.py's judge, SCAN-H26, here
 * for every point at every distance):
 *   views   how many separate stretches of the walk (VIEW_SECS) saw something in its cube
 *   free    how many sight lines of OTHER stretches passed through its cube on their way to something farther
 * A point is "seen past" when free > 2 x the points seen in its cube; "confirmed" when views >= 2 and not seen past.
 *
 * lines: [{ c: [x, y, z] (the camera), p: [x, y, z] (the point), t (s) }] in one frame. -> { views, free, seen } arrays.
 */
export const CUBE = 0.3, CARVE_STEP = 0.15, VIEW_SECS = 5;
export function carve(lines) {
  const K = (x, y, z) => (Math.floor(x / CUBE) + 4096) * 67108864 + (Math.floor(y / CUBE) + 4096) * 8192 + (Math.floor(z / CUBE) + 4096);
  const view = (t) => Math.floor(t / VIEW_SECS);
  const seen = new Map(), views = new Map(), free = new Map();
  const end = new Float64Array(lines.length);
  lines.forEach((l, i) => {
    const k = end[i] = K(l.p[0], l.p[1], l.p[2]);
    seen.set(k, (seen.get(k) || 0) + 1);
    let v = views.get(k); if (!v) views.set(k, v = new Set()); v.add(view(l.t));
  });
  // free: a cube a line crosses well short of its end, counted once per line, kept per stretch so a point's own
  // stretch does not vouch against it
  for (const l of lines) {
    const d = [l.p[0] - l.c[0], l.p[1] - l.c[1], l.p[2] - l.c[2]], r = Math.hypot(d[0], d[1], d[2]);
    if (!(r > 3 * CUBE)) continue;
    const v = view(l.t);
    let last = -1;
    for (let s = CUBE; s < r - 2 * CUBE; s += CARVE_STEP) {
      const k = K(l.c[0] + (d[0] * s) / r, l.c[1] + (d[1] * s) / r, l.c[2] + (d[2] * s) / r);
      if (k === last) continue; last = k;
      if (!seen.has(k)) continue;           // only cubes that hold a point are asked about
      let f = free.get(k); if (!f) free.set(k, f = new Map());
      f.set(v, (f.get(v) || 0) + 1);
    }
  }
  const out = { views: new Int32Array(lines.length), free: new Int32Array(lines.length), seen: new Int32Array(lines.length) };
  lines.forEach((l, i) => {
    const k = end[i], v = view(l.t), f = free.get(k);
    out.views[i] = views.get(k).size; out.seen[i] = seen.get(k);
    let n = 0; if (f) for (const [fv, c] of f) if (fv !== v) n += c;
    out.free[i] = n;
  });
  return out;
}
export const seenPast = (c, i) => c.free[i] > 2 * c.seen[i];
export const confirmed = (c, i) => c.views[i] >= 2 && !seenPast(c, i);

/**
 * WHICH POINTS TO KEEP: EVERY ONE THAT ITS NAME MAKES LIKELY; A SECOND LOOK ONLY FOR THE ODD ONES (2026-11-19).
 * The owner, on the study of the second look (docs/SCAN-PLAN.md 31): "my last round of thoughts were too strict...
 * We should keep more points, and only strictly require a second look confirmation for anomalous points that don't
 * have a name. We can leverage the segmentation (and probably even just the google scene semantics for a faster live
 * processing?) to add context to points to determine what is likely an anomaly... - we can assume that any point
 * that sits like 5 inches higher/lower than a neighbor on a grass lawn is probably an anomaly and smooth that out
 * unless it's confirmed from a different angle. - buildings have a wider margin, maybe 5 feet. - trees can be all
 * over the place. Not certain on the best way to handle that."
 *
 * So, by what a point is named (kindOf: Google's scene label today; a cut-into-things name can stand in):
 *   ground    (terrain, road, sidewalk) kept. More than GROUND_ODD from the middle height of the ground-named
 *             points round it (the 0.5 m squares about it, the same stretch of the walk): a real bump when CONFIRMED,
 *             else SMOOTHED to that middle height.
 *   built     (building, structure) kept when BUILT_NEAR other built-named points lie within BUILT_REACH; alone,
 *             only when confirmed.
 *   tree      kept, wherever it is.
 *   no name   (none, unlabeled, object, vehicle, person, sky, water) kept only when confirmed.
 * A point the recording marked weak (depth under the live confidence cut) needs confirming whatever its name.
 *
 * pts: [{ e, n, y, t, label, weak }], C: carve() of the same points in the same order.
 * -> { verdict: Uint8Array (KEEP, BUMP, SMOOTHED, TENTATIVE), y: Float64Array (the height to use), kind: [], tally }
 */
export const GROUND_ODD = 0.13, BUILT_REACH = 1.5, BUILT_NEAR = 4, KEEP = 0, BUMP = 1, SMOOTHED = 2, TENTATIVE = 3;
const KIND = { terrain: 'ground', road: 'ground', sidewalk: 'ground', building: 'built', structure: 'built', tree: 'tree' };
export const kindOf = (label) => KIND[label] || 'none';
export function judge(pts, C, kind = (p) => kindOf(p.label)) {
  const kinds = pts.map(kind);
  const gk = (p, dx = 0, dy = 0, dt = 0) => `${Math.floor(p.e / GROUND_CELL) + dx},${Math.floor(p.n / GROUND_CELL) + dy},${Math.floor(p.t / GROUND_SECS) + dt}`;
  const bk = (p, dx = 0, dy = 0) => `${Math.floor(p.e / BUILT_REACH) + dx},${Math.floor(p.n / BUILT_REACH) + dy}`;
  const ground = new Map(), built = new Map();
  pts.forEach((p, i) => {
    if (kinds[i] === 'ground' && Number.isFinite(p.y)) { const k = gk(p); let a = ground.get(k); if (!a) ground.set(k, a = []); a.push(p.y); }
    if (kinds[i] === 'built') built.set(bk(p), (built.get(bk(p)) || 0) + 1);
  });
  const out = { verdict: new Uint8Array(pts.length), y: new Float64Array(pts.length), kind: kinds,
    tally: { ground: 0, bump: 0, smoothed: 0, built: 0, builtAlone: 0, tree: 0, noName: 0, noNameUnconfirmed: 0, weakUnconfirmed: 0 } };
  const T = out.tally;
  pts.forEach((p, i) => {
    const ok = confirmed(C, i);
    out.y[i] = p.y;
    if (p.weak && !ok) { T.weakUnconfirmed++; out.verdict[i] = TENTATIVE; return; }
    if (kinds[i] === 'ground') {
      T.ground++;
      const near = [];
      for (let dt = -1; dt <= 1; dt++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const a = ground.get(gk(p, dx, dy, dt)); if (a) for (const v of a) near.push(v); }
      if (near.length < 6) return;                    // nothing to be odd against: kept as it is
      near.sort((a, b) => a - b);
      const mid = near[near.length >> 1];
      if (Math.abs(p.y - mid) <= GROUND_ODD) return;
      if (ok) { T.bump++; out.verdict[i] = BUMP; } else { T.smoothed++; out.verdict[i] = SMOOTHED; out.y[i] = mid; }
    } else if (kinds[i] === 'built') {
      T.built++;
      let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += built.get(bk(p, dx, dy)) || 0;
      if (n < BUILT_NEAR && !ok) { T.builtAlone++; out.verdict[i] = TENTATIVE; }
    } else if (kinds[i] === 'tree') T.tree++;
    else { T.noName++; if (!ok) { T.noNameUnconfirmed++; out.verdict[i] = TENTATIVE; } }
  });
  return out;
}

/**
 * THE GROUND, BY MORE THAN ONE LOOK (2026-11-19; the owner: "legitimate low spots and permanent mounds do exist in
 * lawns... Itd be nice to map legitimate low spots and high spots. Perhaps consensus/majority votes from different
 * angles?"). Each GROUND_CELL square's ground (its lowest substantial layer, as heights() takes it) is found
 * separately for each stretch of the walk (GROUND_SECS) that saw it. How far those looks agree is the size of bump
 * the walk could map: -> { squares, one, two, more, spread: sorted differences (m) between each look and its
 * square's median, for squares with two looks or more }.
 */
export function groundLooks(recs) {
  const cols = new Map();
  for (const r of recs) {
    if (!Number.isFinite(r.y) || !Number.isFinite(r.e)) continue;
    const k = `${Math.floor(r.e / GROUND_CELL)},${Math.floor(r.n / GROUND_CELL)}`, v = Math.floor(r.t / GROUND_SECS);
    let c = cols.get(k); if (!c) cols.set(k, c = new Map());
    let ys = c.get(v); if (!ys) c.set(v, ys = []); ys.push(r.y);
  }
  const out = { squares: 0, one: 0, two: 0, more: 0, spread: [] };
  for (const c of cols.values()) {
    const lows = [];
    for (const ys of c.values()) {
      if (ys.length < GROUND_PTS) continue;
      ys.sort((a, b) => a - b);
      let hi = 0, got = null;
      for (let lo = 0; lo < ys.length && got == null; lo++) { while (hi < ys.length && ys[hi] < ys[lo] + 2 * GROUND_BAND) hi++; if (hi - lo >= GROUND_SHARE * ys.length) got = ys[lo + ((hi - lo) >> 1)]; }
      if (got != null) lows.push(got);
    }
    if (!lows.length) continue;
    out.squares++;
    if (lows.length === 1) { out.one++; continue; }
    if (lows.length === 2) out.two++; else out.more++;
    lows.sort((a, b) => a - b);
    const med = lows.length % 2 ? lows[lows.length >> 1] : (lows[lows.length / 2 - 1] + lows[lows.length / 2]) / 2;
    for (const v of lows) out.spread.push(Math.abs(v - med));
  }
  out.spread.sort((a, b) => a - b);
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
