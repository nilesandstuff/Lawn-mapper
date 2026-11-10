// scan/lib/lidar-marks.js: straight edges and corners from the laser's returns. node scan/test/lidar-marks.test.js
import assert from 'node:assert/strict';
import { lidarMarks, snapTo } from '../lib/lidar-marks.js';

let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
// a 40 x 30 m patch at about 4 returns a square metre (the owner's 2018 flight), returns scattered at random
const P = [];
const inRect = (e, n, x0, y0, x1, y1) => e >= x0 && e <= x1 && n >= y0 && n <= y1;
const deckLow = (e, n) => inRect(e, n, 5, 5, 17, 13) || inRect(e, n, 5, 13, 10, 18);     // an L, 1.7 m up
const deckHigh = (e, n) => inRect(e, n, 12, 8, 17, 13);                                    // its upper level, 3.1 m up
const wall = (e, n) => inRect(e, n, 25, 4, 33, 4.5);                                       // a stone wall, 1.8 m, 0.5 thick
const tub = (e, n) => Math.hypot(e - 30, n - 20) <= 1.1;                                   // a round hot tub, 1 m
for (let i = 0; i < 40 * 30 * 4; i++) {
  const e = rnd() * 40, n = rnd() * 30;
  let h = 0;
  if (deckHigh(e, n)) h = 3.1; else if (deckLow(e, n)) h = 1.7; else if (wall(e, n)) h = 1.8; else if (tub(e, n)) h = 1.0;
  P.push({ e, n, h: h + (rnd() - 0.5) * 0.05 });
}
const pts = { n: P.length, e: (i) => P[i].e, nn: (i) => P[i].n, hag: (i) => P[i].h, bright: () => 0, kind: () => 3 };
const M = lidarMarks([0, 0, 40, 30], pts);
const inRingT = (ring, [x, y]) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const near = (at, want) => Math.hypot(at[0] - want[0], at[1] - want[1]);
const best = (want) => Math.min(...M.corners.map((c) => near(c.at, want)));

assert.ok(M.spacing > 0.4 && M.spacing < 0.6, `return spacing ${M.spacing}`);
// the deck's six outer corners and the upper level's four, each found
const deck = [[5, 5], [17, 5], [17, 13], [10, 13], [10, 18], [5, 18]], high = [[12, 8], [17, 8], [17, 13], [12, 13]];
const errs = [...deck, ...high].map(best);
console.log(`deck corners: ${errs.map((x) => (x * 3.281).toFixed(1)).join(', ')} ft off (median ${(errs.sort((a, b) => a - b)[errs.length >> 1] * 3.281).toFixed(1)})`);
assert.ok(errs.every((x) => x < 0.45), 'every deck corner within 0.45 m');
assert.ok(errs[errs.length >> 1] < 0.25, 'the median within 0.25 m');
// the wall: its long sides exact; its ends only as sure as the laser's last hits on its top, and said so
const wallObj = M.objects.find((o) => near(o.middle, [29, 4.25]) < 3 && o.ring);
assert.ok(wallObj, 'the wall is one thing');
const vs = wallObj.ring.map((p) => p[1]);
assert.ok(Math.abs(Math.min(...vs) - 4) < 0.15 && Math.abs(Math.max(...vs) - 4.5) < 0.15, `the wall's faces: ${vs.map((v) => v.toFixed(2))}`);
const wallCorners = M.corners.filter((c) => c.of === wallObj.id && c.kind === 'corner');
for (const c of wallCorners) {
  const e = Math.min(...[[25, 4], [33, 4], [33, 4.5], [25, 4.5]].map((w) => near(c.at, w)));
  if (c.sure) assert.ok(e < 0.4, `a corner said to be sure is within 0.4 m (${e.toFixed(2)})`);
  else assert.ok(c.within === null || c.within > 0.3, 'an unsure corner says how unsure');
}
console.log(`wall corners: ${wallCorners.map((c) => `${(Math.min(...[[25, 4], [33, 4], [33, 4.5], [25, 4.5]].map((w) => near(c.at, w))) * 3.281).toFixed(1)} ft${c.sure ? '' : ' (unsure)'}`).join(', ')}`);
// every deck corner is sure
assert.ok(M.corners.filter((c) => c.kind === 'corner' && near(c.at, [11, 11]) < 9).every((c) => c.sure), 'the deck\'s corners are sure');
// the hot tub: round, so its middle
const tubMark = M.corners.find((c) => near(c.at, [30, 20]) < 0.5);
assert.ok(M.corners.some((c) => c.kind === 'middle' && near(c.at, [30, 20]) < 0.4), 'a small round thing is marked by its middle');
// two levels of the deck: two objects over it, the upper one about 3.1 m up
const overDeck = M.objects.filter((o) => near(o.middle, [11, 11]) < 6);
assert.equal(overDeck.length, 2); assert.ok(overDeck.some((o) => Math.abs(o.top - 3.1) < 0.2) && overDeck.some((o) => Math.abs(o.top - 1.7) < 0.2));
// snapping
assert.ok(near(snapTo(M, [17.3, 4.8], 1).at, [17, 5]) < 0.45); assert.equal(snapTo(M, [2, 25], 1), null);
console.log('lidar-marks: ok');

// paving by the ground's brightness (the owner's lot, 2026-11-10: a concrete drive darker than the grass, meeting a
// blacktop road darker still; a lighter patch of the neighbour's grass; the ground under the woods dark too), each
// overlapping the next in brightness as a real flight's does
{
  let sd = 5; const r = () => { sd = (sd + 0x6d2b79f5) | 0; let t = Math.imul(sd ^ (sd >>> 15), 1 | sd); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const Q = [];
  const drive = (e, n) => e >= 8 && e <= 14 && n >= 5 && n <= 19, road = (e, n) => e >= 30 && e <= 37;
  const pale = (e, n) => e >= 16 && e <= 24 && n >= 20 && n <= 26, woods = (e, n) => e <= 5;
  const lane = (e, n) => e >= 14 && e <= 30 && n >= 10 && n <= 14; // the drive's run out to the road
  for (let i = 0; i < 40 * 30 * 4; i++) {
    const e = r() * 40, n = r() * 30;
    const b = road(e, n) ? 40 : drive(e, n) || lane(e, n) ? 75 : pale(e, n) ? 160 : woods(e, n) ? 50 : 120;
    Q.push({ e, n, h: 0, b: b + 18 * g(), kind: 0 });
    if (woods(e, n)) Q.push({ e, n, h: 9, b: 0, kind: 2 });
  }
  const R2 = lidarMarks([0, 0, 40, 30], { n: Q.length, e: (i) => Q[i].e, nn: (i) => Q[i].n, hag: (i) => Q[i].h, bright: (i) => Q[i].b, kind: (i) => Q[i].kind });
  const pv = R2.objects.filter((o) => o.kind === 'paving');
  console.log(`paving: ${pv.map((o) => `${o.area} m2 at ${o.middle.map((x) => x.toFixed(0))}`).join('; ')}`);
  const drv = pv.find((o) => inRingT(o.ring, [11, 8]));
  assert.ok(drv, 'the drive is found, darker than the grass');
  const dc = [[8, 5], [14, 5], [8, 19], [14, 19]].map((w) => Math.min(...R2.corners.filter((c) => c.of === drv.id).map((c) => near(c.at, w))));
  console.log(`drive corners: ${dc.map((x) => (x * 3.281).toFixed(1)).join(', ')} ft off`);
  assert.ok(dc.every((x) => x < 0.7), 'its four outer corners within 0.7 m (brightness is noisy)');
  assert.ok(!drv.ring.some(([e]) => e > 31), 'the drive is not run into the road');
  assert.ok(R2.corners.filter((c) => c.of === drv.id && c.kind === 'corner').every((c) => !c.sure), 'and no corner of it is said to be sure');
  assert.ok(!pv.some((o) => inRingT(o.ring, [20, 23])), 'the lighter grass is not paving');
  assert.ok(!pv.some((o) => o.middle[0] < 5), 'nor the ground under the woods');
  console.log('lidar-marks (paving): ok');
}

// the woods and a house with a deck against it (the owner, 2026-11-10: shapes all over the woods, the deck a building)
{
  let sd = 9; const r = () => { sd = (sd + 0x6d2b79f5) | 0; let t = Math.imul(sd ^ (sd >>> 15), 1 | sd); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; // mulberry32: the LCG above lays 3-call points in stripes
  const Q = [];
  const house = (e, n) => e >= 5 && e <= 17 && n >= 5 && n <= 15;          // a pitched roof, eaves 4.5 m, ridge 7 m
  const deck = (e, n) => e >= 17 && e <= 22 && n >= 7 && n <= 12;           // level, 3 m up, against the house
  const woods = (e, n) => e >= 30;                                          // crowns over everything east of 30 m
  const log = (e, n) => e >= 38 && e <= 41 && n >= 10 && n <= 12;           // a solid thing in the woods, 0.8 m
  for (let i = 0; i < 50 * 25 * 4; i++) {
    const e = r() * 50, n = r() * 25;
    let h = 0, kind = 0;
    if (house(e, n)) { h = 7 - 2.5 * Math.abs(n - 10) / 5; kind = 1; } else if (deck(e, n)) { h = 3; kind = 1; } else if (log(e, n)) { h = 0.8; kind = 3; }
    Q.push({ e, n, h: h + (r() - 0.5) * 0.05, kind });
    if (woods(e, n) && !log(e, n)) Q.push({ e, n, h: 8 + r() * 6, kind: 2 });
  }
  const R3 = lidarMarks([0, 0, 50, 25], { n: Q.length, e: (i) => Q[i].e, nn: (i) => Q[i].n, hag: (i) => Q[i].h, bright: () => 0, kind: (i) => Q[i].kind });
  const bld = R3.objects.filter((o) => o.kind === 'building'), obj = R3.objects.filter((o) => o.kind === 'object');
  assert.equal(bld.length, 1, 'one building, the house');
  assert.ok(near(bld[0].middle, [11, 10]) < 1, 'the house outlined without its deck');
  assert.ok(obj.some((o) => near(o.middle, [19.5, 9.5]) < 1 && Math.abs(o.top - 3) < 0.3), 'the deck a thing of its own');
  assert.ok(!R3.objects.some((o) => o.middle[0] > 30), 'nothing in the woods');
  console.log('lidar-marks (woods, deck): ok');
}
