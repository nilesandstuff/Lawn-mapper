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

import { rootZone, maxSprinklerRate, withTexture, layersOf, textureClass, TOPSOIL } from './soil.js';
import { slowLayerOf, calibrateLayer, layerDepths, perchedRoutes, perchedCells, drainToLayerMmDay, barrierExtraMm } from './perched.js';
import { tableDepths, subsoilOf } from './groundwater.js';
import { workingCm, speciesOf, groupOf, typicalRoots, attachRootRatio, rootsByMonth, kcFor, SPECIES } from './roots.js';
import { soilIndex } from './soilplace.js';
import { dayIndex } from './shade/climate.js';
import { maskOf } from './geo.js';
import { roofRouting } from './gutters.js';
import { buildModel, simulate, idealIrrigation, zoneIrrigation, schedulingMultiplier, PARAMS, WARM, withMode } from './balance.js';
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
export function waterPlan(res, { lawnMask, paved = null, soil = { units: [] }, topsoil = false, downspouts = [], gutters = [], typical, week = null, light = null, lightMonths = null, radiation = null, fenceHeat = null, windMonths = null, shadeKinds = null, season = null, grass = 'cool', species = null, soilTemp = null, mode = 'normal', placement = null, texture = null, parcelMask = null, areas = [], zoneOf: userZones = null, groundwater = null, snapshots = null, params: given = null } = {}) {
  // warm-season turf (owner 2026-10-18): FAO-56's p 0.5 in place of cool-season's 0.4
  // the level's crop coefficient from the owner's table by species (roots.js kcFor; FINDINGS H54), unless params were given whole
  const kc = kcFor(species, grass, mode);
  // the schedule waters for the level's coefficient; the grass draws at its own (normal's), so a lower level shows its stress
  const params = withMode(given || (grass === 'warm' ? { ...PARAMS, ...WARM } : PARAMS), mode, given ? null : kc.kc, given ? null : kc.normalKc);
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
  /* THE ROOTS (H53): the working depth from the species checked (the group's general figure with none), and each
     soil's available water cm by cm down to it, for the day's shallower roots (balance.js simulate). */
  const ids = speciesOf(species, grass), rootCm = workingCm(species, grass);
  /* EACH SOIL IN ITS OWN PLACE (H62): with a placement (soilplace.js), each unit's soils become their own entries --
     their own layers, group, drainage and water table -- and each cell takes the one its wetness index falls to;
     without one, the unit's main soil as before. `placed` is what the soil view and card list. */
  const placed = [], soilAt = new Int16Array(N).fill(0);
  const pct = (v) => Math.round(v * 100);
  units.forEach((u) => {
    const P = placement?.byUnit?.get(u.mukey);
    const m = u.polygons?.length ? maskOf(g, u.polygons.map((coordinates) => ({ type: 'Polygon', coordinates }))) : null;
    if (!P) {
      const k = placed.push(u) - 1;
      if (m) for (let i = 0; i < N; i++) if (m[i]) soilAt[i] = 2 * k;
      return;
    }
    const idx = P.comps.map((c, j) => placed.push({
      mukey: u.mukey, share: null, polygons: null, chosen: u.chosen || null,
      name: P.borrowed ? `${c.name} (${pct(c.share)}% of ${P.borrowed}, the nearest mapped soil: the survey maps this ground as ${u.name || 'urban land'})`
        : P.comps.length > 1 ? `${c.name} (${pct(c.share)}% of ${u.name}${c.drainage && c.drainage !== P.comps[0].drainage ? ', in its wetter ground' : ''})` : u.name,
      drainage: c.drainage || u.drainage, hydgrp: c.hydgrp || u.hydgrp, slope: c.slope ?? u.slope, profile: c.profile, wetByMonth: c.wetByMonth || u.wetByMonth,
      component: c.name, placedBy: P.cuts.length ? 'wetness' : 'only soil', borrowed: P.borrowed,
      wtMinCm: (() => { const v = (c.wetByMonth || []).filter(Number.isFinite); return v.length ? Math.min(...v) : null; })(),
    }) - 1);
    if (m) for (let i = 0; i < N; i++) if (m[i]) soilAt[i] = 2 * idx[soilIndex(P, placement.twi ? placement.twi[i] : NaN)];
  });
  const soils = [];
  const tableFor = (profile, topsoil) => { const t = new Float32Array(Math.ceil(rootCm) + 1); for (let cm = 1; cm < t.length; cm++) t[cm] = rootZone(profile, { rootCm: cm, topsoil })?.tawMm ?? 0; return t; };
  for (const u of placed) {
    soils.push({ unit: u, rz: rootZone(u.profile, { rootCm }), tawByCm: tableFor(u.profile, false), drainage: u.drainage, hydgrp: u.hydgrp, wetByMonth: u.wetByMonth });
    soils.push({ unit: u, rz: rootZone(u.profile, { rootCm, topsoil: true }), tawByCm: tableFor(u.profile, true), drainage: u.drainage, hydgrp: u.hydgrp, wetByMonth: u.wetByMonth, topsoil: true });
  }
  if (topsoil) for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) soilAt[i] += 1;
  /* THE CAPILLARY BARRIER (research-interface.md B; H73): the loamy topsoil put on a sand or loamy sand holds water
     above the boundary that the survey's field capacity does not count -- the sand below takes none until the loam is
     nearly saturated. About 2.2 mm more per cm of loam (10 cm +22 mm, the topsoil's own available water again),
     counted as a raised field capacity, and no water rises from below across it (the sand under it dry and nearly
     non-conducting). */
  for (const s of soils) {
    if (!s.topsoil || !s.rz) continue;
    const ex = barrierExtraMm(s.unit.profile, TOPSOIL.cm, textureClass);
    if (!(ex > 0)) continue;
    s.barrierMm = ex; s.rz = { ...s.rz, tawMm: s.rz.tawMm + ex };
    for (let cm = 1; cm < s.tawByCm.length; cm++) s.tawByCm[cm] += ex * Math.min(1, cm / TOPSOIL.cm);
  }
  /* SLOW LAYERS THAT PERCH WATER (H73; lib/perched.js): each soil's, its depth under the topsoil when there is some */
  const slow = soils.map((s) => {
    const L = calibrateLayer(slowLayerOf(s.unit.profile), s.wetByMonth, typical, params.kc);
    if (!L || !s.topsoil) return L;
    const t = TOPSOIL.cm, sh = (v) => (Number.isFinite(v) ? v + t : null);
    return { ...L, topCm: L.topCm + t, topLoCm: sh(L.topLoCm), topHiCm: sh(L.topHiCm) };
  });

  // 2. roofs
  const roofs = roofRouting(g, wallNow, res.runoff.filled, { downspouts, gutters });
  const model = buildModel(res, { kinds, soilAt, soils, roofTo: roofs.roofTo, light, lightMonths: light ? lightMonths : null, radiation: light ? radiation : null, fenceHeat: light ? fenceHeat : null, windMonths, shadeKinds: light ? shadeKinds : null, params });
  for (let i = 0; i < N; i++) if (deckCells[i]) { model.etFactor[i] *= params.deckShelter; model.etBase[i] *= params.deckShelter; }
  /* The roots through the season: each day of the ten years (and of this week) takes its root-zone share from the
     10 cm soil temperature -- the day's own where IEMRE gave it, else the typical year's (roots.js). The warm-season
     spring decline is tied to the growing season's first day after a cold winter. */
  const greenUp = grass === 'warm' && season && season.size && season.size < 360 ? Math.min(...season) : null;
  const tTyp = soilTemp?.typical?.length === 365 ? soilTemp.typical : null;
  let rootsTyp = tTyp ? typicalRoots(tTyp, species, grass, { greenUp }) : null;
  let rootOwnDays = 0;
  if (tTyp || soilTemp?.byDate) {
    rootOwnDays = attachRootRatio(typical, { soilByDate: soilTemp?.byDate || null, typical: tTyp, ids: species, group: grass, greenUp, dayIndex });
    // the roots by month from the years themselves, when most days had their own soil temperature
    if (rootOwnDays > typical.length / 2) rootsTyp = rootsByMonth(typical, rootCm, dayIndex) || rootsTyp;
    if (week?.days?.length) attachRootRatio(week.days, { soilByDate: soilTemp?.byDate || null, typical: tTyp, ids: species, group: grass, greenUp, dayIndex });
  }
  // the most a day's watering can put down, cell by cell (PARAMS.cyclesPerDay runs of an hour's intake),
  // as water reaching the grass: what is put down, over the scheduling multiplier
  const SM = schedulingMultiplier(params);
  model.dayCapMm = new Float32Array(N).fill(Infinity);
  // what each cell of ground takes in an hour, mm (rain faster than this runs off, on days whose hours are known)
  model.intakeMmH = new Float32Array(N).fill(Infinity);
  for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn || kinds[i] === KIND.other) model.intakeMmH[i] = maxSprinklerRate(soils[soilAt[i]].rz, model.slope[i]).inPerH * 25.4;
  for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) model.dayCapMm[i] = (params.cyclesPerDay * maxSprinklerRate(soils[soilAt[i]].rz, model.slope[i]).inPerH * 25.4) / SM;
  /* THE WATER TABLE UNDER EACH SQUARE METRE (H70; lib/groundwater.js): from the water levels round the lawn (ponds,
     streams, wetlands within a kilometre), the cell's own lidar ground, and its soil's wet layers; and the soil
     between its roots and the water table, for the water rising from it. Without the water maps, the survey alone. */
  if (groundwater?.levelAny) {
    model.wtCm = new Float32Array(N * 12).fill(NaN); model.crCls = new Uint8Array(N).fill(2); model.crK = new Float32Array(N).fill(100);
    const sub = soils.map((s) => subsoilOf(s.unit.profile, rootCm, 200, textureClass));
    for (let i = 0; i < N; i++) {
      if (kinds[i] !== KIND.lawn || !Number.isFinite(res.z[i])) continue;
      // over a slow layer the survey's wet months are the perched water (the store below holds it), not the water table
      model.wtCm.set(tableDepths(res.z[i], { any: groundwater.levelAny[i], perm: groundwater.levelPerm[i] }, slow[soilAt[i]] ? null : soils[soilAt[i]].wetByMonth), i * 12);
      model.crCls[i] = sub[soilAt[i]].cls; model.crK[i] = sub[soilAt[i]].ksatMmDay;
    }
  }

  /* THE PERCHED STORE (H73): the slow layer's depth under each cell of ground (its soil's depth, deeper under rises and
     shallower under hollows), the routes along its top, and what each cell's roots drain into it at: the survey's own
     rate down to the layer, not the drainage class's factor (which already holds the perching and would count it
     twice). Roofs and paving keep none (their cells take what runs to them as free-draining ground). */
  if (slow.some(Boolean)) {
    const ground = (i) => (kinds[i] === KIND.lawn || kinds[i] === KIND.other || kinds[i] === KIND.pavers) && Number.isFinite(res.z[i]);
    const { zL, beta, z5 } = layerDepths(g, res.z, soilAt, slow);
    const par = perchedCells(N, soilAt, slow, zL, ground);
    let any = false; for (let i = 0; i < N && !any; i++) any = Number.isFinite(par.zL[i]);
    if (any) {
      model.perched = { routes: perchedRoutes(g, z5, par.zL), par, slow, beta };
      const drainTo = soils.map((s, k) => (slow[k] ? drainToLayerMmDay(s.unit.profile, rootCm - (s.topsoil ? TOPSOIL.cm : 0), slow[k].topCm - (s.topsoil ? TOPSOIL.cm : 0), s.rz?.belowMmH) : null));
      for (let i = 0; i < N; i++) if (Number.isFinite(par.zL[i])) model.drainDay[i] = drainTo[soilAt[i]];
      if (!model.crCls) {
        model.crCls = new Uint8Array(N).fill(2); model.crK = new Float32Array(N).fill(100);
        const sub = soils.map((s) => subsoilOf(s.unit.profile, rootCm, 200, textureClass));
        for (let i = 0; i < N; i++) if (Number.isFinite(par.zL[i])) { model.crCls[i] = sub[soilAt[i]].cls; model.crK[i] = sub[soilAt[i]].ksatMmDay; }
      }
    }
  }
  if (soils.some((s) => s.barrierMm)) { model.noRise = new Uint8Array(N); for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn && soils[soilAt[i]].barrierMm) model.noRise[i] = 1; }

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
  /* THE SOIL ON A GIVEN DAY (2026-11-04, to set the model against soil moisture readings, FINDINGS H74): the recent
     weeks' real weather, rain alone (no watering assumed), and each cell's water at the end of each date asked for,
     as a share of the water its roots can use: (TAW - Dr + water above field capacity + standing water) / TAW, so
     1 is full and over 1 wetter than full. The run starts full 60 days back. */
  let snaps = null;
  if (snapshots?.length && week?.days?.length) {
    const want = new Map(snapshots.map((d) => [d, null]));
    simulate(model, week.days, { season, record: (d, st) => {
      const date = week.days[d].date;
      if (!want.has(date) || want.get(date)) return;
      const wet = new Float32Array(N).fill(NaN);
      for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn || kinds[i] === KIND.other || kinds[i] === KIND.pavers) {
        const t = model.taw[i];
        if (t > 0) wet[i] = (t - st.Dr[i] + st.grav[i] + st.pond[i]) / t;
      }
      want.set(date, wet);
    } });
    snaps = [...want.entries()].filter(([, w]) => w).map(([date, wet]) => ({ date, wet }));
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
  /* What the water table does under the lawn (H70): its depth month by month at the lawn's middle, the share of the
     lawn it reaches within a foot of the surface in summer, where it stands at the surface (seeps), and the water it
     lifts into the roots over a season, with rain alone and as watered. */
  const groundwaterOut = (() => {
    if (!model.wtCm) return null;
    const cells = []; for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn && Number.isFinite(res.z[i])) cells.push(i);
    if (!cells.length) return null;
    const byMonth = Array.from({ length: 12 }, (_, m) => { const v = cells.map((i) => model.wtCm[i * 12 + m]); const fin = v.filter(Number.isFinite); return fin.length > cells.length / 2 ? med(fin) : null; });
    const summer = [6, 7, 8];
    const share = (f) => cells.filter((i) => summer.every((m) => f(model.wtCm[i * 12 + m]))).length / cells.length;
    const seepCells = cells.filter((i) => [4, 5, 6, 7, 8].every((m) => model.wtCm[i * 12 + m] <= params.seepCm));
    const late = new Float32Array(N).fill(NaN), riseMm = new Float32Array(N).fill(NaN);
    for (const i of cells) { late[i] = model.wtCm[i * 12 + 8]; riseMm[i] = rainOnly.rose[i] / years; }
    return {
      byMonthCm: byMonth, withinFootSummer: share((d) => d <= 30.48), withinTwoFeetSummer: share((d) => d <= 60.96), seepShare: seepCells.length / cells.length,
      riseRainAloneMm: med(cells.map((i) => rainOnly.rose[i] / years)), risePlannedMm: med(cells.map((i) => planned.rose[i] / years)),
      riseMostMm: Math.max(...cells.map((i) => rainOnly.rose[i] / years)),
      late, riseMm, summary: groundwater.summary || null,
    };
  })();
  /* What the perched water does under the lawn (H73): the share of the lawn over a slow layer, each such soil's layer
     (depth, kind, how slowly it lets water through), the layer's depth across the lawn, the season's days the perched
     water stands in the roots, and a year's seep at the surface, leak through the layer, and water arriving sideways. */
  const perchedOut = (() => {
    const barrier = soils.filter((s, k) => s.barrierMm && kinds.some((v, i) => v === KIND.lawn && soilAt[i] === k)).map((s) => ({ name: s.unit.name, mm: s.barrierMm }));
    if (!model.perched) return barrier.length ? { share: 0, soils: [], barrier } : null;
    const par = model.perched.par;
    const lawnCells = []; for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) lawnCells.push(i);
    const cells = lawnCells.filter((i) => Number.isFinite(par.zL[i]));
    if (!cells.length) return barrier.length ? { share: 0, soils: [], barrier } : null;
    const usedSoils = [...new Set(cells.map((i) => soilAt[i]))];
    const yr = (t, k) => cells.map((i) => t.perched[k][i] / years);
    const sd = Math.max(1, rainOnly.seasonDays / years);
    const standDays = new Float32Array(N).fill(NaN), seepMm = new Float32Array(N).fill(NaN), layerCm = new Float32Array(N).fill(NaN);
    for (const i of cells) { standDays[i] = rainOnly.perched.standDays[i] / years; seepMm[i] = rainOnly.perched.seep[i] / years; layerCm[i] = par.zL[i]; }
    return {
      share: cells.length / Math.max(1, lawnCells.length),
      soils: usedSoils.map((k) => { const L = model.perched.slow[k]; return { name: soils[k].unit.name, topsoil: !!soils[k].topsoil, depthCm: L.topCm, how: L.how, band: L.band, layer: L.name, resistDays: L.resistDays, cM: L.cM, calibrated: L.calibrated || null, kLatMmDay: L.kLatMmDay, beta: model.perched.beta[k] }; }),
      layerCmLow: q(cells.map((i) => par.zL[i]), 0.1), layerCmHigh: q(cells.map((i) => par.zL[i]), 0.9),
      standDaysRainAlone: med(cells.map((i) => rainOnly.perched.standDays[i] / years)), standDaysPlanned: med(cells.map((i) => planned.perched.standDays[i] / years)),
      standDaysMost: Math.max(...cells.map((i) => rainOnly.perched.standDays[i] / years)), seasonDays: sd,
      seepMm: med(yr(rainOnly, 'seep')), seepMostMm: Math.max(...yr(rainOnly, 'seep')), seepShare: cells.filter((i) => rainOnly.perched.seep[i] / years >= 5).length / lawnCells.length,
      leakMm: med(yr(rainOnly, 'leak')), sidewaysInMostMm: Math.max(...yr(rainOnly, 'latIn')), intoMm: med(yr(rainOnly, 'into')),
      toRootsMm: med(yr(rainOnly, 'toRoots')), toRootsPlannedMm: med(yr(planned, 'toRoots')),
      topMinCm: med(cells.map((i) => rainOnly.perched.topMin[i])), // the perched water's shallowest, with rain alone (Infinity: never)
      standDays, seepMmMap: seepMm, layerCm, barrier,
    };
  })();
  return {
    snapshots: snaps,
    groundwater: groundwaterOut,
    perched: perchedOut,
    multiplier: SM, rootIn: rootCm / 2.54,
    mode: params.mode, kc: { ...kc, used: params.scheduleKc ?? params.kc, grass: params.kc },
    /* THE GRASS SHORT OF WATER (owner, 2026-10-29): the lawn's middle cell's share of the season's days past the
       readily available water, as planned and with rain alone, and the days themselves. */
    stress: (() => {
      const lawnCells = []; for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn && zones.zoneOf[i] >= 0) lawnCells.push(i);
      const sd = Math.max(1, planned.seasonDays / years), sh = (t, a = t.dryDays) => med(lawnCells.map((i) => a[i] / Math.max(1, t.seasonDays)));
      const use = (t) => med(lawnCells.map((i) => (t.etFull[i] > 0 ? t.etSeason[i] / t.etFull[i] : 1)));
      return { planned: sh(planned), severe: sh(planned, planned.severeDays), rainAlone: sh(rainOnly), rainAloneSevere: sh(rainOnly, rainOnly.severeDays), useShare: use(planned), rainAloneUseShare: use(rainOnly), seasonDays: Math.round(sd) };
    })(),
    roots: { species: ids.map((id) => ({ id, name: SPECIES[id].name, workingIn: SPECIES[id].workingIn, general: !!SPECIES[id].general })), workingIn: Math.round((rootCm / 2.54) * 10) / 10, typical: rootsTyp, ownDays: rootOwnDays, ofDays: typical.length },
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
    soil: placed.map((u) => ({ name: u.name, component: u.component || null, borrowed: u.borrowed || null, chosen: u.chosen || null, share: u.share ?? null, layers: layersOf(u.profile), intakeInH: (() => { const r = rootZone(u.profile); return r?.topKsatMmH ? r.topKsatMmH / 25.4 : null; })(), drainage: u.drainage, hydgrp: u.hydgrp, wtMinCm: u.wtMinCm ?? null, wetByMonth: u.wetByMonth, assumed: !!u.assumed, tawMm: rootZone(u.profile)?.tawMm ?? null, tawTopsoilMm: rootZone(u.profile, { topsoil: true })?.tawMm ?? null })),
    years, topsoil, grass, thisWeek, shaded: !!light, lightByMonth: !!model.lightMonths, ownRadiation: !!model.rad, fences: model.fenceHeat ? { fences: model.fenceHeat.fences, seen: model.fenceHeat.seen } : null, treeCool: !!model.canopy, yardWind: model.windAt ? (() => { const v = []; for (let i = 0; i < N; i++) if (kinds[i] === KIND.lawn) v.push(model.winds[model.windAt[i]]); return v.length ? med(v) : null; })() : null,
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
  return rain.map((r, m) => ({ month: m, rainMm: med(r), referenceMm: med(et[m]), grassUseMm: med(et[m]) * (params.scheduleKc ?? params.kc) })); // what the watering replaces, at the level's coefficient
}
