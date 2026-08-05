import { degPerScreenPx } from './detailImagery'
import { halfOctave } from './quantise'
import type { LatLng, MapPin } from './events'

/**
 * Pin clustering.
 *
 * At world view a dozen events in the same city land on the same three pixels
 * and the globe turns into a smear of overlapping teardrops. So events that sit
 * within a small fraction of the *visible span* of each other collapse into one
 * badge, which the user can expand to fan its members out.
 *
 * Everything here is pure: the store holds only "which cluster is open".
 */

const RAD = Math.PI / 180

/** Signed longitude difference in (-180, 180] — the short way round the seam. */
export const wrapLngDeg = (d: number) => {
  const x = ((d + 180) % 360 + 360) % 360 - 180
  return x === -180 ? 180 : x
}

/**
 * Great-circle separation in degrees (haversine).
 *
 * Haversine rather than a flat delta because two events either side of the
 * antimeridian, or near a pole, are neighbours on the sphere and nowhere near
 * each other in raw lat/lng. For small separations this reduces exactly to the
 * cos(lat)-scaled longitude difference one would write by hand.
 */
export function angularSeparationDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = (b.lat - a.lat) * RAD
  const dLng = wrapLngDeg(b.lng - a.lng) * RAD
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / RAD
}

/** Fraction of the visible span below which two events are "the same spot". */
export const CLUSTER_SPAN_FRACTION = 0.035

/** The clustering radius for a given view, in degrees. */
export const clusterThresholdDeg = (visibleSpanDeg: number) =>
  Math.max(0.0005, visibleSpanDeg * CLUSTER_SPAN_FRACTION)

/** One pin's worth of events: a single when `members.length === 1`. */
export interface EventGroup {
  /** Stable key: the id of the highest-priority member. */
  id: string
  lat: number
  lng: number
  /** Highest priority first. */
  members: MapPin[]
}

export interface ClusterResult {
  singles: EventGroup[]
  clusters: EventGroup[]
}

const byPriority = (a: MapPin, b: MapPin) =>
  b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Group events whose angular separation is under the span-scaled threshold.
 *
 * Greedy from the highest-priority event outward, so a cluster is always
 * anchored on — and positioned at — its most important member. That keeps the
 * badge where the eye expects the headline event to be, and makes the grouping
 * independent of input order.
 */
export function clusterEvents(events: MapPin[], visibleSpanDeg: number): ClusterResult {
  const threshold = clusterThresholdDeg(visibleSpanDeg)
  const pending = [...events].sort(byPriority)
  const taken = new Set<string>()
  const singles: EventGroup[] = []
  const clusters: EventGroup[] = []

  for (const seed of pending) {
    if (taken.has(seed.id)) continue
    taken.add(seed.id)
    const members = [seed]
    for (const other of pending) {
      if (taken.has(other.id)) continue
      if (angularSeparationDeg(seed.geometry.anchor, other.geometry.anchor) <= threshold) {
        taken.add(other.id)
        members.push(other)
      }
    }
    const group: EventGroup = { id: seed.id, ...seed.geometry.anchor, members }
    ;(members.length > 1 ? clusters : singles).push(group)
  }
  return { singles, clusters }
}

/**
 * The fan is measured on the *screen*, not on the globe.
 *
 * It used to be a fraction of `visibleSpanDeg` — the horizon, everything the
 * camera could see if the lens were infinitely wide. Close in that is one to
 * two orders of magnitude wider than the frame (at 0.02 radii: 22.7° of horizon
 * against 1.05° of frame), so a fan sized off it threw its members hundreds of
 * screens away. What a fan wants is a fixed number of pixels: far enough for
 * the pins not to overlap, near enough to stay in view.
 *
 * So the radius is stated in CSS pixels and converted to degrees through the
 * frame the camera actually shows (viewSpanDeg / viewport height). Zoom while
 * the fan is open and the ring keeps the same size on screen.
 */
export const FAN_MIN_PX = 56
export const FAN_MAX_PX = 72
/** Members beyond this count stop widening the ring; it is capped anyway. */
export const FAN_GROWTH_COUNT = 12
/** The ring may never take more than this much of the viewport's short side. */
export const FAN_MAX_VIEWPORT_FRACTION = 0.15

/** The live camera, in the two units the fan needs to talk in. */
export interface FanView {
  /**
   * Ground degrees per CSS pixel at the centre of the screen — the camera's own
   * scale there (see detailImagery.degPerScreenPx).
   *
   * The centre's scale rather than the frame's average, because that average is
   * a bad conversion anywhere near it: a sphere foreshortens hard toward the
   * limb, so at world view the middle of the screen resolves several times finer
   * than the frame as a whole, and a fan sized on the average would be that many
   * times too wide.
   */
  degPerPx: number
  /** Frame height in CSS px. */
  heightPx: number
  /** Frame width in CSS px, for the short-side cap. */
  widthPx: number
}

/**
 * How far above the surface the pins are drawn, in globe radii — the layer's
 * `htmlAltitude`. 0.006 is 38 km, nothing at all next to a camera 16 000 km up
 * and a third of the way to one 110 km up.
 */
export const PIN_ALTITUDE = 0.006

/**
 * The fan's view for a camera.
 *
 * The scale that matters is the one in the *pin plane*, not on the ground:
 * everything a fan draws floats at PIN_ALTITUDE, and a plane a third nearer the
 * camera is magnified by a third. Measured in the browser, ignoring this made
 * the ring 14% too wide at a 300 km view and 53% too wide at a 110 km one —
 * the closer the camera, the worse, which is exactly the complaint.
 *
 * Below the pin plane there is no sensible answer (the pins are behind the
 * camera), so the lower bound keeps the arithmetic finite rather than pretending
 * to be right.
 */
export function fanViewFor(camera: {
  altitude: number
  fovDeg: number
  widthPx: number
  heightPx: number
}): FanView {
  const above = Math.max(camera.altitude - PIN_ALTITUDE, camera.altitude * 0.1, 0)
  return {
    degPerPx: degPerScreenPx(above, camera.heightPx, camera.fovDeg),
    widthPx: camera.widthPx,
    heightPx: camera.heightPx,
  }
}

/**
 * Ring radius in CSS pixels: 56 px for a small cluster growing to 72 px at a
 * dozen members, then hard-capped so the fan cannot leave the viewport however
 * many members or however odd the window shape.
 */
export function fanRadiusPx(count: number, view: FanView): number {
  const t = Math.min(1, Math.max(0, (count - 3) / (FAN_GROWTH_COUNT - 3)))
  const wanted = FAN_MIN_PX + (FAN_MAX_PX - FAN_MIN_PX) * t
  const shortSide = Math.max(1, Math.min(view.widthPx, view.heightPx))
  return Math.max(1, Math.min(wanted, shortSide * FAN_MAX_VIEWPORT_FRACTION))
}

/** The same radius in degrees of arc, at the scale currently on screen. */
export function fanRadiusDeg(count: number, view: FanView): number {
  return fanRadiusPx(count, view) * Math.max(view.degPerPx, 0)
}

/**
 * Where an expanded cluster's members sit: evenly around the anchor, at the
 * screen-sized radius above. Longitude is divided by cos(lat) so the ring stays
 * round instead of squashing toward the poles.
 */
export function fanPositions(
  centre: { lat: number; lng: number },
  count: number,
  view: FanView,
): { lat: number; lng: number }[] {
  const radius = fanRadiusDeg(count, view)
  return Array.from({ length: count }, (_, i) => {
    // start at the top and go clockwise; the first (highest-priority) member
    // therefore always sits directly above the anchor
    const a = (i / count) * 2 * Math.PI - Math.PI / 2
    const lat = Math.max(-89.5, Math.min(89.5, centre.lat - Math.sin(a) * radius))
    const cos = Math.max(0.05, Math.cos(centre.lat * RAD))
    return { lat, lng: wrapLngDeg(centre.lng + (Math.cos(a) * radius) / cos) }
  })
}

/**
 * Thickness of a leg, in CSS pixels.
 *
 * The arcs layer takes angular degrees, which has the same failure the fan
 * radius had: a fixed 0.24° is a hairline across the Atlantic and a 26 km
 * ribbon over a city, wide enough at close zoom to swallow the pins it connects.
 * So it is stated in pixels and converted through the same view.
 */
export const LEG_STROKE_PX = 1.6

export const legStrokeDeg = (view: FanView) => Math.max(1e-9, LEG_STROKE_PX * view.degPerPx)

/** A pin to draw: either one event or a collapsed cluster badge. */
export type PinDatum =
  | { kind: 'event'; id: string; lat: number; lng: number; event: MapPin; fanned: boolean }
  | { kind: 'cluster'; id: string; lat: number; lng: number; members: MapPin[] }

/** A leg drawn from an expanded cluster's anchor out to one fanned member. */
export interface ClusterLeg {
  id: string
  startLat: number
  startLng: number
  endLat: number
  endLng: number
  event: MapPin
}

export interface PinLayout {
  pins: PinDatum[]
  legs: ClusterLeg[]
}

/**
 * Turn groups into the pins actually drawn.
 *
 * The selected event is never hidden inside a badge: if its cluster is closed,
 * it is lifted out and drawn on its own coordinates, and the badge covers only
 * what is left (dropping to a plain pin when one event remains).
 */
export function layoutPins(
  groups: ClusterResult,
  opts: { expandedId?: string; selectedId?: string; fan: FanView },
): PinLayout {
  const pins: PinDatum[] = []
  const legs: ClusterLeg[] = []
  const asPin = (
    e: MapPin,
    at: LatLng = e.geometry.anchor,
    fanned = false,
  ): PinDatum => ({
    kind: 'event',
    id: e.id,
    lat: at.lat,
    lng: at.lng,
    event: e,
    fanned,
  })

  for (const g of groups.singles) pins.push(asPin(g.members[0]))

  for (const g of groups.clusters) {
    if (g.id === opts.expandedId) {
      const spots = fanPositions(g, g.members.length, opts.fan)
      g.members.forEach((e, i) => {
        pins.push(asPin(e, spots[i], true))
        legs.push({
          id: `${g.id}:${e.id}`,
          startLat: g.lat,
          startLng: g.lng,
          endLat: spots[i].lat,
          endLng: spots[i].lng,
          event: e,
        })
      })
      continue
    }
    const rest = g.members.filter((e) => e.id !== opts.selectedId)
    const picked = g.members.find((e) => e.id === opts.selectedId)
    if (picked) pins.push(asPin(picked))
    if (rest.length === 1) pins.push(asPin(rest[0]))
    else if (rest.length > 1)
      pins.push({ kind: 'cluster', id: g.id, ...rest[0].geometry.anchor, members: rest })
  }
  return { pins, legs }
}

/**
 * Quantise the visible span before clustering. Zoom reports a new altitude on
 * every frame of a pinch; re-clustering (and so rebuilding every pin element)
 * that often is both wasteful and visually noisy. Snapping to half-octave
 * buckets means the grouping only changes at a handful of discrete zoom steps.
 */
export const clusterSpanBucket = (visibleSpanDeg: number) => halfOctave(visibleSpanDeg)

/**
 * How far the span may drift before an open cluster closes itself.
 *
 * Wider than it used to be, and deliberately: the fan is now laid out from the
 * live frame, so it stays the right size on screen through a zoom and there is
 * nothing to rescue. What still justifies closing it is that the *clustering*
 * has re-run by then — past an octave or so the members are no longer one spot,
 * and a fan of a group that no longer exists is a lie.
 */
export const FAN_COLLAPSE_FACTOR = 2.2

/** Has the view moved enough that an open cluster no longer makes sense? */
export const spanChangedEnough = (before: number, after: number, factor = 1.3) => {
  if (before <= 0) return true
  const r = after / before
  return r > factor || r < 1 / factor
}
