import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  EventIndex,
  MINOR_PRIORITY,
  anchorYearOf,
  derivedEventsFor,
  effectivePriority,
  geometryPointsOf,
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
import {
  MAX_SEGMENT_DEG,
  densifyPath,
  densifyPaths,
  directionOf,
  routePolyline,
  isGeoPath,
} from '../src/lib/paths'
import { drawingPoints, isDrawing, routeDrawingFor } from '../src/lib/drawing'
import { FIT_FOV, MAX_FIT_ALTITUDE, POINT_CAP_DEG, altitudeForCapDeg, focusTargetFor } from '../src/lib/geoFocus'
import { separationDeg } from '../src/lib/queryIndex'
import { viewSpanDeg, visibleSpanDeg } from '../src/lib/detailImagery'
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
      'id', 'kind', 'name', 'priority', 'tags', 'summary', 'body', 'image', 'links',
      'strong', 'weak',
    ]
    const allowed: Record<string, Set<string>> = {
      event: new Set([
        ...common,
        'start', 'end', 'lat', 'lng', 'area', 'paths', 'direction', 'drawing', 'parent',
      ]),
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

/**
 * Route geometry. The rules are the same three the build script enforces (see
 * `validate_paths` in scripts/build_event_chunks.py) plus the ones only the
 * corpus can answer: that the routes are actually there, that a pin stands on
 * the road it draws, and that the camera can be put somewhere that shows it.
 */
describe('items — path events', () => {
  const pathEvents = events.filter((e) => e.paths)

  it('ships a body of routes, on the events that are about going somewhere', () => {
    expect(pathEvents.length, 'too few path events').toBeGreaterThanOrEqual(6)
    for (const id of ['silk-road', 'slave-trade', 'magellan', 'zheng-he'])
      expect(
        pathEvents.map((e) => e.id),
        `${id} should draw its route`,
      ).toContain(id)
  })

  it('uses `paths` — always a list of routes — and never a bare `path`', () => {
    for (const e of items) expect('path' in e, `${e.id} uses the wrong field`).toBe(false)
    for (const e of pathEvents) {
      expect(Array.isArray(e.paths), e.id).toBe(true)
      expect(e.paths!.length, `${e.id} has an empty paths list`).toBeGreaterThanOrEqual(1)
    }
  })

  it('has at least two points per route, all of them on the planet', () => {
    for (const e of pathEvents)
      for (const [i, path] of e.paths!.entries()) {
        expect(path.length, `${e.id} path ${i}`).toBeGreaterThanOrEqual(2)
        expect(isGeoPath(path), `${e.id} path ${i} is not a route`).toBe(true)
        for (const p of path) {
          expect(p.length, `${e.id} path ${i}`).toBe(2)
          const [lng, lat] = p // GeoJSON order, as everywhere else
          expect(lat, `${e.id} path ${i}`).toBeGreaterThanOrEqual(-90)
          expect(lat, `${e.id} path ${i}`).toBeLessThanOrEqual(90)
          expect(lng, `${e.id} path ${i}`).toBeGreaterThanOrEqual(-180)
          expect(lng, `${e.id} path ${i}`).toBeLessThanOrEqual(180)
        }
      }
  })

  it('stands its pin on the route it draws', () => {
    // the pin is what a reader clicks to see the route, so it must not be
    // somewhere else entirely; densified, since a waypoint is not the road
    for (const e of pathEvents) {
      const nearest = Math.min(
        ...densifyPaths(e.paths!, 2)
          .flat()
          .map(([lng, lat]) => separationDeg(e.lat, e.lng, lat, lng)),
      )
      expect(nearest, `${e.id}'s pin is ${nearest.toFixed(1)}° off its own route`).toBeLessThan(8)
    }
  })

  it('is authored at waypoint fidelity, and densifies to a smooth arc', () => {
    for (const e of pathEvents) {
      const drawn = densifyPaths(e.paths!)
      for (const path of drawn)
        for (let i = 1; i < path.length; i++)
          expect(
            separationDeg(path[i - 1][1], path[i - 1][0], path[i][1], path[i][0]),
            `${e.id} has a segment the renderer would draw as a rhumb line`,
          ).toBeLessThanOrEqual(MAX_SEGMENT_DEG + 1e-9)
      // and densifying really did something: these are ocean crossings
      expect(drawn.flat().length).toBeGreaterThan(e.paths!.flat().length)
    }
  })

  it('can be framed by the camera: the fit holds the whole route, or admits it cannot', () => {
    for (const e of pathEvents) {
      const target = focusTargetFor(e)!
      const horizon = visibleSpanDeg(target.altitude) / 2
      const worst = Math.max(
        ...geometryPointsOf(e).map(([lng, lat]) => separationDeg(target.lat, target.lng, lat, lng)),
      )
      // A circumnavigation cannot be shown at once — half of it is behind the
      // planet — so the fit stops at world view rather than lying about it.
      if (worst > horizon) expect(target.altitude, `${e.id}`).toBe(MAX_FIT_ALTITUDE)
      // every route is wider than a point, so every fit backs off further than
      // the height a bare pin is flown to
      expect(target.altitude, `${e.id}`).toBeGreaterThan(altitudeForCapDeg(POINT_CAP_DEG))
    }
    expect(focusTargetFor(byId.get('magellan') as HistoricalEvent)!.altitude).toBe(MAX_FIT_ALTITUDE)
  })

  it("keeps the owner's example a point pin: Magellan is a place, the voyage is its route", () => {
    const magellan = byId.get('magellan') as HistoricalEvent
    expect(magellan.area, 'the circumnavigation is a route, not a region').toBeUndefined()
    expect(magellan.paths).toHaveLength(1)
    // the pin stands in the strait that carries the name
    expect(separationDeg(magellan.lat, magellan.lng, -53.5, -70.9)).toBeLessThan(2)
    // and the route goes right round: it must reach both the far Pacific and
    // the Indian Ocean, or it is not a circumnavigation
    const lngs = magellan.paths![0].map((p) => p[0])
    expect(Math.min(...lngs)).toBeLessThanOrEqual(-170)
    expect(Math.max(...lngs)).toBeGreaterThan(120)
  })

  it('lets one event carry both a footprint and its routes', () => {
    const trade = byId.get('slave-trade') as HistoricalEvent
    expect(trade.area, 'the Atlantic basin the system worked across').toBeDefined()
    expect(trade.paths, 'the three legs of the triangle').toHaveLength(3)
    // a triangle closes: the return leg ends where the outward one began
    const [outward, , homeward] = trade.paths!
    expect(homeward[homeward.length - 1]).toEqual(outward[0])
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

/**
 * The typed relation graph: `parent`, `strong`, `weak` (see `buildRelations` in
 * src/lib/events.ts). These are the corpus's half of the contract — the shape
 * the runtime is allowed to assume. The other half, that the index materialises
 * the inverse and applies the precedence order, is in tests/events.test.ts.
 */
describe('items — relations', () => {
  /** Every declared edge as an ordered pair, per field. */
  const declared = (field: 'strong' | 'weak') =>
    items.flatMap((e) => (e[field] ?? []).map((o) => [e.id, o] as const))
  const strongPairs = declared('strong')
  const weakPairs = declared('weak')
  const key = (a: string, b: string) => [a, b].sort().join('|')
  const strongKeys = new Set(strongPairs.map(([a, b]) => key(a, b)))
  const family = new Set(
    events.filter((e) => e.parent).flatMap((e) => [key(e.id, e.parent!)]),
  )

  it('has finished the migration: nothing still carries the old `related`', () => {
    for (const e of items) expect('related' in e, `${e.id} still has related`).toBe(false)
  })

  it('resolves every strong and weak id, and relates nothing to itself', () => {
    for (const [a, b] of [...strongPairs, ...weakPairs]) {
      expect(byId.has(b), `${a} -> unknown ${b}`).toBe(true)
      expect(b, `${a} relates to itself`).not.toBe(a)
    }
  })

  it('never lists the same id twice in one field', () => {
    for (const e of items)
      for (const field of ['strong', 'weak'] as const) {
        const ids = e[field] ?? []
        expect(new Set(ids).size, `${e.id}.${field} repeats an id`).toBe(ids.length)
      }
  })

  /**
   * Symmetric relations are authored on ONE side. Writing both is not wrong —
   * the index dedupes it — but it is the first step towards the two sides
   * disagreeing, so the corpus is held to the convention.
   */
  it('declares each symmetric edge from one side only', () => {
    for (const pairs of [strongPairs, weakPairs])
      for (const [a, b] of pairs)
        expect(
          pairs.some(([x, y]) => x === b && y === a),
          `${a} and ${b} both declare the relation — write it once`,
        ).toBe(false)
  })

  /** One pair, one relation: containment beats strong, strong beats weak. */
  it('never states a pair at two strengths at once', () => {
    for (const [a, b] of [...strongPairs, ...weakPairs])
      expect(family.has(key(a, b)), `${a} <-> ${b} is already parent/child`).toBe(false)
    for (const [a, b] of weakPairs)
      expect(strongKeys.has(key(a, b)), `${a} <-> ${b} is both strong and weak`).toBe(false)
  })

  /**
   * The point of the rework: the corpus is a graph, not a list of islands. Every
   * item is reachable from at least one other, and the strong tier is large
   * enough to be the backbone rather than a handful of special cases.
   */
  it('leaves no item unrelated to anything', () => {
    const degree = new Map<string, number>()
    const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1)
    for (const e of events) if (e.parent) (bump(e.id), bump(e.parent))
    for (const [a, b] of [...strongPairs, ...weakPairs]) (bump(a), bump(b))
    const orphans = items.filter((e) => !degree.has(e.id)).map((e) => e.id)
    expect(orphans, `${orphans.length} item(s) relate to nothing`).toEqual([])
  })

  it('carries a substantial graph in every tier', () => {
    expect(strongPairs.length).toBeGreaterThanOrEqual(300)
    expect(weakPairs.length).toBeGreaterThanOrEqual(150)
    expect(events.filter((e) => e.parent).length).toBeGreaterThanOrEqual(200)
  })

  /**
   * The upgrades the migration was for, spot-checked: a life and its signature
   * work, a concept and the event that carries it, a treaty and the war it
   * ended. Direction is not asserted — these are symmetric, and which side
   * holds the array is an authoring choice.
   */
  it('binds the obvious pairs strongly', () => {
    for (const [a, b] of [
      ['albert-einstein', 'relativity'],
      ['theory-of-relativity', 'relativity'],
      ['charles-darwin', 'origin-species'],
      ['isaac-newton', 'newton'],
      ['johannes-gutenberg', 'printing-press'],
      ['napoleon-bonaparte', 'waterloo'],
      ['abraham-lincoln', 'emancipation'],
      ['nelson-mandela', 'apartheid-end'],
      ['versailles', 'ww2'], // the treaty and the war it seeded
      ['peace-augsburg', 'westphalia'],
      ['temujin-genghis-khan', 'genghis-khan'],
      ['global-internet', 'www'],
    ])
      expect(strongKeys.has(key(a, b)), `${a} <-> ${b} is not strong`).toBe(true)
  })

  it('gives every battle a war to be part of', () => {
    for (const id of ['stalingrad', 'waterloo', 'gettysburg', 'somme', 'agincourt', 'zama',
      'kiev-pocket', 'battle-plassey'])
      expect((byId.get(id) as HistoricalEvent).parent, `${id} has no parent`).toBeTruthy()
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

  it('points every item at an external reference', () => {
    for (const e of items) {
      const urls = (e.links ?? []).filter((l) => l.url)
      expect(urls.length, `${e.id} has no external link`).toBeGreaterThanOrEqual(1)
      for (const l of urls) expect(l.url, e.id).toMatch(/^https:\/\//)
    }
  })

  /**
   * "Read more" points *out* of the corpus. An entry aimed at another item is
   * how a relation used to be smuggled into the strip; there are now three
   * typed fields for that, and the sections that render them sit above it.
   */
  it('keeps the read-more strip external, with a label and a url on every entry', () => {
    for (const e of items)
      for (const l of e.links ?? []) {
        expect('event' in l, `${e.id}: a read-more link points at an item — relate it instead`).toBe(false)
        expect(l.url, `${e.id}: link needs a url`).toBeTruthy()
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

  it('reads the real corpus through the relation maps, both ways', () => {
    // Barbarossa's parts, chronological — and what focus mode pins
    expect(index.childrenOf('barbarossa').map((e) => e.id)).toEqual([
      'minsk-pocket', 'smolensk-1941', 'kiev-pocket', 'moscow-1941', 'leningrad-siege',
    ])
    // …reached from inside, the chain out to the war
    expect(index.parentChain('kiev-pocket').map((e) => e.id)).toEqual(['barbarossa', 'ww2'])
    // a strong pair navigates from the side that never declared it
    expect(byId.get('ww2')!.strong ?? []).not.toContain('versailles')
    expect(index.strongOf('ww2').map((i) => i.id)).toContain('versailles')
    expect(index.strongOf('versailles').map((i) => i.id)).toContain('ww2')
    // a life and the article about its work, both ways
    expect(index.strongOf('relativity').map((i) => i.id)).toContain('albert-einstein')
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

/**
 * ONE-WAY vs TWO-WAY. The field is optional and defaults to `oneway`, but the
 * corpus states it on every path event on purpose: the eight drawn routes are
 * the whole population, they are the exemplars a new one gets authored against,
 * and "the author thought about it" is not something a default can record.
 */
describe('items — route direction', () => {
  const pathEvents = events.filter((e) => e.paths)

  it('declares a direction on every drawn route', () => {
    for (const e of pathEvents)
      expect(['oneway', 'twoway'], `${e.id} has no direction`).toContain(directionOf(e))
    for (const e of pathEvents) expect(e.direction, `${e.id} leaves it to the default`).toBeDefined()
  })

  it('never puts a direction on an event with no route to give it one', () => {
    for (const e of events) if (!e.paths) expect(e.direction, e.id).toBeUndefined()
  })

  it('calls the trade networks two-way and the voyages one-way', () => {
    const dir = (id: string) => directionOf(byId.get(id) as HistoricalEvent)
    // carried goods both ways for centuries; an arrow on either would be a lie
    expect(dir('silk-road')).toBe('twoway')
    expect(dir('manila-galleon')).toBe('twoway')
    // voyages, and a triangle that circulated one way round
    for (const id of ['magellan', 'columbus', 'da-gama', 'dias', 'zheng-he', 'slave-trade'])
      expect(dir(id), id).toBe('oneway')
  })

  it('gives every route a route layer carrying its own direction', () => {
    for (const e of pathEvents) {
      const d = routeDrawingFor(e)!
      const routes = d.layers.filter((l) => l.type === 'route')
      expect(routes.length, e.id).toBe(1)
      expect((routes[0] as { paths: unknown[] }).paths.length, e.id).toBe(e.paths!.length)
      expect((routes[0] as { direction?: string }).direction, e.id).toBe(directionOf(e))
      // the whole drawing is the route: ports are pixels the renderer draws, not
      // degree-sized glyphs generated here
      expect(d.layers.every((l) => l.type === 'route'), e.id).toBe(true)
      expect(isDrawing(d), e.id).toBe(true)
      // and the camera can still be framed on it — `geometryPointsOf` reads the
      // drawing, so every authored waypoint has to be reachable through it
      const pts = drawingPoints(d)
      expect(pts.length, e.id).toBe(e.paths!.flat().length)
    }
  })

  it('smooths every shipped route without sailing it onto land', () => {
    // The redesign puts a Catmull-Rom curve through the authored waypoints, and
    // the risk that buys is a spline bowing past a waypoint an author placed to
    // clear a cape. Measured over the whole corpus the worst excursion is 0.42°
    // (46 km, in the Java Sea on Zheng He's track); a degree and a half is the
    // point at which a bow would start putting an ocean leg on a coastline.
    for (const e of pathEvents) {
      for (const path of e.paths!) {
        const authored = densifyPath(path, 0.25)
        for (const p of routePolyline(path)) {
          const off = Math.min(
            ...authored.map(([lng, lat]) => separationDeg(p[1], p[0], lat, lng)),
          )
          expect(off, `${e.id} bows ${off.toFixed(2)}° off its own waypoints`).toBeLessThan(1.5)
        }
      }
    }
  })
})

/**
 * BATTLE PLANS. The build script validates the shape (see `validate_drawing` in
 * scripts/build_event_chunks.py); what only the corpus can answer is whether the
 * plans are *about* the events they hang on — that the geometry is in the right
 * theatre, at the right scale, and that the camera can frame it.
 */
describe('items — drawings', () => {
  const drawn = events.filter((e) => e.drawing)

  it('ships the exemplars', () => {
    expect(drawn.map((e) => e.id)).toEqual(expect.arrayContaining(['barbarossa', 'd-day']))
  })

  it('is a valid drawing wherever one is present, and absent everywhere else', () => {
    for (const e of drawn) expect(isDrawing(e.drawing), `${e.id}`).toBe(true)
    for (const i of items) if (!isEvent(i)) expect('drawing' in i, i.id).toBe(false)
  })

  it('keeps every drawn coordinate on the planet and in the right order', () => {
    for (const e of drawn)
      for (const [lng, lat] of drawingPoints(e.drawing)) {
        expect(Math.abs(lng), `${e.id} lng`).toBeLessThanOrEqual(180)
        expect(Math.abs(lat), `${e.id} lat`).toBeLessThanOrEqual(90)
      }
  })

  it('draws where the event happened: every layer near the pin', () => {
    for (const e of drawn) {
      const worst = Math.max(
        ...drawingPoints(e.drawing).map(([lng, lat]) => separationDeg(e.lat, e.lng, lat, lng)),
      )
      // a theatre, not a hemisphere — if a drawing is further from its own pin
      // than this, a coordinate has been swapped
      expect(worst, `${e.id} draws ${worst.toFixed(1)}° from its own pin`).toBeLessThan(25)
    }
  })

  it('uses each of the four kinds somewhere, so the schema is exercised', () => {
    const kinds = new Set(drawn.flatMap((e) => e.drawing!.layers.map((l) => l.type)))
    for (const k of ['frontline', 'thrust', 'marker', 'label'])
      expect(kinds, `no drawing uses a ${k}`).toContain(k)
  })

  it('can be framed by the camera, and the plan fills the frame rather than a corner', () => {
    for (const e of drawn) {
      const target = focusTargetFor(e)!
      const half = visibleSpanDeg(target.altitude) / 2
      const pts = drawingPoints(e.drawing)
      const worst = Math.max(
        ...pts.map(([lng, lat]) => separationDeg(target.lat, target.lng, lat, lng)),
      )
      expect(worst, `${e.id} does not fit the fit`).toBeLessThanOrEqual(half + 1e-9)
      // …and is not lost in it. Measured against the FRAME, not the horizon:
      // close in the two differ by an order of magnitude, and it is the frame
      // the reader is looking at.
      const frameHalf = viewSpanDeg(target.altitude, FIT_FOV) / 2
      expect(worst / frameHalf, `${e.id} is a smudge in its own frame`).toBeGreaterThan(0.3)
    }
  })

  it("draws Barbarossa's 1941: two fronts, three army groups, the pockets", () => {
    const b = byId.get('barbarossa') as HistoricalEvent
    const layers = b.drawing!.layers
    const fronts = layers.filter((l) => l.type === 'frontline')
    const thrusts = layers.filter((l) => l.type === 'thrust')
    expect(fronts, 'the June border and the December high-water mark').toHaveLength(2)
    expect(thrusts, 'Army Groups North, Centre and South').toHaveLength(3)

    // The June 22 line is the 1939 partition border: it runs from the Baltic to
    // the Black Sea, and stays west of the December one at every latitude.
    const june = (fronts[0] as { paths: [number, number][][] }).paths[0]
    const dec = (fronts[1] as { paths: [number, number][][] }).paths[0]
    expect(Math.max(...june.map((p) => p[1]))).toBeGreaterThan(55) // Baltic
    expect(Math.min(...june.map((p) => p[1]))).toBeLessThan(46) // the Danube delta
    expect(Math.max(...june.map((p) => p[0]))).toBeLessThan(Math.max(...dec.map((p) => p[0])))
    // the December line reaches the Moscow suburbs and no further
    expect(Math.max(...dec.map((p) => p[0]))).toBeGreaterThan(38)
    expect(Math.max(...dec.map((p) => p[0]))).toBeLessThan(41)

    // each thrust starts on the June line and ends deep inside the USSR
    for (const t of thrusts as { path: [number, number][]; label?: string }[]) {
      expect(t.path[0][0], `${t.label} starts too far east`).toBeLessThan(24)
      expect(t.path[t.path.length - 1][0], `${t.label} stops too soon`).toBeGreaterThan(29)
    }
    // Leningrad, Moscow, Rostov — the three objectives, north to south
    const tips = (thrusts as { path: [number, number][] }[]).map((t) => t.path[t.path.length - 1])
    expect(separationDeg(tips[0][1], tips[0][0], 59.94, 30.31)).toBeLessThan(1.5)
    expect(separationDeg(tips[1][1], tips[1][0], 55.75, 37.62)).toBeLessThan(1.5)
    expect(separationDeg(tips[2][1], tips[2][0], 47.24, 39.72)).toBeLessThan(1.5)

    const marks = layers.filter((l) => l.type === 'marker') as { label?: string }[]
    for (const pocket of ['Minsk', 'Smolensk', 'Kiev'])
      expect(marks.map((m) => m.label ?? '').join(' '), `${pocket} pocket`).toContain(pocket)
  })

  it('gives Barbarossa a footprint that is the 1941 theatre, not all of Russia', () => {
    const b = byId.get('barbarossa') as HistoricalEvent
    // the front never reached the Urals, let alone Kamchatka; a footprint that
    // said otherwise framed the drawing at world view
    expect(Math.max(...b.area!.map((p) => p[0]))).toBeLessThan(45)
    expect(focusTargetFor(b)!.altitude).toBeLessThan(0.5)
  })

  it('draws Normandy on the beaches: five landings between the Cotentin and the Orne', () => {
    const d = byId.get('d-day') as HistoricalEvent
    const layers = d.drawing!.layers
    const thrusts = layers.filter((l) => l.type === 'thrust') as {
      path: [number, number][]
      label?: string
    }[]
    expect(thrusts, 'Utah, Omaha, Gold, Juno, Sword').toHaveLength(5)
    for (const beach of ['Utah', 'Omaha', 'Gold', 'Juno', 'Sword'])
      expect(thrusts.map((t) => t.label), beach).toContain(beach)
    // every assault comes from the sea (north) onto the coast
    for (const t of thrusts) {
      const from = t.path[0]
      const to = t.path[t.path.length - 1]
      expect(from[1], `${t.label} starts inland`).toBeGreaterThan(to[1])
      expect(to[1], `${t.label} lands off the Normandy coast`).toBeGreaterThan(49.2)
      expect(to[1], `${t.label} lands off the Normandy coast`).toBeLessThan(49.5)
    }
    // west to east in the order the beaches actually run
    const lngs = thrusts.map((t) => t.path[t.path.length - 1][0])
    expect(lngs).toEqual([...lngs].sort((a, b) => a - b))
    // and the two frontlines: the night of the 6th, and the front three weeks on
    expect(layers.filter((l) => l.type === 'frontline')).toHaveLength(2)
  })
})
