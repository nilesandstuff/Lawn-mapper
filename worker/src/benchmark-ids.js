/**
 * SHORT NAMES FOR THE 32 BENCHMARK LAWNS, B01 to B32.
 *
 * Short names for the 32 frozen benchmark lawns (cohort benchmark-1rijjz2), fixed 2026-09-26 at the owner's request so results can be discussed as 'B07' rather than 'Kent County 8,626 sq ft'. Grouped by state and county, smallest traced lawn first within a county. NEVER renumber: the findings file quotes these. A lawn that is not here gets no tag.
 *
 * A JavaScript module rather than a JSON file so the Worker (the admin
 * pictures endpoint adds each lot's coordinates by its tag) and the Node tools
 * (train-detector.js) import the same object; the Python readers get the tags
 * through the frames' scale.json.
 *
 * The keys are corpus map ids, which begin with the address point as
 * "longitude,latitude". They are served only to the signed-in owner.
 */
export const BENCHMARK_IDS = {
  '-96.87726,46.80986:sam3:find': 'B01',
  '-96.31024,30.59139:sam3:find': 'B02',
  '-112.83597,37.70577:sam3:find': 'B03',
  '-122.59407,48.03813:sam3:find': 'B04',
  '-85.74709,42.87412:sam3:find': 'B05',
  '-85.61014,43.03520:sam3_exclude:exclude': 'B06',
  '-85.64651,42.81639:sam3:find': 'B07',
  '-85.72400,42.87286:sam3:find': 'B08',
  '-85.58216,43.08465:sam3:find': 'B09',
  '-85.58069,43.05429:sam3:find': 'B10',
  '-85.57742,43.09564:sam3_exclude:exclude': 'B11',
  '-85.64033,43.07105:sam3:find': 'B12',
  '-85.67425,42.80681:sam3:find': 'B13',
  '-85.95191,42.78183:sam3:find': 'B14',
  '-85.81809,43.02488:sam3:find': 'B15',
  '-85.82204,42.98126:sam3:find': 'B16',
  '-83.45285,42.40950:sam3:find': 'B17',
  '-81.62058,41.11245:sam3:find': 'B18',
  '-85.67808,38.04124:sam3:find': 'B19',
  '-85.67913,38.04131:sam3:find': 'B20',
  '-85.67816,38.04042:sam3:find': 'B21',
  '-77.60251,38.77674:sam3:find': 'B22',
  '-77.61167,38.77826:sam3:find': 'B23',
  '-77.60953,38.77517:sam3:find': 'B24',
  '-77.23724,39.19168:sam3:find': 'B25',
  '-77.26011,39.21623:sam3_exclude:exclude': 'B26',
  '-78.54605,33.87955:sam3:find': 'B27',
  '-80.65242,35.00238:sam3:find': 'B28',
  '-77.21901,34.66301:sam3:find': 'B29',
  '-77.48222,34.73669:sam3:find': 'B30',
  '-77.48013,34.73608:sam3:find': 'B31',
  '-80.55371,34.99379:sam3:find': 'B32',
};

/** The tag for a map id, or null. */
export const benchmarkTag = (id) => BENCHMARK_IDS[id] || null;

/*
 * EVERY OTHER MAP IS A C NUMBER (owner, 2026-10-04: "keep the B numbered ones
 * as is, then switch to C numbers for the rest"). C01, C02 ... from
 * corpus.lot_no, which the benchmark's 32 do not have. The console, the map
 * list and a training run's results all name a map with this.
 */
export const C_PREFIX = 'C';
export function mapName(id, lotNo = null) {
  const b = benchmarkTag(id);
  if (b) return b;
  const n = Number(lotNo);
  return n > 0 ? `${C_PREFIX}${String(n).padStart(2, '0')}` : null;
}

/** The map id for a tag, or null. */
export const benchmarkId = (tag) => Object.keys(BENCHMARK_IDS).find((k) => BENCHMARK_IDS[k] === tag) || null;

/**
 * The address point a corpus map id starts with, as { lat, lng }, or null.
 * Ids are "lng,lat:model:mode"; longitude first, which is the order nobody
 * pastes into a map search box -- hence this.
 */
export function coordsOfId(id) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?::|$)/.exec(String(id || ''));
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
