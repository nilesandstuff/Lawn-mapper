/**
 * Who has been tracing, and how it has gone for each of them.
 *
 * ONE ROW PER PERSON, because every question this page exists for is a
 * comparison: who is worth trusting, who is stalled at a gate waiting on the
 * owner, whether the volunteer link is being used, which route is actually
 * producing the corpus. A card per worker would answer none of those without
 * scrolling.
 *
 * SAME RULE AS THE OTHER OWNER PAGES: no permission logic here and there must
 * not be. The API answers 404 to anybody who is not an administrator.
 *
 * And the same rule about text: a worker id comes from a crowd platform, and a
 * note is whatever the owner typed. Everything goes in with textContent -- one
 * innerHTML on this page runs a stranger's string while signed in as the
 * owner.
 */

const $ = (s) => document.querySelector(s);
const n = (v) => Number(v || 0).toLocaleString();

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

let workers = [];
let filter = 'all';
let rates = { rateCents: 75, minPayoutCents: 500 };

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

/** A duration in the words somebody setting a reward would use. */
const asTime = (secs) => {
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

/**
 * How long ago, roughly.
 *
 * Roughly on purpose: the question this column answers is "is this person
 * still around", and a timestamp to the second makes that harder to read at a
 * glance rather than easier.
 */
function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'never';
  const mins = Math.round(ms / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const shown = () => workers.filter((w) => {
  if (filter === 'all') return true;
  /*
   * "Waiting on me" is the one filter that is not about who somebody is. It is
   * the only view with anything urgent in it: a crowd worker held after five
   * maps cannot do a sixth until these are graded, so every row here is
   * somebody stopped rather than somebody idle.
   */
  if (filter === 'waiting') return w.waiting > 0;
  return w.kind === filter;
});

function render() {
  const body = $('#rows');
  body.textContent = '';

  const list = shown();
  for (const w of list) {
    const row = el('tr');
    if (w.trusted) row.className = 'trusted';

    /* Name, what the owner called them, and which route they came in on. */
    const who = el('td');
    const name = el('button', 'namebtn', w.worker);
    name.type = 'button';
    name.addEventListener('click', () => pick(w.worker));
    who.append(name, ' ', el('span', `pill ${w.kind}`, w.kind));
    if (w.trusted) who.append(' ', el('span', 'pill hired', 'trusted'));
    if (w.note) who.append(el('span', 'said', w.note));
    /*
     * WHERE THE MONEY GOES, under the name, because on the paid route settling
     * up is the reason to look somebody up at all. Shown only when there is
     * one: "no destination yet" is a different state from "$0 owed", and a
     * worker who has not told us where to send it is the one case the owner
     * has to do something about.
     */
    if (w.payout) {
      who.append(el('span', 'said', `${w.payout.kind}: ${w.payout.handle}`));
    } else if (w.kind === 'paid') {
      who.append(el('span', 'said nodest', 'no payout destination yet'));
    }
    if (w.email) who.append(el('span', 'said', w.email));
    row.append(who);

    row.append(el('td', 'num', n(w.handed)));

    const waiting = el('td', 'num', w.waiting ? n(w.waiting) : '—');
    if (w.waiting) waiting.classList.add('waiting');
    row.append(waiting);

    row.append(el('td', 'num', n(w.kept)));
    row.append(el('td', 'num', w.excused ? n(w.excused) : '—'));
    row.append(el('td', 'num', w.refused ? n(w.refused) : '—'));

    /*
     * NOTHING REVIEWED IS NOT A PASS RATE OF ZERO. They are opposite facts --
     * "none of their maps passed" and "nobody has looked yet" -- and printing
     * both as 0% would make a page whose entire job is judging people lie
     * about the ones who have just arrived.
     */
    const rate = el('td', 'num');
    if (w.passRate === null) {
      rate.className = 'num rate none';
      rate.textContent = '—';
    } else {
      const pct = Math.round(w.passRate * 100);
      rate.className = `num rate${pct < 80 ? ' low' : ''}`;
      rate.textContent = `${pct}%`;
    }
    row.append(rate);

    row.append(el('td', 'num', asTime(w.medianSeconds)));

    /*
     * OWED, and the minimum said where it is decided rather than in a footnote.
     * Below it nothing is sent, so a row showing $3.00 is not a row to act on
     * and must not read like one.
     */
    const owed = el('td', 'num');
    if (w.owedCents) {
      owed.textContent = money(w.owedCents);
      owed.classList.add(w.owedCents >= rates.minPayoutCents ? 'due' : 'under');
    } else {
      owed.textContent = '—';
    }
    row.append(owed);

    row.append(el('td', 'num', ago(w.lastAt)));
    body.append(row);
  }

  const sent = list.reduce((a, w) => a + w.handed, 0);
  const ungraded = list.reduce((a, w) => a + w.waiting, 0);
  /* Only what is actually payable: below the minimum nothing is sent. */
  const due = list
    .filter((w) => w.owedCents >= rates.minPayoutCents)
    .reduce((a, w) => a + w.owedCents, 0);
  $('#totals').textContent = list.length
    ? `${n(list.length)} ${list.length === 1 ? 'person' : 'people'} · `
      + `${n(sent)} lawns handed out`
      + (ungraded ? ` · ${n(ungraded)} maps waiting on you` : ' · nothing waiting on you')
      + (due ? ` · ${money(due)} due to be paid` : '')
    : 'Nobody on this filter.';
}

async function load() {
  let data;
  try {
    const res = await fetch('/api/admin/workers');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#page').hidden = true;
    $('#locked').hidden = false;
    return;
  }

  workers = data.workers || [];
  rates = {
    rateCents: data.rateCents || 75,
    minPayoutCents: data.minPayoutCents || 500,
  };
  if (!workers.length) {
    $('#page').hidden = true;
    $('#none').hidden = false;
    return;
  }

  $('#none').hidden = true;
  $('#page').hidden = false;
  render();
}

/* ------------------------------------------ what the owner knows about one */
/*
 * TWO SEPARATE FACTS, EDITED TOGETHER AND STORED APART.
 *
 *   the route  where somebody came from, which decides what they see at the
 *              end: a completion code for a platform, a running count for
 *              somebody hired or helping out. It says nothing about quality.
 *
 *   trust      the later, deliberate decision that they have earned their way
 *              past the gates.
 *
 * A hired person is gated exactly like a stranger until trust is granted. The
 * gates are what replaced an audition, so marking somebody "hired" is a
 * statement about their pay arrangement, not a reference.
 */
let picked = null;
let pickKind = 'crowd';
let pickTrusted = false;

function paintPick() {
  const w = workers.find((x) => x.worker === picked);
  if (!w) { $('#picked').hidden = true; return; }

  $('#picked').hidden = false;
  $('#pick-name').textContent = w.worker;
  $('#pick-note').value = w.note || '';

  for (const b of document.querySelectorAll('#pick-kind button')) {
    b.classList.toggle('on', b.dataset.kind === pickKind);
  }
  const trust = $('#pick-trust');
  trust.classList.toggle('on', pickTrusted);
  trust.textContent = pickTrusted
    ? 'Trusted — no gates, no daily cap'
    : 'Gated like a stranger';

  /*
   * Said out loud, because the combination people will reach for -- hired, not
   * yet trusted -- looks like it ought to mean "let them work" and does not.
   */
  $('#pick-said').textContent = pickTrusted
    ? 'They go straight past the five and fifteen map gates and the daily cap.'
    : `They do ${5} maps, then wait for you, then ${10} more, then wait again. `
      + 'Marking somebody hired does not change that — trust does.';
}

function pick(worker) {
  const w = workers.find((x) => x.worker === worker);
  if (!w) return;
  picked = worker;
  pickKind = w.kind || 'crowd';
  pickTrusted = Boolean(w.trusted);
  paintPick();
  $('#picked').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

for (const b of document.querySelectorAll('#pick-kind button')) {
  b.addEventListener('click', () => { pickKind = b.dataset.kind; paintPick(); });
}
$('#pick-trust').addEventListener('click', () => { pickTrusted = !pickTrusted; paintPick(); });
$('#pick-close').addEventListener('click', () => { picked = null; $('#picked').hidden = true; });

$('#pick-save').addEventListener('click', async () => {
  if (!picked) return;
  const save = $('#pick-save');
  save.disabled = true;
  const note = $('#pick-note').value.trim();

  try {
    const res = await fetch('/api/admin/trust-worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        worker: picked,
        trusted: pickTrusted,
        kind: pickKind,
        /* Null rather than '' so the route's COALESCE leaves an existing note
           alone instead of blanking it when the field was never touched. */
        ...(note ? { note } : {}),
      }),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    save.disabled = false;
    $('#pick-said').textContent = 'That did not save — nothing was changed.';
    return;
  }

  const w = workers.find((x) => x.worker === picked);
  if (w) {
    w.kind = pickKind;
    w.trusted = pickTrusted;
    if (note) w.note = note;
  }
  save.disabled = false;
  render();
  paintPick();
});

for (const b of document.querySelectorAll('#routes button')) {
  b.addEventListener('click', () => {
    filter = b.dataset.route;
    for (const o of document.querySelectorAll('#routes button')) {
      o.classList.toggle('on', o === b);
    }
    render();
  });
}

load();
