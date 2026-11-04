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
import { decodeModel, modelUsable } from './lidar-model.js';
import { BANDS } from './locate.js';

export const MODEL_PATH = (map, tool = 'shade') => `/api/maps/model?id=${encodeURIComponent(map)}&tool=${tool}`;
export const NO_MODEL = 'this map has no lidar model yet: open it in the shade map first, which builds and saves it';

/** The model's bytes from the site (same origin on the scan site: its Worker passes /api/maps/* to Lawn Mapper). */
export async function fetchModel(map, { fetchFn = fetch, base = '' } = {}) {
  if (!map) throw new Error('no map: the page was opened without one');
  const res = await fetchFn(`${base}${MODEL_PATH(map)}`, { credentials: 'same-origin' });
  if (res.status === 404) throw new Error(NO_MODEL);
  if (!res.ok) throw new Error(`the lidar model could not be read (${res.status})`);
  const m = decodeModel(await res.arrayBuffer());
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
export function gridsFromModel(model, { origin, box, lawn = [], S, toMerc, cell = 0.25 }) {
  const { meta, arrays } = model;
  const sgrid = meta.grid, K = kindsOf(model, S);
  const [ox, oy] = toMerc(origin);
  const k = Math.cos((origin[1] * Math.PI) / 180);
  const kind = arrays.kind, { ground, mu } = arrays, layers = meta.layers;
  const counts = { building: 0, tree: 0, solidTree: 0, structure: 0, unknown: 0, standing: 0 };
  const things1 = new Uint8Array(kind.length), bld1 = new Uint8Array(kind.length);
  /* SOLID FOR THE MATCH: a column the shade map's 3D map has something in AT THE HEIGHT THE PHONE SEES (its cubes
     between standLow and standHigh over the ground with any leaf, mu > 0: a hedge, a trunk, a wall, a shed; not the
     crown a person walks under, whose low cubes the shade map leaves open). The cubes' contents are the shade map's;
     the band is the phone's (locate.js BANDS, the heights its standing points are taken at). A file without cubes
     falls back to the column's kind: every tree, solid tree, structure or unknown column, whole. */
  const standsIn = (j) => {
    if (!mu || !layers || !Number.isFinite(ground[j])) return true;
    const lo = ground[j] + BANDS.standLow, hi = ground[j] + BANDS.standHigh, base = j * layers.nz;
    const l0 = Math.max(0, Math.floor((lo - layers.z0) / layers.dz)), l1 = Math.min(layers.nz - 1, Math.floor((hi - layers.z0) / layers.dz));
    for (let l = l0; l <= l1; l++) if (mu[base + l] > 0) return true;
    return false;
  };
  for (let j = 0; j < kind.length; j++) {
    const v = kind[j];
    if (v === K.BUILDING) { bld1[j] = 1; counts.building++; continue; }
    if (v === K.TREE) counts.tree++; else if (v === K.SOLID_TREE) counts.solidTree++; else if (v === K.STRUCTURE) counts.structure++; else if (v === K.UNKNOWN) counts.unknown++; else continue;
    if (standsIn(j)) { things1[j] = 1; counts.standing++; }
  }
  const at = [ox, oy];
  const dem = valuesOnGrid(arrays.ground, sgrid, box, cell, at, k);
  const things = buildingsOnGrid(things1, sgrid, box, cell, at, k, 1);
  const bld = buildingsOnGrid(bld1, sgrid, box, cell, at, k, 1);
  const top = arrays.top ? valuesOnGrid(arrays.top, sgrid, box, cell, at, k) : null;
  /* A building's walls: the shade map's own rule, wallsOf (2 ft in from the roof's edge, the owner's number), run on
     its BUILDING columns. A STRUCTURE (a stone wall, a shed, bins) has no eaves and is solid at its own edge. */
  let walls = null;
  if (typeof S?.wallsOf === 'function') {
    const wl = S.wallsOf(bld1, sgrid.w, sgrid.h, { cellM: 1, fineM: cell });
    walls = buildingsOnGrid(wl.walls, { x0: sgrid.x0, y1: sgrid.y1, cell: sgrid.cell * wl.cellM, cellY: (sgrid.cellY || sgrid.cell) * wl.cellM, w: wl.w, h: wl.h }, box, cell, at, k, 1);
  }
  const G = buildGrids({ dem, things, bld, walls, top }, box, { cell });
  // the lawn the owner traced: the lawn-edge term's field (scan/lib/surface.js), the AR's own
  const F = lawn.length ? lawnField(lawn, box, cell) : null;
  if (F && F.cells && F.W === G.W && F.H === G.H) G.lawnSd = F.sd;
  if (top) G.wallTop = top;
  const ruleName = `the shade map's model of ${meta.at ? String(meta.at).slice(0, 10) : 'an unknown date'}${meta.photo ? ', low structures judged by the summer photo' : ''}${meta.erased ? `, ${meta.erased} columns erased by hand` : ''}`;
  return {
    G, k, ox, oy, counts, buildings: bld, footprint: walls, rule: ruleName,
    cloud: { name: meta.lidar?.name || "the shade map's survey", url: meta.lidar?.url || null, epoch: meta.lidar?.epoch ?? null },
    how: Array.isArray(meta.lidar?.shift) ? "the shade map's" : 'as the model has it',
    shade: { kind, sgrid, S, K, stats: { top: arrays.top || null }, ground: arrays.ground, mu: arrays.mu || null, layers: meta.layers || null, meta },
  };
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
