import { defineStore } from 'pinia'
import { clamp, toWarp, fromWarp, MIN_TIME, MAX_TIME, type Year } from '../lib/time'
import { clampSelection, sameSpan, windowContaining, type Span } from '../lib/selection'
import type { Era } from '../lib/eras'

/** Opening view: the classical world through the present, framed on the eras
 *  most events live in. The selection is what the globe actually shows. */
const HOME_WINDOW: Span = { start: -550, end: MAX_TIME }
const HOME_SELECTION: Span = { start: 500, end: 1945 }

export const useTimeStore = defineStore('time', {
  state: () => ({
    currentTime: 1500 as Year,
    range: { ...HOME_WINDOW },
    /** Sub-range of `range` that filters what the globe shows (see stores/events). */
    selection: { ...HOME_SELECTION },
  }),
  getters: {
    span: (s) => s.range.end - s.range.start,
    selectionSpan: (s) => s.selection.end - s.selection.start,
  },
  actions: {
    setTime(t: Year) {
      this.currentTime = clamp(t, this.range.start, this.range.end)
    },
    /** Jump to a time; if it lies outside the window, recenter the window on it. */
    focusTime(t: Year) {
      const target = clamp(t)
      if (target < this.range.start || target > this.range.end) {
        const half = (toWarp(this.range.end) - toWarp(this.range.start)) / 2
        const c = toWarp(target)
        this.setRange({ start: clamp(fromWarp(c - half)), end: clamp(fromWarp(c + half)) })
      }
      this.currentTime = target
    },
    /** Zoom in warp (display) space around a focus fraction [0..1] of the window. */
    zoom(factor: number, focus = 0.5) {
      const ws = toWarp(this.range.start)
      const we = toWarp(this.range.end)
      const pivot = ws + (we - ws) * focus
      const start = clamp(fromWarp(pivot - (pivot - ws) * factor))
      const end = clamp(fromWarp(pivot + (we - pivot) * factor))
      if (end - start >= 1) this.setRange({ start, end })
    },
    /** Pan by a fraction of the visible window (display space). */
    pan(fraction: number) {
      const ws = toWarp(this.range.start)
      const we = toWarp(this.range.end)
      const lo = toWarp(MIN_TIME) - ws // how far left there is still room to go
      const hi = toWarp(MAX_TIME) - we
      const d = Math.max(lo, Math.min(hi, (we - ws) * fraction))
      // Already hard against the end being pushed at: not a pan.
      if (d === 0) return
      // A saturated end is *exactly* the end of time, not the warp roundtrip of
      // it. `fromWarp(toWarp(MIN_TIME))` comes back 5 µyr short, which is enough
      // room for the next pan to move and the one after to move back — so a
      // held drag at the bound oscillated between two windows five microseconds
      // of geological time apart, republishing the range on every pointer move
      // and re-running the whole downstream pipeline for each.
      const start = d === lo ? MIN_TIME : clamp(fromWarp(ws + d))
      const end = d === hi ? MAX_TIME : clamp(fromWarp(we + d))
      this.setRange({ start, end })
    },
    /**
     * Move the window. The selection follows it in, keeping what overlap it can,
     * and the cursor comes along too — a cursor outside the window has no mark on
     * the rail, yet it is what the globe's surface is drawn for.
     *
     * A move that changes none of the three publishes nothing. This is not a
     * micro-optimisation: pushing the window against the beginning or the end of
     * time is a *held gesture*, one call per pointer move, and every one of them
     * used to assign three fresh objects for the same three intervals. Vue
     * compares by identity, so each one re-ran the entire downstream pipeline —
     * the nation borders re-digested, the event index re-queried, the era plan
     * rebuilt — to arrive at the picture already on screen.
     */
    setRange(range: Span) {
      const selection = clampSelection(this.selection, range)
      const currentTime = clamp(this.currentTime, range.start, range.end)
      if (
        sameSpan(range, this.range) &&
        sameSpan(selection, this.selection) &&
        currentTime === this.currentTime
      )
        return
      this.range = range
      this.selection = selection
      this.currentTime = currentTime
    },
    /**
     * Set the selection from two instants in any order (a dragged handle may pass
     * the other) — and, as with setRange, only when the result actually differs:
     * a handle held against the edge of the window clamps to where it already is.
     */
    setSelection(a: Year, b: Year) {
      const selection = clampSelection({ start: a, end: b }, this.range)
      if (sameSpan(selection, this.selection)) return
      this.selection = selection
    },
    /** Frame an era: it becomes the selection, and the window opens up if it has to. */
    selectEra(era: Era) {
      this.setRange(windowContaining({ start: era.start, end: era.end }, this.range))
      this.setSelection(era.start, era.end)
    },
  },
})
