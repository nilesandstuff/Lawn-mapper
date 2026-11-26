/**
 * WHICH MAPS HAVE A WALK NOT YET TAKEN UP (core session, 2026-11-26): shared by workflow S3's planner
 * (scan/tools/after-walk.mjs) and the scan site's own clock (src/after.js), which starts S3 when one is due. Pure.
 */
export const SETTLED_MS = 30 * 60 * 1000, RECENT_MS = 4 * 86400 * 1000, POOL_MAX = 6;
export const FROM_MS = Date.UTC(2026, 10, 24);   // walks before the app sent whole walks (1.25) are not taken up by themselves

/** The id prefixes (twins/<first digits>) that cover walk ids from lo to hi (ms). */
export function prefixesOf(lo, hi, digits = 5) {
  const unit = 10 ** (13 - digits), out = [];
  for (let p = Math.floor(lo / unit); p <= Math.floor(hi / unit); p++) out.push(String(p).padStart(digits, '0'));
  return out;
}

/** What is due. walks: [{ id, map, settled }], markers: Map(map -> [ids]). -> [[ids newest first]], one a map due */
export function planOf(walks, markers) {
  const byMap = new Map();
  for (const w of walks) { if (!w.map || !w.settled) continue; if (!byMap.has(w.map)) byMap.set(w.map, []); byMap.get(w.map).push(w.id); }
  const out = [];
  for (const [map, ids] of byMap) {
    const had = markers.get(map) || [], fresh = ids.filter((id) => !had.includes(id));
    if (!fresh.length) continue;
    out.push([...new Set([...fresh, ...had])].sort((a, b) => Number(b) - Number(a)).slice(0, POOL_MAX));
  }
  return out;
}

