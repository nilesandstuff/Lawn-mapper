/**
 * THE DAILY WATER BALANCE OF A LAWN, SQUARE METRE BY SQUARE METRE
 * (water session, 2026-10-18; the owner's vision, water/VISION.md).
 *
 * Each day, on the 1 m grid of lib/lowspots.js:
 *
 *   ROOFS     rain less the roof's first wetting runs to where the user says
 *             (lib/gutters.js: each roof cell's water goes down a downspout
 *             onto the ground it empties to, or drips off the nearest edge);
 *             with nothing entered, to the roof piece's lowest neighbour.
 *   PAVING    concrete and blacktop hold a film (the depression storage),
 *             which evaporates; the rest runs on, downhill.
 *   GROUND    rain + irrigation + whatever ran onto the cell: the SCS curve
 *             number (by hydrologic group, slope-adjusted) splits it into
 *             soaking in and running on. Water that reaches a low spot is
 *             held there (up to the spot's depth) and soaks in on later days.
 *   ROOT ZONE soaking-in water refills the root zone (lib/soil.js rootZone:
 *             what the roots can use); beyond field capacity it is gravity
 *             water, which drains down at a rate set by the slowest layer
 *             below the roots and the drainage class, and hardly at all when
 *             the seasonal water table is up. What cannot drain or fit stays:
 *             a WET day. The grass uses ET0 x Kc x light (FAO-56, eq. 84
 *             stress below the readily available water): past that, a DRY
 *             (stressed) day.
 *   SNOW      below freezing rain is snow; it melts by degree-days.
 *
 * Every number the model leans on is in PARAMS, with where it comes from.
 * Water is in mm, which on a 1 m cell is litres.
 */

import { KC } from './et.js';
import { dayIndex } from './shade/climate.js';

export const PARAMS = {
  kc: KC,                 // the owner's grass coefficient (VISION.md), 0.8 for now
  p: 0.4,                 // FAO-56 Table 22 depletion fraction before stress: cool-season turf 0.4 (warm-season 0.5)
  roofLossMm: 0.5,        // a roof's first wetting, per rain day (first flush 10 gal per 1,000 sq ft = 0.41 mm, Texas manual)
  paveStoreMm: 1.0,       // concrete / blacktop film that does not run off and evaporates (measured 0.4-1 mm, Zhou 2021; ASCE 1992 table 1.3-2.5)
  cnLawn: { A: 39, B: 61, C: 74, D: 80 }, // TR-55 (USDA 1986), open space in good condition
  cnOther: { A: 49, B: 69, C: 79, D: 84 }, // TR-55, open space in fair condition (beds, bare edges)
  cnPaved: 98,
  satRoomFrac: 0.1,       // water the root zone holds above field capacity before it ponds, as a share of its depth
  drainShareMax: 0.6,     // at most this share of the gravity water drains in a day (a day or two to field capacity)
  drainFactor: {          // drainage class -> how freely gravity water leaves (the survey's words, read as rates)
    'Excessively drained': 1, 'Somewhat excessively drained': 1, 'Well drained': 1, 'Moderately well drained': 0.5,
    'Somewhat poorly drained': 0.25, 'Poorly drained': 0.1, 'Very poorly drained': 0.05,
  },
  tableBlockCm: 30,       // a water table within this far below the roots stops them draining
  wetSat: 0.5,            // a WET day: the root zone at least this far from field capacity to saturation, or water standing
  snowMeltMmPerC: 3.5,    // degree-day melt
  seasonC: 10,            // growing season: the week's mean temperature at or above this
};

const HYD = (h) => String(h || 'B').trim().toUpperCase();

/* Shade: turf ET is linear in the sunlight it gets, but about 30% of full-sun ET is carried in by warm
   dry air, which shade does not stop (Danielson & Feldhake 1981, lysimeters): ET = ET_sun x (0.3 + 0.7 x
   the share of sunlight received). `light` is that share (1 in full sun). */
export const shadeFactor = (light) => 0.3 + 0.7 * Math.max(0, Math.min(1, light));

/** TR-55 curve number for a cell, dual groups read as drained (first letter) unless the water table is up. */
export function curveNumber(hydgrp, kind, wetTable, params = PARAMS) {
  let g = HYD(hydgrp);
  if (g.includes('/')) g = wetTable ? g.split('/')[1] : g.split('/')[0];
  g = 'ABCD'.includes(g[0]) ? g[0] : 'B';
  if (kind === 'paved') return params.cnPaved;
  return (kind === 'lawn' ? params.cnLawn : params.cnOther)[g];
}

/** Slope-adjusted curve number (Williams 1995, as SWAT uses it); slope in m/m. */
export function cnSlope(cn2, slope) {
  const cn3 = cn2 * Math.exp(0.00673 * (100 - cn2));
  return Math.min(99, ((cn3 - cn2) / 3) * (1 - 2 * Math.exp(-13.86 * slope)) + cn2);
}

/** Daily runoff (mm) from water `w` (mm) by curve number (SCS, Ia = 0.2 S). */
export function scsRunoff(w, cn) {
  if (cn >= 99.5) return Math.max(0, w);
  const S = 25400 / cn - 254, Ia = 0.2 * S;
  return w > Ia ? ((w - Ia) ** 2) / (w + 0.8 * S) : 0;
}

/**
 * The model for one lot, from the analysis (lib/lowspots.js), the soil and what the user drew.
 *
 * res      analyse(): grid, z, wall, runoff { down, filled }, spots { depth, spots }
 * kinds    Uint8Array per cell: 0 other ground, 1 lawn, 2 roof, 3 paved
 * soilAt   Int16Array per cell: index into `zonesOfSoil`, -1 none
 * soils    [{ rz: rootZone(...), drainage, hydgrp, wetByMonth }]
 * roofTo   Int32Array per cell: where a roof cell's water lands (lib/gutters.js), -1 nowhere
 * light    Float32Array per cell (0-1, ET multiplier from shade) or null
 */
export function buildModel(res, { kinds, soilAt, soils, roofTo, light = null, params = PARAMS }) {
  const g = res.grid, N = g.W * g.H;
  const { down, filled } = res.runoff;
  const order = [];
  for (let i = 0; i < N; i++) if (kinds[i] !== 2) order.push(i);
  order.sort((a, b) => filled[b] - filled[a]);

  // slope per cell (m/m) from the ground surface, central differences
  const slope = new Float32Array(N);
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    const i = r * g.W + c;
    const zx = (res.z[r * g.W + Math.min(g.W - 1, c + 1)] - res.z[r * g.W + Math.max(0, c - 1)]) / ((Math.min(g.W - 1, c + 1) - Math.max(0, c - 1)) * g.cell || 1);
    const zy = (res.z[Math.min(g.H - 1, r + 1) * g.W + c] - res.z[Math.max(0, r - 1) * g.W + c]) / ((Math.min(g.H - 1, r + 1) - Math.max(0, r - 1)) * g.cell || 1);
    slope[i] = Math.min(1, Math.hypot(zx, zy));
  }
  // low spots hold water up to their depth (reported spots only: the rest is noise, FINDINGS H7)
  const pondCap = new Float32Array(N);
  for (const s of res.spots.spots) if (s.reported) for (const i of s.cells) pondCap[i] = res.spots.depth[i] * 1000;

  const taw = new Float32Array(N), raw = new Float32Array(N), satRoom = new Float32Array(N), drainDay = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = soils[soilAt[i]] || soils[0];
    const rz = s?.rz;
    const t = rz?.tawMm ?? 20;
    taw[i] = t; raw[i] = params.p * t;
    satRoom[i] = params.satRoomFrac * (rz?.rootCm ?? 15) * 10;
    const below = rz?.belowMmH ?? 5;
    drainDay[i] = below * 24 * (params.drainFactor[s?.drainage] ?? 0.5);
  }
  return { g, N, kinds, soilAt, soils, roofTo, light, order, down, slope, pondCap, taw, raw, satRoom, drainDay, params };
}

/**
 * Run the balance over `days` ([{ date, tmax, tmin, rain, et0 }]).
 *
 * season: a Set of day-of-year indices (0..364, shade/climate.js dayIndex) -- the shade map's growing
 * season (20% growth potential, the owner's rule), the same for both maps; without it, a week's mean
 * temperature of PARAMS.seasonC or more.
 * irrigate(dayIndex, state) -> Float32Array of mm per cell to apply that day, or null. The state it
 * sees: { Dr (depletion, mm), grav, month, inSeason }.
 * start: { Dr: Float32Array } to begin from (default: every cell at field capacity).
 * record(dayIndex, state, flags) is called after each day (optional).
 *
 * -> totals per cell over the run: irrigation, et, drained (below the roots), ranOff (left the cell
 *    on the surface), wetDays, dryDays, seasonDays; and the end state.
 */
export function simulate(model, days, { irrigate = null, start = null, record = null, season = null } = {}) {
  const { N, kinds, order, down, roofTo, slope, pondCap, taw, raw, satRoom, drainDay, soils, soilAt, params } = model;
  const Dr = start?.Dr ? Float32Array.from(start.Dr) : new Float32Array(N);
  const grav = new Float32Array(N), pond = new Float32Array(N), film = new Float32Array(N);
  const tot = { irrigation: new Float32Array(N), et: new Float32Array(N), drained: new Float32Array(N), ranOff: new Float32Array(N), wetDays: new Uint16Array(N), dryDays: new Uint16Array(N), seasonDays: 0, rain: 0 };
  const inflow = new Float32Array(N);
  const cn = new Float32Array(N);
  let snow = 0, lastMonth = -1;
  const temps = [];
  for (let d = 0; d < days.length; d++) {
    const day = days[d];
    const month = Number(day.date.slice(5, 7)) - 1;
    const tmean = (day.tmax + day.tmin) / 2;
    temps.push(tmean); if (temps.length > 7) temps.shift();
    const inSeason = season ? season.has(dayIndex(day.date.replace(/-/g, ''))) : temps.reduce((s, v) => s + v, 0) / temps.length >= params.seasonC;
    if (month !== lastMonth) { // curve numbers and drainage follow the month's water table
      for (let i = 0; i < N; i++) {
        const s = soils[soilAt[i]] || soils[0];
        const wt = s?.wetByMonth?.[month];
        const wetTable = wt !== null && wt !== undefined && wt <= (s?.rz?.rootCm ?? 15) + params.tableBlockCm;
        const kind = kinds[i] === 1 ? 'lawn' : kinds[i] === 3 ? 'paved' : 'other';
        cn[i] = kinds[i] === 2 ? 99 : cnSlope(curveNumber(s?.hydgrp, kind, wetTable, params), slope[i]);
        model.blocked ||= new Uint8Array(N);
        model.blocked[i] = wetTable ? 1 : 0;
      }
      lastMonth = month;
    }
    // snow: below freezing the day's rain is stored; above, the store melts by degree-days
    let P = Number.isFinite(day.rain) ? day.rain : 0;
    if (day.tmax <= 0) { snow += P; P = 0; } else if (snow > 0) { const melt = Math.min(snow, params.snowMeltMmPerC * Math.max(0, tmean)); snow -= melt; P += melt; }
    tot.rain += P;
    const et0 = Number.isFinite(day.et0) ? day.et0 : 0;
    const irr = irrigate ? irrigate(d, { Dr, grav, month, inSeason, date: day.date, use: et0 * params.kc }) : null;

    inflow.fill(0);
    // roofs
    const roofQ = Math.max(0, P - params.roofLossMm);
    if (roofQ > 0) for (let i = 0; i < N; i++) if (kinds[i] === 2 && roofTo[i] >= 0) inflow[roofTo[i]] += roofQ;
    // the ground, uphill first
    for (const i of order) {
      const add = irr ? irr[i] || 0 : 0;
      if (add) tot.irrigation[i] += add;
      let w = P + inflow[i] + pond[i];
      pond[i] = 0;
      let q;
      if (kinds[i] === 3) {
        const take = Math.min(w, params.paveStoreMm - film[i]);
        film[i] += take; q = w - take;
      } else {
        q = scsRunoff(w, cn[i]);
        let inf = w - q + add;
        const room = Dr[i] + (satRoom[i] - grav[i]);
        if (inf > room) { q += inf - room; inf = room; }
        Dr[i] -= inf;
        if (Dr[i] < 0) { grav[i] += -Dr[i]; Dr[i] = 0; }
        if (q > 0 && pondCap[i] > 0) { const hold = Math.min(q, pondCap[i]); pond[i] = hold; q -= hold; }
      }
      if (q > 0) { tot.ranOff[i] += q; if (down[i] >= 0) inflow[down[i]] += q; }
    }
    // the day's water use and drainage
    for (let i = 0; i < N; i++) {
      const k = kinds[i];
      if (k === 2) continue;
      if (k === 3) { film[i] = Math.max(0, film[i] - et0); continue; }
      const etc = et0 * params.kc * shadeFactor(model.light ? model.light[i] : 1);
      // gravity water drains first, then the roots draw
      if (grav[i] > 0) {
        const rate = model.blocked[i] ? drainDay[i] * 0.05 : drainDay[i];
        const out = Math.min(grav[i] * params.drainShareMax, rate, grav[i]);
        grav[i] -= out; tot.drained[i] += out;
      }
      let use = etc;
      if (pond[i] > 0) { const e = Math.min(pond[i], use); pond[i] -= e; use -= e; tot.et[i] += e; }
      if (grav[i] > 0) { const e = Math.min(grav[i], use); grav[i] -= e; use -= e; tot.et[i] += e; }
      if (use > 0) {
        const ks = Dr[i] <= raw[i] ? 1 : Math.max(0, (taw[i] - Dr[i]) / Math.max(1e-6, taw[i] - raw[i]));
        const e = Math.min(use * ks, taw[i] - Dr[i]);
        Dr[i] += e; tot.et[i] += e;
      }
      if (inSeason) {
        if (grav[i] >= params.wetSat * satRoom[i] || pond[i] > 0) tot.wetDays[i]++;
        if (Dr[i] > raw[i]) tot.dryDays[i]++;
      }
    }
    if (inSeason) tot.seasonDays++;
    if (record) record(d, { Dr, grav, pond, month, inSeason, date: day.date });
  }
  return { ...tot, end: { Dr, grav, pond, film, snow } };
}

/**
 * Irrigation by cell: each lawn cell is watered back to field capacity (today's use included) on the
 * morning the day's use would take it past the readily available water (in season). The ideal, cell by cell: what each square metre would need.
 */
export function idealIrrigation(model) {
  const out = new Float32Array(model.N);
  return (d, st) => {
    if (!st.inSeason) return null;
    let any = false;
    out.fill(0);
    // watered the morning the day's use would take it past the readily available water
    for (let i = 0; i < model.N; i++) {
      if (model.kinds[i] !== 1) continue;
      const use = st.use * shadeFactor(model.light ? model.light[i] : 1);
      if (st.Dr[i] + use > model.raw[i]) { out[i] = st.Dr[i] + use; any = true; }
    }
    return any ? out : null;
  };
}

/**
 * Irrigation by zone: a zone is watered, all of it the same depth, on the day its average lawn cell has
 * passed its readily available water; the depth is the zone's average depletion. `zoneOf` per cell
 * (-1 not in a zone). `events` collects { d, zone, mm }.
 */
export function zoneIrrigation(model, zoneOf, nZones, events = []) {
  const out = new Float32Array(model.N);
  const cells = Array.from({ length: nZones }, () => []);
  for (let i = 0; i < model.N; i++) if (zoneOf[i] >= 0 && model.kinds[i] === 1) cells[zoneOf[i]].push(i);
  return (d, st) => {
    if (!st.inSeason) return null;
    let any = false;
    out.fill(0);
    for (let z = 0; z < nZones; z++) {
      const cs = cells[z];
      if (!cs.length) continue;
      let dr = 0, rw = 0, use = 0;
      for (const i of cs) { dr += st.Dr[i]; rw += model.raw[i]; use += st.use * shadeFactor(model.light ? model.light[i] : 1); }
      dr /= cs.length; rw /= cs.length; use /= cs.length;
      if (dr + use > rw) {
        dr += use; // refill to full, today's use included
        for (const i of cs) out[i] = dr;
        events.push({ d, zone: z, mm: dr });
        any = true;
      }
    }
    return any ? out : null;
  };
}
