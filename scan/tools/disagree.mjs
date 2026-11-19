/**
 * WHERE A WALK AND THE LIDAR MODEL DISAGREE, FOR ONE WALK (core session, 2026-11-18; scan/lib/disagree.js says why).
 * Workflow "S. Yard AR tool", task `disagree`, on a twin already fetched (scan/tools/twin-r2.mjs get).
 *
 * The walk's points are placed by its own roof corners, each part by the corners sighted nearest it (refkeep.js
 * keepPlan and align.js fitAt, as the reference is kept), and only the points seen within RANGE_M of the camera are
 * used: the phone's depth is from motion, and noisy past that. The model is the shade map's finished file, gridded as
 * the AR page grids it. COUNTS, LENGTHS AND SHARES ONLY: no coordinate, no address, no picture.
 *
 *   CLOUDFLARE_API_TOKEN=... node scan/tools/disagree.mjs twin
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toMerc, ringsOf } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';
import { gridsFromModel } from '../lib/lidar-load.js';
import { readMap, readModel } from './twin-io.mjs';
import { readCloud, readLabels, readTrack } from '../lib/twin.js';
import { keepPlan } from '../lib/refkeep.js';
import { fitAt, apply } from '../lib/align.js';
import { disagree, lines, heights, carve, seenPast, confirmed, groundLooks, NEAR_M } from '../lib/disagree.js';

const RANGE_M = 6;

const dir = process.argv[2] || 'twin';
const site = (process.env.SITE || '').replace(/\/$/, ''), key = process.env.MAPS_READ_TOKEN;
const json = (f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } };
const meta = json('meta.json') || {}, live = json('live.json') || { marks: [] };
const buf = (f) => { const b = readFileSync(join(dir, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

const recs = [];
for (const f of readdirSync(dir).filter((x) => /^cloud-\d+\.bin$/.test(x)).sort()) {
  const part = readCloud(buf(f)), lp = f.replace('cloud-', 'labels-');
  const lab = existsSync(join(dir, lp)) ? readLabels(buf(lp), part.length) : null;
  part.forEach((r, i) => { r.label = lab?.[i]?.label ?? null; r.conf = lab?.[i]?.conf ?? null; r.spike = !!lab?.[i]?.spike; r.geo = !!lab?.[i]?.geoDepth; });
  recs.push(...part);
}
const track = [];
for (const f of readdirSync(dir).filter((x) => /^track-\d+\.bin$/.test(x)).sort()) track.push(...readTrack(buf(f)));
track.sort((a, b) => a.t - b.t);
const camAt = (t) => { let lo = 0, hi = track.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (track[m].t < t) lo = m + 1; else hi = m; } return track[lo]?.pos || null; };

if (!meta.map || String(meta.map).length > 300) throw new Error('the twin names no usable map');
let m;
try { m = await readMap(meta.map, site, key); } catch (e) { throw new Error(/no such map|needs the|could not be read \(\d+\)/.test(e.message) ? e.message : 'the map could not be read from the database'); }
const origin = [m.lng, m.lat];
const lawnRings = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(origin, p)));
const all = [...lawnRings.flat(), ...ringsOf(m.parcel ? [m.parcel] : []).flat().map((p) => toLocal(origin, p))];
const es = all.map((p) => p[0]), ns = all.map((p) => p[1]);
const box = all.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
const model = await readModel(meta.map, m.ownerId);
const S = await import('../../public/shade/structures.js');
const L = gridsFromModel(model, { origin, box, lawn: lawnRings, S, toMerc });
const { G, shade } = L;

// the walk on the map: its roof corners, each part by those sighted nearest it
const plan = keepPlan(live.marks || []);
console.log(`The walk: ${recs.length.toLocaleString()} points, ${new Set((live.marks || []).map((x) => x.id)).size} corners marked; ${plan.ok ? `placed by ${new Set(plan.use.map((x) => x.id)).size} of them${plan.agree ? `, agreeing within ${(plan.g.worstM * 39.37).toFixed(0)} in` : ', which do NOT all agree with the map: read what follows with that in mind'}` : `NOT placed (${plan.why})`}.`);
console.log(`The model: the shade map's, ${model.meta?.at ? String(model.meta.at).slice(0, 10) : 'undated'}; lined up ${model.meta?.lidar?.fit ? (model.meta.lidar.fit.confident ? `by the photo${model.meta.lidar.fit.on ? ` (${model.meta.lidar.fit.on})` : ''}, confidently` : 'by the datum alone (the photo match was not confident)') : 'by the datum alone (no photo match kept)'}.`);
if (!plan.ok) process.exit(0);
const fits = new Map();
const fitFor = (odo) => { const k = Math.round(odo); if (!fits.has(k)) fits.set(k, fitAt(plan.use, k) || plan.C); return fits.get(k); };
const pts = [], every = []; // pts: within RANGE_M (the report); every: every measured point with its camera (the study below)
let far = 0, spikes = 0;
for (let i = 0; i < recs.length; i++) {
  const r = recs[i];
  if (r.spike) { spikes++; continue; }
  const cam = camAt(r.t);
  const dist = cam ? Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z) : null;
  const [e, n] = apply(fitFor(r.odo), [r.x, -r.z]);
  const pt = { e, n, y: r.y, t: r.t, ground: r.ground, label: r.label, conf: r.conf, i };
  // Google's street geometry past 25 m is not a measurement of the camera's: never part of the study
  if (cam && !r.geo) every.push({ ...pt, h: r.y - r.ground, dist, c: [cam.x, cam.y, cam.z], p: [r.x, r.y, r.z] });
  if (dist != null && dist > RANGE_M) { far++; continue; }
  pts.push(pt);
}
// THE HEIGHT IS OVER THE GROUND THE PAGE KEPT UNDER EACH POINT. Taking it over the ground the walk's own points show
// nearby (lib/disagree.js heights) was tried twice on 2026-11-18 and made the report no better on one walk and worse
// on the other (docs/SCAN-PLAN.md section 30), so it is not used; how many points it would move is still printed.
{
  const hs = heights(pts);
  let was = 0, moved = 0;
  pts.forEach((p, k) => { p.h = p.y - p.ground; if (p.h > 0.4 && p.h < 2.4) { was++; if (!(hs[k] > 0.4 && hs[k] < 2.4)) moved++; } });
  console.log(`Heights: over the ground the page kept under each point (the walk's own ground nearby would un-stand ${moved.toLocaleString()} of ${was.toLocaleString()} standing points; tried, not used).`);
}
console.log(`Used: ${pts.length.toLocaleString()} points seen within ${Math.round(RANGE_M * 3.281)} ft of the phone (${far.toLocaleString()} farther left out, ${spikes} spikes); labelled ${Math.round((100 * pts.filter((p) => p.label).length) / Math.max(1, pts.length))}%.`);

// the model's answers at a place (metres round the map's origin)
const fine = (e, n) => { const c = Math.floor((e - box[0]) / G.cell), r = Math.floor((box[3] - n) / G.cell); return c < 0 || r < 0 || c >= G.W || r >= G.H ? -1 : r * G.W + c; };
const solid = (e, n) => { for (let dy = 0; dy < 1; dy += G.cell) for (let dx = 0; dx < 1; dx += G.cell) { const k = fine(Math.floor(e) + dx + G.cell / 2, Math.floor(n) + dy + G.cell / 2); if (k >= 0 && G.occ[k]) return true; } return false; };
const NAMES = Object.fromEntries(Object.entries(model.meta?.rule?.kinds || {}).map(([k, v]) => [v, k.toLowerCase().replace('_', ' ')]));
const kind = (e, n) => {
  if (!shade) return null;
  const { sgrid } = shade, x = L.ox + e / L.k, y = L.oy + n / L.k;
  const c = Math.floor((x - sgrid.x0) / sgrid.cell), r = Math.floor((sgrid.y1 - y) / (sgrid.cellY || sgrid.cell));
  return c < 0 || r < 0 || c >= sgrid.w || r >= sgrid.h ? null : NAMES[shade.kind[r * sgrid.w + c]] || null;
};
const inRing = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const lawn = (e, n) => (lawnRings.length ? lawnRings.some((r) => inRing(r, e, n)) : null);
if (m.trace?.status === 'whole') console.log('This map\'s lawn is the whole property (no trace): "grass outside the lawn" then means outside the property line.');
// what the phone's standing points may agree with: the match's solid cells, or any column the model calls a tree, a
// structure, a building or unknown (the match leaves crowns out; a trunk or a shrub under one is still the model's)
const anything = (e, n) => solid(e, n) || !['nothing', null].includes(kind(e + 0.5 - (e - Math.floor(e)), n + 0.5 - (n - Math.floor(n))));
const result = disagree(pts, { solid: anything, standing: solid, kind, lawn });
for (const l of lines(result)) console.log(l);

/* HOW FAR CAN THE PHONE'S DEPTH BE TRUSTED, AND DOES A SECOND LOOK TELL REAL FROM NOISE (2026-11-19; lib/disagree.js
   carve says why, in the owner's words). Every measured point at every distance, asked of the rest of the walk. */
{
  const t0 = Date.now(), C = carve(every), FT = 3.281;
  const inLidar = (p) => { for (let dy = -NEAR_M; dy <= NEAR_M; dy += 1) for (let dx = -NEAR_M; dx <= NEAR_M; dx += 1) if (anything(p.e + dx, p.n + dy)) return true; return false; };
  const pc = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  console.log(`BY DISTANCE FROM THE PHONE (every measured point, ${every.length.toLocaleString()}; a second look = another ${5} s stretch of the walk saw the same foot-wide cube; ${((Date.now() - t0) / 1000).toFixed(0)} s):`);
  const bands = [[0, 10], [10, 20], [20, 40], [40, 60], [60, 80], [80, 1e9]];
  for (const [a, b] of bands) {
    let n = 0, two = 0, past = 0, conf = 0, st = 0, stIn = 0, stC = 0, stCIn = 0, stX = 0, stXIn = 0;
    every.forEach((p, k) => {
      const d = p.dist * FT; if (d < a || d >= b) return;
      n++; if (C.views[k] >= 2) two++; if (seenPast(C, k)) past++; const ok = confirmed(C, k); if (ok) conf++;
      if (p.h > 0.4 && p.h < 2.4) { const hit = inLidar(p); st++; if (hit) stIn++; if (ok) { stC++; if (hit) stCIn++; } else { stX++; if (hit) stXIn++; } }
    });
    if (!n) continue;
    console.log(`  ${a}-${b > 1e6 ? '' : b} ft${b > 1e6 ? ' and over' : ''}: ${n.toLocaleString()} points; a second look ${pc(two, n)}, seen past ${pc(past, n)}, confirmed ${pc(conf, n)}. Standing ones in the lidar within 1 m: all ${pc(stIn, st)} of ${st.toLocaleString()}; confirmed ${pc(stCIn, stC)} of ${stC.toLocaleString()}; not confirmed ${pc(stXIn, stX)} of ${stX.toLocaleString()}.`);
  }
  // the report again on every confirmed point out to 80 ft, beside the one above (within 20 ft, confirmed or not)
  const FAR_M = 80 / FT, wide = every.filter((p, k) => p.dist <= FAR_M && confirmed(C, k));
  console.log(`THE SAME REPORT ON EVERY CONFIRMED POINT OUT TO 80 FT (${wide.length.toLocaleString()} points; above: ${pts.length.toLocaleString()} within ${Math.round(RANGE_M * FT)} ft, confirmed or not):`);
  for (const l of lines(disagree(wide, { solid: anything, standing: solid, kind, lawn })).slice(0, 6)) console.log(`  ${l}`);
  // the patches above: were their points confirmed, or seen past?
  const at = new Map(every.map((p, k) => [p.i, k]));
  result.extra.patches.forEach((pt, j) => {
    const ks = (pt.idx || []).map((i) => at.get(i)).filter((k) => k != null); if (!ks.length) return;
    console.log(`  patch ${j + 1} (${pt.cells} m2, ${pt.label}): ${pc(ks.filter((k) => confirmed(C, k)).length, ks.length)} of its points confirmed, ${pc(ks.filter((k) => seenPast(C, k)).length, ks.length)} seen past, ${pc(ks.filter((k) => C.views[k] < 2).length, ks.length)} seen in one stretch only.`);
  });
  // the ground by more than one look
  const inch = (m) => (m * 39.37).toFixed(1), q = (a, f) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))] : NaN);
  for (const [name, set] of [[`within ${Math.round(RANGE_M * FT)} ft`, every.filter((p) => p.dist <= RANGE_M)], ['out to 80 ft', every.filter((p) => p.dist <= FAR_M)]]) {
    const g = groundLooks(set);
    console.log(`THE GROUND BY MORE THAN ONE LOOK (${name}): ${g.squares.toLocaleString()} squares of 20 in; seen in one stretch ${pc(g.one, g.squares)}, two ${pc(g.two, g.squares)}, three or more ${pc(g.more, g.squares)}. Where looked at twice or more, a look sits a median ${inch(q(g.spread, 0.5))} in from its square's middle height (three in four within ${inch(q(g.spread, 0.75))} in, nine in ten within ${inch(q(g.spread, 0.9))} in).`);
  }
}
// for the segment trial (scan/tools/segment_study.py): each patch as the indexes of its points in the twin's own
// records. Kept in the run's folder only; no place in it.
if (process.env.CELLS_OUT) writeFileSync(process.env.CELLS_OUT, JSON.stringify(result.extra.patches.map((p) => ({ cells: p.cells, lengthM: p.lengthM, line: p.line, label: p.label, idx: p.idx || [] }))));
