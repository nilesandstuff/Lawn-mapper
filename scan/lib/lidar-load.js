/**
 * THE LOT'S LIDAR AS THE AR PAGE READS IT (core session): the cloud, moved onto the photo's ground, the shared rule's
 * buildings and short structures and its walls 2 ft in, and the match's grids. One function for the page's worker
 * (scan/public/lidar-worker.js) and for the twin check (scan/tools/twin-check.mjs), so the check measures exactly what
 * the phone matched against. The readers and the shared rule are handed in, because the browser and Node find them
 * at different paths: { pointsIn, toMerc, nad83Correction, io, rule: () => Promise<[structures module, grid module]> }.
 */
import { fromLocal } from './frames.js';
import { buildGrids, buildingsOnGrid, valuesOnGrid } from './lidar.js';
import { lawnField } from './surface.js';

export const CROWN_M = 3; // m: a tree column at least this tall is a crown the phone walks under; lower, a thing it sees

export async function loadLidar({ origin, box, lidar, fetchLidar, lawn = [] }, { pointsIn, toMerc, nad83Correction, io, rule, decodePng = null }, progress = () => {}) {
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
    /* structuresFor (the features session, 2026-11-04): the rule reads the summer photo itself and judges low
       structures by it (green is a plant, not a shed); without the photo there are no low structures at all. The AR
       tool makes one call and gets every later change to the rule and the photo check with no change of its own. */
    /* The flight's date goes with it (2026-11-04), so the photo read is the summer nearest the flight rather than the
       newest one: a shed built since the flight is not in the lidar, and a tree felled since is. A node caller (the
       twin check) passes decodePng; the page decodes in the browser. */
    const flownMs = flown?.end ?? (cloud.epoch ? (cloud.epoch - 1970) * 365.25 * 864e5 : null);
    const opts = { shift: [east / k, north / k], ...(flownMs ? { flownMs } : {}), ...(decodePng ? { decodePng } : {}) };
    const s = typeof S.structuresFor === 'function' ? await S.structuresFor(cols, sgrid, opts) : S.structuresFrom(cols, sgrid, opts);
    const solid = new Uint8Array(s.kind.length);
    for (let j = 0; j < solid.length; j++) solid[j] = s.kind[j] === S.BUILDING || (S.STRUCTURE != null && s.kind[j] === S.STRUCTURE) ? 1 : 0;
    buildings = buildingsOnGrid(solid, sgrid, box, 0.25, [ox, oy], k, 1);
    if (typeof S.wallsOf === 'function') {
      /* 2 ft in from the edge only for a BUILDING, whose roof overhangs its walls. A STRUCTURE -- a stone wall, a
         shed, bins -- is drawn and matched at its own edge (the owner's walk at work, 2026-11-03: the phone saw
         nothing at 60% of the STRUCTURE wall cells drawn 2 ft inside a stone wall; SCAN-H6). The AR's choice of which
         walls to match; the shared rule's kinds are unchanged. */
      const bOnly = Uint8Array.from(s.kind, (v) => (v === S.BUILDING ? 1 : 0));
      const wl = S.wallsOf(bOnly, sgrid.w, sgrid.h, { cellM: 1, fineM: 0.25 });
      footprint = buildingsOnGrid(wl.walls, { x0: sgrid.x0, y1: sgrid.y1, cell: sgrid.cell * wl.cellM, w: wl.w, h: wl.h }, box, 0.25, [ox, oy], k, 1);
      if (S.STRUCTURE != null) { const st = buildingsOnGrid(s.kind, sgrid, box, 0.25, [ox, oy], k, S.STRUCTURE); for (let j = 0; j < footprint.length; j++) if (st[j]) footprint[j] = 1; }
    }
    ruleName = `the shared rule (public/shade/structures.js${footprint ? ', house walls 2 ft in, other structures at their edge' : ''}; ${s.photo ? 'low structures judged by the summer photo' : 'no summer photo, so no low structures'})`; counts = s.counts;
    shade = { kind: s.kind, sgrid, S, stats: s.stats };
    /* under a crown: the AR's own choice not to match low points there (lidar.js buildGrids opts.under; SCAN-H3).
       A crown is a TREE column standing CROWN_M or more: since the rule's step 7 (2026-11-04, the owner: what no rule
       names is a tree, never left out) a hedge, a low wall or a bush is TREE too, and those the phone sees and the
       match wants. */
    const tall = Uint8Array.from(s.kind, (v, j) => ((v === S.TREE || v === S.SOLID_TREE) && s.stats?.top && s.stats.top[j] >= CROWN_M ? 1 : 0));
    under = buildingsOnGrid(tall, sgrid, box, 0.25, [ox, oy], k, 1);
  } catch (err) { ruleName += `: ${err.message}`; }
  // the lawn the owner traced: the lawn-edge term's field, and where low unclassified points are the ground
  const F = lawn.length ? lawnField(lawn, box, 0.25) : null;
  const lowIn = F && F.cells ? Uint8Array.from(F.sd, (v) => (v > 0.3 ? 1 : 0)) : null;
  const G = buildGrids({ e, n, z: cols.z, cls: cols.cls, nret: cols.nret }, box, { buildings, footprint, under, lowIn });
  if (F && F.cells && F.W === G.W && F.H === G.H) G.lawnSd = F.sd;
  // how tall each building's or structure's wall really stands: its column's top in the shared rule (the owner,
  // 2026-11-03: "the stone wall right next to me is shorter in reality than it is according to the lidar" -- every
  // such wall was drawn 3 m tall)
  if (shade?.stats?.top) G.wallTop = valuesOnGrid(shade.stats.top, shade.sgrid, box, 0.25, [ox, oy], k);
  return { G, cols, e, n, k, ox, oy, cloud, how, rule: ruleName, counts, shade, buildings, footprint };
}
