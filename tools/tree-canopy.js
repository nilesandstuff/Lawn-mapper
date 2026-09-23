/**
 * Draw the tree canopy over the lawns it was found on, so somebody can look at
 * it.
 *
 * STAGE 2 of the plan in docs/DETECTOR-FINDINGS.md. The canopy raster is the
 * product; this draws it, and reports what share of it sits on ground somebody
 * traced as lawn and what share is on the property at all.
 *
 * THE CROWNS ARE GONE and the numbers that went with them went too. This used
 * to cut the canopy into crowns with a watershed and report how many there
 * were and how many were big enough to tap. The model is semantic -- tree or
 * no tree, per pixel -- so those counts were facts about the watershed's gap
 * parameter rather than about the trees, and they were published as results.
 * See H18 and H19.
 *
 * What survives is the pair of ratios, because they were always nearly canopy
 * statistics: the clump outlines are disjoint, so summing over them is summing
 * over the canopy minus simplification and the smallest patches.
 *
 *   onLawnPct   how much canopy sits on ground traced as lawn
 *   insidePct   how much canopy is inside the property line at all
 *
 * READ THEM TOGETHER OR NEITHER MEANS ANYTHING. Low on the lawn and high
 * inside the line is somebody looking at those trees and deciding there is no
 * grass under them. Low on both is a neighbour's tree, which nobody was ever
 * asked about.
 *
 * It reuses the detector's own fetch, resize, rasteriser and renderer so the
 * pictures are directly comparable with /predictions.html -- same frames, same
 * dimming outside the property line, same green for the traced lawn.
 *
 *   node tools/tree-canopy.js
 *
 * or, the way anybody actually runs it, workflow "19. Find the tree canopy".
 */

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { query } from './corpus-db.js';
import {
  fetchImage, resize, maskOf, geometries, inferredGeometries, GRID,
} from './train-detector.js';
import { drawPrediction } from './render-prediction.js';
import { runSlug, runKeys, runRow, publishRunList } from './run-folder.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { metresPerPixel } from '../public/lib/mercator.js';

const SQM_PER_SQFT = 0.09290304;

const CANOPY = process.env.CANOPY || process.env.CROWNS || 'canopy';
const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';

/** What this run was for, in the words of whoever started it. See RUN_ABOUT
    in tools/train-detector.js for why it is a sentence and not a flag dump. */
const RUN_ABOUT = String(process.env.RUN_ABOUT || '').trim().slice(0, 600);

const QUERY = `
  SELECT id, county, frame, image_frame, shapes, parcel, image_key
    FROM corpus
   WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL
   ORDER BY at DESC
   LIMIT 200
`;

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

/**
 * A clump's polygon, from the dumped frame's pixels into the 512 grid
 * everything is drawn and measured on.
 *
 * The frames are written at whatever DUMP_SIZE the run used and the renderer
 * works at GRID. One scale factor, applied once, here -- rather than in the
 * Python, which does not know what the renderer wants, or in the renderer,
 * which would then need to know where the numbers came from.
 */
export const toGrid = (polygon, framePx) => polygon.map(([x, y]) => [
  (x * GRID) / framePx, (y * GRID) / framePx,
]);

/**
 * How much of a clump lands on ground the tracer called lawn.
 *
 * `rasterizePolygon(rings, width, height, project)` -- the projection is
 * IDENTITY here because a clump arrives already in the grid's own pixels,
 * where every other caller hands it lng/lat and a frame to project through.
 * Getting that argument list wrong is what killed the first run of this, and
 * it did not throw where the mistake was: the mask went in as `width`, so the
 * error surfaced four frames later as "undefined is not a function" from a
 * missing projector.
 */
/**
 * The model's own tree/no-tree answer, from the PNG the Python wrote, onto the
 * grid everything is drawn on.
 *
 * NEAREST NEIGHBOUR, NOT AVERAGED, and that matters here more than it usually
 * does. This is a yes/no raster; averaging it would put a grey halo round
 * every clump and the halo would then be thresholded back into canopy that the
 * model never claimed -- a thin one around sixty clumps is a lot of invented
 * tree. Sampling asks the same question of the same pixel and cannot invent
 * anything.
 *
 * Missing is not an error. The masks arrived with a later version of the
 * Python than some canopy folders were written by, and a run without them
 * should still draw its shapes.
 */
function maskFromPng(file, decoders) {
  if (!existsSync(file)) return null;
  const png = decoders.png.PNG.sync.read(readFileSync(file));
  const out = new Uint8Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) {
    const sy = Math.min(png.height - 1, Math.floor((y * png.height) / GRID));
    for (let x = 0; x < GRID; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / GRID));
      /* Red alone: the Python writes 1-bit, which decodes to white or black,
         so the three channels agree and one read is enough. */
      out[y * GRID + x] = png.data[(sy * png.width + sx) * 4] > 127 ? 1 : 0;
    }
  }
  return out;
}

export function overlap(ring, truth, within) {
  const mask = rasterizePolygon([ring], GRID, GRID, (p) => p);
  let area = 0;
  let onLawn = 0;
  let inside = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    area++;
    if (!within || within[i]) inside++;
    if (truth[i]) onLawn++;
  }
  return { area, onLawn, inside };
}

async function main() {
  if (!existsSync(CANOPY)) {
    console.log(`No ${CANOPY}/ directory. Run tools/tree-canopy.py first.`);
    process.exitCode = 1;
    return;
  }

  /* `.default` on jpeg-js and not on pngjs, which is how train-detector.js
     builds the same pair -- jpeg-js is CommonJS, so the namespace object has
     the decoder under `default` and `decoders.jpeg.decode` would be undefined
     on the first JPEG rather than at startup. */
  const decoders = {
    png: await import('pngjs'),
    jpeg: (await import('jpeg-js')).default,
  };

  const rows = query(QUERY);
  console.log(`${rows.length} approved maps.\n`);

  const dir = mkdtempSync(join(tmpdir(), 'canopy-'));
  const entries = [];
  let put = 0;

  /* A folder of this run's own, named for the minute and the model, so a
     later run never overwrites these and they stay comparable. */
  const startedAt = new Date();
  const model = process.env.MODEL || 'restor/tcd-segformer';
  const slug = runSlug({ at: startedAt, models: [model] });
  const keys = runKeys(slug);

  try {
    for (const row of rows) {
      const file = join(CANOPY, `${row.id}.json`);
      if (!existsSync(file)) continue;
      const found = parse(readFileSync(file, 'utf8'));
/*
       * THE FRAME THE PHOTOGRAPH WAS TAKEN ON, which since H20 is not the one
       * the phone displayed. The banked picture is captured at 10 cm a pixel
       * or better, so its zoom and size differ from the display's -- and a
       * mask rasterised against the wrong one would not line up with the
       * pixels it is supposed to describe.
       *
       * Rows banked before that column existed have no `image_frame`, and
       * those really were taken on `frame`, so the fallback is correct rather
       * than a guess.
       */
      const frame = parse(row.image_frame) || parse(row.frame);
      const truthGeoms = geometries(parse(row.shapes));
      if (!found || !frame || !truthGeoms.length) continue;

      const img = fetchImage(BUCKET, row.image_key, dir, decoders);
      if (!img.ok) {
        console.log(`  skipped ${row.id.slice(0, 28)} -- ${img.reason}`);
        continue;
      }

      const photo = resize(img.data, img.width, img.height, img.channels, GRID);
      const truth = maskOf(truthGeoms, frame, GRID);
      const inferredGeoms = inferredGeometries(parse(row.shapes));
      const inferred = inferredGeoms.length ? maskOf(inferredGeoms, frame, GRID) : null;
      const parcelGeom = parse(row.parcel);
      const within = parcelGeom ? maskOf([parcelGeom], frame, GRID) : null;
      const mpp = metresPerPixel(frame, GRID);
      const sqft = (px) => (px * mpp * mpp) / SQM_PER_SQFT;

      const rings = [];
      let onLawnPx = 0;
      let clumpPx = 0;
      let insidePx = 0;

      for (const clump of found.clumps || found.crowns || []) {
        const ring = toGrid(clump.polygon, found.framePx || GRID);
        rings.push(ring);
        const o = overlap(ring, truth, within);
        clumpPx += o.area;
        onLawnPx += o.onLawn;
        insidePx += o.inside;
      }

      const n = entries.length;
      const write = (pix, name) => {
        const png = new decoders.png.PNG({ width: GRID, height: GRID });
        png.data = Buffer.from(pix.buffer, pix.byteOffset, pix.length);
        const out = join(dir, name);
        writeFileSync(out, decoders.png.PNG.sync.write(png));
        return out;
      };

      const shots = [[keys.shapes(n), drawPrediction({
        photo, truth, within, inferred, rings, grid: GRID,
      }), `${n}.png`]];

      /*
       * AND THE RASTER THE CROWNS WERE CUT OUT OF, where the Python left one.
       *
       * The clump outlines beside it are a simplified boundary of this; the
       * raster is where the holes, the speckle and the thin connections
       * between patches actually live, and stage 3 will work on the raster
       * rather than on the outlines.
       */
      const canopy = maskFromPng(join(CANOPY, `${row.id}-mask.png`), decoders);
      const maskKey = canopy ? keys.mask(n) : null;
      if (canopy) {
        shots.push([maskKey, drawPrediction({
          photo, truth, within, inferred, mask: canopy, grid: GRID,
          /*
           * UNCLIPPED, because the clump outlines beside it are. A clump ring
           * covers whatever canopy the model found, and is never cut at the
           * property line, so clipping the canopy under it made the canopy
           * appear to stop at a boundary the outlines sailed past -- which
           * reads as the mask being truncated, and was. Beyond the line it draws weaker, matching the
           * dimmed photograph: a neighbour's tree is a fact about the picture,
           * not a claim about the property.
           */
          clipMask: false,
        }), `${n}-mask.png`]);
      }

      try {
        for (const [k, pix, name] of shots) {
          execFileSync('npx', [
            'wrangler', 'r2', 'object', 'put', `${BUCKET}/${k}`,
            '--file', write(pix, name), '--content-type', 'image/png', '--remote',
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
        }
        put++;
      } catch (e) {
        console.log(`  could not upload ${keys.shapes(n)}: `
          + `${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 80)}`);
        continue;
      }

      entries.push({
        key: keys.shapes(n),
        maskKey,
        county: row.county || null,
        /* Contiguous patches of canopy. NOT a count of trees: two trees whose
           branches touch are one clump. */
        clumps: rings.length,
        clumpSqFt: Math.round(sqft(clumpPx)),
        /*
         * How much of the canopy sits on ground the tracer called lawn, and
         * how much is on the property at all. Neither reads alone -- see the
         * note at the top of this file.
         */
        onLawnPct: clumpPx ? Number(((100 * onLawnPx) / clumpPx).toFixed(1)) : null,
        insidePct: clumpPx ? Number(((100 * insidePx) / clumpPx).toFixed(1)) : null,
        canopySqFt: Math.round((found.canopySqM || 0) / SQM_PER_SQFT),
        readAtPx: found.readAt?.px ?? null,
        mpp: Number(mpp.toFixed(3)),
        /* Whether this frame had to be UPSAMPLED to reach the model's 10 cm.
           Above 1.0 the model was shown interpolation rather than imagery. */
        metresAcross: found.metresAcross ?? null,
        sourceMpp: found.sourceMpp ?? null,
        upsampled: found.upsampled ?? null,
      });

      const e = entries[entries.length - 1];
      console.log(
        `  ${String(row.county || 'traced by hand').padEnd(22).slice(0, 22)} `
        + `${String(rings.length).padStart(3)} clumps  `
        + `${String(e.onLawnPct ?? '--').padStart(5)}% on traced lawn  `
        + `${String(e.insidePct ?? '--').padStart(5)}% inside the line`
        + (e.upsampled > 1.05 ? `  UPSAMPLED ${e.upsampled}x` : '')
      );
    }

    if (!entries.length) {
      console.log('\nNothing could be drawn.');
      process.exitCode = 1;
      return;
    }

    /* Most canopy first: the wooded lots are where stage 3 has work to do. */
    entries.sort((a, b) => (b.canopySqFt || 0) - (a.canopySqFt || 0));

    const settings = {
      model,
      minClumpM2: Number(process.env.MIN_CLUMP_M2 || 4),
      targetMpp: Number(process.env.TARGET_MPP || 0.1),
      gridPx: GRID,
      lawns: entries.length,
    };

    const indexFile = join(dir, 'index.json');
    writeFileSync(indexFile, `${JSON.stringify({
      drawnAt: new Date().toISOString(),
      slug,
      config: 'tree canopy',
      features: model,
      about: RUN_ABOUT,
      settings,
      lawns: entries.length,
      note: 'Tree canopy over the lawn somebody traced by hand (green). "Raw mask" '
        + 'is the model\'s own tree/no-tree answer per pixel; "shapes" is the '
        + 'simplified outline of each contiguous patch. A patch is NOT a tree -- '
        + 'two trees whose branches touch are one patch. Read the two percentages '
        + 'together: low on the lawn and high inside the line is a tracer deciding '
        + 'there is no grass under those trees; low on both is a neighbour\'s tree.',
      entries,
    }, null, 1)}\n`);

    execFileSync('npx', [
      'wrangler', 'r2', 'object', 'put', `${BUCKET}/${keys.index}`,
      '--file', indexFile, '--content-type', 'application/json', '--remote',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    /* The picker last, once everything it points at is in the bucket. */
    const list = publishRunList(BUCKET, dir, runRow({
      slug,
      at: startedAt,
      title: `tree canopy · ${model.split('/').pop()}`,
      about: RUN_ABOUT,
      settings,
      lawns: entries.length,
      /* No headline. These are not a measurement and a number in the picker
         would be read as one. */
      headline: null,
    }));

    /* ------------------------------------------------- the end of the log */
    const clumps = entries.map((e) => e.clumps);
    const shares = entries.map((e) => e.onLawnPct).filter((v) => v !== null);
    const inside = entries.map((e) => e.insidePct).filter((v) => v !== null);
    const mid = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

    console.log(`\n${'='.repeat(64)}\n`);
    console.log(`Drew ${put} lawns. Open /predictions.html and pick this run:`);
    console.log(`  ${slug}`);
    console.log(`The page now lists ${list.runs} run${list.runs === 1 ? '' : 's'}. `
      + 'The button at the top flips every');
    console.log('picture between the canopy outlines and the raw per-pixel mask.');

    console.log(`\nContiguous patches of canopy per lawn: ${Math.min(...clumps)} to `
      + `${Math.max(...clumps)}, middle ${mid(clumps)}.`);
    console.log('A PATCH IS NOT A TREE. Two trees whose branches touch are one patch.');
    console.log('This run does not count trees and nothing here should be read as if');
    console.log('it did -- the model answers tree or no tree, per pixel, and has no');
    console.log('notion of where one tree ends. See H18 and H19.');

    if (shares.length && inside.length) {
      console.log(`\nCanopy on ground traced as lawn:  ${Math.min(...shares).toFixed(0)}% to `
        + `${Math.max(...shares).toFixed(0)}%, middle ${mid(shares).toFixed(0)}%.`);
      console.log(`Canopy inside the property line: ${Math.min(...inside).toFixed(0)}% to `
        + `${Math.max(...inside).toFixed(0)}%, middle ${mid(inside).toFixed(0)}%.`);
      console.log('\nREAD THE TWO TOGETHER. Low on the lawn and HIGH inside the line');
      console.log('means somebody looked at those trees and decided there is no grass');
      console.log('under them. Low on both means the canopy is a neighbour\'s and the');
      console.log('first number was never about anybody\'s judgement.');

      const judged = entries
        .filter((e) => e.insidePct >= 50 && e.onLawnPct !== null && e.onLawnPct < 10).length;
      const elsewhere = entries.filter((e) => e.insidePct !== null && e.insidePct < 25).length;
      console.log(`\n${judged} lawns are mostly on the property and mostly NOT on the lawn: `
        + 'trees somebody declined.');
      console.log(`${elsewhere} lawns are mostly off the property: not theirs to answer.`);
    }

    /*
     * THE RESOLUTION SPLIT, which is the open question about this step.
     *
     * The stored photograph is a fixed pixel count whatever the lot, so a big
     * lot arrives coarser than the model's 10 cm and reaching 10 cm means
     * INVENTING pixels. Printed at the end because it is the first thing to
     * rule out when the canopy reads worse on the bigger lots.
     */
    const up = entries.filter((e) => e.upsampled > 1.05);
    if (up.length) {
      const worst = up.reduce((a, b) => (a.upsampled > b.upsampled ? a : b));
      console.log(`\n${up.length} of ${entries.length} lawns were UPSAMPLED to reach the `
        + `model's 10 cm,`);
      console.log(`worst ${worst.upsampled}x at ${Math.round(worst.metresAcross)} m across. `
        + 'Upsampling adds pixels, not detail.');
    } else if (entries.some((e) => e.upsampled !== null)) {
      console.log('\nNo lawn was upsampled: every frame was at or finer than 10 cm.');
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
