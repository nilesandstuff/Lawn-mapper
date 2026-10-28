/**
 * THE AUTO-FRONT CHECK (owner, 2026-10-28): the owner opens corpus lots in the
 * sections tool, which proposes front, back and sides from the address
 * (public/lib/yards.js), and marks each right or wrong. The marks live in
 * the corpus bucket, one small file, read back as a tally.
 *
 * A mark: { id, verdict: 'right' | 'wrong' | 'skip', note, at, info } where
 * info is what the rule decided (the street, the facing, corner or not), so
 * a wrong mark says what went wrong without reopening the lot.
 */

export const MARKS_KEY = 'yards/marks.json';
export const VERDICTS = new Set(['right', 'wrong', 'skip']);

export async function readMarks(bucket) {
  try {
    const object = await bucket.get(MARKS_KEY);
    const data = object ? await object.json() : null;
    return data?.marks && typeof data.marks === 'object' ? data.marks : {};
  } catch {
    return {};
  }
}

export async function writeMarks(bucket, marks) {
  await bucket.put(MARKS_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), marks }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** The marks with one lot's verdict set, or cleared when the verdict is empty. */
export function setMark(marks, id, verdict, { note = '', info = null } = {}) {
  const out = { ...marks };
  if (!verdict) { delete out[id]; return out; }
  if (!VERDICTS.has(verdict)) throw new Error('Not a verdict');
  out[id] = { verdict, note: String(note || '').slice(0, 300), info: info && typeof info === 'object' ? info : null, at: new Date().toISOString() };
  return out;
}

/** How the check stands: counts, and the share right among those judged. */
export function tally(marks) {
  const t = { right: 0, wrong: 0, skip: 0, total: 0, pctRight: null };
  for (const m of Object.values(marks || {})) {
    if (!VERDICTS.has(m?.verdict)) continue;
    t[m.verdict]++;
    t.total++;
  }
  const judged = t.right + t.wrong;
  t.pctRight = judged ? Math.round((100 * t.right) / judged) : null;
  return t;
}
