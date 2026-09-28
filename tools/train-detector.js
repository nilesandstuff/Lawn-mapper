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
import {
  mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { query } from './corpus-db.js';
import { benchmarkTag, coordsOfId } from '../worker/src/benchmark-ids.js';
import {
  imageFeatures, featureStats, standardise, FEATURE_COUNT, FEATURE_NAMES,
} from '../public/lib/features.js';
import { train, predict, balanceWeights } from './learner.js';
import {
  drawPrediction, drawLayers, LAYERS, tracePrediction, traceMask, traceDrift, mistakeCounts,
} from './render-prediction.js';
import {
  classesFor, errorByClass, interiorError, classOverlap,
} from './boundary.js';
import { runSlug, runKeys, runRow, publishRunList } from './run-folder.js';
import { edgeBand, bestShift } from './edge-band.js';
import {
  loadBackbone, tiledFeatures, sampleAt, projection, project,
} from './backbone.js';
import { rasterizePolygon } from '../public/lib/mask.js';
import { stage3, clearCanopy } from './stage3.js';
import { colourEdges } from './colour-edges.js';
import { frameBbox3857 } from '../worker/src/imagery.js';
import { lawnSetClause, lawnSetName, lawnSetDescription, BENCHMARK_PRINT } from './lawn-set.js';
import { lngLatToFramePx, metresPerPixel } from '../public/lib/mercator.js';

const SQM_PER_SQFT = 0.09290304;

/*
 * SHORT NAMES FOR THE BENCHMARK LAWNS, B01 to B32 (worker/src/benchmark-ids.js,
 * fixed 2026-09-26). "Kent County 8,626 sq ft" was how the owner and every
 * session had to name a lot, and two tools computing square feet two ways
 * had already produced two names for one lawn. Null for any lawn not in it.
 */
export function lawnTag(id) {
  return benchmarkTag(id);
}
/** "B06 Kent County" -- the tag first, so a column of them sorts and reads at a glance. */
const lawnName = (L) => `${L.tag ? `${L.tag} ` : ''}${L.county || 'traced by hand'}`;

/*
 * THE PLAN'S ROW (docs/DETECTOR-FINDINGS.md, H39): the one the pictures are
 * drawn for whenever a run scores it. Change it here when THE PLAN changes.
 */
const PLAN_ROW = 'decoder, canopy on lawn + stage 3, span, lidar veto';
/* THE ROW ON TRIAL, drawn in preference to THE PLAN's when a run scores it,
   because the pictures are how a candidate is judged (owner, 2026-09-26).
   None now: the lidar ∩ NAIP canopy row was drawn once and lost (H42). */
const TRIAL_ROW = null;

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

/*
 * THE RING: what is around this spot, laid out separately from what is at it.
 *
 * The head decides one pixel at a time from one patch's description, with no
 * knowledge of what it decided next door. So a pixel under a tree is asked
 * "dark and leafy -- grass?" and answers no, correctly, about the only
 * evidence it was given. The lawn three metres either side is never mentioned.
 *
 * The backbone's own description of that patch does carry some of its
 * surroundings, because every patch attends to every other. But it carries it
 * BLENDED -- one smear where what-is-here and what-is-near are stirred
 * together. Laid out in order, as separate entries at known distances, the
 * same information is something a small head can find a rule in.
 *
 * IN METRES, NOT PIXELS, and that is not tidiness. These twenty properties
 * span 0.055 to 0.475 metres a pixel -- a factor of nine. A ring measured in
 * pixels would reach three metres on one lot and twenty-six on the next, so
 * the head would be learning a different question per lawn. Metres is the only
 * unit under which "what is six metres away" means one thing.
 *
 * THE REACH HAS TO BEAT THE THING IT IS BRIDGING. A canopy is often six to ten
 * metres across, so a ring of immediate neighbours is still entirely under the
 * tree and has learnt nothing. 3 m and 6 m are chosen to straddle a typical
 * one; the far ring is what touches grass on the other side.
 *
 * NARROW ON PURPOSE. Sixteen ring points at the centre's own width would be
 * 688 numbers of surroundings against 43 of evidence, and drowning the centre
 * is precisely the failure this is supposed to avoid. Each ring point gets two
 * colour numbers and a six-number squeeze of the backbone: enough to say "that
 * over there looks like lawn", not enough to out-shout what is actually
 * visible here.
 */
const RING_METRES = [3, 6];
const RING_DIRS = 8;
const RING_DIMS = 6;
const RING_POINTS = RING_METRES.length * RING_DIRS;

/*
 * Excess green and green share: the two cheap numbers that most directly say
 * "that is vegetation". The ring is asked one question -- is there lawn out
 * there -- and does not need brightness, saturation or roughness to answer it.
 */
const RING_COLOUR = [3, 4];

/** Cheap colour and texture, then the backbone at two scales. */
const TOTAL_FEATURES = FEATURE_COUNT + 2 * PROJ_DIMS;

/*
 * EVERYTHING FOR ONE LAWN HAPPENS AT ONE GRID, and that is what makes the
 * comparison fair. The truth, the prediction and SAM's own outline are all
 * rasterised on it, so the three are counted on identical cells.
 *
 * THE GRID FOLLOWS METRES NOW, NOT A FIXED COUNT. 512 cells over the whole
 * frame was 12 cm a cell on a 60 m lot and 62 cm on a 319 m one -- the same
 * bug as H20 in a third place, and the one that matters most for the head
 * the browser actually runs: its texture window is 0.25 m (FINE_M), so on any
 * lot over about 128 m a cell was wider than the window and the feature was
 * measuring nothing. And the outline is quantised to the cell, which is where
 * "the mask is worse on big lawns" was partly coming from.
 *
 * So a lawn gets ceil(metres across / CELL_M) cells, floored at GRID and
 * capped at GRID_MAX. The floor keeps every lot under about 77 m exactly as
 * it was, cell for cell, so nothing already at the target moves. The cap is
 * memory: the cheap features are FEATURE_COUNT floats per cell held for every
 * cell of every lawn, 15 MB a lawn at 512 and 59 MB at 1024, and the runner
 * cannot hold this corpus at 10 cm. At the cap a 319 m lot is 31 cm a cell --
 * half what it was, not the target, and said so in the run's settings.
 *
 * GRID stays exported as the floor and as the grid every synthetic lawn in
 * the tests uses.
 */
const GRID = 512;
export const CELL_M = 0.15;
export const GRID_MAX = 1024;

/**
 * The cell size in force, in metres, or 0 for the old fixed 512.
 *
 * GRID_CELL_M exists so the change can be MEASURED: "fixed" (or 0) scores
 * every lawn on 512 cells exactly as every run before 2026-09-23 did, which
 * is the control a run at 15 cm reads against. Unset means CELL_M.
 */
export const cellMetres = () => {
  const raw = String(process.env.GRID_CELL_M ?? '').trim().toLowerCase();
  if (raw === '') return CELL_M;
  if (raw === 'fixed' || raw === '512') return 0;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * The size a frame is written at for the Python tools: as stored when
 * DUMP_SIZE is unset or "native", otherwise the LONGER side at DUMP_SIZE with
 * the shorter one following, so a rectangle stays a rectangle.
 */
export const dumpDims = (w, h) => {
  const want = dumpSize();
  if (!want) return [w, h];
  const f = want / Math.max(w, h);
  return [Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f))];
};

/** How many cells across this frame gets: 15 cm a cell, between the floor and the cap. */
export const gridFor = (frame, cell = cellMetres()) => gridDims(frame, cell).w;

/**
 * The grid for a frame, as width and height in cells.
 *
 * FRAMES ARE RECTANGLES since 2026-09-23 -- the parcel's box plus a margin,
 * cropped both ways -- so the grid is too. The rule (CELL_M a cell between
 * the floor and the cap) is applied to the LONGER side and the shorter one
 * follows at the same cells per metre, which is what keeps a texture window
 * the same size in both directions. A square frame gets the square it
 * always got.
 */
export const gridDims = (frame, cell = cellMetres()) => {
  const across = metresPerPixel(frame, 1);
  const height = Number.isFinite(frame?.height) && frame.height > 0 ? frame.height : frame?.size;
  const aspect = Number.isFinite(height) && Number.isFinite(frame?.size) && frame.size > 0
    ? height / frame.size : 1;
  const long = Math.max(1, aspect);            // the longer side, as a multiple of the width
  let cellsLong;
  if (!cell || !Number.isFinite(across) || across <= 0) {
    cellsLong = GRID;
  } else {
    /* The nudge keeps 150 / 0.15 from rounding up to 1001 cells. */
    cellsLong = Math.min(GRID_MAX, Math.max(GRID, Math.ceil((across * long) / cell - 1e-9)));
  }
  const w = Math.max(1, Math.round(cellsLong / long));
  const h = Math.max(1, Math.round((cellsLong * aspect) / long));
  return { w, h };
};

/**
 * How big the PUBLISHED pictures are, which is not the grid the model is
 * scored on.
 *
 * GRID is 512 because that is where the masks are compared and the error
 * figures computed, and moving it would move every number this project has.
 * The pictures are a different job: they are looked at, and since the
 * photographs are now banked at 1280 to 3192 px (H20), drawing them at 512
 * throws away everything a person would zoom in to see.
 *
 * 1280 is the common stored size, so it is real detail rather than an upscale
 * for most lots, and it costs about 6x the drawing time -- three minutes
 * becomes twenty, which is free CI and worth it for a picture somebody
 * actually reads. Capped at 2048 because a 33-lawn page on a phone is already
 * the binding constraint on how big these can be.
 */
const renderPx = () => {
  const n = Number(process.env.RENDER_PX);
  return Number.isFinite(n) && n >= 256 ? Math.min(2048, Math.round(n)) : 1280;
};

/*
 * WHAT SIZE THE PHOTOGRAPHS ARE WRITTEN OUT AT, which is not the same question
 * as what grid they are scored on.
 *
 * The scoring grid is 512 and stays 512 -- that is what makes one run
 * comparable to the last. But the frames handed to the extractor were being
 * written at 512 too, and then resized UP to 672 or 896 on the way into the
 * model. Upscaling invents no detail. Asking for a finer patch grid over a
 * blurrier picture buys a sharper-looking edge drawn from the same
 * information, which is the sort of improvement that shows up in a number and
 * nowhere else.
 *
 * The stored photograph is bigger than 512. So write the frames at whatever
 * size the extractor is going to read them at, and the box-average runs once,
 * downward, from the real pixels.
 *
 * Defaults to GRID so a run with nothing set behaves as it did.
 */
const dumpSize = () => {
  /*
   * "native" MEANS WHATEVER R2 HOLDS, and it is the right answer now that the
   * stored photographs are not all one size.
   *
   * THIS BUG HAS BEEN FIXED TWICE. First the dump was 1024 while the stored
   * photograph was 1280, giving away a fifth of the linear resolution for
   * nothing. Raising it to 1280 fixed that -- and then workflow 21 re-banked
   * the big lots at 10 cm a pixel, up to 3192 px and 5120 px, and a fixed 1280
   * threw the whole gain away again: a 319 m lot came back down to 24.9 cm a
   * pixel, which is precisely the state H20 describes. The fix was undone by
   * the next improvement because it was a CONSTANT where it should have been a
   * reference to the source.
   *
   * So a number is still honoured -- tests and old runs pass one -- but the
   * default follows the photograph, and cannot be left behind again.
   */
  const raw = String(process.env.DUMP_SIZE || '').trim();
  const n = Number(raw);
  /*
   * ANYTHING THAT IS NOT A USABLE NUMBER MEANS NATIVE, including a typo.
   *
   * The old rule fell back to the 512 scoring grid, which is the quietest
   * possible wrong answer: a mistyped DUMP_SIZE would have written every frame
   * at a sixth of its resolution and nothing would have said so. Falling back
   * to the source instead makes a typo cost disk rather than detail, and the
   * dump step prints the sizes it wrote either way.
   */
  return Number.isFinite(n) && n >= 64 ? Math.round(n) : 0;
};

/*
 * DRAW WHAT IT GOT WRONG, on the photograph it got it wrong on.
 *
 * Off unless asked, because it costs memory in the reading loop -- the
 * photograph and one mask per lawn have to be kept alive rather than turned
 * into features and dropped. Cheap when wanted and pointless when not.
 *
 * See tools/render-prediction.js for what is drawn and why that rather than
 * "here is the lawn it found".
 */
const renderWanted = /^(1|true|yes)$/i.test(String(process.env.RENDER_PREDICTIONS || ''));

/**
 * WHAT THIS RUN IS TESTING, typed by whoever started it.
 *
 * The settings beside the pictures say what was different; they cannot say
 * what the difference was meant to prove, and that is the part nobody can
 * reconstruct later. "Does dropping unseen ground help the visible half" is a
 * sentence; `seenOnly: true` is a flag that reads, six weeks on, as somebody
 * having fiddled with something.
 *
 * Optional, and empty is honest. A required field would be filled in with
 * "test" by the third run and then the field would be lying instead of blank.
 */
const RUN_ABOUT = String(process.env.RUN_ABOUT || '').trim().slice(0, 600);

/*
 * HOW WIDE THE FRAME IS IN METRES, one number per lawn.
 *
 * Scale-MAE is not a model you hand a picture to. Its position encoding is
 * built from the ground distance a patch covers, so it has to be TOLD what it
 * is looking at, and a wrong answer there is not an error -- it is a model
 * quietly reading a lawn as though it were a car park seen from orbit.
 *
 * Written as metres across the frame rather than metres per pixel, because
 * per-pixel depends on what size the picture was saved at and this does not.
 * The extractor divides by whatever width it ends up using.
 */
/*
 * A SHORT NAME FOR "THESE EXACT LAWNS".
 *
 * Not security, not collision-proof -- a label. Two runs printing the same
 * fingerprint scored the same properties, so the difference between their
 * tables is the thing under test. Two printing different ones are not
 * comparable at all, however similar the headings look, and that is worth
 * being able to see without reading twenty lines of lawn-by-lawn output.
 */
export const setPrint = (lawns) => {
  let h = 2166136261;
  for (const id of lawns.map((L) => L.id).sort()) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
};

export const frameSpans = (lawns, grid = GRID) => {
  const out = {};
  for (const L of lawns) out[L.id] = L.mpp * (L.grid || grid);
  return out;
};

/**
 * Each frame as [west, south, east, north] in EPSG:3857 metres, for anything
 * that has to find the frame in a dataset that is not a picture -- the 3DEP
 * point clouds are published in exactly that projection, so a reader can
 * cut the frame's rectangle straight out of the octree with no reprojection
 * and no guessing about which pixel is which metre. Written into scale.json
 * beside the spans.
 */
export const frameBoxes = (lawns) => {
  const out = {};
  for (const L of lawns) if (L.frame) out[L.id] = frameBbox3857(L.frame);
  return out;
};

/**
 * How many pixels R2 actually holds for each lawn, which is NOT the size the
 * frames were dumped at.
 *
 * WHY THIS HAS TO TRAVEL WITH THE FRAMES. `resize` upscales as happily as it
 * downscales, so dumping a 640 px photograph at 1280 produces a 1280 px file
 * carrying 640 px of detail. Anything downstream that works out ground
 * resolution from the FILE then claims twice the resolution that exists -- and
 * the number it would corrupt (H20's `upsampled`) is the one whose entire job
 * is to say when the model is being shown interpolation. A measurement that
 * flatters itself in exactly its own subject is worse than no measurement.
 */
export const framePixels = (lawns) => {
  const out = {};
  for (const L of lawns) if (L.storedPx) out[L.id] = L.storedPx;
  return out;
};

const QUERY = `
  SELECT id, county, tree_line, frame, shapes, detected_shapes, parcel,
         image_key, image_provider, image_frame, mode, model, naip_align
    FROM corpus
   WHERE status = 'approved' AND image_key IS NOT NULL AND frame IS NOT NULL${lawnSetClause()}
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
 * Only the shapes the reviewer marked as inferred rather than seen.
 *
 * WHY THIS IS SEPARATE FROM THE TRUTH. Under a tree canopy there is no grass
 * in the photograph -- there is a tree. A person who knows what lawns look
 * like can say with confidence that grass continues under it, and that
 * judgement is worth recording, but it is a judgement about SHAPE and not a
 * reading of the pixels. Mixed in undifferentiated it teaches "canopy means
 * lawn", which on a genuinely wooded lot claims the woods; the record already
 * has one of those, at 34,500 sq ft.
 *
 * Kept apart, it becomes the opposite of a hazard: the error on these pixels
 * and the error everywhere else can be reported separately, so "the model now
 * bridges canopies" and "the model has stopped looking" are two different
 * numbers instead of one ambiguous one.
 *
 * Nothing marked means this returns nothing, and every pixel counts as seen --
 * which is exactly right for a corpus traced before the flag existed.
 */
const inferredGeometries = (stored) => {
  const list = Array.isArray(stored) ? stored : stored?.features || [];
  return list.filter((g) => g?.properties?.inferred).map((g) => g.geometry).filter(Boolean);
};

/**
 * WHERE BOTH LAYERS COVER A PIXEL, IT COUNTS AS INFERRED.
 *
 * This was the other way round for one commit, on the reasoning that a
 * generously drawn inferred patch could pull visible ground out of the column
 * that watches for the model going blind. That reasoning describes a corpus
 * traced by strangers. This one is traced by its owner and a few friends, and
 * it gets the precision backwards.
 *
 * The blue layer is the generous one. It was drawn to answer "how much lawn is
 * here", in one sweep, across ground that was visible and ground that was not
 * -- most of it before the inferred layer existed at all. The purple is the
 * careful one: drawn deliberately, small, by somebody who stopped and thought
 * about that particular canopy. Precision lives with the later, narrower mark.
 *
 * And seen-wins made the whole exercise a no-op. Every existing map already
 * has blue over its canopies, so marking them purple would have left purple
 * lying entirely inside blue -- subtracted to nothing, an empty column, and no
 * amount of marking would ever have filled it.
 *
 * WHAT REPLACES THE GUARD: the share of each map that is marked, reported
 * beside the score. A map marked over generously cannot hide -- it shows up as
 * a large inferred share, next to the number it is affecting, where it can be
 * looked at and argued with. That is a better guard than a silent rule,
 * because it is visible.
 */

/**
 * How much of a lawn's truth is marked inferred, 0 to 1.
 *
 * The guard, now that the tie rule no longer is one. A map marked over
 * generously cannot distort the numbers quietly -- it appears beside them as a
 * large share, on the lawn it belongs to, where it can be looked at.
 *
 * Counted over truth pixels inside the property line, because that is the set
 * every other number here is counted over.
 */
export function inferredShare(truth, inferred, within) {
  if (!inferred) return 0;
  let marked = 0, total = 0;
  for (let i = 0; i < truth.length; i++) {
    if (within && !within[i]) continue;
    if (!truth[i]) continue;
    total++;
    if (inferred[i]) marked++;
  }
  return total ? marked / total : 0;
}

/** The other half: everything NOT marked inferred, which is most of it. */
const seenGeometries = (stored) => {
  const list = Array.isArray(stored) ? stored : stored?.features || [];
  return list.filter((g) => !g?.properties?.inferred)
    .map((g) => (g?.geometry ? g.geometry : g)).filter(Boolean);
};

/**
 * Pull one stored photograph out of R2 and decode it to RGBA.
 *
 * THE KEY ENDS .png AND THE BYTES MIGHT NOT BE. storeImage names every object
 * .png whatever the source actually returned, so trusting the extension
 * decodes a JPEG with a PNG reader and throws on a file that is perfectly
 * fine. The magic number is the only honest answer.
 */
/*
 * THREE TRIES, because one failure silently rewrites the experiment.
 *
 * A lawn that will not fetch is skipped, and a skipped lawn is not a slightly
 * smaller run -- it is a DIFFERENT SET, and the numbers move far more with the
 * set than with anything being compared. Two transient wrangler failures took
 * one run from 20 lawns to 18, and the fixed colour-only configuration moved
 * 38.7% -> 48.2% on identical code. Nine and a half points, from nothing but
 * which gardens were in the room.
 *
 * So a network blip must not be allowed to look like a result. Retrying is the
 * cheap half of the fix; saying so loudly at the end is the other half.
 */
const FETCH_TRIES = 3;

function fetchImage(bucket, key, dir, decoders) {
  const file = join(dir, 'image.bin');
  let last = '';
  for (let attempt = 1; attempt <= FETCH_TRIES; attempt++) {
    try {
      execFileSync('npx', [
        'wrangler', 'r2', 'object', 'get', `${bucket}/${key}`,
        '--file', file, '--remote',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      last = '';
      break;
    } catch (e) {
      last = String(e.message || e).slice(0, 80);
      /* A short wait, doubling. Whatever rate limit or hiccup this was, going
         straight back at it is the way to meet it again. */
      if (attempt < FETCH_TRIES) execFileSync('sleep', [String(attempt * 2)]);
    }
  }
  if (last) return { ok: false, reason: `could not fetch after ${FETCH_TRIES} tries (${last})` };
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
function resize(src, w, h, channels, size, sizeH = size) {
  const out = new Uint8Array(size * sizeH * 4);
  const sx = w / size;
  const sy = h / sizeH;
  for (let y = 0; y < sizeH; y++) {
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

/**
 * A lawn's three masks as one picture: red is the traced lawn, green is
 * inside the property line (all of it, when there is no line), blue is
 * "inferred, not seen". On the scoring grid, G x GH, so a reader that knows
 * the grid needs nothing else to line them up.
 */
export function labelsPng(L, PNG) {
  const G = L.grid || GRID;
  const GH = L.gridH || G;
  const png = new PNG({ width: G, height: GH });
  const px = png.data;
  for (let i = 0; i < G * GH; i++) {
    const o = i * 4;
    px[o] = L.truth[i] ? 255 : 0;
    px[o + 1] = !L.within || L.within[i] ? 255 : 0;
    px[o + 2] = L.inferred && L.inferred[i] ? 255 : 0;
    px[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * A decoder's answer, read back off its picture as a mask on the grid.
 *
 * Grey, 255 meaning certainly lawn, cut at the middle -- the same 0.5 the
 * head's own answers are cut at in runFold. Null when the picture is not
 * the size of the grid it claims to answer, because a resample here would
 * hide exactly the registration bug the Python side's tests exist to catch.
 */
export function predictionMask(png, G, GH = G) {
  if (!png || png.width !== G || png.height !== GH) return null;
  const out = new Uint8Array(G * GH);
  for (let i = 0; i < out.length; i++) out[i] = png.data[i * 4] >= 128 ? 1 : 0;
  return out;
}

/**
 * The tree model's mask, written at the frame's own pixels, brought to the
 * scoring grid by nearest neighbour. Both cover the same frame, so a cell
 * reads the mask pixel under its top-left corner; at 15 cm cells over a 10 cm
 * mask that is never more than a cell out. Null for a picture with no pixels.
 */
export function canopyMask(png, G, GH = G) {
  if (!png || !png.width || !png.height) return null;
  const out = new Uint8Array(G * GH);
  for (let y = 0; y < GH; y++) {
    const sy = Math.min(png.height - 1, Math.floor((y * png.height) / GH));
    for (let x = 0; x < G; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / G));
      out[y * G + x] = png.data[(sy * png.width + sx) * 4] >= 128 ? 1 : 0;
    }
  }
  return out;
}

/**
 * The lidar's height above ground, from the grey PNG tools/lidar_frame.py
 * writes (a tenth of a metre a level, on its own 2 m grid), sampled nearest
 * onto the scoring grid as metres. Nearest for the same reason as the canopy
 * mask: a 2 m reading copied into the 15 cm cells under it is the reading;
 * an average would invent heights between two trees.
 */
export function heightMask(png, G, GH = G) {
  if (!png || !png.width || !png.height) return null;
  const out = new Float32Array(G * GH);
  for (let y = 0; y < GH; y++) {
    const sy = Math.min(png.height - 1, Math.floor((y * png.height) / GH));
    for (let x = 0; x < G; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / G));
      out[y * G + x] = png.data[(sy * png.width + sx) * 4] / 10;
    }
  }
  return out;
}

/**
 * The tree model's canopy, widened where the lidar and NAIP-CHM agree it
 * missed a tree (H41), or where NAIP-CHM alone says so on a lawn with no
 * point cloud. Null when there is nothing to widen.
 */
export function canopyPlus(canopy, lidarCanopy, naipCanopy) {
  if (!canopy || !naipCanopy) return null;
  const out = Uint8Array.from(canopy);
  for (let i = 0; i < out.length; i++) {
    if (naipCanopy[i] && (!lidarCanopy || lidarCanopy[i])) out[i] = 1;
  }
  return out;
}

/**
 * THE LIDAR VETO (H38): a cell the point cloud calls roof or void is not
 * lawn, whatever stage 1 and stage 3 said. Returns a copy; a missing mask
 * vetoes nothing.
 */
export function lidarVeto(mask, roof, voidMask) {
  if (!roof && !voidMask) return mask;
  const out = Uint8Array.from(mask);
  for (let i = 0; i < out.length; i++) {
    if ((roof && roof[i]) || (voidMask && voidMask[i])) out[i] = 0;
  }
  return out;
}

/** Geometries -> a filled mask on the GRID, using the row's own frame. */
function maskOf(geoms, frame, size, sizeH = size) {
  const project = (ll) => lngLatToFramePx(frame, ll, size, sizeH);
  const out = new Uint8Array(size * sizeH);
  for (const g of geoms) {
    if (g?.type !== 'Polygon' || !Array.isArray(g.coordinates)) continue;
    const m = rasterizePolygon(g.coordinates, size, sizeH, project);
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
 * The traced outline's error, and how much of the raw mask's error lies near
 * the truth's edge (see tools/edge-band.js). Percentages; null-safe.
 */
export function edgeDiagnosis(L, predicted) {
  const G = L.grid || GRID;
  const GH = L.gridH || G;
  const trace = tracePrediction({ predicted, within: L.within, grid: G, gridH: GH, mpp: L.mpp });
  const traced = traceMask({ shapes: trace.shapes, within: L.within, grid: G, gridH: GH });
  const t = compare(traced, L.truth, L.within);
  const cellsFor = (m) => Math.max(1, Math.round(m / (L.mpp || 0.15)));
  const band = edgeBand({
    truth: L.truth, got: predicted, within: L.within, w: G, h: GH,
    radii: [cellsFor(0.5), cellsFor(1.0)],
  });
  const share = (k) => (band.wrong ? (100 * band.near[k]) / band.wrong : 0);
  /* Up to 0.6 m each way: past that it is not registration, it is a different answer. */
  const s = bestShift({ truth: L.truth, got: predicted, within: L.within, w: G, h: GH, reach: cellsFor(0.6) });
  const truthPx = t.truth || 1;
  return {
    tracedPct: t.errorPct ?? 0, near05: share(0), near10: share(1),
    shiftX: s.dx * L.mpp, shiftY: s.dy * L.mpp, shiftedPct: (100 * s.wrong) / truthPx,
  };
}

/**
 * Features from the Python extractor, if it was run.
 *
 * ONE PASS OVER THE WHOLE PROPERTY, which is the point of going to Python at
 * all. The ONNX export Node can load is frozen at 224 pixels, so it had to be
 * run on sixteen tiles -- and a patch in the middle of a tile cannot see the
 * garden it sits in, which is exactly the context a pretrained model is for.
 * In PyTorch the same architecture interpolates its position embeddings and
 * takes any size, so every patch attends to every other one. Grass in shadow
 * can then be read as grass because the model can see the lawn around it.
 *
 * So when these are present there is no coarse pass: the single grid already
 * carries both the detail and the whole-frame context.
 */
function readPythonFeatures(dir) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const grids = new Map();
  for (const [stem, shape] of Object.entries(manifest.images || {})) {
    const file = join(dir, `${stem}.f32`);
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    grids.set(stem, {
      data: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
      gridW: shape.gridW, gridH: shape.gridH, dim: shape.dim,
      /* How far past the photograph a windowed grid runs. See sampleAt. */
      coverX: shape.coverX || 1, coverY: shape.coverY || 1,
      windows: shape.windows || 1, mpp: shape.mpp || null,
    });
  }
  return { manifest, grids };
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
export function buildRow(lawn, p, out, offset, grid = GRID, cfg = null, gridH = grid) {
  const { cheap, fine, coarse, ring } = lawn;
  const useColour = cfg ? cfg.colour : true;
  const useEye = cfg ? cfg.backbone : true;
  const dims = cfg ? cfg.dims : PROJ_DIMS;

  const px = p % grid;
  const py = (p / grid) | 0;

  let at = offset;
  if (useColour) {
    for (let f = 0; f < FEATURE_COUNT; f++) out[at + f] = cheap[p * FEATURE_COUNT + f];
    at += FEATURE_COUNT;
  }
  if (useEye && fine) {
    sampleAt(fine, px, py, grid, out, at, gridH);
    at += dims;
    /* The Python path has no coarse grid: its single pass already saw the
       whole frame, so a second, blurrier copy of the same thing would only
       spend width. */
    if (coarse) { sampleAt(coarse, px, py, grid, out, at, gridH); at += dims; }
  }

  /*
   * THE SURROUNDINGS, AFTER the evidence and never instead of it.
   *
   * Order matters only for readability -- the head sees a flat row either way
   * -- but reading a row and finding what is actually here before what is
   * merely near is worth the zero it costs.
   */
  if (cfg && cfg.ring) {
    /* Pixels per metre, from this lawn's own scale. The fallback is only for
       synthetic lawns in the tests; a real one always carries mpp. */
    const perMetre = 1 / (lawn.mpp || 0.1);
    for (const metres of RING_METRES) {
      const reach = metres * perMetre;
      for (let d = 0; d < RING_DIRS; d++) {
        const angle = (2 * Math.PI * d) / RING_DIRS;
        /*
         * Clamped to the frame. A ring point off the edge repeats the edge
         * rather than reading zeroes: zero is a colour, and a lawn at the
         * frame's edge would get a ring of confident black.
         */
        const qx = Math.min(grid - 1, Math.max(0, px + Math.cos(angle) * reach));
        const qy = Math.min(gridH - 1, Math.max(0, py + Math.sin(angle) * reach));
        const q = ((qy | 0) * grid + (qx | 0)) * FEATURE_COUNT;
        for (const f of RING_COLOUR) out[at++] = cheap[q + f];
        /*
         * THE RING OBEYS cfg.backbone TOO, and it did not until 2026-09-19.
         *
         * The gate here was `if (ring)` -- meaning "if this lawn has backbone
         * features at all" -- so the row named "colour, with surroundings",
         * declared `backbone: false`, carried six backbone numbers per ring
         * point anyway. That row exists to answer one question, stated in the
         * comment beside its definition: does the ring's gain need the
         * backbone, or is "is it green over there" the whole of it. It could
         * not answer that question, because it was never colour-only.
         *
         * Caught by a reproducibility check rather than by reading the code:
         * it was the one supposedly backbone-free row that drifted between two
         * identical runs (H13), which it could not have done without backbone
         * features in it.
         */
        if (ring && useEye) { sampleAt(ring, qx, qy, grid, out, at, gridH); at += RING_DIMS; }
      }
    }
  }
  return out;
}

/** How wide a row is under one configuration, and whether it is runnable. */
export function rowWidth(cfg, hasEye, scales = 2) {
  const colour = cfg.colour ? FEATURE_COUNT : 0;
  const eye = cfg.backbone && hasEye ? scales * cfg.dims : 0;
  /* Matches buildRow: a ring only carries backbone numbers when THIS
     configuration asked for the backbone, not merely when one exists. */
  const ring = cfg.ring
    ? RING_POINTS * (RING_COLOUR.length + (cfg.backbone && hasEye ? RING_DIMS : 0))
    : 0;
  return colour + eye + ring;
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

export function shrink(grid, dims) {
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
  /*
   * THE COVER TRAVELS WITH THE SQUEEZED GRID. This returned only the four
   * fields above until 2026-09-24, so sampleAt read every squeezed grid as
   * if it covered the photograph exactly -- which it did, until the windows
   * (cover about 1.15) and then the padded rectangles (cover up to 2.9). On
   * a padded rectangle the head read features stretched by the aspect ratio
   * and scored 80% wrong on the eye alone while the decoder, reading the
   * same files with its own mapping, scored 28.5%. H22's windowed rows
   * carried the same error at a smaller size. See H25.
   */
  return {
    data: out, gridW, gridH, dim: dims,
    coverX: grid.coverX || 1, coverY: grid.coverY || 1,
    windows: grid.windows || 1, mpp: grid.mpp ?? null,
  };
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
  /*
   * THE CONTROL, NOT A CANDIDATE. Colour will never be the answer: it is what
   * shadow defeats, and the plan (docs/DETECTOR-FINDINGS.md, THE PLAN) puts
   * the visible lawn on the satellite-pretrained eye. This row stays because
   * it is reproducible to the decimal (H10) and so says whether the corpus
   * moved between two runs, and because it is the only head a browser can
   * run (EXPORT_MODEL). It is excluded from "best" -- see `contenders`.
   */
  { name: 'colour and texture only', colour: true, backbone: false, dims: 0, control: true },
  { name: 'the pretrained eye only', colour: false, backbone: true, dims: 32 },
  { name: 'both', colour: true, backbone: true, dims: 32 },
  /*
   * The 96-number squeeze, the colour-only ring and the combined ring were
   * rows here until 2026-09-23. Six rows of the same random projection into
   * the same 16-unit head were six ways of asking the same narrow question,
   * and the winner among them moved with the corpus (H4, H13, H23). The
   * decoder row -- tools/train_decoder.py, scored below from PREDICTIONS_DIR
   * -- reads the eye's full width instead of a random 32 of it, which is the
   * question those rows could not ask.
   */
];

/**
 * THE SAME SIX, TRAINED ONLY ON GROUND SOMEBODY COULD ACTUALLY SEE.
 *
 * THE QUESTION. `truth` is every shape the tracer drew, and that INCLUDES the
 * patches they marked "inferred, not seen" -- ground under a canopy that they
 * judged to be lawn without being able to look at it. The head is therefore
 * told to answer 1 on pixels whose appearance is indistinguishable from woods,
 * and the same dark canopy is labelled 1 on a lawn with one tree in it and 0 on
 * a wooded lot. From the model's side that is not a hard case, it is a
 * contradiction: the label is not a function of anything it can see.
 *
 * So does carrying that contradiction cost the visible half anything? Nobody
 * knows. The inferred marks have been scored separately since the column was
 * added and have never been separated in TRAINING, so the question has been
 * open by omission rather than by decision.
 *
 * DON'T-CARE, NOT ZERO, and the difference is the whole design. Labelling the
 * inferred pixels 0 would teach "canopy means not lawn", which is a different
 * wrong answer and would wreck the thing a second stage would be built on.
 * Dropping them from the sample says only "do not grade me on this".
 *
 * PAIRED IN ONE RUN rather than compared across two, because H13 says a
 * backbone row occasionally comes back different on an identical re-run, and a
 * two-run comparison could not tell that apart from a result. Every twin here
 * shares the corpus, the folds, the seed and the feature extraction with its
 * original; the only difference is which pixels were sampled.
 *
 * WHAT TO READ, and reading the wrong column would invert the conclusion: the
 * SEEN column is the experiment. The inferred column is expected to get much
 * worse -- nothing taught these rows what to say there -- and that is the
 * arrangement working, not a regression.
 */
const seenOnlyTwin = (cfg) => ({
  ...cfg,
  name: `${cfg.name} (seen only)`,
  seenOnly: true,
  /* Which row it is the twin OF, so the comparison can be printed rather than
     eyeballed off two names that differ by a suffix. */
  twinOf: cfg.name,
});

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

  /* Each lawn on its own grid -- see gridFor. `opts.grid` is the fallback for
     the synthetic lawns in the tests, which carry none. */
  const gridOf = (L) => L.grid || grid;
  const gridHOf = (L) => L.gridH || L.grid || grid;

  let trainedOn = 0;
  for (let i = 0; i < lawns.length; i++) {
    if (i === held) continue;               // the whole point
    trainedOn++;
    const L = lawns[i];
    const n = gridOf(L) * gridHOf(L);
    for (let k = 0; k < perLawn; k++) {
      const p = Math.floor(rand() * n);
      if (L.within && !L.within[p]) continue;
      /*
       * GROUND NOBODY COULD SEE IS NOT EVIDENCE, when the configuration says
       * so. See seenOnlyTwin: the pixel is dropped rather than labelled 0,
       * because 0 would teach "canopy means not lawn" and that is a different
       * wrong answer.
       *
       * Dropped rather than resampled, which is the same thing the property-line
       * test above does one line earlier: a lawn with a lot of marked ground
       * contributes fewer rows, and having less visible evidence to offer is
       * exactly what is true of it. H6 puts marked ground at 5% of a typical
       * map, so the sample loss is small -- but it is a real difference between
       * a row and its twin and is not the effect being measured.
       */
      if (cfg.seenOnly && L.inferred && L.inferred[p]) continue;
      picked.push([L, p]);
      ys.push(L.truth[p]);
    }
  }

  const x = new Float32Array(picked.length * width);
  for (let i = 0; i < picked.length; i++) {
    buildRow(picked[i][0], picked[i][1], x, i * width, gridOf(picked[i][0]), cfg, gridHOf(picked[i][0]));
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
  const tg = gridOf(test);
  const tgH = gridHOf(test);
  const got = new Uint8Array(tg * tgH);
  const ROWS = 32;
  const chunk = new Float32Array(ROWS * tg * width);
  for (let y0 = 0; y0 < tgH; y0 += ROWS) {
    const rows = Math.min(ROWS, tgH - y0);
    const count = rows * tg;
    for (let i = 0; i < count; i++) {
      buildRow(test, y0 * tg + i, chunk, i * width, tg, cfg, tgH);
    }
    const slice = chunk.subarray(0, count * width);
    standardise(slice, stats, width);
    const p = predict({ ...model, inputs: width }, slice);
    for (let i = 0; i < count; i++) got[y0 * tg + i] = p[i] > 0.5 ? 1 : 0;
  }

  return judgeFold(test, got, { trainedOn, sampled: picked.length });
}

/**
 * Everything a fold reports about one held-out answer, from the mask alone.
 *
 * Split out of runFold so an answer that did not come from the head -- the
 * decoder's, read from a file -- is judged by exactly the same arithmetic
 * and lands in the same table. Two copies of "how wrong, and where" would be
 * two chances to disagree about the number the whole run is for.
 */
export function judgeFold(test, got, { trainedOn = 0, sampled = 0 } = {}) {
  /*
   * HOW WRONG IS IT IN THE DARK?
   *
   * Reported because shadow is the objection this whole approach has to answer,
   * and a single percentage cannot. A model reading mostly colour should fall
   * apart on grass in shade -- dark, and with the green washed out of it -- so
   * splitting the error by how bright the ground is turns "I think shadows
   * break it" into something the run either confirms or refutes.
   *
   * The cut is the frame's own median brightness rather than a fixed value: a
   * photograph taken in flat light has no dark half in absolute terms, and a
   * threshold picked in advance would call every pixel of it bright and report
   * nothing.
   */
  /*
   * SEEN VERSUS INFERRED, which is the guard on the ring.
   *
   * The worry about giving the head its surroundings is specific and correct:
   * context is a cleaner, louder signal than a faint edge in shadow, so a head
   * offered both might learn to lean on the neighbours and stop reading the
   * evidence. That would trade the thing that is hard to see for the thing
   * that is impossible to see, and come out ahead on the total while being
   * worse at the job.
   *
   * There is no way to forbid that in the architecture -- the head uses what
   * predicts, and that is what training means. What there is, is a way to SEE
   * it: score the pixels the reviewer could actually see apart from the ones
   * they inferred. A ring that is working lifts the inferred column and leaves
   * the seen column alone. A ring that has started guessing lifts the inferred
   * column and drops the seen one, and that shows up here as two numbers
   * moving in opposite directions rather than as one number quietly improving.
   *
   * Both are null until something is marked, which is honest: before the flag
   * exists there is no such thing as an inferred pixel, and every pixel is
   * seen.
   */
  let seenWrong = 0, seenTruth = 0, guessWrong = 0, guessTruth = 0;
  for (let i = 0; i < got.length; i++) {
    if (test.within && !test.within[i]) continue;
    const wrong = (got[i] ? 1 : 0) !== (test.truth[i] ? 1 : 0);
    if (test.inferred && test.inferred[i]) {
      guessTruth += test.truth[i] ? 1 : 0;
      guessWrong += wrong ? 1 : 0;
    } else {
      seenTruth += test.truth[i] ? 1 : 0;
      seenWrong += wrong ? 1 : 0;
    }
  }

  let darkWrong = 0, darkTruth = 0, brightWrong = 0, brightTruth = 0;
  {
    const lumaOf = (i) => test.cheap[i * FEATURE_COUNT + 5];
    const sample = [];
    for (let i = 0; i < got.length; i += 7) {
      if (test.within && !test.within[i]) continue;
      sample.push(lumaOf(i));
    }
    sample.sort((a, b) => a - b);
    const cut = sample.length ? sample[sample.length >> 1] : 0.5;
    for (let i = 0; i < got.length; i++) {
      if (test.within && !test.within[i]) continue;
      const dark = lumaOf(i) < cut;
      const wrong = (got[i] ? 1 : 0) !== (test.truth[i] ? 1 : 0);
      if (dark) { darkTruth += test.truth[i] ? 1 : 0; darkWrong += wrong ? 1 : 0; }
      else { brightTruth += test.truth[i] ? 1 : 0; brightWrong += wrong ? 1 : 0; }
    }
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

  /*
   * WHERE THE ERROR LIVES: the sharp half of the boundary against the soft
   * half, and hard-rimmed shade against soft-rimmed shade.
   *
   * Both are here to test H12 -- the reading that this model handles the
   * ground we assumed was hard and fails on the ground we assumed was easy.
   * The interior figure is the control, and it is not optional: error
   * concentrates at boundaries in every segmentation model there has ever
   * been, so "the edge is worse than the middle" is a definition rather than
   * a finding. Crisp against soft is the comparison with an answer in it.
   */
  const edge = test.classes
    ? errorByClass({
      classes: test.classes.edge, predicted: got, truth: test.truth, within: test.within,
    })
    : null;
  const shade = test.classes
    ? errorByClass({
      classes: test.classes.shade, predicted: got, truth: test.truth, within: test.within,
    })
    : null;
  const inner = test.classes
    ? interiorError({
      band: test.classes.band, predicted: got, truth: test.truth, within: test.within,
    })
    : null;

  return {
    mine: compare(got, test.truth, test.within),
    theirs: test.detected ? compare(test.detected, test.truth, test.within) : null,
    trainedOn,
    /* How many pixels the head actually learnt from. Returned because a
       configuration can now DROP samples -- see seenOnly -- and a flag that
       silently failed to reach the sampling would produce a twin identical to
       its original, which is also a legitimate result of the experiment. The
       two are indistinguishable from the report and not from this number. */
    sampled,
    collapsed: judged > 0 && (lit === 0 || lit === judged),
    crispEdgePct: edge?.crispPct ?? null,
    softEdgePct: edge?.softPct ?? null,
    hardShadePct: shade?.crispPct ?? null,
    softShadePct: shade?.softPct ?? null,
    interiorPct: inner,
    darkPct: darkTruth ? (100 * darkWrong) / darkTruth : null,
    brightPct: brightTruth ? (100 * brightWrong) / brightTruth : null,
    seenPct: seenTruth ? (100 * seenWrong) / seenTruth : null,
    guessPct: guessTruth ? (100 * guessWrong) / guessTruth : null,
    predicted: got,
  };
}

/**
 * Draw the outline the detector would have handed the drawing tools, per lawn,
 * and put the pictures in the bucket.
 *
 * EVERY RUN KEEPS ITS OWN FOLDER, and this used to be the other way round.
 *
 * The old comment here argued that one run should overwrite the last, on the
 * grounds that docs/DETECTOR-FINDINGS.md is the history and these pictures are
 * only a diagnosis of the model as it stands. That was wrong in the way that
 * matters: the findings file records what a run SCORED, and it has no way to
 * record what the shapes looked like. "Is this outline worth correcting by
 * hand" is the question this page exists for and only the picture answers it,
 * so two runs a point apart can be a completely different answer and the
 * earlier one was already gone.
 *
 * BOTH PICTURES, EVERY LAWN. The shapes are what the drawing tools would
 * receive; the raw mask is what the model actually said. The tracer smooths,
 * fills holes under about 60 sq ft and bins the speckle -- all wanted, all
 * flattering -- and the toggle between the two is where that shows.
 *
 * The index is written LAST, on purpose. The page reads the index to know what
 * exists, so writing it first would advertise pictures that are still
 * uploading, and a run that dies halfway would leave the page pointing at
 * things that never arrived. The RUN LIST is written after that, for the same
 * reason one step further out: a run appears in the picker only once there is
 * something behind it.
 */
async function publishRenderings(bucket, best, lawns, using, meta = {}) {
  const { PNG } = await import('pngjs');
  const dir = mkdtempSync(join(tmpdir(), 'lawn-render-'));
  const entries = [];
  let put = 0;

  const startedAt = new Date();
  const slug = runSlug({
    at: startedAt,
    models: [meta.model || 'detector'],
    suffix: meta.size ? `${meta.size}px` : '',
  });
  const keys = runKeys(slug);

  try {
    for (const [n, r] of best.rows.entries()) {
      const L = r.lawn;
      if (!L.photo || !r.predicted) continue;

      /*
       * Traced first, with the app's own tolerance and vertex cap, because the
       * picture is meant to answer "how long would this take to correct by
       * hand" -- and that is a question about the shape the drawing tools would
       * receive, not about the mask behind it.
       */
      /*
       * TRACED ON THE SCORING GRID, DRAWN BIGGER, and the reason is simply
       * that THERE IS NO FINER MASK TO TRACE.
       *
       * runFold answers one value per grid cell, so `r.predicted` is a 512x512
       * array and that is the entire resolution of the model's opinion.
       * Tracing an upsampled copy would not find more shape; it would find the
       * staircase the upsample invented, and report those as handles somebody
       * would have to drag.
       *
       * (An earlier version of this comment said the reason was that
       * TRACE_TOLERANCE_M is calibrated at 512. That is wrong.
       * tracePrediction converts the tolerance through `mpp`, so the smoothing
       * stays the same distance in METRES at any grid size. The tolerance was
       * never the obstacle; the mask's own resolution is.)
       *
       * The rings are scaled up afterwards purely for drawing.
       */
      const G = L.grid || GRID;
      const GH = L.gridH || G;
      const trace = tracePrediction({
        predicted: r.predicted, within: L.within, grid: G, gridH: GH, mpp: L.mpp,
      });
      const PX = renderPx();
      const PY = Math.max(1, Math.round((PX * GH) / G));
      const scale = PX / G;
      const bigRings = trace.rings.map((ring) => ring.map(([x, y]) => [x * scale, y * scale]));
      const bigPhoto = L.photoBig || L.photo;
      const big = (m) => {
        if (!m || (PX === G && PY === GH)) return m;
        const out = new Uint8Array(PX * PY);
        for (let y = 0; y < PY; y++) {
          const sy = Math.min(GH - 1, Math.floor(y / scale));
          for (let x = 0; x < PX; x++) {
            out[y * PX + x] = m[sy * G + Math.min(G - 1, Math.floor(x / scale))];
          }
        }
        return out;
      };

      /*
       * STAGE 3'S ADDITIONS, where this row has a stage 3: every cell the
       * rules put back under the canopy that stage 1 (cleared) did not claim.
       * Painted amber on both pictures, so "was that the detector or the
       * guesser" can be answered by looking.
       */
      let added = null;
      if (r.base) {
        added = new Uint8Array(r.predicted.length);
        for (let i = 0; i < added.length; i++) added[i] = r.predicted[i] && !r.base[i] ? 1 : 0;
      }

      const pixels = drawPrediction({
        photo: bigPhoto,
        truth: big(L.truth),
        within: big(L.within),
        inferred: big(L.inferred),
        rings: bigRings,
        added: big(added),
        grid: PX,
        gridH: PY,
      });

      /*
       * AND THE SAME ANSWER BEFORE THE TRACER TOUCHED IT, which is the other
       * half of the toggle on the page. Drawn from the same photograph with
       * the same green wash so the two flip cleanly between each other -- only
       * the model's own layer differs.
       */
      const rawPixels = drawPrediction({
        photo: bigPhoto,
        truth: big(L.truth),
        within: big(L.within),
        inferred: big(L.inferred),
        mask: big(r.predicted),
        added: big(added),
        grid: PX,
        gridH: PY,
      });

      /*
       * EVERY LAYER ON ITS OWN (owner, 2026-09-26), for the page's switches:
       * the photograph once, and one tall image holding a transparent frame
       * per layer in LAYERS order. See drawLayers.
       */
      const clipTo = (m) => {
        if (!m || !L.within) return m;
        const o = new Uint8Array(m.length);
        for (let i = 0; i < m.length; i++) o[i] = m[i] && L.within[i] ? 1 : 0;
        return o;
      };
      let vetoed = null;
      if (r.preVeto) {
        vetoed = new Uint8Array(r.predicted.length);
        for (let i = 0; i < vetoed.length; i++) vetoed[i] = r.preVeto[i] && !r.predicted[i] ? 1 : 0;
      }
      const layered = drawLayers({
        photo: bigPhoto,
        within: big(L.within),
        grid: PX,
        gridH: PY,
        rings: bigRings,
        masks: {
          truth: big(clipTo(L.truth)),
          inferred: big(clipTo(L.inferred)),
          canopy: big(L.canopy),
          lidarCanopy: big(L.lidarCanopy),
          naipCanopy: big(L.naipCanopy),
          roof: big(L.roof),
          void: big(L.void),
          mask: big(clipTo(r.predicted)),
          added: big(clipTo(added)),
          vetoed: big(clipTo(vetoed)),
          edgeAdded: big(clipTo(r.edgeAdded)),
          edgeRemoved: big(clipTo(r.edgeRemoved)),
          line: big(L.within),
        },
      });

      /* Named by position, not by map id. The id contains the coordinates of
         somebody's house, and a bucket key is not the place for those. */
      const key = keys.shapes(n);
      const maskKey = keys.mask(n);
      const photoKey = keys.photo(n);
      const layersKey = keys.layers(n);
      const write = (pix, name, h = PY) => {
        const png = new PNG({ width: PX, height: h });
        png.data = Buffer.from(pix.buffer, pix.byteOffset, pix.length);
        const file = join(dir, name);
        writeFileSync(file, PNG.sync.write(png));
        return file;
      };

      try {
        for (const [k, pix, name, h] of [
          [key, pixels, `${n}.png`, PY],
          [maskKey, rawPixels, `${n}-mask.png`, PY],
          [photoKey, layered.photo, `${n}-photo.png`, PY],
          [layersKey, layered.sprite, `${n}-layers.png`, PY * LAYERS.length],
        ]) {
          execFileSync('npx', [
            'wrangler', 'r2', 'object', 'put', `${bucket}/${k}`,
            '--file', write(pix, name, h), '--content-type', 'image/png', '--remote',
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
        }
        put++;
      } catch (e) {
        console.log(`  could not upload ${key}: `
          + `${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 90)}`);
        continue;
      }

      /*
       * THE NUMBERS ARE ASKED OF THE OUTLINE, not of the mask behind it.
       *
       * A reader spotted the difference: a caption said 17.8% of the inferred
       * ground was missed under a picture whose outline covered that ground
       * completely. Both were right -- the tracer fills any hole under about
       * 60 sq ft, which is wanted, and the caption was describing the other
       * object. So these come from the traced polygon rasterised back.
       *
       * r.mine.errorPct stays on the raw mask: it is the run's own figure,
       * the one the table sorts by and the findings file quotes.
       */
      const traced = traceMask({ shapes: trace.shapes, within: L.within, grid: G, gridH: GH });
      const counts = mistakeCounts({
        truth: L.truth, predicted: traced, within: L.within, inferred: L.inferred,
      });
      const drift = traceDrift({ predicted: r.predicted, traced, within: L.within });
      const sqft = (px) => (px * L.mpp * L.mpp) / SQM_PER_SQFT;
      entries.push({
        key,
        /* The same lawn, as the model actually answered it. The page flips
           every picture between the two at once. */
        maskKey,
        /* The photograph and the stacked layers (LAYERS order, one frame each). */
        photoKey,
        layersKey,
        county: L.county || null,
        tag: L.tag || null,
        /* The address point, "lat, lng" on the card, for pasting into other
           map tools. The index is served only to the signed-in owner. */
        ...(coordsOfId(L.id) || {}),
        squareFeet: Math.round(sqft(L.truthPx)),
        errorPct: Number(r.mine.errorPct.toFixed(1)),
        /* The same count for the outline in the picture, which is what the
           owner reads a picture as (B01: 10.8% on the mask, drawn all but
           perfectly). The table stays on the mask. */
        outlineErrorPct: (() => { const c = compare(traced, L.truth, L.within).errorPct; return c === null ? null : Number(c.toFixed(1)); })(),
        samErrorPct: r.theirs ? Number(r.theirs.errorPct.toFixed(1)) : null,
        foundPct: counts.foundPct === null ? null : Number(counts.foundPct.toFixed(1)),
        overPct: counts.overPct === null ? null : Number(counts.overPct.toFixed(1)),
        missedInferredPct: counts.missedInferredPct === null
          ? null : Number(counts.missedInferredPct.toFixed(1)),
        inferredPct: Number(L.inferredPct.toFixed(1)),
        mpp: Number(L.mpp.toFixed(3)),
        /* Cells across this lawn's grid: 15 cm a cell between 512 and 1024,
           so the cm figure above is the cell, and this says whether the cap
           was what decided it. */
        gridPx: G,
        gridPy: GH,
        renderPy: PY,
        /* How big the published picture is, so the page knows whether opening
           it full size gains anything. */
        renderPx: PX,
        /*
         * THE EDITING COST, which is what this page is really for. Pieces and
         * handles are what a person would be dragging; the dropped count is
         * what the tracer binned before they ever saw it, and a model whose
         * answer is mostly speckle looks deceptively tidy without it.
         */
        pieces: trace.pieces,
        vertices: trace.vertices,
        droppedPieces: trace.droppedPieces,
        droppedSqFt: Math.round(sqft(trace.droppedPx)),
        /*
         * How far the outline drifted from the mask it was traced from, both
         * ways. Tidying is the tracer's job and mostly an improvement, but it
         * makes a picture look better than the model is -- so the amount is
         * reported rather than left to be discovered by someone comparing a
         * caption with a shape.
         */
        filledSqFt: Math.round(sqft(drift.added)),
        trimmedSqFt: Math.round(sqft(drift.removed)),
      });
    }

    if (!entries.length) {
      console.log('\nNothing could be drawn -- no lawn kept both a photograph and an answer.');
      return;
    }

    /* Worst first. The top of the page should be the failures; a gallery
       sorted by id buries them among the ones that worked. */
    entries.sort((a, b) => b.errorPct - a.errorPct);

    /*
     * EVERY KNOB THAT WAS TURNED, recorded beside the pictures rather than
     * left in a workflow log that expires. A picture without its settings is
     * the exact failure docs/DETECTOR-FINDINGS.md exists to prevent -- a
     * result recalled without its corpus is not a result -- and these outlive
     * the run that made them by design now.
     */
    const settings = {
      model: meta.model || null,
      sizePx: meta.size || null,
      config: best.cfg.name,
      features: using,
      lawns: lawns.length,
      /* The scoring grid follows metres since 2026-09-23: CELL_M a cell,
         floored at GRID and capped at GRID_MAX. The range is what this run
         actually used; `capped` is how many lawns hit the ceiling and so are
         coarser than the cell size says. */
      gridPx: cellMetres() ? null : GRID,
      cellM: cellMetres() || null,
      gridMin: Math.min(...lawns.map((L) => L.grid || GRID)),
      gridMax: Math.max(...lawns.map((L) => L.grid || GRID)),
      gridCapped: cellMetres()
        ? lawns.filter((L) => (L.grid || GRID) >= GRID_MAX && L.mpp > cellMetres() * 1.001).length
        : null,
      /* Whether the backbone read big lots in windows or squeezed them
         whole -- the extractor's manifest says, and it belongs beside the
         pictures because it is the other half of what this run varied. */
      windowedLawns: meta.windowed ?? null,
      aerialEye: Boolean(meta.aerialEye),
      noBackbone: Boolean(meta.noBackbone),
      medianErrorPct: Number(best.med.toFixed(1)),
    };

    const indexFile = join(dir, 'index.json');
    writeFileSync(indexFile, `${JSON.stringify({
      drawnAt: new Date().toISOString(),
      slug,
      config: best.cfg.name,
      features: using,
      /* WHAT THIS RUN WAS FOR, in the words of whoever started it. The
         settings say what was different; only this says what the difference
         was meant to prove. */
      about: RUN_ABOUT,
      /* The layers in each lawn's `layersKey`, top frame first, with the
         colour and whether the page shows it until told otherwise. */
      layers: LAYERS.map(({ id, label, colour, on }) => ({ id, label, colour, on })),
      settings,
      lawns: lawns.length,
      medianErrorPct: Number(best.med.toFixed(1)),
      /*
       * THE ONE CAVEAT THAT MUST TRAVEL WITH THE PICTURES. Every answer here
       * is from a model that had never seen the lawn it was drawing -- that
       * is what makes it an honest measurement and it is NOT what a published
       * model would draw for a new address. Carried in the file rather than
       * only on the page, so it cannot be separated from the thing it
       * qualifies.
       */
      note: 'Leave-one-out: each lawn was drawn by a model trained on the other '
        + `${lawns.length - 1} and never shown this one. "Shapes" is the traced `
        + 'polygon the drawing tools would receive; "raw mask" is what the model '
        + 'actually answered, before smoothing, hole-filling and speckle removal.'
        + (best.cfg.stage3
          ? ' AMBER is what stage 3 put back under the canopy; red is what the detector itself said.'
          : ''),
      entries,
    }, null, 1)}\n`);

    execFileSync('npx', [
      'wrangler', 'r2', 'object', 'put', `${bucket}/${keys.index}`,
      '--file', indexFile, '--content-type', 'application/json', '--remote',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    /* THE PICKER LAST. A run appears in the list only once everything it
       points at is already in the bucket. */
    const list = publishRunList(bucket, dir, runRow({
      slug,
      at: startedAt,
      title: `${meta.model || 'detector'}${meta.size ? ` ${meta.size}px` : ''}`,
      about: RUN_ABOUT,
      settings,
      lawns: entries.length,
      headline: Number(best.med.toFixed(1)),
    }));

    console.log(`\nDrew ${put} of ${best.rows.length} lawns under "${best.cfg.name}".`);
    console.log(`Folder: ${keys.index.replace('/index.json', '')}`);
    console.log(`The page now lists ${list.runs} run${list.runs === 1 ? '' : 's'}.`);
    console.log('Open /predictions.html to see the outlines it drew, worst first,');
    console.log('and the button at the top to flip every picture to the raw mask.');
  } catch (e) {
    console.log(`\nCould not publish the renderings: `
      + `${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 120)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

  console.log(`${rows.length} approved map${rows.length === 1 ? '' : 's'} with a stored photograph: `
    + `${lawnSetDescription()}.\n`);

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
  /*
   * THE PYTHON PATH, when it has been run.
   *
   * A directory of patch grids, one per lawn, keyed by the same id the
   * photographs were saved under. Read before the lawns are gathered so a
   * missing extractor is reported once rather than twenty times.
   */
  const pyDir = process.env.FEATURES_DIR || '';
  const py = pyDir ? readPythonFeatures(pyDir) : null;
  /* The canopy masks, when workflow 14 ran the tree model first. See where
     each lawn's `inferred` is built for what they are used for. */
  const canopyDir = process.env.CANOPY_DIR || '';
  /* "lawn": canopy is unseen only where the tracer drew lawn. "all": every
     canopy cell is unseen, which H27 measured and the pictures argued against. */
  const canopyMode = process.env.CANOPY_MODE === 'all' ? 'all' : 'lawn';
  let canopied = 0;
  /* Workflow 23's height layers, for stage 3's woods rule (H34). */
  const lidarDir = process.env.LIDAR_DIR || '';
  let lidared = 0;
  if (pyDir && !py) {
    console.log(`No features found in ${pyDir}. Run the extractor first, or`);
    console.log('unset FEATURES_DIR to fall back to the in-browser backbone.');
    process.exitCode = 1;
    return;
  }
  if (py) {
    const any = [...py.grids.values()][0];
    const all = [...py.grids.values()];
    const windowed = all.filter((g) => g.windows > 1).length;
    const seen = all.map((g) => g.mpp).filter((m) => Number.isFinite(m) && m > 0);
    console.log(`Features from ${py.manifest.model} at ${py.manifest.size}px:`);
    console.log(`${py.grids.size} lawns, ${any?.dim} numbers a patch.`);
    /*
     * HOW THE MODEL READ THEM, said here because the old sentence -- "one pass
     * over the whole property, every patch saw all of it" -- was true and was
     * the problem: one pass over a 319 m lot at 896 px is 36 cm a pixel.
     */
    if (windowed) {
      console.log(`${windowed} of them too big to read at the target in one pass, so read in`);
      console.log('overlapping windows at the photograph\'s own resolution and stitched.');
    } else {
      console.log('Every one read in a single pass at the target or finer.');
    }
    if (seen.length) {
      console.log(`The coarsest any lawn reached the model: ${(Math.max(...seen) * 100).toFixed(1)} cm a pixel.\n`);
    } else {
      console.log('');
    }
  }

  let eye = null;
  if (!py && process.env.NO_BACKBONE !== 'true') {
    const t = Date.now();
    try {
      eye = await loadBackbone();
      console.log(`Pretrained eye loaded in ${((Date.now() - t) / 1000).toFixed(1)}s.`);
    } catch (e) {
      console.log('The pretrained eye would not load, so this is colour and');
      console.log(`texture only: ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  } else if (!py) {
    console.log('NO_BACKBONE is set, so this is colour and texture only.');
  }
  const using = (py
    ? `colour, texture and ${py.manifest.model} at ${py.manifest.size}px`
    : eye ? 'colour, texture and a pretrained eye (tiled, 224px)'
      : 'colour and texture only')
    + (process.env.PREDICTIONS_DIR || process.env.PREDICTIONS_DIRS
      ? ', and a decoder over the eye\'s full grid' : '');

  /*
   * HAS THIS EYE EVER SEEN THE GROUND FROM ABOVE?
   *
   * The advice at the bottom of this file used to answer that with a
   * hard-coded "no". It was written when DINOv2 was the only option and it
   * said, of any backbone that lost to colour, that "these models learn from
   * photographs taken from the ground; a view straight down is not what they
   * know." True of DINOv2. Flatly false of Scale-MAE, which was pretrained on
   * satellite imagery and is handed the ground distance of a pixel -- and it
   * printed that sentence anyway, about a run that had just proved the
   * opposite by closing most of the gap it was explaining away.
   *
   * A diagnosis that cannot see what it is diagnosing is worse than none: it
   * reads as a finding and it is a leftover.
   */
  const aerialEye = /scalemae|satlas|prithvi|satmae|croma|dofa/i.test(
    String(py?.manifest?.model || '')
  );
  console.log('');

  /* The projection is made once, on first use, and reused for every lawn and
     both scales. Fitting a different one per lawn would put each lawn's
     features in its own coordinate system, and the head would be learning
     nineteen languages at once. */

  /* ---------------------------------------------------- gather the lawns */
  const dir = mkdtempSync(join(tmpdir(), 'lawn-'));
  const lawns = [];
  /* Lawns the run wanted and did not get. See FETCH_TRIES: this is the
     difference between two tables that otherwise look comparable. */
  const missing = [];
  try {
    for (const row of rows) {
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
      if (!frame || !truthGeoms.length) continue;

      const img = fetchImage(bucket, row.image_key, dir, decoders);
      if (!img.ok) {
        console.log(`  skipped ${row.id.slice(0, 28)} -- ${img.reason}`);
        missing.push(row.id.slice(0, 28));
        continue;
      }

      /* This lawn's own grid: 15 cm a cell, between the floor and the cap. */
      const { w: G, h: GH } = gridDims(frame);
      const rgb = resize(img.data, img.width, img.height, img.channels, G, GH);
      const truth = maskOf(truthGeoms, frame, G, GH);
      /* Where both layers cover a pixel it counts as INFERRED -- the narrower,
         later mark is the more careful one. See inferredShare above for why,
         and for what stands in for the guard that rule used to be. */
      const inferredGeoms = inferredGeometries(parse(row.shapes));
      let inferred = inferredGeoms.length ? maskOf(inferredGeoms, frame, G, GH) : null;
      /*
       * AND THE CANOPY, WHEN A RUN BRINGS ONE. The tree model's mask
       * (tools/tree-canopy.py) is a better record of what the camera could
       * not see than the hand-drawn "inferred" marks: it is drawn per pixel
       * by a model built for the job, and the marks are a person's guess at
       * where a canopy edge is. Merged into `inferred` rather than kept
       * separate, because both mean the same thing here -- ground nobody
       * could see -- and every reader below already knows what to do with
       * it: the seen column scores outside it, the seen-only rows and the
       * decoder do not train on it. It is NEVER a "not lawn" label; see
       * seenOnlyTwin for why zero would be the wrong answer.
       */
      /*
       * BUT ONLY WHERE THE TRACER DREW LAWN, unless CANOPY_MODE=all. The
       * first run (H27) made EVERY canopy cell don't-care, and the owner saw
       * what that did in the pictures: the lawn's edge crept into the woods.
       * Woods the tracer never drew were the decoder's only weighted
       * examples of "not lawn under trees", and making them don't-care threw
       * those lessons away. The tracer's own marks already say "probably
       * grass under these edge trees, not deeper in"; what the canopy mask
       * adds is the case where the traced lawn runs under a tree the tracer
       * did not mark. So: canopy over traced lawn (marked or not) is unseen;
       * canopy the tracer left out stays what they said it was, not lawn.
       */
      let canopyRaw = null;
      if (canopyDir) {
        const file = join(canopyDir, `${row.id}-mask.png`);
        const canopy = existsSync(file)
          ? canopyMask(decoders.png.PNG.sync.read(readFileSync(file)), G, GH) : null;
        if (canopy) {
          canopyRaw = canopy;
          inferred = inferred || new Uint8Array(G * GH);
          for (let i = 0; i < canopy.length; i++) {
            if (canopy[i] && (canopyMode === 'all' || truth[i])) inferred[i] = 1;
          }
          canopied++;
        }
      }
      /*
       * THE LIDAR'S CANOPY HEIGHT, where workflow 23's reader ran over these
       * frames (LIDAR_DIR). Stage 3's woods rule (H34) is the only reader;
       * nothing is trained on it. Missing is not an error: three benchmark
       * lawns have no point cloud over them and read as they did before.
       */
      let height = null;
      /*
       * AND WHAT IT SAYS OUTRIGHT (H38): a roof (no ground return, 2.5 m up,
       * flat) or a void (nothing back over 6 m, or water). Neither can be
       * lawn whatever the photograph shows, so they veto lawn after stage 3.
       * Measured before use: 0.2 / 0.5% of lawn cells under roof, 0.0% under
       * void, against 26% and 0.7% of the visible not-lawn.
       */
      let roof = null;
      let voidMask = null;
      /* The lidar's canopy and NAIP-CHM's (H38, H41), for the canopy row and
         the pictures. NAIP is read over every frame, lidar or not. */
      let lidarCanopy = null;
      let naipCanopy = null;
      if (lidarDir) {
        const file = join(lidarDir, `${row.id}-height.png`);
        if (existsSync(file)) {
          height = heightMask(decoders.png.PNG.sync.read(readFileSync(file)), G, GH);
          if (height) lidared++;
        }
        const read = (name) => {
          const f = join(lidarDir, `${row.id}-${name}.png`);
          return existsSync(f) ? canopyMask(decoders.png.PNG.sync.read(readFileSync(f)), G, GH) : null;
        };
        roof = read('roof');
        voidMask = read('void');
        lidarCanopy = read('lidar-canopy');
        naipCanopy = read('naip-canopy');
      }
      const parcelGeom = parse(row.parcel);
      /*
       * No property line means the whole frame is fair game. Rare, and the
       * alternative -- dropping the row -- would throw away a hand-traced lawn
       * for the sake of tidiness.
       */
      const within = parcelGeom ? maskOf([parcelGeom], frame, G, GH) : null;

      let truthPx = 0;
      for (let i = 0; i < truth.length; i++) if (truth[i] && (!within || within[i])) truthPx++;
      if (!truthPx) {
        console.log(`  skipped ${row.id.slice(0, 28)} -- no lawn inside the property line`);
        continue;
      }

      lawns.push({
        id: row.id,
        tag: lawnTag(row.id),
        county: row.county,
        /* The frame the photograph was taken on, for scale.json's boxes. */
        frame,
        /* How NAIP lines up here, if the editor set it (tools/naip_bands.py). */
        naipAlign: parse(row.naip_align),
        /* Cells across and down. Everything below for this lawn is on this grid. */
        grid: G,
        gridH: GH,
        /*
         * Kept only for DUMP_FRAMES, and resized from the ORIGINAL pixels
         * rather than from the 512 grid beside it. Going 512 -> 896 would be
         * an upscale of something already thrown away; this is one
         * box-average, downward, from what R2 actually holds.
         */
        /*
         * Zero means "as stored", which skips the resize entirely rather than
         * asking for the size it already is -- one fewer pass over a 5,000
         * pixel image, and no rounding at all.
         */
        dump: process.env.DUMP_FRAMES
          ? resize(img.data, img.width, img.height, img.channels, ...dumpDims(img.width, img.height))
          : null,
        dumpW: process.env.DUMP_FRAMES ? dumpDims(img.width, img.height)[0] : 0,
        dumpH: process.env.DUMP_FRAMES ? dumpDims(img.width, img.height)[1] : 0,
        /* What R2 actually holds, before any resize. See framePixels(). */
        storedPx: img.width,
        storedPy: img.height,
        canopy: row.tree_line === null || row.tree_line === undefined ? null : Number(row.tree_line),
        /*
         * The photograph itself, at the grid everything is measured on, kept
         * only when the run is going to draw on it. It is the same pixels the
         * features came from, so a rendering shows what the model actually
         * saw rather than a prettier copy of it.
         */
        photo: renderWanted ? rgb : null,
        /* AND A BIGGER COPY FOR THE PICTURE. The scored one is at GRID, which
           is where every number comes from; this is what gets drawn, so a
           reader zooming in sees the photograph rather than 512 soft pixels. */
        photoBig: renderWanted && renderPx() !== G
          ? resize(img.data, img.width, img.height, img.channels,
            renderPx(), Math.max(1, Math.round((renderPx() * GH) / G)))
          : null,
        /* Held raw: each fold standardises against its own training lawns. */
        /* The windows are distances on the ground, so this frame's scale goes
           in with the pixels -- see FINE_M in lib/features.js. */
        cheap: imageFeatures(rgb, G, GH, { mpp: metresPerPixel(frame, G) }),
        /*
         * Kept at the model's full width. Projecting here would fix the
         * squeeze at one size, and how much the squeeze costs is one of the
         * things the configurations below are there to find out.
         */
        /*
         * One grid from Python, or two from the tiled ONNX path. Never both:
         * the Python pass already saw the whole frame, so a coarse copy would
         * be a blurrier version of what it is sitting next to.
         */
        fineFull: py ? (py.grids.get(row.id) || null)
          : eye ? await tiledFeatures(eye, rgb, G, GH, { tiles: FINE_TILES }) : null,
        coarseFull: py ? null
          : eye ? await tiledFeatures(eye, rgb, G, GH, { tiles: COARSE_TILES }) : null,
        truth,
        within,
        /*
         * Where the sharp boundaries and the hard-rimmed shade are. A property
         * of the photograph and the hand-traced outline, so it is computed
         * once here rather than six times per lawn inside the scoring loop.
         * Filled in below, once `within` and `cheap` both exist.
         */
        classes: null,
        /* Where the reviewer said "I know, I cannot see it". Null until some
           map has been marked, and null means every pixel counts as seen. */
        inferred,
        /* The tree model's mask on its own, for stage 3 (tools/stage3.js),
           which reasons about canopy as canopy rather than as unseen ground. */
        canopy: canopyRaw,
        /* And the lidar's height above ground in metres, for its woods rule. */
        height,
        /* Roof and void, for the veto (H38). Null without a point cloud. */
        roof,
        void: voidMask,
        lidarCanopy,
        naipCanopy,
        /*
         * THE TREE MODEL'S CANOPY PLUS WHAT TWO OTHER INSTRUMENTS AGREE IT
         * MISSED (H41): cells the lidar (2011-2020) AND NAIP-CHM (2021-2023)
         * both call canopy, and on a lawn with no point cloud NAIP-CHM alone.
         * Used only by stage 3 in the "lidar ∩ NAIP canopy" row; training and
         * scoring still use the tree model's, so every column stays comparable.
         */
        canopyPlus: canopyPlus(canopyRaw, lidarCanopy, naipCanopy),
        inferredPct: 100 * inferredShare(truth, inferred, within),
        truthPx,
        mpp: metresPerPixel(frame, G),
        detected: row.detected_shapes
          ? maskOf(geometries(parse(row.detected_shapes)), frame, G, GH) : null,
        /*
         * WHICH DETECTOR DREW THE OUTLINE THIS LAWN IS SCORED AGAINST.
         *
         * "SAM, on the same N lawns" is the line every number in
         * docs/DETECTOR-FINDINGS.md is measured against, and it was an
         * assumption rather than a reading: the baseline is whatever sits in
         * `detected_shapes`, and that is whatever method the tracer happened to
         * press. There is a free land-cover method now, so a corpus can carry a
         * mix -- and a mixed baseline quietly relabels the line to beat while
         * every table above it still says SAM.
         *
         * Kept per lawn and reported in one line below. It changes no
         * arithmetic; it stops the arithmetic being read as something it is not.
         */
        drawnBy: row.model || null,
        run: `${row.model || 'no model'} / ${row.mode || 'no mode'}`,
      });
      /*
       * The sharp-boundary and hard-shade classes, once, now that the lawn is
       * built. See tools/boundary.js for what they are and what they are not:
       * this finds sharp edges, of which driveways and paths are the common
       * case, and it does not find driveways.
       */
      {
        const L = lawns[lawns.length - 1];
        L.classes = classesFor({
          cheap: L.cheap, truth: L.truth, within: L.within, grid: L.grid, gridH: L.gridH,
        });
      }

      process.stdout.write(`  read ${lawns.length}/${rows.length}\r`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${lawns.length} usable.`);
  /* The legend for B01..B32, once a run, with the scorer's own square feet. */
  if (lawns.some((L) => L.tag)) {
    const named = lawns.filter((L) => L.tag).sort((a, b) => a.tag.localeCompare(b.tag));
    console.log('Benchmark names (worker/src/benchmark-ids.js):');
    for (let i = 0; i < named.length; i += 2) {
      console.log(named.slice(i, i + 2).map((L) => {
        const ft = Math.round((L.truthPx * L.mpp * L.mpp) / SQM_PER_SQFT).toLocaleString();
        return `  ${lawnName(L).padEnd(26).slice(0, 26)} ${ft.padStart(8)} sq ft`;
      }).join('    '));
    }
  }
  if (canopyDir) {
    console.log(`Canopy from ${canopyDir} merged into the unseen ground of ${canopied} of ${lawns.length} lawns`
      + (canopyMode === 'all' ? ' (EVERY canopy cell):' : ' (only where the tracer drew lawn):'));
    console.log('the SEEN column scores outside it and the decoder does not train on it.');
    if (!canopied) console.log('(No masks found -- was the canopy step run over these frames?)');
  }
  if (lidarDir) {
    console.log(`Lidar height from ${lidarDir} on ${lidared} of ${lawns.length} lawns, for stage 3's woods rule only.`);
    if (!lidared) console.log('(No height layers found -- was the lidar step run over these frames?)');
  }
  console.log('');

  /*
   * WRITE THE FRAMES OUT AND STOP, when asked.
   *
   * The Python extractor reads pictures from a directory. This is the step
   * that puts them there, at exactly the grid everything else is measured on,
   * so the patch grid it returns lines up with the outlines without anybody
   * having to reconcile two resizes.
   *
   * Named by the row id, which is what the reader keys on later.
   */
  if (process.env.DUMP_FRAMES) {
    const dest = process.env.DUMP_FRAMES;
    const asked = dumpSize();
    mkdirSync(dest, { recursive: true });

    /*
     * EACH FRAME AT ITS OWN SIZE, because since workflow 21 the stored
     * photographs are not all one size -- a small garden is 1280 px and a
     * re-banked 319 m lot is 3192. Writing them all at one width was what
     * threw the re-banking away the first time it was tried.
     *
     * The side comes from the buffer rather than from a variable, so it cannot
     * disagree with the pixels it describes.
     */
    const sides = [];
    for (const L of lawns) {
      const side = Math.max(L.dumpW, L.dumpH);
      sides.push(side);
      const png = new decoders.png.PNG({ width: L.dumpW, height: L.dumpH });
      png.data = Buffer.from(L.dump.buffer, L.dump.byteOffset, L.dump.byteLength);
      writeFileSync(join(dest, `${L.id}.png`), decoders.png.PNG.sync.write(png));
      /*
       * AND WHAT THE TRACER SAID ABOUT IT, on the scoring grid, for the
       * decoder (tools/train_decoder.py): the traced lawn, the property line
       * and the "inferred, not seen" marks, one channel each. The same masks
       * the head is trained and scored on, written from the same arrays, so
       * the decoder cannot be graded against a different outline.
       */
      writeFileSync(join(dest, `${L.id}-labels.png`), labelsPng(L, decoders.png.PNG));
    }
    /*
     * The ground truth of the pictures, for any model that asks what scale it
     * is looking at. Written next to them rather than inside them because a
     * PNG has nowhere honest to put it.
     */
    writeFileSync(
      join(dest, 'scale.json'),
      JSON.stringify({
        frames: frameSpans(lawns),
        /* Where each frame IS, in Web Mercator metres, for the lidar reader. */
        boxes: frameBoxes(lawns),
        /* NAIP's alignment where the editor set one; the rest are aligned by
           tools/naip_bands.py against the photograph. */
        naipAlign: Object.fromEntries(lawns.filter((L) => L.naipAlign).map((L) => [L.id, L.naipAlign])),
        /* B01..B32, for the Python readers' tables (worker/src/benchmark-ids.js). */
        tags: Object.fromEntries(lawns.filter((L) => L.tag).map((L) => [L.id, L.tag])),
        /* Metres DOWN each frame, which since the crop is not the same as
           across it. */
        downs: Object.fromEntries(lawns.map((L) => [L.id, L.mpp * (L.gridH || L.grid || GRID)])),
        storedPx: framePixels(lawns),
        storedPy: Object.fromEntries(lawns.filter((L) => L.storedPy).map((L) => [L.id, L.storedPy])),
      }, null, 1),
    );

    const spans = lawns.map((L) => L.mpp * Math.max(L.grid || GRID, L.gridH || 0));
    const cm = lawns.map((L, i) => (100 * L.mpp * Math.max(L.grid || GRID, L.gridH || 0)) / sides[i]);
    console.log(`Wrote ${lawns.length} frames to ${dest}, `
      + `${Math.min(...sides)}-${Math.max(...sides)} px each`
      + `${asked ? ` (DUMP_SIZE=${asked})` : ' (as stored)'},`);
    console.log(`covering ${Math.min(...spans).toFixed(0)}-${Math.max(...spans).toFixed(0)} m of ground`);
    console.log(`at ${Math.min(...cm).toFixed(1)}-${Math.max(...cm).toFixed(1)} cm a pixel, `
      + 'and scale.json beside them.');

    /*
     * AND WHETHER ANY FRAME WAS BLOWN UP PAST ITS OWN PHOTOGRAPH, which adds
     * pixels and no detail and would make every resolution figure downstream
     * optimistic. Said here because this is where the inflation happens, and
     * because a fixed DUMP_SIZE has now twice been left behind by a change to
     * what R2 holds.
     */
    const storedLong = (L) => Math.max(L.storedPx || 0, L.storedPy || 0);
    const inflated = lawns.filter((L, i) => storedLong(L) && sides[i] > storedLong(L)).length;
    const shrunk = lawns.filter((L, i) => storedLong(L) && sides[i] < storedLong(L)).length;
    if (inflated) {
      console.log(`\n${inflated} frames were written BIGGER than the photograph R2 holds,`);
      console.log('so they carry no more detail than they arrived with. scale.json');
      console.log('records the real size so nothing downstream is fooled.');
    }
    if (shrunk) {
      console.log(`\n${shrunk} frames were written SMALLER than R2 holds, which throws`);
      console.log('away resolution before the model sees it. That is H20 all over');
      console.log('again -- unset DUMP_SIZE to write them as stored.');
    }
    if (!inflated && !shrunk) {
      console.log('\nEvery frame was written at exactly what R2 holds: nothing');
      console.log('inflated, nothing thrown away.');
    }
    console.log('Run the extractor over them, then run this again with');
    console.log('FEATURES_DIR pointing at what it produced.');
    return;
  }

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

  const hasEye = Boolean(eye) || Boolean(py);
  const scales = py ? 1 : 2;
  const any = py ? [...py.grids.values()][0] : null;
  const runnable = CONFIGS.filter((c) => rowWidth(c, hasEye, scales) > 0
    && (!c.backbone || hasEye));

  /*
   * AND THE SEEN-ONLY TWINS, when asked for and when there is anything to
   * separate.
   *
   * Off by default because it doubles the run, and pointless when no map has
   * been marked -- with nothing inferred, a twin is a byte-identical copy of
   * its original and half the run would be spent proving that.
   */
  const twinsWanted = /^(1|true|yes)$/i.test(String(process.env.SEEN_ONLY_TWINS || ''));
  const anyMarked = lawns.some((L) => L.inferred);
  if (twinsWanted && anyMarked) {
    runnable.push(...runnable.slice().map(seenOnlyTwin));
    console.log(`Also training ${runnable.length / 2} seen-only twins: the same rows `
      + 'with ground nobody could see dropped from the sample.\n');
  } else if (twinsWanted) {
    console.log('No map has any inferred marks, so a seen-only twin would be an '
      + 'identical copy. Skipped.\n');
  }
  const table = [];

  /*
   * The ring's squeeze is the same width whatever the centre's is, so it is
   * made once here rather than rebuilt per configuration. Sixteen ring points
   * per pixel means this one gets read a lot.
   */
  if (hasEye && runnable.some((c) => c.ring && c.backbone)) {
    for (const L of lawns) L.ring = L.fineFull ? shrink(L.fineFull, RING_DIMS) : null;
  }

  /* One fold's verdict as a table row, the same shape for every source. */
  const foldRow = (held, f) => ({
    lawn: lawns[held], mine: f.mine, theirs: samScores[held],
    collapsed: f.collapsed, darkPct: f.darkPct, brightPct: f.brightPct,
    seenPct: f.seenPct, guessPct: f.guessPct,
    crispEdgePct: f.crispEdgePct, softEdgePct: f.softEdgePct,
    hardShadePct: f.hardShadePct, softShadePct: f.softShadePct,
    interiorPct: f.interiorPct,
    /* The held-out answer itself, for RENDER_PREDICTIONS. Kept only when
       asked: twenty-three masks per configuration is memory spent on
       something most runs never look at. */
    predicted: renderWanted ? f.predicted : null,
  });

  /* The rows of one configuration, summarised into its line of the table. */
  const summarise = (cfg, rows, width) => {
    const med = median(rows.map((r) => r.mine.errorPct));
    const paired = rows.filter((r) => r.theirs);
    const wins = paired.filter((r) => r.mine.errorPct < r.theirs.errorPct).length;
    const collapsed = rows.filter((r) => r.collapsed).length;
    const dark = median(rows.map((r) => r.darkPct).filter((v) => v !== null));
    const bright = median(rows.map((r) => r.brightPct).filter((v) => v !== null));
    const seen = median(rows.map((r) => r.seenPct).filter((v) => v !== null));
    const guess = median(rows.map((r) => r.guessPct).filter((v) => v !== null));
    const mid = (key) => {
      const vs = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
      return vs.length ? median(vs) : null;
    };
    console.log(`   ${med.toFixed(1)}% out on the middle lawn, better than SAM on ${wins} of ${paired.length}.\n`);
    return {
      cfg, med, wins, of: paired.length, rows, width, collapsed, dark, bright, seen, guess,
      crispEdge: mid('crispEdgePct'),
      softEdge: mid('softEdgePct'),
      hardShade: mid('hardShadePct'),
      softShade: mid('softShadePct'),
      interior: mid('interiorPct'),
    };
  };

  for (const cfg of runnable) {
    /* Squeeze the patches to this configuration's width, once for all lawns. */
    if (cfg.backbone && hasEye) {
      for (const L of lawns) {
        L.fine = L.fineFull ? shrink(L.fineFull, cfg.dims) : null;
        L.coarse = L.coarseFull ? shrink(L.coarseFull, cfg.dims) : null;
      }
    }
    const width = rowWidth(cfg, hasEye, scales);
    console.log(`Scoring "${cfg.name}" (${width} numbers a pixel)…`);

    const rows = [];
    for (let held = 0; held < lawns.length; held++) {
      rows.push(foldRow(held, runFold(lawns, held, { cfg, width })));
    }
    table.push(summarise(cfg, rows, width));
  }

  /*
   * THE DECODER'S ANSWERS, read from files and judged by the same arithmetic.
   *
   * tools/train_decoder.py trains one small convolutional decoder per
   * held-out lawn over the eye's FULL patch grid -- all 1024 numbers, and the
   * neighbours' -- and writes each held-out answer as a probability picture
   * on this lawn's own grid. Nothing about that can be done in Node in the
   * time a workflow has, so it is a step of its own; what is done here is the
   * only part that has to be identical, which is the scoring.
   *
   * A lawn with no answer is reported, not skipped silently: a row over 29 of
   * 32 lawns would sit in the same table as rows over 32 and look comparable.
   */
  /*
   * ONE ROW PER DIRECTORY. PREDICTIONS_DIR is one decoder; PREDICTIONS_DIRS
   * is several, as `label=dir,label=dir`, for a run that trained the same
   * decoder more than once over the SAME extracted features -- which is the
   * only way to compare two training rules (H28: the extraction itself comes
   * back in more than one state, and two runs can differ by that alone).
   */
  const predDirs = [];
  /* Each decoder's answers per lawn, kept for stage 3 below. */
  const decoderMasks = [];
  if (process.env.PREDICTIONS_DIR) predDirs.push({ label: '', dir: process.env.PREDICTIONS_DIR });
  for (const entry of String(process.env.PREDICTIONS_DIRS || '').split(',')) {
    const at = entry.indexOf('=');
    if (at > 0) predDirs.push({ label: entry.slice(0, at).trim(), dir: entry.slice(at + 1).trim() });
  }
  for (const { label, dir: predDir } of predDirs) {
    const manifestPath = join(predDir, 'manifest.json');
    const pm = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
    const cfg = {
      name: label ? `decoder, ${label}` : 'the pretrained eye, decoder',
      colour: false, backbone: true,
      dims: pm.dim || any?.dim || 0, decoder: true,
    };
    console.log(`Scoring "${cfg.name}" (${cfg.dims} numbers a patch, `
      + `${pm.params ? `${pm.params.toLocaleString()} weights, ` : ''}`
      + `${pm.epochs || '?'} epochs a fold)…`);
    const rows = [];
    const unanswered = [];
    const masks = new Array(lawns.length).fill(null);
    for (let held = 0; held < lawns.length; held++) {
      const L = lawns[held];
      const file = join(predDir, `${L.id}-pred.png`);
      const got = existsSync(file)
        ? predictionMask(decoders.png.PNG.sync.read(readFileSync(file)), L.grid, L.gridH)
        : null;
      if (!got) { unanswered.push(L.id.slice(0, 28)); continue; }
      masks[held] = got;
      rows.push(foldRow(held, judgeFold(L, got, { trainedOn: lawns.length - 1 })));
    }
    if (unanswered.length) {
      console.log(`   ${unanswered.length} of ${lawns.length} lawns have no decoder answer `
        + `(${unanswered.slice(0, 3).join(', ')}${unanswered.length > 3 ? ', …' : ''}),`);
      console.log('   so this row is over fewer lawns than the others and does not compare.');
    }
    if (rows.length) {
      table.push(summarise(cfg, rows, cfg.dims));
      decoderMasks.push({ cfg, masks });
    } else console.log('   No decoder answers found, so there is no row for it.\n');
  }

  /*
   * STAGE 3: LAWN UNDER THE TREES, by geometry over two masks.
   *
   * Stage 1 is taught nothing under the canopy; stage 2 says where the
   * canopy is; this reasons between them (tools/stage3.js): the canopy is
   * cleared from stage 1's answer, then canopy within `reach` of visible lawn
   * becomes lawn, then a clump of canopy with lawn round more than `ring` of
   * its rim is filled. No training, so the two numbers are SWEPT here and
   * printed as a table: a flat table means the rules do nothing, a peak that
   * moves when a lawn is added means noise (THE PLAN, docs/DETECTOR-FINDINGS.md).
   *
   * Read the INFERRED column: that is the ground under the trees, and the
   * only ground stage 3 is allowed to change. The seen column says what it
   * cost on visible ground (canopy the tracer left out counts as seen when
   * CANOPY_MODE is "lawn", so a bridge into the woods shows up there).
   */
  if (decoderMasks.length && lawns.some((L) => L.canopy)) {
    const judge = (masks, opts) => {
      const rows = [];
      for (let held = 0; held < lawns.length; held++) {
        const L = lawns[held];
        if (!masks[held]) continue;
        const canopy = opts.plus && L.canopyPlus ? L.canopyPlus : L.canopy;
        let mask = canopy
          ? stage3(masks[held], canopy, L.grid, L.gridH, { mpp: L.mpp, height: L.height, ...opts }).mask
          : masks[held];
        /* Colour on the edges only (tools/colour-edges.js), before the veto
           so roof and void still have the last word. */
        if (opts.edges && L.cheap) {
          mask = colourEdges(mask, L.cheap, FEATURE_COUNT, {
            w: L.grid, h: L.gridH, mpp: L.mpp, within: L.within, canopy: L.canopy,
          }).mask;
        }
        const preVeto = opts.veto ? mask : null;
        if (opts.veto) mask = lidarVeto(mask, L.roof, L.void);
        const row = foldRow(held, judgeFold(L, mask, { trainedOn: lawns.length - 1 }));
        /*
         * WHAT STAGE 1 SAID, with the canopy cleared, so the pictures can
         * paint stage 3's additions in their own colour. The owner could not
         * tell from the pictures whether a shape under the trees was the
         * detector's or the guesser's, and the two are different bugs.
         */
        row.base = canopy ? clearCanopy(masks[held], canopy) : null;
        /* And what the veto took, for the pictures' own layer. */
        row.preVeto = preVeto;
        rows.push(row);
      }
      return rows;
    };
    const mid = (rows, key) => {
      const vs = rows.map((r) => (key === 'mine' ? r.mine.errorPct : r[key])).filter((v) => v !== null && v !== undefined);
      return vs.length ? median(vs) : null;
    };
    const fmt = (v) => (v === null ? '  --' : v.toFixed(1).padStart(5));

    /*
     * SWEPT OVER EVERY DECODER, not just the first. H31 found the three
     * decoders differ under stage 3 in the tail (the wooded lots) and not
     * the median, and a sweep over one of them said nothing about the other
     * two. Each table is a few seconds.
     */
    const reaches = [0, 1.5, 3, 4.5];
    const rings = [1, 0.5, 0.35];
    const spans = [4, 8, 12];
    const spanReaches = [0, 1, 1.5];
    const cell = (rows) => `${fmt(mid(rows, 'mine'))} /${fmt(mid(rows, 'seenPct'))} /${fmt(mid(rows, 'guessPct'))}`.padStart(22);
    for (const first of decoderMasks) {
      console.log(`\nSTAGE 3 over "${first.cfg.name}": reach in metres across, `
        + 'rim fraction down. Each cell: headline / seen / inferred.\n');
      console.log(`  ${'rim'.padEnd(10)}${reaches.map((r) => `reach ${r} m`.padStart(22)).join('')}`);
      for (const minRing of rings) {
        const label = minRing >= 1 ? 'no bridge' : `> ${Math.round(minRing * 360)}°`;
        let line = `  ${label.padEnd(10)}`;
        for (const reachM of reaches) line += cell(judge(first.masks, { reachM, minRing }));
        console.log(line);
      }
      const base = judge(first.masks, { reachM: 0, minRing: 1 });
      console.log(`\n  (canopy cleared, no rules: ${fmt(mid(base, 'mine'))} / ${fmt(mid(base, 'seenPct'))} / ${fmt(mid(base, 'guessPct'))};`
        + ` stage 1 as it came: ${fmt(mid(table.find((t) => t.cfg === first.cfg).rows, 'mine'))})\n`);

      /*
       * SPAN, the owner's rule (2026-09-25): lawn under canopy joins the lawn
       * that can be seen, and may fall a little beyond the joined shape but
       * not far. Canopy with visible lawn on both sides of it within `span`
       * each way is filled, then a small reach goes beyond, then the bridge.
       * Enclosure (H32) was measured as a trade the other way and is not
       * printed any more; its code stays.
       */
      console.log('  Span: canopy with visible lawn on BOTH sides within N metres is filled, then a small reach (bridge over 180°).\n');
      console.log(`  ${'span'.padEnd(10)}${spanReaches.map((r) => `reach ${r} m`.padStart(22)).join('')}`);
      for (const spanM of spans) {
        let line = `  ${`${spanM} m`.padEnd(10)}`;
        for (const reachM of spanReaches) line += cell(judge(first.masks, { spanM, reachM, minRing: 0.5 }));
        console.log(line);
      }
      console.log();

      /*
       * WOODS, from the lidar (H34): a canopy clump whose median height is
       * H metres or more is woods and is never filled. Swept at the fixed
       * span cell (8 m, 1 m, 180°); "off" is that cell as it was.
       */
      if (lawns.some((L) => L.height)) {
        console.log('  Woods: a canopy clump at least H metres tall (lidar median) is never filled; at span 8 m, reach 1 m, bridge over 180°.\n');
        let line = `  ${'H'.padEnd(10)}`;
        const talls = [0, 4, 6, 8, 12];
        console.log(`  ${''.padEnd(10)}${talls.map((t) => (t ? `${t} m` : 'off').padStart(22)).join('')}`);
        for (const tallM of talls) line += cell(judge(first.masks, { spanM: 8, reachM: 1, minRing: 0.5, tallM }));
        console.log(line);
        /*
         * AND BIG (H35): tall alone took the tracer's own lawn trees for
         * woods. A wood is many trees, so the clump has to be at least A m²
         * as well; at 12 m, the cutoff the first sweep favoured.
         */
        console.log(`\n  ${'12 m and'.padEnd(10)}${[0, 200, 500, 1000].map((a) => (a ? `≥ ${a} m²` : 'any size').padStart(22)).join('')}`);
        line = `  ${''.padEnd(10)}`;
        for (const woodsM2 of [0, 200, 500, 1000]) line += cell(judge(first.masks, { spanM: 8, reachM: 1, minRing: 0.5, tallM: 12, woodsM2 }));
        console.log(line);
        console.log();
      }
    }

    /*
     * And the plan's own numbers as rows in the table, for every decoder.
     * The span cell (H33's row) was fixed before its sweep was seen: 8 m
     * each way joins a tree up to 16 m across, 1 m of reach is "a little
     * beyond". The woods cell adds H34's rule at 6 m, chosen from the two
     * class medians (3.7 and 7.3 m) before the sweep above was seen. The
     * reach-only row of H30 to H32 is in the sweep tables, not the table.
     */
    for (const { cfg, masks } of decoderMasks) {
      const cfg4 = { ...cfg, name: `${cfg.name} + stage 3, span`, stage3: true };
      console.log(`Scoring "${cfg4.name}" (span 8 m, reach 1 m, bridge over 180°)…`);
      table.push(summarise(cfg4, judge(masks, { spanM: 8, reachM: 1, minRing: 0.5 }), cfg.dims));
      /*
       * The woods row is retired: tall and big measured as nothing (H36) and
       * the understory as weaker than height (H37). Its sweep stays above.
       *
       * THE LIDAR VETO (H38): roof and void cells are never lawn, applied
       * after stage 3 over the span row. The split says, in square metres of
       * stage 3's answer, what each mask took from the tracer's lawn (cost)
       * and from lawn the tracer did not draw (gain) -- the number that says
       * whether the veto earns its place, beside the medians that may not
       * move at all when the pond is one lot of 32.
       */
      if (lawns.some((L) => L.roof || L.void)) {
        const cfg6 = { ...cfg, name: `${cfg.name} + stage 3, span, lidar veto`, stage3: true };
        console.log(`Scoring "${cfg6.name}" (span 8 m, reach 1 m, bridge over 180°, then roof and void are not lawn)…`);
        const vetoed = judge(masks, { spanM: 8, reachM: 1, minRing: 0.5, veto: true });
        table.push(summarise(cfg6, vetoed, cfg.dims));
        /*
         * THE SAME ROW WITH COLOUR ON THE EDGES (owner, 2026-09-27): every
         * cell within 1 m of the decoder's edge re-decided by a colour model
         * fitted to this lot's own confident ground. Its lot-by-lot figures
         * against the row above are the test; compare-runs reads both.
         */
        const cfgE = { ...cfg, name: `${cfg6.name}, colour edges`, stage3: true };
        console.log(`Scoring "${cfgE.name}" (cells within 1 m of the edge re-decided by this lot's own colours)…`);
        const edged = judge(masks, { spanM: 8, reachM: 1, minRing: 0.5, veto: true, edges: true });
        table.push(summarise(cfgE, edged, cfg.dims));
        /* What colour edges changed in THE PLAN's final answer, for the
           pictures' own two layers (owner, 2026-09-28: "no labelled layer
           for it"). Both rows are after the veto, so this is exactly the
           difference between the two scores. */
        vetoed.forEach((r, i) => {
          const e = edged[i];
          if (!r.predicted || !e?.predicted) return;
          r.edgeAdded = new Uint8Array(r.predicted.length);
          r.edgeRemoved = new Uint8Array(r.predicted.length);
          for (let k = 0; k < r.predicted.length; k++) {
            r.edgeAdded[k] = e.predicted[k] && !r.predicted[k] ? 1 : 0;
            r.edgeRemoved[k] = r.predicted[k] && !e.predicted[k] ? 1 : 0;
          }
        });
        const split = { roof: [0, 0], void: [0, 0] };
        const moved = [];
        const plain = judge(masks, { spanM: 8, reachM: 1, minRing: 0.5 });
        for (let held = 0; held < lawns.length; held++) {
          const L = lawns[held];
          if (!masks[held] || !L.canopy) continue;
          const m = stage3(masks[held], L.canopy, L.grid, L.gridH, { mpp: L.mpp, spanM: 8, reachM: 1, minRing: 0.5 }).mask;
          const a = L.mpp * L.mpp;
          for (const k of ['roof', 'void']) {
            const v = L[k];
            if (!v) continue;
            for (let i = 0; i < m.length; i++) {
              if (!m[i] || !v[i] || (L.within && !L.within[i])) continue;
              split[k][L.truth[i] ? 0 : 1] += a;
            }
          }
        }
        vetoed.forEach((r, i) => {
          const p = plain[i];
          if (Math.abs(r.mine.errorPct - p.mine.errorPct) >= 1) moved.push([r.lawn, p.mine.errorPct, r.mine.errorPct]);
        });
        console.log(`   veto took, of stage 3's lawn: roof ${Math.round(split.roof[0])} m² of the tracer's lawn / ${Math.round(split.roof[1])} m² not;`
          + ` void ${Math.round(split.void[0])} m² / ${Math.round(split.void[1])} m².`);
        for (const [L, before, after] of moved) {
          const sqft = Math.round((L.truthPx * L.mpp * L.mpp) / SQM_PER_SQFT);
          console.log(`   ${lawnName(L).slice(0, 22).padEnd(22)} ${sqft.toLocaleString().padStart(8)} sq ft: ${before.toFixed(1)}% -> ${after.toFixed(1)}%`);
        }
        if (!moved.length) console.log('   no lawn moved by a point or more.');

        /*
         * THE LIDAR ∩ NAIP CANOPY (H41, owner 2026-09-26): the plan's row
         * with stage 3 working over the tree model's canopy PLUS the cells
         * the lidar and NAIP-CHM both call canopy (NAIP alone where there is
         * no point cloud). Stage 3 only: the decoder was trained, and every
         * column is scored, against the tree model's canopy as before, so
         * this row differs from the one above in exactly one thing.
         */
        /*
         * SHELVED 2026-09-27 (owner): "lidar canopy is bad ... the canopy
         * model is doing the intended function better." The row is kept
         * behind LIDAR_CANOPY=1 in case a specific use turns up; it never fed
         * THE PLAN's row, whose veto is roof and void only.
         */
        if (/^(1|true|yes)$/i.test(String(process.env.LIDAR_CANOPY || '')) && lawns.some((L) => L.canopyPlus)) {
          const cfg7 = { ...cfg, name: `${cfg.name} + stage 3, span, lidar veto, lidar ∩ NAIP canopy`, stage3: true };
          console.log(`Scoring "${cfg7.name}" (as above, stage 3 over the tree model's canopy plus lidar ∩ NAIP-CHM)…`);
          const plus = judge(masks, { spanM: 8, reachM: 1, minRing: 0.5, veto: true, plus: true });
          table.push(summarise(cfg7, plus, cfg.dims));
          let extra = 0;
          let extraOnLawn = 0;
          for (const L of lawns) {
            if (!L.canopyPlus || !L.canopy) continue;
            for (let i = 0; i < L.canopy.length; i++) {
              if (!L.canopyPlus[i] || L.canopy[i] || (L.within && !L.within[i])) continue;
              extra += L.mpp * L.mpp;
              if (L.truth[i]) extraOnLawn += L.mpp * L.mpp;
            }
          }
          console.log(`   canopy added inside the lines: ${Math.round(extra)} m², ${Math.round(extraOnLawn)} m² of it over the tracer's lawn.`);
          const movedPlus = [];
          plus.forEach((r, i) => {
            const p = vetoed[i];
            if (Math.abs(r.mine.errorPct - p.mine.errorPct) >= 1) movedPlus.push([r.lawn, p.mine.errorPct, r.mine.errorPct]);
          });
          for (const [L, before, after] of movedPlus) {
            const sqft = Math.round((L.truthPx * L.mpp * L.mpp) / SQM_PER_SQFT);
            console.log(`   ${lawnName(L).slice(0, 22).padEnd(22)} ${sqft.toLocaleString().padStart(8)} sq ft: ${before.toFixed(1)}% -> ${after.toFixed(1)}%`);
          }
          if (!movedPlus.length) console.log('   no lawn moved by a point or more.');
        }
      }
    }
  }

  /* The per-lawn detail, for the best configuration only -- twenty lines per
     configuration would bury the comparison the run exists to make.
     *
     * TWINS ARE EXCLUDED FROM "BEST". A seen-only row is an experiment about
     * training labels, not a candidate model: its headline error includes the
     * inferred ground it was deliberately never taught, so letting it win would
     * draw the pictures and set the verdict for a configuration that is losing
     * on purpose. Its own comparison is printed below, on the column that
     * means something for it. */
  /*
   * AND SO IS THE COLOUR CONTROL. It has won the headline more than once
   * (35886436057, on the windowed corpus) and each time the run drew its
   * pictures and set its verdict around a row that will never be the
   * detector: colour is what shadow washes out, and the plan puts the visible
   * lawn on the eye. It stays in the table, where it is a control; it does
   * not get to be "best".
   */
  const candidates = table.filter((t) => !t.cfg.twinOf && !t.cfg.control);
  /* A run with no eye at all has only the control, and a table with no best
     row would print "no SAM outline" about a run that has one. */
  const contenders = candidates.length ? candidates : table.filter((t) => !t.cfg.twinOf);
  const best = contenders.slice().sort((a, b) => a.med - b.med)[0];
  /*
   * AND THE SAME FOR THE PLAN'S ROW, when it is not the lowest median. The
   * lowest median's table is the one every run since H33 printed, so it stays
   * for comparison; but the row the project is building is THE PLAN's, and
   * its lot-by-lot figures were only ever visible for the lots a rule moved.
   */
  const planRow = table.find((t) => t.cfg.name === PLAN_ROW);
  for (const t of [best, planRow !== best ? planRow : null]) {
    if (!t) continue;
    console.log(`Lawn by lawn, under "${t.cfg.name}":\n`);
    for (const r of t.rows) {
      const L = r.lawn;
      const sqft = (px) => (px * L.mpp * L.mpp) / SQM_PER_SQFT;
      const d = r.predicted ? edgeDiagnosis(L, r.predicted) : null;
      if (d) r.diagnosis = d;
      console.log(
        `  ${lawnName(L).padEnd(24).slice(0, 24)} `
        + `${Math.round(sqft(L.truthPx)).toLocaleString().padStart(8)} sq ft true   `
        + `trained ${r.mine.errorPct.toFixed(1).padStart(5)}% wrong   `
        + (r.theirs ? `SAM ${r.theirs.errorPct.toFixed(1).padStart(5)}% wrong` : 'SAM not stored')
        + (d ? `   outline ${d.tracedPct.toFixed(1).padStart(5)}%   `
          + `within 0.5 m of the edge ${d.near05.toFixed(0).padStart(3)}%, 1 m ${d.near10.toFixed(0).padStart(3)}%   `
          + `best shift ${d.shiftX.toFixed(2)},${d.shiftY.toFixed(2)} m -> ${d.shiftedPct.toFixed(1)}%` : '')
      );
    }
    console.log('');
  }
  /*
   * WHAT THE ~10% ON A NEAR-PERFECT PICTURE IS MADE OF (owner, 2026-09-27,
   * B01). "outline" is the error of the traced polygon the picture shows and
   * the app would hand over; the percentages after it are the share of the
   * RAW mask's wrong ground lying within half a metre and a metre of the
   * truth's edge. Mostly-edge error is the patch grid's resolution, not a
   * mistake anybody would fix; see tools/edge-band.js.
   */
  if (planRow) {
    const ds = planRow.rows.map((r) => r.diagnosis).filter(Boolean);
    if (ds.length) {
      const med = (a) => { const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
      console.log(`Where THE PLAN's row is wrong, median over ${ds.length} lawns: `
        + `${med(ds.map((d) => d.near05)).toFixed(0)}% of the wrong ground is within 0.5 m of the true edge, `
        + `${med(ds.map((d) => d.near10)).toFixed(0)}% within 1 m; the traced outline scores `
        + `${med(ds.map((d) => d.tracedPct)).toFixed(1)}% against the mask's ${planRow.med.toFixed(1)}%. `
        + `Best shift of the mask onto the truth (x right, y down): median ${med(ds.map((d) => d.shiftX)).toFixed(2)}, `
        + `${med(ds.map((d) => d.shiftY)).toFixed(2)} m, error then ${med(ds.map((d) => d.shiftedPct)).toFixed(1)}% -- `
        + 'a consistent nonzero shift is a registration bug, not a detector one.\n');
    }
  }

  /*
   * THE TAIL, FOR EVERY ROW. The headline is a median and the per-lawn list
   * above is one row's, so a row that wins the median while losing the
   * wooded lots by fifty points looked like the best row (H31: the everywhere
   * decoder + stage 3, 24.2% and Kent 22,481 sq ft at 50%). Every lot that
   * ANY candidate row gets more than 60% wrong, with every row's figure
   * beside it, so median and tail are read together.
   */
  const BADLY = 60;
  const byLawn = new Map();
  for (const t of contenders) {
    for (const r of t.rows) {
      if (!byLawn.has(r.lawn)) byLawn.set(r.lawn, new Map());
      byLawn.get(r.lawn).set(t.cfg, r.mine.errorPct);
    }
  }
  const badLots = [...byLawn].filter(([, errs]) => Math.max(...errs.values()) > BADLY);
  if (badLots.length && contenders.length > 1) {
    console.log(`\nThe lots any row gets more than ${BADLY}% wrong, under every row:\n`);
    const short = (name) => name.replace('the pretrained eye, ', '').replace('decoder, ', '').replace('canopy ', '').slice(0, 14).padStart(14);
    console.log(`  ${''.padEnd(29)}${contenders.map((t) => short(t.cfg.name)).join('')}`);
    for (const [L, errs] of badLots) {
      const sqft = Math.round((L.truthPx * L.mpp * L.mpp) / SQM_PER_SQFT);
      console.log(`  ${lawnName(L).padEnd(22).slice(0, 22)} ${sqft.toLocaleString().padStart(9)} `
        + contenders.map((t) => (errs.has(t.cfg) ? `${errs.get(t.cfg).toFixed(0)}%` : '--').padStart(14)).join(''));
    }
  }

  /* ------------------------------------------------- draw the mistakes */
  /*
   * INTO R2, AND ONLY FOR THE BEST CONFIGURATION.
   *
   * Six configurations times twenty-three lawns is a hundred and thirty-eight
   * pictures, which is a wall rather than a diagnosis. The winner is the one
   * whose failures are worth understanding; the losers are already explained
   * by the table.
   *
   * To the bucket rather than to a workflow artifact, for the reason
   * everything else here goes to the bucket: this project is read from a
   * phone, and a zip file is not something a phone opens. The page at
   * /predictions.html reads them straight out of the same place.
   */
  /*
   * WHICH ROW GETS DRAWN: THE PLAN'S, when the run scored it, and the lowest
   * median only when it did not. The lowest median was "canopy everywhere +
   * stage 3, span" in every run from H33 on, and it is deterministic (H36:
   * identical to the decimal), so run after run drew the SAME pictures while
   * the row each run was testing -- the woods rule, the lidar veto -- was
   * never drawn. The owner looked for the difference and there was none to
   * find (2026-09-25). The best median is still named in the table.
   */
  const drawn = (TRIAL_ROW && table.find((t) => t.cfg.name === TRIAL_ROW)) || table.find((t) => t.cfg.name === PLAN_ROW) || best;
  if (renderWanted && drawn && drawn !== best) {
    console.log(`\nDrawing "${drawn.cfg.name}" (${drawn.med.toFixed(1)}%) -- ${drawn.cfg.name === TRIAL_ROW ? 'the row on trial' : "THE PLAN's row"} -- not the lowest median ("${best.cfg.name}", ${best.med.toFixed(1)}%).`);
  }
  /*
   * EVERY ROW'S PER-LOT RESULT, AS A FILE (LOT_RESULTS), so runs can be
   * compared lot by lot and across seeds (tools/compare-runs.js). The table
   * above is a median of these; decisions are made on the paired lots.
   * `benchmark` marks the frozen 32 -- the lots every rule so far was tuned
   * on -- so the ones approved since can be read on their own.
   */
  if (process.env.LOT_RESULTS) {
    const r1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(2)));
    writeFileSync(process.env.LOT_RESULTS, `${JSON.stringify({
      seed: Number(process.env.SEED || 0) || null,
      fingerprint: setPrint(lawns),
      decoder: process.env.DECODER_KIND || null,
      folds: process.env.FOLDS || 'leave-one-out',
      rows: table.map((t) => ({
        name: t.cfg.name,
        median: r1(t.med),
        lots: t.rows.map((r) => ({
          id: r.lawn.id,
          tag: benchmarkTag(r.lawn.id) || null,
          benchmark: Boolean(benchmarkTag(r.lawn.id)),
          error: r1(r.mine.errorPct),
          seen: r1(r.seenPct),
          inferred: r1(r.guessPct),
          truthM2: r1(r.mine.truth),
          ...(r.diagnosis ? {
            outline: r1(r.diagnosis.tracedPct),
            nearEdge05: r1(r.diagnosis.near05),
            nearEdge10: r1(r.diagnosis.near10),
            shiftX: r1(r.diagnosis.shiftX),
            shiftY: r1(r.diagnosis.shiftY),
            shifted: r1(r.diagnosis.shiftedPct),
          } : {}),
        })),
      })),
    })}\n`);
    console.log(`Per-lot results for ${table.length} rows in ${process.env.LOT_RESULTS}.`);
  }

  if (renderWanted && drawn) {
    /*
     * THE RUN'S OWN IDENTITY, assembled here where the facts are rather than
     * re-derived inside the renderer from the one sentence it used to be
     * handed. The folder name and the picker label both come out of this, and
     * a run labelled from a guess is a run nobody can find again.
     */
    await publishRenderings(bucket, drawn, lawns, using, {
      model: py ? py.manifest.model : (eye ? 'dinov2-tiled-224' : 'no-backbone'),
      size: py ? py.manifest.size : (eye ? 224 : null),
      noBackbone: process.env.NO_BACKBONE === 'true',
      aerialEye,
      windowed: py ? (py.manifest.windowed ?? null) : null,
    });
  }

  /*
   * H47's fair half: the drawn row's held-out mask per lawn, for
   * tools/segments_pred.py to re-run the per-crown test with the DETECTOR's
   * visible lawn instead of the tracer's. Outside the canopy the plan row's
   * mask is stage 1's own answer (stage 3 only changes ground under it).
   */
  if (process.env.PRED_OUT && drawn) {
    const { PNG } = await import('pngjs');
    mkdirSync(process.env.PRED_OUT, { recursive: true });
    let wrote = 0;
    for (const r of drawn.rows) {
      const L = r.lawn;
      if (!r.predicted) continue;
      const G = L.grid || GRID;
      const GH = L.gridH || G;
      const png = new PNG({ width: G, height: GH });
      for (let i = 0; i < G * GH; i++) {
        const v = r.predicted[i] ? 255 : 0;
        png.data[i * 4] = v; png.data[i * 4 + 1] = v; png.data[i * 4 + 2] = v; png.data[i * 4 + 3] = 255;
      }
      writeFileSync(join(process.env.PRED_OUT, `${L.id}-pred.png`), PNG.sync.write(png));
      wrote++;
    }
    console.log(`Held-out masks of "${drawn.cfg.name}" for ${wrote} lawns in ${process.env.PRED_OUT}.`);
  }

  /* ------------------------------------------------------------- verdict */
  console.log(`\n${'='.repeat(64)}`);
  console.log(`\nTrained on ${lawns.length - 1} lawns, tested on the one left out, ${lawns.length} times.`);
  console.log(`Features available: ${using}.`);
  /*
   * WHICH LAWNS, not just how many.
   *
   * Two tables from two runs look comparable and are not, if the sets differ.
   * The fingerprint is here so that can be checked at a glance instead of
   * being assumed -- same number, same table means the only thing that changed
   * is the thing under test.
   */
  console.log(`Lawn set: ${lawns.length} of ${rows.length}, fingerprint ${setPrint(lawns)}, ${lawnSetDescription()}.`);
  /*
   * THE BENCHMARK IS A FINGERPRINT, NOT A LABEL. The cohort column says which
   * rows were frozen; this says whether the run got exactly those. A row
   * rejected since, a photograph that would not fetch, a row re-stamped by a
   * later deploy -- any of them makes this a different set, and the tables
   * above stop comparing with the ones in docs/DETECTOR-FINDINGS.md.
   */
  if (lawnSetName() === 'benchmark' && setPrint(lawns) !== BENCHMARK_PRINT) {
    console.log(`\n${'!'.repeat(64)}`);
    console.log(`\nTHIS IS NOT THE BENCHMARK. The frozen set has fingerprint ${BENCHMARK_PRINT};`);
    console.log(`this run got ${setPrint(lawns)} over ${lawns.length} lawns. Do not set this table`);
    console.log('beside the ones in docs/DETECTOR-FINDINGS.md until the difference is');
    console.log('explained (a rejected row, a photograph that failed, or a row stamped late).');
    console.log(`\n${'!'.repeat(64)}`);
  }
  console.log('');

  /* Row names in full: at 32 characters the stage 3 rows all read "decoder, canopy on lawn + stage". */
  const NAME_W = Math.min(72, Math.max(32, ...table.map((t) => t.cfg.name.length)));
  console.log(`  ${'what it looked at'.padEnd(NAME_W)}   wrong   in shade  in sun   beat SAM on`);
  for (const t of table) {
    console.log(
      `  ${t.cfg.name.padEnd(NAME_W).slice(0, NAME_W)} ${t.med.toFixed(1).padStart(5)}%   `
      + `${(t.dark === null ? '  --' : t.dark.toFixed(1)).padStart(6)}%  `
      + `${(t.bright === null ? '  --' : t.bright.toFixed(1)).padStart(6)}%   `
      + `${t.wins} of ${t.of}`
      + (t.collapsed
        ? `   (${t.collapsed} of ${t.rows.length} folds answered the same thing everywhere -- not a score)`
        : '')
    );
  }

  /*
   * SEEN AND INFERRED, IN ITS OWN TABLE.
   *
   * Two more columns on the table above would push it past the width of a
   * phone, and this only exists once something has been marked. Printed
   * separately it also reads as what it is: a different question, about
   * whether the surroundings are helping or taking over.
   */
  const marked = lawns.filter((L) => L.inferred).length;
  if (marked) {
    const shares = lawns.filter((L) => L.inferred).map((L) => L.inferredPct);
    const most = Math.max(...shares);
    const typical = shares.slice().sort((a, b) => a - b)[shares.length >> 1];
    console.log(`\n  ${marked} of ${lawns.length} maps have areas marked "inferred, not seen".`);
    /*
     * THE SHARE IS THE GUARD. Where the two layers overlap the pixel counts as
     * inferred -- the later, narrower mark is the more careful statement, and
     * the blue below it was drawn in one sweep over everything. That rule can
     * only be trusted while the marks stay deliberate, so the proportion is
     * printed beside the score rather than policed silently: a map marked over
     * generously shows up here as a large share, on the lawn it belongs to.
     */
    console.log(`  Marked ground is ${typical.toFixed(0)}% of a typical one, `
      + `${most.toFixed(0)}% of the most-marked.`);
    if (most > 60) {
      console.log('\n  THAT TOP FIGURE IS HIGH. An inferred layer covering most of a');
      console.log('  lawn moves that lawn out of the column watching for the model');
      console.log('  going blind. Worth opening and checking the marks are meant.');
    }
    console.log('\n  Error on those, against error everywhere else:\n');
    console.log(`  ${'what it looked at'.padEnd(NAME_W)}   seen   inferred`);
    for (const t of table) {
      console.log(
        `  ${t.cfg.name.padEnd(NAME_W).slice(0, NAME_W)} `
        + `${(t.seen === null ? '  --' : t.seen.toFixed(1)).padStart(5)}%  `
        + `${(t.guess === null ? '  --' : t.guess.toFixed(1)).padStart(6)}%`
      );
    }

    /* ------------------------------------------------ the seen-only twins */
    /*
     * THE EXPERIMENT, PRINTED AS THE ONE COMPARISON IT IS.
     *
     * Twelve rows in the tables above and only six numbers in them matter:
     * each twin's SEEN error against its original's. Left to be read off the
     * big table, the eye goes to the headline column instead -- which is the
     * wrong one, because the headline includes the inferred ground the twins
     * were deliberately never taught. See seenOnlyTwin.
     */
    const twins = table.filter((t) => t.cfg.twinOf);
    if (twins.length) {
      console.log('\n  DOES TRAINING ON GROUND NOBODY COULD SEE COST THE VISIBLE HALF?');
      console.log('  Each row against its twin, on SEEN ground only. Lower is better;');
      console.log('  a minus in the last column means dropping the guesses helped.\n');
      console.log(`  ${'what it looked at'.padEnd(NAME_W)}  as-is  seen-only   change`);
      let best = null;
      for (const t of twins) {
        const base = table.find((o) => o.cfg.name === t.cfg.twinOf);
        if (!base || base.seen === null || t.seen === null) continue;
        const delta = t.seen - base.seen;
        if (best === null || delta < best) best = delta;
        console.log(
          `  ${t.cfg.twinOf.padEnd(NAME_W).slice(0, NAME_W)} `
          + `${base.seen.toFixed(1).padStart(5)}%  `
          + `${t.seen.toFixed(1).padStart(8)}%  `
          + `${(delta >= 0 ? '+' : '') + delta.toFixed(1)}`.padStart(8)
        );
      }
      /*
       * AND THE BAR IT HAS TO CLEAR, said next to the numbers rather than left
       * in a document nobody has open. H7: one map is worth up to 10 points at
       * this corpus size, and H13: a backbone row can move ~3 on an identical
       * re-run. A 2-point improvement here is not a result.
       */
      console.log('\n  Read against H7 and H13 in docs/DETECTOR-FINDINGS.md before');
      console.log('  concluding anything: under about 3 points is re-run noise on a');
      console.log('  backbone row, and the corpus itself is worth up to 10.');
      if (best !== null && best <= -3) {
        console.log(`\n  The best twin is ${(-best).toFixed(1)} points better on visible ground.`);
        console.log('  Worth a repeat run of the same pair before it is believed.');
      } else if (best !== null && best >= 3) {
        console.log(`\n  Every twin is worse, the best by ${best.toFixed(1)} points. So the`);
        console.log('  inferred labels were HELPING the visible half, which is the');
        console.log('  opposite of what this was built to test. Do not explain it away.');
      } else {
        console.log('\n  Nothing moved beyond the noise either way, so the inferred');
        console.log('  labels are neither the problem nor the help they might have been.');
      }
      /*
       * The other half of the pair, stated so nobody reports it as a loss. The
       * twins were never taught what to say under a canopy and the inferred
       * column measures exactly that ground.
       */
      console.log('\n  The twins\' INFERRED column is expected to be much worse. Nothing');
      console.log('  taught them what is under a tree; that is the arrangement, not a fault.');
    }
  } else {
    console.log('\n  Nothing is marked "inferred, not seen" yet, so every pixel');
    console.log('  counts as seen and there is no second column to show.');
  }
  /*
   * WHERE THE ERROR LIVES.
   *
   * The reading this answers (H12): the model handles the ground we assumed
   * was hard -- tree lines, dappled shade -- and fails on the ground we
   * assumed was easy, driveway and path edges and dense shade off a building.
   * If that is right the work has been aimed at the wrong half of the problem;
   * if it is wrong it is an impression formed from two dozen pictures.
   *
   * THE INTERIOR COLUMN IS THE CONTROL AND IS NOT DECORATION. Error
   * concentrates at boundaries in every segmentation model ever built, so
   * "the edge is worse than the middle" is a definition. The comparison with
   * an answer in it is SHARP against SOFT, each being half of the same
   * boundary, split at that lawn's own median sharpness.
   */
  if (table.some((t) => t.crispEdge !== null)) {
    console.log('\n  Where the error lives -- the sharp half of a boundary against');
    console.log('  the soft half, and hard-rimmed shade against soft-rimmed:\n');
    console.log(`  ${'what it looked at'.padEnd(NAME_W)}  sharp    soft   hard shade  soft shade  middle`);
    const cell = (v, w) => (v === null ? '  --' : v.toFixed(1)).padStart(w);
    for (const t of table) {
      console.log(
        `  ${t.cfg.name.padEnd(NAME_W).slice(0, NAME_W)} `
        + `${cell(t.crispEdge, 5)}%  ${cell(t.softEdge, 5)}%  `
        + `${cell(t.hardShade, 8)}%  ${cell(t.softShade, 8)}%  ${cell(t.interior, 5)}%`
      );
    }

    /*
     * The verdict, stated only where the numbers support one. Both halves of
     * each pair are the same kind of ground measured the same way, so the
     * difference is readable -- but it is still 23 lawns, so a small gap is
     * not a result. Ten points is the bar H7 sets for this corpus.
     */
    const b = table.slice().sort((a, c) => a.med - c.med)[0];
    if (b && b.crispEdge !== null && b.softEdge !== null) {
      const gap = b.crispEdge - b.softEdge;
      /*
       * ARE THE TWO COLUMNS THE SAME PIXELS? Both splits key off one gradient
       * map, so a dark strip beside a driveway is hard-rimmed shade AND a
       * sharp boundary. Without this the table can report one finding twice
       * and look like two independent confirmations of it.
       */
      const sample = lawns.find((L) => L.classes);
      if (sample) {
        const share = classOverlap({
          edge: sample.classes.edge, shade: sample.classes.shade, within: sample.within,
        });
        if (share !== null) {
          console.log(`\n  Of the hard-rimmed shade, ${(100 * share).toFixed(0)}% is also on a sharp`);
          console.log(`  boundary (first lawn). ${share > 0.6
            ? 'Mostly the same ground, so read the two columns as ONE result.'
            : 'Mostly separate ground, so they are two findings.'}`);
        }
      }

      console.log('');
      if (gap > 10) {
        console.log(`  SHARP BOUNDARIES ARE ${gap.toFixed(1)} POINTS WORSE than soft ones under`);
        console.log(`  "${b.cfg.name}". That is the opposite of where the work has`);
        console.log('  gone -- a driveway edge is unambiguous and a tree line is not.');
      } else if (gap < -10) {
        console.log(`  Sharp boundaries are ${(-gap).toFixed(1)} points BETTER than soft ones, which`);
        console.log('  is what you would expect. Read H12 as refuted here.');
      } else {
        console.log(`  The two halves are within ${Math.abs(gap).toFixed(1)} points, which at 23 lawns`);
        console.log('  is nothing (H7). Neither supported nor refuted here.');
      }

      /*
       * AND THE ONE COMPARISON THAT SAYS WHOSE FAULT IT IS.
       *
       * S8 blames the backbone: a sidewalk is sub-pixel at the resolutions a
       * satellite model was pretrained on, so it smooths the edge away. That
       * story predicts the gap should be WIDER with the eye than without it.
       *
       * The backbone-free row is the test, and the first run of this table
       * failed it -- colour and texture alone showed the same pattern. A
       * verdict that said "supports S8" without looking at that row would
       * have promoted a guess about a satellite model into a finding, on
       * evidence that a model with no satellite in it reproduces. Which is
       * precisely the kind of quiet promotion docs/DETECTOR-FINDINGS.md
       * exists to stop.
       */
      const control = table.find((t) => !t.cfg.backbone && !t.cfg.ring);
      if (control && control.crispEdge !== null && control.softEdge !== null) {
        const plain = control.crispEdge - control.softEdge;
        const extra = gap - plain;
        console.log('');
        console.log(`  Without any backbone the same gap is ${plain.toFixed(1)} points.`);
        if (plain > 10 && Math.abs(extra) < 10) {
          console.log('  SO THIS IS NOT THE BACKBONE\'S DOING. Colour and texture alone show');
          console.log('  the same pattern, so sharp boundaries are hard for this whole');
          console.log('  approach rather than for a satellite model specifically. S8 blames');
          console.log('  the backbone and this does not support that half of it.');
        } else if (extra > 10) {
          console.log(`  The eye widens it by ${extra.toFixed(1)} points, which is what S8 predicts:`);
          console.log('  the backbone is making sharp edges worse, not just failing to help.');
        } else if (extra < -10) {
          console.log(`  The eye NARROWS it by ${(-extra).toFixed(1)} points, so the backbone is helping`);
          console.log('  here. S8 predicts the opposite and is refuted on this run.');
        }
      }
    }
  }

  if (samMed !== null) {
    console.log(`\n  SAM, on the same ${samCount} lawns             ${samMed.toFixed(1)}%`);

    /*
     * AND WHO ACTUALLY DREW THAT LINE.
     *
     * The baseline is whatever is stored in `detected_shapes`, which is
     * whatever method the tracer pressed -- and there is a free land-cover
     * method now, so a corpus can carry a mix. One line when it is all one
     * method, a breakdown when it is not, because a mixed baseline is not the
     * "SAM" that every table in docs/DETECTOR-FINDINGS.md is compared against
     * and the difference is invisible from the number alone.
     */
    const drew = new Map();
    for (let i = 0; i < lawns.length; i++) {
      if (!samScores[i]) continue;
      const by = lawns[i].drawnBy || 'not recorded';
      if (!drew.has(by)) drew.set(by, []);
      drew.get(by).push(samScores[i].errorPct);
    }
    const kinds = [...drew.entries()].sort((a, b) => b[1].length - a[1].length);
    if (kinds.length === 1) {
      console.log(`  (all ${samCount} drawn by ${kinds[0][0]})`);
    } else {
      console.log('\n  THAT LINE IS A MIX, so it is not the SAM baseline the findings');
      console.log('  file quotes. Which method drew each stored outline:');
      for (const [by, list] of kinds) {
        console.log(`    ${String(by).padEnd(16).slice(0, 16)} ${String(list.length).padStart(3)} lawns  `
          + `${median(list).toFixed(1)}% out on the middle one`);
      }
      console.log('  Compare like with like before quoting the gap anywhere.');
    }
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
    /*
     * THE TABLE READS ITSELF, because the next person to run this will be
     * looking at it on a phone months from now and the four rows only mean
     * something in relation to each other. Stating which comparison decided
     * the sentence also makes the sentence checkable.
     */
    console.log('STILL NOT BETTER than the detector we pay for.\n');

    const row = (name) => table.find((t) => t.cfg.name === name);
    const colour = row('colour and texture only');
    const eyeOnly = row('the pretrained eye only');
    const narrow = row('both');
    const wide = row('both, 96 numbers a patch');

    /*
     * NOTHING UNDER ABOUT THREE POINTS IS REAL. The same configuration has
     * come back 38.7, 40.5 and 43.2 across runs that differed only in how the
     * head was trained, so a gap smaller than that is the measurement moving,
     * not the features. Twenty lawns is what makes it that wide.
     */
    const NOISE = 3;

    /*
     * THE SHADE COLUMN IS THE ONE TO READ FIRST.
     *
     * It is the difference between a model that has learnt what grass looks
     * like and one that has learnt what green looks like, and the overall
     * figure hides it completely -- a model can be mediocre everywhere or good
     * in the sun and hopeless in the shade, and those score the same.
     */
    for (const t of table) {
      if (t.dark === null || t.bright === null) continue;
      const penalty = t.dark - t.bright;
      if (penalty > NOISE) {
        console.log(`"${t.cfg.name}" is ${penalty.toFixed(1)} points worse in shade`);
        console.log('than in sun, which is what reading colour gets you: grass in');
        console.log('shadow is dark with the green washed out of it.\n');
      } else if (penalty < -NOISE) {
        console.log(`"${t.cfg.name}" is actually ${(-penalty).toFixed(1)} points BETTER in`);
        console.log('shade than in sun -- so whatever it is reading, it is not');
        console.log('brightness. That is the thing colour alone can never do.\n');
      }
    }

    if (colour && eyeOnly && colour.med > eyeOnly.med + NOISE) {
      console.log(`The pretrained eye ALONE (${eyeOnly.med.toFixed(1)}%) beats colour alone`);
      console.log(`(${colour.med.toFixed(1)}%), so it is reading things colour cannot. Worth`);
      console.log('a bigger model, or a higher resolution, before anything else.');
    } else if (colour && eyeOnly && eyeOnly.med > colour.med + NOISE) {
      console.log(`The pretrained eye ALONE (${eyeOnly.med.toFixed(1)}%) is clearly worse than`);
      console.log(`colour alone (${colour.med.toFixed(1)}%), so it is not carrying this on its own.`);
      if (aerialEye) {
        /*
         * A satellite-pretrained backbone losing to colour is a different
         * finding from a ground-pretrained one losing to colour, and pointing
         * it at "try aerial imagery" would be advice it has already taken.
         */
        console.log('This one HAS seen the ground from above, so the ceiling is not');
        console.log('what it was trained on. What is left is resolution -- these were');
        console.log('trained around a third of a metre a pixel and these frames are');
        console.log('nearer ten centimetres -- and the number of lawns. Note the');
        console.log('combined rows above before writing the eye off: it can be worth');
        console.log('a lot alongside colour while losing to it alone.');
      } else {
        console.log('These models learn from photographs taken from the ground; a view');
        console.log('straight down is not what they know. A backbone trained on aerial');
        console.log('imagery is the lever, not more of this one.');
      }
    } else if (colour && eyeOnly) {
      console.log(`The pretrained eye alone (${eyeOnly.med.toFixed(1)}%) scores near colour alone`);
      console.log(`(${colour.med.toFixed(1)}%), so the two are largely saying the same thing and`);
      console.log('neither adds much to the other.');
    }

    if (narrow && wide && narrow.med > wide.med + NOISE) {
      console.log(`\nThe wider squeeze helps (${wide.med.toFixed(1)}% against ${narrow.med.toFixed(1)}%), so some`);
      console.log('of what the eye sees was being thrown away on the way down to 32');
      console.log('numbers. Worth widening further before concluding much about it.');
    }

    /*
     * DID THE SURROUNDINGS HELP, OR TAKE OVER?
     *
     * The whole reason the ring is a separate configuration rather than just
     * switched on: "both" and "both, with surroundings" differ by the ring and
     * by nothing else, so the difference between their two columns is
     * attributable. Three outcomes and they want different words.
     *
     * The bad one is not "it got worse" -- that is easy to see. The bad one is
     * inferred improving WHILE seen degrades, because the total can still go
     * down and look like progress while the detector has quietly stopped
     * reading faint evidence in favour of guessing from the neighbours.
     */
    const plain = row('both');
    const ringed = row('both, with surroundings');
    if (plain && ringed && marked && plain.seen !== null && ringed.seen !== null) {
      const seenMoved = ringed.seen - plain.seen;
      const guessMoved = (ringed.guess ?? 0) - (plain.guess ?? 0);
      console.log('\nWHAT THE SURROUNDINGS DID:');
      if (guessMoved < -NOISE && seenMoved > NOISE) {
        console.log(`  inferred areas ${(-guessMoved).toFixed(1)} points BETTER,`);
        console.log(`  but everything visible ${seenMoved.toFixed(1)} points WORSE.`);
        console.log('\n  That is the trade nobody asked for. It is bridging canopies by');
        console.log('  guessing from the neighbours and has stopped reading the faint');
        console.log('  evidence it used to. Narrow the ring or drop it -- the total');
        console.log('  may look better and the detector is not.');
      } else if (guessMoved < -NOISE) {
        console.log(`  inferred areas ${(-guessMoved).toFixed(1)} points better, everything`);
        console.log(`  visible ${Math.abs(seenMoved).toFixed(1)} points ${seenMoved > 0 ? 'worse' : 'better'} -- within noise.`);
        console.log('\n  This is the result the ring was built for: it bridges what');
        console.log('  cannot be seen without giving up what can.');
      } else if (seenMoved > NOISE) {
        console.log(`  everything visible ${seenMoved.toFixed(1)} points worse, and inferred`);
        console.log('  areas no better. The ring is costing and not paying.');
      } else {
        console.log('  neither column moved beyond noise. The surroundings are not');
        console.log('  yet doing anything either way -- more marked areas would say');
        console.log('  more than more argument will.');
      }
    }

    const bestMed = Math.min(...contenders.map((t) => t.med));
    console.log(`\nThe best of them is ${bestMed.toFixed(1)}% against SAM's ${samMed.toFixed(1)}% -- a factor of`);
    console.log(`${(bestMed / samMed).toFixed(1)}, which is not a gap that settings close. With ${lawns.length} lawns`);
    console.log('the honest reading is that there is not enough to learn from yet.');
    console.log('Approve more maps and run this again; it is free, and the moment');
    console.log('the top row goes under the SAM line it is worth building on.');
  }

  /*
   * THE WARNING THAT OUTRANKS THE TABLE, last because last is what gets read.
   *
   * A run that lost lawns did not produce a slightly noisier version of the
   * same measurement. It measured a different set, and the set is the biggest
   * term in every number above -- 20 lawns to 18 moved the fixed colour-only
   * configuration by nine and a half points and flipped the sign of its
   * shade-versus-sun gap. Against that, the difference between two backbones
   * is not visible.
   *
   * So this does not say "note that two were skipped". It says the table
   * cannot be set beside the last one, because that is the decision it
   * changes.
   */
  if (missing.length) {
    console.log(`\n${'!'.repeat(64)}`);
    console.log(`\n${missing.length} lawn(s) could not be read, so this ran on `
      + `${lawns.length} of ${rows.length}.`);
    console.log('\nDO NOT COMPARE THIS TABLE WITH ANOTHER RUN. Which properties are');
    console.log('in the set moves these numbers more than anything being tested:');
    console.log('one run that lost two of twenty moved the fixed colour-only row');
    console.log('by 9.5 points and reversed its shade-versus-sun gap.');
    console.log('\nRun it again. The fetch retries three times now, so a second');
    console.log('failure on the same lawn is the photograph, not the network.');
    console.log(`\n${'!'.repeat(64)}`);
  }

  /* --------------------------------------------- ship it for dev mode */
  /*
   * COLOUR AND TEXTURE ONLY, whatever scored best above.
   *
   * The browser has no backbone and is not getting one -- that is two hundred
   * megabytes to look at one garden. So what dev mode can actually run is the
   * colour-and-texture head, which is also the best of the four, and this
   * writes exactly that.
   *
   * TRAINED ON EVERY LAWN, unlike the folds. The folds exist to produce an
   * honest number by never testing on what they learnt from; this exists to be
   * used, so it takes all the evidence there is. Which means the score
   * travelling with it comes from the folds, not from this fit -- a model
   * asked about a lawn it was trained on flatters itself, and the file says so
   * in its own fields.
   */
  const shipped = table.find((t) => t.cfg.name === 'colour and texture only');
  if (process.env.EXPORT_MODEL === 'true' && shipped) {
    const picked = [];
    const ys = [];
    let seed = 4242;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (const L of lawns) {
      const g = L.grid || GRID;
      const gh = L.gridH || g;
      for (let k = 0; k < 6000; k++) {
        const p = Math.floor(rand() * g * gh);
        if (L.within && !L.within[p]) continue;
        picked.push([L, p]);
        ys.push(L.truth[p]);
      }
    }
    const width = FEATURE_COUNT;
    const x = new Float32Array(picked.length * width);
    for (let i = 0; i < picked.length; i++) {
      buildRow(picked[i][0], picked[i][1], x, i * width, picked[i][0].grid || GRID, shipped.cfg, picked[i][0].gridH || picked[i][0].grid || GRID);
    }
    const y = Float32Array.from(ys);
    const stats = featureStats(x, width);
    standardise(x, stats, width);
    const model = train(x, y, balanceWeights(y), { seed: 99, inputs: width });

    /*
     * INTO R2, NOT INTO THE REPOSITORY.
     *
     * Committing the weights needed write access the workflow token does not
     * have, and getting it would mean a repository setting changed by hand --
     * which is the one thing this project does not do. The bucket is already
     * here, already holds every photograph these weights were learnt from, and
     * is already reachable with the token this workflow carries.
     *
     * It is also the better arrangement: a retrained model is live the moment
     * it is written, with no deploy. The flywheel is meant to turn quickly,
     * and a deploy between every turn is a brake nobody chose.
     */
    const dir2 = mkdtempSync(join(tmpdir(), 'model-'));
    const file = join(dir2, 'lawn-head.json');
    writeFileSync(file, `${JSON.stringify({
      note: 'Trained by workflow 12. The error below is from leaving one lawn '
        + 'out at a time, NOT from this fit -- this one has seen every lawn.',
      W1: [...model.W1], b1: [...model.b1], W2: [...model.W2], b2: model.b2,
      hidden: model.hidden, inputs: model.inputs,
      mean: [...stats.mean], sd: [...stats.sd],
      features: FEATURE_NAMES,
      trainedOn: lawns.length,
      errorPct: Number(shipped.med.toFixed(1)),
      samErrorPct: samMed === null ? null : Number(samMed.toFixed(1)),
      scoredAt: new Date().toISOString(),
    }, null, 1)}\n`);

    try {
      execFileSync('npx', [
        'wrangler', 'r2', 'object', 'put', `${bucket}/model/lawn-head.json`,
        '--file', file, '--content-type', 'application/json', '--remote',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`\nPublished the model: ${lawns.length} lawns, `
        + `${shipped.med.toFixed(1)}% out when tested honestly.`);
      console.log('Developer mode will draw it now -- no deploy needed.');
    } catch (e) {
      console.log(`\nTrained it but could not publish it: `
        + `${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 120)}`);
      process.exitCode = 1;
    }
    rmSync(dir2, { recursive: true, force: true });
  }

  console.log(`\n${'='.repeat(64)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log('Training stopped:', e.message);
    process.exitCode = 1;
  });
}

export {
  compare, resize, maskOf, GRID, renderPx, dumpSize, FETCH_TRIES,
  inferredGeometries, seenGeometries,
  /* For tools/tree-crowns.js, which draws over the same photographs and must
     build the same masks from the same rows. A second copy of the fetch, the
     resize or the rasteriser would be a second thing to drift. */
  fetchImage, geometries,
};
