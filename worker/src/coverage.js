/**
 * What the app can pull a property line for, said in plain numbers.
 *
 * COMPUTED, NEVER WRITTEN DOWN. The sentence on the address step used to name
 * five Michigan counties and one in Nevada, and it was true when it was typed.
 * By the time anybody read it the registry held a hundred and fifty-nine
 * entries across thirty-odd states, and the app was telling every visitor
 * outside West Michigan that it had nothing for them. A hand-written list of a
 * growing thing is a promise to keep editing it, and that promise is always
 * broken quietly.
 *
 * So everything here is derived from the registry on the way out. Verify a new
 * county and the page says so on the next request, with no second edit
 * anywhere and nothing to remember.
 *
 * THREE KINDS OF COVERAGE, and flattening them would make the page lie:
 *
 *   whole   one layer serves the entire state, and the state publishes it
 *           itself from its own cadastre. Maryland answered at four points
 *           from the Eastern Shore to the western panhandle.
 *
 *   most    one layer serves the state, assembled from what each county or
 *           town has sent in. North Carolina, Vermont, New Hampshire and
 *           Indiana are all this: a county that has submitted nothing looks
 *           exactly like a working service from here, and Bloomington
 *           demonstrably has parcels that IndianaMap does not carry. Saying
 *           "every county in Indiana" would be the app overstating itself on
 *           the first screen to somebody about to type an address.
 *
 *   some    named counties, each with its own server, each verified.
 *
 * A state can be `most` AND have county servers of its own -- Indiana has
 * three in the atlas -- because a county server that works is worth keeping
 * for the day the state's goes down. Those are named rather than hidden.
 */

import { ALL_COUNTIES } from './counties.js';
import { US_COUNTIES } from './us-counties.js';

/**
 * How many counties a state may be missing before the page stops listing the
 * gaps and starts listing what it has.
 *
 * Five, because "Michigan, all but Alcona and Alger" is a sentence somebody
 * reads and can act on, and "Texas, all but two hundred and thirty-one" is a
 * number pretending to be one. Past the threshold the useful list flips to the
 * other side of the subtraction.
 */
export const NEAR_COMPLETE = 5;

/**
 * The whole picture, one entry per state we can serve anything in.
 *
 *   ab, name     GA, Georgia
 *   kind         'whole' | 'most' | 'some'  -- see the header
 *   total        how many counties the state has
 *   covered      how many we can pull a property line in. For a statewide
 *                layer that is the whole state, which is the claim being made
 *                rather than a count of anything verified.
 *   source       the statewide layer's own name, for the two kinds that have
 *                one, so the page can say where it comes from
 *   counties     individually verified counties, by name, sorted
 *   missing      counties with nothing serving them, by name, sorted. Empty
 *                for a statewide state: `most` means the gaps exist and are
 *                not knowable from here, which is not the same as none.
 *
 * Both lists are always present. Which one a reader should be shown depends on
 * `missing.length`, and that is the caller's call rather than something to
 * decide here by sending one and withholding the other.
 */
export function coverage() {
  const states = {}; // ab -> { fp, ab, name, counties }
  for (const [fp, s] of Object.entries(US_COUNTIES)) states[s.ab] = { fp, ...s };

  const found = new Map(); // ab -> { wide: entry|null, fips: Set }
  const row = (ab) => {
    if (!found.has(ab)) found.set(ab, { wide: null, fips: new Set() });
    return found.get(ab);
  };

  for (const entry of Object.values(ALL_COUNTIES)) {
    if (!entry?.service) continue;

    if (entry.statewide) {
      if (!entry.state || !states[entry.state]) continue;
      /* A state with two statewide layers keeps the one promising more. */
      const held = row(entry.state).wide;
      if (!held || (entry.complete && !held.complete)) row(entry.state).wide = entry;
      continue;
    }

    /*
     * THE FIPS CODE IS THE JOIN, not the name. "St. Louis County" against
     * "St Louis County" and "DeKalb" against "De Kalb" are the same place and
     * different strings, and the registry already carries the number minted to
     * settle exactly that. An entry with no usable code is not counted:
     * claiming a state because a name looked like it might belong to it would
     * be worse than the gap it papers over.
     */
    const fips = String(entry.fips || '');
    if (!/^\d{5}$/.test(fips)) continue;
    const [stateFp, countyFp] = [fips.slice(0, 2), fips.slice(2)];
    const state = US_COUNTIES[stateFp];
    if (!state?.counties[countyFp]) continue;
    row(state.ab).fips.add(countyFp);
  }

  const out = [];
  for (const [ab, { wide, fips }] of found) {
    const state = states[ab];
    const all = Object.entries(state.counties); // [fp, name]
    const everyOne = !wide && fips.size === all.length;
    const kind = wide ? (wide.complete ? 'whole' : 'most') : everyOne ? 'whole' : 'some';

    out.push({
      ab,
      name: state.name,
      kind,
      total: all.length,
      covered: wide ? all.length : fips.size,
      source: wide ? wide.name : null,
      counties: all.filter(([fp]) => fips.has(fp)).map(([, n]) => n).sort(),
      /* Not "none missing" -- unknowable. See the header on `most`. */
      missing: wide ? [] : all.filter(([fp]) => !fips.has(fp)).map(([, n]) => n).sort(),
    });
  }

  /*
   * Whole states, then near-whole, then by how much of the state is covered.
   * Somebody opening this is asking "is my state in here", and the ones worth
   * putting at the top are the ones where the answer is unambiguous.
   */
  const rank = { whole: 0, most: 1, some: 2 };
  out.sort((a, b) =>
    (rank[a.kind] - rank[b.kind])
    || (b.covered / b.total - a.covered / a.total)
    || a.name.localeCompare(b.name));
  return out;
}

/**
 * The one-line version, small enough to ride along with /api/config so the
 * address step can say something true before anybody asks for the detail.
 *
 * `counties` counts the individually verified ones only. A statewide layer is
 * deliberately not converted into a county count: adding Indiana's 92 to the
 * total would turn a claim the registry makes into 92 counties nobody has
 * checked, and the number on the front page is the one that must not be
 * hopeful.
 */
export function coverageSummary() {
  const states = coverage();
  const some = states.filter((s) => s.kind === 'some');
  return {
    /* Every state with anything at all, which is the number the dialog's own
       first line reports and the one a reader counts the rows against. */
    states: states.length,
    whole: states.filter((s) => s.kind === 'whole').map((s) => s.name),
    most: states.filter((s) => s.kind === 'most').map((s) => s.name),
    /*
     * COUNTED SEPARATELY FROM THE STATES ABOVE, not added to them. The
     * sentence reads "all of Maryland, most of Indiana, plus N counties in M
     * other states", and "other" has to be true: folding Indiana's own three
     * county servers into N would count Indiana twice and leave a reader
     * unable to reconcile any two numbers on the line. They are in the dialog,
     * on Indiana's row, where they belong.
     */
    someStates: some.length,
    someCounties: some.reduce((n, s) => n + s.counties.length, 0),
  };
}
