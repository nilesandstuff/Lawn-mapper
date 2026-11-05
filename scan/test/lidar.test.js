/**
 * scan/lib/lidar.js on a made-up lot -- a house, a fence and three trees on a 6% slope -- AS THE SHADE MAP WOULD
 * FINISH IT (public/lib/lidar-model.js: 1 m columns with a kind, a ground and a top; the owner, 2026-11-04: the AR
 * follows the shade map's output and rebuilds nothing), and a phone that sees what stands within 6 m of its walk, in
 * a frame turned and shifted from the map's.
 *   node scan/test/lidar.test.js
 */
import assert from 'node:assert/strict';
import { buildGrids, buildingsOnGrid, register, sample, piecesOf, placementCost } from '../lib/lidar.js';
import { gridsFromModel, loadLidar, kindsOf, NO_MODEL } from '../lib/lidar-load.js';
import { encodeModel, decodeModel, packModel } from '../lib/lidar-model.js';
import * as S from '../../public/shade/structures.js';
import { gridOver } from '../../public/shade/grid.js';
import { toMerc, fromMerc } from '../lib/photo.js';

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const ground = (e, n) => 100 + 0.06 * e + 0.01 * n;

/* THE LOT AS A MODEL. The map's origin at a 3857 point; the shade grid 1 m columns over the box round it (gridOver, as
   the shade map lays it), each column classed by what the lot has at its centre: the house (roof 6 m up, e -12.5..2.5,
   n 3.5..13.5) BUILDING; a fence 1.7 m tall along n = -11.5, the centre of its column (e -20..10) UNKNOWN (the rule's step 7: a return over the
   grass no rule names); three crowns of radius 3 m, 9 m tall, TREE, each with leaf from the ground up in its trunk's column (at a column's centre) and open below 4 m elsewhere. */
const LAT = 42.8, K = Math.cos((LAT * Math.PI) / 180), OX = -9540000, OY = 5285000;
const ORIGIN = fromMerc([OX, OY]);
const BOX = [-30, -30, 30, 30];
const TREES = [[8.5, 3.5], [15.5, -5.5], [-18.5, -3.5]];
function model(box = BOX) {
  const bbox = [OX + box[0] / K, OY + box[1] / K, OX + box[2] / K, OY + box[3] / K];
  const grid = gridOver(bbox, 1, LAT), N = grid.w * grid.h;
  const nz = 12, z0 = 98, dz = 1;
  const kind = new Uint8Array(N), top = new Float32Array(N).fill(NaN), gr = new Float32Array(N), mu = new Float32Array(N * nz);
  for (let r = 0; r < grid.h; r++) for (let c = 0; c < grid.w; c++) {
    const j = r * grid.w + c;
    const e = (grid.x0 + (c + 0.5) * grid.cell - OX) * K, n = (grid.y1 - (r + 0.5) * grid.cell - OY) * K;
    gr[j] = ground(e, n);
    const tree = TREES.find(([te, tn]) => Math.hypot(e - te, n - tn) < 3);
    // a column with any roof over it is BUILDING (its roof returns are there), as the real rule has it
    if (e + 0.5 > -12.5 && e - 0.5 < 2.5 && n + 0.5 > 3.5 && n - 0.5 < 13.5) { kind[j] = S.BUILDING; top[j] = 6; }
    else if (tree) { const trunk = Math.floor(e) === Math.floor(tree[0]) && Math.floor(n) === Math.floor(tree[1]); kind[j] = S.TREE; top[j] = 9; for (let l = 0; l < nz; l++) { const z = z0 + l * dz; if (z >= gr[j] + (trunk ? 0 : 4) && z <= gr[j] + 9) mu[j * nz + l] = trunk ? 9 : 0.5; } }
    else if (e > -20 && e < 10 && Math.floor(n) === -12) { kind[j] = S.UNKNOWN; top[j] = 1.7; }
    if (kind[j] !== S.NOTHING && kind[j] !== S.TREE) { const lo = kind[j] === S.BUILDING ? 5 : 0; for (let l = 0; l < nz; l++) { const z = z0 + l * dz; if (z >= gr[j] + lo && z <= gr[j] + top[j]) mu[j * nz + l] = 9; } }
  }
  const meta = { tool: 'shade', at: '2026-11-04T12:00:00Z', grid, layers: { z0, dz, nz }, lidar: { url: 'x', name: 'the test flight', epoch: 2018, shift: [0.1, -0.2] }, photo: { id: 'p', date: '2018-07-01', source: 'test' }, rule: { kinds: { NOTHING: S.NOTHING, BUILDING: S.BUILDING, TREE: S.TREE, SOLID_TREE: S.SOLID_TREE, STRUCTURE: S.STRUCTURE, UNKNOWN: S.UNKNOWN } }, erased: 0 };
  return decodeModel(encodeModel(meta, { ground: gr, kind, top, mu }));
}
const M = model();
const L0 = gridsFromModel(M, { origin: ORIGIN, box: BOX, S, toMerc });
const G = L0.G;
const TH = (63 * Math.PI) / 180, SH = [5, -7];
const toAR = ([e, n]) => { const a = e - SH[0], b = n - SH[1]; return [Math.cos(-TH) * a - Math.sin(-TH) * b, Math.sin(-TH) * a + Math.cos(-TH) * b]; };
function seen(path, { reach = 6, noise = 0.03 } = {}) {
  const near = (e, n) => path.some(([pe, pn]) => Math.hypot(e - pe, n - pn) < reach);
  const stand = [], gr = [];
  const walls = [[[-12, 4], [2, 4]], [[2, 4], [2, 13]], [[-12, 4], [-12, 13]], [[-20, -11.5], [10, -11.5]]];
  for (const [[e0, n0], [e1, n1]] of walls) { const len = Math.hypot(e1 - e0, n1 - n0); for (let t = 0; t <= len; t += 0.1) { const e = e0 + ((e1 - e0) * t) / len, n = n0 + ((n1 - n0) * t) / len; if (near(e, n)) stand.push([e + (rnd() - 0.5) * noise, n + (rnd() - 0.5) * noise]); } }
  for (const [te, tn] of [[8.5, 3.5], [15.5, -5.5], [-18.5, -3.5]]) for (let k = 0; k < 40; k++) { const a = rnd() * 6.283; const e = te + 0.2 * Math.cos(a), n = tn + 0.2 * Math.sin(a); if (near(e, n)) stand.push([e, n]); }
  for (const [pe, pn] of path) for (let k = 0; k < 20; k++) { const a = rnd() * 6.283, r = 0.5 + rnd() * 4; const e = pe + r * Math.cos(a), n = pn + r * Math.sin(a); gr.push([e, n, ground(e, n) - 100 + (rnd() - 0.5) * noise]); }
  return { stand: stand.map((p) => toAR(p)), ground: gr.map(([e, n, y]) => [...toAR([e, n]), y - 1.3]) };
}
const truthAt = (T, p) => { const c = Math.cos(T.theta) * T.s, s = Math.sin(T.theta) * T.s; return [c * p[0] - s * p[1] + T.tx, s * p[0] + c * p[1] + T.ty]; };
const offAt = (T, mapPt) => { const g = truthAt(T, toAR(mapPt)); return Math.hypot(g[0] - mapPt[0], g[1] - mapPt[1]); };

// the grids
assert.ok(Math.abs(sample(G, G.dem, 10, -20) - ground(10, -20)) < 0.1, 'the slope (the shade map\'s ground, a 1 m column\'s)');
assert.ok(sample(G, G.dist, -11.9, 8) < 0.6, `a wall, 2 ft in from the roof\'s edge to within a column: ${sample(G, G.dist, -11.9, 8)}`);
assert.ok(sample(G, G.dist, -5, 8) > 2, 'inside the house is not solid');
assert.ok(sample(G, G.dist, 0, -11.5) < 0.3, 'the fence');
assert.ok(sample(G, G.dist, 22, 20) > 3, 'open lawn');
assert.ok(sample(G, G.dist, 8.5, 3.5) < 0.3 && sample(G, G.dist, 8.5 + 2.4, 3.5) > 1, `a tree is solid where the shade map's cubes have its trunk, open under its crown: ${sample(G, G.dist, 8.5, 3.5)} ${sample(G, G.dist, 10.9, 3.5)}`);
assert.ok(G.occTop && G.bld && G.wallTop, 'the tops and the roof mask come back for the overlay');
{
  const k = (e, n) => Math.floor((30 - n) / G.cell) * G.W + Math.floor((e + 30) / G.cell);
  assert.ok(Math.abs(G.occTop[k(0, -11.5)] - 1.7) < 0.01, `the fence\'s top is the shade map\'s: ${G.occTop[k(0, -11.5)]}`);
  assert.ok(Math.abs(G.wallTop[k(-5, 8)] - 6) < 0.01, 'the house\'s top');
  assert.equal(G.bld[k(-5, 8)], 1, 'under the roof');
  assert.equal(G.bld[k(20, 20)], 0, 'open lawn is not roof');
  assert.deepEqual(L0.counts.building > 0 && L0.counts.tree > 0 && L0.counts.unknown > 0, true, JSON.stringify(L0.counts));
  assert.match(L0.rule, /shade map's model of 2026-11-04.*summer photo/);
}
// past the house and a tree, from a GPS guess 8 m off and any turn: found to a few centimetres
{
  const path = [[-6, -1], [-2, -1], [2, -1], [6, -1], [8, -2]];
  const { stand, ground: gr } = seen(path);
  const fix = register(G, stand, gr, { at: [path[2][0] + 5, path[2][1] - 6], phone: toAR(path[2]), radiusM: 12 });
  assert.ok(fix.ok, `a fix: ${fix.why}`);
  // TO A COLUMN (2026-11-04): the shade map's model places a roof's edge and a trunk only to its 1 m column, so a fix
  // that rests on a wall's inset and a trunk is free by up to half a column each way; what the test proves is that
  // the fix is in the right column, not in the one next door
  for (const p of [[0, 0], [-12, 4], [15.5, -5.5]]) assert.ok(offAt(fix.T, p) < 1, `${p} within a column: ${offAt(fix.T, p).toFixed(3)}`);
  assert.ok(fix.hits > 0.8, `most points land: ${fix.hits}`);
  // from that fix, a small search a few steps on
  const next = seen([[6, -1], [8, -2], [10, -4]]);
  const fix2 = register(G, next.stand, next.ground, { T: fix.T }, { searchM: 1.5, searchDeg: 6 });
  assert.ok(fix2.ok && offAt(fix2.T, [0, 0]) < 1, `the next fix from the last: ${fix2.why || offAt(fix2.T, [0, 0]).toFixed(2)}`);
}
// GPS off the lidar read for the map: refused with a reason, not a crash (the owner's walk, 2026-11-03)
{
  const { stand, ground: gr } = seen([[0, -1], [4, -1]]);
  const fix = register(G, stand, gr, { at: [500, 500], phone: toAR([0, -1]), radiusM: 6 });
  assert.ok(!fix.ok && /off the edge of the lidar/.test(fix.why), fix.why);
}
// SCAN-H3: what the phone sees is mostly not in a thin lidar. The same walk with three times as many points that land
// nowhere (shrubs the flight missed): the share falls under 50% and it is refused, unless enough land in number
// (minLanded, offered when references are marked to judge the fix); searched within the 2 m the GPS guess is off
{
  const path = [[-6, -1], [-2, -1], [2, -1], [6, -1], [8, -2]];
  const { stand, ground: gr } = seen(path);
  const junk = []; for (let i = 0; i < stand.length * 2; i++) junk.push(toAR([-20 + rnd() * 40, -25 + rnd() * 8]));
  const prior = { at: [path[2][0] + 1, path[2][1] - 1], phone: toAR(path[2]), radiusM: 2 };
  const strict = register(G, [...stand, ...junk], gr, prior);
  assert.ok(!strict.ok && /lands on the lidar/.test(strict.why), `refused on share: ${strict.why}`);
  const lenient = register(G, [...stand, ...junk], gr, prior, { minLanded: 40 });
  assert.ok(lenient.ok && lenient.landed >= 40 && offAt(lenient.T, [0, 0]) < 1, `passed on number: ${lenient.why} ${lenient.landed}`);
}
// THE LAWN'S EDGE (scan/lib/surface.js): a straight fence alone slides along itself; grass meeting paving pins it
{
  const { lawnField } = await import('../lib/surface.js');
  const Gs = { ...G, lawnSd: lawnField([[[-25, -11], [6, -11], [6, -2], [-25, -2]]], [-30, -30, 30, 30], G.cell).sd };
  const { stand, ground: gr } = seen([[-10, -9], [-6, -9], [-2, -9]], { reach: 4 });
  const surf = [];
  for (let n = -10.5; n <= -3; n += 0.3) for (let e = 2; e <= 10; e += 0.3) surf.push([...toAR([e + (rnd() - 0.5) * 0.05, n]), e < 6 ? 'grass' : 'pave']);
  const prior = { T: { theta: TH + 0.03, tx: SH[0] + 1.2, ty: SH[1] - 0.3, s: 1 } };
  const without = register(G, stand, gr, prior, { searchM: 2.5, searchDeg: 6 });
  const withEdge = register(Gs, stand, gr, prior, { searchM: 2.5, searchDeg: 6, surface: surf });
  assert.ok(withEdge.ok, `with the lawn's edge, a fix: ${withEdge.why}`);
  // to within the edge's slack (15 cm either side, SURF_TOL) and the 0.3 m spacing of the colour samples
  assert.ok(offAt(withEdge.T, [0, -11.5]) < 0.45 && offAt(withEdge.T, [6, -6]) < 0.45, `pinned along the fence: ${offAt(withEdge.T, [6, -6]).toFixed(2)}`);
  assert.ok(!without.ok || offAt(without.T, [6, -6]) > offAt(withEdge.T, [6, -6]), `the fence alone does worse: ${without.why || offAt(without.T, [6, -6]).toFixed(2)}`);
  assert.ok(withEdge.surface.n > 100 && withEdge.surface.off < withEdge.surface.n * 0.1, `the surface lands: ${JSON.stringify(withEdge.surface)}`);
}
// a straight fence alone: two places fit, refused
{
  const { stand, ground: gr } = seen([[-10, -9], [-6, -9], [-2, -9]], { reach: 4 });
  const fix = register(G, stand, gr, { at: [-6 + 3, -9 - 4], phone: toAR([-6, -9]), radiusM: 10 });
  assert.ok(!fix.ok, `refused: ${fix.why}`);
}
// THE SAME THROUGH loadLidar (scan/lib/lidar-load.js), the one reading the AR page's worker and the twin check share:
// the model fetched from the site, the kinds read from the file's own codes
{
  const bytes = await packModel(M.meta, M.arrays); // as the site keeps it: gzipped
  const fetchFn = async (url) => (/id=map-1&tool=shade/.test(url) ? new Response(bytes) : new Response('no', { status: 404 }));
  const R = await loadLidar({ origin: ORIGIN, box: BOX, map: 'map-1', lawn: [[[-25, -11], [6, -11], [6, -2], [-25, -2]]] }, { toMerc, rule: async () => S, fetchFn });
  assert.ok(sample(R.G, R.G.dist, 0, -11.5) < 0.3 && sample(R.G, R.G.dist, -5, 8) > 2, 'the same grids');
  assert.ok(R.G.lawnSd && R.model.meta.at === M.meta.at && R.shade.K.BUILDING === S.BUILDING, 'the lawn edge, the model and the kinds');
  await assert.rejects(loadLidar({ origin: ORIGIN, box: BOX, map: 'map-2' }, { toMerc, rule: async () => S, fetchFn }), new RegExp(NO_MODEL.slice(0, 30)));
  // a file naming its kinds differently is read by its own codes
  const odd = decodeModel(encodeModel({ ...M.meta, rule: { kinds: { NOTHING: 9, BUILDING: 1, TREE: 2, SOLID_TREE: 3, STRUCTURE: 4, UNKNOWN: 5 } } }, M.arrays));
  assert.equal(kindsOf(odd, S).NOTHING, 9);
  // a mapping check that does not lean on the rule: one building column, found where it is
  const fake = { x0: 0, y1: 100, cell: 2, w: 50, h: 50 }, kind = new Uint8Array(2500); kind[10 * 50 + 20] = 1;
  const one = buildingsOnGrid(kind, fake, [-10, -10, 10, 10], 0.5, [41, 79], 1); // the column spans x 40-42, y 78-80: e and n -1..1
  let c = 0; for (const v of one) c += v;
  assert.equal(c, 16, 'a 2 m column is 16 half-metre cells');
  // THE COLUMN'S OWN RETURNS (shade findings 35, 2026-11-04): with `low` and `returns` in the file, a crown whose
  // pooled cubes reach the band is not solid unless its own lowest return is in the band, and a solid column is
  // drawn from that return up through its own cubes, not to the treetop
  {
    const g1 = { w: 3, h: 1, x0: OX - 1.5 / K, y1: OY + 0.5 / K, cell: 1 / K, lat: LAT }, nz = 12, z0 = 100;
    const gr = Float32Array.from([100.5, 100.5, 100.5]), kd = Uint8Array.from([S.TREE, S.TREE, S.UNKNOWN]), tp = Float32Array.from([9, 9, 1.7]);
    const mu = new Float32Array(3 * nz), ret = new Uint8Array(3 * nz);
    for (let j = 0; j < 3; j++) for (let l = 0; l < nz; l++) { const z = z0 + l; if (j < 2 && z >= 100.5 + 1 && z < 110) mu[j * nz + l] = 0.5; if (j === 2 && z <= 102) mu[j * nz + l] = 9; }
    // column 0: a trunk of its own from the ground (returns in every cube), low 0.6; column 1: pooled leaf low down
    // but its own returns only from 5 m up (low 5.2); column 2: a 1.7 m thing, own returns in cubes 0-1
    for (let l = 0; l < nz; l++) { if (z0 + l >= 101 && z0 + l < 110) ret[l] = 1; if (z0 + l >= 105.5 && z0 + l < 110) ret[nz + l] = 1; if (z0 + l <= 101) ret[2 * nz + l] = 1; }
    const lowA = Float32Array.from([0.6, 5.2, 0.5]);
    const mk = (extra) => gridsFromModel(decodeModel(encodeModel({ ...M.meta, grid: g1, layers: { z0, dz: 1, nz } }, { ground: gr, kind: kd, top: tp, mu, ...extra })), { origin: ORIGIN, box: [-1.5, -0.5, 1.5, 0.5], S, toMerc });
    const byMu = mk({}), byOwn = mk({ returns: ret, low: lowA });
    assert.equal(byMu.counts.standing, 3, 'by the pooled cubes all three stand');
    assert.equal(byOwn.counts.standing, 2, `by the column's own returns the pooled crown does not: ${byOwn.counts.standing}`);
    const at = (L, e) => L.G.occTop[Math.floor(0.5 / 0.25) * L.G.W + Math.floor((e + 1.5) / 0.25)];
    assert.ok(Math.abs(at(byOwn, -1) - 9) < 0.01 && Math.abs(at(byOwn, 1) - 1.5) < 0.01, `drawn through its own cubes: trunk ${at(byOwn, -1)}, low thing ${at(byOwn, 1)} (its top 1.7, its cubes end at 1.5)`);
    assert.ok(Math.abs(at(byMu, 0) - 9) < 0.01, 'without own returns, the old height');
  }
  // buildGrids refuses grids of the wrong size
  assert.throws(() => buildGrids({ dem: new Float32Array(3) }, BOX), /cells/);
}
// EACH WALL ON ITS OWN (owner, 2026-11-03: usually 2 ft in from the roof's edge, sometimes a foot or less, sometimes
// 10 ft for a porch or a sunroom). The roof here runs 3.5..13.5 north; its edge is near 3.6-4 in the mask.
{
  const line = (e0, n0, e1, n1, step = 0.1) => { const out = [], len = Math.hypot(e1 - e0, n1 - n0); for (let t = 0; t <= len; t += step) out.push([e0 + ((e1 - e0) * t) / len + (rnd() - 0.5) * 0.03, n0 + ((n1 - n0) * t) / len + (rnd() - 0.5) * 0.03]); return out; };
  const trunk = (te, tn) => Array.from({ length: 40 }, () => { const a = rnd() * 6.283; return [te + 0.2 * Math.cos(a), tn + 0.2 * Math.sin(a)]; });
  const groundNear = (pts) => pts.map(([pe, pn]) => { const a = rnd() * 6.283, r = 0.5 + rnd() * 4, e = pe + r * Math.cos(a), n = pn + r * Math.sin(a); return [...toAR([e, n]), ground(e, n) - 101.3]; });
  // pieces: an L corner is two pieces, a trunk stays one
  const L = [...line(0, 0, 4, 0), ...line(0, 0.1, 0, 4)], P = piecesOf(L);
  assert.equal(new Set(P.of.slice(8, 35)).size, 1, 'one wall is one piece (away from the corner, where points run no one way)');
  assert.notEqual(P.of[20], P.of[65], 'the two walls of a corner are two pieces');
  const tk = piecesOf(trunk(0, 0)); assert.equal(tk.n, 1, 'a trunk is one piece');
  // a porch: the south wall stands 3 m in from the roof's edge, the side walls 2 ft in, and two trees
  const map = [...line(-11.4, 6.5, 1.4, 6.5), ...line(1.9, 6.6, 1.9, 9), ...line(-11.9, 6.6, -11.9, 9), ...trunk(8.5, 3.5), ...trunk(15.5, -5.5)];
  const walk = [[-6, 0], [0, 0], [6, -1]];
  const stand = map.map(toAR), gr = groundNear(walk.flatMap((p) => Array(20).fill(p)));
  const fix = register(G, stand, gr, { at: [3, -6], phone: toAR([0, 0]), radiusM: 12 });
  assert.ok(fix.ok, `the porch: a fix: ${fix.why}`);
  for (const p of [[0, 0], [-12, 4], [15.5, -5.5]]) assert.ok(offAt(fix.T, p) < 0.5, `the porch: ${p} within 50 cm: ${offAt(fix.T, p).toFixed(3)}`);
  const porch = fix.walls.find((w) => w.insetM > 2);
  assert.ok(porch, `the porch wall found as a wall of its own, well in: ${JSON.stringify(fix.walls)}`);
  // the old way, every wall 2 ft in (the distance to the drawn walls), is pulled north by the porch wall
  const old = { ...G, inset: null, distNW: null, distRoof: null };
  const fixOld = register(old, stand, gr, { at: [3, -6], phone: toAR([0, 0]), radiusM: 12 });
  const offOld = fixOld.ok ? offAt(fixOld.T, [0, 0]) : Infinity;
  assert.ok(offOld > offAt(fix.T, [0, 0]), `the old way does worse: ${offOld.toFixed(2)} against ${offAt(fix.T, [0, 0]).toFixed(2)}`);
  // the roof's edge alone: the phone looks up at the gutters along the south and east edges, and the trees
  const gutters = [];
  const lowest = (f) => { let best = null; for (let x = 0; x <= 2; x += 0.01) { const [e, n] = f(x), d = sample(G, G.distRoof, e, n); if (!best || d < best.d) best = { d, p: [e, n] }; } return best; };
  for (let e = -12; e <= 2; e += 0.25) { const b = lowest((x) => [e, 3 + x]); if (b.d < 0.15) gutters.push(b.p); }
  for (let n = 4.5; n <= 13; n += 0.25) { const b = lowest((x) => [1 + x, n]); if (b.d < 0.15) gutters.push(b.p); }
  assert.ok(gutters.length > 60, `the roof's edge traced: ${gutters.length}`);
  const fixUp = register(G, [...trunk(8.5, 3.5), ...trunk(15.5, -5.5)].map(toAR), gr, { at: [3, -6], phone: toAR([0, 0]), radiusM: 12 }, { high: gutters.map(toAR) });
  assert.ok(fixUp.ok, `looking up: a fix: ${fixUp.why}`);
  assert.ok(fixUp.high.hits > 50, `the gutters land on the roof's edge: ${JSON.stringify(fixUp.high)}`);
  for (const p of [[0, 0], [-12, 4]]) assert.ok(offAt(fixUp.T, p) < 0.25, `looking up: ${p} within 25 cm: ${offAt(fixUp.T, p).toFixed(3)}`);
  // a crown high up, far from any roof, costs the same wherever the placement puts it, and is not a miss
  const T0 = { theta: TH, tx: SH[0], ty: SH[1], s: 1 }, crown = trunk(15.5, -5.5).map(toAR), tree = trunk(8.5, 3.5).map(toAR);
  const a = placementCost(G, tree, [], T0, { high: crown }), b = placementCost(G, tree, [], { ...T0, tx: T0.tx + 1 }, { high: crown });
  assert.ok(Math.abs(placementCost(G, [], [], T0, { high: crown }).cost - placementCost(G, [], [], { ...T0, ty: T0.ty + 1 }, { high: crown }).cost) < 1e-9, 'a crown costs the same anywhere');
  assert.ok(a.hits > 0.95 && a.cost < b.cost, `the tree still decides: ${a.hits} ${a.cost} ${b.cost}`);
}
console.log('lidar: ok');
