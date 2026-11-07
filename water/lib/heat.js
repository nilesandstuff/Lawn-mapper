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

export const W_PER_MJ = 1e6 / 86400; // 1 MJ/m2 a day as a 24-hour mean, W/m2
const LAMBDA = 2.45; // MJ per kg of water evaporated (FAO-56)
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** The month's typical day: the means of the ten years' days in it. -> null without enough weather. */
export function monthWeather(days, month, lat, elevM = 200) {
  const acc = { n: 0, rs: 0, rnl: 0, fd: 0, fdPar: 0, clear: 0, et0: 0, tmax: 0, tmin: 0, ea: 0, rh: 0 };
  for (const d of days || []) {
    if (!d?.date || Number(d.date.slice(5, 7)) - 1 !== month) continue;
    const part = airShare(d, lat, dayOfYear(d.date), elevM);
    if (!part?.light) continue;
    const a = pmParts(d, lat, dayOfYear(d.date), elevM);
    acc.n++; acc.rs += part.light.rs; acc.rnl += part.light.rnl; acc.fd += part.light.fd; acc.fdPar += part.light.fdPar;
    acc.clear += part.clear; acc.et0 += a.et0; acc.tmax += d.tmax; acc.tmin += d.tmin; acc.ea += a.ea; acc.rh += d.rh;
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
