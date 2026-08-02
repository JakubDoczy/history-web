import { describe, it, expect } from 'vitest'
import {
  MARKER_SIZE_DEG,
  decorSizeDeg,
  drawingPoints,
  isDrawing,
  isDrawingSpec,
  routeDecorFor,
  type Drawing,
  type DrawingSpec,
} from '../src/lib/drawing'
import { ARROW_FRACTIONS, pointAlongPath, type GeoPath } from '../src/lib/paths'
import { separationDeg } from '../src/lib/queryIndex'

const line: GeoPath = [
  [0, 0],
  [10, 0],
]

describe('isDrawingSpec', () => {
  it('accepts one of each kind, at its minimum', () => {
    const specs: DrawingSpec[] = [
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

describe('routeDecorFor', () => {
  const outward: GeoPath = [
    [-6.35, 36.79],
    [-15.4, 28.1],
    [-59.6, 13.1],
  ]

  it('marks both ends of every route, whichever way it runs', () => {
    for (const direction of ['oneway', 'twoway'] as const) {
      const d = routeDecorFor({ paths: [outward], direction })!
      const dots = d.layers.filter((l) => l.type === 'marker' && l.style === 'dot')
      expect(dots, direction).toHaveLength(2)
      expect(dots.map((l) => (l as { pos: [number, number] }).pos)).toEqual([
        outward[0],
        outward[outward.length - 1],
      ])
    }
  })

  it('puts two chevrons on a one-way route, and none on a two-way one', () => {
    const one = routeDecorFor({ paths: [outward], direction: 'oneway' })!
    const arrows = one.layers.filter((l) => l.type === 'marker' && l.style === 'arrow')
    expect(arrows).toHaveLength(ARROW_FRACTIONS.length)
    for (const a of arrows) expect(Number.isFinite((a as { bearing?: number }).bearing)).toBe(true)

    const two = routeDecorFor({ paths: [outward], direction: 'twoway' })!
    expect(two.layers.every((l) => l.type !== 'marker' || l.style !== 'arrow')).toBe(true)
  })

  it('defaults to one-way, so a voyage that forgot to say so still points', () => {
    const d = routeDecorFor({ paths: [outward] })!
    expect(d.layers.some((l) => l.type === 'marker' && l.style === 'arrow')).toBe(true)
  })

  it('points its chevrons the way the route is travelled', () => {
    // due east along the equator: every bearing is 90
    const d = routeDecorFor({ paths: [[[0, 0], [40, 0]]], direction: 'oneway' })!
    for (const a of d.layers.filter((l) => l.type === 'marker' && l.style === 'arrow'))
      expect((a as { bearing: number }).bearing).toBeCloseTo(90, 6)
    // and reversing the route reverses them
    const back = routeDecorFor({ paths: [[[40, 0], [0, 0]]], direction: 'oneway' })!
    for (const a of back.layers.filter((l) => l.type === 'marker' && l.style === 'arrow'))
      expect((a as { bearing: number }).bearing).toBeCloseTo(270, 6)
  })

  it('places the chevrons a third and two-thirds along, by ARC LENGTH', () => {
    // A route authored with all its detail at one end: by waypoint index the
    // chevrons would cluster there; by arc length they do not.
    const lopsided: GeoPath = [
      [0, 0], [0.5, 0], [1, 0], [1.5, 0], [2, 0], [60, 0],
    ]
    const d = routeDecorFor({ paths: [lopsided], direction: 'oneway' })!
    const arrows = d.layers.filter(
      (l): l is Extract<DrawingSpec, { type: 'marker' }> => l.type === 'marker' && l.style === 'arrow',
    )
    expect(arrows[0].pos[0]).toBeCloseTo(20, 4)
    expect(arrows[1].pos[0]).toBeCloseTo(40, 4)
  })

  it('decorates every route of a network, not only the first', () => {
    const d = routeDecorFor({ paths: [outward, [[0, 0], [10, 10]], [[20, 20], [30, 30]]] })!
    expect(d.layers.filter((l) => l.type === 'marker' && l.style === 'dot')).toHaveLength(6)
    expect(d.layers.filter((l) => l.type === 'marker' && l.style === 'arrow')).toHaveLength(6)
  })

  it('has nothing to say about an event with no routes', () => {
    expect(routeDecorFor({})).toBeUndefined()
    expect(routeDecorFor({ paths: [] })).toBeUndefined()
    // a "route" of one point is not a route
    expect(routeDecorFor({ paths: [[[0, 0]] as unknown as GeoPath] })).toBeUndefined()
  })
})

describe('decorSizeDeg', () => {
  it('scales with the route, and stays inside its bounds', () => {
    const hop = decorSizeDeg([[[0, 0], [1, 0]]])
    const ocean = decorSizeDeg([[[-6, 36], [-60, 13]]])
    const world = decorSizeDeg([[[-70, -53], [120, 10]]])
    expect(hop).toBeLessThan(ocean)
    expect(ocean).toBeLessThan(world)
    for (const s of [hop, ocean, world]) {
      expect(s).toBeGreaterThanOrEqual(0.4)
      expect(s).toBeLessThanOrEqual(1.8)
    }
    // a glyph is never so big it stops being a glyph
    expect(world).toBeLessThan(MARKER_SIZE_DEG * 4)
  })

  it('never gives a zero-length route a zero-size glyph', () => {
    expect(decorSizeDeg([[[5, 5], [5, 5]]])).toBeGreaterThan(0)
  })
})

describe('the chevrons agree with the dashes', () => {
  /**
   * The dash animation runs from the first waypoint to the last (three-globe
   * advances `dashOffset` in that direction on a fat line), and the chevrons are
   * placed on the same forward tangent. If either flipped, a route would say two
   * opposite things at once — so this pins the shared assumption.
   */
  it('faces the direction travel is going at each chevron', () => {
    const route: GeoPath = [
      [-9.14, 38.7],
      [-17.5, 14.7],
      [18.4, -34.0],
    ]
    for (const t of ARROW_FRACTIONS) {
      const at = pointAlongPath(route, t)!
      const ahead = pointAlongPath(route, Math.min(1, t + 0.05))!
      // the point a little further along the route is roughly where the chevron
      // is pointing
      const forward = separationDeg(at.lat, at.lng, ahead.lat, ahead.lng)
      expect(forward).toBeGreaterThan(0)
      const dLng = ahead.lng - at.lng
      const dLat = ahead.lat - at.lat
      const bearingAhead =
        (Math.atan2(dLng * Math.cos((at.lat * Math.PI) / 180), dLat) * 180) / Math.PI
      const diff = Math.abs((((at.bearing - bearingAhead + 540) % 360) - 180))
      expect(diff, `t=${t}`).toBeLessThan(20)
    }
  })
})
