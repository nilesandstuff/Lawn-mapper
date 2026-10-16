/**
 * The dashboard (owner, 2026-10-16): every map, every tool, in order.
 *
 * The rules are docs/MAPS.md. Each map lists the tools from /api/tools, each
 * with its state, worked out here from the dates in /api/maps:
 *
 *   done     the tool has a part for this map, newer than what it needs
 *   stale    something it needs changed after it ran ("needs an update")
 *   ready    everything it needs is done
 *   locked   it needs an earlier tool first
 *
 * Signed out, the visitor is a guest with one map (the server decides, and
 * says so in `max`); signing in keeps it.
 */

const $ = (s) => document.querySelector(s);
const getJson = async (url, opts) => {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw Object.assign(new Error(body.error || String(res.status)), { body, status: res.status });
  return body;
};

/* -------------------------------------------------------------- the state */

/** When a tool's work on a map last changed, or null. 'lawn' is the map's own record. */
function doneAt(map, toolId) {
  if (toolId === 'lawn') return hasLawn(map) ? map.at : null;
  return map.tools?.[toolId]?.updatedAt || null;
}
const hasLawn = (map) => Number(map.squareFeet) > 0;

/** A tool's state on one map. Exported for tools/dashboard.test.js. */
export function toolState(map, tool) {
  if (tool.soon) return 'soon';
  const mine = doneAt(map, tool.id);
  const needsAt = tool.needs.map((n) => doneAt(map, n));
  if (needsAt.some((t) => !t)) return mine ? 'stale' : 'locked';
  if (!mine) return 'ready';
  return needsAt.some((t) => Date.parse(t) > Date.parse(mine)) ? 'stale' : 'done';
}

const LABEL = { done: 'done', stale: 'needs an update', ready: 'ready', locked: 'locked', soon: 'coming soon' };
const ACTION = { done: 'Open', stale: 'Update', ready: 'Start' };

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

/* ------------------------------------------------------------- the page */

let me = null;
let tools = [];
let maps = [];
let max = 1;

function renderWho() {
  const who = $('#who');
  who.innerHTML = '';
  if (me) {
    const span = document.createElement('span');
    span.textContent = me.email;
    const out = document.createElement('button');
    out.className = 'link'; out.type = 'button'; out.textContent = 'Sign out';
    out.onclick = async () => {
      await getJson('/api/auth/signout', { method: 'POST' }).catch(() => {});
      location.reload();
    };
    who.append(span, out);
  } else {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Sign in'; b.dataset.signin = '';
    who.append(b);
  }
}

function toolRow(map, tool) {
  const li = document.createElement('li');
  const state = toolState(map, tool);
  const name = document.createElement('span');
  name.className = 'tname';
  name.textContent = tool.name;
  const chip = document.createElement('span');
  chip.className = `chip ${state}`;
  chip.textContent = LABEL[state];
  name.append(chip);

  let right;
  if (ACTION[state]) {
    right = document.createElement('a');
    right.className = state === 'ready' || state === 'stale' ? 'btn primary' : 'btn';
    right.href = tool.url.replace('{id}', encodeURIComponent(map.id));
    right.textContent = ACTION[state];
  } else {
    right = document.createElement('span');
    right.className = 'why';
    right.textContent = state === 'locked'
      ? `after ${tool.needs.map((n) => tools.find((t) => t.id === n)?.name || n).join(' and ')}`
      : '';
  }
  const blurb = document.createElement('p');
  blurb.className = 'tblurb';
  blurb.textContent = tool.blurb;
  li.append(name, right, blurb);
  return li;
}

function mapCard(map, focus) {
  const card = document.createElement('section');
  card.className = `card${focus ? ' flash' : ''}`;
  card.id = `map-${encodeURIComponent(map.id)}`;
  const top = document.createElement('div');
  top.className = 'card-top';
  const h = document.createElement('h2');
  h.textContent = map.address || 'A saved map';
  const del = document.createElement('button');
  del.className = 'del'; del.type = 'button';
  del.setAttribute('aria-label', `Forget the map of ${map.address || 'this lawn'}`);
  del.textContent = '×';
  del.onclick = async () => {
    if (!confirm(`Forget the map of ${map.address}? Every tool's work on it goes too.`)) return;
    await getJson(`/api/maps?id=${encodeURIComponent(map.id)}`, { method: 'DELETE' }).catch(() => {});
    load();
  };
  top.append(h, del);
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = [
    hasLawn(map) ? `${Math.round(map.squareFeet).toLocaleString()} sq ft of lawn` : 'Lawn not measured yet',
    map.at ? `saved ${ago(map.at)}` : '',
  ].filter(Boolean).join(' · ');
  const ol = document.createElement('ol');
  ol.className = 'tools';
  for (const t of tools) ol.append(toolRow(map, t));
  card.append(top, meta, ol);
  return card;
}

function render() {
  renderWho();
  const focus = new URLSearchParams(location.search).get('map');
  const list = $('#maps');
  list.innerHTML = '';
  $('#empty').hidden = maps.length > 0;
  $('#empty-signin').hidden = Boolean(me);
  $('#actions').hidden = maps.length === 0;
  const full = !me && maps.length >= max;
  $('#guest-note').hidden = !full;
  if (full) {
    $('#guest-note').innerHTML = '';
    $('#guest-note').append('Signed out, you keep one map. ');
    const b = document.createElement('button');
    b.className = 'link'; b.type = 'button'; b.dataset.signin = ''; b.textContent = 'Sign in';
    $('#guest-note').append(b, ' to keep more, on every device. This one comes with you.');
  }
  $('#lead').textContent = maps.length
    ? 'Open a map in any tool. Each one builds on the ones before it, and keeps its work on the map.'
    : (me ? 'No maps on your account yet.' : 'Nothing saved on this browser yet.');
  for (const m of maps) list.append(mapCard(m, m.id === focus));
  const f = focus && document.getElementById(`map-${encodeURIComponent(focus)}`);
  if (f) f.scrollIntoView({ block: 'center' });
}

async function load() {
  try {
    const [who, list, t] = await Promise.all([
      getJson('/api/auth/me'),
      getJson('/api/maps'),
      getJson('/api/tools'),
    ]);
    me = who.user || null;
    maps = list.maps || [];
    max = list.max || 1;
    tools = t.tools || [];
  } catch {
    $('#lead').textContent = 'Your maps could not be loaded just now. Reload the page to try again.';
    return;
  }
  render();
}

/* The page itself: only in a browser, so the states above can be tested in node. */
function boot() {
  /* ------------------------------------------------------------- sign in */

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-signin]')) return;
    $('#signin-msg').textContent = '';
    $('#signin').showModal();
  });
  $('#signin-close').onclick = () => $('#signin').close();
  $('#signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#signin-email').value.trim();
    $('#signin-send').disabled = true;
    try {
      await getJson('/api/auth/email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, next: 'home:/dashboard' }),
      });
      $('#signin-msg').textContent = `A link is on its way to ${email}. Open it on this device.`;
    } catch (err) {
      $('#signin-msg').textContent = err.body?.message || 'The link could not be sent. Check the address and try again.';
    } finally {
      $('#signin-send').disabled = false;
    }
  });

  /* The sign-in link lands here with #signed-in; say so once, then clear it. */
  if (location.hash === '#signed-in') {
    history.replaceState(null, '', location.pathname + location.search);
    $('#lead').textContent = 'Signed in. Loading your maps…';
  }
  load();
}
if (typeof document !== 'undefined') boot();
