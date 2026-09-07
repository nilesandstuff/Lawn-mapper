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

/* ------------------------------------------------------------ the frame */
/**
 * Some sources cannot serve an arbitrary frame, so the frame moves to them.
 *
 * Google's Static Maps endpoint takes an INTEGER zoom. Our frames come from
 * zoomToFit and are fractional -- 19.66 on a real lot -- and Google floors
 * anything else, which would return a picture of a different rectangle than
 * the one the mask is unprojected against. Every lawn traced from it would be
 * measured against the wrong ground and look completely plausible.
 *
 * The fix is not to fight it: the frame is ours to choose, so when Google is
 * the source the frame is rebuilt at a zoom Google can actually serve. Always
 * DOWN (Math.floor), never up -- flooring zooms out, so the parcel that fitted
 * before still fits. Rounding up could crop the far end of a deep lot.
 *
 * Everything downstream already treats the server's echoed frame as
 * authoritative, so an adjusted frame flows through unprojection, the overlay
 * and the export without any of them needing to know why.
 */
export function providerFrame(provider, frame) {
  const p = PROVIDERS[normaliseProvider(provider)];
  return p.frame ? p.frame(frame) : frame;
}

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
    /*
     * Tested, and it does not work. Kept as something to look at, because
     * seeing where the vegetation is remains useful, but it is no longer
     * offered to the detector.
     *
     * The idea was sound and the imagery is not up to it. NDVI does ignore
     * shadow, exactly as hoped -- but NAIP is 30 cm native against a frame
     * asking for about 3.5 cm, so every edge arrives soft, and the contrast
     * between turf and tree canopy turned out too weak to separate them at
     * that resolution. Two failures at once: boundaries no crisper than the
     * shadows they replaced, and no way to tell the trees from the lawn.
     *
     * Fixing it would need finer multispectral imagery than anything free,
     * so this is a dead end rather than an unfinished feature.
     */
    detect: false,
    note: 'Shows where vegetation is. Measured against real lawns and rejected: NAIP is too coarse at this zoom, and grass and tree canopy do not separate.',
    url: (frame) => arcgisImage(USGS_NAIP, frame, 'NDVI_Color'),
  },

  /*
   * Google's satellite view, which is what most people picture when they think
   * of aerial imagery, and often a different year again from Mapbox.
   *
   * Only offered when GOOGLE_MAPS_KEY is set -- the Static Maps endpoint is
   * billed per request, so an unconfigured deployment must not advertise a
   * source that will 403 the moment anyone picks it.
   *
   * Two conversions matter and neither is optional:
   *
   *   TILES. Google is a 256-pixel tile scheme; Mapbox is 512. The same ground
   *   scale is therefore Google zoom = Mapbox zoom + 1, because
   *   512 * 2^z === 256 * 2^(z+1). Getting this wrong is a factor of two in
   *   every distance and a factor of four in every area.
   *
   *   SIZE. 640x640 at scale=2 is Google's maximum and returns 1280 px, which
   *   is exactly what Mapbox @2x gives for a 640 frame. The two sources are
   *   the same picture size of the same ground.
   */
  google: {
    label: 'Google satellite',
    note: 'Often a different year again, and the imagery most people recognise. Costs a fraction of a cent per look.',
    detect: true,
    prompt: 'grass',
    promptVar: 'SAM_PROMPT',
    keyVar: 'GOOGLE_MAPS_KEY',
    // Google floors fractional zoom, so meet it at an integer one.
    frame: (frame) => ({ ...frame, zoom: Math.floor(frame.zoom) }),
    url: (frame, _token, env) =>
      'https://maps.googleapis.com/maps/api/staticmap?' + new URLSearchParams({
        center: `${frame.lat},${frame.lng}`,
        zoom: String(Math.floor(frame.zoom) + 1), // 512px tiles -> 256px tiles
        size: '640x640',
        scale: '2',
        maptype: 'satellite',
        format: 'png',
        key: env?.GOOGLE_MAPS_KEY || '',
      }),
  },

  esri: {
    // No "(look only)" in the name. The picker, the on-map list and the tip
    // all mark a view-only source themselves, from `detect` -- baking it into
    // the label as well produced "Esri World Imagery (look only) (view only)".
    label: 'Esri World Imagery',
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

/**
 * The picture for a source, for LOOKING at.
 *
 * Deliberately not detectionProvider. Looking and detecting are different
 * questions, and collapsing them is a bug with no symptom: asking for the NDVI
 * preview and being handed Mapbox pixels would draw a perfectly good
 * photograph of the right place, and the person comparing sources would be
 * comparing Mapbox with itself. A source that cannot render one image of the
 * frame at all (Esri, which serves only tiles) returns null rather than
 * substituting something else.
 */
export function imageryUrl(provider, frame, token, env) {
  const p = PROVIDERS[normaliseProvider(provider)];
  return p.url ? p.url(providerFrame(provider, frame), token, env) : null;
}

/** The picture for MEASURING from, which is never a source that cannot answer. */
export function detectionImageUrl(provider, frame, token, env) {
  const id = detectionProvider(provider);
  return PROVIDERS[id].url(providerFrame(id, frame), token, env);
}

/** The wording the detector gets, for this source, with env overrides. */
export function imageryPrompt(provider, env) {
  const p = PROVIDERS[detectionProvider(provider)];
  return String(env?.[p.promptVar] || p.prompt).trim();
}

/**
 * What the browser needs to build the picker, without duplicating the list.
 *
 * A source that needs a key it has not been given is left out entirely rather
 * than offered and then failing: picking it would spend a click to learn that
 * the deployment was never configured for it.
 */
export const providerCatalogue = (env) =>
  Object.entries(PROVIDERS)
    .filter(([, p]) => !p.keyVar || Boolean(env?.[p.keyVar]))
    .map(([id, p]) => ({
      id,
      label: p.label,
      note: p.note,
      detect: Boolean(p.detect),
      tiles: p.tiles || null,
      // The frame this source will actually be served at, so the browser can
      // place a preview on the same ground the detector will measure.
      integerZoom: Boolean(p.frame),
    }));

/** Is this source usable at all in this deployment? */
export const providerAvailable = (provider, env) => {
  const p = PROVIDERS[normaliseProvider(provider)];
  return !p.keyVar || Boolean(env?.[p.keyVar]);
};
