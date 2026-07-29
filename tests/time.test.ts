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
