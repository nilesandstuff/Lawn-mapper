/**
 * The console's client side.
 *
 * EVERYTHING HERE IS A RENDERING OF SOMETHING THE SERVER DECIDED. There is no
 * permission logic in this file and there must not be: the API answers 404 to
 * anybody who is not an administrator, and a page that merely hides its own
 * buttons is not a permission system -- it is a permission system's
 * screenshot. So the whole page is one `if (it loaded)`.
 *
 * Text goes in with textContent, never by building HTML from strings. Almost
 * every value on this page was typed by somebody else: an email address, a
 * name from a provider, a street address, a sentence of feedback. One
 * innerHTML with a name in it and the console is the one page on the site that
 * runs a stranger's script while signed in as the owner.
 */

/*
 * The app's own projection, imported rather than reimplemented. If the review
 * canvas put an outline anywhere but where the map drew it, every judgement
 * made on this page would be about the wrong pixels.
 */
import { lngLatToFramePx } from '/lib/mercator.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

const get = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};

const post = async (path, body) => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || String(res.status));
  return res.json();
};

const n = (v) => Number(v || 0).toLocaleString();

/** "3 days ago" -- a timestamp is not what anybody reading this is asking. */
function ago(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ------------------------------------------------------------- overview */

/**
 * The line under the training-maps tile.
 *
 * THREE STATES, NOT TWO, and conflating any of them wastes somebody's
 * afternoon. An empty corpus and an unreadable one look identical from here --
 * both show no maps -- but one means "nobody has finished a map yet" and the
 * other means "go and fix the database", which are opposite reactions.
 *
 * So the unreadable case carries the database's own words. "no such column:
 * image_key" is a complete diagnosis; "not recording" is a mystery, and it was
 * a mystery for six deploys while the corpus quietly filled up behind it.
 *
 * The bare `!c` is the third state: a server too old to send the field at all.
 */
function corpusNote(c) {
  if (!c) return 'not recording';
  if (c.unavailable) return `cannot read the corpus: ${c.unavailable}`;
  if (!c.total) return 'finished maps, kept for training';
  return `${n(c.withImage)} with a photo · ${n(c.corrected)} corrected`;
}

function renderTiles(o) {
  const tiles = $('#tiles');
  tiles.innerHTML = '';

  /*
   * PASSES, NOT PRESSES, is the headline everywhere on this page.
   *
   * A press costs one Replicate prediction per ticked box, so a day of
   * four-box detections bills four times a day of one-box ones. The presses
   * are shown beside it because "40 passes" from 10 people and from 1 person
   * are different situations.
   */
  const cells = [
    ['AI passes today', o.today?.passes, `${n(o.today?.presses)} presses`],
    ['Last 7 days', o.week?.passes, `${n(o.week?.presses)} presses`],
    ['Last 30 days', o.month?.passes, `${n(o.month?.presses)} presses`],
    ['Accounts', o.users, `${n(o.sessions)} signed in`],
    ['Saved maps', o.maps, ''],
    /*
     * The training corpus: how much there is, and how much of the scarce kind.
     *
     * "Corrected" counts the finished maps where a person disagreed with the
     * detector -- drawn by hand, or moved by more than a tenth. Both kinds are
     * wanted. The accepted ones are most of what a real model would meet and
     * are where its sense of an ordinary lawn comes from; the corrected ones
     * are the only evidence of what the detector gets wrong, and they arrive
     * far more slowly. Two rates, both worth watching, which is why the tile
     * shows the pile and the scarce part of it rather than one number.
     */
    ['Training maps', o.corpus?.total, corpusNote(o.corpus)],
    // Bought credits only. Daily allowances expire nightly whether or not
    // anybody spends them, so counting them here would report the site as
    // owing thirty passes to everyone who ever signed in.
    ['Credits held', o.creditsOutstanding, 'bought, not yet spent'],
  ];

  for (const [label, value, note] of cells) {
    const tile = el('div', 'tile');
    tile.append(el('b', null, n(value)), el('span', null, label));
    if (note) tile.append(el('small', null, note));
    tiles.append(tile);
  }
}

/**
 * One bar per day. No library, no canvas, no second request.
 *
 * The question a chart like this answers is "was yesterday unusual", which is
 * read by comparing heights -- and heights are what a div is good at. Scaled
 * to the busiest day in the window so the shape is visible whether the peak is
 * four passes or four hundred.
 */
function renderDays(daily) {
  const box = $('#days');
  box.innerHTML = '';

  const days = (daily || []).slice().reverse();
  $('#days-empty').hidden = days.length > 0;
  if (!days.length) return;

  const peak = Math.max(...days.map((d) => d.passes), 1);
  for (const d of days) {
    const col = el('div', 'day');
    const bar = el('i');
    bar.style.height = `${Math.round((d.passes / peak) * 74)}px`;
    bar.title = `${d.day}: ${d.passes} passes over ${d.presses} presses`;
    col.append(bar, el('u', null, d.day.slice(8)));
    box.append(col);
  }
}

/* ------------------------------------------------------------- the prices */

/**
 * The daily allowances, editable in place.
 *
 * WHY THIS IS A CARD AND NOT A DOCUMENTED VARIABLE. These are the numbers the
 * owner will actually want to change -- is five a day too mean, is thirty too
 * generous -- and a number that costs a repository settings page and a deploy
 * to change is a number that stays at whatever was guessed first. Each box
 * saves on its own; there is no form to submit, because a form implies the
 * five numbers are one decision and they are not.
 *
 * Each row says whether anybody has changed it. "80" beside a box you just
 * typed 80 into tells you nothing about whether the save landed, which is the
 * only question anybody has after pressing save.
 *
 * SAID IN WORDS THAT MEAN SOMETHING TO THE READER. This label used to read
 * "from the deployment", which is precise, accurate, and was asked about the
 * first time somebody saw it -- it describes where the code looked rather than
 * what the reader did, and the reader is the one standing there. "Not changed
 * yet" is the same fact from their side of it.
 *
 * The distinction is worth showing at all for one reason: a row that has been
 * changed here STOPS following the repository variable, so editing FREE_DAILY
 * in GitHub and deploying will not move it. A row still on its default will.
 */
async function renderSettings() {
  const box = $('#settings');
  const { settings } = await get('/api/admin/settings');

  box.innerHTML = '';
  for (const s of settings) box.append(settingRow(s));
}

function settingRow(s) {
  const row = el('div', 'setting');
  row.append(el('b', null, s.label));

  const field = el('div', 'actions');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.value = String(s.value);
  input.setAttribute('aria-label', s.label);

  const save = el('button', null, 'Save');
  const where = el('small', 'meta',
    s.stored ? 'changed here' : 'not changed yet — using the default');

  const write = async (value) => {
    save.disabled = true;
    try {
      const { settings: after } = await post('/api/admin/settings', { [s.key]: value });
      const fresh = after.find((x) => x.key === s.key) || s;
      row.replaceWith(settingRow(fresh));
    } catch (err) {
      where.textContent = `could not save: ${err.message}`;
    } finally {
      save.disabled = false;
    }
  };

  save.addEventListener('click', () => write(Number(input.value)));
  field.append(input, save);

  /*
   * A way back to the deployment's own number.
   *
   * Only offered once there is something to undo. Without it the only way out
   * of a mistyped value is remembering what was there before it, which is
   * exactly what somebody who has just mistyped a value does not have.
   */
  if (s.stored) {
    const reset = el('button', null, `Back to ${s.fallback}`);
    reset.title = 'Forget the number saved here and follow the deploy settings again.';
    reset.addEventListener('click', () => write(null));
    field.append(reset);
  }

  field.append(where);
  row.append(field);
  row.append(el('div', 'meta', s.help));
  return row;
}

/* ------------------------------------------------------------- reviewing */

/*
 * ONE CANDIDATE AT A TIME, drawn on a plain 2D canvas.
 *
 * Not a map. The feedback page once asked a phone for sixty WebGL maps on a
 * page that can hold about sixteen, and the ones past the limit drew nothing
 * at all, silently. Nothing here needs panning or zooming -- the frame is
 * fixed, the geometry is fixed, and a canvas has no context ceiling.
 *
 * The projection is the app's own, imported rather than reimplemented: if the
 * outline did not land exactly where the app drew it, every judgement made
 * here would be about the wrong pixels.
 */
let queue = 'priority';
let pending = [];
let showAi = false;

const REVIEW_COLOURS = {
  parcel: '#f2c744',   // the property line: the thing never guessed
  lawn: '#4ec26a',     // what was finished, and what is being judged
  ai: '#e2725b',       // what the detector drew, when asked for
};

async function renderReview() {
  const box = $('#review');
  if (!pending.length) {
    box.innerHTML = '';
    box.append(el('p', 'empty', 'Loading…'));
    const data = await get(`/api/admin/candidates?queue=${queue}`);
    if (data.unavailable) {
      box.innerHTML = '';
      box.append(el('p', 'empty', `Cannot read the candidates: ${data.unavailable}`));
      return;
    }
    pending = data.candidates || [];
    if (!pending.length) {
      box.innerHTML = '';
      box.append(el('p', 'empty',
        queue === 'ungraded'
          ? 'Every approved map has a canopy grade. Nothing to catch up on.'
          : data.waiting
            ? 'Nothing in this queue right now.'
            : 'Every finished map has been reviewed. Go and make some more.'));
      return;
    }
  }
  drawCandidate(pending[0]);
}

function drawCandidate(c) {
  const box = $('#review');
  box.innerHTML = '';

  const head = el('div', 'who');
  head.append(el('b', null, c.county || 'somewhere with no county record'));
  head.append(el('span', 'pill', `${n(c.squareFeet)} sq ft`));

  /*
   * How many separate pieces the lawn is. Shown because a map made of eight
   * overlapping pieces looks like a mess on the canvas and there was no way to
   * tell whether that was the data or the drawing of it.
   *
   * Pieces are normal and overlap is harmless: the training target is a filled
   * mask, so two shapes over the same ground paint the same pixels, and the
   * square footage already has overlap taken out of it. This is here to be
   * read, not to be acted on.
   */
  const pieces = (c.shapes || []).length;
  if (pieces > 1) head.append(el('span', 'pill free', `${pieces} pieces`));
  if (c.parcelSource === 'hand') head.append(el('span', 'pill free', 'traced boundary'));

  /*
   * Which imagery did they draw on, and is it the one we kept?
   *
   * Google and Esri can be looked at but not saved, so a map drawn on either
   * gets a Mapbox photo of the same spot saved instead. The outlines are in
   * lng/lat so nothing shifts, but the reviewer is then judging a drawing
   * against a different photo from the one it was drawn on. Those can be years
   * apart. Worth knowing before calling a drawing wrong.
   *
   * Said in full words rather than "esri map · mapbox photo", which was short
   * and needed explaining.
   */
  const NAME = { mapbox: 'Mapbox', google: 'Google', esri: 'Esri', naip: 'NAIP', ndvi: 'NDVI' };
  const name = (id) => NAME[id] || id;

  const shot = c.imageProvider || null;
  if (shot && c.provider && shot !== c.provider) {
    const pill = el('span', 'pill warn', `drawn on ${name(c.provider)}, photo is ${name(shot)}`);
    pill.title = `${name(c.provider)} imagery cannot be saved, so we kept a `
      + `${name(shot)} photo of the same spot. The photos may be from different `
      + 'years, so the drawing may not line up with what you are looking at.';
    head.append(pill);
  } else if (shot) {
    head.append(el('span', 'pill free', `${name(shot)} photo`));
  }

  box.append(head);

  if (c.why?.length) {
    const why = el('div', 'why');
    for (const w of c.why) why.append(el('span', 'pill free', w));
    box.append(why);
  }

  const canvas = el('canvas');
  canvas.width = 640;
  canvas.height = 640;
  box.append(canvas);
  paint(canvas, c);

  const legend = el('div', 'legend');
  for (const [label, colour] of [
    ['property line', REVIEW_COLOURS.parcel],
    ['the lawn', REVIEW_COLOURS.lawn],
    ...(c.detectedShapes && showAi ? [["what the AI drew", REVIEW_COLOURS.ai]] : []),
  ]) {
    const item = el('span');
    const swatch = el('i');
    swatch.style.background = colour;
    item.append(swatch, document.createTextNode(label));
    legend.append(item);
  }
  box.append(legend);

  /*
   * HOW MUCH CANOPY IS OVER THIS LAWN? Asked here because this is the only
   * moment anybody looks at the photograph.
   *
   * It used to be inferred from the exclusion list -- whether the Trees box
   * was ticked during an exclude-mode detection -- which counts a choice about
   * how the AI was run rather than anything about the lawn. That box is off by
   * default and does not exist in Find-grass or hand-drawn mode, so a wooded
   * lot traced by hand scored zero and the counter sat at zero while the
   * corpus filled with the very lawns it was meant to find. The old signal is
   * kept as a STARTING POSITION: ticking Trees is decent evidence of trees,
   * and a prefilled answer is not the answer.
   *
   * THREE LEVELS, NOT A TICK BOX, and the question named above them.
   *
   * Two separate things were wrong with the tick box. It said "No tree line"
   * when it was off, in a plain button identical to "Skip for now" beside it
   * -- so on every candidate that was not an exclude-woods run it read as a
   * label stating a fact rather than a control asking a question, and it went
   * unpressed. Every approved map came back unmarked.
   *
   * And "has a tree line" could not be answered anyway. A row of trees, or any
   * canopy that makes the cover ambiguous? The second is what the hard slice
   * is for -- and on a wooded street it is every lawn, so the answer would
   * have been yes everywhere and the counter would count nothing. The grade is
   * what makes it answerable AND discriminating: only "decided the edge"
   * counts toward the target.
   */
  const CANOPY = [
    [0, 'None', 'The edge of the lawn is plainly visible.'],
    [1, 'Some', 'Canopy overhangs, but you could still see where the lawn stops.'],
    [2, 'Decided the edge', 'You had to judge where the grass stops under the trees.'],
  ];
  let canopy = c.canopyHint ? 2 : null;

  const ask = el('div', 'ask');
  ask.append(el('h3', null, 'Canopy over this lawn'));
  const choices = el('div', 'choices');
  const buttons = CANOPY.map(([value, label, note]) => {
    const b = el('button', null, label);
    b.title = note;
    b.addEventListener('click', () => {
      canopy = value;
      paintCanopy();
    });
    return b;
  });
  const note = el('p', 'meta', '');
  const paintCanopy = () => {
    buttons.forEach((b, i) => { b.className = CANOPY[i][0] === canopy ? 'on' : ''; });
    note.textContent = canopy === null
      ? 'Not answered yet — say which, so the hard slice can be built from it.'
      : CANOPY.find(([v]) => v === canopy)[2];
  };
  choices.append(...buttons);
  ask.append(choices, note);
  box.append(ask);
  paintCanopy();

  /*
   * THE GRADING QUEUE OFFERS NO VERDICT, because the verdict is already in.
   *
   * These rows were approved before the canopy question existed in a form
   * anybody could answer. Showing Approve would re-state a decision that has
   * been made, and Reject would try to change one -- which the API refuses,
   * deliberately: a stale tap must not change somebody's mind for them. So
   * here there is one button, and it does the only thing left to do.
   */
  const grading = queue === 'ungraded';
  const verdict = el('div', 'verdict');
  const approve = el('button', 'approve', grading ? 'Save the grade' : 'Approve');
  const reject = el('button', 'reject', 'Reject');
  const edit = el('button', null, 'Edit');
  verdict.append(approve);
  if (!grading) verdict.append(reject);
  verdict.append(edit);
  box.append(verdict);

  if (grading) {
    box.append(el('p', 'meta',
      'Already approved — this is only the canopy question, which nobody was '
      + 'asked when it went through.'));
  }

  const extras = el('div', 'actions');
  if (c.detectedShapes) {
    /*
     * OFF BY DEFAULT, on purpose. Seeing the detector's answer while judging
     * -- and especially while EDITING -- pulls a correction towards it. Useful
     * for deciding whether a map is interesting, quietly harmful as a default.
     */
    const toggle = el('button', null, showAi ? 'Hide the AI\'s version' : 'Show the AI\'s version');
    toggle.addEventListener('click', () => { showAi = !showAi; drawCandidate(c); });
    extras.append(toggle);
  }
  const skip = el('button', null, 'Skip for now');
  skip.addEventListener('click', () => { pending.shift(); renderReview(); });
  extras.append(skip);
  box.append(extras);

  if (!c.hasImage) {
    box.append(el('p', 'meta',
      'No photograph stored for this one, so the outline is drawn on its own. '
      + 'Still reviewable, but nothing can be trained on it until the picture '
      + 'is fetched.'));
  }

  const send = async (status) => {
    for (const b of [approve, reject, edit]) b.disabled = true;
    try {
      /*
       * Grading an approved row re-affirms its own status: the verdict does
       * not move, only the grade. Its ORIGINAL queue is kept too -- overwriting
       * it with 'ungraded' would lose which draw surfaced it, and that is what
       * tells the export whether the row may sit in the representative slice.
       */
      const res = await post('/api/admin/review', {
        id: c.id,
        status: grading ? 'approved' : status,
        queue: grading ? (c.reviewQueue || 'priority') : queue,
        canopy,
      });
      if (!res.ok) throw new Error(res.reason || 'refused');
      pending.shift();
      await renderReview();
      renderCorpus().catch(() => {});
    } catch (err) {
      for (const b of [approve, reject, edit]) b.disabled = false;
      box.append(el('p', 'meta', `That did not save: ${err.message}`));
    }
  };
  approve.addEventListener('click', () => send('approved'));
  reject.addEventListener('click', () => send('rejected'));

  /*
   * EDITING HAPPENS IN THE MAP APP, not here. The brush, erase, undo and draw
   * tools are seven thousand lines of it; a second copy in the console would
   * drift from the first within a month and the two would disagree about what
   * a lawn is.
   *
   * Finishing over there rewrites the row and resets it to unreviewed, so the
   * corrected version comes back to this queue to be approved on its merits.
   */
  edit.addEventListener('click', () => {
    window.location.href = `/#review=${encodeURIComponent(c.id)}`;
  });
}

function paint(canvas, c) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const overlay = () => {
    if (!c.frame) {
      ctx.fillStyle = '#7a8578';
      ctx.font = '16px system-ui, sans-serif';
      ctx.fillText('No frame stored, so this cannot be drawn to scale.', 18, 30);
      return;
    }
    /*
     * ONE PATH FOR ALL THE RINGS, FILLED EVEN-ODD.
     *
     * A polygon here is an outline plus its holes -- a shed or a pool cut out
     * of the lawn. Filling each ring in its own path painted the hole GREEN on
     * top of the lawn, which is precisely inverted: the reviewer saw the shed
     * marked as grass and was being asked to approve it as a training example.
     * Even-odd is the same rule the measurement and the raster already use, so
     * what is drawn here is what was counted.
     */
    const ring = (geometry, colour, width, fill) => {
      const rings = geometry?.coordinates || [];
      if (!rings.length) return;
      ctx.beginPath();
      for (const coords of rings) {
        coords.forEach(([lng, lat], i) => {
          const [x, y] = lngLatToFramePx(c.frame, [lng, lat], W, H);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    if (c.parcel) ring(c.parcel, REVIEW_COLOURS.parcel, 2.5);

    /*
     * ORDER MATTERS, and it was wrong.
     *
     * The AI outline was drawn first and the lawn painted over it with a
     * translucent green fill, which washed it out. Pressing "show the AI's
     * version" changed almost nothing on screen, so the one way to tell which
     * pieces a person drew and which the detector did was unusable.
     *
     * With the AI shown the lawn drops its fill and the AI goes on top, dashed.
     * Two outlines, both readable, which is the whole point of the comparison.
     */
    const showing = showAi && (c.detectedShapes || []).length;
    for (const g of c.shapes || []) {
      ring(g, REVIEW_COLOURS.lawn, 2.5, showing ? null : 'rgba(78,194,106,.22)');
    }
    if (showing) {
      ctx.setLineDash([6, 4]);
      for (const g of c.detectedShapes) ring(g, REVIEW_COLOURS.ai, 2);
      ctx.setLineDash([]);
    }
  };

  if (!c.hasImage) { overlay(); return; }

  const img = new Image();
  /* Drawn only once the picture is there, so the outline never briefly sits on
     an empty square and reads as a mask over nothing. */
  img.onload = () => { ctx.drawImage(img, 0, 0, W, H); overlay(); };
  img.onerror = () => overlay();
  img.src = `/api/admin/candidate-image?id=${encodeURIComponent(c.id)}`;
}

/* -------------------------------------------------------- training data */

/*
 * WHAT TO GO AND MAP NEXT, which is the only question this panel answers.
 *
 * A total tells somebody nothing about where to spend an afternoon: four
 * hundred maps down one street and four hundred across four states read the
 * same and are worth wildly different amounts. So the ranking is by how far
 * behind each target is, and the server decides it -- the page only draws it.
 */
async function renderCorpus() {
  const box = $('#corpus');
  const data = await get('/api/admin/corpus');
  box.innerHTML = '';

  if (data.unavailable) {
    box.append(el('p', 'empty', `Cannot read the training data: ${data.unavailable}`));
    return;
  }

  const s = data.stats || {};
  if (!s.total) {
    box.append(el('p', 'empty', s.waiting
      ? `${n(s.waiting)} finished map${s.waiting === 1 ? '' : 's'} waiting to be `
        + 'reviewed, and nothing approved yet. Approve some above and the '
        + 'targets below start filling in.'
      : 'No finished maps yet. Measure a lawn and press "finish, save and see '
        + 'more options" — that is the moment one is kept.'));
    return;
  }

  /*
   * SAID BEFORE THE BARS, because the bars measure the approved set and a
   * reader who does not know that will read them as measuring everything.
   */
  if (s.waiting || s.rejected) {
    const queue = [];
    if (s.waiting) queue.push(`${n(s.waiting)} waiting to be reviewed`);
    if (s.rejected) queue.push(`${n(s.rejected)} rejected`);
    box.append(el('p', 'meta',
      `Counting ${n(s.total)} approved. Also ${queue.join(', ')}.`));
  }

  for (const g of data.gaps || []) box.append(gapRow(g));

  /*
   * Facts that are not targets, so they go under the list rather than in it.
   * Each is a thing that would be wrong to chase and useful to notice.
   */
  const notes = [];
  if (s.withImage < s.total) {
    notes.push(`${n(s.total - s.withImage)} of ${n(s.total)} have no photograph `
      + 'stored — the outline is still fine, and the frame can re-fetch it.');
  }
  if (s.handParcel) {
    notes.push(`${n(s.handParcel)} used a hand-traced property line rather than `
      + 'a county record. Still usable, but a traced line is a guess and a '
      + 'county line is a record.');
  }
  if (s.withDetection < s.total) {
    notes.push(`${n(s.total - s.withDetection)} have no saved AI outline to `
      + 'compare against — either drawn by hand, or finished before the app '
      + 'started keeping it.');
  }
  if (notes.length) {
    const box2 = el('div', 'meta');
    for (const t of notes) box2.append(el('p', null, t));
    box.append(box2);
  }

  for (const [title, rows] of [
    ['Counties', data.counties],
    ['Imagery', data.providers],
    ['How it was measured', data.modes],
  ]) {
    if (!rows?.length) continue;
    box.append(el('h3', null, title));
    const list = el('div', 'meta');
    for (const r of rows) {
      list.append(el('p', null,
        `${r.name} — ${n(r.n)}${r.blocks ? ` across ${n(r.blocks)} places` : ''}`));
    }
    box.append(list);
  }
}

function gapRow(g) {
  const row = el('div', 'person');

  const who = el('div', 'who');
  who.append(el('b', null, g.label));
  who.append(el('span', 'pill', g.done ? 'enough' : `${n(g.have)} of ${n(g.need)}`));
  row.append(who);

  /*
   * A bar rather than a number alone, because "48 of 300" and "280 of 300" are
   * the same shape of sentence and a very different amount of work left.
   * Written with a width style rather than <progress>, which cannot be styled
   * consistently across the browsers this gets opened in.
   */
  const track = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  fill.style.width = `${Math.round((g.share || 0) * 100)}%`;
  if (g.done) fill.classList.add('bar-done');
  track.append(fill);
  row.append(track);

  row.append(el('div', 'meta', g.done ? g.why : `${g.why} ${g.what}`));
  return row;
}

/* --------------------------------------------------------------- people */

let searchTimer = null;

async function renderPeople(q = '') {
  const box = $('#people');
  const { users, tier } = await get(`/api/admin/users?q=${encodeURIComponent(q)}`);

  box.innerHTML = '';
  if (!users.length) {
    box.append(el('p', 'empty', q ? 'Nobody matches that.' : 'No accounts yet.'));
    return;
  }

  // Carried onto each row so the "own daily limit" box can show what leaving
  // it blank means, in the number that is actually in force today.
  for (const u of users) box.append(personRow({ ...u, tier }));
}

function personRow(u) {
  const row = el('div', 'person');

  const who = el('div', 'who');
  who.append(el('b', null, u.name || u.email));
  if (u.unlimited) {
    who.append(el('span', 'pill', 'unlimited'));
  } else {
    /*
     * TODAY'S ALLOWANCE IS THE HEADLINE, and the bought balance is a footnote,
     * because that is their relative size in practice: everybody has an
     * allowance and almost nobody has bought anything. It used to read
     * "0 credits" for a perfectly healthy new account, which is the pill
     * saying the account is broken when it is not.
     */
    const d = u.daily || { used: 0, limit: 0 };
    who.append(el('span', 'pill free', `${Math.max(0, d.limit - d.used)}/${d.limit} today`));
    if (u.rawCredits) who.append(el('span', 'pill', `${n(u.rawCredits)} bought`));
  }
  // Somebody decided this account is real, which is also what exempts it from
  // the shared-address ceiling. Worth showing, since it is the one thing here
  // that changes how a detection is counted rather than how much of it is free.
  if (u.dailyLimit !== null && u.dailyLimit !== undefined) who.append(el('span', 'pill', 'vouched'));
  if (u.role === 'admin') who.append(el('span', 'pill', 'admin'));
  row.append(who);

  if (u.name) row.append(el('div', 'meta', u.email));
  row.append(el('div', 'meta',
    `${n(u.passes)} passes · ${n(u.maps)} maps · seen ${ago(u.lastSeenAt) || 'never'}`));

  /*
   * The action anybody actually comes here for is "give this person some
   * credits", so it is a field and two buttons rather than a menu. The amount
   * is typed because the useful numbers are not a list -- 5 to unstick
   * somebody, 100 for a refund, and whatever a pack turns out to be.
   */
  const actions = el('div', 'actions');
  const amount = document.createElement('input');
  amount.type = 'number';
  amount.value = '20';
  amount.setAttribute('aria-label', `Credits to add or remove for ${u.email}`);

  const give = el('button', null, 'Grant');
  give.title = 'Bought credits, which do not expire and are spent after the day\'s allowance.';
  give.addEventListener('click', () => change(u, { grant: Number(amount.value) }, row));

  const take = el('button', null, 'Take');
  take.addEventListener('click', () => change(u, { grant: -Math.abs(Number(amount.value)) }, row));

  const unlimited = el('button', null, u.unlimited ? 'Make limited' : 'Make unlimited');
  unlimited.addEventListener('click', () => change(u, { unlimited: !u.unlimited }, row));

  const admin = el('button', null, u.role === 'admin' ? 'Remove admin' : 'Make admin');
  admin.addEventListener('click', () =>
    change(u, { role: u.role === 'admin' ? 'user' : 'admin' }, row));

  actions.append(amount, give, take, unlimited, admin);
  row.append(actions);

  /*
   * THIS ACCOUNT'S OWN DAILY LIMIT, which is also the answer to "a business
   * cannot use the site because its office shares one IP".
   *
   * Setting it does two things at once, deliberately: it gives the account
   * whatever allowance it needs, and it marks the account as one a person has
   * looked at and decided is real -- which stops it being counted against the
   * shared address at all. Eight people in an office behind one IP are
   * indistinguishable from eight accounts made by one person, and no rule will
   * ever separate them, so a person does it here in four seconds.
   *
   * Blank puts the account back on the free tier and un-vouches it. Both
   * directions have to be reachable or the console can only make exceptions.
   */
  const vouch = el('div', 'actions');
  const limit = document.createElement('input');
  limit.type = 'number';
  limit.min = '0';
  limit.placeholder = `free tier${u.tier ? ` (${u.tier})` : ''}`;
  limit.value = u.dailyLimit === null || u.dailyLimit === undefined ? '' : String(u.dailyLimit);
  limit.setAttribute('aria-label', `Daily AI passes for ${u.email}`);

  const setLimit = el('button', null, 'Set daily limit');
  setLimit.addEventListener('click', () =>
    change(u, { dailyLimit: limit.value.trim() === '' ? null : Number(limit.value) }, row));

  vouch.append(limit, setLimit,
    el('small', 'meta', 'Own allowance; also exempt from the shared-address ceiling.'));
  row.append(vouch);

  /* The history, because "why do I have 12 credits" is the question asked. */
  const history = el('button', null, 'History');
  history.addEventListener('click', async () => {
    history.disabled = true;
    const { entries } = await get(`/api/admin/ledger?user=${encodeURIComponent(u.id)}`);
    const list = el('div');
    for (const e of entries.slice(0, 40)) {
      list.append(el('div', 'meta',
        `${e.at.slice(0, 16).replace('T', ' ')}  ${e.delta >= 0 ? '+' : ''}${e.delta}`
        + `${e.units ? ` (${e.units} passes)` : ''}  ${e.reason}`
        + `${e.detail ? ` — ${e.detail}` : ''}`));
    }
    if (!entries.length) list.append(el('div', 'meta', 'Nothing yet.'));
    row.append(list);
  });
  actions.append(history);

  return row;
}

async function change(user, patch, row) {
  try {
    const { user: after } = await post('/api/admin/user', { id: user.id, ...patch });
    row.replaceWith(personRow({ ...user, ...after }));
    // The tiles carry a credit total, which a grant just moved.
    renderTiles(await get('/api/admin/overview'));
  } catch (err) {
    row.append(el('div', 'meta', `Could not do that: ${err.message}`));
  }
}

/* ------------------------------------------------------------- feedback */

async function renderFeedback() {
  const box = $('#feedback');
  const { entries, enabled } = await get('/api/admin/feedback');

  box.innerHTML = '';
  if (!enabled) {
    box.append(el('p', 'empty',
      'Feedback is switched off. Set the FEEDBACK variable to 1 and deploy.'));
    return;
  }
  if (!entries.length) {
    box.append(el('p', 'empty', 'No reports yet.'));
    return;
  }

  /*
   * Worst first, then newest. A console is read for a minute at a time, and
   * "bad" is the only rating that contains work to do -- sorting by time alone
   * buries it under a week of "great".
   */
  const rank = { bad: 0, close: 1, great: 2 };
  const sorted = entries.slice().sort((a, b) =>
    (rank[a.rating] ?? 3) - (rank[b.rating] ?? 3) || String(b.at).localeCompare(String(a.at)));

  for (const f of sorted.slice(0, 40)) {
    const item = el('div', 'entry');
    const top = el('div', 'top');
    top.append(el('span', `rate ${f.rating}`, f.rating));
    top.append(el('b', null, f.address || '(no address)'));
    item.append(top);
    item.append(el('div', 'meta',
      [f.modelLabel || f.model, f.mode, f.exclude?.join(' + '),
        f.squareFeet ? `${n(f.squareFeet)} sq ft` : null, ago(f.at)]
        .filter(Boolean).join(' · ')));
    if (f.note) item.append(el('p', 'note', f.note));
    box.append(item);
  }

  /*
   * The map viewer already exists and already draws these properly, so the
   * console links to it rather than growing a second copy that will drift.
   */
  const link = el('a', 'link', 'Open the map viewer for these →');
  link.href = '/review.html';
  box.append(link);
}

/* ------------------------------------------------------------------ log */

async function renderLog() {
  const box = $('#log');
  const { entries, logging } = await get('/api/admin/log');

  box.innerHTML = '';
  if (!logging) {
    box.append(el('p', 'empty',
      'The measurement log is switched off. Set LOG_TESTS to 1 and deploy.'));
    return;
  }
  if (!entries.length) {
    box.append(el('p', 'empty', 'Nothing logged yet.'));
    return;
  }

  for (const e of entries.slice(0, 60)) {
    const item = el('div', 'entry');
    const top = el('div', 'top');
    top.append(el('b', null, e.address || '(no address)'));
    /* The outcome is the field worth seeing first: everything else on the row
     * is context for whichever ones did not succeed. */
    top.append(el('span', 'meta', e.outcome || ''));
    item.append(top);
    item.append(el('div', 'meta',
      [e.model, e.prompt, e.passes ? `${e.passes} passes` : null,
        e.provider, e.county, ago(e.at)].filter(Boolean).join(' · ')));
    if (e.detail) item.append(el('div', 'meta', e.detail));
    box.append(item);
  }
}

/* ----------------------------------------------------------------- boot */

(async () => {
  let overview;
  try {
    overview = await get('/api/admin/overview');
  } catch {
    /*
     * 404 is what the API says to everybody who is not an administrator, so
     * this branch covers "not signed in", "signed in as somebody else" and
     * "this deployment has no accounts" alike -- deliberately, because telling
     * them apart would tell a stranger which one they are.
     */
    $('#locked').hidden = false;
    $('#locked-text').textContent =
      'This page is for the site\'s administrators. If that is you, sign in on '
      + 'the map first and come back.';
    return;
  }

  $('#body').hidden = false;
  renderTiles(overview);
  renderDays(overview.daily);

  /* Each section fails on its own. A broken log must not hide the people. */
  renderSettings().catch(() => { $('#settings').textContent = 'Could not load the limits.'; });
  renderReview().catch(() => { $('#review').textContent = 'Could not load the candidates.'; });
  renderCorpus().catch(() => { $('#corpus').textContent = 'Could not load the training data.'; });

  /*
   * Switching queue throws away the loaded page rather than filtering it. The
   * two queues are different DRAWS, not two views of one list -- keeping the
   * priority page and relabelling it "random" would put maps chosen for being
   * interesting into the one slice that must not contain them.
   */
  const QUEUES = [
    ['#queue-priority', 'priority'],
    ['#queue-random', 'random'],
    ['#queue-ungraded', 'ungraded'],
  ];
  for (const [id, which] of QUEUES) {
    $(id).addEventListener('click', () => {
      if (queue === which) return;
      queue = which;
      pending = [];
      for (const [other, name] of QUEUES) $(other).classList.toggle('on', name === which);
      renderReview().catch(() => { $('#review').textContent = 'Could not load the candidates.'; });
    });
  }
  renderPeople().catch(() => { $('#people').textContent = 'Could not load accounts.'; });
  renderFeedback().catch(() => { $('#feedback').textContent = 'Could not load feedback.'; });
  renderLog().catch(() => { $('#log').textContent = 'Could not load the log.'; });

  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    // Settle before asking: a search box that queries per keystroke turns
    // "nilesjac" into eight round trips and shows the answer to "nilesja".
    searchTimer = setTimeout(() => renderPeople(e.target.value.trim()), 250);
  });
})();
