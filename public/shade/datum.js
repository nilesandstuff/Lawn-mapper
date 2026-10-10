/**
 * THE USGS POINT CLOUDS ARE IN NAD83; THE PHOTO IS NOT (shade map, 2026-10-10).
 *
 * MEASURED FIRST, EXPLAINED SECOND. Matching each cloud's ground to the
 * Mapbox photo (align.js) on four lots in four states, flown 2016-2021,
 * every one needed the cloud moved the same way: 0.2-0.8 m west and
 * 0.7-1.2 m north. One direction everywhere is not noise. It is the size and
 * direction of the gap between NAD83 -- the datum US lidar is surveyed in,
 * fixed to the North American plate -- and ITRF/WGS84, the global frame the
 * web map is in. The octrees on AWS are labelled EPSG:3857, but their
 * reprojection treated NAD83 latitudes and longitudes as WGS84 ones (the
 * usual "null" transform, good to a metre or two and no better).
 *
 * So the cloud is corrected by geodesy, not by fitting: the published
 * 14-parameter transformation from ITRF2008 to NAD83(2011) (Pearson & Snay,
 * GPS Solutions 17, 2013, Table 7; ITRF2008 = WGS84(G1762) to a centimetre
 * or two), at the epoch the lidar was flown. On the four lots it predicts:
 *
 *                 predicted move       measured by matching
 *     WI 2017     0.85 W  0.90 N        0.82 W  0.78 N
 *     MA 2021     0.45 W  1.14 N        0.56 W  0.82 N
 *     PA 2019     0.54 W  1.04 N        0.45 W  0.68 N
 *     MI 2016     0.78 W  0.93 N        0.17 W  1.19 N  (loosest match)
 *
 * The photo match then checks what is left over (align.js, `residual`).
 * A county's own .laz delivered in NAD83 would need the same correction; a
 * cloud already in WGS84 would need none -- which is why the residual is
 * always measured, never assumed.
 */

const A = 6378137.0;
const F = 1 / 298.257222101; // GRS80; WGS84's differs by 0.1 mm here
const E2 = F * (2 - F);
const MAS = Math.PI / 180 / 3600 / 1000;

/* ITRF2008 -> NAD83(2011) at epoch 1997.0 with rates per year. */
const T0 = [0.99343, -1.90331, -0.52655], TD = [0.00079, -0.00060, -0.00134];
const R0 = [25.91467, 9.42645, 11.59935], RD = [0.06667, -0.75744, -0.05133]; // mas
const S0 = 1.71504e-9, SD = -0.10201e-9;

export function toXYZ(lat, lng, h = 0) {
  const la = lat * Math.PI / 180, lo = lng * Math.PI / 180;
  const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
  return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + h) * Math.sin(la)];
}

export function toGeo([x, y, z]) {
  const lo = Math.atan2(y, x), p = Math.hypot(x, y);
  let la = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 8; i++) {
    const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
    const h = p / Math.cos(la) - N;
    la = Math.atan2(z, p * (1 - E2 * N / (N + h)));
  }
  return [la * 180 / Math.PI, lo * 180 / Math.PI];
}

/** ITRF2008 earth-centred coordinates -> NAD83(2011), at a decimal-year epoch. */
export function itrfToNad83([x, y, z], epoch) {
  const dt = epoch - 1997;
  const T = T0.map((t, i) => t + TD[i] * dt);
  const [rx, ry, rz] = R0.map((r, i) => (r + RD[i] * dt) * MAS);
  const s = S0 + SD * dt;
  return [
    T[0] + (1 + s) * x + rz * y - ry * z,
    T[1] - rz * x + (1 + s) * y + rx * z,
    T[2] + ry * x - rx * y + (1 + s) * z,
  ];
}

/**
 * How far, in real metres east and north, to move a point cloud whose NAD83
 * coordinates were read as WGS84, to put it on WGS84's ground, near
 * (lat, lng), for a flight at `epoch` (a decimal year; the middle of the
 * collection when known).
 */
export function nad83Correction(lat, lng, epoch) {
  const [la2, lo2] = toGeo(itrfToNad83(toXYZ(lat, lng), epoch));
  const north = (la2 - lat) * Math.PI / 180 * 6371000;
  const east = (lo2 - lng) * Math.PI / 180 * 6371000 * Math.cos(lat * Math.PI / 180);
  return { east: -east, north: -north };
}
