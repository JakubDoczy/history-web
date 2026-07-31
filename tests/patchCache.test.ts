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
        patch(box(0, 0, 10, 10), 900, 100),
        patch(box(-20, -20, 20, 20), 60, 90),
        patch(box(80, 80, 89, 89), 1200, 99), // the camera jumped away from this
      ],
      target,
      100,
    )
    expect(plan.map((p) => p.pxPerDeg)).toEqual([60, 900])
  })

  it('drops patches older than the time to live', () => {
    const plan = compositePlan(
      [patch(target, 900, 0), patch(target, 400, PATCH_TTL_MS)],
      target,
      PATCH_TTL_MS + 1,
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].pxPerDeg).toBe(400)
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
        patch(box(0, 0, 10, 10), 900, 100, 'sentinel'),
        patch(box(0, 0, 10, 10), 60, 90, 'bluemarble'),
        patch(box(0, 0, 5, 5), 900, 95, 'sentinel'),
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
    expect(
      dominantSource([
        patch(box(0, 0, 10, 5), 60, 0, 'halves'),
        patch(box(0, 5, 10, 10), 60, 1, 'halves'),
        patch(box(0, 0, 10, 6), 900, 2, 'sharp'),
      ], target),
    ).toBe('halves')
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

describe('pruneCache', () => {
  const target = box(0, 0, 10, 10)

  it('keeps only the newest few', () => {
    const many = Array.from({ length: 9 }, (_, i) => patch(target, 500, i))
    const kept = pruneCache(many, target, 10)
    expect(kept).toHaveLength(PATCH_KEEP)
    expect(kept[0].at).toBe(8) // newest first
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

  it('forgets expired patches even when they still overlap', () => {
    const kept = pruneCache([patch(target, 500, 0)], target, PATCH_TTL_MS + 1)
    expect(kept).toEqual([])
  })
})
