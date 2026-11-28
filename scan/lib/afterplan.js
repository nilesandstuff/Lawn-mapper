/**
 * WHICH MAPS HAVE A WALK NOT YET TAKEN UP (core session, 2026-11-26): shared by workflow S4's planner
 * (scan/tools/after-walk.mjs) and the scan site's own clock (src/after.js), which starts S4 when one is due. Pure.
 */
export const SETTLED_MS = 30 * 60 * 1000, RECENT_MS = 4 * 86400 * 1000, POOL_MAX = 10;   // 6 until 2026-11-27 (the owner: "raise it to 10 and pick the well-aligned ones")
export const FROM_MS = Date.UTC(2026, 10, 24);   // walks before the app sent whole walks (1.25) are not taken up by themselves

/** The id prefixes (twins/<first digits>) that cover walk ids from lo to hi (ms). */
export function prefixesOf(lo, hi, digits = 5) {
  const unit = 10 ** (13 - digits), out = [];
  for (let p = Math.floor(lo / unit); p <= Math.floor(hi / unit); p++) out.push(String(p).padStart(digits, '0'));
  return out;
}

/** A map's marker (auto/<map>.json) as planOf reads it; an old marker was the list of its walks alone. */
export function markerOf(m) {
  if (Array.isArray(m)) return { walks: m, left: [], placed: {}, old: true };
  return { walks: m?.walks || [], left: m?.left || [], placed: m?.placed || {}, old: !!m && !m.left };
}

/** How the S4 run placed a walk: 'ref' through the map's reference, 'own' by its own corners only, 'none' not at all. */
const RANK = { ref: 1, undefined: 2, own: 3, none: 4 };

/**
 * What is due. walks: [{ id, map, settled }], markers: Map(map -> marker). -> [[pool ids newest first, left out ids]],
 * one a map due. A map is due when a settled walk of it is in neither the marker's pool nor its left-out list. Its
 * pool: the new walks first, then those the last run placed through the reference, then the untried, then those
 * placed by their own corners alone, newest first within each; a walk placed not at all only while new; POOL_MAX at
 * the most. The rest are left out, and named so in the marker, so they do not make the map due again (2026-11-27:
 * the older walks of a full pool, never in its marker, made it due every hour and S4 ran back to back all afternoon).
 * An old marker (the list alone, before 2026-11-27) names no left-out walks: by itself only a walk newer than its
 * oldest is new (as section 101 fixed it); asked to repool (S4 run by hand with walks "repool"), every walk it does not
 * name is, and the map pools anew.
 */
export function planOf(walks, markers, { repool = false } = {}) {
  const byMap = new Map();
  for (const w of walks) { if (!w.map || !w.settled) continue; if (!byMap.has(w.map)) byMap.set(w.map, []); byMap.get(w.map).push(w.id); }
  const out = [];
  for (const [map, ids] of byMap) {
    const mk = markerOf(markers.get(map)), known = new Set([...mk.walks, ...mk.left]);
    const floor = !repool && mk.old && mk.walks.length ? Math.min(...mk.walks.map(Number)) : -Infinity;
    const fresh = ids.filter((id) => !known.has(id) && Number(id) > floor);
    if (!fresh.length) continue;
    const rank = (id) => (fresh.includes(id) ? 0 : RANK[mk.placed[id]] ?? 2);
    const all = [...new Set([...fresh, ...mk.walks, ...mk.left, ...ids])].filter((id) => rank(id) < 4)
      .sort((a, b) => rank(a) - rank(b) || Number(b) - Number(a));
    const pool = all.slice(0, POOL_MAX).sort((a, b) => Number(b) - Number(a));
    const left = [...new Set([...mk.walks, ...mk.left, ...ids])].filter((id) => !pool.includes(id)).sort((a, b) => Number(b) - Number(a));
    out.push([pool, left]);
  }
  return out;
}
