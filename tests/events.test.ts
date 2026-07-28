import { describe, it, expect } from 'vitest'
import { visibleEvents, type HistoricalEvent } from '../src/lib/events'

const ev = (id: string, o: Partial<HistoricalEvent> = {}): HistoricalEvent => ({
  id, name: id, start: 0, lat: 0, lng: 0, priority: 50, tags: [], summary: '', ...o,
})

const data = [
  ev('ww2', { start: 1939, end: 1945, priority: 96, tags: ['war'] }),
  ev('stalingrad', { start: 1942, end: 1943, priority: 72, tags: ['war'], parent: 'ww2' }),
  ev('trinity', { start: 1945, priority: 82, tags: ['science', 'war'], parent: 'ww2' }),
  ev('moon', { start: 1969, priority: 90, tags: ['science'] }),
  ev('pangaea', { start: -335e6, end: -175e6, priority: 90, tags: ['geology'] }),
]

describe('visibleEvents', () => {
  it('keeps only events intersecting the window', () => {
    const ids = visibleEvents(data, 1940, 1950).map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['ww2', 'stalingrad', 'trinity']))
    expect(ids).not.toContain('moon')
    expect(ids).not.toContain('pangaea')
  })

  it('spanning events intersect even when window is inside them', () => {
    expect(visibleEvents(data, -300e6, -299e6).map((e) => e.id)).toEqual(['pangaea'])
  })

  it('culls by priority when over cap, sorted desc', () => {
    const out = visibleEvents(data, -1e9, 2100, {}, 2)
    expect(out.map((e) => e.id)).toEqual(['ww2', 'moon']) // 96, then 90 (stable)
  })

  it('tag filter matches any selected tag', () => {
    const ids = visibleEvents(data, 1900, 2000, { tags: ['science'] }).map((e) => e.id)
    expect(ids.sort()).toEqual(['moon', 'trinity'])
  })

  it('parent filter includes the root and all descendants', () => {
    const ids = visibleEvents(data, 1900, 2000, { parent: 'ww2' }).map((e) => e.id)
    expect(ids.sort()).toEqual(['stalingrad', 'trinity', 'ww2'])
  })

  it('filters combine (tags AND parent)', () => {
    const ids = visibleEvents(data, 1900, 2000, { tags: ['science'], parent: 'ww2' }).map((e) => e.id)
    expect(ids).toEqual(['trinity'])
  })
})
