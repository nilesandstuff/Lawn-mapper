/**
 * THE LIDAR'S BUILT THINGS, ON THE WALKS' SQUARES (core session, 2026-11-27). The owner, after two maps of solid
 * structure made square by square from the walks: "Maybe the orange and purple colors shouldn't be point-by-point
 * mapping, but rather checks on the lidar... 'lidar says there's a building here. Yup there is, but the shape is a bit
 * off' or 'it's a deck, not a building. And that's an aboveground pool'... Because the lidar shapes are really good,
 * but they have some fuzziness at edges, lidar doesn't actually know how far in the walls sit, and it can get confused
 * when trees touch the building."
 *
 * So the lidar's own kinds (the shade map's finished file, public/lib/lidar-model.js: structures.js BUILDING 1 and
 * STRUCTURE 4, after the owner's erasures) are put onto the 1 ft squares the walks are mapped on (the map's local
 * metres east and north of its point, scan/lib/frames.js), with each column's top. surfaces.py --lidar then checks
 * each lidar shape against what the walks saw. Nothing here classifies a point: the rule stays in structures.js.
 *
 *   node scan/tools/lidar-built.mjs <a walk's twin dir (its meta.json names the map)> <out.json>
 *
 * Prints counts and sizes only: no ids, no places.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { CORPUS_BUCKET, readObject, API, account } from './twin-r2.mjs';
import { loadModel } from '../../public/lib/lidar-model.js';

export const CELL_M = 0.3048;
const R_EARTH = 6378137; // scan/lib/frames.js and fuse.js fromLocal: the walk's local frame is a sphere of this radius
const MERC_R = 6378137;

/** The map's local metres [e, n] east/north of origin [lng, lat] -> EPSG:3857 [x, y] (fuse.js fromLocal, ept.js toMerc). */
export function localToMerc(origin, [e, n]) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  const lng = origin[0] + (e / (R_EARTH * k)) * (180 / Math.PI), lat = origin[1] + (n / R_EARTH) * (180 / Math.PI);
  return [(MERC_R * lng * Math.PI) / 180, MERC_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
}

/** And back. */
export function mercToLocal(origin, [x, y]) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  const lng = (x / MERC_R) * (180 / Math.PI), lat = (2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * (180 / Math.PI);
  return [((lng - origin[0]) * Math.PI / 180) * R_EARTH * k, ((lat - origin[1]) * Math.PI / 180) * R_EARTH];
}

/**
 * The lidar file's kinds and tops on 1 ft squares of the map's local frame. -> { cellM, i0, j0, w, h, kinds (Uint8,
 * rows south to north), tops (Uint8 decimetres over the ground, 0 none) }. Only BUILDING (1) and STRUCTURE (4) kept.
 */
export function lidarOnSquares(model, origin, { cellM = CELL_M } = {}) {
  const G = model.meta.grid, cy = G.cellY || G.cell, kind = model.arrays.kind, top = model.arrays.top;
  const corners = [[G.x0, G.y1], [G.x0 + G.w * G.cell, G.y1], [G.x0, G.y1 - G.h * cy], [G.x0 + G.w * G.cell, G.y1 - G.h * cy]].map((p) => mercToLocal(origin, p));
  const i0 = Math.floor(Math.min(...corners.map((p) => p[0])) / cellM), i1 = Math.ceil(Math.max(...corners.map((p) => p[0])) / cellM);
  const j0 = Math.floor(Math.min(...corners.map((p) => p[1])) / cellM), j1 = Math.ceil(Math.max(...corners.map((p) => p[1])) / cellM);
  const w = i1 - i0, h = j1 - j0;
  const kinds = new Uint8Array(w * h), tops = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const [x, y] = localToMerc(origin, [(i0 + c + 0.5) * cellM, (j0 + r + 0.5) * cellM]);
    const cc = Math.floor((x - G.x0) / G.cell), rr = Math.floor((G.y1 - y) / cy);
    if (cc < 0 || rr < 0 || cc >= G.w || rr >= G.h) continue;
    const k = kind[rr * G.w + cc];
    if (k !== 1 && k !== 4) continue;
    kinds[r * w + c] = k;
    const t = top ? top[rr * G.w + cc] : NaN;
    tops[r * w + c] = Number.isFinite(t) && t > 0 ? Math.min(254, Math.round(t * 10)) : 0;
  }
  return { cellM, i0, j0, w, h, kinds, tops };
}

async function sql(statement, params = []) {
  const token = process.env.CLOUDFLARE_API_TOKEN, h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const acct = await account(token);
  const j = await (await fetch(`${API}/accounts/${acct}/d1/database?name=lawn-mapper`, { headers: h })).json();
  const id = (j.result || []).find((d) => d.name === 'lawn-mapper')?.uuid;
  if (!id) throw new Error('the main database could not be found');
  for (let t = 0; t < 4; t++) {
    if (t) await new Promise((ok) => setTimeout(ok, 3000 * t));
    const r = await fetch(`${API}/accounts/${acct}/d1/database/${id}/query`, { method: 'POST', headers: h, body: JSON.stringify({ sql: statement, params }) }).catch(() => null);
    const q = r ? await r.json().catch(() => null) : null;
    if (q?.success) return q.result?.[0]?.results || [];
  }
  throw new Error('the main database would not answer (asked four times)');
}

async function main() {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) throw new Error('a twin dir and an out file');
  let key = null;
  try { key = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).map || null; } catch { key = null; }
  if (!key) { console.log('  THE LIDAR\'S BUILT THINGS: none read (the walk names no map).'); return; }
  const row = (await sql('SELECT user_id, lng, lat FROM maps WHERE key = ? LIMIT 1', [key]))[0];
  if (!row || !Number.isFinite(row.lng)) { console.log('  THE LIDAR\'S BUILT THINGS: none read (the walk\'s map is not a signed-in map).'); return; }
  const prefix = `models/user/${row.user_id}/${createHash('sha256').update(key).digest('hex')}/shade`;
  const fromBucket = async (u) => {
    const part = /[?&]part=(\d+)/.exec(u)?.[1];
    const bytes = await readObject(CORPUS_BUCKET, part ? `${prefix}.${part}.bin` : `${prefix}.bin`).catch(() => null);
    return bytes ? { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : { ok: false, status: 404 };
  };
  let model = null;
  try { model = await loadModel(fromBucket, 'model'); } catch { model = null; }
  if (!model?.arrays?.kind) { console.log('  THE LIDAR\'S BUILT THINGS: none read (the map has no lidar model: open it in the shade map once).'); return; }
  const g = lidarOnSquares(model, [row.lng, row.lat]);
  const enc = (a) => deflateSync(Buffer.from(a.buffer, a.byteOffset, a.byteLength), { level: 9 }).toString('base64');
  let nb = 0, ns = 0;
  for (const k of g.kinds) { if (k === 1) nb++; else if (k === 4) ns++; }
  writeFileSync(out, JSON.stringify({ v: 1, cellM: g.cellM, i0: g.i0, j0: g.j0, w: g.w, h: g.h, enc: 'zlib+base64', lidarAt: model.meta.at || null,
    what: 'the shade map\'s lidar kinds on the map\'s 1 ft squares, rows south to north: 1 building, 4 low structure (structures.js), 0 neither; tops in decimetres over the ground',
    kinds: enc(g.kinds), tops: enc(g.tops) }));
  console.log(`  THE LIDAR'S BUILT THINGS, for the walks to check: buildings ${nb.toLocaleString('en-US')} sq ft, low structures ${ns.toLocaleString('en-US')} sq ft (the shade map's lidar model of ${String(model.meta.at || '').slice(0, 10) || 'unknown date'}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.log(`  THE LIDAR'S BUILT THINGS: not read (${String(e?.message || e).slice(0, 120)}).`); });
