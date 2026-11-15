/**
 * The plan's weather sources (water/lib/weather.js): Open-Meteo first (2026-11-15), NASA POWER when it does not
 * answer, PRISM's rain over either. Made-up answers, no network.
 *   node water/test/weather.test.js
 */
import assert from 'node:assert/strict';
import { openMeteoDaysOf, typicalYears } from '../lib/weather.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok  ${name}`); }

const om = (dates, over = {}) => ({ elevation: 250, daily: { time: dates, temperature_2m_max: dates.map(() => 25), temperature_2m_min: dates.map(() => 12), relative_humidity_2m_mean: dates.map(() => 65), wind_speed_10m_mean: dates.map(() => 4), shortwave_radiation_sum: dates.map(() => 22), precipitation_sum: dates.map(() => 3), ...over } });
const daysOf = (y0, y1) => { const out = []; for (let t = Date.UTC(y0, 0, 1); t <= Date.UTC(y1, 11, 31); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });

await test('Open-Meteo\'s days: the 10 m wind to 2 m, ET0 worked out, days without temperatures dropped', async () => {
  const r = openMeteoDaysOf(om(['2025-07-01', '2025-07-02'], { temperature_2m_max: [25, null] }), 43);
  assert.equal(r.days.length, 1);
  assert.ok(Math.abs(r.days[0].wind - 4 * 0.748) < 0.01);
  assert.ok(r.days[0].et0 > 3 && r.days[0].et0 < 7, `ET0 ${r.days[0].et0}`);
  assert.equal(r.elev, 250);
  assert.equal(openMeteoDaysOf(om(['2025-07-01', '2025-07-02']), 43, { until: '2025-07-02' }).days.length, 1, 'today left for the forecast');
});

await test('the ten years: Open-Meteo when it answers, with PRISM\'s rain; NASA POWER when it does not', async () => {
  const now = new Date(Date.UTC(2026, 5, 1));
  const prism = { data: [['2016-07-04', '1.00']] };
  const fetchOm = async (u) => (u.includes('open-meteo') ? json(om(daysOf(2016, 2025))) : u.includes('rcc-acis') ? json(prism) : json({}, 500));
  const a = await typicalYears(43, -85.6, { now, fetchFn: fetchOm });
  assert.match(a.weatherFrom, /Open-Meteo/);
  assert.match(a.rainFrom, /PRISM/);
  assert.equal(a.days.find((d) => d.date === '2016-07-04').rain, 25.4, 'PRISM\'s inch over the model\'s 3 mm');
  assert.equal(a.days.find((d) => d.date === '2016-07-05').rain, 3, 'the model\'s rain where PRISM has none');
  let powerAsked = false;
  const power = { geometry: { coordinates: [0, 0, 240] }, properties: { parameter: { T2M_MAX: { 20160101: 1 }, T2M_MIN: { 20160101: -4 }, RH2M: { 20160101: 80 }, WS2M: { 20160101: 3 }, ALLSKY_SFC_SW_DWN: { 20160101: 4 }, PRECTOTCORR: { 20160101: 0 } } } };
  const fetchDown = async (u) => (u.includes('open-meteo') ? json({ error: true, reason: 'Daily API request limit exceeded' }, 429) : u.includes('power.larc') ? ((powerAsked = true), json(power)) : json({}, 500));
  const b = await typicalYears(43, -85.6, { now, fetchFn: fetchDown });
  assert.ok(powerAsked); assert.match(b.weatherFrom, /NASA POWER/); assert.equal(b.days.length, 1);
});

console.log(`\n${passed} passed`);
