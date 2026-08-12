import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  formatOn,
  formatYear,
  clamp,
  toWarp,
  fromWarp,
  presentYear,
  PRESENT,
  MIN_TIME,
  MAX_TIME,
  formatTime,
  pointTime,
  timeEnd,
  timeExtent,
  timeFrom,
  timeIntersects,
  timeLength,
  timeStart,
  type Time,
} from '../src/lib/time'
import { HISTORICAL } from '../src/lib/eras'
import { useEventStore } from '../src/stores/events'
import { FIT_MS, HOME_SELECTION, HOME_WINDOW, HOME_YEAR, useTimeStore } from '../src/stores/time'
import { MIN_SEL_FRACTION, SLIDE_MARGIN, windowFitting, type Span } from '../src/lib/selection'
import { LOCK_SCALE, LOCK_SPLIT, lockedWindow } from '../src/lib/rangeLock'

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

  it('opens on a window inside the ends of time, and reaches the present', () => {
    // Round 57 moved the opening window off the present and onto 1400–1789, at
    // the reader's request (see stores/time.ts HOME_WINDOW and 'the opening
    // view' below). What this block is about is unchanged: nothing runs past
    // the present, and a window taken there ends exactly there.
    const s = useTimeStore()
    expect(s.range.start).toBeGreaterThanOrEqual(MIN_TIME)
    expect(s.range.end).toBeLessThanOrEqual(MAX_TIME)
    s.setRange({ start: -550, end: MAX_TIME })
    expect(s.range.end).toBe(MAX_TIME)
  })

  it('cannot scrub, focus or select past it', () => {
    const s = useTimeStore()
    s.setRange({ start: -550, end: MAX_TIME }) // a window with the present on it
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
    s.setRange({ start: -550, end: MAX_TIME }) // room for the years below
    s.setTime(1990) // opens the band out past 1945 to 1990
    expect(s.selection.end).toBe(1990)
    s.selectEra(medieval)
    // the era *is* the selection, outright — the 1990 the cursor asked for does
    // not widen it, and neither does the 500 that follows
    expect(s.selection).toEqual({ start: 500, end: 1500 })
    // the fit takes the window off 1990 entirely, so the cursor has to come with
    // it; it lands on the near edge of the era rather than adrift in the margin
    expect(s.currentTime).toBe(1500)
    expect(s.selection).toEqual({ start: 500, end: 1500 })
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

/* ------------------------------------------------- the band and the rail ---
   Regression: `selectEra` sets the band to the era and then *flies* the window
   to it, so for the length of the flight the band is wider than the rail — and
   what put it back was the tween landing. Any gesture cancels the tween, and
   two of them then returned without touching the band: a pan already hard
   against the end of time (`d === 0`) and a zoom refused by the minimum-span
   guard. The band stayed off the rail, drawn at a negative x, until something
   unrelated happened to re-clamp it. See /tmp/shots35/repro-era-band.mjs. */
describe('the selection is never stranded outside the window', () => {
  const STONE_AGE = { name: 'Stone Age', start: -3e6, end: -3301, color: '#5a5f6d' }
  /** Frames of a fit in flight — collected, and run only when a test says so. */
  let frames: FrameRequestCallback[]
  /** A clock the test drives, so a tween can be flown without waiting on one. */
  let clock: number

  const inWindow = (s: ReturnType<typeof useTimeStore>) =>
    s.selection.start >= s.range.start && s.selection.end <= s.range.end

  /** The state the repro starts from: home window, home band, a fit in flight. */
  const eraFlightFromHome = () => {
    const s = useTimeStore()
    s.setRange({ start: -550, end: MAX_TIME })
    s.setSelection(500, 1945)
    s.selectEra(STONE_AGE)
    expect(frames.length).toBeGreaterThan(0) // the fit really is in the air
    expect(inWindow(s)).toBe(false) // ...and the band is deliberately off-rail
    return s
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    frames = []
    // a clock to fly against, and a user who has not asked for less motion —
    // without both, fitWindow lands in one synchronous step and there is no
    // in-flight state to strand anything
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    clock = performance.now()
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('re-clamps when a pan is refused for being hard against the end of time', () => {
    const s = useTimeStore()
    eraFlightFromHome()
    const before = s.range
    s.pan(1) // the window already ends at the present: nothing to pan into
    expect(s.range).toBe(before) // still not a pan…
    expect(inWindow(s)).toBe(true) // …but the band is back on the rail
  })

  it('re-clamps when a zoom is refused by the minimum-span guard', () => {
    const s = useTimeStore()
    eraFlightFromHome()
    const before = s.range
    s.zoom(1e-5) // a window less than a year wide: refused
    expect(s.range).toBe(before)
    expect(inWindow(s)).toBe(true)
  })

  it('leaves the band on the rail when a scrub takes the view over mid-flight', () => {
    const s = useTimeStore()
    eraFlightFromHome()
    s.setTime(-100000) // outside the window, so the cursor lands on its edge
    expect(inWindow(s)).toBe(true)
    expect(s.currentTime).toBeGreaterThanOrEqual(s.range.start)
  })

  it('lands the flight with the band on the rail', () => {
    const s = useTimeStore()
    eraFlightFromHome()
    // half way there: still in the air, still off the rail
    clock += FIT_MS / 2
    frames.shift()!(clock)
    expect(inWindow(s)).toBe(false)
    // and now the landing
    clock += FIT_MS
    frames.shift()!(clock)
    expect(s.range).toEqual(windowFitting(STONE_AGE))
    expect(inWindow(s)).toBe(true)
  })

  it('clamps the era into the window it is flying to, at the moment it is set', () => {
    // no clock: the fit lands synchronously, and the band must be inside it
    vi.unstubAllGlobals()
    setActivePinia(createPinia())
    const s = useTimeStore()
    for (const era of HISTORICAL) {
      s.selectEra(era)
      expect(inWindow(s), era.name).toBe(true)
      expect(s.selection).toEqual({ start: Math.max(era.start, MIN_TIME), end: era.end })
    }
  })
})

/**
 * TIME AS A VARIANT (see `Time` in src/lib/time.ts).
 *
 * The type replaces `start` plus an optional `end`, and the whole of the case
 * for it is that `end ?? start` was written in six places and meant a slightly
 * different thing in each. What is asserted here is the contract those six
 * places now share: how the boundary decides which member it is, and that every
 * fold answers the same for a point as the old arithmetic did.
 */
describe('Time', () => {
  describe('the boundary decides the member, once', () => {
    it('is a point when there is no end', () => {
      expect(timeFrom(1969)).toEqual({ kind: 'point', year: 1969 })
    })

    it('is a point when the end is the start — a war dated 1812–1812 is a year', () => {
      expect(timeFrom(1812, 1812)).toEqual({ kind: 'point', year: 1812 })
    })

    it('is a period when the two differ', () => {
      expect(timeFrom(1939, 1945)).toEqual({ kind: 'period', start: 1939, end: 1945 })
    })

    it('orders a reversed pair rather than carrying it', () => {
      expect(timeFrom(1945, 1939)).toEqual({ kind: 'period', start: 1939, end: 1945 })
    })

    it('handles deep time and year zero like any other number', () => {
      expect(timeFrom(-4.5e9, -4.4e9)).toEqual({ kind: 'period', start: -4.5e9, end: -4.4e9 })
      // the case the old truthy tests got wrong: `end` of 0 is a real year
      expect(timeFrom(-10, 0)).toEqual({ kind: 'period', start: -10, end: 0 })
      expect(timeFrom(0)).toEqual({ kind: 'point', year: 0 })
    })
  })

  describe('the folds', () => {
    const point = pointTime(1969)
    const period = timeFrom(1939, 1945)

    it('gives a point zero length and its own year at both ends', () => {
      expect(timeExtent(point)).toEqual([1969, 1969])
      expect(timeStart(point)).toBe(1969)
      expect(timeEnd(point)).toBe(1969)
      expect(timeLength(point)).toBe(0)
    })

    it('gives a period its two ends and the years between them', () => {
      expect(timeExtent(period)).toEqual([1939, 1945])
      expect(timeStart(period)).toBe(1939)
      expect(timeEnd(period)).toBe(1945)
      expect(timeLength(period)).toBe(6)
    })

    /**
     * Closed at both ends, and that is the load-bearing half: an event dated to
     * exactly the edge of the selection band is ON the timeline. Three callers
     * ask this question and they have to agree to the year.
     */
    it('intersects on a closed interval, touching years included', () => {
      expect(timeIntersects(period, 1939, 1945)).toBe(true)
      expect(timeIntersects(period, 1900, 1939)).toBe(true) // meeting at the start
      expect(timeIntersects(period, 1945, 2000)).toBe(true) // and at the end
      expect(timeIntersects(period, 1941, 1942)).toBe(true) // a band inside it
      expect(timeIntersects(period, 1900, 1938)).toBe(false)
      expect(timeIntersects(period, 1946, 2000)).toBe(false)
      expect(timeIntersects(point, 1969, 1969)).toBe(true)
      expect(timeIntersects(point, 1970, 2000)).toBe(false)
    })

    it('formats each kind the way the panel reads it', () => {
      expect(formatTime(point)).toBe('1969')
      expect(formatTime(period)).toBe('1939 – 1945')
      expect(formatTime(pointTime(-99))).toBe('100 BCE')
    })

    /**
     * A DATE IS NAMED BY THE YEAR IT IS IN (round 45).
     *
     * The corpus dates things to the day now — World War II opens on 1
     * September 1939, which is the year 1939.667 — and `formatYear` rounds,
     * because its own callers are continuous positions on the era rail. Every
     * item's own time goes through `formatOn` instead, or the war would have
     * been captioned "1940 – 1946".
     */
    it('names an item’s date by the year it falls in, not the nearest one', () => {
      expect(formatOn(1939.667)).toBe('1939')
      expect(formatOn(1945.67)).toBe('1945')
      expect(formatOn(1944)).toBe('1944') // the integers are unchanged
      expect(formatTime(timeFrom(1939.66712, 1945.66986))).toBe('1939 – 1945')
    })

    it('says a period inside one year once, rather than twice', () => {
      // Normandy: 6 June to 25 July 1944. The rail says the months.
      expect(formatTime(timeFrom(1944.43033, 1944.56421))).toBe('1944')
    })
  })

  /**
   * The property the old `end ?? start` was reaching for, stated once: a point
   * behaves exactly like a period of zero width, so nothing downstream needs a
   * case for it.
   */
  it('answers for a point exactly as for a zero-width period', () => {
    for (const y of [-4.5e9, -752, 0, 1969, MAX_TIME]) {
      const point = pointTime(y)
      const degenerate: Time = { kind: 'period', start: y, end: y }
      expect(timeExtent(point)).toEqual(timeExtent(degenerate))
      expect(timeLength(point)).toBe(timeLength(degenerate))
      for (const [a, b] of [[y - 1, y + 1], [y, y], [y + 1, y + 2]])
        expect(timeIntersects(point, a, b)).toBe(timeIntersects(degenerate, a, b))
    }
  })
})

/* ----------------------------------------------------------- the range lock */

/**
 * THE LOCK: a press on the rail brings the range with it, at the scale the
 * depth deserves. The maths is tests/rangeLock.test.ts; this is the store's
 * half — that the default is on, that the window and the band and the cursor
 * all land together, that the drag wins and teaches, that the era overrides,
 * and that with the lock off the rail behaves exactly as it did before.
 */
describe('the range lock', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const width = (s: Span) => s.end - s.start

  it('is on by default, on the reader’s own proportions', () => {
    const s = useTimeStore()
    expect(s.rangeLock).toBe(true)
    expect(s.lockScale).toBe(LOCK_SCALE)
    expect(s.lockSplit).toBe(LOCK_SPLIT)
    expect(s.lockIsDefault).toBe(true)
  })

  it('gives a click near the present one year back and five forward', () => {
    const s = useTimeStore()
    s.setRange({ start: 1900, end: MAX_TIME }) // a century, with 2000 well inside
    const before = { ...s.range }
    s.scrubTo(2000)
    expect(s.currentTime).toBe(2000)
    expect(s.selection).toEqual({ start: 1999, end: 2005 })
    // …and the rail did not move, because the band it asked for was already on
    // it. Round 56 fitted the window to the band here — a 6.6-year rail — which
    // is the shift the reader complained about. See 'the view holds still'.
    expect(s.range).toEqual(before)
  })

  it('gives a click at 1 Ma a window a hundred thousand times wider', () => {
    const s = useTimeStore()
    s.scrubTo(1990)
    const near = width(s.selection)
    s.scrubTo(-1e6)
    expect(s.currentTime).toBe(-1e6)
    expect(width(s.selection)).toBeCloseTo(0.2 * (1e6 + MAX_TIME), 0)
    expect(width(s.selection) / near).toBeGreaterThan(20_000)
  })

  it('works at −2.5 Ga, where the years are large negatives', () => {
    const s = useTimeStore()
    s.scrubTo(-2.5e9)
    expect(s.currentTime).toBe(-2.5e9)
    expect(s.selection.start).toBeLessThan(-2.5e9)
    expect(s.selection.end).toBeGreaterThan(-2.5e9)
    expect(s.selection.start).toBeGreaterThanOrEqual(MIN_TIME)
    expect(width(s.selection)).toBeCloseTo(0.2 * (2.5e9 + MAX_TIME), 0)
  })

  it('keeps the rail’s standing invariants at every depth', () => {
    const s = useTimeStore()
    for (const y of [MIN_TIME, -2.5e9, -1e6, -10_000, 0, 1500, 1990, 2020, MAX_TIME]) {
      s.scrubTo(y)
      expect(s.currentTime).toBeGreaterThanOrEqual(s.selection.start)
      expect(s.currentTime).toBeLessThanOrEqual(s.selection.end)
      expect(s.selection.start).toBeGreaterThanOrEqual(s.range.start)
      expect(s.selection.end).toBeLessThanOrEqual(s.range.end)
    }
  })

  it('converges instead of ratcheting: the same depth is the same scale', () => {
    // the span is a function of the clicked year alone, never of the window it
    // was clicked in — so a reader clicking about in one era stays at one zoom
    const s = useTimeStore()
    s.scrubTo(-1e6)
    const first = width(s.selection)
    s.scrubTo(-1e6)
    expect(width(s.selection)).toBe(first)
    s.scrubTo(-1.02e6)
    expect(width(s.selection) / first).toBeCloseTo(1.02, 2)
  })

  it('unlocked, a press on the rail is setTime to the byte', () => {
    const locked = useTimeStore()
    locked.setRangeLock(false)
    const plain = useTimeStore(createPinia())
    for (const y of [1990, 1200, -10_000, 1500, MAX_TIME]) {
      locked.scrubTo(y)
      plain.setTime(y)
      expect(locked.range).toEqual(plain.range)
      expect(locked.selection).toEqual(plain.selection)
      expect(locked.currentTime).toEqual(plain.currentTime)
    }
  })

  it('lets the drag win, and learns the reader’s proportions from it', () => {
    const s = useTimeStore()
    s.setRange({ start: -2e6, end: 0 }) // zoomed out by hand
    s.setTime(-1e6)
    s.setSelection(-1.5e6, -0.5e6) // …and both handles dragged wide open
    s.learnLock() // (TimelineBar calls this when the handle is released)
    expect(s.lockIsDefault).toBe(false)
    expect(s.lockScale).toBeCloseTo(1e6 / (1e6 + MAX_TIME), 3)
    expect(s.lockSplit).toBeCloseTo(0.5, 3)
    // the next click is answered in those proportions, at whatever depth
    s.scrubTo(-2e6)
    expect(width(s.selection) / 2e6).toBeCloseTo(1, 2)
    expect((s.currentTime - s.selection.start) / width(s.selection)).toBeCloseTo(0.5, 2)
  })

  it('resets to the shipped proportions on demand', () => {
    const s = useTimeStore()
    s.scrubTo(-1e6)
    s.setSelection(-1.5e6, -0.5e6)
    s.learnLock()
    expect(s.lockIsDefault).toBe(false)
    s.resetLock()
    expect(s.lockIsDefault).toBe(true)
    s.scrubTo(-1e6)
    expect(width(s.selection)).toBeCloseTo(0.2 * (1e6 + MAX_TIME), 0)
  })

  it('learns nothing while it is off', () => {
    const s = useTimeStore()
    s.setRangeLock(false)
    s.setSelection(-1.5e6, -0.5e6)
    s.setTime(-1e6)
    s.learnLock()
    expect(s.lockIsDefault).toBe(true)
  })

  it('toggles, and nothing moves until the next press', () => {
    const s = useTimeStore()
    s.scrubTo(1500) // locked: the band becomes 1482–1588, on a rail that holds still
    const framed = { ...s.range }
    s.toggleRangeLock()
    expect(s.rangeLock).toBe(false)
    expect(s.range).toEqual(framed)
    s.scrubTo(1550) // unlocked: the cursor moves, the window does not
    expect(s.range).toEqual(framed)
    expect(s.currentTime).toBe(1550)
  })

  /**
   * Picking an era means "show me this era", not "recentre my relative window
   * on its edge" — so the fit wins over the lock. And then the era teaches it:
   * the lock's next answer is at the era's own scale, which is the reading a
   * reader who just asked for an era would expect.
   */
  it('lets an era pick override it, and takes the era as the new scale', () => {
    const s = useTimeStore()
    const medieval = HISTORICAL.find((e) => e.name === 'Medieval')!
    s.scrubTo(1990)
    s.selectEra(medieval)
    expect(s.selection).toEqual({ start: 500, end: 1500 }) // the era, outright
    expect(s.range).toEqual(windowFitting(medieval)) // …and the era fit, +5%
    expect(s.lockIsDefault).toBe(false)
    // the cursor landed on 1500, so the era is a 1000-year window at a depth of
    // 526 years — k ≈ 1.9, with the year at its far end
    expect(s.lockScale).toBeCloseTo(1000 / (MAX_TIME - 1500), 3)
    expect(s.lockSplit).toBe(1)
    const before = width(s.selection)
    s.scrubTo(1000)
    expect(width(s.selection) / before).toBeGreaterThan(1) // the era's scale, at 1000
  })

  it('leaves the saga rail’s cursor moves alone', () => {
    // setCursor is a step of a saga: a statement about where inside an event
    // the reader is, not a request to reframe the rail
    const s = useTimeStore()
    s.setRange({ start: 1900, end: 2000 })
    s.setSelection(1939, 1945)
    const band = s.selection
    s.setCursor(1941)
    expect(s.currentTime).toBe(1941)
    expect(s.selection).toBe(band)
    expect(s.range).toEqual({ start: 1900, end: 2000 })
  })
})

/* --------------------------------------------- round 57: the two windows part */

/**
 * THE VIEW HOLDS STILL.
 *
 * The reader's complaint about the lock as it shipped: *"now the whole timeline
 * shifts constantly when you click — don't do that. If possible (visible
 * timeline is large enough), just shift selected range."*
 *
 * So a locked click moves the year and the band by the same relative rule it
 * always did (tests/rangeLock.test.ts), and the VISIBLE window is now a
 * separate question with three answers: nothing, a slide, and — only when no
 * slide could hold the band — a widening. The geometry is
 * `windowLeastMoved` (tests/selection.test.ts); this is the store using it.
 */
describe('the locked click and the visible window', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const warp = (s: Span) => toWarp(s.end) - toWarp(s.start)
  const width = (s: Span) => s.end - s.start
  const inside = (b: Span, w: Span) => b.start >= w.start && b.end <= w.end

  it('does not move the view at all when the band fits on it', () => {
    const s = useTimeStore()
    s.setRange({ start: 1400, end: 1789 })
    const view = { ...s.range }
    // three successive clicks, all landing bands inside 1400–1789
    for (const y of [1500, 1600, 1450]) {
      s.scrubTo(y)
      expect(s.currentTime).toBe(y)
      expect(s.range).toEqual(view) // strict: not "about the same window"
      expect(inside(s.selection, s.range)).toBe(true)
    }
    // and the band did move, every time — this is not a test of a no-op click
    expect(s.selection).toEqual(lockedWindow(1450))
  })

  it('publishes no new window object when it does not move it', () => {
    // downstream watchers key on identity: an unchanged window that arrives as
    // a fresh object re-runs the era plan, the border digest and the event query
    const s = useTimeStore()
    s.setRange({ start: 1400, end: 1789 })
    const view = s.range
    s.scrubTo(1500)
    expect(s.range).toBe(view)
  })

  it('slides, minimally, when the band pokes out of the end', () => {
    const s = useTimeStore()
    s.setRange({ start: 1400, end: 1789 })
    const before = { ...s.range }
    s.scrubTo(1700) // band 1689.1 – 1754.3, comfortably inside: nothing moves
    expect(s.range).toEqual(before)
    s.scrubTo(1770) // band 1761.5 – 1812.7: 24 years past the right-hand edge
    expect(s.range.start).toBeGreaterThan(before.start) // it slid RIGHT
    expect(s.range.end).toBeGreaterThan(before.end)
    expect(inside(s.selection, s.range)).toBe(true)
    // the width is kept exactly (in warp, which is what the rail draws), so the
    // reader's zoom survives the click — a slide, not a reframe
    expect(warp(s.range)).toBeCloseTo(warp(before), 12)
    // …and no further than it had to: the band is against the far margin
    const air = toWarp(s.range.end) - toWarp(s.selection.end)
    expect(air).toBeCloseTo(warp(s.range) * SLIDE_MARGIN, 9)
  })

  it('slides the other way just as little', () => {
    const s = useTimeStore()
    s.setRange({ start: 1400, end: 1789 })
    const before = { ...s.range }
    s.scrubTo(1405) // band 1300.8 – 1424.8: 99 years off the left-hand edge
    expect(s.range.start).toBeLessThan(before.start)
    expect(s.range.end).toBeLessThan(before.end)
    expect(warp(s.range)).toBeCloseTo(warp(before), 12)
    expect(inside(s.selection, s.range)).toBe(true)
    const air = toWarp(s.selection.start) - toWarp(s.range.start)
    expect(air).toBeCloseTo(warp(s.range) * SLIDE_MARGIN, 9)
  })

  it('widens only when no slide could hold the band', () => {
    const s = useTimeStore()
    s.setRange({ start: 1500, end: 1520 }) // 20 years of rail
    s.scrubTo(1510) // …and a band of 103, which no slide of 20 can contain
    expect(warp(s.range)).toBeGreaterThan(warp({ start: 1500, end: 1520 }))
    expect(inside(s.selection, s.range)).toBe(true)
    // exactly the band plus its two margins, and not the era fit's +5% recentre
    expect(warp(s.range)).toBeCloseTo(warp(s.selection) / (1 - 2 * SLIDE_MARGIN), 9)
    expect(s.range).not.toEqual(windowFitting(s.selection))
  })

  it('never zooms IN: a click inside a wide view leaves it wide', () => {
    // the old fit did — a click at 1 Ma on the whole-of-time rail landed on a
    // 200 ka window. The band is that narrow now; the rail is not.
    const s = useTimeStore()
    s.setRange({ start: MIN_TIME, end: MAX_TIME })
    const whole = { ...s.range }
    s.scrubTo(-1e6)
    expect(s.range).toEqual(whole)
    expect(s.currentTime).toBe(-1e6)
    // An honest limit, and an old one: on a rail this wide the rule's 200 ka
    // band is a third of a percent of it, and `clampSelection` will not let a
    // band be narrower than 2% of the window — two handles that close together
    // cannot be told apart, let alone grabbed. So the band lands at that floor
    // (~340 ka here), centred on where the rule put it. Zoom in and the rule's
    // own width is what you get; see the 1400–1789 cases above.
    expect(warp(s.selection) / warp(s.range)).toBeCloseTo(MIN_SEL_FRACTION, 9)
    expect(width(s.selection)).toBeGreaterThan(0.2 * (1e6 + MAX_TIME))
    expect(s.selection.start).toBeLessThan(-1e6)
    expect(s.selection.end).toBeGreaterThan(-1e6)
  })

  it('keeps the standing invariants through a run of clicks at every depth', () => {
    const s = useTimeStore()
    for (const y of [MIN_TIME, -2.5e9, -1e6, -10_000, 0, 1500, 1990, 2020, MAX_TIME]) {
      s.scrubTo(y)
      expect(s.currentTime).toBeGreaterThanOrEqual(s.selection.start)
      expect(s.currentTime).toBeLessThanOrEqual(s.selection.end)
      expect(inside(s.selection, s.range)).toBe(true)
      expect(s.range.start).toBeGreaterThanOrEqual(MIN_TIME)
      expect(s.range.end).toBeLessThanOrEqual(MAX_TIME)
    }
  })

  it('still lets the drag teach it, and the taught click still holds the view', () => {
    const s = useTimeStore()
    s.setRange({ start: -2e6, end: 0 })
    s.setTime(-1e6)
    s.setSelection(-1.5e6, -0.5e6) // both handles dragged wide open
    s.learnLock() // (TimelineBar calls this on pointer-up)
    expect(s.lockIsDefault).toBe(false)
    const view = { ...s.range }
    s.scrubTo(-1.1e6) // the reader's proportions, in the reader's view
    expect(width(s.selection) / 1.1e6).toBeCloseTo(1, 1)
    expect((s.currentTime - s.selection.start) / width(s.selection)).toBeCloseTo(0.5, 2)
    expect(s.range).toEqual(view) // …and the view stayed where they put it
  })
})

/**
 * THE OPENING VIEW, in the numbers it was asked for: *"by default, show 1400 –
 * 1789, with year selected being fall of Constantinople (and default locked
 * range)"*.
 */
describe('the opening view', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('is the early-modern rail, 1400–1789 exactly', () => {
    expect(useTimeStore().range).toEqual({ start: 1400, end: 1789 })
    expect(HOME_WINDOW).toEqual({ start: 1400, end: 1789 })
  })

  it('opens on the fall of Constantinople', () => {
    expect(useTimeStore().currentTime).toBe(1453)
    expect(HOME_YEAR).toBe(1453)
  })

  it('opens with the band a locked click on 1453 would have asked for', () => {
    const s = useTimeStore()
    expect(s.selection).toEqual(lockedWindow(1453))
    expect(HOME_SELECTION).toEqual(lockedWindow(1453))
    // stated as the rule rather than as a constant, because MAX_TIME is the
    // current year: span = 0.2 × (present − 1453), one sixth of it before 1453
    const span = LOCK_SCALE * (MAX_TIME - 1453)
    expect(s.selection.start).toBeCloseTo(1453 - span * LOCK_SPLIT, 9)
    expect(s.selection.end).toBeCloseTo(s.selection.start + span, 9)
  })

  it.runIf(PRESENT === 2026)('is, in 2026, the band 1433.9 – 1548.5', () => {
    // the exact doubles, while the clock says 2026 — the guard is honest about
    // why they are not frozen: the rule is relative to the present
    const s = useTimeStore()
    expect(s.selection.start).toBe(1433.9)
    expect(s.selection.end).toBe(1548.5)
    expect(s.selection.end - s.selection.start).toBeCloseTo(114.6, 9)
  })

  it('opens in a state the first locked click agrees with', () => {
    // the band is inside the window, the year is inside the band, and a click
    // on the year it opens on changes nothing at all
    const s = useTimeStore()
    expect(s.selection.start).toBeGreaterThan(s.range.start)
    expect(s.selection.end).toBeLessThan(s.range.end)
    expect(s.currentTime).toBeGreaterThan(s.selection.start)
    expect(s.currentTime).toBeLessThan(s.selection.end)
    const opening = { range: { ...s.range }, selection: { ...s.selection } }
    s.scrubTo(1453)
    expect(s.range).toEqual(opening.range)
    expect(s.selection).toEqual(opening.selection)
    expect(s.currentTime).toBe(1453)
  })

  it('does not select or open an event: what opens is a year', () => {
    // the corpus has the fall of Constantinople (`fall-constantinople`, 1453,
    // public/data/events/medieval.json) and the default deliberately does not
    // touch it — no focus, no panel, nothing but the year on the rail
    const s = useTimeStore()
    expect(s.currentTime).toBe(1453)
    expect(useEventStore().focus).toBeUndefined()
    expect(useEventStore().selected).toBeUndefined()
  })
})
