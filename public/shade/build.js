/**
 * THE SHADE MAP'S BUILD STAMP (core session, 2026-11-09; the owner: "when a
 * user visits the AR tool, it checks to see if the most recent version of
 * the shade map has been loaded and saved for that map. If the most recent
 * version hasn't been loaded, it calls the shade maps tools and updates it").
 *
 * Written into every saved model as meta.build (model-out.js). A reader
 * holding a newer SHADE_BUILD than a model's (or a model with none) knows
 * the model is out of date and can run rebuild.js. BUMP IT whenever what the
 * model holds changes: a rule in structures.js, the canopy, the seasons, an
 * array added or changed in model-out.js, how erasures or fences are applied.
 *
 *   1  2026-11-09  the first stamp: points, intensity, the surround, trunk
 *                  offsets, own returns, fences in the header
 *   2  2026-11-12  structures.js: a roof under a crown stays a building
 *                  (roofUnderCrown, why 10; shade findings 36)
 *   3  2026-11-12  the crown over such a roof: summer leaves above the roof,
 *                  drawn as a tree there, no eaves from it; the file's `roof`
 *   4  2026-11-16  structures.js: a roof edge under a crown stays a building
 *                  (edgeUnderCrown, why 11; shade findings 37)
 *   5  2026-11-16  edgeUnderCrown: each building's own brightness, not the
 *                  grid's (a dark roof among bright ones; findings 37)
 *   6  2026-11-16  edgeUnderCrown: no brightness test where nothing stands
 *                  over the roof's height (a bright gutter); a hole in a roof
 *                  is roof (roofHoles, why 12); findings 37
 */
export const SHADE_BUILD = 6;
