/**
 * Ground-truth tests for the features and the head.
 *
 * WHY THESE MATTER MORE THAN MOST. Everything in these two files is arithmetic
 * that cannot throw. A colour index with its terms reversed, a window running
 * off the edge, a normalisation applied at training and skipped at prediction:
 * each of those produces a model that scores badly, and a model that scores
 * badly is indistinguishable from a problem that is hard. The whole point of
 * the exercise is to find out whether twenty lawns is enough, and a silent bug
 * here would answer "no" convincingly and wrongly.
 *
 * So every check below builds data whose right answer is known by
 * construction, rather than asserting that the code returns what it returns.
 *
 *   node tools/learner.test.js
 */

import {
  imageFeatures, featureStats, standardise, FEATURE_COUNT, FEATURE_NAMES,
} from '../public/lib/features.js';
import { train, predict, balanceWeights } from './learner.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

/* A flat RGBA image of one colour, with an optional patch painted in. */
function image(w, h, [r, g, b]) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  return px;
}
/*
 * The scale every synthetic frame here is pretended to be at.
 *
 * It has to be given, because the feature windows are distances on the ground
 * rather than pixel counts -- 12 cm a cell is what a typical lawn in the corpus
 * comes out at (H1), so these tests see roughly the windows a real frame does.
 */
const MPP = { mpp: 0.12 };

const paint = (px, w, x0, y0, pw, ph, [r, g, b]) => {
  for (let y = y0; y < y0 + ph; y++) {
    for (let x = x0; x < x0 + pw; x++) {
      const i = (y * w + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
    }
  }
};

/* ------------------------------------------------------------- features */
{
  console.log('--- what a pixel looks like ---');

  check('the names and the count agree',
    FEATURE_NAMES.length === FEATURE_COUNT,
    `${FEATURE_NAMES.length} names for ${FEATURE_COUNT} columns -- a report `
    + 'that labels the wrong column is worse than one with no labels');

  const W = 32, H = 32;
  const grass = imageFeatures(image(W, H, [70, 120, 60]), W, H, MPP);
  const road = imageFeatures(image(W, H, [130, 130, 128]), W, H, MPP);
  const mid = (16 * W + 16) * FEATURE_COUNT;

  /*
   * EXCESS GREEN IS THE ONE THAT HAS TO BE RIGHT. 2G - R - B, positive on
   * vegetation and about zero on anything grey. With the terms transposed it
   * would still be a number, still train, and still be useless.
   */
  check('grass reads positive on excess green',
    grass[mid + 3] > 0.1, `${grass[mid + 3].toFixed(3)}`);
  check('and grey asphalt reads about zero',
    Math.abs(road[mid + 3]) < 0.02, `${road[mid + 3].toFixed(3)}`);

  /*
   * TEXTURE, WHICH IS THE OTHER HALF OF THE ANSWER. A lawn is rough at a few
   * pixels and a driveway is not, so a flat image must report no roughness and
   * a speckled one must report some -- at the same average brightness, or the
   * check would pass on brightness alone.
   */
  const flat = image(W, H, [120, 120, 120]);
  const speckled = image(W, H, [120, 120, 120]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((x + y) % 2) continue;
      const i = (y * W + x) * 4;
      speckled[i] = speckled[i + 1] = speckled[i + 2] = 160;
    }
  }
  const fF = imageFeatures(flat, W, H, MPP);
  const sF = imageFeatures(speckled, W, H, MPP);
  /*
   * Compared against the speckled patch rather than against zero. Colours are
   * held as Float32, so a "flat" patch carries a little rounding and its
   * variance lands around 1e-4 rather than on 0 -- which is not a fault to fix,
   * it is the floor of the arithmetic. What has to be true is that the floor is
   * nowhere near the signal, and a ratio says that where an absolute threshold
   * would just be a number somebody tuned until it passed.
   */
  check('a speckled patch reads far rougher than a flat one',
    sF[mid + 8] > 100 * fF[mid + 8] && sF[mid + 8] > 0.05,
    `flat ${fF[mid + 8].toExponential(2)} against speckled ${sF[mid + 8].toFixed(3)}`);
  check('roughness is never NaN on a perfectly flat patch',
    Number.isFinite(fF[mid + 8]),
    'variance can go microscopically negative in floating point, and the '
    + 'square root of that poisons every weight downstream');

  /*
   * THE WINDOW MUST NOT RUN OFF THE EDGE. A corner pixel has a quarter of a
   * window available, and reading past it gives zeroes that look like a dark,
   * smooth border -- a fake feature around every image, learnt as if real.
   */
  const corner = 0;
  const cornerFeat = imageFeatures(image(W, H, [70, 120, 60]), W, H, MPP);
  check('a corner pixel is averaged over what exists, not over zeroes',
    Math.abs(cornerFeat[corner + 7] - cornerFeat[mid + 7]) < 1e-6,
    'on a uniform image every pixel must report the same local mean, corners '
    + 'included');

  /*
   * THE NEIGHBOURHOOD FEATURE HAS TO SEE FURTHER THAN THE FINE ONE, which is
   * what makes grass in shadow recoverable: dark, but surrounded by lawn.
   */
  const shadow = image(W, H, [70, 120, 60]);
  paint(shadow, W, 14, 14, 4, 4, [30, 45, 28]);
  const sh = imageFeatures(shadow, W, H, MPP);
  check('a shadowed pixel still sees green around it',
    sh[mid + 9] > 0.1,
    `neighbourhood green ${sh[mid + 9].toFixed(3)} while the pixel itself is dark`);

  /*
   * ---------------------------------------------------------------------
   * THE THREE COLUMNS AIMED AT THE BIGGEST NUMBER IN THE ERROR TABLE.
   *
   * Hard-rimmed shade -- a building's shadow -- scores 27 to 41 points worse
   * than soft-rimmed shade thrown by a tree (H12 in docs/DETECTOR-FINDINGS.md).
   * These check that each new column does the job it was added for, on data
   * whose right answer is known by construction. An untested feature column is
   * a number the model will happily learn noise from.
   * ---------------------------------------------------------------------
   */

  /*
   * NORMALISED EXCESS GREEN SURVIVES THE SHADOW AND THE RAW ONE DOES NOT.
   *
   * The same grass at a quarter of the light: in shade r, g and b all shrink
   * together, so 2G-R-B shrinks with them while (2G-R-B)/(R+G+B) does not.
   * That is the whole argument for the column, so it is the test.
   */
  const litGrass = imageFeatures(image(W, H, [80, 140, 64]), W, H, MPP);
  const darkGrass = imageFeatures(image(W, H, [20, 35, 16]), W, H, MPP);
  const rawDrop = Math.abs(darkGrass[mid + 3] - litGrass[mid + 3]);
  const normDrop = Math.abs(darkGrass[mid + 11] - litGrass[mid + 11]);
  check('raw excess green collapses when the light goes',
    rawDrop > 0.2,
    `${litGrass[mid + 3].toFixed(3)} in sun against ${darkGrass[mid + 3].toFixed(3)} in shade`);
  check('and the normalised one holds, which is why it was added',
    normDrop < rawDrop / 4,
    `${litGrass[mid + 11].toFixed(3)} against ${darkGrass[mid + 11].toFixed(3)} `
    + `-- a drop of ${normDrop.toFixed(3)} where the raw column drops ${rawDrop.toFixed(3)}`);

  /*
   * DARK BECAUSE OF A SHADOW, OR DARK BECAUSE IT IS A DARK THING?
   *
   * Nothing in the old vector could tell those apart, and it is exactly the
   * question a building's shadow asks. Two frames, both with a dark patch of
   * identical colour: in one the patch is most of the frame (a shadow), in the
   * other it is a lone dark object on bright ground (a wet drive, a flat roof).
   * The pixel is identical in both; only the region differs.
   */
  const bigShadow = image(W, H, [200, 200, 195]);
  paint(bigShadow, W, 0, 0, W, 24, [40, 44, 38]);       // most of the frame, dark
  const loneObject = image(W, H, [200, 200, 195]);
  paint(loneObject, W, 14, 14, 4, 4, [40, 44, 38]);     // one small dark thing

  const inShadow = imageFeatures(bigShadow, W, H, MPP);
  const onObject = imageFeatures(loneObject, W, H, MPP);
  const probe = (16 * W + 16) * FEATURE_COUNT;

  check('the pixel itself is identical in both, so the old columns cannot help',
    Math.abs(inShadow[probe + 5] - onObject[probe + 5]) < 1e-6,
    `brightness ${inShadow[probe + 5].toFixed(4)} either way`);
  check('but regional brightness tells a shadow from a dark object',
    inShadow[probe + 12] < onObject[probe + 12] / 2,
    `${inShadow[probe + 12].toFixed(3)} inside a shadow against `
    + `${onObject[probe + 12].toFixed(3)} for a lone dark thing`);
  check('and the ratio says the shadowed one is not unusually dark for where it is',
    inShadow[probe + 13] > 2 * onObject[probe + 13],
    `${inShadow[probe + 13].toFixed(3)} against ${onObject[probe + 13].toFixed(3)}`);
}

/* ------------------------------------------- the windows are distances */
{
  console.log('\n--- the windows are metres, not pixels ---');

  /*
   * THE BUG THIS PINS. The windows were fixed pixel counts, so a 15x15 window
   * was 75 cm on a small lot and 5.7 m on a large one (H1: 5-38 cm a cell).
   * "Is this ground rough" was therefore a different question per lawn, and the
   * model was asked to learn one answer to all of them.
   *
   * Two frames of the SAME GROUND at different scales: a stripe pattern whose
   * period is fixed in metres. Read with metric windows, the texture column
   * should agree between them; read with pixel windows it cannot.
   */
  const W = 64, H = 64;
  const striped = (periodPx) => {
    const px = image(W, H, [110, 110, 110]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (Math.floor(x / periodPx) % 2 === 0) continue;
        const i = (y * W + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = 150;
      }
    }
    return px;
  };

  /* 0.5 m stripes, seen at two resolutions: 4 px at 12.5 cm, 8 px at 6.25 cm. */
  const coarseView = imageFeatures(striped(4), W, H, { mpp: 0.125 });
  const fineView = imageFeatures(striped(8), W, H, { mpp: 0.0625 });
  const at = (f, x, y, col) => f[(y * W + x) * FEATURE_COUNT + col];

  /* Sampled at the same place on the pattern in both: the middle of a stripe. */
  const rough1 = at(coarseView, 34, 32, 8);
  const rough2 = at(fineView, 36, 32, 8);
  check('the same ground at two scales reads about the same roughness',
    Math.abs(rough1 - rough2) < 0.3 * Math.max(rough1, rough2),
    `${rough1.toFixed(4)} at 12.5 cm a pixel against ${rough2.toFixed(4)} at 6.25 `
    + '-- with windows counted in pixels these could not agree');

  /*
   * AND THE SCALE IS NOT OPTIONAL. Leaving it out used to be silently possible
   * and would have meant the model reading one set of windows in training and
   * another in the app -- no error, no wrong-looking output, just a worse
   * model that looks like a harder problem.
   */
  let threw = false;
  try { imageFeatures(striped(4), W, H); } catch { threw = true; }
  check('and a caller that forgets the scale is told, not quietly served',
    threw, 'a default here would be a different feature vector in each caller');
}

/* --------------------------------------------------------- standardising */
{
  console.log('\n--- putting the columns on one scale ---');

  const rows = new Float32Array([1, 10, 2, 20, 3, 30]);
  const stats = featureStats(rows, 2);
  check('the mean of each column is its own mean',
    Math.abs(stats.mean[0] - 2) < 1e-9 && Math.abs(stats.mean[1] - 20) < 1e-9,
    `${stats.mean[0]}, ${stats.mean[1]}`);

  const copy = Float32Array.from(rows);
  standardise(copy, stats, 2);
  check('and standardising centres it',
    Math.abs(copy[0] + copy[2] + copy[4]) < 1e-5,
    'the three values of column one should now sum to zero');

  /*
   * A CONSTANT COLUMN HAS NO SPREAD. Dividing by it gives Infinity, which
   * reaches every weight in one step and ends training with a model of NaN.
   */
  const flat = new Float32Array([5, 1, 5, 2, 5, 3]);
  const flatStats = featureStats(flat, 2);
  standardise(flat, flatStats, 2);
  check('a column that never varies does not become Infinity',
    Number.isFinite(flat[0]) && Number.isFinite(flat[2]),
    `${flat[0]}, ${flat[2]}`);
}

/* -------------------------------------------------------------- the head */
{
  console.log('\n--- the head ---');

  /*
   * A PROBLEM WITH A KNOWN ANSWER: two clouds of points either side of a line
   * that is not axis-aligned. If the head cannot separate this, nothing it
   * reports about lawns means anything.
   */
  const N = 4000;
  const inputs = 2;
  const x = new Float32Array(N * inputs);
  const y = new Float32Array(N);
  let s = 7;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < N; i++) {
    const a = rand() * 4 - 2;
    const b = rand() * 4 - 2;
    x[i * inputs] = a;
    x[i * inputs + 1] = b;
    y[i] = a + b > 0 ? 1 : 0;
  }
  const model = train(x, y, null, { inputs, hidden: 8, epochs: 8, seed: 3 });
  const p = predict(model, x);
  let right = 0;
  for (let i = 0; i < N; i++) if ((p[i] > 0.5 ? 1 : 0) === y[i]) right++;
  check('it learns a boundary it can actually represent',
    right / N > 0.95, `${((100 * right) / N).toFixed(1)}% right`);

  /* Same seed, same answer, or no comparison between runs means anything. */
  const again = train(x, y, null, { inputs, hidden: 8, epochs: 8, seed: 3 });
  check('and the same seed gives the same model',
    again.W2.every((v, i) => v === model.W2[i]),
    'without this, "it improved by a point" cannot be told from a reshuffle');
  const other = train(x, y, null, { inputs, hidden: 8, epochs: 8, seed: 4 });
  check('while a different seed gives a different one',
    !other.W2.every((v, i) => v === model.W2[i]),
    'identical output from different seeds would mean the seed is ignored');

  /*
   * THE IMBALANCE TRAP, which is the failure that looks like success. If one
   * answer is nine tenths of the data, "always say no" is 90% accurate and is
   * what plain training finds. Weighting is what stops it.
   */
  const M = 3000;
  const xi = new Float32Array(M * inputs);
  const yi = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const rare = i % 10 === 0;
    xi[i * inputs] = rare ? 1 + rand() * 0.5 : -1 + rand() * 0.5;
    xi[i * inputs + 1] = rand();
    yi[i] = rare ? 1 : 0;
  }
  const w = balanceWeights(yi);
  const balanced = train(xi, yi, w, { inputs, hidden: 8, epochs: 10, seed: 5 });
  const pb = predict(balanced, xi);
  let foundRare = 0, rare = 0;
  for (let i = 0; i < M; i++) {
    if (!yi[i]) continue;
    rare++;
    if (pb[i] > 0.5) foundRare++;
  }
  check('the rarer answer is still found when it is one pixel in ten',
    foundRare / rare > 0.9,
    `${foundRare}/${rare} of the rare class -- unweighted, "always no" scores `
    + '90% and finds none of them');

  /*
   * A WIDE FEATURE SET MUST STILL TRAIN.
   *
   * One step moves the sum feeding each unit by about the rate times the
   * squared length of the input row, and with standardised features that grows
   * with the width. A rate that settles on eleven numbers a pixel overshoots
   * on two hundred -- and overshooting does not look like a worse score, it
   * looks like a model that has stopped answering: sixteen of twenty folds
   * replied "no lawn" over the whole property and it printed as 100% wrong.
   *
   * Same separable problem at two widths. The wide one is padded with noise,
   * so it is no harder -- if it scores far worse, the rate did not survive the
   * width.
   */
  for (const wide of [2, 200]) {
    const Nw = 3000;
    const xw = new Float32Array(Nw * wide);
    const yw = new Float32Array(Nw);
    for (let i = 0; i < Nw; i++) {
      const a = rand() * 4 - 2;
      const b = rand() * 4 - 2;
      xw[i * wide] = a;
      xw[i * wide + 1] = b;
      for (let f = 2; f < wide; f++) xw[i * wide + f] = rand() * 2 - 1;
      yw[i] = a + b > 0 ? 1 : 0;
    }
    const m = train(xw, yw, null, { inputs: wide, hidden: 12, seed: 11 });
    const pw = predict(m, xw);
    let ok = 0, lit = 0;
    for (let i = 0; i < Nw; i++) {
      if (pw[i] > 0.5) lit++;
      if ((pw[i] > 0.5 ? 1 : 0) === yw[i]) ok++;
    }
    check(`${wide} inputs: it still answers both ways`,
      lit > Nw * 0.1 && lit < Nw * 0.9,
      `${lit} of ${Nw} called positive -- all or none means it diverged`);
    check(`  and still learns the boundary`,
      ok / Nw > 0.9, `${((100 * ok) / Nw).toFixed(1)}% right`);
  }

  check('weights make the two answers count equally',
    Math.abs(w.reduce((a, b, i) => a + (yi[i] ? b : 0), 0)
      - w.reduce((a, b, i) => a + (yi[i] ? 0 : b), 0)) < 1e-3,
    'the weighted totals of the two classes should match');
}

/* ------------------------------------------------------- scoring a fold */
{
  console.log('\n--- how wrong is wrong ---');
  const { compare, resize, maskOf } = await import('./train-detector.js');

  const S = 8;
  const box = (x0, y0, x1, y1) => {
    const m = new Uint8Array(S * S);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * S + x] = 1;
    return m;
  };

  const truth = box(2, 2, 6, 6);          // 16 pixels of lawn
  check('a perfect answer is nothing wrong',
    compare(truth, truth, null).errorPct === 0);

  /*
   * THE CASE THE PERCENTAGE EXISTS FOR: right size, wrong place. A scorer that
   * subtracted totals would call this flawless, and a model free to put the
   * lawn anywhere as long as it is the right size would sail through.
   */
  const elsewhere = box(2, 2, 6, 6);
  const shifted = new Uint8Array(S * S);
  for (let y = 2; y < 6; y++) for (let x = 4; x < 8; x++) shifted[y * S + x] = 1;
  const off = compare(shifted, elsewhere, null);
  check('same area in the wrong place still scores as wrong',
    off.errorPct === 100 && off.extra === 8 && off.missed === 8,
    `${off.errorPct}% wrong, ${off.extra} invented, ${off.missed} missed`);

  /*
   * ONLY INSIDE THE PROPERTY LINE. SAM's stored outline is already clipped to
   * it, so judging the trained model over the whole frame would charge it for
   * the neighbour's garden and make the comparison meaningless.
   */
  const within = box(0, 0, 4, 8);
  const spilling = box(2, 2, 8, 6);       // half of it past the line
  const judged = compare(spilling, truth, within);
  check('what falls outside the property line is not counted either way',
    judged.extra === 0 && judged.missed === 0,
    `${judged.extra} invented, ${judged.missed} missed -- inside the line the `
    + 'two agree exactly, and outside it nobody asked');

  check('an empty truth reports no percentage rather than zero',
    compare(truth, new Uint8Array(S * S), null).errorPct === null,
    'zero would read as a perfect score on a lawn that is not there');

  /* The resize is an average, not a sample: a checkerboard must go grey. */
  const check2 = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    const v = (i % 2) ? 255 : 0;
    check2[i * 4] = check2[i * 4 + 1] = check2[i * 4 + 2] = v;
    check2[i * 4 + 3] = 255;
  }
  const small = resize(check2, 4, 4, 4, 2);
  check('downsizing averages rather than picking one pixel',
    small[0] > 100 && small[0] < 155,
    `${small[0]} -- a nearest-neighbour resize would give 0 or 255, and would `
    + 'throw away exactly the texture the features are reading');

  /* A geometry must land where the frame says, or every label is offset. */
  const frame = { lng: -85.8637, lat: 42.8703, zoom: 19, size: 256 };
  const { framePxToLngLat } = await import('../public/lib/mercator.js');
  const corners = [[64, 64], [192, 64], [192, 192], [64, 192], [64, 64]]
    .map(([x, y]) => framePxToLngLat(frame, [x, y], 256, 256));
  const mask = maskOf([{ type: 'Polygon', coordinates: [corners] }], frame, 256);
  let on = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) on++;
  check('a shape drawn in frame pixels comes back as those pixels',
    Math.abs(on - 128 * 128) < 600,
    `${on} pixels lit for a 128x128 box -- an offset here would train the `
    + 'model on labels that do not match the photograph');
}

/* ------------------------------------------------- leaving one lawn out */
/*
 * THE CHECK EVERYTHING ELSE RESTS ON.
 *
 * The whole exercise is one line: the one that skips the held-out lawn. Get it
 * wrong and nothing fails -- the model trains on the garden it is about to be
 * marked on, scores beautifully, and the report says twenty lawns was plenty.
 * There is no way to tell that apart from real success by reading the output,
 * which is exactly why it needs a test rather than a careful eye.
 */
{
  console.log('\n--- leaving one out ---');
  const { runFold, GRID } = await import('./train-detector.js');
  const { imageFeatures } = await import('../public/lib/features.js');

  /*
   * Lawns whose answer is decidable from colour, so a working fold must score
   * well and a broken one cannot be told apart by score alone -- which is why
   * the check below counts what it trained on rather than how well it did.
   */
  const G = 64;
  const makeLawn = (seedColour, lawnRows, grassColour = null) => {
    const px = new Uint8Array(G * G * 4);
    const truth = new Uint8Array(G * G);
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const i = y * G + x;
        const grass = y < lawnRows;
        truth[i] = grass ? 1 : 0;
        const [r, g, b] = grass
          ? (grassColour || [60, 130 + seedColour, 55])
          : [140, 138, 135];
        px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
      }
    }
    /* `cheap` is the colour-and-texture layer; with no backbone loaded the
       row width is just that, which is what these folds exercise. */
    return {
      cheap: imageFeatures(px, G, G, MPP), width: FEATURE_COUNT,
      truth, within: null, detected: null,
    };
  };

  const lawns = [
    makeLawn(0, 32), makeLawn(6, 28), makeLawn(-6, 36),
    makeLawn(3, 30), makeLawn(-3, 34),
  ];

  const fold = runFold(lawns, 2, { perLawn: 900, grid: G });
  check('a fold trains on every lawn except the one it is marked on',
    fold.trainedOn === lawns.length - 1,
    `trained on ${fold.trainedOn} of ${lawns.length} -- if this ever equals `
    + `${lawns.length}, every score in the report is the model marking its own work`);

  check('and it can still answer a lawn it has never seen',
    fold.mine.errorPct < 25,
    `${fold.mine.errorPct.toFixed(1)}% wrong on the held-out lawn`);

  /*
   * AND IT MUST BE HARDER THAN MARKING ITS OWN WORK. Same lawn, once held out
   * and once left in: the included run should do at least as well. If holding
   * it out changed nothing at all, the exclusion is not reaching the data.
   */
  const withItIn = runFold([...lawns, lawns[2]], lawns.length, { perLawn: 900, grid: G });
  check('the held-out lawn really is absent from the training set',
    withItIn.trainedOn === lawns.length && fold.trainedOn === lawns.length - 1,
    'the second run includes a copy of the test lawn and must count one more');

  /* Every lawn gets a turn, and each one is a separate answer. */
  const all = lawns.map((_, i) => runFold(lawns, i, { perLawn: 600, grid: G }));
  check('every lawn takes its turn as the one left out',
    all.length === lawns.length && all.every((r) => r.trainedOn === lawns.length - 1),
    all.map((r) => r.trainedOn).join(', '));

  /*
   * AND THE HELD-OUT LAWN IS WHAT DECIDES THE SCORE.
   *
   * The five lawns above are all trivially separable, so every fold scores
   * zero and a check for "the folds differ" passes or fails on nothing. A lawn
   * whose grass is nearly the colour of its pavement is the honest test: if
   * holding THAT one out does not score worse than holding out an easy one,
   * the result is not coming from the lawn under test.
   */
  const hard = makeLawn(0, 30, [139, 139, 136]); // grass the colour of the path
  const mixed = [...lawns, hard];
  const easyFold = runFold(mixed, 0, { perLawn: 900, grid: G });
  const hardFold = runFold(mixed, mixed.length - 1, { perLawn: 900, grid: G });
  check('a hard lawn scores worse than an easy one when it is the one held out',
    hardFold.mine.wrong > easyFold.mine.wrong,
    `hard ${hardFold.mine.wrong} wrong against easy ${easyFold.mine.wrong} -- `
    + 'the same number for both would mean the held-out lawn is not being read');
}

/* ------------------------------------- can the backbone reach the head? */
/*
 * THE CHECK THAT TELLS A BUG FROM A FINDING.
 *
 * Adding a pretrained backbone moved the score from 43.2% to 42.8% -- which is
 * no change at all. That is suspicious rather than disappointing: a frozen
 * DINOv2 carries far more about a picture than eleven colour and variance
 * numbers do, so getting the same answer back suggests its features are not
 * reaching the head, not that they are useless.
 *
 * Those are opposite problems with opposite responses -- fix the plumbing, or
 * abandon the approach -- and nothing in the report can tell them apart. So
 * this builds lawns where the answer is ONLY in the backbone channel: the
 * colour layer is identical everywhere, and a fold that scores well can only
 * have done it by reading the patch grids.
 */
{
  console.log('\n--- can the backbone channel be learnt from at all? ---');
  const { runFold, buildRow } = await import('./train-detector.js');
  const PROJ = 32;
  const G = 64;
  const GRIDW = 8;                         // a coarse patch grid over the lawn
  const width = FEATURE_COUNT + 2 * PROJ;

  const madeLawn = (flip) => {
    /* Colour says nothing: every pixel identical. */
    const cheap = new Float32Array(G * G * FEATURE_COUNT).fill(0.5);
    const truth = new Uint8Array(G * G);

    /* The backbone grid says everything: top half one value, bottom another. */
    const fineData = new Float32Array(GRIDW * GRIDW * PROJ);
    for (let gy = 0; gy < GRIDW; gy++) {
      for (let gx = 0; gx < GRIDW; gx++) {
        const lawn = gy < GRIDW / 2;
        for (let d = 0; d < PROJ; d++) {
          fineData[(gy * GRIDW + gx) * PROJ + d] = lawn ? 1 + flip * 0.05 : -1 - flip * 0.05;
        }
      }
    }
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) truth[y * G + x] = y < G / 2 ? 1 : 0;
    }
    const fine = { data: fineData, gridW: GRIDW, gridH: GRIDW, dim: PROJ };
    return { cheap, fine, coarse: fine, truth, within: null, detected: null, width };
  };

  const lawns = [madeLawn(0), madeLawn(1), madeLawn(-1), madeLawn(2), madeLawn(-2)];

  /* First: a row really does carry the patch values, in the right columns. */
  const row = new Float32Array(width);
  buildRow(lawns[0], 2 * G + 2, row, 0, G);          // a pixel in the top half
  check('a feature row carries the backbone values after the colour ones',
    row.slice(FEATURE_COUNT, FEATURE_COUNT + PROJ).every((v) => v > 0.5),
    `columns ${FEATURE_COUNT}..${FEATURE_COUNT + PROJ} read `
    + `${row[FEATURE_COUNT].toFixed(2)} -- zeroes here would mean the grid is `
    + 'never sampled, and the head would be training on colour alone');

  const low = new Float32Array(width);
  buildRow(lawns[0], (G - 2) * G + 2, low, 0, G);    // a pixel in the bottom half
  check('and a pixel elsewhere reads a different patch',
    low[FEATURE_COUNT] < -0.5,
    `${low[FEATURE_COUNT].toFixed(2)} against ${row[FEATURE_COUNT].toFixed(2)} `
    + '-- the same value at both ends would mean every pixel samples one patch');

  /*
   * EVERY LAWN MUST BE SQUEEZED THROUGH THE SAME PROJECTION.
   *
   * This was wrong for one run and the result was completely convincing: the
   * backbone rows read 63.9% alone and 100% at the wider squeeze against 40.5%
   * for colour, and the obvious conclusion was that a model trained on
   * ground-level photographs cannot read a garden from above.
   *
   * It was not that. A random projection is a change of coordinates, and a
   * fresh one per lawn puts each lawn's features in a private language -- so
   * grass here and grass next door had no numerical relationship, and the head
   * was asked to generalise across noise. Nothing about it looks wrong from
   * the outside; the numbers are simply bad in a plausible direction.
   */
  const { lensFor } = await import('./train-detector.js');
  const a = lensFor(384, 32);
  const b = lensFor(384, 32);
  check('the same squeeze is reused rather than drawn again',
    a === b,
    'a fresh projection per lawn is a private coordinate system per lawn, and '
    + 'the head cannot learn anything that crosses lawns');
  check('and a different width gets its own',
    lensFor(384, 96) !== a && lensFor(384, 96).length === 384 * 96,
    'one matrix cannot serve two widths');

  /* Then: the head can actually learn from that channel alone. */
  const fold = runFold(lawns, 2, { perLawn: 900, grid: G });
  check('a lawn whose answer is only in the backbone channel is learnable',
    fold.mine.errorPct < 20,
    `${fold.mine.errorPct.toFixed(1)}% wrong with colour saying nothing -- if `
    + 'this is near 100% the backbone features never reach the head, and the '
    + 'training report is measuring colour twice');
}

/* ------------------------------------- two layers, and which wins where they meet */
{
  console.log('\n--- the inferred layer ---');
  const {
    inferredShare, inferredGeometries, seenGeometries,
  } = await import('./train-detector.js');

  const poly = (tag) => ({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], tag });

  /*
   * A traced lawn is usually ONE outline holding both kinds of ground -- grass,
   * then canopy, then grass again -- so inferred areas are drawn as their own
   * shapes on their own layer, overlapping the lawn beneath. Splitting the
   * stored list has to put every shape on exactly one side.
   */
  const stored = [
    { type: 'Feature', properties: {}, geometry: poly('lawn') },
    { type: 'Feature', properties: { inferred: true }, geometry: poly('guess') },
    /* Written before the flag existed: a bare geometry, and always seen. */
    poly('old'),
  ];
  check('every shape lands on exactly one layer',
    seenGeometries(stored).length === 2 && inferredGeometries(stored).length === 1,
    `${seenGeometries(stored).length} seen, ${inferredGeometries(stored).length} inferred`);
  check('and a shape from before the flag counts as seen',
    seenGeometries(stored).some((g) => g.tag === 'old'),
    'bare geometries are older maps, and nobody guessed at anything on them');

  /*
   * THE TIE RULE: where both layers cover a pixel, it counts as INFERRED.
   *
   * This was the other way round for one commit, and it was wrong for a
   * concrete reason rather than a philosophical one: every map in this corpus
   * was traced before the inferred layer existed, so the blue already covers
   * the canopies. Subtracting it would leave every new purple mark lying
   * entirely inside blue, zeroed, and no amount of marking would ever have
   * filled the column. The feature would have done nothing at all.
   *
   * It is also the wrong way round on the merits. The blue was drawn in one
   * sweep to answer "how much lawn is here", across ground visible and not.
   * The purple is drawn deliberately, small, by somebody who stopped and
   * thought about that particular canopy. Precision lives with the narrower
   * mark, so the narrower mark wins.
   */
  const truth = new Uint8Array([1, 1, 1, 1, 0]);
  const marked = new Uint8Array([1, 1, 0, 0, 1]);

  check('ground covered by both layers counts as inferred',
    Math.abs(inferredShare(truth, marked, null) - 0.5) < 1e-9,
    `${inferredShare(truth, marked, null)} -- the blue was drawn over the `
    + 'canopies before the purple existed, so subtracting it would zero every '
    + 'mark and the column would never fill');

  check('and ground outside the lawn is not counted either way',
    inferredShare(new Uint8Array([1, 0]), new Uint8Array([0, 1]), null) === 0,
    'a mark that reaches past the lawn is not lawn, inferred or otherwise');

  check('nothing marked is a share of nothing, not a share of everything',
    inferredShare(truth, null, null) === 0,
    'null has to read as zero, because most maps will carry no marks at all');

  /*
   * The share is what replaced the tie rule as the guard. It cannot correct a
   * map marked over generously -- it makes one visible, beside the score it is
   * affecting, which is the better of the two.
   */
  const within = new Uint8Array([1, 1, 0, 0, 0]);
  check('and only ground inside the property line is in the reckoning',
    inferredShare(truth, marked, within) === 1,
    'every other number in this report is counted inside the line, and a '
    + 'share counted over a different set is not comparable to them');
}

/* ------------------------------------------ what is AROUND a spot, in metres */
{
  console.log('\n--- the ring ---');
  const { buildRow, rowWidth } = await import('./train-detector.js');

  const G = 64;
  const plain = { colour: true, backbone: false, dims: 0 };
  const ringed = { colour: true, backbone: false, dims: 0, ring: true };

  /*
   * A lawn that is plain grey everywhere except for one bright column far off
   * to the east. The centre pixel sees nothing of it; a ring that reaches far
   * enough does. That is the whole mechanism, so it is the whole test.
   */
  const lawnAt = (mpp) => {
    const cheap = new Float32Array(G * G * FEATURE_COUNT).fill(0.2);
    for (let y = 0; y < G; y++) {
      for (let x = 40; x < 48; x++) {
        for (let f = 0; f < FEATURE_COUNT; f++) cheap[(y * G + x) * FEATURE_COUNT + f] = 0.9;
      }
    }
    return { cheap, truth: new Uint8Array(G * G), within: null, mpp };
  };

  const centre = 32 * G + 20;              // twenty pixels west of the bright band

  const narrow = rowWidth(plain, false);
  const wide = rowWidth(ringed, false);
  check('the ring adds width and the centre keeps its own',
    wide > narrow && narrow === FEATURE_COUNT,
    `${narrow} -> ${wide}: the surroundings are meant to be extra evidence, `
    + 'not a replacement for what is actually at the spot');

  /*
   * A COLOUR-ONLY RING IS COLOUR-ONLY, and for six weeks it was not.
   *
   * The row named "colour, with surroundings" exists to answer exactly one
   * question: does the ring's gain need the backbone, or is "is it green over
   * there" the whole of it. It declares `backbone: false`. But the ring
   * sampled the backbone whenever the LAWN had one, rather than whenever the
   * CONFIGURATION asked for one, so that row silently carried six backbone
   * numbers per ring point and could never have answered its question.
   *
   * It was caught by a reproducibility check, not by reading: it was the one
   * supposedly backbone-free row that drifted between two identical runs,
   * which it could not do without backbone features in it. H4's ring readings
   * before 2026-09-19 are confounded by this.
   */
  check('a colour-only ring carries no backbone numbers, eye present or not',
    rowWidth(ringed, true) === rowWidth(ringed, false),
    `${rowWidth(ringed, true)} with an eye available vs ${rowWidth(ringed, false)} without`);
  check('and a ring that DID ask for the backbone still gets it',
    rowWidth({ ...ringed, backbone: true, dims: 4 }, true)
      > rowWidth({ ...ringed, backbone: true, dims: 4 }, false),
    'otherwise the fix above would have turned the ring off for everyone');

  /* And the row itself, not just its declared width: handing a lawn a backbone
     grid must not change what a colour-only configuration reads. */
  {
    const eyeGrid = {
      data: new Float32Array(8 * 8 * 6).fill(0.75), gridW: 8, gridH: 8, dim: 6,
    };
    const bare = lawnAt(1);
    const withEye = { ...lawnAt(1), ring: eyeGrid };
    const a = buildRow(bare, centre, new Float32Array(wide), 0, G, ringed);
    const b = buildRow(withEye, centre, new Float32Array(wide), 0, G, ringed);
    check('and the row reads the same whether or not the lawn has an eye',
      a.every((v, i) => v === b[i]),
      'a configuration that says backbone:false must not read the backbone');
  }

  /*
   * ONE METRE PER PIXEL AGAINST FOUR. At 1 m a pixel the 6 m ring reaches six
   * pixels east and finds more grey; at 0.25 m a pixel the same 6 m reaches
   * twenty-four pixels and lands in the bright band.
   *
   * THIS IS THE POINT OF MEASURING IN METRES. These twenty properties span a
   * factor of nine in metres per pixel, so a ring counted in pixels would ask
   * a different question of every lawn and the head would be learning them all
   * at once.
   */
  const near = buildRow(lawnAt(1), centre, new Float32Array(wide), 0, G, ringed);
  const far = buildRow(lawnAt(0.25), centre, new Float32Array(wide), 0, G, ringed);

  const ringOf = (row) => [...row.slice(FEATURE_COUNT)];
  check('the ring reads further out on a wider-zoomed lawn',
    Math.max(...ringOf(far)) > Math.max(...ringOf(near)) + 0.3,
    `nearest ${Math.max(...ringOf(near)).toFixed(2)} against `
    + `${Math.max(...ringOf(far)).toFixed(2)} -- if these match, the ring is `
    + 'counting pixels and every lawn is being asked a different question');

  check('and what is at the spot is unchanged by switching the ring on',
    ringOf(near).length === wide - FEATURE_COUNT
    && near.slice(0, FEATURE_COUNT).every(
      (v, i) => v === buildRow(lawnAt(1), centre, new Float32Array(narrow), 0, G, plain)[i]),
    'the first eleven numbers are the evidence at this spot and must not move '
    + 'when surroundings are added, or the two rows are not comparable');

  /* The frame edge: a ring point off the picture must repeat the edge rather
     than read zero, because zero is a colour and a lawn at the edge of its
     frame would get a confident black neighbour that is not there. */
  const edge = buildRow(lawnAt(1), 32 * G + 1, new Float32Array(wide), 0, G, ringed);
  check('a ring point off the edge repeats the edge instead of reading black',
    ringOf(edge).every((v) => v > 0),
    'zeroes here are an invented dark neighbour, and every lawn has four edges');
}

/* ---------------------------------------- seen apart from inferred */
{
  console.log('\n--- seen against inferred ---');
  const { runFold } = await import('./train-detector.js');
  const { imageFeatures } = await import('../public/lib/features.js');

  /*
   * THE GUARD ON THE RING, and the reason the flag exists at all.
   *
   * Giving the head its surroundings risks it leaning on the neighbours and
   * giving up on faint evidence -- trading the hard-to-see for the
   * impossible-to-see and coming out ahead on the total while being worse at
   * the job. Nothing in the architecture forbids that; the head uses whatever
   * predicts. What stops it going unnoticed is scoring the pixels a person
   * could actually SEE apart from the ones they inferred, so the two move
   * separately and a trade is visible as a trade.
   */
  const G = 64;
  const make = (tint, withInferred) => {
    const px = new Uint8Array(G * G * 4);
    const truth = new Uint8Array(G * G);
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const i = y * G + x;
        truth[i] = y < 32 ? 1 : 0;
        const [r, g, b] = truth[i] ? [60, 130 + tint, 55] : [140, 138, 135];
        px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
      }
    }
    /* A band of the lawn declared "I know it is there, I cannot see it". */
    let inferred = null;
    if (withInferred) {
      inferred = new Uint8Array(G * G);
      for (let y = 8; y < 16; y++) for (let x = 0; x < G; x++) inferred[y * G + x] = 1;
    }
    return {
      cheap: imageFeatures(px, G, G, MPP), width: FEATURE_COUNT,
      truth, within: null, detected: null, inferred, mpp: 0.1,
    };
  };

  const cfg = { colour: true, backbone: false, dims: 0 };
  const lawns = [make(0, true), make(6, true), make(-6, false), make(3, true)];

  const held = runFold(lawns, 0, { cfg, width: FEATURE_COUNT, perLawn: 900, grid: G });
  check('a map with marked areas reports both columns',
    held.seenPct !== null && held.guessPct !== null,
    `seen ${held.seenPct}, inferred ${held.guessPct} -- a null here means the `
    + 'mask never reached the fold and the guard is not guarding anything');

  const none = runFold(lawns, 2, { cfg, width: FEATURE_COUNT, perLawn: 900, grid: G });
  check('a map with nothing marked has no inferred column',
    none.guessPct === null,
    'an inferred score on a map where nothing was inferred is a number '
    + 'invented out of an empty set');
  check('and its seen column is just its ordinary error',
    Math.abs(none.seenPct - none.mine.errorPct) < 1e-9,
    `${none.seenPct} against ${none.mine.errorPct} -- with nothing marked, `
    + '"seen" and "everything" are the same pixels and must agree');
}

/* ------------------------------------------------ what the frames are worth */
{
  /*
   * THE GROUND SIZE THAT TRAVELS WITH THE PICTURES.
   *
   * Scale-MAE is the first backbone here that has to be TOLD how much ground a
   * pixel covers, and the failure mode is the one this project keeps meeting:
   * a wrong number does not error, it produces a confident wrong answer. So
   * the number is written as metres ACROSS THE FRAME, which does not depend on
   * what size the photograph was saved at, and divided by the read size at the
   * far end.
   *
   * Writing metres-per-pixel instead would be correct on the day and silently
   * wrong the moment DUMP_SIZE changed -- which is a thing a workflow input
   * now does on every run.
   */
  const { frameSpans, dumpSize } = await import('./train-detector.js');

  const spans = frameSpans([
    { id: 'a', mpp: 0.1 },
    { id: 'b', mpp: 0.25 },
  ], 512);
  check('the frame is measured in metres of ground, not pixels',
    Math.abs(spans.a - 51.2) < 1e-9 && Math.abs(spans.b - 128) < 1e-9,
    `got ${JSON.stringify(spans)} -- a scale-aware model reads this as the `
    + 'size of the world in the picture');
  check('and two lawns photographed at different zooms keep different sizes',
    spans.a !== spans.b,
    'one span for every property would tell the model every garden is the '
    + 'same size, which is exactly the information it was chosen for');

  const was = process.env.DUMP_SIZE;
  delete process.env.DUMP_SIZE;
  check('unset, the dump stays at the scoring grid',
    dumpSize() === 512,
    'a run with nothing set must behave as it did before the input existed');
  process.env.DUMP_SIZE = '896';
  check('set, it follows', dumpSize() === 896, 'the input is ignored');
  process.env.DUMP_SIZE = 'nonsense';
  check('and nonsense falls back rather than writing a 0x0 png',
    dumpSize() === 512,
    'NaN through to mkdir is a failure three steps from its cause');
  if (was === undefined) delete process.env.DUMP_SIZE; else process.env.DUMP_SIZE = was;
}

/* ------------------------------------------------ which lawns, not how many */
{
  /*
   * THE SET IS THE BIGGEST TERM IN EVERY NUMBER THIS TOOL PRINTS.
   *
   * Two transient R2 failures took a run from 20 lawns to 18, and the fixed
   * colour-only configuration -- same code, same features, same seed -- moved
   * 38.7% to 48.2% and reversed the sign of its shade-versus-sun gap. Nine and
   * a half points and a flipped conclusion, from nothing but which gardens
   * were in the room.
   *
   * Two tables can therefore look comparable and not be. The fingerprint is
   * what makes that visible without reading the lawn-by-lawn list.
   */
  const { setPrint, FETCH_TRIES } = await import('./train-detector.js');

  const set = [{ id: 'aaa' }, { id: 'bbb' }, { id: 'ccc' }];
  check('the same lawns fingerprint the same whatever order they arrive in',
    setPrint(set) === setPrint([set[2], set[0], set[1]]),
    'row order is a property of the query, not of the experiment, and a '
    + 'fingerprint that moved with it would cry wolf on every run');
  check('and losing one changes it',
    setPrint(set) !== setPrint(set.slice(0, 2)),
    'the whole point is that 18 lawns and 20 lawns are different experiments');
  check('it is short enough to read on a phone',
    setPrint(set).length === 7,
    `got ${setPrint(set).length} characters -- this is a label, not a hash`);

  check('a lawn is not abandoned on one bad fetch',
    FETCH_TRIES >= 3,
    'one wrangler hiccup silently rewrites the set, and a rewritten set is '
    + 'a different measurement wearing the same headings');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
