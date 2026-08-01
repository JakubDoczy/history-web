import { defineStore } from 'pinia'
import {
  EventIndex,
  anchorYearOf,
  searchItems,
  type EventFilter,
  type HistoricalEvent,
  type Item,
} from '../lib/events'
import { internalLinkIds } from '../lib/richtext'
import { chunksFor, mergeEvents, type EventManifest } from '../lib/eventChunks'
import { TAGS } from '../lib/tags'
import { FAN_COLLAPSE_FACTOR, spanChangedEnough } from '../lib/eventClusters'
import { useTimeStore } from './time'
import { useSettingsStore } from './settings'

// The index lives outside reactive state: it is rebuilt wholesale on merge and
// queried thousands of times per scrub, so wrapping it in proxies buys nothing.
// `revision` is what tells getters it changed.
let index = new EventIndex([])

const DATA = `${import.meta.env.BASE_URL}data/events/`

/**
 * A JSON fetch that fails by returning undefined rather than by throwing, and
 * that treats an HTTP error as a failure.
 *
 * `fetch` resolves for 404 and 500 alike, so the only thing that used to notice
 * a missing file was `JSON.parse` choking on an error page — which meant a
 * server that answered "not found" in JSON would have had its error object
 * merged into the event list.
 */
async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}

export const useEventStore = defineStore('events', {
  state: () => ({
    all: [] as Item[],
    revision: 0,
    manifest: null as EventManifest | null,
    requested: new Set<string>(),
    filter: {} as EventFilter,
    selectedId: undefined as string | undefined,
    /**
     * A place the panel asked the globe to look at. Bumped, never cleared: the
     * globe watches the counter, so asking for the same coordinates twice still
     * flies there twice.
     */
    flyTo: undefined as { lat: number; lng: number; seq: number } | undefined,
    /** The cluster the user has opened, if any (see lib/eventClusters.ts). */
    expandedClusterId: undefined as string | undefined,
    /** Visible span when that cluster was opened — the fan is only valid near it. */
    expandedSpan: 0,
  }),
  getters: {
    /**
     * The globe shows the *selection*, not the whole visible window: the rail is
     * a map of time, and the highlighted band on it is what you asked to see.
     */
    visible(state): HistoricalEvent[] {
      const { selection } = useTimeStore()
      const { maxEvents, showMinorEvents } = useSettingsStore()
      void state.revision // getter caches by revision, not by array identity
      const filter = { ...state.filter, minor: showMinorEvents }
      return index.query(selection.start, selection.end, filter, maxEvents)
    },
    /**
     * The item the panel shows. A derived birth/death pin is not an article of
     * its own — selecting one opens the life it came from, while `selectedId`
     * stays on the pin so the globe can keep highlighting the right teardrop.
     */
    selected(state): Item | undefined {
      void state.revision
      if (!state.selectedId) return undefined
      const derivedFrom = index.pin(state.selectedId)?.derivedFrom
      return index.byId.get(derivedFrom ?? state.selectedId)
    },
    allTags: () => [...TAGS],
    childrenOf: (s) => (id: string) =>
      s.all.filter((e): e is HistoricalEvent => 'parent' in e && e.parent === id),
    byId: (s) => (id: string) => s.all.find((e) => e.id === id),
    /** A pin by id, derived pins included — what the globe and the panel jump to. */
    pinById: (s) => (id: string) => {
      void s.revision
      return index.pin(id)
    },
    /**
     * The items on either end of a link with this one: what its body points at,
     * and what points back at it. The panel's "Linked" section — an article's
     * neighbourhood, assembled rather than hand-listed.
     */
    linkedTo: (s) => (id: string) => {
      void s.revision
      const item = index.byId.get(id)
      if (!item) return [] as Item[]
      const out = new Map<string, Item>()
      for (const other of index.backlinksTo(id)) if (other.id !== id) out.set(other.id, other)
      for (const target of internalLinkIds(item.body ?? '')) {
        const t = index.byId.get(target)
        if (t && t.id !== id) out.set(t.id, t)
      }
      return [...out.values()].sort((a, b) => b.priority - a.priority)
    },
    search: (s) => (q: string) => {
      void s.revision
      return searchItems(s.all, q)
    },
  },
  actions: {
    /** Fetch the manifest and the always-loaded spine; then prefetch the rest when idle. */
    async init() {
      // The manifest is the root of the whole dataset: without it there is no
      // spine, no chunk list, and nothing ever asks again. It used to be one
      // unguarded await, so a 404 or a dropped connection rejected out of
      // `onMounted` and left an app with no events at all and no way back.
      // A handful of tries with a widening gap covers the case this actually
      // fails in — a cold CDN or a phone changing network — and giving up
      // quietly still leaves everything that does not depend on it working.
      for (let attempt = 0; attempt < 4 && !this.manifest; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt))
        this.manifest = (await fetchJson<EventManifest>(DATA + 'manifest.json')) ?? null
      }
      if (!this.manifest?.spine) return
      await this.load(this.manifest.spine)
      const t = useTimeStore()
      this.ensure(t.range.start, t.range.end)
      // Background prefetch keeps search and event-to-event links whole without
      // gating anything on it. One chunk at a time; failures just leave that
      // chunk to the window-driven path.
      // globalThis, not window: this action is ordinary async code and gets run
      // by tests and by anything else without a DOM, where reaching for
      // `window` throws and takes the spine down with it.
      const idle = globalThis.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 4000))
      idle(async () => {
        for (const c of this.manifest?.chunks ?? []) await this.load(c.file)
      })
    },
    /** Merge items into the store and rebuild the query index. */
    adopt(events: Item[]) {
      this.all = mergeEvents(this.all, events)
      index = new EventIndex(this.all)
      this.revision++
    },
    async load(file: string) {
      if (this.requested.has(file)) return
      this.requested.add(file)
      const events = await fetchJson<Item[]>(DATA + file)
      // A chunk file is an array. Anything else — an error document, a partial
      // write, a proxy's login page — is not data, and merging it would put
      // objects with no id or date into the index.
      if (Array.isArray(events)) this.adopt(events)
      else this.requested.delete(file) // transient failure — retry on the next window move
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
    /** Ask the globe to look at a coordinate (a person's birth or death place). */
    lookAt(lat: number, lng: number) {
      this.flyTo = { lat, lng, seq: (this.flyTo?.seq ?? 0) + 1 }
    },
    /** The year to put the timeline on when an item is opened from a link. */
    focusYear(id: string): number | undefined {
      const pin = index.pin(id)
      if (pin) return pin.start
      const item = index.byId.get(id)
      return item && anchorYearOf(item)
    },
    expandCluster(id: string, spanDeg: number) {
      this.expandedClusterId = id
      this.expandedSpan = spanDeg
    },
    collapseClusters() {
      this.expandedClusterId = undefined
    },
    /**
     * Zoom moved. The fan itself follows the camera now (it is laid out in
     * screen pixels from the live frame), so only a change big enough to have
     * re-run the clustering closes it — see FAN_COLLAPSE_FACTOR.
     */
    noteSpan(spanDeg: number) {
      if (this.expandedClusterId && spanChangedEnough(this.expandedSpan, spanDeg, FAN_COLLAPSE_FACTOR))
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
