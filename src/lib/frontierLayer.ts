import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments, type Scene } from 'three'
import { groundFactor, inkLift, splitAtFacets, SURFACE_ALT } from './drawingLayer'
import type { FrontierInk, InkEntry, Ring } from './nations'

/**
 * POLITICAL INK — the part of a polity's boundary that is a frontier.
 *
 * Why this exists at all, rather than the polygon layer's own stroke. Once the
 * polities are clipped to `land-50m.json` (scripts/clip-nations.mjs), roughly
 * three quarters of every boundary in the corpus IS the coastline — and the
 * drawn map already draws that line, in its own pen, with an eleven-pixel
 * shoreline wash over it. Stroking the polity's outline on top of it puts a
 * second coastline in a nation colour a hair off the first, which is the doubled
 * edge the reader reported. three-globe strokes a polygon as one closed loop and
 * has no way to say "all of it except these edges", so the frontier is drawn
 * here instead and the polygon layer is left with the cap: the fill that says
 * how far the polity reached, and the hover target that names it.
 *
 * ONE OBJECT for every frontier on the globe. Ten polities at a hundred and
 * thirty pieces would be a hundred and thirty draw calls as one line each; as a
 * single `LineSegments` with a colour per vertex it is one, and the colour is
 * still per polity. The DrawingLayer's fat lines were the obvious alternative
 * and are the wrong tool here: it keys its rebuild on `JSON.stringify(drawing)`
 * and measures a drawing's extent with an O(n²) walk over every point, both of
 * which are fine for a battle plan of forty coordinates and neither of which
 * survives twenty-five thousand.
 *
 * GL_LINES rather than fat lines is also what the borders already were — see
 * `polygonStrokeColor` in GlobeView — so the weight, the aliasing and the
 * behaviour under a moving camera are unchanged from what shipped. What changed
 * is which edges are in it.
 */

const RAD = Math.PI / 180

/** Mirrors three-globe's `polar2Cartesian`: y polar, z through (0, 0). */
const unit = (lng: number, lat: number): [number, number, number] => {
  const p = lat * RAD
  const l = lng * RAD
  const c = Math.cos(p)
  return [c * Math.sin(l), Math.sin(p), c * Math.cos(l)]
}

/**
 * THE ALTITUDE THIS LAYER'S GEOMETRY IS BUILT AT, before `setCameraAltitude`
 * scales it to where it belongs. Not the height the ink is drawn at — see
 * `inkLift` in lib/drawingLayer.ts for that, and `applyLift` below for how the
 * built height becomes the real one without touching a vertex.
 *
 * ROUND 63b. This was `FRONTIER_ALT = 0.0013` (8.3 km) — a FIXED altitude, on
 * the layer a reader looks at more than any other, and the same defect round
 * 63a convicted the drawings of, at twice the size. Measured on the Oder at
 * Frankfurt (Oder), the Germany/Poland line, with a nation wash on both banks
 * (tests/e2e/repro63.e2e.mjs, `SECTIONS=frontier`):
 *
 *     frame     hover      slide
 *     500 km    10.87 km    13.4 px
 *     100 km    13.46 km    46.2 px
 *      40 km    13.41 km   126.4 px   ← the border a screen-width off its river
 *
 * The hover is bigger than the altitude because most of it was never the
 * altitude: the rendered planet is a 90x45 polyhedron whose facets hang up to
 * 7.8 km inside the sphere this ink was drawn on (`groundFactor`). 8.3 km of
 * lift plus 5 km of facet dip is the 13.4 km above, and no smaller constant
 * could have reached it.
 *
 * ROUND 55 is still true and is now somebody else's problem: an altitude only
 * buys clearance against a chord whose sag it exceeds, and 314 stored frontier
 * edges in the corpus sag deeper than 8.3 km — Russia's 1700 line along 52°N is
 * one edge across thirty degrees of arc, and its chord passes 217 km below the
 * surface. `borderRings` cuts those into 2° arcs before they ever reach this
 * layer (BORDER_SEGMENT_DEG in lib/nations.ts), and that cut is still what
 * makes the ink follow the ground rather than cut a hole through it. What has
 * changed is the 2° residue: a chord between two GROUNDED points inside one
 * facet lies IN that facet's plane and cannot sag at all, so the 0.97 km this
 * altitude used to have to cover is nought (`splitAtFacets`).
 */
export const FRONTIER_BUILD_ALT = SURFACE_ALT

/**
 * THE FLOOR UNDER A GL_LINE'S LIFT, in globe radii. 1.6e-6 R is 10 m.
 *
 * The drawings can lift by `MIN_LIFT` — under two metres — because a fat line
 * is a strip of TRIANGLES and carries `polygonOffset`, which biases in
 * depth-buffer units and is therefore exactly the right size at every zoom.
 * This layer is GL_LINES on purpose (one draw call for every border on the
 * globe, see the header), and WebGL has no polygon offset for line primitives:
 * `POLYGON_OFFSET_FILL` does nothing to them. Whatever clearance a border has
 * over the planet, it has in METRES.
 *
 * Two clearances are wanted and only one of them is a problem.
 *
 *  · Against the DEPTH BUFFER, none is needed. One quantum of a 24-bit depth
 *    buffer at the surface is about `cameraAlt / (0.35 · 2^24)` radii — 2.7 m
 *    at world view, where `inkLift` is already at its 3.8 km ceiling, and
 *    proportionally less all the way down, where `inkLift` is 0.002·cameraAlt.
 *    The ratio never drops below about 1400.
 *  · Against the GEOMETRY, this much. `splitAtFacets` cuts a line at the
 *    geographic grid line, and the mesh's own edge is up to 0.0013° away from
 *    it — the poleward bulge of a chord against the parallel through its ends.
 *    Inside that sliver a cut vertex is placed on the neighbouring facet's
 *    plane, which is the wrong plane by at most 0.0013°·sin 2° = 8e-7 R, or
 *    5 m; a quarter over is 10 m.
 *
 * It binds only below a 4.8 km frame, where `inkLift` has fallen under it, and
 * costs about one pixel there. Above that the lift is the policy's and this
 * number is not consulted.
 */
export const LINE_FLOOR = 1.6e-6

/** #rrggbb to linear-ish 0..1 triple. Three's `Color` would do it; this is two lines. */
const rgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/**
 * A place on the RENDERED planet, not on the sphere it is inscribed in.
 *
 * `groundFactor` (lib/drawingLayer.ts) is the radius of the actual mesh under a
 * lat/lng — the facet plane the fragment shader will rasterise there, up to
 * 7.8 km inside the ideal sphere. Every vertex in this buffer goes through
 * here, which is what turns a 13 km hover into the lift and nothing else.
 */
const grounded = (lng: number, lat: number, radius: number): [number, number, number] => {
  const u = unit(lng, lat)
  const r = radius * (groundFactor(lng, lat) + FRONTIER_BUILD_ALT)
  return [u[0] * r, u[1] * r, u[2] * r]
}

const place = (lng: number, lat: number, radius: number, positions: number[]) =>
  positions.push(...grounded(lng, lat, radius))

/**
 * What a frontier polyline contributes: one segment per step, both endpoints.
 *
 * The previous point is CARRIED rather than re-placed, which halves the work:
 * GL_LINES wants every interior vertex twice and `grounded` is the expensive
 * call on this layer now — four trig pairs and a plane intersection against the
 * one multiply it used to be. On the worst year on the globe (1941, 306 pieces,
 * 22 726 stored vertices) a full rebuild is 17 ms against the 10 ms it was
 * before grounding; placing each vertex twice made it 25.
 */
function pushLine(
  path: Ring,
  color: [number, number, number],
  radius: number,
  positions: number[],
  colors: number[],
) {
  if (path.length < 2) return
  let prev = grounded(path[0][0], path[0][1], radius)
  for (let i = 1; i < path.length; i++) {
    const next = grounded(path[i][0], path[i][1], radius)
    positions.push(prev[0], prev[1], prev[2], next[0], next[1], next[2])
    colors.push(color[0], color[1], color[2], color[0], color[1], color[2])
    prev = next
  }
}

/**
 * A LINE IN DISPUTE IS DASHED — the outline of a contested zone, round 60.
 *
 * The dashes are cut in the GEOMETRY rather than drawn by a dashed material,
 * and the reason is the one this layer exists for in the first place: one
 * object for every frontier on the globe. `LineDashedMaterial` would need its
 * own material, its own `computeLineDistances` pass and therefore its own
 * `LineSegments`, which is a second draw call and a second thing to keep in
 * step with the first. Cutting a polyline into on and off runs produces exactly
 * the primitive this buffer already holds, so a dashed border costs nothing but
 * fewer vertices than a solid one.
 *
 * It also makes the dash GROUND-FIXED for free, which a screen-space dash is
 * not: the period is measured along the path in degrees of arc, so a dash is a
 * distance on the map and it neither stretches nor marches when the camera
 * moves. That is the same choice the hatch inside the zone makes (lib/hatch.ts)
 * and for the same reason.
 */
export const DASH_DEG = 0.34
export const GAP_DEG = 0.26

/**
 * A SKETCHED FRONTIER IS DASHED TOO — round 64, and the other thing a broken
 * line means on a map. A contested zone's short dash says "two claimants"; a
 * sketch's longer dash says "an estimate" — the frontier of a polity whose
 * line no survey, river or treaty stands behind (`RingEntry.sketch`, cut per
 * edge by the build). The pattern is longer and the gap tighter than the
 * dispute dash so the two read as different pens at a glance: an estimate is
 * most of a line, a dispute is barely half of one.
 */
export const SKETCH_DASH_DEG = 0.62
export const SKETCH_GAP_DEG = 0.24

function pushDashed(
  path: Ring,
  color: [number, number, number],
  radius: number,
  positions: number[],
  colors: number[],
  phase = 0,
  dashDeg = DASH_DEG,
  gapDeg = GAP_DEG,
) {
  const period = dashDeg + gapDeg
  // Where along the current period the walk is; carried across segments so a
  // dash spans a vertex rather than restarting at every one.
  let at = phase % period
  const point = (lng: number, lat: number) => {
    place(lng, lat, radius, positions)
    colors.push(color[0], color[1], color[2])
  }
  for (let i = 0; i + 1 < path.length; i++) {
    const [x0, y0] = path[i]
    const [x1, y1] = path[i + 1]
    // Length in degrees of ground, longitude compressed by its parallel — the
    // same measure the hatch uses, so a dash is the same size in Sudan and in
    // Ukraine.
    const mid = ((y0 + y1) / 2) * RAD
    const dx = (x1 - x0) * Math.cos(mid)
    const dy = y1 - y0
    const len = Math.hypot(dx, dy)
    if (!len) continue
    let t = 0
    while (t < len) {
      const remaining = at < dashDeg ? dashDeg - at : period - at
      const step = Math.min(remaining, len - t)
      if (at < dashDeg) {
        const a = t / len
        const b = (t + step) / len
        point(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a)
        point(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)
      }
      t += step
      at = (at + step) % period
    }
  }
}

const NO_PATHS: Ring[] = []

/**
 * One entry's ink — which part of its boundary is drawn.
 *
 * Four answers rather than the boolean this was, and the two new ones exist for
 * one situation each, both introduced by the modern-states layer (round 57):
 *
 *  · `coast` — the shore ONLY. A polity that has yielded its political ink to
 *    the modern set still needs its outline on the photograph, where there is no
 *    drawn coastline underneath it (see COASTAL_INK).
 *  · `none` — nothing at all. The same polity on the drawn map, where the map
 *    inks its own coast and the frontier is being drawn, better, by somebody
 *    else. Its wash and its label stay; only the duplicate line goes.
 */
export const inkPathsOf = (entry: InkEntry, ink: FrontierInk): Ring[] =>
  ink === 'all'
    ? entry.coordinates
    : ink === 'frontier'
      ? entry.frontier
      : ink === 'coast'
        ? entry.coast
        : NO_PATHS

/**
 * The entry's SKETCHED frontier, drawn dashed — whenever the plan draws its
 * frontier at all ('frontier' on the drawn map, 'all' on the photograph). A
 * contested zone never has sketch runs (its whole outline is the dispute
 * dash), and an entry that yielded its ink ('coast', 'none') dashes nothing.
 */
export const sketchPathsOf = (entry: InkEntry, ink: FrontierInk): Ring[] =>
  (ink === 'frontier' || ink === 'all') && entry.kind !== 'contested' ? entry.sketch : NO_PATHS

/**
 * …and the solid remainder. One subtlety keeps `all` honest: `coordinates` is
 * the whole closed boundary, sketch edges included, so an entry with sketch
 * runs cannot draw its outline as the closed loop without inking the estimate
 * solid underneath its own dashes. It draws the coast and the solid frontier
 * as runs instead — the same edges, minus the sketch — which tile the boundary
 * exactly because the three kinds are one per-edge classification.
 */
export const solidPathsOf = (entry: InkEntry, ink: FrontierInk): Ring[] =>
  ink === 'all' && entry.sketch.length ? [...entry.coast, ...entry.frontier] : inkPathsOf(entry, ink)

export class FrontierLayer {
  private geometry = new BufferGeometry()
  private material: LineBasicMaterial
  private lines: LineSegments
  /** What is drawn now, so an unchanged border list is not rebuilt per tick. */
  private currentKey = ''
  /** Where the camera is, in globe radii. The lift is a function of it. */
  private cameraAlt = 2.5
  /** The lift on screen now, so an unchanged camera does not touch the object. */
  private lift = FRONTIER_BUILD_ALT

  constructor(
    scene: Scene,
    private radius: number,
  ) {
    this.material = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      // Same contract as every other overlay: test depth so the planet hides
      // what is round the back, write none so nothing punches a hole in
      // anything, and bias in depth-buffer units so the line is not eaten by
      // its own map at any zoom (see `groundBias` in lib/drawingLayer.ts).
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    })
    this.lines = new LineSegments(this.geometry, this.material)
    // Under the DrawingLayer's twelve — a battle plan wins over a border — and
    // over the polygon layer's nought, so a frontier is not lost under a fill.
    //
    // ROUND 63b: this, and not an altitude, is what carries the LAYERING the
    // last four rounds argued about, and grounding the ink is only safe because
    // of it. Every cap on this globe — a polity's wash, an event footprint, a
    // contested zone's hatch — is `depthWrite: false` (see `capMaterial` and
    // lib/hatch.ts), so no cap ever writes a depth value for this line to lose
    // to. The only depth in the buffer under a border is the PLANET's, which is
    // what the lift clears; who paints over whom is decided entirely by
    // renderOrder, and three sorts a transparent object by renderOrder before
    // anything else. So the ink stays over its own fill after being lowered
    // fifteen kilometres beneath it, which is the whole reason this change can
    // ground the ink without touching a single cap.
    //
    // What altitude still decides, and what round 60's cap ordering therefore
    // still means, is which of two things a fragment of the PLANET hides. That
    // ordering (contested caps lowest, because a zone is the one cap whose own
    // outline is drawn on top of it) is between caps, all of which are still on
    // the sphere and none of which moved.
    this.lines.renderOrder = 6
    this.lines.frustumCulled = false
    scene.add(this.lines)
  }

  /** The scene node, exposed so a test can count what was built. */
  get object() {
    return this.lines
  }

  /**
   * WHERE THE CAMERA IS, which is the only thing the lift depends on. In globe
   * radii, straight from `pointOfView().altitude`. Returns true if the ink
   * moved — the caller's cue to wake the render pump.
   *
   * The same mechanism, for the same reason, as `DrawingLayer.setCameraAltitude`
   * — a uniform scale about the globe's centre, which is a purely radial move
   * for every vertex at once. It costs one matrix on a buffer of fifty thousand
   * vertices, which is what makes it affordable on every camera event of every
   * gesture; rebuilding this layer's geometry per frame is not, and that is the
   * whole difference between a policy that can track the camera and one that
   * has to pick a constant and live with it.
   *
   * The dash pattern does not move with it: the dashes are cut in the GEOMETRY
   * in degrees of ground (`pushDashed`), so a radial scale of the whole buffer
   * leaves every dash exactly where it was on the map.
   */
  setCameraAltitude(cameraAlt: number): boolean {
    this.cameraAlt = cameraAlt
    return this.applyLift()
  }

  private applyLift(): boolean {
    // No chord-sag floor: a line cut at the folds lies in a facet plane and has
    // nothing to clear but the sliver `LINE_FLOOR` is sized for. That is what
    // separates this layer from a wash, which cannot be cut (see
    // `groundClearance` in lib/drawingLayer.ts).
    const want = inkLift(this.cameraAlt, LINE_FLOOR)
    // A relative epsilon, for the same reason `DrawingLayer.applyLift` has one:
    // OrbitControls damping leaves the altitude wandering in the last few
    // digits, and a scale rewritten sixty times a second to the same value is
    // sixty frames bought for nothing.
    if (Math.abs(want - this.lift) <= Math.max(this.lift, want) * 0.02) return false
    this.lift = want
    this.lines.scale.setScalar((1 + want) / (1 + FRONTIER_BUILD_ALT))
    return true
  }

  /**
   * Draw these polities' frontiers in these colours. Returns true if anything
   * changed — the caller's cue to wake the render pump.
   *
   * `colorOf` is a parameter rather than `entry.nation.color` because a nation
   * colour was chosen against a dark photograph and has to be re-aimed at the
   * drawn map's paper; the mode is the caller's business (see `onGround`). So
   * is `inkOf`, and for a sharper version of the same reason: which part of a
   * boundary is worth drawing depends on what ELSE is on the map that year (see
   * `inkPathsOf`), which this layer cannot know and its caller already does.
   */
  set(entries: InkEntry[], colorOf: (e: InkEntry) => string, inkOf: (e: InkEntry) => FrontierInk): boolean {
    const key = entries.map((e) => `${e.nation.id}:${colorOf(e)}:${inkOf(e)}`).join('|')
    if (key === this.currentKey) return false
    this.currentKey = key
    const positions: number[] = []
    const colors: number[] = []
    for (const entry of entries) {
      const color = rgb(colorOf(entry))
      const ink = inkOf(entry)
      // A contested zone's outline is dashed in the dispute pattern; every
      // other entry's solid paths are solid lines. See `pushDashed`.
      const push = entry.kind === 'contested' ? pushDashed : pushLine
      for (const path of solidPathsOf(entry, ink))
        // CUT AT THE PLANET'S OWN FOLDS FIRST — the reason a grounded border
        // needs a lift of metres rather than kilometres. See `splitAtFacets`.
        // The dashed walk runs over the cut path too, and has to: it emits a
        // dash within one segment of the path it is given, so cutting the path
        // is exactly what keeps a single DASH from straddling a ridge. It
        // cannot change the pattern — the dash period is measured in degrees of
        // ground along the same polyline, and inserting a point on a segment
        // does not move any point of it.
        push(splitAtFacets(path), color, this.radius, positions, colors)
      // …and the estimated frontier, dashed in the sketch pattern (round 64):
      // the same pen, a broken line, so a guess stops posing as a survey.
      for (const path of sketchPathsOf(entry, ink))
        pushDashed(splitAtFacets(path), color, this.radius, positions, colors, 0, SKETCH_DASH_DEG, SKETCH_GAP_DEG)
    }
    this.geometry.dispose()
    this.geometry = new BufferGeometry()
    this.geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    this.geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
    this.lines.geometry = this.geometry
    this.lines.visible = positions.length > 0
    return true
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
    this.lines.removeFromParent()
  }
}
