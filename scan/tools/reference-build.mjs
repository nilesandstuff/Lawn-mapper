/**
 * THE MAP'S REFERENCE WALK, FROM A TWIN (core session, 2026-11-09; scan/lib/walkref.js, SCAN-H32). A walk placed by
 * its marks becomes the reference that places later walks on the same map by their shape, live on the page.
 *
 *   node scan/tools/reference-build.mjs build <twin dir>         the walk's reference, kept as refs/<map>.bin
 *   node scan/tools/reference-build.mjs check <dir> <dir> [...]  the page's own fix (walkref.js shapeFix) on walks
 *                                                                with check marks: each in turn the reference, the
 *                                                                others placed from it, scored on their own marks
 *
 * Each dir as twin-r2.mjs get leaves it. Prints distances and counts only.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRef, encodeRef, decodeRef, shapeFix, fitRigid, place, STAND, sameFix, trustedRef } from '../lib/walkref.js';
import { keepPlan, placeWalk, matchUsable, updateRef, AS_IS, closingOf, CLOSE_M, mergeCounted, countsOf, compose, invert, placementOf, placeOnShape, addPlaced } from '../lib/refkeep.js';
import { fitAt } from '../lib/align.js';
import { readTrack } from '../lib/twin.js';
import { checkMarks } from '../lib/postfix.js';
import { walkPrior } from '../lib/walkfix.js';
import { writeObject, readObject, BUCKET, API, account, list } from './twin-r2.mjs';

const FT = 3.28084;
const DROP = new Set([2, 10, 11]);   // label + 1: sky, vehicle, person

// label + 1 -> a kind for the label study: building 1, tree 2, structure or object 3; anything else not known
const KIND = { 3: 1, 4: 2, 8: 3, 9: 3 };

/** A twin's points as the page keeps them: { stand, ground } [[u, v, y]] in its session. */
export function twinPoints(dir) {
  const stand = [], ground = [];
  for (const f of readdirSync(dir).filter((x) => /^cloud-\d{4}\.bin$/.test(x)).sort()) {
    const b = readFileSync(join(dir, f));
    const a = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 24) * 6);
    const n = a.length / 6;
    const lp = join(dir, f.replace('cloud-', 'labels-'));
    const lab = existsSync(lp) ? readFileSync(lp) : null;
    const four = lab && lab.length === 4 * n, three = lab && lab.length === 3 * n;
    for (let i = 0; i < n; i++) {
      const x = a[i * 6 + 2], y = a[i * 6 + 3], z = a[i * 6 + 4], g = a[i * 6 + 5];
      if (!Number.isFinite(g)) continue;
      if (four && (lab[i * 4 + 3] & 3)) continue;              // the page's spikes, Geospatial Depth
      const l = four ? lab[i * 4] : three ? lab[i * 3] : 0;
      if (DROP.has(l)) continue;
      const h = y - g;
      const odo = a[i * 6 + 1];   // m walked when the point was seen (refkeep.js partOf)
      if (Math.abs(h) < 0.15) ground.push([x, -z, y, odo]);
      else if (h >= STAND[0] && h <= STAND[1]) stand.push([x, -z, y, odo, KIND[l] || 0]);
    }
  }
  return { stand, ground };
}

function readJson(dir, name) {
  try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return null; }
}

/** The walk's marks: checks (the last of each), references, and the fit of all of them. */
export function marksOf(dir) {
  const live = readJson(dir, 'live.json') || {};
  const checks = checkMarks(live.marks);
  const refs = (live.marks || []).filter((m) => m.kind === 'ref' && m.ar && m.map);
  const all = [...checks, ...refs];
  const T = all.length >= 3 ? fitRigid(all.map((m) => m.ar), all.map((m) => m.map)) : null;
  const resid = T ? all.map((m) => { const p = place(T, ...m.ar); return Math.hypot(p[0] - m.map[0], p[1] - m.map[1]); }) : [];
  return { checks, refs, T, resid };
}

/* AIM TO AIM (the owner, 2026-11-10: check points placed loosely on the photo hurt the scores). A spot aimed at in
   both walks (the same point, so the same id) is one place on the ground: once the walk is placed on the earlier
   one, its aim should land where the earlier walk's aim did, in the earlier walk's own frame. No photo in it. */
function lastAims(live) {
  const by = new Map();
  for (const m of live?.marks || []) if (m.ar && m.id != null) by.set(m.id, m);
  return by;
}
export function aimToAim(r, w, T) {
  const a = lastAims(readJson(r.d, 'live.json')), b = lastAims(readJson(w.d, 'live.json'));
  const out = [];
  for (const [id, mb] of b) { const ma = a.get(id); if (!ma) continue; const p = place(T, ...mb.ar), q = place(r.T, ...ma.ar); out.push(Math.hypot(p[0] - q[0], p[1] - q[1]) * FT); }
  return out;
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

async function build(dir) {
  const meta = readJson(dir, 'meta.json') || {};
  if (!meta.map) throw new Error('the walk has no map');
  const { T, resid, checks, refs } = marksOf(dir);
  if (!T) throw new Error('the walk needs three marks or more to be a reference');
  const pts = twinPoints(dir);
  const ref = buildRef(pts, T, Date.now());
  const bytes = encodeRef(ref);
  await writeObject(BUCKET, `refs/${meta.map}.bin`, bytes, 'application/octet-stream');
  console.log(`Reference kept for the walk's map: ${ref.stand.length / 3} standing and ${ref.ground.length / 3} ground points `
    + `(${(bytes.length / 1e6).toFixed(1)} MB), placed by ${checks.length + refs.length} marks (the marks' own fit: median ${(med(resid) * FT).toFixed(1)} ft).`);
}

/** Where the phone's tracking jumped, from the walk's track: more than a metre between two poses, faster than anyone
 *  walks (6 m a second). -> the odometer readings (m walked). */
export function jumpsOf(dir) {
  const out = [];
  let q = null;
  for (const f of readdirSync(dir).filter((x) => /^track-\d{4}\.bin$/.test(x)).sort()) {
    const b = readFileSync(join(dir, f));
    for (const r of readTrack(b.buffer.slice(b.byteOffset, b.byteOffset + Math.floor(b.byteLength / 4) * 4))) {
      if (r.tracking !== 'normal') continue;
      if (q) { const d = Math.hypot(r.pos.x - q.pos.x, r.pos.y - q.pos.y, r.pos.z - q.pos.z), dt = Math.max(0.001, r.t - q.t); if (d > 1 && dt < 1.5 && d / dt > 6) out.push({ odo: r.odo, m: d }); }
      q = r;
    }
  }
  return out;
}

/* THE MAP'S REFERENCE MADE AFRESH FROM ONE GOOD WALK (2026-11-22). The owner's lot's reference had taken in a walk
   placed by a corner marked 20 ft from its place (2026-11-20), and the next walk matched to it was moved 675 in. The
   goal's rule: a reference is overwritten "only... if there's a high degree of confidence that the new info is
   actually better." So this is for a walk that has earned it, and it refuses any other:
     - three roof corners or more, ALL agreeing with the map after their one best fit (refkeep.js goodPart, nothing
       left out);
     - the walk's start left out, up to the cut the places seen twice gave (start.json, view.json: mend_study.py);
     - the walk is NOT cut at the phone's one-frame steps: on the walk this was built for they were the phone putting
       itself right (docs/SCAN-PLAN.md 48).
   The reference it replaces is kept as a backup. Counts and distances only. */
async function fresh(dir) {
  const meta = readJson(dir, 'meta.json') || {}, live = readJson(dir, 'live.json') || {};
  if (!meta.map) throw new Error('the walk has no map');
  const plan = keepPlan(live.marks || [], []), g = plan.g;
  const corners = new Set((plan.use || []).map((m) => m.id)).size;
  if (!plan.ok || !plan.agree || corners < 3) throw new Error(`not good enough to replace a reference: ${!plan.ok ? plan.why : corners < 3 ? `${corners} corners place it, three wanted` : `${g.left?.length || 0} of its corners disagree with the others`}`);
  console.log(`Its corners: ${corners} agree within ${(g.worstM * 39.37).toFixed(0)} in after one fit${g.T?.s && g.T.s !== 1 ? ` (the phone's distances scaled ${((g.T.s - 1) * 100).toFixed(1)}% to the map's)` : ''}.`);
  // the start cut, seconds -> metres walked, by the track
  const cutS = Math.max(0, ...['start.json', 'view.json'].map((f) => Number(readJson(dir, f)?.startCutS) || 0));
  let cutOdo = 0;
  if (cutS > 0) {
    for (const f of readdirSync(dir).filter((x) => /^track-\d{4}\.bin$/.test(x)).sort()) {
      const b = readFileSync(join(dir, f));
      for (const r of readTrack(b.buffer.slice(b.byteOffset, b.byteOffset + Math.floor(b.byteLength / 4) * 4))) if (r.t <= cutS && Number.isFinite(r.odo)) cutOdo = Math.max(cutOdo, r.odo);
    }
  }
  const all = twinPoints(dir);
  const pts = { stand: all.stand.filter((p) => p[3] >= cutOdo), ground: all.ground.filter((p) => p[3] >= cutOdo) };
  console.log(`The walk: ${all.stand.length} standing and ${all.ground.length} ground points; its start left out up to ${(cutS / 60).toFixed(1)} min (${Math.round(cutOdo * FT)} ft walked): ${pts.stand.length} and ${pts.ground.length} kept.`);
  if (pts.stand.length < 200) throw new Error(`too little of the yard (${pts.stand.length} standing points)`);
  const ps = placeWalk(pts.stand, plan.use, plan.C, []), pg = placeWalk(pts.ground, plan.use, plan.C, []);
  const u = updateRef(null, { stand: ps.pts, ground: pg.pts }, { C: AS_IS, F: null, w: g.n, phone: g.T?.s && g.T.s !== 1 ? g.T.s : null });
  if (!u.ref) throw new Error(u.why);
  const key = `refs/${meta.map}.bin`;
  const oldBytes = await readObject(BUCKET, key).catch(() => null), old = oldBytes ? decodeRef(oldBytes) : null;
  if (old) {
    // how the walk sits on the reference it would replace: said, never used
    const f = shapeFix(old, pts);
    console.log(`The reference it replaces: ${old.stand.length / 3} standing and ${old.ground.length / 3} ground points from ${old.walks} walk${old.walks === 1 ? '' : 's'}. This walk matched to its shape: ${f.ok ? `yes (landed ${f.landed}, next best ${f.second})` : `no (${f.why})`}.`);
  } else console.log('No reference was kept for this map before.');
  if (process.env.DRY) { console.log('A dry run: nothing written.'); return; }
  if (oldBytes) await writeObject(BUCKET, `refs/backup/${meta.map}-${Date.now()}.bin`, oldBytes, 'application/octet-stream');
  const bytes = encodeRef(u.ref);
  await writeObject(BUCKET, key, bytes, 'application/octet-stream', { walk: String(meta.walk || '') });
  console.log(`Reference MADE AFRESH from this walk alone: ${u.ref.stand.length / 3} standing and ${u.ref.ground.length / 3} ground points (${(bytes.length / 1e6).toFixed(1)} MB), the phone's scale kept with it ${Number.isFinite(u.ref.phone) ? `${((u.ref.phone - 1) * 100).toFixed(1)}%` : 'none'}${oldBytes ? '; the one it replaced is kept as a backup' : ''}.`);
}

/* KEEP WHAT IS GOOD (lib/refkeep.js; the owner, 2026-11-15): the part of the walk its agreeing marks vouch for, added
   to the map's reference, correcting it where this walk saw the yard. Counts and distances only. */
async function keep(dir) {
  const meta = readJson(dir, 'meta.json') || {}, live = readJson(dir, 'live.json') || {};
  // a walk begun before the page had its map (2026-11-24) names none: MAP_FROM is the twin of a walk on the same map
  if (!meta.map && process.env.MAP_FROM) { meta.map = (readJson(process.env.MAP_FROM, 'meta.json') || {}).map; if (meta.map) console.log('The walk names no map: its map taken from the other walk given.'); }
  if (!meta.map) throw new Error('the walk has no map');
  const jumps = jumpsOf(dir);
  console.log(`The walk's marks: ${(live.marks || []).length}; the phone's tracking jumped ${jumps.length} time${jumps.length === 1 ? '' : 's'}${jumps.length ? ` (${jumps.map((j) => `${(j.m * FT).toFixed(1)} ft at ${Math.round(j.odo * FT)} ft walked`).join(', ')})` : ''}.`);
  for (const m of live.marks || []) console.log(`  mark at ${Math.round((m.odo || 0) * FT)} ft walked${m.by ? ` (${m.by})` : ''}, its corner's own allowance ${Number.isFinite(m.tol) ? `${(m.tol * FT).toFixed(1)} ft` : 'not recorded'}`);
  /* HOW FAR APART, WALKED AND ON THE MAP (2026-11-16: "no two of the 3 marks agree with the map to 1.5 ft"): for each
     pair of the last mark of each corner, the distance between them as the phone walked it and as the lidar outline
     has it. A distance, never a place. */
  {
    const last = new Map(); for (const m of live.marks || []) if (m?.ar && m?.map) last.set(m.id, m);
    const L = [...last.values()], d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const w = d(L[i].ar, L[j].ar), mp = d(L[i].map, L[j].map);
      console.log(`  corners ${i + 1} and ${j + 1}: ${(w * FT).toFixed(1)} ft apart as walked, ${(mp * FT).toFixed(1)} ft on the map's outline: ${((w - mp) * FT).toFixed(1)} ft ${w > mp ? 'longer' : 'shorter'} on the ground (${(100 * (w - mp) / mp).toFixed(1)}%)`);
    }
  }
  /* EVERY WALK IS KEPT (refkeep.js keepPlan, as the page does it since 2026-11-16): the whole walk, each part placed
     by the roof corners sighted nearest it; corners that disagree no longer stop it. */
  const plan = keepPlan(live.marks || [], jumps.map((j) => j.odo));
  const g = plan.g;
  const pts = twinPoints(dir);
  console.log(`Its corners: ${plan.ok ? `${new Set(plan.use.map((m) => m.id)).size} place the walk (${plan.use.length} marks)` : `none can (${plan.why})`}; ${g.ok ? `${g.n} agree within ${(g.worstM * 39.37).toFixed(0)} in${g.left.length ? `, ${g.left.length} left out` : ''}${g.T?.s && g.T.s !== 1 ? `, the phone's distances scaled ${((g.T.s - 1) * 100).toFixed(1)}% to the map's` : ''}` : `they do not agree (${g.why}): each part of the walk placed by the corners sighted nearest it`}. `
    + `The whole walk: ${pts.stand.length} standing points, ${pts.ground.length} ground points.`);
  if (pts.stand.length < 200) throw new Error(`too little of the yard (${pts.stand.length} standing points)`);
  const key = `refs/${meta.map}.bin`;
  const oldBytes = await readObject(BUCKET, key).catch(() => null), old = oldBytes ? decodeRef(oldBytes) : null;
  // the walk on the saved shape, when there is one and the match holds (walkref.js shapeFix): the shape and where it
  // is are kept apart (refkeep.js updateRef)
  let F = null;
  const J = jumps.map((j) => j.odo);
  if (old) {
    const f = shapeFix(old, pts), usable = !plan.ok || matchUsable(plan, J);
    if (f.ok && usable) F = f.T;
    console.log(`Matched to the saved shape: ${f.ok ? `yes (landed ${f.landed}, next best ${f.second})${usable ? '' : `, but not used: the walk ${J.length ? 'jumped' : 'drifted'}, so its corners place it, stretch by stretch`}` : `no (${f.why})`}.`);
  }
  if (!plan.ok && !F) throw new Error(`nothing places this walk: ${plan.why}, and no match to a saved shape`);
  // only what its corners vouch for (the page's own rule since 2026-11-22: app.js keepReference)
  // and only a walk that came back to itself, where it gives a reading (refkeep.js closingOf)
  { const c = closingOf(live.marks || [], live.pins || []); if (c) console.log(`Its own closing: ${(c.m * 39.37).toFixed(0)} in out at ${c.by}, after ${Math.round(c.walkedM * FT)} ft of walking.`); if (c && c.m > CLOSE_M) throw new Error('not put into the reference: the walk did not come back to itself'); }
  if (!F && !g.ok) throw new Error(`not put into the reference: ${g.why}`);
  const ps = F ? null : placeWalk(pts.stand, plan.use, plan.C, J), pg = F ? null : placeWalk(pts.ground, plan.use, plan.C, J);
  if (!F && ps.left + pg.left) console.log(`Not placed: ${ps.left + pg.left} points seen after a tracking jump with no corners sighted after it.`);
  const part = F ? pts : { stand: ps.pts, ground: pg.pts };
  if (part.stand.length < 200) throw new Error(`too little of the yard could be placed (${part.stand.length} standing points)`);
  const u = updateRef(old, part, { C: F ? (plan.ok && g.ok ? plan.C : null) : AS_IS, F, w: plan.agree ? g.n : 1, phone: plan.agree && g.T?.s && g.T.s !== 1 ? g.T.s : null });
  if (process.env.DRY) { console.log(`A dry run: nothing written (it would be: ${u.ref ? u.how : `refused, ${u.why}`}).`); return; }
  if (!u.ref) throw new Error(u.why);
  if (oldBytes) await writeObject(BUCKET, `refs/backup/${meta.map}-${Date.now()}.bin`, oldBytes, 'application/octet-stream');
  const bytes = encodeRef(u.ref);
  await writeObject(BUCKET, key, bytes, 'application/octet-stream', { walk: String(meta.walk || '') });
  console.log(`Reference: ${u.how}. ${u.added} points from this walk${old ? `, ${u.replaced} earlier ones corrected, ${u.kept} kept; where the shape sits on the map moved ${(u.movedM * 39.37).toFixed(0)} in (${u.ref.seen.length} readings)` : ''}; `
    + `now ${u.ref.stand.length / 3} standing and ${u.ref.ground.length / 3} ground points (${(bytes.length / 1e6).toFixed(1)} MB), from ${u.ref.walks} walk${u.ref.walks === 1 ? '' : 's'}.`);
}

/* WALKREF_VARIANTS="cell,step;cell,step": the fix tried with other search cells (m) and turn steps (degrees) too. */
const variants = () => (process.env.WALKREF_VARIANTS || '').split(';').map((x) => x.split(',').map(Number)).filter((v) => v.length === 2 && v.every((n) => n > 0));

/* The live fix as it ran on the phone (live.json prev, scan/public/app.js prevKept): how often it was asked, when it
   first placed the walk, why it last refused, and where its last fix put the walk's own check marks. */
function liveFix(dirs) {
  for (const d of dirs) {
    const live = readJson(d, 'live.json') || {}, meta = readJson(d, 'meta.json') || {}, P = live.prev;
    const name = meta.walk || d;
    if (!P) { console.log(`  ${name}: no live fix kept (a walk from before the live fix, or no reference for its map)`); continue; }
    if (P.reference === false || P.why) { console.log(`  ${name}: the earlier walk was not used (${P.why || 'the page had no reference; why was not recorded before 2026-11-10'})`); if (!P.fix) continue; }
    const { checks, T } = marksOf(d);
    let at = '';
    if (P.fix?.T && checks.length) {
      const e = checks.map((c) => { const p = place(P.fix.T, ...c.ar); return Math.hypot(p[0] - c.map[0], p[1] - c.map[1]) * FT; });
      at = `; its last fix put the walk's ${checks.length} check marks ${med(e).toFixed(1)} ft from where they were placed (${e.map((x) => x.toFixed(1)).join(', ')})`;
      if (T) { const turn = Math.abs(((P.fix.T.theta - T.theta + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * 180 / Math.PI; at += `, turned ${turn.toFixed(1)} degrees from the marks' own fit`; }
    }
    console.log(`  ${name}: live fix asked ${P.asks ?? '-'} times, placed ${P.ok ?? '-'} (first after ${P.firstOkM ?? '-'} m walked; last ${P.lastMs ?? '-'} ms)`
      + `${P.fix ? `, last landed ${P.fix.landed} (next best ${P.fix.second}) after ${P.fix.walkedM} m` : ''}${P.lastWhy ? `; last refusal: ${P.lastWhy}` : ''}${at}.`);
  }
}

function check(dirs) {
  console.log('The live fix as it ran on the phone:');
  liveFix(dirs);
  const walks = dirs.map((d) => ({ d, meta: readJson(d, 'meta.json') || {}, pts: twinPoints(d), ...marksOf(d) })).filter((w) => w.T && w.checks.length >= 3);
  console.log(`The page's own shape fix (scan/lib/walkref.js) on ${walks.length} walks; each placement scored on the placed walk's own check marks.`);
  const errs = (w, T) => w.checks.map((c) => { const p = place(T, ...c.ar); return Math.hypot(p[0] - c.map[0], p[1] - c.map[1]) * FT; });
  const meds = [];
  for (const r of walks) {
    const ref = buildRef(r.pts, r.T);
    for (const w of walks) {
      if (w === r || (r.meta.map && w.meta.map && r.meta.map !== w.meta.map)) continue;
      for (const [cell, step] of variants()) {
        const g = shapeFix(ref, w.pts, { cell, step, gate: 0, standGate: 0 });
        const eg = g.T ? errs(w, g.T) : [];
        console.log(`    (search ${cell} m, ${step} degrees: landed ${g.landed ?? '-'} (standing ${g.standLanded ?? '-'}), next best ${g.second ?? '-'}, ${g.ms ?? '-'} ms: ${eg.length ? `${med(eg).toFixed(1)} ft` : g.why})`);
      }
      const f = shapeFix(ref, w.pts);
      const e = f.T ? errs(w, f.T) : [];
      const own = errs(w, fitRigid(w.checks.map((m) => m.ar), w.checks.map((m) => m.map)));
      const aims = f.T ? aimToAim(r, w, f.T) : [], aimsOwn = w.T ? aimToAim(r, w, w.T) : [];
      if (aimsOwn.length) console.log(`    aim to aim (${aimsOwn.length} spots aimed at in both walks, no photo in it): the shape fix ${aims.length ? `${med(aims).toFixed(1)} ft (${aims.map((x) => x.toFixed(1)).join(', ')})` : '-'}; the two walks' own marks ${med(aimsOwn).toFixed(1)} ft`);
      console.log(`  ${w.meta.walk || w.d} placed by ${r.meta.walk || r.d}: ${f.ok ? 'PLACED' : 'not placed'} (landed ${f.landed ?? '-'}, standing ${f.standLanded ?? '-'}, next best ${f.second ?? '-'}, ${f.ms ?? '-'} ms): `
        + `${e.length ? `${med(e).toFixed(1)} ft (${e.map((x) => x.toFixed(1)).join(', ')})` : f.why}; its own marks' fit ${med(own).toFixed(1)} ft`);
      if (f.ok) meds.push(med(e));
    }
  }
  console.log(`Placed ${meds.length}; median of their medians ${meds.length ? med(meds).toFixed(1) : '-'} ft.`);
}

/* WALK 2 BY THE REFERENCE, SCORED BY ITS OWN CORNERS (2026-11-22; the goal: walk 2 on "uses the shapes from the
   reference to track to orient the user"). Each walk given is matched to its map's SAVED reference by its shape alone
   (walkref.js shapeFix, the page's own), and where that puts the walk's marked roof corners is set against where the
   map has them. The corners take no part in the match: they are the judge. Also with only the walk's first stretch,
   since a live fix has to land early. A walk that is itself the reference's source says nothing: it is marked. */
async function against(dirs) {
  const first = readJson(dirs[0], 'meta.json') || {};
  if (!first.map) throw new Error('the first walk has no map');
  const bytes = await readObject(BUCKET, `refs/${first.map}.bin`).catch(() => null);
  if (!bytes) throw new Error('no reference is kept for this map');
  const ref = decodeRef(bytes);
  console.log(`WALKS MATCHED TO THEIR MAP'S SAVED REFERENCE (${ref.stand.length / 3} standing, ${ref.ground.length / 3} ground points, from ${ref.walks} walk${ref.walks === 1 ? '' : 's'}), judged by their own roof corners:`);
  const P = ref.P && (ref.P.theta || ref.P.tx || ref.P.ty) ? ref.P : null;
  const onMap = (T, ar) => { const p = place(T, ...ar); return P ? place({ ...P, s: 1 }, ...p) : p; };
  for (const d of dirs) {
    const meta = readJson(d, 'meta.json') || {}, live = readJson(d, 'live.json') || {};
    if (meta.map !== first.map) { console.log(`  walk ${meta.walk || d}: another map, left out.`); continue; }
    const last = new Map(); for (const m of live.marks || []) if (m?.ar && m?.map && m.kind === 'ref') last.set(m.id, m);
    const marks = [...last.values()], pts = twinPoints(d);
    const g = keepPlan(live.marks || [], []).g;
    const total = Math.max(0, ...pts.stand.map((p) => p[3] || 0));
    console.log(`  walk ${meta.walk || d} (${(meta.started || '').slice(0, 10)}, ${Math.round(total * FT)} ft walked, ${marks.length} corners; its own corners ${g.ok ? `agree within ${(g.worstM * 39.37).toFixed(0)} in${g.left.length ? `, ${g.left.length} left out` : ''}` : `vouch for nothing (${g.ambiguous ? 'which is wrong cannot be told' : 'none agree'})`}):`);
    // AS THE PAGE NOW DOES, every 15 m from 60 m walked: stretched by the reference's scale, a lead over the next best,
    // a loose GPS bound when there is one, and USED only when two in a row agree (walkref.js sameFix)
    const errOf = (T) => marks.map((m) => { const p = onMap(T, m.ar); return Math.hypot(p[0] - m.map[0], p[1] - m.map[1]) * 39.37; });
    const mid = (() => { let x = 0, y = 0; for (const p of pts.stand) { x += p[0]; y += p[1]; } return pts.stand.length ? [x / pts.stand.length, y / pts.stand.length] : [0, 0]; })();
    // twice over: without a corner (from 60 m, a loose GPS bound), and WITH THE LATEST CORNER MARKED SO FAR as a pin
    // (from 15 m; the corner used as the pin is then no judge of that fix: it is shown in brackets)
    const refs = (live.marks || []).filter((m) => m?.ar && m?.map && m.kind === 'ref').sort((a, b) => a.odo - b.odo);
    // the phone's heading at a moment of the walk: Street View's own reading of how the session is turned on the map
    // (live.json geoTrail, theta with its yawAcc), the middle of the last five good ones
    const headingAt = (lim) => {
      const g = (live.geoTrail || []).filter((r) => (r.odo ?? 0) <= lim && Number.isFinite(r.theta) && Number.isFinite(r.yawAcc) && r.yawAcc <= 20).slice(-5);
      if (!g.length) return null;
      const th = Math.atan2(g.reduce((a, r) => a + Math.sin(r.theta), 0), g.reduce((a, r) => a + Math.cos(r.theta), 0));
      return { theta: th, searchDeg: Math.max(15, 2 * Math.max(...g.map((r) => r.yawAcc))) };
    };
    /* THE PAGE'S MATCH AS IT IS NOW, TO THE WALK'S END (2026-11-25): the latest corner as the pin; judged by ALL the
       other corners marked so far. Run 593: refused from 443 ft to the end though the corners sat 1-24 in out. Run
       595: bounding the turn to 15 degrees of the last used fit changed NOTHING (the same refusals to the digit), so
       the rival is a near turn, not a far one. walkref.js now asks a smaller lead of a pinned match. */
    {
      console.log('   THE LATEST CORNER AS A PIN, AS THE PAGE ASKS IT, TO THE END; judged by the other corners marked so far:');
      let before = null, used = 0, asked = 0, lastT = null; const errsUsed = [];
      for (let upTo = 30; ; upTo += 15) {
        const last = upTo >= total, lim = last ? total : upTo;
        const pinM = refs.filter((m) => m.odo <= lim).pop();
        if (!pinM) { if (last) break; continue; }
        const part = { stand: pts.stand.filter((p) => (p[3] || 0) <= lim), ground: pts.ground.filter((p) => (p[3] || 0) <= lim) };
        const f = shapeFix(ref, part, { prior: { pin: { ar: pinM.ar, map: pinM.map }, searchM: 1.5 } });
        asked++;
        const judges = refs.filter((m) => m.id !== pinM.id && m.odo <= lim);
        const e = f.T ? judges.map((m) => { const p = onMap(f.T, m.ar); return Math.hypot(p[0] - m.map[0], p[1] - m.map[1]) * 39.37; }) : [];
        const confirmed = f.ok && before && sameFix(before, f.T, mid);
        if (confirmed) { used++; lastT = f.T; errsUsed.push(...e); }
        console.log(`    at ${Math.round(lim * FT)} ft: ${f.ok ? (confirmed ? 'USED' : 'a match, waiting') : f.T ? `refused (${f.why || ''})` : 'nothing'}${f.landed != null ? `, landed ${f.landed}, next best ${f.second ?? '-'}` : ''}${e.length ? `; the other corners ${e.map((x) => `${x.toFixed(0)} in`).join(', ')}` : ''}`);
        before = f.ok ? f.T : null;
        if (last) break;
      }
      console.log(`    -> asked ${asked}, used ${used}; the other corners under the USED ones: ${errsUsed.length ? `middle ${med(errsUsed).toFixed(0)} in, worst ${Math.max(...errsUsed).toFixed(0)} in (${errsUsed.length})` : 'none to judge'}.`);
    }
    if (process.env.REF_FULL) for (const withPin of [false, true, 'heading']) {
      console.log(`   ${withPin === 'heading' ? 'WITH ONE CORNER AND THE PHONE\'S OWN HEADING (Street View\'s), from 49 ft to 394 ft:' : withPin ? 'WITH ONE CORNER (the latest marked so far) as a pin, from 49 ft to 394 ft:' : 'WITHOUT a corner, from 197 ft:'}`);
      let before = null, used = 0, usedBad = 0, firstUsed = null;
      for (let upTo = withPin ? 15 : 60; ; upTo += 15) {
        const last = upTo >= total;
        const lim = last ? Infinity : upTo;
        const within = (g) => (g.odo ?? 0) <= lim;
        const pinM = withPin ? refs.filter((m) => m.odo <= lim).pop() : null;
        if (withPin && !pinM) { if (last) break; continue; }
        const part = { stand: pts.stand.filter((p) => (p[3] || 0) <= lim), ground: pts.ground.filter((p) => (p[3] || 0) <= lim) };
        const prior = walkPrior((live.gpsTrail || []).filter(within), (live.geoTrail || []).filter(within));
        const hd = withPin === 'heading' ? headingAt(lim) : null;
        if (withPin === 'heading' && !hd) { if (last || upTo >= 120) break; continue; }
        const loose = pinM ? { pin: { ar: pinM.ar, map: pinM.map }, searchM: 1.5, ...(hd || {}) } : prior ? { T: prior.T, searchM: Math.max(15, 2 * prior.searchM), searchDeg: Math.max(25, 2 * prior.searchDeg) } : null;
        const f = shapeFix(ref, part, loose ? { prior: loose } : {});
        const judges = marks.filter((m) => !pinM || m.id !== pinM.id);
        const e = f.T ? judges.map((m) => { const p = onMap(f.T, m.ar); return Math.hypot(p[0] - m.map[0], p[1] - m.map[1]) * 39.37; }) : [];
        const confirmed = f.ok && before && sameFix(before, f.T, mid);
        if (confirmed) { used++; if (firstUsed == null) firstUsed = last ? total : upTo; if (e.length && Math.min(...e) > 60) usedBad++; }
        console.log(`    at ${last ? `its end (${Math.round(total * FT)} ft)` : `${Math.round(upTo * FT)} ft`}: ${f.ok ? (confirmed ? 'USED (two alike)' : 'a match, waiting for the next to agree') : f.T ? 'refused' : 'nothing'}${f.landed != null ? ` (landed ${f.landed}, next best ${f.second ?? '-'}${loose ? '' : ', no GPS yet'})` : ''}${e.length ? `: the other corners ${e.map((x) => x.toFixed(0)).join(', ')} in out` : f.why ? `: ${f.why}` : ''}`);
        before = f.ok ? f.T : null;
        if (last || (withPin && upTo >= 120)) break;
      }
      console.log(`    -> used ${used} time${used === 1 ? '' : 's'}${used ? `, first at ${Math.round(firstUsed * FT)} ft, ${usedBad} of them with every judging corner over 5 ft out` : ''}.`);
    }
    /* THE WHOLE WALK, AND ONLY ITS LAST STRETCH (2026-11-25; the owner: "I remarked r3 a handful of times because it
       drifted several times... the shape fixing to the reference walk should've corrected it"). The page matches ALL
       the walk's points so far as one rigid shape; after the tracking has slid, the early points and the late ones are
       no longer one shape, and one placement cannot be right for both. Here the same match every 15 m to the walk's
       end, with the latest corner as the pin as the page has it: on everything so far, and on only the last WIN m
       walked. THE JUDGE is the corner marks made in the last 60 m (the pin's own mark left out): where the phone
       was just then, which is what a live fix is for. */
    if (process.env.REF_FULL) for (const WIN of [0, 60, 30]) {
      console.log(`   ${WIN ? `ONLY THE LAST ${Math.round(WIN * FT)} ft WALKED` : 'EVERYTHING SO FAR'}, the latest corner as a pin, to the walk's end; judged by the corners marked in the last 197 ft:`);
      let before = null, used = 0, asked = 0; const errs = [], errsUsed = [];
      for (let upTo = 30; ; upTo += 15) {
        const last = upTo >= total, lim = last ? total : upTo;
        const pinM = refs.filter((m) => m.odo <= lim).pop();
        if (!pinM) { if (last) break; continue; }
        const inWin = (p) => (p[3] || 0) <= lim && (!WIN || (p[3] || 0) > lim - WIN);
        const part = { stand: pts.stand.filter(inWin), ground: pts.ground.filter(inWin) };
        const f = shapeFix(ref, part, { prior: { pin: { ar: pinM.ar, map: pinM.map }, searchM: 1.5 } });
        asked++;
        const judges = refs.filter((m) => m !== pinM && m.odo <= lim && m.odo > lim - 60);
        const e = f.T ? judges.map((m) => { const p = onMap(f.T, m.ar); return Math.hypot(p[0] - m.map[0], p[1] - m.map[1]) * 39.37; }) : [];
        const confirmed = f.ok && before && sameFix(before, f.T, mid);
        if (f.ok) errs.push(...e);
        if (confirmed) { used++; errsUsed.push(...e); }
        console.log(`    at ${Math.round(lim * FT)} ft (${part.stand.length} standing points): ${f.ok ? (confirmed ? 'USED' : 'a match, waiting') : f.T ? `refused (${f.why || ''})` : 'nothing'}${f.landed != null ? `, landed ${f.landed}, next best ${f.second ?? '-'}` : ''}${e.length ? `; recent corners ${e.map((x) => `${x.toFixed(0)} in`).join(', ')}` : ''}`);
        before = f.ok ? f.T : null;
        if (last) break;
      }
      console.log(`    -> asked ${asked}, used ${used}; recent corners under the matches: ${errs.length ? `middle ${med(errs).toFixed(0)} in, worst ${Math.max(...errs).toFixed(0)} in (${errs.length})` : 'none to judge'}; under the USED ones: ${errsUsed.length ? `middle ${med(errsUsed).toFixed(0)} in, worst ${Math.max(...errsUsed).toFixed(0)} in (${errsUsed.length})` : 'none to judge'}.`);
    }
  }
}

/* DO THE PHONE'S LABELS HELP THE SHAPE FIX? (2026-11-25; the owner: "the reference can also use the arcore scene
   semantics as another signal to match for a fix"). The first walk given is made a reference here, by its own roof
   corners, each standing point keeping its kind (building, tree, structure). The second is matched to it every 15 m
   as the page does (the latest corner a pin), twice: by shape alone, and with a standing point landing only on its
   own kind. Judged by the second walk's other corners. Nothing is kept. */
async function labels(dirs) {
  const [rd, wd] = dirs;
  const rl = readJson(rd, 'live.json') || {}, g0 = keepPlan(rl.marks || [], []).g;
  if (!g0.ok || !g0.T) throw new Error('the first walk\'s corners do not place it');
  const rp = twinPoints(rd);
  const seen = new Map();
  for (const p of rp.stand) { const k = `${Math.floor(p[0] / 0.2)},${Math.floor(p[1] / 0.2)},${Math.floor(p[2] / 0.2)}`; if (!seen.has(k)) seen.set(k, p); }
  const sp = [...seen.values()], stand = new Float32Array(sp.length * 3), standK = new Uint8Array(sp.length);
  sp.forEach((p, i) => { const [e, n] = place(g0.T, p[0], p[1]); stand[i * 3] = e; stand[i * 3 + 1] = n; stand[i * 3 + 2] = p[2]; standK[i] = p[4] || 0; });
  const plain = buildRef({ stand: [], ground: rp.ground }, g0.T);
  const ref = { stand, ground: plain.ground };
  const share = (k) => Math.round((100 * standK.filter((x) => x === k).length) / Math.max(1, standK.length));
  console.log(`DO THE PHONE'S LABELS HELP THE SHAPE FIX? The reference made here from the first walk: ${sp.length} standing points (building ${share(1)}%, tree ${share(2)}%, structure ${share(3)}%, not known ${share(0)}%), ${ref.ground.length / 3} ground.`);
  const live = readJson(wd, 'live.json') || {}, pts = twinPoints(wd);
  const refs = (live.marks || []).filter((m) => m?.ar && m?.map && m.kind === 'ref').sort((a, b) => a.odo - b.odo);
  const total = Math.max(0, ...pts.stand.map((p) => p[3] || 0));
  const mid = (() => { let x = 0, y = 0; for (const p of pts.stand) { x += p[0]; y += p[1]; } return pts.stand.length ? [x / pts.stand.length, y / pts.stand.length] : [0, 0]; })();
  for (const withK of [false, true]) {
    console.log(`   ${withK ? 'A STANDING POINT LANDS ONLY ON ITS OWN KIND' : 'BY SHAPE ALONE'} (the latest corner a pin); judged by the other corners marked so far:`);
    const R = withK ? { ...ref, standK } : ref;
    let before = null, used = 0, asked = 0; const errsUsed = [], leads = [];
    for (let upTo = 30; ; upTo += 15) {
      const last = upTo >= total, lim = last ? total : upTo;
      const pinM = refs.filter((m) => m.odo <= lim).pop();
      if (!pinM) { if (last) break; continue; }
      const part = { stand: pts.stand.filter((p) => (p[3] || 0) <= lim), ground: pts.ground.filter((p) => (p[3] || 0) <= lim) };
      const f = shapeFix(R, part, { prior: { pin: { ar: pinM.ar, map: pinM.map }, searchM: 1.5 } });
      asked++;
      const e = f.T ? refs.filter((m) => m.id !== pinM.id && m.odo <= lim).map((m) => { const p = place(f.T, ...m.ar); return Math.hypot(p[0] - m.map[0], p[1] - m.map[1]) * 39.37; }) : [];
      const confirmed = f.ok && before && sameFix(before, f.T, mid);
      if (confirmed) { used++; errsUsed.push(...e); }
      if (f.landed != null && f.second != null) leads.push(f.second / f.landed);
      console.log(`    at ${Math.round(lim * FT)} ft: ${f.ok ? (confirmed ? 'USED' : 'a match, waiting') : f.T ? `refused (${f.why || ''})` : 'nothing'}${f.landed != null ? `, landed ${f.landed}, next best ${f.second ?? '-'}` : ''}${e.length ? `; the other corners ${e.map((x) => `${x.toFixed(0)} in`).join(', ')}` : ''}`);
      before = f.ok ? f.T : null;
      if (last) break;
    }
    console.log(`    -> asked ${asked}, used ${used}; the next best as a share of the best, middle ${leads.length ? med(leads).toFixed(2) : '-'}; the other corners under the USED ones: ${errsUsed.length ? `middle ${med(errsUsed).toFixed(0)} in, worst ${Math.max(...errsUsed).toFixed(0)} in (${errsUsed.length})` : 'none to judge'}.`);
  }
}

/* THE REFERENCE A WALK REPLACED, PUT BACK (2026-11-25). The owner's walk of 2026-11-24 22:04 began before the page had
   its map and at its end replaced the map's reference as though "fresh" had been chosen. The owner: the reference is
   "the accumulation of every walk". This says what the map's reference and its backups hold (when saved, how many
   walks, when each walk's reading of its place was taken), and unless DRY puts the NEWEST backup back as the
   reference, the one it displaces kept as a backup in its turn. Walks are then added with `keep`. Times and counts. */
async function restore(dir) {
  const meta = readJson(dir, 'meta.json') || {};
  if (!meta.map) throw new Error('the walk has no map');
  const token = process.env.CLOUDFLARE_API_TOKEN, base = `${API}/accounts/${await account(token)}/r2/buckets/${BUCKET}`;
  const pre = `refs/backup/${meta.map}-`;
  const olds = (await list(base, token, pre)).filter((o) => o.key.startsWith(pre) && /^\d+\.bin$/.test(o.key.slice(pre.length))).sort((a, b) => Number(b.key.slice(pre.length, -4)) - Number(a.key.slice(pre.length, -4)));
  const say = (name, r, bytes) => console.log(`  ${name}: ${r ? `${r.stand.length / 3} standing and ${r.ground.length / 3} ground points, ${(bytes.length / 1e6).toFixed(1)} MB, from ${r.walks} walk${r.walks === 1 ? '' : 's'}; made ${new Date(r.at || 0).toISOString().slice(0, 16)}; its place read ${r.seen.length} time${r.seen.length === 1 ? '' : 's'}${r.seen.length ? ` (${r.seen.map((o) => new Date(o.at || 0).toISOString().slice(5, 16)).join(', ')})` : ''}` : 'could not be read'}`);
  const key = `refs/${meta.map}.bin`;
  const nowBytes = await readObject(BUCKET, key).catch(() => null);
  console.log(`THE MAP'S REFERENCE AND ITS BACKUPS (${olds.length} backups; times UTC):`);
  say('the reference now', nowBytes ? decodeRef(nowBytes) : null, nowBytes || []);
  let first = null;
  for (const o of olds.slice(0, 6)) {
    const b = await readObject(BUCKET, o.key).catch(() => null);
    if (!first) first = b;
    say(`backup, saved ${new Date(Number(o.key.slice(pre.length, -4))).toISOString().slice(0, 16)}`, b ? decodeRef(b) : null, b || []);
  }
  if (!first || !decodeRef(first)) { console.log('No backup to put back.'); return; }
  if (process.env.DRY) { console.log('A dry run: nothing written.'); return; }
  if (nowBytes) await writeObject(BUCKET, `refs/backup/${meta.map}-${Date.now()}.bin`, nowBytes, 'application/octet-stream');
  await writeObject(BUCKET, key, first, 'application/octet-stream', { walk: 'restored' });
  console.log('The newest backup is the reference again; the one it displaced is kept as a backup.');
}

/* ------------------------------------------------------------------ the reference as every walk, counted */
/** A walk's twin, read for the reference: its points, corners, jumps, map. */
/* (2026-11-25, run 604) THE TRACK'S "JUMPS" ARE NOT USED: the page never cuts a walk at them (L.jumps is never set), and
   on the walk of 2026-11-20 the steps jumpsOf finds were the page's stalls, which taking back made worse (section 59);
   cut at them, two thirds of that walk had no corner of its own and was left out. JUMPS=1 uses them. The walk's
   start is cut as `fresh` cuts it (start.json, view.json). Only the corners that agree with each other (goodPart)
   place, pin or judge a walk: the walk of 2026-11-20 holds a mark 20 ft from its corner. */
function walkOf(d, mapFallback) {
  const meta = readJson(d, 'meta.json') || {}, live = readJson(d, 'live.json') || {};
  const jumps = process.env.JUMPS ? jumpsOf(d).map((j) => j.odo) : [];
  const g = keepPlan(live.marks || [], jumps).g, left = new Set(g?.ok ? g.left : []);
  const marks = (live.marks || []).filter((m) => !left.has(m.id));
  const cutS = Math.max(0, ...['start.json', 'view.json'].map((f) => Number(readJson(d, f)?.startCutS) || 0));
  let cutOdo = 0;
  if (cutS > 0) for (const f of readdirSync(d).filter((x) => /^track-\d{4}\.bin$/.test(x)).sort()) {
    const b = readFileSync(join(d, f));
    for (const r of readTrack(b.buffer.slice(b.byteOffset, b.byteOffset + Math.floor(b.byteLength / 4) * 4))) if (r.t <= cutS && Number.isFinite(r.odo)) cutOdo = Math.max(cutOdo, r.odo);
  }
  const all = twinPoints(d), keep = (p) => (p[3] || 0) >= cutOdo;
  const pts = { stand: all.stand.filter(keep), ground: all.ground.filter(keep) };
  const id = String(meta.walk || d.replace(/^.*w-/, ''));
  console.log(`  (walk ${id}: ${(live.marks || []).length} corner marks, ${left.size} left out as disagreeing${g?.ok ? '' : ` (${g?.why || 'none agree'})`}; ${cutOdo ? `its start cut at ${Math.round(cutOdo * FT)} ft walked` : 'no start cut'}${process.env.JUMPS ? `; ${jumps.length} jumps used` : ''})`);
  return { d, id, map: meta.map || mapFallback || null, marks, jumps, pts, at: Number(meta.walk) || Date.now(), cornersOk: !!g?.ok };
}

/* THE REFERENCE MADE FROM WALKS, IN THE ORDER GIVEN (2026-11-25): the first placed by its own corners (it must have three
   that agree), each later one put on the shape so far a stretch at a time (placeOnShape), confirming, adding, and
   marking what it looked at and missed (refkeep.js mergeCounted); its corners give readings of where the shape is.
   -> the reference */
function buildFrom(walks, log) {
  const [w0, ...rest] = walks;
  if (!w0.cornersOk) throw new Error(`walk ${w0.id} cannot be first: its corners cannot be trusted (put a walk whose corners agree first)`);
  const plan = keepPlan(w0.marks, w0.jumps);
  if (!plan.ok) throw new Error(`walk ${w0.id}: its corners do not place it (${plan.why})`);
  const ps = placeWalk(w0.pts.stand, plan.use, plan.C, w0.jumps), pg = placeWalk(w0.pts.ground, plan.use, plan.C, w0.jumps);
  const u = updateRef(null, { stand: ps.pts, ground: pg.pts }, { C: AS_IS, w: plan.g?.n || 1, at: w0.at, phone: plan.g?.T?.s && plan.g.T.s !== 1 ? plan.g.T.s : null });
  if (!u.ref) throw new Error(`walk ${w0.id}: ${u.why}`);
  let ref = u.ref;
  const say = (r) => { const c = countsOf(r); return `${r.stand.length / 3} standing (${c.stand[0]} on one walk's word, ${c.stand[1]} on two, ${c.stand[2]} on three or more), ${r.ground.length / 3} ground`; };
  log(`  walk ${w0.id} first, by its ${new Set(plan.use.map((m) => m.id)).size} corners${plan.agree ? ` (agreeing within ${(plan.g.worstM * 39.37).toFixed(0)} in)` : ', NOT all agreeing'}${ps.left + pg.left ? `; ${ps.left + pg.left} points after a jump left out` : ''}: ${say(ref)}.`);
  for (const w of rest) {
    log(`  walk ${w.id} on the shape so far${w.cornersOk ? '' : ' (its corners cannot be trusted: held by its whole-walk match instead)'}:`);
    let T0 = null;
    if (!w.cornersOk) {
      const f = shapeFix(ref, w.pts);
      if (!f.ok) { log(`    NOT ADDED: its whole-walk match failed (${f.why}).`); continue; }
      T0 = f.T;
      // its corners under that match: the shape's own word on which of them was marked wrong
      const P0 = { ...(ref.P || AS_IS), s: 1 }, last = new Map(); for (const m of w.marks) if (m?.ar && m?.map && m.kind === 'ref') last.set(m.id, m);
      const e = [...last.values()].map((m) => { const q = place(P0, ...place(f.T, ...m.ar)); return `${m.id} ${(Math.hypot(q[0] - m.map[0], q[1] - m.map[1]) * 39.37).toFixed(0)} in`; });
      log(`    its whole-walk match: landed ${f.landed}, next best ${f.second}; its corners under it (the latest mark of each): ${e.join(', ')}.`);
      if (!process.env.UNTRUSTED) { log('    NOT ADDED: nothing vouches for where its match puts it (UNTRUSTED=1 adds it, as no witness of absence).'); continue; }
    }
    const placed = placeOnShape(ref, w.pts, w.cornersOk ? w.marks : [], w.jumps, { log, T0 });
    const m = addPlaced(ref, placed, w.at, { looked: w.cornersOk });
    ref = m.ref;
    log(`    confirmed ${m.confirmed}, added ${m.added}, dropped ${m.dropped} (missed twice and more than seen); its corners gave ${placed.readings.length} readings of where the shape is, which moved it ${(m.movedM * 39.37).toFixed(0)} in. Now ${say(ref)}.`);
  }
  return ref;
}

/* THE PAGE'S LIVE MATCH REPLAYED ON A WALK AGAINST A REFERENCE (every 15 m, the latest corner a pin, two alike), judged
   by the walk's other corners. -> one line of totals */
function replayLive(ref, w, label, log) {
  const refs = w.marks.filter((m) => m?.ar && m?.map && m.kind === 'ref').sort((a, b) => a.odo - b.odo);
  const total = Math.max(0, ...w.pts.stand.map((p) => p[3] || 0));
  const mid = (() => { let x = 0, y = 0; for (const p of w.pts.stand) { x += p[0]; y += p[1]; } return w.pts.stand.length ? [x / w.pts.stand.length, y / w.pts.stand.length] : [0, 0]; })();
  const P = ref.P || AS_IS, toShape = invert({ ...P, s: 1 });
  let before = null, used = 0, asked = 0, run = 0, longest = 0; const errs = [];
  for (let upTo = 30; ; upTo += 15) {
    const last = upTo >= total, lim = last ? total : upTo;
    const pinM = refs.filter((m) => m.odo <= lim).pop();
    if (!pinM) { if (last) break; continue; }
    const part = { stand: w.pts.stand.filter((p) => (p[3] || 0) <= lim), ground: w.pts.ground.filter((p) => (p[3] || 0) <= lim) };
    const f = shapeFix(ref, part, { prior: { pin: { ar: pinM.ar, map: place(toShape, ...pinM.map) }, searchM: 1.5 } });
    asked++;
    const e = f.T ? refs.filter((m) => m.id !== pinM.id && m.odo <= lim).map((m) => { const q = place({ ...P, s: 1 }, ...place(f.T, ...m.ar)); return Math.hypot(q[0] - m.map[0], q[1] - m.map[1]) * 39.37; }) : [];
    const confirmed = f.ok && before && sameFix(before, f.T, mid);
    if (confirmed) { used++; errs.push(...e); run++; longest = Math.max(longest, run); } else run = 0;
    before = f.ok ? f.T : null;
    if (last) break;
  }
  log(`    ${label}: asked ${asked}, used ${used} (the longest run without a refusal ${longest}); the other corners under the used fits: ${errs.length ? `middle ${med(errs).toFixed(0)} in, worst ${Math.max(...errs).toFixed(0)} in` : 'none to judge'}.`);
}

/* EACH WALK AGAINST THE OTHERS (2026-11-25; the owner: "keep building mechanisms to add to the reference walk, verify
   it, and get better shape fixes"). For each walk given: the reference made from the OTHERS (buildFrom, in the order
   given), and the page's live match replayed on the walk left out, against every point of it and against only the
   points two walks or more vouch for. The walk left out is judged by its own corners, which took no part. */
async function crossval(dirs) {
  const map0 = dirs.map((d) => (readJson(d, 'meta.json') || {}).map).find(Boolean);
  const walks = dirs.map((d) => walkOf(d, map0));
  console.log(`EACH WALK AGAINST A REFERENCE MADE OF THE OTHERS (${walks.length} walks; the live match every 49 ft, the latest corner a pin, judged by the walk's other corners):`);
  for (let i = 0; i < walks.length; i++) {
    const others = walks.filter((_, j) => j !== i);
    if (!walks[i].cornersOk) { console.log(` WALK ${walks[i].id}: its corners cannot be trusted, so they cannot judge it: not left out.`); continue; }
    console.log(` WALK ${walks[i].id} LEFT OUT; the reference from ${others.map((w) => w.id).join(' then ')}:`);
    let ref;
    try { ref = buildFrom(others, (t) => console.log(t)); } catch (e) { console.log(`  could not be made: ${e.message}`); continue; }
    replayLive(ref, walks[i], 'against every point', (t) => console.log(t));
    const t = trustedRef(ref, 2, 1500);
    if (t.trusted) replayLive(t, walks[i], `against only the points two walks vouch for (${t.stand.length / 3} standing)`, (x) => console.log(x));
    else console.log('    too few points two walks vouch for to match against.');
  }
}

/* THE MAP'S REFERENCE MADE AGAIN FROM ITS WALKS, COUNTED (buildFrom), written unless DRY; the one it replaces kept as a
   backup. Every walk on the map should be given, the surest first. */
async function rebuild(dirs) {
  const map0 = dirs.map((d) => (readJson(d, 'meta.json') || {}).map).find(Boolean);
  if (!map0) throw new Error('none of the walks names a map');
  const walks = dirs.map((d) => walkOf(d, map0));
  if (walks.some((w) => w.map !== map0)) throw new Error('the walks are not all of one map');
  console.log(`THE MAP'S REFERENCE MADE AGAIN FROM ${walks.length} WALKS, EVERY POINT COUNTED:`);
  const ref = buildFrom(walks, (t) => console.log(t));
  // each walk against the finished reference: how much of it lands on points other walks vouch for
  const bytes = encodeRef(ref);
  console.log(`Made: ${(bytes.length / 1e6).toFixed(1)} MB, version 3 (the counts kept).`);
  if (process.env.DRY) { console.log('A dry run: nothing written.'); return; }
  const key = `refs/${map0}.bin`;
  const oldBytes = await readObject(BUCKET, key).catch(() => null);
  if (oldBytes) await writeObject(BUCKET, `refs/backup/${map0}-${Date.now()}.bin`, oldBytes, 'application/octet-stream');
  await writeObject(BUCKET, key, bytes, 'application/octet-stream', { walk: walks.map((w) => w.id).join(' ') });
  console.log(`Kept as the map's reference${oldBytes ? '; the one it replaced is a backup' : ''}.`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (process.argv[1]?.endsWith('reference-build.mjs')) {
  (cmd === 'build' ? build(rest[0] || 'twin') : cmd === 'keep' ? keep(rest[0] || 'twin') : cmd === 'fresh' ? fresh(rest[0] || 'twin') : cmd === 'crossval' ? crossval(rest) : cmd === 'rebuild' ? rebuild(rest) : cmd === 'restore' ? restore(rest[0] || 'twin') : cmd === 'labels' ? labels(rest) : cmd === 'against' ? against(rest) : cmd === 'check' ? Promise.resolve(check(rest)) : Promise.reject(new Error('build <dir> or check <dir> <dir>...')))
    .catch((e) => { console.log(`Reference: ${e.message}`); process.exit(1); });
}
