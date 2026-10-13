/**
 * IS THERE NEWER LIDAR THAN THE CLOUD WE READ? (owner, 2026-10-13: "I thought
 * we had found county level lidar flights ... more recent than flights we
 * pulled from 3dep"). H94.
 *
 * For every place in the locked set (lots within ~2 km counted once), three
 * answers side by side:
 *   octree   the 3DEP Entwine cloud on AWS that lidar-plan.js would pick
 *            (lidar-cover.js footprints + pickBest) -- what the detector reads
 *   wesm     every collection USGS's own index (lidar-season.js) lists there,
 *            including ones published as LAZ tiles on rockyweb.usgs.gov but
 *            not yet made into an octree on AWS
 *   local    lidar-derived services (DEM, DSM, hillshade, intensity, tile
 *            grids) that ArcGIS Online lists over the point, USGS's own left
 *            out. An extent is not coverage: H94's candidates were then
 *            checked at the point by hand (identify / query).
 *
 *   node tools/lidar-newer.js rows.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { FOOTPRINTS, fetchFootprints, planCoverage, flownYear } from './lidar-cover.js';
import { lidarAt } from './lidar-season.js';
import { yearHints } from './compare-imagery.js';
const OUT = process.argv[2];
const ids = JSON.parse(readFileSync(new URL('./locked-lawns.json', import.meta.url), 'utf8')).ids;
const pts = [];
for (const id of ids) {
  const [lng, lat] = id.split(':')[0].split(',').map(Number);
  if (pts.some((p) => Math.abs(p.lng - lng) < 0.02 && Math.abs(p.lat - lat) < 0.02)) continue;
  pts.push({ id, lng, lat });
}
console.log(`${pts.length} places from ${ids.length} locked lots`);
const fp = await fetchFootprints(FOOTPRINTS);
const plan = planCoverage(fp.features || fp, pts).rows;
const LIDARISH = /lidar|li-dar|\blas\b|point.?cloud|\bdsm\b|\bndsm\b|\bdem\b|\bdtm\b|elevation|hillshade|surface.?model|canopy.?height|\bchm\b/i;
async function agol(lng, lat) {
  const d = 0.001;
  const q = '(title:lidar OR title:LiDAR OR title:DSM OR title:DEM OR title:elevation OR title:hillshade OR title:"point cloud" OR tags:lidar OR tags:LiDAR) '
    + 'AND (type:"Image Service" OR type:"Map Service" OR type:"Feature Service" OR type:"Scene Service" OR type:"Elevation Layer")';
  const u = 'https://www.arcgis.com/sharing/rest/search?' + new URLSearchParams({ q, bbox: [lng - d, lat - d, lng + d, lat + d].join(','), f: 'json', num: '100' });
  const r = await (await fetch(u)).json();
  const out = [];
  for (const it of r.results || []) {
    if (!Array.isArray(it.extent) || it.extent.length !== 2) continue;
    const [[x0, y0], [x1, y1]] = it.extent;
    if ((x1 - x0) * (y1 - y0) > 30) continue; // national layers out
    if (!(lng >= x0 && lng <= x1 && lat >= y0 && lat <= y1)) continue;
    if (!LIDARISH.test(`${it.title} ${(it.tags || []).join(' ')}`)) continue;
    if (/usgs|3dep|national map/i.test(`${it.owner} ${it.title}`)) continue;
    out.push({ title: it.title, owner: it.owner, type: it.type, url: it.url, years: yearHints(`${it.title} ${it.snippet || ''}`), modified: new Date(it.modified).toISOString().slice(0, 10) });
  }
  return out;
}
const rows = [];
for (const p of pts) {
  const pr = plan.find((r) => r.id === p.id);
  const ept = pr.best ? { name: pr.best.name, year: flownYear(pr.best.name) } : null;
  const eptAll = pr.matches.map((f) => ({ name: f.name, year: flownYear(f.name) }));
  let wesm = [];
  try { wesm = await lidarAt(p.lng, p.lat); } catch (e) { wesm = [{ error: String(e.message) }]; }
  let local = [];
  try { local = await agol(p.lng, p.lat); } catch (e) { local = [{ error: String(e.message) }]; }
  rows.push({ ...p, ept, eptAll, wesm, local });
  const wy = Math.max(0, ...wesm.map((w) => Number((w.end || '').slice(0, 4)) || 0));
  const ly = Math.max(0, ...local.flatMap((l) => l.years || []));
  console.log(`${p.id.padEnd(36)} ept ${ept?.year ?? '-'}  wesm ${wy || '-'}  local ${local.length} newest ${ly || '-'}`);
  await new Promise((r) => setTimeout(r, 300));
}
writeFileSync(OUT, JSON.stringify(rows, null, 1));
