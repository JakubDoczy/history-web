import type { Year } from './time'
import type { Ring } from './nations'
import type { GeoPath, PathDirection } from './paths'
import { drawingPoints, type Drawing } from './drawing'
import { internalLinkIds } from './richtext'
import { GeoGrid, SpanIndex, TopScored, separationDeg } from './queryIndex'
import type { ViewportScope } from './viewport'

/**
 * The dataset is a set of ITEMS, not only events. Three kinds share one id
 * space, one search, one panel and one link syntax — `[text](item:id)`:
 *
 *  - `event`   something that happened at a place and a time. Pinned on the
 *              globe and drawn on the timeline. The default kind: an entry with
 *              no `kind` is an event, which is what every entry written before
 *              this model existed relies on.
 *  - `person`  an article about a life. Not a pin of its own; the index derives
 *              up to two minor point events from it (birth and death), and
 *              clicking one of those opens the person's article.
 *  - `concept` an article about an idea. No place, and only a nominal year
 *              (`anchorYear`) so it lands in an era chunk. Reached from links
 *              and from search.
 */
export type ItemKind = 'event' | 'person' | 'concept'

/** What every item carries, whatever its kind. */
export interface ItemBase {
  id: string
  kind?: ItemKind
  name: string
  /**
   * Ranking position, derived by scripts/build_event_chunks.py from
   * data/events/ranking.txt — never written by hand. Higher = more important;
   * `MINOR_PRIORITY` (0) means "not on the ranking list" (see `isMinor`).
   */
  priority: number
  tags: string[]
  summary: string
  /** Optional rich body (markdown subset, see lib/richtext.ts). */
  body?: string
  image?: { url: string; caption?: string }
  links?: { label: string; url?: string; event?: string }[]
  /** Ids of items worth reading next; rendered in the panel's read-more strip. */
  related?: string[]
}

export interface HistoricalEvent extends ItemBase {
  kind?: 'event'
  start: Year
  end?: Year // omitted = instantaneous
  lat: number
  lng: number
  /** Optional polygon (GeoJSON [lng, lat] order) for area events; lat/lng then acts as centroid. */
  area?: Ring
  /**
   * Optional route geometry: one or more polylines in GeoJSON [lng, lat] order
   * (see lib/paths.ts for why this is always an array, never a bare `path`).
   *
   * A path event is a pin like any other until it is opened; selecting it draws
   * the routes on the globe, and deselecting removes them again — the same
   * lifecycle the selected area polygon has. `lat`/`lng` stays the place the
   * pin stands, and by convention it stands *on* the route (the Strait of
   * Magellan for the circumnavigation, Nanjing for the treasure fleets).
   *
   * An event may carry both `area` and `paths`; both are drawn when it is
   * selected. The Atlantic slave trade is the case that asked for it — three
   * legs of a triangle over the basin the whole system worked across.
   */
  paths?: GeoPath[]
  /**
   * Whether the routes have a direction — see `PathDirection` in lib/paths.ts.
   * Absent means `oneway`, so a voyage need not say so; a trade network must.
   */
  direction?: PathDirection
  /**
   * An operational overlay: frontlines, thrusts, markers and labels, drawn when
   * the item is shown on the map. See lib/drawing.ts for the schema and
   * lib/drawingLayer.ts for what puts it on the globe.
   *
   * Unlike `area` and `paths`, this does NOT draw on a plain selection. A battle
   * plan is a lot of ink, and clicking a pin is a glance; "Show on map" is the
   * request to *study* the thing, and it is what puts the panel out of the way
   * (see `focus` in stores/events.ts) so there is something to study.
   */
  drawing?: Drawing
  parent?: string // id of parent event
  /**
   * Set only on events the index derives from a person (see `derivedEventsFor`).
   * Never present in the data files; it is what makes a birth pin open the
   * life it belongs to rather than a stub article about the birth.
   */
  derivedFrom?: string
}

/** Where a life began or ended. `label` is what the panel's chip says. */
export interface Place {
  lat: number
  lng: number
  label?: string
}

export interface Person extends ItemBase {
  kind: 'person'
  born: Year
  died?: Year
  birthPlace?: Place
  deathPlace?: Place
}

export interface Concept extends ItemBase {
  kind: 'concept'
  /** Nominal year: the era chunk the concept ships in, and where search sorts it. */
  anchorYear: Year
}

export type Item = HistoricalEvent | Person | Concept

export const kindOf = (i: Item): ItemKind => i.kind ?? 'event'
export const isEvent = (i: Item): i is HistoricalEvent => kindOf(i) === 'event'
export const isPerson = (i: Item): i is Person => i.kind === 'person'
export const isConcept = (i: Item): i is Concept => i.kind === 'concept'

/**
 * The priority of an item that is not on the ranking list. Minor items are off
 * the globe by default (Settings → Events → "Show minor events" brings them
 * back) but stay searchable and linkable, which is the whole point of the tier:
 * the corpus can hold far more than the map can usefully show.
 */
export const MINOR_PRIORITY = 0
export const isMinor = (i: { priority: number }) => i.priority <= MINOR_PRIORITY

/** The year an item sits at: an event starts, a person is born, a concept is anchored. */
export function anchorYearOf(i: Item): Year {
  if (isPerson(i)) return i.born
  if (isConcept(i)) return i.anchorYear
  return i.start
}

/**
 * Every coordinate an item occupies, `[lng, lat]` each — its pin, its footprint
 * and its routes. What "show this on the map" is framed on (lib/geoFocus.ts).
 *
 * A person contributes the place their life began (or ended, if that is the only
 * one recorded); a concept contributes nothing, which is what leaves it with no
 * map action at all.
 */
export function geometryPointsOf(item: Item): GeoPath {
  if (isPerson(item)) {
    const p = item.birthPlace ?? item.deathPlace
    return p ? [[p.lng, p.lat]] : []
  }
  if (isConcept(item)) return []
  const out: GeoPath = [[item.lng, item.lat]]
  if (item.area) out.push(...item.area)
  for (const path of item.paths ?? []) out.push(...path)
  // …and its drawing, which for an event like D-Day is the only geometry it has
  // beyond the pin: no footprint, no route, and a plan that spans a coastline.
  out.push(...drawingPoints(item.drawing))
  return out
}

/**
 * Is there something on the map worth clearing the screen for?
 *
 * The test behind focus mode (see `focus` in stores/events.ts): a drawing, a
 * route or a footprint is *geometry you look at*, and the article should get out
 * of its way. A bare pin is not — minimising the panel to reveal one teardrop
 * would be a worse view of the same thing.
 */
export const hasMapGeometry = (i: Item): boolean =>
  isEvent(i) && (!!i.drawing || !!i.paths?.length || !!i.area?.length)

/** The span an item occupies on the timeline — a point for anything instantaneous. */
export function timeExtentOf(i: Item): [Year, Year] {
  if (isPerson(i)) return [i.born, i.died ?? i.born]
  if (isConcept(i)) return [i.anchorYear, i.anchorYear]
  return [i.start, i.end ?? i.start]
}

/* ------------------------------------------------------------ derived pins */

/** `${personId}${DERIVED_SUFFIX.birth}` etc. — a derived pin's id. */
export const DERIVED_SUFFIX = { birth: '--birth', death: '--death' } as const

/**
 * The point events a person contributes to the globe.
 *
 * A life is an article, not a pin — but a birth and a death *are* events at a
 * place and a time, and the map is poorer for leaving them off. So the index
 * synthesises them rather than the data duplicating them: nothing in the files
 * says "Birth of Einstein", and editing the person moves the pin.
 *
 * They are minor-tier by construction. Two pins per person over a corpus of
 * lives would swamp the globe at the default cap, and a birth is rarely the
 * most important thing in its window; the ranking list governs the *person*,
 * and the pins ride along when minor events are shown.
 *
 * No place, no pin: a coordinate is not something to guess at.
 */
export function derivedEventsFor(p: Person): HistoricalEvent[] {
  const make = (suffix: string, name: string, year: Year, place: Place): HistoricalEvent => ({
    id: p.id + suffix,
    name,
    start: year,
    lat: place.lat,
    lng: place.lng,
    priority: MINOR_PRIORITY,
    tags: p.tags,
    summary: place.label ? `${name}, at ${place.label}.` : `${name}.`,
    derivedFrom: p.id,
  })
  const out: HistoricalEvent[] = []
  if (p.birthPlace)
    out.push(make(DERIVED_SUFFIX.birth, `Birth of ${p.name}`, p.born, p.birthPlace))
  if (p.died !== undefined && p.deathPlace)
    out.push(make(DERIVED_SUFFIX.death, `Death of ${p.name}`, p.died, p.deathPlace))
  return out
}

/** Everything that can carry a pin: real events, plus every person's derived pair. */
export function pinnableEvents(items: Item[]): HistoricalEvent[] {
  const out: HistoricalEvent[] = []
  for (const i of items) {
    if (isEvent(i)) out.push(i)
    else if (isPerson(i)) out.push(...derivedEventsFor(i))
  }
  return out
}

/* --------------------------------------------------------------- filtering */

export interface EventFilter {
  tags?: string[] // event must carry at least one
  parent?: string // event must be the parent itself or a descendant
  /** Include minor-tier (unranked) events. Off by default — see MINOR_PRIORITY. */
  minor?: boolean
}

const intersects = (e: HistoricalEvent, start: Year, end: Year) =>
  e.start <= end && (e.end ?? e.start) >= start

const isUnder = (e: HistoricalEvent, root: string, byId: Map<string, Item>) => {
  for (
    let cur: HistoricalEvent | undefined = e;
    cur;
    cur = cur.parent ? (byId.get(cur.parent) as HistoricalEvent | undefined) : undefined
  )
    if (cur.id === root) return true
  return false
}

const passes = (e: HistoricalEvent, filter: EventFilter, byId: Map<string, Item>) =>
  (filter.minor || !isMinor(e)) &&
  (!filter.tags?.length || e.tags.some((t) => filter.tags!.includes(t))) &&
  (!filter.parent || isUnder(e, filter.parent, byId))

/* ------------------------------------------------- partial-coverage penalty */

/**
 * A year is a unit of time, not an instant: an event dated 1939–1945 occupies
 * *seven* years, and one dated 1969 occupies one. Both spans below are measured
 * that way, which is what the dataset's integer years mean and what a reader
 * sees in the label.
 *
 * Without it the intervals are closed for `intersects` and half-open for
 * coverage, and the two disagree exactly where it hurts: Stalingrad (1942–1943)
 * against a 1943–1944 selection is an intersection worth zero overlap — the one
 * year both of them are *about* measures nothing — and the event that best
 * fits the window takes the heaviest penalty in it.
 */
export const YEAR_UNIT = 1

/**
 * How much of an event the selection actually contains: overlap ÷ event span,
 * in [0, 1]. A point event spans one unit and, once it intersects at all,
 * scores 1 — there is nothing partial about being somewhere.
 *
 * This is deliberately *not* symmetric with "how much of the selection the
 * event covers" — the question the culling asks is "is this event about the
 * years on screen?", and a 146-year warming trend seen through a ten-year
 * window is only 7% about them.
 */
export function coverageOf(evStart: Year, evEnd: Year, start: Year, end: Year): number {
  const s = Math.min(evStart, evEnd)
  const e = Math.max(evStart, evEnd)
  const overlap = Math.min(e, end) - Math.max(s, start) + YEAR_UNIT
  return Math.max(0, Math.min(1, overlap / (e - s + YEAR_UNIT)))
}

/**
 * The curve that turns coverage into a multiplier on priority, and the two
 * pairs of constants it is read with.
 *
 *     factor = floor + (1 − floor) · coverage^k        (k < 1, so concave)
 *
 * Concave and floored, both for the same reason: **the ranking list has to be
 * able to win.** A flat multiply by coverage would let any local event outrank
 * the Cold War inside the Cold War, which is not what a reader wants; the floor
 * says "an event never loses more than this fraction of its importance", and
 * k < 1 means the first sliver of overlap already buys most of what is on
 * offer. An event ten times longer than the selection (coverage 0.1) keeps 78%
 * of its rank, so priority 98 still beats priority 70 outright.
 *
 * Two cases, because the two kinds of partial overlap do not mean the same
 * thing:
 *
 *  · **ONGOING** — the event runs past the end of the selection. You are
 *    looking at the middle (or the start) of something still under way: the
 *    Cold War seen from 1960, global warming seen from the 1990s. It is *about*
 *    the years on screen, so the penalty is gentle (floor 0.60, k 0.35).
 *  · **ENDED** — the selection reaches past the event's end, so the thing
 *    finished inside the window and the rest of the window is aftermath. The
 *    Cold War against a 1990–1999 selection is one year of overlap and nine
 *    years of "after". Penalised harder (floor 0.45, k 0.50) — this is the
 *    asymmetry the product asked for.
 *
 * Full containment either way lands on coverage 1 and factor exactly 1: an
 * event wholly inside the selection is never penalised.
 *
 * Tuned against the real dataset (priorities run 52–100):
 *
 *   selection    event                        raw  cov     eff   case
 *   1990–1999    global-warming 1880–2026      90  0.068  68.1  ongoing
 *   1990–1999    cold-war       1947–1991      94  0.044  53.2  ended
 *   1990–1999    himalaya-uplift −50 Ma–2026   60  ~0     36.1  ongoing
 *   1990–1999    german-reunification 1990     78  1      78.0  point
 *   1943–1944    ww2            1939–1945      98  0.286  84.1  ongoing
 *   1943–1944    stalingrad     1942–1943      75  0.500  62.9  ended
 *   1939–1999    ww2            1939–1945      98  1      98.0  whole
 *   1200–1300    ottoman-empire 1299–1922      83  0.003  54.2  ongoing
 *
 * The 1990s case is the one the constants were chosen on: warming should still
 * make the decade's list (68.1 sits mid-table, above Maastricht at 66) without
 * outranking the decade's own headline events (reunification 78, apartheid 75),
 * and the Cold War — over in the first year of the window — should fall to the
 * bottom rather than lead it. The 1943 case is the other end of the same dial:
 * the war is only 29% inside that window but is still what 1943 is *about*, and
 * at 84.1 it stays ahead of D-Day (81), which is wholly inside it.
 */
export const COVERAGE_ONGOING = { floor: 0.6, k: 0.35 } as const
export const COVERAGE_ENDED = { floor: 0.45, k: 0.5 } as const

/** The multiplier itself. Pure; 1 for point events and for full containment. */
export function coveragePenalty(
  evStart: Year,
  evEnd: Year,
  start: Year,
  end: Year,
): number {
  // A selection with no width (a bare cursor) says nothing about coverage, and
  // reading one would penalise every spanning event to its floor at once.
  if (!(end > start)) return 1
  const coverage = coverageOf(evStart, evEnd, start, end)
  // "Ended" is decided by the selection reaching the event's end, which also
  // covers the event-wholly-inside case — where coverage is 1 and the choice of
  // constants cannot matter.
  const { floor, k } = end >= Math.max(evStart, evEnd) ? COVERAGE_ENDED : COVERAGE_ONGOING
  return floor + (1 - floor) * coverage ** k
}

/** Priority as the culling sees it: rank, discounted by how much of the event
 *  the selection actually holds. */
export const effectivePriority = (e: HistoricalEvent, start: Year, end: Year): number =>
  e.priority * coveragePenalty(e.start, e.end ?? e.start, start, end)

/* ------------------------------------------------------- viewport scoping */

/**
 * How far an area event reaches from its centroid, in degrees of arc.
 *
 * An area event is indexed as a point (its centroid) plus this radius, so a
 * plague whose centroid is off screen is still found when its footprint is on
 * it. The bounding circle is loose for a long thin ring, which costs a few
 * false positives in the grid and nothing in the answer — membership is tested
 * against the same circle either way, and the alternative (testing the polygon)
 * would pay for precision no one can see at pin scale.
 *
 * `paths` deliberately do NOT widen it, though they are geometry too. A route
 * is drawn only when its event is selected, and a selected pin is kept by the
 * store whatever the camera is doing (`EventIndex.admits` ignores the scope) —
 * so counting the route here would buy nothing on screen and cost a great deal:
 * a circumnavigation's radius is most of the planet, which would put its pin in
 * the top-N contest in *every* frame, at a spot the camera is not looking at.
 */
export function eventRadiusDeg(e: HistoricalEvent): number {
  if (!e.area?.length) return 0
  let max = 0
  for (const [lng, lat] of e.area) {
    const d = separationDeg(e.lat, e.lng, lat, lng)
    if (d > max) max = d
  }
  return max
}

/** Is this event inside the visible circle (footprint included)? */
export const inScope = (e: HistoricalEvent, scope: ViewportScope): boolean =>
  separationDeg(scope.lat, scope.lng, e.lat, e.lng) <= scope.radiusDeg + eventRadiusDeg(e)

/** Events in the time window, matching filters, top `cap` by effective priority. */
export function visibleEvents(
  events: HistoricalEvent[],
  start: Year,
  end: Year,
  filter: EventFilter = {},
  cap = 100,
  scope?: ViewportScope,
): HistoricalEvent[] {
  const byId = new Map<string, Item>(events.map((e) => [e.id, e]))
  return events
    .filter((e) => intersects(e, start, end))
    .filter((e) => !scope || inScope(e, scope))
    .filter((e) => passes(e, filter, byId))
    .map((e) => ({ e, s: effectivePriority(e, start, end) }))
    // Raw priority breaks a tie in the discounted score, which keeps this in
    // step with the index's scan order (see EventIndex.query).
    .sort((a, b) => b.s - a.s || b.e.priority - a.e.priority)
    .slice(0, cap)
    .map((x) => x.e)
}

/* ------------------------------------------------------------ query plans */

/**
 * Three ways to enumerate the same candidates. All produce the identical
 * answer; they differ only in what they touch to get there.
 *
 *  · `priority` — walk the pins best-first and stop when nothing unseen can
 *    still make the cut. Unbeatable when the window is wide, because the answer
 *    is then sitting at the front of the list; degenerates to a full scan when
 *    almost nothing matches, because the bound never rises.
 *  · `time`     — enumerate the span index's hits. Wins when the selection is
 *    narrow against a large corpus: a single year out of ten thousand events.
 *  · `space`    — enumerate the grid's cells. Wins when the camera is close:
 *    the frame holds a hundredth of the corpus and the time window is wide.
 */
export type QueryPlan = 'priority' | 'space' | 'time'

/**
 * Which plan to run, from three counts that are all O(log n) or already known.
 *
 * The model is crude on purpose — one multiplication per plan, because a
 * planner that costs more than the difference between the plans is a loss. It
 * assumes time and space membership are independent (they are not: history
 * happens in cities) and that hits are spread evenly through priority order
 * (they are not either). Both errors push the same way — the priority scan is
 * usually better than estimated — so the estimate is compared against a scan
 * cost that is deliberately not padded.
 */
export function chooseQueryPlan(o: {
  /** Pins in the index. */
  n: number
  cap: number
  /** Pins whose span meets the selection (exact, from the span index). */
  timeHits: number
  /** Pins in the cells the scope touches, or `n` when unscoped. */
  spaceCandidates: number
}): QueryPlan {
  const n = Math.max(1, o.n)
  const density = (o.timeHits / n) * (o.spaceCandidates / n)
  // how far the best-first scan must walk before `cap` survivors accumulate
  const scan = Math.min(n, (o.cap + 1) / Math.max(density, 1 / n))
  // the span index over-scans by the slack in each magnitude bucket; measured
  // on the real corpus and on the synthetic ones that is well under 2x
  const time = 2 * o.timeHits + 8
  const space = o.spaceCandidates + 8
  const best = Math.min(scan, time, space)
  return best === scan ? 'priority' : best === space ? 'space' : 'time'
}

/**
 * Query index for large item sets.
 *
 * It holds every item (so links, search and the panel can reach a person or a
 * concept) but queries only what can be pinned: real events plus the birth and
 * death points derived from each person.
 *
 * One canonical order runs through the whole thing: `byPriority`, best first.
 * It is the scan order of the cheapest plan, it is the tie-break in every
 * plan's result, and it is the identity a pin has in both auxiliary indexes —
 * `spans` and `geo` are built over exactly that array, so a hit from either is
 * a position in it. That is what lets three different enumerations produce the
 * same list to the last element (see `query`).
 */
export class EventIndex {
  readonly items: Item[]
  readonly byId: Map<string, Item>
  /**
   * The pins that are *not* in `byId`: the birth and death points derived from
   * each person, whose ids exist nowhere in the data.
   *
   * This used to be every pin, real ones included — a second map the size of
   * the corpus, holding what `byId` already held. At 68 000 items that copy
   * cost 10 ms of the build to answer a question `byId` can answer with one
   * extra `isEvent` check (see `pin`).
   */
  private derivedPins: Map<string, HistoricalEvent>
  private byPriority: HistoricalEvent[]
  /** Time spans of `byPriority`, by magnitude bucket (lib/queryIndex.ts). */
  private spans: SpanIndex
  /** Locations of `byPriority`, on a lat/lng grid; areas by centroid + radius. */
  private geo: GeoGrid
  /** id → items whose body links to it. Built once; see `backlinksTo`. */
  private backlinks = new Map<string, Item[]>()
  /**
   * Which plan the last query ran. Diagnostics only — the bench script reads
   * it, and a test asserts the planner picks what it claims to. Nothing in the
   * app behaves differently for it.
   */
  lastPlan: QueryPlan = 'priority'

  constructor(items: Item[]) {
    this.items = items
    // Loops rather than `new Map(items.map(…))`: the map-of-pairs form
    // allocates a two-element array per item and measured twice as slow at
    // 68 000 items, which at that size is 20 ms of the build spent on garbage.
    this.byId = new Map()
    for (const i of items) this.byId.set(i.id, i)
    const pins = pinnableEvents(items)
    this.derivedPins = new Map()
    for (const p of pins) if (p.derivedFrom) this.derivedPins.set(p.id, p)
    // Every derived pin sits at MINOR_PRIORITY, so within the minor tier the
    // rank of the *person* is the only thing left to sort on — which is what
    // makes ranking a life worth doing even though a life carries no pin of
    // its own: when minor pins are shown and the cap bites, Einstein's birth
    // survives and an unranked figure's does not.
    const rank = (e: HistoricalEvent) =>
      e.derivedFrom ? (this.byId.get(e.derivedFrom)?.priority ?? 0) : e.priority
    this.byPriority = [...pins].sort((a, b) => b.priority - a.priority || rank(b) - rank(a))
    // One pass fills the columns both indexes are built from. Building them
    // from arrays of little objects instead cost 17 ms per 68 000 events in
    // allocation alone — a sixth of the whole build budget, spent on garbage.
    const n = this.byPriority.length
    const starts = new Float64Array(n)
    const ends = new Float64Array(n)
    const lats = new Float64Array(n)
    const lngs = new Float64Array(n)
    const radii = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const e = this.byPriority[i]
      const s = e.start
      const f = e.end ?? s
      starts[i] = Math.min(s, f)
      ends[i] = Math.max(s, f)
      lats[i] = e.lat
      lngs[i] = e.lng
      radii[i] = eventRadiusDeg(e)
    }
    this.spans = SpanIndex.fromColumns(starts, ends)
    this.geo = GeoGrid.fromColumns(lats, lngs, radii)
    for (const i of items) {
      // Most items have no body at all, and running the link regex over an
      // empty string 68 000 times cost 20 ms of the build for no links.
      if (!i.body) continue
      for (const id of internalLinkIds(i.body)) {
        const list = this.backlinks.get(id)
        if (list) list.push(i)
        else this.backlinks.set(id, [i])
      }
    }
  }

  /**
   * Top `cap` pins in the span — and, when the camera is zoomed in past world
   * view, in the circle of ground it can see — ranked by *effective* priority:
   * rank times the partial-coverage penalty (see `coveragePenalty`).
   *
   * The budget is deliberately spent inside the scope rather than filtered
   * after it: a global top-30 filtered down to Europe would show whichever of
   * the world's thirty biggest events happened to be European, which at close
   * zoom is usually none of them. Running the same contest among the events on
   * screen is what makes zooming in reveal something.
   *
   * Whichever plan enumerates the candidates, the survivors are chosen by the
   * same bounded heap under the same total order (score, then canonical
   * position), so the three plans are interchangeable — and a test holds them
   * to that on random datasets, because a planner that could change the answer
   * would make the pins depend on the dataset's size.
   *
   * The `priority` plan's early exit is exact rather than heuristic: the
   * coverage penalty is a multiplier in (0, 1], so an event's discounted score
   * can never exceed its raw priority, and once `cap` hits are in hand and the
   * raw priority under the scan has fallen to the weakest of them, nothing
   * further down the list can displace anything.
   */
  query(
    start: Year,
    end: Year,
    filter: EventFilter = {},
    cap = 100,
    scope?: ViewportScope,
  ): HistoricalEvent[] {
    if (cap <= 0) return []
    const n = this.byPriority.length
    const timeHits = this.spans.countIntersecting(start, end)
    const spaceCandidates = scope ? this.geo.candidateCount(scope) : n
    const plan = chooseQueryPlan({ n, cap, timeHits, spaceCandidates })
    // The enumeration to fall back on, and what it will cost: both exact counts
    // rather than estimates, which is what makes the budget below meaningful.
    const spaceCost = scope ? spaceCandidates : Infinity
    const timeCost = 2 * timeHits
    const fallback: QueryPlan = spaceCost <= timeCost ? 'space' : 'time'
    const fallbackCost = Math.min(spaceCost, timeCost)

    const run = (chosen: QueryPlan): HistoricalEvent[] | undefined => {
      const top = new TopScored<HistoricalEvent>(cap)
      // The space plan's enumeration *is* the membership test, so only the
      // other two pay for one.
      const testScope = chosen === 'space' ? undefined : scope
      // `i` is a position in byPriority, which is both the tie-break and the
      // identity the auxiliary indexes hand back.
      const consider = (i: number) => {
        const e = this.byPriority[i]
        if (!intersects(e, start, end)) return
        if (testScope && !this.geo.contains(testScope, i)) return
        if (!passes(e, filter, this.byId)) return
        top.push(e, effectivePriority(e, start, end), i)
      }
      if (chosen === 'priority') {
        // How far the best-first scan may walk before the fallback is simply
        // the better bet. The planner's estimate of this scan is the one number
        // here that cannot be measured up front — it assumes hits are spread
        // evenly through priority order, and the coverage penalty makes that
        // wrong in exactly the case that hurts (a close camera over a busy
        // region, where the cap fills with discounted scores so the early exit
        // never fires). Rather than model that, the scan is given a budget the
        // size of its alternative and abandoned if it overruns: the answer is
        // the same either way, and the worst case is twice the better plan
        // instead of the 15 ms this used to cost at 100x.
        const limit = Math.min(n, Math.ceil(fallbackCost))
        let i = 0
        for (; i < limit; i++) {
          if (top.full && this.byPriority[i].priority <= top.worstScore) break
          consider(i)
        }
        if (i >= limit && limit < n) return undefined // overran: try the other one
      } else if (chosen === 'space' && scope) this.geo.forEach(scope, consider)
      else this.spans.forEach(start, end, consider)
      this.lastPlan = chosen
      return top.drain()
    }
    return run(plan) ?? run(fallback)!
  }

  /** The pin carrying an id — a real event, or one derived from a person. */
  pin(id: string): HistoricalEvent | undefined {
    const item = this.byId.get(id)
    // a person or a concept carries no pin of its own, and a derived id is in
    // neither the data nor `byId`
    if (item) return isEvent(item) ? item : undefined
    return this.derivedPins.get(id)
  }

  /**
   * The pin for `id`, if the timeline and the filters still admit it.
   *
   * This is what a *selection* is allowed to bypass, and the line is drawn
   * where user intent is: the cap and the camera are the app's judgement about
   * what will fit on screen, and an event the user has explicitly opened should
   * outrank both — losing the pin under the open panel is the app arguing with
   * a decision the user just made. The timeline window and the tag/parent
   * filters are the *user's own* statements about what to show, and overriding
   * those would be the same mistake in the other direction; both have hidden a
   * selected pin since long before this, and both still do.
   */
  admits(id: string, start: Year, end: Year, filter: EventFilter = {}): HistoricalEvent | undefined {
    const pin = this.pin(id)
    if (!pin || !intersects(pin, start, end)) return undefined
    return passes(pin, filter, this.byId) ? pin : undefined
  }

  /** Items whose body links to `id`. The other half of a two-way relation. */
  backlinksTo(id: string): Item[] {
    return this.backlinks.get(id) ?? []
  }
}

/* ------------------------------------------------------------------ search */

/**
 * Name-and-tag search over every loaded item — events, persons and concepts
 * alike — ranked by priority, which is to say by the ranking list.
 *
 * Priority stays the primary key: the list is the app's one statement about
 * what matters, and a search that quietly overrode it would be a second one.
 * Quality of match only breaks ties, where the list has nothing to say — a name
 * beginning with the query ahead of a name merely containing it, and either
 * ahead of a tag-only hit.
 */
export function searchItems(items: Item[], q: string, cap = 8): Item[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const scored: { item: Item; score: number }[] = []
  for (const i of items) {
    const at = i.name.toLowerCase().indexOf(needle)
    const score = at === 0 ? 2 : at > 0 ? 1 : i.tags.some((t) => t.includes(needle)) ? 0 : -1
    if (score >= 0) scored.push({ item: i, score })
  }
  return scored
    .sort((a, b) => b.item.priority - a.item.priority || b.score - a.score)
    .slice(0, cap)
    .map((s) => s.item)
}
