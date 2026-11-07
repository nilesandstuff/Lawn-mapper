/**
 * WHICH MAP (core session, 2026-11-07; the owner: "the app needs at least to have a picker built on the page (the
 * browser page should too). But it would be very handy if maps could be picked automatically via finding the nearest
 * saved map based on device location."). Pure: the page fetches /api/maps and the phone's place and asks here.
 */
export const NEAR_M = 150; // a map whose middle is this close to the phone is the one it stands on

/** Metres between two [lng, lat] points (haversine). */
export function metresBetween(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** The maps with a place, nearest first when the phone's place is known ({ map, m }), else as given. */
export function byDistance(maps, here = null) {
  const out = (maps || []).filter((m) => Number.isFinite(m?.lng) && Number.isFinite(m?.lat)).map((map) => ({ map, m: here ? metresBetween(here, [map.lng, map.lat]) : null }));
  if (here) out.sort((a, b) => a.m - b.m);
  return out;
}

/** The map to open by itself: the nearest, when it is within NEAR_M (and the phone's fix is not worse than that). */
export function nearestMap(maps, here, accuracyM = 0) {
  if (!here) return null;
  const [first] = byDistance(maps, here);
  return first && first.m <= NEAR_M && accuracyM <= NEAR_M ? first : null;
}

/** A map's name for the list: what the person called it, else its address, else its date. */
export const mapLabel = (m) => String(m?.name || m?.address || (m?.at ? `Map of ${new Date(m.at).toLocaleDateString()}` : 'A map')).slice(0, 80);
