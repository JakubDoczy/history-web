import { defineStore } from 'pinia'
import { EventIndex, type HistoricalEvent, type EventFilter } from '../lib/events'
import { chunksFor, mergeEvents, type EventManifest } from '../lib/eventChunks'
import { TAGS } from '../lib/tags'
import { spanChangedEnough } from '../lib/eventClusters'
import { useTimeStore } from './time'
import { useSettingsStore } from './settings'

// The index lives outside reactive state: it is rebuilt wholesale on merge and
// queried thousands of times per scrub, so wrapping it in proxies buys nothing.
// `revision` is what tells getters it changed.
let index = new EventIndex([])

const DATA = `${import.meta.env.BASE_URL}data/events/`

export const useEventStore = defineStore('events', {
  state: () => ({
    all: [] as HistoricalEvent[],
    revision: 0,
    manifest: null as EventManifest | null,
    requested: new Set<string>(),
    filter: {} as EventFilter,
    selectedId: undefined as string | undefined,
    /** The cluster the user has opened, if any (see lib/eventClusters.ts). */
    expandedClusterId: undefined as string | undefined,
    /** Visible span when that cluster was opened — the fan is only valid near it. */
    expandedSpan: 0,
  }),
  getters: {
    visible(state): HistoricalEvent[] {
      const { range } = useTimeStore()
      const { maxEvents } = useSettingsStore()
      void state.revision // getter caches by revision, not by array identity
      return index.query(range.start, range.end, state.filter, maxEvents)
    },
    selected: (s) => s.all.find((e) => e.id === s.selectedId),
    allTags: () => [...TAGS],
    childrenOf: (s) => (id: string) => s.all.filter((e) => e.parent === id),
    byId: (s) => (id: string) => s.all.find((e) => e.id === id),
    search: (s) => (q: string) => {
      const needle = q.trim().toLowerCase()
      if (!needle) return [] as HistoricalEvent[]
      return s.all
        .filter((e) => e.name.toLowerCase().includes(needle) || e.tags.some((t) => t.includes(needle)))
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 8)
    },
  },
  actions: {
    /** Fetch the manifest and the always-loaded spine; then prefetch the rest when idle. */
    async init() {
      this.manifest = (await (await fetch(DATA + 'manifest.json')).json()) as EventManifest
      await this.load(this.manifest.spine)
      const t = useTimeStore()
      this.ensure(t.range.start, t.range.end)
      // Background prefetch keeps search and event-to-event links whole without
      // gating anything on it. One chunk at a time; failures just leave that
      // chunk to the window-driven path.
      const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 4000))
      idle(async () => {
        for (const c of this.manifest?.chunks ?? []) await this.load(c.file)
      })
    },
    /** Merge events into the store and rebuild the query index. */
    adopt(events: HistoricalEvent[]) {
      this.all = mergeEvents(this.all, events)
      index = new EventIndex(this.all)
      this.revision++
    },
    async load(file: string) {
      if (this.requested.has(file)) return
      this.requested.add(file)
      try {
        this.adopt((await (await fetch(DATA + file)).json()) as HistoricalEvent[])
      } catch {
        this.requested.delete(file) // transient failure — retry on the next window move
      }
    },
    /** Make sure the chunks covering a time window are loaded (or loading). */
    ensure(start: number, end: number) {
      if (this.manifest) for (const f of chunksFor(this.manifest, start, end)) this.load(f)
    },
    select(id?: string) {
      this.selectedId = id
      // picking a member answers the question the cluster was asking, so it
      // closes; the selected event keeps its own pin either way.
      this.expandedClusterId = undefined
    },
    expandCluster(id: string, spanDeg: number) {
      this.expandedClusterId = id
      this.expandedSpan = spanDeg
    },
    collapseClusters() {
      this.expandedClusterId = undefined
    },
    /**
     * Zoom moved. A fan laid out for one span is nonsense at another — and the
     * clustering itself has re-run by then — so a big enough change closes it.
     */
    noteSpan(spanDeg: number) {
      if (this.expandedClusterId && spanChangedEnough(this.expandedSpan, spanDeg))
        this.expandedClusterId = undefined
    },
    toggleTag(tag: string) {
      const tags = this.filter.tags ?? []
      this.filter.tags = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]
    },
    setParentFilter(id?: string) {
      this.filter.parent = id
    },
    clearFilter() {
      this.filter = {}
    },
  },
})
