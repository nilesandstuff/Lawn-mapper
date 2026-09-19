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
import {
  imageFeatures, featureStats, standardise, FEATURE_COUNT, FEATURE_NAMES,
} from '../public/lib/features.js';
import { train, predict, balanceWeights } from './learner.js';
import {
  drawPrediction, tracePrediction, traceMask, traceDrift, mistakeCounts,
} from './render-prediction.js';
import { classesFor, errorByClass, interiorError } from './boundary.js';
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
 * EVERYTHING HAPPENS AT ONE GRID, and that is what makes the comparison fair.
 * The truth, the prediction and SAM's own outline are all rasterised here, so
 * the three are counted on identical pixels. 512 keeps twenty lawns inside a
 * few hundred megabytes and is finer than the 0.35 m the tracer simplifies to.
 */
const GRID = 512;

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
  const raw = Number(process.env.DUMP_SIZE);
  return Number.isFinite(raw) && raw >= 64 ? Math.round(raw) : GRID;
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
  for (const L of lawns) out[L.id] = L.mpp * grid;
  return out;
};

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
export function buildRow(lawn, p, out, offset, grid = GRID, cfg = null) {
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
    sampleAt(fine, px, py, grid, out, at);
    at += dims;
    /* The Python path has no coarse grid: its single pass already saw the
       whole frame, so a second, blurrier copy of the same thing would only
       spend width. */
    if (coarse) { sampleAt(coarse, px, py, grid, out, at); at += dims; }
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
        const qy = Math.min(grid - 1, Math.max(0, py + Math.sin(angle) * reach));
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
        if (ring && useEye) { sampleAt(ring, qx, qy, grid, out, at); at += RING_DIMS; }
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
  /*
   * THE SAME EVIDENCE, PLUS WHAT IS AROUND IT.
   *
   * Deliberately identical to "both" except for the ring, so the difference
   * between those two rows is the surroundings and nothing else. A ring
   * configuration that also changed the squeeze would answer two questions at
   * once and settle neither.
   *
   * The colour-only ring is here for the same reason: it says whether the gain
   * (if any) needs the backbone at all, or whether "is it green over there" is
   * the whole of it. Cheap to know and cheaper than assuming.
   */
  { name: 'colour, with surroundings', colour: true, backbone: false, dims: 0, ring: true },
  { name: 'both, with surroundings', colour: true, backbone: true, dims: 32, ring: true },
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
 * ONE RUN OVERWRITES THE LAST, deliberately. These are a diagnosis of the
 * model as it is now, not a history of it: a dated folder would grow without
 * limit in a bucket that also holds the training photographs, and nobody is
 * going to go back and compare the pictures from three runs ago -- the numbers
 * in docs/DETECTOR-FINDINGS.md are the history.
 *
 * The index is written LAST, on purpose. The page reads the index to know what
 * exists, so writing it first would advertise pictures that are still
 * uploading, and a run that dies halfway would leave the page pointing at
 * things that never arrived. Written last, a half-finished run leaves the
 * previous set intact and completely readable.
 */
async function publishRenderings(bucket, best, lawns, using) {
  const { PNG } = await import('pngjs');
  const dir = mkdtempSync(join(tmpdir(), 'lawn-render-'));
  const entries = [];
  let put = 0;

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
      const trace = tracePrediction({
        predicted: r.predicted, within: L.within, grid: GRID, mpp: L.mpp,
      });

      const pixels = drawPrediction({
        photo: L.photo,
        truth: L.truth,
        within: L.within,
        inferred: L.inferred,
        rings: trace.rings,
        grid: GRID,
      });

      const png = new PNG({ width: GRID, height: GRID });
      png.data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length);
      const file = join(dir, `${n}.png`);
      writeFileSync(file, PNG.sync.write(png));

      /* Named by position, not by map id. The id contains the coordinates of
         somebody's house, and a bucket key is not the place for those. */
      const key = `predictions/${n}.png`;
      try {
        execFileSync('npx', [
          'wrangler', 'r2', 'object', 'put', `${bucket}/${key}`,
          '--file', file, '--content-type', 'image/png', '--remote',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
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
      const traced = traceMask({ shapes: trace.shapes, within: L.within, grid: GRID });
      const counts = mistakeCounts({
        truth: L.truth, predicted: traced, within: L.within, inferred: L.inferred,
      });
      const drift = traceDrift({ predicted: r.predicted, traced, within: L.within });
      const sqft = (px) => (px * L.mpp * L.mpp) / SQM_PER_SQFT;
      entries.push({
        key,
        county: L.county || null,
        squareFeet: Math.round(sqft(L.truthPx)),
        errorPct: Number(r.mine.errorPct.toFixed(1)),
        samErrorPct: r.theirs ? Number(r.theirs.errorPct.toFixed(1)) : null,
        foundPct: counts.foundPct === null ? null : Number(counts.foundPct.toFixed(1)),
        overPct: counts.overPct === null ? null : Number(counts.overPct.toFixed(1)),
        missedInferredPct: counts.missedInferredPct === null
          ? null : Number(counts.missedInferredPct.toFixed(1)),
        inferredPct: Number(L.inferredPct.toFixed(1)),
        mpp: Number(L.mpp.toFixed(3)),
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

    const indexFile = join(dir, 'index.json');
    writeFileSync(indexFile, `${JSON.stringify({
      drawnAt: new Date().toISOString(),
      config: best.cfg.name,
      features: using,
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
        + `${lawns.length - 1} and never shown this one. The outline is the `
        + 'traced polygon the drawing tools would receive, not the raw mask.',
      entries,
    }, null, 1)}\n`);

    execFileSync('npx', [
      'wrangler', 'r2', 'object', 'put', `${bucket}/predictions/index.json`,
      '--file', indexFile, '--content-type', 'application/json', '--remote',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    console.log(`\nDrew ${put} of ${best.rows.length} lawns under "${best.cfg.name}".`);
    console.log('Open /predictions.html to see the outlines it drew, worst first.');
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
  /*
   * THE PYTHON PATH, when it has been run.
   *
   * A directory of patch grids, one per lawn, keyed by the same id the
   * photographs were saved under. Read before the lawns are gathered so a
   * missing extractor is reported once rather than twenty times.
   */
  const pyDir = process.env.FEATURES_DIR || '';
  const py = pyDir ? readPythonFeatures(pyDir) : null;
  if (pyDir && !py) {
    console.log(`No features found in ${pyDir}. Run the extractor first, or`);
    console.log('unset FEATURES_DIR to fall back to the in-browser backbone.');
    process.exitCode = 1;
    return;
  }
  if (py) {
    const any = [...py.grids.values()][0];
    console.log(`Features from ${py.manifest.model} at ${py.manifest.size}px:`);
    console.log(`${py.grids.size} lawns, ${any?.gridW}x${any?.gridH} patches of ${any?.dim},`);
    console.log('one pass over the whole property -- every patch saw all of it.\n');
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
  const using = py
    ? `colour, texture and ${py.manifest.model} at ${py.manifest.size}px`
    : eye ? 'colour, texture and a pretrained eye (tiled, 224px)'
      : 'colour and texture only';

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
      const frame = parse(row.frame);
      const truthGeoms = geometries(parse(row.shapes));
      if (!frame || !truthGeoms.length) continue;

      const img = fetchImage(bucket, row.image_key, dir, decoders);
      if (!img.ok) {
        console.log(`  skipped ${row.id.slice(0, 28)} -- ${img.reason}`);
        missing.push(row.id.slice(0, 28));
        continue;
      }

      const rgb = resize(img.data, img.width, img.height, img.channels, GRID);
      const truth = maskOf(truthGeoms, frame, GRID);
      /* Where both layers cover a pixel it counts as INFERRED -- the narrower,
         later mark is the more careful one. See inferredShare above for why,
         and for what stands in for the guard that rule used to be. */
      const inferredGeoms = inferredGeometries(parse(row.shapes));
      const inferred = inferredGeoms.length ? maskOf(inferredGeoms, frame, GRID) : null;
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
        /*
         * Kept only for DUMP_FRAMES, and resized from the ORIGINAL pixels
         * rather than from the 512 grid beside it. Going 512 -> 896 would be
         * an upscale of something already thrown away; this is one
         * box-average, downward, from what R2 actually holds.
         */
        dump: process.env.DUMP_FRAMES
          ? resize(img.data, img.width, img.height, img.channels, dumpSize())
          : null,
        canopy: row.tree_line === null || row.tree_line === undefined ? null : Number(row.tree_line),
        /*
         * The photograph itself, at the grid everything is measured on, kept
         * only when the run is going to draw on it. It is the same pixels the
         * features came from, so a rendering shows what the model actually
         * saw rather than a prettier copy of it.
         */
        photo: renderWanted ? rgb : null,
        /* Held raw: each fold standardises against its own training lawns. */
        cheap: imageFeatures(rgb, GRID, GRID),
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
          : eye ? await tiledFeatures(eye, rgb, GRID, GRID, { tiles: FINE_TILES }) : null,
        coarseFull: py ? null
          : eye ? await tiledFeatures(eye, rgb, GRID, GRID, { tiles: COARSE_TILES }) : null,
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
        inferredPct: 100 * inferredShare(truth, inferred, within),
        truthPx,
        mpp: metresPerPixel(frame, GRID),
        detected: row.detected_shapes
          ? maskOf(geometries(parse(row.detected_shapes)), frame, GRID) : null,
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
          cheap: L.cheap, truth: L.truth, within: L.within, grid: GRID,
        });
      }

      process.stdout.write(`  read ${lawns.length}/${rows.length}\r`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${lawns.length} usable.\n`);

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
    const size = dumpSize();
    mkdirSync(dest, { recursive: true });
    for (const L of lawns) {
      const png = new decoders.png.PNG({ width: size, height: size });
      png.data = Buffer.from(L.dump.buffer, L.dump.byteOffset, L.dump.byteLength);
      writeFileSync(join(dest, `${L.id}.png`), decoders.png.PNG.sync.write(png));
    }
    /*
     * The ground truth of the pictures, for any model that asks what scale it
     * is looking at. Written next to them rather than inside them because a
     * PNG has nowhere honest to put it.
     */
    writeFileSync(
      join(dest, 'scale.json'),
      JSON.stringify({ frames: frameSpans(lawns) }, null, 1),
    );
    const spans = lawns.map((L) => L.mpp * GRID);
    const lo = Math.min(...spans), hi = Math.max(...spans);
    console.log(`Wrote ${lawns.length} frames to ${dest} at ${size}x${size},`);
    console.log(`covering ${lo.toFixed(0)}-${hi.toFixed(0)} m of ground`);
    console.log(`(${(lo / size).toFixed(3)}-${(hi / size).toFixed(3)} m a pixel), and scale.json beside them.`);
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
  const runnable = CONFIGS.filter((c) => rowWidth(c, hasEye, scales) > 0
    && (!c.backbone || hasEye));
  const table = [];

  /*
   * The ring's squeeze is the same width whatever the centre's is, so it is
   * made once here rather than rebuilt per configuration. Sixteen ring points
   * per pixel means this one gets read a lot.
   */
  if (hasEye && runnable.some((c) => c.ring && c.backbone)) {
    for (const L of lawns) L.ring = L.fineFull ? shrink(L.fineFull, RING_DIMS) : null;
  }

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
      const f = runFold(lawns, held, { cfg, width });
      rows.push({
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
    }
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
    table.push({
      cfg, med, wins, of: paired.length, rows, width, collapsed, dark, bright, seen, guess,
      crispEdge: mid('crispEdgePct'),
      softEdge: mid('softEdgePct'),
      hardShade: mid('hardShadePct'),
      softShade: mid('softShadePct'),
      interior: mid('interiorPct'),
    });
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
  if (renderWanted && best) {
    await publishRenderings(bucket, best, lawns, using);
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
  console.log(`Lawn set: ${lawns.length} of ${rows.length}, fingerprint ${setPrint(lawns)}.\n`);

  console.log('  what it looked at                  wrong   in shade  in sun   beat SAM on');
  for (const t of table) {
    console.log(
      `  ${t.cfg.name.padEnd(32).slice(0, 32)} ${t.med.toFixed(1).padStart(5)}%   `
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
    console.log('  what it looked at                  seen   inferred');
    for (const t of table) {
      console.log(
        `  ${t.cfg.name.padEnd(32).slice(0, 32)} `
        + `${(t.seen === null ? '  --' : t.seen.toFixed(1)).padStart(5)}%  `
        + `${(t.guess === null ? '  --' : t.guess.toFixed(1)).padStart(6)}%`
      );
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
    console.log('  what it looked at                 sharp    soft   hard shade  soft shade  middle');
    const cell = (v, w) => (v === null ? '  --' : v.toFixed(1)).padStart(w);
    for (const t of table) {
      console.log(
        `  ${t.cfg.name.padEnd(32).slice(0, 32)} `
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

    const bestMed = Math.min(...table.map((t) => t.med));
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
      for (let k = 0; k < 6000; k++) {
        const p = Math.floor(rand() * GRID * GRID);
        if (L.within && !L.within[p]) continue;
        picked.push([L, p]);
        ys.push(L.truth[p]);
      }
    }
    const width = FEATURE_COUNT;
    const x = new Float32Array(picked.length * width);
    for (let i = 0; i < picked.length; i++) {
      buildRow(picked[i][0], picked[i][1], x, i * width, GRID, shipped.cfg);
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
  compare, resize, maskOf, GRID, dumpSize, FETCH_TRIES,
  inferredGeometries, seenGeometries,
};
