/**
 * THE COUNTY PHOTO AT ITS OWN SHARPNESS (owner, 2026-10-06: "display every
 * drop of clarity the county images provide over the whole property line").
 *
 * The quick picture of a frame is 1280 px across its longer side whatever the
 * lot, so past ~100 m it is softer than a 7.5 cm county photo. The server
 * gives at most 1280 logical (2560 px) a request, so the full sharpness of a
 * big frame comes as a grid of pieces, each a frame of its own at a higher
 * zoom, laid edge to edge over the quick picture once they arrive. At most
 * six (each up to 2560 x 2560 px held in a phone's memory); past that the
 * pieces settle a little short of the photo's full sharpness.
 *
 * Pure: the browser fetches and paints what this returns.
 */
import { lngLatToWorld, worldToLngLat, worldSize } from './mercator.js';

const EQUATOR_M = 40075016.686;

/** Ground metres per image pixel (@2x) for a frame at `zoom`. */
export const metresPerImagePx = (lat, zoom) => (EQUATOR_M * Math.cos((lat * Math.PI) / 180)) / worldSize(zoom) / 2;

/**
 * The pieces, as frames ({lng, lat, zoom, size, height}), that cover `frame`
 * at `targetM` metres a pixel -- or none when the quick picture is already
 * within `slack` of that, or the source is unknown.
 */
export function sharpTiles(frame, targetM, {
  maxLogical = 1280, maxTiles = 6, maxZoom = 20, slack = 1.25, minLogical = 256,
} = {}) {
  if (!frame || !(targetM > 0)) return [];
  const height = frame.height || frame.size;
  const nowM = metresPerImagePx(frame.lat, frame.zoom);
  const gain = nowM / targetM;
  if (!(gain >= slack)) return [];
  let zoom = Math.min(maxZoom, frame.zoom + Math.log2(gain));
  let tiles = null;
  /* Too many pieces: settle for a little less than all of it, a tenth of a
     zoom at a time, until they fit or it is no longer worth it. */
  while (zoom > frame.zoom + Math.log2(slack)) {
    const scale = 2 ** (zoom - frame.zoom);
    const W = frame.size * scale, H = height * scale;
    const nx = Math.ceil(W / maxLogical), ny = Math.ceil(H / maxLogical);
    if (nx * ny <= maxTiles) { tiles = { W, H, nx, ny }; break; }
    zoom -= 0.1;
  }
  if (!tiles || zoom <= frame.zoom + Math.log2(slack)) return [];
  const { W, H, nx, ny } = tiles;
  const [cx, cy] = lngLatToWorld([frame.lng, frame.lat], zoom);
  const tw = W / nx, th = H / ny;
  const out = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [lng, lat] = worldToLngLat([cx - W / 2 + (i + 0.5) * tw, cy - H / 2 + (j + 0.5) * th], zoom);
      /* A pixel of overlap each way, so rounding never leaves a seam. */
      /* Never under the server's 256: it would serve 256 and the piece would
         land stretched. A bigger piece just overlaps its neighbour. */
      out.push({ lng, lat, zoom, size: Math.max(minLogical, Math.ceil(tw) + 1), height: Math.max(minLogical, Math.ceil(th) + 1) });
    }
  }
  return out;
}
