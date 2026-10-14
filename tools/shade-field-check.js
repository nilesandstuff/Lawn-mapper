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

const ZONE = 'America/New_York';
const PHONE_M = 1.27, EDGE_M = 25, NEAR_M = 3;
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
function tiles(u, cellM = 120) {
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
    const row = { t: s.t, lux: s.lux, gain: sunGain(sunOffFace(s.up, sun.elevation, sun.azimuth)), T: full[0], Ton: beam(onModel, 0, 0), Toff: beam(offModel, 0, 0), cls: confidence(full, bld) };
    const te = truckEffect(s, trucks, sun, { phoneM: PHONE_M });
    if (te === 'near') { why.truckNear++; continue; }
    if (te === 'shadow') { why.truckShadow++; truckShadowRows.push(row); continue; }
    const heading = mount && s.face != null ? (s.face + mount.offset) % 360 : s.heading;
    if (operatorShadow(heading, sun.azimuth)) { why.behind++; continue; }
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
    why, faint, clear: so.clear, sunLux: so.sunLux, shadeLux: so.shadeLux, scored, tally: tally(scored), leafTest, truckShadow: { n: tsN, dark: tsDark },
  };
}

export async function fieldCheck(day) {
  const t0 = localMs('0:00', Date.parse(`${day}T12:00:00Z`)), t1 = t0 + 86400000;
  const sessions = query(`SELECT DISTINCT session FROM shade_fixes WHERE t >= ${t0} AND t < ${t1}`).map((r) => String(r.session).replace(/'/g, "''"));
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
  const mount = compassOffset(visits.flatMap((v) => usable(v)));
  const out = [`Field check ${day}: ${visits.length} visits; the phone's mounting angle ${mount ? `${Math.round(mount.offset)} degrees (steady to ${Math.round(mount.spread)}, from ${mount.n} straight-line readings)` : 'not found (GPS heading used)'}.`];
  const all = [];
  const leafAll = { n: 0, calendar: 0, on: 0, off: 0 };
  let tsN = 0, tsDark = 0;
  for (const v of visits) {
    let r;
    try { r = await visitCheck(v, mount && { ...mount, day: true }); } catch (e) { r = { skip: `error: ${e.message}` }; }
    const head = `${hm(v[0].t)}-${hm(v[v.length - 1].t)}`;
    if (r.skip) { out.push(`\n${head}: skipped (${r.skip})`); continue; }
    all.push(...r.scored);
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
    }
  }
  const T = tally(all), n = all.length, ag = all.filter((x) => x.modelSun === x.phoneSun).length;
  out.push(`\nDAY: ${n} readings scored, agree ${ag} (${pct(ag, n)}).`);
  out.push(`  where the model is sure: ${classLine(T)}`);
  out.push(`  open = sure of sun; building = behind a building (no leaves involved); tree = deep in a crown's shade; edge = unsure.`);
  out.push(`  where the leaves decide (${leafAll.n} readings): the phone agrees with the calendar's leaves at ${leafAll.calendar}, full leaves at ${leafAll.on}, bare trees at ${leafAll.off}.`);
  out.push(`  the truck's shadow: the phone read ${tsDark} of ${tsN} judged readings there as shade.`);
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const day = process.env.DAY || new Date().toLocaleDateString('en-CA', { timeZone: ZONE });
  console.log(await fieldCheck(day));
}
