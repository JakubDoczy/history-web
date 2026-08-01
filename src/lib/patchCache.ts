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

/**
 * How much decoded imagery the cache may hold, in bytes.
 *
 * A count is not a bound. Four entries sounds modest until you notice what an
 * entry is: a decoded JPEG at up to the device's texture ceiling, which is
 * 4096x4096x4 = 67 MB each on a desktop — 268 MB of image data for a cache
 * described as "not a leak", before the composite canvas, its mip chain and the
 * Lanczos copies. The count still applies; this is the bound that holds when
 * the patches are large.
 *
 * 96 MB is roughly three full-screen patches on a dense display and a dozen at
 * the sizes a laptop actually asks for, which is what the cache is for.
 */
export const PATCH_MEMORY_BUDGET = 96 * 1024 * 1024

/**
 * Decoded size of a patch, in bytes, from what we already know about it.
 *
 * No new field to keep in step with the image: a patch's pixel dimensions are
 * its span times its own resolution, which is exactly what was requested.
 */
export const patchBytes = (p: { bbox: Bbox; pxPerDeg: number }): number => {
  const w = (p.bbox.maxLng - p.bbox.minLng) * p.pxPerDeg
  const h = (p.bbox.maxLat - p.bbox.minLat) * p.pxPerDeg
  return Math.max(0, w) * Math.max(0, h) * 4
}

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
  /**
   * Ground resolution of the fetched image, in metres per pixel.
   *
   * Carried on the patch rather than on the loader, so a composite can quote
   * the resolution of the imagery it actually drew instead of whichever request
   * returned most recently — which is the number the scale panel shows and the
   * one an "is this getting sharper or blurrier" check has to read.
   */
  groundRes: number
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
 * How much less of the view a sharper source may cover and still be preferred.
 *
 * The two sensors are fifty times apart in resolution, so almost any amount of
 * Sentinel-2 beats Blue Marble over the ground it covers. What it must not do
 * is win while covering a corner of the screen: the rest of the frame would
 * fall back to the base map, which is a much bigger loss than the sharpness is
 * a gain.
 */
export const SOURCE_COVERAGE_FLOOR = 0.6

/**
 * The one source worth compositing for a view: the sharpest one that still
 * covers most of what the best-covered source covers.
 *
 * Zoomed in, a Sentinel-2 patch and an older Blue Marble patch both cover the
 * whole frame, and the sharp one is obviously the one to keep. Zoomed out, the
 * wide Blue Marble patch covers everything and the Sentinel-2 patch is a
 * postage stamp in the middle — taking "sharpest" there would throw away the
 * imagery that covers the screen in favour of one that covers 3% of it.
 *
 * This used to be decided by coverage first, with a small tolerance breaking
 * ties in favour of sharpness, and that put the two the wrong way round: a pan
 * that left the sharp patch covering 90% of the frame against the coarse one's
 * 100% handed the whole view — including the ground the sharp patch still
 * covered — back to the 500 m source. Coverage is now a floor to clear rather
 * than a quantity to maximise, so sharpness only loses when it genuinely leaves
 * most of the screen bare.
 */
export function dominantSource<T>(
  patches: CachedPatch<T>[],
  target: Bbox,
  floor = SOURCE_COVERAGE_FLOOR,
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
  const all = [...bySource.entries()]
  if (!all.length) return undefined
  const bestCovered = Math.max(...all.map(([, s]) => s.covered))
  const eligible = all.filter(([, s]) => s.covered >= bestCovered * floor)
  return eligible.sort((a, b) => b[1].pxPerDeg - a[1].pxPerDeg)[0][0]
}

/**
 * Does `outer` cover every part of `inner` that this view can actually see?
 *
 * Only the part inside `target` matters: a patch may extend far beyond the
 * canvas, and what happens off the canvas cannot be drawn over.
 */
/** Does `outer` contain the whole of `inner`, whatever anyone is looking at? */
const contains = (outer: Bbox, inner: Bbox): boolean =>
  outer.minLat <= inner.minLat &&
  outer.maxLat >= inner.maxLat &&
  outer.minLng <= inner.minLng &&
  outer.maxLng >= inner.maxLng

/**
 * Fraction of the view a patch covers that nothing sharper already covers.
 *
 * Approximated by the largest single overlap rather than the true union of the
 * later patches. The approximation only ever *over*-states how much a patch
 * adds, so it can keep a patch that was not worth drawing and can never drop
 * one that was — and in the case this exists for, a stack of concentric
 * rectangles, one later patch contains all the others and the answer is exact.
 */
export function uniqueContribution<T>(
  patch: CachedPatch<T>,
  later: CachedPatch<T>[],
  target: Bbox,
): number {
  const own = coverage(target, patch.bbox)
  let hidden = 0
  for (const q of later) {
    const both = rectIntersection(patch.bbox, q.bbox)
    if (both) hidden = Math.max(hidden, coverage(target, both))
  }
  return Math.max(0, own - hidden)
}

/**
 * How much of the view a patch must add, over and above what is drawn on top of
 * it, to be worth drawing at all.
 *
 * Every patch in a composite brings a hard rectangular edge with it — the joins
 * inside a composite are not feathered, only its outer boundary is — so this is
 * really "how much ground is worth an edge". Measured over a scripted
 * continuous zoom-out, the draw stack averaged 3.6 patches deep with four
 * concentric copies of the same ground at the worst; at 2% that fell to 2.0,
 * and at 8% to 1.4, with the frames showing any nesting at all going from 88%
 * to 18%. Above about a tenth it starts refusing patches that cover a visible
 * slice of the screen, which is a coverage loss rather than an edge saved.
 */
export const MIN_UNIQUE_COVERAGE = 0.08

/**
 * Drop every patch that the ones drawn after it make redundant.
 *
 * A zoom leaves the cache holding a set of *concentric* rectangles: each wheel
 * notch asks for a box centred on the same point, and all of them arrive. Drawn
 * coarsest-first they stack — a big soft one, a smaller sharper one on top of
 * it, a smaller sharper one on top of that — and because the join between two
 * patches inside a composite has no feather, every step is a visible
 * rectangular edge. That is the "small image over a larger copy over a larger
 * copy" the field report describes.
 *
 * Zooming *in* the sharpest patch covers the whole view and hides the rest
 * outright, which an earlier version of this rule handled. Zooming *out* it
 * does not: the sharpest patch is the smallest, so it sits as an island in the
 * middle of the others and every one of them survives, contributing a ring of
 * ground a fraction of a degree wide and a hard edge all the way round. Asking
 * what a patch *adds* rather than whether it is completely buried covers both
 * directions with one test, and the threshold is what says a ring that thin was
 * never worth an edge.
 *
 * The sharpest patch is always kept: it is the imagery the view is actually
 * about, and at wide zoom it is the only thing standing between a sharp centre
 * and no patch at all.
 */
export function usefulPlan<T>(ordered: CachedPatch<T>[], target: Bbox): CachedPatch<T>[] {
  return ordered.filter(
    (p, i) =>
      i === ordered.length - 1 ||
      uniqueContribution(p, ordered.slice(i + 1), target) >= MIN_UNIQUE_COVERAGE,
  )
}

/**
 * Which cached patches are worth drawing for a view, in the order to draw them.
 *
 * A patch that has expired, that misses the view entirely (the camera jumped),
 * or that contributes a sliver too thin to notice is dropped — each one costs a
 * draw call and a chance of a visible seam. So is every patch from a source
 * other than the dominant one: see `dominantSource` and `CachedPatch.source`.
 *
 * Expiry goes through `afterTtl`, not a plain age test: the sharpest patch
 * covering the view stays until something at least as sharp replaces it, so a
 * clock can never be the reason the picture gets blurrier.
 */
export function compositePlan<T>(
  patches: CachedPatch<T>[],
  target: Bbox,
  now: number,
  ttlMs = PATCH_TTL_MS,
): CachedPatch<T>[] {
  const live = afterTtl(patches, target, now, ttlMs).filter(
    (p) => coverage(target, p.bbox) > 0.002,
  )
  const source = dominantSource(live, target)
  return usefulPlan(drawOrder(live.filter((p) => p.source === source)), target)
}

/**
 * Sharpest first, newest breaking a tie — the order in which patches earn their
 * place in a bounded cache.
 */
const byUsefulness = <T>(patches: CachedPatch<T>[]): CachedPatch<T>[] =>
  [...patches].sort((a, b) => b.pxPerDeg - a.pxPerDeg || b.at - a.at)

/**
 * Expiry, with the one exception that keeps the picture from going backwards.
 *
 * A patch older than the time to live is normally not worth drawing. But if it
 * is the sharpest thing that still covers this view, dropping it replaces what
 * is on screen with something coarser — and the imagery it holds has not
 * actually changed: these are static basemaps, and forty-five seconds does not
 * make a coastline wrong. So an expired patch survives exactly as long as
 * nothing fresh is as sharp. Everything else about the bound still holds:
 * patches that miss the view are dropped, and `pruneCache` still keeps only a
 * few.
 */
export function afterTtl<T>(
  patches: CachedPatch<T>[],
  target: Bbox,
  now: number,
  ttlMs = PATCH_TTL_MS,
): CachedPatch<T>[] {
  const covering = patches.filter((p) => coverage(target, p.bbox) > 0)
  const fresh = covering.filter((p) => now - p.at <= ttlMs)
  const best = byUsefulness(covering)[0]
  if (!best || fresh.includes(best)) return fresh
  return [best, ...fresh]
}

/**
 * What to keep after a patch arrives: the few that most improve this view.
 *
 * Age used to decide it, and age is the wrong question. During a zoom the
 * requests go out coarse-to-sharp but arrive in whatever order the network
 * allows, so "keep the four newest" regularly threw away the sharpest patch on
 * screen because a wider, coarser one from earlier in the same zoom happened to
 * land last. Measured against the mocked services, the composite went from
 * 275 m per pixel to 1187 m per pixel with the camera standing still, and back
 * again when the next request landed — the "replaced by lower and then back by
 * higher" the field report describes.
 *
 * So the ranking is what a patch is worth to the view: sharpest first, and a
 * patch is kept only if it reaches ground that nothing sharper already kept
 * reaches. A wide coarse patch survives because it fills the ring around the
 * sharp one; a redundant one inside it does not.
 */
export function pruneCache<T>(
  patches: CachedPatch<T>[],
  target: Bbox,
  now: number,
  keep = PATCH_KEEP,
  ttlMs = PATCH_TTL_MS,
  budget = PATCH_MEMORY_BUDGET,
): CachedPatch<T>[] {
  const kept: CachedPatch<T>[] = []
  let bytes = 0
  for (const p of byUsefulness(afterTtl(patches, target, now, ttlMs))) {
    if (kept.length >= keep) break
    // The sharpest patch is first, so it is always affordable: the budget can
    // only ever refuse the wider, coarser company it keeps.
    const size = patchBytes(p)
    if (kept.length && bytes + size > budget) continue
    bytes += size
    // Redundancy is judged against the patch's whole extent, not against the
    // view being pruned for. This runs when a patch *arrives*, so the target is
    // that arrival's own rectangle — and a patch is worth keeping precisely
    // because it covers ground the arrival does not. Only a sharper patch that
    // geometrically contains the whole of this one can never add anything, to
    // this view or to the next.
    if (kept.some((q) => contains(q.bbox, p.bbox))) continue
    kept.push(p)
  }
  return kept
}
