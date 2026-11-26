/**
 * THE OUTBOX (core session, 2026-11-07; the owner: "Does it save to the phone and upload in the background or do I
 * need to keep the app open? If I were to immediately exit the app, or if my internet connection cut, would the
 * upload wait or would the photos and data be permanently lost? Can you show something in the app that indicates the
 * upload status?").
 *
 * Until then a walk's parts (points, track, pictures, live.json) went up from memory, each tried twice and then
 * dropped, so closing the app or losing signal lost whatever had not gone yet. Now every part is written to the
 * phone first (IndexedDB) and leaves it only when the site says it has it. A part that fails waits and is tried again
 * (5 s, doubling to a minute), and parts left by a walk that was closed early go up the next time the page opens, in
 * the app or in the same browser. A part the site refuses outright (a 4xx other than 408/429) is set aside, counted,
 * not retried. A part written again under the same name (live.json, meta.json) replaces the waiting one.
 *
 * The store is injected: idbStore() on the phone, memoryStore() in the tests and where IndexedDB is missing.
 */

export const RETRY_MS = 5000;
export const RETRY_MAX_MS = 60000;

export const sizeOf = (b) => (b == null ? 0 : b.size ?? b.byteLength ?? (typeof b === 'string' ? b.length : 0));

/** A store in memory: { put, del, all } over plain objects. */
export function memoryStore() {
  const m = new Map();
  return {
    kind: 'memory',
    put: async (x) => { m.set(x.id, x); },
    get: async (id) => m.get(id) ?? null,
    del: async (id) => { m.delete(id); },
    all: async () => [...m.values()].sort((a, b) => a.at - b.at),
  };
}

/** A store in the page's IndexedDB (kept on the phone across closes), or null where there is none. */
export async function idbStore(name = 'yard-ar', table = 'outbox') {
  if (typeof indexedDB === 'undefined') return null;
  const db = await new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(name, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(table)) req.result.createObjectStore(table, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  if (!db) return null;
  const tx = (mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction(table, mode), s = t.objectStore(table);
    const r = fn(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return {
    kind: 'phone',
    put: (x) => tx('readwrite', (s) => s.put(x)),
    get: async (id) => (await tx('readonly', (s) => s.get(id))) ?? null,
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    all: async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => a.at - b.at),
  };
}

/**
 * The outbox. send(part) -> 'ok' | 'retry' | 'drop' | 'off' ('off': the site cannot take parts at all, e.g. no
 * bucket; everything stays on the phone). onChange(status) on every change.
 */
export const PARALLEL = 4;
export function newOutbox({ store, send, onChange = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), parallel = PARALLEL }) {
  const st = { pending: 0, bytes: 0, walks: 0, sending: false, waitingMs: 0, sent: 0, sentBytes: 0, dropped: 0, lastDrop: null, off: null, lastError: null, store: store.kind };
  let running = false, kickAgain = false, seq = 0, held = false;
  /* (2026-11-07, the owner's first outdoor walk in the app: its pins and its Street View trail never reached the
     bucket) a part written again while its older copy waited in this round's list, or was on its way, must not be
     deleted when the older copy lands: live.json is rewritten every few seconds and at the walk's end, and the end's
     copy, the one with everything, was deleted as "sent". Only the copy that went is taken off the phone. */
  /* THE LIST IN MEMORY (2026-11-26; the owner, after a walk whose stutters "seemed to have gotten worse as the walk
     progressed": "the upload file isn't being stored in RAM right?"). It was not: the parts wait on the phone's disk.
     But every part kept and every part sent read the WHOLE waiting list back off the disk to count it, and every
     round read every waiting part's body at once, so the work per part grew with the backlog -- on the 2:10 pm walk
     of 26 Nov about 1,400 parts, sending the whole walk long. Now the list (id, time, size, walk) is read off the
     disk once, kept here, and a body is read only when its part goes. */
  let index = null;
  const load = async () => {
    if (index) return index;
    const m = new Map();
    try { for (const x of await store.all()) m.set(x.id, { id: x.id, at: x.at, size: sizeOf(x.body), walk: x.walk }); } catch { /* an empty list; the next look tries again */ return m; }
    return (index = index || m);
  };
  const settle = async (item) => {
    const cur = store.get ? await store.get(item.id) : item;
    if (!cur || cur.at === item.at) { await store.del(item.id); const ix = await load(); if (ix.get(item.id)?.at === item.at) ix.delete(item.id); }
    else kickAgain = true;
  };
  const emit = async () => {
    try {
      const ix = [...(await load()).values()];
      st.pending = ix.length; st.bytes = ix.reduce((a, x) => a + x.size, 0); st.walks = new Set(ix.map((x) => x.walk)).size;
    } catch { /* the count can wait */ }
    onChange({ ...st });
  };
  async function run() {
    if (held) return;   // HELD (2026-11-24): kept on the phone, sent when let go (a walk that sends only at its end)
    if (running) { kickAgain = true; return; }
    running = true;
    try {
      let backoff = 0;
      for (;;) {
        kickAgain = false; // what arrives from here on is seen by the next look
        if (st.off || held) break;
        const all = [...(await load()).values()].sort((a, b) => a.at - b.at);
        if (!all.length) break;
        st.sending = true; st.waitingMs = 0; await emit();
        /* SEVERAL AT ONCE (2026-11-12, the first walk that timed itself: 407 parts, 18.5 MB, 25 minutes for a 4-minute
           walk; a send took 0.65 s whatever its size, one after another -- 13 KB a second on a 10 Mbps connection).
           The wait is the round trip, not the bytes, so `parallel` parts go together. A part that must wait stops
           the round as before; the others of its group finish first. */
        let failed = false;
        const one = async (entry) => {
          let r, item;
          try { item = await store.get(entry.id); } catch { item = undefined; }
          if (item === null) { const ix = await load(); if (ix.get(entry.id) === entry) ix.delete(entry.id); return 'ok'; } // gone already
          if (!item) return 'retry';
          try { r = await send(item); } catch (e) { r = 'retry'; st.lastError = e?.message || 'no connection'; }
          if (r === 'ok') { await settle(item); st.sent++; st.sentBytes += sizeOf(item.body); st.lastError = null; backoff = 0; await emit(); }
          else if (r === 'drop') { await settle(item); st.dropped++; st.lastDrop = `${item.name}: ${item.dropWhy || 'refused'}`; await emit(); }
          else if (r === 'off') st.off = item.offWhy || 'the site cannot take uploads';
          return r;
        };
        for (let i = 0; i < all.length && !failed && !st.off; i += parallel) {
          const rs = await Promise.all(all.slice(i, i + parallel).map(one));
          if (rs.some((r) => r !== 'ok' && r !== 'drop' && r !== 'off')) failed = true; // 'retry': wait, then start again from the oldest
        }
        if (st.off) break;
        if (!failed) continue; // all sent: look again (more may have come meanwhile)
        backoff = Math.min(RETRY_MAX_MS, backoff ? backoff * 2 : RETRY_MS);
        st.sending = false; st.waitingMs = backoff; await emit();
        await sleep(backoff);
      }
    } finally {
      st.sending = false; st.waitingMs = 0; running = false;
      await emit();
      const again = kickAgain;
      kickAgain = false;
      if (again && !st.off) run();
    }
  }
  return {
    status: () => ({ ...st }),
    /** Keep a part on the phone and send it when it can. */
    async add(walk, name, type, body) {
      const x = { id: `${walk}/${name}`, walk, name, type, body, at: now() + (seq++) * 1e-3 };
      await store.put(x);
      (await load()).set(x.id, { id: x.id, at: x.at, size: sizeOf(body), walk });
      await emit();
      run();
    },
    kick: () => run(),
    /** Hold the sending (parts are still kept), or let it go and send. */
    hold(v) { held = !!v; st.held = held; if (!held) run(); else emit(); },
    refresh: () => emit(),
  };
}

/** The status in a few words, for the HUD and the page. */
export function statusText(s) {
  if (!s) return '';
  const mb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  if (s.off) return `Upload: off (${s.off}); ${s.pending} part${s.pending === 1 ? '' : 's'} kept on this phone`;
  if (!s.pending) return `Upload: all saved${s.sent ? ` (${s.sent} part${s.sent === 1 ? '' : 's'}, ${mb(s.sentBytes)} sent)` : ''}${s.dropped ? `; ${s.dropped} refused by the site${s.lastDrop ? ` (last: ${s.lastDrop})` : ''}` : ''}`;
  const what = `${s.pending} part${s.pending === 1 ? '' : 's'} (${mb(s.bytes)})${s.walks > 1 ? ` from ${s.walks} walks` : ''}`;
  if (s.sending) return `Upload: sending ${what}`;
  return `Upload: ${what} waiting on this phone; trying again in ${Math.round(s.waitingMs / 1000)} s${s.lastError ? ` (${s.lastError})` : ''}`;
}
