/**
 * The low-spot map and the watering plan for one property, off the page's
 * thread (water session): reading a cloud and running ten years of daily
 * water balance take a phone several seconds each.
 *
 * In:  { site }                          -> progress, then { done } (the low-spot map), then
 *                                           { plan } (the watering plan), or { error } / { planError }
 *      { replan: { topsoil, downspouts, gutters } } -> { plan } again, from what is kept here
 *
 * The worker keeps the lot (the analysis, its soil and its weather) between
 * messages, so a downspout tapped on the page is a few seconds' work, not a
 * re-read of the survey.
 */

import { workerIo } from '/lib/browser-io.js';
import { runSite } from '/lib/site.js';
import { soilFor, sdaPost } from '/lib/soil.js';
import { typicalYears, thisWeek, attachStationHours, soilDaysOver } from '/lib/weather.js';
import { heatOfMonth, surfaceOfMonth, stressByMonth } from '/lib/heat.js';
import { simulate } from '/lib/balance.js';
import { ra, rsFromCover, dayOfYear } from '/lib/et.js';
import { waterPlan } from '/lib/plan.js';
import { demAround, terrain, hillside, RADIUS_M } from '/lib/upslope.js';
import { placeSoils, twiForGrid } from '/lib/soilplace.js';
import { streamsNear, floodNear, streamReading, waterNear } from '/lib/streams.js';
import { waterOnGround, waterLevels, burnedTerrain, handGrid, demCell } from '/lib/groundwater.js';
import { powerUrl, typicalYear, growingSeason, SEASON_GP } from '/lib/shade/climate.js';
import { onePass } from '/lib/shade/passes.js';
import { polygonsOf } from '/lib/geo.js';
import { erasedOn } from '/lib/leaf.js';
import { fenceRadiation } from '/lib/fenceheat.js';
import { localWind, stationRain } from '/lib/wind.js';
import { pointsIn } from '/lib/ept.js';
import { overtureFor } from '/lib/overture.js';
import { obstacleGrid, nearHeights, windGrid, coverWithin } from '/lib/obstacles.js';
import { shelterByDirection, monthlyShelter, calibrate } from '/lib/shelter.js';
import { windShare } from '/lib/balance.js';
import { leafCalendar } from '/lib/shade/seasonal.js';
import { cleanFences, fencesOnGrid } from '/lib/shade/fences.js';
import { toMerc as toMercS } from '/lib/shade/ept.js';
import { momentOf, surfaceNowAt, openNow, forcingAt, MODEL_VERSION, SCORING } from '/lib/surfacenow.js';
import { atMoment, spinWeatherUrl, spinHours, SPIN_DAYS } from '/lib/momentweather.js';
import { fitAnnual, spinColumns, columnProps, stepColumn, skinParts, CENTRES } from '/lib/soiltemp.js';
import { NUDGES, KNOBS, SOIL_NUDGE_C, BEAM_NUDGE, SQUARE_COLS, rowOf } from '/lib/residuals.js';
import { loadModel } from '/lib/lib/lidar-model.js';
import { surfaceExplain, soilExplain, windExplain, moistureExplain } from '/lib/explain.js';
import { spearman } from '/lib/rank.js';
import { offLawnM, ON_TRACE_M } from '/lib/walkrecords.js';

const kept = { r: null, lawn: null, standIn: false, soil: null, typical: null, week: null, lng: null, lat: null, season: null, climate: null, light: null };

function standInLawn(res) {
  // no traced lawn (an address typed here, not a Lawn Mapper map): open ground with no trees, not paving
  const g = res.grid, N = g.W * g.H, m = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!res.wall[i] && res.perCell.tall[i] === 0 && Number.isFinite(res.rawZ[i])) m[i] = 1;
  return m;
}

/** The shade map's growing season for this grass (climate.js, the owner's 20% GP rule), as a Set. */
function seasonFor(grass) {
  if (!kept.climate) return null;
  const tSoil = kept.climate.tSoil?.every?.(Number.isFinite) ? kept.climate.tSoil : null;
  const gs = growingSeason(kept.climate.tMean, grass === 'warm' ? 'warm' : 'cool', SEASON_GP, tSoil);
  return gs.days.length ? new Set(gs.days) : null;
}

/** each day's share of the broadleaf trees' leaves out (the shade map's leaf calendar), 365 values, or null */
function leafShareOf(climate) {
  if (!climate?.tMean?.length) return null;
  try { const cal = leafCalendar(climate.tMean); return Float32Array.from({ length: 365 }, (_, k) => cal.share(k)); } catch { return null; }
}

function planWith(inputs = {}, zoneOf = null) {
  const { r } = kept;
  const grass = inputs.grass === 'warm' ? 'warm' : 'cool';
  kept.season = seasonFor(grass);
  return waterPlan(r.result, {
    lawnMask: kept.lawn, lawnIsLot: !!kept.wholeLot, paved: r.impervious ? r.impervious.paved : null, soil: kept.soil, placement: kept.placement || null,
    topsoil: !!inputs.topsoil, downspouts: inputs.downspouts || [], gutters: inputs.gutters || [],
    typical: kept.typical, week: kept.week, season: kept.season, species: inputs.species || null, mode: inputs.mode || 'normal', soilTemp: { byDate: kept.soilDays || null, typical: kept.climate?.tSoil || null }, light: kept.light, lightMonths: kept.lightMonths || null, radiation: kept.radiation || null, fenceHeat: kept.fenceHeat || null, windMonths: kept.windMonths || null, shadeKinds: kept.shadeKinds || null, grass,
    texture: inputs.texture || null, parcelMask: r.parcelMask || null, areas: inputs.areas || [], zoneOf, groundwater: kept.groundwater || null,
    snapshots: Array.isArray(inputs.snapshots) ? inputs.snapshots : null,
    leafShare: kept.leafShare || (kept.leafShare = leafShareOf(kept.climate)),
  });
}

/* THE HEAT VIEW (owner, 2026-11-07; lib/heat.js): one month's energy pushes and pulls per spot, from the plan's own model
   and the ten years' days of that month, on request (the page asks when the view or the month changes). */
function heatFor({ month, id }) {
  if (!kept.model || !kept.typical) { self.postMessage({ heat: { id, error: 'the plan is not worked out yet' } }); return; }
  const h = heatOfMonth(kept.model, kept.typical, month, { season: kept.season || null });
  if (!h) { self.postMessage({ heat: { id, error: 'no weather for that month' } }); return; }
  const g = h.ground;
  /* THE SURFACE'S OWN TEMPERATURE (lib/heat.js surfaceOfMonth): kept watered (no water stress), and with rain alone
     (each square's own Ks that month, from the plan's ten years without a sprinkler, worked out once a plan) */
  if (!kept.ksRain) kept.ksRain = stressByMonth(kept.model, kept.typical, { season: kept.season || null });
  const ks = kept.ksRain[month];
  const wet = surfaceOfMonth(kept.model, h), dry = surfaceOfMonth(kept.model, h, { ks });
  const surf = { wetDay: wet.day, wetNight: wet.night, dryDay: dry.day, dryNight: dry.night, wind: wet.wind, ks: Float32Array.from(ks), ta: wet.ta, open: wet.open, peakW: wet.peakW, hours: wet.hours, wind2: wet.wind2, windByMonth: !!kept.model.windAtMonths };
  self.postMessage({ heat: { id, month, weather: h.weather, inSeason: h.inSeason, sunny: h.sunny, open: h.open, ground: g, night: h.night, air: h.air, surf, ownRadiation: !!kept.model.rad, fences: !!kept.model.fenceHeat, trees: !!kept.model.canopy } },
    [g.sun.buffer, g.sky.buffer, g.fence.buffer, g.paving.buffer, g.net.buffer, h.night.buffer, h.air.buffer, surf.wetDay.buffer, surf.wetNight.buffer, surf.dryDay.buffer, surf.dryNight.buffer, surf.wind.buffer, surf.ks.buffer]);
}

/* THE SOIL COLUMNS UP TO A TIME (FINDINGS H92), for a walk's spots or every lawn spot at a moment the explorer asks
   for (public/explore.js): the hours before tEnd and the year's soil wave for the bottom and the start; each spot's
   own beam every daylight hour (the light session L, already built), its own water each day (watered for the three
   days before when the walker ticked the sprinklers). Without the hours or the wave: { spun: null, why }. */
async function columnsTo(L, cells, tEnd, { sprinklers = false, wantDate = null } = {}) {
  const m = kept.model, g = kept.lightRes.grid, W = g.W, lat = kept.lat, lng = kept.lng;
  const tStart = tEnd - SPIN_DAYS * 864e5;
  const out = { spun: null, why: null, spinW: null, raw: null, cOf: new Map(cells.map((i, c) => [i, c])), ksFull: null, tEnd };
  let fit = null;
  try {
    fit = kept.soilDays ? fitAnnual([...kept.soilDays].map(([date, v]) => ({ date, t: v[0] }))) : null;
    if (!fit) throw new Error('the area\'s soil temperature record (IEMRE) did not answer');
    const res = await fetch(spinWeatherUrl(lat, lng, tEnd + 36e5));
    if (!res.ok) throw new Error(`Open-Meteo's archived hours answered ${res.status}`);
    out.raw = await res.json();
    const { hours, gaps } = spinHours(out.raw, tStart, tEnd);
    if (hours.length < SPIN_DAYS * 24 * 0.9 || gaps > SPIN_DAYS * 24 * 0.1) throw new Error(`Open-Meteo's archived hours had ${hours.length} of ${SPIN_DAYS * 24}`);
    out.spinW = { hours, gaps, w: hours.map((h) => momentOf({ t: h.t + 18e5, lat, lng, ta: h.ta, rh: h.rh, wind: h.wind, ghi: h.ghi, cloud: h.cloud })) };
  } catch (e) { out.why = e?.message || String(e); }
  const spinW = out.spinW;
  let spinBeam = null;
  if (spinW && cells.length) {
    /* each spot's direct beam at each daylight hour's middle: every day while that is under 400,000 rays, else every
       few days (the hour's beam taken from the nearest day asked: the sun moves under a degree a day) */
    const lit = spinW.hours.map((h, k) => k).filter((k) => spinW.w[k].el > 0);
    const stride = Math.max(1, Math.ceil((cells.length * lit.length) / 400000));
    const asked = lit.filter((k) => Math.floor((spinW.hours[k].t - tStart) / 864e5) % stride === 0);
    const q = new Float64Array(asked.length * cells.length * 3);
    let p = 0;
    for (const k of asked) for (const i of cells) { q[p++] = (i % W) + 0.5; q[p++] = Math.floor(i / W) + 0.5; q[p++] = spinW.hours[k].t + 18e5; }
    const got = await L.samples(q);
    const rowOf = new Map(asked.map((k, a) => [k, a]));
    // an hour not asked: the same hour of the nearest day that was
    spinBeam = (k, c) => {
      if (spinW.w[k].el <= 0) return 0;
      let a = rowOf.get(k);
      for (let d = 1; a === undefined && d <= stride; d++) a = rowOf.get(k - 24 * d) ?? rowOf.get(k + 24 * d);
      return a === undefined ? 1 : got[a * cells.length + c];
    };
    // the spot's daylight average over the weeks (the explanation's "shade over the weeks before")
    out.beamWeeks = (c) => { let s = 0, w = 0; for (const k of lit) { const gh = spinW.w[k].ghi || 0; s += spinBeam(k, c) * gh; w += gh; } return w > 0 ? s / w : null; };
  }
  /* each day's water for the spots: how much the ground holds back from evaporating (Ks) and how full the root zone
     is (the soil's conductivity and heat capacity follow it) */
  const dayKs = new Map(), dayFull = new Map();
  const days = kept.week?.days || [];
  if (days.length) {
    simulate(m, days, { season: kept.season || null, record: (d, st) => {
      const kOf = (i) => (st.Dr[i] <= m.raw[i] || !(m.taw[i] > m.raw[i]) ? 1 : Math.max(0, (m.taw[i] - st.Dr[i]) / (m.taw[i] - m.raw[i])));
      dayKs.set(days[d].date, Float32Array.from(cells, kOf));
      dayFull.set(days[d].date, Float32Array.from(cells, (i) => (m.taw[i] > 0 ? Math.max(0, 1 - st.Dr[i] / m.taw[i]) : 1)));
      if (days[d].date === wantDate) out.ksFull = Float32Array.from(st.Dr, (_, i) => kOf(i));
    } });
  }
  out.weatherReaches = (date) => days.some((d) => d.date === date);
  const texOf = (i) => m.soils?.[m.soilAt?.[i]]?.rz?.texture || null;
  const dayOfMs = (t) => new Date(t).toISOString().slice(0, 10);
  const nearDay = (map, d) => { if (map.has(d)) return map.get(d); let best = null, bd = Infinity; for (const k of map.keys()) { const x = Math.abs(Date.parse(k) - Date.parse(d)); if (x < bd) { bd = x; best = k; } } return best === null ? null : map.get(best); };
  const watered = (t) => !!sprinklers && t >= tEnd - 3 * 864e5;
  const propsMemo = cells.map(() => ({ d: null, p: null }));
  out.texOf = texOf;
  out.fullAt = (c, t) => (watered(t) ? 1 : nearDay(dayFull, dayOfMs(t))?.[c] ?? 1);
  out.propsAt = (c, t) => {
    const d = dayOfMs(t), memo = propsMemo[c];
    if (memo.d !== d) { memo.d = d; memo.p = columnProps(texOf(cells[c]), m.rootCm?.[cells[c]] ?? 15, out.fullAt(c, t)); }
    return memo.p;
  };
  out.ksAt = (c, t) => (watered(t) ? 1 : nearDay(dayKs, dayOfMs(t))?.[c] ?? 1);
  if (spinW && spinBeam) {
    out.spun = spinColumns({ n: cells.length, hours: spinW.hours, fit,
      propsOf: (c, k) => out.propsAt(c, spinW.hours[k].t),
      forcing: (c, k) => forcingAt(m, cells[c], spinBeam(k, c), spinW.w[k], { month: new Date(spinW.hours[k].t).getUTCMonth(), ks: out.ksAt(c, spinW.hours[k].t) }) });
  } else if (!out.why) out.why = 'no spots on the shade grid';
  out.used = out.spun ? `each spot's own soil column, ${SPIN_DAYS} days spun up from Open-Meteo's archived hours${spinW.gaps ? ` (${spinW.gaps} hours missing, the hour before carried)` : ''}, the bottom from the area's soil temperature record`
    : `none: G a share of Rn, as version 1 (${out.why})`;
  return out;
}

/** One spot at a minute over its spun column: the column carried from the last whole hour to t under the moment's own
 *  forcing. -> { ts, f, T (the layers after), props, parts, tBottom } or null with no column */
function spotAt(cols, i, beam, w, t, ks) {
  const m = kept.model, c = cols.cOf.get(i);
  if (!cols.spun || c === undefined || !w) return null;
  const month = new Date(t).getUTCMonth();
  const f = forcingAt(m, i, beam, w, { month, ks: Number.isFinite(ks) ? ks : cols.ksAt(c, t) });
  const T = Float64Array.from(cols.spun.T[c]), props = cols.propsAt(c, t), tBottom = cols.spun.tBottomAt(t);
  const ts = stepColumn(T, props, { ...f, tBottom }, Math.max(60, (t - cols.spun.t) / 1000)).ts;
  return { ts, f, T, props, parts: skinParts(T[0], f, ts), tBottom, c };
}

/* A THERMAL WALK AGAINST THE MODEL (owner, 2026-11-15: "take ground truth measurements to verify the surface
   temperature predictions of the water model"; public/app.js checkWalk). records: the walk's cells, one per cell,
   one pass and one angle band (the thermal session's grid.json, the shape agreed 2026-11-15), its place already turned
   into lng/lat and checked against the trace by the page. Each is set against the surface the model gives at the
   record's own minute: the sun where it stood, the direct beam's share through the canopy at that spot at that minute
   (the light worker, asked again), the air as the walker read it (else the station's), the station's humidity and
   wind, and the cloud from the sky sweep (else the station's sky cover); the ground as wet as that day's rain left it,
   or watered when the walker said the sprinklers ran; since 2026-11-17 each spot's own soil column (columnsTo).
   -> { id, model, n, bias, rmse, rho, bands, sunShade, open, v1, records: Float32Array of predictions, settings }.
   What it worked out is kept (kept.walkCtx) so the explorer can open any record's factors (explain). */
const toC = (r) => (r && Number.isFinite(r.T) ? (r.unit === 'F' ? ((r.T - 32) * 5) / 9 : r.T) : null);
async function walkCheck({ id, records, series, notes }) {
  const m = kept.model;
  if (!m || !kept.lightRes) { self.postMessage({ walkCheck: { id, error: m ? 'the shade is not worked out on this map' : 'the plan is not worked out yet' } }); return; }
  const g = kept.lightRes.grid, W = g.W, H = g.H, cell = (g.bbox[2] - g.bbox[0]) / W;
  const lat = kept.lat, lng = kept.lng;
  // each record's place on the light worker's grid (the shade map's gridOver over the same box) and its cell
  const pts = new Float64Array(records.length * 3), idx = new Int32Array(records.length).fill(-1);
  records.forEach((r, k) => {
    const [X, Y] = toMercS([r.lng, r.lat]);
    const gx = (X - g.bbox[0]) / cell, gy = (g.bbox[3] - Y) / cell;
    pts[3 * k] = gx; pts[3 * k + 1] = gy; pts[3 * k + 2] = r.tm;
    if (gx >= 0 && gy >= 0 && gx < W && gy < H) idx[k] = Math.floor(gy) * W + Math.floor(gx);
  });
  const tFirst = records.reduce((a, r) => Math.min(a, r.tm), Infinity);
  const tEnd = Math.floor(tFirst / 36e5) * 36e5;
  const cells = [...new Set(Array.from(idx).filter((i) => i >= 0))];
  const date = new Date(records.length ? records[0].tm : Date.now()).toISOString().slice(0, 10);
  let beams, cols;
  const L = lightSession(kept.lightRes, kept.lightSite, kept.climate);
  try {
    await L.build(L.edits.erased);
    beams = await L.samples(pts); // the grass's top, as the shade map's field readings ask at a phone's height
    cols = await columnsTo(L, cells, tEnd, { sprinklers: !!notes?.sprinklers, wantDate: notes?.sprinklers ? null : date });
  } catch (e) { self.postMessage({ walkCheck: { id, error: `the shade at those minutes: ${e?.message || e}` } }); return; } finally { L.close(); }
  // how wet the ground was: watered when the walker said so, else that day's rain-alone run
  const ks = notes?.sprinklers ? null : cols.ksFull;
  const wet = notes?.sprinklers ? 'watered (the sprinklers ran)' : cols.weatherReaches(date) ? 'as that day\'s rain left it' : 'watered (the weather record does not reach that day)';
  // the walker's air: straight-line between their readings; the sky sweep's cloud
  const airs = (notes?.air || []).map((a) => ({ t: a.at, T: toC(a) })).filter((a) => Number.isFinite(a.t) && Number.isFinite(a.T)).sort((a, b) => a.t - b.t);
  const airAt = (t) => {
    if (!airs.length) return null;
    if (airs.length === 1 || t <= airs[0].t) return airs[0].T;
    for (let k = 1; k < airs.length; k++) if (t <= airs[k].t) return airs[k - 1].T + ((airs[k].T - airs[k - 1].T) * (t - airs[k - 1].t)) / (airs[k].t - airs[k - 1].t);
    return airs[airs.length - 1].T;
  };
  const sweep = notes?.sky && Number.isFinite(notes.sky.cloud_fraction) ? notes.sky.cloud_fraction : null;
  const typed = { clear: 0, broken: 0.6, overcast: 1 }[notes?.cloud];
  const memo = new Map(), memoSt = new Map();
  /* the moment's weather with the walker's air (byStation false) or, for the second score, the station's alone: the
     live map only ever has the station's, so that score is what it can do; the walker's says how good the model is */
  const weatherAt = (t, byStation = false) => {
    const key = Math.round(t / 6e4), M = byStation ? memoSt : memo;
    if (M.has(key)) return M.get(key);
    const s = atMoment(series || [], t);
    const ta = byStation ? s.ta : airAt(t) ?? s.ta;
    /* the cloud for the sky's longwave: the walker's word, the sky sweep, else by day the satellite's sunshine against
       the clear sky (momentOf works it out when no cloud is given), else the station's sky cover */
    // the live map's run (byStation) has neither the walker's word nor the sweep: the satellite's sunshine, else the station's sky cover
    const cloud = !byStation && Number.isFinite(typed) ? typed : (!byStation ? sweep : null) ?? (Number.isFinite(s.ghi) ? null : s.cloud);
    const w = Number.isFinite(ta) ? momentOf({ t, lat, lng, ta, rh: Number.isFinite(s.rh) ? s.rh : 70, wind: s.wind, ghi: s.ghi, cloud }) : null;
    M.set(key, w);
    return w;
  };
  const pred = new Float32Array(records.length).fill(NaN), was = new Float32Array(records.length).fill(NaN);
  const anyGhi = (series || []).some((r) => Number.isFinite(r.ghi));
  const used = { air: airs.length ? 'the walker\'s thermometer' : 'the station', cloud: Number.isFinite(typed) ? 'the walker\'s word' : sweep !== null ? 'the sky sweep' : anyGhi ? 'from the satellite\'s sunshine by day' : 'the station\'s sky cover', wet };
  records.forEach((r, k) => {
    const w = weatherAt(r.tm), i = idx[k];
    if (!w || i < 0) return;
    const month = new Date(r.tm).getUTCMonth();
    was[k] = surfaceNowAt(m, i, beams[k], w, { month, ks: ks ? ks[i] : 1 }).ts;
    const s = spotAt(cols, i, beams[k], w, r.tm, ks ? ks[i] : null);
    pred[k] = s ? s.ts : was[k];
  });
  /* the second score: the live map's own prediction -- nothing of the walker's in it but the walk's time and place:
     the station's air, humidity and wind, the cloud from the satellite's sunshine (else the station's sky cover) */
  const predSt = new Float32Array(records.length).fill(NaN);
  records.forEach((r, k) => {
    const w = weatherAt(r.tm, true), i = idx[k];
    if (!w || i < 0) return;
    const s = spotAt(cols, i, beams[k], w, r.tm, ks ? ks[i] : null);
    predSt[k] = s ? s.ts : surfaceNowAt(m, i, beams[k], w, { month: new Date(r.tm).getUTCMonth(), ks: ks ? ks[i] : 1 }).ts;
  });
  kept.walkCtx = { id, records, idx, beams, weatherAt, ks, cols, was, used };
  const stats = (ks2, P = pred) => {
    const d = ks2.map((k) => records[k].T - P[k]);
    if (!d.length) return { n: 0 };
    const bias = d.reduce((a, b) => a + b, 0) / d.length;
    return { n: d.length, bias, rmse: Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length), rho: spearman(ks2.map((k) => records[k].T), ks2.map((k) => P[k])) };
  };
  const ok = records.map((_, k) => k).filter((k) => Number.isFinite(pred[k]) && Number.isFinite(records[k].T));
  const bands = {};
  for (const b of ['0-60', '60-70', '70-80']) bands[b] = stats(ok.filter((k) => (records[k].band || '0-60') === b));
  const main = ok.filter((k) => (records[k].band || '0-60') === '0-60');
  const sunShade = { sun: stats(main.filter((k) => beams[k] >= 0.5)), shade: stats(main.filter((k) => beams[k] < 0.2)) };
  /* BY DISTANCE FROM PAVING (owner, 2026-11-17: what paving does to the grass beside it, "a pretty big gap in the
     model"): each square's distance to the nearest paved cell of the plan (driveways, walks, patios; kinds 3 and 4),
     in bands, both scores; the model's own edge term is S8's estimate, so these bands are its test */
  const dist = pavingDistance(m.kinds, W, H, cell * Math.cos((lat * Math.PI) / 180));
  const EDGE = [['0-1 m', 0, 1], ['1-3 m', 1, 3], ['3-7 m', 3, 7], ['7+ m', 7, Infinity]];
  const edge = Object.fromEntries(EDGE.map(([name, lo, hi]) => { const ks = main.filter((k) => idx[k] >= 0 && dist[idx[k]] >= lo && dist[idx[k]] < hi); return [name, { ...stats(ks), live: stats(ks.filter((k) => Number.isFinite(predSt[k])), predSt), sun: stats(ks.filter((k) => beams[k] >= 0.5)) }]; }));
  /* EVERY SQUARE, WITH WHAT WENT INTO IT AND HOW FAR EACH KNOB WOULD MOVE IT (2026-11-18, lib/residuals.js; read by
     tools/residuals.py): the walker's-air run, the main band. x, y: metres across the plan's grid, not a place. */
  const cellM = cell * Math.cos((lat * Math.PI) / 180), t0w = records.length ? records.reduce((a, r) => Math.min(a, r.tm), Infinity) : 0;
  const diagRows = [];
  for (const k of main) {
    const i = idx[k], r = records[k], w = weatherAt(r.tm), kk = ks ? ks[i] : null;
    const s = spotAt(cols, i, beams[k], w, r.tm, kk);
    if (!s) continue;
    const T0 = cols.spun.T[s.c], dt = Math.max(60, (r.tm - cols.spun.t) / 1000);
    const run = (f, dT = 0) => stepColumn(Float64Array.from(T0, (v) => v + dT), s.props, { ...f, tBottom: s.tBottom }, dt).ts;
    const base = run(s.f), J = {};
    for (const n of NUDGES) J[n.key] = run(n.apply(s.f)) - base;
    J.soil = run(s.f, SOIL_NUDGE_C) - base;
    const up = beams[k] <= 1 - BEAM_NUDGE, sb = spotAt(cols, i, beams[k] + (up ? BEAM_NUDGE : -BEAM_NUDGE), w, r.tm, kk);
    J.shade = sb ? (up ? sb.ts - s.ts : s.ts - sb.ts) : 0;
    const tex = cols.texOf(i) || {}, month = new Date(r.tm).getUTCMonth();
    const o = { meas: r.T, pred: pred[k], predSt: predSt[k], v1: was[k], min: (r.tm - t0w) / 6e4, el: w.el, ghi: w.ghi, cloud: w.cloud, ta: w.ta, wind: w.wind, rh: w.rh,
      beam: beams[k], sky: skyAt(m, i, month), shelter: shelterAt(m, i, month), canopy: m.canopy ? m.canopy[i] : 0, edge: m.edgeHeat ? m.edgeHeat[i] : 1, pavingM: Math.min(30, dist[i]), kind: m.kinds[i],
      swNet: s.f.swNet, rnIso: s.f.rnIso, ra: s.f.ra, beta: s.f.beta, fence: s.f.fence, paving: s.f.paving, air: s.f.air, u2: s.f.u2, t1: T0[0], lambda1: s.props[0]?.lambda,
      sand: tex.sand, clay: tex.clay, rootCm: m.rootCm ? m.rootCm[i] : null, full: cols.fullAt(s.c, r.tm), x: (i % W) * cellM, y: Math.floor(i / W) * cellM };
    diagRows.push([...rowOf(o, SQUARE_COLS), ...KNOBS.map((q) => (Number.isFinite(J[q]) ? Math.round(J[q] * 10000) / 10000 : 0))]);
  }
  const diag = { cols: [...SQUARE_COLS, ...KNOBS.map((q) => `J_${q}`)], rows: diagRows };
  const mid = records.length ? records[Math.floor(records.length / 2)].tm : Date.now();
  const wMid = weatherAt(mid);
  used.soil = cols.used;
  // the same walk under version 1, beside it: the before and after of the soil columns
  const wasOk = main.filter((k) => Number.isFinite(was[k]));
  const v1 = cols.spun ? { model: 'surface-now 1 (2026-11-15)', ...stats(wasOk, was), sun: stats(wasOk.filter((k) => beams[k] >= 0.5), was), shade: stats(wasOk.filter((k) => beams[k] < 0.2), was) } : null;
  const stOk = main.filter((k) => Number.isFinite(predSt[k]));
  const wSt = weatherAt(mid, true);
  const station = { air: 'the live map\'s: the station\'s air, humidity and wind, the cloud from the satellite\'s sunshine (else the station\'s sky cover)', cloudMid: wSt ? wSt.cloud : null, cloudWalker: wMid ? wMid.cloud : null, airMid: wSt ? wSt.ta : null, airWalker: wMid ? wMid.ta : null,
    ...stats(stOk, predSt), sun: stats(stOk.filter((k) => beams[k] >= 0.5), predSt), shade: stats(stOk.filter((k) => beams[k] < 0.2), predSt) };
  const out = { id, model: MODEL_VERSION, scoring: SCORING, shape: kept.shape || null, ...stats(main), bands, sunShade, edge, used, v1, station,
    open: wMid ? { ts: openNow(wMid, m.params).ts, ta: wMid.ta, ghi: wMid.ghi, cloud: wMid.cloud, el: wMid.el, from: wMid.from } : null, pred: Float32Array.from(pred), diag };
  self.postMessage({ walkCheck: out }, [out.pred.buffer]);
}

/** Each cell's distance (m) to the nearest paved cell (kinds 3, 4), to 30 m: two chamfer passes over the grid. */
function pavingDistance(kinds, W, H, cellM) {
  const D = new Float32Array(W * H).fill(Infinity), d1 = cellM, d2 = cellM * Math.SQRT2;
  for (let i = 0; i < W * H; i++) if (kinds[i] === 3 || kinds[i] === 4) D[i] = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c; let v = D[i];
    if (c > 0) v = Math.min(v, D[i - 1] + d1);
    if (r > 0) { v = Math.min(v, D[i - W] + d1); if (c > 0) v = Math.min(v, D[i - W - 1] + d2); if (c < W - 1) v = Math.min(v, D[i - W + 1] + d2); }
    D[i] = v;
  }
  for (let r = H - 1; r >= 0; r--) for (let c = W - 1; c >= 0; c--) {
    const i = r * W + c; let v = D[i];
    if (c < W - 1) v = Math.min(v, D[i + 1] + d1);
    if (r < H - 1) { v = Math.min(v, D[i + W] + d1); if (c < W - 1) v = Math.min(v, D[i + W + 1] + d2); if (c > 0) v = Math.min(v, D[i + W - 1] + d2); }
    D[i] = v;
  }
  return D;
}

/* THE EXPLORER'S MOMENT (owner, 2026-11-17; public/explore.js): every lawn spot at one time -- its grass surface, its
   soil at 2 and 4 inches and its wind -- from the same pieces a walk is scored with, on Open-Meteo's archived hours
   for the weather. Kept (kept.moment) so a tapped spot's factors come back at once (explain). */
const lerpDepth = (T, z) => { for (let k = 1; k < CENTRES.length; k++) if (z <= CENTRES[k]) { const a = (z - CENTRES[k - 1]) / (CENTRES[k] - CENTRES[k - 1]); return T[k - 1] + a * (T[k] - T[k - 1]); } return T[T.length - 1]; };
async function moment({ id, t, sprinklers = false, depthCm = null }) {
  const r = await momentCore({ t, sprinklers, depthCm });
  if (r.error) { self.postMessage({ moment: { id, error: r.error } }); return; }
  const { w, used, surface, soil5, soil10, wind, soilD } = r;
  self.postMessage({ moment: { id, t, w: { ta: w.ta, rh: w.rh, wind: w.wind, ghi: w.ghi, cloud: w.cloud, el: w.el }, used, surface, soil5, soil10, wind, soilD, depthCm } }, [surface.buffer, soil5.buffer, soil10.buffer, wind.buffer, ...(soilD ? [soilD.buffer] : [])]);
}
async function momentCore({ t, sprinklers = false, depthCm = null }) {
  const m = kept.model;
  if (!m || !kept.lightRes) return { error: m ? 'the shade is not worked out on this map' : 'the plan is not worked out yet' };
  const g = kept.lightRes.grid, N = g.W * g.H, W = g.W;
  const kinds = m.kinds;
  const cells = []; for (let i = 0; i < N; i++) if (kinds[i] === 1) cells.push(i);
  const tEnd = Math.floor(t / 36e5) * 36e5;
  let beams, cols;
  const L = lightSession(kept.lightRes, kept.lightSite, kept.climate);
  try {
    await L.build(L.edits.erased);
    const q = new Float64Array(cells.length * 3);
    cells.forEach((i, c) => { q[3 * c] = (i % W) + 0.5; q[3 * c + 1] = Math.floor(i / W) + 0.5; q[3 * c + 2] = t; });
    beams = await L.samples(q);
    cols = await columnsTo(L, cells, tEnd, { sprinklers, wantDate: new Date(t).toISOString().slice(0, 10) });
  } finally { L.close(); }
  if (!cols.spun) return { error: `the soil columns: ${cols.why}` };
  // the moment's own weather: the hour it falls in, from the same archived hours
  const hr = spinHours(cols.raw, tEnd, tEnd + 36e5).hours[0];
  if (!hr) return { error: 'Open-Meteo has no weather for that hour yet' };
  const w = momentOf({ t, lat: kept.lat, lng: kept.lng, ta: hr.ta, rh: hr.rh, wind: hr.wind, ghi: hr.ghi, cloud: hr.cloud });
  const surface = new Float32Array(N).fill(NaN), soil5 = new Float32Array(N).fill(NaN), soil10 = new Float32Array(N).fill(NaN), wind = new Float32Array(N).fill(NaN);
  const soilD = Number.isFinite(depthCm) ? new Float32Array(N).fill(NaN) : null; // a reading's own depth (the field page's soil thermometer)
  cells.forEach((i, c) => {
    const s = spotAt(cols, i, beams[c], w, t, cols.ksFull ? cols.ksFull[i] : null);
    if (!s) return;
    surface[i] = s.ts; soil5[i] = lerpDepth(s.T, 0.05); soil10[i] = lerpDepth(s.T, 0.10); wind[i] = s.f.u2;
    if (soilD) soilD[i] = lerpDepth(s.T, depthCm / 100);
  });
  kept.moment = { t, w, cells, beams, cols, sprinklers };
  return { w, used: cols.used, surface, soil5, soil10, wind, soilD };
}

/* POINT READINGS AGAINST THE MODEL (the water builder's soil check, 2026-11-17; src/autoscore.js): readings taken at
   one time -- a soil thermometer at depthCm, or the grass surface -- each set against the nearest lawn spot's model
   (within two cells, as the explorer). points: [{ n, lng, lat, value (C) }] -> { n, bias, rmse, rho, spots, used } */
async function pointsAt({ id, t, depthCm = null, points = [], view = 'soil' }) {
  const r = await momentCore({ t, depthCm: view === 'soil' ? depthCm : null });
  if (r.error) { self.postMessage({ pointsAt: { id, error: r.error } }); return; }
  const m = kept.model, field = view === 'soil' ? r.soilD : r.surface, g = kept.lightRes.grid, W = g.W, H = g.H, cell = (g.bbox[2] - g.bbox[0]) / W;
  const spots = points.map((p) => {
    const [X, Y] = toMercS([p.lng, p.lat]);
    const c0 = Math.floor((X - g.bbox[0]) / cell), r0 = Math.floor((g.bbox[3] - Y) / cell);
    const inGrid = c0 >= 0 && r0 >= 0 && c0 < W && r0 < H;
    // the nearest lawn spot the model works out: within two cells it is the reading's; the distance either way (to 15 m),
    // so a reading the check cannot use says why (off the lawn, or the map's box), in metres only
    let best = -1, bd = Infinity;
    for (let rr = r0 - 15; rr <= r0 + 15; rr++) for (let cc = c0 - 15; cc <= c0 + 15; cc++) {
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const i = rr * W + cc, dd = (rr - r0) ** 2 + (cc - c0) ** 2;
      if (Number.isFinite(field[i]) && dd < bd) { bd = dd; best = i; }
    }
    const k = Math.cos((kept.lat * Math.PI) / 180), metres = best >= 0 ? Math.sqrt(bd) * cell * k : null;
    // off the map's box: by how far (metres only), so a reading on the wrong map shows as one
    const boxM = inGrid ? 0 : Math.round(Math.hypot(Math.max(0, g.bbox[0] - X, X - g.bbox[2]), Math.max(0, g.bbox[1] - Y, Y - g.bbox[3])) * k);
    return { n: p.n, value: p.value, model: best >= 0 && bd <= 8 ? field[best] : null, lawnM: metres === null ? null : Math.round(metres * 10) / 10, inGrid, boxM, kind: inGrid ? m.kinds[r0 * W + c0] : null };
  });
  const ok = spots.filter((x) => Number.isFinite(x.model) && Number.isFinite(x.value)), d = ok.map((x) => x.value - x.model);
  const bias = d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  self.postMessage({ pointsAt: { id, view, depthCm, n: ok.length, bias, rmse: d.length ? Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length) : null,
    rho: ok.length >= 3 ? spearman(ok.map((x) => x.value), ok.map((x) => x.model)) : null, spots, used: r.used, air: r.w.ta, model: MODEL_VERSION } });
}

/* WHICH CELL KIND EACH POINT IS ON (the builder's walk placement, 2026-11-17: a whole property saved as lawn counts a
   record only on the plan's own lawn cells): { points: [[lng, lat]] } -> { kinds: [kind or null] }, on the light
   worker's grid as walkCheck places a record */
function cellsAt({ id, points = [] }) {
  const m = kept.model, g = kept.lightRes?.grid;
  if (!m || !g) { self.postMessage({ cellsAt: { id, error: 'the plan is not worked out yet' } }); return; }
  const W = g.W, H = g.H, cell = (g.bbox[2] - g.bbox[0]) / W;
  const kinds = points.map(([lng, lat]) => {
    const [X, Y] = toMercS([lng, lat]), c = Math.floor((X - g.bbox[0]) / cell), r = Math.floor((g.bbox[3] - Y) / cell);
    return c >= 0 && r >= 0 && c < W && r < H ? m.kinds[r * W + c] : null;
  });
  self.postMessage({ cellsAt: { id, kinds } });
}

/** A spot's month shelter and the sky it sees, as forcingAt reads them. */
function shelterAt(m, i, month) { const winds = m.winds || [1], at = m.windAtMonths ? m.windAtMonths[month] : m.windAt; return winds[at ? at[i] : 0] ?? 1; }
function skyAt(m, i, month) { const R = m.rad ? m.rad[month] : null, FH = m.fenceHeat; return R ? (FH ? Math.max(0, R.parD[i] - FH.reflSky[i]) : R.parD[i]) : 1; }

/* ONE SPOT'S FACTORS (the explorer's tap): { view: surface | soil | wind, and either k (a record of the last walk
   checked) or i (a cell of the last moment), reading (C or m/s, optional), depthCm (soil) } -> lib/explain.js's */
function explain({ id, view, k = null, i = null, reading = null, depthCm = 10 }) {
  const m = kept.model;
  let ctx, cell, t, w, beam, ks, v1 = null, airFrom = null, cloudFrom = null;
  if (k !== null && kept.walkCtx) {
    const W0 = kept.walkCtx; ctx = W0.cols; cell = W0.idx[k]; t = W0.records[k].tm; w = W0.weatherAt(t); beam = W0.beams[k]; ks = W0.ks ? W0.ks[cell] : null; v1 = W0.was[k];
    airFrom = W0.used.air; cloudFrom = W0.used.cloud;
  } else if (i !== null && kept.moment) {
    const M = kept.moment, c = M.cols.cOf.get(i); ctx = M.cols; cell = i; t = M.t; w = M.w; beam = c === undefined ? null : M.beams[c]; ks = M.cols.ksFull ? M.cols.ksFull[i] : null;
    airFrom = 'Open-Meteo\'s archived hour'; cloudFrom = 'Open-Meteo\'s archived hour';
  }
  if (!ctx || cell < 0 || cell === null) { self.postMessage({ explain: { id, error: 'nothing worked out for that spot yet' } }); return; }
  const s = spotAt(ctx, cell, beam, w, t, ks);
  if (!s) { self.postMessage({ explain: { id, error: 'that spot is not on the lawn the model works out' } }); return; }
  const month = new Date(t).getUTCMonth();
  const a = { ts: s.ts, f: s.f, parts: s.parts, w, beam, ks: Number.isFinite(ks) ? ks : ctx.ksAt(s.c, t), skyView: skyAt(m, cell, month), shelter: shelterAt(m, cell, month),
    column: Array.from(s.T), centres: CENTRES, props: s.props, texture: ctx.texOf(cell), rootCm: m.rootCm?.[cell] ?? 15, full: ctx.fullAt(s.c, t),
    shadeWeeks: ctx.beamWeeks ? ctx.beamWeeks(s.c) : null, tBottom: s.tBottom, v1, reading, airFrom, cloudFrom, soilFrom: ctx.used };
  let out;
  if (view === 'soil') out = soilExplain({ ...a, depthCm, value: lerpDepth(s.T, depthCm / 100) });
  else if (view === 'wind') out = windExplain({ w, u2: s.f.u2, shelter: a.shelter, open: w.wind, ra: s.f.ra, reading, airFrom, cloudFrom });
  else out = surfaceExplain(a);
  self.postMessage({ explain: { id, t, ...out } });
}

/* THE ROOT ZONE ON A DATE (the explorer's moisture view): the weeks' weather, rain alone, every cell's water as a share
   of what its roots can use (as plan.js's snapshots), and with i, that spot's factors over the days before. */
function moistureAt({ id, date, i = null, reading = null, unit = null, days: back = 7 }) {
  const m = kept.model, days = kept.week?.days || [];
  if (!m || !days.some((d) => d.date === date)) { self.postMessage({ moistureAt: { id, error: m ? 'the weather record does not reach that day' : 'the plan is not worked out yet' } }); return; }
  const kinds = m.kinds, N = kinds.length, at = days.findIndex((d) => d.date === date), from = Math.max(0, at - back);
  let wet = null, ex = null, before = null;
  const snap = (st) => ({ et: st.tot.et[i], drained: st.tot.drained[i], ranOff: st.tot.ranOff[i], rose: st.tot.rose?.[i] ?? 0 });
  simulate(m, days, { season: kept.season || null, record: (d, st) => {
    if (i !== null && d === from) before = snap(st);
    if (d !== at) return;
    wet = new Float32Array(N).fill(NaN);
    for (let c = 0; c < N; c++) if (kinds[c] === 1) { const tw = m.taw[c]; if (tw > 0) wet[c] = (tw - st.Dr[c] + st.grav[c] + st.pond[c]) / tw; }
    if (i !== null && m.taw[i] > 0) {
      const now = snap(st), b = before || { et: 0, drained: 0, ranOff: 0, rose: 0 }, span = days.slice(from + 1, at + 1);
      const sum = (f) => span.reduce((a, x) => a + (Number.isFinite(f(x)) ? f(x) : 0), 0);
      const ks = st.Dr[i] <= m.raw[i] || !(m.taw[i] > m.raw[i]) ? 1 : Math.max(0, (m.taw[i] - st.Dr[i]) / (m.taw[i] - m.raw[i]));
      const month = Number(date.slice(5, 7)) - 1;
      ex = moistureExplain({ wet: wet[i], taw: m.taw[i], raw: m.raw[i], rootCm: m.rootCm?.[i], texture: m.soils?.[m.soilAt?.[i]]?.rz?.texture || null, Dr: st.Dr[i], grav: st.grav[i], pond: st.pond[i], ks,
        week: { rain: sum((x) => x.rain), et0: sum((x) => x.et0), et: now.et - b.et, drained: now.drained - b.drained, ranOff: now.ranOff - b.ranOff, rose: now.rose - b.rose },
        etFactor: st.etFactor?.[i], light: m.lightMonths?.[month]?.[i] ?? m.light?.[i] ?? null, days: span.length, reading, unit });
    }
  } });
  const msg = { id, date, wet, explain: ex };
  self.postMessage({ moistureAt: msg }, wet ? [wet.buffer] : []);
}

/* A SURFACE-TEMPERATURE VISIT AGAINST THE MODEL (owner, 2026-11-09): the surface model (lib/heat.js) on the visit
   day's own weather (the weeks the plan reads), the air as the visitor measured it when they did, the ground as wet as
   that day's rain-alone run has it (or kept watered, when the visitor ticked the sprinklers); each cell's surface
   minus the air, at the afternoon peak (a visit 10 am-5 pm) or
   before dawn (9 pm-8 am). Anything else (dusk, dawn) has no fair moment to compare with. */
function surfCheck(q) {
  const r = surfCore(q);
  if (r.error) { self.postMessage({ surfCheck: { id: q.id, error: r.error } }); return; }
  self.postMessage({ surfCheck: { id: q.id, ...r } }, [r.dT.buffer]);
}
/** surfCheck's working, for the page's message and the server's visit check alike. -> { error } or the fields */
function surfCore({ date, hour, airF, watered = false }) {
  const days = kept.week?.days || [];
  const day = days.find((d) => d.date === date);
  if (!kept.model || !day) return { error: kept.model ? 'the weather record does not reach that day' : 'the plan is not worked out yet' };
  const mode = hour >= 10 && hour < 17 ? 'day' : hour >= 21 || hour < 8 ? 'night' : null;
  if (!mode) return { error: 'taken at dusk or dawn: no fair moment to compare with (the model gives the afternoon peak and before dawn)' };
  const month = Number(date.slice(5, 7)) - 1;
  /* how wet the ground was that day: kept watered when the visitor ticked that the sprinklers ran in the 3 days
     before (ks null: the grass uses all it wants), else rain alone, the stations' rain over the weeks before */
  let ks = null;
  if (!watered) simulate(kept.model, days, { season: kept.season || null, record: (d, st) => {
    if (days[d].date !== date) return;
    const m = kept.model;
    ks = Float32Array.from(st.Dr, (Dr, i) => (Dr <= m.raw[i] || !(m.taw[i] > m.raw[i]) ? 1 : Math.max(0, (m.taw[i] - Dr) / (m.taw[i] - m.raw[i]))));
  } });
  const air = Number.isFinite(airF) ? (airF - 32) / 1.8 : null;
  /* a recent day from the stations has no sunshine yet (NASA's comes days later): the forecast's cloud cover, else
     FAO-56's estimate from the day's temperature range (eq. 50, kRs 0.16 inland); a missing wind 2 m/s and humidity
     from the night's low as the dew point (FAO-56's fallbacks) */
  const lat = kept.model.g?.lat ?? kept.lat ?? 42.5, doy = dayOfYear(date);
  const es = (t) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
  const rs = Number.isFinite(day.rs) ? day.rs : Number.isFinite(day.cover) ? rsFromCover(day.cover, lat, doy) : 0.16 * Math.sqrt(Math.max(0, day.tmax - day.tmin)) * ra(lat, doy);
  const rh = Number.isFinite(day.rh) ? day.rh : Math.min(100, (100 * es(day.tmin)) / ((es(day.tmax) + es(day.tmin)) / 2));
  const one = { ...day, rs, rh, wind: Number.isFinite(day.wind) ? day.wind : 2, ...(air !== null ? (mode === 'day' ? { tmax: air } : { tmin: air }) : {}) };
  const filled = [!Number.isFinite(day.rs) && (Number.isFinite(day.cover) ? 'sunshine from the cloud cover' : 'sunshine from the day\'s temperature range'), !Number.isFinite(day.rh) && 'humidity from the night\'s low', !Number.isFinite(day.wind) && 'wind 2 m/s'].filter(Boolean);
  const h = heatOfMonth(kept.model, [one], month, { season: kept.season || null });
  if (!h) return { error: 'that day has no sunshine, humidity or wind in the record' };
  const s = surfaceOfMonth(kept.model, h, { ks });
  const ta = mode === 'day' ? s.ta.day : s.ta.night;
  const dT = Float32Array.from(mode === 'day' ? s.day : s.night, (t) => t - ta);
  return { mode, ta, open: (mode === 'day' ? s.open.day : s.open.night) - ta, dT, ks, wind: s.wind, filled, watered: !!watered };
}

/* A FIELD VISIT'S READINGS AGAINST THE MODEL, WITH NO PAGE (owner, 2026-11-18: "I don't want anything to have to run
   in the browser like that"): the two checks the water map's page worked out when it was open (public/app.js
   moistureCard and surfCards), here for the water builder (builder/server.mjs points) -- the same rules, the same
   record kept (moisture_checks). Soil moisture: each reading against the root zone's water on its day, rain alone, the
   mean of the lawn cells within NEAR_M of it, else the nearest within SNAP_M. Surface temperature: each reading minus
   the air against surfCore's. The day and hour are the lot's own, by its longitude (the page used the phone's clock).
   -> { visitCheck: { id, rho, n, spots, settings } } */
const NEAR_M = 1.0, SNAP_M = 2.0;
function visitCheck({ id, unit, at, depth_in = null, air_f = null, watered = false, readings = [] }) {
  const m = kept.model, res = kept.lightRes, site = kept.lightSite;
  if (!m || !res) { self.postMessage({ visitCheck: { id, error: m ? 'the shade is not worked out on this map' : 'the plan is not worked out yet' } }); return; }
  const g = res.grid, W = g.W, H = g.H, bbox = g.bbox, dx = (res.shift?.east || 0) / g.k, dy = (res.shift?.north || 0) / g.k;
  const cw = (bbox[2] - bbox[0]) / W, ch = (bbox[3] - bbox[1]) / H, trace = site?.lawn || [];
  const local = new Date(at + (kept.lng / 15) * 36e5), date = local.toISOString().slice(0, 10), hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  const place = (r) => { const [x, y] = toMercS([r.lng, r.lat]); return { gx: (x - dx - bbox[0]) / cw, gy: (bbox[3] - (y - dy)) / ch, k: Math.cos((r.lat * Math.PI) / 180) }; };
  const cellOf = (q) => { const c = Math.floor(q.gx), r = Math.floor(q.gy); return c >= 0 && c < W && r >= 0 && r < H ? r * W + c : -1; };
  // on the lawn by the trace (within ON_TRACE_M); with no trace by the cell; a whole property saved as lawn by both
  const onLawn = (off, kind) => (off === null ? kind === 1 : off <= ON_TRACE_M && (!kept.wholeLot || kind === 1));
  if (unit === 'surface_f') {
    const sc = surfCore({ date, hour, airF: air_f, watered });
    if (sc.error) { self.postMessage({ visitCheck: { id, error: sc.error, final: true } }); return; }
    const air = Number.isFinite(air_f) ? air_f : sc.ta * 1.8 + 32;
    const spots = readings.map((r) => {
      const i = cellOf(place(r)), off = offLawnM([r.lng, r.lat], trace), kind = i >= 0 ? m.kinds[i] : null;
      return { n: r.n, value: r.value, measured: r.value - air, wet: i >= 0 && Number.isFinite(sc.dT[i]) ? sc.dT[i] * 1.8 : null, lawn: onLawn(off, kind) ? 1 : 0, off, kind };
    });
    const ok = spots.filter((x) => x.lawn && x.wet !== null);
    self.postMessage({ visitCheck: { id, rho: spearman(ok.map((x) => x.measured), ok.map((x) => x.wet)), n: ok.length, spots,
      settings: { date, irrigated: sc.watered ? 'watered' : 'rain alone', season: `surface, ${sc.mode === 'day' ? 'afternoon' : 'before dawn'}; air ${Math.round(air)} F` } } });
    return;
  }
  const days = kept.week?.days || [], dAt = days.findIndex((d) => d.date === date);
  let wet = null;
  if (dAt >= 0) simulate(m, days, { season: kept.season || null, record: (d, st) => {
    if (d !== dAt) return;
    wet = new Float32Array(W * H).fill(NaN);
    for (let c = 0; c < W * H; c++) if (m.kinds[c] === 1 && m.taw[c] > 0) wet[c] = (m.taw[c] - st.Dr[c] + st.grav[c] + st.pond[c]) / m.taw[c];
  } });
  const P = kept.planKept || {};
  const spots = readings.map((r) => {
    const q = place(r), i0 = cellOf(q), c0 = Math.floor(q.gx), r0 = Math.floor(q.gy), reach = Math.ceil(SNAP_M / (cw * q.k)) + 1, near = [];
    let best = null;
    for (let rr = r0 - reach; rr <= r0 + reach; rr++) for (let cc = c0 - reach; cc <= c0 + reach; cc++) {
      if (cc < 0 || cc >= W || rr < 0 || rr >= H) continue;
      const i = rr * W + cc;
      if (m.kinds[i] !== 1 || !wet || !Number.isFinite(wet[i])) continue;
      const dist = Math.hypot((cc + 0.5 - q.gx) * cw, (rr + 0.5 - q.gy) * ch) * q.k;
      if (dist <= NEAR_M) near.push(i);
      if (dist <= SNAP_M && (!best || dist < best.dist)) best = { i, dist };
    }
    const cells = near.length ? near : best ? [best.i] : [], zones = new Map();
    for (const i of cells) if (P.zoneOf && P.zoneOf[i] >= 0) zones.set(P.zoneOf[i], (zones.get(P.zoneOf[i]) || 0) + 1);
    const mean = (f) => { const v = cells.map(f).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const off = offLawnM([r.lng, r.lat], trace), kind = i0 >= 0 ? m.kinds[i0] : null;
    return { n: r.n, value: r.value, wet: cells.length ? mean((i) => wet[i]) : null, need: cells.length && P.needMm ? mean((i) => P.needMm[i]) : null,
      zone: zones.size ? [...zones.entries()].sort((a, b) => b[1] - a[1])[0][0] : null, kind, lawn: onLawn(off, kind) ? 1 : 0, off, cells: cells.length };
  });
  const lawn = spots.filter((x) => x.lawn && x.wet !== null);
  self.postMessage({ visitCheck: { id, rho: spearman(lawn.map((x) => x.value), lawn.map((x) => x.wet)), n: lawn.length, spots, reaches: dAt >= 0,
    settings: { date, depth_in, rootMm: P.rootIn ? Math.round(P.rootIn * 25.4) : null, season: P.mode || null, irrigated: 'rain alone', onTraceM: ON_TRACE_M, nearM: NEAR_M } } });
}

/* THE PLAN ON THE PERSON'S OWN VALVES (owner, 2026-10-23: "a final step that gives exact watering recs by season
   and zone"): the same ten years, each valve's lawn (public/heads.js, from where its heads throw) watered as one. */
function valvePlan({ inputs, zoneOf, id }) {
  if (!kept.r || !kept.typical) { self.postMessage({ valvePlan: { id, error: 'not ready' } }); return; }
  const p = planWith(inputs || kept.inputs || {}, zoneOf);
  self.postMessage({ valvePlan: { id, zones: p.zones, thisWeek: p.thisWeek, multiplier: p.multiplier, weather: p.weather, years: p.years, grass: p.grass, seasonDays: kept.season ? kept.season.size : null, rootIn: p.rootIn } });
}

async function plan(inputs = {}) {
  const t0 = Date.now();
  const p = planWith(inputs);
  kept.model = p.model; // the heat view's (heatFor): the plan's own model, never sent to the page
  kept.planKept = { zoneOf: p.zoneOf ? p.zoneOf.slice() : null, needMm: p.needMm ? p.needMm.slice() : null, rootIn: p.rootIn, mode: p.mode }; // the server's visit check (visitCheck)
  kept.ksRain = null; // how wet the ground runs with rain alone, month by month: worked out again on the heat view's first ask
  const grass = p.grass;
  const out = {
    /* kinds and soilAt are the model's own arrays: the page gets copies, since the transfer below empties what it sends
       (in a browser; Node's stand-in does not), and the model here goes on reading them -- a walk scored, the heat view,
       the explorer. Until 2026-11-17 the originals went, and a page's checks ran on a model with neither. */
    zones: p.zones, zoneOf: p.zoneOf, kinds: Uint8Array.from(p.kinds), needMm: p.needMm, soilAt: Int16Array.from(p.soilAt), multiplier: p.multiplier, rootIn: p.rootIn, needMonth: p.needMonth, wetFromWatering: p.wetFromWatering, wetAnyway: p.wetAnyway, dryShare: p.dryShare,
    roofs: p.roofs, soil: p.soil, weather: p.weather, thisWeek: p.thisWeek, years: p.years, topsoil: p.topsoil,
    standIn: kept.standIn, seconds: (Date.now() - t0) / 1000, shaded: p.shaded, lightByMonth: p.lightByMonth, ownRadiation: p.ownRadiation, fences: p.fences, treeCool: p.treeCool, yardWind: p.yardWind, windInfo: kept.windInfo || null, windJuly: kept.windMonths ? kept.windMonths[6].slice() : null, localWind: kept.wind || null, lightInfo: kept.lightInfo || null, shape: kept.shape || null, sunShare: p.sunShare,
    seasonDays: kept.season ? kept.season.size : null, grass, roots: p.roots, mode: p.mode, kc: p.kc, stress: p.stress, rainFrom: kept.rainFrom, weatherFrom: kept.weatherFrom, weekFrom: kept.week?.weatherFrom || null, rainShaped: kept.rainShaped || 0, rainStation: kept.rainShaped ? kept.wind.station : null, texture: p.texture,
    trees: p.trees, treeMm: p.treeMm,
    trouble: Object.values(kept.sources || {}).filter(Boolean), groundwater: p.groundwater, perched: p.perched, snapshots: p.snapshots || null,
  };
  self.postMessage({ plan: out }, [out.zoneOf.buffer, out.kinds.buffer, out.soilAt.buffer, out.needMm.buffer, out.wetFromWatering.buffer, out.wetAnyway.buffer, out.dryShare.buffer]);
}

/* THE SAME MAP EVERY LOAD (owner, 2026-10-19: "the map loads a bit differently each time... there wasn't a
   zone 3 this time"). Every outside source is asked up to three times before the plan goes without it, the
   plan is shown once -- with the shade already in it -- and the page says which source, if any, did not
   answer. */
async function again(fn, tries = 3) {
  let last;
  for (let k = 0; k < tries; k++) {
    try { const v = await fn(); if (v !== null && v !== undefined) return v; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 1500 * (k + 1)));
  }
  if (last) throw last;
  return null;
}

async function start(site, inputs) {
  kept.wholeLot = !!site.wholeLot; // the whole property marked as lawn: its paving stays paving (lib/plan.js)
  const io = await workerIo('/lib');
  const pickCloud = async (lng, lat) => {
    const res = await fetch(`/api/shade/lidar?lng=${lng}&lat=${lat}`);
    if (!res.ok) throw new Error(`the lidar search answered ${res.status}`);
    return res.json();
  };
  const progress = (done, total) => self.postMessage({ progress: { done, total } });
  // the soil and the weather do not wait for the lidar
  const lng = site.lng, lat = site.lat;
  const soilP = again(() => {
    const d = 120 / 111320, e = d / Math.cos((lat * Math.PI) / 180);
    return soilFor([lng - e, lat - d, lng + e, lat + d], (q) => sdaPost(q)).then((x) => (x.units.length ? x : null));
  }).catch((err) => ({ units: [], error: err.message })).then((x) => x || { units: [], error: 'no answer' });
  /* EACH SOIL IN ITS OWN PLACE (H62): the USGS 10 m ground and the survey's map over the same window (600 m round),
     fetched now beside the lidar; the hillside reading after the plan uses the same ground. */
  const demP = again(() => demAround(lng, lat)).catch(() => null);
  /* THE WATER ROUND THE LAWN (H70): streams, lakes and ponds (NHDPlus HR) and wetlands (NWI) within 900 m, through this
     site's cached route, for the water table under the lawn -- fetched now, beside the lidar, for the plan. */
  const waterP = again(() => Promise.all([streamsNear(lng, lat, { via: '/api/water/streams', radiusM: 900 }), waterNear(lng, lat, { via: '/api/water/streams', radiusM: 900 })]), 2).catch((e) => ({ error: e.message || String(e) }));
  const soilWinP = again(() => {
    const d = RADIUS_M / 111320, e = d / Math.cos((lat * Math.PI) / 180);
    return soilFor([lng - e, lat - d, lng + e, lat + d], (q) => sdaPost(q));
  }).catch(() => null);
  const typicalP = again(() => typicalYears(lat, lng));
  const weekP = again(() => thisWeek(lat, lng, { back: 60 })).catch(() => null);
  /* THE SOIL'S TEMPERATURE DAY BY DAY (H53): IEMRE's 4-inch soil (a modelled 0-7 cm layer) for each of the plan's ten years and this one, for
     the roots' rise and fall; kept with the map (the water part) for a season. */
  const yNow = new Date().getUTCFullYear();
  const soilTempP = soilDaysOver(lat, lng, yNow - 10, yNow).then((m) => (m.size ? m : null)).catch(() => null);
  /* THE LOCAL WIND (H48): the nearest airport station's ten years, summed -- kept with the map (the water part) and
     used as it is for half a year; otherwise fetched again, beside the lidar, and sent to the page to keep. */
  const keptWind = inputs.wind?.stats && inputs.wind.at && Date.now() - Date.parse(inputs.wind.at) < 182 * 864e5 ? inputs.wind : null;
  const windP = keptWind ? Promise.resolve(keptWind)
    : fetch('/data/asos-stations.json').then((x) => x.json()).then((list) => localWind(list, lat, lng)).then((w) => { if (w) self.postMessage({ wind: w }); return w; }).catch(() => null);
  // the shade map's typical year (its own reader, lib/shade/climate.js): its growing season and its light
  const y1 = new Date().getUTCFullYear() - 1;
  /* THE SHADE MAP'S OWN CLIMATE (its /api/shade/climate, through this site's Worker): the same typical year, with
     its soil temperature IEMRE's where IEMRE answers (owner, 2026-10-26: "switch to the Iowa model as long as it
     holds true to other locations"; the features session's 111-station test, SHADE-FINDINGS 29), so the two maps'
     growing seasons agree. NASA POWER read here directly, as before, when that does not answer. */
  const fromShade = () => fetch(`/api/shade/climate?lng=${lng}&lat=${lat}`).then((x) => (x.ok ? x.json() : null))
    .then((c) => (c && Array.isArray(c.tMean) && c.tMean.length >= 365 && Array.isArray(c.ghi) ? c : null)).catch(() => null);
  const climateP = fromShade().then((c) => c || again(() => fetch(powerUrl(lng, lat, y1 - 9, y1)).then((x) => x.json()).then((p) => ({ ...typicalYear(p), tSoilSource: 'nasa' })))).catch(() => null);

  const r = await runSite(site, io, pickCloud, { progress });
  if (r.error) { self.postMessage({ error: r.error, notOnAws: r.notOnAws }); return; }
  const res = r.result, g = res.grid;
  /* THE WIND'S OBSTACLES, WIDE (H50): the lidar's coarse levels 150 m round the grid, and Overture's buildings there,
     fetched beside the soil and the weather (owner: "If you have to pull a wider area for lidar than you currently
     do, do what you need to do"). */
  const PAD = 150;
  const wideP = (async () => {
    const url = site.lidar?.url || r.cloud?.url;
    if (!url || !site.lawn?.length) return null;
    const cm = (g.bbox[2] - g.bbox[0]) / g.W, wide = [g.bbox[0] - PAD * cm, g.bbox[1] - PAD * cm, g.bbox[2] + PAD * cm, g.bbox[3] + PAD * cm];
    // a tile-only flight not yet on the server: a minute's wait at most, then the wind goes without the wide box (it has the shade map's grid)
    const [pts, ov] = await Promise.all([pointsIn(url, wide, io, { spacingM: 1.8, lat, tries: 12 }), overtureFor(wide).catch(() => null)]);
    /* the wide box's points moved onto the web map's ground like the lawn's own (the shade map's kept shift, 3857
       units; the core session, 2026-11-18: this box was gridded unmoved, about a metre off, the wind's obstacles only) */
    const sh = Array.isArray(site.lidar?.shift) ? site.lidar.shift : null;
    const cols = sh && (sh[0] || sh[1]) ? { ...pts.cols, x: Float64Array.from(pts.cols.x, (v) => v + sh[0]), y: Float64Array.from(pts.cols.y, (v) => v + sh[1]) } : pts.cols;
    return obstacleGrid(cols, wide, lat, 4, { buildings: ov?.buildings || null });
  })().catch(() => null);
  const reported = new Uint8Array(g.W * g.H);
  // 2: a lawn hollow (on the traced lawn, when there is one); 1: any other reported spot
  for (const s of res.spots.spots) {
    if (!s.reported) continue;
    const onLawn = !r.lawnMask || s.cells.some((i) => r.lawnMask[i]);
    const v = s.kind === 'hollow' && onLawn ? 2 : 1;
    for (const i of s.cells) if (res.spots.depth[i] >= 0.005) reported[i] = v;
  }
  const grade = new Float32Array(g.W * g.H).fill(NaN);
  for (const w of res.beside.walls) grade[w.i] = w.fallAway;
  // copies go to the page: the worker keeps its own for the plan
  const out = {
    grid: { W: g.W, H: g.H, cell: g.cell, k: g.k, bbox: g.bbox, lat: g.lat },
    shift: res.shift,
    depth: res.spots.depth.slice(), reported, z: Float32Array.from(res.z), flow: (r.weightedFlow || res.runoff.area).slice(), weighted: !!r.weightedFlow, wall: res.wall.slice(), grade,
    paved: r.impervious ? r.impervious.paved.slice() : null,
    parcelMask: r.parcelMask, lawnMask: r.lawnMask,
    spots: r.spots, hasLawn: r.hasLawn, summary: { ...r.summary, noiseRuns: undefined }, cloud: r.cloud,
    trunks: res.trunks || null,
    photoFrame: r.greenFrame || null, // which summer photo the rule read (shade/naip.js): the frame nearest the flight, or the mosaic
  };
  const transfer = [out.depth.buffer, out.z.buffer, reported.buffer, out.flow.buffer, out.wall.buffer, grade.buffer, ...(out.paved ? [out.paved.buffer] : [])];
  self.postMessage({ done: out }, transfer);

  self.postMessage({ planProgress: 'Reading the soil survey and ten years of weather…' });
  kept.r = r; kept.lng = lng; kept.lat = lat;
  kept.lawn = r.lawnMask || standInLawn(res); kept.standIn = !r.lawnMask;
  kept.soil = await soilP;
  kept.placement = null;
  try {
    const [dem, win] = await Promise.all([demP, soilWinP]);
    if (dem) kept.dem = { dem, t: terrain(dem) };
    if (dem && win?.units?.length && kept.soil.units?.length) {
      const pl = placeSoils(kept.soil.units, win.units, dem, kept.dem.t);
      if (pl.byUnit.size) kept.placement = { byUnit: pl.byUnit, twi: twiForGrid(dem, pl.twi, res.grid) };
    }
  } catch { kept.placement = null; }
  /* THE WATER TABLE UNDER THE LAWN (H70; lib/groundwater.js): the water levels round each lawn cell (the mapped water
     within a kilometre, inverse-distance weighted, all of it and the permanent alone), and the lawn's height above the
     nearest water down the flow path (the mapped water burned into the 10 m ground), for the plan and the page. */
  kept.groundwater = null;
  try {
    const wat = await waterP;
    if (wat?.error) throw new Error(`the national water maps did not answer (${wat.error})`);
    if (kept.dem && wat) {
      const { dem, t } = kept.dem, [streams, near] = wat;
      const hold = waterOnGround(dem, t, { streams, bodies: near.bodies, wetlands: near.wetlands });
      const g = res.grid, N = g.W * g.H, at = new Int32Array(N).fill(-1), cells = new Set();
      for (let i = 0; i < N; i++) if (kept.lawn[i]) { const [x, y] = g.toMerc(i % g.W, Math.floor(i / g.W)); const j = demCell(dem, x, y); at[i] = j; if (j >= 0) cells.add(j); }
      const lv = waterLevels(dem, hold, cells);
      const levelAny = new Float32Array(N).fill(NaN), levelPerm = new Float32Array(N).fill(NaN);
      for (let i = 0; i < N; i++) if (at[i] >= 0) { const v = lv.get(at[i]); levelAny[i] = v.any; levelPerm[i] = v.perm; }
      const hg = handGrid(dem, burnedTerrain(dem, hold, terrain), hold);
      const mid = (arr) => { const v = [...cells].map((j) => arr[j]).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
      // the nearest water of each kind to the lawn's cells, straight-line, and what it is
      const lawnCells = [...cells], cs = dem.cell;
      const nearest = (want) => { let best = null; for (let k = 0; k < hold.length; k++) { if (!want(hold[k])) continue; const kr = Math.floor(k / dem.W), kc = k % dem.W; for (const j of lawnCells) { const d = Math.hypot(kr - Math.floor(j / dem.W), kc - (j % dem.W)) * cs; if (!best || d < best.m) best = { m: d, level: dem.z[k] }; } } return best; };
      const wetlandAtLawn = lawnCells.filter((j) => hold[j] === 1 || hold[j] === 2).length / Math.max(1, lawnCells.length);
      kept.groundwater = {
        levelAny, levelPerm,
        summary: {
          handPermM: mid(hg.perm.h), handAnyM: mid(hg.wet.h), permanent: nearest((h) => h === 1), seasonal: nearest((h) => h === 1 || h === 2),
          ponds: near.bodies.length, wetlands: near.wetlands.length, streams: streams.length, wetlandAtLawn,
          wetlandKinds: [...new Set(near.wetlands.map((w) => w.code))].slice(0, 12),
        },
      };
    }
  } catch (e) { kept.groundwater = null; self.postMessage({ groundwaterError: e.message || String(e) }); }
  if (!kept.groundwater && !kept.dem) self.postMessage({ groundwaterError: 'the USGS 10 m ground did not answer' });
  const typ = await typicalP;
  kept.typical = typ.days; kept.rainFrom = typ.rainFrom; kept.weatherFrom = typ.weatherFrom || 'NASA POWER (about 50 km)';
  kept.week = await weekP;
  kept.wind = await windP;
  kept.soilDays = await soilTempP;
  /* THE TEN YEARS' CLOUDBURSTS (to-do 7, H52): the station's hourly rain over the same ten years gives each rainy day
     of the plan its hours, so rain falling faster than the lawn takes it runs off in the ten-year plan too. */
  kept.rainShaped = 0;
  try {
    if (kept.wind?.station?.id) {
      const yEnd = new Date().getUTCFullYear() - 1;
      const hours = await stationRain(kept.wind.station.id, yEnd - 9, yEnd);
      kept.rainShaped = attachStationHours(kept.typical, hours);
    }
  } catch { kept.rainShaped = 0; }
  kept.climate = await climateP;
  // the shade first, so the plan is shown once, with it (lib/shade/light-worker.js)
  kept.shade = site.lawn?.length ? 'failed' : 'no traced lawn';
  if (site.lawn?.length && kept.climate && typeof Worker !== 'undefined') {
    self.postMessage({ planProgress: 'Working out the shade on the lawn…' });
    kept.season = seasonFor(inputs.grass === 'warm' ? 'warm' : 'cool');
    site.cloudSeason = r.cloud?.season || null;
    site.green = r.green || null;
    /* the fused model when this lawn has one (fusedFor), else the lidar; a fused file that will not stand (a grid that
       is not this map's, a worker error) is set aside and the lidar used, with the reason kept for the report */
    site.fused = site.noFused ? null : await fusedFor(site, res.grid).catch((e) => { kept.fusedWhy = `the fused model could not be read (${e?.message || e})`; return null; });
    let lit = await again(() => lawnLight(res, site, kept.climate, kept.season), 2).catch((e) => { kept.shadeWhy = e?.message || String(e); return null; });
    if (!lit && site.fused) {
      kept.fusedWhy = `the fused model was set aside (${kept.shadeWhy || 'no light worked out'})`; kept.shadeWhy = null; site.fused = null;
      lit = await again(() => lawnLight(res, site, kept.climate, kept.season), 2).catch((e) => { kept.shadeWhy = e?.message || String(e); return null; });
    }
    kept.shape = site.fused ? { model: 'fused', at: site.fused.at, from: site.fused.from } : { model: 'lidar', why: site.noFused ? 'asked for the lidar alone' : kept.fusedWhy || null };
    kept.lightRes = res; kept.lightSite = site; // a walk's moments ask the light worker again (walkCheck)
    kept.light = lit?.summer || null; kept.lightMonths = lit?.months || null; kept.radiation = lit?.radiation || null;
    // the fences' longwave on the lawn (H49): the shade map's fences, seen from each lawn cell
    // EACH SPOT'S OWN WIND (H50): what stands upwind of it, by direction, weighted by the station's daytime wind
    kept.windMonths = null; kept.windInfo = null;
    try {
      self.postMessage({ planProgress: 'Working out the wind at each spot of the lawn…' });
      const og = await wideP;
      const cells = []; for (let i = 0; i < kept.lawn.length; i++) if (kept.lawn[i]) cells.push(i);
      if (cells.length && (og || kept.shadeKinds)) {
        const gr = { W: res.grid.W, H: res.grid.H, bbox: res.grid.bbox };
        const wg = windGrid(gr, og, nearHeights(res.points, gr, res.z), kept.shadeKinds, PAD);
        const cm = (gr.bbox[2] - gr.bbox[0]) / gr.W;
        const toCell = (p) => { const [mx, my] = toMercS(p); return [(mx - gr.bbox[0]) / cm + PAD, (gr.bbox[3] - my) / cm + PAD]; };
        const fz = site.shadeEdits?.fences?.length ? fencesOnGrid(cleanFences(site.shadeEdits.fences), toCell, () => 0, 1) : [];
        const sd = shelterByDirection(wg, cells, gr.W, PAD, PAD, fz);
        const cal = kept.climate?.tMean ? leafCalendar(kept.climate.tMean) : null;
        const leaf = Array.from({ length: 12 }, (_, m) => { if (!cal) return m >= 4 && m <= 9 ? 1 : 0; let a = 0; for (let k = MONTH_START[m]; k < MONTH_START[m + 1]; k++) a += cal.share(k); return a / (MONTH_START[m + 1] - MONTH_START[m]); });
        const roses = kept.wind?.stats?.byMonth?.map((b) => b.rose) || null;
        const months = monthlyShelter(sd, cells.length, roses, leaf);
        let mx = 0, my = 0; for (const i of cells) { mx += i % gr.W; my += Math.floor(i / gr.W); }
        const cover = coverWithin(wg, mx / cells.length + PAD, my / cells.length + PAD, 90);
        const yard = windShare(100 * cover);
        const fit = calibrate(months, yard);
        const N = gr.W * gr.H;
        kept.windMonths = fit.map(({ F }) => { const a = new Float32Array(N).fill(yard); cells.forEach((i, q) => { a[i] = F[q]; }); return a; });
        const med = (a) => { const v = cells.map((i) => a[i]).sort((x, y) => x - y); return v[v.length >> 1]; };
        const lo = (a) => { const v = cells.map((i) => a[i]).sort((x, y) => x - y); return v[Math.floor(0.1 * (v.length - 1))]; };
        kept.windInfo = { cover, yard, wide: !!og, fences: fz.length, July: { median: med(kept.windMonths[6]), calmest: lo(kept.windMonths[6]) }, B: fit.map((f) => Math.round(f.B * 100) / 100), rose: !!roses };
      }
    } catch { kept.windMonths = null; kept.windInfo = null; }
    kept.fenceHeat = null;
    if (kept.radiation && site.shadeEdits?.fences?.length) {
      try {
        const cells = []; for (let i = 0; i < kept.lawn.length; i++) if (kept.lawn[i]) cells.push(i);
        kept.fenceHeat = fenceRadiation(site.shadeEdits.fences, { W: res.grid.W, H: res.grid.H, bbox: res.grid.bbox, cell: 1 }, res.z, cells, lat, lng, undefined, kept.radiation);
      } catch { kept.fenceHeat = null; }
    }
    if (kept.light) kept.shade = 'ok';
  }
  kept.sources = {
    soil: kept.soil.error ? `the soil survey did not answer (${kept.soil.error}); a loam is assumed` : null,
    weather: null,
    week: kept.week ? null : "this week's weather did not answer",
    overture: r.summary.overture ? null : 'Overture did not answer: roofs and paving from the laser and the photo only',
    photo: r.summary.pavingFromPhoto || !r.lawnMask ? null : 'the USDA photo did not answer: paving and roofs from the laser only',
    shade: kept.shade === 'failed' ? `the shade could not be worked out${kept.shadeWhy ? ` (${kept.shadeWhy})` : ''}: the lawn is taken as in full sun` : null,
  };
  self.postMessage({ planProgress: 'Working out the watering plan…' });
  await plan(inputs);
  // the hillside above the lawn (USGS 10 m ground, 600 m round): after the plan, so it never holds it up
  try {
    const pts = [];
    const g = res.grid;
    for (let r0 = 0; r0 < g.H; r0 += 3) for (let c0 = 0; c0 < g.W; c0 += 3) if (kept.lawn[r0 * g.W + c0]) pts.push(res.lngLat(r0 + 0.5, c0 + 0.5));
    if (!pts.length) pts.push([lng, lat]);
    const dem = kept.dem?.dem || await demAround(lng, lat);
    self.postMessage({ hill: hillside(dem, kept.dem?.t || terrain(dem), pts) });
  } catch (e) {
    self.postMessage({ hill: { error: e.message || String(e) } });
  }
  /* STREAMS AND THE FLOOD PLAIN (H63): the streams within a kilometre (NHDPlus HR) and FEMA's flood map, against the
     lawn's own lidar ground; the streams' water from the 10 m ground. After the plan; on the page only. */
  try {
    const g = res.grid, lawn = [];
    for (let i = 0; i < kept.lawn.length; i++) if (kept.lawn[i] && Number.isFinite(res.z[i])) lawn.push({ p: res.lngLat(Math.floor(i / g.W) + 0.5, (i % g.W) + 0.5), z: res.z[i] });
    if (lawn.length) {
      const xs = lawn.map((c) => c.p[0]), ys = lawn.map((c) => c.p[1]);
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const [streams, flood] = await Promise.all([again(() => streamsNear(lng, lat, { via: '/api/water/streams' })).catch(() => null), again(() => floodNear(lng, lat, box)).catch(() => null)]);
      const dem = kept.dem?.dem || null;
      const waterAt = dem ? ([x0, y0]) => {
        const [mx, my] = toMercS([x0, y0]), cs = (dem.bbox[2] - dem.bbox[0]) / dem.W;
        const c = Math.floor((mx - dem.bbox[0]) / cs), r = Math.floor((dem.bbox[3] - my) / cs);
        let lo = Infinity;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= dem.H || cc >= dem.W || dr * dr + dc * dc > 4) continue; const v = dem.z[rr * dem.W + cc]; if (Number.isFinite(v) && v < lo) lo = v; }
        return Number.isFinite(lo) ? lo : null;
      } : null;
      const reading = streams || flood ? streamReading({ streams: streams || [], flood, lawn, waterAt }) : null;
      // a stream beyond the 10 m window: its water from USGS's point elevation service (1 m where it has it)
      for (const k of ['perennial', 'nearest']) {
        const st = reading?.[k];
        if (!st || Number.isFinite(st.waterM) || !st.at) continue;
        try {
          const j = await (await fetch(`https://epqs.nationalmap.gov/v1/json?x=${st.at[0]}&y=${st.at[1]}&units=Meters&wkid=4326`, { signal: AbortSignal.timeout(20000) })).json();
          const v = Number(j?.value);
          if (Number.isFinite(v) && v > -500) { st.waterM = v; st.aboveM = reading.lawnM - v; st.waterFrom = 'point'; }
        } catch { /* left without */ }
      }
      self.postMessage({ streams: reading ? { ...reading, streamsOk: !!streams, floodOk: !!flood } : { error: 'neither the national stream map nor FEMA\'s flood map answered' } });
    }
  } catch (e) {
    self.postMessage({ streams: { error: e.message || String(e) } });
  }
}

/**
 * The share of open-sky sunlight each lawn cell gets over the growing season's summer (June-August
 * days in it, every 4th), from the shade map's light worker (lib/shade/light-worker.js, copied
 * unchanged): its daily light integral against the open sky's, with NASA's clouds.
 */
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]; // day indices, as climate.js dayIndex

/* THE LIGHT WORKER, SET UP ONCE (the plan's months; a walk's moments): its worker, one question at a time, and the
   canopy built as the plan builds it. -> { ask, build(erased), edits, passes, close } */
/**
 * THE FUSED MODEL OF A MAP, OR NULL (docs/MAPS.md "The fused model"; the core session's contract, 2026-11-23): the
 * file beside the map's lidar model, through the account routes the page already uses (the water builder's stand-in
 * answers the same address from what the water Worker hands it). Used only when its grid is this map's box cut a
 * whole number of times finer; anything else is left alone and the lidar used.
 * -> { file: { meta, arrays }, scale, at, from: { lidarAt, walk, walkAt, version } } or null
 */
async function fusedFor(site, g) {
  if (!site.mapId) return null;
  const file = await loadModel((u, init) => fetch(u, { credentials: 'same-origin', ...init }), `/api/maps/model?id=${encodeURIComponent(site.mapId)}&tool=shade&file=fused`);
  if (!file) return null;
  const fg = file.meta?.grid, scale = fg ? Math.round(fg.w / g.W) : 0, cell = (g.bbox[2] - g.bbox[0]) / g.W;
  if (!fg || !file.arrays?.mu || !file.arrays?.ground) throw new Error('not a model file');
  if (scale < 1 || scale > 4 || fg.w !== g.W * scale || fg.h !== g.H * scale || Math.abs(fg.x0 - g.bbox[0]) > cell / 4 || Math.abs(fg.y1 - g.bbox[3]) > cell / 4) throw new Error('its grid is not this map\'s');
  const f = file.meta.fused || {};
  return { file, scale, at: file.meta.at || null, from: { lidarAt: f.lidarAt ?? null, walk: f.walk ?? null, walkAt: f.walkAt ?? null, version: f.version ?? null } };
}

function lightSession(res, site, climate) {
  const g = res.grid;
  const w = new Worker('/lib/shade/light-worker.js', { type: 'module' });
  // one message out, the next answer back (the worker answers in order)
  let waiting = null;
  w.onmessage = ({ data: m }) => { if (!waiting || m.type === 'progress') return; const k = waiting; waiting = null; if (m.type === 'error') k.reject(new Error(m.message)); else k.resolve(m); };
  w.onerror = (e) => { if (waiting) { const k = waiting; waiting = null; k.reject(new Error(e.message || 'the light worker stopped')); } };
  const ask = (msg) => new Promise((resolve, reject) => { waiting = { resolve, reject }; w.postMessage(msg); });
  /* ONE LEAF STATE OVER THE LOT (the shade map's passes.js, 2026-10-29): a survey's passes can be months apart, one
     in leaf and one not; each point carries its day (lib/las.js leafOfMs, set in ept.js cropRecords). Over the
     analysis box, one state wins where the larger pass alone covers it, and the other pass's points are left out;
     otherwise 'mixed' and the canopy judges column by column. The same call the shade page makes, on the same points. */
  const passes = onePass(res.points, g.bbox, Math.cos((site.lat * Math.PI) / 180));
  /* THE SUMMER CANOPY (FINDINGS H44): as the shade map draws it -- a leaf-off flight's crowns given their leaves
     back from this place's typical temperatures (light-worker.js 'seasonal'; before 2026-10-27 the water map
     asked for the crowns as flown, bare branches on a November flight) -- and without the trees and branches
     erased on the shade map. */
  const edits = erasedOn(site.shadeEdits, { W: g.W, H: g.H, bbox: g.bbox });
  /* THE FUSED MODEL, WHERE THE LAWN HAS ONE (owner, 2026-11-24: "make it use the fused map when available. Not all
     lawns will have fused maps, so we need to support both... you'll still get shade as it's calculated by the shade
     map"). The shade is the shade map's light worker either way; only what it stands on differs: the lidar's points
     ('build', as before), or the fused file (docs/MAPS.md: the lidar and a yard walk, on a half-metre grid), given
     whole to the worker's 'model' path as the shade page gives it. The fused grid is `scale` cells to one of the
     water map's: places asked are multiplied by it, answers are brought back down. The trees and branches erased on
     the shade map are already out of a model file, so only a further erasure (the crowns, for the buildings-alone
     run) is sent, on the fine grid. */
  const fused = site.fused || null, scale = fused ? fused.scale : 1;
  const fine = (mask) => {
    if (!mask || scale === 1) return mask || undefined;
    const FW = g.W * scale, out = new Uint8Array(FW * g.H * scale);
    for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) if (mask[r * g.W + c]) for (let dr = 0; dr < scale; dr++) out.fill(1, (r * scale + dr) * FW + c * scale, (r * scale + dr) * FW + (c + 1) * scale);
    return out;
  };
  // a fine grid's kinds on the water grid: a building anywhere in the square, else the commonest thing standing in it
  const coarseKinds = (k) => {
    if (!k || scale === 1) return k;
    const FW = g.W * scale, out = new Uint8Array(g.W * g.H), n = new Uint8Array(8);
    for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
      n.fill(0);
      for (let dr = 0; dr < scale; dr++) for (let dc = 0; dc < scale; dc++) n[k[(r * scale + dr) * FW + c * scale + dc] & 7]++;
      let best = 0;
      if (n[1]) best = 1;
      else { let top = 3; for (const v of [2, 4]) if (n[v] > n[top]) top = v; if (n[top] * 2 >= scale * scale) best = top; }
      out[r * g.W + c] = best;
    }
    return out;
  };
  const build = async (erased) => {
    const common = { lat: site.lat, lng: site.lng, lot: polygonsOf(site.lawn), lawn: polygonsOf(site.lawn), canopy: 'seasonal', tMean: Array.isArray(climate?.tMean) ? climate.tMean : null,
      // the fences drawn on the shade map (its part, v 3): their shade too, as the shade map works it out
      fences: site.shadeEdits?.fences?.length ? site.shadeEdits.fences : undefined };
    const m = fused
      ? await ask({ type: 'model', file: fused.file, ...common, erased: erased === edits.erased ? undefined : fine(erased) })
      : await ask({ type: 'build', cols: passes.cols, box: g.bbox, shift: null, ...common,
        green: site.green || null, // the summer photo's green: the shade map's low-structure rule needs it (2026-11-04; set on site by start, as cloudSeason is)
        flight: site.cloudSeason || null, erased, erasedCubes: edits.cubes });
    if (m.w !== g.W * scale || m.h !== g.H * scale) throw new Error('the shade grid is not the water grid');
    return scale === 1 ? m : { ...m, kinds: coarseKinds(m.kinds), fineW: m.w, w: g.W, h: g.H };
  };
  /** The sun's beam through the canopy at places and minutes: pts [gx, gy, t, ...] in the water grid's cells. */
  const samples = async (pts, heightM = 0.1) => {
    let q = pts;
    if (scale !== 1) { q = Float64Array.from(pts); for (let i = 0; i < q.length; i += 3) { q[i] *= scale; q[i + 1] *= scale; } }
    return (await ask({ type: 'samples', pts: q, heightM })).T;
  };
  return { ask, build, samples, scale, edits, passes, close: () => w.terminate() };
}

function lawnLight(res, site, climate, season) {
  const g = res.grid, N = g.W * g.H;
  const L = lightSession(res, site, climate);
  const { ask, build, edits, passes } = L;
  const perCell = (m, scale = 1) => {
    const a = new Float32Array(N).fill(1);
    if (!m.dli || !(m.openDli > 0)) return null;
    const S = L.scale;
    if (S === 1) {
      for (let p = 0; p < m.dli.length; p++) {
        const x = Math.floor(m.xy[2 * p]), y = Math.floor(m.xy[2 * p + 1]);
        if (x >= 0 && y >= 0 && x < g.W && y < g.H) a[y * g.W + x] = Math.max(0, Math.min(1, (m.dli[p] / m.openDli) * scale));
      }
      return a;
    }
    // the fused model's finer grid: a water cell is the mean of the points the worker has inside it
    const sum = new Float32Array(N), n = new Uint16Array(N);
    for (let p = 0; p < m.dli.length; p++) {
      const x = Math.floor(m.xy[2 * p] / S), y = Math.floor(m.xy[2 * p + 1] / S);
      if (x >= 0 && y >= 0 && x < g.W && y < g.H) { sum[y * g.W + x] += Math.max(0, Math.min(1, (m.dli[p] / m.openDli) * scale)); n[y * g.W + x]++; }
    }
    for (let i = 0; i < N; i++) if (n[i]) a[i] = sum[i] / n[i];
    return a;
  };
  const monthDays = (mo) => { const md = []; for (let k = MONTH_START[mo] + 1; k < MONTH_START[mo + 1]; k += 3) md.push(k); return md; };
  // the same climate with all of the sun as beam, or all of it as sky: the share each cell gets of each (its sky view)
  const beamOnly = { ...climate, diffuse: new Array(365).fill(0) }, skyOnly = { ...climate, diffuse: new Array(365).fill(1) };
  const months = async (clim) => { const out = []; for (let mo = 0; mo < 12; mo++) { const a = perCell(await ask({ type: 'period', days: monthDays(mo), climate: clim })); if (!a) return null; out.push(a); } return out; };
  const work = (async () => {
    const m = await build(edits.erased);
    kept.lightInfo = { canopy: m.canopy, why: m.seasonsWhy || null, fences: m.fences || 0, erased: edits.cells, blocks: edits.blocks, blocksLost: edits.blocksLost, season: site.cloudSeason || null, inLeafColumns: m.inLeafColumns || 0, passes: { season: passes.season, off: passes.off, on: passes.on, dropped: passes.dropped } };
    // the shade map's own reading of every cell (0 open, 1 roof, 2 evergreen, 3 deciduous): its trees, for the air and the wind
    const kinds = m.kinds && m.kinds.length === N ? Uint8Array.from(m.kinds) : null;
    kept.shadeKinds = kinds;
    // the summer (the zones and the report go by it)
    const days = [];
    for (let k = 151; k <= 242; k += 4) if (!season || season.has(k)) days.push(k);
    const summer = perCell(await ask({ type: 'period', days, climate }));
    if (!summer) return null;
    /* THROUGH THE YEAR (owner, 2026-10-27: "the way that shade changes throughout the year as canopy cover changes
       and the position of the sun changes (again, the shade map does that)"): every third day of each month, the
       leaves as its calendar has them that day and the sun where it is. */
    const byMonth = await months(climate);
    /* A SPOT'S OWN RADIATION (H47): of the sun's beam and of the sky, the share each cell sees, with the trees and
       with the buildings alone (every crown column erased, as the trees step's eraser does), so the water map can
       put the near-infrared through the crowns and count the sky the grass loses its heat to. */
    let radiation = null;
    if (byMonth && kinds) {
      const beam = await months(beamOnly), sky = await months(skyOnly);
      const noCrowns = edits.erased ? Uint8Array.from(edits.erased) : new Uint8Array(N);
      for (let i = 0; i < N; i++) if (kinds[i] === 2 || kinds[i] === 3) noCrowns[i] = 1;
      await build(noCrowns);
      const beamB = await months(beamOnly), skyB = await months(skyOnly);
      if (beam && sky && beamB && skyB) radiation = { beam, sky, beamB, skyB };
    }
    return { summer, months: byMonth, radiation };
  })();
  // four minutes in a browser; the water builder (builder/headless.mjs), on a slower shared CPU, sets its own
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('the shade took too long')), globalThis.WATER_SHADE_MS || 240000));
  return Promise.race([work, timer]).finally(() => L.close());
}

self.onmessage = async ({ data }) => {
  try {
    if (data.site) { kept.inputs = data.inputs || {}; await start(data.site, data.inputs || {}); }
    else if (data.replan) { kept.inputs = data.replan; if (kept.r) await plan(data.replan); }
    else if (data.valvePlan) valvePlan(data.valvePlan);
    else if (data.heat) heatFor(data.heat);
    else if (data.surfCheck) surfCheck(data.surfCheck);
    else if (data.walkCheck) await walkCheck(data.walkCheck);
    else if (data.moment) await moment(data.moment);
    else if (data.explain) explain(data.explain);
    else if (data.moistureAt) moistureAt(data.moistureAt);
    else if (data.pointsAt) await pointsAt(data.pointsAt);
    else if (data.cellsAt) cellsAt(data.cellsAt);
    else if (data.visitCheck) visitCheck(data.visitCheck);
  } catch (e) {
    if (data?.heat) { self.postMessage({ heat: { id: data.heat.id, error: e.message || String(e) } }); return; }
    if (data?.surfCheck) { self.postMessage({ surfCheck: { id: data.surfCheck.id, error: e.message || String(e) } }); return; }
    if (data?.walkCheck) { self.postMessage({ walkCheck: { id: data.walkCheck.id, error: e.message || String(e) } }); return; }
    for (const key of ['moment', 'explain', 'moistureAt', 'pointsAt', 'cellsAt', 'visitCheck']) if (data?.[key]) { self.postMessage({ [key]: { id: data[key].id, error: e.message || String(e) } }); return; }
    if (data?.valvePlan) { self.postMessage({ valvePlan: { id: data.valvePlan.id, error: e.message || String(e) } }); return; }
    self.postMessage(kept.r ? { planError: e.message || String(e) } : { error: e.message || String(e) });
  }
};

