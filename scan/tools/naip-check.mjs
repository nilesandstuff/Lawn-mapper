/**
 * DOES NAIP SIT ON THE LIDAR? (core session, 2026-11-10; docs/SCAN-PLAN.md section 22). The owner: "I just remembered
 * that NAIP exists. Does naip line up neatly with 3dep? Naip isn't good enough for lawn traces but it's definitely good
 * enough for placing points... Naip should be newer than 3dep right? That's what matters."
 *
 * NAIP's fourth band is near infrared, and the lidar's brightness is near infrared too (1064 nm): grass bright,
 * concrete darker, blacktop darkest, in both. So the two are matched as they are, no colour to translate: the lidar's
 * ground brightness on 0.25 m cells (look.js lidarPicture, the placement map's own picture, trees and raised things
 * left off) against NAIP's near infrared over the same ground, patch by patch (public/lib/register.js, the matcher
 * the Lawn Mapper lines its photos up with). First a planted test: NAIP slid by a known amount must come back as that.
 *
 *   node scan/tools/naip-check.mjs <walk>[,<walk>...] | recent
 *
 * "recent": the newest walk on each of the last three maps walked (the owner's home and work).
 *
 * Prints counts, dates and distances only: no place (the repository and its logs are public).
 */
import { readMap, readModel } from './twin-io.mjs';
import { readObject, BUCKET } from './twin-r2.mjs';
import { gridsFromModel } from '../lib/lidar-load.js';
import { returnsFrom } from '../lib/lidar-marks.js';
import { lidarPicture } from '../lib/look.js';
import { ringsOf, toMerc } from '../lib/photo.js';
import { toLocal, fromLocal } from '../lib/frames.js';
import { registerImages } from '../../public/lib/register.js';
import { PNG } from 'pngjs';
import { execFileSync } from 'node:child_process';
import { rowsOf } from './walks.mjs';
import { DB_NAME } from './d1.mjs';

const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const CROP = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox';
const MOSAIC = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
const CELL = 0.25;
const PLANT = [1.25, -1.0]; // metres east, north: whole cells, so the slide is exact

/** The NAIP frames over a lon/lat ring, newest first: { id, date, gsd, covers }. */
async function framesOver(ring) {
  const res = await fetch(STAC, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ collections: ['naip'], intersects: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, limit: 100 }) });
  if (!res.ok) throw new Error(`NAIP search: HTTP ${res.status}`);
  const inside = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
  return ((await res.json())?.features || []).map((f) => ({
    id: f.id, date: f.properties?.datetime?.slice(0, 10), gsd: f.properties?.gsd,
    covers: ring.every((pt) => (f.geometry?.coordinates || []).some((poly) => inside(pt, poly))),
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/** One frame's near infrared over a 3857 bbox at W x H, as an RGBA picture (grey). */
async function frameNir(id, bbox, W, H) {
  const url = `${CROP}/${bbox.map((v) => v.toFixed(2)).join(',')}/${W}x${H}.png?collection=naip&item=${encodeURIComponent(id)}&assets=image&asset_bidx=image%7C4,4,4&coord_crs=EPSG:3857&dst_crs=EPSG:3857&resampling=bilinear`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`NAIP crop: HTTP ${res.status}`);
  const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

/** The USGS mosaic's near infrared (the newest it holds), the same way. */
async function mosaicNir(bbox, W, H) {
  const url = `${MOSAIC}?bbox=${bbox.map((v) => v.toFixed(2)).join(',')}&bboxSR=3857&imageSR=3857&size=${W},${H}&format=bsq&pixelType=U8&interpolation=RSP_BilinearInterpolation&f=image`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`NAIP mosaic: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < W * H * 4) throw new Error('NAIP mosaic: short answer');
  const data = new Uint8ClampedArray(W * H * 4);
  for (let k = 0; k < W * H; k++) { const v = buf[3 * W * H + k]; data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = v; data[k * 4 + 3] = 255; }
  return { data, width: W, height: H };
}

/** A picture slid by whole pixels (dx east, dy south), edges repeated. */
function slid(img, dx, dy) {
  const { width: W, height: H } = img, out = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(W - 1, Math.max(0, x - dx)), sy = Math.min(H - 1, Math.max(0, y - dy));
    for (let c = 0; c < 4; c++) out[(y * W + x) * 4 + c] = img.data[(sy * W + sx) * 4 + c];
  }
  return { data: out, width: W, height: H };
}

const say = (r) => {
  if (!r.offsetM) return `no answer (${r.why})`;
  const vs = r.vectors.filter((v) => v.inlier), cm = r.cellM;
  const mag = vs.map((v) => Math.hypot(v.dx, v.dy) * cm).sort((a, b) => a - b), q = (f) => mag.length ? mag[Math.min(mag.length - 1, Math.floor(mag.length * f))].toFixed(2) : '-';
  return `${r.offsetM.east.toFixed(2)} m east, ${r.offsetM.north.toFixed(2)} m north (${r.model}, ${r.confident ? 'confident' : 'NOT confident'}: ${r.inliers} of ${r.patches} patches agree, ` +
    `rms ${r.rmsM?.toFixed(2)} m, spread ${r.spread?.toFixed(2)}; patch moves median ${q(0.5)} m, 90th pct ${q(0.9)} m)${r.why ? ` -- ${r.why}` : ''}`;
};

async function one(walk) {
  const meta = JSON.parse(Buffer.from(await readObject(BUCKET, `twins/${walk}/meta.json`)).toString('utf8'));
  const m = await readMap(meta.map);
  const model = await readModel(meta.map, m.ownerId);
  const origin = [m.lng, m.lat];
  const lawn = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(origin, p)));
  const parcel = ringsOf(m.parcel ? [m.parcel] : []).map((r) => r.map((p) => toLocal(origin, p)));
  const pts = [...lawn.flat(), ...parcel.flat()], es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
  const box = pts.length ? [Math.min(...es) - 20, Math.min(...ns) - 20, Math.max(...es) + 20, Math.max(...ns) + 20] : [-60, -60, 60, 60];
  const S = await import('../../public/shade/structures.js');
  const G = gridsFromModel(model, { origin, box, lawn: [], S, toMerc });
  const P = returnsFrom({ ...G, model });
  if (!P) throw new Error('the model keeps no returns');
  const pic = lidarPicture(box, P, CELL, { noRaised: true, noTrees: true });
  const lid = { data: pic.rgba, width: pic.W, height: pic.H };
  const groundM = pic.W * CELL;
  // the same ground in web mercator (the local frame's corners; over a lot the two differ by a scale only)
  const nw = toMerc(fromLocal(origin, [box[0], box[3]])), se = toMerc(fromLocal(origin, [box[0] + pic.W * CELL, box[3] - pic.H * CELL]));
  const bbox = [nw[0], se[1], se[0], nw[1]];
  const ring = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map((p) => fromLocal(origin, p));
  console.log(`\nWalk ${walk}: box ${groundM.toFixed(0)} x ${(pic.H * CELL).toFixed(0)} m, the lidar picture on ${CELL} m cells.`);
  if (model.flown || model.date) console.log(`  The lidar flown: ${String(model.flown || model.date).slice(0, 10)}`);
  const frames = await framesOver(ring).catch((e) => { console.log(`  ${e.message}`); return []; });
  console.log(`  NAIP frames over the lot: ${frames.map((f) => `${f.date} (${f.gsd} m${f.covers ? '' : ', part'})`).join(', ') || 'none found'}`);
  // the lidar against itself, slid: the matcher must find the slide
  const self = registerImages(lid, slid(lid, Math.round(PLANT[0] / CELL), -Math.round(PLANT[1] / CELL)), groundM);
  console.log(`  Planted, lidar against itself slid ${PLANT[0]} m east, ${PLANT[1]} m north: ${say(self)}`);
  const tries = frames.filter((f) => f.covers).slice(0, 3).map((f) => ({ label: `NAIP ${f.date} (${f.gsd} m)`, get: () => frameNir(f.id, bbox, pic.W, pic.H) }));
  tries.push({ label: 'NAIP, the USGS mosaic (its newest)', get: () => mosaicNir(bbox, pic.W, pic.H) });
  for (const t of tries) {
    let img;
    try { img = await t.get(); } catch (e) { console.log(`  ${t.label}: ${e.message}`); continue; }
    const r = registerImages(lid, img, groundM);
    console.log(`  ${t.label} against the lidar: ${say(r)}`);
    const pl = registerImages(lid, slid(img, Math.round(PLANT[0] / CELL), -Math.round(PLANT[1] / CELL)), groundM);
    const got = pl.offsetM && r.offsetM ? [pl.offsetM.east - r.offsetM.east, pl.offsetM.north - r.offsetM.north] : null;
    console.log(`    and slid a further ${PLANT[0]} m east, ${PLANT[1]} m north: ${got ? `found ${got.map((v) => v.toFixed(2)).join(' m east, ')} m north more` : `no answer (${pl.why})`}`);
  }
}

async function main() {
  let walks = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (walks.length === 1 && walks[0] === 'recent') {
    // the walks kept on the site, newest first; each one's map is in its twin's meta.json
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', '--command=SELECT id, json FROM walks ORDER BY at DESC LIMIT 40'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const seen = new Set(); walks = [];
    for (const r of rowsOf(out)) {
      let id = String(r.id); try { id = String(JSON.parse(r.json)?.startedAt || r.id); } catch { /* the row's id */ }
      let meta = null; try { meta = JSON.parse(Buffer.from(await readObject(BUCKET, `twins/${id}/meta.json`)).toString('utf8')); } catch { continue; }
      if (!meta?.map || seen.has(meta.map)) continue;
      seen.add(meta.map); walks.push(id);
      if (walks.length >= 3) break;
    }
    console.log(`The newest walk on each of the last ${walks.length} maps walked.`);
  }
  if (!walks.length) throw new Error('which walk? (its map is the one looked at)');
  for (const w of walks) await one(w).catch((e) => console.log(`\nWalk ${w}: ${e.message}`));
}

main().catch((e) => { console.log(`NAIP check: ${e.message}`); process.exit(1); });
