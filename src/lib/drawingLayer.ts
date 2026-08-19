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
  ShapeUtils,
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
  areaCapRing,
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
  ZONE_FILL_OPACITY,
  ZONE_OUTLINE_WIDTH,
  type Drawing,
  type DrawingSpec,
  type FrontlineTicks,
  type MarkerStyle,
  type UnitType,
} from './drawing'
import { markInk, STROKE_CASING } from './present/ink'

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
 * THE HIGHEST this layer's ink is ever lifted off the ground, in globe radii.
 * 0.0006 R is 3.8 km — the height of a mountain, not of a satellite.
 *
 * WHY A LIFT COSTS ANYTHING. Overlay geometry drawn at altitude h does not sit
 * on the ground it names: seen from anywhere except straight overhead it lands
 * on the ground *behind* itself, by h·tan(incidence), and the offset swings as
 * the camera orbits. Measured in the shipped build at 1100 px wide, on a feature
 * 45% of the frame from the optical axis:
 *
 *     altitude          172 km view   1921 km view   world view
 *     0.0155 (98.8 km)     336 px         30 px         8 px     ← battle plans
 *     0.0142 (90.5 km)     295 px         27 px         7 px     ← routes
 *     0.0120 (76.5 km)     233 px         23 px         6 px     ← the area cap
 *     0.0006 ( 3.8 km)       9 px          1 px         0 px     ← round 59
 *
 * ROUND 63, and the reader again: *"for many drawings with higher zoom,
 * drawings are still floating."* They were, and the table above says why the
 * fix could not be another smaller number. A FIXED lift is a fixed distance on
 * the planet, so its cost in pixels doubles every time the frame halves — nine
 * pixels at 172 km is seventy at 20 km, and this app's zoom floor is a 160 m
 * frame. Whatever constant is chosen, there is a zoom at which the ink is
 * plainly in the air. So the lift is not a constant any more: see `inkLift`.
 *
 * This value survives as the CEILING — what the lift is clamped to once the
 * camera is far enough out that a mountain's height is worth nothing on screen,
 * and the altitude at which the geometry is built before `setCameraAltitude`
 * scales it. Two reasons to keep it rather than lift by a pure fraction of the
 * camera's height: at world view the depth buffer's quantum at the sub-camera
 * point is ~2.7 km (24-bit, no log depth, near plane at 0.35 of the camera's
 * height), so the ink needs real clearance up there; and a lift proportional to
 * a camera 2.5 radii out would be 4000 km.
 *
 * The OTHER half of round 63 is that a lift was never the whole hover anyway.
 * See `groundFactor`: the rendered planet is a 90x45 polyhedron inscribed in
 * the sphere this layer draws on, so ink at 3.8 km measured 6.9-8.5 km above
 * the ground under it (tests/e2e/repro63.e2e.mjs, before-*). Most of the hover
 * was the planet's own faceting, and no altitude constant can reach that.
 */
export const SURFACE_ALT = 0.0006

/**
 * HOW HIGH THE INK RIDES, as a fraction of the camera's own height.
 *
 * The one number that makes the hover cost the same at every zoom. Ink at
 * height h seen from height H slides against its ground by about
 * 1.07·(h/H)·tan(incidence) of the frame's width; at the 45%-off-axis point a
 * reader actually looks at, tan(incidence) is around 0.45. So h/H = 0.002 puts
 * the slide at a tenth of a percent of the frame — one pixel in a 1100 px
 * window — and keeps it there from the world view down to the last metre of
 * zoom, which is the whole point.
 */
export const LIFT_PER_HEIGHT = 0.002

/**
 * The lift never goes below this, in globe radii. 3e-7 R is 1.9 m.
 *
 * Not a clearance — `groundBias` buys the clearance, in depth-buffer units,
 * which is the unit that is correct at every zoom. This is a floating-point
 * floor: positions are float32 and the globe's radius is 100 scene units, where
 * one ULP is 7.6e-6 — so a lift under about 1e-7 R stops being representable at
 * all and the ink lands exactly on the surface it is meant to be over.
 */
export const MIN_LIFT = 3e-7

/**
 * How deep a chord of one degree dips below the RENDERED planet where it
 * crosses a facet fold, in globe radii.
 *
 * The one thing that still makes a lift necessary at all once the ink is
 * grounded (`groundFactor`). Two facets meet at a ridge with about 4° of
 * dihedral deficit; a chord of arc length L straddling that ridge passes under
 * it by (L/4)·sin(4°) — 1.94 km at L = 1°, and proportionally less for the
 * short segments a close-up plan is authored with. Every builder here reports
 * the longest chord it laid down (`noteSpan`), and the lift is floored at
 * 1.25 times the dip that chord implies.
 *
 * That floor is self-balancing, which is why it is a floor and not a constant:
 * a drawing whose chords are a degree long is a drawing that spans a continent,
 * and 1.94 km of hover is a fifth of a pixel at the zoom anybody looks at a
 * continent from. A drawing authored at the scale of a beach has chords a
 * twentieth of that and a floor to match.
 */
export const FOLD_DIP_PER_DEG = ((Math.PI / 180) * Math.sin(4 * (Math.PI / 180))) / 4

/**
 * HOW HIGH A PIECE OF GEOMETRY THAT WIDE HAS TO RIDE to clear the ground it is
 * drawn on, in globe radii. Two terms, and they change places:
 *
 *  · the FOLD it may straddle (`FOLD_DIP_PER_DEG`), which is what a line cut at
 *    the folds no longer has and a zone's cap still does;
 *  · the CHORD's own sag below the sphere, R(1-cos(L/2)) — nothing at the scale
 *    a plan is authored at, and the whole story for a wash whose triangulation
 *    has been capped at `ZONE_MAX_TRIANGLES`. An 8° cap edge sags 18 km, which
 *    no altitude constant on this layer ever covered: it used to be paid for
 *    out of the 7.8 km the ideal sphere stands above the rendered planet, and
 *    grounding the ink spends exactly that.
 *
 * A quarter over, because the bound is a worst case and the cost of being wrong
 * is a hole in the map.
 */
export const groundClearance = (spanDeg: number): number =>
  1.25 * (1 - Math.cos((spanDeg / 2) * (Math.PI / 180)) + FOLD_DIP_PER_DEG * spanDeg)

/**
 * THE ONE GROUNDING POLICY: how high the ink sits, for a camera at this height.
 *
 * `cameraAlt` and the result are both in globe radii, the units globe.gl's
 * `pointOfView().altitude` is in. `floor` is what the drawing's own geometry
 * needs to stay out of the planet (`groundClearance`).
 *
 * THE FLOOR BEATS THE CEILING, and it has to: `SURFACE_ALT` is a cosmetic cap
 * on how much parallax the reader is asked to tolerate, and the floor is the
 * difference between a wash and a wash with holes in it. Only a drawing
 * authored at continental scale can reach past the cap, and a drawing authored
 * at continental scale is one nobody looks at from 40 km.
 *
 * Everything this layer draws goes through here, and the frontier ink and the
 * polygon caps should: one policy, one place, and a number a test can state.
 */
export const inkLift = (cameraAlt: number, floor = MIN_LIFT): number =>
  Math.max(MIN_LIFT, floor, Math.min(SURFACE_ALT, LIFT_PER_HEIGHT * cameraAlt))

/**
 * THE PLANET IS NOT A SPHERE — it is a 90x45 polyhedron inscribed in one, and
 * this is where its surface actually is.
 *
 * three-globe builds the globe as `SphereGeometry(R, 360/4, 180/4)`
 * (`globeCurvatureResolution`, 4°), so every facet is a pair of flat triangles
 * whose corners touch the ideal sphere and whose middles hang below it. The dip
 * is up to R(1 - cos 2.83°) = 7.8 km at the equator, ~6 km at Normandy's
 * latitude — twice what round 59 spent the whole altitude budget on. Ink drawn
 * on the ideal sphere therefore hovers above the ground it names by the FACET
 * DIP plus its own lift, which measured 6.9 km at the D-Day plan with a lift of
 * 3.8 km, and slid 17 px against the coast at a 40 km frame.
 *
 * So the ink is not drawn on the sphere. Every vertex is placed at
 * `radius · (groundFactor + lift)`: the exact radius of the rendered surface
 * under it, plus a lift that is now free to be tiny. Two things fall out of it
 * for nothing — a chord between two points inside one facet lies IN that
 * facet's plane, so a grounded polyline does not sag at all where the old one
 * sagged 240 m, and the ink's own creases are the ground's creases.
 *
 * This is the RADIAL correction only. The imagery for a lat/lng also lands up
 * to ~5 km to one SIDE of where the sphere puts it, because the texture is
 * interpolated barycentrically across a 4° facet and that is not the radial
 * projection. Correcting that too would register this layer's ink with the
 * photograph and de-register it from the pins, the nation caps and the frontier
 * ink, which are all still on the sphere — a worse map. The tangential term is
 * the globe's own tessellation to answer (`globeCurvatureResolution`), and it
 * does not float: it is a constant offset that neither slides nor swings, which
 * is not what was reported.
 *
 * Longitude is periodic and latitude is clamped, so no caller has to normalise.
 */
export const GLOBE_FACET_DEG = 4

export function groundFactor(lng: number, lat: number): number {
  const n = 180 / GLOBE_FACET_DEG
  // The mesh's grid, in geographic terms: longitude lines at multiples of 4°,
  // latitude lines at 90 - 4k. Verified against the running globe in
  // tests/e2e/repro63.e2e.mjs and against three's own SphereGeometry in
  // tests/drawingLayer.test.ts.
  const u = ((((lng + 180) % 360) + 360) % 360) / GLOBE_FACET_DEG
  const v = Math.min(n, Math.max(0, (90 - lat) / GLOBE_FACET_DEG))
  const iu = Math.floor(u)
  const iv = Math.min(n - 1, Math.floor(v))
  const s = u - iu
  const t = v - iv
  const lng0 = -180 + iu * GLOBE_FACET_DEG
  const lat0 = 90 - iv * GLOBE_FACET_DEG
  // b is the facet's north-west corner; the quad is split along b–d, which is
  // three's own winding for SphereGeometry (indices a,b,d then b,c,d).
  const b = unit(lng0, lat0)
  const d = unit(lng0 + GLOBE_FACET_DEG, lat0 - GLOBE_FACET_DEG)
  const third =
    s >= t ? unit(lng0 + GLOBE_FACET_DEG, lat0) : unit(lng0, lat0 - GLOBE_FACET_DEG)
  // Where the RADIAL through this direction meets the triangle's plane, which
  // is `plane offset / cos(angle to the plane's normal)`. Not the barycentric
  // point at these lng/lat: that is where the IMAGERY lands, and the two differ
  // — the tangential term this correction deliberately leaves alone.
  const nrm = cross(
    [b[0] - third[0], b[1] - third[1], b[2] - third[2]],
    [d[0] - third[0], d[1] - third[1], d[2] - third[2]],
  )
  const dir = unit(lng, lat)
  const denom = dir[0] * nrm[0] + dir[1] * nrm[1] + dir[2] * nrm[2]
  if (!(Math.abs(denom) > 1e-12)) return 1
  // Which of the two triangles a direction really falls in differs from the
  // (s, t) test by up to 0.0013° — the poleward bulge of a chord against the
  // parallel through its ends. Inside that band the wrong triangle's plane is
  // still the right answer to within a few metres, because the two planes meet
  // along the fold the band straddles.
  return (third[0] * nrm[0] + third[1] * nrm[1] + third[2] * nrm[2]) / denom
}

/**
 * A unit direction, put on the ground and lifted: the only way this file turns
 * a place into a position.
 *
 * Takes the direction rather than a lng/lat pair because half its callers have
 * built one in the tangent frame and have no lng/lat to hand; deriving the pair
 * back out is two trig calls, against the alternative of two placement rules
 * that can disagree.
 */
function grounded(
  dir: [number, number, number],
  radius: number,
  alt: number,
): [number, number, number] {
  const lat = Math.asin(Math.max(-1, Math.min(1, dir[1]))) / RAD
  const lng = Math.atan2(dir[0], dir[2]) / RAD
  return scale(dir, radius * (groundFactor(lng, lat) + alt))
}

/** How long a polyline is, in degrees of arc along its own chords. */
export function arcLengthDeg(pts: GeoPath): number {
  let total = 0
  for (let i = 1; i < pts.length; i++)
    total += separationDeg(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0])
  return total
}

/** The longest chord in a polyline, in degrees of arc. Feeds the lift floor. */
export function maxChordDeg(pts: GeoPath): number {
  let max = 0
  for (let i = 1; i < pts.length; i++)
    max = Math.max(max, separationDeg(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]))
  return max
}

/**
 * Does the segment between these two places pass over a facet fold?
 *
 * An endpoint sitting exactly ON a fold does not count, and that is the whole
 * of the epsilon: `splitAtFacets` puts its cut points there on purpose, and a
 * test of "did I cut everything" that answers yes for the cuts themselves is
 * not a test.
 */
export function crossesFold(a: GeoPath[number], b: GeoPath[number]): boolean {
  const spans = (from: number, to: number) => {
    const lo = Math.min(from, to) / GLOBE_FACET_DEG
    const hi = Math.max(from, to) / GLOBE_FACET_DEG
    return Math.floor(lo + 1e-9) !== Math.floor(hi - 1e-9)
  }
  const lngB = a[0] + ((((b[0] - a[0] + 540) % 360) + 360) % 360) - 180
  return spans(a[0], lngB) || spans(90 - a[1], 90 - b[1])
}

/**
 * CUT A POLYLINE AT EVERY FACET FOLD IT CROSSES — the reason a grounded line
 * needs almost no lift at all.
 *
 * A chord whose ends are in one facet lies IN that facet's plane, because both
 * ends were placed on it: it cannot sink below the ground because it *is* the
 * ground. A chord that straddles a fold is the only kind that can, and it
 * passes under the ridge by (L/4)·sin 4° — 1.94 km for a chord a degree long
 * (`FOLD_DIP_PER_DEG`), which is a lift big enough to put the float back.
 *
 * So the crossings get a vertex, and the whole class goes away. It costs about
 * one extra point per four degrees of line, computed once at build.
 *
 * The cut lands on the geographic grid line rather than on the mesh's own edge,
 * and the two are 0.0013° apart — the poleward bulge of a chord against the
 * parallel through its ends. In that sliver the ink is drawn on the neighbour's
 * plane and can sit up to ~10 m low, which is what `MIN_LIFT` is sized for.
 */
export function splitAtFacets(path: GeoPath): GeoPath {
  if (path.length < 2) return [...path]
  const out: GeoPath = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const dLng = ((b[0] - a[0] + 540) % 360) - 180
    const dLat = b[1] - a[1]
    const ts: number[] = []
    // grid lines: longitude at multiples of 4°, latitude at 90 - 4k
    const cuts = (from: number, delta: number, phase: number) => {
      if (!(Math.abs(delta) > 1e-12)) return
      const lo = Math.min(from, from + delta)
      const hi = Math.max(from, from + delta)
      const first = Math.ceil((lo - phase) / GLOBE_FACET_DEG)
      const last = Math.floor((hi - phase) / GLOBE_FACET_DEG)
      // a guard, not a policy: a segment cannot legitimately want hundreds
      for (let k = first; k <= last && k - first < 128; k++) {
        const t = (phase + k * GLOBE_FACET_DEG - from) / delta
        if (t > 1e-9 && t < 1 - 1e-9) ts.push(t)
      }
    }
    cuts(a[0], dLng, 0)
    cuts(a[1], dLat, 2)
    ts.sort((x, y) => x - y)
    let last = 0
    for (const t of ts) {
      if (t - last < 1e-9) continue
      last = t
      out.push([a[0] + dLng * t, a[1] + dLat * t])
    }
    out.push(b)
  }
  return out
}

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
 * A MARK IS A SHEET, and a sheet is drawn in one pass.
 *
 * Every filled mark on this map — a thrust ribbon, an arrow head, a marker glyph
 * — is flat geometry lying on the sphere, and it is double-sided because it is
 * built in lat/lng and some of its triangles come out wound the other way (the
 * same reason the polygon caps are, see `capMaterial` in GlobeView).
 *
 * three renders a TRANSPARENT DoubleSide material twice — back faces, then front
 * faces — so that the two skins of a hollow shell blend in the right order, and
 * it flips `material.side` between them with `needsUpdate = true`, which makes
 * `setProgram` re-derive the material's parameters and rebuild its program cache
 * key on every one of those passes. A sheet has no second skin: each triangle
 * faces the camera or faces away, so the two passes draw disjoint halves of one
 * mark, blended once each, exactly as a single pass draws them. Turning the
 * second pass off halves the draw calls of a battle plan and takes its
 * per-frame material invalidations to nought (measured in
 * tests/e2e/framePerf.e2e.mjs: a plan open, 42 draws and 36 invalidations a
 * frame → 24 and 0).
 */
const flatSheet = { side: DoubleSide, forceSinglePass: true } as const

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
  return grounded(p, radius, alt)
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
 * Half-width of the military glyphs' line-art strokes, in glyph units.
 *
 * ROUND 68. A unit frame and a fortress are LINE ART — a symbol is its outline,
 * not a filled block — and this is the pen they are drawn with. 0.09 of the
 * size puts about the same ink on a 0.45° unit frame as `CROSS_BAR` puts on a
 * battle cross of the same footprint, which is what keeps the new glyphs in
 * the house weight next to the old ones.
 */
export const GLYPH_STROKE = 0.09

/**
 * The APP-6 unit frame's half-extents, in glyph units: a rectangle half again
 * as wide as tall, which is the standard's own proportion for a friendly-unit
 * frame (friend = rectangle; the app draws no hostile diamonds — both sides of
 * a battle are drawn in their layer's colour, which is this map's convention
 * for allegiance already).
 */
export const UNIT_FRAME = { w: 1, h: 2 / 3 } as const

/** How far a unit frame's interior device stands clear of the frame's stroke. */
export const UNIT_DEVICE_INSET = GLYPH_STROKE * 2

/**
 * The star fort's plan, in glyph units: five bastion tips at the full radius,
 * walls drawn back between them. Five because a pentagon with pointed bastions
 * is the trace italienne every seventeenth-century plan draws — three reads as
 * a triangle and six as a snowflake.
 */
export const FORTRESS_PLAN = { bastions: 5, tip: 1, wall: 0.72 } as const

/**
 * The 2-D outline of each marker glyph, in units of its `size` (a radius). x is
 * east, y is north before any bearing is applied.
 *
 * Every entry is a TRIANGLE FAN around its FIRST point, and that constraint is
 * the whole trick: no triangulation library, no winding rules, and the same six
 * lines of code place all the glyphs. It does mean the first point has to see
 * every edge — which is true of a rectangle from any corner and of a chevron
 * from its tip, but *not* of a star from one of its points. A star fanned from a
 * point renders as a lopsided dart (it did), so the star and the circle carry an
 * explicit centre as their first vertex and repeat their first ring point at the
 * end to close the loop.
 *
 * The LINE-ART glyphs (round 68: `unit`, `fortress`) are made of the same fans:
 * an outline is the band between a ring offset outward and inward by the
 * stroke's half-width (`outlineBand`), one convex quad per edge, and a straight
 * stroke is one quad. Mitred corners are shared between neighbouring quads, so
 * a band never overlaps itself — two transparent sheets over one piece of
 * ground blend twice, which is the round-63 cross defect and the reason the
 * saltire inside an infantry frame is one 12-point outline rather than two
 * crossed bars.
 *
 * `outset` grows the shape outward by that many glyph units, for the casing pass
 * (`MARK_CASING_OUTSET`). It is a true outset for the dot, the cross and the
 * star; for the chevron it is a scale about the origin, which is the same thing
 * everywhere except at the tail notch, where it deepens the notch by a fifth of
 * the outset. The line-art glyphs grow their STROKES by `CROSS_CASING_BAR` of
 * it, for the reason the cross's bars do: a thin stroke fattened by the whole
 * outset on both sides closes its own notches and the frame stops reading as a
 * frame.
 *
 * `unitType` is read by `unit` alone: the APP-6 interior device.
 */
export function glyphShape(
  style: MarkerStyle,
  outset = 0,
  unitType?: UnitType,
): [number, number][][] {
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
      //
      // ONE OUTLINE, not two crossed bars, and round 63 is why. Two bars are two
      // fans, and two transparent fans over the same square of ground blend
      // twice: at the 0.95 a glyph is inked at, the middle of the cross came out
      // at 0.9975 — a lighter square in the centre of every battle mark, plainly
      // visible at the zoom the reader had complained about. The twelve-point
      // outline of the same X has no overlap to blend, and costs four triangles
      // where the bars cost four.
      const t = CROSS_BAR + outset * CROSS_CASING_BAR
      const l = 1 + outset
      const ring: [number, number][] = [
        [l, t],
        [t, t],
        [t, l],
        [-t, l],
        [-t, t],
        [-l, t],
        [-l, -t],
        [-t, -t],
        [-t, -l],
        [t, -l],
        [t, -t],
        [l, -t],
      ]
      const c = Math.cos(Math.PI / 4)
      const turned = ring.map(([x, y]): [number, number] => [(x - y) * c, (x + y) * c])
      // …fanned from the centre, which every point of a plus can see, and closed
      // by repeating the first point (the same shape `dot` and `star` are built
      // in, for the same reason).
      return [[[0, 0], ...turned, turned[0]]]
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
    case 'unit': {
      // The APP-6 friendly-unit frame: a rectangle in line art, with the
      // interior device the unitType names. Monochrome on purpose — the
      // layer's colour is the allegiance, exactly as it is for every thrust
      // and frontline of a two-sided battle.
      const t = GLYPH_STROKE + outset * CROSS_CASING_BAR
      const { w, h } = UNIT_FRAME
      const polys = outlineBand(
        [
          [-w, -h],
          [w, -h],
          [w, h],
          [-w, h],
        ],
        t,
      )
      // The device stops clear of the frame's inner edge: butting against it
      // would blend twice where the two meet (see the fan comment above).
      const dw = w - GLYPH_STROKE - UNIT_DEVICE_INSET
      const dh = h - GLYPH_STROKE - UNIT_DEVICE_INSET
      const saltire = () => [saltireRing(dw, dh, t / ((dw + dh) / 2))]
      const oval = (rx: number, ry: number) => outlineBand(ellipseRing(rx, ry), t)
      switch (unitType) {
        case 'infantry':
          polys.push(...saltire())
          break
        case 'armor':
          polys.push(...oval(dw * 0.72, dh * 0.6))
          break
        case 'cavalry':
          // the single diagonal, lower-left to upper-right, lengthened by the
          // casing's own growth so the rim wraps its ends too
          polys.push(strokeQuad([-dw, -dh], [dw, dh], t, outset * CROSS_CASING_BAR))
          break
        case 'artillery': {
          // the filled dot — the one device that is a solid, like the marker dot
          const r = 0.24 + outset * CROSS_CASING_BAR
          const ring: [number, number][] = [[0, 0]]
          for (let i = 0; i <= 14; i++) {
            const a = (i / 14) * Math.PI * 2
            ring.push([Math.cos(a) * r, Math.sin(a) * r])
          }
          polys.push(ring)
          break
        }
        case 'mixed':
          // mechanised: the saltire over the oval, as APP-6 composes them. The
          // two devices cross in four small patches that blend twice; at a
          // glyph's opacity that is a 5% lightening over a few pixels, judged
          // acceptable against drawing the union outline of an X and an oval.
          polys.push(...saltire(), ...oval(dw * 0.72, dh * 0.6))
          break
      }
      return polys
    }
    case 'fortress': {
      // The trace italienne in plan: five pointed bastions round a pentagon,
      // as an outline. One closed ring, banded, so nothing overlaps.
      const t = GLYPH_STROKE + outset * CROSS_CASING_BAR
      const ring: [number, number][] = []
      const n = FORTRESS_PLAN.bastions * 2
      for (let i = 0; i < n; i++) {
        const a = Math.PI / 2 + (i / n) * Math.PI * 2
        const r = i % 2 === 0 ? FORTRESS_PLAN.tip : FORTRESS_PLAN.wall
        ring.push([Math.cos(a) * r, Math.sin(a) * r])
      }
      return outlineBand(ring, t)
    }
  }
}

/**
 * A closed ring drawn as LINE ART: the band between the ring offset outward and
 * inward by the stroke's half-width, one quad per edge, each a fan from its own
 * first corner. The mitred corners come from `offsetPolygon`, so neighbouring
 * quads share their boundary vertices exactly — no crack, and no overlap for
 * transparency to double-blend.
 */
export function outlineBand(ring: [number, number][], halfW: number): [number, number][][] {
  const outer = offsetPolygon(ring, halfW)
  const inner = offsetPolygon(ring, -halfW)
  const out: [number, number][][] = []
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length
    out.push([outer[i], outer[j], inner[j], inner[i]])
  }
  return out
}

/**
 * One straight stroke as a quad: `a` to `b` at half-width `halfW`, the ends
 * pushed out by `lengthen` so a casing pass wraps them as well as the sides.
 */
function strokeQuad(
  a: [number, number],
  b: [number, number],
  halfW: number,
  lengthen = 0,
): [number, number][] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const px = -uy * halfW
  const py = ux * halfW
  const a2 = [a[0] - ux * lengthen, a[1] - uy * lengthen]
  const b2 = [b[0] + ux * lengthen, b[1] + uy * lengthen]
  return [
    [a2[0] + px, a2[1] + py],
    [b2[0] + px, b2[1] + py],
    [b2[0] - px, b2[1] - py],
    [a2[0] - px, a2[1] - py],
  ]
}

/**
 * The infantry saltire as ONE closed outline — two bars drawn as two quads
 * would blend twice where they cross, the round-63 cross defect. Built the way
 * the battle cross is: the 12-point outline of a plus of half-width `t`,
 * turned 45° and stretched anisotropically so its four tips land on the
 * corners (±w, ±h). The stretch keeps it one ring fanned from its own centre,
 * which every point of an X can see.
 */
function saltireRing(w: number, h: number, t: number): [number, number][] {
  const plus: [number, number][] = [
    [1, t],
    [t, t],
    [t, 1],
    [-t, 1],
    [-t, t],
    [-1, t],
    [-1, -t],
    [-t, -t],
    [-t, -1],
    [t, -1],
    [t, -t],
    [1, -t],
  ]
  // rotate 45° then scale to the corners; the two compose to this one map
  const pts = plus.map(([x, y]): [number, number] => [(x - y) * w, (x + y) * h])
  return [[0, 0], ...pts, pts[0]]
}

/** A closed ellipse ring, for the armor oval. Twenty edges is a smooth oval. */
function ellipseRing(rx: number, ry: number, segments = 20): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    pts.push([Math.cos(a) * rx, Math.sin(a) * ry])
  }
  return pts
}

/**
 * A POLYGON GROWN OUTWARD BY `d` — a rim of constant width, which is what a
 * casing is and what scaling a shape about a point is not.
 *
 * The arrowhead's casing used to be the head scaled about the shaft's tip. A
 * scale grows a shape in proportion to how far each part of it is from the
 * anchor, so the chevron's wings — the parts furthest from the tip — grew
 * backwards past the shaft's own end and stood out as two grey flares behind
 * every arrowhead on the map (photographed at Gold and Juno,
 * /tmp/shots63/ink/paintA-thrust-map.png). A true offset has no anchor: each
 * edge slides out along its own normal by exactly `d`, and the corners follow
 * from where the slid edges meet.
 *
 * Winding is measured rather than assumed, so the caller may hand it either.
 * A pair of nearly parallel edges is left at the offset edge's own endpoint
 * instead of chasing an intersection off to infinity.
 */
export function offsetPolygon(poly: [number, number][], d: number): [number, number][] {
  const n = poly.length
  if (n < 3 || !Number.isFinite(d) || d === 0) return poly.map(([x, y]) => [x, y])
  let area = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % n]
    area += x1 * y2 - x2 * y1
  }
  const sign = area >= 0 ? 1 : -1
  // each edge, slid out along its own normal
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n]
    const ex = q[0] - p[0]
    const ey = q[1] - p[1]
    const len = Math.hypot(ex, ey) || 1
    // outward normal for this winding
    const nx = (sign * ey) / len
    const ny = (-sign * ex) / len
    return { px: p[0] + nx * d, py: p[1] + ny * d, ex, ey }
  })
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    // vertex i is where edge i-1 meets edge i
    const a = lines[(i - 1 + n) % n]
    const b = lines[i]
    const det = a.ex * b.ey - a.ey * b.ex
    if (Math.abs(det) < 1e-12 * (Math.hypot(a.ex, a.ey) * Math.hypot(b.ex, b.ey) || 1)) {
      out.push([b.px, b.py])
      continue
    }
    const t = ((b.px - a.px) * b.ey - (b.py - a.py) * b.ex) / det
    out.push([a.px + a.ex * t, a.py + a.ey * t])
  }
  return out
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
 *
 * `t` IS ARC LENGTH ALONG THE SPINE, not the fraction of the vertex list. The
 * two agree only while the spine is sampled evenly, which it stopped being when
 * lines started being cut at the planet's facet folds (`splitAtFacets`): an
 * extra vertex where a thrust crosses 0° meridian would otherwise put a step in
 * the taper at the Greenwich line, which is not a thing an army does.
 */
export function ribbonGeometry(
  path: GeoPath,
  halfWidthAt: (t: number) => number,
  radius: number,
  alt: number,
): BufferGeometry {
  const pos: number[] = []
  const n = path.length
  const cum: number[] = [0]
  for (let i = 1; i < n; i++)
    cum.push(cum[i - 1] + separationDeg(path[i - 1][1], path[i - 1][0], path[i][1], path[i][0]))
  const total = cum[n - 1] || 1
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
    const w = halfWidthAt(n > 1 ? cum[i] / total : 0)
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
 * HOW A THRUST'S SHAFT SWELLS from tail to head, as a fraction of its full
 * half-width, for a point `t` of the way along it by arc length.
 *
 * ROUND 63: *"they should be painted more nicely."* The taper was linear from
 * 0.42 to 1, which over a shaft twenty times its own width is a WEDGE — two
 * straight edges converging on a point, the shape of a doorstop. A brush loaded
 * at the start of a stroke does not do that: it comes up to weight quickly and
 * then holds, so the eye reads a stroke with a beginning rather than a triangle
 * with a base. The exponent is the whole of it — 0.6 puts the shaft at three
 * quarters of full width a fifth of the way along, where the linear ramp was at
 * a little over half.
 *
 * The tail is a hair heavier than it was (0.46 against 0.42) for the same
 * reason: at 0.42 of a half-width the stroke starts at a fifth of its own
 * weight, which on a 60 km arrow is a hairline.
 */
export const THRUST_TAIL = 0.46
export const thrustWidthAt = (t: number): number =>
  THRUST_TAIL + (1 - THRUST_TAIL) * Math.pow(Math.max(0, Math.min(1, t)), 0.6)

/**
 * How many extra spine points the rounded tail is drawn with. Eight is where
 * the semicircle stops being a chamfer; past twelve nothing on screen changes.
 */
const TAIL_SAMPLES = 8

/**
 * THE TAIL, ROUNDED: the spine extended backwards far enough to carry a
 * semicircular cap, and the width profile that draws one.
 *
 * A ribbon has no end caps — it is a strip of quads, so it stops on a straight
 * line across, and a straight line across a stroke's start is a cut rather than
 * an end. Nor does its casing wrap that cut: the casing is the same strip a
 * rim wider, with the same first vertex, so a cased ribbon had a rim down both
 * sides and none across the back.
 *
 * Both are fixed by the same trick, and it needs no new geometry kind. The
 * spine is extended `reach` degrees behind its first point, and the half-width
 * over that stretch follows a circle: √(r² - s²) for s measured back from the
 * authored tail. The strip then draws its own round cap. Because the casing
 * pass runs the SAME extended spine at radius r + rim, the two caps are
 * concentric semicircles, and the rim comes out the same width round the tail
 * as it is down the sides.
 */
export function tailCap(shaft: GeoPath, reach: number): GeoPath {
  if (shaft.length < 2 || !(reach > 0)) return [...shaft]
  const [a, b] = shaft
  const dLng = ((b[0] - a[0] + 540) % 360) - 180
  const east = dLng * Math.cos(a[1] * RAD)
  const len = Math.hypot(east, b[1] - a[1])
  if (!(len > 1e-12)) return [...shaft]
  // backwards along the first segment's heading, in the same east/north frame
  // `ribbonGeometry` takes its perpendicular in
  const bx = -east / len
  const by = -(b[1] - a[1]) / len
  const out: GeoPath = []
  for (let i = TAIL_SAMPLES; i > 0; i--) {
    const s = (reach * i) / TAIL_SAMPLES
    out.push([a[0] + (bx * s) / Math.max(Math.cos(a[1] * RAD), 1e-6), a[1] + by * s])
  }
  return [...out, ...shaft]
}

/* -------------------------------------------------------------- teeth */

/**
 * How a front's teeth are spaced and how long they are, as fractions of the
 * front's OWN length.
 *
 * Not in pixels and not in degrees of arc, and both alternatives were the
 * obvious ones. Pixels would need a screen-space perpendicular, which a fat line
 * has and a piece of geometry does not; degrees of arc would put the same tooth
 * on a 20° front across Russia and on a 1° front across a bridgehead, so one
 * would be a comb and the other a bristle. A fraction of the line's own length
 * makes the mark scale-free *within a drawing*: the June front and the December
 * front are combed the same way whatever size they are, which is the only
 * comparison a reader ever makes.
 *
 * 0.055 puts about eighteen teeth on a front — a comb, not a zip — and 0.022
 * makes each a little over a third of the gap between them, which is the
 * proportion a hachured line is drawn at.
 */
export const FRONTLINE_TICKS = { every: 0.055, length: 0.022 } as const

/**
 * The teeth on a front, as disjoint segments: `[from, to]` pairs walking the
 * line at a constant spacing, each standing perpendicular on the named side.
 *
 * "Left" is left OF TRAVEL along the polyline — the same frame `ribbonGeometry`
 * offsets a thrust's edges in, so the two crosswise constructions on this layer
 * cannot come to disagree about which side is which.
 *
 * Pure geometry over an already densified path, so it is a test's whole subject:
 * count, spacing, side, length.
 */
export function tickSegments(pts: GeoPath, side: FrontlineTicks): [GeoPath[number], GeoPath[number]][] {
  if (pts.length < 2) return []
  const seg: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const d = separationDeg(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0])
    seg.push(d)
    total += d
  }
  if (!(total > 0)) return []
  const step = total * FRONTLINE_TICKS.every
  const len = total * FRONTLINE_TICKS.length
  const sign = side === 'left' ? 1 : -1
  const out: [GeoPath[number], GeoPath[number]][] = []
  // Half a step in from each end: a tooth standing exactly on the end of a front
  // reads as the front turning a corner.
  let next = step / 2
  let walked = 0
  for (let i = 1; i < pts.length && out.length < 400; i++) {
    const d = seg[i - 1]
    while (next <= walked + d && next < total) {
      const t = d > 0 ? (next - walked) / d : 0
      const a = pts[i - 1]
      const b = pts[i]
      const lng = a[0] + (((b[0] - a[0] + 540) % 360) - 180) * t
      const lat = a[1] + (b[1] - a[1]) * t
      // the heading here, as an east/north pair, and the perpendicular of it
      const dLng = ((b[0] - a[0] + 540) % 360) - 180
      const east = dLng * Math.cos(lat * RAD)
      const norm2 = Math.hypot(east, b[1] - a[1]) || 1
      const px = (-(b[1] - a[1]) / norm2) * sign
      const py = (east / norm2) * sign
      out.push([
        [lng, lat],
        [lng + (px * len) / Math.max(Math.cos(lat * RAD), 1e-6), lat + py * len],
      ])
      next += step
    }
    walked += d
  }
  return out
}

/* --------------------------------------------------------------- zone cap */

/**
 * A ZONE'S CAP — a closed ring, filled, lying on the sphere.
 *
 * Three steps, and each is one of this app's existing decisions rather than a
 * new one:
 *
 *  1. `areaCapRing` closes the authored ring and densifies its EDGES onto great
 *     circles, exactly as an event footprint's cap is prepared (lib/paths.ts).
 *  2. `ShapeUtils.triangulateShape` — three's own earcut — triangulates it in
 *     lng/lat. The same library and the same planar assumption three-globe's
 *     polygon layer makes about a cap; the reason the ring is densified first is
 *     written out at `areaCapRing`.
 *  3. …and then every triangle is subdivided to a common order and each vertex
 *     lifted onto the sphere. That step is the one earcut cannot do for us: a
 *     triangle spanning 5° drawn as a flat sheet sags R(1-cos 2.5°) = 6 km below
 *     the sphere it is meant to lie on, which is deeper than `SURFACE_ALT` lifts
 *     it, so the middle of a pocket would be swallowed by its own planet. At the
 *     resolution a route is densified to (`ROUTE_SEGMENT_DEG`, 1°) the sag is
 *     240 m — the same margin every other grounded thing here is built with.
 *
 * The subdivision order is GLOBAL rather than per triangle, because that is what
 * makes the mesh crack-free: two triangles sharing an edge cut it at the same
 * fractions and meet exactly, where a per-triangle order leaves a T-junction and
 * a hairline of ground showing through a wash.
 *
 * Longitudes are unwrapped against the first point before triangulating, so a
 * ring straddling the antimeridian is one shape rather than two continents
 * apart; `unit` is periodic in longitude, so nothing has to be wrapped back.
 */
export const ZONE_MAX_TRIANGLES = 4000

/**
 * THE WASH POOLS AT ITS EDGE — how much heavier a zone's fill is right at the
 * ring, and how far in that lasts as a share of the zone's own reach.
 *
 * ROUND 63, and the only one of the painterly auditions that is about a FILL.
 * A flat 18% alpha over a whole pocket is a lid: it says "tinted" without
 * saying "by hand", and on parchment (`#ece2c8`, and a zone is drawn on it as
 * often as on a photograph) a flat 18% of a pale accent is very nearly nothing
 * at all in the middle and equally nothing at the rim. Watercolour does not
 * behave that way — the pigment carries to the edge of the wet area and dries
 * darker there, which is the single most recognisable thing about a hand-tinted
 * map.
 *
 * So the wash carries a SKIRT: a strip of the same colour lying just inside the
 * ring, in the same buffer, whose alpha is strongest at the ring and nothing at
 * its inner edge. `edge` is how much extra tint it lays down there, in units of
 * the wash's own alpha — half again is enough to read as a deliberate edge and
 * not enough to become a second outline, and the zone already has a dashed one.
 * `band` is how far in it reaches, as a share of the radius of a disc the
 * zone's own size, so a bridgehead and an occupation zone pool over the same
 * fraction of themselves rather than over the same number of kilometres.
 *
 * It costs NO draw call and no texture: the skirt is appended to the cap's own
 * geometry, and the ramp across it is two lines of the fragment shader
 * (`pooledMaterial`). One mesh, one material, one pass.
 */
export const ZONE_POOL = { edge: 1.9, band: 0.28 } as const

export function capGeometry(
  ring: GeoPath,
  radius: number,
  alt: number,
  maxEdgeDeg = ROUTE_SEGMENT_DEG,
): BufferGeometry {
  const g = new BufferGeometry()
  if (ring.length < 3) {
    g.setAttribute('position', new Float32BufferAttribute([], 3))
    return g
  }
  const closed = areaCapRing(ring)
  // unwrapped, so the planar triangulation sees one shape across the seam.
  // `Vector2` and not a bare pair: `triangulateShape` drops a duplicated end
  // point with `.equals`, so the contour has to be three's own type.
  const flat: Vector2[] = []
  for (const [lng, lat] of closed) {
    const prev = flat.length ? flat[flat.length - 1].x : lng
    flat.push(new Vector2(prev + (((lng - prev + 540) % 360) - 180), lat))
  }
  const faces = ShapeUtils.triangulateShape(flat, [])
  if (!faces.length) {
    g.setAttribute('position', new Float32BufferAttribute([], 3))
    return g
  }
  // the order every triangle is cut to: enough for the worst edge, capped so a
  // ring authored at continental scale cannot ask for a million triangles
  let worst = 0
  for (const [a, b, c] of faces)
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ])
      worst = Math.max(worst, separationDeg(flat[p].y, flat[p].x, flat[q].y, flat[q].x))
  const wanted = Math.max(1, Math.ceil(worst / maxEdgeDeg))
  const n = Math.max(1, Math.min(wanted, Math.floor(Math.sqrt(ZONE_MAX_TRIANGLES / faces.length))))
  // What the caller needs for the lift floor: the longest edge any triangle in
  // this mesh actually ends up with, once the global subdivision order has been
  // capped. See `FOLD_DIP_PER_DEG`.
  g.userData.maxEdgeDeg = worst / n
  const pos: number[] = []
  // …and, per vertex, what the pooled edge (`ZONE_POOL`) should do to its
  // alpha: 2 for the wash itself, and 0 at the ring falling to 1 inward for the
  // skirt below. See `pooledMaterial` for the ramp it feeds.
  const pool: number[] = []
  const at = (a: Vector2, b: Vector2, c: Vector2, i: number, j: number) => {
    const u = i / n
    const v = j / n
    pool.push(2)
    return grounded(
      unit(a.x + (b.x - a.x) * u + (c.x - a.x) * v, a.y + (b.y - a.y) * u + (c.y - a.y) * v),
      radius,
      alt,
    )
  }
  for (const [ia, ib, ic] of faces) {
    const a = flat[ia]
    const b = flat[ib]
    const c = flat[ic]
    for (let i = 0; i < n; i++)
      for (let j = 0; i + j < n; j++) {
        pos.push(...at(a, b, c, i, j), ...at(a, b, c, i + 1, j), ...at(a, b, c, i, j + 1))
        if (i + j + 2 <= n)
          pos.push(
            ...at(a, b, c, i + 1, j),
            ...at(a, b, c, i + 1, j + 1),
            ...at(a, b, c, i, j + 1),
          )
      }
  }
  // THE POOLED EDGE, as a SKIRT: one strip of quads lying just inside the ring,
  // in the same buffer as the wash and drawn in the same call.
  //
  // The obvious construction — a distance-to-the-ring per cap vertex, ramped in
  // the shader — was built first and does not work, and why is worth writing
  // down. A cap's triangulation is as coarse as its ring: a four-sided zone is
  // FOUR TRIANGLES, every one of whose vertices is on the boundary, so a
  // distance field sampled at them is nought everywhere and the ramp has
  // nothing to ramp across (measured in the running app: twelve vertices, every
  // one at distance nought). Subdividing the cap fine enough to carry a band a
  // tenth of the zone's width would take a pocket from four triangles to a few
  // thousand, on a layer whose whole budget argument is that a selection may
  // not add per-frame cost.
  //
  // A skirt costs two triangles per ring edge — forty on a densified pocket —
  // needs no distance field, and puts the tint exactly where a wash pools.
  const ringPts = flat.slice(0, flat.length - (flat.length > 1 && flat[0].equals(flat[flat.length - 1]) ? 1 : 0))
  if (ringPts.length >= 3) {
    // A fair metric: longitudes are shorter than latitudes away from the
    // equator, and a band that ignored it would be a wide skirt in Norway.
    const meanLat = ringPts.reduce((t, p) => t + p.y, 0) / ringPts.length
    const kx = Math.max(Math.cos(meanLat * RAD), 0.05)
    let area = 0
    for (let i = 0; i < ringPts.length; i++) {
      const p = ringPts[i]
      const q = ringPts[(i + 1) % ringPts.length]
      area += p.x * kx * q.y - q.x * kx * p.y
    }
    // the radius of a disc of the zone's own area: a scale-free "how big is
    // this pocket" that does not care whether it is a crescent or a square
    const band = Math.sqrt(Math.abs(area) / 2 / Math.PI) * ZONE_POOL.band
    const inner = offsetPolygon(
      ringPts.map((p) => [p.x * kx, p.y] as [number, number]),
      -band,
    ).map(([x, y]) => new Vector2(x / kx, y))
    for (let i = 0; i < ringPts.length; i++) {
      const j = (i + 1) % ringPts.length
      const quad: [Vector2, number][] = [
        [ringPts[i], 0],
        [ringPts[j], 0],
        [inner[j], 1],
        [inner[i], 1],
      ]
      for (const [p, q, r] of [
        [quad[0], quad[1], quad[2]],
        [quad[0], quad[2], quad[3]],
      ]) {
        for (const [v, w] of [p, q, r]) {
          pos.push(...grounded(unit(v.x, v.y), radius, alt))
          pool.push(w)
        }
      }
    }
  }
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('poolDist', new Float32BufferAttribute(pool, 1))
  return g
}

/**
 * A `MeshBasicMaterial` whose alpha rises toward the edge of the shape, from
 * the `poolDist` attribute `capGeometry` writes. See `ZONE_POOL`.
 *
 * Four string substitutions against three's own basic shader, each anchored on
 * a whole `#include` line so a miss is a compile error rather than a silently
 * wrong picture — the same contract `taperMaterial` is written under, and the
 * cache key has to differ for the same reason.
 */
function pooledMaterial(
  params: ConstructorParameters<typeof MeshBasicMaterial>[0],
): MeshBasicMaterial {
  const mat = new MeshBasicMaterial(params)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPoolEdge = { value: ZONE_POOL.edge }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <clipping_planes_pars_vertex>',
        '#include <clipping_planes_pars_vertex>\nattribute float poolDist;\nvarying float vPool;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvPool = poolDist;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <clipping_planes_pars_fragment>',
        '#include <clipping_planes_pars_fragment>\nvarying float vPool;\nuniform float uPoolEdge;',
      )
      .replace(
        '#include <opaque_fragment>',
        // vPool of 2 is the wash, which is left alone; 0..1 is the skirt, whose
        // alpha is the EXTRA only and falls to nothing at its inner edge, so
        // there is no step where the two meet.
        'float pool = 1.0 - clamp( vPool, 0.0, 1.0 );\n\tdiffuseColor.a *= vPool <= 1.0 ? ( uPoolEdge - 1.0 ) * pool * pool : 1.0;\n\t#include <opaque_fragment>',
      )
  }
  mat.customProgramCacheKey = () => 'zonePool'
  return mat
}

/**
 * Where a zone's own label goes: the mean of its ring, with longitudes unwrapped
 * so a ring across the seam does not label itself on the far side of the planet.
 *
 * A centroid would be more correct for a crescent and is not worth the code: a
 * zone is a pocket or a perimeter, its label is a word inside it, and the reader
 * cannot tell a centroid from a mean of a ring they can see.
 */
export function ringCentre(ring: GeoPath): [number, number] {
  let lng = ring[0][0]
  let sumLng = 0
  let sumLat = 0
  for (const [x, y] of ring) {
    lng += ((x - lng + 540) % 360) - 180
    sumLng += lng
    sumLat += y
  }
  const mean = sumLng / ring.length
  return [((mean + 540) % 360) - 180, sumLat / ring.length]
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
 * The midpoint of a polyline BY ARC LENGTH, and the bearing through it — where
 * a `strength` label sits and which way it runs (round 68). Arc length rather
 * than the middle vertex for the reason `ribbonGeometry`'s taper is: the spine
 * is cut at facet folds and densified unevenly, and "halfway along the arrow"
 * is a place, not an index.
 */
export function midOf(path: GeoPath): { lng: number; lat: number; bearing: number } {
  if (path.length === 1) return { lng: path[0][0], lat: path[0][1], bearing: 0 }
  const cum: number[] = [0]
  for (let i = 1; i < path.length; i++)
    cum.push(cum[i - 1] + separationDeg(path[i - 1][1], path[i - 1][0], path[i][1], path[i][0]))
  const half = cum[cum.length - 1] / 2
  let i = 1
  while (i < path.length - 1 && cum[i] < half) i++
  const a = path[i - 1]
  const b = path[i]
  const seg = cum[i] - cum[i - 1]
  const f = seg > 0 ? (half - cum[i - 1]) / seg : 0
  const dLng = ((b[0] - a[0] + 540) % 360) - 180
  const lng = ((a[0] + dLng * f + 540) % 360) - 180
  const lat = a[1] + (b[1] - a[1]) * f
  const east = dLng * Math.cos(lat * RAD)
  const bearing = (Math.atan2(east, b[1] - a[1]) / RAD + 360) % 360
  return { lng, lat, bearing }
}

/**
 * A bearing, as the CSS rotation that lays text ALONG it, kept upright.
 *
 * The globe's camera never rolls, so at the centre of the frame screen-up is
 * north and text running along bearing b is rotated (b − 90°) clockwise from
 * horizontal; anything that would come out upside-down is turned 180°, because
 * a map label reads along a line in whichever direction keeps it legible. Away
 * from the frame's centre meridian convergence tilts this by a few degrees —
 * accepted, because a CSS2D label is placed once per build and the exact
 * screen tangent is a per-frame projection this layer deliberately never does.
 */
export function textAngleDeg(bearing: number): number {
  let a = (((bearing - 90) % 360) + 360) % 360
  if (a > 90 && a <= 270) a -= 180
  return ((a + 540) % 360) - 180
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
 * Zones sit lowest, then routes, then frontlines, then thrusts, then markers,
 * then labels.
 *
 * This is a *paint* order, not a height order: every overlay is at exactly
 * `SURFACE_ALT` and writes no depth, so which one wins where they cross is
 * decided here and nowhere else. That is deliberate — the previous arrangement
 * separated the kinds by a thousandth of a radius each to keep them from
 * z-fighting, and those thousandths were 6 km of parallax apiece.
 *
 * A zone is under everything because it is a WASH: it says what was inside a
 * ring, and a wash laid over the arrows that closed the ring would be exactly
 * the "battle plan read through a filter" the area cap steps aside to avoid.
 */
const KIND_ORDER: Record<DrawingSpec['type'], number> = {
  zone: 0,
  route: 1,
  frontline: 2,
  thrust: 3,
  marker: 4,
  label: 5,
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
  /** The altitude the geometry on screen was BUILT at. See `setCameraAltitude`. */
  private builtAlt = SURFACE_ALT
  /** The longest chord anything in this drawing laid down. See `noteSpan`. */
  private spanDeg = 0
  /** Where the camera is, in globe radii. The lift is a function of it. */
  private cameraAlt = 2.5
  /** The lift on screen now, so an unchanged camera does not touch the group. */
  private lift = SURFACE_ALT
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

  /**
   * WHERE THE CAMERA IS, which is the only thing the lift depends on. In globe
   * radii, straight from `pointOfView().altitude`. Returns true if the ink
   * moved — the caller's cue to wake the render pump.
   *
   * The lift is applied as a UNIFORM SCALE on the group rather than by
   * rebuilding the geometry, and that is the whole reason this can run on every
   * camera event of every gesture. A scale about the globe's centre is a purely
   * radial move for every vertex at once, which is exactly what a change of
   * altitude is; it costs one matrix, no allocation, and no geometry is touched.
   *
   * It is not quite exact, and the error is worth stating: the ink is built at
   * `radius·(groundFactor + builtAlt)` where `groundFactor` is within 0.12% of
   * 1, so scaling by (1+lift)/(1+builtAlt) lands the lift within
   * 0.0012·(lift - builtAlt) of where it was asked for — under five metres at
   * the very worst, against a lift whose own job is measured in kilometres.
   *
   * Nothing else in the group cares. A fat line's width is in screen pixels and
   * a dash pattern is measured in the geometry's own local units, so neither
   * moves; a CSS2D label is placed from its world matrix, so it follows.
   */
  setCameraAltitude(cameraAlt: number): boolean {
    this.cameraAlt = cameraAlt
    return this.applyLift()
  }

  /**
   * `span` if a mark that wide, laid along these points, reaches a facet fold —
   * and nought if it stays inside one facet, where nothing can sag at all.
   *
   * The two ways to reach one: a run of points that crosses a fold, and a point
   * sitting close enough to one that the mark's own width does.
   */
  private foldSpan(pts: GeoPath, span: number): number {
    const wrap = (v: number) => ((v % GLOBE_FACET_DEG) + GLOBE_FACET_DEG) % GLOBE_FACET_DEG
    for (let i = 0; i < pts.length; i++) {
      if (i && crossesFold(pts[i - 1], pts[i])) return span
      const dLng = wrap(pts[i][0])
      const dLat = wrap(pts[i][1] - 2)
      if (Math.min(dLng, GLOBE_FACET_DEG - dLng) <= span) return span
      if (Math.min(dLat, GLOBE_FACET_DEG - dLat) <= span) return span
    }
    return 0
  }

  /** The floor the drawing's own chords put under the lift. See `FOLD_DIP_PER_DEG`. */
  private noteSpan(deg: number) {
    if (deg > this.spanDeg) {
      this.spanDeg = deg
      this.applyLift()
    }
  }

  private applyLift(): boolean {
    const want = inkLift(this.cameraAlt, groundClearance(this.spanDeg))
    // A relative epsilon, for the same reason `povMoved` has one: OrbitControls
    // damping leaves the altitude wandering in the last few digits, and a scale
    // rewritten sixty times a second to the same value is sixty wasted frames.
    if (Math.abs(want - this.lift) <= Math.max(this.lift, want) * 0.02) return false
    this.lift = want
    this.group.scale.setScalar((1 + want) / (1 + this.builtAlt))
    return true
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
    this.builtAlt = alt
    const layers = [...drawing.layers].sort((a, b) => KIND_ORDER[a.type] - KIND_ORDER[b.type])
    this.ground = opts.ground ?? 'dark'
    for (const [i, spec] of layers.entries()) this.build(spec, opts.color, alt, i)
    // The lift belongs to the camera, not to the rebuild: a drawing that
    // appears while the reader is at 40 km has to arrive on the ground, not at
    // the altitude the geometry happened to be built at.
    this.lift = alt
    this.group.scale.setScalar(1)
    this.applyLift()
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
        // The strength at the LINE's midpoint (round 68) — of the first path,
        // because a multi-path front is one front and one count, and writing
        // it once per piece would claim the count once per piece.
        if (spec.strength && spec.paths.length && spec.paths[0].length >= 2) {
          const mid = midOf(densifyPath(spec.paths[0], ROUTE_SEGMENT_DEG))
          this.addLabel(
            { type: 'label', pos: [mid.lng, mid.lat], text: spec.strength },
            alt,
            { extraClass: 'drawing-label--strength' },
          )
        }
        break
      case 'thrust':
        this.addThrust(spec, color, alt, order)
        break
      case 'zone':
        this.addZone(spec, color, alt, order)
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
  private place(raw: GeoPath, alt: number): { positions: number[]; cum: number[] } {
    const positions: number[] = []
    const cum: number[] = [0]
    let last: [number, number, number] | undefined
    // Every line on this globe is cut at the planet's own folds before it is
    // placed, which is what lets the lift be metres rather than kilometres. See
    // `splitAtFacets`. It costs a handful of vertices on a line that already
    // has one every degree, and the dash distances below are measured after it,
    // so nothing downstream can tell.
    const pts = splitAtFacets(raw)
    for (const [lng, lat] of pts) {
      const p = grounded(unit(lng, lat), this.radius, alt)
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
      const p = grounded(unit(end[0], end[1]), this.radius, alt)
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

  /**
   * ONE FRONTLINE: a casing, its teeth, then the stroke and its teeth over them.
   *
   * The two passes are the whole of what round 60 added here. A front is drawn
   * over whatever the map has — a hatched sea, a snowfield, a thrust ribbon, and
   * on the drawn map a parchment whose value is not far off half the palette —
   * and a bare 2.4 px line reads on some of that and dissolves into the rest.
   * `STROKE_CASING` (lib/present/ink.ts) is the same rim a route has always
   * carried, and this is it promoted to every stroke.
   *
   * The casing DASHES WITH THE STROKE, where a route's is solid under a dashed
   * line. The two dashes mean opposite things: a route's is decoration and its
   * casing's job is to say the pieces are one route, while a front's dash is the
   * data — approximate, projected, or in dispute — and a solid rim under it
   * would put the line back that the author deliberately broke.
   */
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
    const dashed = spec.dash === 'dashed'
    const width = spec.width ?? FRONTLINE_WIDTH
    // The teeth, if this front names a side. Built from the same densified
    // polyline the stroke is, so they stand on the line rather than near it.
    const teeth = spec.ticks
      ? tickSegments(pts, spec.ticks).flatMap(([a, b]) => [
          ...this.place([a], alt).positions,
          ...this.place([b], alt).positions,
        ])
      : []
    // Casings first and half a step below, then the strokes: two transparent
    // sheets at exactly the same depth have nothing to sort by, so paint order
    // decides it here (the same half-step `addMarker` uses).
    for (const [hex, opacity, extra, bump] of [
      // the casing…
      [new Color(STROKE_CASING.color).getHex(), STROKE_CASING.opacity, STROKE_CASING.widen, 0],
      // …and the stroke over it
      [color.getHex(), 0.95, 0, 0.5],
    ] as const) {
      // Dash sizes are in world units for LineMaterial, so they are scaled off
      // the globe's own radius: the same numbers then give the same-looking dash
      // whatever the globe is sized at.
      const mat = new LineMaterial({
        color: hex,
        linewidth: width + extra,
        dashed,
        dashScale: 1,
        dashSize: this.radius * 0.008,
        gapSize: this.radius * 0.006,
        transparent: true,
        opacity,
        depthWrite: false,
        ...groundBias,
      })
      mat.resolution.copy(this.resolution)
      const geom = new LineGeometry()
      geom.setPositions(positions)
      const line = new Line2(geom, mat)
      if (dashed) line.computeLineDistances()
      line.renderOrder = 12 + order + bump
      this.group.add(line)
      this.geometries.push(geom)
      this.materials.push(mat)
      if (!teeth.length) continue
      // Every tooth in ONE object: `LineSegmentsGeometry` holds disjoint
      // segments, so eighteen teeth are eighteen marks for one draw call. Solid
      // whatever the front does — a tooth is shorter than one dash.
      const tg = new LineSegmentsGeometry()
      tg.setPositions(teeth)
      const tm = new LineMaterial({
        color: hex,
        // a hair thinner than the line they hang off, which is how a hachure is
        // drawn and what keeps eighteen of them from out-weighing the front
        linewidth: width * 0.8 + extra,
        transparent: true,
        opacity,
        depthWrite: false,
        ...groundBias,
      })
      tm.resolution.copy(this.resolution)
      const marks = new LineSegments2(tg, tm)
      marks.renderOrder = 12 + order + bump
      this.group.add(marks)
      this.geometries.push(tg)
      this.materials.push(tm)
    }
  }

  /**
   * ONE ZONE: a wash inside the ring, and a dashed edge round it.
   *
   * The fill is `capGeometry` — the same preparation an event footprint's cap
   * gets, triangulated and dropped onto the sphere (see there). The edge is an
   * ordinary dashed FRONTLINE through the closed ring, which is not a shortcut:
   * a zone's boundary is a line on this map like any other, so it gets the same
   * densification, the same casing and the same screen-pixel weight, and there
   * is one piece of code that knows how to put a line on a sphere.
   *
   * Dashed on purpose. A pocket's edge is where a ring closed, not a surveyed
   * frontier, and every zone this vocabulary is for — a siege perimeter, a
   * bridgehead, an occupation area — is an approximation of the same kind.
   */
  private addZone(
    spec: Extract<DrawingSpec, { type: 'zone' }>,
    color: Color,
    alt: number,
    order: number,
  ) {
    const geom = capGeometry(spec.ring, this.radius, alt)
    // A cap is triangles, and a triangle straddling a facet fold dips under it
    // exactly as a chord does — so the wash reports its own worst edge. Not cut
    // at the folds like a line is: a crack-free triangulation is a global
    // subdivision order (see `capGeometry`), and inserting vertices along one
    // fold would put a T-junction through the wash. A zone big enough to reach
    // a fold is a zone nobody reads at 40 km.
    this.noteSpan(this.foldSpan(spec.ring, (geom.userData.maxEdgeDeg as number) ?? 0))
    // The wash, with its edge pooled (`ZONE_POOL`). Still one mesh, one
    // material, one draw call, and still `forceSinglePass`: it is one sheet.
    const mat = pooledMaterial({
      color,
      transparent: true,
      opacity: ZONE_FILL_OPACITY,
      ...flatSheet,
      depthWrite: false,
      ...groundBias,
    })
    const mesh = new Mesh(geom, mat)
    mesh.renderOrder = 12 + order
    this.group.add(mesh)
    this.geometries.push(geom)
    this.materials.push(mat)
    const [first] = spec.ring
    const last = spec.ring[spec.ring.length - 1]
    const closed =
      first[0] === last[0] && first[1] === last[1] ? spec.ring : [...spec.ring, first]
    this.addLine(
      closed,
      color,
      { type: 'frontline', paths: [], dash: 'dashed', width: ZONE_OUTLINE_WIDTH },
      alt,
      order,
    )
    if (spec.label) this.addLabel({ type: 'label', pos: ringCentre(spec.ring), text: spec.label }, alt)
  }

  /**
   * ONE THRUST: a cased ribbon on a SMOOTHED spine, with the head on the curve.
   *
   * The spine goes through `routePolyline` — centripetal Catmull-Rom through the
   * authored waypoints, then great-circle densification — which is the same
   * machinery a route's curve comes from, and deliberately so: there is one
   * owner of curvature on this globe (lib/paths.ts) and an axis of advance is a
   * curve for the same reason a voyage is. Authored as five points and drawn as
   * five chords, Army Group Centre read as a survey traverse; through the
   * spline it reads as an arm swung round Minsk. Everything downstream follows
   * for free — `headOf` takes its bearing off the last *smoothed* segment, so
   * the arrowhead points where the advance was actually going at the end rather
   * than along the last authored chord.
   *
   * Casing, then fill, in two passes over the same construction at two widths:
   * `STROKE_CASING.outset` is in units of the shaft's own half-width, since a
   * ribbon is measured in degrees of arc and a rim fixed in pixels would swamp a
   * narrow axis and vanish under a wide one.
   */
  private addThrust(
    spec: Extract<DrawingSpec, { type: 'thrust' }>,
    color: Color,
    alt: number,
    order: number,
  ) {
    const w = spec.width ?? THRUST_WIDTH_DEG
    const headLen = w * THRUST_HEAD_SCALE
    const spine = routePolyline(spec.path)
    const head = headOf(spine)
    const shaft = trimEnd(spine, headLen)
    const taper = spec.taper !== false
    const tip = shaft[shaft.length - 1]
    const rim = w * STROKE_CASING.outset
    // The tail's own semicircle, and the rim's outside it: the spine reaches
    // back far enough to carry the wider of the two. See `tailCap`.
    const tailR = w * (taper ? THRUST_TAIL : 1)
    const capped = taper ? tailCap(shaft, tailR + rim) : shaft
    // A ribbon is a BAND, so cutting its spine at the folds is only half the
    // job: the quads still span the shaft's own width across one. That width is
    // the residue, and only where the band actually meets a fold.
    const cut = splitAtFacets(capped)
    this.noteSpan(this.foldSpan(cut, 2 * w + rim))
    // Where the authored shaft starts, along the extended spine — the centre of
    // the tail's semicircle, in the arc-length units `ribbonGeometry` measures
    // its parameter in.
    const capDeg = taper ? tailR + rim : 0
    const totalDeg = capDeg + Math.max(1e-9, arcLengthDeg(shaft))
    // Half-width of the head, in units of its length: wider than the shaft by
    // enough to read as an arrowhead rather than as the line getting pointy.
    const k = (w * 2.0) / headLen
    for (const [hex, opacity, out, bump] of [
      [new Color(STROKE_CASING.color), STROKE_CASING.opacity, rim, 0],
      [color, 0.82, 0, 0.5],
    ] as const) {
      const mat = new MeshBasicMaterial({
        color: hex,
        transparent: true,
        opacity,
        ...flatSheet,
        depthWrite: false,
        ...groundBias,
      })
      // r is this pass's own tail radius, so the two caps are concentric.
      const r = tailR + out
      const geom = ribbonGeometry(
        cut,
        (t) => {
          const s = t * totalDeg - capDeg
          if (!taper) return w + out
          if (s < 0) return Math.sqrt(Math.max(0, r * r - s * s))
          return w * thrustWidthAt(s / Math.max(1e-9, totalDeg - capDeg)) + out
        },
        this.radius,
        alt,
      )
      const mesh = new Mesh(geom, mat)
      mesh.renderOrder = 12 + order + bump
      this.group.add(mesh)
      this.geometries.push(geom)
      this.materials.push(mat)

      // …and the head, as real geometry oriented on the spine's end tangent.
      //
      // Anchored at the SHAFT'S tip, not at the spine's, and shaped so its base
      // sits at y=0: the shaft was trimmed back by exactly `headLen` to make
      // room, so a head centred on the spine's end floats clear of the line it
      // belongs to (it did, visibly, on every arrow). Built this way the two
      // meet, and the head's point lands on the spine's real end — where the
      // advance stopped. The casing pass grows the chevron OUTWARD by the same
      // rim the shaft grew by — see `offsetPolygon` for what it used to do
      // instead and what that looked like.
      const headGeom = fanGeometry(
        [
          offsetPolygon(
            [
              [0, 1],
              [-k, 0],
              [0, 0.18],
              [k, 0],
            ],
            out / headLen,
          ),
        ],
        tip[0],
        tip[1],
        headLen,
        head.bearing,
        this.radius,
        alt,
      )
      const headMesh = new Mesh(headGeom, mat)
      headMesh.renderOrder = 12 + order + bump
      this.group.add(headMesh)
      this.geometries.push(headGeom)
    }

    // THE STRENGTH ALONG THE SHAFT (round 68) — "troop counts on some arrows".
    // At the smoothed spine's own midpoint, laid along the mid-tangent so it
    // reads as writing ON the arrow rather than a caption near it, and sized
    // with the shaft: an army group's ribbon carries a bigger count than a
    // division's. √ of the width ratio, because label area is what the eye
    // sizes and the default already reads at 1.
    if (spec.strength) {
      const mid = midOf(spine)
      this.addLabel({ type: 'label', pos: [mid.lng, mid.lat], text: spec.strength }, alt, {
        extraClass: 'drawing-label--strength',
        rotateDeg: textAngleDeg(mid.bearing),
        scale: Math.min(1.6, Math.max(0.8, Math.sqrt(w / THRUST_WIDTH_DEG))),
      })
    }
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
    // The widest a glyph's own triangles reach: a cross's bar runs corner to
    // corner, and the casing stands a fifth outside that. It only matters if
    // the glyph is sitting on a fold, which almost none of them are.
    this.noteSpan(this.foldSpan([spec.pos], size * 2 * (1 + MARK_CASING_OUTSET) * Math.SQRT2))
    const ink = markInk(hex, this.ground)
    const glyph = (outset: number) =>
      fanGeometry(
        glyphShape(style, outset, spec.unitType),
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
        ...flatSheet,
        depthWrite: false,
        ...groundBias,
      })
      const mesh = new Mesh(geom, mat)
      mesh.renderOrder = 12 + order + bump
      this.group.add(mesh)
      this.geometries.push(geom)
      this.materials.push(mat)
    }
    // THE ECHELON over a unit frame (round 68): 'XX' is a division, 'XXX' a
    // corps, exactly where APP-6 sets it — above the frame, closer in than a
    // name label so the two never collide. In the frame's own units, so a big
    // frame pushes it as far as a small one, proportionally.
    if (style === 'unit' && spec.unitSize)
      this.addLabel(
        {
          type: 'label',
          pos: [spec.pos[0], spec.pos[1] + size * (UNIT_FRAME.h + 0.55)],
          text: spec.unitSize,
        },
        alt,
        { extraClass: 'drawing-label--unitsize' },
      )
    // A marker's label goes ABOVE the glyph, not on it. The offset is in the
    // glyph's own units, so a big cross pushes its label further than a small
    // dot does and the gap looks the same at either size.
    if (spec.label)
      this.addLabel(
        { type: 'label', pos: [spec.pos[0], spec.pos[1] + size * 2.1], text: spec.label },
        alt,
      )
  }

  private addLabel(
    spec: Extract<DrawingSpec, { type: 'label' }>,
    alt: number,
    /**
     * How the words are SET (round 68): `extraClass` picks the variant (a
     * strength along a shaft, an echelon over a unit frame), `rotateDeg` lays
     * the text along a bearing (`textAngleDeg`), `scale` sizes it with the
     * thing it annotates — a wide thrust carries a bigger count than a narrow
     * one, in em so the paper/dark variants keep their own base sizes.
     */
    opts?: { extraClass?: string; rotateDeg?: number; scale?: number },
  ) {
    // A drawing may be rendered where there is no DOM (a test, a build-time
    // check of the geometry); labels are the one part that needs one.
    if (typeof document === 'undefined') return
    const el = document.createElement('div')
    el.className =
      `drawing-label drawing-label--${spec.size ?? 'sm'}` +
      (this.ground === 'paper' ? ' drawing-label--paper' : '') +
      (opts?.extraClass ? ` ${opts.extraClass}` : '')
    // The turned or scaled part is an INNER element, and has to be:
    // CSS2DRenderer owns the outer element's `transform` — it writes the
    // centring translate inline on every render — so a rotation put there
    // would be overwritten on the next frame.
    if (opts?.rotateDeg || opts?.scale) {
      const inner = document.createElement('div')
      inner.textContent = spec.text
      if (opts.scale) inner.style.fontSize = `${opts.scale}em`
      if (opts.rotateDeg) inner.style.transform = `rotate(${opts.rotateDeg}deg)`
      el.appendChild(inner)
    } else {
      el.textContent = spec.text
    }
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
    const p = grounded(unit(spec.pos[0], spec.pos[1]), this.radius, alt)
    obj.position.set(p[0], p[1], p[2])
    this.group.add(obj)
    this.labels.push(obj)
  }

  private clear() {
    for (const l of this.labels) l.element.remove()
    this.labels = []
    this.flowing = []
    this.spanDeg = 0
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
