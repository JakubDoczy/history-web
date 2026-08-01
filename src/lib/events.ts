import type { Year } from './time'
import type { Ring } from './nations'
import { internalLinkIds } from './richtext'

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

/** Events in the time window, matching filters, top `cap` by effective priority. */
export function visibleEvents(
  events: HistoricalEvent[],
  start: Year,
  end: Year,
  filter: EventFilter = {},
  cap = 100,
): HistoricalEvent[] {
  const byId = new Map<string, Item>(events.map((e) => [e.id, e]))
  return events
    .filter((e) => intersects(e, start, end))
    .filter((e) => passes(e, filter, byId))
    .map((e) => ({ e, s: effectivePriority(e, start, end) }))
    // Raw priority breaks a tie in the discounted score, which keeps this in
    // step with the index's scan order (see EventIndex.query).
    .sort((a, b) => b.s - a.s || b.e.priority - a.e.priority)
    .slice(0, cap)
    .map((x) => x.e)
}

/**
 * Query index for large item sets.
 *
 * It holds every item (so links, search and the panel can reach a person or a
 * concept) but queries only what can be pinned: real events plus the birth and
 * death points derived from each person. Pins are pre-sorted by priority once,
 * so a query walks them best-first and can stop as soon as no unseen event can
 * still make the cut (see `query`).
 */
export class EventIndex {
  readonly items: Item[]
  readonly byId: Map<string, Item>
  /** Real + derived events, by pin id. A derived id is not in `byId`. */
  readonly pinsById: Map<string, HistoricalEvent>
  private byPriority: HistoricalEvent[]
  /** id → items whose body links to it. Built once; see `backlinksTo`. */
  private backlinks = new Map<string, Item[]>()

  constructor(items: Item[]) {
    this.items = items
    this.byId = new Map(items.map((e) => [e.id, e]))
    const pins = pinnableEvents(items)
    this.pinsById = new Map(pins.map((e) => [e.id, e]))
    // Every derived pin sits at MINOR_PRIORITY, so within the minor tier the
    // rank of the *person* is the only thing left to sort on — which is what
    // makes ranking a life worth doing even though a life carries no pin of
    // its own: when minor pins are shown and the cap bites, Einstein's birth
    // survives and an unranked figure's does not.
    const rank = (e: HistoricalEvent) =>
      e.derivedFrom ? (this.byId.get(e.derivedFrom)?.priority ?? 0) : e.priority
    this.byPriority = [...pins].sort((a, b) => b.priority - a.priority || rank(b) - rank(a))
    for (const i of items)
      for (const id of internalLinkIds(i.body ?? '')) {
        const list = this.backlinks.get(id)
        if (list) list.push(i)
        else this.backlinks.set(id, [i])
      }
  }

  /**
   * Top `cap` pins in the span, ranked by *effective* priority — rank times the
   * partial-coverage penalty (see `coveragePenalty`).
   *
   * The penalty is per-query, so the pre-sort by raw priority is no longer the
   * answer; it is still the scan order, and it still bounds the work. Because
   * the penalty is a multiplier in (0, 1], an event's discounted score can
   * never exceed its raw priority, so once `cap` hits are in hand and the raw
   * priority of the item under the scan has fallen to the weakest of them,
   * nothing further down the list can displace anything — that is an exact
   * early exit, not a heuristic. `prune` keeps the running set from growing
   * past 2·cap so the scan stays linear on a corpus where most events match.
   */
  query(start: Year, end: Year, filter: EventFilter = {}, cap = 100): HistoricalEvent[] {
    if (cap <= 0) return []
    const hits: { e: HistoricalEvent; s: number }[] = []
    let bound = -Infinity // weakest score among the best `cap` seen so far
    let full = false
    const prune = () => {
      // Stable, so equal scores keep scan order — which is priority order, and
      // then data order. `visibleEvents` sorts to the same total order.
      hits.sort((a, b) => b.s - a.s)
      hits.length = Math.min(hits.length, cap)
      bound = hits[hits.length - 1].s
      full = true
    }
    for (const e of this.byPriority) {
      if (full && e.priority <= bound) break
      if (!intersects(e, start, end)) continue
      if (!passes(e, filter, this.byId)) continue
      hits.push({ e, s: effectivePriority(e, start, end) })
      if (hits.length >= 2 * cap) prune()
    }
    hits.sort((a, b) => b.s - a.s)
    return hits.slice(0, cap).map((h) => h.e)
  }

  /** The pin carrying an id — a real event, or one derived from a person. */
  pin(id: string): HistoricalEvent | undefined {
    return this.pinsById.get(id)
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
