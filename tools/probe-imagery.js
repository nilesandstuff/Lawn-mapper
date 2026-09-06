/**
 * What the free imagery sources actually give us, and whether they line up.
 *
 * Adding a second satellite source is not just a URL swap. Every measurement
 * this app makes comes from the FRAME -- a centre, a zoom and a pixel size --
 * and the pixel-to-lng/lat maths assumes the picture covers exactly the
 * rectangle that frame describes. Mapbox's static endpoint is defined that way.
 * Esri and USGS are not: they take a bounding box and a pixel size, and are
 * free to return something slightly different -- snapped to their own tile
 * grid, or letterboxed to preserve an aspect ratio.
 *
 * If the returned extent is not the requested extent, every lawn traced from
 * that image is measured against the wrong ground, and the number will look
 * entirely plausible. So this asks each service, in f=json mode, what extent it
 * actually returned, and compares it to what was asked for.
 *
 * It also lists the raster functions the NAIP service publishes, which is how
 * to find out whether NDVI is available rather than assuming a name.
 *
 * Free: these are public services and this fetches metadata plus a couple of
 * small images.
 *
 *   node tools/probe-imagery.js
 */

import { frameCorners, metresPerPixel } from '../public/lib/mercator.js';

/* A real frame, the size the app really uses. */
const FRAME = { lng: -85.8637, lat: 42.8703, zoom: 19.66, size: 640 };
const IMG = 1280;

/** lng/lat -> EPSG:3857 metres. The frame is axis-aligned in this projection. */
const R = 20037508.342789244;
const toMercator = ([lng, lat]) => [
  (lng * R) / 180,
  (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * (R / 180),
];

const corners = frameCorners(FRAME);          // NW, NE, SE, SW
const [west, north] = toMercator(corners[0]);
const [east, south] = toMercator(corners[2]);
const bbox = [west, south, east, north];

console.log('The frame every measurement is made against:');
console.log(`  centre ${FRAME.lng}, ${FRAME.lat}  zoom ${FRAME.zoom}  ${IMG}px`);
console.log(`  ${(metresPerPixel(FRAME, IMG) * 100).toFixed(2)} cm per pixel`);
console.log(`  bbox 3857: ${bbox.map((n) => n.toFixed(2)).join(', ')}`);
console.log(`  ${(east - west).toFixed(1)} m across, ${(north - south).toFixed(1)} m down\n`);

const SERVICES = {
  'Esri World Imagery': {
    root: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    op: 'export',
  },
  'USGS NAIP Plus': {
    root: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer',
    op: 'exportImage',
  },
  'USGS NAIP (imagery only)': {
    root: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer',
    op: 'exportImage',
  },
};

const get = async (url) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20000);
  try {
    const res = await fetch(url, { signal: c.signal });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return { error: `HTTP ${res.status}` };
    if (type.includes('json')) return { json: await res.json() };
    const buf = await res.arrayBuffer();
    return { bytes: buf.byteLength, type };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(t);
  }
};

for (const [name, svc] of Object.entries(SERVICES)) {
  console.log(`--- ${name}`);

  /* 1. Does it exist, and what is it? */
  const meta = await get(`${svc.root}?f=json`);
  if (meta.error || meta.json?.error) {
    console.log(`    UNREACHABLE: ${meta.error || meta.json.error.message}\n`);
    continue;
  }
  const m = meta.json;
  console.log(`    ok: ${(m.serviceDescription || m.description || m.name || '').slice(0, 90).replace(/\s+/g, ' ')}`);
  if (m.pixelSizeX) console.log(`    native resolution: ${m.pixelSizeX} m`);

  /*
   * 2. The raster functions it publishes.
   *
   * This is the question behind "feed it NDVI instead": NDVI needs the
   * near-infrared band, which plain aerial photography does not carry. If the
   * service offers an NDVI function it can compute one server-side; if it does
   * not, the idea needs a different source, not a different parameter.
   */
  const fns = (m.rasterFunctionInfos || []).map((f) => f.name);
  if (fns.length) {
    console.log(`    raster functions (${fns.length}): ${fns.join(', ').slice(0, 300)}`);
    const ndvi = fns.filter((f) => /ndvi|vegetation|nir|infrared/i.test(f));
    console.log(`    vegetation-related: ${ndvi.length ? ndvi.join(', ') : 'NONE'}`);
  } else if (svc.op === 'exportImage') {
    console.log('    raster functions: none published');
  }

  /*
   * 3. The check that matters: ask for our exact frame and see what comes back.
   *
   * f=json makes the service report the extent it served rather than just
   * handing over pixels, which is the only way to catch a snap or a letterbox.
   */
  const params = new URLSearchParams({
    bbox: bbox.join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${IMG},${IMG}`,
    format: 'png',
    f: 'json',
  });
  const shot = await get(`${svc.root}/${svc.op}?${params}`);
  if (shot.error || shot.json?.error) {
    console.log(`    export failed: ${shot.error || JSON.stringify(shot.json.error).slice(0, 160)}\n`);
    continue;
  }

  const ext = shot.json.extent;
  if (!ext) {
    console.log(`    export returned no extent: ${JSON.stringify(shot.json).slice(0, 200)}\n`);
    continue;
  }

  const off = {
    west: ext.xmin - bbox[0],
    south: ext.ymin - bbox[1],
    east: ext.xmax - bbox[2],
    north: ext.ymax - bbox[3],
  };
  const worst = Math.max(...Object.values(off).map(Math.abs));
  const mpp = metresPerPixel(FRAME, IMG);

  /*
   * Both halves, or the verdict is worthless. Esri answered with a correct
   * extent and an image 0 pixels wide, and an extent-only check called that
   * ALIGNED -- a picture containing nothing covers any rectangle you like.
   */
  const sized = shot.json.width === IMG && shot.json.height === IMG;
  const placed = worst / mpp < 0.5;

  console.log(`    served ${shot.json.width}x${shot.json.height} px (asked for ${IMG}x${IMG})`);
  console.log(`    extent off by ${worst.toFixed(3)} m = ${(worst / mpp).toFixed(2)} px`);
  console.log(
    sized && placed
      ? '    USABLE: right size, right place'
      : !sized
        ? '    UNUSABLE: the service did not render at this size'
        : '    MISALIGNED: every lawn traced from this would be measured against the wrong ground'
  );

  const png = await get(`${svc.root}/${svc.op}?${params.toString().replace('f=json', 'f=image')}`);
  console.log(png.bytes
    ? `    image: ${(png.bytes / 1024).toFixed(0)} KB ${png.type}\n`
    : `    image failed: ${png.error || 'unknown'}\n`);
}

/*
 * If a service would not render, ask whether it is the scale rather than the
 * service. Our frame is about 3.5 cm per pixel, which is far finer than any of
 * these hold natively -- NAIP is 30 cm -- and an ArcGIS service is entitled to
 * refuse beyond its maximum scale rather than invent detail.
 */
console.log('--- retry at coarser scales, to separate "cannot" from "will not"');
for (const [name, svc] of Object.entries(SERVICES)) {
  for (const px of [512, 256]) {
    const p = new URLSearchParams({
      bbox: bbox.join(','), bboxSR: '3857', imageSR: '3857',
      size: `${px},${px}`, format: 'png', f: 'json',
    });
    const r = await get(`${svc.root}/${svc.op}?${p}`);
    const w = r.json?.width ?? 0;
    console.log(`    ${name} @ ${px}px -> ${w ? `${w}x${r.json.height}` : (r.error || JSON.stringify(r.json?.error || r.json).slice(0, 90))}`);
    if (w) break;
  }
}

/*
 * Esri, specifically.
 *
 * `export` handed back a 0x0 image at every size, with the extent we asked for
 * and no error -- which is what a *cached* map service does when it is not
 * allowed to draw arbitrary extents on demand. That is a statement about the
 * operation, not the imagery: the same pixels are served happily as pre-baked
 * tiles. Since a tile is a fixed Web Mercator square and our frame is defined
 * in exactly those coordinates, tiles are usable for the map view -- what they
 * cannot do is hand back one image of our exact frame, which is what the
 * detector needs. This section establishes which half is true.
 */
console.log('\n--- Esri: what it will serve, given export will not');
const esri = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const emeta = (await get(`${esri}?f=json`)).json || {};
console.log(`    cached (singleFusedMapCache): ${emeta.singleFusedMapCache}`);
console.log(`    exportTilesAllowed: ${emeta.exportTilesAllowed}`);
console.log(`    capabilities: ${emeta.capabilities}`);
const lods = emeta.tileInfo?.lods || [];
if (lods.length) {
  const top = lods[lods.length - 1];
  console.log(`    tile levels: 0..${top.level}  finest ${top.resolution.toFixed(4)} m/px`);
}

/* The XYZ tile for our centre, at the zoom the app uses. */
const z = 19;
const n = 2 ** z;
const tx = Math.floor(((FRAME.lng + 180) / 360) * n);
const latRad = (FRAME.lat * Math.PI) / 180;
const ty = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
for (const host of ['services', 'server']) {
  const t = await get(`https://${host}.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`);
  console.log(`    tile z${z}/${ty}/${tx} via ${host}. -> ${t.bytes ? `${(t.bytes / 1024).toFixed(0)} KB ${t.type}` : t.error}`);
}

/*
 * How old is what we are looking at?
 *
 * "Find the clearest or newest image" is the whole point of offering a choice,
 * and a source is only worth switching to if you can see its date. Both of
 * these publish the acquisition date of the individual photo under a point --
 * Esri through a metadata layer, NAIP through its own image catalogue.
 */
console.log('\n--- how old is the imagery under our test point?');
const pointQ = new URLSearchParams({
  geometry: `${FRAME.lng},${FRAME.lat}`,
  geometryType: 'esriGeometryPoint',
  inSR: '4326',
  spatialRel: 'esriSpatialRelIntersects',
  outFields: '*',
  returnGeometry: 'false',
  f: 'json',
});
const esriMeta = await get(
  `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Imagery_Metadata/MapServer/8/query?${pointQ}`
);
const ef = esriMeta.json?.features?.[0]?.attributes;
console.log(ef
  ? `    Esri: ${ef.SRC_DATE2 || ef.SRC_DATE || '?'} from ${ef.NICE_NAME || ef.SRC_DESC || '?'} at ${ef.SRC_RES ?? '?'} m`
  : `    Esri metadata: ${esriMeta.error || JSON.stringify(esriMeta.json).slice(0, 120)}`);

for (const [name, svc] of Object.entries(SERVICES)) {
  if (svc.op !== 'exportImage') continue;
  const q = await get(`${svc.root}/query?${pointQ}`);
  const feats = q.json?.features || [];
  if (!feats.length) {
    console.log(`    ${name}: no catalogue answer (${q.error || JSON.stringify(q.json).slice(0, 90)})`);
    continue;
  }
  const dates = feats
    .map((f) => f.attributes)
    .map((a) => a.SRC_DATE || a.AcquisitionDate || a.acquisitionDate || a.Year || a.SRC_DATE2)
    .filter(Boolean);
  console.log(`    ${name}: ${feats.length} photo(s), dates ${[...new Set(dates)].join(', ') || 'not published'}`);
}

console.log('\nAn extent within half a pixel is fine -- the frame is what the app');
console.log('measures against, and each source only has to fill that rectangle.');
console.log('A service that will not render at our scale is not a bug in it: NAIP is');
console.log('30 cm native and our frame asks for about 3.5 cm.');
