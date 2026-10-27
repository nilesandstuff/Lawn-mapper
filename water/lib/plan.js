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

import { rootZone, maxSprinklerRate, withTexture, layersOf } from './soil.js';
import { maskOf } from './geo.js';
import { roofRouting } from './gutters.js';
import { buildModel, simulate, idealIrrigation, zoneIrrigation, schedulingMultiplier, PARAMS, WARM } from './balance.js';
import { drawZones } from './zones.js';

export const KIND = { other: 0, lawn: 1, roof: 2, paved: 3, pavers: 4 };

/* WHAT THE OWNER MARKED (owner, 2026-10-19: a wooden deck and a hot tub read as blacktop; an evergreen row
   as roof). An area the person outlines and names wins over every finder. */
export const AREA_KINDS = {
  deck: { kind: 0, label: 'deck with gaps (rain falls through)', deck: true },
  pavers: { kind: 4, label: 'brick or paver patio' },
  solid: { kind: 3, label: 'solid surface (hot tub, slab, shed floor)' },
  roof: { kind: 2, label: 'roof' },
  lawn: { kind: 1, label: 'lawn' },
  bed: { kind: 0, label: 'garden bed or mulch' },
};
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
export function waterPlan(res, { lawnMask, paved = null, soil = { units: [] }, topsoil = false, downspouts = [], gutters = [], typical, week = null, light = null, lightMonths = null, radiation = null, shadeKinds = null, season = null, grass = 'cool', texture = null, parcelMask = null, areas = [], zoneOf: userZones = null, params: given = null } = {}) {
  // warm-season turf (owner 2026-10-18): FAO-56's p 0.5 in place of cool-season's 0.4
  const params = given || (grass === 'warm' ? { ...PARAMS, ...WARM } : PARAMS);
  const g = res.grid, N = g.W * g.H;
  // 1. what each cell is
  const kinds = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (res.wall[i]) kinds[i] = KIND.roof;
    else if (lawnMask?.[i]) kinds[i] = KIND.lawn;
    else if (paved && paved[i] >= 0.5) kinds[i] = KIND.paved;
    else kinds[i] = KIND.other;
  }
  // the person's own marks, last drawn on top
  const deckCells = new Uint8Array(N);
  for (const a of areas || []) {
    const t = AREA_KINDS[a?.kind];
    if (!t || !Array.isArray(a.ring) || a.ring.length < 3) continue;
    const ring = a.ring[0][0] === a.ring[a.ring.length - 1][0] && a.ring[0][1] === a.ring[a.ring.length - 1][1] ? a.ring : [...a.ring, a.ring[0]];
    const m = maskOf(g, { type: 'Polygon', coordinates: [ring] });
    for (let i = 0; i < N; i++) if (m[i]) { kinds[i] = t.kind; deckCells[i] = t.deck ? 1 : 0; }
  }
  const wallNow = Uint8Array.from(kinds, (k) => (k === KIND.roof ? 1 : 0));
  const units = (soil.units.length ? soil.units : [DEFAULT_SOIL]).map((u) => (texture ? withTexture(u, texture) : u));
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
  const roofs = roofRouting(g, wallNow, res.runoff.filled, { downspouts, gutters });
  const model = buildModel(res, { kinds, soilAt, soils, roofTo: roofs.roofTo, light, lightMonths: light ? lightMonths : null, radiation: light ? radiation : null, shadeKinds: light ? shadeKinds : null, params });
  for (let i = 0; i < N; i++) if (deckCells[i]) { model.etFactor[i] *= params.deckShelter; model.etBase[i] *= params.deckShelter; }
  // the most a day's watering can put down, cell by cell (PARAMS.cyclesPerDay runs of an hour's intake),
  // as water reaching the grass: what is put down, over the scheduling multiplier
  const SM = schedulingMultiplier(params);
  model.dayCapMm = new Float32Array(N).fill(Infinity);
  // what each cell of ground takes in an hour, mm (rain faster than this runs off, on days whose hours are known)
  model.intakeMmH = new Float32Array(N).fill(Infinity);
  for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn || kinds[i] === KIND.other) model.intakeMmH[i] = maxSprinklerRate(soils[soilAt[i]].rz, model.slope[i]).inPerH * 25.4;
  for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) model.dayCapMm[i] = (params.cyclesPerDay * maxSprinklerRate(soils[soilAt[i]].rz, model.slope[i]).inPerH * 25.4) / SM;

  const years = Math.max(1, new Set(typical.map((d) => d.date.slice(0, 4))).size); // distinct years (a test may give summers only)
  // 3. the ideal, cell by cell
  const perMonth = Array.from({ length: 12 }, () => new Float32Array(N));
  const ideal = idealIrrigation(model);
  simulate(model, typical, { season, irrigate: (d, st) => { const out = ideal(d, st); if (out) { const m = st.month; for (let i = 0; i < N; i++) if (out[i]) perMonth[m][i] += out[i]; } return out; } });
  const zones = userZones ? { zoneOf: userZones, n: Math.max(0, ...userZones) + 1, peakMonth: null, user: true } : drawZones(model, perMonth, years);

  // 4. the zones watered as zones
  const events = [];
  const planned = simulate(model, typical, { season, irrigate: zoneIrrigation(model, zones.zoneOf, zones.n, events) });
  // 5. rain alone
  const rainOnly = simulate(model, typical, { season });

  const yearOf = (d) => Number(typical[d].date.slice(0, 4));
  const y0 = yearOf(0);
  const monthOf = (d) => Number(typical[d].date.slice(5, 7)) - 1;
  const wx = monthly(typical, years, params);
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
      months.push({ month: m, waterings: med(counts), low: q(counts, 0.1), high: q(counts, 0.9), mmEach: med(mms) * SM, mmMonth: med(perYear.map((p) => p.mm)) * SM });
    }
    const share = (arr, days) => med(cells.map((i) => arr[i] / Math.max(1, days)));
    const rz = cells.map((i) => soils[soilAt[i]].rz?.tawMm ?? null);
    const unitNames = [...new Set(cells.map((i) => soils[soilAt[i]].unit.name))];
    const drainage = [...new Set(cells.map((i) => soils[soilAt[i]].drainage))];
    // run-on: the zone's cells that get a quarter or more again of their own rain, off roofs, paving or uphill
    const runOn = cells.filter((i) => planned.ranOn[i] >= 0.25 * planned.rain).length / cells.length;
    const runOnRatio = med(cells.map((i) => planned.ranOn[i] / Math.max(1, planned.rain)));
    const peak = months.reduce((a, b) => ((b.mmMonth || 0) > (a.mmMonth || 0) ? b : a), months[0]);
    /* cycle and soak: the zone's slowest-taking ground (the 10th percentile rate) against typical
       sprinklers -- spray heads about 1.5 in/h, rotors about 0.5 in/h (until the heads are mapped) */
    const rates = cells.map((i) => maxSprinklerRate(soils[soilAt[i]].rz, model.slope[i]).inPerH);
    const takes = q(rates, 0.1);
    const cyclesFor = (pr) => Math.max(1, Math.ceil(pr / takes));
    /* A WEEK WITH NO RAIN in the zone's thirstiest month: its grass's use (the month's typical ET, this
       zone's sun and heat) times the scheduling multiplier, in waterings of what a day's cycles allow. The
       figure to set a controller by; rain skips waterings (the typical month above counts it). */
    const each = (peak.mmEach || med(cells.map((i) => Math.min(model.raw[i], model.dayCapMm[i]))) * SM);
    const dryMm = (wx[peak.month].grassUseMm / DAYS_IN[peak.month]) * 7 * med(cells.map((i) => model.etFactor[i])) * SM;
    out.push({
      dryWeek: { month: peak.month, mm: dryMm, each, waterings: Math.max(1, Math.round(dryMm / Math.max(0.1, each))) },
      takesInPerH: takes, cycles: { spray: cyclesFor(1.5), rotor: cyclesFor(0.5) },
      zone: z, m2: cells.length * g.cell * g.cell,
      depthMm: med(cells.map((i) => Math.min(model.raw[i], model.dayCapMm[i]))) * SM,
      tawMm: med(rz),
      peakMonth: peak.month, peakEveryDays: peak.waterings ? DAYS_IN[peak.month] / peak.waterings : null,
      months,
      slope: med(cells.map((i) => model.slope[i])),
      sun: light ? med(cells.map((i) => light[i])) : null,
      heatShare: cells.filter((i) => model.heat[i] > 1.02).length / cells.length,
      soils: unitNames, drainage, runOnShare: runOn, runOnRatio,
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
    simulate(model, week.days, { season, irrigate: zoneIrrigation(model, zones.zoneOf, zones.n, wev) });
    const ti = Math.max(0, week.days.findIndex((d) => d.date >= week.today));
    thisWeek = {
      today: week.today,
      zones: out.map((o) => {
        const next = wev.find((e) => e.zone === o.zone && e.d >= ti);
        const last = [...wev].reverse().find((e) => e.zone === o.zone && e.d < ti);
        return { zone: o.zone, next: next ? { date: week.days[next.d].date, mm: next.mm * SM } : null, last: last ? { date: week.days[last.d].date } : null };
      }),
      rainComing: week.days.slice(ti).reduce((s, d) => s + (d.rain || 0), 0),
      through: week.days[week.days.length - 1].date,
      // the recent rains whose hours are known: how much, and the most in one hour (weather.js addRainHours)
      rains: week.days.filter((d) => d.hours && d.date < week.today).map((d) => ({ date: d.date, mm: d.rain, peakMmH: d.peakMmH })),
      // the lawn's own intake, the middle of its cells (rain faster than this ran off)
      lawnIntakeMmH: med(Array.from(model.intakeMmH).filter((v, i) => kinds[i] === KIND.lawn && Number.isFinite(v))),
    };
  }

  // per-cell overlays for the page
  /* EACH SQUARE METRE'S OWN NEED (owner, 2026-10-19: "changes to map inputs do have knock-on effects in
     the same way that a real lawn is affected by many different things"): the watering it would want in the
     lawn's thirstiest month, typical year, cell by cell -- every input's effect shows here, whether or not
     it moves a zone line. */
  const pm = zones.peakMonth ?? 6;
  const needMm = new Float32Array(N).fill(NaN);
  for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) needMm[i] = (perMonth[pm][i] / years) * SM;
  const wetShare = new Float32Array(N), dryShare = new Float32Array(N), wetFromWatering = new Float32Array(N), wetAnyway = new Float32Array(N);
  for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) {
    wetShare[i] = planned.wetDays[i] / Math.max(1, planned.seasonDays); dryShare[i] = planned.dryDays[i] / Math.max(1, planned.seasonDays);
    wetFromWatering[i] = (planned.wetDays[i] - rainOnly.wetDays[i]) / Math.max(1, planned.seasonDays);
    wetAnyway[i] = rainOnly.wetDays[i] / Math.max(1, rainOnly.seasonDays);
  }
  return {
    multiplier: SM, rootIn: (soils[0]?.rz?.rootCm ?? 20.32) / 2.54,
    zones: out, zoneOf: zones.zoneOf, userZones: !!zones.user, kinds, needMm,
    // each cell's soil, as the index of its unit in soil below (the soil view)
    soilAt: Int16Array.from(soilAt, (v) => v >> 1), needMonth: pm, wetShare, dryShare, wetFromWatering, wetAnyway,
    roofs: (() => {
      /* Only the roofs on the property count for asking: the analysis reaches 30 m past the property line,
         where the neighbours' houses are (owner, 2026-10-19: "it says I still have 21 unmarked roofs"). With
         no property line, the roofs within 5 m of the lawn. */
      let mine = parcelMask;
      if (!mine) {
        mine = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) { const r = Math.floor(i / g.W), c = i % g.W; for (let dr = -5; dr <= 5; dr++) for (let dc = -5; dc <= 5; dc++) { const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < g.H && cc < g.W) mine[rr * g.W + cc] = 1; } }
      }
      const onLot = roofs.pieces.filter((p) => p.cells.some((i) => mine[i]) && p.cells.length >= 6);
      return { pieces: onLot.length, guessed: onLot.filter((p) => p.guessed).length, unusedDownspouts: roofs.unused, allPieces: roofs.pieces.length };
    })(),
    texture: texture || null,
    soil: units.map((u) => ({ name: u.name, chosen: u.chosen || null, share: u.share ?? null, layers: layersOf(u.profile), intakeInH: (() => { const r = rootZone(u.profile); return r?.topKsatMmH ? r.topKsatMmH / 25.4 : null; })(), drainage: u.drainage, hydgrp: u.hydgrp, wtMinCm: u.wtMinCm ?? null, wetByMonth: u.wetByMonth, assumed: !!u.assumed, tawMm: rootZone(u.profile)?.tawMm ?? null, tawTopsoilMm: rootZone(u.profile, { topsoil: true })?.tawMm ?? null })),
    years, topsoil, grass, thisWeek, shaded: !!light, lightByMonth: !!model.lightMonths, ownRadiation: !!model.rad, treeCool: !!model.canopy, yardWind: model.windAt ? (() => { const v = []; for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) v.push(model.winds[model.windAt[i]]); return v.length ? med(v) : null; })() : null,
    sunShare: light ? (() => { const v = []; for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) v.push(light[i]); return med(v); })() : null,
    weather: wx,
  };
}

/** Rain and grass water use by month, typical-year medians (mm). */
export function monthly(days, years, params = PARAMS) {
  const rain = Array.from({ length: 12 }, () => new Array(years).fill(0)), et = Array.from({ length: 12 }, () => new Array(years).fill(0));
  const y0 = Number(days[0].date.slice(0, 4));
  for (const d of days) {
    const m = Number(d.date.slice(5, 7)) - 1, y = Number(d.date.slice(0, 4)) - y0;
    if (y < 0 || y >= years) continue;
    rain[m][y] += d.rain || 0; et[m][y] += d.et0 || 0;
  }
  // the reference (clipped, well-watered grass: what Enviroweather calls Potential ET) and the grass's own use
  return rain.map((r, m) => ({ month: m, rainMm: med(r), referenceMm: med(et[m]), grassUseMm: med(et[m]) * params.kc }));
}
