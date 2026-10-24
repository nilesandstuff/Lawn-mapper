/**
 * THE LIVE MODEL'S VERSION HISTORY (owner, 2026-10-06): its name in the
 * picker, "Turf Trace - alpha version 2 (79% accuracy)", and the list behind
 * the picker's "Version history" button.
 *
 * ONE ROW PER RELEASE SHIPPED TO THE LIVE SERVER, newest last. Add a row
 * whenever workflow 14 `release: alpha` ships a new model; the last row is
 * the live one.
 *
 * ACCURACY is 100 minus the configuration's typical held-out lot error -- the
 * median of THE PLAN's row in the workflow 14 runs that picked it (each lot
 * scored by a model that never saw it), rounded. A release itself trains on
 * every lot and so has no held-out score of its own; this is the best rough
 * figure, meant to show progress, not to be quoted to a decimal.
 *
 * STAGE follows the owner's thresholds: alpha below 82%, beta from 82% to
 * under 86%, no stage label from 86% on. Versions count up across stages.
 */
export const MODEL_VERSIONS = [
  {
    version: 1,
    shipped: '2026-09-29',
    trainedAt: '2026-09-29T21:10:24Z',
    accuracy: 76,
    lots: 55,
    basis: 'THE PLAN of 2026-09-29: 24.0% typical lot error, run 36601001355',
  },
  {
    version: 2,
    shipped: '2026-10-06',
    trainedAt: '2026-10-06T06:44:39Z',
    accuracy: 79,
    lots: 80,
    basis: 'H78: taught under trees, canopy as input; 21.0 / 21.3 / 21.0% over three seeds, runs 37393325860, 37393416186, 37393510265',
  },
  {
    version: 3,
    shipped: '2026-10-07',
    trainedAt: '2026-10-07T15:52:29Z',
    accuracy: 79,
    lots: 81,
    basis: 'H83: three decoders averaged; 20.3 / 22.1 / 20.7% over three seeds (mean 21.0), runs 37582634690, 37582729096, 37582829432 -- the single-decoder setup on the same runs and locked 81 lots is 21.8 (78%)',
  },
  {
    version: 4,
    shipped: '2026-10-11',
    trainedAt: '2026-10-11T07:44:29Z',
    accuracy: 81,
    lots: 104,
    basis: 'v3 retrained on every approved map (104, 31 of them county-drawn) plus the owner\'s 5 not-lawn-only maps (owner, 2026-10-11), run 38115838951. Accuracy is the nearest measurement: THE PLAN\'s single decoder on the locked 104, 19.0 / 19.1 / 18.9% (H92 runs 38085217225, 38085219178, 38085221591). The averaged-of-3 + not-lawn arrangement at 104 is NOT separately measured; H79 found the pond maps worth nothing measurable overall (they carry B12)',
  },
  {
    version: 5,
    shipped: '2026-10-13',
    trainedAt: '2026-10-13T23:18:29Z',
    accuracy: 81,
    lots: 105,
    basis: 'v4\'s arrangement on the new lidar -- the newest USGS flight by its own dates, from its LAZ tiles where AWS lags (H96), the NAD83 datum move (H95), noise dropped -- and the lidar\'s ground brightness as an input (H97); every approved map (105) plus the 5 not-lawn-only maps, run 38474850752 (the first try, 38442418156, lost its 18 tile frames and was replaced). Accuracy: THE PLAN\'s single decoder on that arrangement at the locked 104, 19.1 / 18.6 / 18.0% (runs 38474854745, 38474858216, 38474862635; against the old 18.9 / 18.8 / 19.5%, 44 lots better and 24 worse, p = 0.021). The averaged-of-3 + not-lawn release itself is not separately measured',
  },
  {
    version: 6,
    shipped: '2026-10-23',
    trainedAt: '2026-10-23T20:27:21Z',
    accuracy: 85,
    lots: 106,
    basis: 'A new eye (owner, 2026-10-23: "1 yes do it"): DINOv3\'s satellite ViT-L in place of Scale-MAE, on v5\'s arrangement -- three decoders averaged, every approved map (106) plus the 5 not-lawn-only maps, every lot read whole at 896 -- run 39997905282. Accuracy: THE PLAN\'s single decoder on this eye at the locked 104, no pond examples, 15.4% (H114, run 39858638936; 71 lots better and 23 worse than Scale-MAE, the county-photo lots 25.9 -> 17.1). The averaged + pond release itself is not separately measured; S62 measures the eye with the pond examples on',
  },
  {
    version: 7,
    shipped: '2026-10-23',
    trainedAt: '2026-10-23T23:11:25Z',
    accuracy: 85,
    lots: 106,
    basis: 'v6 with the big lots read whole at 10 cm a pixel in one pass (owner, 2026-10-23: "yes go ahead"; H121), trained on Modal\'s GPU with the pond maps: 31 of the 111 frames read whole at up to 4096 px, three decoders averaged, run 40028974483. Accuracy: still H114\'s 15.4% for this eye; H121 measured the native read on one seed as a tie over all lots and -1.2 points on the 26 past 90 m (20.7% -> 17.3%). The release itself is not separately measured',
  },
];

/** alpha below 82%, beta below 86%, then no stage label. */
export function stageFor(accuracy) {
  if (accuracy < 82) return 'alpha';
  if (accuracy < 86) return 'beta';
  return null;
}

/** "Turf Trace - alpha version 2 (79% accuracy)". */
export function modelName(v) {
  const stage = stageFor(v.accuracy);
  return `Turf Trace - ${stage ? `${stage} ` : ''}version ${v.version} (${v.accuracy}% accuracy)`;
}

export const currentModel = () => MODEL_VERSIONS[MODEL_VERSIONS.length - 1];

/** The list the picker shows, newest first, the live one marked. */
export function versionHistory() {
  const live = currentModel().version;
  return MODEL_VERSIONS.map((v) => ({
    version: v.version, stage: stageFor(v.accuracy), shipped: v.shipped,
    accuracy: v.accuracy, lots: v.lots, live: v.version === live, name: modelName(v),
  })).reverse();
}
