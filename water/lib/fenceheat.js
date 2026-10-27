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
 *   WARMING. A sunlit board runs warmer than the air by what it absorbs over what its two faces shed (a thin board:
 *   both faces at one temperature): dT = absorptance x the sun on it / h, h = 2 x (5.7 + 3.8 u + 4 eps sigma T^3)
 *   (McAdams' convection on a flat plate, u the wind at the fence; the radiative part linearised). The grass a face
 *   fills a share F of the sky of takes F x 4 eps sigma T^3 x dT more longwave than from a fence at air temperature.
 *   So per day, extra MJ/m2 = F x c x absorptance x (the sun's beam and sky on the board, both faces), c = 4 eps
 *   sigma T^3 / h, the sun on the board from the day's beam and sky with the month's sun path.
 */
import { cleanFences, fencesOnGrid, faceViews, reflectedSky } from './shade/fences.js';
import { sunPath, clearSky } from './shade/sun.js';
import { toMerc } from './shade/ept.js';

export const FENCE_HEAT = { windMs: 1.5, emissivity: 0.9, tK: 295, groundAlbedo: 0.2 };

/** c: extra longwave MJ on the grass per MJ the board absorbs, per unit view factor (about 0.16 at 1.5 m/s). */
export function heatShare({ windMs, emissivity, tK } = FENCE_HEAT) {
  const r = 4 * emissivity * 5.670e-8 * tK ** 3;
  return r / (2 * (5.7 + 3.8 * windMs + r));
}

/** A length's beam on its two faces over a mid-month day, per unit of beam on level ground (clear-sky weighting). */
export function faceBeamRatio(seg, lat, lng, month, year = 2025) {
  const path = sunPath(lat, lng, Date.UTC(year, month, 15, 12), 20);
  let face = 0, flat = 0;
  for (const s of path) {
    const { dni } = clearSky(s.elevation);
    face += dni * Math.abs(s.dir[0] * seg.nE + s.dir[1] * seg.nN);
    flat += dni * s.dir[2];
  }
  return flat > 0 ? face / flat : 0;
}

/**
 * For the cells `cells` (indices into the grid { W, H, bbox (3857), cell (m) }, ground z per cell):
 * -> null without fences, else { lengths, seen (cells seeing a face), reflSky: Float32Array(N) (the reflected
 *    skylight counted as sky, to take out of the longwave sky view), beam: [12 Float32Array(N)], sky: Float32Array(N)
 *    (extra MJ/m2 of longwave per MJ/m2 of the day's beam and of its skylight on level ground) }
 */
export function fenceRadiation(fences, grid, z, cells, lat, lng, opts = FENCE_HEAT) {
  const recs = cleanFences(fences);
  if (!recs.length) return null;
  const { W, H, bbox } = grid, N = W * H, cm = grid.cell || 1;
  const cellMerc = (bbox[2] - bbox[0]) / W;
  const toCell = (p) => { const [mx, my] = toMerc(p); return [(mx - bbox[0]) / cellMerc, (bbox[3] - my) / cellMerc]; };
  const groundAt = (gx, gy) => { const c = Math.max(0, Math.min(W - 1, Math.floor(gx))), r = Math.max(0, Math.min(H - 1, Math.floor(gy))); const v = z[r * W + c]; return Number.isFinite(v) ? v : 0; };
  const segs = fencesOnGrid(recs, toCell, groundAt, cm);
  if (!segs.length) return null;
  const list = Array.from(cells);
  const xy = new Float32Array(list.length * 2);
  list.forEach((i, p) => { xy[2 * p] = (i % W) + 0.5; xy[2 * p + 1] = Math.floor(i / W) + 0.5; });
  const views = faceViews(segs, xy, groundAt, cm);
  const c = heatShare(opts);
  const alpha = segs.map((s) => 1 - s.rho);
  const ratio = segs.map((s) => Array.from({ length: 12 }, (_, m) => faceBeamRatio(s, lat, lng, m)));
  const reflSky = new Float32Array(N), sky = new Float32Array(N), beam = Array.from({ length: 12 }, () => new Float32Array(N));
  let seen = 0;
  list.forEach((i, p) => {
    const v = views[p];
    if (!v) return;
    seen++;
    reflSky[i] = reflectedSky(v, segs);
    for (const { s, F } of v) {
      const k = F * c * alpha[s];
      // the sky on both faces (half the sky each), and the ground's reflection on both
      sky[i] += k * (1 + opts.groundAlbedo);
      for (let m = 0; m < 12; m++) beam[m][i] += k * (ratio[s][m] + opts.groundAlbedo);
    }
  });
  return { lengths: segs.length, fences: recs.length, seen, reflSky, beam, sky };
}
