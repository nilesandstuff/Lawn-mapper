/**
 * WHAT CAN PLACE THIS WALK? (core session, 2026-11-05; the owner: "It's strange that there was not enough lidar for a
 * match on the post processing... Look into that thoroughly"). Run by workflow "S. Yard AR tool", task `study`, on a
 * twin with references (fetched without pictures).
 *
 * The walk is placed by its references (the best placement there is on these walks: check points within inches to a
 * few feet), and then moved: every shift up to 6 m each way in 0.5 m steps and every turn up to 12 degrees in 2. For
 * each kind of evidence, how well the phone's points agree with the shade map's model at each placement:
 *
 *   walls     standing points (0.4-2.4 m) within 30 cm of a solid cell of the match (what the live match uses)
 *   roofEdge  high points (2.4-12 m) within 30 cm of a roof's edge (also used)
 *   canopy    high points inside a cube of the model that holds leaf or roof (mu > 0), give or take one cube: the 3D
 *             crowns, which the match does NOT use today
 *   occupied  every point above the ground (0.4-12 m) inside such a cube: walls, trunks, crowns and roofs together, 3D
 *   ground    ground points within 15 cm of the model's ground, once the height offset is taken out (its shape)
 *
 * A signal that can place the walk scores best at the references' placement and clearly worse a couple of metres
 * away. Printed per signal: its score at the references, the best score anywhere and how far from the references
 * that best is, and the "contrast" (score at the references against the median score 2 m or more away). NUMBERS ONLY.
 *
 *   CLOUDFLARE_API_TOKEN=... node scan/tools/match-study.mjs twin
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { toMerc, ringsOf } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';
import { gridsFromModel } from '../lib/lidar-load.js';
import { columnAt } from '../lib/lidar-model.js';
import { sample } from '../lib/lidar.js';
import { readCloud, readTrack, placer } from '../lib/twin.js';
import { apply } from '../lib/align.js';
import { classify } from '../lib/postfix.js';
import { BANDS } from '../lib/locate.js';
import { readMap, readModel } from './twin-io.mjs';

const thin = (a, m) => (a.length <= m ? a : a.filter((_, i) => i % Math.ceil(a.length / m) === 0));
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);

async function main() {
  const dir = process.argv[2] || 'twin', t0 = Date.now();
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const live = existsSync(join(dir, 'live.json')) ? JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')) : { marks: [] };
  const recs = [], track = [];
  for (const f of readdirSync(dir).filter((x) => /^cloud-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); recs.push(...readCloud(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  for (const f of readdirSync(dir).filter((x) => /^track-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); track.push(...readTrack(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  track.sort((a, b) => a.t - b.t);
  const m = await readMap(meta.map);
  const origin = [m.lng, m.lat];
  const ring = [...ringsOf(m.shapes || []), ...ringsOf(m.parcel ? [m.parcel] : [])].flat().map((p) => toLocal(origin, p));
  const es = ring.map((p) => p[0]), ns = ring.map((p) => p[1]);
  const box = ring.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
  const model = await readModel(meta.map, m.ownerId);
  const S = await import('../../public/shade/structures.js');
  const L = gridsFromModel(model, { origin, box, S, toMerc }), G = L.G;
  const refs = placer(live, 'refs');
  if ((live.marks || []).filter((x) => x.kind === 'ref').length < 2) throw new Error('this study needs a walk with two references');

  // the phone's points, as the page classes them, plus every point above the ground for the 3D signals
  const pts = classify(recs, track);
  const above = [];
  for (const r of recs) { if (!Number.isFinite(r.ground)) continue; const h = r.y - r.ground; if (h > BANDS.standLow && h < BANDS.highTop) above.push([r.x, -r.z, r.y, r.odo]); }
  const stand = thin(pts.stand, 3000), high = thin(pts.high.map((p) => p), 3000), ground = thin(pts.ground, 3000), occ = thin(above, 4000);
  // the high points need their heights for the canopy: take them from the records again (classify keeps u, v, odo)
  const highY = thin(recs.filter((r) => Number.isFinite(r.ground) && r.y - r.ground >= BANDS.standHigh && r.y - r.ground < BANDS.highTop).map((r) => [r.x, -r.z, r.y, r.odo]), 3000);
  console.log(`Walk: ${recs.length.toLocaleString()} points; classed ${pts.stand.length.toLocaleString()} standing, ${pts.high.length.toLocaleString()} high, ${pts.ground.length.toLocaleString()} ground; ${above.length.toLocaleString()} above the ground in all. Model: ${L.rule}.`);

  // the model in 3D: is the cube at a map point and an absolute height occupied (leaf or roof), give or take one cube
  const { grid } = model.meta, layers = model.meta.layers, mu = model.arrays.mu, mg = model.arrays.ground, kind = model.arrays.kind, top = model.arrays.top;
  const k = Math.cos((origin[1] * Math.PI) / 180), [ox, oy] = toMerc(origin);
  const occupied = (e, n, z) => {
    const j = columnAt(grid, ox + e / k, oy + n / k); if (j < 0) return false;
    if (kind[j] === 1 && Number.isFinite(mg[j]) && Number.isFinite(top[j]) && z <= mg[j] + top[j] + 0.5) return true; // under a roof: the building
    if (!mu || !layers) return false;
    const l = Math.floor((z - layers.z0) / layers.dz);
    for (let d = -1; d <= 1; d++) { const q = l + d; if (q >= 0 && q < layers.nz && mu[j * layers.nz + q] > 0) return true; }
    return false;
  };
  const demAt = (e, n) => sample(G, G.dem, e, n);

  // one placement's scores
  const score = (T) => {
    const gz = [];
    for (const [u, v, y] of ground) { const [e, n] = apply(T, [u, v]), z = demAt(e, n); if (Number.isFinite(z)) gz.push(z - y); }
    gz.sort((a, b) => a - b);
    const tz = gz.length ? gz[gz.length >> 1] : null;
    let gIn = 0; for (const d of gz) if (Math.abs(d - tz) < 0.15) gIn++;
    let wIn = 0; for (const [u, v] of stand) { const [e, n] = apply(T, [u, v]); if (sample(G, G.dist, e, n) <= 0.3) wIn++; }
    let rIn = 0, rN = 0; if (G.distRoof) for (const [u, v] of high) { const [e, n] = apply(T, [u, v]); rN++; if (sample(G, G.distRoof, e, n) <= 0.3) rIn++; }
    let cIn = 0, oIn = 0;
    if (tz != null) {
      for (const [u, v, y] of highY) { const [e, n] = apply(T, [u, v]); if (occupied(e, n, y + tz)) cIn++; }
      for (const [u, v, y] of occ) { const [e, n] = apply(T, [u, v]); if (occupied(e, n, y + tz)) oIn++; }
    }
    return { walls: stand.length ? wIn / stand.length : null, roofEdge: rN ? rIn / rN : null, canopy: highY.length && tz != null ? cIn / highY.length : null, occupied: occ.length && tz != null ? oIn / occ.length : null, ground: gz.length ? gIn / gz.length : null };
  };

  // the references' placement for the walk as a whole (their fit at the middle of the walk), and the moves round it
  const odos = recs.map((r) => r.odo), mid = odos.length ? odos[odos.length >> 1] : 0;
  const T0 = refs(mid);
  if (!T0) throw new Error('the references give no placement');
  const results = [];
  for (let dDeg = -12; dDeg <= 12; dDeg += 2) for (let dx = -6; dx <= 6; dx += 0.5) for (let dy = -6; dy <= 6; dy += 0.5) {
    // turn about the walk's middle (where the phone was halfway), then shift
    const pm = apply(T0, [0, 0]), th = (dDeg * Math.PI) / 180;
    const T = { theta: T0.theta + th, tx: pm[0] + Math.cos(th) * (T0.tx - pm[0]) - Math.sin(th) * (T0.ty - pm[1]) + dx, ty: pm[1] + Math.sin(th) * (T0.tx - pm[0]) + Math.cos(th) * (T0.ty - pm[1]) + dy, s: T0.s ?? 1 };
    results.push({ dx, dy, dDeg, s: score(T) });
  }
  const at0 = results.find((r) => r.dx === 0 && r.dy === 0 && r.dDeg === 0).s;
  console.log(`Placements tried round the references' fit: ${results.length} (shifts to 6 m, turns to 12 degrees).`);
  console.log('signal     at refs  best anywhere (where)                contrast (refs / median 2 m+ away)');
  for (const key of ['walls', 'roofEdge', 'canopy', 'occupied', 'ground']) {
    const vals = results.filter((r) => r.s[key] != null);
    if (!vals.length) { console.log(`${key.padEnd(10)} -`); continue; }
    const best = vals.reduce((a, b) => (b.s[key] > a.s[key] ? b : a));
    const away = vals.filter((r) => Math.hypot(r.dx, r.dy) >= 2).map((r) => r.s[key]).sort((a, b) => a - b);
    const med = away[away.length >> 1];
    const rank = vals.filter((r) => r.s[key] > at0[key]).length;
    console.log(`${key.padEnd(10)} ${pct(at0[key]).padStart(6)}  ${pct(best.s[key]).padStart(5)} at ${Math.hypot(best.dx, best.dy).toFixed(1)} m, ${best.dDeg} deg${' '.repeat(8)}  ${(at0[key] / (med || 1e-9)).toFixed(2)}x; ${rank} of ${vals.length} placements score better than the refs`);
  }
  // the combination the study suggests: canopy and occupied with walls and ground, each normalised by its median away
  const norm = {};
  for (const key of ['walls', 'roofEdge', 'canopy', 'occupied', 'ground']) { const a = results.map((r) => r.s[key]).filter((v) => v != null).sort((x, y) => x - y); norm[key] = a.length ? a[a.length >> 1] || 1e-9 : null; }
  const combos = { 'walls+ground (today, roughly)': ['walls', 'ground'], 'occupied (3D) alone': ['occupied'], 'occupied+ground': ['occupied', 'ground'], 'occupied+walls+ground': ['occupied', 'walls', 'ground'], 'canopy+walls+ground': ['canopy', 'walls', 'ground'] };
  for (const [name, keys] of Object.entries(combos)) {
    const val = (r) => keys.reduce((a, key) => a + (r.s[key] != null && norm[key] ? r.s[key] / norm[key] : 0), 0);
    const best = results.reduce((a, b) => (val(b) > val(a) ? b : a));
    const v0 = val(results.find((r) => r.dx === 0 && r.dy === 0 && r.dDeg === 0)), rank = results.filter((r) => val(r) > v0).length;
    console.log(`combined ${name}: best at ${Math.hypot(best.dx, best.dy).toFixed(1)} m, ${best.dDeg} deg from the refs; ${rank} of ${results.length} placements score better than the refs`);
  }
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)} s.`);
}

main().catch((e) => { console.log(`Match study: ${String(e.message).replace(/-?\d+\.\d{3,}/g, '#')}`); process.exit(1); });
