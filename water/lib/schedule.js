/**
 * WHEN TO WATER EACH ZONE, SEASON BY SEASON (owner, 2026-10-23: "build a final step that gives exact watering
 * recs by season and zone").
 *
 * The watering plan (lib/plan.js), run with the person's own valves as its zones, says for each valve zone how
 * often a typical year waters it month by month and how much each time -- in water reaching the grass, times the
 * plan's own scheduling multiplier for a typical system (lib/balance.js PARAMS.duLq). With the heads mapped, the
 * zone's own rate and evenness are known (lib/precip.js over the lawn it waters), so here:
 *
 *   put down     the grass's water each time (the plan's depth over its multiplier), times the Irrigation
 *                Association's scheduling multiplier 1 / (0.4 + 0.6 DUlq) on THIS zone's lower-quarter
 *                uniformity (held between 0.4 and 0.9: below 0.4 it is the heads to fix, not the time)
 *   minutes      put down / the zone's average rate over its lawn
 *   runs         one, unless the zone puts water down faster than its slowest tenth of ground takes it in;
 *                then cycle and soak, at most two runs a day (owner, 2026-10-20), an hour apart
 *   how often    the plan's waterings in a typical month, as days a week (or every so many days)
 *
 * Pure.
 */

export const DAYS_IN = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Meteorological seasons (northern hemisphere: the lots are in the US). */
export const SEASONS = [['Spring', [2, 3, 4]], ['Summer', [5, 6, 7]], ['Fall', [8, 9, 10]], ['Winter', [11, 0, 1]]];
export const MAX_RUNS = 2;
export const DU_LO = 0.4, DU_HI = 0.9;

export const schedulingMultiplierFor = (du) => 1 / (0.4 + 0.6 * Math.max(DU_LO, Math.min(DU_HI, du)));

/** How often, in words a controller is set by: "3 days a week", "every 10 days". */
export function oftenWords(perWeek) {
  if (!(perWeek > 0)) return null;
  if (perWeek >= 0.9) { const d = Math.min(7, Math.max(1, Math.round(perWeek))); return d === 7 ? 'every day' : `${d} day${d > 1 ? 's' : ''} a week`; }
  const days = Math.round(7 / perWeek);
  return days >= 24 ? 'about once a month' : `every ${days} days`;
}

/** One watering of `depthIn` inches on a zone putting down `rateInH`, on ground taking `takesInH`. */
export function runsFor(depthIn, rateInH, takesInH) {
  const total = (depthIn / rateInH) * 60;
  const runs = !(takesInH > 0) || rateInH <= takesInH ? 1 : Math.min(MAX_RUNS, Math.max(1, Math.ceil(depthIn / takesInH - 0.05)));
  return { runs, minutes: Math.max(1, Math.round(total / runs)), total: Math.max(1, Math.round(total)) };
}

/**
 * pz: a plan zone (lib/plan.js: months [{ month, waterings, low, high, mmEach }], takesInPerH, dryWeek), its
 * multiplier planSM; zone: { rateInH, du }. -> { put, sm, months: [{ month, perWeek, often, depthIn, runs,
 * minutes, total, dryOnly }], seasons: [{ name, months, often, runs, minutes, total, depthIn, range }], dry: {...},
 * skipAfterIn }
 */
export function zoneSchedule(pz, { rateInH, du }, planSM) {
  if (!(rateInH > 0) || !pz) return null;
  const sm = schedulingMultiplierFor(du), takes = pz.takesInPerH;
  const toPut = (mmPlan) => ((mmPlan / planSM) * sm) / 25.4; // the plan's depth -> this zone's, inches
  const months = pz.months.map((m) => {
    const perWeek = m.waterings ? m.waterings / (DAYS_IN[m.month] / 7) : 0;
    if (!perWeek && !m.high) return { month: m.month, perWeek: 0, often: null, off: true };
    const depthIn = m.mmEach ? toPut(m.mmEach) : pz.depthMm ? toPut(pz.depthMm) : null;
    if (!depthIn) return { month: m.month, perWeek: 0, often: null, off: true };
    return { month: m.month, perWeek, often: perWeek ? oftenWords(perWeek) : null, dryOnly: !perWeek, depthIn, ...runsFor(depthIn, rateInH, takes) };
  });
  const seasons = [];
  for (const [name, ms] of SEASONS) {
    const on = months.filter((m) => ms.includes(m.month) && !m.off);
    if (!on.length) continue;
    const wet = on.filter((m) => m.perWeek > 0);
    // the season's watering: its depth is the soil's (much the same month to month); how often, by month
    const depthIn = (wet.length ? wet : on).reduce((s, m) => s + m.depthIn, 0) / (wet.length ? wet : on).length;
    const r = runsFor(depthIn, rateInH, takes);
    // month by month; a month a typical year does not water says so (it may in a dry spell)
    const often = on.map((m) => ({ month: m.month, often: m.perWeek > 0 ? m.often : 'only in a dry spell', perWeek: m.perWeek }));
    const words = [...new Set(often.map((o) => o.often))];
    seasons.push({ name, months: on.map((m) => m.month), often, sameAll: words.length === 1, dryOnly: !wet.length, depthIn, ...r });
  }
  // a week with no rain in the zone's thirstiest month (the plan's figure), in this zone's minutes
  let dry = null;
  if (pz.dryWeek?.mm > 0) {
    const weekIn = toPut(pz.dryWeek.mm), n = Math.max(1, pz.dryWeek.waterings), each = weekIn / n;
    dry = { month: pz.dryWeek.month, waterings: n, weekIn, ...runsFor(each, rateInH, takes) };
  }
  // rain that stands in for a watering: what reaches the grass each time
  const plain = months.filter((m) => m.depthIn).map((m) => m.depthIn / sm);
  return { sm, du, rateInH, takesInH: takes, months, seasons, dry, skipAfterIn: plain.length ? plain.reduce((s, v) => s + v, 0) / plain.length : null };
}

/**
 * Each valve zone's lawn, from its heads' water on the analysis grid: a lawn cell is the zone's that puts the
 * most on it. byZone: Map zone -> Float32Array in/h; lawn(i). -> { zoneOf: Int16Array (zone - 1, or -1),
 * zones: Map zone -> { cells, rateInH (mean over its cells), du (lower quarter, its own water) } }
 */
export function valveZones(byZone, N, lawn) {
  const zoneOf = new Int16Array(N).fill(-1), best = new Float32Array(N);
  for (const [z, a] of byZone) for (let i = 0; i < N; i++) if (lawn(i) && a[i] > best[i]) { best[i] = a[i]; zoneOf[i] = z - 1; }
  const zones = new Map();
  for (const [z, a] of byZone) {
    const v = [];
    for (let i = 0; i < N; i++) if (zoneOf[i] === z - 1) v.push(a[i]);
    if (!v.length) continue;
    v.sort((x, y) => x - y);
    const mean = v.reduce((s, x) => s + x, 0) / v.length, q = v.slice(0, Math.max(1, Math.floor(v.length / 4)));
    zones.set(z, { cells: v.length, rateInH: mean, du: mean > 0 ? q.reduce((s, x) => s + x, 0) / q.length / mean : 0 });
  }
  return { zoneOf, zones };
}
