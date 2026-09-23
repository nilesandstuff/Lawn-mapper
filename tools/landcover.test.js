/**
 * The land cover lawn source, checked without touching the network.
 *
 * WHAT THESE ARE FOR. This method is free and it is a URL: there is no
 * prediction to inspect, no version to pin, and nothing that fails loudly. If
 * the remap range slips by one, or the bbox goes out in the wrong projection,
 * what arrives is a perfectly valid PNG of the wrong thing, and the app traces
 * it and reports a confident number. So the URL is the thing to test.
 *
 *   node tools/landcover.test.js
 */

import {
  lawnMaskUrl, maskPixels, classAt, covers, LAWN_CLASSES, LANDCOVER_HOST,
  LANDCOVER_SERVICE, overlayCatalogue,
} from '../worker/src/landcover.js';
import { frameBbox3857, imagePixels } from '../worker/src/imagery.js';
import { metresPerPixel } from '../public/lib/mercator.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

/* A frame over a Midlothian, Virginia suburb -- the one the classes were
   first read on by hand, so a failure here is comparable to something real. */
const frame = { lng: -77.5850, lat: 37.4370, zoom: 19, size: 640 };
const url = new URL(lawnMaskUrl(frame));
const params = url.searchParams;

/* ------------------------------------------------------- the two classes */
{
  /*
   * THE OFF-BY-ONE THIS FILE MOSTLY EXISTS FOR.
   *
   * ArcGIS Remap takes InputRanges as [min, max) pairs, so the range for
   * classes 27 and 28 is [27, 29] and NOT [27, 28]. Get it wrong the tight way
   * and canopy-over-turf silently stops counting; get it wrong the loose way
   * and 29 -- Pervious Developed, Other -- starts being measured as lawn.
   * Neither shows up as an error anywhere.
   */
  const rule = JSON.parse(params.get('renderingRule'));
  const ranges = rule.rasterFunctionArguments.InputRanges;

  check('the remap asks for exactly the two lawn classes',
    ranges.length === 2 && ranges[0] === 27 && ranges[1] === 29,
    `InputRanges: ${JSON.stringify(ranges)} (half-open, so 29 means "up to but not 29")`);

  check('and those are the classes the module names',
    LAWN_CLASSES.turf === 28 && LAWN_CLASSES.canopyOverTurf === 27,
    JSON.stringify(LAWN_CLASSES));

  check('unmatched pixels are dropped rather than painted',
    rule.rasterFunctionArguments.AllowUnmatched === false,
    'anything else and every non-lawn class becomes lawn-coloured');

  check('lawn comes back white',
    JSON.stringify(rule.rasterFunctionArguments.OutputValues) === '[255]',
    'the tracer thresholds at 128, so a lower value would trace as background');
}

/* ------------------------------------------------------------- the frame */
{
  /*
   * A mask is unprojected against the frame the browser was given, so a mask
   * that covers a different patch of ground than it claims is not a visible
   * fault -- it is a lawn-shaped outline sitting over somebody else's garden.
   * Both SRs pinned to 3857 means no reprojection happens in between.
   */
  check('the bbox is the frame, in the projection the tracer assumes',
    params.get('bbox') === frameBbox3857(frame).join(',')
    && params.get('bboxSR') === '3857' && params.get('imageSR') === '3857',
    `${params.get('bbox')} @ ${params.get('bboxSR')} -> ${params.get('imageSR')}`);

  /*
   * SIZED TO THE DATA, NOT TO THE PHOTOGRAPH -- the fault this whole module
   * shipped with. Asking for the aerial's 1280 px gave 17 px blocks of a 1 m
   * raster, every step of which the tracer's 8 px corner window read as a real
   * corner; the outline then disagreed with its own mask by 17% of its area.
   * See maskPixels for the measurements.
   */
  const px = maskPixels(frame);
  check('it is sized to the data rather than to the photograph',
    params.get('size') === `${px},${px}` && px < imagePixels(frame),
    `${params.get('size')} against the photograph's ${imagePixels(frame)}`);

  const widthM = metresPerPixel(frame, imagePixels(frame)) * imagePixels(frame);
  const perMetre = px / widthM;
  check('at about four pixels per ground metre',
    perMetre > 3.5 && perMetre < 4.5,
    `${perMetre.toFixed(2)} px/m over ${widthM.toFixed(0)} m of ground`);

  /*
   * A frame can be small enough that four pixels a metre is a postage stamp,
   * and large enough that it would exceed the photograph. Both ends are
   * clamped, and a mask bigger than the aerial would be asking the service to
   * invent the detail this change exists to stop asking for.
   */
  for (const f of [
    { lng: -77.585, lat: 37.437, zoom: 21, size: 256 },
    { lng: -77.585, lat: 37.437, zoom: 14, size: 640 },
  ]) {
    const n = maskPixels(f);
    check(`a z${f.zoom} frame stays within the clamps`,
      n >= 64 && n <= imagePixels(f), `${n} px, photograph is ${imagePixels(f)}`);
  }

  check('it asks for an image, as a PNG',
    params.get('f') === 'image' && params.get('format') === 'png',
    'JPEG here would invent colours along every class boundary');
}

/* ------------------------------------------------------------- the host */
{
  check('the service is the makers’ own, not the state mirror',
    new URL(LANDCOVER_SERVICE).hostname === LANDCOVER_HOST,
    `${new URL(LANDCOVER_SERVICE).hostname} vs ${LANDCOVER_HOST}`);

  /*
   * /api/mask will only proxy hosts on its list, and the mask URL built here
   * has to be one of them or every detection fails at the last step with
   * "Could not load the mask image".
   */
  check('and the mask URL is on that host',
    url.hostname === LANDCOVER_HOST, url.hostname);

  check('over https, which the proxy also requires', url.protocol === 'https:');
}

/* --------------------------------------------------------- the env override */
{
  const moved = new URL(lawnMaskUrl(frame, { LANDCOVER_SERVICE: 'https://elsewhere.test/svc/ImageServer/' }));
  check('the service can be moved without a deploy',
    moved.hostname === 'elsewhere.test' && moved.pathname === '/svc/ImageServer/exportImage',
    `${moved.origin}${moved.pathname} (trailing slash trimmed, so no // in the path)`);
}

/* ------------------------------------------------------------- overlays */
/*
 * The layer-picker overlays. They exist to be compared against the mask and
 * the drawn shapes, so the thing that must hold is that the "lawn only" one
 * shows EXACTLY what the mask measures -- a comparison layer that disagreed
 * with the thing it is compared against would send somebody hunting a bug in
 * the tracer that was really in the picture.
 */
{
  const list = overlayCatalogue({});
  check('both overlays are offered', list.length === 2, list.map((o) => o.id).join(', '));

  for (const o of list) {
    check(`${o.id}: carries a tile template`,
      typeof o.tiles === 'string' && o.tiles.includes('/exportImage?'), String(o.tiles).slice(0, 60));
    /*
     * Mapbox substitutes this placeholder itself, so it has to survive
     * URLSearchParams -- which percent-encodes braces and would leave the
     * literal text in every request.
     */
    check(`${o.id}: the bbox placeholder is left for Mapbox to fill`,
      o.tiles.includes('bbox={bbox-epsg-3857}'),
      o.tiles.includes('%7Bbbox') ? 'the braces got percent-encoded' : 'ok');
    check(`${o.id}: is on the allowed host`,
      new URL(o.tiles.replace('{bbox-epsg-3857}', '0,0,1,1')).hostname === LANDCOVER_HOST);
    check(`${o.id}: says what it is`, Boolean(o.label && o.note));
  }

  const lawnOverlay = list.find((o) => o.id === 'lulc-lawn');
  const overlayRule = new URL(lawnOverlay.tiles.replace('{bbox-epsg-3857}', '0,0,1,1'))
    .searchParams.get('renderingRule');
  check('the lawn overlay draws exactly what the mask measures',
    JSON.parse(overlayRule).rasterFunctionArguments.InputRanges.join(',')
      === JSON.parse(params.get('renderingRule')).rasterFunctionArguments.InputRanges.join(','),
    overlayRule);

  const allOverlay = list.find((o) => o.id === 'lulc-all');
  check('and the all-classes overlay remaps nothing',
    !new URL(allOverlay.tiles.replace('{bbox-epsg-3857}', '0,0,1,1')).searchParams.get('renderingRule'),
    'it is there to show the classes the other two are derived from');
}

/* ------------------------------------------------------------- coverage */
{
  /*
   * COVERAGE IS A QUESTION, AND ITS ANSWER DECIDES WHETHER SOMEBODY IS
   * CHARGED. A wrong "yes" hands back an empty mask that reads as "no grass
   * here"; a wrong "no" spends a detection the visitor did not need. Both
   * failure paths below have to end in a plain null rather than a throw,
   * because a throw inside /api/segment is a 500 on a press that had a perfectly
   * good fallback available.
   */
  const realFetch = globalThis.fetch;
  const answer = (body) => {
    globalThis.fetch = async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    answer({ value: '28' });
    check('a class number means there is data here', (await classAt(-77.585, 37.437)) === 28);
    check('and that counts as covered', (await covers(-77.585, 37.437)) === true);

    /*
     * "NoData" is the literal string this service returns outside its
     * footprint. It is not an error and it is not a number.
     */
    answer({ value: 'NoData' });
    check('"NoData" is not a class', (await classAt(-82.19, 36.60)) === null);
    check('and that counts as not covered', (await covers(-82.19, 36.60)) === false);

    answer({ error: { code: 500, message: 'boom' } });
    check('an error from the service reads as no data, not as a throw',
      (await classAt(-77.585, 37.437)) === null);

    globalThis.fetch = async () => { throw new Error('network down'); };
    check('and neither does a dead network',
      (await classAt(-77.585, 37.437)) === null,
      'a throw here would 500 a press that could have fallen back to the AI');

    globalThis.fetch = async () => new Response('nope', { status: 503 });
    check('nor a 503', (await classAt(-77.585, 37.437)) === null);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
