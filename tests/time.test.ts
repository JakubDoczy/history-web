import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { formatYear, clamp, toWarp, fromWarp, MIN_TIME, MAX_TIME } from '../src/lib/time'
import { useTimeStore } from '../src/stores/time'

describe('formatYear', () => {
  it.each([
    [-250e6, '250 Ma'],
    [-4.5e9, '4500 Ma'],
    [-12_000, '12 ka'],
    [-2999, '3000 BCE'],
    [0, '1 BCE'],
    [1969, '1969'],
  ])('%d → %s', (t, s) => expect(formatYear(t)).toBe(s))
})

describe('clamp', () => {
  it('clamps to Earth history bounds by default', () => {
    expect(clamp(-9e9)).toBe(MIN_TIME)
    expect(clamp(99999)).toBe(MAX_TIME)
    expect(clamp(1500)).toBe(1500)
  })
})

describe('time store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('setTime clamps to visible range', () => {
    const s = useTimeStore()
    s.range = { start: 1000, end: 2000 }
    s.setTime(3000)
    expect(s.currentTime).toBe(2000)
  })

  it('zoom shrinks span and keeps the focused instant fixed', () => {
    const s = useTimeStore()
    s.range = { start: -1e6, end: 2000 }
    const focusTime = fromWarp(
      toWarp(s.range.start) + (toWarp(s.range.end) - toWarp(s.range.start)) * 0.3,
    )
    s.zoom(0.5, 0.3)
    expect(s.span).toBeLessThan(1e6 + 2000)
    const after = fromWarp(
      toWarp(s.range.start) + (toWarp(s.range.end) - toWarp(s.range.start)) * 0.3,
    )
    expect(after / focusTime).toBeCloseTo(1, 3) // focus point stays put
    s.range = { start: 0, end: 1 }
    s.zoom(0.1)
    expect(s.span).toBeGreaterThanOrEqual(1) // never below 1 year
  })

  it('warp roundtrips and is monotonic', () => {
    for (const t of [MIN_TIME, -250e6, -10_000, 0, 1500, MAX_TIME]) {
      expect(Math.abs(fromWarp(toWarp(t)) - t)).toBeLessThan(Math.max(1e-5 * Math.abs(t), 1e-5))
    }
    expect(toWarp(-1e9)).toBeLessThan(toWarp(-1e6))
    expect(toWarp(-1e6)).toBeLessThan(toWarp(2000))
  })

  it('is effectively linear for narrow recent windows', () => {
    // deviation of the midpoint from the linear midpoint, as fraction of span
    const midDeviation = (a: number, b: number) => {
      const mid = fromWarp((toWarp(a) + toWarp(b)) / 2)
      return Math.abs(mid - (a + b) / 2) / (b - a)
    }
    expect(midDeviation(2016, 2026)).toBeLessThan(0.005) // 10 years: linear (dev ≈ days)
    expect(midDeviation(1926, 2026)).toBeLessThan(0.05) // 100 years: pretty linear
    expect(midDeviation(-4e9, 2026)).toBeGreaterThan(0.3) // full range: strongly log
  })

  it('zoom out is clamped to global bounds', () => {
    const s = useTimeStore()
    s.zoom(100)
    expect(s.range.start).toBeGreaterThanOrEqual(MIN_TIME)
    expect(s.range.end).toBeLessThanOrEqual(MAX_TIME)
  })

  it('focusTime recenters the window when the target is outside it', () => {
    const s = useTimeStore()
    s.range = { start: 1900, end: 2000 }
    s.focusTime(1950)
    expect(s.range).toEqual({ start: 1900, end: 2000 }) // inside: window untouched
    s.focusTime(-250e6)
    expect(s.currentTime).toBe(-250e6)
    expect(s.range.start).toBeLessThan(-250e6)
    expect(s.range.end).toBeGreaterThan(-250e6)
  })

  it('pan shifts window and stops at bounds', () => {
    const s = useTimeStore()
    s.range = { start: 0, end: 1000 }
    s.pan(0.5)
    expect(s.range.start).toBeGreaterThan(0)
    expect(s.range.end).toBeGreaterThan(1000)
    s.pan(1e6)
    expect(s.range.end).toBeLessThanOrEqual(MAX_TIME)
    s.pan(-1e6)
    expect(s.range.start).toBeGreaterThanOrEqual(MIN_TIME)
  })
})

/**
 * Downstream of these three properties sit the border digest, the event index
 * and the era plan, and all of them are invalidated by *identity*. So the thing
 * under test is not the numbers — those were always right — but whether new
 * objects were published at all.
 */
describe('time store: a move that moves nothing publishes nothing', () => {
  beforeEach(() => setActivePinia(createPinia()))

  /** Identities of everything a downstream watcher keys on. */
  const snap = (s: ReturnType<typeof useTimeStore>) => ({
    range: s.range,
    selection: s.selection,
    currentTime: s.currentTime,
  })

  it('panning against the end of time republishes nothing', () => {
    const s = useTimeStore()
    s.setRange({ start: MAX_TIME - 100, end: MAX_TIME })
    const before = snap(s)
    for (let i = 0; i < 30; i++) s.pan(0.2) // a held drag at the rail's end
    expect(snap(s)).toEqual(before)
    expect(s.range).toBe(before.range) // same object, not merely equal
    expect(s.selection).toBe(before.selection)
  })

  it('panning against the beginning of time republishes nothing', () => {
    const s = useTimeStore()
    s.setRange({ start: MIN_TIME, end: MIN_TIME + 1e6 })
    const before = snap(s)
    for (let i = 0; i < 30; i++) s.pan(-0.2)
    expect(s.range).toBe(before.range)
    expect(s.selection).toBe(before.selection)
    expect(s.currentTime).toBe(before.currentTime)
  })

  it('zooming out at full extent republishes nothing', () => {
    const s = useTimeStore()
    s.setRange({ start: MIN_TIME, end: MAX_TIME })
    const before = snap(s)
    for (let i = 0; i < 10; i++) s.zoom(4)
    expect(s.range).toBe(before.range)
    expect(s.selection).toBe(before.selection)
  })

  it('setRange to the identical window republishes nothing', () => {
    const s = useTimeStore()
    const before = snap(s)
    s.setRange({ ...s.range }) // same numbers, different object
    expect(s.range).toBe(before.range)
    expect(s.selection).toBe(before.selection)
  })

  it('a selection handle held past the window edge republishes nothing', () => {
    const s = useTimeStore()
    s.setRange({ start: 1000, end: 2000 })
    s.setSelection(1200, 1800)
    const held = s.selection
    s.setSelection(1200, 2400) // dragged past the end: clamps back to 2000
    const clamped = s.selection
    expect(clamped).not.toBe(held)
    for (let i = 0; i < 20; i++) s.setSelection(1200, 2400 + i * 100)
    expect(s.selection).toBe(clamped) // ...and never again
  })

  it('a pan into the bound lands exactly on it, and settles there', () => {
    const s = useTimeStore()
    s.setRange({ start: MIN_TIME + 1e6, end: MIN_TIME + 2e6 })
    s.pan(-10) // overshoot the beginning of time
    // exactly the bound, not the warp roundtrip of it: 5 µyr of slack here is
    // enough for a held drag to oscillate between two windows forever
    expect(s.range.start).toBe(MIN_TIME)
    const settled = s.range
    s.pan(-10)
    s.pan(-0.01)
    expect(s.range).toBe(settled)
  })

  it('a pan into the end of time lands exactly on it, and settles there', () => {
    const s = useTimeStore()
    s.setRange({ start: MAX_TIME - 2000, end: MAX_TIME - 1000 })
    s.pan(10)
    expect(s.range.end).toBe(MAX_TIME)
    const settled = s.range
    s.pan(10)
    expect(s.range).toBe(settled)
  })

  it('a pan with room to move still moves', () => {
    const s = useTimeStore()
    s.setRange({ start: 1000, end: 2000 })
    const before = s.range
    s.pan(0.25)
    expect(s.range).not.toBe(before)
    expect(s.range.start).toBeGreaterThan(1000)
  })

  it('still publishes when something really does change', () => {
    const s = useTimeStore()
    s.setRange({ start: 1000, end: 2000 })
    const before = snap(s)
    s.setRange({ start: 1001, end: 2000 })
    expect(s.range).not.toBe(before.range)
    expect(s.range).toEqual({ start: 1001, end: 2000 })
  })

  it('publishes when only the selection is squeezed by the move', () => {
    const s = useTimeStore()
    s.setRange({ start: 1000, end: 2000 })
    s.setSelection(1100, 1900)
    const before = snap(s)
    s.setRange({ start: 1000, end: 1500 }) // same start, selection must clamp
    expect(s.selection).not.toBe(before.selection)
    expect(s.selection.end).toBeLessThanOrEqual(1500)
  })

  it('publishes when only the cursor is squeezed by the move', () => {
    const s = useTimeStore()
    s.setRange({ start: 1000, end: 2000 })
    s.setSelection(1000, 2000)
    s.setTime(1900)
    s.setRange({ start: 1000, end: 2000 }) // no-op, to settle
    const before = snap(s)
    s.setRange({ start: 1000, end: 1800 })
    expect(s.currentTime).toBe(1800)
    expect(s.currentTime).not.toBe(before.currentTime)
  })
})
