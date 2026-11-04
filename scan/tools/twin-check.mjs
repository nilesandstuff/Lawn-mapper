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
import { buildingsOnGrid, register, MIN_LANDED, placementCost, LAWN_LOW_M } from '../lib/lidar.js';
import { disagreement, REF_TOL_M, REF_TOL_DEG } from '../lib/locate.js';
import { readCloud, placer, placeCloud } from '../lib/twin.js';
import { apply } from '../lib/align.js';
import { surfaceOf, lawnField, tally } from '../lib/surface.js';
import jpeg from 'jpeg-js';

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');

/** The saved map with its tools' parts: from the database when the runner has the Cloudflare token (the site's edge
 *  answers GitHub's runners 403, as tools/draw-map.mjs found), else through the site's read-only route. */
async function readMap(id, site, key) {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    const { query } = await import('../../tools/corpus-db.js');
    const q = `'${String(id).replace(/'/g, "''")}'`;
    const rows = query(`SELECT m.key, m.lng, m.lat, m.payload, m.user_id FROM maps m JOIN users u ON u.id = m.user_id WHERE u.role = 'admin' AND m.key = ${q}`);
    if (!rows.length) throw new Error('no such map among the owner\'s');
    let payload = {}; try { payload = JSON.parse(rows[0].payload) || {}; } catch { /* empty */ }
    const tools = {};
    for (const t of query(`SELECT tool, data FROM map_tools WHERE owner_kind = 'user' AND owner_id = '${String(rows[0].user_id).replace(/'/g, "''")}' AND map_key = ${q}`)) {
      try { tools[t.tool] = { data: JSON.parse(t.data) }; } catch { /* unreadable part */ }
    }
    return { ...payload, lng: payload.lng ?? rows[0].lng, lat: payload.lat ?? rows[0].lat, tools };
  }
  if (!site || !key) throw new Error('the map needs the Cloudflare token, or SITE and MAPS_READ_TOKEN');
  const r = await fetch(`${site}/api/admin/saved-maps/one?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`the map could not be read (${r.status})`);
  return (await r.json()).map;
}

async function main() {
  const dir = process.argv[2] || 'twin';
  const site = (process.env.SITE || '').replace(/\/$/, ''), key = process.env.MAPS_READ_TOKEN;
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const live = existsSync(join(dir, 'live.json')) ? JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')) : { fixes: [], marks: [] };
  const recs = [];
  for (const f of readdirSync(dir).filter((x) => /^cloud-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); recs.push(...readCloud(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  recs.forEach((r, i) => { r.i = i; });
  console.log(`Twin: ${recs.length.toLocaleString()} phone points; ${live.fixes.length} lidar fixes, ${live.marks.filter((m) => m.kind === 'ref').length} reference marks${live.ended ? '' : ' (cut short)'}.`);
  // a map's key is whatever the page made it (it can name the place): quoted for SQL, never printed
  if (!meta.map || String(meta.map).length > 300 || /[\u0000-\u001f]/.test(String(meta.map))) throw new Error('the twin names no usable map');
  // an error from the database read can quote the query, and so the map's key: not printed
  let m;
  try { m = await readMap(meta.map, site, key); } catch (e) { throw new Error(/no such map|needs the|could not be read \(\d+\)/.test(e.message) ? e.message : 'the map could not be read from the database'); }
  const origin = [m.lng, m.lat];
  const pts = [...ringsOf(m.shapes || []), ...ringsOf(m.parcel ? [m.parcel] : [])].flat().map((p) => toLocal(origin, p));
  const es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
  const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
  const lawnRings = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(origin, p)));
  const L = await loadLidar({ origin, box, lidar: m.tools?.shade?.data?.lidar || null, lawn: lawnRings, fetchLidar: async (lng, lat) => {
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
  let patchOf = null; const patchRows = [];
  const mPerUnit = L.k; // 3857 units to metres at this latitude
  // the shade column under a fine cell, as buildingsOnGrid finds it
  const columnAt = (k) => { if (!shade) return -1; const { sgrid } = shade; const e = box[0] + ((k % W) + 0.5) * G.cell, n = box[3] - (((k / W) | 0) + 0.5) * G.cell; const x = L.ox + e / L.k, y = L.oy + n / L.k; const c = Math.floor((x - sgrid.x0) / sgrid.cell), r = Math.floor((sgrid.y1 - y) / (sgrid.cellY || sgrid.cell)); return c >= 0 && r >= 0 && c < sgrid.w && r < sgrid.h ? r * sgrid.w + c : -1; };
  const patchAtCell = (k) => { if (!patchOf) return -1; const { sgrid } = shade; const c0 = columnAt(k); if (c0 < 0) return -1; const cx = c0 % sgrid.w, cy = (c0 / sgrid.w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = cx + dx, yy = cy + dy; if (xx >= 0 && yy >= 0 && xx < sgrid.w && yy < sgrid.h && patchOf[yy * sgrid.w + xx] >= 0) return patchOf[yy * sgrid.w + xx]; } return -1; };
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
    // each patch, for the features session (2026-11-03): size, heights, returns, nearest tree, contact, phantoms
    patchOf = new Int32Array(w * h).fill(-1);
    const stats = shade.stats || {};
    for (let k0 = 0; k0 < w * h; k0++) {
      if (kind[k0] !== S.STRUCTURE || patchOf[k0] >= 0) continue;
      const id = patchRows.length, cells = [k0]; patchOf[k0] = id;
      for (let q = 0; q < cells.length; q++) { const j = cells[q], jx = j % w, jy = (j / w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = jx + dx, yy = jy + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const i2 = yy * w + xx; if (patchOf[i2] < 0 && kind[i2] === S.STRUCTURE) { patchOf[i2] = id; cells.push(i2); } } }
      const xs = cells.map((j) => j % w), ys = cells.map((j) => (j / w) | 0);
      const tops = cells.map((j) => (stats.top ? stats.top[j] : NaN)).filter(Number.isFinite).sort((x, y) => x - y);
      const firm = stats.firm ? cells.reduce((a2, j) => a2 + stats.firm[j], 0) / cells.length : null;
      let nearest = null, building = false;
      for (const j of cells) {
        const jx = j % w, jy = (j / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = jx + dx, yy = jy + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && kind[yy * w + xx] === S.BUILDING) building = true; }
        for (let dy = -15; dy <= 15; dy++) for (let dx = -15; dx <= 15; dx++) {
          const xx = jx + dx, yy = jy + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const i2 = yy * w + xx; if (!tree[i2]) continue;
          const d = Math.hypot(dx, dy) * (sgrid.cell * mPerUnit);
          if (!nearest || d < nearest.m) nearest = { m: d, top: stats.top ? stats.top[i2] : null };
        }
      }
      patchRows.push({ columns: cells.length, boxM: [(Math.max(...xs) - Math.min(...xs) + 1) * sgrid.cell * mPerUnit, (Math.max(...ys) - Math.min(...ys) + 1) * (sgrid.cellY || sgrid.cell) * mPerUnit].map((v) => +v.toFixed(1)),
        topMedianM: tops.length ? +tops[tops.length >> 1].toFixed(1) : null, topMaxM: tops.length ? +tops[tops.length - 1].toFixed(1) : null, firmPerColumn: firm != null ? +firm.toFixed(2) : null,
        nearestTree: nearest ? { m: +nearest.m.toFixed(1), topM: nearest.top != null && Number.isFinite(nearest.top) ? +nearest.top.toFixed(1) : null } : null, bordersBuilding: building, wallCells: 0, wallCellsNearWalk: 0, phantoms: 0 });
    }
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
    if (mode === 'refs' && patchRows.length) for (let k = 0; k < N; k++) {
      if (!G.occ[k] || band[k]) continue;
      const p = patchAtCell(k); if (p < 0) continue;
      patchRows[p].wallCells++; if (walked[k]) { patchRows[p].wallCellsNearWalk++; if (!seenNear[k]) patchRows[p].phantoms++; }
    }
    console.log(`Placed by ${mode === 'refs' ? 'the references alone' : 'the walk\'s fixes, else its references'}: ${P.placed.toLocaleString()} points (${P.unplaced.toLocaleString()} not placed). Standing points ${st.toLocaleString()}: ${pct(stHit, st)} within 30 cm of a solid cell (on the lidar's own points ${byKind[1]}, on building walls ${byKind[2]}, on STRUCTURE walls ${byKind[3]}); ${pct(stOverCrown, st)} of them stand under a crown, and of those ${pct(stOverCrownHit, stOverCrown)} land. Ground points ${gr.toLocaleString()}.`);
    console.log(`  Solid cells within 6 m of the walk that the phone saw nothing at (phantoms): the lidar's own ${ph[1]} of ${tot[1]} (${pct(ph[1], tot[1])}), building walls ${ph[2]} of ${tot[2]} (${pct(ph[2], tot[2])}), STRUCTURE walls ${ph[3]} of ${tot[3]} (${pct(ph[3], tot[3])}).`);
  }

  if (patchRows.length) {
    console.log(`STRUCTURE patches, one a line (numbers only; phantoms = wall cells within 6 m of the walk where the phone saw nothing within 0.5 m):`);
    patchRows.forEach((r, i) => console.log(`  patch ${i + 1}: ${JSON.stringify(r)}`));
  }
  // THE GROUND'S COLOUR, as the page now reads it live: each ground point labelled from the twin's picture nearest it
  // in time that sees it (scan/lib/surface.js), and the lawn the owner traced as the match's lawn edge
  if (G.lawnSd) { let cells = 0; for (const v of G.lawnSd) if (v > 0) cells++; console.log(`The traced lawn: ${Math.round(cells * G.cell * G.cell).toLocaleString()} m2 on the match's grid.`); }
  // SOLID CELLS IN THE LAWN (the owner, 2026-11-03: "solid blue columns showing up in the lawn area that weren't
  // associated with anything I was seeing... on the south end of the bigger strip of grass on the hill"): the lidar's
  // own low points more than 0.5 m inside the traced lawn, by class, height over the ground the match took, returns,
  // and whether the phone saw anything within 0.5 m of them (placed by the references)
  if (G.lawnSd) {
    const P = placeCloud(recs, placer(live, 'refs')), seenAt = new Uint8Array(N);
    for (let i = 0; i < P.pts.length; i += 4) {
      if (P.pts[i + 3] !== 1) continue;
      const c = Math.floor((P.pts[i] - box[0]) / G.cell), r2 = Math.floor((box[3] - P.pts[i + 1]) / G.cell);
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) { const rr = r2 + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < H && cc < W) seenAt[rr * W + cc] = 1; }
    }
    const cls = {}, hs = [], rets = {}, cells = new Set(), seenCells = new Set();
    let lawnN = 0, ys = [], y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < N; k++) if (G.lawnSd[k] > 0) { lawnN++; const r2 = (k / W) | 0; y0 = Math.min(y0, r2); y1 = Math.max(y1, r2); }
    for (let i = 0; i < L.cols.n; i++) {
      const c0 = L.cols.cls[i]; if (c0 === 2 || c0 === 7 || c0 === 18 || c0 === 9 || c0 === 6) continue;
      const cc = Math.floor((L.e[i] - box[0]) / G.cell), rr = Math.floor((box[3] - L.n[i]) / G.cell);
      if (cc < 0 || rr < 0 || cc >= W || rr >= H) continue;
      const k = rr * W + cc;
      if (!(G.lawnSd[k] > 0.5)) continue;
      const h = L.cols.z[i] - G.dem[k];
      if (!(h > 0.25 && h < 2.5)) continue;
      cls[c0] = (cls[c0] || 0) + 1; hs.push(h); const nr = L.cols.nret ? L.cols.nret[i] : 0; rets[nr] = (rets[nr] || 0) + 1;
      cells.add(k); if (seenAt[k]) seenCells.add(k); ys.push(rr);
    }
    hs.sort((a2, b2) => a2 - b2);
    const south = ys.filter((r2) => r2 > y0 + (2 * (y1 - y0)) / 3).length;
    // the ground under them: how far the match's ground there sits from the lowest lidar ground return within 2 m
    let demGap = [];
    for (const k of cells) {
      const cc = k % W, rr = (k / W) | 0; let lowest = Infinity;
      for (let i = 0; i < L.cols.n; i++) { if (L.cols.cls[i] !== 2) continue; const c2 = Math.floor((L.e[i] - box[0]) / G.cell), r3 = Math.floor((box[3] - L.n[i]) / G.cell); if (Math.abs(c2 - cc) <= 8 && Math.abs(r3 - rr) <= 8) lowest = Math.min(lowest, L.cols.z[i]); }
      if (Number.isFinite(lowest)) demGap.push(G.dem[k] - lowest);
      if (demGap.length > 200) break;
    }
    demGap.sort((a2, b2) => a2 - b2);
    let stillSolid = 0; for (const k of cells) if (G.occ[k]) stillSolid++;
    console.log(`Still solid after the lawn rule (unclassified under ${LAWN_LOW_M} m in the lawn is ground): ${stillSolid} of the ${cells.size} cells below.`);
    console.log(`Low-point cells more than 0.5 m inside the traced lawn: ${cells.size} (of ${lawnN.toLocaleString()} lawn cells), from ${hs.length} lidar points; ${pct(south, ys.length)} of those points in the southern third of the lawn. Classes ${JSON.stringify(cls)} (1 unclassified, 3-5 low/medium/high vegetation); height over the match's ground: median ${hs.length ? hs[hs.length >> 1].toFixed(2) : '-'} m, lowest ${hs.length ? hs[0].toFixed(2) : '-'}, highest ${hs.length ? hs[hs.length - 1].toFixed(2) : '-'}; returns a pulse ${JSON.stringify(rets)}. The phone saw something within 0.5 m of ${seenCells.size} of the ${cells.size} cells. The match's ground there sits ${demGap.length ? demGap[demGap.length >> 1].toFixed(2) : '-'} m above the lowest ground return within 2 m (median).`);
  }
  let surfOf = new Map(); // record index -> 'grass' | 'pave'
  const keys = [];
  for (const f of readdirSync(dir).filter((x) => /^keys-\d+\.json$/.test(x)).sort()) keys.push(...JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const pics = keys.filter((k) => existsSync(join(dir, k.name))).sort((a, b) => a.t - b.t);
  if (pics.length) {
    /* WHICH WAY UP, AND WHICH WAY ROUND, IS THE PICTURE against the depth (the owner, 2026-11-04: the gravel drive
       is in the first pictures and beside the lawn, and the colour read "paving inside the lawn" where the check
       points vouch for the references). Each ground point is coloured from the picture nearest it in time under
       four readings of that picture -- as kept, flipped top to bottom, mirrored left to right, both -- and the
       reading whose grass and paving agree best with the traced lawn, where the references place them, is the one
       the depth and the picture share. The live page (app.js) reads the picture the same way as "as kept". */
    const groundIdx = []; for (let i = 0; i < recs.length; i++) if (Math.abs(recs[i].y - recs[i].ground) < 0.2) groundIdx.push(i);
    groundIdx.sort((a, b) => recs[a].t - recs[b].t);
    const mul = (M, x, y, z, w) => [M[0] * x + M[4] * y + M[8] * z + M[12] * w, M[1] * x + M[5] * y + M[9] * z + M[13] * w, M[2] * x + M[6] * y + M[10] * z + M[14] * w, M[3] * x + M[7] * y + M[11] * z + M[15] * w];
    const inv = (M) => { // a rigid camera-to-world: transpose the turn, turn the move back
      const R = [M[0], M[1], M[2], 0, M[4], M[5], M[6], 0, M[8], M[9], M[10], 0, 0, 0, 0, 1], t0 = [M[12], M[13], M[14]];
      const o = [R[0], R[4], R[8], 0, R[1], R[5], R[9], 0, R[2], R[6], R[10], 0, 0, 0, 0, 1];
      o[12] = -(o[0] * t0[0] + o[4] * t0[1] + o[8] * t0[2]); o[13] = -(o[1] * t0[0] + o[5] * t0[1] + o[9] * t0[2]); o[14] = -(o[2] * t0[0] + o[6] * t0[1] + o[10] * t0[2]);
      return o;
    };
    // each ground point's picture and pixel, once; the four readings only move the pixel
    const hits = []; // [recIdx, picIdx, px, py]
    const imgs = new Map();
    let lo = 0;
    for (let q = 0; q < pics.length; q++) {
      const k = pics[q], t0 = q ? (pics[q - 1].t + k.t) / 2 : -Infinity, t1 = q + 1 < pics.length ? (k.t + pics[q + 1].t) / 2 : Infinity;
      while (lo < groundIdx.length && recs[groundIdx[lo]].t < t0) lo++;
      const V = inv(k.view);
      for (let j = lo; j < groundIdx.length && recs[groundIdx[j]].t < t1; j++) {
        const r = recs[groundIdx[j]], c = mul(V, r.x, r.y, r.z, 1);
        if (c[2] > -0.3) continue;
        const cl = mul(k.proj, c[0], c[1], c[2], c[3]), nx = cl[0] / cl[3], ny = cl[1] / cl[3];
        if (Math.abs(nx) > 0.98 || Math.abs(ny) > 0.98) continue;
        if (!imgs.has(q)) imgs.set(q, jpeg.decode(readFileSync(join(dir, k.name)), { useTArray: true, formatAsRGBA: true }));
        const img = imgs.get(q);
        hits.push([groundIdx[j], q, Math.min(img.width - 1, Math.floor(((nx + 1) / 2) * img.width)), Math.min(img.height - 1, Math.floor(((1 - ny) / 2) * img.height))]);
      }
    }
    const refsPlace = placer(live, 'refs');
    const readings = [['as kept', false, false], ['flipped top to bottom', true, false], ['mirrored left to right', false, true], ['flipped and mirrored', true, true]];
    const results = [];
    for (const [name, fy, fx] of readings) {
      const map = new Map();
      for (const [ri, q, px0, py0] of hits) {
        const img = imgs.get(q), px = fx ? img.width - 1 - px0 : px0, py = fy ? img.height - 1 - py0 : py0;
        const o = (py * img.width + px) * 4, s = surfaceOf(img.data[o], img.data[o + 1], img.data[o + 2]);
        if (s) map.set(ri, s);
      }
      // agreement with the traced lawn where the references place the points
      let n = 0, paveIn = 0, grassOut = 0, firstTen = 0, firstTenPave = 0;
      if (G.lawnSd) for (const [ri, s] of map) {
        const r = recs[ri], T = refsPlace(r.odo); if (!T) continue;
        const [e, nn] = apply(T, [r.x, -r.z]), c = Math.floor((e - box[0]) / G.cell), rr = Math.floor((box[3] - nn) / G.cell);
        if (c < 0 || rr < 0 || c >= W || rr >= H) continue;
        const sd = G.lawnSd[rr * W + c]; n++;
        if (s === 'pave' && sd > 0.35) paveIn++; if (s === 'grass' && sd < -0.35) grassOut++;
      }
      for (const [ri, q] of hits) if (q < 10 && map.has(ri)) { firstTen++; if (map.get(ri) === 'pave') firstTenPave++; }
      results.push({ name, map, tally: tally([...map.values()]), n, paveIn, grassOut, wrong: n ? (paveIn + grassOut) / n : 1, firstTen, firstTenPave });
    }
    results.sort((a, b) => a.wrong - b.wrong);
    console.log(`Ground points coloured from ${pics.length} pictures (${hits.length.toLocaleString()} point-in-picture pairs of ${groundIdx.length.toLocaleString()} ground points). The picture read four ways, against the traced lawn where the references place the points:`);
    for (const r of results) console.log(`  ${r.name}: grass ${r.tally.grass.toLocaleString()}, paving ${r.tally.pave.toLocaleString()}; on the wrong side of the trace ${pct(r.paveIn + r.grassOut, r.n)} (paving inside it ${r.paveIn.toLocaleString()}, grass outside it ${r.grassOut.toLocaleString()}); in the first 10 pictures ${pct(r.firstTenPave, r.firstTen)} paving of ${r.firstTen.toLocaleString()} points`);
    const best = results[0];
    console.log(`  -> read ${best.name}: ${best === results.find((r) => r.name === 'as kept') ? 'what the live page does' : 'NOT what the live page does (app.js reads it as kept)'}.`);
    surfOf = best.map;
    // the pictures one by one, the first dozen: what share of the ground in each reads as paving, best reading
    const perPic = new Map();
    for (const [ri, q] of hits) { if (q >= 12 || !best.map.has(ri)) continue; const e = perPic.get(q) || { n: 0, pave: 0 }; e.n++; if (best.map.get(ri) === 'pave') e.pave++; perPic.set(q, e); }
    console.log(`  the first pictures, paving share of their ground points: ${[...perPic.entries()].sort((a, b) => a[0] - b[0]).map(([q, e]) => `#${q + 1} ${pct(e.pave, e.n)}`).join(', ')}`);
  } else console.log('No pictures in the twin: the lawn-edge term cannot be tried on it.');

  // THE WALK REPLAYED THROUGH TODAY'S MATCH: every 5 m of the walk, the last 25 ft of what the phone saw (classed by
  // its height over the ground the page took then), searched from the references' fit as the page would, and judged
  // the way locate.js judges it (2 m and 10 degrees from the references)
  const refsAt = placer(live, 'refs');
  const byOdo = recs.slice().sort((a, b) => a.odo - b.odo);
  const end = byOdo.length ? byOdo[byOdo.length - 1].odo : 0;
  const VARIANTS = [['strict', {}], ['lenient', { minLanded: MIN_LANDED }], ['lawnEdge', { minLanded: MIN_LANDED, useSurface: true }], ['lawnEdgeRoofs', { minLanded: MIN_LANDED, useSurface: true, highX: 2 }],
    ['paveOnly', { minLanded: MIN_LANDED, useSurface: true, grassCap: 0 }], ['lawnEdgeW3', { minLanded: MIN_LANDED, useSurface: true, surfW: 3 }], ['lawnEdgeW8', { minLanded: MIN_LANDED, useSurface: true, surfW: 8 }], ['lawnEdgeW8Roofs', { minLanded: MIN_LANDED, useSurface: true, surfW: 8, highX: 2 }]];
  const rep = { asked: 0, why: {} };
  for (const [name] of VARIANTS) rep[name] = { fixes: 0, agree: 0, offM: [] };
  let lo = 0;
  for (let odo = 8; odo <= end; odo += 5) {
    const T0 = refsAt(odo); if (!T0) continue;
    while (lo < byOdo.length && byOdo[lo].odo < odo - 7.6) lo++;
    const stand = [], ground = [], high = [], surface = [], vox = new Set();
    for (let i = lo; i < byOdo.length && byOdo[i].odo <= odo; i++) {
      const p = byOdo[i], h = p.y - p.ground, kk = `${Math.floor(p.x / 0.1)},${Math.floor(p.z / 0.1)},${h > 0.3 ? 1 : 0}`;
      if (vox.has(kk)) continue; vox.add(kk);
      if (Math.abs(h) < 0.2) { ground.push([p.x, -p.z, p.y]); const s = surfOf.get(p.i); if (s) surface.push([p.x, -p.z, s]); }
      else if (h > 0.4 && h < 2.4) stand.push([p.x, -p.z]); else if (h >= 2.4 && h < 12) high.push([p.x, -p.z]);
    }
    const thinA = (a, m) => (a.length <= m ? a : a.filter((_, i) => i % Math.ceil(a.length / m) === 0));
    const S = thinA(stand, 600), Gr = thinA(ground, 300), Hi = thinA(high, 300), Su = thinA(surface, 400);
    if (S.length + Hi.length < 30) continue;
    rep.asked++;
    /* THE COST ROUND THE REFERENCES' POSE (SCAN-H6's "two places fit about as well"): the match's cost at the
       references' pose and 2 m off it each way, and turned 10 degrees each way. A direction the cost barely rises
       in is one the match cannot pin (a wall slides along itself). Summed over the asks. */
    {
      const at = (T) => placementCost(G, S, Gr, T, { high: Hi, surface: Su }).cost;
      const c0 = at(T0), rot = (d) => { const th = T0.theta + (d * Math.PI) / 180, c = Math.cos(T0.theta), s = Math.sin(T0.theta), c1 = Math.cos(th), s1 = Math.sin(th), [u, v] = phone; return { ...T0, theta: th, tx: T0.tx + (c * u - s * v) - (c1 * u - s1 * v), ty: T0.ty + (s * u + c * v) - (s1 * u + c1 * v) }; };
      const prof = { e: at({ ...T0, tx: T0.tx + 2 }) / c0, w: at({ ...T0, tx: T0.tx - 2 }) / c0, n: at({ ...T0, ty: T0.ty + 2 }) / c0, s: at({ ...T0, ty: T0.ty - 2 }) / c0, cw: at(rot(10)) / c0, ccw: at(rot(-10)) / c0 };
      rep.prof = rep.prof || { n: 0, e: 0, w: 0, nn: 0, s: 0, cw: 0, ccw: 0, flat: 0 };
      rep.prof.n++; rep.prof.e += prof.e; rep.prof.w += prof.w; rep.prof.nn += prof.n; rep.prof.s += prof.s; rep.prof.cw += prof.cw; rep.prof.ccw += prof.ccw;
      if (Math.min(prof.e, prof.w, prof.n, prof.s) < 1.1) rep.prof.flat++;
    }
    // how the colours agree with the traced lawn where the references put the phone
    if (G.lawnSd && Su.length) { const pc = placementCost(G, [], [], T0, { surface: Su, detail: true }).surface; rep.surf = rep.surf || { n: 0, off: 0, offGrass: 0, edge: 0, landed: 0 }; for (const k of Object.keys(rep.surf)) rep.surf[k] += pc[k]; }
    const phone = (() => { let best = null; for (const p of byOdo) if (p.odo <= odo) best = p; return best ? [best.x, -best.z] : [0, 0]; })();
    for (const [mode, opts] of VARIANTS) {
      const { useSurface, highX, surfW, grassCap, ...o } = opts;
      G.surfW = surfW; G.grassCap = grassCap;
      const hi = highX ? Array.from({ length: highX }, () => Hi).flat() : Hi;
      const f = register(G, S, Gr, { T: T0 }, { searchM: 6, searchDeg: 25, high: hi, surface: useSurface ? Su : [], ...o });
      if (!f.ok) { if (mode === 'lawnEdge') { const w = `${f.why}`.replace(/\d+/g, '#'); rep.why[w] = (rep.why[w] || 0) + 1; } continue; }
      rep[mode].fixes++;
      const d = disagreement(f.T, T0, phone);
      // who is right, the fix or the references? how each lines the lawn's edge and the walls up
      if (mode === 'lawnEdgeW8') {
        const at = (T) => { const pc = placementCost(G, S, Gr, T, { high: Hi, surface: Su, detail: true }); return { edgeOk: pc.surface.edge ? Math.round((100 * pc.surface.landed) / pc.surface.edge) : null, landed: pc.landed }; };
        rep.rows = rep.rows || []; rep.rows.push({ atM: Math.round(odo), offM: +d.m.toFixed(1), offDeg: +d.deg.toFixed(0), fix: at(f.T), refs: at(T0) });
      }
      if (d.m <= REF_TOL_M && d.deg <= REF_TOL_DEG) { rep[mode].agree++; rep[mode].offM.push(d.m); }
    }
  }
  const line = (k) => { const r = rep[k]; r.offM.sort((a, b) => a - b); return `${r.fixes} fixes, ${r.agree} within ${REF_TOL_M} m and ${REF_TOL_DEG} deg of the references${r.offM.length ? ` (half within ${r.offM[r.offM.length >> 1].toFixed(2)} m)` : ''}`; };
  console.log(`Replayed through today's match, every 5 m from the references' fit: ${rep.asked} asks.`);
  console.log(`  at the 50% share: ${line('strict')}`);
  console.log(`  with ${MIN_LANDED} points landed in number: ${line('lenient')}`);
  console.log(`  + the lawn's edges (grass and paving against the traced lawn): ${line('lawnEdge')}`);
  console.log(`  + the lawn's edges and the roof edges counted twice: ${line('lawnEdgeRoofs')}`);
  console.log(`  the lawn's edges, paving only (grass off the traced lawn costs nothing): ${line('paveOnly')}`);
  console.log(`  the lawn's edges weighed 3 times: ${line('lawnEdgeW3')}`);
  console.log(`  the lawn's edges weighed 8 times: ${line('lawnEdgeW8')}`);
  console.log(`  the lawn's edges weighed 8 times, roof edges twice: ${line('lawnEdgeW8Roofs')}`);
  console.log(`  refused with the lawn's edges: ${JSON.stringify(rep.why)}`);
  for (const r of rep.rows || []) console.log(`  fix at ${r.atM} m walked: ${r.offM} m and ${r.offDeg} deg from the references; edge points on the right side ${r.fix.edgeOk}% at the fix, ${r.refs.edgeOk}% at the references; points landed ${r.fix.landed} against ${r.refs.landed}`);
  if (rep.prof) { const P = rep.prof, f = (v) => (v / P.n).toFixed(2); console.log(`  the cost round the references' pose, as a multiple of the cost there (1.00 = no worse), averaged over ${P.n} asks: 2 m east ${f(P.e)}, west ${f(P.w)}, north ${f(P.nn)}, south ${f(P.s)}; turned 10 degrees ${f(P.cw)} / ${f(P.ccw)}. Asks where some 2 m step costs under 10% more: ${P.flat} of ${P.n}.`); }
  if (rep.surf) console.log(`  where the references put it: ${rep.surf.n.toLocaleString()} grass and paving points, ${pct(rep.surf.off, rep.surf.n)} on the wrong side of the traced lawn's edge by more than 35 cm (grass outside it ${pct(rep.surf.offGrass, rep.surf.off)} of those, paving inside it the rest); ${rep.surf.edge.toLocaleString()} within ${1.5} m of the edge, ${pct(rep.surf.landed, rep.surf.edge)} of those on the right side.`);
}

// an error can carry a URL with a place in it: long decimals are blanked before it is printed (the repository is public)
main().catch((e) => { console.log(`Twin check: ${String(e.message).replace(/-?\d+\.\d{3,}/g, '#')}`); process.exit(1); });
