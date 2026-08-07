import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicMaterial,
  Vector2,
  type Object3D,
  type Scene,
} from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import {
  ROUTE_SEGMENT_DEG,
  ROUTE_STYLE,
  densifyPath,
  directionOf,
  flowPhase,
  routePolyline,
  slerpPoint,
  taperOpacity,
  type GeoPath,
} from './paths'
import { separationDeg } from './queryIndex'
import {
  drawingPoints,
  FRONTLINE_WIDTH,
  MARKER_SIZE_DEG,
  THRUST_HEAD_SCALE,
  THRUST_WIDTH_DEG,
  type Drawing,
  type DrawingSpec,
  type MarkerStyle,
} from './drawing'
import { markInk } from './present/ink'

/**
 * The renderer for a `Drawing` (lib/drawing.ts): a three.js group built from the
 * spec, added to the globe's scene, and thrown away when the drawing hides.
 *
 * Four decisions worth the words:
 *
 * **Everything is built on the sphere, not projected onto a plane.** A frontline
 * is a fat line through points lifted to an altitude; a thrust is a ribbon whose
 * edges are offset along the surface normal-perpendicular at each point; a
 * marker is a flat shape laid in the local tangent frame. Nothing here has a
 * "map" to be right on — the camera can be anywhere.
 *
 * **Everything sits at ONE altitude, and that altitude is tiny.** See
 * `SURFACE_ALT`. This is the fix for the drawings visibly sliding against the
 * ground as the camera moved.
 *
 * **Widths come in two units, on purpose.** A frontline or a route is in screen
 * pixels (Line2, so it stays a line at any zoom); a thrust and a marker are in
 * degrees of arc (real meshes, so they have a footprint that grows as you come
 * in). That is the difference between a symbol drawn ON a map and a thing that
 * is ON THE GROUND, and an operational map uses both.
 *
 * **It is disposed, completely, every time.** A drawing is rebuilt from scratch
 * on every change rather than diffed: they are tens of triangles, they change
 * when the user opens a different article, and a diffing path would be a
 * lifetime bug waiting to happen for no measurable frame time. `dispose` walks
 * the group and frees every geometry, material and DOM node it made.
 */

const RAD = Math.PI / 180

/**
 * How far above the surface every overlay sits, in globe radii. 0.0006 R is
 * 3.8 km — the height of a mountain, not of a satellite.
 *
 * WHY IT IS THIS SMALL. Overlay geometry drawn at altitude h does not sit on the
 * ground it names: seen from anywhere except straight overhead it lands on the
 * ground *behind* itself, by h·tan(incidence), and the offset swings as the
 * camera orbits. Measured in the shipped build at 1100 px wide, on a feature
 * 45% of the frame from the optical axis:
 *
 *     altitude          172 km view   1921 km view   world view
 *     0.0155 (98.8 km)     336 px         30 px         8 px     ← battle plans
 *     0.0142 (90.5 km)     295 px         27 px         7 px     ← routes
 *     0.0120 (76.5 km)     233 px         23 px         6 px     ← the area cap
 *     0.0006 ( 3.8 km)       9 px          1 px         0 px     ← here
 *
 * A frontline on the Dnieper that moves a third of the screen when you turn the
 * globe is not on the Dnieper, and that is exactly what was reported. Nine
 * pixels at the tightest zoom the app allows is the residue, and it is under the
 * width of the line drawing it.
 *
 * WHY IT IS NOT ZERO. Chords. The globe is a 90x45-segment sphere, so its facets
 * dip up to R(1-cos 2°) = 3.9 km *below* the ideal sphere — harmless, that only
 * buys clearance. But the overlays are drawn as chords too, and a chord sags
 * below the sphere it was cut from: 240 m across the 1° a route or a frontline
 * is densified to (`ROUTE_SEGMENT_DEG`), and up to ~800 m across the radius of
 * the largest marker glyph. 3.8 km clears the worst of those by five times.
 * Halving it again was tried and reverted: it looks identical, and it spends the
 * whole margin the glyphs need to buy about six pixels at a zoom the reader has
 * to fight the camera to reach.
 *
 * WHY THAT IS NOT ENOUGH ON ITS OWN. The depth buffer is 24-bit with no log
 * depth, and at world view the near plane sits at 0.35 of the camera's height,
 * which puts one depth quantum at ~2.7 km of altitude at the sub-camera point —
 * the same order as the clearance. So every overlay material also carries a
 * negative polygon offset (`groundBias`), which biases in depth-buffer units and
 * is therefore correct at every zoom. Geometry decides where things *are*;
 * polygon offset decides that they are not eaten by their own map.
 */
export const SURFACE_ALT = 0.0006

/**
 * The depth bias every overlay material carries.
 *
 * Negative pulls toward the camera. Four units is a handful of depth quanta at
 * whatever distance the fragment is at — enough that a line hugging the surface
 * never z-fights with it, and nothing at all against the ~2R of depth between
 * the near face of the globe and the far one, so the planet still hides what is
 * round the back. The factor term does the same job for grazing angles near the
 * limb, where a line's depth slope across a pixel is steepest.
 */
const groundBias = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 } as const

/**
 * Per-vertex opacity for a fat line, in one extra instanced attribute.
 *
 * `LineMaterial` carries a single opacity for a whole line, which is why the
 * taper down a route used to be cut into twenty constant-opacity pieces. Twenty
 * pieces is twenty objects, twenty materials and — this is the part that was
 * felt — twenty draw calls, and a route event draws three routes. Measured at
 * the zoom the whole Atlantic is framed at: 98 draw calls a frame with the
 * trans-Atlantic trade selected, against 34 with nothing selected.
 *
 * `LineSegmentsGeometry` already hands the shader a start and an end value per
 * segment for position and for colour. This adds a third such pair carrying
 * alpha, which the rasteriser interpolates along the segment exactly as it does
 * the colour, and the fragment shader multiplies into its own alpha. Twenty
 * objects become one, and the gradient stops being twenty steps and becomes
 * continuous — which is what it was always meant to look like.
 */
function setTaper(geom: LineGeometry, alphas: number[]) {
  // the pairs layout `LineGeometry.setPositions` builds: segment i runs from
  // vertex i to vertex i+1, and neighbouring segments share the boundary value
  const n = Math.max(0, alphas.length - 1)
  const pairs = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    pairs[i * 2] = alphas[i]
    pairs[i * 2 + 1] = alphas[i + 1]
  }
  const buffer = new InstancedInterleavedBuffer(pairs, 2, 1)
  geom.setAttribute('instanceTaperStart', new InterleavedBufferAttribute(buffer, 1, 0))
  geom.setAttribute('instanceTaperEnd', new InterleavedBufferAttribute(buffer, 1, 1))
}

/**
 * A `LineMaterial` that reads the attribute `setTaper` writes.
 *
 * The patch is four string substitutions against three's own line shader, which
 * is a hostage to its exact source — so each anchor is a whole statement rather
 * than a fragment, and a miss is loud: the attribute would be undeclared and the
 * shader would fail to compile rather than silently drawing the wrong thing.
 * The cache key has to differ from a plain LineMaterial's or the two share a
 * compiled program and whichever compiled first wins.
 */
function taperMaterial(params: ConstructorParameters<typeof LineMaterial>[0]): LineMaterial {
  const mat = new LineMaterial(params)
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        'attribute vec3 instanceColorStart;',
        'attribute vec3 instanceColorStart;\n\t\tattribute float instanceTaperStart;\n\t\tattribute float instanceTaperEnd;\n\t\tvarying float vTaper;',
      )
      .replace(
        'float aspect = resolution.x / resolution.y;',
        'vTaper = ( position.y < 0.5 ) ? instanceTaperStart : instanceTaperEnd;\n\t\t\tfloat aspect = resolution.x / resolution.y;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform vec3 diffuse;', 'varying float vTaper;\n\t\tuniform vec3 diffuse;')
      .replace(
        'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
        'gl_FragColor = vec4( diffuseColor.rgb, alpha * vTaper );',
      )
  }
  mat.customProgramCacheKey = () => 'lineTaper'
  return mat
}

/**
 * A unit vector on the sphere from `[lng, lat]`.
 *
 * Mirrors three-globe's own `polar2Cartesian` exactly — y is the polar axis and
 * z points at (0, 0) — because everything this layer draws has to land on the
 * same sphere the pins and the routes do. Getting it wrong is a drawing that is
 * plausibly shaped and in the wrong ocean.
 */
const unit = (lng: number, lat: number): [number, number, number] => {
  const p = lat * RAD
  const l = lng * RAD
  const c = Math.cos(p)
  return [c * Math.sin(l), Math.sin(p), c * Math.cos(l)]
}

const scale = (v: [number, number, number], k: number): [number, number, number] => [
  v[0] * k,
  v[1] * k,
  v[2] * k,
]

const add = (
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

const cross = (
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

const norm = (v: [number, number, number]): [number, number, number] => {
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}

/**
 * The local tangent frame at a point: which way is east, which way is north.
 *
 * Every flat glyph is drawn in these two axes, so one 2-D shape (a circle, a
 * cross, a five-pointed star, a chevron) becomes a mesh anywhere on the planet
 * without a projection and without a special case at the poles — at a pole
 * "east" is arbitrary but still perpendicular to up, which is all the maths
 * needs.
 */
export function tangentFrame(lng: number, lat: number) {
  const up = unit(lng, lat)
  const pole: [number, number, number] = [0, 1, 0]
  // At a pole `up` is parallel to the axis and the cross product vanishes; any
  // perpendicular will do, and this one is continuous with the limit from below.
  let east = cross(pole, up)
  if (Math.hypot(east[0], east[1], east[2]) < 1e-9) east = [1, 0, 0]
  east = norm(east)
  const north = norm(cross(up, east))
  return { up, east, north }
}

/**
 * A point `x` degrees east and `y` degrees north of (lng, lat), at `alt`.
 *
 * Small-angle placement: the offset is added in the tangent plane and the result
 * renormalised back onto the sphere. Exact at the point, and under a degree of
 * error at the sizes anything here is drawn at (glyphs are ~1°, thrust shafts
 * under 2°); getting it exactly right would need a two-axis rotation per vertex
 * for a difference no screen can show.
 */
export function offsetPoint(
  lng: number,
  lat: number,
  x: number,
  y: number,
  radius: number,
  alt: number,
): [number, number, number] {
  const { up, east, north } = tangentFrame(lng, lat)
  const p = norm(add(up, add(scale(east, x * RAD), scale(north, y * RAD))))
  return scale(p, radius * (1 + alt))
}

/* ------------------------------------------------------------ glyph shapes */

/**
 * Half-thickness of the battle cross's bars, in units of its size.
 *
 * ROUND 52: 0.26 before, and 0.26 is a fine nib. The reported fault was *"in
 * steps, 'x' mark is a bit too hard to see on the map"*, and a cross authored at
 * 0.02° of arc — the D-Day plan's — is about twelve screen pixels across at the
 * zoom its step frames, so its bars were drawn three pixels wide with an
 * antialiased edge eating one of them from each side. 0.36 is the broad nib a
 * battle map is actually drawn with: half again the ink, at the same footprint,
 * so the mark still means the same piece of ground.
 */
const CROSS_BAR = 0.34

/**
 * How much of the casing outset a cross's BARS take, against all of it on its
 * arms.
 *
 * An X is read from the notches between its arms, and two bars that thicken as
 * fast as they lengthen close them: two bars of half-width w crossing at 45°
 * have their waist at w√2, so a casing at a full outset on both puts the waist
 * at 0.82 of an arm that reaches 1.22 — and the mark stops looking like a battle
 * cross and starts looking like a blot (it did; photographed on the first
 * attempt at this fix). Growing the arms by the whole outset and the bars by
 * half of it puts the waist at 0.65 against the same 1.22, so each arm stands
 * about half its own length clear, which is what makes the shape an X.
 */
const CROSS_CASING_BAR = 0.55

/**
 * How far a glyph's casing stands outside the glyph, in units of its size.
 *
 * The same idea as `ROUTE_STYLE.haloStroke` — a rim of the opposing tone, so the
 * mark is read against the casing rather than against whatever it landed on —
 * and the same reason it is not simply a scaled-up copy of the glyph: scaling an
 * X by 1.22 scales its BARS by 1.22 too, which for a bar 0.36 wide is a rim of
 * four hundredths of the size and invisible. `glyphShape` therefore takes an
 * OUTSET, in glyph units, and each shape grows by it in the direction that
 * actually puts tone round its edge.
 */
export const MARK_CASING_OUTSET = 0.22

/**
 * The 2-D outline of each marker glyph, in units of its `size` (a radius). x is
 * east, y is north before any bearing is applied.
 *
 * Every entry is a TRIANGLE FAN around its FIRST point, and that constraint is
 * the whole trick: no triangulation library, no winding rules, and the same six
 * lines of code place all four glyphs. It does mean the first point has to see
 * every edge — which is true of a rectangle from any corner and of a chevron
 * from its tip, but *not* of a star from one of its points. A star fanned from a
 * point renders as a lopsided dart (it did), so the star and the circle carry an
 * explicit centre as their first vertex and repeat their first ring point at the
 * end to close the loop.
 *
 * `outset` grows the shape outward by that many glyph units, for the casing pass
 * (`MARK_CASING_OUTSET`). It is a true outset for the dot, the cross and the
 * star; for the chevron it is a scale about the origin, which is the same thing
 * everywhere except at the tail notch, where it deepens the notch by a fifth of
 * the outset. A casing's job is a rim, and the notch has a rim either way.
 */
export function glyphShape(style: MarkerStyle, outset = 0): [number, number][][] {
  switch (style) {
    case 'dot': {
      const r = 1 + outset
      const ring: [number, number][] = [[0, 0]]
      for (let i = 0; i <= 18; i++) {
        const a = (i / 18) * Math.PI * 2
        ring.push([Math.cos(a) * r, Math.sin(a) * r])
      }
      return [ring]
    }
    case 'cross': {
      // The battle cross: an X, not a plus. A plus is a hospital and a church.
      const t = CROSS_BAR + outset * CROSS_CASING_BAR
      const l = 1 + outset
      const bar = (rot: number): [number, number][] =>
        (
          [
            [-l, -t],
            [l, -t],
            [l, t],
            [-l, t],
          ] as [number, number][]
        ).map(([x, y]) => [
          x * Math.cos(rot) - y * Math.sin(rot),
          x * Math.sin(rot) + y * Math.cos(rot),
        ])
      return [bar(Math.PI / 4), bar(-Math.PI / 4)]
    }
    case 'star': {
      // centre first (the fan origin), then the ten alternating points, then
      // the first point again so the last sector closes
      const pts: [number, number][] = [[0, 0]]
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI / 2 + (i / 10) * Math.PI * 2
        const r = (i % 2 === 0 ? 1 : 0.42) + outset
        pts.push([Math.cos(a) * r, Math.sin(a) * r])
      }
      return [pts]
    }
    case 'arrow': {
      // A chevron pointing north (+y) before the bearing rotates it: a broad
      // head with a notched tail, so it reads as an arrowhead rather than a
      // triangle sitting on the line.
      const k = 1 + outset
      return [
        (
          [
            [0, 1.15],
            [-0.85, -0.6],
            [0, -0.15],
            [0.85, -0.6],
          ] as [number, number][]
        ).map(([x, y]) => [x * k, y * k]),
      ]
    }
  }
}

/** A fan of triangles over `shape`, placed on the sphere and turned by `bearing`. */
function fanGeometry(
  shape: [number, number][][],
  lng: number,
  lat: number,
  sizeDeg: number,
  bearingDeg: number,
  radius: number,
  alt: number,
): BufferGeometry {
  // Bearing is clockwise from north; the tangent frame's x is east and y north,
  // so a bearing of 0 must leave the glyph pointing at +y.
  const b = bearingDeg * RAD
  const cosB = Math.cos(b)
  const sinB = Math.sin(b)
  const pos: number[] = []
  for (const poly of shape) {
    const placed = poly.map(([x, y]) => {
      const ex = x * cosB + y * sinB
      const ny = -x * sinB + y * cosB
      return offsetPoint(lng, lat, ex * sizeDeg, ny * sizeDeg, radius, alt)
    })
    for (let i = 1; i + 1 < placed.length; i++)
      pos.push(...placed[0], ...placed[i], ...placed[i + 1])
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  return g
}

/* ----------------------------------------------------------------- ribbons */

/**
 * A ribbon along a route: the shaft of a thrust arrow.
 *
 * Half-width is given per point so the shaft can taper, and the last point is
 * dropped short of the spine's end — `headLen` degrees back — because that is
 * where the arrowhead's base goes. A shaft that ran the whole way would poke out
 * of the head like a pin through a dart.
 */
export function ribbonGeometry(
  path: GeoPath,
  halfWidthAt: (t: number) => number,
  radius: number,
  alt: number,
): BufferGeometry {
  const pos: number[] = []
  const n = path.length
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)]
    const b = path[Math.min(n - 1, i + 1)]
    // The heading through this point, as a bearing, so the offset is "so many
    // degrees to the left/right of the way we are going".
    const [lng, lat] = path[i]
    const dLng = ((b[0] - a[0] + 540) % 360) - 180
    const dLat = b[1] - a[1]
    const east = dLng * Math.cos(lat * RAD)
    const len = Math.hypot(east, dLat) || 1
    // perpendicular, pointing left of travel
    const px = -dLat / len
    const py = east / len
    const w = halfWidthAt(n > 1 ? i / (n - 1) : 0)
    pos.push(...offsetPoint(lng, lat, px * w, py * w, radius, alt))
    pos.push(...offsetPoint(lng, lat, -px * w, -py * w, radius, alt))
  }
  const idx: number[] = []
  for (let i = 0; i + 1 < n; i++) {
    const a = i * 2
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  return g
}

/**
 * Where a thrust's arrowhead sits and which way it points.
 *
 * The tangent is taken from the last densified segment, so the head follows the
 * curve of the spine rather than the straight line from the first waypoint —
 * an army group that turned south ends up pointing south.
 */
export function headOf(path: GeoPath): { lng: number; lat: number; bearing: number } {
  const a = path[Math.max(0, path.length - 2)]
  const b = path[path.length - 1]
  const dLng = ((b[0] - a[0] + 540) % 360) - 180
  const east = dLng * Math.cos((b[1] * RAD + a[1] * RAD) / 2)
  const bearing = (Math.atan2(east, b[1] - a[1]) / RAD + 360) % 360
  return { lng: b[0], lat: b[1], bearing }
}

/**
 * Trim `headLen` degrees off the end of a path — where the shaft stops so the
 * arrowhead can start. Returns at least the first two points, since a ribbon
 * needs a direction even when the head eats the whole spine.
 */
export function trimEnd(path: GeoPath, headLen: number): GeoPath {
  if (path.length < 2 || !(headLen > 0)) return [...path]
  const RADn = Math.PI / 180
  const segLen = (a: [number, number], b: [number, number]) => {
    const dLng = ((b[0] - a[0] + 540) % 360) - 180
    return Math.hypot(dLng * Math.cos(((a[1] + b[1]) / 2) * RADn), b[1] - a[1])
  }
  let left = headLen
  const out = [...path]
  while (out.length > 2) {
    const d = segLen(out[out.length - 2], out[out.length - 1])
    if (d > left) {
      const f = 1 - left / d
      out[out.length - 1] = slerpPoint(out[out.length - 2], out[out.length - 1], f)
      return out
    }
    left -= d
    out.pop()
  }
  const d = segLen(out[0], out[1])
  if (d > left) out[1] = slerpPoint(out[0], out[1], Math.max(0.05, 1 - left / d))
  return out
}

/* ------------------------------------------------------------------ layer */

export interface DrawingLayerOptions {
  /** The colour every layer that does not name its own is drawn in. */
  color: string
  /** Height above the surface, in globe radii. Above the area cap, below pins. */
  altitude?: number
  /** Screen size, for the fat lines. Set again on resize. */
  resolution?: { width: number; height: number }
  /**
   * What the ink is landing on.
   *
   * Only the LABELS read it, and they have to: a drawing label is white with a
   * hard black halo, which is exactly right over snowfield, forest and ocean
   * and exactly wrong on parchment — the letters vanish into the paper and all
   * that is left is the halo, a grey smear where a word should be. Everything
   * else on this layer carries its own casing and reads on either ground.
   */
  ground?: 'dark' | 'paper'
}

/** How many times the drawing's own width the frame may be before labels go. */
export const LABEL_SPAN_RATIO = 6

/**
 * How wide a drawing is, in degrees of arc: the largest separation between any
 * two of its coordinates. O(n²) over a few dozen points, once per rebuild.
 */
export function drawingExtentDeg(drawing: Drawing | undefined): number {
  const pts = drawingPoints(drawing)
  let max = 0
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      max = Math.max(max, separationDeg(pts[i][1], pts[i][0], pts[j][1], pts[j][0]))
  return max
}

/**
 * Routes sit lowest, then frontlines, then thrusts, then markers, then labels.
 *
 * This is a *paint* order, not a height order: every overlay is at exactly
 * `SURFACE_ALT` and writes no depth, so which one wins where they cross is
 * decided here and nowhere else. That is deliberate — the previous arrangement
 * separated the kinds by a thousandth of a radius each to keep them from
 * z-fighting, and those thousandths were 6 km of parallax apiece.
 */
const KIND_ORDER: Record<DrawingSpec['type'], number> = {
  route: 0,
  frontline: 1,
  thrust: 2,
  marker: 3,
  label: 4,
}

export class DrawingLayer {
  private group = new Group()
  private materials: (MeshBasicMaterial | LineMaterial)[] = []
  private geometries: BufferGeometry[] = []
  private labels: CSS2DObject[] = []
  /** What the ink is landing on; see DrawingLayerOptions.ground. */
  private ground: 'dark' | 'paper' = 'dark'
  private resolution = new Vector2(900, 900)
  /** What is drawn now — so an unchanged spec is not rebuilt on every tick. */
  private currentKey = ''
  /** How wide the drawn thing is, in degrees of arc. See `setViewSpanDeg`. */
  private extentDeg = 0
  /**
   * The dashed pieces of every one-way route, with the distance along the whole
   * route at which each piece starts. `setFlowPhase` walks this; nothing else
   * does. Empty means there is nothing on screen that moves.
   */
  private flowing: { material: LineMaterial; startDist: number; cycle: number }[] = []

  constructor(
    scene: Scene,
    private radius: number,
  ) {
    // Rendered after the globe and the polygon layers so a frontline over a
    // border wins, and with depth *test* on (the planet still hides what is
    // round the back) but no depth *write*, so two overlapping layers of the
    // same drawing do not punch holes in each other.
    this.group.renderOrder = 12
    scene.add(this.group)
  }

  /** The scene node, exposed so a test can count what was built. */
  get object(): Object3D {
    return this.group
  }

  setResolution(width: number, height: number) {
    this.resolution.set(width, height)
    for (const m of this.materials) if (m instanceof LineMaterial) m.resolution.copy(this.resolution)
  }

  /**
   * How much of the planet the camera is showing. Only the LABELS read it.
   *
   * A drawing is authored for the frame "Show on map" flies to, and its labels
   * are spaced for that frame — the five Normandy beaches are 10 km apart. Zoom
   * out to the hemisphere and they collapse into one unreadable smear over the
   * Baltic, which is worse than nothing. The geometry stays (a shrinking arrow
   * is still an arrow); the words go, and come back on the way in.
   *
   * Six times the drawing's own width is the threshold: at that point a label is
   * about a sixth of the way across the frame from its neighbour, which is the
   * last zoom at which they are still telling you which is which.
   */
  setViewSpanDeg(spanDeg: number) {
    const show = !(this.extentDeg > 0) || spanDeg <= this.extentDeg * LABEL_SPAN_RATIO
    for (const l of this.labels) l.visible = show
  }

  /** Is anything drawn here animating? The caller's cue to buy frames. */
  get hasFlow(): boolean {
    return this.flowing.length > 0
  }

  /**
   * Put the flowing dashes where the wall clock says they are.
   *
   * THE pattern for animation under frame-on-demand, and the same one
   * `setCloudDrift` uses: a pure function of `nowMs`, evaluated on every frame
   * that gets drawn, for whatever reason it got drawn. Nothing accumulates, so
   * there is no such thing as a stale frame or a missed step to catch up on —
   * every frame is simply correct. The separate question, how *often* to draw an
   * otherwise idle globe, is the caller's, and `ROUTE_FLOW_INTERVAL_MS` answers
   * it.
   *
   * `dashOffset` is subtracted inside the shader's `mod`, so shifting it
   * *forward* by the phase moves the pattern toward the end of the line — the
   * direction of travel. Each piece adds its own start distance because
   * `computeLineDistances` measures from the piece's own first vertex, and the
   * pieces have to spell one continuous dash pattern.
   */
  setFlowPhase(nowMs: number) {
    const phase = flowPhase(nowMs)
    for (const f of this.flowing) f.material.dashOffset = f.startDist - phase * f.cycle
  }

  /**
   * Show this drawing, or nothing. Rebuilt only when the spec or the options
   * actually differ from what is on screen — the caller is a Vue watcher and
   * will hand us the same drawing many times over.
   *
   * Returns true if anything changed, which is the caller's cue to wake the
   * render pump.
   */
  set(drawing: Drawing | undefined, opts: DrawingLayerOptions): boolean {
    const key = drawing
      ? `${opts.color}|${opts.altitude ?? ''}|${opts.ground ?? ''}|${JSON.stringify(drawing)}`
      : ''
    if (key === this.currentKey) return false
    this.currentKey = key
    this.clear()
    if (opts.resolution) this.resolution.set(opts.resolution.width, opts.resolution.height)
    this.extentDeg = drawingExtentDeg(drawing)
    if (!drawing) return true
    const alt = opts.altitude ?? SURFACE_ALT
    const layers = [...drawing.layers].sort((a, b) => KIND_ORDER[a.type] - KIND_ORDER[b.type])
    this.ground = opts.ground ?? 'dark'
    for (const [i, spec] of layers.entries()) this.build(spec, opts.color, alt, i)
    return true
  }

  private build(spec: DrawingSpec, fallbackColor: string, alt: number, order: number) {
    const hex = spec.color ?? fallbackColor
    const color = new Color(hex)
    switch (spec.type) {
      case 'route':
        for (const path of spec.paths) this.addRoute(path, color, spec, alt, order)
        break
      case 'frontline':
        for (const path of spec.paths) this.addLine(path, color, spec, alt, order)
        break
      case 'thrust':
        this.addThrust(spec, color, alt, order)
        break
      case 'marker':
        this.addMarker(spec, hex, alt, order)
        break
      case 'label':
        this.addLabel(spec, alt)
        break
    }
  }

  /**
   * A polyline's vertices in world space, and the distance along it at each one.
   *
   * The distances are Euclidean along the chords — which is what
   * `computeLineDistances` will measure and what `dashSize` is compared against
   * inside the shader — rather than arc length, so the dash pattern the caller
   * asks for is the dash pattern that appears.
   */
  private place(pts: GeoPath, alt: number): { positions: number[]; cum: number[] } {
    const positions: number[] = []
    const cum: number[] = [0]
    let last: [number, number, number] | undefined
    for (const [lng, lat] of pts) {
      const p = scale(unit(lng, lat), this.radius * (1 + alt))
      positions.push(...p)
      if (last) cum.push(cum[cum.length - 1] + Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]))
      last = p
    }
    return { positions, cum }
  }

  /**
   * ONE ROUTE: a dark casing, and a bright stroke over it that fades toward the
   * end it did not come from.
   *
   * The shape comes from `routePolyline` — a centripetal Catmull-Rom through the
   * authored ports, then great-circle densification — so what lands here is
   * already a smooth curve on the sphere, and this function's whole job is how
   * it is inked.
   *
   * The stroke is ONE fat line carrying the gradient per vertex (`setTaper`),
   * and the gradient is the thing that says which way a voyage went in a still
   * picture. It used to be twenty separate lines at twenty constant opacities,
   * because `LineMaterial` has no per-vertex alpha of its own — that is what
   * `setTaper` and `taperMaterial` add, and collapsing the route to one object
   * is what they bought. Only a *one-way* route is registered as flowing, which
   * is what keeps a two-way trade network from buying a single frame.
   *
   * The casing is one line for the whole route at a constant opacity. It is a
   * casing — its job is that the route is legible over a snowfield, and a casing
   * that faded out would stop doing that exactly where the stroke is faintest.
   */
  private addRoute(
    path: GeoPath,
    color: Color,
    spec: Extract<DrawingSpec, { type: 'route' }>,
    alt: number,
    order: number,
  ) {
    const pts = routePolyline(path)
    if (pts.length < 2) return
    const { positions, cum } = this.place(pts, alt)
    const total = cum[cum.length - 1]
    if (!(total > 0)) return
    const oneway = directionOf(spec) === 'oneway'
    const dashSize = total * (oneway ? ROUTE_STYLE.dash : ROUTE_STYLE.evenDash)
    const gapSize = total * (oneway ? ROUTE_STYLE.gap : ROUTE_STYLE.evenGap)
    const cycle = dashSize + gapSize

    // the casing, solid, under everything
    const haloGeom = new LineGeometry()
    haloGeom.setPositions(positions)
    const haloMat = new LineMaterial({
      color: new Color(ROUTE_STYLE.haloColor).getHex(),
      linewidth: ROUTE_STYLE.haloStroke,
      transparent: true,
      opacity: ROUTE_STYLE.haloOpacity,
      depthWrite: false,
      ...groundBias,
    })
    haloMat.resolution.copy(this.resolution)
    const halo = new Line2(haloGeom, haloMat)
    halo.renderOrder = 12 + order
    this.group.add(halo)
    this.geometries.push(haloGeom)
    this.materials.push(haloMat)

    // …and the stroke: one line, the gradient carried per vertex. See setTaper
    // for why this is not twenty lines any more.
    const geom = new LineGeometry()
    geom.setPositions(positions)
    setTaper(geom, cum.map((d) => taperOpacity(d / total, directionOf(spec))))
    const mat = taperMaterial({
      color: color.getHex(),
      linewidth: ROUTE_STYLE.stroke,
      dashed: true,
      dashScale: 1,
      dashSize,
      gapSize,
      transparent: true,
      // the taper is the alpha now; the material's own opacity is the ceiling
      // the attribute is measured against
      opacity: 1,
      depthWrite: false,
      ...groundBias,
    })
    mat.resolution.copy(this.resolution)
    const line = new Line2(geom, mat)
    line.computeLineDistances()
    line.renderOrder = 12 + order
    this.group.add(line)
    this.geometries.push(geom)
    this.materials.push(mat)
    if (oneway) this.flowing.push({ material: mat, startDist: 0, cycle })

    // …and a dot on each port, in SCREEN pixels like the line.
    //
    // A zero-length fat line is a disc. `LineMaterial` draws round caps on the
    // ends of an undashed segment — the fragment shader keeps everything inside
    // one radius of the endpoint and discards the rest — so a Line2 whose two
    // points are the same place is a circle `linewidth` px across, at that
    // place, at whatever zoom. That is exactly what a port marker wants to be,
    // and it costs no new renderer: it inherits the altitude, the depth bias and
    // the resolution the route already has. A degree-sized glyph cannot do this;
    // it is three pixels wide when the route is framed and eighty one zoom in.
    //
    // Both ports go in ONE object per layer rather than one each: a
    // `LineSegmentsGeometry` holds disjoint segments, and two zero-length ones
    // are two discs for the price of a single draw call.
    const ports = [pts[0], pts[pts.length - 1]].flatMap((end) => {
      const p = scale(unit(end[0], end[1]), this.radius * (1 + alt))
      return [...p, ...p]
    })
    for (const [w, c, o] of [
      [ROUTE_STYLE.stroke * 3.4, new Color(ROUTE_STYLE.haloColor).getHex(), ROUTE_STYLE.haloOpacity],
      [ROUTE_STYLE.stroke * 2.2, color.getHex(), 1],
    ] as [number, number, number][]) {
      const g = new LineSegmentsGeometry()
      g.setPositions(ports)
      const m = new LineMaterial({
        color: c,
        linewidth: w,
        transparent: true,
        opacity: o,
        depthWrite: false,
        ...groundBias,
      })
      m.resolution.copy(this.resolution)
      const dot = new LineSegments2(g, m)
      dot.renderOrder = 12 + order
      this.group.add(dot)
      this.geometries.push(g)
      this.materials.push(m)
    }
  }

  private addLine(
    path: GeoPath,
    color: Color,
    spec: Extract<DrawingSpec, { type: 'frontline' }>,
    alt: number,
    order: number,
  ) {
    // Densified for the same reason routes are (lib/paths.ts): a front drawn
    // between two waypoints 15° apart is a rhumb line, and a rhumb line across
    // the Pripet Marshes is in the wrong marsh. At the ROUTE_SEGMENT_DEG the
    // routes use, not the coarser authoring limit — see `SURFACE_ALT`: a
    // grounded line's chords have to sag less than its clearance or the line
    // disappears into the planet between its own vertices.
    const pts = densifyPath(path, ROUTE_SEGMENT_DEG)
    const { positions } = this.place(pts, alt)
    const geom = new LineGeometry()
    geom.setPositions(positions)
    const dashed = spec.dash === 'dashed'
    const width = spec.width ?? FRONTLINE_WIDTH
    // Dash sizes are in world units for LineMaterial, so they are scaled off the
    // globe's own radius: the same numbers then give the same-looking dash
    // whatever the globe is sized at.
    const mat = new LineMaterial({
      color: color.getHex(),
      linewidth: width,
      dashed,
      dashScale: 1,
      dashSize: this.radius * 0.008,
      gapSize: this.radius * 0.006,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      ...groundBias,
    })
    mat.resolution.copy(this.resolution)
    const line = new Line2(geom, mat)
    if (dashed) line.computeLineDistances()
    line.renderOrder = 12 + order
    this.group.add(line)
    this.geometries.push(geom)
    this.materials.push(mat)
  }

  private addThrust(
    spec: Extract<DrawingSpec, { type: 'thrust' }>,
    color: Color,
    alt: number,
    order: number,
  ) {
    const w = spec.width ?? THRUST_WIDTH_DEG
    const headLen = w * THRUST_HEAD_SCALE
    const spine = densifyPath(spec.path, ROUTE_SEGMENT_DEG)
    const head = headOf(spine)
    const shaft = trimEnd(spine, headLen)
    const taper = spec.taper !== false
    const geom = ribbonGeometry(shaft, (t) => w * (taper ? 0.42 + 0.58 * t : 1), this.radius, alt)
    const mat = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.82,
      side: DoubleSide,
      depthWrite: false,
      ...groundBias,
    })
    const mesh = new Mesh(geom, mat)
    mesh.renderOrder = 12 + order
    this.group.add(mesh)
    this.geometries.push(geom)
    this.materials.push(mat)

    // …and the head, as real geometry oriented on the spine's end tangent.
    //
    // Anchored at the SHAFT'S tip, not at the spine's, and shaped so its base
    // sits at y=0: the shaft was trimmed back by exactly `headLen` to make room,
    // so a head centred on the spine's end floats clear of the line it belongs
    // to (it did, visibly, on every arrow). Built this way the two meet, and the
    // head's point lands on the spine's real end — where the advance stopped.
    const tip = shaft[shaft.length - 1]
    // Half-width of the head, in units of its length: wider than the shaft by
    // enough to read as an arrowhead rather than as the line getting pointy.
    const k = (w * 2.0) / headLen
    const headGeom = fanGeometry(
      [
        [
          [0, 1],
          [-k, 0],
          [0, 0.18],
          [k, 0],
        ],
      ],
      tip[0],
      tip[1],
      headLen,
      head.bearing,
      this.radius,
      alt,
    )
    const headMesh = new Mesh(headGeom, mat)
    headMesh.renderOrder = 12 + order
    this.group.add(headMesh)
    this.geometries.push(headGeom)
  }

  /**
   * ONE MARKER: a casing in the opposing tone, and the glyph over it.
   *
   * The same two-pass arrangement `addRoute` uses, for the same reason and after
   * the same report: a mark with no casing is legible only where the ground
   * happens to differ from it, and the ground a battle plan is drawn on is
   * whatever the map has there — a thrust ribbon, a coastline, a lake, or
   * parchment the same value as the mark itself. What is new in round 52 is that
   * BOTH tones are resolved from the ground (`markInk`), because the drawn map
   * inverted the problem: on a photograph the glyph is bright and its casing
   * dark, and on paper the glyph is ink and its casing is the paper's own
   * highlight. See lib/present/ink.ts for the measurements.
   *
   * The casing is a wider glyph, not a wider line: `MARK_CASING_OUTSET`.
   */
  private addMarker(
    spec: Extract<DrawingSpec, { type: 'marker' }>,
    hex: string,
    alt: number,
    order: number,
  ) {
    const style = spec.style ?? 'dot'
    const size = spec.size ?? MARKER_SIZE_DEG
    const ink = markInk(hex, this.ground)
    const glyph = (outset: number) =>
      fanGeometry(
        glyphShape(style, outset),
        spec.pos[0],
        spec.pos[1],
        size,
        spec.bearing ?? 0,
        this.radius,
        // Exactly the altitude everything else is at. A marker used to be lifted a
        // thousandth of a radius clear of the lines to keep a battle cross from
        // z-fighting with the front it sits on; nothing here writes depth, so the
        // lift bought nothing that KIND_ORDER was not already buying, and it cost
        // 6 km of parallax between a cross and the line under it.
        alt,
      )
    // Casing first and HALF A STEP below the glyph in paint order. Both passes
    // are transparent and exactly coincident in depth, so back-to-front sorting
    // has nothing to separate them and would pick an order per frame; the half
    // step decides it here. It cannot reach the next layer, whose own casing is
    // a whole step above.
    for (const [outset, color, opacity, bump] of [
      [MARK_CASING_OUTSET, ink.casing, ink.casingOpacity, 0],
      [0, ink.fill, 0.95, 0.5],
    ] as const) {
      const geom = glyph(outset)
      const mat = new MeshBasicMaterial({
        color: new Color(color),
        transparent: true,
        opacity,
        side: DoubleSide,
        depthWrite: false,
        ...groundBias,
      })
      const mesh = new Mesh(geom, mat)
      mesh.renderOrder = 12 + order + bump
      this.group.add(mesh)
      this.geometries.push(geom)
      this.materials.push(mat)
    }
    // A marker's label goes ABOVE the glyph, not on it. The offset is in the
    // glyph's own units, so a big cross pushes its label further than a small
    // dot does and the gap looks the same at either size.
    if (spec.label)
      this.addLabel(
        { type: 'label', pos: [spec.pos[0], spec.pos[1] + size * 2.1], text: spec.label },
        alt,
      )
  }

  private addLabel(spec: Extract<DrawingSpec, { type: 'label' }>, alt: number) {
    // A drawing may be rendered where there is no DOM (a test, a build-time
    // check of the geometry); labels are the one part that needs one.
    if (typeof document === 'undefined') return
    const el = document.createElement('div')
    el.className =
      `drawing-label drawing-label--${spec.size ?? 'sm'}` +
      (this.ground === 'paper' ? ' drawing-label--paper' : '')
    el.textContent = spec.text
    if (spec.color) el.style.color = spec.color
    // Labels must never eat a click meant for a pin or the globe behind them.
    el.style.pointerEvents = 'none'
    const obj = new CSS2DObject(el)
    // Anchored at the SURFACE point, not above it. A CSS2D label is screen-space
    // — it is drawn wherever its 3-D anchor projects to — so an anchor lifted
    // clear of the ground slides against the ground exactly like the geometry
    // did, and a label is the one overlay whose whole job is to point at a
    // place. It sits at the same altitude as the glyph it belongs to, and the
    // gap between the two is put in *geographically* by `addMarker`, which is a
    // real distance on the map rather than a height above it.
    const p = scale(unit(spec.pos[0], spec.pos[1]), this.radius * (1 + alt))
    obj.position.set(p[0], p[1], p[2])
    this.group.add(obj)
    this.labels.push(obj)
  }

  private clear() {
    for (const l of this.labels) l.element.remove()
    this.labels = []
    this.flowing = []
    this.group.clear()
    for (const g of this.geometries) g.dispose()
    for (const m of this.materials) m.dispose()
    this.geometries = []
    this.materials = []
  }

  dispose() {
    this.clear()
    this.group.removeFromParent()
  }
}
