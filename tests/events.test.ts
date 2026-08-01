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

/* ------------------------------------------------------------- items ----- */

import {
  MINOR_PRIORITY,
  anchorYearOf,
  derivedEventsFor,
  isConcept,
  isEvent,
  isMinor,
  isPerson,
  kindOf,
  pinnableEvents,
  searchItems,
  timeExtentOf,
  type Concept,
  type Item,
  type Person,
} from '../src/lib/events'

const einstein: Person = {
  id: 'einstein', kind: 'person', name: 'Albert Einstein', born: 1879, died: 1955,
  birthPlace: { lat: 48.4, lng: 9.99, label: 'Ulm' },
  deathPlace: { lat: 40.36, lng: -74.67, label: 'Princeton' },
  priority: 88, tags: ['science'], summary: '', body: 'see [relativity](item:relativity)',
}
const nowhere: Person = {
  id: 'nowhere', kind: 'person', name: 'No Place', born: 1500,
  priority: MINOR_PRIORITY, tags: ['culture'], summary: '',
}
const relativityIdea: Concept = {
  id: 'relativity-idea', kind: 'concept', name: 'Relativity', anchorYear: 1905,
  priority: 80, tags: ['science'], summary: '',
}

describe('item kinds', () => {
  it('treats a missing kind as an event, which is what the old data relies on', () => {
    const legacy = ev('legacy')
    expect(kindOf(legacy)).toBe('event')
    expect(isEvent(legacy)).toBe(true)
    expect(isPerson(einstein) && isConcept(relativityIdea)).toBe(true)
  })

  it('anchors each kind at the right year, and gives each its extent', () => {
    expect(anchorYearOf(ev('e', { start: 1066, end: 1087 }))).toBe(1066)
    expect(anchorYearOf(einstein)).toBe(1879)
    expect(anchorYearOf(relativityIdea)).toBe(1905)
    expect(timeExtentOf(ev('e', { start: 1066, end: 1087 }))).toEqual([1066, 1087])
    expect(timeExtentOf(einstein)).toEqual([1879, 1955])
    expect(timeExtentOf(nowhere)).toEqual([1500, 1500]) // no death year: a point
    expect(timeExtentOf(relativityIdea)).toEqual([1905, 1905])
  })

  it('calls anything off the ranking list minor', () => {
    expect(isMinor({ priority: MINOR_PRIORITY })).toBe(true)
    expect(isMinor({ priority: 1 })).toBe(false)
  })
})

describe('derivedEventsFor', () => {
  it('makes a minor birth and death pin from a life', () => {
    const [birth, death] = derivedEventsFor(einstein)
    expect([birth.name, birth.start, birth.lat, birth.priority, birth.derivedFrom]).toEqual([
      'Birth of Albert Einstein', 1879, 48.4, MINOR_PRIORITY, 'einstein',
    ])
    expect([death.name, death.start, death.lng]).toEqual(['Death of Albert Einstein', 1955, -74.67])
    expect(birth.tags).toEqual(einstein.tags) // so tag filtering and pin colour still work
  })

  it('makes no pin without a coordinate, rather than guessing one', () => {
    expect(derivedEventsFor(nowhere)).toEqual([])
    expect(derivedEventsFor({ ...einstein, deathPlace: undefined })).toHaveLength(1)
    expect(derivedEventsFor({ ...einstein, died: undefined })).toHaveLength(1) // birth only
  })

  it('pins events and persons, never concepts', () => {
    const ids = pinnableEvents([ev('a'), einstein, relativityIdea, nowhere]).map((e) => e.id)
    expect(ids).toEqual(['a', 'einstein--birth', 'einstein--death'])
  })
})

describe('the minor tier', () => {
  const data = [
    ev('ranked', { start: 1900, priority: 60 }),
    ev('unranked', { start: 1900, priority: MINOR_PRIORITY }),
  ]

  it('is hidden by default and shown on request, through both query paths', () => {
    for (const q of [
      (f: object) => visibleEvents(data, 1890, 1910, f).map((e) => e.id),
      (f: object) => new EventIndex(data).query(1890, 1910, f).map((e) => e.id),
    ]) {
      expect(q({})).toEqual(['ranked'])
      expect(q({ minor: true }).sort()).toEqual(['ranked', 'unranked'])
    }
  })

  it('orders derived pins by the rank of the person they came from', () => {
    const minor: Person = { ...einstein, id: 'minor', name: 'Minor Figure', priority: MINOR_PRIORITY }
    const index = new EventIndex([einstein, minor])
    const got = index.query(1870, 1890, { minor: true }, 10).map((e) => e.id)
    expect(got[0]).toBe('einstein--birth') // both pins are minor; the life's rank breaks the tie
  })
})

describe('searchItems', () => {
  const corpus: Item[] = [
    ev('ww2', { name: 'Second World War', priority: 98, tags: ['war'] }),
    einstein,
    relativityIdea,
    { ...nowhere, name: 'Obscure Person' },
  ]

  it('reaches every kind, not only events', () => {
    expect(searchItems(corpus, 'einstein').map((i) => i.id)).toEqual(['einstein'])
    expect(searchItems(corpus, 'relativity').map((i) => i.id)).toEqual(['relativity-idea'])
    expect(searchItems(corpus, 'obscure').map((i) => i.id)).toEqual(['nowhere'])
  })

  it('ranks by priority, so minor items come last', () => {
    const got = searchItems(corpus, 'e')
    for (let i = 1; i < got.length; i++)
      expect(got[i].priority).toBeLessThanOrEqual(got[i - 1].priority)
    expect(got[got.length - 1].id).toBe('nowhere')
  })

  it('prefers a name that starts with the query when priorities tie', () => {
    const tie: Item[] = [
      ev('a', { name: 'The Great War', priority: 50 }),
      ev('b', { name: 'War of the Roses', priority: 50 }),
    ]
    expect(searchItems(tie, 'war').map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('returns nothing for a blank query', () => {
    expect(searchItems(corpus, '   ')).toEqual([])
  })
})

describe('EventIndex backlinks', () => {
  it('finds what points at an item, which is the other half of a link', () => {
    const target = ev('relativity', { body: 'by [Einstein](item:einstein)' })
    const index = new EventIndex([einstein, target])
    expect(index.backlinksTo('einstein').map((i) => i.id)).toEqual(['relativity'])
    expect(index.backlinksTo('relativity').map((i) => i.id)).toEqual(['einstein'])
  })
})

import {
  COVERAGE_ENDED,
  COVERAGE_ONGOING,
  coverageOf,
  coveragePenalty,
  effectivePriority,
} from '../src/lib/events'

/**
 * The culling's answer to "this event is barely in the window": discount its
 * rank by how much of it the selection actually holds. The shape of the curve
 * matters more than any single number in it, so that is what is pinned here —
 * the constants are free to be retuned as long as these stay true.
 */
describe('partial-coverage penalty', () => {
  describe('coverage', () => {
    it('is the fraction of the event the selection holds, counting years as units', () => {
      expect(coverageOf(1939, 1945, 1939, 1945)).toBe(1) // wholly inside
      expect(coverageOf(1939, 1945, 1943, 1944)).toBeCloseTo(2 / 7, 12)
      expect(coverageOf(1880, 2026, 1990, 1999)).toBeCloseTo(10 / 147, 12)
    })

    // A year is a unit of time, not an instant: an event ending in 1943 and a
    // selection starting in 1943 share the whole of 1943, and `intersects`
    // already says so. Half-open arithmetic here would call that zero.
    it('gives a touching year real width, as intersection does', () => {
      expect(coverageOf(1942, 1943, 1943, 1944)).toBeCloseTo(0.5, 12)
      expect(coverageOf(1943, 1943, 1943, 1944)).toBe(1)
    })

    it('never leaves [0, 1]', () => {
      expect(coverageOf(1939, 1945, -1e9, 1e9)).toBe(1)
      expect(coverageOf(1939, 1945, 1800, 1810)).toBe(0)
    })
  })

  it('leaves point events alone, wherever the selection reaches', () => {
    for (const [s, e] of [[1969, 1969], [1900, 2000], [1969, 2026], [-1e9, 1969]] as const)
      expect(coveragePenalty(1969, 1969, s, e), `${s}..${e}`).toBe(1)
  })

  it('leaves an event wholly inside the selection alone', () => {
    expect(coveragePenalty(1939, 1945, 1900, 2000)).toBe(1)
    expect(coveragePenalty(-335e6, -175e6, -1e9, 2026)).toBe(1)
  })

  it('rises monotonically with coverage, in both cases', () => {
    for (const end of [1999, 2100]) {
      // widening the event around a fixed selection lowers coverage, and must
      // lower the factor with it — never raise it, never plateau
      let last = Infinity
      for (const width of [10, 20, 50, 100, 500, 5000]) {
        const f = coveragePenalty(1990 - width, 1990 + width, 1990, end)
        expect(f, `width ${width}, end ${end}`).toBeLessThan(last)
        last = f
      }
    }
  })

  // The asymmetry the product asked for: an event the selection has outlived is
  // worth less than one still running, at the same coverage.
  it('penalises an event that ended inside the selection harder than one still running', () => {
    for (const c of [0.01, 0.1, 0.3, 0.5, 0.9]) {
      const ended = COVERAGE_ENDED.floor + (1 - COVERAGE_ENDED.floor) * c ** COVERAGE_ENDED.k
      const ongoing = COVERAGE_ONGOING.floor + (1 - COVERAGE_ONGOING.floor) * c ** COVERAGE_ONGOING.k
      expect(ended, `coverage ${c}`).toBeLessThan(ongoing)
    }
    // and on real spans: the same 44-year event, seen from inside and from after
    const inside = coveragePenalty(1947, 1991, 1960, 1965)
    const after = coveragePenalty(1947, 1991, 1988, 1993)
    expect(after).toBeLessThan(inside)
  })

  it('meets at 1: full coverage is not a case distinction', () => {
    expect(coveragePenalty(1939, 1945, 1939, 1945)).toBe(1)
    expect(coveragePenalty(1939, 1945, 1930, 1960)).toBe(1)
  })

  it('says nothing about a selection with no width', () => {
    expect(coveragePenalty(1880, 2026, 1990, 1990)).toBe(1)
  })

  // The point of the floor and of k < 1: importance can still win. An era-long
  // event ten times the selection, ranked far above the local news, must not be
  // culled out of its own century.
  it('lets a much better event ten times longer than the selection still lead', () => {
    const long = ev('long', { start: 1900, end: 2000, priority: 98 })
    const local = ev('local', { start: 1950, priority: 70 })
    const [s, e] = [1950, 1960]
    expect(effectivePriority(long, s, e)).toBeGreaterThan(effectivePriority(local, s, e))
    // but it does lose ground — the discount is real, not decorative
    expect(effectivePriority(long, s, e)).toBeLessThan(long.priority * 0.85)
  })

  it('re-ranks the query, and only where coverage says it should', () => {
    const data = [
      ev('warming', { start: 1880, end: 2026, priority: 90 }),
      ev('cold-war', { start: 1947, end: 1991, priority: 94 }),
      ev('reunification', { start: 1990, priority: 78 }),
      ev('maastricht', { start: 1993, priority: 66 }),
    ]
    const index = new EventIndex(data)
    // raw priority would open on the Cold War, which was over in the first year
    expect(index.query(1990, 1999).map((e) => e.id)).toEqual([
      'reunification',
      'warming',
      'maastricht',
      'cold-war',
    ])
    // and a selection the Cold War is genuinely about still opens on it
    expect(index.query(1960, 1970)[0].id).toBe('cold-war')
  })

  it('agrees with the reference implementation when the penalty bites', () => {
    const data = [
      ev('a', { start: 1000, end: 2000, priority: 99 }),
      ev('b', { start: 1500, end: 1520, priority: 60 }),
      ev('c', { start: 1510, priority: 61 }),
      ev('d', { start: 1400, end: 1512, priority: 80 }),
      ev('e', { start: 1511, end: 1513, priority: 61 }),
    ]
    const index = new EventIndex(data)
    for (const cap of [1, 2, 3, 5])
      expect(index.query(1510, 1515, {}, cap).map((x) => x.id)).toEqual(
        visibleEvents(data, 1510, 1515, {}, cap).map((x) => x.id),
      )
  })
})
