import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import {
  EventIndex,
  anchorYearOf,
  effectivePriority,
  isMinor,
  parseItems,
  searchItems,
  touchesSpan,
  type EventFilter,
  type HistoricalEvent,
  type Item,
  type MapPin,
  type RawItem,
  type Subject,
} from '../lib/events'
import { timeStart } from '../lib/time'
import type { Drawing } from '../lib/drawing'
import { orderedSteps, stepTimeYears, type Step } from '../lib/steps'
import { resolveFocusInk } from '../lib/present/ink'
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
 * How many focus contexts the stack will hold (see `focusStack`).
 *
 * The real case is two — an operation, and a battle inside it the reader pressed
 * "Show on map" on — and the corpus's parent chains are three deep at the very
 * most. The cap is not a UX rule, it is a bound: nothing here ever pops a frame
 * the user did not put on, so without one a long enough session down a chain of
 * parts would grow the array forever. When it bites, the *oldest* context goes:
 * the way back out of the innermost few is worth more than the way back to
 * something six steps ago.
 */
export const FOCUS_STACK_CAP = 4

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
    .sort((a, b) => b.priority - a.priority || timeStart(a.time) - timeStart(b.time))
    .slice(0, cap)

/**
 * Is `id` a *part of* `parentId` — a battle inside the operation?
 *
 * This is the whole test the focus navigation turns on (see `select`), so it
 * asks the data rather than the fifteen pins the cap let through: a child listed
 * under "Contains" but ranked out of the pinned set is still part of the thing
 * on screen, and opening it should no more leave the operation than opening the
 * one next to it would. `visible` keeps a pin under it either way.
 *
 * Life markers (a person's birth, a death) are asked about too — they are pins
 * without a `parent`, so the answer is always no, which is the correct one: a
 * birth is related to a life, never contained by an operation.
 */
const isPartOf = (parentId: string, id?: string): boolean => {
  if (!id) return false
  // Only an event is *part of* anything — a life, an idea or a life marker is
  // related to things, never contained by them (see `parent` in lib/events.ts).
  const item = index.byId.get(id)
  if (item?.kind === 'event' && item.parent === parentId) return true
  const pin = index.pin(id)
  return pin?.kind === 'event' && pin.parent === parentId
}

/** The focus context the reader is in: the top of the stack. */
const topFocus = (stack: readonly string[]): string | undefined => stack[stack.length - 1]

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
     *
     * A STACK, innermost last, because looking at something is a place you can
     * be *inside of*. An operation's battles are on the globe precisely so they
     * can be opened; opening one used to throw the operation away, so closing
     * the battle landed on the default world rather than back where the reader
     * had been. Now:
     *
     *  · selecting a part of the focused item keeps this stack as it is — the
     *    plan and its pins stay, the part's article opens over them, and the
     *    panel offers "← Operation Barbarossa" (see `focusReturnTo`);
     *  · pressing "Show on map" on that part *pushes* it: it becomes the
     *    context, with its own ink and its own parts, and leaving pops back to
     *    the operation rather than to the world;
     *  · a statement about anything else — a search hit, a link out of the
     *    family — empties the stack in one go (`clearFocus`).
     *
     * INVARIANT (the thing the stuck state broke): while this is non-empty the
     * selection is either the context itself or a part of it, so there is always
     * an article or a pill on screen naming something — i.e. always a way out.
     * Every action below leaves that true; `tests/eventsStore.test.ts` walks the
     * transitions and checks it.
     */
    focusStack: [] as string[],
    /** In focus mode, has the reader pulled the article back up over the map? */
    focusExpanded: false,
    /**
     * STEPPED FOCUS: which authored step of the focused event the reader is in,
     * or `undefined` for the overview.
     *
     * `undefined` is the ground state and it is never skipped: entering a focus,
     * pushing one, popping one and dropping the whole stack all reset it, so the
     * first thing a reader sees of any event is always the event whole (see
     * lib/steps.ts, rule 1). Only `selectStep` ever sets it, and only to an id
     * the focused event actually declares.
     *
     * It belongs to the TOP of the focus stack, not to the stack: stepping into
     * a battle inside a stepped operation and back out again returns to the
     * overview rather than to whichever step was open, because the step is a
     * reading of one event and the reader has been somewhere else since.
     */
    stepId: undefined as string | undefined,
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
    visible(state): MapPin[] {
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
      const focusId = topFocus(state.focusStack)
      if (focusId) {
        const out: MapPin[] = []
        // The MINOR filter is lifted for the whole set: a child battle is part
        // of the thing already on the globe, and the focused item itself may
        // well be the minor pin the reader had to search for to get here.
        const focusFilter = { ...filter, minor: true }
        // The selection is appended for the same reason it is outside the mode
        // (below): whatever the panel is open on keeps its pin. Inside a focus
        // that is normally the context or one of the children already listed —
        // it matters for the child that "Contains" reached but the child cap
        // ranked out of the pinned set.
        //
        // So are the open step's HIGHLIGHTS, and for a stronger reason: a step
        // that says it is about Kiev has said the one thing that outranks the
        // child cap. The cap exists to stop a hundred children swamping the
        // globe; a named child is not one of the hundred, it is the point of the
        // moment the reader is standing in. See `Step.highlights`.
        for (const id of [
          focusId,
          ...focusChildrenOf(focusId).map((c) => c.id),
          ...this.highlightedIds,
          ...(state.selectedId ? [state.selectedId] : []),
        ]) {
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
     * The item the panel shows. A life marker is not an article of its own —
     * selecting one opens the life it came from (`EventIndex.article` is the
     * one place that resolution lives), while `selectedId` stays on the pin so
     * the globe can keep highlighting the right teardrop.
     */
    selected(state): Item | undefined {
      void state.revision
      return state.selectedId ? index.article(state.selectedId) : undefined
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
    /**
     * Where the camera would have to be to show this item — `undefined` for an
     * item with no geometry at all, which is what hides the panel's "Show on
     * map" action on a concept. Life markers resolve too: they carry a geometry
     * of their own (a point, at the place the life began or ended).
     *
     * Fitted to the window that is actually on screen, not to a square one: the
     * lens's fov measures the frame's HEIGHT, so on a portrait phone the frame
     * is half as wide as it is tall and a route fitted vertically hangs off both
     * sides (see `tightFovDeg` in lib/geoFocus.ts). The view store already
     * publishes both axes for the scale bar and the scope, so the fit costs a
     * read; it also makes this getter follow a resize, which is right — the
     * altitude that framed an item in landscape does not frame it in portrait.
     */
    mapTarget: (s) => (id: string): FocusTarget | undefined => {
      void s.revision
      const view = useViewStore()
      const item = index.byId.get(id) ?? index.pin(id)
      return (
        item &&
        focusTargetFor(item, view.fov, view.viewportWidthPx / Math.max(1, view.viewportPx))
      )
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
    /**
     * The focus context the reader is in, or `undefined` for the plain map.
     *
     * The top of `focusStack`, in the shape the rest of the app already reads
     * (`events.focus?.itemId`). A getter, so the stack is the single truth and
     * nothing can set a focus without going through the actions that keep the
     * selection consistent with it.
     */
    focus(state): { itemId: string } | undefined {
      const id = topFocus(state.focusStack)
      return id ? { itemId: id } : undefined
    },
    /** The item focus mode is on, if any — what the pill names and what draws. */
    focused(state): Subject | undefined {
      void state.revision
      const id = topFocus(state.focusStack)
      // `pin` as well as `byId`: "Show on map" reaches life markers (a person's
      // birth), which are pins in their own right but live outside `byId`.
      // Without the fallback the mode would be on with nothing named.
      return id ? (index.byId.get(id) ?? index.pin(id)) : undefined
    },
    /** The child events focus mode is forcing onto the globe. */
    focusChildren(state): HistoricalEvent[] {
      void state.revision
      const id = topFocus(state.focusStack)
      return id ? focusChildrenOf(id) : []
    },
    /**
     * When the panel is open on a *part* of the focused item — a battle inside
     * the operation — the item to go back to; `undefined` otherwise.
     *
     * This is the back control's whole condition and its label ("← Operation
     * Barbarossa"), and it is why the reader can tell they are inside something
     * rather than looking at a battle that happens to have pins around it.
     */
    focusReturnTo(state): Subject | undefined {
      void state.revision
      const id = topFocus(state.focusStack)
      if (!id || !state.selectedId || state.selectedId === id) return undefined
      return index.byId.get(id) ?? index.pin(id)
    },
    /** Is the panel currently the compact pill rather than the article? */
    panelMinimised(state): boolean {
      return state.focusStack.length > 0 && !state.focusExpanded
    },
    /* --- stepped focus (lib/steps.ts) --------------------------------------
       Four getters over one authored list. They are the whole of what the step
       strip, the step page and the globe read, and every one of them is empty or
       `undefined` for the overwhelming majority of the corpus, which carries no
       steps at all. */
    /**
     * The focused event's steps, in time order — `[]` when there are none, or
     * when the thing in focus is a life marker, a person or an idea.
     *
     * Ordered here rather than trusted from the data, so the chips read
     * chronologically whatever order they were typed in.
     */
    focusSteps(): Step[] {
      const item = this.focused
      if (item?.kind !== 'event' || !item.steps?.length) return []
      return orderedSteps(item.steps, item.time)
    },
    /** The step the reader is in, or `undefined` — the overview. */
    activeStep(state): Step | undefined {
      return state.stepId ? this.focusSteps.find((s) => s.id === state.stepId) : undefined
    },
    /**
     * The children the open step has asked to be lifted (see `Step.highlights`).
     * Empty on the overview, which is the ground state and says nothing.
     */
    highlightedIds(): string[] {
      return this.activeStep?.highlights ?? []
    },
    /**
     * The plan on the globe: the focused item's ink, resolved for the open step.
     *
     * The FOCUS's drawing, not the selection's — while a child battle is open
     * inside an operation the operation's plan is what stays on the map. What
     * the step does to it — filter the parent's layers, merge the step's own —
     * is `resolveFocusInk` (lib/present/ink.ts) and lives there rather than
     * here, so the one rule that decides what is on the map is a pure function a
     * test can reach. On the overview it hands back the drawing itself, the same
     * object, so stepping back out is a no-op for the renderer's key comparison.
     */
    focusDrawing(state): Drawing | undefined {
      const item = this.focused
      if (item?.kind !== 'event') return undefined
      return resolveFocusInk(item, state.stepId, { mode: useSettingsStore().mode })
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
    adopt(raw: RawItem[]) {
      this.all = mergeEvents(this.all, parseItems(raw))
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
      const events = await fetchJson<RawItem[]>(DATA + file)
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
    /**
     * Open an item. `select()` with nothing is not "select undefined" — it is
     * the close button, and it unwinds (see `close`).
     *
     * Selecting anything *outside* the focused item leaves the mode altogether.
     * The mode is a statement about one item ("show me this"); a search hit or a
     * link out of the family is a statement about a different one, and leaving a
     * battle plan drawn under someone else's article would be the map arguing
     * with the panel.
     *
     * Selecting the focused item, or one of its PARTS, is not that. A battle is
     * on the globe *because* the operation is being looked at, so opening it
     * stays inside the operation: the ink and the sibling pins keep their places
     * and the article (or the pill — whichever shape the panel is in) swaps to
     * the battle, with a way back to the operation on it.
     */
    select(id?: string) {
      if (id === undefined) return this.close()
      const focusId = topFocus(this.focusStack)
      if (focusId !== undefined && focusId !== id && !isPartOf(focusId, id)) this.clearFocus()
      // Clicking a PART of the focused item opens its article expanded, even if
      // the context's own panel was minimised: the tap said "tell me about this
      // one", and answering with another pill would make the user tap twice.
      else if (focusId !== undefined && focusId !== id) this.focusExpanded = true
      this.selectedId = id
      // picking a member answers the question the cluster was asking, so it
      // closes; the selected event keeps its own pin either way.
      this.expandedClusterId = undefined
    },
    /**
     * The close button on the article and on the pill, and the last thing Escape
     * does — one layer at a time, never straight to the world:
     *
     *  · reading a part of the focused item → back to the focused item, still in
     *    the mode, its plan still on the globe;
     *  · reading the focused item itself → out of that context, and into
     *    whatever context it was opened from (`exitFocus` pops the stack);
     *  · nothing focused → the panel simply closes.
     *
     * The one place the selection is cleared is the bottom of that ladder, which
     * is what makes "close" reachable in a finite number of presses from every
     * state and what keeps a focus from ever being left on screen with no panel
     * to leave it by.
     */
    close() {
      const focusId = topFocus(this.focusStack)
      this.expandedClusterId = undefined
      if (focusId === undefined) {
        this.selectedId = undefined
        return
      }
      if (this.selectedId !== undefined && this.selectedId !== focusId) {
        this.selectedId = focusId
        // back to the context as its pill: the child's article was the reading,
        // and closing it should uncover the map, not swap one article for another
        this.focusExpanded = false
        return
      }
      this.exitFocus()
      // The stack ran out: the mode is over and so is the reading.
      if (this.focusStack.length === 0) this.selectedId = undefined
    },
    /**
     * Escape, and the panel's "← …" control: unwind exactly one layer of the
     * mode without closing anything that can be stepped back into instead.
     *
     * Same ladder as `close`, minus its last rung — Escape gives the map back,
     * it does not take the article away (see HomeView.vue).
     */
    focusBack() {
      const focusId = topFocus(this.focusStack)
      if (focusId === undefined) return
      if (this.selectedId !== undefined && this.selectedId !== focusId) {
        this.selectedId = focusId
        // same as close(): stepping back from a part restores the context's
        // pill, not an article — the child's article auto-expanded on select
        this.focusExpanded = false
      } else this.exitFocus()
    },
    /**
     * Put the map in front: minimise the panel, draw the item's drawing, pin its
     * children. See `focusStack` in the state above.
     *
     * A part of the item already in focus is *pushed*, so leaving it comes back
     * here; anything else replaces the stack, because it is a statement about
     * somewhere else entirely.
     */
    enterFocus(id: string) {
      const focusId = topFocus(this.focusStack)
      if (focusId === id) {
        // already the context — "Show on map" pressed again on the open article
      } else if (focusId !== undefined && isPartOf(focusId, id)) {
        this.focusStack.push(id)
        if (this.focusStack.length > FOCUS_STACK_CAP) this.focusStack.shift()
      } else {
        this.focusStack = [id]
      }
      this.focusExpanded = false
      // A new context always opens on its overview, never on a step — the one
      // that was open belonged to the event being left (see `stepId`).
      this.stepId = undefined
      // The mode is always on its own item: this is what makes the invariant
      // hold no matter which way the caller arrived (a pin, a link, a search).
      this.selectedId = id
    },
    /**
     * Leave the innermost context: the article comes back whole, the drawing
     * goes, the pins relax — or, if this focus was opened from inside another,
     * that one comes back instead of the plain map.
     */
    exitFocus() {
      this.focusStack.pop()
      this.focusExpanded = false
      this.stepId = undefined // the step belonged to the context being left
      const focusId = topFocus(this.focusStack)
      if (focusId !== undefined) this.selectedId = focusId
    },
    /**
     * Drop every context at once — the plain map, with the panel left alone.
     * What a statement about something outside the family does to the mode.
     */
    clearFocus() {
      if (this.focusStack.length) this.focusStack = []
      this.focusExpanded = false
      this.stepId = undefined
    },
    /**
     * The clean slate: no focus, no selection, no open cluster.
     *
     * This is what picking an era or an age means — the reader has asked for a
     * different *time*, which is a question about the whole world and not about
     * whatever one operation was filling the globe. The era pickers call it
     * alongside `time.selectEra` (TopBar.vue, TimelineBar.vue) rather than the
     * time store calling it itself: time knows nothing about events, and this is
     * the composition point where the two are already spoken about together.
     */
    dismiss() {
      this.clearFocus()
      this.selectedId = undefined
      this.expandedClusterId = undefined
    },
    /**
     * The mode outlives nothing. Scrubbing the band clear of the focused item is
     * the same statement picking an era makes — "show me a different time" — and
     * it gets the same answer (`dismiss`).
     *
     * Focus mode is one item's context: its ink on the ground, its children
     * pinned, its steps in the strip. All of that is *about a year*, and the
     * band is what says the year is on screen. Without this the mode simply
     * stayed: Barbarossa's 1941 front, drawn over the Permian, on a globe with
     * no pins on it at all (/tmp/shots35/verify-F2-live.png). The pin was culled
     * by the same band a hundred lines up (`visible`), so the mode was already
     * arguing with the map it was drawn on.
     *
     * The test is intersection, not containment, and that margin is the design:
     * a band nudged off one end of a fifty-year war still touches it, and a
     * reader stepping through the steps of an operation is moving the *cursor*
     * only (`setCursor` in stores/time.ts), which never narrows the band. The
     * mode dies when its subject has left the timeline entirely — no sooner.
     *
     * An item that is not in the index yet is left alone: chunks stream, and
     * "I have not loaded it" is not "it is not in this time".
     */
    dropFocusOffTimeline(start: number, end: number) {
      const item = this.focused
      if (!item || touchesSpan(item, start, end)) return
      this.dismiss()
    },
    /** The pill's chevron: the article, over the map, without leaving the mode. */
    toggleFocusExpanded() {
      if (this.focusStack.length) this.focusExpanded = !this.focusExpanded
    },
    /**
     * Step into one of the focused event's steps — or, with no id, back out to
     * the overview. The step strip's only action (see components/StepStrip.vue).
     *
     * Five things follow, and they are the feature:
     *
     *  · the **drawing** filters to the timeless layers plus that step's, and the
     *    step's own ink merges over the top (`focusDrawing`), so the June front
     *    and the December front are no longer on the map at the same time;
     *  · its **highlights**, if it names any, are pinned and accented — see
     *    `highlightedIds` and `Step.highlights`;
     *  · the step's **page** replaces the article's body, with the step's name as
     *    its heading and a way back — and only when there is one, because a step
     *    that is purely a filter of the map should not open a panel over the map
     *    it just filtered;
     *  · the **camera** moves, if the step says where; if it does not, the view
     *    is left exactly where the reader put it, which is the more common and
     *    the less rude case;
     *  · the **cursor** moves to the step's year — the cursor only, and its
     *    START if it is a period. See `setCursor` in stores/time.ts for why the
     *    selection band must not follow it.
     *
     * An unknown id is a no-op rather than a reset: it can only come from a stale
     * link or a chunk that has not loaded, and answering "I do not know that
     * step" by silently changing what is on the globe is worse than answering
     * nothing.
     *
     * Whichever chip is pressed, the **selection comes back to the focused
     * event** first. The strip is a control over one event — its own steps — and
     * a step's page belongs to that event's article, not to whatever else the
     * panel happens to be open on: with a battle inside the operation open, the
     * chip used to light up while its page stayed unreachable (the page renders
     * only on the focused event's own article, see `stepPage` in EventPanel.vue)
     * and `focusExpanded` force-opened the *battle's* article instead — a click
     * on Kiev that answered with Minsk.
     */
    selectStep(id?: string) {
      const item = this.focused
      if (item?.kind !== 'event') return
      // Was the panel open on a PART of the event? Then the part's article is
      // not the reading any more, and the pill comes back with it — the same
      // rule `close` and `focusBack` follow on the way out of a part. A step
      // with a page overrides this below: that page IS a reading.
      const fromPart = this.selectedId !== item.id
      if (id === undefined) {
        const wasStepped = this.stepId !== undefined
        // Nothing to step back out of, and the panel is already on the event.
        if (!wasStepped && !fromPart) return
        this.selectedId = item.id
        this.stepId = undefined
        if (fromPart) this.focusExpanded = false
        // Only refit the camera if a step could have moved it: an event whose
        // steps carry no camera never took the view over, and putting it back
        // would be undoing something the reader did themselves.
        if (wasStepped && this.focusSteps.some((s) => s.camera)) {
          const target = this.mapTarget(item.id)
          if (target) this.lookAt(target.lat, target.lng, target.altitude)
        }
        return
      }
      const step = this.focusSteps.find((s) => s.id === id)
      if (!step) return
      this.selectedId = item.id
      this.stepId = step.id
      if (step.page) this.focusExpanded = true
      else if (fromPart) this.focusExpanded = false
      // The step's own time, projected back onto the event's real years — its
      // START, which for a point is the whole of it and for a stretch is where
      // the reader is being put.
      useTimeStore().setCursor(timeStart(stepTimeYears(step, item.time)))
      if (step.camera) this.lookAt(step.camera.lat, step.camera.lng, step.camera.altitude)
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
     *
     * Pressed on a PART of the item already in focus — a battle inside the
     * operation — this pushes rather than replaces (see `enterFocus`), so the
     * battle gets the map on the operation's terms and closing it comes back to
     * the operation.
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
      if (pin) return timeStart(pin.time)
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
