/**
 * WHAT KIND OF LOW SPOT IS THIS (water session, 2026-10-16).
 *
 * Over the 104 corpus maps the low-spot map reported spots on 59% of lawns,
 * at least 28 of them over 25 cm deep and up to a meter (FINDINGS H9). A lawn
 * does not hold a meter of water. So every reported spot is measured and
 * sorted, and only a LAWN HOLLOW is offered as a lawn problem:
 *
 *   water    open water or a pool: the laser mostly does not come back from
 *            water (it is absorbed or mirrored away), so the spot has far
 *            fewer returns of any kind than the ground round it, or the
 *            survey classed its points as water (class 9)
 *   trees    under a canopy: most of the returns over it are tree, so the
 *            "ground" is the few pulses that got through, and it is not lawn
 *   paved    pavement, a parked car, or ground the laser could not see:
 *            under half the returns of the open ground round it (a road,
 *            a driveway with cars, a gap between houses: 0.28-0.40 in the
 *            development set, against about 1 on grass), or ground returns
 *            far darker than the box's lawns (asphalt reflects the laser's
 *            infrared much less than grass). A low spot there is a curb
 *            line, a drain or nothing.
 *   ditch    long and narrow: a roadside ditch, a swale, a creek bed -- made
 *            to carry water, not a place it gets stuck
 *   built    deep against a wall: a stairwell, a window well, a sunken entry
 *   deep     deeper than a lawn hollow is: a pond, a pit, a retention basin
 *   hollow   everything else: what the lawn map is for
 *
 * HOW THE THRESHOLDS WERE SET (FINDINGS H10). water, ditch, built and deep
 * were written down first; 34 photos of spots from 12 West Michigan squares
 * then showed roads and driveways passing as water and woods passing as
 * hollows, so trees and paved were added and the water ratio lowered,
 * looking at those same 34. They are the DEVELOPMENT set; the rules are
 * scored on a fresh sample from other squares, photos looked at after the
 * kinds were written down. Pure: the tests run it on made-up spots.
 */

export const KIND = {
  hollow: 'a low spot in the lawn',
  water: 'open water or a pool',
  trees: 'under trees, where the ground is hard to see',
  paved: 'pavement, a parked car, or ground the laser could not see',
  ditch: 'a ditch, swale or creek bed',
  built: 'a stairwell, window well or sunken entry',
  deep: 'a pond, pit or basin, deeper than a lawn hollow',
};

export const RULES = {
  waterReturnRatio: 0.15, // returns per m^2 in the spot / on the open ground round it (a pond: 0.02; asphalt: 0.3)
  fewReturns: 0.45, // under this, pavement, cars or hidden ground (above waterReturnRatio)
  treesShare: 0.3, // share of the returns over the spot that are 2 m+ up and not roof
  pavedIntensity: 0.6, // the spot's mean ground intensity / the box's 75th percentile ground intensity
  waterClass9Share: 0.2, // share of the spot's points the survey classed as water
  ditchElongation: 3, // long axis / short axis of the wet cells
  ditchLength: 8, // m along the long axis
  builtDepth: 0.25, // m, against a wall
  deepDepth: 0.25, // m, anywhere
};

/** Long axis, short axis (m) and their ratio, from the spread of the cells (principal axes). */
export function shapeOf(cells, W, cell = 1) {
  const n = cells.length;
  if (n < 2) return { length: cell, width: cell, elongation: 1 };
  let sx = 0, sy = 0;
  for (const i of cells) { sx += i % W; sy += Math.floor(i / W); }
  const mx = sx / n, my = sy / n;
  let a = 0, b = 0, d = 0;
  for (const i of cells) {
    const x = (i % W) - mx, y = Math.floor(i / W) - my;
    a += x * x; b += x * y; d += y * y;
  }
  a /= n; b /= n; d /= n;
  const tr = a + d, det = a * d - b * b, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 1 / 12); // a single row of cells still has 1/12 variance across
  // a uniform strip of length L has variance L^2/12 along it
  return { length: Math.sqrt(12 * l1) * cell, width: Math.sqrt(12 * l2) * cell, elongation: Math.sqrt(l1 / l2) };
}

/**
 * The kind of one spot. `m` = { depth, againstBuilding, returnRatio, class9Share,
 * length, elongation }.
 */
export function kindOf(m, rules = RULES) {
  if (m.class9Share >= rules.waterClass9Share || m.returnRatio < rules.waterReturnRatio) return 'water';
  if (m.treesShare >= rules.treesShare) return 'trees';
  if (m.returnRatio < rules.fewReturns) return 'paved';
  if (m.intensityRatio !== null && m.intensityRatio < rules.pavedIntensity) return 'paved';
  if (m.againstBuilding && m.depth > rules.builtDepth) return 'built';
  if (m.elongation >= rules.ditchElongation && m.length >= rules.ditchLength) return 'ditch';
  if (m.depth > rules.deepDepth) return 'deep';
  return 'hollow';
}

/**
 * Every reported spot, measured and sorted. `perCell` = { all, class9, tall,
 * groundI, groundN, groundP75 }: per grid cell, every return, class 9, the
 * returns 2 m+ over the ground that are not roof, the sum and count of the
 * ground returns' intensity; and the box's 75th percentile ground intensity;
 * `wall` the roofs; `depth` the filled depth per cell.
 */
export function sortSpots(g, spots, depth, perCell, wall, { wet = 0.01 } = {}) {
  // the open ground's return density: cells that are neither roof nor in any filled spot
  let openPts = 0, openCells = 0;
  for (let i = 0; i < depth.length; i++) {
    if (wall[i] || depth[i] > 1e-4) continue;
    openPts += perCell.all[i]; openCells++;
  }
  const openDensity = openPts / Math.max(1, openCells * g.cell * g.cell);
  for (const s of spots) {
    if (!s.reported) continue;
    const cells = s.cells.filter((i) => depth[i] >= wet);
    let pts = 0, nine = 0, tall = 0, gi = 0, gn = 0;
    for (const i of cells) {
      pts += perCell.all[i]; nine += perCell.class9[i]; tall += perCell.tall?.[i] || 0;
      gi += perCell.groundI?.[i] || 0; gn += perCell.groundN?.[i] || 0;
    }
    const shape = shapeOf(cells.length ? cells : s.cells, g.W, g.cell);
    const m = {
      depth: s.depth,
      againstBuilding: s.againstBuilding,
      returnRatio: openDensity > 0 ? (pts / Math.max(1, cells.length * g.cell * g.cell)) / openDensity : 1,
      class9Share: pts ? nine / pts : 0,
      treesShare: pts ? tall / pts : 0,
      intensityRatio: gn >= 3 && perCell.groundP75 > 0 ? (gi / gn) / perCell.groundP75 : null,
      length: shape.length,
      width: shape.width,
      elongation: shape.elongation,
    };
    s.measures = m;
    s.kind = kindOf(m);
  }
  return { openDensity };
}
