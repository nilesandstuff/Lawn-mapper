/**
 * THE LOCAL WIND (owner, 2026-10-27: "it'll be necessary to find local weather data to see how windy the area is and
 * what the trends are in regards to wind speed, direction, and other stats"; FINDINGS H48).
 *
 * From the nearest airport weather station with ten years of record (the compact list, public/data/asos-stations.json,
 * from the Iowa Environmental Mesonet: tools/stations.mjs), its hourly reports (IEM's ASOS archive, free, no key, open
 * to browsers): speed (knots at the 10 m mast) and the direction it blows FROM, every routine hour.
 *
 * What the plan takes from it is the DIRECTION by month: the share of the daytime wind (speed-weighted, the hours the
 * grass uses water) from each of 16 directions, so each spot's shelter (what stands upwind of it) is averaged the way
 * the wind actually comes. The day-to-day speed stays the weather's (NASA POWER's, the open-airport wind, H44). The
 * page also shows the station's speeds, calm, gusts and the year-by-year trend.
 */

export const IEM_ASOS = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py';
export const KT = 0.514444; // m/s per knot
export const TO_2M = 4.87 / Math.log(67.8 * 10 - 5.42); // FAO-56 eq. 47: a 10 m wind at 2 m over short grass, 0.748
export const SECTORS = 16;
const RAD = Math.PI / 180;

/** Great-circle distance, km. */
export function kmBetween(lat1, lng1, lat2, lng2) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lng2 - lng1) * RAD) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** The n nearest stations still reporting: [{ id, network, lat, lon, firstYear, name, km }]. */
export function nearestStations(list, lat, lng, n = 3, { year = new Date().getUTCFullYear() } = {}) {
  return (list?.stations || list || [])
    .filter((s) => s[5] === null || s[5] >= year - 1)
    .map(([id, network, slat, slon, firstYear, , name]) => ({ id, network, lat: slat, lon: slon, firstYear, name, km: kmBetween(lat, lng, slat, slon) }))
    .sort((a, b) => a.km - b.km).slice(0, n);
}

/** IEM's hourly archive for a station, routine reports only, UTC: speed, direction, gust. */
export function asosUrl(id, y1, y2) {
  return `${IEM_ASOS}?station=${encodeURIComponent(id)}&data=sknt&data=drct&data=gust&year1=${y1}&month1=1&day1=1&year2=${y2 + 1}&month2=1&day2=1&tz=Etc/UTC&format=onlycomma&latlon=no&missing=empty&trace=empty&report_type=3`;
}

/** The CSV as rows { t (ms UTC), kt, dir (deg from, null when calm or variable), gust (kt | null) }; one per hour. */
export function parseAsos(csv) {
  const rows = [];
  let lastHour = -1;
  for (const line of String(csv).split('\n')) {
    const f = line.split(',');
    if (f.length < 4 || f[0] === 'station') continue;
    const t = Date.parse(`${f[1].replace(' ', 'T')}:00Z`), kt = parseFloat(f[2]);
    if (!Number.isFinite(t) || !Number.isFinite(kt)) continue;
    const hour = Math.floor(t / 3600000);
    if (hour === lastHour) continue; // one report an hour
    lastHour = hour;
    const d = parseFloat(f[3]), g = parseFloat(f[4]);
    rows.push({ t, kt, dir: kt > 0 && Number.isFinite(d) && d > 0 ? d % 360 : null, gust: Number.isFinite(g) ? g : null });
  }
  return rows;
}

const sectorOf = (deg) => Math.round(deg / (360 / SECTORS)) % SECTORS;

/**
 * The station's wind, summed. lng gives local solar time; daytime is 8:00-20:00 solar (the grass's water use).
 * -> { years: [y0, y1], hours, byMonth: [12 { ms, dayMs, calm, gustP90, rose (16 shares of the daytime wind,
 *    speed-weighted), freq (16 shares of the hours) }], byYear: [{ year, ms, hours }], trendPerDecade (m/s),
 *    prevailing (sector of the most daytime wind, summer), all: { ms, dayMs, calm } } -- speeds at 2 m over open
 *    grass (FAO-56 eq. 47 from the 10 m mast).
 */
export function windStats(rows, lng) {
  const M = Array.from({ length: 12 }, () => ({ n: 0, s: 0, dn: 0, ds: 0, calm: 0, gusts: [], rose: new Float64Array(SECTORS), freq: new Float64Array(SECTORS) }));
  const Y = new Map();
  for (const r of rows) {
    const d = new Date(r.t), m = d.getUTCMonth(), y = d.getUTCFullYear();
    const ms = r.kt * KT * TO_2M;
    const solar = (d.getUTCHours() + d.getUTCMinutes() / 60 + lng / 15 + 24) % 24;
    const b = M[m];
    b.n++; b.s += ms;
    if (r.kt < 3) b.calm++;
    if (r.gust !== null) b.gusts.push(r.gust * KT);
    if (r.dir !== null) b.freq[sectorOf(r.dir)]++;
    if (solar >= 8 && solar < 20) { b.dn++; b.ds += ms; if (r.dir !== null) b.rose[sectorOf(r.dir)] += ms; }
    const yy = Y.get(y) || { n: 0, s: 0 }; yy.n++; yy.s += ms; Y.set(y, yy);
  }
  const norm = (a) => { const t = a.reduce((x, v) => x + v, 0); return Array.from(a, (v) => (t > 0 ? Math.round((v / t) * 1e4) / 1e4 : 0)); };
  const q = (a, p) => { if (!a.length) return null; const s = a.sort((x, z) => x - z); return s[Math.floor(p * (s.length - 1))]; };
  const r2 = (v) => Math.round(v * 100) / 100;
  const byMonth = M.map((b) => ({ ms: b.n ? r2(b.s / b.n) : null, dayMs: b.dn ? r2(b.ds / b.dn) : null, calm: b.n ? r2(b.calm / b.n) : null, gustP90: b.gusts.length ? r2(q(b.gusts, 0.9)) : null, rose: norm(b.rose), freq: norm(b.freq) }));
  // whole years only (8,000 hours or more), for the trend
  const byYear = [...Y.entries()].filter(([, v]) => v.n >= 8000).map(([year, v]) => ({ year, ms: r2(v.s / v.n), hours: v.n })).sort((a, b) => a.year - b.year);
  let trend = null;
  if (byYear.length >= 5) {
    const n = byYear.length, mx = byYear.reduce((s, v) => s + v.year, 0) / n, my = byYear.reduce((s, v) => s + v.ms, 0) / n;
    const sxy = byYear.reduce((s, v) => s + (v.year - mx) * (v.ms - my), 0), sxx = byYear.reduce((s, v) => s + (v.year - mx) ** 2, 0);
    trend = r2((sxy / sxx) * 10);
  }
  const summer = new Float64Array(SECTORS);
  for (const m of [5, 6, 7]) M[m].rose.forEach((v, k) => { summer[k] += v; });
  const tot = M.reduce((s, b) => ({ n: s.n + b.n, s: s.s + b.s, dn: s.dn + b.dn, ds: s.ds + b.ds, calm: s.calm + b.calm }), { n: 0, s: 0, dn: 0, ds: 0, calm: 0 });
  const years = rows.length ? [new Date(rows[0].t).getUTCFullYear(), new Date(rows[rows.length - 1].t).getUTCFullYear()] : null;
  return {
    years, hours: rows.length, byMonth, byYear, trendPerDecade: trend,
    prevailing: summer.some((v) => v > 0) ? summer.indexOf(Math.max(...summer)) : null,
    all: { ms: tot.n ? r2(tot.s / tot.n) : null, dayMs: tot.dn ? r2(tot.ds / tot.dn) : null, calm: tot.n ? r2(tot.calm / tot.n) : null },
  };
}

/** A sector's compass name (0 = from the north, clockwise). */
export const sectorName = (k) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][((k % 16) + 16) % 16];

/** Ten whole years of a station, fetched and summed: { station, stats } (stats null when the archive did not answer). */
export async function localWind(list, lat, lng, { fetchFn = fetch, years = 10, now = new Date() } = {}) {
  const y2 = now.getUTCFullYear() - 1, y1 = y2 - years + 1;
  for (const st of nearestStations(list, lat, lng, 3)) {
    if (st.firstYear > y1 || st.km > 80) continue;
    const r = await fetchFn(asosUrl(st.id, y1, y2));
    if (!r.ok) continue;
    const rows = parseAsos(await r.text());
    if (rows.length < years * 6000) continue; // a patchy record: the next nearest
    return { station: { id: st.id, name: st.name, km: Math.round(st.km * 10) / 10 }, stats: windStats(rows, lng), at: now.toISOString().slice(0, 10) };
  }
  return null;
}

/**
 * THE STATION'S RAIN BY THE HOUR, for the ten-year plan (owner's to-do 7: "the typical-year plan runs on daily totals,
 * so it cannot tell a cloudburst from a soak"; FINDINGS H52): the same station's routine hourly reports, their
 * hour's rain (p01i, inches, a trace as none). -> [{ utc (ms), mm }] for the wet hours, oldest first.
 */
export async function stationRain(id, y1, y2, fetchFn = fetch) {
  const url = `${IEM_ASOS}?station=${encodeURIComponent(id)}&data=p01i&year1=${y1}&month1=1&day1=1&year2=${y2 + 1}&month2=1&day2=1&tz=Etc/UTC&format=onlycomma&latlon=no&missing=empty&trace=empty&report_type=3`;
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`IEM answered ${r.status}`);
  const out = [];
  let lastHour = -1;
  for (const line of (await r.text()).split('\n')) {
    const f = line.split(',');
    if (f.length < 3 || f[0] === 'station') continue;
    const t = Date.parse(`${f[1].replace(' ', 'T')}:00Z`), inch = parseFloat(f[2]);
    if (!Number.isFinite(t)) continue;
    const hour = Math.floor(t / 3600000);
    if (hour === lastHour) continue;
    lastHour = hour;
    if (inch > 0) out.push({ utc: hour * 3600000, mm: inch * 25.4 });
  }
  return out;
}
