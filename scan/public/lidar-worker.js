/**
 * THE LOT'S LIDAR FOR "YOU ARE HERE" (core session; scan/lib/lidar.js). A module worker, so gridding the model and
 * searching it do not stall the camera.
 *
 * Since 2026-11-04 it reads THE SHADE MAP'S FINISHED MODEL (public/lib/lidar-model.js, GET /api/maps/model) and
 * rebuilds nothing: no points, no readers, no rule of its own (the owner: "the AR shouldn't be rebuilding lidar maps
 * from scratch"). The shared structures module is loaded only for its wallsOf and its kind codes.
 *
 * In:  { load: { origin: [lng, lat], box: [e0, n0, e1, n1] map metres, map: the map's id, lawn: traced rings } }
 *      { register: { id, stand, ground, prior, s, high, refs, surface } }
 * Out: { progress }; { ready: { points, solid, cell, cloud, shift, rule, structures, lawnEdge } } or { error }; { fix, id }.
 */
import { toMerc } from '/lib/photo.js';
import { register, MIN_LANDED } from '/lib/lidar.js';
import { loadLidar } from '/lib/lidar-load.js';
// THE SHARED TREE-VERSUS-BUILDING RULE'S MODULE (CLAUDE.md, "One way to read lidar"), copied into this site unchanged
// at deploy time (scan/tools/prepare.mjs): its kind codes and wallsOf. The kinds themselves come from the model.
const sharedRule = () => import('/lib/shade/structures.js');

let G = null;

self.onmessage = async ({ data }) => {
  if (data.register) {
    const { id, stand, ground, prior, s, high = [], refs = false, surface = [] } = data.register;
    let fix;
    try { fix = G ? register(G, stand, ground, prior, { s, high, surface, ...(refs ? { minLanded: MIN_LANDED } : {}), ...(prior?.T ? { searchM: prior.searchM ?? 4, searchDeg: prior.searchDeg ?? 15 } : {}) }) : { ok: false, why: 'no lidar yet' }; } catch (err) { fix = { ok: false, why: `the match failed: ${err.message}` }; }
    self.postMessage({ fix, id });
    return;
  }
  if (!data.load) return;
  try {
    const { origin, box, map, lawn = [] } = data.load;
    const L = await loadLidar({ origin, box, map, lawn }, { toMerc, rule: sharedRule }, (progress) => self.postMessage({ progress }));
    const { cloud, how, rule, counts, shade, k, ox, oy } = L;
    G = L.G;
    const columns = shade.sgrid.w * shade.sgrid.h;
    self.postMessage({ ready: { points: columns, solid: G.solid, cell: G.cell, cloud: cloud.name || null, shift: how, rule, structures: counts, lawnEdge: !!G.lawnSd, modelAt: shade.meta?.at || null } });
    // THE OVERLAY (SCAN-H2): what the match matches against, for the camera view. solids: each solid 0.25 m cell as
    // [e, n, ground, top], as tall as the shade map's column; tall: each shade-map column with anything in it as
    // [e, n, lowest, highest, roof?], the lowest its first cube with any leaf in the shade map's canopy (mu > 0) and
    // the highest its top; dem1: the ground at 1 m; dist: the distance grid, for the agreement dots.
    const sol = [];
    for (let r = 0; r < G.H; r++) for (let cc = 0; cc < G.W; cc++) {
      const k2 = r * G.W + cc; if (!G.occ[k2]) continue;
      const top = Math.min(15, Math.max(0.5, G.occTop[k2] || 0.5));
      sol.push(box[0] + cc * G.cell, box[3] - (r + 1) * G.cell, G.dem[k2], G.dem[k2] + top);
    }
    const tall = [];
    const { kind, sgrid, K, ground, mu, layers } = shade, top = shade.stats.top;
    const cellE = sgrid.cell * k, cellN = (sgrid.cellY || sgrid.cell) * k;
    for (let r = 0; r < sgrid.h; r++) for (let c = 0; c < sgrid.w; c++) {
      const j = r * sgrid.w + c; if (kind[j] === K.NOTHING || !Number.isFinite(ground[j])) continue;
      const e = (sgrid.x0 + c * sgrid.cell - ox) * k, n = (sgrid.y1 - (r + 1) * (sgrid.cellY || sgrid.cell) - oy) * k;
      if (e + cellE < box[0] || e > box[2] || n + cellN < box[1] || n > box[3]) continue;
      let lo = ground[j];
      if (mu && layers) { for (let l = 0; l < layers.nz; l++) if (mu[j * layers.nz + l] > 0) { lo = Math.max(ground[j], layers.z0 + l * layers.dz); break; } }
      const hi = ground[j] + (top && Number.isFinite(top[j]) ? Math.min(80, top[j]) : 3);
      if (hi > lo) tall.push(e, n, lo, hi, kind[j] === K.BUILDING ? 1 : 0);
    }
    const dw = Math.ceil(G.W / 4), dh = Math.ceil(G.H / 4), dem1 = new Float32Array(dw * dh);
    for (let r = 0; r < dh; r++) for (let cc = 0; cc < dw; cc++) dem1[r * dw + cc] = G.dem[Math.min(G.H - 1, r * 4 + 2) * G.W + Math.min(G.W - 1, cc * 4 + 2)];
    const solids = Float32Array.from(sol), tallA = Float32Array.from(tall), dist = Float32Array.from(G.dist);
    self.postMessage({ overlay: { box, cell: G.cell, solids, tall: tallA, tallCell: cellE, dem1: { box, cell: G.cell * 4, W: dw, H: dh, data: dem1 }, dist: { box, cell: G.cell, W: G.W, H: G.H, data: dist } } }, [solids.buffer, tallA.buffer, dem1.buffer, dist.buffer]);
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
