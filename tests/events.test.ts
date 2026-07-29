import { describe, it, expect, beforeEach } from 'vitest'
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

import { EventIndex } from '../src/lib/events'

describe('EventIndex', () => {
  const randomEvents = (n: number): HistoricalEvent[] =>
    Array.from({ length: n }, (_, i) => {
      const start = Math.floor(Math.random() * 4000) - 2000
      return ev(`e${i}`, {
        start,
        end: Math.random() < 0.3 ? start + Math.floor(Math.random() * 200) : undefined,
        priority: Math.floor(Math.random() * 100),
        tags: [['war', 'science', 'culture'][i % 3]],
        parent: i > 0 && Math.random() < 0.1 ? `e${Math.floor(Math.random() * i)}` : undefined,
      })
    })

  it('matches the reference implementation on random data', () => {
    const data = randomEvents(1000)
    const idx = new EventIndex(data)
    for (const [s, e, f] of [
      [0, 500, {}],
      [-2000, 2100, { tags: ['war'] }],
      [-500, 500, { parent: 'e0' }],
      [100, 120, { tags: ['science', 'culture'] }],
    ] as const) {
      expect(idx.query(s, e, f, 50).map((x) => x.id)).toEqual(
        visibleEvents(data, s, e, f, 50).map((x) => x.id),
      )
    }
  })

  it('handles 50k events fast (perf smoke)', () => {
    const idx = new EventIndex(randomEvents(50_000))
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) idx.query(-2000 + i * 10, -1900 + i * 10, { tags: ['war'] })
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

import { setActivePinia, createPinia } from 'pinia'
import { useEventStore } from '../src/stores/events'

describe('event search', () => {
  beforeEach(() => setActivePinia(createPinia()))
  it('matches names case-insensitively, ranked by priority', () => {
    const s = useEventStore()
    // the store starts empty now: data arrives in fetched chunks
    s.adopt([
      ev('great-war', { name: 'The Great War', priority: 90, tags: ['war'] }),
      ev('cold-war', { name: 'Cold War', priority: 80, tags: ['war', 'politics'] }),
      ev('warsaw-pact', { name: 'Warsaw Pact', priority: 60, tags: ['politics'] }),
      ev('unrelated', { name: 'Something else', priority: 99, tags: ['science'] }),
    ])
    const r = s.search('war')
    expect(r.length).toBeGreaterThan(0)
    for (let i = 1; i < r.length; i++) expect(r[i].priority).toBeLessThanOrEqual(r[i - 1].priority)
  })
  it('returns nothing for blank query', () => {
    expect(useEventStore().search('   ')).toEqual([])
  })
})
