import { describe, it, expect } from 'vitest'
import {
  MAX_SEGMENT_DEG,
  ROUTE_STYLE,
  allPathPoints,
  bearingDeg,
  densifyPath,
  densifyPaths,
  directionOf,
  isGeoPath,
  pathTermini,
  pointAlongPath,
  slerpPoint,
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

describe('densifyPaths and allPathPoints', () => {
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

  it('flattens every point of every route', () => {
    expect(allPathPoints(routes)).toEqual([
      [0, 0],
      [40, 0],
      [10, 10],
      [11, 11],
    ])
    expect(allPathPoints([])).toEqual([])
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

describe('bearingDeg', () => {
  it('reads the cardinal directions off the equator and the meridian', () => {
    expect(bearingDeg([0, 0], [10, 0])).toBeCloseTo(90, 6)
    expect(bearingDeg([0, 0], [-10, 0])).toBeCloseTo(270, 6)
    expect(bearingDeg([0, 0], [0, 10])).toBeCloseTo(0, 6)
    expect(bearingDeg([0, 10], [0, 0])).toBeCloseTo(180, 6)
  })

  it('is always in [0, 360)', () => {
    for (const [a, b] of [
      [[-179, 10], [179, 10]],
      [[179, -10], [-179, -20]],
      [[0, 89], [180, 89]],
    ] as [[number, number], [number, number]][]) {
      const d = bearingDeg(a, b)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(360)
    }
  })

  it('curves with the great circle: a high-latitude eastward leg starts north of east', () => {
    // London to Moscow really does begin on a north-easterly heading
    expect(bearingDeg([-0.13, 51.51], [37.62, 55.75])).toBeLessThan(90)
    expect(bearingDeg([-0.13, 51.51], [37.62, 55.75])).toBeGreaterThan(45)
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

describe('pointAlongPath', () => {
  const equator: GeoPath = [
    [0, 0],
    [30, 0],
    [60, 0],
  ]

  it('walks by arc length, not by waypoint', () => {
    // half the waypoints are in the first tenth of this route
    const lopsided: GeoPath = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [100, 0],
    ]
    expect(pointAlongPath(lopsided, 0.5)!.lng).toBeCloseTo(50, 4)
    expect(pointAlongPath(equator, 0.5)!.lng).toBeCloseTo(30, 4)
    expect(pointAlongPath(equator, 0.25)!.lng).toBeCloseTo(15, 4)
  })

  it('clamps to the ends and carries the end segment"s heading there', () => {
    expect(pointAlongPath(equator, 0)).toMatchObject({ lng: 0, lat: 0, bearing: 90 })
    const end = pointAlongPath(equator, 1)!
    expect(end.lng).toBeCloseTo(60, 6)
    expect(pointAlongPath(equator, -3)!.lng).toBeCloseTo(0, 6)
    expect(pointAlongPath(equator, 9)!.lng).toBeCloseTo(60, 6)
  })

  it('gives the heading of the leg it landed on, not of the whole route', () => {
    const bent: GeoPath = [
      [0, 0],
      [20, 0], // due east
      [20, 20], // then due north
    ]
    expect(pointAlongPath(bent, 0.2)!.bearing).toBeCloseTo(90, 3)
    expect(pointAlongPath(bent, 0.9)!.bearing).toBeCloseTo(0, 3)
  })

  it('has nothing to report for a route that is not one', () => {
    expect(pointAlongPath([], 0.5)).toBeUndefined()
    expect(pointAlongPath([[1, 1]], 0.5)).toBeUndefined()
  })

  it('survives a route whose waypoints are all the same place', () => {
    const still = pointAlongPath(
      [
        [5, 5],
        [5, 5],
      ],
      0.5,
    )!
    expect(still.lng).toBe(5)
    expect(still.lat).toBe(5)
  })

  it('stays on the route it is walking', () => {
    const atlantic: GeoPath = [
      [-6.35, 36.79],
      [-15.4, 28.1],
      [-59.6, 13.1],
      [-77.0, 18.0],
    ]
    const drawn = densifyPath(atlantic)
    for (const t of [0.1, 1 / 3, 0.5, 2 / 3, 0.9]) {
      const p = pointAlongPath(atlantic, t)!
      const nearest = Math.min(
        ...drawn.map(([lng, lat]) => separationDeg(p.lat, p.lng, lat, lng)),
      )
      expect(nearest, `t=${t}`).toBeLessThan(MAX_SEGMENT_DEG)
    }
  })
})

describe('pathTermini', () => {
  it('takes the first and last point of every route, in order', () => {
    expect(
      pathTermini([
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        [
          [10, 10],
          [11, 11],
        ],
      ]),
    ).toEqual([
      [0, 0],
      [2, 2],
      [10, 10],
      [11, 11],
    ])
  })

  it('ignores anything that is not a route', () => {
    expect(pathTermini([[[5, 5]] as unknown as GeoPath])).toEqual([])
  })
})

describe('ROUTE_STYLE', () => {
  it('keeps the halo wider than the line it sits under', () => {
    expect(ROUTE_STYLE.haloStroke).toBeGreaterThan(ROUTE_STYLE.stroke)
    expect(ROUTE_STYLE.haloAlt).toBeLessThan(ROUTE_STYLE.lineAlt)
    // …and both clear of the area cap (0.012), which they draw over
    expect(ROUTE_STYLE.haloAlt).toBeGreaterThan(0.012)
  })

  it('gives a one-way route more line than gap, and a two-way one an even split', () => {
    expect(ROUTE_STYLE.dash / (ROUTE_STYLE.dash + ROUTE_STYLE.gap)).toBeGreaterThan(0.625)
    expect(ROUTE_STYLE.evenDash).toBe(ROUTE_STYLE.evenGap)
  })

  it('runs the dash fast enough to read as flowing, slow enough to stay calm', () => {
    // a dash crosses the whole route in this long; under a second is a strobe,
    // over about five is the creep this replaced
    expect(ROUTE_STYLE.animateMs).toBeGreaterThan(1500)
    expect(ROUTE_STYLE.animateMs).toBeLessThan(5000)
  })
})
