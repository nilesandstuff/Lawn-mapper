/**
 * WHICH PHOTO A SAVED MAP WAS TRACED ON, AND WHERE THE EDITOR PUT IT
 * (shade map; owner, 2026-10-11: maps are saved on county photos too, not
 * only on Mapbox). The lidar is lined up with that photo's ground as shown.
 */

import { toMerc } from './ept.js';

/**
 * The photo a saved map's outline was traced on, and where the editor put it.
 *
 * A map saved on a county photo records which service (countySvc) and the
 * line-up that moved that photo onto Mapbox's ground (countyAlign: east and
 * north in metres, and a scale about the map's frame centre), or null when
 * the line-up was unsure and the photo was shown where the county put it
 * (app.js countyLineUp, alignedFrame). Every other detecting source is
 * either Mapbox or lined up onto it, so its outline is on Mapbox's ground.
 */
export function tracedOn(save) {
  if (save?.provider === 'county' && save.countySvc != null) {
    const a = save.countyAlign;
    const ok = a && [a.east, a.north, a.scale].every(Number.isFinite);
    return {
      provider: 'county', svc: save.countySvc,
      align: ok ? { east: a.east, north: a.north, scale: a.scale } : null,
      about: save.frame && Number.isFinite(save.frame.lng) ? [save.frame.lng, save.frame.lat] : [save.lng, save.lat],
    };
  }
  return { provider: 'mapbox' };
}

/**
 * How far the editor moved the county photo's ground at a point [lng, lat],
 * in real metres east and north: the shift, plus the scale about the saved
 * frame's centre (p -> c + s (p - c) + shift).
 */
export function lineUpAt(t, [lng, lat]) {
  if (!t?.align) return { east: 0, north: 0 };
  const k = Math.cos(lat * Math.PI / 180);
  const [px, py] = toMerc([lng, lat]), [cx, cy] = toMerc(t.about);
  return {
    east: t.align.east + (t.align.scale - 1) * (px - cx) * k,
    north: t.align.north + (t.align.scale - 1) * (py - cy) * k,
  };
}
