/**
 * The arithmetic of tools/compare-imagery.js, without a network.
 *   node tools/compare-imagery.test.js
 */
import {
  siblingRoots, newestFirst, catalogueRoot, pickImagery, yearHints, nativeCm, isBlank, greenShare, greyGrid, summarise,
} from './compare-imagery.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

check('the catalogue root of a county parcel layer',
  catalogueRoot('https://gis.example.gov/arcgis/rest/services/Parcels/MapServer') === 'https://gis.example.gov/arcgis/rest/services');
check('and of an ArcGIS Online one',
  catalogueRoot('https://services2.arcgis.com/abc/ArcGIS/rest/services/P/FeatureServer') === 'https://services2.arcgis.com/abc/ArcGIS/rest/services');
check('no root from something that is not a service', catalogueRoot('https://example.com/x') === null);
check('sibling web adaptors on the same host are asked too (Ottawa keeps aerials under /image/)',
  siblingRoots('https://gis.miottawa.org/arcgis/rest/services').includes('https://gis.miottawa.org/image/rest/services'));
check('but ArcGIS Online is one root', siblingRoots('https://services2.arcgis.com/abc/ArcGIS/rest/services').length === 1);
const ranked = newestFirst([
  { name: 'ImageService/Aerial1962' }, { name: 'ImageService/Aerial2021' }, { name: 'ImageService/Aerial2024_Cached' },
  { name: 'ImageService/Aerial2024' }, { name: 'Orthos_Current' },
]).map((x) => x.name);
check('the newest flight comes first, its cached twin next, then undated, then older',
  JSON.stringify(ranked) === JSON.stringify(['ImageService/Aerial2024', 'ImageService/Aerial2024_Cached', 'Orthos_Current', 'ImageService/Aerial2021', 'ImageService/Aerial1962']),
  ranked.join(', '));

const picked = pickImagery([
  { name: 'Imagery/Ortho_2023', type: 'ImageServer' },
  { name: 'Aerials2021', type: 'MapServer' },
  { name: 'Ortho_Index', type: 'MapServer' },
  { name: 'Parcels', type: 'MapServer' },
  { name: 'Ortho2022', type: 'FeatureServer' },
  { name: 'Lidar_Hillshade', type: 'ImageServer' },
]).map((s) => s.name);
check('imagery services are picked, indexes and parcels are not',
  JSON.stringify(picked) === JSON.stringify(['Imagery/Ortho_2023', 'Aerials2021']), picked.join(', '));

check('years are found in names and text', JSON.stringify(yearHints('Ortho_2023 flown spring 2022, 6in')) === '[2022,2023]');
check('and nonsense numbers are not years', yearHints('Layer 12345 at 3857').length === 0);

check('native resolution of a Web Mercator image service',
  Math.abs(nativeCm({ pixelSizeX: 0.3, spatialReference: { wkid: 102100 } }, 60) - 15) < 1e-9);
check('of a feet-based map service, from its units',
  Math.abs(nativeCm({ units: 'esriFeet', spatialReference: { wkid: 2283 }, tileInfo: { lods: [{ resolution: 2 }, { resolution: 0.5 }] } }, 38) - 15.24) < 1e-9);
check('a tile cache counts only the levels it draws, not its whole scheme',
  Math.abs(nativeCm({ units: 'esriMeters', maxScale: 9027.98, spatialReference: { wkid: 3857 },
    tileInfo: { lods: [{ scale: 18055.95, resolution: 4.77 }, { scale: 9027.98, resolution: 2.39 }, { scale: 4513.99, resolution: 1.19 }] } }, 0) - 239) < 1e-6);
check('and unknown rather than guessed when the units cannot be told',
  nativeCm({ pixelSizeX: 0.5, spatialReference: { wkid: 2283 } }, 38) === null);

const W = 20, H = 20;
const fill = (fn) => { const d = new Uint8Array(W * H * 4); for (let i = 0; i < W * H; i++) { const [r, g, b, a] = fn(i); d.set([r, g, b, a], i * 4); } return d; };
check('a flat colour is blank', isBlank(fill(() => [200, 200, 200, 255]), W, H));
check('a transparent picture is blank', isBlank(fill((i) => [i % 255, i % 200, 0, 0]), W, H));
check('a varied picture is not', !isBlank(fill((i) => [(i * 37) % 255, (i * 53) % 255, (i * 11) % 255, 255]), W, H));
check('green share counts green pixels', Math.abs(greenShare(fill((i) => (i % 2 ? [40, 160, 40, 255] : [120, 120, 120, 255])), W, H) - 0.5) < 0.05);

const g = greyGrid(fill(() => [100, 100, 100, 255]), W, H, 5, 5);
check('the grey grid averages to the right size and value', g.length === 25 && Math.abs(g[12] - 100) < 1e-3);

const s = summarise([
  { sources: [{ key: 'mapbox' }, { key: 'county', label: 'county', covered: true, detailVsMapbox: 1.5, offsetM: 1, nativeCm: 8, greenVsMapbox: 0.5, years: [2023] }] },
  { sources: [{ key: 'mapbox' }, { key: 'county', label: 'county', covered: false }] },
]);
check('the summary counts coverage and keeps medians',
  s.length === 1 && s[0].tried === 2 && s[0].covered === 1 && s[0].detailVsMapbox === 1.5 && s[0].sharperThanMapbox === 1
    && JSON.stringify(s[0].years) === '[2023]', JSON.stringify(s[0]));

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
