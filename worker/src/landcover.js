/**
 * Lawn from a published land cover map, instead of from an AI.
 *
 * WHAT THIS IS. The Chesapeake Bay Program's one-metre land use raster,
 * produced by the Chesapeake Conservancy with the University of Vermont
 * Spatial Analysis Laboratory and USGS. 54 classes over the Bay watershed and
 * the counties beside it. Two of them are what this app measures:
 *
 *     28   Turf Grass
 *     27   Tree Canopy over Turf Grass
 *
 * So where it has data there is no need to ask a model what the grass is --
 * somebody has already said, at a metre, for every parcel at once.
 *
 * WHAT IT IS NOT. It is not ground truth and it does not see under trees.
 * From the Bay Program's own classification methods: class 27 is "tree cover
 * within 30 ft of structures ... in rural wooded areas, and within 60 ft of
 * structures ... in developed areas", and "the understory in all TCTG areas is
 * ASSUMED to be turf grass". It is a distance rule with an assumption on the
 * end of it. See E7 in docs/DETECTOR-FINDINGS.md for what follows from that --
 * chiefly that it is generous on an ordinary suburban lot and stops sixty feet
 * from the house on an acre.
 *
 * AND IT IS A METRE, against the 10-15 cm this app's own imagery gives (H1),
 * on a boundary problem where resolution has already been shown to matter
 * (H9). Expect the outline to be blockier than SAM's. Whether blockier and
 * roughly right beats smooth and wrong is exactly the thing to measure, and
 * nothing here has measured it.
 *
 * WHY IT IS FREE. No Replicate call, no prediction, no allowance. One image
 * request to a public ArcGIS service, which is why the Worker branches to it
 * before the allowance is touched rather than after.
 */

import { frameBbox3857, imagePixels } from './imagery.js';
import { metresPerPixel } from '../../public/lib/mercator.js';

/**
 * The makers' own service, not the state's copy of it.
 *
 * Virginia republishes the same raster through VGIN as a cached map service:
 * JPEG tiles, no identify, no query. That copy cannot be used for this -- the
 * colour IS the class and JPEG invents colours along every class boundary,
 * which is precisely the edge being measured. This one answers `identify` with
 * the raw class number and will remap server-side. Same data, one of the two
 * is usable.
 */
export const LANDCOVER_SERVICE =
  'https://cicgis.org/arcgis/rest/services/LULC/bay_lu_tif/ImageServer';

/** The host /api/mask is allowed to proxy for this source. */
export const LANDCOVER_HOST = 'cicgis.org';

/**
 * Turf grass, and canopy the makers assume has turf under it.
 *
 * As a half-open range because that is what ArcGIS's Remap takes: InputRanges
 * are [min, max) pairs, so 27-29 is 27 and 28 and nothing else. Written as the
 * two class numbers and derived, rather than as the literal [27, 29], because
 * "29" appearing in a lawn definition is a class this does not want (29 is
 * Pervious Developed, Other) and the next person should not have to work that
 * out.
 */
export const LAWN_CLASSES = { turf: 28, canopyOverTurf: 27 };

const REMAP_RANGE = [
  Math.min(...Object.values(LAWN_CLASSES)),
  Math.max(...Object.values(LAWN_CLASSES)) + 1,
];

const service = (env) => String(env?.LANDCOVER_SERVICE || LANDCOVER_SERVICE).replace(/\/+$/, '');

/**
 * One request that returns the lawn mask already cut out.
 *
 * The remap happens on their server, so what comes back is the same shape of
 * thing SAM returns -- white where lawn, nothing where not -- and the browser
 * traces it with the code it already has. No palette to reconstruct and no
 * class numbers crossing the wire as pixels.
 *
 * bboxSR and imageSR are both 3857 for the reason arcgisImage gives: no
 * reprojection between what is asked for and what arrives, so the mask lands
 * exactly on the frame the browser will unproject it against.
 */
/**
 * HOW MANY PIXELS TO ASK FOR, and why it is not the photograph's answer.
 *
 * THE FAULT THIS FIXES. The first version asked for the mask at the same size
 * as the aerial -- 1280 px for a 640 frame, about 6 cm a pixel. The data is one
 * metre, so every class cell arrived as a 17 px block with hard stair-steps,
 * and the tracer's corner detector looks at an 8 px window. An 8 px window
 * inside a 17 px step sees a perfect 90 degree corner, so EVERY STEP became an
 * anchored corner -- hundreds of them, all artefacts of asking for seventeen
 * times more pixels than the data has. Corners are the last thing simplifyRing
 * gives up, so the vertex budget was spent entirely on staircase and the runs
 * between them were cut as straight chords across the real edge.
 *
 * Measured against the mask the outline was traced from, same lot, same code:
 *
 *     1280 px   IoU 83.0%    41 vertices on the biggest ring
 *      640 px   IoU 84.0%    48
 *      320 px   IoU 89.4%    76
 *      160 px   IoU 90.9%    65
 *
 * 17% of the answer disagreeing with its own mask is what "the shapes are
 * diverging from the mask" looked like from the screen.
 *
 * FOUR PIXELS PER GROUND METRE. Enough oversampling that a cell boundary lands
 * where it should, coarse enough that the corner window spans two cells rather
 * than sitting inside one. Asking for more than this is not more detail -- the
 * data has none to give -- it is more staircase.
 *
 * Never more than the photograph's own size, so this can only ever ask for
 * fewer pixels than before, and floored at 64 so a tiny frame still has
 * something to trace.
 */
const PX_PER_GROUND_M = 4;

export function maskPixels(frame) {
  const full = imagePixels(frame);
  const widthM = metresPerPixel(frame, full) * full;
  return Math.max(64, Math.min(full, Math.round(widthM * PX_PER_GROUND_M)));
}

export function lawnMaskUrl(frame, env) {
  const px = maskPixels(frame);
  /* The same pixels per metre down the frame as across it, so a rectangular
     frame gets a rectangular mask rather than a squashed one. */
  const py = Math.max(64, Math.round((px * (frame.height || frame.size)) / frame.size));
  const params = new URLSearchParams({
    bbox: frameBbox3857(frame).join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${px},${py}`,
    format: 'png',
    f: 'image',
    renderingRule: JSON.stringify({
      rasterFunction: 'Remap',
      rasterFunctionArguments: {
        InputRanges: REMAP_RANGE,
        OutputValues: [255],
        /*
         * Everything else becomes NoData rather than 0, which the PNG carries
         * as transparent -- and binarize() already treats a transparent pixel
         * as background. Mapping to 0 instead would work too; NoData is chosen
         * because it also makes an out-of-coverage request obviously empty
         * rather than obviously black.
         */
        AllowUnmatched: false,
      },
    }),
  });
  return `${service(env)}/exportImage?${params}`;
}

/**
 * The class number at one point, or null if this raster does not reach there.
 *
 * Used as the coverage test, and it is a real test rather than a bounding box:
 * the raster is the Bay watershed plus adjacent counties, which is not a
 * rectangle in any projection and has holes in states it otherwise covers.
 * Roanoke has data and Bristol, in the same state, does not. Asking is one
 * cheap request and is never wrong; a box would be both.
 */
export async function classAt(lng, lat, env, timeoutMs = 8000) {
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    returnCatalogItems: 'false',
  });
  let data;
  try {
    const res = await fetch(`${service(env)}/identify?${params}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  if (!data || data.error) return null;
  const n = Number(data.value);
  /*
   * "NoData" is the string this service returns outside its footprint, and
   * Number("NoData") is NaN -- so this one check covers both the outside and
   * anything else unparseable. Do not "simplify" it to a truthiness test: 0 is
   * a legitimate pixel value in general, even if this raster's classes start
   * at 11.
   */
  return Number.isFinite(n) ? n : null;
}

/**
 * Is there land cover data at this address?
 *
 * Deliberately not "is there lawn here" -- a house roof is covered by the
 * raster and is not lawn, and a detection whose centre lands on the roof is
 * the ordinary case, not a miss.
 */
export const covers = async (lng, lat, env) => (await classAt(lng, lat, env)) !== null;

/**
 * The same raster as something to LOOK at, for the layer picker.
 *
 * WHY THIS EXISTS. The first real test of the land cover method produced
 * outlines that did not match the mask they came from, and there was no way to
 * see which of the three things was wrong -- the raster, the mask cut out of
 * it, or the polygons traced from the mask. Three suspects and one visible
 * symptom is not a debuggable position. These put the first two on the map
 * underneath the third.
 *
 * `{bbox-epsg-3857}` is Mapbox GL's own placeholder for a raster source's tile
 * extent, and exportImage takes a bbox, so a plain ArcGIS image service is a
 * tile source with no tiling server in front of it.
 *
 * These are for DISPLAY ONLY and deliberately do not go through /api/mask:
 * nothing reads their pixels off a canvas, so there is no tainting to avoid
 * and no reason to put the Worker in the path of a picture.
 */
export const OVERLAYS = [
  {
    id: 'lulc-all',
    label: 'Land cover, all classes',
    note: 'Every one of the 54 classes in their published colours. Turf grass is pale green; tree canopy over turf is a darker green.',
  },
  {
    id: 'lulc-lawn',
    label: 'Land cover, lawn only',
    note: 'Just the two classes the free method measures — turf grass and tree canopy over turf grass. This is the mask, before anything traces it.',
    /* The same remap the mask uses, so what is drawn here and what is
       measured cannot drift apart. */
    lawnOnly: true,
  },
];

/** A Mapbox raster-source tile template for one of the overlays above. */
export function overlayTiles(id, env) {
  const overlay = OVERLAYS.find((o) => o.id === id);
  if (!overlay) return null;
  const params = new URLSearchParams({
    bboxSR: '3857',
    imageSR: '3857',
    size: '256,256',
    format: 'png32',
    transparent: 'true',
    f: 'image',
  });
  if (overlay.lawnOnly) {
    params.set('renderingRule', JSON.stringify({
      rasterFunction: 'Remap',
      rasterFunctionArguments: {
        InputRanges: REMAP_RANGE, OutputValues: [255], AllowUnmatched: false,
      },
    }));
  }
  /*
   * The placeholder is substituted by Mapbox, so it must survive
   * URLSearchParams -- which would percent-encode the braces. Appended after
   * the encoding rather than passed through it.
   */
  return `${service(env)}/exportImage?bbox={bbox-epsg-3857}&${params}`;
}

/** What the browser needs to offer these, without a second copy of the list. */
export const overlayCatalogue = (env) => OVERLAYS.map((o) => ({
  id: o.id,
  label: o.label,
  note: o.note,
  tiles: overlayTiles(o.id, env),
}));
