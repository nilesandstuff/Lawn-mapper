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
export function imageTensor(lib, rgb, w, h, size, {
  channels = 4, rect = null,
} = {}) {
  const data = new Float32Array(3 * size * size);
  /* A window of the source, for tiling; the whole thing by default. */
  const [rx, ry, rw, rh] = rect || [0, 0, w, h];
  const sx = rw / size;
  const sy = rh / size;

  for (let y = 0; y < size; y++) {
    const y0 = ry + Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, ry + Math.floor((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = rx + Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, rx + Math.floor((x + 1) * sx));
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
export async function patchFeatures({ lib, net }, rgb, w, h, size, { rect = null } = {}) {
  const pixel_values = imageTensor(lib, rgb, w, h, size, { channels: 4, rect });
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
 * The export is frozen at this input size. Measured, not assumed.
 *
 * DINOv2 itself takes any multiple of the patch size -- it interpolates its
 * position embeddings -- but the ONNX conversion baked the table in at 257
 * tokens, which is one class token plus a 16x16 grid. Anything larger is
 * refused outright by the graph:
 *
 *   Attempting to broadcast an axis by a dimension other than 1. 257 by 2705
 *
 * where 2705 is the 52x52 grid a 728px input would need. Workflow 13 checks
 * this, and re-checks it, because a future export may lift the restriction and
 * this whole tiling arrangement exists only because of it.
 */
export const NATIVE_SIZE = 224;

/**
 * Features over a frame, by running the model on TILES of it.
 *
 * WHY. One pass over a whole property gives a 16x16 grid -- one patch every
 * 3.3 m on a typical lot, which is coarser than the hand-written features this
 * is meant to improve on and useless for an edge. The size cannot be raised,
 * so the ground covered per pass comes down instead: sixteen tiles of a lot
 * are sixteen patches each across a quarter of its width, which is about 0.8 m
 * a patch.
 *
 * AND IT IS RUN AT TWO SCALES, which costs one extra pass and buys the thing
 * tiling otherwise loses. A tile only sees itself, so a patch in the middle of
 * one has no idea it is in a garden surrounded by trees -- and that context is
 * the entire reason for using a pretrained model rather than more colour
 * statistics. So the whole frame is also run coarsely, and every pixel carries
 * both: what is here at 0.8 m, and what kind of place this is at 3.3 m.
 *
 * Cheap enough not to think about: a pass is about 0.1s, so seventeen of them
 * is under two seconds a lawn.
 */
export async function tiledFeatures(bag, rgb, w, h, { tiles = 4, size = NATIVE_SIZE } = {}) {
  const side = size / PATCH;
  const gridW = tiles * side;
  const gridH = tiles * side;
  let dim = 0;
  let data = null;

  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const rect = [
        Math.floor((tx * w) / tiles), Math.floor((ty * h) / tiles),
        Math.ceil(w / tiles), Math.ceil(h / tiles),
      ];
      const f = await patchFeatures(bag, rgb, w, h, size, { rect });
      if (!data) {
        dim = f.dim;
        data = new Float32Array(gridW * gridH * dim);
      }
      /* Each tile's own 16x16 block, placed where that tile sits. */
      for (let py = 0; py < side; py++) {
        for (let px = 0; px < side; px++) {
          const from = (py * side + px) * dim;
          const to = ((ty * side + py) * gridW + (tx * side + px)) * dim;
          for (let d = 0; d < dim; d++) data[to + d] = f.data[from + d];
        }
      }
    }
  }

  return { data, gridW, gridH, dim };
}

/**
 * Read a patch grid at a pixel position, bilinearly.
 *
 * Nearest-neighbour here would stamp the patch grid into the output as visible
 * squares, and the head would learn the squares.
 */
export function sampleAt(feat, px, py, gridPx, out, offset, gridPy = gridPx) {
  const { data, gridW, gridH, dim } = feat;
  /*
   * A grid read in windows runs a little past the photograph's edge -- the
   * last window's core lands in padding -- so its columns span `coverX`
   * times the picture's width, not exactly the width. Dividing here is what
   * keeps a photograph pixel on its own patch; without it every feature on a
   * windowed lawn would sit slightly up and left of the ground it describes,
   * by more the further right it is. One-pass grids carry no cover and read
   * as they always did.
   */
  const coverX = feat.coverX || 1;
  const coverY = feat.coverY || 1;
  const gx = Math.min(gridW - 1, Math.max(0, ((px / gridPx) * gridW) / coverX - 0.5));
  const gy = Math.min(gridH - 1, Math.max(0, ((py / gridPy) * gridH) / coverY - 0.5));
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
