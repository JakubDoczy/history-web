import type { HistoricalEvent } from './events'

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
  members: HistoricalEvent[]
}

export interface ClusterResult {
  singles: EventGroup[]
  clusters: EventGroup[]
}

const byPriority = (a: HistoricalEvent, b: HistoricalEvent) =>
  b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Group events whose angular separation is under the span-scaled threshold.
 *
 * Greedy from the highest-priority event outward, so a cluster is always
 * anchored on — and positioned at — its most important member. That keeps the
 * badge where the eye expects the headline event to be, and makes the grouping
 * independent of input order.
 */
export function clusterEvents(events: HistoricalEvent[], visibleSpanDeg: number): ClusterResult {
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
      if (angularSeparationDeg(seed, other) <= threshold) {
        taken.add(other.id)
        members.push(other)
      }
    }
    const group: EventGroup = { id: seed.id, lat: seed.lat, lng: seed.lng, members }
    ;(members.length > 1 ? clusters : singles).push(group)
  }
  return { singles, clusters }
}

/**
 * Where an expanded cluster's members sit: evenly around the anchor, at a
 * radius proportional to the visible span so the fan looks the same size on
 * screen at any zoom. Longitude is divided by cos(lat) so the ring stays round
 * instead of squashing toward the poles.
 */
export const FAN_SPAN_FRACTION = 0.038

export function fanPositions(
  centre: { lat: number; lng: number },
  count: number,
  visibleSpanDeg: number,
): { lat: number; lng: number }[] {
  const r = Math.max(0.0008, visibleSpanDeg * FAN_SPAN_FRACTION)
  // more than a handful and one ring gets crowded; widen it rather than overlap
  const radius = r * (count > 6 ? count / 6 : 1)
  return Array.from({ length: count }, (_, i) => {
    // start at the top and go clockwise; the first (highest-priority) member
    // therefore always sits directly above the anchor
    const a = (i / count) * 2 * Math.PI - Math.PI / 2
    const lat = Math.max(-89.5, Math.min(89.5, centre.lat - Math.sin(a) * radius))
    const cos = Math.max(0.05, Math.cos(centre.lat * RAD))
    return { lat, lng: wrapLngDeg(centre.lng + (Math.cos(a) * radius) / cos) }
  })
}

/** A pin to draw: either one event or a collapsed cluster badge. */
export type PinDatum =
  | { kind: 'event'; id: string; lat: number; lng: number; event: HistoricalEvent; fanned: boolean }
  | { kind: 'cluster'; id: string; lat: number; lng: number; members: HistoricalEvent[] }

/** A leg drawn from an expanded cluster's anchor out to one fanned member. */
export interface ClusterLeg {
  id: string
  startLat: number
  startLng: number
  endLat: number
  endLng: number
  event: HistoricalEvent
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
  opts: { expandedId?: string; selectedId?: string; visibleSpanDeg: number },
): PinLayout {
  const pins: PinDatum[] = []
  const legs: ClusterLeg[] = []
  const asPin = (
    e: HistoricalEvent,
    at: { lat: number; lng: number } = e,
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
      const spots = fanPositions(g, g.members.length, opts.visibleSpanDeg)
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
      pins.push({ kind: 'cluster', id: g.id, lat: rest[0].lat, lng: rest[0].lng, members: rest })
  }
  return { pins, legs }
}

/**
 * Quantise the visible span before clustering. Zoom reports a new altitude on
 * every frame of a pinch; re-clustering (and so rebuilding every pin element)
 * that often is both wasteful and visually noisy. Snapping to half-octave
 * buckets means the grouping only changes at a handful of discrete zoom steps.
 */
export const clusterSpanBucket = (visibleSpanDeg: number) =>
  2 ** (Math.round(Math.log2(Math.max(1e-6, visibleSpanDeg)) * 2) / 2)

/** Has the view moved enough that an open cluster no longer makes sense? */
export const spanChangedEnough = (before: number, after: number, factor = 1.3) => {
  if (before <= 0) return true
  const r = after / before
  return r > factor || r < 1 / factor
}
