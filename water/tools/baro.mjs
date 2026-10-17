/**
 * THE OWNER'S BAROMETER AGAINST THE LIDAR GROUND (water session, 2026-10-17;
 * owner: "I've taken sensor recordings using my phone on a few dozen
 * properties. I had the barometer sensor on. The phone was fixed to my
 * fertilizer spreader ... subtracting the hopper height from the elevation
 * should give you a good idea of where the ground is, and the bumps").
 *
 * The recordings are the shade map's field readings (the features session's
 * tables, read the way its tools/shade-field-check.js loadVisits reads them,
 * with its own pickSessions and truth.js splitVisits): shade_fixes (GPS),
 * shade_baro (one median per second: hPa and the phone's relative altitude,
 * kept since 2026-10-17 -- older recordings need re-uploading), shade_orient
 * (tilt), shade_cuts (stretches the owner erased).
 *
 * For each visit with the barometer: the lidar ground (the shared ground,
 * lib/shade/ground.js, on the web map's frame) under every usable fix, and
 * the phone's height. The hopper's 1.27 m and the barometer's own zero are
 * one constant; the weather drifts the pressure slowly; so the fit is
 *     baro height = lidar ground + a + b * t
 * and what is reported is what is left:
 *   relief    the lidar ground's range along the pass (5th-95th percentile)
 *   residual  SD of baro minus (ground + a + b t)
 *   r         correlation of the two after the fit (whole-lot shape)
 *   r bumps   correlation of what is left after a 20 s running mean is taken
 *             from each (the short bumps the owner asked about)
 *
 * NUMBERS ONLY: visits are numbered, never named; no session name (the
 * owner's file names can carry a street), place or coordinate is printed or
 * written, and nothing derived from the tracks goes into a public file
 * (features session's rule for these tracks, 2026-10-17).
 *
 *   CLOUDFLARE_API_TOKEN=.. CLOUDFLARE_ACCOUNT_ID=.. node water/tools/baro.mjs
 */

import { query } from '../../tools/corpus-db.js';
import { pickSessions } from '../../tools/shade-field-check.js';
import { splitVisits } from '../../public/shade/truth.js';
import { lidarAt } from '../../worker/src/shade.js';
import { pointsIn, toMerc, mercScale } from '../lib/ept.js';
import { nodeIo } from '../lib/node-io.js';
import { analyse } from '../lib/lowspots.js';

const HOPPER_M = 1.27; // the phone on the spreader (features session, 2026-10-17); a constant, it cancels in the fit
/* THE SPREADER DAYS: the phone rode the spreader only on the days it moved over about 2 m/s (features
   session, 2026-10-17); on the others it was carried, and a hand's height wanders by more than the bumps. */
const SPREADER_SPEED = 2;
const MAX_ACC = 8, MAX_SPEED = 4.5, FLAT = Math.cos((20 * Math.PI) / 180);
const PAD = 15;

const q = (sql) => query(sql);
const esc = (s) => String(s).replace(/'/g, "''");
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const pct = (v, f) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };

/** Pearson correlation. */
export function corr(a, b) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN;
}

/** Least squares h - g = a + b t: returns the residuals. */
export function detrend(t, h, g) {
  const n = t.length, y = h.map((v, i) => v - g[i]);
  const mt = t.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let stt = 0, sty = 0;
  for (let i = 0; i < n; i++) { stt += (t[i] - mt) ** 2; sty += (t[i] - mt) * (y[i] - my); }
  const b = stt ? sty / stt : 0, a = my - b * mt;
  return { a, b, fitted: t.map((v, i) => g[i] + a + b * v), resid: y.map((v, i) => v - (a + b * t[i])) };
}

/** The value minus its running mean over `w` seconds (t in s). */
export function highPass(t, v, w = 20) {
  return v.map((x, i) => {
    let s = 0, k = 0;
    for (let j = i; j >= 0 && t[i] - t[j] <= w / 2; j--) { s += v[j]; k++; }
    for (let j = i + 1; j < v.length && t[j] - t[i] <= w / 2; j++) { s += v[j]; k++; }
    return x - s / k;
  });
}

/** Height from pressure when the phone gave no relative altitude: the hypsometric step from the visit's first second. */
const heightFrom = (hpa, p0) => -8434 * Math.log(hpa / p0);

/** Bilinear lidar ground at a web-mercator point, NaN off the grid or on a roof. */
function groundAt(res, x, y) {
  const g = res.grid, [fc, fr] = g.toCell(x, y);
  const c = fc - 0.5, r = fr - 0.5, c0 = Math.floor(c), r0 = Math.floor(r);
  if (c0 < 0 || r0 < 0 || c0 + 1 >= g.W || r0 + 1 >= g.H) return NaN;
  const at = (rr, cc) => (res.wall[rr * g.W + cc] ? NaN : res.z[rr * g.W + cc]);
  const dc = c - c0, dr = r - r0;
  return at(r0, c0) * (1 - dc) * (1 - dr) + at(r0, c0 + 1) * dc * (1 - dr) + at(r0 + 1, c0) * (1 - dc) * dr + at(r0 + 1, c0 + 1) * dc * dr;
}

async function main() {
  let have = 0;
  try { have = q('SELECT COUNT(*) AS n FROM shade_baro')[0]?.n || 0; } catch (e) { console.log(`No barometer table yet (${e.message.slice(0, 80)}).`); }
  const spans = q('SELECT session, MIN(t) AS a, MAX(t) AS b FROM shade_fixes GROUP BY session');
  const sessions = pickSessions(spans);
  console.log(`Recordings: ${spans.length} (${sessions.length} after uploads replace the pushes they cover); barometer seconds stored: ${have}.`);
  const withBaro = [];
  for (const s of sessions) {
    const n = q(`SELECT COUNT(*) AS n FROM shade_baro WHERE session = '${esc(s.session)}'`)[0]?.n || 0;
    if (n) withBaro.push({ ...s, n });
  }
  console.log(`Recordings with the barometer: ${withBaro.length}.\n`);

  const io = nodeIo();
  const done = [];
  let k = 0, walked = 0;
  for (const s of withBaro) {
    const fixes = [], baro = new Map(), tilt = new Map();
    for (let a = s.a; a <= s.b; a += 7200000) {
      const w = `session = '${esc(s.session)}' AND t >= ${a} AND t < ${a + 7200000}`;
      fixes.push(...q(`SELECT t, lat, lng, acc, speed FROM shade_fixes WHERE ${w} ORDER BY t`));
      for (const r of q(`SELECT t, hpa, alt FROM shade_baro WHERE ${w} ORDER BY t`)) baro.set(Math.floor(r.t / 1000), r);
      for (const r of q(`SELECT t, nz FROM shade_orient WHERE ${w} ORDER BY t`)) tilt.set(Math.floor(r.t / 1000), r.nz);
    }
    const cuts = q(`SELECT t0, t1 FROM shade_cuts WHERE session = '${esc(s.session)}'`);
    const track = fixes.filter((f) => !cuts.some((c) => f.t >= c.t0 && f.t <= c.t1))
      .map((f) => ({ t: f.t, lat: f.lat, lng: f.lng, acc: f.acc, speed: f.speed ?? 0 }));
    for (const visit of splitVisits(track)) {
      k++;
      const pace = med(visit.map((f) => f.speed).filter((v) => v > 0.5));
      if (!(pace >= SPREADER_SPEED)) { walked++; console.log(`#${k}: median ${Number.isFinite(pace) ? pace.toFixed(1) : '-'} m/s -- carried, not on the spreader; skipped`); continue; }
      const pts = visit.filter((f) => (f.acc == null || f.acc <= MAX_ACC) && f.speed <= MAX_SPEED
        && baro.has(Math.floor(f.t / 1000)) && !(tilt.has(Math.floor(f.t / 1000)) && tilt.get(Math.floor(f.t / 1000)) < FLAT));
      if (pts.length < 60) { console.log(`#${k}: ${pts.length} usable seconds with the barometer -- too few`); continue; }
      // the lidar under the visit
      const lat = med(pts.map((p) => p.lat)), lng = med(pts.map((p) => p.lng));
      const xy = pts.map((p) => toMerc([p.lng, p.lat]));
      const kk = mercScale(lat), pad = PAD / kk;
      const bbox = [Math.min(...xy.map((v) => v[0])) - pad, Math.min(...xy.map((v) => v[1])) - pad, Math.max(...xy.map((v) => v[0])) + pad, Math.max(...xy.map((v) => v[1])) + pad];
      if ((bbox[2] - bbox[0]) * kk > 400 || (bbox[3] - bbox[1]) * kk > 400) { console.log(`#${k}: spans over 400 m -- skipped`); continue; }
      try {
        const cloud = (await lidarAt(lng, lat)).clouds?.[0];
        if (!cloud) { console.log(`#${k}: no public lidar`); continue; }
        const { cols } = await pointsIn(cloud.url, bbox, io);
        const res = analyse(cols, bbox, lat, { epoch: cloud.epoch, nullRuns: 0 });
        /* The barometer can lag the GPS (or lead it): try each lag up to 15 s and keep the one that fits best. */
        const kk1 = 1 / kk;
        const series = (lag) => {
          const t = [], h = [], g = [], slope = [], acc = [];
          const b0 = baro.get(Math.floor(pts[0].t / 1000) + lag);
          if (!b0) return null;
          for (let i = 0; i < pts.length; i++) {
            const b = baro.get(Math.floor(pts[i].t / 1000) + lag);
            if (!b) continue;
            const [x, y] = xy[i], gz = groundAt(res, x, y);
            if (!Number.isFinite(gz)) continue;
            const sx = (groundAt(res, x + kk1, y) - groundAt(res, x - kk1, y)) / 2, sy = (groundAt(res, x, y + kk1) - groundAt(res, x, y - kk1)) / 2;
            t.push((pts[i].t - pts[0].t) / 1000);
            h.push((Number.isFinite(b.alt) ? b.alt : heightFrom(b.hpa, b0.hpa)) - HOPPER_M);
            g.push(gz); slope.push(Math.hypot(sx, sy)); acc.push(pts[i].acc ?? NaN);
          }
          return t.length >= 60 ? { t, h, g, slope, acc } : null;
        };
        let best = null;
        for (let lag = -15; lag <= 15; lag++) {
          const sr = series(lag);
          if (!sr) continue;
          const fit = detrend(sr.t, sr.h, sr.g);
          const sd = Math.sqrt(fit.resid.reduce((s2, v) => s2 + v * v, 0) / fit.resid.length);
          if (!best || sd < best.sd) best = { lag, sr, fit, sd };
        }
        if (!best) { console.log(`#${k}: under 60 seconds over open lidar ground`); continue; }
        const { t, h, g, slope, acc } = best.sr, fit = best.fit, sd = best.sd;
        const lag0 = series(0), sd0 = lag0 ? (() => { const f0 = detrend(lag0.t, lag0.h, lag0.g); return Math.sqrt(f0.resid.reduce((s2, v) => s2 + v * v, 0) / f0.resid.length); })() : NaN;
        const r = corr(g, h.map((v, i) => v - fit.a - fit.b * t[i]));
        const rb = corr(highPass(t, h), highPass(t, g));
        const relief = pct(g, 0.95) - pct(g, 0.05);
        /* What the GPS alone would cost: the ground's slope times how far off the fix may be. And the
           residual where the ground is nearly flat (under 3%), where a wrong fix costs almost nothing --
           the part of the leftover that is the barometer's own. 5 s smoothing takes out its sample noise. */
        const gpsCost = Math.sqrt(med(slope.map((s2, i) => (s2 * (Number.isFinite(acc[i]) ? acc[i] : 4)) ** 2)));
        const smooth = h.map((_, i) => { let s2 = 0, n2 = 0; for (let j = i; j >= 0 && t[i] - t[j] <= 2.5; j--) { s2 += h[j] - g[j]; n2++; } for (let j = i + 1; j < h.length && t[j] - t[i] <= 2.5; j++) { s2 += h[j] - g[j]; n2++; } return s2 / n2 - fit.a - fit.b * t[i]; });
        const flatIdx = slope.map((s2, i) => (s2 < 0.03 ? i : -1)).filter((i) => i >= 0);
        const flatSd = flatIdx.length >= 30 ? Math.sqrt(flatIdx.reduce((s2, i) => s2 + smooth[i] ** 2, 0) / flatIdx.length) : NaN;
        const steepIdx = slope.map((s2, i) => (s2 >= 0.08 ? i : -1)).filter((i) => i >= 0);
        const steepSd = steepIdx.length >= 30 ? Math.sqrt(steepIdx.reduce((s2, i) => s2 + smooth[i] ** 2, 0) / steepIdx.length) : NaN;
        const row = { seconds: t.length, minutes: t[t.length - 1] / 60, relief, sd, sd0, lag: best.lag, r, rb, drift: fit.b * 60, gpsAcc: med(pts.map((p) => p.acc)), gpsCost, flatSd, flatN: flatIdx.length, steepSd, steepN: steepIdx.length, flight: cloud.name };
        done.push(row);
        const cm = (v) => (Number.isFinite(v) ? (v * 100).toFixed(0) : '-');
        console.log(`#${k}: ${row.seconds} s over ${row.minutes.toFixed(0)} min; lidar relief ${cm(relief)} cm; after offset and drift (${(row.drift * 100).toFixed(1)} cm/min): residual ${cm(sd)} cm (no lag ${cm(sd0)}, best lag ${row.lag} s), r ${r.toFixed(2)}, r bumps ${rb.toFixed(2)}; GPS median ${row.gpsAcc?.toFixed?.(1) ?? '-'} m, worth ${cm(gpsCost)} cm on this slope; smoothed residual on flat ground ${cm(flatSd)} cm (${flatIdx.length} s), on 8%+ slopes ${cm(steepSd)} cm (${steepIdx.length} s)`);
      } catch (e) {
        console.log(`#${k}: failed -- ${String(e.message).replace(/-?\d+\.\d{3,}/g, '…')}`);
      }
    }
  }

  console.log('\n==============================================================');
  console.log(`THE OWNER'S BAROMETER AGAINST THE LIDAR GROUND: ${done.length} visit(s) compared (${walked} carried visit(s) left out)`);
  if (!done.length) {
    console.log(have ? '  Nothing to compare yet: no spreader visit with the barometer has 60 usable seconds over open lidar ground.'
      : '  Nothing to compare yet: no barometer stored. Re-upload the old exports on the shade readings page (zip upload; nothing doubles), then run this again.');
    return;
  }
  console.log(`  lidar relief along a pass: median ${(med(done.map((d) => d.relief)) * 100).toFixed(0)} cm (10th-90th ${(pct(done.map((d) => d.relief), 0.1) * 100).toFixed(0)}-${(pct(done.map((d) => d.relief), 0.9) * 100).toFixed(0)})`);
  console.log(`  residual after offset and drift: median ${(med(done.map((d) => d.sd)) * 100).toFixed(0)} cm (10th-90th ${(pct(done.map((d) => d.sd), 0.1) * 100).toFixed(0)}-${(pct(done.map((d) => d.sd), 0.9) * 100).toFixed(0)})`);
  console.log(`  whole-pass shape, correlation: median ${med(done.map((d) => d.r)).toFixed(2)}; visits at 0.8 or better: ${done.filter((d) => d.r >= 0.8).length} of ${done.length}`);
  console.log(`  short bumps (20 s high-pass), correlation: median ${med(done.map((d) => d.rb)).toFixed(2)}; at 0.5 or better: ${done.filter((d) => d.rb >= 0.5).length} of ${done.length}`);
  console.log(`  best barometer lag: ${done.map((d) => `${d.lag} s`).join(', ')}; residual at no lag: median ${(med(done.map((d) => d.sd0)) * 100).toFixed(0)} cm`);
  console.log(`  what the GPS error alone costs on these slopes: median ${(med(done.map((d) => d.gpsCost)) * 100).toFixed(0)} cm`);
  console.log(`  smoothed residual on flat ground (under 3%): median ${(med(done.map((d) => d.flatSd)) * 100).toFixed(0)} cm; on 8%+ slopes: median ${(med(done.map((d) => d.steepSd)) * 100).toFixed(0)} cm`);
  console.log(`  weather drift: median ${(med(done.map((d) => Math.abs(d.drift))) * 100).toFixed(1)} cm/min`);
}

if (process.argv[1] && process.argv[1].endsWith('baro.mjs')) main().catch((e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });
