import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import {
  EventIndex,
  anchorYearOf,
  effectivePriority,
  isMinor,
  searchItems,
  type EventFilter,
  type HistoricalEvent,
  type Item,
} from '../lib/events'
import { focusTargetFor, type FocusTarget } from '../lib/geoFocus'
import { assignTiers, type Tier } from '../lib/eventTiers'
import { internalLinkIds } from '../lib/richtext'
import { chunksFor, mergeEvents, type EventManifest } from '../lib/eventChunks'
import { TAGS } from '../lib/tags'
import { FAN_COLLAPSE_FACTOR, spanChangedEnough } from '../lib/eventClusters'
import { useTimeStore } from './time'
import { useSettingsStore } from './settings'
import { useViewStore } from './view'

// The index lives outside reactive state: it is rebuilt wholesale on merge and
// queried thousands of times per scrub, so wrapping it in proxies buys nothing.
// `revision` is what tells getters it changed.
let index = new EventIndex([])

/**
 * The tier each visible event was last given.
 *
 * Held outside the store, and outside reactivity, because it is the *input* to
 * the getter that produces the next one — tiers have hysteresis (see
 * lib/eventTiers.ts), so the assignment is a function of the previous
 * assignment as well as of the current result set. A getter reading its own
 * last value through a ref would loop; a module-level handoff cannot, since a
 * computed only re-runs when something it read changed, and this is not one of
 * those things.
 */
let lastTiers: ReadonlyMap<string, Tier> = new Map()

const DATA = `${import.meta.env.BASE_URL}data/events/`

/**
 * How many child pins focus mode will force onto the globe.
 *
 * In the mode the children are not competing for the screen — they *are* the
 * screen (see `visible`) — so nothing else bounds them, and they need a bound
 * for the same reason the top-N cap exists: "Contains" on World War II is a
 * hundred entries, and putting all of them on the globe would replace one open
 * article with a swarm. Fifteen is about what a fitted frame holds without the
 * pins colliding, and every real operation in the corpus has fewer parts.
 */
export const FOCUS_CHILD_CAP = 15

/**
 * The children of an item, best first — what focus mode pins alongside it.
 *
 * Direct children only, and *children only*: the pins a battle plan puts on the
 * globe are the events the plan contains, never the things it merely relates to.
 * A strong association is an article to read next, not a teardrop to draw on
 * someone else's map, and the product asked for exactly this — "in a battle
 * plan, show only child events".
 *
 * The panel's own "Contains" list is the same set, so the two agree. A grandchild
 * is one click away, at which point it becomes the focus and brings its own.
 *
 * Sorted best-first here, though `EventIndex.childrenOf` hands them over
 * chronologically: this is the list the cap bites into, and what it should keep
 * is the battles that matter, not the earliest five.
 */
const focusChildrenOf = (parentId: string, cap = FOCUS_CHILD_CAP): HistoricalEvent[] =>
  [...index.childrenOf(parentId)]
    .sort((a, b) => b.priority - a.priority || a.start - b.start)
    .slice(0, cap)

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
     *
     * `altitude` is optional and means "and this far out", which is what fitting
     * a route or a footprint in the frame needs; without it the camera keeps the
     * height the user chose, which is what a birth-place chip wants.
     */
    flyTo: undefined as
      | { lat: number; lng: number; altitude?: number; seq: number }
      | undefined,
    /** The cluster the user has opened, if any (see lib/eventClusters.ts). */
    expandedClusterId: undefined as string | undefined,
    /** Visible span when that cluster was opened — the fan is only valid near it. */
    expandedSpan: 0,
    /**
     * FOCUS MODE: the reader asked to *look at* something, not to read about it.
     *
     * Entered by "Show on map" on *anything* the map can reach — a battle plan,
     * a voyage, a footprint, a bare point event alike. Four things follow, and
     * they are the whole feature:
     *
     *  · the panel minimises to a pill (EventPanel.vue), so the map is not
     *    behind an article;
     *  · the item's `drawing` renders (GlobeView.vue) — the one place it does;
     *  · its child events get their pins (see `visible`), so an operation shows
     *    its battles;
     *  · and *nothing else* is on the globe: no unrelated pins, no nation
     *    borders. That is the point of the mode, and the reason it applies to a
     *    lone pin too — "show me this" is answered by a clear map with this on
     *    it, whatever this happens to be.
     *
     * It is *not* the same thing as the selection, and keeping them apart is
     * what makes Escape do something sensible: Escape leaves the mode and gives
     * back the article, without closing it.
     */
    focus: undefined as { itemId: string } | undefined,
    /** In focus mode, has the reader pulled the article back up over the map? */
    focusExpanded: false,
  }),
  getters: {
    /**
     * The globe shows the *selection*, not the whole visible window: the rail is
     * a map of time, and the highlighted band on it is what you asked to see.
     *
     * And, once the camera is closer than world view, only the ground it can
     * see: the top-N budget is what one frame can usefully hold, so zoomed in it
     * is spent among the events in the frame. `view.scope` is `undefined` at
     * world view, where this is the global query it has always been, and is
     * quantised so that a pan or a zoom re-runs it a few times rather than sixty
     * times a second (lib/viewport.ts).
     */
    visible(state): HistoricalEvent[] {
      const { selection } = useTimeStore()
      const { maxEvents, showMinorEvents } = useSettingsStore()
      const view = useViewStore()
      void state.revision // getter caches by revision, not by array identity
      const filter = { ...state.filter, minor: showMinorEvents }
      // `toRaw`, because the scope is read *per candidate* inside the query and
      // store state hands out a deep reactive proxy: every `scope.lat` in that
      // loop would otherwise go through a get trap. Timed against the same
      // query with a plain object, the proxy costs 1.4-2.3x. Reading the
      // property here still registers the dependency; only the value handed on
      // is unwrapped.
      const scope = view.scope && toRaw(view.scope)
      // FOCUS MODE short-circuits the contest entirely. The reader asked to look
      // at one thing, and the answer is that thing and the parts of it — not
      // that thing *plus* whatever else the top-N budget happened to rank into
      // the same frame. So the culling never runs: there is nothing to cull
      // between, and skipping the query is also the cheapest this getter is all
      // day.
      //
      // What survives from the normal path is the *user's* own statements: the
      // timeline window and the tag/parent filters still gate every pin here
      // (`admits`), exactly as they gate a selected one. What is dropped is the
      // app's judgement — the top-N cap and the viewport scope — because a
      // focused item and its children are not competing for the screen, they
      // are the screen.
      if (state.focus) {
        const out: HistoricalEvent[] = []
        // The MINOR filter is lifted for the whole set: a child battle is part
        // of the thing already on the globe, and the focused item itself may
        // well be the minor pin the reader had to search for to get here.
        const focusFilter = { ...filter, minor: true }
        for (const id of [state.focus.itemId, ...focusChildrenOf(state.focus.itemId).map((c) => c.id)]) {
          if (out.some((e) => e.id === id)) continue
          const kept = index.admits(id, selection.start, selection.end, focusFilter)
          if (kept) out.push(kept)
        }
        return out
      }
      const out = index.query(selection.start, selection.end, filter, maxEvents, scope)
      // The open panel's event keeps its pin. Panning away from it, or scrubbing
      // until it slips out of the top N, used to leave the panel describing an
      // event with nothing on the globe to point at — and viewport scoping made
      // that easy to do by accident, since the pin now leaves the set as soon as
      // it leaves the frame. It is appended rather than ranked in: it did not
      // win a place, it is being kept, and the tiers below read it as what it
      // is (a pin the selection styling marks anyway).
      if (state.selectedId && !out.some((e) => e.id === state.selectedId)) {
        const kept = index.admits(state.selectedId, selection.start, selection.end, filter)
        if (kept) out.push(kept)
      }
      return out
    },
    /**
     * Significance tier per visible event, cut from the same effective scores
     * the culling ranked them by (see lib/eventTiers.ts).
     *
     * It rides on `visible`, so it is recomputed exactly when the result set is
     * — a scrub, a zoom past a quantisation step, a filter change — and never
     * on a frame that changed neither.
     */
    tiers(): ReadonlyMap<string, Tier> {
      const { selection } = useTimeStore()
      const ranked = this.visible.map((e) => ({
        id: e.id,
        score: effectivePriority(e, selection.start, selection.end),
        minor: isMinor(e),
      }))
      return (lastTiers = assignTiers(ranked, lastTiers))
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
    /* --- the typed relation graph, as the panel reads it ------------------
       Four getters over one index (see `buildRelations` in lib/events.ts).
       They are a precedence order, not four independent lists: the index has
       already removed a parent or a child from the association maps, and a
       strong pair from the weak one, so the same item never appears in two
       sections of the same article. */
    /** What this item is part of, innermost first: parent, grandparent, … */
    parentChainOf: (s) => (id: string) => {
      void s.revision
      return index.parentChain(id)
    },
    /** Its direct children, chronological — what "Contains" lists. */
    childrenOf: (s) => (id: string) => {
      void s.revision
      return index.childrenOf(id)
    },
    /** Its defining associations, both authoring directions merged. */
    strongOf: (s) => (id: string) => {
      void s.revision
      return index.strongOf(id)
    },
    /** Its see-also associations — declared `weak` only. */
    weakOf: (s) => (id: string) => {
      void s.revision
      return index.weakOf(id)
    },
    byId: (s) => (id: string) => s.all.find((e) => e.id === id),
    /** A pin by id, derived pins included — what the globe and the panel jump to. */
    pinById: (s) => (id: string) => {
      void s.revision
      return index.pin(id)
    },
    /**
     * Where the camera would have to be to show this item — `undefined` for an
     * item with no geometry at all, which is what hides the panel's "Show on
     * map" action on a concept. Derived birth/death pins resolve too, since they
     * are events like any other once the index has made them.
     */
    mapTarget: (s) => (id: string): FocusTarget | undefined => {
      void s.revision
      const item = index.byId.get(id) ?? index.pin(id)
      return item && focusTargetFor(item)
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
    /**
     * "See also": the declared `weak` edges, then everything the prose is
     * already tied to that no stronger relation has claimed.
     *
     * Body links are not a fourth relation type — they are sentences, and an
     * article that mentions the Black Death in passing has not declared
     * anything. But the pair *is* worth offering, so it lands at the bottom of
     * the softest section rather than in a machine-y "Linked" list of its own.
     * Deduped against the three sections above it, in their precedence order,
     * so nothing is offered twice under two different headings.
     */
    seeAlsoOf(state) {
      return (id: string): Item[] => {
        void state.revision
        const out: Item[] = []
        const taken = new Set<string>([id])
        for (const i of index.parentChain(id)) taken.add(i.id)
        for (const i of index.childrenOf(id)) taken.add(i.id)
        for (const i of index.strongOf(id)) taken.add(i.id)
        for (const i of [...index.weakOf(id), ...this.linkedTo(id)])
          if (!taken.has(i.id)) {
            taken.add(i.id)
            out.push(i)
          }
        return out
      }
    },
    search: (s) => (q: string) => {
      void s.revision
      return searchItems(s.all, q)
    },
    /** The item focus mode is on, if any — what the pill names and what draws. */
    focused(state): Item | undefined {
      void state.revision
      return state.focus ? index.byId.get(state.focus.itemId) : undefined
    },
    /** The child events focus mode is forcing onto the globe. */
    focusChildren(state): HistoricalEvent[] {
      void state.revision
      return state.focus ? focusChildrenOf(state.focus.itemId) : []
    },
    /** Is the panel currently the compact pill rather than the article? */
    panelMinimised(state): boolean {
      return !!state.focus && !state.focusExpanded
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
      // A merge changes what the result set is a contest *between*, so the
      // tier memory it was holding is about a different contest. Dropping it
      // costs at most one re-cut of the tiers on the frame a chunk lands, and
      // keeps the hysteresis from carrying an opinion across datasets.
      lastTiers = new Map()
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
      // Selecting anything *else* leaves focus mode. The mode is a statement
      // about one item ("show me this"); clicking another pin, following a link
      // or closing the panel are all statements about a different one, and
      // leaving a battle plan drawn under someone else's article would be the
      // map arguing with the panel. Re-selecting the focused item is not a
      // change and keeps the mode — which is what lets the pill's own children
      // be clicked without the drawing flickering away.
      if (this.focus && this.focus.itemId !== id) this.exitFocus()
      this.selectedId = id
      // picking a member answers the question the cluster was asking, so it
      // closes; the selected event keeps its own pin either way.
      this.expandedClusterId = undefined
    },
    /**
     * Put the map in front: minimise the panel, draw the item's drawing, pin its
     * children. See `focus` in the state above.
     */
    enterFocus(id: string) {
      this.focus = { itemId: id }
      this.focusExpanded = false
    },
    /** Leave it: the article comes back whole, the drawing goes, the pins relax. */
    exitFocus() {
      this.focus = undefined
      this.focusExpanded = false
    },
    /** The pill's chevron: the article, over the map, without leaving the mode. */
    toggleFocusExpanded() {
      if (this.focus) this.focusExpanded = !this.focusExpanded
    },
    /**
     * Ask the globe to look at a coordinate (a person's birth or death place),
     * optionally from a given height — see `flyTo` and `showOnMap`.
     */
    lookAt(lat: number, lng: number, altitude?: number) {
      this.flyTo = { lat, lng, altitude, seq: (this.flyTo?.seq ?? 0) + 1 }
    },
    /**
     * "Show me this on the map": the one action that makes an item *visible*,
     * wherever the reader arrived from — a search hit, a link inside an article,
     * a minor item nothing would have pinned.
     *
     * Four things have to be true afterwards, and each is one line here:
     *
     *  · it is **selected**, which is what keeps its pin and what draws its area
     *    and its routes;
     *  · the **timeline** contains it — `focusTime` recentres the window if the
     *    year is outside it and then extends the selection band onto the year,
     *    which is the same extendSelectionTo rule a scrub obeys;
     *  · the **camera** frames its whole geometry (lib/geoFocus.ts): a point
     *    from a sensible height, a footprint or a route fitted with margin;
     *  · and the app is in **focus mode**: the article folds to a pill and the
     *    globe clears down to this item, its children and its ink (see `focus`).
     *
     * That last one has no exceptions. It used to require real geometry, on the
     * reasoning that minimising an article to reveal a single teardrop is a
     * worse view of the same thing — but that is only true on a globe still
     * covered in other people's pins. Now that the mode empties the map, a bare
     * point event gets the same answer everything else does: the thing you asked
     * for, alone, with the camera on it.
     *
     * The selection is left alone when the panel is already showing this item,
     * so pressing it from a birth pin does not swap the pin out from under the
     * article it opened.
     */
    showOnMap(id: string) {
      // The one thing that can still refuse: an item with nowhere to go at all,
      // which is a concept. The panel hides the button in that case, so this is
      // the guard rather than the behaviour.
      const target = this.mapTarget(id)
      if (!target) return
      if (this.selected?.id !== id) this.select(id)
      const year = this.focusYear(id)
      if (year !== undefined) useTimeStore().focusTime(year)
      this.lookAt(target.lat, target.lng, target.altitude)
      this.enterFocus(id)
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
