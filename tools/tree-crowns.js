/**
 * Draw the tree crowns over the lawns they were found on, so somebody can look
 * at them.
 *
 * THE QUESTION THIS ANSWERS IS NOT "how accurate is the model". It is: would
 * these crowns work as TOGGLES -- one tap each, on for grass underneath and off
 * to ignore. Those are different questions and the second is not answerable
 * from a number. A model that finds 94% of the canopy as one enormous blob is
 * accurate and useless here; one that finds nine crowns out of eleven, each
 * cleanly separated, is less accurate and exactly what is wanted.
 *
 * So the deliverable is pictures, and the numbers beside them are about the
 * EDITING rather than the accuracy: how many crowns, how many are big enough to
 * hit with a thumb, and -- the one that matters most -- how much of the crown
 * area falls inside the lawn somebody traced by hand.
 *
 * WHY THAT LAST NUMBER IS THE MEASUREMENT. A crown sitting inside the traced
 * lawn is a tree the tracer decided has grass under it: a toggle that should
 * start ON. A crown outside it is one they decided against: OFF. If those two
 * groups separate cleanly the toggles have something to be right about. If the
 * crowns land half in and half out of every lawn, the idea does not work and
 * this is where it shows.
 *
 * It reuses the detector's own fetch, resize, rasteriser and renderer so the
 * pictures are directly comparable with /predictions.html -- same frames, same
 * dimming outside the property line, same green for the traced lawn.
 *
 *   node tools/tree-crowns.js
 *
 * or, the way anybody actually runs it, workflow "19. Find the tree crowns".
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
import { rasterizePolygon } from '../public/lib/mask.js';
import { metresPerPixel } from '../public/lib/mercator.js';

const SQM_PER_SQFT = 0.09290304;

const CROWNS = process.env.CROWNS || 'crowns';
const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';

/**
 * A crown too small to tap is a crown that costs more than it saves.
 *
 * Forty-four points is the usual floor for a touch target and a phone shows
 * one of these frames about 360 points wide, so anything under roughly an
 * eighth of the frame's width is a fiddle. Reported rather than dropped --
 * the model found it, and hiding it here would flatter the idea.
 */
const THUMB_FRACTION = 1 / 12;

const QUERY = `
  SELECT id, county, frame, shapes, parcel, image_key
    FROM corpus
   WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL
   ORDER BY at DESC
   LIMIT 200
`;

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

/**
 * A crown's polygon, from the dumped frame's pixels into the 512 grid
 * everything is drawn and measured on.
 *
 * The frames are written at whatever DUMP_SIZE the run used and the renderer
 * works at GRID. One scale factor, applied once, here -- rather than in the
 * Python, which does not know what the renderer wants, or in the renderer,
 * which would then need to know where the numbers came from.
 */
const toGrid = (polygon, framePx) => polygon.map(([x, y]) => [
  (x * GRID) / framePx, (y * GRID) / framePx,
]);

/** How much of a crown lands on ground the tracer called lawn. */
function overlap(ring, truth, within) {
  const mask = new Uint8Array(GRID * GRID);
  rasterizePolygon([ring], mask, GRID);
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
  if (!existsSync(CROWNS)) {
    console.log(`No ${CROWNS}/ directory. Run tools/tree-crowns.py first.`);
    process.exitCode = 1;
    return;
  }

  const decoders = {
    png: await import('pngjs'),
    jpeg: await import('jpeg-js'),
  };

  const rows = query(QUERY);
  console.log(`${rows.length} approved maps.\n`);

  const dir = mkdtempSync(join(tmpdir(), 'crowns-'));
  const entries = [];
  let put = 0;

  try {
    for (const row of rows) {
      const file = join(CROWNS, `${row.id}.json`);
      if (!existsSync(file)) continue;
      const found = parse(readFileSync(file, 'utf8'));
      const frame = parse(row.frame);
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
      let crownPx = 0;
      let insidePx = 0;
      let thumbable = 0;
      const minSide = GRID * THUMB_FRACTION;

      for (const crown of found.crowns || []) {
        const ring = toGrid(crown.polygon, found.framePx || GRID);
        rings.push(ring);
        const o = overlap(ring, truth, within);
        crownPx += o.area;
        onLawnPx += o.onLawn;
        insidePx += o.inside;

        const xs = ring.map((p) => p[0]);
        const ys = ring.map((p) => p[1]);
        const side = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        if (side >= minSide) thumbable++;
      }

      const pixels = drawPrediction({
        photo, truth, within, inferred, rings, grid: GRID,
      });
      const png = new decoders.png.PNG({ width: GRID, height: GRID });
      png.data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length);
      const out = join(dir, `${entries.length}.png`);
      writeFileSync(out, decoders.png.PNG.sync.write(png));

      const key = `crowns/${entries.length}.png`;
      try {
        execFileSync('npx', [
          'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
          '--file', out, '--content-type', 'image/png', '--remote',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        put++;
      } catch (e) {
        console.log(`  could not upload ${key}: `
          + `${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 80)}`);
        continue;
      }

      entries.push({
        key,
        county: row.county || null,
        crowns: rings.length,
        thumbable,
        crownSqFt: Math.round(sqft(crownPx)),
        /*
         * THE NUMBER THE WHOLE RUN IS FOR. Of all the crown area found, how
         * much sits on ground the tracer called lawn -- the toggles that
         * should start ON. A clean split between lawns is the idea working; a
         * middling number on every lawn is the idea failing.
         */
        onLawnPct: crownPx ? Number(((100 * onLawnPx) / crownPx).toFixed(1)) : null,
        insidePct: crownPx ? Number(((100 * insidePx) / crownPx).toFixed(1)) : null,
        canopySqFt: Math.round((found.canopySqM || 0) / SQM_PER_SQFT),
        readAtPx: found.readAt?.px ?? null,
        mpp: Number(mpp.toFixed(3)),
      });

      console.log(
        `  ${String(row.county || 'traced by hand').padEnd(22).slice(0, 22)} `
        + `${String(rings.length).padStart(3)} crowns  `
        + `${String(thumbable).padStart(3)} big enough to tap  `
        + `${String(entries[entries.length - 1].onLawnPct ?? '--').padStart(5)}% on traced lawn`
      );
    }

    if (!entries.length) {
      console.log('\nNothing could be drawn.');
      process.exitCode = 1;
      return;
    }

    /* Most crowns first: the busiest lawns are where a toggle list either
       saves real time or becomes a wall of switches. */
    entries.sort((a, b) => b.crowns - a.crowns);

    const indexFile = join(dir, 'index.json');
    writeFileSync(indexFile, `${JSON.stringify({
      drawnAt: new Date().toISOString(),
      config: 'tree crowns',
      features: process.env.MODEL || 'restor/tcd-segformer',
      lawns: entries.length,
      note: 'Each outline is one tree crown the model found, drawn over the lawn '
        + 'somebody traced by hand (green). The question is whether these would '
        + 'work as one-tap toggles, not how accurate they are.',
      entries,
    }, null, 1)}\n`);

    execFileSync('npx', [
      'wrangler', 'r2', 'object', 'put', `${BUCKET}/crowns/index.json`,
      '--file', indexFile, '--content-type', 'application/json', '--remote',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    /* ------------------------------------------------- the end of the log */
    const counts = entries.map((e) => e.crowns);
    const taps = entries.map((e) => e.thumbable);
    const shares = entries.map((e) => e.onLawnPct).filter((v) => v !== null);
    const mid = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

    console.log(`\n${'='.repeat(64)}\n`);
    console.log(`Drew ${put} lawns. Open /predictions.html?set=crowns to look at them.`);
    console.log(`\nCrowns per lawn: ${Math.min(...counts)} to ${Math.max(...counts)}, `
      + `middle ${mid(counts)}.`);
    console.log(`Big enough to tap: middle ${mid(taps)} of ${mid(counts)}.`);
    if (shares.length) {
      console.log(`\nCrown area sitting on the traced lawn: ${Math.min(...shares).toFixed(0)}% `
        + `to ${Math.max(...shares).toFixed(0)}%, middle ${mid(shares).toFixed(0)}%.`);
      console.log('\nTHAT SPREAD IS THE RESULT, not the average. A crown inside the');
      console.log('traced lawn is a tree somebody decided has grass under it -- a');
      console.log('toggle that should start ON -- and one outside is a no. If lawns');
      console.log('sit at the ends of that range the two groups separate and the');
      console.log('toggles have something to be right about. If every lawn sits in');
      console.log('the middle, the crowns do not line up with anybody\'s judgement.');
    }
    console.log('\nThe pictures decide it. A model that finds the canopy as one');
    console.log('enormous blob is accurate and useless; nine clean crowns out of');
    console.log('eleven is less accurate and exactly what a toggle list needs.');
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
