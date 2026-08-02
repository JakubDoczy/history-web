import { separationDeg, type Cap } from './queryIndex'
import { geometryPointsOf, type Item } from './events'
import type { GeoPath } from './paths'

/**
 * "Show on map": where the camera has to be for an item's geometry to be *on
 * screen*, whatever that geometry is — a point, a footprint, a route, or all
 * three at once.
 *
 * Pure geometry, no store and no globe: the panel decides whether to offer the
 * action by asking for a target and getting `undefined` (a concept has nowhere
 * to fly to), and the globe is handed the answer as a point of view.
 */

/** globe.gl's perspective camera. Mirrors DEFAULT_FOV in lib/detailImagery.ts. */
export const FIT_FOV = 50

/**
 * The cap a *point* is framed with, in degrees of arc.
 *
 * A point has no extent, so the altitude is a judgement rather than a fit: six
 * degrees is a ~1500 km frame, which puts a city in its region — coastline,
 * mountains, the neighbouring countries — rather than filling the screen with
 * ground nobody asked about. Close enough to say "there", wide enough to say
 * "and here is where that is".
 */
export const POINT_CAP_DEG = 6

/** Slack around a fitted cap, so a route does not touch the edges of the frame. */
export const FIT_MARGIN = 1.18

/**
 * How far back the camera will go. 2.5 radii is the app's own world view (see
 * stores/view.ts): a globe-spanning route — a circumnavigation — cannot be
 * fitted at all, since half of it is behind the planet, so the fit stops at the
 * view that shows the most of one hemisphere and lets the user spin.
 */
export const MAX_FIT_ALTITUDE = 2.5
/** And how close. Below this the camera is inside the app's own zoom limits. */
export const MIN_FIT_ALTITUDE = 0.05

/**
 * The cap radius below which an item counts as having no extent at all.
 *
 * A tenth of a kilometre: far below anything this dataset is authored at, and
 * far above the rounding noise in `separationDeg`, which returns ~1e-8° for a
 * point measured against itself (an `acos` near 1). Without the epsilon a
 * single-point item would sometimes read as having a hair of extent and be
 * framed from the minimum altitude instead of from the point cap — which is a
 * bug that only shows up at certain coordinates.
 */
export const MIN_EXTENT_DEG = 1e-3

export interface FocusTarget {
  lat: number
  lng: number
  /** Camera height in globe radii, as globe.gl reports and accepts it. */
  altitude: number
}

/**
 * The smallest circle on the sphere (near enough) containing every point.
 *
 * Centre is the normalised mean of the points as unit vectors, radius the
 * largest angular distance from it. Not the true minimal enclosing cap — that
 * needs an iterative solve — but the difference is a few degrees on a shape
 * this is only used to *frame*, and the mean has two properties worth more than
 * the last few degrees: it needs no longitude convention, so a route crossing
 * the antimeridian or a pole is no special case, and it is stable under adding
 * a point near the middle.
 *
 * `fallback` is used when the points cancel out — a route wrapped right round
 * the planet has a mean of nothing at all — and is normally the item's own
 * anchor, the place its pin already stands.
 */
export function boundingCap(
  points: GeoPath,
  fallback?: { lat: number; lng: number },
): Cap | undefined {
  if (!points.length) return undefined
  const RAD = Math.PI / 180
  let x = 0
  let y = 0
  let z = 0
  for (const [lng, lat] of points) {
    const c = Math.cos(lat * RAD)
    x += c * Math.cos(lng * RAD)
    y += c * Math.sin(lng * RAD)
    z += Math.sin(lat * RAD)
  }
  const norm = Math.hypot(x, y, z) / points.length
  const degenerate = norm < 1e-6
  if (degenerate && !fallback) return undefined
  const lat = degenerate ? fallback!.lat : Math.atan2(z, Math.hypot(x, y)) / RAD
  const lng = degenerate ? fallback!.lng : Math.atan2(y, x) / RAD
  let radiusDeg = 0
  for (const [plng, plat] of points) {
    const d = separationDeg(lat, lng, plat, plng)
    if (d > radiusDeg) radiusDeg = d
  }
  return { lat, lng, radiusDeg }
}

/**
 * Camera altitude at which a cap of this angular radius fits in the frame.
 *
 * Two constraints, and the answer is whichever is further out:
 *
 *  · the **frame** — inverting `viewSpanDeg` (lib/detailImagery.ts): the frame
 *    edge leaves the camera at θ = fov/2, and the sine rule in the triangle
 *    centre–camera–ground gives altitude = sin(half + θ)/sin θ − 1.
 *  · the **horizon** — past about 64° of cap the frame is already wider than
 *    the planet and the lens stops being the limit; what is left is how much of
 *    the sphere the camera can see at all, which is acos(1/(1+altitude)).
 *
 * Both are clamped, and the clamp at the top is the honest part: no altitude
 * shows a cap wider than a hemisphere, so a route that circles the globe is
 * framed at world view rather than at an altitude computed from a lie.
 */
export function altitudeForCapDeg(radiusDeg: number, fovDeg = FIT_FOV, margin = FIT_MARGIN): number {
  const RAD = Math.PI / 180
  const half = Math.min(89.5, Math.max(0, radiusDeg) * margin) * RAD
  const theta = (fovDeg / 2) * RAD
  const frame = Math.sin(half + theta) / Math.sin(theta) - 1
  const horizon = 1 / Math.cos(half) - 1
  return Math.min(MAX_FIT_ALTITUDE, Math.max(MIN_FIT_ALTITUDE, frame, horizon))
}

/**
 * Where to put the camera to show an item — or `undefined` for an item with no
 * geometry, which is what hides the "Show on map" action on a concept.
 *
 * An event is framed on everything it draws: its own point (the pin, which is
 * always kept), its footprint if it has one, and every waypoint of every route.
 * A person is framed on the place their life began, which is the one coordinate
 * a life is certain to carry.
 */
export function focusTargetFor(item: Item, fovDeg = FIT_FOV): FocusTarget | undefined {
  const points = geometryPointsOf(item)
  if (!points.length) return undefined
  const anchor = { lng: points[0][0], lat: points[0][1] }
  const cap = boundingCap(points, anchor)!
  return {
    lat: cap.lat,
    lng: cap.lng,
    // A single point still gets a considered altitude rather than the zero its
    // cap radius would give — but ONLY a point. Once an item has extent, the
    // extent is the answer, however small it is: a battle plan across the
    // Normandy beaches is 50 km wide, and floored to the point cap it would be
    // framed from 1500 km up, which is a picture of the Channel with a smudge on
    // it. `MIN_FIT_ALTITUDE` is what stops the fit going absurdly close, and it
    // is the right floor for this because it is about the camera, not about
    // guessing what the reader meant.
    altitude: altitudeForCapDeg(
      cap.radiusDeg > MIN_EXTENT_DEG ? cap.radiusDeg : POINT_CAP_DEG,
      fovDeg,
    ),
  }
}
