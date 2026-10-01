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
import { resolve } from 'node:path';
import { query } from './corpus-db.js';
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
  console.log(`photo     ${row.image_provider || '(none stored)'}`);
  console.log(`corrected ${row.hand_edited ? 'yes' : 'no'}`);
  console.log(`release   ${row.model_version || '(none recorded)'}`);

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

function main() {
  const id = process.env.ID || '';
  const status = process.env.STATUS || 'rejected';

  const where = id
    ? `id = '${id.replace(/'/g, "''")}'`
    : `status = '${status.replace(/'/g, "''")}'`;

  let rows = [];
  try {
    rows = query(`
      SELECT id, at, status, county, provider, model, mode, hand_edited,
             image_provider, square_feet, shapes, detected_shapes,
             frame, image_frame, parcel, model_version
        FROM corpus WHERE ${where} ORDER BY at DESC LIMIT 5
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

  console.log(`\n${'='.repeat(64)}`);
  console.log('\nOverlap is not a problem for training: the target is a filled');
  console.log('mask, so two shapes over the same ground paint the same pixels.');
  console.log('It matters here only because it makes the card hard to read.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
