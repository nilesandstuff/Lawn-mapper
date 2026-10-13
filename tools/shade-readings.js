/**
 * Are the owner's light readings arriving? (features session, 2026-10-13.)
 * Workflow 35 runs this: one read-only query of the shade_* tables, and a
 * report of the latest recordings -- counts and times only. These are tracks
 * over customers' lawns (worker/schema.sql), so no place is printed: not a
 * coordinate, not a session's first fix.
 *
 *   node tools/shade-readings.js
 */

import { query } from './corpus-db.js';

const ZONE = process.env.TZ_REPORT || 'America/New_York';
const when = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ago = (ms, now) => {
  const m = Math.round((now - ms) / 60000);
  return m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/**
 * The newest recording in five-minute steps: GPS fixes (one a second is
 * full), seconds of light and of orientation, and the median speed -- so a
 * stop on a property shows as a stretch of slow, full minutes.
 */
export function timeline(buckets) {
  const out = ['', 'Newest recording, five minutes at a time (full = 300 each; mph is the median speed):'];
  for (const b of buckets) {
    const mph = b.speed == null ? '  -' : String(Math.round(b.speed * 2.237)).padStart(3);
    out.push(`  ${when(b.t).padEnd(16)} gps ${String(b.fixes).padStart(3)}  light ${String(b.lux).padStart(3)}  orientation ${String(b.orient).padStart(3)}  ${mph} mph`);
  }
  return out.join('\n');
}

/** The report, from the rows the queries give (pure, for the tests). */
export function report(sessions, keys, now = Date.now()) {
  const out = [];
  out.push(`Push address: ${keys?.n ? `set (made ${keys.made})` : 'NOT MADE YET -- open /shade-log once to make it'}`);
  if (!sessions.length) {
    out.push('', 'No recordings stored yet.');
    out.push('', 'RESULT: nothing has arrived.');
    return out.join('\n');
  }
  out.push('', `Latest ${sessions.length} recordings (newest first):`);
  for (const s of sessions) {
    const span = Math.max(1, (s.last - s.first) / 1000);
    const lightShare = Math.min(1, s.lux / span);
    out.push(`- ${s.session}: ${when(s.first)} to ${when(s.last)}; ${s.fixes} GPS fixes, ${s.lux} s of light (${Math.round(100 * lightShare)}% of the time), ${s.orient} s of orientation; last light ${s.lastLux ? ago(s.lastLux, now) : 'never'}`);
  }
  const top = sessions[0];
  const lightShare = Math.min(1, top.lux / Math.max(1, (top.last - top.first) / 1000));
  out.push('', `RESULT: newest reading ${ago(Math.max(top.last, top.lastLux || 0), now)} (${when(Math.max(top.last, top.lastLux || 0))}), recording "${top.session}".`);
  out.push(`Light came in for ${Math.round(100 * lightShare)}% of that recording${lightShare < 0.8 ? ' -- LOW: the phone is putting the light sensor to sleep (battery settings, /shade-log step 3)' : ''}; orientation ${top.orient ? 'is' : 'is NOT'} arriving.`);
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sessions = query(`
    SELECT f.session, MIN(f.t) AS first, MAX(f.t) AS last, COUNT(*) AS fixes,
           (SELECT COUNT(*) FROM shade_lux l WHERE l.session = f.session) AS lux,
           (SELECT MAX(t) FROM shade_lux l WHERE l.session = f.session) AS lastLux,
           (SELECT COUNT(*) FROM shade_orient o WHERE o.session = f.session) AS orient
    FROM shade_fixes f GROUP BY f.session ORDER BY last DESC LIMIT 10`);
  const keys = query('SELECT COUNT(*) AS n, MAX(created_at) AS made FROM shade_push_keys')[0];
  console.log(report(sessions, keys));
  if (sessions.length) {
    const s = String(sessions[0].session).replace(/'/g, "''");
    const B = 300000;
    const rows = query(`
      SELECT b AS t, SUM(fx) AS fixes, SUM(lx) AS lux, SUM(oz) AS orient FROM (
        SELECT (t / ${B}) * ${B} AS b, 1 AS fx, 0 AS lx, 0 AS oz FROM shade_fixes WHERE session = '${s}'
        UNION ALL SELECT (t / ${B}) * ${B}, 0, 1, 0 FROM shade_lux WHERE session = '${s}'
        UNION ALL SELECT (t / ${B}) * ${B}, 0, 0, 1 FROM shade_orient WHERE session = '${s}'
      ) GROUP BY b ORDER BY b`);
    const speeds = query(`SELECT (t / ${B}) * ${B} AS b, speed FROM shade_fixes WHERE session = '${s}' AND speed IS NOT NULL`);
    const by = new Map();
    for (const r of speeds) { if (!by.has(r.b)) by.set(r.b, []); by.get(r.b).push(r.speed); }
    for (const r of rows) { const v = (by.get(r.t) || []).sort((a, b) => a - b); r.speed = v.length ? v[v.length >> 1] : null; }
    console.log(timeline(rows));
  }
}
