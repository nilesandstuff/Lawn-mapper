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
 *
 * With LEVELS=yes, also today's recordings half an hour at a time, judged
 * as the check view judges them (each reading at its own angle to the sun):
 * the sun's level facing the phone squarely, the shade's, and how many
 * readings were sun, shade, or left out -- no places.
 *
 * With LIDAR=yes, the lidar under today's tracks, area by area (about 300 m
 * squares): the flight the shade map uses and when it was flown, and any
 * newer flight USGS has -- in its index (WESM) or as download tiles (the TNM
 * API) -- that the map cannot read yet. Years only, no names, no places.
 */

import { query } from './corpus-db.js';
import { sunAt } from '../public/shade/sun.js';
import { lidarAt } from '../worker/src/shade.js';
import { sunOffFace, sunGain, joinTrack, usable, sunOrShadeAround } from '../public/shade/truth.js';

const ZONE = process.env.TZ_REPORT || 'America/New_York';
const when = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/**
 * A recording's name, safe for a public log: Sensor Logger's own ids (a
 * uuid) as they are; an uploaded file's name -- which the owner may have
 * named after the street -- as a short code (this repository is public).
 */
export function sessionLabel(name) {
  const s = String(name || '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${/^upload /.test(s) ? 'upload' : 'recording'} #${(h >>> 0).toString(16).padStart(8, '0')}`;
}
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
    out.push(`- ${sessionLabel(s.session)}: ${when(s.first)} to ${when(s.last)}; ${s.fixes} GPS fixes, ${s.lux} s of light (${Math.round(100 * lightShare)}% of the time), ${s.orient} s of orientation; last light ${s.lastLux ? ago(s.lastLux, now) : 'never'}`);
  }
  const top = sessions[0];
  const lightShare = Math.min(1, top.lux / Math.max(1, (top.last - top.first) / 1000));
  out.push('', `RESULT: newest reading ${ago(Math.max(top.last, top.lastLux || 0), now)} (${when(Math.max(top.last, top.lastLux || 0))}), recording "${sessionLabel(top.session)}".`);
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

/**
 * Samples ({ t, lux, gain, el }) half an hour at a time, each stretch judged
 * by sunOrShadeAround: face-on sun and shade levels and the counts.
 */
export function sunLevels(samples, stepMs = 1800000) {
  const by = new Map();
  for (const s of samples) { const k = Math.floor(s.t / stepMs) * stepMs; if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
  const out = ['', 'Today half an hour at a time, each reading judged at its own angle to the sun (face-on = the sun\'s level facing the phone squarely, the median and the brightest tenth; the tilt tests\' brightest tenth was about 90,000-100,000 at 38 degrees up):'];
  for (const [k, list] of [...by].sort((a, b) => a[0] - b[0])) {
    const el = list.reduce((a, s) => a + s.el, 0) / list.length;
    const so = list.length >= 10 ? sunOrShadeAround(list) : null;
    const head = `  ${when(k).padEnd(16)} sun ${el.toFixed(0).padStart(2)}° up  ${String(list.length).padStart(4)} readings`;
    if (!so || !so.clear) { out.push(`${head}  no clear split into sun and shade`); continue; }
    const n = (f) => so.sun.filter((v, i) => f(v, i)).length;
    const beam = list.filter((x, i) => so.judged[i] && so.sun[i] && x.gain > 0.05).map((x) => (x.lux - so.shadeLux) / x.gain).sort((x, y) => x - y);
    const p90 = beam.length ? beam[Math.floor(0.9 * (beam.length - 1))] : NaN;
    out.push(`${head}  face-on sun ${Math.round(so.sunLux).toLocaleString('en-US').padStart(7)} (brightest tenth ${Math.round(p90).toLocaleString('en-US').padStart(7)}), shade ${Math.round(so.shadeLux).toLocaleString('en-US').padStart(6)}; ${n((v, i) => so.judged[i] && v)} sun, ${n((v, i) => so.judged[i] && !v)} shade, ${n((v, i) => so.faint[i])} turned too far, ${n((v, i) => !so.judged[i] && !so.faint[i])} cloud`);
  }
  return out.join('\n');
}

/**
 * One line per area from what lidarAt and the TNM API say there: { used:
 * { year, end }, newer: [{ end, tiles }] } -> text. Pure, for the tests.
 */
export function lidarAges(areas) {
  const y = (ms) => (ms ? new Date(ms).getUTCFullYear() : '?');
  const out = ['', `The lidar under today's tracks (${areas.length} area${areas.length === 1 ? '' : 's'} about 300 m across):`];
  const groups = new Map();
  for (const a of areas) {
    const used = a.used ? `flown ${a.used.end ? `to ${new Date(a.used.end).toISOString().slice(0, 7)}` : `in ${a.used.year ?? '?'}`}` : 'NO LIDAR';
    const newer = a.newer.length ? `NEWER FLIGHT NOT USED: ${a.newer.map((n) => `${y(n.end)}${n.tiles ? ' (download tiles only)' : ''}`).join(', ')}` : 'nothing newer anywhere at USGS';
    const k = `${used}; ${newer}`;
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  for (const [k, n] of groups) out.push(`  ${String(n).padStart(3)} area${n === 1 ? ' ' : 's'}: ${k}`);
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
  if (/^y/i.test(process.env.LEVELS || '')) {
    const t0 = localMs('0:00'), now = Date.now(), samples = [];
    const today = query(`SELECT DISTINCT session FROM shade_fixes WHERE t >= ${t0}`).map((r) => String(r.session).replace(/'/g, "''"));
    for (const s of today) {
      for (let a = t0; a < now; a += 7200000) {
        const b = a + 7200000, w = `session = '${s}' AND t >= ${a} AND t < ${b}`;
        const fix = query(`SELECT t, lat, lng, acc, speed, bearing FROM shade_fixes WHERE ${w} ORDER BY t`).map((r) => [r.t, r.lat, r.lng, r.acc, r.speed, r.bearing]);
        if (!fix.length) continue;
        const lux = query(`SELECT t, lux FROM shade_lux WHERE ${w} ORDER BY t`).map((r) => [r.t, r.lux]);
        const orient = query(`SELECT t, nx, ny, nz, head FROM shade_orient WHERE ${w} ORDER BY t`).map((r) => [r.t, r.nx, r.ny, r.nz, r.head]);
        for (const p of usable(joinTrack(fix, lux, { orient }))) {
          const sun = sunAt(p.lat, p.lng, p.t);
          if (sun.elevation > 5) samples.push({ t: p.t, lux: p.lux, gain: sunGain(sunOffFace(p.up, sun.elevation, sun.azimuth)), el: sun.elevation });
        }
      }
    }
    samples.sort((x, y) => x.t - y.t);
    console.log(samples.length ? sunLevels(samples) : '\nToday: no usable readings yet.');
  }
  if (/^y/i.test(process.env.LIDAR || '')) {
    const t0 = localMs('0:00');
    const fixes = query(`SELECT lat, lng FROM shade_fixes WHERE t >= ${t0} AND (speed IS NULL OR speed < 4.5)`);
    const cells = new Map();
    for (const f of fixes) { const k = `${Math.round(f.lng * 300)},${Math.round(f.lat * 300)}`; if (!cells.has(k)) cells.set(k, [f.lng, f.lat]); }
    const areas = [];
    for (const [lng, lat] of cells.values()) {
      const found = await lidarAt(lng, lat).catch(() => null);
      const c = found?.clouds?.[0];
      const end = c?.unit?.end ?? null;
      const newer = (found?.notOnAws || []).filter((u) => (u.end ?? 0) > (end ?? 0)).map((u) => ({ end: u.end, tiles: false }));
      try {
        const d = 0.002, q = new URLSearchParams({ datasets: 'Lidar Point Cloud (LPC)', bbox: [lng - d, lat - d, lng + d, lat + d].join(','), max: '200', outputFormat: 'JSON' });
        const tnm = await (await fetch(`https://tnmaccess.nationalmap.gov/api/v1/products?${q}`)).json();
        const years = new Set();
        for (const it of tnm.items || []) {
          const m = /_(20\d\d)(?:_|\/)/.exec(it.downloadURL || '');
          if (m && Date.UTC(+m[1], 11, 31) > (end ?? 0) + 365.25 * 86400000 && !newer.some((n) => new Date(n.end).getUTCFullYear() >= +m[1])) years.add(+m[1]);
        }
        for (const yy of years) newer.push({ end: Date.UTC(yy, 6, 1), tiles: true });
      } catch { /* the TNM API not answering: WESM's answer stands */ }
      areas.push({ used: c ? { year: c.year, end } : null, newer });
    }
    console.log(areas.length ? lidarAges(areas) : '\nToday: no tracks yet.');
  }
}
