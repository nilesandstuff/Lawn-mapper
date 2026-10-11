/**
 * DOES THE LIDAR LAND ON THE PHOTO'S GROUND? (shade map, features session)
 *
 * The lidar has to land on the ground of the photo the lawn was traced on:
 * Mapbox's, or a county photo's as the editor lined it up (shade.js decides
 * which, from the saved map). This measures how far off it is from ANY photo
 * of a frame, and says how sure it is.
 *
 * WHAT IS COMPARED. The lidar's GROUND INTENSITY: how brightly each patch of
 * ground returned the laser. Asphalt, concrete and grass return differently,
 * so roads, kerbs, drives and paths draw the same lines they draw in the
 * photo. It is a true orthophoto -- every return is at its real x, y -- so it
 * has no lean of its own. Lines are compared, not brightness (register.js's
 * edge-orientation features, used unchanged), because a road can be dark to
 * the laser and pale in the photo.
 *
 * ONLY OPEN GROUND VOTES. Roofs and crowns lean in the photo by up to metres
 * (H63), in a direction that has nothing to do with the ground's offset. So
 * every cell the lidar says is roof or canopy, and a margin around it big
 * enough to cover the lean, is left out of the comparison on BOTH sides.
 *
 * WHY NOT register.js's PATCHES. Tried first (2026-10-10, five lots from
 * H63): QL2 lidar holds one or two ground returns a square metre, so a 9 m
 * patch has too little in it; 5-10% of patches agreed, and three clouds over
 * one Massachusetts lot gave three answers 1.6 m apart. Here the whole frame's
 * open ground is matched at once -- a curving road alone pins both axes --
 * and the frame's four quarters are then matched on their own. Their
 * scatter is the error bar, and an answer is only applied when that error
 * is under 20 cm; otherwise it is shown, labelled, and not applied.
 */

import { orientationFeatures } from '../lib/register.js';
import { gridForFrame, rasterise, fillGaps, blurNaN, resample, greyPicture, greyCentred } from './grid.js';
import { mercScale } from './ept.js';

/** Normalised correlation of two feature sets, mov displaced by (dx, dy) cells, over a window. */
function score(R, M, dx, dy, x0, y0, x1, y1) {
  const w = R.w;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const ya = Math.max(y0, -dy), yb = Math.min(y1, R.h - dy);
  const xa = Math.max(x0, -dx), xb = Math.min(x1, R.w - dx);
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = y * w + x, j = (y + dy) * w + (x + dx);
      if (!R.valid[i] || !M.valid[j]) continue;
      const a1 = R.c1[i], a2 = R.c2[i], b1 = M.c1[j], b2 = M.c2[j];
      n += 2; sa += a1 + a2; sb += b1 + b2;
      saa += a1 * a1 + a2 * a2; sbb += b1 * b1 + b2 * b2; sab += a1 * b1 + a2 * b2;
    }
  }
  if (n < 200) return { s: -1, n };
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  if (va <= 1e-9 || vb <= 1e-9) return { s: -1, n };
  return { s: (sab - (sa * sb) / n) / Math.sqrt(va * vb), n };
}

const parabola = (m, c, p) => {
  const d = m - 2 * c + p;
  return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / d)) : 0;
};

/**
 * The displacement (cells, sub-cell) that best lines mov up with ref inside
 * a window, searched over +-r cells around (cx, cy) in steps of `step`, then
 * refined. `second` is the best score at least `apart` cells away: a peak
 * that barely beats something far away is a guess.
 */
export function bestShift(R, M, win, { cx = 0, cy = 0, r = 10, step = 2, apart = 4 } = {}) {
  const [x0, y0, x1, y1] = win;
  const seen = [];
  let best = null;
  for (let dy = cy - r; dy <= cy + r; dy += step) {
    for (let dx = cx - r; dx <= cx + r; dx += step) {
      const { s } = score(R, M, dx, dy, x0, y0, x1, y1);
      seen.push([dx, dy, s]);
      if (!best || s > best.s) best = { dx, dy, s };
    }
  }
  if (!best || best.s <= -1) return null;
  for (let dy = best.dy - step + 1; dy <= best.dy + step - 1; dy++) {
    for (let dx = best.dx - step + 1; dx <= best.dx + step - 1; dx++) {
      const { s } = score(R, M, dx, dy, x0, y0, x1, y1);
      if (s > best.s) best = { dx, dy, s };
    }
  }
  const at = (dx, dy) => score(R, M, dx, dy, x0, y0, x1, y1).s;
  const fx = parabola(at(best.dx - 1, best.dy), best.s, at(best.dx + 1, best.dy));
  const fy = parabola(at(best.dx, best.dy - 1), best.s, at(best.dx, best.dy + 1));
  /* The rival: the best LOCAL maximum of the coarse search away from the
     peak, or the rim of the search if there is none -- not the peak's own
     shoulder, which on smoothed features is wide and says nothing. */
  const at0 = new Map(seen.map(([x, y, v]) => [`${x},${y}`, v]));
  let second = -1;
  for (const [dx, dy, s] of seen) {
    if (Math.max(Math.abs(dx - best.dx), Math.abs(dy - best.dy)) < apart) continue;
    let isMax = true;
    for (let j = -1; j <= 1 && isMax; j++) {
      for (let i = -1; i <= 1; i++) {
        const v = at0.get(`${dx + i * step},${dy + j * step}`);
        if ((i || j) && v !== undefined && v > s) { isMax = false; break; }
      }
    }
    const rim = Math.abs(dx - cx) >= r - step + 1 || Math.abs(dy - cy) >= r - step + 1;
    if ((isMax || rim) && s > second) second = s;
  }
  return { dx: best.dx + fx, dy: best.dy + fy, score: best.s, second, seen, step };
}

/** Grow a 0/1 mask by r cells (square). */
export function dilate(mask, w, h, r) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = Uint8Array.from(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cur[y * w + x]) continue;
        if ((x > 0 && cur[y * w + x - 1]) || (x < w - 1 && cur[y * w + x + 1])
          || (y > 0 && cur[(y - 1) * w + x]) || (y < h - 1 && cur[(y + 1) * w + x])) next[y * w + x] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Line the cloud up with a photo of `frame` (photo = { data, width, height },
 * RGBA, any pixel size covering exactly the frame).
 *
 * `pre` is a shift already decided ([dx, dy], EPSG:3857 metres; datum.js's
 * correction), applied before matching, so what comes back is what is LEFT.
 *
 * Returns
 *   east, north     real metres to move the (pre-shifted) LIDAR onto the photo's ground
 *   shift           the same as [dx, dy] in EPSG:3857 metres (null unless confident)
 *   confident, why  the verdict, in words
 *   quarters        each quarter's own answer; spreadM their RMS scatter about
 *                   the whole; errorM that over sqrt(quarters), the error bar
 *   score, second   the whole frame's peak and its best rival
 *   openShare       how much of the frame was open ground that could vote
 *   picture         the lidar's ground picture, for showing beside the photo
 */
export function alignToPhoto(cols, frame, photo, {
  cellM = 0.3, rasterM = 0.5, reachM = 4, leanM = 3, tallM = 1.5, maxErrorM = 0.2, minMargin = 0.03, minQuarterScore = 0.12, layer = 'iLow', pre = null,
} = {}) {
  const k = mercScale(frame.lat);
  const widthM = gridForFrame(frame, 1, 1).cell * k;
  const aspect = (frame.height || frame.size) / frame.size;

  /* The lidar's layers on a coarse grid matched to its density. */
  const gw = Math.max(32, Math.round(widthM / rasterM)), gh = Math.max(32, Math.round(gw * aspect));
  const g = gridForFrame(frame, gw, gh);
  const r = rasterise(cols, g, { shift: pre });

  /* The working grid. */
  const w = Math.round(widthM / cellM), h = Math.round(w * aspect);
  const intensity = resample(blurNaN(fillGaps(r[layer], gw, gh, 2), gw, gh, 0.7), gw, gh, w, h);

  /* Open ground: a ground return, nothing tall over it, and clear of
     anything tall by `leanM`. */
  const tall = new Uint8Array(gw * gh);
  const ground = fillGaps(r.zGround, gw, gh, 3);
  const top = fillGaps(r.zTop, gw, gh, 2);
  for (let i = 0; i < gw * gh; i++) {
    /* A sparse cloud leaves many 0.5 m cells empty; an empty cell between
       open ones is open. Tall is what was MEASURED tall, or ground no
       return reached for metres around (under a roof). */
    if (Number.isNaN(ground[i]) || top[i] - ground[i] >= tallM) tall[i] = 1;
  }
  const blocked = dilate(tall, gw, gh, Math.ceil(leanM / rasterM));
  const open = new Uint8Array(w * h);
  let nOpen = 0;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor((y * gh) / h));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, Math.floor((x * gw) / w));
      if (!blocked[gy * gw + gx]) { open[y * w + x] = 1; nOpen++; }
    }
  }

  const R = orientationFeatures(greyCentred(photo.data, photo.width, photo.height, w, h), w, h, { sigma: 1.5, spread: 2 });
  const M = orientationFeatures(intensity, w, h, { sigma: 1.5, spread: 2 });
  for (let i = 0; i < w * h; i++) if (!open[i]) R.valid[i] = 0;
  /* The lidar side is masked by validity only (NaN ground): its own roofs
     are where they really are, and the photo's open cells are matched to
     wherever they land in it. */
  const picture = greyPicture(intensity, w, h);
  const openShare = nOpen / (w * h);
  const out = (o) => ({ picture, grid: { w, h, cellM }, openShare, ...o });

  const reach = Math.ceil(reachM / cellM);
  const all = bestShift(R, M, [0, 0, w, h], { r: reach, step: 2, apart: Math.ceil(1 / cellM) });
  if (!all) return out({ confident: false, why: 'nothing on open ground to match', east: null, north: null, shift: null, quarters: [] });

  /* Each quarter on its own, searched near the whole frame's answer. */
  const qs = [[0, 0, w / 2, h / 2], [w / 2, 0, w, h / 2], [0, h / 2, w / 2, h], [w / 2, h / 2, w, h]]
    .map((q) => q.map(Math.round))
    .map((q) => bestShift(R, M, q, { cx: Math.round(all.dx), cy: Math.round(all.dy), r: Math.ceil(2 / cellM), step: 1, apart: Math.ceil(1 / cellM) }));
  const toM = (s) => s && { east: -s.dx * cellM, north: s.dy * cellM, score: s.score };
  const quarters = qs.map(toM);
  const whole = toM(all);
  /* The error bar: how far the quarters, each matched alone, land from the
     whole frame's answer (root mean square), over the square root of how
     many there are -- a standard error, in metres. */
  const good = quarters.filter((q) => q && q.score >= minQuarterScore);
  const spreadM = good.length
    ? Math.sqrt(good.reduce((t, q) => t + (q.east - whole.east) ** 2 + (q.north - whole.north) ** 2, 0) / good.length)
    : null;
  const errorM = good.length >= 3 ? spreadM / Math.sqrt(good.length) : null;

  const margin = all.score - all.second;
  const confident = margin >= minMargin && errorM !== null && errorM <= maxErrorM;
  const why = margin < minMargin ? 'another match elsewhere is nearly as good: not measured'
    : errorM === null ? `only ${good.length} of 4 quarters had enough open ground to match alone: not measured`
      : confident ? `measured to about ${Math.round(errorM * 100)} cm (the quarters scatter ${spreadM.toFixed(2)} m)`
        : `the quarters scatter ${spreadM.toFixed(2)} m, so the error is about ${errorM.toFixed(2)} m: too loose to apply`;
  return out({
    confident, why,
    east: whole.east, north: whole.north,
    shift: confident ? [whole.east / k, whole.north / k] : null,
    score: all.score, second: all.second, quarters, spreadM, errorM,
  });
}
