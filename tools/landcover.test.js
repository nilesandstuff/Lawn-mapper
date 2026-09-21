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
  lawnMaskUrl, classAt, covers, LAWN_CLASSES, LANDCOVER_HOST, LANDCOVER_SERVICE,
} from '../worker/src/landcover.js';
import { frameBbox3857, imagePixels } from '../worker/src/imagery.js';

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

  const px = imagePixels(frame);
  check('and it is asked for at the same pixel size as the photograph',
    params.get('size') === `${px},${px}`,
    `${params.get('size')} (a different size traces the same lawn at another detail)`);

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
