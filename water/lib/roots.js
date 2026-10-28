/**
 * THE ROOTS: HOW DEEP, BY SPECIES, AND HOW THEY RISE AND FALL WITH THE SOIL'S WARMTH (water session, 2026-10-28;
 * FINDINGS H53, S15; the owner's brief, research-roots-brief.md).
 *
 * WORKING DEPTH. The plan's root zone is the depth watering should wet, not where the deepest root ends: the
 * "most generous reasonable working depth" per species (owner). Measured where it could be: Kentucky bluegrass
 * holds 95% of its root mass in the top 12.7 cm at fairway height and its effective irrigation root zone is about
 * 15 cm (Sprague 1932; Sheffer, Dunn & Minner 1987); tall fescue keeps useful root length to 76 cm, two thirds of it
 * in the top 30 (Wu 1985), and the Irrigation Association's test lawns take 10 in; bermudagrass has its active zone
 * at 20-60 cm (Carrow 1996), the IA's 8.1 in. Species with no depth data of their own take the general figure for
 * their group (owner: "generalized for cool season, and separately for warm season, since species data lacks").
 * Several species checked: the average of their depths (owner).
 *
 * THE SEASON. Roots are deeper in spring and fall than in midsummer (Upham et al. 2008): cool-season roots peak in
 * late spring and lose 25-50% by late summer at lawn height (the brief's estimate; bentgrass greens, measured, lose
 * 60-80%), warm-season roots peak in summer and can collapse for three weeks at spring green-up. The best-supported
 * driver is the 10-15 cm soil temperature (Beard & Daniel 1966: a 5-day running mean explained 89% of bentgrass root
 * variation; Schlossberg et al. 2002: viable root length fell 1% per 77 degree-days over 10 C, R2 0.84). The plan's
 * soil temperature is IEMRE's "4-inch" soil (ERA5-Land's modelled 0-7 cm layer, daily high and low: the layer most
 * of a lawn's roots are in), the typical year's from the shade map's climate route. The brief's
 * two-part model: a production curve P(T) (Yin's beta function between a base, an optimum and a maximum
 * temperature) and a daily standing-root index R with heat-driven loss,
 *     R(t) = R(t-1) + g P(T) - m(T) R(t-1),   m(T) = m0 + k max(0, T - Tcrit),
 * T the 5-day running mean of the soil temperature; the loss term goes by the day's HIGH (standingIndex). Creeping bentgrass is fitted (chamber and green data);
 * bluegrass and bermudagrass are threshold-constrained estimates; the plan's cool-season and warm-season groups take
 * those two. The root ZONE follows the index, never below 0.4 of the working depth (S15: a mapping of mass to
 * depth is this session's estimate -- the top 7.5 cm holds most of the mass whatever the season).
 */

export const SPECIES = {
  kbg: { name: 'Kentucky bluegrass', group: 'cool', workingIn: 8, basis: '95% of the root mass in the top 5 in, active roots to 12-18 in by the third year (Sprague 1932; Sheffer et al. 1987); the effective irrigation zone about 6 in, taken generously' },
  rye: { name: 'Perennial ryegrass', group: 'cool', workingIn: 8, model: 'rye', basis: 'the deepest roots of five cool-season grasses in April, 13 in in a rhizotron (Koski 1983, Ohio State), more mass below 14 in than bluegrass (Sheffer et al. 1987) -- but short-lived roots (a mean life of 46 days in pasture, Gibbs & Reid 1992), so 8 in in spring and the season\'s model takes them down by summer' },
  tf: { name: 'Tall fescue', group: 'cool', workingIn: 12, basis: 'two thirds of the root length in the top 12 in, useful roots to 30 in (Wu 1985); 10 in in the Irrigation Association\'s test lawns' },
  fine: { name: 'Fine fescues (creeping red, Chewings, hard, sheep)', group: 'cool', workingIn: 8, general: true, basis: 'hard fescue rooted deepest of any species in Sprague\'s trial; the others have no depth data (Beard ranks them "fair" in midsummer, with ryegrass): the cool-season figure' },
  bent: { name: 'Bentgrass', group: 'cool', workingIn: 6, model: 'bent', basis: '93% of the root mass in the top 3 in at a quarter-inch cut, more at lawn height (Sprague 1932); a green\'s 4 in in spring and 2 in in midsummer (Throssell 1996), a lawn cut higher' },
  coolMix: { name: 'A cool-season lawn, not sure which grasses', group: 'cool', workingIn: 8, general: true, basis: 'the cool-season figure: extension\'s 6-8 in (K-State MF2803, UC IPM) at its top, the owner\'s 8 in' },
  bermuda: { name: 'Bermudagrass', group: 'warm', workingIn: 12, basis: 'the densest roots at 8-24 in of seven grasses (Carrow 1996), the deepest midsummer roots of any turf (Beard 2001); 8-9 in in the Irrigation Association\'s test lawns, taken generously' },
  zoysia: { name: 'Zoysiagrass', group: 'warm', workingIn: 8, basis: 'shallower than bermuda, its roots concentrated in the top 2 in (Wherley et al. 2011; Qian et al. 1997); 18-31 in unrestricted (Texas A&M), a maximum not a working depth' },
  staug: { name: 'St. Augustinegrass', group: 'warm', workingIn: 8, basis: '75-87% of its roots in the top 6 in (Florida); 8 in in Dukes\'s (2007) scheduling model' },
  centipede: { name: 'Centipedegrass', group: 'warm', workingIn: 10, general: true, basis: 'no depth data (Beard ranks its midsummer roots "moderate"): the warm-season figure' },
  bahia: { name: 'Bahiagrass', group: 'warm', workingIn: 12, basis: '76% of its roots in the top 12 in (Florida forage studies); rooting deepens with less frequent watering (UF/IFAS)' },
  buffalo: { name: 'Buffalograss', group: 'warm', workingIn: 12, basis: '62% of its roots in the top 12 in, drawing water to 36 (Utah State); deeper-rooted than bluegrass (UNL)' },
  warmMix: { name: 'A warm-season lawn, not sure which grasses', group: 'warm', workingIn: 10, general: true, basis: 'the warm-season figure: the Irrigation Association\'s 8-9 in test lawns and UC IPM\'s "some warm-season deeper", taken generously' },
};
export const GENERAL = { cool: 'coolMix', warm: 'warmMix' };

/** The brief's model parameters: production (Tb, To, Tm, C) and the daily balance (g, m0, k per day, Tcrit C). */
export const ROOT_MODELS = {
  cool: { Tb: 1, To: 18, Tm: 35, g: 0.005, m0: 0.005, k: 0.002, Tcrit: 25, highOffset: 3.3, basis: 'Kentucky bluegrass: cell division just above 0 C, peak root weight at 21 C in a chamber, growth ceasing about 32 C (Bogart 1972); loss above 25 C (Beard); perennial roots: a 200-day life (the brief\'s estimate)' },
  bent: { Tb: 5, To: 16, Tm: 35, g: 0.010, m0: 0.010, k: 0.004, Tcrit: 23, highOffset: 3.3, basis: 'creeping bentgrass, fitted: peak root weight at 16 C, loss once the 5 cm soil passes 23 C (Pote et al. 2006; Fagerness & Yelverton 2001), a 100-day root life' },
  rye: { Tb: 2, To: 16, Tm: 35, g: 0.015, m0: 0.015, k: 0.004, Tcrit: 24, highOffset: 3.3, basis: 'perennial ryegrass (research-roots-ryegrass.md): roots in every month (Garwood 1967), the optimum at the cool end of bluegrass\'s (less heat-tolerant: Wehner & Watschke 1981), a mean root life of 46 days (Gibbs & Reid 1992; eight turnovers a year, Reid & Crush 2013), loss from 24 C -- estimates on measured lives' },
  warm: { Tb: 10, To: 27, Tm: 43, g: 0.004, m0: 0.004, k: 0.004, Tcrit: 38, winter: 0.05, highOffset: 3.3, basis: 'bermudagrass: optimum 24-29 C, heat stress above 38 C, ceasing about 43 C (DiPaola & Beard 1980, 1992; Beard 2001); slow growth in unfrozen soil of 5-10 C' },
};
export const DEPTH_FLOOR = 0.4;
export const HIGH_OFFSET = 3.3; // the 10 cm daily high over the daily mean, C, where only means are known (IEMRE at the owner's lot: median 3.3)
export const RUN_DAYS = 5;

/** Yin's beta function: production 0-1 at soil temperature T. */
export function production(T, { Tb, To, Tm, winter = 0 }) {
  if (!(T > Tb && T < Tm)) return winter && T > 5 && T <= 10 ? winter : 0;
  const q = (Tm - To) / (To - Tb);
  return Math.max(0, ((T - Tb) / (To - Tb)) * ((Tm - T) / (Tm - To)) ** q);
}

/** The 5-day running mean of a daily series (the first days take what there is). */
export function runningMean(T, n = RUN_DAYS) {
  const out = new Float32Array(T.length);
  let s = 0, c = 0;
  for (let i = 0; i < T.length; i++) {
    const v = T[i];
    if (Number.isFinite(v)) { s += v; c++; }
    const j = i - n;
    if (j >= 0 && Number.isFinite(T[j])) { s -= T[j]; c--; }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

/**
 * The standing-root index day by day over a soil-temperature series T (C, daily, 10 cm). The first year is run
 * twice so the start settles (a typical year loops; an actual series warms up on its own first year). events: day
 * indices of a warm-season green-up after a cold winter -- the index drops to 0.2 and production stops for 21 days.
 * -> Float32Array R (0-1)
 */
export function standingIndex(T, params, { events = [], start = 0.5, high = null } = {}) {
  const n = T.length, R = new Float32Array(n);
  const Tm5 = runningMean(T), Th5 = high ? runningMean(high) : null;
  const warm = Math.min(n, 365);
  let r = start;
  const step = (i, hold) => {
    const t = Number.isFinite(Tm5[i]) ? Tm5[i] : params.To;
    /* THE LOSS BY THE DAY'S HIGH (this session's choice, S15): most of a lawn's roots sit in the top 7.5 cm, which
       runs hotter by day than the 10 cm the model is written for; the 10 cm daily high (IEMRE's, a median 3.3 C
       over the day's mean, 5.7 in summer on the owner's lot) stands in for it. With the mean alone a Great Lakes
       summer never reaches the loss zone and the late-summer low the brief describes does not appear. */
    const h = Th5 && Number.isFinite(Th5[i]) ? Th5[i] : t + params.highOffset;
    const P = hold ? 0 : production(t, params);
    /* The baseline turnover eases with cold soil as production does (this session's adjustment, S15): at the
       brief's constant m0 a Michigan winter near 0 C halves the index by March and the year peaks in October,
       against its own seasonal table (roots alive at 70-90% through winter, the peak in late spring). */
    const cold = Math.max(0, Math.min(1, (t - params.Tb) / (params.To - params.Tb)));
    const m = params.m0 * cold + params.k * Math.max(0, h - params.Tcrit);
    r = Math.max(0, Math.min(1, r + params.g * P - m * r));
    return r;
  };
  for (let i = 0; i < warm; i++) step(i, false); // the warm-up pass
  const ev = new Set(events);
  let hold = 0;
  for (let i = 0; i < n; i++) {
    if (ev.has(i)) { r *= 0.2; hold = 21; }
    R[i] = step(i, hold > 0);
    if (hold > 0) hold--;
  }
  return R;
}

/** The species checked, cleaned: known ids, or the group's general entry when none. */
export function speciesOf(ids, group = 'cool') {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => SPECIES[id]);
  return list.length ? [...new Set(list)] : [GENERAL[group] || 'coolMix'];
}

/** The group a set of species makes: the one with more species (a tie, or none, cool). */
export function groupOf(ids, fallback = 'cool') {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => SPECIES[id]);
  if (!list.length) return fallback === 'warm' ? 'warm' : 'cool';
  const warm = list.filter((id) => SPECIES[id].group === 'warm').length;
  return warm > list.length - warm ? 'warm' : 'cool';
}

/** The working depth, cm: the average of the species' (owner: "pick the average root depths"). */
export function workingCm(ids, group = 'cool') {
  const list = speciesOf(ids, group);
  return (list.reduce((s, id) => s + SPECIES[id].workingIn, 0) / list.length) * 2.54;
}

/**
 * The root zone day by day over a soil-temperature series, as a share of the working depth (DEPTH_FLOOR..1), the
 * species' own models averaged by their depths. events: as standingIndex.
 * -> { ratio: Float32Array, workingCm, perSpecies: { id: Float32Array R } }
 */
export function rootSeries(T, ids, group = 'cool', { events = [], high = null } = {}) {
  const list = speciesOf(ids, group);
  const wk = workingCm(ids, group);
  const perSpecies = {};
  const depth = new Float32Array(T.length);
  for (const id of list) {
    const sp = SPECIES[id], params = ROOT_MODELS[sp.model || sp.group];
    const R = standingIndex(T, params, { events: sp.group === 'warm' ? events : [], high });
    perSpecies[id] = R;
    for (let i = 0; i < T.length; i++) depth[i] += (sp.workingIn * 2.54 * Math.max(DEPTH_FLOOR, R[i])) / list.length;
  }
  return { ratio: Float32Array.from(depth, (d) => Math.max(DEPTH_FLOOR, Math.min(1, d / wk))), workingCm: wk, perSpecies };
}

/** A typical year's root depth by month, inches: { byMonth[12], peakIn, peakMonth, lowIn, lowMonth }. */
export function typicalRoots(tSoil365, ids, group = 'cool', { greenUp = null } = {}) {
  if (!tSoil365 || tSoil365.length !== 365) return null;
  const T = Float32Array.from(tSoil365);
  const cold = Math.min(...runningMean(T)) < 5;
  const { ratio, workingCm: wk } = rootSeries(T, ids, group, { events: greenUp !== null && cold ? [greenUp] : [] });
  const MS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
  const byMonth = MS.slice(0, 12).map((a, m) => { let s = 0; for (let k = a; k < MS[m + 1]; k++) s += ratio[k]; return Math.round(((s / (MS[m + 1] - a)) * wk) / 2.54 * 10) / 10; });
  let peakMonth = 0, lowMonth = 0;
  byMonth.forEach((v, m) => { if (v > byMonth[peakMonth]) peakMonth = m; if (v < byMonth[lowMonth]) lowMonth = m; });
  return { byMonth, peakIn: byMonth[peakMonth], peakMonth, lowIn: byMonth[lowMonth], lowMonth, workingIn: Math.round((wk / 2.54) * 10) / 10 };
}

/** A typical year's roots by month from days that carry rootRatio (the actual years, averaged by month), inches. */
export function rootsByMonth(days, wkCm, dayIndex) {
  const MS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
  const sum = new Float64Array(12), n = new Uint32Array(12);
  for (const d of days) { if (!Number.isFinite(d.rootRatio)) continue; const k = dayIndex(d.date.replace(/-/g, '')); const m = MS.findIndex((a, i) => k >= a && k < MS[i + 1]); if (m >= 0) { sum[m] += d.rootRatio; n[m]++; } }
  if (!Array.from(n).every((v) => v > 0)) return null;
  const byMonth = Array.from(sum, (v, m) => Math.round(((v / n[m]) * wkCm) / 2.54 * 10) / 10);
  let peakMonth = 0, lowMonth = 0;
  byMonth.forEach((v, m) => { if (v > byMonth[peakMonth]) peakMonth = m; if (v < byMonth[lowMonth]) lowMonth = m; });
  return { byMonth, peakIn: byMonth[peakMonth], peakMonth, lowIn: byMonth[lowMonth], lowMonth, workingIn: Math.round((wkCm / 2.54) * 10) / 10 };
}

/**
 * Each day of `days` ([{ date }]) given its root-zone share (day.rootRatio) from the soil temperature: the day's own
 * (soilByDate: 'YYYY-MM-DD' -> C) where known, else the typical year's by day of year; the series run continuously,
 * warmed up on the typical year. greenUp: the warm-season season's first day of year (a green-up, each year), or null.
 * -> the number of days from their own soil temperature
 */
export function attachRootRatio(days, { soilByDate = null, typical = null, ids, group = 'cool', greenUp = null, dayIndex }) {
  if (!days.length || (!soilByDate && !typical)) return 0;
  const T = new Float32Array(days.length), H = new Float32Array(days.length);
  let own = 0;
  for (let d = 0; d < days.length; d++) {
    const v = soilByDate?.get ? soilByDate.get(days[d].date) : soilByDate?.[days[d].date];
    const mean = Array.isArray(v) ? v[0] : v, hi = Array.isArray(v) ? v[1] : NaN;
    if (Number.isFinite(mean)) { T[d] = mean; H[d] = Number.isFinite(hi) ? hi : mean + HIGH_OFFSET; own++; }
    else { T[d] = typical ? typical[dayIndex(days[d].date.replace(/-/g, ''))] : NaN; H[d] = T[d] + HIGH_OFFSET; }
  }
  // a cold winter before each green-up: the warm-season spring decline
  const events = [];
  if (greenUp !== null) {
    const m5 = runningMean(T);
    for (let d = 1; d < days.length; d++) {
      if (dayIndex(days[d].date.replace(/-/g, '')) !== greenUp) continue;
      let coldest = Infinity;
      for (let k = Math.max(0, d - 120); k < d; k++) if (m5[k] < coldest) coldest = m5[k];
      if (coldest < 5) events.push(d);
    }
  }
  const { ratio } = rootSeries(T, ids, group, { events, high: H });
  for (let d = 0; d < days.length; d++) days[d].rootRatio = ratio[d];
  return own;
}
