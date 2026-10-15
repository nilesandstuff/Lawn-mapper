/**
 * THE CAMERA ON A LEASH (owner, 2026-10-15: "when in 3d mode, it's
 * currently easy to zoom out too far and pan far away from the property.
 * Put a lock in place that ... doesn't let the imaginary camera POV be
 * located more than 500 m away from the property line (as measured from
 * the ground above the camera. The camera can be up to 2km above the
 * property)").
 *
 * Mapbox constrains the map's CENTER (maxBounds) and its ZOOM, but a tilted
 * camera sits far behind the center: at 75 degrees and 2 km up it is 7 km
 * back. So the leash reads the camera itself (the free-camera API: where it
 * is and how high) after every move, and when the ground under it is more
 * than `maxM` from the property line, or it is higher than `maxAltM`, puts
 * it back at the line, looking the same way. The pure parts (distance to
 * the lot, where the camera goes back to) are exported for the tests.
 */

const R = 6378137;
const RAD = Math.PI / 180;

/** The ring(s) of a GeoJSON Polygon or MultiPolygon, outer rings only. */
export function outerRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((p) => p[0]);
  if (geometry.type === 'Point') return [[geometry.coordinates]];
  return [];
}

/* A local flat frame about `lat0`: meters east and north of (lng0, lat0). */
const toXY = (p, lng0, lat0) => [(p[0] - lng0) * RAD * R * Math.cos(lat0 * RAD), (p[1] - lat0) * RAD * R];
const fromXY = (x, y, lng0, lat0) => [lng0 + x / (RAD * R * Math.cos(lat0 * RAD)), lat0 + y / (RAD * R)];

function inside(x, y, ring) {
  let on = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) on = !on;
  }
  return on;
}

/**
 * Where the point (lng, lat) stands against the lot: { d (meters, 0
 * inside), near: [lng, lat] (the nearest point of the line, or the point
 * itself when inside) }.
 */
export function nearestOnLot(lng, lat, rings) {
  let best = { d: Infinity, near: [lng, lat] };
  for (const ring of rings) {
    const xy = ring.map((p) => toXY(p, lng, lat));
    if (xy.length >= 3 && inside(0, 0, xy)) return { d: 0, near: [lng, lat] };
    const n = xy.length === 1 ? 1 : xy.length;
    for (let i = 0; i < n; i++) {
      const a = xy[i], b = xy.length === 1 ? a : xy[(i + 1) % xy.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / L2)) : 0;
      const px = a[0] + t * dx, py = a[1] + t * dy;
      const d = Math.hypot(px, py);
      if (d < best.d) best = { d, near: fromXY(px, py, lng, lat) };
    }
  }
  return best;
}

/**
 * The camera pulled back onto its leash: null when it is within `maxM` of
 * the lot over the ground and no higher than `maxAltM`; else where it goes,
 * { lng, lat, alt } -- the same bearing from the nearest point of the line,
 * `maxM` out, and no higher than the ceiling.
 */
export function pullBack({ lng, lat, alt }, rings, { maxM = 500, maxAltM = 2000 } = {}) {
  const alt2 = Math.min(alt, maxAltM);
  const { d, near } = nearestOnLot(lng, lat, rings);
  if (d <= maxM && alt2 === alt) return null;
  if (d <= maxM) return { lng, lat, alt: alt2 };
  const [x, y] = toXY([lng, lat], near[0], near[1]);
  const f = maxM / d;
  const [lng2, lat2] = fromXY(x * f, y * f, near[0], near[1]);
  return { lng: lng2, lat: lat2, alt: alt2 };
}

/**
 * The zoom at which a camera looking straight down from `maxAltM` sees a
 * map `heightPx` tall at `lat`: Mapbox's camera stands 1.5 x the map's
 * height (in pixels) from the center, at 512 x 2^zoom pixels round the
 * world. Zooming out past it would lift the camera over the ceiling.
 */
export function zoomFloor(lat, heightPx, maxAltM = 2000) {
  const metersPerPxAtFloor = maxAltM / (1.5 * heightPx);
  return Math.log2((2 * Math.PI * R * Math.cos(lat * RAD)) / (512 * metersPerPxAtFloor));
}

/**
 * Keep `map`'s camera within `maxM` (over the ground) of `feature`'s line
 * and under `maxAltM`. Returns stop(). Needs mapboxgl's free camera
 * (v2+); a map without it is left alone.
 */
export function leash(map, feature, { maxM = 500, maxAltM = 2000 } = {}) {
  const rings = outerRings(feature?.geometry);
  if (!rings.length || typeof map.getFreeCameraOptions !== 'function') return () => {};
  const Merc = globalThis.mapboxgl?.MercatorCoordinate;
  let busy = false;
  const floor = () => {
    const h = map.getContainer()?.clientHeight || map.getCanvas()?.clientHeight || 600;
    const z = zoomFloor(rings[0][0][1], h, maxAltM);
    if (Number.isFinite(z)) map.setMinZoom(Math.max(0, Math.floor(z * 100) / 100));
  };
  const check = () => {
    if (busy) return;
    const fc = map.getFreeCameraOptions();
    const p = fc?.position;
    if (!p || !Merc) return;
    const ll = p.toLngLat();
    const fix = pullBack({ lng: ll.lng, lat: ll.lat, alt: p.toAltitude() }, rings, { maxM, maxAltM });
    if (!fix) return;
    busy = true;
    try {
      fc.position = Merc.fromLngLat([fix.lng, fix.lat], fix.alt);
      map.setFreeCameraOptions(fc);
    } catch { /* an odd transform: leave it */ } finally { busy = false; }
  };
  floor();
  map.on('move', check);
  map.on('resize', floor);
  return () => { map.off('move', check); map.off('resize', floor); map.setMinZoom(0); };
}
