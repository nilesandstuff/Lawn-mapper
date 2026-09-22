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

/*
 * WHICH SET OF PICTURES TO SHOW, from the address bar.
 *
 * `?set=crowns` is the tree crowns; anything else is the detector's own
 * renderings, which is what every existing link points at. The server keeps its
 * own allowlist -- this is a convenience, not the guard.
 */
const QS = new URLSearchParams(location.search);
const SET = QS.get('set') === 'crowns' ? 'crowns' : '';

/*
 * WHICH RUN, from the address bar, so a run is a link somebody can send.
 *
 * Empty means "the newest one there is", which is what an unadorned
 * /predictions.html should show -- the alternative is a bookmark that silently
 * stops tracking the work as soon as one more run happens.
 *
 * Checked here only to keep a malformed one out of a fetch. The server has the
 * real pattern and refuses anything outside it.
 */
const RUN = /^[a-z0-9][a-z0-9-]{0,95}$/.test(QS.get('run') || '') ? QS.get('run') : '';

/**
 * Which of the two pictures is showing, for every lawn at once.
 *
 * The shapes are what the drawing tools would receive; the raw mask is what
 * the model actually answered. The tracer between them smooths every edge,
 * fills any hole under about 60 sq ft and bins the speckle, and the flip is
 * the only way to see WHERE that happened -- the per-lawn numbers say how many
 * square feet it was worth, which is a different and much weaker fact.
 */
let showMask = false;

/* Every picture on the page, so the button can flip all of them together. */
const pictures = [];

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

  /*
   * THE TREE CROWNS ARE A DIFFERENT KIND OF ENTRY and get a different caption.
   *
   * They carry no error figure because they are not a measurement -- they are
   * a question about whether each crown would work as a one-tap toggle. Reusing
   * this page rather than building a second one is right (same frames, same
   * green wash, same lazy loading), and reusing its NUMBERS would not be:
   * "undefined% out" over a picture of trees is worse than no pill at all.
   */
  if (e.crowns !== undefined) {
    top.append(el('span', 'pill', `${n(e.crowns)} crowns`));
    top.append(el('span', e.thumbable ? 'pill' : 'pill grey',
      `${n(e.thumbable)} big enough to tap`));
    if (e.onLawnPct !== null && e.onLawnPct !== undefined) {
      top.append(el('span', 'pill warn', `${pct(e.onLawnPct)} on the traced lawn`));
    }
    /*
     * AND HOW MUCH IS ON THE PROPERTY AT ALL, which is the pill that makes the
     * one before it readable.
     *
     * "4% on the traced lawn" has two completely different meanings and the
     * first pill cannot tell them apart: the tracer looked at these trees and
     * decided there is no grass under them -- a toggle correctly starting OFF,
     * which is the idea working -- or the crowns belong to next door and were
     * never a candidate either way. This one separates them. A lawn reading 4%
     * on the lawn and 90% inside the line is a judgement; 4% and 10% is a
     * neighbour's tree.
     */
    if (e.insidePct !== null && e.insidePct !== undefined) {
      top.append(el('span', e.insidePct >= 50 ? 'pill' : 'pill grey',
        `${pct(e.insidePct)} inside the line`));
    }
    box.append(top);
    box.append(el('div', 'meta',
      `${n(e.crownSqFt)} sq ft of crown · ${n(e.canopySqFt)} sq ft of canopy found · `
      + `${Math.round(e.mpp * 100)} cm a pixel in the frame`
      + (e.readAtPx ? ` · read at ${n(e.readAtPx)} px` : '')));
    box.append(el('div', 'meta cost',
      'A crown inside the green is a tree somebody decided has grass under it — '
      + 'a toggle that should start ON. One outside the green but inside the '
      + 'property line is a no. One outside the line is not theirs to answer.'));
    return withPicture(box, e, i,
      `Lawn ${i + 1}: every tree crown found, over the photograph, with the `
      + 'hand-traced lawn washed in green');
  }

  top.append(el('span', 'pill warn', `${pct(e.errorPct)} out`));
  if (e.samErrorPct !== null && e.samErrorPct !== undefined) {
    /* SAM beside it, because "28% wrong" only means something against the
       thing we currently pay for on the same lawn. */
    top.append(el('span', `pill ${e.errorPct < e.samErrorPct ? '' : 'grey'}`,
      `SAM ${pct(e.samErrorPct)}`));
  }
  if (e.inferredPct >= 1) top.append(el('span', 'pill', `${pct(e.inferredPct)} inferred`));
  box.append(top);

  /*
   * "the outline" is load-bearing wording. These are measured on the traced
   * polygon, not on the mask behind it, because that is what the picture shows
   * -- see traceMask() for the caption bug that made the distinction matter.
   */
  box.append(el('div', 'meta',
    `${n(e.squareFeet)} sq ft of lawn · ${Math.round(e.mpp * 100)} cm a pixel · `
    + `the outline found ${pct(e.foundPct)} of it · over-called ${pct(e.overPct)}`));

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

    /*
     * WHAT TIDYING THE OUTLINE WAS WORTH, both ways.
     *
     * The tracer fills any hole under about 60 sq ft and smooths every edge,
     * which is wanted -- a shape full of pinholes is not an editing surface --
     * and it also makes the picture tidier than the model's actual answer.
     * Saying by how much is the difference between a helpful rendering and a
     * flattering one.
     */
    if (e.filledSqFt || e.trimmedSqFt) {
      box.append(el('div', 'meta cost',
        `tracing it filled ${n(e.filledSqFt)} sq ft of holes `
        + `and shaved ${n(e.trimmedSqFt)} sq ft off the edges`));
    }
  }

  /*
   * The picture loads only when it is scrolled to. Twenty-three of these is
   * about five megabytes, and on a phone that is the difference between a
   * page and a wait.
   */
  return withPicture(box, e, i,
    `Lawn ${i + 1}: the outline the detector drew, over the photograph, `
    + 'with the hand-traced lawn washed in green');
}

/**
 * The picture, loaded only when it is scrolled to.
 *
 * Twenty-three of these is about five megabytes, and on a phone that is the
 * difference between a page and a wait. Shared by both kinds of entry so the
 * lazy loading and the failure message cannot drift apart between them.
 */
function withPicture(box, e, i, alt) {
  const img = el('img', 'shot pred');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = alt;

  /*
   * THE TWO PICTURES OF THE SAME LAWN, swapped in place.
   *
   * Swapping `src` rather than holding both in the DOM: these are a quarter of
   * a megabyte each and a page of thirty lawns would be fifteen megabytes to
   * load two of everything, most of it never looked at. The run folders are
   * immutable and served with a day's cache, so the second flip is instant
   * anyway and the first is the only one that costs anything.
   *
   * A run from before the mask was drawn has no second picture. Those entries
   * stay on the shapes rather than breaking, and the button says why.
   */
  const shown = () => (showMask && e.maskKey ? e.maskKey : e.key);
  const paint = () => {
    img.src = `/api/admin/prediction-image?key=${encodeURIComponent(shown())}`;
    img.alt = showMask && e.maskKey
      ? `Lawn ${i + 1}: every pixel the model called lawn, before tracing, `
        + 'over the photograph with the hand-traced lawn washed in green'
      : alt;
  };
  paint();
  pictures.push(paint);

  img.addEventListener('error', () => {
    img.replaceWith(el('p', 'empty', 'That picture could not be loaded.'));
  });
  box.append(img);

  /* Only where there is marked ground to say anything about. Printing "—" on
     the maps with none would make the interesting ones harder to spot. */
  if (e.missedInferredPct !== null && e.missedInferredPct !== undefined) {
    box.append(el('div', 'meta',
      `Of the ground marked "inferred, not seen", the outline misses `
      + `${pct(e.missedInferredPct)}.`));
  }

  return box;
}

/**
 * The run list, for the picker.
 *
 * NEVER FATAL. A missing or empty list means nothing has been drawn since runs
 * got folders of their own, and there are renderings in the old flat place
 * that should still open. Losing the picker is a smaller loss than losing the
 * page.
 */
async function loadRuns() {
  try {
    const res = await fetch('/api/admin/prediction-runs');
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.runs) ? body.runs : [];
  } catch {
    return [];
  }
}

/** A run's own line in the picker: when it ran, what it was, how it scored. */
function runLabel(r) {
  const when = r.at ? new Date(r.at).toLocaleString() : r.slug;
  const score = Number.isFinite(r.headline) ? ` · ${r.headline.toFixed(1)}%` : '';
  return `${when} · ${r.title || r.slug}${score}`;
}

function fillPicker(runs, current) {
  const sel = $('#run');
  if (!runs.length) {
    /* One option saying so, rather than an empty box that reads as broken. */
    sel.append(el('option', null, 'the latest drawing'));
    sel.disabled = true;
    return;
  }
  for (const r of runs) {
    const o = el('option', null, runLabel(r));
    o.value = r.slug;
    if (r.slug === current) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    /* A whole page load rather than a re-render. Every picture, every number
       and the caveat all belong to the run, and swapping them piecemeal is how
       a page ends up showing one run's outlines under another's error figure. */
    const next = new URLSearchParams(location.search);
    next.set('run', sel.value);
    next.delete('set');
    location.search = next.toString();
  });
}

/**
 * The settings the run was given, as one line.
 *
 * Free-form on purpose -- the training runs and the tree crowns have almost
 * nothing in common -- so this prints whatever it is handed rather than
 * knowing the names. A key it has never seen is the case that matters: this
 * page should not need editing before a new knob can be recorded.
 */
function settingsLine(settings) {
  const pretty = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return Object.entries(settings || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => `${pretty(k)}: ${v === true ? 'yes' : v}`)
    .join(' · ');
}

(async () => {
  const runs = await loadRuns();
  /* No run named in the address bar means the newest one, so a bare link keeps
     tracking the work instead of freezing on whatever was current the day it
     was bookmarked. */
  const want = RUN || (!SET && runs.length ? runs[0].slug : '');

  let data;
  try {
    const q = want ? `?run=${encodeURIComponent(want)}` : (SET ? `?set=${SET}` : '');
    const res = await fetch(`/api/admin/predictions${q}`);
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
  fillPicker(runs, want);

  if (data.about) {
    $('#about').hidden = false;
    $('#about').textContent = `What this run was testing: ${data.about}`;
  }
  const line = settingsLine(data.settings);
  if (line) {
    $('#settings').hidden = false;
    $('#settings').textContent = line;
  }

  /*
   * THE FLIP. Off unless this run drew both pictures -- and it says which,
   * because a button that simply does nothing reads as a broken button rather
   * than as a run that predates the second rendering.
   */
  const flip = $('#flip');
  const hasMasks = entries.some((e) => e.maskKey);
  if (!hasMasks) {
    flip.disabled = true;
    flip.textContent = 'No raw mask in this run';
  } else {
    flip.addEventListener('click', () => {
      showMask = !showMask;
      flip.setAttribute('aria-pressed', String(showMask));
      flip.textContent = showMask ? 'Show the shapes' : 'Show the raw mask';
      for (const paint of pictures) paint();
    });
  }
  /*
   * THE HEADING IS ABOUT WHATEVER SET IS OPEN. The detector's renderings carry
   * an error figure and the tree crowns do not -- they are not a measurement,
   * they are a question about whether something would work as a tap target --
   * so printing "undefined% on the middle lawn" over them would be inventing a
   * number the run never produced.
   */
  $('#head').textContent = Number.isFinite(data.medianErrorPct)
    ? `"${data.config}" — ${pct(data.medianErrorPct)} on the middle lawn`
    : `"${data.config}" — ${entries.length} lawns`;
  $('#sub').textContent = `${entries.length} lawns · ${data.features} · drawn `
    + `${new Date(data.drawnAt).toLocaleString()}`;
  $('#caveat').textContent = data.note || '';

  const list = $('#list');
  for (const [i, e] of entries.entries()) list.append(row(e, i));
})();
