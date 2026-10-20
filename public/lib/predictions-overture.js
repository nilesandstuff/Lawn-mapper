/*
 * OVERTURE'S BUILDINGS AND OPENSTREETMAP'S ROADS AND SIDEWALKS OVER EACH LAWN
 * ON THE PREDICTIONS PAGE (owner, 2026-10-20: "I'd want to be able to see the
 * building shapes and the road/sidewalk shapes lined up myself before deciding
 * how I want to deal with all of that").
 *
 * Four layers, drawn by the browser on a canvas over the run's photo, so they
 * appear on every run that was drawn with layers, not only runs made after
 * today:
 *
 *   ovtRoad      OpenStreetMap's road centrelines, as a band at the typical
 *                width Overture gives the road class (the kerb is not known)
 *   ovtWalk      OpenStreetMap's sidewalks and footways: the line itself, and
 *                a band at their typical width
 *   ovtBuilding  Overture's building footprints exactly as published
 *   ovtFit       the same footprints moved, all together, onto the run's own
 *                lidar roof mask (the blue "lidar roof" layer), the way the
 *                training run's `overture: aligned` arm moves them
 *
 * Read straight from Overture's public tiles (lib/overture.js) for the frame
 * of each lawn as it is scrolled to, once per lawn; the fit comes from the
 * roof frame of the run's own layers image. Nothing here touches the run.
 */
import { overtureFor } from './overture.js';
import { lngLatToFramePx } from './mercator.js';
import { fitFrame, frameGrid } from './overture-fit.js';

export const OVERTURE_LAYERS = [
  { id: 'ovtRoad', label: 'OSM road, typical width', colour: [61, 123, 255], on: true, client: true },
  { id: 'ovtWalk', label: 'OSM sidewalk', colour: [255, 79, 216], on: true, client: true },
  { id: 'ovtBuilding', label: 'Overture building, as published', colour: [255, 230, 0], on: true, client: true },
  { id: 'ovtFit', label: 'Overture building, moved onto the lidar roof', colour: [0, 229, 255], on: true, client: true },
];

/** The run's layers with these four slid in under the detector's outline and the property line. */
export function withOverture(defs) {
  const out = defs.filter((l) => !OVERTURE_LAYERS.some((o) => o.id === l.id));
  let at = out.findIndex((l) => l.id === 'shapes');
  if (at < 0) at = out.findIndex((l) => l.id === 'line');
  if (at < 0) at = out.length;
  out.splice(at, 0, ...OVERTURE_LAYERS);
  return out;
}

/* Margin round the frame, in ground metres, so a road whose centreline is
   just outside the picture still draws its band inside it. */
const MARGIN_M = 20;

/* Overture's answer per frame, fetched once: the list and the full-size view
   draw the same lawn, and a lawn scrolled past twice is one fetch. */
const fetched = new Map();
function overtureOf(frame) {
  const key = `${frame.lng},${frame.lat},${frame.zoom},${frame.size},${frame.height || ''}`;
  if (!fetched.has(key)) {
    const g = frameGrid(frame);
    const m = MARGIN_M / g.k;
    const [w, s, e, n] = g.box;
    fetched.set(key, overtureFor([w - m, s - m, e + m, n + m]).catch((err) => { fetched.delete(key); throw err; }));
  }
  return fetched.get(key);
}

/**
 * The run's lidar roof frame as a mask on the fit grid, read from the layers
 * image: frame `k` of `N` stacked frames, each `px` by `py`. Null when the
 * image cannot be read or the frame is blank (no lidar over this lawn).
 */
export async function roofFromSprite(url, k, N, px, py, W, H) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try { await img.decode(); } catch { return null; }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, k * py, px, py, 0, 0, W, H);
  const a = ctx.getImageData(0, 0, W, H).data;
  const data = new Uint8Array(W * H);
  let n = 0;
  /* The roof is drawn as a checker of opaque blocks (render-prediction.js), so
     shrunk to half-metre cells it averages to about half alpha; anything
     clearly above the background counts. */
  for (let i = 0; i < W * H; i++) if (a[i * 4 + 3] > 40) { data[i] = 1; n++; }
  return n ? { data, w: W, h: H } : null;
}

/** Fit results per frame, so the full-size view does not search again. */
const fits = new Map();

/**
 * Draw the four layers on ONE canvas over the lawn `e` ({ frame, renderPx,
 * renderPy }) -- one, not four, because a page of thirty lawns at four
 * canvases each is more picture memory than a phone has. `on` maps layer id
 * to whether it shows; `roof` is a promise of the lidar roof mask on the fit
 * grid, or null. Resolves to { caption, redraw }: a line about the fit for
 * under the picture, and a function that draws the canvas again from what
 * was read, for when a switch changes.
 */
export async function drawOverture(e, canvas, roof, on) {
  const frame = e.frame;
  const W = canvas.width, H = canvas.height;
  const ov = await overtureOf(frame);
  const g = frameGrid(frame);
  const groundW = (g.box[2] - g.box[0]) * g.k; // ground metres across the picture
  const pxPerM = W / groundW;
  const px = (p) => lngLatToFramePx(frame, p, W, H);
  const roads = (ov.roads || []).map((r) => ({ walk: r.walk, width: r.width, lines: (r.lines || []).filter((l) => l.length >= 2).map((l) => l.map(px)) }));
  const rings = (ov.buildings || []).map((poly) => (poly?.[0] && poly[0].length >= 4 ? poly[0].map(px) : null)).filter(Boolean);

  /* The fit: one shift for the lot, onto the lidar's roofs. */
  const key = `${frame.lng},${frame.lat},${frame.zoom},${frame.size},${frame.height || ''}`;
  let fit = fits.get(key);
  if (fit === undefined) {
    const mask = await roof;
    fit = mask ? fitFrame(frame, ov.buildings || [], mask) : null;
    fits.set(key, fit);
  }

  const redraw = (show) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const path = (pts, close = false) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (close) ctx.closePath();
    };
    for (const r of roads) {
      if (!(r.walk ? show.ovtWalk : show.ovtRoad)) continue;
      for (const pts of r.lines) {
        ctx.strokeStyle = r.walk ? 'rgba(255,79,216,0.45)' : 'rgba(61,123,255,0.35)';
        ctx.lineWidth = Math.max(1, (r.width || 3) * pxPerM);
        path(pts); ctx.stroke();
        if (r.walk) {
          ctx.strokeStyle = 'rgba(255,79,216,0.95)';
          ctx.lineWidth = Math.max(1.5, W / 640);
          path(pts); ctx.stroke();
        }
      }
    }
    const outline = (dx, dy, colour) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = Math.max(2, W / 480);
      for (const ring of rings) { path(ring.map(([x, y]) => [x + dx, y + dy]), true); ctx.stroke(); }
    };
    if (show.ovtBuilding) outline(0, 0, 'rgba(255,230,0,0.95)');
    if (show.ovtFit && fit?.applied) outline(fit.eastM * pxPerM, fit.southM * pxPerM, 'rgba(0,229,255,0.95)');
  };
  redraw(on || {});
  return { caption: fitText(fit, rings.length, roads.reduce((n, r) => n + r.lines.length, 0)), redraw };
}

/** One line about what the fit found, for the caption. Pure. */
export function fitText(fit, buildings, roads) {
  const what = `${buildings} building${buildings === 1 ? '' : 's'}, ${roads} road or sidewalk line${roads === 1 ? '' : 's'} from Overture`;
  if (!buildings) return `${what}.`;
  if (!fit) return `${what}. No lidar roof here to fit the buildings to.`;
  const m = (v) => `${Math.abs(v).toFixed(1)} m ${v >= 0 ? 'E' : 'W'}`;
  const nm = (v) => `${Math.abs(v).toFixed(1)} m ${v >= 0 ? 'S' : 'N'}`;
  const pc = (v) => `${Math.round(v * 100)}%`;
  if (!fit.applied) return `${what}. Left as published: moving them would not overlap the lidar roof better (${pc(fit.iou0)} as published, ${pc(fit.iou)} at best).`;
  return `${what}. Moved ${m(fit.eastM)}, ${nm(fit.southM)} onto the lidar roof: overlap ${pc(fit.iou0)} as published, ${pc(fit.iou)} moved.`;
}

/* Exported for the page's sizing of the roof read. */
export { frameGrid };
