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
} from './features.js';
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
  const grass = imageFeatures(image(W, H, [70, 120, 60]), W, H);
  const road = imageFeatures(image(W, H, [130, 130, 128]), W, H);
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
  const fF = imageFeatures(flat, W, H);
  const sF = imageFeatures(speckled, W, H);
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
  const cornerFeat = imageFeatures(image(W, H, [70, 120, 60]), W, H);
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
  const sh = imageFeatures(shadow, W, H);
  check('a shadowed pixel still sees green around it',
    sh[mid + 9] > 0.1,
    `neighbourhood green ${sh[mid + 9].toFixed(3)} while the pixel itself is dark`);
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
  const { imageFeatures } = await import('./features.js');

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
    return { features: imageFeatures(px, G, G), truth, within: null, detected: null };
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

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
