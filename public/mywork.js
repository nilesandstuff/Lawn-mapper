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

/*
 * AND THE SAME TRANSLATION FOR A PAYOUT.
 *
 * `returned` is the one that has to be said carefully. It does not mean the
 * request was thrown away -- the money goes straight back into the balance and
 * can be asked for again. Left as the bare word it reads like a rejection, and
 * somebody who thinks they have lost five dollars stops tracing.
 */
const PAYSTATE = {
  requested: { label: 'waiting to be sent', cls: 'requested' },
  paid: { label: 'sent', cls: 'paid' },
  returned: { label: 'back in your balance', cls: 'returned' },
};

/*
 * A PAYOUT GETS A DATE AND A MAP GETS "3d ago", and the difference is on
 * purpose. "Was this one reviewed yet" is a question about recency; "when did
 * I ask for that five dollars" is a question somebody may have to match
 * against a Venmo history months later.
 */
function day(iso) {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let kind = 'venmo';

function paintKinds() {
  for (const b of document.querySelectorAll('#kinds button')) {
    b.classList.toggle('on', b.dataset.kind === kind);
  }
}

/*
 * WHETHER THE BUTTON CAN BE PRESSED, AND WHY NOT IF IT CANNOT.
 *
 * A disabled button with no sentence beside it is the worst version of this
 * screen: somebody with four dollars fifty and no explanation concludes the
 * page is broken, and somebody who never filled in a Venmo username concludes
 * they are being stiffed. Each reason names the thing to do about it.
 */
function paintCashout(data) {
  const button = $('#cashout');
  const said = $('#cashout-said');
  const open = (data.payouts || []).find((p) => p.state === 'requested');

  if (open) {
    button.disabled = true;
    button.textContent = 'Requested';
    said.textContent =
      `${money(open.cents)} asked for on ${day(open.requestedAt)} — waiting to `
      + 'be sent. Anything you earn meanwhile goes onto the next one.';
    return;
  }

  button.textContent = data.canRequest
    ? `Request ${money(data.owedCents)}`
    : 'Request payout';

  if (!data.payout?.handle) {
    button.disabled = true;
    said.textContent = 'Add a Venmo username or a PayPal email below first — '
      + 'otherwise there is nowhere to send it.';
    return;
  }

  if (!data.canRequest) {
    button.disabled = true;
    /*
     * THE MINIMUM IS SAID AS A DISTANCE, NOT AS A RULE. "You need $5" reads as
     * a hurdle; "two more approved maps" is the same fact as something
     * somebody can act on this afternoon.
     */
    const short = Math.max(0, data.minPayoutCents - data.owedCents);
    const more = Math.ceil(short / data.rateCents);
    said.textContent =
      `${more} more approved ${more === 1 ? 'map' : 'maps'} reaches the `
      + `${money(data.minPayoutCents)} minimum payout.`;
    return;
  }

  button.disabled = false;
  said.textContent = 'Paid by hand in Venmo or PayPal, usually within a few days.';
}

function paintPayouts(list) {
  const body = $('#payrows');
  body.textContent = '';
  for (const p of list) {
    const row = el('tr');
    row.append(el('td', null, day(p.requestedAt)));
    row.append(el('td', null, money(p.cents)));
    row.append(el('td', null, p.handle ? `${p.kind || ''} ${p.handle}`.trim() : '—'));

    const how = PAYSTATE[p.state] || { label: p.state, cls: 'requested' };
    const cell = el('td');
    cell.append(el('span', `tag ${how.cls}`, how.label));
    /*
     * The owner's note rides along in the same cell. On a returned request it
     * is the only place the reason for it exists, and on a sent one it is
     * usually the payment reference somebody would want to match up.
     */
    const aside = p.note || p.reference;
    if (aside) {
      cell.append(document.createElement('br'));
      cell.append(el('span', 'sub', aside));
    }
    row.append(cell);
    body.append(row);
  }
  $('#pay-history').hidden = list.length === 0;
}

function render(data) {
  $('#s-approved').textContent = n(data.approved);
  $('#s-waiting').textContent = n(data.waiting);
  $('#s-excused').textContent = n(data.excused);
  $('#s-refused').textContent = n(data.refused);

  /*
   * THE HEADLINE NUMBER IS THE BALANCE, NOT THE LIFETIME TOTAL. They are the
   * same figure until the first payout and then they part company forever, and
   * the one somebody can act on today is what is left to collect. The total
   * earned stays underneath it, because that is the record of the work.
   */
  $('#earned').textContent = money(data.owedCents);
  $('#earned-note').textContent =
    `yours to collect — ${money(data.earnedCents)} earned from `
    + `${n(data.approved)} approved ${data.approved === 1 ? 'map' : 'maps'} in all`;

  paintCashout(data);

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

  paintPayouts(data.payouts || []);

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
    /* Reload rather than patch: saving a destination is what unlocks the
       payout button, and the two would otherwise disagree until a refresh. */
    await load();
  } catch {
    $('#pay-said').textContent = 'That did not save — nothing was changed.';
  }
  save.disabled = false;
});

/*
 * ASKING FOR THE MONEY.
 *
 * The button is only ever enabled when the server would allow it, but it asks
 * anyway and shows whatever comes back: the balance is a live figure and the
 * page in front of somebody may be an hour old. The server's refusals are
 * written to be read by the worker, so they are shown as they arrive rather
 * than replaced with a generic failure.
 */
$('#cashout').addEventListener('click', async () => {
  const button = $('#cashout');
  button.disabled = true;
  try {
    const res = await fetch('/api/auth/payout/request', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      /* Repaint from the server's version of the balance first -- a refusal
         usually means this page was out of date -- then say why. */
      await load();
      $('#cashout-said').textContent = body.reason || 'That did not go through.';
      return;
    }
    await load();
    $('#cashout-said').textContent =
      `${money(body.cents)} requested. You will get it in Venmo or PayPal — `
      + 'this page shows when it has been sent.';
  } catch {
    $('#cashout-said').textContent =
      'That did not go through — nothing was requested. Try again in a moment.';
    button.disabled = false;
  }
});

load();
