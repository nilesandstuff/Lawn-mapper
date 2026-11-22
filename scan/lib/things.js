/**
 * THE THINGS A PERSON PLACES IN A YARD (core session, 2026-11-22). The goal (CLAUDE.md): a walk "can place sprinkler
 * heads, gutters (where they connect to the roof and where they let out)", and each walk "adds to future... references.
 * But only overwrites existing reference shapes if there's a high degree of confidence that the new info is actually
 * better."
 *
 * A thing is a KIND at a PLACE on the map (the map's own metres, east and north of its origin, and how high over the
 * ground), with every SIGHTING of it kept: which walk, where that walk had it, and what vouched for that walk's place
 * on the map when it was aimed at. The thing's place is worked out from its sightings; a new sighting never throws an
 * old one away.
 *
 *   - sighted again (the same kind within SAME_M of where it is): one more sighting of the same thing;
 *   - its place: the sightings of the BEST-vouched grade there is (three agreeing corners > the earlier walk's shape >
 *     two corners), and of those the middle one each way. So one loose sighting cannot move a thing three good ones
 *     placed, and a better-vouched sighting does take over from a worse one;
 *   - taken away: marked gone with the walk that said so, never deleted (a later sighting brings it back).
 *
 * Pure. Kept by the scan site beside the map's reference (scan/src/twin.js things; things/<map>.json).
 */
export const KINDS = [
  { id: 'sprinkler', name: 'Sprinkler head', short: 'sprinkler' },
  { id: 'gutter-top', name: 'Gutter, where it meets the roof', short: 'gutter top' },
  { id: 'gutter-out', name: 'Gutter, where it lets out', short: 'gutter outlet' },
  { id: 'other', name: 'Something else', short: 'thing' },
];
export const kindOf = (id) => KINDS.find((k) => k.id === id) || null;
export const SAME_M = 1;          // m: the same kind this near an old one is the same thing sighted again
export const MAX_SIGHTINGS = 12;  // kept per thing, the newest
export const MAX_THINGS = 400;

/* What vouched for the walk's place on the map at the moment of a sighting, best first. */
export const GRADES = ['corners3', 'earlier', 'corners2', 'unsure'];
const rank = (g) => { const i = GRADES.indexOf(g); return i < 0 ? GRADES.length : i; };
const mid = (v) => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const r2 = (x) => +(+x).toFixed(2);

/** A sighting: { at: [e, n], h, walk, grade, aimM?, t } -> the same, rounded and checked, or null. */
export function sighting(s) {
  if (!s || !Array.isArray(s.at) || !s.at.every(Number.isFinite)) return null;
  return { at: [r2(s.at[0]), r2(s.at[1])], h: Number.isFinite(s.h) ? r2(s.h) : null, walk: String(s.walk || ''), grade: GRADES.includes(s.grade) ? s.grade : 'unsure', aimM: Number.isFinite(s.aimM) ? r2(s.aimM) : null, t: Number.isFinite(s.t) ? s.t : Date.now() };
}

/** A thing's place from its sightings: those of the best grade there is, the middle one each way. */
export function placeOf(seen) {
  const S = (seen || []).filter((s) => s?.at);
  if (!S.length) return null;
  const best = Math.min(...S.map((s) => rank(s.grade))), use = S.filter((s) => rank(s.grade) === best);
  const hs = use.map((s) => s.h).filter(Number.isFinite);
  return { at: [r2(mid(use.map((s) => s.at[0]))), r2(mid(use.map((s) => s.at[1])))], h: hs.length ? r2(mid(hs)) : null, grade: GRADES[best] || 'unsure', by: use.length };
}

/**
 * A walk's sightings put into a map's things. things: [{ id, kind, at, h, grade, seen: [...], gone? }] (or none);
 * add: [{ kind, at, h, walk, grade, aimM, t }]. -> { things, added, again, moved: [{ id, m }] }.
 */
export function addSightings(things, add, { sameM = SAME_M } = {}) {
  const out = (things || []).map((t) => ({ ...t, seen: [...(t.seen || [])] }));
  let added = 0, again = 0;
  const moved = [];
  let next = out.reduce((a, t) => Math.max(a, Number(String(t.id).replace(/\D/g, '')) || 0), 0) + 1;
  for (const raw of add || []) {
    const s = sighting(raw);
    if (!s || !kindOf(raw.kind)) continue;
    let hit = null, d = Infinity;
    for (const t of out) { if (t.kind !== raw.kind || !t.at) continue; const x = Math.hypot(t.at[0] - s.at[0], t.at[1] - s.at[1]); if (x <= sameM && x < d) { hit = t; d = x; } }
    if (hit) {
      const was = hit.at;
      hit.seen = [...hit.seen, s].slice(-MAX_SIGHTINGS);
      const p = placeOf(hit.seen);
      Object.assign(hit, { at: p.at, h: p.h, grade: p.grade });
      delete hit.gone;
      again++;
      const m = Math.hypot(p.at[0] - was[0], p.at[1] - was[1]);
      if (m > 0.005) moved.push({ id: hit.id, m: r2(m) });
    } else if (out.length < MAX_THINGS) {
      const p = placeOf([s]);
      out.push({ id: `t${next++}`, kind: raw.kind, at: p.at, h: p.h, grade: p.grade, seen: [s] });
      added++;
    }
  }
  return { things: out, added, again, moved };
}

/** A thing taken away by a walk: marked, not deleted. -> the things. */
export function takeAway(things, id, walk) {
  return (things || []).map((t) => (t.id === id ? { ...t, gone: { walk: String(walk || ''), t: Date.now() } } : t));
}

/** The things still there. */
export const standing = (things) => (things || []).filter((t) => t?.at && !t.gone && kindOf(t.kind));

/** What is read and written: { v: 1, things }. Anything else reads as no things. */
export function decodeThings(text) {
  try {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    if (!j || j.v !== 1 || !Array.isArray(j.things)) return [];
    return j.things.filter((t) => t && typeof t.id === 'string' && kindOf(t.kind) && Array.isArray(t.at) && t.at.every(Number.isFinite)).slice(0, MAX_THINGS);
  } catch { return []; }
}
export const encodeThings = (things) => JSON.stringify({ v: 1, things: (things || []).slice(0, MAX_THINGS) });
