/**
 * Every map in the corpus, in one list.
 *
 * SAME RULE AS THE CONSOLE: there is no permission logic here and there must
 * not be. The API answers 404 to anybody who is not an administrator, so this
 * whole page is one `if (it loaded)`.
 *
 * And the same rule about text: everything below goes in with textContent. A
 * county name and a map id both arrive from somewhere else, and one innerHTML
 * on this page runs a stranger's script while signed in as the owner.
 */

/*
 * The console's own drawing, not a second one. Two pages putting the same
 * outline in slightly different places is the fault this shares a module to
 * avoid -- and on this page, telling two copies of a lawn apart is the entire
 * job, so a drawing that cannot be trusted would make the page pointless.
 */
import { paint } from '/lib/review-draw.js';
import { latLngOfId, coordsLine } from '/lib/coords.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

const n = (v) => Number(v || 0).toLocaleString();
const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

const post = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.reason || data.error || `refused (${res.status})`);
  }
  return data;
};

/*
 * WHAT EACH FILTER IS FOR, rather than a list of statuses for its own sake.
 *
 * "Not checked yet" is the one that earns its place: it is the same set the
 * console's inferred queue works through, and seeing its size is how you know
 * whether that job is nearly done without opening it.
 */
const FILTERS = {
  all: () => true,
  approved: (m) => m.status === 'approved',
  new: (m) => m.status === 'new',
  rejected: (m) => m.status === 'rejected',
  marked: (m) => m.marked > 0,
  unchecked: (m) => m.status === 'approved' && !m.checked,
};

let maps = [];
let duplicates = [];
let filter = 'all';

/** One row. Deliberately dense: this page is for scanning, not for reading. */
function row(m, { dim = false, open = false } = {}) {
  const box = el('div', `entry${dim ? ' dim' : ''}`);

  /*
   * Redrawn rather than rebuilt, because a verdict changes the pills and
   * nothing else. Rebuilding the row would throw away a canvas somebody has
   * already waited for and looked at -- and looking at it is how they decided.
   */
  const top = el('div', 'top');
  const pills = () => {
    top.replaceChildren();
    if (m.name) top.append(el('span', 'pill', m.name));
    top.append(el('b', null, m.county || 'traced by hand'));
    /*
     * Green for approved, grey for rejected, amber for one still waiting.
     * Approved and rejected were both grey, which on a page whose job is
     * scanning meant the two verdicts looked identical and only the word
     * told them apart -- so the colour was carrying nothing and the eye had
     * to read every row.
     */
    top.append(el('span', `pill ${m.status === 'rejected' ? 'grey' : m.status === 'new' ? 'warn' : ''}`, m.status));
    if (m.marked) top.append(el('span', 'pill', `${m.marked} inferred`));
    /*
     * "Not checked" rather than a tick for checked. The absence is the
     * actionable state and the presence is the resting one, so only the
     * absence is worth a pill -- a page where every row carries a badge has
     * no badges.
     */
    if (m.status === 'approved' && !m.checked) top.append(el('span', 'pill warn', 'not checked'));
    if (!m.hasImage) top.append(el('span', 'pill warn', 'no photo'));
  };
  pills();
  box.append(top);

  box.append(el('div', 'meta',
    `${n(m.squareFeet)} sq ft · ${m.pieces} piece${m.pieces === 1 ? '' : 's'} · `
    + `${m.method} · saved ${day(m.at)}`));

  /*
   * THE ID IN FULL, because it is the only handle there is. It is also the
   * thing that went wrong: two ids differing in the fifth decimal place were
   * the same lawn twice, and nothing but reading them side by side showed it.
   */
  box.append(el('div', 'mono', m.id));
  /* And the address point the right way round, to paste elsewhere. */
  const ll = latLngOfId(m.id);
  if (ll) box.append(coordsLine(ll));

  /*
   * AND THE MAP ITSELF, which a list of square footages cannot stand in for.
   * Two rows for one garden are told apart by looking at them: same lawn or
   * next door, marks on one and not the other, an outline somebody improved.
   *
   * Fetched per map rather than shipped with the list. Five hundred rows of
   * outlines is a megabyte of coordinates to answer a question about two of
   * them, so a duplicate group draws itself and everything else waits to be
   * asked.
   */
  const canvas = el('canvas', 'shot');
  canvas.width = 320;
  canvas.height = 320;
  const show = el('button', 'ghost small', 'Look at it');
  let drawn = false;
  const draw = async () => {
    if (drawn) return;
    drawn = true;
    show.remove();
    box.append(canvas);
    try {
      const res = await fetch(`/api/admin/candidate?id=${encodeURIComponent(m.id)}`);
      if (!res.ok) throw new Error(String(res.status));
      const full = await res.json();
      paint(canvas, { ...full, hasImage: m.hasImage });
    } catch {
      box.append(el('p', 'empty', 'That map could not be drawn.'));
    }
  };
  show.addEventListener('click', draw);
  if (open) draw(); else box.append(show);

  /* A not-lawn-only map (tinker mode) is not a lawn to approve: "Put it back"
     after a reject would make it 'approved', and training would read its
     empty lawn as "nothing on this lot is lawn". No verdict offered. */
  if (!String(m.status || '').startsWith('notlawn')) box.append(verdictRow(m, pills));
  return box;
}

/*
 * THE VERDICT, FROM THE LIST.
 *
 * Seeing two copies of a lawn and not being able to drop one is most of a
 * feature: the page's whole reason to exist is deciding which duplicate to
 * lose, and a page that can only point at the problem sends you to the
 * console to find the same map again by eye.
 *
 * It goes through the same /api/admin/review route the console uses. Not a
 * new one: a second way to write a verdict is a second set of rules about
 * what a verdict means, and they drift.
 */
function verdictRow(m, pills) {
  const wrap = el('div', 'actions verdict-row');
  const note = el('small', null, '');

  /*
   * ONE BUTTON, LABELLED BY WHAT IT WILL DO TO THIS ROW. A pair reading
   * "Approve / Reject" over a map that is already approved says nothing; the
   * only move worth offering is the one that changes something.
   */
  const flipTo = () => (m.status === 'rejected' ? 'approved' : 'rejected');
  const btn = el('button', null, '');
  const relabel = () => {
    btn.className = m.status === 'rejected' ? 'yes' : 'no';
    btn.textContent = m.status === 'rejected' ? 'Put it back' : 'Reject it';
  };
  relabel();

  /*
   * TWO TAPS TO REJECT, ONE TO RESTORE.
   *
   * Not symmetry for its own sake: this is a long list on a phone, and a
   * stray thumb while scrolling should not be able to drop a map out of the
   * training set. Putting one back is the undo, so guarding it would only
   * make the recovery harder than the mistake.
   */
  let armed = 0;
  const disarm = () => { armed = 0; relabel(); };

  const send = async () => {
    btn.disabled = true;
    note.textContent = 'Saving…';
    const want = flipTo();
    try {
      await post('/api/admin/review', {
        id: m.id,
        status: want,
        /*
         * Sent back exactly as it came, because the route writes both
         * columns outright. Omitting the grade would erase it, and this page
         * never asked the canopy question so it has no answer of its own.
         */
        queue: m.reviewQueue || 'list',
        canopy: m.canopy,
        /*
         * The current verdict was on the screen, in a pill, above the button
         * that was pressed. That is the condition the server's guard exists
         * to check for, so this is the honest place to say so.
         */
        force: true,
      });
      m.status = want;
      pills();
      relabel();
      note.textContent = '';
      refreshCounts();
    } catch (err) {
      note.textContent = `Did not save: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', () => {
    if (m.status === 'rejected') { send(); return; }
    if (armed) { clearTimeout(armed); armed = 0; send(); return; }
    btn.className = 'no armed';
    btn.textContent = 'Really reject it?';
    /* It disarms itself, so a question left unanswered goes back to being a
       button rather than sitting there armed until a later scroll finds it. */
    armed = setTimeout(disarm, 5000);
  });

  /*
   * EDIT, in the real editor (owner, 2026-09-30: a mistake spotted in one of
   * the inferred areas). The same door the console's Edit button uses --
   * /#review=<id> -- with a note to come back HERE rather than to the console.
   * Saving puts the map back to unreviewed, as it does from the console:
   * the approval was of the old outline.
   */
  const editLink = el('a', 'button-link', 'Edit');
  editLink.href = `/#review=${encodeURIComponent(m.id)}&back=maps`;
  editLink.title = 'Open this map in the editor, fix it, and save it back';
  wrap.append(btn, editLink, note);
  return wrap;
}

/*
 * The tallies, separately from the list, because a verdict changes them and
 * must not redraw the rows. Re-rendering would take back every canvas
 * somebody had opened -- including, on a duplicate, the two they were in the
 * middle of comparing.
 *
 * Which also means a rejected row STAYS PUT under the "Approved" filter until
 * the next load. It says "rejected" on it, so the list is not lying; making
 * rows vanish under the finger that judged them would be worse.
 */
function refreshCounts() {
  const shown = maps.filter(FILTERS[filter] || FILTERS.all);
  $('#counts').textContent =
    `${maps.length} map${maps.length === 1 ? '' : 's'} in the corpus · `
    + `${maps.filter(FILTERS.approved).length} approved · `
    + `${maps.filter(FILTERS.rejected).length} rejected · `
    + `${maps.filter(FILTERS.unchecked).length} still to check for inferred areas · `
    + `showing ${shown.length}`;
  return shown;
}

function render() {
  const list = $('#list');
  list.innerHTML = '';

  const shown = refreshCounts();

  if (!shown.length) {
    list.append(el('p', 'empty', 'Nothing matches that filter.'));
    return;
  }
  for (const m of shown) list.append(row(m));
}

function renderDupes() {
  if (!duplicates.length) return;
  $('#dupes-card').hidden = false;
  const box = $('#dupes');
  box.innerHTML = '';

  const byId = new Map(maps.map((m) => [m.id, m]));
  for (const ids of duplicates) {
    const group = el('div', 'dupe-group');
    /*
     * The one carrying marks goes first and the rest are dimmed, because that
     * is nearly always the copy to keep -- somebody did work on it that the
     * other does not have. Nearly always is not always, which is why the other
     * is shown rather than hidden.
     */
    const rows = ids.map((id) => byId.get(id)).filter(Boolean)
      .sort((a, b) => (b.marked - a.marked) || (b.at || '').localeCompare(a.at || ''));
    /* A duplicate group draws itself. Comparing two lawns is why somebody
       scrolled to this card, and making them tap twice first is a page that
       has not understood its own purpose. */
    for (const [i, m] of rows.entries()) group.append(row(m, { dim: i > 0, open: true }));
    box.append(group);
  }
}

(async () => {
  let data;
  try {
    const res = await fetch('/api/admin/maps');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#locked').hidden = false;
    return;
  }

  maps = data.maps || [];
  duplicates = data.duplicates || [];
  $('#page').hidden = false;

  renderDupes();
  render();

  for (const key of Object.keys(FILTERS)) {
    const btn = $(`#filter-${key}`);
    if (!btn) continue;
    btn.addEventListener('click', () => {
      filter = key;
      for (const other of Object.keys(FILTERS)) {
        $(`#filter-${other}`)?.classList.toggle('on', other === key);
      }
      render();
    });
  }
})();
