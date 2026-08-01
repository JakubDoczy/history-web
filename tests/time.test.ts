import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  formatYear,
  clamp,
  toWarp,
  fromWarp,
  presentYear,
  PRESENT,
  MIN_TIME,
  MAX_TIME,
} from '../src/lib/time'
import { HISTORICAL } from '../src/lib/eras'
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

/** The rail ends now. Not at a round number in the future — at the current year. */
describe('the end of time is the present', () => {
  it('is read from the clock, once, at module load', () => {
    expect(MAX_TIME).toBe(PRESENT)
    expect(PRESENT).toBe(new Date().getFullYear())
    // injectable, so this is a property of the clock and not of a literal
    expect(presentYear(new Date(2031, 5, 14))).toBe(2031)
    expect(presentYear(new Date(1969, 6, 20))).toBe(1969)
  })

  it('admits nothing from the future', () => {
    expect(clamp(MAX_TIME + 1)).toBe(MAX_TIME)
    expect(clamp(3000)).toBe(MAX_TIME)
    // warp saturates there too: every future year maps to the end of the rail
    expect(toWarp(MAX_TIME)).toBe(0)
    expect(toWarp(MAX_TIME + 500)).toBe(toWarp(MAX_TIME))
    expect(fromWarp(0)).toBe(MAX_TIME)
  })

  it('leaves the last historical era ending today, not in 2100', () => {
    const contemporary = HISTORICAL[HISTORICAL.length - 1]
    expect(contemporary.name).toBe('Contemporary')
    expect(contemporary.end).toBe(MAX_TIME)
  })
})

describe('time store stops at the present', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens on a window that ends now', () => {
    expect(useTimeStore().range.end).toBe(MAX_TIME)
  })

  it('cannot scrub, focus or select past it', () => {
    const s = useTimeStore()
    s.setTime(9999)
    expect(s.currentTime).toBe(MAX_TIME)
    s.focusTime(4000)
    expect(s.currentTime).toBe(MAX_TIME)
    expect(s.range.end).toBeLessThanOrEqual(MAX_TIME)
    s.setSelection(1900, 9999)
    expect(s.selection.end).toBeLessThanOrEqual(MAX_TIME)
  })

  it('cannot pan or zoom past it, from any window', () => {
    const s = useTimeStore()
    for (const start of [MIN_TIME, -10_000, 1900, MAX_TIME - 50]) {
      s.setRange({ start, end: Math.min(MAX_TIME, start + 100) })
      for (let i = 0; i < 20; i++) s.pan(0.7)
      expect(s.range.end).toBeLessThanOrEqual(MAX_TIME)
      s.zoom(0.5, 1) // zoom in hard against the right-hand edge
      expect(s.range.end).toBeLessThanOrEqual(MAX_TIME)
      expect(s.currentTime).toBeLessThanOrEqual(MAX_TIME)
      expect(s.selection.end).toBeLessThanOrEqual(MAX_TIME)
    }
  })

  it('frames the Contemporary era right up to today when picked from the era combo', () => {
    const s = useTimeStore()
    s.selectEra(HISTORICAL[HISTORICAL.length - 1])
    expect(s.selection).toEqual({ start: 1945, end: MAX_TIME })
    expect(s.range.end).toBe(MAX_TIME)
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
 * The band is the display filter: only what it covers reaches the globe. So a
 * year picked from outside it would leave the cursor on an empty world, and the
 * band has to come along — by the nearer edge, exactly, and no further.
 */
describe('the selection follows the year you pick', () => {
  beforeEach(() => setActivePinia(createPinia()))

  /** A window and band with room on both sides to grow into. */
  const framed = () => {
    const s = useTimeStore()
    s.setRange({ start: 1000, end: 2000 })
    s.setSelection(1300, 1600)
    s.setTime(1400)
    return s
  }

  it('leaves the band alone for a year already inside it', () => {
    const s = framed()
    const before = s.selection
    s.setTime(1550)
    expect(s.currentTime).toBe(1550)
    expect(s.selection).toBe(before) // the same object, so nothing downstream re-runs
    s.setTime(1300) // exactly on an edge is inside
    s.setTime(1600)
    expect(s.selection).toBe(before)
  })

  it('extends the end exactly, and does not touch the start', () => {
    const s = framed()
    s.setTime(1750)
    expect(s.selection).toEqual({ start: 1300, end: 1750 })
    expect(s.currentTime).toBe(1750)
  })

  it('extends the start exactly, and does not touch the end', () => {
    const s = framed()
    s.setTime(1100)
    expect(s.selection).toEqual({ start: 1100, end: 1600 })
    expect(s.currentTime).toBe(1100)
  })

  it('never recentres the band — the far edge is where it was', () => {
    const s = framed()
    s.setTime(1990)
    expect(s.selection.start).toBe(1300)
    s.setTime(1010)
    expect(s.selection.end).toBe(1990)
  })

  it('drags the edge along, monotonically, as the cursor scrubs past it', () => {
    const s = framed()
    let last = s.selection.end
    for (let y = 1600; y <= 1900; y += 20) {
      s.setTime(y)
      expect(s.selection.end).toBe(Math.max(1600, y)) // the edge is *on* the cursor
      expect(s.selection.end).toBeGreaterThanOrEqual(last)
      expect(s.selection.start).toBe(1300)
      last = s.selection.end
    }
    // scrubbing back into the band does not shrink what the scrub opened up
    const opened = s.selection
    s.setTime(1500)
    expect(s.selection).toBe(opened)
  })

  it('jumps outside the window: the window recentres and the band reaches the year', () => {
    const s = useTimeStore()
    s.focusTime(-250e6)
    expect(s.currentTime).toBe(-250e6)
    expect(s.range.start).toBeLessThan(-250e6)
    expect(s.range.end).toBeGreaterThan(-250e6)
    // inside *both*: the recentre happens first, or the clamp would clip the
    // extension straight back out again
    expect(s.selection.start).toBe(-250e6)
    expect(s.selection.end).toBeGreaterThan(-250e6)
    expect(s.selection.start).toBeGreaterThanOrEqual(s.range.start)
    expect(s.selection.end).toBeLessThanOrEqual(s.range.end)
  })

  it('does not extend when the cursor is moved by a clamp rather than by a user', () => {
    const s = useTimeStore()
    // a cursor sitting outside the band (only reachable programmatically now)
    s.range = { start: 1000, end: 2000 }
    s.selection = { start: 1000, end: 1200 }
    s.currentTime = 1800
    s.setRange({ start: 1000, end: 1500 }) // the window shrinks and pulls the cursor
    expect(s.currentTime).toBe(1500)
    // ...and the band does not chase it back. (Value, not identity: setRange
    // republishes all three together when any one of them moves.)
    expect(s.selection).toEqual({ start: 1000, end: 1200 })
  })

  it('settles at the end of time instead of oscillating there', () => {
    const s = useTimeStore()
    s.setRange({ start: MAX_TIME - 100, end: MAX_TIME })
    s.setTime(MAX_TIME)
    expect(s.selection.end).toBe(MAX_TIME) // exactly, not the warp roundtrip of it
    const settled = s.selection
    for (let i = 0; i < 20; i++) s.setTime(9999) // held against the present
    expect(s.selection).toBe(settled)
    expect(s.currentTime).toBe(MAX_TIME)
  })

  it('settles at the beginning of time instead of oscillating there', () => {
    const s = useTimeStore()
    s.setRange({ start: MIN_TIME, end: MIN_TIME + 1e6 })
    s.setTime(MIN_TIME)
    expect(s.selection.start).toBe(MIN_TIME)
    const settled = s.selection
    for (let i = 0; i < 20; i++) s.setTime(-9e9)
    expect(s.selection).toBe(settled)
    expect(s.currentTime).toBe(MIN_TIME)
  })

  it('leaves the era combo setting the band outright', () => {
    const s = useTimeStore()
    const medieval = HISTORICAL.find((e) => e.name === 'Medieval')!
    s.setTime(1990) // opens the band out past 1945 to 1990
    expect(s.selection.end).toBe(1990)
    s.selectEra(medieval)
    // the era *is* the selection, even though the cursor is now outside it: an
    // era is a framing, not a jump
    expect(s.selection).toEqual({ start: 500, end: 1500 })
    expect(s.currentTime).toBe(1990)
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
