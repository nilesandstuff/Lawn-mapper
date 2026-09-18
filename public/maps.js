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

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

const n = (v) => Number(v || 0).toLocaleString();
const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

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

  const top = el('div', 'top');
  top.append(el('b', null, m.county || 'traced by hand'));
  top.append(el('span', `pill ${m.status === 'approved' ? 'free' : m.status === 'rejected' ? 'grey' : ''}`, m.status));
  if (m.marked) top.append(el('span', 'pill', `${m.marked} inferred`));
  /*
   * "Not checked" rather than a tick for checked. The absence is the
   * actionable state and the presence is the resting one, so only the absence
   * is worth a pill -- a page where every row carries a badge has no badges.
   */
  if (m.status === 'approved' && !m.checked) top.append(el('span', 'pill warn', 'not checked'));
  if (!m.hasImage) top.append(el('span', 'pill warn', 'no photo'));
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
  return box;
}

function render() {
  const list = $('#list');
  list.innerHTML = '';

  const shown = maps.filter(FILTERS[filter] || FILTERS.all);
  $('#counts').textContent =
    `${maps.length} map${maps.length === 1 ? '' : 's'} in the corpus · `
    + `${maps.filter(FILTERS.approved).length} approved · `
    + `${maps.filter(FILTERS.unchecked).length} still to check for inferred areas · `
    + `showing ${shown.length}`;

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
