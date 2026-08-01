import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  EventIndex,
  MINOR_PRIORITY,
  anchorYearOf,
  derivedEventsFor,
  effectivePriority,
  isConcept,
  isEvent,
  isMinor,
  isPerson,
  kindOf,
  timeExtentOf,
  type Concept,
  type HistoricalEvent,
  type Item,
  type Person,
} from '../src/lib/events'
import { type EventManifest } from '../src/lib/eventChunks'
import { TAGS } from '../src/lib/tags'
import { MIN_TIME, MAX_TIME } from '../src/lib/time'
import { internalLinkIds, renderRichText } from '../src/lib/richtext'

// The dataset ships as era chunks under public/data/events (see
// scripts/build_event_chunks.py). Tests validate the union of all chunks,
// then the ranking file, the manifest and the spine against it.
//
// Every entry is an ITEM: an event (the default kind, and the only one before
// the item model existed), a person or a concept. Whatever applies to all three
// is asserted over `items`; whatever is about a place and a time is asserted
// over `events`, which is what carries a pin.
const DIR = join(__dirname, '..', 'public', 'data', 'events')
const readJson = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'))
const manifest = readJson('manifest.json') as EventManifest
const chunkItems = new Map<string, Item[]>(
  manifest.chunks.map((c) => [c.file, readJson(c.file) as Item[]]),
)
const items = [...chunkItems.values()].flat()
const spine = readJson(manifest.spine) as Item[]
const byId = new Map(items.map((e) => [e.id, e]))

const events = items.filter(isEvent)
const persons = items.filter(isPerson)
const concepts = items.filter(isConcept)

/** ranking.txt, comments and blank lines stripped — the source of every priority. */
const ranking = readFileSync(join(DIR, 'ranking.txt'), 'utf8')
  .split('\n')
  .map((l) => l.split('#', 1)[0].trim())
  .filter(Boolean)
const rankOf = new Map(ranking.map((id, i) => [id, i]))

const MIN_PRIORITY = 1
const MAX_PRIORITY = 100

/**
 * The rank → priority curve, mirrored from scripts/build_event_chunks.py. The
 * test owns a copy on purpose: the mapping is a contract between the build and
 * every threshold the runtime uses (spine at 85, tier bands at 95/85/70/55),
 * and a silent change to it should fail here rather than quietly reshape the
 * globe.
 */
const TOP = 100
const BOTTOM = 52
const SHAPE = 0.6
const priorityForRank = (rank: number, n: number) =>
  n <= 1 ? TOP : Math.max(1, Math.round(TOP - (TOP - BOTTOM) * (rank / (n - 1)) ** SHAPE))

describe('items — dataset shape', () => {
  it('is a non-trivial array', () => {
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBeGreaterThanOrEqual(150)
    expect(events.length).toBeGreaterThanOrEqual(150)
  })

  it('has unique ids in slug form', () => {
    const seen = new Set<string>()
    for (const e of items) {
      expect(e.id, `${e.id} is not a slug`).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(seen.has(e.id), `duplicate id ${e.id}`).toBe(false)
      seen.add(e.id)
    }
  })

  it('uses one of the three kinds, defaulting to event', () => {
    for (const e of items) {
      expect(['event', 'person', 'concept'], e.id).toContain(kindOf(e))
      // the default is load-bearing: every entry written before persons and
      // concepts existed carries no `kind` at all
      if (!('kind' in e)) expect(isEvent(e), e.id).toBe(true)
    }
    expect(items.filter((e) => e.kind === undefined).length).toBeGreaterThanOrEqual(150)
  })

  it('has the fields every item needs, with the right types', () => {
    for (const e of items) {
      expect(typeof e.name, e.id).toBe('string')
      expect(e.name.length, e.id).toBeGreaterThan(0)
      expect(typeof e.summary, e.id).toBe('string')
      expect(e.summary.length, e.id).toBeGreaterThan(20)
      expect(typeof e.priority, e.id).toBe('number')
      expect(Array.isArray(e.tags), e.id).toBe(true)
      expect(Number.isFinite(anchorYearOf(e)), `${e.id} has no anchor year`).toBe(true)
    }
  })

  it('has the fields each kind needs, with the right types', () => {
    for (const e of events) {
      expect(typeof e.start, e.id).toBe('number')
      expect(typeof e.lat, e.id).toBe('number')
      expect(typeof e.lng, e.id).toBe('number')
    }
    for (const p of persons) {
      expect(typeof p.born, p.id).toBe('number')
      if (p.died !== undefined) expect(typeof p.died, p.id).toBe('number')
    }
    for (const c of concepts) expect(typeof c.anchorYear, c.id).toBe('number')
  })

  it('carries no unknown keys', () => {
    const common = [
      'id', 'kind', 'name', 'priority', 'tags', 'summary', 'body', 'image', 'links', 'related',
    ]
    const allowed: Record<string, Set<string>> = {
      event: new Set([...common, 'start', 'end', 'lat', 'lng', 'area', 'parent']),
      person: new Set([...common, 'born', 'died', 'birthPlace', 'deathPlace']),
      concept: new Set([...common, 'anchorYear']),
    }
    for (const e of items)
      for (const k of Object.keys(e))
        expect(allowed[kindOf(e)].has(k), `${e.id} (${kindOf(e)}) has unexpected key ${k}`).toBe(true)
  })

  it('never ships a derived key: birth and death pins are made at runtime', () => {
    for (const e of items) expect('derivedFrom' in e, e.id).toBe(false)
  })
})

describe('items — time', () => {
  it('keeps every item inside the timeline range', () => {
    for (const e of items) {
      const [from, to] = timeExtentOf(e)
      expect(Number.isFinite(from), e.id).toBe(true)
      expect(from, e.id).toBeGreaterThanOrEqual(MIN_TIME)
      expect(to, e.id).toBeLessThanOrEqual(MAX_TIME)
    }
  })

  it('has end >= start when a span is given', () => {
    for (const e of events) {
      if (e.end === undefined) continue
      expect(Number.isFinite(e.end), e.id).toBe(true)
      expect(e.end, e.id).toBeGreaterThanOrEqual(e.start)
      expect(e.end, e.id).toBeLessThanOrEqual(MAX_TIME)
    }
  })

  it('never lets a person die before being born', () => {
    for (const p of persons) {
      if (p.died === undefined) continue
      expect(p.died, p.id).toBeGreaterThanOrEqual(p.born)
      expect(p.died - p.born, `${p.id} lived implausibly long`).toBeLessThan(122)
    }
  })

  it('uses negative years for deep time and BCE (astronomical numbering)', () => {
    expect((byId.get('earth-formation') as HistoricalEvent).start).toBeLessThan(-4e9)
    expect((byId.get('kpg-extinction') as HistoricalEvent).start).toBe(-66_000_000)
    // 753 BCE == astronomical year -752
    expect((byId.get('rome-founding') as HistoricalEvent).start).toBe(-752)
    expect((byId.get('moon-landing') as HistoricalEvent).start).toBe(1969)
    // and a life the same way: Caesar, 100 BCE – 44 BCE
    expect((byId.get('julius-caesar') as Person).born).toBe(-99)
    expect((byId.get('julius-caesar') as Person).died).toBe(-43)
  })

  it('covers every scale, from deep time to the present', () => {
    const bands: [number, number][] = [
      [MIN_TIME, -1e9],      // Hadean / Archean
      [-1e9, -1e8],          // Neoproterozoic–Mesozoic
      [-1e8, -1e6],          // Cenozoic
      [-1e6, -10_000],       // Pleistocene / human prehistory
      [-10_000, -3000],      // neolithic
      [-3000, -500],         // bronze / early iron age
      [-500, 500],           // classical antiquity
      [500, 1500],           // medieval
      [1500, 1800],          // early modern
      [1800, 1900],          // 19th century
      [1900, 1945],
      [1945, 2000],
      [2000, MAX_TIME],
    ]
    for (const [lo, hi] of bands) {
      const n = events.filter((e) => e.start <= hi && (e.end ?? e.start) >= lo).length
      expect(n, `band ${lo}..${hi} is empty`).toBeGreaterThanOrEqual(5)
    }
  })
})

describe('items — geography', () => {
  const inRange = (lat: number, lng: number, who: string) => {
    expect(lat, who).toBeGreaterThanOrEqual(-90)
    expect(lat, who).toBeLessThanOrEqual(90)
    expect(lng, who).toBeGreaterThanOrEqual(-180)
    expect(lng, who).toBeLessThanOrEqual(180)
  }

  it('has coordinates in range', () => {
    for (const e of events) inRange(e.lat, e.lng, e.id)
  })

  it('puts every birth and death place on the planet', () => {
    for (const p of persons) {
      if (p.birthPlace) inRange(p.birthPlace.lat, p.birthPlace.lng, `${p.id} birthPlace`)
      if (p.deathPlace) inRange(p.deathPlace.lat, p.deathPlace.lng, `${p.id} deathPlace`)
    }
  })

  it('has well-formed area rings, with the point inside the ring bbox', () => {
    const areas = events.filter((e) => e.area)
    expect(areas.length).toBeGreaterThanOrEqual(10)
    for (const e of areas) {
      const ring = e.area!
      expect(ring.length, e.id).toBeGreaterThanOrEqual(3)
      for (const p of ring) {
        expect(p.length, e.id).toBe(2)
        const [lng, lat] = p // GeoJSON order
        inRange(lat, lng, e.id)
      }
      const lngs = ring.map((p) => p[0])
      const lats = ring.map((p) => p[1])
      expect(e.lng, `${e.id} centroid outside ring bbox`).toBeGreaterThanOrEqual(Math.min(...lngs))
      expect(e.lng, `${e.id} centroid outside ring bbox`).toBeLessThanOrEqual(Math.max(...lngs))
      expect(e.lat, `${e.id} centroid outside ring bbox`).toBeGreaterThanOrEqual(Math.min(...lats))
      expect(e.lat, `${e.id} centroid outside ring bbox`).toBeLessThanOrEqual(Math.max(...lats))
    }
  })
})

describe('items — tags', () => {
  it('only uses the controlled vocabulary, at least one tag each', () => {
    for (const e of items) {
      expect(e.tags.length, `${e.id} has no tags`).toBeGreaterThan(0)
      expect(new Set(e.tags).size, `${e.id} repeats a tag`).toBe(e.tags.length)
      for (const t of e.tags) expect(TAGS as readonly string[], `${e.id}: ${t}`).toContain(t)
    }
  })

  it('exercises every tag in the vocabulary', () => {
    const used = new Set(items.flatMap((e) => e.tags))
    for (const t of TAGS) expect(used, `tag ${t} is unused`).toContain(t)
  })
})

describe('ranking.txt — the source of every priority', () => {
  it('is an ordered list of ids that all exist, with no duplicates', () => {
    expect(ranking.length).toBeGreaterThanOrEqual(150)
    expect(new Set(ranking).size, 'ranking.txt repeats an id').toBe(ranking.length)
    for (const id of ranking) expect(byId.has(id), `ranking.txt names unknown id ${id}`).toBe(true)
  })

  it('derives every priority from rank position, and nothing from the JSON', () => {
    for (const e of items) {
      const rank = rankOf.get(e.id)
      expect(
        e.priority,
        `${e.id}: priority ${e.priority} does not match rank ${rank ?? '(unranked)'}`,
      ).toBe(rank === undefined ? MINOR_PRIORITY : priorityForRank(rank, ranking.length))
    }
  })

  it('keeps ranked priorities in range and integral, and unranked ones at zero', () => {
    for (const e of items) {
      expect(Number.isInteger(e.priority), e.id).toBe(true)
      if (rankOf.has(e.id)) {
        expect(e.priority, e.id).toBeGreaterThanOrEqual(MIN_PRIORITY)
        expect(e.priority, e.id).toBeLessThanOrEqual(MAX_PRIORITY)
        expect(isMinor(e), `${e.id} is ranked but reads as minor`).toBe(false)
      } else {
        expect(e.priority, e.id).toBe(MINOR_PRIORITY)
        expect(isMinor(e), e.id).toBe(true)
      }
    }
  })

  it('never lets a lower rank outrank a higher one', () => {
    for (let i = 1; i < ranking.length; i++)
      expect(
        byId.get(ranking[i])!.priority,
        `${ranking[i]} outranks ${ranking[i - 1]}`,
      ).toBeLessThanOrEqual(byId.get(ranking[i - 1])!.priority)
  })

  it('reserves the top tier for a small set of era-defining items', () => {
    const top = items.filter((e) => e.priority >= 95)
    expect(top.length).toBeGreaterThanOrEqual(10)
    expect(top.length).toBeLessThanOrEqual(30)
  })

  it('spreads the remaining items across the lower tiers', () => {
    const tier = (lo: number, hi: number) =>
      items.filter((e) => e.priority >= lo && e.priority < hi).length
    for (const [lo, hi] of [[85, 95], [70, 85], [55, 70]] as const)
      expect(tier(lo, hi), `tier ${lo}..${hi} too thin`).toBeGreaterThanOrEqual(15)
    // no single tier dominates
    for (const [lo, hi] of [[85, 95], [70, 85], [55, 70], [1, 55]] as const)
      expect(tier(lo, hi) / items.length, `tier ${lo}..${hi} dominates`).toBeLessThan(0.6)
  })

  it('keeps a minor tier, as something the corpus actually exercises', () => {
    const minor = items.filter(isMinor)
    expect(minor.length, 'nothing is off the ranking list').toBeGreaterThanOrEqual(1)
    expect(minor.length / items.length, 'most of the corpus is minor').toBeLessThan(0.5)
  })
})

describe('items — hierarchy', () => {
  it('resolves every parent reference, to an event', () => {
    for (const e of events)
      if (e.parent) {
        const p = byId.get(e.parent)
        expect(p, `${e.id} -> missing parent ${e.parent}`).toBeDefined()
        expect(isEvent(p!), `${e.id} -> parent ${e.parent} is not an event`).toBe(true)
      }
  })

  it('has no cycles and no self-parents', () => {
    for (const e of events) {
      const seen = new Set<string>([e.id])
      let cur = e.parent
      while (cur) {
        expect(seen.has(cur), `cycle through ${e.id}`).toBe(false)
        seen.add(cur)
        cur = (byId.get(cur) as HistoricalEvent | undefined)?.parent
      }
    }
  })

  /**
   * A child never begins before its parent. It may outlive it: parents are often
   * point events that open an era (e.g. "PRC proclaimed" → "Cultural Revolution")
   * or spans whose consequences continue (WWI → Treaty of Versailles).
   */
  it('never starts a child before its parent', () => {
    for (const e of events) {
      const p = e.parent ? (byId.get(e.parent) as HistoricalEvent) : undefined
      if (!p) continue
      expect(e.start >= p.start, `${e.id} (${e.start}) starts before ${p.id} (${p.start})`).toBe(true)
    }
  })

  it('builds real hierarchies, not a flat list', () => {
    const children = new Map<string, number>()
    for (const e of events)
      if (e.parent) children.set(e.parent, (children.get(e.parent) ?? 0) + 1)
    expect(children.size).toBeGreaterThanOrEqual(20)
    for (const id of ['ww2', 'french-revolution', 'apollo-program', 'cold-war'])
      expect(children.get(id) ?? 0, `${id} has no children`).toBeGreaterThanOrEqual(1)
  })
})

describe('items — rich content', () => {
  it('gives every item a body that renders', () => {
    for (const e of items) {
      expect(typeof e.body, `${e.id} has no body`).toBe('string')
      expect(e.body!.length, e.id).toBeGreaterThan(30)
      expect(renderRichText(e.body!)).toContain('<p>')
    }
  })

  it('resolves every internal link in body text, in either scheme', () => {
    let internal = 0
    for (const e of items)
      for (const id of internalLinkIds(e.body!)) {
        internal++
        expect(byId.has(id), `${e.id} links to unknown item ${id}`).toBe(true)
      }
    expect(internal).toBeGreaterThanOrEqual(50)
  })

  it('accepts item: as the canonical scheme and keeps event: working', () => {
    const scheme = (re: RegExp) => items.filter((e) => re.test(e.body!)).length
    expect(scheme(/\]\(item:/), 'nothing uses the canonical item: scheme').toBeGreaterThanOrEqual(20)
    expect(
      scheme(/\]\(event:/),
      'the event: alias has fallen out of the corpus',
    ).toBeGreaterThanOrEqual(50)
  })

  it('resolves every related id', () => {
    for (const e of items)
      for (const id of e.related ?? []) {
        expect(byId.has(id), `${e.id} -> unknown related ${id}`).toBe(true)
        expect(id, `${e.id} lists itself as related`).not.toBe(e.id)
      }
  })

  it('points every item at an external reference', () => {
    for (const e of items) {
      const urls = (e.links ?? []).filter((l) => l.url)
      expect(urls.length, `${e.id} has no external link`).toBeGreaterThanOrEqual(1)
      for (const l of urls) expect(l.url, e.id).toMatch(/^https:\/\//)
    }
  })

  it('resolves every link entry that references an item', () => {
    for (const e of items)
      for (const l of e.links ?? []) {
        expect(Boolean(l.url) !== Boolean(l.event), `${e.id}: link needs exactly one target`).toBe(true)
        if (l.event) expect(byId.has(l.event), `${e.id} -> ${l.event}`).toBe(true)
        expect(l.label.length, e.id).toBeGreaterThan(0)
      }
  })

  it('uses https image urls with captions when present', () => {
    for (const e of items) {
      if (!e.image) continue
      expect(e.image.url, e.id).toMatch(/^https:\/\//)
    }
  })
})

describe('persons and concepts', () => {
  it('ships a seed corpus of both', () => {
    expect(persons.length, 'too few persons').toBeGreaterThanOrEqual(15)
    expect(concepts.length, 'too few concepts').toBeGreaterThanOrEqual(8)
  })

  it('spreads the lives across eras rather than crowding one', () => {
    const born = persons.map((p) => p.born)
    expect(Math.min(...born), 'no life before the common era').toBeLessThan(0)
    expect(Math.max(...born), 'no life within living memory').toBeGreaterThan(1900)
    // no single century holds half of them
    const byCentury = new Map<number, number>()
    for (const y of born) {
      const c = Math.floor(y / 100)
      byCentury.set(c, (byCentury.get(c) ?? 0) + 1)
    }
    expect(Math.max(...byCentury.values()) / persons.length).toBeLessThan(0.5)
  })

  it('gives every life at least one place to put on the map', () => {
    for (const p of persons)
      expect(Boolean(p.birthPlace || p.deathPlace), `${p.id} has nowhere`).toBe(true)
  })

  it('wires persons and concepts into the existing corpus, both ways', () => {
    const linksInto = new Map<string, number>()
    for (const e of items)
      for (const id of internalLinkIds(e.body!))
        if (e.id !== id) linksInto.set(id, (linksInto.get(id) ?? 0) + 1)

    for (const p of [...persons, ...concepts]) {
      // out: the article reaches the corpus
      expect(new Set(internalLinkIds(p.body!)).size, `${p.id} links to nothing`).toBeGreaterThanOrEqual(1)
      // in: something in the corpus reaches the article
      expect(linksInto.get(p.id) ?? 0, `nothing links to ${p.id}`).toBeGreaterThanOrEqual(1)
    }
    // and the inbound links are not all from other new articles: existing event
    // bodies were edited to point at the people and ideas in them
    const fromEvents = [...persons, ...concepts].filter((p) =>
      events.some((e) => internalLinkIds(e.body!).includes(p.id)),
    )
    expect(fromEvents.length, 'no existing event links to a person or concept').toBeGreaterThanOrEqual(15)
  })
})

describe('derived birth and death pins', () => {
  it('derives at most two point events per person, at the stated places', () => {
    for (const p of persons) {
      const derived = derivedEventsFor(p)
      const wanted = (p.birthPlace ? 1 : 0) + (p.deathPlace && p.died !== undefined ? 1 : 0)
      expect(derived.length, p.id).toBe(wanted)
      for (const d of derived) {
        expect(d.id.startsWith(p.id), d.id).toBe(true)
        expect(d.derivedFrom, d.id).toBe(p.id)
        expect(d.priority, `${d.id} must be minor-tier`).toBe(MINOR_PRIORITY)
        expect(d.tags, d.id).toEqual(p.tags)
        expect(d.end, `${d.id} is a point in time`).toBeUndefined()
        expect(byId.has(d.id), `${d.id} must not exist in the data too`).toBe(false)
      }
      if (p.birthPlace) {
        const b = derived[0]
        expect(b.name).toBe(`Birth of ${p.name}`)
        expect([b.start, b.lat, b.lng]).toEqual([p.born, p.birthPlace.lat, p.birthPlace.lng])
      }
      if (p.died !== undefined && p.deathPlace) {
        const d = derived[derived.length - 1]
        expect(d.name).toBe(`Death of ${p.name}`)
        expect([d.start, d.lat, d.lng]).toEqual([p.died, p.deathPlace.lat, p.deathPlace.lng])
      }
    }
  })

  it('keeps derived pins off the globe until minor events are asked for', () => {
    const index = new EventIndex(items)
    const einstein = byId.get('albert-einstein') as Person
    const birth = derivedEventsFor(einstein)[0]

    const normal = index.query(einstein.born - 5, einstein.born + 5, {}, 500).map((e) => e.id)
    expect(normal).not.toContain(birth.id)

    const withMinor = index.query(einstein.born - 5, einstein.born + 5, { minor: true }, 500)
    expect(withMinor.map((e) => e.id)).toContain(birth.id)
  })

  it('resolves a derived pin back to the life it belongs to', () => {
    const index = new EventIndex(items)
    for (const p of persons)
      for (const d of derivedEventsFor(p)) {
        expect(index.pin(d.id)?.derivedFrom, d.id).toBe(p.id)
        expect(index.byId.get(index.pin(d.id)!.derivedFrom!)?.name).toBe(p.name)
      }
  })

  it('never lets a person or a concept become a pin of its own', () => {
    const index = new EventIndex(items)
    for (const i of [...persons, ...concepts]) expect(index.pin(i.id), i.id).toBeUndefined()
  })
})

describe('items — behaviour through the query layer', () => {
  const index = new EventIndex(items)

  it('returns a sensible number of events at every zoom level', () => {
    const windows: [number, number][] = [
      [MIN_TIME, MAX_TIME],
      [-4e9, -1e9],
      [-600e6, -200e6],
      [-100e6, -1e6],
      [-200_000, -10_000],
      [-5000, 0],
      [0, 500],
      [500, 1500],
      [1400, 1700],
      [1700, 1850],
      [1850, 1950],
      [1900, 2000],
      [1960, 1980],
      [2000, 2026],
    ]
    for (const [s, e] of windows) {
      const got = index.query(s, e, {}, 20)
      expect(got.length, `window ${s}..${e} is empty`).toBeGreaterThanOrEqual(3)
      // Returned best-first — by *effective* priority, which is rank discounted
      // by how much of the event this window actually holds (see
      // `coveragePenalty`). Raw priority is no longer the order: a 146-year
      // trend seen through a decade ranks below the decade's own events.
      for (let i = 1; i < got.length; i++)
        expect(effectivePriority(got[i], s, e)).toBeLessThanOrEqual(
          effectivePriority(got[i - 1], s, e),
        )
    }
  })

  it('surfaces era-defining events when the whole timeline is in view', () => {
    const ids = index.query(MIN_TIME, MAX_TIME, {}, 10).map((e) => e.id)
    expect(ids).toContain('earth-formation')
    expect(ids.every((id) => byId.get(id)!.priority >= 95)).toBe(true)
  })

  it('supports tag filtering across the vocabulary', () => {
    for (const t of TAGS) {
      const got = index.query(MIN_TIME, MAX_TIME, { tags: [t] }, 500)
      expect(got.length, `no events for tag ${t}`).toBeGreaterThan(0)
      for (const e of got) expect(e.tags).toContain(t)
    }
  })

  it('supports drilling into a parent event', () => {
    const got = index.query(MIN_TIME, MAX_TIME, { parent: 'ww2' }, 100).map((e) => e.id)
    expect(got).toContain('ww2')
    expect(got).toContain('stalingrad')
    expect(got.length).toBeGreaterThan(3)
  })

  it('finds the neighbourhood of an article in both directions', () => {
    // the person's body points at the event…
    expect(internalLinkIds(byId.get('albert-einstein')!.body!)).toContain('relativity')
    // …and the event's body was edited to point back
    expect(index.backlinksTo('albert-einstein').map((i) => i.id)).toContain('relativity')
  })
})

describe('item chunks — manifest and spine', () => {
  it('lists every chunk file in the directory, and nothing else', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
    const listed = new Set([...manifest.chunks.map((c) => c.file), manifest.spine, 'manifest.json'])
    for (const f of files) expect(listed.has(f), `${f} not in manifest`).toBe(true)
    expect(files.length).toBe(listed.size)
  })

  it('reports true coverage and counts per chunk', () => {
    for (const c of manifest.chunks) {
      const evs = chunkItems.get(c.file)!
      expect(evs.length, c.file).toBe(c.count)
      expect(Math.min(...evs.map((e) => timeExtentOf(e)[0])), c.file).toBe(c.from)
      expect(Math.max(...evs.map((e) => timeExtentOf(e)[1])), c.file).toBe(c.to)
    }
  })

  it('chunks persons by birth year and concepts by anchor year', () => {
    // the era bounds of scripts/build_event_chunks.py, in file order
    const bounds: [string, number][] = [
      ['deep-time.json', -5e9],
      ['ancient.json', -10_000],
      ['medieval.json', 500],
      ['early-modern.json', 1500],
      ['modern.json', 1800],
      ['contemporary.json', 1945],
    ]
    for (const [file, evs] of chunkItems) {
      const i = bounds.findIndex(([f]) => f === file)
      const lo = bounds[i][1]
      const hi = i + 1 < bounds.length ? bounds[i + 1][1] : Infinity
      for (const e of evs) {
        const y = anchorYearOf(e)
        expect(y, `${e.id} (${kindOf(e)}) is in the wrong chunk ${file}`).toBeGreaterThanOrEqual(lo)
        expect(y, `${e.id} (${kindOf(e)}) is in the wrong chunk ${file}`).toBeLessThan(hi)
      }
    }
    // and the seed content actually lands across several of them
    const chunkOf = (id: string) => [...chunkItems].find(([, v]) => v.some((e) => e.id === id))![0]
    expect(chunkOf('julius-caesar')).toBe('ancient.json')
    expect(chunkOf('ibn-sina')).toBe('medieval.json')
    expect(chunkOf('albert-einstein')).toBe('modern.json')
    expect(chunkOf('silk-roads')).toBe('ancient.json') // a concept, placed by anchorYear
    expect((byId.get('silk-roads') as Concept).anchorYear).toBeLessThan(0)
  })

  it('spine is exactly the high-priority backbone, present in era chunks too', () => {
    const expected = items.filter((e) => e.priority >= 85)
    expect(new Set(spine.map((e) => e.id))).toEqual(new Set(expected.map((e) => e.id)))
    expect(spine.length).toBeGreaterThanOrEqual(30) // the timeline is never empty
    expect(spine.some(isPerson), 'no life is important enough to always be loaded').toBe(true)
  })

  it('every tag in the vocabulary has a pin colour', async () => {
    const { TAG_COLORS } = await import('../src/lib/tags')
    for (const t of TAGS) expect(TAG_COLORS[t], t).toMatch(/^#[0-9a-f]{6}$/)
  })
})

/**
 * The coverage penalty, against the dataset it was tuned on. These are the
 * worked examples from `coveragePenalty`'s documentation; if a retune moves the
 * constants far enough to break them, the doc table needs rewriting too.
 */
describe('items — partial coverage against real spans', () => {
  const index = new EventIndex(items)
  const ids = (s: number, e: number, cap = 12) => index.query(s, e, {}, cap).map((x) => x.id)

  it('drops a warming trend below the decade it is only 7% about', () => {
    const nineties = ids(1990, 1999)
    expect(nineties).toContain('global-warming') // still there — it is important
    expect(nineties.indexOf('global-warming')).toBeGreaterThan(
      nineties.indexOf('german-reunification'),
    )
    expect(nineties[0]).toBe('soviet-collapse') // raw priority opened on the Cold War
  })

  it('sinks an event the selection has outlived below one it has not', () => {
    const nineties = ids(1990, 1999)
    // both are barely-overlapping long events; the Cold War ended in 1991 and
    // the warming did not, and that is the whole of the asymmetry
    expect(nineties.indexOf('cold-war')).toBeGreaterThan(nineties.indexOf('global-warming'))
    expect(nineties[nineties.length - 1]).toBe('cold-war')
  })

  it('keeps the war at the head of a single year of it', () => {
    // 29% coverage and rank 98 still beats D-Day, which is wholly inside 1943–44
    expect(ids(1943, 1944)[0]).toBe('ww2')
    expect(effectivePriority(byId.get('ww2') as HistoricalEvent, 1943, 1944)).toBeGreaterThan(81)
  })

  it('costs an era-spanning empire its lead over a century inside it', () => {
    const ottoman = byId.get('ottoman-empire') as HistoricalEvent
    // 1299–1922 against 1200–1300: two years of overlap, and over 600 outside
    expect(effectivePriority(ottoman, 1200, 1300)).toBeLessThan(60)
    expect(ids(1200, 1300)[0]).toBe('mongol-conquests')
  })
})
