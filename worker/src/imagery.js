/**
 * Where the satellite picture comes from.
 *
 * The app measures against a FRAME -- a centre, a zoom and a pixel size -- and
 * every lng/lat it derives from a mask pixel assumes the picture covers exactly
 * the rectangle that frame describes. Mapbox's static endpoint is defined that
 * way by construction: you give it a centre and a zoom and it gives you that
 * square. Nothing else here is. An ArcGIS image service takes a bounding box
 * and a pixel size, and is entitled to hand back a slightly different extent --
 * snapped to its own grid, or letterboxed to keep an aspect ratio.
 *
 * That is the whole risk in offering a choice of imagery: a source that is off
 * by a few metres does not look broken. The lawn traces fine, the number looks
 * plausible, and it is wrong. So the bbox below is derived from frameCorners()
 * -- the same function the browser uses to place the mask -- rather than
 * recomputed, and tools/probe-imagery.js checks each service's returned extent
 * against the requested one before a source is allowed in here. Both USGS
 * services came back at 0.000 m offset; Esri's export came back 0x0 and is
 * therefore not a source, only a basemap (see probe-imagery.js).
 */

import { frameCorners } from '../../public/lib/mercator.js';

/* ------------------------------------------------------------ projection */
/**
 * lng/lat -> EPSG:3857 metres. ArcGIS wants a bbox in a projected system, and
 * Web Mercator is the one the frame is already axis-aligned in, so the frame's
 * corners map to a rectangle rather than a rotated quadrilateral.
 */
const R = 20037508.342789244;
const toMercator = ([lng, lat]) => [
  (lng * R) / 180,
  (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * (R / 180),
];

/** The frame as [west, south, east, north] in EPSG:3857 metres. */
export function frameBbox3857(frame) {
  const corners = frameCorners(frame); // NW, NE, SE, SW
  const [west, north] = toMercator(corners[0]);
  const [east, south] = toMercator(corners[2]);
  return [west, south, east, north];
}

/**
 * How many real pixels the returned image has on a side.
 *
 * Mapbox is asked at @2x, so a 640-logical frame arrives as 1280 px. Every
 * other source has to match that or the same lawn is traced at half the
 * detail. (Nothing downstream depends on the number -- the browser reads the
 * image's own width -- but the sources should be compared like for like.)
 */
export const imagePixels = (frame) => Math.min(frame.size * 2, 2560);

/* -------------------------------------------------------------- sources */

const USGS_NAIP = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer';

/**
 * One ArcGIS image-service request for exactly our frame.
 *
 * `f=image` returns pixels; the same call with f=json returns the extent it
 * served, which is what the probe compares. bboxSR and imageSR are both 3857
 * so no reprojection happens between what we ask for and what we get.
 */
function arcgisImage(root, frame, renderingRule) {
  const px = imagePixels(frame);
  const params = new URLSearchParams({
    bbox: frameBbox3857(frame).join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${px},${px}`,
    format: 'png',
    f: 'image',
  });
  if (renderingRule) params.set('renderingRule', JSON.stringify({ rasterFunction: renderingRule }));
  return `${root}/exportImage?${params}`;
}

/**
 * The sources a person can pick between.
 *
 * `prompt` is per source because the detector is being shown a different kind
 * of picture, not the same picture from a different vendor. Asking for "grass"
 * on a false-colour vegetation index is asking about a thing that is not in
 * the image. Each is overridable by env var so a better wording can be
 * deployed without a code change, and measured with tools/probe-sam3.js.
 */
export const PROVIDERS = {
  mapbox: {
    label: 'Mapbox satellite',
    note: 'The default. Sharpest of the four, and the one every measurement so far was made on.',
    detect: true,
    prompt: 'grass',
    promptVar: 'SAM_PROMPT',
    url: (frame, token) =>
      `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
      `${frame.lng},${frame.lat},${frame.zoom},0/${frame.size}x${frame.size}@2x` +
      `?access_token=${token}&attribution=false&logo=false`,
  },

  naip: {
    label: 'USGS aerial (NAIP)',
    // 30 cm native against a frame that asks for about 3.5 cm, so this is
    // upsampled roughly eight times. Whether that is worse than Mapbox depends
    // entirely on which year each was flown and what the light was doing --
    // which is the reason for offering the choice rather than picking one.
    note: 'Government aerial photography, reflown every 2-3 years. Softer than Mapbox but often a different year and different light.',
    detect: true,
    prompt: 'grass',
    promptVar: 'SAM_PROMPT',
    url: (frame) => arcgisImage(USGS_NAIP, frame),
  },

  ndvi: {
    label: 'USGS vegetation index (NDVI)',
    /*
     * The interesting one. NAIP carries a near-infrared band, and healthy
     * vegetation reflects far more infrared than anything built. NDVI is the
     * contrast between those two bands, so it separates growing things from
     * pavement using a signal that a shadow barely touches -- which is the
     * failure mode we keep hitting, lawn in shade read as not-lawn.
     *
     * It does not distinguish grass from trees by brightness the way a photo
     * does; it distinguishes both from everything else. So this is a different
     * detection problem, not a clearer version of the same one, and the prompt
     * has to say so.
     */
    note: 'Infrared vegetation index. Shadows barely affect it, so lawn in shade still reads as lawn — but trees and grass look alike, so expect to erase canopy.',
    detect: true,
    prompt: 'green vegetation',
    promptVar: 'SAM_PROMPT_NDVI',
    url: (frame) => arcgisImage(USGS_NAIP, frame, 'NDVI_Color'),
  },

  esri: {
    label: 'Esri World Imagery (look only)',
    /*
     * Esri is a cached basemap: singleFusedMapCache is true and
     * exportTilesAllowed is false, so it serves pre-baked tiles and refuses to
     * draw an arbitrary rectangle -- its export operation answers every request
     * with a correct extent and an image zero pixels wide. Tiles are enough to
     * LOOK at (they are fixed Web Mercator squares, which is the projection the
     * frame is already in, so the map places them correctly and for free), and
     * not enough to DETECT from, which needs one image of our exact frame.
     *
     * Kept anyway, because looking is most of the point: the reason to want a
     * second source is to see whether the trees are in leaf and how old the
     * photo looks, and that judgement is made by eye before anything is spent.
     */
    detect: false,
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    note: 'Often a different year again — worth a look. Esri only serves fixed tiles, so detection falls back to Mapbox.',
  },
};

export const DEFAULT_PROVIDER = 'mapbox';

/** Anything unrecognised falls back to the default rather than failing. */
export const normaliseProvider = (value) =>
  Object.prototype.hasOwnProperty.call(PROVIDERS, value) ? value : DEFAULT_PROVIDER;

/**
 * The source to actually segment from.
 *
 * Separate from normaliseProvider because a source can be worth looking at
 * without being able to answer the detector -- Esri is exactly that. Falling
 * back is the right behaviour, but it must be a *visible* fallback: the UI says
 * which source a measurement came from, so this never quietly substitutes one
 * picture for another.
 */
export function detectionProvider(value) {
  const id = normaliseProvider(value);
  return PROVIDERS[id].detect ? id : DEFAULT_PROVIDER;
}

export function imageryUrl(provider, frame, token) {
  return PROVIDERS[detectionProvider(provider)].url(frame, token);
}

/** The wording the detector gets, for this source, with env overrides. */
export function imageryPrompt(provider, env) {
  const p = PROVIDERS[detectionProvider(provider)];
  return String(env?.[p.promptVar] || p.prompt).trim();
}

/** What the browser needs to build the picker, without duplicating the list. */
export const providerCatalogue = () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    note: p.note,
    detect: Boolean(p.detect),
    tiles: p.tiles || null,
  }));
