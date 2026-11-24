/**
 * THE FUSED MODEL, MADE WHEN A WALK'S SIDE CHANGES (core session, 2026-11-23; docs/MAPS.md "The fused model"; the
 * owner: "built from both parts, but is seperate from either... an entirely new 3D environment, so the original data
 * is not modified in the process of fusing it"). The shade page fuses when the lidar's side changes; the scan page
 * does when a walk's plants are new, through the SAME module (the features session's public/shade/fuse.js), so the
 * fused file is there and fresh without the shade map having been opened.
 *
 * What is stored says what it was made from (X-Model-Made-From: the lidar file's own write time on the server, the
 * walk's side's time, the fusing's version); when that already names these three, nothing is written, so the two
 * writers never undo each other. Neither source is written: the lidar's file is only read, the walk's side only read.
 *
 * Pure of the page: everything it needs is handed in, so it runs in a test.
 *   fuseWalk({ fetchFn, base, map, plants, origin, F, loadModel, modelFiles, still })
 *     F: the fusing module (fuseModel, openFromSeen?, fusedGrid?, FUSE_VERSION?); still(): false to give up midway.
 *   -> { made: true, ms?, stats } | { made: false, why }
 */
export const madeFromOf = (lidarAt, walkAt, version) => `${lidarAt}|${walkAt}|${version ?? 0}`;

export async function fuseWalk({ fetchFn, base = '', map, plants, origin, F, loadModel, modelFiles, still = () => true }) {
  if (!plants?.boxes?.length || !plants.at) return { made: false, why: 'the walk has no plants on the map' };
  // a walk made on another map of the same lot says where it is measured from (plants.origin, the main site's
  // plantsOfPlace); its own map's walk says nothing and is measured from the map's point
  if (Array.isArray(plants.origin) && plants.origin.every(Number.isFinite)) origin = plants.origin;
  if (!Array.isArray(origin)) return { made: false, why: 'the map has no point' };
  if (typeof F?.fuseModel !== 'function') return { made: false, why: 'no fusing module' };
  const url = `${base}/api/maps/model?id=${encodeURIComponent(map)}&tool=shade`, init = { credentials: 'same-origin' };
  const lh = await fetchFn(url, { ...init, method: 'HEAD' });
  const lidarAt = lh.ok ? lh.headers.get('X-Model-At') : null;
  if (!lidarAt) return { made: false, why: 'no lidar model yet' };
  const want = madeFromOf(lidarAt, plants.at, F.FUSE_VERSION);
  const fh = await fetchFn(`${url}&file=fused`, { ...init, method: 'HEAD' });
  if (fh.ok && fh.headers.get('X-Model-Made-From') === want) return { made: false, why: 'already made from this lidar and this walk' };
  const lidar = await loadModel(fetchFn, url, init);
  if (!lidar) return { made: false, why: 'no lidar model yet' };
  if (!still()) return { made: false, why: 'given up: the page moved on' };
  const open = plants.seen && F.openFromSeen && F.fusedGrid ? await F.openFromSeen(plants.seen, origin, F.fusedGrid(lidar.meta)).catch(() => null) : null;
  // the air seen open above 8 ft (plants.seenHigh), read by the fusing's own reader when it has one; the fusing trims
  // by it only where its leaf calendar allows (in leaf, or not a deciduous crown). The same call as the shade page's.
  const openHigh = plants.seenHigh && F.openHighFromSeen && F.fusedGrid ? await F.openHighFromSeen(plants.seenHigh, origin, F.fusedGrid(lidar.meta)).catch(() => null) : null;
  // the air above 8 ft seen EMPTY IN ANY SEASON (plants.clearHigh, SCAN-PLAN 62), read by the same band reader; a
  // fusing that does not know it ignores it
  const openBare = plants.clearHigh && F.openHighFromSeen && F.fusedGrid ? await F.openHighFromSeen(plants.clearHigh, origin, F.fusedGrid(lidar.meta)).catch(() => null) : null;
  const fused = F.fuseModel(lidar, plants, origin, { open, openHigh, ...(openBare ? { openBare } : {}) });
  const files = await modelFiles(fused);
  const put = (u, body) => fetchFn(u, { ...init, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Model-Made-From': want }, body });
  for (let i = 0; i < (files.parts || []).length; i++) { const r = await put(`${url}&file=fused&part=${i + 1}`, files.parts[i]); if (!r.ok) return { made: false, why: `part ${i + 1} refused (${r.status})` }; }
  const r = await put(`${url}&file=fused`, files.main);
  if (!r.ok) return { made: false, why: `the site answered ${r.status}` };
  const f = fused.meta?.fused || {};
  return { made: true, madeFrom: want, withOpenAir: !!open, withOpenHigh: !!openHigh, stats: { refined: f.refined ?? null, added: f.added ?? null, trimmed: f.trimmed ?? null, moved: (f.moved || []).length } };
}
