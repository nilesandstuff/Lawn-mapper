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
  return powerDays(lat, lng, `${y0}-01-01`, `${y1}-12-31`, fetchFn);
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
  const power = await powerDays(lat, lng, start, ymd(now), fetchFn).catch(() => ({ days: [] }));
  const past = power.days.filter((d) => d.rain !== null);
  const fc = await nwsForecast(lat, lng, fetchFn).catch(() => null);
  let filled = [];
  const lastPast = past.length ? past[past.length - 1].date : start;
  if (fc?.stations) {
    const ob = await nwsObserved(fc.stations, Date.parse(`${lastPast}T00:00:00Z`) + 864e5, fc.tz, lat, fetchFn).catch(() => ({ days: [] }));
    const today = fc.days[0]?.date;
    filled = ob.days.filter((d) => d.date > lastPast && (!today || d.date < today));
  }
  const coming = fc ? fc.days.filter((d) => !filled.length || d.date > filled[filled.length - 1].date).filter((d) => d.date > lastPast) : [];
  const days = [...past, ...filled, ...coming];
  for (const d of days) if (gauge[d.date] !== undefined) { d.rain = gauge[d.date]; d.src += ' + gauge'; }
  return { days, today: fc?.days[0]?.date ?? ymd(now) };
}
