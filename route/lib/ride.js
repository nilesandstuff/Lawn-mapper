/**
 * Riding the machine between close stops (route session, 2026-11-06).
 *
 * Owner: "when stops are close together, like within 1,000 feet by the road
 * or adjacent through backyards, it saves time, probably 5 minutes per stop,
 * for a person to ride their machine to that stop rather than load their
 * equipment back up and drive."
 *
 * So between two STOPS (never the shop or a start) that are close -- by the
 * road within `road` metres, or in a straight line within `yard` metres
 * (back-to-back lots, where the road round is long) -- the step costs its
 * travel minus `save` seconds: no loading up, no unloading. Through the
 * yards the travel is the walk across at riding pace, if that beats the
 * road. The step can come out below zero; the route finders (solve.js,
 * split.js) take that as it is, so close stops are drawn together, onto one
 * person and next to each other.
 */

export const RIDE_DEFAULTS = { road: 305, yard: 70, save: 300 }; // 1,000 ft, 230 ft, 5 minutes
const RIDE_SPEED = 2.2; // metres a second, about 5 mph on a spreader
const ACROSS = 1.4; // a yard crossing is not a straight line

export function metres(a, b) {
  const r = Math.PI / 180;
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * 6371000;
}

/** 'road', 'yard' or null: whether two stops are close enough to ride between. */
export function closeness(a, b, roadMetres, rules = RIDE_DEFAULTS) {
  if (!rules || !rules.save) return null;
  if (roadMetres != null && roadMetres <= rules.road) return 'road';
  if (metres(a, b) <= rules.yard) return 'yard';
  return null;
}

/** The seconds a close step takes on the machine, before the saving. */
export function rideSeconds(a, b, kind, driveSeconds) {
  if (kind === 'yard') return Math.min(driveSeconds ?? Infinity, (metres(a, b) * ACROSS) / RIDE_SPEED);
  return driveSeconds ?? (metres(a, b) * ACROSS) / RIDE_SPEED;
}

/**
 * The drive matrix with close steps between stops turned into rides.
 *   points  [{ lng, lat }] in matrix order
 *   isStop  (i) -> whether point i is a stop (not the shop, not a start)
 * Returns { D: the adjusted matrix, close: (i, j) -> 'road' | 'yard' | null }.
 */
export function rideAdjust(D, M, points, isStop, rules = RIDE_DEFAULTS) {
  const n = points.length;
  const kinds = Array.from({ length: n }, () => Array(n).fill(null));
  const out = D.map((row) => row.slice());
  if (rules && rules.save) {
    for (let i = 0; i < n; i += 1) {
      if (!isStop(i)) continue;
      for (let j = 0; j < n; j += 1) {
        if (i === j || !isStop(j)) continue;
        const kind = closeness(points[i], points[j], M?.[i]?.[j], rules);
        if (!kind) continue;
        kinds[i][j] = kind;
        out[i][j] = rideSeconds(points[i], points[j], kind, D[i][j]) - rules.save;
      }
    }
  }
  return { D: out, close: (i, j) => kinds[i]?.[j] || null };
}

/**
 * A leg as shown: { duration, distance } and, when it is a ride between
 * close stops, ride: true and saved: the seconds it saves.
 */
export function rideLeg(leg, a, b, rules = RIDE_DEFAULTS) {
  if (!leg || !a || !b || !rules?.save) return leg;
  const kind = closeness(a, b, leg.distance, rules);
  if (!kind) return leg;
  return { ...leg, duration: Math.round(rideSeconds(a, b, kind, leg.duration)), ride: kind, saved: rules.save };
}

/** Rules from the planner's settings (feet and minutes) to metres and seconds. */
export function rulesFrom({ roadFt = 1000, yardFt = 230, saveMin = 5 } = {}) {
  return { road: Number(roadFt) * 0.3048, yard: Number(yardFt) * 0.3048, save: Number(saveMin) * 60 };
}
