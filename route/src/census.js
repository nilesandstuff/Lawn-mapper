/**
 * The US Census Bureau's geocoder: a second opinion when Mapbox cannot place
 * an address (route session, 2026-11-10). Free, no key, no Mapbox allowance.
 *
 * Found on a real work order (2026-11-10): a "Ct" Mapbox did not have near
 * the shop (it offered a street of that name in Florida), which the Census
 * matched to the same house number on the "Ave" of that name -- a house
 * Mapbox also knew. The Census's address ranges come from the county and the
 * post office; a work order's street type is not always theirs.
 */

const KEEP_UPPER = /^(N|S|E|W|NE|NW|SE|SW|[A-Z]{2})$/;

/** "4120 JUNIPER AVE SE, FAIRVIEW, MI, 49999" -> "4120 Juniper Ave SE, Fairview, MI 49999". */
export function tidyLabel(s) {
  const parts = String(s).split(',').map((p) => p.trim());
  const words = (p, i) => p.split(/\s+/).map((w) => (KEEP_UPPER.test(w) && (i > 0 || /^(N|S|E|W|NE|NW|SE|SW)$/.test(w)) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');
  const out = parts.map(words);
  if (out.length >= 4 && /^\d{5}/.test(out[out.length - 1])) out.splice(-2, 2, `${out[out.length - 2]} ${out[out.length - 1]}`);
  return out.join(', ');
}

export async function censusGeocode(fetcher, q) {
  const params = new URLSearchParams({ address: q, benchmark: 'Public_AR_Current', format: 'json' });
  const res = await fetcher(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params}`);
  if (!res.ok) return null;
  const m = (await res.json())?.result?.addressMatches?.[0];
  if (!m || !Number.isFinite(m.coordinates?.x) || !Number.isFinite(m.coordinates?.y)) return null;
  return { lng: m.coordinates.x, lat: m.coordinates.y, label: tidyLabel(m.matchedAddress), accuracy: 'census' };
}
