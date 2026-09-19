/**
 * One outline per lawn, worst first.
 *
 * SAME RULE AS THE OTHER OWNER PAGES: no permission logic here and there must
 * not be. The API answers 404 to anybody who is not an administrator, so this
 * whole page is one `if (it loaded)`.
 *
 * And the same rule about text: everything goes in with textContent. A county
 * name arrives from a public records office by way of the Census, and one
 * innerHTML on this page runs a stranger's string while signed in as the owner.
 */

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

const n = (v) => Number(v || 0).toLocaleString();
const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);

/**
 * One lawn.
 *
 * THE TWO KINDS OF MISTAKE ARE SHOWN SEPARATELY, not rolled into the error
 * figure, because they mean opposite things and the summary hides which is
 * happening. A model that misses half the lawn and one that claims the whole
 * property can score the same and need completely different work.
 *
 * AND THE EDITING COST BESIDE THEM. Pieces and handles are not accuracy; they
 * are how much dragging a person would do to fix this outline, which is the
 * question the page exists for. A shape can be close and unusable.
 */
function row(e, i) {
  const box = el('div', 'entry');

  const top = el('div', 'top');
  top.append(el('b', null, e.county || 'traced by hand'));
  top.append(el('span', 'pill warn', `${pct(e.errorPct)} out`));
  if (e.samErrorPct !== null && e.samErrorPct !== undefined) {
    /* SAM beside it, because "28% wrong" only means something against the
       thing we currently pay for on the same lawn. */
    top.append(el('span', `pill ${e.errorPct < e.samErrorPct ? '' : 'grey'}`,
      `SAM ${pct(e.samErrorPct)}`));
  }
  if (e.inferredPct >= 1) top.append(el('span', 'pill', `${pct(e.inferredPct)} inferred`));
  box.append(top);

  box.append(el('div', 'meta',
    `${n(e.squareFeet)} sq ft of lawn · ${Math.round(e.mpp * 100)} cm a pixel · `
    + `found ${pct(e.foundPct)} of it · over-called ${pct(e.overPct)}`));

  /*
   * What correcting it would cost. Written as a sentence rather than as two
   * more percentages, because it is a different kind of fact from the ones
   * above it -- those are about accuracy, this is about work.
   *
   * Older index files have no counts; they get no line rather than a row of
   * zeroes, which would read as "one piece, no handles".
   */
  if (e.pieces !== undefined && e.pieces !== null) {
    let cost = `${n(e.pieces)} ${e.pieces === 1 ? 'piece' : 'pieces'}, `
      + `${n(e.vertices)} ${e.vertices === 1 ? 'handle' : 'handles'} to drag`;
    /* What the tracer binned before anybody saw it. Invisible in the picture
       by definition, and a model whose answer is mostly speckle looks tidy
       once the speckle has been dropped. */
    if (e.droppedPieces) {
      cost += ` · ${n(e.droppedPieces)} scraps dropped (${n(e.droppedSqFt)} sq ft)`;
    }
    box.append(el('div', 'meta cost', cost));
  }

  /*
   * The picture loads only when it is scrolled to. Twenty-three of these is
   * about five megabytes, and on a phone that is the difference between a
   * page and a wait.
   */
  const img = el('img', 'shot pred');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = `Lawn ${i + 1}: the outline the detector drew, over the photograph, `
    + 'with the hand-traced lawn washed in green';
  img.src = `/api/admin/prediction-image?key=${encodeURIComponent(e.key)}`;
  img.addEventListener('error', () => {
    img.replaceWith(el('p', 'empty', 'That picture could not be loaded.'));
  });
  box.append(img);

  /* Only where there is marked ground to say anything about. Printing "—" on
     the maps with none would make the interesting ones harder to spot. */
  if (e.missedInferredPct !== null && e.missedInferredPct !== undefined) {
    box.append(el('div', 'meta',
      `Of the ground marked "inferred, not seen", it missed ${pct(e.missedInferredPct)}.`));
  }

  return box;
}

(async () => {
  let data;
  try {
    const res = await fetch('/api/admin/predictions');
    if (res.status === 404) { $('#none').hidden = false; return; }
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#locked').hidden = false;
    return;
  }

  const entries = data.entries || [];
  if (!entries.length) { $('#none').hidden = false; return; }

  $('#page').hidden = false;
  $('#head').textContent = `"${data.config}" — ${pct(data.medianErrorPct)} on the middle lawn`;
  $('#sub').textContent = `${entries.length} lawns · ${data.features} · drawn `
    + `${new Date(data.drawnAt).toLocaleString()}`;
  $('#caveat').textContent = data.note || '';

  const list = $('#list');
  for (const [i, e] of entries.entries()) list.append(row(e, i));
})();
