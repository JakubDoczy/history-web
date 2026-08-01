import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  clampSelection,
  windowContaining,
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

  it('selectEra selects the era and widens the window only when it has to', () => {
    const s = useTimeStore()
    const medieval = HISTORICAL.find((e) => e.name === 'Medieval')!
    s.selectEra(medieval)
    expect(s.range).toEqual({ start: -550, end: MAX_TIME }) // already visible: window untouched
    // exact, so the era label round-trips: 499.9999 would read as Classical too
    expect(s.selection).toEqual({ start: 500, end: 1500 })
    expect(spanEraLabel(s.selection.start, s.selection.end)).toBe('Medieval')

    expect(s.currentTime).toBe(1500) // still inside: untouched

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
})
