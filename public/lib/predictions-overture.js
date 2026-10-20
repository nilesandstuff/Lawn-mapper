/*
 * THE ROAD AND SIDEWALK CENTRELINES OVER EACH LAWN ON THE PREDICTIONS PAGE.
 *
 * Owner, 2026-10-20, after judging the shapes here by eye: Overture's
 * buildings are scrapped for the lawn map ("some shapes are just plain wrong
 * when aligned correctly"); the road and sidewalk lines stay, as lines only,
 * since "the center lines of the shapes do seem to always fall on actual
 * roads/sidewalks, just not always on the center". So two layers, drawn by the
 * browser on one canvas over the run's photo, on every run drawn with layers:
 *
 *   ovtRoad   OpenStreetMap's road centrelines, a thin blue line
 *   ovtWalk   OpenStreetMap's sidewalk, footway and path lines, thin pink
 *
 * These are what the decoder is given (tools/overture-frames.js, one channel:
 * 1 on a line falling to 0 two metres off it), so the page shows what the
 * trial sees. Read straight from Overture's public tiles (lib/overture.js)
 * for the frame of each lawn as it is scrolled to, once per lawn.
 */
import { overtureFor } from './overture.js';
import { lngLatToFramePx, frameCorners } from './mercator.js';

export const OVERTURE_LAYERS = [
  { id: 'ovtRoad', label: 'OSM road centreline', colour: [61, 123, 255], on: true, client: true },
  { id: 'ovtWalk', label: 'OSM sidewalk / path line', colour: [255, 79, 216], on: true, client: true },
];

/** The run's layers with these slid in under the detector's outline and the property line. */
export function withOverture(defs) {
  const out = defs.filter((l) => !OVERTURE_LAYERS.some((o) => o.id === l.id));
  let at = out.findIndex((l) => l.id === 'shapes');
  if (at < 0) at = out.findIndex((l) => l.id === 'line');
  if (at < 0) at = out.length;
  out.splice(at, 0, ...OVERTURE_LAYERS);
  return out;
}

const R = 6378137;
const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];

/** A photo frame's box in web-mercator metres [w, s, e, n], and cos(lat) for ground metres. */
export function frameBox(frame) {
  const c = frameCorners(frame); // NW, NE, SE, SW
  const [w, n] = toMerc(c[0]), [e, s] = toMerc(c[2]);
  return { box: [w, s, e, n], k: Math.cos((frame.lat * Math.PI) / 180) };
}

/* Margin round the frame, in ground metres, so a line just outside the
   picture is still fetched (its skirt reaches in). */
const MARGIN_M = 10;

/* Overture's answer per frame, fetched once: the list and the full-size view
   draw the same lawn, and a lawn scrolled past twice is one fetch. */
const fetched = new Map();
function overtureOf(frame) {
  const key = `${frame.lng},${frame.lat},${frame.zoom},${frame.size},${frame.height || ''}`;
  if (!fetched.has(key)) {
    const { box, k } = frameBox(frame);
    const m = MARGIN_M / k;
    const [w, s, e, n] = box;
    fetched.set(key, overtureFor([w - m, s - m, e + m, n + m]).catch((err) => { fetched.delete(key); throw err; }));
  }
  return fetched.get(key);
}

/**
 * Draw the lines on ONE canvas over the lawn `e` ({ frame }) -- one, not one
 * per layer, because a page of thirty lawns at several canvases each is more
 * picture memory than a phone has. `on` maps layer id to whether it shows.
 * Resolves to { caption, redraw }: a line of text for under the picture, and
 * a function that draws the canvas again from what was read, for when a
 * switch changes.
 */
export async function drawOverture(e, canvas, on) {
  const frame = e.frame;
  const W = canvas.width, H = canvas.height;
  const ov = await overtureOf(frame);
  const px = (p) => lngLatToFramePx(frame, p, W, H);
  const roads = (ov.roads || []).map((r) => ({ walk: r.walk, lines: (r.lines || []).filter((l) => l.length >= 2).map((l) => l.map(px)) }));
  const redraw = (show) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.5, W / 640);
    for (const r of roads) {
      if (!(r.walk ? show.ovtWalk : show.ovtRoad)) continue;
      ctx.strokeStyle = r.walk ? 'rgba(255,79,216,0.95)' : 'rgba(61,123,255,0.95)';
      for (const pts of r.lines) {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
    }
  };
  redraw(on || {});
  const n = (walk) => roads.filter((r) => r.walk === walk).reduce((t, r) => t + r.lines.length, 0);
  return { caption: linesText(n(false), n(true)), redraw };
}

/** One line about what was drawn, for the caption. Pure. */
export function linesText(roads, walks) {
  const s = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
  if (!roads && !walks) return 'No road or sidewalk line from OpenStreetMap (via Overture) over this frame.';
  return `${s(roads, 'road centreline')}, ${s(walks, 'sidewalk or path line')} from OpenStreetMap via Overture. Each falls somewhere on a road, sidewalk or driveway, not always its middle.`;
}
