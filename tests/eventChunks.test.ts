import { describe, it, expect } from 'vitest'
import { chunksFor, mergeEvents, type EventManifest } from '../src/lib/eventChunks'
import { parseItem, type HistoricalEvent } from '../src/lib/events'
import { timeStart } from '../src/lib/time'

const m: EventManifest = {
  spine: 'spine.json',
  chunks: [
    { file: 'deep.json', from: -4.5e9, to: -10_000, count: 10 },
    { file: 'ancient.json', from: -10_000, to: 500, count: 10 },
    { file: 'modern.json', from: 1800, to: 2026, count: 10 },
  ],
}

const ev = (id: string, start = 0): HistoricalEvent =>
  parseItem({
    id, name: id, start, lat: 0, lng: 0, priority: 50, tags: ['war'], summary: 'x'.repeat(30),
  }) as HistoricalEvent

describe('chunksFor', () => {
  it('returns chunks intersecting the window', () => {
    expect(chunksFor(m, -5000, 400)).toEqual(['ancient.json'])
    expect(chunksFor(m, -20_000, 2000)).toEqual(['deep.json', 'ancient.json', 'modern.json'])
  })

  it('pads the window so scrubbing preloads neighbours', () => {
    // window 600..1700 doesn't touch modern (1800+), but the 25% pad does
    expect(chunksFor(m, 600, 1700)).toContain('modern.json')
    // ...while a narrow window far away still doesn't
    expect(chunksFor(m, 600, 700)).toEqual([])
  })

  it('finds long events from a window that only touches their tail', () => {
    // coverage `to` is max(end), so a chunk of old-but-ongoing events is found
    const long: EventManifest = {
      spine: 's',
      chunks: [{ file: 'holocene.json', from: -12_000, to: 2026, count: 1 }],
    }
    expect(chunksFor(long, 1900, 2000)).toEqual(['holocene.json'])
  })
})

describe('mergeEvents', () => {
  it('deduplicates by id, keeping the first copy', () => {
    const merged = mergeEvents([ev('a'), ev('b')], [ev('b', 99), ev('c')])
    expect(merged.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(timeStart(merged[1].time)).toBe(0) // spine copy wins; era copy is identical anyway
  })
})
