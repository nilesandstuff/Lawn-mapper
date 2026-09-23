/**
 * The trace importer, checked without posting anything.
 *
 * WHAT THESE ARE FOR. This tool writes training data, and every way it can go
 * wrong is silent. A State Plane easting is a perfectly valid number; a
 * property traced as three pieces is three perfectly valid polygons. Neither
 * throws, and both produce corpus rows somebody would have to review before
 * noticing they were nonsense.
 *
 *   node tools/import-traces.test.js
 */

import { planImport } from './import-traces.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

/* About 35 m square in Midlothian, Virginia -- roughly a quarter acre. */
const square = (lng, lat, d = 0.00035) => ({
  type: 'Polygon',
  coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]],
});
const feature = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });
const fc = (features) => ({ type: 'FeatureCollection', features });

/* ------------------------------------------------------------ grouping */
{
  /*
   * THE ONE THAT MATTERS MOST. A front lawn, a back lawn and the strip by the
   * garage are ONE property. Imported ungrouped they become three maps of a
   * third of a lawn each, every one of them framed on its own piece -- which
   * trains the model on photographs of fences and is invisible in any count.
   */
  const three = fc([
    feature(square(-77.5850, 37.4370), { lawn_id: 'A' }),
    feature(square(-77.5855, 37.4372), { lawn_id: 'A' }),
    feature(square(-77.5847, 37.4368), { lawn_id: 'A' }),
    feature(square(-77.5900, 37.4400), { lawn_id: 'B' }),
  ]);
  const p = planImport(three, { source: 't' });
  check('pieces sharing an id become one lawn', p.maps.length === 2,
    `${p.maps.length} lawns from 4 features`);
  check('and that lawn keeps all its pieces',
    p.maps.find((m) => m.key === 'lawn_id=A')?.shapes.length === 3,
    JSON.stringify(p.maps.map((m) => [m.key, m.shapes.length])));

  /*
   * The frame has to cover the WHOLE property, not the piece that happened to
   * be first. A frame built from one piece puts the rest of the lawn outside
   * the photograph the corpus stores.
   */
  const a = p.maps.find((m) => m.key === 'lawn_id=A');
  check('the frame is centred on all the pieces together',
    Math.abs(a.frame.lng - -77.5851) < 0.0004 && Math.abs(a.frame.lat - 37.4370) < 0.0004,
    `${a.frame.lat.toFixed(5)}, ${a.frame.lng.toFixed(5)}`);
  check('at a zoom that fits them', a.frame.zoom >= 14 && a.frame.zoom <= 20, String(a.frame.zoom));
  check('and the app’s own frame size, so imports are comparable to traces',
    a.frame.size === 640, String(a.frame.size));
}

{
  const p = planImport(fc([feature(square(-77.585, 37.437)), feature(square(-77.59, 37.44))]), { source: 't' });
  check('with no grouping attribute each polygon is its own lawn',
    p.maps.length === 2 && p.grouped === 0, `${p.maps.length} lawns, ${p.grouped} grouped`);
}

/* ------------------------------------------------------- the CRS trap */
{
  /*
   * A State Plane easting is a valid number and an invalid longitude. Accepted,
   * it lands the lawn in the Gulf of Guinea and fetches a photograph of the
   * sea -- which somebody then has to review. The check is on the VALUES,
   * because the declared CRS is the part that lies.
   */
  const statePlane = {
    type: 'Polygon',
    coordinates: [[[11458321, 3712004], [11458421, 3712004], [11458421, 3712104], [11458321, 3712104], [11458321, 3712004]]],
  };
  const p = planImport(fc([feature(statePlane)]), { source: 't' });
  check('projected coordinates are refused, not imported',
    p.maps.length === 0 && p.rejected.length === 1);
  check('and the refusal says what to do about it',
    /EPSG:4326/.test(p.rejected[0].why), p.rejected[0].why);

  /*
   * Lat and lon the wrong way round passes every range check: a Virginia lawn
   * transposed is 37.4E, 77.6S, and both are real numbers on a real globe. It
   * is caught only by there being no turf in Antarctica.
   */
  const swapped = planImport(fc([feature(square(37.437, -77.585))]), { source: 't' });
  check('transposed lat/lon is refused',
    swapped.maps.length === 0, JSON.stringify(swapped.rejected));
  check('and the refusal names the likely cause',
    /wrong way round/.test(swapped.rejected[0]?.why || ''), swapped.rejected[0]?.why);

  /* The band has to be wide enough for anywhere real. */
  const anchorage = planImport(fc([feature(square(-149.9, 61.2))]), { source: 't' });
  check('but a genuinely high-latitude lawn is a known limit, not a silent drop',
    anchorage.maps.length === 0 && /wrong way round/.test(anchorage.rejected[0].why),
    'Anchorage is past the band; refused loudly rather than imported wrong');
}

/* --------------------------------------------------------- the inferred flag */
{
  const p = planImport(fc([feature(square(-77.585, 37.437))]), { source: 't' });
  check('inferred defaults to false',
    p.maps[0].shapes[0].properties.inferred === false,
    'a claim, not a fact -- which is why every import goes to the review queue');

  /* A shapefile has no booleans, so every one of these means yes. */
  for (const raw of [1, '1', 'true', 'TRUE', 'Y', 'yes']) {
    const marked = planImport(fc([feature(square(-77.585, 37.437), { inferred: raw })]), { source: 't' });
    check(`inferred: ${JSON.stringify(raw)} is read as yes`,
      marked.maps[0].shapes[0].properties.inferred === true);
  }
  for (const raw of [0, '0', 'false', 'N', 'no', '']) {
    const marked = planImport(fc([feature(square(-77.585, 37.437), { inferred: raw })]), { source: 't' });
    check(`inferred: ${JSON.stringify(raw)} is read as no`,
      marked.maps[0].shapes[0].properties.inferred === false);
  }
}

/* -------------------------------------------------------------- the source */
{
  const p = planImport(fc([feature(square(-77.585, 37.437))]), { source: 'jane-q3' });
  check('the batch is named on the row',
    p.maps[0].mode === 'import:jane-q3' && p.maps[0].model === 'import',
    `${p.maps[0].model} / ${p.maps[0].mode}`);
  /*
   * `mode` is part of the corpus id, so this is also what makes a re-import
   * update its own rows instead of doubling them -- and what makes a bad batch
   * findable later. An import that cannot be told from our own tracing cannot
   * be pulled back out.
   */
  const other = planImport(fc([feature(square(-77.585, 37.437))]), { source: 'other' });
  check('and two batches of the same lawn are distinguishable',
    p.maps[0].mode !== other.maps[0].mode);
}

/* ------------------------------------------------------------- sanity bounds */
{
  const tiny = planImport(fc([feature(square(-77.585, 37.437, 0.000004))]), { source: 't' });
  check('a doormat is refused', tiny.maps.length === 0, JSON.stringify(tiny.rejected));

  const huge = planImport(fc([feature(square(-77.585, 37.437, 0.02))]), { source: 't' });
  check('and so is a lawn the size of a farm', huge.maps.length === 0, JSON.stringify(huge.rejected));

  /* H1's largest real corpus lot is 158,000 sq ft, so the ceiling has to sit
     well above it or the importer refuses the lots we most need. */
  const big = planImport(fc([feature(square(-77.585, 37.437, 0.0006))]), { source: 't' });
  check('a genuinely large lot still gets through',
    big.maps.length === 1, `${big.maps[0]?.sqFt.toLocaleString()} sq ft`);
}

/* ------------------------------------------------------------- odd geometry */
{
  const multi = {
    type: 'MultiPolygon',
    coordinates: [square(-77.585, 37.437).coordinates, square(-77.5858, 37.4374).coordinates],
  };
  const p = planImport(fc([feature(multi, { lawn_id: 'M' })]), { source: 't' });
  check('a multipolygon is split into its pieces',
    p.maps.length === 1 && p.maps[0].shapes.length === 2,
    `${p.maps.length} lawn, ${p.maps[0]?.shapes.length} pieces`);
  check('and every piece is a plain Polygon',
    p.maps[0].shapes.every((s) => s.geometry.type === 'Polygon'));

  const lines = planImport(fc([feature({ type: 'LineString', coordinates: [[-77.5, 37.4], [-77.6, 37.5]] })]), { source: 't' });
  check('a line is refused rather than measured',
    lines.maps.length === 0 && /not an area/.test(lines.rejected[0].why), lines.rejected[0]?.why);

  const empty = planImport(fc([{ type: 'Feature', properties: {} }]), { source: 't' });
  check('a feature with no geometry is refused', empty.maps.length === 0);

  check('an empty file is not an error', planImport(fc([]), { source: 't' }).maps.length === 0);
  check('and neither is nonsense', planImport(null, { source: 't' }).maps.length === 0);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
