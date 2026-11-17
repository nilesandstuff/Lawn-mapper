/**
 * THE SOIL'S OWN TEMPERATURE, SPOT BY SPOT, COUPLED BOTH WAYS TO THE SURFACE (owner, 2026-11-17: "We don't currently
 * have any sort of modelling of soil temperature differences between spots. Soil temps certainly affect surface
 * temperatures, and surface temps affect soil temps. So we have to find out how to model that feedback loop").
 * The research agent's survey of the same day (FINDINGS H92) chose, as the large land models do (ECMWF IFS/HTESSEL,
 * CLM5, PALM), a column of soil layers per spot, solved hourly by implicit heat diffusion, under a skin that has no
 * heat capacity of its own and is tied to the top layer by a conductance -- not G as a share of Rn (FAO-56's hourly
 * 0.1/0.5 Rn, which at night is an endless heater: the first walks ran 4-5 F warm, more in shade, H91).
 *
 *   THE COLUMN   8 layers, 2, 3, 5, 10, 15, 25, 40, 50 cm thick (to 1.5 m; the 5-10 cm layer is a 4-inch probe's)
 *   PROPERTIES   conductivity by Johansen (1975) as CLM5 writes it: l = Ke lsat + (1 - Ke) ldry, lsat = ls^(1-n)
 *                lw^n, ls = (8.80 sand + 2.92 clay)/(sand + clay), ldry = (0.135 rd + 64.7)/(2700 - 0.947 rd),
 *                rd = 2700 (1 - n), Ke = log10(Sr) + 1 (>= 0); organic matter mixed in at ls 0.25, ldry 0.05;
 *                heat capacity by de Vries (1963): C = 2.0e6 (1 - n - om) + 2.5e6 om + 4.18e6 theta (J/m3/K)
 *   WATER        theta in the root zone from the daily water balance (field capacity less the depletion), below it
 *                field capacity
 *   THE SKIN     (1 - 0.05) SWnet + e (V Lsky + (1 - V) s Ta^4) - e s Ts^4 - H - LE - G = 0, linearised about Ta as the
 *                surface model is (surfacenow.js); G = L (Ts - T1), L = 10 W/m2/K (IFS's low vegetation, a mown lawn
 *                and its thatch); 5% of the net sunshine passes straight to the top layer (IFS fRs); LE = Ks x
 *                Priestley-Taylor of (Rn - G) by day, none by night; H = rho cp (Ts - Ta)/ra, ra = 208/u2
 *   NUMERICS     backward Euler, one-hour steps, the skin solved together with the top layer (G linear in the new
 *                T1), a tridiagonal solve per spot (Thomas)
 *   THE BOTTOM   held at 1.5 m to the year's wave fitted to the area's 4-inch soil series (IEMRE), damped and
 *                delayed to that depth (annual damping depth 2.4 m); the same for every spot: only the top differs
 *   THE START    every layer at that wave on the first day, then 45 days of each spot's own hourly forcing (spin-up)
 *
 * NOT IN IT (yet): a stable night's still air (ra stays the neutral one), frozen ground and snow, thatch thicker than
 * half an inch, sideways heat between spots.
 */

export const LAYERS = [0.02, 0.03, 0.05, 0.10, 0.15, 0.25, 0.40, 0.50]; // m, top down
export const DEPTHS = LAYERS.reduce((a, dz, k) => { a.push((k ? a[k - 1] : 0) + dz); return a; }, []); // bottoms
export const CENTRES = LAYERS.map((dz, k) => DEPTHS[k] - dz / 2);
export const LAMBDA_SKIN = 10; // W/m2/K, the lawn and its thatch (IFS low vegetation; PALM: the most sensitive term)
export const SW_TO_SOIL = 0.05; // share of the net sunshine reaching the soil straight through the turf (IFS fRs)
export const ANNUAL_DAMPING_M = 2.4;
const SIGMA = 5.67e-8, EMIS = 0.98, RHO_CP = 1.2 * 1005, YEAR_MS = 365.25 * 864e5;

/** A layer's thermal conductivity (W/m/K) and heat capacity (J/m3/K): sand, clay, om in %, porosity n, water theta. */
export function soilProps({ sand = 40, clay = 20, om = 2, n = 0.45 } = {}, theta = 0.25) {
  // the organic share of the solids: the survey's organic matter (% by weight), taken as the same share by volume
  const s = Math.max(1, sand), c = Math.max(1, clay), fom = Math.max(0, Math.min(0.5, (om || 0) / 100));
  const por = Math.max(0.3, Math.min(0.7, n || 0.45));
  const lsMin = (8.80 * s + 2.92 * c) / (s + c);
  const ls = (1 - fom) * lsMin + fom * 0.25;
  const rd = 2700 * (1 - por);
  const ldryMin = (0.135 * rd + 64.7) / (2700 - 0.947 * rd);
  const ldry = (1 - fom) * ldryMin + fom * 0.05;
  const lsat = ls ** (1 - por) * 0.57 ** por;
  const Sr = Math.max(0, Math.min(1, theta / por));
  const Ke = Sr > 0 ? Math.max(0, Math.log10(Sr) + 1) : 0;
  const lambda = Ke * lsat + (1 - Ke) * ldry;
  const C = 2.0e6 * Math.max(0, 1 - por - fom) + 2.5e6 * fom + 4.18e6 * Math.max(0, Math.min(por, theta));
  return { lambda, C, Ke };
}

/** The year's soil wave from a daily series [{ date, t (C) }]: mean, amplitude, phase (day-of-year radians). */
export function fitAnnual(days) {
  const pts = (days || []).filter((d) => Number.isFinite(d?.t) && d?.date);
  if (pts.length < 60) return null;
  let a = 0, b = 0, m = 0;
  for (const d of pts) m += d.t;
  m /= pts.length;
  for (const d of pts) { const w = (2 * Math.PI * (Date.parse(`${d.date}T12:00:00Z`) % YEAR_MS)) / YEAR_MS; a += (d.t - m) * Math.cos(w); b += (d.t - m) * Math.sin(w); }
  a *= 2 / pts.length; b *= 2 / pts.length;
  return { mean: m, amp: Math.hypot(a, b), phase: Math.atan2(b, a), depthM: 0.1 };
}
/** That wave at depth z (m) and time t (ms): damped e^(-dz/D) and delayed dz/D from the series' own depth. */
export function annualAt(fit, z, t) {
  const dz = Math.max(0, z - fit.depthM), w = (2 * Math.PI * (t % YEAR_MS)) / YEAR_MS;
  return fit.mean + fit.amp * Math.exp(-dz / ANNUAL_DAMPING_M) * Math.cos(w - fit.phase - dz / ANNUAL_DAMPING_M);
}

/** A column of layer temperatures at a time, from the wave (the start of the spin-up). */
export function startColumn(fit, t) { return Float64Array.from(CENTRES, (z) => annualAt(fit, z, t)); }

/**
 * ONE HOUR OF ONE SPOT. T: the layer temperatures (updated in place); props: [{ lambda, C }] per layer; f: the hour's
 * forcing at the spot: { swNet (W/m2 absorbed by the lawn), rnIso (net radiation were the skin at the air's
 * temperature: SW + e (V Lsky + (1 - V) s Ta^4 - s Ta^4) + fences + paving), ta (C), ra (s/m), beta (the share of
 * Rn - G turned to evaporation: Ks x Priestley-Taylor by day, 0 by night), tBottom (C) }; dt in s.
 * -> { ts (C), g (W/m2 into the soil) }
 */
export function stepColumn(T, props, f, dt = 3600) {
  const N = T.length;
  const kR = 4 * EMIS * SIGMA * (f.ta + 273.15) ** 3, kH = RHO_CP / f.ra, L = LAMBDA_SKIN, b1 = 1 - Math.max(0, Math.min(0.95, f.beta));
  const rn = f.rnIso - SW_TO_SOIL * f.swNet; // the skin's own share
  const D = kH + b1 * (kR + L);
  // G = g0 + g1 T1 (the skin solved with the top layer): from (1 - beta)(Rn - G) = H
  const g0 = L * ((b1 * (rn - L * f.ta)) / D + f.ta), g1 = -L * (kH + b1 * kR) / D;
  const a = new Float64Array(N), b = new Float64Array(N), c = new Float64Array(N), d = new Float64Array(N);
  const K = new Float64Array(N); // conductance between layer k and k+1 (W/m2/K), the last to the bottom
  for (let k = 0; k < N - 1; k++) K[k] = 1 / (LAYERS[k] / 2 / props[k].lambda + LAYERS[k + 1] / 2 / props[k + 1].lambda);
  K[N - 1] = props[N - 1].lambda / (LAYERS[N - 1] / 2);
  for (let k = 0; k < N; k++) {
    const cap = (props[k].C * LAYERS[k]) / dt;
    b[k] = cap + K[k] + (k ? K[k - 1] : 0);
    a[k] = k ? -K[k - 1] : 0;
    c[k] = k < N - 1 ? -K[k] : 0;
    d[k] = cap * T[k];
  }
  b[0] -= g1; d[0] += g0 + SW_TO_SOIL * f.swNet;
  d[N - 1] += K[N - 1] * f.tBottom;
  // Thomas
  for (let k = 1; k < N; k++) { const m = a[k] / b[k - 1]; b[k] -= m * c[k - 1]; d[k] -= m * d[k - 1]; }
  T[N - 1] = d[N - 1] / b[N - 1];
  for (let k = N - 2; k >= 0; k--) T[k] = (d[k] - c[k] * T[k + 1]) / b[k];
  const g = g0 + g1 * T[0];
  const x = (b1 * (rn - L * (f.ta - T[0]))) / D; // Ts - Ta
  return { ts: f.ta + x, g };
}

/** The skin at a moment over a column whose top layer stands at t1 (the walk's minute, the column left as it is). */
export function skinOver(t1, f) {
  const kR = 4 * EMIS * SIGMA * (f.ta + 273.15) ** 3, kH = RHO_CP / f.ra, L = LAMBDA_SKIN, b1 = 1 - Math.max(0, Math.min(0.95, f.beta));
  const rn = f.rnIso - SW_TO_SOIL * f.swNet;
  const x = (b1 * (rn - L * (f.ta - t1))) / (kH + b1 * (kR + L));
  return f.ta + x;
}

/**
 * WATER HELD AT FIELD CAPACITY AND AT WILTING, AND THE PORE SPACE, from texture (Saxton & Rawls 2006, their eqs 1-5;
 * sand, clay and organic matter in %): the soil survey's root zone carries texture only. -> { wp, fc, sat } (m3/m3)
 */
export function saxtonRawls(sand = 40, clay = 20, om = 2) {
  const S = Math.max(0.01, Math.min(0.95, sand / 100)), C = Math.max(0.01, Math.min(0.6, clay / 100)), O = Math.max(0, Math.min(8, om));
  const w15t = -0.024 * S + 0.487 * C + 0.006 * O + 0.005 * S * O - 0.013 * C * O + 0.068 * S * C + 0.031;
  const wp = w15t + (0.14 * w15t - 0.02);
  const w33t = -0.251 * S + 0.195 * C + 0.011 * O + 0.006 * S * O - 0.027 * C * O + 0.452 * S * C + 0.299;
  const fc = w33t + (1.283 * w33t * w33t - 0.374 * w33t - 0.015);
  const wst = 0.278 * S + 0.034 * C + 0.022 * O - 0.018 * S * O - 0.027 * C * O - 0.584 * S * C + 0.078;
  const sat = fc + (wst + (0.636 * wst - 0.107)) - 0.097 * S + 0.043;
  return { wp: Math.max(0.01, wp), fc: Math.max(wp + 0.02, fc), sat: Math.max(fc + 0.03, Math.min(0.7, sat)) };
}

/** A spot's column on one day: texture { sand, clay }, the roots' depth (cm) and how full the root zone is (0-1, 1
 *  at field capacity); below the roots at field capacity. -> [{ lambda, C }] per layer */
export function columnProps(texture, rootCm, full = 1) {
  const sand = Number.isFinite(texture?.sand) ? texture.sand : 40, clay = Number.isFinite(texture?.clay) ? texture.clay : 20;
  const h = saxtonRawls(sand, clay, 2);
  const root = h.wp + (h.fc - h.wp) * Math.max(0, Math.min(1, full));
  return CENTRES.map((z) => soilProps({ sand, clay, om: 2, n: h.sat }, z * 100 < (rootCm || 15) ? root : h.fc));
}

/**
 * THE SPIN-UP: every spot's column run hour by hour from the year's wave to the end of the hours given.
 * n: spots; hours: [{ t (the hour's start, ms) }]; forcing(c, h) -> stepColumn's f without tBottom (null: the hour
 * is skipped, the column left as it stands); propsOf(c, h) -> [{ lambda, C }] per layer; fit: fitAnnual's.
 * -> { T: [Float64Array] per spot (the layers at the end), t (ms), skipped (hours) }
 */
export function spinColumns({ n, hours, forcing, propsOf, fit }) {
  const t0 = hours.length ? hours[0].t : 0;
  const T = Array.from({ length: n }, () => startColumn(fit, t0));
  const zb = DEPTHS[DEPTHS.length - 1] + LAYERS[LAYERS.length - 1] / 2;
  let skipped = 0;
  hours.forEach((hr, h) => {
    const tBottom = annualAt(fit, zb, hr.t + 18e5);
    let any = false;
    for (let c = 0; c < n; c++) {
      const f = forcing(c, h);
      if (!f) continue;
      any = true;
      stepColumn(T[c], propsOf(c, h), { ...f, tBottom }, 3600);
    }
    if (!any) skipped++;
  });
  return { T, t: hours.length ? hours[hours.length - 1].t + 36e5 : t0, skipped, tBottomAt: (t) => annualAt(fit, zb, t) };
}

/** The skin's energy at a moment, from the forcing, the top layer t1 and the skin ts that came of them (W/m2; the
 *  shares sum to nothing): net radiation at the skin, into the ground, to the air, to evaporation. */
export function skinParts(t1, f, ts) {
  const kR = 4 * EMIS * SIGMA * (f.ta + 273.15) ** 3, kH = RHO_CP / f.ra;
  const rn = f.rnIso - SW_TO_SOIL * f.swNet - kR * (ts - f.ta);
  const g = LAMBDA_SKIN * (ts - t1), h = kH * (ts - f.ta);
  return { rn, g, h, le: rn - g - h, swSoil: SW_TO_SOIL * f.swNet };
}
