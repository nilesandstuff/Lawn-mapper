/**
 * Web Mercator <-> pixel math for a Mapbox Static Images frame.
 *
 * This module exists to answer one question: given a pixel in the satellite
 * PNG we sent to SAM, what lng/lat is it? Get that wrong and the traced lawn
 * lands in the wrong place or comes out the wrong size -- and unlike a crash,
 * it looks completely plausible.
 *
 * Note the division of labour with area.js: this file converts pixels to
 * WGS84 lng/lat and stops there. Area is then measured geodesically from
 * those lng/lat values. We never compute area in this projected pixel space
 * -- that is the ~1.88x error area.js warns about.
 */

/**
 * Mapbox renders with 512px tiles, so at zoom z the world is 512 * 2^z
 * *logical* pixels across. Google/OSM-derived code uses 256 here; that
 * difference is exactly a factor of two in every distance, which would make
 * every lawn come out 4x too large (or small) in area.
 *
 * app.js cross-checks this constant against Mapbox GL JS's own projection at
 * runtime and warns loudly on a mismatch, so a wrong assumption here surfaces
 * as a console error rather than a wrong number on the screen.
 */
export const TILE_SIZE = 512;

export const worldSize = (zoom) => TILE_SIZE * Math.pow(2, zoom);

/** [lng, lat] -> absolute world pixel coordinates at `zoom`. */
export function lngLatToWorld([lng, lat], zoom) {
  const ws = worldSize(zoom);
  // Clamp to the Mercator limit; beyond ~85.05 deg the projection diverges.
  const s = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
  return [
    ((lng + 180) / 360) * ws,
    (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws,
  ];
}

/** Absolute world pixel coordinates at `zoom` -> [lng, lat]. */
export function worldToLngLat([x, y], zoom) {
  const ws = worldSize(zoom);
  const n = Math.PI * (1 - (2 * y) / ws);
  return [
    (x / ws) * 360 - 180,
    (Math.atan(Math.sinh(n)) * 180) / Math.PI,
  ];
}

/*
 * A "frame" is one Mapbox Static Images request: { lng, lat, zoom, size }.
 * `size` is the logical width/height we asked for; because we request @2x,
 * the PNG that comes back is 2*size on each side. Every function below takes
 * the actual image dimensions rather than assuming, so a server-side cap
 * (Mapbox maxes out at 1280) cannot silently desynchronise the two.
 */

/** Pixel in the returned image -> [lng, lat]. */
export function framePxToLngLat(frame, [px, py], imgW, imgH) {
  const [cx, cy] = lngLatToWorld([frame.lng, frame.lat], frame.zoom);
  return worldToLngLat(
    [
      cx + (px / imgW - 0.5) * frame.size,
      cy + (py / imgH - 0.5) * frame.size,
    ],
    frame.zoom
  );
}

/** [lng, lat] -> pixel in the returned image. Inverse of framePxToLngLat. */
export function lngLatToFramePx(frame, lngLat, imgW, imgH) {
  const [cx, cy] = lngLatToWorld([frame.lng, frame.lat], frame.zoom);
  const [x, y] = lngLatToWorld(lngLat, frame.zoom);
  return [
    ((x - cx) / frame.size + 0.5) * imgW,
    ((y - cy) / frame.size + 0.5) * imgH,
  ];
}

/**
 * The frame's four corners, in the order Mapbox GL's `image` source wants
 * (top-left, top-right, bottom-right, bottom-left). Used by the debug
 * overlay that proves the georeferencing is right: if the mask lines up with
 * the satellite basemap underneath it, this whole file is correct.
 */
export function frameCorners(frame) {
  const [cx, cy] = lngLatToWorld([frame.lng, frame.lat], frame.zoom);
  const h = frame.size / 2;
  const at = (dx, dy) => worldToLngLat([cx + dx, cy + dy], frame.zoom);
  return [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
}

/**
 * Ground resolution in metres per image pixel. Used for sanity checks and to
 * report honest precision -- a lawn traced at 5cm/px should not be quoted to
 * the square foot.
 */
export function metresPerPixel(frame, imgW) {
  const EQUATOR_M = 40075016.686;
  const logicalPerImagePx = frame.size / imgW;
  return (
    (EQUATOR_M * Math.cos((frame.lat * Math.PI) / 180) / worldSize(frame.zoom)) *
    logicalPerImagePx
  );
}

/**
 * Pick the highest zoom that still fits `bbox` inside a `size`-logical-pixel
 * square, with padding so the parcel is not flush against the edge. SAM needs
 * to see the whole property plus a little context; cropping the far edge of a
 * deep lot is how you lose the back yard.
 *
 * bbox is [west, south, east, north].
 */
export function zoomToFit(bbox, size, { minZoom = 14, maxZoom = 20, padding = 0.12 } = {}) {
  const [w, s, e, n] = bbox;
  // Measure the span in zoom-0 world pixels, then solve for the zoom at which
  // it fills the available box.
  const [x1, y1] = lngLatToWorld([w, n], 0);
  const [x2, y2] = lngLatToWorld([e, s], 0);
  // lngLatToWorld at zoom 0 already returns TILE_SIZE-based pixels, and a
  // span scales by 2^zoom from there, so `avail` is compared against those
  // units directly -- dividing by TILE_SIZE again would clamp every parcel
  // to minZoom.
  const spanX = Math.abs(x2 - x1);
  const spanY = Math.abs(y2 - y1);
  const avail = size * (1 - padding);

  if (spanX <= 0 && spanY <= 0) return maxZoom;

  const fit = Math.min(
    spanX > 0 ? Math.log2(avail / spanX) : Infinity,
    spanY > 0 ? Math.log2(avail / spanY) : Infinity
  );

  return Math.max(minZoom, Math.min(maxZoom, Math.floor(fit * 100) / 100));
}

/** Bounding box [w, s, e, n] of a GeoJSON geometry. */
export function geometryBounds(geometry) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      w = Math.min(w, coords[0]); e = Math.max(e, coords[0]);
      s = Math.min(s, coords[1]); n = Math.max(n, coords[1]);
      return;
    }
    coords.forEach(visit);
  };
  const g = geometry?.type === 'Feature' ? geometry.geometry : geometry;
  if (!g?.coordinates) return null;
  visit(g.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
