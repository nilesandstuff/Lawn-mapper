/**
 * THE TREES, BUILT (no drawing): the canopy and its seasons and kinds from
 * the cleaned points, as the trees step (trees-ui.js startTrees) and the
 * rebuild without a page (rebuild.js) both build them, so the two cannot
 * drift. `flight` is the lot's leaf state ('off', 'on', 'mixed' or null),
 * `green` the summer photo's reading (naip.js greenOver), or null.
 */
import { gridOver } from './grid.js';
import { buildCanopy } from './canopy.js';
import { seasonalCanopyFor } from './seasonal.js';

export async function treesModel(cols, box, shift, lat, { flight = null, green = null } = {}) {
  const grid = gridOver(box, 1, lat);
  const model = buildCanopy(cols, grid, { shift });
  const leafOff = flight === 'off' || flight === 'mixed';
  const season = await seasonalCanopyFor(cols, model, { shift, classify: leafOff, green }); // the photo, read once per lot (naip.js)
  return { grid, model, season, leafOff };
}
