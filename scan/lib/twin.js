/**
 * THE DIGITAL TWIN OF A WALK (core session, 2026-11-03; owner: "Can you start saving the outputs of the digital twin
 * that is being constructed? I want to see how it lines up with reality.").
 *
 * What the phone builds while it walks, kept so it can be laid over the photo and the lidar afterwards (/twin.html):
 *
 *   cloud-NNNN.bin  the depth points, in the session's own frame: Float32 records [t, odo, x, y, z, ground], t in
 *                   seconds from the walk's start, ground the height the page took for the ground under it then
 *                   (the column's floor, locate.js groundUnder; before 2026-11-04 the crosshair's average).
 *                   One point per 5 cm cube for the whole walk, so standing still adds nothing.
 *   track-NNNN.bin  the camera, five times a second: Float32 [t, odo, x, y, z, qx, qy, qz, qw, tracking 0|1|2].
 *   key-NNNN.jpg    camera pictures (WebXR's camera-access), at most one a second and only after moving 0.3 m or
 *                   turning 10 degrees, each with its pose and projection in keys-NNNN.json: what a later Gaussian
 *                   splat or photogrammetry pass would need (none is run; that would want a paid GPU, asked first).
 *   live.json       the fixes (lidar and references), the marks, the pins and the checks so far; overwritten at each
 *                   flush and at the end, so a walk cut short keeps what it had.
 *   meta.json       the walk's id, the map's id, the engine, the start, the camera picture's size.
 *
 * No coordinates in degrees and no address: everything is in the session's metres or the map's local metres (east
 * and north of the map's own point, which only the map record holds). Admin only on the site (src/twin.js).
 * Pure: the page hands parts to an uploader; tests in scan/test/twin.test.js.
 */

import { newLocate, fitFor, refFit, nearestFix, FIX_REACH } from './locate.js';
import { apply } from './align.js';

export const VOXEL = 0.05;           // m: one point kept per cube this size
export const VOXEL_MAX = 3e6;        // cubes remembered; past this every point is kept
export const POSE_EVERY = 200;       // ms between camera poses
export const KEY_EVERY = 1000;       // ms at least between pictures
export const KEY_MOVE = 0.3, KEY_TURN = 10; // m, degrees: what counts as having moved for a new picture
export const KEY_MAX = 900;          // pictures per walk at most (15 minutes of one a second)
export const CLOUD_REC = 6, TRACK_REC = 10;
export const FLUSH_EVERY = 15000;    // ms between uploads of what has piled up

export function newTwin({ walk, map = null, engine = null, started = Date.now() } = {}) {
  return { walk: String(walk), map, engine, started, cloud: [], track: [], keys: [], vox: new Set(), seq: { cloud: 0, track: 0, key: 0 }, lastPose: -Infinity, lastKey: null, flushedAt: started, counts: { points: 0, poses: 0, keys: 0, parts: 0, failed: 0 }, camera: null };
}

const sec = (tw, now) => (now - tw.started) / 1000;

/** Depth points ({x, y, z} in the session frame) seen at `now`, `odo` metres into the walk, over ground height gy. */
export function addPoints(tw, now, odo, pts, gy = NaN) {
  let n = 0;
  const t = sec(tw, now), full = tw.vox.size >= VOXEL_MAX;
  for (const p of pts) {
    if (!p || !Number.isFinite(p.x)) continue;
    if (!full) {
      const k = `${Math.floor(p.x / VOXEL)},${Math.floor(p.y / VOXEL)},${Math.floor(p.z / VOXEL)}`;
      if (tw.vox.has(k)) continue;
      tw.vox.add(k);
    }
    tw.cloud.push(t, odo, p.x, p.y, p.z, p.g ?? gy ?? NaN); n++; // p.g: the ground the page took under it (locate.js addDepth)
  }
  tw.counts.points += n;
  return n;
}

const TRACKING = { normal: 0, limited: 1, lost: 2 };
/** The camera's pose, at most every POSE_EVERY ms. -> true when kept */
export function addPose(tw, now, odo, pos, quat, tracking = 'normal') {
  if (!pos || !quat || now - tw.lastPose < POSE_EVERY) return false;
  tw.lastPose = now;
  tw.track.push(sec(tw, now), odo, pos.x, pos.y, pos.z, quat.x, quat.y, quat.z, quat.w, TRACKING[tracking] ?? 2);
  tw.counts.poses++;
  return true;
}

/** The angle between two orientations, degrees. */
export function turnDeg(a, b) {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}
/** Is it time for a camera picture? */
export function wantKey(tw, now, pos, quat) {
  if (!pos || !quat || tw.counts.keys >= KEY_MAX) return false;
  const k = tw.lastKey;
  if (!k) return true;
  if (now - k.now < KEY_EVERY) return false;
  return Math.hypot(pos.x - k.pos.x, pos.y - k.pos.y, pos.z - k.pos.z) >= KEY_MOVE || turnDeg(quat, k.quat) >= KEY_TURN;
}
/** A camera picture taken: its blob goes up as key-NNNN.jpg; its pose waits for the next keys-NNNN.json. */
export function addKey(tw, now, odo, pos, quat, { w, h, proj, view }) {
  const name = `key-${String(tw.counts.keys).padStart(4, '0')}.jpg`;
  tw.lastKey = { now, pos: { ...pos }, quat: { ...quat } };
  tw.keys.push({ name, t: +sec(tw, now).toFixed(3), odo: +odo.toFixed(3), w, h, proj: Array.from(proj, (v) => +v.toFixed(6)), view: Array.from(view, (v) => +v.toFixed(6)) });
  tw.camera = { w, h };
  tw.counts.keys++;
  return name;
}

/** Is it time to send what has piled up? */
export const flushDue = (tw, now) => now - tw.flushedAt >= FLUSH_EVERY && (tw.cloud.length || tw.track.length || tw.keys.length);

/** What has piled up, as parts to upload: [{ name, type, body }]; the piles are emptied. `live` is the state so far. */
export function flush(tw, now, live = null) {
  const out = [], pad = (n) => String(n).padStart(4, '0');
  if (tw.seq.cloud === 0 && tw.seq.track === 0 && !tw.metaSent) {
    out.push({ name: 'meta.json', type: 'application/json', body: JSON.stringify(metaOf(tw)) });
    tw.metaSent = true;
  }
  if (tw.cloud.length) { out.push({ name: `cloud-${pad(tw.seq.cloud++)}.bin`, type: 'application/octet-stream', body: Float32Array.from(tw.cloud).buffer }); tw.cloud = []; }
  if (tw.track.length) { out.push({ name: `track-${pad(tw.seq.track++)}.bin`, type: 'application/octet-stream', body: Float32Array.from(tw.track).buffer }); tw.track = []; }
  if (tw.keys.length) { out.push({ name: `keys-${pad(tw.seq.key++)}.json`, type: 'application/json', body: JSON.stringify(tw.keys) }); tw.keys = []; }
  if (live) out.push({ name: 'live.json', type: 'application/json', body: JSON.stringify(live) });
  if (tw.camera && !tw.metaCamera) { out.push({ name: 'meta.json', type: 'application/json', body: JSON.stringify(metaOf(tw)) }); tw.metaCamera = true; }
  tw.flushedAt = now;
  tw.counts.parts += out.length;
  return out;
}
export const metaOf = (tw) => ({ walk: tw.walk, map: tw.map, engine: tw.engine, depthType: tw.depthType || null, started: new Date(tw.started).toISOString(), camera: tw.camera, voxelM: VOXEL, cloudRecord: ['t', 'odo', 'x', 'y', 'z', 'ground'], trackRecord: ['t', 'odo', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'tracking'] });

/**
 * The state worth keeping as it stands: the lidar's kept fixes and the references' marks (each with its moment of
 * the walk), the pins and checks. From locate.js's L and walk.js's walk. Map places are the map's local metres.
 */
export function liveOf(L, w, extra = {}) {
  const r = (v) => (Number.isFinite(v) ? +v.toFixed(4) : null), xyz = (p) => (p ? { x: r(p.x), y: r(p.y), z: r(p.z) } : null);
  return {
    fixes: (L?.fixes || []).map((f) => ({ odo: r(f.odo), T: { theta: r(f.T.theta), tx: r(f.T.tx), ty: r(f.T.ty), s: r(f.T.s ?? 1) }, hits: r(f.hits), from: f.from || null })),
    marks: (L?.marks || []).map((m) => ({ id: m.id, kind: m.kind, map: m.map, ar: m.ar, y: r(m.y), odo: r(m.odo) })),
    pins: (w?.pins || []).map((p) => ({ name: p.name, at: xyz(p.at), anchorAt: xyz(p.anchorAt), odo: r(p.odo) })),
    checks: (w?.checks || []).length,
    odo: r(w?.odo ?? 0),
    ...extra,
  };
}

/** A cloud part back as records: [{ t, odo, x, y, z, ground }]. */
export function readCloud(buf) {
  const f = new Float32Array(buf), out = [];
  for (let i = 0; i + CLOUD_REC <= f.length; i += CLOUD_REC) out.push({ t: f[i], odo: f[i + 1], x: f[i + 2], y: f[i + 3], z: f[i + 4], ground: f[i + 5] });
  return out;
}
/** A track part back as records: [{ t, odo, pos, quat, tracking }]. */
export function readTrack(buf) {
  const f = new Float32Array(buf), out = [];
  for (let i = 0; i + TRACK_REC <= f.length; i += TRACK_REC) out.push({ t: f[i], odo: f[i + 1], pos: { x: f[i + 2], y: f[i + 3], z: f[i + 4] }, quat: { x: f[i + 5], y: f[i + 6], z: f[i + 7], w: f[i + 8] }, tracking: ['normal', 'limited', 'lost'][f[i + 9]] || 'lost' });
  return out;
}

/* ------------------------------------------------------------ the viewer */


/**
 * How a moment of the walk goes onto the map, from what live.json kept: 'both' as the walk did it (the lidar fix
 * nearest in the walk, within FIX_REACH, else the references), 'refs' the references alone, 'fixes' the fixes alone.
 * -> (odo) => T or null
 */
export function placer(live, mode = 'both') {
  const L = newLocate();
  L.marks = (live?.marks || []).map((m) => ({ ...m }));
  L.fixes = (live?.fixes || []).map((f) => ({ ...f }));
  if (mode === 'refs') return (odo) => refFit(L, odo);
  if (mode === 'fixes') return (odo) => { const f = nearestFix(L, odo); return f && Math.abs(f.odo - odo) <= FIX_REACH ? f.T : null; };
  return (odo) => fitFor(L, odo);
}

/** What a point is, by its height over the ground the page took under it: the same bands as the match (locate.js). */
export const kindOf = (h) => (!Number.isFinite(h) ? 'other' : Math.abs(h) < 0.2 ? 'ground' : h > 0.4 && h < 2.4 ? 'stand' : h >= 2.4 && h < 12 ? 'high' : 'other');

/** The cloud on the map. -> { pts: Float32Array [e, n, h, kind 0 ground|1 stand|2 high|3 other] x N, placed, unplaced } */
export function placeCloud(records, place) {
  const out = new Float32Array(records.length * 4), K = { ground: 0, stand: 1, high: 2, other: 3 };
  let n = 0, unplaced = 0, lastOdo = NaN, T = null;
  for (const r of records) {
    if (r.odo !== lastOdo) { T = place(r.odo); lastOdo = r.odo; }
    if (!T) { unplaced++; continue; }
    const [e, nn] = apply(T, [r.x, -r.z]), h = r.y - r.ground;
    out[n * 4] = e; out[n * 4 + 1] = nn; out[n * 4 + 2] = h; out[n * 4 + 3] = K[kindOf(h)]; n++;
  }
  return { pts: out.subarray(0, n * 4), placed: n, unplaced };
}

/**
 * How well the phone's standing points line up with the lidar's solid cells: the share within 0.3 m and the median
 * distance. dist: { box, cell, W, H, data } (the worker's overlay.dist).
 */
export function lineUp(pts, dist) {
  const ds = [];
  for (let i = 0; i < pts.length; i += 4) {
    if (pts[i + 3] !== 1) continue;
    const c = Math.floor((pts[i] - dist.box[0]) / dist.cell), r = Math.floor((dist.box[3] - pts[i + 1]) / dist.cell);
    if (c < 0 || r < 0 || c >= dist.W || r >= dist.H) continue;
    ds.push(dist.data[r * dist.W + c]);
  }
  if (!ds.length) return { n: 0, within30cm: null, medianM: null };
  ds.sort((a, b) => a - b);
  return { n: ds.length, within30cm: ds.filter((d) => d <= 0.3).length / ds.length, medianM: ds[ds.length >> 1] };
}
