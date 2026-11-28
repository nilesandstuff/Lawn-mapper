/**
 * A DOWNLOADED WALK PUT ON THE MAP THROUGH THE MAP'S REFERENCE (core session, 2026-11-26). The owner, 2026-11-25: "get
 * everything aligned right and put in mechanisms to get everything aligned right as new walks come in."
 *
 * Until now each walk's plants and ground went on the map by that walk's OWN corners: one fit for the whole walk
 * (walk-fit.mjs). Two walks so placed sit apart wherever either slid (the 21:48 walk's corners sat 6 in to 3 ft 11 in
 * from their places under one fit), and on foot squares they share little (260 of 3,073 plant squares). Here the walk
 * is put on the map's reference a stretch at a time (refkeep.js placeOnShape, held by its own agreeing corners), then
 * through the reference's own place on the map: every walk so placed is in the ONE frame of the shape the walks built.
 *
 * It rewrites the twin IN THE LOCAL FOLDER (never the bucket): the points (cloud-NNNN.bin), the camera's track
 * (track-NNNN.bin) and the pictures' poses (keys-NNNN.json) are moved into the map's metres (x east, z south, y up,
 * heights stretched by the phone's scale), and fit.json says "no turn, no shift", so plants.py and surfaces.py work
 * on it unchanged. A point in no matched stretch is moved by the walk's own corners' fit when they vouch for it; else
 * it is dropped (NaN). A walk whose corners cannot be trusted is left as it was (fit.json untouched).
 *
 *   node scan/tools/twin-onref.mjs <twin dir> [reference file]     (default: the map's, from the bucket)
 *
 * Counts and distances only.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRef, place } from '../lib/walkref.js';
import { keepPlan, placeOnShape, compose } from '../lib/refkeep.js';
import { twinPoints } from './reference-build.mjs';
import { BUCKET, readObject } from './twin-r2.mjs';
import { fitOf } from './walk-fit.mjs';

const TRACK_REC = 10, FT = 3.28084;
const readJson = (d, n) => { try { return JSON.parse(readFileSync(join(d, n), 'utf8')); } catch { return null; } };

/** The similarity (turn about the vertical, shift, scale) as a 4x4 on [x, y, z, 1] in the session's axes: (u, v) =
 *  (x, -z) goes to (e, n) = s R (u, v) + t, then x' = e, z' = -n; y' = s y. Column-major like WebGL. */
export function m4Of(T) {
  const s = T.s ?? 1, c = Math.cos(T.theta) * s, n = Math.sin(T.theta) * s;
  // x' = c x + n z + tx ; z' = -(n x - c z + ty) = -n x + c z - ty ; y' = s y
  return [c, 0, -n, 0, 0, s, 0, 0, n, 0, c, 0, T.tx, 0, -T.ty, 1];
}
const mul = (A, B) => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return o; };
function inv4(m) { // general 4x4 inverse (column-major)
  const a = m, o = new Array(16);
  o[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  o[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  o[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  o[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  o[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  o[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  o[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  o[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  o[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  o[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  o[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  o[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  o[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  o[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  o[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  o[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * o[0] + a[1] * o[4] + a[2] * o[8] + a[3] * o[12];
  return o.map((v) => v / det);
}

/** (odo) -> the map similarity for that moment of the walk, or null. wins: placeOnShape's windows; P: the reference's. */
export function placerOf(wins, P, fallback = null) {
  const ok = wins.filter((w) => w.T).map((w) => ({ c: w.c, M: compose({ ...P, s: 1 }, w.T) }));
  return (odo) => {
    let best = null, bd = Infinity;
    for (const w of ok) { const d = Math.abs(w.c - odo); if (d < bd) { bd = d; best = w; } }
    return best && bd <= 30 ? best.M : fallback;
  };
}

export function moveTwin(dir, at) {
  let pts = 0, dropped = 0;
  for (const f of readdirSync(dir).filter((x) => /^cloud-\d{4}\.bin$/.test(x))) {
    const b = readFileSync(join(dir, f)), a = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + Math.floor(b.byteLength / 24) * 24));
    for (let i = 0; i + 5 < a.length; i += 6) {
      const T = at(a[i + 1]);
      if (!T) { a[i + 2] = a[i + 3] = a[i + 4] = NaN; dropped++; continue; }
      const s = T.s ?? 1, [e, n] = place(T, a[i + 2], -a[i + 4]);
      a[i + 2] = e; a[i + 4] = -n; a[i + 3] *= s; a[i + 5] *= s; pts++;
    }
    writeFileSync(join(dir, f), Buffer.from(a.buffer));
  }
  // the camera's track, and each picture's pose (by its own odometer reading, else the track's nearest in time)
  const track = [];
  for (const f of readdirSync(dir).filter((x) => /^track-\d{4}\.bin$/.test(x))) {
    const b = readFileSync(join(dir, f)), a = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + Math.floor(b.byteLength / 4) * 4));
    for (let i = 0; i + TRACK_REC <= a.length; i += TRACK_REC) {
      const T = at(a[i + 1]);
      track.push([a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4]]);   // as it was, for the pictures' convention below
      if (!T) { a[i + 2] = a[i + 3] = a[i + 4] = NaN; continue; }
      const s = T.s ?? 1, [e, n] = place(T, a[i + 2], -a[i + 4]);
      a[i + 2] = e; a[i + 4] = -n; a[i + 3] *= s;
    }
    writeFileSync(join(dir, f), Buffer.from(a.buffer));
  }
  track.sort((p, q) => p[0] - q[0]);
  const near = (t) => { let lo = 0, hi = track.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (track[m][0] < t) lo = m; else hi = m; } return track.length ? (Math.abs(track[lo][0] - t) < Math.abs(track[hi][0] - t) ? track[lo] : track[hi]) : null; };
  let keys = 0, inverted = 0, votes = 0;
  const keyFiles = readdirSync(dir).filter((x) => /^keys-\d{4}\.json$/.test(x));
  // the pictures' convention, as segment_study.pose_keys finds it: whichever reading puts the cameras on the track
  for (const f of keyFiles) for (const k of readJson(dir, f) || []) {
    const r = near(k.t); if (!r || !k.view) continue;
    const V = k.view, I = inv4(V), dA = Math.hypot(V[12] - r[2], V[13] - r[3], V[14] - r[4]), dB = Math.hypot(I[12] - r[2], I[13] - r[3], I[14] - r[4]);
    votes++; if (dB < dA) inverted++;
  }
  const appWay = votes && inverted * 2 > votes;   // the view kept is session to camera (the app)
  for (const f of keyFiles) {
    const list = readJson(dir, f) || [];
    for (const k of list) {
      if (!k.view) continue;
      const r = near(k.t), T = at(Number.isFinite(k.odo) ? k.odo : r ? r[1] : 0);
      if (!T) { k.view = null; continue; }
      const M = m4Of(T);
      k.view = appWay ? mul(k.view, inv4(M)) : mul(M, k.view);
      keys++;
    }
    writeFileSync(join(dir, f), JSON.stringify(list));
  }
  // THE SURFACES ARCORE FOUND (planes.json, bridge 10): each plane by the moment of the walk nearest it, the track's
  // point nearest its middle (a plane has no moment of its own: ARCore keeps moving it as it sees more)
  let planes = 0;
  const pj = readJson(dir, 'planes.json');
  if (pj && Array.isArray(pj.planes) && track.length) {
    const kept = [];
    for (const pl of pj.planes) {
      const xyz = pl[3];
      if (!Array.isArray(xyz) || xyz.length < 9) continue;
      let cx = 0, cz = 0; const nv = Math.floor(xyz.length / 3);
      for (let i = 0; i < nv; i++) { cx += xyz[3 * i]; cz += xyz[3 * i + 2]; }
      cx /= nv; cz /= nv;
      let best = null, bd = Infinity;
      for (const r of track) { const d = (r[2] - cx) ** 2 + (r[4] - cz) ** 2; if (d < bd) { bd = d; best = r; } }
      const T = best ? at(best[1]) : null;
      if (!T) continue;
      const s = T.s ?? 1, out = [];
      for (let i = 0; i < nv; i++) { const [e, n] = place(T, xyz[3 * i], -xyz[3 * i + 2]); out.push(+e.toFixed(3), +(xyz[3 * i + 1] * s).toFixed(3), +(-n).toFixed(3)); }
      kept.push([pl[0], pl[1], pl[2], out]);
    }
    writeFileSync(join(dir, 'planes.json'), JSON.stringify({ ...pj, moved: 'onto the map by the reference', planes: kept }));
    planes = kept.length;
  }
  return { pts, dropped, keys, appWay, planes };
}

async function main() {
  const [dir, refFile] = process.argv.slice(2);
  const meta = readJson(dir, 'meta.json') || {}, live = readJson(dir, 'live.json') || {};
  if (!meta.map) throw new Error('the walk names no map');
  const g = keepPlan(live.marks || [], []).g;
  if (!g?.ok) { console.log(`On the reference: NOT done (its corners cannot be trusted: ${g?.why || 'none agree'}); left by its own fit.`); return; }
  const bytes = refFile ? readFileSync(refFile) : await readObject(BUCKET, `refs/${meta.map}.bin`).catch(() => null);
  const ref = bytes ? decodeRef(new Uint8Array(bytes)) : null;
  if (!ref) { console.log('On the reference: NOT done (the map has no reference); left by its own fit.'); return; }
  const left = new Set(g.left || []);
  const marks = (live.marks || []).filter((m) => !left.has(m.id));
  const res = placeOnShape(ref, twinPoints(dir), marks, []);
  const own = fitOf(live);
  const at = placerOf(res.windows, ref.P || { theta: 0, tx: 0, ty: 0 }, own.ok ? own.T : null);
  const ok = res.windows.filter((w) => w.T);
  // a walk with no stretch at all (0 of 0) was taken as placed and ranked with the well placed (2026-11-27 repool run)
  if (!ok.length) { console.log(`On the reference: NOT done (no stretch of it could be matched: ${res.windows.length} tried); left by its own fit.`); return; }
  if (ok.length < res.windows.length / 2) { console.log(`On the reference: NOT done (only ${ok.length} of ${res.windows.length} stretches matched); left by its own fit.`); return; }
  // how far the reference puts the walk from where its own corners did, along the walk (the gap the old way left)
  const gaps = own.ok ? ok.map((w) => { const M = compose({ ...(ref.P || {}), s: 1 }, w.T); const pc = w.part.stand[Math.floor(w.part.stand.length / 2)]; if (!pc) return null; const a = place(M, pc[0], pc[1]), b = place(own.T, pc[0], pc[1]); return Math.hypot(a[0] - b[0], a[1] - b[1]); }).filter((x) => x != null).sort((a, b) => a - b) : [];
  const mv = moveTwin(dir, at);
  const ss = ok.map((w) => w.T.s ?? 1).sort((a, b) => a - b), sMid = ss[ss.length >> 1] || 1;
  writeFileSync(join(dir, 'fit.json'), JSON.stringify({ ok: true, T: { theta: 0, tx: 0, ty: 0, s: 1 }, n: g.n, worstM: g.worstM, by: 'the reference', castScale: sMid, closing: own.closing || null }));
  // how each moment of the walk goes onto the map, for the 3D view of every walk of the map (cloud-view.js ?all=1)
  const r4 = (v) => +(+v).toFixed(5);
  writeFileSync(join(dir, 'onref.json'), JSON.stringify({ v: 1, by: 'the reference', reachM: 30, windows: ok.map((w) => { const M = compose({ ...(ref.P || {}), s: 1 }, w.T); return { c: +w.c.toFixed(1), M: { theta: r4(M.theta), tx: r4(M.tx), ty: r4(M.ty), s: r4(M.s ?? 1) } }; }), fallback: own.ok ? own.T : null }));
  console.log(`On the reference: ${ok.length} of ${res.windows.length} stretches matched; ${mv.pts.toLocaleString()} points moved onto the map through it${mv.dropped ? `, ${mv.dropped.toLocaleString()} in no stretch and with no fit of its own dropped` : ''}; ${mv.keys} pictures' poses moved (${mv.appWay ? 'session to camera' : 'camera to session'}). Where it puts the walk against its own corners' one fit: ${gaps.length ? `middle ${(gaps[gaps.length >> 1] * 39.37).toFixed(0)} in, the most ${(gaps[gaps.length - 1] * 39.37).toFixed(0)} in` : 'not comparable'}.`);
}

if (process.argv[1] && process.argv[1].endsWith('twin-onref.mjs')) main().catch((e) => { console.log(`On the reference: ${e.message}`); process.exit(1); });
