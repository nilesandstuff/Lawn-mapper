/**
 * THE HEAT VIEW (water session; owner, 2026-11-07: "a view that represents the overall push and pull of the various
 * factors that affect soil temps and air temps... You can show air and heat seperately if you have to").
 *
 * Nothing new is modelled here: this reads out, spot by spot, the energy terms the daily balance already uses
 * (balance.js etToday, H43-H49), for a typical day of one month (the ten years' days of that month, averaged), and
 * sets each against the OPEN LAWN -- full sun, full sky, no fence, no paving near -- so warmer and cooler mean warmer
 * or cooler than open lawn on the same day.
 *
 * THE GROUND (W/m2, the 24-hour mean; what pushes the surface and so the soil under it warmer or cooler):
 *   sun     the visible and near-infrared sunlight the spot gets through what stands over it, less what turf reflects
 *           of each (H47), less the open lawn's (1 - 0.23) of the day's sunshine
 *   sky     the longwave heat the spot loses to the sky, day and night, in proportion to the sky it sees; FAO-56's
 *           net longwave (eq. 39), which falls as the air gets damper (its vapour pressure) and as it clouds over
 *           (the day's sunshine against a clear day's) -- less sky seen is less heat lost, so it counts warm here
 *   fence   a fence's sunlit boards, warmer than the air, and the sky it fills (H49)
 *   paving  the heat off paving and walls onto the grass beside them (S8, PARAMS.edgeBoost), as the extra water it
 *           drives off, turned into energy (2.45 MJ per kg)
 *   net     their sum
 * NIGHT: the loss to the sky alone, W/m2, as the spot's own (not against the open lawn): FAO-56 gives one net
 * longwave for the day, so night and day lose at about the same rate; the open spots lose the most (frost and dew
 * come there first).
 * THE AIR (C, a sunny afternoon of the month in the growing season): the cooling the trees round a spot give its air,
 * up to PARAMS.airCoolC at full canopy within PARAMS.canopyRadiusM (Ziter et al. 2019; H43), scaled by how sunny
 * the month's days are. The model holds the air the same everywhere else: no warmer air over paving, none from a
 * sheltered corner (wind changes the drying, not the temperature, in this model).
 * NOT MODELLED: the soil's own temperature spot by spot. The roots use the area's measured soil temperature (IEMRE,
 * H41); the ground budget here is what would push it up or down from that, not a temperature.
 */

import { airShare, pmParts, dayOfYear } from './et.js';
import { simulate } from './balance.js';

export const W_PER_MJ = 1e6 / 86400; // 1 MJ/m2 a day as a 24-hour mean, W/m2
const LAMBDA = 2.45; // MJ per kg of water evaporated (FAO-56)
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** The month's typical day: the means of the ten years' days in it. -> null without enough weather. */
export function monthWeather(days, month, lat, elevM = 200) {
  const acc = { n: 0, rs: 0, rnl: 0, fd: 0, fdPar: 0, clear: 0, et0: 0, tmax: 0, tmin: 0, ea: 0, rh: 0, wind: 0 };
  for (const d of days || []) {
    if (!d?.date || Number(d.date.slice(5, 7)) - 1 !== month) continue;
    const part = airShare(d, lat, dayOfYear(d.date), elevM);
    if (!part?.light) continue;
    const a = pmParts(d, lat, dayOfYear(d.date), elevM);
    acc.n++; acc.rs += part.light.rs; acc.rnl += part.light.rnl; acc.fd += part.light.fd; acc.fdPar += part.light.fdPar;
    acc.clear += part.clear; acc.et0 += a.et0; acc.tmax += d.tmax; acc.tmin += d.tmin; acc.ea += a.ea; acc.rh += d.rh; acc.wind += d.wind;
  }
  if (!acc.n) return null;
  const out = { days: acc.n };
  for (const k of Object.keys(acc)) if (k !== 'n') out[k] = acc[k] / acc.n;
  return out;
}

/**
 * One month's heat, spot by spot. model: balance.js buildModel's (its rad, fenceHeat, canopy, edgeHeat, params);
 * days: the plan's typical days; month 0-11; season: the plan's Set of day indices, or null (then in season).
 * -> { month, weather, inSeason, sunny, ground: { sun, sky, fence, paving, net } (Float32Array W/m2 against open
 *    lawn), night (W/m2 lost to the sky, the spot's own), air (C, negative = cooler), open: { sun, sky } } or null
 */
export function heatOfMonth(model, days, month, { season = null, elevM = 200 } = {}) {
  const { N, params } = model, lat = model.g?.lat ?? 42.5;
  const w = monthWeather(days, month, lat, elevM);
  if (!w) return null;
  const R = model.rad ? model.rad[month] : null;
  const light = model.lightMonths ? model.lightMonths[month] : model.light;
  const FH = model.fenceHeat, fb = FH ? FH.beam[month] : null, fRefl = FH ? FH.reflSky : null, fSky = FH ? (FH.skyM ? FH.skyM[month] : FH.sky) : null;
  const { rs, rnl, fd, fdPar } = w;
  const Bp = 0.5 * (1 - fdPar), Dp = 0.5 * fdPar, Bn = Math.max(0, 1 - fd - Bp), Dn = Math.max(0, fd - Dp);
  const aP = (1 - params.albedoPar) * rs, aN = (1 - params.albedoNir) * rs;
  const sunOpen = aP * (Bp + Dp) + aN * (Bn + Dn); // the open lawn's absorbed sunshine (Bp+Dp = Bn+Dn = 0.5)
  const beamMJ = rs * (1 - fd), skyMJ = rs * fd;
  const edge = model.edgeHeat || null;
  const edgeMJ = LAMBDA * (params.kc ?? 0.8) * w.et0; // what one whole extra open-lawn day's water would take
  const sun = new Float32Array(N), sky = new Float32Array(N), fence = new Float32Array(N), paving = new Float32Array(N), net = new Float32Array(N), night = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = R ? aP * (Bp * R.parB[i] + Dp * R.parD[i]) + aN * (Bn * R.nirB[i] + Dn * R.nirD[i]) : sunOpen * Math.max(0, Math.min(1, light ? light[i] : 1));
    const view = R ? (FH ? Math.max(0, R.parD[i] - fRefl[i]) : R.parD[i]) : 1;
    sun[i] = (s - sunOpen) * W_PER_MJ;
    sky[i] = rnl * (1 - view) * W_PER_MJ; // less sky seen: less lost than the open lawn
    fence[i] = FH ? (beamMJ * fb[i] + skyMJ * fSky[i]) * W_PER_MJ : 0;
    paving[i] = edge ? (edge[i] - 1) * edgeMJ * W_PER_MJ : 0;
    net[i] = sun[i] + sky[i] + fence[i] + paving[i];
    night[i] = rnl * view * W_PER_MJ;
  }
  // the air: trees' cooling of a sunny afternoon, in the growing season (balance.js etToday's own terms)
  const mid = MONTH_START[month] + 14;
  const inSeason = season ? season.has(mid) : true;
  const sunny = Math.min(1, w.clear / params.clearRef);
  const air = new Float32Array(N);
  if (model.canopy) for (let i = 0; i < N; i++) air[i] = -params.airCoolC * model.canopy[i] * sunny;
  return { month, weather: { ...w, rsW: rs * W_PER_MJ, rnlW: rnl * W_PER_MJ }, inSeason, sunny, ground: { sun, sky, fence, paving, net }, night, air, open: { sun: sunOpen * W_PER_MJ, sky: rnl * W_PER_MJ } };
}

/*
 * THE SURFACE'S OWN TEMPERATURE (owner, 2026-11-07: "add the surface model"; with "wind, how wet the ground is,
 * angled slopes to and away from sun, pavers"). An ESTIMATE: textbook surface energy balance, nothing here measured
 * against a thermometer (S28). For each lawn square, two moments of a typical day of the month:
 *
 *   A SUNNY AFTERNOON (the day's peak sun, the air at the month's mean high, less the shade's cooling of it):
 *     Rn = the sunshine the spot absorbs at the peak (the day's total shared out as a half-sine over the day length:
 *          peak = total x pi / (2 x day length); its share through what stands over it and on its own slope, H47)
 *          - the loss to the sky (FAO-56's net longwave, in proportion to the sky seen)
 *          + a fence's sunlit boards and the paving's heat, scaled to the peak the same way
 *     G  = 0.1 Rn into the ground (FAO-56's hourly daytime soil heat)
 *     LE = Ks x 1.26 x D/(D+g) x (Rn - G): the water the grass gives off, as Priestley & Taylor (1972) give it for
 *          well-watered grass, cut by the plan's water-stress coefficient Ks (FAO-56 eq. 84) where the root zone
 *          is drier than its readily available water -- dry grass cannot spend the sun on evaporation, so it heats
 *     what is left warms the air over it, carried off by the wind:
 *     Ts - Ta = (Rn - G - LE) / (rho cp / ra + 4 e s Ta^3)
 *          ra = 208 / u2 s/m, FAO-56's aerodynamic resistance of clipped grass at u2 m/s, u2 the month's mean open
 *          wind times the spot's own share of it (the wind view, H50), at least 0.5 m/s; the second term is the
 *          surface's own extra longwave as it warms (the linearised Stefan-Boltzmann law, e = 0.98)
 *   BEFORE DAWN (the air at the month's mean low; no sun, no evaporation):
 *     Rn = - the loss to the sky (FAO-56's net longwave: smaller in damp air and under cloud), in proportion to the
 *          sky seen; G = 0.5 Rn (FAO-56's hourly night soil heat: the ground gives back half of what is lost)
 *     Ts - Ta = (Rn - G) / (rho cp / ra + 4 e s Ta^3): a calm, open spot cools the most
 *
 * NOT IN IT: hour-by-hour sun and shade (the spot's share is the day's, so a spot shaded only in the morning reads
 * as partly shaded at the afternoon peak too); heat stored in paving and given back at night; dew; the wind's own
 * fall at night (the day's mean wind is used); the grass's height. The air over each spot is the month's mean high
 * or low, less the shade's afternoon cooling: the model has no warmer air over paving.
 */
const SIGMA = 5.67e-8, EMIS = 0.98, RHO_CP = 1.2 * 1005; // W/m2/K4; turf's emissivity; J/m3/K
const satSlope = (t) => (4098 * 0.6108 * Math.exp((17.27 * t) / (t + 237.3))) / (t + 237.3) ** 2; // kPa/C (FAO-56 eq. 13)
/** day length, hours, at latitude lat on day of year J (FAO-56 eqs. 24, 25, 34) */
export function dayLength(lat, J) {
  const phi = (lat * Math.PI) / 180, dec = 0.409 * Math.sin((2 * Math.PI * J) / 365 - 1.39);
  return (24 / Math.PI) * Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec))));
}

/**
 * The surface temperatures of a month (C), from heatOfMonth's terms (h) and the plan's model.
 * ks: Float32Array per cell, the month's mean water-stress coefficient (1 = not short of water), or null (all 1).
 * -> { day, night (Float32Array C), ta: { day, night }, open: { day, night } (open, level, watered lawn in the open
 *      wind), peakW (the peak sunshine on open level ground), wind (Float32Array: each spot's share of the open wind) }
 */
export function surfaceOfMonth(model, h, { ks = null, elevM = 200 } = {}) {
  const { N } = model, w = h.weather, month = h.month;
  const lat = model.g?.lat ?? 42.5, J = MONTH_START[month] + 15;
  const hours = dayLength(lat, J);
  const peakOver = hours > 0 ? (24 * Math.PI) / (2 * hours) : 0; // the half-sine peak against the 24-hour mean
  const P = 101.3 * ((293 - 0.0065 * elevM) / 293) ** 5.26, gamma = 0.000665 * P;
  const winds = model.winds || [1], at = model.windAtMonths ? model.windAtMonths[month] : model.windAt;
  const u2 = Number.isFinite(w.wind) ? w.wind : 2;
  const taD = w.tmax, taN = w.tmin;
  const kD = 4 * EMIS * SIGMA * (taD + 273.15) ** 3, kN = 4 * EMIS * SIGMA * (taN + 273.15) ** 3;
  const sky = w.rnl * W_PER_MJ; // the open lawn's net longwave loss, W/m2
  const sunOpenPeak = h.open.sun * peakOver;
  const day = new Float32Array(N), night = new Float32Array(N), wind = new Float32Array(N);
  const one = (absorbedPeak, skyView, extraPeak, windF, k, ta, air) => {
    const ra = 208 / Math.max(0.5, u2 * windF);
    const t = ta + air, kd = 4 * EMIS * SIGMA * (t + 273.15) ** 3;
    const Rn = absorbedPeak - sky * skyView + extraPeak, G = 0.1 * Rn;
    const D = satSlope(t), LE = Math.max(0, k * 1.26 * (D / (D + gamma)) * Math.max(0, Rn - G));
    const d = t + (Rn - G - LE) / (RHO_CP / ra + kd);
    const Rnn = -sky * skyView, Gn = 0.5 * Rnn;
    const n = taN + (Rnn - Gn) / (RHO_CP / ra + kN);
    return [d, n];
  };
  for (let i = 0; i < N; i++) {
    const f = winds[at ? at[i] : 0] ?? 1;
    wind[i] = f;
    const absorbed = (h.open.sun + h.ground.sun[i]) * peakOver; // the spot's own sunshine at the peak
    const skyView = 1 - h.ground.sky[i] / Math.max(1e-6, sky); // sky term = sky x (1 - view)
    const extra = (h.ground.fence[i] + h.ground.paving[i]) * peakOver;
    const [d, n] = one(absorbed, skyView, extra, f, ks ? ks[i] : 1, taD, h.air[i] || 0);
    day[i] = d; night[i] = n;
  }
  const [od, on] = one(sunOpenPeak, 1, 0, 1, 1, taD, 0);
  return { day, night, wind, ta: { day: taD, night: taN }, open: { day: od, night: on }, peakW: sunOpenPeak, hours, wind2: u2, kD, kN };
}

/**
 * HOW WET THE GROUND IS, month by month (for the surface model's evaporation): the plan's own ten years with rain
 * alone, each lawn square's water-stress coefficient Ks averaged over each month's days (FAO-56 eq. 84: 1 while the
 * root zone holds its readily available water, falling to 0 at the wilting point). -> [12 Float32Array]
 */
export function stressByMonth(model, days, { season = null } = {}) {
  const { N } = model;
  const sum = Array.from({ length: 12 }, () => new Float32Array(N)), n = new Uint16Array(12);
  simulate(model, days, { season, record: (d, st) => {
    const m = Number(days[d].date.slice(5, 7)) - 1;
    if (!(m >= 0 && m < 12)) return;
    n[m]++;
    const s = sum[m];
    for (let i = 0; i < N; i++) {
      const taw = model.taw[i], raw = model.raw[i], Dr = st.Dr[i];
      s[i] += Dr <= raw || !(taw > raw) ? 1 : Math.max(0, (taw - Dr) / (taw - raw));
    }
  } });
  return sum.map((s, m) => (n[m] ? Float32Array.from(s, (v) => v / n[m]) : new Float32Array(N).fill(1)));
}

