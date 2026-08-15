import { describe, it, expect } from 'vitest'
import { Scene } from 'three'
import {
  FRONTIER_BUILD_ALT,
  FrontierLayer,
  LINE_FLOOR,
  DASH_DEG,
  GAP_DEG,
  SKETCH_DASH_DEG,
  SKETCH_GAP_DEG,
  sketchPathsOf,
  solidPathsOf,
} from '../src/lib/frontierLayer'
import {
  GLOBE_FACET_DEG,
  MIN_LIFT,
  SURFACE_ALT,
  groundFactor,
  inkLift,
} from '../src/lib/drawingLayer'
import type { InkEntry, Nation, Ring } from '../src/lib/nations'

/**
 * ROUND 63b — THE POLITICAL INK IS ON THE GROUND.
 *
 * The frontier layer had the drawings' round-63a defect at twice the size: a
 * fixed 0.0013 R (8.3 km) altitude on ink drawn on an ideal sphere the rendered
 * planet is only inscribed in, which measured 13.4 km of hover and 126 px of
 * slide against a 40 km frame on the Germany/Poland line
 * (tests/e2e/repro63.e2e.mjs, `SECTIONS=frontier`).
 *
 * What is asserted here is the three halves of the one policy, on the layer's
 * real output rather than on a model of it: every vertex on the RENDERED
 * planet's radius, every chord inside one facet, and the height a function of
 * the camera applied without touching a vertex.
 */

const RAD = Math.PI / 180
const R = 100

const nation = { id: 'x', name: 'X', color: '#ffffff' } as unknown as Nation

const entryOf = (paths: Ring[], kind: 'full' | 'contested' = 'full'): InkEntry =>
  ({
    nation,
    kind,
    ring: paths[0],
    coordinates: paths,
    frontier: paths,
    sketch: [],
    coast: [],
    label: 'X',
  }) as unknown as InkEntry

const build = (paths: Ring[], kind: 'full' | 'contested' = 'full') => {
  const layer = new FrontierLayer(new Scene(), R)
  layer.set([entryOf(paths, kind)], () => '#ffffff', () => 'all')
  return layer
}

/** Every vertex of the built buffer, in the layer's own local space. */
const verticesOf = (layer: FrontierLayer) => {
  const p = layer.object.geometry.getAttribute('position')
  const out: [number, number, number][] = []
  for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)])
  return out
}

/** …and where each of them says it is, in degrees. */
const geoOf = (v: [number, number, number]): [number, number] => {
  const len = Math.hypot(v[0], v[1], v[2])
  return [Math.atan2(v[0], v[2]) / RAD, Math.asin(v[1] / len) / RAD]
}

/**
 * How far above the RENDERED planet a point is, in globe radii. Negative means
 * the planet eats it — which is the one answer no vertex and no midpoint of any
 * chord may give.
 */
const clearance = (v: [number, number, number]): number => {
  const [lng, lat] = geoOf(v)
  return Math.hypot(v[0], v[1], v[2]) / R - groundFactor(lng, lat)
}

describe('the political ink sits on the planet that is drawn', () => {
  // A line straight through the middle of a facet, touching no fold at all.
  const inside: Ring = [
    [1, 1],
    [2, 1.4],
    [3, 1.1],
  ]
  // …and one that crosses several, in both directions. Latitude folds are at
  // 90 - 4k, i.e. at 2 deg either side of the equator; longitude folds at 4k.
  // Not a 45-degree diagonal: on that slope every latitude fold falls on a
  // longitude fold and the cut count halves, which would make the test agree
  // with a `splitAtFacets` that only looked one way.
  const across: Ring = [
    [-1, -3],
    [9, 5.5],
  ]

  /**
   * The dip of a chord below the planet, sampled along it. In globe radii, and
   * positive means the ink is in the air where it belongs.
   *
   * Positions are float32, so a vertex placed exactly on a fold reads back a
   * hundred-thousandth of a degree off it — which is why this asks the question
   * the layer actually cares about (is any part of this line underground?)
   * rather than the arithmetic one (`crossesFold` on the recovered lng/lat),
   * whose epsilon is nine decimal places tighter than the buffer it would be
   * reading.
   */
  const chordClearance = (
    a: [number, number, number],
    b: [number, number, number],
  ): number => {
    let worst = Infinity
    for (let k = 1; k < 8; k++) {
      const t = k / 8
      worst = Math.min(
        worst,
        clearance([
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ]),
      )
    }
    return worst
  }

  it('puts every vertex on the rendered planet, not on the sphere it is inscribed in', () => {
    const layer = build([across])
    for (const v of verticesOf(layer)) {
      const [lng, lat] = geoOf(v)
      const want = R * (groundFactor(lng, lat) + FRONTIER_BUILD_ALT)
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(want, 5)
    }
    layer.dispose()
  })

  it('leaves the ink hovering by the lift and nothing else', () => {
    // The point of grounding: the hover is the lift, everywhere, rather than
    // the lift plus up to 7.8 km of facet dip. Measured at the facet CENTRES,
    // which is where the old scheme was worst — longitude folds fall on
    // multiples of four and latitude folds two degrees off them (90 - 4k), so
    // the middle of a facet is (4j + 2, 4k).
    const mids: Ring = []
    for (let k = 0; k < 8; k++) mids.push([k * GLOBE_FACET_DEG + 2, k * GLOBE_FACET_DEG])
    const layer = build([mids])
    for (const v of verticesOf(layer)) expect(clearance(v)).toBeCloseTo(FRONTIER_BUILD_ALT, 7)
    layer.dispose()
  })

  it('cuts a border at every fold it crosses, so no chord dips under a ridge', () => {
    const layer = build([across])
    const vs = verticesOf(layer)
    expect(vs.length).toBeGreaterThan(2)
    // GL_LINES: pairs. Every chord lies in one facet plane, so it hangs at the
    // build altitude along its whole length rather than sagging away from its
    // ends — within a hair, which is the float32 buffer and the sliver where
    // the cut lands on the neighbouring plane.
    for (let i = 0; i + 1 < vs.length; i += 2)
      expect(chordClearance(vs[i], vs[i + 1])).toBeGreaterThan(FRONTIER_BUILD_ALT * 0.99)
    layer.dispose()
  })

  it('is the cut that buys it, and the uncut chord shows what it cost', () => {
    // The same line WITHOUT the cut: one chord from end to end, whose middle
    // passes under the ridges it crosses. This is what every border on the
    // globe was doing before round 63b, paid for out of the eight kilometres
    // the ink used to be lifted by.
    const [a, b] = across.map((p) => {
      const g = groundFactor(p[0], p[1]) + FRONTIER_BUILD_ALT
      const c = Math.cos(p[1] * RAD)
      return [
        c * Math.sin(p[0] * RAD) * R * g,
        Math.sin(p[1] * RAD) * R * g,
        c * Math.cos(p[0] * RAD) * R * g,
      ] as [number, number, number]
    })
    // Deep enough to eat the ink at any lift this policy ever hands out.
    expect(chordClearance(a, b)).toBeLessThan(-2e-4)
  })

  it('costs the cut only where there is a fold to cut at', () => {
    const plain = build([inside])
    const cut = build([across])
    // Three points inside one facet are two segments and four vertices: nothing
    // was inserted.
    expect(verticesOf(plain).length).toBe(4)
    // …and one edge across ten degrees of longitude and eight and a half of
    // latitude meets five folds — three of longitude, two of latitude — so it
    // comes out as six segments rather than one.
    expect(verticesOf(cut).length).toBe(6 * 2)
    plain.dispose()
    cut.dispose()
  })

  it('cuts a DASH at the folds too, so a dashed border cannot sink either', () => {
    const layer = build([across], 'contested')
    const vs = verticesOf(layer)
    expect(vs.length).toBeGreaterThan(0)
    for (let i = 0; i + 1 < vs.length; i += 2)
      expect(chordClearance(vs[i], vs[i + 1])).toBeGreaterThan(FRONTIER_BUILD_ALT * 0.99)
    layer.dispose()
  })

  it('leaves the dash period alone when it cuts the path under it', () => {
    // The cut inserts points ON the polyline, so the pattern measured in
    // degrees of ground is the pattern that was there before. A ten-degree run
    // crossing three folds still comes out at the declared duty cycle.
    const layer = build([across], 'contested')
    const vs = verticesOf(layer)
    let ink = 0
    for (let i = 0; i + 1 < vs.length; i += 2) {
      const a = geoOf(vs[i])
      const b = geoOf(vs[i + 1])
      ink += Math.hypot((b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180), b[1] - a[1])
    }
    const total = Math.hypot(10 * Math.cos((1.25 * Math.PI) / 180), 8.5)
    expect(ink / total).toBeCloseTo(DASH_DEG / (DASH_DEG + GAP_DEG), 1)
    layer.dispose()
  })
})

/**
 * ROUND 64 — A SKETCHED FRONTIER IS DASHED. An `approx` polity's estimated
 * inland edges arrive on the entry as `sketch` paths, and the layer draws them
 * as a broken line in the polity's own pen — a longer dash than the dispute
 * pattern, so an estimate and a contested line read as different statements.
 */
describe('the sketch dashes', () => {
  const across: Ring = [
    [-1, -3],
    [9, 5.5],
  ]
  const sketchEntry = (paths: Ring[], sketch: Ring[]): InkEntry =>
    ({
      nation,
      kind: 'full',
      ring: paths[0] ?? sketch[0],
      coordinates: [...paths, ...sketch],
      frontier: paths,
      sketch,
      coast: [],
      label: 'X',
    }) as unknown as InkEntry

  const inkLength = (layer: FrontierLayer) => {
    const vs = verticesOf(layer)
    let ink = 0
    for (let i = 0; i + 1 < vs.length; i += 2) {
      const a = geoOf(vs[i])
      const b = geoOf(vs[i + 1])
      ink += Math.hypot((b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180), b[1] - a[1])
    }
    return ink
  }

  it('draws the sketch at the sketch duty cycle, in the same buffer', () => {
    const layer = new FrontierLayer(new Scene(), R)
    layer.set([sketchEntry([], [across])], () => '#ffffff', () => 'frontier')
    const total = Math.hypot(10 * Math.cos((1.25 * Math.PI) / 180), 8.5)
    expect(inkLength(layer) / total).toBeCloseTo(SKETCH_DASH_DEG / (SKETCH_DASH_DEG + SKETCH_GAP_DEG), 1)
    layer.dispose()
  })

  it('reads as a different pen from a dispute: a longer dash, a fuller line', () => {
    expect(SKETCH_DASH_DEG).toBeGreaterThan(DASH_DEG)
    expect(SKETCH_DASH_DEG / (SKETCH_DASH_DEG + SKETCH_GAP_DEG)).toBeGreaterThan(DASH_DEG / (DASH_DEG + GAP_DEG))
  })

  it('dashes the sketch on the photograph too, without doubling it under a solid loop', () => {
    const solid: Ring = [
      [20, 0],
      [30, 8.5],
    ]
    const entry = sketchEntry([solid], [across])
    // On 'all' the solid paths are coast+frontier rather than the closed
    // coordinates, precisely so the sketch is not also drawn solid underneath.
    expect(solidPathsOf(entry, 'all')).toEqual([solid])
    expect(sketchPathsOf(entry, 'all')).toEqual([across])
    // …and an entry that yielded its ink dashes nothing.
    expect(sketchPathsOf(entry, 'none')).toEqual([])
    expect(sketchPathsOf(entry, 'coast')).toEqual([])
  })

  it('never dashes a contested zone twice: its outline is already the dispute dash', () => {
    const entry = { ...sketchEntry([], [across]), kind: 'contested' } as InkEntry
    expect(sketchPathsOf(entry, 'frontier')).toEqual([])
  })
})

describe('how high the political ink rides', () => {
  const path: Ring = [
    [1, 1],
    [2, 1.4],
  ]

  it('tracks the camera without rebuilding a vertex', () => {
    const layer = build([path])
    const before = verticesOf(layer)
    layer.setCameraAltitude(0.00658) // a 40 km frame
    const after = verticesOf(layer)
    // The buffer is untouched: the height is a scale on one object, which is
    // what makes this affordable on every camera event of every gesture.
    expect(after).toEqual(before)
    expect(layer.object.scale.x).toBeCloseTo(
      (1 + inkLift(0.00658, LINE_FLOOR)) / (1 + FRONTIER_BUILD_ALT),
      9,
    )
    layer.dispose()
  })

  it('lands the ink at the lift the one policy asks for, at every zoom', () => {
    for (const alt of [2.5, 0.5, 0.0834, 0.0168, 0.00658, 1e-4]) {
      const layer = build([path])
      layer.setCameraAltitude(alt)
      const s = layer.object.scale.x
      for (const v of verticesOf(layer)) {
        const lifted: [number, number, number] = [v[0] * s, v[1] * s, v[2] * s]
        // A uniform scale is exact only for a vertex at radius 1, and a grounded
        // vertex is at `groundFactor`, up to 0.12% under it. The error works out
        // to exactly `dip · (builtAlt - want)`, which is NEVER NEGATIVE — the
        // lift is capped at the build altitude — so the slack is always in the
        // safe direction, and it is at most 0.0012 · 0.0006 R, four and a half
        // metres, at the deepest zoom where the lift itself is smallest.
        const err = clearance(lifted) - inkLift(alt, LINE_FLOOR)
        // …to within the buffer's own float32, which is a relative 6e-8 on a
        // radius of a hundred scene units.
        expect(err).toBeGreaterThan(-1e-7)
        expect(err).toBeLessThan(0.0013 * FRONTIER_BUILD_ALT)
      }
      layer.dispose()
    }
  })

  it('answers false when the camera has not moved enough to matter', () => {
    const layer = build([path])
    expect(layer.setCameraAltitude(0.02)).toBe(true)
    expect(layer.setCameraAltitude(0.02)).toBe(false)
    // …and the 2% epsilon, which is what keeps OrbitControls' damping from
    // buying a frame per digit.
    expect(layer.setCameraAltitude(0.0201)).toBe(false)
    expect(layer.setCameraAltitude(0.05)).toBe(true)
    layer.dispose()
  })

  it('floors the lift where a GL_LINE has no polygon offset to fall back on', () => {
    // A fat line is triangles and carries `polygonOffset`, so the DrawingLayer
    // can lift by MIN_LIFT. This layer is GL_LINES and WebGL has no polygon
    // offset for them, so it floors at the width of the sliver where the cut
    // lands on the wrong facet's plane.
    expect(LINE_FLOOR).toBeGreaterThan(MIN_LIFT)
    expect(inkLift(1e-6, LINE_FLOOR)).toBe(LINE_FLOOR)
    // …and the floor is a floor, not a habit: it is out of the way by the time
    // a reader is looking at a country.
    expect(inkLift(0.00658, LINE_FLOOR)).toBeGreaterThan(LINE_FLOOR * 5)
    expect(inkLift(2.5, LINE_FLOOR)).toBe(SURFACE_ALT)
  })
})
