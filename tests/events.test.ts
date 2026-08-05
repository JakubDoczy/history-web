import { describe, it, expect, beforeEach } from 'vitest'
import { parseItem, visibleEvents, type HistoricalEvent, type RawEvent } from '../src/lib/events'
import { timeFrom, timeStart } from '../src/lib/time'

// Fixtures are written in the RAW shape — flat lat/lng/area/paths, as the data
// files carry them — and go through the parser, which is the only thing that
// makes an Item. That keeps the tests honest about the boundary: nothing in the
// app ever sees a hand-built item either.
const ev = (id: string, o: Partial<RawEvent> = {}): HistoricalEvent =>
  parseItem({
    id, name: id, start: 0, lat: 0, lng: 0, priority: 50, tags: [], summary: '', ...o,
  }) as HistoricalEvent

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

/* --------------------------------------------------- viewport-scoped culling */

import {
  chooseQueryPlan,
  featureOf,
  inScope,
  locationPoints,
  locationRadiusDeg,
  pointFeatures,
  pointsOf,
  type QueryPlan,
} from '../src/lib/events'
import { DEFAULT_DIRECTION } from '../src/lib/paths'

/**
 * LOCATION AS A COMPOSITION (see `EventLocation` in src/lib/events.ts).
 *
 * The flat fields on disk become one anchor and a list of variants, and the two
 * things worth asserting are the two the design rests on: the parser's
 * guarantees about that list (canonical order, at most one of each unique kind,
 * empty is empty), and that the folds over it are exhaustive.
 */
describe('the location composition', () => {
  it('composes the flat fields into features, in one canonical order', () => {
    const e = ev('all', {
      lat: 1, lng: 2,
      area: [[0, 0], [1, 1], [2, 0]],
      paths: [[[0, 0], [5, 5]]],
      points: [{ lat: 9, lng: 8, name: 'Oak Ridge' }, { lat: 7, lng: 6 }],
    })
    expect(e.location.anchor).toEqual({ lat: 1, lng: 2 })
    expect(e.location.features.map((f) => f.kind)).toEqual(['area', 'line', 'point', 'point'])
    expect(pointFeatures(e.location)).toEqual([
      { kind: 'point', at: { lat: 9, lng: 8 }, name: 'Oak Ridge' },
      { kind: 'point', at: { lat: 7, lng: 6 } },
    ])
  })

  /** Empty is empty: what every consumer's old `!!e.area?.length` test meant. */
  it('makes no feature at all from an empty ring, path list or point list', () => {
    const e = ev('bare', { area: [], paths: [], points: [] })
    expect(e.location.features).toEqual([])
    expect(featureOf(e.location, 'area')).toBeUndefined()
    expect(featureOf(e.location, 'line')).toBeUndefined()
    expect(pointFeatures(e.location)).toEqual([])
  })

  /** `direction` meant nothing without paths, and is now a field OF the line. */
  it('folds direction into the line feature and defaults it', () => {
    expect(featureOf(ev('a', { paths: [[[0, 0], [1, 1]]] }).location, 'line')!.direction).toBe(
      DEFAULT_DIRECTION,
    )
    expect(
      featureOf(ev('b', { paths: [[[0, 0], [1, 1]]], direction: 'twoway' }).location, 'line')!
        .direction,
    ).toBe('twoway')
    // …and a direction with no route to belong to is dropped rather than carried
    expect(ev('c', { direction: 'twoway' }).location.features).toEqual([])
  })

  it('finds a unique feature by kind, and does not pretend points are unique', () => {
    const e = ev('a', { area: [[0, 0], [1, 1], [2, 0]] })
    expect(featureOf(e.location, 'area')!.kind).toBe('area')
    expect(featureOf(e.location, 'line')).toBeUndefined()
  })

  describe('locationPoints — every coordinate, exhaustively', () => {
    it('starts at the anchor and folds every feature into it', () => {
      const e = ev('a', {
        lat: 1, lng: 2,
        area: [[10, 11]],
        paths: [[[20, 21], [22, 23]]],
        points: [{ lat: 31, lng: 30 }],
      })
      expect(locationPoints(e.location)).toEqual([
        [2, 1], [10, 11], [20, 21], [22, 23], [30, 31],
      ])
    })

    /**
     * The drawing is NOT part of the location — it is a picture of what happened
     * on it — but it is very much part of what the camera has to hold. D-Day is
     * the case: a pin and a plan across a coastline, with no footprint and no
     * route, so the plan is the only thing that says how big it is.
     */
    it('is the location alone; the drawing joins it in pointsOf', () => {
      const e = ev('d', {
        lat: 49.3, lng: -0.6,
        drawing: { layers: [{ type: 'marker', pos: [-1.6, 49.6] }] },
      })
      expect(locationPoints(e.location)).toEqual([[-0.6, 49.3]])
      expect(pointsOf(e)).toEqual([[-0.6, 49.3], [-1.6, 49.6]])
    })
  })
})

describe('locationRadiusDeg', () => {
  it('is zero for a point event', () => {
    expect(locationRadiusDeg(ev('p').location)).toBe(0)
  })
  it('is the furthest vertex of an area event from its centroid', () => {
    // ring is [lng, lat]; the furthest of these is 3° away along the meridian
    const area = ev('a', { lat: 0, lng: 0, area: [[0, 3], [1, 0], [0, -2]] })
    expect(locationRadiusDeg(area.location)).toBeCloseTo(3, 6)
  })
  /**
   * The two features that contribute NOTHING are the interesting half of the
   * fold: both draw only when the event is selected, and a selected pin is kept
   * whatever the camera is doing — so counting them would put a
   * circumnavigation's pin in the top-N contest in every frame, at a spot the
   * camera is not looking at.
   */
  it('gives a route and a secondary site no reach at all', () => {
    const route = ev('r', { lat: 0, lng: 0, paths: [[[0, 0], [170, 60]]] })
    const sites = ev('s', { lat: 0, lng: 0, points: [{ lat: 60, lng: 170 }] })
    expect(locationRadiusDeg(route.location)).toBe(0)
    expect(locationRadiusDeg(sites.location)).toBe(0)
  })
  it('lets a footprint reach into a scope its centroid is outside of', () => {
    const area = ev('a', { lat: 0, lng: 0, area: [[0, 5], [0, -5], [5, 0]] })
    const scope = { lat: 0, lng: 6, radiusDeg: 2 }
    expect(inScope(area, scope)).toBe(true)
    expect(inScope(ev('p'), scope)).toBe(false)
  })
})

describe('viewport-scoped queries', () => {
  /** Events scattered over real-ish clumps, so a scope holds some and not others. */
  const placed = (n: number, seed = 1): HistoricalEvent[] => {
    let s = seed
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    const hubs = [
      [48.85, 2.35], [51.5, -0.13], [41.9, 12.5], [35.7, 139.7], [-33.9, 151.2],
      [40.7, -74], [-1.3, 36.8], [55.75, 37.6], [28.6, 77.2], [-23.5, -46.6],
    ]
    return Array.from({ length: n }, (_, i) => {
      const [hLat, hLng] = hubs[i % hubs.length]
      const start = Math.floor(rand() * 3000) - 1000
      return ev(`e${i}`, {
        start,
        end: rand() < 0.3 ? start + Math.floor(rand() * 300) : undefined,
        priority: 1 + Math.floor(rand() * 99),
        lat: Math.max(-89, Math.min(89, hLat + (rand() - 0.5) * 20)),
        lng: hLng + (rand() - 0.5) * 20,
        tags: [['war', 'science', 'culture'][i % 3]],
      })
    })
  }

  const scopes = [
    { lat: 48.85, lng: 2.35, radiusDeg: 8 }, // Europe, close in
    { lat: 48.85, lng: 2.35, radiusDeg: 45 }, // half a hemisphere
    { lat: 35.7, lng: 139.7, radiusDeg: 2 }, // one city
    { lat: 89, lng: 0, radiusDeg: 20 }, // over the pole
    { lat: 0, lng: 180, radiusDeg: 30 }, // across the seam
  ]

  it('matches the reference implementation, scope by scope', () => {
    const data = placed(2000)
    const idx = new EventIndex(data)
    for (const scope of scopes)
      for (const [s, e, f] of [
        [-1000, 2100, {}],
        [1500, 1520, {}],
        [0, 1000, { tags: ['war'] }],
      ] as const)
        expect(idx.query(s, e, f, 30, scope).map((x) => x.id)).toEqual(
          visibleEvents(data, s, e, f, 30, scope).map((x) => x.id),
        )
  })

  it('gives the same answer whichever plan the planner picks', () => {
    // The three enumerations are interchangeable by design; if they were not,
    // the pins on screen would depend on how big the dataset happens to be.
    const data = placed(3000, 9)
    const idx = new EventIndex(data)
    const used = new Set<QueryPlan>()
    for (const scope of [undefined, ...scopes])
      for (const [s, e] of [[-1000, 2100], [1200, 1210], [1500, 1900], [-900, -880]] as const) {
        expect(idx.query(s, e, {}, 30, scope).map((x) => x.id)).toEqual(
          visibleEvents(data, s, e, {}, 30, scope).map((x) => x.id),
        )
        used.add(idx.lastPlan)
      }
    // and the matrix above really did exercise all three
    expect([...used].sort()).toEqual(['priority', 'space', 'time'])
  })

  it('surfaces regional events that lost the global contest', () => {
    // one global heavyweight per hub, and a crowd of local events in Europe
    const data = [
      ...Array.from({ length: 30 }, (_, i) =>
        ev(`world${i}`, { start: 1500, priority: 99, lat: -40 + i, lng: -120 + i * 4 }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        ev(`paris${i}`, { start: 1500, priority: 40 + i, lat: 48.8 + i * 0.01, lng: 2.3 }),
      ),
    ]
    const idx = new EventIndex(data)
    const world = idx.query(1400, 1600, {}, 30).map((e) => e.id)
    expect(world.some((id) => id.startsWith('paris'))).toBe(false)
    const zoomed = idx.query(1400, 1600, {}, 30, { lat: 48.85, lng: 2.35, radiusDeg: 5 })
    expect(zoomed.map((e) => e.id)).toEqual(
      // all ten, best first — the whole budget spent inside the frame
      Array.from({ length: 10 }, (_, i) => `paris${9 - i}`),
    )
  })

  it('is exactly the old query when no scope is given', () => {
    const data = placed(500, 4)
    const idx = new EventIndex(data)
    expect(idx.query(1000, 1600, {}, 30, undefined).map((e) => e.id)).toEqual(
      visibleEvents(data, 1000, 1600, {}, 30).map((e) => e.id),
    )
  })

  it('returns nothing when the scope is empty of events', () => {
    const idx = new EventIndex(placed(200, 6))
    expect(idx.query(-1000, 2100, {}, 30, { lat: -85, lng: 0, radiusDeg: 1 })).toEqual([])
  })
})

describe('EventIndex.admits — what a selection may override', () => {
  const data = [
    ev('paris', { start: 1789, end: 1799, lat: 48.85, lng: 2.35, priority: 80, tags: ['war'] }),
    ev('child', { start: 1789, lat: 0, lng: 0, priority: 10, parent: 'paris', tags: ['science'] }),
  ]
  const idx = new EventIndex(data)

  it('admits a pin the timeline still reaches, wherever the camera is', () => {
    // no scope argument at all: the camera is not this question's business
    expect(idx.admits('paris', 1700, 1800)?.id).toBe('paris')
  })

  it('refuses one the timeline no longer reaches', () => {
    expect(idx.admits('paris', 1900, 2000)).toBeUndefined()
  })

  it('refuses one the user has filtered away', () => {
    expect(idx.admits('paris', 1700, 1800, { tags: ['science'] })).toBeUndefined()
    expect(idx.admits('child', 1700, 1800, { parent: 'paris' })?.id).toBe('child')
    expect(idx.admits('child', 1700, 1800, { parent: 'child' })?.id).toBe('child')
    expect(idx.admits('paris', 1700, 1800, { parent: 'child' })).toBeUndefined()
  })

  it('refuses a minor pin while minor pins are hidden, and admits it when shown', () => {
    const withMinor = new EventIndex([ev('m', { start: 1789, priority: MINOR_PRIORITY })])
    expect(withMinor.admits('m', 1700, 1800)).toBeUndefined()
    expect(withMinor.admits('m', 1700, 1800, { minor: true })?.id).toBe('m')
  })

  it('has nothing to say about an id that carries no pin', () => {
    expect(idx.admits('nope', 0, 3000)).toBeUndefined()
  })
})

describe('chooseQueryPlan', () => {
  it('scans by priority when the window is wide — the answer is at the front', () => {
    expect(chooseQueryPlan({ n: 50_000, cap: 30, timeHits: 40_000, spaceCandidates: 50_000 })).toBe(
      'priority',
    )
  })
  it('walks the time index when a single year is asked of a huge corpus', () => {
    expect(chooseQueryPlan({ n: 50_000, cap: 30, timeHits: 20, spaceCandidates: 50_000 })).toBe(
      'time',
    )
  })
  it('walks the grid when the camera is close and the window is wide', () => {
    expect(chooseQueryPlan({ n: 50_000, cap: 30, timeHits: 45_000, spaceCandidates: 120 })).toBe(
      'space',
    )
  })
  it('never proposes to scan more than the corpus', () => {
    // a query that matches nothing must still cost at most one pass
    expect(chooseQueryPlan({ n: 1000, cap: 30, timeHits: 0, spaceCandidates: 1000 })).toBe('time')
  })
})

import { setActivePinia, createPinia } from 'pinia'
import { useEventStore } from '../src/stores/events'

describe('event search', () => {
  beforeEach(() => setActivePinia(createPinia()))
  it('matches names case-insensitively, ranked by priority', () => {
    const s = useEventStore()
    // the store starts empty now: data arrives in fetched chunks — RAW, which
    // is what `adopt` takes; it is the boundary that makes them items
    const raw = (id: string, o: Partial<RawEvent>): RawEvent => ({
      id, name: id, start: 0, lat: 0, lng: 0, priority: 50, tags: [], summary: '', ...o,
    })
    s.adopt([
      raw('great-war', { name: 'The Great War', priority: 90, tags: ['war'] }),
      raw('cold-war', { name: 'Cold War', priority: 80, tags: ['war', 'politics'] }),
      raw('warsaw-pact', { name: 'Warsaw Pact', priority: 60, tags: ['politics'] }),
      raw('unrelated', { name: 'Something else', priority: 99, tags: ['science'] }),
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
  isMinor,
  lifeMarkersFor,
  mapPinsOf,
  searchItems,
  timeExtentOf,
  touchesSpan,
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
  it('stamps a missing kind as an event, which is what the old data relies on', () => {
    // the raw entry says nothing about its kind; the parser is what decides
    const legacy = parseItem({
      id: 'legacy', name: 'legacy', start: 0, lat: 0, lng: 0, priority: 50, tags: [], summary: '',
    })
    expect(legacy.kind).toBe('event')
    expect([einstein.kind, relativityIdea.kind]).toEqual(['person', 'concept'])
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

  it('says whether a subject touches an interval, edges included', () => {
    const war = ev('e', { start: 1939, end: 1945 })
    expect(touchesSpan(war, 1939, 1945)).toBe(true)
    expect(touchesSpan(war, 1900, 1939)).toBe(true) // meeting at the start year
    expect(touchesSpan(war, 1945, 2000)).toBe(true) // and at the end year
    expect(touchesSpan(war, 1941, 1942)).toBe(true) // a band inside the event
    expect(touchesSpan(war, 1900, 1938)).toBe(false)
    expect(touchesSpan(war, 1946, 2000)).toBe(false)
    expect(touchesSpan(war, -300e6, -299e6)).toBe(false)
    // a life and an idea are spans and points in the same sense
    expect(touchesSpan(einstein, 1950, 1960)).toBe(true)
    expect(touchesSpan(relativityIdea, 1905, 1905)).toBe(true)
    expect(touchesSpan(relativityIdea, 1906, 2000)).toBe(false)
  })

  it('calls anything off the ranking list minor', () => {
    expect(isMinor({ priority: MINOR_PRIORITY })).toBe(true)
    expect(isMinor({ priority: 1 })).toBe(false)
  })
})

describe('lifeMarkersFor', () => {
  it('makes a minor birth and death pin from a life', () => {
    const [birth, death] = lifeMarkersFor(einstein)
    expect([birth.name, timeStart(birth.time), birth.location.anchor.lat, birth.priority, birth.of.id]).toEqual([
      'Birth of Albert Einstein', 1879, 48.4, MINOR_PRIORITY, 'einstein',
    ])
    expect([birth.kind, birth.moment]).toEqual(['life-marker', 'birth'])
    expect([death.name, timeStart(death.time), death.location.anchor.lng]).toEqual([
      'Death of Albert Einstein', 1955, -74.67,
    ])
    expect(birth.tags).toEqual(einstein.tags) // so tag filtering and pin colour still work
  })

  it('makes no pin without a coordinate, rather than guessing one', () => {
    expect(lifeMarkersFor(nowhere)).toEqual([])
    expect(lifeMarkersFor({ ...einstein, deathPlace: undefined })).toHaveLength(1)
    expect(lifeMarkersFor({ ...einstein, died: undefined })).toHaveLength(1) // birth only
  })

  it('pins events and persons, never concepts', () => {
    const ids = mapPinsOf([ev('a'), einstein, relativityIdea, nowhere]).map((e) => e.id)
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

import { buildRelations, type Item } from '../src/lib/events'

/**
 * The relation graph: three one-sided fields in the data become four maps read
 * in both directions, under one precedence order (containment > strong > weak).
 */
describe('buildRelations', () => {
  const item = (id: string, o: Partial<RawEvent> = {}): HistoricalEvent =>
    ev(id, { start: 1900, ...o })
  const build = (items: Item[]) => buildRelations(items, new Map(items.map((i) => [i.id, i])))

  it('materialises the inverse of a strong edge, so one side is enough', () => {
    const r = build([item('einstein', { strong: ['relativity'] }), item('relativity')])
    expect(r.strong.get('einstein')).toEqual(['relativity'])
    expect(r.strong.get('relativity')).toEqual(['einstein'])
  })

  it('does the same for weak, and keeps the two tiers apart', () => {
    const r = build([item('a', { strong: ['b'], weak: ['c'] }), item('b'), item('c')])
    expect(r.strong.get('a')).toEqual(['b'])
    expect(r.weak.get('a')).toEqual(['c'])
    expect(r.weak.get('c')).toEqual(['a'])
    expect(r.strong.get('c')).toBeUndefined()
  })

  it('dedupes an edge written from both sides', () => {
    const r = build([item('a', { strong: ['b'] }), item('b', { strong: ['a'] })])
    expect(r.strong.get('a')).toEqual(['b'])
    expect(r.strong.get('b')).toEqual(['a'])
  })

  it('never relates an item to itself, or to an id that is not loaded', () => {
    const r = build([item('a', { strong: ['a', 'ghost', 'b'] }), item('b')])
    expect(r.strong.get('a')).toEqual(['b'])
  })

  it('lets containment win: a parent is never also an association', () => {
    const r = build([
      item('war'),
      item('battle', { parent: 'war', strong: ['war'], weak: ['war'] }),
    ])
    expect(r.strong.get('battle')).toBeUndefined()
    expect(r.weak.get('battle')).toBeUndefined()
    expect(r.strong.get('war')).toBeUndefined()
    expect(r.children.get('war')!.map((e) => e.id)).toEqual(['battle'])
  })

  it('lets strong win over weak for the same pair', () => {
    const r = build([item('a', { strong: ['b'] }), item('b', { weak: ['a'] })])
    expect(r.strong.get('a')).toEqual(['b'])
    expect(r.weak.get('a')).toBeUndefined()
    expect(r.weak.get('b')).toBeUndefined()
  })

  it('orders children chronologically and associations best-first', () => {
    const r = build([
      item('war'),
      item('late', { parent: 'war', start: 1944, priority: 10 }),
      item('early', { parent: 'war', start: 1940, priority: 90 }),
      item('hub', { strong: ['small', 'big'] }),
      item('small', { priority: 20 }),
      item('big', { priority: 80 }),
    ])
    expect(r.children.get('war')!.map((e) => e.id)).toEqual(['early', 'late'])
    expect(r.strong.get('hub')).toEqual(['big', 'small'])
  })

  it('ignores a parent that is not loaded, rather than inventing a family', () => {
    const r = build([item('orphan', { parent: 'nowhere', strong: ['x'] }), item('x')])
    expect(r.children.get('nowhere')).toBeUndefined()
    expect(r.strong.get('orphan')).toEqual(['x'])
  })
})

describe('EventIndex relations', () => {
  const item = (id: string, o: Partial<HistoricalEvent> = {}): HistoricalEvent =>
    ev(id, { start: 1900, ...o })
  const index = new EventIndex([
    item('war', { start: 1939 }),
    item('operation', { start: 1941, parent: 'war' }),
    item('battle', { start: 1942, parent: 'operation', weak: ['aside'] }),
    item('treaty', { start: 1945, strong: ['war'] }),
    item('aside', { start: 1950 }),
  ])

  it('walks the parent chain innermost first', () => {
    expect(index.parentChain('battle').map((e) => e.id)).toEqual(['operation', 'war'])
    expect(index.parentChain('war')).toEqual([])
    expect(index.parentChain('nope')).toEqual([])
  })

  it('hands back direct children only', () => {
    expect(index.childrenOf('war').map((e) => e.id)).toEqual(['operation'])
    expect(index.childrenOf('operation').map((e) => e.id)).toEqual(['battle'])
    expect(index.childrenOf('battle')).toEqual([])
  })

  it('reads a strong edge from the side that did not declare it', () => {
    expect(index.strongOf('war').map((i) => i.id)).toEqual(['treaty'])
    expect(index.strongOf('treaty').map((i) => i.id)).toEqual(['war'])
  })

  it('reads weak edges the same way', () => {
    expect(index.weakOf('aside').map((i) => i.id)).toEqual(['battle'])
  })

  it('survives a parent cycle rather than hanging on it', () => {
    const cyclic = new EventIndex([
      item('a', { parent: 'b' }),
      item('b', { parent: 'a' }),
    ])
    // it stops the moment the walk revisits something, so `a` is not its own
    // ancestor and the chain is finite
    expect(cyclic.parentChain('a').map((e) => e.id)).toEqual(['b'])
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
      expect(coverageOf(timeFrom(1939, 1945), 1939, 1945)).toBe(1) // wholly inside
      expect(coverageOf(timeFrom(1939, 1945), 1943, 1944)).toBeCloseTo(2 / 7, 12)
      expect(coverageOf(timeFrom(1880, 2026), 1990, 1999)).toBeCloseTo(10 / 147, 12)
    })

    // A year is a unit of time, not an instant: an event ending in 1943 and a
    // selection starting in 1943 share the whole of 1943, and `intersects`
    // already says so. Half-open arithmetic here would call that zero.
    it('gives a touching year real width, as intersection does', () => {
      expect(coverageOf(timeFrom(1942, 1943), 1943, 1944)).toBeCloseTo(0.5, 12)
      expect(coverageOf(timeFrom(1943, 1943), 1943, 1944)).toBe(1)
    })

    it('never leaves [0, 1]', () => {
      expect(coverageOf(timeFrom(1939, 1945), -1e9, 1e9)).toBe(1)
      expect(coverageOf(timeFrom(1939, 1945), 1800, 1810)).toBe(0)
    })
  })

  it('leaves point events alone, wherever the selection reaches', () => {
    for (const [s, e] of [[1969, 1969], [1900, 2000], [1969, 2026], [-1e9, 1969]] as const)
      expect(coveragePenalty(timeFrom(1969, 1969), s, e), `${s}..${e}`).toBe(1)
  })

  it('leaves an event wholly inside the selection alone', () => {
    expect(coveragePenalty(timeFrom(1939, 1945), 1900, 2000)).toBe(1)
    expect(coveragePenalty(timeFrom(-335e6, -175e6), -1e9, 2026)).toBe(1)
  })

  it('rises monotonically with coverage, in both cases', () => {
    for (const end of [1999, 2100]) {
      // widening the event around a fixed selection lowers coverage, and must
      // lower the factor with it — never raise it, never plateau
      let last = Infinity
      for (const width of [10, 20, 50, 100, 500, 5000]) {
        const f = coveragePenalty(timeFrom(1990 - width, 1990 + width), 1990, end)
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
    const inside = coveragePenalty(timeFrom(1947, 1991), 1960, 1965)
    const after = coveragePenalty(timeFrom(1947, 1991), 1988, 1993)
    expect(after).toBeLessThan(inside)
  })

  it('meets at 1: full coverage is not a case distinction', () => {
    expect(coveragePenalty(timeFrom(1939, 1945), 1939, 1945)).toBe(1)
    expect(coveragePenalty(timeFrom(1939, 1945), 1930, 1960)).toBe(1)
  })

  it('says nothing about a selection with no width', () => {
    expect(coveragePenalty(timeFrom(1880, 2026), 1990, 1990)).toBe(1)
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
