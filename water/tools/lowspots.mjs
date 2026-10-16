/**
 * STEP 1 OFFLINE: the low-spot map for a few lots (water session).
 *
 * LOTS NEVER COME FROM THE REPOSITORY. They are read from the environment,
 * WATER_LOTS, one per line or separated by ';':  label,lat,lng[,halfWidthM]
 * In CI that is a secret; the repository is public, so a lot never goes in a
 * workflow input or a log line. Output goes to OUT (a folder), named by
 * label, and the console prints only labels and numbers -- no coordinates.
 *
 *   WATER_LOTS='a,42.9,-85.7' OUT=out node water/tools/lowspots.mjs
 *
 * For each lot: which cloud (the shade map's lidarAt, worker/src/shade.js,
 * the code behind /api/shade/lidar), the points over a box LOT_PAD m
 * wider than the lot on each side (a low spot is judged on its whole
 * catchment, not on the lot's edge), and then lib/lowspots.js.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { pointsIn, toMerc, mercScale } from '../lib/ept.js';
import { lidarAt } from '../../worker/src/shade.js';
import { nodeIo } from '../lib/node-io.js';
import { analyse, spotRecords } from '../lib/lowspots.js';
import { renderMap } from '../lib/render.js';

const PAD = Number(process.env.LOT_PAD || 40);

export function parseLots(text) {
  return String(text || '').split(/[\n;]+/).map((s) => s.trim()).filter(Boolean).map((line) => {
    const [label, lat, lng, half] = line.split(',').map((s) => s.trim());
    const out = { label, lat: Number(lat), lng: Number(lng), half: Number(half || 25) };
    if (!label || !Number.isFinite(out.lat) || !Number.isFinite(out.lng)) throw new Error(`a lot line did not read as label,lat,lng (lot "${label || '?'}")`);
    return out;
  });
}

async function one(lot, outDir) {
  const t0 = Date.now();
  const pick = await lidarAt(lot.lng, lot.lat);
  const cloud = pick?.clouds?.[0];
  if (!cloud) return { label: lot.label, error: 'no public lidar over this lot' };
  const k = mercScale(lot.lat);
  const [cx, cy] = toMerc([lot.lng, lot.lat]);
  const half = (lot.half + PAD) / k;
  const bbox = [cx - half, cy - half, cx + half, cy + half];
  const { cols, flown } = await pointsIn(cloud.url, bbox, nodeIo());
  const epoch = cloud.epoch || (flown ? 1970 + flown.mid / (365.25 * 864e5) : null);
  const lotCells = [PAD, PAD, PAD + 2 * lot.half, PAD + 2 * lot.half];
  const res = analyse(cols, bbox, lot.lat, { epoch, within: lotCells });
  const spots = spotRecords(res, { within: lotCells });
  const img = renderMap(res, { lot: lotCells });
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer);
  writeFileSync(join(outDir, `${lot.label}.png`), PNG.sync.write(png));
  const report = {
    label: lot.label,
    cloud: { name: cloud.name, flown: flown ? new Date(flown.mid).toISOString().slice(0, 10) : null, ql: cloud.unit?.ql ?? null },
    stats: res.stats,
    datumShiftM: res.shift,
    spots,
    foundation: res.beside.summary,
    seconds: (Date.now() - t0) / 1000,
  };
  writeFileSync(join(outDir, `${lot.label}.json`), JSON.stringify(report, null, 1));
  return report;
}

async function main() {
  const lots = parseLots(process.env.WATER_LOTS);
  if (!lots.length) { console.log('No lots: set WATER_LOTS (label,lat,lng per line).'); return; }
  const outDir = process.env.OUT || 'water-out';
  mkdirSync(outDir, { recursive: true });
  for (const lot of lots) {
    try {
      const r = await one(lot, outDir);
      if (r.error) { console.log(`${lot.label}: ${r.error}`); continue; }
      const f = r.foundation;
      console.log(`${r.label}: ${r.cloud.name} (flown ${r.cloud.flown}), ground ${r.stats.groundPointsPerM2.toFixed(2)}/m^2, scatter ${(r.stats.scatter * 100).toFixed(1)} cm, noise floor ${(r.stats.noiseFloor * 100).toFixed(1)} cm;`
        + ` ${r.spots.length} low spot(s) on the lot${r.spots.length ? ` (deepest ${r.spots[0].depthCm} cm, ${r.spots[0].areaM2} m^2)` : ''};`
        + ` beside buildings: ${Math.round(f.towardShare * 100)}% falls toward, ${Math.round(f.meetsCodeShare * 100)}% meets 5%; ${r.seconds.toFixed(0)} s`);
    } catch (e) {
      console.log(`${lot.label}: failed -- ${e.message}`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('lowspots.mjs')) main();
