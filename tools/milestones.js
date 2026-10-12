/**
 * REMINDERS TIED TO THE CORPUS'S SIZE (owner, 2026-10-06). Said at the end of
 * every deploy log (ci-prepare counts the approved maps) and in every training
 * run's log (train_decoder.py, which keeps the same number), because nobody
 * remembers a promise like "when we have 500 maps" on their own.
 */
export const MILESTONES = [
  {
    maps: 150,
    say: 'Revisit the decoder: a small UperNet head lost to our own small decoder at 104 maps '
      + '(H93, overfitting); try it again now there are more, and Mask2Former only if it shows something. '
      + 'S26 in docs/DETECTOR-FINDINGS.md.',
  },
];

/** The reminders a corpus of `n` approved maps has reached. */
export function milestonesReached(n) {
  return MILESTONES.filter((m) => Number.isFinite(n) && n >= m.maps);
}
