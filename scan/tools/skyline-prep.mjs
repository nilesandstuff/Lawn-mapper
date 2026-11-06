/**
 * THE SKYLINE STUDY'S INPUTS (core session, 2026-11-06; scan/tools/skyline_study.py reads them). Run by workflow
 * "S. Yard AR tool", task `skyline`, on a twin fetched with its pictures. Writes beside the twin:
 *
 *   sky-surface.bin  Float32, the shade map's model as one surface: ground + the highest return per column (the
 *                    ground where a column has none), absolute metres, row-major from the north edge
 *   sky-ground.bin   Float32, the ground alone, the same grid
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
  writeFileSync(join(dir, 'sky-input.json'), JSON.stringify({
    lawn,
    grid: { w: g.w, h: g.h, x0: (g.x0 - ox) * k, y1: (g.y1 - oy) * k, cell: g.cell * k, cellY: (g.cellY || g.cell) * k },
    pictures: pics, checks, refs,
  }));
  const eyes = pics.map((p) => p.eye).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`Skyline inputs: the model's surface ${g.w} x ${g.h} columns of ${(g.cell * k).toFixed(2)} m (${tops.toLocaleString()} with something standing), ${pics.length} pictures (phone over its ground: median ${eyes.length ? eyes[eyes.length >> 1].toFixed(2) : '-'} m), ${checks.length} check marks, ${refs.length} reference marks.`);
}

main().catch((e) => { console.log(`Skyline inputs: ${String(e.message).replace(/-?\d+\.\d{3,}/g, '#')}`); process.exit(1); });
