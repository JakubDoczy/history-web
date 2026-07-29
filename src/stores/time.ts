import { defineStore } from 'pinia'
import { clamp, toWarp, fromWarp, MIN_TIME, MAX_TIME, type Year } from '../lib/time'

export const useTimeStore = defineStore('time', {
  state: () => ({
    currentTime: 1500 as Year,
    range: { start: MIN_TIME, end: MAX_TIME },
  }),
  getters: {
    span: (s) => s.range.end - s.range.start,
  },
  actions: {
    setTime(t: Year) {
      this.currentTime = clamp(t, this.range.start, this.range.end)
    },
    /** Zoom in warp (display) space around a focus fraction [0..1] of the window. */
    zoom(factor: number, focus = 0.5) {
      const ws = toWarp(this.range.start)
      const we = toWarp(this.range.end)
      const pivot = ws + (we - ws) * focus
      const start = clamp(fromWarp(pivot - (pivot - ws) * factor))
      const end = clamp(fromWarp(pivot + (we - pivot) * factor))
      if (end - start >= 1) this.range = { start, end }
    },
    /** Pan by a fraction of the visible window (display space). */
    pan(fraction: number) {
      const ws = toWarp(this.range.start)
      const we = toWarp(this.range.end)
      const d0 = (we - ws) * fraction
      const d = Math.max(toWarp(MIN_TIME) - ws, Math.min(toWarp(MAX_TIME) - we, d0))
      this.range = { start: clamp(fromWarp(ws + d)), end: clamp(fromWarp(we + d)) }
    },
  },
})
