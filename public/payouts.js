/**
 * Money somebody has asked for.
 *
 * NOTHING HERE MOVES A CENT. The payment happens in Venmo or PayPal, by hand,
 * in another app. This page is the bookkeeping that would otherwise be done
 * from memory: what was asked for, what it covered, and whether it went out.
 *
 * SAME RULE AS THE OTHER OWNER PAGES: no permission logic here and there must
 * not be. The API answers 404 to anybody who is not an administrator.
 *
 * And the same rule about text. A payout handle is a stranger's string typed
 * into a form, so everything goes in with textContent -- one innerHTML on this
 * page runs it while signed in as the owner.
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

/** A date rather than "3d ago": this is a figure to match against a payment
    history, possibly months later. */
function day(iso) {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

const STATE = {
  requested: { label: 'waiting', cls: 'requested' },
  paid: { label: 'sent', cls: 'paid' },
  returned: { label: 'returned to balance', cls: 'returned' },
};

let payouts = [];

/**
 * One request, open.
 *
 * The destination is the thing that gets copied out of this page and typed
 * into another app, so it is the largest thing on the card after the amount.
 */
function openCard(p) {
  const card = el('div', 'req open');

  const top = el('div', 'top');
  top.append(el('span', 'amount', money(p.cents)));
  top.append(el('span', null, `${n(p.maps)} approved ${p.maps === 1 ? 'map' : 'maps'}`));
  top.append(el('span', null, `asked ${day(p.requestedAt)}`));
  card.append(top);

  const who = el('div');
  who.append(el('span', 'who', p.worker));
  if (p.email) who.append(el('span', 'said', p.email));
  card.append(who);

  const dest = el('div', 'dest');
  dest.append(el('b', null, `${p.kind || 'somewhere'}: `));
  dest.append(document.createTextNode(p.handle || '—'));
  card.append(dest);

  /*
   * THE HANDLE MOVED AFTER THEY ASKED. Paying the snapshot would send the
   * money to an address they have just told us they no longer use, so this is
   * said in full rather than hinted at -- and both are printed, because which
   * one is right is a judgement the owner makes, not this page.
   */
  if (p.changed) {
    const warn = el('div', 'changed');
    warn.append(document.createTextNode(
      'They changed where payments go after asking. It now says '
    ));
    warn.append(el('b', null, `${p.nowKind || ''} ${p.nowHandle || ''}`.trim()));
    warn.append(document.createTextNode('. Send it there.'));
    card.append(warn);
  }

  const ref = el('input', 'refline');
  ref.type = 'text';
  ref.maxLength = 200;
  ref.placeholder = 'Reference, or why it could not be sent';
  card.append(ref);

  const said = el('p', 'said-line');

  const acts = el('div', 'acts');
  const paid = el('button', 'primary', 'Mark sent');
  paid.type = 'button';
  const back = el('button', 'ghost', 'Could not send');
  back.type = 'button';

  const settle = async (state) => {
    const text = ref.value.trim();
    /*
     * A RETURN NEEDS A REASON, because it is the only explanation the person
     * waiting for the money ever gets. "Sent" explains itself; "we did not
     * send it" with nothing after it does not.
     */
    if (state === 'returned' && !text) {
      said.textContent = 'Say why first — they see this, and it is all they see.';
      ref.focus();
      return;
    }

    const asks = state === 'paid'
      ? `Mark ${money(p.cents)} to ${p.handle || 'them'} as sent?`
      : `Put ${money(p.cents)} back into their balance?`;
    if (!window.confirm(asks)) return;

    paid.disabled = true;
    back.disabled = true;
    try {
      const res = await fetch('/api/admin/settle-payout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: p.id,
          state,
          ...(state === 'paid' ? { reference: text } : { note: text }),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        said.textContent = body.reason === 'already-settled'
          ? 'That one was already settled somewhere else. Reloading.'
          : 'That did not save — nothing was changed.';
        if (body.reason === 'already-settled') { await load(); return; }
        paid.disabled = false;
        back.disabled = false;
        return;
      }
      await load();
    } catch {
      said.textContent = 'That did not save — nothing was changed.';
      paid.disabled = false;
      back.disabled = false;
    }
  };

  paid.addEventListener('click', () => settle('paid'));
  back.addEventListener('click', () => settle('returned'));
  acts.append(paid, back);
  card.append(acts, said);
  return card;
}

/** One request, already decided. A record, so it is one line and no buttons. */
function doneCard(p) {
  const card = el('div', 'req');
  const top = el('div', 'top');
  top.append(el('span', 'amount', money(p.cents)));
  const how = STATE[p.state] || { label: p.state, cls: 'requested' };
  top.append(el('span', `tag ${how.cls}`, how.label));
  top.append(el('span', null, day(p.decidedAt || p.requestedAt)));
  card.append(top);

  const who = el('div');
  who.append(el('span', 'who', p.worker));
  who.append(el('span', 'said',
    `${p.kind || ''} ${p.handle || ''}`.trim() || 'no destination'));
  if (p.reference) who.append(el('span', 'said', `ref: ${p.reference}`));
  if (p.note) who.append(el('span', 'said', p.note));
  card.append(who);
  return card;
}

function render() {
  const open = payouts.filter((p) => p.state === 'requested');
  const done = payouts.filter((p) => p.state !== 'requested');

  const box = $('#open');
  box.textContent = '';
  for (const p of open) box.append(openCard(p));
  $('#nothing-open').hidden = open.length > 0;

  const doneBox = $('#done');
  doneBox.textContent = '';
  for (const p of done) doneBox.append(doneCard(p));
  $('#donecard').hidden = done.length === 0;

  const owed = open.reduce((a, p) => a + p.cents, 0);
  const sent = done
    .filter((p) => p.state === 'paid')
    .reduce((a, p) => a + p.cents, 0);
  $('#totals').textContent = open.length
    ? `${money(owed)} to send across ${n(open.length)} `
      + `${open.length === 1 ? 'request' : 'requests'} · ${money(sent)} sent so far`
    : `Nothing waiting · ${money(sent)} sent so far`;
}

async function load() {
  let data;
  try {
    const res = await fetch('/api/admin/payouts');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    $('#page').hidden = true;
    $('#none').hidden = true;
    $('#locked').hidden = false;
    return;
  }

  payouts = data.payouts || [];
  if (!payouts.length) {
    $('#page').hidden = true;
    $('#none').hidden = false;
    return;
  }

  $('#none').hidden = true;
  $('#page').hidden = false;
  render();
}

load();
