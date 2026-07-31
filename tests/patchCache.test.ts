import { describe, it, expect } from 'vitest'
import {
  rectIntersection,
  rectUnion,
  rectArea,
  coverage,
  drawOrder,
  placeOnCanvas,
  compositePlan,
  dominantSource,
  usefulPlan,
  uniqueContribution,
  MIN_UNIQUE_COVERAGE,
  pruneCache,
  PATCH_KEEP,
  PATCH_TTL_MS,
  type CachedPatch,
} from '../src/lib/patchCache'
import type { Bbox } from '../src/lib/detailImagery'

const box = (minLat: number, minLng: number, maxLat: number, maxLng: number): Bbox => ({
  minLat,
  minLng,
  maxLat,
  maxLng,
})

const patch = (
  bbox: Bbox,
  pxPerDeg: number,
  at: number,
  source = 'one',
): CachedPatch<string> => ({
  bbox,
  source,
  pxPerDeg,
  at,
  image: `${source}:${pxPerDeg}@${at}`,
})

describe('rectIntersection', () => {
  it('returns the overlapping part', () => {
    expect(rectIntersection(box(0, 0, 10, 10), box(5, 5, 20, 20))).toEqual(box(5, 5, 10, 10))
  })

  it('is undefined when the rectangles miss', () => {
    expect(rectIntersection(box(0, 0, 10, 10), box(20, 20, 30, 30))).toBeUndefined()
  })

  it('treats a shared edge as a miss, not a zero-area overlap', () => {
    // a patch that only touches the view contributes nothing and would still
    // cost a draw call and a seam
    expect(rectIntersection(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBeUndefined()
  })

  it('is commutative', () => {
    const a = box(-5, -30, 15, 40)
    const b = box(0, 0, 60, 60)
    expect(rectIntersection(a, b)).toEqual(rectIntersection(b, a))
  })
})

describe('rectUnion', () => {
  it('contains both inputs', () => {
    const u = rectUnion(box(0, 0, 10, 10), box(-5, 20, 3, 25))
    expect(u).toEqual(box(-5, 0, 10, 25))
    expect(rectArea(u)).toBeGreaterThanOrEqual(rectArea(box(0, 0, 10, 10)))
  })
})

describe('coverage', () => {
  it('is 1 when the patch swallows the view', () => {
    expect(coverage(box(0, 0, 10, 10), box(-90, -180, 90, 180))).toBeCloseTo(1, 9)
  })

  it('is the area fraction when it half covers', () => {
    expect(coverage(box(0, 0, 10, 10), box(0, 0, 10, 5))).toBeCloseTo(0.5, 9)
  })

  it('is 0 for a patch the camera has jumped away from', () => {
    expect(coverage(box(0, 0, 10, 10), box(40, 40, 50, 50))).toBe(0)
  })
})

describe('drawOrder', () => {
  it('puts the coarsest first, so the sharpest survives the overlap', () => {
    const order = drawOrder([patch(box(0, 0, 1, 1), 800, 5), patch(box(0, 0, 1, 1), 120, 1)])
    expect(order.map((p) => p.pxPerDeg)).toEqual([120, 800])
  })

  it('breaks ties by age, newest last', () => {
    const order = drawOrder([
      patch(box(0, 0, 1, 1), 500, 30),
      patch(box(0, 0, 1, 1), 500, 10),
      patch(box(0, 0, 1, 1), 500, 20),
    ])
    expect(order.map((p) => p.at)).toEqual([10, 20, 30])
  })

  it('does not mutate the array it is given', () => {
    const input = [patch(box(0, 0, 1, 1), 900, 1), patch(box(0, 0, 1, 1), 100, 2)]
    const before = input.map((p) => p.pxPerDeg)
    drawOrder(input)
    expect(input.map((p) => p.pxPerDeg)).toEqual(before)
  })
})

describe('placeOnCanvas', () => {
  const target = box(0, 0, 10, 20) // 10 deg tall, 20 deg wide

  it('fills the canvas when the patch is the view', () => {
    expect(placeOnCanvas(target, target, 200, 100)).toEqual({ x: 0, y: 0, w: 200, h: 100 })
  })

  it('flips latitude into canvas y, which runs the other way', () => {
    // the top half of the view in latitude is the top half of the canvas
    const top = placeOnCanvas(target, box(5, 0, 10, 20), 200, 100)
    expect(top).toEqual({ x: 0, y: 0, w: 200, h: 50 })
    const bottom = placeOnCanvas(target, box(0, 0, 5, 20), 200, 100)
    expect(bottom).toEqual({ x: 0, y: 50, w: 200, h: 50 })
  })

  it('places longitude left to right', () => {
    expect(placeOnCanvas(target, box(0, 10, 10, 20), 200, 100)).toEqual({
      x: 100,
      y: 0,
      w: 100,
      h: 100,
    })
  })

  it('lets a patch hang off the edge rather than distorting it', () => {
    // a patch larger than the view keeps its own scale; clipping is the
    // canvas's job, and squeezing it would misplace every pixel inside
    const p = placeOnCanvas(target, box(-10, -20, 20, 40), 200, 100)
    expect(p.x).toBe(-200)
    expect(p.y).toBe(-100)
    expect(p.w).toBe(600)
    expect(p.h).toBe(300)
  })

  it('round-trips a patch centre to the canvas centre', () => {
    for (const t of [box(0, 0, 10, 20), box(-33, 140, -30, 155), box(60, -10, 62, -4)]) {
      const inner = box(
        t.minLat + 0.25 * (t.maxLat - t.minLat),
        t.minLng + 0.25 * (t.maxLng - t.minLng),
        t.maxLat - 0.25 * (t.maxLat - t.minLat),
        t.maxLng - 0.25 * (t.maxLng - t.minLng),
      )
      const { x, y, w, h } = placeOnCanvas(t, inner, 400, 300)
      expect(x + w / 2).toBeCloseTo(200, 6)
      expect(y + h / 2).toBeCloseTo(150, 6)
    }
  })
})

describe('compositePlan', () => {
  const target = box(0, 0, 10, 10)

  it('keeps the patches that still overlap, coarsest first', () => {
    const plan = compositePlan(
      [
        patch(box(0, 0, 5, 5), 900, 100), // sharp, but only a quarter of the view
        patch(box(-20, -20, 20, 20), 60, 90),
        patch(box(80, 80, 89, 89), 1200, 99), // the camera jumped away from this
      ],
      target,
      100,
    )
    expect(plan.map((p) => p.pxPerDeg)).toEqual([60, 900])
  })

  it('drops a patch that a sharper one covers completely', () => {
    // A zoom-in leaves concentric rectangles in the cache. Stacked, each join is
    // a hard rectangular edge with no feather — a small image over a larger copy
    // over a larger copy — and not one pixel of the lower layers survives.
    const plan = compositePlan(
      [
        patch(box(-20, -20, 20, 20), 60, 90),
        patch(box(-5, -5, 15, 15), 300, 95),
        patch(box(0, 0, 10, 10), 900, 100),
      ],
      target,
      100,
    )
    expect(plan.map((p) => p.pxPerDeg)).toEqual([900])
  })

  it('keeps a coarse patch that covers ground the sharp one does not', () => {
    const plan = compositePlan(
      [
        patch(box(-20, -20, 20, 20), 60, 90),
        patch(box(0, 0, 10, 6), 900, 100), // stops short of the north edge
      ],
      target,
      100,
    )
    expect(plan.map((p) => p.pxPerDeg)).toEqual([60, 900])
  })

  it('drops patches older than the time to live, once something fresh is as sharp', () => {
    const plan = compositePlan(
      [patch(target, 900, 0), patch(target, 900, PATCH_TTL_MS)],
      target,
      PATCH_TTL_MS + 1,
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].at).toBe(PATCH_TTL_MS)
  })

  it('keeps an expired patch that is still the sharpest thing covering the view', () => {
    // A clock must never be the reason the picture gets blurrier. The imagery
    // has not changed — these are static basemaps — so dropping the only sharp
    // patch on screen in favour of a fresh coarse one is a pure regression.
    const plan = compositePlan(
      [patch(target, 900, 0), patch(target, 400, PATCH_TTL_MS)],
      target,
      PATCH_TTL_MS + 1,
    )
    expect(plan.map((p) => p.pxPerDeg)).toContain(900)
    expect(plan[plan.length - 1].pxPerDeg).toBe(900) // and it is what gets drawn on top
  })

  it('drops slivers too thin to be worth a draw call', () => {
    const sliver = box(0, 9.99, 10, 10)
    expect(compositePlan([patch(sliver, 900, 0)], target, 0)).toHaveLength(0)
  })

  it('is empty when nothing has been fetched yet', () => {
    expect(compositePlan([], target, 0)).toEqual([])
  })

  it('never draws two sources onto one canvas', () => {
    // The composite is a single texture with a single feathered rectangle, so
    // where two sensors meet inside it there is nothing to blend the join with:
    // it is a hard straight line with a palette step across it.
    const plan = compositePlan(
      [
        patch(box(0, 0, 5, 10), 900, 100, 'sentinel'), // southern half
        patch(box(0, 0, 10, 10), 60, 90, 'bluemarble'),
        patch(box(5, 0, 10, 10), 900, 95, 'sentinel'), // northern half
      ],
      target,
      100,
    )
    expect(new Set(plan.map((p) => p.source)).size).toBe(1)
    expect(plan).toHaveLength(2)
  })
})

describe('dominantSource', () => {
  const target = box(0, 0, 10, 10)

  it('prefers the sharper source when both cover the view', () => {
    expect(
      dominantSource([
        patch(box(-5, -5, 15, 15), 60, 0, 'bluemarble'),
        patch(box(0, 0, 10, 10), 900, 1, 'sentinel'),
      ], target),
    ).toBe('sentinel')
  })

  it('prefers the source that covers the view over a sharper island in it', () => {
    // zoomed out: the wide 500 m patch is the whole picture and the 10 m patch
    // is a postage stamp. Taking "sharpest" here would drop the imagery that
    // covers the screen in favour of one that covers 1% of it.
    expect(
      dominantSource([
        patch(box(0, 0, 10, 10), 60, 0, 'bluemarble'),
        patch(box(4.5, 4.5, 5.5, 5.5), 900, 1, 'sentinel'),
      ], target),
    ).toBe('bluemarble')
  })

  it('adds up several patches of the same source', () => {
    // two halves of the view from one source beat a sharp patch that reaches
    // only a corner of it
    expect(
      dominantSource([
        patch(box(0, 0, 10, 5), 60, 0, 'halves'),
        patch(box(0, 5, 10, 10), 60, 1, 'halves'),
        patch(box(0, 0, 10, 2), 900, 2, 'sharp'),
      ], target),
    ).toBe('halves')
  })

  it('keeps the sharp source through a pan that leaves a strip uncovered', () => {
    // The old rule maximised coverage, so 90% sharp lost to 100% coarse and the
    // whole view — including the ground the sharp patch still covered — dropped
    // to the 500 m source. Coverage is a floor to clear, not a prize.
    expect(
      dominantSource([
        patch(box(0, 0, 10, 10), 60, 1, 'coarse'),
        patch(box(0, 0, 9, 10), 900, 2, 'sharp'),
      ], target),
    ).toBe('sharp')
  })

  it('ignores patches that miss the view, and is undefined with nothing to draw', () => {
    expect(dominantSource([patch(box(80, 80, 89, 89), 900, 0, 'far')], target)).toBeUndefined()
    expect(dominantSource([], target)).toBeUndefined()
  })

  it('does not flip sensor on a rounding difference in coverage', () => {
    // both cover essentially all of it; the tolerance is what stops the
    // composite alternating between sensors as the camera drifts a hair
    const a = dominantSource([
      patch(box(-0.001, 0, 10, 10), 60, 0, 'coarse'),
      patch(box(0, 0, 10, 10), 900, 1, 'sharp'),
    ], target)
    expect(a).toBe('sharp')
  })
})

describe('usefulPlan', () => {
  const target = box(0, 0, 10, 10)

  it('drops the concentric layers a zoom leaves behind', () => {
    // Each wheel notch asks for a smaller box around the same point and they
    // all arrive. Stacked coarsest-first that is a big soft rectangle, a
    // smaller sharper one on it, a smaller sharper one on that — and the joins
    // inside a composite have no feather, so every step is a visible edge:
    // "a small image over a larger copy over a larger copy".
    const plan = usefulPlan(
      drawOrder([
        patch(box(-10, -10, 20, 20), 100, 1),
        patch(box(-2, -2, 12, 12), 400, 2),
        patch(box(-1, -1, 11, 11), 900, 3),
      ]),
      target,
    )
    expect(plan.map((p) => p.pxPerDeg)).toEqual([900])
  })

  it('keeps a coarse patch that reaches ground the sharp one does not', () => {
    const plan = usefulPlan(
      drawOrder([patch(box(-5, -5, 15, 15), 100, 1), patch(box(2, 2, 8, 8), 900, 2)]),
      target,
    )
    expect(plan.map((p) => p.pxPerDeg)).toEqual([100, 900])
  })

  it('collapses the stack a zoom-OUT leaves, where nothing is fully hidden', () => {
    // The case the "completely buried" rule could not see. Zooming out, the
    // sharpest patch is the *smallest*: it sits as an island inside the others,
    // so every one of them survives and contributes a ring of ground a fraction
    // of a degree wide with a hard rectangular edge all the way round it.
    const wide = box(0, 0, 40, 40)
    const plan = usefulPlan(
      drawOrder([
        patch(box(18, 18, 22, 22), 323, 1),
        patch(box(18.4, 18.4, 21.6, 21.6), 379, 2),
        patch(box(18.8, 18.8, 21.2, 21.2), 452, 3),
      ]),
      wide,
    )
    expect(plan.map((p) => p.pxPerDeg)).toEqual([452])
  })

  it('never drops the sharpest patch, however little of the view it covers', () => {
    // at wide zoom it is the only thing between a sharp centre and no patch
    const wide = box(0, 0, 90, 90)
    const only = patch(box(44, 44, 46, 46), 900, 1)
    expect(usefulPlan(drawOrder([only]), wide)).toEqual([only])
  })

  it('keeps patches that each hold their own part of a pan', () => {
    const plan = usefulPlan(
      drawOrder([patch(box(0, 0, 10, 5), 900, 1), patch(box(0, 5, 10, 10), 900, 2)]),
      target,
    )
    expect(plan).toHaveLength(2)
  })
})

describe('uniqueContribution', () => {
  const target = box(0, 0, 10, 10)

  it('is the whole coverage when nothing is drawn over it', () => {
    expect(uniqueContribution(patch(box(0, 0, 10, 5), 60, 0), [], target)).toBeCloseTo(0.5, 6)
  })

  it('is zero when a later patch buries it', () => {
    expect(
      uniqueContribution(patch(box(2, 2, 8, 8), 60, 0), [patch(box(0, 0, 10, 10), 900, 1)], target),
    ).toBeCloseTo(0, 6)
  })

  it('is the ring a concentric patch adds', () => {
    const outer = patch(box(0, 0, 10, 10), 60, 0)
    const inner = patch(box(1, 1, 9, 9), 900, 1)
    // 100% of the view minus the 64% the inner one covers
    expect(uniqueContribution(outer, [inner], target)).toBeCloseTo(1 - 0.64, 6)
  })

  it('never claims a patch adds less than it does', () => {
    // the approximation takes the largest single overlap, not the union, so it
    // may over-state what a patch adds and can never drop one that mattered
    const p = patch(box(0, 0, 10, 10), 60, 0)
    const halves = [patch(box(0, 0, 10, 5), 900, 1), patch(box(0, 5, 10, 10), 900, 2)]
    expect(uniqueContribution(p, halves, target)).toBeGreaterThanOrEqual(0)
    expect(MIN_UNIQUE_COVERAGE).toBeGreaterThan(0)
  })
})

describe('pruneCache', () => {
  const target = box(0, 0, 10, 10)

  it('keeps the newest few when they are all equally useful', () => {
    // same rectangle, same resolution: nothing tells them apart but age, and a
    // patch that contains an earlier one entirely cannot need it
    const many = Array.from({ length: 9 }, (_, i) => patch(box(0, 0, 10, 10 - i * 0.01), 60, i))
    const kept = pruneCache(many, target, 10)
    expect(kept).toHaveLength(PATCH_KEEP)
    expect(kept[0].at).toBe(8) // newest first
  })

  it('never evicts a sharper patch to make room for a coarser newer one', () => {
    // This is the flip-flop. During a zoom the requests go out coarse to sharp
    // and arrive in whatever order the network allows, so keeping "the newest
    // four" regularly threw away the sharpest imagery on screen because a wider,
    // coarser patch from earlier in the same zoom happened to land last.
    const sharp = patch(box(4, 4, 6, 6), 4000, 0)
    const coarse = Array.from({ length: 6 }, (_, i) => patch(box(-i, -i, 10 + i, 10 + i), 100 + i, i + 1))
    const kept = pruneCache([...coarse, sharp], target, 10)
    expect(kept).toContain(sharp)
    expect(kept[0]).toBe(sharp) // and it is ranked first, so it survives every later arrival
  })

  it('bounds what it holds in bytes, not just in entries', () => {
    // Four entries is not a bound: an entry is a decoded image at up to the
    // device's texture ceiling, which is 67 MB on a desktop.
    const huge = (i: number) => patch(box(0, 0, 40, 40), 2000 - i, i) // ~25 GB each
    const many = [huge(0), huge(1), huge(2), huge(3)]
    const kept = pruneCache(many, target, 10)
    expect(kept).toHaveLength(1) // the sharpest, and nothing else fits
    expect(kept[0].pxPerDeg).toBe(2000)
    // and the sharpest is kept even when it alone exceeds the budget: refusing
    // it would leave the view with nothing at all
    expect(pruneCache([huge(0)], target, 10)).toHaveLength(1)
  })

  it('keeps several patches when they fit', () => {
    const small = (i: number) => patch(box(-i, -i, 10 + i, 10 + i), 40 - i, i)
    expect(pruneCache([small(0), small(1), small(2)], target, 10)).toHaveLength(3)
  })

  it('drops a patch a sharper one contains outright', () => {
    const wide = patch(box(0, 0, 10, 10), 900, 5)
    const inner = patch(box(2, 2, 8, 8), 300, 6) // newer, coarser, entirely inside
    expect(pruneCache([wide, inner], target, 10)).toEqual([wide])
  })

  it('forgets patches the camera has jumped away from', () => {
    const kept = pruneCache(
      [patch(target, 500, 1), patch(box(70, 70, 80, 80), 500, 2)],
      target,
      3,
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].bbox).toEqual(target)
  })

  it('forgets expired patches once something fresh is as sharp', () => {
    const kept = pruneCache(
      [patch(target, 500, 0), patch(target, 500, PATCH_TTL_MS)],
      target,
      PATCH_TTL_MS + 1,
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].at).toBe(PATCH_TTL_MS)
  })

  it('holds an expired patch that is still the only sharp imagery for the view', () => {
    const kept = pruneCache([patch(target, 500, 0)], target, PATCH_TTL_MS + 1)
    expect(kept).toHaveLength(1)
  })
})
