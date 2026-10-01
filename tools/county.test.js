/**
 * County photos: the verdict the API stores (worker/src/county.js) and the
 * compare page's filters and projection (public/county.js).
 *   node tools/county.test.js
 */
import { cleanCountyReview, cleanCountyOutlines, MAX_NUDGE_M, countyServiceAt, countyServiceById } from '../worker/src/county.js';
import { providerCatalogue, imageryUrl, detectionProvider, countyExportUrl, frameBbox3857 } from '../worker/src/imagery.js';
import { FILTERS, shown, stepIn, doubtful, pathFor, polygonsOf, editHref } from '../public/county.js';
import { lngLatToFramePx } from '../public/lib/mercator.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

check('a verdict of ok with a nudge is kept, to the centimetre',
  JSON.stringify(cleanCountyReview({ review: 'ok', east: 0.123, north: -0.5 })) === JSON.stringify({ review: 'ok', east: 0.12, north: -0.5 }));
check('off and null are verdicts too',
  cleanCountyReview({ review: 'off' })?.review === 'off' && cleanCountyReview({ review: null })?.review === null);
check('anything else is refused', cleanCountyReview({ review: 'maybe' }) === null && cleanCountyReview({ review: 'ok', east: 'x' }) === null);
check(`a nudge is held at ${MAX_NUDGE_M} m`, cleanCountyReview({ review: 'ok', east: 50, north: -50 }).east === MAX_NUDGE_M);

const list = [
  { id: 'a', review: null, fit: 0.6, residual_m: 0.05, east: 1, north: 0 },
  { id: 'b', review: 'ok', fit: 0.6, residual_m: 0.05, east: 1, north: 0 },
  { id: 'c', review: null, fit: 0.2, residual_m: 0.05, east: 1, north: 0 },
  { id: 'd', review: 'off', fit: 0.6, residual_m: 0.6, east: 1, north: 0 },
];
check('to check: the unjudged', JSON.stringify(shown(list, 'todo')) === '[0,2]');
check('doubtful: unjudged with a weak fit', JSON.stringify(shown(list, 'doubtful')) === '[2]' && doubtful(list[3]));
check('lines up / do not use', JSON.stringify(shown(list, 'ok')) === '[1]' && JSON.stringify(shown(list, 'off')) === '[3]');
check('stepping wraps within the filter', stepIn(list, 'todo', 2, 1) === 0 && stepIn(list, 'todo', 0, -1) === 2);
check('every filter is a function', Object.values(FILTERS).every((f) => typeof f === 'function'));

/* The outline is projected exactly as training rasterises it: lngLatToFramePx
   against the map's frame and the photo's own pixels. */
const frame = { lng: -85.86, lat: 42.87, zoom: 19.5, size: 640, height: 640 };
const ring = [[-85.8601, 42.8701], [-85.8599, 42.8701], [-85.8599, 42.8699], [-85.8601, 42.8701]];
const d = pathFor([ring], frame, 1280, 1280);
const [x0, y0] = lngLatToFramePx(frame, ring[0], 1280, 1280);
check('outlines use the training projection', d.startsWith(`M${x0.toFixed(1)},${y0.toFixed(1)}`), d.slice(0, 30));
check('multipolygons draw every part', polygonsOf({ type: 'MultiPolygon', coordinates: [[ring], [ring]] }).length === 2);

/* Measured by lib/register.js: doubtful unless it was sure AND the banked file
   measures within 10 cm of Mapbox. */
check('measured and landed is not doubtful', !doubtful({ reg_confident: 1, residual_m: 0.03 }));
check('not sure is doubtful, whatever else', doubtful({ reg_confident: 0, residual_m: 0.01, fit: 0.9 }));
check('sure but the banked file is off, or not measurable, is doubtful',
  doubtful({ reg_confident: 1, residual_m: 0.4 }) && doubtful({ reg_confident: 1, residual_m: null }));
check('Edit outlines opens the editor on the county photo and comes back',
  editHref('a b:c') === '/#review=a%20b%3Ac&photo=county&back=county');

/* Outlines saved from the editor on a county photo. */
const sq = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const kept = cleanCountyOutlines({ shapes: [{ geometry: sq, properties: { inferred: true, junk: 1 } }], notLawn: [sq] });
check('outlines are cleaned as a finished map\'s are, inferred flag and all',
  kept && JSON.parse(kept.shapes)[0].properties.inferred === true && !('junk' in JSON.parse(kept.shapes)[0].properties)
  && JSON.parse(kept.notLawn).length === 1, JSON.stringify(kept));
check('not-lawn alone is a set of outlines', cleanCountyOutlines({ shapes: [], notLawn: [sq] })?.shapes === '[]');
check('nothing at all is refused', cleanCountyOutlines({ shapes: [], notLawn: [] }) === null && cleanCountyOutlines({}) === null);

/* The county photo as a source, for any address (owner, 2026-10-01). */
{
  const cat = providerCatalogue({}).find((p) => p.id === 'county');
  check('the county photo is in the list, detects, and is offered per lot only',
    cat && cat.detect === true && cat.perLot === true, JSON.stringify(cat));
  check('and it detects as itself, not Mapbox', detectionProvider('county') === 'county');
  const f = { lng: -85.86, lat: 42.87, zoom: 19.5, size: 640, height: 400 };
  check('no service, no picture: never a guess', imageryUrl('county', f) === null);
  const img = new URL(imageryUrl('county', { ...f, svc: { url: 'https://gis.example/arcgis/rest/services/Ortho2024/ImageServer', type: 'ImageServer', maxPx: 4096 } }));
  check('an image service is asked for exactly the frame at the frame\'s pixels',
    img.pathname.endsWith('/ImageServer/exportImage') && img.searchParams.get('size') === '1280,800'
    && img.searchParams.get('bbox') === frameBbox3857(f).join(',') && img.searchParams.get('bboxSR') === '3857',
    img.search.slice(0, 120));
  const small = new URL(countyExportUrl({ url: 'https://gis.example/x/MapServer', type: 'MapServer', maxPx: 1000 }, f));
  check('a map service that draws less is asked for its most, same shape',
    small.pathname.endsWith('/MapServer/export') && small.searchParams.get('size') === '1000,625'
    && small.searchParams.get('format') === 'png32', small.search.slice(0, 120));
  /* The lookup, against a stand-in database. */
  const rows = [{ id: 7, url: 'https://a/ImageServer', type: 'ImageServer', title: 'Ortho 2024', year: 2024, native_cm: 7.5, max_px: 4000 }];
  const seen = [];
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => { seen.push([sql, a]); return { first: async () => rows[0] }; } }) } };
  const at = await countyServiceAt(env, -85.86, 42.87);
  check('the lookup asks for a service that draws a box and covers the point, newest then finest',
    at?.id === 7 && at.maxPx === 4000 && /export_ok = 1/.test(seen[0][0]) && /west <= \?1 AND east >= \?1/.test(seen[0][0])
    && /ORDER BY COALESCE\(year, 0\) DESC, COALESCE\(native_cm, 99\) ASC/.test(seen[0][0]), JSON.stringify(at));
  check('by id: only a whole number, never a URL', await countyServiceById(env, 'https://evil') === null
    && (await countyServiceById(env, '7'))?.url === 'https://a/ImageServer');
  check('no database, no answer', await countyServiceAt({}, 1, 2) === null);
}

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
