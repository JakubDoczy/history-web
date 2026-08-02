import { separationDeg } from './queryIndex'

/**
 * Route geometry — the lines a *path event* draws on the globe when it is
 * opened: the Silk Road's branches, the triangle of the Atlantic slave trade,
 * the track of the Magellan–Elcano circumnavigation.
 *
 * ONE canonical field, `paths`, and it is always an array of polylines. A
 * single route is `[route]`, one element long. The alternative — a `path` for
 * the common case and a `paths` for the rest — would put a two-way branch in
 * every consumer (the pin glyph, the layer, the bounding cap, the validator,
 * the tests) to save one pair of brackets in the data. Most of the routes worth
 * drawing are networks or round trips anyway: an out-and-back voyage is two
 * legs that do not retrace each other, and a trade road is a fan of branches.
 *
 * A point is `[lng, lat]` — GeoJSON order, the same order `Ring` uses for area
 * events (lib/nations.ts), so one reading rule covers every piece of geometry
 * in the dataset.
 */
export type GeoPath = [number, number][]

const RAD = Math.PI / 180

/**
 * Longest segment, in degrees of arc, that `densifyPath` will leave alone.
 *
 * Three degrees is ~330 km — a couple of pixels of curve error at the zoom this
 * globe is usually read at, and well under the ~100 km fidelity the routes are
 * authored to.
 */
export const MAX_SEGMENT_DEG = 3

const toVec = ([lng, lat]: [number, number]): [number, number, number] => {
  const p = lat * RAD
  const l = lng * RAD
  const c = Math.cos(p)
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)]
}

const toLngLat = (v: [number, number, number]): [number, number] => [
  Math.atan2(v[1], v[0]) / RAD,
  Math.atan2(v[2], Math.hypot(v[0], v[1])) / RAD,
]

/**
 * Subdivide a polyline so that no segment spans more than `maxSegDeg`, putting
 * the new points on the great circle between the ones they sit between.
 *
 * This exists because of how the renderer joins two points: three-globe's paths
 * layer interpolates **linearly in lat/lng** at its own resolution, which is a
 * rhumb line, not a great circle. Over a short hop the two agree; over an ocean
 * they do not. Cape Verde to Barbados drawn as a lat/lng straight line runs
 * hundreds of kilometres north of the track a ship actually sailed, and — worse
 * for a globe you can spin — it reads as *wrong*, because a great circle is what
 * a straight line on a sphere looks like.
 *
 * So the data is authored at waypoint fidelity and the curve is put in here,
 * before the layer ever sees it: after densification every segment is short
 * enough that the renderer's linear fill-in is indistinguishable from the arc.
 *
 * Pure, and endpoint-exact: every authored waypoint survives unmoved, in order,
 * so a route still passes through the ports it names. Antipodal pairs are left
 * alone — there is no unique great circle between them, and guessing one would
 * be inventing geography.
 */
export function densifyPath(path: GeoPath, maxSegDeg = MAX_SEGMENT_DEG): GeoPath {
  if (path.length < 2 || !(maxSegDeg > 0)) return [...path]
  const out: GeoPath = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const sep = separationDeg(a[1], a[0], b[1], b[0])
    // The epsilon is not cosmetic: a segment that is an exact multiple of the
    // limit lands on 2.0000000000000004 often enough to matter, and rounding
    // that up costs an extra point on every regular leg of every route.
    const steps = Math.ceil(sep / maxSegDeg - 1e-9)
    // 179.9°: near-antipodal points have no well-defined arc between them, and
    // the slerp denominator vanishes there anyway
    if (steps > 1 && sep < 179.9) {
      const va = toVec(a)
      const vb = toVec(b)
      const omega = sep * RAD
      const sinOmega = Math.sin(omega)
      for (let s = 1; s < steps; s++) {
        const t = s / steps
        const k1 = Math.sin((1 - t) * omega) / sinOmega
        const k2 = Math.sin(t * omega) / sinOmega
        out.push(
          toLngLat([
            va[0] * k1 + vb[0] * k2,
            va[1] * k1 + vb[1] * k2,
            va[2] * k1 + vb[2] * k2,
          ]),
        )
      }
    }
    out.push(b)
  }
  return out
}

/** `densifyPath` over a whole set of routes. */
export const densifyPaths = (paths: GeoPath[], maxSegDeg = MAX_SEGMENT_DEG): GeoPath[] =>
  paths.map((p) => densifyPath(p, maxSegDeg))

/** Every point of every route, in one list — what a bounding cap is cut from. */
export const allPathPoints = (paths: GeoPath[]): GeoPath => paths.flat() as GeoPath

/**
 * Is this a drawable route? Two points at least (one point is a place, not a
 * path), each a coordinate pair on the planet.
 *
 * The same rule is enforced at build time by scripts/build_event_chunks.py and
 * asserted over the shipped corpus by tests/eventsData.test.ts; this is the
 * runtime copy, for anything that reaches the layer from elsewhere.
 */
export const isGeoPath = (p: unknown): p is GeoPath =>
  Array.isArray(p) &&
  p.length >= 2 &&
  p.every(
    (pt) =>
      Array.isArray(pt) &&
      pt.length === 2 &&
      Number.isFinite(pt[0]) &&
      Number.isFinite(pt[1]) &&
      Math.abs(pt[0]) <= 180 &&
      Math.abs(pt[1]) <= 90,
  )
