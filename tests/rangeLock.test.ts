import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LOCK,
  depthOf,
  deriveLock,
  isDefaultLock,
  LOCK_DOMAIN,
  LOCK_FLOOR_YEARS,
  LOCK_SCALE,
  LOCK_SCALE_RANGE,
  LOCK_SPLIT,
  lockedWindow,
} from '../src/lib/rangeLock'
import { MAX_TIME, MIN_TIME, PRESENT, toWarp } from '../src/lib/time'
import { SUB_AGE_MAX_SPAN, subLaneOpen, bandsFor } from '../src/lib/eras'

const span = (w: { start: number; end: number }) => w.end - w.start

describe('the locked window: the reader’s own example', () => {
  it('is 1 year back and 5 forward near the present', () => {
    // the sentence this whole feature came from: "near current years something
    // like 1 year back and 5 to the future"
    const w = lockedWindow(2000)
    expect(span(w)).toBe(LOCK_FLOOR_YEARS)
    expect(w.start).toBe(1999)
    expect(w.end).toBe(2005)
    expect(2000 - w.start).toBe(1)
    expect(w.end - 2000).toBe(5)
  })

  it('holds the floor for every year the proportional rule would undercut', () => {
    // below k·distance = FLOOR the rule would ask for less than six years, and
    // at the present itself for none at all
    for (let y = PRESENT - Math.floor(LOCK_FLOOR_YEARS / LOCK_SCALE); y <= PRESENT; y++)
      expect(span(lockedWindow(y))).toBe(LOCK_FLOOR_YEARS)
  })

  it('is exactly the floor at the present, slid back off the end of time', () => {
    // 5 forward would be 2031, and the future is not history: the window slides
    // rather than shrinking, so it keeps its six years
    const w = lockedWindow(PRESENT)
    expect(w).toEqual({ start: MAX_TIME - LOCK_FLOOR_YEARS, end: MAX_TIME })
    expect(span(w)).toBe(LOCK_FLOOR_YEARS)
  })
})

describe('the locked window is proportional to depth', () => {
  it('grows as k times the distance from the present, continuously', () => {
    for (const d of [1e3, 1e4, 1e5, 1e6, 1e8, 1e9]) {
      const w = lockedWindow(PRESENT - d)
      expect(span(w)).toBeCloseTo(LOCK_SCALE * d, 6)
    }
  })

  it('has no steps in it: neighbouring years get neighbouring windows', () => {
    const a = span(lockedWindow(-900_000))
    const b = span(lockedWindow(-900_001))
    expect(b / a).toBeCloseTo(1, 5)
  })

  it('gives a click at 1 Ma a vastly wider window than one at 1990', () => {
    expect(span(lockedWindow(-1e6)) / span(lockedWindow(1990))).toBeGreaterThan(20_000)
  })

  it('keeps the clicked year inside, at every depth and at both ends of time', () => {
    for (const y of [MIN_TIME, -4e9, -2.5e9, -1e6, -10_000, 0, 1500, 1990, 2020, MAX_TIME])
      for (const k of [0.02, LOCK_SCALE, 0.5, 2])
        for (const s of [0, 0.1, LOCK_SPLIT, 0.9, 1]) {
          const w = lockedWindow(y, k, s)
          expect(w.start).toBeLessThanOrEqual(y)
          expect(w.end).toBeGreaterThanOrEqual(y)
          expect(w.start).toBeGreaterThanOrEqual(MIN_TIME)
          expect(w.end).toBeLessThanOrEqual(MAX_TIME)
        }
  })

  it('preserves the split wherever there is room for it', () => {
    for (const y of [-2.5e9, -1e6, -10_000, 1000]) {
      const w = lockedWindow(y)
      expect((y - w.start) / span(w)).toBeCloseTo(LOCK_SPLIT, 9)
    }
  })

  it('slides rather than shrinks at the beginning of time', () => {
    const w = lockedWindow(MIN_TIME)
    expect(w.start).toBe(MIN_TIME)
    expect(span(w)).toBeCloseTo(LOCK_SCALE * depthOf(MIN_TIME), 0)
  })

  it('cannot ask for more than the whole timeline', () => {
    const w = lockedWindow(MIN_TIME, 10)
    expect(w).toEqual({ start: MIN_TIME, end: MAX_TIME })
  })

  it('treats the future as no distance at all', () => {
    expect(depthOf(PRESENT + 500)).toBe(0)
    expect(lockedWindow(PRESENT + 500)).toEqual(lockedWindow(PRESENT))
  })

  it('works in deep time, where the years are large negatives', () => {
    const w = lockedWindow(-2.5e9)
    expect(span(w)).toBeCloseTo(0.2 * (2.5e9 + PRESENT), 0)
    expect(w.start).toBeLessThan(-2.5e9)
    expect(w.end).toBeGreaterThan(-2.5e9)
    expect(w.start).toBeLessThan(w.end) // no reversed magnitudes
  })
})

/**
 * WHY k = 0.2, as measurements rather than as taste.
 *
 * These are the two boundaries the constant was chosen against — where the
 * rail's own tables change what they draw — so if either table moves, this is
 * what says the constant has to be looked at again.
 */
describe('k, by what the rail actually draws', () => {
  it('opens the named-period lane for the whole of recorded history', () => {
    // the fine lane appears at windows of 2000 years or less; at k = 0.2 that
    // is every click back to ~8000 BCE, which covers 21 of the 23 named
    // periods and the back half of the Neolithic band
    const boundary = PRESENT - SUB_AGE_MAX_SPAN / LOCK_SCALE
    expect(boundary).toBeGreaterThan(-8100)
    expect(boundary).toBeLessThan(-7900)
    for (const y of [1990, 1500, 0, -3000, -7000])
      expect(subLaneOpen(...ends(lockedWindow(y)))).toBe(true)
    for (const y of [-12_000, -1e6]) expect(subLaneOpen(...ends(lockedWindow(y)))).toBe(false)
  })

  it('flips the era strip to geology deep inside the Stone Age', () => {
    // human-history bands are drawn up to a 20 000-year window, i.e. back to
    // ~100 ka at k = 0.2 — 3 Ma of Stone Age band remains beyond it, which is
    // the strip saying "this is prehistory" rather than naming a period
    expect(named(lockedWindow(-50_000))).toContain('Stone Age')
    expect(named(lockedWindow(-1e6))).toContain('Quaternary')
    expect(named(lockedWindow(-1e8))).toContain('Cretaceous')
    expect(named(lockedWindow(-2.5e9))).toEqual(['Archean', 'Proterozoic'])
  })

  it('shows an era and the edges of its neighbours, not one era swallowed', () => {
    // measured share of the geological period the click landed in: enough to
    // read the era you are in, not so much that it becomes a single band
    const share = (y: number, len: number) => span(lockedWindow(y)) / len
    expect(share(-1e8, 79e6)).toBeGreaterThan(0.15) // Cretaceous
    expect(share(-1e8, 79e6)).toBeLessThan(0.35)
    expect(share(-2.5e9, 1.53e9)).toBeGreaterThan(0.15) // Archean
    expect(share(-2.5e9, 1.53e9)).toBeLessThan(0.5)
  })

  it('is the same zoom at every depth, because the warp is logarithmic', () => {
    // a window that is a fixed fraction of the distance to the present has a
    // fixed WIDTH IN WARP — so the rail looks the same at 10 ka and at 2.5 Ga.
    // Measured: 0.215 of a warp unit, on a rail 18.13 units wide.
    const widths = [-1e4, -1e6, -1e8, -2.5e9].map((y) => {
      const w = lockedWindow(y)
      return toWarp(w.end) - toWarp(w.start)
    })
    for (const u of widths) expect(u).toBeCloseTo(0.215, 3)
    expect(toWarp(MAX_TIME) - toWarp(MIN_TIME)).toBeCloseTo(18.13, 2)
  })
})

const ends = (w: { start: number; end: number }): [number, number] => [w.start, w.end]
const named = (w: { start: number; end: number }) => bandsFor(w.start, w.end).map((e) => e.name)

describe('re-deriving the lock from a window the reader made', () => {
  it('reads k straight back off a deep-time band', () => {
    const year = -1e6
    const lock = deriveLock({ start: -1.4e6, end: -0.9e6 }, year)
    expect(lock.scale).toBeCloseTo(5e5 / depthOf(year), 6)
    expect(lock.split).toBeCloseTo(4e5 / 5e5, 6)
  })

  it('round-trips: a window derived from a lock teaches the same lock back', () => {
    for (const y of [-2.5e9, -1e6, -10_000, 1000]) {
      const w = lockedWindow(y)
      const lock = deriveLock(w, y)
      expect(lock.scale).toBeCloseTo(LOCK_SCALE, 9)
      expect(lock.split).toBeCloseTo(LOCK_SPLIT, 9)
    }
  })

  it('keeps the previous k where the floor, not the reader, set the span', () => {
    // 2020 is ten years from the present: any six-year band there is the floor
    // speaking, and reading k off it would teach 0.6 — 1.5 Ga of window at
    // 2.5 Ga. The split it still learns, since that is what "1 back, 5
    // forward" is a statement about.
    const lock = deriveLock({ start: 2018, end: 2024 }, 2020, DEFAULT_LOCK)
    expect(lock.scale).toBe(DEFAULT_LOCK.scale)
    expect(lock.split).toBeCloseTo(2 / 6, 9)
  })

  it('clamps a k that would take the next click off the rail', () => {
    const wild = deriveLock({ start: -1e9, end: 0 }, -100, DEFAULT_LOCK)
    expect(wild.scale).toBe(LOCK_SCALE_RANGE.max)
    const tiny = deriveLock({ start: -1e6, end: -1e6 + 1 }, -1e6, DEFAULT_LOCK)
    expect(tiny.scale).toBe(LOCK_SCALE_RANGE.min)
  })

  it('clamps the split when the cursor sits outside the band', () => {
    // a handle dragged past the cursor leaves it outside; the drag still wins
    expect(deriveLock({ start: -1e6, end: -0.9e6 }, -1.2e6).split).toBe(0)
    expect(deriveLock({ start: -1e6, end: -0.9e6 }, -0.5e6).split).toBe(1)
  })

  it('keeps both parameters for a band of no width', () => {
    const lock = deriveLock({ start: -1e6, end: -1e6 }, -1e6, { scale: 0.4, split: 0.3 })
    expect(lock).toEqual({ scale: 0.4, split: 0.3 })
  })

  it('orders a band handed over backwards', () => {
    const a = deriveLock({ start: -0.9e6, end: -1.4e6 }, -1e6)
    const b = deriveLock({ start: -1.4e6, end: -0.9e6 }, -1e6)
    expect(a).toEqual(b)
  })
})

describe('the lock’s defaults', () => {
  it('are the reader’s example, and nothing else is', () => {
    expect(DEFAULT_LOCK).toEqual({ scale: LOCK_SCALE, split: LOCK_SPLIT })
    expect(LOCK_FLOOR_YEARS * LOCK_SPLIT).toBe(1) // one year back
    expect(LOCK_FLOOR_YEARS * (1 - LOCK_SPLIT)).toBe(5) // five forward
    expect(isDefaultLock(DEFAULT_LOCK)).toBe(true)
    expect(isDefaultLock({ ...DEFAULT_LOCK, scale: 0.21 })).toBe(false)
    expect(isDefaultLock({ ...DEFAULT_LOCK, split: 0.5 })).toBe(false)
  })

  it('spans the whole of Earth history', () => {
    expect(LOCK_DOMAIN).toEqual({ start: MIN_TIME, end: MAX_TIME })
  })
})
