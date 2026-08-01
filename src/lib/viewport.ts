import { visibleSpanDeg, viewSpanDeg, DEFAULT_FOV } from './detailImagery'
import type { Cap } from './queryIndex'

/**
 * What "the events on screen" means, geometrically.
 *
 * The top-N budget is a statement about attention, not about the planet: thirty
 * pins is what a *frame* can hold. At world view the frame is the planet and the
 * two questions are the same one, which is why nothing here changes the default
 * view. Zoomed in they are not: the contest for those thirty slots is still
 * being fought globally, so a regional event that lost it stays invisible
 * however far you zoom into its region — the map gets emptier as you look
 * closer, which is exactly backwards.
 *
 * So a zoomed-in camera publishes the circle of ground it can see, and the
 * query runs the same budget inside it.
 */

/** The circle of ground a query is scoped to. */
export type ViewportScope = Cap

/**
 * How much wider than the frame the scope is.
 *
 * Two things have to fit inside the slack: the corners of a rectangular frame
 * (already accounted for exactly, below) and the error the quantisation
 * introduces by snapping the centre — at most half a pan step, which is
 * `SCOPE_PAN_STEP / 2` of the radius. 1.3 covers that with room to spare, and
 * the rest of it is the point: pins appear a little before they reach the edge
 * of the screen rather than popping into existence on it.
 */
export const SCOPE_MARGIN = 1.3

/**
 * How far the camera may pan, as a fraction of the scope's radius, before the
 * scope is re-cut.
 *
 * Panning at close zoom moves the visible area continuously, and re-querying
 * (and so re-clustering, and so rebuilding pins) per frame is the jank this is
 * meant to avoid. A quarter of the radius is a visible but unhurried cadence:
 * about four re-queries per screen-width of panning, each of them cheap.
 */
export const SCOPE_PAN_STEP = 0.25

/**
 * Radius buckets: half an octave, the same ladder `clusterSpanBucket` uses, and
 * rounded *up* rather than to nearest.
 *
 * Up, because the radius is a promise: everything within it is considered, and
 * the margin above is sized on the assumption that the bucket never shrinks the
 * circle. Rounding to nearest would take up to 16% off it, and the pins that
 * fell out would be the ones at the edge of the screen — the ones the margin
 * exists to protect.
 */
export const scopeRadiusBucket = (radiusDeg: number) =>
  2 ** (Math.ceil(Math.log2(Math.max(1e-6, radiusDeg)) * 2) / 2)

/** Longitude folded into (−180, 180]. */
const wrapLng = (d: number) => {
  const x = (((d + 180) % 360) + 360) % 360 - 180
  return x === -180 ? 180 : x
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Snap a scope to the quantisation grid.
 *
 * The centre's step is a fraction of the *bucketed* radius, so the grid itself
 * is one of a handful of fixed lattices rather than something that drifts with
 * the camera: at a given zoom bucket, a scope is one of a fixed set of circles,
 * and a slow pan crosses between them one at a time instead of producing a new
 * query per frame.
 */
export function quantiseScope(scope: ViewportScope): ViewportScope {
  const radiusDeg = Math.min(180, scopeRadiusBucket(scope.radiusDeg))
  const step = radiusDeg * SCOPE_PAN_STEP
  return {
    lat: clamp(Math.round(scope.lat / step) * step, -90, 90),
    lng: wrapLng(Math.round(wrapLng(scope.lng) / step) * step),
    radiusDeg,
  }
}

/** Two scopes the query cannot tell apart. */
export const sameScope = (a?: ViewportScope, b?: ViewportScope): boolean =>
  a === b || (!!a && !!b && a.lat === b.lat && a.lng === b.lng && a.radiusDeg === b.radiusDeg)

export interface CameraView {
  lat: number
  lng: number
  /** Camera height in globe radii, as globe.gl reports it. */
  altitude: number
  fovDeg?: number
  /** Viewport width ÷ height. The frame's fov measures its *height*. */
  aspect?: number
}

/**
 * The scope for a camera — or `undefined` at world view, where there is nothing
 * to scope to and the behaviour is the one the app has always had.
 *
 * The threshold is read off the geometry rather than picked: `viewSpanDeg` is
 * the ground the frame actually contains and `visibleSpanDeg` is the ground the
 * camera could see at all (the horizon). When the frame — corners included,
 * margin included — reaches past the horizon, the whole visible globe is on
 * screen and the query is the global one. Pull in from there and the frame
 * starts cutting the planet, which is the moment a regional contest begins to
 * mean something. At the default altitude of 2.5 the frame is wider than the
 * planet by a factor of two, so the default view is a long way clear of it.
 *
 * The transition is continuous by construction: at the crossing point the
 * scope's radius is the horizon itself, so the first scoped query differs from
 * the global one only by the events on the far side of the planet — which are
 * behind the globe and were never drawn.
 */
export function cameraScope(cam: CameraView): ViewportScope | undefined {
  const horizonRadius = visibleSpanDeg(cam.altitude) / 2
  const fov = cam.fovDeg ?? DEFAULT_FOV
  const frameRadius = viewSpanDeg(cam.altitude, fov) / 2
  // the corner, not the edge: fov measures the frame's height, and the ground
  // distance to a corner is the diagonal of the half-height/half-width box
  const corner = frameRadius * Math.hypot(1, clamp(cam.aspect ?? 1, 0.35, 3))
  const wanted = corner * SCOPE_MARGIN
  if (wanted >= horizonRadius) return undefined
  return quantiseScope({ lat: cam.lat, lng: cam.lng, radiusDeg: wanted })
}
