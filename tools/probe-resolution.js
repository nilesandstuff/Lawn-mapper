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
  const channels = png ? 4 : 4;
  return {
    ok: true,
    bytes: buf.length,
    width: img.width,
    height: img.height,
    ...extraDetail(img.data, img.width, img.height, channels),
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
    const label = String(row.county || 'traced by hand').padEnd(22).slice(0, 22);
    const line = [`  ${label} ${row.across.toFixed(0).padStart(4)} m across`];
    const got = {};
    for (const size of SIZES) {
      const r = await fetchOne(row.f, size, decoders);
      if (!r.ok) { line.push(`  ${size * 2}px: ${r.reason}`); continue; }
      got[size] = r;
      const mpp = row.across / r.width;
      line.push(
        `  ${String(r.width).padStart(4)}px ${(mpp * 100).toFixed(1).padStart(5)} cm/px`
        + ` detail ${r.ratio.toFixed(3)}`
        + ` ${(r.bytes / 1024).toFixed(0).padStart(4)} KB`
      );
    }
    console.log(line.join(''));
    if (got[640] && got[1280]) {
      results.push({
        across: row.across,
        small: got[640],
        big: got[1280],
        bytesPerPx: (got[1280].bytes / got[1280].width ** 2)
          / (got[640].bytes / got[640].width ** 2),
      });
    }
  }

  if (!results.length) {
    console.log('\nNothing came back to compare.');
    process.exitCode = 1;
    return;
  }

  /* ---------------------------------------------------- the end of the log */
  const mid = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const smallE = mid(results.map((r) => r.small.extra));
  const bigE = mid(results.map((r) => r.big.extra));
  const bytes = mid(results.map((r) => r.bytesPerPx));
  const keeps = smallE ? bigE / smallE : 0;

  console.log(`\n${'='.repeat(64)}\n`);
  console.log('THE QUESTION: if we ask Mapbox for 2560 px instead of 1280,');
  console.log('do we get more detail, or the same picture stretched?\n');
  console.log(`Detail only that size can hold, at 1280 px: ${smallE.toFixed(3)}`);
  console.log(`Detail only that size can hold, at 2560 px: ${bigE.toFixed(3)}`);
  console.log(`  the bigger frame keeps ${(100 * keeps).toFixed(0)}% as much`);
  console.log(`Bytes per pixel, 2560 against 1280: ${bytes.toFixed(2)}x\n`);

  /*
   * THE VERDICT IS STATED, not left to be inferred from two decimals, because
   * this is read on a phone at the end of a log.
   *
   * THE THRESHOLD IS ANCHORED ON A TEST, not picked. tools/probe-resolution
   * .test.js runs this measure over four images whose answer is known: real
   * texture scores about 0.89, the SAME content upscaled twice scores about
   * 0.37, and smooth ground scores near 0.01. So an upscale keeps roughly 40%
   * of what native keeps, and half is a fair line between the two.
   *
   * SMOOTH GROUND IS NOT A FAILURE HERE. A flat lawn has nothing above 1280 to
   * lose and scores near zero at both sizes -- and that is the right answer,
   * because for flat ground the bigger request genuinely buys nothing. It does
   * make `keeps` noisy when both numbers are tiny, which is why the absolute
   * figures are printed beside it rather than the ratio alone.
   */
  if (smallE < 0.05 && bigE < 0.05) {
    console.log('VERDICT: CANNOT TELL. Both frames are nearly featureless at');
    console.log('this scale, so there is no detail for either size to carry and');
    console.log('the comparison has nothing to work with. Try lots with trees');
    console.log('or buildings on them rather than open ground.');
  } else if (keeps < 0.5) {
    console.log('VERDICT: NO. The bigger frame is Mapbox upscaling its own');
    console.log('tiles. Asking for it would cost four times the bytes in R2,');
    console.log('move the interpolation from our side to theirs, and change');
    console.log('nothing. The other half of H20 needs different imagery -- NAIP,');
    console.log('or a county orthophoto service -- not a bigger request.');
  } else if (keeps < 0.8) {
    console.log('VERDICT: PARTLY. The bigger frame carries real detail but less');
    console.log('per pixel than the smaller one, so some is genuine and some is');
    console.log('stretch. Worth it on the big lots, where H20 bites, and not');
    console.log('worth the bytes on the small ones that are already fine enough.');
  } else {
    console.log('VERDICT: YES. The bigger frame is as informative per pixel as');
    console.log('the smaller one, so those pixels are real imagery. Raising the');
    console.log('stored frame closes the other half of H20 -- at four times the');
    console.log('bytes in R2, which is the cost to weigh against it.');
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
