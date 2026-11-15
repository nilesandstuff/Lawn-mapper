/**
 * THE WEATHER OF A MOMENT, for the ground-truth walks (owner, 2026-11-15: "once a walk comes in, we'll have the current
 * weather data we need for the time and place of the walk"). The surface at a minute (surfacenow.js) needs the air's
 * temperature and humidity, the open wind and the sunshine (or the cloud) at that minute.
 *
 * Sources are tried in order and each fills what it has; a series is frozen in the water database the first time a
 * walk is compared (src/truth.js), so a later archive change cannot move an old comparison.
 *
 *   ASOS   the nearest airport station still reporting (the wind's list, public/data/asos-stations.json), IEM's
 *          archive of its routine and special reports (free, no key, kept for decades): air, dew point, humidity,
 *          wind at the 10 m mast (to 2 m over grass, FAO-56 eq. 47), and the sky cover by layer, read as a cloud
 *          fraction (the most covered layer: FEW 2/8, SCT 4/8, BKN 6/8, OVC and VV 8/8). No sunshine. Fetched by
 *          the water Worker.
 *   SAT    Open-Meteo's Satellite Radiation API: the global horizontal irradiance from GOES every 10 minutes on a
 *          2 km grid, about 20 minutes behind, archived from April 2025 (the research agent, 2026-11-15; verified).
 *          The MEASURED sunshine the moment needs, though a 2 km, 10-minute value cannot see one cloud's shadow
 *          cross the lawn.
 *   HRRR   Open-Meteo's Historical Forecast API, its best model for the place (NOAA's 3 km HRRR every 15 minutes in
 *          the US until Open-Meteo retires it at the end of November 2026, then its successor): air, humidity,
 *          10 m wind, sunshine; the fallback for what the station and the satellite lack.
 *          Both Open-Meteo sources are free for non-commercial use, 10,000 calls a day COUNTED BY ADDRESS, and a
 *          shared server address (this sandbox; a Cloudflare Worker) is refused once its neighbours have spent the
 *          day's share (seen 2026-11-15). So the PAGE fetches them, from the admin's own address, and hands the
 *          rows to the Worker, which adds the station's and freezes them. Data CC BY 4.0, named on the card.
 *
 * A series: [{ src, t (ms UTC), ta (C), rh (%), wind (m/s at 2 m), cloud (0-1) | null, ghi (W/m2) | null }], sorted;
 * each moment takes each quantity from the best source that has it near that minute (PREFER).
 */

import { IEM_ASOS, KT, TO_2M, nearestStations } from './wind.js';

/* which source first, quantity by quantity: the observed station for the air (the walker's thermometer goes before
   all of them, in the worker), the satellite for the sunshine, the model where nothing measured answers */
export const PREFER = { ta: ['asos', 'hrrr'], rh: ['asos', 'hrrr'], wind: ['asos', 'hrrr'], ghi: ['sat', 'hrrr'], cloud: ['asos'] };

const COVER = { CLR: 0, SKC: 0, NSC: 0, NCD: 0, FEW: 2 / 8, SCT: 4 / 8, BKN: 6 / 8, OVC: 1, VV: 1 };

/** IEM's reports for one station between two times (ms), routine and special, UTC. */
export function asosMomentUrl(id, t0, t1) {
  const a = new Date(t0), b = new Date(t1 + 864e5); // the archive takes whole days; the end day is exclusive
  const d = (x, k) => `year${k}=${x.getUTCFullYear()}&month${k}=${x.getUTCMonth() + 1}&day${k}=${x.getUTCDate()}`;
  return `${IEM_ASOS}?station=${encodeURIComponent(id)}&data=tmpf&data=dwpf&data=relh&data=sknt&data=skyc1&data=skyc2&data=skyc3&data=skyc4&${d(a, 1)}&${d(b, 2)}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=empty&trace=empty&report_type=3&report_type=4`;
}

/** The CSV as series rows, kept between t0 and t1 (ms). */
export function parseAsosMoment(csv, t0 = -Infinity, t1 = Infinity) {
  const out = [];
  const lines = String(csv).split('\n');
  const head = (lines[0] || '').split(',');
  const col = (name) => head.indexOf(name);
  const iT = col('valid'), iTa = col('tmpf'), iRh = col('relh'), iKt = col('sknt'), iSky = ['skyc1', 'skyc2', 'skyc3', 'skyc4'].map(col);
  if (iT < 0) return out;
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const t = Date.parse(`${(f[iT] || '').replace(' ', 'T')}:00Z`);
    if (!Number.isFinite(t) || t < t0 || t > t1) continue;
    const tf = parseFloat(f[iTa]), rh = parseFloat(f[iRh]), kt = parseFloat(f[iKt]);
    const covers = iSky.map((i) => (i >= 0 ? COVER[(f[i] || '').trim()] : undefined)).filter((c) => c !== undefined);
    out.push({
      t,
      ta: Number.isFinite(tf) ? ((tf - 32) * 5) / 9 : null,
      rh: Number.isFinite(rh) ? rh : null,
      wind: Number.isFinite(kt) ? kt * KT * TO_2M : null,
      cloud: covers.length ? Math.max(...covers) : null,
      ghi: null,
      src: 'asos',
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** One moment from a series: each quantity from the first source in PREFER that has it near the minute (within
 *  maxGapMin), ta, rh, wind and ghi straight-line between the reports either side, the cloud from the nearest report.
 *  -> { t, ta, rh, wind, cloud, ghi, gapMin, from: { quantity: source } } */
export function atMoment(series, t, { maxGapMin = 90, prefer = PREFER } = {}) {
  const near = maxGapMin * 6e4;
  const lerp = (rows, key) => {
    let before = null, after = null;
    for (const r of rows) {
      if (!Number.isFinite(r[key])) continue;
      if (r.t <= t) before = r; else { after = r; break; }
    }
    if (before && after && after.t - before.t <= 2 * near) return { v: before[key] + ((after[key] - before[key]) * (t - before.t)) / (after.t - before.t), gap: Math.min(t - before.t, after.t - t) };
    const one = before || after;
    return one && Math.abs(one.t - t) <= near ? { v: one[key], gap: Math.abs(one.t - t) } : null;
  };
  const nearest = (rows, key) => {
    let best = null;
    for (const r of rows) if (Number.isFinite(r[key]) && (!best || Math.abs(r.t - t) < Math.abs(best.t - t))) best = r;
    return best && Math.abs(best.t - t) <= near ? { v: best[key], gap: Math.abs(best.t - t) } : null;
  };
  const out = { t, from: {} };
  let gap = null;
  for (const key of ['ta', 'rh', 'wind', 'ghi', 'cloud']) {
    const order = [...(prefer[key] || []), null]; // null: any source, the last resort (an untagged series)
    let got = null;
    for (const src of order) {
      const rows = series.filter((r) => (src === null ? !order.includes(r.src) || !r.src : r.src === src));
      got = key === 'cloud' ? nearest(rows, key) : lerp(rows, key);
      if (got) { out.from[key] = src || rows.find((r) => Number.isFinite(r[key]))?.src || 'series'; break; }
    }
    out[key] = got ? got.v : null;
    if (got && (key === 'ghi' || key === 'cloud')) gap = gap === null ? got.gap / 6e4 : Math.min(gap, got.gap / 6e4);
  }
  out.gapMin = gap;
  return out;
}

/* OPEN-METEO, fetched by the page (above): the two calls for a walk's day, and their rows. Open-Meteo's sunshine is
   the mean over the interval ending at its time stamp, so it is placed at the interval's middle. */
const ymdUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
export function openMeteoUrls(lat, lng, t0, t1) {
  const a = ymdUtc(t0 - 36e5), b = ymdUtc(t1 + 36e5), at = `latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&start_date=${a}&end_date=${b}&timezone=GMT`;
  return {
    sat: `https://satellite-api.open-meteo.com/v1/archive?${at}&hourly=shortwave_radiation&models=satellite_radiation_seamless&temporal_resolution=native`,
    hrrr: `https://historical-forecast-api.open-meteo.com/v1/forecast?${at}&minutely_15=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation&models=best_match&wind_speed_unit=ms`,
  };
}
export function parseOpenMeteo(j, src, t0 = -Infinity, t1 = Infinity) {
  const block = src === 'sat' ? j?.hourly : j?.minutely_15;
  if (!block?.time?.length) return [];
  const times = block.time.map((x) => Date.parse(`${x}:00Z`));
  const step = times.length > 1 ? times[1] - times[0] : src === 'sat' ? 6e5 : 9e5;
  const out = [];
  times.forEach((tt, k) => {
    if (!Number.isFinite(tt)) return;
    const g = block.shortwave_radiation?.[k];
    if (src === 'sat') { if (Number.isFinite(g) && tt - step / 2 >= t0 && tt - step / 2 <= t1) out.push({ src, t: tt - step / 2, ta: null, rh: null, wind: null, cloud: null, ghi: g }); return; }
    if (tt < t0 || tt > t1) return;
    const u10 = block.wind_speed_10m?.[k];
    out.push({ src, t: tt, ta: block.temperature_2m?.[k] ?? null, rh: block.relative_humidity_2m?.[k] ?? null, wind: Number.isFinite(u10) ? u10 * TO_2M : null, cloud: null, ghi: null });
    if (Number.isFinite(g)) out.push({ src, t: tt - step / 2, ta: null, rh: null, wind: null, cloud: null, ghi: g });
  });
  return out.sort((x, y) => x.t - y.t);
}

/** Rows the page fetched (Open-Meteo), checked before they are kept: known sources, numbers in range, inside the
 *  walk's window. -> rows */
export function cleanRows(rows, t0, t1, pad = 36e5) {
  const ok = (v, lo, hi) => (v === null || v === undefined ? null : Number.isFinite(Number(v)) && v >= lo && v <= hi ? Number(v) : null);
  return (Array.isArray(rows) ? rows : []).slice(0, 2000).filter((r) => ['sat', 'hrrr'].includes(r?.src) && Number.isFinite(r.t) && r.t >= t0 - pad && r.t <= t1 + pad)
    .map((r) => ({ src: r.src, t: r.t, ta: ok(r.ta, -60, 60), rh: ok(r.rh, 0, 100), wind: ok(r.wind, 0, 60), cloud: null, ghi: ok(r.ghi, 0, 1500) }));
}

/**
 * The weather round a walk (t0-t1, ms), an hour either side. stations: the ASOS list. -> { sources: [{ name, km, rows }],
 * series } -- km, never the station's position. Throws when nothing answers.
 */
export async function weatherOfMoment(stations, lat, lng, t0, t1, { fetchFn = fetch, pad = 36e5, extra = null } = {}) {
  const sources = [];
  let series = [];
  const more = cleanRows(extra?.rows, t0, t1, pad);
  for (const src of ['sat', 'hrrr']) {
    const n = more.filter((r) => r.src === src).length;
    if (n) sources.push({ name: src === 'sat' ? 'Open-Meteo satellite sunshine (GOES, 2 km, 10 min; CC BY 4.0)' : 'Open-Meteo best model (HRRR in the US, 15 min; CC BY 4.0)', km: null, rows: n, has: src === 'sat' ? 'sunshine' : 'air, humidity, wind, sunshine (model)' });
  }
  for (const s of nearestStations(stations, lat, lng, 3, { year: new Date(t0).getUTCFullYear() })) {
    try {
      const res = await fetchFn(asosMomentUrl(s.id, t0 - pad, t1 + pad));
      if (!res.ok) continue;
      const rows = parseAsosMoment(await res.text(), t0 - pad, t1 + pad).filter((r) => Number.isFinite(r.ta));
      if (rows.length < 2) continue;
      sources.push({ name: `ASOS ${s.id}`, km: Math.round(s.km * 10) / 10, rows: rows.length, has: 'air, humidity, wind, sky cover' });
      series = rows;
      break;
    } catch { /* the next station */ }
  }
  series = [...series, ...more].sort((a, b) => a.t - b.t);
  if (!series.length) throw new Error('no station answered for that time');
  return { sources, series };
}
