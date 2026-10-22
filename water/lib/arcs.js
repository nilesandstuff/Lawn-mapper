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

import { unEnu, enu as enuOf } from './heads.js';

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

/*
 * EVERY ADJUSTABLE HEAD FITTED TOGETHER (owner, 2026-10-21: "for heads with an adjustable arc, let's
 * automatically try to fit the correct arc for best head to head coverage and max coverage of the lawn").
 *
 * Head-to-head coverage is the rule designers space heads by: every piece of lawn inside the throw of two or
 * more heads, each head's water reaching the next. So the lawn round the heads is cut into half-metre cells,
 * and each cell is worth something by how many heads reach it:
 *
 *   lawn          the first head 1, the second 0.5 (head to head), a third 0.3, more 0.1
 *   building or   -2 a head (water on a wall or a drive is lost, and the reason an arc is turned)
 *   paving
 *   other ground  -0.05 a head: beds and woods may take a sprinkler's water (owner, 2026-10-21: "arc finding
 *                 can hit woods and flower beds"); the small cost only breaks ties toward less waste
 *
 * weighted by the area each sample stands for, and each head of its zone that a head's water reaches is worth
 * NEIGHBOUR_GAIN more (the rule itself: water from each head reaching the next). A head's arc and throw are then the window of directions,
 * within its nozzle's range, and the throw (full down to MIN_THROW, the radius screw) that add the most, given every other head where it is; heads are fitted in turn, three
 * rounds, each starting from the last. A fixed pattern is only turned; a full circle and a strip are left to
 * autoArc; a head the person set (fixed) stays as they set it and counts as it is. Pure.
 *
 * heads: [{ id, at [lng, lat], zone, radiusM, nozzle { arcFixed, arcMin, arcMax, strip }, dir, arc, throw, fixed }]
 * ground(at) -> 'lawn' | 'hard' | 'other' | null. -> Map id -> { dir, arc, throw }
 */
export const FIT_CELL_M = 0.5, FIT_ROUNDS = 3;
const LAWN_GAIN = [1, 0.5, 0.3, 0.1], HARD_GAIN = -2, OTHER_GAIN = -0.05;
/* each neighbouring head (same zone) a head's water reaches: head to head, the designer's rule, worth this many
   square metres of lawn; it keeps an edge head's arc reaching the heads either side of it */
export const NEIGHBOUR_GAIN = 4;

export function fitArcs(heads, ground, { only = null } = {}) {
  const B = 360 / BIN_DEG, out = new Map();
  const live = heads.filter((h) => h.radiusM > 0 && Array.isArray(h.at));
  if (!live.length) return out;
  const o = live[0].at;
  const cellGround = new Map();
  const groundOf = (key, e, n) => {
    if (!cellGround.has(key)) cellGround.set(key, ground(unEnu(o, [e, n])));
    return cellGround.get(key);
  };
  // each head's samples: per bin, [{ key, w, f (fraction of the throw), g }]
  const plan = new Map(), neighbours = new Map();
  for (const h of live) {
    const [he, hn] = enuOf(o, h.at), R = h.radiusM, J = Math.max(4, Math.ceil(R / 0.4));
    const bins = [];
    for (let k = 0; k < B; k++) {
      const t = ((k + 0.5) * BIN_DEG * Math.PI) / 180, list = [];
      for (let j = 0; j < J; j++) {
        const f = (j + 0.5) / J, r = f * R, e = he + Math.sin(t) * r, n = hn + Math.cos(t) * r;
        const ce = Math.floor(e / FIT_CELL_M), cn = Math.floor(n / FIT_CELL_M), key = `${ce},${cn}`;
        list.push({ key, w: r * (R / J) * ((BIN_DEG * Math.PI) / 180), f, g: groundOf(key, (ce + 0.5) * FIT_CELL_M, (cn + 0.5) * FIT_CELL_M) });
      }
      bins.push(list);
    }
    plan.set(h.id, bins);
    // its neighbours: the heads of its zone within its throw, by direction (the bins either side of it)
    const near = [];
    for (const o2 of live) {
      if (o2 === h || (h.zone != null && o2.zone != null && o2.zone !== h.zone)) continue;
      const [e2, n2] = enuOf(o, o2.at), d = Math.hypot(e2 - he, n2 - hn);
      if (d < 0.5 || d > R) continue;
      const b = ((Math.atan2(e2 - he, n2 - hn) * 180) / Math.PI + 360) % 360;
      near.push({ f: d / R, bins: [Math.floor(((b - BIN_DEG / 2 + 360) % 360) / BIN_DEG), Math.floor(((b + BIN_DEG / 2) % 360) / BIN_DEG)] });
    }
    neighbours.set(h.id, near);
  }
  const cover = new Map(), mine = new Map();
  const sectorOf = (h) => {
    if (h.nozzle?.strip) return null;
    const arc = Number.isFinite(h.nozzle?.arcFixed) ? h.nozzle.arcFixed : Number.isFinite(h.arc) ? h.arc : 360;
    const len = Math.max(1, Math.min(B, Math.round(arc / BIN_DEG)));
    const start = len >= B ? 0 : Math.round(((((h.dir ?? 0) - arc / 2) % 360) + 360) % 360 / BIN_DEG) % B;
    return { start, len, throw: h.throw ?? 1 };
  };
  const add = (id, s) => {
    const cells = new Set(), bins = plan.get(id);
    for (let k = 0; k < s.len; k++) for (const p of bins[(s.start + k) % B]) if (p.f <= s.throw + 1e-9) cells.add(p.key);
    for (const c of cells) cover.set(c, (cover.get(c) || 0) + 1);
    mine.set(id, cells);
  };
  const remove = (id) => { for (const c of mine.get(id) || []) cover.set(c, cover.get(c) - 1); mine.delete(id); };
  const gainOf = (p) => (p.g === 'lawn' ? LAWN_GAIN[Math.min(3, cover.get(p.key) || 0)] : p.g === 'hard' ? HARD_GAIN : OTHER_GAIN);
  const free = (h) => !h.fixed && (!only || only.has(h.id)) && !h.nozzle?.strip && !(Number.isFinite(h.nozzle?.arcFixed) && h.nozzle.arcFixed >= 360);
  // the heads that stay as they are count from the start; the rest go in one at a time
  const cur = new Map();
  for (const h of live) { const s = sectorOf(h); if (s && !free(h)) { add(h.id, s); cur.set(h.id, s); } }
  /* a head's arc AND throw together: the radius screw shortens the whole head, so a sector that would reach the
     house can be kept by throwing shorter rather than turned away; throws from full down to MIN_THROW */
  const THROWS = [1, 0.95, 0.9, 0.85, 0.8, 0.75].filter((t) => t >= MIN_THROW - 1e-9);
  const fit = (h) => {
    const bins = plan.get(h.id);
    const fixed = Number.isFinite(h.nozzle?.arcFixed) ? Math.round(h.nozzle.arcFixed / BIN_DEG) : null;
    const lo = fixed ?? Math.max(1, Math.ceil((Number.isFinite(h.nozzle?.arcMin) ? h.nozzle.arcMin : BIN_DEG) / BIN_DEG));
    const hi = fixed ?? Math.min(B, Math.floor((Number.isFinite(h.nozzle?.arcMax) ? h.nozzle.arcMax : 360) / BIN_DEG));
    let best = null;
    for (const T of h.fixedThrow ? [h.throw ?? 1] : THROWS) {
      const gain = bins.map((list) => list.reduce((t, p) => (p.f <= T + 1e-9 ? t + p.w * gainOf(p) : t), 0));
      const nbs = neighbours.get(h.id).filter((nb) => nb.f <= T + 1e-9);
      for (let len = lo; len <= hi; len++) {
        for (let start = 0; start < (len >= B ? 1 : B); start++) {
          let t = 0;
          for (let k = 0; k < len; k++) t += gain[(start + k) % B];
          // a neighbour on the arc's edge counts once, from either side
          for (const nb of nbs) if (nb.bins.some((k) => (k - start + B) % B < len)) t += NEIGHBOUR_GAIN;
          // a wider arc or a longer throw must add something real; on a tie, the narrower and the longer throw
          if (!best || t > best.t + 1e-6 * (1 + Math.abs(best.t))) best = { start, len, t, throw: T };
        }
      }
    }
    return { start: best.start, len: best.len, throw: best.throw };
  };
  const todo = live.filter(free);
  for (let round = 0; round < FIT_ROUNDS; round++) {
    let moved = false;
    for (const h of todo) {
      if (cur.has(h.id)) remove(h.id);
      const s = fit(h), was = cur.get(h.id);
      if (!was || was.start !== s.start || was.len !== s.len || was.throw !== s.throw) moved = true;
      cur.set(h.id, s); add(h.id, s);
    }
    if (!moved) break;
  }
  for (const h of todo) {
    const s = cur.get(h.id), arc = s.len * BIN_DEG;
    out.set(h.id, { dir: s.len >= B ? 0 : ((s.start * BIN_DEG + arc / 2) % 360), arc: Number.isFinite(h.nozzle?.arcFixed) ? h.nozzle.arcFixed : arc, throw: s.throw });
  }
  return out;
}
