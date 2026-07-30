import { defineStore } from 'pinia'
import {
  activeKeyframe,
  extremes,
  nationLabel,
  visibleNations,
  type Nation,
  type Ring,
} from '../lib/nations'
import { useTimeStore } from './time'
import rawNations from '../data/nations.json'

/** Overlays only appear when zoomed into human-history scale. */
const OVERLAY_MAX_SPAN = 10_000

export interface BorderEntry {
  nation: Nation
  kind: 'full' | 'max' | 'min'
  ring: Ring
  /** What the globe shows on hover: name plus the polity's span. */
  label: string
}

export const useNationStore = defineStore('nations', {
  state: () => ({
    all: rawNations as Nation[],
    showExtremes: false,
  }),
  getters: {
    /** The polities notable at the current time (already capped and size-sorted). */
    current(state): Nation[] {
      const { currentTime } = useTimeStore()
      return visibleNations(state.all, currentTime)
    },
    /**
     * One entry per ring, because the globe's polygon layer draws one ring at a
     * time — a polity with islands or two continents contributes several.
     */
    borders(state): BorderEntry[] {
      const { currentTime, range, span } = useTimeStore()
      if (span > OVERLAY_MAX_SPAN) return []
      return this.current.flatMap((nation) => {
        const out: BorderEntry[] = []
        const label = nationLabel(nation)
        const full = activeKeyframe(nation, currentTime)
        for (const ring of full?.rings ?? []) out.push({ nation, kind: 'full', ring, label })
        if (state.showExtremes) {
          const { max, min } = extremes(nation, range.start, range.end)
          if (max && max !== full)
            for (const ring of max.rings) out.push({ nation, kind: 'max', ring, label: `${label} — largest extent in view` })
          if (min && min !== max && min !== full)
            for (const ring of min.rings) out.push({ nation, kind: 'min', ring, label: `${label} — smallest extent in view` })
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
