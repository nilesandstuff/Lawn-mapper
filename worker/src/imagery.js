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

import { frameCorners, frameHeight } from '../../public/lib/mercator.js';

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
/** And down, for a frame that is not square. */
export const imageHeightPixels = (frame) => Math.min(frameHeight(frame) * 2, 2560);

/**
 * How many metres of ground one RETURNED pixel covers, for a frame.
 *
 * Exact Web Mercator, not an estimate: a tile scheme is 512 logical pixels
 * across the world at zoom 0, doubling each zoom, and `@2x` returns two pixels
 * per logical one. There is nothing to infer and nothing to probe.
 */
export const groundPerPixel = (frame) =>
  (40075016.686 * Math.cos((frame.lat * Math.PI) / 180))
  / (512 * 2 ** frame.zoom) / 2;

/** Metres of ground across a whole frame, and down it. */
export const groundAcross = (frame) => groundPerPixel(frame) * frame.size * 2;
export const groundDown = (frame) => groundPerPixel(frame) * frameHeight(frame) * 2;

/**
 * What the DETECTOR wants a pixel to be worth, in metres.
 *
 * The canopy model was trained at 10 cm and the lawn detector is scored at the
 * same scale. This is the number the stored photograph should be captured at.
 */
export const TARGET_GROUND_M = 0.10;

/** Mapbox will not serve a static image wider than this many logical pixels. */
export const MAX_LOGICAL = 1280;

/**
 * The most tiles one photograph is allowed to be stitched from.
 *
 * Four requests covers a lot up to about 512 m across at 10 cm a pixel, which
 * is past anything the corpus has seen. The limit exists because the cost is
 * quadratic in both directions -- requests AND stored bytes -- and a 3x3 of a
 * farm would be nine calls for a 7,700-pixel image nobody asked for. Past it
 * the photograph is coarser and says so.
 */
export const MAX_TILES_ACROSS = 2;

/**
 * The frame to BANK a training photograph at, which is not the frame the phone
 * is showing.
 *
 * THE BUG THIS FIXES, and it is the whole of H20. `zoomToFit` picks a zoom that
 * fits the parcel inside a fixed 640 logical pixels, so the RESOLUTION of a
 * stored photograph falls out of how big the lot is: a 25 m garden is banked at
 * 2 cm a pixel and a 319 m lot at 25 cm. The detector's needs never entered
 * into it. Then the training tools resample every frame to 10 cm -- averaging
 * real detail away on the small lots, and INVENTING pixels on the big ones.
 * That is why the canopy model reads worse on big lawns: it was being handed
 * interpolation and told it was imagery.
 *
 * So the zoom is pinned to the target ground size and the SIZE varies to cover
 * the lot, which is the other way round from the display frame. At 10 cm a
 * pixel that fits a lot up to about 256 m across in one request.
 *
 * PAST THAT, THE RESULT IS COARSER AND SAYS SO. Mapbox caps one static image at
 * 1280 logical pixels, so a bigger lot cannot be had at 10 cm from a single
 * call -- it would need tiling. Rather than silently returning something
 * different from what was asked, the frame is clamped and the caller is handed
 * the ground size it actually achieved, so nothing downstream has to guess.
 */
export function captureFrame(frame, target = TARGET_GROUND_M, { maxLogical = MAX_LOGICAL * MAX_TILES_ACROSS } = {}) {
  const across = groundAcross(frame);
  const down = groundDown(frame);
  const height0 = frameHeight(frame);

  /*
   * NEVER COARSER THAN THE DISPLAY FRAME ALREADY MANAGES, which is why the
   * floor is `frame.size` rather than whatever the target needs.
   *
   * A small lot is already banked far finer than 10 cm -- a 25 m garden comes
   * back at 2 cm -- and it costs exactly the same request to keep it, because
   * the frame is 640 logical either way. Pinning everything to 10 cm would
   * have thrown that away to hit a number, and thrown it away permanently:
   * the photograph is the archive, and a future model that wants 5 cm cannot
   * ask this one again in two years' time when the imagery has been reflown.
   *
   * So the rule is only ever upward. Raise the size until a pixel is worth
   * 10 cm or better, and leave alone anything that already clears it.
   *
   * RECTANGLES KEEP THEIR SHAPE. The rule is applied to the longer side and
   * the shorter one follows at the same scale, so a frame cropped to a long
   * thin parcel stays a long thin picture rather than growing back into the
   * square it was cropped out of.
   */
  const longM = Math.max(across, down);
  const long0 = Math.max(frame.size, height0);
  const wanted = Math.ceil(longM / target / 2);
  const ceiling = maxLogical;
  const long = Math.min(ceiling, Math.max(long0, wanted));
  const factor = long / long0;
  const size = Math.round(frame.size * factor);
  const height = Math.round(height0 * factor);

  /*
   * The zoom then follows from the size: whatever puts `across` metres into
   * `size` logical pixels. Fractional zooms are fine -- the static API takes
   * them, and rounding to an integer would cost up to 40% of the resolution
   * for nothing.
   */
  const zoom = Math.log2(
    (40075016.686 * Math.cos((frame.lat * Math.PI) / 180) * size) / (512 * across)
  );
  const out = { lng: frame.lng, lat: frame.lat, zoom, size, height };
  const groundM = groundPerPixel(out);

  return {
    frame: out,
    groundM,
    /* True when even a full grid of tiles could not reach the target: the lot
       is wider than about 512 m at 10 cm. The photograph is still far better
       than the display frame would have given, and the caller is told rather
       than left to assume it got what it asked for. */
    capped: long >= ceiling && groundM > target * 1.001,
    across,
    down,
  };
}

/**
 * The requests that actually make up one photograph.
 *
 * ONE CALL IS USUALLY ENOUGH and then this is a list of one. Past about 256 m
 * across at 10 cm a pixel the frame needs more logical pixels than Mapbox will
 * serve in a single static image, so the ground is split into a grid and the
 * pieces are stitched.
 *
 * THE SPLIT IS DONE IN WORLD PIXELS, not in degrees, and that is what makes
 * the seams invisible. Web Mercator is conformal and the static API centres a
 * frame on a coordinate, so two frames whose centres are exactly `size` world
 * pixels apart at the same zoom abut precisely. Splitting by longitude instead
 * would drift with latitude and leave a visible join -- and a join running
 * through a lawn is a feature the detector would learn.
 *
 * Returns tiles in reading order with their column and row, so a caller can
 * paste each one at (col * px, row * px) without recomputing anything.
 */
/**
 * THE FRAME FOR ONE LIVE REQUEST: captureFrame held to what Mapbox serves in
 * one picture (owner's report, 2026-10-02: a 620 m not-lawn map in Kent
 * County saved no photo). The Worker's banking and the trained model each
 * make ONE request, and Mapbox refuses anything over 1280 logical pixels, so
 * the full plan's 2560 got nothing at all for every frame past about 256 m --
 * no photo, and no trained-model detection. Here such a lot is photographed
 * coarser (a 620 m frame at 24 cm a pixel), flagged `capped`; workflow 21
 * (tools/refetch-imagery.js) still re-banks it at full resolution from
 * capturePlan's tiles.
 */
export const liveCaptureFrame = (frame, target = TARGET_GROUND_M) =>
  captureFrame(frame, target, { maxLogical: MAX_LOGICAL });

export function capturePlan(frame, target = TARGET_GROUND_M) {
  const shot = captureFrame(frame, target);
  const { zoom, size, height } = shot.frame;
  const cols = Math.ceil(size / MAX_LOGICAL);
  const rows = Math.ceil(height / MAX_LOGICAL);

  if (cols <= 1 && rows <= 1) {
    return {
      ...shot, cols: 1, rows: 1, tileSize: size, tileHeight: height,
      tiles: [{ frame: shot.frame, col: 0, row: 0 }],
    };
  }

  /* Equal tiles, so every piece is the same pixel size and the stitch is a
     plain paste. A remainder tile would be a second size to keep track of for
     no gain -- the total is rounded up instead. */
  return { ...shot, ...tileGrid(frame, zoom, Math.ceil(size / cols), Math.ceil(height / rows), cols, rows) };
}

/**
 * A `cols` x `rows` grid of frames, each `tileW` x `tileH` logical pixels,
 * centred as a whole on `frame` at `zoom`, plus the frame of the stitched
 * result. Shared by the banking plan and the live detection plan, because the
 * seam arithmetic is the part that must not be written twice.
 *
 * The stitched photograph covers `tileW * cols` by `tileH * rows` logical
 * pixels, so the frame recorded against it has to be the stitched one, or
 * every mask built from it would be a fraction of a lawn out.
 */
function tileGrid(frame, zoom, tileW, tileH, cols, rows) {
  const fullW = tileW * cols;
  const fullH = tileH * rows;
  const ws = 512 * 2 ** zoom;
  const cx = ((frame.lng + 180) / 360) * ws;
  const s = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, frame.lat)) * Math.PI) / 180);
  const cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws;

  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = cx - fullW / 2 + (col + 0.5) * tileW;
      const y = cy - fullH / 2 + (row + 0.5) * tileH;
      const n = Math.PI * (1 - (2 * y) / ws);
      tiles.push({
        col,
        row,
        frame: {
          lng: (x / ws) * 360 - 180,
          lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
          zoom,
          size: tileW,
          height: tileH,
        },
      });
    }
  }

  return {
    frame: { lng: frame.lng, lat: frame.lat, zoom, size: fullW, height: fullH },
    cols,
    rows,
    tileSize: tileW,
    tileHeight: tileH,
    tiles,
  };
}

/**
 * The pictures one LIVE detection is made from, so the model reads 10 cm a
 * pixel whatever the size of the lot.
 *
 * THE RULE THIS SERVES: every detector gets 10 cm a pixel unless a coarser
 * feed has been shown not to hurt. The live path did not: the browser asks for
 * the frame it is DISPLAYING -- the parcel fitted into 640 logical pixels,
 * 1280 px at @2x -- and sent that to SAM, which reads its input at a fixed
 * `inputPx` on the long side. So a 60 m lot reached the model at 6 cm and a
 * 172 m lot at 17 cm, and nothing said so. H20 again, on the path that
 * measures real lawns for real people.
 *
 * WHEN THE LOT FITS, NOTHING CHANGES. Below `inputPx` x 10 cm across (about
 * 100 m) the display frame already puts 10 cm or better into the model's
 * input, and it is sent exactly as before. Past that the ground is cut into
 * an n x n grid where each piece is `inputPx` pixels, the lot fills the grid
 * (so a piece is at the target or finer -- a lot that only just needed
 * cutting comes out at 5 cm), the model is asked once per piece, and the
 * browser pastes the masks back together on a grid the tiles were laid out
 * to abut on. Same arithmetic as capturePlan, same seam guarantee.
 *
 * `maxAcross` is the budget. Each tile is a prediction -- an allowance slot
 * and a Replicate request, against a rate limit of a handful a minute -- so
 * past the cap the pieces get coarser rather than more numerous, and the
 * plan says so in `capped` and `groundM`.
 *
 * Only Mapbox is tiled. NAIP is 30 cm native, so 10 cm asks for detail that
 * is not there; Google serves one fixed size at integer zooms; and neither
 * is the default. Those come back as a plan of one, which is the same shape,
 * so the handler has one path.
 */
export function detectionPlan(provider, frame, {
  inputPx = 1008, maxAcross = 2, target = TARGET_GROUND_M,
} = {}) {
  const id = detectionProvider(provider);
  const served = providerFrame(id, frame);
  const across = groundAcross(served);
  const down = groundDown(served);
  const longM = Math.max(across, down);
  const longPx = Math.max(served.size, frameHeight(served)) * 2;
  const one = {
    frame: served, cols: 1, rows: 1, tileSize: served.size, tileHeight: frameHeight(served),
    tiles: [{ frame: served, col: 0, row: 0 }],
    /* What the model actually resolves: the picture's longer side is read at
       `inputPx`, or as it is if it is already smaller. */
    groundM: longM / Math.min(inputPx, longPx),
    across, down, capped: false, wanted: 1,
  };
  if (id !== 'mapbox') return one;

  const wanted = Math.ceil(longM / (inputPx * target));
  /*
   * ONE PIECE MEANS THE PICTURE AS ASKED, not one piece at the target. With
   * pieces switched off (maxAcross 1, the default since H21) this used to
   * fall through to a 1 x 1 "grid" whose single tile was the whole lot at
   * 10 cm -- 1500 logical px for a 300 m lot, which Mapbox refuses (HTTP
   * 422), so the biggest lots could not be detected at all. The one-picture
   * path is the one H21 measured and the one the app took before pieces
   * existed; it is what "off" has to mean.
   */
  if (wanted <= 1 || maxAcross <= 1) return one;

  /* At exactly the target, each side cut into as many pieces of at most
     `inputPx` as it needs, each side capped separately. A capped piece is
     read shrunk, but it can never be asked for bigger than Mapbox serves. */
  const wantW = Math.ceil(across / target / 2);
  const wantH = Math.ceil(down / target / 2);
  const tile = inputPx / 2; // logical; Mapbox renders @2x
  const cols = Math.max(1, Math.min(maxAcross, Math.ceil(wantW / tile)));
  const rows = Math.max(1, Math.min(maxAcross, Math.ceil(wantH / tile)));
  const tileW = Math.min(MAX_LOGICAL, Math.ceil(wantW / cols));
  const tileH = Math.min(MAX_LOGICAL, Math.ceil(wantH / rows));
  /* The zoom that puts the lot's width into the stitched width: exactly the
     target when no side is capped, coarser when one is. */
  const zoom = Math.log2(
    (40075016.686 * Math.cos((frame.lat * Math.PI) / 180) * tileW * cols) / (512 * across)
  );
  const grid = tileGrid(frame, zoom, tileW, tileH, cols, rows);
  /* What the model resolves: a capped piece is bigger than its input and is
     read shrunk, so the ground a pixel covers grows with it. */
  const read = Math.max(tileW, tileH) * 2;
  return {
    ...grid,
    groundM: (groundPerPixel(grid.frame) * read) / Math.min(inputPx, read),
    across,
    down,
    capped: tileW > tile || tileH > tile,
    wanted,
  };
}

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

/**
 * One county service's picture of exactly our frame: an ArcGIS export of the
 * frame's Web Mercator box at the frame's pixel size -- or, where the service
 * will not draw that big, the biggest it will, same box, same shape (the
 * readers resample to their own grid either way).
 */
export function countyExportUrl(svc, frame) {
  if (!svc?.url) return null;
  /* A tile cache has no box to ask for: the picture is this Worker's own,
     stitched from the tiles (index.js handleImagery, tile-mosaic.js), so a
     detector is pointed here. */
  if (svc.tiled) {
    if (!svc.selfOrigin) return null;
    return `${svc.selfOrigin}/api/imagery?` + new URLSearchParams({
      lng: frame.lng, lat: frame.lat, zoom: frame.zoom, size: frame.size,
      height: frame.height || frame.size, provider: 'county', svc: svc.id,
    });
  }
  return countyBoxUrl(svc, frameBbox3857(frame), imagePixels(frame), imageHeightPixels(frame));
}

/** The same export for any Web Mercator box, at w x h or the biggest the
    service draws at that shape. */
export function countyBoxUrl(svc, bbox, w, h) {
  const max = Number(svc.maxPx) || Number(svc.max_px) || 4096;
  if (Math.max(w, h) > max) {
    const k = max / Math.max(w, h);
    w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k));
  }
  const params = new URLSearchParams({
    bbox: bbox.join(','), bboxSR: '3857', imageSR: '3857', size: `${w},${h}`, f: 'image',
  });
  if (svc.type === 'ImageServer') {
    params.set('format', 'png');
    params.set('interpolation', 'RSP_BilinearInterpolation');
    return `${svc.url}/exportImage?${params}`;
  }
  params.set('format', 'png32');
  params.set('transparent', 'true');
  return `${svc.url}/export?${params}`;
}

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
  const py = imageHeightPixels(frame);
  const params = new URLSearchParams({
    bbox: frameBbox3857(frame).join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${px},${py}`,
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
      `${frame.lng},${frame.lat},${frame.zoom},0/${frame.size}x${frameHeight(frame)}@2x` +
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
    note: 'Often a different year again, and the imagery most people recognise. View only: '
      + 'detection and the saved photo use Mapbox, so line it up before tracing on it.',
    /*
     * VIEW ONLY (owner, 2026-10-01). Its terms keep us from storing its
     * pictures, so a map drawn on Google already banks a Mapbox photo -- and
     * its pictures are often warped in ways no shift lines up (workflow 8,
     * "compare on our lawns"). 13 of 101 maps had been drawn on it. Looking
     * stays; detection and training are Mapbox's.
     */
    detect: false,
    prompt: 'grass',
    promptVar: 'SAM_PROMPT',
    keyVar: 'GOOGLE_MAPS_KEY',
    // Google floors fractional zoom, so meet it at an integer one -- and it
    // serves one fixed 640x640 picture, so the frame says so rather than
    // claiming a rectangle the picture does not have.
    frame: (frame) => ({ ...frame, zoom: Math.floor(frame.zoom), size: 640, height: 640 }),
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

  /*
   * THE COUNTY'S OWN PHOTO, where there is one (owner, 2026-10-01: "make the
   * county maps available for any location that has them, and have them be
   * the default ... County map layers will not be view only").
   *
   * Not one service but whichever one covers the lot: county_services, built
   * ahead of time by tools/county-imagery.js, and looked up by the Worker
   * (worker/src/county.js) into frame.svc before anything asks for a URL. No
   * svc, no picture -- never somebody else's county, and never an address
   * typed into a query string (the Worker only fetches services it lists).
   *
   * DETECTS. The trained model has only been trained on Mapbox, so how it
   * does on these photos is what the training comparison measures (H62, H63).
   */
  county: {
    label: 'County photo',
    note: "The county's or state's own aerial photography: usually the sharpest there is, often flown in early spring with the leaves off.",
    detect: true,
    perLot: true,
    prompt: 'grass',
    promptVar: 'SAM_PROMPT',
    url: (frame) => (frame?.svc ? countyExportUrl(frame.svc, frame) : null),
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
    /*
     * THE CACHE STOPS AT z19, AND SAYS SO WITH A 200.
     *
     * Measured, not guessed -- workflow 8 asks for a tile at every zoom and
     * prints what came back:
     *
     *   z16  19,200 bytes    z20  2,521 bytes
     *   z17  17,252 bytes    z21  2,521 bytes
     *   z18  14,279 bytes    z22  2,521 bytes
     *   z19  10,264 bytes    z23  2,521 bytes
     *
     * Past z19 it does not 404. It returns a "map data not yet available"
     * tile: HTTP 200, valid JPEG, the same 2,521 bytes every time. So nothing
     * errors, nothing can be caught, and the map simply shows that instead of
     * the ground.
     *
     * THIS IS THE WHOLE BUG BEHIND "Esri hasn't been providing any imagery".
     * A lot fits the frame at about z19.4 and correcting corners goes deeper
     * still, so every zoom anybody WORKS at is past the end of the cache and
     * every zoom that would have looked fine is one nobody stays at.
     *
     * Declared here so Mapbox overzooms the z19 tile rather than requesting a
     * z21 that does not exist. Softer, and it is the photograph.
     */
    maxzoom: 19,
    note: 'Often a different year again — worth a look. Esri only serves fixed tiles, so detection falls back to Mapbox. Its photography stops at zoom 19, so it softens as you go in further.',
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

/** The width and height a fixed-size source serves, from its own frame rule:
    a frame that differs from it in both says which sides the rule sets. */
const fixedSizeOf = (p) => {
  const f = p.frame({ lng: 0, lat: 0, zoom: 19.5, size: 1, height: 1 });
  return f.size !== 1 ? { size: f.size, height: f.height ?? f.size } : null;
};

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
      /*
       * How deep the tiles really go. Sent rather than assumed, because the
       * browser cannot find out: past the end of an Esri cache the answer is
       * a 200 carrying a placeholder, which no client-side check can tell
       * from photography. Without this the map requests zooms that do not
       * exist and shows "not available" instead of the ground.
       */
      maxzoom: Number.isFinite(p.maxzoom) ? p.maxzoom : null,
      // The frame this source will actually be served at, so the browser can
      // place a preview on the same ground the detector will measure.
      integerZoom: Boolean(p.frame),
      /* Offered only where a lot has one (the county photo): the editor asks
         /api/county-imagery and shows it only when the answer is yes. */
      perLot: Boolean(p.perLot),
      /*
       * And its size: Google serves one 640 x 640 picture whatever the frame's
       * shape. Frames became rectangles cropped to the lot (731ea38) and only
       * this side learned it, so the browser laid a 640-wide picture on a frame
       * a third that wide -- Google looked squeezed about twice over (owner,
       * 2026-10-01, a lot 170 ft wide showing 350 ft). Read off the frame rule
       * itself so the two cannot drift apart again.
       */
      fixedSize: p.frame ? fixedSizeOf(p) : null,
    }));

/** Is this source usable at all in this deployment? */
export const providerAvailable = (provider, env) => {
  const p = PROVIDERS[normaliseProvider(provider)];
  return !p.keyVar || Boolean(env?.[p.keyVar]);
};
