/**
 * Scoring one aerial photo's shadows against the shade map's model of the
 * same place (shared by tools/shade-check-naip.js and
 * tools/shade-check-imagery.js). Nothing here is tuned on trees:
 *
 *   1. The sun's position and the photo's offset from the lidar are fitted
 *      on BUILDINGS' shadows alone -- open cells near a roof that, at that
 *      sun, no tree in the model touches.
 *   2. What shadow looks like in this photo is read off buildings too: the
 *      median brightness inside a building's full shadow (S) and in full sun
 *      (L). Brightness runs S + T(L - S) with the share T of the direct
 *      beam, so "under half the beam" -- the model's shade -- is under
 *      (S + L) / 2.
 *   3. Then the trees' shadows are scored: on ground the buildings leave in
 *      sun, any shadow is a tree's.
 *
 *   scorePhoto(site, photo, { suns, leaf })
 *     photo: { bright: Float32Array per model cell, ground: Uint8Array per
 *       model cell (1 = the surface being scored: green grass for a summer
 *       photo, any open ground for a leaf-off one), seen: Uint8Array }
 *     suns: [{ dir, elevation, azimuth, ...label }] to fit among, or a
 *       function (best | null) -> candidates (coarse, then finer).
 *     leaf: 'on' | 'off' -- which model the trees are scored with.
 */

import { beamAt } from './shade-site.js';

export const SHIFT_M = 6; // aerial photos are good to a few meters
const FIT_NEAR_M = 15; // cells this close to a roof fit the sun

export function corr(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };

export function scorePhoto(site, photo, { suns, leaf = 'on', minContrast = 1.8 } = {}) {
  const { model, season } = site, { w, h, nz } = model, N = w * h;
  const { bright, ground, seen } = photo;
  const M = SHIFT_M + 2;
  const cells = [];
  for (let y = M; y < h - M; y++) for (let x = M; x < w - M; x++) {
    const k = y * w + x;
    if (season.kind[k] === 0 && seen[k] && ground[k] && bright[k] > 3) cells.push(k);
  }
  if (cells.length < 300) return { skip: `only ${cells.length} cells of open ground` };

  const muB = new Float32Array(model.mu.length);
  for (let c = 0; c < N; c++) if (season.kind[c] === 1) for (let l = 0; l < nz; l++) muB[c * nz + l] = model.mu[c * nz + l];
  const muTrees = leaf === 'off' ? season.muOff : season.muOn;
  const open = [];
  for (let k = 0; k < N; k++) if (season.kind[k] === 0) open.push(k);
  const where = new Int32Array(N).fill(-1);
  open.forEach((k, i) => { where[k] = i; });

  /* 1. The sun and the offset, from buildings. */
  const roofNear = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (season.kind[y * w + x] !== 1) continue;
    for (let j = -FIT_NEAR_M; j <= FIT_NEAR_M; j++) for (let i = -FIT_NEAR_M; i <= FIT_NEAR_M; i++) {
      const xx = x + i, yy = y + j;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) roofNear[yy * w + xx] = 1;
    }
  }
  const fitCells = [];
  for (let y = M; y < h - M; y++) for (let x = M; x < w - M; x++) {
    const k = y * w + x;
    if (season.kind[k] === 0 && seen[k] && roofNear[k] && bright[k] > 3) fitCells.push(k);
  }
  const logB = Float32Array.from(bright, (v) => Math.log(Math.max(1, v)));
  let fit = null;
  const tryAll = (list) => {
    for (const sun of list) {
      if (!(sun.elevation >= 10)) continue;
      const Tb = beamAt(model, muB, open, sun.dir), Tf = beamAt(model, muTrees, open, sun.dir);
      for (let dy = -SHIFT_M; dy <= SHIFT_M; dy++) for (let dx = -SHIFT_M; dx <= SHIFT_M; dx++) {
        const m = [], p = [];
        for (const k of fitCells) {
          const j = where[k + dy * w + dx];
          if (j < 0 || Math.abs(Tf[j] - Tb[j]) > 0.05) continue;
          m.push(Tb[j]); p.push(logB[k]);
        }
        if (m.length < 200) continue;
        const r = corr(m, p);
        if (!fit || r > fit.r) fit = { r, n: m.length, dx, dy, sun };
      }
    }
  };
  if (typeof suns === 'function') { tryAll(suns(null)); if (fit) tryAll(suns(fit)); } else tryAll(suns);
  if (!fit) return { skip: 'too few cells by buildings to fit the sun' };

  const shifted = (T) => Float32Array.from(cells, (k) => { const j = where[k + fit.dy * w + fit.dx]; return j >= 0 ? T[j] : 1; });
  const TbAll = beamAt(model, muB, open, fit.sun.dir), TtAll = beamAt(model, muTrees, open, fit.sun.dir);
  const Tb = shifted(TbAll), Tt = shifted(TtAll);
  const Toth = shifted(beamAt(model, leaf === 'off' ? season.muOn : season.muOff, open, fit.sun.dir));

  /* 2. Shadow as this photo shows it, from inside buildings' shadows. */
  const tbAt = (c) => (season.kind[c] === 1 ? 0 : where[c] >= 0 ? TbAll[where[c]] : 1);
  const inB = [], lit = [];
  cells.forEach((k, i) => {
    const c = k + fit.dy * w + fit.dx;
    if ([c, c - 1, c + 1, c - w, c + w].every((d) => tbAt(d) <= 0.1)) inB.push(bright[k]);
    else if (Tt[i] >= 0.95) lit.push(bright[k]);
  });
  if (inB.length < 20) return { fit: fitOut(fit), skip: `only ${inB.length} cells inside a building's shadow` };
  const S = med(inB), L = med(lit), contrast = L / S;
  if (!(contrast >= minContrast)) return { fit: fitOut(fit), skip: `buildings' shadows only ${contrast.toFixed(2)}x darker than sun (haze, or a cloud)` };
  const photoT = Float32Array.from(cells, (k) => Math.min(1.2, Math.max(-0.2, (bright[k] - S) / (L - S))));
  const photoShade = Uint8Array.from(photoT, (v) => (v < 0.5 ? 1 : 0));

  /* Edges: the model's shade class changes within a cell. */
  const cls = new Int8Array(N).fill(-1);
  open.forEach((k, i) => { cls[k] = TtAll[i] < 0.5 ? 1 : 0; });
  const edge = Uint8Array.from(cells, (k) => {
    const c = k + fit.dy * w + fit.dx, v = cls[c];
    for (const d of [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1]) { const u = cls[c + d]; if (u >= 0 && u !== v) return 1; }
    return 0;
  });

  /* 3. The trees. */
  const tally = (keep, T) => {
    const r = { n: 0, photo: 0, model: 0, both: 0, modelOnly: 0, photoOnly: 0, lit: 0 };
    cells.forEach((_, i) => {
      if (!keep(i)) return;
      const p = photoShade[i], m = T[i] < 0.5 ? 1 : 0;
      r.n++; r.photo += p; r.model += m;
      if (p && m) r.both++; else if (m) r.modelOnly++; else if (p) r.photoOnly++; else r.lit++;
    });
    return r;
  };
  const treeCell = (i) => Tb[i] >= 0.5;
  let sm = 0, sp = 0, so = 0, nT = 0;
  cells.forEach((_, i) => { if (treeCell(i)) { sm += Tt[i]; so += Toth[i]; sp += Math.min(1, Math.max(0, photoT[i])); nT++; } });
  return {
    fit: fitOut(fit), leaf, cells: cells.length,
    sunLevel: Math.round(L), shadeLevel: Math.round(S), contrast: +contrast.toFixed(2),
    meanBeamTrees: { model: +(sm / nT).toFixed(3), photo: +(sp / nT).toFixed(3), otherSeason: +(so / nT).toFixed(3) },
    all: tally(() => true, Tt),
    trees: tally(treeCell, Tt),
    treesInner: tally((i) => treeCell(i) && !edge[i], Tt),
    treesOtherSeason: tally(treeCell, Toth),
  };
}

const fitOut = (f) => ({ sunEl: +f.sun.elevation.toFixed(1), sunAz: +f.sun.azimuth.toFixed(0), shift: [f.dx, f.dy], r: +f.r.toFixed(3), n: f.n, ...(f.sun.t ? { utc: new Date(f.sun.t).toISOString().slice(0, 16) } : {}) });

/** Sun candidates by direction alone, for a photo with no date: coarse, then around the best. */
export function sunGrid(best) {
  const R = Math.PI / 180;
  const make = (az, el) => ({ azimuth: az, elevation: el, dir: [Math.sin(az * R) * Math.cos(el * R), Math.cos(az * R) * Math.cos(el * R), Math.sin(el * R)] });
  const out = [];
  if (!best) { for (let az = 60; az <= 300; az += 12) for (let el = 15; el <= 75; el += 8) out.push(make(az, el)); return out; }
  for (let az = best.sun.azimuth - 10; az <= best.sun.azimuth + 10; az += 2.5) for (let el = best.sun.elevation - 6; el <= best.sun.elevation + 6; el += 2) out.push(make(az, el));
  return out;
}
