/**
 * SOIL TEMPERATURE (owner, 2026-10-26: "build a soil temp view. So there's
 * shadow, dli, and hours of light views. Then add soil temps ... break the
 * view up into the time frames with similar trends, and of course show the
 * current 5 day trailing average and the current moment").
 *
 * THE OPEN GROUND'S SOIL comes from NASA POWER's top soil layer (TSOIL1,
 * MERRA-2's first layer, about the top 10 cm): the typical year (climate.js
 * typicalYear) for the time frames, and this year's days as observed for
 * the trailing average. MERRA-2 is a model on a ~50 km cell, so it is the
 * area's soil, not a measurement at this lawn.
 *
 * SHADE COOLS THE SOIL. Each spot's soil is the open ground's less a cooling
 * in proportion to the sunlight the shade takes from it:
 *
 *   T(spot) = T(open) - SOIL_SHADE_C_PER_MJ x (sunlight lost, MJ/m2/day)
 *
 * PROVISIONAL, from one measurement: Edmondson et al. (2016, Sci. Rep.
 * 6:33708; 79 loggers at 1.5 cm in Leicester, UK) found summer (May-July)
 * daily mean soil 17.2 C under grass and 14.1 C under trees and shrubs in
 * non-domestic greenspace, 3.1 C cooler. Leicester's summer days bring about
 * 17 MJ/m2 of sun and a woodland floor loses most of it (taken as 85%, about
 * 14.5 MJ), so about 0.2 C per MJ/m2/day lost. The same study found woody
 * cover slightly WARMER in winter (it holds the night's heat), which this
 * leaves out: with little sun to lose in winter the cooling is small anyway.
 * The water map session is asked for better (2026-10-26).
 */

export const SOIL_SHADE_C_PER_MJ = 0.2;
export const TRAIL_DAYS = 5;

const PAR = 2.04; // mol of photosynthetic light per MJ of sunlight (climate.js PAR_MOL_PER_MJ)
export const toF = (c) => c * 1.8 + 32;

/**
 * A spot's soil over a run of days from the light worker's period answer:
 * the open ground's mean soil `openC` over those days, the open ground's mean
 * DLI `openDli` and the spot's `dli` (both with NASA's clouds). The light it
 * lost, in MJ, is (openDli - dli) / 2.04.
 */
export const shadedSoil = (openC, openDli, dli, k = SOIL_SHADE_C_PER_MJ) =>
  openC - k * Math.max(0, openDli - dli) / PAR;

/** Mean of a 365-day series over some day indices. */
export const meanOver = (series, days) => (days.length ? days.reduce((s, k) => s + series[k], 0) / days.length : NaN);

/**
 * THE TIME FRAMES: the typical year's soil cut into runs of days with the
 * same trend (owner: "break the view up into the time frames with similar
 * trends"). Each day's trend is the slope of the typical soil over three
 * weeks round it; a day is warming or cooling when that slope is more than
 * a third of the year's steepest (a sine of the year's swing is steeper than
 * that for two thirds of the time), and otherwise steady: warm steady above
 * the year's middle, cold steady below. Runs shorter than four weeks join
 * the neighbour they sit closest to in temperature. A place whose soil
 * swings less than 4 C through the year is one frame, steady all year.
 *
 * Returns [{ kind: 'cold'|'warming'|'warm'|'cooling'|'steady', start, end
 * (day indices, may wrap New Year), days: [...], from, to, mean (C), rate
 * (C a week, + warming) }], in the order of the year starting from the frame
 * that holds 1 January.
 */
export function soilFrames(series, { halfSpan = 10, minDays = 28, steadyShare = 1 / 3 } = {}) {
  if (!series || series.length !== 365 || !series.every(Number.isFinite)) return [];
  const at = (k) => series[((k % 365) + 365) % 365];
  const lo = Math.min(...series), hi = Math.max(...series), mid = (lo + hi) / 2;
  const allDays = Array.from({ length: 365 }, (_, k) => k);
  const describe = (kind, days) => {
    const first = days[0], last = days[days.length - 1];
    return { kind, start: first, end: last, days, from: at(first), to: at(last), mean: meanOver(series, days), rate: days.length > 1 ? ((at(last) - at(first)) / (days.length - 1)) * 7 : 0 };
  };
  if (hi - lo < 4) return [describe('steady', allDays)];
  const slope = allDays.map((k) => (at(k + halfSpan) - at(k - halfSpan)) / (2 * halfSpan));
  const steep = Math.max(...slope.map(Math.abs));
  const kindOf = (k) => (slope[k] > steadyShare * steep ? 'warming' : slope[k] < -steadyShare * steep ? 'cooling' : series[k] >= mid ? 'warm' : 'cold');
  /* Runs round the year, starting at a change of kind so none is cut at New Year. */
  const kinds = allDays.map(kindOf);
  let s0 = kinds.findIndex((v, k) => v !== kinds[(k + 364) % 365]);
  if (s0 < 0) return [describe(kinds[0], allDays)];
  let runs = [];
  for (let i = 0; i < 365; i++) {
    const k = (s0 + i) % 365;
    if (!runs.length || runs[runs.length - 1].kind !== kinds[k]) runs.push({ kind: kinds[k], days: [] });
    runs[runs.length - 1].days.push(k);
  }
  /* Short runs join a neighbour: the one whose mean temperature is nearer. */
  for (;;) {
    if (runs.length <= 1) break;
    let i = -1;
    for (let j = 0; j < runs.length; j++) if (runs[j].days.length < minDays && (i < 0 || runs[j].days.length < runs[i].days.length)) i = j;
    if (i < 0) break;
    const n = runs.length, a = runs[(i + n - 1) % n], b = runs[(i + 1) % n];
    const m = meanOver(series, runs[i].days);
    const into = Math.abs(meanOver(series, a.days) - m) <= Math.abs(meanOver(series, b.days) - m) ? a : b;
    if (into === a) a.days.push(...runs[i].days); else b.days.unshift(...runs[i].days);
    runs.splice(i, 1);
    /* Neighbours of one kind become one run. */
    for (let j = 0; j < runs.length && runs.length > 1; j++) {
      const nx = (j + 1) % runs.length;
      if (nx !== j && runs[j].kind === runs[nx].kind) { runs[j].days.push(...runs[nx].days); runs.splice(nx, 1); if (nx < j) j--; j--; }
    }
  }
  const out = runs.map((r) => describe(r.kind, r.days));
  /* In calendar order from the frame holding 1 January. */
  const j0 = Math.max(0, out.findIndex((f) => f.days.includes(0)));
  return [...out.slice(j0), ...out.slice(0, j0)];
}

export const FRAME_NAME = { cold: 'Cold, steady', warming: 'Warming', warm: 'Warm, steady', cooling: 'Cooling', steady: 'Steady all year' };

/**
 * THE TRAILING AVERAGE: the mean of the last `n` days with a value in a
 * { 'YYYYMMDD': C } map, up to and including `through` (a 'YYYYMMDD', or the
 * latest day there is). Returns { mean, days: ['YYYYMMDD'...], through } or
 * null with fewer than n days in the last n + 3.
 */
export function trailingAverage(daily, { n = TRAIL_DAYS, through = null } = {}) {
  const keys = Object.keys(daily || {}).filter((d) => Number.isFinite(daily[d]) && (!through || d <= through)).sort();
  if (keys.length < n) return null;
  const last = keys[keys.length - 1];
  const t = Date.UTC(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8));
  const recent = keys.slice(-n);
  const first = recent[0];
  const span = Math.round((t - Date.UTC(+first.slice(0, 4), +first.slice(4, 6) - 1, +first.slice(6, 8))) / 86400000) + 1;
  if (span > n + 3) return null;
  return { mean: recent.reduce((s, d) => s + daily[d], 0) / n, days: recent, through: last };
}

/** 'YYYYMMDD' -> the 0..364 day index (29 Feb onto 28 Feb, as climate.js dayIndex). */
export function dayOfYmd(ymd) {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6) - 1, d = +ymd.slice(6, 8);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const doy = Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000);
  return leap && doy >= 59 ? Math.max(58, doy - 1) : doy;
}

/** Colour bands for temperatures lo..hi in whole steps (F): { step, n, edges, of }. */
export function tempBands(lo, hi, { most = 7 } = {}) {
  const span = Math.max(1, hi - lo);
  const step = [1, 2, 3, 5, 10].find((s) => span / s <= most) || 10;
  const a = Math.floor(lo / step) * step, b = Math.max(a + step, Math.ceil(hi / step) * step);
  const n = Math.round((b - a) / step);
  const edges = Array.from({ length: n + 1 }, (_, i) => a + i * step);
  const of = (v) => Math.min(n - 1, Math.max(0, Math.floor((v - a) / step)));
  return { step, n, edges, of, lo: a, hi: b };
}
