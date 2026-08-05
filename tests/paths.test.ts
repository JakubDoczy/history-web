import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import {
  AREA_CAP_RESOLUTION_DEG,
  MAX_SEGMENT_DEG,
  ROUTE_FLOW_INTERVAL_MS,
  ROUTE_SEGMENT_DEG,
  ROUTE_SMOOTH_SAMPLES,
  ROUTE_STYLE,
  areaCapRing,
  densifyPath,
  densifyPaths,
  directionOf,
  flowPhase,
  isGeoPath,
  routePolyline,
  slerpPoint,
  smoothPath,
  taperOpacity,
  type GeoPath,
} from '../src/lib/paths'
import { separationDeg } from '../src/lib/queryIndex'

/** Longest segment of a polyline, in degrees of arc. */
const longestSegment = (path: GeoPath) =>
  path.slice(1).reduce((max, p, i) => Math.max(max, separationDeg(path[i][1], path[i][0], p[1], p[0])), 0)

/** How far a point lies off the great circle through a and b, in degrees. */
const offArc = (a: [number, number], b: [number, number], p: [number, number]) => {
  const RAD = Math.PI / 180
  const vec = ([lng, lat]: [number, number]) => {
    const c = Math.cos(lat * RAD)
    return [c * Math.cos(lng * RAD), c * Math.sin(lng * RAD), Math.sin(lat * RAD)] as const
  }
  const [ax, ay, az] = vec(a)
  const [bx, by, bz] = vec(b)
  const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]
  const len = Math.hypot(...n)
  const [px, py, pz] = vec(p)
  return Math.abs(Math.asin((n[0] * px + n[1] * py + n[2] * pz) / len)) / RAD
}

describe('densifyPath', () => {
  it('leaves a path whose segments are already short alone', () => {
    const path: GeoPath = [
      [0, 0],
      [1, 1],
      [2, 2],
    ]
    expect(densifyPath(path)).toEqual(path)
  })

  it('subdivides until every segment is within the limit', () => {
    // Cape Verde to Barbados: one authored leg, 3700 km of open ocean
    const leg: GeoPath = [
      [-23.5, 14.9],
      [-59.6, 13.1],
    ]
    for (const maxSeg of [1, 3, 10]) {
      const out = densifyPath(leg, maxSeg)
      expect(longestSegment(out)).toBeLessThanOrEqual(maxSeg + 1e-9)
      expect(out.length).toBeGreaterThan(2)
    }
    expect(longestSegment(densifyPath(leg))).toBeLessThanOrEqual(MAX_SEGMENT_DEG)
  })

  it('keeps every authored waypoint, unmoved and in order', () => {
    const path: GeoPath = [
      [-6.35, 36.79],
      [-70.9, -53.5],
      [144.75, 13.45],
    ]
    const out = densifyPath(path)
    let at = 0
    for (const p of path) {
      const found = out.findIndex((q, i) => i >= at && q[0] === p[0] && q[1] === p[1])
      expect(found, `${p} survived`).toBeGreaterThanOrEqual(at)
      at = found
    }
  })

  it('puts the new points on the great circle, not on a lat/lng straight line', () => {
    // The whole reason the helper exists: three-globe interpolates linearly in
    // lat/lng, which on a long east-west leg at latitude is nowhere near the arc.
    const a: [number, number] = [-9.14, 38.72] // Lisbon
    const b: [number, number] = [-74.0, 40.7] // New York
    const out = densifyPath([a, b], 3)
    for (const p of out) expect(offArc(a, b, p)).toBeLessThan(1e-6)
    // and the arc really is off the naive average — halfway along, a lat/lng
    // straight line sits at 39.7°N and the great circle at 44.5°N, which at this
    // scale is 500 km of ocean between the drawn line and the sailed one
    const mid = out[Math.floor(out.length / 2)]
    expect(mid[1]).toBeGreaterThan(43.5)
    expect(Math.max(...out.map((p) => p[1]))).toBeGreaterThan(44)
  })

  it('handles the poles and the antimeridian without special-casing them', () => {
    const overPole = densifyPath(
      [
        [0, 80],
        [180, 80],
      ],
      10,
    )
    // the great circle between them runs over the pole
    expect(Math.max(...overPole.map((p) => p[1]))).toBeGreaterThan(89)
    const overDateline = densifyPath(
      [
        [170, 10],
        [-170, 10],
      ],
      3,
    )
    expect(longestSegment(overDateline)).toBeLessThanOrEqual(3 + 1e-9)
    for (const p of overDateline) expect(Math.abs(p[0])).toBeLessThanOrEqual(180)
  })

  it('refuses to invent an arc between antipodes, and copes with degenerate input', () => {
    const antipodal: GeoPath = [
      [0, 0],
      [180, 0],
    ]
    expect(densifyPath(antipodal)).toEqual(antipodal)
    expect(densifyPath([[1, 2]])).toEqual([[1, 2]])
    expect(densifyPath([])).toEqual([])
    // a nonsense limit is not an invitation to loop forever
    expect(
      densifyPath(
        [
          [0, 0],
          [40, 0],
        ],
        0,
      ),
    ).toEqual([
      [0, 0],
      [40, 0],
    ])
  })

  it('is pure: the input is not touched', () => {
    const path: GeoPath = [
      [0, 0],
      [40, 0],
    ]
    const before = JSON.stringify(path)
    densifyPath(path)
    expect(JSON.stringify(path)).toBe(before)
  })
})

describe('densifyPaths', () => {
  const routes: GeoPath[] = [
    [
      [0, 0],
      [40, 0],
    ],
    [
      [10, 10],
      [11, 11],
    ],
  ]

  it('densifies each route independently', () => {
    const out = densifyPaths(routes, 5)
    expect(out).toHaveLength(2)
    expect(out[0].length).toBeGreaterThan(2)
    expect(out[1]).toEqual(routes[1])
  })

})

describe('isGeoPath', () => {
  it('accepts a two-point route and anything longer', () => {
    expect(
      isGeoPath([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(true)
    expect(
      isGeoPath([
        [-180, -90],
        [180, 90],
        [0, 0],
      ]),
    ).toBe(true)
  })

  it('rejects a single point, a bad pair and a coordinate off the planet', () => {
    expect(isGeoPath([[0, 0]])).toBe(false)
    expect(isGeoPath([])).toBe(false)
    expect(isGeoPath('nope')).toBe(false)
    expect(
      isGeoPath([
        [0, 0, 5],
        [1, 1],
      ]),
    ).toBe(false)
    expect(
      isGeoPath([
        [0, 0],
        [181, 0],
      ]),
    ).toBe(false)
    expect(
      isGeoPath([
        [0, 0],
        [0, 91],
      ]),
    ).toBe(false)
    expect(
      isGeoPath([
        [0, 0],
        [0, Number.NaN],
      ]),
    ).toBe(false)
  })
})

describe('directionOf', () => {
  it('defaults to one-way, so a voyage need not declare itself', () => {
    expect(directionOf({})).toBe('oneway')
    expect(directionOf({ direction: 'oneway' })).toBe('oneway')
    expect(directionOf({ direction: 'twoway' })).toBe('twoway')
  })
})

describe('slerpPoint', () => {
  it('returns the endpoints exactly', () => {
    const a: [number, number] = [10, 20]
    const b: [number, number] = [30, 40]
    expect(slerpPoint(a, b, 0)).toEqual(a)
    expect(slerpPoint(a, b, 1)).toEqual(b)
    expect(slerpPoint(a, b, -1)).toEqual(a)
    expect(slerpPoint(a, b, 2)).toEqual(b)
  })

  it('lands on the great circle, not on the lat/lng straight line', () => {
    // Cape Verde to Barbados: the arc runs south of the rhumb line
    const a: [number, number] = [-23.5, 14.9]
    const b: [number, number] = [-59.6, 13.1]
    const mid = slerpPoint(a, b, 0.5)
    expect(offArc(a, b, mid)).toBeLessThan(1e-6)
    expect(separationDeg(a[1], a[0], mid[1], mid[0])).toBeCloseTo(
      separationDeg(mid[1], mid[0], b[1], b[0]),
      6,
    )
  })

  it('does not invent an arc between antipodes', () => {
    expect(slerpPoint([0, 0], [180, 0], 0.5)).toEqual([180, 0])
  })
})

describe('ROUTE_STYLE', () => {
  it('keeps the casing wider than the line it sits under', () => {
    expect(ROUTE_STYLE.haloStroke).toBeGreaterThan(ROUTE_STYLE.stroke)
    // thin and elegant, not a band
    expect(ROUTE_STYLE.stroke).toBeGreaterThanOrEqual(2)
    expect(ROUTE_STYLE.stroke).toBeLessThanOrEqual(3)
  })

  it('gives a one-way route more line than gap, and a two-way one an even split', () => {
    expect(ROUTE_STYLE.dash / (ROUTE_STYLE.dash + ROUTE_STYLE.gap)).toBeGreaterThan(0.6)
    expect(ROUTE_STYLE.evenDash).toBe(ROUTE_STYLE.evenGap)
  })

  it('runs the dash at a walk: a dash crosses its own length in about a beat', () => {
    // 3200 ms to traverse the whole line against a 0.04 cycle was 7.8 dashes a
    // second past any point — a strobe. One cycle per 1.2 s is a current.
    expect(ROUTE_STYLE.flowCycleMs).toBeGreaterThan(700)
    expect(ROUTE_STYLE.flowCycleMs).toBeLessThan(2500)
  })

  it('wakes the pump often enough to be smooth and rarely enough to be cheap', () => {
    expect(ROUTE_FLOW_INTERVAL_MS).toBeGreaterThanOrEqual(45) // not 60 Hz
    expect(ROUTE_FLOW_INTERVAL_MS).toBeLessThanOrEqual(70) // at least ~15 Hz
    // and the dash moves well under a tenth of its cycle between frames
    expect(ROUTE_FLOW_INTERVAL_MS / ROUTE_STYLE.flowCycleMs).toBeLessThan(0.1)
  })
})

describe('flowPhase', () => {
  it('is a pure function of the clock, and never accumulates', () => {
    // The whole fix for "rapid then static": whatever frames were or were not
    // drawn, the phase at a given instant is the same number.
    expect(flowPhase(0)).toBe(0)
    expect(flowPhase(ROUTE_STYLE.flowCycleMs / 4)).toBeCloseTo(0.25, 12)
    expect(flowPhase(ROUTE_STYLE.flowCycleMs)).toBeCloseTo(0, 12)
    // a hundred cycles later is the same place in the cycle
    expect(flowPhase(ROUTE_STYLE.flowCycleMs * 100.25)).toBeCloseTo(0.25, 6)
  })

  it('stays in [0, 1) for any clock, including a negative one', () => {
    for (const t of [-1e9, -0.5, 0, 1, 12345.6, 1e12]) {
      const p = flowPhase(t)
      expect(p, `${t}`).toBeGreaterThanOrEqual(0)
      expect(p, `${t}`).toBeLessThan(1)
    }
  })

  it('advances at exactly one cycle per flowCycleMs, at any sampling', () => {
    // sampled evenly, sampled unevenly, sampled with a gap: same rate
    const rate = (a: number, b: number) => {
      let d = flowPhase(b) - flowPhase(a)
      if (d < 0) d += 1 // one wrap
      return d / (b - a)
    }
    const want = 1 / ROUTE_STYLE.flowCycleMs
    for (const [a, b] of [
      [0, 16],
      [1000, 1050],
      [5000, 5900],
      [1e6 + 3, 1e6 + 7],
    ])
      expect(rate(a, b), `${a}->${b}`).toBeCloseTo(want, 12)
  })
})

describe('taperOpacity', () => {
  it('rises to the destination on a one-way route', () => {
    expect(taperOpacity(0, 'oneway')).toBeCloseTo(ROUTE_STYLE.tailOpacity, 12)
    expect(taperOpacity(1, 'oneway')).toBeCloseTo(1, 12)
    let prev = -1
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = taperOpacity(t, 'oneway')
      expect(v).toBeGreaterThan(prev)
      prev = v
    }
  })

  it('is symmetric on a two-way route: reversing it changes nothing you can see', () => {
    for (const t of [0, 0.1, 0.3, 0.5, 0.75, 1])
      expect(taperOpacity(t, 'twoway'), `${t}`).toBeCloseTo(taperOpacity(1 - t, 'twoway'), 12)
    expect(taperOpacity(0, 'twoway')).toBeCloseTo(ROUTE_STYLE.endOpacity, 12)
    expect(taperOpacity(0.5, 'twoway')).toBeCloseTo(1, 12)
  })

  it('never goes dark enough to lose the route, and never over full', () => {
    for (const dir of ['oneway', 'twoway'] as const)
      for (let t = -0.5; t <= 1.5; t += 0.1) {
        expect(taperOpacity(t, dir), `${dir} ${t}`).toBeGreaterThanOrEqual(0.3)
        expect(taperOpacity(t, dir), `${dir} ${t}`).toBeLessThanOrEqual(1)
      }
  })
})

describe('smoothPath', () => {
  const corner: GeoPath = [
    [0, 0],
    [20, 0],
    [20, 20],
  ]

  it('keeps every authored waypoint, exactly and in order', () => {
    const out = smoothPath(corner)
    let at = -1
    for (const p of corner) {
      const found = out.findIndex((q, i) => i > at && q[0] === p[0] && q[1] === p[1])
      expect(found, `${p} survived`).toBeGreaterThan(at)
      at = found
    }
  })

  it('puts samples between the waypoints, so the corner stops being a corner', () => {
    const out = smoothPath(corner)
    expect(out.length).toBe((corner.length - 1) * ROUTE_SMOOTH_SAMPLES + 1)
    // The turn is ROUNDED: the samples either side of the waypoint leave the two
    // straight legs, so the drawn line goes *through* the corner on a curve
    // rather than hitting it. This is the whole point of smoothing, and its
    // whole risk — the same test bounds the excursion, because a spline that
    // rounds a corner by 5° would sail a voyage onto the land it was avoiding.
    let worst = 0
    for (const [lng, lat] of out) {
      const offLegs = Math.min(
        lng <= 20 ? Math.abs(lat) : Infinity, // the eastward leg lies on lat 0
        lat >= 0 ? Math.abs(lng - 20) : Infinity, // the northward leg on lng 20
      )
      worst = Math.max(worst, offLegs)
    }
    expect(worst, 'the corner is actually rounded').toBeGreaterThan(0.15)
    expect(worst, 'and not rounded into the next country').toBeLessThan(1)
  })

  it('stays on the sphere: every sample is a real coordinate', () => {
    for (const path of [
      corner,
      [[170, 10], [-170, 12], [-160, 8]] as GeoPath, // across the antimeridian
      [[0, 85], [90, 87], [180, 85]] as GeoPath, // over the pole
    ]) {
      for (const [lng, lat] of smoothPath(path)) {
        expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true)
        expect(Math.abs(lng)).toBeLessThanOrEqual(180)
        expect(Math.abs(lat)).toBeLessThanOrEqual(90)
      }
    }
  })

  it('does not bow far off the road the waypoints describe', () => {
    // The failure this guards: a full-tension Catmull-Rom through waypoints an
    // author placed to stay in the water swings past them and onto land.
    const route: GeoPath = [
      [-6.35, 36.79],
      [-15.4, 28.1],
      [-25, 20],
      [-59.6, 13.1],
    ]
    for (const p of smoothPath(route)) {
      const nearest = Math.min(
        ...densifyPath(route, 0.5).map(([lng, lat]) => separationDeg(p[1], p[0], lat, lng)),
      )
      expect(nearest, `${p} wandered off the route`).toBeLessThan(2)
    }
  })

  it('has nothing to smooth on a straight hop, and never touches its input', () => {
    const two: GeoPath = [
      [0, 0],
      [10, 0],
    ]
    expect(smoothPath(two)).toEqual(two)
    const before = JSON.stringify(corner)
    smoothPath(corner)
    expect(JSON.stringify(corner)).toBe(before)
  })

  it('survives repeated waypoints without dividing by zero', () => {
    const doubled: GeoPath = [
      [0, 0],
      [10, 0],
      [10, 0],
      [10, 10],
    ]
    for (const [lng, lat] of smoothPath(doubled))
      expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true)
  })
})

describe('routePolyline', () => {
  it('smooths THEN densifies: curved through the waypoints, arc-true between them', () => {
    const leg: GeoPath = [
      [-9.14, 38.72],
      [-30, 30],
      [-74.0, 40.7],
    ]
    const out = routePolyline(leg)
    for (let i = 1; i < out.length; i++)
      expect(
        separationDeg(out[i - 1][1], out[i - 1][0], out[i][1], out[i][0]),
      ).toBeLessThanOrEqual(ROUTE_SEGMENT_DEG + 1e-9)
    // and the authored ports are still on it
    for (const p of leg) expect(out.some((q) => q[0] === p[0] && q[1] === p[1]), `${p}`).toBe(true)
  })

  it('leaves chords short enough to hug the ground at SURFACE_ALT', () => {
    // A polyline is drawn as chords. A chord across `d` degrees sags
    // R(1-cos(d/2)) below the sphere; at 1° that is 240 m, against the ~3.8 km
    // the overlays are lifted by. Any coarser and a grounded route would sink
    // into the planet between its own vertices.
    const sagKm = 6371 * (1 - Math.cos((ROUTE_SEGMENT_DEG / 2) * (Math.PI / 180)))
    expect(sagKm).toBeLessThan(0.0006 * 6371 * 0.25)
  })
})

/**
 * The rule the polygon layer is silently relying on.
 *
 * three-conic-polygon-geometry interpolates a cap's contour along great
 * circles, then decides which boundary triangles to keep with a *planar*
 * point-in-polygon test against the ring it was handed. If those two disagree
 * it throws away triangles that are genuinely inside, and the fill comes back
 * with bites out of its edge. They only agree if the ring we hand it already
 * contains every point the layer would have interpolated.
 */
describe('areaCapRing', () => {
  const RAD = Math.PI / 180
  const sepDeg = (a: [number, number], b: [number, number]) => {
    const v = ([lng, lat]: [number, number]) => {
      const p = lat * RAD
      const l = lng * RAD
      return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]
    }
    const [x, y] = [v(a), v(b)]
    return Math.acos(Math.min(1, Math.max(-1, x[0] * y[0] + x[1] * y[1] + x[2] * y[2]))) / RAD
  }

  /** Every area ring the app actually ships. */
  const shippedRings = () => {
    const dir = 'public/data/events'
    const rings: [number, number][][] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'manifest.json') continue
      const parsed = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))
      const events = Array.isArray(parsed) ? parsed : (parsed.events ?? [])
      for (const e of events) if (Array.isArray(e?.area) && e.area.length >= 3) rings.push(e.area)
    }
    expect(rings.length).toBeGreaterThan(0)
    return rings
  }

  /** The great-circle midpoint of every edge — what the layer would interpolate. */
  const edgeMidpoints = (ring: [number, number][]) => {
    const out: [number, number][] = []
    for (let i = 1; i < ring.length; i++) {
      const mid = densifyPath([ring[i - 1], ring[i]], sepDeg(ring[i - 1], ring[i]) / 2 + 1e-9)
      if (mid.length === 3) out.push(mid[1])
    }
    return out
  }

  const ATLANTIC: [number, number][] = [
    [-50, -35], [-20, -35], [12, -10], [10, 5], [-5, 12], [-18, 15], [-70, 20], [-80, 5], [-70, -15],
  ]

  it('closes an open ring, because a footprint is authored open', () => {
    const out = areaCapRing(ATLANTIC)
    expect(out[0]).toEqual(out[out.length - 1])
  })

  it('leaves no segment longer than the layer tessellates at, so the layer adds nothing', () => {
    const out = areaCapRing(ATLANTIC)
    for (let i = 1; i < out.length; i++) {
      expect(sepDeg(out[i - 1], out[i])).toBeLessThanOrEqual(AREA_CAP_RESOLUTION_DEG + 1e-9)
    }
  })

  it('keeps every authored vertex, unmoved and in order', () => {
    const out = areaCapRing(ATLANTIC)
    let at = 0
    for (const v of ATLANTIC) {
      const found = out.findIndex((p, i) => i >= at && p[0] === v[0] && p[1] === v[1])
      expect(found).toBeGreaterThanOrEqual(at)
      at = found
    }
  })

  /**
   * How far the great-circle contour departs from the straight lng/lat edge
   * between the same two vertices — in degrees.
   *
   * This is the whole quantity that matters. The library builds the contour on
   * the first curve and judges the resulting triangles against the second, so a
   * departure comparable to a triangle's own size is a misclassified triangle.
   */
  const contourDeparture = (ring: [number, number][]) => {
    let worst = 0
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]]
      for (const m of edgeMidpoints([a, b])) {
        worst = Math.max(worst, Math.hypot(m[0] - (a[0] + b[0]) / 2, m[1] - (a[1] + b[1]) / 2))
      }
    }
    return worst
  }

  it('the authored ring puts its contour degrees away from the edge it is judged against', () => {
    // this is the bug: 1.9° of departure against a 2° triangle, so whole rows
    // of boundary triangles test "outside" and are discarded
    const departure = contourDeparture([...ATLANTIC, ATLANTIC[0]])
    expect(departure).toBeGreaterThan(AREA_CAP_RESOLUTION_DEG / 2)
  })

  it('the densified ring keeps that departure far under one triangle', () => {
    // 0.007° against the authored ring's 1.9°, and 0.4% of a cap triangle:
    // measured in degrees, because degrees are what the planar test sees, so
    // this includes the longitude stretch at high latitude
    const departure = contourDeparture(areaCapRing(ATLANTIC))
    expect(departure).toBeLessThan(AREA_CAP_RESOLUTION_DEG / 100)
  })

  it('and does so for every footprint shipped, not just the awkward one', () => {
    // The bound is looser than the Atlantic case because departure is measured
    // in degrees, and a degree of longitude is a shorter distance the further
    // from the equator it is: the worst shipped ring is a high-latitude one at
    // 0.077°, still under a twentieth of a cap triangle. What matters is the
    // ratio to the triangle, and nothing shipped comes close to it.
    for (const ring of shippedRings()) {
      expect(contourDeparture(areaCapRing(ring))).toBeLessThan(AREA_CAP_RESOLUTION_DEG / 20)
    }
  })

  it('holds for every footprint actually shipped, at the resolution actually used', () => {
    for (const ring of shippedRings()) {
      const out = areaCapRing(ring)
      for (let i = 1; i < out.length; i++) {
        expect(sepDeg(out[i - 1], out[i])).toBeLessThanOrEqual(AREA_CAP_RESOLUTION_DEG + 1e-9)
      }
    }
  })

  it('leaves a ring already finer than the resolution alone', () => {
    const tight: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
    expect(areaCapRing(tight)).toEqual([...tight, tight[0]])
  })

  it('does not invent a polygon out of a degenerate ring', () => {
    expect(areaCapRing([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]])
  })
})
