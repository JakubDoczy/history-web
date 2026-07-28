import { defineStore } from 'pinia'
import { activeKeyframe, extremes, type Nation, type Ring } from '../lib/nations'
import { useTimeStore } from './time'
import rawNations from '../data/nations.json'

/** Overlays only appear when zoomed into human-history scale. */
const OVERLAY_MAX_SPAN = 10_000

export interface BorderEntry {
  nation: Nation
  kind: 'full' | 'max' | 'min'
  ring: Ring
}

export const useNationStore = defineStore('nations', {
  state: () => ({
    all: rawNations as Nation[],
    showExtremes: false,
  }),
  getters: {
    /** Border polygons for the current time & window, respecting timeline LOD. */
    borders(state): BorderEntry[] {
      const { currentTime, range, span } = useTimeStore()
      if (span > OVERLAY_MAX_SPAN) return []
      return state.all.flatMap((nation) => {
        const out: BorderEntry[] = []
        const full = activeKeyframe(nation, currentTime)
        if (full) out.push({ nation, kind: 'full', ring: full.ring })
        if (state.showExtremes) {
          const { max, min } = extremes(nation, range.start, range.end)
          if (max && max.ring !== full?.ring) out.push({ nation, kind: 'max', ring: max.ring })
          if (min && min !== max && min.ring !== full?.ring) out.push({ nation, kind: 'min', ring: min.ring })
        }
        return out
      })
    },
  },
  actions: {
    toggleExtremes() {
      this.showExtremes = !this.showExtremes
    },
  },
})
