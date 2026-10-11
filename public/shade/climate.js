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
 * (assuming clouds come and go without favouring morning or afternoon).
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
