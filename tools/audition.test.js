/**
 * Choosing the lawns a stranger's first attempts are scored against.
 *
 * WHY THIS ORDERING IS WORTH TESTING. An audition with an ambiguous answer
 * does not merely fail to measure anybody -- it fails the CAREFUL people, who
 * are the ones with an opinion about where a tree line ends. Rejecting exactly
 * the workers worth keeping is the worst outcome this whole arrangement has,
 * and it would look from the outside like nobody good applied.
 *
 *   node tools/audition.test.js
 */

import { difficulty, sizeIsOrdinary, EASY_MIN_SQFT, EASY_MAX_SQFT } from './pick-audition.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const lawn = (over = {}) => ({
  square_feet: 12000, tree_line: 0, hand_edited: 1, inferred_shapes: 0, ...over,
});

/* ------------------------------------------- inferred ground disqualifies */
{
  /*
   * Ground marked "I know it is lawn, I cannot see it" is a judgement call by
   * definition, and workers are explicitly told those marks are optional. A
   * lawn that needs them cannot score anybody, however tidy it is otherwise.
   */
  const clean = lawn();
  const marked = lawn({ inferred_shapes: 1 });
  check('a lawn with inferred areas ranks below a clean one',
    difficulty(marked) > difficulty(clean),
    `${difficulty(marked).toFixed(1)} against ${difficulty(clean).toFixed(1)}`);

  /*
   * AND IT OUTWEIGHS EVERYTHING ELSE. A perfect-sized, hand-edited, canopy-free
   * lawn with one inferred patch must still rank below an awkward lawn with
   * none -- otherwise the other weights could quietly vote it back in.
   */
  const awkward = lawn({ square_feet: EASY_MAX_SQFT, tree_line: 1, hand_edited: 0 });
  check('and no combination of other faults outweighs it',
    difficulty(lawn({ inferred_shapes: 1 })) > difficulty(awkward),
    `${difficulty(lawn({ inferred_shapes: 1 })).toFixed(1)} against `
    + `${difficulty(awkward).toFixed(1)} for a lawn with every other problem`);
}

/* ------------------------------------------------------ the tree line */
{
  check('a wooded lot ranks below an open one',
    difficulty(lawn({ tree_line: 1 })) > difficulty(lawn({ tree_line: 0 })),
    'H12: the ambiguous ground around trees is where two careful people disagree');

  /*
   * An ungraded lawn is treated as the worst rather than the best. Nobody has
   * looked; assuming it is clear would put an unknown into the answer key.
   */
  check('and an ungraded one is assumed wooded, not assumed clear',
    difficulty(lawn({ tree_line: null })) > difficulty(lawn({ tree_line: 0 })),
    'an unchecked lawn must not sneak into the answer key by being unchecked');
}

/* ------------------------------------------------------------- size */
{
  check('an estate and a courtyard are both out of range',
    !sizeIsOrdinary(158451) && !sizeIsOrdinary(400),
    `the range is ${EASY_MIN_SQFT}–${EASY_MAX_SQFT} sq ft`);
  check('and an ordinary garden is in it',
    sizeIsOrdinary(12000) && sizeIsOrdinary(6000), 'both typical corpus sizes');

  /*
   * Within the range, the middle is preferred at BOTH ends -- an audition that
   * takes half an hour tests stamina, and one that is over in twenty seconds
   * tests nothing. Nobody is paid for the audition either way.
   */
  const middle = lawn({ square_feet: (EASY_MIN_SQFT + EASY_MAX_SQFT) / 2 });
  check('and a middling lawn beats one at either edge of the range',
    difficulty(middle) < difficulty(lawn({ square_feet: EASY_MIN_SQFT }))
    && difficulty(middle) < difficulty(lawn({ square_feet: EASY_MAX_SQFT })),
    'stamina is not the thing being tested');
}

/* --------------------------------------------------- SAM is not the answer */
{
  /*
   * A map nobody corrected is SAM's opinion rather than a person's, and
   * scoring a stranger against SAM would be scoring them against the very
   * thing they were hired to beat -- a worker who drew a BETTER outline than
   * SAM would fail for it.
   */
  check('a map nobody hand edited ranks below one somebody corrected',
    difficulty(lawn({ hand_edited: 0 })) > difficulty(lawn({ hand_edited: 1 })),
    'otherwise a worker who beats SAM fails the audition for beating SAM');
}

/* ------------------------------------------------ the whole ordering */
{
  /* The one that matters end to end: given a realistic mix, the pick is the
     open, hand-edited, ordinary lawn with nothing inferred. */
  const pile = [
    { name: 'wooded', ...lawn({ tree_line: 1 }) },
    { name: 'inferred', ...lawn({ inferred_shapes: 2 }) },
    { name: 'huge', ...lawn({ square_feet: EASY_MAX_SQFT }) },
    { name: 'raw SAM', ...lawn({ hand_edited: 0 }) },
    { name: 'the good one', ...lawn() },
    { name: 'ungraded', ...lawn({ tree_line: null }) },
  ].sort((a, b) => difficulty(a) - difficulty(b));

  check('the easiest lawn is the one an audition should use',
    pile[0].name === 'the good one',
    pile.map((p) => p.name).join(' < '));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
