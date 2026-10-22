/**
 * The pipe laid as an installer lays it (lib/layout.js), and the radius screw (lib/heads.js, lib/precip.js).
 *   node water/test/layout.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { layout } from '../lib/layout.js';
import { enu, unEnu, catalogue, headWater, sprayBodyId } from '../lib/heads.js';
import { precipitation, screwedProfile, profileAt, profileMean, setProfiles } from '../lib/precip.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const o = [-85.5, 43.0];
const P = (e, n) => unEnu(o, [e, n]);
// a 30 x 20 m lawn; a house 10-20 x 8-14; a tree at (24, 4), 3 m round; a drive 26-30 x 10-20
const ground = (at) => {
  const [e, n] = enu(o, at);
  const building = e > 10 && e < 20 && n > 8 && n < 14, canopy = Math.hypot(e - 24, n - 4) < 3, paved = e > 26 && e < 30 && n > 10 && n < 20;
  return { building, canopy, paved, lawn: e >= 0 && e <= 30 && n >= 0 && n <= 20 && !building && !paved };
};
const ring = [[1, 1], [9, 1], [17, 1], [25, 1], [29, 1], [1, 7], [1, 13], [1, 19], [9, 19], [17, 19], [24, 19]].map(([e, n], k) => ({ id: `a${k}`, at: P(e, n) }));

test('a zone round a house: never through it, never under the tree, square runs, every head on the tree', () => {
  const L = layout({ pvb: P(15, 7.6), boxes: [{ id: 'b1', at: P(9, 7) }], zones: [{ n: 1, box: 'b1', heads: ring }], bearing: 0, ground });
  const t = L.zones.get(1), byId = new Map(t.nodes.map((n) => [n.id, n]));
  assert.equal(t.nodes.filter((n) => n.kind === 'head').length, ring.length);
  let inHouse = 0, underTree = 0;
  for (const n of t.nodes) {
    if (!n.parent) continue;
    const a = enu(o, byId.get(n.parent).at), b = enu(o, n.at);
    if (n.kind !== 'head') assert.ok(Math.abs(a[0] - b[0]) < 0.3 || Math.abs(a[1] - b[1]) < 0.3, `a diagonal run ${a} -> ${b}`);
    for (let s = 0; s <= 20; s++) {
      const x = a[0] + ((b[0] - a[0]) * s) / 20, y = a[1] + ((b[1] - a[1]) * s) / 20;
      if (x > 10.2 && x < 19.8 && y > 8.2 && y < 13.8) inHouse++;
      if (n.kind !== 'head' && Math.hypot(x - 24, y - 4) < 2.5) underTree++;
    }
    assert.ok(n.lenFt > 0 && n.lenFt < 120);
  }
  assert.equal(inHouse, 0, 'a run through the house');
  assert.equal(underTree, 0, 'a run under the tree');
  // the main, backflow preventer to valve box, routed too
  assert.ok(L.main[0].lenM > 5 && L.main[0].lenM < 12, `main ${L.main[0].lenM}`);
});

test('two zones on one valve box share the trench out of it rather than running side by side', () => {
  const near = ring.slice(0, 5), far = ring.slice(7).map((h) => ({ ...h, id: `b${h.id}` }));
  const L = layout({ pvb: P(15, 7.6), boxes: [{ id: 'b1', at: P(9, 7) }], zones: [{ n: 1, box: 'b1', heads: near }, { n: 2, box: 'b1', heads: far }], bearing: 0, ground });
  assert.ok(L.zones.get(1) && L.zones.get(2));
  const len = (z) => L.zones.get(z).nodes.reduce((s, n) => s + (n.parent ? n.lenFt : 0), 0);
  assert.ok(len(1) < 200 && len(2) < 200, `${len(1)} ${len(2)}`);
});

test('the radius screw: a rotary nozzle keeps its rate, a rotor keeps its flow, a spray loses some', () => {
  const dir = new URL('../lib/heads/', import.meta.url);
  const cat = catalogue(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'))));
  const pick = (kind) => cat.families.find((f) => f.kind === kind && f.nozzles.some((z) => !Number.isFinite(z.arcFixed) && !z.strip))?.nozzles.find((z) => !Number.isFinite(z.arcFixed) && !z.strip);
  for (const [kind, body] of [['rotary', sprayBodyId(4, null)], ['spray', sprayBodyId(4, null)]]) {
    const z = pick(kind), full = headWater({ body, nozzle: z.id, arc: 180 }, cat, 40), cut = headWater({ body, nozzle: z.id, arc: 180, throw: 0.8 }, cat, 40);
    assert.ok(Math.abs(cut.radiusFt - 0.8 * full.radiusFt) < 1e-9 && Math.abs(cut.fullRadiusFt - full.radiusFt) < 1e-9);
    if (kind === 'rotary') assert.ok(Math.abs(cut.precipInH - full.precipInH) / full.precipInH < 0.01, 'matched precipitation');
    else assert.ok(cut.gpm < full.gpm && cut.precipInH > full.precipInH, 'a throttled spray: less flow, a higher rate');
  }
  const rb = cat.bodies.find((b) => b.kind === 'rotor' && cat.familiesFor(b.id).some((f) => f.nozzles.length));
  const rz = cat.familiesFor(rb.id).find((f) => f.nozzles.length).nozzles[0];
  const rf = headWater({ body: rb.id, nozzle: rz.id, arc: 180 }, cat, 45), rc = headWater({ body: rb.id, nozzle: rz.id, arc: 180, throw: 0.75 }, cat, 45);
  assert.equal(rc.gpm, rf.gpm, 'a rotor screw does not change the flow');
  assert.ok(Math.abs(rc.precipInH / rf.precipInH - 1 / 0.5625) < 0.01, 'its rate rises as 1/k^2');
});

test("a screwed-down rotor's water piles up past the first metres, and still adds up to its flow", () => {
  setProfiles(JSON.parse(readFileSync(new URL('../lib/hydraulics/profiles.json', import.meta.url), 'utf8')));
  const base = [[0, 1], [0.5, 1], [0.8, 0.8], [1, 0.2]], k = 0.71, R = 12.8;
  const s = screwedProfile(base, k, R);
  const ratio = (rho) => profileAt(s, rho) / profileMean(s) / (profileAt(base, rho * k) / profileMean(base));
  assert.ok(ratio(0.7) > ratio(0.1) * 1.8, `mid-throw ${ratio(0.7).toFixed(2)} vs near ${ratio(0.1).toFixed(2)}`);
  const cell = 0.25, W = 120, H = 120, at = (c, r) => unEnu(o, [(c - 60 + 0.5) * cell, (60 - r - 0.5) * cell]);
  const p = precipitation({ W, H, cellM: cell, at, lawn: () => true }, [{ zone: 1, at: o, gpm: 3, radiusM: R * k, cut: k, arc: 360, dir: 0, profile: 'rotor' }]);
  const a = p.byZone.get(1); let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i];
  const gpm = (sum * cell * cell * 10.7639) / 96.25;
  assert.ok(Math.abs(gpm - 3) / 3 < 0.05, `adds up to ${gpm.toFixed(2)} gpm`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water layout: ${tests.length} passed`);
