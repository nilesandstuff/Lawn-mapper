/**
 * scan/lib/postfix.js: a walk recorded first and fixed afterwards. A made-up lot (a house turned 25 degrees, a fence,
 * five trunks) as the shade map's model, a 150 m walk round it whose session frame drifts from the map by 1.2 m and
 * 2.5 degrees as it goes (ARCore's slow drift), the references' fit 1 m and 3 degrees off as the start. The windows
 * follow the drift; one placement for the whole walk cannot.
 *   node scan/test/postfix.test.js
 */
import assert from 'node:assert/strict';
import { classify, solveWalk, checkErrors, baseMesh, refsPrior } from '../lib/postfix.js';
import { gridsFromModel } from '../lib/lidar-load.js';
import { encodeModel, decodeModel } from '../lib/lidar-model.js';
import { apply, unapply } from '../lib/align.js';
import * as S from '../../public/shade/structures.js';
import { gridOver } from '../../public/shade/grid.js';
import { toMerc, fromMerc } from '../lib/photo.js';

let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const LAT = 42.8, K = Math.cos((LAT * Math.PI) / 180), OX = -9540000, OY = 5285000, BOX = [-40, -40, 40, 40], ORIGIN = fromMerc([OX, OY]);
const TH = (25 * Math.PI) / 180, rot = ([x, y]) => [Math.cos(TH) * x - Math.sin(TH) * y, Math.sin(TH) * x + Math.cos(TH) * y];
const roof = [[-8, -5], [8, -5], [8, 5], [-8, 5]].map(rot); // the roof, turned
const wallsOf = [[-7.4, -4.4], [7.4, -4.4], [7.4, 4.4], [-7.4, 4.4]].map(rot); // the walls 2 ft in
const fence = [[-30, -22], [25, -22]];
const trunks = [[18.5, 10.5], [-20.5, 12.5], [22.5, -10.5], [-15.5, -14.5], [3.5, 20.5]];
const inPoly = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };

// the model: 1 m columns
const bbox = [OX + BOX[0] / K, OY + BOX[1] / K, OX + BOX[2] / K, OY + BOX[3] / K], grid = gridOver(bbox, 1, LAT), N = grid.w * grid.h, nz = 14, z0 = 99;
const kind = new Uint8Array(N), top = new Float32Array(N).fill(NaN), ground = new Float32Array(N).fill(100), low = new Float32Array(N).fill(NaN), mu = new Float32Array(N * nz);
for (let r = 0; r < grid.h; r++) for (let c = 0; c < grid.w; c++) {
  const j = r * grid.w + c, e = (grid.x0 + (c + 0.5) * grid.cell - OX) * K, n = (grid.y1 - (r + 0.5) * grid.cell - OY) * K;
  if (inPoly(roof, e, n)) { kind[j] = S.BUILDING; top[j] = 6; continue; }
  if (Math.floor(n) === -22 && e > -30 && e < 25) { kind[j] = S.UNKNOWN; top[j] = 1.8; low[j] = 0.6; continue; }
  const t = trunks.find(([te, tn]) => Math.floor(e) === Math.floor(te) && Math.floor(n) === Math.floor(tn));
  if (t) { kind[j] = S.TREE; top[j] = 10; low[j] = 0.5; }
}
const M = decodeModel(encodeModel({ tool: 'shade', at: '2026-11-05T00:00:00Z', grid, layers: { z0, dz: 1, nz }, rule: { kinds: { NOTHING: 0, BUILDING: 1, TREE: 2, SOLID_TREE: 3, STRUCTURE: 4, UNKNOWN: 5 } } }, { ground, kind, top, low, mu }));
const { G } = gridsFromModel(M, { origin: ORIGIN, box: BOX, S, toMerc });

// the walk: a loop round the house, 1.5 m a sample; the true session -> map placement drifts with distance walked
const path = [];
const loop = [...[[-10, -7], [10, -7], [10, 7], [-10, 7], [-10, -7]].map(rot), [-16, -20], [22, -20], [22.5, -12.5], [20.5, 8.5], [18.5, 13]];
let odo = 0;
for (let i = 0; i + 1 < loop.length; i++) {
  const [a, b] = [loop[i], loop[i + 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (let d = 0; d < L; d += 1.5) { path.push({ at: [a[0] + ((b[0] - a[0]) * d) / L, a[1] + ((b[1] - a[1]) * d) / L], odo }); odo += 1.5; }
}
const END = odo, T0 = { theta: 1.1, tx: 3, ty: -2, s: 1 };
const truthAt = (o) => ({ theta: T0.theta + ((2.5 * Math.PI) / 180) * (o / END), tx: T0.tx + 1.0 * (o / END), ty: T0.ty - 0.7 * (o / END), s: 1 });
// what the phone sees: points on the walls, the fence and the trunks within 3.5 m, twice each; ground round it
const segsOf = (poly) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]]);
const things = [...segsOf(wallsOf), fence];
const recs = [], track = [];
for (const { at, odo: o } of path) {
  const T = truthAt(o), toSession = ([e, n]) => { const [u, v] = unapply(T, [e, n]); return [u, -v]; }; // x, z
  const [cx, cz] = toSession(at); track.push({ t: o, pos: { x: cx, y: 0, z: cz } });
  const add = (e, n, h) => { const [x, z] = toSession([e + (rnd() - 0.5) * 0.04, n + (rnd() - 0.5) * 0.04]); recs.push({ t: o, odo: o, x, y: -1.4 + h, z, ground: -1.4 }); };
  for (const [a, b] of things) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 0; d <= L; d += 0.2) { const e = a[0] + ((b[0] - a[0]) * d) / L, n = a[1] + ((b[1] - a[1]) * d) / L; if (Math.hypot(e - at[0], n - at[1]) < 3.4) for (let k = 0; k < 2; k++) add(e, n, 0.6 + rnd() * 1.4); }
  }
  for (const [te, tn] of trunks) if (Math.hypot(te - at[0], tn - at[1]) < 3.4) for (let k = 0; k < 24; k++) { const a = rnd() * 6.283; add(te + 0.2 * Math.cos(a), tn + 0.2 * Math.sin(a), 0.6 + rnd() * 1.4); add(te + 0.2 * Math.cos(a), tn + 0.2 * Math.sin(a), 0.6 + rnd() * 1.4); }
  for (let k = 0; k < 20; k++) { const a = rnd() * 6.283, r = 0.5 + rnd() * 4; add(at[0] + r * Math.cos(a), at[1] + r * Math.sin(a), 0); }
}

const pts = classify(recs, track);
assert.ok(pts.stand.length > 500 && pts.ground.length > 500, `classified: ${pts.stand.length} standing, ${pts.ground.length} ground`);
// the references' fit: 1 m and 3 degrees off the start
const prior = { T: { theta: T0.theta + (3 * Math.PI) / 180, tx: T0.tx + 0.8, ty: T0.ty - 0.6, s: 1 }, searchM: 3, searchDeg: 8 };
const sol = solveWalk(pts, G, prior);
assert.ok(sol.global.ok, `one placement for the whole walk: ${sol.global.why}`);
const kept = sol.windows.filter((w) => w.kept).length;
assert.ok(kept >= sol.windows.length / 2, `windows kept: ${kept} of ${sol.windows.length} (${JSON.stringify(sol.windows.map((w) => w.why || (w.kept ? 'kept' : 'dropped')))})`);
const err = (place) => path.map(({ at, odo: o }) => { const T = truthAt(o), sess = unapply(T, at), p = apply(place(o), sess); return Math.hypot(p[0] - at[0], p[1] - at[1]); });
const eW = err(sol.placeAt), eG = err(() => sol.global.T), eP = err(() => prior.T);
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1], max = (a) => Math.max(...a);
// what the wall rule allows: a stretch that sees one wall of the house is free by up to 0.6 m along it
assert.ok(med(eW) < 0.45 && max(eW) < 1.0, `the windows follow the walk: median ${med(eW).toFixed(2)} m, worst ${max(eW).toFixed(2)} m`);
assert.ok(med(eW) < med(eG) && max(eW) < max(eP), `better than one placement (median ${med(eG).toFixed(2)} m) and than the references (worst ${max(eP).toFixed(2)} m)`);
assert.ok(max(eG) < max(eP), 'and one placement for the whole walk already beats the references alone');
// NEVER WORSE THAN THE REFERENCES: references 3 m off everywhere -> no window is within 1.5 m of them, the walk keeps
// them; true references -> the windows are kept, and the placement is no worse than with no references at all
{
  const off = (o) => ({ ...truthAt(o), tx: truthAt(o).tx + 3 });
  const bound = solveWalk(pts, G, prior, { refPlace: off });
  assert.equal(bound.windows.filter((w) => w.kept).length, 0, 'every window too far from the references');
  assert.deepEqual(bound.placeAt(40), off(40), 'the references kept where no window is');
  const good = solveWalk(pts, G, prior, { refPlace: truthAt });
  assert.ok(good.windows.filter((w) => w.kept).length >= kept - 1, 'with true references the windows stay');
  assert.ok(med(err(good.placeAt)) < 0.45, `and the walk is placed: ${med(err(good.placeAt)).toFixed(2)} m`);
}
// check points, by mark: a check at the far end of the walk
const far = path.at(-1), mark = { id: 'c1', kind: 'check', map: far.at, ar: unapply(truthAt(far.odo), far.at), odo: far.odo };
const [c] = checkErrors([mark], sol.placeAt);
assert.ok(c.m < 0.6, `the check point at the end: ${c.m.toFixed(2)} m`);
// refsPrior: two reference marks give a fit
const r1 = { id: 'r1', kind: 'ref', map: [0, 0], ar: unapply(T0, [0, 0]), odo: 0 }, r2 = { id: 'r2', kind: 'ref', map: [10, 3], ar: unapply(T0, [10, 3]), odo: 5 };
const rp = refsPrior([r1, r2]);
assert.ok(rp && Math.abs(rp.T.tx - T0.tx) < 1e-6 && rp.searchM === 6);
// the base mesh: points on the map, one per cell, at the map's heights
const mesh = baseMesh(recs, sol.placeAt, 101.4);
assert.ok(mesh.e.length > 1000 && mesh.e.length < recs.length, `mesh cells: ${mesh.e.length} of ${recs.length} records`);
let gz = 0, gn = 0; for (let i = 0; i < mesh.e.length; i++) if (mesh.cls[i] === 0) { gz += mesh.z[i]; gn++; }
assert.ok(Math.abs(gz / gn - 100) < 0.05, `the ground at the map's height: ${(gz / gn).toFixed(3)}`);
console.log(`postfix: ok (median ${med(eW).toFixed(2)} m with windows, worst ${max(eW).toFixed(2)}; one placement worst ${max(eG).toFixed(2)}; references worst ${max(eP).toFixed(2)})`);
