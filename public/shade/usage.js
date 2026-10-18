/**
 * The shade map's usage and errors, sent to the site (worker/src/
 * shade-usage.js; owner, 2026-10-14). What is sent: the kind of thing that
 * happened ('open', 'search', 'built', ...), a few words about it, and a
 * random id for this browser -- never an address or a coordinate. An ERROR
 * also carries the place being looked at (setPlace), because a failure
 * cannot be reproduced without it (owner, 2026-10-14); the server keeps it
 * admin-only and forgets it after 90 days. The
 * server drops admins, the owner's own devices and anything automated;
 * this side only says when the device is the owner's (marked on the shade
 * admin page) and never lets a failure here touch the page.
 */

const CLIENT_KEY = 'lawnmapper.shade.client', SELF_KEY = 'lawnmapper.shade.self';
const store = () => { try { return window.localStorage; } catch { return null; } };

function clientId() {
  const s = store();
  try {
    let id = s?.getItem(CLIENT_KEY);
    if (!id) { id = crypto.randomUUID(); s?.setItem(CLIENT_KEY, id); }
    return id;
  } catch { return null; }
}

/** Is this device marked as the owner's (it then sends nothing)? */
export function isOwnDevice() { try { return store()?.getItem(SELF_KEY) === '1'; } catch { return false; } }
export function setOwnDevice(on) { try { if (on) store()?.setItem(SELF_KEY, '1'); else store()?.removeItem(SELF_KEY); } catch { /* not kept */ } }

const page = () => {
  const p = location.pathname;
  return /shade-log|^\/log\b/.test(p) ? 'shade-log' : /shade-admin|^\/admin\b/.test(p) ? 'shade-admin' : /shade-trees|^\/trees\b/.test(p) ? 'shade-trees' : 'shade';
};

function send(path, body) {
  if (isOwnDevice()) return;
  try {
    const data = JSON.stringify({ ...body, page: page(), client: clientId() });
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  } catch { /* never the page's problem */ }
}

/** Something a visitor did or got: kind ('open', 'built', ...), a few words. */
export function track(kind, detail = null) { send('/api/shade/event', { kind, detail: detail == null ? null : String(detail).slice(0, 120) }); }

let here = null;
/** The place on screen, sent with any error from now on: { place, lng, lat }, or null. */
export function setPlace(p) {
  here = p && Number.isFinite(p.lng) && Number.isFinite(p.lat)
    ? { place: p.place ? String(p.place).slice(0, 160) : null, lng: Math.round(p.lng * 1e5) / 1e5, lat: Math.round(p.lat * 1e5) / 1e5 }
    : null;
}

let reported = 0;
/** Something that went wrong for the visitor (at most 20 a page load), with the place on screen. */
export function reportError(where, message) {
  if (++reported > 20) return;
  send('/api/shade/error', { where: String(where || '').slice(0, 120), message: String(message || 'unknown').slice(0, 300), ...(here || {}) });
}

/** Uncaught errors and rejected promises on the page, reported once each. */
export function watchErrors() {
  const seen = new Set();
  const once = (where, msg) => { const k = `${where}|${msg}`; if (seen.has(k)) return; seen.add(k); reportError(where, msg); };
  window.addEventListener('error', (e) => once(e.filename ? `${String(e.filename).split('/').pop()}:${e.lineno}` : 'page', e.message));
  window.addEventListener('unhandledrejection', (e) => once('promise', e.reason?.message || String(e.reason)));
}
