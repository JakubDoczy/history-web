import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  clampSelection,
  windowContaining,
  windowFitting,
  orderSpan,
  sameSpan,
  MIN_SEL_FRACTION,
} from '../src/lib/selection'
import { toWarp, MIN_TIME, MAX_TIME } from '../src/lib/time'
import { HISTORICAL, spanEraLabel } from '../src/lib/eras'
import { useTimeStore } from '../src/stores/time'
import { useEventStore } from '../src/stores/events'
import type { HistoricalEvent } from '../src/lib/events'

const inside = (sel: { start: number; end: number }, win: { start: number; end: number }) =>
  sel.start >= win.start - 1e-6 && sel.end <= win.end + 1e-6 && sel.end > sel.start

/** Width in display space, which is where the minimum lives. */
const warpWidth = (s: { start: number; end: number }) => toWarp(s.end) - toWarp(s.start)

describe('sameSpan', () => {
  it('is value equality, not identity — which is the whole point of it', () => {
    const a = { start: 1000, end: 2000 }
    expect(sameSpan(a, a)).toBe(true)
    expect(sameSpan(a, { ...a })).toBe(true)
  })

  it('separates spans that differ at either end', () => {
    expect(sameSpan({ start: 1000, end: 2000 }, { start: 1001, end: 2000 })).toBe(false)
    expect(sameSpan({ start: 1000, end: 2000 }, { start: 1000, end: 2001 })).toBe(false)
  })

  // Exact, not epsilon: the callers snap saturated ends to the bound rather
  // than leaning on a tolerance here (see stores/time.ts pan).
  it('does not forgive a floating-point hair', () => {
    expect(sameSpan({ start: 1000, end: 2000 }, { start: 1000 + 1e-9, end: 2000 })).toBe(false)
  })

  it('ignores ordering conventions — it compares fields, not intervals', () => {
    expect(sameSpan({ start: 2000, end: 1000 }, { start: 1000, end: 2000 })).toBe(false)
  })
})

describe('orderSpan', () => {
  it('sorts either way round', () => {
    expect(orderSpan(1900, 1500)).toEqual({ start: 1500, end: 1900 })
    expect(orderSpan(1500, 1900)).toEqual({ start: 1500, end: 1900 })
  })
})

describe('clampSelection', () => {
  const win = { start: -550, end: 2100 }

  it('leaves a contained selection exactly alone (no lossy warp roundtrip)', () => {
    expect(clampSelection({ start: 500, end: 1945 }, win)).toEqual({ start: 500, end: 1945 })
  })

  it('normalizes an inverted selection (handle dragged past its partner)', () => {
    const sel = clampSelection({ start: 1945, end: 500 }, win)
    expect(sel.start).toBeCloseTo(500, 6)
    expect(sel.end).toBeCloseTo(1945, 6)
  })

  it('keeps the overlap when the window shrinks around it', () => {
    const sel = clampSelection({ start: 500, end: 1945 }, { start: 1000, end: 1600 })
    expect(sel.start).toBeCloseTo(1000, 6)
    expect(sel.end).toBeCloseTo(1600, 6)
  })

  it('clips to the overlap when the window shrinks over one edge only', () => {
    const sel = clampSelection({ start: 500, end: 1945 }, { start: 1200, end: 2100 })
    expect(sel.start).toBeCloseTo(1200, 6)
    expect(sel.end).toBeCloseTo(1945, 6)
  })

  it('collapses to the near edge, at minimum width, when the window pans clear past it', () => {
    const win2 = { start: 1960, end: 2100 }
    const sel = clampSelection({ start: 500, end: 1945 }, win2)
    expect(inside(sel, win2)).toBe(true)
    expect(sel.start).toBeCloseTo(1960, 4) // pinned to the edge it was left behind
    expect(warpWidth(sel)).toBeCloseTo(warpWidth(win2) * MIN_SEL_FRACTION, 6)

    const past = { start: -4e9, end: -1e9 }
    const back = clampSelection({ start: 500, end: 1945 }, past)
    expect(inside(back, past)).toBe(true)
    expect(back.end).toBeCloseTo(-1e9, -3) // pinned to the other edge
  })

  it('gives a zero-width selection the minimum width without leaving the window', () => {
    for (const t of [-550, 400, 2100]) {
      const sel = clampSelection({ start: t, end: t }, win)
      expect(inside(sel, win)).toBe(true)
      expect(warpWidth(sel)).toBeCloseTo(warpWidth(win) * MIN_SEL_FRACTION, 6)
    }
  })

  it('survives a degenerate window', () => {
    expect(clampSelection({ start: 0, end: 100 }, { start: 1500, end: 1500 })).toEqual({
      start: 1500,
      end: 1500,
    })
  })

  it('accepts a window given backwards', () => {
    const sel = clampSelection({ start: 500, end: 1945 }, { start: 2100, end: -550 })
    expect(sel.start).toBeCloseTo(500, 6)
    expect(sel.end).toBeCloseTo(1945, 6)
  })

  it('clamps years beyond the end of time (warp saturates there)', () => {
    const sel = clampSelection({ start: 467, end: 2776 }, win)
    expect(sel.end).toBeCloseTo(MAX_TIME, 6) // the present, not the window's nominal end
    expect(sel.start).toBeCloseTo(467, 6)
  })

  it('is idempotent', () => {
    const once = clampSelection({ start: -4e9, end: 1945 }, { start: 1000, end: 1600 })
    expect(clampSelection(once, { start: 1000, end: 1600 })).toEqual(once)
  })
})

describe('windowContaining', () => {
  it('keeps the window when the span already fits', () => {
    const win = { start: -550, end: 2100 }
    expect(windowContaining({ start: 500, end: 1500 }, win)).toEqual(win)
  })

  it('opens up with padding when the span does not fit', () => {
    const win = windowContaining({ start: -3e6, end: -3300 }, { start: -550, end: 2100 })
    expect(win.start).toBeLessThan(-3e6)
    expect(win.end).toBeGreaterThan(-3300)
  })

  it('never escapes the global bounds', () => {
    const win = windowContaining({ start: MIN_TIME, end: MAX_TIME }, { start: 0, end: 1 })
    expect(win.start).toBeGreaterThanOrEqual(MIN_TIME)
    expect(win.end).toBeLessThanOrEqual(MAX_TIME)
  })
})

describe('time store selection', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens on the documented default framing', () => {
    const s = useTimeStore()
    expect(s.range).toEqual({ start: -550, end: MAX_TIME })
    expect(s.selection).toEqual({ start: 500, end: 1945 })
  })

  it('zoom and pan drag the selection along with the window', () => {
    const s = useTimeStore()
    s.zoom(0.2, 0.5)
    expect(inside(s.selection, s.range)).toBe(true)
    s.pan(0.9)
    expect(inside(s.selection, s.range)).toBe(true)
    s.pan(-5)
    expect(inside(s.selection, s.range)).toBe(true)
  })

  it('setSelection normalizes and clamps', () => {
    const s = useTimeStore()
    s.setSelection(1800, 1000)
    expect(s.selection.start).toBeCloseTo(1000, 6)
    expect(s.selection.end).toBeCloseTo(1800, 6)
    s.setSelection(-9e9, 9e9)
    expect(inside(s.selection, s.range)).toBe(true)
  })

  it('selectEra selects the era and fits the window to it', () => {
    const s = useTimeStore()
    const medieval = HISTORICAL.find((e) => e.name === 'Medieval')!
    s.selectEra(medieval)
    // exact, so the era label round-trips: 499.9999 would read as Classical too
    expect(s.selection).toEqual({ start: 500, end: 1500 })
    expect(spanEraLabel(s.selection.start, s.selection.end)).toBe('Medieval')
    // the window is the era plus 5% of air either side — measured on the rail,
    // which is warp space, not in years
    expect(s.range).toEqual(windowFitting(medieval))
    expect(warpWidth(s.range)).toBeCloseTo(warpWidth(s.selection) * 1.1, 9)
    expect(inside(s.selection, s.range)).toBe(true)

    expect(s.currentTime).toBe(1500) // still inside the era: untouched

    const stone = HISTORICAL[0]
    s.selectEra(stone)
    expect(s.range.start).toBeLessThan(stone.start)
    expect(inside(s.selection, s.range)).toBe(true)
    expect(s.selection.start).toBeCloseTo(stone.start, 0)
    // the cursor is dragged in with the window: it drives the globe surface, and
    // a cursor off the rail cannot be seen or moved
    expect(s.currentTime).toBeLessThanOrEqual(s.range.end)
    expect(s.currentTime).toBeGreaterThanOrEqual(s.range.start)
  })
})

describe('event store visibility follows the selection', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows only events intersecting the selection, not the whole window', () => {
    const time = useTimeStore()
    const events = useEventStore()
    const ev = (id: string, start: number): HistoricalEvent => ({
      id, name: id, start, lat: 0, lng: 0, priority: 1, tags: ['war'], summary: '',
    })
    events.adopt([ev('classical', -300), ev('medieval', 1200), ev('modern', 2000)])
    expect(events.visible.map((e) => e.id)).toEqual(['medieval']) // default 500–1945
    time.setSelection(-550, 0)
    expect(events.visible.map((e) => e.id)).toEqual(['classical'])
  })

  /** What the product asks for, end to end: jump to a thing and you can see it. */
  it('makes the jumped-to item visible, because the band grew to reach it', () => {
    const time = useTimeStore()
    const events = useEventStore()
    const ev = (id: string, start: number): HistoricalEvent => ({
      id, name: id, start, lat: 0, lng: 0, priority: 1, tags: ['war'], summary: '',
    })
    events.adopt([ev('classical', -300), ev('medieval', 1200), ev('modern', 2000)])
    expect(events.visible.map((e) => e.id)).toEqual(['medieval'])

    time.setTime(events.focusYear('modern')!) // a search / panel jump forward
    expect(events.visible.map((e) => e.id)).toEqual(['medieval', 'modern'])

    time.setTime(events.focusYear('classical')!) // ...and back past the other edge
    expect(events.visible.map((e) => e.id)).toEqual(['classical', 'medieval', 'modern'])
  })
})

import {
  EDGE_MERGE_PX,
  FIT_MARGIN,
  FLAG_PX,
  easeInOut,
  flagSide,
  mergedEdge,
  tweenWindow,
  windowFitting,
} from '../src/lib/selection'
import { fromWarp } from '../src/lib/time'

describe('windowFitting', () => {
  it('frames the span with a margin of the span, either side', () => {
    const win = windowFitting({ start: 500, end: 1500 })
    const span = toWarp(1500) - toWarp(500)
    expect(toWarp(500) - toWarp(win.start)).toBeCloseTo(span * FIT_MARGIN, 9)
    expect(toWarp(win.end) - toWarp(1500)).toBeCloseTo(span * FIT_MARGIN, 9)
    expect(warpWidth(win)).toBeCloseTo(span * (1 + 2 * FIT_MARGIN), 9)
  })

  // The margin is a fraction of the rail, not of a number of years — which is
  // the only reading that works at both ends of a 4.5-billion-year timeline.
  it('gives a deep-time era and a decade the same margin on screen', () => {
    const deep = windowFitting({ start: -2.5e9, end: -538.8e6 })
    const near = windowFitting({ start: 1990, end: 1999 })
    expect(warpWidth(deep) / (toWarp(-538.8e6) - toWarp(-2.5e9))).toBeCloseTo(
      warpWidth(near) / (toWarp(1999) - toWarp(1990)),
      9,
    )
  })

  it('moves the view even when the span is already visible — fitting, not containing', () => {
    const span = { start: 1900, end: 1910 }
    expect(windowFitting(span)).not.toEqual(windowContaining(span, { start: -550, end: MAX_TIME }))
    expect(warpWidth(windowFitting(span))).toBeLessThan(
      warpWidth({ start: -550, end: MAX_TIME }) / 10,
    )
  })

  it('saturates at the ends of time, exactly', () => {
    // an era running to the present has no right-hand margin to be given
    expect(windowFitting({ start: 1945, end: MAX_TIME }).end).toBe(MAX_TIME)
    expect(windowFitting({ start: MIN_TIME, end: -4e9 }).start).toBe(MIN_TIME)
    const whole = windowFitting({ start: MIN_TIME, end: MAX_TIME })
    expect(whole).toEqual({ start: MIN_TIME, end: MAX_TIME })
  })

  it('accepts its span in either order', () => {
    expect(windowFitting({ start: 1500, end: 500 })).toEqual(windowFitting({ start: 500, end: 1500 }))
  })
})

describe('the fit tween', () => {
  const from = { start: -550, end: MAX_TIME }
  const to = windowFitting({ start: 500, end: 1500 })

  it('starts where it is and lands exactly on the target', () => {
    expect(tweenWindow(from, to, 0)).toEqual(from)
    expect(tweenWindow(from, to, 1)).toEqual(to)
    expect(tweenWindow(from, to, 1.4)).toEqual(to) // a late frame cannot overshoot
  })

  it('moves monotonically, and in warp space', () => {
    let last = toWarp(from.start)
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const u = toWarp(tweenWindow(from, to, t).start)
      expect(u).toBeGreaterThan(last)
      last = u
    }
    // the halfway frame is halfway *on the rail*, which is not halfway in years
    const mid = tweenWindow(from, to, 0.5)
    expect(toWarp(mid.start)).toBeCloseTo((toWarp(from.start) + toWarp(to.start)) / 2, 9)
    expect(mid.start).not.toBeCloseTo((from.start + to.start) / 2, 0)
  })

  it('eases in and out', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9)
    expect(easeInOut(0.1)).toBeLessThan(0.1) // slow start
    expect(easeInOut(0.9)).toBeGreaterThan(0.9) // slow finish
    expect(easeInOut(-1)).toBe(0)
    expect(easeInOut(9)).toBe(1)
  })

  it('never leaves the ends of time on the way', () => {
    const wide = { start: MIN_TIME, end: MAX_TIME }
    for (const t of [0, 0.3, 0.6, 1]) {
      const f = tweenWindow(wide, to, t)
      expect(f.start).toBeGreaterThanOrEqual(MIN_TIME)
      expect(f.end).toBeLessThanOrEqual(MAX_TIME)
    }
  })
})

/**
 * The cursor sitting on a selection edge is two glyphs a few pixels apart, and
 * the thicker one is the handle — so the ember cursor reads as being *outside*
 * a band it is exactly on the boundary of. These two pure functions are what
 * TimelineBar merges them with.
 */
describe('mergedEdge', () => {
  it('merges only within the threshold', () => {
    expect(mergedEdge(100, 100, 400)).toBe('start')
    expect(mergedEdge(100 + EDGE_MERGE_PX, 100, 400)).toBe('start')
    expect(mergedEdge(100 + EDGE_MERGE_PX + 0.01, 100, 400)).toBe(null)
    expect(mergedEdge(398, 100, 400)).toBe('end')
    expect(mergedEdge(250, 100, 400)).toBe(null)
  })

  it('picks one edge when a minimum-width band puts both in reach', () => {
    // both edges inside the threshold: nearest wins, and it is never 'both'
    expect(mergedEdge(200, 199, 202)).toBe('start')
    expect(mergedEdge(201, 199, 202)).toBe('end')
    expect(mergedEdge(200, 200, 200)).toBe('start') // a collapsed band still resolves
  })

  it('works at either end of the rail', () => {
    expect(mergedEdge(0, 0, 300)).toBe('start')
    expect(mergedEdge(1280, 900, 1280)).toBe('end')
  })
})

describe('flagSide', () => {
  it('hangs the flag into the band when merged, so the glyph reads as one', () => {
    expect(flagSide(600, 1280, 'start')).toBe('right')
    expect(flagSide(600, 1280, 'end')).toBe('left')
  })

  it('lets the rail edges override that, rather than clip the year', () => {
    expect(flagSide(1279, 1280, 'start')).toBe('left') // no room on the right
    expect(flagSide(2, 1280, 'end')).toBe('right') // none on the left
    expect(flagSide(1279, 1280, null)).toBe('left')
    expect(flagSide(2, 1280, null)).toBe('right')
  })

  it('keeps the flag on a rail too narrow for it either way', () => {
    // a phone with a band at the edge: pick a side, do not oscillate
    for (const x of [0, 30, 60])
      expect(['left', 'right']).toContain(flagSide(x, FLAG_PX + 10, 'end'))
  })
})

describe('time store: era fit', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('fits the window to a sub-age, not just to the era around it', () => {
    const s = useTimeStore()
    const viking = { name: 'Viking Age', start: 793, end: 1066, color: '#000' }
    s.selectEra(viking)
    expect(s.selection).toEqual({ start: 793, end: 1066 })
    expect(s.range).toEqual(windowFitting(viking))
    // the whole point: the period fills the rail instead of being a sliver on it
    expect(warpWidth(s.selection) / warpWidth(s.range)).toBeCloseTo(1 / 1.1, 9)
  })

  it('reaches the target in one step where there is no clock to animate against', () => {
    const s = useTimeStore()
    const medieval = HISTORICAL.find((e) => e.name === 'Medieval')!
    s.selectEra(medieval)
    expect(s.range).toEqual(windowFitting(medieval))
  })

  it('is abandoned the moment the user touches the view', () => {
    const s = useTimeStore()
    const frames: (() => void)[] = []
    const raf = ((fn: () => void) => (frames.push(fn), frames.length)) as typeof requestAnimationFrame
    const g = globalThis as { requestAnimationFrame?: typeof requestAnimationFrame; matchMedia?: unknown }
    const [oldRaf, oldMm] = [g.requestAnimationFrame, g.matchMedia]
    g.requestAnimationFrame = raf
    g.matchMedia = () => ({ matches: false })
    try {
      const medieval = HISTORICAL.find((e) => e.name === 'Medieval')!
      s.selectEra(medieval)
      expect(frames.length).toBe(1) // animating, not landed
      expect(s.range).not.toEqual(windowFitting(medieval))
      s.pan(0.1) // the user takes over
      const taken = s.range
      frames.forEach((f) => f()) // a frame already queued must not fight back
      expect(s.range).toBe(taken)
    } finally {
      g.requestAnimationFrame = oldRaf
      g.matchMedia = oldMm
    }
  })

  it('holds the selection whole while the window flies to it', () => {
    const s = useTimeStore()
    const frames: (() => void)[] = []
    const g = globalThis as { requestAnimationFrame?: typeof requestAnimationFrame; matchMedia?: unknown }
    const [oldRaf, oldMm] = [g.requestAnimationFrame, g.matchMedia]
    g.requestAnimationFrame = ((fn: () => void) => (frames.push(fn), frames.length)) as typeof requestAnimationFrame
    g.matchMedia = () => ({ matches: false })
    try {
      s.setRange({ start: 1900, end: 2000 }) // nowhere near the era being picked
      const stone = HISTORICAL[0]
      s.selectEra(stone)
      // the intermediate windows do not contain it, and must not clip it either:
      // clampSelection would collapse the band to a sliver and re-run the query
      for (let i = 0; i < 40 && frames.length; i++) frames.shift()!()
      expect(s.selection).toEqual({ start: stone.start, end: stone.end })
    } finally {
      g.requestAnimationFrame = oldRaf
      g.matchMedia = oldMm
    }
  })
})
