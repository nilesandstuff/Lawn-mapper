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

import { KC, airShare, dayOfYear } from './et.js';
import { dayIndex } from './shade/climate.js';

export const PARAMS = {
  kc: KC,                 // the owner's grass coefficient (VISION.md), 0.8 for now
  p: 0.4,                 // FAO-56 Table 22 depletion fraction before stress: cool-season turf 0.4 (warm-season 0.5)
  roofLossMm: 0.5,        // a roof's first wetting, per rain day (first flush 10 gal per 1,000 sq ft = 0.41 mm, Texas manual)
  paveStoreMm: 1.0,       // concrete / blacktop film that does not run off and evaporates (measured 0.4-1 mm, Zhou 2021; ASCE 1992 table 1.3-2.5)
  cnLawn: { A: 39, B: 61, C: 74, D: 80 }, // TR-55 (USDA 1986), open space in good condition
  cnOther: { A: 49, B: 69, C: 79, D: 84 }, // TR-55, open space in fair condition (beds, bare edges)
  cnPaved: 98,
  cnPavers: { A: 76, B: 85, C: 89, D: 91 }, // brick or paver patio: TR-55's gravel, water getting through the joints
  deckShelter: 0.3,       // the ground under a deck dries at this share of the open lawn's rate (it is shaded and covered)
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
  /* HEAT OFF PAVING AND WALLS (owner 2026-10-18: "thermal effects of impervious surfaces"): turf beside
     hardscape uses about 5-11% more water at the edge, fading to under 5% by about 7 m, the
     afternoon-facing (south and west) side the strongest (Brown 2005; WUCOLS's 1.1-1.4 near south and
     southwest walls is expert judgement). An estimate, FINDINGS S8: up to edgeBoost at the edge, to
     nothing at edgeReachM, half as much from paving or a wall to the north or east of the grass. */
  edgeBoost: 0.08,
  edgeReachM: 7,
  /* Water running over the ground spreads to every lower neighbour, in proportion to the slope to the
     power 1.1 (Freeman 1991's multiple flow directions), not down one line: a downspout's water fans out. */
  spreadPower: 1.1,
  /* AT MOST TWO SOAK CYCLES A DAY (owner, 2026-10-20: "the soak cycle watering regimens that are prescribed
     should be limited to 2 per day"). A cycle puts down at most what the ground takes in an hour (a run,
     then an hour's soak), so a day's watering is at most cyclesPerDay times that: on slow ground a watering
     is smaller and comes more often. */
  cyclesPerDay: 2,
  /* SPRINKLERS WATER UNEVENLY: to give the driest quarter of a zone what it needs the zone gets more on
     average. The Irrigation Association's scheduling multiplier, 1 / (0.4 + 0.6 DU), on a lower-quarter
     distribution uniformity of 0.65, a typical home spray system (IA auditor figures: spray 0.65, rotors
     0.70; until the heads are mapped). The plan simulates what reaches the grass; what to put down is
     that times the multiplier. */
  duLq: 0.65,
  /* SHADE AND THE AIR (FINDINGS H43): the air's share of ET0 on a day without the weather to split it (Danielson &
     Feldhake 1981's figure; the owner's lot's summer averages 0.26); the most a full canopy within canopyRadiusM
     cools a sunny afternoon (Ziter et al. 2019: 0.7 C within 10 m, 1.3 within 30, over 1.5 within 60-90), the crowns
     the shade map's own (coverAround); a day as sunny as theirs at this
     share of clear-sky sunshine (their sampling days, summer afternoons, about 29 C). */
  airShare: 0.3,
  airCoolC: 1.3,
  /* THE YARD'S WIND (FINDINGS H44): Heisler 1990's neighbourhoods, cover counted within windRadiusM (his inner
     band, 0-91 m; clipped to the grid, which reaches 30 m past the lot), the share rounded to windStep. */
  /* A SPOT'S OWN RADIATION (FINDINGS H47): the visible light and the near-infrared apart. Leaves pass more of the
     near-infrared: a crown passing a share T of the visible passes T^nirExp of it (Campbell & Norman 1998's
     turbid medium gives 0.5; the oak-hickory floor's 1.8 times more shortwave than visible, Baldocchi et al. 1984,
     about 0.7-0.8; one single tree, Heisler et al. 2003, about 1). Turf reflects about 0.06 of the visible, 0.40 of
     the near-infrared (Bremer et al. 2011's bands; together FAO-56's 0.23 in the open). */
  nirExp: 0.8,
  albedoPar: 0.06,
  albedoNir: 0.40,
  windYard: true,
  windRadiusM: 90,
  windStep: 0.02,
  canopyRadiusM: 30,
  clearRef: 0.75,
};

/** What to put down for each mm the grass needs, sprinklers watering unevenly (PARAMS.duLq). */
export const schedulingMultiplier = (params = PARAMS) => 1 / (0.4 + 0.6 * params.duLq);

/** Warm-season turf (owner 2026-10-18: "warm season should be an option"): FAO-56 Table 22's p 0.5. */
export const WARM = { p: 0.5 };

const HYD = (h) => String(h || 'B').trim().toUpperCase();

/* SHADE (FINDINGS H43, 2026-10-26). Turf ET is linear in the sunlight it gets, down to what the air alone gives
   it with no sun at all (Danielson & Feldhake 1981, lysimeters under shade cloth). That floor is the air's part
   of the day's Penman-Monteith (et.js airShare): measured 2.1-2.5 mm/d in Fort Collins, where the equation gives
   2.4 on the same weeks' climate; it varies by day, about 26% of a Michigan summer day's and 16-41% day to day.
   So ET = ET_open x ((1 - s) x L + s x A): L the share of sunlight the cell gets, s the day's air share, and A
   what is left of the air's drying power where trees have cooled it (below). `shadeFactor` is that with s the
   default and no cooling: the factor for a day without the weather to split it. */
export const shadeFactor = (light, airShare = PARAMS.airShare) => airShare + (1 - airShare) * Math.max(0, Math.min(1, light));

/**
 * Within radiusM of each cell, the share of the ground under tree crowns and the share under buildings, BY THE SHADE
 * MAP'S OWN READING of every cell (owner, 2026-10-27: "you should follow the output of the shade map"): `kinds` as
 * its light worker returns them (seasonal.js: 0 open, 1 roof, 2 evergreen, 3 deciduous), on this same grid. Without
 * them (no shade worked out) no crowns, and the buildings are the water map's own walls. Each share is against the
 * cells within the radius on the grid (it reaches 30 m past the lot, so a wider radius is clipped to it).
 * -> { crown: Float32Array | null, built: Float32Array }
 */
export function coverAround(res, radiusM, kinds = null) {
  const g = res.grid, W = g.W, H = g.H, N = W * H;
  const S = (W + 1) * (H + 1);
  const crownS = new Float64Array(S), builtS = new Float64Array(S);
  for (let r = 0; r < H; r++) {
    let rc = 0, rb = 0;
    for (let c = 0; c < W; c++) {
      const i = r * W + c, k = kinds ? kinds[i] : 0;
      if (kinds ? k === 1 : res.wall?.[i]) rb++;
      else if (k === 2 || k === 3) rc++;
      const j = (r + 1) * (W + 1) + c + 1;
      crownS[j] = crownS[j - W - 1] + rc; builtS[j] = builtS[j - W - 1] + rb;
    }
  }
  // a square of the disc's area (half-side r x sqrt(pi)/2), clipped to the grid
  const h = Math.max(1, Math.round((radiusM * Math.sqrt(Math.PI)) / 2 / g.cell));
  const crown = kinds ? new Float32Array(N) : null, built = new Float32Array(N);
  const box = (A, r0, c0, r1, c1) => A[r1 * (W + 1) + c1] - A[r0 * (W + 1) + c1] - A[r1 * (W + 1) + c0] + A[r0 * (W + 1) + c0];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const r0 = Math.max(0, r - h), r1 = Math.min(H, r + h + 1), c0 = Math.max(0, c - h), c1 = Math.min(W, c + h + 1);
    const n = (r1 - r0) * (c1 - c0);
    if (crown) crown[r * W + c] = box(crownS, r0, c0, r1, c1) / n;
    built[r * W + c] = box(builtS, r0, c0, r1, c1) / n;
  }
  return { crown, built };
}

/** The share of the ground within PARAMS.canopyRadiusM of each cell under the shade map's tree crowns, or null. */
export const canopyAround = (res, kinds, params = PARAMS) => (kinds ? coverAround(res, params.canopyRadiusM, kinds).crown : null);

/**
 * THE YARD'S WIND, as a share of the open wind the weather gives (NASA POWER's matches the nearest major airport's,
 * FINDINGS H44): Heisler 1990 (ASHRAE Trans. 96(1), 15 houses, 2 m against the airport's 2 m, summer): the wind is
 * cut 100x / (24 + 1.1x) percent, x the percent of the ground within about 90 m under buildings and tree crowns
 * (buildings alone, 22%; 77% tree cover, 70%). x is held to the 0-90% his neighbourhoods spanned.
 */
export const windShare = (coverPct) => { const x = Math.max(0, Math.min(90, coverPct)); return 1 - x / (24 + 1.1 * x); };

/**
 * TODAY'S USE PER CELL, as a multiple of the open lawn's (fills `out`): heat and shelter (model.etBase), the
 * sunlight (light, or lightMonths[month]), the yard's wind (model.windAt, an index into model.winds), and the air -- the day's own share of
 * it, cooled near trees on a sunny day in the growing season by up to PARAMS.airCoolC at full cover within
 * canopyRadiusM (Ziter et al. 2019, Madison: 1.3 C cooler afternoons from no canopy to full within 30 m), the vapour
 * in it held (et.js airShare). part: airShare(day, ..., { winds: model.winds }), or null for a day without the
 * weather to split (then the default share, and the air's part cut by the wind as on a typical summer day).
 */
export function etToday(model, part, inSeason, out, month = null) {
  const { N, etBase, canopy, params } = model;
  // the month's own light when the shade map gave it by month (its leaves and its sun that month), else the summer's
  const light = model.lightMonths && month !== null ? model.lightMonths[month] : model.light;
  const winds = model.winds || [1], at = model.windAt;
  let sunRel = part?.sunRel, airRel = part?.airRel;
  if (!sunRel) {
    const s = part ? part.share : params.airShare;
    sunRel = winds.map(() => 1 - s);
    airRel = winds.map((f) => s * calmAir(f));
  }
  const sunny = part ? Math.min(1, part.clear / params.clearRef) : 0;
  const cool = canopy && inSeason && part ? part.perC * params.airCoolC * sunny : 0; // share lost at full cover
  /* A SPOT'S OWN RADIATION (H47): its visible and near-infrared sunlight, each through what stands over it, less
     what the turf reflects of each, less the open lawn's longwave loss to the sky in proportion to the sky it sees
     (trees and walls at about the air's temperature give back what the grass sends them, day and night). */
  const R = model.rad && month !== null && part?.light && part.kRel ? model.rad[month] : null;
  if (R) {
    const { rs, rnl, fd, fdPar } = part.light;
    const Bp = 0.5 * (1 - fdPar), Dp = 0.5 * fdPar, Bn = Math.max(0, 1 - fd - Bp), Dn = Math.max(0, fd - Dp);
    const aP = (1 - params.albedoPar) * rs, aN = (1 - params.albedoNir) * rs;
    for (let i = 0; i < N; i++) {
      const k = at ? at[i] : 0;
      const A = cool ? Math.max(0, 1 - cool * canopy[i]) : 1;
      const net = aP * (Bp * R.parB[i] + Dp * R.parD[i]) + aN * (Bn * R.nirB[i] + Dn * R.nirD[i]) - rnl * R.parD[i];
      out[i] = etBase[i] * Math.max(0, part.kRel[k] * net + airRel[k] * A);
    }
    return out;
  }
  for (let i = 0; i < N; i++) {
    const k = at ? at[i] : 0;
    const L = light ? Math.max(0, Math.min(1, light[i])) : 1;
    const A = cool ? Math.max(0, 1 - cool * canopy[i]) : 1;
    out[i] = etBase[i] * (sunRel[k] * L + airRel[k] * A);
  }
  return out;
}

/**
 * Each month's light per cell for a spot's own radiation (H47), from the shade map's beam and sky shares with the
 * trees (beam, sky) and with the buildings alone (beamB, skyB): the visible light as the shade map has it (it is
 * held to light measured under canopy), the near-infrared through the crowns' part as T^nirExp (T the crowns' own
 * visible share, beam / beamB), the buildings' part the same for both. -> [12 { parB, parD, nirB, nirD }]
 */
export function radiationModel({ beam, sky, beamB, skyB }, N, params = PARAMS) {
  const x = params.nirExp, fin = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);
  return beam.map((_, m) => {
    const parB = new Float32Array(N), parD = new Float32Array(N), nirB = new Float32Array(N), nirD = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const b = fin(beam[m][i]), d = fin(sky[m][i]), bb = Math.max(b, fin(beamB[m][i])), db = Math.max(d, fin(skyB[m][i]));
      parB[i] = b; parD[i] = d;
      nirB[i] = bb > 1e-4 ? bb * (b / bb) ** x : 0;
      nirD[i] = db > 1e-4 ? db * (d / db) ** x : 0;
    }
    return { parB, parD, nirB, nirD };
  });
}

/** The air's part of Penman-Monteith at a share f of a 2.3 m/s summer wind, against the open wind's, 25 C (the
    term is u / (delta + gamma (1 + 0.34 u))): for a day without the weather to recompute it. */
function calmAir(f) {
  const d = 0.189, gm = 0.0665, u = 2.3, uf = Math.max(0.5, u * f);
  return (uf / (d + gm * (1 + 0.34 * uf))) / (u / (d + gm * (1 + 0.34 * u)));
}

/** TR-55 curve number for a cell, dual groups read as drained (first letter) unless the water table is up. */
export function curveNumber(hydgrp, kind, wetTable, params = PARAMS) {
  let g = HYD(hydgrp);
  if (g.includes('/')) g = wetTable ? g.split('/')[1] : g.split('/')[0];
  g = 'ABCD'.includes(g[0]) ? g[0] : 'B';
  if (kind === 'paved') return params.cnPaved;
  if (kind === 'pavers') return params.cnPavers[g];
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
 * lightMonths  [12 Float32Array] the same share month by month (the shade map's worker: its leaves and sun that month), or null
 * radiation  { beam, sky, beamB, skyB }: 12 Float32Arrays each, from the shade map's worker -- the share of the
 *            sun's beam and of the sky each cell sees (the sky's share is its sky view), with the trees and with the
 *            buildings alone -- or null (H47)
 * shadeKinds  Uint8Array per cell from the shade map's light worker (0 open, 1 roof, 2 evergreen, 3 deciduous) or null
 */
export function buildModel(res, { kinds, soilAt, soils, roofTo, light = null, lightMonths = null, radiation = null, shadeKinds = null, params = PARAMS }) {
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

  // where surface water goes: every lower neighbour on the filled ground (no roofs), by slope^power
  const recv = new Int32Array(N * 8).fill(-1), share = new Float32Array(N * 8), nRecv = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (kinds[i] === 2) continue;
    const r = Math.floor(i / g.W), c = i % g.W;
    let tot = 0, n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
      const j = rr * g.W + cc;
      if (kinds[j] === 2) continue;
      const drop = (filled[i] - filled[j]) / (Math.hypot(dr, dc) * g.cell);
      if (drop <= 0) continue;
      const w = drop ** params.spreadPower;
      recv[i * 8 + n] = j; share[i * 8 + n] = w; tot += w; n++;
    }
    for (let k = 0; k < n; k++) share[i * 8 + k] /= tot;
    nRecv[i] = n;
  }
  // heat off paving and walls onto the grass beside them
  const heat = new Float32Array(N).fill(1);
  const reach = Math.ceil(params.edgeReachM / g.cell);
  if (params.edgeBoost > 0) for (let i = 0; i < N; i++) {
    if (kinds[i] !== 1) continue;
    const r = Math.floor(i / g.W), c = i % g.W;
    let best = 0;
    for (let rr = Math.max(0, r - reach); rr <= Math.min(g.H - 1, r + reach); rr++) for (let cc = Math.max(0, c - reach); cc <= Math.min(g.W - 1, c + reach); cc++) {
      const k = kinds[rr * g.W + cc];
      if (k !== 2 && k !== 3) continue;
      const d = Math.hypot(rr - r, cc - c) * g.cell;
      if (d > params.edgeReachM) continue;
      // row grows southward: the hot surface is to the south when rr > r, to the west when cc < c
      const sunSide = rr > r || cc < c ? 1 : 0.5;
      best = Math.max(best, params.edgeBoost * (1 - d / params.edgeReachM) * sunSide);
    }
    heat[i] = 1 + best;
  }

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
  /* what the grass in each cell uses, as a multiple of the open lawn's: etBase is the heat (and, from plan.js, a
     deck's shelter); etFactor the day without a weather split, for the planning before a run; simulate works out
     each day's own (etToday) */
  const etBase = Float32Array.from(heat);
  const canopy = canopyAround(res, shadeKinds, params);
  // the yard's wind per cell, in steps of windStep (each step's day worked out once a day in simulate)
  let winds = [1], windAt = null;
  const wc = params.windYard ? coverAround(res, params.windRadiusM, shadeKinds) : null;
  if (wc) {
    const step = params.windStep, idx = new Map();
    windAt = new Uint8Array(N); winds = [];
    for (let i = 0; i < N; i++) {
      const f = Math.round(windShare(100 * ((wc.crown ? wc.crown[i] : 0) + wc.built[i])) / step) * step;
      if (!idx.has(f)) { idx.set(f, winds.length); winds.push(f); }
      windAt[i] = idx.get(f);
    }
  }
  const model = { g, N, kinds, soilAt, soils, roofTo, light, lightMonths: lightMonths?.length === 12 ? lightMonths : null, canopy, winds, windAt, order, down, recv, share, nRecv, slope, pondCap, taw, raw, satRoom, drainDay, heat, etBase, params };
  model.rad = radiation ? radiationModel(radiation, N, params) : null;
  model.etFactor = etToday(model, null, false, new Float32Array(N));
  return model;
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
  const { N, kinds, order, recv, share, nRecv, roofTo, slope, pondCap, taw, raw, satRoom, drainDay, soils, soilAt, params } = model;
  const etFactor = new Float32Array(N), lat = model.g?.lat ?? 42.5;
  const Dr = start?.Dr ? Float32Array.from(start.Dr) : new Float32Array(N);
  const grav = new Float32Array(N), pond = new Float32Array(N), film = new Float32Array(N);
  const tot = { irrigation: new Float32Array(N), et: new Float32Array(N), drained: new Float32Array(N), ranOff: new Float32Array(N), ranOn: new Float32Array(N), wetDays: new Uint16Array(N), dryDays: new Uint16Array(N), seasonDays: 0, rain: 0 };
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
        const kind = kinds[i] === 1 ? 'lawn' : kinds[i] === 3 ? 'paved' : kinds[i] === 4 ? 'pavers' : 'other';
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
    etToday(model, et0 > 0 ? airShare(day, lat, dayOfYear(day.date), 200, { winds: model.winds }) : null, inSeason, etFactor, month);
    const irr = irrigate ? irrigate(d, { Dr, grav, month, inSeason, date: day.date, use: et0 * params.kc, etFactor }) : null;

    inflow.fill(0);
    // roofs
    const roofQ = Math.max(0, P - params.roofLossMm);
    if (roofQ > 0) for (let i = 0; i < N; i++) if (kinds[i] === 2 && roofTo[i] >= 0) inflow[roofTo[i]] += roofQ;
    // the ground, uphill first
    for (const i of order) {
      const add = irr ? irr[i] || 0 : 0;
      if (add) tot.irrigation[i] += add;
      tot.ranOn[i] += inflow[i];
      let w = P + inflow[i] + pond[i];
      pond[i] = 0;
      let q;
      if (kinds[i] === 3) {
        const take = Math.min(w, params.paveStoreMm - film[i]);
        film[i] += take; q = w - take;
      } else {
        q = scsRunoff(w, cn[i]);
        /* THE RATE (weather.js addRainHours): on a day whose hours are known, rain falling faster than this ground
           takes it in runs off even where the day's total would not (Horton's infiltration excess) -- the larger
           of the two is taken. The ground's rate is the one the cycle-and-soak advice uses (soil.js
           maxSprinklerRate: the survey's intake, the soil's texture and the slope). */
        if (day.hours && model.intakeMmH && P > 0) {
          const f = model.intakeMmH[i];
          let excess = 0;
          for (const h of day.hours) if (h > f) excess += h - f;
          // its own rain only (water running on from uphill comes as the day's sum, without hours)
          if (excess > q) q = Math.min(w, excess);
        }
        let inf = w - q + add;
        const room = Dr[i] + (satRoom[i] - grav[i]);
        if (inf > room) { q += inf - room; inf = room; }
        Dr[i] -= inf;
        if (Dr[i] < 0) { grav[i] += -Dr[i]; Dr[i] = 0; }
        if (q > 0 && pondCap[i] > 0) { const hold = Math.min(q, pondCap[i]); pond[i] = hold; q -= hold; }
      }
      if (q > 0) { tot.ranOff[i] += q; for (let k = 0; k < nRecv[i]; k++) inflow[recv[i * 8 + k]] += q * share[i * 8 + k]; }
    }
    // the day's water use and drainage
    for (let i = 0; i < N; i++) {
      const k = kinds[i];
      if (k === 2) continue;
      if (k === 3) { film[i] = Math.max(0, film[i] - et0); continue; }
      const etc = et0 * params.kc * etFactor[i];
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
  const cap = model.dayCapMm;
  return (d, st) => {
    if (!st.inSeason) return null;
    let any = false;
    out.fill(0);
    // watered the morning the day's use would take it past the readily available water, back to full -- or
    // as far as a day's soak cycles go (PARAMS.cyclesPerDay), so slow ground is watered again sooner while
    // the root zone keeps its room for rain
    for (let i = 0; i < model.N; i++) {
      if (model.kinds[i] !== 1) continue;
      const use = st.use * (st.etFactor || model.etFactor)[i];
      const most = cap ? cap[i] : Infinity;
      if (st.Dr[i] + use > model.raw[i]) { out[i] = Math.min(st.Dr[i] + use, most); any = true; }
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
  // the most a day's watering can put down on the zone: what its slowest-taking tenth allows
  const caps = cells.map((cs) => {
    if (!model.dayCapMm || !cs.length) return Infinity;
    const v = cs.map((i) => model.dayCapMm[i]).sort((a, b) => a - b);
    return v[Math.floor(0.1 * (v.length - 1))];
  });
  return (d, st) => {
    if (!st.inSeason) return null;
    let any = false;
    out.fill(0);
    for (let z = 0; z < nZones; z++) {
      const cs = cells[z];
      if (!cs.length) continue;
      let dr = 0, rw = 0, use = 0;
      for (const i of cs) { dr += st.Dr[i]; rw += model.raw[i]; use += st.use * (st.etFactor || model.etFactor)[i]; }
      dr /= cs.length; rw /= cs.length; use /= cs.length;
      if (dr + use > rw) {
        dr = Math.min(dr + use, caps[z]); // refill to full, today's use included, or as far as a day's cycles go
        for (const i of cs) out[i] = dr;
        events.push({ d, zone: z, mm: dr });
        any = true;
      }
    }
    return any ? out : null;
  };
}
