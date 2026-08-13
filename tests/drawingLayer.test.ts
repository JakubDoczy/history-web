import { describe, it, expect } from 'vitest'
import { BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import {
  DrawingLayer,
  FRONTLINE_TICKS,
  MARK_CASING_OUTSET,
  SURFACE_ALT,
  ZONE_MAX_TRIANGLES,
  capGeometry,
  drawingExtentDeg,
  glyphShape,
  headOf,
  offsetPoint,
  ribbonGeometry,
  tangentFrame,
  tickSegments,
  trimEnd,
} from '../src/lib/drawingLayer'
import { ZONE_FILL_OPACITY, type Drawing } from '../src/lib/drawing'
import { ROUTE_STYLE, densifyPath, flowPhase, routePolyline, type GeoPath } from '../src/lib/paths'
import {
  MARK_CASING_DARK,
  MARK_CASING_PAPER,
  STROKE_CASING,
  markInk,
} from '../src/lib/present/ink'
import { PAPER } from '../src/lib/drawnTile'

const R = 100

/**
 * three-globe's own `polar2Cartesian`, copied. Every vertex this layer produces
 * has to land on the same sphere the pins and the routes do, and the only way to
 * assert that is against the formula they use — a drawing that is plausibly
 * shaped and 90° out is exactly the failure this catches.
 */
const globeCoords = (lat: number, lng: number, alt = 0) => {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((90 - lng) * Math.PI) / 180
  const r = R * (1 + alt)
  return new Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  )
}

describe('tangentFrame', () => {
  it('is orthonormal everywhere, poles included', () => {
    for (const [lng, lat] of [
      [0, 0],
      [37.6, 55.7],
      [-74.7, 40.3],
      [180, 0],
      [0, 90],
      [0, -90],
      [123, 89.999],
    ]) {
      const { up, east, north } = tangentFrame(lng, lat)
      for (const v of [up, east, north]) expect(Math.hypot(...v), `${lng},${lat}`).toBeCloseTo(1, 9)
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      expect(dot(up, east), `${lng},${lat}`).toBeCloseTo(0, 9)
      expect(dot(up, north), `${lng},${lat}`).toBeCloseTo(0, 9)
      expect(dot(east, north), `${lng},${lat}`).toBeCloseTo(0, 9)
    }
  })

  it('points east at increasing longitude and north at increasing latitude', () => {
    const { east, north } = tangentFrame(20, 30)
    const here = globeCoords(30, 20).normalize()
    const eastward = globeCoords(30, 20.01).normalize().sub(here).normalize()
    const northward = globeCoords(30.01, 20).normalize().sub(here).normalize()
    expect(new Vector3(...east).dot(eastward)).toBeGreaterThan(0.999)
    expect(new Vector3(...north).dot(northward)).toBeGreaterThan(0.999)
  })
})

describe('offsetPoint', () => {
  it('lands on the globe.gl sphere at the right radius', () => {
    const p = offsetPoint(30, 45, 0, 0, R, 0.02)
    expect(Math.hypot(...p)).toBeCloseTo(R * 1.02, 6)
    expect(new Vector3(...p).distanceTo(globeCoords(45, 30, 0.02))).toBeLessThan(1e-6)
  })

  it('moves a degree east as a degree east', () => {
    const p = new Vector3(...offsetPoint(30, 0, 1, 0, R, 0))
    // one degree of longitude at the equator, to within the small-angle error
    expect(p.angleTo(globeCoords(0, 31)) * (180 / Math.PI)).toBeLessThan(0.02)
  })

  it('moves a degree north as a degree north, at any latitude', () => {
    for (const lat of [0, 45, 70]) {
      const p = new Vector3(...offsetPoint(10, lat, 0, 1, R, 0))
      expect(p.angleTo(globeCoords(lat + 1, 10)) * (180 / Math.PI), `lat ${lat}`).toBeLessThan(0.02)
    }
  })
})

describe('glyphShape', () => {
  it('gives every style a closed outline that fits its unit radius', () => {
    for (const style of ['dot', 'cross', 'star', 'arrow'] as const) {
      const parts = glyphShape(style)
      expect(parts.length, style).toBeGreaterThan(0)
      for (const poly of parts) {
        expect(poly.length, style).toBeGreaterThanOrEqual(3)
        for (const [x, y] of poly) expect(Math.hypot(x, y), style).toBeLessThanOrEqual(1.2)
      }
    }
  })

  it('makes the chevron point north before it is turned', () => {
    const [tip] = glyphShape('arrow')[0]
    expect(tip[0]).toBeCloseTo(0, 9)
    expect(tip[1]).toBeGreaterThan(0.5)
  })

  it('makes the battle cross an X and not a plus', () => {
    // a plus has vertices on the axes; an X has them on the diagonals
    const onAxis = glyphShape('cross')
      .flat()
      .filter(([x, y]) => Math.abs(x) < 1e-6 || Math.abs(y) < 1e-6)
    expect(onAxis).toHaveLength(0)
  })

  /**
   * ROUND 52 — the casing outset, which is what makes a small mark findable.
   *
   * The property that matters is not "the casing is bigger": a uniformly scaled
   * X is bigger and leaves no rim along its bars, because the bars scale with
   * it. What is asserted is that the outset shape CONTAINS the glyph with real
   * clearance in every direction a mark can be looked at from.
   *
   * HALF the outset is the floor rather than all of it, because the cross grows
   * anisotropically on purpose (`CROSS_CASING_BAR`): its arms take the whole
   * outset and its bars take 55% of it, which is what keeps a cased X an X.
   */
  it('grows every glyph outward by the outset, bars included', () => {
    for (const style of ['dot', 'cross', 'star', 'arrow'] as const) {
      const plain = glyphShape(style)
      const cased = glyphShape(style, MARK_CASING_OUTSET)
      expect(cased.length, style).toBe(plain.length)
      // sixteen directions round the glyph: how far the outline reaches each way
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        const reach = (parts: [number, number][][]) =>
          Math.max(...parts.flat().map(([x, y]) => x * Math.cos(a) + y * Math.sin(a)))
        expect(reach(cased) - reach(plain), `${style} @ ${k}`).toBeGreaterThan(
          MARK_CASING_OUTSET * 0.5,
        )
      }
    }
  })
})

describe('trimEnd', () => {
  const path: GeoPath = [
    [0, 0],
    [10, 0],
    [20, 0],
  ]

  it('takes the head length off the end and leaves the rest alone', () => {
    const out = trimEnd(path, 4)
    expect(out[0]).toEqual([0, 0])
    expect(out[out.length - 1][0]).toBeCloseTo(16, 3)
  })

  it('eats whole segments when the head is longer than one', () => {
    const out = trimEnd(path, 14)
    expect(out[out.length - 1][0]).toBeCloseTo(6, 3)
  })

  it('always leaves a line, even when the head would swallow the spine', () => {
    const out = trimEnd(path, 999)
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[0]).toEqual([0, 0])
  })

  it('is a copy, not a mutation of the caller"s path', () => {
    const original: GeoPath = [
      [0, 0],
      [10, 0],
    ]
    trimEnd(original, 3)
    expect(original).toEqual([
      [0, 0],
      [10, 0],
    ])
  })
})

describe('headOf', () => {
  it('reads the bearing off the LAST segment, so a curved axis points where it ended', () => {
    // east along the equator, then hard north
    const bent: GeoPath = [
      [0, 0],
      [10, 0],
      [10, 10],
    ]
    const head = headOf(bent)
    expect(head.lng).toBe(10)
    expect(head.lat).toBe(10)
    expect(head.bearing).toBeCloseTo(0, 3) // north, not the 90 the first leg had
    expect(headOf([[0, 0], [10, 0]]).bearing).toBeCloseTo(90, 3)
  })
})

describe('ribbonGeometry', () => {
  const path: GeoPath = [
    [0, 0],
    [5, 0],
    [10, 0],
  ]

  it('builds two vertices per point and two triangles per segment', () => {
    const g = ribbonGeometry(path, () => 0.5, R, 0)
    expect(g.getAttribute('position').count).toBe(path.length * 2)
    expect(g.getIndex()!.count).toBe((path.length - 1) * 6)
  })

  it('puts the two edges the stated half-width either side of the spine', () => {
    const w = 0.8
    const g = ribbonGeometry(path, () => w, R, 0)
    const pos = g.getAttribute('position')
    const left = new Vector3().fromBufferAttribute(pos, 2)
    const right = new Vector3().fromBufferAttribute(pos, 3)
    const centre = globeCoords(0, 5)
    for (const v of [left, right])
      expect((v.angleTo(centre) * 180) / Math.PI).toBeCloseTo(w, 2)
    // …and on opposite sides
    expect(left.angleTo(right) * (180 / Math.PI)).toBeCloseTo(2 * w, 2)
  })

  it('tapers when told to: the tail is narrower than the head', () => {
    const g = ribbonGeometry(path, (t) => 0.2 + 0.8 * t, R, 0)
    const pos = g.getAttribute('position')
    const width = (i: number) =>
      new Vector3()
        .fromBufferAttribute(pos, i * 2)
        .angleTo(new Vector3().fromBufferAttribute(pos, i * 2 + 1))
    expect(width(0)).toBeLessThan(width(2))
  })
})

describe('DrawingLayer', () => {
  const drawing: Drawing = {
    layers: [
      { type: 'frontline', paths: [[[20, 50], [30, 55]]], dash: 'dashed' },
      { type: 'frontline', paths: [[[20, 48], [30, 53]]] },
      { type: 'thrust', path: [[21, 51], [28, 54]] },
      { type: 'marker', pos: [25, 52], style: 'cross' },
      { type: 'label', pos: [25, 52], text: 'Minsk' },
    ],
  }

  it('builds a scene node per drawn thing and adds it to the scene', () => {
    const scene = new Scene()
    const layer = new DrawingLayer(scene, R)
    expect(scene.children).toContain(layer.object)
    expect(layer.set(drawing, { color: '#e5484d' })).toBe(true)
    // two frontlines, each a casing and a stroke (round 60); a thrust (shaft +
    // head, again twice); a marker; the label needs a DOM and is skipped in a
    // headless run
    expect(layer.object.children.filter((c) => c instanceof Line2)).toHaveLength(4)
    // Line2 IS a Mesh (LineSegments2 extends it), so the solid meshes are the
    // ones that are not fat lines: a thrust shaft and its arrowhead in TWO
    // passes — casing then fill (round 60) — and the marker's own two, its
    // casing and the glyph over it (round 52).
    expect(
      layer.object.children.filter((c) => c instanceof Mesh && !(c instanceof Line2)),
    ).toHaveLength(6)
    layer.dispose()
  })

  /**
   * A SHEET IS DRAWN ONCE, and this is the guard on it.
   *
   * three renders a transparent DoubleSide material twice — back faces, then
   * front — and invalidates the material between the passes, which makes
   * `setProgram` rebuild its program cache key each time. Every filled mark here
   * is a flat sheet on the sphere, so the second pass draws triangles the first
   * one culled and nothing else: `forceSinglePass` is what says so, and its
   * absence is silent (twice the draw calls, the same picture), which is exactly
   * the kind of regression a test has to hold.
   */
  it('draws every filled mark in one pass', () => {
    const scene = new Scene()
    const layer = new DrawingLayer(scene, R)
    layer.set(drawing, { color: '#e5484d' })
    const solids = layer.object.children.filter(
      (c): c is Mesh => c instanceof Mesh && !(c instanceof Line2),
    )
    expect(solids.length).toBeGreaterThan(0)
    for (const m of solids) {
      const mat = m.material as MeshBasicMaterial
      expect(mat.transparent).toBe(true)
      expect(mat.side).toBe(DoubleSide)
      expect(mat.forceSinglePass).toBe(true)
    }
    layer.dispose()
  })

  it('draws frontlines under thrusts under markers, whatever order they are authored in', () => {
    const scene = new Scene()
    const layer = new DrawingLayer(scene, R)
    layer.set(
      {
        layers: [
          { type: 'marker', pos: [25, 52] },
          { type: 'thrust', path: [[21, 51], [28, 54]] },
          { type: 'frontline', paths: [[[20, 50], [30, 55]]] },
        ],
      },
      { color: '#fff' },
    )
    const orders = layer.object.children.map((c) => c.renderOrder)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    expect(layer.object.children[0]).toBeInstanceOf(Line2)
    layer.dispose()
  })

  it('does not rebuild when handed the same drawing again', () => {
    const scene = new Scene()
    const layer = new DrawingLayer(scene, R)
    expect(layer.set(drawing, { color: '#e5484d' })).toBe(true)
    const first = layer.object.children[0]
    expect(layer.set(drawing, { color: '#e5484d' })).toBe(false)
    expect(layer.object.children[0]).toBe(first)
    // …but a different colour is a different picture
    expect(layer.set(drawing, { color: '#4c8dff' })).toBe(true)
    expect(layer.object.children[0]).not.toBe(first)
    layer.dispose()
  })

  it('clears to nothing, and frees what it built', () => {
    const scene = new Scene()
    const layer = new DrawingLayer(scene, R)
    layer.set(drawing, { color: '#e5484d' })
    const geoms = layer.object.children
      .map((c) => (c as Mesh).geometry)
      .filter((g): g is BufferGeometry => !!g)
    let disposed = 0
    for (const g of geoms) g.addEventListener('dispose', () => disposed++)
    expect(layer.set(undefined, { color: '#e5484d' })).toBe(true)
    expect(layer.object.children).toHaveLength(0)
    expect(disposed).toBe(geoms.length)
    layer.dispose()
    expect(scene.children).not.toContain(layer.object)
  })

  it('puts every vertex on the sphere it was given, above the surface', () => {
    const scene = new Scene()
    const layer = new DrawingLayer(scene, R)
    layer.set(drawing, { color: '#e5484d', altitude: 0.02 })
    for (const child of layer.object.children) {
      // A fat line keeps its vertices in instanced attributes and its plain
      // `position` is the unit box the shader extrudes; only the solid meshes
      // carry world-space vertices to check.
      if (child instanceof Line2) continue
      const g = (child as Mesh).geometry
      const pos = g?.getAttribute('position')
      if (!pos) continue
      for (let i = 0; i < pos.count; i++) {
        const r = new Vector3().fromBufferAttribute(pos, i).length()
        expect(r).toBeGreaterThan(R)
        expect(r).toBeLessThan(R * 1.05)
      }
    }
    layer.dispose()
  })

  it('draws a marker where the marker says, not where a swapped pair would be', () => {
    const scene = new Scene()
    const layer = new DrawingLayer(scene, R)
    layer.set({ layers: [{ type: 'marker', pos: [37.62, 55.75], size: 0.5 }] }, { color: '#fff' })
    const pos = ((layer.object.children[0] as Mesh).geometry as BufferGeometry).getAttribute('position')
    const centre = new Vector3()
    for (let i = 0; i < pos.count; i++) centre.add(new Vector3().fromBufferAttribute(pos, i))
    centre.divideScalar(pos.count)
    // Moscow, within the glyph's own radius
    expect((centre.angleTo(globeCoords(55.75, 37.62)) * 180) / Math.PI).toBeLessThan(0.6)
    layer.dispose()
  })
})

describe('SURFACE_ALT', () => {
  /**
   * The number the "drawings shift against the ground" bug came down to. The
   * geometry of it: an overlay at altitude h, seen at incidence angle θ from
   * the surface normal, lands h·tanθ from the ground it names, and the offset
   * swings as the camera orbits. Half a 50° field of view puts θ at 25° at the
   * edge of the frame whatever the zoom, so the slip in *ground* units is a
   * constant h·tan25° — and in *pixels* it is that over the framed width, which
   * is worst zoomed all the way in.
   */
  const slipPx = (altR: number, framedKm: number, widthPx = 1100) =>
    ((altR * 6371 * Math.tan((25 * Math.PI) / 180)) / framedKm) * widthPx

  it('keeps a grounded overlay within a few pixels of its ground at any zoom', () => {
    // what the shipped build did, for the record: a third of the screen at the
    // closest the camera is allowed to come
    expect(slipPx(0.0155, 172)).toBeGreaterThan(250)
    // and what it does now — at the very edge of the tightest frame, and
    // proportionally nothing anywhere else
    expect(slipPx(SURFACE_ALT, 172)).toBeLessThan(12)
    expect(slipPx(SURFACE_ALT, 172) / 1100).toBeLessThan(0.011)
    expect(slipPx(SURFACE_ALT, 1921)).toBeLessThan(1.2)
    // a factor of twenty-five, which is the whole of the reported bug
    expect(slipPx(0.0155, 172) / slipPx(SURFACE_ALT, 172)).toBeGreaterThan(25)
  })

  it('still clears the sag of the chords the overlays are drawn as', () => {
    // A 1° chord (ROUTE_SEGMENT_DEG) sags R(1-cos 0.5°) below the sphere. If the
    // clearance were under that, a grounded line would sink into the planet
    // between its own vertices — which is the floor on how low this can go.
    const sagR = 1 - Math.cos((0.5 * Math.PI) / 180)
    expect(SURFACE_ALT).toBeGreaterThan(sagR * 4)
  })
})

describe('DrawingLayer routes', () => {
  const oneway: Drawing = {
    layers: [{ type: 'route', paths: [[[0, 0], [20, 5], [40, 0]]], direction: 'oneway' }],
  }
  const twoway: Drawing = {
    layers: [{ type: 'route', paths: [[[0, 0], [20, 5], [40, 0]]], direction: 'twoway' }],
  }

  const strokes = (layer: DrawingLayer) =>
    layer.object.children.filter(
      (c): c is Line2 => c instanceof Line2 && (c.material as LineMaterial).dashed,
    )
  /** The route's own casing: solid, and long (the port dots are zero-length). */
  const casings = (layer: DrawingLayer) =>
    layer.object.children.filter(
      (c): c is Line2 =>
        c instanceof Line2 &&
        !(c.material as LineMaterial).dashed &&
        (c.material as LineMaterial).linewidth === ROUTE_STYLE.haloStroke,
    )
  /**
   * The port dots: zero-length fat lines, which render as screen-space discs.
   *
   * `LineSegments2`, not `Line2` — both ports of a route now share one object
   * (two disjoint zero-length segments), which is one draw call instead of two.
   * `Line2` extends `LineSegments2`, so this matches either shape.
   */
  const portDots = (layer: DrawingLayer) =>
    layer.object.children.filter(
      (c): c is LineSegments2 =>
        c instanceof LineSegments2 &&
        !(c.material as LineMaterial).dashed &&
        (c.material as LineMaterial).linewidth !== ROUTE_STYLE.haloStroke,
    )

  /** The taper ramp a stroke carries per vertex; see setTaper in the layer. */
  const taper = (l: LineSegments2) => {
    const a = l.geometry.getAttribute('instanceTaperStart')
    const b = l.geometry.getAttribute('instanceTaperEnd')
    return [...Array(a.count).keys()].map((i) => a.getX(i)).concat(b.getX(b.count - 1))
  }

  it('puts a dot on each port, sized in screen pixels like the line', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(oneway, { color: '#e5a54d' })
    // two ends, each a dark disc under a bright one — in two objects, one per
    // layer, each holding both ports
    const dots = portDots(layer)
    expect(dots).toHaveLength(2)
    for (const d of dots) expect(d.geometry.getAttribute('instanceStart').count).toBe(2)
    const widths = dots.map((d) => (d.material as LineMaterial).linewidth)
    for (const w of widths) expect(w).toBeGreaterThan(ROUTE_STYLE.stroke)
    // A zero-length fat line IS the disc: both of its vertices are the same
    // point, which is what makes LineMaterial's round cap the whole primitive.
    for (const d of dots) {
      const g = d.geometry
      const start = g.getAttribute('instanceStart')
      const end = g.getAttribute('instanceEnd')
      for (let i = 0; i < start.count; i++)
        expect(
          Math.hypot(start.getX(i) - end.getX(i), start.getY(i) - end.getY(i), start.getZ(i) - end.getZ(i)),
        ).toBe(0)
    }
    layer.dispose()
  })

  it('draws one solid casing and ONE tapered stroke over it', () => {
    // The stroke used to be ROUTE_STYLE.taperPieces separate lines, because a
    // LineMaterial carries one opacity for its whole length. It carries a
    // per-vertex ramp now (setTaper), so a route is one object — measured at
    // mid zoom, 98 draw calls a frame with this event selected became 41.
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(oneway, { color: '#e5a54d' })
    expect(casings(layer)).toHaveLength(1)
    expect(strokes(layer)).toHaveLength(1)
    // the casing is wider than the stroke, and under it in paint order
    const casing = casings(layer)[0]
    expect((casing.material as LineMaterial).linewidth).toBeGreaterThan(ROUTE_STYLE.stroke)
    expect(layer.object.children.indexOf(casing)).toBeLessThan(
      layer.object.children.indexOf(strokes(layer)[0]),
    )
    layer.dispose()
  })

  it('brightens toward the destination on a one-way route', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(oneway, { color: '#e5a54d' })
    const ops = taper(strokes(layer)[0])
    // the ramp now reaches its true endpoints rather than the midpoints of the
    // first and last of twenty pieces
    expect(ops[0]).toBeCloseTo(ROUTE_STYLE.tailOpacity, 6)
    expect(ops[ops.length - 1]).toBeCloseTo(1, 6)
    // monotone: a voyage does not flicker on its way across
    for (let i = 1; i < ops.length; i++) expect(ops[i]).toBeGreaterThanOrEqual(ops[i - 1])
    // and the material's own opacity is out of the way, or it would scale it twice
    expect((strokes(layer)[0].material as LineMaterial).opacity).toBe(1)
    layer.dispose()
  })

  it('fades away equally at both ends of a two-way route', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(twoway, { color: '#4c8dff' })
    const ops = taper(strokes(layer)[0])
    for (let i = 0; i < ops.length; i++)
      expect(ops[i], `vertex ${i}`).toBeCloseTo(ops[ops.length - 1 - i], 6)
    expect(Math.max(...ops)).toBeGreaterThan(Math.min(...ops))
    expect(ops[0]).toBeCloseTo(ROUTE_STYLE.endOpacity, 6)
    layer.dispose()
  })

  it('spells ONE dash pattern down the route, with no joins left to cross', () => {
    // This used to be the awkward part of the twenty-piece stroke: each piece
    // had to be told where it began along the whole route or the dashes
    // restarted at every join. One line has no joins, so the pattern is the
    // material's and the offset is nothing.
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(twoway, { color: '#4c8dff' })
    const pieces = strokes(layer)
    expect(pieces).toHaveLength(1)
    const m = pieces[0].material as LineMaterial
    expect(m.dashSize + m.gapSize).toBeGreaterThan(0)
    expect(m.dashOffset).toBe(0)
    layer.dispose()
  })

  it('only a ONE-WAY route asks for frames', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(twoway, { color: '#4c8dff' })
    expect(layer.hasFlow, 'a trade network does not move').toBe(false)
    layer.set(oneway, { color: '#e5a54d' })
    expect(layer.hasFlow, 'a voyage does').toBe(true)
    layer.set(undefined, { color: '#e5a54d' })
    expect(layer.hasFlow, 'and nothing on screen asks for nothing').toBe(false)
    layer.dispose()
  })

  it('puts the dash where the wall clock says, and never accumulates', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(oneway, { color: '#e5a54d' })
    const first = strokes(layer)[0].material as LineMaterial
    const cycle = first.dashSize + first.gapSize
    const at = (t: number) => {
      layer.setFlowPhase(t)
      return first.dashOffset
    }
    // the same instant is the same picture, whatever was called in between
    const a = at(0)
    at(1234)
    at(99999)
    expect(at(0)).toBe(a)
    // and one whole cycle later is the same place in the cycle
    expect(at(ROUTE_STYLE.flowCycleMs)).toBeCloseTo(a, 9)
    // it runs FORWARD along the line: within a cycle the offset decreases, which
    // is what moves the pattern toward the destination
    expect(at(ROUTE_STYLE.flowCycleMs / 4)).toBeLessThan(a)
    expect(at(ROUTE_STYLE.flowCycleMs / 2)).toBeLessThan(at(ROUTE_STYLE.flowCycleMs / 4))
    // a frame skipped entirely does not shift anything: the phase is the clock
    expect(at(5000)).toBeCloseTo(-flowPhase(5000) * cycle, 9)
    layer.dispose()
  })

  it('grounds everything it draws at the one altitude it was given', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      {
        layers: [
          { type: 'route', paths: [[[0, 0], [20, 5]]] },
          { type: 'frontline', paths: [[[0, 1], [20, 6]]] },
          { type: 'marker', pos: [10, 3], style: 'cross' },
          { type: 'thrust', path: [[0, 2], [20, 7]] },
        ],
      },
      { color: '#fff', altitude: SURFACE_ALT },
    )
    // Every solid mesh vertex sits at exactly the stated radius — no kind gets
    // its own extra lift any more, because a lift is parallax.
    for (const child of layer.object.children) {
      // LineSegments2 (and Line2, which extends it) keeps its real vertices in
      // instanceStart/instanceEnd; `position` is the unit quad the fat-line
      // shader extrudes, and measuring that is measuring the template
      if (child instanceof LineSegments2) continue
      const pos = ((child as Mesh).geometry as BufferGeometry)?.getAttribute('position')
      if (!pos) continue
      for (let i = 0; i < pos.count; i++)
        expect(new Vector3().fromBufferAttribute(pos, i).length()).toBeCloseTo(
          R * (1 + SURFACE_ALT),
          4,
        )
    }
    layer.dispose()
  })

  it('biases every overlay material in depth rather than in height', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      {
        layers: [
          { type: 'route', paths: [[[0, 0], [20, 5]]] },
          { type: 'frontline', paths: [[[0, 1], [20, 6]]] },
          { type: 'marker', pos: [10, 3] },
          { type: 'thrust', path: [[0, 2], [20, 7]] },
        ],
      },
      { color: '#fff' },
    )
    for (const child of layer.object.children) {
      const m = (child as Mesh).material as LineMaterial | undefined
      if (!m || !('polygonOffset' in m)) continue
      expect(m.polygonOffset, child.type).toBe(true)
      expect(m.polygonOffsetUnits, child.type).toBeLessThan(0)
      // …and still no depth writing, so the kinds order by renderOrder alone
      expect(m.depthWrite, child.type).toBe(false)
    }
    layer.dispose()
  })

  it('draws a route under a frontline under a marker, however it is authored', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      {
        layers: [
          { type: 'marker', pos: [10, 3] },
          { type: 'frontline', paths: [[[0, 1], [20, 6]]] },
          { type: 'route', paths: [[[0, 0], [20, 5]]] },
        ],
      },
      { color: '#fff' },
    )
    const orders = layer.object.children.map((c) => c.renderOrder)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    layer.dispose()
  })

  it('has nothing to draw for a route that is one point', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      { layers: [{ type: 'route', paths: [[[5, 5]] as unknown as GeoPath] }] },
      { color: '#fff' },
    )
    expect(layer.object.children).toHaveLength(0)
    expect(layer.hasFlow).toBe(false)
    layer.dispose()
  })
})

/**
 * ROUND 52 — THE BATTLE X, REPORTED AS *"in steps, 'x' mark is a bit too hard to
 * see on the map"*.
 *
 * It was two faults with one shape. The glyph carried no casing, so it was
 * legible only where the ground happened to differ from it — and a battle plan's
 * ground is its own thrust ribbons as often as it is the map. And its colour was
 * a photograph's colour on both grounds: `#ffd7a8` measures 1.16:1 against the
 * drawn map's parchment, which is not a faint mark, it is no mark at all.
 *
 * Both are now decided by the ground the layer was told it is on, which is the
 * one thing a test can hold: build the same marker twice, once per ground, and
 * assert the two passes and the two tones.
 */
describe('a marker and its casing', () => {
  const meshes = (layer: DrawingLayer) =>
    layer.object.children.filter((c): c is Mesh => c instanceof Mesh && !(c instanceof Line2))
  const colorOf = (m: Mesh) => '#' + (m.material as MeshBasicMaterial).color.getHexString()
  /** Farthest vertex from the globe centre-line of the glyph, in world units. */
  const spread = (m: Mesh) => {
    const pos = (m.geometry as BufferGeometry).getAttribute('position')
    const centre = new Vector3()
    for (let i = 0; i < pos.count; i++) centre.add(new Vector3().fromBufferAttribute(pos, i))
    centre.divideScalar(pos.count)
    let max = 0
    for (let i = 0; i < pos.count; i++)
      max = Math.max(max, new Vector3().fromBufferAttribute(pos, i).distanceTo(centre))
    return max
  }
  const built = (ground: 'dark' | 'paper', style: 'cross' | 'dot' | 'star' | 'arrow' = 'cross') => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      { layers: [{ type: 'marker', pos: [32.4, 50.3], style, size: 0.3, color: '#ffd7a8' }] },
      { color: '#fff', ground },
    )
    return layer
  }
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a: string, b: string) =>
    (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

  it('draws every glyph twice: a casing, then the mark over it', () => {
    for (const style of ['cross', 'dot', 'star', 'arrow'] as const) {
      const layer = built('paper', style)
      const [casing, mark] = meshes(layer)
      expect(meshes(layer), style).toHaveLength(2)
      // the casing is under the mark in paint order and wider than it on the
      // ground — a rim, in the glyph's own units, not a second copy
      expect(casing.renderOrder, style).toBeLessThan(mark.renderOrder)
      expect(spread(casing), style).toBeGreaterThan(spread(mark) * 1.05)
      layer.dispose()
    }
  })

  it('inks the mark for the ground it landed on, and cases it in the opposite tone', () => {
    const paper = built('paper')
    const dark = built('dark')
    const [paperCasing, paperMark] = meshes(paper).map(colorOf)
    const [darkCasing, darkMark] = meshes(dark).map(colorOf)

    // ON A PHOTOGRAPH nothing about the accent changes — it was picked against
    // Blue Marble and it still works there — and the casing is the route's.
    expect(darkMark).toBe('#ffd7a8')
    expect(darkCasing).toBe(MARK_CASING_DARK.color)

    // ON PAPER the mark is ink and the casing is the paper's own highlight: a
    // reserved halo, which is what lifts the cross off the thrust under it.
    expect(paperMark).not.toBe(darkMark)
    expect(paperCasing).toBe(MARK_CASING_PAPER.color)
    expect(lum(paperCasing)).toBeGreaterThan(lum(PAPER.land))
    expect(lum(paperMark)).toBeLessThan(lum(PAPER.land))

    // …and the number the report was about. 1.16:1 against the land tone before;
    // a drawn mark on a drawn map is 3:1 or it is decoration.
    expect(ratio('#ffd7a8', PAPER.land)).toBeLessThan(1.3)
    expect(ratio(paperMark, PAPER.land)).toBeGreaterThan(3)

    // THE GROUND A BATTLE MARK IS ACTUALLY ON is not the paper, it is the plan:
    // a cross marks a pocket, and a pocket closes on top of the thrust that
    // closed it. Inked, the mark alone is 1.87:1 against `#ff8a4c` — better than
    // the 1.19:1 it was, and still not enough on its own. That is what the
    // casing is for, and the casing is clear of both.
    expect(ratio(paperMark, '#ff8a4c')).toBeGreaterThan(1.8)
    expect(ratio(paperCasing, '#ff8a4c')).toBeGreaterThan(2)
    expect(ratio(paperCasing, paperMark)).toBeGreaterThan(4)
    paper.dispose()
    dark.dispose()
  })

  it('rebuilds when the ground changes, because the ink does', () => {
    const layer = new DrawingLayer(new Scene(), R)
    const spec: Drawing = {
      layers: [{ type: 'marker', pos: [32.4, 50.3], style: 'cross', size: 0.3, color: '#ffd7a8' }],
    }
    expect(layer.set(spec, { color: '#fff', ground: 'dark' })).toBe(true)
    expect(colorOf(meshes(layer)[1])).toBe('#ffd7a8')
    expect(layer.set(spec, { color: '#fff', ground: 'paper' })).toBe(true)
    expect(colorOf(meshes(layer)[1])).toBe(markInk('#ffd7a8', 'paper').fill)
    layer.dispose()
  })
})

/**
 * ROUND 60 — CASING ON EVERY STROKE.
 *
 * A route has been cased since it was drawn; a frontline and a thrust ribbon
 * were not, and they land on the same grounds and on each other. These hold the
 * two properties that make a casing a casing: it is UNDER the stroke in paint
 * order, and it is WIDER than it — in screen pixels for a fat line, in degrees
 * of arc for a ribbon, which is the same two-unit split the layer is built on.
 */
describe('a stroke and its casing', () => {
  // `Line2` extends `LineSegments2`, so a continuous fat line is both and a comb
  // of teeth is only the second — which is exactly the distinction being made.
  const lines = (layer: DrawingLayer) =>
    layer.object.children.filter((c): c is Line2 => c instanceof Line2)
  const meshes = (layer: DrawingLayer) =>
    layer.object.children.filter((c): c is Mesh => c instanceof Mesh && !(c instanceof LineSegments2))
  const matOf = (o: Mesh) => o.material as LineMaterial & MeshBasicMaterial
  const colorOf = (o: Mesh) => '#' + matOf(o).color.getHexString()

  it('cases a frontline: one dark line under the stroke, wider than it', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      { layers: [{ type: 'frontline', paths: [[[20, 50], [30, 55]]], width: 3 }] },
      { color: '#e5484d' },
    )
    const [casing, stroke] = lines(layer)
    expect(lines(layer)).toHaveLength(2)
    expect(colorOf(casing)).toBe(STROKE_CASING.color)
    expect(colorOf(stroke)).toBe('#e5484d')
    expect(casing.renderOrder).toBeLessThan(stroke.renderOrder)
    expect(matOf(casing).linewidth).toBeCloseTo(3 + STROKE_CASING.widen, 6)
    expect(matOf(stroke).linewidth).toBe(3)
    layer.dispose()
  })

  it('is ONE constant, so both map modes get the same rim', () => {
    const spec: Drawing = { layers: [{ type: 'frontline', paths: [[[20, 50], [30, 55]]] }] }
    const on = (ground: 'dark' | 'paper') => {
      const layer = new DrawingLayer(new Scene(), R)
      layer.set(spec, { color: '#e5484d', ground })
      const out = colorOf(lines(layer)[0])
      layer.dispose()
      return out
    }
    expect(on('dark')).toBe(STROKE_CASING.color)
    expect(on('paper')).toBe(STROKE_CASING.color)
  })

  it("dashes the casing with the front, because a front's dash is the data", () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      { layers: [{ type: 'frontline', paths: [[[20, 50], [30, 55]]], dash: 'dashed' }] },
      { color: '#e5484d' },
    )
    for (const l of lines(layer)) expect(matOf(l).dashed).toBe(true)
    layer.dispose()
  })

  it('cases a thrust in degrees of arc: the rim stands outside the ribbon all round', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set({ layers: [{ type: 'thrust', path: [[21, 51], [28, 54]], width: 0.6 }] }, { color: '#e5484d' })
    // shaft and head, twice: casing then fill
    expect(meshes(layer)).toHaveLength(4)
    const [casingShaft, casingHead, shaft, head] = meshes(layer)
    expect(colorOf(casingShaft)).toBe(STROKE_CASING.color)
    expect(colorOf(shaft)).toBe('#e5484d')
    expect(casingShaft.renderOrder).toBeLessThan(shaft.renderOrder)
    expect(casingHead.renderOrder).toBeLessThan(head.renderOrder)
    // the casing ribbon is wider than the ribbon at every point along it
    const widthOf = (m: Mesh) => {
      const pos = (m.geometry as BufferGeometry).getAttribute('position')
      let max = 0
      for (let i = 0; i + 1 < pos.count; i += 2)
        max = Math.max(
          max,
          new Vector3().fromBufferAttribute(pos, i).distanceTo(new Vector3().fromBufferAttribute(pos, i + 1)),
        )
      return max
    }
    expect(widthOf(casingShaft)).toBeGreaterThan(widthOf(shaft) * 1.05)
    layer.dispose()
  })

  it('draws the casing in ONE pass too, like every other sheet on this layer', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      {
        layers: [
          { type: 'thrust', path: [[21, 51], [28, 54]] },
          { type: 'zone', ring: [[20, 50], [24, 50], [24, 53]] },
        ],
      },
      { color: '#e5484d' },
    )
    for (const m of meshes(layer)) {
      expect(matOf(m).side).toBe(DoubleSide)
      expect(matOf(m).forceSinglePass).toBe(true)
      expect(matOf(m).transparent).toBe(true)
    }
    layer.dispose()
  })
})

/**
 * ROUND 60 — A THRUST IS A CURVE, and the curve has one owner.
 *
 * The spine went through `densifyPath` alone, which puts every authored waypoint
 * on a great circle to the next and leaves the corners between them: an axis of
 * advance drawn as a survey traverse. `routePolyline` is what a route's shape
 * comes from, and this asserts the thrust now comes from the same place —
 * including the consequence that matters, the arrowhead sitting on the SMOOTHED
 * end tangent rather than on the last authored chord.
 */
describe('a smoothed thrust', () => {
  const dogleg: GeoPath = [
    [20, 50],
    [26, 50],
    [30, 54],
  ]

  it('bends where a plotter would have cornered', () => {
    const smooth = routePolyline(dogleg)
    const chords = densifyPath(dogleg, 1)
    // the smoothed spine leaves the authored polyline: measured at the corner,
    // which is exactly where a corner should stop being one
    const near = (p: [number, number], path: GeoPath) =>
      Math.min(...path.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])))
    const worst = Math.max(...smooth.map((p) => near(p, chords)))
    expect(worst).toBeGreaterThan(0.05)
    // …and it still passes through every waypoint the author wrote
    for (const w of dogleg)
      expect(Math.min(...smooth.map((q) => Math.hypot(q[0] - w[0], q[1] - w[1])))).toBeLessThan(1e-9)
  })

  it('puts the arrowhead on the smoothed end tangent', () => {
    const smooth = routePolyline(dogleg)
    const head = headOf(smooth)
    // the bearing off the last authored chord, for comparison
    const chord = headOf([dogleg[dogleg.length - 2], dogleg[dogleg.length - 1]])
    expect(head.lng).toBeCloseTo(dogleg[2][0], 6)
    expect(head.lat).toBeCloseTo(dogleg[2][1], 6)
    // 0.46° apart on this dogleg: small, because a centripetal spline with
    // reflected end control points arrives smoothly, and it is the whole
    // difference between an arrow aimed down the last authored chord and one
    // aimed down the curve the reader can see.
    expect(Math.abs(head.bearing - chord.bearing)).toBeGreaterThan(0.25)
  })

  it('draws the ribbon along the smoothed spine, not the authored chords', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set({ layers: [{ type: 'thrust', path: dogleg }] }, { color: '#fff' })
    const shaft = layer.object.children.filter(
      (c): c is Mesh => c instanceof Mesh && !(c instanceof LineSegments2),
    )[0]
    const pos = (shaft.geometry as BufferGeometry).getAttribute('position')
    // one vertex pair per point of the smoothed, trimmed spine — far more than
    // the four the authored dogleg densifies to at this size
    expect(pos.count / 2).toBeGreaterThan(dogleg.length * 4)
    layer.dispose()
  })
})

/**
 * ROUND 60 — TICKS: which side of a front was held.
 *
 * `tickSegments` is the whole of it, and it is pure geometry over an already
 * densified polyline: count, spacing, side, length. The renderer's part is one
 * `LineSegments2` per pass, which is what keeps eighteen teeth at one draw call.
 */
describe('frontline ticks', () => {
  const straight: GeoPath = [
    [0, 0],
    [10, 0],
  ]
  const pts = densifyPath(straight, 1)

  it('is absent by default, so every front authored before this is unchanged', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set({ layers: [{ type: 'frontline', paths: [straight] }] }, { color: '#fff' })
    expect(
      layer.object.children.filter((c) => c instanceof LineSegments2 && !(c instanceof Line2)),
    ).toHaveLength(0)
    layer.dispose()
  })

  it('combs the line at a constant spacing, in its own length', () => {
    const teeth = tickSegments(pts, 'left')
    expect(teeth.length).toBeGreaterThan(10)
    expect(teeth.length).toBeLessThan(24)
    const along = teeth.map(([a]) => a[0])
    const gaps = along.slice(1).map((x, i) => x - along[i])
    for (const g of gaps) expect(g).toBeCloseTo(10 * FRONTLINE_TICKS.every, 3)
    // and stands off both ends rather than turning a corner on them
    expect(along[0]).toBeGreaterThan(0)
    expect(along[along.length - 1]).toBeLessThan(10)
  })

  it('puts them on the named side of TRAVEL, and mirrors when the side flips', () => {
    // east along the equator: left of travel is north
    const [[, to]] = tickSegments(pts, 'left').map(([a, b]) => [a, b])
    expect(to[1]).toBeGreaterThan(0)
    const [[, right]] = tickSegments(pts, 'right').map(([a, b]) => [a, b])
    expect(right[1]).toBeLessThan(0)
    // a front authored the other way round has its "left" on the other side,
    // which is the whole content of the convention
    const back = tickSegments(densifyPath([[10, 0], [0, 0]], 1), 'left')
    expect(back[0][1][1]).toBeLessThan(0)
  })

  it('makes each tooth a fraction of the front, not a fixed distance', () => {
    const long = tickSegments(densifyPath([[0, 0], [20, 0]], 1), 'left')
    const short = tickSegments(densifyPath([[0, 0], [2, 0]], 1), 'left')
    const len = (t: [[number, number], [number, number]][]) =>
      Math.hypot(t[0][1][0] - t[0][0][0], t[0][1][1] - t[0][0][1])
    expect(len(long) / len(short)).toBeCloseTo(10, 1)
    expect(long.length).toBe(short.length)
  })

  it('draws every tooth in one object per pass, cased like the line', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      { layers: [{ type: 'frontline', paths: [straight], ticks: 'left' }] },
      { color: '#e5484d' },
    )
    const combs = layer.object.children.filter(
      (c): c is LineSegments2 => c instanceof LineSegments2 && !(c instanceof Line2),
    )
    expect(combs).toHaveLength(2)
    const hexOf = (o: LineSegments2) => '#' + (o.material as LineMaterial).color.getHexString()
    expect(hexOf(combs[0])).toBe(STROKE_CASING.color)
    expect(hexOf(combs[1])).toBe('#e5484d')
    expect(combs[0].renderOrder).toBeLessThan(combs[1].renderOrder)
    layer.dispose()
  })

  it('has nothing to comb on a line with no length', () => {
    expect(tickSegments([[5, 5], [5, 5]], 'left')).toEqual([])
    expect(tickSegments([[5, 5]], 'left')).toEqual([])
  })
})

/**
 * ROUND 60 — THE ZONE: a pocket, washed and edged.
 *
 * The two things a filled area on a sphere has to get right are that it is
 * INSIDE the ring and that it does not sink through the planet between its own
 * vertices — a triangle spanning 5° sags 6 km below a surface it is lifted 3.8 km
 * above. That is what the subdivision in `capGeometry` is for, and it is what
 * these measure.
 */
describe('zone caps', () => {
  const ring: GeoPath = [
    [20, 50],
    [26, 50],
    [26, 54],
    [20, 54],
  ]

  it('fills the ring and stays on the sphere between its own vertices', () => {
    const g = capGeometry(ring, R, SURFACE_ALT)
    const pos = g.getAttribute('position')
    expect(pos.count).toBeGreaterThan(3)
    expect(pos.count % 3).toBe(0)
    for (let i = 0; i < pos.count; i++) {
      const v = new Vector3().fromBufferAttribute(pos, i)
      // every vertex on the sphere at the layer's own altitude…
      // to Float32, which is what the attribute holds
      expect(v.length()).toBeCloseTo(R * (1 + SURFACE_ALT), 3)
      // …and inside the ring it was cut from, to the Float32 the attribute holds
      const lat = (Math.asin(v.y / v.length()) * 180) / Math.PI
      const lng = (Math.atan2(v.x, v.z) * 180) / Math.PI
      // …and inside the ring it was cut from — with the poleward bulge a
      // GREAT CIRCLE has against the parallel through its ends (0.03° across
      // this ring's 6° top edge), because that is the curve `areaCapRing`
      // densifies onto and the one an event footprint's cap already uses.
      expect(lng).toBeGreaterThanOrEqual(20 - 1e-4)
      expect(lng).toBeLessThanOrEqual(26 + 1e-4)
      expect(lat).toBeGreaterThanOrEqual(50 - 1e-4)
      expect(lat).toBeLessThanOrEqual(54.05)
    }
  })

  it('cuts every triangle fine enough that its chord clears the ground', () => {
    const pos = capGeometry(ring, R, SURFACE_ALT).getAttribute('position')
    // the deepest a triangle's plane dips below the sphere, against the
    // clearance the whole layer is lifted by
    let deepest = 0
    for (let i = 0; i < pos.count; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(pos, i + k))
      const centroid = a.clone().add(b).add(c).divideScalar(3)
      deepest = Math.max(deepest, R - centroid.length())
    }
    expect(deepest).toBeLessThan(R * SURFACE_ALT)
  })

  it('does not explode on a ring authored at continental scale', () => {
    const huge: GeoPath = [
      [-60, 10],
      [10, 10],
      [10, 50],
      [-60, 50],
    ]
    const pos = capGeometry(huge, R, SURFACE_ALT).getAttribute('position')
    expect(pos.count / 3).toBeLessThanOrEqual(ZONE_MAX_TRIANGLES)
  })

  it('is one shape across the antimeridian, not two continents apart', () => {
    const seam: GeoPath = [
      [178, 10],
      [-178, 10],
      [-178, 14],
      [178, 14],
    ]
    const pos = capGeometry(seam, R, SURFACE_ALT).getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const v = new Vector3().fromBufferAttribute(pos, i)
      const lng = (Math.atan2(v.x, v.z) * 180) / Math.PI
      expect(Math.abs(lng)).toBeGreaterThan(177.9)
    }
  })

  it('draws nothing for a ring that is not a ring', () => {
    expect(capGeometry([[0, 0], [1, 1]], R, SURFACE_ALT).getAttribute('position').count).toBe(0)
  })

  it('washes the ring and edges it with a dashed, cased line', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set({ layers: [{ type: 'zone', ring, label: 'Kiev pocket' }] }, { color: '#e5484d' })
    const cap = layer.object.children.filter(
      (c): c is Mesh => c instanceof Mesh && !(c instanceof LineSegments2),
    )
    const edge = layer.object.children.filter((c): c is Line2 => c instanceof Line2)
    expect(cap).toHaveLength(1)
    expect((cap[0].material as MeshBasicMaterial).opacity).toBe(ZONE_FILL_OPACITY)
    // a wash, not a lid: lighter than the footprint cap it may sit inside
    expect((cap[0].material as MeshBasicMaterial).opacity).toBeLessThan(0.22)
    expect(edge).toHaveLength(2)
    for (const l of edge) expect((l.material as LineMaterial).dashed).toBe(true)
    expect(cap[0].renderOrder).toBeLessThanOrEqual(edge[0].renderOrder)
    layer.dispose()
  })

  it('sits under every other kind, because a wash over a plan is a filter', () => {
    const layer = new DrawingLayer(new Scene(), R)
    layer.set(
      {
        layers: [
          { type: 'marker', pos: [23, 52] },
          { type: 'thrust', path: [[21, 51], [25, 53]] },
          { type: 'zone', ring },
          { type: 'frontline', paths: [[[20, 50], [26, 54]]] },
        ],
      },
      { color: '#fff' },
    )
    const orders = layer.object.children.map((c) => c.renderOrder)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    // the zone's cap is the first thing built and the lowest thing painted
    expect(layer.object.children[0]).toBeInstanceOf(Mesh)
    expect(layer.object.children[0]).not.toBeInstanceOf(Line2)
    layer.dispose()
  })

  it('reaches the camera through drawingPoints, so a pocket is framed whole', () => {
    expect(drawingExtentDeg({ layers: [{ type: 'zone', ring }] })).toBeGreaterThan(4)
  })
})
