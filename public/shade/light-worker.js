/**
 * The shade map's light calculations, off the page's main thread (a module
 * Web Worker), so a phone stays responsive while a few million rays are
 * marched. Messages in, messages out; all the arithmetic is in canopy.js,
 * rays.js and sun.js, which the tests run directly.
 *
 *   { type: 'build', cols, box, lat, lng, shift, heightM, lot, lawn, opaque }
 *       -> { type: 'built', w, h, box, svf (per lot cell), top }
 *   { type: 'now', t }            -> { type: 'now', T (per point) }
 *   { type: 'day', dayMs }        -> { type: 'day', sunHours, beamHours, dli, openDli, path }
 *   { type: 'months', year }      -> { type: 'months', rows: [{ month, dli, openDli, sunHours }] }
 *
 * Points are 0.5 m (`sub` 2 per 1 m cell) over the lot; the month table
 * uses one point per cell and 20-minute steps.
 */

import { buildCanopy, solidAtGrass } from './canopy.js';
import { gridOver } from './grid.js';
import { toMerc } from './ept.js';
import { samplePoints, skyView, sunlitNow, dayLight } from './rays.js';
import { sunPath, sunAt, solarNoon } from './sun.js';
import { rasterizePolygon } from '../lib/mask.js';

let S = null; // the current property

function maskOf(rings, grid) {
  const proj = ([lng, lat]) => {
    const [x, y] = toMerc([lng, lat]);
    return [(x - grid.x0) / grid.cell, (grid.y1 - y) / grid.cell];
  };
  return rasterizePolygon(rings, grid.w, grid.h, proj);
}

/** Mean of `values` over the points whose cell is in `mask`. */
function meanOver(values, cells, mask) {
  let s = 0, n = 0;
  for (let p = 0; p < values.length; p++) if (mask[cells[p]]) { s += values[p]; n++; }
  return n ? s / n : null;
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'build') {
      const grid = gridOver(m.box, 1, m.lat);
      const model = buildCanopy(m.cols, grid, { shift: m.shift, opaqueCanopy: !!m.opaque });
      const all = new Uint8Array(grid.w * grid.h).fill(1);
      const lot = m.lot?.length ? m.lot.reduce((acc, rings) => { const k = maskOf(rings, grid); for (let i = 0; i < k.length; i++) acc[i] |= k[i]; return acc; }, new Uint8Array(grid.w * grid.h)) : all;
      /* Inside a house (or under canopy nothing got through) there is no
         grass to light: those cells are left out of the sums and the colours. */
      let solid = 0;
      for (let k = 0; k < lot.length; k++) if (lot[k] && solidAtGrass(model, k)) { lot[k] = 0; solid++; }
      const lawn = m.lawn?.length ? m.lawn.reduce((acc, rings) => { const k = maskOf(rings, grid); for (let i = 0; i < k.length; i++) acc[i] |= k[i]; return acc; }, new Uint8Array(grid.w * grid.h)) : null;
      const coarse = samplePoints(model, lot, 1);
      const svfCell = new Float32Array(grid.w * grid.h).fill(1);
      const sv = skyView(model, coarse.xy);
      coarse.cells.forEach((c, i) => { svfCell[c] = sv[i]; });
      const fine = samplePoints(model, lot, 2);
      const svfFine = Float32Array.from(fine.cells, (c) => svfCell[c]);
      const lawnOpen = lawn ? Uint8Array.from(lawn, (v, k) => v & lot[k]) : null;
      S = { m, grid, model, lot, lawn, lawnOpen, coarse, fine, svfCell, svfFine, svCoarse: sv };
      self.postMessage({
        type: 'built', w: grid.w, h: grid.h, top: model.top, ground: model.z0,
        svfLawn: lawnOpen ? meanOver(svfFine, fine.cells, lawnOpen) : null, svfLot: meanOver(svfFine, fine.cells, lot),
        lawnCells: lawn ? lawn.reduce((a, b) => a + b, 0) : 0, solidCells: solid,
      });
    } else if (m.type === 'now') {
      const s = sunAt(S.m.lat, S.m.lng, m.t);
      const ce = Math.cos(s.elevation * Math.PI / 180);
      const dir = [Math.sin(s.azimuth * Math.PI / 180) * ce, Math.cos(s.azimuth * Math.PI / 180) * ce, Math.sin(s.elevation * Math.PI / 180)];
      const T = s.elevation > 0 ? sunlitNow(S.model, S.fine.xy, dir) : new Float32Array(S.fine.cells.length);
      self.postMessage({ type: 'now', T, elevation: s.elevation, azimuth: s.azimuth, xy: S.fine.xy, w: S.grid.w, h: S.grid.h, id: m.id }, [T.buffer]);
    } else if (m.type === 'day') {
      const path = sunPath(S.m.lat, S.m.lng, m.dayMs, 10);
      const d = dayLight(S.model, S.fine.xy, path, { stepMin: 10, heightM: S.m.heightM, svf: S.svfFine });
      const mask = S.lawnOpen || S.lot;
      const area = (lo, hi) => { let n = 0; for (let p = 0; p < d.sunHours.length; p++) if (mask[S.fine.cells[p]] && d.sunHours[p] >= lo && d.sunHours[p] < hi) n++; return n * 0.25; };
      self.postMessage({
        type: 'day', id: m.id, xy: S.fine.xy, w: S.grid.w, h: S.grid.h,
        sunHours: d.sunHours, beamHours: d.beamHours, dli: d.dli, openDli: d.openDli,
        dayHours: path.length * 10 / 60, sunrise: path[0]?.t ?? null, sunset: path.at(-1)?.t ?? null,
        meanDli: meanOver(d.dli, S.fine.cells, mask), meanSun: meanOver(d.sunHours, S.fine.cells, mask),
        areaM2: { full: area(6, 99), part: area(3, 6), shade: area(0, 3) },
      });
    } else if (m.type === 'months') {
      const mask = S.lawnOpen || S.lot;
      const rows = [];
      for (let month = 0; month < 12; month++) {
        const day = solarNoon(S.m.lng, Date.UTC(m.year, month, 21, 12));
        const path = sunPath(S.m.lat, S.m.lng, day, 20);
        const d = dayLight(S.model, S.coarse.xy, path, { stepMin: 20, heightM: S.m.heightM, svf: S.svCoarse });
        rows.push({ month, dli: meanOver(d.dli, S.coarse.cells, mask), openDli: d.openDli, sunHours: meanOver(d.sunHours, S.coarse.cells, mask), dayHours: path.length / 3 });
        self.postMessage({ type: 'progress', what: 'months', done: month + 1, of: 12, id: m.id });
      }
      self.postMessage({ type: 'months', rows, id: m.id });
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e?.message || e), id: m.id });
  }
};
