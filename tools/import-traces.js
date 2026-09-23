/**
 * Lawn outlines traced in somebody else's GIS, brought in as corpus maps.
 *
 * WHY THIS EXISTS. S3 says the corpus is the binding constraint and that
 * "anything that makes hand-tracing faster is worth as much as a backbone".
 * Somebody who traces polygons for a living, on imagery better than we serve,
 * is the fastest tracing available -- and their output is already the shape
 * this app stores. A GeoJSON FeatureCollection of lawn polygons IS a stack of
 * corpus maps; all that is missing is a frame per lawn and a row to write.
 *
 *   node tools/import-traces.js path/to/traces.geojson
 *
 * Environment:
 *   SITE          where to post (default https://lawnmap.nilesandstuff.com)
 *   GROUP_BY      attribute that says which lawn a polygon belongs to
 *   SOURCE        a name for this batch, e.g. "jane-q3" (required)
 *   DRY_RUN       "true" to check the file and post nothing
 *   LIMIT         stop after this many lawns
 *
 * NOTHING HERE IS APPROVED. Every row lands at status 'new', which is the
 * review queue, and carries inferred: false on every ring unless the file says
 * otherwise. Both of those are claims rather than facts -- see the note on
 * `inferred` below -- and the review pass is what turns them into an answer.
 * A hundred unreviewed imports are a hundred unverified claims, not a hundred
 * training examples.
 */

import { readFileSync } from 'node:fs';
import { zoomToFit, geometryBounds } from '../public/lib/mercator.js';
import { measure } from '../public/lib/area.js';

const SITE = (process.env.SITE || 'https://lawnmap.nilesandstuff.com').replace(/\/+$/, '');
const SOURCE = (process.env.SOURCE || '').trim();
const GROUP_BY = (process.env.GROUP_BY || '').trim();
const DRY_RUN = String(process.env.DRY_RUN || '') === 'true';
const LIMIT = Number(process.env.LIMIT) > 0 ? Number(process.env.LIMIT) : Infinity;

/* The app's own frame size, so an imported map is framed exactly as a traced
   one would have been and the two are comparable in training. */
const FRAME_SIZE = 640;

/*
 * WHICH LAWN A POLYGON BELONGS TO.
 *
 * A property is often several pieces -- front, back, the strip by the garage
 * -- and they must arrive as ONE map with several shapes, not as three maps of
 * a third of a lawn each. Without a grouping field this file cannot tell those
 * apart from three separate houses, so it looks for the attribute names a GIS
 * person would plausibly have used, and falls back to one-lawn-per-feature
 * while SAYING SO, because that fallback is wrong for exactly the layer most
 * worth importing.
 */
const GROUP_FIELDS = ['lawn_id', 'lawnid', 'property_id', 'parcel_id', 'parcelid', 'pin', 'address', 'site_addr', 'id'];

/*
 * COORDINATES THAT ARE NOT DEGREES.
 *
 * GeoJSON's specification mandates WGS84 lon/lat, so a correct export is
 * already right -- but QGIS will happily write the layer's own CRS into a
 * .geojson and label it nothing at all, and State Plane eastings look like
 * 11,458,321. That number is not a longitude and never will be, and the only
 * thing worse than refusing it is accepting it: the polygon lands in the Gulf
 * of Guinea, the frame is computed around it, and the imagery fetch returns
 * ocean that somebody then has to review.
 *
 * So the check is on the VALUES rather than on any declared CRS, because the
 * declaration is the part that lies.
 */
const looksLikeDegrees = ([x, y]) =>
  Number.isFinite(x) && Number.isFinite(y)
  && Math.abs(x) <= 180 && Math.abs(y) <= 90;

/*
 * TRANSPOSED PAIRS, WHICH THE CHECK ABOVE CANNOT SEE.
 *
 * The other commonest GIS import fault is lat and lon the wrong way round, and
 * it slips through the range check completely: a Virginia lawn transposed is
 * 37.4E, 77.6S, and both of those are real numbers on a real globe. It lands
 * in Antarctica at a plausible size and imports without complaint.
 *
 * There is no general way to catch it -- (40, 40) is a genuine place. What
 * CAN be said is that nobody is measuring a lawn past sixty degrees: there is
 * no turf in Antarctica and very little north of Anchorage, and a transposed
 * US coordinate always lands outside that band because US longitudes are
 * larger than any US latitude. Narrow, honest, and it catches the whole
 * continental case.
 */
const PLAUSIBLE_LAT = 60;

/** Every coordinate pair in a polygon or multipolygon. */
function* pairs(geometry) {
  const rings = geometry?.type === 'MultiPolygon'
    ? geometry.coordinates.flat()
    : geometry?.type === 'Polygon' ? geometry.coordinates : [];
  for (const ring of rings) for (const p of ring || []) yield p;
}

/**
 * One GIS feature -> the shape this app stores, or null with a reason.
 *
 * MultiPolygon is split rather than kept: the corpus stores a list of
 * polygons, and "one feature per lawn piece" is what every downstream measure
 * and edit already assumes.
 */
function shapesFrom(feature, problems) {
  const g = feature?.geometry;
  if (!g) { problems.push('no geometry'); return []; }
  if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') {
    problems.push(`${g.type} is not an area`);
    return [];
  }
  for (const p of pairs(g)) {
    if (!looksLikeDegrees(p)) {
      problems.push(`coordinates are not degrees (${p[0]}, ${p[1]}) -- reproject to EPSG:4326`);
      return [];
    }
    if (Math.abs(p[1]) > PLAUSIBLE_LAT) {
      problems.push(`latitude ${p[1]} is past ${PLAUSIBLE_LAT} degrees `
        + '-- lat and lon are probably the wrong way round');
      return [];
    }
  }

  /*
   * INFERRED IS A CLAIM, AND FALSE IS NOT THE NEUTRAL VALUE.
   *
   * Writing `inferred: false` asserts "a person could see this ground". On a
   * treed lot that is a statement about the hardest part of the measurement,
   * made by this importer rather than by anybody who looked. It is the right
   * default only because every imported row goes to the review queue, where
   * somebody marks what was really guessed at.
   *
   * An `inferred` attribute in the file wins, and is read loosely because a
   * shapefile has no booleans: 1, "1", "true", "Y" and "yes" all mean yes.
   */
  const raw = feature.properties?.inferred ?? feature.properties?.INFERRED;
  const inferred = /^(1|true|y|yes)$/i.test(String(raw ?? '').trim());

  const rings = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  return rings.map((coordinates) => ({
    type: 'Feature',
    properties: { inferred },
    geometry: { type: 'Polygon', coordinates },
  }));
}

/** The grouping key for a feature, and the field it came from. */
function groupOf(feature, i) {
  const props = feature?.properties || {};
  const fields = GROUP_BY ? [GROUP_BY] : GROUP_FIELDS;
  for (const f of fields) {
    const v = props[f] ?? props[f.toUpperCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return { key: `${f}=${String(v).trim()}`, field: f };
    }
  }
  return { key: `#${i}`, field: null };
}

export function planImport(collection, { source = SOURCE } = {}) {
  const features = Array.isArray(collection?.features) ? collection.features
    : Array.isArray(collection) ? collection : [];
  const groups = new Map();
  const rejected = [];
  let grouped = 0;

  features.forEach((f, i) => {
    const problems = [];
    const shapes = shapesFrom(f, problems);
    if (!shapes.length) { rejected.push({ at: i, why: problems[0] || 'unusable' }); return; }
    const { key, field } = groupOf(f, i);
    if (field) grouped++;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...shapes);
  });

  const maps = [];
  for (const [key, shapes] of groups) {
    /*
     * The frame is built from ALL of a lawn's pieces together, exactly as the
     * app builds it from the whole parcel. Framing each piece separately would
     * zoom the tool in on the strip beside the garage and train on a
     * photograph of a fence.
     */
    const boxes = shapes.map((s) => geometryBounds(s.geometry)).filter(Boolean);
    if (!boxes.length) { rejected.push({ at: key, why: 'no bounds' }); continue; }
    const bbox = boxes.reduce((a, b) => [
      Math.min(a[0], b[0]), Math.min(a[1], b[1]),
      Math.max(a[2], b[2]), Math.max(a[3], b[3]),
    ]);

    const sqFt = shapes.reduce((n, s) => n + measure(s.geometry).squareFeet, 0);
    /*
     * A lawn the size of a football pitch or of a doormat is a grouping
     * mistake or a units mistake, and either way it is cheaper to refuse it
     * here than to review it later. The bounds are deliberately wide: the
     * corpus already holds a 158,000 sq ft lot (H1).
     */
    if (!(sqFt > 100) || sqFt > 500000) {
      rejected.push({ at: key, why: `${Math.round(sqFt).toLocaleString()} sq ft is not a lawn` });
      continue;
    }

    maps.push({
      key,
      sqFt: Math.round(sqFt),
      shapes,
      frame: {
        lng: (bbox[0] + bbox[2]) / 2,
        lat: (bbox[1] + bbox[3]) / 2,
        zoom: zoomToFit(bbox, FRAME_SIZE),
        size: FRAME_SIZE,
      },
      /*
       * WHERE IT CAME FROM, on the row itself.
       *
       * `mode` is part of the corpus id, so a batch imported twice updates its
       * own rows rather than doubling them -- and, more importantly, an import
       * can always be told apart from our own tracing. If a batch turns out to
       * be systematically off, that is the difference between pulling it back
       * out and never being able to find it again.
       */
      model: 'import',
      mode: `import:${source}`,
    });
  }

  return { maps, rejected, grouped, features: features.length };
}

/* ------------------------------------------------------------------ run */

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node tools/import-traces.js <file.geojson>');
    process.exit(2);
  }
  if (!SOURCE) {
    console.error('SOURCE is required -- a name for this batch, so its rows can be found again.');
    process.exit(2);
  }

  const collection = JSON.parse(readFileSync(path, 'utf8'));

  /*
   * A declared CRS is reported and not obeyed. GeoJSON's `crs` member was
   * removed from the specification in RFC 7946 and survives in exports from
   * older tooling, where it is as likely to be wrong as right. The coordinate
   * values are checked instead; this line exists so a mismatch is visible in
   * the log rather than mysterious.
   */
  const declared = collection?.crs?.properties?.name;
  if (declared) console.log(`The file declares ${declared}. Coordinates are checked on their values, not on this.`);

  const { maps, rejected, grouped, features } = planImport(collection);

  console.log(`${features} features -> ${maps.length} lawns`);
  console.log(grouped
    ? `${grouped} of them carried a grouping attribute.`
    : 'NO GROUPING ATTRIBUTE FOUND, so every polygon was treated as its own lawn.\n'
      + '  If a property was traced as several pieces, they have just been imported as\n'
      + `  several separate lawns. Set GROUP_BY, or add one of: ${GROUP_FIELDS.join(', ')}`);

  if (rejected.length) {
    console.log(`\n${rejected.length} refused:`);
    for (const r of rejected.slice(0, 20)) console.log(`  ${r.at}: ${r.why}`);
    if (rejected.length > 20) console.log(`  ... and ${rejected.length - 20} more`);
  }

  const chosen = maps.slice(0, LIMIT);
  if (DRY_RUN) {
    console.log(`\nDRY RUN -- nothing posted. The first few would be:`);
    for (const m of chosen.slice(0, 5)) {
      console.log(`  ${m.key}  ${m.sqFt.toLocaleString()} sq ft  `
        + `${m.shapes.length} piece(s)  at ${m.frame.lat.toFixed(5)},${m.frame.lng.toFixed(5)} z${m.frame.zoom}`);
    }
    process.exit(0);
  }

  console.log(`\nPosting ${chosen.length} to ${SITE}/api/finished`);
  let ok = 0;
  const failed = [];
  for (const m of chosen) {
    const body = {
      frame: m.frame, lng: m.frame.lng, lat: m.frame.lat,
      shapes: m.shapes, model: m.model, mode: m.mode,
      /* Nobody has looked at this outline on OUR imagery, which is the only
         imagery the corpus stores. Said explicitly rather than left to the
         absence of marks. See recordFinished. */
      handEdited: false,
    };
    try {
      const res = await fetch(`${SITE}/api/finished`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const out = await res.json().catch(() => ({}));
      if (out.ok) ok++;
      else failed.push(`${m.key}: ${out.reason || res.status}`);
    } catch (e) {
      failed.push(`${m.key}: ${e.name}`);
    }
    /* Gentle: this is our own Worker, but each row fetches a photograph from
       somebody else's imagery server behind it. */
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n${ok} imported, ${failed.length} failed.`);
  for (const f of failed.slice(0, 20)) console.log(`  ${f}`);

  console.log('\nEvery one of these is at status "new" -- the review queue -- and every');
  console.log('ring says inferred: false, which is a CLAIM that the ground was visible.');
  console.log('They are not corpus until somebody has been through them.');
  process.exit(failed.length && !ok ? 1 : 0);
}
