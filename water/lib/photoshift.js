/**
 * THE PHOTO LINED UP ON THE LIDAR (owner, 2026-10-20: "Line up mapbox and county photos as best as
 * possible with the lidar. Ask the core session for advice"). The core session's answer, the same day:
 *
 *   THE RAW LIDAR IS THE TRUTH. It is surveyed; a photo is not. Mapbox's photos sit 2-3 m off it in places
 *   (every Fargo lot about 2.9 m, the Kentucky site 3-4 m), county photos about a metre, mostly north. The
 *   old datum move (lib/datum.js nad83Correction) fits half of Mapbox's error and puts county photos 1.2 m
 *   wrong: the wrong shape of fix. So the lidar is gridded where it was surveyed, and each PHOTO is moved
 *   onto it -- and the lawn traced on that photo with it. Property lines share the lidar's datum and stay.
 *
 * One move per map, tried in this order, and the page says which it used:
 *
 *   ground       the shade map's ground matcher (shade/align.js alignToPhoto, copied unchanged): the lines
 *                on open ground -- kerbs, drives, paths -- in the lidar's intensity against the photo's. No
 *                lean, so the better number; used when it commits (the frame's quarters agree within 20 cm).
 *                It committed on 14 of the core's 98 lots.
 *   ground,      the ground matcher again, when its error bar is under GROUND_LOOSE_M (0.5 m) though over the
 *   looser       shade map's 0.2 m, and its peak stands clear of any rival.
 *   roof         the core's roof-edge fit (roof-fit.js): the lidar's eaves slid onto the photo's edges, used
 *                when its peak is clear (PEAK_MIN 1.35). Clear on 38 of 98. It INCLUDES THE ROOFS' LEAN, which
 *                is why it comes after the ground, even a loose ground match (FINDINGS H28): on a Fargo lot the
 *                ground matcher said E +1.18 (to 0.21 m), the driveways' edges read by hand E +0.7 to +1.1,
 *                the roof fit E +3.0; on the owner's lot the ground matcher E +0.43 N -1.01 (to 0.35 m), the
 *                road's and the driveways' edges by hand E +0.65 N -1.05. Two lots: the order is a judgement.
 *   neighbours   none of those: the median of the core's measured lots of the same photo source within
 *                NEAR_M (Mapbox's error is one vector per town -- Fargo's six lots within 0.25 m). Those are
 *                ROOF fits, lean and all: on Fargo's lots they say E +2.9 where the ground says about 1.
 *   source       none near: that source's median over the core's measured lots (roof fits too). On the owner's
 *                lot it says E +1.79, 1.2 m more than the ground.
 *
 * A shift here is THE MOVE APPLIED TO THE PHOTO (and a trace on it) to put it on the raw lidar, in ground
 * metres east and north: the shape the core proposed for the maps record (tools.core.data.photo.shift;
 * docs/MAPS.md), kept in the water part (tools.water.data.photoShift) until the core's exists.
 */

import { alignToPhoto } from './shade/align.js';
import { gridForFrame, rasterise } from './shade/grid.js';
import { mercScale } from './shade/ept.js';
import { greyGrid } from './lib/photo-fit.js';
import { heightSurface, fitRoof, FIT_CELL_M, PEAK_MIN } from './roof-fit.js';

export const NEAR_M = 2000, GROUND_LOOSE_M = 0.5, GROUND_MARGIN = 0.03; // the matcher's own minMargin
/* The core's medians, RAW lidar, as moves of the PHOTO (its numbers are the lidar's move: the other sign). */
export const SOURCE_MEDIAN = { mapbox: { east: 1.79, north: -1.06, lots: 29 }, county: { east: 0.22, north: -0.75, lots: 9 } };

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const R = 6371000;
const distM = (a, b) => { const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180); return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * (Math.PI / 180) * R; };

/** A point [lng, lat] moved `east`, `north` ground metres. */
export function moved([lng, lat], { east, north }) {
  return [lng + ((east / (R * Math.cos((lat * Math.PI) / 180))) * 180) / Math.PI, lat + ((north / R) * 180) / Math.PI];
}

/** The core's measured lots of `source` within NEAR_M of [lng, lat]: their median move, or null. */
export function fromNeighbours(at, source, lots, near = NEAR_M) {
  const close = (lots || []).filter((l) => l.source === source && distM(at, [l.lng, l.lat]) <= near);
  if (!close.length) return null;
  return { east: median(close.map((l) => l.east)), north: median(close.map((l) => l.north)), lots: close.length, farthestM: Math.max(...close.map((l) => distM(at, [l.lng, l.lat]))) };
}

/**
 * The roof-edge fit over a photo frame ({ lng, lat, zoom, size, height }, as /api/imagery takes it; the
 * photo RGBA covering exactly it). -> the LIDAR's move onto the photo { east, north, peak, edges,
 * confident } or null.
 */
export function roofFitOnFrame(cols, frame, photo) {
  const k = mercScale(frame.lat);
  const one = gridForFrame(frame, 1, 1), widthM = one.cell * k, heightM = (one.cellY || one.cell) * k;
  // the height surface at about 0.5 m, the photo's edges at exactly half that, so a height cell is two fit cells
  const hw = Math.max(16, Math.round(widthM / (2 * FIT_CELL_M))), hh = Math.max(16, Math.round(heightM / (2 * FIT_CELL_M)));
  const hg = { ...gridForFrame(frame, hw, hh), cellM: 2 * FIT_CELL_M };
  const fw = hw * 2, fh = hh * 2, cellM = widthM / fw;
  const grey = greyGrid(photo.data, photo.width, photo.height, fw, fh);
  const f = fitRoof(heightSurface(rasterise(cols, hg), hg), hg, grey, fw, fh, k);
  if (!f) return null;
  // fitRoof counts in FIT_CELL_M cells; this frame's are cellM
  const s = cellM / FIT_CELL_M;
  return { ...f, east: f.east * s, north: f.north * s };
}

/**
 * The photo's move onto the raw lidar, for one frame. source: 'mapbox' | 'county'; lots: the core's table
 * (photo-shifts.json). -> { east, north, method, peak?, errorM?, lots?, why, tried: { ground, roof } }
 */
export function measure(cols, frame, photo, { source = 'mapbox', lots = [], at = [frame.lng, frame.lat] } = {}) {
  const tried = { ground: null, roof: null };
  let roof = null;
  if (cols?.n && photo?.data) {
    try {
      const a = alignToPhoto(cols, frame, photo);
      tried.ground = { east: a.east, north: a.north, confident: !!a.confident, errorM: a.errorM ?? null, margin: Number.isFinite(a.score) && Number.isFinite(a.second) ? a.score - a.second : null, why: a.why };
    } catch (e) { tried.ground = { error: String(e?.message || e) }; }
    try {
      roof = roofFitOnFrame(cols, frame, photo);
      tried.roof = roof ? { east: roof.east, north: roof.north, peak: roof.peak, edges: roof.edges, confident: roof.confident } : null;
    } catch (e) { tried.roof = { error: String(e?.message || e) }; }
  }
  const g = tried.ground;
  if (g?.confident) return { east: -g.east, north: -g.north, method: 'ground', errorM: g.errorM, why: `the lines on open ground matched (${g.why})`, tried };
  if (g && Number.isFinite(g.east) && Number.isFinite(g.errorM) && g.errorM <= GROUND_LOOSE_M && g.margin >= GROUND_MARGIN) {
    return { east: -g.east, north: -g.north, method: 'ground-loose', errorM: g.errorM, why: `the lines on open ground matched to about ${Math.round(g.errorM * 100)} cm (looser than the shade map's 20 cm)`, tried };
  }
  if (roof?.confident) return { east: -roof.east, north: -roof.north, method: 'roof', peak: roof.peak, why: `the roof edges matched (peak ${roof.peak.toFixed(2)}, ${PEAK_MIN} needed); roofs lean in a photo, so this may be off by their lean`, tried };
  const nb = fromNeighbours(at, source, lots);
  if (nb) return { east: nb.east, north: nb.north, method: 'neighbours', lots: nb.lots, why: `no match was clear here; the median of ${nb.lots} measured ${nb.lots > 1 ? 'lots' : 'lot'} within ${(nb.farthestM / 1609).toFixed(1)} mi on the same photos`, tried };
  const m = SOURCE_MEDIAN[source] || SOURCE_MEDIAN.mapbox;
  return { east: m.east, north: m.north, method: 'source', lots: m.lots, why: `no match was clear here and no measured lot is near; ${source === 'county' ? 'county photos\'' : 'Mapbox\'s'} typical error over ${m.lots} measured lots`, tried };
}

/** Is `s` a usable kept shift ({ east, north } finite, under 10 m)? */
export const usable = (s) => !!s && Number.isFinite(s.east) && Number.isFinite(s.north) && Math.hypot(s.east, s.north) < 10;

/* ---------------------------------------------------- moving what was drawn on the photo */

const ringMoved = (ring, d) => ring.map((p) => (Array.isArray(p) && p.length >= 2 ? [...moved(p, d), ...p.slice(2)] : p));

/** GeoJSON features (Polygon / MultiPolygon, as a saved map's shapes) moved by d. */
export function featuresMoved(features, d) {
  if (!d || (!d.east && !d.north)) return features;
  return (features || []).map((f) => {
    const g = f?.geometry;
    if (!g) return f;
    const coordinates = g.type === 'Polygon' ? g.coordinates.map((r) => ringMoved(r, d))
      : g.type === 'MultiPolygon' ? g.coordinates.map((poly) => poly.map((r) => ringMoved(r, d))) : g.coordinates;
    return { ...f, geometry: { ...g, coordinates } };
  });
}

/**
 * The water part's own points (downspouts, gutters, marked areas, the sprinklers, the backflow preventer and
 * valve boxes), moved by d: once, when a map tapped over an unmoved photo is first opened with the photo on
 * the lidar. The GPS calibration is dropped (it was a move onto the old photo; a new one takes 20 seconds).
 */
export function inputsMoved(w, d) {
  if (!w || (!d.east && !d.north)) return w;
  const p = (q) => (Array.isArray(q) && q.length >= 2 && Number.isFinite(q[0]) ? [...moved(q, d), ...q.slice(2)].map((v) => +v.toFixed(7)) : q);
  const out = { ...w };
  if (Array.isArray(w.downspouts)) out.downspouts = w.downspouts.map((s) => ({ ...s, from: p(s.from), to: s.to ? p(s.to) : s.to }));
  if (Array.isArray(w.gutters)) out.gutters = w.gutters.map((line) => line.map(p));
  if (Array.isArray(w.areas)) out.areas = w.areas.map((a) => ({ ...a, ring: (a.ring || []).map(p) }));
  if (w.irrigation && typeof w.irrigation === 'object') {
    const irr = { ...w.irrigation };
    if (Array.isArray(irr.heads)) irr.heads = irr.heads.map((h) => ({ ...h, at: p(h.at) }));
    if (irr.system) {
      irr.system = { ...irr.system };
      if (irr.system.pvb?.at) irr.system.pvb = { ...irr.system.pvb, at: p(irr.system.pvb.at) };
      if (Array.isArray(irr.system.boxes)) irr.system.boxes = irr.system.boxes.map((b) => ({ ...b, at: p(b.at) }));
    }
    delete irr.gpsCal;
    out.irrigation = irr;
  }
  return out;
}
