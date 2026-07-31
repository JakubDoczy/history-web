import type { Bbox } from './detailImagery'

/**
 * A short-lived memory of the patches we have already paid for.
 *
 * Streaming one patch per settled view means that the moment the camera moves,
 * the only sharp imagery on screen is thrown away and the view falls back to the
 * 4096-wide basemap for the ~300 ms of settle plus however long the request
 * takes. The centre of the screen — which did not move — goes soft for no
 * reason.
 *
 * So the last few patches are kept and drawn onto a canvas cut to the new view:
 * whatever the old patches still cover stays exactly as sharp as it was, and
 * only the strip newly exposed at the edges shows the basemap until the fresh
 * request lands. The shader is unchanged; it still gets one texture and one
 * rectangle.
 */

/** How long a patch is worth compositing before its imagery is stale. */
export const PATCH_TTL_MS = 45_000
/** How many to keep. Enough to cover a pan plus a zoom-out; not a leak. */
export const PATCH_KEEP = 4

export interface CachedPatch<T> {
  bbox: Bbox
  /** Effective resolution of the fetched image, in pixels per degree of longitude. */
  pxPerDeg: number
  /** When it arrived, on the same clock as the `now` passed to these functions. */
  at: number
  image: T
}

/** The overlapping part of two rectangles, or undefined if they miss entirely. */
export function rectIntersection(a: Bbox, b: Bbox): Bbox | undefined {
  const minLat = Math.max(a.minLat, b.minLat)
  const maxLat = Math.min(a.maxLat, b.maxLat)
  const minLng = Math.max(a.minLng, b.minLng)
  const maxLng = Math.min(a.maxLng, b.maxLng)
  if (maxLat <= minLat || maxLng <= minLng) return undefined
  return { minLat, minLng, maxLat, maxLng }
}

/** The smallest rectangle containing both. */
export function rectUnion(a: Bbox, b: Bbox): Bbox {
  return {
    minLat: Math.min(a.minLat, b.minLat),
    minLng: Math.min(a.minLng, b.minLng),
    maxLat: Math.max(a.maxLat, b.maxLat),
    maxLng: Math.max(a.maxLng, b.maxLng),
  }
}

export const rectArea = (b: Bbox) =>
  Math.max(0, b.maxLat - b.minLat) * Math.max(0, b.maxLng - b.minLng)

/** How much of `target` a patch covers, 0..1. */
export function coverage(target: Bbox, patch: Bbox): number {
  const hit = rectIntersection(target, patch)
  const area = rectArea(target)
  return hit && area > 0 ? rectArea(hit) / area : 0
}

/**
 * Draw order: coarsest first, sharpest last, so the sharpest imagery survives
 * where patches overlap. Equal resolutions fall back to age, newest last —
 * two patches at the same zoom differ only in how recently the source saw them.
 */
export function drawOrder<T>(patches: CachedPatch<T>[]): CachedPatch<T>[] {
  return [...patches].sort((a, b) => a.pxPerDeg - b.pxPerDeg || a.at - b.at)
}

/**
 * Where a patch lands on a canvas that covers exactly `target`.
 *
 * Latitude runs up and canvas y runs down, which is the one sign error this
 * whole file exists to get right in a single tested place.
 */
export function placeOnCanvas(
  target: Bbox,
  patch: Bbox,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const lngSpan = Math.max(target.maxLng - target.minLng, 1e-9)
  const latSpan = Math.max(target.maxLat - target.minLat, 1e-9)
  return {
    x: ((patch.minLng - target.minLng) / lngSpan) * width,
    y: ((target.maxLat - patch.maxLat) / latSpan) * height,
    w: ((patch.maxLng - patch.minLng) / lngSpan) * width,
    h: ((patch.maxLat - patch.minLat) / latSpan) * height,
  }
}

/**
 * Which cached patches are worth drawing for a view, in the order to draw them.
 *
 * A patch that has expired, that misses the view entirely (the camera jumped),
 * or that contributes a sliver too thin to notice is dropped — each one costs a
 * draw call and a chance of a visible seam.
 */
export function compositePlan<T>(
  patches: CachedPatch<T>[],
  target: Bbox,
  now: number,
  ttlMs = PATCH_TTL_MS,
): CachedPatch<T>[] {
  return drawOrder(
    patches.filter((p) => now - p.at <= ttlMs && coverage(target, p.bbox) > 0.002),
  )
}

/**
 * What to keep after a patch arrives: the freshest few that still have
 * something to say about this view. Expiry and the big-jump case are the same
 * rule seen twice — a patch nobody can see again is not worth holding.
 */
export function pruneCache<T>(
  patches: CachedPatch<T>[],
  target: Bbox,
  now: number,
  keep = PATCH_KEEP,
  ttlMs = PATCH_TTL_MS,
): CachedPatch<T>[] {
  return patches
    .filter((p) => now - p.at <= ttlMs && coverage(target, p.bbox) > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, keep)
}
