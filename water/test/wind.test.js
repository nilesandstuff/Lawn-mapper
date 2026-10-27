/**
 * The local wind (lib/wind.js) and the fences' radiant heat (lib/fenceheat.js). Made-up records and fences.
 *   node water/test/wind.test.js
 */
import assert from 'node:assert/strict';
import { parseAsos, windStats, nearestStations, kmBetween, TO_2M, KT } from '../lib/wind.js';
import { fenceRadiation, heatShare, faceBeamRatio } from '../lib/fenceheat.js';
import { attachStationHours } from '../lib/weather.js';
import { toMerc, fromMerc } from '../lib/shade/ept.js';
import { weps, buildingLee, buildingFront, shelterByDirection, monthlyShelter, calibrate } from '../lib/shelter.js';

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

test('the shelter curves: WEPS behind a barrier by porosity, a house\'s lee and its front', () => {
  // the USDA's fitted curve, as tabulated in its handbook's terms (the research's table)
  assert.ok(Math.abs(weps(5, 0) - 0.18) < 0.01 && Math.abs(weps(10, 0) - 0.55) < 0.01, 'solid');
  assert.ok(Math.abs(weps(2, 0.5) - 0.40) < 0.01 && Math.abs(weps(5, 0.5) - 0.29) < 0.01, 'half open');
  assert.equal(weps(40, 0), 1); assert.equal(weps(-6, 0), 1);
  assert.ok(weps(-1, 0) < 0.2, 'just upwind of a solid fence, slowed too');
  // a 6 m house, 12 m across, 10 m deep: its cavity, then its wake
  assert.equal(buildingLee(5, 6, 12, 10), 0.1);
  assert.ok(Math.abs(buildingLee(18, 6, 12, 10) - 0.47) < 0.02);
  assert.equal(buildingLee(40, 6, 12, 10), 1);
  assert.equal(buildingFront(3, 6, 12), 0.3); assert.equal(buildingFront(15, 6, 12), 1);
});

test('each spot\'s wind: behind a house from the west, open to the east; by the month\'s rose; held to the yard\'s figure', () => {
  // a 60 x 60 m grid, a 6 m house 12 m across in the middle; cells 9 m east and 9 m west of it
  const W = 60, H = 60, kind = new Uint8Array(W * H), height = new Float32Array(W * H), base = new Float32Array(W * H);
  for (let r = 24; r < 36; r++) for (let c = 25; c < 35; c++) { kind[r * W + c] = 1; height[r * W + c] = 6; }
  const east = 30 * W + 44, west = 30 * W + 15;
  const sd = shelterByDirection({ W, H, kind, height, base }, [east, west], W, 0, 0);
  const W_ = 12, E_ = 4; // sectors: from the west, from the east
  assert.ok(sd.on[0 * 16 + W_] < 0.5, `east of the house, a west wind: ${sd.on[W_]}`);
  assert.ok(sd.on[0 * 16 + E_] > 0.9, 'east of the house, an east wind: open');
  assert.ok(sd.on[1 * 16 + E_] < 0.5 && sd.on[1 * 16 + W_] > 0.9, 'and the other way round to the west');
  // a fence 1.8 m tall, solid, running north-south 4 m west of a cell: from the west, sheltered
  const open = new Uint8Array(W * H);
  const cell = 30 * W + 10;
  const fence = { ax: 6, ay: 20, bx: 6, by: 40, h: 1.8, style: 'solid', nE: 1, nN: 0 };
  const sf = shelterByDirection({ W, H, kind: open, height: new Float32Array(W * H), base }, [cell], W, 0, 0, [fence]);
  assert.ok(sf.on[W_] < 0.15, `2.2 heights behind a solid fence: ${sf.on[W_]}`);
  assert.ok(sf.on[E_] < 0.7, 'upwind of it, a little slowed too');
  const spaced = shelterByDirection({ W, H, kind: open, height: new Float32Array(W * H), base }, [cell], W, 0, 0, [{ ...fence, style: 'spaced' }]);
  assert.ok(spaced.on[W_] > sf.on[W_] + 0.2, 'a spaced fence shelters less');
  // the month: all the wind from the west -> the east cell is sheltered all month; held to a yard figure of 0.4
  const rose = new Array(16).fill(0); rose[W_] = 1;
  const months = monthlyShelter(sd, 2, new Array(12).fill(rose), new Array(12).fill(1));
  assert.ok(months[6][0] < 0.5 && months[6][1] > 0.9);
  const fit = calibrate(months, 0.4);
  const mean = (fit[6].F[0] + fit[6].F[1]) / 2;
  assert.ok(Math.abs(mean - 0.4) < 0.02, `the lawn's mean is the yard's figure: ${mean}`);
  assert.ok(fit[6].F[0] < fit[6].F[1], 'and the sheltered spot stays the calmer');
});

test('the ten years\' rain by the hour: a day takes the station\'s hours in its window, scaled to its own total', () => {
  const H = 3600000, t = (d, h) => Date.UTC(2020, 6, d, h);
  // the station: 10 mm in one hour at 03 UTC on the 2nd (inside the PRISM day of the 2nd, which ends 12 UTC)
  const hours = [{ utc: t(2, 3), mm: 10 }, { utc: t(5, 20), mm: 2 }];
  const days = [
    { date: '2020-07-02', rain: 25, src: 'power + PRISM rain' },
    { date: '2020-07-03', rain: 8, src: 'power + PRISM rain' }, // no station rain in its window: daily total alone
    { date: '2020-07-04', rain: 1, src: 'power + PRISM rain' }, // under 2.5 mm: left as it is
  ];
  const n = attachStationHours(days, hours);
  assert.equal(n, 1);
  assert.ok(days[0].hours && Math.abs(days[0].hours.reduce((a, b) => a + b, 0) - 25) < 0.01, 'the day keeps its total');
  assert.equal(Math.max(...days[0].hours), 25, 'and falls in the one hour the station had it');
  assert.equal(days[1].hours, undefined); assert.equal(days[2].hours, undefined);
  assert.equal(attachStationHours(days, []), 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water wind: ${tests.length} passed`);
