/**
 * THE HILLSIDE ABOVE A LAWN, AND THE WATER TABLE IT MAY FEED (water session, 2026-10-18).
 *
 * Owner, 2026-10-18: "known details about the water table if possible,
 * especially in areas below steep hills."
 *
 * The lot's own lidar box reaches only 30 m past the property line; a hill
 * that feeds a lawn from below ground can be hundreds of metres long. So
 * this reads the USGS 3DEP elevation service (10 m, no key, open to
 * browsers) over RADIUS_M round the lot and asks three things:
 *
 *   UPSLOPE   how much land drains toward the lawn (D8 on the filled
 *             ground), and how steep it is on average;
 *   TWI       the topographic wetness index, ln(a / tan b), of the lawn,
 *             as a percentile of the land round it (no published lawn
 *             threshold exists -- PARAMS-SOURCES.md 6 -- so a rank within
 *             its own surroundings);
 *   HAND      the lawn's height above the nearest drainage line (a channel:
 *             CHANNEL_HA or more draining through a cell). Agren et al. 2014
 *             found "wet if 1 m or less above the nearest channel" predicted
 *             wet soils better than TWI.
 *
 * A first cut: what it says goes on the page as "likely", and into FINDINGS
 * as SPECULATION until a wet spring on a real lawn says otherwise.
 */

import { fill } from './hydro.js';
import { toMerc, mercScale } from './ept.js';

/* CHANNEL_HA: 4 ha first, but on a 10 m DEM in town that marks the street gutters (two of ten corpus
   lots came out "10 m from a channel" with nothing draining onto them); 20 ha is about where a small
   stream begins. */
export const RADIUS_M = 600, CELL_M = 10, CHANNEL_HA = 20;
const N8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';

/** The 3DEP ground over a square `radius` m round [lng, lat], CELL_M cells, row 0 north. */
export async function demAround(lng, lat, { radius = RADIUS_M, cell = CELL_M, fetchFn = fetch } = {}) {
  const k = mercScale(lat), [cx, cy] = toMerc([lng, lat]);
  const n = Math.round((2 * radius) / cell), h = radius / k;
  const bbox = [cx - h, cy - h, cx + h, cy + h];
  const url = `${SERVICE}?bbox=${bbox.map((v) => v.toFixed(2)).join(',')}&bboxSR=3857&imageSR=3857&size=${n},${n}&format=bsq&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`the USGS elevation service answered ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < n * n * 4) throw new Error('the USGS elevation service sent too little');
  // raw little-endian float32, band sequential; a validity bit-mask follows
  const z = new Float32Array(buf.slice(0, n * n * 4));
  for (let i = 0; i < z.length; i++) if (!(z[i] > -500 && z[i] < 9000)) z[i] = NaN;
  return { W: n, H: n, cell, z, bbox, k };
}

/** D8 receivers, contributing area (m^2), slope (m/m) on a DEM { W, H, cell, z }. */
export function terrain(dem) {
  const { W, H, cell } = dem, N = W * H;
  const z = Float64Array.from(dem.z, (v) => (Number.isFinite(v) ? v : -1e9));
  const filled = fill(dem, z, new Uint8Array(N), 1e-4);
  const down = new Int32Array(N).fill(-1), slope = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = Math.floor(i / W), c = i % W;
    let best = -1, bd = 0, steep = 0;
    for (const [dr, dc] of N8) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const j = rr * W + cc, d = Math.hypot(dr, dc) * cell;
      const drop = (filled[i] - filled[j]) / d;
      if (drop > bd) { bd = drop; best = j; }
      steep = Math.max(steep, (z[i] - z[j]) / d);
    }
    down[i] = best; slope[i] = Math.max(0.001, steep);
  }
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => filled[b] - filled[a]);
  const area = new Float64Array(N).fill(cell * cell);
  for (const i of order) if (down[i] >= 0) area[down[i]] += area[i];
  return { down, area, slope, filled, order };
}

/**
 * What the hillside says about the lawn. lawn: [lng, lat] points on it (its cells' centres, or the
 * map's point). -> { upslopeHa, upslopeSlope, lotSlope, twi, twiPercentile, handM, channelM, likely }
 */
export function hillside(dem, t, lawnPoints) {
  const { W, H, cell } = dem, N = W * H;
  const at = ([lng, lat]) => {
    const [x, y] = toMerc([lng, lat]);
    const c = Math.floor(((x - dem.bbox[0]) / (dem.bbox[2] - dem.bbox[0])) * W), r = Math.floor(((dem.bbox[3] - y) / (dem.bbox[3] - dem.bbox[1])) * H);
    return c < 0 || r < 0 || c >= W || r >= H ? -1 : r * W + c;
  };
  const lot = [...new Set(lawnPoints.map(at).filter((i) => i >= 0))];
  if (!lot.length) return null;
  const twi = new Float32Array(N);
  for (let i = 0; i < N; i++) twi[i] = Math.log(t.area[i] / cell / t.slope[i]);
  const sorted = Array.from(twi).filter(Number.isFinite).sort((a, b) => a - b);
  const rank = (v) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } return lo / sorted.length; };
  const lotTwiSorted = lot.map((i) => twi[i]).sort((a, b) => a - b);
  const lotTwi = lotTwiSorted[lotTwiSorted.length >> 1]; // the lawn's middle, not its wettest corner
  // land draining into the lawn from OUTSIDE it: every cell whose path passes through a lawn cell
  const inLot = new Uint8Array(N); for (const i of lot) inLot[i] = 1;
  const feeds = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let j = i, steps = 0;
    while (j >= 0 && !inLot[j] && steps++ < W * 2) j = t.down[j];
    if (j >= 0 && inLot[j] && !inLot[i]) feeds[i] = 1;
  }
  let upCells = 0, upSlope = 0;
  for (let i = 0; i < N; i++) if (feeds[i]) { upCells++; upSlope += t.slope[i]; }
  // height above the nearest drainage line, down the flow path
  const channel = (i) => t.area[i] >= CHANNEL_HA * 1e4;
  const hand = lot.map((i) => {
    let j = i, steps = 0, dist = 0;
    while (j >= 0 && !channel(j) && steps++ < W * 2) { const n = t.down[j]; if (n < 0) break; dist += cell * (Math.abs(n - j) === 1 || Math.abs(n - j) === W ? 1 : Math.SQRT2); j = n; }
    return j >= 0 && channel(j) ? { h: dem.z[i] - dem.z[j], dist } : null;
  }).filter(Boolean);
  const hs = hand.map((x) => x.h).sort((a, b) => a - b);
  const handM = hs.length ? hs[hs.length >> 1] : null;
  const channelM = hand.length ? Math.min(...hand.map((x) => x.dist)) : null;
  const lotSlope = lot.reduce((s, i) => s + t.slope[i], 0) / lot.length;
  const upslopeHa = (upCells * cell * cell) / 1e4, upslopeSlope = upCells ? upSlope / upCells : 0;
  const out = { upslopeHa, upslopeSlope, lotSlope, twi: lotTwi, twiPercentile: rank(lotTwi), handM, channelM };
  /* A first cut, graded (SPECULATION in FINDINGS; ten corpus lots, no ground truth yet):
     LIKELY    the lawn's middle within a metre of a drainage line, or at the foot of a hectare or more of
               slope over 8% AND in the wettest 15% of its surroundings;
     POSSIBLE  one of: the wettest 20%, or a hectare or more of 8%+ slope above it;
     UNLIKELY  neither. */
  out.nearChannel = handM !== null && handM <= 1;
  out.belowHill = upslopeHa >= 1 && upslopeSlope >= 0.08;
  out.level = out.nearChannel || (out.belowHill && out.twiPercentile >= 0.85) ? 'likely'
    : out.belowHill || out.twiPercentile >= 0.8 ? 'possible' : 'unlikely';
  return out;
}
