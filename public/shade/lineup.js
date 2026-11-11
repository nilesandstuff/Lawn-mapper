/**
 * WHICH LIDAR, OVER WHICH BOX, LINED UP HOW: the decisions the shade page
 * makes before it builds anything (moved out of public/shade.js on
 * 2026-11-11 so the server's first build of an admin save, rebuild.js,
 * makes the same ones): the photo frame the line-up runs on, the box the
 * lidar is read over, the density test that skips a survey with a hole over
 * the lot, and which photo match is applied.
 */
import { toMerc, fromMerc, mercScale } from './ept.js';
import { gridForFrame, gridBox } from './grid.js';

export const MARGIN_M = 50; // lidar read this far round the lot
export const ALIGN_M = 140; // the photo frame the match runs on, at least this wide
export const MIN_DENSITY = 0.5; // points a square meter over the lot under which a survey is taken as not covering it (USGS QL3)

/** A square frame centered on the site, at least ALIGN_M and the lot wide, at a whole-ish zoom. */
export function alignFrame(site, bounds) {
  const k = mercScale(site.lat);
  const [x0, y0] = toMerc([bounds[0], bounds[1]]), [x1, y1] = toMerc([bounds[2], bounds[3]]);
  const spanM = Math.max(ALIGN_M, (Math.max(x1 - x0, y1 - y0) * k) + 20);
  const mPerPxZ0 = (2 * Math.PI * 6378137 * k) / 512;
  const zoom = Math.max(15, Math.min(19, Math.floor(Math.log2((1280 * mPerPxZ0) / spanM) * 100) / 100));
  const [lng, lat] = fromMerc([(x0 + x1) / 2, (y0 + y1) / 2]);
  return { lng, lat, zoom, size: 1280, height: 1280 };
}

/** The lot as a 3857 box [x0, y0, x1, y1] from its [w, s, e, n] bounds, and its area in square meters at `lat`. */
export function lotOf(bounds, lat) {
  const [lx0, ly0] = toMerc([bounds[0], bounds[1]]), [lx1, ly1] = toMerc([bounds[2], bounds[3]]);
  const k = mercScale(lat);
  return { lot: [lx0, ly0, lx1, ly1], lotM2: Math.max(1, (lx1 - lx0) * (ly1 - ly0) * k * k) };
}

/** Points a square meter over the lot. */
export function lotDensity(cols, lot, lotM2) {
  const [lx0, ly0, lx1, ly1] = lot;
  let n = 0;
  for (let i = 0; i < cols.n; i++) if (cols.x[i] >= lx0 && cols.x[i] <= lx1 && cols.y[i] >= ly0 && cols.y[i] <= ly1) n++;
  return n / lotM2;
}

/** The box the lidar is read over: the lot plus MARGIN_M, and at least the photo frame. */
export function modelBox(lot, frame, lat) {
  const [lx0, ly0, lx1, ly1] = lot;
  const fBox = gridBox(gridForFrame(frame, 1, 1));
  const m = MARGIN_M / mercScale(lat);
  return [Math.min(lx0 - m, fBox[0]), Math.min(ly0 - m, fBox[1]), Math.max(lx1 + m, fBox[2]), Math.max(ly1 + m, fBox[3])];
}

/**
 * The photo match applied: the county photo's where it was read (its fit plus
 * the editor's line-up `move` at the frame's center, since the outline was
 * drawn on the moved photo), else Mapbox's. Null when neither measured one.
 */
export function fitFrom({ onCounty = null, onMapbox = null, move = { east: 0, north: 0 } } = {}) {
  if (onCounty && !onCounty.error) {
    const f = onCounty.fit;
    return { ...f, east: f.east === null ? null : f.east + move.east, north: f.north === null ? null : f.north + move.north };
  }
  return onMapbox?.fit || null;
}

/** The cloud's shift: the datum's `pre` plus the measured residual when the match was confident (3857 units). */
export function shiftFrom(pre, fit, lat) {
  const k = mercScale(lat);
  const residual = fit?.confident ? [fit.east / k, fit.north / k] : [0, 0];
  return [pre[0] + residual[0], pre[1] + residual[1]];
}
