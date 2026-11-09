/**
 * WHERE THE TREE TRUNKS ARE (water session, 2026-11-04; owner: "A pre requisite to that [tree roots] is knowing
 * where tree trunks are"). Nothing of the shade map's changes: its crown finder (shade/crowns.js, linked here) gives
 * each crown's top, height and radius on the water map's own 1 m grid; this module adds the one thing it does not
 * look for, THE STEM UNDER THE CROWN.
 *
 *   1. Crowns: crownsOf on the columns the shared rule (shade/structures.js) does not call a building or a low
 *      structure: local maxima of the pit-free canopy height model, flooded downhill (the shade map's method).
 *   2. Stem: returns STEM_LO to STEM_HI m over the ground, and under 0.4 of the crown's height, inside the crown's
 *      columns. A trunk is hit now and then by an airborne laser (more on a leaf-off flight), a crown's underside
 *      almost never that low. The 3 x 3 block of columns with the most such returns, STEM_MIN or more, is the stem;
 *      the trunk is the mean of those returns.
 *   3. Without a stem, the trunk is the crown's top (an open-grown tree's top stands over its trunk), marked so.
 *      A crown may hold several stems STEM_APART m or more apart (a wide leaf-off crown is often two or three
 *      trees the canopy model could not part), at most one per STEM_AREA_M2 of crown; each is a trunk, and the
 *      crown's area is shared among them. (On the owner's lot's leaf-off flight the rule without that cap put 84
 *      trunks within 35 m of the house: shrubs, fence posts and low branches under the crowns pass as stems too.)
 *      A stem must also stand within max(3 m, 0.4 R) of the crown's top: against the owner's 7 marked trunks the
 *      stems farther out than that were all wrong (H79).
 *
 * MEASURED: not yet. H32 (2026-10-22) scored crown tops against the core's photo-traced crowns: inside the right
 * crown 53-60%, a median 3.8 m from the crown's centre -- a floor, those were crowns, not trunks. The readings
 * page's trunk marks are the ground truth to score this against (FINDINGS when done). Under CLAUDE.md "One way
 * to read lidar" a rule about what a point is has one home: once measured this goes to the shade session to adopt,
 * and the water map imports it back from there.
 *
 *   trunksOf(cols, bbox, lat, { built }) -> { w, h, lab, trunks: [{ id, crown, x, y, lng, lat, H, R (this trunk's
 *   share of the crown, as a radius), crownR, drop, how: 'stem' | 'top', stemReturns, stemsInCrown, top: { x, y },
 *   centre: { x, y } }] }   (x, y in EPSG:3857; cols as las.js makes them)
 */

import { gridOver, cellOf } from './shade/grid.js';
import { structuresFrom, flagStrays, BUILDING, STRUCTURE, NOISE } from './shade/structures.js';
import { crownsOf } from './shade/crowns.js';
import { fromMerc } from './ept.js';

export const TRUNK = {
  minH: 4,          // a crown this tall or taller (the shade map's crownsOf default)
  stemLo: 0.5,      // a stem return stands this far over the ground (under it: grass, the ground's own scatter)
  stemHi: 3.0,      // and no higher than this
  stemShareOfH: 0.4, // nor above this share of the crown's height (a low crown's underside)
  stemMin: 3,       // returns in the 3 x 3 block, at least
  stemApart: 3,     // two stems in one crown stand at least this far apart (m): closer is one trunk's returns
  stemSpreadM: 1.0, // a stem's returns stand within this (RMS radius, m) of each other: a trunk is narrow
  stemAlso: 0.5,    // a further stem in the same crown needs at least this share of the strongest's returns
  stemAreaM2: 25,   // and a crown holds at most one trunk per this many square metres (R 2.8 m each: a close wood)
  nearTopShare: 0.4, // a stem counts only within this share of the crown's radius of its top...
  nearTopMinM: 3,   // ...or this many metres, whichever is more (the owner's 7 marks, 2026-11-05: H79)
};

export function trunksOf(cols, bbox, lat, { built = null, green = null, opts = TRUNK } = {}) {
  const grid = gridOver(bbox, 1, lat);
  if (!built) flagStrays(cols, grid); // as the shade map does before it reads the columns (shadeRoofs did it already when `built` is given)
  const st = built || structuresFrom(cols, grid, { green });
  const { model, kind, stats } = st, { w, h, ground } = model, N = w * h;
  // the top of what is not built: the crown finder's canopy height model
  const top = new Float32Array(N).fill(NaN);
  for (let k = 0; k < N; k++) if (stats.above[k] && kind[k] !== BUILDING && kind[k] !== STRUCTURE) top[k] = stats.zHi[k] - ground[k];
  const { lab, crowns } = crownsOf(cols, model, { top, minH: opts.minH });
  // stem returns per column
  const n = new Uint16Array(N), sx = new Float64Array(N), sy = new Float64Array(N), sxx = new Float64Array(N), syy = new Float64Array(N);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i]);
    if (k < 0 || lab[k] < 0 || !Number.isFinite(ground[k])) continue;
    const o = cols.z[i] - ground[k], c = crowns[lab[k]];
    if (o < opts.stemLo || o > Math.min(opts.stemHi, opts.stemShareOfH * c.H)) continue;
    n[k]++; sx[k] += cols.x[i]; sy[k] += cols.y[i]; sxx[k] += cols.x[i] * cols.x[i]; syy[k] += cols.y[i] * cols.y[i];
  }
  const kM = Math.cos((lat * Math.PI) / 180); // 3857 m -> m
  const centre = (k) => ({ x: grid.x0 + ((k % w) + 0.5) * grid.cell, y: grid.y1 - (((k / w) | 0) + 0.5) * grid.cell });
  const sums = crowns.map(() => ({ x: 0, y: 0, n: 0 }));
  for (let k = 0; k < N; k++) if (lab[k] >= 0) { const c = centre(k); const s = sums[lab[k]]; s.x += c.x; s.y += c.y; s.n++; }
  /* Stems: the 3 x 3 block sums of stem returns, per crown; every local maximum of STEM_MIN or more is a stem, the
     strongest first and none within STEM_APART m of a stronger one. A wide crown on a leaf-off flight is often two
     or three trees the canopy model could not part (the owner's lot: crowns 9-10 m across with a stem 10-18 m from
     the top), so a crown may hold several trunks; each takes a share of the crown's area. */
  const blk = new Uint16Array(N);
  for (let k = 0; k < N; k++) {
    if (lab[k] < 0) continue;
    const id = lab[k], x = k % w, y = (k / w) | 0;
    let tot = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (lab[j] === id) tot += n[j];
    }
    blk[k] = tot;
  }
  const cands = crowns.map(() => []);
  for (let k = 0; k < N; k++) if (lab[k] >= 0 && blk[k] >= opts.stemMin) cands[lab[k]].push(k);
  const trunks = [];
  crowns.forEach((c, id) => {
    const topAt = centre(c.apex), s = sums[id], mid = s.n ? { x: s.x / s.n, y: s.y / s.n } : topAt;
    const stems = [];
    for (const k of cands[id].sort((a, b) => blk[b] - blk[a] || a - b)) {
      const x = k % w, y = (k / w) | 0;
      let X = 0, Y = 0, XX = 0, YY = 0, M = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (lab[j] === id) { X += sx[j]; Y += sy[j]; XX += sxx[j]; YY += syy[j]; M += n[j]; }
      }
      const mx = X / M, my = Y / M, rms = Math.sqrt(Math.max(0, XX / M - mx * mx + YY / M - my * my)) * kM;
      // the same trunk seen from an overlapping block, or a neighbour closer than two trunks stand: one stem
      if (stems.some((q) => Math.hypot(q.X - mx, q.Y - my) * kM < opts.stemApart)) continue;
      // a trunk is narrow: its returns stand within a metre of each other; a crown's underside spreads over the block
      if (rms > opts.stemSpreadM) continue;
      // and it stands near the crown's top: the stems found 4.6-12.6 m from the top on the owner's lot were all
      // somewhere no trunk was marked, the right ones 1.6-3.4 m from it (H79; fitted on 7 marks, not yet checked on others)
      if (Math.hypot(mx - topAt.x, my - topAt.y) * kM > Math.max(opts.nearTopMinM, opts.nearTopShare * c.R)) continue;
      // a second stem in the crown must be as strong as the first (its low branches and shrubs give a few returns too)
      if (stems.length && (blk[k] < opts.stemAlso * stems[0].n || stems.length >= Math.max(1, Math.floor(c.n / opts.stemAreaM2)))) break;
      stems.push({ x, y, X: mx, Y: my, n: blk[k], rms });
    }
    const share = Math.max(1, stems.length);
    const one = (x, y, how, stemReturns, part) => {
      const [lng, la] = fromMerc([x, y]);
      return { id: part ? `${id}.${part}` : id, crown: id, H: c.H, R: c.R / Math.sqrt(share), crownR: c.R, drop: c.drop, how, stemReturns, stemsInCrown: stems.length, top: topAt, centre: mid, x, y, lng, lat: la };
    };
    if (!stems.length) trunks.push(one(topAt.x, topAt.y, 'top', cands[id].length ? Math.max(...cands[id].map((k) => blk[k])) : 0, 0));
    else stems.forEach((q, i) => trunks.push(one(q.X, q.Y, 'stem', q.n, i)));
  });
  // each crown on its own (the tree roots' draw centres on the crown, not the trunk: owner, 2026-11-09):
  // its middle (the mean of its columns, in 3857), its radius and area (1 m columns), its height
  const crownList = crowns.map((c, id) => ({ id, cx: sums[id].n ? sums[id].x / sums[id].n : centre(c.apex).x, cy: sums[id].n ? sums[id].y / sums[id].n : centre(c.apex).y, R: c.R, A: c.n, H: c.H }));
  return { w, h, lab, trunks, crowns: crownList };
}
