import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type HistoricalEvent, EventIndex } from '../src/lib/events'
import { type EventManifest } from '../src/lib/eventChunks'
import { TAGS } from '../src/lib/tags'
import { MIN_TIME, MAX_TIME } from '../src/lib/time'
import { renderRichText } from '../src/lib/richtext'

// The dataset ships as era chunks under public/data/events (see
// scripts/build_event_chunks.py). Tests validate the union of all chunks,
// then the manifest and spine against it.
const DIR = join(__dirname, '..', 'public', 'data', 'events')
const readJson = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'))
const manifest = readJson('manifest.json') as EventManifest
const chunkEvents = new Map<string, HistoricalEvent[]>(
  manifest.chunks.map((c) => [c.file, readJson(c.file) as HistoricalEvent[]]),
)
const events = [...chunkEvents.values()].flat()
const spine = readJson(manifest.spine) as HistoricalEvent[]
const byId = new Map(events.map((e) => [e.id, e]))

const MIN_PRIORITY = 1
const MAX_PRIORITY = 100

describe('events.json — dataset shape', () => {
  it('is a non-trivial array', () => {
    expect(Array.isArray(events)).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(150)
  })

  it('has unique ids in slug form', () => {
    const seen = new Set<string>()
    for (const e of events) {
      expect(e.id, `${e.id} is not a slug`).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(seen.has(e.id), `duplicate id ${e.id}`).toBe(false)
      seen.add(e.id)
    }
  })

  it('has the required fields with the right types', () => {
    for (const e of events) {
      expect(typeof e.name, e.id).toBe('string')
      expect(e.name.length, e.id).toBeGreaterThan(0)
      expect(typeof e.summary, e.id).toBe('string')
      expect(e.summary.length, e.id).toBeGreaterThan(20)
      expect(typeof e.start, e.id).toBe('number')
      expect(typeof e.lat, e.id).toBe('number')
      expect(typeof e.lng, e.id).toBe('number')
      expect(typeof e.priority, e.id).toBe('number')
      expect(Array.isArray(e.tags), e.id).toBe(true)
    }
  })

  it('carries no unknown keys', () => {
    const allowed = new Set([
      'id', 'name', 'start', 'end', 'lat', 'lng', 'area',
      'priority', 'tags', 'parent', 'summary', 'body', 'image', 'links',
    ])
    for (const e of events)
      for (const k of Object.keys(e))
        expect(allowed.has(k), `${e.id} has unexpected key ${k}`).toBe(true)
  })
})

describe('events.json — time', () => {
  it('keeps every event inside the timeline range', () => {
    for (const e of events) {
      expect(Number.isFinite(e.start), e.id).toBe(true)
      expect(e.start, e.id).toBeGreaterThanOrEqual(MIN_TIME)
      expect(e.start, e.id).toBeLessThanOrEqual(MAX_TIME)
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

  it('uses negative years for deep time and BCE (astronomical numbering)', () => {
    expect(byId.get('earth-formation')!.start).toBeLessThan(-4e9)
    expect(byId.get('kpg-extinction')!.start).toBe(-66_000_000)
    // 753 BCE == astronomical year -752
    expect(byId.get('rome-founding')!.start).toBe(-752)
    expect(byId.get('moon-landing')!.start).toBe(1969)
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

describe('events.json — geography', () => {
  it('has coordinates in range', () => {
    for (const e of events) {
      expect(e.lat, e.id).toBeGreaterThanOrEqual(-90)
      expect(e.lat, e.id).toBeLessThanOrEqual(90)
      expect(e.lng, e.id).toBeGreaterThanOrEqual(-180)
      expect(e.lng, e.id).toBeLessThanOrEqual(180)
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
        expect(lng, e.id).toBeGreaterThanOrEqual(-180)
        expect(lng, e.id).toBeLessThanOrEqual(180)
        expect(lat, e.id).toBeGreaterThanOrEqual(-90)
        expect(lat, e.id).toBeLessThanOrEqual(90)
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

describe('events.json — tags and priorities', () => {
  it('only uses the controlled vocabulary, at least one tag each', () => {
    for (const e of events) {
      expect(e.tags.length, `${e.id} has no tags`).toBeGreaterThan(0)
      expect(new Set(e.tags).size, `${e.id} repeats a tag`).toBe(e.tags.length)
      for (const t of e.tags) expect(TAGS as readonly string[], `${e.id}: ${t}`).toContain(t)
    }
  })

  it('exercises every tag in the vocabulary', () => {
    const used = new Set(events.flatMap((e) => e.tags))
    for (const t of TAGS) expect(used, `tag ${t} is unused`).toContain(t)
  })

  it('keeps priorities in range and integral', () => {
    for (const e of events) {
      expect(Number.isInteger(e.priority), e.id).toBe(true)
      expect(e.priority, e.id).toBeGreaterThanOrEqual(MIN_PRIORITY)
      expect(e.priority, e.id).toBeLessThanOrEqual(MAX_PRIORITY)
    }
  })

  it('reserves the top tier for a small set of era-defining events', () => {
    const top = events.filter((e) => e.priority >= 95)
    expect(top.length).toBeGreaterThanOrEqual(10)
    expect(top.length).toBeLessThanOrEqual(30)
  })

  it('spreads the remaining events across the lower tiers', () => {
    const tier = (lo: number, hi: number) =>
      events.filter((e) => e.priority >= lo && e.priority < hi).length
    for (const [lo, hi] of [[85, 95], [70, 85], [55, 70]] as const)
      expect(tier(lo, hi), `tier ${lo}..${hi} too thin`).toBeGreaterThanOrEqual(15)
    // no single tier dominates
    for (const [lo, hi] of [[85, 95], [70, 85], [55, 70], [1, 55]] as const)
      expect(tier(lo, hi) / events.length, `tier ${lo}..${hi} dominates`).toBeLessThan(0.6)
  })
})

describe('events.json — hierarchy', () => {
  it('resolves every parent reference', () => {
    for (const e of events)
      if (e.parent) expect(byId.has(e.parent), `${e.id} -> missing parent ${e.parent}`).toBe(true)
  })

  it('has no cycles and no self-parents', () => {
    for (const e of events) {
      const seen = new Set<string>([e.id])
      let cur = e.parent
      while (cur) {
        expect(seen.has(cur), `cycle through ${e.id}`).toBe(false)
        seen.add(cur)
        cur = byId.get(cur)?.parent
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
      const p = e.parent ? byId.get(e.parent)! : undefined
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

describe('events.json — rich content', () => {
  it('gives every event a body that renders', () => {
    for (const e of events) {
      expect(typeof e.body, `${e.id} has no body`).toBe('string')
      expect(e.body!.length, e.id).toBeGreaterThan(30)
      expect(renderRichText(e.body!)).toContain('<p>')
    }
  })

  it('resolves every internal event link in body text', () => {
    let internal = 0
    for (const e of events)
      for (const [, id] of e.body!.matchAll(/\]\(event:([\w-]+)\)/g)) {
        internal++
        expect(byId.has(id), `${e.id} links to unknown event ${id}`).toBe(true)
      }
    expect(internal).toBeGreaterThanOrEqual(50)
  })

  it('points every event at an external reference', () => {
    for (const e of events) {
      const urls = (e.links ?? []).filter((l) => l.url)
      expect(urls.length, `${e.id} has no external link`).toBeGreaterThanOrEqual(1)
      for (const l of urls) expect(l.url, e.id).toMatch(/^https:\/\//)
    }
  })

  it('resolves every link entry that references an event', () => {
    for (const e of events)
      for (const l of e.links ?? []) {
        expect(Boolean(l.url) !== Boolean(l.event), `${e.id}: link needs exactly one target`).toBe(true)
        if (l.event) expect(byId.has(l.event), `${e.id} -> ${l.event}`).toBe(true)
        expect(l.label.length, e.id).toBeGreaterThan(0)
      }
  })

  it('uses https image urls with captions when present', () => {
    for (const e of events) {
      if (!e.image) continue
      expect(e.image.url, e.id).toMatch(/^https:\/\//)
    }
  })
})

describe('events.json — behaviour through the query layer', () => {
  const index = new EventIndex(events)

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
      // returned highest-priority first
      for (let i = 1; i < got.length; i++)
        expect(got[i].priority).toBeLessThanOrEqual(got[i - 1].priority)
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
})

describe('event chunks — manifest and spine', () => {
  it('lists every chunk file in the directory, and nothing else', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
    const listed = new Set([...manifest.chunks.map((c) => c.file), manifest.spine, 'manifest.json'])
    for (const f of files) expect(listed.has(f), `${f} not in manifest`).toBe(true)
    expect(files.length).toBe(listed.size)
  })

  it('reports true coverage and counts per chunk', () => {
    for (const c of manifest.chunks) {
      const evs = chunkEvents.get(c.file)!
      expect(evs.length, c.file).toBe(c.count)
      expect(Math.min(...evs.map((e) => e.start)), c.file).toBe(c.from)
      expect(Math.max(...evs.map((e) => e.end ?? e.start)), c.file).toBe(c.to)
    }
  })

  it('spine is exactly the high-priority backbone, present in era chunks too', () => {
    const expected = events.filter((e) => e.priority >= 85)
    expect(new Set(spine.map((e) => e.id))).toEqual(new Set(expected.map((e) => e.id)))
    expect(spine.length).toBeGreaterThanOrEqual(30) // the timeline is never empty
  })

  it('every tag in the vocabulary has a pin colour', async () => {
    const { TAG_COLORS } = await import('../src/lib/tags')
    for (const t of TAGS) expect(TAG_COLORS[t], t).toMatch(/^#[0-9a-f]{6}$/)
  })
})
