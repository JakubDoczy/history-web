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
 * triangle. The drawn line says so twice — it brightens toward the destination,
 * and (motion allowed) its dashes flow that way.
 *
 * `twoway` — a network. The Silk Road carried silk west and silver east for a
 * thousand years, and the Manila galleon was a round trip by definition; a
 * direction on either would be a claim the history does not support. These get a
 * symmetric treatment instead: an even dash that does not move, and a brightness
 * that fades away equally at both ends.
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

/* --------------------------------------------------------------- smoothing */

/**
 * Samples per authored segment when a route is smoothed. Eight is the point
 * where the corner of a triangle trade route stops reading as a corner; past
 * about twelve nothing on screen changes and the point count doubles.
 */
export const ROUTE_SMOOTH_SAMPLES = 8
/**
 * How hard the spline pulls. 1 is a textbook Catmull-Rom, and a textbook
 * Catmull-Rom through waypoints an author placed to *avoid* land bows out past
 * them — Magellan's turn round Cape Horn swung into Tierra del Fuego at full
 * tension. Half-strength tangents keep the curve visibly curved and keep it in
 * the water; it is still interpolating, so every authored waypoint is still hit
 * exactly whatever this is set to.
 */
export const ROUTE_SMOOTH_TENSION = 0.5
/**
 * Longest segment of a *drawn* route, in degrees of arc — five times finer than
 * the `MAX_SEGMENT_DEG` the data is authored to.
 *
 * Two jobs. It is what makes a long ocean leg a great circle rather than a
 * chord, as before. But it is also what lets the route sit ~4 km off the ground
 * (see `SURFACE_ALT` in lib/drawingLayer.ts): a polyline is drawn as chords, and
 * a chord across 3° of arc sags 2.2 km below the sphere — through the planet, at
 * that altitude. At 1° the sag is 240 m, an eighth of the clearance.
 */
export const ROUTE_SEGMENT_DEG = 1

/**
 * A centripetal Catmull-Rom spline through the waypoints, on the sphere.
 *
 * Authored routes are lists of ports and landfalls, and joining ports with
 * straight arcs draws a voyage as a polygon: Magellan reads as eleven decisions
 * rather than one passage. This puts the curve back — the tangent at each
 * waypoint is a blend of its neighbours', so the drawn line leaves a port on the
 * heading it arrived on and turns through the next one instead of at it.
 *
 * Centripetal (the knots are spaced by the square root of chord length, α=0.5)
 * rather than uniform, because uniform Catmull-Rom loops on itself wherever the
 * spacing is uneven — and route data is nothing but uneven spacing, a dozen
 * waypoints threading the Philippines and two crossing the Pacific.
 *
 * The interpolation is done on the unit vectors and renormalised, so the result
 * is on the sphere by construction and there is no antimeridian to special-case:
 * a spline through 179°E and 179°W passes through 180°, not back across Asia.
 *
 * Every authored waypoint survives exactly, in order — the samples are taken
 * strictly *between* them.
 */
export function smoothPath(
  path: GeoPath,
  samples = ROUTE_SMOOTH_SAMPLES,
  tension = ROUTE_SMOOTH_TENSION,
): GeoPath {
  // Consecutive duplicates carry no direction and would divide by zero in the
  // knot spacing; they are also not a shape anyone authored on purpose.
  const pts = path.filter((p, i) => i === 0 || p[0] !== path[i - 1][0] || p[1] !== path[i - 1][1])
  if (pts.length < 3 || samples < 2) return [...path]
  const v = pts.map(toVec)
  const n = v.length
  // Virtual end control points, reflected through the endpoint: the first and
  // last real segments then get the same treatment as the middle ones, and the
  // route does not straighten out just before it arrives.
  const at = (i: number): [number, number, number] =>
    i < 0
      ? [2 * v[0][0] - v[1][0], 2 * v[0][1] - v[1][1], 2 * v[0][2] - v[1][2]]
      : i >= n
        ? [2 * v[n - 1][0] - v[n - 2][0], 2 * v[n - 1][1] - v[n - 2][1], 2 * v[n - 1][2] - v[n - 2][2]]
        : v[i]
  const dist = (a: [number, number, number], b: [number, number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const out: GeoPath = []
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    // centripetal knots; the floor keeps a degenerate control point (two
    // waypoints a metre apart) from blowing the tangents up
    const d01 = Math.max(Math.sqrt(dist(p0, p1)), 1e-6)
    const d12 = Math.max(Math.sqrt(dist(p1, p2)), 1e-6)
    const d23 = Math.max(Math.sqrt(dist(p2, p3)), 1e-6)
    // Non-uniform Catmull-Rom tangents, scaled into the segment's own [0,1]
    // parameter so the Hermite basis below can be the plain one.
    const m1: [number, number, number] = [0, 0, 0]
    const m2: [number, number, number] = [0, 0, 0]
    for (let k = 0; k < 3; k++) {
      m1[k] =
        tension *
        d12 *
        ((p1[k] - p0[k]) / d01 - (p2[k] - p0[k]) / (d01 + d12) + (p2[k] - p1[k]) / d12)
      m2[k] =
        tension *
        d12 *
        ((p2[k] - p1[k]) / d12 - (p3[k] - p1[k]) / (d12 + d23) + (p3[k] - p2[k]) / d23)
    }
    out.push(pts[i]) // the authored waypoint, verbatim
    for (let s = 1; s < samples; s++) {
      const t = s / samples
      const t2 = t * t
      const t3 = t2 * t
      const h00 = 2 * t3 - 3 * t2 + 1
      const h10 = t3 - 2 * t2 + t
      const h01 = -2 * t3 + 3 * t2
      const h11 = t3 - t2
      const p: [number, number, number] = [0, 0, 0]
      for (let k = 0; k < 3; k++)
        p[k] = h00 * p1[k] + h10 * m1[k] + h01 * p2[k] + h11 * m2[k]
      const len = Math.hypot(p[0], p[1], p[2])
      // A sample can only land on the origin if the control points did; there is
      // no direction to renormalise there, so the waypoints stand alone.
      if (len > 1e-9) out.push(toLngLat([p[0] / len, p[1] / len, p[2] / len]))
    }
  }
  out.push(pts[n - 1])
  return out
}

/**
 * The polyline a route is actually drawn as: smoothed through its waypoints,
 * then densified onto great circles.
 *
 * The order is the whole trick. Smoothing first puts curvature *through* the
 * waypoints, which is a statement about the shape of the voyage; densifying
 * second puts every stretch between two samples on the arc a ship would sail,
 * which is a statement about the sphere. Densifying first and smoothing after
 * would round off the densified points — that is, smooth away the great circle.
 */
export const routePolyline = (path: GeoPath): GeoPath =>
  densifyPath(smoothPath(path), ROUTE_SEGMENT_DEG)

/* ------------------------------------------------------------ route styling */

/**
 * How a route is drawn.
 *
 * The shipped design was a globe.gl paths-layer line: a wide dark solid
 * "halo" entry with a hard-dashed coloured entry laid over it, both floating
 * ~90 km above the planet, the dash advanced by three-globe's own frame ticker.
 * All three of those were wrong, and the numbers are worth keeping:
 *
 *  · **the dash never moved.** Measured on the shipped build with a route open
 *    and the camera parked, the dash offset advanced 0.0000 of line length in
 *    4.7 s — 100% of frames identical. The route wake (`routesDrawn`) bought one
 *    frame per tick with `wake(0)`, so the pump paused and resumed on *every*
 *    frame (11 pauses / 11 resumes in that 4.7 s), and globe.gl's
 *    `pauseAnimation` cancels three-globe's FrameTicker rAF — which had been
 *    scheduled by the `resume` a few statements earlier and had not fired yet.
 *    The animation was structurally unable to tick.
 *  · **when it did move, it lurched.** With the pump's cushion held open by a
 *    drag, the ticker ran free and the offset moved in steps whose largest was
 *    3.9x the median, because the step is `rate x timeDelta` off whatever frames
 *    the browser happened to draw.
 *  · **and the rate was a strobe.** 3200 ms to traverse the line against a
 *    0.04-of-length dash cycle is 7.8 dashes past any point per second.
 *
 * So: no layer ticker, no per-frame accumulation. The phase is a pure function
 * of the wall clock (`flowPhase`), exactly like the cloud drift, and the pump is
 * woken at a steady modest rate while a flowing route is on screen. Any frame,
 * drawn for any reason, shows the phase the clock says.
 *
 * Widths are in *screen pixels* (fat lines), so a route stays legible zoomed out
 * to the ocean it crosses and does not thicken into a band zoomed in. Dash and
 * gap are fractions of the route's own length, so a circumnavigation and a
 * coastal hop carry the same *number* of dashes rather than the same dash size.
 */
export const ROUTE_STYLE = {
  /** The drawn line. Thin and elegant; the casing under it does the shouting. */
  stroke: 2.3,
  /**
   * The casing. Wider than the line by 2.4 px — a pixel of dark either side —
   * and *solid*, so the gaps in the dashed line above still read as one route
   * rather than as unrelated ticks. Without it a route crossing the Sahara or a
   * snowfield disappears into the map; much more of it and the casing becomes
   * the line, with the stroke reading as a highlight down the middle of a black
   * road (5.3 px at half opacity did exactly that at close zoom).
   */
  haloStroke: 2.3 + 2.4,
  haloColor: '#03070d',
  haloOpacity: 0.42,
  /**
   * A one-way route's dash. Duty cycle 0.65 — a chain of long strokes with a
   * breath between them, not a row of ticks. 0.04 of the route per cycle puts 25
   * dashes on a route however long it is.
   */
  dash: 0.026,
  gap: 0.014,
  /**
   * A two-way route's dash: 50/50, the symmetric pattern — reversing the route
   * reverses nothing you can see. It does not move.
   */
  evenDash: 0.02,
  evenGap: 0.02,
  /**
   * How bright the stroke is at the two ends of a route, against 1 at its
   * brightest. A one-way route runs `tail` at the origin to full at the
   * destination, so the direction is legible in a still screenshot and under
   * reduced motion, where no dash is moving. A two-way route is `end` at both
   * ends and full in the middle — symmetric, and it reads as a road fading into
   * the distance in both directions, which is what a trade network is.
   */
  tailOpacity: 0.36,
  endOpacity: 0.5,
  /**
   * One dash cycle, in ms. 1200 against the 128 ms the strobe amounted to: a
   * dash crosses its own length in a beat and a bit, which reads as a current in
   * the line rather than as traffic on it.
   */
  flowCycleMs: 1200,
} as const

/**
 * How often the pump is woken while a route is flowing: ~20 Hz.
 *
 * The dash advances 1/24 of its cycle per frame at this rate — under 2 px on a
 * route framed to fill the screen — and the phase is read from the clock, so a
 * frame that arrives late or early is still correct rather than behind. Compare
 * `cloudIdleIntervalMs`, which answers the same question for the cloud deck.
 */
export const ROUTE_FLOW_INTERVAL_MS = 50

/**
 * Where in the dash cycle the wall clock is: [0, 1).
 *
 * Pure, and modular — it cannot accumulate, drift or lurch, whatever frames were
 * or were not drawn since the last call. This is the whole fix for the animation
 * the owner saw as "rapid then static".
 */
export const flowPhase = (nowMs: number): number => {
  const c = ROUTE_STYLE.flowCycleMs
  return (((nowMs % c) + c) % c) / c
}

/**
 * How bright the stroke is at fraction `t` along a route.
 *
 * One-way rises evenly to the destination; two-way rises to the middle and falls
 * away again, which is symmetric by construction rather than by two numbers
 * somebody has to keep equal. Both are piecewise LINEAR: the ramp is sampled per
 * VERTEX and handed to the stroke as an attribute (`setTaper` in
 * lib/drawingLayer.ts), so the shape only has to be one the eye reads as an even
 * fade, and a straight line is that shape. It used to be cut into twenty
 * constant-opacity pieces, which is why linearity was load-bearing rather than
 * merely tidy; the per-vertex ramp made that a preference.
 */
export const taperOpacity = (t: number, direction: PathDirection): number => {
  const c = Math.max(0, Math.min(1, t))
  if (direction === 'twoway')
    return ROUTE_STYLE.endOpacity + (1 - ROUTE_STYLE.endOpacity) * (1 - Math.abs(2 * c - 1))
  return ROUTE_STYLE.tailOpacity + (1 - ROUTE_STYLE.tailOpacity) * c
}

/* ------------------------------------------------------- points along a route */

/*
 * `PathPoint`, `bearingDeg` and `pointAlongPath` used to live here: the machinery
 * for walking a route by ARC LENGTH and reading off the heading, which is how
 * the direction chevrons were placed a third and two-thirds along. The chevrons
 * are gone with the redesign, and so is the machinery — direction is now carried
 * by the line itself, by a brightness that rises toward the destination (which
 * works in a still frame and under reduced motion) and by dashes that flow the
 * same way when motion is allowed. `slerpPoint` below stays; the renderer trims
 * a thrust's shaft with it.
 */

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
