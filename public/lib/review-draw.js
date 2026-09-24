/**
 * Drawing a stored map: the photograph, the property line, the outlines.
 *
 * SHARED BY THE CONSOLE AND THE EVERY-MAP PAGE, and that is the whole reason
 * it is a module. admin.js imports the app's own projection rather than
 * reimplementing it, on the grounds that a card which puts an outline anywhere
 * but where the map drew it makes every judgement on the page a judgement
 * about the wrong pixels. A second copy of the drawing itself would reopen
 * exactly that hole one file over -- two pages showing the same lawn slightly
 * differently, and no way to tell which one to believe.
 *
 * The every-map page needs this because a list of square footages cannot
 * answer the question it exists for. Two rows for one garden are told apart by
 * looking at them.
 */

import { lngLatToFramePx } from './mercator.js';
import { distinctFraction } from './mask.js';

export const REVIEW_COLOURS = {
  parcel: '#f2c744',   // the property line: the thing never guessed
  lawn: '#4ec26a',     // what was finished, and what is being judged
  ai: '#e2725b',       // what the detector drew, when asked for
  // Lawn the reviewer knows is there and cannot see. Deliberately not a shade
  // of the lawn green: this is a different kind of claim, not a weaker one.
  inferred: '#b388ff',
};


/*
 * BOTH STORED FORMS, in one place.
 *
 * Maps traced before shapes could be marked "inferred, not seen" hold bare
 * geometries; maps traced since hold Features. Everything that draws a
 * candidate goes through here, so neither form has to be remembered anywhere
 * else -- and an old map keeps drawing exactly as it did.
 */
export const shapeParts = (c) => (c.shapes || []).map((f) => ({
  geometry: f?.geometry || f,
  inferred: Boolean(f?.properties?.inferred),
}));

export function overlapFraction(c) {
  const shapes = shapeParts(c)
    .map((p) => p.geometry?.coordinates)
    .filter((r) => Array.isArray(r) && r.length);
  if (!c.frame || shapes.length < 2) return 0;
  const G = 256;
  const project = (ll) => lngLatToFramePx(c.frame, ll, G, G);
  const distinct = distinctFraction(shapes, G, G, project);
  return distinct > 0 ? (1 / distinct) - 1 : 0;
}

export function paint(canvas, c, { showAi = false } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  /*
   * THE FRAME OF THE PICTURE BEING DRAWN ON, not the frame the phone showed.
   *
   * The photograph under this canvas is the STORED one, and since workflow 21
   * that is banked as the rectangle round the parcel at 10 cm -- a different
   * rectangle from the display frame whenever the display frame was not
   * already that: every map drawn on Google (a 640-square at a whole zoom) and
   * every map from before the frames were cropped to the parcel. Projecting
   * the outlines with the display frame put them a long way off the picture
   * on those maps, which read as the map being wrong. It was not: the editor
   * lays the display frame on live tiles and was right, and the training tools
   * have projected against image_frame since the column existed. Only this
   * card disagreed, so only this card is fixed.
   *
   * Without a photograph there is nothing to line up with, and the display
   * frame is as good a rectangle as any.
   */
  const frame = c.hasImage && c.imageFrame ? c.imageFrame : c.frame;

  const overlay = () => {
    if (!frame) {
      ctx.fillStyle = '#7a8578';
      ctx.font = '16px system-ui, sans-serif';
      ctx.fillText('No frame stored, so this cannot be drawn to scale.', 18, 30);
      return;
    }
    /*
     * ONE PATH FOR ALL THE RINGS, FILLED EVEN-ODD.
     *
     * A polygon here is an outline plus its holes -- a shed or a pool cut out
     * of the lawn. Filling each ring in its own path painted the hole GREEN on
     * top of the lawn, which is precisely inverted: the reviewer saw the shed
     * marked as grass and was being asked to approve it as a training example.
     * Even-odd is the same rule the measurement and the raster already use, so
     * what is drawn here is what was counted.
     */
    const ring = (geometry, colour, width, fill) => {
      const rings = geometry?.coordinates || [];
      if (!rings.length) return;
      ctx.beginPath();
      for (const coords of rings) {
        coords.forEach(([lng, lat], i) => {
          const [x, y] = lngLatToFramePx(frame, [lng, lat], W, H);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    if (c.parcel) ring(c.parcel, REVIEW_COLOURS.parcel, 2.5);

    /*
     * ORDER MATTERS, and it was wrong.
     *
     * The AI outline was drawn first and the lawn painted over it with a
     * translucent green fill, which washed it out. Pressing "show the AI's
     * version" changed almost nothing on screen, so the one way to tell which
     * pieces a person drew and which the detector did was unusable.
     *
     * With the AI shown the lawn drops its fill and the AI goes on top, dashed.
     * Two outlines, both readable, which is the whole point of the comparison.
     */
    const showing = showAi && (c.detectedShapes || []).length;
    for (const part of shapeParts(c)) {
      /*
       * Inferred areas are drawn dashed and in their own colour, because the
       * point of this queue is deciding whether the mark is right -- and a
       * mark you cannot see on the picture is one nobody can check.
       */
      if (part.inferred) ctx.setLineDash([5, 4]);
      ring(
        part.geometry,
        part.inferred ? REVIEW_COLOURS.inferred : REVIEW_COLOURS.lawn,
        2.5,
        showing ? null : (part.inferred ? 'rgba(179,136,255,.25)' : 'rgba(78,194,106,.22)')
      );
      if (part.inferred) ctx.setLineDash([]);
    }
    if (showing) {
      ctx.setLineDash([6, 4]);
      for (const g of c.detectedShapes) ring(g, REVIEW_COLOURS.ai, 2);
      ctx.setLineDash([]);
    }
  };

  if (!c.hasImage) { overlay(); return; }

  const img = new Image();
  /* Drawn only once the picture is there, so the outline never briefly sits on
     an empty square and reads as a mask over nothing. */
  img.onload = () => { ctx.drawImage(img, 0, 0, W, H); overlay(); };
  img.onerror = () => overlay();
  img.src = `/api/admin/candidate-image?id=${encodeURIComponent(c.id)}`;
}
