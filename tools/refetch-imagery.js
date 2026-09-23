/**
 * Re-bank every corpus photograph at the detector's own scale.
 *
 * WHY. Until 2026-09-23 the resolution of a stored photograph was a side
 * effect of how big the lot was: `zoomToFit` fits the parcel into a fixed 640
 * logical pixels, so a 25 m garden was banked at 2 cm a pixel and a 319 m lot
 * at 25 cm. The detector wants 10 cm, so the big lots were being upsampled
 * into it -- handed interpolation dressed as imagery. That is H20, and it is
 * the best explanation anyone has for the canopy model reading worse on big
 * lawns.
 *
 * `captureFrame` fixed it at the point of capture, but only for photographs
 * banked from then on. The ones already in the bucket keep whatever they were
 * taken at. This re-takes them.
 *
 * WHAT IT DOES NOT TOUCH. The outline, the parcel, the review status, the
 * account -- nothing but the photograph and the frame it was shot on. A map
 * somebody traced by hand is not re-traced by this; the same lawn is simply
 * photographed again, better.
 *
 * ONLY WHERE IT HELPS. A lot already banked finer than 10 cm is left alone,
 * because re-taking it could only make it worse: the imagery may have been
 * reflown since, and a photograph is the archive. Pass FORCE=true to override
 * that, which is for after a change to the capture rules rather than for
 * ordinary use.
 *
 * IT COSTS MAPBOX REQUESTS, one or four per lawn, on the same free tier the
 * app already uses. Nothing is bought from Replicate.
 *
 *   node tools/refetch-imagery.js
 *
 * or workflow "21. Re-bank the photographs at 10 cm".
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { query, wrangler, resolveDatabase } from './corpus-db.js';
import {
  capturePlan, groundPerPixel, groundAcross, TARGET_GROUND_M,
} from '../worker/src/imagery.js';
import { frameFor, geometryBounds } from '../public/lib/mercator.js';

/*
 * THE FRAME IS THE PARCEL'S BOX PLUS THIS MARGIN, CROPPED BOTH WAYS -- the
 * same rule the app uses for its display frame (FRAME_MARGIN_M in app.js),
 * so a banked photograph is the picture the live detector would have seen.
 * A square around the longer side put the neighbours in on both sides of
 * the shorter one, and every detector read them.
 */
const MARGIN_M = 10;
const LONG_SIDE = 640;

const TOKEN = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN || '';
const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
const FORCE = /^(1|true|yes)$/i.test(String(process.env.FORCE || ''));
const LIMIT = Number(process.env.LIMIT || 200);
const DRY = /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ''));

/*
 * ONLY MAPBOX ROWS. A lawn banked against NAIP was banked there deliberately
 * -- NAIP is a different photograph of the same place, often a different year
 * -- and re-taking it from Mapbox would quietly swap the source out from under
 * a map somebody approved while looking at it.
 */
const QUERY = `
  SELECT id, county, frame, parcel, image_frame, image_key, image_provider, status
    FROM corpus
   WHERE frame IS NOT NULL AND image_key IS NOT NULL
     AND (image_provider IS NULL OR image_provider = 'mapbox')
   ORDER BY at DESC
   LIMIT ${LIMIT}
`;

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const esc = (s) => String(s).replace(/'/g, "''");

const url = (f) =>
  'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/'
  + `${f.lng},${f.lat},${f.zoom},0/${f.size}x${f.height || f.size}@2x`
  + `?access_token=${TOKEN}&attribution=false&logo=false`;

/**
 * Fetch every tile of one photograph and paste them into a single image.
 *
 * The tiles abut exactly because the split is done in world pixels -- see
 * `capturePlan`. So this is a plain paste at (col * px, row * px) with no
 * blending, and any seam would be a bug in the plan rather than something to
 * feather over here. tools/capture-frame.test.js is what guards that.
 */
async function stitch(plan, decoders) {
  const px = plan.tileSize * 2;
  const py = (plan.tileHeight || plan.tileSize) * 2;
  const width = px * plan.cols;
  const height = py * plan.rows;
  const out = new Uint8Array(width * height * 4);

  for (const tile of plan.tiles) {
    const res = await fetch(url(tile.frame));
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const type = res.headers.get('content-type') || '';
    /* Mapbox answers a bad request with JSON and a 200, so the content type is
       the only thing separating a photograph from an apology. */
    if (!type.startsWith('image/')) return { ok: false, reason: 'not-an-image' };

    const buf = Buffer.from(await res.arrayBuffer());
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const img = isPng
      ? decoders.png.PNG.sync.read(buf)
      : decoders.jpeg.decode(buf, { useTArray: true });
    if (img.width !== px || img.height !== py) {
      /* Mapbox served a different size from the one asked for, which would
         paste misaligned and leave a seam. Refused rather than stitched. */
      return { ok: false, reason: `tile-${img.width}x${img.height}px-wanted-${px}x${py}` };
    }

    const ox = tile.col * px;
    const oy = tile.row * py;
    for (let y = 0; y < py; y++) {
      const from = y * px * 4;
      const to = ((oy + y) * width + ox) * 4;
      out.set(img.data.subarray(from, from + px * 4), to);
    }
  }
  return { ok: true, pixels: out, width, height };
}

async function main() {
  if (!TOKEN) {
    console.log('No MAPBOX_TOKEN, so nothing can be fetched.');
    process.exitCode = 1;
    return;
  }

  const decoders = {
    png: await import('pngjs'),
    jpeg: (await import('jpeg-js')).default,
  };

  const rows = query(QUERY);
  console.log(`${rows.length} maps banked against Mapbox.\n`);

  const dir = mkdtempSync(join(tmpdir(), 'refetch-'));
  let done = 0, skipped = 0, failed = 0, tiled = 0;
  const gains = [];

  try {
    for (const row of rows) {
      /* The parcel's box plus the margin, cropped both ways; a row with no
         parcel keeps the frame the phone showed. */
      const parcel = parse(row.parcel);
      const bbox = parcel ? geometryBounds(parcel) : null;
      const display = bbox ? frameFor(bbox, LONG_SIDE, { marginM: MARGIN_M }) : parse(row.frame);
      if (!display) { failed++; continue; }
      const label = String(row.county || 'traced by hand').padEnd(20).slice(0, 20);

      /* What it is banked at NOW. A row with no image_frame was taken on the
         display frame, which is exactly the case this exists to fix. */
      const wasFrame = parse(row.image_frame) || parse(row.frame);
      const was = groundPerPixel(wasFrame);
      const plan = capturePlan(display);

      /* Left alone only when the photograph in the bucket is the same
         rectangle of ground at least as fine. A square from before the crop
         is not the same rectangle, whatever its resolution. */
      const shape = (f) => (f.height || f.size) / f.size;
      const sameShape = Number.isFinite(wasFrame.height)
        && Math.abs(shape(wasFrame) - shape(plan.frame)) < 0.01
        && Math.abs(groundAcross(wasFrame) - plan.across) < 1;
      if (!FORCE && sameShape && was <= plan.groundM + 1e-9) {
        skipped++;
        console.log(`  ${label} ${(was * 100).toFixed(1).padStart(5)} cm/px  already this rectangle, at least as fine`);
        continue;
      }

      if (DRY) {
        console.log(`  ${label} ${(was * 100).toFixed(1).padStart(5)} -> `
          + `${(plan.groundM * 100).toFixed(1).padStart(5)} cm/px  ${plan.cols}x${plan.rows}`);
        done++;
        gains.push(was / plan.groundM);
        continue;
      }

      const shot = await stitch(plan, decoders);
      if (!shot.ok) {
        failed++;
        console.log(`  ${label} FAILED: ${shot.reason}`);
        continue;
      }

      const png = new decoders.png.PNG({ width: shot.width, height: shot.height });
      png.data = Buffer.from(shot.pixels.buffer, shot.pixels.byteOffset, shot.pixels.length);
      const file = join(dir, 'shot.png');
      writeFileSync(file, decoders.png.PNG.sync.write(png));

      try {
        /* The SAME key, so the new photograph replaces the old one rather than
           leaving an orphan behind and a row pointing at the wrong one. */
        execFileSync('npx', [
          'wrangler', 'r2', 'object', 'put', `${BUCKET}/${row.image_key}`,
          '--file', file, '--content-type', 'image/png', '--remote',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        /* And the frame it was taken on, in the same breath. A photograph whose
           frame did not travel with it is one nothing can build a mask for. */
        wrangler(['d1', 'execute', resolveDatabase(true), '--remote', '--command',
          `UPDATE corpus SET image_frame = '${esc(JSON.stringify(plan.frame))}' `
          + `WHERE id = '${esc(row.id)}'`]);
      } catch (e) {
        failed++;
        console.log(`  ${label} could not store: `
          + `${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 70)}`);
        continue;
      }

      done++;
      gains.push(was / plan.groundM);
      if (plan.tiles.length > 1) tiled++;
      console.log(`  ${label} ${(was * 100).toFixed(1).padStart(5)} -> `
        + `${(plan.groundM * 100).toFixed(1).padStart(5)} cm/px  `
        + `${shot.width}x${shot.height}px${plan.tiles.length > 1 ? `  ${plan.cols}x${plan.rows} stitched` : ''}`
        + `${plan.capped ? '  still capped' : ''}`);
    }

    /* ---------------------------------------------------- the end of the log */
    const mid = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0);
    console.log(`\n${'='.repeat(64)}\n`);
    console.log(`${DRY ? 'WOULD RE-BANK' : 'Re-banked'} ${done}.  `
      + `Left alone ${skipped} already fine.  Failed ${failed}.`);
    if (tiled) console.log(`${tiled} needed stitching from more than one request.`);
    if (gains.length) {
      console.log(`\nResolution gained: up to ${Math.max(...gains).toFixed(1)}x finer, `
        + `middle ${mid(gains).toFixed(1)}x.`);
    }
    console.log('\nOnly the photograph and its frame changed. No outline, no');
    console.log('parcel, no review status: a map somebody traced by hand is the');
    console.log('same map, of a better picture of the same ground.');
    if (!DRY && done) {
      console.log('\nEvery photograph is now the parcel plus 10 m, cropped both ways,');
      console.log('at 10 cm a pixel or finer. Run workflow 19 and 14 on them next.');
    }
    console.log(`\n${'='.repeat(64)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log('Stopped:', e.message);
    process.exitCode = 1;
  });
}
