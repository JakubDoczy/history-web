import type { Year } from './time'
import type { HistoricalEvent } from './events'

/**
 * Events ship in era-sized chunk files under data/events/, described by a
 * manifest, so the dataset can grow to tens of thousands of entries without
 * growing the JS bundle or the first paint. The store fetches the spine
 * (top-priority events across all time, so the timeline is never empty) plus
 * whichever chunks the visible window touches.
 */
export interface ChunkMeta {
  file: string
  /** Actual coverage: min(start)..max(end) of the chunk's events. Chunks may overlap. */
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

/** Merge, id-deduplicated: spine events appear again in their era chunk. */
export function mergeEvents(base: HistoricalEvent[], add: HistoricalEvent[]): HistoricalEvent[] {
  const seen = new Set(base.map((e) => e.id))
  return [...base, ...add.filter((e) => !seen.has(e.id))]
}
