/**
 * RAIN AND WEATHER FOR ONE LAWN, DAY BY DAY (water session, 2026-10-18).
 *
 * Owner, 2026-10-18: both a typical-year plan and a "this week" adjustment.
 *
 *   past      NASA POWER daily (power.larc.nasa.gov, no key, open to browsers): temperatures,
 *             humidity, wind at 2 m, sunshine, rain. A coarse grid (about 50 km) that misses
 *             local storms (FINDINGS H4), so a user's own gauge totals override its rain. It
 *             runs 3-4 days behind; the days between come from the nearest NWS station.
 *   typical   ten whole years of POWER days: the water balance runs over all of them, and the
 *             plan for a month is what those ten Junes (say) needed.
 *   coming    the NWS forecast grid (api.weather.gov): hourly temperature, humidity, wind,
 *             sky cover and rain amounts, a week ahead.
 *
 * Every day comes out as { date: 'YYYY-MM-DD', tmax, tmin, rh, wind, rs, rain, et0, src }.
 * `fetchFn` is the caller's fetch.
 */

import { penmanMonteith, hargreaves, ra, rsFromCover, dayOfYear } from './et.js';

const POWER = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const NWS = 'https://api.weather.gov';
const ymd = (d) => d.toISOString().slice(0, 10);
const compact = (s) => s.replace(/-/g, '');

/** ET0 for a day from whatever it has: sunshine -> Penman-Monteith; cloud -> PM with sunshine from cloud; else Hargreaves. */
export function et0For(day, lat, elev = 200) {
  const doy = dayOfYear(day.date);
  if (![day.tmax, day.tmin].every(Number.isFinite)) return null;
  let rs = day.rs;
  if (!Number.isFinite(rs) && Number.isFinite(day.cover)) rs = rsFromCover(day.cover, lat, doy);
  if (!Number.isFinite(rs)) rs = 0.16 * Math.sqrt(Math.max(0, day.tmax - day.tmin)) * ra(lat, doy); // FAO-56 eq. 50
  if (Number.isFinite(day.rh) || Number.isFinite(day.wind)) {
    return penmanMonteith({ tmax: day.tmax, tmin: day.tmin, rh: Number.isFinite(day.rh) ? day.rh : undefined, wind: Number.isFinite(day.wind) ? day.wind : 2, rs }, lat, doy, elev);
  }
  return hargreaves(day.tmax, day.tmin, lat, doy);
}

/** POWER daily days from `start` to `end` ('YYYY-MM-DD'); missing values (-999) are null. */
export async function powerDays(lat, lng, start, end, fetchFn = fetch) {
  const url = `${POWER}?parameters=T2M_MAX,T2M_MIN,RH2M,WS2M,ALLSKY_SFC_SW_DWN,PRECTOTCORR&community=AG&longitude=${lng.toFixed(4)}&latitude=${lat.toFixed(4)}&start=${compact(start)}&end=${compact(end)}&format=JSON`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`NASA POWER answered ${res.status}`);
  const j = await res.json();
  const p = j.properties?.parameter || {};
  const elev = j.geometry?.coordinates?.[2] ?? 200;
  const v = (k, d) => { const x = p[k]?.[d]; return x === undefined || x === null || x <= -998 ? null : x; };
  const days = Object.keys(p.T2M_MAX || {}).sort().map((d) => {
    const day = { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, tmax: v('T2M_MAX', d), tmin: v('T2M_MIN', d), rh: v('RH2M', d), wind: v('WS2M', d), rs: v('ALLSKY_SFC_SW_DWN', d), rain: v('PRECTOTCORR', d), src: 'power' };
    return day;
  }).filter((d) => d.tmax !== null && d.tmin !== null);
  for (const d of days) d.et0 = et0For(d, lat, elev);
  return { days, elev };
}

/** The ten whole years before this one, from POWER: the typical-year runs. */
export async function typicalYears(lat, lng, { years = 10, now = new Date(), fetchFn = fetch } = {}) {
  const y1 = now.getUTCFullYear() - 1, y0 = y1 - years + 1;
  const [power, prism] = await Promise.all([
    powerDays(lat, lng, `${y0}-01-01`, `${y1}-12-31`, fetchFn),
    prismRain(lat, lng, `${y0}-01-01`, `${y1}-12-31`, fetchFn).catch(() => null),
  ]);
  return { ...power, rainFrom: withPrism(power.days, prism) };
}

/* ------------------------------------------------------------ RAIN BY THE HOUR */

/* HOW FAST IT RAINED (owner, 2026-10-25: "we should try to find out the rate of rainfall, at least for short term
   'past week' type looks"). The Iowa Environmental Mesonet's reanalysis (IEMRE, free, open to browsers) serves each
   point's hourly rain: the National Weather Service's Stage IV radar analysis, gauge-corrected, adjusted to PRISM
   (mesonet.agron.iastate.edu/iemre). The plan keeps PRISM's daily total and takes only the hours' shape from it. */
export const IEMRE = 'https://mesonet.agron.iastate.edu/iemre/hourly';

/** One local day's hourly rain at a point: [{ utc: ms, mm }]. */
export async function iemreHours(lat, lng, date, fetchFn = fetch) {
  const res = await fetchFn(`${IEMRE}/${date}/${lat.toFixed(4)}/${lng.toFixed(4)}/json`);
  if (!res.ok) throw new Error(`IEMRE answered ${res.status}`);
  const j = await res.json();
  return (j.data || []).map((h) => ({ utc: Date.parse(h.valid_utc.replace(/Z$/, ':00Z')), mm: Number.isFinite(h.hourly_precip_in) ? h.hourly_precip_in * 25.4 : 0 }));
}

/**
 * The 24 hours a day's rain total belongs to, scaled to that total. A PRISM day is the 24 hours ENDING 12:00 UTC on
 * its date (7 a.m. Central daylight) -- checked on the owner's lot over 14 rainy days, Aug-Oct 2026: that window's
 * radar total tracks PRISM's (e.g. 28.7 against 31.5 mm, 15.2 against 17.8), the others do not (FINDINGS H39); a
 * POWER or station day is taken as the UTC day. hours: [{ utc, mm }] spanning the day before to the day after.
 * -> [mm x 24], or null when the radar has no rain in the window to give it a shape
 */
export function rainHours(dayMm, date, hours, { prism = true } = {}) {
  if (!(dayMm > 0) || !hours?.length) return null;
  const H = 3600e3, start = Date.parse(`${date}T00:00:00Z`) - (prism ? 12 * H : 0);
  const mm = new Array(24).fill(0);
  for (const h of hours) { const k = Math.floor((h.utc - start) / H); if (k >= 0 && k < 24) mm[k] += h.mm; }
  const total = mm.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;
  return mm.map((v) => +((v * dayMm) / total).toFixed(2));
}

/** The recent rainy days' hours (at least `minMm`; the last `maxDays` of them), on `days` as d.hours. */
export async function addRainHours(days, lat, lng, { minMm = 2.5, maxDays = 12, fetchFn = fetch } = {}) {
  const wet = days.filter((d) => d.src !== 'forecast' && d.rain >= minMm).slice(-maxDays);
  const need = new Set();
  for (const d of wet) { const t = Date.parse(`${d.date}T12:00:00Z`); for (const o of [-1, 0, 1]) need.add(new Date(t + o * 864e5).toISOString().slice(0, 10)); }
  const got = new Map(), list = [...need];
  // four at a time
  for (let k = 0; k < list.length; k += 4) {
    await Promise.all(list.slice(k, k + 4).map((date) => iemreHours(lat, lng, date, fetchFn).then((h) => got.set(date, h)).catch(() => {})));
  }
  let n = 0;
  for (const d of wet) {
    const t = Date.parse(`${d.date}T12:00:00Z`);
    const hours = [-1, 0, 1].flatMap((o) => got.get(new Date(t + o * 864e5).toISOString().slice(0, 10)) || []);
    const h = rainHours(d.rain, d.date, hours, { prism: /PRISM/.test(d.src || '') });
    if (h) { d.hours = h; d.peakMmH = Math.max(...h); n++; }
  }
  return n;
}

/* ---------------------------------------------------------------- PRISM rain */

/* RAIN FROM PRISM, NOT NASA (owner, 2026-10-19: the plan's July rain read high -- 3.95 in, where other
   sources give 2.7-3.4). NASA POWER's rain is a ~50 km grid; PRISM's daily grid is 4 km and built from the
   rain gauges (Oregon State's PRISM Climate Group), served free and open to browsers by the NOAA Regional
   Climate Centers' ACIS (data.rcc-acis.org, grid 21). On the owner's lot, ten Julys: POWER median 3.94 in,
   PRISM 2.94. POWER keeps the temperatures, humidity, wind and sunshine. */
export const ACIS = 'https://data.rcc-acis.org/GridData';

/** PRISM daily rain (mm) by 'YYYY-MM-DD' at a point, from start to end; missing days absent. */
export async function prismRain(lat, lng, start, end, fetchFn = fetch) {
  const q = encodeURIComponent(JSON.stringify({ loc: `${lng.toFixed(4)},${lat.toFixed(4)}`, sdate: start, edate: end, grid: '21', elems: [{ name: 'pcpn' }] }));
  const res = await fetchFn(`${ACIS}?params=${q}`);
  if (!res.ok) throw new Error(`ACIS answered ${res.status}`);
  const j = await res.json();
  const out = new Map();
  for (const [d, v] of j.data || []) { const x = Number(v); if (Number.isFinite(x) && x >= 0) out.set(d, x * 25.4); }
  return out;
}

/** Put PRISM's rain on the days it has; -> which source the rain came from. */
function withPrism(days, prism) {
  if (!prism || !prism.size) return 'NASA POWER';
  let n = 0;
  for (const d of days) if (prism.has(d.date)) { d.rain = prism.get(d.date); d.src = `${d.src} + PRISM rain`; n++; }
  return n ? 'PRISM (4 km, from the rain gauges)' : 'NASA POWER';
}

/* ---------------------------------------------------------------- the NWS */

/** 'PT3H' / 'P1DT6H' -> hours. */
export function hoursOf(iso) {
  const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(iso || '');
  return m ? (Number(m[1] || 0) * 24 + Number(m[2] || 0) + Number(m[3] || 0) / 60) : 1;
}

/** NWS grid layer -> hour-by-hour Map(ms -> value); `share` spreads an amount (rain) over its hours. */
export function hourly(layer, { share = false, scale = 1 } = {}) {
  const out = new Map();
  for (const { validTime, value } of layer?.values || []) {
    if (value === null || value === undefined) continue;
    const [start, dur] = validTime.split('/');
    const t0 = Date.parse(start), h = Math.max(1, Math.round(hoursOf(dur)));
    for (let k = 0; k < h; k++) out.set(t0 + k * 36e5, (share ? value / h : value) * scale);
  }
  return out;
}

/** The local calendar date of a time, in an IANA zone. */
const localDate = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/* 10 m wind -> 2 m (FAO-56 eq. 47): x 4.87 / ln(67.8 z - 5.42) = 0.748 at z = 10 m. */
const TO_2M = 4.87 / Math.log(67.8 * 10 - 5.42);

/** The NWS forecast a week ahead, as whole local days (the part of today still to come included). */
export async function nwsForecast(lat, lng, fetchFn = fetch) {
  const pt = await (await fetchFn(`${NWS}/points/${lat.toFixed(4)},${lng.toFixed(4)}`, { headers: { Accept: 'application/geo+json' } })).json();
  const tz = pt.properties?.timeZone || 'America/New_York';
  const grid = (await (await fetchFn(pt.properties.forecastGridData, { headers: { Accept: 'application/geo+json' } })).json()).properties;
  const elev = grid.elevation?.value ?? 200;
  const T = hourly(grid.temperature), RH = hourly(grid.relativeHumidity), W = hourly(grid.windSpeed, { scale: 1 / 3.6 }), C = hourly(grid.skyCover, { scale: 0.01 }), R = hourly(grid.quantitativePrecipitation, { share: true });
  const byDay = new Map();
  for (const [ms, t] of T) {
    const d = localDate(ms, tz);
    const e = byDay.get(d) || { date: d, temps: [], rh: [], wind: [], cover: [], rain: 0, hours: 0 };
    e.temps.push(t); e.hours++;
    if (RH.has(ms)) e.rh.push(RH.get(ms));
    if (W.has(ms)) e.wind.push(W.get(ms) * TO_2M);
    if (C.has(ms)) e.cover.push(C.get(ms));
    e.rain += R.get(ms) || 0;
    byDay.set(d, e);
  }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const days = [...byDay.values()].filter((e) => e.hours >= 12).map((e) => ({
    date: e.date, tmax: Math.max(...e.temps), tmin: Math.min(...e.temps), rh: mean(e.rh), wind: mean(e.wind), cover: mean(e.cover), rs: null, rain: e.rain, src: 'nws forecast',
  })).sort((a, b) => a.date.localeCompare(b.date));
  for (const d of days) d.et0 = et0For(d, lat, elev);
  return { days, tz, stations: pt.properties.observationStations };
}

/** The nearest NWS station's observations between `start` and now, as local days (fills POWER's last days). */
export async function nwsObserved(stationsUrl, start, tz, lat, fetchFn = fetch) {
  const st = await (await fetchFn(stationsUrl, { headers: { Accept: 'application/geo+json' } })).json();
  const id = st.features?.[0]?.properties?.stationIdentifier;
  if (!id) return { days: [], station: null };
  const obs = await (await fetchFn(`${NWS}/stations/${id}/observations?start=${encodeURIComponent(new Date(start).toISOString())}&limit=500`, { headers: { Accept: 'application/geo+json' } })).json();
  const byDay = new Map();
  for (const f of obs.features || []) {
    const p = f.properties, ms = Date.parse(p.timestamp), d = localDate(ms, tz);
    const e = byDay.get(d) || { date: d, temps: [], rh: [], wind: [], rain: 0, rainSeen: 0, n: 0 };
    if (Number.isFinite(p.temperature?.value)) e.temps.push(p.temperature.value);
    if (Number.isFinite(p.relativeHumidity?.value)) e.rh.push(p.relativeHumidity.value);
    if (Number.isFinite(p.windSpeed?.value)) e.wind.push((p.windSpeed.value / 3.6) * TO_2M);
    if (Number.isFinite(p.precipitationLastHour?.value)) { e.rain += p.precipitationLastHour.value; e.rainSeen++; }
    e.n++;
    byDay.set(d, e);
  }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const days = [...byDay.values()].filter((e) => e.temps.length >= 12).map((e) => ({
    date: e.date, tmax: Math.max(...e.temps), tmin: Math.min(...e.temps), rh: mean(e.rh), wind: mean(e.wind), rs: null,
    rain: e.rainSeen ? e.rain : null, src: `nws station ${id}`,
  })).sort((a, b) => a.date.localeCompare(b.date));
  for (const d of days) d.et0 = et0For(d, lat);
  return { days, station: id };
}

/**
 * THIS WEEK: the last `back` days (POWER, then the station for the days POWER has not reached),
 * and the forecast after today. Gauge totals the user gives ({ 'YYYY-MM-DD': mm }) replace rain.
 */
export async function thisWeek(lat, lng, { back = 14, now = new Date(), gauge = {}, fetchFn = fetch } = {}) {
  const start = ymd(new Date(now.getTime() - back * 864e5));
  const [power, prism] = await Promise.all([
    powerDays(lat, lng, start, ymd(now), fetchFn).catch(() => ({ days: [] })),
    prismRain(lat, lng, start, ymd(now), fetchFn).catch(() => null),
  ]);
  withPrism(power.days, prism);
  const past = power.days.filter((d) => d.rain !== null);
  const fc = await nwsForecast(lat, lng, fetchFn).catch(() => null);
  let filled = [];
  const lastPast = past.length ? past[past.length - 1].date : start;
  if (fc?.stations) {
    const ob = await nwsObserved(fc.stations, Date.parse(`${lastPast}T00:00:00Z`) + 864e5, fc.tz, lat, fetchFn).catch(() => ({ days: [] }));
    const today = fc.days[0]?.date;
    filled = ob.days.filter((d) => d.date > lastPast && (!today || d.date < today));
  }
  const coming = fc ? fc.days.filter((d) => d.date > lastPast) : [];
  // PRISM reaches the days the station fills too (it runs a day behind; POWER three or four)
  withPrism(filled, prism);
  /* A day neither POWER nor the station has yet: PRISM's rain (or none), and the water use of the last
     three known days -- so the run has no hole between the past and the forecast. */
  const today0 = fc?.days[0]?.date ?? ymd(now);
  const known = [...past, ...filled];
  const lastKnown = known.length ? known[known.length - 1].date : start;
  const recentEt = known.slice(-3).map((d) => d.et0).filter(Number.isFinite);
  const etGuess = recentEt.length ? recentEt.reduce((a, b) => a + b, 0) / recentEt.length : 2;
  for (let t = Date.parse(`${lastKnown}T12:00:00Z`) + 864e5; ymd(new Date(t)) < today0; t += 864e5) {
    const date = ymd(new Date(t)), tmp = known[known.length - 1] || { tmax: 20, tmin: 10 };
    filled.push({ date, tmax: tmp.tmax, tmin: tmp.tmin, rain: prism?.get(date) ?? 0, et0: etGuess, src: prism?.has(date) ? 'PRISM rain; water use from the days before' : 'no record yet' });
  }
  filled.sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set();
  const days = [...past, ...filled, ...coming].filter((d) => !seen.has(d.date) && seen.add(d.date));
  for (const d of days) if (gauge[d.date] !== undefined) { d.rain = gauge[d.date]; d.src += ' + gauge'; }
  // how fast the recent rains fell (IEMRE's hours, scaled to the day's total); without them, daily totals
  const hourly = await addRainHours(days.filter((d) => d.date < (fc?.days[0]?.date ?? ymd(now))), lat, lng, { fetchFn }).catch(() => 0);
  return { days, today: fc?.days[0]?.date ?? ymd(now), hourly };
}
