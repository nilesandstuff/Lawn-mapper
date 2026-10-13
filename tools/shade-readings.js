/**
 * Are the owner's light readings arriving? (features session, 2026-10-13.)
 * Workflow 35 runs this: one read-only query of the shade_* tables, and a
 * report of the latest recordings -- counts and times only. These are tracks
 * over customers' lawns (worker/schema.sql), so no place is printed: not a
 * coordinate, not a session's first fix.
 *
 *   node tools/shade-readings.js
 *   FROM=12:38 TO=12:42 node tools/shade-readings.js   (a window, second by second)
 *
 * With FROM and TO (local times today, or "YYYY-MM-DD HH:MM"), also every
 * second in that window: lux and how the phone was tilted, against the sun
 * -- for measuring the sensor's angle response (the owner's tilt tests).
 * The sun is placed from the window's fixes, which are not printed.
 */

import { query } from './corpus-db.js';
import { sunAt } from '../public/shade/sun.js';
import { sunOffFace } from '../public/shade/truth.js';

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

/** The latest pushes the site received, kept or refused (shade_push_log). */
export function pushes(rows, now = Date.now()) {
  if (!rows.length) return '\nPushes received: none logged yet (the log started 2026-10-13).';
  const out = ['', `Latest ${rows.length} pushes the site received (newest first):`];
  for (const r of rows) {
    const t = Date.parse(r.at);
    out.push(`  ${when(t).padEnd(16)} ${ago(t, now).padEnd(12)} ${r.status === 200 ? 'kept' : `REFUSED ${r.status}`}  ${r.entries ?? '?'} entries -> ${r.lux ?? 0} s light, ${r.fix ?? 0} fixes, ${r.orient ?? 0} s orientation, ${r.bytes ?? '?'} bytes, ${r.ms ?? '?'} ms${r.error ? `  (${r.error})` : ''}`);
  }
  const bad = rows.filter((r) => r.status !== 200).length;
  out.push(`PUSHES: the last one ${ago(Date.parse(rows[0].at), now)}; ${bad} of these ${rows.length} refused.`);
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

/** "HH:MM" today, or "YYYY-MM-DD HH:MM", in ZONE, as epoch ms. */
export function localMs(text, now = Date.now(), zone = ZONE) {
  const m = String(text).trim().match(/^(?:(\d{4})-(\d\d)-(\d\d)\s+)?(\d{1,2}):(\d\d)(?::(\d\d))?$/);
  if (!m) return NaN;
  const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  const today = parts(now);
  const [y, mo, d] = m[1] ? [+m[1], +m[2], +m[3]] : [today.year, today.month, today.day];
  const guess = Date.UTC(y, mo - 1, d, +m[4], +m[5], +(m[6] || 0));
  const seen = parts(guess), offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) - guess;
  return guess - offset;
}

/**
 * A window second by second: lux, the phone face's tilt from flat and its
 * (magnetic) heading, and the sun's angle off the face. `orient` rows are
 * [t, nx, ny, nz, head] per second; `sun(t)` gives { elevation, azimuth }.
 */
export function tiltWindow(lux, orient, sun) {
  const O = new Map(orient.map((r) => [r[0], r]));
  const R = 180 / Math.PI;
  const out = ['', 'Second by second (tilt = face from flat; face az = the way the face leans, magnetic; sun off = angle between the face and the sun, magnetic, no declination):'];
  out.push('  time         lux    tilt  face az  sun off');
  const rows = [];
  for (const [t, v] of lux) {
    const o = O.get(Math.floor(t / 1000) * 1000);
    const s = sun(t);
    if (!o) { out.push(`  ${new Date(t).toLocaleTimeString('en-US', { timeZone: ZONE, hour12: false })}  ${String(Math.round(v)).padStart(7)}   (no orientation)`); continue; }
    const [, nx, ny, nz] = o;
    const tilt = Math.acos(Math.max(-1, Math.min(1, nz))) * R;
    const faceAz = (Math.atan2(nx, ny) * R + 360) % 360;
    const off = sunOffFace([nx, ny, nz], s.elevation, s.azimuth);
    rows.push({ t, lux: v, nx, ny, nz, off });
    out.push(`  ${new Date(t).toLocaleTimeString('en-US', { timeZone: ZONE, hour12: false })}  ${String(Math.round(v)).padStart(7)}  ${tilt.toFixed(0).padStart(4)}°  ${faceAz.toFixed(0).padStart(5)}°  ${off.toFixed(0).padStart(5)}°`);
  }
  if (lux.length) {
    const s = sun(lux[0][0]);
    const v = lux.map((r) => r[1]).sort((a, b) => a - b);
    out.push(`WINDOW: ${lux.length} s of light, ${rows.length} with orientation; sun ${s.elevation.toFixed(0)}° up at ${s.azimuth.toFixed(0)}° (true); lux ${Math.round(v[0])} to ${Math.round(v[v.length - 1])}, median ${Math.round(v[v.length >> 1])}.`);
  } else out.push('WINDOW: no light readings in it.');
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
  let log = [];
  try { log = query('SELECT at, session, status, entries, lux, fix, orient, bytes, ms, error FROM shade_push_log ORDER BY id DESC LIMIT 15'); } catch { /* not made yet: the deploy makes it */ }
  console.log(pushes(log));
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
  if (process.env.FROM && process.env.TO) {
    const t0 = localMs(process.env.FROM), t1 = localMs(process.env.TO);
    if (!(t1 > t0)) console.log(`\nWindow: could not read FROM=${process.env.FROM} TO=${process.env.TO} (HH:MM, or YYYY-MM-DD HH:MM).`);
    else {
      const lux = query(`SELECT t, lux FROM shade_lux WHERE t BETWEEN ${t0} AND ${t1} ORDER BY t`).map((r) => [r.t, r.lux]);
      const orient = query(`SELECT t, nx, ny, nz, head FROM shade_orient WHERE t BETWEEN ${t0 - 1000} AND ${t1 + 1000} ORDER BY t`).map((r) => [r.t, r.nx, r.ny, r.nz, r.head]);
      const fixes = query(`SELECT lat, lng FROM shade_fixes WHERE t BETWEEN ${t0 - 600000} AND ${t1 + 600000}`);
      const md = (a) => a.sort((x, y) => x - y)[a.length >> 1];
      const lat = md(fixes.map((f) => f.lat)), lng = md(fixes.map((f) => f.lng));
      console.log(`\nWindow ${when(t0)} to ${when(t1)}:`);
      if (!fixes.length) console.log('No GPS fixes near it, so the sun cannot be placed.');
      else console.log(tiltWindow(lux, orient, (t) => sunAt(lat, lng, t)));
    }
  }
}
