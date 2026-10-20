/**
 * Sprinkler heads (water session): the catalogue, a head's and a zone's water, pipes, GPS.
 *   node water/test/heads.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { catalogue, rowAt, headWater, zoneWater, headPsi, lineCheck, gpmAt, psiPer100ft, pipe, settle, calibrate, placeByGps, enu, unEnu, facing } from '../lib/heads.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const toy = {
  bodies: [
    { id: 't-spray-prs', brand: 'Toy', model: 'Spray PRS', kind: 'spray', regulatedPsi: 30, swappable: true, nozzleFamilies: ['t-fixed', 't-adj'] },
    { id: 't-rotor', brand: 'Toy', model: 'Rotor', kind: 'rotor', regulatedPsi: null, swappable: true, nozzleFamilies: ['t-rot'] },
  ],
  families: [
    { id: 't-fixed', brand: 'Toy', name: 'fixed', kind: 'spray', flow: 'arc', nozzles: [{ id: 't-15q', label: '15Q', arcFixed: 90, rows: [{ psi: 20, radiusFt: 12, gpm: 3.0 }, { psi: 30, radiusFt: 15, gpm: 3.7 }] }] },
    { id: 't-adj', brand: 'Toy', name: 'adjustable', kind: 'spray', flow: 'arc', nozzles: [{ id: 't-12a', label: '12A', arcFixed: null, arcMin: 0, arcMax: 360, rows: [{ psi: 30, radiusFt: 12, gpm: 2.6 }] }] },
    { id: 't-rot', brand: 'Toy', name: 'rotor', kind: 'rotor', flow: 'constant', nozzles: [{ id: 't-r3', label: '3.0', arcFixed: null, arcMin: 40, arcMax: 360, rows: [{ psi: 40, radiusFt: 34, gpm: 3.0 }, { psi: 50, radiusFt: 36, gpm: 3.4 }] }] },
  ],
};

test('every catalogue file in lib/heads reads, keeps its ids unique, and its rows are numbers', () => {
  const dir = new URL('../lib/heads/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
  const cat = catalogue(files);
  const ids = new Set();
  for (const f of cat.families) for (const n of f.nozzles) {
    assert.ok(!ids.has(n.id), `nozzle id ${n.id} twice`); ids.add(n.id);
    for (const r of n.rows) if (Number.isFinite(r.gpm)) { const throwFt = r.radiusFt ?? r.lengthFt; assert.ok(r.gpm > 0 && r.gpm < 60 && throwFt > 0 && throwFt < 120, `${n.id} ${JSON.stringify(r)}`); }
  }
  for (const b of cat.bodies) for (const fam of b.nozzleFamilies || []) assert.ok(cat.family(fam), `${b.id} takes ${fam}, not in the catalogue`);
  console.log(`     ${files.length} files, ${cat.bodies.length} bodies, ${cat.families.length} families, ${ids.size} nozzles`);
});

test("a nozzle's chart: linear between rows, held at the ends", () => {
  const n = toy.families[0].nozzles[0];
  assert.deepEqual(rowAt(n, 25), { psi: 25, radiusFt: 13.5, gpm: 3.35, widthFt: null, lengthFt: null, outside: false });
  assert.equal(rowAt(n, 50).gpm, 3.7); assert.equal(rowAt(n, 50).outside, true);
});

test('a head: a fixed quarter puts out a quarter of the full circle; a rotor its nozzle whatever the arc; a regulated body caps the pressure', () => {
  const cat = catalogue([toy]);
  const q = headWater({ body: 't-spray-prs', nozzle: 't-15q' }, cat, 60);
  assert.equal(q.psi, 30); assert.ok(Math.abs(q.gpm - 0.925) < 1e-9); assert.equal(q.arc, 90);
  // rate at head-to-head spacing: 96.25 x 3.7 / 15^2
  assert.ok(Math.abs(q.precipInH - 1.583) < 0.01, q.precipInH);
  const half = headWater({ body: 't-spray-prs', nozzle: 't-12a', arc: 180 }, cat, 45);
  assert.ok(Math.abs(half.gpm - 1.3) < 1e-9);
  const r90 = headWater({ body: 't-rotor', nozzle: 't-r3', arc: 90 }, cat, 45), r360 = headWater({ body: 't-rotor', nozzle: 't-r3', arc: 360 }, cat, 45);
  assert.equal(r90.gpm, r360.gpm);
  assert.ok(Math.abs(r90.precipInH - 4 * r360.precipInH) < 1e-9, 'a quarter-circle rotor lays its water on a quarter of the ground');
  assert.equal(headPsi({ regulatedPsi: 30 }, 25), 25);
});

test('a zone: its flow, its rate, and sprays mixed with rotors are flagged', () => {
  const cat = catalogue([toy]);
  const z = zoneWater([{ body: 't-spray-prs', nozzle: 't-15q' }, { body: 't-spray-prs', nozzle: 't-15q' }, { body: 't-rotor', nozzle: 't-r3', arc: 180 }, { body: 't-rotor' }], cat, 45);
  assert.equal(z.heads, 4); assert.equal(z.unknown, 1);
  assert.ok(Math.abs(z.gpm - (0.925 * 2 + 3.2)) < 1e-9);
  assert.equal(z.mixed, true);
});

test('pipes: 3/4 in Schedule 40 carries about 8.3 gpm under 5 ft/s; 1 in loses about 2.4 psi per 100 ft at 10 gpm', () => {
  assert.ok(Math.abs(gpmAt(pipe('pvc40-075')) - 8.31) < 0.05);
  assert.ok(Math.abs(psiPer100ft(pipe('pvc40-100'), 10) - 2.39) < 0.05);
  assert.equal(lineCheck('pe-075', 12).over, true);
  assert.equal(lineCheck('pe-100', 12).over, false);
});

test("GPS: a calibration takes out the phone's offset, a jump is dropped, and a head lands where it was stood on", () => {
  const ref = [-85.5, 43.0];
  const off = [3.2, -1.7]; // the phone reads 3.2 m east and 1.7 m south of the truth
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const fixesAt = (truth, n, jump = false) => Array.from({ length: n }, (_, k) => {
    const [e, nn] = [off[0] + rnd() * 1.2 + (jump && k === 3 ? 25 : 0), off[1] + rnd() * 1.2];
    const p = unEnu(truth, [e, nn]);
    return { lng: p[0], lat: p[1], acc: 4 };
  });
  const cal = calibrate(ref, fixesAt(ref, 20, true));
  assert.ok(Math.abs(cal.offsetM - Math.hypot(...off)) < 0.4, `offset ${cal.offsetM.toFixed(2)} m`);
  assert.ok(cal.jitterM < 1, `jitter ${cal.jitterM.toFixed(2)} m`);
  const head = unEnu(ref, [12, 8]);
  const placed = placeByGps(fixesAt(head, 5), cal);
  const miss = enu(head, placed.at);
  assert.ok(Math.hypot(...miss) < 0.6, `missed by ${Math.hypot(...miss).toFixed(2)} m`);
  assert.equal(settle([]), null);
  // a fix from before the GPS locked on, far away, is not part of the calibration
  const cal2 = calibrate(ref, [{ lng: 0, lat: 0, acc: 5 }, ...fixesAt(ref, 10)]);
  assert.ok(Math.abs(cal2.offsetM - Math.hypot(...off)) < 0.5, `with a stray fix: ${cal2.offsetM.toFixed(2)} m`);
});

test('a part-circle head faces the middle of the lawn by default', () => {
  const at = [-85.5, 43.0];
  assert.ok(Math.abs(facing(at, unEnu(at, [0, 10])) - 0) < 1e-6);
  assert.ok(Math.abs(facing(at, unEnu(at, [10, 0])) - 90) < 1e-6);
  assert.ok(Math.abs(facing(at, unEnu(at, [-10, 0])) - 270) < 1e-6);
});

test("Rain Bird's own charts: a 4-VAN at a quarter reads its printed quarter, a strip is a rectangle, a 15Q is a quarter of its circle", () => {
  const cat = catalogue([JSON.parse(readFileSync(new URL('../lib/heads/rainbird-sprays.json', import.meta.url), 'utf8'))]);
  const van = headWater({ body: 'rb-1804-prs', nozzle: 'rb-van-4', arc: 90 }, cat, 50);
  assert.equal(van.psi, 30); assert.ok(Math.abs(van.gpm - 0.29) < 1e-9, `4-VAN at 90: ${van.gpm}`);
  const strip = headWater({ body: 'rb-1804-prs', nozzle: 'rb-mpr-15est' }, cat, 30);
  assert.ok(strip.strip && strip.strip.widthFt > 0 && strip.strip.lengthFt > 0 && strip.gpm > 0, JSON.stringify(strip));
  const q = headWater({ body: 'rb-1804-prs', nozzle: cat.families.find((f) => f.id === 'rb-mpr').nozzles.find((x) => x.label === '15Q').id }, cat, 30);
  assert.equal(q.arc, 90); assert.ok(q.gpm > 0.8 && q.gpm < 1.0, `15Q ${q.gpm}`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water heads: ${tests.length} passed`);
