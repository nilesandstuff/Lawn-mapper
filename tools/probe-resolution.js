/**
 * Does asking Mapbox for more pixels get more DETAIL, or just a bigger blur?
 *
 * THE QUESTION THIS SETTLES. Every stored photograph here is 1280x1280,
 * because FRAME_SIZE is 640 logical and Mapbox is asked at @2x. One static
 * request can return 2560, so we are using half of what a single call already
 * offers. H20 says that costs real resolution on big lots: a 194 m lot is
 * stored at 15 cm a pixel, the canopy model wants 10 cm, and reaching 10 cm
 * from 15 means inventing pixels.
 *
 * The obvious fix is to ask for 2560. The obvious fix is only a fix IF MAPBOX
 * ACTUALLY HAS THAT IMAGERY. Satellite coverage has a real limit per place,
 * and past it the static API upscales its own tiles and returns them without
 * comment. Doubling the request would then move the interpolation from our
 * side to theirs, cost four times the bytes, and change nothing. That is
 * exactly the kind of improvement this project has twice argued for and then
 * measured as nothing, so it gets measured first.
 *
 * HOW YOU TELL AN UPSCALE FROM REAL DETAIL, without ground truth.
 *
 * The honest question is not "is this image sharp". It is: DOES THE BIGGER
 * REQUEST CARRY ANYTHING THE SMALLER ONE COULD NOT? So that is what is
 * measured, directly.
 *
 *   take the 2560 frame
 *   shrink it to 1280 and blow it back up to 2560, the same way any resize
 *     would
 *   whatever is left over is detail too fine for 1280 to have held
 *
 * A frame Mapbox upscaled from its own 1280-scale tiles has nothing left over:
 * every pixel was already a blend of coarser ones, so the round trip returns
 * it almost exactly. A frame sampled at its own resolution keeps real texture
 * that the smaller one cannot represent.
 *
 * WHY NOT THE OBVIOUS MEASURE, and this was caught by testing it rather than
 * by thinking about it. The first version compared neighbouring pixels against
 * pixels two apart, on the theory that an upscale is smooth between its
 * samples. It is -- but a clean 2x upscale scores 0.667 there, not the 0.5 the
 * theory predicts, and far worse, a GENUINELY SMOOTH field scores LOWER still:
 * a flat lawn or a road surface comes out at 0.5 while an upscale of a busy
 * frame comes out at 0.667. The number confounded "there is no detail here"
 * with "the detail was invented", which are opposite answers to this question.
 *
 * The residual does not have that failure. A smooth field has nothing above
 * 1280 to lose, so it scores near zero -- and that is the RIGHT answer, because
 * for a smooth field the bigger request genuinely buys nothing.
 *
 * AND THE BYTES, as a second opinion that shares no arithmetic with the first.
 * A photograph with real texture compresses badly. If four times the pixels
 * arrive in barely more bytes, there is barely more in them.
 *
 *   MAPBOX_TOKEN=... node tools/probe-resolution.js
 *
 * or workflow "20. Is more resolution available". Nothing is bought: the
 * static API is included in the same free tier the app already uses, and this
 * fetches a handful of frames.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from './corpus-db.js';

const TOKEN = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN || '';

/** How many of the biggest lots to look at. Big lots are where H20 bites. */
const HOW_MANY = Number(process.env.HOW_MANY || 6);

/* The two sizes: what we store today, and the most one request can return. */
const SIZES = [640, 1280];

/*
 * WHERE THE LINES SIT, and they are read off a test rather than chosen.
 * tools/probe-resolution.test.js runs this measure over images whose answer is
 * known: real texture scores about 0.89, the SAME content upscaled twice about
 * 0.37, and smooth ground about 0.01. So an upscale keeps roughly 40% of what
 * native keeps.
 */
const UPSCALED = 0.5;    // keeps less than this -- the extra pixels are made up
const REAL = 0.8;        // keeps more than this -- the extra pixels are imagery
const FEATURELESS = 0.05; // nothing at either size, so there is nothing to rule on

const QUERY = `
  SELECT id, county, frame
    FROM corpus
   WHERE status = 'approved' AND frame IS NOT NULL
   ORDER BY at DESC
   LIMIT 200
`;

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

const EQUATOR_M = 40075016.686;
/** Metres of ground across a frame, from its centre, zoom and logical size. */
const metresAcross = (frame) =>
  (EQUATOR_M * Math.cos((frame.lat * Math.PI) / 180) / (512 * 2 ** frame.zoom))
  * frame.size;

const url = (frame, size) =>
  'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/'
  + `${frame.lng},${frame.lat},${frame.zoom},0/${size}x${size}@2x`
  + `?access_token=${TOKEN}&attribution=false&logo=false`;

/**
 * How much of an image is finer than half its size could hold.
 *
 * Shrink by two, blow back up, and see what is left over. The leftover is
 * detail that only exists at this size. Reported as a share of the image's own
 * overall variation, so a dark frame and a bright one are comparable.
 *
 * Measured on the green channel alone. Satellite imagery is heavily correlated
 * across channels, so three would be three views of one number, and green
 * carries the most signal in vegetation -- which is most of what is here.
 *
 * Sampled on a centre crop. The edges of a static frame can carry compression
 * artefacts and a faint vignette; neither is the ground, and both would answer
 * a question about texture with a fact about the encoder.
 */
export function extraDetail(pixels, width, height, channels) {
  const x0 = Math.floor(width / 4) & ~1;
  const x1 = Math.floor((width * 3) / 4) & ~1;
  const y0 = Math.floor(height / 4) & ~1;
  const y1 = Math.floor((height * 3) / 4) & ~1;
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return null;

  const at = (x, y) => pixels[((y0 + y) * width + (x0 + x)) * channels + 1];

  /* Shrink by two: a box average, which is what any honest downsample does. */
  const hw = w >> 1, hh = h >> 1;
  const small = new Float64Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      small[y * hw + x] = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y)
        + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4;
    }
  }

  /* And back up, bilinear, which is what any honest upsample does. */
  let residual = 0, signal = 0, mean = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { mean += at(x, y); n++; }
  }
  mean /= n;

  for (let y = 0; y < h; y++) {
    const sy = Math.min(hh - 1, Math.max(0, y / 2 - 0.25));
    const y0i = Math.floor(sy), y1i = Math.min(hh - 1, y0i + 1), fy = sy - y0i;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(hw - 1, Math.max(0, x / 2 - 0.25));
      const x0i = Math.floor(sx), x1i = Math.min(hw - 1, x0i + 1), fx = sx - x0i;
      const v = small[y0i * hw + x0i] * (1 - fx) * (1 - fy)
        + small[y0i * hw + x1i] * fx * (1 - fy)
        + small[y1i * hw + x0i] * (1 - fx) * fy
        + small[y1i * hw + x1i] * fx * fy;
      residual += Math.abs(at(x, y) - v);
      signal += Math.abs(at(x, y) - mean);
    }
  }
  if (!signal) return null;
  return { extra: residual / signal, residual: residual / n };
}

/**
 * What to call one lawn, from the two detail figures.
 *
 * SEPARATED OUT SO IT CAN BE TESTED WITHOUT A NETWORK. Both times this file
 * has failed in CI it failed in the reporting, not the arithmetic -- once on a
 * renamed field, once on an undefined spread -- and neither needed Mapbox to
 * catch. A run costs two minutes and a round trip; this costs nothing.
 */
export function verdictFor(smallExtra, bigExtra) {
  const keeps = smallExtra ? bigExtra / smallExtra : 0;
  if (smallExtra < FEATURELESS && bigExtra < FEATURELESS) {
    return { keeps, verdict: 'flat, cannot tell' };
  }
  if (keeps < UPSCALED) return { keeps, verdict: 'UPSCALED' };
  if (keeps < REAL) return { keeps, verdict: 'partly real' };
  return { keeps, verdict: 'real detail' };
}

async function fetchOne(frame, size, decoders) {
  const res = await fetch(url(frame, size));
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  /* Mapbox answers PNG for this style; decode whichever arrives rather than
     assuming, because a wrong assumption here would look like a bad frame. */
  const png = buf[0] === 0x89 && buf[1] === 0x50;
  const img = png
    ? decoders.png.PNG.sync.read(buf)
    : decoders.jpeg.decode(buf, { useTArray: true });
  const detail = extraDetail(img.data, img.width, img.height, 4);
  /* A frame with no variation at all -- a solid tile, or a failed fetch that
     decoded anyway -- has nothing to measure. Refused here rather than spread
     into an object whose `extra` is then undefined, which is how this file
     crashed twice. */
  if (!detail) return { ok: false, reason: 'no-variation' };
  return {
    ok: true,
    bytes: buf.length,
    width: img.width,
    height: img.height,
    ...detail,
  };
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

  const rows = query(QUERY)
    .map((r) => ({ ...r, f: parse(r.frame) }))
    .filter((r) => r.f && Number.isFinite(r.f.zoom))
    .map((r) => ({ ...r, across: metresAcross(r.f) }))
    .sort((a, b) => b.across - a.across)
    .slice(0, HOW_MANY);

  if (!rows.length) {
    console.log('No approved maps with a frame to probe.');
    process.exitCode = 1;
    return;
  }

  console.log(`The ${rows.length} biggest lots, which are where H20 bites.\n`);
  const results = [];

  for (const row of rows) {
    const label = String(row.county || 'traced by hand').padEnd(20).slice(0, 20);
    const got = {};
    let failed = '';
    for (const size of SIZES) {
      const r = await fetchOne(row.f, size, decoders);
      if (!r.ok) { failed = r.reason; continue; }
      got[size] = r;
    }
    if (failed || !got[640] || !got[1280]) {
      console.log(`  ${label} ${row.across.toFixed(0).padStart(4)} m   ${failed || 'no pair'}`);
      continue;
    }

    /*
     * A VERDICT PER LAWN, not just a number, because this varies BY PLACE.
     * Mapbox stitches its satellite layer out of many sources and the real
     * resolution differs from one address to the next, so a single median over
     * the corpus would average a sharp city lot together with a coarse rural
     * one and describe neither.
     */
    const { keeps, verdict } = verdictFor(got[640].extra, got[1280].extra);
    results.push({ across: row.across, ...got, keeps, verdict });
    console.log(
      `  ${label} ${row.across.toFixed(0).padStart(4)} m  `
      + ` 1280:${got[640].extra.toFixed(3)}`
      + ` 2560:${got[1280].extra.toFixed(3)}`
      + ` keeps ${(100 * keeps).toFixed(0).padStart(3)}%`
      + `  ${verdict}`
    );
  }

  if (!results.length) {
    console.log('\nNothing came back to compare.');
    process.exitCode = 1;
    return;
  }

  /* ---------------------------------------------------- the end of the log */
  const tally = (v) => results.filter((r) => r.verdict === v).length;
  const upscaled = tally('UPSCALED');
  const real = tally('real detail');
  const partly = tally('partly real');
  const flat = tally('flat, cannot tell');
  const bytes = results.map((r) => (r[1280].bytes / r[1280].width ** 2)
    / (r[640].bytes / r[640].width ** 2));
  const mid = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

  console.log(`\n${'='.repeat(64)}\n`);
  console.log('THE QUESTION: if we ask Mapbox for 2560 px instead of 1280,');
  console.log('do we get more detail, or the same picture stretched?\n');
  console.log(`  real detail        ${String(real).padStart(2)} lawns`);
  console.log(`  partly real        ${String(partly).padStart(2)} lawns`);
  console.log(`  UPSCALED           ${String(upscaled).padStart(2)} lawns`);
  console.log(`  flat, cannot tell  ${String(flat).padStart(2)} lawns`);
  console.log(`\nBytes per pixel, 2560 against 1280: ${mid(bytes).toFixed(2)}x`);

  /*
   * COUNTED, NOT AVERAGED, and that is the whole shape of this answer.
   *
   * Mapbox stitches its satellite layer out of many sources -- Maxar here, a
   * state orthophoto there, something older somewhere else -- so the real
   * resolution is a fact about the ADDRESS, not about Mapbox. A median over
   * the corpus would average a sharp suburban lot together with a coarse rural
   * one and describe neither, and the decision this informs is per-lawn
   * anyway: ask for more pixels where more pixels exist.
   */
  console.log('\nTHIS VARIES BY PLACE, which is why they are counted rather than');
  console.log('averaged. Mapbox stitches its satellite layer from many sources,');
  console.log('so the resolution actually available is a fact about the address.');

  if (upscaled + flat === results.length) {
    console.log('\nVERDICT: NO, nowhere in this sample. Every frame that could be');
    console.log('ruled on is Mapbox upscaling its own tiles. A bigger request');
    console.log('would cost four times the bytes in R2, move the interpolation');
    console.log('from our side to theirs, and change nothing. The other half of');
    console.log('H20 needs different imagery -- NAIP, or a county orthophoto');
    console.log('service -- not a bigger request.');
  } else if (real + partly >= upscaled) {
    console.log(`\nVERDICT: YES, on ${real + partly} of ${results.length}. Those lawns have real`);
    console.log('imagery we are not asking for. Worth raising the stored frame --');
    console.log('PER LAWN, not globally, since asking everywhere would pay four');
    console.log('times the bytes on the lawns where it buys nothing.');
  } else {
    console.log(`\nVERDICT: SOMETIMES. ${real + partly} of ${results.length} have detail we are not`);
    console.log('asking for and the rest do not, so a global change is the wrong');
    console.log('shape: it would pay four times the bytes everywhere to help a');
    console.log('minority. Ask per lawn, where the detail is there.');
  }

  /*
   * AND THE CONSEQUENCE FOR H20, which is bigger than this workflow.
   *
   * H20 puts the upsampling crossover at 128 m across, worked out from the
   * stored frame being 1280 px. That assumes the stored frame carries 1280 px
   * of REAL detail. Where Mapbox is already upscaling, it does not -- so the
   * true crossover is lower there, and `sourceMpp` in every canopy run is
   * optimistic for those lawns.
   */
  if (upscaled) {
    console.log(`\nAND A CAVEAT ON H20: ${upscaled} of these lawns are ALREADY upscaled at`);
    console.log('1280 px. H20 puts the crossover at 128 m across on the assumption');
    console.log('that a stored 1280 px frame holds 1280 px of real detail. Where');
    console.log('Mapbox is stretching, it does not -- so for those lawns the real');
    console.log('crossover is lower and every sourceMpp figure is optimistic.');
    console.log('The crossover is a fact about the address, not one number.');
  }

  console.log('\nThis is a proxy and it is measured, not assumed: the same');
  console.log('arithmetic over images whose answer is known is in');
  console.log('tools/probe-resolution.test.js.');
  console.log(`\n${'='.repeat(64)}`);
}

/* Guarded, like every other tool here, so the arithmetic above can be tested
   without the module going and fetching things on import. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log('Stopped:', e.message);
    process.exitCode = 1;
  });
}
