import { describe, it, expect } from 'vitest'
import { MAX_SEGMENT_DEG, allPathPoints, densifyPath, densifyPaths, isGeoPath, type GeoPath } from '../src/lib/paths'
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
