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

/*
 * THE ZOOM HAS TO MOVE WITH THE SIZE, and the first two runs of this file did
 * not do that. They are void because of it.
 *
 * In the Mapbox static API the ground a frame covers is
 *
 *     size * EQUATOR_M * cos(lat) / (512 * 2^zoom)
 *
 * so ground per RETURNED pixel is EQUATOR_M * cos(lat) / (512 * 2^zoom * 2) --
 * a function of the ZOOM ALONE. Asking for a bigger `size` at a fixed zoom
 * does not sharpen anything; it widens the frame. Measured: at z19, sizes 320,
 * 640 and 1280 all come back at 5.47 cm a pixel, covering 35 m, 70 m and 140 m
 * of ground.
 *
 * So the first two runs compared three DIFFERENT AREAS at one resolution and
 * read the differences as detail. A wider crop simply contains more varied
 * scenery than a narrow one, which is what those numbers were.
 *
 * Holding the ground fixed while changing the resolution means moving both
 * together: one zoom step up and twice the size is the same lot at twice the
 * linear resolution. 1280 logical is Mapbox's ceiling for one request, so with
 * a 640-logical frame these three are the whole available range.
 */
const STEPS = [
  { dz: -1, scale: 0.5 },  // the same lot, half the resolution
  { dz: 0, scale: 1 },     // the same lot, as we store it today
  { dz: 1, scale: 2 },     // the same lot, twice the resolution -- the question
];

/** Mapbox will not serve a static image wider than this many logical pixels. */
const MAX_LOGICAL = 1280;

/*
 * WHERE THE LINES SIT, AND WHY THEY ARE RATIOS RATHER THAN ABSOLUTE VALUES.
 *
 * tools/probe-resolution.test.js runs this measure over images whose answer is
 * known: real texture scores about 0.89, the SAME content upscaled twice about
 * 0.37, smooth ground about 0.01. The tempting reading is "above 0.4 is real".
 *
 * IT DOES NOT TRANSFER, and the first real run proved it. Actual Mapbox frames
 * score 0.017 to 0.164 -- every one of them BELOW the synthetic upscale's 0.37
 * -- because aerial photography is vastly smoother than white noise. An
 * absolute threshold calibrated on made-up images would have called every real
 * frame an upscale.
 *
 * What does transfer is the RATIO between one size and the next on the SAME
 * scene, because interpolation halves the detail by construction whatever the
 * content: the synthetic upscale keeps 37/89 = 42% of native. So the steps are
 * compared against each other and the absolute figures are used only to say
 * when both are too small to divide.
 */
const STRETCHED = 0.5;   // a step keeping less than this gained nothing real
const GAINING = 0.8;     // a step keeping this much is still real imagery
const FEATURELESS = 0.03; // too little at both ends of a step to divide them

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

/**
 * The same ground as `frame`, at a different resolution.
 *
 * Both the zoom and the size move, which is the whole correction: one zoom
 * step doubles the pixels per metre, and doubling the size keeps the frame
 * over the same lot rather than widening it.
 */
const stepFrame = (frame, { dz, scale }) => ({
  lng: frame.lng,
  lat: frame.lat,
  zoom: frame.zoom + dz,
  size: Math.round(frame.size * scale),
});

const url = (f) =>
  'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/'
  + `${f.lng},${f.lat},${f.zoom},0/${f.size}x${f.size}@2x`
  + `?access_token=${TOKEN}&attribution=false&logo=false`;

/* extraDetail moved to public/lib/sharpness.js, so the editor can use it too. */
export { extraDetail } from '../public/lib/sharpness.js';

/**
 * What to call one lawn, from the two detail figures.
 *
 * SEPARATED OUT SO IT CAN BE TESTED WITHOUT A NETWORK. Both times this file
 * has failed in CI it failed in the reporting, not the arithmetic -- once on a
 * renamed field, once on an undefined spread -- and neither needed Mapbox to
 * catch. A run costs two minutes and a round trip; this costs nothing.
 */
export function verdictFor(extras) {
  const [at640, at1280, at2560] = extras;

  /*
   * ONE STEP OF THE STAIRCASE: did going from one size to the next gain
   * anything? `null` when both ends are too small to divide -- a ratio of two
   * numbers near zero is noise, and reporting it as a verdict about Mapbox is
   * how flat ground would become a complaint.
   */
  const step = (lower, upper) => {
    if (lower < FEATURELESS && upper < FEATURELESS) return null;
    if (!lower) return 0;
    return upper / lower;
  };
  const toMid = step(at640, at1280);
  const toTop = step(at1280, at2560);

  /*
   * EACH FIGURE STANDS ALONE, which is what lets three of them be read as a
   * staircase. `extra` asks one question of one image: how much of it is finer
   * than half its size could have held. A frame at its own native resolution
   * answers with real texture; a frame a provider stretched to that size
   * answers with almost nothing, because every pixel in it was already a blend
   * of coarser ones.
   *
   * So the biggest size still answering substantially is the ceiling for that
   * address.
   */
  /* Nothing measurable at any step: open grass or a bare field. No request
     buys anything on it, which is a fact about the lawn rather than about the
     imagery, and must not be reported as stretching. */
  if (toMid === null && toTop === null) {
    return { ceiling: null, toMid, toTop, verdict: 'flat ground, nothing to gain' };
  }

  /* The stored frame is already interpolated: going to 1280 gained little.
     This is the case that makes H20's crossover wrong for a lawn. */
  if (toMid !== null && toMid < STRETCHED) {
    return { ceiling: 640, toMid, toTop, verdict: 'ALREADY STRETCHED at 1280' };
  }

  if (toTop === null) {
    return { ceiling: 1280, toMid, toTop, verdict: '1280 real, 2560 unreadable' };
  }
  if (toTop >= GAINING) {
    return { ceiling: 2560, toMid, toTop, verdict: 'real detail at 2560' };
  }
  if (toTop >= STRETCHED) {
    return { ceiling: 2560, toMid, toTop, verdict: 'some detail at 2560' };
  }
  return { ceiling: 1280, toMid, toTop, verdict: '1280 is the ceiling' };
}

async function fetchOne(f, decoders) {
  const res = await fetch(url(f));
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
    const frames = STEPS.map((step) => stepFrame(row.f, step));

    /* Past Mapbox's own ceiling there is nothing to ask for, and a refused
       request is not evidence about the imagery. Said, not skipped silently. */
    if (frames.some((f) => f.size > MAX_LOGICAL)) {
      console.log(`  ${label} ${row.across.toFixed(0).padStart(4)} m  `
        + `  the top step needs ${frames[2].size} logical px, past Mapbox's ${MAX_LOGICAL}`);
      continue;
    }

    const got = [];
    let failed = '';
    for (const f of frames) {
      const r = await fetchOne(f, decoders);
      if (!r.ok) { failed = r.reason; break; }
      got.push(r);
    }
    if (failed || got.length !== STEPS.length) {
      console.log(`  ${label} ${row.across.toFixed(0).padStart(4)} m   ${failed || 'incomplete'}`);
      continue;
    }

    /*
     * A VERDICT PER LAWN, because this varies BY PLACE. Mapbox stitches its
     * satellite layer out of many sources and the real resolution differs from
     * one address to the next, so a single median over the corpus would
     * average a sharp suburban lot together with a coarse rural one and
     * describe neither.
     */
    const extras = got.map((g) => g.extra);
    const { ceiling, verdict } = verdictFor(extras);
    results.push({ across: row.across, got, ceiling, verdict });

    /* Ground per pixel at the middle step, which is what we store today. */
    const cm = (100 * row.across) / got[1].width;
    console.log(
      `  ${label} ${row.across.toFixed(0).padStart(4)} m`
      + ` ${cm.toFixed(1).padStart(5)} cm/px  `
      + `${got.map((g, i) => `${g.width}:${extras[i].toFixed(3)}`).join(' ')}`
      + `   ${verdict}`
    );
  }

  /* ---------------------------------------------------- the end of the log */
  const tally = (c) => results.filter((r) => r.ceiling === c).length;
  const can2560 = tally(2560);
  const cap1280 = tally(1280);
  const stretched = tally(640);
  const flat = results.filter((r) => r.ceiling === null).length;
  const bytes = results.map((r) => (r.got[2].bytes / r.got[2].width ** 2)
    / (r.got[1].bytes / r.got[1].width ** 2));
  const mid = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

  console.log(`\n${'='.repeat(64)}\n`);
  console.log('HOW MUCH RESOLUTION EACH ADDRESS ACTUALLY HAS.\n');
  console.log(`  real detail up to 2560 px   ${String(can2560).padStart(2)} lawns  <- we could ask for more`);
  console.log(`  1280 is the ceiling         ${String(cap1280).padStart(2)} lawns  <- we already ask for all of it`);
  console.log(`  ALREADY STRETCHED at 1280   ${String(stretched).padStart(2)} lawns  <- the stored frame is interpolated`);
  console.log(`  flat ground, nothing to gain ${String(flat).padStart(1)} lawns  <- no request buys anything`);
  console.log(`\nBytes per pixel, one zoom step up against what we store: ${mid(bytes).toFixed(2)}x`);

  console.log('\nTHIS IS A FACT ABOUT THE ADDRESS, not about Mapbox. Their');
  console.log('satellite layer is stitched from many sources -- one place has a');
  console.log('recent survey, the next has something older and coarser -- which');
  console.log('is why these are counted rather than averaged.');

  if (can2560) {
    console.log(`\nWORTH ASKING FOR MORE on ${can2560} of ${results.length}: those have imagery we are`);
    console.log('not requesting. PER LAWN, not globally -- asking everywhere would');
    console.log('pay four times the bytes in R2 on the lawns where it buys nothing.');
  } else {
    console.log('\nNOT WORTH ASKING FOR MORE anywhere in this sample. A bigger');
    console.log('request would move the interpolation from our side to theirs and');
    console.log('cost four times the bytes. The other half of H20 needs different');
    console.log('imagery -- NAIP, or a county orthophoto service -- not more pixels.');
  }

  /*
   * THE CONSEQUENCE FOR H20, which is bigger than this workflow.
   *
   * H20 puts the upsampling crossover at 128 m across, worked out from the
   * stored frame being 1280 px. That assumes 1280 px of REAL detail. For a
   * lawn where Mapbox was already stretching, it is not -- the true crossover
   * is lower and `sourceMpp` in every canopy run is optimistic for it.
   */
  if (stretched) {
    console.log(`\nAND A CAVEAT ON H20: ${stretched} of these are already stretched at 1280.`);
    console.log('H20 puts the crossover at 128 m across assuming a stored 1280 px');
    console.log('frame holds 1280 px of real detail. Where Mapbox is stretching it');
    console.log('does not, so for those lawns the real crossover is LOWER and every');
    console.log('sourceMpp figure is optimistic.');
  } else {
    console.log("\nH20's crossover holds for this sample: none of these lawns was");
    console.log('already stretched at 1280, so a stored frame here really does');
    console.log('carry 1280 px of detail.');
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
