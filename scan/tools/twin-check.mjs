/**
 * HOW A WALK'S TWIN LINES UP WITH THE LIDAR, IN NUMBERS (core session, 2026-11-03). The owner, after a walk on a new
 * lawn: "there are blue 'walls' underneath tree canopies... there should be plenty of data from this walk for you to
 * dig into." Run by workflow "S. Yard AR tool", task `twin`, on a twin already fetched (scan/tools/twin-r2.mjs get).
 *
 * The lidar is read exactly as the AR page reads it (scan/lib/lidar-load.js), and the phone's points placed as the
 * walk placed them (its lidar fixes, else its references; scan/lib/twin.js placer). Then, counted:
 *   - the solid cells the match uses, by where they came from: the lidar's own points 0.25-2.5 m up (trunks, fences,
 *     low branches, shrubs) or the walls drawn 2 ft inside a BUILDING or a STRUCTURE; and how many of each stand
 *     under a tree's crown (the shade map's TREE / SOLID_TREE columns);
 *   - the STRUCTURE columns, and how many touch a tree's (the ring round canopies);
 *   - the phone's standing points: how many land within 30 cm of a solid cell, over a crown or not;
 *   - the solid cells near the walk that the phone never saw anything at (phantoms).
 * NUMBERS ONLY: no coordinates, no address, no picture. The map is read with MAPS_READ_TOKEN from SITE.
 *
 *   SITE=https://lawnmap.example.com MAPS_READ_TOKEN=... node scan/tools/twin-check.mjs twin
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pointsIn, toMerc } from '../../water/lib/ept.js';
import { nad83Correction } from '../../water/lib/datum.js';
import { nodeIo } from '../../water/lib/node-io.js';
import { toLocal } from '../lib/frames.js';
import { ringsOf } from '../lib/photo.js';
import { loadLidar } from '../lib/lidar-load.js';
import { buildingsOnGrid } from '../lib/lidar.js';
import { readCloud, placer, placeCloud } from '../lib/twin.js';

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');

async function main() {
  const dir = process.argv[2] || 'twin';
  const site = (process.env.SITE || '').replace(/\/$/, ''), key = process.env.MAPS_READ_TOKEN;
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const live = existsSync(join(dir, 'live.json')) ? JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')) : { fixes: [], marks: [] };
  const recs = [];
  for (const f of readdirSync(dir).filter((x) => /^cloud-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); recs.push(...readCloud(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  console.log(`Twin: ${recs.length.toLocaleString()} phone points; ${live.fixes.length} lidar fixes, ${live.marks.filter((m) => m.kind === 'ref').length} reference marks${live.ended ? '' : ' (cut short)'}.`);
  if (!meta.map) throw new Error('the twin names no map');
  if (!site || !key) throw new Error('SITE and MAPS_READ_TOKEN are needed to read the map');
  const r = await fetch(`${site}/api/admin/saved-maps/one?id=${encodeURIComponent(meta.map)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`the map could not be read (${r.status})`);
  const m = (await r.json()).map;
  const origin = [m.lng, m.lat];
  const pts = [...ringsOf(m.shapes || []), ...ringsOf(m.parcel ? [m.parcel] : [])].flat().map((p) => toLocal(origin, p));
  const es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
  const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
  const L = await loadLidar({ origin, box, lidar: m.tools?.shade?.data?.lidar || null, fetchLidar: async (lng, lat) => {
    const res = await fetch(`${site}/api/shade/lidar?lng=${lng}&lat=${lat}`);
    return res.ok ? (await res.json()).clouds?.[0] || null : null;
  } }, { pointsIn, toMerc, nad83Correction, io: nodeIo(), rule: () => Promise.all([import('../../public/shade/structures.js'), import('../../public/shade/grid.js')]) });
  const { G, shade } = L;
  const W = G.W, H = G.H, N = W * H;
  console.log(`Lidar: ${L.cols.n.toLocaleString()} points over ${Math.round((box[2] - box[0]) * (box[3] - box[1])).toLocaleString()} m2 (${(L.cols.n / ((box[2] - box[0]) * (box[3] - box[1]))).toFixed(1)} a m2), shift ${L.how}; ${L.rule}.`);
  if (L.counts) console.log(`Shared rule, 1 m columns: ${JSON.stringify(L.counts)}.`);

  // where each solid cell came from: the lidar's own low points, or a drawn wall; and under a crown or not
  const band = new Uint8Array(N);
  const B = { e: L.e, n: L.n, z: L.cols.z, cls: L.cols.cls };
  for (let i = 0; i < L.cols.n; i++) {
    const c = B.cls[i]; if (c === 2 || c === 7 || c === 18 || c === 9 || c === 6) continue;
    const cc = Math.floor((B.e[i] - box[0]) / G.cell), rr = Math.floor((box[3] - B.n[i]) / G.cell);
    if (cc < 0 || rr < 0 || cc >= W || rr >= H) continue;
    const h = B.z[i] - G.dem[rr * W + cc];
    if (h > 0.25 && h < 2.5) band[rr * W + cc] = 1;
  }
  let crown = new Uint8Array(N), structure = new Uint8Array(N), building = new Uint8Array(N);
  if (shade) {
    const { S, sgrid, kind } = shade;
    const tree = Uint8Array.from(kind, (v) => (v === S.TREE || v === S.SOLID_TREE ? 1 : 0));
    crown = buildingsOnGrid(tree, sgrid, box, G.cell, [L.ox, L.oy], L.k, 1);
    structure = buildingsOnGrid(kind, sgrid, box, G.cell, [L.ox, L.oy], L.k, S.STRUCTURE);
    building = buildingsOnGrid(kind, sgrid, box, G.cell, [L.ox, L.oy], L.k, S.BUILDING);
    // the STRUCTURE columns that touch a tree's: the ring round canopies the owner saw (brown on the shade map)
    let st = 0, touch1 = 0, touch2 = 0, patches = 0;
    const w = sgrid.w, h = sgrid.h, seen = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) {
      if (kind[k] !== S.STRUCTURE) continue;
      st++;
      const x = k % w, y = (k / w) | 0;
      let t1 = false, t2 = false;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (tree[yy * w + xx]) { t2 = true; if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) t1 = true; }
      }
      if (t1) touch1++; if (t2) touch2++;
      if (!seen[k]) { patches++; const q = [k]; seen[k] = 1; while (q.length) { const j = q.pop(), jx = j % w, jy = (j / w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = jx + dx, yy = jy + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const i2 = yy * w + xx; if (!seen[i2] && kind[i2] === S.STRUCTURE) { seen[i2] = 1; q.push(i2); } } } }
    }
    console.log(`STRUCTURE: ${st} columns in ${patches} patches; ${st ? pct(touch1, st) : '-'} touch a tree column, ${st ? pct(touch2, st) : '-'} are within 2 m of one.`);
  }
  // the solid cells by source
  const near = (arr, k, r = 1) => { const x = k % W, y = (k / W) | 0; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && arr[yy * W + xx]) return true; } return false; };
  const src = { band: 0, bandUnderCrown: 0, wall: 0, wallOfStructure: 0, wallOfStructureUnderCrown: 0, wallOfBuilding: 0 };
  const kindOfSolid = new Uint8Array(N); // 1 band, 2 wall of a building, 3 wall of a structure
  for (let k = 0; k < N; k++) {
    if (!G.occ[k]) continue;
    if (band[k]) { src.band++; kindOfSolid[k] = 1; if (crown[k]) src.bandUnderCrown++; continue; }
    src.wall++;
    if (near(structure, k, 4) && !near(building, k, 4)) { src.wallOfStructure++; kindOfSolid[k] = 3; if (near(crown, k, 4)) src.wallOfStructureUnderCrown++; } else { src.wallOfBuilding++; kindOfSolid[k] = 2; }
  }
  console.log(`Solid cells (0.25 m) the match uses: ${G.solid.toLocaleString()}. From the lidar's own points 0.25-2.5 m up: ${src.band.toLocaleString()} (${pct(src.bandUnderCrown, src.band)} of them under a crown). Drawn walls: ${src.wall.toLocaleString()}, of buildings ${src.wallOfBuilding.toLocaleString()}, of STRUCTUREs ${src.wallOfStructure.toLocaleString()} (${pct(src.wallOfStructureUnderCrown, src.wallOfStructure)} of those by a crown).`);

  // the phone's points, as the walk placed them
  const modes = live.fixes.length ? ['both', 'refs'] : ['refs'];
  for (const mode of modes) {
    const P = placeCloud(recs, placer(live, mode));
    let st = 0, stHit = 0, stOverCrown = 0, stOverCrownHit = 0, byKind = [0, 0, 0, 0], gr = 0;
    const seenNear = new Uint8Array(N), dz = [];
    for (let i = 0; i < P.pts.length; i += 4) {
      const e = P.pts[i], n = P.pts[i + 1], kd = P.pts[i + 3];
      const c = Math.floor((e - box[0]) / G.cell), r2 = Math.floor((box[3] - n) / G.cell);
      if (c < 0 || r2 < 0 || c >= W || r2 >= H) continue;
      const k = r2 * W + c;
      if (kd === 0) { gr++; continue; }
      if (kd !== 1) continue;
      st++;
      const d = G.dist[k], hit = d <= 0.3;
      if (hit) { stHit++; // which source it landed on: the nearest solid cell within a cell or two
        let best = 0; for (let rr = -1; rr <= 1 && !best; rr++) for (let cc = -1; cc <= 1; cc++) { const j = k + rr * W + cc; if (j >= 0 && j < N && kindOfSolid[j]) { best = kindOfSolid[j]; break; } }
        byKind[best]++; }
      if (crown[k]) { stOverCrown++; if (hit) stOverCrownHit++; }
      for (let rr = -2; rr <= 2; rr++) for (let cc = -2; cc <= 2; cc++) { const j = k + rr * W + cc; if (j >= 0 && j < N) seenNear[j] = 1; }
    }
    // phantoms: solid cells within 6 m of where the phone was that it never saw anything at (within 0.5 m)
    const walked = new Uint8Array(N);
    const pl = placer(live, mode);
    for (const f of readdirSync(dir).filter((x) => /^track-\d+\.bin$/.test(x))) {
      const b = readFileSync(join(dir, f)), a = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      for (let i = 0; i + 10 <= a.length; i += 10) {
        const T = pl(a[i + 1]); if (!T) continue;
        const c0 = Math.cos(T.theta) * T.s, s0 = Math.sin(T.theta) * T.s, u = a[i + 2], v = -a[i + 4];
        const e = c0 * u - s0 * v + T.tx, n = s0 * u + c0 * v + T.ty;
        const cc0 = Math.floor((e - box[0]) / G.cell), rr0 = Math.floor((box[3] - n) / G.cell), R = Math.round(6 / G.cell);
        for (let rr = -R; rr <= R; rr += 2) for (let cc = -R; cc <= R; cc += 2) { const x = cc0 + cc, y = rr0 + rr; if (x >= 0 && y >= 0 && x < W && y < H && rr * rr + cc * cc <= R * R) { walked[y * W + x] = 1; if (x + 1 < W) walked[y * W + x + 1] = 1; if (y + 1 < H) { walked[(y + 1) * W + x] = 1; if (x + 1 < W) walked[(y + 1) * W + x + 1] = 1; } } }
      }
    }
    const ph = [0, 0, 0, 0], tot = [0, 0, 0, 0];
    for (let k = 0; k < N; k++) if (kindOfSolid[k] && walked[k]) { tot[kindOfSolid[k]]++; if (!seenNear[k]) ph[kindOfSolid[k]]++; }
    console.log(`Placed by ${mode === 'refs' ? 'the references alone' : 'the walk\'s fixes, else its references'}: ${P.placed.toLocaleString()} points (${P.unplaced.toLocaleString()} not placed). Standing points ${st.toLocaleString()}: ${pct(stHit, st)} within 30 cm of a solid cell (on the lidar's own points ${byKind[1]}, on building walls ${byKind[2]}, on STRUCTURE walls ${byKind[3]}); ${pct(stOverCrown, st)} of them stand under a crown, and of those ${pct(stOverCrownHit, stOverCrown)} land. Ground points ${gr.toLocaleString()}.`);
    console.log(`  Solid cells within 6 m of the walk that the phone saw nothing at (phantoms): the lidar's own ${ph[1]} of ${tot[1]} (${pct(ph[1], tot[1])}), building walls ${ph[2]} of ${tot[2]} (${pct(ph[2], tot[2])}), STRUCTURE walls ${ph[3]} of ${tot[3]} (${pct(ph[3], tot[3])}).`);
  }
}

// an error can carry a URL with a place in it: long decimals are blanked before it is printed (the repository is public)
main().catch((e) => { console.log(`Twin check: ${String(e.message).replace(/-?\d+\.\d{3,}/g, '#')}`); process.exit(1); });
