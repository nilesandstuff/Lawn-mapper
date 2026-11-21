/**
 * THE ROOF CORNERS AGAINST EACH OTHER (core session, 2026-11-21). The owner: "frequent disagreement between the
 * reference points... measure the exact distances between the corners of my roofs to see if our lidar shapes are
 * good or not."
 *
 * A walk marks roof corners: each mark holds where the phone had the corner (its own frame, metres) and where the
 * placement map has it (the lidar's corner, map metres). The distance between two corners needs no placing of the
 * walk at all: the phone's is the distance between its two marks, the map's the distance between its two corners.
 * When they differ, either the phone drifted between the marks (it grows with the walking between them, and differs
 * from walk to walk) or the map's corners are not where the roof's are (the SAME difference in every walk). So the
 * same pair read over several walks tells the two apart; one walk cannot.
 *
 * Pure. marks: live.json's ({ id, map: [e, n], ar: [u, v], odo, by }).
 */
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const cornerKey = (m) => `${m.map[0].toFixed(2)},${m.map[1].toFixed(2)}`;
const ok = (m) => Array.isArray(m?.ar) && Array.isArray(m?.map) && m.ar.every(Number.isFinite) && m.map.every(Number.isFinite) && Number.isFinite(m.odo);

/**
 * One walk's corner pairs. For each two different corners, the two marks nearest each other in the walk (least
 * walking between them, so least drift): -> [{ a, b, mapM, phoneM, diffM (phone - map), walkedM }], a < b the
 * corners' keys. And each corner marked more than once: -> again: [{ key, movedM, walkedM }] between consecutive
 * marks of it (what the phone's frame moved there, drift or a jump).
 */
export function walkPairs(marks) {
  const M = (marks || []).filter(ok), by = new Map();
  for (const m of M) { const k = cornerKey(m); if (!by.has(k)) by.set(k, []); by.get(k).push(m); }
  const keys = [...by.keys()].sort(), pairs = [], again = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    let best = null;
    for (const p of by.get(keys[i])) for (const q of by.get(keys[j])) { const w = Math.abs(p.odo - q.odo); if (!best || w < best.w) best = { p, q, w }; }
    const mapM = d2(best.p.map, best.q.map), phoneM = d2(best.p.ar, best.q.ar);
    pairs.push({ a: keys[i], b: keys[j], mapM, phoneM, diffM: phoneM - mapM, walkedM: best.w });
  }
  for (const [key, list] of by) {
    const s = [...list].sort((a, b) => a.odo - b.odo);
    for (let i = 1; i < s.length; i++) again.push({ key, movedM: d2(s[i].ar, s[i - 1].ar), walkedM: s[i].odo - s[i - 1].odo });
  }
  return { corners: keys, at: new Map(keys.map((k) => [k, by.get(k)[0].map])), pairs, again, scale: scaleOf(pairs) };
}

/**
 * THE PHONE'S SCALE AGAINST THE MAP'S, from one walk's pairs: the one number k that best makes phone = k x map
 * (least squares over the pairs, so the long pairs count most). k under 1: the phone measures short. -> { k, n,
 * restM: what each pair is still off by with the scale taken out (phone / k - map), rmsM, rawRmsM } or null under
 * two pairs. Drift between the marks goes into the rest, not into k, unless it is all one way.
 */
export function scaleOf(pairs) {
  const P = (pairs || []).filter((p) => p.mapM > 1);
  if (P.length < 2) return null;
  const k = P.reduce((a, p) => a + p.phoneM * p.mapM, 0) / P.reduce((a, p) => a + p.mapM * p.mapM, 0);
  const restM = P.map((p) => p.phoneM / k - p.mapM), rms = (v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length);
  return { k, n: P.length, restM, rmsM: rms(restM), rawRmsM: rms(P.map((p) => p.diffM)) };
}

/**
 * The same roof corner in several walks does not always carry the same map place to the centimetre (the page finds
 * the lidar's corners afresh, and a corner can land a few inches off). So the walks' corners are gathered: a corner
 * within `tol` of one already met is that one. Rewrites each walk's pairs (and again, corners) with the shared
 * names, in place; -> the number of distinct corners.
 */
export function shareCorners(walks, tol = 0.6) {
  const met = [];
  for (const w of walks) {
    const name = new Map();
    for (const [k, at] of w.at || []) {
      let hit = met.find((c) => d2(c.at, at) <= tol);
      if (!hit) { hit = { id: `c${String(met.length).padStart(3, '0')}`, at }; met.push(hit); }
      name.set(k, hit.id);
    }
    const n = (k) => name.get(k) || k;
    w.pairs = w.pairs.map((p) => { const [a, b] = [n(p.a), n(p.b)].sort(); return { ...p, a, b }; }).filter((p) => p.a !== p.b);
    w.again = w.again.map((a) => ({ ...a, key: n(a.key) }));
    w.corners = [...new Set(w.corners.map(n))];
  }
  return met.length;
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/**
 * The same pair over several walks. walks: [{ pairs }] (walkPairs), all of one map.
 * -> [{ a, b, mapM, n, diffs: [m], medianM, spreadM (half the range), verdict }], the pairs read in two walks or
 * more first. verdict: 'map' when every walk gives the same difference (within `same`) and it is not nothing (over
 * `least`): the map's corners are that much nearer or farther than the roof's; 'phone' when the walks differ among
 * themselves by more than `same`; 'agree' when all are within `least`; 'once' when only one walk read it.
 */
export function acrossWalks(walks, { same = 0.2, least = 0.15 } = {}) {
  const by = new Map();
  for (const w of walks) for (const p of w.pairs || []) { const k = `${p.a}|${p.b}`; if (!by.has(k)) by.set(k, { a: p.a, b: p.b, mapM: p.mapM, diffs: [] }); by.get(k).diffs.push(p.diffM); }
  const out = [...by.values()].map((x) => {
    const n = x.diffs.length, med = median(x.diffs), spread = (Math.max(...x.diffs) - Math.min(...x.diffs)) / 2;
    const verdict = n < 2 ? 'once' : spread > same ? 'phone' : Math.abs(med) > least ? 'map' : 'agree';
    return { ...x, n, medianM: med, spreadM: spread, verdict };
  });
  return out.sort((p, q) => q.n - p.n || Math.abs(q.medianM) - Math.abs(p.medianM));
}

/**
 * How far each corner would have to move for the map's distances to match the walks' (the pairs called 'map' or
 * 'agree'): a corner in several pairs that are all long or all short is the one that is off. -> Map key -> { n,
 * meanM }: the mean of its pairs' differences, signed (plus: the roof's corner is farther from the others than the
 * map's). A reading, not a fit: three corners cannot say which one of them moved.
 */
export function cornerLean(across) {
  const by = new Map();
  for (const p of across) { if (p.n < 2 || p.verdict === 'phone') continue; for (const k of [p.a, p.b]) { if (!by.has(k)) by.set(k, []); by.get(k).push(p.medianM); } }
  return new Map([...by].map(([k, v]) => [k, { n: v.length, meanM: v.reduce((a, b) => a + b, 0) / v.length }]));
}
