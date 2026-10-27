/**
 * The local wind (lib/wind.js) and the fences' radiant heat (lib/fenceheat.js). Made-up records and fences.
 *   node water/test/wind.test.js
 */
import assert from 'node:assert/strict';
import { parseAsos, windStats, nearestStations, kmBetween, TO_2M, KT } from '../lib/wind.js';
import { fenceRadiation, heatShare, faceBeamRatio } from '../lib/fenceheat.js';
import { toMerc, fromMerc } from '../lib/shade/ept.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the station\'s hours: one report an hour, calm and variable without a direction', () => {
  const csv = 'station,valid,sknt,drct,gust\nX,2024-07-01 12:53,10.00,270.00,18.00\nX,2024-07-01 12:58,11.00,270.00,\nX,2024-07-01 13:53,0.00,0.00,\nX,2024-07-01 14:53,4.00,,\n';
  const r = parseAsos(csv);
  assert.equal(r.length, 3, 'the second report in the same hour is dropped');
  assert.equal(r[0].dir, 270); assert.equal(r[0].gust, 18);
  assert.equal(r[1].dir, null, 'calm'); assert.equal(r[2].dir, null, 'variable');
});

test('the wind by month: daytime from the west, speeds at 2 m, the trend', () => {
  const rows = [];
  // ten years of July: daytime (solar 8-20 at lng 0) 10 kt from the west, nights 4 kt from the south
  for (let y = 2015; y < 2025; y++) for (let d = 1; d <= 31; d++) for (let h = 0; h < 24; h++) {
    const day = h >= 8 && h < 20;
    rows.push({ t: Date.UTC(y, 6, d, h), kt: day ? 10 + (y - 2015) * 0.1 : 4, dir: day ? 270 : 180, gust: null });
  }
  // and fill the rest of each year so the years count (8,000 hours)
  for (let y = 2015; y < 2025; y++) for (let m = 0; m < 12; m++) if (m !== 6) for (let d = 1; d <= 28; d++) for (let h = 0; h < 24; h++) rows.push({ t: Date.UTC(y, m, d, h), kt: 6, dir: 0 + 90, gust: null });
  rows.sort((a, b) => a.t - b.t);
  const s = windStats(rows, 0);
  const jul = s.byMonth[6];
  assert.equal(jul.rose[12], 1, 'all the daytime wind from the west (sector 12)');
  assert.ok(jul.freq[8] > 0.4 && jul.freq[12] > 0.4, 'by hours, half south and half west');
  assert.ok(Math.abs(jul.dayMs - 10.45 * KT * TO_2M) < 0.02, `${jul.dayMs}`);
  assert.equal(s.byYear.length, 10);
  assert.ok(s.trendPerDecade > 0, 'stronger each year');
});

test('the nearest station still reporting', () => {
  const list = { stations: [['A', 'N', 42.0, -85.0, 1990, null, 'a'], ['B', 'N', 42.5, -85.0, 1990, 2001, 'b'], ['C', 'N', 43.0, -85.0, 1990, null, 'c']] };
  const n = nearestStations(list, 42.6, -85.0, 2);
  assert.deepEqual(n.map((s) => s.id), ['C', 'A'], 'B stopped in 2001');
  assert.ok(Math.abs(kmBetween(42, -85, 43, -85) - 111.2) < 0.5);
});

test('a fence: the grass at its foot sees it, takes some sky from the longwave, and is warmed in sun', () => {
  // a 1 m grid of 40 x 40 cells; a 1.8 m natural-wood solid fence running east-west across the middle
  const lat = 42.9, lng = -85.6, W = 40, H = 40;
  const [cx, cy] = toMerc([lng, lat]);
  const k = 1 / Math.cos((lat * Math.PI) / 180); // 3857 units per metre
  const bbox = [cx - 20 * k, cy - 20 * k, cx + 20 * k, cy + 20 * k];
  const ll = (e, n) => fromMerc([cx + e * k, cy + n * k]);
  const fence = { line: [ll(-10, 0), ll(10, 0)], heightM: 1.8, style: 'solid', material: 'wood', color: 'natural' };
  const z = new Float32Array(W * H);
  const cells = []; for (let i = 0; i < W * H; i++) cells.push(i);
  const fr = fenceRadiation([fence], { W, H, bbox, cell: 1 }, z, cells, lat, lng);
  assert.equal(fr.fences, 1);
  const at = (e, n) => Math.floor(20 - n) * W + Math.floor(20 + e); // cell holding (e, n) m from the middle
  const foot = at(0, -0.5), far = at(0, -15);
  assert.ok(fr.reflSky[foot] > 0.01 && fr.reflSky[far] === 0, `reflected sky ${fr.reflSky[foot]}`);
  assert.ok(fr.sky[foot] > 0.01 && fr.beam[6][foot] > 0, 'warmed by sky and sun');
  assert.equal(fr.sky[far], 0, 'beyond three heights: nothing');
  // the south face gets more July sun than the north one... but both faces warm the one thin board
  const seg = { nE: 0, nN: 1 };
  assert.ok(faceBeamRatio(seg, lat, lng, 0) > faceBeamRatio(seg, lat, lng, 6), 'a low winter sun lights an upright face more, per unit on the ground');
  assert.ok(heatShare() > 0.1 && heatShare() < 0.25);
  assert.equal(fenceRadiation([], { W, H, bbox, cell: 1 }, z, cells, lat, lng), null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water wind: ${tests.length} passed`);
