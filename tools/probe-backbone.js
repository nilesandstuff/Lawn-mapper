/**
 * Does the pretrained eye run here at all, and at what size?
 *
 * ITS OWN PROBE BECAUSE THE ANSWERS ARE UNKNOWN AND CHEAP TO GET WRONG. Three
 * things have to be true before anything is built on this model, and none of
 * them can be checked from a machine that cannot reach huggingface.co:
 *
 *   1. it loads on a CI runner at all, on a CPU, in reasonable time
 *   2. the exported graph accepts an input LARGER than the 224 it was exported
 *      at -- DINOv2 interpolates its position embeddings, but an ONNX export
 *      can freeze that axis, and 224 over a 40 m frame is one patch every
 *      2.5 m, which throws away the resolution this is for
 *   3. the output is shaped the way the reader assumes: one token per patch
 *      plus a leading class token
 *
 * Getting (2) wrong in particular would not fail -- it would silently run at
 * 224 and produce a worse model than the hand-written features, which would
 * read as "the backbone did not help".
 *
 * Free. No corpus, no D1, no R2: one synthetic image through the model.
 */

import { loadBackbone, patchFeatures, PATCH, BACKBONE_MODEL } from './backbone.js';

/*
 * A REFUSED INPUT SIZE PRINTS THE WHOLE INPUT.
 *
 * onnxruntime's error for a shape it will not accept carries the offending
 * tensor with it, and Node renders that: one refused size buried the report
 * under a million and a half normalised pixel values. On a log read from a
 * phone that is not a nuisance, it is the difference between an answer and no
 * answer -- so anything reported from a failure here is cut to one line.
 */
const oneLine = (e) => String(e?.message || e)
  .replace(/\s+/g, ' ')
  .slice(0, 110);

/* Something with structure in it, so a wrong answer is not hidden by a flat
   input: green blocks on grey, at a few different scales. */
function testImage(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const block = (Math.floor(x / 37) + Math.floor(y / 53)) % 2 === 0;
      px[i] = block ? 62 : 141;
      px[i + 1] = block ? 131 : 138;
      px[i + 2] = block ? 54 : 135;
      px[i + 3] = 255;
    }
  }
  return px;
}

async function main() {
  console.log(`model: ${BACKBONE_MODEL}, patch ${PATCH}px\n`);

  let bag;
  const t0 = Date.now();
  try {
    bag = await loadBackbone();
  } catch (e) {
    console.log('FAILED TO LOAD.');
    console.log(oneLine(e));
    console.log('\nIf this is a download failure the runner could not reach');
    console.log('huggingface.co. If it is an onnxruntime error the native');
    console.log('binary did not install -- check the npm step above.');
    process.exitCode = 1;
    return;
  }
  console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const W = 1024;
  const img = testImage(W, W);

  /*
   * Every size that is a whole number of patches, from the exported default
   * upward. The largest one that works is the resolution this can run at, and
   * the timing says whether twenty lawns is a minute or an hour.
   */
  const sizes = [224, 392, 518, 644, 728];
  let best = null;

  console.log('  size   patches    dim   time     ');
  for (const size of sizes) {
    if (size % PATCH) { console.log(`  ${size}  not a multiple of ${PATCH}, skipped`); continue; }
    const t = Date.now();
    try {
      const f = await patchFeatures(bag, img, W, W, size);
      const ms = Date.now() - t;
      console.log(
        `  ${String(size).padStart(4)}   ${String(f.gridW)}x${f.gridH}`.padEnd(22)
        + `${String(f.dim).padStart(4)}   ${(ms / 1000).toFixed(1)}s`
      );
      best = { size, ...f, ms };
    } catch (e) {
      console.log(`  ${String(size).padStart(4)}   refused -- ${oneLine(e)}`);
    }
  }

  console.log(`\n${'='.repeat(60)}\n`);
  if (!best) {
    console.log('No input size worked, so the backbone cannot be used as it is.');
    process.exitCode = 1;
    return;
  }

  /*
   * A LOADED MODEL THAT ANSWERS THE SAME THING EVERYWHERE IS NO USE. A graph
   * that runs but was exported without its weights, or read wrongly, gives
   * features that barely differ with the picture -- and every number above
   * would still look perfectly healthy.
   *
   * COMPARED IN GROUPS, NOT IN PAIRS, and the first version of this got that
   * wrong and failed a model that was working. A ViT patch embedding carries
   * WHERE the patch is as well as what is in it, so two patches of identical
   * green at different positions are genuinely far apart -- picking one green
   * patch and one grey one and measuring the gap says almost nothing, which is
   * exactly what it said: 7.25 across against 7.69 within.
   *
   * The honest question is whether the two kinds of ground are separable at
   * all: is a green patch closer to the average green patch than to the
   * average grey one? That is what the head downstream has to do, so it is
   * what this should ask.
   */
  const { data, gridW, gridH, dim, size } = best;

  /*
   * Each patch's true colour is read back from the image rather than worked
   * out from the block geometry. The arithmetic version needs the resize
   * factor and the block size to agree, and when it does not it mislabels the
   * patches and blames the model.
   */
  const scale = W / size;
  const isGreen = [];
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const cx = Math.min(W - 1, Math.round((gx + 0.5) * PATCH * scale));
      const cy = Math.min(W - 1, Math.round((gy + 0.5) * PATCH * scale));
      const i = (cy * W + cx) * 4;
      isGreen.push(img[i + 1] > img[i] + 20);   // green block or grey block
    }
  }

  const centroid = (want) => {
    const c = new Float64Array(dim);
    let n = 0;
    for (let p = 0; p < isGreen.length; p++) {
      if (isGreen[p] !== want) continue;
      for (let d = 0; d < dim; d++) c[d] += data[p * dim + d];
      n++;
    }
    for (let d = 0; d < dim; d++) c[d] /= n || 1;
    return { c, n };
  };
  const dist = (a, aOff, b) => {
    let s = 0;
    for (let d = 0; d < dim; d++) s += (a[aOff + d] - b[d]) ** 2;
    return Math.sqrt(s);
  };

  const G = centroid(true);
  const K = centroid(false);
  let right = 0;
  for (let p = 0; p < isGreen.length; p++) {
    const nearer = dist(data, p * dim, G.c) < dist(data, p * dim, K.c);
    if (nearer === isGreen[p]) right++;
  }
  const accuracy = (100 * right) / isGreen.length;

  console.log(`Largest input that ran: ${size}px, a ${gridW}x${gridH} grid`);
  console.log(`of ${dim}-number patches, in ${(best.ms / 1000).toFixed(1)}s per image.`);
  console.log(`Twenty lawns would be about ${((best.ms * 20) / 1000).toFixed(0)}s.\n`);
  console.log(`${G.n} green patches and ${K.n} grey ones.`);
  console.log(`Sorted by which average they sit nearer: ${accuracy.toFixed(0)}% right.`);

  if (accuracy > 85) {
    console.log('\nThe two kinds of ground are plainly separable in these');
    console.log('features, so the weights are loaded and being read correctly.');
  } else {
    console.log('\nTHE TWO ARE NOT SEPARABLE. The model runs, but its output does');
    console.log('not distinguish two obviously different surfaces -- so either the');
    console.log('weights or the reading of them is wrong. Nothing should be built');
    console.log('on this yet.');
    process.exitCode = 1;
  }
  console.log(`\n${'='.repeat(60)}`);
}

main().catch((e) => {
  console.log('The probe stopped:', oneLine(e));
  process.exitCode = 1;
});
