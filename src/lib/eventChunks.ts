import type { Year } from './time'
import type { Item } from './events'

/**
 * Items ship in era-sized chunk files under data/events/, described by a
 * manifest, so the dataset can grow to tens of thousands of entries without
 * growing the JS bundle or the first paint. The store fetches the spine
 * (top-ranked items across all time, so the timeline is never empty) plus
 * whichever chunks the visible window touches.
 *
 * An item lands in a chunk by the year it is anchored at — an event's start, a
 * person's birth, a concept's `anchorYear` — so persons and concepts stream on
 * exactly the same path events always did.
 */
export interface ChunkMeta {
  file: string
  /** Actual coverage: the min..max time extent of the chunk's items. Chunks may overlap. */
  from: Year
  to: Year
  count: number
}

export interface EventManifest {
  spine: string
  chunks: ChunkMeta[]
}

/**
 * Chunk files whose coverage intersects the window, padded by a quarter of the
 * span each side so ordinary scrubbing hits chunks that are already loading.
 */
export function chunksFor(m: EventManifest, start: Year, end: Year): string[] {
  const pad = (end - start) * 0.25
  const s = start - pad
  const e = end + pad
  return m.chunks.filter((c) => c.from <= e && c.to >= s).map((c) => c.file)
}

/** Merge, id-deduplicated: spine items appear again in their era chunk. */
export function mergeEvents(base: Item[], add: Item[]): Item[] {
  const seen = new Set(base.map((e) => e.id))
  return [...base, ...add.filter((e) => !seen.has(e.id))]
}
