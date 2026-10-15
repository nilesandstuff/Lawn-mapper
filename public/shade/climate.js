/**
 * CLOUDS AND THE GROWING SEASON (shade map, step 3).
 *
 * Steps 1-2 give each patch of lawn its share of a CLEAR sky. Real days
 * are cloudier, and grass only uses light while it grows. Both come from
 * NASA POWER (power.larc.nasa.gov, free, no key), daily, ten years:
 *
 *   ALLSKY_SFC_SW_DWN    sunlight reaching the ground, clouds included, MJ/m2/day
 *   ALLSKY_SFC_SW_DIFF   the diffuse (scattered sky) part of it
 *   T2M                  mean air temperature, C
 *
 * folded into a typical year: for each day of the year, the mean (and the
 * 10th and 90th percentiles) over the ten years and a week either side.
 *
 * A PATCH'S LIGHT ON A REAL DAY. The clear-sky ray tracing says, for each
 * patch and each date, what share of OPEN ground's direct beam it gets
 * (beamShare: shade, and the ground's slope) and what share of the sky it
 * sees (sky view). NASA says how much of the day's light came as beam and
 * as diffuse. So:
 *
 *   DLI = 2.04 umol/J x [ beam MJ x beamShare + diffuse MJ x skyView ]
 *
 * (assuming clouds come and go without favoring morning or afternoon).
 *
 * THE GROWING SEASON, ESTIMATED until Turf Tools' numbers arrive: growth
 * potential (PACE Turf; Gelernter & Stowell 2005), a bell curve of daily
 * mean temperature around the grass type's optimum:
 *
 *   GP = exp( -0.5 ((T - Topt) / sd)^2 )   cool-season 20 C, sd 5.5
 *                                          warm-season 31 C, sd 7
 *
 * and the season is the days with GP at least 0.5.
 */

export const GRASS = {
  cool: { label: 'Cool-season', opt: 20, sd: 5.5 },
  warm: { label: 'Warm-season', opt: 31, sd: 7 },
};
export const SEASON_GP = 0.5;
export const PAR_MOL_PER_MJ = 2.04;

export const powerUrl = (lng, lat, y0, y1) => 'https://power.larc.nasa.gov/api/temporal/daily/point?'
  + new URLSearchParams({
    parameters: 'ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DIFF,T2M', community: 'AG',
    longitude: lng.toFixed(3), latitude: lat.toFixed(3), start: `${y0}0101`, end: `${y1}1231`, format: 'JSON',
  });

/** 0-based day of the year for 'YYYYMMDD', 29 Feb folded onto 28 Feb, so every year has 365. */
export function dayIndex(ymd) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(4, 6)) - 1, d = Number(ymd.slice(6, 8));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const doy = Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000);
  return leap && doy >= 59 ? Math.max(58, doy - 1) : doy;
}

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/**
 * A NASA POWER daily response -> the typical year: 365 values each of
 * ghi (mean MJ), ghiP10, ghiP90, diffuse (mean share of ghi, 0..1), tMean (C).
 * Each day pools the same date +- `halfWindow` days over every year.
 */
export function typicalYear(power, { halfWindow = 7 } = {}) {
  const p = power?.properties?.parameter;
  if (!p?.ALLSKY_SFC_SW_DWN || !p?.T2M) throw new Error('NASA POWER sent no sunlight or temperature');
  const fill = Number(power?.header?.fill_value ?? -999);
  const by = Array.from({ length: 365 }, () => ({ ghi: [], diff: [], t: [] }));
  for (const [ymd, ghi] of Object.entries(p.ALLSKY_SFC_SW_DWN)) {
    const k = dayIndex(ymd);
    const diff = p.ALLSKY_SFC_SW_DIFF?.[ymd];
    const t = p.T2M[ymd];
    if (Number.isFinite(ghi) && ghi !== fill && ghi >= 0) {
      by[k].ghi.push(ghi);
      if (Number.isFinite(diff) && diff !== fill && ghi > 0) by[k].diff.push(Math.min(1, Math.max(0, diff / ghi)));
    }
    if (Number.isFinite(t) && t !== fill) by[k].t.push(t);
  }
  const out = { ghi: [], ghiP10: [], ghiP90: [], diffuse: [], tMean: [], years: new Set(Object.keys(p.T2M).map((d) => d.slice(0, 4))).size };
  for (let k = 0; k < 365; k++) {
    const g = [], f = [], t = [];
    for (let j = -halfWindow; j <= halfWindow; j++) {
      const b = by[(k + j + 365) % 365];
      g.push(...b.ghi); f.push(...b.diff); t.push(...b.t);
    }
    g.sort((a, b) => a - b);
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
    out.ghi.push(mean(g)); out.ghiP10.push(pct(g, 0.1)); out.ghiP90.push(pct(g, 0.9));
    out.diffuse.push(f.length ? mean(f) : NaN); out.tMean.push(mean(t));
  }
  /* Where POWER gave no diffuse split, Erbs et al. (1982) from clearness would
     go here; POWER has always sent it so far, so a missing day takes 0.5. */
  out.diffuse = out.diffuse.map((v) => (Number.isFinite(v) ? v : 0.5));
  return out;
}

/* ------------------------------------------- this year as it is */

/** NASA POWER's daily T2M for one year -> { 'YYYYMMDD': C } without fill values. */
export function observedDays(power) {
  const t = power?.properties?.parameter?.T2M || {};
  const fill = Number(power?.header?.fill_value ?? -999);
  const out = {};
  for (const [ymd, v] of Object.entries(t)) if (Number.isFinite(v) && v !== fill && v > -90) out[ymd] = v;
  return out;
}

/**
 * The NWS point forecast's periods (api.weather.gov, F, day and night in
 * turn) -> { 'YYYYMMDD': mean C }, each day the mean of its daytime high and
 * the following night's low; a lone period counts alone.
 */
export function nwsDailyMeans(periods) {
  const by = {};
  for (const p of periods || []) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(p.startTime || '');
    if (!m || !Number.isFinite(Number(p.temperature))) continue;
    /* A night period starting at 18:00 belongs to the day it started on. */
    const ymd = `${m[1]}${m[2]}${m[3]}`;
    const c = p.temperatureUnit === 'C' ? Number(p.temperature) : ((Number(p.temperature) - 32) * 5) / 9;
    (by[ymd] ||= []).push(c);
  }
  const out = {};
  for (const [ymd, a] of Object.entries(by)) out[ymd] = a.reduce((s, v) => s + v, 0) / a.length;
  return out;
}

const ymdOf = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * THIS YEAR AS IT IS (owner, 2026-10-15: "leaf drop should be determined by
 * weather"; this fall ran warm and the typical-year calendar had the lawn
 * trees half bare two weeks before they were). The typical year's daily
 * mean (365, climate.js typicalYear) with:
 *   - the days already lived replaced by what was observed (NASA POWER, a
 *     few days behind),
 *   - the week ahead by the forecast (NWS, where it answers),
 *   - and beyond that the typical mean plus the recent anomaly (the last
 *     `memoryDays` observed days against typical), fading with an e-folding
 *     of `fadeDays`: a warm fortnight makes a warm week likely, less so
 *     next month (the last 14 days, not 30: in the owner's county 2026 ran
 *     +3 C in early September, -3 C late September, +3 C in October),
 * then a +-`half`-day running mean, as the typical year is pooled, so one
 * hot day does not green a canopy. Returns { tMean, through (day index of
 * the last observed day, or null), forecastTo, anomaly (C), year }.
 */
export function yearAsItIs(typical, observed = {}, forecast = {}, { today = new Date(), half = 7, memoryDays = 14, fadeDays = 20 } = {}) {
  const year = today.getUTCFullYear();
  const raw = Float64Array.from(typical);
  const seen = new Uint8Array(365);
  let through = null, forecastTo = null;
  for (const [ymd, v] of Object.entries(observed)) {
    if (ymd.slice(0, 4) !== String(year)) continue;
    const k = dayIndex(ymd);
    raw[k] = v; seen[k] = 1;
    if (through === null || k > through) through = k;
  }
  /* The anomaly: the last memoryDays observed days against typical. */
  let anomaly = 0;
  if (through !== null) {
    let s = 0, n = 0;
    for (let k = Math.max(0, through - memoryDays + 1); k <= through; k++) if (seen[k]) { s += raw[k] - typical[k]; n++; }
    anomaly = n ? s / n : 0;
  }
  for (const [ymd, v] of Object.entries(forecast)) {
    if (ymd.slice(0, 4) !== String(year)) continue;
    const k = dayIndex(ymd);
    if (seen[k]) continue; // what was observed beats what was forecast
    raw[k] = v; seen[k] = 2;
    if (forecastTo === null || k > forecastTo) forecastTo = k;
  }
  /* Every day after the last observed one that neither source gave (the few
     days before the forecast starts, and all of them after it ends): the
     typical mean plus the anomaly, fading from the last observed day. */
  if (through !== null) for (let k = through + 1; k < 365; k++) if (!seen[k]) raw[k] = typical[k] + anomaly * Math.exp(-(k - through) / fadeDays);
  /* Lived days with no value (a gap in POWER) take the neighbours' smoothing. */
  const tMean = new Float64Array(365);
  for (let k = 0; k < 365; k++) {
    let s = 0, n = 0;
    for (let j = -half; j <= half; j++) { const v = raw[(k + j + 365) % 365]; if (Number.isFinite(v)) { s += v; n++; } }
    tMean[k] = n ? s / n : typical[k];
  }
  return { tMean: Array.from(tMean), through, forecastTo, anomaly, year, today: ymdOf(today) };
}

/** Growth potential, 0..1, at a mean temperature. */
export const growthPotential = (tC, grass = 'cool') => {
  const g = GRASS[grass] || GRASS.cool;
  return Math.exp(-0.5 * ((tC - g.opt) / g.sd) ** 2);
};

/** The season: day indices (0..364) with GP >= SEASON_GP, and its first and last day (null if all year or none). */
export function growingSeason(tMean, grass = 'cool', threshold = SEASON_GP) {
  const on = tMean.map((t) => growthPotential(t, grass) >= threshold);
  const days = on.flatMap((v, k) => (v ? [k] : []));
  if (!days.length) return { days, start: null, end: null, allYear: false };
  if (days.length === 365) return { days, start: null, end: null, allYear: true };
  /* The longest run, wrapping round New Year for warm places. */
  let best = { start: 0, len: 0 };
  for (let k = 0; k < 365; k++) {
    if (!on[k] || on[(k + 364) % 365]) continue;
    let len = 0;
    while (len < 365 && on[(k + len) % 365]) len++;
    if (len > best.len) best = { start: k, len };
  }
  return { days, start: best.start, end: (best.start + best.len - 1) % 365, allYear: false, mainRun: best.len };
}

/** A patch's light on a day: beam and diffuse MJ split, its beam share and sky view -> mol/m2. */
export const dliOn = (ghiMJ, diffuseShare, beamShare, skyView) =>
  PAR_MOL_PER_MJ * (ghiMJ * (1 - diffuseShare) * beamShare + ghiMJ * diffuseShare * skyView);

/** 'Mar 20' for a day index. */
export const dayLabel = (k) => new Date(Date.UTC(2025, 0, 1 + k)).toUTCString().slice(5, 11).replace(/^0/, '').replace(/^(\d+) (\w+)$/, '$2 $1');
