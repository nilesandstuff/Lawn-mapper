/**
 * THE LOT'S LIDAR AS THE AR PAGE READS IT (core session): the cloud, moved onto the photo's ground, the shared rule's
 * buildings and short structures and its walls 2 ft in, and the match's grids. One function for the page's worker
 * (scan/public/lidar-worker.js) and for the twin check (scan/tools/twin-check.mjs), so the check measures exactly what
 * the phone matched against. The readers and the shared rule are handed in, because the browser and Node find them
 * at different paths: { pointsIn, toMerc, nad83Correction, io, rule: () => Promise<[structures module, grid module]> }.
 */
import { fromLocal } from './frames.js';
import { buildGrids, buildingsOnGrid } from './lidar.js';

export async function loadLidar({ origin, box, lidar, fetchLidar }, { pointsIn, toMerc, nad83Correction, io, rule }, progress = () => {}) {
  const [lng, lat] = origin;
  const k = Math.cos((lat * Math.PI) / 180);
  progress('Finding the lidar survey…');
  let cloud = lidar?.url ? { url: lidar.url, name: lidar.name || "the shade map's survey", epoch: lidar.epoch ?? null } : null;
  if (!cloud) {
    cloud = await fetchLidar(lng, lat);
    if (!cloud) throw new Error('no public lidar over this property');
  }
  const a = toMerc(fromLocal(origin, [box[0], box[1]])), b = toMerc(fromLocal(origin, [box[2], box[3]]));
  const bbox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const { cols, flown } = await pointsIn(cloud.url, bbox, io, { lat, tries: 12, progress: (done, total) => { if (total) progress(`Reading the lidar: ${done} of ${total} pieces…`); } });
  if (!cols.n) throw new Error('the survey has no points here');
  let east = 0, north = 0, how = 'none';
  if (Array.isArray(lidar?.shift) && lidar.shift.length === 2) { east = lidar.shift[0] * k; north = lidar.shift[1] * k; how = "the shade map's"; }
  else {
    const epoch = cloud.epoch || (flown ? 1970 + flown.mid / (365.25 * 864e5) : null);
    if (epoch) { const d = nad83Correction(lat, lng, epoch); east = d.east; north = d.north; how = `the datum at ${epoch.toFixed(1)}`; }
  }
  progress(`Gridding ${cols.n.toLocaleString()} lidar points…`);
  const [ox, oy] = toMerc(origin);
  const e = new Float64Array(cols.n), n = new Float64Array(cols.n);
  for (let i = 0; i < cols.n; i++) { e[i] = (cols.x[i] - ox) * k + east; n[i] = (cols.y[i] - oy) * k + north; }
  // the buildings by the shared rule, on the shade map's 1 m grid over the same (shifted) ground (CLAUDE.md "One way
  // to read lidar"): BUILDING and STRUCTURE solid, and the walls 2 ft in from a roof's edge (wallsOf)
  let buildings = null, footprint = null, under = null, ruleName = 'the AR copy of the water rule (the shared module did not load)', counts = null, shade = null;
  try {
    const [S, { gridOver }] = await rule();
    const sgrid = gridOver(bbox, 1, lat);
    const s = S.structuresFrom(cols, sgrid, { shift: [east / k, north / k] });
    const solid = new Uint8Array(s.kind.length);
    for (let j = 0; j < solid.length; j++) solid[j] = s.kind[j] === S.BUILDING || (S.STRUCTURE != null && s.kind[j] === S.STRUCTURE) ? 1 : 0;
    buildings = buildingsOnGrid(solid, sgrid, box, 0.25, [ox, oy], k, 1);
    if (typeof S.wallsOf === 'function') {
      const wl = S.wallsOf(solid, sgrid.w, sgrid.h, { cellM: 1, fineM: 0.25 });
      footprint = buildingsOnGrid(wl.walls, { x0: sgrid.x0, y1: sgrid.y1, cell: sgrid.cell * wl.cellM, w: wl.w, h: wl.h }, box, 0.25, [ox, oy], k, 1);
    }
    ruleName = `the shared rule (public/shade/structures.js${footprint ? ', walls 2 ft in' : ''})`; counts = s.counts;
    shade = { kind: s.kind, sgrid, S, stats: s.stats };
    // under a crown: the AR's own choice not to match low points there (lidar.js buildGrids opts.under)
    under = buildingsOnGrid(Uint8Array.from(s.kind, (v) => (v === S.TREE || v === S.SOLID_TREE ? 1 : 0)), sgrid, box, 0.25, [ox, oy], k, 1);
  } catch (err) { ruleName += `: ${err.message}`; }
  const G = buildGrids({ e, n, z: cols.z, cls: cols.cls, nret: cols.nret }, box, { buildings, footprint, under });
  return { G, cols, e, n, k, ox, oy, cloud, how, rule: ruleName, counts, shade, buildings, footprint };
}
