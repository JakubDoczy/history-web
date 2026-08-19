import { directionOf, isGeoPath, type GeoPath, type PathDirection } from './paths'

/**
 * CUSTOM MAP DRAWINGS — the "battle plan" overlay.
 *
 * A pin says *where*, an area says *how far*, a route says *along what*. None of
 * them can say what an operation actually did: a line held on one morning, three
 * axes of advance, a pocket closed round four armies. That is what a drawing is
 * for, and it is why the schema is not "a picture" — a picture would be a file
 * nobody could check, at one projection, in one style, going stale the moment
 * the palette changed. A drawing is DATA: four kinds of thing, each a handful of
 * coordinates, rendered by lib/drawingLayer.ts in the app's own colours at
 * whatever angle the camera happens to be at.
 *
 * The kinds are the vocabulary of an operational map, and deliberately no more
 * than that:
 *
 *  · `route`     — a voyage or a trade road. Smoothed, grounded, tapered, and
 *                  (one-way, motion allowed) flowing the way it was travelled.
 *                  Not authored in the data: it is generated from an event's
 *                  `paths` by `routeDrawingFor`, so that ONE renderer owns every
 *                  line this globe draws over its map.
 *  · `frontline` — polylines. A line at a moment: where the front was.
 *  · `thrust`    — one polyline read as an arrow. An axis of advance.
 *  · `zone`      — a closed ring, washed and edged in a dashed line. A pocket, a
 *                  siege perimeter, a bridgehead, an occupation area: extent
 *                  that belongs to the operation rather than to the event's
 *                  whole footprint.
 *  · `marker`    — a point with a glyph: a battle cross, a star, a dot, a
 *                  chevron — and, since round 68, the military-map symbols: a
 *                  NATO APP-6 friendly-unit frame (`unit`, with an optional
 *                  interior device and an echelon string above it) and a
 *                  bastioned star fort (`fortress`). Where something happened,
 *                  or what stood there.
 *  · `label`     — words on the map. Small caps, haloed, no leader line.
 *
 * A `thrust` or a `frontline` may also carry `strength` (round 68) — free text
 * ("250,000", "6 divisions") set along the shaft / at the line's midpoint in
 * the map-label style, which is what puts troop counts on the arrows.
 *
 * Everything is `[lng, lat]`, GeoJSON order, like every other coordinate in the
 * dataset. Colour defaults to the event's tag colour and is overridable per
 * layer, so a two-sided battle can be drawn in two colours without inventing a
 * second tag.
 *
 * Validated at build time by `validate_drawing` in
 * scripts/build_event_chunks.py, over the shipped corpus by
 * tests/eventsData.test.ts, and at runtime by `isDrawing` below — the same three
 * places `paths` is checked, for the same reason: a typo here is a silent hole
 * in a map, not an exception.
 */

/** What every layer may carry. */
export interface DrawingCommon {
  /**
   * Overrides the event's tag colour for this layer. Any CSS colour the
   * renderer's `Color` understands; `#rrggbb` by convention in the data.
   */
  color?: string
  /**
   * WHEN this layer is true — a year (1941), a fraction of the event's span
   * (0..1), or the literal `'overview'` (round 64).
   *
   * Read by lib/steps.ts, which is where the forms and the comparison between
   * them are defined (`keepsLayer` is the whole rule, in one place). The rule
   * in three lines:
   *
   *  · no `at` — TIMELESS: drawn on the overview and in every step;
   *  · a number — DATED: drawn on the overview and in the single step whose
   *    window it falls in;
   *  · `'overview'` — OVERVIEW-ONLY: drawn whenever no step is open — the saga
   *    overview, before the first step and after stepping back out — and
   *    hidden inside every step. This is what a saga's own summary map is made
   *    of: dated battle markers and sparse arrows that belong to the whole
   *    story would, as timeless layers, clutter every single step.
   *
   * An event with no `steps` ignores the field entirely and draws every layer,
   * which is what every drawing authored before stepping existed relies on —
   * and why the build script rejects `'overview'` there: on a stepless event
   * it could only mean "always", which is spelt by omitting `at`. It is also
   * rejected on a STEP's own drawing, whose layers exist only inside their
   * step and can never be on an overview at all.
   */
  at?: number | 'overview'
  /** Shown in the layer's own label, and by the renderer's hit label. */
  label?: string
}

/**
 * A drawn route: the Silk Road's branches, the Atlantic triangle, Magellan.
 *
 * `paths` are the AUTHORED waypoints, not a drawn polyline — the smoothing and
 * the great-circle densification happen in the renderer (see `routePolyline` in
 * lib/paths.ts), so the spec stays the small honest thing the data says and the
 * curve stays one decision in one place.
 */
export interface RouteSpec extends DrawingCommon {
  type: 'route'
  /** One or more polylines. See lib/paths.ts for why it is always a list. */
  paths: GeoPath[]
  /** Default `oneway`; see `directionOf`. */
  direction?: PathDirection
}

/**
 * WHICH SIDE OF A FRONT IS HELD — the teeth on a line, and nothing else.
 *
 * Read as "left" and "right" OF TRAVEL along the polyline as it is authored,
 * which is the only frame a bare list of coordinates has: north/south and
 * east/west are useless on a front that turns through ninety degrees, and any
 * other convention would need a second field saying which way to read the first.
 * The renderer's own perpendicular (`ribbonGeometry`) uses the same frame, so
 * one rule covers every crosswise mark this layer draws.
 */
export type FrontlineTicks = 'left' | 'right'

/** A battle line at a moment. One or more polylines. */
export interface FrontlineSpec extends DrawingCommon {
  type: 'frontline'
  /** Always a list, for the reason `paths` is (see lib/paths.ts). */
  paths: GeoPath[]
  /** Solid = held; dashed = approximate, projected, or a line in dispute. */
  dash?: 'solid' | 'dashed'
  /** Screen pixels. A front is a line on a map, so it keeps its weight at any zoom. */
  width?: number
  /**
   * Short perpendicular teeth on one side — the standard mark for "the ground
   * behind this line is held". Absent by default, which is what every front
   * authored before this existed relies on.
   */
  ticks?: FrontlineTicks
  /**
   * What held the line, as free text — "6 divisions", "250,000". Set at the
   * line's midpoint in the map-label style. See ThrustSpec.strength.
   */
  strength?: string
}

/**
 * An offensive axis: a polyline spine with a real arrowhead on the end.
 *
 * `width` is in DEGREES OF ARC, not pixels — unlike a frontline. A thrust is a
 * body of troops with a frontage, and drawing it as a hairline that never
 * changes with zoom would make an army group the same weight as a divisional
 * boundary. The arrowhead is geometry oriented on the spine's end tangent, so it
 * points where the advance was actually going.
 */
export interface ThrustSpec extends DrawingCommon {
  type: 'thrust'
  /** The axis. The LAST point is the tip: that is where the arrowhead sits. */
  path: GeoPath
  /** Half-width of the shaft in degrees of arc. Default THRUST_WIDTH_DEG. */
  width?: number
  /** Narrow at the tail, full width at the head. Default true. */
  taper?: boolean
  /**
   * What the arrow is made of, as free text: "250,000", "6 divisions", "Second
   * Army". ROUND 68 — "I want to see things like for example troop counts on
   * some arrows." Set along the shaft at its midpoint, oriented on the spine's
   * mid-tangent and sized with the thrust's own width, in the map-label style
   * (small caps, haloed), so it reads on both grounds. Free text on purpose:
   * a count, an echelon and a name are all things an operational map writes
   * on an arrow, and the schema should not have an opinion about which.
   */
  strength?: string
}

/**
 * A closed area the operation is ABOUT: the pocket at Kiev, the ring round
 * Leningrad, the bridgehead over the Rhine, the zone an army occupied.
 *
 * The one thing operations kept needing that no other kind could say. A
 * frontline can trace the same ring, but a line says "the front ran here" and a
 * washed area says "this was inside" — which is the whole content of a pocket.
 * An event's `area` footprint cannot say it either: that is the theatre the
 * event is filed under, one per event, drawn whenever the event is selected,
 * where a zone is one layer of a plan among several, dateable with `at` like
 * every other layer, and there may be four of them.
 *
 * `ring` is authored OPEN — the same convention an event's footprint uses — and
 * closed by the renderer. Three points minimum: two is a line, and a line is a
 * frontline.
 */
export interface ZoneSpec extends DrawingCommon {
  type: 'zone'
  /** The boundary, `[lng, lat]`, authored open. At least three points. */
  ring: GeoPath
}

/**
 * ROUND 68 adds the military-map glyphs — "really custom paintings", NATO
 * markings on divisions and fortresses.
 *
 *  · `unit`     — the APP-6 friendly-unit frame: a rectangle, monochrome
 *                 line-art in the layer's colour, with an optional interior
 *                 device (`unitType`) and an optional echelon string above the
 *                 frame (`unitSize`).
 *  · `fortress` — a bastioned star fort in outline: a pentagon with pointed
 *                 bastions, the plan-view symbol every C17 map draws a
 *                 fortified place with.
 *
 * Both are ordinary markers: sized in degrees of arc, cased like every glyph,
 * coloured by the layer (a two-sided battle already overrides colour per
 * layer), legible on both grounds through `markInk`.
 */
export type MarkerStyle = 'cross' | 'star' | 'dot' | 'arrow' | 'unit' | 'fortress'

/**
 * The interior device of a `unit` frame — the APP-6 friendly-unit icons this
 * vocabulary knows: infantry is the saltire, armor the oval, cavalry the single
 * diagonal, artillery the filled dot, mixed (mechanised infantry) the saltire
 * over the oval.
 */
export type UnitType = 'infantry' | 'armor' | 'cavalry' | 'artillery' | 'mixed'

export const UNIT_TYPES: readonly UnitType[] = [
  'infantry',
  'armor',
  'cavalry',
  'artillery',
  'mixed',
]

/** A point with a glyph on it. */
export interface MarkerSpec extends DrawingCommon {
  type: 'marker'
  pos: [number, number]
  /** Default 'dot'. 'cross' is the battle cross; 'arrow' needs a `bearing`. */
  style?: MarkerStyle
  /** Radius in degrees of arc. Default MARKER_SIZE_DEG. */
  size?: number
  /** Degrees clockwise from north. Only 'arrow' is oriented. */
  bearing?: number
  /** The interior device. Only a `unit` frame has an interior to draw in. */
  unitType?: UnitType
  /**
   * The echelon, set above the frame as small text: 'X' brigade, 'XX'
   * division, 'XXX' corps, 'XXXX' army. Free string — a numbered echelon or a
   * non-NATO convention is as sayable as the standard four.
   */
  unitSize?: string
}

/** Words on the map. */
export interface LabelSpec extends DrawingCommon {
  type: 'label'
  pos: [number, number]
  text: string
  /** 'sm' is a place, 'md' is a formation or a front. Default 'sm'. */
  size?: 'sm' | 'md'
}

export type DrawingSpec =
  | RouteSpec
  | FrontlineSpec
  | ThrustSpec
  | ZoneSpec
  | MarkerSpec
  | LabelSpec

export interface Drawing {
  layers: DrawingSpec[]
}

/* ------------------------------------------------------------- defaults */

/** Frontline width in screen px when the layer does not say. */
export const FRONTLINE_WIDTH = 2.4
/** Thrust shaft half-width in degrees of arc when the layer does not say. */
export const THRUST_WIDTH_DEG = 0.55
/** Marker radius in degrees of arc when the layer does not say. */
export const MARKER_SIZE_DEG = 0.8
/**
 * How far the arrowhead reaches beyond the shaft, as a multiple of half-width.
 * 2.4 gives the long head an operational map uses (the head is about twice the
 * shaft's width across) without eating a short axis whole.
 */
export const THRUST_HEAD_SCALE = 2.4
/**
 * How much of the ground a zone's wash takes.
 *
 * 0.18 is a wash and not a lid: it is under the 0.22 an event's own footprint
 * cap gets, because a zone is drawn INSIDE a plan — over thrust ribbons, over
 * frontlines, over a hatched sea — and anything heavier turns the ink beneath it
 * into ink seen through a filter, which is the same defect the cap-supersession
 * rule at GlobeView exists to remove.
 */
export const ZONE_FILL_OPACITY = 0.18
/** A zone's dashed edge, in screen pixels. Lighter than a front: it is a limit, not a line held. */
export const ZONE_OUTLINE_WIDTH = 1.8

/* ------------------------------------------------------------ validation */

const isPos = (p: unknown): p is [number, number] =>
  Array.isArray(p) &&
  p.length === 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90

const isColor = (c: unknown) => c === undefined || (typeof c === 'string' && c.length > 0)
const isSize = (n: unknown) => n === undefined || (typeof n === 'number' && n > 0 && n < 90)
/** Free text that is actually text: `strength`, `unitSize`. */
const isText = (t: unknown) => t === undefined || (typeof t === 'string' && t.length > 0)

/** Is this one drawable layer? The runtime twin of `validate_drawing`. */
export function isDrawingSpec(l: unknown): l is DrawingSpec {
  if (!l || typeof l !== 'object') return false
  const s = l as Record<string, unknown>
  if (!isColor(s.color)) return false
  // A finite number, or the one literal (see `DrawingCommon.at`). The runtime
  // guard is structural — where the literal is allowed to appear is contextual
  // (an event with steps, never a step's own drawing) and is the build
  // script's check, mirrored over the corpus by tests/eventsData.test.ts.
  if (s.at !== undefined && s.at !== 'overview' && !Number.isFinite(s.at)) return false
  if (s.label !== undefined && typeof s.label !== 'string') return false
  switch (s.type) {
    case 'route':
      return (
        Array.isArray(s.paths) &&
        s.paths.length > 0 &&
        s.paths.every(isGeoPath) &&
        (s.direction === undefined || s.direction === 'oneway' || s.direction === 'twoway')
      )
    case 'frontline':
      return (
        Array.isArray(s.paths) &&
        s.paths.length > 0 &&
        s.paths.every(isGeoPath) &&
        (s.dash === undefined || s.dash === 'solid' || s.dash === 'dashed') &&
        (s.ticks === undefined || s.ticks === 'left' || s.ticks === 'right') &&
        isSize(s.width) &&
        isText(s.strength)
      )
    case 'thrust':
      return (
        isGeoPath(s.path) &&
        isSize(s.width) &&
        (s.taper === undefined || typeof s.taper === 'boolean') &&
        isText(s.strength)
      )
    case 'zone':
      // A ring, not a line: `isGeoPath` checks the coordinates, and three points
      // is what makes the thing enclose anything at all.
      return isGeoPath(s.ring) && (s.ring as GeoPath).length >= 3
    case 'marker':
      return (
        isPos(s.pos) &&
        (s.style === undefined ||
          (['cross', 'star', 'dot', 'arrow', 'unit', 'fortress'] as unknown[]).includes(s.style)) &&
        isSize(s.size) &&
        (s.bearing === undefined || Number.isFinite(s.bearing)) &&
        // The unit fields belong to the unit frame: an interior device on a dot
        // is a typo, and this guard is structural — the same layer says both.
        (s.unitType === undefined ||
          (s.style === 'unit' && (UNIT_TYPES as unknown[]).includes(s.unitType))) &&
        (s.unitSize === undefined ||
          (s.style === 'unit' && typeof s.unitSize === 'string' && s.unitSize.length > 0))
      )
    case 'label':
      return (
        isPos(s.pos) &&
        typeof s.text === 'string' &&
        s.text.length > 0 &&
        (s.size === undefined || s.size === 'sm' || s.size === 'md')
      )
    default:
      return false
  }
}

/** Is this a drawable overlay? At least one layer, every one of them valid. */
export const isDrawing = (d: unknown): d is Drawing =>
  !!d &&
  typeof d === 'object' &&
  Array.isArray((d as Drawing).layers) &&
  (d as Drawing).layers.length > 0 &&
  (d as Drawing).layers.every(isDrawingSpec)

/* ---------------------------------------------------------------- extent */

/**
 * Every coordinate a drawing occupies — what the camera has to hold to show it.
 *
 * Feeds the drawing half of `pointsOf` (lib/events.ts), so an event whose
 * only shape is its drawing — D-Day is a pin and a plan, with no footprint and
 * no route — is still framed on the whole plan rather than on the pin alone.
 */
export function drawingPoints(d: Drawing | undefined): GeoPath {
  if (!d) return []
  const out: GeoPath = []
  for (const l of d.layers) {
    if (l.type === 'frontline' || l.type === 'route') for (const p of l.paths) out.push(...p)
    else if (l.type === 'thrust') out.push(...l.path)
    else if (l.type === 'zone') out.push(...l.ring)
    else out.push(l.pos)
  }
  return out
}

/* ------------------------------------------------------------ route drawing */

/**
 * A `routes` shape (lib/events.ts), expressed as a drawing.
 *
 * Structurally typed rather than importing `Shape`, for two reasons: it keeps
 * the module graph one-way (events → drawing, never back), and it lets the raw
 * data shape — where `direction` may be absent — go through the same function,
 * which is what the build-time checks in the data tests use.
 *
 * Going through `Drawing` rather than a layer of its own is the point. There is
 * exactly ONE renderer of geometry on this globe's map — the same code that puts
 * a frontline on the Dnieper puts Magellan in the Pacific, at the same altitude,
 * with the same depth handling, in the same units. The old arrangement had
 * routes in globe.gl's paths layer and their decoration here, which is how the
 * routes ended up 90 km above a battle plan's 98 km with neither number written
 * down anywhere near the other.
 *
 * It is also a pure function of the event, so the route drawing is testable
 * without a scene and cannot go stale: it is rebuilt from the paths.
 *
 * ONE layer, and no glyphs. The ports used to be `marker` layers generated here,
 * sized in degrees of arc off the route's own extent — which meant a dot that
 * was three pixels across at the zoom the route is framed at and eighty across
 * one zoom further in, because a marker is a thing on the ground and a port
 * marker wants to be a symbol on a map. The renderer draws them instead, in
 * screen pixels, as part of drawing the line they end.
 */
export const routeDrawingFor = (e: {
  paths?: GeoPath[]
  direction?: PathDirection
}): Drawing | undefined => {
  const paths = e.paths?.filter((p) => p.length >= 2) ?? []
  if (!paths.length) return undefined
  return { layers: [{ type: 'route', paths, direction: directionOf(e) }] }
}

/** How heavy an area's outline is drawn, in screen pixels. */
export const AREA_OUTLINE_WIDTH = 2

/**
 * An event footprint's OUTLINE, as a drawing layer.
 *
 * The fill stays in the polygon layer — it is the hover and click target, and a
 * cap is a mesh, so the polygon offset that keeps it off the planet's depth
 * value reaches it. The outline cannot be drawn there: three-globe strokes a
 * polygon with a `Line`, GL_LINES, and `POLYGON_OFFSET_FILL` does not apply to
 * line primitives — there is no `glPolygonOffset` for lines in WebGL at all. So
 * the stroke was left separated from the globe by height alone, 8.9 km against
 * a ~2.7 km depth quantum at world view, and it kept doing what the cap stopped
 * doing: resolving to the planet's own depth value and flickering along its
 * length as the camera moved.
 *
 * Drawn through the DrawingLayer it is a *fat* line — screen-space quads, which
 * are triangles, which do take the offset. It also gets everything else the
 * layer already guarantees: SURFACE_ALT, densification so the chords do not sag
 * through the planet between vertices, and a renderOrder above the cap.
 *
 * The ring is closed here rather than by the caller, because a footprint's ring
 * is authored open (the polygon layer closes it for its own coordinates) and an
 * outline with a gap in it is exactly the artefact this is fixing.
 */
export const areaOutlineFor = (
  ring: GeoPath | undefined,
  /** In screen pixels. The look picks it — see `OUTLINE_WIDTH` in lib/present/ink.ts. */
  width: number = AREA_OUTLINE_WIDTH,
): DrawingSpec | undefined => {
  if (!ring || ring.length < 3) return undefined
  const [first] = ring
  const last = ring[ring.length - 1]
  const closed = first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first]
  return { type: 'frontline', paths: [closed], dash: 'solid', width }
}
