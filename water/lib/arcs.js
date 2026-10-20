/**
 * EACH HEAD'S ARC, SET FOR THE LAWN (water session; owner, 2026-10-20: "display the arcs... the distance is
 * informed by the dynamic pressure and gpm nozzle. Automatically render the arcs to show the maximum coverage
 * and most even overlap. Show those arcs to the user and let them adjust the arcs if needed").
 *
 * From a head, every 5 degrees, a ray out to its throw (its nozzle's radius at the pressure the head gets,
 * lib/hydraulics.js) is sampled: how much lands on lawn, how much on a building or paving. Then:
 *
 *   an adjustable nozzle  the widest unbroken run of directions that water lawn and spare the hard surfaces,
 *                         within the nozzle's own arc range, centred on that run
 *   a fixed pattern       (a quarter, a half...) turned to the window that waters the most lawn and throws the
 *                         least onto hard surfaces
 *   a strip               turned the same way, its rectangle sampled
 *   the throw             shortened, no further than MIN_THROW (the radius screw's usual limit), where it would
 *                         otherwise reach a building or paving inside the arc
 *
 * Even overlap -- head to head, each head's water reaching the next -- is what a designer spaces heads for;
 * the heads are where they are, so what is left to set is the arc and the throw, and the precipitation map
 * (lib/precip.js) shows what overlap results. Pure: positions [lng, lat], ground(at) -> 'lawn' | 'hard' |
 * 'other' | null (off the map).
 */

import { unEnu } from './heads.js';

export const BIN_DEG = 5, MIN_THROW = 0.75;
const FRACTIONS = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0];

/** A point `m` metres from `at` toward `deg` (clockwise from north). */
const toward = (at, deg, m) => unEnu(at, [Math.sin((deg * Math.PI) / 180) * m, Math.cos((deg * Math.PI) / 180) * m]);

/** Every BIN_DEG: { deg, lawn (share of the ray on lawn), hard (share on a building or paving), firstHard (the
    nearest fraction of the throw that is hard, or 1) }. */
export function rays(at, radiusM, ground) {
  const out = [];
  for (let k = 0; k < 360 / BIN_DEG; k++) {
    const deg = (k + 0.5) * BIN_DEG;
    let lawn = 0, hard = 0, firstHard = 1;
    for (const f of FRACTIONS) {
      const g = ground(toward(at, deg, f * radiusM));
      if (g === 'lawn') lawn++;
      else if (g === 'hard') { hard++; if (f < firstHard) firstHard = f; }
    }
    out.push({ deg, lawn: lawn / FRACTIONS.length, hard: hard / FRACTIONS.length, firstHard });
  }
  return out;
}

const score = (r) => r.lawn - 2 * r.hard;
const good = (r) => r.lawn >= 0.5 && r.hard <= 0.15;

/** The best window of `w` bins (circular): -> { start, sum } */
function bestWindow(rs, w) {
  const n = rs.length;
  let best = { start: 0, sum: -Infinity };
  for (let s = 0; s < n; s++) {
    let sum = 0;
    for (let k = 0; k < w; k++) sum += score(rs[(s + k) % n]);
    if (sum > best.sum + 1e-9) best = { start: s, sum };
  }
  return best;
}

/** The longest circular run of good bins: -> { start, len, sum } or null */
function longestRun(rs) {
  const n = rs.length;
  if (rs.every(good)) return { start: 0, len: n, sum: rs.reduce((t, r) => t + score(r), 0) };
  let best = null;
  for (let s = 0; s < n; s++) {
    if (!good(rs[s]) || good(rs[(s - 1 + n) % n])) continue; // a run starts here
    let len = 0, sum = 0;
    while (len < n && good(rs[(s + len) % n])) { sum += score(rs[(s + len) % n]); len++; }
    if (!best || len > best.len || (len === best.len && sum > best.sum)) best = { start: s, len, sum };
  }
  return best;
}

/** How far the throw may go over the bins it waters before it reaches a hard surface. */
function throwFor(rs, start, len) {
  let nearest = 1;
  for (let k = 0; k < len; k++) nearest = Math.min(nearest, rs[(start + k) % rs.length].firstHard);
  return nearest >= 1 ? 1 : Math.max(MIN_THROW, Math.min(1, nearest - 0.05));
}

/**
 * The arc for one head. nozzle: { arcFixed, arcMin, arcMax, strip }; radiusM: its throw.
 * -> { dir (degrees clockwise from north, the middle of the arc), arc (degrees; null for a strip), throw (0.75-1),
 *      lawnShare (of the watered ground, sampled), hardShare }
 */
export function autoArc(at, radiusM, nozzle, ground) {
  if (!(radiusM > 0)) return null;
  const n = 360 / BIN_DEG;
  if (nozzle?.strip) {
    // a strip: the rectangle turned to the most lawn
    const L = radiusM, W = (nozzle.strip.widthFt || 4) / 3.2808, type = nozzle.strip.type;
    let best = null;
    for (let k = 0; k < n; k++) {
      const dir = k * BIN_DEG;
      let lawn = 0, hard = 0, m = 0;
      for (const a of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const b of [-0.4, 0, 0.4]) {
        const along = type === 'center' ? (a - 0.5) * L : type === 'side' ? (b + 0.5) * W * 2 : a * L;
        const across = type === 'side' ? (a - 0.5) * L : b * W;
        const p = unEnu(at, [Math.sin((dir * Math.PI) / 180) * along + Math.cos((dir * Math.PI) / 180) * across, Math.cos((dir * Math.PI) / 180) * along - Math.sin((dir * Math.PI) / 180) * across]);
        const g = ground(p); m++;
        if (g === 'lawn') lawn++; else if (g === 'hard') hard++;
      }
      const s = (lawn - 2 * hard) / m;
      if (!best || s > best.s) best = { dir, s, lawnShare: lawn / m, hardShare: hard / m };
    }
    return { dir: best.dir, arc: null, throw: 1, lawnShare: best.lawnShare, hardShare: best.hardShare };
  }
  const rs = rays(at, radiusM, ground);
  const fixed = Number.isFinite(nozzle?.arcFixed) ? nozzle.arcFixed : null;
  const lo = fixed ?? (Number.isFinite(nozzle?.arcMin) ? Math.max(nozzle.arcMin, BIN_DEG) : 45), hi = fixed ?? (Number.isFinite(nozzle?.arcMax) ? nozzle.arcMax : 360);
  let start, len;
  if (fixed === null) {
    const run = longestRun(rs);
    if (run && run.len === n && hi >= 360) { start = 0; len = n; }
    else if (run) {
      len = Math.max(Math.ceil(lo / BIN_DEG), Math.min(Math.floor(hi / BIN_DEG), run.len));
      start = run.len >= len ? run.start + Math.floor((run.len - len) / 2) : bestWindow(rs, len).start;
    } else { len = Math.max(Math.ceil(lo / BIN_DEG), Math.min(Math.floor(hi / BIN_DEG), 90 / BIN_DEG)); start = bestWindow(rs, len).start; }
  } else if (fixed >= 360) { start = 0; len = n; }
  else { len = Math.round(fixed / BIN_DEG); start = bestWindow(rs, len).start; }
  const arc = fixed ?? len * BIN_DEG;
  const dir = len >= n ? 0 : ((start + len / 2) * BIN_DEG) % 360;
  let lawn = 0, hard = 0;
  for (let k = 0; k < len; k++) { lawn += rs[(start + k) % n].lawn; hard += rs[(start + k) % n].hard; }
  return { dir, arc, throw: throwFor(rs, start, len), lawnShare: lawn / len, hardShare: hard / len };
}
