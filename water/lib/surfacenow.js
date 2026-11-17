/**
 * THE SURFACE AT THIS MINUTE (owner, 2026-11-15: thermal walks with the Yard AR app, "take ground truth measurements
 * to verify the surface temperature predictions of the water model"). An ESTIMATE, as heat.js's month model is, and
 * the same physics; what changes is that every input is the moment's own instead of a typical day's:
 *
 *   the sun       where it stands at that minute (the shade map's sun.js), and the direct beam's share reaching the
 *                 grass at that spot at that minute through what stands over it, the canopy as it stood that day
 *                 (the shade map's light worker, 'samples'), instead of the day's mean share
 *   sunshine      the measured global horizontal irradiance at that minute when a source has it, else the clear sky
 *                 (sun.js clearSky) dimmed by the cloud (Kasten & Czeplak 1980: x (1 - 0.75 c^3.4)); split into beam
 *                 and sky by Erbs et al. (1982) from how clear it is against the top of the atmosphere
 *   the sky       the downwelling longwave from the air's temperature and vapour (Brutsaert 1975's clear-sky
 *                 emissivity) and the cloud fraction (Crawford & Duchon 1999: cloud radiates as a black body at the
 *                 air's temperature); what the spot does not see of the sky (crowns, walls) radiates at the air's
 *                 temperature. The thermal walk's sky sweep is an 8-14 um brightness, NOT this: it gives the cloud
 *                 fraction only (the thermal session's correction, 2026-11-15).
 *   air, wind     the moment's air temperature, humidity and open wind at 2 m, the wind cut by the spot's own
 *                 shelter (H50) for the month
 *
 * Per lawn cell, linearised about the air temperature Ta (as heat.js):
 *   SW  = (1 - aPAR) x (beam x T + sky x Dpar) / 2 + (1 - aNIR) x (beam x T^nirExp + sky x Dnir) / 2
 *         beam, sky: the horizontal beam and diffuse irradiance; T the beam's share through the canopy at that
 *         minute; Dpar, Dnir the month's diffuse shares (sky view through the crowns, H47)
 *   Rn* = SW + e (V Lsky + (1 - V) s Ta^4 - s Ta^4) + fence + paving      (the net radiation were the surface at Ta)
 *   G   = 0.1 Rn* with the sun up, 0.5 Rn* with it down (FAO-56's hourly soil heat)
 *   LE  = Ks x 1.26 x D/(D+g) x (Rn* - G) with the sun up (Priestley & Taylor 1972), 0 with it down (no dew)
 *   Ts - Ta = (Rn* - G - LE) / (rho cp / ra + 4 e s Ta^3),   ra = 208 / u2 (FAO-56's clipped grass), u2 >= 0.5 m/s
 *
 * NOT IN IT: the ground's slope for the beam at that minute (the beam is taken on level ground; the month model has
 * the slope, H81, and this lawn is mostly level); heat stored in the soil from the hours before (the grass surface
 * follows the sun within minutes, the soil under it does not); dew; a stable night's still air (ra is the neutral
 * one); warmer air over paving.
 */

import { sunAt, clearSky, SOLAR_CONSTANT } from './shade/sun.js';

/** Kept with every comparison (src/truth.js truth_results): change it whenever the model's arithmetic changes, so
 *  the walks already scored can be scored again and the versions compared. */
export const MODEL_VERSION = 'surface-now 2, soil columns (2026-11-17)';
/* WHAT A WALK'S RESULT CARRIES, apart from the model (a walk whose result is older is scored again, with no change of
   model): 1, the scores; 2 (2026-11-17), the same walk scored again with the station's air in place of the walker's
   (the owner: "we should score it both ways... the prediction can't be any more accurate than the station's"). */
export const SCORING = 2;
/* version 1 (2026-11-15): G as a share of Rn (FAO-56 hourly), no heat stored in the ground. Version 2: each spot's own
   soil column, spun up over the weeks before (lib/soiltemp.js, FINDINGS H92); version 1 stays as surfaceNowAt for a
   walk with no hourly weather to spin up from. */

const SIGMA = 5.67e-8, EMIS = 0.98, RHO_CP = 1.2 * 1005;
const RAD = Math.PI / 180;
const satVp = (t) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3)); // kPa (FAO-56 eq. 11)
const satSlope = (t) => (4098 * satVp(t)) / (t + 237.3) ** 2; // kPa/C (FAO-56 eq. 13)

/** Global horizontal irradiance and its split into beam and sky (W/m2) with the sun at `el` degrees.
 *  ghi: measured, or null to take the clear sky dimmed by `cloud` (0-1; null = clear). R: Earth-sun distance, AU. */
export function sunshineNow(el, { ghi = null, cloud = null, R = 1, heightM = 200 } = {}) {
  if (!(el > 0)) return { ghi: 0, beam: 0, sky: 0, kt: 0, from: 'night' };
  const clear = clearSky(el, heightM, R).ghi;
  const c = Number.isFinite(cloud) ? Math.max(0, Math.min(1, cloud)) : 0;
  const g = Number.isFinite(ghi) ? Math.max(0, ghi) : clear * (1 - 0.75 * c ** 3.4);
  const top = (SOLAR_CONSTANT / (R * R)) * Math.sin(el * RAD);
  const kt = top > 0 ? Math.min(1, g / top) : 0;
  // Erbs et al. (1982): the diffuse fraction from the clearness index
  const fd = kt <= 0.22 ? 1 - 0.09 * kt : kt <= 0.8 ? 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4 : 0.165;
  return { ghi: g, beam: g * (1 - fd), sky: g * fd, kt, clear, from: Number.isFinite(ghi) ? 'measured' : Number.isFinite(cloud) ? 'clear sky and cloud' : 'clear sky' };
}

/** Downwelling longwave from the sky, W/m2: Brutsaert (1975) clear, Crawford & Duchon (1999) cloud. */
export function skyLongwave(ta, rh, cloud = 0) {
  const T = ta + 273.15, ea = (satVp(ta) * Math.max(1, Math.min(100, rh))) / 100; // kPa
  const eClear = 1.24 * ((ea * 10) / T) ** (1 / 7); // ea in hPa
  const c = Number.isFinite(cloud) ? Math.max(0, Math.min(1, cloud)) : 0;
  return (c + (1 - c) * eClear) * SIGMA * T ** 4;
}

/**
 * The weather of one moment, made whole: { t (ms), lat, lng, ta (C), rh (%), wind (m/s at 2 m, open), ghi?, cloud? }
 * -> { el, az, ...sunshineNow, lsky, ta, rh, wind, cloud }
 */
export function momentOf({ t, lat, lng, ta, rh, wind, ghi = null, cloud = null, heightM = 200 }) {
  const s = sunAt(lat, lng, t);
  const sun = sunshineNow(s.elevation, { ghi, cloud, R: s.R, heightM });
  /* the cloud for the sky's longwave: as given; else, by day, from how far the sunshine falls short of the clear
     sky (Kasten & Czeplak inverted); else none */
  let c = Number.isFinite(cloud) ? cloud : null;
  if (c === null && Number.isFinite(ghi) && sun.clear > 50) c = Math.max(0, Math.min(1, ((1 - ghi / sun.clear) / 0.75) ** (1 / 3.4)));
  return { el: s.elevation, az: s.azimuth, ...sun, cloud: c ?? 0, cloudFrom: Number.isFinite(cloud) ? 'given' : c === null ? 'none (clear assumed)' : 'from the sunshine', lsky: skyLongwave(ta, rh, c ?? 0), ta, rh, wind: Number.isFinite(wind) ? wind : 2 };
}

/**
 * One lawn cell's surface temperature at a moment. model: balance.js buildModel's; i: the cell; T: the direct beam's
 * share reaching it at that minute (0-1, the light worker's 'samples'); w: momentOf's; month 0-11 (for the diffuse
 * shares, the wind's shelter, the fences); ks: the cell's water-stress coefficient (1 = not short of water).
 * -> { ts, dT (Ts - Ta), parts: { sw, lw, fence, paving, rn, g, le } (W/m2), u2 }
 */
export function surfaceNowAt(model, i, T, w, { month, ks = 1, elevM = 200 } = {}) {
  const params = model.params;
  const R = model.rad ? model.rad[month] : null;
  const Dpar = R ? R.parD[i] : 1, Dnir = R ? R.nirD[i] : 1;
  const FH = model.fenceHeat;
  const V = R ? (FH ? Math.max(0, R.parD[i] - FH.reflSky[i]) : R.parD[i]) : 1; // the sky the grass sees (as heat.js)
  const tb = Math.max(0, Math.min(1, Number.isFinite(T) ? T : 1));
  const sw = (1 - params.albedoPar) * 0.5 * (w.beam * tb + w.sky * Dpar) + (1 - params.albedoNir) * 0.5 * (w.beam * tb ** params.nirExp + w.sky * Dnir);
  const Ta = w.ta, Tk = Ta + 273.15, bb = SIGMA * Tk ** 4;
  const lw = EMIS * (V * w.lsky + (1 - V) * bb - bb);
  const fence = FH ? w.beam * FH.beam[month][i] + w.sky * (FH.skyM ? FH.skyM[month][i] : FH.sky[i]) : 0;
  const up = w.el > 0;
  const P = 101.3 * ((293 - 0.0065 * elevM) / 293) ** 5.26, gamma = 0.000665 * P, D = satSlope(Ta);
  const pt = (rn) => 1.26 * (D / (D + gamma)) * Math.max(0, rn);
  // the paving's heat as heat.js has it: its extra share of an open lawn's water use, turned into energy
  const edge = model.edgeHeat ? model.edgeHeat[i] : 1;
  const openRn = (1 - params.albedoPar) * 0.5 * (w.beam + w.sky) + (1 - params.albedoNir) * 0.5 * (w.beam + w.sky) + EMIS * (w.lsky - bb);
  const paving = up ? (edge - 1) * (params.kc ?? 0.8) * pt(0.9 * openRn) : 0;
  const rn = sw + lw + fence + paving;
  const g = (up ? 0.1 : 0.5) * rn;
  const le = up ? Math.max(0, Math.min(1, ks)) * pt(rn - g) : 0;
  const winds = model.winds || [1], at = model.windAtMonths ? model.windAtMonths[month] : model.windAt;
  const u2 = Math.max(0.5, w.wind * (winds[at ? at[i] : 0] ?? 1));
  const ra = 208 / u2;
  // the trees' cooling of the air beside them on a sunny day (H43), scaled by how sunny the moment is
  const sunny = up && w.clear > 0 ? Math.min(1, w.ghi / w.clear / (params.clearRef || 0.75)) : 0;
  const air = model.canopy ? -params.airCoolC * model.canopy[i] * sunny : 0;
  const t = Ta + air, kd = 4 * EMIS * SIGMA * (t + 273.15) ** 3;
  const dT = air + (rn - g - le) / (RHO_CP / ra + kd);
  return { ts: Ta + dT, dT, parts: { sw, lw, fence, paving, rn, g, le }, u2, air };
}

/**
 * THE MOMENT'S ENERGY AT ONE SPOT, without the ground's part (for the soil columns, lib/soiltemp.js): the same terms
 * surfaceNowAt uses. -> { swNet, rnIso (net radiation were the skin at the local air's temperature, fences and paving
 * in), ta (the local air: the trees' cooling in), ra, beta (Ks x Priestley-Taylor's share by day, 0 by night), u2 }
 */
export function forcingAt(model, i, T, w, { month, ks = 1, elevM = 200 } = {}) {
  const params = model.params;
  const R = model.rad ? model.rad[month] : null;
  const Dpar = R ? R.parD[i] : 1, Dnir = R ? R.nirD[i] : 1;
  const FH = model.fenceHeat;
  const V = R ? (FH ? Math.max(0, R.parD[i] - FH.reflSky[i]) : R.parD[i]) : 1;
  const tb = Math.max(0, Math.min(1, Number.isFinite(T) ? T : 1));
  const swNet = (1 - params.albedoPar) * 0.5 * (w.beam * tb + w.sky * Dpar) + (1 - params.albedoNir) * 0.5 * (w.beam * tb ** params.nirExp + w.sky * Dnir);
  const up = w.el > 0;
  const sunny = up && w.clear > 0 ? Math.min(1, w.ghi / w.clear / (params.clearRef || 0.75)) : 0;
  const air = model.canopy ? -params.airCoolC * model.canopy[i] * sunny : 0;
  const ta = w.ta + air, bb = SIGMA * (ta + 273.15) ** 4;
  const fence = FH ? w.beam * FH.beam[month][i] + w.sky * (FH.skyM ? FH.skyM[month][i] : FH.sky[i]) : 0;
  const P = 101.3 * ((293 - 0.0065 * elevM) / 293) ** 5.26, gamma = 0.000665 * P, D = satSlope(ta);
  const ptShare = 1.26 * (D / (D + gamma));
  const edge = model.edgeHeat ? model.edgeHeat[i] : 1;
  const openRn = (1 - params.albedoPar) * 0.5 * (w.beam + w.sky) + (1 - params.albedoNir) * 0.5 * (w.beam + w.sky) + EMIS * (w.lsky - bb);
  const paving = up ? (edge - 1) * (params.kc ?? 0.8) * ptShare * Math.max(0, 0.9 * openRn) : 0;
  const rnIso = swNet + EMIS * (V * w.lsky + (1 - V) * bb - bb) + fence + paving;
  const winds = model.winds || [1], at = model.windAtMonths ? model.windAtMonths[month] : model.windAt;
  const u2 = Math.max(0.5, w.wind * (winds[at ? at[i] : 0] ?? 1));
  return { swNet, rnIso, ta, ra: 208 / u2, beta: up ? Math.max(0, Math.min(1, ks)) * ptShare : 0, u2, air, fence, paving };
}

/** Open, level, watered lawn in the open wind at the same moment: the reference the card sets each spot against. */
export function openNow(w, params, elevM = 200) {
  const model = { params, rad: null, fenceHeat: null, edgeHeat: null, canopy: null, winds: [1], windAt: null };
  return surfaceNowAt(model, 0, 1, w, { month: 0, ks: 1, elevM });
}
