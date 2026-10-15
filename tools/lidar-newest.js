/**
 * THE NEWEST LIDAR OVER EACH FRAME, BY USGS'S OWN DATES (H94, H96; owner,
 * 2026-10-13). Workflow 14 writes it over tools/lidar-plan.js's plan and
 * tools/lidar_frame.py reads it; the live server asks the same question of
 * one frame (newestFor, from tools/serve-alpha.mjs). ADOPTED 2026-10-13: H96
 * measured the 20 locked lots it changes 10 better, 1 worse.
 *
 * TWO MODES:
 *
 *   date     the baseline's pick, unchanged, with the flight's dates from
 *            USGS's index (WESM) beside it -- the epoch S35's datum move
 *            needs. The octree is matched to a work unit the way the shade
 *            map's picker does it (public/shade/find.js): the octree's name
 *            CONTAINS the work unit's (WI_SEWRPC_2017 inside
 *            USGS_LPC_WI_SEWRPC_2017_LAS_2019).
 *
 *   newest   re-picked. Every octree over the frame dated by WESM where it
 *            matches (its NAME's year otherwise -- the funding year, which put
 *            a 2018 cloud over one flown in 2021 at the Macon lot, H94), and
 *            every collection USGS has published as LAZ tiles over the frame
 *            (the TNM API) that has no octree on AWS. The newest wins; tiles
 *            only when their flight ended more than a year after the newest
 *            octree's, since they are downloaded whole (57-520 MB a tile).
 *
 *   FRAMES=frames PLAN=lidar-plan.json MODE=date|newest node tools/lidar-newest.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FOOTPRINTS, fetchFootprints, covers, densityPerSqM, flownYear } from './lidar-cover.js';
import { fromMercator } from './lidar-plan.js';
import { WESM } from './lidar-season.js';

const TNM = 'https://tnmaccess.nationalmap.gov/api/v1/products';
const YEAR_MS = 365.25 * 86400000;

/* ------------------------------------------------------------ pure parts */

export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const decimalYear = (ms) => 1970 + ms / YEAR_MS;

/** WESM's features as plain records, with the flight's middle as a decimal year. */
export function workUnits(wesmJson) {
  return (wesmJson?.features || []).map(({ attributes: a }) => ({
    workunit: a.workunit, project: a.project, ql: a.ql,
    start: Number.isFinite(a.collect_start) ? a.collect_start : null,
    end: Number.isFinite(a.collect_end) ? a.collect_end : null,
  })).map((u) => ({
    ...u, epoch: u.start !== null && u.end !== null ? decimalYear((u.start + u.end) / 2) : null,
  }));
}

/** The work unit an octree was built from: the longest one whose name its name contains. */
export function unitOf(octreeName, units) {
  const n = norm(octreeName);
  return units.filter((u) => norm(u.workunit) && n.includes(norm(u.workunit)))
    .sort((a, b) => norm(b.workunit).length - norm(a.workunit).length)[0] || null;
}

/** An octree with its flight dates: WESM's when matched, else the name's year. */
export function dateOctree(o, units) {
  const unit = unitOf(o.name, units);
  const y = flownYear(o.name);
  return {
    ...o,
    unit: unit?.workunit || null,
    end: unit?.end ?? (y ? Date.UTC(y, 11, 31) : null),
    epoch: unit?.epoch ?? (y ? y + 0.5 : null),
    dated: unit ? 'wesm' : (y ? 'name' : 'none'),
  };
}

/** The work unit folder of a rockyweb LAZ url: .../Projects/<project>/<unit>/LAZ/<file>. */
export function unitFolder(url) {
  const parts = String(url || '').split('/');
  const i = parts.lastIndexOf('LAZ');
  return i > 0 ? parts[i - 1] : null;
}

/**
 * USGS's published tile collections over a frame that no octree carries:
 * [{ unit, end, epoch, tiles: [url], mb }]. `items` is the TNM API's list.
 */
export function tileSets(items, units, octreeUnits) {
  const onAws = new Set(octreeUnits.filter(Boolean).map(norm));
  const sets = new Map();
  for (const it of items || []) {
    const url = it.downloadLazURL || (/\.laz$/i.test(it.downloadURL || '') ? it.downloadURL : null);
    if (!url) continue;
    const folder = unitFolder(url);
    const unit = units.find((u) => norm(u.workunit) === norm(folder))
      || units.find((u) => norm(folder).includes(norm(u.workunit)) && norm(u.workunit));
    if (!unit || unit.end === null || onAws.has(norm(unit.workunit)) || /legacy/i.test(unit.project || '')) continue;
    const s = sets.get(unit.workunit) || { unit: unit.workunit, end: unit.end, epoch: unit.epoch, tiles: [], mb: 0 };
    if (!s.tiles.includes(url)) {
      s.tiles.push(url);
      s.mb += (Number(it.sizeInBytes) || 0) / 1e6;
    }
    sets.set(unit.workunit, s);
  }
  return [...sets.values()];
}

/** The newest: an octree by date (density breaks a tie), tiles only when over a year newer. */
export function pickNewest(octrees, sets) {
  const best = octrees.slice().sort((a, b) => ((b.end ?? -Infinity) - (a.end ?? -Infinity)) || ((b.density || 0) - (a.density || 0)))[0] || null;
  const tiles = sets.slice().sort((a, b) => b.end - a.end)[0] || null;
  if (tiles && (!best || best.end === null || tiles.end - best.end > YEAR_MS)) return { kind: 'tiles', ...tiles };
  return best ? { kind: 'octree', ...best } : null;
}

const year = (ms) => (ms === null || ms === undefined ? null : new Date(ms).getUTCFullYear());

/** Every octree over a point, dated. */
export function octreesOver(fc, lng, lat, units) {
  return (fc?.features || []).filter((f) => covers(f.geometry, lng, lat)).map((f) => dateOctree({
    name: f.properties?.name || '(unnamed)', url: f.properties?.url || null, density: densityPerSqM(f),
  }, units));
}

/**
 * The plan entry: what lidar_frame.py reads. A tiles entry also names the
 * newest OCTREE (octreeUrl, octreeEpoch), which the live server reads until
 * the tiles are on its volume, and tree_lidar.py reads always.
 */
export function entryFor(id, octrees, pick) {
  if (!pick) return null;
  if (pick.kind === 'octree') {
    return { name: pick.name, url: pick.url, year: year(pick.end), epoch: pick.epoch, unit: pick.unit, dated: pick.dated, source: 'octree', density: pick.density, others: octrees.length - 1 };
  }
  const best = pickNewest(octrees, []);
  return {
    name: pick.unit, url: `tiles://${id}/ept.json`, tiles: pick.tiles, mb: Math.round(pick.mb), year: year(pick.end), epoch: pick.epoch,
    source: 'tiles', density: null, others: octrees.length,
    octreeUrl: best?.url || null, octreeName: best?.name || null, octreeEpoch: best?.epoch ?? null,
  };
}

const boxDegrees = (box) => {
  const [w, s] = fromMercator([box[0], box[1]]);
  const [e, n] = fromMercator([box[2], box[3]]);
  return [w, s, e, n];
};

/* ------------------------------------------------------------- the network */

async function getJson(url, tries = 3, timeoutMs = 60000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        // ArcGIS answers a failed query with HTTP 200 and an error body (WESM,
        // 2026-10-15: {"error":{"code":400,"message":"Failed to execute query."}}).
        const j = await res.json();
        if (!j?.error) return j;
        last = new Error(`${j.error.code || ''} ${j.error.message || 'query failed'}`.trim());
      } else {
        last = new Error(`HTTP ${res.status}`);
      }
    } catch (e) { last = e; }
    if (i < tries - 1) await new Promise((r) => { setTimeout(r, 2000 * (i + 1)); });
  }
  throw last;
}

const wesmAt = (lng, lat, quick = false) => getJson(`${WESM}?${new URLSearchParams({
  geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
  spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false', f: 'json',
  outFields: 'workunit,project,collect_start,collect_end,ql',
})}`, quick ? 1 : 3, quick ? 8000 : 60000);

const tnmOver = ([w, s, e, n], quick = false) => getJson(`${TNM}?${new URLSearchParams({
  datasets: 'Lidar Point Cloud (LPC)', bbox: [w, s, e, n].join(','), max: '200', outputFormat: 'JSON',
})}`, quick ? 1 : 3, quick ? 8000 : 60000);

/**
 * ONE FRAME, FOR THE LIVE SERVER: the plan entry for a Web Mercator box, from
 * the footprints it already holds. USGS's index or the TNM API not answering
 * is not fatal: it falls back to the octrees dated by their names.
 */
export async function newestFor(box, fc) {
  const [lng, lat] = fromMercator([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
  // One try of eight seconds each: a person is waiting on this lot.
  const units = workUnits(await wesmAt(lng, lat, true).catch(() => null));
  const octrees = octreesOver(fc, lng, lat, units);
  const items = units.length ? (await tnmOver(boxDegrees(box), true).catch(() => null))?.items || [] : [];
  return entryFor('lot', octrees, pickNewest(octrees, tileSets(items, units, octrees.map((o) => o.unit))));
}

async function main() {
  const FRAMES = process.env.FRAMES || 'frames';
  const PLAN = process.env.PLAN || 'lidar-plan.json';
  const MODE = process.env.MODE || 'newest';
  if (!['date', 'newest'].includes(MODE)) throw new Error(`MODE=${MODE}: date or newest`);
  const boxes = JSON.parse(readFileSync(join(FRAMES, 'scale.json'), 'utf8')).boxes || {};
  const base = JSON.parse(readFileSync(PLAN, 'utf8'));
  const fc = MODE === 'newest' ? await fetchFootprints(FOOTPRINTS) : null;
  const out = {};
  let changed = 0, toTiles = 0, mb = 0, undated = 0;
  const wesmDown = [];
  for (const [id, box] of Object.entries(boxes)) {
    const [lng, lat] = fromMercator([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
    const units = workUnits(await wesmAt(lng, lat).catch((e) => { wesmDown.push(`${id}: ${e.message}`); return null; }));
    const was = base[id] || null;
    if (MODE === 'date') {
      if (!was) { out[id] = null; continue; }
      const d = dateOctree(was, units);
      if (d.dated !== 'wesm') undated++;
      out[id] = { ...was, epoch: d.epoch, unit: d.unit, dated: d.dated };
      continue;
    }
    const octrees = octreesOver(fc, lng, lat, units);
    const items = (await tnmOver(boxDegrees(box)).catch(() => null))?.items || [];
    const pick = pickNewest(octrees, tileSets(items, units, octrees.map((o) => o.unit)));
    out[id] = entryFor(id, octrees, pick);
    const now = out[id];
    if ((now?.name || null) !== (was?.name || null)) {
      changed++;
      if (now?.source === 'tiles') { toTiles++; mb += now.mb; }
      console.log(`  ${id.slice(0, 28).padEnd(30)} ${was ? `${was.year ?? '—'} ${was.name}` : 'NO LIDAR'}  ->  ${now ? `${now.year ?? '—'} ${now.name}${now.source === 'tiles' ? ` (${now.tiles.length} tiles, ${now.mb} MB)` : ''}` : 'NO LIDAR'}`);
    }
    await new Promise((r) => { setTimeout(r, 200); });
  }
  const n = Object.keys(boxes).length;
  if (wesmDown.length) {
    // Without USGS's dates a frame silently falls back to its name's year and
    // never to newer tiles: a different corpus than the one the findings were
    // measured on. Refuse rather than train on it.
    console.error(`\nUSGS's flight index (WESM) did not answer for ${wesmDown.length} of ${n} frames, after retries:`);
    for (const l of wesmDown.slice(0, 10)) console.error(`  ${l}`);
    console.error('Refusing to plan the lidar without it. Re-run when index.nationalmap.gov answers.');
    process.exit(1);
  }
  writeFileSync(PLAN, JSON.stringify(out, null, 1));
  console.log(MODE === 'date'
    ? `\n${n} frames dated from USGS's index; ${undated} with no matching work unit took the name's year.`
    : `\n${changed} of ${n} frames read a different flight; ${toTiles} of them from USGS's newer LAZ tiles (${mb} MB to download).`);
}

if (process.argv[1] && process.argv[1].endsWith('lidar-newest.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
