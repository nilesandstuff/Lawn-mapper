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
  capturePlan, groundPerPixel, TARGET_GROUND_M,
} from '../worker/src/imagery.js';

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
  SELECT id, county, frame, image_frame, image_key, image_provider, status
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
  + `${f.lng},${f.lat},${f.zoom},0/${f.size}x${f.size}@2x`
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
  const side = px * plan.cols;
  const out = new Uint8Array(side * side * 4);

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
    if (img.width !== px) {
      /* Mapbox served a different size from the one asked for, which would
         paste misaligned and leave a seam. Refused rather than stitched. */
      return { ok: false, reason: `tile-${img.width}px-wanted-${px}` };
    }

    const ox = tile.col * px;
    const oy = tile.row * px;
    for (let y = 0; y < px; y++) {
      const from = y * px * 4;
      const to = ((oy + y) * side + ox) * 4;
      out.set(img.data.subarray(from, from + px * 4), to);
    }
  }
  return { ok: true, pixels: out, side };
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
      const display = parse(row.frame);
      if (!display) { failed++; continue; }
      const label = String(row.county || 'traced by hand').padEnd(20).slice(0, 20);

      /* What it is banked at NOW. A row with no image_frame was taken on the
         display frame, which is exactly the case this exists to fix. */
      const wasFrame = parse(row.image_frame) || display;
      const was = groundPerPixel(wasFrame);
      const plan = capturePlan(display);

      if (!FORCE && was <= plan.groundM + 1e-9) {
        skipped++;
        console.log(`  ${label} ${(was * 100).toFixed(1).padStart(5)} cm/px  already at least as fine`);
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

      const png = new decoders.png.PNG({ width: shot.side, height: shot.side });
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
      if (plan.cols > 1) tiled++;
      console.log(`  ${label} ${(was * 100).toFixed(1).padStart(5)} -> `
        + `${(plan.groundM * 100).toFixed(1).padStart(5)} cm/px  `
        + `${shot.side}px${plan.cols > 1 ? `  ${plan.cols}x${plan.rows} stitched` : ''}`
        + `${plan.capped ? '  still capped' : ''}`);
    }

    /* ---------------------------------------------------- the end of the log */
    const mid = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0);
    console.log(`\n${'='.repeat(64)}\n`);
    console.log(`${DRY ? 'WOULD RE-BANK' : 'Re-banked'} ${done}.  `
      + `Left alone ${skipped} already fine.  Failed ${failed}.`);
    if (tiled) console.log(`${tiled} needed stitching from ${2 * 2} tiles.`);
    if (gains.length) {
      console.log(`\nResolution gained: up to ${Math.max(...gains).toFixed(1)}x finer, `
        + `middle ${mid(gains).toFixed(1)}x.`);
    }
    console.log('\nOnly the photograph and its frame changed. No outline, no');
    console.log('parcel, no review status: a map somebody traced by hand is the');
    console.log('same map, of a better picture of the same ground.');
    if (!DRY && done) {
      console.log('\nRun workflow 19 next to see whether the canopy reads better on');
      console.log('the big lawns, which is the whole point of H20.');
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
