/**
 * SAM on the corpus, the way the app now asks it -- and, on the big lots, the
 * way it used to -- scored against the lawns somebody traced by hand.
 *
 * WHAT THIS ANSWERS. On 2026-09-23 the live detection stopped sending SAM
 * the frame on the phone's screen (the parcel in 1280 px, which SAM reads at
 * 1008, so 17 cm a pixel on a 172 m lot) and started photographing a big
 * lot in pieces at 10 cm a pixel or finer, one prediction per piece. Whether
 * that made the outlines better is a number, and this is where it comes from.
 *
 * TWO ANSWERS PER BIG LOT, ONE RUN, SAME DAY. Every lawn is asked the way the
 * app asks now (detectionPlan). A lawn the plan cuts into pieces is ALSO
 * asked the old way -- one picture of the display frame -- so the two masks
 * differ in nothing but the cut: same model, same prompt, same threshold,
 * same minute. The outline already stored on the row (`detected_shapes`) is
 * reported beside them for context, but it is not the control: it was drawn
 * on some earlier day, by whichever method the tracer pressed, and then
 * clipped and traced.
 *
 * SCORED WHERE THE LIVE PATH SCORES. Truth, property line and both masks are
 * rasterised at the picture size over the STITCHED frame (the plan's frame,
 * which for a one-piece lot is the display frame), and error is counted
 * inside the property line exactly as train-detector.js counts it, so a
 * figure here reads against the table in docs/DETECTOR-FINDINGS.md.
 *
 * THIS COSTS MONEY: one prediction per piece, plus one per tiled lawn for
 * the control. About forty on this corpus. The pictures go to the same run
 * folders as every other detector, so /predictions.html shows them.
 *
 *   REPLICATE_TOKEN=... MAPBOX_SERVER_TOKEN=... CLOUDFLARE_API_TOKEN=... \
 *     node tools/score-sam.js
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { query } from './corpus-db.js';
import {
  compare, maskOf, geometries, inferredGeometries, renderPx,
} from './train-detector.js';
import { drawPrediction, tracePrediction, traceMask, mistakeCounts } from './render-prediction.js';
import { runSlug, runKeys, runRow, publishRunList } from './run-folder.js';
import { stitchMasks } from '../public/lib/tiles.js';
import { binarize } from '../public/lib/mask.js';
import { metresPerPixel, frameFor, geometryBounds } from '../public/lib/mercator.js';
import { lawnSetClause, lawnSetDescription } from './lawn-set.js';
import {
  detectionPlan, detectionImageUrl, imageryPrompt, groundAcross,
} from '../worker/src/imagery.js';
import {
  MODELS, samVersion, samPrompt, samThreshold, SAM_INPUT_PX, samMaxTilesAcross,
} from '../worker/src/sam.js';

const SQM_PER_SQFT = 0.09290304;
const BUCKET = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
const RUN_ABOUT = String(process.env.RUN_ABOUT || '').trim().slice(0, 600);
const LIMIT = Math.max(0, parseInt(process.env.LIMIT || '0', 10) || 0);
const mapbox = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;
const auth = { Authorization: `Bearer ${process.env.REPLICATE_TOKEN}` };

const QUERY = `
  SELECT id, county, frame, image_frame, shapes, parcel, detected_shapes, model, mode
    FROM corpus
   WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL${lawnSetClause()}
   ORDER BY at DESC
   LIMIT 200
`;
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

/* ------------------------------------------------------------ Replicate */

/** One prediction, waited out. Returns the mask PNG's bytes or throws. */
async function predict(version, input) {
  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({ version, input }),
  });
  let body;
  try { body = JSON.parse(await res.text()); } catch { body = {}; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.detail || body.error || 'no message'}`);

  let final = body;
  if (final.status && !['succeeded', 'failed', 'canceled'].includes(final.status) && final.urls?.get) {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      final = await (await fetch(final.urls.get, { headers: auth })).json();
      if (['succeeded', 'failed', 'canceled'].includes(final.status)) break;
    }
  }
  if (final.status !== 'succeeded') {
    throw new Error(`${final.status}: ${JSON.stringify(final.error || final.detail).slice(0, 120)}`);
  }
  const out = final.output;
  const url = Array.isArray(out) ? out[0] : typeof out === 'string' ? out : out?.mask || out?.image;
  if (typeof url !== 'string') throw new Error(`unexpected output ${JSON.stringify(out).slice(0, 80)}`);
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

/**
 * An image's pixels as the {width, height, data} the mask tools read.
 *
 * BY SIGNATURE, NOT BY ASSUMPTION. Mapbox's static satellite picture is a
 * JPEG; SAM's mask is a PNG. The first version of this read everything as
 * PNG, and the first run paid for every prediction and then threw every lawn
 * away on "unrecognised content at end of stream".
 */
const decodeImage = (decoders, bytes) => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const png = decoders.png.PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const img = decoders.jpeg.decode(bytes, { useTArray: true });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error(`not an image (starts ${bytes[0]},${bytes[1]})`);
};

/**
 * Ask SAM for every piece of a plan and paste the answers together, exactly
 * as the browser does. Returns the stitched RGBA image and the pieces used.
 */
async function askPlan(plan, version, pass, decoders) {
  const pieces = [];
  for (const tile of plan.tiles) {
    const url = detectionImageUrl('mapbox', tile.frame, mapbox, process.env);
    const bytes = await predict(version, MODELS.sam3.input(url, pass));
    pieces.push({ col: tile.col, row: tile.row, image: decodeImage(decoders, bytes) });
  }
  return pieces.length === 1 ? pieces[0].image : stitchMasks(pieces, plan.cols, plan.rows);
}

/**
 * The photograph SAM was shown, for the rendering: the same tiles, fetched
 * from Mapbox and pasted on the same grid. The banked photograph will not do
 * -- it was captured on a different frame (H20), and a mask drawn over a
 * picture of a different rectangle is the misalignment the rendering exists
 * to catch.
 */
async function photoOf(plan, decoders) {
  const pieces = [];
  for (const tile of plan.tiles) {
    const url = detectionImageUrl('mapbox', tile.frame, mapbox, process.env);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Mapbox HTTP ${res.status}`);
    pieces.push({
      col: tile.col, row: tile.row,
      image: decodeImage(decoders, Buffer.from(await res.arrayBuffer())),
    });
  }
  return pieces.length === 1 ? pieces[0].image : stitchMasks(pieces, plan.cols, plan.rows);
}

/* ------------------------------------------------------------- rasters */

/** Nearest-neighbour resample of a binary mask to a grid. */
function toGrid(bin, w, h, px, py = px) {
  const out = new Uint8Array(px * py);
  for (let y = 0; y < py; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / py));
    for (let x = 0; x < px; x++) {
      out[y * px + x] = bin[sy * w + Math.min(w - 1, Math.floor((x * w) / px))];
    }
  }
  return out;
}

/** Box-average an RGBA picture to a grid, RGBA out. */
function resizeRgba(img, px, py = px) {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(px * py * 4);
  for (let y = 0; y < py; y++) {
    const y0 = Math.floor((y * h) / py), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / py));
    for (let x = 0; x < px; x++) {
      const x0 = Math.floor((x * w) / px), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / px));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++) {
        for (let xx = x0; xx < x1 && xx < w; xx++) {
          const i = (yy * w + xx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (y * px + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- run */

async function main() {
  if (!mapbox || !process.env.REPLICATE_TOKEN) {
    console.log('Needs MAPBOX_SERVER_TOKEN (or MAPBOX_TOKEN) and REPLICATE_TOKEN.');
    process.exitCode = 1;
    return;
  }
  const decoders = {
    png: await import('pngjs'),
    jpeg: (await import('jpeg-js')).default,
  };
  const { PNG } = decoders.png;

  const env = process.env;
  const modelId = 'sam3';
  const version = await samVersion(env, modelId);
  const pass = {
    prompt: samPrompt(modelId, imageryPrompt('mapbox', env), env),
    threshold: samThreshold(env, modelId),
  };
  const maxAcross = samMaxTilesAcross(env);

  let rows = query(QUERY);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`${rows.length} approved maps (${lawnSetDescription()}). Asking ${MODELS.sam3.slug} for "${pass.prompt}" `
    + `at ${pass.threshold}, pieces up to ${maxAcross} across.\n`);

  const PX = renderPx();
  const dir = mkdtempSync(join(tmpdir(), 'score-sam-'));
  const startedAt = new Date();
  const slug = runSlug({ at: startedAt, models: [MODELS.sam3.slug], suffix: 'scored' });
  const keys = runKeys(slug);
  const entries = [];
  let predictions = 0;
  let spent = 0;

  let PY = PX;
  const write = (pix, name) => {
    const png = new PNG({ width: PX, height: PY });
    png.data = Buffer.from(pix.buffer, pix.byteOffset, pix.length);
    const out = join(dir, name);
    writeFileSync(out, PNG.sync.write(png));
    return out;
  };

  try {
    for (const row of rows) {
      /* THE DISPLAY FRAME, not the banked one: the live path receives what
         the phone is showing, and that is what is being scored. */
      /* As the app frames it now: the parcel's box plus 10 m, cropped both
         ways. A row without a parcel keeps the frame the phone showed. */
      const parcelForFrame = parse(row.parcel);
      const bboxForFrame = parcelForFrame ? geometryBounds(parcelForFrame) : null;
      const display = bboxForFrame ? frameFor(bboxForFrame, 640, { marginM: 10 }) : parse(row.frame);
      const truthGeoms = geometries(parse(row.shapes));
      if (!display || !truthGeoms.length) continue;

      const plan = detectionPlan('mapbox', display, { inputPx: SAM_INPUT_PX, maxAcross });
      const frame = plan.frame;
      const across = groundAcross(display);
      const label = `${String(row.county || 'traced by hand').padEnd(22).slice(0, 22)} ${String(Math.round(across)).padStart(4)} m`;

      let stitched, single = null, photo;
      try {
        /* THE PHOTOGRAPH FIRST, before anything is paid for: if the picture
           cannot be had or read, the lawn is skipped for free. */
        photo = await photoOf(plan, decoders);
        stitched = await askPlan(plan, version, pass, decoders);
        predictions += plan.tiles.length;
        if (plan.tiles.length > 1) {
          /* THE CONTROL: the same lawn the old way, one picture of the
             display frame, which is a plan of one. */
          single = await askPlan(
            { frame: display, cols: 1, rows: 1, tiles: [{ frame: display, col: 0, row: 0 }] },
            version, pass, decoders,
          );
          predictions += 1;
        }
      } catch (e) {
        console.log(`  ${label}  skipped -- ${String(e.message || e).slice(0, 90)}`);
        continue;
      }

      /* Everything on the stitched frame at the picture size, which keeps
         the frame's shape. */
      PY = Math.max(1, Math.round((PX * (frame.height || frame.size)) / frame.size));
      const truth = maskOf(truthGeoms, frame, PX, PY);
      const inferredGeoms = inferredGeometries(parse(row.shapes));
      const inferred = inferredGeoms.length ? maskOf(inferredGeoms, frame, PX, PY) : null;
      const parcelGeom = parse(row.parcel);
      const within = parcelGeom ? maskOf([parcelGeom], frame, PX, PY) : null;
      const mpp = metresPerPixel(frame, PX);
      const sqft = (px) => (px * mpp * mpp) / SQM_PER_SQFT;

      let truthPx = 0;
      for (let i = 0; i < truth.length; i++) if (truth[i] && (!within || within[i])) truthPx++;
      if (!truthPx) continue;

      /* Find-grass polarity, as the app reads it: literal, with the
         mostly-on safety flip. */
      /*
       * AND WHETHER THE SAFETY FLIP FIRED. binarize inverts a mask that is
       * more than 90% on, on the theory that nothing we segment covers that
       * much of the frame. A treeless lot cut into pieces at 5 cm can come
       * back almost all grass, and a flip there would turn a right answer
       * into a wrong one -- so the on-fraction and the flip are recorded for
       * both masks, and a lawn whose "worse in pieces" is really "flipped in
       * pieces" can be told apart from one where SAM lost the plot.
       */
      const readMask = (img) => {
        const literal = binarize(img, 128, { autoPolarity: false });
        let on = 0;
        for (let i = 0; i < literal.length; i++) on += literal[i];
        const onFrac = on / literal.length;
        const flipped = onFrac > 0.9;
        const used = binarize(img, 128, { autoPolarity: true });
        return { mask: toGrid(used, img.width, img.height, PX, PY), onFrac, flipped };
      };
      const got = readMask(stitched);
      const predicted = got.mask;
      const mine = compare(predicted, truth, within);
      const one = single ? readMask(single) : null;
      const control = one ? compare(one.mask, truth, within) : null;
      const stored = row.detected_shapes
        ? compare(maskOf(geometries(parse(row.detected_shapes)), frame, PX, PY), truth, within)
        : null;

      /* The outline the drawing tools would get, and what it costs to fix. */
      const trace = tracePrediction({ predicted, within, grid: PX, gridH: PY, mpp });
      const traced = traceMask({ shapes: trace.shapes, within, grid: PX, gridH: PY });
      const counts = mistakeCounts({ truth, predicted: traced, within, inferred });

      const n = entries.length;
      const pix = resizeRgba(photo, PX, PY);
      try {
        execFileSync('npx', [
          'wrangler', 'r2', 'object', 'put', `${BUCKET}/${keys.shapes(n)}`,
          '--file', write(drawPrediction({ photo: pix, truth, within, inferred, rings: trace.rings, grid: PX, gridH: PY }), `${n}.png`),
          '--content-type', 'image/png', '--remote',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        execFileSync('npx', [
          'wrangler', 'r2', 'object', 'put', `${BUCKET}/${keys.mask(n)}`,
          '--file', write(drawPrediction({ photo: pix, truth, within, inferred, mask: predicted, grid: PX, gridH: PY }), `${n}-mask.png`),
          '--content-type', 'image/png', '--remote',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        console.log(`  ${label}  could not upload: ${String(e.message || e).replace(/\s+/g, ' ').slice(0, 80)}`);
        continue;
      }

      entries.push({
        key: keys.shapes(n),
        maskKey: keys.mask(n),
        county: row.county || null,
        squareFeet: Math.round(sqft(truthPx)),
        /* The headline: SAM as the app asks now, on the raw mask. */
        errorPct: Number(mine.errorPct.toFixed(1)),
        /* THE CONTROL, in the slot the page labels "SAM": the same lawn the
           old way. Null on a one-piece lot, where the two would be the same
           prediction. */
        samErrorPct: control ? Number(control.errorPct.toFixed(1)) : null,
        /* The outline already on the row, for context only -- another day,
           whichever method was pressed, clipped and traced. */
        storedErrorPct: stored ? Number(stored.errorPct.toFixed(1)) : null,
        storedBy: row.model || null,
        foundPct: counts.foundPct === null ? null : Number(counts.foundPct.toFixed(1)),
        overPct: counts.overPct === null ? null : Number(counts.overPct.toFixed(1)),
        missedInferredPct: counts.missedInferredPct === null ? null : Number(counts.missedInferredPct.toFixed(1)),
        inferredPct: 0,
        mpp: Number(mpp.toFixed(3)),
        renderPx: PX,
        renderPy: PY,
        pieces: trace.pieces,
        vertices: trace.vertices,
        droppedPieces: trace.droppedPieces,
        droppedSqFt: Math.round(sqft(trace.droppedPx)),
        metresAcross: Math.round(across),
        tiles: plan.tiles.length,
        groundCm: Math.round(plan.groundM * 1000) / 10,
        capped: Boolean(plan.capped),
        /* Which way the mask was wrong, and whether it was flipped. */
        extraPct: mine.truth ? Number(((100 * mine.extra) / mine.truth).toFixed(1)) : null,
        missedPct: mine.truth ? Number(((100 * mine.missed) / mine.truth).toFixed(1)) : null,
        onPct: Number((100 * got.onFrac).toFixed(1)),
        flipped: got.flipped,
        controlExtraPct: control && control.truth ? Number(((100 * control.extra) / control.truth).toFixed(1)) : null,
        controlMissedPct: control && control.truth ? Number(((100 * control.missed) / control.truth).toFixed(1)) : null,
        controlOnPct: one ? Number((100 * one.onFrac).toFixed(1)) : null,
        controlFlipped: one ? one.flipped : null,
      });
      spent += plan.tiles.length + (single ? 1 : 0);

      const e = entries[n];
      const how = (err, extra, missed, on, flipped) =>
        `${String(err).padStart(5)}% out (${extra} over, ${missed} missed; mask ${on}% on${flipped ? ', FLIPPED' : ''})`;
      console.log(`  ${label}  ${String(e.tiles).padStart(2)} piece${e.tiles === 1 ? ' ' : 's'} `
        + `${String(e.groundCm).padStart(5)} cm/px  now ${how(e.errorPct, e.extraPct, e.missedPct, e.onPct, e.flipped)}`
        + (control ? `  one picture ${how(e.samErrorPct, e.controlExtraPct, e.controlMissedPct, e.controlOnPct, e.controlFlipped)}` : '')
        + (stored ? `  stored outline ${String(e.storedErrorPct).padStart(5)}%` : ''));
    }

    if (!entries.length) {
      console.log('\nNothing could be scored.');
      process.exitCode = 1;
      return;
    }

    entries.sort((a, b) => b.errorPct - a.errorPct);
    const mid = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const all = entries.map((e) => e.errorPct);
    const tiled = entries.filter((e) => e.samErrorPct !== null);
    const settings = {
      model: MODELS.sam3.slug,
      prompt: pass.prompt,
      threshold: pass.threshold,
      inputPx: SAM_INPUT_PX,
      maxTilesAcross: maxAcross,
      renderPx: PX,
      lawns: entries.length,
      tiledLawns: tiled.length,
      predictions,
      medianErrorPct: Number(mid(all).toFixed(1)),
    };

    const indexFile = join(dir, 'index.json');
    writeFileSync(indexFile, `${JSON.stringify({
      drawnAt: new Date().toISOString(),
      slug,
      config: 'SAM, as the app asks it',
      features: MODELS.sam3.slug,
      about: RUN_ABOUT,
      settings,
      lawns: entries.length,
      note: 'SAM on each lawn as the live path asks it now: one picture under about '
        + '100 m across, pieces at 10 cm a pixel past that. "% out" is the raw mask '
        + 'against the hand trace, inside the property line. The "SAM" pill on a '
        + 'lawn that was cut into pieces is the CONTROL: the same lawn, same '
        + 'prompt, same minute, as one picture of the display frame -- the old way.',
      entries,
    }, null, 1)}\n`);
    execFileSync('npx', [
      'wrangler', 'r2', 'object', 'put', `${BUCKET}/${keys.index}`,
      '--file', indexFile, '--content-type', 'application/json', '--remote',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const list = publishRunList(BUCKET, dir, runRow({
      slug, at: startedAt,
      title: `SAM scored · ${entries.length} lawns`,
      about: RUN_ABOUT, settings, lawns: entries.length,
      headline: settings.medianErrorPct,
    }));

    /* ------------------------------------------------- the end of the log */
    console.log(`\n${'='.repeat(64)}\n`);
    console.log(`Scored ${entries.length} lawns with ${predictions} predictions (${spent} paid for).`);
    console.log(`Open /predictions.html and pick this run:\n  ${slug}`);
    console.log(`The page now lists ${list.runs} run${list.runs === 1 ? '' : 's'}.`);
    console.log(`\nSAM as the app asks it now, raw mask inside the property line:`);
    console.log(`  median ${mid(all).toFixed(1)}% out over ${entries.length} lawns `
      + `(${Math.min(...all).toFixed(1)} to ${Math.max(...all).toFixed(1)})`);

    if (tiled.length) {
      const now = tiled.map((e) => e.errorPct);
      const was = tiled.map((e) => e.samErrorPct);
      const better = tiled.filter((e) => e.errorPct < e.samErrorPct - 0.05).length;
      const worse = tiled.filter((e) => e.errorPct > e.samErrorPct + 0.05).length;
      console.log(`\nTHE ${tiled.length} LAWNS THAT WERE CUT INTO PIECES, against the same lawns as one picture:`);
      console.log(`  in pieces   median ${mid(now).toFixed(1)}% out`);
      console.log(`  one picture median ${mid(was).toFixed(1)}% out`);
      console.log(`  better on ${better}, worse on ${worse}, within 0.05 on ${tiled.length - better - worse}.`);
      for (const e of tiled.slice().sort((a, b) => a.metresAcross - b.metresAcross)) {
        console.log(`    ${String(e.metresAcross).padStart(4)} m  ${String(e.tiles).padStart(2)} pieces at ${e.groundCm} cm  `
          + `${String(e.samErrorPct).padStart(5)}% -> ${String(e.errorPct).padStart(5)}%`
          + `   over ${e.controlExtraPct} -> ${e.extraPct}, missed ${e.controlMissedPct} -> ${e.missedPct}`
          + `   mask on ${e.controlOnPct}% -> ${e.onPct}%`
          + (e.controlFlipped || e.flipped ? `   flipped: ${e.controlFlipped ? 'one picture' : ''}${e.controlFlipped && e.flipped ? ' and ' : ''}${e.flipped ? 'pieces' : ''}` : '')
          + (e.capped ? '  (capped)' : ''));
      }
      const flips = tiled.filter((e) => e.flipped || e.controlFlipped).length;
      console.log('\nSame model, same prompt, same minute: only the cut differs. This is');
      console.log('the number that says whether 10 cm a pixel helped SAM.');
      console.log(flips
        ? `\n${flips} of these had the >90%-on polarity flip fire on at least one mask, so`
          + '\nread those rows as "flipped", not as SAM being wrong.'
        : '\nThe polarity flip fired on none of them: the difference is SAM\'s answer.');
    } else {
      console.log('\nNo lawn was big enough to be cut into pieces, so there is no');
      console.log('one-picture control in this run.');
    }

    const withStored = entries.filter((e) => e.storedErrorPct !== null);
    if (withStored.length) {
      console.log(`\nFor context, the outlines already stored on ${withStored.length} rows `
        + `(another day, whichever method was pressed, clipped and traced):`);
      console.log(`  median ${mid(withStored.map((e) => e.storedErrorPct)).toFixed(1)}% out.`);
    }
    console.log(`\nWrite this run into docs/DETECTOR-FINDINGS.md.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.log('Scoring stopped:', e.message);
  process.exitCode = 1;
});
