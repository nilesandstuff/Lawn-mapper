/**
 * Sprinkler heads (water session): the catalogue, a head's and a zone's water, pipes, GPS.
 *   node water/test/heads.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { autoArc, fitArcs } from '../lib/arcs.js';
import { precipitation, rateAt, setProfiles } from '../lib/precip.js';
import { catalogue, rowAt, headWater, zoneWater, headPsi, lineCheck, gpmAt, psiPer100ft, pipe, settle, calibrate, placeByGps, enu, unEnu, facing, sprayBodyId, seriesOf, nozzleRiseIn, SPRAY_POP_IN, SPRAY_REG_PSI } from '../lib/heads.js';

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

test("Toro's TVAN reads its printed quarter (0.71 gpm at 30 psi), not its full circle scaled down", () => {
  const cat = catalogue([JSON.parse(readFileSync(new URL('../lib/heads/other-brands.json', import.meta.url), 'utf8'))]);
  const body = cat.bodies.find((b) => (b.nozzleFamilies || []).includes('to-tvan'));
  const w = headWater({ body: body?.id, nozzle: 'to-tvan8', arc: 90 }, cat, 30);
  assert.ok(Math.abs(w.gpm - 0.71) < 1e-9, `TVAN8 at 90: ${w.gpm}`);
  assert.ok(!cat.brands.includes('Orbit') || cat.bodies.some((b) => b.brand === 'Orbit' && cat.charted(b)), 'a brand with no chart is not offered');
});

test('arcs: a corner head waters its quarter of the lawn, an edge head its half, a head mid-lawn a full circle; a fixed half faces the lawn; the throw stops short of a drive', () => {
  const ref = [-85.5, 43.0];
  // the lawn: x 0-20 m, y 0-20 m; a drive beyond x > 20; anything else other ground
  const ground = (p) => { const [x, y] = enu(ref, p); return x > 20 ? 'hard' : x >= 0 && y >= 0 && y <= 20 ? 'lawn' : 'other'; };
  const adj = { arcFixed: null, arcMin: 45, arcMax: 360 };
  const corner = autoArc(ref, 5, adj, ground);
  assert.ok(Math.abs(corner.arc - 90) <= 10 && Math.abs(corner.dir - 45) <= 10, JSON.stringify(corner));
  const edge = autoArc(unEnu(ref, [10, 0]), 5, adj, ground);
  assert.ok(Math.abs(edge.arc - 180) <= 10 && (edge.dir <= 10 || edge.dir >= 350), JSON.stringify(edge));
  const mid = autoArc(unEnu(ref, [10, 10]), 5, adj, ground);
  assert.equal(mid.arc, 360);
  const half = autoArc(unEnu(ref, [10, 0]), 5, { arcFixed: 180 }, ground);
  assert.ok(half.arc === 180 && (half.dir <= 10 || half.dir >= 350), JSON.stringify(half));
  // 3 m from the drive with a 5 m throw: an adjustable head turns its arc off the drive (more lawn watered
  // than a full circle cut short); a full-circle nozzle, which cannot turn away, is shortened, never below 75%
  const nearDrive = autoArc(unEnu(ref, [17, 10]), 5, adj, ground);
  assert.ok(nearDrive.arc < 360 && nearDrive.hardShare <= 0.15, JSON.stringify(nearDrive));
  const fullNearDrive = autoArc(unEnu(ref, [17, 10]), 5, { arcFixed: 360 }, ground);
  assert.ok(fullNearDrive.throw < 1 && fullNearDrive.throw >= 0.75, JSON.stringify(fullNearDrive));
});

test('precipitation: every head\'s water adds back up to its gpm over the ground; a quarter puts the same gpm on a quarter of the area; two heads head to head even out', () => {
  const ref = [-85.5, 43.0], cellM = 0.25, W = 120, H = 120;
  const grid = { W, H, cellM, at: (c, r) => unEnu(ref, [(c + 0.5) * cellM - 15, (r + 0.5) * cellM - 15]), lawn: () => true };
  const total = (a) => a.reduce((s, v) => s + v, 0) * cellM * cellM * 10.7639 / 96.25; // in/h x ft2 -> gpm
  for (const h of [{ zone: 1, at: ref, gpm: 3.7, radiusM: 4.6, arc: 360, dir: 0, kind: 'spray' }, { zone: 1, at: ref, gpm: 0.93, radiusM: 4.6, arc: 90, dir: 45, kind: 'spray' }, { zone: 1, at: ref, gpm: 0.5, radiusM: 0, arc: null, dir: 90, kind: 'spray', strip: { type: 'end', lengthM: 4.5, widthM: 1.0 } }]) {
    const p = precipitation(grid, [h]);
    assert.ok(Math.abs(total(p.byZone.get(1)) - h.gpm) / h.gpm < 0.04, `${h.arc ?? 'strip'}: ${total(p.byZone.get(1)).toFixed(3)} gpm vs ${h.gpm}`);
  }
  // the quarter's rate is the full circle's (matched precipitation)
  const fullR = rateAt({ gpm: 3.7, radiusM: 4.6, arc: 360, dir: 0, kind: 'spray' }, 1, 1), quarterR = rateAt({ gpm: 0.925, radiusM: 4.6, arc: 90, dir: 45, kind: 'spray' }, 1, 1);
  assert.ok(Math.abs(fullR - quarterR) < 1e-9);
  // a single head: no even coverage; heads at head-to-head spacing in a row: better
  const one = precipitation({ ...grid, lawn: (i) => { const r = Math.floor(i / W), c = i % W; return Math.abs((c + 0.5) * cellM - 15) < 4 && Math.abs((r + 0.5) * cellM - 15) < 4; } }, [{ zone: 1, at: ref, gpm: 3.7, radiusM: 4.6, arc: 360, dir: 0, kind: 'spray' }]);
  const row = [];
  for (let x = -9.2; x <= 9.2; x += 4.6) for (let y = -9.2; y <= 9.2; y += 4.6) row.push({ zone: 1, at: unEnu(ref, [x, y]), gpm: 3.7, radiusM: 4.6, arc: 360, dir: 0, kind: 'spray' });
  const many = precipitation({ ...grid, lawn: (i) => { const r = Math.floor(i / W), c = i % W; return Math.abs((c + 0.5) * cellM - 15) < 4 && Math.abs((r + 0.5) * cellM - 15) < 4; } }, row);
  assert.ok(many.du > one.du, `DU ${one.du.toFixed(2)} alone, ${many.du.toFixed(2)} head to head`);
});

test("precipitation with the measured spreads: each still adds back up to its gpm, and rotors at head-to-head spacing are as even as the research's own zero-wind simulations (69-90%)", () => {
  setProfiles(JSON.parse(readFileSync(new URL('../lib/hydraulics/profiles.json', import.meta.url), 'utf8')));
  const ref = [-85.5, 43.0], cellM = 0.25, W = 160, H = 160;
  const grid = { W, H, cellM, at: (c, r) => unEnu(ref, [(c + 0.5) * cellM - 20, (r + 0.5) * cellM - 20]), lawn: () => true };
  const total = (a) => a.reduce((s, v) => s + v, 0) * cellM * cellM * 10.7639 / 96.25;
  for (const profile of ['rotor', 'rotor-la', 'rotary', 'spray-he', 'spray', 'impact']) {
    const h = { zone: 1, at: ref, gpm: 2, radiusM: 5, arc: 360, dir: 0, profile };
    const got = total(precipitation(grid, [h]).byZone.get(1));
    assert.ok(Math.abs(got - 2) / 2 < 0.05, `${profile}: ${got.toFixed(3)} gpm vs 2`);
  }
  // rotors on a 10 m square grid, each throwing 10 m (head to head): the middle square's uniformity
  const heads = [];
  for (let x = -20; x <= 20; x += 10) for (let y = -20; y <= 20; y += 10) heads.push({ zone: 1, at: unEnu(ref, [x, y]), gpm: 3, radiusM: 10, arc: 360, dir: 0, profile: 'rotor' });
  const mid = (i) => { const r = Math.floor(i / W), c = i % W, x = (c + 0.5) * cellM - 20, y = (r + 0.5) * cellM - 20; return x >= 0 && x < 10 && y >= 0 && y < 10; };
  const p = precipitation({ ...grid, lawn: mid }, heads);
  assert.ok(p.du >= 0.6 && p.du <= 0.95, `rotors head to head: DU ${p.du.toFixed(2)}`);
  console.log(`     rotors head to head, zero wind: DU ${(p.du * 100).toFixed(0)}%`);
});

test('a spray body is only its height and its regulator: one for each, taking every swappable nozzle', () => {
  const dir = new URL('../lib/heads/', import.meta.url);
  const cat = catalogue(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'))));
  for (const pop of SPRAY_POP_IN) for (const reg of SPRAY_REG_PSI) assert.ok(cat.body(sprayBodyId(pop, reg)), `${pop} ${reg}`);
  const b = cat.body(sprayBodyId(4, null));
  const rvan = cat.families.find((f) => /r-van/i.test(f.id) && !/strip/.test(f.id));
  assert.ok(rvan && b.nozzleFamilies.includes(rvan.id), 'an R-VAN goes on any spray body');
  assert.ok(!cat.brands.includes('Any'), 'the generic bodies are not a brand');
  assert.equal(nozzleRiseIn(cat.body(sprayBodyId(6, 30))), 6);
  assert.equal(nozzleRiseIn(cat.body(sprayBodyId(null, null))), 12);
  // a regulated body holds the nozzle down; an open one passes the zone's pressure
  const n = rvan.nozzles[0], zone = 60;
  const open = headWater({ body: sprayBodyId(4, null), nozzle: n.id, arc: 180 }, cat, zone), reg = headWater({ body: sprayBodyId(4, 45), nozzle: n.id, arc: 180 }, cat, zone);
  assert.ok(open.psi > reg.psi, `${open.psi} vs ${reg.psi}`);
  // rotors group by the series on the cap
  const series = new Set(cat.bodies.filter((x) => x.kind === 'rotor' && x.brand === 'Hunter').map(seriesOf));
  assert.ok(series.has('PGP Ultra or I-20') && series.size <= 6, [...series].join(' | '));
});

test('adjustable arcs fitted together: corners a quarter, sides a half, all facing in, off the house', () => {
  const o = [-85.5, 43.0];
  // a 12 x 9 m lawn, a house north of it, a drive west of it
  const ground = (at) => { const [e, n] = enu(o, at); if (e >= 0 && e <= 12 && n >= 0 && n <= 9) return 'lawn'; if (n > 9 && n < 15 && e > 2 && e < 10) return 'hard'; if (e < 0 && e > -3) return 'hard'; return 'other'; };
  const nz = { arcFixed: null, arcMin: 45, arcMax: 270 };
  const want = [[0, 0, 45, 90], [6, 0, 0, 180], [12, 0, 315, 90], [0, 9, 135, 90], [6, 9, 180, 180], [12, 9, 225, 90], [0, 4.5, 90, 180], [12, 4.5, 270, 180]];
  const heads = want.map(([e, n], k) => ({ id: `h${k}`, at: unEnu(o, [e, n]), radiusM: 6.5, nozzle: nz, dir: 0, arc: 180 }));
  const fit = fitArcs(heads, ground);
  want.forEach(([, , dir, arc], k) => {
    const x = fit.get(`h${k}`);
    assert.equal(x.arc, arc, `h${k} arc ${x.arc}`);
    const off = Math.abs(((x.dir - dir + 540) % 360) - 180);
    assert.ok(off <= 10, `h${k} faces ${x.dir}, not ${dir}`);
  });
  // the side heads shorten their throw rather than water the house
  assert.ok(fit.get('h6').throw < 1);
  // a head the person set stays, and the others fit round it
  heads[0].fixed = true; heads[0].dir = 45; heads[0].arc = 90;
  assert.ok(!fitArcs(heads, ground).has('h0'));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water heads: ${tests.length} passed`);
