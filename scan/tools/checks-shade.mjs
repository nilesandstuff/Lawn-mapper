/**
 * DO THE CHECK MARKS SIT ON THE LIDAR? (core session, 2026-11-08). The owner places each check mark on the Mapbox photo,
 * on something it shows, "within inches. BUT I'm wondering if the aerial imagery is connecting correctly with the
 * reality... Are we sure that (1,000, 1,000) and (2,000, 2,000) actually point to where the lidar signatures for those
 * visually recognizable shapes would be." Every placement error is measured against those marks.
 *
 * The shade map put the lidar on this photo with ONE shift for the whole frame (public/shade.js, alignToPhoto), and
 * a photo can be stretched or skewed a little differently in each corner. So this asks the shade map's own matcher
 * (public/shade/align.js alignToPhoto: the lidar's low returns' brightness against the photo's edges, by direction,
 * on open ground only; measured on the corpus in docs/DETECTOR-FINDINGS.md H103/H108) again, on the lidar exactly as
 * the scan uses it (the shift already applied): over the whole lot, and in a 30 m square round each mark. A shift of
 * zero means the photo's ground sits on the lidar's there; a mark's spot in the lidar's world is the mark less the
 * shift. (A matcher of its own, tried first, read noise on the real lot; this one has been tried on 98 lots.)
 *
 * Needs the twin with skyline-prep.mjs run (sky-points.bin, sky-input.json). Fetches Mapbox photos for the run; keeps
 * nothing but checks-lidar.json. Prints distances only.
 *
 *   CLOUDFLARE_API_TOKEN=... MAPBOX_SERVER_TOKEN=... node scan/tools/checks-shade.mjs twin
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alignToPhoto } from '../../public/shade/align.js';
import { frameFor, bboxOf, toMerc, ringsOf } from '../lib/photo.js';
import { toLocal } from '../lib/frames.js';
import { readMap } from './twin-io.mjs';

const FT = 3.281;
const ft = (m) => (m * FT).toFixed(1);

async function photoFor(frame, token, sharp) {
  const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${frame.lng},${frame.lat},${frame.zoom},0/${frame.size}x${frame.height}@2x?access_token=${token}&attribution=false&logo=false`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the photo could not be fetched (${r.status})`);
  // Mapbox's satellite comes as a JPEG whatever the name: decoded by what it is
  const { data, info } = await sharp(Buffer.from(await r.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function describe(f) {
  if (!f || !Number.isFinite(f.east)) return `not measured (${f?.why || 'no answer'})`;
  const mag = Math.hypot(f.east, f.north);
  const q = (f.quarters || []).filter((x) => x && Number.isFinite(x.east) && x.score >= 0.12);
  const qs = q.length ? `; its quarters alone: ${q.map((x) => `${ft(Math.hypot(x.east, x.north))}`).join(', ')} ft` : '';
  return `${ft(mag)} ft (east ${f.east * FT >= 0 ? '+' : ''}${ft(f.east)}, north ${f.north * FT >= 0 ? '+' : ''}${ft(f.north)} ft)` +
    `${f.confident ? ', sure' : `, NOT SURE: ${f.why}`}${Number.isFinite(f.errorM) ? `; give or take ${ft(f.errorM)} ft` : ''}${qs}`;
}

async function main() {
  const dir = process.argv[2] || 'twin';
  const token = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('no Mapbox token');
  const sharp = (await import('sharp')).default;
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const inp = JSON.parse(readFileSync(join(dir, 'sky-input.json'), 'utf8'));
  const m = await readMap(meta.map);
  const origin = [m.lng, m.lat], k = Math.cos((origin[1] * Math.PI) / 180), [ox, oy] = toMerc(origin);
  // the lidar's returns as the shade map's matcher takes them (EPSG:3857, the cloud's shift already applied)
  const b = readFileSync(join(dir, 'sky-points.bin'));
  const rec = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const n = rec.length / 6;
  const cols = { n, x: new Float64Array(n), y: new Float64Array(n), z: new Float32Array(n), intensity: new Float32Array(n), cls: new Uint8Array(n), ret: new Uint8Array(n).fill(1), nret: new Uint8Array(n).fill(1) };
  for (let i = 0; i < n; i++) {
    cols.x[i] = ox + rec[i * 6] / k; cols.y[i] = oy + rec[i * 6 + 1] / k; cols.z[i] = rec[i * 6 + 2];
    cols.intensity[i] = rec[i * 6 + 3]; cols.cls[i] = rec[i * 6 + 4];
  }
  const checks = inp.checks || [];
  console.log(`Check marks against the lidar, by the shade map's own matcher: ${checks.length} marks, ${n.toLocaleString()} lidar returns. ` +
    'A shift is how far the photo\'s ground sits from the lidar\'s (0 = on it).');
  const out = { whole: null, marks: [] };
  // the whole lot: the scan page's own frame
  const lawn = ringsOf(m.shapes || []).map((r) => r.map((p) => toLocal(origin, p)));
  const parcel = ringsOf(m.parcel ? [m.parcel] : []).map((r) => r.map((p) => toLocal(origin, p)));
  const whole = frameFor(bboxOf(origin, [...lawn.flat(), ...parcel.flat()], 12), m.lat);
  try { out.whole = alignToPhoto(cols, whole, await photoFor(whole, token, sharp)); } catch (e) { out.whole = { why: e.message }; }
  console.log(`  the whole lot: ${describe(out.whole)}`);
  // each mark: the smallest square round it the frame allows (frameFor stops at zoom 20)
  const seen = new Set();
  for (const c of checks) {
    if (seen.has(c.id)) continue; seen.add(c.id);
    const fr = frameFor(bboxOf(origin, [c.map], 15), m.lat, 640);
    let f;
    try { f = alignToPhoto(cols, fr, await photoFor(fr, token, sharp), { reachM: 3 }); } catch (e) { f = { why: e.message }; }
    out.marks.push({ id: c.id, east: f.east ?? null, north: f.north ?? null, confident: !!f.confident, why: f.why || null, errorM: f.errorM ?? null });
    const wM = (fr.size * (2 * Math.PI * 6378137 * k) / 512) / 2 ** fr.zoom;
    console.log(`  check ${c.id} (a ${Math.round(wM)} m square round it): ${describe(f)}`);
  }
  const sure = out.marks.filter((x) => x.confident && Number.isFinite(x.east));
  if (sure.length) {
    const mags = sure.map((x) => Math.hypot(x.east, x.north) * FT).sort((a, b) => a - b);
    console.log(`  sure at ${sure.length} of ${out.marks.length} marks: median ${mags[mags.length >> 1].toFixed(1)} ft, largest ${mags[mags.length - 1].toFixed(1)} ft.`);
  } else console.log('  no mark measured surely.');
  writeFileSync(join(dir, 'checks-lidar.json'), JSON.stringify(out));
}

main().catch((e) => { console.error(`Check marks against the lidar: ${e.message}`); process.exit(1); });
