/**
 * THE SCAN SITE STARTS "S4. AFTER A WALK" ITSELF (core session, 2026-11-26). GitHub ran this repository's schedules
 * about ten hours late, and dropped some (docs/SCAN-PLAN.md 73), so a walk's plants and ground waited for it. The
 * owner, 2026-11-26: "Yea that's do that". Every 20 minutes (the Worker's own cron, which Cloudflare keeps): the walks
 * of the last few days are read from the twin bucket as S4's planner reads them (lib/afterplan.js); when a map has a
 * settled walk its marker does not name, S4 is started through GitHub's API with the token the owner made (a
 * fine-grained token on this repository, Actions read and write, kept as the Worker's secret GH_DISPATCH_TOKEN; never
 * logged). Not more than once in 50 minutes; what was done is kept in auto/_dispatch.json.
 */
import { prefixesOf, planOf, SETTLED_MS, RECENT_MS, FROM_MS } from '../lib/afterplan.js';

export const AGAIN_MS = 50 * 60 * 1000;
const WORKFLOW = 'scan-after-walk.yml';

async function readJson(bucket, key) {
  const o = await bucket.get(key);
  if (!o) return null;
  try { return JSON.parse(await o.text()); } catch { return null; }
}

/** -> { due, walks, dispatched, why } */
export async function afterWalks(env, now = Date.now(), fetcher = fetch) {
  const B = env.TWIN;
  if (!B) return { why: 'no bucket' };
  const lo = Math.max(FROM_MS, now - RECENT_MS), newest = new Map();
  for (const p of prefixesOf(lo, now)) {
    let cursor;
    do {
      const r = await B.list({ prefix: `twins/${p}`, cursor, limit: 1000 });
      for (const o of r.objects) {
        const m = /^twins\/(\d{13})\//.exec(o.key); if (!m || Number(m[1]) < lo) continue;
        newest.set(m[1], Math.max(newest.get(m[1]) || 0, new Date(o.uploaded).getTime()));
      }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
  }
  const walks = [];
  for (const [id, t] of newest) walks.push({ id, map: (await readJson(B, `twins/${id}/meta.json`))?.map || null, settled: now - t > SETTLED_MS });
  const markers = new Map();
  for (const map of new Set(walks.map((w) => w.map).filter(Boolean))) markers.set(map, (await readJson(B, `auto/${map}.json`))?.walks || []);
  const due = planOf(walks, markers);
  if (!due.length) return { due: 0, walks: walks.length, dispatched: false, why: 'nothing new' };
  const last = await readJson(B, 'auto/_dispatch.json');
  if (last?.at && now - Date.parse(last.at) < AGAIN_MS) return { due: due.length, walks: walks.length, dispatched: false, why: 'started not long ago' };
  if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) return { due: due.length, walks: walks.length, dispatched: false, why: 'no token' };
  const r = await fetcher(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'lawn-scan-worker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.GH_REF || 'main' }),
  });
  const ok = r.status === 204;
  await B.put('auto/_dispatch.json', JSON.stringify({ at: new Date(now).toISOString(), due: due.length, status: r.status }), { httpMetadata: { contentType: 'application/json' } });
  return { due: due.length, walks: walks.length, dispatched: ok, why: ok ? null : `GitHub answered ${r.status}` };
}
