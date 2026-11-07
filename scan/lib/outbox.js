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
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    all: async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => a.at - b.at),
  };
}

/**
 * The outbox. send(part) -> 'ok' | 'retry' | 'drop' | 'off' ('off': the site cannot take parts at all, e.g. no
 * bucket; everything stays on the phone). onChange(status) on every change.
 */
export function newOutbox({ store, send, onChange = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const st = { pending: 0, bytes: 0, walks: 0, sending: false, waitingMs: 0, sent: 0, sentBytes: 0, dropped: 0, off: null, lastError: null, store: store.kind };
  let running = false, kickAgain = false, seq = 0;
  const emit = async () => {
    try {
      const all = await store.all();
      st.pending = all.length; st.bytes = all.reduce((a, x) => a + sizeOf(x.body), 0); st.walks = new Set(all.map((x) => x.walk)).size;
    } catch { /* the count can wait */ }
    onChange({ ...st });
  };
  async function run() {
    if (running) { kickAgain = true; return; }
    running = true;
    try {
      let backoff = 0;
      for (;;) {
        kickAgain = false; // what arrives from here on is seen by the next look
        if (st.off) break;
        const all = await store.all();
        if (!all.length) break;
        st.sending = true; st.waitingMs = 0; await emit();
        let failed = false;
        for (const item of all) {
          let r;
          try { r = await send(item); } catch (e) { r = 'retry'; st.lastError = e?.message || 'no connection'; }
          if (r === 'ok') { await store.del(item.id); st.sent++; st.sentBytes += sizeOf(item.body); st.lastError = null; backoff = 0; await emit(); continue; }
          if (r === 'drop') { await store.del(item.id); st.dropped++; await emit(); continue; }
          if (r === 'off') { st.off = item.offWhy || 'the site cannot take uploads'; break; }
          failed = true; break; // 'retry': wait, then start again from the oldest
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
      await store.put({ id: `${walk}/${name}`, walk, name, type, body, at: now() + (seq++) * 1e-3 });
      await emit();
      run();
    },
    kick: () => run(),
    refresh: () => emit(),
  };
}

/** The status in a few words, for the HUD and the page. */
export function statusText(s) {
  if (!s) return '';
  const mb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  if (s.off) return `Upload: off (${s.off}); ${s.pending} part${s.pending === 1 ? '' : 's'} kept on this phone`;
  if (!s.pending) return `Upload: all saved${s.sent ? ` (${s.sent} part${s.sent === 1 ? '' : 's'}, ${mb(s.sentBytes)} sent)` : ''}${s.dropped ? `; ${s.dropped} refused by the site` : ''}`;
  const what = `${s.pending} part${s.pending === 1 ? '' : 's'} (${mb(s.bytes)})${s.walks > 1 ? ` from ${s.walks} walks` : ''}`;
  if (s.sending) return `Upload: sending ${what}`;
  return `Upload: ${what} waiting on this phone; trying again in ${Math.round(s.waitingMs / 1000)} s${s.lastError ? ` (${s.lastError})` : ''}`;
}
