/**
 * A shared day, live (route session, 2026-11-06): who has which stops, which
 * are done, and the re-split when someone comes free to help.
 *
 * Owner: "Sometimes one person has an extremely heavy route that day. So
 * when the others get done, they can come help that person ... the helpers
 * may not become available at the same time, and we never know when a
 * person will be available to help until they're ready." And: "the idea is
 * to end up with a similar end time across the board."
 *
 * So nothing is predicted: at each moment someone comes free (or says when
 * they will be), every stop not yet done is shared out again among everyone
 * still working, so all come back to the shop at about the same time
 * (split.js rebalance). The stop each working person is on or driving to
 * stays theirs. Ticks are the ground truth; GPS is only asked for at the
 * moment someone taps, when the page is open and it works.
 *
 * THE DOC, kept by the Worker (src/live.js), one per shared link:
 *   { id, version, at, shop: { label, lng, lat },
 *     stops:  { [sid]: { address, city, name, minutes, sqft, label, lng, lat, done: null | { at, by } } },
 *     people: [{ id, name, stops: [sid],             in driving order, done ones first
 *                into: { [sid]: { duration, distance } | null },   the drive to each stop
 *                back: { duration, distance } | null,               the drive home
 *                geometry: [[lng, lat]] | null,
 *                readyAt: ms | null,   free from then (a helper who said when)
 *                start: { lng, lat, label } | null,   where they said they are
 *                free: bool,           volunteered to help, whether or not they have stops
 *                helper: bool }],      joined by the link, rather than from the planner
 *     ride: { road, yard, save },      riding between close stops (lib/ride.js)
 *     events: [{ at, text }] }
 */

import { RIDE_DEFAULTS, rideLeg } from './ride.js';

export const MAX_EVENTS = 30;

/** A split plan from the planner (people.js's shape) as a live doc. */
export function planToLive(plan, { id = null, now = Date.now() } = {}) {
  const stops = {};
  let n = 0;
  const people = plan.people.map((p, k) => {
    const sids = p.stops.map((s) => {
      n += 1;
      const sid = `s${n}`;
      stops[sid] = {
        address: s.address, city: s.city || '', name: s.name || '', minutes: s.minutes ?? null, sqft: s.sqft ?? null,
        label: s.label || s.address, lng: s.lng, lat: s.lat, done: null,
      };
      return sid;
    });
    const into = {};
    sids.forEach((sid, i) => { into[sid] = i === 0 ? null : p.legs?.[i - 1] || null; });
    return {
      id: `p${k + 1}`, name: p.name || `Person ${k + 1}`, stops: sids, into,
      back: sids.length ? p.legs?.[sids.length - 1] || null : null,
      geometry: p.geometry || null, readyAt: null, start: null, free: false, helper: false,
    };
  });
  return { id, version: 1, at: plan.at || now, shop: plan.shop, ride: plan.ride || RIDE_DEFAULTS, stops, people, events: [] };
}

/** Each person's stops: done (in the order they were done) and still to do (in route order). */
export function standing(doc) {
  return doc.people.map((p) => {
    const done = p.stops.filter((s) => doc.stops[s]?.done).sort((a, b) => doc.stops[a].done.at - doc.stops[b].done.at);
    const todo = p.stops.filter((s) => doc.stops[s] && !doc.stops[s].done);
    return { id: p.id, done, todo };
  });
}

/** Who takes part in a re-split: anyone with stops to do, or who has said they are free. */
export const taking = (doc) => doc.people.filter((p, k) => p.free || standing(doc)[k].todo.length);

/**
 * The points a re-split needs, in matrix order: every stop still to do, each
 * person's known position, then the shop (last). key -> index in `index`.
 */
export function problemPoints(doc) {
  const points = [];
  const index = new Map();
  const add = (key, p) => { if (!index.has(key)) { index.set(key, points.length); points.push({ key, lng: p.lng, lat: p.lat }); } };
  const st = standing(doc);
  doc.people.forEach((p, k) => {
    for (const s of st[k].todo) add(s, doc.stops[s]);
    const pos = position(doc, p, st[k]);
    if (pos) add(pos.key, pos);
  });
  add('shop', doc.shop);
  return { points, index };
}

/** Where a person is: their last done stop, else where they said, else unknown. */
function position(doc, p, st) {
  if (st.done.length) { const s = st.done[st.done.length - 1]; return { key: s, ...doc.stops[s] }; }
  if (p.start) return { key: `at:${p.id}`, ...p.start };
  return null;
}

/**
 * The re-split's input, given the drive times D between problemPoints:
 *   persons  [{ anchor, fixed }]   (split.js)
 *   current  each one's stops still to do that may move, as point indices
 *   kept     each one's stop that stays (on it or driving to it), or null
 *   who      the doc people taking part, in the same order
 */
export function problem(doc, D, index, now = Date.now()) {
  const st = standing(doc);
  const service = [];
  for (const [key, i] of index) service[i] = doc.stops[key] ? (Number(doc.stops[key].minutes) || 0) * 60 : 0;
  const who = [];
  const persons = [];
  const current = [];
  const kept = [];
  doc.people.forEach((p, k) => {
    const s = st[k];
    if (!p.free && !s.todo.length) return;
    const wait = p.readyAt && p.readyAt > now ? (p.readyAt - now) / 1000 : 0;
    const pos = position(doc, p, s);
    const posI = pos ? index.get(pos.key) : null;
    // working now, with stops: the next one is where they are or are going, and stays theirs
    const working = s.todo.length && !(p.readyAt && p.readyAt > now);
    const keep = working ? s.todo[0] : null;
    who.push(p);
    if (keep) {
      const ki = index.get(keep);
      persons.push({ anchor: ki, fixed: wait + (posI != null ? D[posI][ki] || 0 : 0) + service[ki] });
      current.push(s.todo.slice(1).map((x) => index.get(x)));
    } else {
      persons.push({ anchor: posI ?? null, fixed: wait });
      current.push(s.todo.map((x) => index.get(x)));
    }
    kept.push(keep);
  });
  return { persons, current, kept, who, service, shop: index.get('shop') };
}

/**
 * The doc with a re-split applied: each person's list is their done stops,
 * the stop they keep, then their new route. The drives come from the matrix
 * (D seconds, M metres); geometry is dropped where a route changed (the page
 * fetches it again). Returns { doc, changes: [{ id, gained, lost }] }.
 */
export function applySplit(doc, pr, routes, D, M, points, now = Date.now()) {
  const st = standing(doc);
  const keyOf = (i) => points[i].key;
  const next = structuredClone(doc);
  const changes = [];
  pr.who.forEach((p, w) => {
    const k = doc.people.findIndex((x) => x.id === p.id);
    const before = new Set(st[k].todo);
    const todo = [...(pr.kept[w] ? [pr.kept[w]] : []), ...routes[w].map(keyOf)];
    const person = next.people[k];
    person.stops = [...st[k].done, ...todo];
    // the drives: from where they are (or, unknown, nothing) through the list to the shop
    const pos = position(doc, p, st[k]);
    let from = pos ? pos.key : null;
    const idx = (key) => points.findIndex((x) => x.key === key);
    for (const s of todo) {
      const leg = from == null ? null : { duration: D[idx(from)][idx(s)], distance: M[idx(from)][idx(s)] };
      // from a stop to a close stop: ridden, not driven (lib/ride.js)
      person.into[s] = leg && doc.stops[from] ? rideLeg(leg, doc.stops[from], doc.stops[s], doc.ride || RIDE_DEFAULTS) : leg;
      from = s;
    }
    const shopI = idx('shop');
    person.back = from == null ? null : { duration: D[idx(from)][shopI], distance: M[idx(from)][shopI] };
    const gained = todo.filter((s) => !before.has(s));
    const lost = [...before].filter((s) => !todo.includes(s));
    if (gained.length || lost.length || todo.join() !== st[k].todo.join()) person.geometry = null;
    changes.push({ id: p.id, gained, lost });
  });
  return { doc: next, changes };
}

/** "Sam took 5 stops (2 from Person 1, 3 from Lee)" and the like, for the events list. */
export function describe(doc, changes) {
  const name = (id) => doc.people.find((p) => p.id === id)?.name || 'someone';
  const ownerBefore = new Map();
  doc.people.forEach((p) => p.stops.forEach((s) => ownerBefore.set(s, p.id)));
  const lines = [];
  for (const c of changes) {
    if (!c.gained.length) continue;
    const from = {};
    for (const s of c.gained) { const o = ownerBefore.get(s); from[o] = (from[o] || 0) + 1; }
    const parts = Object.entries(from).map(([id, n]) => `${n} from ${name(id)}`);
    lines.push(`${name(c.id)} took ${c.gained.length} stop${c.gained.length === 1 ? '' : 's'} (${parts.join(', ')})`);
  }
  return lines;
}

/**
 * Whether an update from a page may replace the stored doc: the same stops,
 * none lost or doubled, done stops left with whoever did them, nobody
 * removed. Returns an error string, or null. The stored done marks always
 * win (stops are taken from the stored doc).
 */
export function checkUpdate(stored, next) {
  if (!next || !Array.isArray(next.people)) return 'No people';
  const ids = new Set(next.people.map((p) => p.id));
  if (ids.size !== next.people.length) return 'A person twice';
  for (const p of stored.people) if (!ids.has(p.id)) return 'A person went missing';
  const seen = new Set();
  for (const p of next.people) {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40) return 'A name, please';
    for (const s of p.stops || []) {
      if (!stored.stops[s]) return `No such stop ${s}`;
      if (seen.has(s)) return `Stop ${s} twice`;
      seen.add(s);
    }
  }
  if (seen.size !== Object.keys(stored.stops).length) return 'A stop went missing';
  const holder = new Map();
  next.people.forEach((p) => p.stops.forEach((s) => holder.set(s, p.id)));
  for (const p of stored.people) for (const s of p.stops) if (stored.stops[s].done && holder.get(s) !== p.id) return 'A done stop moved';
  return null;
}
