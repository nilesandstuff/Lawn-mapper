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
import { disagree, lines, heights } from '../lib/disagree.js';

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
  part.forEach((r, i) => { r.label = lab?.[i]?.label ?? null; r.conf = lab?.[i]?.conf ?? null; r.spike = !!lab?.[i]?.spike; });
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
const pts = [];
let far = 0, spikes = 0;
for (let i = 0; i < recs.length; i++) {
  const r = recs[i];
  if (r.spike) { spikes++; continue; }
  const cam = camAt(r.t);
  if (cam && Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z) > RANGE_M) { far++; continue; }
  const [e, n] = apply(fitFor(r.odo), [r.x, -r.z]);
  pts.push({ e, n, y: r.y, t: r.t, ground: r.ground, label: r.label, conf: r.conf, i });
}
// each point's height over the ground the walk itself saw nearby (lib/disagree.js heights), not over the height
// the page kept under it: the owner found the first report's patches to be ground
{
  const hs = heights(pts);
  let was = 0, now = 0;
  pts.forEach((p, k) => { const old = p.y - p.ground; p.h = hs[k]; if (old > 0.4 && old < 2.4) { was++; if (!(p.h > 0.4 && p.h < 2.4)) now++; } });
  console.log(`Heights: over the ground the walk itself saw nearby; ${now.toLocaleString()} of the ${was.toLocaleString()} points the kept ground height called standing are not standing by it.`);
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
// for the segment trial (scan/tools/segment_study.py): each patch as the indexes of its points in the twin's own
// records. Kept in the run's folder only; no place in it.
if (process.env.CELLS_OUT) writeFileSync(process.env.CELLS_OUT, JSON.stringify(result.extra.patches.map((p) => ({ cells: p.cells, lengthM: p.lengthM, line: p.line, label: p.label, idx: p.idx || [] }))));
