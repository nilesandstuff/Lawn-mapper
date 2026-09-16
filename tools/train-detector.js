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
import { rasterizePolygon } from '../public/lib/mask.js';
import { lngLatToFramePx, metresPerPixel } from '../public/lib/mercator.js';

const SQM_PER_SQFT = 0.09290304;

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
export function runFold(lawns, held, { perLawn = 6000, grid = GRID } = {}) {
  /*
   * SAMPLED, NOT EVERY PIXEL. Nineteen lawns is five million pixels and they
   * are enormously redundant -- neighbouring pixels of the same lawn are the
   * same fact. A few thousand per lawn carries the same information and keeps
   * a fold to a couple of seconds, which is what makes twenty folds possible.
   */
  const xs = [];
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
      xs.push(L.features.subarray(p * FEATURE_COUNT, (p + 1) * FEATURE_COUNT));
      ys.push(L.truth[p]);
    }
  }

  const x = new Float32Array(xs.length * FEATURE_COUNT);
  for (let i = 0; i < xs.length; i++) x.set(xs[i], i * FEATURE_COUNT);
  const y = Float32Array.from(ys);

  /*
   * The scaling is measured on the training lawns only. Standardising with the
   * held-out lawn included would let it influence its own normalisation, which
   * is testing on what you trained on by a quiet back door.
   */
  const stats = featureStats(x);
  standardise(x, stats);

  const model = train(x, y, balanceWeights(y), { seed: 99 });

  const test = lawns[held];
  const tx = Float32Array.from(test.features);
  standardise(tx, stats);
  const p = predict(model, tx);

  const got = new Uint8Array(grid * grid);
  for (let i = 0; i < p.length; i++) got[i] = p[i] > 0.5 ? 1 : 0;

  return {
    mine: compare(got, test.truth, test.within),
    theirs: test.detected ? compare(test.detected, test.truth, test.within) : null,
    trainedOn,
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
        features: imageFeatures(rgb, GRID, GRID),
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
  console.log('Training once per lawn, each time on all the others.\n');
  const results = [];

  for (let held = 0; held < lawns.length; held++) {
    const test = lawns[held];
    const { mine, theirs, trainedOn } = runFold(lawns, held);
    results.push({ lawn: test, mine, theirs, trainedOn });

    const sqft = (px) => (px * test.mpp * test.mpp) / SQM_PER_SQFT;
    console.log(
      `  ${String(test.county || 'traced by hand').padEnd(20).slice(0, 20)} `
      + `${Math.round(sqft(test.truthPx)).toLocaleString().padStart(8)} sq ft true   `
      + `trained ${mine.errorPct.toFixed(1).padStart(5)}% wrong   `
      + (theirs ? `SAM ${theirs.errorPct.toFixed(1).padStart(5)}% wrong` : 'SAM not stored')
    );
  }

  /* ------------------------------------------------------------- verdict */
  const median = (list) => {
    const s = list.slice().sort((a, b) => a - b);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const both = results.filter((r) => r.theirs);
  const mineMed = median(results.map((r) => r.mine.errorPct));
  const theirsMed = both.length ? median(both.map((r) => r.theirs.errorPct)) : null;
  const wins = both.filter((r) => r.mine.errorPct < r.theirs.errorPct).length;

  console.log(`\n${'='.repeat(64)}`);
  console.log(`\nTrained on ${lawns.length - 1} lawns, tested on the one left out, ${lawns.length} times.`);
  console.log(`\nThe trained head is ${mineMed.toFixed(1)}% out on the middle lawn.`);

  if (theirsMed !== null) {
    console.log(`SAM, on the same ${both.length} lawns, is ${theirsMed.toFixed(1)}%.`);
    console.log(`\nIt is better on ${wins} of ${both.length}.`);

    /*
     * COUNTING THE LAWNS IT WINS, NOT JUST THE MEDIAN, because at this size
     * one disastrous lawn moves a median and a majority is harder to get by
     * luck. Neither is proof at twenty; together they are an indication.
     */
    const better = mineMed < theirsMed;
    const clear = Math.abs(mineMed - theirsMed) > 3 && (wins > both.length * 0.6 || wins < both.length * 0.4);
    console.log('');
    if (better && clear) {
      console.log('WORTH BUILDING ON. It beats the detector it was trained to replace,');
      console.log('on lawns it had never seen, by enough to not be noise. The next');
      console.log('move is more maps: every one makes the next model better and this');
      console.log('measurement steadier.');
    } else if (better) {
      console.log('AHEAD, BUT NOT BY ENOUGH TO TRUST. It is better on the middle lawn,');
      console.log('and with this few lawns that can turn over on one more map. Worth');
      console.log('another run once there are ten more, before anything is built on it.');
    } else {
      console.log('NOT BETTER YET. Which is a real answer and cost nothing: the pipeline');
      console.log('works, the measurement is honest, and the features are the part to');
      console.log('change. More lawns would help; a stronger backbone would help more.');
    }
  } else {
    console.log('\nNo stored SAM outline on any of these, so there is nothing to');
    console.log('compare against -- only the trained number, which alone says little.');
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
