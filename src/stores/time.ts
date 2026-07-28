import { defineStore } from 'pinia'
import { clamp, MIN_TIME, MAX_TIME, type Year } from '../lib/time'

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
    /** Multiplicative zoom around a focus point given as fraction [0..1] of the window. */
    zoom(factor: number, focus = 0.5) {
      const pivot = this.range.start + this.span * focus
      const start = clamp(pivot - (pivot - this.range.start) * factor)
      const end = clamp(pivot + (this.range.end - pivot) * factor)
      if (end - start >= 1) this.range = { start, end } // min window: 1 year
    },
    pan(deltaYears: number) {
      const d = Math.max(MIN_TIME - this.range.start, Math.min(MAX_TIME - this.range.end, deltaYears))
      this.range = { start: this.range.start + d, end: this.range.end + d }
    },
  },
})
