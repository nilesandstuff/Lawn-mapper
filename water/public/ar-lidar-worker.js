/**
 * THE LOT'S LIDAR FOR "YOU ARE HERE" (public/ar.js; lib/ar-lidar.js; FINDINGS H68). A module worker, so reading and
 * gridding a few hundred thousand points does not stall the camera.
 *
 * In:  { load: { origin: [lng, lat] (map metres are east/north of it), box: [e0, n0, e1, n1] map metres,
 *               lidar: the shade map's kept cloud (tools.shade.data.lidar: { url, box, shift }) or null } }
 *       { register: { id, stand, ground, prior, s } }   (lib/ar-lidar.js register, here beside the grids)
 * Out: { progress: text } as it goes; { ready: { points, solid, cloud, shift } } or { error }; { fix, id }.
 *
 * The same cloud, and the same move onto the photo's ground, as the water map itself (lib/site.js, lib/lowspots.js):
 * the shade map's kept shift when the map has one, else the NAD83 correction at the flight's epoch.
 */
import { workerIo } from '/lib/browser-io.js';
import { pointsIn, toMerc } from '/lib/ept.js';
import { nad83Correction } from '/lib/datum.js';
import { fromLocal } from '/lib/ar-align.js';
import { buildGrids, register } from '/lib/ar-lidar.js';

let G = null;

self.onmessage = async ({ data }) => {
  if (data.register) {
    const { id, stand, ground, prior, s } = data.register;
    let fix;
    try { fix = G ? register(G, stand, ground, prior, { s, ...(prior?.T ? { searchM: prior.searchM ?? 4, searchDeg: prior.searchDeg ?? 15 } : {}) }) : { ok: false, why: 'the lidar is not read yet' }; } catch (e) { fix = { ok: false, why: e.message }; }
    self.postMessage({ fix, id });
    return;
  }
  if (!data.load) return;
  try {
    const { origin, box, lidar } = data.load;
    const [lng, lat] = origin;
    const k = Math.cos((lat * Math.PI) / 180);
    self.postMessage({ progress: 'Finding the lidar survey…' });
    let cloud = lidar?.url ? { url: lidar.url, name: lidar.name || "the shade map's survey", epoch: lidar.epoch ?? null } : null;
    if (!cloud) {
      const res = await fetch(`/api/shade/lidar?lng=${lng}&lat=${lat}`);
      if (!res.ok) throw new Error(`the lidar search answered ${res.status}`);
      cloud = (await res.json()).clouds?.[0] || null;
      if (!cloud) throw new Error('no public lidar over this property');
    }
    const io = await workerIo('/lib');
    // the box in web mercator, from its corners in map metres
    const a = toMerc(fromLocal(origin, [box[0], box[1]])), b = toMerc(fromLocal(origin, [box[2], box[3]]));
    const bbox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const { cols, flown } = await pointsIn(cloud.url, bbox, io, { lat, tries: 12, progress: (done, total) => { if (total) self.postMessage({ progress: `Reading the lidar: ${done} of ${total} pieces…` }); } });
    if (!cols.n) throw new Error('the survey has no points here');
    // onto the photo's ground: the shade map's shift (web mercator units) or the datum at the flight's epoch (metres)
    let east = 0, north = 0, how = 'none';
    if (Array.isArray(lidar?.shift) && lidar.shift.length === 2) { east = lidar.shift[0] * k; north = lidar.shift[1] * k; how = "the shade map's"; }
    else {
      const epoch = cloud.epoch || (flown ? 1970 + flown.mid / (365.25 * 864e5) : null);
      if (epoch) { const d = nad83Correction(lat, lng, epoch); east = d.east; north = d.north; how = `the datum at ${epoch.toFixed(1)}`; }
    }
    self.postMessage({ progress: `Gridding ${cols.n.toLocaleString()} lidar points…` });
    const [ox, oy] = toMerc(origin);
    const e = new Float64Array(cols.n), n = new Float64Array(cols.n);
    for (let i = 0; i < cols.n; i++) { e[i] = (cols.x[i] - ox) * k + east; n[i] = (cols.y[i] - oy) * k + north; }
    G = buildGrids({ e, n, z: cols.z, cls: cols.cls, nret: cols.nret }, box);
    self.postMessage({ ready: { points: cols.n, solid: G.solid, cell: G.cell, cloud: cloud.name || null, shift: how } });
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
