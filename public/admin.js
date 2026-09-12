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
    ['Credits held', o.creditsOutstanding, 'owed to accounts'],
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

/* --------------------------------------------------------------- people */

let searchTimer = null;

async function renderPeople(q = '') {
  const box = $('#people');
  const { users } = await get(`/api/admin/users?q=${encodeURIComponent(q)}`);

  box.innerHTML = '';
  if (!users.length) {
    box.append(el('p', 'empty', q ? 'Nobody matches that.' : 'No accounts yet.'));
    return;
  }

  for (const u of users) box.append(personRow(u));
}

function personRow(u) {
  const row = el('div', 'person');

  const who = el('div', 'who');
  who.append(el('b', null, u.name || u.email));
  if (u.unlimited) who.append(el('span', 'pill', 'unlimited'));
  else who.append(el('span', 'pill free', `${n(u.rawCredits)} credits`));
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
