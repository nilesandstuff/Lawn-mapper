/**
 * Pasting the pieces of a tiled detection back into one mask.
 *
 * A lot too big to reach the model at 10 cm a pixel in one picture is cut
 * into an n x n grid of pictures by the Worker (detectionPlan in
 * worker/src/imagery.js), and the model answers each piece separately. The
 * tracer wants one bitmap over one frame, so the answers are pasted onto a
 * grid here: piece (col, row) goes at (col * w, row * h), where w and h are
 * the piece's own pixel size. Nothing is scaled and nothing is guessed --
 * the tiles were laid out to abut exactly in world pixels, so a plain paste
 * is the correct stitch.
 *
 * Plain arrays in, plain object out, so the same code runs in the browser on
 * ImageData and in Node under test. The result has the three fields the
 * tracer reads (width, height, data) and nothing else.
 */
export function stitchMasks(pieces, cols, rows) {
  if (!pieces.length) throw new Error('No mask pieces to stitch');
  const { width: w, height: h } = pieces[0].image;
  for (const p of pieces) {
    if (p.image.width !== w || p.image.height !== h) {
      throw new Error('The detector returned pieces of different sizes, so they cannot be stitched.');
    }
  }
  if (pieces.length !== cols * rows) {
    throw new Error(`Expected ${cols * rows} mask pieces and got ${pieces.length}.`);
  }

  const W = w * cols;
  const H = h * rows;
  const data = new Uint8ClampedArray(W * H * 4);
  for (const p of pieces) {
    if (!(p.col >= 0 && p.col < cols && p.row >= 0 && p.row < rows)) {
      throw new Error(`A mask piece is off the grid: column ${p.col}, row ${p.row}.`);
    }
    const src = p.image.data;
    for (let y = 0; y < h; y++) {
      const from = y * w * 4;
      const to = ((p.row * h + y) * W + p.col * w) * 4;
      data.set(src.subarray(from, from + w * 4), to);
    }
  }
  return { width: W, height: H, data };
}
