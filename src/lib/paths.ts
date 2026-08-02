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

/* --------------------------------------------------------------- direction */

/**
 * Does this route have a direction?
 *
 * `oneway` — a voyage. Something went from the first waypoint to the last, once
 * and that way round: Magellan west, da Gama east, a slaving ship's leg of the
 * triangle. The drawn line says so — the dashes run along the travel direction
 * and arrowheads sit on the road.
 *
 * `twoway` — a network. The Silk Road carried silk west and silver east for a
 * thousand years, and the Manila galleon was a round trip by definition; an
 * arrow on either would be a claim the history does not support. These get a
 * symmetric treatment instead: an even 50% dash that does not move.
 *
 * The default is `oneway` because most drawn routes are voyages, and because a
 * voyage that forgot to declare itself should still read as a voyage. A trade
 * network that forgets says something mildly wrong, which is the cheaper error:
 * it is a smaller set, and it is the set an author is thinking hardest about.
 */
export type PathDirection = 'oneway' | 'twoway'
export const DEFAULT_DIRECTION: PathDirection = 'oneway'
export const directionOf = (e: { direction?: PathDirection }): PathDirection =>
  e.direction ?? DEFAULT_DIRECTION

/* ------------------------------------------------------------ route styling */

/**
 * How a route is drawn. Gathered here rather than scattered through the globe
 * component because the numbers are a set — the halo is only a halo if it is
 * wider than the line it sits under, and the dash only reads as flowing if the
 * pattern is short enough to see a dash arrive.
 *
 * Widths are in *screen pixels* (the layer draws fat lines), so a route stays
 * legible zoomed out to the ocean it crosses and does not thicken into a band
 * zoomed in. Dash and gap are in units of line length, so a long voyage and a
 * short one carry the same *number* of dashes rather than the same dash size.
 */
export const ROUTE_STYLE = {
  /** The drawn line. 2.6 px: enough body to carry a colour over bright terrain. */
  stroke: 2.6,
  /**
   * The under-stroke. Wider than the line by 2.2 px — about a pixel of dark
   * either side — and *solid*, so the gaps in the dashed line above still read
   * as a route rather than as unrelated ticks. Without it a route crossing the
   * Sahara or a snowfield disappears into the map.
   */
  haloStroke: 2.6 + 2.2,
  haloColor: 'rgba(5,9,16,0.62)',
  /**
   * A one-way route's dash. Duty cycle 0.7 (was 0.625): more line than gap, so
   * the eye follows a chain rather than counting ticks.
   */
  dash: 0.028,
  gap: 0.012,
  /**
   * A two-way route's dash: 50/50, which is the symmetric pattern — reversing
   * the route reverses nothing you can see. It does not animate.
   */
  evenDash: 0.02,
  evenGap: 0.02,
  /**
   * How long a dash takes to travel the whole line, in ms. 3200 against the
   * 9000 it was: at 9 s a dash crossed an ocean slower than the cloud deck
   * drifts and read as a still line someone had nudged. Still calm — a dash
   * covers a thirtieth of the route per second, which is a walk, not a strobe.
   */
  animateMs: 3200,
  /** Altitudes: halo below line, both above the area cap (0.012), below the pins. */
  lineAlt: 0.0142,
  haloAlt: 0.0132,
} as const

/* ------------------------------------------------------- points along a route */

/** A place on a route, and which way the route is going through it. */
export interface PathPoint {
  lng: number
  lat: number
  /** Degrees clockwise from north — the tangent, pointing the way of travel. */
  bearing: number
}

/**
 * Initial bearing from `a` to `b`, degrees clockwise from north.
 *
 * "Initial" is the honest word: on a sphere the bearing of a great circle
 * changes along it, so this is the direction you set off in. Over the short
 * segments a densified route is made of, that is the direction of the segment.
 */
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const p1 = a[1] * RAD
  const p2 = b[1] * RAD
  const dl = (b[0] - a[0]) * RAD
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  const deg = Math.atan2(y, x) / RAD
  return (deg + 360) % 360
}

/**
 * The point a given fraction of the way along a route, by ARC LENGTH — not by
 * waypoint count.
 *
 * The difference is the whole point. Magellan's track is authored with a dozen
 * waypoints around the Philippines and two across the Pacific, so "the middle
 * waypoint" is in Indonesia while the middle of the *voyage* is in open water.
 * An arrowhead placed by waypoint index would cluster wherever the author
 * happened to write detail.
 *
 * `t` is clamped to [0, 1]; the bearing at the ends is the first (or last)
 * segment's, which is the direction the route leaves (or arrives) in.
 */
export function pointAlongPath(path: GeoPath, t: number): PathPoint | undefined {
  if (path.length < 2) return undefined
  const segs: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const d = separationDeg(path[i - 1][1], path[i - 1][0], path[i][1], path[i][0])
    segs.push(d)
    total += d
  }
  // A route whose waypoints are all the same place has no length to walk along;
  // the first point is the only answer that is not a division by zero.
  if (!(total > 0)) return { lng: path[0][0], lat: path[0][1], bearing: 0 }
  let want = Math.max(0, Math.min(1, t)) * total
  for (let i = 0; i < segs.length; i++) {
    if (want > segs[i] && i < segs.length - 1) {
      want -= segs[i]
      continue
    }
    const a = path[i]
    const b = path[i + 1]
    const f = segs[i] > 0 ? Math.max(0, Math.min(1, want / segs[i])) : 0
    // Interpolating on the great circle rather than in lat/lng, for the reason
    // densifyPath exists at all: over a long leg the two are not the same place.
    const [lng, lat] = slerpPoint(a, b, f)
    return { lng, lat, bearing: bearingDeg(a, b) }
  }
  return undefined
}

/**
 * The point a fraction `f` of the way along the great circle from `a` to `b`.
 * Near-antipodal pairs fall back to the endpoint, for the same reason
 * `densifyPath` leaves them alone: there is no unique arc to walk along.
 */
export function slerpPoint(a: [number, number], b: [number, number], f: number): [number, number] {
  if (f <= 0) return [a[0], a[1]]
  if (f >= 1) return [b[0], b[1]]
  const sep = separationDeg(a[1], a[0], b[1], b[0])
  if (!(sep > 1e-9) || sep >= 179.9) return [b[0], b[1]]
  const omega = sep * RAD
  const sinOmega = Math.sin(omega)
  const va = toVec(a)
  const vb = toVec(b)
  const k1 = Math.sin((1 - f) * omega) / sinOmega
  const k2 = Math.sin(f * omega) / sinOmega
  return toLngLat([
    va[0] * k1 + vb[0] * k2,
    va[1] * k1 + vb[1] * k2,
    va[2] * k1 + vb[2] * k2,
  ])
}

/**
 * Where the arrowheads go on a one-way route: a third and two-thirds along.
 *
 * Not at the end, which is where an arrow "belongs" on a diagram — a route's end
 * is a port, and the port already carries a terminus dot. Two arrows inside the
 * line say the direction twice, at places the eye lands anyway, and survive the
 * route being partly behind the planet.
 */
export const ARROW_FRACTIONS = [1 / 3, 2 / 3] as const

/** The termini — first and last point of every route. The ports. */
export const pathTermini = (paths: GeoPath[]): GeoPath =>
  paths.filter((p) => p.length >= 2).flatMap((p) => [p[0], p[p.length - 1]])
