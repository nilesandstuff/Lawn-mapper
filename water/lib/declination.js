/**
 * MAGNETIC DECLINATION (2026-11-17): the phone's compass bearings are from magnetic north (the thermal photos' az,
 * the core session's word that day); the map's are from true north. The World Magnetic Model 2025 (NOAA NCEI and the
 * British Geological Survey; a work of the US government, public domain; valid 2025.0-2030.0), its 90 coefficients
 * below as published in WMM2025.COF [n, m, g, h, dg/dt, dh/dt] (nT, nT/yr), evaluated as its technical report sets
 * out: the geodetic place to geocentric, Schmidt semi-normalised Legendre functions to degree 12, the field's north,
 * east and down parts, the north part turned back to the geodetic frame, and the angle. Checked against the model's
 * own test values (test/declination.test.js).
 *
 *   declination(lat, lng, decimalYear, altKm = 0) -> degrees, east of true north positive
 *   trueBearing(magDeg, lat, lng, t (ms)) -> degrees from true north
 */
const EPOCH = 2025.0, N = 12;
const COEF = [
  [1, 0, -29351.8, 0.0, 12.0, 0.0], [1, 1, -1410.8, 4545.4, 9.7, -21.5], [2, 0, -2556.6, 0.0, -11.6, 0.0], [2, 1, 2951.1, -3133.6, -5.2, -27.7],
  [2, 2, 1649.3, -815.1, -8.0, -12.1], [3, 0, 1361.0, 0.0, -1.3, 0.0], [3, 1, -2404.1, -56.6, -4.2, 4.0], [3, 2, 1243.8, 237.5, 0.4, -0.3],
  [3, 3, 453.6, -549.5, -15.6, -4.1], [4, 0, 895.0, 0.0, -1.6, 0.0], [4, 1, 799.5, 278.6, -2.4, -1.1], [4, 2, 55.7, -133.9, -6.0, 4.1],
  [4, 3, -281.1, 212.0, 5.6, 1.6], [4, 4, 12.1, -375.6, -7.0, -4.4], [5, 0, -233.2, 0.0, 0.6, 0.0], [5, 1, 368.9, 45.4, 1.4, -0.5],
  [5, 2, 187.2, 220.2, 0.0, 2.2], [5, 3, -138.7, -122.9, 0.6, 0.4], [5, 4, -142.0, 43.0, 2.2, 1.7], [5, 5, 20.9, 106.1, 0.9, 1.9],
  [6, 0, 64.4, 0.0, -0.2, 0.0], [6, 1, 63.8, -18.4, -0.4, 0.3], [6, 2, 76.9, 16.8, 0.9, -1.6], [6, 3, -115.7, 48.8, 1.2, -0.4],
  [6, 4, -40.9, -59.8, -0.9, 0.9], [6, 5, 14.9, 10.9, 0.3, 0.7], [6, 6, -60.7, 72.7, 0.9, 0.9], [7, 0, 79.5, 0.0, -0.0, 0.0],
  [7, 1, -77.0, -48.9, -0.1, 0.6], [7, 2, -8.8, -14.4, -0.1, 0.5], [7, 3, 59.3, -1.0, 0.5, -0.8], [7, 4, 15.8, 23.4, -0.1, 0.0],
  [7, 5, 2.5, -7.4, -0.8, -1.0], [7, 6, -11.1, -25.1, -0.8, 0.6], [7, 7, 14.2, -2.3, 0.8, -0.2], [8, 0, 23.2, 0.0, -0.1, 0.0],
  [8, 1, 10.8, 7.1, 0.2, -0.2], [8, 2, -17.5, -12.6, 0.0, 0.5], [8, 3, 2.0, 11.4, 0.5, -0.4], [8, 4, -21.7, -9.7, -0.1, 0.4],
  [8, 5, 16.9, 12.7, 0.3, -0.5], [8, 6, 15.0, 0.7, 0.2, -0.6], [8, 7, -16.8, -5.2, -0.0, 0.3], [8, 8, 0.9, 3.9, 0.2, 0.2],
  [9, 0, 4.6, 0.0, -0.0, 0.0], [9, 1, 7.8, -24.8, -0.1, -0.3], [9, 2, 3.0, 12.2, 0.1, 0.3], [9, 3, -0.2, 8.3, 0.3, -0.3],
  [9, 4, -2.5, -3.3, -0.3, 0.3], [9, 5, -13.1, -5.2, 0.0, 0.2], [9, 6, 2.4, 7.2, 0.3, -0.1], [9, 7, 8.6, -0.6, -0.1, -0.2],
  [9, 8, -8.7, 0.8, 0.1, 0.4], [9, 9, -12.9, 10.0, -0.1, 0.1], [10, 0, -1.3, 0.0, 0.1, 0.0], [10, 1, -6.4, 3.3, 0.0, 0.0],
  [10, 2, 0.2, 0.0, 0.1, -0.0], [10, 3, 2.0, 2.4, 0.1, -0.2], [10, 4, -1.0, 5.3, -0.0, 0.1], [10, 5, -0.6, -9.1, -0.3, -0.1],
  [10, 6, -0.9, 0.4, 0.0, 0.1], [10, 7, 1.5, -4.2, -0.1, 0.0], [10, 8, 0.9, -3.8, -0.1, -0.1], [10, 9, -2.7, 0.9, -0.0, 0.2],
  [10, 10, -3.9, -9.1, -0.0, -0.0], [11, 0, 2.9, 0.0, 0.0, 0.0], [11, 1, -1.5, 0.0, -0.0, -0.0], [11, 2, -2.5, 2.9, 0.0, 0.1],
  [11, 3, 2.4, -0.6, 0.0, -0.0], [11, 4, -0.6, 0.2, 0.0, 0.1], [11, 5, -0.1, 0.5, -0.1, -0.0], [11, 6, -0.6, -0.3, 0.0, -0.0],
  [11, 7, -0.1, -1.2, -0.0, 0.1], [11, 8, 1.1, -1.7, -0.1, -0.0], [11, 9, -1.0, -2.9, -0.1, 0.0], [11, 10, -0.2, -1.8, -0.1, 0.0],
  [11, 11, 2.6, -2.3, -0.1, 0.0], [12, 0, -2.0, 0.0, 0.0, 0.0], [12, 1, -0.2, -1.3, 0.0, -0.0], [12, 2, 0.3, 0.7, -0.0, 0.0],
  [12, 3, 1.2, 1.0, -0.0, -0.1], [12, 4, -1.3, -1.4, -0.0, 0.1], [12, 5, 0.6, -0.0, -0.0, -0.0], [12, 6, 0.6, 0.6, 0.1, -0.0],
  [12, 7, 0.5, -0.1, -0.0, -0.0], [12, 8, -0.1, 0.8, 0.0, 0.0], [12, 9, -0.4, 0.1, 0.0, -0.0], [12, 10, -0.2, -1.0, -0.1, -0.0],
  [12, 11, -1.3, 0.1, -0.0, 0.0], [12, 12, -0.7, 0.2, -0.1, -0.1],
];
const A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F), RE = 6371.2;
const g = [], h = [], gd = [], hd = [];
for (let n = 0; n <= N; n++) { g.push(new Array(N + 1).fill(0)); h.push(new Array(N + 1).fill(0)); gd.push(new Array(N + 1).fill(0)); hd.push(new Array(N + 1).fill(0)); }
for (const [n, m, a, b, c, d] of COEF) { g[n][m] = a; h[n][m] = b; gd[n][m] = c; hd[n][m] = d; }

export function declination(lat, lng, year, altKm = 0) {
  const R = Math.PI / 180, phi = lat * R, lam = lng * R, dt = year - EPOCH;
  const sp = Math.sin(phi), cp = Math.cos(phi), Rc = A / Math.sqrt(1 - E2 * sp * sp);
  const p = (Rc + altKm) * cp, z = (Rc * (1 - E2) + altKm) * sp, r = Math.hypot(p, z), phis = Math.asin(z / r);
  const s = Math.sin(phis), c = Math.cos(phis);
  const P = [], dP = [];
  for (let n = 0; n <= N; n++) { P.push(new Array(N + 1).fill(0)); dP.push(new Array(N + 1).fill(0)); }
  P[0][0] = 1;
  for (let n = 1; n <= N; n++) {
    for (let m = 0; m <= n; m++) {
      if (m === n) {
        const k = n === 1 ? 1 : Math.sqrt((2 * n - 1) / (2 * n));
        P[n][n] = k * c * P[n - 1][n - 1];
        dP[n][n] = k * (c * dP[n - 1][n - 1] - s * P[n - 1][n - 1]);
      } else {
        const d = Math.sqrt(n * n - m * m), e = n > 1 ? Math.sqrt((n - 1) * (n - 1) - m * m) : 0;
        P[n][m] = ((2 * n - 1) * s * P[n - 1][m] - (n > 1 ? e * P[n - 2][m] : 0)) / d;
        dP[n][m] = ((2 * n - 1) * (s * dP[n - 1][m] + c * P[n - 1][m]) - (n > 1 ? e * dP[n - 2][m] : 0)) / d;
      }
    }
  }
  let X = 0, Y = 0, Z = 0;
  for (let n = 1; n <= N; n++) {
    const ar = (RE / r) ** (n + 2);
    for (let m = 0; m <= n; m++) {
      const gg = g[n][m] + dt * gd[n][m], hh = h[n][m] + dt * hd[n][m], cm = Math.cos(m * lam), sm = Math.sin(m * lam);
      X -= ar * (gg * cm + hh * sm) * dP[n][m];
      Y += (ar * m * (gg * sm - hh * cm) * P[n][m]) / c;
      Z -= ar * (n + 1) * (gg * cm + hh * sm) * P[n][m];
    }
  }
  const psi = phis - phi;
  return Math.atan2(Y, X * Math.cos(psi) - Z * Math.sin(psi)) / R;
}

/** A compass bearing (degrees from magnetic north) turned to true north, at a place and time (ms). */
export function trueBearing(magDeg, lat, lng, t) {
  const d = new Date(t), y0 = Date.UTC(d.getUTCFullYear(), 0, 1), y1 = Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  return (((magDeg + declination(lat, lng, d.getUTCFullYear() + (t - y0) / (y1 - y0))) % 360) + 360) % 360;
}
