/**
 * Does the pretrained eye run here, and at a resolution worth having?
 *
 * ITS OWN PROBE BECAUSE THE ANSWERS WERE UNKNOWN AND CHEAP TO GET WRONG, and
 * the first run earned its keep immediately. The export is frozen at 224
 * pixels: DINOv2 interpolates its position embeddings and takes any size, but
 * the ONNX conversion baked the table in at 257 tokens, so a larger input is
 * refused by the graph rather than resized. One pass over a whole property at
 * 224 is a patch every 3.3 m -- coarser than the hand-written features this is
 * meant to replace. Had that gone unnoticed it would have read as "the
 * backbone did not help".
 *
 * So the model is run on TILES, and this checks the thing that now matters:
 * whether tiling gets the ground-per-patch down far enough to tell two
 * surfaces apart. It also re-checks the size restriction, because a future
 * export may lift it and the tiling exists only because of it.
 *
 * Free. No corpus, no D1, no R2: synthetic images through the model.
 */

import {
  loadBackbone, patchFeatures, tiledFeatures, PATCH, NATIVE_SIZE, BACKBONE_MODEL,
} from './backbone.js';

const oneLine = (e) => String(e?.message || e).replace(/\s+/g, ' ').slice(0, 110);

/*
 * THE REPORT IS BUILT UP AND PRINTED IN ONE GO AT THE END.
 *
 * transformers.js prints the entire input tensor when the graph refuses a
 * shape -- a million and a half numbers, on stderr, interleaved line by line
 * with anything written at the same moment. The first run's findings were
 * shredded through that dump and unreadable. Collecting the lines and emitting
 * them in a single write keeps the answer in one piece whatever else is being
 * shouted alongside it.
 */
const report = [];
const say = (line = '') => report.push(line);

/** Blocks of grass-green on path-grey, at a size given in metres. */
function testImage(w, metresAcross, blockMetres) {
  const px = new Uint8Array(w * w * 4);
  const perBlock = Math.max(1, Math.round((blockMetres / metresAcross) * w));
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const green = (Math.floor(x / perBlock) + Math.floor(y / perBlock)) % 2 === 0;
      px[i] = green ? 62 : 141;
      px[i + 1] = green ? 131 : 138;
      px[i + 2] = green ? 54 : 135;
      px[i + 3] = 255;
    }
  }
  return px;
}

/**
 * Can the two surfaces be told apart from these features?
 *
 * BY GROUP, NOT BY PAIR. A ViT patch embedding carries where the patch is as
 * well as what is in it, so two patches of identical green at different
 * positions are genuinely far apart -- the first version of this compared one
 * green patch with one grey one, got 7.25 against 7.69, and failed a model
 * that was working. What the head downstream actually has to do is sort
 * patches into two groups, so that is what this asks.
 */
function separability(feat, img, W, metresAcross, blockMetres) {
  const { data, gridW, gridH, dim } = feat;
  const perBlock = Math.max(1, Math.round((blockMetres / metresAcross) * W));

  /* Labels read from the picture at each patch centre, not worked out from the
     block arithmetic -- which needs the resize factor to agree and blames the
     model when it does not. */
  const want = [];
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const cx = Math.min(W - 1, Math.round(((gx + 0.5) / gridW) * W));
      const cy = Math.min(W - 1, Math.round(((gy + 0.5) / gridH) * W));
      const i = (cy * W + cx) * 4;
      want.push(img[i + 1] > img[i] + 20);
    }
  }

  const centroid = (klass) => {
    const c = new Float64Array(dim);
    let n = 0;
    for (let p = 0; p < want.length; p++) {
      if (want[p] !== klass) continue;
      for (let d = 0; d < dim; d++) c[d] += data[p * dim + d];
      n++;
    }
    for (let d = 0; d < dim; d++) c[d] /= n || 1;
    return { c, n };
  };
  const dist = (off, c) => {
    let s = 0;
    for (let d = 0; d < dim; d++) s += (data[off + d] - c[d]) ** 2;
    return s;
  };

  const G = centroid(true);
  const K = centroid(false);
  if (!G.n || !K.n) return { accuracy: null, green: G.n, grey: K.n, perBlock };

  let right = 0;
  for (let p = 0; p < want.length; p++) {
    if ((dist(p * dim, G.c) < dist(p * dim, K.c)) === want[p]) right++;
  }
  return { accuracy: (100 * right) / want.length, green: G.n, grey: K.n, perBlock };
}

async function main() {
  say(`model: ${BACKBONE_MODEL}, patch ${PATCH}px`);

  let bag;
  const t0 = Date.now();
  try {
    bag = await loadBackbone();
  } catch (e) {
    say('FAILED TO LOAD.');
    say(oneLine(e));
    say('');
    say('A download failure means the runner could not reach huggingface.co.');
    say('An onnxruntime error means the native binary did not install.');
    console.log(report.join('\n'));
    process.exitCode = 1;
    return;
  }
  say(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  say('');

  const W = 1024;
  const FRAME_M = 53;          // about what one property's frame spans
  const img = testImage(W, FRAME_M, 4);

  /*
   * IS THE SIZE STILL FROZEN? Re-checked rather than assumed, because a newer
   * export could lift it and the whole tiling arrangement is a workaround for
   * it. Console silenced around the attempt: the library prints the entire
   * input tensor on a refusal, and the answer here is one bit.
   */
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  let bigger = false;
  console.log = console.error = console.warn = () => {};
  try {
    await patchFeatures(bag, img, W, W, NATIVE_SIZE + PATCH * 4);
    bigger = true;
  } catch { /* expected */ }
  Object.assign(console, quiet);

  say(bigger
    ? `A LARGER INPUT IS NOW ACCEPTED. The export is no longer frozen at`
      + ` ${NATIVE_SIZE}px, so the tiling below can be dropped for a single`
      + ' pass at a higher resolution.'
    : `The export is still frozen at ${NATIVE_SIZE}px, so tiling it is.`);
  say('');

  say('  tiles   patches over the frame   ground per patch   time');
  let best = null;
  for (const tiles of [1, 2, 4]) {
    const t = Date.now();
    try {
      const f = await tiledFeatures(bag, img, W, W, { tiles });
      const ms = Date.now() - t;
      const perPatch = FRAME_M / f.gridW;
      say(
        `  ${String(tiles).padStart(5)}   ${String(`${f.gridW}x${f.gridH}`).padEnd(22)}`
        + ` ${perPatch.toFixed(2).padStart(6)} m        ${(ms / 1000).toFixed(1)}s`
      );
      best = { tiles, ms, perPatch, ...f };
    } catch (e) {
      say(`  ${String(tiles).padStart(5)}   refused -- ${oneLine(e)}`);
    }
  }

  say('');
  say('='.repeat(62));
  say('');

  if (!best) {
    say('No tiling worked, so this model cannot be used as it is.');
    console.log(report.join('\n'));
    process.exitCode = 1;
    return;
  }

  /*
   * TESTED ON BLOCKS BIGGER THAN A PATCH. At one tile a patch covers 3.3 m, so
   * a 4 m block is barely one patch across and every patch straddles two
   * surfaces -- the labels are then meaningless and the score lands near a
   * coin flip whatever the model does. That is what 55% meant on the first
   * run: the test image was unresolvable at that size, not the model failing.
   */
  say('Telling grass-green from path-grey, by which average a patch sits nearer:');
  say('');
  say('  block size   1 tile    2 tiles   4 tiles');
  for (const blockM of [4, 8, 16]) {
    const test = testImage(W, FRAME_M, blockM);
    const row = [];
    for (const tiles of [1, 2, 4]) {
      const f = await tiledFeatures(bag, test, W, W, { tiles });
      const s = separability(f, test, W, FRAME_M, blockM);
      row.push(s.accuracy === null ? '  --  ' : `${s.accuracy.toFixed(0).padStart(4)}% `);
    }
    say(`  ${String(`${blockM} m`).padEnd(12)} ${row.join('   ')}`);
  }

  say('');
  const four = best.tiles === 4 ? best : null;
  if (four) {
    say(`At four tiles: ${four.gridW}x${four.gridH} patches, ${four.perPatch.toFixed(2)} m each,`);
    say(`${(four.ms / 1000).toFixed(1)}s a lawn -- about ${((four.ms * 20) / 1000).toFixed(0)}s for twenty.`);
  }
  say('');
  say('='.repeat(62));

  console.log(report.join('\n'));
}

main().catch((e) => {
  console.log(report.join('\n'));
  console.log('\nThe probe stopped:', oneLine(e));
  process.exitCode = 1;
});
