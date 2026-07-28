import type { Year } from './time'

export interface HistoricalEvent {
  id: string
  name: string
  start: Year
  end?: Year // omitted = instantaneous
  lat: number
  lng: number
  /** Optional polygon [lat, lng][] for area events; lat/lng then acts as centroid. */
  area?: [number, number][]
  priority: number // higher = more important
  tags: string[]
  parent?: string // id of parent event
  summary: string
  /** Optional rich body (markdown subset, see lib/richtext.ts). */
  body?: string
  image?: { url: string; caption?: string }
  links?: { label: string; url?: string; event?: string }[]
}

export interface EventFilter {
  tags?: string[] // event must carry at least one
  parent?: string // event must be the parent itself or a descendant
}

const intersects = (e: HistoricalEvent, start: Year, end: Year) =>
  e.start <= end && (e.end ?? e.start) >= start

const isUnder = (e: HistoricalEvent, root: string, byId: Map<string, HistoricalEvent>) => {
  for (let cur: HistoricalEvent | undefined = e; cur; cur = cur.parent ? byId.get(cur.parent) : undefined)
    if (cur.id === root) return true
  return false
}

/** Events in the time window, matching filters, top `cap` by priority. */
export function visibleEvents(
  events: HistoricalEvent[],
  start: Year,
  end: Year,
  filter: EventFilter = {},
  cap = 100,
): HistoricalEvent[] {
  const byId = new Map(events.map((e) => [e.id, e]))
  return events
    .filter((e) => intersects(e, start, end))
    .filter((e) => !filter.tags?.length || e.tags.some((t) => filter.tags!.includes(t)))
    .filter((e) => !filter.parent || isUnder(e, filter.parent, byId))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, cap)
}
