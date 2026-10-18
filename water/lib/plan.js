/**
 * HOW MUCH AND HOW OFTEN, ZONE BY ZONE (water session, 2026-10-18).
 *
 * Owner, 2026-10-18 (water/VISION.md): "the purpose of the tool is for
 * users to see how much AND how often a user needs to water certain areas
 * of their lawn in order to avoid over watering and under watering."
 *
 *   1. what each cell is (roof, lawn, paving, other ground) and its soil
 *      (the survey's map units on the grid; the owner's optional 4 inch
 *      loamy topsoil on the LAWN cells only);
 *   2. where the roofs' water lands (lib/gutters.js);
 *   3. ten typical years, every lawn cell watered the day it needs it: what
 *      each square metre would ask for -> the zones (lib/zones.js);
 *   4. ten typical years again, each ZONE watered as one: the plan, month by
 *      month -- how many waterings, how much each -- and the cells the plan
 *      still leaves too wet or too dry;
 *   5. ten typical years with no watering: what rain alone does;
 *   6. this week: the last weeks' weather and the forecast, zone by zone:
 *      when to water next and how much.
 */

import { rootZone } from './soil.js';
import { maskOf } from './geo.js';
import { roofRouting } from './gutters.js';
import { buildModel, simulate, idealIrrigation, zoneIrrigation, PARAMS } from './balance.js';
import { drawZones } from './zones.js';

export const KIND = { other: 0, lawn: 1, roof: 2, paved: 3 };
const DAYS_IN = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const q = (v, f) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null; };

/** A stand-in profile when the survey has nothing (a loam), marked so the page says so. */
const DEFAULT_SOIL = { name: 'no survey soil here (a loam assumed)', drainage: 'Well drained', hydgrp: 'B', wetByMonth: new Array(12).fill(null), profile: { horizons: [{ topCm: 0, bottomCm: 150, awc: 0.15, ksatUmS: 3.7, sand: 40, clay: 20 }] }, polygons: [], assumed: true };

/**
 * res: analyse() result; opts:
 *   lawnMask (Uint8Array), paved (Float32Array 0-1 or null), soil ({ units } from soilFor),
 *   topsoil (bool), downspouts, gutters, typical (days), week ({ days, today }), light (Float32Array | null),
 *   zoneOf (Int16Array, the user's own zones, optional), params
 */
export function waterPlan(res, { lawnMask, paved = null, soil = { units: [] }, topsoil = false, downspouts = [], gutters = [], typical, week = null, light = null, zoneOf: userZones = null, params = PARAMS } = {}) {
  const g = res.grid, N = g.W * g.H;
  // 1. what each cell is
  const kinds = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (res.wall[i]) kinds[i] = KIND.roof;
    else if (lawnMask?.[i]) kinds[i] = KIND.lawn;
    else if (paved && paved[i] >= 0.5) kinds[i] = KIND.paved;
    else kinds[i] = KIND.other;
  }
  const units = soil.units.length ? soil.units : [DEFAULT_SOIL];
  const soils = [];
  for (const u of units) {
    soils.push({ unit: u, rz: rootZone(u.profile), drainage: u.drainage, hydgrp: u.hydgrp, wetByMonth: u.wetByMonth });
    soils.push({ unit: u, rz: rootZone(u.profile, { topsoil: true }), drainage: u.drainage, hydgrp: u.hydgrp, wetByMonth: u.wetByMonth, topsoil: true });
  }
  const soilAt = new Int16Array(N).fill(0);
  units.forEach((u, k) => {
    if (!u.polygons?.length) return;
    const m = maskOf(g, u.polygons.map((coordinates) => ({ type: 'Polygon', coordinates })));
    for (let i = 0; i < N; i++) if (m[i]) soilAt[i] = 2 * k;
  });
  if (topsoil) for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) soilAt[i] += 1;

  // 2. roofs
  const roofs = roofRouting(g, res.wall, res.runoff.filled, { downspouts, gutters });
  const model = buildModel(res, { kinds, soilAt, soils, roofTo: roofs.roofTo, light, params });

  const years = Math.max(1, Math.round(typical.length / 365.25));
  // 3. the ideal, cell by cell
  const perMonth = Array.from({ length: 12 }, () => new Float32Array(N));
  const ideal = idealIrrigation(model);
  simulate(model, typical, { irrigate: (d, st) => { const out = ideal(d, st); if (out) { const m = st.month; for (let i = 0; i < N; i++) if (out[i]) perMonth[m][i] += out[i]; } return out; } });
  const zones = userZones ? { zoneOf: userZones, n: Math.max(0, ...userZones) + 1, peakMonth: null, user: true } : drawZones(model, perMonth, years);

  // 4. the zones watered as zones
  const events = [];
  const planned = simulate(model, typical, { irrigate: zoneIrrigation(model, zones.zoneOf, zones.n, events) });
  // 5. rain alone
  const rainOnly = simulate(model, typical);

  const yearOf = (d) => Number(typical[d].date.slice(0, 4));
  const y0 = yearOf(0);
  const monthOf = (d) => Number(typical[d].date.slice(5, 7)) - 1;
  const out = [];
  for (let z = 0; z < zones.n; z++) {
    const cells = [];
    for (let i = 0; i < N; i++) if (zones.zoneOf[i] === z && kinds[i] === KIND.lawn) cells.push(i);
    if (!cells.length) continue;
    const mine = events.filter((e) => e.zone === z);
    const months = [];
    for (let m = 0; m < 12; m++) {
      const perYear = Array.from({ length: years }, () => ({ n: 0, mm: 0 }));
      for (const e of mine) if (monthOf(e.d) === m) { const y = yearOf(e.d) - y0; if (perYear[y]) { perYear[y].n++; perYear[y].mm += e.mm; } }
      const counts = perYear.map((p) => p.n), mms = mine.filter((e) => monthOf(e.d) === m).map((e) => e.mm);
      months.push({ month: m, waterings: med(counts), low: q(counts, 0.1), high: q(counts, 0.9), mmEach: med(mms), mmMonth: med(perYear.map((p) => p.mm)) });
    }
    const share = (arr, days) => med(cells.map((i) => arr[i] / Math.max(1, days)));
    const rz = cells.map((i) => soils[soilAt[i]].rz?.tawMm ?? null);
    const unitNames = [...new Set(cells.map((i) => soils[soilAt[i]].unit.name))];
    const drainage = [...new Set(cells.map((i) => soils[soilAt[i]].drainage))];
    const runOn = cells.filter((i) => roofOrPaveFeeds(model, i)).length / cells.length;
    const peak = months.reduce((a, b) => ((b.mmMonth || 0) > (a.mmMonth || 0) ? b : a), months[0]);
    out.push({
      zone: z, m2: cells.length * g.cell * g.cell,
      depthMm: med(cells.map((i) => model.raw[i])),
      tawMm: med(rz),
      peakMonth: peak.month, peakEveryDays: peak.waterings ? DAYS_IN[peak.month] / peak.waterings : null,
      months,
      slope: med(cells.map((i) => model.slope[i])),
      soils: unitNames, drainage, runOnShare: runOn,
      /* too wet: the plan's watering adds wet days (5% of the season or more) over what rain alone
         gives -- over-watered; wet anyway: rain alone keeps it wet a tenth of the season -- a drainage
         matter, not a watering one */
      tooWet: cells.filter((i) => (planned.wetDays[i] - rainOnly.wetDays[i]) / Math.max(1, planned.seasonDays) >= 0.05).length * g.cell * g.cell,
      wetAnyway: cells.filter((i) => rainOnly.wetDays[i] / Math.max(1, rainOnly.seasonDays) >= 0.1).length * g.cell * g.cell,
      tooDry: cells.filter((i) => planned.dryDays[i] / Math.max(1, planned.seasonDays) > 0.1).length * g.cell * g.cell,
      wetShare: share(planned.wetDays, planned.seasonDays), dryShare: share(planned.dryDays, planned.seasonDays),
      rainAloneDryShare: share(rainOnly.dryDays, rainOnly.seasonDays), rainAloneWetShare: share(rainOnly.wetDays, rainOnly.seasonDays),
    });
  }

  // 6. this week
  let thisWeek = null;
  if (week?.days?.length) {
    const wev = [];
    simulate(model, week.days, { irrigate: zoneIrrigation(model, zones.zoneOf, zones.n, wev) });
    const ti = Math.max(0, week.days.findIndex((d) => d.date >= week.today));
    thisWeek = {
      today: week.today,
      zones: out.map((o) => {
        const next = wev.find((e) => e.zone === o.zone && e.d >= ti);
        const last = [...wev].reverse().find((e) => e.zone === o.zone && e.d < ti);
        return { zone: o.zone, next: next ? { date: week.days[next.d].date, mm: next.mm } : null, last: last ? { date: week.days[last.d].date } : null };
      }),
      rainComing: week.days.slice(ti).reduce((s, d) => s + (d.rain || 0), 0),
      through: week.days[week.days.length - 1].date,
    };
  }

  // per-cell overlays for the page
  const wetShare = new Float32Array(N), dryShare = new Float32Array(N), wetFromWatering = new Float32Array(N);
  for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) {
    wetShare[i] = planned.wetDays[i] / Math.max(1, planned.seasonDays); dryShare[i] = planned.dryDays[i] / Math.max(1, planned.seasonDays);
    wetFromWatering[i] = (planned.wetDays[i] - rainOnly.wetDays[i]) / Math.max(1, planned.seasonDays);
  }
  return {
    zones: out, zoneOf: zones.zoneOf, userZones: !!zones.user, kinds, wetShare, dryShare, wetFromWatering,
    roofs: { pieces: roofs.pieces.length, guessed: roofs.pieces.filter((p) => p.guessed).length, unusedDownspouts: roofs.unused },
    soil: units.map((u) => ({ name: u.name, share: u.share ?? null, drainage: u.drainage, hydgrp: u.hydgrp, wtMinCm: u.wtMinCm ?? null, wetByMonth: u.wetByMonth, assumed: !!u.assumed, tawMm: rootZone(u.profile)?.tawMm ?? null, tawTopsoilMm: rootZone(u.profile, { topsoil: true })?.tawMm ?? null })),
    years, topsoil, thisWeek,
    weather: monthly(typical, years, params),
  };
}

/** Whether a cell gets water from a roof or paving (any roof cell lands on it, or paving drains into it). */
function roofOrPaveFeeds(model, i) {
  model._fed ||= (() => {
    const fed = new Uint8Array(model.N);
    for (let j = 0; j < model.N; j++) if (model.kinds[j] === 2 && model.roofTo[j] >= 0) fed[model.roofTo[j]] = 1;
    for (const j of model.order) if (model.down[j] >= 0 && (fed[j] || model.kinds[j] === 3)) fed[model.down[j]] = 1;
    return fed;
  })();
  return model._fed[i] === 1;
}

/** Rain and grass water use by month, typical-year medians (mm). */
export function monthly(days, years, params = PARAMS) {
  const rain = Array.from({ length: 12 }, () => new Array(years).fill(0)), et = Array.from({ length: 12 }, () => new Array(years).fill(0));
  const y0 = Number(days[0].date.slice(0, 4));
  for (const d of days) {
    const m = Number(d.date.slice(5, 7)) - 1, y = Number(d.date.slice(0, 4)) - y0;
    if (y < 0 || y >= years) continue;
    rain[m][y] += d.rain || 0; et[m][y] += (d.et0 || 0) * params.kc;
  }
  return rain.map((r, m) => ({ month: m, rainMm: med(r), grassUseMm: med(et[m]) }));
}
