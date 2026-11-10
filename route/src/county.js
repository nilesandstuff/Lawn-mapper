/**
 * The county's own parcel records, asked for an address Mapbox cannot place
 * (route session, 2026-11-10). The county is the authority on its addresses:
 * a work order's address came from it. Found on a real one: a court Mapbox
 * knew only under another street type, and the Census placed 300 m off along
 * the street; the county's parcel for it sat where the house is.
 *
 * The parcel services and their address fields are the ones Lawn Mapper
 * reads for property lines (worker/src/counties.js), copied here so the route
 * planner depends on nothing of the main site's. A match is placed at the
 * middle of its parcel.
 */

const STREET_TYPES = {
  ct: 'CT', court: 'CT', ave: 'AVE', av: 'AVE', avenue: 'AVE', dr: 'DR', drive: 'DR', st: 'ST', street: 'ST',
  rd: 'RD', road: 'RD', ln: 'LN', lane: 'LN', cir: 'CIR', circle: 'CIR', blvd: 'BLVD', boulevard: 'BLVD',
  pl: 'PL', place: 'PL', way: 'WAY', trl: 'TRL', trail: 'TRL', pkwy: 'PKWY', parkway: 'PKWY', ter: 'TER',
  terrace: 'TER', hwy: 'HWY', highway: 'HWY', cv: 'CV', cove: 'CV', pt: 'PT', pointe: 'PTE',
};
const DIRS = /^(N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)$/i;

/** "9 Elm Ct SE" -> { num: '9', name: 'ELM', type: 'CT' }; the street part only (before any comma). */
export function parseStreet(text) {
  const words = String(text || '').split(',')[0].replace(/[.#]/g, ' ').trim().split(/\s+/);
  const num = /^\d{1,6}$/.test(words[0] || '') ? words.shift() : null;
  if (words.length > 1 && DIRS.test(words[0])) words.shift();
  while (words.length > 1 && DIRS.test(words[words.length - 1])) words.pop();
  let type = null;
  if (words.length > 1 && STREET_TYPES[words[words.length - 1].toLowerCase()]) type = STREET_TYPES[words.pop().toLowerCase()];
  const name = words.join(' ').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  // the first word of the name: what the county is searched by ("Cr" for Ct and the like do not spoil it)
  return { num, name, type, key: name.split(' ')[0] || '' };
}

/** The street type a label names ("... Alaska Avenue Southeast, ..." -> 'AVE'), or null. */
export const typeOf = (label) => parseStreet(label).type;

const tidy = (s) => String(s || '').trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
  .replace(/\b(Ne|Nw|Se|Sw|Mi)\b/g, (m) => m.toUpperCase());

export const COUNTIES = [
  {
    name: 'Kent', box: [-85.80, 42.76, -85.31, 43.29],
    url: 'https://gis.kentcountymi.gov/agisprod/rest/services/ParcelsWithCondos/FeatureServer/0/query',
    where: (a) => `PROPERTYADDRESS LIKE '${a.num} %${a.key}%'`,
    fields: 'PROPERTYADDRESS,PROPADDRESSCITY,PROPADDRESSSTATE_ZIPCODE',
    read: (x) => ({ street: x.PROPERTYADDRESS, city: x.PROPADDRESSCITY, zip: String(x.PROPADDRESSSTATE_ZIPCODE || '').replace(/^MI/, '').trim() }),
  },
  {
    name: 'Ottawa', box: [-86.30, 42.76, -85.78, 43.28],
    url: 'https://gis.miottawa.org/arcgis/rest/services/Hosted/AR_ParcelSearch_gdb/FeatureServer/6/query',
    where: (a) => `propertyaddress LIKE '${a.num} %${a.key}%'`,
    fields: 'propertyaddress,propertycity',
    read: (x) => ({ street: x.propertyaddress, city: x.propertycity, zip: '' }),
  },
  {
    name: 'Allegan', box: [-86.28, 42.42, -85.54, 42.77],
    url: 'https://gis.allegancounty.org/server/rest/services/Parcel_Drafter_MIL1/MapServer/0/query',
    where: (a) => `propaddrnu=${a.num} AND UPPER(propstre_1) LIKE '%${a.key}%'`,
    fields: 'propaddrnu,propstre_1,propStre_2,propcity,propzip',
    read: (x) => ({ street: `${x.propaddrnu} ${x.propstre_1} ${String(x.propStre_2 || '').trim()}`, city: x.propcity, zip: x.propzip }),
  },
];

const near = (box, pt, margin = 0.3) => !pt || (pt[0] >= box[0] - margin && pt[0] <= box[2] + margin && pt[1] >= box[1] - margin && pt[1] <= box[3] + margin);

function centre(geometry) {
  const ring = geometry?.rings?.[0];
  if (!ring?.length) return null;
  const pts = ring.slice(0, -1).length ? ring.slice(0, -1) : ring;
  return { lng: pts.reduce((a, p) => a + p[0], 0) / pts.length, lat: pts.reduce((a, p) => a + p[1], 0) / pts.length };
}

/**
 * The parcel for an address, from the counties around `near` ([lng, lat]):
 * { lng, lat, label, accuracy: 'county' } or null. Where several match (a
 * Ct and an Ave of one name, both with that number), the one of the street
 * type asked for wins, then the one nearest.
 */
export async function countyGeocode(fetcher, q, nearPt = null, { timeoutMs = 8000 } = {}) {
  const a = parseStreet(q);
  if (!a.num || !a.key || a.key.length < 2) return null;
  const found = [];
  await Promise.all(COUNTIES.filter((c) => near(c.box, nearPt)).map(async (c) => {
    const params = new URLSearchParams({ where: c.where(a), outFields: c.fields, returnGeometry: 'true', outSR: '4326', f: 'json' });
    try {
      const res = await Promise.race([fetcher(`${c.url}?${params}`), new Promise((_, no) => setTimeout(() => no(new Error('slow')), timeoutMs))]);
      if (!res.ok) return;
      const data = await res.json();
      for (const f of (data.features || []).slice(0, 20)) {
        const at = centre(f.geometry);
        if (!at) continue;
        const r = c.read(f.attributes || {});
        const got = parseStreet(r.street);
        if (got.num !== a.num || !got.name.split(' ').includes(a.key)) continue;
        const label = `${tidy(r.street).replace(/\s+/g, ' ')}, ${tidy(r.city)}, MI${r.zip ? ` ${r.zip}` : ''}`;
        found.push({ ...at, label, accuracy: 'county', score: (a.type && got.type === a.type ? 2 : 0) + (got.name === a.name ? 1 : 0) });
      }
    } catch { /* a county server down: the others still answer */ }
  }));
  if (!found.length) return null;
  const d = (x) => (nearPt ? Math.hypot(x.lng - nearPt[0], x.lat - nearPt[1]) : 0);
  found.sort((x, y) => y.score - x.score || d(x) - d(y));
  const { score, ...best } = found[0];
  return best;
}
