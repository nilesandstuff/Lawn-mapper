/**
 * What a paid tracer can see about their own work.
 *
 * THE ONLY PAGE IN THIS PROJECT WRITTEN FOR SOMEBODY OTHER THAN THE OWNER, and
 * that changes what it owes its reader. "Did my map get approved" is otherwise
 * unanswerable from their side, which would leave them taking somebody's word
 * for what they are owed -- not a reasonable thing to ask of a stranger for
 * seventy-five cents a map.
 *
 * Every number is read from the signed-in account. There is no parameter that
 * names a worker, so there is nothing to tamper with and nothing here about
 * anybody else.
 *
 * Text goes in with textContent throughout: a county name comes from a public
 * records office and a payout handle is whatever somebody typed.
 */

const $ = (s) => document.querySelector(s);
const n = (v) => Number(v || 0).toLocaleString();

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

/** How long ago, roughly — the question is "recently?", not "when exactly?". */
function ago(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/*
 * WHAT EACH OUTCOME MEANS, IN THE WORKER'S WORDS RATHER THAN THE DATABASE'S.
 *
 * `kept` and `excused` are the owner's vocabulary and mean nothing to somebody
 * who has never seen the grading page. And the distinction matters to them in
 * a way it does not to anyone else: one of these pays and one does not.
 */
const OUTCOME = {
  submitted: { label: 'waiting on review', cls: 'submitted' },
  kept: { label: 'approved', cls: 'kept' },
  excused: { label: 'hard lawn — no charge to you', cls: 'excused' },
  refused: { label: 'not accepted', cls: 'refused' },
};

let kind = 'venmo';

function paintKinds() {
  for (const b of document.querySelectorAll('#kinds button')) {
    b.classList.toggle('on', b.dataset.kind === kind);
  }
}

function render(data) {
  $('#s-approved').textContent = n(data.approved);
  $('#s-waiting').textContent = n(data.waiting);
  $('#s-excused').textContent = n(data.excused);
  $('#s-refused').textContent = n(data.refused);

  $('#earned').textContent = money(data.earnedCents);

  /*
   * THE MINIMUM IS SAID AS A DISTANCE, NOT AS A RULE. "You need $5" reads as a
   * hurdle; "two more approved maps" is the same fact as something somebody
   * can act on this afternoon.
   */
  const short = Math.max(0, data.minPayoutCents - data.earnedCents);
  const more = Math.ceil(short / data.rateCents);
  $('#earned-note').textContent = short === 0
    ? `over the ${money(data.minPayoutCents)} minimum — due to be paid`
    : `${more} more approved ${more === 1 ? 'map' : 'maps'} reaches the `
      + `${money(data.minPayoutCents)} minimum payout`;

  $('#rate-note').textContent =
    `${data.rateCents}c per APPROVED map. A lawn marked as a hard one is not `
    + 'held against you and does not pay; every map is checked by hand, '
    + 'usually within a day.';

  if (data.payout?.kind) kind = data.payout.kind;
  paintKinds();
  $('#handle').value = data.payout?.handle || '';
  $('#pay-said').textContent = data.payout?.handle
    ? 'Change it any time — maps already sent still count.'
    : 'Not set yet. Maps still count; add this whenever you like.';

  const body = $('#rows');
  body.textContent = '';
  for (const m of data.maps || []) {
    const row = el('tr');
    row.append(el('td', null, m.county || 'somewhere'));
    row.append(el('td', null, ago(m.submittedAt)));
    const how = OUTCOME[m.state] || { label: m.state, cls: 'submitted' };
    const cell = el('td');
    cell.append(el('span', `tag ${how.cls}`, how.label));
    row.append(cell);
    body.append(row);
  }
  $('#none').hidden = (data.maps || []).length > 0;
}

async function load() {
  let data;
  try {
    const res = await fetch('/api/auth/mywork');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#page').hidden = true;
    $('#locked').hidden = false;
    return;
  }
  $('#locked').hidden = true;
  $('#page').hidden = false;
  render(data);
}

for (const b of document.querySelectorAll('#kinds button')) {
  b.addEventListener('click', () => { kind = b.dataset.kind; paintKinds(); });
}

$('#save').addEventListener('click', async () => {
  const handle = $('#handle').value.trim();
  if (!handle) {
    $('#pay-said').textContent = 'Enter a Venmo username or a PayPal email first.';
    return;
  }
  const save = $('#save');
  save.disabled = true;
  try {
    const res = await fetch('/api/auth/payout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, handle }),
    });
    if (!res.ok) throw new Error(String(res.status));
    $('#pay-said').textContent = 'Saved. Maps already sent still count.';
  } catch {
    $('#pay-said').textContent = 'That did not save — nothing was changed.';
  }
  save.disabled = false;
});

load();
