/**
 * TWIN RUNS, LINKED AFTER THE FACT (owner, 2026-10-26: "Maybe it would work
 * better if they were done as independent runs like they have been
 * previously, but you just link them after the fact so I can still view them
 * like twins").
 *
 * Two runs of workflow 14 are run on their own, each drawing its own
 * pictures. Then they are linked: by workflow 24 when it compares exactly one
 * run against one other (tools/link-runs.js), or by picking a twin on the
 * predictions page (POST /api/admin/run-twin). The links live in one small
 * file beside the run list, runs/twins.json:
 *
 *   { "pairs": { "<slug a>": "<slug b>", "<slug b>": "<slug a>" } }
 *
 * A run has at most one twin. Linking it to a new one unlinks the old pair
 * on both sides, so the file never says A -> B while B -> C.
 */

export const TWINS_KEY = 'runs/twins.json';

/** A run folder's name: what run-folder.js writes and the page asks for. */
export const isRunSlug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,95}$/.test(s);

/** The pairs with `a` and `b` linked to each other; `b` empty unlinks `a`. */
export function linkTwins(pairs, a, b) {
  const out = { ...(pairs && typeof pairs === 'object' ? pairs : {}) };
  for (const s of [a, b]) {
    if (!s) continue;
    const old = out[s];
    if (old && out[old] === s) delete out[old];
    delete out[s];
  }
  if (a && b && a !== b) { out[a] = b; out[b] = a; }
  return out;
}

/** The pairs as stored, or none. */
export async function readTwins(bucket) {
  try {
    const object = await bucket.get(TWINS_KEY);
    const data = object ? await object.json() : null;
    return data?.pairs && typeof data.pairs === 'object' ? data.pairs : {};
  } catch {
    return {};
  }
}

export async function writeTwins(bucket, pairs) {
  await bucket.put(TWINS_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), pairs }), {
    httpMetadata: { contentType: 'application/json' },
  });
}
