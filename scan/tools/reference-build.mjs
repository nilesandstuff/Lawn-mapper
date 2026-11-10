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
import { buildRef, encodeRef, shapeFix, fitRigid, place, STAND } from '../lib/walkref.js';
import { checkMarks } from '../lib/postfix.js';
import { writeObject, BUCKET } from './twin-r2.mjs';

const FT = 3.28084;
const DROP = new Set([2, 10, 11]);   // label + 1: sky, vehicle, person

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
      if (Math.abs(h) < 0.15) ground.push([x, -z, y]);
      else if (h >= STAND[0] && h <= STAND[1]) stand.push([x, -z, y]);
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

/* WALKREF_VARIANTS="cell,step;cell,step": the fix tried with other search cells (m) and turn steps (degrees) too. */
const variants = () => (process.env.WALKREF_VARIANTS || '').split(';').map((x) => x.split(',').map(Number)).filter((v) => v.length === 2 && v.every((n) => n > 0));

/* The live fix as it ran on the phone (live.json prev, scan/public/app.js prevKept): how often it was asked, when it
   first placed the walk, why it last refused, and where its last fix put the walk's own check marks. */
function liveFix(dirs) {
  for (const d of dirs) {
    const live = readJson(d, 'live.json') || {}, meta = readJson(d, 'meta.json') || {}, P = live.prev;
    const name = meta.walk || d;
    if (!P) { console.log(`  ${name}: no live fix kept (a walk from before the live fix, or no reference for its map)`); continue; }
    if (P.reference === false) { console.log(`  ${name}: its map had no reference walk`); continue; }
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

const [cmd, ...rest] = process.argv.slice(2);
if (process.argv[1]?.endsWith('reference-build.mjs')) {
  (cmd === 'build' ? build(rest[0] || 'twin') : cmd === 'check' ? Promise.resolve(check(rest)) : Promise.reject(new Error('build <dir> or check <dir> <dir>...')))
    .catch((e) => { console.log(`Reference: ${e.message}`); process.exit(1); });
}
