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
import { typicalYears, thisWeek } from '/lib/weather.js';
import { waterPlan } from '/lib/plan.js';
import { demAround, terrain, hillside } from '/lib/upslope.js';
import { powerUrl, typicalYear, growingSeason, SEASON_GP } from '/lib/shade/climate.js';
import { polygonsOf } from '/lib/geo.js';

const kept = { r: null, lawn: null, standIn: false, soil: null, typical: null, week: null, lng: null, lat: null, season: null, climate: null, light: null };

function standInLawn(res) {
  // no traced lawn (an address typed here, not a Lawn Mapper map): open ground with no trees, not paving
  const g = res.grid, N = g.W * g.H, m = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!res.wall[i] && res.perCell.tall[i] === 0 && Number.isFinite(res.rawZ[i])) m[i] = 1;
  return m;
}

async function plan(inputs = {}) {
  const { r } = kept;
  const t0 = Date.now();
  const p = waterPlan(r.result, {
    lawnMask: kept.lawn, paved: r.impervious ? r.impervious.paved : null, soil: kept.soil,
    topsoil: !!inputs.topsoil, downspouts: inputs.downspouts || [], gutters: inputs.gutters || [],
    typical: kept.typical, week: kept.week, season: kept.season, light: kept.light,
  });
  const out = {
    zones: p.zones, zoneOf: p.zoneOf, wetFromWatering: p.wetFromWatering, wetAnyway: p.wetAnyway, dryShare: p.dryShare,
    roofs: p.roofs, soil: p.soil, weather: p.weather, thisWeek: p.thisWeek, years: p.years, topsoil: p.topsoil,
    standIn: kept.standIn, seconds: (Date.now() - t0) / 1000, shaded: p.shaded, sunShare: p.sunShare,
    seasonDays: kept.season ? kept.season.size : null,
  };
  self.postMessage({ plan: out }, [out.zoneOf.buffer, out.wetFromWatering.buffer, out.wetAnyway.buffer, out.dryShare.buffer]);
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
  const soilP = (async () => {
    const d = 120 / 111320, e = d / Math.cos((lat * Math.PI) / 180);
    return soilFor([lng - e, lat - d, lng + e, lat + d], (q) => sdaPost(q));
  })().catch((err) => ({ units: [], error: err.message }));
  const typicalP = typicalYears(lat, lng).then((x) => x.days);
  const weekP = thisWeek(lat, lng, { back: 60 }).catch(() => null);
  // the shade map's typical year (its own reader, lib/shade/climate.js): its growing season and its light
  const y1 = new Date().getUTCFullYear() - 1;
  const climateP = fetch(powerUrl(lng, lat, y1 - 9, y1)).then((x) => x.json()).then((p) => typicalYear(p)).catch(() => null);

  const r = await runSite(site, io, pickCloud, { progress });
  if (r.error) { self.postMessage({ error: r.error, notOnAws: r.notOnAws }); return; }
  const res = r.result, g = res.grid;
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
    depth: res.spots.depth.slice(), reported, flow: (r.weightedFlow || res.runoff.area).slice(), weighted: !!r.weightedFlow, wall: res.wall.slice(), grade,
    paved: r.impervious ? r.impervious.paved.slice() : null,
    parcelMask: r.parcelMask, lawnMask: r.lawnMask,
    spots: r.spots, hasLawn: r.hasLawn, summary: { ...r.summary, noiseRuns: undefined }, cloud: r.cloud,
  };
  const transfer = [out.depth.buffer, reported.buffer, out.flow.buffer, out.wall.buffer, grade.buffer, ...(out.paved ? [out.paved.buffer] : [])];
  self.postMessage({ done: out }, transfer);

  self.postMessage({ planProgress: 'Reading the soil survey and ten years of weather…' });
  kept.r = r; kept.lng = lng; kept.lat = lat;
  kept.lawn = r.lawnMask || standInLawn(res); kept.standIn = !r.lawnMask;
  kept.soil = await soilP;
  kept.typical = await typicalP;
  kept.week = await weekP;
  kept.climate = await climateP;
  if (kept.climate) {
    const gs = growingSeason(kept.climate.tMean, 'cool', SEASON_GP, kept.climate.tSoil?.every?.(Number.isFinite) ? kept.climate.tSoil : null);
    if (gs.days.length) kept.season = new Set(gs.days);
  }
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
  // the shade on the lawn, by the shade map's own light worker: then the plan again, with it
  if (site.lawn?.length && kept.climate && typeof Worker !== 'undefined') {
    try {
      self.postMessage({ planProgress: 'Working out the shade on the lawn…' });
      kept.light = await lawnLight(res, site, kept.climate, kept.season);
      if (kept.light) { self.postMessage({ planProgress: 'Working out the watering plan with the shade…' }); await plan(kept.inputs || inputs); }
    } catch (e) {
      self.postMessage({ planProgress: `The shade could not be worked out (${e.message || e}); the plan takes the lawn as in full sun.` });
    }
  }
}

/**
 * The share of open-sky sunlight each lawn cell gets over the growing season's summer (June-August
 * days in it, every 4th), from the shade map's light worker (lib/shade/light-worker.js, copied
 * unchanged): its daily light integral against the open sky's, with NASA's clouds.
 */
function lawnLight(res, site, climate, season) {
  return new Promise((resolve, reject) => {
    const w = new Worker('/lib/shade/light-worker.js', { type: 'module' });
    const g = res.grid, N = g.W * g.H;
    const done = (v, err) => { w.terminate(); if (err) reject(err); else resolve(v); };
    const timer = setTimeout(() => done(null, new Error('the shade took too long')), 240000);
    w.onerror = (e) => { clearTimeout(timer); done(null, new Error(e.message || 'the light worker stopped')); };
    w.onmessage = ({ data: m }) => {
      if (m.type === 'error') { clearTimeout(timer); done(null, new Error(m.message)); return; }
      if (m.type === 'built') {
        if (m.w !== g.W || m.h !== g.H) { clearTimeout(timer); done(null, new Error('the shade grid is not the water grid')); return; }
        const days = [];
        for (let k = 151; k <= 242; k += 4) if (!season || season.has(k)) days.push(k);
        w.postMessage({ type: 'period', days, climate });
        return;
      }
      if (m.type === 'period') {
        clearTimeout(timer);
        if (!m.dli || !(m.openDli > 0)) { done(null); return; }
        const light = new Float32Array(N).fill(1);
        for (let p = 0; p < m.dli.length; p++) {
          const x = Math.floor(m.xy[2 * p]), y = Math.floor(m.xy[2 * p + 1]);
          if (x >= 0 && y >= 0 && x < g.W && y < g.H) light[y * g.W + x] = Math.max(0, Math.min(1, m.dli[p] / m.openDli));
        }
        done(light);
      }
    };
    const pts = res.points;
    w.postMessage({ type: 'build', cols: pts, box: g.bbox, lat: site.lat, lng: site.lng, shift: null, lot: polygonsOf(site.lawn), lawn: polygonsOf(site.lawn), canopy: 'measured', flight: null });
  });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.site) { kept.inputs = data.inputs || {}; await start(data.site, data.inputs || {}); }
    else if (data.replan) { kept.inputs = data.replan; if (kept.r) await plan(data.replan); }
  } catch (e) {
    self.postMessage(kept.r ? { planError: e.message || String(e) } : { error: e.message || String(e) });
  }
};

