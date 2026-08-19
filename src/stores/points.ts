import { defineStore } from 'pinia'
import { useTimeStore } from './time'
import { useSettingsStore } from './settings'
import { parsePoints, resolvePointsAt, type HistoricalPoint, type ResolvedPoint } from '../lib/points'
import raw from '../data/points.json'

/**
 * POINTS — the reactive half of lib/points.ts.
 *
 * The dataset ships in the bundle (src/data/points.json, ~16 kB source): it is
 * two orders of magnitude under the smallest event chunk, so a manifest and a
 * fetch would cost more than they save. Parsed once, at module scope, through
 * the same validator the tests hold the file to.
 *
 * WHAT DRIVES THE SET: the YEAR — `time.currentTime`, the cursor — not the
 * selection band the events are culled by. A point is not an event: an event
 * *happened* somewhere in the band, a point *is there* in the year the globe
 * is drawn for, and the band can be centuries wide. The set therefore changes
 * only when the cursor crosses an era boundary, and `resolvePointsAt`'s total
 * ordering (priority, then id) means a scrub inside an era changes nothing at
 * all — no flicker, no churn.
 */

const POINTS: HistoricalPoint[] = parsePoints(raw)

export const usePointsStore = defineStore('points', {
  state: () => ({
    /** The point whose info chip is open, or `null`. */
    selectedId: null as string | null,
  }),
  getters: {
    /** The whole parsed dataset — for search-like consumers and tests. */
    all: (): readonly HistoricalPoint[] => POINTS,
    /**
     * The points on the globe now: the top N (settings, default 10, 0 = layer
     * off) of everything that exists at the cursor's year. ~50 candidates, so
     * recomputing per cursor move is nothing.
     */
    visible(): ResolvedPoint[] {
      const time = useTimeStore()
      const settings = useSettingsStore()
      return resolvePointsAt(POINTS, time.currentTime, settings.maxPoints)
    },
    /**
     * The chip's subject — resolved against the VISIBLE set, so scrubbing the
     * cursor out of the selected point's era (or ranking it out of the top N)
     * takes the chip down with the marker: a chip describing a point with no
     * mark on the globe would be the same defect the event panel's kept-pin
     * rule exists to prevent, answered the cheaper way round.
     */
    selected(): ResolvedPoint | null {
      return this.visible.find((p) => p.id === this.selectedId) ?? null
    },
  },
  actions: {
    /** Open the chip on a point; clicking the same point again closes it. */
    select(id: string) {
      this.selectedId = this.selectedId === id ? null : id
    },
    dismiss() {
      this.selectedId = null
    },
  },
})
