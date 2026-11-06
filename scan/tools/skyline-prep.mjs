/**
 * THE SKYLINE STUDY'S INPUTS (core session, 2026-11-06; scan/tools/skyline_study.py reads them). Run by workflow
 * "S. Yard AR tool", task `skyline`, on a twin fetched with its pictures. Writes beside the twin:
 *
 *   sky-surface.bin  Float32, the shade map's model as one surface: ground + the highest return per column (the
 *                    ground where a column has none), absolute metres, row-major from the north edge
 *   sky-ground.bin   Float32, the ground alone, the same grid
 *   sky-points.bin   Float32 [east, north, z, intensity, class, kind] per return, when the model carries its points
 *   sky-input.json   the grid in the map's local metres (east, north round the map's origin), the check points
 *                    (session [u, v] and map [e, n]), and for each picture the phone's height over its own ground then
 *
 * Nothing printed but counts. Coordinates stay in the files on the runner; the repository is public.
 *
 *   CLOUDFLARE_API_TOKEN=... node scan/tools/skyline-prep.mjs twin
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toMerc, ringsOf } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';
import { readCloud, readTrack } from '../lib/twin.js';
import { readMap, readModel } from './twin-io.mjs';
import { gpsPrior } from '../lib/postfix.js';

async function main() {
  const dir = process.argv[2] || 'twin';
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const live = existsSync(join(dir, 'live.json')) ? JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')) : { marks: [] };
  if (!meta.map) throw new Error('the twin names no map');
  const m = await readMap(meta.map);
  const model = await readModel(meta.map, m.ownerId);
  const origin = [m.lng, m.lat], k = Math.cos((origin[1] * Math.PI) / 180), [ox, oy] = toMerc(origin);
  const g = model.meta.grid, n = g.w * g.h, ground = model.arrays.ground, top = model.arrays.top;
  const surf = new Float32Array(n), gr = new Float32Array(n);
  let tops = 0;
  for (let i = 0; i < n; i++) {
    const z = ground[i];
    gr[i] = Number.isFinite(z) ? z : NaN;
    const t = top ? top[i] : NaN;
    surf[i] = Number.isFinite(z) ? z + (Number.isFinite(t) && t > 0 ? t : 0) : NaN;
    if (Number.isFinite(t) && t > 0) tops++;
  }
  writeFileSync(join(dir, 'sky-surface.bin'), Buffer.from(surf.buffer));
  writeFileSync(join(dir, 'sky-ground.bin'), Buffer.from(gr.buffer));
  // THE SHADE MAP'S ADDITIONS OF 2026-11-06 (the features session, asked for by the core): the ground's intensity per
  // column (pavement is dark, grass bright) and the surround (ground and top 100 m out at 2 m cells, its own grid)
  const A = model.arrays, sur = model.meta.surround;
  let hasInt = false, hasSur = false;
  if (A.intensity && A.intensity.length === n) { writeFileSync(join(dir, 'sky-intensity.bin'), Buffer.from(Uint16Array.from(A.intensity).buffer)); hasInt = true; }
  if (A.gIntens && A.gIntens.length === n) writeFileSync(join(dir, 'sky-gintens.bin'), Buffer.from(Uint8Array.from(A.gIntens).buffer));
  let surround = null;
  if (sur?.grid && A.surroundGround && A.surroundTop && A.surroundGround.length === sur.grid.w * sur.grid.h) {
    const sg = sur.grid, ns = sg.w * sg.h, ssurf = new Float32Array(ns), sgr = new Float32Array(ns);
    for (let i = 0; i < ns; i++) { const z = A.surroundGround[i], t = A.surroundTop[i]; sgr[i] = Number.isFinite(z) ? z : NaN; ssurf[i] = Number.isFinite(z) ? z + (Number.isFinite(t) && t > 0 ? t : 0) : NaN; }
    writeFileSync(join(dir, 'sky-surround-surface.bin'), Buffer.from(ssurf.buffer));
    writeFileSync(join(dir, 'sky-surround-ground.bin'), Buffer.from(sgr.buffer));
    surround = { w: sg.w, h: sg.h, x0: (sg.x0 - ox) * k, y1: (sg.y1 - oy) * k, cell: sg.cell * k, cellY: (sg.cellY || sg.cell) * k };
    hasSur = true;
  }
  // THE POINTS THEMSELVES (the shade map, 2026-11-06, asked for by the core at the owner's word: "get the finest returns
  // for the ground"): every return the shade map kept, cleaned and with its column's kind. Written as Float32 records
  // [east, north, z, intensity, class, kind] in the map's local metres. ptX/ptY are 3857 cm east and SOUTH of the
  // grid's (x0, y1) corner, the cloud's shift applied, the same frame as the columns.
  let nPts = 0;
  if (A.ptX && A.ptY && A.ptZ && A.ptX.length) {
    const np_ = A.ptX.length, rec = new Float32Array(np_ * 6);
    for (let i = 0; i < np_; i++) {
      const mx = g.x0 + A.ptX[i] / 100, my = g.y1 - A.ptY[i] / 100;
      rec.set([(mx - ox) * k, (my - oy) * k, A.ptZ[i] / 100, A.ptI ? A.ptI[i] : 0, A.ptCls ? A.ptCls[i] : 0, A.ptKind ? A.ptKind[i] : 0], i * 6);
    }
    writeFileSync(join(dir, 'sky-points.bin'), Buffer.from(rec.buffer));
    nPts = np_;
  }
  // the kinds (structures.js: BUILDING 1), so roofs alone can be tried: they do not change with the season
  writeFileSync(join(dir, 'sky-kind.bin'), Buffer.from(Uint8Array.from(model.arrays.kind).buffer));

  // the phone's height over its own ground at each picture: the camera's height less the ground the page had then
  const recs = [];
  for (const f of readdirSync(dir).filter((x) => /^cloud-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); recs.push(...readCloud(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  recs.sort((a, b) => a.t - b.t);
  // the phone's turn rate at each picture, from the track (poses every so often): a picture that lags its pose by a
  // frame or two is turned by rate x lag, one way on a walk taken one way round
  const track = [];
  for (const f of readdirSync(dir).filter((x) => /^track-\d+\.bin$/.test(x)).sort()) { const b = readFileSync(join(dir, f)); track.push(...readTrack(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  track.sort((a, b) => a.t - b.t);
  const yawOf = (q) => { const { x, y, z, w } = q; const fx = -(2 * (x * z + w * y)), fz = -(1 - 2 * (x * x + y * y)); return Math.atan2(-fz, fx); };
  const yawRateAt = (t) => {
    const near = track.filter((p) => Math.abs(p.t - t) <= 0.35 && p.tracking !== 'lost');
    if (near.length < 2) return null;
    const a = near[0], b = near[near.length - 1]; if (b.t - a.t < 0.1) return null;
    let d = yawOf(b.quat) - yawOf(a.quat); d = ((d + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    return +((d / (b.t - a.t)) * 180 / Math.PI).toFixed(2); // degrees per second, the azimuth convention of the study
  };
  const keys = [];
  for (const f of readdirSync(dir).filter((x) => /^keys-\d+\.json$/.test(x)).sort()) keys.push(...JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const groundAt = (t) => {
    let lo = 0, hi = recs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (recs[mid].t < t - 1.5) lo = mid + 1; else hi = mid; }
    const ys = [];
    for (let i = lo; i < recs.length && recs[i].t <= t + 1.5; i++) if (Number.isFinite(recs[i].ground)) ys.push(recs[i].ground);
    ys.sort((a, b) => a - b);
    return ys.length ? ys[ys.length >> 1] : null;
  };
  const pics = keys.filter((x) => existsSync(join(dir, x.name))).map((x) => {
    const camY = x.view[13], gy = groundAt(x.t);
    return { name: x.name, t: x.t, odo: x.odo, w: x.w, h: x.h, view: x.view, proj: x.proj, eye: gy != null ? +(camY - gy).toFixed(3) : null, yawRate: yawRateAt(x.t) };
  });
  const checks = (live.marks || []).filter((x) => x.kind === 'check' && x.ar && x.map).map((x) => ({ id: x.id, ar: x.ar, map: x.map, odo: x.odo ?? null }));
  const refs = (live.marks || []).filter((x) => x.kind === 'ref' && x.ar && x.map).map((x) => ({ id: x.id, ar: x.ar, map: x.map, odo: x.odo ?? null }));
  // the traced lawn, local metres: NOT a fix signal (the owner, 2026-11-04); only to check the pavement projection
  const lawn = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(origin, p).map((v) => +v.toFixed(2))));
  // THE GPS TRAIL'S PLACEMENT (SCAN-H22): the owner's work walks, 2026-11-06, where the skyline's best three were 190-370
  // ft off and the GPS trail alone 8-23 ft. The search keeps near it; the pavement study starts from it as well.
  const gp = gpsPrior(live.gpsTrail);
  const gps = gp ? { theta: gp.T.theta, tx: gp.T.tx, ty: gp.T.ty, searchM: gp.searchM, searchDeg: gp.searchDeg, from: gp.from } : null;
  writeFileSync(join(dir, 'sky-input.json'), JSON.stringify({
    lawn,
    grid: { w: g.w, h: g.h, x0: (g.x0 - ox) * k, y1: (g.y1 - oy) * k, cell: g.cell * k, cellY: (g.cellY || g.cell) * k },
    pictures: pics, checks, refs, surround, intensityMedian: model.meta.own?.intensityMedian ?? null, gps,
  }));
  const eyes = pics.map((p) => p.eye).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`GPS trail: ${gps ? `${gps.from}; the search keeps within ${Math.round(Math.min(24, Math.max(10, 2 * gps.searchM)))} m and ${Math.round(gps.searchDeg + 10)} degrees of its placement` : 'too short or none: the search is not limited'}.`);
  console.log(`Model extras: intensity ${hasInt ? 'yes' : 'no'}, surround ${hasSur ? `${surround.w} x ${surround.h} cells of ${surround.cell.toFixed(1)} m` : 'no'}, points ${nPts ? nPts.toLocaleString() : (model.meta.points?.leftOut ? 'left out of the file (too big)' : 'no')}.`);
  console.log(`Skyline inputs: the model's surface ${g.w} x ${g.h} columns of ${(g.cell * k).toFixed(2)} m (${tops.toLocaleString()} with something standing), ${pics.length} pictures (phone over its ground: median ${eyes.length ? eyes[eyes.length >> 1].toFixed(2) : '-'} m), ${checks.length} check marks, ${refs.length} reference marks.`);
}

main().catch((e) => { console.log(`Skyline inputs: ${String(e.message).replace(/-?\d+\.\d{3,}/g, '#')}`); process.exit(1); });
