import { describe, it, expect } from 'vitest'
import { BufferGeometry, Mesh, Scene, Vector3 } from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import {
  DrawingLayer,
  glyphShape,
  headOf,
  offsetPoint,
  ribbonGeometry,
  tangentFrame,
  trimEnd,
} from '../src/lib/drawingLayer'
import type { Drawing } from '../src/lib/drawing'
import type { GeoPath } from '../src/lib/paths'

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
    // two frontlines (fat lines), a thrust (shaft + head), a marker; the label
    // needs a DOM and is skipped in a headless run
    expect(layer.object.children.filter((c) => c instanceof Line2)).toHaveLength(2)
    // Line2 IS a Mesh (LineSegments2 extends it), so the solid meshes are the
    // ones that are not fat lines: a thrust shaft, its arrowhead, one marker.
    expect(
      layer.object.children.filter((c) => c instanceof Mesh && !(c instanceof Line2)),
    ).toHaveLength(3)
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
