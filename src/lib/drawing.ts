import { separationDeg } from './queryIndex'
import {
  ARROW_FRACTIONS,
  directionOf,
  isGeoPath,
  pathTermini,
  pointAlongPath,
  type GeoPath,
  type PathDirection,
} from './paths'

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
 * The four kinds are the vocabulary of an operational map, and deliberately no
 * more than that:
 *
 *  · `frontline` — polylines. A line at a moment: where the front was.
 *  · `thrust`    — one polyline read as an arrow. An axis of advance.
 *  · `marker`    — a point with a glyph: a battle cross, a star, a dot, a
 *                  chevron. Where something happened.
 *  · `label`     — words on the map. Small caps, haloed, no leader line.
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
   * WHEN this layer is true — a year (1941) or a fraction of the event's span
   * (0..1). Carried for time-staging a drawing as the timeline moves; nothing
   * reads it yet and **every layer renders regardless**, so it is documentation
   * with a schema slot rather than behaviour. It is here now because staging is
   * a change to the renderer, not to the data, and adding it later would mean
   * re-authoring every exemplar.
   */
  at?: number
  /** Shown in the layer's own label, and by the renderer's hit label. */
  label?: string
}

/** A battle line at a moment. One or more polylines. */
export interface FrontlineSpec extends DrawingCommon {
  type: 'frontline'
  /** Always a list, for the reason `paths` is (see lib/paths.ts). */
  paths: GeoPath[]
  /** Solid = held; dashed = approximate, projected, or a line in dispute. */
  dash?: 'solid' | 'dashed'
  /** Screen pixels. A front is a line on a map, so it keeps its weight at any zoom. */
  width?: number
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
}

export type MarkerStyle = 'cross' | 'star' | 'dot' | 'arrow'

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
}

/** Words on the map. */
export interface LabelSpec extends DrawingCommon {
  type: 'label'
  pos: [number, number]
  text: string
  /** 'sm' is a place, 'md' is a formation or a front. Default 'sm'. */
  size?: 'sm' | 'md'
}

export type DrawingSpec = FrontlineSpec | ThrustSpec | MarkerSpec | LabelSpec

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

/** The layer kinds, in draw order — later kinds paint over earlier ones. */
export const DRAWING_KINDS = ['frontline', 'thrust', 'marker', 'label'] as const

/* ------------------------------------------------------------ validation */

const isPos = (p: unknown): p is [number, number] =>
  Array.isArray(p) &&
  p.length === 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0] as number) <= 180 &&
  Math.abs(p[1] as number) <= 90

const isColor = (c: unknown) => c === undefined || (typeof c === 'string' && c.length > 0)
const isSize = (n: unknown) => n === undefined || (typeof n === 'number' && n > 0 && n < 90)

/** Is this one drawable layer? The runtime twin of `validate_drawing`. */
export function isDrawingSpec(l: unknown): l is DrawingSpec {
  if (!l || typeof l !== 'object') return false
  const s = l as Record<string, unknown>
  if (!isColor(s.color)) return false
  if (s.at !== undefined && !Number.isFinite(s.at)) return false
  if (s.label !== undefined && typeof s.label !== 'string') return false
  switch (s.type) {
    case 'frontline':
      return (
        Array.isArray(s.paths) &&
        s.paths.length > 0 &&
        s.paths.every(isGeoPath) &&
        (s.dash === undefined || s.dash === 'solid' || s.dash === 'dashed') &&
        isSize(s.width)
      )
    case 'thrust':
      return isGeoPath(s.path) && isSize(s.width) && (s.taper === undefined || typeof s.taper === 'boolean')
    case 'marker':
      return (
        isPos(s.pos) &&
        (s.style === undefined || (['cross', 'star', 'dot', 'arrow'] as unknown[]).includes(s.style)) &&
        isSize(s.size) &&
        (s.bearing === undefined || Number.isFinite(s.bearing))
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
 * Feeds `geometryPointsOf` (lib/events.ts), so an event whose only geometry is
 * its drawing — D-Day is a pin and a plan, with no `area` and no `paths` — is
 * still framed on the whole plan rather than on the pin alone.
 */
export function drawingPoints(d: Drawing | undefined): GeoPath {
  if (!d) return []
  const out: GeoPath = []
  for (const l of d.layers) {
    if (l.type === 'frontline') for (const p of l.paths) out.push(...p)
    else if (l.type === 'thrust') out.push(...l.path)
    else out.push(l.pos)
  }
  return out
}

/* ------------------------------------------------------------ route decor */

/**
 * The dots and arrowheads that decorate a drawn route, expressed as a drawing.
 *
 * Two things follow from generating a `Drawing` rather than a bespoke overlay:
 * there is exactly ONE renderer of glyphs on this globe, and the route
 * decoration is a pure function of the route — testable without a scene, and
 * impossible to leave behind when the routes change, because it is rebuilt from
 * them.
 *
 *  · a **dot at every terminus**: the ports. Both directions get these — a road
 *    has ends whichever way you walk it.
 *  · **two chevrons per route, at a third and two-thirds along**, ONE-WAY ONLY.
 *    The fat-line dash animation already runs from the first waypoint to the
 *    last (three-globe advances `dashOffset` in that direction), so the dashes
 *    and the chevrons agree by construction; the chevrons are what makes the
 *    direction legible in a screenshot, in reduced motion, and on the half of
 *    the route that is behind the planet's limb.
 *
 * Size scales with the route's own extent (see `decorSizeDeg`): a chevron sized
 * for the Atlantic triangle is invisible on the Bosporus, and one sized for the
 * Bosporus is a blot on a circumnavigation.
 */
export function routeDecorFor(e: {
  paths?: GeoPath[]
  direction?: PathDirection
}): Drawing | undefined {
  const paths = e.paths?.filter((p) => p.length >= 2) ?? []
  if (!paths.length) return undefined
  const size = decorSizeDeg(paths)
  const layers: DrawingSpec[] = pathTermini(paths).map((pos) => ({
    type: 'marker' as const,
    pos,
    style: 'dot' as const,
    // A port is a smaller mark than a direction: the dot says "the route ends
    // here", which the line already half-said, while the chevron is carrying
    // information nothing else on the map carries.
    size: size * 0.45,
  }))
  if (directionOf(e) === 'oneway') {
    for (const path of paths) {
      for (const t of ARROW_FRACTIONS) {
        const at = pointAlongPath(path, t)
        if (!at) continue
        layers.push({
          type: 'marker',
          pos: [at.lng, at.lat],
          style: 'arrow',
          bearing: at.bearing,
          size,
        })
      }
    }
  }
  return layers.length ? { layers } : undefined
}

/**
 * How big a route's decoration should be, in degrees of arc.
 *
 * Measured off the spread of the termini rather than the point count: what
 * matters is how far out the camera will have to be to hold the route, and the
 * fit is computed from exactly that spread (lib/geoFocus.ts). The floor keeps a
 * short hop's chevron from vanishing; the ceiling keeps a circumnavigation's
 * from covering Java.
 */
export function decorSizeDeg(paths: GeoPath[]): number {
  const ends = pathTermini(paths)
  let spread = 0
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++)
      spread = Math.max(spread, separationDeg(ends[i][1], ends[i][0], ends[j][1], ends[j][0]))
  return Math.max(0.4, Math.min(1.8, spread * 0.028))
}
