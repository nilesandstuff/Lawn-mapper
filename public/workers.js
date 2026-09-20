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
    const name = el('span', 'name', w.worker);
    who.append(name, ' ', el('span', `pill ${w.kind}`, w.kind));
    if (w.trusted) who.append(' ', el('span', 'pill hired', 'trusted'));
    if (w.note) who.append(el('span', 'said', w.note));
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
    row.append(el('td', 'num', ago(w.lastAt)));
    body.append(row);
  }

  const sent = list.reduce((a, w) => a + w.handed, 0);
  const owed = list.reduce((a, w) => a + w.waiting, 0);
  $('#totals').textContent = list.length
    ? `${n(list.length)} ${list.length === 1 ? 'person' : 'people'} · `
      + `${n(sent)} lawns handed out`
      + (owed ? ` · ${n(owed)} maps waiting on you` : ' · nothing waiting on you')
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
  if (!workers.length) {
    $('#page').hidden = true;
    $('#none').hidden = false;
    return;
  }

  $('#none').hidden = true;
  $('#page').hidden = false;
  render();
}

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
