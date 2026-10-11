/**
 * The shade map's light calculations, off the page's main thread (a module
 * Web Worker), so a phone stays responsive while a few million rays are
 * marched. Messages in, messages out; all the arithmetic is in canopy.js,
 * seasonal.js, rays.js, sun.js and climate.js, which the tests run directly.
 *
 *   { type: 'build', cols, box, lat, lng, shift, heightM, lot, lawn,
 *     canopy: 'seasonal' | 'measured' | 'solid', flight: 'off'|'on'|'mixed'|null, tMean? }
 *       -> { type: 'built', ..., kinds, counts, calendar }
 *   { type: 'now', t }            -> { type: 'now', T (per point), leaves }
 *   { type: 'day', dayMs }        -> { type: 'day', sunHours, beamHours, dli, openDli, leaves, ... }
 *   { type: 'months', year }      -> { type: 'months', rows: [{ month, dli, openDli, sunHours, leaves }] }
 *   { type: 'season', climate, grass, threshold, bands }
 *       -> { type: 'season', xy, mean (per point), lawn[365], open[365], season, stats }
 *
 * THE TREES ON A DATE. In 'seasonal' mode the deciduous crowns' leaves are
 * out by the share leafCalendar gives for that date (seasonal.js), and every
 * calculation uses the canopy as it stands then; the sky view is worked out
 * bare and in leaf and blended the same way. 'measured' is the laser's
 * canopy all year; 'solid' stops all light in every crown.
 *
 * Points are 0.5 m (`sub` 2 per 1 m cell) over the lot; the month table and
 * the season use one point per cell and 20-minute steps.
 */

import { buildCanopy, solidAtGrass } from './canopy.js';
import { seasonalCanopy, muWithLeaves, leafCalendar } from './seasonal.js';
import { gridOver } from './grid.js';
import { toMerc } from './ept.js';
import { samplePoints, skyView, sunlitNow, dayLight, beamShare } from './rays.js';
import { sunPath, sunAt, solarNoon } from './sun.js';
import { growingSeason, growthPotential, dliOn, PAR_MOL_PER_MJ } from './climate.js';
import { rasterizePolygon } from '../lib/mask.js';

let S = null; // the current property

function maskOf(rings, grid) {
  const proj = ([lng, lat]) => {
    const [x, y] = toMerc([lng, lat]);
    return [(x - grid.x0) / grid.cell, (grid.y1 - y) / grid.cell];
  };
  return rasterizePolygon(rings, grid.w, grid.h, proj);
}

const union = (polys, grid) => polys.reduce((acc, rings) => {
  const k = maskOf(rings, grid);
  for (let i = 0; i < k.length; i++) acc[i] |= k[i];
  return acc;
}, new Uint8Array(grid.w * grid.h));

/** Mean of `values` over the points whose cell is in `mask`. */
function meanOver(values, cells, mask) {
  let s = 0, n = 0;
  for (let p = 0; p < values.length; p++) if (mask[cells[p]]) { s += values[p]; n++; }
  return n ? s / n : null;
}

/** 0-based day of the year of a time, 29 Feb folded onto 28 Feb (as climate.js). */
function dayOfYear(ms) {
  const d = new Date(ms), y = d.getUTCFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const doy = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000);
  return leap && doy >= 59 ? Math.max(58, doy - 1) : doy;
}

/** Share of deciduous leaves out on a day of the year (1 when seasons are off). */
const leavesOn = (k) => (S.calendar ? S.calendar.share(k) : 1);

/** The model with the canopy as it stands at leaf share f (cached by tenths). */
function modelAt(f) {
  if (!S.season) return S.model;
  const key = Math.round(f * 10) / 10;
  if (!S.byLeaf.has(key)) S.byLeaf.set(key, { ...S.model, mu: muWithLeaves(S.season, key) });
  return S.byLeaf.get(key);
}

/** Sky view per coarse point at leaf share f, blended between bare and in leaf. */
function skyAt(f) {
  if (!S.svOn) return S.svOff;
  const out = new Float32Array(S.svOff.length);
  for (let p = 0; p < out.length; p++) out[p] = S.svOff[p] + f * (S.svOn[p] - S.svOff[p]);
  return out;
}
const fineSky = (sv) => Float32Array.from(S.fine.cells, (c) => sv[S.coarseIndex[c]]);

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'build') build(m);
    else if (m.type === 'now') {
      const s = sunAt(S.m.lat, S.m.lng, m.t);
      const f = leavesOn(dayOfYear(m.t));
      const ce = Math.cos(s.elevation * Math.PI / 180);
      const dir = [Math.sin(s.azimuth * Math.PI / 180) * ce, Math.cos(s.azimuth * Math.PI / 180) * ce, Math.sin(s.elevation * Math.PI / 180)];
      const T = s.elevation > 0 ? sunlitNow(modelAt(f), S.fine.xy, dir) : new Float32Array(S.fine.cells.length);
      self.postMessage({ type: 'now', T, leaves: f, elevation: s.elevation, azimuth: s.azimuth, xy: S.fine.xy, w: S.grid.w, h: S.grid.h, id: m.id }, [T.buffer]);
    } else if (m.type === 'day') {
      const f = leavesOn(dayOfYear(m.dayMs));
      const path = sunPath(S.m.lat, S.m.lng, m.dayMs, 10);
      const d = dayLight(modelAt(f), S.fine.xy, path, { stepMin: 10, heightM: S.m.heightM, svf: fineSky(skyAt(f)) });
      const mask = S.lawnOpen || S.lot;
      const area = (lo, hi) => { let n = 0; for (let p = 0; p < d.sunHours.length; p++) if (mask[S.fine.cells[p]] && d.sunHours[p] >= lo && d.sunHours[p] < hi) n++; return n * 0.25; };
      self.postMessage({
        type: 'day', id: m.id, xy: S.fine.xy, w: S.grid.w, h: S.grid.h, leaves: f,
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
        const f = leavesOn(dayOfYear(day));
        const path = sunPath(S.m.lat, S.m.lng, day, 20);
        const d = dayLight(modelAt(f), S.coarse.xy, path, { stepMin: 20, heightM: S.m.heightM, svf: skyAt(f) });
        rows.push({ month, leaves: f, dli: meanOver(d.dli, S.coarse.cells, mask), openDli: d.openDli, sunHours: meanOver(d.sunHours, S.coarse.cells, mask), dayHours: path.length / 3 });
        self.postMessage({ type: 'progress', what: 'months', done: month + 1, of: 12, id: m.id });
      }
      self.postMessage({ type: 'months', rows, id: m.id });
    } else if (m.type === 'season') {
      seasonOf(m);
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e?.message || e), id: m.id });
  }
};

function build(m) {
  const grid = gridOver(m.box, 1, m.lat);
  const solidMode = m.canopy === 'solid';
  const model = buildCanopy(m.cols, grid, { shift: m.shift, opaqueCanopy: solidMode });
  /* Seasons: only when asked, with a calendar, and from a flight that did
     not already see the summer canopy. */
  const leafOffFlight = m.flight === 'off' || m.flight === 'mixed';
  const calendar = m.tMean ? leafCalendar(m.tMean) : null;
  const season = !solidMode ? seasonalCanopy(m.cols, model, { shift: m.shift, classify: leafOffFlight }) : null;
  const seasonal = m.canopy === 'seasonal' && leafOffFlight && calendar && season;

  const all = new Uint8Array(grid.w * grid.h).fill(1);
  const lot = m.lot?.length ? union(m.lot, grid) : all;
  /* Inside a house (or under canopy nothing got through) there is no
     grass to light: those cells are left out of the sums and the colours. */
  let solid = 0;
  for (let k = 0; k < lot.length; k++) if (lot[k] && solidAtGrass(model, k)) { lot[k] = 0; solid++; }
  const lawn = m.lawn?.length ? union(m.lawn, grid) : null;
  const coarse = samplePoints(model, lot, 1);
  const fine = samplePoints(model, lot, 2);
  const coarseIndex = new Int32Array(grid.w * grid.h).fill(-1);
  coarse.cells.forEach((c, i) => { coarseIndex[c] = i; });
  const lawnOpen = lawn ? Uint8Array.from(lawn, (v, k) => v & lot[k]) : null;
  S = {
    m, grid, model, lot, lawn, lawnOpen, coarse, fine, coarseIndex,
    season: seasonal ? season : null, calendar: seasonal ? calendar : null, byLeaf: new Map(),
  };
  S.svOff = skyView(seasonal ? modelAt(0) : model, coarse.xy);
  S.svOn = seasonal ? skyView(modelAt(1), coarse.xy) : null;
  const kinds = season ? season.kind : new Uint8Array(grid.w * grid.h);
  self.postMessage({
    type: 'built', w: grid.w, h: grid.h, top: model.top, ground: model.z0,
    lawnCells: lawn ? lawn.reduce((a, b) => a + b, 0) : 0, solidCells: solid,
    canopy: seasonal ? 'seasonal' : solidMode ? 'solid' : 'measured',
    seasonsWhy: seasonal ? null : m.canopy !== 'seasonal' ? null
      : !leafOffFlight ? (m.flight === 'on' ? 'the lidar was flown in leaf, so it already shows the summer canopy' : 'the flight season is unknown')
        : !calendar ? 'the typical temperatures did not load' : null,
    kinds, counts: season?.counts || null, classified: !!season?.classified,
    calendar: calendar && seasonal ? { out: calendar.out, full: calendar.full, halfOut: calendar.halfOut, halfFall: calendar.halfFall, bare: calendar.bare, always: !!calendar.always, never: !!calendar.never } : null,
  });
}

const SAMPLE_EVERY = 14;

/** Beam share per coarse point on every SAMPLE_EVERY-th day of the year, kept on S. */
function sampleBeams(year) {
  if (S.beams) return S.beams;
  const days = [];
  for (let d = 0; d < 365; d += SAMPLE_EVERY) days.push(d);
  const rows = days.map((d, i) => {
    const t = solarNoon(S.m.lng, Date.UTC(year, 0, 1 + d, 12));
    const bs = beamShare(modelAt(leavesOn(d)), S.coarse.xy, sunPath(S.m.lat, S.m.lng, t, 20), { heightM: S.m.heightM });
    self.postMessage({ type: 'progress', what: 'season', done: i + 1, of: days.length });
    return bs;
  });
  S.beams = { days, rows };
  return S.beams;
}

/** A point's beam share on day k, between the sampled days (round the year). */
function beamOn(beams, p, k) {
  const { days, rows } = beams;
  const i = Math.min(days.length - 1, Math.floor(k / SAMPLE_EVERY));
  const d0 = days[i], j = (i + 1) % days.length;
  const d1 = j === 0 ? 365 : days[j];
  const f = (k - d0) / (d1 - d0);
  return rows[i][p] * (1 - f) + rows[j][p] * f;
}

function seasonOf(m) {
  const c = m.climate;
  const beams = sampleBeams(new Date().getUTCFullYear());
  const n = S.coarse.cells.length;
  const mask = S.lawnOpen || S.lot;
  const inMask = Uint8Array.from(S.coarse.cells, (k) => mask[k]);
  const nIn = inMask.reduce((a, b) => a + b, 0) || 1;
  const season = growingSeason(c.tMean, m.grass, m.threshold);
  const days = season.days.length ? season.days : [];
  const lawn = new Float32Array(365), lawnDull = new Float32Array(365), open = new Float32Array(365);
  const sum = new Float32Array(n);
  const inSeason = c.tMean.map((t) => growthPotential(t, m.grass) >= m.threshold);
  for (let k = 0; k < 365; k++) {
    const sky = skyAt(leavesOn(k));
    let t = 0, tDull = 0;
    for (let p = 0; p < n; p++) {
      const bs = beamOn(beams, p, k);
      const v = dliOn(c.ghi[k], c.diffuse[k], bs, sky[p]);
      if (inMask[p]) { t += v; tDull += dliOn(c.ghiP10[k], c.diffuse[k], bs, sky[p]); }
      if (inSeason[k]) sum[p] += v;
    }
    lawn[k] = t / nIn; lawnDull[k] = tDull / nIn;
    open[k] = PAR_MOL_PER_MJ * c.ghi[k];
  }
  const mean = days.length ? sum.map((v) => v / days.length) : sum;
  const pick = (arr) => {
    if (!days.length) return null;
    let lo = days[0], hi = days[0], s = 0;
    for (const k of days) { if (arr[k] < arr[lo]) lo = k; if (arr[k] > arr[hi]) hi = k; s += arr[k]; }
    return { mean: s / days.length, min: arr[lo], minDay: lo, max: arr[hi], maxDay: hi };
  };
  const lawnStats = pick(lawn), openStats = pick(open);
  const dull = lawnStats ? lawnDull[lawnStats.minDay] : null;
  /* Area of the lawn by its season-average light, in m2 (1 m points). */
  const bands = m.bands.map(([lo, hi]) => {
    let a = 0;
    for (let p = 0; p < n; p++) if (inMask[p] && mean[p] >= lo && mean[p] < hi) a++;
    return a;
  });
  self.postMessage({
    type: 'season', id: m.id, xy: S.coarse.xy, mean, lawn, lawnDull, open, season,
    stats: { lawn: lawnStats, open: openStats, dullAtMin: dull, bands },
  });
}
