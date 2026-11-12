/**
 * When you'll be at each stop, and back at the shop, as the day goes
 * (route session, 2026-11-10). Owner: "updates the time estimate as you go,
 * and gives an estimated finishing time. When an address is crossed off,
 * assume that it's crossed off while at that address."
 *
 * So a tick is a fix: at that moment you were at that stop, its job done.
 * From the latest tick (or now, before the first; or the time a helper said
 * they'd be free) the rest runs on: drive, job, drive, job ... drive home.
 * A ride between close stops takes its saving off the job it reaches
 * (lib/ride.js). If the stop you are on now should already be done, you are
 * behind: it is taken as finishing now, and the rest moves back with it.
 *
 *   steps   [{ drive: seconds, job: minutes, saved: seconds }]  the stops still to do, in order
 *   back    seconds from the last of them to the shop
 * Returns { arrivals: [ms], finish: ms, left: ms from now }.
 */
export function timeline(steps, back, { lastTick = null, now = Date.now(), readyAt = null } = {}) {
  let t = lastTick ?? now;
  if (readyAt && readyAt > t) t = readyAt;
  if (lastTick == null && t < now) t = now;
  const arrivals = [];
  steps.forEach((s, i) => {
    t += (s.drive || 0) * 1000;
    arrivals.push(t);
    t += ((Number(s.job) || 0) * 60 - (s.saved || 0)) * 1000;
    if (i === 0 && t < now) t = now; // behind on the stop you're on: done now, at the earliest
  });
  t += (back || 0) * 1000;
  if (!steps.length && t < now) t = now;
  return { arrivals, finish: t, left: Math.max(0, t - now) };
}
