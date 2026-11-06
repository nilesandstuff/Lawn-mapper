/**
 * THE LOT'S LIDAR AS THE AR PAGE READS IT: THE SHADE MAP'S FINISHED MODEL, NOTHING REBUILT (core session; the owner,
 * 2026-11-04: "there should be one base set of files for making 3d maps from lidar... When a map goes into the shade
 * map, the lidar gets built, aligned, points get sorted/classified, then the finished output is saved. The AR
 * shouldn't be rebuilding lidar maps from scratch").
 *
 * The shade map writes one file per map (public/lib/lidar-model.js, PUT /api/maps/model?id=&tool=shade); this reads
 * it back and puts its 1 m columns on the match's 0.25 m grid in map metres (scan/lib/lidar.js buildGrids). One
 * function for the page's worker (scan/public/lidar-worker.js) and for the twin check (scan/tools/twin-check.mjs), so
 * the check measures exactly what the phone matched against. The AR's own steps on top of the model -- which
 * cells are solid for the match, a building's walls as its outline, the traced lawn's edge -- are each named in
 * docs/SCAN-DIVERGENCES.md; nothing here reads a lidar point or judges a height.
 */
import { fromLocal } from './frames.js';
import { buildGrids, buildingsOnGrid, valuesOnGrid } from './lidar.js';
import { lawnField } from './surface.js';
import { unpackModel, modelUsable } from './lidar-model.js';
import { BANDS } from './locate.js';
import { ringsOfMask, straighten, offsetRing, fillRings, lineOfPatch, postOf, patchesOf, areaOf, drawSegment } from './outline.js';

export const TRUNK_MAX_COLUMNS = 4; // a patch of standing tree columns this small, under a crown, is a trunk
export const TRUNK_CROWN_M = 3;     // its column's top at least this high: a crown over it, not a bush
export const TRUNK_HALF_M = 0.3;    // drawn and matched as a post this thick each way: a real trunk's surface, a third of a column
export const WALL_HALF_M = 0.15;    // a long thin structure (a wall, a fence) as a line this thick each way

export const MODEL_PATH = (map, tool = 'shade') => `/api/maps/model?id=${encodeURIComponent(map)}&tool=${tool}`;
export const NO_MODEL = 'this map has no lidar model yet: open it in the shade map first, which builds and saves it';

/** The model's bytes from the site (same origin on the scan site: its Worker passes /api/maps/* to Lawn Mapper). */
export async function fetchModel(map, { fetchFn = fetch, base = '' } = {}) {
  if (!map) throw new Error('no map: the page was opened without one');
  const res = await fetchFn(`${base}${MODEL_PATH(map)}`, { credentials: 'same-origin' });
  if (res.status === 404) throw new Error(NO_MODEL);
  if (!res.ok) throw new Error(`the lidar model could not be read (${res.status})`);
  const m = await unpackModel(await res.arrayBuffer());
  if (!modelUsable(m)) throw new Error('the lidar model is incomplete (no grid, ground or kinds)');
  return m;
}

/** The kind codes: the file's own when it names them, else the shared module's. */
export function kindsOf(model, S) {
  const k = model.meta?.rule?.kinds || {};
  const pick = (name, fallback) => (Number.isInteger(k[name]) ? k[name] : fallback);
  return {
    NOTHING: pick('NOTHING', S?.NOTHING ?? 0), BUILDING: pick('BUILDING', S?.BUILDING ?? 1), TREE: pick('TREE', S?.TREE ?? 2),
    SOLID_TREE: pick('SOLID_TREE', S?.SOLID_TREE ?? 3), STRUCTURE: pick('STRUCTURE', S?.STRUCTURE ?? 4), UNKNOWN: pick('UNKNOWN', S?.UNKNOWN ?? 5),
  };
}

/**
 * The match's grids from a model: `origin` [lng, lat] the map's origin, `box` [e0, n0, e1, n1] map metres round it,
 * `lawn` the traced lawn's rings in map metres (the AR's lawn-edge term), `S` the shared structures module (wallsOf
 * and the kind codes), `toMerc` [lng, lat] -> EPSG:3857.
 */
export function gridsFromModel(model, { origin, box, lawn = [], S, toMerc, cell = 0.25, straight = true, treesInMatch = false }) {
  const { meta, arrays } = model;
  const sgrid = meta.grid, K = kindsOf(model, S);
  const [ox, oy] = toMerc(origin);
  const k = Math.cos((origin[1] * Math.PI) / 180);
  const kind = arrays.kind, { ground, mu, returns, low } = arrays, layers = meta.layers;
  const counts = { building: 0, tree: 0, solidTree: 0, structure: 0, unknown: 0, standing: 0 };
  const things1 = new Uint8Array(kind.length), bld1 = new Uint8Array(kind.length);
  /* SOLID FOR THE MATCH: a column with something of ITS OWN at the height the phone sees, 0.4-2.4 m over the ground
     (locate.js BANDS, the heights its standing points are taken at). The shade map's file says what that is, in
     this order of preference (shade findings 35, 2026-11-04: on the owner's lot 59% of the crowned columns the
     cubes alone called solid were solid only through canopy.js's pooling of a sparse flight's neighbours, and 8%
     through the cubes' 1 m steps reaching a crown's underside):
       low      the column's lowest own return over the grass, exact: solid when it falls in the band;
       returns  the column's own returns per cube: solid when a cube overlapping the band has any;
       mu       the pooled canopy (files written before 2026-11-04 evening): solid when a band cube has leaf.
     The band is the AR's; every number in it is the shade map's. A file with none of the three falls back to the
     kind alone: every tree, solid tree, structure or unknown column, whole. */
  const cubesOf = (j) => {
    const lo = ground[j] + BANDS.standLow, hi = ground[j] + BANDS.standHigh;
    return [Math.max(0, Math.floor((lo - layers.z0) / layers.dz)), Math.min(layers.nz - 1, Math.floor((hi - layers.z0) / layers.dz))];
  };
  const standsIn = (j) => {
    if (!Number.isFinite(ground[j])) return true;
    if (low && Number.isFinite(low[j])) return low[j] >= BANDS.standLow && low[j] <= BANDS.standHigh;
    const own = returns || mu;
    if (!own || !layers) return true;
    const [l0, l1] = cubesOf(j), base = j * layers.nz;
    for (let l = l0; l <= l1; l++) if (own[base + l] > 0) return true;
    return false;
  };
  /* HOW TALL A SOLID COLUMN IS DRAWN (the owner, 2026-11-04: "in AR, I'm seeing blue walls under those same
     canopies"; shade findings 35: one low cube, a median 2 m of air, then the crown, drawn as one box to the
     treetop). From its lowest own return up through the cubes that have own returns without a gap; the column's top
     when the file has no per-cube returns. A building's wall is drawn to its top as before. */
  const standTop = new Float32Array(kind.length).fill(NaN);
  for (let j = 0; j < kind.length; j++) {
    const t = arrays.top ? arrays.top[j] : NaN;
    if (!returns || !layers || !Number.isFinite(ground[j])) { standTop[j] = t; continue; }
    const base = j * layers.nz;
    let l = low && Number.isFinite(low[j]) ? Math.max(0, Math.floor((ground[j] + low[j] - layers.z0) / layers.dz)) : cubesOf(j)[0];
    while (l < layers.nz && !(returns[base + l] > 0)) l++;
    if (l >= layers.nz) { standTop[j] = t; continue; }
    let e = l; while (e + 1 < layers.nz && returns[base + e + 1] > 0) e++;
    standTop[j] = Math.min(Number.isFinite(t) ? t : Infinity, layers.z0 + (e + 1) * layers.dz - ground[j]);
  }
  for (let j = 0; j < kind.length; j++) {
    const v = kind[j];
    if (v === K.BUILDING) { bld1[j] = 1; counts.building++; continue; }
    if (v === K.TREE) counts.tree++; else if (v === K.SOLID_TREE) counts.solidTree++; else if (v === K.STRUCTURE) counts.structure++; else if (v === K.UNKNOWN) counts.unknown++; else continue;
    if (standsIn(j)) { things1[j] = 1; counts.standing++; }
  }
  const at = [ox, oy];
  const dem = valuesOnGrid(arrays.ground, sgrid, box, cell, at, k);
  let things, bld, walls = null, shapes = null;
  if (straight) {
    shapes = straightShapes({ sgrid, kind, K, things1, bld1, top: arrays.top, returns, ground, layers, ox, oy, k, box, cell, inset: S?.WALL_INSET_M ?? 0.61, lowDx: arrays.lowDx || null, lowDy: arrays.lowDy || null, treesInMatch });
    ({ things, bld, walls } = shapes);
  } else {
    things = buildingsOnGrid(things1, sgrid, box, cell, at, k, 1);
    bld = buildingsOnGrid(bld1, sgrid, box, cell, at, k, 1);
  }
  const topForDraw = arrays.top ? Float32Array.from(arrays.top, (t, j) => (bld1[j] ? t : standTop[j])) : null;
  const top = topForDraw ? valuesOnGrid(topForDraw, sgrid, box, cell, at, k) : null;
  /* A building's walls: the shade map's own rule, wallsOf (2 ft in from the roof's edge, the owner's number), run on
     its BUILDING columns. A STRUCTURE (a stone wall, a shed, bins) has no eaves and is solid at its own edge. */
  if (!straight && typeof S?.wallsOf === 'function') {
    const wl = S.wallsOf(bld1, sgrid.w, sgrid.h, { cellM: 1, fineM: cell });
    walls = buildingsOnGrid(wl.walls, { x0: sgrid.x0, y1: sgrid.y1, cell: sgrid.cell * wl.cellM, cellY: (sgrid.cellY || sgrid.cell) * wl.cellM, w: wl.w, h: wl.h }, box, cell, at, k, 1);
  }
  const G = buildGrids({ dem, things, bld, walls, top }, box, { cell });
  // the lawn the owner traced: the lawn-edge term's field (scan/lib/surface.js), the AR's own
  const F = lawn.length ? lawnField(lawn, box, cell) : null;
  if (F && F.cells && F.W === G.W && F.H === G.H) G.lawnSd = F.sd;
  if (arrays.top) G.wallTop = valuesOnGrid(arrays.top, sgrid, box, cell, at, k);
  const ruleName = `the shade map's model of ${meta.at ? String(meta.at).slice(0, 10) : 'an unknown date'}${meta.photo ? ', low structures judged by the summer photo' : ''}${meta.erased ? `, ${meta.erased} columns erased by hand` : ''}`;
  return {
    G, k, ox, oy, counts: shapes ? { ...counts, ...shapes.counts } : counts, buildings: bld, footprint: walls, rule: ruleName + (shapes ? `, straightened (${shapes.counts.buildingsStraight} buildings, ${shapes.counts.wallLines} walls as lines, ${shapes.counts.treesIgnored ? `${shapes.counts.treesIgnored} tree columns ignored` : `${shapes.counts.trunks} trunks as posts`})` : ''),
    cloud: { name: meta.lidar?.name || "the shade map's survey", url: meta.lidar?.url || null, epoch: meta.lidar?.epoch ?? null },
    how: Array.isArray(meta.lidar?.shift) ? "the shade map's" : 'as the model has it',
    shade: { kind, sgrid, S, K, trunkCols: shapes?.trunkCols || null, stats: { top: arrays.top || null, standTop }, ground: arrays.ground, mu: arrays.mu || null, returns: returns || null, low: low || null, layers: meta.layers || null, meta },
  };
}

/**
 * STRAIGHT THINGS MADE STRAIGHT (owner, 2026-11-05; scan/lib/outline.js; docs/SCAN-DIVERGENCES.md step 3b). From the
 * model's 1 m columns, on the match's fine grid:
 *   bld     every building's outline traced, fitted with straight sides, near-square corners squared, filled
 *   walls   that outline moved 2 ft in (the shade map's own number, WALL_INSET_M), filled: the inside of the walls
 *   things  a long thin STRUCTURE patch (a wall, a fence) as one line through its middle; any other STRUCTURE patch
 *           (a shed, bins) as its straightened outline; a TRUNK -- a patch of TRUNK_MAX_COLUMNS or fewer standing tree
 *           columns under a crown -- as one post where its own returns are; every other standing column (a bush, a
 *           hedge, an unknown thing) as its columns, untouched ("let's not touch trees")
 */
/* TREES OUT OF THE MATCH (the owner, 2026-11-06: "lidar tree trunks are not reliable. I'm working on that with the
   shade map. For now, we need to ignore them"): no tree column, post or not, is a solid the match may rest on, unless
   treesInMatch is set (the tests). Buildings and STRUCTURE stay. docs/SCAN-DIVERGENCES.md step 9. */
export function straightShapes({ sgrid, kind, K, things1, bld1, top, returns, ground, layers, ox, oy, k, box, cell, inset, lowDx = null, lowDy = null, treesInMatch = false }) {
  const cy = sgrid.cellY || sgrid.cell, w = sgrid.w, h = sgrid.h;
  const toM = ([gx, gy]) => [(sgrid.x0 + gx * sgrid.cell - ox) * k, (sgrid.y1 - gy * cy - oy) * k];
  const centre = (j) => toM([(j % w) + 0.5, ((j / w) | 0) + 0.5]);
  const counts = { buildingsStraight: 0, wallLines: 0, shedsStraight: 0, trunks: 0, treesIgnored: 0 };
  const trunkCols = new Uint8Array(w * h); // the columns made into posts, so the drawing does not box them again
  // buildings
  const rings = ringsOfMask(bld1, w, h).map((r) => straighten(r.map(toM)));
  // an outline runs clockwise in map metres (outline.js ringsOfMask: the inside on the right), a courtyard the other way;
  // the walls stand 2 ft into the building from either
  counts.buildingsStraight = rings.filter((r) => areaOf(r) < 0).length;
  const bld = fillRings(rings, box, cell);
  const walls = fillRings(rings.map((r) => offsetRing(r, areaOf(r) < 0 ? inset : -inset)), box, cell);
  // what stands at the phone's height
  const rest = things1.slice(), extra = fillRings([], box, cell), W = Math.max(1, Math.ceil((box[2] - box[0]) / cell));
  const struct = Uint8Array.from(kind, (v, j) => (v === K.STRUCTURE && things1[j] ? 1 : 0));
  for (const patch of patchesOf(struct, w, h)) {
    for (const j of patch) rest[j] = 0;
    const seg = lineOfPatch(patch.map(centre), { colM: sgrid.cell * k });
    if (seg) { drawSegment(extra, box, cell, seg[0], seg[1], WALL_HALF_M); counts.wallLines++; continue; }
    const m = new Uint8Array(w * h); for (const j of patch) m[j] = 1;
    const shed = ringsOfMask(m, w, h).map((r) => straighten(r.map(toM)));
    const f = fillRings(shed, box, cell); for (let i = 0; i < f.length; i++) if (f[i]) extra[i] = 1;
    counts.shedsStraight++;
  }
  const tree = Uint8Array.from(kind, (v, j) => ((v === K.TREE || v === K.SOLID_TREE) && things1[j] ? 1 : 0));
  const ownInBand = (j) => {
    if (!returns || !layers || !Number.isFinite(ground[j])) return 1;
    const l0 = Math.max(0, Math.floor((ground[j] + BANDS.standLow - layers.z0) / layers.dz)), l1 = Math.min(layers.nz - 1, Math.floor((ground[j] + BANDS.standHigh - layers.z0) / layers.dz));
    let n = 0; for (let l = l0; l <= l1; l++) n += returns[j * layers.nz + l]; return n;
  };
  if (!treesInMatch) for (let j = 0; j < tree.length; j++) if (tree[j]) { rest[j] = 0; counts.treesIgnored++; }
  for (const patch of treesInMatch ? patchesOf(tree, w, h) : []) {
    const tall = top && patch.some((j) => top[j] >= TRUNK_CROWN_M);
    if (patch.length > TRUNK_MAX_COLUMNS || !tall) continue;
    for (const j of patch) rest[j] = 0;
    /* where in each column its own standing returns are (the shade map's lowDx, lowDy, cm east and north of the
       column's centre, 2026-11-05): the post within centimetres, not half a column */
    const at = (j) => { const c = centre(j); return lowDx && lowDy ? [c[0] + lowDx[j] / 100, c[1] + lowDy[j] / 100] : c; };
    const p = postOf(patch.map(at), patch.map(ownInBand));
    drawSegment(extra, box, cell, p, p, TRUNK_HALF_M);
    counts.trunks++;
    for (const j of patch) trunkCols[j] = 1;
  }
  const things = buildingsOnGrid(rest, sgrid, box, cell, [ox, oy], k, 1);
  for (let i = 0; i < extra.length; i++) if (extra[i]) things[i] = 1;
  void W;
  return { bld, walls, things, counts, trunkCols };
}

/**
 * The model, fetched and gridded. `rule` -> Promise<structures module> (the browser and Node find it at different
 * paths); `fetchFn` for Node. Returns gridsFromModel's answer plus `model`.
 */
export async function loadLidar({ origin, box, map, lawn = [] }, { toMerc, rule, fetchFn = fetch, base = '' }, progress = () => {}) {
  progress("Reading the shade map's lidar model…");
  const model = await fetchModel(map, { fetchFn, base });
  const S = rule ? await rule() : null;
  progress(`Gridding ${model.meta.grid.w * model.meta.grid.h} lidar columns…`);
  return { ...gridsFromModel(model, { origin, box, lawn, S, toMerc }), model };
}

/* so a caller can map a point into the model's box the way the page does */
export { fromLocal };
