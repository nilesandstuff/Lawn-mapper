/**
 * THE WALK'S WORDS FOR THE NEXT ROOF CORNER, AND POINTS PUT BACK ON THEIR CORNERS (owner, 2026-11-12).
 *
 * whereIs: "if you look at a roof corner that has been auto scanned already, it goes through the prompts for
 *   rescanning... It should say 'move on to next prompt X feet to the Y direction'". The distance on the level and
 *   a word for the direction, from where the camera is and which way it looks.
 *
 * resnap: the owner placed R1 on a corner of the lidar view, then changed the map's property line in the Lawn Mapper;
 *   back in the AR the point sat "1-2 feet away from a corner". The corners are found again over whatever box the
 *   lawn and the lot make, so a corner can come out a foot or two from where it was; the point kept the old place.
 *   A point that was put ON a corner (it carries `snap` or `roof`) goes to the nearest corner of the same sort
 *   within reach; one placed by hand off any corner stays.
 *
 * Pure; positions are plain arrays.
 */

export const NEAR_SIGHT_M = 16;   // a corner's sighting starts by itself only from within this (roof-corner.js FAR_M is 14)
export const RESNAP_M = 1.5;      // a snapped point goes to a corner within this of where it was
const FT = 3.28084;

/** camera position [x, y, z], its look direction [x, y, z], a target [x, y, z] (y up) -> { m, ft, word, facing } */
export function whereIs(cam, look, target) {
  const dx = target[0] - cam[0], dz = target[2] - cam[2], m = Math.hypot(dx, dz);
  const lx = look[0], lz = look[2], ll = Math.hypot(lx, lz);
  if (m < 0.5 || ll < 1e-6) return { m, ft: Math.round(m * FT), word: 'right here', facing: true };
  // the angle from where the camera looks (on the level) round to the target: positive to the right
  const cross = lx * dz - lz * dx, dot = lx * dx + lz * dz;
  const deg = (Math.atan2(cross, dot) * 180) / Math.PI;
  const a = Math.abs(deg);
  const word = a <= 25 ? 'straight ahead' : a >= 150 ? 'behind you' : `${a < 65 ? 'ahead and ' : a > 115 ? 'behind and ' : ''}to your ${deg > 0 ? 'right' : 'left'}`;
  return { m, ft: Math.round(m * FT), word, facing: a <= 60, deg };
}

/**
 * points: [{ map: [e, n], snap?, roof? }]; corners: the marks' corners [{ at, kind, of, sure, within }]; roofs: the
 * roof corners offered [{ at, eaveM, label, sure, within, offLot }]. Moves in place. -> { moved: [{ name, m }] }
 */
export function resnap(points, corners = [], roofs = [], reach = RESNAP_M) {
  const moved = [];
  const nearest = (list, at) => { let best = null, bd = reach; for (const c of list) { const d = Math.hypot(c.at[0] - at[0], c.at[1] - at[1]); if (d <= bd) { bd = d; best = c; } } return best ? { c: best, d: bd } : null; };
  for (const p of points || []) {
    if (!p?.map) continue;
    if (p.roof) {
      const hit = nearest(roofs, p.map);
      if (hit && hit.d > 0.02) { p.map = hit.c.at.slice(); p.roof = { ...p.roof, eaveM: hit.c.eaveM, label: hit.c.label, sure: hit.c.sure, within: hit.c.within, offLot: !!hit.c.offLot }; moved.push({ name: p.name, m: +hit.d.toFixed(2) }); }
    } else if (p.snap) {
      const hit = nearest(corners.filter((c) => c.kind === p.snap.kind), p.map);
      if (hit && hit.d > 0.02) { p.map = hit.c.at.slice(); p.snap = { kind: hit.c.kind, of: hit.c.of, sure: !!hit.c.sure, within: hit.c.within ?? null }; moved.push({ name: p.name, m: +hit.d.toFixed(2) }); }
    }
  }
  return { moved };
}
