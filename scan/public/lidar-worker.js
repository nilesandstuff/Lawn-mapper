/**
 * THE LOT'S LIDAR FOR "YOU ARE HERE" (core session; scan/lib/lidar.js). A module worker, so reading and gridding a
 * few hundred thousand points does not stall the camera. Carried from the water session's
 * water/public/ar-lidar-worker.js (FINDINGS H68) with their agreement; the readers it imports (ept.js, las.js,
 * laz.js, datum.js, browser-io.js, vendor/laz-perf) are copied into this site's /lib at deploy time by
 * scan/tools/prepare.mjs from the water tool's copies, unchanged.
 *
 * In:  { load: { origin: [lng, lat], box: [e0, n0, e1, n1] map metres, lidar: the shade map's kept cloud
 *               (tools.shade.data.lidar: { url, name, epoch, box, shift }) or null } }
 *      { register: { id, stand, ground, prior, s } }
 * Out: { progress }; { ready: { points, solid, cell, cloud, shift } } or { error }; { fix, id }.
 *
 * The same cloud, and the same move onto the photo's ground, as the shade and water maps: the shade map's kept shift
 * when the map has one, else the NAD83 correction at the flight's epoch.
 */
import { workerIo } from '/lib/browser-io.js';
import { pointsIn, toMerc } from '/lib/ept.js';
import { nad83Correction } from '/lib/datum.js';
import { register, MIN_LANDED } from '/lib/lidar.js';
import { loadLidar } from '/lib/lidar-load.js';
import { lawnField } from '/lib/surface.js';
// THE SHARED TREE-VERSUS-BUILDING RULE (CLAUDE.md, "One way to read lidar"): the shade map's own module, copied into
// this site unchanged at deploy time (scan/tools/prepare.mjs). Loaded lazily, so a failure falls back to the old rule.
const sharedRule = () => Promise.all([import('/lib/shade/structures.js'), import('/lib/shade/grid.js')]);

let G = null;

self.onmessage = async ({ data }) => {
  if (data.register) {
    const { id, stand, ground, prior, s, high = [], refs = false, surface = [] } = data.register;
    let fix;
    try { fix = G ? register(G, stand, ground, prior, { s, high, surface, ...(refs ? { minLanded: MIN_LANDED } : {}), ...(prior?.T ? { searchM: prior.searchM ?? 4, searchDeg: prior.searchDeg ?? 15 } : {}) }) : { ok: false, why: 'the lidar is not read yet' }; } catch (e) { fix = { ok: false, why: e.message }; }
    self.postMessage({ fix, id });
    return;
  }
  if (!data.load) return;
  try {
    const { origin, box, lidar, lawn = [] } = data.load;
    const io = await workerIo('/lib');
    const L = await loadLidar({ origin, box, lidar, fetchLidar: async (lng, lat) => {
      const res = await fetch(`/api/shade/lidar?lng=${lng}&lat=${lat}`);
      if (!res.ok) throw new Error(`the lidar search answered ${res.status}`);
      return (await res.json()).clouds?.[0] || null;
    } }, { pointsIn, toMerc, nad83Correction, io, rule: sharedRule }, (progress) => self.postMessage({ progress }));
    const { cols, e, n, cloud, how, rule, counts } = L;
    G = L.G;
    // the lawn the owner traced, for the lawn-edge term (scan/lib/surface.js)
    if (lawn.length) { const F = lawnField(lawn, box, G.cell); if (F.W === G.W && F.H === G.H && F.cells) G.lawnSd = F.sd; }
    self.postMessage({ ready: { points: cols.n, solid: G.solid, cell: G.cell, cloud: cloud.name || null, shift: how, rule, structures: counts, lawnEdge: !!G.lawnSd } });
    // THE OVERLAY (core session, SCAN-H2): what the match matches against, for the camera view. solids: each solid
    // 0.25 m cell as [e, n, ground, top]; tall: each 1 m cell with points 2.5 m or more above the ground as
    // [e, n, lowest, highest, roof?]; dem1: the ground at 1 m; dist: the distance grid, for the agreement dots.
    const sol = [];
    for (let r = 0; r < G.H; r++) for (let cc = 0; cc < G.W; cc++) {
      const k = r * G.W + cc; if (!G.occ[k]) continue;
      const top = G.bld && G.bld[k] ? 3 : Math.max(0.5, G.occTop[k] || 0.5);
      sol.push(box[0] + cc * G.cell, box[3] - (r + 1) * G.cell, G.dem[k], G.dem[k] + top);
    }
    const CW = Math.ceil((box[2] - box[0]) / 1), CH = Math.ceil((box[3] - box[1]) / 1);
    const lo = new Float32Array(CW * CH).fill(Infinity), hi = new Float32Array(CW * CH).fill(-Infinity), roof = new Uint8Array(CW * CH);
    for (let i = 0; i < cols.n; i++) {
      const cl = cols.cls[i]; if (cl === 2 || cl === 7 || cl === 18 || cl === 9) continue;
      const fc = Math.floor((e[i] - box[0]) / G.cell), fr = Math.floor((box[3] - n[i]) / G.cell);
      if (fc < 0 || fr < 0 || fc >= G.W || fr >= G.H) continue;
      const fk = fr * G.W + fc, h = cols.z[i] - G.dem[fk];
      if (h < 2.5) continue;
      const c1 = Math.floor((e[i] - box[0]) / 1), r1 = Math.floor((box[3] - n[i]) / 1), j = r1 * CW + c1;
      if (cols.z[i] < lo[j]) lo[j] = cols.z[i]; if (cols.z[i] > hi[j]) hi[j] = cols.z[i];
      if (G.bld && G.bld[fk]) roof[j] = 1;
    }
    const tall = [];
    for (let r = 0; r < CH; r++) for (let cc = 0; cc < CW; cc++) { const j = r * CW + cc; if (hi[j] > lo[j]) tall.push(box[0] + cc, box[3] - (r + 1), lo[j], hi[j], roof[j]); }
    const dw = Math.ceil(G.W / 4), dh = Math.ceil(G.H / 4), dem1 = new Float32Array(dw * dh);
    for (let r = 0; r < dh; r++) for (let cc = 0; cc < dw; cc++) dem1[r * dw + cc] = G.dem[Math.min(G.H - 1, r * 4 + 2) * G.W + Math.min(G.W - 1, cc * 4 + 2)];
    const solids = Float32Array.from(sol), tallA = Float32Array.from(tall), dist = Float32Array.from(G.dist);
    self.postMessage({ overlay: { box, cell: G.cell, solids, tall: tallA, dem1: { box, cell: G.cell * 4, W: dw, H: dh, data: dem1 }, dist: { box, cell: G.cell, W: G.W, H: G.H, data: dist } } }, [solids.buffer, tallA.buffer, dem1.buffer, dist.buffer]);
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
