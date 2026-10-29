/**
 * FENCES' RADIANT HEAT ON THE GRASS (owner, 2026-10-27: "Integrate fences now. Shade, radiant heat (warming and
 * cooling), and wind"; FINDINGS H49).
 *
 * The fences are the shade map's: drawn there, kept in its part (v 3), and put on the grid, seen from each spot and
 * lit by the sun with its own code (lib/shade/fences.js: cleanFences, fencesOnGrid, faceViews, reflectedSky;
 * lib/shade/sun.js: sunPath, clearSky). Their SHADE and the sunlight a pale face throws back are in the shade map's
 * light (the water map passes them to its light worker). What the water map adds is the far-infrared:
 *
 *   COOLING BLOCKED. A fence stands where the grass would see sky, so the grass loses less heat to the sky, day and
 *   night. The sky view the shade map gives already has the fence in it; but it counts a pale face's reflected
 *   skylight as more sky (rho x F x 0.5, fences.js reflectedSky), so that is taken back out for the longwave.
 *
 *   WARMING. A sunlit board runs warmer than the air by what it absorbs over what it sheds (McAdams' convection on
 *   a flat plate, 5.7 + 3.8 u, u the wind at the fence; the radiation linearised, 4 eps sigma T^3; per face h). The
 *   board is NOT one temperature (corrected 2026-10-29, FINDINGS H59; owner: "fix both of those"): wood is an
 *   insulator, a 19 mm board passing about 6.3 W/m2/K from face to face against 17 off each face, so the sunlit face
 *   runs 15-20 C over the air and the back half that or less. Each face's warmth, from what each absorbs (S1 on it,
 *   S2 on the other, K the board's conductance): x1 = (S1 (h + K) + S2 K) / (h (h + 2K)). The grass sees the face on
 *   its side and takes F x 4 eps sigma T^3 x that face's warmth more longwave than from a fence at air temperature.
 *   About two thirds of what a board absorbs rises away in the air (convection 11.4 of 16.8 W/m2/K at 1.5 m/s).
 *
 *   THE BOARD'S OWN SUN (corrected 2026-10-29): the board is lit through whatever stands over it -- the trees' share
 *   of the beam and of the sky at the lawn beside it, month by month, from the shade map's light (its beam with the
 *   trees over its beam with the buildings alone, both with the fence in, so the fence's own shade cancels).
 */
import { cleanFences, fencesOnGrid, faceViews, reflectedSky } from './shade/fences.js';
import { sunPath, clearSky } from './shade/sun.js';
import { toMerc } from './shade/ept.js';

export const FENCE_HEAT = { windMs: 1.5, emissivity: 0.9, tK: 295, groundAlbedo: 0.2,
  // the board's conductance face to face, W/m2/K: a 19 mm wood board (k 0.12 W/m/K); a hollow vinyl panel, two 2.5 mm
  // walls (k 0.16) round a 25 mm air space (about 0.17 m2K/W with the radiation across it): about 5
  boardK: { wood: 0.12 / 0.019, vinyl: 5 } };

/**
 * Per face: extra longwave on the grass per unit absorbed on the face it sees (`seen`) and on the far face (`far`),
 * per unit view factor. Their mean is the one-temperature board's share (heatShare).
 */
export function faceShares(material = 'wood', { windMs, emissivity, tK, boardK } = FENCE_HEAT) {
  const r = 4 * emissivity * 5.670e-8 * tK ** 3, h = 5.7 + 3.8 * windMs + r, K = boardK?.[material] ?? boardK?.wood ?? 6.3;
  const den = h * (h + 2 * K);
  return { seen: (r * (h + K)) / den, far: (r * K) / den, r, h, K };
}

/** c: extra longwave MJ on the grass per MJ the board absorbs, per unit view factor (about 0.16 at 1.5 m/s). */
export function heatShare({ windMs, emissivity, tK } = FENCE_HEAT) {
  const r = 4 * emissivity * 5.670e-8 * tK ** 3;
  return r / (2 * (5.7 + 3.8 * windMs + r));
}

/** A length's beam on each face over a mid-month day, per unit of beam on level ground (clear-sky weighting): [the face its normal (nE, nN) points out of, the other]. */
export function faceBeamSides(seg, lat, lng, month, year = 2025) {
  const path = sunPath(lat, lng, Date.UTC(year, month, 15, 12), 20);
  let pos = 0, neg = 0, flat = 0;
  for (const s of path) {
    const { dni } = clearSky(s.elevation);
    const c = s.dir[0] * seg.nE + s.dir[1] * seg.nN;
    if (c > 0) pos += dni * c; else neg -= dni * c;
    flat += dni * s.dir[2];
  }
  return flat > 0 ? [pos / flat, neg / flat] : [0, 0];
}
/** Both faces' beam together, per unit on level ground. */
export function faceBeamRatio(seg, lat, lng, month, year = 2025) {
  const [a, b] = faceBeamSides(seg, lat, lng, month, year);
  return a + b;
}

/**
 * The share of the beam and of the sky that reaches a length through the trees, month by month: the shade map's beam
 * (and sky) with the trees over the same with the buildings alone, summed over the lawn within 1-3 m of it on either
 * side (both runs have the fence in them, so its own shade cancels). 1 where there is no lawn beside it to read.
 */
export function treeLightAt(seg, radiation, grid, isLawn) {
  const { W, H } = grid;
  const out = { beam: new Array(12).fill(1), sky: new Array(12).fill(1) };
  if (!radiation?.beamB) return out;
  // the grid's own normal (x east, y south)
  const gx = seg.nE, gy = -seg.nN, n = Math.max(2, Math.ceil(seg.len));
  const picks = [];
  for (let a = 0; a < n; a++) {
    const t = (a + 0.5) / n, x0 = seg.ax + (seg.bx - seg.ax) * t, y0 = seg.ay + (seg.by - seg.ay) * t;
    for (const side of [1, -1]) for (const d of [1.5, 2.5]) {
      const x = Math.floor(x0 + side * d * gx), y = Math.floor(y0 + side * d * gy);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (isLawn(i)) picks.push(i);
    }
  }
  if (!picks.length) return out;
  for (let m = 0; m < 12; m++) {
    let b = 0, bB = 0, k = 0, kB = 0;
    for (const i of picks) { b += radiation.beam[m][i]; bB += radiation.beamB[m][i]; k += radiation.sky[m][i]; kB += radiation.skyB[m][i]; }
    if (bB > 0.05 * picks.length) out.beam[m] = Math.max(0, Math.min(1, b / bB));
    if (kB > 0.05 * picks.length) out.sky[m] = Math.max(0, Math.min(1, k / kB));
  }
  return out;
}

/**
 * For the cells `cells` (indices into the grid { W, H, bbox (3857), cell (m) }, ground z per cell):
 * -> null without fences, else { lengths, seen (cells seeing a face), reflSky: Float32Array(N) (the reflected
 *    skylight counted as sky, to take out of the longwave sky view), beam: [12 Float32Array(N)], sky: Float32Array(N)
 *    (extra MJ/m2 of longwave per MJ/m2 of the day's beam and of its skylight on level ground) }
 */
export function fenceRadiation(fences, grid, z, cells, lat, lng, opts = FENCE_HEAT, radiation = null) {
  const recs = cleanFences(fences);
  if (!recs.length) return null;
  const { W, H, bbox } = grid, N = W * H, cm = grid.cell || 1;
  const cellMerc = (bbox[2] - bbox[0]) / W;
  const toCell = (p) => { const [mx, my] = toMerc(p); return [(mx - bbox[0]) / cellMerc, (bbox[3] - my) / cellMerc]; };
  const groundAt = (gx, gy) => { const c = Math.max(0, Math.min(W - 1, Math.floor(gx))), r = Math.max(0, Math.min(H - 1, Math.floor(gy))); const v = z[r * W + c]; return Number.isFinite(v) ? v : 0; };
  const segs = fencesOnGrid(recs, toCell, groundAt, cm);
  if (!segs.length) return null;
  const material = new Map(recs.map((f) => [f.id, f.material]));
  const list = Array.from(cells);
  const lawn = new Uint8Array(N); for (const i of list) lawn[i] = 1;
  const xy = new Float32Array(list.length * 2);
  list.forEach((i, p) => { xy[2 * p] = (i % W) + 0.5; xy[2 * p + 1] = Math.floor(i / W) + 0.5; });
  const views = faceViews(segs, xy, groundAt, cm);
  const alb = opts.groundAlbedo;
  /* Per length and month, what each face absorbs per MJ of the day's beam and of its sky on level ground: the beam on
     that face through the trees, half the sky through the trees, half the ground's reflection of both. */
  const per = segs.map((s) => {
    const fs = faceShares(material.get(s.id) || 'wood', opts), al = 1 - s.rho;
    const tree = treeLightAt(s, radiation, grid, (i) => lawn[i] === 1);
    const sides = Array.from({ length: 12 }, (_, m) => faceBeamSides(s, lat, lng, m));
    return { fs, al, tree, sides };
  });
  const reflSky = new Float32Array(N), sky = new Float32Array(N), beam = Array.from({ length: 12 }, () => new Float32Array(N));
  // the month's sky term needs its own array (the trees' sky share moves with the leaves)
  const skyM = Array.from({ length: 12 }, () => new Float32Array(N));
  let seen = 0;
  list.forEach((i, p) => {
    const v = views[p];
    if (!v) return;
    seen++;
    reflSky[i] = reflectedSky(v, segs);
    for (const { s, F, side } of v) {
      const { fs, al, tree, sides } = per[s];
      for (let m = 0; m < 12; m++) {
        const tb = tree.beam[m], tk = tree.sky[m];
        // the face this spot sees, and the far one (side 1: the face the normal points out of)
        const [pos, neg] = sides[m];
        const bSeen = side > 0 ? pos : neg, bFar = side > 0 ? neg : pos;
        const kSeen = F * al * fs.seen, kFar = F * al * fs.far;
        // per MJ of beam on level ground: the faces' beam through the trees, and the ground's reflection of it (half to each face)
        beam[m][i] += kSeen * (bSeen * tb + 0.5 * alb * tb) + kFar * (bFar * tb + 0.5 * alb * tb);
        // per MJ of sky on level ground: half the sky on each face through the trees, and half its reflection off the ground
        skyM[m][i] += (kSeen + kFar) * (0.5 * tk + 0.5 * alb * tk);
      }
    }
    sky[i] = skyM[6][i];
  });
  return { lengths: segs.length, fences: recs.length, seen, reflSky, beam, sky, skyM, treeLit: per.map((q) => ({ beam: q.tree.beam.map((v) => Math.round(v * 100) / 100), sky: q.tree.sky.map((v) => Math.round(v * 100) / 100) })) };
}
