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
import { waterPlan } from '/lib/plan.js';
import { demAround, terrain, hillside } from '/lib/upslope.js';
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

function planWith(inputs = {}, zoneOf = null) {
  const { r } = kept;
  const grass = inputs.grass === 'warm' ? 'warm' : 'cool';
  kept.season = seasonFor(grass);
  return waterPlan(r.result, {
    lawnMask: kept.lawn, paved: r.impervious ? r.impervious.paved : null, soil: kept.soil,
    topsoil: !!inputs.topsoil, downspouts: inputs.downspouts || [], gutters: inputs.gutters || [],
    typical: kept.typical, week: kept.week, season: kept.season, species: inputs.species || null, mode: inputs.mode || 'normal', soilTemp: { byDate: kept.soilDays || null, typical: kept.climate?.tSoil || null }, light: kept.light, lightMonths: kept.lightMonths || null, radiation: kept.radiation || null, fenceHeat: kept.fenceHeat || null, windMonths: kept.windMonths || null, shadeKinds: kept.shadeKinds || null, grass,
    texture: inputs.texture || null, parcelMask: r.parcelMask || null, areas: inputs.areas || [], zoneOf,
  });
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
  const grass = p.grass;
  const out = {
    zones: p.zones, zoneOf: p.zoneOf, kinds: p.kinds, needMm: p.needMm, soilAt: p.soilAt, multiplier: p.multiplier, rootIn: p.rootIn, needMonth: p.needMonth, wetFromWatering: p.wetFromWatering, wetAnyway: p.wetAnyway, dryShare: p.dryShare,
    roofs: p.roofs, soil: p.soil, weather: p.weather, thisWeek: p.thisWeek, years: p.years, topsoil: p.topsoil,
    standIn: kept.standIn, seconds: (Date.now() - t0) / 1000, shaded: p.shaded, lightByMonth: p.lightByMonth, ownRadiation: p.ownRadiation, fences: p.fences, treeCool: p.treeCool, yardWind: p.yardWind, windInfo: kept.windInfo || null, windJuly: kept.windMonths ? kept.windMonths[6].slice() : null, localWind: kept.wind || null, lightInfo: kept.lightInfo || null, sunShare: p.sunShare,
    seasonDays: kept.season ? kept.season.size : null, grass, roots: p.roots, mode: p.mode, kc: p.kc, stress: p.stress, rainFrom: kept.rainFrom, rainShaped: kept.rainShaped || 0, rainStation: kept.rainShaped ? kept.wind.station : null, texture: p.texture,
    trouble: Object.values(kept.sources || {}).filter(Boolean),
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
    return obstacleGrid(pts.cols, wide, lat, 4, { buildings: ov?.buildings || null });
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
  };
  const transfer = [out.depth.buffer, out.z.buffer, reported.buffer, out.flow.buffer, out.wall.buffer, grade.buffer, ...(out.paved ? [out.paved.buffer] : [])];
  self.postMessage({ done: out }, transfer);

  self.postMessage({ planProgress: 'Reading the soil survey and ten years of weather…' });
  kept.r = r; kept.lng = lng; kept.lat = lat;
  kept.lawn = r.lawnMask || standInLawn(res); kept.standIn = !r.lawnMask;
  kept.soil = await soilP;
  const typ = await typicalP;
  kept.typical = typ.days; kept.rainFrom = typ.rainFrom;
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
    const lit = await again(() => lawnLight(res, site, kept.climate, kept.season), 2).catch(() => null);
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
    shade: kept.shade === 'failed' ? 'the shade could not be worked out: the lawn is taken as in full sun' : null,
  };
  self.postMessage({ planProgress: 'Working out the watering plan…' });
  await plan(inputs);
  // the hillside above the lawn (USGS 10 m ground, 600 m round): after the plan, so it never holds it up
  try {
    const pts = [];
    const g = res.grid;
    for (let r0 = 0; r0 < g.H; r0 += 3) for (let c0 = 0; c0 < g.W; c0 += 3) if (kept.lawn[r0 * g.W + c0]) pts.push(res.lngLat(r0 + 0.5, c0 + 0.5));
    if (!pts.length) pts.push([lng, lat]);
    const dem = await demAround(lng, lat);
    self.postMessage({ hill: hillside(dem, terrain(dem), pts) });
  } catch (e) {
    self.postMessage({ hill: { error: e.message || String(e) } });
  }
}

/**
 * The share of open-sky sunlight each lawn cell gets over the growing season's summer (June-August
 * days in it, every 4th), from the shade map's light worker (lib/shade/light-worker.js, copied
 * unchanged): its daily light integral against the open sky's, with NASA's clouds.
 */
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]; // day indices, as climate.js dayIndex

function lawnLight(res, site, climate, season) {
  const g = res.grid, N = g.W * g.H;
  const w = new Worker('/lib/shade/light-worker.js', { type: 'module' });
  // one message out, the next answer back (the worker answers in order)
  let waiting = null;
  w.onmessage = ({ data: m }) => { if (!waiting || m.type === 'progress') return; const k = waiting; waiting = null; if (m.type === 'error') k.reject(new Error(m.message)); else k.resolve(m); };
  w.onerror = (e) => { if (waiting) { const k = waiting; waiting = null; k.reject(new Error(e.message || 'the light worker stopped')); } };
  const ask = (msg) => new Promise((resolve, reject) => { waiting = { resolve, reject }; w.postMessage(msg); });
  const perCell = (m, scale = 1) => {
    const a = new Float32Array(N).fill(1);
    if (!m.dli || !(m.openDli > 0)) return null;
    for (let p = 0; p < m.dli.length; p++) {
      const x = Math.floor(m.xy[2 * p]), y = Math.floor(m.xy[2 * p + 1]);
      if (x >= 0 && y >= 0 && x < g.W && y < g.H) a[y * g.W + x] = Math.max(0, Math.min(1, (m.dli[p] / m.openDli) * scale));
    }
    return a;
  };
  const monthDays = (mo) => { const md = []; for (let k = MONTH_START[mo] + 1; k < MONTH_START[mo + 1]; k += 3) md.push(k); return md; };
  // the same climate with all of the sun as beam, or all of it as sky: the share each cell gets of each (its sky view)
  const beamOnly = { ...climate, diffuse: new Array(365).fill(0) }, skyOnly = { ...climate, diffuse: new Array(365).fill(1) };
  const months = async (clim) => { const out = []; for (let mo = 0; mo < 12; mo++) { const a = perCell(await ask({ type: 'period', days: monthDays(mo), climate: clim })); if (!a) return null; out.push(a); } return out; };
  /* ONE LEAF STATE OVER THE LOT (the shade map's passes.js, 2026-10-29): a survey's passes can be months apart, one
     in leaf and one not; each point carries its day (lib/las.js leafOfMs, set in ept.js cropRecords). Over the
     analysis box, one state wins where the larger pass alone covers it, and the other pass's points are left out;
     otherwise 'mixed' and the canopy judges column by column. The same call the shade page makes, on the same points. */
  const passes = onePass(res.points, g.bbox, Math.cos((site.lat * Math.PI) / 180));
  const build = (erased) => ask({ type: 'build', cols: passes.cols, box: g.bbox, lat: site.lat, lng: site.lng, shift: null, lot: polygonsOf(site.lawn), lawn: polygonsOf(site.lawn),
    canopy: 'seasonal', flight: site.cloudSeason || null, tMean: Array.isArray(climate?.tMean) ? climate.tMean : null, erased, erasedCubes: edits.cubes,
    // the fences drawn on the shade map (its part, v 3): their shade too, as the shade map works it out
    fences: site.shadeEdits?.fences?.length ? site.shadeEdits.fences : undefined });
  /* THE SUMMER CANOPY (FINDINGS H44): as the shade map draws it -- a leaf-off flight's crowns given their leaves
     back from this place's typical temperatures (light-worker.js 'seasonal'; before 2026-10-27 the water map
     asked for the crowns as flown, bare branches on a November flight) -- and without the trees and branches
     erased on the shade map. */
  const edits = erasedOn(site.shadeEdits, { W: g.W, H: g.H, bbox: g.bbox });
  const work = (async () => {
    const m = await build(edits.erased);
    if (m.w !== g.W || m.h !== g.H) throw new Error('the shade grid is not the water grid');
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
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('the shade took too long')), 240000));
  return Promise.race([work, timer]).finally(() => w.terminate());
}

self.onmessage = async ({ data }) => {
  try {
    if (data.site) { kept.inputs = data.inputs || {}; await start(data.site, data.inputs || {}); }
    else if (data.replan) { kept.inputs = data.replan; if (kept.r) await plan(data.replan); }
    else if (data.valvePlan) valvePlan(data.valvePlan);
  } catch (e) {
    if (data?.valvePlan) { self.postMessage({ valvePlan: { id: data.valvePlan.id, error: e.message || String(e) } }); return; }
    self.postMessage(kept.r ? { planError: e.message || String(e) } : { error: e.message || String(e) });
  }
};

