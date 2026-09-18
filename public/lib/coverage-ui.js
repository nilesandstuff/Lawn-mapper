/**
 * The coverage sentence, and the list behind it.
 *
 * NOTHING HERE IS WRITTEN DOWN. Both the sentence on the address step and
 * every row in the dialog are built from what the Worker computes off the
 * parcel registry, so verifying a new county changes what this says with no
 * second edit anywhere. The paragraph this replaces named six counties and had
 * been wrong for months -- a hand-written list of a growing thing is a promise
 * to keep editing it, and that promise is always broken quietly.
 *
 * Everything below goes in with textContent. A county name is a string from a
 * public records office by way of the Census, and one innerHTML here would run
 * whatever that string turned out to contain.
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

/** "Maryland and Connecticut", "a, b and c" -- an English list, not a join. */
export function listOf(names) {
  const n = names.filter(Boolean);
  if (!n.length) return '';
  if (n.length === 1) return n[0];
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/**
 * The sentence for the address step.
 *
 * TWO KINDS OF STATE, SAID DIFFERENTLY, because they are different promises.
 * A state we serve whole is served whole. A statewide layer that is a mosaic
 * of what each county sent the state has holes in it that look exactly like a
 * working service from here -- so it gets "most of", and somebody in a gap is
 * disappointed rather than misled.
 */
export function coverageSentence(c) {
  const whole = c.whole?.length ? [`all of ${listOf(c.whole)}`] : [];
  const most = c.most?.length ? [`most of ${listOf(c.most)}`] : [];
  /*
   * A COMMA BETWEEN THE CLAUSES, NOT "AND". Each clause already ends in an
   * "and" of its own, so joining them with another produced "all of
   * Connecticut and Maryland and most of Indiana..." -- three ands in a row
   * doing two different jobs, which reads as a typo rather than a list.
   */
  const states = [...whole, ...most].join(', ');

  /*
   * "PLUS", NOT A THIRD ITEM IN THE LIST. Joining it with "and" produced
   * "...North Carolina and Vermont and 152 counties in 45 states", which is
   * two ands doing different jobs in one breath and reads as a mistake. The
   * counties are a separate clause because they are a separate claim.
   */
  const counties = c.someCounties
    ? `${c.someCounties} ${c.someCounties === 1 ? 'county' : 'counties'} in `
      + `${c.someStates} ${states ? 'other ' : ''}`
      + `${c.someStates === 1 ? 'state' : 'states'}`
    : '';

  const body = states && counties ? `${states}, plus ${counties}`
    : states || counties;
  if (!body) return 'Property lines come from public records.';
  return `Property lines come from public records — ${body}.`;
}

/**
 * The count beside a state's name.
 *
 * "9 of 9" reads as a riddle; "all 9" reads as an answer. And a mosaic must
 * not say "all 10" while the sentence above it says "most of New Hampshire" --
 * two numbers for the same state that disagree in the same glance is worse
 * than either one alone.
 */
const countOf = (s) => (s.kind === 'some' ? `${s.covered} of ${s.total}`
  : s.kind === 'most' ? 'most of the state'
    : s.total === 1 ? 'the whole state' : `all ${s.total}`);

/**
 * WHICH LIST A STATE'S ROW SHOULD SHOW, decided before any element is made so
 * the rule can be argued with on its own.
 *
 *   none     one layer serves the state and no county was checked separately.
 *            Nothing to open, so the row does not offer a triangle.
 *   missing  the short list of what is absent: "Missing: Garrett and Kent"
 *   has      the counties we do have
 *   also     a statewide layer that ALSO has county servers of its own
 *
 * SUBTRACTING IS ONLY WORTH IT WHEN IT IS SHORTER, which the threshold alone
 * does not guarantee. Hawaii has two of its five counties: listing the three
 * it is missing is a longer list than naming the two it has, and tells a
 * reader in Honolulu less. Delaware is the same, one of three. So the rule is
 * "few enough to be a sentence AND fewer than the alternative", not just the
 * first half.
 */
export function shownList(s, nearComplete) {
  if (s.kind !== 'some') {
    if (!s.counties.length) return { mode: 'none', names: [] };
    /*
     * "ALSO" ONLY IF THERE IS SOMETHING ELSE. Connecticut is whole because all
     * nine of its planning regions are covered one at a time, with no
     * statewide layer anywhere -- so "Also served county by county" was
     * pointing at a layer that does not exist. The presence of a source is
     * what makes "also" a true word.
     */
    return { mode: s.source ? 'also' : 'has', names: s.counties };
  }
  const subtract = s.missing.length
    && s.missing.length <= nearComplete
    && s.missing.length < s.counties.length;
  return subtract
    ? { mode: 'missing', names: s.missing }
    : { mode: 'has', names: s.counties };
}

/**
 * One row per state.
 *
 * WHAT A ROW SHOWS depends on what is worth reading, which is the whole point
 * of the threshold. A state served by one layer has no county list worth
 * opening, so it does not pretend to. A state missing four counties names the
 * four. A state with nine of a hundred and twenty names the nine. Listing a
 * hundred and eleven counties Kentucky does not have would be technically the
 * same information and useless.
 */
function stateRow(s, nearComplete) {
  const head = (node) => {
    node.className = 'cov-head';
    node.append(el('span', 'cov-name', s.name));
    node.append(el('span', 'cov-count', countOf(s)));
    return node;
  };

  const { mode, names } = shownList(s, nearComplete);

  /* Nothing to open, so it does not offer a triangle that discloses nothing. */
  if (mode === 'none') {
    const flat = el('div', 'cov-flat');
    flat.append(head(el('div')));
    if (s.source) flat.append(el('p', 'cov-source', s.source));
    return flat;
  }

  const row = el('details', 'cov-state');
  row.append(head(el('summary')));

  const p = el('p', 'cov-names');
  if (mode === 'missing') {
    p.append(el('b', null, 'Missing: '));
    p.append(document.createTextNode(listOf(names)));
  } else if (mode === 'also') {
    /*
     * A statewide layer WITH county servers of its own. Both are true and the
     * second is worth saying: it is the fallback for the day the state's layer
     * goes down, and it is the only part of that state anybody has checked one
     * parcel at a time.
     */
    p.append(el('b', null, 'Also served county by county: '));
    p.append(document.createTextNode(listOf(names)));
  } else {
    /* Plain commas, not an English list: this is a directory of forty
       counties, not a sentence, and "and" before the last one pretends
       otherwise. */
    p.textContent = names.join(', ');
  }
  row.append(p);

  if (s.source) row.append(el('p', 'cov-source', s.source));
  return row;
}

/**
 * Wire the note and the dialog. Safe to call on a page that has neither.
 *
 * The full list is fetched when the dialog is first opened, not at startup:
 * it is three thousand county names, and the address step needs four numbers.
 */
export function mountCoverage({ summary, fetchList }) {
  const dialog = document.getElementById('coverage-dialog');
  /*
   * EVERY BUTTON THAT ASKS, not one by id. The question comes up twice -- on
   * the address step before anybody has typed anything, and on the Property
   * line tab when the boundary came back empty and somebody wants to know
   * whether that is their county or a fault. One dialog, one list, and an
   * attribute rather than a second id so a third place costs nothing.
   */
  const openers = document.querySelectorAll('[data-coverage-open]');
  if (!dialog || !openers.length) return;

  /*
   * Only the first sentence is replaced. The rest of the paragraph -- "anywhere
   * else you trace it yourself" -- and the button are true whatever the numbers
   * say, and rebuilding the paragraph would take the button with it.
   */
  const text = document.getElementById('coverage-text');
  if (summary && text) text.textContent = coverageSentence(summary);

  const list = document.getElementById('coverage-list');
  const lead = document.getElementById('coverage-lead');
  let loaded = false;

  const fill = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const data = await fetchList();
      const states = data.states || [];
      const near = Number(data.nearComplete) || 5;

      lead.textContent = states.length
        ? `${states.length} states. Tap one to see which counties.`
        : 'No counties are configured on this deployment.';

      list.replaceChildren();
      for (const s of states) list.append(stateRow(s, near));
    } catch {
      loaded = false; // so closing and reopening tries again
      lead.textContent = 'That list could not be loaded just now.';
    }
  };

  for (const open of openers) {
    open.addEventListener('click', () => {
      fill();
      /* showModal over show(): it is the one that dims the page behind, traps
         focus and answers Escape, which is the whole reason this is a dialog. */
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
  }
  document.getElementById('coverage-close')
    ?.addEventListener('click', () => dialog.close());
  /*
   * A tap on the backdrop closes it. The backdrop is not a child, so a click
   * on it lands on the dialog itself -- which is how a click outside the card
   * is told from a click on something in it.
   */
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
}
