/**
 * HOW A WALK'S TWIN LINES UP WITH THE LIDAR, IN NUMBERS (core session, 2026-11-03). The owner, after a walk on a new
 * lawn: "there are blue 'walls' underneath tree canopies... there should be plenty of data from this walk for you to
 * dig into." Run by workflow "S. Yard AR tool", task `twin`, on a twin already fetched (scan/tools/twin-r2.mjs get).
 *
 * The lidar is THE SHADE MAP'S FINISHED MODEL (public/lib/lidar-model.js), read from the main site's bucket and
 * gridded exactly as the AR page grids it (scan/lib/lidar-load.js gridsFromModel; since 2026-11-04 the AR rebuilds
 * nothing from points), and the phone's points placed as the walk placed them (its lidar fixes, else its references;
 * scan/lib/twin.js placer). Then, counted:
 *   - the solid cells the match uses, by where they came from: a column the shade map's cubes fill at the phone's
 *     height (a trunk, a hedge, a structure, unknown) or the walls drawn 2 ft inside a BUILDING; and how many of
 *     each stand in or by a tree's column;
 *   - the STRUCTURE columns, and how many touch a tree's (the ring round canopies);
 *   - the phone's standing points: how many land within 30 cm of a solid cell, over a crown or not;
 *   - the solid cells near the walk that the phone never saw anything at (phantoms).
 * NUMBERS ONLY: no coordinates, no address, no picture. The map is read from the database with the Cloudflare token.
 *
 *   CLOUDFLARE_API_TOKEN=... node scan/tools/twin-check.mjs twin
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { toMerc, ringsOf } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';
import { gridsFromModel } from '../lib/lidar-load.js';
import { unpackModel, modelUsable } from '../lib/lidar-model.js';
import { buildingsOnGrid, register, MIN_LANDED, placementCost } from '../lib/lidar.js';
import { readObject, CORPUS_BUCKET } from './twin-r2.mjs';
import { disagreement, REF_TOL_M, REF_TOL_DEG } from '../lib/locate.js';
import { readCloud, readTrack, placer, placeCloud } from '../lib/twin.js';
import { apply } from '../lib/align.js';
import { surfaceOf, tally } from '../lib/surface.js';
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
    return { ...payload, lng: payload.lng ?? rows[0].lng, lat: payload.lat ?? rows[0].lat, tools, ownerId: rows[0].user_id };
  }
  if (!site || !key) throw new Error('the map needs the Cloudflare token, or SITE and MAPS_READ_TOKEN');
  const r = await fetch(`${site}/api/admin/saved-maps/one?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`the map could not be read (${r.status})`);
  return (await r.json()).map;
}

/** THE SHADE MAP'S FINISHED MODEL of the map (public/lib/lidar-model.js), as the page reads it: from the main site's
 *  bucket by the key routes-maps.js writes it under (unified.js modelKey), since the site answers the runner 403. */
async function readModel(mapKey, ownerId) {
  if (!ownerId) throw new Error('the model needs the map\'s owner');
  const key = `models/user/${ownerId}/${createHash('sha256').update(String(mapKey)).digest('hex')}/shade.bin`;
  const bytes = await readObject(CORPUS_BUCKET, key);
  if (!bytes) throw new Error('this map has no lidar model yet: open it in the shade map first, which builds and saves it');
  const m = await unpackModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!modelUsable(m)) throw new Error('the lidar model is incomplete');
  return m;
}

async function main() {
  const dir = process.argv[2] || 'twin';
  const site = (process.env.SITE || '').replace(/\/$/, ''), key = process.env.MAPS_READ_TOKEN;
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const live = existsSync(join(dir, 'live.json')) ? JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')) : { fixes: [], marks: [] };
  const recs = [];
  for (const f of readdirSync(dir).filter((x) => /^cloud-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); recs.push(...readCloud(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  recs.forEach((r, i) => { r.i = i; });
  // the camera's place when each point was seen (the track, 5 a second), for a point's range from it
  const track = [];
  for (const f of readdirSync(dir).filter((x) => /^track-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); track.push(...readTrack(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  track.sort((a, b) => a.t - b.t);
  const camAt = (tt) => { let lo = 0, hi = track.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (track[m].t < tt) lo = m + 1; else hi = m; } return track[lo]?.pos || null; };
  /* THE PHONE'S POINTS CLASSED AGAIN THE WAY locate.js NOW DOES IT (SCAN-H7): a column's floor the 15th percentile
     of its points, not the lowest; standing points kept within STAND_RANGE of the camera, ground within GROUND_RANGE.
     `cls2[i]`: 'g', 's', 'h' or null; `h2[i]` the height over that floor. Over the whole walk at once, not as the
     walk went, so a little kinder than the page. */
  const colYs = new Map();
  for (const r of recs) { const k = `${Math.floor(r.x)},${Math.floor(r.z)}`; (colYs.get(k) || colYs.set(k, []).get(k)).push(r.y); }
  // three floor rules per column: the lowest point (as the page did until 2026-11-04), the 15th percentile, the
  // densest 5 cm height (as the page does now); the own column when it has 12 points, else the lowest of nine
  const floors = { lowest: new Map(), p15: new Map(), densest: new Map() };
  for (const [k, ys] of colYs) {
    ys.sort((a, b) => a - b);
    floors.lowest.set(k, ys[0]); floors.p15.set(k, ys[Math.min(ys.length - 1, Math.floor(0.15 * ys.length))]);
    const hist = new Map(); for (const y of ys) { const b = Math.floor(y / 0.05); hist.set(b, (hist.get(b) || 0) + 1); }
    let best = null, bestN = -1; for (const [b] of hist) { const n = (hist.get(b - 1) || 0) + hist.get(b) + (hist.get(b + 1) || 0); if (n > bestN) { bestN = n; best = b; } }
    floors.densest.set(k, (best + 0.5) * 0.05);
  }
  const floorBy = (rule, r, ownFirst) => {
    const cx = Math.floor(r.x), cz = Math.floor(r.z), F = floors[rule], gy = r.ground; // r.ground: the crosshair's average on this walk
    if (ownFirst) { const own = F.get(`${cx},${cz}`); if (own != null && colYs.get(`${cx},${cz}`).length >= 12 && own <= gy + 0.5) return own; }
    let g = Infinity; for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const f = F.get(`${cx + dx},${cz + dz}`); if (f != null && f < g && f <= gy + 0.5) g = f; }
    return Number.isFinite(g) ? g : gy;
  };
  const rangeOf = (r) => { const cam = camAt(r.t); return cam ? Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z) : 0; };
  const classify = (rule, ownFirst, standCap, groundCap) => recs.map((r) => { const range = rangeOf(r), h = r.y - floorBy(rule, r, ownFirst); return Math.abs(h) < 0.2 ? (range <= groundCap ? 'g' : null) : h > 0.4 && h < 2.4 ? (range <= standCap ? 's' : null) : h >= 2.4 && h < 12 ? 'h' : null; });
  const RULES = [['the lowest of nine columns, any range (as the page did)', 'lowest', false, Infinity, Infinity], ['the 15th percentile, standing within 3.5 m', 'p15', false, 3.5, 6], ['the densest height, own column first, standing within 3.5 m (as the page does now)', 'densest', true, 3.5, 6], ['the densest height, own column first, any range', 'densest', true, Infinity, Infinity]];
  const CLS = RULES.map(([, rule, own, sc, gc]) => classify(rule, own, sc, gc));
  const cls2 = CLS[2];
  for (let i = 0; i < RULES.length; i++) { const c = { g: 0, s: 0, h: 0, null: 0 }; for (const v of CLS[i]) c[v]++; console.log(`Classed with the floor ${RULES[i][0]}: ground ${c.g.toLocaleString()}, standing ${c.s.toLocaleString()}, high ${c.h.toLocaleString()}.`); }
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
  const model = await readModel(meta.map, m.ownerId);
  const S = await import('../../public/shade/structures.js');
  const L = { ...gridsFromModel(model, { origin, box, lawn: lawnRings, S, toMerc }), model };
  const { G, shade } = L;
  const W = G.W, H = G.H, N = W * H;
  console.log(`Lidar: the shade map's model (${model.meta.at ? String(model.meta.at).slice(0, 10) : 'undated'}), ${(shade.sgrid.w * shade.sgrid.h).toLocaleString()} columns over ${Math.round((box[2] - box[0]) * (box[3] - box[1])).toLocaleString()} m2, shift ${L.how}; ${L.rule}.`);
  if (L.counts) console.log(`The model's columns: ${JSON.stringify(L.counts)} (standing: solid for the match at the phone's height).`);

  // where each solid cell came from: a column solid at the phone's height (a tree's trunk, a hedge, a structure, unknown), or a building's drawn wall; and under a crown or not
  const band = new Uint8Array(N); // the shade map's standing columns, filled below
  let crown = new Uint8Array(N), structure = new Uint8Array(N), building = new Uint8Array(N);
  let patchOf = null; const patchRows = [];
  const mPerUnit = L.k; // 3857 units to metres at this latitude
  // the shade column under a fine cell, as buildingsOnGrid finds it
  const columnAt = (k) => { if (!shade) return -1; const { sgrid } = shade; const e = box[0] + ((k % W) + 0.5) * G.cell, n = box[3] - (((k / W) | 0) + 0.5) * G.cell; const x = L.ox + e / L.k, y = L.oy + n / L.k; const c = Math.floor((x - sgrid.x0) / sgrid.cell), r = Math.floor((sgrid.y1 - y) / (sgrid.cellY || sgrid.cell)); return c >= 0 && r >= 0 && c < sgrid.w && r < sgrid.h ? r * sgrid.w + c : -1; };
  const patchAtCell = (k) => { if (!patchOf) return -1; const { sgrid } = shade; const c0 = columnAt(k); if (c0 < 0) return -1; const cx = c0 % sgrid.w, cy = (c0 / sgrid.w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = cx + dx, yy = cy + dy; if (xx >= 0 && yy >= 0 && xx < sgrid.w && yy < sgrid.h && patchOf[yy * sgrid.w + xx] >= 0) return patchOf[yy * sgrid.w + xx]; } return -1; };
  if (shade) {
    const { S, sgrid, kind } = shade;
    const tree = Uint8Array.from(kind, (v) => (v === S.TREE || v === S.SOLID_TREE ? 1 : 0)); // crowns, as the shade map has them
    { const standing = buildingsOnGrid(Uint8Array.from(kind, (v) => (v !== S.BUILDING && v !== S.NOTHING ? 1 : 0)), sgrid, box, G.cell, [L.ox, L.oy], L.k, 1); for (let k = 0; k < N; k++) if (G.occ[k] && standing[k] && !(L.footprint && L.footprint[k])) band[k] = 1; }
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
  const kindOfSolid = new Uint8Array(N); // 1 a column solid at the phone's height, 2 wall of a building, 3 a structure's cell
  for (let k = 0; k < N; k++) {
    if (!G.occ[k]) continue;
    if (band[k]) { src.band++; kindOfSolid[k] = 1; if (crown[k]) src.bandUnderCrown++; continue; }
    src.wall++;
    if (near(structure, k, 4) && !near(building, k, 4)) { src.wallOfStructure++; kindOfSolid[k] = 3; if (near(crown, k, 4)) src.wallOfStructureUnderCrown++; } else { src.wallOfBuilding++; kindOfSolid[k] = 2; }
  }
  console.log(`Solid cells (0.25 m) the match uses: ${G.solid.toLocaleString()}. Columns solid at the phone's height: ${src.band.toLocaleString()} (${pct(src.bandUnderCrown, src.band)} of them tree columns). Building walls drawn 2 ft in: ${src.wallOfBuilding.toLocaleString()}; structures' cells: ${src.wallOfStructure.toLocaleString()} (${pct(src.wallOfStructureUnderCrown, src.wallOfStructure)} within 1 m of a crown).`);

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
    console.log(`  Solid cells within 6 m of the walk that the phone saw nothing at (phantoms): the standing columns ${ph[1]} of ${tot[1]} (${pct(ph[1], tot[1])}), building walls ${ph[2]} of ${tot[2]} (${pct(ph[2], tot[2])}), STRUCTURE walls ${ph[3]} of ${tot[3]} (${pct(ph[3], tot[3])}).`);
  }

  if (patchRows.length) {
    console.log(`STRUCTURE patches, one a line (numbers only; phantoms = wall cells within 6 m of the walk where the phone saw nothing within 0.5 m):`);
    patchRows.forEach((r, i) => console.log(`  patch ${i + 1}: ${JSON.stringify(r)}`));
  }
  // THE GROUND'S COLOUR, as the page now reads it live: each ground point labelled from the twin's picture nearest it
  // in time that sees it (scan/lib/surface.js), and the lawn the owner traced as the match's lawn edge
  if (G.lawnSd) { let cells = 0; for (const v of G.lawnSd) if (v > 0) cells++; console.log(`The traced lawn: ${Math.round(cells * G.cell * G.cell).toLocaleString()} m2 on the match's grid.`); }
  // SOLID CELLS IN THE LAWN (the owner, 2026-11-03: blue columns in the grass): now the shade map's columns, so what
  // stands inside the traced lawn is read from its kinds, for the shade map to judge
  if (G.lawnSd && shade) {
    const inLawn = new Map();
    for (let k = 0; k < N; k++) {
      if (!G.occ[k] || !(G.lawnSd[k] > 0.5)) continue;
      const j = columnAt(k); if (j < 0) continue;
      const v = shade.kind[j]; inLawn.set(v, (inLawn.get(v) || 0) + 1);
    }
    let lawnN = 0; for (const v of G.lawnSd) if (v > 0.5) lawnN++;
    const names = { [S.BUILDING]: 'building', [S.TREE]: 'tree', [S.SOLID_TREE]: 'solid tree', [S.STRUCTURE]: 'structure', [S.UNKNOWN]: 'unknown' };
    console.log(`Solid cells more than 0.5 m inside the traced lawn: ${[...inLawn.values()].reduce((a2, b2) => a2 + b2, 0)} of ${lawnN.toLocaleString()} lawn cells, by the shade map's kind: ${[...inLawn.entries()].map(([v, c]) => `${names[v] || v} ${c}`).join(', ') || 'none'}.`);
  }
  let surfOf = new Map(); // record index -> 'grass' | 'pave'
  let standSurf = new Map(); // standing record index -> 'grass' | 'pave' | 'none', from the picture
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
    const groundIdx = []; for (let i = 0; i < recs.length; i++) if (Math.abs(recs[i].y - recs[i].ground) < 0.2 || cls2[i] === 's') groundIdx.push(i);
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
      const map = new Map(), standMap = new Map();
      for (const [ri, q, px0, py0] of hits) {
        const img = imgs.get(q), px = fx ? img.width - 1 - px0 : px0, py = fy ? img.height - 1 - py0 : py0;
        const o = (py * img.width + px) * 4, s = surfaceOf(img.data[o], img.data[o + 1], img.data[o + 2]);
        if (cls2[ri] === 's') { standMap.set(ri, s || 'none'); if (Math.abs(recs[ri].y - recs[ri].ground) >= 0.2) continue; }
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
      results.push({ name, map, standMap, tally: tally([...map.values()]), n, paveIn, grassOut, wrong: n ? (paveIn + grassOut) / n : 1, firstTen, firstTenPave });
    }
    results.sort((a, b) => a.wrong - b.wrong);
    console.log(`Ground points coloured from ${pics.length} pictures (${hits.length.toLocaleString()} point-in-picture pairs of ${groundIdx.length.toLocaleString()} ground points). The picture read four ways, against the traced lawn where the references place the points:`);
    for (const r of results) console.log(`  ${r.name}: grass ${r.tally.grass.toLocaleString()}, paving ${r.tally.pave.toLocaleString()}; on the wrong side of the trace ${pct(r.paveIn + r.grassOut, r.n)} (paving inside it ${r.paveIn.toLocaleString()}, grass outside it ${r.grassOut.toLocaleString()}); in the first 10 pictures ${pct(r.firstTenPave, r.firstTen)} paving of ${r.firstTen.toLocaleString()} points`);
    const best = results[0];
    console.log(`  -> read ${best.name}: ${best === results.find((r) => r.name === 'as kept') ? 'what the live page does' : 'NOT what the live page does (app.js reads it as kept)'}.`);
    surfOf = best.map; standSurf = best.standMap;
    // the pictures one by one, the first dozen: what share of the ground in each reads as paving, best reading
    const perPic = new Map();
    for (const [ri, q] of hits) { if (q >= 12 || !best.map.has(ri)) continue; const e = perPic.get(q) || { n: 0, pave: 0 }; e.n++; if (best.map.get(ri) === 'pave') e.pave++; perPic.set(q, e); }
    console.log(`  the first pictures, paving share of their ground points: ${[...perPic.entries()].sort((a, b) => a[0] - b[0]).map(([q, e]) => `#${q + 1} ${pct(e.pave, e.n)}`).join(', ')}`);
  } else console.log('No pictures in the twin: the lawn-edge term cannot be tried on it.');

  /* WHAT THE PHONE'S "STANDING" POINTS ARE, against the lidar's own ground, where the references put them (SCAN-H6:
     87% landed on nothing at a pose the check points vouched for). The phone's up is lined to the lidar's by the
     median of (lidar ground - phone y) over the ground points; then each standing point's height over the LIDAR
     ground says: under 0.3 m, the phone misread the ground as a thing (a slope: its ground is the lowest point of a
     1 m column and its neighbours); 0.3-2.5 m and on a solid cell, a match; 0.3-2.5 m and over 1 m from any solid
     cell, a thing the lidar does not have (new, or missed by a thin flight); over 2.5 m, a crown or an overhang. */
  for (const [label, isStand] of RULES.map(([name], i) => [name, (r) => CLS[i][r.i] === 's'])) {
    const pl = placer(live, 'refs');
    const demAt = (e, n) => { const c = Math.floor((e - box[0]) / G.cell), r = Math.floor((box[3] - n) / G.cell); return c >= 0 && r >= 0 && c < W && r < H ? G.dem[r * W + c] : NaN; };
    const distAt = (e, n) => { const c = Math.floor((e - box[0]) / G.cell), r = Math.floor((box[3] - n) / G.cell); return c >= 0 && r >= 0 && c < W && r < H ? G.dist[r * W + c] : NaN; };
    // the phone's up lined to the lidar's per 20 m of walk (ARCore's height drifts along a walk), by the ground points
    const segs = new Map();
    for (let i = 0; i < recs.length; i += 5) { const r = recs[i]; if (Math.abs(r.y - r.ground) >= 0.2) continue; const T = pl(r.odo); if (!T) continue; const [e, n] = apply(T, [r.x, -r.z]), z = demAt(e, n); if (!Number.isFinite(z)) continue; const s = Math.floor(r.odo / 20); (segs.get(s) || segs.set(s, []).get(s)).push(z - r.y); }
    const tzOf = new Map(); let diffsN = 0;
    for (const [s, d] of segs) { d.sort((a, b) => a - b); tzOf.set(s, d[d.length >> 1]); diffsN += d.length; }
    const tzAt = (odo) => { const s = Math.floor(odo / 20); if (tzOf.has(s)) return tzOf.get(s); let best = null; for (const [k, v] of tzOf) if (best == null || Math.abs(k - s) < Math.abs(best[0] - s)) best = [k, v]; return best ? best[1] : NaN; };
    const diffs = { length: diffsN }, tz = tzAt(0);
    const k = { groundMisread: 0, landed: 0, near: 0, missing: 0, high: 0, n: 0 }, slopes = { misread: [], all: [] };
    const ranges = { misread: [], landed: [], missing: [] }, inLawn = { missing: 0, missingN: 0, landed: 0, landedN: 0 }, farMissing = { n: 0, far: 0 };
    const slopeAt = (e, n) => { const a = demAt(e + 1, n), b = demAt(e - 1, n), c = demAt(e, n + 1), d = demAt(e, n - 1); return Number.isFinite(a + b + c + d) ? Math.hypot((a - b) / 2, (c - d) / 2) : NaN; };
    for (const r of recs) {
      if (!isStand(r)) continue;
      const T = pl(r.odo); if (!T) continue;
      const [e, n] = apply(T, [r.x, -r.z]), z = demAt(e, n); if (!Number.isFinite(z)) continue;
      const hl = r.y + tzAt(r.odo) - z, d = distAt(e, n); k.n++;
      const cam = camAt(r.t), range = cam ? Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z) : NaN;
      const sd = G.lawnSd ? G.lawnSd[Math.floor((box[3] - n) / G.cell) * W + Math.floor((e - box[0]) / G.cell)] : NaN;
      if (hl < 0.3) { k.groundMisread++; const s = slopeAt(e, n); if (Number.isFinite(s)) slopes.misread.push(s); if (Number.isFinite(range)) ranges.misread.push(range); }
      else if (hl > 2.5) k.high++;
      else if (d <= 0.3) { k.landed++; if (Number.isFinite(range)) ranges.landed.push(range); if (Number.isFinite(sd)) { inLawn.landedN++; if (sd > 0.5) inLawn.landed++; } }
      else if (d <= 1) k.near++;
      else { k.missing++; if (Number.isFinite(range)) { ranges.missing.push(range); farMissing.n++; if (range > 4) farMissing.far++; } if (Number.isFinite(sd)) { inLawn.missingN++; if (sd > 0.5) inLawn.missing++; } }
      const s = slopeAt(e, n); if (Number.isFinite(s) && k.n % 3 === 0) slopes.all.push(s);
    }
    const med = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
    console.log(`The phone's standing points, ${label}, at the references' pose (${k.n.toLocaleString()}; the phone's up lined to the lidar's per 20 m of walk from ${diffs.length.toLocaleString()} ground points; ${[...tzOf.values()].map((v) => v.toFixed(2)).join(', ')} m): ${pct(k.groundMisread, k.n)} are under 0.3 m over the LIDAR ground (the phone misread the ground as a thing; the lidar's slope under them ${(med(slopes.misread) * 100).toFixed(0)}%, under all of them ${(med(slopes.all) * 100).toFixed(0)}%); ${pct(k.landed, k.n)} land on a solid cell; ${pct(k.near, k.n)} within 1 m of one; ${pct(k.missing, k.n)} stand 0.3-2.5 m up with nothing solid within 1 m (things the lidar does not have); ${pct(k.high, k.n)} are over 2.5 m up by the lidar (a crown, a wall top on a slope).`);
    const q = (a, f) => { a.sort((x, y) => x - y); return a.length ? a[Math.floor(a.length * f)].toFixed(1) : '?'; };
    console.log(`  Range from the camera when seen (median / 9 in 10 under): misread ground ${q(ranges.misread, 0.5)} / ${q(ranges.misread, 0.9)} m, landed ${q(ranges.landed, 0.5)} / ${q(ranges.landed, 0.9)} m, missing from the lidar ${q(ranges.missing, 0.5)} / ${q(ranges.missing, 0.9)} m; ${pct(farMissing.far, farMissing.n)} of the missing were seen from over 4 m. Inside the traced lawn, where nothing stands: ${pct(inLawn.missing, inLawn.missingN)} of the missing, ${pct(inLawn.landed, inLawn.landedN)} of the landed.`);
    // the same points by range band: what share of each band lands, is missing, or is misread ground
    const bands = [[0, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 8]], tot = bands.map(() => ({ n: 0, landed: 0, missing: 0, misread: 0 }));
    for (const r of recs) {
      if (!isStand(r)) continue;
      const T = pl(r.odo); if (!T) continue;
      const [e, n] = apply(T, [r.x, -r.z]), z = demAt(e, n); if (!Number.isFinite(z)) continue;
      const cam = camAt(r.t); if (!cam) continue;
      const range = Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z), bi = bands.findIndex(([a, b]) => range >= a && range < b); if (bi < 0) continue;
      const hl = r.y + tzAt(r.odo) - z, d = distAt(e, n), b = tot[bi]; b.n++;
      if (hl < 0.3) b.misread++; else if (hl <= 2.5 && d <= 0.3) b.landed++; else if (hl <= 2.5 && d > 1) b.missing++;
    }
    console.log(`  By range: ${bands.map(([a, b], i) => `${a}-${b} m: ${tot[i].n.toLocaleString()} points, ${pct(tot[i].landed, tot[i].n)} land, ${pct(tot[i].missing, tot[i].n)} missing, ${pct(tot[i].misread, tot[i].n)} misread ground`).join('; ')}.`);
  }

  const end2 = recs.reduce((m, r) => Math.max(m, r.odo), 0);
  /* TWO FILTERS FOR INVENTED STANDING POINTS, measured before they are built (SCAN-H7: in the open lawn the phone's
     standing points land on nothing anywhere): their colour in the picture (grass-coloured things do not stand 0.4 m
     up in a mowed lawn), and how densely they were seen (a real surface fills its 0.2 m voxel with many 5 cm cubes;
     noise scatters). For the standing points at the references' pose: landed against missing, by each. */
  {
    const dens = new Map();
    for (const r of recs) if (cls2[r.i] === 's') { const k = `${Math.floor(r.x / 0.2)},${Math.floor(r.y / 0.2)},${Math.floor(r.z / 0.2)}`; dens.set(k, (dens.get(k) || 0) + 1); }
    const pl = placer(live, 'refs');
    const distAt = (e, n) => { const c = Math.floor((e - box[0]) / G.cell), r = Math.floor((box[3] - n) / G.cell); return c >= 0 && r >= 0 && c < W && r < H ? G.dist[r * W + c] : NaN; };
    const by = { landed: { grass: 0, pave: 0, none: 0, unseen: 0, dens: [] }, missing: { grass: 0, pave: 0, none: 0, unseen: 0, dens: [] } };
    const filt = { grass: { landed: 0, n: 0 }, dens3: { landed: 0, n: 0 }, dens5: { landed: 0, n: 0 }, both: { landed: 0, n: 0 }, all: { landed: 0, n: 0 } };
    for (const r of recs) {
      if (cls2[r.i] !== 's') continue; const T = pl(r.odo); if (!T) continue;
      const [e, n] = apply(T, [r.x, -r.z]), d = distAt(e, n); if (!Number.isFinite(d)) continue;
      const landed = d <= 0.3, missing = d > 1; if (!landed && !missing) continue;
      const s = standSurf.get(r.i) || 'unseen', dn = dens.get(`${Math.floor(r.x / 0.2)},${Math.floor(r.y / 0.2)},${Math.floor(r.z / 0.2)}`) || 1;
      const g = landed ? by.landed : by.missing; g[s]++; g.dens.push(dn);
      const notGrass = s !== 'grass';
      filt.all.n++; if (landed) filt.all.landed++;
      if (notGrass) { filt.grass.n++; if (landed) filt.grass.landed++; }
      if (dn >= 3) { filt.dens3.n++; if (landed) filt.dens3.landed++; }
      if (dn >= 5) { filt.dens5.n++; if (landed) filt.dens5.landed++; }
      if (notGrass && dn >= 3) { filt.both.n++; if (landed) filt.both.landed++; }
    }
    const med = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : '-'; };
    const row = (g) => `grass ${g.grass}, paving ${g.pave}, other colour ${g.none}, not in a picture ${g.unseen}; cubes a voxel, median ${med(g.dens)}`;
    console.log(`Standing points (the new classing) at the references' pose: landed: ${row(by.landed)}. Missing: ${row(by.missing)}.`);
    console.log(`  What a filter would leave, and how many of those land: all ${filt.all.n} (${pct(filt.all.landed, filt.all.n)}); not grass-coloured ${filt.grass.n} (${pct(filt.grass.landed, filt.grass.n)}); 3+ cubes a voxel ${filt.dens3.n} (${pct(filt.dens3.landed, filt.dens3.n)}); 5+ cubes ${filt.dens5.n} (${pct(filt.dens5.landed, filt.dens5.n)}); not grass and 3+ cubes ${filt.both.n} (${pct(filt.both.landed, filt.both.n)}).`);
  }
  /* IS THE LIDAR WHERE THE PHONE SAYS, OR OFF AS A WHOLE? (SCAN-H7: at 78 m, where check point C2 vouched for the
     references to 10 in, a fix 4.9 m off landed 100 points against the references' 2.) The phone's standing points
     (the new classing), placed by the references, slid as one over the lidar: the shift that lands the most, in each
     third of the walk. The same shift in all three means the lidar sits off this map by that much (its move onto
     the photo); different shifts mean the references' fit drifts along the walk. */
  {
    const pl = placer(live, 'refs');
    const thirds = [[], [], []];
    for (const r of recs) { if (cls2[r.i] !== 's') continue; const T = pl(r.odo); if (!T) continue; const third = Math.min(2, Math.floor((3 * r.odo) / Math.max(1e-9, end2))); thirds[third].push(apply(T, [r.x, -r.z])); }
    const landedAt = (pts, de, dn) => { let n = 0; for (const [e, nn] of pts) { const c = Math.floor((e + de - box[0]) / G.cell), r = Math.floor((box[3] - (nn + dn)) / G.cell); if (c >= 0 && r >= 0 && c < W && r < H && G.dist[r * W + c] <= 0.3) n++; } return n; };
    const out = [];
    for (let i = 0; i < 3; i++) {
      const pts = thirds[i].filter((_, j) => j % 2 === 0); if (pts.length < 50) { out.push(`third ${i + 1}: too few points (${pts.length})`); continue; }
      let best = { n: landedAt(pts, 0, 0), de: 0, dn: 0 };
      const at0 = best.n;
      for (let de = -8; de <= 8; de += 0.5) for (let dn = -8; dn <= 8; dn += 0.5) { const n = landedAt(pts, de, dn); if (n > best.n) best = { n, de, dn }; }
      // refined to a quarter metre round the best
      for (let de = best.de - 0.5; de <= best.de + 0.5; de += 0.25) for (let dn = best.dn - 0.5; dn <= best.dn + 0.5; dn += 0.25) { const n = landedAt(pts, de, dn); if (n > best.n) best = { n, de, dn }; }
      out.push(`third ${i + 1} (${pts.length.toLocaleString()} points): ${pct(at0, pts.length)} land where the references put them; most land, ${pct(best.n, pts.length)}, shifted ${Math.hypot(best.de, best.dn).toFixed(2)} m (${best.de >= 0 ? 'east' : 'west'} ${Math.abs(best.de).toFixed(2)}, ${best.dn >= 0 ? 'north' : 'south'} ${Math.abs(best.dn).toFixed(2)})`);
    }
    console.log(`The lidar against the phone's standing points, slid as one (shift only, no turn): ${out.join('; ')}.`);
  }

  // THE WALK REPLAYED THROUGH TODAY'S MATCH: every 5 m of the walk, the last 25 ft of what the phone saw (classed by
  // its height over the ground the page took then), searched from the references' fit as the page would, and judged
  // the way locate.js judges it (2 m and 10 degrees from the references)
  const refsAt = placer(live, 'refs');
  const byOdo = recs.slice().sort((a, b) => a.odo - b.odo);
  const end = byOdo.length ? byOdo[byOdo.length - 1].odo : 0;
  const ALL = [['strict', {}], ['lenient', { minLanded: MIN_LANDED }], ['lawnEdge', { minLanded: MIN_LANDED, useSurface: true }], ['lawnEdgeRoofs', { minLanded: MIN_LANDED, useSurface: true, highX: 2 }],
    ['paveOnly', { minLanded: MIN_LANDED, useSurface: true, grassCap: 0 }], ['lawnEdgeW3', { minLanded: MIN_LANDED, useSurface: true, surfW: 3 }], ['lawnEdgeW8', { minLanded: MIN_LANDED, useSurface: true, surfW: 8 }], ['lawnEdgeW8Roofs', { minLanded: MIN_LANDED, useSurface: true, surfW: 8, highX: 2 }]];
  for (const [passName, classify, VARIANTS] of [['classed as the page did (the lowest of nine, any range)', (p) => CLS[0][p.i], ALL], ['classed as the page does now (the densest height, own column first, standing within 3.5 m)', (p) => cls2[p.i], ALL]]) {
  const rep = { asked: 0, why: {} };
  for (const [name] of VARIANTS) rep[name] = { fixes: 0, agree: 0, offM: [] };
  let lo = 0;
  for (let odo = 8; odo <= end; odo += 5) {
    const T0 = refsAt(odo); if (!T0) continue;
    while (lo < byOdo.length && byOdo[lo].odo < odo - 7.6) lo++;
    const stand = [], ground = [], high = [], surface = [], vox = new Set();
    for (let i = lo; i < byOdo.length && byOdo[i].odo <= odo; i++) {
      const p = byOdo[i], c = classify(p); if (!c) continue;
      const kk = `${Math.floor(p.x / 0.1)},${Math.floor(p.z / 0.1)},${c}`;
      if (vox.has(kk)) continue; vox.add(kk);
      if (c === 'g') { ground.push([p.x, -p.z, p.y]); const s = surfOf.get(p.i); if (s) surface.push([p.x, -p.z, s]); }
      else if (c === 's') stand.push([p.x, -p.z]); else high.push([p.x, -p.z]);
    }
    const thinA = (a, m) => (a.length <= m ? a : a.filter((_, i) => i % Math.ceil(a.length / m) === 0));
    const S = thinA(stand, 600), Gr = thinA(ground, 300), Hi = thinA(high, 300), Su = thinA(surface, 400);
    if (S.length + Hi.length < 30) continue;
    rep.asked++;
    // how the colours agree with the traced lawn where the references put the phone
    if (G.lawnSd && Su.length) { const pc = placementCost(G, [], [], T0, { surface: Su, detail: true }).surface; rep.surf = rep.surf || { n: 0, off: 0, offGrass: 0, edge: 0, landed: 0 }; for (const k of Object.keys(rep.surf)) rep.surf[k] += pc[k]; }
    const phone = (() => { let best = null; for (const p of byOdo) if (p.odo <= odo) best = p; return best ? [best.x, -best.z] : [0, 0]; })();
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
  console.log(`Replayed through today's match, the points ${passName}, every 5 m from the references' fit: ${rep.asked} asks.`);
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
}

// an error can carry a URL with a place in it: long decimals are blanked before it is printed (the repository is public)
main().catch((e) => { console.log(`Twin check: ${String(e.message).replace(/-?\d+\.\d{3,}/g, '#')}`); process.exit(1); });
