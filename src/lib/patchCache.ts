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
  /**
   * Which imagery source produced it.
   *
   * Two sources that disagree about colour must never end up on the same
   * canvas: Sentinel-2 is a different sensor from Blue Marble, greener and
   * darker, and where the two met inside a composite the join was a hard
   * straight line with a palette step across it — the "patch versus patch seam"
   * no amount of edge feathering can help, because the feather is at the
   * *rectangle's* edge and this seam is in the middle of it.
   */
  source: string
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
 * The one source worth compositing for a view: whichever covers most of it,
 * and the sharper one when two cover it equally well.
 *
 * Both halves of that rule earn their place. Zoomed in, a Sentinel-2 patch and
 * an older Blue Marble patch both cover the whole frame, and the sharp one is
 * obviously the one to keep. Zoomed out, the wide Blue Marble patch covers
 * everything and the Sentinel-2 patch is a postage stamp in the middle — taking
 * "sharpest" there would throw away the imagery that covers the screen in
 * favour of one that covers 3% of it.
 *
 * The tolerance matters: coverage is rarely exactly equal, and without it a
 * source that covered 0.999 of the view would beat one that covered 1.0 by a
 * rounding error and the composite would flip between sensors as the camera
 * drifted.
 */
export function dominantSource<T>(
  patches: CachedPatch<T>[],
  target: Bbox,
  tolerance = 0.05,
): string | undefined {
  const bySource = new Map<string, { covered: number; pxPerDeg: number }>()
  for (const p of patches) {
    const c = coverage(target, p.bbox)
    if (c <= 0) continue
    const held = bySource.get(p.source) ?? { covered: 0, pxPerDeg: 0 }
    held.covered = Math.min(1, held.covered + c)
    held.pxPerDeg = Math.max(held.pxPerDeg, p.pxPerDeg)
    bySource.set(p.source, held)
  }
  let best: { source: string; covered: number; pxPerDeg: number } | undefined
  for (const [source, s] of bySource) {
    if (
      !best ||
      s.covered > best.covered + tolerance ||
      (s.covered > best.covered - tolerance && s.pxPerDeg > best.pxPerDeg)
    ) {
      best = { source, ...s }
    }
  }
  return best?.source
}

/**
 * Does `outer` cover every part of `inner` that this view can actually see?
 *
 * Only the part inside `target` matters: a patch may extend far beyond the
 * canvas, and what happens off the canvas cannot be drawn over.
 */
const hides = (outer: Bbox, inner: Bbox, target: Bbox): boolean => {
  const seen = rectIntersection(target, inner)
  if (!seen) return true
  return (
    outer.minLat <= seen.minLat &&
    outer.maxLat >= seen.maxLat &&
    outer.minLng <= seen.minLng &&
    outer.maxLng >= seen.maxLng
  )
}

/**
 * Drop every patch that something drawn after it covers completely.
 *
 * A zoom-in leaves the cache holding a set of *concentric* rectangles: each
 * wheel notch asks for a smaller box centred on the same point, and all four
 * arrive. Drawn coarsest-first they stack — a big soft one, a smaller sharper
 * one on top of it, a smaller sharper one on top of that — and because the join
 * between two patches inside a composite has no feather, every step is a visible
 * rectangular edge. That is the "small image over a larger copy over a larger
 * copy" the field report describes, and none of those lower layers contributes a
 * single pixel that survives to the screen.
 */
export function visiblePlan<T>(ordered: CachedPatch<T>[], target: Bbox): CachedPatch<T>[] {
  return ordered.filter(
    (p, i) => !ordered.some((q, j) => j > i && hides(q.bbox, p.bbox, target)),
  )
}

/**
 * Which cached patches are worth drawing for a view, in the order to draw them.
 *
 * A patch that has expired, that misses the view entirely (the camera jumped),
 * or that contributes a sliver too thin to notice is dropped — each one costs a
 * draw call and a chance of a visible seam. So is every patch from a source
 * other than the dominant one: see `dominantSource` and `CachedPatch.source`.
 */
export function compositePlan<T>(
  patches: CachedPatch<T>[],
  target: Bbox,
  now: number,
  ttlMs = PATCH_TTL_MS,
): CachedPatch<T>[] {
  const live = patches.filter((p) => now - p.at <= ttlMs && coverage(target, p.bbox) > 0.002)
  const source = dominantSource(live, target)
  return visiblePlan(drawOrder(live.filter((p) => p.source === source)), target)
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
