import { describe, it, expect } from 'vitest'
import {
  drawingPoints,
  isDrawing,
  isDrawingSpec,
  routeDrawingFor,
  type Drawing,
  type DrawingSpec,
} from '../src/lib/drawing'
import { type GeoPath } from '../src/lib/paths'

const line: GeoPath = [
  [0, 0],
  [10, 0],
]

describe('isDrawingSpec', () => {
  it('accepts one of each kind, at its minimum', () => {
    const specs: DrawingSpec[] = [
      { type: 'route', paths: [line] },
      { type: 'frontline', paths: [line] },
      { type: 'thrust', path: line },
      { type: 'marker', pos: [5, 5] },
      { type: 'label', pos: [5, 5], text: 'Minsk' },
    ]
    for (const s of specs) expect(isDrawingSpec(s), s.type).toBe(true)
  })

  it('accepts every optional field the schema documents', () => {
    expect(
      isDrawingSpec({
        type: 'frontline',
        paths: [line, line],
        dash: 'dashed',
        width: 3,
        color: '#e5484d',
        at: 1941,
        label: 'Front, December',
      }),
    ).toBe(true)
    expect(isDrawingSpec({ type: 'thrust', path: line, width: 0.6, taper: false })).toBe(true)
    expect(isDrawingSpec({ type: 'marker', pos: [1, 2], style: 'arrow', bearing: 91, size: 0.4 })).toBe(true)
    expect(isDrawingSpec({ type: 'label', pos: [1, 2], text: 'Caen', size: 'md' })).toBe(true)
  })

  it('rejects what a typo produces', () => {
    const bad: unknown[] = [
      null,
      42,
      { type: 'frontline' }, // no paths
      { type: 'frontline', paths: [] }, // empty
      { type: 'frontline', paths: [[[0, 0]]] }, // one point is not a line
      { type: 'frontline', paths: [line], dash: 'dotted' },
      { type: 'thrust', path: [[0, 0]] },
      { type: 'thrust', path: line, taper: 'yes' },
      { type: 'marker', pos: [200, 0] }, // off the planet
      { type: 'marker', pos: [0, 0], style: 'chevron' },
      { type: 'marker', pos: [0, 0], size: 0 }, // a marker with no size is not drawn
      { type: 'label', pos: [0, 0] }, // no text
      { type: 'label', pos: [0, 0], text: '' },
      { type: 'label', pos: [0, 0], text: 'x', size: 'xl' },
      { type: 'battleplan', paths: [line] },
      { type: 'frontline', paths: [line], at: 'later' },
    ]
    for (const b of bad) expect(isDrawingSpec(b), JSON.stringify(b)).toBe(false)
  })

  it('catches the coordinate order mistake it exists for', () => {
    // [lat, lng] for Moscow: 55.75 is not a longitude problem, but 37.62 as a
    // latitude is legal too — the pair that breaks is the one out of range
    expect(isDrawingSpec({ type: 'marker', pos: [55.75, 137.62] })).toBe(false)
    expect(isDrawingSpec({ type: 'frontline', paths: [[[50, 30], [50, 137.62]]] })).toBe(false)
  })
})

describe('isDrawing', () => {
  it('needs a non-empty layer list where every layer is drawable', () => {
    expect(isDrawing({ layers: [{ type: 'marker', pos: [0, 0] }] })).toBe(true)
    expect(isDrawing({ layers: [] })).toBe(false)
    expect(isDrawing({})).toBe(false)
    expect(isDrawing(undefined)).toBe(false)
    expect(isDrawing({ layers: [{ type: 'marker', pos: [0, 0] }, { type: 'nope' }] })).toBe(false)
  })
})

describe('drawingPoints', () => {
  it('collects every coordinate of every kind of layer', () => {
    const d: Drawing = {
      layers: [
        { type: 'frontline', paths: [[[1, 1], [2, 2]], [[3, 3], [4, 4]]] },
        { type: 'thrust', path: [[5, 5], [6, 6]] },
        { type: 'marker', pos: [7, 7] },
        { type: 'label', pos: [8, 8], text: 'x' },
      ],
    }
    expect(drawingPoints(d)).toEqual([
      [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8],
    ])
    expect(drawingPoints(undefined)).toEqual([])
  })
})

describe('routeDrawingFor', () => {
  const outward: GeoPath = [
    [-6.35, 36.79],
    [-15.4, 28.1],
    [-59.6, 13.1],
  ]

  it('draws the route itself, carrying the AUTHORED waypoints and the direction', () => {
    for (const direction of ['oneway', 'twoway'] as const) {
      const d = routeDrawingFor({ paths: [outward], direction })!
      const routes = d.layers.filter(
        (l): l is Extract<DrawingSpec, { type: 'route' }> => l.type === 'route',
      )
      expect(routes, direction).toHaveLength(1)
      // not a smoothed or densified polyline: the curve is the renderer's job,
      // so the spec stays the thing the data actually said
      expect(routes[0].paths).toEqual([outward])
      expect(routes[0].direction).toBe(direction)
    }
  })

  it('defaults to one-way, so a voyage that forgot to say so still points', () => {
    const d = routeDrawingFor({ paths: [outward] })!
    const route = d.layers.find((l) => l.type === 'route') as Extract<
      DrawingSpec,
      { type: 'route' }
    >
    expect(route.direction).toBe('oneway')
  })

  it('puts no glyph on anything: the line is the whole drawing', () => {
    // Ports and direction used to be `marker` layers generated here — dots at
    // the termini, chevrons a third and two-thirds along. Both are gone: a
    // marker is sized in degrees of arc, which is the wrong unit for a symbol on
    // a map, and the renderer draws the ports in pixels as part of the line.
    for (const direction of ['oneway', 'twoway'] as const) {
      const d = routeDrawingFor({ paths: [outward], direction })!
      expect(d.layers.every((l) => l.type === 'route'), direction).toBe(true)
    }
  })

  it('draws every route of a network, not only the first', () => {
    const d = routeDrawingFor({ paths: [outward, [[0, 0], [10, 10]], [[20, 20], [30, 30]]] })!
    const route = d.layers.find((l) => l.type === 'route') as Extract<
      DrawingSpec,
      { type: 'route' }
    >
    expect(route.paths).toHaveLength(3)
  })

  it('is a valid drawing, so the renderer needs no special case for it', () => {
    expect(isDrawing(routeDrawingFor({ paths: [outward] }))).toBe(true)
  })

  it('has nothing to say about an event with no routes', () => {
    expect(routeDrawingFor({})).toBeUndefined()
    expect(routeDrawingFor({ paths: [] })).toBeUndefined()
    // a "route" of one point is not a route
    expect(routeDrawingFor({ paths: [[[0, 0]] as unknown as GeoPath] })).toBeUndefined()
  })
})

describe('drawingPoints reaches a route', () => {
  /**
   * `geometryPointsOf` frames the camera on everything a drawing occupies, and a
   * route drawing IS the drawing for a path event. If its waypoints were not
   * reachable here, "Show on map" would fit the camera to the terminus dots and
   * cut the middle of the voyage out of frame.
   */
  it('counts every waypoint of every route', () => {
    const d = routeDrawingFor({
      paths: [
        [
          [0, 0],
          [10, 5],
          [20, 0],
        ],
      ],
    })!
    const pts = drawingPoints(d)
    for (const p of [[0, 0], [10, 5], [20, 0]])
      expect(pts.some((q) => q[0] === p[0] && q[1] === p[1]), `${p}`).toBe(true)
  })
})
