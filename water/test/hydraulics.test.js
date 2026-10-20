/**
 * The pressure at each head (water session): routing, devices, friction, elevation, the solve.
 *   node water/test/hydraulics.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { route, solveZone, deviceLoss, frictionPerFt, dwPerFt, roughnessMm, regulatedOut, sizeFor, pipeSize, headFlow, PSI_PER_FT, FT_PER_M } from '../lib/hydraulics.js';
import { catalogue, unEnu } from '../lib/heads.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const dir = new URL('../lib/heads/', import.meta.url);
const cat = catalogue(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'))));
const ref = [-85.5, 43];
const at = (e, n) => unEnu(ref, [e, n]);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('routing: heads in a row are one run, each after its parent', () => {
  const t = route(ref, [{ id: 'a', at: at(5, 0) }, { id: 'b', at: at(10, 0) }, { id: 'c', at: at(15, 0) }]);
  const n = Object.fromEntries(t.nodes.map((x) => [x.id, x]));
  assert.equal(n.a.parent, 'valve'); assert.equal(n.b.parent, 'a'); assert.equal(n.c.parent, 'b');
  assert.equal(t.order[0].id, 'valve');
  for (const x of t.order.slice(1)) assert.ok(t.order.findIndex((y) => y.id === x.parent) < t.order.indexOf(x), 'parents first');
});

test('routing: a run through a building goes round it if it can', () => {
  // the straight way to b crosses a wall between x 4 and 6; a is a way round
  const blocked = (p, q) => { const [e1] = [((p[0] - ref[0]) * 111320 * Math.cos(43 * Math.PI / 180))], [e2] = [((q[0] - ref[0]) * 111320 * Math.cos(43 * Math.PI / 180))]; const n1 = (p[1] - ref[1]) * 111320, n2 = (q[1] - ref[1]) * 111320; return Math.min(e1, e2) < 5 && Math.max(e1, e2) > 5 && Math.min(n1, n2) < 1; };
  const t = route(ref, [{ id: 'b', at: at(10, 0) }, { id: 'a', at: at(5, 4) }], { blocked });
  assert.equal(Object.fromEntries(t.nodes.map((x) => [x.id, x])).b.parent, 'a');
});

test("routing: Hunter's six heads in two rows are fed as a trunk with branches, not one line snaking through all six (his WRONG)", () => {
  // two columns of three heads 5 m apart, the valve 5 m below the middle of the pair
  const hs = [];
  for (const e of [0, 5]) for (const n of [5, 10, 15]) hs.push({ id: `h${e}${n}`, at: at(e, n) });
  const t = route(at(2.5, 0), hs);
  const byId = new Map(t.nodes.map((x) => [x.id, x]));
  const depth = (id) => { let k = 0; for (let x = byId.get(id); x && x.parent !== null; x = byId.get(x.parent)) if (x.kind === 'head') k++; return k; };
  const most = Math.max(...hs.map((h) => depth(h.id)));
  assert.ok(most <= 3, `the farthest head is behind ${most} heads`);
});

test('devices: between the maker\'s points a line; past the last the square of the flow; a check valve holds its spring below the first', () => {
  const pvb = { kind: 'pvb', points: [{ gpm: 5, psi: 4 }, { gpm: 15, psi: 8 }] };
  near(deviceLoss(pvb, 10), 6, 1e-9, 'between'); near(deviceLoss(pvb, 30), 32, 1e-9, 'past'); near(deviceLoss(pvb, 1), 4, 1e-9, 'below');
  near(deviceLoss({ kind: 'valve', points: [{ gpm: 10, psi: 2 }] }, 5), 0.5, 1e-9, 'an open valve below its first point');
});

test('friction: Hazen-Williams, 1 in Schedule 40 at 10 gpm loses about 2.4 psi per 100 ft; runs are sized under 5 ft/s from 3/4 in', () => {
  near(frictionPerFt(1.049, 150, 10) * 100, 2.39, 0.05, 'psi per 100 ft');
  // Rain Bird's worked example (Landscape Irrigation Design Manual, p. 91): 162.8 ft of 2 in Schedule 40 at
  // 39.2 gpm, 1.872 psi in their table; Hazen-Williams with C 150 within 5% of it
  const rb = frictionPerFt(2.067, 150, 39.2) * 162.8;
  assert.ok(Math.abs(rb - 1.872) / 1.872 < 0.05, `Rain Bird's main: ${rb.toFixed(3)} psi vs 1.872`);
  assert.equal(sizeFor('pe', 2).nominal, 0.75);
  assert.equal(sizeFor('pe', 10).nominal, 1);
  assert.equal(sizeFor('pe', 20).nominal, 1.25);
  assert.equal(sizeFor('pvc40', 30).nominal, 1.5, 'the largest when none keeps it under 5 ft/s');
});

test('a head past its chart: flow by the pressure to the 0.52 (sprays, fitted on the charts); a regulated body holds its nozzle at its setting', () => {
  const free = headFlow({ body: 'rb-1804', nozzle: 'rb-mpr-15h' }, cat, 60);
  near(free.gpm, 1.85 * (60 / 30) ** 0.52, 0.02, '15H at 60 psi'); assert.equal(free.status, 'high');
  const prs = headFlow({ body: 'rb-1804-prs', nozzle: 'rb-mpr-15h' }, cat, 60);
  near(prs.nozzlePsi, 30, 1e-9, 'PRS'); assert.equal(prs.status, 'ok');
});

const zone = (heads, opts = {}) => {
  const tree = route(ref, heads);
  return solveZone({ tree, heads: new Map(heads.map((h) => [h.id, h])), water: (h, psi) => headFlow(h, cat, psi), family: 'pe', valve: { kind: 'valve', points: [{ gpm: 10, psi: 2 }] }, ...opts },
    { psi: 50, gaugeAt: ref, gaugeElevM: opts.elev ? 0 : null, upstream: (Q) => deviceLoss({ kind: 'pvb', points: [{ gpm: 5, psi: 4 }, { gpm: 15, psi: 8 }] }, Q) });
};
const row = (n, dy = 0, nozzle = 'rb-mpr-15h') => Array.from({ length: n }, (_, k) => ({ id: `h${k}`, at: at(5 + 4.5 * k, dy), body: 'rb-1804', nozzle }));

test('the solve: the valve passes what the heads put out, each head puts out its chart\'s flow at its own pressure, pressure falls along the run', () => {
  const r = zone(row(6));
  const sum = [...r.heads.values()].reduce((t, h) => t + h.gpm, 0);
  near(r.gpm, sum, 0.01, 'valve flow = heads');
  for (const [id, h] of r.heads) near(h.gpm, headFlow({ body: 'rb-1804', nozzle: 'rb-mpr-15h' }, cat, h.psi).gpm, 0.01, `${id} on its chart`);
  const ps = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5'].map((id) => r.heads.get(id).psi);
  for (let k = 1; k < ps.length; k++) assert.ok(ps[k] <= ps[k - 1] + 1e-9, `falls along the run: ${ps.map((p) => p.toFixed(2))}`);
  assert.ok(r.iterations < 60, `settled in ${r.iterations}`);
  // the worksheet adds up
  const w = r.worksheet;
  near(w.gauge - w.upstream - w.valve - w.lateral - w.swing + w.elevation, w.atHead, 0.05, 'worksheet');
});

test('elevation: the same zone 10 ft uphill gets about 4.3 psi less at its heads', () => {
  const flat = zone(row(4)), up = zone(row(4), { elev: (p) => (p === ref ? 0 : ((p[0] - ref[0]) * 111320 * Math.cos(43 * Math.PI / 180) > 1 ? 10 / FT_PER_M : 0)) });
  const d = flat.heads.get('h3').psi - up.heads.get('h3').psi;
  near(up.worksheet.elevation, -(10 + 4 / 12) * PSI_PER_FT, 0.01, 'the rise: 10 ft and the 4 in pop-up');
  // less than the rise alone: the heads run a little less water, so the devices and pipes lose a little less
  const lessLoss = (flat.worksheet.upstream + flat.worksheet.valve + flat.worksheet.lateral + flat.worksheet.swing) - (up.worksheet.upstream + up.worksheet.valve + up.worksheet.lateral + up.worksheet.swing);
  assert.ok(lessLoss > 0, 'lower flow, lower losses');
  near(d, (10 + 4 / 12) * PSI_PER_FT - lessLoss, 0.05, 'the rise, less the losses saved');
});

test('water quality: plastic and copper stay smooth; galvanized roughens with years, faster in iron-bearing water', () => {
  assert.equal(roughnessMm('pvc40', { hardness: 'veryHard', orange: true }, 40), 0.0015);
  assert.equal(roughnessMm('cuK', { hardness: 'veryHard' }, 40), 0.0015);
  const mild = roughnessMm('galv', { hardness: 'soft' }, 40), rusty = roughnessMm('galv', { hardness: 'soft', orange: true }, 40);
  assert.ok(Math.abs(mild - (0.15 + 40 * 0.025)) < 1e-9 && rusty > mild, `${mild} ${rusty}`);
  assert.ok(dwPerFt(0.824, rusty, 6) > 1.5 * dwPerFt(0.824, 0.15, 6), 'an old rusty line loses far more');
});

test("Darcy-Weisbach: the research's worked value (3/4 in Class 200, 4 gpm, 1.02 psi per 100 ft) and more than Hazen-Williams' 150 in small pipe", () => {
  const dw = dwPerFt(0.91, 0.0015, 4) * 100;
  assert.ok(Math.abs(dw - 1.02) < 0.03, `${dw}`);
  assert.ok(dw > frictionPerFt(0.91, 150, 4) * 100, 'H-W 150 reads low in small plastic pipe');
  // Rain Bird's 2 in main (1.872 psi in their H-W chart): Darcy-Weisbach within 10% of it
  const rb = dwPerFt(2.047, 0.0015, 39.2) * 162.8;
  assert.ok(Math.abs(rb - 1.872) / 1.872 < 0.10, `Rain Bird's main by Darcy-Weisbach: ${rb.toFixed(3)}`);
});

test("pressure-regulating bodies: Rain Bird's 1800 PRS holds 30 from 35 psi in and passes less below; Hunter's PRB rotor needs 15 psi over its 45", () => {
  const prs = { id: 'rb-1804-prs', kind: 'spray', regulatedPsi: 30 };
  assert.equal(regulatedOut(prs, 60), 30); assert.equal(regulatedOut(prs, 35), 30); assert.equal(regulatedOut(prs, 32), 27);
  const prb = { id: 'hu-pgp-ultra-04-prb', kind: 'rotor', regulatedPsi: 45 };
  assert.equal(regulatedOut(prb, 70), 45); assert.equal(regulatedOut(prb, 55), 40);
});

test("the makers' devices: every curve reads, and a typical 1 in PVB and valve lose a few psi at a home zone's 10 gpm", () => {
  const dev = JSON.parse(readFileSync(new URL('../lib/hydraulics/devices.json', import.meta.url), 'utf8')).devices;
  for (const d of dev) assert.ok(d.points.length && d.points.every((p) => p.gpm > 0 && p.psi >= 0), d.id);
  const mid = (kind) => { const v = dev.filter((d) => d.kind === kind && d.sizeIn === 1).map((d) => deviceLoss(d, 10)).sort((a, b) => a - b); return v[Math.floor((v.length - 1) / 2)]; };
  const pvb = mid('pvb'), valve = mid('valve');
  assert.ok(pvb > 1 && pvb < 10, `PVB ${pvb}`); assert.ok(valve > 0.5 && valve < 6, `valve ${valve}`);
  console.log(`     typical at 10 gpm: 1 in PVB ${pvb.toFixed(1)} psi, 1 in valve ${valve.toFixed(1)} psi`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water hydraulics: ${tests.length} passed`);
