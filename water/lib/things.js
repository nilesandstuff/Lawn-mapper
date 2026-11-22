/**
 * THINGS PLACED IN A YARD AR WALK, OFFERED TO THE WATER MAP (owner, 2026-11-22, asked whether a walk's sprinkler heads
 * and gutter points should be shared with the water map: "Yes. Ask the water map how it wants that"). The Yard AR
 * tool keeps them in its own part of the map's record (map.tools.scan.data.things; docs/MAPS.md, the core session's
 * scan/lib/things.js forRecord): { id, kind: sprinkler | gutter-top | gutter-out | other, lng, lat, e, n, h, grade:
 * corners3 | earlier | corners2 | unsure, seen, last, gone?, pair? }. Pure: what to offer, given what the person has
 * already placed by hand and what they have already answered.
 *
 * OFFERED, NEVER PUT IN BY ITSELF: a head or downspout the person placed by hand stays; a walk's thing within SAME_M
 * of one is the same thing and is not offered. A thing answered once (taken or passed over; its id is kept in the
 * water part, walkThings) is not offered again, and a thing a later walk took away (gone) is not offered. A thing
 * whose walk was not sure of its own place (grade unsure) is offered unticked.
 *
 * A DOWNSPOUT is a gutter-top and its gutter-out (the same pair id): { from, to }, as lib/gutters.js roofRouting reads
 * them. An outlet with no top is offered with from null: the page gives it the nearest roof edge, and says it guessed.
 *
 * PLACES ARE THE LIDAR'S (the walk fixes itself to the lidar by roof corners; the water map works on the lidar's
 * grid): a thing is put where the walk has it, not moved to suit the photo.
 */
export const SAME_M = 1.0;
const metres = (a, b) => { const k = Math.cos((a[1] * Math.PI) / 180); return Math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 111320); };
const at = (t) => (Number.isFinite(t?.lng) && Number.isFinite(t?.lat) ? [+t.lng.toFixed(7), +t.lat.toFixed(7)] : null);
const RANK = { corners3: 3, earlier: 2, corners2: 1, unsure: 0 };

/**
 * things: the scan part's list. have: { heads: [[lng, lat]], downspouts: [{ from, to }], answered: [thing ids] }.
 * -> { heads: [{ ids, at, grade, tick }], spouts: [{ ids, from (or null), to, grade, tick }], other (count of
 *      'other' things, not offered), same (count left out as already placed by hand) }
 */
export function offersFrom(things, { heads = [], downspouts = [], answered = [] } = {}) {
  const done = new Set(answered), live = (Array.isArray(things) ? things : []).filter((t) => t && t.id && !t.gone && at(t));
  const out = { heads: [], spouts: [], other: live.filter((t) => t.kind === 'other').length, same: 0 };
  for (const t of live.filter((x) => x.kind === 'sprinkler' && !done.has(x.id))) {
    const p = at(t);
    if (heads.some((h) => metres(h, p) <= SAME_M)) { out.same++; continue; }
    out.heads.push({ ids: [t.id], at: p, grade: t.grade || 'unsure', tick: t.grade !== 'unsure' && !!t.grade });
  }
  const tops = new Map(live.filter((t) => t.kind === 'gutter-top' && t.pair).map((t) => [t.pair, t]));
  for (const o of live.filter((x) => x.kind === 'gutter-out' && !done.has(x.id))) {
    const to = at(o), top = o.pair ? tops.get(o.pair) : null, from = top ? at(top) : null;
    if (downspouts.some((d) => d?.to && metres(d.to, to) <= SAME_M)) { out.same++; continue; }
    const grade = top ? (RANK[top.grade] < RANK[o.grade] ? top.grade : o.grade) || 'unsure' : o.grade || 'unsure';
    out.spouts.push({ ids: top ? [o.id, top.id] : [o.id], from, to, grade, tick: grade !== 'unsure' });
  }
  return out;
}

/** How many of each, in words, for the offer's first line. */
export function offerWords(o) {
  const n = (k, one, many) => (k ? `${k} ${k === 1 ? one : many}` : '');
  return [n(o.heads.length, 'sprinkler head', 'sprinkler heads'), n(o.spouts.length, 'downspout', 'downspouts')].filter(Boolean).join(' and ');
}
