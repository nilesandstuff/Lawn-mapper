/**
 * WHERE THE SUN IS, AND HOW STRONG IT IS ON A CLEAR DAY (shade map).
 *
 * Position: NOAA's solar calculator (the "General Solar Position" equations
 * of the NOAA Global Monitoring Laboratory spreadsheet), good to about a
 * hundredth of a degree for centuries either side of 2000 -- far below
 * anything a lawn could notice.
 *
 * Strength (owner, 2026-10-10: "the difference in actual strength of light
 * based on latitude and elevation"). Latitude enters through the sun's
 * angle: lower sun, longer path through the air, and less energy per square
 * metre of level ground. Elevation enters through the air itself: less of
 * it above a high lawn, so less is scattered away. The clear-sky model is
 * the Meinel/Laue form used in solar engineering:
 *
 *   air mass       Kasten & Young (1989), sun-angle form
 *   direct beam    DNI = I0 [ (1 - a h) 0.7^(AM^0.678) + a h ],  a = 0.14 per km
 *                  (Laue 1970: about +14% per km of height at the sun's
 *                  normal; I0 corrected for the Earth-sun distance)
 *   diffuse sky    DHI = 0.1 DNI on a clear day (the Meinel rule)
 *
 * It is a CLEAR-SKY model. Clouds are the next step, from measured climate
 * (NASA POWER), and will scale these numbers down, not replace the geometry.
 *
 * Light for grass: photosynthetically active photons per joule of sunlight
 * at ground level, about 2.04 umol per J of global shortwave (roughly 45%
 * of the energy is in 400-700 nm, at about 4.57 umol per J of PAR). So a
 * clear midsummer day of ~30 MJ/m2 is ~60 mol/m2/day of DLI, the textbook
 * figure for full summer sun.
 */

const RAD = Math.PI / 180;
export const SOLAR_CONSTANT = 1361; // W/m2
export const PAR_UMOL_PER_J = 2.04;

/** Julian day of a JS time (ms since 1970, UTC). */
const julian = (ms) => ms / 86400000 + 2440587.5;

/** Declination (deg), equation of time (minutes) and Earth-sun distance (AU) at a time. */
export function solarTerms(ms) {
  const T = (julian(ms) - 2451545) / 36525;
  const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C, trueAnom = M + C;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(trueAnom * RAD));
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eot = 4 / RAD * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
  return { decl, eot, R };
}

/**
 * The sun seen from (lat, lng) at a time: elevation above the horizon and
 * azimuth clockwise from north, in degrees, with NOAA's refraction
 * correction (the sun looks a little higher near the horizon than it is).
 */
export function sunAt(lat, lng, ms) {
  const { decl, eot, R } = solarTerms(ms);
  const d = new Date(ms);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60000;
  let tst = (minutes + eot + 4 * lng) % 1440;
  if (tst < 0) tst += 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const cz = Math.min(1, Math.max(-1, Math.sin(lat * RAD) * Math.sin(decl * RAD)
    + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(ha * RAD)));
  const zen = Math.acos(cz) / RAD;
  let el = 90 - zen;
  /* Refraction (NOAA's piecewise fit), in degrees. */
  const te = Math.tan(el * RAD);
  const refr = el > 85 ? 0
    : el > 5 ? (58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5) / 3600
      : el > -0.575 ? (1735 + el * (-518.2 + el * (103.4 + el * (-12.79 + el * 0.711)))) / 3600
        : (-20.774 / te) / 3600;
  el += refr;
  const az = (Math.atan2(Math.sin(ha * RAD), Math.cos(ha * RAD) * Math.sin(lat * RAD)
    - Math.tan(decl * RAD) * Math.cos(lat * RAD)) / RAD + 180 + 360) % 360;
  return { elevation: el, azimuth: az, decl, eot, R };
}

/** UTC time (ms) of solar noon at a longitude on the UTC calendar day of `dayMs`. */
export function solarNoon(lng, dayMs) {
  const d = new Date(dayMs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let t = midnight + (720 - 4 * lng) * 60000;
  t = midnight + (720 - 4 * lng - solarTerms(t).eot) * 60000; // once more with that day's equation of time
  return t;
}

/**
 * The sun's positions through one day, every `stepMin` minutes while it is
 * up, centred on solar noon: [{ t, elevation, azimuth, dir: [east, north, up] }].
 * `dayMs` is any time on the wanted date at the place (noon local is safest).
 */
export function sunPath(lat, lng, dayMs, stepMin = 10) {
  const noon = solarNoon(lng, dayMs);
  const out = [];
  for (let m = -12 * 60 + stepMin / 2; m < 12 * 60; m += stepMin) {
    const t = noon + m * 60000;
    const s = sunAt(lat, lng, t);
    if (s.elevation <= 0) continue;
    const ce = Math.cos(s.elevation * RAD);
    out.push({ t, elevation: s.elevation, azimuth: s.azimuth, R: s.R,
      dir: [Math.sin(s.azimuth * RAD) * ce, Math.cos(s.azimuth * RAD) * ce, Math.sin(s.elevation * RAD)] });
  }
  return out;
}

/** Relative optical air mass, Kasten & Young (1989). Elevation in degrees. */
export function airMass(elevationDeg) {
  const z = 90 - elevationDeg;
  if (z >= 90) return Infinity;
  return 1 / (Math.cos(z * RAD) + 0.50572 * (96.07995 - z) ** -1.6364);
}

/**
 * Clear-sky irradiance with the sun at `elevationDeg`, at a site `heightM`
 * above sea level, `R` AU from the sun: { dni, dhi, ghi } in W/m2 (direct
 * normal, diffuse horizontal, global horizontal).
 */
export function clearSky(elevationDeg, heightM = 0, R = 1) {
  if (elevationDeg <= 0) return { dni: 0, dhi: 0, ghi: 0 };
  const I0 = SOLAR_CONSTANT / (R * R);
  const AM = airMass(elevationDeg);
  const h = Math.max(0, heightM) / 1000;
  const a = 0.14;
  const dni = I0 * ((1 - a * h) * 0.7 ** (AM ** 0.678) + a * h);
  const dhi = 0.1 * dni;
  return { dni, dhi, ghi: dni * Math.sin(elevationDeg * RAD) + dhi };
}

/** W/m2 for `seconds` -> mol/m2 of photosynthetically active light. */
export const parMol = (wm2, seconds) => (wm2 * seconds * PAR_UMOL_PER_J) / 1e6;
