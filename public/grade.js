/**
 * Grading the maps that were paid for.
 *
 * ONE CARD AT A TIME, LIKE SCREENING, and for the same reason: this is a queue
 * to be emptied on a phone, and a scrolling list of maps is a list nobody
 * reaches the bottom of. The difference is that a screening mistake costs one
 * lawn out of a county with thousands, and a mistake here costs either a bad
 * map in the training set or a good worker stopped for nothing -- so the
 * verdict is sent BEFORE moving on, and a failure puts the card back.
 *
 * THE DRAWING IS BORROWED, not rewritten. lib/review-draw.js is what the
 * console and the every-map page already use, and a second copy of it here
 * would eventually put an outline somewhere the other pages do not -- which
 * would make every judgement on this page a judgement about the wrong pixels.
 *
 * SAME RULE AS THE OTHER OWNER PAGES: no permission logic here and there must
 * not be. The API answers 404 to anybody who is not an administrator. And
 * everything goes in with textContent -- a worker id comes from a crowd
 * platform, and one innerHTML here runs a stranger's string as the owner.
 */

import { paint } from './lib/review-draw.js';

const $ = (s) => document.querySelector(s);
const n = (v) => Number(v || 0).toLocaleString();

let queue = [];
let at = 0;
let done = 0;
let median = '';
const counts = {};

/**
 * A duration, in the words somebody setting a reward would use.
 *
 * Minutes and seconds rather than a raw count, because the number is read
 * against "how much is five minutes of somebody's time worth" and 412 does
 * not answer that question without arithmetic.
 */
const asTime = (secs) => {
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

/** How a worker has been doing so far, in the fewest words that are true. */
function standing(tally) {
  if (!tally) return '';
  const { kept = 0, excused = 0, refused = 0 } = tally;
  const reviewed = kept + excused + refused;
  if (!reviewed) return 'nothing of theirs has been graded yet';
  const passed = kept + excused;
  return `${n(passed)} of ${n(reviewed)} passed so far`
    + (excused ? ` (${n(excused)} excused)` : '');
}

function show() {
  if (at >= queue.length) { load(); return; }
  const job = queue[at];

  /* The picture wants the CORPUS id, because that is what the banked image and
     the stored outline belong to. The job id is only the queue's own name for
     this lawn. */
  paint($('#shot'), { ...job, id: job.mapId });

  $('#where').textContent = [
    job.county || 'somewhere with parcels',
    job.squareFeet ? `${n(job.squareFeet)} sq ft of lawn` : 'no area recorded',
    job.parcelSqFt ? `in a ${n(job.parcelSqFt)} sq ft plot` : null,
  ].filter(Boolean).join(' · ');

  const who = $('#who');
  who.textContent = '';
  const name = document.createElement('b');
  name.textContent = job.worker || 'an unnamed worker';
  /*
   * And how long THIS one took, beside how they have been doing. It is the
   * nearest thing to context for a map that looks rushed -- though it settles
   * nothing on its own, which is why it sits next to the tally rather than
   * anywhere near the buttons: a careless map made slowly still passes here,
   * and that judgement is the point of this page.
   */
  who.append(name, ` · ${standing(job.tally)}`,
    job.seconds ? ` · took ${asTime(job.seconds)}` : '');
  if (job.tally?.note) who.append(` · ${job.tally.note}`);

  /*
   * THE TRUST SWITCH, showing the state it is actually in rather than always
   * offering to grant. Somebody already trusted needs the way back more than
   * they need the offer again -- and a control that says "trust" beside a
   * worker who is already trusted is a control that has been pressed twice by
   * somebody checking whether it worked.
   */
  const trust = $('#trust');
  trust.hidden = !job.worker;
  trust.disabled = false;
  trust.classList.toggle('on', Boolean(job.tally?.trusted));
  trust.textContent = job.tally?.trusted
    ? 'Trusted — no gates, no daily cap. Undo?'
    : 'Trust this worker (lifts the gates and the daily cap)';

  /*
   * THE FLAG, WHEN THERE IS ONE. A submission that went through as "I checked
   * it and the automatic outline was already right" is the single case where
   * the machine has a suspicion it cannot act on, so it is said out loud
   * rather than left to be noticed.
   */
  const flag = $('#flag');
  flag.hidden = job.flag !== 'unchanged';
  flag.textContent = job.flag === 'unchanged'
    ? 'They sent this without changing the automatic outline, and confirmed '
      + 'that it was already right. Sometimes it is.'
    : '';

  const left = queue.length - at;
  $('#count').textContent = [
    done ? `${n(done)} graded just now` : null,
    `${n(left)} loaded · ${n(counts.submitted || 0)} waiting`,
    /*
     * WHAT A MAP ACTUALLY COSTS IN TIME, on the screen the owner is already
     * looking at. The reward has to be defensible -- the platforms judge
     * underpayment on the median observed time rather than on the estimate in
     * the listing -- and there is no other moment when somebody is thinking
     * about this queue with a phone in their hand.
     */
    median ? `typically ${median}` : null,
  ].filter(Boolean).join(' · ');

  /*
   * TIDYING HAPPENS IN THE MAP APP, not here -- the same rule the console
   * follows. The brush and the erase tools are thousands of lines of it, and a
   * second copy would drift from the first within a month.
   *
   * Finishing over there rewrites the corpus row and resets it to unreviewed,
   * so the sensible order is: tidy, come back, keep. The worker is still
   * judged on what they sent, which is the shape on this card.
   */
  const tidy = $('#tidy');
  tidy.textContent = '';
  if (job.mapId) {
    const link = document.createElement('a');
    link.href = `/#review=${encodeURIComponent(job.mapId)}`;
    link.textContent = 'Open it in the app to tidy it →';
    tidy.append(link);
  }

  for (const b of ['#keep', '#excuse', '#refuse']) $(b).disabled = false;
}

async function verdict(kind) {
  const job = queue[at];
  if (!job) return;
  for (const b of ['#keep', '#excuse', '#refuse']) $(b).disabled = true;

  /*
   * SENT BEFORE MOVING ON, unlike screening.
   *
   * The screening page moves first and reports a failure afterwards, because a
   * lost screening verdict costs one candidate out of thousands. A lost
   * verdict HERE leaves a worker sitting at a gate waiting on a review that
   * was never recorded -- they cannot see it, cannot ask about it, and the
   * queue on this page would not show it again. So the round trip is waited
   * for, and a failure puts the same card back rather than losing it.
   */
  try {
    const res = await fetch('/api/admin/review-lawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: job.id, verdict: kind }),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    $('#count').textContent = 'That verdict did not save. Nothing was recorded '
      + '— try it again.';
    for (const b of ['#keep', '#excuse', '#refuse']) $(b).disabled = false;
    return;
  }

  /*
   * The worker's own tally moves too, so the next card of theirs in this batch
   * shows what was just decided rather than the state the page loaded with.
   * The server agrees; this only saves a reload.
   */
  if (job.tally) {
    job.tally[kind] = (job.tally[kind] || 0) + 1;
    job.tally.pending = Math.max(0, (job.tally.pending || 0) - 1);
  }

  at++;
  done++;
  if (counts.submitted) counts.submitted--;
  show();
}

async function load() {
  let data;
  try {
    const res = await fetch('/api/admin/lawn-reviews?limit=12');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#page').hidden = true;
    $('#locked').hidden = false;
    return;
  }

  Object.assign(counts, data.counts || {});
  queue = data.jobs || [];
  at = 0;
  median = data.timed ? `${asTime(data.medianSeconds)} a map over ${n(data.timed)}` : '';

  if (!queue.length) {
    $('#page').hidden = true;
    $('#none').hidden = false;
    const parts = Object.entries(counts)
      .map(([state, many]) => `${n(many)} ${state}`)
      .join(' · ');
    $('#none-counts').textContent = parts ? `So far: ${parts}.` : '';
    return;
  }

  $('#none').hidden = true;
  $('#page').hidden = false;
  show();
}

/*
 * Trusting somebody, or taking it back.
 *
 * Sent and waited for, like a verdict and unlike a screening decision: the
 * consequence is somebody being let off the gates, and silently failing to
 * record that leaves a hired worker stuck at a five-map wall wondering why
 * nothing happened. The card stays where it is either way -- this is not a
 * judgement on the map in front of it, and moving on would imply it was.
 */
$('#trust').addEventListener('click', async () => {
  const job = queue[at];
  if (!job?.worker) return;
  const next = !job.tally?.trusted;
  const trust = $('#trust');
  trust.disabled = true;

  try {
    const res = await fetch('/api/admin/trust-worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker: job.worker, trusted: next }),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    trust.disabled = false;
    $('#count').textContent = 'That did not save — nothing was changed.';
    return;
  }

  /*
   * Every card of theirs in this batch, not just this one. The owner will very
   * often be looking at a run of maps from the same person, and a switch that
   * reverted on the next card reads as not having worked.
   */
  for (const row of queue) {
    if (row.worker === job.worker && row.tally) row.tally.trusted = next;
  }
  show();
});

$('#keep').addEventListener('click', () => verdict('kept'));
$('#excuse').addEventListener('click', () => verdict('excused'));
$('#refuse').addEventListener('click', () => verdict('refused'));

/*
 * A keyboard for the session that happens at a desk. K, E and R rather than
 * Y and N, because there are three answers here and two of them are a no --
 * arrow keys would have to pick which no is the natural one, and there is no
 * natural one.
 */
document.addEventListener('keydown', (e) => {
  if ($('#page').hidden) return;
  if (e.key === 'k' || e.key === 'K') verdict('kept');
  if (e.key === 'e' || e.key === 'E') verdict('excused');
  if (e.key === 'r' || e.key === 'R') verdict('refused');
});

load();
