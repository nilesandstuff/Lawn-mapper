/**
 * Look at what is actually stored for one finished map.
 *
 * Written for a specific report: candidates turning up with overlapping shapes
 * that could not be told apart, and "show the AI's version" drawing nothing.
 * Both of those are claims about the ROW, and reading the row is the only way
 * to settle them -- the card can only show what it was given.
 *
 * Free: one read-only query. Prints a summary per map rather than the outlines
 * themselves, which are tens of thousands of numbers and unreadable in a log.
 *
 *   ID=<row id> node tools/inspect-map.js
 *   STATUS=rejected node tools/inspect-map.js
 */

import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { resolve } from 'node:path';
import { query } from './corpus-db.js';
import { benchmarkId } from '../worker/src/benchmark-ids.js';
import { areaSqFt } from '../worker/src/score.js';
import { rasterizePolygon, unionMasks } from '../public/lib/mask.js';
import { lngLatToFramePx, metresPerPixel, zoomToFit } from '../public/lib/mercator.js';

const SQM_PER_SQFT = 0.09290304;

const parse = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

/** Geometries out of a stored column, tolerating both shapes it has used. */
const geometries = (stored) => {
  const list = Array.isArray(stored) ? stored : stored?.features || [];
  return list.map((g) => (g?.geometry ? g.geometry : g)).filter(Boolean);
};

/**
 * THE CARD, DRAWN HERE: the stored photograph with the stored outlines on it,
 * projected exactly as the console card projects them (onto image_frame when
 * there is a photo). Written to inspect/<n>.png for the workflow to keep, so
 * "the outlines are off the imagery" can be looked at, not argued about.
 */
let pictured = 0;
async function picture(row) {
  if (!row.image_key) return;
  const f = parse(row.image_frame) || parse(row.frame);
  if (!f) return;
  const dir = 'inspect';
  mkdirSync(dir, { recursive: true });
  const raw = `${dir}/raw.bin`;
  try {
    execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'get',
      `lawn-mapper-corpus/${row.image_key}`, '--file', raw, '--remote'],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.log(`(no picture for ${row.id}: ${String(e.stderr || e.message).slice(0, 160)})`);
    return;
  }
  const meta = await sharp(raw).metadata();
  const W = meta.width;
  const H = meta.height;
  const path = (g) => {
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.map((poly) => poly.map((ring) => 'M' + ring.map((ll) => lngLatToFramePx(f, ll, W, H)
      .map((v) => v.toFixed(1)).join(',')).join('L') + 'Z').join(' ')).join(' ');
  };
  const parts = [];
  const parcel = parse(row.parcel);
  if (parcel) parts.push(`<path d="${path(parcel.geometry || parcel)}" fill="none" stroke="#f2c744" stroke-width="4"/>`);
  for (const g of geometries(parse(row.shapes))) {
    parts.push(`<path d="${path(g)}" fill="rgba(78,194,106,.25)" fill-rule="evenodd" stroke="#4ec26a" stroke-width="4"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;
  pictured += 1;
  const stem = `${dir}/${String(pictured).padStart(2, '0')}-${row.id.replace(/[^A-Za-z0-9.-]+/g, '_')}`;
  const out = `${stem}.png`;
  await sharp(raw).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(out);
  console.log(`picture   ${out}  (${W}x${H} photo, frame ${f.size}x${f.height || f.size} -> `
    + `${(W / f.size).toFixed(3)} x ${(H / (f.height || f.size)).toFixed(3)} px per frame px)`);
}

/**
 * How much ground two or more shapes share.
 *
 * Added up, overlapping shapes count the same grass twice. The union counts it
 * once. The difference is the overlap, and it is the number that says whether
 * a pile of shapes is "six pieces of one lawn" or "the same lawn drawn twice".
 */
export function overlapSqFt(geoms, grid = 512) {
  const rings = geoms
    .filter((g) => g?.type === 'Polygon' && Array.isArray(g.coordinates))
    .map((g) => g.coordinates);
  if (rings.length < 2) return { sumSqFt: areaSqFt(geoms), unionSqFt: areaSqFt(geoms), overlapSqFt: 0 };

  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const ring of r) for (const [lng, lat] of ring) {
    w = Math.min(w, lng); e = Math.max(e, lng);
    s = Math.min(s, lat); n = Math.max(n, lat);
  }
  const bbox = [w, s, e, n];
  const frame = {
    lng: (w + e) / 2, lat: (s + n) / 2,
    zoom: zoomToFit(bbox, grid, { minZoom: 0, maxZoom: 28 }),
    size: grid,
  };
  const project = (ll) => lngLatToFramePx(frame, ll, grid, grid);
  const masks = rings.map((r) => rasterizePolygon(r, grid, grid, project));

  const px = (metresPerPixel(frame, grid) ** 2) / SQM_PER_SQFT;
  let sum = 0;
  for (const m of masks) for (let p = 0; p < m.length; p++) if (m[p]) sum++;

  const union = unionMasks(masks);
  let once = 0;
  for (let p = 0; p < union.length; p++) if (union[p]) once++;

  return { sumSqFt: sum * px, unionSqFt: once * px, overlapSqFt: (sum - once) * px };
}

function describe(row) {
  const shapes = geometries(parse(row.shapes));
  const detectedRaw = parse(row.detected_shapes);
  const detected = geometries(detectedRaw);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`id        ${row.id}`);
  console.log(`status    ${row.status}   saved ${row.at}`);
  console.log(`county    ${row.county || '(traced by hand)'}`);
  console.log(`measured  ${row.provider || '?'} imagery, ${row.model || 'no model'}, ${row.mode || '?'} mode`);
  console.log(`photo     ${row.image_provider || '(none stored)'}  ${row.image_key || ''}`);
  if (row.county_svc) console.log(`county photo service ${row.county_svc}  aligned ${row.county_align || '(not moved)'}`);
  console.log(`corrected ${row.hand_edited ? 'yes' : 'no'}`);
  console.log(`release   ${row.model_version || '(none recorded)'}`);
  console.log(`not-lawn  ${geometries(parse(row.not_lawn)).length} trace(s)`);

  /*
   * THE TWO FRAMES, and whether the outline lands inside the photograph
   * (owner, 2026-09-30: review cards with outlines well off the imagery).
   * The card projects onto image_frame when a photo is stored; if the lawn's
   * own box falls mostly outside that rectangle, or far from its middle, the
   * frame and the picture disagree -- and this says by how much.
   */
  const frame = parse(row.frame);
  const imageFrame = parse(row.image_frame);
  const fmt = (f) => (f ? `${Number(f.lng).toFixed(6)},${Number(f.lat).toFixed(6)} z${Number(f.zoom).toFixed(3)} `
    + `${f.size}x${f.height || f.size}` : '(none)');
  console.log(`frame       ${fmt(frame)}`);
  console.log(`image frame ${fmt(imageFrame)}`);
  const shapeGeoms = geometries(parse(row.shapes));
  for (const [name, f] of [['frame', frame], ['image frame', imageFrame]]) {
    if (!f || !shapeGeoms.length) continue;
    const W = f.size;
    const H = f.height || f.size;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const g of shapeGeoms) {
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) for (const ring of poly) for (const ll of ring) {
        const [x, y] = lngLatToFramePx(f, ll, W, H);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    const mpp = metresPerPixel(f, W);
    console.log(`  lawn in ${name}: x ${Math.round(x0)}..${Math.round(x1)} of ${W}, `
      + `y ${Math.round(y0)}..${Math.round(y1)} of ${H} (${mpp.toFixed(3)} m/px)`);
  }
  if (frame && imageFrame) {
    const dLng = (imageFrame.lng - frame.lng) * 111320 * Math.cos(frame.lat * Math.PI / 180);
    const dLat = (imageFrame.lat - frame.lat) * 110540;
    console.log(`  image centre vs frame centre: ${dLng.toFixed(1)} m east, ${dLat.toFixed(1)} m north`);
  }

  /*
   * THE TWO CLAIMS THIS TOOL EXISTS FOR.
   *
   * "The overlapping shapes were there before pressing the button" is a claim
   * about `shapes`. "Pressing it drew nothing" is a claim about
   * `detected_shapes` -- and the difference between NULL and an empty list
   * matters, because the card shows the button for both and can only draw for
   * one. That distinction is invisible on screen and decides the answer.
   */
  console.log(`\nthe lawn (what the person ended up with)`);
  console.log(`  pieces         ${shapes.length}`);
  const o = overlapSqFt(shapes);
  console.log(`  added up       ${Math.round(o.sumSqFt).toLocaleString()} sq ft`);
  console.log(`  distinct       ${Math.round(o.unionSqFt).toLocaleString()} sq ft`);
  console.log(`  overlapping    ${Math.round(o.overlapSqFt).toLocaleString()} sq ft`
    + (o.unionSqFt > 0 ? `  (${((100 * o.overlapSqFt) / o.unionSqFt).toFixed(1)}% of the lawn)` : ''));
  console.log(`  stored total   ${Number(row.square_feet || 0).toLocaleString()} sq ft`);

  console.log(`\nthe AI's version`);
  if (detectedRaw === null) {
    console.log("  NOT STORED (null). The card hides the button, which is right.");
  } else if (!detected.length) {
    console.log(`  STORED BUT EMPTY (${JSON.stringify(detectedRaw).slice(0, 40)}).`);
    console.log('  This is the bug: an empty list is truthy, so the card shows');
    console.log('  the button and then draws nothing when it is pressed.');
  } else {
    console.log(`  pieces         ${detected.length}`);
    console.log(`  area           ${Math.round(areaSqFt(detected)).toLocaleString()} sq ft`);
  }
}

async function main() {
  const id = process.env.ID || '';
  const status = process.env.STATUS || 'rejected';

  /* 'noparcel': approved maps with no property line at all, which training
     grades over the whole frame (owner, 2026-10-02). */
  /* A map's name as the console shows it -- B07, C55 -- as well as its id
     (2026-10-08: "its assigned c55"). */
  const tag = /^[BbCc]\d+$/.test(id) ? id.toUpperCase() : null;
  const where = tag
    ? (tag[0] === 'B' ? `id = '${String(benchmarkId(tag) || '').replace(/'/g, "''")}'` : `lot_no = ${Number(tag.slice(1))}`)
    : id
    ? `id = '${id.replace(/'/g, "''")}'`
    : status === 'noparcel'
      ? "status = 'approved' AND (parcel IS NULL OR parcel = '' OR parcel = 'null')"
      : `status = '${status.replace(/'/g, "''")}'`;

  let rows = [];
  try {
    rows = query(`
      SELECT id, at, status, county, provider, model, mode, hand_edited,
             image_provider, square_feet, shapes, detected_shapes,
             frame, image_frame, parcel, model_version, image_key, not_lawn,
             county_svc, county_align
        FROM corpus WHERE ${where} ORDER BY at DESC LIMIT ${Math.max(1, Math.min(60, Number(process.env.LIMIT) || 5))}
    `);
  } catch (err) {
    console.log('Could not read the database, so nothing was inspected.');
    console.log(err.message);
    process.exitCode = 1;
    return;
  }

  if (!rows.length) {
    console.log(id ? `No map with id ${id}.` : `No maps with status "${status}".`);
    return;
  }

  console.log(`${rows.length} map${rows.length === 1 ? '' : 's'} to look at.`);
  for (const row of rows) describe(row);
  /* EVERY COUNTY SERVICE THE CATALOGUE HAS OVER THE SPOT (owner, 2026-10-09:
     the banked county photo was a different flight from the live one), with
     when each was last checked, so a photo that is no longer offered can be
     traced to the row that gave it. Only rows still in the catalogue. */
  for (const row of rows) {
    const f = parse(row.frame);
    if (!f || !Number.isFinite(f.lng) || !Number.isFinite(f.lat)) continue;
    try {
      const svcs = query(`SELECT id, title, url, year, native_cm, max_px, export_ok, tile_merc, checked_at, leaf, flown
                            FROM county_services WHERE west <= ${f.lng} AND east >= ${f.lng} AND south <= ${f.lat} AND north >= ${f.lat}
                           ORDER BY id`);
      console.log(`\ncounty services in the catalogue over ${row.id} (${svcs.length}):`);
      for (const s of svcs) {
        console.log(`  #${s.id} ${s.title || '(untitled)'}  year ${s.year ?? '?'}  native ${s.native_cm ?? '?'} cm  ${s.tile_merc ? 'tile cache' : 'export'}${s.export_ok ? '' : ' (no export)'}`
          + `  leaf ${s.leaf || '?'}${s.flown ? ` flown ${s.flown}` : ''}  checked ${s.checked_at || '?'}\n     ${s.url}`);
      }
    } catch { /* an older database */ }
  }
  /* The county photo's own service, for a map drawn on one: a fault in the
     picture (2026-10-08, C55's black stripe) is usually the service's. */
  for (const row of rows) {
    const svc = Number(row.county_svc);
    if (!Number.isInteger(svc) || svc <= 0) continue;
    try {
      const [s] = query(`SELECT id, url, type, title, year, native_cm, tile_merc, export_ok, max_px FROM county_services WHERE id = ${svc}`);
      if (s) console.log(`\ncounty photo for ${row.id}: #${s.id} ${s.title || ''} ${s.year || ''}, ${s.native_cm || '?'} cm, `
        + `${s.tile_merc ? 'tile cache' : s.type || '?'}${s.export_ok ? ', exports' : ''}${s.max_px ? `, max ${s.max_px}px` : ''}\n  ${s.url}`);
    } catch { /* the picture below still says what it can */ }
  }
  for (const row of rows) await picture(row);

  console.log(`\n${'='.repeat(64)}`);
  console.log('\nOverlap is not a problem for training: the target is a filled');
  console.log('mask, so two shapes over the same ground paint the same pixels.');
  console.log('It matters here only because it makes the card hard to read.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
