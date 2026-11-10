/**
 * THE INPUTS FOR STRETCHING A MAP'S PHOTOS ONTO THE LIDAR (core session, 2026-11-09; docs/SCAN-PLAN.md section 17;
 * scan/tools/warp_study.py). The owner: aerial photos are not true to the ground, they are locally skewed, and only
 * the lidar is; "Yes let's do it".
 *
 *   node scan/tools/warp-prep.mjs <walk> <dir>
 *
 * For the map the walk was made on, into <dir>:
 *   lidar.bin      every return of the shade map's model at its MEASURED place: the model has the cloud's one shift
 *                  onto a photo applied (lidar-model.js meta.lidar.shift), taken off here. Float32 [east, north, z,
 *                  intensity, class, height over the ground] in the map's local metres.
 *   photo-county.png / photo-mapbox.png and photos.json   the photo the map was traced on as Lawn Mapper keeps it
 *                  (the county photo with the editor's line-up: worker/src/map-photo.js), and Mapbox for the same
 *                  frame; each with its frame and pixel size.
 *   marks.json     every walk on this map: its check and reference marks (id, the map's metres, kind) and when.
 *
 * Prints counts only (the repository and its logs are public).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMap, readModel } from './twin-io.mjs';
import { readObject, CORPUS_BUCKET, BUCKET } from './twin-r2.mjs';
import { photoSpec } from '../../worker/src/map-photo.js';
import { liveCaptureFrame, imagePixels, imageHeightPixels } from '../../worker/src/imagery.js';
import { toMerc } from '../lib/photo.js';
import { checkMarks } from '../lib/postfix.js';
import { createHash } from 'node:crypto';

const API = 'https://api.cloudflare.com/client/v4';

async function cf(path) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) account = (await (await fetch(`${API}/accounts?per_page=5`, { headers: { Authorization: `Bearer ${token}` } })).json()).result?.[0]?.id;
  return fetch(`${API}/accounts/${account}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Every walk in the twin bucket with its meta (walk, map, started). */
async function walksOfBucket() {
  const out = [];
  let cursor = '';
  do {
    const j = await (await cf(`/r2/buckets/${BUCKET}/objects?prefix=twins/&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json();
    for (const o of j.result || []) if (/\/meta\.json$/.test(o.key)) out.push(o.key.split('/')[1]);
    cursor = j.result_info?.is_truncated ? j.result_info.cursor : '';
  } while (cursor);
  return out;
}

async function json(bucket, key) {
  const b = await readObject(bucket, key).catch(() => null);
  if (!b) return null;
  try { return JSON.parse(Buffer.from(b).toString('utf8')); } catch { return null; }
}

async function main() {
  const [walk, dir = 'warp'] = process.argv.slice(2);
  if (!walk) throw new Error('which walk? (its map is the one studied)');
  mkdirSync(dir, { recursive: true });
  const meta = await json(BUCKET, `twins/${walk}/meta.json`);
  if (!meta?.map) throw new Error('that walk names no map');
  const m = await readMap(meta.map);
  const model = await readModel(meta.map, m.ownerId);
  const origin = [m.lng, m.lat], k = Math.cos((origin[1] * Math.PI) / 180), [ox, oy] = toMerc(origin);

  // the lidar where it was measured: the model's one shift onto a photo taken off
  const A = model.arrays, g = model.meta.grid, shift = model.meta.lidar?.shift || [0, 0];
  if (!A.ptX?.length) throw new Error('the model keeps no points');
  const np = A.ptX.length, rec = new Float32Array(np * 6);
  const gw = g.w, gh = g.h, cellX = g.cell, cellY = g.cellY || g.cell;
  for (let i = 0; i < np; i++) {
    const mx = g.x0 + A.ptX[i] / 100, my = g.y1 - A.ptY[i] / 100;
    const c = Math.min(gw - 1, Math.max(0, Math.floor((mx - g.x0) / cellX))), r = Math.min(gh - 1, Math.max(0, Math.floor((g.y1 - my) / cellY)));
    const gz = A.ground[r * gw + c];
    const z = A.ptZ[i] / 100;
    rec.set([(mx - shift[0] - ox) * k, (my - shift[1] - oy) * k, z, A.ptI ? A.ptI[i] : 0, A.ptCls ? A.ptCls[i] : 0, Number.isFinite(gz) ? z - gz : NaN], i * 6);
  }
  writeFileSync(join(dir, 'lidar.bin'), Buffer.from(rec.buffer));

  // the photos: the kept one (as the marks were placed on it) and Mapbox for the same frame
  const spec = photoSpec(m);
  if (!spec) throw new Error('the map has no saved frame');
  const frame = liveCaptureFrame(spec.frame).frame;
  const W = imagePixels(frame), H = imageHeightPixels(frame);
  const photos = {};
  const sha = createHash('sha256').update(String(meta.map)).digest('hex');
  const kept = await readObject(CORPUS_BUCKET, `models/user/${m.ownerId}/${sha}/photo.bin`).catch(() => null);
  if (kept) {
    const name = `photo-${spec.provider}.png`;
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(kept).png().toBuffer({ resolveWithObject: true });
    writeFileSync(join(dir, name), data);
    photos[spec.provider] = { file: name, frame, w: info.width, h: info.height, kept: true };
  }
  const token = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;
  if (token && !photos.mapbox) {
    // Mapbox's largest picture is 1280 a side at @2x: the frame's own size when it fits, else as large as it allows
    const scale = Math.min(1, 1280 / Math.max(frame.size, frame.height));
    const z = frame.zoom + Math.log2(scale), sw = Math.round(frame.size * scale), sh = Math.round(frame.height * scale);
    const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${frame.lng},${frame.lat},${z},0/${sw}x${sh}@2x?access_token=${token}&attribution=false&logo=false`;
    const r = await fetch(url);
    if (r.ok) {
      const sharp = (await import('sharp')).default;
      const { data, info } = await sharp(Buffer.from(await r.arrayBuffer())).png().toBuffer({ resolveWithObject: true });
      writeFileSync(join(dir, 'photo-mapbox.png'), data);
      photos.mapbox = { file: 'photo-mapbox.png', frame: { lng: frame.lng, lat: frame.lat, zoom: z, size: sw, height: sh }, w: info.width, h: info.height, kept: false };
    } else console.log(`Mapbox's photo could not be fetched (${r.status}).`);
  }
  // the model's shift in the map's metres: the stretched photo is laid where the page draws the lidar, which is the model
  writeFileSync(join(dir, 'photos.json'), JSON.stringify({ map: meta.map, origin, k, photos, shift: [shift[0] * k, shift[1] * k] }));

  // every walk on this map: its marks
  const walks = [];
  for (const w of await walksOfBucket()) {
    const mt = await json(BUCKET, `twins/${w}/meta.json`);
    if (mt?.map !== meta.map) continue;
    const live = await json(BUCKET, `twins/${w}/live.json`);
    const checks = checkMarks(live?.marks);
    const refs = (live?.marks || []).filter((x) => x.kind === 'ref' && x.map);
    // the points as placed on the photos, with any second placement on the other photo (app.js "Place them again")
    const points = (live?.points || []).filter((x) => Array.isArray(x.map)).map((x) => ({ id: x.id, on: x.on || null, map: x.map, again: x.again?.map ? { on: x.again.on || null, map: x.again.map } : null }));
    walks.push({ walk: w, started: mt.started || null, marks: [...checks, ...refs].map((x) => ({ id: x.id, kind: x.kind, map: x.map, ar: x.ar || null })), points });
  }
  writeFileSync(join(dir, 'marks.json'), JSON.stringify({ walks }));
  console.log(`Warp inputs: ${np.toLocaleString()} lidar returns (the model's shift onto a photo, ${Math.hypot(shift[0] * k, shift[1] * k).toFixed(2)} m, taken off); `
    + `photos: ${Object.entries(photos).map(([s, p]) => `${s} ${p.w}x${p.h}${p.kept ? ' (kept with the map)' : ''}`).join(', ') || 'none'}; `
    + `${walks.length} walks on this map with ${walks.reduce((s, w) => s + w.marks.length, 0)} marks.`);
}

main().catch((e) => { console.log(`Warp inputs: ${e.message}`); process.exit(1); });
