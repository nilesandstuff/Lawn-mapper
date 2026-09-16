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
    console.log(String(e.message || e).slice(0, 400));
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
      console.log(`  ${String(size).padStart(4)}   refused -- ${String(e.message || e).slice(0, 90)}`);
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
   * features that barely differ between a green patch and a grey one -- and
   * every number above would still look perfectly healthy.
   */
  const { data, gridW, dim } = best;
  const at = (gx, gy) => data.subarray((gy * gridW + gx) * dim, (gy * gridW + gx + 1) * dim);
  const dist = (a, b) => {
    let s = 0;
    for (let i = 0; i < dim; i++) s += (a[i] - b[i]) ** 2;
    return Math.sqrt(s);
  };
  const green = at(1, 1);
  const grey = at(Math.floor(37 / (best.size / gridW)) + 1, 1);
  const alsoGreen = at(1, 2);
  const across = dist(green, grey);
  const within = dist(green, alsoGreen);

  console.log(`Largest input that ran: ${best.size}px, a ${gridW}x${gridW} grid`);
  console.log(`of ${dim}-number patches, in ${(best.ms / 1000).toFixed(1)}s per image.`);
  console.log(`Twenty lawns would be about ${((best.ms * 20) / 1000).toFixed(0)}s.\n`);
  console.log(`Difference between a green patch and a grey one: ${across.toFixed(2)}`);
  console.log(`Between two patches of the same green:           ${within.toFixed(2)}`);

  if (across > within * 1.5) {
    console.log('\nIt is telling them apart, so the weights are really loaded.');
  } else {
    console.log('\nIT IS NOT TELLING THEM APART. The model runs but its output');
    console.log('barely changes with the picture, which means the weights or the');
    console.log('reading of them are wrong. Nothing should be built on this yet.');
    process.exitCode = 1;
  }
  console.log(`\n${'='.repeat(60)}`);
}

main().catch((e) => {
  console.log('The probe stopped:', e.message);
  process.exitCode = 1;
});
