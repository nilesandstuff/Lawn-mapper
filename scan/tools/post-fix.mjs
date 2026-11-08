/**
 * A WALK FIXED AFTERWARDS (core session, 2026-11-05; scan/lib/postfix.js). Run by workflow "S. Yard AR tool", task
 * `fix`, on a twin already fetched (scan/tools/twin-r2.mjs get): the whole walk placed on the shade map's model at
 * once, its pins put on the map, its check points scored four ways, and two files written beside the twin for the
 * workflow to keep in the walk's folder of the bucket:
 *
 *   fixed.json  how the walk sits on the map: the global placement, every window, the knots blended along the walk,
 *               the height offset, the pins on the map, the check points' errors
 *   mesh.bin    the base mesh: every point of the walk on the map, one per 10 cm cell, with its class (the
 *               lidar-model.js container, gzipped: unpackModel reads it)
 *
 * NUMBERS ONLY in the log: no coordinates, no map key, no picture (the repository is public).
 *
 *   CLOUDFLARE_API_TOKEN=... node scan/tools/post-fix.mjs twin
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toMerc, ringsOf } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';
import { gridsFromModel } from '../lib/lidar-load.js';
import { sample } from '../lib/lidar.js';
import { packModel } from '../lib/lidar-model.js';
import { readCloud, readTrack, placer } from '../lib/twin.js';
import { apply, fitRigid } from '../lib/align.js';
import { classify, solveWalk, refsPrior, gpsPrior, checkErrors, checkMarks, baseMesh } from '../lib/postfix.js';
import { readMap, readModel } from './twin-io.mjs';
import { walkPrior, walkFix } from '../lib/walkfix.js';

const FT = 3.28084;
const ft = (m) => (m == null || !Number.isFinite(m) ? '-' : `${(m * FT).toFixed(1)} ft`);
const r4 = (v) => (Number.isFinite(v) ? +v.toFixed(4) : null);
const Tout = (T) => (T ? { theta: r4(T.theta), tx: r4(T.tx), ty: r4(T.ty), s: r4(T.s ?? 1) } : null);

async function main() {
  const dir = process.argv[2] || 'twin', t0 = Date.now();
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const live = existsSync(join(dir, 'live.json')) ? JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')) : { marks: [], pins: [] };
  const recs = [], track = [];
  for (const f of readdirSync(dir).filter((x) => /^cloud-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); recs.push(...readCloud(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  for (const f of readdirSync(dir).filter((x) => /^track-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); track.push(...readTrack(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  track.sort((a, b) => a.t - b.t);
  if (!meta.map) throw new Error('the twin names no map');
  let m;
  try { m = await readMap(meta.map); } catch (e) { throw new Error(/no such map|needs the|could not be read \(\d+\)/.test(e.message) ? e.message : 'the map could not be read from the database'); }
  const origin = [m.lng, m.lat];
  const ring = [...ringsOf(m.shapes || []), ...ringsOf(m.parcel ? [m.parcel] : [])].flat().map((p) => toLocal(origin, p));
  const es = ring.map((p) => p[0]), ns = ring.map((p) => p[1]);
  const box = ring.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
  const model = await readModel(meta.map, m.ownerId);
  const S = await import('../../public/shade/structures.js');
  const L = gridsFromModel(model, { origin, box, S, toMerc });
  console.log(`Walk: ${recs.length.toLocaleString()} points, ${track.length.toLocaleString()} poses, ${(live.marks || []).filter((x) => x.kind === 'ref').length} reference marks, ${(live.marks || []).filter((x) => x.kind === 'check').length} check marks, ${(live.pins || []).length} pins${live.recordOnly ? ', recorded only (no live fix)' : ''}.`);
  console.log(`Lidar: the shade map's model (${model.meta.at ? String(model.meta.at).slice(0, 10) : 'undated'}); ${L.rule}.`);

  const pts = classify(recs, track);
  console.log(`Classed as the page does: ${pts.stand.length.toLocaleString()} standing (seen twice, within 3.5 m), ${pts.ground.length.toLocaleString()} ground, ${pts.high.length.toLocaleString()} high.`);
  // where to start: the references; else GPS as the page kept it; else anywhere in the box
  let prior = refsPrior(live.marks), from = 'the references';
  if (!prior) { const g = gpsPrior(live.gpsTrail); if (g) { prior = g; from = g.from; } }
  if (!prior && live.gps?.at && live.gps?.phone) { prior = { at: live.gps.at, phone: live.gps.phone, radiusM: Math.max(8, Math.min(25, (live.gps.acc || 10) * 1.5)) }; from = 'GPS'; }
  if (!prior) {
    const p0 = track[0]?.pos;
    prior = { at: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], phone: p0 ? [p0.x, -p0.z] : [0, 0], radiusM: Math.hypot(box[2] - box[0], box[3] - box[1]) / 2 };
    from = 'anywhere on the lot (no references, no GPS)';
  }
  /* THE PICTURES' PLACEMENT (2026-11-06, SCAN-H19; scan/tools/skyline_study.py then pavement_study.py, task place):
     the skyline for the coarse placement, the lidar's brightness under the pavement the pictures saw and the ground's
     shape for the fine one. ARCore holds a walk to about a foot (SCAN-H13), so one placement stands for the whole
     walk. Used for the walk when no references were marked; with references, scored beside them. */
  const pl = existsSync(join(dir, 'placement.json')) ? JSON.parse(readFileSync(join(dir, 'placement.json'), 'utf8')) : null;
  const plT = pl && Number.isFinite(pl.theta) ? { theta: pl.theta, tx: pl.tx, ty: pl.ty, s: 1 } : null;
  if (plT) console.log(`The pictures' placement: ${pl.from}${pl.pavementCells != null ? ` (${pl.pavementCells} pavement cells, ${pl.groundPoints} ground points)` : ''}.`);
  const refsPlace = placer(live, 'refs');
  const hasRefs = (live.marks || []).filter((x) => x.kind === 'ref').length >= 2;
  const sol = solveWalk(pts, L.G, prior, { refPlace: hasRefs ? refsPlace : null });
  const kept = sol.windows.filter((w) => w.kept);
  const placeAfter = !hasRefs && plT ? () => plT : sol.placeAt;
  if (!hasRefs && plT) console.log('No references: the walk is placed by its pictures (the lidar points below are reported, not used).');
  console.log(`Started from ${from}. One placement for the whole walk: ${sol.global.ok ? `found, ${Math.round((sol.global.hits || 0) * 100)}% of standing points landed (${sol.global.landed})` : `not found (${sol.global.why})`}.`);
  console.log(`Windows of 60 m every 20 m: ${sol.windows.length}; found ${sol.windows.filter((w) => w.ok).length}; kept ${kept.length}${hasRefs ? ', each within 1.5 m and 5 degrees of the references, the references kept everywhere else' : ''} (the rest: ${JSON.stringify(sol.windows.filter((w) => !w.kept).map((w) => (w.why ? w.why.replace(/\d+(\.\d+)?/g, '#') : 'not found')).reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {}))}).`);

  /* THE WHOLE WALK PLACED AT ONCE, AS THE PAGE NOW DOES LIVE (scan/lib/walkfix.js, 2026-11-08), replayed: at a
     quarter, half, three quarters and the end of the walk, the trail's placement (Street View's readings, else GPS's)
     from what had been walked by then, refined by the ground points seen by then. */
  const gnd = [], seenCell = new Set();
  for (const r of recs) {
    if (!Number.isFinite(r.ground) || Math.abs(r.y - r.ground) >= 0.15) continue;
    const k = `${Math.floor(r.x / 0.5)},${Math.floor(r.z / 0.5)}`; if (seenCell.has(k)) continue; seenCell.add(k);
    gnd.push({ p: [r.x, -r.z, r.y], odo: r.odo });
  }
  const geoT = (live.geoTrail || []).map((g) => ({ ...g, at: Array.isArray(g.at) ? g.at : Number.isFinite(g.lat) ? toLocal(origin, [g.lng, g.lat]) : null }));
  const dem = { box: L.G.box, cell: L.G.cell, W: L.G.W, H: L.G.H, data: L.G.dem };
  const maxOdo = Math.max(0, ...recs.map((r) => r.odo || 0));
  const replay = [];
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const upto = maxOdo * frac;
    const gsub = gnd.filter((g) => g.odo <= upto + 1e-6), step = Math.max(1, Math.ceil(gsub.length / 1500));
    const ground = gsub.filter((_, i) => i % step === 0).map((g) => g.p);
    const prior = walkPrior((live.gpsTrail || []).filter((g) => (g.odo ?? 0) <= upto), geoT.filter((g) => (g.odo ?? 0) <= upto));
    const fx = walkFix(dem, ground, prior);
    replay.push({ frac, upto, prior, fx, ground: ground.length });
  }
  const lastWalk = replay[replay.length - 1].fx;
  // the check points, four ways
  const ways = { 'after the walk': placeAfter, ...(plT ? { pictures: () => plT } : {}), ...(sol.global.ok ? { 'one placement': () => sol.global.T } : {}), 'references alone': refsPlace, 'as walked': placer(live, 'both'),
    ...(lastWalk?.T ? { 'whole walk (replayed)': () => lastWalk.T } : {}), ...(live.walk?.T ? { 'whole walk, live': () => live.walk.T } : {}) };
  const table = {};
  for (const [name, place] of Object.entries(ways)) for (const c of checkErrors(live.marks, place)) (table[c.id] = table[c.id] || {})[name] = c.m;
  if (Object.keys(table).length) {
    console.log('Check points, how far each placement puts them:');
    for (const [id, row] of Object.entries(table)) console.log(`  ${String(id).slice(0, 12)}: ${Object.entries(row).map(([k, v]) => `${k} ${ft(v)}`).join(', ')}`);
    const med = (k) => { const a = Object.values(table).map((r) => r[k]).filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
    console.log(`  median: ${Object.keys(ways).map((k) => `${k} ${ft(med(k))}`).join(', ')}`);
  } else console.log('No check points marked: nothing to score against.');
  {
    const medOf = (T) => { if (!T) return null; const a = checkErrors(live.marks, () => T).map((c) => c.m).filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
    console.log(`The whole walk placed at once, as the page now does live (replayed): ${replay.map((r) => `at ${Math.round(r.upto * FT)} ft walked: ${r.prior ? (r.fx.ok ? 'used' : `not used (${r.fx.why})`) : 'no trail yet'}${r.fx.T ? `, ${Math.round((r.fx.share || 0) * 100)}% on the ground, margin ${((r.fx.margin || 0) * 100).toFixed(1)}%` : ''}${medOf(r.fx.T) != null ? `, checks median ${ft(medOf(r.fx.T))}` : ''}${r.prior && medOf(r.prior.T) != null ? ` (the trail alone ${ft(medOf(r.prior.T))})` : ''}`).join('; ')}.`);
  }

  /* THE CHECK POINTS AS THEIR OWN REFERENCES (2026-11-05): what any placement made from marks could do on this walk.
     All of them fitted as one turn and shift: what is left at each is how far ARCore's own frame bent between them (no
     single placement can beat it); and each one left out, placed by the others: what marking references at those
     spots would have given. With the GPS trail's placement beside them, when there was one. */
  const uniq = checkMarks(live.marks); // a point marked twice: its last mark
  if (uniq.length >= 3) {
    const all = fitRigid(uniq.map((c) => ({ ar: c.ar, map: c.map })));
    const loo = uniq.map((c) => { const T = fitRigid(uniq.filter((d) => d !== c).map((d) => ({ ar: d.ar, map: d.map }))); if (!T) return null; const [e, n] = apply(T, c.ar); return Math.hypot(e - c.map[0], n - c.map[1]); });
    const span = Math.max(...uniq.map((c) => c.odo ?? 0)) - Math.min(...uniq.map((c) => c.odo ?? 0));
    console.log(`The ${uniq.length} check points as their own references (marked over ${Math.round(span * FT)} ft of walking):`);
    if (all) console.log(`  all fitted at once: left over ${all.residuals.map((r) => ft(r)).join(', ')} (ARCore's frame bending between them); distances AR against map ${((all.scale - 1) * 100).toFixed(1)}%`);
    console.log(`  each placed by the others: ${loo.map((r) => ft(r)).join(', ')}`);
    const g = gpsPrior(live.gpsTrail);
    if (g?.T) console.log(`  the GPS trail's placement alone: ${uniq.map((c) => { const [e, n] = apply(g.T, c.ar); return ft(Math.hypot(e - c.map[0], n - c.map[1])); }).join(', ')}`);
    const twice = cks.filter((c) => cks.filter((d) => d.id === c.id).length > 1);
    if (twice.length) { const ids = [...new Set(twice.map((c) => c.id))]; for (const id of ids) { const ms = cks.filter((c) => c.id === id); console.log(`  marked twice: ${ms.length} marks ${ft(Math.hypot(ms[0].ar[0] - ms[ms.length - 1].ar[0], ms[0].ar[1] - ms[ms.length - 1].ar[1]))} apart as ARCore had them, ${Math.round(Math.abs((ms[ms.length - 1].odo ?? 0) - (ms[0].odo ?? 0)) * FT)} ft walked between`); } }
  }

  // the height, the pins, the mesh
  // the height: the lidar's ground minus the phone's, at the phone's ground points as the walk is placed
  const tzOf = (place) => { const d = []; for (const [u, v, y, odo] of pts.ground.filter((_, i) => i % 20 === 0)) { const T = place(odo); if (!T) continue; const [e, n] = apply(T, [u, v]); const z = sample(L.G, L.G.dem, e, n); if (Number.isFinite(z)) d.push(z - y); } d.sort((a, b) => a - b); return d.length > 30 ? d[d.length >> 1] : null; };
  const tz = !hasRefs && plT ? tzOf(placeAfter) : (sol.global.tz ?? tzOf(placeAfter));
  const pins = (live.pins || []).filter((p) => p.at).map((p) => { const T = placeAfter(p.odo ?? 0); const [e, n] = T ? apply(T, [p.at.x, -p.at.z]) : [null, null]; return { name: p.name, map: e == null ? null : [r4(e), r4(n)], z: tz != null && Number.isFinite(p.at.y) ? r4(p.at.y + tz) : null, odo: p.odo ?? null }; });
  const mesh = baseMesh(recs, placeAfter, tz ?? 0);
  const meshBytes = await packModel({ tool: 'scan', kind: 'base-mesh', v: 1, walk: meta.walk || null, at: new Date().toISOString(), voxel: 0.1, frame: 'map metres round the map origin; z absolute (the lidar ground)', classes: { 0: 'ground', 1: 'standing', 2: 'high', 3: 'other' }, heightKnown: tz != null }, mesh);
  writeFileSync(join(dir, 'mesh.bin'), Buffer.from(meshBytes));
  const fixed = {
    v: 1, at: new Date().toISOString(), method: !hasRefs && plT ? `the pictures: ${pl.from}` : 'postfix.js solveWalk: global, 60 m windows every 20 m, neighbour check, blended', from,
    pictures: plT ? { ...Tout(plT), from: pl.from, pavementCells: pl.pavementCells ?? null } : null,
    model: { at: model.meta.at || null }, global: { ...sol.global, T: Tout(sol.global.T) }, tz,
    windows: sol.windows.map((w) => ({ odo0: w.odo0, odo1: w.odo1, ok: w.ok, kept: w.kept, hits: r4(w.hits), landed: w.landed ?? null, why: w.why || null, T: Tout(w.T) })),
    knots: sol.knots.map((k) => ({ odo: k.odo, T: Tout(k.T) })), pins, checks: table,
  };
  writeFileSync(join(dir, 'fixed.json'), JSON.stringify(fixed));
  console.log(`Pins put on the map: ${pins.filter((p) => p.map).length} of ${pins.length}. Height known: ${tz != null ? 'yes, from the ground points' : 'no'}.`);
  /* PINS AS CHECKS (the owner, 2026-11-05: on a walk without references "I placed pins on the checkpoints... I also
     placed a pin on the same spot a few times"): each placed pin against the nearest check point on the map (when the
     walk kept the points, live.json `points`), and pins dropped on one spot, how far apart they are as ARCore had them
     and as placed */
  const checksMap = (live.points || []).filter((p) => p.kind === 'check' && p.map);
  if (checksMap.length) {
    const near = pins.filter((p) => p.map).map((p) => { let best = null; for (const c of checksMap) { const d = Math.hypot(p.map[0] - c.map[0], p.map[1] - c.map[1]); if (!best || d < best.d) best = { d, name: c.name }; } return { pin: p.name, ...best }; });
    console.log(`Pins against the nearest check point (as placed after the walk): ${near.map((x) => `${String(x.pin).slice(0, 8)}->${String(x.name).slice(0, 8)} ${ft(x.d)}`).join(', ') || 'none'}.`);
    /* WHICH CHECK POINTS THE PINS WERE ON (the owner, 2026-11-07: "I can't remember which 2"): with no placement at
       all, the distance between two pins as ARCore had them against the distance between every two check points on
       the map; the pairs that agree best */
    const pp = (live.pins || []).filter((p) => p.at);
    if (pp.length >= 2 && checksMap.length >= 2) {
      const lines = [];
      for (let a = 0; a < pp.length; a++) for (let b = a + 1; b < pp.length; b++) {
        const dAr = Math.hypot(pp[a].at.x - pp[b].at.x, pp[a].at.z - pp[b].at.z);
        if (dAr < 1) continue; // two pins on one spot say nothing here
        const pairs = [];
        for (let i = 0; i < checksMap.length; i++) for (let j = i + 1; j < checksMap.length; j++) pairs.push({ i, j, d: Math.abs(Math.hypot(checksMap[i].map[0] - checksMap[j].map[0], checksMap[i].map[1] - checksMap[j].map[1]) - dAr) });
        pairs.sort((x, y) => x.d - y.d);
        lines.push(`pins ${String(pp[a].name).slice(0, 8)} and ${String(pp[b].name).slice(0, 8)}, ${ft(dAr)} apart: ${pairs.slice(0, 3).map((x) => `${String(checksMap[x.i].name).slice(0, 8)}+${String(checksMap[x.j].name).slice(0, 8)} (off by ${ft(x.d)})`).join(', ')}`);
      }
      if (lines.length) console.log(`Which check points the pins were on, by their distance apart alone: ${lines.join('; ')}.`);
    }
  } else console.log('The walk kept no check points (walks before 2026-11-05 did not): pins cannot be scored against them.');
  const sess = (live.pins || []).filter((p) => p.at).map((p, i) => ({ i, u: p.at.x, v: -p.at.z }));
  const groups = [];
  for (const p of sess) { const g = groups.find((G) => G.some((q) => Math.hypot(q.u - p.u, q.v - p.v) < 2)); if (g) g.push(p); else groups.push([p]); }
  const spread = (pts) => { let m = 0; for (const a of pts) for (const b of pts) m = Math.max(m, Math.hypot(a[0] - b[0], a[1] - b[1])); return m; };
  const same = groups.filter((G) => G.length > 1);
  if (same.length) console.log(`Pins on one spot: ${same.map((G) => `${G.length} pins, ${ft(spread(G.map((p) => [p.u, p.v])))} apart as ARCore had them, ${ft(spread(G.map((p) => pins[p.i]?.map).filter(Boolean)))} as placed after the walk`).join('; ')}.`);
  console.log(`Base mesh: ${mesh.e.length.toLocaleString()} cells of 10 cm from ${recs.length.toLocaleString()} points, ${(meshBytes.byteLength / 1e6).toFixed(2)} MB gzipped. Done in ${Math.round((Date.now() - t0) / 1000)} s.`);
}

main().catch((e) => { console.log(`Post-walk fix: ${String(e.message).replace(/-?\d+\.\d{3,}/g, '#')}`); process.exit(1); });
