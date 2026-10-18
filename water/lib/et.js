/**
 * HOW MUCH WATER THE GRASS USES A DAY (water session, 2026-10-18).
 *
 * Reference evapotranspiration, ET0, by the FAO-56 Penman-Monteith equation
 * (Allen, Pereira, Raes & Smith 1998, FAO Irrigation and Drainage Paper 56,
 * eq. 6, daily step, soil heat flux G = 0), and Hargreaves-Samani (1985,
 * FAO-56 eq. 52) when only temperatures are known. The lawn's own use is
 * ET0 x Kc; the owner's Kc for now is 0.8 (water/VISION.md: "adjusted for
 * grass coefficients, use .8 for now, but I've got more specific numbers I
 * can give you later").
 */

export const KC = 0.8;

const RAD = Math.PI / 180;

/** Saturation vapour pressure (kPa) at T (C). FAO-56 eq. 11. */
export const es = (t) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3));

/** Extraterrestrial radiation Ra (MJ/m2/day) at latitude (deg) on day of year. FAO-56 eq. 21. */
export function ra(latDeg, doy) {
  const phi = latDeg * RAD;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
  const dec = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec))));
  return ((24 * 60) / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws));
}

/**
 * FAO-56 Penman-Monteith ET0, mm/day.
 * d: { tmax, tmin (C), rh (%, daily mean) | ea (kPa), wind (m/s at 2 m), rs (MJ/m2/day) },
 * latDeg, doy, elevM.
 */
export function penmanMonteith(d, latDeg, doy, elevM = 200) {
  const tmean = (d.tmax + d.tmin) / 2;
  const P = 101.3 * ((293 - 0.0065 * elevM) / 293) ** 5.26;
  const gamma = 0.000665 * P;
  const delta = (4098 * es(tmean)) / (tmean + 237.3) ** 2;
  const esat = (es(d.tmax) + es(d.tmin)) / 2;
  const ea = d.ea ?? (d.rh !== undefined && d.rh !== null ? (d.rh / 100) * esat : es(d.tmin));
  const Ra = ra(latDeg, doy);
  const Rso = (0.75 + 2e-5 * elevM) * Ra;
  const rs = Math.min(d.rs, Rso);
  const Rns = (1 - 0.23) * rs;
  const sigma = 4.903e-9;
  const rel = Rso > 0 ? Math.max(0.25, Math.min(1, rs / Rso)) : 0.5;
  const Rnl = sigma * (((d.tmax + 273.16) ** 4 + (d.tmin + 273.16) ** 4) / 2) * (0.34 - 0.14 * Math.sqrt(Math.max(ea, 0))) * (1.35 * rel - 0.35);
  const Rn = Rns - Rnl;
  const u2 = Math.max(0.5, d.wind ?? 2);
  const et0 = (0.408 * delta * Rn + gamma * (900 / (tmean + 273)) * u2 * (esat - ea)) / (delta + gamma * (1 + 0.34 * u2));
  return Math.max(0, et0);
}

/** Hargreaves-Samani ET0, mm/day, from temperatures alone. FAO-56 eq. 52. */
export function hargreaves(tmax, tmin, latDeg, doy) {
  const Ra = ra(latDeg, doy);
  return Math.max(0, 0.0023 * (((tmax + tmin) / 2) + 17.8) * Math.sqrt(Math.max(0, tmax - tmin)) * Ra * 0.408);
}

/**
 * Solar radiation from sky cover (0-1), for a forecast that gives clouds and not sunshine:
 * the Angstrom form with sunshine fraction n/N = 1 - cover (FAO-56 eq. 35, as = 0.25, bs = 0.5).
 * A rough stand-in; the forecast's own ET0 is checked against POWER's measured days in FINDINGS.
 */
export function rsFromCover(cover, latDeg, doy) {
  return (0.25 + 0.5 * (1 - Math.max(0, Math.min(1, cover)))) * ra(latDeg, doy);
}

/** Day of year (1-366) of a Date or 'YYYY-MM-DD'. */
export function dayOfYear(date) {
  const d = typeof date === 'string' ? new Date(`${date}T12:00:00Z`) : date;
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 864e5);
}
