/**
 * THE OWNER'S FIELD READINGS AGAINST THE MODEL, A DAY AT A TIME (features
 * session, 2026-10-13). What the check view does for one visit, for every
 * visit of a day, in node: the same lidar and model (tools/shade-site.js),
 * the same leaf share for the date, the sun placed for each reading's time
 * and place, the same judging (each reading at its own angle to the sun),
 * the truck and the operator's shadow left out. Then the question the owner
 * asked: where the model should be CERTAIN, does the phone agree?
 *
 *   open      every point within 3 m of the reading gets at least 0.8 of the
 *             beam (GPS error covered): the model is sure of sun
 *   building  every point within 3 m is behind a building (trees ignored):
 *             sure of shade, with no leaves to get wrong
 *   tree      every point within 3 m gets under 0.2, and no building is in
 *             the way: tree shade (the leaves this week matter)
 *   edge      the rest: shadow edges, thin crowns -- the model unsure
 *
 * Counts and shares only: the repository is public and these are tracks
 * over customers' lawns, so no place, name or coordinate is printed.
 *
 *   DAY=2026-10-13 node tools/shade-field-check.js   (workflow 35, check: yes)
 */

import { query } from './corpus-db.js';
import { shadeSite } from './shade-site.js';
import { localMs } from './shade-readings.js';
import { joinTrack, usable, splitVisits, compassOffset, operatorShadow, sunOffFace, sunGain, sunOrShadeAround, metersBetween } from '../public/shade/truth.js';
import { findTrucks, truckEffect } from '../public/shade/truck.js';
import { sunAt } from '../public/shade/sun.js';
import { transmittance, groundAt } from '../public/shade/rays.js';
import { muWithLeaves, leafCalendar } from '../public/shade/seasonal.js';
import { climateAt } from '../worker/src/shade.js';
import { canopyParts, rayParts } from './shade-ray-check.js';

const ZONE = 'America/New_York';
const PHONE_M = 1.27, EDGE_M = 25, NEAR_M = 3;
/* GPS offsets tried, meters east and north (owner, 2026-10-14: is the track where the model is?). */
export const OFFSETS = [];
for (let n = -4; n <= 4; n++) for (let e = -4; e <= 4; e++) OFFSETS.push([e, n]);
const hm = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });

/** 0-based day of the year, 29 Feb folded onto 28 Feb (as the light worker). */
function dayOfYear(ms) {
  const d = new Date(ms), y = d.getUTCFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const doy = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000);
  return leap && doy >= 59 ? Math.max(58, doy - 1) : doy;
}

/** The model's class for a reading from the beam at its spot and around it (see above). */
export function confidence(full, bld) {
  if (full.every((t) => t >= 0.8)) return 'open';
  if (bld.every((t) => t <= 0.2)) return 'building';
  if (full.every((t) => t <= 0.2) && bld.every((t) => t >= 0.8)) return 'tree';
  return 'edge';
}

/** Agreement counts by class: { cls: { n, agree, modelSun, phoneSun } }. */
export function tally(rows) {
  const out = {};
  for (const r of rows) {
    const c = (out[r.cls] ||= { n: 0, agree: 0, modelSun: 0, phoneSun: 0, tooBright: 0, tooDark: 0 });
    c.n++;
    if (r.modelSun === r.phoneSun) c.agree++;
    else if (r.modelSun) c.tooBright++;
    else c.tooDark++;
    if (r.modelSun) c.modelSun++;
    if (r.phoneSun) c.phoneSun++;
  }
  return out;
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
export function classLine(t) {
  return ['open', 'building', 'tree', 'edge'].map((k) => {
    const c = t[k];
    return c ? `${k} ${c.agree}/${c.n} (${pct(c.agree, c.n)}${c.n > c.agree ? `; misses: model too bright ${c.tooBright}, too dark ${c.tooDark}` : ''})` : `${k} 0`;
  }).join(' | ');
}

/** Readings grouped into squares `cellM` across, each modelled on its own (a long visit down a street). */
export function tiles(u, cellM = 120) {
  const lat0 = u[0].lat, k = 111195, kx = k * Math.cos((lat0 * Math.PI) / 180);
  const by = new Map();
  for (const s of u) {
    const key = `${Math.floor((s.lng * kx) / cellM)},${Math.floor((s.lat * k) / cellM)}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(s);
  }
  return [...by.values()].map((list) => {
    const [i, j] = [Math.floor((list[0].lng * kx) / cellM), Math.floor((list[0].lat * k) / cellM)];
    return { lng: ((i + 0.5) * cellM) / kx, lat: ((j + 0.5) * cellM) / k, halfM: cellM / 2 + 50, list };
  });
}

export async function visitCheck(visit, dayMount) {
  const trucks = findTrucks(visit);
  const u = usable(visit);
  if (u.length < 20) return { skip: `${u.length} usable readings` };
  /* This visit's own mounting angle first: the phone is set down afresh at every stop. */
  const mount = compassOffset(u) || dayMount;
  const why = { edge: 0, truckNear: 0, truckShadow: 0, behind: 0 };
  const rows = [], truckShadowRows = [];
  let flight = null, flightEnd = null, leaf = 1;
  for (const tile of tiles(u)) {
    const site = await shadeSite(tile.lng, tile.lat, { halfM: tile.halfM });
    if (!site) continue;
    const got = await scoreTile(site, tile, trucks, mount, why, rows, truckShadowRows);
    ({ flight, flightEnd, leaf } = got);
  }
  if (!rows.length && !truckShadowRows.length) return { skip: 'no lidar or no readings inside it' };
  rows.sort((a, b) => a.t - b.t);
  return judgeVisit(visit, u, trucks, mount, why, rows, truckShadowRows, { flight, flightEnd, leaf });
}

async function scoreTile(site, tile, trucks, mount, why, rows, truckShadowRows) {
  const { lng, lat } = tile;
  const flight = site.cloud.unit?.season || null;
  const climate = await climateAt(lng, lat).catch(() => null);
  const calendar = climate?.tMean ? leafCalendar(climate.tMean) : null;
  const seasonal = calendar && (flight === 'off' || flight === 'mixed');
  const leaf = seasonal ? calendar.share(dayOfYear(tile.list[0].t)) : 1;
  const model = { ...site.model, mu: seasonal ? muWithLeaves(site.season, leaf) : site.model.mu };
  const { w, h, nz } = model;
  const bmu = new Float32Array(model.mu.length);
  for (let k = 0; k < w * h; k++) if (site.season.kind[k] === 1) for (let l = 0; l < nz; l++) bmu[k * nz + l] = model.mu[k * nz + l];
  const bmodel = { ...model, mu: bmu };
  /* The same readings with the leaves all on and all off, to test the
     calendar's share against what the phone saw (owner, 2026-10-13: most
     trees still hold most of their leaves; dropping has just begun). */
  const onModel = seasonal ? { ...model, mu: site.season.muOn } : model;
  const offModel = seasonal ? { ...model, mu: site.season.muOff } : model;
  /* Where the shade comes from, and the what-ifs (shade-ray-check.js;
     owner, 2026-10-14: is the leaf filling lowering the crowns?). */
  const cp = canopyParts(site, model.mu);
  const nlModel = { ...model, mu: cp.noLowLeaves }, nfModel = { ...model, mu: cp.noFill }, nnModel = { ...model, mu: cp.neither };
  const c7Model = { ...model, mu: cp.clumped7 }, c5Model = { ...model, mu: cp.clumped5 };
  const R = Math.PI / 180;
  const ring = [[0, 0], ...[...Array(8)].map((_, i) => [NEAR_M * Math.cos((i * Math.PI) / 4), NEAR_M * Math.sin((i * Math.PI) / 4)])];
  for (const s of tile.list) {
    const sun = sunAt(s.lat, s.lng, s.t);
    if (sun.elevation <= 2) continue;
    const [gx, gy] = site.cellOf(s.lng, s.lat);
    if (Math.min(gx, gy, w - gx, h - gy) < EDGE_M) { why.edge++; continue; }
    const ce = Math.cos(sun.elevation * R);
    const dir = [Math.sin(sun.azimuth * R) * ce, Math.cos(sun.azimuth * R) * ce, Math.sin(sun.elevation * R)];
    const beam = (mdl, dx, dy) => transmittance(mdl, gx + dx, gy - dy, groundAt(mdl, gx + dx, gy - dy) + PHONE_M, dir);
    const full = ring.map(([dx, dy]) => beam(model, dx, dy)), bld = ring.map(([dx, dy]) => beam(bmodel, dx, dy));
    const rp = rayParts(model, cp.parts, gx, gy, groundAt(model, gx, gy) + PHONE_M, dir);
    const row = {
      t: s.t, lux: s.lux, gain: sunGain(sunOffFace(s.up, sun.elevation, sun.azimuth)), T: full[0], Ton: beam(onModel, 0, 0), Toff: beam(offModel, 0, 0), cls: confidence(full, bld),
      Tnl: beam(nlModel, 0, 0), Tnf: beam(nfModel, 0, 0), Tnn: beam(nnModel, 0, 0), Tc7: beam(c7Model, 0, 0), Tc5: beam(c5Model, 0, 0), ray: rp, el: sun.elevation,
      off: Float32Array.from(OFFSETS, ([dx, dy]) => beam(model, dx, dy)), acc: s.acc,
    };
    const te = truckEffect(s, trucks, sun, { phoneM: PHONE_M });
    if (te === 'near') { why.truckNear++; continue; }
    if (te === 'shadow') { why.truckShadow++; truckShadowRows.push(row); continue; }
    const heading = mount && s.face != null ? (s.face + mount.offset) % 360 : s.heading;
    if (operatorShadow(heading, sun.azimuth)) { why.behind++; continue; }
    /* The sun's bearing from straight behind the operator (0 = right behind), for the open misses. */
    row.behindDeg = heading == null ? null : Math.abs(((sun.azimuth - (heading + 180) + 540) % 360) - 180);
    row.speed = s.speed;
    rows.push(row);
  }
  return { flight, flightEnd: site.cloud.unit?.end ?? null, leaf };
}

function judgeVisit(visit, u, trucks, mount, why, rows, truckShadowRows, { flight, flightEnd, leaf }) {
  /* Judged as the check view judges (the truck's readings out); the truck's
     shadow judged alongside the rest, to see whether the phone found it dark. */
  const so = sunOrShadeAround(rows);
  const scored = [];
  rows.forEach((r, i) => { if (so.clear && so.judged[i]) scored.push({ ...r, modelSun: r.T >= 0.5, phoneSun: so.sun[i] }); });
  /* Where the leaves decide (the three canopies disagree), which agrees? */
  const leafy = scored.filter((r) => (r.Ton >= 0.5) !== (r.Toff >= 0.5));
  const leafTest = { n: leafy.length, calendar: leafy.filter((r) => r.modelSun === r.phoneSun).length, on: leafy.filter((r) => (r.Ton >= 0.5) === r.phoneSun).length, off: leafy.filter((r) => (r.Toff >= 0.5) === r.phoneSun).length };
  const whatIf = whatIfs(scored);
  whatIf.lag = lagScan(rows, scored);
  whatIf.offsets = offsetScan(scored);
  whatIf.ceiling = gpsCeiling(scored);
  const both = [...rows, ...truckShadowRows].sort((a, b) => a.t - b.t);
  const sb = sunOrShadeAround(both);
  let tsDark = 0, tsN = 0;
  both.forEach((r, i) => { if (truckShadowRows.includes(r) && sb.clear && sb.judged[i]) { tsN++; if (!sb.sun[i]) tsDark++; } });
  const faint = so.clear ? so.faint.filter(Boolean).length : 0;
  /* The truck: do the anchors at the start and end of a stop agree? */
  const spread = trucks.map((tr) => Math.max(0, ...tr.anchors.map((a) => metersBetween([tr.lat, tr.lng], [a.lat, a.lng]))));
  return {
    t0: visit[0].t, t1: visit[visit.length - 1].t, flight, flightEnd, leaf, mount,
    usable: u.length, trucks: trucks.length, anchors: trucks.reduce((a, tr) => a + tr.anchors.length, 0), spread,
    why, faint, clear: so.clear, sunLux: so.sunLux, shadeLux: so.shadeLux, scored, tally: tally(scored), leafTest, truckShadow: { n: tsN, dark: tsDark }, whatIf,
  };
}

const median = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };

/**
 * The what-ifs over scored readings (shade-ray-check.js): agreement with the
 * model as it is, without leaves below the lowest branch, without the solid
 * fill under dense crowns, and without both; and for the readings the model
 * calls shade and the phone sun, what stopped the light and how high.
 */
export function whatIfs(scored) {
  const agree = (key) => scored.filter((r) => (r[key] >= 0.5) === r.phoneSun).length;
  const dark = scored.filter((r) => !r.modelSun && r.phoneSun && r.ray);
  const share = (p) => median(dark.map((r) => (r.ray.total > 0 ? r.ray.tau[p] / r.ray.total : NaN)));
  return {
    n: scored.length, asIs: agree('T'), noLowLeaves: agree('Tnl'), noFill: agree('Tnf'), neither: agree('Tnn'), clumped7: agree('Tc7'), clumped5: agree('Tc5'),
    /* Through trees (not open, not behind a building), by how high the sun was: a longer slant through the crowns as it drops. */
    byElevation: [[0, 25], [25, 32], [32, 90]].map(([a, b]) => {
      const rs = scored.filter((r) => r.el >= a && r.el < b && r.cls !== 'open' && r.cls !== 'building' && r.ray?.total > 0);
      return { a, b, n: rs.length, asIs: rs.filter((r) => (r.T >= 0.5) === r.phoneSun).length, c7: rs.filter((r) => (r.Tc7 >= 0.5) === r.phoneSun).length, c5: rs.filter((r) => (r.Tc5 >= 0.5) === r.phoneSun).length, tooDark: rs.filter((r) => r.T < 0.5 && r.phoneSun).length, tooBright: rs.filter((r) => r.T >= 0.5 && !r.phoneSun).length };
    }),
    dark: {
      n: dark.length,
      shares: { measured: share('measured'), fill: share('fill'), leafLow: share('leafLow'), leafHigh: share('leafHigh') },
      heightM: median(dark.map((r) => r.ray.heightOver)), distM: median(dark.map((r) => r.ray.distM)), elevation: median(dark.map((r) => r.el)),
      flipNoLow: dark.filter((r) => r.Tnl >= 0.5).length, flipNoFill: dark.filter((r) => r.Tnf >= 0.5).length, flipNeither: dark.filter((r) => r.Tnn >= 0.5).length,
      bareSun: dark.filter((r) => r.Toff >= 0.5).length,
    },
    /* Behind a building, the phone read sun: how bright, against the visit's face-on sun. */
    building: scored.filter((r) => r.cls === 'building' && r.phoneSun).map((r) => r.lux / Math.max(1e-6, r.gain)),
  };
}

/**
 * Agreement with the whole track moved by each of OFFSETS: { counts per
 * offset, n, best: { e, n, agree }, atZero }. A real GPS bias shows as the
 * same best move visit after visit; noise as a scatter of small gains.
 */
export function offsetScan(scored) {
  const counts = OFFSETS.map((_, j) => scored.filter((r) => r.off && (r.off[j] >= 0.5) === r.phoneSun).length);
  const z = OFFSETS.findIndex(([e, n]) => !e && !n);
  let b = z;
  counts.forEach((c, j) => { if (c > counts[b] || (c === counts[b] && Math.hypot(...OFFSETS[j]) < Math.hypot(...OFFSETS[b]))) b = j; });
  return { counts, n: scored.length, atZero: counts[z], best: { e: OFFSETS[b][0], n: OFFSETS[b][1], agree: counts[b] } };
}

/**
 * THE GPS CEILING: if the model were exactly right and the phone's fix were
 * off by GPS error alone (a round Gaussian of sigma m, or each reading's
 * own reported accuracy as a 68% radius), how often would the phone agree
 * with the model at the recorded spot? Per class: { cls: { n, actual,
 * sigma2, sigma3, own } } as shares. Uses the moved-track beams (OFFSETS).
 */
export function gpsCeiling(scored) {
  const zero = OFFSETS.findIndex(([e, n]) => !e && !n);
  const p = (r, sig) => {
    let ws = 0, wsun = 0;
    OFFSETS.forEach(([e, n], j) => { const wt = Math.exp(-(e * e + n * n) / (2 * sig * sig)); ws += wt; if (r.off[j] >= 0.5) wsun += wt; });
    const pSun = wsun / ws, s0 = r.off[zero] >= 0.5;
    return s0 ? pSun : 1 - pSun;
  };
  const out = {};
  for (const r of scored) {
    if (!r.off) continue;
    const c = (out[r.cls] ||= { n: 0, actual: 0, sigma2: 0, sigma3: 0, own: 0, accs: [] });
    c.n++;
    if (r.modelSun === r.phoneSun) c.actual++;
    c.sigma2 += p(r, 2); c.sigma3 += p(r, 3);
    const own = Number.isFinite(r.acc) && r.acc > 0 ? Math.min(6, r.acc / 1.5) : 2;
    c.own += p(r, Math.max(0.5, own));
    if (Number.isFinite(r.acc)) c.accs.push(r.acc);
  }
  for (const c of Object.values(out)) {
    for (const k of ['actual', 'sigma2', 'sigma3', 'own']) c[k] /= c.n;
    c.accs.sort((a, b) => a - b);
    c.accMedian = c.accs.length ? c.accs[c.accs.length >> 1] : null;
    delete c.accs;
  }
  return out;
}

export function ceilingLine(g) {
  const p = (x) => `${Math.round(100 * x)}%`;
  return `  GPS ceiling (a perfect model read through GPS error): ${['open', 'building', 'tree', 'edge'].filter((k) => g[k]).map((k) => `${k}: actual ${p(g[k].actual)}, ceiling ${p(g[k].own)} at the phone's own accuracy (median ${g[k].accMedian ?? '?'} m), ${p(g[k].sigma2)} at 2 m, ${p(g[k].sigma3)} at 3 m`).join(' | ')}`;
}

/**
 * Open sun the phone read as shade: where the sun stood from behind the
 * operator (degrees, in 30-degree bins from straight behind), its height, and the
 * phone's tilt gain, against the open readings it read as sun. A shadow of
 * the operator wider than the 35-degree rule shows as misses piling up just
 * past 35 degrees.
 */
export function openMisses(scored) {
  const open = scored.filter((r) => r.cls === 'open');
  const bin = (r) => (r.behindDeg == null ? 'no heading' : `${Math.floor(r.behindDeg / 15) * 15}-${Math.floor(r.behindDeg / 15) * 15 + 15}`);
  const t = {};
  for (const r of open) { const b = (t[bin(r)] ||= { n: 0, shade: 0 }); b.n++; if (!r.phoneSun) b.shade++; }
  const med = (a) => { const x = a.filter(Number.isFinite).sort((p, q) => p - q); return x.length ? x[x.length >> 1] : NaN; };
  const miss = open.filter((r) => !r.phoneSun), hit = open.filter((r) => r.phoneSun);
  return { n: open.length, misses: miss.length, byBehind: t, gainMiss: med(miss.map((r) => r.gain)), gainHit: med(hit.map((r) => r.gain)), elMiss: med(miss.map((r) => r.el)), elHit: med(hit.map((r) => r.el)), speedMiss: med(miss.map((r) => r.speed)), speedHit: med(hit.map((r) => r.speed)) };
}

export function openMissLine(o) {
  if (!o?.n) return null;
  const order = Object.keys(o.byBehind).sort((a, b) => (parseInt(a, 10) || 999) - (parseInt(b, 10) || 999));
  return `  open sun read as shade: ${o.misses} of ${o.n}; by the sun's angle from straight behind you (degrees: shade/all): ${order.map((k) => `${k} ${o.byBehind[k].shade}/${o.byBehind[k].n}`).join(', ')}; median tilt gain ${o.gainMiss?.toFixed(2)} (misses) vs ${o.gainHit?.toFixed(2)}, sun ${Math.round(o.elMiss)} vs ${Math.round(o.elHit)} degrees, speed ${o.speedMiss?.toFixed(1)} vs ${o.speedHit?.toFixed(1)} m/s`;
}

/**
 * A LAG between the light and the GPS: each scored reading's phone verdict
 * against the model at the track's position k seconds later (k < 0:
 * earlier), for k in -3..3. A lag moves readings along the way the mower
 * goes, which a whole-track move east or north cancels out on a back-and-
 * forth pattern; this does not. { k: { n, agree } }, edge readings only too.
 */
export function lagScan(rows, scored, ks = [-3, -2, -1, 0, 1, 2, 3]) {
  const at = new Map(rows.map((r) => [Math.round(r.t / 1000), r.T]));
  const out = {};
  for (const k of ks) {
    const o = (out[k] = { n: 0, agree: 0, edgeN: 0, edgeAgree: 0 });
    for (const r of scored) {
      const T = at.get(Math.round(r.t / 1000) + k);
      if (T == null) continue;
      const ok = (T >= 0.5) === r.phoneSun;
      o.n++; if (ok) o.agree++;
      if (r.cls === 'edge') { o.edgeN++; if (ok) o.edgeAgree++; }
    }
  }
  return out;
}

export function lagLine(l) {
  if (!l) return null;
  const p = (a, b) => (b ? `${Math.round((1000 * a) / b) / 10}%` : '-');
  return `  light against the track k seconds later: ${Object.entries(l).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, o]) => `${k > 0 ? '+' : ''}${k}s ${p(o.agree, o.n)} (edges ${p(o.edgeAgree, o.edgeN)})`).join(', ')}`;
}

export function offsetLine(o) {
  if (!o?.n) return null;
  const { e, n, agree } = o.best;
  return `  GPS moved to fit best: ${!e && !n ? 'not moved (as recorded fits best)' : `${Math.abs(e)} m ${e >= 0 ? 'east' : 'west'}, ${Math.abs(n)} m ${n >= 0 ? 'north' : 'south'}`}: agree ${agree}/${o.n} against ${o.atZero} as recorded`;
}

export function whatIfLines(w, sunLux) {
  if (!w?.n) return [];
  const p = (x) => (Number.isFinite(x) ? `${Math.round(100 * x)}%` : '-');
  const ol = offsetLine(w.offsets);
  const out = ol ? [ol] : [];
  if (w.ceiling) out.push(ceilingLine(w.ceiling));
  if (w.openMiss) { const l = openMissLine(w.openMiss); if (l) out.push(l); }
  if (w.lag) { const l = lagLine(w.lag); if (l) out.push(l); }
  out.push(`  what-ifs: agree as modelled ${w.asIs}/${w.n}; no leaves below the lowest branch ${w.noLowLeaves}; no solid fill under dense crowns ${w.noFill}; neither ${w.neither}; crowns clumped (x0.7 per meter) ${w.clumped7}, (x0.5) ${w.clumped5}`);
  const eb = w.byElevation.filter((b) => b.n);
  if (eb.length) out.push(`  through trees, by sun height: ${eb.map((b) => `${b.a}-${b.b} deg: agree ${b.asIs}/${b.n} (too dark ${b.tooDark}, too bright ${b.tooBright}; clumped x0.7 ${b.c7}, x0.5 ${b.c5})`).join(' | ')}`);
  const d = w.dark;
  if (d.n) {
    out.push(`  model shade where the phone read sun (${d.n}): light stopped a median ${Number.isFinite(d.heightM) ? d.heightM.toFixed(1) : '?'} m up, ${Number.isFinite(d.distM) ? Math.round(d.distM) : '?'} m away, sun ${Number.isFinite(d.elevation) ? Math.round(d.elevation) : '?'} degrees up;`);
    out.push(`    of the shade on those rays (median shares): laser-measured ${p(d.shares.measured)}, fill under dense crowns ${p(d.shares.fill)}, leaves below the lowest branch ${p(d.shares.leafLow)}, leaves among the branches ${p(d.shares.leafHigh)}`);
    out.push(`    turned to sun by: no low leaves ${d.flipNoLow}, no fill ${d.flipNoFill}, neither ${d.flipNeither}, bare trees ${d.bareSun}`);
  }
  if (w.building.length && sunLux) {
    const r = w.building.map((x) => x / sunLux).sort((a, b) => a - b);
    out.push(`  behind a building yet read as sun (${r.length}): face-on brightness ${p(r[0])}-${p(r[r.length - 1])} of full sun, median ${p(r[r.length >> 1])}`);
  }
  return out;
}

/**
 * The recordings to use, from [{ session, a, b }] (first and last fix): an
 * uploaded export ("upload ...") wins over a pushed recording it overlaps --
 * the owner re-uploads a day's backups so its light is stored the new way
 * (each second's median and brightest sample), and the same stops must not
 * count twice.
 */
export function pickSessions(spans) {
  const up = spans.filter((r) => /^upload /.test(String(r.session)));
  return spans.filter((r) => /^upload /.test(String(r.session)) || !up.some((u) => u.a <= r.b && r.a <= u.b));
}

/** A day's visits from the database, in time order (joined tracks, split at the truck). */
export async function loadVisits(day) {
  const t0 = localMs('0:00', Date.parse(`${day}T12:00:00Z`)), t1 = t0 + 86400000;
  const spans = query(`SELECT session, MIN(t) AS a, MAX(t) AS b FROM shade_fixes WHERE t >= ${t0} AND t < ${t1} GROUP BY session`);
  const sessions = pickSessions(spans).map((r) => String(r.session).replace(/'/g, "''"));
  const visits = [];
  for (const s of sessions) {
    const fix = [], lux = [], orient = [];
    for (let a = t0; a < t1; a += 7200000) {
      const w = `session = '${s}' AND t >= ${a} AND t < ${a + 7200000}`;
      fix.push(...query(`SELECT t, lat, lng, acc, speed, bearing FROM shade_fixes WHERE ${w} ORDER BY t`).map((r) => [r.t, r.lat, r.lng, r.acc, r.speed, r.bearing]));
      if (!fix.length) continue;
      lux.push(...query(`SELECT t, lux FROM shade_lux WHERE ${w} ORDER BY t`).map((r) => [r.t, r.lux]));
      orient.push(...query(`SELECT t, nx, ny, nz, head FROM shade_orient WHERE ${w} ORDER BY t`).map((r) => [r.t, r.nx, r.ny, r.nz, r.head]));
    }
    visits.push(...splitVisits(joinTrack(fix, lux, { orient })));
  }
  visits.sort((a, b) => a[0].t - b[0].t);
  /* Flecks: seconds whose brightest sample was over 3x their median and
     bright (over 10,000 lux) -- recordings stored since 2026-10-14 only. */
  const inList = sessions.map((x) => `'${x}'`).join(',') || "''";
  let flecks = null;
  try { flecks = query(`SELECT COUNT(lux_max) AS n, SUM(CASE WHEN lux_max > 3 * lux AND lux_max > 10000 THEN 1 ELSE 0 END) AS f FROM shade_lux WHERE session IN (${inList}) AND t >= ${t0} AND t < ${t1}`)[0]; } catch { /* no column yet */ }
  visits.flecks = flecks;
  return visits;
}

export async function fieldCheck(day) {
  const visits = await loadVisits(day);
  const mount = compassOffset(visits.flatMap((v) => usable(v)));
  const fl = visits.flecks;
  const out = [`Field check ${day}: ${visits.length} visits; ${fl?.n ? `flecks of sun (a second's brightest sample over 3x its median, over 10,000 lux): ${fl.f} of ${fl.n} seconds;` : 'light stored as one mean per second (no fleck data);'} the phone's mounting angle ${mount ? `${Math.round(mount.offset)} degrees (steady to ${Math.round(mount.spread)}, from ${mount.n} straight-line readings)` : 'not found (GPS heading used)'}.`];
  const all = [];
  const dayLag = {};
  const leafAll = { n: 0, calendar: 0, on: 0, off: 0 };
  let tsN = 0, tsDark = 0;
  for (const v of visits) {
    let r;
    try { r = await visitCheck(v, mount && { ...mount, day: true }); } catch (e) { r = { skip: `error: ${e.message}` }; }
    const head = `${hm(v[0].t)}-${hm(v[v.length - 1].t)}`;
    if (r.skip) { out.push(`\n${head}: skipped (${r.skip})`); continue; }
    all.push(...r.scored);
    for (const [k, o] of Object.entries(r.whatIf?.lag || {})) { const d = (dayLag[k] ||= { n: 0, agree: 0, edgeN: 0, edgeAgree: 0 }); for (const q of Object.keys(d)) d[q] += o[q]; }
    for (const k of Object.keys(leafAll)) leafAll[k] += r.leafTest[k];
    tsN += r.truckShadow.n; tsDark += r.truckShadow.dark;
    const tt = r.scored.length, ag = r.scored.filter((x) => x.modelSun === x.phoneSun).length;
    out.push(`\n${head}: ${r.usable} readings; phone on the hopper at ${r.mount ? `${Math.round(r.mount.offset)} degrees${r.mount.day ? ' (the day\'s fit)' : ''}` : '? (GPS heading used)'}; lidar ${r.flight || '?'} flight to ${r.flightEnd ? new Date(r.flightEnd).toISOString().slice(0, 7) : '?'}, leaves ${Math.round(100 * r.leaf)}% on`);
    out.push(`  truck: ${r.trucks} spot${r.trucks === 1 ? '' : 's'} from ${r.anchors} anchor${r.anchors === 1 ? '' : 's'}${r.spread.length ? ` (anchors within ${r.spread.map((m) => m.toFixed(1)).join(', ')} m of their spot)` : ''}; left out ${r.why.truckNear} beside it, ${r.why.truckShadow} in its shadow (the phone read ${r.truckShadow.n ? `${r.truckShadow.dark} of ${r.truckShadow.n} of those as shade` : 'none of those judged'})`);
    out.push(`  also out: ${r.why.behind} your shadow, ${r.why.edge} near the model's edge, ${r.faint} face turned too far`);
    out.push(r.clear
      ? `  scored ${tt}: agree ${ag} (${pct(ag, tt)}); face-on sun ${Math.round(r.sunLux).toLocaleString('en-US')}, shade ${Math.round(r.shadeLux).toLocaleString('en-US')}`
      : '  no clear split into sun and shade: not scored');
    if (tt) {
      out.push(`  by how sure the model is: ${classLine(r.tally)}`);
      const tr = r.tally.tree;
      if (tr) out.push(`    tree shade: the phone read sun at ${tr.phoneSun} of ${tr.n} (leaves gone, or the crown thinner than the model)`);
      const L = r.leafTest;
      if (L.n) out.push(`  where the leaves decide (${L.n} readings): the phone agrees with the calendar's ${Math.round(100 * r.leaf)}% leaves at ${L.calendar}, with full leaves at ${L.on}, with bare trees at ${L.off}`);
      out.push(...whatIfLines(r.whatIf, r.sunLux));
    }
  }
  const T = tally(all), n = all.length, ag = all.filter((x) => x.modelSun === x.phoneSun).length;
  const wDay = whatIfs(all);
  wDay.lag = dayLag;
  wDay.offsets = offsetScan(all);
  wDay.ceiling = gpsCeiling(all);
  wDay.openMiss = openMisses(all);
  out.push(`\nDAY: ${n} readings scored, agree ${ag} (${pct(ag, n)}).`);
  out.push(`  where the model is sure: ${classLine(T)}`);
  out.push(`  open = sure of sun; building = behind a building (no leaves involved); tree = deep in a crown's shade; edge = unsure.`);
  out.push(`  where the leaves decide (${leafAll.n} readings): the phone agrees with the calendar's leaves at ${leafAll.calendar}, full leaves at ${leafAll.on}, bare trees at ${leafAll.off}.`);
  out.push(`  the truck's shadow: the phone read ${tsDark} of ${tsN} judged readings there as shade.`);
  out.push(...whatIfLines({ ...wDay, building: [] }, null));
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const day = process.env.DAY || new Date().toLocaleDateString('en-CA', { timeZone: ZONE });
  console.log(await fieldCheck(day));
}
