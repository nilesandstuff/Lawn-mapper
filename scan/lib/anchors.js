/**
 * ANCHOR NUDGES (core session, 2026-11-06; the owner: "Can we have some way to notify the user while they're doing a
 * walk to be like 'look at the roof, driveway, road, or patio' if it's been a while since a good anchor was seen?").
 *
 * What places a walk without marks (docs/SCAN-PLAN.md SCAN-H18, H19): the skyline (roof lines against the sky,
 * matched to the lidar to about a degree) for the coarse placement, and pavement (the lidar's ground is dark there)
 * for the fine one. Both need the camera to have LOOKED at them: the 22:02 walk saw pavement in 12 of 347 pictures
 * and its brightness fit wandered to 12-17 ft; the 21:56 walk saw it in 19 of 194 and sat at 2.6 ft.
 *
 * So the page reads, from the picture it already grabs about once a second, whether this moment shows
 *   - a skyline: the camera tipped up a little and the top of the picture is sky with something under it;
 *   - pavement: the camera tipped down and the lower half is grey ground (surface.js's paving colour);
 * and nudges when the walk has gone NUDGE_M without one. No model, no network: colours and the camera's tilt only.
 * A nudge is a hint, never a block; it says which and repeats at most every REPEAT_M walked.
 */
import { surfaceOf } from './surface.js';

export const NUDGE_M = 30;    // metres walked without a view of that kind before a nudge
export const REPEAT_M = 15;   // metres walked between two nudges of one kind
export const START_M = 6;     // nothing in the walk's first metres: the user is finding their feet

/** The camera's tilt from a quaternion, degrees: + looking up, - looking down. */
export function pitchOf(q) {
  const { x, y, z, w } = q;
  const fy = -(2 * (y * z - w * x)); // the camera's -z axis turned by q, its up component
  return (Math.asin(Math.max(-1, Math.min(1, fy))) * 180) / Math.PI;
}

/** Sky: bright and either colourless (cloud, haze) or blue. */
export function isSky(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, s = mx ? (mx - mn) / mx : 0;
  if (v < 0.55) return false;
  if (s < 0.16) return true;
  return b >= r && b >= g && s < 0.6;
}

/**
 * What one picture shows: { sky, pave, skyShare, paveShare }. pixels: RGBA bytes, w x h, top row first; pitch in
 * degrees (pitchOf). Sampled on a coarse grid; a few hundred pixels say enough.
 */
export function viewOf(pixels, w, h, pitch) {
  const at = (x, y) => { const k = (Math.min(h - 1, Math.floor(y * h)) * w + Math.min(w - 1, Math.floor(x * w))) * 4; return [pixels[k], pixels[k + 1], pixels[k + 2]]; };
  const share = (y0, y1, test) => { let n = 0, m = 0; for (let j = 0; j < 8; j++) for (let i = 0; i < 16; i++) { m++; if (test(...at((i + 0.5) / 16, y0 + ((j + 0.5) / 8) * (y1 - y0)))) n++; } return n / m; };
  const skyTop = share(0, 0.15, isSky), skyMid = share(0.3, 0.6, isSky);
  const paveLow = share(0.5, 1, (r, g, b) => surfaceOf(r, g, b) === 'pave');
  return {
    sky: pitch > 2 && skyTop >= 0.4 && skyMid <= 0.6, // sky above, something (a roof, a crown) under it
    pave: pitch < -10 && paveLow >= 0.25,
    skyShare: +skyTop.toFixed(2), paveShare: +paveLow.toFixed(2),
  };
}

export const newAnchors = () => ({ lastSky: 0, lastPave: 0, nudgedSky: -1e9, nudgedPave: -1e9, views: { sky: 0, pave: 0, frames: 0 }, nudges: { sky: 0, pave: 0 } });

/** Record one picture's view at `odo` metres walked. */
export function noteView(a, odo, view) {
  a.views.frames++;
  if (view.sky) { a.lastSky = odo; a.views.sky++; }
  if (view.pave) { a.lastPave = odo; a.views.pave++; }
}

/** A nudge due now, or null: { kind: 'sky' | 'pave', text }. Counts it as given. */
export function nudge(a, odo) {
  if (odo < START_M) return null;
  const want = [];
  if (odo - a.lastSky >= NUDGE_M && odo - a.nudgedSky >= REPEAT_M) want.push(['sky', odo - a.lastSky]);
  if (odo - a.lastPave >= NUDGE_M && odo - a.nudgedPave >= REPEAT_M) want.push(['pave', odo - a.lastPave]);
  if (!want.length) return null;
  const [kind] = want.sort((p, q) => q[1] - p[1])[0]; // the longer-missing one first
  if (kind === 'sky') { a.nudgedSky = odo; a.nudges.sky++; return { kind, text: 'Look up at a roofline against the sky for a few seconds' }; }
  a.nudgedPave = odo; a.nudges.pave++;
  return { kind, text: 'Point the camera at the driveway, road, sidewalk or patio for a few seconds' };
}

/** For live.json and the walk's summary. */
export const anchorsKept = (a) => ({ views: { ...a.views }, nudges: { ...a.nudges }, lastSky: +a.lastSky.toFixed(1), lastPave: +a.lastPave.toFixed(1) });
