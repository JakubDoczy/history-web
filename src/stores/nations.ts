import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { borderRings, visibleNations, type BorderRing, type Nation } from '../lib/nations'
import {
  contestedRings,
  hatchColors,
  isContestedAt,
  type ContestedRing,
  type ContestedZone,
} from '../lib/contested'
import { modernBorderEntries } from '../lib/modernBorders'
import { useTimeStore } from './time'
import { useSettingsStore } from './settings'
import rawFile from '../data/nations.clipped.json'

const rawNations = (rawFile as { nations: unknown }).nations
const rawContested = ((rawFile as { contested?: unknown }).contested ?? []) as unknown

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
     * every polity holds keyframes holding pieces holding rings holding tens of
     * thousands of coordinates. Handing that to `reactive()` walks the whole tree to wrap it in
     * proxies, and then every coordinate read on the way to the GPU goes through
     * a proxy trap. `markRaw` is the whole fix: the store's API is unchanged,
     * `all` is still a tracked property, only its contents stay plain objects.
     */
    all: markRaw(rawNations as unknown as Nation[]),
    /**
     * …and the ground none of them held: the contested zones, out of the same
     * generated file's second key. Raw for the same reason `all` is, and a
     * separate list because a zone is not a polity — it is never ranked, never
     * counted against `MAX_VISIBLE` and never returned by `current`.
     */
    zones: markRaw(rawContested as ContestedZone[]),
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
    /**
     * The contested zones in force now, one entry per piece.
     *
     * Same span gate as the borders, and the hatch colours are resolved HERE
     * rather than at the renderer because they depend on which polities are on
     * the globe at this instant — a claimant the reader can see somewhere else
     * lends its colour to a stripe, and one they cannot leaves it neutral (see
     * lib/contested.ts). `current` is already computed for the borders, so
     * asking it is free.
     */
    contested(): ContestedRing[] {
      const { currentTime, span } = useTimeStore()
      if (span > OVERLAY_MAX_SPAN) return []
      const drawn = new Set(this.current.map((n) => n.id))
      return this.zones
        .filter((z) => isContestedAt(z, currentTime))
        .flatMap((z) => contestedRings(z, hatchColors(z, drawn)))
    },
    /**
     * The modern states' frontier ink: nought or one entry, never a polity.
     *
     * It sits in this store rather than beside the layer that draws it because
     * it answers the same question `borders` does — what political ink belongs
     * on the globe at this instant — and because the two have to be decided
     * together: while this is non-empty the polities in those years yield their
     * own frontier ink to it (see `inkPathsOf`), and a caller that read the two
     * from different places could show both.
     *
     * Same span gate as the borders: a reader looking at ten thousand years at
     * once is not being shown Belgium.
     */
    modernBorders(): BorderEntry[] {
      const { currentTime, span } = useTimeStore()
      if (span > OVERLAY_MAX_SPAN) return []
      if (!useSettingsStore().modernBorders) return []
      return modernBorderEntries(currentTime)
    },
  },
})
