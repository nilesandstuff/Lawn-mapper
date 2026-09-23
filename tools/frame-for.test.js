/**
 * The display frame is the parcel's box plus a margin, cropped both ways.
 *
 *   node tools/frame-for.test.js
 */
import assert from 'node:assert/strict';
import {
  frameFor, frameHeight, frameCorners, lngLatToFramePx, framePxToLngLat, metresPerPixel,
} from '../public/lib/mercator.js';

const EQ = 40075016.686;
/* A box `w` metres wide and `h` deep at a latitude, in degrees. */
const box = (w, h, lat = 42.9, lng = -85) => {
  const mPerDegLat = (EQ / 360);
  const mPerDegLng = mPerDegLat * Math.cos((lat * Math.PI) / 180);
  return [lng - w / 2 / mPerDegLng, lat - h / 2 / mPerDegLat, lng + w / 2 / mPerDegLng, lat + h / 2 / mPerDegLat];
};
const groundW = (f) => metresPerPixel(f, f.size) * f.size;
const groundH = (f) => metresPerPixel(f, f.size) * frameHeight(f);

{
  /* A long thin lot: 120 m by 40 m. Wide picture, 10 m margin each side. */
  const f = frameFor(box(120, 40), 640, { marginM: 10 });
  assert.ok(Math.abs(groundW(f) - 140) < 2, `width ${groundW(f)} m, want 140`);
  assert.ok(Math.abs(groundH(f) - 60) < 2, `height ${groundH(f)} m, want 60`);
  assert.ok(f.size >= 630 && f.size <= 640, `the longer side fills the frame: ${f.size}`);
  assert.ok(f.height < f.size * 0.5 && f.height > f.size * 0.38, `height ${f.height} for a 140x60 lot`);

  /* The same lot turned: tall picture. */
  const t = frameFor(box(40, 120), 640, { marginM: 10 });
  assert.ok(Math.abs(groundW(t) - 60) < 2 && Math.abs(groundH(t) - 140) < 2, 'turned lot');
  assert.ok(t.height >= 630 && t.height <= 640, `turned: ${t.height}`);
}

{
  /* The parcel's corners land inside the picture with the margin around
     them, in image pixels of any size. */
  const b = box(120, 40);
  const f = frameFor(b, 640, { marginM: 10 });
  const [x0, y0] = lngLatToFramePx(f, [b[0], b[3]], 1280, 2 * f.height);
  const [x1, y1] = lngLatToFramePx(f, [b[2], b[1]], 1280, 2 * f.height);
  const mpp = metresPerPixel(f, 1280);
  assert.ok(Math.abs(x0 * mpp - 10) < 1.5, `left margin ${x0 * mpp} m`);
  assert.ok(Math.abs(y0 * mpp - 10) < 1.5, `top margin ${y0 * mpp} m`);
  assert.ok(Math.abs((1280 - x1) * mpp - 10) < 1.5, `right margin ${(1280 - x1) * mpp} m`);
  assert.ok(Math.abs((2 * f.height - y1) * mpp - 10) < 1.5, `bottom margin ${(2 * f.height - y1) * mpp} m`);

  /* And round-trips. */
  const back = framePxToLngLat(f, [x0, y0], 1280, 2 * f.height);
  assert.ok(Math.abs(back[0] - b[0]) < 1e-7 && Math.abs(back[1] - b[3]) < 1e-7, 'round trip');

  /* Corners: top-left, top-right, bottom-right, bottom-left, and a rectangle. */
  const c = frameCorners(f);
  assert.ok(c[0][0] < c[1][0] && c[0][1] > c[3][1]);
  assert.ok(Math.abs(c[1][0] - c[2][0]) < 1e-12);
}

{
  /* A square frame without a height is what it always was. */
  const sq = { lng: -85, lat: 42.9, zoom: 19, size: 640 };
  assert.equal(frameHeight(sq), 640);
  const [x, y] = lngLatToFramePx(sq, [-85, 42.9], 1280, 1280);
  assert.ok(Math.abs(x - 640) < 1e-9 && Math.abs(y - 640) < 1e-9);
}

{
  /* A tiny lot is not a tiny picture: the floor holds, and the zoom cap
     keeps it from asking for detail Mapbox does not have. */
  const f = frameFor(box(8, 8), 640, { marginM: 10 });
  assert.ok(f.size >= 160 && f.height >= 160, `tiny lot ${f.size}x${f.height}`);
  assert.ok(f.zoom <= 20);
}

console.log('frame for: ok');
