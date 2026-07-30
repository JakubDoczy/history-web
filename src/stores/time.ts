import { defineStore } from 'pinia'
import { clamp, toWarp, fromWarp, MIN_TIME, MAX_TIME, type Year } from '../lib/time'
import { clampSelection, windowContaining, type Span } from '../lib/selection'
import type { Era } from '../lib/eras'

/** Opening view: the classical world through the present, framed on the eras
 *  most events live in. The selection is what the globe actually shows. */
const HOME_WINDOW: Span = { start: -550, end: 2100 }
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
      const d0 = (we - ws) * fraction
      const d = Math.max(toWarp(MIN_TIME) - ws, Math.min(toWarp(MAX_TIME) - we, d0))
      this.setRange({ start: clamp(fromWarp(ws + d)), end: clamp(fromWarp(we + d)) })
    },
    /**
     * Move the window. The selection follows it in, keeping what overlap it can,
     * and the cursor comes along too — a cursor outside the window has no mark on
     * the rail, yet it is what the globe's surface is drawn for.
     */
    setRange(range: Span) {
      this.range = range
      this.selection = clampSelection(this.selection, range)
      this.currentTime = clamp(this.currentTime, range.start, range.end)
    },
    /** Set the selection from two instants in any order (a dragged handle may pass the other). */
    setSelection(a: Year, b: Year) {
      this.selection = clampSelection({ start: a, end: b }, this.range)
    },
    /** Frame an era: it becomes the selection, and the window opens up if it has to. */
    selectEra(era: Era) {
      this.setRange(windowContaining({ start: era.start, end: era.end }, this.range))
      this.setSelection(era.start, era.end)
    },
  },
})
