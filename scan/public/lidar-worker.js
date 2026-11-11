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
 *      { walk: { id, ground: [[u, v, y]], prior: { T } } }  (scan/lib/walkfix.js) -> { walk: fix, id }
 * Out: { progress }; { ready: { points, solid, cell, cloud, shift, rule, structures, lawnEdge } } or { error }; { fix, id }.
 */
import { toMerc } from '/lib/photo.js';
import { register, MIN_LANDED } from '/lib/lidar.js';
import { loadLidar } from '/lib/lidar-load.js';
import { walkFix } from '/lib/walkfix.js';
import { lookGrids, lidarPicture } from '/lib/look.js';
import { lidarMarks, returnsFrom } from '/lib/lidar-marks.js';
import { groundPicture } from '/lib/ground-picture.js';
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
  // THE WHOLE WALK AT ONCE (scan/lib/walkfix.js, SCAN-H25): the trail's placement refined by the ground's shape
  if (data.walk) {
    const { id, ground, prior } = data.walk;
    let fix;
    try { fix = G ? walkFix({ box: G.box, cell: G.cell, W: G.W, H: G.H, data: G.dem }, ground, prior) : { ok: false, why: 'no lidar yet' }; } catch (err) { fix = { ok: false, why: `the walk's placement failed: ${err.message}` }; }
    self.postMessage({ walk: fix, id });
    return;
  }
  if (!data.load) return;
  try {
    const { origin, box, map } = data.load;
    // the traced lawn is not given to the match (owner, 2026-11-05; docs/SCAN-DIVERGENCES.md step 5)
    const L = await loadLidar({ origin, box, map, lawn: [] }, { toMerc, rule: sharedRule }, (progress) => self.postMessage({ progress }));
    const { cloud, how, rule, counts, shade, k, ox, oy } = L;
    G = L.G;
    const columns = shade.sgrid.w * shade.sgrid.h;
    self.postMessage({ ready: { points: columns, solid: G.solid, cell: G.cell, cloud: cloud.name || null, shift: how, rule, structures: counts, lawnEdge: !!G.lawnSd, modelAt: shade.meta?.at || null, modelBuild: shade.meta?.build ?? null, modelBasedOn: shade.meta?.basedOn || null } });
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
    /* WHAT YOU SEE IS WHAT IS MATCHED (the owner, 2026-11-05: "none of the post processing you said you did actually
       ended up in the live ar"): roofs drawn from the straightened outline the match uses (G.bld, 0.25 m), as runs
       along each row, not the model's 1 m columns; a trunk made into a post is not boxed again from the ground, its
       column drawn from the crown up only */
    /* (2026-11-07, the owner's screenshot: a gable roof drawn as a flat-topped block) a run along a row was drawn at
       its highest cell, so every row across a ridge stood at the ridge's height. A run now breaks wherever the roof's
       height changes by more than ROOF_STEP, so the roof is drawn at the height the model has, cell by cell. */
    const ROOF_STEP = 0.3;
    const tall = [], roofRuns = [];
    const { kind, sgrid, K, ground, mu, layers, trunkCols } = shade, top = shade.stats.top;
    const roofAt = (k2) => { const g = G.dem[k2], t = G.wallTop ? G.wallTop[k2] : NaN; return Number.isFinite(g) && Number.isFinite(t) ? g + Math.min(40, t) : NaN; };
    for (let r = 0; r < G.H; r++) {
      for (let c0 = 0; c0 < G.W;) {
        const k0 = r * G.W + c0, h0 = roofAt(k0);
        if (!G.bld[k0] || !Number.isFinite(h0)) { c0++; continue; }
        let c1 = c0, lo = Number.isFinite(G.dem[k0]) ? G.dem[k0] : Infinity, hi = h0;
        while (c1 + 1 < G.W && G.bld[k0 + (c1 + 1 - c0)]) {
          const h = roofAt(k0 + (c1 + 1 - c0));
          if (!Number.isFinite(h) || Math.abs(h - h0) > ROOF_STEP) break;
          c1++; hi = Math.max(hi, h); const g = G.dem[k0 + (c1 - c0)]; if (Number.isFinite(g)) lo = Math.min(lo, g);
        }
        if (Number.isFinite(lo) && hi > lo) roofRuns.push(box[0] + c0 * G.cell, box[3] - (r + 1) * G.cell, box[0] + (c1 + 1) * G.cell, box[3] - r * G.cell, lo, hi);
        c0 = c1 + 1;
      }
    }
    const cellE = sgrid.cell * k, cellN = (sgrid.cellY || sgrid.cell) * k;
    // each tree column's crown (lowest leaf to top), for how the lidar looks in the camera (lib/look.js)
    const SN = sgrid.w * sgrid.h, crownLo = new Float32Array(SN).fill(NaN), crownHi = new Float32Array(SN).fill(NaN), isTree = new Uint8Array(SN);
    for (let r = 0; r < sgrid.h; r++) for (let c = 0; c < sgrid.w; c++) {
      const j = r * sgrid.w + c; if (kind[j] === K.NOTHING || kind[j] === K.BUILDING || !Number.isFinite(ground[j])) continue;
      const e = (sgrid.x0 + c * sgrid.cell - ox) * k, n = (sgrid.y1 - (r + 1) * (sgrid.cellY || sgrid.cell) - oy) * k;
      if (e + cellE < box[0] || e > box[2] || n + cellN < box[1] || n > box[3]) continue;
      let lo = ground[j];
      const floor = trunkCols && trunkCols[j] ? ground[j] + 2.4 : -Infinity; // a post's column: the crown only
      if (mu && layers) { for (let l = 0; l < layers.nz; l++) if (mu[j * layers.nz + l] > 0 && layers.z0 + (l + 1) * layers.dz > floor) { lo = Math.max(ground[j], floor, layers.z0 + l * layers.dz); break; } }
      else lo = Math.max(lo, floor);
      const hi = ground[j] + (top && Number.isFinite(top[j]) ? Math.min(80, top[j]) : 3);
      if (hi > lo) tall.push(e, n, lo, hi, kind[j] === K.BUILDING ? 1 : 0);
      if (kind[j] === K.TREE || kind[j] === K.SOLID_TREE) { isTree[j] = 1; if (hi > lo) { crownLo[j] = lo; crownHi[j] = hi; } }
    }
    const dw = Math.ceil(G.W / 4), dh = Math.ceil(G.H / 4), dem1 = new Float32Array(dw * dh);
    for (let r = 0; r < dh; r++) for (let cc = 0; cc < dw; cc++) dem1[r * dw + cc] = G.dem[Math.min(G.H - 1, r * 4 + 2) * G.W + Math.min(G.W - 1, cc * 4 + 2)];
    /* THE LOOK (the owner, 2026-11-10: roofs black, walls white, trees green, other objects orange, at 0.5 m and
       smoothed): the same cells by kind on 0.5 m, for lib/look.js to make surfaces of. For the eye only. */
    const show = lookGrids(G, roofAt, { w: sgrid.w, h: sgrid.h, e0: (sgrid.x0 - ox) * k, n1: (sgrid.y1 - oy) * k, cellE, cellN, tree: isTree, lo: crownLo, hi: crownHi });
    /* THE LIDAR AS A PICTURE TO PLACE POINTS ON (lib/look.js lidarPicture; the owner, 2026-11-10): from the model's
       own returns, where it keeps them; a column's kind is the shade map's, a height is over the shade map's ground. */
    let picture = null, P = null;
    try {
      P = returnsFrom(L);
      if (P) picture = lidarPicture(box, P, undefined, { noRaised: true });
    } catch (err) { self.postMessage({ progress: `the lidar picture could not be made (${err.message})` }); }
    const solids = Float32Array.from(sol), tallA = Float32Array.from(tall), roofsA = Float32Array.from(roofRuns), dist = Float32Array.from(G.dist);
    self.postMessage({ overlay: { show, picture, box, cell: G.cell, solids, tall: tallA, roofRuns: roofsA, tallCell: cellE, dem1: { box, cell: G.cell * 4, W: dw, H: dh, data: dem1 }, dist: { box, cell: G.cell, W: G.W, H: G.H, data: dist } } }, [solids.buffer, tallA.buffer, roofsA.buffer, dem1.buffer, dist.buffer]);
    // the raised things' straight edges and corners, to place points on (lib/lidar-marks.js): after the overlay, since
    // they take some seconds on a phone and the camera view needs none of them
    // the ground alone, hard-edged (lib/ground-picture.js; the owner, 2026-11-11): after the overlay too
    if (P) {
      try {
        const t0 = Date.now(), g = groundPicture(box, P);
        self.postMessage({ ground: { e0: g.e0, n1: g.n1, cell: g.cell, W: g.W, H: g.H, rgba: g.rgba, spacing: g.spacing, levels: g.levels }, progress: `lidar ground picture: ${g.W} x ${g.H} cells of ${g.cell.toFixed(2)} m, ${Date.now() - t0} ms` }, [g.rgba.buffer]);
      } catch (err) { self.postMessage({ progress: `the lidar's ground picture could not be made (${err.message})` }); }
    }
    if (P) {
      try {
        const t0 = Date.now(), M = lidarMarks(box, P);
        const marks = { objects: M.objects.map((o) => ({ id: o.id, kind: o.kind, ring: o.ring, top: o.top, area: o.area, square: o.square, middle: o.middle, traced: !!o.traced })), corners: M.corners, spacing: M.spacing };
        self.postMessage({ marks, progress: `lidar marks: ${M.objects.length} things, ${M.corners.filter((c) => c.kind === 'corner').length} corners (${M.corners.filter((c) => c.sure).length} sure), ${Date.now() - t0} ms` });
      } catch (err) { self.postMessage({ progress: `the lidar's corners could not be found (${err.message})` }); }
    }
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
