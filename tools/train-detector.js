/**
 * Train a lawn detector on the approved maps, and find out honestly whether it
 * is any better than the one we pay for.
 *
 * THE MEASUREMENT IS THE HARD PART, NOT THE TRAINING. With twenty lawns, any
 * model can be trained; the question is whether the number that comes out
 * means anything. Hold five back for testing and the verdict rests on five
 * gardens -- and the scorer has already shown how unstable that is, with two
 * four-map buckets reading 17.9% and 37.4%. Move one lawn and the conclusion
 * flips.
 *
 * So: LEAVE ONE OUT. Train once per lawn, each time on every lawn but one, and
 * test on the one left out. Twenty independent results instead of five, and
 * every lawn used for both jobs without ever being tested on itself. Only
 * affordable because the head is tiny -- on a full fine-tune this would be
 * absurd, and at this size it is the right method rather than a compromise.
 *
 * AND IT IS SCORED AGAINST THE DETECTOR ON THE SAME LAWNS. "18% out" means
 * nothing on its own; the corpus stores what SAM drew for each of these rows,
 * so both are measured on the same pixels with the same rule, and the report
 * is the difference. A new model that cannot beat the old one on the lawns the
 * old one has already seen is not a step forward however good its own number
 * looks.
 *
 *   node tools/train-detector.js
 *
 * or, the way anybody actually runs it, workflow "12. Train a lawn detector".
 */

import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { query } from './corpus-db.js';
import { imageFeatures, featureStats, standardise, FEATURE_COUNT } from './features.js';
import { train, predict, balanceWeights } from './learner.js';
import {
  loadBackbone, tiledFeatures, sampleAt, projection, project,
} from './backbone.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { lngLatToFramePx, metresPerPixel } from '../public/lib/mercator.js';

const SQM_PER_SQFT = 0.09290304;

/*
 * HOW MANY NUMBERS OF THE BACKBONE'S 384 EACH PIXEL CARRIES.
 *
 * All of them, twice over, would be 768 floats a pixel -- three quarters of a
 * gigabyte for one lawn at 512 square, before anything is trained. A random
 * projection squeezes each patch down to this many while keeping the distances
 * between patches roughly intact, which is all the head reads them for.
 *
 * 32 is a guess that can be checked later rather than a measured optimum, and
 * it is written down as a guess for that reason.
 */
const PROJ_DIMS = 32;

/*
 * TWO SCALES, because tiling costs context and the context is the point.
 *
 * FINE is the frame in sixteen tiles: 64x64 patches, about 0.83 m each, which
 * is what says where an edge runs. COARSE is one pass over the whole frame:
 * 16x16 patches at 3.3 m, each of which has seen the entire property -- which
 * is what says whether this green is a lawn or a forest floor. Neither answers
 * the other's question.
 */
const FINE_TILES = 4;
const COARSE_TILES = 1;

/** Cheap colour and texture, then the backbone at two scales. */
const TOTAL_FEATURES = FEATURE_COUNT + 2 * PROJ_DIMS;

/*
 * EVERYTHING HAPPENS AT ONE GRID, and that is what makes the comparison fair.
 * The truth, the prediction and SAM's own outline are all rasterised here, so
 * the three are counted on identical pixels. 512 keeps twenty lawns inside a
 * few hundred megabytes and is finer than the 0.35 m the tracer simplifies to.
 */
const GRID = 512;

const QUERY = `
  SELECT id, county, tree_line, frame, shapes, detected_shapes, parcel,
         image_key, image_provider, mode, model
    FROM corpus
   WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL
   ORDER BY at DESC
   LIMIT 200
`;

const parse = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

const geometries = (stored) => {
  const list = Array.isArray(stored) ? stored : stored?.features || [];
  return list.map((g) => (g?.geometry ? g.geometry : g)).filter(Boolean);
};

/**
 * Pull one stored photograph out of R2 and decode it to RGBA.
 *
 * THE KEY ENDS .png AND THE BYTES MIGHT NOT BE. storeImage names every object
 * .png whatever the source actually returned, so trusting the extension
 * decodes a JPEG with a PNG reader and throws on a file that is perfectly
 * fine. The magic number is the only honest answer.
 */
function fetchImage(bucket, key, dir, decoders) {
  const file = join(dir, 'image.bin');
  try {
    execFileSync('npx', [
      'wrangler', 'r2', 'object', 'get', `${bucket}/${key}`,
      '--file', file, '--remote',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, reason: `could not fetch (${String(e.message || e).slice(0, 80)})` };
  }
  if (!existsSync(file)) return { ok: false, reason: 'nothing was written' };

  const bytes = readFileSync(file);
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const img = decoders.png.PNG.sync.read(bytes);
      return { ok: true, data: img.data, width: img.width, height: img.height, channels: 4 };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const img = decoders.jpeg.decode(bytes, { useTArray: true });
      return { ok: true, data: img.data, width: img.width, height: img.height, channels: 4 };
    }
    return { ok: false, reason: `not an image (starts ${bytes[0]},${bytes[1]})` };
  } catch (e) {
    return { ok: false, reason: `could not decode (${String(e.message || e).slice(0, 60)})` };
  }
}

/** Box-average down to GRID, which is both a resize and a mild denoise. */
function resize(src, w, h, channels, size) {
  const out = new Uint8Array(size * size * 4);
  const sx = w / size;
  const sy = h / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++) {
        for (let xx = x0; xx < x1 && xx < w; xx++) {
          const i = (yy * w + xx) * channels;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

/** Geometries -> a filled mask on the GRID, using the row's own frame. */
function maskOf(geoms, frame, size) {
  const project = (ll) => lngLatToFramePx(frame, ll, size, size);
  const out = new Uint8Array(size * size);
  for (const g of geoms) {
    if (g?.type !== 'Polygon' || !Array.isArray(g.coordinates)) continue;
    const m = rasterizePolygon(g.coordinates, size, size, project);
    for (let i = 0; i < m.length; i++) if (m[i]) out[i] = 1;
  }
  return out;
}

/**
 * How wrong one mask is against another, counted only where it is allowed to
 * be judged.
 *
 * WITHIN THE PROPERTY LINE ONLY, because that is what the app measures and
 * what the model is asked for. Counting a model's opinion of the neighbour's
 * garden against it would be charging it for an answer nobody wanted, and
 * SAM's outline is already clipped to the line before it is stored -- so
 * scoring the two differently would make the comparison meaningless.
 */
function compare(got, want, within) {
  let wrong = 0, truth = 0, extra = 0, missed = 0;
  for (let i = 0; i < want.length; i++) {
    if (within && !within[i]) continue;
    if (want[i]) truth++;
    if (got[i] && !want[i]) { wrong++; extra++; }
    else if (!got[i] && want[i]) { wrong++; missed++; }
  }
  return { wrong, truth, extra, missed, errorPct: truth ? (100 * wrong) / truth : null };
}

/**
 * One pixel's full feature vector: colour and texture, then the backbone at
 * both scales.
 *
 * BUILT ON DEMAND RATHER THAN STORED. Seventy-five numbers for every pixel of
 * every lawn is three hundred megabytes before training starts, and almost all
 * of it is never read -- a fold samples a few thousand pixels per lawn. What
 * IS stored is the cheap layer, which is small, and the two patch grids, which
 * are tiny; this assembles a row from them when one is asked for.
 */
export function buildRow(lawn, p, out, offset, grid = GRID, cfg = null) {
  const { cheap, fine, coarse } = lawn;
  const useColour = cfg ? cfg.colour : true;
  const useEye = cfg ? cfg.backbone : true;
  const dims = cfg ? cfg.dims : PROJ_DIMS;

  let at = offset;
  if (useColour) {
    for (let f = 0; f < FEATURE_COUNT; f++) out[at + f] = cheap[p * FEATURE_COUNT + f];
    at += FEATURE_COUNT;
  }
  if (useEye && fine) {
    const px = p % grid;
    const py = (p / grid) | 0;
    sampleAt(fine, px, py, grid, out, at);
    at += dims;
    if (coarse) sampleAt(coarse, px, py, grid, out, at);
  }
  return out;
}

/** How wide a row is under one configuration, and whether it is runnable. */
export function rowWidth(cfg, hasEye) {
  const colour = cfg.colour ? FEATURE_COUNT : 0;
  const eye = cfg.backbone && hasEye ? 2 * cfg.dims : 0;
  return colour + eye;
}

/**
 * A patch grid with every patch squeezed to `dims` numbers.
 *
 * The projection is made from the width the model ACTUALLY returned rather
 * than from the 384 this one happens to have. Sizing it from an assumption
 * would read past the end of every patch the day a different backbone is
 * tried, and typed arrays answer that with zeroes rather than an error -- a
 * model trained on padding, scoring badly, blaming the data.
 */
const lenses = new Map();
export function lensFor(dim, dims) {
  const key = `${dim}:${dims}`;
  if (!lenses.has(key)) lenses.set(key, projection(dim, dims));
  return lenses.get(key);
}

function shrink(grid, dims) {
  const { data, gridW, gridH, dim } = grid;
  /*
   * ONE PROJECTION FOR EVERY LAWN AND BOTH SCALES, cached by the pair of
   * widths it maps between.
   *
   * This was a fresh matrix per call for one run, and the run is worth keeping
   * on record: the backbone rows read 63.9% alone and 100% at the wider
   * squeeze, against 40.5% for colour, and the obvious reading was that a
   * model trained on ground-level photographs cannot see a garden from above.
   *
   * It was nothing of the kind. A random projection is a change of coordinates,
   * and a different one per lawn puts every lawn's features in a private
   * language -- so a patch of grass in one garden and a patch of grass in the
   * next had no numerical relationship at all. The head was being handed noise
   * and asked to generalise across it, which is exactly what it failed to do.
   *
   * The comment warning against this was here and was deleted in the refactor
   * that made the width configurable. It is a test now instead.
   */
  const M = lensFor(dim, dims);
  const out = new Float32Array(gridW * gridH * dims);
  for (let p = 0; p < gridW * gridH; p++) {
    project(M, dim, dims, data, p * dim, out, p * dims);
  }
  return { data: out, gridW, gridH, dim: dims };
}

/**
 * ONE RUN, SEVERAL FEATURE SETS.
 *
 * Adding the backbone moved the score from 43.2% to 42.8%, which is no change,
 * and one number cannot say why. Colour and the backbone may be saying the
 * same thing; the backbone may be saying nothing useful about a photograph
 * taken straight down, which is not what it was trained on; the projection may
 * be throwing the signal away on its way to 32 numbers. Those want different
 * answers and they are indistinguishable from a single figure.
 *
 * Running the model over twenty lawns is three minutes; scoring a feature set
 * once the patches are in hand is seconds. So the patches are extracted once,
 * at full width, and every configuration below is scored against the same
 * lawns -- which also makes them comparable to each other, not just to SAM.
 */
const CONFIGS = [
  { name: 'colour and texture only', colour: true, backbone: false, dims: 0 },
  { name: 'the pretrained eye only', colour: false, backbone: true, dims: 32 },
  { name: 'both', colour: true, backbone: true, dims: 32 },
  { name: 'both, 96 numbers a patch', colour: true, backbone: true, dims: 96 },
];

/**
 * One fold: train on every lawn but `held`, then answer `held`.
 *
 * ITS OWN FUNCTION SO THAT THE EXCLUSION CAN BE TESTED. Everything about this
 * exercise rests on one line -- the one that skips the held-out lawn -- and
 * getting it wrong does not fail, it flatters. A fold that trains on the lawn
 * it is about to be marked on scores beautifully and means nothing, and there
 * is no way to tell from the outside which of those you are looking at. So the
 * count of lawns actually trained on comes back with the result, and a test
 * holds it to `lawns.length - 1`.
 */
export function runFold(lawns, held, opts = {}) {
  const { perLawn = 6000, grid = GRID } = opts;
  /*
   * SAMPLED, NOT EVERY PIXEL. Nineteen lawns is five million pixels and they
   * are enormously redundant -- neighbouring pixels of the same lawn are the
   * same fact. A few thousand per lawn carries the same information and keeps
   * a fold to a couple of seconds, which is what makes twenty folds possible.
   */
  const cfg = opts.cfg || { colour: true, backbone: true, dims: PROJ_DIMS };
  const width = opts.width || lawns[0].width || TOTAL_FEATURES;
  const picked = [];
  const ys = [];
  let seed = 12345 + held;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  let trainedOn = 0;
  for (let i = 0; i < lawns.length; i++) {
    if (i === held) continue;               // the whole point
    trainedOn++;
    const L = lawns[i];
    const n = grid * grid;
    for (let k = 0; k < perLawn; k++) {
      const p = Math.floor(rand() * n);
      if (L.within && !L.within[p]) continue;
      picked.push([L, p]);
      ys.push(L.truth[p]);
    }
  }

  const x = new Float32Array(picked.length * width);
  for (let i = 0; i < picked.length; i++) {
    buildRow(picked[i][0], picked[i][1], x, i * width, grid, cfg);
  }
  const y = Float32Array.from(ys);

  /*
   * The scaling is measured on the training lawns only. Standardising with the
   * held-out lawn included would let it influence its own normalisation, which
   * is testing on what you trained on by a quiet back door.
   */
  const stats = featureStats(x, width);
  standardise(x, stats, width);

  const model = train(x, y, balanceWeights(y), { seed: 99, inputs: width });

  /*
   * ANSWERED IN STRIPS, not all at once. A quarter of a million pixels times
   * seventy-five numbers is a large allocation to hold beside everything else
   * already in memory, and there is no reason to: the head reads each row once
   * and never looks back.
   */
  const test = lawns[held];
  const got = new Uint8Array(grid * grid);
  const ROWS = 32;
  const chunk = new Float32Array(ROWS * grid * width);
  for (let y0 = 0; y0 < grid; y0 += ROWS) {
    const rows = Math.min(ROWS, grid - y0);
    const count = rows * grid;
    for (let i = 0; i < count; i++) {
      buildRow(test, y0 * grid + i, chunk, i * width, grid, cfg);
    }
    const slice = chunk.subarray(0, count * width);
    standardise(slice, stats, width);
    const p = predict({ ...model, inputs: width }, slice);
    for (let i = 0; i < count; i++) got[y0 * grid + i] = p[i] > 0.5 ? 1 : 0;
  }

  /*
   * DID IT ANSWER THE SAME THING EVERYWHERE? A head that has collapsed to "no
   * lawn anywhere" scores exactly 100% wrong, which prints as a number and
   * reads as a bad model rather than as a broken one. Counted here so the
   * report can say which it was.
   */
  let lit = 0, judged = 0;
  for (let i = 0; i < got.length; i++) {
    if (test.within && !test.within[i]) continue;
    judged++;
    if (got[i]) lit++;
  }

  return {
    mine: compare(got, test.truth, test.within),
    theirs: test.detected ? compare(test.detected, test.truth, test.within) : null,
    trainedOn,
    collapsed: judged > 0 && (lit === 0 || lit === judged),
    predicted: got,
  };
}

async function main() {
  const bucket = process.env.CORPUS_BUCKET || 'lawn-mapper-corpus';
  let decoders;
  try {
    decoders = { png: await import('pngjs'), jpeg: (await import('jpeg-js')).default };
  } catch {
    console.log('The image decoders are missing. The workflow installs them with');
    console.log('  npm install pngjs jpeg-js --no-save');
    process.exitCode = 1;
    return;
  }

  let rows = [];
  try {
    rows = query(QUERY);
  } catch (err) {
    console.log('Could not read the corpus, so nothing was trained.');
    console.log(err.message);
    process.exitCode = 1;
    return;
  }

  console.log(`${rows.length} approved map${rows.length === 1 ? '' : 's'} with a stored photograph.\n`);

  /*
   * THE BACKBONE IS OPTIONAL, and the run says which it used.
   *
   * Without it this falls back to colour and texture alone -- which is a real
   * configuration, not a broken one: it is what the first run measured, and
   * having it reachable is how the two can be compared on the same lawns. What
   * must never happen is a silent fallback, because then a disappointing
   * number is unattributable. So the mode is printed, and it is printed again
   * at the end beside the result.
   */
  let eye = null;
  if (process.env.NO_BACKBONE !== 'true') {
    const t = Date.now();
    try {
      eye = await loadBackbone();
      console.log(`Pretrained eye loaded in ${((Date.now() - t) / 1000).toFixed(1)}s.`);
    } catch (e) {
      console.log('The pretrained eye would not load, so this is colour and');
      console.log(`texture only: ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  } else {
    console.log('NO_BACKBONE is set, so this is colour and texture only.');
  }
  const using = eye ? 'colour, texture and a pretrained eye' : 'colour and texture only';
  console.log('');

  /* The projection is made once, on first use, and reused for every lawn and
     both scales. Fitting a different one per lawn would put each lawn's
     features in its own coordinate system, and the head would be learning
     nineteen languages at once. */

  /* ---------------------------------------------------- gather the lawns */
  const dir = mkdtempSync(join(tmpdir(), 'lawn-'));
  const lawns = [];
  try {
    for (const row of rows) {
      const frame = parse(row.frame);
      const truthGeoms = geometries(parse(row.shapes));
      if (!frame || !truthGeoms.length) continue;

      const img = fetchImage(bucket, row.image_key, dir, decoders);
      if (!img.ok) {
        console.log(`  skipped ${row.id.slice(0, 28)} -- ${img.reason}`);
        continue;
      }

      const rgb = resize(img.data, img.width, img.height, img.channels, GRID);
      const truth = maskOf(truthGeoms, frame, GRID);
      const parcelGeom = parse(row.parcel);
      /*
       * No property line means the whole frame is fair game. Rare, and the
       * alternative -- dropping the row -- would throw away a hand-traced lawn
       * for the sake of tidiness.
       */
      const within = parcelGeom ? maskOf([parcelGeom], frame, GRID) : null;

      let truthPx = 0;
      for (let i = 0; i < truth.length; i++) if (truth[i] && (!within || within[i])) truthPx++;
      if (!truthPx) {
        console.log(`  skipped ${row.id.slice(0, 28)} -- no lawn inside the property line`);
        continue;
      }

      lawns.push({
        id: row.id,
        county: row.county,
        canopy: row.tree_line === null || row.tree_line === undefined ? null : Number(row.tree_line),
        /* Held raw: each fold standardises against its own training lawns. */
        cheap: imageFeatures(rgb, GRID, GRID),
        /*
         * Kept at the model's full width. Projecting here would fix the
         * squeeze at one size, and how much the squeeze costs is one of the
         * things the configurations below are there to find out.
         */
        fineFull: eye
          ? await tiledFeatures(eye, rgb, GRID, GRID, { tiles: FINE_TILES }) : null,
        coarseFull: eye
          ? await tiledFeatures(eye, rgb, GRID, GRID, { tiles: COARSE_TILES }) : null,
        truth,
        within,
        truthPx,
        mpp: metresPerPixel(frame, GRID),
        detected: row.detected_shapes
          ? maskOf(geometries(parse(row.detected_shapes)), frame, GRID) : null,
        run: `${row.model || 'no model'} / ${row.mode || 'no mode'}`,
      });
      process.stdout.write(`  read ${lawns.length}/${rows.length}\r`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${lawns.length} usable.\n`);

  /*
   * THREE IS THE FLOOR, and it is a floor about honesty rather than about
   * training. Leaving one out of two leaves one to learn from, and a "result"
   * from that would be a number with nothing behind it.
   */
  if (lawns.length < 3) {
    console.log('Not enough to leave one out. Approve a few more maps and run this again.');
    return;
  }

  /* ------------------------------------------------- leave one out */
  const median = (list) => {
    const t = list.slice().sort((a, b) => a - b);
    if (!t.length) return null;
    const m = t.length >> 1;
    return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2;
  };

  /*
   * SAM'S SCORE IS THE SAME WHATEVER WE DO, so it is worked out once and sits
   * beside every configuration as the line to beat.
   */
  const samScores = lawns
    .map((L) => (L.detected ? compare(L.detected, L.truth, L.within) : null));
  const samMed = median(samScores.filter(Boolean).map((s) => s.errorPct));
  const samCount = samScores.filter(Boolean).length;

  const runnable = CONFIGS.filter((c) => rowWidth(c, Boolean(eye)) > 0
    && (!c.backbone || eye));
  const table = [];

  for (const cfg of runnable) {
    /* Squeeze the patches to this configuration's width, once for all lawns. */
    if (cfg.backbone && eye) {
      for (const L of lawns) {
        L.fine = shrink(L.fineFull, cfg.dims);
        L.coarse = shrink(L.coarseFull, cfg.dims);
      }
    }
    const width = rowWidth(cfg, Boolean(eye));
    console.log(`Scoring "${cfg.name}" (${width} numbers a pixel)…`);

    const rows = [];
    for (let held = 0; held < lawns.length; held++) {
      const { mine, collapsed } = runFold(lawns, held, { cfg, width });
      rows.push({ lawn: lawns[held], mine, theirs: samScores[held], collapsed });
    }
    const med = median(rows.map((r) => r.mine.errorPct));
    const paired = rows.filter((r) => r.theirs);
    const wins = paired.filter((r) => r.mine.errorPct < r.theirs.errorPct).length;
    const collapsed = rows.filter((r) => r.collapsed).length;
    table.push({ cfg, med, wins, of: paired.length, rows, width, collapsed });
    console.log(`   ${med.toFixed(1)}% out on the middle lawn, better than SAM on ${wins} of ${paired.length}.\n`);
  }

  /* The per-lawn detail, for the best configuration only -- twenty lines per
     configuration would bury the comparison the run exists to make. */
  const best = table.slice().sort((a, b) => a.med - b.med)[0];
  if (best) {
    console.log(`Lawn by lawn, under "${best.cfg.name}":\n`);
    for (const r of best.rows) {
      const L = r.lawn;
      const sqft = (px) => (px * L.mpp * L.mpp) / SQM_PER_SQFT;
      console.log(
        `  ${String(L.county || 'traced by hand').padEnd(20).slice(0, 20)} `
        + `${Math.round(sqft(L.truthPx)).toLocaleString().padStart(8)} sq ft true   `
        + `trained ${r.mine.errorPct.toFixed(1).padStart(5)}% wrong   `
        + (r.theirs ? `SAM ${r.theirs.errorPct.toFixed(1).padStart(5)}% wrong` : 'SAM not stored')
      );
    }
  }

  /* ------------------------------------------------------------- verdict */
  console.log(`\n${'='.repeat(64)}`);
  console.log(`\nTrained on ${lawns.length - 1} lawns, tested on the one left out, ${lawns.length} times.`);
  console.log(`Features available: ${using}.\n`);

  console.log('  what it looked at                  wrong   beat SAM on');
  for (const t of table) {
    console.log(
      `  ${t.cfg.name.padEnd(32).slice(0, 32)} ${t.med.toFixed(1).padStart(5)}%   `
      + `${t.wins} of ${t.of}`
      + (t.collapsed
        ? `   (${t.collapsed} of ${t.rows.length} folds answered the same thing everywhere -- not a score)`
        : '')
    );
  }
  if (samMed !== null) {
    console.log(`\n  SAM, on the same ${samCount} lawns             ${samMed.toFixed(1)}%`);
  }

  console.log('');
  if (samMed === null || !best) {
    console.log('No stored SAM outline to compare against, so there is only the');
    console.log('trained number, which alone says little.');
  } else if (best.med < samMed && Math.abs(best.med - samMed) > 3 && best.wins > best.of * 0.6) {
    console.log(`WORTH BUILDING ON. "${best.cfg.name}" beats the detector it was`);
    console.log('trained to replace, on lawns it had never seen, by enough not to be');
    console.log('noise. The next move is more maps: every one makes the next model');
    console.log('better and this measurement steadier.');
  } else if (best.med < samMed) {
    console.log('AHEAD, BUT NOT BY ENOUGH TO TRUST. Better on the middle lawn, and');
    console.log('with this few lawns that can turn over on one more map. Worth');
    console.log('another run once there are ten more.');
  } else {
    console.log('STILL NOT BETTER. The comparison above is the useful part: if the');
    console.log('pretrained eye alone scores near the colour-only row, the two are');
    console.log('saying the same thing and a different backbone is the lever. If it');
    console.log('scores far worse alone, it is not reading this kind of picture well');
    console.log('-- these models are trained on photographs taken from the ground,');
    console.log('and a view straight down is not what they know. And if the wider');
    console.log('squeeze beats the narrow one, the projection was the bottleneck');
    console.log('rather than the features.');
  }

  console.log(`\n${'='.repeat(64)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log('Training stopped:', e.message);
    process.exitCode = 1;
  });
}

export { compare, resize, maskOf, GRID };
