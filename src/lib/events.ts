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

/** Events in the time window, matching filters, top `cap` by priority. */
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
    .sort((a, b) => b.priority - a.priority)
    .slice(0, cap)
}

/**
 * Query index for large item sets.
 *
 * It holds every item (so links, search and the panel can reach a person or a
 * concept) but queries only what can be pinned: real events plus the birth and
 * death points derived from each person. Pins are pre-sorted by priority once,
 * so a query is a single scan with early exit after `cap` hits — no per-query
 * sort, and high-priority events are found first.
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

  query(start: Year, end: Year, filter: EventFilter = {}, cap = 100): HistoricalEvent[] {
    const out: HistoricalEvent[] = []
    for (const e of this.byPriority) {
      if (!intersects(e, start, end)) continue
      if (!passes(e, filter, this.byId)) continue
      out.push(e)
      if (out.length >= cap) break
    }
    return out
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
