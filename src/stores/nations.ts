import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { borderRings, visibleNations, type BorderRing, type Nation } from '../lib/nations'
import { useTimeStore } from './time'
import rawNations from '../data/nations.json'

/** Overlays only appear when zoomed into human-history scale. */
const OVERLAY_MAX_SPAN = 10_000

/** One drawable ring; see lib/nations.ts for why identity matters so much. */
export type BorderEntry = BorderRing

export const useNationStore = defineStore('nations', {
  state: () => ({
    /**
     * The dataset, deliberately outside Vue's reactivity.
     *
     * It is loaded from JSON, never mutated, and made of deeply nested arrays —
     * every polity holds keyframes holding rings holding thousands of [lng, lat]
     * pairs. Handing that to `reactive()` walks the whole tree to wrap it in
     * proxies, and then every coordinate read on the way to the GPU goes through
     * a proxy trap. `markRaw` is the whole fix: the store's API is unchanged,
     * `all` is still a tracked property, only its contents stay plain objects.
     */
    all: markRaw(rawNations as Nation[]),
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
     *
     * The entries are memoised per (polity, keyframe, ring): the list is rebuilt
     * on every timeline tick, but while the keyframe holds, every object in it
     * is the same object the renderer already has meshes and geometry for.
     */
    borders(): BorderEntry[] {
      const { currentTime, span } = useTimeStore()
      if (span > OVERLAY_MAX_SPAN) return []
      return this.current.flatMap((nation) => borderRings(nation, currentTime))
    },
  },
})
