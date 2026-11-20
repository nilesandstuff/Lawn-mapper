/**
 * A WALK'S HEIGHTS PINNED TO THE LIDAR'S GROUND, STRETCH BY STRETCH (core session, 2026-11-20; docs/SCAN-REVIEW.md C).
 *
 * MEASURED (docs/SCAN-PLAN.md 34): the ground of a walk lies in levels about 5 in apart, and two visits to one
 * spot differ by 5-6 in while one visit is 4 in thick. The phone's height drifts as it goes (ordinary for its
 * tracking). The lidar's ground does not drift, so each stretch of the walk is slid up or down to sit on it.
 *
 * THE LIDAR IS A BLUNT TOOL (the owner, 2026-11-20: "you shouldn't treat it as perfect"): 1 m columns, good to
 * about 4 in, years old. So it is asked only for what it is good at -- ONE number for each PIN_M of walking, the
 * middle of thousands of points -- never for the shape of the ground inside a stretch, which stays the walk's own.
 * And the proof is not the lidar's: `levels` measures the walk against ITSELF (how far two visits to one spot
 * disagree), before and after.
 *
 * Pure: no page, no network.
 */
export const PIN_M = 12;        // metres of walking that share one height offset (between centres it is interpolated)
export const PIN_NEAR_M = 4;    // only ground seen this near pins a stretch: the depth is surest there
export const PIN_MIN = 60;      // points a stretch needs to be pinned by itself

const median = (a) => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : NaN; };
const pctl = (s, f) => s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * f)))];

/** The ground height of a 1 m column grid at a local place, between the columns' centres (bilinear; NaN outside). */
export function lidarGroundAt(ground, sgrid, ox, oy, k, e, n) {
  const fc = (ox + e / k - sgrid.x0) / sgrid.cell - 0.5, fr = (sgrid.y1 - (oy + n / k)) / (sgrid.cellY || sgrid.cell) - 0.5;
  const c0 = Math.floor(fc), r0 = Math.floor(fr), a = fc - c0, b = fr - r0;
  let sum = 0, w = 0;
  for (const [c, r, wt] of [[c0, r0, (1 - a) * (1 - b)], [c0 + 1, r0, a * (1 - b)], [c0, r0 + 1, (1 - a) * b], [c0 + 1, r0 + 1, a * b]]) {
    if (c < 0 || r < 0 || c >= sgrid.w || r >= sgrid.h) continue;
    const v = ground[r * sgrid.w + c];
    if (Number.isFinite(v) && wt > 0) { sum += v * wt; w += wt; }
  }
  return w > 0.25 ? sum / w : NaN;
}

/**
 * pts: ground points [{ y, odo, dist, lidar }] (y the walk's height, lidar the lidar's ground there).
 * -> { off(odo): the height to take off a point seen at odo, stretches: [{ odo, off, n, spread }], pinned, drift }
 * A stretch with too few points takes its neighbours' offsets (interpolated); a walk with none is left as it is.
 */
export function pinPlan(pts, { stretch = PIN_M, near = PIN_NEAR_M, least = PIN_MIN } = {}) {
  const by = new Map();
  for (const p of pts) {
    if (!(p.dist <= near) || !Number.isFinite(p.lidar) || !Number.isFinite(p.y)) continue;
    const k = Math.floor(p.odo / stretch); let a = by.get(k); if (!a) by.set(k, a = []); a.push(p.y - p.lidar);
  }
  const stretches = [...by.entries()].filter(([, a]) => a.length >= least).sort((a, b) => a[0] - b[0]).map(([k, a]) => {
    const s = Float64Array.from(a).sort();
    return { odo: (k + 0.5) * stretch, off: s[s.length >> 1], n: s.length, spread: pctl(s, 0.9) - pctl(s, 0.1) };
  });
  const off = (odo) => {
    if (!stretches.length) return 0;
    if (odo <= stretches[0].odo) return stretches[0].off;
    for (let i = 1; i < stretches.length; i++) if (odo <= stretches[i].odo) { const a = stretches[i - 1], b = stretches[i], f = (odo - a.odo) / (b.odo - a.odo); return a.off + f * (b.off - a.off); }
    return stretches[stretches.length - 1].off;
  };
  const offs = stretches.map((s) => s.off);
  return { off, stretches, pinned: stretches.length, drift: offs.length ? Math.max(...offs) - Math.min(...offs) : 0 };
}

/**
 * HOW WELL A WALK AGREES WITH ITSELF: pts [{ e, n, t, h }] (h any height), in columns of `col` metres.
 * -> { columns, thick: middle thickness of a column (its middle 80%), twice: columns seen on two visits `gap` s
 *      apart, visits: the middle difference between their visits' own levels, one: a single visit's thickness }
 */
export function levels(pts, { col = 0.5, gap = 20, least = 40, visit = 12 } = {}) {
  const by = new Map();
  for (const p of pts) { if (!Number.isFinite(p.h)) continue; const k = `${Math.floor(p.e / col)},${Math.floor(p.n / col)}`; let a = by.get(k); if (!a) by.set(k, a = []); a.push(p); }
  const thick = [], visits = [], one = [];
  for (const a of by.values()) {
    if (a.length < least) continue;
    const s = Float64Array.from(a, (p) => p.h).sort();
    thick.push(pctl(s, 0.9) - pctl(s, 0.1));
    a.sort((x, y) => x.t - y.t);
    const vs = []; let cur = [a[0]];
    for (let i = 1; i < a.length; i++) { if (a[i].t - a[i - 1].t > gap) { vs.push(cur); cur = []; } cur.push(a[i]); }
    vs.push(cur);
    const big = vs.filter((v) => v.length >= visit);
    if (big.length < 2) continue;
    const m = big.map((v) => median(v.map((p) => p.h)));
    visits.push(Math.max(...m) - Math.min(...m));
    one.push(median(big.map((v) => { const q = Float64Array.from(v, (p) => p.h).sort(); return pctl(q, 0.9) - pctl(q, 0.1); })));
  }
  return { columns: thick.length, thick: median(thick), thick75: thick.length ? pctl(Float64Array.from(thick).sort(), 0.75) : NaN, twice: visits.length, visits: median(visits), visits75: visits.length ? pctl(Float64Array.from(visits).sort(), 0.75) : NaN, one: median(one) };
}
