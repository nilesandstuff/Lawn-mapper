/**
 * After the heads: what could be better about the system (lib/fixes.js), and when to water each zone
 * (lib/schedule.js). Made-up heads and plans with known answers.
 *   node water/test/advice.test.js
 */

import assert from 'node:assert/strict';
import { suggestions, betweenZones, ownRate } from '../lib/fixes.js';
import { zoneSchedule, oftenWords, runsFor, valveZones, schedulingMultiplierFor } from '../lib/schedule.js';
import { precipitation } from '../lib/precip.js';
import { unEnu } from '../lib/heads.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const O = [-85, 42.5];
const at = (e, n) => unEnu(O, [e, n]);
/** A spray at (e, n) m: 12 ft throw, a quarter, half or full circle at the matched flow. */
const spray = (id, zone, e, n, { arc = 360, dir = 0, gpm = null, status = 'ok', psi = 30, kind = 'spray', radiusM = 3.66, adjustable = true } = {}) => ({
  id, zone, at: at(e, n), kind, arc, dir, gpm: gpm ?? 1.6 * (arc / 360), radiusM, fullRadiusM: radiusM, cut: 1, throw: 1, profile: 'rotary', strip: null,
  status, psi, chartLo: 15, chartHi: 30, adjustable, fixedArc: !adjustable, arcMax: 360, label: '12-VAN',
});

test('pressure under or over the chart is named, with the change that answers it', () => {
  const heads = [spray('a', 1, 0, 0, { status: 'low', psi: 12 }), spray('b', 1, 4, 0, { status: 'low', psi: 11 }), spray('c', 2, 20, 0, { status: 'high', psi: 70 })];
  const s = suggestions({ heads });
  const low = s.find((x) => x.kind === 'pressure-low'), high = s.find((x) => x.kind === 'pressure-high');
  assert.ok(low && low.zone === 1 && low.heads.length === 2, 'zone 1 is under its chart');
  assert.match(low.text, /less pressure/); assert.match(low.text, /Rotary nozzles/);
  assert.ok(high && high.zone === 2, 'zone 2 is over its chart');
  assert.match(high.text, /mist/);
});

test('rotors and sprays on one valve are flagged; one kind on each is not', () => {
  const rotor = { ...spray('r', 1, 10, 0), kind: 'rotor', radiusM: 10, fullRadiusM: 10, gpm: 2, profile: 'rotor' };
  const mixed = suggestions({ heads: [spray('a', 1, 0, 0), spray('b', 1, 4, 0), rotor] });
  assert.ok(mixed.some((x) => x.kind === 'mixed' && x.zone === 1));
  const apart = suggestions({ heads: [spray('a', 1, 0, 0), spray('b', 1, 4, 0), { ...rotor, zone: 2 }] });
  assert.ok(!apart.some((x) => x.kind === 'mixed'));
});

test('a head laying down twice its zone-mates\' rate is unmatched; matched arcs are not', () => {
  const matched = [spray('a', 1, 0, 0, { arc: 90 }), spray('b', 1, 4, 0, { arc: 180 }), spray('c', 1, 8, 0, { arc: 360 }), spray('d', 1, 12, 0, { arc: 90 })];
  assert.ok(Math.abs(ownRate(matched[0]) - ownRate(matched[2])) < 1e-9, 'matched precipitation: the same rate at any arc');
  assert.ok(!suggestions({ heads: matched }).some((x) => x.kind === 'unmatched'));
  // a full-circle nozzle's flow on a quarter: four times the rate
  const odd = [...matched.slice(1), spray('q', 1, 0, 0, { arc: 90, gpm: 1.6 })];
  const s = suggestions({ heads: odd });
  assert.ok(s.some((x) => x.kind === 'unmatched' && x.heads.includes('q')));
});

/** A cover grid: half-metre cells over [-6, 6] m east and north, all lawn. */
function coverFor(heads) {
  const cellM = 0.5, W = 24, H = 24;
  const cAt = (c, r) => at(-6 + (c + 0.5) * cellM, 6 - (r + 0.5) * cellM);
  const lawnFlag = new Uint8Array(W * H).fill(1);
  const p = precipitation({ W, H, cellM, at: cAt, lawn: () => true }, heads);
  return { p, W, H, cellM, at: cAt, lawnFlag };
}

test('lawn no head reaches, beside a head facing away, says to turn or open its arc', () => {
  // one head in the middle throwing a half circle to the north: the south half gets nothing, and it could
  const h = spray('a', 1, 0, 0, { arc: 180, dir: 0, radiusM: 5 });
  const s = suggestions({ heads: [h], cover: coverFor([h]) });
  const miss = s.find((x) => x.kind === 'missed');
  assert.ok(miss, 'the dry half is found');
  assert.equal(miss.fix, 'arc'); assert.deepEqual(miss.heads, ['a']);
  assert.match(miss.text, /open its arc/);
  // lawn out of every head's reach: a head of its own
  const far = spray('b', 1, -5.5, 5.5, { arc: 90, dir: 135, radiusM: 2 });
  const s2 = suggestions({ heads: [far], cover: coverFor([far]) });
  assert.ok(s2.some((x) => x.kind === 'missed' && x.fix === 'head'));
});

test('water thrown on paving is flagged once it is a fifth or more of the head\'s', () => {
  const h = spray('a', 1, 0, 0, { arc: 180, dir: 90, radiusM: 4 });
  const groundAt = (p) => (p[0] > O[0] + 1.5 / 82000 ? 'paved' : 'lawn'); // paving from 1.5 m east
  const s = suggestions({ heads: [h], cover: coverFor([h]), groundAt });
  assert.ok(s.some((x) => x.kind === 'overspray' && x.heads[0] === 'a'));
  const s2 = suggestions({ heads: [{ ...h, dir: 270 }], cover: coverFor([{ ...h, dir: 270 }]), groundAt });
  assert.ok(!s2.some((x) => x.kind === 'overspray'), 'turned away, it is not');
});

test('zones at different rates are the run times\' to answer, not a fault', () => {
  assert.equal(betweenZones(new Map([[1, 1.5], [2, 1.4]])), null);
  const b = betweenZones(new Map([[1, 1.5], [2, 0.45]]));
  assert.equal(b.hi.zone, 1); assert.equal(b.lo.zone, 2);
});

test('how often, in a controller\'s words', () => {
  assert.equal(oftenWords(2.3), '2 days a week');
  assert.equal(oftenWords(7.4), 'every day');
  assert.equal(oftenWords(0.5), 'every 14 days');
  assert.equal(oftenWords(1 / (31 / 7)), 'about once a month');
  assert.equal(oftenWords(0), null);
});

test('one watering: minutes from the rate, cycle and soak only where it waters faster than the ground takes', () => {
  assert.deepEqual(runsFor(0.5, 1.5, 2), { runs: 1, minutes: 20, total: 20 });
  const soak = runsFor(0.5, 1.5, 0.3);
  assert.equal(soak.runs, 2); assert.equal(soak.minutes, 10);
  assert.equal(runsFor(0.5, 0.4, 0.3).runs, 2, 'at most two runs a day (owner, 2026-10-20)');
});

test('a zone\'s schedule: the plan\'s depth moved to its own evenness, minutes by its own rate, seasons by month', () => {
  const planSM = schedulingMultiplierFor(0.65);
  const months = Array.from({ length: 12 }, (_, m) => ({ month: m, waterings: [0, 0, 0, 2, 5, 9, 12, 11, 6, 2, 0, 0][m], high: 0, mmEach: 12.7 * planSM }));
  const pz = { months, takesInPerH: 0.7, dryWeek: { month: 6, mm: 30 * planSM, waterings: 3 }, depthMm: 12.7 * planSM };
  const even = zoneSchedule(pz, { rateInH: 1.5, du: 0.65 }, planSM);
  // the grass gets half an inch each time; at the plan's own evenness that is half an inch times its multiplier
  const summer = even.seasons.find((s) => s.name === 'Summer');
  assert.ok(Math.abs(summer.depthIn - 0.5 * planSM) < 1e-6, `${summer.depthIn}`);
  assert.equal(summer.runs, 1, 'about 0.63 in on ground taking 0.7 in an hour: one run');
  assert.equal(summer.total, Math.round((0.5 * planSM / 1.5) * 60));
  assert.deepEqual(summer.often.map((o) => o.often), ['2 days a week', '3 days a week', '2 days a week']);
  assert.equal(even.seasons.find((s) => s.name === 'Spring').months.join(), '3,4');
  assert.ok(!even.seasons.some((s) => s.name === 'Winter'));
  // slower ground: cycle and soak
  assert.equal(zoneSchedule({ ...pz, takesInPerH: 0.4 }, { rateInH: 1.5, du: 0.65 }, planSM).seasons[0].runs, 2);
  // a less even zone puts down more to give its driest quarter enough
  const patchy = zoneSchedule(pz, { rateInH: 1.5, du: 0.45 }, planSM);
  assert.ok(patchy.seasons[0].depthIn > even.seasons[0].depthIn * 1.15);
  // and a rotor zone at a third the rate runs three times as long
  const rotors = zoneSchedule(pz, { rateInH: 0.5, du: 0.65 }, planSM);
  assert.ok(Math.abs(rotors.seasons.find((s) => s.name === 'Summer').total - 3 * summer.total) <= 1);
  // rain that stands in for a watering: what reaches the grass, half an inch
  assert.ok(Math.abs(even.skipAfterIn - 0.5) < 1e-6);
  // a dry week in July: 30 mm of grass water over three waterings
  assert.equal(even.dry.waterings, 3); assert.ok(Math.abs(even.dry.weekIn - (30 * planSM) / 25.4) < 1e-6);
});

test('each valve\'s lawn is where it puts down the most', () => {
  const a = new Float32Array([1, 1, 0.2, 0]), b = new Float32Array([0.5, 0, 0.4, 0]);
  const { zoneOf, zones } = valveZones(new Map([[1, a], [3, b]]), 4, (i) => i !== 1 || true);
  assert.deepEqual([...zoneOf], [0, 0, 2, -1]);
  assert.equal(zones.get(1).cells, 2); assert.equal(zones.get(3).cells, 1);
  assert.ok(Math.abs(zones.get(1).rateInH - 1) < 1e-9);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water advice: ${tests.length} passed`);
