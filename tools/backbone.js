/**
 * The pretrained eye: turns an aerial photograph into features that know about
 * texture and context, not just colour.
 *
 * WHY THIS EXISTS. The first trained detector used eleven hand-written numbers
 * per pixel -- colour, plus how much the brightness wobbles over half a metre
 * and a metre and a half. It scored 43% against SAM's 17% and the reason was
 * exactly what you would guess from the list: seven of the eleven numbers were
 * one pixel of colour, so dormant grass read like concrete; and the widest
 * thing it ever looked at was 1.55 m, so a lawn under a tree canopy and a
 * forest floor -- which differ at three to ten metres -- were indistinguishable
 * to it.
 *
 * Neither is fixable by writing more windows by hand. Multi-scale texture in
 * context is the thing a pretrained vision model already encodes, and DINOv2
 * encodes it without ever having been told what a lawn is: every patch is
 * represented in the light of the whole image, which is the property the hand
 * features could not have at any window size.
 *
 * FROZEN, AND THAT IS THE POINT. Nothing here is trained. The weights are what
 * somebody else paid for; all this does is read them out, and the small head
 * downstream learns the only thing that is specific to us -- which of those
 * patterns mean grass. That is what makes twenty lawns a plausible number.
 *
 * COARSE ON PURPOSE, AND COMBINED RATHER THAN SUBSTITUTED. A patch is 14 pixels
 * of input, so the features come back on a grid far coarser than the mask. That
 * is fine for "is this under canopy" and useless for "where exactly does the
 * grass stop". So these are used ALONGSIDE the cheap per-pixel numbers, not
 * instead of them: the backbone says what kind of ground this is, the colour
 * says where its edge runs.
 */

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_SD = [0.229, 0.224, 0.225];

/** ViT-S/14: 384 numbers per patch, 21M parameters, and it runs on a CPU. */
export const BACKBONE_MODEL = 'Xenova/dinov2-small';
export const PATCH = 14;

/**
 * Load the model once.
 *
 * Separate from using it because loading is seconds and a download, and every
 * lawn in the corpus goes through the same loaded copy.
 */
export async function loadBackbone({ model = BACKBONE_MODEL, dtype = 'fp32' } = {}) {
  const lib = await import('@huggingface/transformers');
  const net = await lib.AutoModel.from_pretrained(model, { dtype });
  return { lib, net, model };
}

/**
 * An image, as the tensor the model wants: [1, 3, size, size], ImageNet-scaled.
 *
 * BUILT BY HAND RATHER THAN BY THE PROCESSOR, because the processor crops to
 * whatever size the model was exported at -- typically 224, which over a 40 m
 * frame is a patch every 2.5 m and throws away the resolution this is being
 * asked for. DINOv2 interpolates its position embeddings, so it takes any
 * multiple of the patch size; whether the exported graph kept that axis
 * dynamic is the thing the probe below answers.
 *
 * `rgb` is RGBA or RGB bytes at `w` x `h`; it is box-averaged to `size`.
 */
export function imageTensor(lib, rgb, w, h, size, { channels = 4 } = {}) {
  const data = new Float32Array(3 * size * size);
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
          r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; n++;
        }
      }
      /* Planar, not interleaved: ONNX wants all the red, then all the green. */
      const p = y * size + x;
      data[p] = ((r / n / 255) - IMAGENET_MEAN[0]) / IMAGENET_SD[0];
      data[size * size + p] = ((g / n / 255) - IMAGENET_MEAN[1]) / IMAGENET_SD[1];
      data[2 * size * size + p] = ((b / n / 255) - IMAGENET_MEAN[2]) / IMAGENET_SD[2];
    }
  }
  return new lib.Tensor('float32', data, [1, 3, size, size]);
}

/**
 * Patch features for one image.
 *
 * Returns { data, gridW, gridH, dim } where `data` is gridW*gridH*dim floats,
 * row-major. The leading classification token is dropped: it describes the
 * whole picture, and every patch would carry the same copy of it.
 */
export async function patchFeatures({ lib, net }, rgb, w, h, size) {
  const pixel_values = imageTensor(lib, rgb, w, h, size, { channels: 4 });
  const out = await net({ pixel_values });
  const hidden = out.last_hidden_state;
  if (!hidden) throw new Error(`no last_hidden_state; got ${Object.keys(out).join(', ')}`);

  const [, tokens, dim] = hidden.dims;
  const side = size / PATCH;
  const expected = side * side;
  /*
   * One token more than the patches is the classification token, which is what
   * DINOv2 returns; anything else means the geometry is not what is assumed
   * here, and quietly reshaping it would scramble every feature's position.
   */
  if (tokens !== expected + 1) {
    throw new Error(`expected ${expected} patches plus a class token, got ${tokens}`);
  }

  const src = hidden.data;
  const data = new Float32Array(expected * dim);
  for (let p = 0; p < expected; p++) {
    for (let d = 0; d < dim; d++) data[p * dim + d] = src[(p + 1) * dim + d];
  }
  return { data, gridW: side, gridH: side, dim };
}

/**
 * Read a patch grid at a pixel position, bilinearly.
 *
 * Nearest-neighbour here would stamp the patch grid into the output as visible
 * squares, and the head would learn the squares.
 */
export function sampleAt(feat, px, py, gridPx, out, offset) {
  const { data, gridW, gridH, dim } = feat;
  const gx = Math.min(gridW - 1, Math.max(0, (px / gridPx) * gridW - 0.5));
  const gy = Math.min(gridH - 1, Math.max(0, (py / gridPx) * gridH - 0.5));
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const x1 = Math.min(gridW - 1, x0 + 1), y1 = Math.min(gridH - 1, y0 + 1);
  const fx = gx - x0, fy = gy - y0;

  const i00 = (y0 * gridW + x0) * dim;
  const i10 = (y0 * gridW + x1) * dim;
  const i01 = (y1 * gridW + x0) * dim;
  const i11 = (y1 * gridW + x1) * dim;

  for (let d = 0; d < dim; d++) {
    const top = data[i00 + d] * (1 - fx) + data[i10 + d] * fx;
    const bot = data[i01 + d] * (1 - fx) + data[i11 + d] * fx;
    out[offset + d] = top * (1 - fy) + bot * fy;
  }
}

/**
 * A fixed random projection, for squeezing 384 numbers into something a
 * per-pixel feature vector can afford to carry.
 *
 * WHY NOT PCA. PCA would concentrate the signal better and needs a covariance
 * and an eigendecomposition of a 384-square matrix, written by hand, tested by
 * hand. A random projection preserves distances well enough for a small head
 * (Johnson-Lindenstrauss), is fifteen lines, and is exactly reproducible from
 * a seed. If the backbone turns out to be worth it, PCA is the obvious next
 * refinement -- but it should be spent after there is a number saying so.
 */
export function projection(dim, out, seed = 7) {
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const M = new Float32Array(dim * out);
  const scale = 1 / Math.sqrt(out);
  for (let i = 0; i < M.length; i++) {
    /* Box-Muller, so the entries are normal rather than uniform. */
    const u = Math.max(1e-12, rand());
    const v = rand();
    M[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale;
  }
  return M;
}

/** y = M^T x, for one vector. */
export function project(M, dim, out, x, xOff, y, yOff) {
  for (let o = 0; o < out; o++) {
    let sum = 0;
    for (let d = 0; d < dim; d++) sum += x[xOff + d] * M[d * out + o];
    y[yOff + o] = sum;
  }
}
