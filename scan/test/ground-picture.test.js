// scan/lib/ground-picture.js: the ground alone, hard-edged, and a strip's width read off it. node scan/test/ground-picture.test.js
import assert from 'node:assert/strict';
import { groundPicture, stripWidth } from '../lib/ground-picture.js';

const rng = (seed) => { let sd = seed; return () => { sd = (sd + 0x6d2b79f5) | 0; let t = Math.imul(sd ^ (sd >>> 15), 1 | sd); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
// a 70 x 50 m lot at the owner's flight's density (a return every 0.72 m): grass, a concrete drive of a known width
// running 40 m at 20 degrees to the grid, into a blacktop road; a house (no ground returns) beside the drive
function lot(seed, driveW, noise) {
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const th = (20 * Math.PI) / 180, ux = Math.cos(th), uy = Math.sin(th), P = [];
  const n = Math.round((70 * 50) / (0.72 * 0.72));
  for (let i = 0; i < n; i++) {
    const e = r() * 70, nn = r() * 50;
    const dx = e - 8, dy = nn - 12, along = dx * ux + dy * uy, across = -dx * uy + dy * ux;
    const road = e >= 60, drive = along >= 0 && Math.abs(across) <= driveW / 2 && !road;
    const house = along > 5 && along < 20 && across > driveW / 2 + 3 && across < driveW / 2 + 12;
    if (house) { P.push({ e, n: nn, h: 5, b: 30000 }); continue; }
    P.push({ e, n: nn, h: (r() - 0.5) * 0.06, b: (road ? 9000 : drive ? 17000 : 38000) + noise * g() });
  }
  return { n: P.length, e: (i) => P[i].e, nn: (i) => P[i].n, hag: (i) => P[i].h, bright: (i) => P[i].b, kind: () => 0 };
}
const ring = [[2, 2], [58, 2], [58, 48], [2, 48]];
const TRUE = 3.66; // 12 ft
const got = [];
for (let seed = 1; seed <= 8; seed++) {
  const pic = groundPicture([0, 0, 70, 50], lot(seed, TRUE, 5000));
  const w = stripWidth(pic, ring);
  assert.ok(w, `seed ${seed}: a strip is found`);
  got.push(w.widthM);
  if (seed === 1) {
    assert.ok(Math.abs(pic.cell - 0.18) < 0.02, `a grid four times as fine as the returns (${pic.cell})`);
    assert.ok(w.lengthM > 25, `the long straight run (${w.lengthM.toFixed(0)} m)`);
    // hard edges: every cell is well away from mid grey, or is the flat grey of no ground
    const k = (e, n) => (Math.floor((50 - n) / pic.cell) * pic.W + Math.floor(e / pic.cell)) * 4;
    for (let i = 0; i < pic.W * pic.H; i++) { const v = pic.rgba[i * 4]; assert.ok(v <= 90 || v >= 165 || v === 128, `no soft greys (${v})`); }
    const drive = pic.rgba[k(8 + 20 * Math.cos(0.349), 12 + 20 * Math.sin(0.349))], road = pic.rgba[k(65, 25)], grass = pic.rgba[k(30, 40)];
    assert.ok(grass >= 165 && drive <= 90 && road < drive, `grass light (${grass}), concrete dark (${drive}), blacktop darker (${road})`);
  }
}
const mean = got.reduce((s, v) => s + v, 0) / got.length, worst = Math.max(...got.map((v) => Math.abs(v - TRUE)));
console.log(`a ${TRUE} m drive, 8 lots: read ${got.map((v) => v.toFixed(2)).join(', ')} m (mean ${mean.toFixed(2)}, worst ${worst.toFixed(2)} m off)`);
assert.ok(Math.abs(mean - TRUE) < 0.1, 'no lean: the mean within 0.1 m');
assert.ok(worst < 0.25, 'each lot within 0.25 m');
// other widths, so the answer is not the method's own favourite number
for (const tw of [2.7, 5.0]) {
  const w = stripWidth(groundPicture([0, 0, 70, 50], lot(11, tw, 5000)), ring);
  console.log(`a ${tw} m drive: read ${w.widthM.toFixed(2)} m`);
  assert.ok(Math.abs(w.widthM - tw) < 0.25, `a ${tw} m drive within 0.25 m`);
}
console.log('ground-picture: ok');
