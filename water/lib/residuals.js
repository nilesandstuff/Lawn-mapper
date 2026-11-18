/**
 * THE MODEL'S KNOBS, NUDGED ONE AT A TIME, AT EVERY SCORED SQUARE (owner, 2026-11-18: "come up with a way to actually
 * track the trends in how the model is different from the measurements... because the model is so complex, we need an
 * equally complex way to extrapolate where the model is coming short"). Pure.
 *
 * At each square of a thermal walk the analysis worker (public/analyse.js walkCheck) solves the surface again with one
 * piece of the physics changed by a set amount, holding the rest: how far the prediction moves is that square's
 * sensitivity to the piece. The residual analysis (tools/residuals.py) then asks which mix of these changes, the same
 * everywhere, best explains measured minus modelled across walks, and checks it on a walk it was not fitted on. A
 * sensitivity says how much a change WOULD move a square; only the fit says whether the data want it.
 *
 * Each nudge takes surfacenow.js forcingAt's { swNet, rnIso, ta, ra, beta, fence, paving, air } and gives it back
 * changed. The two that need more than the forcing (the soil 1 C warmer, the sun's share through the trees) are done
 * by the caller: SOIL_NUDGE_C, BEAM_NUDGE.
 */
import { LAMBDA_SKIN, SW_TO_SOIL } from './soiltemp.js';

export const NUDGES = [
  { key: 'sun', what: 'sunshine absorbed +10% (albedo, the sun on the grass)', apply: (f) => ({ ...f, swNet: f.swNet * 1.1, rnIso: f.rnIso + 0.1 * f.swNet }) },
  { key: 'longwave', what: 'net longwave +10% (the sky\'s and the surroundings\')', apply: (f) => ({ ...f, rnIso: f.rnIso + 0.1 * (f.rnIso - f.swNet - (f.fence || 0) - (f.paving || 0)) }) },
  { key: 'wind', what: 'wind at the grass +10% (shelter, the station\'s wind)', apply: (f) => ({ ...f, ra: f.ra / 1.1 }) },
  { key: 'evap', what: 'evaporation +10% of its share (the grass\'s water use)', apply: (f) => ({ ...f, beta: Math.min(1, f.beta * 1.1) }) },
  { key: 'skin', what: 'turf-to-soil conductance +10% (thatch)', apply: (f) => ({ ...f, lambdaSkin: LAMBDA_SKIN * 1.1 }) },
  { key: 'through', what: 'sunshine straight to the soil +10% of its share', apply: (f) => ({ ...f, swToSoil: SW_TO_SOIL * 1.1 }) },
  { key: 'paving', what: 'paving\'s heat on the grass +10%', apply: (f) => ({ ...f, rnIso: f.rnIso + 0.1 * (f.paving || 0) }) },
  { key: 'fence', what: 'fences\' heat on the grass +10%', apply: (f) => ({ ...f, rnIso: f.rnIso + 0.1 * (f.fence || 0) }) },
  { key: 'treecool', what: 'the trees\' cooling of the air +10%', apply: (f) => ({ ...f, ta: f.ta + 0.1 * (f.air || 0) }) },
  { key: 'air', what: 'air 1 C warmer', apply: (f) => ({ ...f, ta: f.ta + 1 }) },
];
export const SOIL_NUDGE_C = 1;   // the whole column 1 C warmer: 'soil'
export const BEAM_NUDGE = 0.1;   // the sun's share through the canopy +0.1: 'shade'
export const KNOBS = [...NUDGES.map((n) => n.key), 'soil', 'shade'];
export const KNOB_WHAT = { ...Object.fromEntries(NUDGES.map((n) => [n.key, n.what])), soil: 'the soil 1 C warmer (the soil columns)', shade: 'direct sun through the canopy +0.1 of its share (the shade map)' };

/** The columns each square carries (besides J_<knob>): what was measured, both predictions, and what went into them. */
export const SQUARE_COLS = ['meas', 'pred', 'predSt', 'v1', 'min', 'el', 'ghi', 'cloud', 'ta', 'wind', 'rh', 'beam', 'sky', 'shelter', 'canopy', 'edge', 'pavingM', 'kind',
  'swNet', 'rnIso', 'ra', 'beta', 'fence', 'paving', 'air', 'u2', 't1', 'lambda1', 'sand', 'clay', 'rootCm', 'full', 'x', 'y'];

/** One row, numbers rounded to keep the table small (3 decimals; null when not a number). */
export const rowOf = (o, cols) => cols.map((c) => (Number.isFinite(o[c]) ? Math.round(o[c] * 1000) / 1000 : null));
